// Agenda propia, bandeja caliente, cola de hoy, ranking y actividad del equipo.
import * as pd from "../pipedrive.js";
import { allMatches, byId, getArchived, getMatch, isFresh, orgToSchool, schools, touchesFor, touchesSince } from "../store.js";
import { DAILY_GOAL, DEAL_FIELDS, TYPE_LABEL } from "../config.js";
import { countAttempts, outcomeById, scoreSchool } from "../playbook.js";
import { safeTz, todayIn } from "../time.js";
import { stripHtml } from "./util.js";
import { appCountry, countryFromOpt } from "./records.js";
import { effMatch, potentialFor, schoolListItem } from "./list.js";

// ---------- agenda propia
// Evento entre paréntesis al final del título: «Colegio Magna – MZA (EduExperience Mendoza 2026)» → «EduExperience Mendoza 2026».
// Solo si lleva un año, para no confundirlo con una ciudad entre paréntesis.
export const eventOf = t => { const s = String(t || "").trim(); return (s.match(/\(([^()]*\b20\d\d\b[^()]*)\)\s*$/) || s.match(/\s[–—-]\s*([^–—()]*\b20\d\d\b[^–—()]*)$/))?.[1].trim() || ""; };
// El nombre de la institución sin el evento del prospecto: «Colegio X (EduExperience Mendoza 2026)» → «Colegio X»
export const withoutEvent = t => { const e = eventOf(t); return e ? String(t).replace(/\s*\([^()]*\)\s*$/, m => m.includes(e) ? "" : m).replace(new RegExp(`\\s[–—-]\\s*${e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), "").trim() || t : t; };
// ¿archivado en la app? El colegio de la base o la ficha de Pipedrive (pd-lead-…/pd-org-…; un prospecto con organización
// se archiva como su organización). Lo usan la agenda (sesiones y bandeja caliente) y la bandeja de prospectos nuevos.
export const archivedRef = ({ schoolId = null, leadId = null, orgId = null }) => !!((schoolId && getArchived(schoolId)) || (leadId && getArchived(`pd-lead-${leadId}`)) || (orgId && getArchived(`pd-org-${orgId}`)));
// nombre normalizado → colegio de la base (si dos se llaman igual, el último, como antes): se rearma solo si la base creció
let nameIdx = null, nameIdxN = -1;
const schoolsByName = () => { if (nameIdxN !== schools.length) { nameIdx = new Map(schools.map(s => [pd.norm(s.name), s.id])); nameIdxN = schools.length; } return nameIdx; };
export async function myActivities(user) {
  if (!user.pdUserId) return { warning: "Tu email no coincide con ningún usuario de Pipedrive.", items: [] };
  // Las lecturas que no dependen una de otra van juntas: las opciones de los campos y los tipos de actividad (de la cuenta,
  // con su copia) salen a la par de las actividades; prospectos y personas, a la par apenas se sabe cuáles son.
  // (el nombre de cada tipo como está en Pipedrive, «Tarea interna», «No Show»…: la Agenda le da su botón a cada uno)
  const fieldsP = pd.loadFieldOptions().catch(() => {}), typesP = pd.activityTypes().catch(() => []);
  const list = await pd.activities({ ownerId: user.pdUserId, done: false, limit: 500 });
  const o2s = orgToSchool();
  // Actividades sin organización: muchas están atadas a un prospecto (lead) o a una persona. Se trae su nombre
  // (y la organización del prospecto, si tiene) para que se sepa de quién es cada una.
  // (los prospectos se traen todos: su título dice el evento, «… (EduExperience Mendoza 2026)», y sus campos la ciudad)
  const [leadList, personList] = await Promise.all([
    pd.leadsByIds([...new Set([...list.filter(a => !a.org_id && a.lead_id), ...list.filter(a => a.org_id && a.lead_id)].map(a => a.lead_id))], user.pdUserId).catch(() => []),
    pd.personsByIds([...new Set(list.filter(a => !a.org_id && a.person_id).map(a => a.person_id))]).catch(() => []), fieldsP]);
  const leads = new Map(leadList.map(l => [l.id, l])), persons = new Map(personList.map(p => [p.id, p]));
  const orgOf = a => a.org_id || leads.get(a.lead_id)?.orgId || persons.get(a.person_id)?.orgId || null;
  // Organizaciones que todavía no se cruzaron: se buscan por nombre exacto en la base de colegios.
  const unknown = [...new Set(list.map(orgOf).filter(id => id && !o2s.has(id)))];
  const orgName = new Map(), orgPlace = new Map();
  const [orgList, types] = await Promise.all([unknown.length ? pd.orgsByIds(unknown).catch(() => []) : [], typesP]);
  if (orgList.length) {
    const byName = schoolsByName();
    for (const o of orgList) { orgName.set(o.id, o.name); orgPlace.set(o.id, o); const sid = byName.get(pd.norm(o.name)); if (sid) o2s.set(o.id, sid); }
  }
  const strip = h => String(h || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
  const tnames = new Map(types.map(t => [t.key, t.name]));
  return { items: list.map(a => {
    const org = orgOf(a), lead = leads.get(a.lead_id), person = persons.get(a.person_id);
    // zona y evento, solo con lo que dicen Pipedrive y la base (no se deduce nada más)
    const sch = byId.get(o2s.get(org)), op = orgPlace.get(org), opt = (k, id) => id ? pd.optionLabel(DEAL_FIELDS[k], id) || "" : "";
    const zone = { city: sch?.city || opt("ciudad", lead?.ciudadOpt) || op?.city || "", region: opt("estado", lead?.estadoOpt) || op?.region || "",
      country: sch?.country || countryFromOpt(lead?.paisOpt) || appCountry(op?.country) || "", event: eventOf(lead?.title) || eventOf(a.subject) };
    const who = lead?.title || orgName.get(org) || person?.name || "";
    const url = a.deal_id ? `${pd.PD_WEB}/deal/${a.deal_id}` : a.lead_id ? `${pd.PD_WEB}/leads/inbox/${a.lead_id}` : org ? `${pd.PD_WEB}/organization/${org}` : a.person_id ? `${pd.PD_WEB}/person/${a.person_id}` : `${pd.PD_WEB}/activities/list`;
    return { id: a.id, subject: a.subject, type: a.type, typeLabel: TYPE_LABEL[a.type] || tnames.get(a.type) || a.type, date: a.due_date, time: a.due_time || "", orgId: org, dealId: a.deal_id, schoolId: o2s.get(org) || null,
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
// ciudad o país → pd.norm: miles de colegios comparten ciudad y normalizar es lo caro de filtrar por zona
const zoneNorm = new Map(), znorm = v => { let n = zoneNorm.get(v); if (n === undefined) { if (zoneNorm.size > 20000) zoneNorm.clear(); zoneNorm.set(v, n = pd.norm(v)); } return n; };
export function prospectQueue({ countries = [], limit = 40, excludeOrgIds = new Set(), userId = null, zone = "" } = {}) {
  // Primero el puntaje de todos (liviano) y recién a los `limit` mejores se les arma la ficha de lista: armarla para los
  // 22.000 de la base costaba ≈170 ms en cada Hoy. El orden es el mismo de antes (sort estable: a igual puntaje, el de la base).
  const out = [], z = pd.norm(zone);
  for (const s of schools) {
    if (countries.length && !countries.includes(s.country)) continue;
    if (z && !` ${znorm(s.city)} `.includes(` ${z} `) && znorm(s.country) !== z) continue;
    const m = getMatch(s.id);
    if (m?.orgId && excludeOrgIds.has(m.orgId)) continue;
    if (isFresh(m) && m.ownerId && m.ownerId !== userId) continue;
    const r = withPotential(s, scoreSchool(s, effMatch(s), touchesFor(s.id)));
    if (r) out.push({ s, score: r.score, reasons: r.reasons });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit).map(x => ({ ...schoolListItem(x.s), score: x.score, reasons: x.reasons }));
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
