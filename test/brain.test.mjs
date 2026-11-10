// Token de World Dominion (lib/brain.js): vencimiento del JWT, limpieza de lo que se pega, cuál se usa
// y la carga desde Equipo contra un OrderBrain falso (se prueba antes de guardar; nunca se devuelve).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const GOOD = "eyJhbGciOiJIUzI1NiJ9." + Buffer.from(JSON.stringify({ sub: "x", exp: Math.floor(Date.now() / 1000) + 30 * 86400 })).toString("base64url") + ".firma";
const SITES = [
  { id: "s1", name: "Colegio Falso Uno", clientId: "c1", status: "Active", country: "Mexico", city: "Puebla", latitude: 19.04, longitude: -98.2 },
  { id: "s2", name: "Colegio Falso Dos", clientId: "c1", status: "ChurnOnActive", country: "Peru", city: "Lima", latitude: -12.1, longitude: -77.03 },
];
// OrderBrain falso: solo acepta GOOD; con «vacio» responde una lista vacía y con «html» una página
const srv = http.createServer((req, res) => {
  const tok = String(req.headers.authorization || "").replace(/^Bearer /, "");
  if (tok === "html") { res.writeHead(200, { "content-type": "text/html" }); return res.end("<html>login</html>"); }
  if (tok === "vacio") { res.writeHead(200, { "content-type": "application/json" }); return res.end("[]"); }
  if (tok !== GOOD) { res.writeHead(401); return res.end(); }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(req.url === "/api/sites" ? SITES : req.url === "/api/clients" ? [{ id: "c1", name: "Grupo Falso" }] : []));
});
await new Promise(r => srv.listen(0, "127.0.0.1", r));
after(() => srv.close());

for (const k of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "PIPEDRIVE_API_TOKEN", "BRAIN_TOKEN"]) delete process.env[k];
process.env.DEMO_MODE = "1";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ob-brain-"));
process.env.BRAIN_URL = `http://127.0.0.1:${srv.address().port}`;
const brain = await import("../lib/brain.js");
const store = await import("../lib/store.js");
const { tokenExp, expiryState, cleanToken, pickToken, SOON_MS } = brain;

const jwt = payload => "eyJhbGciOiJIUzI1NiJ9." + Buffer.from(JSON.stringify(payload)).toString("base64url") + ".sig";

test("tokenExp: lee el exp del JWT sin verificar la firma", () => assert.equal(tokenExp(jwt({ exp: 1800000000 })), 1800000000e3));
test("tokenExp: JWT sin exp, otro formato o basura → sin fecha", () => {
  assert.equal(tokenExp(jwt({ sub: "a" })), null);
  assert.equal(tokenExp("abc123"), null);
  assert.equal(tokenExp("a.%%%.c"), null);
  assert.equal(tokenExp(""), null);
  assert.equal(tokenExp(jwt({ exp: "mañana" })), null);
});
test("expiryState: vencido, vence en menos de 3 días, bien o sin fecha", () => {
  const now = 1_000_000_000_000;
  assert.equal(expiryState(null, now), "none");
  assert.equal(expiryState(now - 1, now), "expired");
  assert.equal(expiryState(now, now), "expired");
  assert.equal(expiryState(now + SOON_MS - 1, now), "soon");
  assert.equal(expiryState(now + SOON_MS + 1, now), "ok");
});
test("cleanToken: saca «Bearer», comillas y espacios alrededor", () => {
  assert.equal(cleanToken("  Bearer abc.def.ghi \n"), "abc.def.ghi");
  assert.equal(cleanToken('"abc.def"'), "abc.def");
  assert.equal(cleanToken("'bearer xyz'"), "xyz");
});
test("cleanToken: vacío, con espacios adentro o enorme → error 400 sin repetir el token", () => {
  for (const bad of ["", "   ", "Bearer ", "abc def", "abc\ndef", "x".repeat(9000), "ñandú"]) {
    assert.throws(() => cleanToken(bad), e => e.status === 400 && (bad.trim().length < 3 || !e.message.includes(bad.trim())));
  }
});
test("pickToken: el cargado desde la app manda sobre el del entorno", () => {
  const ok = jwt({ exp: Math.floor(Date.now() / 1000) + 86400 * 10 }), dead = jwt({ exp: Math.floor(Date.now() / 1000) - 60 });
  assert.deepEqual(pickToken(ok, "env1"), { token: ok, source: "app" });
  assert.deepEqual(pickToken("sinfecha", "env1"), { token: "sinfecha", source: "app" });
  assert.deepEqual(pickToken(null, "env1"), { token: "env1", source: "env" });
  assert.equal(pickToken(null, ""), null);
  // el de la app venció y el del entorno no: se usa el del entorno
  assert.deepEqual(pickToken(dead, ok), { token: ok, source: "env" });
  assert.deepEqual(pickToken(dead, "env-sin-fecha"), { token: "env-sin-fecha", source: "env" });
  // vencieron los dos: sigue el de la app
  assert.deepEqual(pickToken(dead, dead + "x"), { token: dead, source: "app" });
});

test("demo sin token: sitios de prueba y sin token cargado", async () => {
  await brain.ensureBrain();
  const st = await brain.brainAdmin();
  assert.equal(st.demo, true); assert.equal(st.source, null); assert.equal(st.loaded, null); assert.equal(st.lastRead, null);
  assert.equal(brain.brainState().demo, true);
});
test("token rechazado por OrderBrain: no se guarda y dice por qué", async () => {
  await assert.rejects(brain.saveBrainToken("tokenviejo123", "Ana Líder"), e => e.status === 400 && /rechazó el token/.test(e.message) && !e.message.includes("tokenviejo123"));
  await assert.rejects(brain.saveBrainToken("html", "Ana Líder"), e => e.status === 400 && /No lo guardé/.test(e.message));
  await assert.rejects(brain.saveBrainToken("vacio", "Ana Líder"), e => e.status === 400 && /sin sitios/.test(e.message));
  assert.equal(await store.getBrainToken(), null);
  assert.equal((await brain.brainAdmin()).demo, true);
});
test("token que anda: se guarda, se usan los sitios al instante y nunca vuelve en el estado", async () => {
  const st = await brain.saveBrainToken("Bearer " + GOOD, "Ana Líder");
  assert.equal(st.source, "app"); assert.equal(st.demo, false); assert.equal(st.sites, 2);
  assert.equal(st.loaded.by, "Ana Líder"); assert.equal(st.expiry, "ok"); assert.ok(st.exp);
  assert.equal(st.lastRead.ok, true); assert.equal(st.lastRead.n, 2);
  assert.ok(!JSON.stringify(st).includes(GOOD.split(".")[1]), "el estado no lleva el token");
  assert.equal((await store.getBrainToken()).token, GOOD);
  const map = brain.brainState();
  assert.equal(map.demo, false);
  assert.deepEqual(map.sites.map(s => [s.name, s.client, s.label]), [["Colegio Falso Uno", "Grupo Falso", "Activo"], ["Colegio Falso Dos", "Grupo Falso", "Churn"]]);
  // otra lectura del estado (relee el token guardado) sigue igual
  const again = await brain.brainAdmin();
  assert.equal(again.source, "app"); assert.equal(again.sites, 2);
});
