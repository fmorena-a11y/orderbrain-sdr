// «Hoy» del líder (pedido del líder de SDR: «a los líderes hacerles su propia interfaz para lo que les interesa a ellos, que sea
// multitenant y que cada uno entre con su mail»). Lógica pura del panel del día: una fila por persona de su gente y la lista
// «Para mirar hoy». Las rutas están en lib/lead-api.js y la pantalla en public/js/leadhome.js. Pruebas en test/leadview.test.mjs.
// Cuatro partes independientes (cada una se pide y se muestra por separado; si una falla, las otras siguen):
//  · acts (actsPart): pendientes de hoy, hechas hoy y vencidas por persona, de la lectura de «Actividad por persona» de Métricas.
//  · demos (demosPart): demos de hoy y de mañana, pasadas sin marcar y «Cuentan» del mes (la regla de Equipo › Demos).
//  · inbound (inboundPart): inbound sin contactar de los últimos 7 días (la definición de Métricas › Inbound) con el plazo de 72 h
//    del reparto, y los del reparto de Slack que todavía no se procesaron.
//  · deals (dealsPart): tratos abiertos de venta y cuántos piden atención (lo mismo que marca la vista «Tratos abiertos»).
// REGLA DE NÚMEROS: cada número tiene una definición exacta (DEFS, la pantalla la muestra); si la lectura vino cortada o no se
// sabe, null (la pantalla pone «?»). Nunca se completa con un 0.
import { fromUtc } from "./time.js";
import { actDay, localDay, isAircall } from "./metrics.js";
import { DEADLINE_H } from "./inbound.js";
import { STALE_DAYS } from "./dealsview.js";

export const LATE_MANY = 10; // «muchas vencidas»: desde cuántas una persona entra en «Para mirar hoy»
export const SOON_H = 24;    // «por vencer»: le quedan 24 h o menos de las 72
export const INB_DAYS = 7;   // inbound: los que entraron en los últimos 7 días (la lectura de Métricas con «7 días»)
export const LIST_MAX = 40;  // filas de cada lista (las más urgentes)
export const PARTS = ["acts", "demos", "inbound", "deals"];
// el orden de «Para mirar hoy»: lo más urgente arriba
export const RANK = { demosToday: 10, inbDeadline: 15, unmarked: 20, inbNew: 25, lateMany: 30, inbTodo: 35, deals: 40 };

// Qué es cada número (la pantalla lo muestra en el title y en el pie de cada tarjeta)
export const DEFS = {
  today: "Actividades sin hacer con fecha de hoy (cualquier tipo), a nombre de la persona en Pipedrive.",
  doneToday: "Actividades que la persona marcó como hechas hoy en Pipedrive (sin las automáticas que crean las cuentas generales).",
  overdue: "Actividades sin hacer con fecha anterior a hoy, a nombre de la persona. Es el mismo número que «Vencidas hoy» de Métricas.",
  inbCalls: "Llamadas de inbound vencidas: actividades sin hacer con asunto «Llamar · inbound…», «Llamar · SDR revival…» o «Llamar · referido de padre…» (las que crea Tus inbound) con fecha anterior a hoy.",
  demosToday: "Demos con fecha de hoy que da o cargó la persona, sin las canceladas.",
  demosTomorrow: "Demos con fecha de mañana que da o cargó la persona, sin las canceladas.",
  unmarked: "Demos del mes en curso y de los últimos 7 días que ya pasaron y no están hechas en Pipedrive ni marcadas desde la app.",
  counts: "Demos hechas del mes que cuentan para el objetivo, por quién la cargó: en un SDR, outbound + inbound ÷ 2; en un account, sin ponderar. La misma regla de Equipo › Demos.",
  inbNew: `Prospectos y tratos con Fuente «Inbound - …» que entraron en los últimos ${INB_DAYS} días y no tienen ninguna llamada, WhatsApp, mail o contacto decisor hecho. Por el campo SDR o, vacío, el dueño. La definición de Métricas › Inbound.`,
  inbLate: `De los sin contactar, los que entraron hace más de ${DEADLINE_H} h.`,
  inbSoon: `De los sin contactar, a los que les quedan ${SOON_H} h o menos de las ${DEADLINE_H}.`,
  inbTodo: "Leads del reparto de Slack (últimos 30 días) que le tocaron a la persona y todavía no se procesaron: no están en Pipedrive.",
  deals: "Tratos abiertos de los embudos de venta donde la persona es dueña o SDR (sin embudos de clientes ni etapas muertas).",
  attn: `Tratos abiertos que piden atención: sin próxima actividad, con la próxima vencida o con más de ${STALE_DAYS} días en la misma etapa.`,
};

