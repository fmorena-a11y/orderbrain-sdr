// Demos del equipo, Métricas y «Hoy» del líder.
import crypto from "crypto";
import * as pd from "../pipedrive.js";
import { allArchived, byId, cacheGet, cacheSet, getProfiles, orgToSchool, touchWindow } from "../store.js";
import { DEFAULT_ACCOUNTS, FREE_OWNERS, LOST_REASONS, MARKETS, OPTIONS } from "../config.js";
import { MAIL_SENT, OUTCOMES } from "../playbook.js";
import { addDays, fromUtc, safeTz, toUtc, todayIn } from "../time.js";
import { RESULTS, ddmm, demoPast, monthBoard, periodChoices, pickPeriod, resultLine, sourceKind, withResult } from "../demos.js";
import * as MX from "../metrics.js";
import { ARCHIVE_REASONS } from "../archive.js";
import { bad, esc } from "../text.js";
import { nice, signer } from "./util.js";
import { appCountry } from "./records.js";
import { demoMoved, demoReminder } from "./contact.js";

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
// Tarjeta «Demos» de Equipo (solo líderes y dirección): un mes o un trimestre (periodKey «2026-11» o «2026-Q4»; sin elegir, el mes
// en curso) en la zona de quien mira. Se lee un día de margen a cada lado (las fechas de Pipedrive están en UTC). La Fuente de
// cada demo: la del trato; sin trato, la del prospecto. Si no se pudo leer, «unread» («?»): nunca se cuenta como outbound.
// ae: los Account Executive (rol del perfil o los de DEFAULT_ACCOUNTS, como en lib/accounts.js): sus demos no se ponderan.
export async function demosMonth(tz, periodKey = "", team = null) {
  const t = todayIn(tz), period = pickPeriod(periodKey, t), raw = await demosRaw(addDays(period.from, -1), addDays(period.to, 1));
  const [m, profiles, labels] = await Promise.all([pd.meta(), getProfiles(), pd.fuenteLabels()]);
  const inP = raw.demos.filter(a => { const d = fromUtc(a.due_date, a.due_time, tz).date; return d >= period.from && d <= period.to; });
  const dealIds = [...new Set(inP.map(a => Number(a.deal_id)).filter(Boolean))].sort((a, b) => a - b);
  const leadIds = [...new Set(inP.filter(a => !a.deal_id && a.lead_id).map(a => a.lead_id))].sort();
  const dk = `demos:src:${crypto.createHash("sha1").update(`${dealIds.join(",")}|${leadIds.join(",")}`).digest("hex").slice(0, 16)}`;
  const src = await cached(dk, 600, async () => {
    const [deals, leads] = await Promise.all([pd.dealsByIds(dealIds).then(l => ({ ok: true, l }), () => ({ ok: false, l: [] })), pd.leadsByIds(leadIds).then(l => ({ ok: true, l }), () => ({ ok: false, l: [] }))]);
    return { deals: deals.ok ? Object.fromEntries(deals.l.map(d => [d.id, d.fuente ?? null])) : null, leads: leads.ok ? Object.fromEntries(leads.l.map(l => [l.id, l.fuenteOpt ?? null])) : null };
  });
  const sourceOf = a => {
    if (a.deal_id) { if (!src.deals) return { kind: "unread", label: "" }; return Object.hasOwn(src.deals, a.deal_id) ? sourceKind(src.deals[a.deal_id], labels) : { kind: "none", label: "El trato ya no está en Pipedrive" }; }
    if (a.lead_id) { if (!src.leads) return { kind: "unread", label: "" }; return Object.hasOwn(src.leads, a.lead_id) ? sourceKind(src.leads[a.lead_id], labels) : { kind: "unread", label: "No pude leer el prospecto" }; }
    return { kind: "none", label: "Sin trato ni prospecto" };
  };
  const ae = new Set(m.users.filter(u => profiles[String(u.email || "").toLowerCase()]?.role === "ae" || Object.values(DEFAULT_ACCOUNTS).map(Number).includes(Number(u.id))).map(u => Number(u.id)));
  return { ...monthBoard(raw.demos, { users: m.users, profiles, free: FREE_OWNERS, period, tz, team, sourceOf, ae }), choices: periodChoices(t), at: raw.at, partial: raw.partial };
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
  const [created, held, { m, profiles, users }] = await Promise.all([createdDemos(addDays(period.from, -1)), demosRaw(addDays(period.from, -1), addDays(t, 15)), mxBase()]);
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
  return cached(`mx:act:2:${period.from}:${t}:${z}:${teamKey(team)}`, 600, async () => {
    const [raw, types, { profiles, users }] = await Promise.all([activityRaw(addDays(period.from, -1), addDays(t, 1)), pd.activityTypes().catch(() => null), mxBase()]);
    // los que usan la app van aunque estén en cero (las cuentas generales, no)
    const include = users.filter(u => profiles[u.email] && !FREE_OWNERS.has(Number(u.id))).map(u => u.id);
    return { period, tz: z, country: "", countryApplies: false, at: raw.at, partial: raw.partial, typesKnown: !!types, read: { done: raw.done.length, pending: raw.pending.length },
      ...MX.activitySummary({ done: raw.done, pending: raw.pending, types: types || [], users, profiles, free: FREE_OWNERS, include, period, tz: z, today: t, partial: raw.partial, team }) };
  });
}
// ---------- «Hoy» del líder (lib/lead-api.js, lógica en lib/leadview.js). NO lee nada nuevo de Pipedrive: usa las MISMAS lecturas
// (y la misma clave de copia, 10 minutos) que Métricas con «7 días» y que Equipo › Demos del mes en curso.
//  · leadActs: las actividades de toda la cuenta (activityRaw): hechas cambiadas en la semana y todas las sin hacer hasta mañana.
//  · leadDemos: el tablero del mes (demosMonth, lo que muestra Equipo › Demos: «Cuentan») y las demos de los últimos 7 días hasta
//    mañana (demosRaw de Métricas: lee hasta 15 días adelante) para las de hoy, las de mañana y las pasadas sin marcar.
export async function leadActs(tz) {
  const z = safeTz(tz), t = todayIn(z), raw = await activityRaw(addDays(MX.periodOf(t, 7).from, -1), addDays(t, 1));
  return { today: t, tz: z, at: raw.at, partial: raw.partial, done: raw.done, pending: raw.pending };
}
export async function leadDemos(tz, team = null) {
  const z = safeTz(tz), t = todayIn(z), from = MX.periodOf(t, 7).from, to = addDays(t, 1);
  const [month, raw, { users, profiles }] = await Promise.all([demosMonth(z, "", team), demosRaw(addDays(from, -1), addDays(t, 15)), mxBase()]);
  const win = monthBoard(raw.demos, { users, profiles, free: FREE_OWNERS, period: { from, to }, tz: z, team });
  return { today: t, tz: z, month, window: { from, to, at: raw.at, partial: !!raw.partial, items: win.items } };
}
// H. Inbound (lib/metrics.js inboundSummary). Lecturas de toda la cuenta por fecha de creación, de la más nueva a la más vieja,
// hasta pasar fromDay (un día antes del período: las fechas de Pipedrive están en UTC), de a 500 y con tope (INB_PAGES; si se
// pasa, partial y los números quedan «?»). Se guardan 10 minutos en memoria (son miles de filas: no van al store).
export const INB_PAGES = { leads: 60, deals: 30 }; // tope de páginas de 500 (las pruebas lo bajan)
const inbRawMem = new Map();
function createdRaw(kind, fromDay) {
  const k = `${kind}|${fromDay}`, hit = inbRawMem.get(k);
  if (hit && Date.now() - hit.t < 600e3) return hit.p;
  for (const [x, v] of inbRawMem) if (Date.now() - v.t >= 600e3) inbRawMem.delete(x);
  const p = (async () => {
    const at = new Date().toISOString(), out = []; let partial = false;
    if (kind === "leads") {
      for (let start = 0, n = 0; ; n++) {
        if (n === INB_PAGES.leads) { partial = true; break; }
        const r = await pd.leadsCreatedPage({ start }); out.push(...r.items);
        const last = r.items.at(-1)?.add_time; if (r.next == null || (last && utcDay(last) < fromDay)) break; start = r.next;
      }
    } else {
      let cursor = null;
      for (let n = 0; ; n++) {
        if (n === INB_PAGES.deals) { partial = true; break; }
        const r = await pd.dealsCreatedPage({ cursor }); out.push(...r.items);
        if (!r.next || (r.oldest && utcDay(r.oldest) < fromDay)) break; cursor = r.next;
      }
    }
    return { at, partial, items: out.filter(x => utcDay(x.add_time) >= fromDay) };
  })();
  inbRawMem.set(k, { t: Date.now(), p });
  p.catch(() => inbRawMem.delete(k));
  return p;
}
// Prospectos y tratos con Fuente inbound que entraron en el período, sus contactos (las actividades hechas de activityRaw, la
// misma lectura que Actividad por persona) y sus demos (demosRaw, la misma lectura que Demos: hasta 15 días adelante).
export async function metricsInbound(tz, { days = 7, team = null } = {}) {
  const z = safeTz(tz), t = todayIn(z), period = MX.periodOf(t, days), from = addDays(period.from, -1);
  return cached(`mx:inb:1:${period.from}:${t}:${z}:${teamKey(team)}`, 600, async () => {
    const [leads, deals, acts, demos, labels, { profiles, users }] = await Promise.all([createdRaw("leads", from), createdRaw("deals", from), activityRaw(from, addDays(t, 1)),
      demosRaw(from, addDays(t, 15)), pd.fuenteLabels(), mxBase()]);
    const ids = OPTIONS.fuente.inbound, memo = new Map(), kindsOf = v => { const key = JSON.stringify(v ?? null); if (!memo.has(key)) memo.set(key, MX.inboundKinds(v, { ids, labels })); return memo.get(key); };
    const partial = { leads: leads.partial, deals: deals.partial, acts: !!(acts.partial.updated || acts.partial.ahead || acts.partial.pending), demos: !!demos.partial };
    const sum = MX.inboundSummary({ leads: leads.items, deals: deals.items, acts: [...acts.done, ...acts.pending], demos: demos.demos, period, tz: z, users, profiles, free: FREE_OWNERS, team,
      sales: SALES_PIPES, kindsOf, outcomes: OUTCOMES, lostReasons: LOST_REASONS, partial });
    // el nombre de cada opción de la Fuente (para decir qué es cada pestaña, como está en la cuenta)
    const fuente = Object.fromEntries(Object.entries(ids).map(([key, id]) => [key, labels.get(String(id)) || ""]));
    return { period, tz: z, country: "", at: { leads: leads.at, deals: deals.at, acts: acts.at, demos: demos.at }, partial, fuente, ...sum };
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
