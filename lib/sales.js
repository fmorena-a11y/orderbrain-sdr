import crypto from "crypto";
import * as pd from "./pipedrive.js";
import { addVirtual, schools, byId, getMatch, setMatch, isFresh, addTouch, touchesFor, touchesSince, orgToSchool, allMatches, refreshMatch, withLock, canonicalId } from "./store.js";
import { market, MARKETS, DEAL_FIELDS, OPTIONS, TYPE_LABEL, CHANNEL_TYPE, LOST_REASONS, DAILY_GOAL, CLIENT_PIPES, FREE_OWNERS } from "./config.js";
import { OUTCOMES, MAIL_SENT, outcomeById, suggestNext, playbookFor, templates, scoreSchool, countAttempts } from "./playbook.js";
import { toUtc, fromUtc, todayIn, weekday, safeTz, addBusinessDays, confirmDay, addDays } from "./time.js";
import { structureNote, aiEnabled, callSummary as aiCallSummary } from "./ai.js";
import { buildTimeline, callSummary, page } from "./timeline.js";
import { brainOf, nearbyClients, brainVersion } from "./brain.js";
import { potentialOf } from "./potential.js";
import { slackFor, slackEnabled } from "./slack.js";
import { keyTokens } from "./scan.js";
import { webInfo, placesLookup } from "./enrich.js";
import { photosFor } from "./photos.js";
import { RESULTS, resultLine, withResult, demoPast, ddmm, demoBoard } from "./demos.js";
import * as MX from "./metrics.js";
import { getStudy, cacheGet, cacheGetMany, cacheSet, getProfiles, getArchived, setArchived, refreshArchived, touchWindow, allArchived, addMail, mailsFor, patchMail } from "./store.js";
import { validateMail } from "./gmail.js";
import { archiveError, archivePlan, canUnarchive, ARCHIVE_REASONS } from "./archive.js";
import { sameName, addrPlace, dupeOrgs, isClient, mergeBlock, mergeError, mergeRequestError, mergeStop, previewWarnings, linkedText } from "./merge.js";
import * as psync from "./sync.js";
import { canLead } from "./teams.js";
import { searchPlan, planKey, groupResults, orgTarget, leadTarget, cleanCursor, MIN_Q, DEAL_STATUS, TYPES } from "./pdsearch.js";
import * as EX from "./existing.js";

export { TYPE_LABEL };
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const stripHtml = h => String(h || "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|li|div)>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\n{3,}/g, "\n\n").trim();
const nice = d => `${weekday(d)} ${d.slice(8, 10)}/${d.slice(5, 7)}`;
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
// Quién firma en Pipedrive y en el ranking: el nombre de su usuario de Pipedrive (no se puede elegir el de otro)
export const signer = user => user.pdName || user.name || user.email;

// ---------- cruce con Pipedrive (7 días de validez)
// ---------- fichas de la agenda que no son colegios de la base: un prospecto (lead) o una organización de Pipedrive
// Se arman a pedido para poder trabajarlos desde la app (contexto, registrar, próximo paso) sin abrir Pipedrive.
// País como lo usa la app (México, Perú…) a partir de lo que guarda Pipedrive («Mexico», «Perú», código…)
const appCountry = raw => { const n = pd.norm(raw); if (!n) return ""; return Object.keys(MARKETS).find(k => pd.norm(k) === n || MARKETS[k].code.toLowerCase() === n) || ""; };
const countryFromOpt = id => Object.entries(OPTIONS.pais).find(([, v]) => String(v) === String(id))?.[0] || "";
// País por el prefijo de un teléfono internacional (+52…, 0052…). Si el prefijo es de más de un país (+1), no se adivina.
export const phoneCountry = (...phones) => {
  for (const x of phones) {
    const t = String(x || "").trim(); if (!/^(\+|00)/.test(t)) continue;
    const d = t.replace(/\D/g, "").replace(/^00/, "");
    const hits = Object.entries(MARKETS).filter(([, m]) => m.prefix && d.startsWith(m.prefix)), n = Math.max(0, ...hits.map(([, m]) => m.prefix.length));
    const best = hits.filter(([, m]) => m.prefix.length === n); if (best.length === 1) return best[0][0];
  }
  return "";
};
const paisWarn = c => `País ${c}: no existe en el campo País de Pipedrive, quedó sin completar.`;
export const personLabel = (name, role) => [String(name || "").trim(), String(role || "").trim() && `(${String(role).trim()})`].filter(Boolean).join(" ");
export async function openRecord(kind, rid, extra = {}) {
  if (kind === "org") {
    // cruzada con un colegio de la base: la ficha es la del colegio (no una copia pd-org-*: lo que se registre ahí tiene que
    // quedar en el colegio, para su cadencia, la meta, el ranking y su estado)
    const sid = orgSchoolMap().get(Number(rid));
    if (sid) return schoolListItem(byId.get(sid));
    const o = (await pd.orgsByIds([Number(rid)]))[0];
    if (!o) throw bad("No encontré esa organización en Pipedrive", 404);
    const s = addVirtual({ id: `pd-org-${o.id}`, name: o.name, city: o.city || extra.city || "", country: appCountry(o.country) || extra.country || "", src: "pipedrive", virtual: true, pdOrgId: o.id });
    // el prospecto de esta organización (si la ficha se abrió desde uno) queda guardado en el cruce, no solo en memoria
    if (extra.leadId) { s.leadId = extra.leadId; const mm = getMatch(s.id); if (mm && !mm.leadId) setMatch(s.id, { ...mm, leadId: extra.leadId }); }
    if (!isFresh(getMatch(s.id))) await checkSchool(s.id, { org: { id: o.id, name: o.name, ownerId: o.ownerId } });
    return schoolListItem(s);
  }
  if (kind === "lead") {
    const l = (await pd.leadsByIds([String(rid)]))[0];
    if (!l) throw bad("No encontré ese prospecto en Pipedrive", 404);
    await pd.loadFieldOptions().catch(() => {});
    const country = countryFromOpt(l.paisOpt), city = l.ciudadOpt ? pd.optionLabel(DEAL_FIELDS.ciudad, l.ciudadOpt) || "" : "";
    if (l.orgId) { const r = await openRecord("org", l.orgId, { leadId: l.id, country, city }); return String(r.id).startsWith("pd-") ? { ...r, leadId: l.id } : r; }
    const person = l.personId ? await pd.getPerson(l.personId).catch(() => null) : null;
    // si el prospecto ya pasó a trato (otra instancia lo convirtió), se sigue con su organización
    const conv = getMatch(`pd-lead-${l.id}`);
    // sin persona (o sin su teléfono), el del prospecto (campo personalizado Teléfono)
    const s = addVirtual({ id: `pd-lead-${l.id}`, name: l.title || person?.name || "Prospecto", city, country, phone: person?.phone || l.phone || "", email: person?.email || l.email || "",
      src: "pipedrive", virtual: true, leadOnly: true, leadId: l.id, personId: l.personId || null, personName: person?.name || "" });
    if (conv?.orgId) { s.leadOnly = false; s.pdOrgId = conv.orgId; }
    else setMatch(s.id, { status: "lead", detail: "Prospecto en Pipedrive", orgId: null, orgName: null, confirmed: true, leadId: l.id, candidates: [] });
    return schoolListItem(s);
  }
  throw bad("Ficha inválida");
}
// id de ficha virtual → la rearma si esta instancia no la tiene
export async function ensureRecord(id) {
  if (byId.has(id)) return true;
  const m = /^pd-(org|lead)-(.+)$/.exec(id); if (!m) return false;
  const r = await openRecord(m[1], m[2]);
  // un prospecto que ya pasó a organización: la misma id sigue abriendo la ficha (ahora de la organización)
  if (!byId.has(id) && r?.id && byId.has(r.id)) byId.set(id, byId.get(r.id));
  return byId.has(id);
}

// ---------- búsqueda en toda la base de Pipedrive (Prospectar y la búsqueda rápida; reglas puras en lib/pdsearch.js)
// En vivo (Pipedrive es la fuente de verdad), solo lectura, con una copia de 60 s por término: «222 429 2676» y
// «2224292676» comparten la misma. Texto o email: una búsqueda por tipo (personas, organizaciones, prospectos y tratos, de
// a 50 con su cursor: ninguno tapa a otro y se sabe si hay más). Teléfono: personas por teléfono + itemSearch con los
// dígitos + el número con espacios en los campos de texto; si no aparece nada, los últimos 10 y 7 dígitos. Si una de las
// búsquedas falla se muestra lo demás (partial); si fallan todas, error.
const pdsCache = new Map(), PDS_TTL = 60e3, PDS_PAGE = 50;
const orgSchoolMap = () => new Map([...orgToSchool()].filter(([, sid]) => byId.has(sid)).map(([oid, sid]) => [Number(oid), sid]));
const userNames = m => new Map((m?.users || []).map(u => [Number(u.id), u.name]));
// jobs: [[clave, promesa de { items, next }]] → ok: [[clave, valor]] de las que respondieron
async function settleAll(jobs) {
  const r = await Promise.allSettled(jobs.map(j => j[1])), ok = r.map((x, i) => x.status === "fulfilled" ? [jobs[i][0], x.value || { items: [] }] : null).filter(Boolean);
  if (!ok.length) throw r[0].reason;
  return { ok, raw: ok.flatMap(([, v]) => v.items || []), partial: ok.length < r.length };
}
// ciudad y país de las organizaciones de los resultados: las cruzadas, del colegio; las otras, de Pipedrive (un pedido de
// hasta 100). Si falla, sin ciudad (no rompe la búsqueda).
async function orgPlaces(raw, o2s) {
  const ids = [...new Set(raw.filter(r => r?.item?.type === "organization").map(r => Number(r.item.id)).filter(Boolean))], places = new Map(), ask = [];
  const txt = (city, region, country) => [city || region, country].filter(Boolean).join(", ");
  for (const id of ids) { const sc = byId.get(o2s.get(id)); if (sc?.city || sc?.country) places.set(id, txt(sc.city, "", sc.country)); else ask.push(id); }
  if (ask.length) for (const o of await pd.orgsByIds(ask.slice(0, 100)).catch(() => [])) { const t = txt(o.city, o.region, appCountry(o.country) || o.country); if (t) places.set(Number(o.id), t); }
  return places;
}
async function pdCtx(raw, plan, term) {
  const o2s = orgSchoolMap(), [m, places] = await Promise.all([pd.meta().catch(() => null), orgPlaces(raw, o2s)]);
  return { users: userNames(m), pipes: m?.pipes || {}, free: FREE_OWNERS, o2s, places, web: pd.PD_WEB, plan, term };
}
async function runPdSearch(plan) {
  const first = plan.terms[0];
  if (plan.kind !== "phone") {
    const { ok, raw, partial } = await settleAll(TYPES.map(t => [t, pd.searchItems(first, { types: t, limit: PDS_PAGE })]));
    const next = Object.fromEntries(ok.map(([t, v]) => [t, v.next || null]));
    const g = groupResults(raw, await pdCtx(raw, plan, first), { next });
    return { kind: plan.kind, term: first, ...g, ...(partial ? { partial: true } : {}), at: new Date().toISOString() };
  }
  const phoneJobs = t => [["persons", pd.searchPersonsByPhone(t)], ["items", pd.searchItems(t, { limit: PDS_PAGE })]];
  let term = first, { ok, raw, partial } = await settleAll([...phoneJobs(first), ...plan.spaced.map(v => ["spaced", pd.searchItems(v, { fields: "custom_fields,notes", limit: PDS_PAGE })])]);
  for (const t of plan.terms.slice(1)) {
    if (raw.length) break;
    try { const r = await settleAll(phoneJobs(t)); ok = r.ok; raw = r.raw; partial ||= r.partial; term = t; }
    catch { partial = true; break; } // ya hubo una respuesta (vacía): lo que falta se avisa, no es un error
  }
  // (un teléfono con más de 50 resultados es raro: si pasa, cualquier grupo puede tener más)
  const capped = ok.some(([, v]) => v.next);
  const g = groupResults(raw, await pdCtx(raw, plan, term), { capped });
  return { kind: plan.kind, term, ...g, ...(partial ? { partial: true } : {}), at: new Date().toISOString() };
}
function pdsCached(k, run) {
  const now = Date.now(), hit = pdsCache.get(k);
  if (hit && now - hit.at < PDS_TTL) return hit.p;
  const p = run();
  pdsCache.delete(k); pdsCache.set(k, { at: now, p }); // al final: el orden del Map es el de antigüedad
  p.catch(() => { if (pdsCache.get(k)?.p === p) pdsCache.delete(k); }); // un error no queda guardado
  for (const [kk, v] of pdsCache) if (pdsCache.size > 300 || now - v.at >= PDS_TTL) pdsCache.delete(kk); else break;
  return p;
}
// (devuelve la misma promesa a quien pide lo mismo mientras está en curso o dentro de los 60 s)
export function pdSearch(q) {
  const plan = searchPlan(q);
  if (!plan) return Promise.reject(bad(`Escribí al menos ${MIN_Q} letras o números.`));
  return pdsCached(planKey(plan), () => runPdSearch(plan));
}
// «Ver más» de un grupo: la página siguiente de ese tipo (cursor de la búsqueda anterior; sin cursor, la primera página de
// ese tipo, para cuando la búsqueda mezclada de un teléfono llegó a su tope). term: el que usó la búsqueda (para un
// teléfono, uno de los de respaldo); si no es uno de los de lo escrito, el primero.
export function pdSearchMore(q, type, cursor, term) {
  const plan = searchPlan(q);
  if (!plan) return Promise.reject(bad(`Escribí al menos ${MIN_Q} letras o números.`));
  if (!TYPES.includes(type)) return Promise.reject(bad("Tipo inválido"));
  const cur = cursor ? cleanCursor(cursor) : null;
  if (cursor && !cur) return Promise.reject(bad("Página inválida"));
  const t = plan.terms.includes(String(term ?? "")) ? String(term) : plan.terms[0];
  return pdsCached(`${planKey(plan)}|${t}|${type}|${cur || ""}`, async () => {
    const r = await pd.searchItems(t, { types: type, limit: PDS_PAGE, cursor: cur || undefined });
    const g = groupResults(r.items, await pdCtx(r.items, plan, t), { next: { [type]: r.next } }).groups.find(x => x.type === type);
    return { type, items: g?.items || [], next: r.next || null, more: !!r.next };
  });
}
// Ficha de una persona de Pipedrive (la que se buscó, tenga o no organización): teléfonos, emails, dueño, su organización
// (y a qué ficha lleva), tratos (con el motivo y la fecha si se ganó o perdió), prospectos, actividades pendientes y hechas,
// y las últimas notas. missing: lo que no se pudo leer (se muestra igual lo demás).
export async function personCard(id) {
  const pid = Number(id);
  if (!Number.isInteger(pid) || pid <= 0) throw bad("Persona inválida");
  const p = await pd.getPersonFull(pid);
  if (!p) throw bad("No encontré esa persona en Pipedrive", 404);
  const parts = { meta: pd.meta(), pending: pd.activities({ personId: pid, done: false, limit: 20 }), done: pd.activities({ personId: pid, done: true, limit: 15 }),
    deals: pd.dealsForPerson(pid), leads: pd.leadsForPerson(pid), notes: pd.notesForPerson(pid, 5), org: p.orgId ? pd.orgsByIds([p.orgId]) : Promise.resolve([]) };
  const keys = Object.keys(parts), got = await Promise.allSettled(Object.values(parts)), v = {}, missing = [];
  keys.forEach((k, i) => { if (got[i].status === "fulfilled") v[k] = got[i].value; else { v[k] = null; if (k !== "meta") missing.push({ pending: "actividades", done: "actividades", deals: "tratos", leads: "prospectos", notes: "notas", org: "organización" }[k]); } });
  const users = userNames(v.meta), o2s = orgSchoolMap();
  const who = uid => !uid ? "" : FREE_OWNERS.has(Number(uid)) ? "Cuenta general" : users.get(Number(uid)) || "";
  const act = a => ({ id: a.id, subject: String(a.subject || "").slice(0, 160), type: a.type, typeLabel: TYPE_LABEL[a.type] || a.type, date: a.due_date || "", time: a.due_time || "", done: !!a.done,
    owner: who(a.owner_id ?? a.user_id), note: stripHtml(a.note).slice(0, 300) });
  const o = (v.org || [])[0];
  return { id: pid, name: p.name || "Sin nombre", phones: p.phones, emails: p.emails, owner: who(p.ownerId), url: `${pd.PD_WEB}/person/${pid}`,
    org: o ? { id: o.id, name: o.name, to: orgTarget(o.id, o2s) } : p.orgId ? { id: p.orgId, name: "", to: orgTarget(p.orgId, o2s) } : null,
    deals: (v.deals || []).slice(0, 20).map(d => ({ id: d.id, title: d.title || "Trato", status: DEAL_STATUS[d.status] || "", pipeline: v.meta?.pipes?.[d.pipeline_id] || "", stage: v.meta?.stages?.[d.stage_id] || "",
      owner: who(d.owner_id ?? d.user_id), url: `${pd.PD_WEB}/deal/${d.id}`, to: d.org_id ? orgTarget(d.org_id, o2s) : null,
      ...(d.status === "lost" ? { reason: String(d.lost_reason || "").slice(0, 200), closed: String(d.lost_time || d.close_time || "").slice(0, 10) } : d.status === "won" ? { closed: String(d.won_time || d.close_time || "").slice(0, 10) } : {}) })),
    leads: (v.leads || []).slice(0, 20).map(l => ({ id: l.id, title: l.title || "Prospecto", archived: !!l.archived, owner: who(l.ownerId), url: `${pd.PD_WEB}/leads/inbox/${encodeURIComponent(l.id)}`, to: leadTarget(l.id, l.orgId, o2s) })),
    pending: (v.pending || []).filter(a => !a.is_deleted).map(act), done: (v.done || []).filter(a => !a.is_deleted).map(act),
    notes: (v.notes || []).map(n => ({ at: n.add_time ? String(n.add_time).replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(n.add_time) ? "" : "Z") : null, by: n.user?.name || who(n.user_id), text: stripHtml(n.content).slice(0, 500) })),
    missing: [...new Set(missing)] };
}

export async function checkSchool(id, { force = false, org = null } = {}) {
  const s = byId.get(id);
  if (!s) throw bad("Colegio inexistente", 404);
  if (s.leadOnly && s.virtual) return getMatch(id) || setMatch(id, { status: "lead", detail: "Prospecto en Pipedrive", orgId: null, confirmed: true, leadId: s.leadId, candidates: [] });
  const cur = getMatch(id);
  // al día, salvo un «Nunca contactado» al que todavía no se le buscaron prospectos (lo dejó así la sincronización masiva,
  // que solo mira organizaciones): ahí se buscan, para que «Nunca contactado» quiera decir que no hay nada en Pipedrive
  if (!force && !org && isFresh(cur) && !needsLeadCheck(cur)) return leadView(s), cur;
  // la ficha y su Historial se piden juntos: el mismo cruce una sola vez
  if (!force && !org) {
    if (checking.has(id)) return checking.get(id);
    const p = (isFresh(cur) ? leadCheck(id, s, cur) : matchSchool(id, s, cur, {})).finally(() => checking.delete(id));
    checking.set(id, p); return p;
  }
  return matchSchool(id, s, cur, { org });
}
const checking = new Map();
async function matchSchool(id, s, cur, { org = null }) {
  // un prospecto sin organización (el cruce dice «Prospecto en Pipe»): si sigue abierto y alguien lo eligió («Es este»), se
  // mantiene; si ahora tiene organización, el colegio pasa a esa (con el prospecto). Elegido solo (auto): se recalcula.
  let keepLead = null;
  if (!org && cur?.status === "lead" && cur.leadId && !s.virtual) {
    let l;
    try { l = await pd.getLead(cur.leadId); } catch { return leadView(s), cur; } // sin saber, queda como estaba
    if (l && !l.archived) {
      if (l.orgId) { org = { id: l.orgId, name: cur.orgName || (await pd.orgsByIds([l.orgId]).catch(() => []))[0]?.name || l.title, ownerId: null }; keepLead = l; }
      else if (cur.confirmed && !cur.auto) return setLeadMatch(id, l, { cur, confirmed: true });
    }
  }
  let chosen = null, candidates = [], auto = false;
  const keep = pd.keepsOrg(cur, s, touchesFor(id).length > 0); // elegido a mano: se mantiene su organización
  if (org) chosen = { ...org, score: 1 };
  else if (keep) chosen = { id: cur.orgId, name: cur.orgName, score: 1 };
  else {
    const ctx = pd.matchCtx(schools);
    candidates = await pd.findOrgCandidates(s, ctx); chosen = pd.pickOrg(candidates);
    auto = !!chosen && pd.isSure(candidates, ctx.key(s));
  }
  if (!chosen) return leadCheck(id, s, { ...pd.noMatchRecord(candidates), ...(cur?.pdx ? { pdx: cur.pdx } : {}) });
  const [deals, m] = await Promise.all([pd.dealsForOrg(chosen.id), pd.meta()]);
  // dueño de la organización en Pipedrive: si es de otra persona, nadie más la prospecta
  let ownerId = chosen.ownerId ?? null;
  if (ownerId === null) ownerId = (await pd.orgsByIds([chosen.id]))[0]?.ownerId || null; // si falla, no se guarda un cruce «sin dueño»
  // las mismas reglas que la sincronización masiva (lib/sync.js): pd.matchRecord es puro
  const rec = pd.matchRecord({ chosen, deals, m, ownerId, confirmed: !!(org || keep), auto, candidates, cur });
  if (keepLead) rec.leadId = keepLead.id;
  return viewed(s, setMatch(id, rec));
}

// ---------- ¿ya está en Pipedrive? Investigación antes de crear (reglas puras en lib/existing.js)
// Muchos prospectos de la cuenta no tienen organización (los importados: «montessori angeles», con la dirección en su campo):
// el cruce por organizaciones no los ve. Antes de crear una organización o un prospecto se buscan prospectos, tratos y
// organizaciones por nombre (con y sin la ciudad), teléfono, mail y web, y las personas con ese teléfono o mail.
// Resultado (EX.decide): sure (se usa ese), maybe (se pregunta: 409 con las candidatas) o none (recién ahí se crea).
// En el cruce (checkSchool), sin organización, la versión liviana (solo el nombre): un prospecto seguro deja el colegio en
// «Prospecto en Pipe»; las dudas y el «no hay nada» quedan en el cruce (pdx) para la ficha.
const EX_TTL = 120e3, PDX_DAYS = 3;
const exCache = new Map();
const needsLeadCheck = m => !!m && m.status === "new" && !m.orgId && !(m.pdx?.at && Date.now() - Date.parse(m.pdx.at) < PDX_DAYS * 864e5);
const pdUrl = x => x.kind === "lead" ? leadUrlOf(x.id) : x.kind === "deal" ? `${pd.PD_WEB}/deal/${x.id}` : `${pd.PD_WEB}/organization/${x.id}`;
// lo que se guarda y se muestra de cada registro encontrado (sin datos de más)
const placeTxt = x => { for (const t of x.texts || []) { const a = EX.addrParts(t); if (a?.muni) return [a.muni, a.state].filter(Boolean).map(capWords).join(", "); } return x.org?.city ? [x.org.city, x.org.region].filter(Boolean).join(", ") : ""; };
const DEAL_TXT = { open: "trato abierto", won: "trato ganado", lost: "trato perdido" };
function exItem(x, users) {
  const kind = x.kind === "lead" ? (x.archived ? "prospecto archivado" : "prospecto") : x.kind === "deal" ? `${DEAL_TXT[x.status] || "trato"}${x.stage ? ` · ${x.stage}` : ""}` : "organización";
  const phone = (x.texts || []).find(t => EX.phonesIn(t).length) || "";
  return { key: x.key, kind: x.kind, id: x.id, title: x.title, what: kind, ownerId: x.ownerId || null, owner: x.ownerId ? users.get(Number(x.ownerId)) || "otra persona" : "",
    orgId: x.orgId || null, orgName: x.kind === "organization" ? "" : x.orgName || "", place: placeTxt(x), phone, why: x.why || "", level: x.level, url: pdUrl(x),
    ...(x.archived ? { archived: true } : {}), ...(x.status ? { status: x.status } : {}) };
}
// un trato como lo da /v2/deals (las personas encontradas por teléfono o mail): lo justo para juzgarlo
const recOfDeal = (d, extra = {}) => ({ key: `deal:${d.id}`, kind: "deal", id: d.id, title: d.title || "", ownerId: pd.realOwner(d.owner_id || d.user_id), orgId: d.org_id || null, orgName: "",
  personId: d.person_id || null, status: d.status || null, stage: "", texts: [], ...extra });