const lc = e => String(e || "").trim().toLowerCase();
const uniq = list => [...new Map((list || []).filter(Boolean).map(a => [a.id, a])).values()];
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
// a quién toca: [{ id, name, n }] de más a menos (después por nombre); name puede faltar (la pantalla lo busca en su lista)
function whoList(map) { return [...map.values()].sort((a, b) => b.n - a.n || String(a.name || "").localeCompare(String(b.name || ""), "es")); }
function bump(map, id, name = "", n = 1) { const k = id ?? `n:${name}`; const x = map.get(k) || { id: id ?? null, name: name || "", n: 0 }; x.n += n; if (name && !x.name) x.name = name; map.set(k, x); }

// ---------- personas: la gente del equipo elegido (líderes y miembros) o, sin equipo o con «Toda la cuenta», todos los usuarios
// del Pipedrive (sin las cuentas generales). role: «ae» (rol del perfil o los accounts por defecto, la regla de Equipo › Demos),
// «sdr» (rol del perfil) o "" (todavía no eligió). app: tiene perfil (usa la app). open: quien mira puede abrir su detalle (su
// gente con canLead, o él mismo). Orden: SDR, accounts y el resto; adentro, alfabético (sin puestos).
export function peopleFor({ users = [], profiles = {}, free = new Set(), team = null, ae = new Set(), lead = false, meId = null, canLead = () => false }) {
  const pos = r => r === "sdr" ? 0 : r === "ae" ? 1 : 2;
  return users.filter(u => Number(u.id) && !free.has(Number(u.id)) && (!team || team.ids.has(Number(u.id)))).map(u => {
    const e = lc(u.email), pr = profiles[e] || null, id = Number(u.id);
    return { id, name: pr?.name || u.name || e, role: pr?.role === "ae" || ae.has(id) ? "ae" : pr?.role === "sdr" ? "sdr" : "", app: !!pr, self: id === Number(meId),
      open: id === Number(meId) || !!canLead(lead, { id, email: e }) };
  }).sort((a, b) => pos(a.role) - pos(b.role) || a.name.localeCompare(b.name, "es", { sensitivity: "base" }) || a.id - b.id);
}

