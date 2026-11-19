// Demos (actividades «Demo» = meeting y «No Show» = lunch de Pipedrive): resultado y lista del equipo. Lógica pura.
// Las métricas de demos están en lib/metrics.js (vista Métricas).
// El resultado se lee SOLO de la línea fija que deja la app en la nota de la actividad (o del campo outcome de Pipedrive
// si alguna vez viene con valor). Sin esa marca es «?» (null), aunque la actividad esté hecha: no se deduce de otras notas.
import { fromUtc, todayIn } from "./time.js";
import { esc as escH } from "./text.js";

const RESULT_TAG = "[Resultado de la demo]";
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

export const ddmm = d => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
// «[Resultado de la demo] No se presentó · marcado por X desde OrderBrain SDR el dd/mm»
export const resultLine = (key, { by, day, to = "" }) => `${RESULT_TAG} ${RESULTS[key]} · marcado por ${by} desde OrderBrain SDR el ${ddmm(day)}${to ? ` · nueva fecha: ${to}` : ""}`;
export const withResult = (note, line) => `${String(note || "").trim() ? String(note).trim() + "<br>" : ""}${escH(line)}`;
// La misma demo cargada más de una vez (sobre todo las entradas automáticas, que repiten una demo ya cargada): cuenta una sola vez
// por trato (si no, prospecto u organización) + día de la demo (en la zona de quien mira) + tipo. Queda la que cargó una persona
// (si no hay, la primera creada), con la fecha de creación más vieja del grupo; hecha si alguna está hecha; la marca de la app, la
// primera que haya. dups: cuántas actividades se sacaron en cada grupo. free: cuentas generales (FREE_OWNERS).
export const isAuto = (a, free = new Set()) => !a.by && free.has(Number(a.creator_user_id));
const demoKey = (a, tz) => `${a.deal_id ? `d${a.deal_id}` : a.lead_id ? `l${a.lead_id}` : a.org_id ? `o${a.org_id}` : `a${a.id}`}|${fromUtc(a.due_date, a.due_time, tz).date}|${a.type}`;
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

// Qué pasó con una demo (tipo «Demo» = meeting o «No Show» = lunch), en este orden: la marca de la app → tipo No Show → hecha en
// Pipedrive → sin marcar (ya pasó y no está hecha). Una reprogramada cuya fecha nueva ya pasó: la marca no dice qué pasó (sigue la
// regla). today: sin hora y con fecha de hoy (no se sabe si ya pasó): «hoy, sin hora» hasta que termine el día.
// Métricas (lib/metrics.js) y la tarjeta «Demos» de Equipo usan esta misma regla.
export const HELD = ["appDone", "appNoshow", "appCanceled", "noshow", "done", "unmarked", "today", "upcoming"];
export function heldState(a, past, today = false) {
  const m = a.mark === "moved" && past ? null : a.mark || null;
  if (m === "done") return "appDone";
  if (m === "noshow") return "appNoshow";
  if (m === "canceled") return "appCanceled";
  if (a.type === "lunch") return "noshow";
  if (a.done) return "done";
  if (today) return "today";
  return past ? "unmarked" : "upcoming";
}

