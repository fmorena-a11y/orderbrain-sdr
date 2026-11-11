// Métricas (vista «Métricas»): cálculos puros sobre lo crudo de Pipedrive, la base de colegios, World Dominion y los
// registros de la app. Regla: cada número sale de una definición exacta; lo que no se puede saber es null («?») o no se
// muestra. Sin puestos: los desgloses por persona van en orden alfabético y solo los ve un líder (server.js corta con 403).
// team: { ids, emails } de la gente de un equipo (lib/teams.js filterOf) o null (todos). Con equipo, cada cuenta toma solo lo
// de su gente (la definición de cada una dice cómo) y las filas por persona son solo de su gente: nada de otros equipos.
import { addDays, fromUtc, safeTz, todayIn } from "./time.js";
import { demoPast, dedupeDemos } from "./demos.js";

export const PERIODS = [7, 30, 90];
// del día (local, de quien mira) hace days-1 días hasta hoy, contando hoy
export const periodOf = (today, days) => { const d = PERIODS.includes(Number(days)) ? Number(days) : 7; return { from: addDays(today, -(d - 1)), to: today, days: d }; };
// fechas de Pipedrive: v2 manda ISO con Z; v1 y algunas viejas, «YYYY-MM-DD HH:MM:SS» en UTC
export const isoUtc = v => { if (!v) return null; const s = String(v).trim(); if (!s) return null; const t = s.includes("T") ? s : s.replace(" ", "T"); return /Z$|[+-]\d\d:?\d\d$/.test(t) ? t : `${t}Z`; };
const fmts = new Map();
export function localDay(v, tz) {
  const x = isoUtc(v), t = x ? Date.parse(x) : NaN; if (isNaN(t)) return "";
  const z = safeTz(tz); if (!fmts.has(z)) fmts.set(z, new Intl.DateTimeFormat("sv-SE", { timeZone: z }));
  return fmts.get(z).format(t);
}
const inP = (d, p) => !!d && d >= p.from && d <= p.to;
const k = v => String(v ?? "").trim().toLowerCase();
// ¿es de la gente del equipo? (sin equipo: todos)
const ofTeam = (team, id) => !team || (!!id && team.ids.has(Number(id)));
const ofTeamEmail = (team, e) => !team || team.emails.has(k(e));
// orden alfabético; sin nombre (usuario no activo, «?»), al final
const alpha = (x, y) => (!x.name) - (!y.name) || String(x.name || "").localeCompare(String(y.name || ""), "es", { sensitivity: "base" });
const inc = (o, key, n = 1) => { o[key] = (o[key] || 0) + n; };
// order: claves en ese orden (las demás después); last: claves al final. Sin order, de más a menos.
const list = (m, { order = [], last = [] } = {}) => { const pos = x => last.includes(x) ? 2e3 + last.indexOf(x) : order.includes(x) ? order.indexOf(x) : 1e3;
  return [...m.entries()].map(([key, n]) => ({ key, n })).sort((a, b) => pos(a.key) - pos(b.key) || b.n - a.n || String(a.key).localeCompare(String(b.key), "es")); };
// etapas de varios embudos juntas (mismo nombre en cada embudo): primero las de antes de la propuesta, después por orden y nombre
export const PROPOSAL = /propos|propuesta|closing|hot deal|negoti|negociaci/i;
const stageSort = m => [...m].map(([key, x]) => ({ key, n: x.n, order: x.order })).sort((a, b) => PROPOSAL.test(a.key) - PROPOSAL.test(b.key) || (a.order ?? 99) - (b.order ?? 99) || a.key.localeCompare(b.key, "es"));