// ---------- actividades de hoy. done y pending: las de lib/sales.js leadActs (compactAct de toda la cuenta); partial: qué lectura
// se cortó ({ updated, ahead, pending }): de la que se cortó no hay número. ids: Set con los ids de la gente.
const INB_CALL = /^\s*Llamar · (inbound|SDR revival|referido de padre)/i;
export function actsPart({ done = [], pending = [], partial = {}, at = null, ids = new Set(), tz, today, free = new Set() }) {
  const known = { pending: !partial?.pending, done: !partial?.updated }, rows = new Map();
  const row = id => { let r = rows.get(id); if (!r) rows.set(id, r = { today: 0, doneToday: 0, overdue: 0, inbCalls: 0 }); return r; };
  for (const id of ids) row(Number(id));
  for (const a of uniq(pending)) {
    const o = Number(a.owner_id); if (a.deleted || a.done || !a.due_date || !ids.has(o)) continue;
    const d = actDay(a, tz); if (!d) continue;
    if (d === today) row(o).today++;
    else if (d < today) { row(o).overdue++; if (INB_CALL.test(a.subject || "")) row(o).inbCalls++; }
  }
  for (const a of uniq(done)) {
    const o = Number(a.owner_id); if (a.deleted || !a.done || !a.done_time || !ids.has(o)) continue;
    if (localDay(a.done_time, tz) !== today) continue;
    if (free.has(Number(a.creator_user_id)) && !isAircall(a.type)) continue; // automática (diio, formularios): no la hizo la persona
    row(o).doneToday++;
  }
  const P = ["today", "overdue", "inbCalls"], by = {}, totals = { today: 0, doneToday: 0, overdue: 0, inbCalls: 0 };
  for (const [id, r] of rows) {
    for (const k of Object.keys(totals)) totals[k] += r[k];
    by[id] = { ...r, ...(known.pending ? {} : Object.fromEntries(P.map(k => [k, null]))), ...(known.done ? {} : { doneToday: null }) };
  }
  if (!known.pending) for (const k of P) totals[k] = null;
  if (!known.done) totals.doneToday = null;
  const many = known.pending ? [...rows].filter(([, r]) => r.overdue >= LATE_MANY).map(([id, r]) => ({ id, name: "", n: r.overdue })).sort((a, b) => b.n - a.n || a.id - b.id) : [];
  const alerts = [];
  if (many.length) alerts.push({ key: "lateMany", rank: RANK.lateMany, n: many.length, text: `${plural(many.length, "persona", "personas")} con ${LATE_MANY} o más actividades vencidas`,
    sub: "", who: many, go: { anchor: "people" }, label: "Ver por persona", def: DEFS.overdue });
  return { at, known, by, totals, alerts };
}

// ---------- demos. month: el tablero del mes en curso (lib/demos.js monthBoard, lo que muestra Equipo › Demos); win: { items,
// partial } con las de los últimos 7 días hasta mañana (mismo formato de fila). Con equipo, las dos listas ya vienen filtradas
// (las que da o cargó alguien del equipo). Una demo es «de» una persona si la da (dueño) o la cargó.
const brief = it => ({ id: it.id, date: it.date, time: it.time || "", name: it.name || "", schoolId: it.schoolId || null, record: it.record || null, ownerId: it.ownerId || null, owner: it.owner || "",
  setterId: it.setterId || null, setter: it.setter || "", ...(it.auto ? { auto: true } : {}), state: it.state });
