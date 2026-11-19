// La lista de /api/schools (sales.schoolList): se guarda armada mientras nada cambió y se rearma con CUALQUIER cambio de lo
// que muestra (cruce, contacto, archivado, colegio sumado, dirección a mano). El ETag es del contenido.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
for (const k of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "PIPEDRIVE_API_TOKEN"]) delete process.env[k];
process.env.DEMO_MODE = "1";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ob-test-"));
const { schools, setMatch, setMatches, addTouch, setArchived, addSchools, storeRev, getMatch, STALE_MS } = await import("../lib/store.js");
const sales = await import("../lib/sales.js");
const parse = L => JSON.parse(L.json.toString("utf8"));
const item = (L, id) => parse(L).find(x => x.id === id);

test("es la misma lista de siempre, sin `found` ni `src` (el navegador no los lee)", () => {
  const L = sales.schoolList(), list = parse(L);
  assert.equal(list.length, schools.length); assert.equal(L.count, schools.length);
  assert.deepEqual(list, JSON.parse(JSON.stringify(schools.map(sales.schoolListItem))));
  assert.ok(schools.some(s => s.found) && schools.some(s => s.src), "la base sí los tiene");
  assert.ok(!list.some(x => "found" in x || "src" in x));
  const keys = new Set(list.flatMap(Object.keys));
  for (const k of ["id", "name", "city", "country", "lat", "lng", "status"]) assert.ok(keys.has(k), k);
  assert.match(L.etag, /^W\/"[0-9a-f]+-.{27}"$/);
});
test("sin cambios no se rearma (mismo objeto, mismo ETag); cada cambio la rearma y el estado nuevo está", async () => {
  const a = sales.schoolList();
  assert.equal(sales.schoolList(), a, "la segunda vez es la copia");
  const [s1, s2, s3] = schools.filter(s => !getMatch(s.id));
  // un cruce
  let r = storeRev(); setMatch(s1.id, { status: "open", detail: "Trato abierto", orgId: 91, ownerId: 1, ownerName: "Demo" }); assert.ok(storeRev() > r);
  const b = sales.schoolList(); assert.notEqual(b, a); assert.notEqual(b.etag, a.etag);
  assert.equal(item(b, s1.id).status, "open"); assert.equal(item(a, s1.id).status, "unk");
  // un contacto registrado
  r = storeRev(); addTouch({ schoolId: s1.id, by: "demo@ordereat.com", byName: "Demo", outcome: "no_answer", channel: "call", connected: false }); assert.ok(storeRev() > r);
  const c = sales.schoolList(); assert.notEqual(c, b); assert.equal(item(c, s1.id).attempts, 1); assert.equal(item(c, s1.id).lastTouch.outcome, "No atendió");
  // archivar y desarchivar
  await setArchived(s2.id, { by: "demo@ordereat.com", byName: "Demo", at: new Date().toISOString(), reason: "Cerró", text: "", leadIds: [] });
  const d = sales.schoolList(); assert.notEqual(d, c); assert.equal(item(d, s2.id).status, "archived");
  await setArchived(s2.id, null);
  const e = sales.schoolList(); assert.notEqual(e, d); assert.equal(item(e, s2.id).status, "unk");
  assert.equal(e.etag, c.etag, "volvió a quedar igual: el mismo ETag (es del contenido)");
  // la dirección a mano va en el cruce
  setMatch(s3.id, { status: "new", detail: "Nunca contactado", orgId: null, addrManual: "Calle Falsa 123" });
  const f = sales.schoolList(); assert.equal(item(f, s3.id).addr, "Calle Falsa 123");
  // la masiva
  await setMatches([[s2.id, { status: "client", detail: "Cliente", orgId: 92 }]]);
  const g = sales.schoolList(); assert.notEqual(g, f); assert.equal(item(g, s2.id).status, "client");
  // un colegio sumado desde el buscador
  const added = addSchools([{ id: "prueba-lista-1", name: "Colegio Prueba Lista", city: "Puebla", country: "México", lat: 19, lng: -98, private: "si" }]);
  assert.equal(added.length, 1);
  const h = sales.schoolList(); assert.notEqual(h, g); assert.equal(h.count, g.count + 1); assert.ok(item(h, "prueba-lista-1"));
  assert.equal(sales.schoolList(), h);
});
test("la copia vence sola: cuando al primer cruce le toca dejar de estar al día, y nunca dura más de un minuto", () => {
  const L = sales.schoolList(), now = Date.now();
  assert.ok(L.until <= now + 60e3 + 50 && L.until > now);
  assert.equal(sales.schoolList(L.until - 1), L);
  const again = sales.schoolList(L.until + 1);
  assert.notEqual(again, L); assert.equal(again.etag, L.etag, "sin cambios, el contenido (y el ETag) es el mismo: el navegador recibe 304");
  // un cruce al que le faltan 5 s para vencer (7 días): la copia dura como mucho hasta ahí
  const s = schools.find(x => !getMatch(x.id));
  setMatch(s.id, { status: "new", detail: "Nunca contactado", orgId: null });
  getMatch(s.id).checkedAt = new Date(Date.now() - STALE_MS + 5000).toISOString();
  const M = sales.schoolList(Date.now() + 61e3); // otra vez (la de recién venció)
  assert.ok(M.until <= Date.now() + 5000 + 50, "vence cuando ese cruce pasa a «Sin revisar»");
});
