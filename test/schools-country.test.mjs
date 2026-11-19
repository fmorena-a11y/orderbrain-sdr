// La base por país (decisión del líder: «por país»): /api/schools?cc= (con partes), el resumen por país y ciudad, la búsqueda en
// los países no cargados, los colegios sueltos, los países donde trabajás y lo puro del navegador (public/js/schoolsum.js).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
for (const k of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "PIPEDRIVE_API_TOKEN", "ANTHROPIC_API_KEY", "READ_ONLY", "BRAIN_TOKEN", "SCHOOLS_FILE"]) delete process.env[k];
Object.assign(process.env, { DEMO_MODE: "1", SESSION_SECRET: "clave-de-prueba", VERCEL: "1", DEV_LOGIN_EMAIL: "demo@ordereat.com", DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "ob-cc-")) });
const { schools, setMatch, addTouch } = await import("../lib/store.js");
const sales = await import("../lib/sales.js");
const SUM = await import("../public/js/schoolsum.js");
const parse = L => JSON.parse(L.json.toString("utf8"));

test("schoolList por país: solo ese país, la misma lista que toda la base filtrada, con su propio ETag y su copia", () => {
  const all = parse(sales.schoolList()), mx = sales.schoolList(Date.now(), { country: "México" }), list = parse(mx);
  assert.ok(list.length > 100);
  assert.ok(list.every(s => s.country === "México"));
  assert.deepEqual(list, all.filter(s => s.country === "México"));
  assert.equal(mx.count, list.length);
  assert.notEqual(mx.etag, sales.schoolList(Date.now(), { country: "Argentina" }).etag);
  assert.equal(sales.schoolList(Date.now(), { country: "México" }), mx, "sin cambios, la misma copia");
});
test("en partes: cada colegio en una sola parte (hash del id), la unión es el país entero, igual en cualquier instancia", () => {
  const whole = parse(sales.schoolList(Date.now(), { country: "México" })).map(s => s.id).sort();
  const parts = [0, 1, 2].map(part => parse(sales.schoolList(Date.now(), { country: "México", part, parts: 3 })).map(s => s.id));
  assert.deepEqual(parts.flat().sort(), whole);
  assert.equal(new Set(parts.flat()).size, whole.length, "ninguno repetido");
  assert.ok(parts.every(p => p.length > whole.length / 6), "partes parejas");
  assert.equal(sales.partOf("abc", 3), sales.partOf("abc", 3));
  assert.equal(sales.partsFor(7999), 1); assert.equal(sales.partsFor(8001), 2); assert.equal(sales.partsFor(30000), 4);
});
test("countryParam: el nombre como está en la base o el código, sin acentos ni mayúsculas; otro, null", () => {
  assert.equal(sales.countryParam("México"), "México"); assert.equal(sales.countryParam("mexico"), "México"); assert.equal(sales.countryParam("MX"), "México");
  assert.equal(sales.countryParam("pe"), "Perú"); assert.equal(sales.countryParam("Narnia"), null); assert.equal(sales.countryParam(""), null);
});
test("resumen: por país (total y partes) y por ciudad, con los mismos números que la lista; «para llamar» según quién mira", () => {
  const [a, b] = schools.filter(s => s.country === "Argentina" && s.city === "Rosario");
  setMatch(a.id, { status: "new", detail: "Nunca contactado", orgId: null });
  setMatch(b.id, { status: "org", detail: "En Pipe", orgId: 77, ownerId: 555, ownerName: "Otra" });
  const sum = parse(sales.schoolsSummary()), items = parse(sales.schoolList());
  assert.equal(sum.total, schools.length);
  assert.equal(sum.countries.reduce((n, c) => n + c.n, 0), schools.length);
  assert.deepEqual(sum.countries.map(c => c.country), [...new Set(schools.map(s => s.country))].sort((x, y) => x.localeCompare(y)));
  const ar = sum.countries.find(c => c.country === "Argentina"); assert.equal(ar.parts, sales.partsFor(ar.n));
  // las ciudades del resumen = las de la lista (mismas marcas, «sin revisar» y «para llamar»)
  const fromList = SUM.aggCities(items.filter(s => s.country === "Argentina"), 1), fromSum = SUM.summaryCities(sum, { me: 1, only: new Set(["Argentina"]) });
  const strip = l => SUM.sortCities(l.map(({ items: _i, ...c }) => c)).map(c => ({ ...c, lat: Math.round(c.lat * 1e3), lng: Math.round(c.lng * 1e3) }));
  assert.deepEqual(strip(fromSum), strip(fromList));
  const ros = fromSum.find(c => c.city === "Rosario");
  // b es de otra persona (555): no se llama; si el que mira es 555, sí
  const ros555 = SUM.summaryCities(sum, { me: 555, only: new Set(["Argentina"]) }).find(c => c.city === "Rosario");
  assert.equal(ros555.pros, ros.pros + 1); assert.equal(ros555.prosMap, ros.prosMap + 1);
  assert.equal(ros.k.new >= 1 && ros.k.org >= 1, true);
});
test("searchSchools: por nombre o teléfono, solo en los países pedidos (only) o sin los que ya están (not), hasta el tope", () => {
  const s = schools.find(x => x.country === "Chile" && x.phone && x.name.length > 12);
  const r = sales.searchSchools(s.name, { only: ["Chile"] });
  assert.ok(r.items.some(x => x.id === s.id)); assert.ok(r.items.every(x => x.country === "Chile"));
  assert.equal(sales.searchSchools(s.name, { not: ["Chile"] }).items.some(x => x.id === s.id), false);
  const d = s.phone.replace(/\D/g, "");
  assert.ok(sales.searchSchools(d.slice(-8), { only: ["Chile"] }).items.some(x => x.id === s.id), "por los últimos dígitos");
  const many = sales.searchSchools("colegio", { limit: 5 });
  assert.equal(many.items.length, 5); assert.ok(many.total > 5);
  assert.deepEqual(sales.searchSchools("a"), { total: 0, items: [] });
  // el nombre que empieza con lo escrito va primero
  const first = sales.searchSchools("colegio", { only: ["Chile"], limit: 3 }).items;
  assert.ok(first.every(x => x.name.toLowerCase().startsWith("colegio")));
});
test("schoolItems: los pedidos que están en la base (como en la lista); lo que no, no viene", () => {
  const s = schools.find(x => x.country === "Perú");
  const r = sales.schoolItems([s.id, "no-existe", "pd-lead-123"]);
  assert.deepEqual(Object.keys(r), [s.id]); assert.deepEqual(r[s.id], sales.schoolListItem(s));
});
test("workCountries: los países de tus contactos de 90 días y tus organizaciones (≥ 10 %, hasta 3); un líder sin nada, el equipo", () => {
  const pe = schools.filter(s => s.country === "Perú").slice(0, 5), co = schools.find(s => s.country === "Colombia"), uy = schools.find(s => s.country === "Uruguay");
  for (const s of pe) addTouch({ schoolId: s.id, by: "ana@ordereat.com", byName: "Ana", outcome: "no_answer", channel: "call" });
  addTouch({ schoolId: co.id, by: "ana@ordereat.com", byName: "Ana", outcome: "no_answer", channel: "call" });
  assert.deepEqual(sales.workCountries({ email: "ana@ordereat.com" }), ["Perú", "Colombia"]);
  setMatch(uy.id, { status: "org", detail: "", orgId: 5, ownerId: 4242, ownerName: "Beto" });
  assert.deepEqual(sales.workCountries({ email: "beto@ordereat.com", pdUserId: 4242 }), ["Uruguay"]);
  assert.deepEqual(sales.workCountries({ email: "nadie@ordereat.com" }), []);
  assert.ok(sales.workCountries({ email: "lider@ordereat.com", leader: true }).includes("Perú"));
});