// ---------- personas: nombre de cada usuario (el del perfil manda), las cuentas generales aparte
// free: ids de las cuentas generales de Pipedrive (FREE_OWNERS). Un id que no es de un usuario activo: «Usuario no activo».
export function who(users = [], profiles = {}, free = new Set()) {
  const byId = new Map(users.map(u => [Number(u.id), u]));
  const idx = new Map(users.flatMap(u => [[k(u.name), u.id], [k(u.email), u.id], [k(profiles[u.email]?.name), u.id]]).filter(([x]) => x));
  const name = id => { const u = byId.get(Number(id)); return u ? profiles[u.email]?.name || u.name : ""; };
  const person = id => { id = Number(id) || null; if (!id) return { key: "?", id: null, name: "" };
    if (free.has(id)) return { key: "free", id, name: "", free: true };
    const n = name(id); return { key: `u${id}`, id, name: n, inactive: !n }; };
  // quién cargó una demo: la nota de la app («Agendada por X desde OrderBrain SDR») manda; si no, quien la creó en Pipedrive.
  // Creada por una cuenta general y sin nota: entrada automática (diio, formularios…), no tiene agendador.
  const loader = a => {
    if (a.by) { const id = idx.get(k(a.by)) || null; return id ? { key: `u${id}`, id, name: name(id) || a.by } : { key: `n:${k(a.by)}`, id: null, name: String(a.by) }; }
    const p = person(a.creator_user_id); return p.free ? { ...p, key: "auto", auto: true } : p;
  };
  return { name, person, loader };
}
// fila de una persona: free (cuenta general), auto (entrada automática), none (sin SDR cargado), inactive (usuario no activo)
const row = (r, extra) => ({ id: r.id ?? null, name: r.name || "", ...Object.fromEntries(["free", "auto", "none", "inactive"].filter(f => r[f]).map(f => [f, true])), ...extra });

// ---------- A. Demos (tipo «Demo» = meeting y «No Show» = lunch: el equipo pasa la demo a No Show cuando no se presentaron)
export const DEMO_TYPES = new Set(["meeting", "lunch"]);
// registrada después: se marcó hecha en el primer minuto desde que se creó (la mayoría, en el mismo segundo)
export const PRE_DONE_MS = 60e3;
export const preDone = a => { if (!a.done) return false; const x = Date.parse(isoUtc(a.add_time) || ""), y = Date.parse(isoUtc(a.done_time) || ""); return !isNaN(x) && !isNaN(y) && y >= x && y - x <= PRE_DONE_MS; };

// A1. Demos cargadas en el período (por la fecha en que se crearon en Pipedrive), por quién la cargó. Sin duplicados
// (dedupeDemos): la misma demo cargada dos veces cuenta una vez, en el día en que se cargó la primera; acts puede traer también
// las de antes del período (para saber que una entrada automática repite una demo ya cargada). people: las cargó una persona.
// Con equipo: las que cargó alguien del equipo (las automáticas y sin creador no son de ningún equipo).
export function demosLoaded(acts, { users = [], profiles = {}, free = new Set(), period, tz, country = "", countryOf = a => a.country || "", team = null }) {
  const W = who(users, profiles, free), tot = { total: 0, demo: 0, noshow: 0, preDone: 0, auto: 0, autoPreDone: 0, unknown: 0, people: 0, dups: 0 }, rows = new Map(), others = new Map();
  const isIn = a => DEMO_TYPES.has(a.type) && !a.deleted && inP(localDay(a.add_time, tz), period);
  for (const a of dedupeDemos(acts.filter(a => DEMO_TYPES.has(a.type) && !a.deleted), { tz, free })) {
    if (country && (countryOf(a) || "?") !== country) continue;
    const l = W.loader(a);
    if (team && (l.auto || !ofTeam(team, l.id))) continue;
    const inPer = isIn(a); tot.dups += a.members.filter(isIn).length - (inPer ? 1 : 0);
    if (!inPer) continue;
    // cargada ya hecha: la primera que se cargó del grupo
    const first = a.members.reduce((x, y) => String(y.add_time || "9") < String(x.add_time || "9") ? y : x, a.members[0]);
    const pre = preDone(first), kind = a.type === "lunch" ? "noshow" : "demo";
    tot.total++; tot[kind]++; if (pre) tot.preDone++;
    if (l.auto) { tot.auto++; if (pre) tot.autoPreDone++; }
    if (l.key === "?") tot.unknown++;
    if (!l.auto && l.key !== "?") tot.people++;
    // las automáticas y las sin creador no son personas: van aparte (others), con las mismas columnas
    const m = l.auto || l.key === "?" ? others : rows, r = m.get(l.key) || row(l, { total: 0, demo: 0, noshow: 0, preDone: 0 }); m.set(l.key, r);
    r.total++; r[kind]++; if (pre) r.preDone++;
  }
  return { totals: tot, people: [...rows.values()].sort(alpha), others: [...others.values()].sort((x, y) => !!y.auto - !!x.auto) };
}

