// Historial de la ficha (línea de tiempo) y el resumen para la próxima llamada.
import * as pd from "../pipedrive.js";
import { byId, cacheGetMany, cacheSet, canonicalId, getMatch, isFresh, mailsFor, touchesFor } from "../store.js";
import { TYPE_LABEL } from "../config.js";
import { fromUtc, todayIn } from "../time.js";
import { callSummary as aiCallSummary, aiEnabled } from "../ai.js";
import { buildTimeline, callSummary, page } from "../timeline.js";
import { bad } from "../text.js";
import { checkSchool } from "./match.js";
import { leadsHere } from "./settle.js";
import { effMatch } from "./list.js";
import { askFor, relatedOrgs } from "./detail.js";

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
  catch (e) { return { summary: { ...rules, aiNote: "La IA no está disponible ahora: va el resumen por reglas." } }; }
}
