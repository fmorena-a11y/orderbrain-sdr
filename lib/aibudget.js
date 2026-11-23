// Tope de gasto de la IA (Anthropic). Antes de cada pedido, guard() mira lo gastado hoy (toda la cuenta y la persona) y corta
// con 429 ai_budget si se pasó; después charge() suma lo que costó según usage. Se guarda por día (UTC) en Redis
// (hash ai:day:<fecha>: total, p:<email>, f:<función>) o en memoria. Topes: AI_DAILY_USD (toda la cuenta, 3 por defecto)
// AI_PERSON_USD (por persona, 2) y AI_MONTHLY_USD (toda la cuenta, 30 por mes, hash ai:month:<AAAA-MM>). AI_DAILY_USD=0 apaga la
// IA. Con Redis caído no se gasta.
import { kvEnabled, kv, key } from "./store.js";

// US$ por millón de tokens (entrada, salida). Un modelo que no está acá se cobra como el más caro de la lista.
const PRICE = { "claude-opus-5-5": [4, 20], "claude-sonnet-5-5": [2, 10], "claude-haiku-5-5": [0.1, 0.5], "claude-opus-5": [5, 25], "claude-opus-4-8": [5, 25], "claude-sonnet-5": [2, 10] };
const SEARCH_USD = 0.01; // cada búsqueda web: US$10 cada 1.000

export const limits = () => ({ day: num(process.env.AI_DAILY_USD, 3), person: num(process.env.AI_PERSON_USD, 2), month: num(process.env.AI_MONTHLY_USD, 30) });
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
  if (kvEnabled) await kv([...Object.entries(f).map(([k, v]) => ["HINCRBYFLOAT", dayKey(d), k, v.toFixed(6)]), ["EXPIRE", dayKey(d), String(40 * 86400)],
    ["HINCRBYFLOAT", monthKey(d), "total", c.toFixed(6)], ["EXPIRE", monthKey(d), String(70 * 86400)]]).catch(() => {});
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

// Lo gastado en los últimos días (para dirección).
export async function usage(days = 7) {
  const out = [];
  for (let k = 0; k < days; k++) {
    const d = new Date(Date.now() - k * 864e5).toISOString().slice(0, 10);
    let h = mem[d] || {};
    if (kvEnabled) { try { const [r] = await kv([["HGETALL", dayKey(d)]]); h = {}; for (let i = 0; i < (r || []).length; i += 2) h[r[i]] = Number(r[i + 1]) || 0; } catch {} }
    const pick = p => Object.fromEntries(Object.entries(h).filter(([x]) => x.startsWith(p)).map(([x, v]) => [x.slice(2), +v.toFixed(2)]));
    out.push({ day: d, total: +(h.total || 0).toFixed(2), people: pick("p:"), features: pick("f:") });
  }
  return { limits: limits(), days: out };
}
