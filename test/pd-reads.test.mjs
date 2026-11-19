// Lecturas de Pipedrive (lib/pipedrive.js) con un `fetch` falso (nada sale a la red): personsByIds/orgsByIds leen de a 100
// hasta completar, y dos GET idénticos a la vez comparten UN pedido (solo GET, solo mientras está en curso, nunca una
// lectura que salió antes de una escritura).
import { test } from "node:test";
import assert from "node:assert/strict";
for (const k of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "DEMO_MODE"]) delete process.env[k];
process.env.PIPEDRIVE_API_TOKEN = "token-de-prueba"; process.env.PIPEDRIVE_DOMAIN = "prueba-local";
const calls = [], gates = [];
let latency = 15, fail = null;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(String(url)), method = opts.method || "GET";
  assert.equal(u.hostname, "prueba-local.pipedrive.com", "ningún pedido sale de la cuenta de prueba");
  calls.push({ method, path: u.pathname, q: Object.fromEntries(u.searchParams), at: Date.now() });
  if (gates.length) await new Promise(r => gates.push(r)); else await new Promise(r => setTimeout(r, latency));
  if (fail) return new Response(JSON.stringify({ success: false, error: fail.msg }), { status: fail.status });
  const ids = (u.searchParams.get("ids") || "").split(",").filter(Boolean).map(Number);
  let data = [];
  if (u.pathname.endsWith("/v2/persons")) data = ids.map(id => ({ id, name: `Persona ${id}`, org_id: id + 1e6 }));
  else if (u.pathname.endsWith("/v2/organizations")) data = ids.map(id => ({ id, name: `Org ${id}`, owner_id: 7, address: { locality: "Puebla" }, is_deleted: id === 13 }));
  else if (u.pathname.endsWith("/v2/deals")) data = [{ id: 1, title: "Trato", org_id: Number(u.searchParams.get("org_id")), status: "open" }];
  else if (method === "POST") data = { id: 99 };
  return new Response(JSON.stringify({ success: true, data }), { status: 200 });
};
test.after(() => { globalThis.fetch = realFetch; });
const pd = await import("../lib/pipedrive.js");
const reset = () => { calls.length = 0; pd._reads.shared = 0; fail = null; };