const labelsOf = l => ({ ciudad: l.ciudadOpt ? pd.optionLabel(DEAL_FIELDS.ciudad, l.ciudadOpt) || "" : "", estado: l.estadoOpt ? pd.optionLabel(DEAL_FIELDS.estado, l.estadoOpt) || "" : "", pais: countryFromOpt(l.paisOpt) });
async function runExQuery(q) {
  if (q.types === "person") return (q.fields === "phone" ? await pd.searchPersonsByPhone(q.term, 10) : await pd.searchItems(q.term, { types: "person", fields: "email", limit: 10 })).items.map(i => i.item);
  return (await pd.searchItems(q.term, { types: q.types, fields: q.fields, limit: 50 })).items.map(i => i.item);
}
// full: todo (antes de crear). Devuelve { at, full, judged, r: EX.decide(...) }. Un pedido que falla: 503 (no se crea nada).
export async function investigate(id, { full = true, force = false, me = null } = {}) {
  const s = byId.get(id); if (!s) throw bad("Colegio inexistente", 404);
  const c = exCache.get(id);
  if (!force && c && Date.now() - c.at < EX_TTL && (c.full || !full)) return { ...c, r: EX.decide(c.judged, { no: getMatch(id)?.pdx?.no || [], me }) };
  const ctx = EX.ctxOf(s, pd.matchCtx(schools).places), plan = EX.queryPlan(s, { full });
  const fail = () => bad("No pude revisar si ya existe en Pipedrive: probá de nuevo.", 503);
  let items;
  try { items = (await Promise.all(plan.map(runExQuery))).flat(); } catch (e) { console.warn("Investigación en Pipedrive:", e.message); throw fail(); }
  const judged = EX.judgeAll(s, ctx, items);
  if (full) {
    try {
      await pd.loadFieldOptions().catch(() => {});
      // las personas con el mismo teléfono o mail: sus prospectos, sus tratos y su organización (de a 2 personas)
      const persons = items.filter(it => it?.type === "person" && EX.contactHit(ctx.contact, { phones: it.phones || [], emails: it.emails || [] })).slice(0, 2);
      for (const p of persons) {
        const contact = EX.contactHit(ctx.contact, { phones: p.phones || [], emails: p.emails || [] }), extra = { contact, personId: p.id, personName: p.name || "" };
        const [leads, deals] = await Promise.all([pd.leadsForPerson(p.id), pd.dealsForPerson(p.id)]);
        for (const l of leads) judged.push(EX.judge(s, ctx, EX.recOfLead(l, labelsOf(l), extra)));
        for (const d of deals) judged.push(EX.judge(s, ctx, recOfDeal(d, extra)));
        if (p.organization?.id) judged.push(EX.judge(s, ctx, { key: `organization:${p.organization.id}`, kind: "organization", id: p.organization.id, title: p.organization.name || "", orgId: p.organization.id, texts: [p.organization.address].filter(Boolean), ...extra }));
      }
      // las organizaciones candidatas del cruce, con su ciudad (casi ninguna trae dirección)
      const cur = getMatch(id) || {}, cands = [...(cur.candidates || []), ...(cur.seen || [])].filter(x => x?.id && !cur.unlinked);
      const orgs = cands.length ? await pd.orgsByIds([...new Set(cands.map(x => Number(x.id)))]) : [];
      for (const o of orgs) judged.push(EX.judge(s, ctx, { key: `organization:${o.id}`, kind: "organization", id: o.id, title: o.name, ownerId: o.ownerId || null, orgId: o.id, org: { city: o.city, region: o.region, country: o.country }, texts: [o.addr].filter(Boolean) }));
    } catch (e) { console.warn("Investigación en Pipedrive:", e.message); throw fail(); }
  }
  // lo que ya está vinculado a OTRO colegio de la base (su organización o el prospecto) no se elige solo: se pregunta
  const o2s = orgSchoolMap(), leadOf = new Map(Object.entries(allMatches()).filter(([sid, m]) => m?.leadId && !sid.startsWith("pd-") && canonicalId(sid) !== id).map(([sid, m]) => [String(m.leadId), sid]));
  for (const x of judged) {
    if (x.level !== "sure") continue;
    const oid = x.kind === "organization" ? Number(x.id) : Number(x.orgId) || null, other = (oid && o2s.get(oid)) || (x.kind === "lead" && leadOf.get(String(x.id)));
    if (other && canonicalId(other) !== id) { x.level = "maybe"; x.why += `, pero ya está vinculado a «${byId.get(other)?.name || "otro colegio"}» de la base`; }
  }
  const out = { at: Date.now(), full, judged: [...new Map(judged.filter(x => x.level).map(x => [x.key, x])).values()] };
  exCache.set(id, out); if (exCache.size > 300) exCache.delete(exCache.keys().next().value);
  return { ...out, r: EX.decide(out.judged, { no: getMatch(id)?.pdx?.no || [], me }) };
}
// lo que queda en el cruce (pdx): cuándo se buscó, qué tan a fondo y lo dudoso (para la ficha), sin perder los descartados
async function pdxOf(id, inv, extra = {}) {
  const m = await pd.meta().catch(() => ({ users: [] })), users = userNames(m), prev = getMatch(id)?.pdx || {};
  const phone = !!EX.contactOf(byId.get(id) || {}).phones.length;
  return { at: new Date(inv.at).toISOString(), full: !!(inv.full || (prev.full && prev.at && Date.now() - Date.parse(prev.at) < PDX_DAYS * 864e5)), phone: inv.full ? phone : !!prev.phone, verdict: inv.r.verdict,
    maybe: inv.r.maybe.slice(0, 6).map(x => exItem(x, users)), info: inv.r.info.slice(0, 3).map(x => exItem(x, users)), ...(prev.no?.length ? { no: prev.no } : {}), ...extra };
}
// el colegio queda «Prospecto en Pipe» con ese prospecto (sin organización)
async function setLeadMatch(id, l, { cur = getMatch(id), confirmed = true, auto = false, pdx = undefined } = {}) {
  const m = await pd.meta().catch(() => ({ users: [] }));
  const person = l.personId ? await pd.getPerson(l.personId).catch(() => null) : null;
  const rec = setMatch(id, { status: "lead", detail: "Prospecto en Pipedrive (sin organización)", orgId: null, orgName: null, leadId: l.id, leadTitle: l.title || "",
    ownerId: l.ownerId || null, ownerName: l.ownerId ? m.users.find(u => u.id === l.ownerId)?.name || "" : "", personId: l.personId || null, personName: person?.name || "",
    confirmed: !!(confirmed || auto), auto: !!auto && !confirmed, candidates: cur?.candidates || [], ...(pdx || cur?.pdx ? { pdx: pdx || cur.pdx } : {}) });
  leadView(byId.get(id));
  return rec;
}
// Un colegio de la base cuyo cruce es un prospecto sin organización se trabaja como la ficha de un prospecto (leadOnly):
// lo que se registre va al prospecto y no se crea organización. Se rearma desde el cruce (otra instancia pudo cambiarlo).
const viewed = (s, rec) => (leadView(s), rec);
// el título del prospecto de la ficha (un colegio de la base en «Prospecto en Pipe» tiene el suyo: «montessori angeles»)
const leadTitleOf = s => (s.leadVia && getMatch(s.id)?.leadTitle) || s.name;
export function leadView(s) {
  if (!s || s.virtual) return s;
  const m = getMatch(s.id);
  if (m?.status === "lead" && m.leadId && !m.orgId) Object.assign(s, { leadOnly: true, leadVia: true, leadId: m.leadId, personId: m.personId || null, personName: m.personName || "" });
  else if (s.leadVia) { s.leadOnly = false; delete s.leadVia; delete s.leadId; delete s.personId; delete s.personName; }
  return s;
}
// El paso liviano del cruce, sin organización: un prospecto seguro → «Prospecto en Pipe» (o su organización, si tiene); si no,
// queda lo que había (rec) con lo dudoso o el «no hay nada» (pdx). Si Pipedrive falla, sin pdx (la ficha no dice «revisé»).
async function leadCheck(id, s, rec) {
  let inv;
  try { inv = await investigate(id, { full: false }); } catch { return viewed(s, setMatch(id, rec)); }
  const pick = inv.r.pick;
  if (pick?.kind === "lead" && !pick.archived) {
    const l = await pd.getLead(pick.id).catch(() => null);
    if (l && !l.archived) {
      const pdx = await pdxOf(id, inv, { pick: pick.key });
      if (!l.orgId) return setLeadMatch(id, l, { cur: rec, confirmed: false, auto: true, pdx });
      const o = (await pd.orgsByIds([l.orgId]).catch(() => []))[0];
      if (o) {
        const [deals, m] = await Promise.all([pd.dealsForOrg(o.id), pd.meta()]);
        const out = pd.matchRecord({ chosen: { id: o.id, name: o.name, score: 1 }, deals, m, ownerId: o.ownerId || null, auto: true, candidates: rec.candidates || [], cur: rec });
        return viewed(s, setMatch(id, { ...out, leadId: l.id, pdx }));
      }
    }
  }
  return viewed(s, setMatch(id, { ...rec, pdx: await pdxOf(id, inv) }));
}
const maybeErr = (msg, items, code = "pd_maybe") => Object.assign(bad(msg, 409), { code, candidates: items });
// Antes de escribir algo de un colegio sin organización (o con organización pero sin prospecto ni trato para él): la
// investigación completa y su decisión. sure: se usa (applyPick). maybe: 409 con las candidatas (la ficha pregunta «¿es
// alguno de estos?»; con «Es este» o «Es otro colegio» se vuelve a pedir). none: sigue (quien llama crea). Un colegio que ya
// es «Prospecto en Pipe»: el prospecto tiene que seguir abierto y ser tuyo o libre (uno de la cuenta general pasa a tu nombre).
// dry: sin escribir en Pipedrive (el chequeo de antes de mandar un mail). Devuelve { done: [...], warnings: [...] }.
export async function settleExisting(id, user, { dry = false } = {}) {
  const s = byId.get(id), done = [], warnings = [];
  if (!s || s.virtual) return { done, warnings };
  const me = Number(user?.pdUserId) || null;
  let rec = await checkSchool(id);
  if (s.leadOnly) { await guardLead(id, s, me, done, { dry }); return { done, warnings }; }
  if (rec.orgId && rec.openDealId) return { done, warnings };
  // con organización: si es cliente, ex cliente o de otra persona, no se va a crear nada (workLead lo deja en la organización)
  if (rec.orgId && (clientNow(schoolSummary(s), rec) || exClientNow(schoolSummary(s), rec) || (rec.ownerId && Number(rec.ownerId) !== me))) return { done, warnings };
  if (rec.orgId) {
    let open;
    try { open = await leadsHere(s, rec.orgId); } catch { throw bad("No pude revisar los prospectos en Pipedrive: probá de nuevo.", 503); }
    if (open.length) return { done, warnings };
  }
  const inv = await investigate(id, { full: true, me });
  let r = inv.r;
  // con organización, solo cuentan los prospectos de afuera (sin organización u otra) y los tratos sin organización
  if (rec.orgId) r = EX.decide(inv.judged.filter(x => (x.kind === "lead" && x.orgId !== rec.orgId) || (x.kind === "deal" && !x.orgId)), { no: getMatch(id)?.pdx?.no || [], me });
  setMatch(id, { ...getMatch(id), pdx: await pdxOf(id, { ...inv, r }) });
  const users = userNames(await pd.meta().catch(() => ({ users: [] })));
  if (r.verdict === "maybe") throw maybeErr("Ya hay algo parecido en Pipedrive: ¿es alguno de estos?", r.maybe.slice(0, 6).map(x => exItem(x, users)));
  if (r.verdict === "sure") await applyPick(id, user, r.pick, { dry, done, auto: true });
  for (const x of r.info) warnings.push(`En Pipedrive hay ${x.kind === "lead" ? "un prospecto archivado" : "un trato perdido sin organización"} de este colegio: «${x.title}»${x.ownerId ? ` (de ${users.get(Number(x.ownerId)) || "otra persona"})` : ""}. Lo dejé como estaba.`);
  return { done, warnings };
}
// el prospecto de un colegio «Prospecto en Pipe»: al día, abierto y tuyo o libre
async function guardLead(id, s, me, done, { dry = false } = {}) {
  let l;
  try { l = await pd.getLead(s.leadId); } catch { throw bad("No pude comprobar en Pipedrive de quién es el prospecto. Probá de nuevo.", 503); }
  if (!l || l.archived) { exCache.delete(id); setMatch(id, { ...pd.noMatchRecord(getMatch(id)?.candidates || []), pdx: undefined }); leadView(s); throw bad(`El prospecto «${getMatch(id)?.leadTitle || s.name}» ya no está abierto en Pipedrive. Probá de nuevo: lo vuelvo a buscar.`, 409); }
  if (l.orgId) { await checkSchool(id, { force: true }); return; } // ahora tiene organización: se sigue con ella
  if (l.ownerId && l.ownerId !== me) {
    const m = await pd.meta().catch(() => ({ users: [] }));
    throw maybeErr(`Ya hay un prospecto de ${m.users.find(u => u.id === l.ownerId)?.name || "otra persona"} para este colegio en Pipedrive: «${l.title}». Hablalo con esa persona.`, [], "pd_theirs");
  }
  if (!l.ownerId && !dry && me) await pd.updateLead(l.id, { owner_id: me }).then(() => { setMatch(id, { ...getMatch(id), ownerId: me }); done.push({ label: "El prospecto pasó a tu nombre (estaba en la cuenta general)", url: leadUrlOf(l.id) }); }).catch(() => {});
}
// Usar un registro de Pipedrive para el colegio (lo eligió la investigación o una persona con «Es este»).
// prospecto: con organización, el colegio pasa a esa (con el prospecto); sin organización, queda «Prospecto en Pipe» (si el
// colegio ya tiene organización, el prospecto pasa a ella). trato: su organización; sin organización, uno abierto tuyo o libre
// queda en una organización nueva a tu nombre, uno de otra persona no se toca (409), uno ganado es cliente (409).
// organización: «Es esta». auto: lo eligió la investigación (se vuelve a calcular).
async function applyPick(id, user, x, { dry = false, done = [], auto = false } = {}) {
  const s = byId.get(id), me = Number(user?.pdUserId) || null, users = userNames(await pd.meta().catch(() => ({ users: [] })));
  const who = oid => users.get(Number(oid)) || "otra persona";
  const cur = getMatch(id) || {};
  if (x.kind === "organization") { await linkSchool(id, { id: Number(x.id), name: x.title, ownerId: x.ownerId ?? null }); done.push({ label: `Ya estaba en Pipedrive: organización «${x.title}»`, url: pdUrl(x) }); return; }
  if (x.kind === "lead") {
    const l = await pd.getLead(x.id).catch(() => { throw bad("No pude leer ese prospecto en Pipedrive. Probá de nuevo.", 503); });
    if (!l) throw bad("Ese prospecto ya no está en Pipedrive.", 404);
    const theirs = l.ownerId && l.ownerId !== me;
    if (l.archived) {
      if (theirs) throw maybeErr(`Ese prospecto es de ${who(l.ownerId)} y está archivado: hablalo con esa persona.`, [], "pd_theirs");
      if (!dry) { await pd.updateLead(l.id, { is_archived: false, ...(me && !l.ownerId ? { owner_id: me } : {}) }); done.push({ label: `Desarchivé el prospecto «${l.title}»`, url: leadUrlOf(l.id) }); }
    }
    if (l.orgId && !(cur.orgId && cur.orgId !== l.orgId)) {
      const name = x.orgName || (await pd.orgsByIds([l.orgId]).catch(() => []))[0]?.name || l.title;
      await checkSchool(id, { org: { id: l.orgId, name, ownerId: null } });
      setMatch(id, { ...getMatch(id), leadId: l.id, ...(auto ? { auto: true, confirmed: true } : {}) });
    } else if (cur.orgId && !l.orgId) {
      // el colegio ya tiene organización: el prospecto suelto pasa a ella (si es tuyo o libre)
      if (theirs) { setMatch(id, { ...cur, leadOther: { id: l.id, title: l.title, ownerId: l.ownerId, owner: who(l.ownerId) } }); return; }
      if (!dry) { await pd.updateLead(l.id, { organization_id: cur.orgId, ...(me && !l.ownerId ? { owner_id: me } : {}) }); setMatch(id, { ...getMatch(id), leadId: l.id }); done.push({ label: `El prospecto «${l.title}» (sin organización) quedó en ${cur.orgName || "la organización"}`, url: leadUrlOf(l.id) }); }
      return;
    } else if (!l.orgId) await setLeadMatch(id, l, { confirmed: !auto, auto });
    else throw maybeErr("Ese prospecto está en otra organización de Pipedrive: vinculá el colegio a esa organización desde la ficha.", [], "pd_other_org");
    leadView(s);
    // sin organización, el prospecto es el único lugar donde escribir: si es de otra persona, no se toca
    if (theirs && s.leadOnly) throw maybeErr(`Ya hay un prospecto de ${who(l.ownerId)} para este colegio en Pipedrive: «${l.title}». Hablalo con esa persona.`, [], "pd_theirs");
    if (!l.ownerId && !dry && me) await pd.updateLead(l.id, { owner_id: me }).then(() => done.push({ label: "El prospecto pasó a tu nombre (estaba en la cuenta general)", url: leadUrlOf(l.id) })).catch(() => {});
    done.unshift({ label: `Ya estaba en Pipedrive: prospecto «${l.title}»`, url: leadUrlOf(l.id) });
    return;
  }
  // trato
  const d = await pd.getDeal(x.id).catch(() => { throw bad("No pude leer ese trato en Pipedrive. Probá de nuevo.", 503); });
  if (!d || d.is_deleted || d.status === "deleted") throw bad("Ese trato ya no está en Pipedrive.", 404);
  if (d.org_id) { await linkSchool(id, { id: Number(d.org_id), name: x.orgName || d.title, ownerId: null }); done.push({ label: `Ya estaba en Pipedrive: trato «${d.title}»`, url: pdUrl(x) }); return; }
  const owner = pd.realOwner(d.owner_id || d.user_id);
  if (d.status === "won") throw maybeErr(`Ya es cliente de OrderEAT: trato ganado «${d.title}» en Pipedrive.`, [], "pd_client");
  if (d.status === "lost") { setMatch(id, { ...getMatch(id), pdx: { ...(getMatch(id)?.pdx || {}), no: [...new Set([...(getMatch(id)?.pdx?.no || []), x.key])] } }); return; }
  if (owner && owner !== me) throw maybeErr(`Tiene un trato abierto de ${who(owner)} en Pipedrive («${d.title}», sin organización). Coordiná con esa persona.`, [], "pd_theirs");
  if (dry) return;
  // tuyo o libre y sin organización: queda en la organización del colegio (o en una nueva a tu nombre)
  let orgId = cur.orgId || null, orgName = cur.orgName || s.name;
  if (!orgId) {
    if (!me) throw bad(pd.NO_OWNER, 403);
    const o = await pd.createOrganization({ name: s.name, website: s.web, ownerId: me, address: { value: [s.addr, s.city, s.country].filter(Boolean).join(", "), locality: s.city, country: s.country } });
    orgId = o.id; orgName = o.name || s.name; done.push({ label: "Organización creada en Pipedrive a tu nombre", url: `${pd.PD_WEB}/organization/${orgId}` });
  }
  await pd.updateDeal(d.id, { org_id: orgId, ...(me && !owner ? { owner_id: me } : {}) });
  await checkSchool(id, { org: { id: orgId, name: orgName, ownerId: me } });
  done.push({ label: `El trato «${d.title}» (sin organización) quedó en ${orgName}`, url: `${pd.PD_WEB}/deal/${d.id}` });
}
// «Es este» (desde la pregunta o la ficha): solo uno de los que se ofrecieron (pdx) o que vuelve a encontrar la investigación
export async function useExisting(id, user, key) {
  const s = byId.get(id); if (!s) throw bad("Colegio inexistente", 404);
  if (s.virtual) throw bad("Es una ficha de Pipedrive.", 400);
  const k = String(key || "");
  const offered = m => [...(m?.pdx?.maybe || []), ...(m?.pdx?.info || [])].find(x => x.key === k);
  let x = offered(getMatch(id));
  if (!x) { const inv = await investigate(id, { full: true, me: user.pdUserId }); x = inv.judged.find(y => y.key === k); }
  if (!x) throw bad("Eso ya no aparece en Pipedrive para este colegio.", 404);
  const done = [];
  await applyPick(id, user, { ...x, texts: x.texts || [] }, { done });
  // ya se eligió: la pregunta no vuelve
  const m = getMatch(id); if (m?.pdx) setMatch(id, { ...m, pdx: { ...m.pdx, maybe: [], verdict: "sure", pick: k } });
  exCache.delete(id);
  return { ok: true, done };
}
// «Es otro colegio, crear prospecto nuevo»: lo que se preguntó queda descartado (la próxima investigación no lo vuelve a ofrecer)
export async function dismissExisting(id, keys = null) {
  const m = getMatch(id) || {}, list = keys?.length ? keys.map(String) : (m.pdx?.maybe || []).map(x => x.key);
  if (!list.length) return { ok: true };
  setMatch(id, { ...m, pdx: { ...(m.pdx || {}), at: m.pdx?.at || new Date().toISOString(), maybe: [], verdict: "none", no: [...new Set([...(m.pdx?.no || []), ...list])].slice(-30) } });
  return { ok: true };
}
// El asistente sin ficha («agendale a Colegio X»): ¿hay un prospecto o un trato abierto que se llame así? (mismo nombre)
export async function namedInPipedrive(name) {
  const s = { name, city: "", country: "" }, ctx = EX.ctxOf(s, pd.matchCtx(schools).places), t = EX.searchTerms(s).title[0];
  if (!t) return [];
  const items = await runExQuery({ types: "lead,deal", fields: "title", term: t }).catch(() => { throw bad("No pude revisar si ya existe en Pipedrive: probá de nuevo.", 503); });
  return items.filter(it => it.type !== "person" && !it.is_archived && it.status !== "lost" && EX.nameLevel(ctx.k, it.title || "", ctx.places) === "same").slice(0, 3).map(it => ({ title: it.title }));
}
// Los prospectos abiertos de la organización que son de ESTE colegio: una organización puede juntar prospectos de varias
// ciudades («COLEGIO LOS ANGELES» con los de Tlalpan, Los Cabos y Oaxaca): los de otra ciudad no son de este.
export async function leadsHere(s, orgId) {
  const open = await pd.leadsForOrg(orgId);
  if (!open.length || !s || s.virtual) return open;
  await pd.loadFieldOptions().catch(() => {});
  return open.filter(l => EX.placeLevel(s, EX.recOfLead(l, labelsOf(l))) !== "other");
}

// «no es esta organización»: queda marcado (unlinked) para que la sincronización masiva no la vuelva a elegir mientras dure
export function unlinkSchool(id) {
  return setMatch(id, { status: "new", detail: "Sin coincidencia confirmada", orgId: null, orgName: null, confirmed: false, auto: false, unlinked: true, candidates: getMatch(id)?.candidates || [] });
}

// ---------- «Es esta» y fusionar organizaciones duplicadas (reglas puras en lib/merge.js)
// «Es esta»: queda vinculada a mano. Las otras candidatas que vio la persona (y la que estaba elegida sola) quedan en el
// cruce (seen) para buscar entre ellas las duplicadas del mismo colegio (dupesFor): la masiva ve todas las organizaciones
// y la búsqueda de Pipedrive puede no traerlas.
const candRef = c => ({ id: Number(c.id), name: String(c.name || ""), ownerId: c.ownerId ?? null });
export async function linkSchool(id, org) {
  const cur = (await refreshMatch(id)) || {}, seen = new Map();
  for (const c of [...(cur.candidates || []), ...(cur.orgId ? [{ id: cur.orgId, name: cur.orgName, ownerId: cur.ownerId }] : []), ...(cur.seen || [])])
    if (c?.id && Number(c.id) !== Number(org.id) && !seen.has(Number(c.id))) seen.set(Number(c.id), candRef(c));
  const rec = await checkSchool(id, { org });
  return seen.size ? setMatch(id, { ...rec, seen: [...seen.values()].slice(0, 8) }) : rec;
}
// Lo que dice Pipedrive de una organización, para comparar: dirección, dueño, tratos, prospectos abiertos, actividades sin
// hacer y personas. _deals, _leads y _acts (crudos) son para los permisos y no salen al navegador (cardOut). leads, acts o
// persons null: no se pudieron leer.
async function orgCard(o, m) {
  const [deals, leads, acts, persons] = await Promise.all([pd.dealsForOrg(o.id), pd.leadsForOrg(o.id).catch(() => null),
    pd.activities({ orgId: o.id, done: false, limit: 50 }).catch(() => null), pd.personsForOrg(o.id).catch(() => null)]);
  const uname = uid => uid ? m.users.find(u => u.id === Number(uid))?.name || "" : "";
  return { id: o.id, name: o.name, city: o.city || "", region: o.region || "", country: o.country || "", addr: o.addr || "", ownerId: o.ownerId || null, owner: uname(o.ownerId),
    url: `${pd.PD_WEB}/organization/${o.id}`, client: isClient(deals),
    deals: deals.map(d => ({ id: d.id, title: d.title || "", status: d.status, pipeline: m.pipes[d.pipeline_id] || "", stage: m.stages[d.stage_id] || "", owner: uname(pd.realOwner(d.owner_id || d.user_id)), clientPipe: CLIENT_PIPES.includes(Number(d.pipeline_id)) })),
    leads: leads && leads.map(l => ({ id: l.id, title: l.title, owner: uname(l.ownerId) })),
    acts: acts && acts.filter(x => !x.done).map(x => ({ id: x.id, subject: x.subject || "", type: x.type || "", due: x.due_date || "", owner: uname(pd.realOwner(x.owner_id ?? x.user_id)) })),
    persons: persons && persons.length, personsMore: (persons?.length || 0) >= 20,
    _deals: deals, _leads: leads, _acts: acts };
}
const cardOut = ({ _deals, _leads, _acts, ...c }) => c;
// Organizaciones vinculadas a OTROS colegios de la base (no a fichas de Pipedrive): orgId → [ids de colegios]
function linkedElsewhere(id) {
  const out = new Map();
  for (const [sid, m] of Object.entries(allMatches())) {
    if (!m?.orgId || sid.startsWith("pd-") || canonicalId(sid) === id) continue;
    const o = Number(m.orgId); if (!out.has(o)) out.set(o, []); out.get(o).push(sid);
  }
  return out;
}
// ids de colegios → [{ id, name, city }] (sin repetir ni los que ya no están en la base)
const linkedSchools = (ids = []) => [...new Map(ids.map(sid => byId.get(sid)).filter(Boolean).map(x => [x.id, { id: x.id, name: x.name, city: x.city || "" }])).values()];
// «¿Estás seguro?»: solo una organización que la ficha ofrece (candidata, la elegida o una vista antes). Con avisos
// (lib/merge.js, previewWarnings): ya vinculada a otro colegio de la base, de otra ciudad, u otra organización del mismo
// colegio en la misma ciudad con un trato abierto (de otra persona o tuyo).
export async function orgPreview(id, orgId, user = null) {
  const s = byId.get(id); if (!s) throw bad("Colegio inexistente", 404);
  const rec = getMatch(id) || {}, oid = Number(orgId);
  const offered = [...(rec.orgId ? [{ id: rec.orgId, name: rec.orgName }] : []), ...(rec.candidates || []), ...(rec.seen || [])];
  if (!oid || !offered.some(c => Number(c.id) === oid)) throw bad("Esa organización no es candidata de este colegio.", 404);
  // las otras que se llaman como el colegio: si alguna es de la misma ciudad y tiene un trato abierto, se avisa
  const ctx = pd.matchCtx(schools), k = ctx.key(s);
  const others = [...new Map(offered.filter(c => Number(c.id) !== oid && sameName(k, c.name, ctx.places)).map(c => [Number(c.id), c])).keys()].slice(0, 4);
  const [orgs, m] = await Promise.all([pd.orgsByIds([oid, ...others]), pd.meta()]);
  const o = orgs.find(x => x.id === oid);
  if (!o) throw bad("No encontré esa organización en Pipedrive: puede que la hayan fusionado o borrado.", 404);
  const same = orgs.filter(x => x.id !== oid && addrPlace(s, x) !== "other" && (sameName(k, x.name, ctx.places)?.city || addrPlace(s, x) === "same"));
  const open = (await Promise.all(same.map(x => pd.dealsForOrg(x.id).then(d => ({ x, d }), () => null)))).filter(Boolean).flatMap(({ x, d }) => {
    const deal = pd.openSalesDeal(d) || d.find(y => y.status === "open"), owner = deal && pd.realOwner(deal.owner_id ?? deal.user_id);
    return owner ? [{ id: x.id, name: x.name, ownerId: owner, owner: m.users.find(u => u.id === owner)?.name || "" }] : [];
  });
  const linkedTo = linkedSchools(linkedElsewhere(id).get(oid));
  return { org: cardOut(await orgCard(o, m)), linkedTo, warnings: previewWarnings({ school: s, org: o, linkedTo, open, me: user?.pdUserId || null }) };
}
// Cuántas duplicadas encontró la última búsqueda (dupesFor): la ficha muestra «Está cargada N veces más · Revisar»
function saveDupeCount(id, orgId, n) {
  const cur = getMatch(id);
  if (cur && Number(cur.orgId) === Number(orgId) && (cur.dupeCount || 0) !== n) setMatch(id, { ...cur, dupeCount: n });
}
// Después de «Es esta» (o desde «Revisar» en la ficha): las otras organizaciones que son el mismo colegio (dupeOrgs) con lo
// que tiene cada una y qué impide fusionarla para quien pregunta (mergeBlock); keepBlock: lo que impide juntar en la
// vinculada; stop (mergeStop): lo que lo impide para todos (colegio sin ciudad, ficha de Pipedrive o la vinculada ya es de
// otro colegio de la base; linkedTo: cuáles). Solo si la eligió una persona (confirmada a mano). Salen de las candidatas
// vistas (seen) y de buscar el nombre propio del colegio en Pipedrive.
export async function dupesFor(id, user, { leader = false } = {}) {
  const s = byId.get(id); if (!s) throw bad("Colegio inexistente", 404);
  const rec = (await refreshMatch(id)) || {};
  const none = { keep: null, keepBlock: null, stop: null, linkedTo: [], dupes: [], leader: !!leader };
  if (s.leadOnly || !rec.orgId || !rec.confirmed || rec.auto) return none;
  const keepId = Number(rec.orgId), linked = linkedElsewhere(id), linkedTo = linkedSchools(linked.get(keepId));
  const stop = mergeStop({ school: s, linkedTo });
  if (stop) { saveDupeCount(id, keepId, 0); return { ...none, stop, linkedTo }; }
  const ctx = pd.matchCtx(schools), k = ctx.key(s);
  const found = new Map((rec.seen || []).map(c => [Number(c.id), c]));
  if (k.strong) for (const t of new Set([k.a.join(" "), k.a.slice(0, 2).join(" ")]))
    for (const o of await pd.searchOrganizations(t, 50, { nameOnly: true })) if (!found.has(Number(o.id))) found.set(Number(o.id), o);
  found.delete(keepId);
  // primero por nombre (sin pedidos); la dirección, solo de las que pasan
  const named = [...found.values()].filter(o => sameName(k, o.name, ctx.places)).slice(0, 20);
  const [orgs, m] = await Promise.all([pd.orgsByIds([keepId, ...named.map(o => Number(o.id))]), pd.meta()]);
  const keepO = orgs.find(o => o.id === keepId);
  if (!keepO) throw bad("No encontré la organización vinculada en Pipedrive: puede que la hayan fusionado o borrado.", 404);
  const { dupes } = dupeOrgs({ school: s, k, ctx, keep: keepO, orgs: orgs.filter(o => o.id !== keepId), linked });
  const top = dupes.slice(0, 6);
  const me = user?.pdUserId || null, nameOf = uid => m.users.find(u => u.id === Number(uid))?.name || "";
  const [keep, ...cards] = await Promise.all([orgCard(keepO, m), ...top.map(x => orgCard(orgs.find(o => o.id === x.id), m))]);
  const block = c => mergeBlock({ org: c, deals: c._deals, leads: c._leads || [], leadsUnknown: !c._leads, acts: c._acts || [], actsUnknown: !c._acts, me, leader, nameOf });
  // cliente en OrderBrain: lo fusiona quien ve todo (dirección, los fijos o, sin equipos, un líder); un líder de equipo no
  // (no se sabe de qué equipo es la cuenta)
  const keepBlock = block(keep) || (leader !== true && brainOf(s)?.client ? `Es cliente en OrderBrain: la fusiona ${leader ? "dirección" : "un líder"}` : null);
  saveDupeCount(id, keepId, top.length);
  return { keep: cardOut(keep), keepBlock, stop: null, linkedTo, leader: !!leader,
    dupes: cards.map((c, i) => ({ ...cardOut(c), sameCity: top[i].sameCity, cityFrom: top[i].cityFrom, elsewhere: top[i].elsewhere, elsewhereAt: top[i].elsewhereAt, block: block(c) })) };
}
const joinY = l => l.length > 1 ? `${l.slice(0, -1).join(", ")} y ${l.at(-1)}` : l[0] || "";
// Fusionar en la vinculada (keepId) las duplicadas elegidas (mergeIds), con los controles de lib/merge.js (mergeError):
// la que queda es la elegida a mano, cada una es duplicada según dupesFor y es tuya o libre (o sos líder; un cliente, solo
// un líder). De a una con la fusión de Pipedrive (queda keepId). Después: nota en la que queda, los cruces que apuntaban a
// las borradas pasan a la que queda (lo elegido a mano sigue elegido a mano), las borradas salen de las candidatas de los
// cruces, de la foto de la sincronización masiva y de las sedes, y el colegio se recalcula con todos los tratos juntos.
export async function mergeOrgs(id, user, { keepId, mergeIds = [], leader = false, by = "", tz = "America/Mexico_City" } = {}) {
  const s = byId.get(id); if (!s) throw bad("Colegio inexistente", 404);
  keepId = Number(keepId);
  const ids = [...new Set((Array.isArray(mergeIds) ? mergeIds : []).map(Number))].filter(n => Number.isInteger(n) && n > 0);
  // una fusión por vez entre instancias: dos cruzadas (A en B y B en A) borrarían las dos
  return withLock("merge-orgs", async () => {
    const rec = await refreshMatch(id);
    const pre = mergeRequestError({ rec, keepId, mergeIds: ids }); if (pre) throw bad(pre.msg, pre.status);
    const d = await dupesFor(id, user, { leader });
    const err = mergeError({ rec, keepId, mergeIds: ids, dupes: d.dupes, keepBlock: d.keepBlock, stop: d.stop }); if (err) throw bad(err.msg, err.status);
    const keep = d.keep, names = new Map(d.dupes.map(x => [x.id, x.name])), done = [], merged = [];
    for (const mid of ids) {
      try { await pd.mergeOrganization(mid, keepId); merged.push(mid); done.push({ label: `«${names.get(mid)}» (id ${mid}) quedó dentro de «${keep.name}»${names.get(mid) === keep.name ? ` (id ${keepId})` : ""}`, url: keep.url }); }
      catch (e) { done.push({ label: `No pude fusionar «${names.get(mid)}»: ${e.message}`, warn: true }); break; }
    }
    if (!merged.length) throw bad(done[0].label, 502);
    // queda merge_with_id: si la vinculada no está en Pipedrive después de fusionar, no toco nada más (que lo revise una persona)
    const after = await pd.orgsByIds([keepId]).catch(() => null);
    if (after && !after.length) {
      done.push({ label: `Pipedrive no muestra «${keep.name}» después de fusionar: revisalo en Pipedrive antes de seguir.`, warn: true });
      return { done, merged, keep: { id: keepId, name: keep.name, url: keep.url }, school: schoolSummary(s) };
    }
    // fecha y autor primero: «Últimas notas» muestra el comienzo
    const who = by || signer(user), list = joinY(merged.map(mid => `«${names.get(mid)}» (id ${mid})`));
    await pd.addNote({ content: esc(`Fusión ${ddmm(todayIn(tz))} (${who}, OrderBrain SDR): ${merged.length === 1 ? "se juntó" : "se juntaron"} ${list}`), orgId: keepId })
      .then(() => done.push({ label: `Nota en «${keep.name}»: fusionada con ${list}`, url: keep.url }))
      .catch(e => done.push({ label: `No pude dejar la nota en «${keep.name}»: ${e.message}`, warn: true }));
    const n = await afterMerge(id, { id: keepId, name: keep.name, ownerId: keep.ownerId }, merged);
    if (n) done.push({ label: n === 1 ? `Otro colegio que apuntaba a una fusionada ahora apunta a «${keep.name}»` : `${n} colegios que apuntaban a las fusionadas ahora apuntan a «${keep.name}»` });
    const fresh = await checkSchool(id, { org: { id: keepId, name: keep.name, ownerId: keep.ownerId } }).catch(() => getMatch(id));
    const rest = (rec.seen || []).filter(c => !merged.includes(Number(c.id)));
    if (fresh) setMatch(id, { ...fresh, seen: rest, dupeCount: Math.max(0, d.dupes.length - merged.length) });
    return { done, merged, keep: { id: keepId, name: keep.name, url: keep.url }, school: schoolSummary(s) };
  });
}
// Lo que apuntaba a las borradas (gone). Devuelve cuántos colegios de la base pasaron a la que queda.
async function afterMerge(id, keep, gone) {
  const g = new Set(gone.map(Number)), drop = l => (l || []).filter(c => !g.has(Number(c.id)));
  sedeCache.clear();
  const [deals, m] = await Promise.all([pd.dealsForOrg(keep.id).catch(() => null), pd.meta().catch(() => null)]);
  let moved = 0;
  for (const [sid, rec] of Object.entries(allMatches())) {
    if (!rec || canonicalId(sid) === id) continue;
    if (g.has(Number(rec.orgId))) {
      // vinculado a una borrada: pasa a la que queda (si alguien la eligió a mano, sigue elegida a mano)
      const hand = pd.keepsOrg(rec, byId.get(sid) || null, touchesFor(sid).length > 0);
      const next = deals && m ? pd.matchRecord({ chosen: { id: keep.id, name: keep.name, score: 1 }, deals, m, ownerId: keep.ownerId ?? null, confirmed: hand, candidates: drop(rec.candidates), cur: rec })
        : { ...rec, orgId: keep.id, orgName: keep.name, candidates: drop(rec.candidates) };
      setMatch(sid, rec.seen ? { ...next, seen: drop(rec.seen) } : next);
      if (!sid.startsWith("pd-")) moved++;
      continue;
    }
    // candidatas (o vistas) que ya no existen: fuera de la ficha
    if (isFresh(rec) && [rec.candidates, rec.seen].some(l => l && drop(l).length !== l.length))
      setMatch(sid, { ...rec, ...(rec.candidates ? { candidates: drop(rec.candidates) } : {}), ...(rec.seen ? { seen: drop(rec.seen) } : {}) });
  }
  await psync.forgetOrgs([...g]).catch(e => console.warn("No pude sacar las fusionadas de la foto de Pipedrive:", e.message));
  return moved;
}