const byWhen = (a, b) => (a.date + (a.time || "99")).localeCompare(b.date + (b.time || "99")) || a.id - b.id;
export function demosPart({ month = null, win = null, ids = new Set(), today, tomorrow }) {
  const known = !!month && !!win && !month.partial && !win.partial;
  const all = new Map(); for (const it of [...(win?.items || []), ...(month?.items || [])]) all.set(it.id, it);
  const list = [...all.values()].sort(byWhen), live = list.filter(it => it.state !== "canceled");
  const dToday = live.filter(it => it.date === today), dTom = live.filter(it => it.date === tomorrow), unmarked = list.filter(it => it.state === "unmarked");
  const of = (l, id) => l.filter(it => Number(it.ownerId) === id || Number(it.setterId) === id).length;
  const mrow = new Map((month?.rows || []).filter(r => r.id).map(r => [Number(r.id), r])), by = {};
  for (const raw of ids) {
    const id = Number(raw), m = mrow.get(id);
    by[id] = known ? { today: of(dToday, id), tomorrow: of(dTom, id), unmarked: of(unmarked, id), counts: m ? m.counts : 0, done: m?.done || 0, out: m?.out || 0, in: m?.in || 0, booked: m?.booked || 0 }
      : { today: null, tomorrow: null, unmarked: null, counts: null, done: null, out: null, in: null, booked: null };
  }
  const totals = known ? { today: dToday.length, tomorrow: dTom.length, unmarked: unmarked.length, counts: month.totals?.counts ?? null, done: month.totals?.done ?? null }
    : { today: null, tomorrow: null, unmarked: null, counts: null, done: null };
  const alerts = [];
  // a quién toca: quien la da; si no es de la gente que se mira (la da un account de otro equipo), quien la cargó
  const touch = (w, it) => { const own = it.ownerId != null && ids.has(Number(it.ownerId)), set = it.setterId != null && ids.has(Number(it.setterId));
    if (!own && set) bump(w, it.setterId, it.setter || ""); else bump(w, it.ownerId, it.owner || (it.ownerId ? "" : "sin dueño")); };
  if (known && dToday.length) {
    const w = new Map(); for (const it of dToday) touch(w, it);
    alerts.push({ key: "demosToday", rank: RANK.demosToday, n: dToday.length, text: `${plural(dToday.length, "demo", "demos")} hoy`, sub: "", who: whoList(w), go: { anchor: "demos" }, label: "Ver las demos", def: DEFS.demosToday });
  }
  if (known && unmarked.length) {
    const w = new Map(); for (const it of unmarked) touch(w, it);
    alerts.push({ key: "unmarked", rank: RANK.unmarked, n: unmarked.length, text: `${plural(unmarked.length, "demo pasada", "demos pasadas")} sin marcar`, sub: "la marca quien la dio (o vos)", who: whoList(w),
      go: { view: "equipo" }, label: "Marcar en Equipo", def: DEFS.unmarked });
  }
  return { at: { month: month?.at || null, window: win?.at || null }, known, period: month?.period ? { key: month.period.key, label: month.period.label } : null, by, totals,
    today: dToday.slice(0, LIST_MAX).map(brief), tomorrow: dTom.slice(0, LIST_MAX).map(brief), unmarked: unmarked.slice(0, LIST_MAX).map(brief), alerts };
}