test("no es el demo: las lecturas pasan por call()", () => assert.equal(pd.DEMO, false));
test("personsByIds: 250 ids = 3 pedidos de hasta 100 y vuelven las 250 (antes se cortaba en 100)", async () => {
  reset();
  const ids = Array.from({ length: 250 }, (_, i) => i + 1), out = await pd.personsByIds(ids);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map(c => c.q.ids.split(",").length), [100, 100, 50]);
  assert.deepEqual(out.map(p => p.id), ids, "todas y en el orden pedido");
  assert.deepEqual(out[249], { id: 250, name: "Persona 250", orgId: 1000250 });
  reset(); assert.equal((await pd.personsByIds(ids.slice(0, 100))).length, 100); assert.equal(calls.length, 1, "hasta 100, un solo pedido como antes");
  reset(); assert.deepEqual(await pd.personsByIds([]), []); assert.equal(calls.length, 0);
});
test("orgsByIds y orgsByIdsAll: de a 100 hasta completar, sin las borradas", async () => {
  reset();
  const ids = Array.from({ length: 230 }, (_, i) => i + 1), out = await pd.orgsByIds(ids);
  assert.equal(calls.length, 3); assert.ok(calls.every(c => c.q.ids.split(",").length <= 100 && c.q.limit === "100"));
  assert.equal(out.length, 229); assert.ok(!out.some(o => o.id === 13));
  assert.deepEqual(out[0], { id: 1, name: "Org 1", ownerId: 7, labelIds: [], country: "", city: "Puebla", region: "", addr: "" });
  reset();
  const all = await pd.orgsByIdsAll([5, 5, "6", 0, null, ...ids]);
  assert.equal(calls.length, 3, "sin repetidos ni vacíos"); assert.equal(all.length, 229);
});
test("dos GET idénticos a la vez: un solo pedido a Pipedrive y cada uno recibe su propio objeto", async () => {
  reset();
  const [a, b, c] = await Promise.all([pd.dealsForOrg(50), pd.dealsForOrg(50), pd.dealsForOrg(51)]);
  assert.equal(calls.length, 2, "50 una vez, 51 aparte"); assert.equal(pd._reads.shared, 1);
  assert.deepEqual(a, b); assert.notEqual(a, b); assert.notEqual(a[0], b[0]);
  a[0].title = "cambiado"; assert.equal(b[0].title, "Trato", "lo que uno toca no le llega al otro");
  assert.equal(c[0].org_id, 51);
});
test("no es una copia: cuando terminó, el siguiente GET va de nuevo a Pipedrive", async () => {
  reset();
  await pd.dealsForOrg(60); await pd.dealsForOrg(60);
  assert.equal(calls.length, 2); assert.equal(pd._reads.shared, 0);
});
test("una lectura que salió antes de una escritura no se comparte con quien lee después de escribir", async () => {
  reset(); gates.push(() => {}); // desde acá cada pedido espera a que lo suelten
  const next = () => new Promise(r => { const t = setInterval(() => { if (gates.length > 1) { clearInterval(t); r(gates.splice(1, 1)[0]); } }, 1); });
  const before = pd.dealsForOrg(70), freeRead = await next();
  const write = pd.addNote({ content: "nota", orgId: 70 }), freeWrite = await next();
  freeWrite(); await write; // la escritura terminó; la primera lectura sigue en curso
  const after = pd.dealsForOrg(70), freeAfter = await next();
  assert.equal(calls.filter(c => c.method === "GET").length, 2, "la de después hizo su propio pedido");
  assert.equal(pd._reads.shared, 0);
  const third = pd.dealsForOrg(70); // sin escrituras en el medio: esta sí se cuelga de la última
  await new Promise(r => setTimeout(r, 5));
  freeRead(); freeAfter(); gates.length = 0;
  await Promise.all([before, after, third]);
  assert.equal(calls.filter(c => c.method === "GET").length, 2); assert.equal(pd._reads.shared, 1);
});
test("mientras una escritura está en curso tampoco se comparte la lectura que salió antes", async () => {
  reset(); gates.push(() => {});
  const next = () => new Promise(r => { const t = setInterval(() => { if (gates.length > 1) { clearInterval(t); r(gates.splice(1, 1)[0]); } }, 1); });
  const r1 = pd.dealsForOrg(80), f1 = await next();
  const w = pd.addNote({ content: "nota", orgId: 80 }), fw = await next();
  const r2 = pd.dealsForOrg(80), f2 = await next();
  assert.equal(calls.filter(c => c.method === "GET").length, 2);
  f1(); fw(); f2(); gates.length = 0; await Promise.all([r1, w, r2]);
  assert.equal(pd._reads.shared, 0);
});
test("las escrituras nunca se comparten", async () => {
  reset();
  await Promise.all([pd.addNote({ content: "igual", orgId: 1 }), pd.addNote({ content: "igual", orgId: 1 })]);
  assert.equal(calls.filter(c => c.method === "POST").length, 2);
});
test("un error le llega a todos los que compartían la lectura, y el siguiente pedido vuelve a probar", async () => {
  reset(); fail = { status: 500, msg: "se cayó" };
  const r = await Promise.allSettled([pd.dealsForOrg(90), pd.dealsForOrg(90)]);
  assert.equal(calls.length, 1);
  for (const x of r) { assert.equal(x.status, "rejected"); assert.ok(x.reason instanceof pd.PipedriveError); assert.equal(x.reason.status, 500); assert.equal(x.reason.message, "se cayó"); }
  fail = null;
  assert.equal((await pd.dealsForOrg(90)).length, 1); assert.equal(calls.length, 2);
});