// Para la lista (puede haber decenas de miles): solo lo que usa la interfaz. La ficha trae el resto.
const LIST_FIELDS = ["id", "name", "city", "country", "lat", "lng", "addr", "phone", "web", "rating", "found", "fit", "src", "area", "osm"];
const BRAIN_PHASE = st => /^Churn/.test(st) ? "churn" : { Active: "activo", Onboarding: "onboarding", Closed: "cerrado" }[st] || null;
// Cruce efectivo: si OrderBrain dice que ya es cliente, manda eso aunque Pipedrive no lo tenga.
function effMatch(s) {
  const m = getMatch(s.id), fm = isFresh(m) ? m : null, b = brainOf(s);
  if (b?.client) return { ...(fm || {}), status: "client", detail: `Cliente en OrderBrain (${b.label})`, checkedAt: new Date().toISOString() };
  // archivado en la app: fuera de la cola, del alto potencial y de las sesiones
  const a = getArchived(s.id); if (a) return { ...(fm || {}), status: "archived", detail: archiveDetail(a), checkedAt: new Date().toISOString() };
  // ex cliente (churn en World Dominion o en Pipedrive): nunca puede ser «nunca contactado»
  if ((b?.churn || fm?.phase === "churn") && fm?.status !== "open") return { ...(fm || {}), status: "churn", churnLabel: b?.label || "Se dio de baja (Pipedrive)", detail: b?.churn ? `${b.label} (OrderBrain)` : "Se dio de baja según Pipedrive", checkedAt: new Date().toISOString() };
  return fm;
}
const archiveDetail = a => `Archivado: ${a.reason}${a.text ? ` · ${a.text}` : ""}`;
// Alto potencial (lib/potential.js): solo para lo que se puede contactar (no clientes, ex clientes, tratos abiertos ni archivados).
const potMemo = new Map(); let potV = -1;
export function potentialFor(s, status) {
  if (["client", "churn", "open", "archived"].includes(status)) return null;
  if (potV !== brainVersion()) { potMemo.clear(); potV = brainVersion(); }
  if (!potMemo.has(s.id)) { const r = potentialOf(s, { nearClients: nearbyClients(s.lat, s.lng) }); potMemo.set(s.id, r?.high ? r.why : null); }
  return potMemo.get(s.id);
}
export function schoolListItem(s) {
  const full = schoolSummary(s), out = {};
  for (const k of [...LIST_FIELDS, "status", "detail", "orgId", "lastTouch", "attempts", "ob", "phase", "ownerId", "ownerName", "lead"]) if (full[k] !== undefined && full[k] !== "" && full[k] !== null) out[k] = full[k];
  if (!out.status) out.status = "unk";
  if (!out.attempts) delete out.attempts;
  if (!out.lead) delete out.lead;
  if (full.pot) out.pot = full.pot;
  return out;
}
export function schoolSummary(s) {
  const m = getMatch(s.id);
  const fresh = m && isFresh(m);
  const t = touchesFor(s.id);
  const last = t[t.length - 1];
  const b = brainOf(s);
  const churn = (b?.churn || (fresh && m.phase === "churn")) && !(fresh && m.status === "open");
  const arch = !b?.client && getArchived(s.id), st = b?.client ? "client" : arch ? "archived" : churn ? "churn" : fresh ? m.status : "unk";
  return { ...s, status: st,
    detail: b?.client ? `Cliente en OrderBrain (${b.label})` : arch ? archiveDetail(arch) : churn ? (b?.churn ? `${b.label} (OrderBrain)` : "Se dio de baja según Pipedrive") : m?.detail || "", orgId: m?.orgId || null, checkedAt: m?.checkedAt || null,
    ownerId: fresh ? m.ownerId || null : null, ownerName: fresh ? m.ownerName || "" : "", lead: !!(fresh && m.leadId && m.status !== "open"),
    ob: b ? { label: b.label, churn: b.churn, site: b.site, client: b.clientName } : null,
    // World Dominion manda; si no está ahí, lo que dicen los tratos de Pipedrive
    phase: arch ? null : b ? BRAIN_PHASE(b.status) : fresh ? m.phase || null : null,
    lastTouch: last ? { at: last.at, by: last.byName, outcome: outcomeById(last.outcome)?.label || "" } : null, attempts: countAttempts(t),
    pot: potentialFor(s, st) || undefined };
}

// ---------- ficha completa
// Tratos abiertos: dueño, embudo y sus etapas (para moverlos desde la ficha) y cuál es «propuesta enviada» en ese embudo.
// Los embudos de clientes (onboarding, clientes, performance) no se tocan desde acá: van sin etapas y el servidor los rechaza.
const dealOps = (d, m) => ({ id: d.id, ownerId: Number(d.owner_id || d.user_id) || null, stageId: d.stage_id, clientPipe: CLIENT_PIPES.includes(Number(d.pipeline_id)),
  ...(d.status === "open" && !CLIENT_PIPES.includes(Number(d.pipeline_id)) ? { stages: pd.pipeStages(m, d.pipeline_id).map(x => ({ id: x.id, name: x.name })), proposalStage: pd.proposalStage(m, d.pipeline_id) } : {}) });
// «Preguntá por …»: lo último que dijo recepción, de un contacto registrado en la app o de una nota con «Preguntar por:».
// Solo lo que alguien escribió: si no hay, null.
const splitAsk = v => { const t = String(v || "").trim(), m = t.match(/^(.*?)\s*\(([^()]*)\)$/); return m ? { name: m[1].trim(), role: m[2].trim() } : { name: t, role: "" }; };
export function askFor(t, notes = []) {
  const x = [...t].reverse().find(y => y.ask?.name);
  const n = notes.map(n => ({ at: String(n.add_time || "").replace(" ", "T") + "Z", m: stripHtml(n.content).match(/Preguntar por:\s*([^\n]+)/) })).filter(n => n.m).sort((a, b) => b.at.localeCompare(a.at))[0];
  if (n && (!x || n.at > x.at)) { const a = splitAsk(n.m[1]); return a.name ? { ...a, at: n.at } : null; }
  return x ? { name: x.ask.name, role: x.ask.role || "", at: x.at } : null;
}
// Candidatas de «¿Es alguna de estas organizaciones?»: ciudad y dueño en Pipedrive, si la dirección es de otra ciudad y
// a qué otro colegio de la base ya está vinculada. { [orgId]: { place, ownerId, owner, other, linked } }; null si no hay
// candidatas o no se pudo leer (la lista sale igual, sin esos datos).
async function candInfo(s, rec) {
  const c = !rec.confirmed ? rec.candidates || [] : [];
  if (!c.length) return null;
  const [orgs, m] = await Promise.all([pd.orgsByIds(c.map(x => Number(x.id))), pd.meta()]).catch(() => [null, null]);
  if (!orgs) return null;
  const linked = linkedElsewhere(s.id);
  return Object.fromEntries(orgs.map(o => [o.id, { place: [o.city, o.region].filter(Boolean).join(", ") || (o.country && o.country !== s.country ? o.country : ""),
    ownerId: o.ownerId || null, owner: o.ownerId ? m.users.find(u => u.id === o.ownerId)?.name || "" : "", other: addrPlace(s, o) === "other",
    linked: linkedText(linkedSchools(linked.get(o.id))) }]));
}
export async function schoolDetail(id, { user, tz, ...opts } = {}) {
  const s = byId.get(id);
  const rec = await checkSchool(id, opts);
  const t = touchesFor(id);
  const base = {
    match: rec, cands: await candInfo(s, rec), school: schoolSummary(s), market: market(s.country), playbook: playbookFor(s, effMatch(s) || rec), brain: brainOf(s),
    attempts: countAttempts(t), touches: t.slice(-15).reverse().map(x => ({ at: x.at, by: x.byName, outcome: outcomeById(x.outcome)?.label || x.outcome, channel: x.channel, text: x.text || "", ...(x.mailId ? { mailId: x.mailId, to: x.to || "" } : {}) })),
    lostReasons: LOST_REASONS, today: todayIn(tz), archive: getArchived(id),
    // mails enviados desde la ficha (Historial los muestra como una sola entrada, con el cuerpo)
    mails: (await mailsFor(id).catch(() => [])).slice(-15).reverse().map(mailOut),
  };
  if (s.leadOnly) {
    const [notes, lead, acts, m] = await Promise.all([pd.notesForLead(s.leadId).catch(() => []), pd.leadsByIds([s.leadId], user?.pdUserId).then(l => l[0] || null).catch(() => null),
      pd.activities({ leadId: s.leadId, done: false, limit: 20 }).catch(() => []), pd.meta().catch(() => ({ users: [] }))]);
    const persons = s.personId ? [{ id: s.personId, name: s.personName, phone: s.phone || "", email: s.email || "" }] : [];
    const uname = uid => m.users.find(u => u.id === uid)?.name || "";
    // leadOwnerId: dueño del prospecto (null: libre); sin dato, no va (la ficha no ofrece archivarlo salvo a un líder)
    // lo pendiente del prospecto (Historial lo muestra en «Pendientes», como en una organización)
    const activities = acts.filter(a => !a.done).map(a => ({ id: a.id, subject: a.subject, type: a.type, typeLabel: TYPE_LABEL[a.type] || a.type, date: a.due_date, time: a.due_time || "", owner: uname(a.owner_id), ownerId: a.owner_id }));
    return { ...base, lead: true, orgUrl: `${pd.PD_WEB}/leads/inbox/${s.leadId}`, deals: [], activities, persons, askFor: askFor(t, notes), ...(lead ? { leadOwnerId: lead.ownerId || null } : {}),
      notes: notes.map(n => ({ at: n.add_time, author: n.user?.name || "", deal: "", text: stripHtml(n.content).slice(0, 900) })),
      templates: templates(s, { me: user?.name, contact: s.personName || "" }) };
  }
  if (!rec.orgId) return { ...base, deals: [], notes: [], activities: [], persons: [], askFor: askFor(t), templates: templates(s, { me: user?.name }) };
  const [deals, notes, acts, persons, m] = await Promise.all([pd.dealsForOrg(rec.orgId), pd.notesForOrg(rec.orgId), pd.activities({ orgId: rec.orgId, done: false, limit: 20 }), pd.personsForOrg(rec.orgId).catch(() => []), pd.meta()]);
  const uname = uid => m.users.find(u => u.id === uid)?.name || "";
  // prospectos abiertos de la organización: si ya hay uno, no se ofrece crear otro (evita duplicados)
  const leads = (await leadsHere(s, rec.orgId).catch(() => [])).map(l => ({ id: l.id, title: l.title, ownerId: l.ownerId || null, owner: uname(l.ownerId), url: `${pd.PD_WEB}/leads/inbox/${l.id}` }));
  if (leads.length === 1 && !getMatch(id)?.leadId) { const mm = getMatch(id); if (mm?.orgId === rec.orgId) setMatch(id, { ...mm, leadId: leads[0].id }); }
  return {
    ...base, orgUrl: `${pd.PD_WEB}/organization/${rec.orgId}`, persons, leads, askFor: askFor(t, notes),
    templates: templates(s, { me: user?.name, contact: persons[0]?.name || "" }),
    deals: deals.map(d => ({ id: d.id, title: d.title, status: d.status, pipeline: m.pipes[d.pipeline_id] || "", stage: m.stages[d.stage_id] || "", lostReason: d.lost_reason, owner: uname(d.owner_id || d.user_id), updated: (d.update_time || "").slice(0, 10), url: `${pd.PD_WEB}/deal/${d.id}`, ...dealOps(d, m) })),
    notes: notes.map(n => ({ at: n.add_time, author: n.user?.name || "", deal: n.deal?.title || "", text: stripHtml(n.content).slice(0, 900) })),
    activities: acts.map(a => ({ id: a.id, subject: a.subject, type: a.type, typeLabel: TYPE_LABEL[a.type] || a.type, date: a.due_date, time: a.due_time || "", owner: uname(a.owner_id), ownerId: a.owner_id })),
  };
}

// Lo que sabe Pipedrive de un colegio, en texto corto, para redactar mensajes con contexto (IA).
export async function draftContext(id, user = {}) {
  const s = byId.get(id); if (!s) return "";
  const m = effMatch(s) || getMatch(id) || {}, out = [];
  out.push(`Estado: ${m.detail || m.status || "sin datos"}${s.ob?.label ? ` · World Dominion: ${s.ob.label}` : ""}`);
  const [notes, deals, persons] = await Promise.all([
    s.leadOnly ? pd.notesForLead(s.leadId, 6).catch(() => []) : m.orgId ? pd.notesForOrg(m.orgId, 6).catch(() => []) : [],
    m.orgId ? pd.dealsForOrg(m.orgId).catch(() => []) : [],
    m.orgId ? pd.personsForOrg(m.orgId).catch(() => []) : [],
  ]);
  if (deals.length) out.push("Tratos: " + deals.slice(0, 4).map(d => `${d.title} (${d.status === "won" ? "ganado" : d.status === "lost" ? `perdido${d.lost_reason ? `: ${d.lost_reason}` : ""}` : "abierto"})`).join("; "));
  if (persons.length) out.push("Personas: " + persons.slice(0, 5).map(p => p.name).join(", "));
  if (notes.length) out.push("Notas (de la más nueva):\n" + notes.map(n => `- ${(n.add_time || "").slice(0, 10)}: ${stripHtml(n.content).replace(/\s+/g, " ").slice(0, 350)}`).join("\n"));
  const t = touchesFor(id).slice(-4).reverse();
  if (t.length) out.push("Contactos registrados en la app:\n" + t.map(x => `- ${x.at.slice(0, 10)} ${x.channel}: ${outcomeById(x.outcome)?.label || x.outcome}${x.text ? ` · ${x.text.slice(0, 200)}` : ""}`).join("\n"));
  const sd = sedeCache.get(id)?.v?.sedes || [];
  if (sd.length) {
    out.push(`Sedes: ${sd.map(x => x.name).join("; ")}`);
    // lo hablado en las otras sedes de la misma red (suele ser la misma gente o la misma concesión)
    const src = sd.filter(x => !x.here && (!x.ownerId || x.ownerId === user.pdUserId)).flatMap(x => [x.orgId && x.orgId !== m.orgId && { org: x.orgId, name: x.name }, ...x.leads.map(l => ({ lead: l.id, name: x.name }))]).filter(Boolean).slice(0, 4);
    const more = await Promise.all(src.map(async x => (await (x.org ? pd.notesForOrg(x.org, 2) : pd.notesForLead(x.lead, 2)).catch(() => [])).map(n => `- ${x.name}, ${(n.add_time || "").slice(0, 10)}: ${stripHtml(n.content).replace(/\s+/g, " ").slice(0, 300)}`)));
    if (more.flat().length) out.push("Notas de otras sedes:\n" + more.flat().join("\n"));
  }
  return out.join("\n");
}

// ---------- Qué pasó con OrderEAT: para un cliente, un onboarding o un churn (o algo perdido), lo que dicen World Dominion,
// Pipedrive (tratos y notas de la organización vinculada y de sus duplicadas con el mismo nombre) y Slack (si está conectado).
// la organización vinculada (primera) y las duplicadas con el mismo nombre (de la búsqueda, hasta 10)
async function relatedOrgIds(rec) {
  let orgIds = rec.orgId ? [rec.orgId] : [];
  if (rec.orgName) {
    const same = (await pd.searchOrganizations(rec.orgName, 10).catch(() => [])).filter(o => pd.norm(o.name) === pd.norm(rec.orgName)).map(o => o.id);
    orgIds = [...new Set([...orgIds, ...same])];
  }
  return orgIds;
}
// De esas, las que pueden ser este colegio (hasta 4): nunca las de otra ciudad u otro país (su dirección en Pipedrive, como
// en lib/merge.js). sure: la vinculada o una de la misma ciudad; sin ciudad en la dirección, sure false (en el Historial va
// a la lista pero no al resumen). Si no se pueden leer las direcciones, solo la vinculada.
async function relatedOrgs(s, rec) {
  const ids = await relatedOrgIds(rec); if (!ids.length) return [];
  const main = ids[0], list = ids.length > 1 ? await pd.orgsByIds(ids).catch(() => null) : [];
  if (!list) return [{ id: main, name: rec.orgName || "", main: true, sure: true }];
  return ids.map(id => list.find(o => Number(o.id) === Number(id)) || (id === main ? { id, name: rec.orgName || "" } : null)).filter(Boolean)
    .map(o => ({ id: o.id, name: o.name, main: o.id === main, place: o.id === main ? "same" : addrPlace(s, o) }))
    .filter(o => o.main || o.place !== "other").slice(0, 4).map(o => ({ id: o.id, name: o.name, main: o.main, sure: o.main || o.place === "same" }));
}
export async function historyFor(id) {
  const s = byId.get(id); if (!s) throw bad("Colegio inexistente", 404);
  const ob = brainOf(s), rec = getMatch(id) || {};
  const orgIds = (await relatedOrgs(s, rec)).map(o => o.id);
  const m = await pd.meta().catch(() => ({ users: [], pipes: {}, stages: {} })), uname = uid => m.users.find(u => u.id === uid)?.name || "";
  const [deals, notes, slack] = await Promise.all([
    Promise.all(orgIds.map(o => pd.dealsForOrg(o).catch(() => []))).then(x => x.flat()),
    Promise.all(orgIds.map(o => pd.notesForOrg(o, 6).catch(() => []))).then(x => x.flat()),
    slackFor([s.name, ob?.site], s.city).catch(e => ({ msgs: [], error: e.message })),
  ]);
  const d10 = v => v ? String(v).slice(0, 10) : "";
  return {
    brain: ob ? { label: ob.label, status: ob.status, client: ob.clientName, site: ob.site, start: ob.start, info: ob.info || {} } : null,
    orgs: orgIds.length,
    deals: deals.sort((a, b) => String(b.add_time).localeCompare(String(a.add_time))).map(d => ({
      title: d.title, pipeline: m.pipes[d.pipeline_id] || "", stage: m.stages[d.stage_id] || "", status: d.status, lostReason: d.lost_reason || "",
      added: d10(d.add_time), won: d10(d.won_time), lost: d10(d.lost_time), owner: uname(d.owner_id || d.user_id), clientPipe: CLIENT_PIPES.includes(d.pipeline_id), url: `${pd.PD_WEB}/deal/${d.id}`, ...dealOps(d, m) })),
    notes: notes.sort((a, b) => String(b.add_time).localeCompare(String(a.add_time))).slice(0, 6).map(n => ({ at: d10(n.add_time), author: n.user?.name || "", deal: n.deal?.title || "", text: stripHtml(n.content).replace(/\n{3,}/g, "\n\n").slice(0, 700) })),
    slack, slackEnabled: slackEnabled(),
  };
}

// ---------- Historial: la línea de tiempo completa de la ficha (lib/timeline.js la arma sin repetir) y el resumen para la
// próxima llamada. De Pipedrive: actividades hechas y notas del prospecto (y de los abiertos de la organización), de la
// organización y sus duplicadas con el mismo nombre (nunca las de otra ciudad u otro país, como en lib/merge.js; las que no
// dicen ciudad van a la lista pero no al resumen), de hasta 3 personas; la creación de los prospectos y los tratos (creado,
// ganado, perdido con motivo). De la app: contactos y mails. Pedidos agrupados y una copia de 2 minutos de lo leído de
// Pipedrive (hasta 200 fichas): cuando la app escribe algo de la ficha cambia su versión en el store (dropTimeline), así
// también las otras instancias la vuelven a leer. Si Pipedrive falla, va lo que se pudo leer y el aviso.
const TL = new Map(), TL_TTL = 120e3, TL_MAX = 200, TL_MAX_PERSONS = 3, TL_MAX_LEADS = 3;
const tlKey = id => canonicalId(id) || id;
export function dropTimeline(id) {
  if (!id) { TL.clear(); return cacheSet("tl:ver:*", Date.now(), 600).catch(() => {}); }
  const k = tlKey(id); TL.delete(id); TL.delete(k);
  return cacheSet(`tl:ver:${k}`, Date.now(), 600).catch(() => {});
}
function keepTl(k, v) {
  const now = Date.now();
  TL.delete(k);
  for (const [x, h] of TL) if (now - h.at >= TL_TTL) TL.delete(x);
  while (TL.size >= TL_MAX) TL.delete(TL.keys().next().value);
  TL.set(k, v);
}
async function timelineData(id) {
  const s = byId.get(id); if (!s) throw bad("Colegio inexistente", 404);
  // sin cruce al día (la ficha se abre a la vez), primero el cruce: si no, saldría vacío aunque esté en Pipedrive
  if (!s.leadOnly && !isFresh(getMatch(id))) await checkSchool(id).catch(() => null);
  const rec = getMatch(id) || {}, warnings = [], cut = [];
  const soft = (what, p) => Promise.resolve(p).catch(() => { warnings.push(what); return null; });
  const [m, types] = await Promise.all([soft("los usuarios de Pipedrive", pd.meta()), pd.activityTypes().catch(() => [])]);
  const orgs = s.leadOnly ? [] : await relatedOrgs(s, rec), orgIds = orgs.map(o => o.id), main = orgIds[0] || null;
  // prospectos: el de la ficha (aunque esté archivado) y los abiertos de la organización
  const [orgLeads, orgPersons] = main ? await Promise.all([soft("los prospectos de la organización", leadsHere(s, main)), soft("las personas de la organización", pd.personsForOrg(main))]) : [[], []];
  const leadIds = [...new Set([s.leadId, rec.leadId, ...(orgLeads || []).map(l => l.id)].filter(Boolean))].slice(0, TL_MAX_LEADS);
  const known = new Map((orgLeads || []).map(l => [l.id, l]));
  const missing = leadIds.filter(l => !known.has(l));
  for (const l of missing.length ? await soft("el prospecto", pd.leadsByIds(missing)) || [] : []) known.set(l.id, l);
  const leads = leadIds.map(l => known.get(l)).filter(Boolean);
  const persons = s.leadOnly ? (s.personId ? [{ id: s.personId, name: s.personName || "" }] : []) : (orgPersons || []).slice(0, TL_MAX_PERSONS);
  const srcs = [...orgIds.map(o => ({ orgId: o, what: o === main ? "la organización" : "una organización duplicada", of: o === main ? "de la organización" : "de una organización duplicada" })),
    ...leadIds.map(l => ({ leadId: l, what: "el prospecto", of: "del prospecto" })), ...persons.map(p => ({ personId: p.id, what: `${p.name || "una persona"}`, of: `de ${p.name || "una persona"}` }))];
  const ask = ({ orgId, leadId, personId }) => ({ orgId, leadId, personId });
  const [actPages, notePages, dealLists, pend] = await Promise.all([
    Promise.all(srcs.map(x => soft(`las actividades ${x.of}`, pd.doneActivities(ask(x))))),
    Promise.all(srcs.map(x => soft(`las notas ${x.of}`, pd.notesAll(ask(x))))),
    Promise.all(orgIds.map(o => soft("los tratos", pd.dealsForOrg(o)))),
    Promise.all([...(main ? [{ orgId: main }] : []), ...leadIds.map(l => ({ leadId: l }))].map(x => pd.activities({ ...x, done: false, limit: 50 }).catch(() => []))),
  ]);
  srcs.forEach((x, i) => { if (actPages[i]?.more || notePages[i]?.more) cut.push(x.what); });
  return {
    acts: actPages.flatMap(p => p?.items || []), notes: notePages.flatMap(p => p?.items || []), deals: dealLists.flatMap(d => d || []), leads,
    pending: uniqBy(pend.flat().filter(a => !a.done), a => a.id), persons: [...persons, ...(orgPersons || [])], orgs,
    users: m?.allUsers || m?.users || [], pipes: m?.pipes || {}, stages: m?.stages || {}, types: Object.fromEntries(types.map(t => [t.key, t.name])),
    mainLeadId: s.leadOnly ? s.leadId : null, warnings: [...new Set(warnings)], cut: [...new Set(cut)],
  };
}
const uniqBy = (l, k) => { const seen = new Set(); return l.filter(x => !seen.has(k(x)) && seen.add(k(x))); };
// Lo leído de Pipedrive se guarda (sin zona horaria); la línea de tiempo se arma en cada pedido, en la zona de quien mira,
// con los contactos y mails de la app al día. La copia vale si es de hace menos de 2 minutos y nadie escribió en la ficha
// (ni en una actividad) después de empezar a leerla: la versión está en el store, la ven todas las instancias.
async function timelineOf(id, { force = false, tz } = {}) {
  const k = tlKey(id), hit = TL.get(k);
  let d = null;
  if (!force && hit && Date.now() - hit.at < TL_TTL) {
    const [v1, v2] = await cacheGetMany([`tl:ver:${k}`, "tl:ver:*"]).catch(() => [null, null]);
    if (Math.max(Number(v1) || 0, Number(v2) || 0) < hit.at) d = hit.d;
  }
  if (!d) {
    const t0 = Date.now();
    d = await timelineData(id);
    // con avisos (Pipedrive falló en algo) no se guarda: el próximo pedido vuelve a probar
    if (!d.warnings.length) keepTl(k, { at: t0, d }); else TL.delete(k);
  }
  const items = buildTimeline({ ...d, tz, touches: touchesFor(id), mails: await mailsFor(id).catch(() => []), web: pd.PD_WEB });
  return { items, pending: d.pending, users: d.users, types: d.types, warnings: d.warnings, cut: d.cut };
}
// Lo pendiente (sin hacer) en la hora de quien mira, para el resumen
function pendingFor(v, tz) {
  const today = todayIn(tz), uname = uid => v.users.find(u => u.id === Number(uid))?.name || "";
  return v.pending.map(a => { const l = fromUtc(a.due_date, a.due_time ? String(a.due_time).slice(0, 5) : "", tz);
    return { label: v.types[a.type] || TYPE_LABEL[a.type] || a.type, subject: a.subject || "", date: l.date, time: l.time, who: uname(a.owner_id ?? a.user_id),
      late: l.date < today || (l.date === today && !!l.time && l.time < new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date())) }; })
    .sort((a, b) => (a.date + (a.time || "99")).localeCompare(b.date + (b.time || "99")));
}
function summaryCtx(id, v, { user, tz, me }) {
  const s = byId.get(id), rec = effMatch(s) || getMatch(id) || {}, cur = getMatch(id) || {};
  const first = String(me || user?.name || "").trim().split(/\s+/)[0] || "";
  return { school: { name: s.name, city: s.city, country: s.country }, status: rec.status, today: todayIn(tz), tz, me: first, meNames: [me, user?.pdName, user?.name].filter(Boolean),
    pending: pendingFor(v, tz), askFor: askFor(touchesFor(id)),
    // sin organización vinculada y con candidatas: no se sabe su historia en Pipedrive; elegida sola y sin confirmar: se avisa
    unlinked: !s.leadOnly && !cur.orgId && (cur.candidates || []).length > 0, unconfirmed: !s.leadOnly && cur.orgId && !cur.confirmed ? cur.orgName || "la organización elegida" : "" };
}
export async function timelineFor(id, { user, tz, me = "", offset = 0, limit = 50, force = false } = {}) {
  const v = await timelineOf(id, { force, tz });
  return { ...page(v.items, offset, limit), warnings: v.warnings, cut: v.cut, summary: callSummary(v.items, summaryCtx(id, v, { user, tz, me })), ai: aiEnabled() };
}
// Resumen con IA (si hay clave): el mismo armado, con el modelo; si falla o no cita, el de reglas. La línea de tiempo sale de la
// copia (la que acaba de leer /timeline); force salta solo la copia de la IA.
export async function callBriefFor(id, { user, tz, me = "", force = false } = {}) {
  const v = await timelineOf(id, { tz });
  const ctx = summaryCtx(id, v, { user, tz, me }), rules = callSummary(v.items, ctx);
  if (!aiEnabled() || rules.cold) return { summary: rules };
  try { const r = await aiCallSummary({ items: v.items, rules, ctx, force }); return { summary: r || { ...rules, aiNote: "La IA no citó de dónde salía cada dato: va el resumen por reglas." } }; }
  catch (e) { return { summary: { ...rules, aiNote: `La IA no respondió (${e.message}): va el resumen por reglas.` } }; }
}