// ---------- inbound. inb: lo de lib/sales.js metricsInbound con «7 días» (lib/metrics.js inboundSummary; kinds.all = todos los
// tipos, cada uno una vez): people (por el campo SDR o, vacío, el dueño) y pending (sin contactar, los 40 más viejos primero).
// El plazo: 72 h desde que entró (DEADLINE_H, la regla del reparto). Si hay más sin contactar que los 40 de la lista, cuántos
// pasaron el plazo solo se sabe si el más nuevo de la lista todavía no lo pasó; si no, null.
// slack: { on, items: [{ email, hoursLeft, state }] } (lib/inbound-run.js listFor, ya filtrado a quien mira) o null (no se pudo leer).
// emails: Map(email → id) de la gente.
export const slackNeeds = st => !st || st.status === "error" || st.status === "partial";
export function inboundPart({ inb = null, slack = null, ids = new Set(), emails = new Map(), now = Date.now() }) {
  const g = inb?.kinds?.all || null, known = !!g && !!inb.known?.entries && !!inb.known?.contacts;
  const left = e => { const t = Date.parse(e); return Number.isFinite(t) ? Math.round(DEADLINE_H - (now - t) / 36e5) : null; };
  const list = known ? (g.pending || []).map(p => ({ id: p.id, rec: p.rec, title: p.title || "", entry: p.entry, personId: p.personId || null, person: p.person || "", ...(p.free ? { free: true } : {}), left: left(p.entry) })) : [];
  const total = known ? g.totals?.notContacted ?? null : null, cut = total != null && total > list.length, newest = list.at(-1);
  const isLate = x => x.left != null && x.left <= 0, isSoon = x => x.left != null && x.left > 0 && x.left <= SOON_H;
  // con la lista cortada (los 40 más viejos): si el más nuevo de la lista ya pasó el plazo, puede haber más que no se ven
  const lateKnown = !cut || (!!newest && !isLate(newest)), soonKnown = !cut || (!!newest && newest.left != null && newest.left > SOON_H);
  const prow = new Map((known ? g.people || [] : []).filter(r => r.id).map(r => [Number(r.id), r])), by = {};
  for (const raw of ids) {
    const id = Number(raw), r = prow.get(id), mine = list.filter(x => Number(x.personId) === id);
    by[id] = { new: known ? (r ? r.notContacted : 0) : null, entries: known ? (r ? r.entries : 0) : null,
      late: known && lateKnown ? mine.filter(isLate).length : null, soon: known && soonKnown ? mine.filter(isSoon).length : null };
  }
  const totals = { new: total, entries: known ? g.totals?.entries ?? null : null, late: known && lateKnown ? list.filter(isLate).length : null, soon: known && soonKnown ? list.filter(isSoon).length : null };
  const alerts = [];
  if (known && total > 0) {
    // a quién toca: las filas por persona de Métricas (exactas aunque la lista venga cortada)
    const w = new Map(); for (const r of g.people || []) if (r.notContacted > 0) bump(w, r.id ?? null, r.name || (r.free ? "cuentas generales" : r.none ? "sin SDR cargado" : r.id ? "" : "sin dueño"), r.notContacted);
    const urgent = (totals.late || 0) + (totals.soon || 0) > 0 || totals.late == null;
    const bits = [totals.late == null ? `${list.length} o más ya pasaron las ${DEADLINE_H} h` : totals.late ? `${totals.late} ya ${totals.late === 1 ? "pasó" : "pasaron"} las ${DEADLINE_H} h` : "",
      totals.soon ? `${totals.soon} ${totals.soon === 1 ? "vence" : "vencen"} en menos de ${SOON_H} h` : ""].filter(Boolean);
    alerts.push({ key: urgent ? "inbDeadline" : "inbNew", rank: urgent ? RANK.inbDeadline : RANK.inbNew, n: total, text: `${plural(total, "inbound", "inbound")} sin contactar${bits.length ? `: ${bits.join(" y ")}` : ""}`,
      sub: `entraron en los últimos ${INB_DAYS} días`, who: whoList(w), go: { anchor: "inbound" }, label: "Ver cuáles", def: DEFS.inbNew });
  }
  // el reparto de Slack: lo que todavía no está en Pipedrive
  let sl = null;
  if (slack) {
    const todo = (slack.items || []).filter(x => slackNeeds(x.state)), w = new Map();
    let n = 0, unassigned = 0, soon = 0;
    for (const x of todo) {
      const id = emails.get(lc(x.email)) ?? null;
      if (!lc(x.email)) { unassigned++; continue; }
      if (id == null || !ids.has(Number(id))) continue; // de alguien que no es de la gente que se mira
      n++; bump(w, Number(id)); if (x.hoursLeft != null && x.hoursLeft <= SOON_H) soon++;
      by[id] = { ...(by[id] || { new: null, entries: null, late: null, soon: null }), todo: (by[id]?.todo || 0) + 1 };
    }
    for (const raw of ids) if (by[Number(raw)] && by[Number(raw)].todo == null) by[Number(raw)].todo = 0;
    sl = { on: !!slack.on, error: slack.error || "", todo: n, soon, unassigned };
    if (n) alerts.push({ key: "inbTodo", rank: RANK.inbTodo, n, text: `${plural(n, "inbound del reparto", "inbound del reparto")} sin procesar`,
      sub: `todavía no ${n === 1 ? "está" : "están"} en Pipedrive${soon ? ` · a ${soon} ${soon === 1 ? "le quedan" : "les quedan"} ${SOON_H} h o menos` : ""}`, who: whoList(w), go: { view: "inbound" }, label: "Ir a Tus inbound", def: DEFS.inbTodo });
  }
  return { at: inb?.at || null, known, period: inb?.period || null, by, totals, cut, slack: sl, list: list.slice(0, LIST_MAX), alerts };
}

