// Tope de gasto de la IA (Anthropic). Antes de cada pedido, guard() mira lo gastado hoy (toda la cuenta y la persona) y corta
// con 429 ai_budget si se pasó; después charge() suma lo que costó según usage. Se guarda por día (UTC) en Redis
// (hash ai:day:<fecha>: total, p:<email>, f:<función>) o en memoria. Topes: AI_DAILY_USD (toda la cuenta, 3 por defecto)
// AI_PERSON_USD (por persona, 2) y AI_MONTHLY_USD (toda la cuenta, 70 por mes, hash ai:month:<AAAA-MM>). AI_DAILY_USD=0 apaga la
// IA. Con Redis caído no se gasta.
import { kvEnabled, kv, key } from "./store.js";

// US$ por millón de tokens (entrada, salida). Un modelo que no está acá se cobra como el más caro de la lista.
const PRICE = { "claude-opus-5-5": [4, 20], "claude-sonnet-5-5": [2, 10], "claude-haiku-5-5": [0.1, 0.5], "claude-opus-5": [5, 25], "claude-opus-4-8": [5, 25], "claude-sonnet-5": [2, 10] };
const SEARCH_USD = 0.01; // cada búsqueda web: US$10 cada 1.000

export const limits = () => ({ day: num(process.env.AI_DAILY_USD, 3), person: num(process.env.AI_PERSON_USD, 2), month: num(process.env.AI_MONTHLY_USD, 70) });
const num = (v, d) => (v === undefined || v === "" || !Number.isFinite(Number(v)) ? d : Number(v));
const today = () => new Date().toISOString().slice(0, 10);
const dayKey = d => key("ai:day:" + d), monthKey = d => key("ai:month:" + d.slice(0, 7));

export function costOf(model, u = {}) {
  const [i, o] = PRICE[String(model || "").replace(/-\d{8}$/, "")] || [5, 25];
  const inTok = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) * 1.25 + (u.cache_read_input_tokens || 0) * 0.1;
  return (inTok * i + (u.output_tokens || 0) * o) / 1e6 + (u.server_tool_use?.web_search_requests || 0) * SEARCH_USD;
}

const mem = {}; // fecha → { total, "p:x": n, "f:y": n }
// Con Redis configurado y caído NO se sigue: sin saber cuánto se gastó, no se gasta (BudgetError).
async function read(d, fields) {
  if (kvEnabled) {
    try { const [r, m] = await kv([["HMGET", dayKey(d), ...fields], ["HGET", monthKey(d), "total"]]); return [...fields.map((_, k) => Number(r?.[k]) || 0), Number(m) || 0]; }
    catch { throw new BudgetError("No pude revisar el gasto de IA de hoy: probá de nuevo en un rato."); }
  }
  return [...fields.map(f => mem[d]?.[f] || 0), mem["m" + d.slice(0, 7)] || 0];
}

export class BudgetError extends Error {
  constructor(msg) { super(msg); this.status = 429; this.code = "ai_budget"; }
}
const usd = n => "US$" + n.toFixed(2).replace(".", ",");

// Antes de pedir: corta si hoy ya se gastó el tope (de toda la cuenta o de la persona).
export async function guard(email) {
  const L = limits();
  if (L.day <= 0) throw new BudgetError("La IA está apagada (tope de gasto en 0).");
  const [total, mine, month] = await read(today(), ["total", "p:" + (email || "-")]);
  if (month >= L.month) throw new BudgetError(`Se llegó al tope de gasto de IA del mes (${usd(L.month)} para todo el equipo).`);
  if (total >= L.day) throw new BudgetError(`Se llegó al tope de gasto de IA de hoy (${usd(L.day)} para todo el equipo). Vuelve mañana.`);
  if (email && mine >= L.person) throw new BudgetError(`Llegaste a tu tope de IA de hoy (${usd(L.person)}). Vuelve mañana.`);
}