// ---------- Tarjeta «Demos» de Equipo (SOLO líderes y dirección; pedido del líder de SDR: «los objetivos son por mes»)
// Período: un mes o un trimestre (Q1 = enero a marzo…) en la zona de quien mira, desde enero del año anterior hasta el actual.
export const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const pad = n => String(n).padStart(2, "0");
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m: 1-12
// «2026-11» (mes) o «2026-Q4» (trimestre) → { kind, key, year, from, to, label }; otra cosa, null
export function periodOf(key) {
  const k = String(key || "").trim().toUpperCase();
  let m = k.match(/^(\d{4})-(\d{2})$/);
  if (m) { const y = +m[1], mo = +m[2]; if (mo < 1 || mo > 12) return null;
    return { kind: "month", key: `${y}-${pad(mo)}`, year: y, from: `${y}-${pad(mo)}-01`, to: `${y}-${pad(mo)}-${pad(lastDay(y, mo))}`, label: `${MONTHS[mo - 1]} ${y}` }; }
  m = k.match(/^(\d{4})-Q([1-4])$/);
  if (m) { const y = +m[1], q = +m[2], a = (q - 1) * 3 + 1, b = a + 2;
    return { kind: "q", key: `${y}-Q${q}`, year: y, q, from: `${y}-${pad(a)}-01`, to: `${y}-${pad(b)}-${pad(lastDay(y, b))}`, label: `Q${q} ${y} (${MONTHS[a - 1]} a ${MONTHS[b - 1]})` }; }
  return null;
}
// lo que se puede elegir: los meses y trimestres desde enero del año anterior hasta el de hoy (nada del futuro)
export function periodChoices(today) {
  const y = +today.slice(0, 4), mo = +today.slice(5, 7), months = [], quarters = [];
  for (let yy = y; yy >= y - 1; yy--) for (let mm = yy === y ? mo : 12; mm >= 1; mm--) months.push(periodOf(`${yy}-${pad(mm)}`));
  for (let yy = y - 1; yy <= y; yy++) for (let q = 1; q <= 4; q++) if (yy < y || (q - 1) * 3 + 1 <= mo) quarters.push(periodOf(`${yy}-Q${q}`));
  return { current: `${y}-${pad(mo)}`, months, quarters };
}
// el período pedido si se puede elegir; si no (o vacío), el mes en curso
export function pickPeriod(key, today) {
  const p = periodOf(key), c = periodChoices(today);
  return p && [...c.months, ...c.quarters].some(x => x.key === p.key) ? p : periodOf(c.current);
}

// Fuente del trato (o del prospecto) de la demo → outbound o inbound, por el NOMBRE de la opción en Pipedrive (labels: id → nombre):
// «Inbound - …» = inbound; «Outbound - …» (y «Oubound - …», así escrita en la cuenta) = outbound. Vacía, «Otro…», una opción
// que no está en la lista o las dos a la vez (el campo es de varias opciones): «none» (sin fuente: no cuenta como ninguna).
export const fuenteIds = v => (Array.isArray(v) ? v : String(v ?? "").split(",")).map(x => x && typeof x === "object" ? x.id ?? x.value : x)
  .map(x => String(x ?? "").trim()).filter(x => /^\d+$/.test(x));
export const fuenteKindOf = label => /^\s*inbound\b/i.test(label || "") ? "in" : /^\s*o\w{0,4}bound\b/i.test(label || "") ? "out" : null;
export function sourceKind(value, labels = new Map()) {
  const ids = fuenteIds(value), names = ids.map(id => labels.get(id) || "").filter(Boolean), kinds = new Set(names.map(fuenteKindOf).filter(Boolean));
  if (!ids.length) return { kind: "none", label: "" };
  if (kinds.size === 1) return { kind: [...kinds][0], label: names.filter(n => fuenteKindOf(n) === [...kinds][0]).join(", ") };
  return { kind: "none", label: names.join(", ") || "Opción que no está en la lista", ...(kinds.size > 1 ? { mixed: true } : {}) };
}
// Cuántas «cuentan» para el objetivo: en los SDR, 2 inbound = 1 outbound (outbound + inbound / 2); en un Account Executive no se
// pondera (outbound + inbound). Las sin fuente no entran (hasta que carguen la Fuente); si alguna hecha no se pudo leer, «?».
export const countsFor = (r, ae = false) => r.unread ? null : r.out + (ae ? r.in : r.in / 2);

