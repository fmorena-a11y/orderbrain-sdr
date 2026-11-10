// Métricas (vista «Métricas»): cálculos puros sobre lo crudo de Pipedrive, la base de colegios, World Dominion y los
// registros de la app. Regla: cada número sale de una definición exacta; lo que no se puede saber es null («?») o no se
// muestra. Sin puestos: los desgloses por persona van en orden alfabético y solo los ve un líder (server.js corta con 403).
import { addDays, fromUtc, safeTz } from "./time.js";
import { demoPast } from "./demos.js";

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
// registrada después: la hora de creación es la misma que la de hecha
export const preDone = a => { if (!a.done) return false; const x = Date.parse(isoUtc(a.add_time) || ""), y = Date.parse(isoUtc(a.done_time) || ""); return !isNaN(x) && x === y; };

// A1. Demos cargadas en el período (por la fecha en que se crearon en Pipedrive), por quién la cargó.
export function demosLoaded(acts, { users = [], profiles = {}, free = new Set(), period, tz, country = "", countryOf = a => a.country || "" }) {
  const W = who(users, profiles, free), tot = { total: 0, demo: 0, noshow: 0, preDone: 0, auto: 0, autoPreDone: 0, unknown: 0 }, rows = new Map(), others = new Map();
  for (const a of acts) {
    if (!DEMO_TYPES.has(a.type) || a.deleted || !inP(localDay(a.add_time, tz), period)) continue;
    if (country && (countryOf(a) || "?") !== country) continue;
    const l = W.loader(a), pre = preDone(a), kind = a.type === "lunch" ? "noshow" : "demo";
    tot.total++; tot[kind]++; if (pre) tot.preDone++;
    if (l.auto) { tot.auto++; if (pre) tot.autoPreDone++; }
    if (l.key === "?") tot.unknown++;
    // las automáticas y las sin creador no son personas: van aparte (others), con las mismas columnas
    const m = l.auto || l.key === "?" ? others : rows, r = m.get(l.key) || row(l, { total: 0, demo: 0, noshow: 0, preDone: 0 }); m.set(l.key, r);
    r.total++; r[kind]++; if (pre) r.preDone++;
  }
  return { totals: tot, people: [...rows.values()].sort(alpha), others: [...others.values()].sort((x, y) => !!y.auto - !!x.auto) };
}

