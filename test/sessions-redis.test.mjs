// Sesiones activas con Redis (Upstash falso): cada sesión en su clave, un índice de resúmenes por persona y los colegios de
// las abiertas aparte. Lo de otro dispositivo se ve, el candado se suelta, todo vence solo y las terminadas viejas se borran.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakeUpstash } from "./fake-upstash.mjs";
for (const k of ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "PIPEDRIVE_API_TOKEN", "DEMO_MODE"]) delete process.env[k];
const R = await fakeUpstash();
process.env.KV_REST_API_URL = R.url; process.env.KV_REST_API_TOKEN = "x"; process.env.KV_PREFIX = "t:";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ob-test-"));
const ss = await import("../lib/sessions.js");
const { SESS_TTL_S } = await import("../lib/store.js");
after(() => R.close());

const T0 = Date.parse("2026-11-10T13:00:00Z");
const A = "ana@ordereat.com";
test("Redis: una clave por sesión + índice por persona; lo de otro dispositivo se ve y el candado se suelta", async () => {
  const { session } = await ss.createFor("Ana@ordereat.com", { name: "Pachuca", origin: { kind: "zone", key: "zone:pachuca" }, items: [{ ref: "a" }, { ref: "b" }] }, T0);
  assert.ok(R.str.has(`t:sess:${A}:${session.id}`));
  assert.deepEqual([...R.hash.keys()].filter(k => k.includes(A)).sort(), [`t:sessidx:${A}`, `t:sessrefs:${A}`]);
  assert.equal(R.hash.get(`t:sessrefs:${A}`).get(session.id), "a\nb");
  // todo vence solo si la persona deja de entrar
  for (const k of [`t:sess:${A}:${session.id}`, `t:sessidx:${A}`, `t:sessrefs:${A}`]) assert.ok(R.ttl(k) > SESS_TTL_S - 5, k);
  // «otro dispositivo»: escribe directo en Redis un contacto en b
  const raw = JSON.parse(R.str.get(`t:sess:${A}:${session.id}`));
  raw.steps.push({ ref: "b", kind: "contact", channel: "call", outcome: "info", at: new Date(T0 + 5e3).toISOString() });
  R.run(["SET", `t:sess:${A}:${session.id}`, JSON.stringify(raw)]);
  const v = await ss.getFor(A, session.id);
  assert.equal(v.stats.worked, 1); assert.equal(v.resume, 0);
  const n0 = R.log.length;
  const r = await ss.recordFor(A, session.id, ss.contactStep("a", { channel: "whatsapp", outcome: "callback", connected: true }), T0 + 9e3);
  assert.equal(r.summary, "1 llamada · 1 WhatsApp"); assert.equal(r.resume, -1);
  // anotar lee y escribe solo esa sesión (nada de HGETALL de todas)
  assert.deepEqual(R.log.slice(n0).filter(c => c[0] === "HGETALL"), []);
  assert.ok(R.log.slice(n0).some(c => c[0] === "GET" && c[1] === `t:sess:${A}:${session.id}`));
  assert.ok(R.log.some(c => c[0] === "SET" && c[1] === `t:lock:sess:${A}`));
  assert.equal(R.run(["GET", `t:lock:sess:${A}`]), null); // el candado no queda puesto
  assert.deepEqual((await ss.listFor("juan@ordereat.com", T0)).open, []);
  // la lista lleva solo resúmenes: sin colegios ni pasos
  const L = await ss.listFor(A, T0 + 10e3);
  assert.equal(L.open[0].id, session.id); assert.equal(L.open[0].items, undefined); assert.equal(L.open[0].steps, undefined);
  assert.equal(L.open[0].summary, "1 llamada · 1 WhatsApp"); assert.equal(L.open[0].stats.pending, 0);
});

test("Redis: terminar saca los colegios de sessrefs; las terminadas de hace más de 14 días se borran al listar", async () => {
  const V = "viejo@ordereat.com";
  const { session } = await ss.createFor(V, { origin: { kind: "list", key: "v" }, items: [{ ref: "a" }] }, T0);
  await ss.updateFor(V, session.id, { status: "done" }, T0);
  assert.equal(R.hash.get(`t:sessrefs:${V}`).has(session.id), false);
  assert.equal((await ss.listFor(V, T0 + 864e5)).done.length, 1);
  assert.equal((await ss.listFor(V, T0 + 15 * 864e5)).done.length, 0);
  assert.equal(R.hash.get(`t:sessidx:${V}`).size, 0);
  assert.equal(R.str.has(`t:sess:${V}:${session.id}`), false);
});

test("Redis: un contacto fuera de la sesión se anota en las abiertas que tienen ese colegio", async () => {
  const F = "fuera@ordereat.com";
  const a = (await ss.createFor(F, { name: "Puebla", origin: { kind: "zone", key: "zone:puebla" }, items: [{ ref: "col-1" }, { ref: "lead:77" }] }, T0)).session;
  const b = (await ss.createFor(F, { name: "Tu día", origin: { kind: "today", key: "today:2026-11-10" }, items: [{ ref: "col-1" }, { ref: "col-2" }] }, T0)).session;
  const step = ss.contactStep("", { channel: "call", outcome: "no_answer", by: F, byName: "Fer", schoolId: "col-1" });
  const out = await ss.recordOutside(F, "col-1", step, { now: T0 + 60e3 });
  assert.deepEqual(out.map(v => v.id).sort(), [a.id, b.id].sort());
  const va = await ss.getFor(F, a.id);
  assert.deepEqual(va.steps.map(s => [s.ref, s.kind, s.outside]), [["col-1", "contact", true]]);
  assert.equal(va.items[0].state, "worked"); assert.equal(va.resume, 1);
  // dentro de la sesión a: queda en a como de la sesión y en b como de afuera
  const w = await ss.recordOutside(F, "col-2", ss.contactStep("col-2", { channel: "mail", outcome: "info", schoolId: "col-2" }), { except: b.id, now: T0 + 70e3 });
  assert.deepEqual(w, []); // col-2 solo está en b
  // la ficha de un prospecto (pd-lead-77) es el lead:77 de la sesión
  const p = await ss.recordOutside(F, "pd-lead-77", ss.commentStep("", { schoolId: "pd-lead-77" }), { now: T0 + 80e3 });
  assert.deepEqual(p.map(v => v.id), [a.id]);
  const s2 = (await ss.getFor(F, a.id)).steps.at(-1);
  assert.deepEqual([s2.ref, s2.kind, s2.outside, s2.schoolId], ["lead:77", "comment", true, "pd-lead-77"]);
  // una terminada no se toca
  await ss.updateFor(F, b.id, { status: "done" }, T0 + 90e3);
  assert.deepEqual((await ss.recordOutside(F, "col-1", step, { now: T0 + 95e3 })).map(v => v.id), [a.id]);
  assert.deepEqual(await ss.recordOutside(F, "otro", step), []);
});