test("pickCountries: territorio elegido, «Todos», donde trabajaste o, sin nada, todos", () => {
  const countries = ["Argentina", "Chile", "México", "Perú"];
  assert.deepEqual(SUM.pickCountries({ territory: ["México", "Narnia"], chosen: true, countries }), { list: ["México"], why: "territory" });
  assert.deepEqual(SUM.pickCountries({ territory: [], chosen: true, work: ["Perú"], countries }), { list: countries, why: "all" });
  assert.deepEqual(SUM.pickCountries({ chosen: false, work: ["Perú", "Chile"], countries }), { list: ["Perú", "Chile"], why: "work" });
  assert.deepEqual(SUM.pickCountries({ chosen: false, work: [], countries }), { list: countries, why: "all" });
  assert.deepEqual(SUM.missing(["México", "México", null, "Perú"], new Set(["Perú"])), ["México"]);
  assert.equal(SUM.prosOf(3, { 7: 2, 9: 4 }, 7), 5); assert.equal(SUM.prosOf(3, { 7: 2, 9: 4 }, null), 9);
  assert.equal(SUM.markKey({ status: "client", phase: "activo" }), "ph-activo"); assert.equal(SUM.markKey({ status: "raro" }), "unk");
});

// ---------- las rutas
const { default: app } = await import("../server.js");
const web = http.createServer(app);
await new Promise(r => web.listen(0, "127.0.0.1", r));
const APP = `http://127.0.0.1:${web.address().port}`;
after(async () => { web.closeAllConnections?.(); await new Promise(r => web.close(r)); });
const r0 = await fetch(APP + "/auth/dev", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
const cookie = r0.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
// (con If-None-Match, fetch de Node agrega «Cache-Control: no-cache», que pide no usar la copia: el navegador no lo hace al
// revalidar la suya; max-age=0 es lo que manda el navegador)
const get = (p, h = {}) => fetch(APP + p, { headers: { cookie, ...(h["if-none-match"] ? { "cache-control": "max-age=0" } : {}), ...h } });

test("GET /api/schools?cc=: solo ese país, ETag y 304; partes; país o parte inválidos, 400; sin cc, toda la base como siempre", async () => {
  const r = await get("/api/schools?cc=MX"), list = await r.json();
  assert.equal(r.status, 200); assert.ok(list.length && list.every(s => s.country === "México"));
  const etag = r.headers.get("etag"); assert.match(etag, /^W\//); assert.equal(r.headers.get("cache-control"), "private, no-cache");
  assert.equal((await get("/api/schools?cc=M%C3%A9xico", { "if-none-match": etag })).status, 304, "por nombre es la misma copia");
  const p1 = await (await get("/api/schools?cc=MX&part=1&parts=2")).json(), p0 = await (await get("/api/schools?cc=MX&part=0&parts=2")).json();
  assert.equal(p0.length + p1.length, list.length);
  for (const q of ["cc=Narnia", "cc=MX&part=2&parts=2", "cc=MX&parts=0", "cc=MX&parts=99", "cc=MX&part=x"]) assert.equal((await get(`/api/schools?${q}`)).status, 400, q);
  assert.equal((await (await get("/api/schools")).json()).length, schools.length);
  assert.equal((await fetch(APP + "/api/schools?cc=MX")).status, 401, "sin sesión, nada");
});
test("GET /api/schools/summary, /search e /items; /api/me trae workCountries", async () => {
  const r = await get("/api/schools/summary"), sum = await r.json();
  assert.equal(r.status, 200); assert.equal(sum.total, schools.length); assert.ok(r.headers.get("etag"));
  assert.equal((await get("/api/schools/summary", { "if-none-match": r.headers.get("etag") })).status, 304);
  const s = await (await get("/api/schools/search?q=colegio&only=Chile,AR&limit=7")).json();
  assert.equal(s.items.length, 7); assert.ok(s.items.every(x => ["Chile", "Argentina"].includes(x.country)));
  const n = await (await get("/api/schools/search?q=colegio&not=Chile")).json();
  assert.ok(n.items.length <= 50 && n.items.every(x => x.country !== "Chile"));
  const id = schools.find(x => x.country === "Bolivia").id, it = await (await get(`/api/schools/items?ids=${id},nada`)).json();
  assert.deepEqual(Object.keys(it), [id]); assert.equal(it[id].country, "Bolivia");
  const me = await (await get("/api/me")).json();
  assert.ok(Array.isArray(me.workCountries));
});
