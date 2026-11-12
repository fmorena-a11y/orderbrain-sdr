// Lo que la sesión anota de un contacto sale de lo que logContact guardó de verdad: el próximo paso (elegido o el automático
// del primer contacto) y la demo. Con el Pipedrive de prueba.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
for (const k of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "PIPEDRIVE_API_TOKEN", "ANTHROPIC_API_KEY"]) delete process.env[k];
process.env.DEMO_MODE = "1";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ob-test-"));
const sales = await import("../lib/sales.js");
const { schools, getMatch } = await import("../lib/store.js");
const ss = await import("../lib/sessions.js");
const user = { email: "demo@example.com", name: "Demo", pdUserId: 1 };
// nuevos de verdad: sin organización y sin nada parecido en Pipedrive (la investigación antes de crear no encuentra nada)
const fresh = [];
for (const s of schools.filter(x => x.country === "México" && !getMatch(x.id)?.orgId)) {
  if (fresh.length >= 3) break;
  const r = await sales.checkSchool(s.id);
  if (r.status === "new" && (await sales.investigate(s.id)).r.verdict === "none") fresh.push(s);
}

test("logContact devuelve el próximo paso automático del primer contacto y la sesión lo anota", async () => {
  const s = fresh[0];
  const r = await sales.logContact(s.id, user, { outcome: "no_answer", channel: "call" }, "UTC");
  assert.equal(r.next.type, "call"); assert.equal(r.next.auto, true); assert.match(r.next.date, /^\d{4}-\d{2}-\d{2}$/); assert.equal(r.demo, null);
  const step = ss.contactStep(s.id, { channel: "call", outcome: "no_answer", next: r.next, demo: r.demo });
  assert.deepEqual(step.next, { type: "call", date: r.next.date, time: "", ownerId: 1, auto: true });
});
test("logContact devuelve el próximo paso elegido y la demo agendada", async () => {
  const r = await sales.logContact(fresh[1].id, user, { outcome: "info", channel: "whatsapp", next: { type: "task", date: "2026-11-20", time: "09:30" } }, "UTC");
  assert.deepEqual(r.next, { type: "task", date: "2026-11-20", time: "09:30", ownerId: 1 });
  const d = await sales.logContact(fresh[2].id, user, { outcome: "demo", channel: "call", demo: { date: "2026-11-21", time: "11:00", duration: 30 } }, "UTC");
  assert.deepEqual(d.demo, { date: "2026-11-21", time: "11:00" }); assert.equal(d.next, null);
});