// Después de pedir: suma lo que costó.
export async function charge(email, feature, model, usage) {
  const c = costOf(model, usage); if (!(c > 0)) return 0;
  const d = today(), f = { total: c, ["p:" + (email || "-")]: c, ["f:" + feature]: c };
  const m = (mem[d] ||= {}); for (const [k, v] of Object.entries(f)) m[k] = (m[k] || 0) + v;
  mem["m" + d.slice(0, 7)] = (mem["m" + d.slice(0, 7)] || 0) + c;
  if (kvEnabled) await kv([...Object.entries(f).map(([k, v]) => ["HINCRBYFLOAT", dayKey(d), k, v.toFixed(6)]), ["EXPIRE", dayKey(d), String(400 * 86400)],
    ["HINCRBYFLOAT", monthKey(d), "total", c.toFixed(6)], ["EXPIRE", monthKey(d), String(800 * 86400)]]).catch(() => {});
  if (c >= 0.25) console.log(`IA ${feature}: ${usd(c)}`);
  return c;
}

// Un pedido con tope: guard, el pedido y charge con su usage.
export async function metered(email, feature, fn) {
  await guard(email);
  const r = await fn();
  await charge(email, feature, r?.model, r?.usage);
  return r;
}

// Lo gastado en los últimos días (para dirección): un solo pedido a Redis para todos los días.
export async function usage(days = 7) {
  const ds = Array.from({ length: days }, (_, k) => new Date(Date.now() - k * 864e5).toISOString().slice(0, 10));
  let hs = ds.map(d => mem[d] || {});
  if (kvEnabled) { try { const r = await kv(ds.map(d => ["HGETALL", dayKey(d)])); hs = r.map(a => { const h = {}; for (let i = 0; i < (a || []).length; i += 2) h[a[i]] = Number(a[i + 1]) || 0; return h; }); } catch {} }
  const out = ds.map((d, k) => {
    const h = hs[k], pick = p => Object.fromEntries(Object.entries(h).filter(([x]) => x.startsWith(p)).map(([x, v]) => [x.slice(2), +v.toFixed(2)]));
    return { day: d, total: +(h.total || 0).toFixed(2), people: pick("p:"), features: pick("f:") };
  });
  return { limits: limits(), days: out };
}

