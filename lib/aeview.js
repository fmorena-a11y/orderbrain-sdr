// «Hoy» del account (pedido del líder de SDR: «hacerle a los accounts sus propias sesiones y enfocarte en los tratos y darle
// importancia a sus tareas, separando lo que es un SDR o un account»). Lógica pura: con los tratos abiertos de quien entra
// (filas de dealRow, lib/dealsview.js) y sus actividades sin hacer (sales.myActivities) arma, en la zona de quien mira, las
// demos de hoy y de mañana (y las de antes que quedaron sin marcar), las tareas vencidas y de hoy agrupadas por trato, los
// tratos que piden atención (cada uno una vez, con el motivo más grave primero) y el resumen de arriba.
// Nunca se inventa: si Pipedrive cortó una lista, el número que depende de ella va null (la pantalla pone «?» y avisa).
// Pruebas en test/aeview.test.mjs.
import { fromUtc, todayIn, addDays } from "./time.js";
import { nowIn } from "./dealsview.js";
import { demoResult, heldState } from "./demos.js";

export const ACTS_LIMIT = 500; // lo que lee sales.myActivities (y la lectura de demos hechas): con 500 justas, la lista pudo cortarse
const hm = t => String(t || "").slice(0, 5);
const isDemo = a => a.type === "meeting";

// ---------- fechas
// lunes a domingo de la semana de un día (YYYY-MM-DD)
export function weekOf(day) {
  const dow = (new Date(day + "T12:00:00Z").getUTCDay() + 6) % 7;
  const from = addDays(day, -dow);
  return { from, to: addDays(from, 6) };
}
// Una actividad de myActivities (date y time en UTC) en la zona de quien mira. late: su día ya pasó; past: ya pasó (con hora,
// la hora; sin hora, desde que empieza su día: una demo sin hora de hoy ya se puede marcar).
export function localOf(a, tz, now = Date.now()) {
  const l = fromUtc(a.date, hm(a.time), tz), n = nowIn(tz, now);
  return { ...a, date: l.date, time: a.time ? l.time : "", today: l.date === n.date, late: l.date < n.date, past: l.date < n.date || (l.date === n.date && (!a.time || l.time <= n.hm)) };
}
// ¿La lista (ordenada por vencimiento, de la más vieja a la más nueva, hasta ACTS_LIMIT) trae todo lo que vence hasta `until`?
// Si vino cortada, solo se sabe hasta el día anterior al de la última (en UTC: un día de margen por la zona horaria).
export function completeUntil(acts, until, limit = ACTS_LIMIT) {
  if (acts.length < limit) return true;
  const last = acts.reduce((m, a) => (a.date > m ? a.date : m), "");
  return !!last && last > addDays(until, 1);
}

// ---------- demos
// lo que hace falta de un trato para mostrarlo al lado de una demo o de una tarea
const dealBrief = r => r ? { id: r.id, title: r.title, pipe: r.pipe?.name || "", stage: r.stage?.name || "", days: r.days, stale: !!r.stale, value: r.value, currency: r.currency || "" } : null;
// a dónde lleva una actividad: el colegio de la base, la ficha del prospecto u organización, o Pipedrive
const target = (a, row) => ({ schoolId: a.schoolId || row?.school?.id || null, record: a.schoolId || row?.school ? null : a.record || (row?.org ? `org:${row.org.id}` : null), url: a.url || "" });
const actOut = (a, row) => ({ id: a.id, type: a.type, typeLabel: a.typeLabel || a.type, subject: a.subject || "", date: a.date, time: a.time, today: a.today, late: a.late, past: a.past,
  who: a.who || row?.school?.name || row?.org?.name || "", city: a.city || row?.school?.city || "", dealId: a.dealId || null, deal: dealBrief(row), ...target(a, row), ...(a.archived ? { archived: true } : {}) });
