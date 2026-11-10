// Sincronización con Redis (Upstash falso): lectura incremental de los cruces, no pisar lo que guardó otra instancia,
// trabajos trabados y quién está corriendo. «Otra instancia» = escribir directo en el Redis falso, como haría ella.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakeUpstash } from "./fake-upstash.mjs";
for (const k of ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "PIPEDRIVE_API_TOKEN"]) delete process.env[k];
const R = await fakeUpstash();
after(() => R.close());
process.env.KV_REST_API_URL = R.url; process.env.KV_REST_API_TOKEN = "x"; process.env.KV_PREFIX = "t:";
process.env.DEMO_MODE = "1";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ob-syncr-"));
const store = await import("../lib/store.js");
const sync = await import("../lib/sync.js");
const K = k => "t:demo:" + k;
const ids = store.schools.map(s => s.id);

test("setMatch: lo que escribe la app nunca queda como de la sincronización (via) y anota el id en match:at", async () => {
  store.setMatch(ids[0], { status: "open", orgId: 999, openDealId: 5, confirmed: true, via: "sync", candidates: [] });
  await store.flush();
  const rec = JSON.parse(R.run(["HGET", K("match"), ids[0]]));
  assert.equal(rec.via, undefined); assert.equal(rec.openDealId, 5);
  assert.ok(R.run(["ZRANGE", K("match:at"), "0", "-1"]).includes(ids[0]));
});

test("sync: la primera vez lee todo de a tandas; después solo los ids cambiados", async () => {
  // otra instancia guardó dos cruces
  for (const id of [ids[1], ids[2]]) { R.run(["HSET", K("match"), id, JSON.stringify({ status: "org", orgId: 1, v: 4, checkedAt: new Date().toISOString() })]); R.run(["ZADD", K("match:at"), String(Date.now()), id]); }
  R.log.length = 0;
  await store.sync({ force: true });
  assert.ok(R.log.some(c => c[0] === "HSCAN"), "primera lectura completa por HSCAN");
  assert.ok(!R.log.some(c => c[0] === "HGETALL" && c[1] === K("match")), "sin HGETALL de todos los cruces");
  assert.equal(store.getMatch(ids[1]).orgId, 1);
  // otra escritura de otra instancia: la siguiente lectura trae solo ese id
  R.run(["HSET", K("match"), ids[3], JSON.stringify({ status: "client", orgId: 2, v: 4, checkedAt: new Date(Date.now() + 1000).toISOString() })]); R.run(["ZADD", K("match:at"), String(Date.now()), ids[3]]);
  R.log.length = 0;
  await store.sync({ force: true });
  assert.ok(!R.log.some(c => c[0] === "HSCAN"), "la segunda no vuelve a leer todo");
  const hm = R.log.find(c => c[0] === "HMGET");
  assert.ok(hm && hm.includes(ids[3]) && hm.length < 10, `HMGET de los cambiados: ${hm?.length}`);
  assert.equal(store.getMatch(ids[3]).status, "client");
});

test("la masiva no pisa lo que otra instancia guardó mientras cruzaba (lo lee justo antes de escribir cada tanda)", async () => {
  const victim = [...store.schools].sort((a, b) => (a.id < b.id ? -1 : 1))[50].id;
  let done = false;
  // justo cuando la masiva relee la tanda, «otra instancia» elige a mano una organización para ese colegio
  R.hooks.push((c, { run }) => {
    if (done || c[0] !== "HMGET" || c[1] !== K("match") || !c.includes(victim)) return;
    done = true;
    run(["HSET", K("match"), victim, JSON.stringify({ status: "org", orgId: 424242, orgName: "Elegida a mano", confirmed: true, auto: false, v: 4, checkedAt: new Date().toISOString(), candidates: [] })]);
  });
  let r = await sync.step({ budgetMs: 60e3 });
  for (let i = 0; r.running && i < 50; i++) r = await sync.step({ budgetMs: 60e3 });
  assert.equal(r.error, null, r.error?.message); assert.equal(r.running, false);
  assert.ok(done, "la masiva releyó la tanda antes de escribir");
  const inRedis = JSON.parse(R.run(["HGET", K("match"), victim]));
  assert.equal(inRedis.orgId, 424242); assert.equal(inRedis.via, undefined);
  assert.equal(store.getMatch(victim).orgId, 424242);
  assert.ok(r.last.skip.recent >= 1);
  R.hooks.length = 0;
});