// A2. Demos con fecha en el período: qué pasó, en este orden: la marca de la app → tipo No Show → hecha en Pipedrive →
// sin marcar (ya pasó y no está hecha). Una reprogramada cuya fecha nueva ya pasó: la marca no dice qué pasó (sigue la regla).
// today: sin hora y con fecha de hoy (no se sabe si ya pasó): «hoy, sin hora» hasta que termine el día.
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
const heldBlank = () => Object.fromEntries([["total", 0], ...HELD.map(s => [s, 0])]);
// Con equipo: las que da o cargó alguien del equipo; por persona, solo su gente.
export function demosHeld(acts, { users = [], profiles = {}, free = new Set(), period, tz, now = Date.now(), country = "", countryOf = a => a.country || "", team = null }) {
  const W = who(users, profiles, free), tot = { ...heldBlank(), dups: 0 }, byOwner = new Map(), byLoader = new Map(), items = [], today = todayIn(tz, now);
  const add = (m, p, st) => { const r = m.get(p.key) || row(p, heldBlank()); m.set(p.key, r); r.total++; r[st]++; };
  // sin duplicados (dedupeDemos): la misma demo cargada dos veces (una entrada automática que la repite) cuenta una vez
  for (const { members, ...a } of dedupeDemos(acts.filter(a => DEMO_TYPES.has(a.type) && !a.deleted), { tz, free })) {
    const day = fromUtc(a.due_date, a.due_time, tz).date;
    if (!inP(day, period)) continue;
    if (country && (countryOf(a) || "?") !== country) continue;
    const o = W.person(a.owner_id), l = W.loader(a), oIn = ofTeam(team, o.id) && !o.free, lIn = ofTeam(team, l.id) && !l.auto;
    if (team && !oIn && !lIn) continue;
    const st = heldState(a, demoPast(a, now, tz), !a.due_time && day === today);
    tot.total++; tot[st]++; tot.dups += a.dups; items.push({ ...a, state: st });
    if (!team || oIn) add(byOwner, o, st);
    if (!team || lIn) add(byLoader, l, st);
  }
  // las cuentas generales y las entradas automáticas no son personas: van al final
  const sorted = m => [...m.values()].sort((x, y) => (!!x.free || !!x.auto) - (!!y.free || !!y.auto) || alpha(x, y));
  return { totals: tot, byOwner: sorted(byOwner), byLoader: sorted(byLoader), items };
}

// A3. Estado HOY del trato de cada demo, solo por deal_id (sin trato o no encontrado: «?»). Cuenta tratos distintos.
// stageOf(id) → { name, order } (del embudo del trato).
export function demoDeals(demos, deals, { stageOf = () => null } = {}) {
  const seen = new Set(), out = { demos: demos.length, withDeal: 0, deals: 0, won: 0, lost: 0, open: 0, unknown: 0, lostReasons: new Map(), openStages: new Map() };
  for (const a of demos) {
    const d = a.deal_id ? deals.get(Number(a.deal_id)) : null;
    if (!d || !["won", "lost", "open"].includes(d.status)) { out.unknown++; continue; }
    out.withDeal++;
    if (seen.has(d.id)) continue; seen.add(d.id); out.deals++;
    out[d.status]++;
    if (d.status === "lost") inc2(out.lostReasons, d.lost_reason || "Sin motivo");
    if (d.status === "open") { const s = stageOf(d.stage_id); inc2(out.openStages, s?.name || "?", s?.order); }
  }
  return { ...out, lostReasons: list(new Map([...out.lostReasons].map(([r, x]) => [r, x.n])), { last: ["Sin motivo"] }), openStages: stageSort(out.openStages) };
}
function inc2(m, key, order) { const x = m.get(key) || { n: 0, order }; x.n++; if (order != null && (x.order == null || order < x.order)) x.order = order; m.set(key, x); }