// ---------- tratos. rows: las filas de lib/dealsview.js (dealRow) del equipo o de toda la cuenta. Un trato es «de» una persona si
// es su dueña o su SDR (lo mismo que «Míos» de Tratos abiertos). Los totales cuentan cada trato una vez.
export const needsAttention = r => (!r.next && !r.nextUnknown) || !!r.stale || !!r.next?.overdue;
export function dealsPart({ rows = [], truncated = false, at = null, ids = new Set() }) {
  const known = !truncated, cnt = l => ({ n: l.length, attn: l.filter(needsAttention).length, noNext: l.filter(r => !r.next && !r.nextUnknown).length, stale: l.filter(r => r.stale).length, overdue: l.filter(r => r.next?.overdue).length });
  const none = { n: null, attn: null, noNext: null, stale: null, overdue: null }, by = {};
  for (const raw of ids) { const id = Number(raw); by[id] = known ? cnt(rows.filter(r => Number(r.owner?.id) === id || Number(r.sdr?.id) === id)) : { ...none }; }
  const totals = known ? cnt(rows) : { ...none }, alerts = [];
  if (known && totals.attn) {
    // a quién toca: la dueña; si no es de la gente que se mira (el trato entra por su SDR), su SDR
    const w = new Map(); for (const r of rows.filter(needsAttention)) {
      const own = r.owner?.id != null && ids.has(Number(r.owner.id)), sdr = r.sdr?.id != null && ids.has(Number(r.sdr.id));
      if (!own && sdr) bump(w, r.sdr.id, r.sdr.name || ""); else bump(w, r.owner?.id ?? null, r.owner?.name || (r.owner?.id ? "" : "sin dueño"));
    }
    const bits = [totals.noNext ? `${totals.noNext} sin próximo paso` : "", totals.overdue ? `${totals.overdue} con la próxima vencida` : "", totals.stale ? `${plural(totals.stale, "quieto", "quietos")} (más de ${STALE_DAYS} días en la etapa)` : ""].filter(Boolean);
    alerts.push({ key: "deals", rank: RANK.deals, n: totals.attn, text: `${plural(totals.attn, "trato pide", "tratos piden")} atención`, sub: bits.join(" · "), who: whoList(w), go: { deals: "team" }, label: "Ver los tratos", def: DEFS.attn });
  }
  return { at, known, staleDays: STALE_DAYS, by, totals, alerts };
}

// «Para mirar hoy»: las alertas de las partes que llegaron, lo más urgente arriba
export const alertsOf = parts => PARTS.flatMap(p => parts?.[p]?.alerts || []).sort((a, b) => a.rank - b.rank || b.n - a.n);

// ---------- detalle de una persona: su agenda (lib/sales.js myActivities, hasta 500 sin hacer por vencimiento) en la zona de quien
// mira: las de hoy por hora (sin hora al final) y las vencidas de la más reciente a la más vieja. cut: Pipedrive devolvió 500
// (puede haber más: los números van «?»).
export function personDay(items = [], { tz, today, max = 100, limit = 500 } = {}) {
  const pick = a => ({ id: a.id, subject: a.subject || "", type: a.type || "", typeLabel: a.typeLabel || a.type || "", who: a.who || "", kind: a.kind || "", schoolId: a.schoolId || null, record: a.record || null, url: a.url || "", city: a.city || "" });
  const loc = items.filter(a => a?.date).map(a => { const l = fromUtc(String(a.date).slice(0, 10), String(a.time || "").slice(0, 5), tz); return { ...pick(a), date: l.date, time: l.time || "" }; });
  const k = a => a.date + (a.time || "99:99");
  const now = loc.filter(a => a.date === today).sort((a, b) => k(a).localeCompare(k(b)) || a.id - b.id), late = loc.filter(a => a.date < today).sort((a, b) => k(b).localeCompare(k(a)) || a.id - b.id);
  const cut = items.length >= limit;
  return { today: now.slice(0, max), overdue: late.slice(0, max), n: { today: cut ? null : now.length, overdue: cut ? null : late.length, next: cut ? null : loc.filter(a => a.date > today).length }, cut };
}
