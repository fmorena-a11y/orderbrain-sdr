// Demos (actividades «Demo» = meeting y «No Show» = lunch de Pipedrive): resultado y lista del equipo. Lógica pura.
// Las métricas de demos están en lib/metrics.js (vista Métricas).
// El resultado se lee SOLO de la línea fija que deja la app en la nota de la actividad (o del campo outcome de Pipedrive
// si alguna vez viene con valor). Sin esa marca es «?» (null), aunque la actividad esté hecha: no se deduce de otras notas.
import { fromUtc, addDays, todayIn } from "./time.js";

export const RESULT_TAG = "[Resultado de la demo]";
export const RESULTS = { done: "Se hizo", noshow: "No se presentó", moved: "Se reprogramó", canceled: "Se canceló" };
const BY_LABEL = Object.fromEntries(Object.entries(RESULTS).map(([k, v]) => [v, k]));
const plain = h => String(h || "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li)>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const LINE = /\[Resultado de la demo\]\s*(Se hizo|No se presentó|Se reprogramó|Se canceló)/g;
// todas las marcas de la nota, en orden (una demo reprogramada y después hecha tiene dos)
export const resultMarks = note => [...plain(note).matchAll(LINE)].map(m => BY_LABEL[m[1]]);
// el campo outcome de Pipedrive (hoy siempre null): solo valores reconocibles; cualquier otro queda «?»
export function outcomeKey(v) {
  const t = String(v && typeof v === "object" ? v.label ?? v.value ?? v.name ?? "" : v ?? "").trim().toLowerCase();
  if (!t) return null;
  if (/no.?show|no se present/.test(t)) return "noshow";
  if (/cancel/.test(t)) return "canceled";
  if (/resched|reprogram|reagend/.test(t)) return "moved";
  if (/^(done|held|completed?|hecha|se hizo|realizada)$/.test(t)) return "done";
  return null;
}
export const demoResult = a => resultMarks(a?.note).at(-1) || outcomeKey(a?.outcome) || null;

const escH = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const ddmm = d => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
// «[Resultado de la demo] No se presentó · marcado por X desde OrderBrain SDR el dd/mm»
export const resultLine = (key, { by, day, to = "" }) => `${RESULT_TAG} ${RESULTS[key]} · marcado por ${by} desde OrderBrain SDR el ${ddmm(day)}${to ? ` · nueva fecha: ${to}` : ""}`;
export const withResult = (note, line) => `${String(note || "").trim() ? String(note).trim() + "<br>" : ""}${escH(line)}`;
// La misma demo cargada más de una vez (sobre todo las entradas automáticas, que repiten una demo ya cargada): cuenta una sola vez
// por trato (si no, prospecto u organización) + día de la demo (en la zona de quien mira) + tipo. Queda la que cargó una persona
// (si no hay, la primera creada), con la fecha de creación más vieja del grupo; hecha si alguna está hecha; la marca de la app, la
// primera que haya. dups: cuántas actividades se sacaron en cada grupo. free: cuentas generales (FREE_OWNERS).
export const isAuto = (a, free = new Set()) => !a.by && free.has(Number(a.creator_user_id));
export const demoKey = (a, tz) => `${a.deal_id ? `d${a.deal_id}` : a.lead_id ? `l${a.lead_id}` : a.org_id ? `o${a.org_id}` : `a${a.id}`}|${fromUtc(a.due_date, a.due_time, tz).date}|${a.type}`;
const t0 = a => String(a.add_time || "9999");
export function dedupeDemos(acts, { tz, free = new Set() } = {}) {
  const groups = new Map(), seen = new Set();
  for (const a of acts) { if (seen.has(a.id)) continue; seen.add(a.id); const k = demoKey(a, tz); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(a); }
  return [...groups.values()].map(g => {
    const s = [...g].sort((x, y) => isAuto(x, free) - isAuto(y, free) || t0(x).localeCompare(t0(y)) || x.id - y.id), rep = s[0];
    if (g.length === 1) return { ...rep, dups: 0, members: [rep] };
    const marked = s.find(a => a.mark || a.result), first = [...g].sort((x, y) => t0(x).localeCompare(t0(y)))[0];
    return { ...rep, add_time: first.add_time, done: g.some(a => a.done), mark: rep.mark || marked?.mark || null, result: rep.result || marked?.result || null,
      moved: g.some(a => a.moved), dups: g.length - 1, members: g };
  });
}
// ya pasó (fecha y hora UTC de Pipedrive). Sin hora: desde que empieza ese día en la zona de quien mira (tz), no en UTC.
export const demoPast = (a, now = Date.now(), tz) => !!a?.due_date && (a.due_time ? Date.parse(`${a.due_date}T${String(a.due_time).slice(0, 5)}:00Z`) <= now : a.due_date <= todayIn(tz, now));

// Quién la agendó: en las agendadas desde la app, el nombre de la nota (el creador en Pipedrive es el dueño del token: no se
// usa aunque el nombre no sea de un usuario activo); si no hay nota, creator_user_id. Sin ninguno de los dos: «?».
const key = v => String(v || "").trim().toLowerCase();
// free: ids de las cuentas generales (FREE_OWNERS). Creada por una de ellas y sin nota: entrada automática (auto), sin agendador.
export function people(users = [], profiles = {}, free = new Set()) {
  const idx = new Map(users.flatMap(u => [[key(u.name), u.id], [key(u.email), u.id], [key(profiles[u.email]?.name), u.id]]).filter(([k]) => k));
  const name = id => { const u = users.find(x => x.id === Number(id)); return u ? profiles[u.email]?.name || u.name : ""; };
  return { name, setter: a => {
    if (!a.by && free.has(Number(a.creator_user_id))) return { id: null, name: "", auto: true };
    const id = (a.by ? idx.get(key(a.by)) : Number(a.creator_user_id)) || null; return { id, name: (id && name(id)) || a.by || "" }; } };
}
const byName = (x, y) => (!x.name) - (!y.name) || String(x.name || "").localeCompare(String(y.name || ""), "es", { sensitivity: "base" });
const local = (a, tz) => { const l = fromUtc(a.due_date, a.due_time, tz); return { date: l.date, time: a.due_time ? l.time : "" }; };

// Resultado que cuenta: «se reprogramó» mueve la demo a la fecha nueva, así que si esa fecha ya pasó falta saber qué pasó («?»).
export const pastResult = (a, past) => a?.result === "moved" && past ? null : a?.result || null;

// Tarjeta «Demos» de Equipo (la ven todos): las de los últimos 7 días (hoy y los 6 anteriores, como en Métricas) y las próximas 14, y cuántas cargó cada uno (ese
// desglose por persona solo lo manda el servidor a un líder; a los demás, lo suyo y el total).
// «Ya pasaron» y «próximas» por fecha y hora (demoPast), no por día. pending: las de antes (hasta `pendingBack` días) que
// quedaron sin resultado, para que quien la dio (o un líder) las marque. Sin puestos: orden alfabético.
// team: { ids } de la gente de un equipo (lib/teams.js) o null (todas): con equipo, las que da o cargó alguien del equipo.
export function demoBoard(demos, { users, profiles, free = new Set(), today, tz, back = 6, ahead = 14, pendingBack = 30, now = Date.now(), team = null }) {
  const from = addDays(today, -back), to = addDays(today, ahead), old = addDays(today, -pendingBack), P = people(users, profiles, free);
  const all = dedupeDemos(demos, { tz, free }).map(a => ({ ...a, ...local(a, tz) })).filter(a => a.date >= old && a.date <= to).map(a => { const s = P.setter(a), past = demoPast(a, now, tz);
    return { id: a.id, date: a.date, time: a.time, utcDate: a.due_date, utcTime: a.due_time || "", name: a.name || "", schoolId: a.schoolId || null, record: a.record || null,
      setterId: s.id, setter: s.name, ...(s.auto ? { auto: true } : {}), ownerId: a.owner_id || null, owner: P.name(a.owner_id), ...(free.has(Number(a.owner_id)) ? { ownerFree: true } : {}), past, result: pastResult(a, past), moved: !!a.moved, done: !!a.done, noShowType: a.type === "lunch" }; })
    .filter(r => !team || (!!r.ownerId && !r.ownerFree && team.ids.has(Number(r.ownerId))) || (!!r.setterId && team.ids.has(Number(r.setterId))))
    .sort((x, y) => (x.date + (x.time || "99")).localeCompare(y.date + (y.time || "99")));
  // «Falta marcar»: sin resultado, que no esté en Pipedrive como No Show (el equipo pasa la demo a ese tipo) ni hecha
  const rows = all.filter(r => r.date >= from), pending = all.filter(r => r.date < from && !r.result && !r.noShowType && !r.done).reverse();
  // las entradas automáticas van aparte, al final (no son una persona)
  const count = new Map(); for (const r of rows) { const k = r.auto ? "auto" : r.setterId || r.setter || "?"; const c = count.get(k) || { id: r.setterId || null, name: r.setter, ...(r.auto ? { auto: true } : {}), upcoming: 0, recent: 0 }; c[r.past ? "recent" : "upcoming"]++; count.set(k, c); }
  // con equipo, cuántas cargó cada uno solo de su gente (no se cuenta a nadie de otro equipo)
  const ppl = [...count.values()].filter(c => !team || (!!c.id && team.ids.has(Number(c.id))));
  return { from, to, today, upcoming: rows.filter(r => !r.past), recent: rows.filter(r => r.past).reverse(), pending, pendingFrom: old, people: ppl.sort((x, y) => !!x.auto - !!y.auto || byName(x, y)) };
}
// Lo que manda el servidor: a un líder, todo; a los demás, la lista y cuántas cargó cada uno solo para sí (mine) y el total.
export function boardFor(b, { leader = false, me = null } = {}) {
  if (leader) return b;
  const { people: rows, ...rest } = b, id = Number(me) || null;
  // quién cargó cada demo: solo en las tuyas («cargaste vos»); en las demás no va (así no se cuenta cuántas cargó cada uno)
  const strip = l => l.map(({ setter, setterId, ...r }) => id && setterId === id ? { ...r, setter, setterId, mineLoaded: true } : r);
  for (const k of ["upcoming", "recent", "pending"]) rest[k] = strip(b[k] || []);
  return { ...rest, mine: (id && rows.find(p => p.id === id)) || { id, upcoming: 0, recent: 0 }, total: { upcoming: b.upcoming.length, recent: b.recent.length } };
}