// ---------- B. Actividad por persona (solo líderes): lo que está cargado en Pipedrive, por dueño de la actividad («a nombre
// de») y por tipo TAL COMO ESTÁ. El tipo no siempre dice el canal (mails cargados como «LinkedIn», WhatsApp anotados como
// llamada): cada columna lleva el nombre del tipo en la cuenta y la vista lo avisa. Tres cuentas que no se mezclan:
//  · dated: hechas cuya fecha (la de la actividad) cae en el período. Las que creó una cuenta general (FREE_OWNERS: las tareas
//    automáticas de diio y otras) van aparte (auto, con su tipo en autoByType), no en las columnas de tipo. Salvo las de
//    Aircall (tipos aircall_*): Aircall las carga con la cuenta general OrderEAT (así vienen en la cuenta real) a nombre de
//    quien llamó: son llamadas de esa persona, así que van en su columna de tipo, las haya creado quien sea (isAircall).
//  · late: con fecha anterior al período y marcadas hechas en el período (vencidas viejas que se cerraron).
//  · overdue: sin hacer y con fecha anterior a hoy; inPeriod: de esas, las que vencieron en el período.
// Fecha de la actividad: el vencimiento en la zona de quien mira (con hora se convierte; sin hora, el día tal cual); sin
// vencimiento, el día en que se marcó hecha. Una hecha antes de su fecha cuenta el día de su fecha.
// done: hechas (las lecturas de lib/sales.js: todas las cambiadas desde el comienzo del período y las de fecha en el período
// que no se tocaron desde entonces); pending: sin hacer con fecha hasta mañana. types: los tipos de la cuenta, en su orden.
// include: ids de usuarios que van aunque estén en cero (los que usan la app). partial: qué lectura se cortó
// ({ updated, ahead, pending }): lo que depende de ella queda null («?»). Cada cuenta general es su propia fila (con su id y
// su nombre): sus números no se juntan con los de otra cuenta general.
// tipos que crea Aircall (aircall_outbound_unanswere, aircall_outbound_answered_…): la clave empieza con «aircall_»
export const isAircall = t => /^aircall_/i.test(String(t || ""));
export const actDay = (a, tz) => a.due_date ? fromUtc(String(a.due_date).slice(0, 10), a.due_time ? String(a.due_time) : "", tz).date : localDay(a.done_time, tz);
// Con equipo: las actividades a nombre de alguien del equipo (las de las cuentas generales no son de ningún equipo).
export function activitySummary({ done = [], pending = [], types = [], users = [], profiles = {}, free = new Set(), include = [], period, tz, today, partial = {}, team = null }) {
  const W = who(users, profiles, free), known = { dated: !partial.updated && !partial.ahead, late: !partial.updated, overdue: !partial.pending };
  const blank = () => ({ byType: {}, auto: 0, autoByType: {}, total: 0 }), rows = new Map(), used = new Set();
  const tot = { dated: blank(), late: { ...blank(), unknown: 0 }, overdue: { n: 0, inPeriod: 0 } };
  // una fila por persona y una por CADA cuenta general (who() les da a todas la misma clave «free»: acá no se juntan)
  const rowOf = id => {
    const p = W.person(id), key = p.free ? `f${p.id}` : p.key; let r = rows.get(key);
    if (!r) { r = row({ ...p, name: p.free ? W.name(id) : p.name }, { dated: blank(), late: blank(), overdue: { n: 0, inPeriod: 0 } }); rows.set(key, r); }
    return r;
  };
  for (const id of include) if (!free.has(Number(id)) && ofTeam(team, id)) rowOf(id);
  const add = (bucket, a) => {
    const t = a.type || "?", r = rowOf(a.owner_id)[bucket], T = tot[bucket]; used.add(t);
    if (free.has(Number(a.creator_user_id)) && !isAircall(t)) { r.auto++; inc(r.autoByType, t); T.auto++; inc(T.autoByType, t); } else { inc(r.byType, t); inc(T.byType, t); }
    r.total++; T.total++;
  };
  // la misma actividad en dos lecturas: vale la última
  for (const a of new Map(done.map(a => [a.id, a])).values()) {
    if (a.deleted || !a.done || !ofTeam(team, a.owner_id)) continue;
    const d = actDay(a, tz);
    if (inP(d, period)) add("dated", a);
    else if (d && d < period.from) {
      if (a.done_time) { if (inP(localDay(a.done_time, tz), period)) add("late", a); }
      // hecha sin hora de hecha y cambiada en el período: no se sabe si se cerró en el período (no se cuenta, se avisa)
      else if (!a.update_time || localDay(a.update_time, tz) >= period.from) tot.late.unknown++;
    }
  }
  for (const a of new Map(pending.map(a => [a.id, a])).values()) {
    if (a.deleted || a.done || !a.due_date || !ofTeam(team, a.owner_id)) continue;
    const d = actDay(a, tz); if (!d || d >= today) continue;
    const r = rowOf(a.owner_id).overdue; r.n++; tot.overdue.n++;
    if (d >= period.from) { r.inPeriod++; tot.overdue.inPeriod++; }
  }
  const pos = new Map(types.map((t, i) => [t.key, i])), tk = new Map(types.map(t => [t.key, t]));
  const typeList = [...used].sort((x, y) => (pos.get(x) ?? 1e4) - (pos.get(y) ?? 1e4) || x.localeCompare(y))
    .map(key => ({ key, name: tk.get(key)?.name || key, known: tk.has(key), active: tk.get(key)?.active !== false }));
  // personas en orden alfabético; después las cuentas generales, los usuarios no activos y sin dueño
  const rank = r => r.free ? 1 : r.inactive ? 2 : !r.id ? 3 : 0;
  const list = [...rows.values()].sort((x, y) => rank(x) - rank(y) || alpha(x, y) || (x.id || 0) - (y.id || 0))
    .map(r => ({ ...r, dated: known.dated ? r.dated : null, late: known.late ? r.late : null, overdue: known.overdue ? r.overdue : null }));
  return { types: typeList, known, dated: known.dated ? tot.dated : null, late: known.late ? tot.late : null, overdue: known.overdue ? tot.overdue : null, rows: list };
}