// A2. Demos con fecha en el período: qué pasó, en este orden: la marca de la app → tipo No Show → hecha en Pipedrive →
// sin marcar (ya pasó y no está hecha). Una reprogramada cuya fecha nueva ya pasó: la marca no dice qué pasó (sigue la regla).
export const HELD = ["appDone", "appNoshow", "appCanceled", "noshow", "done", "unmarked", "upcoming"];
export function heldState(a, past) {
  const m = a.mark === "moved" && past ? null : a.mark || null;
  if (m === "done") return "appDone";
  if (m === "noshow") return "appNoshow";
  if (m === "canceled") return "appCanceled";
  if (a.type === "lunch") return "noshow";
  if (a.done) return "done";
  return past ? "unmarked" : "upcoming";
}
const heldBlank = () => Object.fromEntries([["total", 0], ...HELD.map(s => [s, 0])]);
export function demosHeld(acts, { users = [], profiles = {}, free = new Set(), period, tz, now = Date.now(), country = "", countryOf = a => a.country || "" }) {
  const W = who(users, profiles, free), tot = heldBlank(), byOwner = new Map(), byLoader = new Map(), items = [];
  const add = (m, p, st) => { const r = m.get(p.key) || row(p, heldBlank()); m.set(p.key, r); r.total++; r[st]++; };
  for (const a of acts) {
    if (!DEMO_TYPES.has(a.type) || a.deleted || !inP(fromUtc(a.due_date, a.due_time, tz).date, period)) continue;
    if (country && (countryOf(a) || "?") !== country) continue;
    const st = heldState(a, demoPast(a, now, tz));
    tot.total++; tot[st]++; items.push({ ...a, state: st });
    add(byOwner, W.person(a.owner_id), st); add(byLoader, W.loader(a), st);
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

// ---------- C. Tratos de los embudos de venta (los de MARKETS). País: el del embudo; en LatAm, el del campo País.
// ctx: { sales: Set(pipeline), pipeCountry: { pipe: país }, paisOf(d) → país o "", stageOf(id) → { name, order, pipe } }
export const dealCountry = (d, ctx) => ctx.pipeCountry[d.pipeline_id] || ctx.paisOf(d) || "";
export const userId = v => { const x = v && typeof v === "object" ? v.id ?? v.value : v; return Number(x) || null; };
export function dealsSummary({ won = [], lost = [], open = [], period, tz, country = "", users = [], profiles = {}, free = new Set(), lostReasons = [], ...ctx }) {
  const W = who(users, profiles, free), sales = d => ctx.sales.has(Number(d.pipeline_id)), cOf = d => dealCountry(d, ctx) || "?";
  const keep = d => sales(d) && (!country || cOf(d) === country);
  const people = () => new Map(), add = (m, p) => { const r = m.get(p.key) || row(p, { n: 0 }); m.set(p.key, r); r.n++; };
  const sorted = m => [...m.values()].sort((x, y) => (!!(x.free || x.none)) - (!!(y.free || y.none)) || alpha(x, y));
  const brief = d => ({ id: d.id, title: d.title || "", country: cOf(d), owner: W.person(d.owner_id).name || "", sdr: userId(d.sdr) ? W.person(userId(d.sdr)).name || "" : "" });
  const sdrOf = d => userId(d.sdr) ? W.person(userId(d.sdr)) : { key: "none", id: null, name: "", none: true };
  // C1. Ganados: hoy ganados, con fecha de ganado en el período
  const W1 = won.filter(d => d.status === "won" && keep(d) && inP(localDay(d.won_time, tz), period));
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
      const o = W.person(d.owner_id), x = noNext.get(o.key) || row(o, { n: 0, deals: [] }); noNext.set(o.key, x);
      x.n++; x.deals.push({ id: d.id, title: d.title || "", since: (isoUtc(d.update_time) || "").slice(0, 10) });
    }
  }
  const pipeRows = [...rows.values()].map(r => ({ pipe: r.pipe, country: ctx.pipeCountry[r.pipe] || "", total: r.total, noNext: r.noNext,
    stages: (ctx.stagesOf?.(r.pipe) || []).map(s => ({ id: s.id, name: s.name, n: r.stages.get(s.id) || 0 })).concat([...r.stages].filter(([id]) => !(ctx.stagesOf?.(r.pipe) || []).some(s => s.id === id)).map(([id, n]) => ({ id, name: ctx.stageOf(id)?.name || "?", n }))) }))
    .sort((a, b) => (ctx.pipeOrder?.indexOf(a.pipe) ?? 0) - (ctx.pipeOrder?.indexOf(b.pipe) ?? 0) || a.pipe - b.pipe);
  for (const x of noNext.values()) x.deals = x.deals.sort((a, b) => a.since.localeCompare(b.since)).slice(0, 10); // los 10 más quietos
  const byC = m => [...m].map(([key, n]) => ({ key, n })).sort((a, b) => (a.key === "?") - (b.key === "?") || b.n - a.n || a.key.localeCompare(b.key, "es"));
  return {
    won: { n: W1.length, byCountry: byC(wonCountry), byOwner: sorted(wonOwner), bySdr: sorted(wonSdr), list: W1.map(d => ({ ...brief(d), day: localDay(d.won_time, tz) })).sort((a, b) => a.day.localeCompare(b.day) || a.id - b.id) },
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
export function contactsSummary(touches, { period, tz, country = "", countryOf = () => "", outcomes = [], profiles = {}, cut = false }) {
  const blank = () => ({ n: 0, connected: 0, demo: 0, channels: {} }), tot = blank(), out = new Map(), rows = new Map();
  const add = (r, t) => { r.n++; if (t.connected) r.connected++; if (t.demo) r.demo++; inc(r.channels, CHANNELS.includes(t.channel) ? t.channel : "other"); };
  for (const t of touches) {
    if (!inP(localDay(t.at, tz), period)) continue;
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
  // clientes distintos: solo si todos los sitios dicen de qué cliente son (si no, no se sabe: null)
  const clients = l.length && l.every(s => String(s.client || "").trim()) ? new Set(l.map(s => k(s.client))).size : l.length ? null : 0;
  return { sites: l.length, clients, byStatus: list(st, { order: SITE_ORDER }), byCountry: [...cs].map(([key, n]) => ({ key, n })).sort((a, b) => b.n - a.n || a.key.localeCompare(b.key, "es")) };
}

// ---------- G. Archivados desde la app, por motivo (del registro de archivados: no del estado del colegio)
export function archivedSummary(recs, { period, tz, country = "", countryOf = () => "", reasons = [], profiles = {} }) {
  const all = Object.entries(recs || {}).map(([id, r]) => ({ id, ...r })).filter(r => r && r.at && (!country || (countryOf(r.id) || "?") === country));
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
  if (section === "contacts" || section === "archived") {
    const { people, ...rest } = r;
    return { pub: { ...rest, mine: byEmail(people) }, people: { ...head, people } };
  }
  return { pub: r, people: null };
}
