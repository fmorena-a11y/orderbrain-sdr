import crypto from "crypto";
import * as pd from "./pipedrive.js";
import { addVirtual, schools, byId, getMatch, setMatch, isFresh, addTouch, touchesFor, touchesSince, orgToSchool, allMatches, refreshMatch, withLock } from "./store.js";
import { market, MARKETS, DEAL_FIELDS, OPTIONS, TYPE_LABEL, CHANNEL_TYPE, LOST_REASONS, DAILY_GOAL, CLIENT_PIPES, FREE_OWNERS } from "./config.js";
import { OUTCOMES, outcomeById, suggestNext, playbookFor, templates, scoreSchool, countAttempts } from "./playbook.js";
import { toUtc, fromUtc, todayIn, weekday, safeTz, addBusinessDays, confirmDay, addDays } from "./time.js";
import { structureNote } from "./ai.js";
import { brainOf, nearbyClients, brainVersion } from "./brain.js";
import { potentialOf } from "./potential.js";
import { slackFor, slackEnabled } from "./slack.js";
import { keyTokens } from "./scan.js";
import { webInfo, placesLookup } from "./enrich.js";
import { photosFor } from "./photos.js";
import { RESULTS, resultLine, withResult, demoPast, ddmm, demoBoard } from "./demos.js";
import * as MX from "./metrics.js";
import { getStudy, cacheGet, cacheSet, getProfiles, ROLES, getArchived, setArchived, refreshArchived, touchWindow, allArchived } from "./store.js";
import { archiveError, archivePlan, canUnarchive, ARCHIVE_REASONS } from "./archive.js";

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
    if (l.orgId) { const r = await openRecord("org", l.orgId, { leadId: l.id, country, city }); return { ...r, leadId: l.id }; }
    const person = l.personId ? await pd.getPerson(l.personId).catch(() => null) : null;
    // si el prospecto ya pasó a trato (otra instancia lo convirtió), se sigue con su organización
    const conv = getMatch(`pd-lead-${l.id}`);
    const s = addVirtual({ id: `pd-lead-${l.id}`, name: l.title || person?.name || "Prospecto", city, country, phone: person?.phone || "", email: person?.email || "",
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

export async function checkSchool(id, { force = false, org = null } = {}) {
  const s = byId.get(id);
  if (!s) throw bad("Colegio inexistente", 404);
  if (s.leadOnly) return getMatch(id) || setMatch(id, { status: "lead", detail: "Prospecto en Pipedrive", orgId: null, confirmed: true, leadId: s.leadId, candidates: [] });
  const cur = getMatch(id);
  if (!force && !org && isFresh(cur)) return cur;
  let chosen = null, candidates = [], auto = false;
  const keep = pd.keepsOrg(cur, s, touchesFor(id).length > 0); // elegido a mano: se mantiene su organización
  if (org) chosen = { ...org, score: 1 };
  else if (keep) chosen = { id: cur.orgId, name: cur.orgName, score: 1 };
  else {
    const ctx = pd.matchCtx(schools);
    candidates = await pd.findOrgCandidates(s, ctx); chosen = pd.pickOrg(candidates);
    auto = !!chosen && pd.isSure(candidates, ctx.key(s));
  }
  if (!chosen) return setMatch(id, pd.noMatchRecord(candidates));
  const [deals, m] = await Promise.all([pd.dealsForOrg(chosen.id), pd.meta()]);
  // dueño de la organización en Pipedrive: si es de otra persona, nadie más la prospecta
  let ownerId = chosen.ownerId ?? null;
  if (ownerId === null) ownerId = (await pd.orgsByIds([chosen.id]))[0]?.ownerId || null; // si falla, no se guarda un cruce «sin dueño»
  // las mismas reglas que la sincronización masiva (lib/sync.js): pd.matchRecord es puro
  return setMatch(id, pd.matchRecord({ chosen, deals, m, ownerId, confirmed: !!(org || keep), auto, candidates, cur }));
}

// «no es esta organización»: queda marcado (unlinked) para que la sincronización masiva no la vuelva a elegir mientras dure
export function unlinkSchool(id) {
  return setMatch(id, { status: "new", detail: "Sin coincidencia confirmada", orgId: null, orgName: null, confirmed: false, auto: false, unlinked: true, candidates: getMatch(id)?.candidates || [] });
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
export async function schoolDetail(id, { user, tz, ...opts } = {}) {
  const s = byId.get(id);
  const rec = await checkSchool(id, opts);
  const t = touchesFor(id);
  const base = {
    match: rec, school: schoolSummary(s), market: market(s.country), playbook: playbookFor(s, effMatch(s) || rec), brain: brainOf(s),
    attempts: countAttempts(t), touches: t.slice(-15).reverse().map(x => ({ at: x.at, by: x.byName, outcome: outcomeById(x.outcome)?.label || x.outcome, channel: x.channel, text: x.text || "" })),
    lostReasons: LOST_REASONS, today: todayIn(tz), archive: getArchived(id),
  };
  if (s.leadOnly) {
    const [notes, lead] = await Promise.all([pd.notesForLead(s.leadId).catch(() => []), pd.leadsByIds([s.leadId], user?.pdUserId).then(l => l[0] || null).catch(() => null)]);
    const persons = s.personId ? [{ id: s.personId, name: s.personName, phone: s.phone || "", email: s.email || "" }] : [];
    // leadOwnerId: dueño del prospecto (null: libre); sin dato, no va (la ficha no ofrece archivarlo salvo a un líder)
    return { ...base, lead: true, orgUrl: `${pd.PD_WEB}/leads/inbox/${s.leadId}`, deals: [], activities: [], persons, askFor: askFor(t, notes), ...(lead ? { leadOwnerId: lead.ownerId || null } : {}),
      notes: notes.map(n => ({ at: n.add_time, author: n.user?.name || "", deal: "", text: stripHtml(n.content).slice(0, 900) })),
      templates: templates(s, { me: user?.name, contact: s.personName || "" }) };
  }
  if (!rec.orgId) return { ...base, deals: [], notes: [], activities: [], persons: [], askFor: askFor(t), templates: templates(s, { me: user?.name }) };
  const [deals, notes, acts, persons, m] = await Promise.all([pd.dealsForOrg(rec.orgId), pd.notesForOrg(rec.orgId), pd.activities({ orgId: rec.orgId, done: false, limit: 20 }), pd.personsForOrg(rec.orgId).catch(() => []), pd.meta()]);
  const uname = uid => m.users.find(u => u.id === uid)?.name || "";
  // prospectos abiertos de la organización: si ya hay uno, no se ofrece crear otro (evita duplicados)
  const leads = (await pd.leadsForOrg(rec.orgId).catch(() => [])).map(l => ({ id: l.id, title: l.title, ownerId: l.ownerId || null, owner: uname(l.ownerId), url: `${pd.PD_WEB}/leads/inbox/${l.id}` }));
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
export async function historyFor(id) {
  const s = byId.get(id); if (!s) throw bad("Colegio inexistente", 404);
  const ob = brainOf(s), rec = getMatch(id) || {};
  let orgIds = rec.orgId ? [rec.orgId] : [];
  if (rec.orgName) {
    const same = (await pd.searchOrganizations(rec.orgName, 10).catch(() => [])).filter(o => pd.norm(o.name) === pd.norm(rec.orgName)).map(o => o.id);
    orgIds = [...new Set([...orgIds, ...same])].slice(0, 4);
  }
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
const BASE_SRC = new Set(["Base de colegios", "Persona en Pipedrive"]);
export async function enrichSchool(id, user, by = "") {
  const s = byId.get(id); if (!s) throw bad("Colegio inexistente", 404);
  return withLock("enrich:" + id, async () => {
    const prev = await getEnrich(id).catch(() => null);
    // dueño al día antes de escribir nada
    const rec = s.leadOnly ? getMatch(id) || {} : await checkSchool(id, { force: true }).catch(() => getMatch(id) || {});
    const own = s.leadOnly ? (await pd.leadsByIds([s.leadId]).catch(() => []))[0] : rec.orgId ? (await pd.leadsForOrg(rec.orgId).catch(() => []))[0] : null;
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
      photos = await photosFor(id, { refresh: true, web, webSrc }).catch(() => []);
      data.photos = photos.length;
    }
    // nota en Pipedrive: en el prospecto o la organización (confirmada), si es tuya o libre
    let note = { saved: false };
    const theirs = (uid, name) => uid && uid !== user.pdUserId ? `No guardé la nota: es de ${name || "otra persona"} en Pipedrive. Hablalo con esa persona.` : "";
    const nuevos = data.items.filter(x => !x.known).length + data.sedes.length + data.decisores.length;
    const m = await pd.meta().catch(() => ({ users: [] })), uname = uid => m.users.find(u => u.id === uid)?.name || "";
    const target = s.leadOnly ? { leadId: s.leadId } : rec.orgId && (rec.confirmed || rec.created) ? { orgId: rec.orgId, dealId: rec.openDealId && (!rec.openDealOwnerId || rec.openDealOwnerId === user.pdUserId) ? rec.openDealId : undefined } : null;
    if (!target) note.reason = rec.orgId ? "No guardé la nota: confirmá primero cuál es su organización en Pipedrive (en Historial)." : "Todavía no está en Pipedrive: creá el prospecto y volvé a tocar Enriquecer.";
    else if (s.leadOnly && own?.ownerId && own.ownerId !== user.pdUserId) note.reason = theirs(own.ownerId, uname(own.ownerId));
    else if (!s.leadOnly && rec.ownerId && rec.ownerId !== user.pdUserId) note.reason = theirs(rec.ownerId, rec.ownerName);
    else if (!s.leadOnly && own?.ownerId && own.ownerId !== user.pdUserId) note.reason = theirs(own.ownerId, uname(own.ownerId));
    else if (!nuevos) note.reason = "No encontré nada que no estuviera ya: no hice nota.";
    else {
      const html = enrichHtml(s, data), key = `enrichnote:${target.leadId ? "lead:" + target.leadId : "org:" + target.orgId}`;
      const hash = crypto.createHash("sha1").update(JSON.stringify([data.items, data.sedes, data.decisores])).digest("hex");
      if ((await cacheGet(key)) === hash) note.reason = "Esto ya estaba en una nota de Pipedrive.";
      else {
        try { await pd.addNote({ content: html, ...target }); await cacheSet(key, hash, 365 * 86400); note = { saved: true, at: new Date().toISOString(), url: target.leadId ? `${pd.PD_WEB}/leads/inbox/${target.leadId}` : `${pd.PD_WEB}/organization/${target.orgId}` }; }
        catch (e) { note.reason = `No pude guardar la nota en Pipedrive (${e.message}). Probá de nuevo.`; }
      }
    }
    data = { ...data, nuevos, note: note.saved ? note : data.note?.saved ? data.note : note };
    await cacheSet("enrich:" + id, data, 180 * 86400);
    return { data, note, photos: photos ?? await photosFor(id).catch(() => []) };
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

// Se asegura de que el colegio tenga organización en Pipedrive; si no existe, la crea.
export async function ensureOrg(id, ownerId = null) {
  const s = byId.get(id);
  if (s?.leadOnly) throw bad("Es un prospecto sin organización: lo que registres queda en el prospecto.", 409);
  await refreshMatch(id);
  let rec = await checkSchool(id);
  if (rec.orgId) return rec;
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
export const reminderPlan = (pend, { userId, leader = false, any = false }) => { const move = pend.filter(a => any || leader || Number(a.owner_id) === Number(userId)); return { move, others: pend.filter(a => !move.includes(a)) }; };
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
// resultados que cierran o ya tienen su propio paso (la demo): ahí no se agenda solo un seguimiento
const NO_AUTO_NEXT = ["demo", "not_interested", "bad_data"];
export async function logContact(id, user, p, tz) {
  const s = byId.get(id);
  if (!s) throw bad("Colegio inexistente", 404);
  // archivado (como al crear el prospecto): primero se desarchiva
  await refreshArchived(id);
  if (effMatch(s)?.status === "archived") throw bad("Está archivado: desarchivalo para registrar contactos.", 409);
  const o = outcomeById(p.outcome);
  if (!o) throw bad("Elegí qué pasó en el contacto.");
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
  if (s.leadOnly) return logLead(id, s, user, p, tz, { o, channel, raw, today });

  // ¿lo está tomando por primera vez? (nunca contactado: no tenía organización en Pipedrive)
  const firstTake = !getMatch(id)?.orgId;
  const rec = await ensureOrg(id, user.pdUserId);
  // si estaba a nombre de la cuenta general de la empresa, pasa a quien lo trabaja
  if (!rec.created && !rec.ownerId && rec.confirmed) {
    await pd.updateOrganization(rec.orgId, { owner_id: user.pdUserId }).then(() => { setMatch(id, { ...getMatch(id), ownerId: user.pdUserId, ownerName: signer(user) }); done.push({ label: "El colegio pasó a tu nombre en Pipedrive (estaba en la cuenta general)" }); }).catch(() => {});
  }
  const orgUrl = `${pd.PD_WEB}/organization/${rec.orgId}`;
  done.push({ label: rec.created ? "Organización creada en Pipedrive" : `Guardado en ${rec.orgName}`, url: orgUrl });

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

  // El contacto en sí, como actividad hecha (cuenta para los reportes de Pipedrive).
  const chLabel = { call: "Llamada", whatsapp: "WhatsApp", mail: "Mail", visit: "Visita" }[channel];
  await pd.addActivity({ subject: `${chLabel}: ${o.label} · ${s.name}`, type: CHANNEL_TYPE[channel], dueDate: today, orgId: rec.orgId, dealId, personId, ownerId: user.pdUserId, note: raw ? esc(raw).replace(/\n/g, "<br>") : "", done: true });
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

  // Próximo paso
  if (p.next?.type && TYPE_LABEL[p.next.type]) {
    const u = toUtc(p.next.date, p.next.time, tz);
    await pd.addActivity({ subject: p.next.subject || `${TYPE_LABEL[p.next.type]} · ${s.name}`, type: p.next.type, dueDate: u.date, dueTime: u.time, orgId: rec.orgId, dealId, personId,
      ownerId: Number(p.next.ownerId) || user.pdUserId, note: raw ? esc(raw).slice(0, 1000) : "" });
    html += `<br><b>Próximo paso:</b> ${TYPE_LABEL[p.next.type]} el ${weekday(p.next.date)} ${esc(p.next.date)}${p.next.time ? " " + esc(p.next.time) : ""}`;
    done.push({ label: `Próximo paso: ${TYPE_LABEL[p.next.type]} el ${nice(p.next.date)}${p.next.time ? " a las " + p.next.time : ""}` });
  }

  // Colegio nuevo sin próximo paso elegido: queda una llamada para el próximo día hábil, a tu nombre (se cambia desde la agenda)
  else if ((firstTake || rec.created) && !NO_AUTO_NEXT.includes(o.id)) {
    const day = addBusinessDays(today, 1);
    await pd.addActivity({ subject: `${TYPE_LABEL.call} · ${s.name}`, type: "call", dueDate: day, orgId: rec.orgId, dealId, personId, ownerId: user.pdUserId, note: "Seguimiento del primer contacto (agendado solo por OrderBrain SDR)." });
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
  await pd.addNote({ content: html, orgId: rec.orgId, dealId, personId });
  done.push({ label: "Nota guardada" });

  // Etiqueta de interés en la organización
  // se cambia solo la de interés (alto, medio, bajo); las demás etiquetas quedan. Si no se pueden leer, no se toca nada.
  if (o.interest && rec.status !== "client") {
    const org = (await pd.orgsByIds([rec.orgId]).catch(() => []))[0], lv = [OPTIONS.orgLabel.alto, OPTIONS.orgLabel.medio, OPTIONS.orgLabel.bajo];
    if (org) await pd.updateOrganization(rec.orgId, { label_ids: [...new Set([...(org.labelIds || []).map(Number).filter(x => !lv.includes(x)), OPTIONS.orgLabel[o.interest]])] }).catch(() => {});
  }

  // Marca como hecha la actividad que motivó el contacto
  if (p.completeActivityId) await pd.updateActivity(Number(p.completeActivityId), { done: true }).then(() => done.push({ label: "Actividad pendiente marcada como hecha" }), () => done.push({ label: "No pude marcar la actividad como hecha: hacelo desde la agenda.", warn: true }));
  // Un prospecto (lead) que llegó a demo ya es un trato: se archiva el prospecto con una nota
  // (el prospecto puede venir de la ficha, del cruce guardado o de «Crear prospecto»)
  const leadId = s.leadId || getMatch(id)?.leadId || rec.leadId || null;
  if (leadId && o.id === "demo" && dealId) {
    await pd.addNote({ content: `<b>Pasó a trato</b><br>Demo agendada desde OrderBrain SDR por ${esc(signer(user))}.<br><a href="${pd.PD_WEB}/deal/${dealId}">Ver trato</a>`, leadId }).catch(() => {});
    await pd.updateLead(leadId, { is_archived: true }).then(() => done.push({ label: "Prospecto archivado: ya es un trato" })).catch(() => {});
  }

  addTouch({ schoolId: id, by: user.email, byName: signer(user), outcome: o.id, channel, connected: o.connected, text: raw.slice(0, 300), demo: o.id === "demo", ...(ask ? { ask } : {}) });
  const fresh = await checkSchool(id, { force: true }).catch(() => getMatch(id));
  if (!fresh.confirmed || fresh.auto) setMatch(id, { ...fresh, confirmed: true, auto: false }); // ya se trabajó con esta organización
  done.push(...warnings.map(label => ({ label, warn: true })));
  return { ok: true, done, warnings, orgUrl, dealUrl: dealId ? `${pd.PD_WEB}/deal/${dealId}` : null, school: schoolSummary(s) };
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
  if (p.next?.type && TYPE_LABEL[p.next.type]) {
    const u = toUtc(p.next.date, p.next.time, tz);
    await pd.addActivity({ subject: p.next.subject || `${TYPE_LABEL[p.next.type]} · ${s.name}`, type: p.next.type, dueDate: u.date, dueTime: u.time, leadId: s.leadId, personId, ownerId: Number(p.next.ownerId) || user.pdUserId, note: raw ? esc(raw).slice(0, 1000) : "" });
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
  if (p.completeActivityId) await pd.updateActivity(Number(p.completeActivityId), { done: true }).then(() => done.push({ label: "Actividad pendiente marcada como hecha" }), () => done.push({ label: "No pude marcar la actividad como hecha: hacelo desde la agenda.", warn: true }));
  addTouch({ schoolId: id, by: user.email, byName: signer(user), outcome: o.id, channel, connected: o.connected, text: raw.slice(0, 300), demo: false, ...(ask ? { ask } : {}) });
  return { ok: true, done, orgUrl: leadUrl, dealUrl: null, school: schoolSummary(s) };
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
  if (!s || s.leadOnly) throw bad("Colegio inexistente", 404);
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
    const rec = await ensureOrg(id, user.pdUserId);
    if (rec.ownerId && rec.ownerId !== user.pdUserId) throw bad(`La organización es de ${rec.ownerName || "otra persona"} en Pipedrive. Hablalo con esa persona.`, 409);
    const orgUrl = `${pd.PD_WEB}/organization/${rec.orgId}`;
    const done = [{ label: rec.created ? "Organización creada en Pipedrive" : `Organización: ${rec.orgName}`, url: orgUrl }], warnings = [];
    // ¿ya hay un prospecto abierto? se reusa si es tuyo (sin duplicar persona ni nota); si es de otro, no se crea
    const open = await pd.leadsForOrg(rec.orgId).catch(e => { throw bad(`No pude revisar los prospectos de Pipedrive (${e.message}). Probá de nuevo.`, 502); });
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
      lead = await pd.createLead({ title: s.name, ownerId: user.pdUserId, orgId: rec.orgId, personId, fields: await leadFields(s, user, found) });
      if (!OPTIONS.pais[s.country]) warnings.push(s.country ? paisWarn(s.country) : "No supe el país del colegio: el campo País quedó sin completar.");
      const rows = [
        found.decisores.length ? `<b>Decisores:</b><br>${found.decisores.map(d => `• ${esc(personLabel(d.nombre, d.cargo))}${d.fuente ? ` · ${esc(d.fuente)}` : ""}`).join("<br>")}` : "<b>Decisor:</b> todavía sin nombre. Preguntá en recepción quién maneja la cafetería.",
        found.phones.length ? `<b>Teléfonos:</b> ${found.phones.map(esc).join(" · ")}` : "", found.whatsapp ? `<b>WhatsApp:</b> ${esc(found.whatsapp)}` : "",
        found.emails.length ? `<b>Mails:</b> ${found.emails.map(esc).join(" · ")}` : "", s.web ? `<b>Web:</b> ${esc(s.web)}` : "",
      ].filter(Boolean);
      await pd.addNote({ content: `<b>Prospecto creado desde OrderBrain SDR</b> por ${esc(signer(user))}<br>${rows.join("<br>")}`, orgId: rec.orgId }).catch(() => {});
    }
    const leadUrl = `${pd.PD_WEB}/leads/inbox/${lead.id}`;
    done.push({ label: open.length ? "Prospecto ya existente (tuyo)" : "Prospecto creado a tu nombre", url: leadUrl });
    // la primera tarea a futuro, atada al prospecto (le aparece a quien la tenga en su agenda)
    if (task) {
      const m = await pd.meta(), owner = task.ownerId ? m.users.find(u => u.id === Number(task.ownerId)) : null;
      const u = toUtc(task.date, task.time, tz);
      await pd.addActivity({ subject: String(task.subject || "").trim().slice(0, 140) || `${TYPE_LABEL[task.type]} · ${s.name}`, type: task.type, dueDate: u.date, dueTime: u.time, leadId: lead.id, personId, ownerId: owner?.id || user.pdUserId });
      done.push({ label: `${TYPE_LABEL[task.type]} el ${nice(task.date)}${task.time ? " a las " + task.time : ""} para ${owner && owner.id !== user.pdUserId ? owner.name : "vos"}`, url: leadUrl });
    }
    const fresh = await checkSchool(id, { force: true }).catch(() => getMatch(id));
    setMatch(id, { ...fresh, confirmed: true, auto: false, ownerId: fresh.ownerId || user.pdUserId, leadId: lead.id });
    done.push(...warnings.map(label => ({ label, warn: true })));
    return { ok: true, done, warnings, leadUrl, orgUrl, found, school: schoolSummary(s) };
  }).then(async r => {
    // si había datos de «Enriquecer» que no se pudieron guardar (todavía no estaba en Pipedrive), quedan ahora en una nota
    const e = await getEnrich(id).catch(() => null);
    if (e && !e.note?.saved) {
      const x = await enrichSchool(id, user, e.by).catch(() => null);
      if (x?.note?.saved) r.done.push({ label: "Datos de «Enriquecer» guardados en una nota", url: x.note.url });
    }
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
      const open = await pd.leadsForOrg(rec.orgId).catch(e => { throw bad(`No pude revisar los prospectos en Pipedrive (${e.message}).`, 502); });
      lead = open.find(l => l.ownerId === user.pdUserId) || open.find(l => !l.ownerId) || open[0] || null;
    }
    if (!lead || lead.archived) throw bad("No encontré un prospecto abierto para convertir.", 404);
    if (lead.ownerId && lead.ownerId !== user.pdUserId && !leader) {
      const m = await pd.meta().catch(() => ({ users: [] }));
      throw bad(`El prospecto es de ${m.users.find(u => u.id === lead.ownerId)?.name || "otra persona"} en Pipedrive: hablalo con esa persona.`, 403);
    }
    const country = s.country || countryFromOpt(lead.paisOpt) || (MARKETS[chosen] ? chosen : "") || phoneCountry(s.phone, lead.phone);
    const mk = market(country), done = [];
    const { dealId } = await pd.convertLead(lead.id, { stageId: mk.stage });
    const url = `${pd.PD_WEB}/deal/${dealId}`;
    done.push({ label: `Trato abierto en el embudo ${MARKETS[country] ? country : "LatAm"}`, url });
    if (!MARKETS[country]) done.push({ label: "No supe el país: el trato quedó en el embudo LatAm. Revisalo en Pipedrive.", warn: true });
    done.push({ label: "Las notas y actividades del prospecto pasaron al trato" });
    const orgId = lead.orgId || rec.orgId || null;
    if (s.leadOnly && orgId) { s.leadOnly = false; s.pdOrgId = orgId; }
    if (orgId) await checkSchool(id, { org: { id: orgId, name: rec.orgName || s.name, ownerId: lead.ownerId || user.pdUserId } }).catch(() => null);
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
    const leads = s.leadOnly ? await pd.leadsByIds([s.leadId], user.pdUserId).catch(e => { throw pdErr(e); }) : orgId ? await pd.leadsForOrg(orgId).catch(e => { throw pdErr(e); }) : [];
    // de un prospecto sin organización hay que saber de quién es (si no, solo un líder lo archiva)
    if (s.leadOnly && !leads.length && !leader) throw bad("No pude revisar el prospecto en Pipedrive. Probá de nuevo.", 502);
    const org = orgId ? (await pd.orgsByIds([orgId]).catch(e => { throw pdErr(e); }))[0] || null : null;
    const plan = archivePlan({ leads, org, me: user.pdUserId, ownerId: s.leadOnly ? null : cur.ownerId }), a = { reason, text }, done = [], leadIds = [];
    const m = plan.otherOwner ? await pd.meta().catch(() => ({ users: [] })) : null, uname = uid => m?.users.find(u => u.id === uid)?.name || "otra persona";
    // lo de otra persona (organización o prospecto) solo lo archiva un líder: el archivo vale para todo el equipo
    const err2 = archiveError({ status: eff.status, dealOwner: cur.openDealOwnerId, me: user.pdUserId, leader, othersOwner: plan.otherOwner && uname(plan.otherOwner), reason, text });
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
    const me = user.pdUserId, owner = leader || canUnarchive(rec, user.email) || !me ? false : s.leadOnly ? (await pd.leadsByIds([s.leadId], me).catch(() => []))[0]?.ownerId === me
      : await checkSchool(id).catch(() => getMatch(id) || {}).then(async c => Number(c?.ownerId) === me || (!!c?.orgId && (await pd.leadsForOrg(c.orgId).catch(() => [])).some(l => l.ownerId === me)));
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
  const label = personLabel(name, role), done = [];
  if (s.leadOnly) {
    const lead = (await pd.leadsByIds([s.leadId], user.pdUserId))[0];
    if (!lead) throw bad("No encontré el prospecto en Pipedrive.", 404);
    if (lead.ownerId && lead.ownerId !== user.pdUserId && !leader) throw bad("Ese prospecto es de otra persona en Pipedrive: no le podés agregar contactos.", 403);
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
  if (rec.ownerId && rec.ownerId !== user.pdUserId && !leader) throw bad(`La organización es de ${rec.ownerName || "otra persona"} en Pipedrive: no le podés agregar contactos.`, 403);
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

// ---------- seguimiento del equipo (solo líderes): para acompañar a cada persona, no para comparar (orden alfabético).
// Sale de las actividades y tratos de Pipedrive (no solo de lo registrado en la app). Últimos 7 días contando hoy, en la zona del líder.
export const FOLLOW_KIND = { call: "calls", deadline: "whatsapp", task: "mails" };
const utcIso = v => !v ? null : String(v).includes("T") ? String(v) : String(v).replace(" ", "T") + "Z";
export function followUp({ acts = [], won = [], open = [], users = [], profiles = {}, today, tz }) {
  const from = addDays(today, -6), fmt = new Intl.DateTimeFormat("sv-SE", { timeZone: safeTz(tz) });
  const dayOf = v => { const x = utcIso(v); return x ? fmt.format(new Date(x)) : ""; }, inWeek = d => !!d && d >= from && d <= today;
  const due = a => fromUtc(a.due_date, a.due_time, tz).date;
  // la demo agendada cuenta para quien la agendó (by: nombre de la nota de la app, como en Pipedrive o en su perfil); si no se sabe, para su dueño
  const key = v => String(v || "").trim().toLowerCase(), byName = new Map(users.flatMap(u => [[key(u.name), u.id], [key(u.email), u.id], [key(profiles[u.email]?.name), u.id]]).filter(([k]) => k));
  const setter = a => byName.get(key(a.by)) || Number(a.owner_id);
  // quién entra: usuarios de Pipedrive con perfil en la app o con actividades en la semana (no las cuentas generales)
  const active = new Set(acts.filter(a => inWeek(a.done ? dayOf(a.done_time) || due(a) : due(a)) || inWeek(dayOf(a.add_time))).flatMap(a => [Number(a.owner_id), ...(a.type === "meeting" ? [setter(a)] : [])]));
  const rows = new Map(users.filter(u => pd.realOwner(u.id) && (profiles[u.email] || active.has(u.id))).map(u => { const pr = profiles[u.email];
    return [u.id, { id: u.id, name: pr?.name || u.name, role: pr ? ROLES[pr.role] || "" : "", calls: 0, whatsapp: 0, mails: 0, demosSet: 0, demosDone: 0, won: 0, overdue: 0, noNext: 0, deals: [] }]; }));
  for (const a of acts) {
    const r = rows.get(Number(a.owner_id)); if (!r) continue;
    if (a.done && inWeek(dayOf(a.done_time) || due(a))) { if (FOLLOW_KIND[a.type]) r[FOLLOW_KIND[a.type]]++; if (a.type === "meeting") r.demosDone++; }
    if (!a.done && due(a) < today && due(a) >= from) r.overdue++;
  }
  for (const a of acts) { const r = a.type === "meeting" && inWeek(dayOf(a.add_time)) && rows.get(setter(a)); if (r) r.demosSet++; }
  for (const d of won) { const r = rows.get(Number(d.owner_id)); if (r && inWeek(dayOf(d.won_time))) r.won++; }
  // tratos abiertos de venta sin próxima actividad: primero los que llevan más tiempo quietos
  for (const d of [...open].sort((x, y) => String(x.update_time || "").localeCompare(String(y.update_time || "")))) {
    const r = rows.get(Number(d.owner_id)); if (!r || d.next_activity_id || CLIENT_PIPES.includes(Number(d.pipeline_id))) continue;
    r.noNext++; if (r.deals.length < 5) r.deals.push({ id: d.id, title: d.title, since: (utcIso(d.update_time) || "").slice(0, 10) });
  }
  return { from, today, people: [...rows.values()].sort((x, y) => x.name.localeCompare(y.name, "es", { sensitivity: "base" })) };
}
// Pide a Pipedrive lo justo por páginas (hasta 20 de 500 por listado) y lo guarda 10 minutos. partial: se cortó por el tope.
// Las pendientes van por persona (no las cuentas generales, que tienen miles a futuro), de la más lejana a la más vieja, hasta pasar el comienzo de la semana.
async function followRaw(since) {
  let partial = false;
  const all = async (fn, stop = () => false) => { const out = []; let cursor = null;
    for (let i = 0; ; i++) { if (i === 20) { partial = true; break; } const r = await fn(cursor); out.push(...r.items); if (!r.next || r.items.some(stop)) break; cursor = r.next; }
    return out; };
  const day = since.slice(0, 10), soon = addDays(new Date().toISOString().slice(0, 10), 1);
  const owners = [...new Set((await pd.meta()).users.map(u => pd.realOwner(u.id)).filter(Boolean))], pending = [];
  const [done, won, open] = await Promise.all([
    all(cursor => pd.activitiesPage({ cursor, done: true, since })),
    all(cursor => pd.dealsByStatus({ cursor, status: "won", since })),
    all(cursor => pd.dealsByStatus({ cursor, status: "open" })),
    (async () => { for (let i = 0; i < owners.length; i += 4) // de a 4 personas, para no pasar el límite de pedidos
      for (const l of await Promise.all(owners.slice(i, i + 4).map(id => all(cursor => pd.activitiesPage({ cursor, done: false, dueDesc: true, ownerId: id }), a => a.due_date < day)))) pending.push(...l); })(),
  ]);
  return { at: new Date().toISOString(), partial,
    // hechas: solo las marcadas en la semana (el listado trae todo lo cambiado, también por cambios masivos)
    acts: [...done.filter(a => (a.done_time || a.due_date || "") >= day), ...pending.filter(a => a.due_date >= day && (a.type === "meeting" || a.due_date <= soon))],
    won, open: open.filter(d => !d.next_activity_id && !CLIENT_PIPES.includes(Number(d.pipeline_id))) };
}
let followLoading = null; // dos líderes a la vez: un solo pedido
export async function teamFollow(tz) {
  const since = addDays(new Date().toISOString().slice(0, 10), -8) + "T00:00:00Z"; // cubre la semana en cualquier zona
  let raw = await cacheGet("follow:" + since);
  if (!raw) raw = await (followLoading ||= followRaw(since).then(async r => { await cacheSet("follow:" + since, r, 600); return r; }).finally(() => { followLoading = null; }));
  const [m, profiles] = await Promise.all([pd.meta(), getProfiles()]);
  return { ...followUp({ ...raw, users: m.users, profiles, today: todayIn(tz), tz }), at: raw.at, partial: raw.partial };
}

// Feed del equipo: contactos registrados en la app + notas de Pipedrive cargadas desde OrderBrain.
export async function teamFeed() {
  const local = touchesSince(Date.now() - 14 * 864e5).slice(-40).reverse().map(t => ({ at: t.at, author: t.byName, org: byId.get(t.schoolId)?.name || "", schoolId: t.schoolId, title: outcomeById(t.outcome)?.label || "", channel: t.channel, demo: !!t.demo }));
  if (local.length >= 10) return local;
  const notes = await pd.recentNotes(80).catch(() => []);
  const o2s = orgToSchool();
  const remote = notes.filter(n => /OrderBrain SDR|desde el asistente/i.test(n.content || "")).slice(0, 25).map(n => ({
    at: String(n.add_time).replace(" ", "T") + "Z", author: n.user?.name || "", org: n.organization?.name || "", schoolId: o2s.get(n.org_id) || null,
    title: (stripHtml(n.content).split("\n")[0] || "").split(" · ").pop() || "Nota",
  }));
  const seen = new Set(local.map(l => l.org + l.title));
  return [...local, ...remote.filter(r => !seen.has(r.org + r.title))].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 30);
}

// ---------- demos (lib/demos.js): resultado, lista del equipo y métricas para líderes
// Se piden a Pipedrive por persona (no las cuentas generales), por vencimiento, hasta pasar el comienzo del período;
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
  const k = `demos:${(await cacheGet("demos:ver")) || 0}:${from}:${to}`, hit = await cacheGet(k);
  if (hit) return hit;
  if (!demoLoading.has(k)) demoLoading.set(k, (async () => {
    let partial = false; const out = [];
    const owners = [...new Set((await pd.meta()).users.map(u => pd.realOwner(u.id)).filter(Boolean))];
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
export async function teamDemos(tz) {
  const t = todayIn(tz), raw = await demosRaw(addDays(t, -31), addDays(t, 15));
  const [m, profiles] = await Promise.all([pd.meta(), getProfiles()]);
  return { ...demoBoard(raw.demos, { users: m.users, profiles, free: FREE_OWNERS, today: t, tz }), at: raw.at, partial: raw.partial };
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
export async function metricsDemos(tz, { days = 7, country = "" } = {}) {
  const t = todayIn(tz), period = MX.periodOf(t, days);
  const [created, held, { m, profiles, users }] = await Promise.all([createdDemos(addDays(period.from, -1)), demosRaw(addDays(t, period.days <= 30 ? -31 : -91), addDays(t, 15)), mxBase()]);
  const ids = [...new Set([...created.acts, ...held.demos].map(a => Number(a.deal_id)).filter(Boolean))].sort((a, b) => a - b);
  const dk = `mx:demodeals:${crypto.createHash("sha1").update(ids.join(",")).digest("hex").slice(0, 16)}`;
  const dd = await cached(dk, 600, async () => ({ at: new Date().toISOString(), deals: await pd.dealsByIds(ids) }));
  const deals = new Map(dd.deals.map(d => [Number(d.id), d])), ctx = dealCtx(m);
  const countryOf = a => a.country || (deals.get(Number(a.deal_id)) ? MX.dealCountry(deals.get(Number(a.deal_id)), ctx) : "");
  const opts = { users, profiles, free: FREE_OWNERS, period, tz, country, countryOf };
  const loaded = MX.demosLoaded(created.acts, opts), h = MX.demosHeld(held.demos, { ...opts, now: Date.now() });
  const countries = [...new Set([...created.acts, ...held.demos].map(a => countryOf(a) || "?"))].sort((x, y) => (x === "?") - (y === "?") || x.localeCompare(y, "es"));
  return { period, tz, country, countries, at: { created: created.at, held: held.at, deals: dd.at }, partial: { created: !!created.partial, held: !!held.partial },
    loaded, held: { totals: h.totals, byOwner: h.byOwner, byLoader: h.byLoader }, deals: MX.demoDeals(h.items, deals, { stageOf: ctx.stageOf }) };
}
export async function metricsDeals(tz, { days = 7, country = "" } = {}) {
  const period = MX.periodOf(todayIn(tz), days), [raw, { m, profiles, users }] = await Promise.all([dealsRaw(addDays(period.from, -1)), mxBase()]);
  const sum = MX.dealsSummary({ ...raw, period, tz, country, users, profiles, free: FREE_OWNERS, lostReasons: LOST_REASONS, ...dealCtx(m) });
  sum.open.pipes = sum.open.pipes.map(p => ({ ...p, name: m.pipes?.[p.pipe] || "" }));
  return { period, tz, country, at: raw.at, partial: raw.partial, ...sum };
}
// D: lo registrado desde la app (sin pedidos a Pipedrive)
export async function metricsContacts(tz, { days = 7, country = "" } = {}) {
  const period = MX.periodOf(todayIn(tz), days), w = touchWindow(fromMsOf(period.from, tz)), profiles = await getProfiles();
  return { period, tz, country, at: new Date().toISOString(), max: w.max,
    ...MX.contactsSummary(w.list, { period, tz, country, countryOf: t => byId.get(t.schoolId)?.country || "", outcomes: OUTCOMES, profiles, cut: w.cut }) };
}
// G: el registro de archivados de la app (no el estado del colegio: un cliente archivado se muestra como cliente)
export async function metricsArchived(tz, { days = 7, country = "" } = {}) {
  const period = MX.periodOf(todayIn(tz), days), profiles = await getProfiles();
  return { period, tz, country, at: new Date().toISOString(), ...MX.archivedSummary(allArchived(), { period, tz, country, countryOf: id => byId.get(id)?.country || "", reasons: ARCHIVE_REASONS, profiles }) };
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