// ---------- C. Tratos de los embudos de venta (los de MARKETS). País: el del embudo; en LatAm, el del campo País.
// ctx: { sales: Set(pipeline), pipeCountry: { pipe: país }, paisOf(d) → país o "", stageOf(id) → { name, order, pipe } }
export const dealCountry = (d, ctx) => ctx.pipeCountry[d.pipeline_id] || ctx.paisOf(d) || "";
export const userId = v => { const x = v && typeof v === "object" ? v.id ?? v.value : v; return Number(x) || null; };
// Con equipo: los tratos cuyo dueño o SDR es del equipo; por persona, solo su gente.
export function dealsSummary({ won = [], lost = [], open = [], period, tz, country = "", users = [], profiles = {}, free = new Set(), lostReasons = [], team = null, ...ctx }) {
  const W = who(users, profiles, free), sales = d => ctx.sales.has(Number(d.pipeline_id)), cOf = d => dealCountry(d, ctx) || "?";
  const keep = d => sales(d) && (!country || cOf(d) === country) && (!team || ofTeam(team, userId(d.owner_id)) || ofTeam(team, userId(d.sdr)));
  const people = () => new Map(), add = (m, p) => { if (team && !ofTeam(team, p.id)) return; const r = m.get(p.key) || row(p, { n: 0 }); m.set(p.key, r); r.n++; };
  const sorted = m => [...m.values()].sort((x, y) => (!!(x.free || x.none)) - (!!(y.free || y.none)) || alpha(x, y));
  const brief = d => ({ id: d.id, title: d.title || "", country: cOf(d), owner: W.person(d.owner_id).name || "", sdr: userId(d.sdr) ? W.person(userId(d.sdr)).name || "" : "" });
  const sdrOf = d => userId(d.sdr) ? W.person(userId(d.sdr)) : { key: "none", id: null, name: "", none: true };
  // C1. Ganados: hoy ganados, ganados por primera vez en el período (first_won_time: won_time se puede editar y un trato
  // reabierto y vuelto a ganar cambia su won_time). Sin first_won_time (el demo), won_time.
  const wonDay = d => localDay(d.first_won_time || d.won_time, tz);
  const W1 = won.filter(d => d.status === "won" && keep(d) && inP(wonDay(d), period));
  const wonOwner = people(), wonSdr = people(), wonCountry = new Map();
  for (const d of W1) { add(wonOwner, W.person(d.owner_id)); add(wonSdr, sdrOf(d)); wonCountry.set(cOf(d), (wonCountry.get(cOf(d)) || 0) + 1); }
  // C2. Perdidos: hoy perdidos, con fecha de perdido en el período; motivo y etapa en la que se perdió
  const L = lost.filter(d => d.status === "lost" && keep(d) && inP(localDay(d.lost_time, tz), period));
  const lostOwner = people(), lostSdr = people(), lostCountry = new Map(), reasons = new Map(), stages = new Map();
  let after = 0, before = 0, freeText = 0;
  for (const d of L) {
    add(lostOwner, W.person(d.owner_id)); add(lostSdr, sdrOf(d)); lostCountry.set(cOf(d), (lostCountry.get(cOf(d)) || 0) + 1);
    const r = String(d.lost_reason || "").trim(), known = lostReasons.includes(r);
    if (!known) freeText++;
    reasons.set(known ? r : r ? "Texto libre" : "Sin motivo", (reasons.get(known ? r : r ? "Texto libre" : "Sin motivo") || 0) + 1);
    const s = ctx.stageOf(d.stage_id); inc2(stages, s?.name || "?", s?.order);
    if (PROPOSAL.test(s?.name || "")) after++; else before++;
  }
  // C3 y C4. Abiertos hoy, por embudo y etapa; sin próxima actividad
  const O = open.filter(d => d.status === "open" && keep(d)), rows = new Map(), noNext = new Map();
  for (const d of O) {
    const p = Number(d.pipeline_id), r = rows.get(p) || { pipe: p, total: 0, noNext: 0, stages: new Map() }; rows.set(p, r);
    r.total++; r.stages.set(Number(d.stage_id), (r.stages.get(Number(d.stage_id)) || 0) + 1);
    if (!d.next_activity_id) {
      r.noNext++;
      const o = W.person(d.owner_id); if (team && !ofTeam(team, o.id)) continue;
      const x = noNext.get(o.key) || row(o, { n: 0, deals: [] }); noNext.set(o.key, x);
      x.n++; x.deals.push({ id: d.id, title: d.title || "", since: (isoUtc(d.update_time) || "").slice(0, 10) });
    }
  }
  const pipeRows = [...rows.values()].map(r => ({ pipe: r.pipe, country: ctx.pipeCountry[r.pipe] || "", total: r.total, noNext: r.noNext,
    stages: (ctx.stagesOf?.(r.pipe) || []).map(s => ({ id: s.id, name: s.name, n: r.stages.get(s.id) || 0 })).concat([...r.stages].filter(([id]) => !(ctx.stagesOf?.(r.pipe) || []).some(s => s.id === id)).map(([id, n]) => ({ id, name: ctx.stageOf(id)?.name || "?", n }))) }))
    .sort((a, b) => (ctx.pipeOrder?.indexOf(a.pipe) ?? 0) - (ctx.pipeOrder?.indexOf(b.pipe) ?? 0) || a.pipe - b.pipe);
  for (const x of noNext.values()) x.deals = x.deals.sort((a, b) => a.since.localeCompare(b.since)).slice(0, 10); // los 10 más quietos
  const byC = m => [...m].map(([key, n]) => ({ key, n })).sort((a, b) => (a.key === "?") - (b.key === "?") || b.n - a.n || a.key.localeCompare(b.key, "es"));
  return {
    won: { n: W1.length, byCountry: byC(wonCountry), byOwner: sorted(wonOwner), bySdr: sorted(wonSdr), list: W1.map(d => ({ ...brief(d), day: wonDay(d) })).sort((a, b) => a.day.localeCompare(b.day) || a.id - b.id) },
    lost: { n: L.length, byCountry: byC(lostCountry), reasons: list(reasons, { last: ["Texto libre", "Sin motivo"] }), freeText, afterProposal: after, beforeProposal: before,
      stages: stageSort(stages), byOwner: sorted(lostOwner), bySdr: sorted(lostSdr) },
    open: { n: O.length, noNext: O.filter(d => !d.next_activity_id).length, pipes: pipeRows, noNextByOwner: sorted(noNext) },
  };
}
// lo tuyo en tratos: como dueño y en el campo «SDR»
export function dealsMine(sum, me) {
  const id = Number(me) || null, f = l => (id && l.find(r => r.id === id)?.n) || 0;
  return { wonOwner: f(sum.won.byOwner), wonSdr: f(sum.won.bySdr), lostOwner: f(sum.lost.byOwner), lostSdr: f(sum.lost.bySdr), noNext: f(sum.open.noNextByOwner) };
}

