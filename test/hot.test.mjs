// Bandeja caliente de Hoy: prospectos nuevos para vos (lib/sales.js) y filas con su motivo (public/js/core.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
for (const k of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "PIPEDRIVE_API_TOKEN", "DEMO_MODE"]) delete process.env[k];
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ob-test-"));
process.env.TZ = "UTC";
const { freshLeads } = await import("../lib/sales.js");
globalThis.document = { documentElement: { dataset: {} }, querySelectorAll: () => [] };
globalThis.matchMedia = () => ({ matches: false });
const { hotRows, agoText } = await import("../public/js/core.js");

const now = Date.parse("2026-11-10T15:00:00Z"), h = n => new Date(now - n * 3600e3).toISOString();
const L = (id, extra = {}) => ({ id, title: id, ownerId: 7, archived: false, addTime: h(2), ...extra });

test("freshLeads: solo tuyos, de los últimos 7 días, sin actividad hecha, nota tuya ni creados desde la app", () => {
  const leads = [L("a"), L("b", { addTime: h(30) }), L("viejo", { addTime: h(24 * 8) }), L("otro", { ownerId: 8 }), L("libre", { ownerId: null }), L("arch", { archived: true }),
    L("hecho"), L("nota"), L("app"), L("sinFecha", { addTime: null })];
  const r = freshLeads(leads, { me: 7, done: new Set(["hecho"]), noted: new Set(["nota"]), mine: new Set(["app"]), now });
  assert.deepEqual(r.map(l => l.id), ["a", "b"]);
});
test("freshLeads: lo más nuevo primero y sin usuario no hay nada", () => {
  assert.deepEqual(freshLeads([L("b", { addTime: h(30) }), L("a", { addTime: h(1) })], { me: 7, now }).map(l => l.id), ["a", "b"]);
  assert.deepEqual(freshLeads([L("a")], { me: null, now }), []);
});
test("agoText: minutos, horas y días", () => {
  assert.equal(agoText(h(0), now), "1 min");
  assert.equal(agoText(h(0.5), now), "30 min");
  assert.equal(agoText(h(2), now), "2 h");
  assert.equal(agoText(h(26), now), "1 día");
  assert.equal(agoText(h(72), now), "3 días");
});
test("hotRows: demos de hoy y mañana primero (por hora), después los prospectos; sin repetir la misma ficha", () => {
  const acts = [{ id: 1, type: "meeting", date: "2026-11-11", time: "10:00", schoolId: "s1", who: "Colegio A", subject: "Demo" },
    { id: 2, type: "meeting", date: "2026-11-10", time: "", record: "lead:x", who: "Colegio B", subject: "Demo" },
    { id: 3, type: "meeting", date: "2026-11-12", time: "09:00", schoolId: "s3", subject: "Demo pasado mañana" },
    { id: 4, type: "call", date: "2026-11-10", time: "", schoolId: "s4", subject: "Llamada" }];
  const leads = [{ id: "x", record: "lead:x", title: "Colegio B", addTime: h(2), assigned: true }, { id: "y", record: "lead:y", title: "Colegio C", addTime: h(3), assigned: false, event: "EduExperience 2026" }];
  const r = hotRows(acts, leads, "2026-11-10", now);
  assert.deepEqual(r.map(x => x.why), ["Demo hoy", "Demo mañana 10:00", "Nuevo hace 3 h"]);
  assert.deepEqual(r.map(x => [x.schoolId, x.record]), [[null, "lead:x"], ["s1", null], [null, "lead:y"]]);
  assert.equal(hotRows([], [leads[0]], "2026-11-10", now)[0].why, "Te lo asignaron hace 2 h");
  assert.deepEqual(hotRows([], [], "2026-11-10", now), []);
});