// ---------- sedes de un colegio (planteles, campus): de Pipedrive (organizaciones y prospectos de la misma marca),
// de la base y de lo que publica su web. Solo datos escritos en esas fuentes, con la fuente de cada uno.
const SEDE_WORD = /\b(plantel|planteles|campus|sede|sedes|sucursal|seccion)\b/;
const sedeCache = new Map();
export const splitPhones = v => String(v || "").split(/\s+[-–]\s+|\s*(?:\/|,|;|\by\b|\bo\b)\s*/).map(x => x.trim()).filter(x => x.replace(/\D/g, "").length >= 7);
export const splitMails = v => String(v || "").split(/[\s,;/]+/).map(x => x.trim().toLowerCase()).filter(x => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(x));
const capWords = t => String(t).toLowerCase().replace(/(^|\s)\p{L}/gu, m => m.toUpperCase());
// palabras de nombres muy repetidos (santos, próceres, advocaciones): con solo esas, «Sagrado Corazón» o «Simón Bolívar»
// no alcanzan para decir que dos colegios son de la misma red
const COMMON = new Set("sagrado corazon jesus maria jose juan bosco simon bolivar santa rosa lima cristo rey divino nino nina nuestra senora inmaculada concepcion guadalupe francisco asis antonio padua pedro pablo vicente paul ignacio loyola teresa benito juarez miguel hidalgo jose marti sarmiento belgrano artigas moreno valle americano americana ingles britanico frances aleman italiano mexicano argentino chileno peruano uruguayo".split(" "));
// tipo de institución: una universidad o un profesorado no son sede de un colegio
const TIPO = n => /\buniversidad|\buniversit|\buniv\b/.test(n) ? "uni" : /\bprofesorado|\bterciario|\bnormal superior|\binstituto superior/.test(n) ? "ter" : "k12";
let PLACES = null;
// lugares conocidos (países y ciudades de la base): el «nombre del plantel» de otra red suele ser otra ciudad
const places = () => PLACES ||= new Set([...Object.keys(MARKETS).flatMap(k => keyTokens(k)), "mexico", "peru", ...schools.flatMap(o => keyTokens(o.city))]);
export async function sedesFor(id) {
  const s = byId.get(id); if (!s) return { sedes: [] };
  const c = sedeCache.get(id); if (c && Date.now() - c.at < 3600e3) return c.v;
  const rec = getMatch(id) || {};
  const city = pd.norm(s.city), cityT = new Set([...keyTokens(s.city), ...keyTokens(s.country)]), tipo = TIPO(pd.norm(s.name));
  // la marca: las palabras propias del nombre antes de «plantel/campus/sede», sin la ciudad ni el país
  const brandOf = n => { const x = pd.norm(n), i = x.search(SEDE_WORD); return keyTokens(i > 0 ? x.slice(0, i) : x).filter(w => !SEDE_WORD.test(w) && !cityT.has(w)); };
  const brands = [s.name, rec.confirmed ? rec.orgName : ""].filter(Boolean).map(n => ({ n, b: brandOf(n), campus: SEDE_WORD.test(pd.norm(n)) }));
  // «preparatoria esfer salesianos kennedy»: sin la palabra plantel, la última palabra suele ser el plantel
  for (const x of [...brands]) if (!x.campus && x.b.length >= 3) brands.push({ n: x.n, b: x.b.slice(0, -1), campus: false });
  const brand = brands.map(x => x.b).filter(b => b.length).sort((a, b) => a.length - b.length)[0] || [];
  const none = () => { const v = { sedes: [] }; sedeCache.set(id, { at: Date.now(), v }); return v; };
  // una sola palabra («Americano», «Santiago») no alcanza para decir que son la misma red
  if (brand.length < 2) return none();
  const distinct = brand.some(w => !COMMON.has(w));
  const same = (a, b) => a.length === b.length && a.every(w => b.includes(w));
  // mismo colegio: mismo tipo de institución, su marca es igual a la nuestra (o le suma solo el nombre del plantel, que no
  // puede ser otra ciudad o país), y es de la misma ciudad o dice plantel/campus/sede. Con una marca de nombres muy repetidos,
  // tiene que decir plantel/campus/sede y la marca ser exactamente la misma.
  const fits = (name, place = "") => {
    const n = pd.norm(name), b = brandOf(name), campus = SEDE_WORD.test(n);
    if (TIPO(n) !== tipo) return false;
    const extra = b.filter(w => !brand.includes(w));
    if (!(same(b, brand) || (b.length === brand.length + 1 && extra.length === 1))) return false;
    if (extra.length && places().has(extra[0])) return false;
    if (!distinct && !(campus && same(b, brand))) return false;
    const p = ` ${pd.norm(`${name} ${place}`)} `;
    return !!city && p.includes(` ${city} `) || campus && !place;
  };
  const keyOf = name => keyTokens(name).filter(w => !brand.includes(w) && !cityT.has(w) && !SEDE_WORD.test(w)).map(w => w.length > 4 ? w.replace(/s$/, "") : w).join(" ") || "principal";
  const sedes = new Map();
  const get = name => { const k = keyOf(name); if (!sedes.has(k)) sedes.set(k, { key: k, name: "", phones: [], emails: [], web: "", addr: "", orgId: null, url: "", owner: "", ownerId: null, leads: [], schoolId: null, src: [] }); return sedes.get(k); };
  const add = (x, src, { phones = [], emails = [], web = "", addr = "" } = {}) => {
    for (const p of phones) { const d = p.replace(/\D/g, ""); if (!x.phones.some(q => q.replace(/\D/g, "").endsWith(d) || d.endsWith(q.replace(/\D/g, "")))) x.phones.push(p); else if (d.length > 7) x.phones = x.phones.map(q => d.endsWith(q.replace(/\D/g, "")) ? p : q); }
    for (const e of emails) if (!x.emails.includes(e)) x.emails.push(e);
    x.web ||= web; x.addr ||= addr; if (!x.src.includes(src)) x.src.push(src);
  };
  let failed = false;
  const term = brand.join(" "), byName = t => { const b = brandOf(t); return brand.every(w => b.includes(w)); };
  const [found, leads, m] = await Promise.all([
    pd.searchOrganizations(term, 15).catch(() => { failed = true; return []; }),
    pd.searchLeads(term, 6, byName).catch(() => { failed = true; return []; }),
    pd.meta().catch(() => ({ users: [] }))]);
  const uname = uid => uid ? m.users.find(u => u.id === uid)?.name || "" : "";
  // dirección de las organizaciones candidatas, para pedir mismo país y ciudad
  const cand = found.filter(o => byName(o.name));
  const place = new Map((await pd.orgsByIds(cand.map(o => o.id)).catch(() => { failed = true; return []; })).map(o => [o.id, o]));
  for (const o of cand) {
    const pl = place.get(o.id);
    if (pl?.country && appCountry(pl.country) && appCountry(pl.country) !== s.country) continue;
    if (!fits(o.name, [pl?.city, pl?.region].filter(Boolean).join(" "))) continue;
    const x = get(o.name); x.name = o.name; x.orgId = o.id; x.url = `${pd.PD_WEB}/organization/${o.id}`;
    x.ownerId = o.ownerId || null; x.owner = uname(o.ownerId); add(x, "Pipedrive");
  }
  for (const l of leads) {
    const nm = (l.orgId && cand.find(o => o.id === l.orgId)?.name) || l.title;
    if (!fits(nm, l.addr) && !(l.orgId && [...sedes.values()].some(x => x.orgId === l.orgId))) continue;
    const x = get(nm); x.name ||= nm; x.leads.push({ id: l.id, title: l.title, archived: !!l.archived, url: `${pd.PD_WEB}/leads/inbox/${l.id}`, ownerId: l.ownerId || null, owner: uname(l.ownerId) });
    if (!x.ownerId && l.ownerId && !l.archived) { x.ownerId = l.ownerId; x.owner = uname(l.ownerId); }
    add(x, "Pipedrive", { phones: splitPhones(l.phone), emails: splitMails(l.email), web: l.web, addr: l.addr });
  }
  for (const o of schools) if (o.id !== s.id && !o.virtual && o.country === s.country && pd.norm(o.city) === city && fits(o.name, o.city)) {
    const x = get(o.name); x.name ||= o.name; x.schoolId ||= o.id; add(x, "Mapa", { phones: splitPhones(o.phone), emails: splitMails(o.email), web: o.web || "", addr: o.addr || "" });
  }
  // un nombre igual sin plantel no es otra sede (es otro colegio con el mismo nombre, o el mismo cargado dos veces)
  sedes.delete("principal");
  // la web: la del colegio o la de una sede encontrada arriba (se dice de cuál)
  const webSede = s.web ? null : [...sedes.values()].find(x => x.web);
  let web = s.web || webSede?.web || "";
  if (web && !/^https?:\/\//i.test(web)) web = "https://" + web;
  if (web) {
    const w = await webInfo(web, AbortSignal.timeout(9000)).catch(() => null);
    for (const ws of w?.sedes || []) { const x = get(`${ws.kind} ${ws.name}`); x.name ||= capWords(`${ws.kind} ${ws.name}`); add(x, "Web", { phones: ws.phones, web }); }
  }
  // lada: un número local de la web (sin código de área) se completa solo si los otros números fijos de la red en esa
  // ciudad traen todos la misma lada (no 800/900); se guarda el número publicado y de dónde salió la lada
  const nat = p => p.replace(/\D/g, "").replace(/^(00)?52(1)?(?=\d{10}$)/, "");
  const full = [...sedes.values()].flatMap(x => x.phones).map(nat).filter(d => d.length === 10 && !/^(800|900|01)/.test(d));
  for (const x of sedes.values()) x.phones = x.phones.map(p => {
    const d = nat(p); if (d.length >= 10 || /^\+/.test(p) || s.country !== "México") return { n: p };
    const pre = [...new Set(full.map(f => f.slice(0, 10 - d.length)))];
    const f = pre[0] + d; return pre.length === 1 && d.length >= 7 ? { n: `${f.slice(0, 3)} ${f.slice(3, 6)} ${f.slice(6)}`, raw: p, lada: pre[0] } : { n: p, short: true };
  });
  const list = [...sedes.values()].map(x => ({ ...x, here: !!(rec.orgId && x.orgId === rec.orgId) })).sort((a, b) => b.here - a.here || a.name.localeCompare(b.name));
  const v = { sedes: list.length >= 2 ? list : [], web: list.length >= 2 ? web || "" : s.web || "", webFrom: webSede && list.length >= 2 ? webSede.name : "" };
  if (!failed) sedeCache.set(id, { at: Date.now(), v });
  return v;
}

// ---------- Enriquecer: el SDR ve que falta información y pide juntar todo lo que hay del colegio.
// Junta Pipedrive (prospectos y sedes), su web, Google Maps (si hay clave) y el estudio (si existe), lo guarda para la ficha
// y lo deja como nota en Pipedrive (solo si es tuyo o libre, y sin repetir la misma nota). Nada se deduce: cada dato lleva su fuente.
export const getEnrich = id => cacheGet("enrich:" + id);
// lo que ya estaba (en la base o en Pipedrive: la persona o el propio prospecto) no cuenta como dato nuevo para la nota
const BASE_SRC = new Set(["Base de colegios", "Persona en Pipedrive", "Prospecto en Pipedrive"]);
// photos: false (el automático de un prospecto nuevo) no busca fotos: son para la ficha, no para Pipedrive
export async function enrichSchool(id, user, by = "", { photos: withPhotos = true } = {}) {
  const s = byId.get(id); if (!s) throw bad("Colegio inexistente", 404);
  return withLock("enrich:" + id, async () => {
    const prev = await getEnrich(id).catch(() => null);
    // dueño al día antes de escribir nada
    const rec = s.leadOnly ? getMatch(id) || {} : await checkSchool(id, { force: true }).catch(() => getMatch(id) || {});
    // el prospecto del colegio: el de la ficha, el único abierto o el tuyo (como al registrar un contacto)
    const open = s.leadOnly || !rec.orgId ? [] : await leadsHere(s, rec.orgId).catch(() => []);
    const own = s.leadOnly ? (await pd.leadsByIds([s.leadId]).catch(() => []))[0] : pickContactLead(open, s.leadId || rec.leadId || null, user.pdUserId) || open[0] || null;
    // no se vuelve a consultar todo (Google cobra por consulta) si se enriqueció hace menos de 6 horas
    const fresh = prev && Date.now() - new Date(prev.at).getTime() < 6 * 3600e3;
    let data = prev, photos = null;
    if (!fresh) {
      if (!sedeCache.get(id) || Date.now() - sedeCache.get(id).at > 600e3) sedeCache.delete(id);
      const sd = await sedesFor(id).catch(() => ({ sedes: [] }));
      // la web y de dónde salió (sus teléfonos, mails y fotos llevan esa misma fuente)
      let web = s.web || own?.web || sd.web || "", webSrc = s.web ? "Web del colegio" : own?.web ? "Web cargada en Pipedrive" : sd.webFrom ? `Web de la red (${sd.webFrom})` : "Web del colegio";
      if (web && !/^https?:\/\//i.test(web)) web = "https://" + web;
      const [w, g, st] = await Promise.all([
        web ? webInfo(web, AbortSignal.timeout(9000)).catch(e => ({ error: e.message })) : null,
        s.lat != null ? placesLookup(s, AbortSignal.timeout(12000)).catch(() => null) : null,
        getStudy(id).catch(() => null)]);
      const items = [], seen = new Set();
      const put = (kind, value, src) => { const v = String(value || "").trim(); const k = kind + ":" + v.toLowerCase().replace(/[^\da-z@.]/g, ""); if (!v || seen.has(k)) return; seen.add(k); items.push({ kind, value: v, src }); };
      const baseSrc = s.virtual ? "Persona en Pipedrive" : "Base de colegios";
      if (s.phone) put("tel", s.phone, baseSrc);
      splitPhones(own?.phone).forEach(p => put("tel", p, "Prospecto en Pipedrive"));
      (w?.phones || []).forEach(p => put("tel", p, webSrc));
      if (g?.internationalPhoneNumber) put("tel", g.internationalPhoneNumber, "Google Maps");
      (st?.contacto?.telefonos || []).forEach(p => put("tel", p, "Estudio"));
      if (w?.whatsapp) put("wa", w.whatsapp, webSrc);
      if (st?.contacto?.whatsapp) put("wa", st.contacto.whatsapp, "Estudio");
      if (s.email) put("mail", s.email, baseSrc);
      splitMails(own?.email).forEach(e => put("mail", e, "Prospecto en Pipedrive"));
      (w?.emails || []).forEach(e => put("mail", e, webSrc));
      (st?.contacto?.emails || []).forEach(e => put("mail", e, "Estudio"));
      if (web) put("web", web, s.web ? "Base de colegios" : own?.web ? "Prospecto en Pipedrive" : webSrc);
      if (g?.websiteUri) put("web", g.websiteUri, "Google Maps");
      if (s.addr) put("addr", [s.addr, s.city].filter(Boolean).join(", "), baseSrc);
      if (own?.addr) put("addr", own.addr, "Prospecto en Pipedrive");
      if (g?.formattedAddress) put("addr", g.formattedAddress, "Google Maps");
      // los teléfonos que repiten otro con otro formato («4131045» y «614 413 1045») quedan una vez
      const tels = items.filter(x => x.kind === "tel");
      for (const x of tels) { const d = x.value.replace(/\D/g, ""); if (tels.some(y => y !== x && y.value.replace(/\D/g, "").length > d.length && y.value.replace(/\D/g, "").endsWith(d))) x.dup = true; }
      data = {
        at: new Date().toISOString(), by: by || signer(user), web, webSrc,
        items: items.filter(x => !x.dup).map(x => ({ ...x, known: BASE_SRC.has(x.src) })),
        rating: g?.rating ? { value: g.rating, count: g.userRatingCount || 0 } : null,
        decisores: (st?.decisores || []).filter(d => d?.nombre && !/sin datos|desconocid/i.test(d.nombre)).slice(0, 5),
        // el número tal cual lo publica la fuente; si la app completó la lada, se dice
        sedes: sd.sedes.map(x => ({ name: x.name, src: x.src, phones: x.phones.map(p => p.lada ? `${p.raw} (sin lada en la web; ${p.lada} es la de la red)` : p.n), emails: x.emails, addr: x.addr, here: x.here })),
        sources: { web: web ? (w?.error ? `no se pudo leer: ${w.error}` : "leída") : "no tiene", google: g ? "encontrado" : process.env.GOOGLE_MAPS_API_KEY ? "no lo encontró" : "no disponible", estudio: st ? "hecho" : "no hay" },
      };
      if (withPhotos) { photos = await photosFor(id, { refresh: true, web, webSrc }).catch(() => []); data.photos = photos.length; }
      else data.photos = prev?.photos || 0;
    }
    // nota en Pipedrive: en el prospecto (con su organización) si tiene uno abierto y no hay trato abierto; si no, en la
    // organización (confirmada) y su trato abierto tuyo. Solo si es tuyo o libre. Los datos van además a los campos vacíos
    // del prospecto (leadGaps: nunca se pisa lo que ya tiene).
    let note = { saved: false }, fields = null;
    const theirs = (uid, name) => uid && uid !== user.pdUserId ? `No guardé la nota: es de ${name || "otra persona"} en Pipedrive. Hablalo con esa persona.` : "";
    const nuevos = data.items.filter(x => !x.known).length + data.sedes.length + data.decisores.length;
    const m = await pd.meta().catch(() => ({ users: [] })), uname = uid => m.users.find(u => u.id === uid)?.name || "";
    const leadT = !s.leadOnly && own && !own.archived && !rec.openDealId ? own.id : null;
    const target = s.leadOnly ? { leadId: s.leadId } : rec.orgId && (rec.confirmed || rec.created)
      ? leadT ? { orgId: rec.orgId, leadId: leadT } : { orgId: rec.orgId, dealId: rec.openDealId && (!rec.openDealOwnerId || rec.openDealOwnerId === user.pdUserId) ? rec.openDealId : undefined } : null;
    if (!target) note.reason = rec.orgId ? "No guardé la nota: confirmá primero cuál es su organización en Pipedrive (en Historial)." : "Todavía no está en Pipedrive: creá el prospecto y volvé a tocar Enriquecer.";
    else if (s.leadOnly && own?.ownerId && own.ownerId !== user.pdUserId) note.reason = theirs(own.ownerId, uname(own.ownerId));
    else if (!s.leadOnly && rec.ownerId && rec.ownerId !== user.pdUserId) note.reason = theirs(rec.ownerId, rec.ownerName);
    else if (!s.leadOnly && own?.ownerId && own.ownerId !== user.pdUserId) note.reason = theirs(own.ownerId, uname(own.ownerId));
    const blocked = !!note.reason;
    // los datos van a los campos vacíos del prospecto aunque no haya nada nuevo para la nota (lo de la base también cuenta)
    if (target?.leadId && !blocked) fields = await fillLeadGaps(target.leadId, s, data, user);
    if (blocked) { /* el motivo ya está en note.reason */ }
    else if (!nuevos) note.reason = "No encontré nada que no estuviera ya: no hice nota.";
    else {
      const html = enrichHtml(s, data), key = `enrichnote:${target.leadId ? "lead:" + target.leadId : "org:" + target.orgId}`;
      const hash = crypto.createHash("sha1").update(JSON.stringify([data.items, data.sedes, data.decisores])).digest("hex");
      if ((await cacheGet(key)) === hash) note.reason = "Esto ya estaba en una nota de Pipedrive.";
      else {
        // en el prospecto y su organización; si Pipedrive no acepta las dos juntas, en el prospecto
        const add = () => pd.addNote({ content: html, ...target }).catch(e => { if (!(target.leadId && target.orgId)) throw e; return pd.addNote({ content: html, leadId: target.leadId }); });
        try { await add(); await cacheSet(key, hash, 365 * 86400); note = { saved: true, at: new Date().toISOString(), url: target.leadId ? `${pd.PD_WEB}/leads/inbox/${target.leadId}` : `${pd.PD_WEB}/organization/${target.orgId}`, ...(target.leadId ? { lead: true } : {}) }; }
        catch (e) { note.reason = `No pude guardar la nota en Pipedrive (${e.message}). Probá de nuevo.`; }
      }
    }
    data = { ...data, nuevos, note: note.saved ? note : data.note?.saved ? data.note : note, ...(fields?.saved.length ? { fields: { ...fields, at: new Date().toISOString() } } : {}) };
    await cacheSet("enrich:" + id, data, 180 * 86400);
    return { data, note, fields: fields || { saved: [] }, photos: withPhotos ? photos ?? await photosFor(id).catch(() => []) : [] };
  });
}
const SRC_LABEL = { tel: "Teléfono", wa: "WhatsApp", mail: "Mail", web: "Web", addr: "Dirección" };
function enrichHtml(s, d) {
  const li = x => `<li>${esc(x)}</li>`;
  const rows = ["tel", "wa", "mail", "web", "addr"].flatMap(k => d.items.filter(x => x.kind === k).map(x => li(`${SRC_LABEL[k]}: ${x.value} (${x.src})`)));
  return [`<b>Datos del colegio · OrderBrain SDR</b>`, `Enriquecido el ${d.at.slice(0, 10)} por ${esc(d.by)}. Cada dato dice de dónde salió.`,
    rows.length ? `<ul>${rows.join("")}</ul>` : "",
    d.rating ? `Google Maps: ${d.rating.value}★ (${d.rating.count} reseñas)` : "",
    d.decisores.length ? `<b>Decisores (estudio)</b><ul>${d.decisores.map(x => li(`${x.nombre}${x.cargo ? ` · ${x.cargo}` : ""}${x.fuente ? ` · ${x.fuente}` : ""}`)).join("")}</ul>` : "",
    d.sedes.length ? `<b>Sedes (${d.sedes.length})</b><ul>${d.sedes.map(x => li([x.name, ...x.phones, ...x.emails, x.addr].filter(Boolean).join(" · ") + ` (${x.src.join(", ")})`)).join("")}</ul>` : "",
  ].filter(Boolean).join("<br>");
}

// ---------- campos del prospecto: lo que encontró «Enriquecer» (y la base) va a los campos VACÍOS del prospecto; nunca se
// pisa lo que ya tiene. «No encontrado», «sin datos», «N/A» o «-» cuentan como vacíos (no son un dato).
const F_LEAD = { telefono: "phone", email: "email", web: "web", direccion: "addr", pais: "paisOpt", ciudad: "ciudadOpt", estado: "estadoOpt", niveles: "nivelesOpt" };
export const LEAD_FIELD_LABEL = { telefono: "teléfono", email: "mail", web: "web", direccion: "dirección", pais: "país", ciudad: "ciudad", estado: "estado", niveles: "niveles" };
const PLACEHOLDER = /^(no encontrad[oa]s?|sin datos|no tiene|n\/?a|-+|\.+)$/i;
const blank = v => v == null || (typeof v === "object" ? !Object.keys(v).length : !String(v).trim() || PLACEHOLDER.test(String(v).trim()));
// lead: el prospecto como lo devuelve lib/pipedrive.js (phone, email, web, addr, paisOpt…); want: { clave de DEAL_FIELDS: valor }
export function leadGaps(lead, want) {
  const out = {};
  for (const [name, prop] of Object.entries(F_LEAD)) {
    const k = DEAL_FIELDS[name], v = want?.[k];
    if (!k || blank(v) || !blank(lead?.[prop])) continue;
    out[k] = v;
  }
  return out;
}
const fieldNames = keys => keys.map(k => LEAD_FIELD_LABEL[Object.keys(F_LEAD).find(n => DEAL_FIELDS[n] === k)] || k);
// Lo que se quiere en el prospecto: lo de la base (como al crearlo, sin fuente ni SDR) y, si la base no lo tiene, lo
// primero que encontró Enriquecer con su fuente (web, Google Maps, estudio).
async function leadWants(s, data, user) {
  const pick = k => (data?.items || []).filter(x => x.kind === k && x.src !== "Prospecto en Pipedrive").map(x => x.value);
  const f = await leadFields(s, user, { phones: pick("tel"), emails: pick("mail") });
  delete f[DEAL_FIELDS.fuente]; delete f[DEAL_FIELDS.sdr];
  if (!f[DEAL_FIELDS.web] && (data?.web || pick("web")[0])) f[DEAL_FIELDS.web] = data.web || pick("web")[0];
  if (!f[DEAL_FIELDS.direccion] && pick("addr")[0]) f[DEAL_FIELDS.direccion] = pick("addr")[0];
  return f;
}
// Completa los campos vacíos del prospecto (solo si es tuyo o de la cuenta general; se lee al día antes de escribir).
// { saved: [nombres], url, reason }
async function fillLeadGaps(leadId, s, data, user) {
  const url = `${pd.PD_WEB}/leads/inbox/${leadId}`;
  let lead;
  try { lead = await pd.getLead(leadId); } catch (e) { return { saved: [], url, reason: `No pude leer el prospecto en Pipedrive para completarlo (${e.message}).` }; }
  if (!lead) return { saved: [], url, reason: "El prospecto ya no está en Pipedrive." };
  if (lead.ownerId && lead.ownerId !== user.pdUserId) return { saved: [], url, reason: "No completé el prospecto: es de otra persona." };
  const patch = leadGaps(lead, await leadWants(s, data, user));
  if (!Object.keys(patch).length) return { saved: [], url };
  const r = await pd.fillLead(leadId, patch).catch(e => ({ saved: [], failed: Object.keys(patch), error: e.message }));
  return { saved: fieldNames(r.saved), url, ...(r.failed?.length ? { reason: `No pude completar ${joinY(fieldNames(r.failed))} en el prospecto (${r.error || "Pipedrive no lo aceptó"}).` } : {}) };
}

// Se asegura de que el colegio tenga organización en Pipedrive; si no existe, la crea.
export async function ensureOrg(id, ownerId = null) {
  const s = byId.get(id);
  if (s?.leadOnly) throw bad("Es un prospecto sin organización: lo que registres queda en el prospecto.", 409);
  await refreshMatch(id);
  let rec = await checkSchool(id);
  if (rec.orgId) return rec;
  // nunca se crea sin revisar antes si ya está en Pipedrive (quien llama casi siempre ya lo hizo: queda 2 minutos)
  await settleExisting(id, { pdUserId: ownerId });
  if (s?.leadOnly) throw bad("Este colegio ya tiene un prospecto en Pipedrive: lo que registres queda ahí. Probá de nuevo.", 409);
  rec = getMatch(id);
  if (rec?.orgId) return rec;
  return withLock("org:" + id, async () => {
    // otra instancia pudo haberla creado mientras esperábamos el candado
    await refreshMatch(id);
    rec = await checkSchool(id);
    if (rec.orgId) return rec;
    if (!ownerId) throw bad(pd.NO_OWNER, 403);
    const org = await pd.createOrganization({
      name: s.name, website: s.web, ownerId,
      address: { value: [s.addr, s.city, s.country].filter(Boolean).join(", "), locality: s.city, country: s.country },
    });
    return setMatch(id, { status: "org", detail: "Creado desde OrderBrain SDR", orgId: org.id, orgName: org.name || s.name, confirmed: true, openDealId: null, dealCount: 0, candidates: [], created: true, ownerId: ownerId || null });
  });
}

// Sugerencia de próximo paso para el formulario.
export function nextFor(id, outcome, channel, tz) {
  return suggestNext({ outcome, channel, attempts: countAttempts(touchesFor(id)), today: todayIn(tz) });
}

// ---------- registrar un contacto
// el contacto queda en la nota aunque no tenga nombre (teléfono o mail sueltos); la persona se crea solo con nombre
const contactLine = c => [c.name, c.role, c.phone, c.email].map(x => String(x ?? "").trim()).filter(Boolean).join(" · ");
// Escribe en Pipedrive: actividad hecha (el contacto), nota, persona, trato, demo, próximo paso y pérdida.
// «Atendió recepción»: el nombre y cargo que dieron, para preguntar por esa persona la próxima vez
export const askOf = (o, c) => o.id === "gatekeeper" && String(c?.name || "").trim() ? { name: String(c.name).replace(/\s+/g, " ").trim().slice(0, 80), role: String(c.role || "").replace(/\s+/g, " ").trim().slice(0, 60) } : null;
// Filas de la nota: lo que sacó la IA y lo que cargó el SDR. La cafetería de la IA solo completa la fila «Cafetería» si el SDR no la eligió.
export function noteRows(q = {}, c = {}, ask = null, structured = null) {
  const qualRows = [["Preguntar por", ask && personLabel(ask.name, ask.role)], ["Cafetería", q.cafeteria || structured?.cafeteria], ["Alumnos", q.alumnos], ["Niveles", (q.niveles || []).join(", ")], ["Sistema actual", q.sistema], ["Contacto", contactLine(c)]];
  const aiRows = structured ? [["Resumen", structured.resumen], ["Decisor", structured.decisor], ["Objeción", structured.objecion], ["Próximo paso", structured.proximo_paso], ["Interés", structured.interes]] : [];
  return [...aiRows, ...qualRows].filter(([, v]) => v && String(v).trim());
}
// «Demo blindada»: un WhatsApp «Confirmar demo» el día hábil anterior (o hoy) para quien agenda la demo.
// date y time son locales (tz). Los «Confirmar demo» pendientes de la organización (o del prospecto sin organización):
// al agendar se mueve el tuyo (o cualquiera si sos líder); al mover una demo ya revisada (any) se mueven todos, sin cambiar de dueño.
// Si no hay ninguno se crea a nombre de ownerId (por defecto quien agenda).
export const reminderPlan = (pend, { userId, leader = false, any = false }) => { const move = pend.filter(a => any || canLead(leader, { id: a.owner_id }) || Number(a.owner_id) === Number(userId)); return { move, others: pend.filter(a => !move.includes(a)) }; };
export async function demoReminder({ name, orgId, dealId, personId, leadId, date, time, tz, user, leader = false, any = false, ownerId = null }) {
  const t = todayIn(tz), day = confirmDay(date, t); if (!day) return [];
  const note = `Demo el ${nice(date)}${time ? ` a las ${esc(time)} (hora de ${esc(safeTz(tz))})` : ""}. Confirmala por WhatsApp con la plantilla «Confirmar demo».<br><br><i>Agendado solo por OrderBrain SDR</i>`;
  const where = orgId ? { orgId } : leadId ? { leadId } : null;
  const pend = where ? (await pd.activities({ ...where, done: false, limit: 50 }).catch(() => [])).filter(a => a.type === "deadline" && /^Confirmar demo\b/.test(a.subject || "")) : [];
  const { move, others } = reminderPlan(pend, { userId: user.pdUserId, leader, any }), label = `Recordatorio para confirmar la demo ${day === t ? "hoy" : "el " + nice(day)}`;
  for (const a of move) await pd.updateActivity(a.id, { due_date: day, note });
  if (!move.length) await pd.addActivity({ subject: `Confirmar demo · ${name}`, type: "deadline", dueDate: day, orgId, dealId, personId, leadId, ownerId: ownerId || user.pdUserId, note });
  const theirs = move.some(a => Number(a.owner_id) !== Number(user.pdUserId));
  return [{ label: label + (theirs ? " (es de otra persona: le queda con la fecha nueva)" : "") }, ...(others.length ? [{ label: "Hay otro recordatorio para confirmar esta demo, de otra persona: avisale del cambio.", warn: true }] : [])];
}
// Se movió una demo (actividad de Pipedrive ya revisada con ownActivity): el recordatorio la acompaña, sea de quien sea.
// Si no había, queda para el dueño de la demo (no para el líder que la movió).
export async function demoMoved(a, user, { date, time }, tz, leader = false) {
  if (a?.type !== "meeting" || a.done) return [];
  const org = a.org_id ? (await pd.orgsByIds([a.org_id]).catch(() => []))[0] : null;
  const name = org?.name || String(a.subject || "").split(" · ").slice(1).join(" · ") || "la demo";
  const local = time || (a.due_time ? fromUtc(a.due_date, a.due_time, tz).time : "");
  return demoReminder({ name, orgId: a.org_id || null, dealId: a.deal_id || null, leadId: a.lead_id || null, date, time: local, tz, user, leader, any: true, ownerId: pd.realOwner(a.owner_id) });
}
// ---------- mail desde la ficha: sale de la casilla que la persona tiene conectada en Pipedrive (lib/pdtoken.js, via
// "pipedrive") o, como segunda opción, de su Gmail (lib/gmail.js, via "gmail"), por `send`; acá van los controles de dueño
// y lo que queda en Pipedrive y en la app. Primero se revisa todo lo que puede frenar el envío (archivado, cliente, de otra
// persona) y recién después se manda: si después falla Pipedrive, el mail ya salió y se avisa qué falta registrar a mano.
// Con Pipedrive, el borrador va ligado al prospecto o al trato: dónde queda (mailTarget) se resuelve ANTES de mandar.
const mailOut = m => ({ id: m.id, at: m.at, by: m.byName || "", to: m.to, subject: m.subject, body: m.body || "", next: m.next || null, autoNext: m.autoNext || null, pendingNext: m.pendingNext || null, url: m.url || "", via: m.via || "gmail" });
export const mailNoteHtml = ({ to, subject, text, by, via = "gmail" }) => `<b>Mail enviado</b> a ${esc(to)}<br><b>Asunto:</b> ${esc(subject)}<br><br>${esc(text).replace(/\n/g, "<br>")}<br><br><i>Enviado por ${esc(by)} desde OrderBrain SDR con su ${via === "pipedrive" ? "correo de Pipedrive" : "Gmail"}</i>`;
// «Mail: <asunto> · <colegio>» (sin repetir el colegio si el asunto ya lo nombra)
export const mailActivitySubject = (subject, name) => { const a = `Mail: ${subject}`, b = `${a} · ${name}`; return (b.length <= 250 && !pd.norm(subject).includes(pd.norm(name)) ? b : a).slice(0, 250); };
// Lo que frena un mail antes de mandarlo: archivado, cliente, de otra persona (la organización, su trato abierto o el
// prospecto). Lo usan el envío y el chequeo del modal (antes de la cuenta de 5 s, así no se ofrece «Enviar» donde va a
// fallar). Dueño al día: solo lo tuyo o lo libre (las cuentas generales cuentan como libres).
export async function mailGuard(id, user) {
  const s = byId.get(id);
  if (!s) throw bad("Colegio inexistente", 404);
  if (!user.pdUserId) throw bad("Tu email no coincide con ningún usuario de Pipedrive: pedí que te den de alta.", 403);
  await refreshArchived(id);
  if (effMatch(s)?.status === "archived") throw bad("Está archivado: desarchivalo para escribirle.", 409);
  const me = user.pdUserId;
  // ¿ya está en Pipedrive? (sin escribir: lo que haya que pasar a tu nombre se hace al mandar)
  await settleExisting(id, user, { dry: true });
  if (s.leadOnly) {
    // sin poder leer el prospecto no se sabe de quién es: no se manda (un error pasajero no cuenta como «libre»)
    let lead;
    try { lead = await pd.getLead(s.leadId); } catch { throw bad("No pude comprobar en Pipedrive de quién es el prospecto. Probá de nuevo.", 503); }
    if (!lead) throw bad("Ese prospecto ya no está en Pipedrive (lo borraron o lo pasaron a trato). Actualizá la ficha.", 404);
    if (lead.ownerId && lead.ownerId !== me) { const m = await pd.meta().catch(() => ({ users: [] })); throw bad(`El prospecto es de ${m.users.find(u => u.id === lead.ownerId)?.name || "otra persona"} en Pipedrive. Hablalo con esa persona.`, 409); }
    return { s, lead, cur: null };
  }
  const cur = await checkSchool(id, { force: true });
  const eff = effMatch(s) || cur;
  if (eff.status === "client") throw bad("Ya es cliente de OrderEAT: no se prospecta. Si hay algo, avisale al equipo de cuentas.", 409);
  if (cur.ownerId && cur.ownerId !== me) throw bad(`La organización es de ${cur.ownerName || "otra persona"} en Pipedrive. Hablalo con esa persona.`, 409);
  const dealOwner = cur.openDealId ? pd.realOwner(cur.openDealOwnerId) : null;
  if (dealOwner && dealOwner !== me) throw bad(`Tiene un trato abierto de ${cur.openDealOwner || "otra persona"}. Coordiná con esa persona antes de escribirle.`, 409);
  return { s, lead: null, cur };
}
// la actividad pendiente que queda como próximo paso, en la hora local (Registrar la muestra y la puede mover)
const nextOf = (a, tz, extra = {}) => { const l = a.due_time ? fromUtc(a.due_date, a.due_time, tz) : { date: a.due_date, time: "" }; return { id: a.id, type: a.type, date: l.date, time: (l.time || "").slice(0, 5), subject: a.subject || "", ...extra }; };
const kindOf = type => (TYPE_LABEL[type] || "tarea").toLowerCase();
export async function sendMail(id, user, body, tz, { send, by = "", via = "gmail" } = {}) {
  const s0 = byId.get(id);
  if (!s0) throw bad("Colegio inexistente", 404);
  if (!user.pdUserId) throw bad("Tu email no coincide con ningún usuario de Pipedrive: pedí que te den de alta.", 403);
  const v = validateMail(body); if (v.error) throw bad(v.error);
  // primero todo lo que puede frenar el envío; recién después se manda
  const { s, lead } = await mailGuard(id, user);
  let pre = null;
  if (via === "pipedrive") {
    // el borrador de Pipedrive se liga al prospecto o al trato: primero dónde queda (puede crear la organización o el
    // prospecto a tu nombre, como un contacto). Si eso falla, no se manda (y no se sabe dónde quedaría).
    pre = { done: [], warnings: [] };
    try { Object.assign(pre, await mailTarget(id, s, lead, user, v, pre.done, pre.warnings)); }
    catch (e) { throw bad(`No pude preparar el mail en Pipedrive (${e.message}). No se mandó: probá de nuevo.`, e.status === 409 ? 409 : 502); }
  }
  const t = pre?.target || {};
  const sent = await send({ to: v.to, subject: v.subject, text: v.text, leadId: t.dealId ? null : t.leadId || null, dealId: t.dealId || null, toName: pre?.personName || "" });
  // el mail ya salió: cualquier error de acá en adelante lleva sent = true (el servidor no libera la clave del envío)
  try { return await afterMailSent(id, s, lead, user, v, sent, body, tz, by, pre); }
  catch (e) { throw Object.assign(e, { sent: true }); }
}
// Dónde queda un mail en Pipedrive: el prospecto de la ficha, el trato abierto o, sin trato, un prospecto (workLead: el
// abierto tuyo o libre, o uno nuevo a tu nombre); si no se puede, la organización. Primer contacto real: la organización se
// crea (o pasa de la cuenta general) a tu nombre. Escribe en done/warnings lo que hizo.
async function mailTarget(id, s, lead, user, v, done, warnings) {
  const me = user.pdUserId;
  let target, url, personId = null, personName = "", firstTake = false, leadR = null, orgRec = null;
  if (s.leadOnly) {
    target = { leadId: s.leadId }; url = `${pd.PD_WEB}/leads/inbox/${s.leadId}`;
    personId = s.personId || null;
    if (lead && !lead.ownerId) await pd.updateLead(s.leadId, { owner_id: me }).then(() => done.push({ label: "El prospecto pasó a tu nombre (estaba en la cuenta general)" })).catch(() => {});
  } else {
    // primer contacto real: la organización se crea (o pasa de la cuenta general) a tu nombre; antes, lo que ya hay en Pipedrive
    firstTake = !getMatch(id)?.orgId;
    const pre = await settleExisting(id, user); done.push(...pre.done); warnings.push(...pre.warnings);
    const rec = await ensureOrg(id, me);
    if (!rec.created && !rec.ownerId && rec.confirmed) await pd.updateOrganization(rec.orgId, { owner_id: me }).then(() => { setMatch(id, { ...getMatch(id), ownerId: me, ownerName: signer(user) }); done.push({ label: "El colegio pasó a tu nombre en Pipedrive (estaba en la cuenta general)" }); }).catch(() => {});
    if (rec.created) done.push({ label: "Organización creada en Pipedrive a tu nombre", url: `${pd.PD_WEB}/organization/${rec.orgId}` });
    firstTake = firstTake || !!rec.created;
    const p = (await pd.personsForOrg(rec.orgId).catch(() => [])).find(x => String(x.email || "").trim().toLowerCase() === v.to);
    personId = p?.id || null; personName = p?.name || "";
    // sin trato abierto, el mail va a un prospecto (el abierto tuyo o libre, o uno nuevo a tu nombre), como un contacto
    leadR = rec.openDealId ? null : await workLead(id, rec, user, done, warnings, { personId });
    orgRec = rec;
    if (leadR && !personId && leadR.personId) personId = leadR.personId;
    target = leadR ? { orgId: rec.orgId, leadId: leadR.id } : { orgId: rec.orgId, dealId: rec.openDealId || undefined };
    url = leadR ? leadR.url : rec.openDealId ? `${pd.PD_WEB}/deal/${rec.openDealId}` : `${pd.PD_WEB}/organization/${rec.orgId}`;
  }
  target.personId = personId || undefined;
  return { target, url, firstTake, leadR, orgRec, personName };
}
async function afterMailSent(id, s, lead, user, v, sent, body, tz, by, pre = null) {
  const me = user.pdUserId, sign = by || signer(user), viaPd = sent.via === "pipedrive";
  const today = todayIn(tz), at = new Date().toISOString();
  const done = [{ label: `Mail enviado a ${v.to} desde ${viaPd ? "tu correo de Pipedrive" : sent.from || "tu Gmail"}` }], warnings = [...(pre?.warnings || [])];
  if (sent.bcc) done.push({ label: "Copia a Pipedrive (Smart BCC): queda en su pestaña de correo" });
  if (viaPd) done.push(...(pre?.done || []), { label: sent.linked === "deal" ? "Queda en el correo del trato en Pipedrive" : sent.linked === "lead" ? "Queda en el correo del prospecto en Pipedrive" : "Queda en tu correo de Pipedrive (sin prospecto ni trato para ligarlo)", ...(pre?.url ? { url: pre.url } : {}) });
  let target = pre?.target || null, url = pre?.url || "", activityId = null, autoNext = null, pendingNext = null, firstTake = !!pre?.firstTake, pdOk = false, doneActId = null, leadR = pre?.leadR || null, orgRec = pre?.orgRec || null;
  try {
    if (!pre) ({ target, url, firstTake, leadR, orgRec } = await mailTarget(id, s, lead, user, v, done, warnings));
    const a = await pd.addActivity({ subject: mailActivitySubject(v.subject, s.name), type: CHANNEL_TYPE.mail, dueDate: today, ...target, ownerId: me, done: true,
      note: `<b>Para:</b> ${esc(v.to)}<br><b>Asunto:</b> ${esc(v.subject)}<br><br>${esc(v.text).replace(/\n/g, "<br>")}` });
    activityId = a?.id || null;
    done.push({ label: "Actividad «Mail» hecha en Pipedrive, con el asunto y el texto", url });
    const noteHtml = mailNoteHtml({ ...v, by: sign, via: sent.via });
    await pd.addNote({ content: noteHtml, ...target }).catch(e => { if (!(target.leadId && target.orgId)) throw e; return pd.addNote({ content: noteHtml, leadId: target.leadId, personId: target.personId }); });
    done.push({ label: target.leadId ? "Nota en el prospecto" : target.dealId ? "Nota en el trato" : "Nota en la organización", url });
    const doneId = Number(body.completeActivityId) || null;
    if (doneId) await pd.updateActivity(doneId, { done: true }).then(() => { doneActId = doneId; done.push({ label: "Actividad pendiente marcada como hecha" }); }, () => done.push({ label: "No pude marcar la actividad como hecha: hacelo desde la agenda.", warn: true }));
    // Próximo paso, siempre: si ya tenés algo pendiente con este colegio, queda eso (Registrar lo puede mover, sin crear
    // otro). Si no, una llamada a tu nombre: el próximo día hábil si es el primer contacto, si no en 2 días hábiles.
    // Si no se pueden leer los pendientes, se agenda igual (mejor una llamada de más que un colegio sin nada para hacer).
    // (con organización se leen las de la organización: incluye las del prospecto, que también la llevan)
    const pend = await pd.activities({ ...(target.orgId ? { orgId: target.orgId } : { leadId: target.leadId }), done: false, limit: 50 }).catch(() => null);
    const mine = (pend || []).filter(x => !x.done && Number(pd.realOwner(x.owner_id ?? x.user_id)) === me && x.id !== doneId && x.id !== activityId)
      .sort((x, y) => `${x.due_date} ${x.due_time || ""}`.localeCompare(`${y.due_date} ${y.due_time || ""}`));
    if (mine.length) pendingNext = nextOf(mine[0], tz, { count: mine.length });
    else {
      const day = addBusinessDays(today, firstTake ? 1 : 2);
      const n = await pd.addActivity({ subject: `${TYPE_LABEL.call} · ${s.name}`, type: "call", dueDate: day, ...target, ownerId: me, note: `Seguimiento del mail «${esc(v.subject)}» (agendado solo por OrderBrain SDR).` });
      autoNext = { id: n?.id || null, type: "call", date: day, time: "" };
      done.push({ label: `Próximo paso: llamada el ${nice(day)} (automático, lo podés cambiar)` });
    }
    if (!s.leadOnly) { const fresh = await checkSchool(id, { force: true }).catch(() => getMatch(id)); if (fresh && (!fresh.confirmed || fresh.auto)) setMatch(id, { ...fresh, confirmed: true, auto: false }); }
    pdOk = true;
    // prospecto recién creado: sus campos vacíos y la nota de datos del colegio (con tope de tiempo)
    if (leadR?.created) await enrichNewLead(id, user, done, by).catch(() => {});
  } catch (e) {
    console.warn("Mail enviado sin registrar en Pipedrive:", e.message);
    warnings.push(`El mail salió, pero no pude guardarlo en Pipedrive (${e.message}). Registralo a mano.`);
  }
  // el contacto (cadencia, meta y ranking) y el mail con su cuerpo (Historial): una sola entrada «Mail enviado»
  // (si algo de esto falla, el mail ya salió: se avisa, no se tira error, así no se vuelve a mandar)
  let histOk = false;
  const rec = { id: sent.id, threadId: sent.threadId || "", at, by: user.email, byName: sign, to: v.to, subject: v.subject, body: v.text, from: sent.from || "", bcc: !!sent.bcc,
    signature: sent.signature || "", via: viaPd ? "pipedrive" : "gmail", ...(sent.draftId ? { draftId: sent.draftId } : {}), target, url, activityId, autoNext, pendingNext, next: null, pdOk, ...(doneActId ? { doneActId } : {}) };
  try { addTouch({ schoolId: id, by: user.email, byName: signer(user), outcome: MAIL_SENT.id, channel: "mail", connected: false, text: v.subject.slice(0, 200), mailId: sent.id, to: v.to, ...(doneActId ? { doneActId } : {}) }); await addMail(id, rec); histOk = true; }
  catch (e) { console.warn("Mail enviado sin guardar en el historial:", e.message); warnings.push("El mail salió, pero no pude guardarlo en el historial de la app."); }
  done.push(...warnings.map(label => ({ label, warn: true })));
  const fallback = { type: "call", date: addBusinessDays(today, 2) };
  const suggest = autoNext ? { ...autoNext, why: firstTake ? "Es la primera vez que se lo contacta: quedó una llamada a tu nombre para el próximo día hábil. Cambiala si querés."
      : "Quedó una llamada a tu nombre en 2 días hábiles para confirmar que lo vio y proponer una demo de 20 minutos. Cambiala si querés." }
    : pendingNext ? { ...pendingNext, why: `Ya tenés ${pendingNext.type === "meeting" ? "una demo" : `una ${kindOf(pendingNext.type)}`} con este colegio el ${nice(pendingNext.date)}${pendingNext.time ? ` a las ${pendingNext.time}` : ""}: si la cambiás, se mueve esa (no se crea otra).` }
    : { ...fallback, why: "Llamá en 2 días hábiles para confirmar que lo vio y proponer una demo de 20 minutos." };
  return { ok: true, done, warnings, logged: { pipedrive: pdOk, history: histOk }, mail: mailOut(rec), suggest, fallback, orgUrl: url, school: schoolSummary(s),
    ...(s.leadOnly ? whereOf({ lead: { id: s.leadId, title: leadTitleOf(s), url: leadUrlOf(s.leadId) } }) : whereOf({ lead: leadR, dealId: target?.dealId || null, orgId: orgRec?.orgId || null, orgName: orgRec?.orgName || "" })) };
}
// Próximo paso después de un mail enviado (Registrar se abre con el mail ya registrado). Se mueve la actividad que ya
// quedó (moveActivityId: la llamada automática o una tuya pendiente) en vez de crear otra; si el paso es el mismo que ya
// estaba, no se toca. completeActivityId: la de la agenda desde la que se abrió la ficha, marcada como hecha.
// Sin próximo paso se puede, con aviso.
export async function mailNext(id, user, { mailId, next = null, moveActivityId = null, completeActivityId = null } = {}, tz) {
  const s = byId.get(id); if (!s) throw bad("Colegio inexistente", 404);
  const m = (await mailsFor(id)).find(x => x.id === String(mailId || "") && x.by === user.email);
  if (!m) throw bad("No encontré ese mail.", 404);
  if (m.next) throw bad("Ya guardaste el próximo paso de este mail.", 409);
  if (next && (!TYPE_LABEL[next.type] || !/^\d{4}-\d{2}-\d{2}$/.test(next.date || "") || (next.time && !/^\d{2}:\d{2}$/.test(next.time)))) throw bad("Revisá el próximo paso: qué, día y hora.");
  const done = [], target = m.target || (s.leadOnly ? { leadId: s.leadId } : null);
  const doneId = Number(completeActivityId) || null;
  let closedId = null;
  if (doneId) await pd.updateActivity(doneId, { done: true }).then(() => { closedId = doneId; done.push({ label: "Actividad de la agenda marcada como hecha" }); }, () => done.push({ label: "No pude marcar la actividad como hecha: hacelo desde la agenda.", warn: true }));
  // la que queda como próximo paso: la que pidió mover el navegador o, si no, la automática (salvo que se haya marcado hecha)
  const baseId = Number(moveActivityId) || (m.autoNext?.id && Number(m.autoNext.id) !== doneId ? Number(m.autoNext.id) : null);
  const base = baseId && baseId !== doneId ? await pd.getActivity(baseId).catch(() => null) : null;
  const live = base && !base.done ? base : null;
  const isAuto = !!live && Number(m.autoNext?.id) === live.id;
  const what = a => `${isAuto ? "la llamada automática" : `tu ${kindOf(a.type)}`} del ${nice(nextOf(a, tz).date)}`;
  if (next) {
    if (!target) throw bad("Este mail no quedó en Pipedrive: agendá el próximo paso desde Registrar.", 409);
    const u = toUtc(next.date, next.time, tz), owner = Number(next.ownerId) || user.pdUserId;
    const subject = String(next.subject || "").trim().slice(0, 140);
    // igual a lo que ya estaba (qué, día, hora y para quién, sin detalle nuevo): no se toca
    const same = live && live.type === next.type && live.due_date === u.date && String(live.due_time || "").slice(0, 5) === String(u.time || "").slice(0, 5)
      && Number(pd.realOwner(live.owner_id ?? live.user_id) || live.owner_id) === owner && !subject;
    if (same) done.push({ label: `Queda ${what(live)}${live.due_time ? ` a las ${nextOf(live, tz).time}` : ""}`, url: m.url || undefined });
    else {
      let moved = false;
      if (live) moved = await pd.updateActivity(live.id, { type: next.type, subject: subject || `${TYPE_LABEL[next.type]} · ${s.name}`, due_date: u.date, ...(u.time ? { due_time: u.time } : {}), owner_id: owner }).then(() => true, () => false);
      if (!moved) await pd.addActivity({ subject: subject || `${TYPE_LABEL[next.type]} · ${s.name}`, type: next.type, dueDate: u.date, dueTime: u.time, ...target, ownerId: owner, note: `Después del mail «${esc(m.subject)}»` });
      done.push({ label: `Próximo paso: ${TYPE_LABEL[next.type]} el ${nice(next.date)}${next.time ? " a las " + next.time : ""}${moved ? isAuto ? " (cambié la llamada automática)" : " (moví la que ya tenías, no hay otra)" : ""}`, url: m.url || undefined });
    }
  } else done.push(live ? { label: `Queda ${what(live)}` } : { label: "Sin próximo paso: este colegio se puede perder de vista.", warn: true });
  // la de la agenda que se cerró con el mail: en el Historial va en la entrada del mail
  await patchMail(id, m.id, { next: next ? { type: next.type, date: next.date, time: next.time || "" } : { none: true }, nextAt: new Date().toISOString(), ...(closedId && !m.doneActId ? { doneActId: closedId } : {}) });
  return { ok: true, done, orgUrl: m.url || "", school: schoolSummary(s) };
}

// resultados que cierran o ya tienen su propio paso (la demo): ahí no se agenda solo un seguimiento
const NO_AUTO_NEXT = ["demo", "not_interested", "bad_data"];
// El prospecto abierto de la organización donde va un contacto: el de la ficha o el cruce si sigue abierto; si no, el único
// abierto de la organización (o el tuyo, si hay varios). Solo tuyo o de la cuenta general (FREE_OWNERS → pasa a tu nombre).
export function pickContactLead(open, known, me) {
  const mine = l => Number(l.ownerId) === Number(me), free = l => !l.ownerId;
  const k = known && open.find(l => l.id === known);
  if (k) return k;
  if (open.length === 1) return open[0];
  return open.find(mine) || (open.filter(free).length === 1 ? open.find(free) : null);
}
// Cliente de OrderEAT (no se prospecta): trato ganado o en un embudo de clientes, activo en World Dominion, o fase activo u
// onboarding. sum: schoolSummary; rec: el cruce al día.
export const clientNow = (sum, rec = {}) => sum?.status === "client" || rec?.status === "client" || ["activo", "onboarding"].includes(sum?.phase) || ["activo", "onboarding"].includes(rec?.phase);
// ex cliente de OrderEAT (churn, por World Dominion o Pipedrive): no se le crea prospecto (pedido del líder)
export const exClientNow = (sum, rec = {}) => sum?.status === "churn" || rec?.status === "churn" || sum?.phase === "churn" || rec?.phase === "churn" || !!sum?.ob?.churn;
const leadUrlOf = lid => `${pd.PD_WEB}/leads/inbox/${lid}`;
// El prospecto nuevo de un colegio con organización: a tu nombre, título = nombre del colegio y los campos del formulario
// de Pipedrive (leadFields). Queda en el cruce. Lo usan «Crear prospecto» y el prospecto automático (workLead).
async function newLead(id, rec, user, { personId = null, found = {} } = {}) {
  const s = byId.get(id);
  const lead = await pd.createLead({ title: s.name, ownerId: user.pdUserId, orgId: rec.orgId, personId, fields: await leadFields(s, user, found) });
  if (!lead?.id) throw bad("Pipedrive no devolvió el prospecto.", 502);
  const mm = getMatch(id); if (mm?.orgId === rec.orgId) setMatch(id, { ...mm, leadId: lead.id });
  return lead;
}
// Dónde va lo que se registra de un colegio de la base sin trato abierto (un contacto, un comentario, un mail, lo que
// confirma el asistente): SIEMPRE un prospecto, como se trabaja en el Buzón de prospectos de Pipedrive. El abierto de la
// organización (el de la ficha, el único o el tuyo; uno de la cuenta general pasa a tu nombre) o, si no tiene ninguno,
// uno nuevo a tu nombre (newLead). null = queda en la organización: trato abierto, cliente, organización o prospecto de otra
// persona, varios prospectos sin uno tuyo, o no se pudieron leer los prospectos (con aviso en warnings, salvo el cliente).
// Devuelve { id, title, ownerId, personId, url, created }.
export async function workLead(id, rec, user, done, warnings, { personId = null } = {}) {
  const s = byId.get(id), me = Number(user.pdUserId) || null;
  if (!s || s.leadOnly || !rec?.orgId || rec.openDealId || !me) return null;
  const known = s.leadId || getMatch(id)?.leadId || rec.leadId || null;
  let open = [];
  if (!rec.created) {
    try { open = await leadsHere(s, rec.orgId); }
    catch { warnings.push("No pude revisar los prospectos en Pipedrive: quedó en la organización."); return null; }
  }
  const l = pickContactLead(open, known, me);
  const keep = (x, created) => {
    const mm = getMatch(id); if (mm && mm.leadId !== x.id) setMatch(id, { ...mm, leadId: x.id });
    done.push({ label: `Guardado en el prospecto «${x.title || s.name}»`, url: leadUrlOf(x.id) });
    return { id: x.id, title: x.title || s.name, ownerId: me, personId: x.personId || x.person_id || null, url: leadUrlOf(x.id), created };
  };
  if (l) {
    if (l.ownerId && Number(l.ownerId) !== me) { warnings.push(`El prospecto «${l.title || "sin título"}» es de otra persona: quedó en la organización.`); return null; }
    if (!l.ownerId) await pd.updateLead(l.id, { owner_id: me }).then(() => done.push({ label: "El prospecto pasó a tu nombre (estaba en la cuenta general)" })).catch(() => {});
    return keep(l, false);
  }
  if (open.length) { warnings.push(open.some(x => !x.ownerId) ? "Tiene varios prospectos abiertos en Pipedrive y ninguno es tuyo: quedó en la organización." : "Tiene prospectos abiertos de otras personas: quedó en la organización."); return null; }
  // la investigación encontró un prospecto suelto (sin organización) de otra persona para este colegio: no se crea otro
  const other = getMatch(id)?.leadOther;
  if (other) { warnings.push(`Ya hay un prospecto de ${other.owner || "otra persona"} para este colegio en Pipedrive («${other.title}»): no creé otro, quedó en la organización.`); return null; }
  const sum = schoolSummary(s);
  if (clientNow(sum, rec)) return null;
  if (exClientNow(sum, rec)) { warnings.push("Es ex cliente de OrderEAT: no creé un prospecto, quedó en la organización."); return null; }
  if (rec.ownerId && Number(rec.ownerId) !== me) { warnings.push(`La organización es de ${rec.ownerName || "otra persona"}: no creé un prospecto, quedó en la organización.`); return null; }
  // nadie más lo está creando a la vez (otra instancia o «Crear prospecto»): se vuelve a mirar adentro del candado
  return withLock("prospect:" + id, async () => {
    if (!rec.created) { const again = await leadsHere(s, rec.orgId).catch(() => []); const x = pickContactLead(again, null, me); if (x && (!x.ownerId || Number(x.ownerId) === me)) return keep(x, false); if (again.length) { warnings.push("Ya hay otro prospecto abierto para este colegio: quedó en la organización."); return null; } }
    let lead;
    try { lead = await newLead(id, rec, user, { personId }); }
    catch (e) { warnings.push(`No pude crear el prospecto en Pipedrive (${e.message}): quedó en la organización.`); return null; }
    done.push({ label: `Prospecto creado a tu nombre: «${lead.title || s.name}»`, url: leadUrlOf(lead.id) });
    if (!OPTIONS.pais[s.country]) warnings.push(s.country ? paisWarn(s.country) : "No supe el país del colegio: el campo País del prospecto quedó sin completar.");
    return keep({ ...lead, title: lead.title || s.name }, true);
  });
}
// El prospecto abierto tuyo o libre de la organización (sin trato abierto), sin escribir nada: para notas de datos (estudio).
export async function openLeadFor(id, rec, me) {
  if (!rec?.orgId || rec.openDealId) return null;
  const open = await leadsHere(byId.get(id), rec.orgId).catch(() => []);
  const l = pickContactLead(open, byId.get(id)?.leadId || getMatch(id)?.leadId || rec.leadId || null, me);
  return l && (!l.ownerId || Number(l.ownerId) === Number(me)) ? l : null;
}
// Después de crear un prospecto: Enriquecer completa sus campos vacíos y deja la nota «Datos del colegio» en él. Con tope de
// tiempo (en Vercel no hay segundo plano): si no termina, se avisa que quedó pendiente (en un servidor común sigue y termina
// solo). Nunca tira error: lo registrado ya quedó.
export const ENRICH_WAIT = { ms: Number(process.env.ENRICH_WAIT_MS) || 4000 };
export async function enrichNewLead(id, user, done, by = "") {
  let timer;
  const job = enrichSchool(id, user, by, { photos: false }).catch(e => ({ failed: e }));
  const r = await Promise.race([job, new Promise(ok => { timer = setTimeout(ok, ENRICH_WAIT.ms, null); })]).finally(() => clearTimeout(timer));
  if (!r) { done.push({ label: "Sigo buscando los datos del colegio para el prospecto. Si en un rato no están, tocá «Enriquecer».", pending: true }); return { pending: true }; }
  if (r.failed) { done.push({ label: `No pude completar los datos del prospecto (${r.failed.message}). Tocá «Enriquecer».`, warn: true }); return { failed: true }; }
  if (r.fields?.saved?.length) done.push({ label: `Datos completados en el prospecto: ${joinY(r.fields.saved)}`, url: r.fields.url });
  if (r.fields?.reason) done.push({ label: r.fields.reason, warn: true });
  if (r.note?.saved) done.push({ label: "Nota «Datos del colegio» en el prospecto", url: r.note.url });
  return r;
}
// Se trabajó con esta organización (contacto, comentario, mail): el cruce queda confirmado y ya no se recalcula solo
export async function markWorked(id, rec) {
  const fresh = await checkSchool(id, { force: true }).catch(() => getMatch(id));
  if (fresh?.orgId && fresh.orgId === rec?.orgId && (!fresh.confirmed || fresh.auto)) setMatch(id, { ...fresh, confirmed: true, auto: false });
}
// Dónde quedó lo registrado (Registrar lo dice arriba; con un prospecto la ficha lo muestra sin recargar)
export const whereOf = ({ lead = null, dealId = null, orgId = null, orgName = "" }) => lead ? { where: { kind: "lead", id: lead.id, title: lead.title, url: lead.url, created: !!lead.created }, lead: { id: lead.id, title: lead.title, ownerId: lead.ownerId, url: lead.url, created: !!lead.created } }
  : dealId ? { where: { kind: "deal", id: dealId, url: `${pd.PD_WEB}/deal/${dealId}` } } : orgId ? { where: { kind: "org", id: orgId, title: orgName || "", url: `${pd.PD_WEB}/organization/${orgId}` } } : {};
export async function logContact(id, user, p, tz) {
  const s = byId.get(id);
  if (!s) throw bad("Colegio inexistente", 404);
  // archivado (como al crear el prospecto): primero se desarchiva
  await refreshArchived(id);
  if (effMatch(s)?.status === "archived") throw bad("Está archivado: desarchivalo para registrar contactos.", 409);
  const o = outcomeById(p.outcome);
  if (!o || o.hidden) throw bad("Elegí qué pasó en el contacto.");
  const channel = CHANNEL_TYPE[p.channel] ? p.channel : "call";
  const raw = String(p.text || "").trim().slice(0, 4000);
  const dateRe = /^\d{4}-\d{2}-\d{2}$/, timeRe = /^\d{2}:\d{2}$/;
  if (p.next?.type && !dateRe.test(p.next.date || "")) throw bad("Poné la fecha del próximo paso.");
  if (o.id === "demo" && (!dateRe.test(p.demo?.date || "") || !timeRe.test(p.demo?.time || ""))) throw bad("Poné el día y la hora de la demo.");
  if (p.lost?.reason && !LOST_REASONS.includes(p.lost.reason)) throw bad("Motivo de pérdida inválido.");
  // país del trato (embudo y campo País): el del registro, el del prospecto, el elegido o el prefijo del teléfono
  const lid0 = o.id === "demo" ? s.leadId || getMatch(id)?.leadId || null : null;
  const lead0 = lid0 ? (await pd.leadsByIds([lid0], user.pdUserId).catch(() => []))[0] || null : null;
  const country = s.country || countryFromOpt(lead0?.paisOpt) || (MARKETS[p.country] ? p.country : "") || phoneCountry(s.phone, p.contact?.phone);
  if (s.virtual && !s.country && country) s.country = country;
  if (o.id === "demo" && s.virtual && !s.country) throw bad("Elegí el país del colegio: el trato se crea en el embudo de ese país.");
  const mk = market(country);
  const today = todayIn(tz);
  const done = [], warnings = [];
  // antes de crear nada: ¿ya está en Pipedrive? (puede quedar como «Prospecto en Pipe»: entonces todo va a ese prospecto)
  const pre = await settleExisting(id, user);
  if (s.leadOnly) { const r = await logLead(id, s, user, p, tz, { o, channel, raw, today }); r.done.unshift(...pre.done); r.done.push(...pre.warnings.map(label => ({ label, warn: true }))); return r; }
  done.push(...pre.done); warnings.push(...pre.warnings);

  // ¿lo está tomando por primera vez? (nunca contactado: no tenía organización en Pipedrive)
  const firstTake = !getMatch(id)?.orgId;
  const rec = await ensureOrg(id, user.pdUserId);
  // si estaba a nombre de la cuenta general de la empresa, pasa a quien lo trabaja
  if (!rec.created && !rec.ownerId && rec.confirmed) {
    await pd.updateOrganization(rec.orgId, { owner_id: user.pdUserId }).then(() => { setMatch(id, { ...getMatch(id), ownerId: user.pdUserId, ownerName: signer(user) }); done.push({ label: "El colegio pasó a tu nombre en Pipedrive (estaba en la cuenta general)" }); }).catch(() => {});
  }
  const orgUrl = `${pd.PD_WEB}/organization/${rec.orgId}`;
  // (si todo va a un prospecto, esta línea pasa a decir solo cuál es la organización)
  const orgLine = { label: rec.created ? "Organización creada en Pipedrive a tu nombre" : `Guardado en ${rec.orgName}`, url: orgUrl };
  done.push(orgLine);

  // Persona (decisor o contacto). Si viene de un prospecto que ya tenía persona, esa persona pasa a la organización.
  let personId = p._personId || null;
  if (personId) await pd.updatePerson(personId, { org_id: rec.orgId }).catch(() => {});
  const c = p.contact || {};
  if (c.name && String(c.name).trim()) {
    const person = await pd.addPerson({ name: personLabel(c.name, c.role), orgId: rec.orgId, phone: c.phone, email: c.email, ownerId: user.pdUserId });
    personId = person?.id || null;
    done.push({ label: `Contacto ${c.name}`, url: personId ? `${pd.PD_WEB}/person/${personId}` : orgUrl });
  }

  // Trato: se crea cuando se agenda la demo (o si se pide calificar y no hay uno abierto).
  let dealId = rec.openDealId || null;
  const q = p.qual || {};
  const custom = {};
  if (q.cafeteria && OPTIONS.cafeteria[q.cafeteria]) custom[DEAL_FIELDS.cafeteria] = OPTIONS.cafeteria[q.cafeteria];
  if (Number(q.alumnos) > 0) custom[DEAL_FIELDS.alumnos] = Number(q.alumnos);
  const niveles = (q.niveles || []).map(n => OPTIONS.niveles[n]).filter(Boolean);
  if (niveles.length) custom[DEAL_FIELDS.niveles] = niveles;
  if (o.id === "demo" && !dealId) {
    // la fuente del prospecto, si tiene; si no, cold calling
    const fuente = String(lead0?.fuenteOpt ?? "").split(",").map(Number).filter(n => n > 0);
    const body = { title: `${s.name}`, org_id: rec.orgId, pipeline_id: mk.pipeline, stage_id: mk.stage, owner_id: Number(p.demo.ownerId) || user.pdUserId || undefined,
      custom_fields: { ...custom, [DEAL_FIELDS.fuente]: fuente.length ? fuente : [OPTIONS.fuente.coldCalling] } };
    if (user.pdUserId) body.custom_fields[DEAL_FIELDS.sdr] = user.pdUserId;
    if (OPTIONS.pais[country]) body.custom_fields[DEAL_FIELDS.pais] = OPTIONS.pais[country];
    else warnings.push(country ? paisWarn(country) : "No supe el país: el trato quedó en el embudo LatAm. Revisalo en Pipedrive.");
    const ciudad = await pd.optionFor(DEAL_FIELDS.ciudad, s.city).catch(() => null); if (ciudad) body.custom_fields[DEAL_FIELDS.ciudad] = ciudad;
    if (s.phone) body.custom_fields[DEAL_FIELDS.telefono] = s.phone;
    if (s.web) body.custom_fields[DEAL_FIELDS.web] = s.web;
    if (personId) body.person_id = personId;
    let deal;
    try { deal = await pd.createDeal(body); }
    catch (e) { // si algún campo personalizado no coincide con la cuenta, se crea el trato sin ellos
      console.warn("Trato sin campos personalizados:", e.message);
      deal = await pd.createDeal({ title: body.title, org_id: body.org_id, pipeline_id: body.pipeline_id, stage_id: body.stage_id, owner_id: body.owner_id, person_id: body.person_id });
    }
    dealId = deal.id;
    done.push({ label: "Trato creado en el embudo de ventas", url: `${pd.PD_WEB}/deal/${dealId}` });
  } else if (dealId && Object.keys(custom).length) {
    await pd.updateDeal(dealId, { custom_fields: custom }).catch(e => console.warn("No se pudo calificar el trato:", e.message));
  }

  // Sin trato abierto, el contacto, el próximo paso y la nota van a un PROSPECTO (y a la organización y la persona), como se
  // trabaja en Pipedrive: el abierto de la organización (tuyo o de la cuenta general, que pasa a tu nombre) o uno nuevo a tu
  // nombre (workLead). Si el prospecto o la organización es de otra persona, o es cliente, queda en la organización (con
  // aviso). Con una demo se crea el trato (y el prospecto, si tenía, se archiva más abajo).
  const leadR = !dealId && o.id !== "demo" ? await workLead(id, rec, user, done, warnings, { personId }) : null, leadT = leadR?.id || null;
  if (leadT && !rec.created) orgLine.label = `Organización: ${rec.orgName}`;
  // la persona del prospecto, si no se cargó otra (como lo hace el equipo en Pipedrive: prospecto + organización + persona)
  if (leadR && !personId && leadR.personId) personId = leadR.personId;
  const tgt = leadT ? { orgId: rec.orgId, leadId: leadT } : { orgId: rec.orgId, dealId };

  // El contacto en sí, como actividad hecha (cuenta para los reportes de Pipedrive).
  const chLabel = { call: "Llamada", whatsapp: "WhatsApp", mail: "Mail", visit: "Visita" }[channel];
  await pd.addActivity({ subject: `${chLabel}: ${o.label} · ${s.name}`, type: CHANNEL_TYPE[channel], dueDate: today, ...tgt, personId, ownerId: user.pdUserId, note: raw ? esc(raw).replace(/\n/g, "<br>") : "", done: true });
  done.push({ label: `${chLabel} registrada como hecha` });

  // Nota ordenada
  const ask = askOf(o, c);
  let html = `<b>${esc(chLabel)} · ${esc(o.label)}</b>`;
  let structured = null;
  if (raw && p.ai !== false) structured = await structureNote({ school: s, outcome: o.label, text: raw }).catch(() => null);
  const rows = noteRows(q, c, ask, structured);
  if (rows.length) html += "<br>" + rows.map(([k, v]) => `<b>${k}:</b> ${esc(v)}`).join("<br>");
  if (raw) html += `<br><br>${structured ? "<i>Lo que anotó el SDR:</i> " : ""}${esc(raw).replace(/\n/g, "<br>")}`;

  // Demo
  if (o.id === "demo") {
    const owner = Number(p.demo.ownerId) || user.pdUserId;
    const u = toUtc(p.demo.date, p.demo.time, tz);
    await pd.addActivity({ subject: `Demo OrderEAT · ${s.name}`, type: "meeting", dueDate: u.date, dueTime: u.time, durationMin: Number(p.demo.duration) || 30, orgId: rec.orgId, dealId, personId, ownerId: owner,
      note: `Agendada por ${esc(signer(user))} desde OrderBrain SDR${raw ? "<br><br>" + esc(raw).replace(/\n/g, "<br>") : ""}` });
    html += `<br><b>Demo:</b> ${nice(p.demo.date)} ${esc(p.demo.time)} (hora de ${esc(tz)})`;
    done.push({ label: `Demo el ${nice(p.demo.date)} a las ${p.demo.time}` });
    done.push(...await demoReminder({ name: s.name, orgId: rec.orgId, dealId, personId, date: p.demo.date, time: p.demo.time, tz, user }).catch(e => [{ label: `No pude agendar el recordatorio para confirmar la demo: ${e.message}`, warn: true }]));
  }

  // Próximo paso (nextRec: lo que quedó agendado, para la sesión de trabajo)
  let nextRec = null;
  if (p.next?.type && TYPE_LABEL[p.next.type]) {
    const u = toUtc(p.next.date, p.next.time, tz);
    await pd.addActivity({ subject: p.next.subject || `${TYPE_LABEL[p.next.type]} · ${s.name}`, type: p.next.type, dueDate: u.date, dueTime: u.time, ...tgt, personId,
      ownerId: Number(p.next.ownerId) || user.pdUserId, note: raw ? esc(raw).slice(0, 1000) : "" });
    nextRec = { type: p.next.type, date: p.next.date, time: p.next.time || "", ownerId: Number(p.next.ownerId) || user.pdUserId || null };
    html += `<br><b>Próximo paso:</b> ${TYPE_LABEL[p.next.type]} el ${weekday(p.next.date)} ${esc(p.next.date)}${p.next.time ? " " + esc(p.next.time) : ""}`;
    done.push({ label: `Próximo paso: ${TYPE_LABEL[p.next.type]} el ${nice(p.next.date)}${p.next.time ? " a las " + p.next.time : ""}` });
  }

  // Colegio nuevo sin próximo paso elegido: queda una llamada para el próximo día hábil, a tu nombre (se cambia desde la agenda)
  else if ((firstTake || rec.created) && !NO_AUTO_NEXT.includes(o.id)) {
    const day = addBusinessDays(today, 1);
    await pd.addActivity({ subject: `${TYPE_LABEL.call} · ${s.name}`, type: "call", dueDate: day, ...tgt, personId, ownerId: user.pdUserId, note: "Seguimiento del primer contacto (agendado solo por OrderBrain SDR)." });
    nextRec = { type: "call", date: day, time: "", ownerId: user.pdUserId || null, auto: true };
    html += `<br><b>Próximo paso:</b> ${TYPE_LABEL.call} el ${weekday(day)} ${day}`;
    done.push({ label: `Próximo paso: llamada el ${nice(day)} (automático, cambialo en la agenda si querés)` });
  }

  // Pérdida
  if (p.lost?.reason) {
    if (dealId) {
      await pd.updateDeal(dealId, { status: "lost", lost_reason: p.lost.reason });
      done.push({ label: `Trato perdido: ${p.lost.reason}` });
    }
    html += `<br><b>Motivo:</b> ${esc(p.lost.reason)}`;
  }
  html += `<br><br><i>Cargado por ${esc(signer(user))} desde OrderBrain SDR</i>`;
  // la nota, en el prospecto y la organización; si Pipedrive no acepta las dos juntas, en el prospecto
  if (leadT) await pd.addNote({ content: html, orgId: rec.orgId, leadId: leadT, personId }).catch(() => pd.addNote({ content: html, leadId: leadT }));
  else await pd.addNote({ content: html, orgId: rec.orgId, dealId, personId });
  done.push({ label: leadT ? "Nota guardada en el prospecto" : "Nota guardada" });

  // Etiqueta de interés en la organización
  // se cambia solo la de interés (alto, medio, bajo); las demás etiquetas quedan. Si no se pueden leer, no se toca nada.
  if (o.interest && rec.status !== "client") {
    const org = (await pd.orgsByIds([rec.orgId]).catch(() => []))[0], lv = [OPTIONS.orgLabel.alto, OPTIONS.orgLabel.medio, OPTIONS.orgLabel.bajo];
    if (org) await pd.updateOrganization(rec.orgId, { label_ids: [...new Set([...(org.labelIds || []).map(Number).filter(x => !lv.includes(x)), OPTIONS.orgLabel[o.interest]])] }).catch(() => {});
  }

  // Marca como hecha la actividad que motivó el contacto
  let doneActId = null;
  if (p.completeActivityId) await pd.updateActivity(Number(p.completeActivityId), { done: true }).then(() => { doneActId = Number(p.completeActivityId); done.push({ label: "Actividad pendiente marcada como hecha" }); }, () => done.push({ label: "No pude marcar la actividad como hecha: hacelo desde la agenda.", warn: true }));
  // Un prospecto (lead) que llegó a demo ya es un trato: se archiva el prospecto con una nota
  // (el prospecto puede venir de la ficha, del cruce guardado o de «Crear prospecto»)
  const leadId = s.leadId || getMatch(id)?.leadId || rec.leadId || null;
  if (leadId && o.id === "demo" && dealId) {
    await pd.addNote({ content: `<b>Pasó a trato</b><br>Demo agendada desde OrderBrain SDR por ${esc(signer(user))}.<br><a href="${pd.PD_WEB}/deal/${dealId}">Ver trato</a>`, leadId }).catch(() => {});
    await pd.updateLead(leadId, { is_archived: true }).then(() => done.push({ label: "Prospecto archivado: ya es un trato" })).catch(() => {});
  }

  // doneActId: la pendiente de la agenda que se cerró con este contacto (en el Historial va en la misma entrada)
  addTouch({ schoolId: id, by: user.email, byName: signer(user), outcome: o.id, channel, connected: o.connected, text: raw.slice(0, 300), demo: o.id === "demo", ...(ask ? { ask } : {}), ...(doneActId ? { doneActId } : {}) });
  const fresh = await checkSchool(id, { force: true }).catch(() => getMatch(id));
  if (!fresh.confirmed || fresh.auto) setMatch(id, { ...fresh, confirmed: true, auto: false }); // ya se trabajó con esta organización
  // prospecto recién creado: sus campos vacíos y la nota de datos del colegio (con tope de tiempo; lo registrado ya quedó)
  if (leadR?.created) await enrichNewLead(id, user, done);
  done.push(...warnings.map(label => ({ label, warn: true })));
  return { ok: true, done, warnings, orgUrl: leadR ? leadR.url : orgUrl, dealUrl: dealId ? `${pd.PD_WEB}/deal/${dealId}` : null, school: schoolSummary(s),
    next: nextRec, demo: o.id === "demo" ? { date: p.demo.date, time: p.demo.time } : null, ...whereOf({ lead: leadR, dealId, orgId: rec.orgId, orgName: rec.orgName }) };
}

// Registrar el contacto con un prospecto (lead) de Pipedrive que todavía no tiene organización.
// Todo queda en el prospecto: la actividad hecha, la nota, la persona y el próximo paso. Si llega a demo,
// se crea la organización, se registra como siempre (trato + demo) y el prospecto se archiva.
async function logLead(id, s, user, p, tz, { o, channel, raw, today }) {
  const done = [], leadUrl = `${pd.PD_WEB}/leads/inbox/${s.leadId}`;
  const c = p.contact || {};
  if (o.id === "demo") {
    // pasa a organización (a nombre de quien registra) y se registra con el flujo normal: trato en el embudo del país
    // + demo. La persona se crea una sola vez (en logContact, ya con la organización); la que tenía el prospecto se mueve.
    return withLock("lead:" + s.leadId, async () => {
      const cur = getMatch(id);
      if (cur?.orgId && !s.leadOnly) return logContact(id, user, p, tz); // otra instancia ya lo convirtió
      const org = await pd.createOrganization({ name: withoutEvent(s.name), ownerId: user.pdUserId,
        address: s.city || s.country ? { value: [s.city, s.country].filter(Boolean).join(", "), locality: s.city || undefined, country: s.country || undefined } : undefined });
      await pd.updateLead(s.leadId, { organization_id: org.id }).catch(() => {});
      // la misma ficha sigue funcionando: ahora es la del colegio (organización), con el prospecto guardado en el cruce
      s.leadOnly = false; s.pdOrgId = org.id;
      setMatch(id, { status: "org", detail: "Creado desde OrderBrain SDR", orgId: org.id, orgName: org.name || s.name, confirmed: true, ownerId: user.pdUserId || null, leadId: s.leadId, candidates: [] });
      const r = await logContact(id, user, { ...p, _personId: c.name ? null : s.personId || null }, tz);
      return { ...r, done: [{ label: "Organización creada desde el prospecto", url: `${pd.PD_WEB}/organization/${org.id}` }, ...r.done] };
    });
  }
  let personId = s.personId || null;
  if (c.name && String(c.name).trim()) {
    const person = await pd.addPerson({ name: personLabel(c.name, c.role), phone: c.phone, email: c.email, ownerId: user.pdUserId });
    if (person?.id) {
      done.push({ label: `Contacto ${c.name}`, url: `${pd.PD_WEB}/person/${person.id}` });
      if (!personId) { personId = person.id; await pd.updateLead(s.leadId, { person_id: person.id }).catch(() => {}); s.personId = person.id; s.personName = c.name; }
    }
  }
  const chLabel = { call: "Llamada", whatsapp: "WhatsApp", mail: "Mail", visit: "Visita" }[channel];
  await pd.addActivity({ subject: `${chLabel}: ${o.label} · ${s.name}`, type: CHANNEL_TYPE[channel], dueDate: today, leadId: s.leadId, personId, ownerId: user.pdUserId, note: raw ? esc(raw).replace(/\n/g, "<br>") : "", done: true });
  done.push({ label: `${chLabel} registrada como hecha` });
  let html = `<b>${esc(chLabel)} · ${esc(o.label)}</b>`;
  const ask = askOf(o, c);
  if (ask) html += `<br><b>Preguntar por:</b> ${esc(personLabel(ask.name, ask.role))}`;
  if (contactLine(c)) html += `<br><b>Contacto:</b> ${esc(contactLine(c))}`;
  if (raw) html += `<br><br>${esc(raw).replace(/\n/g, "<br>")}`;
  let nextRec = null;
  if (p.next?.type && TYPE_LABEL[p.next.type]) {
    const u = toUtc(p.next.date, p.next.time, tz);
    await pd.addActivity({ subject: p.next.subject || `${TYPE_LABEL[p.next.type]} · ${s.name}`, type: p.next.type, dueDate: u.date, dueTime: u.time, leadId: s.leadId, personId, ownerId: Number(p.next.ownerId) || user.pdUserId, note: raw ? esc(raw).slice(0, 1000) : "" });
    nextRec = { type: p.next.type, date: p.next.date, time: p.next.time || "", ownerId: Number(p.next.ownerId) || user.pdUserId || null };
    html += `<br><b>Próximo paso:</b> ${TYPE_LABEL[p.next.type]} el ${weekday(p.next.date)} ${esc(p.next.date)}${p.next.time ? " " + esc(p.next.time) : ""}`;
    done.push({ label: `Próximo paso: ${TYPE_LABEL[p.next.type]} el ${nice(p.next.date)}${p.next.time ? " a las " + p.next.time : ""}` });
  }
  // descartado (no le interesa, no es el momento con motivo, dato erróneo): el prospecto se archiva con el motivo
  const discard = !!p.lost?.reason;
  if (p.lost?.reason) html += `<br><b>Motivo:</b> ${esc(p.lost.reason)}`;
  html += `<br><br><i>Cargado por ${esc(signer(user))} desde OrderBrain SDR</i>`;
  await pd.addNote({ content: html, leadId: s.leadId });
  done.push({ label: "Nota guardada en el prospecto", url: leadUrl });
  if (discard) await pd.updateLead(s.leadId, { is_archived: true }).then(() => done.push({ label: "Prospecto archivado" })).catch(() => {});
  let doneActId = null;
  if (p.completeActivityId) await pd.updateActivity(Number(p.completeActivityId), { done: true }).then(() => { doneActId = Number(p.completeActivityId); done.push({ label: "Actividad pendiente marcada como hecha" }); }, () => done.push({ label: "No pude marcar la actividad como hecha: hacelo desde la agenda.", warn: true }));
  addTouch({ schoolId: id, by: user.email, byName: signer(user), outcome: o.id, channel, connected: o.connected, text: raw.slice(0, 300), demo: false, ...(ask ? { ask } : {}), ...(doneActId ? { doneActId } : {}) });
  return { ok: true, done, orgUrl: leadUrl, dealUrl: null, school: schoolSummary(s), next: nextRec, demo: null, ...whereOf({ lead: { id: s.leadId, title: leadTitleOf(s), url: leadUrl } }) };
}

// ---------- comentario y/o tarea para más adelante (para quien registra o para otra persona del equipo), sin registrar un
// contacto. server.js valida el texto, la tarea y su dueño (owner: usuario de Pipedrive) y si la de la agenda sigue (doneId).
// Sin trato abierto van a un PROSPECTO (el abierto tuyo o libre, o uno nuevo a tu nombre: workLead) con su organización y
// su persona; con trato abierto, al trato; prospecto u organización de otra persona, o cliente: a la organización.
export async function commentSchool(id, user, { text = "", task = null, owner = null, doneId = null, gone = false, by = "" } = {}, tz = "UTC") {
  const s = byId.get(id); if (!s) throw bad("Colegio inexistente", 404);
  const sign = signer(user);
  const pre = await settleExisting(id, user);
  const rec = s.leadOnly ? null : await ensureOrg(id, user.pdUserId);
  const done = [...pre.done], warns = [...pre.warnings];
  const leadR = !s.leadOnly && !rec.openDealId ? await workLead(id, rec, user, done, warns) : null, leadT = leadR?.id || null;
  if (rec?.created) done.unshift({ label: "Organización creada en Pipedrive a tu nombre", url: `${pd.PD_WEB}/organization/${rec.orgId}` });
  const target = s.leadOnly ? { leadId: s.leadId } : leadT ? { orgId: rec.orgId, leadId: leadT, personId: leadR.personId || undefined } : { orgId: rec.orgId, dealId: rec.openDealId || undefined };
  const url = s.leadOnly || leadT ? leadUrlOf(s.leadOnly ? s.leadId : leadT) : rec.openDealId ? `${pd.PD_WEB}/deal/${rec.openDealId}` : `${pd.PD_WEB}/organization/${rec.orgId}`;
  if (task) {
    const u = toUtc(task.date, task.time, tz);
    await pd.addActivity({ subject: String(task.subject || "").trim().slice(0, 140) || `${TYPE_LABEL[task.type]} · ${s.name}`, type: task.type, dueDate: u.date, dueTime: u.time, ...target, ownerId: owner?.id || user.pdUserId, note: text ? esc(text).slice(0, 1000) : "" });
    done.push({ label: `${TYPE_LABEL[task.type]} el ${task.date.slice(8, 10)}/${task.date.slice(5, 7)}${task.time ? " a las " + task.time : ""} para ${owner && owner.id !== user.pdUserId ? owner.name : "vos"}`, url });
  }
  const taskLine = task ? `<br><b>Tarea:</b> ${esc(TYPE_LABEL[task.type])} el ${esc(task.date)}${task.time ? " " + esc(task.time) : ""} para ${esc(owner?.name || sign)}` : "";
  const noteHtml = `<b>Comentario</b>${text ? "<br>" + esc(text).replace(/\n/g, "<br>") : ""}${taskLine}<br><br><i>Cargado por ${esc(sign)} desde OrderBrain SDR</i>`;
  // en el prospecto y su organización; si Pipedrive no acepta las dos juntas, en el prospecto
  await pd.addNote({ content: noteHtml, ...target }).catch(e => { if (!leadT) throw e; return pd.addNote({ content: noteHtml, leadId: leadT }); });
  done.push({ label: s.leadOnly || leadT ? "Comentario en el prospecto" : rec.openDealId ? "Comentario en el trato" : "Comentario en la organización", url });
  if (doneId) await pd.updateActivity(doneId, { done: true }).then(() => done.push({ label: "Actividad pendiente marcada como hecha" }), () => done.push({ label: "No pude marcar la actividad como hecha: hacelo desde la agenda.", warn: true }));
  if (gone) done.push({ label: "La actividad ya no está en Pipedrive.", warn: true });
  // se trabajó con esta organización (como al registrar un contacto); un prospecto nuevo se completa con los datos del colegio
  if (rec) await markWorked(id, rec).catch(() => {});
  if (leadR?.created) await enrichNewLead(id, user, done, by);
  for (const w of warns) done.push({ label: w, warn: true });
  return { done, school: schoolSummary(s), orgUrl: url, ...(s.leadOnly ? whereOf({ lead: { id: s.leadId, title: leadTitleOf(s), url } }) : whereOf({ lead: leadR, dealId: rec.openDealId || null, orgId: rec.orgId, orgName: rec.orgName })) };
}

// ---------- crear prospecto: «lo voy a contactar». Crea (si falta) la organización y el prospecto en Pipedrive a
// nombre de quien lo pide, y busca a quién contactar: la web del colegio (teléfonos, WhatsApp, mails) y, si hay
// estudio con IA, los decisores con nombre y cargo. No inventa nada: lo que no encuentra, no lo carga.
// Los campos del formulario «Añadir prospecto» de Pipedrive, con los mismos formatos que usa la cuenta:
// listas = número de opción; selección múltiple = números separados por comas; usuario = id; texto y dirección = texto.
export async function leadFields(s, user, found = {}) {
  const F = DEAL_FIELDS, f = {};
  const ciudad = await pd.optionFor(F.ciudad, s.city).catch(() => null); if (ciudad) f[F.ciudad] = ciudad;
  if (s.state) { const est = await pd.optionFor(F.estado, s.state).catch(() => null); if (est) f[F.estado] = est; }
  if (OPTIONS.pais[s.country]) f[F.pais] = OPTIONS.pais[s.country];
  f[F.fuente] = String(OPTIONS.fuente.coldCalling);
  if (user.pdUserId) f[F.sdr] = user.pdUserId;
  const phone = s.phone || found.phones?.[0], email = s.email || found.emails?.[0];
  if (phone) f[F.telefono] = phone;
  if (email) f[F.email] = email;
  if (s.web) f[F.web] = s.web;
  const addr = [s.addr, s.city, s.country].filter(Boolean).join(", "); if (s.addr) f[F.direccion] = addr;
  const niv = (s.levels || []).map(n => OPTIONS.niveles[n]).filter(Boolean); if (niv.length) f[F.niveles] = niv.join(",");
  return f;
}
// task: la primera tarea a futuro (siempre conviene dejar una): { type, date, time, ownerId, subject }
const PHONE_RE = /\d/g, okPhone = p => (String(p || "").match(PHONE_RE) || []).length >= 8 && !/sin datos|estimad|no identific/i.test(p);
const okEmail = e => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(String(e || "").trim());
const okName = n => n && !/sin datos|estimad|no identific|desconocid|n\/a/i.test(n);
export async function createProspect(id, user, task = null, tz = "America/Montevideo") {
  const s = byId.get(id);
  if (!s || (s.leadOnly && s.virtual)) throw bad("Colegio inexistente", 404);
  if (!user.pdUserId) throw bad("Tu email no coincide con ningún usuario de Pipedrive: pedí que te den de alta.", 403);
  if (task && (!TYPE_LABEL[task.type] || !/^\d{4}-\d{2}-\d{2}$/.test(task.date || "") || (task.time && !/^\d{2}:\d{2}$/.test(task.time)))) throw bad("Revisá la tarea: tipo, día y hora.");
  return withLock("prospect:" + id, async () => {
    // estado al día (no el de hace una semana): si es de otro, cliente, ex cliente o tiene trato abierto, no se crea
    const cur = await checkSchool(id, { force: true });
    const eff = effMatch(s) || cur;
    if (cur.ownerId && cur.ownerId !== user.pdUserId) throw bad(`La organización es de ${cur.ownerName || "otra persona"} en Pipedrive. Hablalo con esa persona.`, 409);
    if (eff.status === "client") throw bad("Ya es cliente de OrderEAT. No se prospecta.", 409);
    if (eff.status === "churn") throw bad("Es ex cliente de OrderEAT: antes de contactar, hablá con el equipo de cuentas.", 409);
    if (eff.status === "open") throw bad(`Ya tiene un trato abierto${cur.openDealOwner ? ` de ${cur.openDealOwner}` : ""}.`, 409);
    if (eff.status === "archived") throw bad("Está archivado: desarchivalo para prospectarlo.", 409);
    // ¿ya está en Pipedrive? Si ya tiene un prospecto (sin organización), es ese: no se crea otro
    const pre = await settleExisting(id, user);
    if (s.leadOnly) {
      const url = leadUrlOf(s.leadId), title = getMatch(id)?.leadTitle || s.name;
      return { ok: true, done: [...pre.done.filter(d => !/^Ya estaba en Pipedrive/.test(d.label)), { label: `Ya tenía un prospecto en Pipedrive: «${title}». No creé otro.`, url }, ...pre.warnings.map(label => ({ label, warn: true }))],
        warnings: pre.warnings, leadUrl: url, orgUrl: url, found: {}, school: schoolSummary(s), created: false, existing: true, lead: { id: s.leadId, title, ownerId: user.pdUserId, url, created: false } };
    }
    const rec = await ensureOrg(id, user.pdUserId);
    if (rec.ownerId && rec.ownerId !== user.pdUserId) throw bad(`La organización es de ${rec.ownerName || "otra persona"} en Pipedrive. Hablalo con esa persona.`, 409);
    const orgUrl = `${pd.PD_WEB}/organization/${rec.orgId}`;
    const done = [...pre.done, { label: rec.created ? "Organización creada en Pipedrive" : `Organización: ${rec.orgName}`, url: orgUrl }], warnings = [...pre.warnings];
    // ¿ya hay un prospecto abierto? se reusa si es tuyo (sin duplicar persona ni nota); si es de otro, no se crea
    const open = await leadsHere(s, rec.orgId).catch(e => { throw bad(`No pude revisar los prospectos de Pipedrive (${e.message}). Probá de nuevo.`, 502); });
    if (open.find(l => l.ownerId && l.ownerId !== user.pdUserId)) throw bad("Ya hay un prospecto abierto de otra persona para este colegio.", 409);
    let lead = open.find(l => !l.ownerId || l.ownerId === user.pdUserId);
    // lo que estaba a nombre de la cuenta general de la empresa pasa a tu nombre: así nadie más lo toma a la vez
    if (!rec.created && !rec.ownerId && rec.confirmed) { await pd.updateOrganization(rec.orgId, { owner_id: user.pdUserId }); setMatch(id, { ...getMatch(id), ownerId: user.pdUserId, ownerName: signer(user) }); done.push({ label: "La organización pasó a tu nombre (estaba en la cuenta general)" }); }
    if (lead && !lead.ownerId && (rec.confirmed || rec.created)) { await pd.updateLead(lead.id, { owner_id: user.pdUserId }); lead.ownerId = user.pdUserId; done.push({ label: "El prospecto pasó a tu nombre (estaba en la cuenta general)" }); }
    const found = { phones: [], emails: [], whatsapp: "", decisores: [] };
    let personId = lead?.personId || null;
    if (!lead) {
      // a quién contactar: la web del colegio y, si hay estudio con IA, los decisores (sin «sin datos» ni estimaciones)
      if (okPhone(s.phone)) found.phones.push(s.phone);
      if (okEmail(s.email)) found.emails.push(s.email);
      if (s.web) {
        try { const { webInfo } = await import("./enrich.js"); const w = await webInfo(s.web); if (okPhone(w.phone)) found.phones.push(w.phone); if (okEmail(w.email)) found.emails.push(w.email); if (/^\+\d{8,15}$/.test(w.whatsapp || "")) found.whatsapp = w.whatsapp; } catch {}
      }
      const { getStudy } = await import("./store.js");
      const st = await getStudy(id).catch(() => null);
      if (st) {
        found.decisores = (st.decisores || []).filter(d => okName(d.nombre)).map(d => ({ ...d, cargo: okName(d.cargo) ? d.cargo : "" })).slice(0, 3);
        found.phones.push(...(st.contacto?.telefonos || []).filter(okPhone)); found.emails.push(...(st.contacto?.emails || []).filter(okEmail));
        if (!found.whatsapp && /^\+?\d{8,15}$/.test(String(st.contacto?.whatsapp || "").replace(/[\s-]/g, ""))) found.whatsapp = st.contacto.whatsapp;
      }
      found.phones = [...new Set(found.phones)].slice(0, 4); found.emails = [...new Set(found.emails.map(e => e.trim().toLowerCase()))].slice(0, 4);
      // persona: solo el decisor con nombre real. Los teléfonos y mails del colegio quedan en la nota y en el prospecto.
      const d0 = found.decisores[0];
      if (d0) {
        const person = await pd.addPerson({ name: personLabel(d0.nombre, d0.cargo), orgId: rec.orgId, ownerId: user.pdUserId }).catch(() => null);
        if (person?.id) { personId = person.id; done.push({ label: `Contacto: ${personLabel(d0.nombre, d0.cargo)}`, url: `${pd.PD_WEB}/person/${person.id}` }); }
      }
      lead = await newLead(id, rec, user, { personId, found });
      if (!OPTIONS.pais[s.country]) warnings.push(s.country ? paisWarn(s.country) : "No supe el país del colegio: el campo País quedó sin completar.");
      const rows = [
        found.decisores.length ? `<b>Decisores:</b><br>${found.decisores.map(d => `• ${esc(personLabel(d.nombre, d.cargo))}${d.fuente ? ` · ${esc(d.fuente)}` : ""}`).join("<br>")}` : "<b>Decisor:</b> todavía sin nombre. Preguntá en recepción quién maneja la cafetería.",
        found.phones.length ? `<b>Teléfonos:</b> ${found.phones.map(esc).join(" · ")}` : "", found.whatsapp ? `<b>WhatsApp:</b> ${esc(found.whatsapp)}` : "",
        found.emails.length ? `<b>Mails:</b> ${found.emails.map(esc).join(" · ")}` : "", s.web ? `<b>Web:</b> ${esc(s.web)}` : "",
      ].filter(Boolean);
      // en el prospecto (y su organización); si Pipedrive no acepta las dos juntas, en el prospecto
      const html = `<b>Prospecto creado desde OrderBrain SDR</b> por ${esc(signer(user))}<br>${rows.join("<br>")}`;
      await pd.addNote({ content: html, orgId: rec.orgId, leadId: lead.id, personId }).catch(() => pd.addNote({ content: html, leadId: lead.id })).catch(() => {});
    }
    const leadUrl = `${pd.PD_WEB}/leads/inbox/${lead.id}`;
    done.push({ label: open.length ? "Prospecto ya existente (tuyo)" : "Prospecto creado a tu nombre", url: leadUrl });
    // la primera tarea a futuro, atada al prospecto (le aparece a quien la tenga en su agenda)
    if (task) {
      const m = await pd.meta(), owner = task.ownerId ? m.users.find(u => u.id === Number(task.ownerId)) : null;
      const u = toUtc(task.date, task.time, tz);
      await pd.addActivity({ subject: String(task.subject || "").trim().slice(0, 140) || `${TYPE_LABEL[task.type]} · ${s.name}`, type: task.type, dueDate: u.date, dueTime: u.time, orgId: rec.orgId, leadId: lead.id, personId, ownerId: owner?.id || user.pdUserId });
      done.push({ label: `${TYPE_LABEL[task.type]} el ${nice(task.date)}${task.time ? " a las " + task.time : ""} para ${owner && owner.id !== user.pdUserId ? owner.name : "vos"}`, url: leadUrl });
    }
    const fresh = await checkSchool(id, { force: true }).catch(() => getMatch(id));
    setMatch(id, { ...fresh, confirmed: true, auto: false, ownerId: fresh.ownerId || user.pdUserId, leadId: lead.id });
    done.push(...warnings.map(label => ({ label, warn: true })));
    return { ok: true, done, warnings, leadUrl, orgUrl, found, school: schoolSummary(s), created: !open.length, lead: { id: lead.id, title: lead.title || s.name, ownerId: user.pdUserId, url: leadUrl, created: !open.length } };
  }).then(async r => {
    // prospecto nuevo (o datos de «Enriquecer» que no se pudieron guardar porque todavía no estaba en Pipedrive): Enriquecer
    // completa los campos vacíos del prospecto y deja la nota de datos en él (con tope de tiempo)
    const e = r.created ? null : await getEnrich(id).catch(() => null);
    if (r.created || (e && !e.note?.saved)) { const n = r.done.length; await enrichNewLead(id, user, r.done, e?.by || ""); r.school = schoolSummary(byId.get(id)); if (r.done.length > n) r.enriched = true; }
    return r;
  });
}

// ---------- prospecto → trato desde la ficha: conversión de Pipedrive (pasan notas y actividades), en el embudo del país
export async function convertToDeal(id, user, { leader = false, country: chosen = "" } = {}) {
  const s = byId.get(id); if (!s) throw bad("Colegio inexistente", 404);
  return withLock("convert:" + id, async () => {
    const rec = getMatch(id) || {};
    if (rec.status === "open" && rec.openDealId) throw bad("Ya tiene un trato abierto.", 409);
    let lead = null;
    const lid = s.leadId || rec.leadId || null;
    if (lid) lead = (await pd.leadsByIds([lid], user.pdUserId).catch(() => []))[0] || null;
    if ((!lead || lead.archived) && rec.orgId) {
      const open = await leadsHere(s, rec.orgId).catch(e => { throw bad(`No pude revisar los prospectos en Pipedrive (${e.message}).`, 502); });
      lead = open.find(l => l.ownerId === user.pdUserId) || open.find(l => !l.ownerId) || open[0] || null;
    }
    if (!lead || lead.archived) throw bad("No encontré un prospecto abierto para convertir.", 404);
    if (lead.ownerId && lead.ownerId !== user.pdUserId && !canLead(leader, { id: lead.ownerId })) {
      const m = await pd.meta().catch(() => ({ users: [] }));
      throw bad(`El prospecto es de ${m.users.find(u => u.id === lead.ownerId)?.name || "otra persona"} en Pipedrive: hablalo con esa persona.`, 403);
    }
    const country = s.country || countryFromOpt(lead.paisOpt) || (MARKETS[chosen] ? chosen : "") || phoneCountry(s.phone, lead.phone);
    const mk = market(country), done = [];
    // un colegio de la base cuyo prospecto no tiene organización: primero la organización (a tu nombre), así el trato la lleva
    let newOrg = null;
    if (s.leadVia && !lead.orgId && !rec.orgId && user.pdUserId) {
      newOrg = await pd.createOrganization({ name: s.name, website: s.web, ownerId: user.pdUserId, address: { value: [s.addr, s.city, s.country].filter(Boolean).join(", "), locality: s.city, country: s.country } });
      await pd.updateLead(lead.id, { organization_id: newOrg.id });
      done.push({ label: "Organización creada en Pipedrive a tu nombre", url: `${pd.PD_WEB}/organization/${newOrg.id}` });
    }
    const { dealId } = await pd.convertLead(lead.id, { stageId: mk.stage });
    const url = `${pd.PD_WEB}/deal/${dealId}`;
    done.push({ label: `Trato abierto en el embudo ${MARKETS[country] ? country : "LatAm"}`, url });
    if (!MARKETS[country]) done.push({ label: "No supe el país: el trato quedó en el embudo LatAm. Revisalo en Pipedrive.", warn: true });
    done.push({ label: "Las notas y actividades del prospecto pasaron al trato" });
    const orgId = lead.orgId || rec.orgId || newOrg?.id || null;
    if (s.leadOnly && orgId) { s.leadOnly = false; s.pdOrgId = orgId; }
    if (orgId) await checkSchool(id, { org: { id: orgId, name: rec.orgName || newOrg?.name || s.name, ownerId: lead.ownerId || user.pdUserId } }).catch(() => null);
    leadView(s);
    const cur = getMatch(id) || {};
    if (cur.status !== "open") setMatch(id, { ...cur, status: "open", detail: "Trato abierto (desde el prospecto)", openDealId: dealId, openDealOwnerId: lead.ownerId || user.pdUserId, openDealOwner: signer(user), confirmed: true, auto: false });
    setMatch(id, { ...getMatch(id), leadId: null });
    return { ok: true, dealId, url, done, school: schoolSummary(s) };
  });
}

// ---------- tratos desde la ficha: propuesta enviada, otra etapa de su embudo, ganado o perdido (solo tratos abiertos).
// El dueño del trato (o un líder) lo controla server.js antes de llamar; acá se valida la etapa y queda una nota en el trato.
// Solo tratos de venta de la organización del colegio: los de clientes y los de otra organización no.
export async function dealAction(id, deal, user, b = {}) {
  const s = byId.get(id), orgId = s && !s.leadOnly ? getMatch(id)?.orgId : null;
  if (!orgId || Number(deal.org_id) !== Number(orgId)) throw bad("Ese trato no es de la organización de este colegio.");
  if (CLIENT_PIPES.includes(Number(deal.pipeline_id))) throw bad("Ese trato es de clientes: cambialo en Pipedrive.", 409);
  if (deal.status !== "open") throw bad("Ese trato ya está cerrado en Pipedrive.", 409);
  const m = await pd.meta(), from = m.stages[deal.stage_id] || "", stages = pd.pipeStages(m, deal.pipeline_id), at = sid => stages.findIndex(x => x.id === sid);
  let body, label;
  if (b.action === "stage" || b.action === "proposal") {
    const st = b.action === "proposal" ? stages.find(x => x.id === pd.proposalStage(m, deal.pipeline_id)) : stages.find(x => x.id === Number(b.stageId));
    if (!st) throw bad(b.action === "proposal" ? "Ese embudo no tiene etapa de propuesta enviada." : "Esa etapa no es del embudo del trato.");
    if (st.id === deal.stage_id) throw bad(`El trato ya está en ${st.name}.`, 409);
    // «Propuesta enviada» solo avanza: si el trato ya pasó esa etapa, no lo manda para atrás
    if (b.action === "proposal" && at(deal.stage_id) > at(st.id)) throw bad(`El trato ya está en ${from || "una etapa posterior"}, después de ${st.name}.`, 409);
    body = { stage_id: st.id }; label = at(st.id) < at(deal.stage_id) ? `Volvió a ${st.name}` : `Pasó a ${st.name}`;
  } else if (b.action === "won") { body = { status: "won" }; label = "Ganado"; }
  else if (b.action === "lost") {
    if (!LOST_REASONS.includes(b.reason)) throw bad("Elegí el motivo de pérdida.");
    body = { status: "lost", lost_reason: b.reason }; label = `Perdido: ${b.reason.replace(/\s+/g, " ")}`;
  } else throw bad("Acción inválida.");
  await pd.updateDeal(deal.id, body);
  const url = `${pd.PD_WEB}/deal/${deal.id}`, done = [{ label: `${deal.title || "Trato"} · ${label}`, url }];
  await pd.addNote({ content: `<b>${esc(label)}</b>${from ? `<br>Estaba en ${esc(from)}` : ""}<br><br><i>Cambiado por ${esc(signer(user))} desde OrderBrain SDR</i>`, dealId: deal.id, orgId: deal.org_id || undefined })
    .then(() => done.push({ label: "Nota en el trato" }), () => done.push({ label: "No pude dejar la nota en el trato.", warn: true }));
  await checkSchool(id, { force: true }).catch(() => {});
  return { ok: true, done, school: schoolSummary(s) };
}

// ---------- archivar en la app (lib/archive.js). En Pipedrive solo lo tuyo o lo libre: el prospecto abierto se archiva
// con una nota y la organización lleva la nota. Lo de otra persona no se toca (se avisa). by: nombre del perfil.
const archNote = (title, a, by) => `<b>${esc(title)}</b><br>Motivo: ${esc(a.reason)}${a.text ? `<br>Caso: ${esc(a.text).replace(/\n/g, "<br>")}` : ""}<br><br><i>${esc(by)} desde OrderBrain SDR</i>`;
export async function archiveSchool(id, user, { leader = false, by = "", reason, text = "" } = {}) {
  const s = byId.get(id); if (!s) throw bad("Colegio inexistente", 404);
  text = String(text || "").replace(/\s+/g, " ").trim().slice(0, 500);
  return withLock("archive:" + id, async () => {
    const was = await refreshArchived(id);
    const cur = s.leadOnly ? getMatch(id) || {} : await checkSchool(id).catch(() => getMatch(id) || {});
    const eff = effMatch(s) || cur;
    const err = archiveError({ status: eff.status, dealOwner: cur.openDealOwnerId, me: user.pdUserId, leader, archived: !!was, reason, text });
    if (err) throw bad(err.msg, err.status);
    const pdErr = e => bad(`No pude revisar Pipedrive (${e.message}). Probá de nuevo.`, 502);
    const orgId = s.leadOnly ? null : cur.orgId || null;
    const leads = s.leadOnly ? await pd.leadsByIds([s.leadId], user.pdUserId).catch(e => { throw pdErr(e); }) : orgId ? await leadsHere(s, orgId).catch(e => { throw pdErr(e); }) : [];
    // de un prospecto sin organización hay que saber de quién es (si no, solo un líder lo archiva)
    if (s.leadOnly && !leads.length && leader !== true) throw bad("No pude revisar el prospecto en Pipedrive. Probá de nuevo.", 502);
    const org = orgId ? (await pd.orgsByIds([orgId]).catch(e => { throw pdErr(e); }))[0] || null : null;
    const plan = archivePlan({ leads, org, me: user.pdUserId, ownerId: s.leadOnly ? null : cur.ownerId }), a = { reason, text }, done = [], leadIds = [];
    const m = plan.otherOwner ? await pd.meta().catch(() => ({ users: [] })) : null, uname = uid => m?.users.find(u => u.id === uid)?.name || "otra persona";
    // lo de otra persona (organización o prospecto) solo lo archiva un líder (de un equipo: si es de su gente): el archivo vale para todo el equipo
    const blocked = plan.otherOwners.find(o => !canLead(leader, { id: o })) || null;
    const err2 = archiveError({ status: eff.status, dealOwner: cur.openDealOwnerId, me: user.pdUserId, leader, othersOwner: blocked && uname(blocked), othersId: blocked, reason, text });
    if (err2) throw bad(err2.msg, err2.status);
    for (const l of plan.archive) {
      try {
        await pd.updateLead(l.id, { is_archived: true }); leadIds.push(l.id);
        done.push({ label: "Prospecto archivado en Pipedrive", url: `${pd.PD_WEB}/leads/inbox/${l.id}` });
        await pd.addNote({ content: archNote("Archivado", a, `Archivado por ${by || signer(user)}`), leadId: l.id }).then(() => done.push({ label: "Nota en el prospecto" }), () => done.push({ label: "No pude dejar la nota en el prospecto.", warn: true }));
      } catch (e) { done.push({ label: `No pude archivar el prospecto en Pipedrive (${e.message}).`, warn: true }); }
    }
    for (const l of plan.others) done.push({ label: `El prospecto es de ${uname(l.ownerId)}: en Pipedrive no se tocó, quedó archivado solo en la app.`, warn: true });
    if (plan.orgNote) await pd.addNote({ content: archNote("Archivado", a, `Archivado por ${by || signer(user)}`), orgId: org.id })
      .then(() => done.push({ label: "Nota en la organización", url: `${pd.PD_WEB}/organization/${org.id}` }), () => done.push({ label: "No pude dejar la nota en la organización.", warn: true }));
    else if (plan.orgOthers) done.push({ label: `La organización es de ${uname(org.ownerId)}: no le dejé nota, quedó archivado solo en la app.`, warn: true });
    const rec = await setArchived(id, { by: String(user.email || "").toLowerCase(), byName: by || signer(user), at: new Date().toISOString(), reason, text, leadIds, orgId: plan.orgNote ? org.id : null });
    done.unshift({ label: `Archivado: ${reason}` });
    return { ok: true, done, archive: rec, school: schoolSummary(s) };
  });
}
export async function unarchiveSchool(id, user, { leader = false, by = "" } = {}) {
  const s = byId.get(id); if (!s) throw bad("Colegio inexistente", 404);
  return withLock("archive:" + id, async () => {
    const rec = await refreshArchived(id);
    if (!rec) throw bad("No está archivado.", 409);
    // también lo desarchiva quien lo tiene hoy en Pipedrive (la organización o el prospecto son suyos)
    const me = user.pdUserId, owner = leader === true || canUnarchive(rec, user.email, leader) || !me ? false : s.leadOnly ? (await pd.leadsByIds([s.leadId], me).catch(() => []))[0]?.ownerId === me
      : await checkSchool(id).catch(() => getMatch(id) || {}).then(async c => Number(c?.ownerId) === me || (!!c?.orgId && (await leadsHere(s, c.orgId).catch(() => [])).some(l => l.ownerId === me)));
    if (!canUnarchive(rec, user.email, leader, owner)) throw bad(`Lo archivó ${rec.byName || "otra persona"}: lo desarchiva esa persona, quien lo tiene en Pipedrive o un líder.`, 403);
    const done = [], who = `Desarchivado por ${by || signer(user)}`;
    for (const lid of rec.leadIds || []) {
      try {
        await pd.updateLead(lid, { is_archived: false });
        done.push({ label: "Prospecto desarchivado en Pipedrive", url: `${pd.PD_WEB}/leads/inbox/${lid}` });
        await pd.addNote({ content: archNote(`Desarchivado (lo había archivado ${rec.byName || "otra persona"})`, rec, who), leadId: lid }).then(() => done.push({ label: "Nota en el prospecto" }), () => done.push({ label: "No pude dejar la nota en el prospecto.", warn: true }));
      } catch (e) { done.push({ label: `No pude desarchivar el prospecto en Pipedrive (${e.message}): hacelo desde Pipedrive.`, warn: true }); }
    }
    // la organización que llevó la nota de archivado lleva la de desarchivado (si sigue siendo tuya o libre)
    if (rec.orgId) {
      const o = (await pd.orgsByIds([rec.orgId]).catch(() => []))[0];
      if (o && archivePlan({ org: o, me: user.pdUserId }).orgNote) await pd.addNote({ content: archNote(`Desarchivado (lo había archivado ${rec.byName || "otra persona"})`, rec, who), orgId: o.id }).then(() => done.push({ label: "Nota en la organización", url: `${pd.PD_WEB}/organization/${o.id}` }), () => done.push({ label: "No pude dejar la nota en la organización.", warn: true }));
    }
    await setArchived(id, null);
    done.unshift({ label: "Desarchivado" });
    return { ok: true, done, school: schoolSummary(s) };
  });
}

// ---------- agregar un decisor desde la ficha: persona en la organización del colegio (o en el prospecto si no tiene
// organización), a nombre de quien la carga. En lo ajeno no (salvo un líder).
export async function addDecisor(id, user, leader, c = {}) {
  const s = byId.get(id); if (!s) throw bad("Colegio inexistente", 404);
  const clean = (v, n) => String(v || "").replace(/\s+/g, " ").trim().slice(0, n);
  const name = clean(c.name, 80), role = clean(c.role, 60), phone = clean(c.phone, 40), email = clean(c.email, 120).toLowerCase();
  if (!name || !okName(name)) throw bad("Escribí el nombre del decisor.");
  if (phone && !okPhone(phone)) throw bad("Revisá el teléfono: tiene que tener al menos 8 dígitos.");
  if (email && !okEmail(email)) throw bad("Revisá el mail.");
  if (!user.pdUserId) throw bad("Tu usuario no está vinculado a Pipedrive: no puedo crear el contacto a tu nombre.", 403);
  const pre = await settleExisting(id, user);
  const label = personLabel(name, role), done = [...pre.done];
  if (s.leadOnly) {
    const lead = (await pd.leadsByIds([s.leadId], user.pdUserId))[0];
    if (!lead) throw bad("No encontré el prospecto en Pipedrive.", 404);
    if (lead.ownerId && lead.ownerId !== user.pdUserId && !canLead(leader, { id: lead.ownerId })) throw bad("Ese prospecto es de otra persona en Pipedrive: no le podés agregar contactos.", 403);
    const p = await pd.addPerson({ name: label, phone, email, ownerId: user.pdUserId });
    const url = `${pd.PD_WEB}/person/${p.id}`;
    done.push({ label: `Contacto ${name}`, url });
    // el prospecto tiene una sola persona: si ya tenía, el decisor queda anotado en el prospecto
    if (!s.personId) { await pd.updateLead(s.leadId, { person_id: p.id }); s.personId = p.id; s.personName = label; done.push({ label: "Vinculado al prospecto" }); }
    else { await pd.addNote({ content: `<b>Decisor</b><br>${esc(contactLine({ name, role, phone, email }))}<br><a href="${url}">Ver contacto</a><br><br><i>Cargado por ${esc(signer(user))} desde OrderBrain SDR</i>`, leadId: s.leadId }); done.push({ label: "Anotado en el prospecto (ya tenía un contacto)" }); }
    return { ok: true, done, person: { id: p.id, name: label, phone, email } };
  }
  // sin organización todavía: se crea a tu nombre (como al registrar o comentar)
  const rec = await ensureOrg(id, user.pdUserId);
  if (rec.ownerId && rec.ownerId !== user.pdUserId && !canLead(leader, { id: rec.ownerId })) throw bad(`La organización es de ${rec.ownerName || "otra persona"} en Pipedrive: no le podés agregar contactos.`, 403);
  if (rec.created) done.push({ label: "Organización creada a tu nombre", url: `${pd.PD_WEB}/organization/${rec.orgId}` });
  const p = await pd.addPerson({ name: label, orgId: rec.orgId, phone, email, ownerId: user.pdUserId });
  done.push({ label: `Contacto ${name} en ${rec.orgName || s.name}`, url: `${pd.PD_WEB}/person/${p.id}` });
  return { ok: true, done, person: { id: p.id, name: label, phone, email }, school: schoolSummary(s) };
}

// ---------- agenda propia
// Evento entre paréntesis al final del título: «Colegio Magna – MZA (EduExperience Mendoza 2026)» → «EduExperience Mendoza 2026».
// Solo si lleva un año, para no confundirlo con una ciudad entre paréntesis.
export const eventOf = t => { const s = String(t || "").trim(); return (s.match(/\(([^()]*\b20\d\d\b[^()]*)\)\s*$/) || s.match(/\s[–—-]\s*([^–—()]*\b20\d\d\b[^–—()]*)$/))?.[1].trim() || ""; };
// El nombre de la institución sin el evento del prospecto: «Colegio X (EduExperience Mendoza 2026)» → «Colegio X»
export const withoutEvent = t => { const e = eventOf(t); return e ? String(t).replace(/\s*\([^()]*\)\s*$/, m => m.includes(e) ? "" : m).replace(new RegExp(`\\s[–—-]\\s*${e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), "").trim() || t : t; };
// ¿archivado en la app? El colegio de la base o la ficha de Pipedrive (pd-lead-…/pd-org-…; un prospecto con organización
// se archiva como su organización). Lo usan la agenda (sesiones y bandeja caliente) y la bandeja de prospectos nuevos.
export const archivedRef = ({ schoolId = null, leadId = null, orgId = null }) => !!((schoolId && getArchived(schoolId)) || (leadId && getArchived(`pd-lead-${leadId}`)) || (orgId && getArchived(`pd-org-${orgId}`)));
export async function myActivities(user) {
  if (!user.pdUserId) return { warning: "Tu email no coincide con ningún usuario de Pipedrive.", items: [] };
  const list = await pd.activities({ ownerId: user.pdUserId, done: false, limit: 500 });
  const o2s = orgToSchool();
  // Actividades sin organización: muchas están atadas a un prospecto (lead) o a una persona. Se trae su nombre
  // (y la organización del prospecto, si tiene) para que se sepa de quién es cada una.
  // (los prospectos se traen todos: su título dice el evento, «… (EduExperience Mendoza 2026)», y sus campos la ciudad)
  const leads = new Map((await pd.leadsByIds([...new Set([...list.filter(a => !a.org_id && a.lead_id), ...list.filter(a => a.org_id && a.lead_id)].map(a => a.lead_id))], user.pdUserId).catch(() => [])).map(l => [l.id, l]));
  await pd.loadFieldOptions().catch(() => {});
  const persons = new Map((await pd.personsByIds([...new Set(list.filter(a => !a.org_id && a.person_id).map(a => a.person_id))]).catch(() => [])).map(p => [p.id, p]));
  const orgOf = a => a.org_id || leads.get(a.lead_id)?.orgId || persons.get(a.person_id)?.orgId || null;
  // Organizaciones que todavía no se cruzaron: se buscan por nombre exacto en la base de colegios.
  const unknown = [...new Set(list.map(orgOf).filter(id => id && !o2s.has(id)))];
  const orgName = new Map(), orgPlace = new Map();
  if (unknown.length) {
    const byName = new Map(schools.map(s => [pd.norm(s.name), s.id]));
    for (const o of await pd.orgsByIds(unknown).catch(() => [])) { orgName.set(o.id, o.name); orgPlace.set(o.id, o); const sid = byName.get(pd.norm(o.name)); if (sid) o2s.set(o.id, sid); }
  }
  const strip = h => String(h || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
  return { items: list.map(a => {
    const org = orgOf(a), lead = leads.get(a.lead_id), person = persons.get(a.person_id);
    // zona y evento, solo con lo que dicen Pipedrive y la base (no se deduce nada más)
    const sch = byId.get(o2s.get(org)), op = orgPlace.get(org), opt = (k, id) => id ? pd.optionLabel(DEAL_FIELDS[k], id) || "" : "";
    const zone = { city: sch?.city || opt("ciudad", lead?.ciudadOpt) || op?.city || "", region: opt("estado", lead?.estadoOpt) || op?.region || "",
      country: sch?.country || countryFromOpt(lead?.paisOpt) || appCountry(op?.country) || "", event: eventOf(lead?.title) || eventOf(a.subject) };
    const who = lead?.title || orgName.get(org) || person?.name || "";
    const url = a.deal_id ? `${pd.PD_WEB}/deal/${a.deal_id}` : a.lead_id ? `${pd.PD_WEB}/leads/inbox/${a.lead_id}` : org ? `${pd.PD_WEB}/organization/${org}` : a.person_id ? `${pd.PD_WEB}/person/${a.person_id}` : `${pd.PD_WEB}/activities/list`;
    return { id: a.id, subject: a.subject, type: a.type, typeLabel: TYPE_LABEL[a.type] || a.type, date: a.due_date, time: a.due_time || "", orgId: org, dealId: a.deal_id, schoolId: o2s.get(org) || null,
      who: who && who !== a.subject ? who.slice(0, 80) : "", kind: lead ? "Prospecto" : person && !org ? "Persona" : "", note: strip(a.note).slice(0, 90), url,
      // para abrir la ficha en la app: el prospecto o la organización de Pipedrive
      record: o2s.get(org) ? null : a.lead_id ? `lead:${a.lead_id}` : org ? `org:${org}` : null, ...zone,
      ...(archivedRef({ schoolId: o2s.get(org), leadId: a.lead_id, orgId: org }) ? { archived: true } : {}) };
  }) };
}

// ---------- bandeja caliente de Hoy: prospectos nuevos para vos
// Tuyos, creados en los últimos `days` días, sin ninguna actividad hecha ni nota tuya, y que no creaste desde la app
// (mine: los que el cruce guarda como tuyos). Lo más nuevo primero.
export function freshLeads(leads, { me, done = new Set(), noted = new Set(), mine = new Set(), now = Date.now(), days = 7, archived = () => false } = {}) {
  const since = now - days * 864e5, at = l => Date.parse(l.addTime || "") || 0;
  return leads.filter(l => l && !l.archived && !archived(l) && me && l.ownerId === me && at(l) >= since && !done.has(l.id) && !noted.has(l.id) && !mine.has(l.id)).sort((a, b) => at(b) - at(a));
}
export async function newForMe(user, now = Date.now()) {
  const me = user.pdUserId; if (!me) return { items: [] };
  const since = new Date(now - 7 * 864e5).toISOString();
  const [leads, done, notes] = await Promise.all([pd.recentLeads(me), pd.activities({ ownerId: me, done: true, limit: 500, updatedSince: since.slice(0, 19) + "Z" }), pd.notesByUser(me, since.slice(0, 10))]);
  const ids = list => new Set(list.map(x => x.lead_id).filter(Boolean)), o2s = orgToSchool();
  const mine = new Set(Object.values(allMatches()).filter(m => m?.leadId && m.ownerId === me).map(m => m.leadId));
  // archivados en la app (el prospecto o su colegio): fuera de la bandeja
  const archived = l => archivedRef({ schoolId: o2s.get(l.orgId), leadId: l.id, orgId: l.orgId });
  return { items: freshLeads(leads, { me, done: ids(done), noted: ids(notes), mine, now, archived }).slice(0, 30).map(l => ({ id: l.id, title: withoutEvent(l.title).slice(0, 80), event: eventOf(l.title),
    addTime: l.addTime, assigned: l.creatorId !== me, schoolId: o2s.get(l.orgId) || null, record: `lead:${l.id}` })) };
}

// ---------- cola de hoy: a quién contactar ahora
// userId: la persona que pide la cola. No se proponen colegios cuya organización en Pipedrive es de otra persona.
// zone: «Puebla», «Pachuca»… se compara por palabras con la ciudad del colegio («Puebla de Zaragoza» entra en «Puebla») o con el país.
export function prospectQueue({ countries = [], limit = 40, excludeOrgIds = new Set(), userId = null, zone = "" } = {}) {
  // perfiles livianos para la cola
  const out = [], z = pd.norm(zone);
  for (const s of schools) {
    if (countries.length && !countries.includes(s.country)) continue;
    if (z && !` ${pd.norm(s.city)} `.includes(` ${z} `) && pd.norm(s.country) !== z) continue;
    const m = getMatch(s.id);
    if (m?.orgId && excludeOrgIds.has(m.orgId)) continue;
    if (isFresh(m) && m.ownerId && m.ownerId !== userId) continue;
    const r = withPotential(s, scoreSchool(s, effMatch(s), touchesFor(s.id)));
    if (r) out.push({ ...schoolListItem(s), score: r.score, reasons: r.reasons });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

// estado y cantidad de intentos (para elegir la plantilla de un mensaje)
export const stateOf = id => { const s = byId.get(id); return { status: (s && effMatch(s)?.status) || getMatch(id)?.status || "", attempts: countAttempts(touchesFor(id)) }; };
// el alto potencial suma a la prioridad (y lo dice), así se contacta antes que el resto
function withPotential(s, r) {
  if (!r) return r;
  const pot = potentialFor(s, effMatch(s)?.status);
  return pot ? { ...r, score: Math.min(100, r.score + 15), reasons: ["Alto potencial", ...r.reasons], pot } : r;
}
export const scoreFor = s => withPotential(s, scoreSchool(s, effMatch(s), touchesFor(s.id)));

// ---------- métricas propias y del equipo
export function stats(user, tz) {
  const today = todayIn(tz);
  const wk = Date.now() - 7 * 864e5;
  const week = touchesSince(wk);
  const mine = week.filter(t => t.by === user.email);
  const fmt = new Intl.DateTimeFormat("sv-SE", { timeZone: safeTz(tz) });
  const isToday = t => today === fmt.format(new Date(t.at));
  const mToday = mine.filter(isToday);
  return {
    today, goal: DAILY_GOAL,
    todayTouches: mToday.length, todayConnected: mToday.filter(t => t.connected).length, todayDemos: mToday.filter(t => t.demo).length,
    weekTouches: mine.length, weekConnected: mine.filter(t => t.connected).length, weekDemos: mine.filter(t => t.demo).length,
  };
}

// Feed del equipo: contactos registrados en la app + notas de Pipedrive cargadas desde OrderBrain.
// team: { ids, emails } de un equipo (lib/teams.js) o null (todos): con equipo, solo lo de su gente.
export async function teamFeed(team = null) {
  const local = touchesSince(Date.now() - 14 * 864e5).filter(t => !team || team.emails.has(String(t.by || "").toLowerCase())).slice(-40).reverse().map(t => ({ at: t.at, author: t.byName, org: byId.get(t.schoolId)?.name || "", schoolId: t.schoolId, title: outcomeById(t.outcome)?.label || "", channel: t.channel, demo: !!t.demo }));
  if (local.length >= 10) return local;
  const notes = await pd.recentNotes(80).catch(() => []);
  const o2s = orgToSchool();
  const remote = notes.filter(n => /OrderBrain SDR|desde el asistente/i.test(n.content || "") && (!team || team.ids.has(Number(n.user_id)) || team.emails.has(String(n.user?.email || "").toLowerCase()))).slice(0, 25).map(n => ({
    at: String(n.add_time).replace(" ", "T") + "Z", author: n.user?.name || "", org: n.organization?.name || "", schoolId: o2s.get(n.org_id) || null,
    title: (stripHtml(n.content).split("\n")[0] || "").split(" · ").pop() || "Nota",
  }));
  const seen = new Set(local.map(l => l.org + l.title));
  return [...local, ...remote.filter(r => !seen.has(r.org + r.title))].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 30);
}

// ---------- demos (lib/demos.js): resultado, lista del equipo y métricas para líderes
// Se piden a Pipedrive por persona (y por cada cuenta general), por vencimiento, hasta pasar el comienzo del período;
// se guardan 10 minutos. Marcar un resultado cambia la versión (demos:ver) y la próxima lectura trae lo nuevo.
const demoLoading = new Map(), DATE_RE = /^\d{4}-\d{2}-\d{2}$/, TIME_RE = /^\d{2}:\d{2}$/;
const subjName = s => String(s || "").split(" · ").slice(1).join(" · ").trim();
// el colegio de cada demo: de la base si está cruzado; si no, la organización o el prospecto de Pipedrive (para abrir su ficha).
// País: el del colegio o el de la dirección de la organización («» si no se sabe).
async function placeDemos(out) {
  const o2s = orgToSchool(), orgIds = [...new Set(out.map(a => a.org_id).filter(id => id && !o2s.has(id)))], orgs = new Map();
  for (let i = 0; i < orgIds.length; i += 100) for (const o of await pd.orgsByIds(orgIds.slice(i, i + 100)).catch(() => [])) orgs.set(o.id, o);
  const leads = new Map((await pd.leadsByIds([...new Set(out.filter(a => !a.org_id && a.lead_id).map(a => a.lead_id))].slice(0, 40)).catch(() => [])).map(l => [l.id, l]));
  return out.map(a => { const sid = o2s.get(a.org_id), sc = sid && byId.get(sid), o = orgs.get(a.org_id);
    return { ...a, schoolId: sc ? sid : null, record: sc ? null : a.org_id ? `org:${a.org_id}` : a.lead_id ? `lead:${a.lead_id}` : null,
      name: sc?.name || o?.name || leads.get(a.lead_id)?.title || subjName(a.subject) || "", country: sc?.country || appCountry(o?.country) || "" }; });
}
async function demosRaw(from, to) {
  const k = `demos:2:${(await cacheGet("demos:ver")) || 0}:${from}:${to}`, hit = await cacheGet(k); // 2: con las cuentas generales
  if (hit) return hit;
  if (!demoLoading.has(k)) demoLoading.set(k, (async () => {
    let partial = false; const out = [];
    // cada persona y también las cuentas generales (FREE_OWNERS): son dueñas de demos (entradas automáticas y otras)
    const owners = [...new Set([...(await pd.meta()).users.map(u => Number(u.id)), ...FREE_OWNERS].filter(Boolean))];
    const one = async id => { let cursor = null;
      for (let i = 0; ; i++) { if (i === 20) { partial = true; break; }
        const r = await pd.demoActsPage({ cursor, ownerId: id }); out.push(...r.items.filter(a => a.due_date >= from && a.due_date <= to));
        if (!r.next || (r.oldest && r.oldest < from)) break; cursor = r.next; } };
    for (let i = 0; i < owners.length; i += 4) await Promise.all(owners.slice(i, i + 4).map(one)); // de a 4 personas
    const r = { at: new Date().toISOString(), partial, demos: await placeDemos(out) };
    await cacheSet(k, r, 600); return r;
  })().finally(() => demoLoading.delete(k)));
  return demoLoading.get(k);
}
// Tarjeta «Demos» (todos): últimos 7 días y próximos 14, en la zona de quien mira, y las de hasta 30 días sin resultado
// (la misma lectura que las métricas de 30 días: un día de margen por las zonas horarias)
export async function teamDemos(tz, team = null) {
  const t = todayIn(tz), raw = await demosRaw(addDays(t, -31), addDays(t, 15));
  const [m, profiles] = await Promise.all([pd.meta(), getProfiles()]);
  return { ...demoBoard(raw.demos, { users: m.users, profiles, free: FREE_OWNERS, today: t, tz, team }), at: raw.at, partial: raw.partial };
}
// ---------- Métricas (vista Métricas): lecturas de Pipedrive guardadas 10 minutos; los cálculos son puros (lib/metrics.js).
// Cada resultado dice de cuándo es (at) y si Pipedrive cortó la lista (partial: el número se muestra «?»).
const mxLoading = new Map();
async function cached(k, ttl, fn) {
  const hit = await cacheGet(k); if (hit) return hit;
  if (!mxLoading.has(k)) mxLoading.set(k, (async () => { const v = await fn(); await cacheSet(k, v, ttl); return v; })().finally(() => mxLoading.delete(k)));
  return mxLoading.get(k);
}
const utcDay = v => (MX.isoUtc(v) || "").slice(0, 10);
// Embudos de venta (los de MARKETS) y su país: los de un solo país lo dicen; en LatAm, el campo País del trato.
export const SALES_PIPES = new Set(Object.values(MARKETS).map(m => Number(m.pipeline)));
const PIPE_COUNTRY = Object.fromEntries(Object.entries(Object.entries(MARKETS).reduce((acc, [c, mk]) => ((acc[mk.pipeline] ||= []).push(c), acc), {})).filter(([, l]) => l.length === 1).map(([p, [c]]) => [p, c]));
const PAIS = Object.fromEntries(Object.entries(OPTIONS.pais).map(([c, id]) => [id, c]));
const paisOf = d => { const v = d?.pais && typeof d.pais === "object" ? d.pais.id ?? d.pais.value : d?.pais; return PAIS[Number(v)] || ""; };
const PIPE_ORDER = [...Object.keys(PIPE_COUNTRY).map(Number).sort((a, b) => PIPE_COUNTRY[a].localeCompare(PIPE_COUNTRY[b], "es")), ...[...SALES_PIPES].filter(p => !PIPE_COUNTRY[p])];
function dealCtx(m) {
  const st = new Map((m.stageList || []).map(x => [Number(x.id), x]));
  return { sales: SALES_PIPES, pipeCountry: PIPE_COUNTRY, paisOf, pipeOrder: PIPE_ORDER, stageOf: id => st.get(Number(id)) || null, stagesOf: p => pd.pipeStages(m, p) };
}
const MX_PAGES = 80;
// A1: demos y No Show CREADAS desde fromDay (UTC). Índice en cache (id y fecha de creación) que se rehace entero cada 12 h; en el
// medio se suma lo cambiado o creado desde la última lectura (updated_since) y se releen por ids (las borradas ya no vienen).
const IDX = "mx:demoidx:1";
async function createdDemos(fromDay) {
  return cached(`mx:created:${fromDay}`, 600, async () => {
    const start = new Date().toISOString(), recs = new Map();
    let idx = await cacheGet(IDX), partial = false;
    const full = !idx || idx.from > fromDay || Date.now() - Date.parse(idx.full) > 12 * 3600e3;
    if (!full) {
      const ids = new Map(idx.ids); let cursor = null, pages = 0, over = false;
      const since = new Date(Date.parse(idx.at) - 120e3).toISOString().replace(/\.\d{3}Z$/, "Z");
      for (;;) {
        if (pages++ === 10) { over = true; break; }
        const r = await pd.activitiesV2({ cursor, sortBy: "update_time", sortDirection: "asc", updatedSince: since });
        const demo = new Set(r.items.map(a => a.id));
        for (const a of r.items) if (utcDay(a.add_time) >= idx.from) ids.set(a.id, a.add_time);
        for (const id of r.seen) if (!demo.has(id)) ids.delete(id); // cambió de tipo: ya no es demo
        if (!r.next) break; cursor = r.next;
      }
      if (!over) {
        const want = [...ids].filter(([, t]) => utcDay(t) >= fromDay).map(([id]) => Number(id));
        for (let i = 0; i < want.length; i += 100) for (const a of (await pd.activitiesV2({ ids: want.slice(i, i + 100), limit: 100 })).items) recs.set(a.id, a);
        for (const id of want) if (!recs.has(id)) ids.delete(id); // borrada (o ya no es demo)
        idx = { ...idx, at: start, ids: [...ids] };
      } else idx = null; // demasiados cambios: se relee todo
    }
    if (!idx || full) {
      recs.clear(); let cursor = null, pages = 0, oldest = null;
      for (;;) {
        if (pages++ === MX_PAGES) { partial = true; break; }
        const r = await pd.activitiesV2({ cursor, sortBy: "add_time", sortDirection: "desc" });
        for (const a of r.items) if (utcDay(a.add_time) >= fromDay) recs.set(a.id, a);
        oldest = r.oldestAdd;
        if (!r.next || (oldest && utcDay(oldest) < fromDay)) break; cursor = r.next;
      }
      idx = partial ? null : { from: fromDay, full: start, at: start, ids: [...recs.values()].map(a => [a.id, a.add_time]) };
    }
    if (idx) await cacheSet(IDX, idx, 2 * 86400);
    return { at: start, partial, acts: await placeDemos([...recs.values()].filter(a => utcDay(a.add_time) >= fromDay)) };
  });
}
// tratos de los embudos de venta: ganados y perdidos cambiados desde fromDay, y todos los abiertos (con próxima actividad, SDR y País)
async function dealsRaw(fromDay) {
  return cached(`mx:deals:${fromDay}`, 600, async () => {
    const partial = {}, since = `${fromDay}T00:00:00Z`;
    const all = async (status, opts) => { const out = []; let cursor = null;
      for (let i = 0; ; i++) { if (i === 20) { partial[status] = true; break; } const r = await pd.metricDealsPage({ cursor, status, ...opts }); out.push(...r.items.filter(d => SALES_PIPES.has(Number(d.pipeline_id)))); if (!r.next) break; cursor = r.next; }
      return out; };
    const [won, lost, open] = await Promise.all([all("won", { since }), all("lost", { since }), all("open", {})]);
    return { at: new Date().toISOString(), partial, won, lost, open };
  });
}
const mxBase = async () => { const [m, profiles] = await Promise.all([pd.meta(), getProfiles()]); return { m, profiles, users: m.users }; };
const fromMsOf = (day, tz) => { const u = toUtc(day, "00:00", tz); return Date.parse(`${u.date}T${u.time}:00Z`); };
// A1, A2 y A3. Las de A2 salen de la misma lectura que la tarjeta de Equipo (por persona y por vencimiento).
// team: { ids, emails } de un equipo (lib/teams.js filterOf) o null (todos): los cálculos toman solo lo de su gente.
export async function metricsDemos(tz, { days = 7, country = "", team = null } = {}) {
  const t = todayIn(tz), period = MX.periodOf(t, days);
  const [created, held, { m, profiles, users }] = await Promise.all([createdDemos(addDays(period.from, -1)), demosRaw(addDays(t, period.days <= 30 ? -31 : -91), addDays(t, 15)), mxBase()]);
  const ids = [...new Set([...created.acts, ...held.demos].map(a => Number(a.deal_id)).filter(Boolean))].sort((a, b) => a - b);
  const dk = `mx:demodeals:${crypto.createHash("sha1").update(ids.join(",")).digest("hex").slice(0, 16)}`;
  const dd = await cached(dk, 600, async () => ({ at: new Date().toISOString(), deals: await pd.dealsByIds(ids) }));
  const deals = new Map(dd.deals.map(d => [Number(d.id), d])), ctx = dealCtx(m);
  const countryOf = a => a.country || (deals.get(Number(a.deal_id)) ? MX.dealCountry(deals.get(Number(a.deal_id)), ctx) : "");
  const opts = { users, profiles, free: FREE_OWNERS, period, tz, country, countryOf, team };
  // A1 también recibe las de A2 (por vencimiento): así una entrada automática que repite una demo cargada antes no cuenta
  const loaded = MX.demosLoaded([...created.acts, ...held.demos], opts), h = MX.demosHeld(held.demos, { ...opts, now: Date.now() });
  const countries = [...new Set([...created.acts, ...held.demos].map(a => countryOf(a) || "?"))].sort((x, y) => (x === "?") - (y === "?") || x.localeCompare(y, "es"));
  return { period, tz, country, countries, at: { created: created.at, held: held.at, deals: dd.at }, partial: { created: !!created.partial, held: !!held.partial },
    loaded, held: { totals: h.totals, byOwner: h.byOwner, byLoader: h.byLoader }, deals: MX.demoDeals(h.items, deals, { stageOf: ctx.stageOf }) };
}
export async function metricsDeals(tz, { days = 7, country = "", team = null } = {}) {
  const period = MX.periodOf(todayIn(tz), days), [raw, { m, profiles, users }] = await Promise.all([dealsRaw(addDays(period.from, -1)), mxBase()]);
  const sum = MX.dealsSummary({ ...raw, period, tz, country, users, profiles, free: FREE_OWNERS, lostReasons: LOST_REASONS, team, ...dealCtx(m) });
  sum.open.pipes = sum.open.pipes.map(p => ({ ...p, name: m.pipes?.[p.pipe] || "" }));
  return { period, tz, country, at: raw.at, partial: raw.partial, ...sum };
}
// B. Actividad por persona (solo líderes). Tres lecturas de toda la cuenta (pd.activitiesPage), por páginas de 500:
//  · updated: las hechas cambiadas desde fromDay. Toda actividad marcada hecha en el período está acá (marcarla la cambia),
//    y también casi todas las de fecha en el período. Se lee por días de último cambio (la de hoy, abierta y al final).
//  · ahead: las hechas sin cambios desde fromDay, por vencimiento de la más lejana a la más vieja, hasta pasar fromDay: las de
//    fecha en el período que se marcaron hechas antes (casi ninguna).
//  · pending: las sin hacer, por vencimiento desde la más vieja, hasta pasar untilDay: las vencidas de todos.
// Con las tres, cada cuenta de activitySummary está completa. Si una pasa su tope de páginas, lo que depende de ella es «?».
// fromDay: un día antes del período y untilDay: mañana (las fechas de Pipedrive están en UTC). Se guarda 10 minutos.
export const ACT_PAGES = { updated: 240, ahead: 20, pending: 60 }; // tope de páginas de 500 de cada lectura (las pruebas lo bajan)
const actRawMem = new Map();
async function pool(list, n, fn) { const out = new Array(list.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => { while (i < list.length) { const j = i++; out[j] = await fn(list[j], j); } }));
  return out; }
function activityRaw(fromDay, untilDay) {
  const k = `${fromDay}|${untilDay}`, hit = actRawMem.get(k);
  if (hit && Date.now() - hit.t < 600e3) return hit.p;
  for (const [x, v] of actRawMem) if (Date.now() - v.t >= 600e3) actRawMem.delete(x);
  const p = (async () => {
    const at = new Date().toISOString(), today = at.slice(0, 10), since = `${fromDay}T00:00:00Z`, partial = {};
    const days = []; for (let d = fromDay; d <= today; d = addDays(d, 1)) days.push(d);
    let left = ACT_PAGES.updated;
    const updated = (await pool(days, 4, async (d, i) => { const out = []; let cursor = null;
      for (;;) {
        if (left-- <= 0) { partial.updated = true; break; }
        const r = await pd.activitiesPage({ cursor, done: true, updatedSince: `${d}T00:00:00Z`, updatedUntil: i < days.length - 1 ? `${days[i + 1]}T00:00:00Z` : undefined, sortBy: "update_time", sortDirection: "asc" });
        out.push(...r.items); if (!r.next) break; cursor = r.next;
      }
      return out; })).flat();
    const byDue = async (opts, max, keep, stop) => { const out = []; let cursor = null;
      for (let n = 0; ; n++) {
        if (n === max) return { out, cut: true };
        const r = await pd.activitiesPage({ cursor, sortBy: "due_date", ...opts });
        out.push(...r.items.filter(keep)); if (!r.next || (r.last?.due_date && stop(r.last.due_date))) return { out, cut: false }; cursor = r.next;
      } };
    const [ahead, pending] = await Promise.all([
      byDue({ done: true, updatedUntil: since, sortDirection: "desc" }, ACT_PAGES.ahead, a => a.due_date >= fromDay, d => d < fromDay),
      byDue({ done: false, sortDirection: "asc" }, ACT_PAGES.pending, a => !!a.due_date && a.due_date <= untilDay, d => d > untilDay),
    ]);
    if (ahead.cut) partial.ahead = true;
    if (pending.cut) partial.pending = true;
    return { at, partial, done: [...ahead.out, ...updated], pending: pending.out };
  })();
  actRawMem.set(k, { t: Date.now(), p });
  p.catch(() => actRawMem.delete(k));
  return p;
}
const teamKey = team => team ? crypto.createHash("sha1").update([...team.ids].sort((a, b) => a - b).join(",")).digest("hex").slice(0, 12) : "all";
export async function metricsActivity(tz, { days = 7, team = null } = {}) {
  const z = safeTz(tz), t = todayIn(z), period = MX.periodOf(t, days);
  return cached(`mx:act:2:${period.days}:${t}:${z}:${teamKey(team)}`, 600, async () => {
    const [raw, types, { profiles, users }] = await Promise.all([activityRaw(addDays(period.from, -1), addDays(t, 1)), pd.activityTypes().catch(() => null), mxBase()]);
    // los que usan la app van aunque estén en cero (las cuentas generales, no)
    const include = users.filter(u => profiles[u.email] && !FREE_OWNERS.has(Number(u.id))).map(u => u.id);
    return { period, tz: z, country: "", countryApplies: false, at: raw.at, partial: raw.partial, typesKnown: !!types, read: { done: raw.done.length, pending: raw.pending.length },
      ...MX.activitySummary({ done: raw.done, pending: raw.pending, types: types || [], users, profiles, free: FREE_OWNERS, include, period, tz: z, today: t, partial: raw.partial, team }) };
  });
}
// D: lo registrado desde la app (sin pedidos a Pipedrive)
export async function metricsContacts(tz, { days = 7, country = "", team = null } = {}) {
  const period = MX.periodOf(todayIn(tz), days), w = touchWindow(fromMsOf(period.from, tz)), profiles = await getProfiles();
  return { period, tz, country, at: new Date().toISOString(), max: w.max,
    ...MX.contactsSummary(w.list, { period, tz, country, countryOf: t => byId.get(t.schoolId)?.country || "", outcomes: [...OUTCOMES, MAIL_SENT], profiles, cut: w.cut, team }) };
}
// G: el registro de archivados de la app (no el estado del colegio: un cliente archivado se muestra como cliente)
export async function metricsArchived(tz, { days = 7, country = "", team = null } = {}) {
  const period = MX.periodOf(todayIn(tz), days), profiles = await getProfiles();
  return { period, tz, country, at: new Date().toISOString(), ...MX.archivedSummary(allArchived(), { period, tz, country, countryOf: id => byId.get(id)?.country || "", reasons: ARCHIVE_REASONS, profiles, team }) };
}
// Marcar el resultado (actividad ya revisada con ownActivity). Queda hecha salvo «se reprogramó», que la mueve a la fecha nueva.
export async function markDemo(a, user, { result, date, time, by }, tz, leader = false) {
  if (a?.type !== "meeting") throw bad("Esa actividad no es una demo.");
  if (!RESULTS[result]) throw bad("Elegí qué pasó con la demo.");
  if ((result === "done" || result === "noshow") && !demoPast(a, Date.now(), tz)) throw bad("Esa demo todavía no pasó.");
  const t = todayIn(tz), who = by || signer(user);
  let done = [];
  if (result === "moved") {
    if (!DATE_RE.test(date || "")) throw bad("Elegí el día nuevo.");
    const tm = TIME_RE.test(time || "") ? time : "", u = toUtc(date, tm, tz);
    await pd.updateActivity(a.id, { due_date: u.date, ...(u.time ? { due_time: u.time } : {}), done: false, note: withResult(a.note, resultLine("moved", { by: who, day: t, to: `${ddmm(date)}${tm ? ` ${tm} (hora de ${safeTz(tz)})` : ""}` })) });
    done = await demoMoved({ ...a, done: false }, user, { date, time: tm }, tz, leader).catch(e => [{ label: `No pude mover el recordatorio para confirmar la demo: ${e.message}`, warn: true }]);
  } else await pd.updateActivity(a.id, { done: true, note: withResult(a.note, resultLine(result, { by: who, day: t })) });
  await cacheSet("demos:ver", Date.now(), 7 * 86400);
  return { ok: true, result, done };
}
// No se presentó: otra demo con el mismo colegio, trato y dueño (la de antes queda como no-show)
export async function rebookDemo(a, user, { date, time, by }, tz) {
  if (a?.type !== "meeting") throw bad("Esa actividad no es una demo.");
  if (!DATE_RE.test(date || "") || !TIME_RE.test(time || "")) throw bad("Poné el día y la hora de la demo.");
  const u = toUtc(date, time, tz), who = by || signer(user), name = subjName(a.subject) || "la demo";
  const n = await pd.addActivity({ subject: a.subject || "Demo OrderEAT", type: "meeting", dueDate: u.date, dueTime: u.time, durationMin: 30, orgId: a.org_id || null, dealId: a.deal_id || null, leadId: a.lead_id || null,
    personId: a.person_id || null, ownerId: a.owner_id || user.pdUserId, note: `Agendada por ${esc(who)} desde OrderBrain SDR<br>Reagendada después de un no-show (demo del ${ddmm(fromUtc(a.due_date, a.due_time, tz).date)})` });
  const done = [{ label: `Demo reagendada para el ${nice(date)} a las ${time}` }, ...await demoReminder({ name, orgId: a.org_id || null, dealId: a.deal_id || null, leadId: a.lead_id || null, date, time, tz, user, ownerId: pd.realOwner(a.owner_id) }).catch(e => [{ label: `No pude agendar el recordatorio para confirmar la demo: ${e.message}`, warn: true }])];
  await cacheSet("demos:ver", Date.now(), 7 * 86400);
  return { ok: true, id: n?.id || null, done };
}

export { OUTCOMES, allMatches };