const byWhen = (a, b) => `${a.date} ${a.time || "99:99"}`.localeCompare(`${b.date} ${b.time || "99:99"}`) || a.id - b.id;
// Demos (tipo meeting) sin hacer: las de hoy, las de mañana y las de días anteriores que quedaron sin marcar (lo más reciente
// primero). Una de hoy que ya pasó lleva past: la pantalla ofrece «Marcar resultado».
export function demoSections(acts, { tz, now = Date.now(), deals = new Map() } = {}) {
  const t = todayIn(tz, now), tm = addDays(t, 1);
  const l = acts.filter(isDemo).map(a => localOf(a, tz, now)).map(a => actOut(a, deals.get(Number(a.dealId))));
  return { today: l.filter(a => a.date === t).sort(byWhen), tomorrow: l.filter(a => a.date === tm).sort(byWhen), unmarked: l.filter(a => a.date < t).sort((a, b) => byWhen(b, a)) };
}
// Demos de esta semana (lunes a domingo, en la zona de quien mira): las que quedan sin hacer más las ya cerradas (hechas en
// Pipedrive, marcadas desde la app o pasadas a «No Show», tipo lunch). done: actividades HECHAS crudas de Pipedrive
// (due_date, due_time, type y note, o mark = el resultado ya leído de la nota). Cada una una vez (por id). Estados con la regla
// de Métricas (heldState de lib/demos.js).
export function weekDemos(acts, done, { tz, now = Date.now() } = {}) {
  const w = weekOf(todayIn(tz, now)), seen = new Set(), out = { total: 0, held: 0, noshow: 0, canceled: 0, upcoming: 0, unmarked: 0, from: w.from, to: w.to };
  const add = (id, date, state) => {
    if (seen.has(id) || date < w.from || date > w.to) return;
    seen.add(id); out.total++;
    if (state === "appDone" || state === "done") out.held++;
    else if (state === "appNoshow" || state === "noshow") out.noshow++;
    else if (state === "appCanceled") out.canceled++;
    else if (state === "unmarked") out.unmarked++;
    else out.upcoming++;
  };
  for (const a of acts.filter(isDemo)) { const l = localOf(a, tz, now); add(a.id, l.date, heldState({ type: a.type, done: false, mark: null }, l.past, l.today && !l.time)); }
  for (const a of done || []) {
    if (a.type !== "meeting" && a.type !== "lunch") continue;
    const l = fromUtc(a.due_date, hm(a.due_time), tz);
    add(a.id, l.date, heldState({ type: a.type, done: true, mark: a.mark !== undefined ? a.mark : demoResult(a) }, true));
  }
  return out;
}

// ---------- tareas
// Lo que no es demo, vencido o de hoy, agrupado por trato (sin trato: por su ficha, o sola). Dentro del grupo, la más vieja
// primero; los grupos, por su tarea más vieja. late: cuántas son de días anteriores.
export function taskGroups(acts, { tz, now = Date.now(), deals = new Map() } = {}) {
  const t = todayIn(tz, now), groups = new Map();
  for (const a of acts.filter(a => !isDemo(a)).map(a => localOf(a, tz, now)).filter(a => a.date <= t)) {
    const row = deals.get(Number(a.dealId)) || null;
    const key = a.dealId ? `d${a.dealId}` : a.schoolId ? `s${a.schoolId}` : a.record ? `r${a.record}` : `a${a.id}`;
    if (!groups.has(key)) groups.set(key, { key, dealId: a.dealId || null, deal: dealBrief(row), name: row?.school?.name || row?.org?.name || a.who || "", city: row?.school?.city || a.city || "", ...target(a, row), items: [] });
    groups.get(key).items.push(actOut(a, row));
  }
  const list = [...groups.values()].map(g => ({ ...g, items: g.items.sort(byWhen), late: g.items.filter(x => x.late).length }));
  list.forEach(g => { g.oldest = g.items[0].date; });
  return list.sort((a, b) => byWhen(a.items[0], b.items[0]));
}

// ---------- tratos que piden atención
// Motivos, del más grave al menos: propuesta enviada (o más adelante) sin nada por delante; la próxima actividad vencida; sin
// próximo paso; quieto hace más de STALE_DAYS en la etapa. Si Pipedrive dice que tiene una próxima y no se pudo leer
// (nextUnknown), no se cuenta como «sin próximo paso» ni como vencida: no se sabe.
export const WHY = ["proposal", "overdue", "noNext", "stale"];
export function reasonsOf(r) {
  const noNext = !r.next && !r.nextUnknown, overdue = !!r.next?.overdue, out = [];
  if (r.proposal === true && (noNext || overdue)) out.push("proposal");
  if (overdue) out.push("overdue");
  if (noNext) out.push("noNext");
  if (r.stale) out.push("stale");
  return out;
}
// Cada trato una sola vez, ordenado por su motivo más grave; después lo vencido hace más tiempo, lo más quieto y lo de más valor.
export function attention(rows) {
  const rank = w => WHY.indexOf(w[0]);
  return rows.map(r => ({ ...r, why: reasonsOf(r) })).filter(r => r.why.length)
    .sort((a, b) => rank(a.why) - rank(b.why) || (a.next?.overdue && b.next?.overdue ? `${a.next.date} ${a.next.time}`.localeCompare(`${b.next.date} ${b.next.time}`) : 0)
      || (b.days ?? -1) - (a.days ?? -1) || (b.value ?? -1) - (a.value ?? -1) || a.id - b.id);
}
// Sesión «Tus tratos»: los que piden atención, en ese orden. Cada ítem abre la ficha del colegio cruzado o de la organización
// del trato (orgOf: la organización de su persona, si el trato no tiene); sin ninguna va como «deal:<id>» y la sesión lo
// saltea con el motivo. Dos tratos de la misma organización son un solo ítem (la ficha muestra los dos).
export function sessionItems(list, orgOf = () => null) {
  const seen = new Set(), items = [];
  for (const r of list) {
    const org = r.org?.id || orgOf(r) || null;
    const ref = r.school?.id || (org ? `org:${org}` : `deal:${r.id}`);
    if (seen.has(ref)) continue; seen.add(ref);
    items.push({ ref, name: r.school?.name || r.org?.name || r.title || "", city: r.school?.city || "", deal: r.id });
  }
  return items;
}