// La tarjeta: demos con fecha en el período (en la zona de quien mira), sin duplicados (dedupeDemos), por quién la cargó (people).
// Estado (heldState): hecha = marcada «se hizo» desde la app o hecha en Pipedrive; No Show = tipo No Show o marcada «no se
// presentó»; cancelada; agendada = todavía no pasó (o es de hoy sin hora); sin marcar = ya pasó y no está hecha ni marcada.
// Las hechas van por fuente (sourceOf(a) → { kind: out|in|none|unread, label }). ae: ids de los Account Executive (sin ponderar).
// Con equipo ({ ids }): la lista, las que da o cargó alguien del equipo; las filas, solo su gente (no las entradas automáticas).
const STATE = { appDone: "done", done: "done", appNoshow: "noshow", noshow: "noshow", appCanceled: "canceled", today: "booked", upcoming: "booked", unmarked: "unmarked" };
const blank = () => ({ total: 0, done: 0, out: 0, in: 0, none: 0, unread: 0, booked: 0, noshow: 0, canceled: 0, unmarked: 0 });
export function monthBoard(demos, { users = [], profiles = {}, free = new Set(), period, tz, now = Date.now(), team = null, sourceOf = () => ({ kind: "unread", label: "" }), ae = new Set() }) {
  const P = people(users, profiles, free), today = todayIn(tz, now), rows = new Map();
  const items = dedupeDemos(demos.filter(a => (a.type === "meeting" || a.type === "lunch") && !a.deleted), { tz, free }).map(a => ({ ...a, ...local(a, tz) }))
    .filter(a => a.date >= period.from && a.date <= period.to).map(a => {
      const s = P.setter(a), past = demoPast(a, now, tz), state = STATE[heldState(a, past, !a.due_time && a.date === today)], src = sourceOf(a) || { kind: "unread", label: "" };
      return { id: a.id, date: a.date, time: a.time, name: a.name || "", schoolId: a.schoolId || null, record: a.record || null, setterId: s.id, setter: s.name, ...(s.auto ? { auto: true } : {}),
        ownerId: a.owner_id || null, owner: P.name(a.owner_id), ...(free.has(Number(a.owner_id)) ? { ownerFree: true } : {}), state, kind: src.kind, fuente: src.label || "", ...(src.mixed ? { mixed: true } : {}),
        past, result: pastResult(a, past), moved: !!a.moved, done: !!a.done, noShowType: a.type === "lunch" };
    })
    .filter(r => !team || (!!r.ownerId && !r.ownerFree && team.ids.has(Number(r.ownerId))) || (!!r.setterId && team.ids.has(Number(r.setterId))))
    .sort((x, y) => (x.date + (x.time || "99")).localeCompare(y.date + (y.time || "99")));
  for (const r of items) {
    if (team && (r.auto || !r.setterId || !team.ids.has(Number(r.setterId)))) continue;
    const key = r.auto ? "auto" : r.setterId || (r.setter ? `n:${r.setter}` : "?");
    const x = rows.get(key) || { id: r.setterId || null, name: r.setter || "", ...(r.auto ? { auto: true } : {}), ...(!r.auto && !r.setterId && !r.setter ? { unknown: true } : {}), ...blank() };
    rows.set(key, x); x.total++; x[r.state]++;
    if (r.state === "done") x[r.kind]++;
  }
  const out = [...rows.values()].map(x => { const isAe = !!x.id && ae.has(Number(x.id)), person = !x.auto && !x.unknown;
    return { ...x, role: person ? (isAe ? "ae" : "sdr") : null, counts: person ? countsFor(x, isAe) : null }; }).sort((x, y) => !!x.auto - !!y.auto || !!x.unknown - !!y.unknown || byName(x, y));
  const totals = blank(), ppl = out.filter(x => x.role);
  for (const x of out) for (const f of Object.keys(totals)) totals[f] += x[f];
  totals.counts = ppl.some(x => x.counts == null) ? null : ppl.reduce((n, x) => n + x.counts, 0);
  return { period, today, rows: out, totals, items };
}
