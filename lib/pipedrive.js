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
export const norm = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const STOP = new Set("colegio college school iep i e p ie iiee institucion educativa particular privado privada bilingue bilingual de del la el los las y the cep escuela instituto".split(" "));
export const tokens = s => norm(s).split(" ").filter(t => t && !STOP.has(t) && t.length > 1);

// Puntaje de una organización para un colegio (0 a 1): qué parte de las palabras propias del nombre del colegio
// están en el de la organización, +0.15 si la organización nombra la ciudad. Puro (sin pedidos): lo usan el cruce
// de a uno (findOrgCandidates) y la sincronización masiva (lib/sync.js), así los dos dan lo mismo.
// a: tokens(colegio), b: Set(tokens(organización)), city0: primera palabra de norm(ciudad del colegio)
export function scoreTokens(a, b, city0) {
  if (!a.length) return 0;
  let s = a.filter(t => b.has(t)).length / a.length;
  if (b.has(city0)) s += 0.15;
  return Math.min(1, s);
}
export const cityWord = school => norm(school.city).split(" ")[0];
export const scoreOrg = (school, org) => scoreTokens(tokens(school.name), new Set(tokens(org.name)), cityWord(school));
// Pueden competir las organizaciones que devolvería la búsqueda de Pipedrive con los términos de findOrgCandidates
// (exige todas las palabras): las que tienen todas las palabras propias del colegio o las dos primeras.
export const eligible = (a, b) => a.slice(0, 2).every(w => b.has(w)) || a.every(w => b.has(w));
// palabras de la organización que no están en el colegio (ni son su ciudad): desempata, gana la más parecida
export const extraWords = (a, b, city0) => { let n = 0; for (const w of b) if (w !== city0 && !a.includes(w)) n++; return n; };
// orden de los candidatos: mayor puntaje, después menos palabras de más, después la organización más vieja (id menor)
export const candBefore = (x, y) => x.score !== y.score ? x.score > y.score : (x.extra || 0) !== (y.extra || 0) ? (x.extra || 0) < (y.extra || 0) : x.id < y.id;
export const rankCandidates = list => list.sort((x, y) => candBefore(x, y) ? -1 : candBefore(y, x) ? 1 : 0);
// umbrales del cruce: desde PICK se elige la organización; desde SURE queda confirmada sin que nadie la elija
export const PICK = 0.67, SURE = 0.95;
// la elegida: la de mayor puntaje (candidatos ya ordenados de mayor a menor) si llega a PICK
export const pickOrg = candidates => candidates.find(o => o.score >= PICK) || null;
// Cruce sin organización elegida
export const noMatchRecord = candidates => ({ status: "new", detail: candidates.length ? "Sin coincidencia clara en Pipe" : "No figura en Pipe", orgId: null, orgName: null, confirmed: false, candidates });
// Cruce con la organización elegida, a partir de sus tratos (puro: los tratos y los usuarios ya vienen).
// motivo y fecha del mismo trato que define el estado (si es «Perdido», el perdido con propuesta)
export function matchRecord({ chosen, deals, m, ownerId, confirmed, candidates = [], cur = null }) {
  const status = deals.length ? classify(deals, m) : "org";
  const open = openSalesDeal(deals), lost = (status === "lost" && lastLostWithProposal(deals, m)) || lastLost(deals);
  return {
    status, detail: describe(status, deals, m), phase: phaseOf(deals, m), orgId: chosen.id, orgName: chosen.name,
    ownerId, ownerName: ownerId ? m.users.find(u => u.id === ownerId)?.name || "" : "",
    confirmed: !!confirmed,
    openDealId: open?.id || null, openDealOwnerId: open ? open.owner_id || open.user_id || null : null, openDealOwner: open ? m.users.find(u => u.id === (open.owner_id || open.user_id))?.name || "" : "",
    lostReason: lost?.lost_reason || "", lostAt: (lost?.lost_time || lost?.update_time || "").slice(0, 10) || null,
    dealCount: deals.length, candidates: candidates.filter(c => c.id !== chosen.id),
    leadId: cur?.orgId === chosen.id ? cur?.leadId || null : null,
  };
}
export async function findOrgCandidates(school) {
  const base = tokens(school.name), city0 = cityWord(school);
  const terms = [base.join(" "), base.slice(0, 2).join(" "), school.name];
  const seen = new Map();
  for (const t of terms) {
    if (!t || t.length < 2) continue;
    for (const o of await searchOrganizations(t)) {
      if (seen.has(o.id)) continue;
      const b = new Set(tokens(o.name));
      // la búsqueda también encuentra por dirección o notas: solo compite lo que tiene las palabras en el nombre
      if (eligible(base, b)) seen.set(o.id, { ...o, score: scoreTokens(base, b, city0), extra: extraWords(base, b, city0) });
    }
    if ([...seen.values()].some(o => o.score >= 0.8)) break;
  }
  return rankCandidates([...seen.values()]).slice(0, 6).map(({ extra, ...o }) => o);
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
