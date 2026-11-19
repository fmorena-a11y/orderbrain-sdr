// La base por país en el navegador (core.js): sumar un país, colegios sueltos de otros países, sacar países y patchSchool.
import { test } from "node:test";
import assert from "node:assert/strict";
globalThis.document = { documentElement: { dataset: {} }, querySelectorAll: () => [], querySelector: () => null, addEventListener: () => {} };
globalThis.matchMedia = () => ({ matches: false });
const fired = [];
globalThis.addEventListener = () => {};
globalThis.dispatchEvent = e => fired.push(e.type);
globalThis.CustomEvent ??= class extends Event { constructor(t, o) { super(t); this.detail = o?.detail; } };
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
const { S, addCountrySchools, dropCountrySchools, rememberLoose, patchSchool, setTerritory } = await import("../public/js/core.js");
const sch = (id, country, extra = {}) => ({ id, name: `Colegio ${id}`, city: "Ciudad", country, lat: 1, lng: 2, status: "unk", ...extra });

test("un país cargado entra en S.schools; uno suelto queda solo en S.byId (ni listas ni conteos) y al cargar su país se suma ese mismo objeto", () => {
  Object.assign(S, { countries: ["Argentina", "México"], schools: [], byId: new Map(), loaded: new Set() });
  addCountrySchools("Argentina", [sch("a1", "Argentina"), sch("a2", "Argentina")]);
  assert.deepEqual(S.schools.map(s => s.id), ["a1", "a2"]); assert.ok(S.loaded.has("Argentina"));
  // de la cola de Hoy, con su puntaje: suelto y sin score ni reasons
  rememberLoose([{ ...sch("m1", "México"), score: 80, reasons: ["x"] }]);
  const loose = S.byId.get("m1");
  assert.ok(loose && !S.schools.includes(loose)); assert.equal(loose.score, undefined); assert.equal(loose._in, false);
  // patchSchool de uno suelto (revisado en Pipedrive) no lo mete en las listas
  patchSchool({ id: "m1", status: "new" }); assert.equal(S.schools.length, 2); assert.equal(loose.status, "new");
  // llega su país: el mismo objeto (la ficha abierta lo sigue viendo), con lo nuevo, una sola vez
  addCountrySchools("México", [sch("m1", "México", { status: "org" }), sch("m2", "México")]);
  assert.equal(S.byId.get("m1"), loose); assert.equal(loose.status, "org"); assert.equal(loose._in, true);
  assert.deepEqual(S.schools.map(s => s.id), ["a1", "a2", "m1", "m2"]);
  addCountrySchools("México", [sch("m1", "México")]); // otra vez (recargar): no se repite
  assert.equal(S.schools.length, 4);
  // un colegio nuevo de un país cargado va a las listas; de uno no cargado, suelto; de un país que la base no tenía (lo sumó el buscador de zonas), a las listas
  patchSchool(sch("a3", "Argentina")); patchSchool(sch("c1", "Chile")); assert.deepEqual(S.schools.map(s => s.id), ["a1", "a2", "m1", "m2", "a3", "c1"]);
  S.countries.push("Perú"); patchSchool(sch("p1", "Perú")); assert.equal(S.schools.length, 6); assert.ok(S.byId.has("p1"));
  // las fichas de Pipedrive nunca van a las listas
  patchSchool({ id: "pd-lead-9", name: "X", country: "Argentina" }); assert.equal(S.schools.length, 6);
});
test("sacar un país (cambió el territorio): sale de las listas pero sigue en S.byId; setTerritory avisa", () => {
  const rev = S.rev;
  dropCountrySchools(["México"]);
  assert.deepEqual(S.schools.map(s => s.id), ["a1", "a2", "a3", "c1"]); assert.ok(!S.loaded.has("México")); assert.ok(S.byId.has("m2")); assert.ok(S.rev > rev);
  assert.equal(S.byId.get("m2")._in, false);
  fired.length = 0; setTerritory(["Argentina", "Narnia"]);
  assert.deepEqual(S.territory, ["Argentina"]); assert.deepEqual(fired, ["ob:territory"]);
});
