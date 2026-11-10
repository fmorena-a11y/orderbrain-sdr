// Slack (opcional): mensajes de los canales de lanzamientos y bajas que nombran al colegio, para tener el contexto de un
// cliente, un onboarding o un churn sin salir de la ficha. El bot «Orderito» publica en #launches-and-churn cada lanzamiento y
// cada baja con un formato fijo («*Sitio:* … *Motivo:* …»): se lee ese formato y también los mensajes de personas.
// Necesita SLACK_BOT_TOKEN (scopes channels:history y users:read; el bot tiene que estar en los canales). Canales en
// SLACK_CHANNEL_ID, separados por coma (por defecto #launches-and-churn). Lee hasta 1.000 mensajes por canal, 30 minutos.
import { keyTokens, norm } from "./scan.js";

const env = process.env;
const TOKEN = env.SLACK_BOT_TOKEN || "", API = (env.SLACK_API_URL || "https://slack.com/api").replace(/\/$/, "");
const CHANNELS = String(env.SLACK_CHANNEL_ID || "C0B52KT5F7F").split(",").map(x => x.trim()).filter(Boolean);
export const slackEnabled = () => !!(TOKEN && CHANNELS.length);
const C = { at: 0, msgs: [], users: new Map(), inflight: null, error: "" };

async function call(method, params = {}) {
  const r = await fetch(`${API}/${method}?${new URLSearchParams(params)}`, { headers: { authorization: `Bearer ${TOKEN}` }, signal: AbortSignal.timeout(12000) });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(`Slack: ${j.error || r.status}`);
  return j;
}
// Texto de un mensaje: el del mensaje, o el de sus bloques o adjuntos (los bots a veces solo mandan eso)
const blockText = b => [b?.text?.text, ...(b?.fields || []).map(f => f.text), ...(b?.elements || []).map(e => e.text || "")].filter(Boolean).join("\n");
const textOf = m => m.text || [...(m.blocks || []).map(blockText), ...(m.attachments || []).map(a => a.text || a.fallback || "")].filter(Boolean).join("\n");
// Mensajes del bot: tipo y campos «*Clave:* valor»
const FIELD = { sitio: "site", colegio: "site", cliente: "client", "ubicación": "place", ubicacion: "place", account: "account", onboarder: "onboarder", autor: "author", motivo: "reason", "estado previo": "before" };
export function parseOrderito(text) {
  const t = String(text || ""), first = t.split("\n").find(l => l.trim()) || "";
  const kind = /LANZAMIENTO/i.test(first) ? "Lanzamiento" : /CHURN\s*\(([^)]+)\)/i.test(first) ? `Churn (${first.match(/CHURN\s*\(([^)]+)\)/i)[1].trim()})` : /CHURN/i.test(first) ? "Churn" : "";
  const fields = {};
  for (const m of t.matchAll(/\*([^*:\n]{2,20}):\*[ \t]*([^\n]*)/g)) { const k = FIELD[m[1].trim().toLowerCase()]; if (k && m[2].trim()) fields[k] = m[2].trim(); }
  return kind || fields.site ? { kind, fields } : null;
}
async function loadChannel(ch, out) {
  let cursor = "";
  for (let i = 0; i < 5; i++) {
    const j = await call("conversations.history", { channel: ch, limit: "200", ...(cursor ? { cursor } : {}) });
    for (const m of j.messages || []) {
      if (m.subtype && m.subtype !== "bot_message") continue; // entradas al canal, ediciones, etc.
      const text = textOf(m); if (!text) continue;
      const o = parseOrderito(text);
      out.push({ ch, ts: m.ts, user: m.user || "", bot: m.username || m.bot_profile?.name || "", text, o, n: ` ${norm(text)} `, site: o?.fields.site ? keyTokens(o.fields.site) : null });
    }
    cursor = j.response_metadata?.next_cursor || ""; if (!cursor) break;
  }
}
async function load() {
  if (Date.now() - C.at < 30 * 60e3) return;
  C.inflight ||= (async () => {
    try {
      const msgs = [];
      for (const ch of CHANNELS) await loadChannel(ch, msgs);
      C.msgs = msgs; C.at = Date.now(); C.error = "";
      const users = await call("users.list", { limit: "500" }).catch(() => null);
      for (const u of users?.members || []) C.users.set(u.id, u.profile?.real_name || u.real_name || u.name || "");
    } catch (e) { C.error = e.message; C.at = Date.now() - 25 * 60e3; } // reintenta en 5 minutos
    finally { C.inflight = null; }
  })();
  await C.inflight;
}
// ¿El mensaje habla de este colegio? Para los del bot, el «Sitio/Colegio» tiene que ser el mismo nombre (las mismas palabras
// propias, sin la ciudad); para los de personas, que aparezcan todas las palabras propias del nombre.
export function mentions(m, names, city = "") {
  const cityT = new Set(keyTokens(city));
  return names.some(name => {
    const w = keyTokens(name).filter(x => !cityT.has(x)); if (!w.length) return false;
    if (m.site) { const s = m.site.filter(x => !cityT.has(x)); return s.length === w.length && w.every(x => s.includes(x)); }
    return w.length >= 2 && w.every(x => m.n.includes(` ${x} `));
  });
}
// names: el nombre del colegio y, si está en World Dominion, el nombre de su sitio. Del más nuevo al más viejo.
export async function slackFor(names, city = "") {
  if (!slackEnabled()) return null;
  await load();
  const list = [...new Set((Array.isArray(names) ? names : [names]).filter(Boolean))];
  const clean = t => t.replace(/<@\w+(\|[^>]+)?>/g, "@").replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2").replace(/<(https?:[^>]+)>/g, "$1").replace(/:[a-z0-9_+-]+:/g, "").replace(/\*/g, "").replace(/\n{3,}/g, "\n\n").trim();
  const hit = C.msgs.filter(m => mentions(m, list, city)).sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 8);
  return { error: C.error, msgs: hit.map(m => ({ at: new Date(Number(m.ts) * 1000).toISOString(), by: C.users.get(m.user) || m.o?.fields.author || m.bot || "",
    kind: m.o?.kind || "", fields: m.o?.fields || {}, text: clean(m.text).slice(0, 700), url: `https://slack.com/archives/${m.ch}/p${m.ts.replace(".", "")}` })) };
}