// ---------- D. Contactos registrados desde OrderBrain (touches): solo lo que se registró en la app
export const CHANNELS = ["call", "whatsapp", "mail", "visit"];
// Con equipo: lo que registró alguien del equipo (por email).
export function contactsSummary(touches, { period, tz, country = "", countryOf = () => "", outcomes = [], profiles = {}, cut = false, team = null }) {
  const blank = () => ({ n: 0, connected: 0, demo: 0, channels: {} }), tot = blank(), out = new Map(), rows = new Map();
  const add = (r, t) => { r.n++; if (t.connected) r.connected++; if (t.demo) r.demo++; inc(r.channels, CHANNELS.includes(t.channel) ? t.channel : "other"); };
  for (const t of touches) {
    if (!inP(localDay(t.at, tz), period) || !ofTeamEmail(team, t.by)) continue;
    if (country && (countryOf(t) || "?") !== country) continue;
    add(tot, t); out.set(t.outcome || "?", (out.get(t.outcome || "?") || 0) + 1);
    const e = k(t.by), r = rows.get(e) || { email: e, name: profiles[e]?.name || t.byName || e, ...blank() }; rows.set(e, r); add(r, t);
  }
  const order = outcomes.map(o => o.id);
  return { partial: !!cut, totals: tot, outcomes: list(out, { order }).map(x => ({ ...x, label: outcomes.find(o => o.id === x.key)?.label || "?" })), people: [...rows.values()].sort(alpha) };
}

