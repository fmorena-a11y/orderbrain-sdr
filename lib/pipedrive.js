// Cliente de la API de Pipedrive (v1 y v2) con el token de la empresa.
// Con DEMO_MODE=1 y sin token, usa datos de prueba en memoria (lib/pipedrive-demo.js).
import { CLIENT_PIPES, DEAD_STAGES, DEAL_FIELDS, FREE_OWNERS } from "./config.js";
// dueño real: las cuentas generales de la empresa cuentan como «sin dueño»
export const realOwner = id => id && !FREE_OWNERS.has(Number(id)) ? Number(id) : null;

const TOKEN = process.env.PIPEDRIVE_API_TOKEN;
const DOMAIN = process.env.PIPEDRIVE_DOMAIN || "ordereat";
const BASE = `https://${DOMAIN}.pipedrive.com/api`;
export const PD_WEB = `https://${DOMAIN}.pipedrive.com`;
export const DEMO = !TOKEN && process.env.DEMO_MODE === "1";
const D = DEMO ? await import("./pipedrive-demo.js") : null;

export class PipedriveError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Pipedrive limita pedidos por token: como mucho 4 a la vez, y ante un 429 se espera lo que pida (retry-after
// o x-ratelimit-reset) o un tiempo creciente, hasta 5 intentos.
let active = 0; const waiting = [];
const acquire = () => active < 4 ? (active++, Promise.resolve()) : new Promise(r => waiting.push(r));
const release = () => { const n = waiting.shift(); if (n) n(); else active--; };
async function call(version, method, path, { query, body } = {}) {
  if (!TOKEN) throw new PipedriveError(500, "Falta PIPEDRIVE_API_TOKEN en el servidor");
  const url = new URL(`${BASE}/${version}${path}`);
  Object.entries(query || {}).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v); });
  for (let attempt = 0; attempt < 5; attempt++) {
    let res;
    await acquire();
    try {
      res = await fetch(url, {
        method,
        headers: { "x-api-token": TOKEN, "content-type": "application/json", accept: "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch { release(); throw new PipedriveError(503, "no se pudo conectar con Pipedrive"); }
    release();
    if (res.status === 429 && attempt < 4) {
      const ra = Number(res.headers.get("retry-after")) || Number(res.headers.get("x-ratelimit-reset")) || 0;
      await new Promise(r => setTimeout(r, Math.min(20000, ra ? ra * 1000 + 250 : 1500 * 2 ** attempt)));
      continue;
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.success === false) throw new PipedriveError(res.status, json.error || json.message || `Pipedrive respondió ${res.status}`);
    return json;
  }
  throw new PipedriveError(429, "Pipedrive está limitando pedidos, probá en un minuto");
}
const v1 = (m, p, o) => call("v1", m, p, o);
const v2 = (m, p, o) => call("v2", m, p, o);

// ---------- lecturas
export async function searchOrganizations(term, limit = 10) {
  if (D) return D.searchOrganizations(term, limit);
  const r = await v2("GET", "/organizations/search", { query: { term: String(term).slice(0, 100), limit } });
  return (r.data?.items || []).map(i => ({ id: i.item.id, name: i.item.name, ownerId: realOwner(i.item.owner?.id) }));
}
export async function dealsForOrg(orgId) {
  if (D) return D.dealsForOrg(orgId);
  const r = await v2("GET", "/deals", { query: { org_id: orgId, limit: 100 } });
  return r.data || [];
}
export async function notesForOrg(orgId, limit = 8) {
  if (D) return D.notesForOrg(orgId, limit);
  const r = await v1("GET", "/notes", { query: { org_id: orgId, limit, sort: "add_time DESC" } });
  return r.data || [];
}
// Prospectos (leads): notas, persona y cambios (asignar persona, archivar cuando pasa a trato o se descarta).
export async function notesForLead(leadId, limit = 12) {
  if (D) return D.notesForLead(leadId, limit);
  const r = await v1("GET", "/notes", { query: { lead_id: leadId, limit, sort: "add_time DESC" } });
  return r.data || [];
}
export async function getPerson(id) {
  if (D) return D.getPerson(id);
  const r = await v2("GET", `/persons/${Number(id)}`);
  const p = r.data || {};
  return { id: p.id, name: p.name, phone: p.phones?.[0]?.value || "", email: p.emails?.[0]?.value || "", orgId: p.org_id || null };
}
// Opciones de los campos de lista (Ciudad, Estado…) para elegir la que corresponde por nombre. Se cachean un día.
let fieldOpts = null, fieldOptsAt = 0;
export async function loadFieldOptions() {
  if (D) return;
  if (!fieldOpts || Date.now() - fieldOptsAt > 864e5) {
    const r = await v1("GET", "/dealFields", { query: { limit: 500 } });
    fieldOpts = new Map((r.data || []).map(f => [f.key, f.options || []])); fieldOptsAt = Date.now();
  }
}
export async function optionFor(key, label) {
  if (D || !label) return null;
  if (!fieldOpts || Date.now() - fieldOptsAt > 864e5) {
    const r = await v1("GET", "/dealFields", { query: { limit: 500 } });
    fieldOpts = new Map((r.data || []).map(f => [f.key, f.options || []])); fieldOptsAt = Date.now();
  }
  // solo si hay exactamente una opción con ese nombre: con dos «Córdoba» o «Lima» dividida en zonas, no se adivina
  const n = norm(label), hits = (fieldOpts.get(key) || []).filter(o => norm(o.label) === n);
  return hits.length === 1 ? hits[0].id : null;
}
// fields: campos personalizados del prospecto (los mismos del formulario de Pipedrive: Ciudad, País, Fuente, SDR…)
export async function createLead({ title, ownerId, orgId, personId, fields = {} }) {
  if (D) return D.createLead({ title, ownerId, orgId, personId });
  const body = { title, ...fields };
  if (ownerId) body.owner_id = ownerId;
  if (orgId) body.organization_id = orgId;
  if (personId) body.person_id = personId;
  let l;
  try { l = (await v1("POST", "/leads", { body })).data; }
  catch (e) { // si algún campo no coincide con la cuenta, se crea igual sin los campos (y se avisa en el log)
    if (!Object.keys(fields).length) throw e;
    console.warn("Prospecto sin campos personalizados:", e.message);
    l = (await v1("POST", "/leads", { body: { title, owner_id: body.owner_id, organization_id: body.organization_id, person_id: body.person_id } })).data;
  }
  if (l?.id) leadCache.set(l.id, leadRec({ ...l, title: l.title || title, organization_id: orgId || null, person_id: personId || null }));
  return l;
}
// prospectos abiertos de una organización (para no duplicar)
export async function leadsForOrg(orgId) {
  if (D) return D.leadsForOrg(orgId);
  // solo los abiertos; un error no se toma como «no hay prospectos» (se corta para no duplicar)
  const r = await v1("GET", "/leads", { query: { organization_id: orgId, limit: 100, archived_status: "not_archived" } });
  return (r.data || []).filter(l => !l.is_archived).map(leadRec);
}
// Prospectos por texto (título y campos), con sus datos de contacto. Incluye archivados: también sirven como dato.
// keep: filtro por título antes de pedir el detalle de cada uno (cada detalle es un pedido a Pipedrive)
export async function searchLeads(term, limit = 10, keep = () => true) {
  if (D) return D.searchLeads(term, limit, keep);
  const r = await v2("GET", "/leads/search", { query: { term: String(term).slice(0, 100), limit: 20 } });
  const ids = (r.data?.items || []).filter(i => keep(i.item.title || "")).slice(0, limit).map(i => i.item.id);
  return leadsByIds(ids);
}
export async function updatePerson(id, body) {
  if (D) return D.updatePerson(id, body);
  return (await v2("PATCH", `/persons/${Number(id)}`, { body })).data;
}
// La persona dueña del token (quien conectó Pipedrive): es líder del equipo en la app.
let tokenOwnerCache = null;
export async function tokenOwner() {
  if (D) return D.tokenOwner();
  if (!tokenOwnerCache) { const r = await v1("GET", "/users/me"); tokenOwnerCache = { id: r.data.id, email: String(r.data.email || "").toLowerCase(), name: r.data.name }; }
  return tokenOwnerCache;
}
export function optionLabel(key, id) { return (fieldOpts?.get(key) || []).find(o => String(o.id) === String(id))?.label || null; }
export async function updateLead(id, body) {
  if (D) return D.updateLead(id, body);
  return (await v1("PATCH", `/leads/${encodeURIComponent(id)}`, { body })).data;
}
export async function recentNotes(limit = 40) {
  if (D) return D.recentNotes(limit);
  const r = await v1("GET", "/notes", { query: { limit, sort: "add_time DESC" } });
  return r.data || [];
}
export async function activities({ ownerId, orgId, done = false, limit = 200, updatedSince }) {
  if (D) return D.activities({ ownerId, orgId, done, limit });
  const r = await v2("GET", "/activities", { query: { owner_id: ownerId, org_id: orgId, done, limit, updated_since: updatedSince, sort_by: "due_date", sort_direction: done ? "desc" : "asc" } });
  return r.data || [];
}
// Prospectos (leads) y personas de las actividades que no tienen organización: para mostrar a quién es cada una.
const leadCache = new Map(), leadsAt = new Map(), leadsLoading = new Map();
// país (opción del campo País) y ciudad (opción del campo Ciudad) del prospecto, para crear el trato en su embudo
const fieldText = v => (v && typeof v === "object" ? v.formatted_address || v.value || "" : v == null ? "" : String(v)).trim();
const leadRec = x => ({ id: x.id, title: x.title || "", orgId: x.organization_id || null, personId: x.person_id || null, ownerId: realOwner(x.owner_id), archived: !!x.is_archived,
  phone: fieldText(x[DEAL_FIELDS.telefono]), email: fieldText(x[DEAL_FIELDS.email]), web: fieldText(x[DEAL_FIELDS.web]), addr: fieldText(x[DEAL_FIELDS.direccion] ?? x[`${DEAL_FIELDS.direccion}_formatted_address`]),
  paisOpt: x[DEAL_FIELDS.pais] || null, ciudadOpt: x[DEAL_FIELDS.ciudad] || null, estadoOpt: x[DEAL_FIELDS.estado] || null, fuenteOpt: x[DEAL_FIELDS.fuente] || null });
// Trae los prospectos de UNA persona (los suyos: la cuenta tiene decenas de miles) de a 500 y los guarda 15 minutos.
async function loadLeads(ownerId) {
  if (!ownerId || Date.now() - (leadsAt.get(ownerId) || 0) < 15 * 60e3) return;
  if (!leadsLoading.has(ownerId)) leadsLoading.set(ownerId, (async () => {
    for (let start = 0, page = 0; page < 10; page++, start += 500) {
      const r = await v1("GET", "/leads", { query: { limit: 500, start, owner_id: ownerId, archived_status: "all" } });
      for (const x of r.data || []) leadCache.set(x.id, leadRec(x));
      if (!r.additional_data?.pagination?.more_items_in_collection) break;
    }
    leadsAt.set(ownerId, Date.now());
  })().finally(() => leadsLoading.delete(ownerId)));
  await leadsLoading.get(ownerId);
}
export async function leadsByIds(ids, ownerId = null) {
  if (D) return D.leadsByIds(ids);
  if (!ids.length) return [];
  await loadLeads(ownerId).catch(() => {});
  const missing = ids.filter(id => !leadCache.has(id)).slice(0, 40);
  await Promise.all(missing.map(async id => {
    try { const r = await v1("GET", `/leads/${encodeURIComponent(id)}`); leadCache.set(id, leadRec({ ...(r.data || {}), id })); }
    catch (e) { if (e.status === 404 || e.status === 410) leadCache.set(id, null); } // un error pasajero no se guarda como «no existe»
  }));
  return ids.map(id => leadCache.get(id)).filter(Boolean);
}
export async function personsByIds(ids) {
  if (D) return D.personsByIds(ids);
  if (!ids.length) return [];
  const r = await v2("GET", "/persons", { query: { ids: ids.slice(0, 100).join(","), limit: 100 } });
  return (r.data || []).map(p => ({ id: p.id, name: p.name, orgId: p.org_id || null }));
}
export async function orgsByIds(ids) {
  if (!ids.length) return [];
  if (D) return D.orgsByIds(ids);
  const r = await v2("GET", "/organizations", { query: { ids: ids.slice(0, 100).join(","), limit: 100 } });
  return (r.data || []).map(o => ({ id: o.id, name: o.name, ownerId: realOwner(o.owner_id), labelIds: o.label_ids || [], country: o.address?.country || "", city: o.address?.locality || o.address?.admin_area_level_2 || "", region: o.address?.admin_area_level_1 || "" }));
}
// Listados completos por páginas (cursor de v2), para la sincronización masiva (lib/sync.js). Solo lectura.
// since: solo lo cambiado desde esa fecha (RFC3339). Devuelven lo justo para el cruce:
// organización { id, name, ownerId, deleted } y trato con los campos que usan classify/describe/phaseOf.
export const compactDeal = d => ({ id: d.id, org_id: d.org_id || null, status: d.status, pipeline_id: d.pipeline_id, stage_id: d.stage_id, owner_id: d.owner_id || d.user_id || null,
  lost_reason: d.lost_reason || null, lost_time: d.lost_time || null, update_time: d.update_time || null, deleted: !!d.is_deleted || d.status === "deleted" });
export async function orgsPage({ cursor, since, limit = 500 } = {}) {
  if (D) return D.orgsPage({ cursor, since, limit });
  const r = await v2("GET", "/organizations", { query: { cursor, limit, updated_since: since, sort_by: "id", sort_direction: "asc" } });
  return { items: (r.data || []).map(o => ({ id: o.id, name: o.name || "", ownerId: realOwner(o.owner_id), deleted: !!o.is_deleted })), next: r.additional_data?.next_cursor || null };
}
export async function dealsPage({ cursor, since, limit = 500 } = {}) {
  if (D) return D.dealsPage({ cursor, since, limit });
  // en una incremental también los borrados (Pipedrive los muestra hasta 30 días), para sacarlos del cruce
  const r = await v2("GET", "/deals", { query: { cursor, limit, updated_since: since, status: since ? "open,won,lost,deleted" : undefined, sort_by: "id", sort_direction: "asc" } });
  return { items: (r.data || []).map(compactDeal), next: r.additional_data?.next_cursor || null };
}
// Una actividad (para saber de quién es antes de cambiarla). null si no existe.
export async function getActivity(id) {
  if (D) return D.getActivity(id);
  try { return (await v2("GET", `/activities/${Number(id)}`)).data || null; }
  catch (e) { if (e.status === 404 || e.status === 410) return null; throw e; }
}
export async function personsForOrg(orgId) {
  if (D) return D.personsForOrg(orgId);
  const r = await v2("GET", "/persons", { query: { org_id: orgId, limit: 20 } });
  return (r.data || []).map(p => ({ id: p.id, name: p.name, phone: p.phones?.[0]?.value || "", email: p.emails?.[0]?.value || "" }));
}

// Usuarios, embudos y etapas: cambian poco, se cachean 1 hora.
let metaCache = null, metaAt = 0;
export async function meta() {
  if (D) return D.meta();
  if (metaCache && Date.now() - metaAt < 3600e3) return metaCache;
  const [u, p, s] = await Promise.all([v1("GET", "/users"), v2("GET", "/pipelines"), v2("GET", "/stages", { query: { limit: 500 } })]);
  metaCache = {
    users: (u.data || []).filter(x => x.active_flag !== false).map(x => ({ id: x.id, name: x.name, email: (x.email || "").toLowerCase() })),
    pipes: Object.fromEntries((p.data || []).map(x => [x.id, x.name])),
    stages: Object.fromEntries((s.data || []).map(x => [x.id, x.name])),
    stageList: (s.data || []).map(x => ({ id: x.id, name: x.name, pipe: x.pipeline_id, order: x.order_nr ?? 0 })),
  };
  metaAt = Date.now();
  return metaCache;
}
// Etapas de un embudo, en orden. «Propuesta enviada» se busca por nombre en el embudo del trato (cada embudo tiene la suya; LatAm no tiene).
export const pipeStages = (m, pipeId) => (m?.stageList || []).filter(x => x.pipe === Number(pipeId)).sort((a, b) => a.order - b.order);
export const proposalStage = (m, pipeId) => pipeStages(m, pipeId).find(x => /^(proposal sent|propuesta enviada)$/i.test(String(x.name).trim()))?.id || null;
// Un trato (para saber de quién es y en qué embudo está antes de cambiarlo). null si no existe.
export async function getDeal(id) {
  if (D) return D.getDeal(id);
  try { return (await v2("GET", `/deals/${Number(id)}`)).data || null; }
  catch (e) { if (e.status === 404 || e.status === 410) return null; throw e; }
}

// ---------- escrituras
// Toda organización nueva queda a nombre de quien la pide: sin usuario de Pipedrive no se crea (quedaría a nombre del dueño del token).
export const NO_OWNER = "Tu usuario no está vinculado a Pipedrive: no puedo crear la organización a tu nombre.";
export async function createOrganization({ name, address, website, ownerId }) {
  if (!ownerId) throw Object.assign(new Error(NO_OWNER), { status: 403 });
  if (D) return D.createOrganization({ name, ownerId });
  const body = { name, visible_to: 3, owner_id: ownerId };
  if (address) body.address = address;
  if (website) body.website = website;
  return (await v2("POST", "/organizations", { body })).data;
}
export async function updateOrganization(id, body) {
  if (D) return D.updateOrganization(id, body);
  return (await v2("PATCH", `/organizations/${id}`, { body })).data;
}
export async function addNote({ content, orgId, dealId, personId, leadId }) {
  if (D) return D.addNote({ content, orgId, dealId, leadId });
  const body = { content };
  if (orgId) body.org_id = orgId;
  if (leadId) body.lead_id = leadId;
  if (dealId) body.deal_id = dealId;
  if (personId) body.person_id = personId;
  return (await v1("POST", "/notes", { body })).data;
}
export async function addActivity({ subject, type, dueDate, dueTime, durationMin, orgId, dealId, personId, leadId, ownerId, note, done }) {
  if (D) return D.addActivity({ subject, type, dueDate, dueTime, orgId, dealId, leadId, ownerId, note, done });
  const body = { subject, type, due_date: dueDate };
  if (orgId) body.org_id = orgId;
  if (leadId) body.lead_id = leadId;
  if (dueTime) body.due_time = dueTime;
  if (durationMin) body.duration = `${String(Math.floor(durationMin / 60)).padStart(2, "0")}:${String(durationMin % 60).padStart(2, "0")}`;
  if (dealId) body.deal_id = dealId;
  if (personId) body.participants = [{ person_id: personId, primary: true }];
  if (ownerId) body.owner_id = ownerId;
  if (note) body.note = note;
  if (done) body.done = true;
  return (await v2("POST", "/activities", { body })).data;
}
export async function updateActivity(id, body) {
  if (D) return D.updateActivity(id, body);
  return (await v2("PATCH", `/activities/${id}`, { body })).data;
}
// Prospecto → trato con la conversión de Pipedrive: pasan las notas, actividades, archivos y mails, y el prospecto queda
// cerrado. Es un trabajo asíncrono: se consulta el estado hasta tener el trato (unos segundos).
export async function convertLead(id, { pipelineId, stageId } = {}) {
  if (D) return D.convertLead(id, { pipelineId, stageId });
  const body = stageId ? { stage_id: stageId } : pipelineId ? { pipeline_id: pipelineId } : {};
  const r = await v2("POST", `/leads/${encodeURIComponent(id)}/convert/deal`, { body });
  const conv = r.data?.conversion_id; if (!conv) throw Object.assign(new Error("Pipedrive no aceptó la conversión"), { status: 502 });
  for (let i = 0; i < 12; i++) {
    await new Promise(res => setTimeout(res, i ? 1500 : 800));
    const st = (await v2("GET", `/leads/${encodeURIComponent(id)}/convert/status/${conv}`)).data || {};
    if (st.status === "completed" && st.deal_id) { leadCache.delete(id); return { dealId: st.deal_id }; }
    if (st.status === "failed" || st.status === "rejected") throw Object.assign(new Error("Pipedrive no pudo convertir el prospecto"), { status: 502 });
  }
  throw Object.assign(new Error("La conversión sigue en curso en Pipedrive: revisalo en unos minutos"), { status: 504 });
}
export async function createDeal(body) {
  if (D) return D.createDeal(body);
  return (await v2("POST", "/deals", { body })).data;
}
export async function updateDeal(id, body) {
  if (D) return D.updateDeal(id, body);
  return (await v2("PATCH", `/deals/${id}`, { body })).data;
}
export async function addPerson({ name, orgId, phone, email, ownerId }) {
  if (D) return D.addPerson({ name, orgId, phone, email, ownerId });
  const body = { name, visible_to: 3 };
  if (orgId) body.org_id = orgId;
  if (phone) body.phones = [{ value: phone, primary: true, label: "work" }];
  if (email) body.emails = [{ value: email, primary: true, label: "work" }];
  if (ownerId) body.owner_id = ownerId;
  return (await v2("POST", "/persons", { body })).data;
}

// ---------- cruce colegio <-> organización
// Reglas puras (sin pedidos): las usan el cruce de a uno (findOrgCandidates, checkSchool en lib/sales.js) y la
// sincronización masiva (lib/sync.js), así los dos dan lo mismo. Probadas en test/match.test.mjs y test/sync.test.mjs.
export const norm = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const STOP = new Set("colegio college school iep i e p ie iiee institucion educativa particular privado privada bilingue bilingual de del la el los las y the cep escuela instituto".split(" "));
export const tokens = s => norm(s).split(" ").filter(t => t && !STOP.has(t) && t.length > 1);
// Palabras que comparten muchísimos colegios (tipo de escuela, santos, nombres de pila: las más repetidas de la base).
// Pesan LOW_W en vez de 1: solas no alcanzan para elegir una organización
// («Centro Educativo San Nicolás» no es «Centro Educativo San José»).
export const LOW = new Set(("universidad centro infantil educacion unidad primaria educativo liceo secundaria superior jardin gimnasio academia academy " +
  "campus sede preparatoria prepa preescolar kinder kindergarten guarderia estancia inicial nivel basica media tecnologico tecnologica tecnico tecnica " +
  "secundario universitario profesional formacion estudios integral especial internacional international americano mixto polivalente educacional " +
  "complejo comunidad fundacion parroquial cristiano cristiana catolica catolico nueva nuevo mundo mi para en cent inf norte sur central ninos " +
  "san santa santo saint maria jose juan jesus nuestra senora sagrado sagrada corazon francisco antonio pablo luis miguel manuel carlos pedro martin " +
  "santiago domingo inmaculada madre padre virgen cristo rey divino nino familia").split(" "));
const LOW_W = 0.35;
// Abreviaturas de ciudades que aparecen en los nombres de las organizaciones («CEPI 109 Mi Solcito - MZA»)
const PLACE_ALIAS = { cdmx: ["mexico"], caba: ["buenos", "aires"], mza: ["mendoza"], gdl: ["guadalajara"], mty: ["monterrey"], qro: ["queretaro"], slp: ["luis", "potosi"] };
const CITY_SKIP = new Set("san santa santo ciudad villa puerto general".split(" "));
// Cómo puede aparecer la ciudad en el nombre de una organización: cada parte, sin «San», «Ciudad»…
// («San Miguel de Tucumán» → [miguel] y [tucuman]; «Ciudad de México» → [mexico]). Si alguna parte tiene palabras
// propias, no cuentan las hechas solo de palabras comunes («Santiago de Querétaro» → [queretaro]).
export function cityParts(city) {
  const parts = norm(city).split(/ (?:de|del) /).map(p => tokens(p).filter(w => !CITY_SKIP.has(w))).filter(p => p.length);
  const strong = parts.filter(p => p.some(w => !LOW.has(w)));
  return strong.length ? strong : parts;
}
const withAlias = b => { let x = null; for (const w of b) if (PLACE_ALIAS[w]) (x ||= new Set(b)), PLACE_ALIAS[w].forEach(v => x.add(v)); return x || b; };
// La organización nombra la ciudad: una parte entera, o su primera palabra si no es común («Puebla» por «Puebla de Zaragoza»)
export const cityIn = (parts, b) => { const x = withAlias(b); return parts.some(p => p.every(w => x.has(w)) || (!LOW.has(p[0]) && x.has(p[0]))); };

// Lo que hace falta de cada colegio para puntuar (se calcula una vez por colegio)
export function schoolKey(s) {
  const a = tokens(s.name), parts = cityParts(s.city), place = new Set([...parts.flat(), ...tokens(s.country)]);
  // las palabras de la ciudad dentro del nombre pesan poco: la organización puede no tenerlas («Liceo Francés de Lima» → «Liceo Francés»)
  const w = a.map(t => LOW.has(t) || place.has(t) ? LOW_W : 1);
  return { a, w, total: w.reduce((x, y) => x + y, 0), strong: w.some(v => v === 1), parts, place, own: new Set(a), city: norm(s.city), nums: new Set(a.filter(isNum).map(numKey)) };
}
// Palabras que nombran un lugar (ciudad o país de la base) y casi nunca son parte del nombre de un colegio
// («piura», «mendoza», «peru»; no «concepcion» ni «paz»). Si la organización nombra otro lugar, no es este colegio.
export function placeWords(list) {
  const inPlace = new Map(), inName = new Map(), add = (m, w) => m.set(w, (m.get(w) || 0) + 1);
  for (const s of list) {
    for (const w of new Set([...cityParts(s.city).flat(), ...tokens(s.country)])) add(inPlace, w);
    for (const w of new Set(tokens(s.name))) add(inName, w);
  }
  const out = new Set(Object.keys(PLACE_ALIAS));
  for (const [w, n] of inPlace) if (n >= 3 && w.length >= 4 && !LOW.has(w) && (inName.get(w) || 0) <= n * 0.25) out.add(w);
  return out;
}
const foreignPlace = (k, b, places) => {
  for (const w of b) {
    if (k.own.has(w) || k.place.has(w) || !places.has(w)) continue;
    if (PLACE_ALIAS[w] && PLACE_ALIAS[w].every(v => k.place.has(v))) continue;
    return true;
  }
  return false;
};
// umbrales del cruce: desde PICK se elige la organización; desde SURE (y sin dudas, ver isSure) queda confirmada sola
export const PICK = 0.67, SURE = 0.95;
const BELOW = PICK - 0.01; // tope para una organización que no se puede elegir sola (sigue como candidata en la ficha)
const isNum = w => /^\d+$/.test(w), numKey = w => String(Number(w));
// Puntaje de una organización para un colegio (0 a 1): qué parte de las palabras propias del colegio tiene la organización,
// con las comunes valiendo LOW_W; +0.15 si nombra la ciudad (solo si coincide alguna palabra propia, o todas si el
// colegio no tiene propias). Queda por debajo de PICK (candidata, pero no se elige sola) si la organización:
//  - nombra otro lugar de la base («Colegio San José Obrero Piura» para el de Lima);
//  - tiene otro número («Fe y Alegría 08» para «Fe y Alegría 13»);
//  - tiene tantas palabras propias de más como las propias que comparte («Colegio Óscar Arnulfo Romero» para
//    «Colegio Romero»; «Colegio Mundo Futurista» para «Colegio Mundo Bilingüe»). Las de 3 letras o menos no cuentan (siglas).
// k: schoolKey(colegio), b: Set(tokens(organización)), places: placeWords(base)
export function rate(k, b, places) {
  if (!k.a.length) return { score: 0, city: false, extra: 0 };
  let got = 0, strongHit = 0;
  k.a.forEach((t, i) => { if (b.has(t)) { got += k.w[i]; if (k.w[i] === 1) strongHit++; } });
  const city = cityIn(k.parts, b);
  let score = got / k.total;
  if (city && (strongHit || (!k.strong && got === k.total))) score += 0.15;
  score = Math.min(1, score);
  // palabras de la organización que no están en el colegio (ni son su ciudad): desempata, gana la más parecida
  let extra = 0, extraStrong = 0, nums = 0, numHit = false;
  for (const w of b) {
    if (isNum(w)) { nums++; if (k.nums.has(numKey(w))) numHit = true; }
    if (k.own.has(w) || k.place.has(w)) continue;
    extra++;
    if (w.length > 3 && !isNum(w) && !LOW.has(w) && !places?.has(w)) extraStrong++;
  }
  if (score >= PICK && ((places && foreignPlace(k, b, places)) || (nums && k.nums.size && !numHit) || (extraStrong && extraStrong >= strongHit))) score = BELOW;
  return { score, city, extra };
}
export const scoreTokens = (k, b, places) => rate(k, b, places).score;
export const scoreOrg = (school, org, places) => rate(schoolKey(school), new Set(tokens(org.name)), places).score;
// Pueden competir las organizaciones que devolvería la búsqueda de Pipedrive con los términos de findOrgCandidates
// (exige todas las palabras): las que tienen todas las palabras propias del colegio o las dos primeras.
export const eligible = (a, b) => a.slice(0, 2).every(w => b.has(w)) || a.every(w => b.has(w));
// orden de los candidatos: mayor puntaje, después la que nombra la ciudad, después menos palabras de más, después la más vieja (id menor)
export const candBefore = (x, y) => x.score !== y.score ? x.score > y.score : !!x.city !== !!y.city ? !!x.city
  : (x.extra || 0) !== (y.extra || 0) ? (x.extra || 0) < (y.extra || 0) : x.id < y.id;
export const rankCandidates = list => list.sort((x, y) => candBefore(x, y) ? -1 : candBefore(y, x) ? 1 : 0);

// Contexto del cruce sobre la base de colegios: la clave de cada colegio, los lugares y qué colegios «reclaman» cada
// organización. Se arma una vez por base (cambia si se suman colegios).
const AMB_CITIES = 1, AMB_ANY = 4;
let ctxMemo = null;
// memo: se guarda para la próxima (la base de la app); false para una lista suelta (no desplaza a la de la app)
export function matchCtx(base, { memo = true } = {}) {
  if (memo && ctxMemo && ctxMemo.base === base && ctxMemo.n === base.length) return ctxMemo;
  const keys = new Map(), byFirst = new Map(), places = placeWords(base);
  base.forEach((s, i) => {
    const k = schoolKey(s); keys.set(s.id ?? i, k);
    if (k.a.length) { let l = byFirst.get(k.a[0]); if (!l) byFirst.set(k.a[0], l = []); l.push(k); }
  });
  const claims = new Map();
  // Colegios de la base que elegirían esta organización (puntaje ≥ PICK), de mayor a menor
  const claimsOf = (id, name) => {
    const ck = id + "|" + name; let c = claims.get(ck); if (c) return c;
    const b = new Set(tokens(name)), seen = new Set(); c = [];
    for (const t of b) for (const k of byFirst.get(t) || []) {
      if (seen.has(k)) continue; seen.add(k);
      if (!eligible(k.a, b)) continue;
      const r = rate(k, b, places); if (r.score >= PICK) c.push({ k, score: r.score, extra: r.extra });
    }
    c.sort((x, y) => y.score - x.score); claims.set(ck, c);
    return c;
  };
  const key = s => keys.get(s.id) || schoolKey(s);
  // Una organización que encaja igual o mejor con otros colegios (2 de otras ciudades, o 4 en total) no se elige
  // sola para ninguno: «Colegio San José» sin ciudad no puede ser el de Lima, el de Piura y el de Cusco a la vez.
  // «Igual o mejor»: mismo puntaje o más y no más palabras de la organización sin cubrir («Colegio Británico» de Lima
  // no le disputa «Colegio Británico de Pachuca» al de Pachuca).
  const ambiguous = (k, c) => {
    let other = 0, any = 0;
    for (const x of claimsOf(c.id, c.name)) {
      if (x.score < c.score) break;
      if (x.k === k || x.extra > (c.extra || 0)) continue;
      any++; if (x.k.city !== k.city) other++;
      if (other >= AMB_CITIES || any >= AMB_ANY) return true;
    }
    return false;
  };
  const ctx = { base, n: base.length, places, key, claimsOf, ambiguous };
  if (memo) ctxMemo = ctx;
  return ctx;
}
// Una candidata ambigua (ver matchCtx) baja de PICK: sigue como candidata pero no se elige sola
export const markAmbiguous = (k, c, ctx) => { if (c.score >= PICK && ctx.ambiguous(k, c)) c.score = BELOW; return c; };
// Candidatos ya puntuados ({ id, name, ownerId, score, city, extra }) → los TOP finales: las ambiguas bajan de PICK,
// se ordenan y quedan { id, name, ownerId, score }.
export function finishCandidates(k, list, ctx, top = 6) {
  for (const c of list) markAmbiguous(k, c, ctx);
  return rankCandidates(list).slice(0, top).map(({ extra, city, ...o }) => o);
}
// la elegida: la de mayor puntaje (candidatos ya ordenados de mayor a menor) si llega a PICK
export const pickOrg = candidates => candidates.find(o => o.score >= PICK) || null;
// Confirmada sola (sin que nadie la elija) solo si no hay dudas: puntaje ≥ SURE, ninguna otra también ≥ SURE,
// y el colegio tiene al menos dos palabras propias y alguna no es común («Colegio Juárez» no alcanza).
export const isSure = (candidates, k) => !!candidates[0] && candidates[0].score >= SURE && !(candidates[1]?.score >= SURE) && k.a.length >= 2 && k.strong;
// Lo que se guarda de los candidatos (la ficha los ofrece si el cruce no está confirmado): pocos y livianos.
const CAND_MIN = 0.3, CAND_KEEP = 4;
export const keepCandidates = list => list.filter(c => c.score >= CAND_MIN).slice(0, CAND_KEEP)
  .map(c => ({ id: c.id, name: c.name, ownerId: c.ownerId ?? null, score: Math.round(c.score * 100) / 100 }));
// Cruce sin organización elegida
export function noMatchRecord(candidates) {
  const c = keepCandidates(candidates);
  return { status: "new", detail: c.length ? "Sin coincidencia clara en Pipe" : "No figura en Pipe", orgId: null, orgName: null, confirmed: false, auto: false, candidates: c };
}
// Cruce con la organización elegida, a partir de sus tratos (puro: los tratos y los usuarios ya vienen).
// confirmed: la eligió una persona (o se creó desde la app); auto: confirmada sola por isSure (se vuelve a calcular).
// motivo y fecha del mismo trato que define el estado (si es «Perdido», el perdido con propuesta)
export function matchRecord({ chosen, deals, m, ownerId, confirmed = false, auto = false, candidates = [], cur = null }) {
  const status = deals.length ? classify(deals, m) : "org";
  const open = openSalesDeal(deals), lost = (status === "lost" && lastLostWithProposal(deals, m)) || lastLost(deals);
  const conf = !!(confirmed || auto);
  return {
    status, detail: describe(status, deals, m), phase: phaseOf(deals, m), orgId: chosen.id, orgName: chosen.name,
    ownerId, ownerName: ownerId ? m.users.find(u => u.id === ownerId)?.name || "" : "",
    confirmed: conf, auto: conf && !confirmed,
    openDealId: open?.id || null, openDealOwnerId: open ? open.owner_id || open.user_id || null : null, openDealOwner: open ? m.users.find(u => u.id === (open.owner_id || open.user_id))?.name || "" : "",
    lostReason: lost?.lost_reason || "", lostAt: (lost?.lost_time || lost?.update_time || "").slice(0, 10) || null,
    dealCount: deals.length, candidates: conf ? [] : keepCandidates(candidates.filter(c => c.id !== chosen.id)),
    leadId: cur?.orgId === chosen.id ? cur?.leadId || null : null,
  };
}
// Un cruce confirmado que se mantiene con su organización: lo eligió una persona. Los confirmados solos (auto) se
// recalculan. Los guardados antes de que existiera «auto» no dicen cómo se confirmaron: se recalculan solo si tienen
// todo lo de una confirmación por puntaje de las reglas viejas (otras candidatas guardadas, todas las palabras del
// colegio en la organización) y nada de un trabajo de alguien (prospecto, contactos registrados). Así se corrigen
// los que confirmaba «San José Obrero» → «ESCUELA SAN JOSE OBRERO» sin perder lo que eligió o trabajó una persona.
// worked: el colegio tiene contactos registrados desde la app.
const oldSure = (school, orgName) => {
  const a = tokens(school.name), b = new Set(tokens(orgName)), c0 = norm(school.city).split(" ")[0];
  return a.length > 0 && Math.min(1, a.filter(t => b.has(t)).length / a.length + (b.has(c0) ? 0.15 : 0)) >= SURE;
};
export const legacyAuto = (cur, school, worked = false) => !!(cur?.confirmed && cur.orgId && cur.auto === undefined && cur.candidates?.length
  && !cur.leadId && !worked && school && oldSure(school, cur.orgName));
export const keepsOrg = (cur, school = null, worked = false) => !!(cur?.confirmed && cur.orgId && !cur.auto && !legacyAuto(cur, school, worked));
// ctx: matchCtx(base de colegios). Sin ctx, solo con este colegio (sin lugares ni ambigüedad).
export async function findOrgCandidates(school, ctx = matchCtx([school], { memo: false })) {
  const k = ctx.key(school);
  const terms = [k.a.join(" "), k.a.slice(0, 2).join(" "), school.name];
  const seen = new Map();
  for (const t of terms) {
    if (!t || t.length < 2) continue;
    for (const o of await searchOrganizations(t)) {
      if (seen.has(o.id)) continue;
      const b = new Set(tokens(o.name));
      // la búsqueda también encuentra por dirección o notas: solo compite lo que tiene las palabras en el nombre
      if (eligible(k.a, b)) seen.set(o.id, { ...o, ...rate(k, b, ctx.places) });
    }
    if ([...seen.values()].some(o => o.score >= 0.8)) break;
  }
  return finishCandidates(k, [...seen.values()], ctx);
}

const isSalesOpen = d => d.status === "open" && !CLIENT_PIPES.includes(d.pipeline_id);
// Perdido = se mandó la propuesta y no se cerró (el trato se perdió en PROPOSAL SENT, CLOSING, HOT DEALS o negociación).
// Si se perdió antes de la propuesta (SELLING, A contactar…), es «Contactado sin avance».
const PROPOSAL_STAGE = /propos|propuesta|closing|hot deal|negoti|negociaci/i;
export const lostAfterProposal = (d, m) => d.status === "lost" && PROPOSAL_STAGE.test(m?.stages?.[d.stage_id] || "");
export function classify(deals, m) {
  const client = deals.some(d => d.status === "won") ||
    deals.some(d => d.status === "open" && CLIENT_PIPES.includes(d.pipeline_id) && !DEAD_STAGES.includes(d.stage_id));
  if (client) return "client";
  if (deals.some(isSalesOpen)) return "open";
  if (deals.some(d => lostAfterProposal(d, m))) return "lost";
  if (deals.some(d => d.status === "lost")) return "stalled";
  return "org";
}
// el último trato perdido; con m, el último perdido CON propuesta (el que define «Perdido»)
export const lastLostWithProposal = (deals, m) => deals.filter(x => lostAfterProposal(x, m)).sort((x, y) => String(y.lost_time || y.update_time).localeCompare(String(x.lost_time || x.update_time)))[0] || null;
export const lastLost = deals => deals.filter(x => x.status === "lost").sort((x, y) => String(y.lost_time || y.update_time).localeCompare(String(x.lost_time || x.update_time)))[0] || null;
export function describe(status, deals, m) {
  if (status === "open") { const d = deals.find(isSalesOpen); return `${m.pipes[d.pipeline_id] || "Embudo"} · ${m.stages[d.stage_id] || "etapa"}`; }
  if (status === "lost") { const d = deals.filter(x => lostAfterProposal(x, m)).sort((x, y) => String(y.lost_time || y.update_time).localeCompare(String(x.lost_time || x.update_time)))[0] || lastLost(deals); return `Perdido ${(d.lost_time || d.update_time || "").slice(0, 10)} · con propuesta${d.lost_reason ? " · " + d.lost_reason : ""}`; }
  if (status === "stalled") { const d = lastLost(deals); return `Contactado ${(d.lost_time || d.update_time || "").slice(0, 10)}, sin avance${d.lost_reason ? " · " + d.lost_reason : ""}`; }
  if (status === "client") return "Ya trabaja con OrderEAT";
  if (status === "org") return "Existe en Pipe, sin tratos";
  return "No figura en Pipe";
}
export const openSalesDeal = deals => deals.find(isSalesOpen) || null;
// Fase comercial para pintar el colegio: activo (verde), onboarding (amarillo), cerrado (azul: firmó y no arrancó),
// churn (rojo) o propuesta enviada (violeta). null si no hay nada de eso.
const ONBOARDING_PIPE = Number(process.env.ONBOARDING_PIPELINE_ID || 16);
export function phaseOf(deals, m) {
  const cl = deals.filter(d => CLIENT_PIPES.includes(d.pipeline_id));
  const alive = d => d.status !== "lost" && !DEAD_STAGES.includes(d.stage_id);
  // en el embudo ONBOARDING: ya lanzado (READY FOR LAUNCH [active], LAUNCHED) o ganado = activo; el resto, onboarding
  const launched = d => d.status === "won" || /launched|\[active\]/i.test(m?.stages?.[d.stage_id] || "");
  const onb = cl.filter(d => alive(d) && d.pipeline_id === ONBOARDING_PIPE);
  if (onb.some(d => !launched(d)) && !cl.some(d => alive(d) && (d.pipeline_id !== ONBOARDING_PIPE || launched(d)))) return "onboarding";
  if (cl.some(alive)) return "activo";
  if (cl.length) return "churn";
  if (deals.some(d => d.status === "won")) return "cerrado";
  const open = deals.find(isSalesOpen);
  if (open && (PROPOSAL_STAGE.test(m?.stages?.[open.stage_id] || "") || /cotiz|quote/i.test(m?.stages?.[open.stage_id] || ""))) return "propuesta";
  return null;
}