test("trabajo trabado: «Rehacer desde cero» lo descarta, y la foto vacía cierra el trabajo y obliga a una completa", async () => {
  // una completa a medias
  let r = await sync.step({ full: true, maxPages: 1, by: "Ana" });
  assert.equal(r.running, true); const gen = r.job.gen;
  await new Promise(res => setTimeout(res, 5)); // otro gen (va por milisegundo)
  r = await sync.step({ full: true, maxPages: 1, by: "Ana" });
  assert.equal(r.running, true); assert.notEqual(r.job.gen, gen, "empezó otra");
  assert.equal(R.run(["HGETALL", K(`sync:${gen}:o`)]).length, 0, "la foto de la descartada se borró");
  // se termina, y después una incremental con la foto perdida (Redis la borró)
  for (let i = 0; r.running && i < 50; i++) r = await sync.step({ budgetMs: 60e3 });
  assert.equal(r.running, false);
  const st = JSON.parse(R.run(["GET", K("sync:state")]));
  R.run(["DEL", K(`sync:${st.base}:o`)]);
  for (let i = 0; i < 5; i++) { r = await sync.step({ budgetMs: 60e3 }); if (r.error || !r.running) break; }
  assert.match(r.error.message, /0 organizaciones/); assert.equal(r.running, false, "el trabajo quedó cerrado");
  assert.equal(JSON.parse(R.run(["GET", K("sync:state")])).base, null);
  r = await sync.step({ maxPages: 1 });
  assert.equal(r.job.mode, "full", "la próxima es completa"); assert.equal(r.error, null);
  for (let i = 0; r.running && i < 50; i++) r = await sync.step({ budgetMs: 60e3 });
  assert.equal(r.running, false); assert.equal(r.error, null);
});

test("un error que se repite 3 pasos seguidos cierra el trabajo (no queda trabado para siempre)", async () => {
  let r = await sync.step({ maxPages: 1 }); assert.equal(r.running, true);
  // un cursor que Pipedrive ya no acepta (400): cada paso falla igual
  const st = JSON.parse(R.run(["GET", K("sync:state")]));
  st.job.cursor = "no-es-un-cursor"; R.run(["SET", K("sync:state"), JSON.stringify(st)]);
  for (let i = 1; i <= 3; i++) {
    r = await sync.step({ maxPages: 1 });
    assert.match(r.error?.message || "", /cursor/, `paso ${i} con error`);
    assert.equal(r.running, i < 3, `paso ${i}: ${r.running ? "sigue" : "cerrado"}`);
  }
  assert.match(r.error.message, /3 veces seguidas/);
  r = await sync.step({ maxPages: 1 }); assert.equal(r.error, null); assert.equal(r.running, true, "la próxima empieza de nuevo");
});

test("status: dice quién está corriendo (el candado), para que otra pestaña no ofrezca «Seguir»", async () => {
  R.run(["SET", K("sync:lock"), `tok|María|${Date.now()}`, "PX", "60000"]);
  const s = await sync.status();
  assert.equal(s.active.by, "María");
  const busy = await sync.step({ maxPages: 1 });
  assert.equal(busy.busy, true); assert.equal(busy.active.by, "María");
  R.run(["DEL", K("sync:lock")]);
  assert.equal((await sync.status("")).active, null); // el último paso lo hizo quien pregunta: no es «otro»
});