// ---------- E. Base de colegios: cuántos hay por país y por ciudad (exacto: es la lista de la app)
export function baseSummary(schools, { country = "", top = 15 } = {}) {
  const byCountry = new Map(), cities = new Map();
  for (const s of schools) {
    byCountry.set(s.country || "?", (byCountry.get(s.country || "?") || 0) + 1);
    if (country && s.country === country) cities.set(s.city || "?", (cities.get(s.city || "?") || 0) + 1);
  }
  const sorted = m => [...m].map(([key, n]) => ({ key, n })).sort((a, b) => b.n - a.n || a.key.localeCompare(b.key, "es"));
  const c = sorted(cities);
  return { total: country ? byCountry.get(country) || 0 : schools.length, byCountry: sorted(byCountry), cities: c.slice(0, top), cityCount: c.length, otherCities: c.slice(top).reduce((s, x) => s + x.n, 0) };
}

// ---------- F. Clientes de OrderEAT: sitios de World Dominion por estado y país (no del cruce)
export const SITE_ORDER = ["Activo", "Onboarding", "Cerrado", "Churn", "Se cayó en onboarding", "Se cayó antes de arrancar"];
export function clientsSummary(sites, { country = "" } = {}) {
  const l = sites.filter(s => !country || (s.country || "?") === country), st = new Map(), cs = new Map();
  for (const s of sites) cs.set(s.country || "?", (cs.get(s.country || "?") || 0) + 1);
  for (const s of l) st.set(s.label || s.status || "?", (st.get(s.label || s.status || "?") || 0) + 1);
  // clientes distintos, por clientId (dos clientes pueden llamarse igual): solo si todos los sitios dicen de qué cliente son
  // (si no, no se sabe: null). activeClients: clientes con al menos un sitio Activo.
  const cid = s => s.clientId != null && String(s.clientId).trim() !== "" ? String(s.clientId) : null;
  const distinct = x => !x.length ? 0 : x.every(cid) ? new Set(x.map(cid)).size : null;
  const act = l.filter(s => (s.label || s.status) === "Activo" || s.status === "Active");
  return { sites: l.length, clients: distinct(l), activeSites: act.length, activeClients: distinct(act), byStatus: list(st, { order: SITE_ORDER }), byCountry: [...cs].map(([key, n]) => ({ key, n })).sort((a, b) => b.n - a.n || a.key.localeCompare(b.key, "es")) };
}