// ---------- resumen de arriba
export function summarize(rows, { truncated = false } = {}) {
  const by = new Map();
  for (const r of rows) if (r.value != null) by.set(r.currency || "?", (by.get(r.currency || "?") || 0) + r.value);
  // con la lista de tratos cortada no se sabe cuántos son ni cuánto suman
  return { deals: truncated ? null : rows.length, value: truncated ? null : [...by].map(([currency, total]) => ({ currency, total })).sort((a, b) => b.total - a.total), noValue: truncated ? null : rows.filter(r => r.value == null).length };
}

// Todo junto. rows: filas de dealRow de los tratos abiertos de quien entra (o null si no se pudieron leer); acts: sus
// actividades sin hacer (myActivities; null si no se pudieron leer); done: { demos, n, oldest } = sus demos y No Show ya
// cerradas, de cuántas actividades hechas leídas (de la más nueva a la más vieja) y el vencimiento de la más vieja (null si no
// se pudieron leer); truncated: Pipedrive cortó la lista de tratos; orgOf: organización de la persona de un trato.
export function buildToday({ rows, acts, done, tz, now = Date.now(), truncated = false, orgOf, limit = ACTS_LIMIT } = {}) {
  const t = todayIn(tz, now), w = weekOf(t), warnings = [];
  const deals = new Map((rows || []).map(r => [Number(r.id), r]));
  const okDeals = !!rows, okActs = !!acts;
  // hasta dónde llega lo leído de sus actividades sin hacer
  const full = until => okActs && completeUntil(acts, until, limit);
  const demosOk = full(addDays(t, 1)), tasksOk = full(t), weekOk = full(w.to);
  // las hechas vienen de la más nueva a la más vieja: si se cortó, hay que haber pasado el lunes
  const doneOk = !!done && (done.n < limit || (!!done.oldest && done.oldest < addDays(w.from, -1)));
  if (!okDeals) warnings.push("No pude leer tus tratos de Pipedrive: los números de tratos van con «?».");
  else if (truncated) warnings.push("Pipedrive devolvió la lista de tratos cortada: puede haber más tratos que no se ven acá.");
  if (!okActs) warnings.push("No pude leer tus actividades de Pipedrive: las demos y las tareas van con «?».");
  else if (!demosOk || !tasksOk) warnings.push(`Tenés ${limit} o más actividades sin hacer y Pipedrive cortó la lista: puede faltar algo de hoy. Cerrá o reprogramá las más viejas.`);
  const demos = okActs ? demoSections(acts, { tz, now, deals }) : { today: [], tomorrow: [], unmarked: [] };
  const tasks = okActs ? taskGroups(acts, { tz, now, deals }) : [];
  const att = okDeals ? attention(rows) : [];
  const nTasks = tasks.reduce((n, g) => n + g.items.length, 0), nLate = tasks.reduce((n, g) => n + g.late, 0);
  const wk = okActs && weekOk && doneOk ? weekDemos(acts, done.demos, { tz, now }) : null;
  return {
    today: t, week: w, warnings,
    summary: { ...(okDeals ? summarize(rows, { truncated }) : { deals: null, value: null, noValue: null }), demosWeek: wk, overdue: tasksOk ? nLate : null,
      attention: okDeals && !truncated ? att.length : null },
    demos: { ...demos, n: demosOk ? demos.today.length + demos.tomorrow.length + demos.unmarked.length : null, complete: demosOk },
    tasks: { groups: tasks, n: tasksOk ? nTasks : null, late: tasksOk ? nLate : null, complete: tasksOk },
    // counts: cuántos tienen cada motivo (un trato puede tener varios), sobre todos los que piden atención
    attention: { deals: att, n: okDeals && !truncated ? att.length : null, complete: okDeals && !truncated, counts: Object.fromEntries(WHY.map(k => [k, att.filter(r => r.why.includes(k)).length])) },
    session: sessionItems(att, orgOf),
  };
}