// ---------- tablero de gasto (Equipo › Gasto de IA): la API la mide la app desde el 23/11/2026; lo de antes (la consola de
// Anthropic) y las suscripciones (precio fijo por mes: Claude Pro/Max/Team de cada persona) se cargan a mano. Un solo valor
// ai:plan sin vencimiento en Redis (o en memoria): { subs: [{ name, usd, since: "AAAA-MM" }], past: [{ month: "AAAA-MM", usd, note }], at, by }.
let planMem = { subs: [], past: [] };
export async function getPlan() {
  if (kvEnabled) { try { const [v] = await kv([["GET", key("ai:plan")]]); return v ? JSON.parse(v) : { subs: [], past: [] }; } catch { return { ...planMem, unknown: true }; } }
  return planMem;
}
const money = v => Math.round(Math.max(0, Math.min(100000, Number(String(v ?? "").replace(",", ".")) || 0)) * 100) / 100;
export function cleanPlan(p = {}, by = "") {
  const subs = (Array.isArray(p.subs) ? p.subs : []).slice(0, 30).map(x => ({ name: String(x?.name || "").trim().slice(0, 60), usd: money(x?.usd), since: /^\d{4}-(0[1-9]|1[0-2])$/.test(x?.since) ? x.since : new Date().toISOString().slice(0, 7) })).filter(x => x.name || x.usd);
  const past = (Array.isArray(p.past) ? p.past : []).slice(0, 36).map(x => ({ month: /^\d{4}-(0[1-9]|1[0-2])$/.test(x?.month) ? x.month : "", usd: money(x?.usd), note: String(x?.note || "").trim().slice(0, 80) })).filter(x => x.month && x.usd);
  return { subs, past, at: new Date().toISOString(), by };
}
export async function setPlan(p, by) {
  const v = cleanPlan(p, by);
  if (kvEnabled) await kv([["SET", key("ai:plan"), JSON.stringify(v)]]);
  else planMem = v;
  return v;
}
const monthsBack = n => { const d = new Date(); return Array.from({ length: n }, (_, k) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - k, 1)).toISOString().slice(0, 7)); };
// Todo lo del tablero: días (los últimos 31), por mes (6), topes y lo cargado a mano.
const r2 = n => +n.toFixed(2);
const daysIn = m => new Date(Date.UTC(+m.slice(0, 4), +m.slice(5), 0)).getUTCDate();
const mondayOf = d => { const t = new Date(d + "T00:00:00Z"), w = (t.getUTCDay() + 6) % 7; return new Date(t - w * 864e5).toISOString().slice(0, 10); };
// Todo lo del tablero, separado en API y suscripciones: hoy, esta semana (lunes a domingo), este mes y este año (en UTC, como
// el tope), más las series por día (31), por semana (12) y por mes (12). La suscripción es un precio por mes: en el día y la
// semana va prorrateada (precio del mes ÷ días del mes, por cada día).
export async function dashboard() {
  const u = await usage(92), plan = await getPlan(), months = monthsBack(12);
  let mt = months.map(m => mem["m" + m] || 0);
  if (kvEnabled) { try { const r = await kv(months.map(m => ["HGET", key("ai:month:" + m), "total"])); mt = r.map(Number).map(x => x || 0); } catch {} }
  // una suscripción cuenta desde su mes «since» (sin él, desde siempre)
  const subsIn = m => (plan.subs || []).filter(x => !x.since || x.since <= m).reduce((a, x) => a + (x.usd || 0), 0);
  const manualIn = m => (plan.past || []).filter(x => x.month === m).reduce((a, x) => a + x.usd, 0);
  const subsDay = d => subsIn(d.slice(0, 7)) / daysIn(d.slice(0, 7));
  const mrows = months.map((m, i) => ({ month: m, app: r2(mt[i]), manual: r2(manualIn(m)), api: r2(mt[i] + manualIn(m)), subs: r2(subsIn(m)) }));
  const byDay = Object.fromEntries(u.days.map(x => [x.day, x.total]));
  // semanas: las últimas 12, de lunes a domingo (los días que no se midieron cuentan 0)
  const today = u.days[0].day, w0 = mondayOf(today), weeks = [];
  for (let k = 0; k < 12; k++) {
    const from = new Date(Date.parse(w0 + "T00:00:00Z") - k * 7 * 864e5).toISOString().slice(0, 10);
    const ds = Array.from({ length: 7 }, (_, j) => new Date(Date.parse(from + "T00:00:00Z") + j * 864e5).toISOString().slice(0, 10)).filter(d => d <= today);
    weeks.push({ from, api: r2(ds.reduce((a, d) => a + (byDay[d] || 0), 0)), subs: r2(ds.reduce((a, d) => a + subsDay(d), 0)) });
  }
  const year = today.slice(0, 4), ym = mrows.filter(m => m.month.startsWith(year));
  const per = (api, subs) => ({ api: r2(api), subs: r2(subs), total: r2(api + subs) });
  const periods = {
    day: per(byDay[today] || 0, subsDay(today)),
    week: per(weeks[0].api, weeks[0].subs),
    month: per(mrows[0].api, mrows[0].subs),
    year: per(ym.reduce((a, m) => a + m.api, 0), ym.reduce((a, m) => a + m.subs, 0)),
  };
  return { ...u, days: u.days.slice(0, 31), plan, subsMonth: r2(subsIn(months[0])), months: mrows, weeks, periods, today, monthApp: mrows[0].app };
}