// ---------- G. Archivados desde la app, por motivo (del registro de archivados: no del estado del colegio)
// Con equipo: lo que archivó alguien del equipo (por email).
export function archivedSummary(recs, { period, tz, country = "", countryOf = () => "", reasons = [], profiles = {}, team = null }) {
  const all = Object.entries(recs || {}).map(([id, r]) => ({ id, ...r })).filter(r => r && r.at && ofTeamEmail(team, r.by) && (!country || (countryOf(r.id) || "?") === country));
  const inPer = all.filter(r => inP(localDay(r.at, tz), period)), byR = new Map(), rows = new Map();
  for (const r of inPer) {
    byR.set(r.reason || "?", (byR.get(r.reason || "?") || 0) + 1);
    const e = k(r.by), x = rows.get(e) || { email: e, name: profiles[e]?.name || r.byName || e, n: 0 }; rows.set(e, x); x.n++;
  }
  const first = all.map(r => isoUtc(r.at)).filter(Boolean).sort()[0] || null;
  return { n: inPer.length, everN: all.length, since: first, reasons: list(byR, { order: reasons }), people: [...rows.values()].sort(alpha) };
}

// ---------- qué ve cada uno: todos, los totales y lo suyo (pub); el desglose por persona solo un líder (people, ruta con 403)
// me: id de Pipedrive de quien mira; email: su email (los contactos y archivados de la app son por email).
export function splitView(section, r, { me = null, email = "" } = {}) {
  const id = Number(me) || null, em = k(email), byId = rows => (id && rows.find(x => x.id === id)) || null, byEmail = rows => (em && rows.find(x => x.email === em)) || null;
  const head = { period: r.period, tz: r.tz, country: r.country, at: r.at, partial: r.partial };
  if (section === "demos") {
    const { loaded, held, ...rest } = r;
    return { pub: { ...rest, loaded: { totals: loaded.totals, mine: byId(loaded.people) }, held: { totals: held.totals, mineOwner: byId(held.byOwner), mineLoader: byId(held.byLoader) } },
      people: { ...head, loaded: [...loaded.people, ...(loaded.others || [])], heldByOwner: held.byOwner, heldByLoader: held.byLoader } };
  }
  if (section === "deals") {
    const { won, lost, open } = r;
    return { pub: { ...head, won: { n: won.n, byCountry: won.byCountry }, open: { n: open.n, noNext: open.noNext, pipes: open.pipes }, mine: dealsMine(r, id),
      lost: { n: lost.n, byCountry: lost.byCountry, reasons: lost.reasons, freeText: lost.freeText, afterProposal: lost.afterProposal, beforeProposal: lost.beforeProposal, stages: lost.stages } },
      people: { ...head, won: { byOwner: won.byOwner, bySdr: won.bySdr, list: won.list }, lost: { byOwner: lost.byOwner, bySdr: lost.bySdr }, noNext: open.noNextByOwner } };
  }
  // actividad por persona: todo es por persona, solo para líderes (las dos rutas cortan con 403 a los demás)
  if (section === "activity") return { pub: null, people: r };
  if (section === "contacts" || section === "archived") {
    const { people, ...rest } = r;
    return { pub: { ...rest, mine: byEmail(people) }, people: { ...head, people } };
  }
  return { pub: r, people: null };
}
