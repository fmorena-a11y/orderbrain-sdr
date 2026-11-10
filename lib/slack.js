// Slack (opcional): mensajes del canal de colegios lanzados que nombran al colegio, para tener el contexto de un cliente,
// un onboarding o un churn sin salir de la ficha. Necesita SLACK_BOT_TOKEN (scopes channels:history y users:read; el bot tiene
// que estar en el canal) y SLACK_CHANNEL_ID. Sin eso no hace nada. Lee hasta 1.000 mensajes y los guarda 30 minutos.
import { keyTokens, norm } from "./scan.js";

const env = process.env;
const TOKEN = env.SLACK_BOT_TOKEN || "", CHANNEL = env.SLACK_CHANNEL_ID || "", API = (env.SLACK_API_URL || "https://slack.com/api").replace(/\/$/, "");
export const slackEnabled = () => !!(TOKEN && CHANNEL);
const C = { at: 0, msgs: [], users: new Map(), inflight: null, error: "" };

async function call(method, params = {}) {
  const r = await fetch(`${API}/${method}?${new URLSearchParams(params)}`, { headers: { authorization: `Bearer ${TOKEN}` }, signal: AbortSignal.timeout(12000) });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(`Slack: ${j.error || r.status}`);
  return j;
}
async function load() {
  if (Date.now() - C.at < 30 * 60e3) return;
  C.inflight ||= (async () => {
    try {
      const msgs = []; let cursor = "";
      for (let i = 0; i < 5; i++) {
        const j = await call("conversations.history", { channel: CHANNEL, limit: "200", ...(cursor ? { cursor } : {}) });
        for (const m of j.messages || []) if (m.text && !m.subtype) msgs.push({ ts: m.ts, user: m.user || "", text: m.text, n: ` ${norm(m.text)} ` });
        cursor = j.response_metadata?.next_cursor || ""; if (!cursor) break;
      }
      C.msgs = msgs; C.at = Date.now(); C.error = "";
      const users = await call("users.list", { limit: "500" }).catch(() => null);
      for (const u of users?.members || []) C.users.set(u.id, u.profile?.real_name || u.real_name || u.name || "");
    } catch (e) { C.error = e.message; C.at = Date.now() - 25 * 60e3; } // reintenta en 5 minutos
    finally { C.inflight = null; }
  })();
  await C.inflight;
}
// Mensajes que nombran al colegio: todas sus palabras propias (sin la ciudad), del más nuevo al más viejo.
export async function slackFor(name, city = "") {
  if (!slackEnabled()) return null;
  await load();
  const cityT = new Set(keyTokens(city)), words = keyTokens(name).filter(w => !cityT.has(w));
  if (!words.length) return { msgs: [], error: C.error };
  const hit = C.msgs.filter(m => words.every(w => m.n.includes(` ${w} `))).sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 6);
  return { error: C.error, msgs: hit.map(m => ({ at: new Date(Number(m.ts) * 1000).toISOString(), by: C.users.get(m.user) || "", text: m.text.replace(/<@\w+>/g, "@").replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2").replace(/<(https?:[^>]+)>/g, "$1").slice(0, 600),
    url: `https://slack.com/archives/${CHANNEL}/p${m.ts.replace(".", "")}` })) };
}
