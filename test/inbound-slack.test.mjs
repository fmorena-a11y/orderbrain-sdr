// Tus inbound con el token de Slack (un Slack falso local): conversations.history del canal privado, users.info para saber
// el email de a quién le toca, chat.getPermalink para el enlace en la nota, y qué pasa si la app no está en el canal.
// Pipedrive de prueba en memoria (DEMO_MODE). Datos inventados.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
for (const k of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "PIPEDRIVE_API_TOKEN", "ANTHROPIC_API_KEY"]) delete process.env[k];
process.env.DEMO_MODE = "1";
process.env.DEV_LOGIN_EMAIL = "demo@example.com";
process.env.SLACK_BOT_TOKEN = "xoxb-prueba";
process.env.SLACK_API_URL = "https://slack.test/api";
process.env.SLACK_INBOUND_CHANNEL = "C0PRUEBA01";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ob-inbound-slack-"));
const now = Math.floor(Date.now() / 1000), calls = [];
let fail = "";
const MSGS = [
  { type: "message", ts: `${now - 3600}.000100`, user: "U0SALVA", text: "*Lead para llamar* — le toca a <@U0FACU0001|Facu Morena>\n:moneybag: Este lead viene de PAUTA en Meta Ads (Facebook/Instagram) · campaña: 1\n\n*Teléfono:* +54 11 5555 0321  ·  <https://wa.me/541155550321|WhatsApp>\n*Nombre:* Paula Slack\n*Colegio:* Colegio Slack de Prueba\n*País:* Argentina\n*Email:* <mailto:paula@slack-ejemplo.test|paula@slack-ejemplo.test>\n*Puesto:* Otro\n*Mensaje:* —" },
  { type: "message", subtype: "channel_join", ts: `${now - 7200}.000100`, user: "U0FACU0001", text: "<@U0FACU0001> has joined the channel" },
  { type: "message", ts: `${now - 40 * 86400}.000100`, user: "U0SALVA", text: "*Lead para llamar* — le toca a <@U0FACU0001|Facu Morena>\n*Teléfono:* 1100000000\n*Nombre:* Muy Viejo" },
];
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(String(url)); calls.push({ method: u.pathname.split("/").pop(), params: Object.fromEntries(u.searchParams), auth: opts.headers?.authorization });
  const json = o => ({ ok: true, status: 200, json: async () => o });
  if (u.host !== "slack.test") throw new Error("sin red en la prueba");
  const m = u.pathname.split("/").pop();
  if (fail) return json({ ok: false, error: fail });
  if (m === "conversations.history") return json({ ok: true, messages: MSGS.filter(x => Number(x.ts) >= Number(u.searchParams.get("oldest"))), response_metadata: { next_cursor: "" } });
  if (m === "users.info") return json({ ok: true, user: { id: u.searchParams.get("user"), profile: { real_name: "Facu Morena", email: "demo@example.com" } } });
  if (m === "chat.getPermalink") return json({ ok: true, permalink: `https://ordereat.slack.com/archives/C0PRUEBA01/p${u.searchParams.get("message_ts").replace(".", "")}` });
  return json({ ok: false, error: "unknown_method" });
};
const IR = await import("../lib/inbound-run.js");
const pd = await import("../lib/pipedrive.js");
const me = { email: "demo@example.com", name: "Demo", pdUserId: 1 };

test("con token: lee el canal (sin entradas al canal ni lo de hace más de 30 días), el email de Slack dice de quién es y la nota lleva el enlace", async () => {
  const l = await IR.listFor(me, false);
  assert.equal(l.slack.on, true); assert.equal(l.slack.demo, false); assert.equal(l.slack.error, "");
  assert.deepEqual(l.items.map(x => [x.name, x.assignee.how]), [["Paula Slack", "slack"]]);
  const h = calls.find(c => c.method === "conversations.history");
  assert.equal(h.params.channel, "C0PRUEBA01"); assert.equal(h.auth, "Bearer xoxb-prueba"); assert.ok(Number(h.params.oldest) < now - 30 * 86400);
  const r = await IR.processMine(me, { tz: "America/Argentina/Buenos_Aires" });
  const s = r.results[0].state;
  assert.equal(s.status, "done"); assert.equal(s.title, "Colegio Slack de Prueba (Inbound Meta Ads)");
  const notes = await pd.notesForLead(s.id, 5);
  assert.ok(notes.some(n => n.content.includes(`https://ordereat.slack.com/archives/C0PRUEBA01/p${MSGS[0].ts.replace(".", "")}`)));
});
test("si Slack responde con error (la app no está en el canal), se avisa y lo pegado sigue andando", async () => {
  fail = "not_in_channel";
  IR.forgetSlack();
  const l = await IR.listFor(me, false);
  assert.equal(l.slack.error, "not_in_channel");
  const p = await IR.paste(me, "*Lead para llamar* — le toca a @\n*Teléfono:* +54 11 5555 0999\n*Nombre:* Pegado Igual\n*Colegio:* Colegio Pegado Igual\n*País:* Argentina");
  assert.equal(p.added, 1);
  assert.ok((await IR.listFor(me, false)).items.some(x => x.name === "Pegado Igual"));
  fail = "";
});
