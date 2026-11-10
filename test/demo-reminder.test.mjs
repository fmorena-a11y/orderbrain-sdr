// «Demo blindada»: qué recordatorios «Confirmar demo» se mueven (reminderPlan) y quién agendó una demo (bookedBy). Lógica pura.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
for (const k of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "PIPEDRIVE_API_TOKEN", "DEMO_MODE"]) delete process.env[k];
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ob-test-"));
const { reminderPlan } = await import("../lib/sales.js");
const { bookedBy, compactAct } = await import("../lib/pipedrive.js");

const sdr = { id: 1, owner_id: 2 }, otro = { id: 2, owner_id: 5 };
test("reminderPlan: al agendar se mueve solo el tuyo; el de otra persona queda y se avisa", () => {
  assert.deepEqual(reminderPlan([sdr, otro], { userId: 2 }), { move: [sdr], others: [otro] });
  assert.deepEqual(reminderPlan([otro], { userId: 2 }), { move: [], others: [otro] });
});
test("reminderPlan: el líder o quien mueve una demo ya revisada (any) mueve el de quien agendó, sin duplicar", () => {
  assert.deepEqual(reminderPlan([sdr, otro], { userId: 3, leader: true }), { move: [sdr, otro], others: [] });
  assert.deepEqual(reminderPlan([sdr], { userId: 3, any: true }), { move: [sdr], others: [] });
  assert.deepEqual(reminderPlan([], { userId: 3, any: true }), { move: [], others: [] });
});
test("bookedBy: quién agendó la demo, de la nota de la app; nada si no es demo o no lo dice", () => {
  assert.equal(bookedBy({ type: "meeting", note: "Agendada por Juan Diego desde OrderBrain SDR<br><br>hola" }), "Juan Diego");
  assert.equal(bookedBy({ type: "meeting", note: "Llamar\n\n(Agendado por Ana &amp; Co desde OrderBrain SDR)" }), "Ana & Co");
  assert.equal(bookedBy({ type: "call", note: "Agendada por Juan Diego desde OrderBrain SDR" }), null);
  assert.equal(bookedBy({ type: "meeting", note: null }), null);
  assert.equal(compactAct({ id: 1, type: "meeting", owner_id: 3, note: "Agendada por Juan Diego desde OrderBrain SDR" }).by, "Juan Diego");
  assert.equal("by" in compactAct({ id: 1, type: "meeting", owner_id: 3, note: "otra cosa" }), false);
});
