// Búsqueda en Pipedrive en la pantalla (public/js/pdsearch.js): qué hace Enter en Prospectar (pdNamed), los dos renglones
// de cada resultado (el dueño no se corta), «o más» cuando Pipedrive tiene más y todo lo de Pipedrive escapado.
import { test } from "node:test";
import assert from "node:assert/strict";
globalThis.document = { documentElement: { dataset: {} }, querySelectorAll: () => [], querySelector: () => null, addEventListener: () => {} };
globalThis.matchMedia = () => ({ matches: false });
globalThis.addEventListener = () => {};
const { S } = await import("../public/js/core.js");
const { pdNamed, pdNameHit, mineBest, pdLines, pdSectionHtml, pdCount } = await import("../public/js/pdsearch.js");
S.byId = new Map();

const data = items => ({ groups: [{ type: "x", label: "X", items }], total: items.length });
const org = (name, extra = {}) => ({ type: "organization", id: 1, name, owner: "Juan", to: { kind: "record", ref: "org:1" }, ...extra });
test("pdNamed: Enter se queda en la lista si en Pipedrive algo se llama así (empieza con lo escrito, o una persona)", () => {
  assert.ok(pdNamed(data([{ type: "person", id: 1, name: "Eduardo Miranda" }]), "Miranda"), "apellido de una persona");
  assert.ok(pdNamed(data([{ type: "person", id: 1, name: "Eduardo Miranda" }]), "eduardo mir"));
  assert.ok(pdNamed(data([{ type: "deal", id: 1, title: "Main Catering - Comedor Tec Puebla" }]), "Main Catering"));
  assert.ok(pdNamed(data([org("Colegio José Vasconcelos")]), "colegio jose"), "sin acentos ni mayúsculas");
});
test("pdNamed: un pueblo que solo aparece al final del nombre (o en la dirección o las notas) se ubica en el mapa", () => {
  assert.ok(!pdNamed(data([org("Nook Junior School Metepec")]), "Metepec"));
  assert.ok(!pdNamed(data([org("Prepa UPAEP Atlixco")]), "Atlixco"));
  assert.ok(!pdNamed(data([{ type: "lead", id: "a", title: "Comedor Tec de Monterrey Puebla" }]), "Monterrey Puebla"));
  assert.ok(!pdNamed(data([org("Colegio X", { hint: "Av. Satélite 12" })]), "Satélite"));
  assert.ok(!pdNamed(null, "algo")); assert.ok(!pdNamed(data([]), "algo"));
  assert.ok(pdNameHit({ type: "person", name: "Laura Gómez" }, "laura") && !pdNameHit(org("Escuela Particular Laura Vicuña"), "laura"), "la búsqueda rápida sube lo que se llama así");
});
test("pdLines: contacto en un renglón y dueño y organización en otro (el dueño no se pierde)", () => {
  const p = { type: "person", id: 2, name: "Laura Gómez", phones: ["+52 (55) 1234-5678", "55 8765 4321"], emails: ["laura.gomez@colegio-ejemplo.mx"], org: { id: 9, name: "Colegio Americano" }, owner: "Demo" };
  assert.deepEqual(pdLines(p), ["+52 (55) 1234-5678, 55 8765 4321 · laura.gomez@colegio-ejemplo.mx", "Dueño: Demo · Colegio Americano"], "el dueño primero: si no entra, se corta la organización");
  assert.deepEqual(pdLines({ type: "person", id: 3, name: "X", phones: [], emails: [], org: null, owner: "" }), ["Sin teléfono ni email", "Sin dueño · Sin organización"]);
  assert.deepEqual(pdLines(org("Colegio Americano", { addr: "", place: "Tlaxcala, México" })), ["Tlaxcala, México", "Dueño: Juan"]);
  assert.deepEqual(pdLines(org("C", { addr: "Av. Juárez 120, Tlaxcala", place: "Tlaxcala, México" })), ["Av. Juárez 120, Tlaxcala", "Dueño: Juan"], "la ciudad ya está en la dirección");
});
test("pdSectionHtml: «o más» si Pipedrive tiene más, «Ver más» por grupo y todo escapado", () => {
  const bad = `<img src=x onerror="window.__x=1">`;
  const items = Array.from({ length: 12 }, (_, i) => org(i ? `Org ${i}` : bad, { id: i + 1, owner: bad }));
  const html = pdSectionHtml({ q: bad, state: "ok", data: { groups: [{ type: "organization", label: "Organizaciones", items, more: true, next: "abc" }], total: 12, more: true } });
  assert.ok(!html.includes("<img"), "escapado");
  assert.match(html, /En Pipedrive · 12 o más resultados/);
  assert.match(html, /Organizaciones <b>12\+<\/b>/);
  assert.match(html, /Ver 2 más/, "primero los que ya llegaron");
  assert.equal((html.match(/data-pdi=/g) || []).length, 10);
  const all = pdSectionHtml({ q: "x", state: "ok", data: { groups: [{ type: "organization", label: "Organizaciones", items: items.slice(0, 3), shown: 10, more: true, next: "abc" }], total: 3, more: true } });
  assert.match(all, /Ver más organizaciones de Pipedrive/, "después, la página siguiente de Pipedrive");
  assert.equal(pdCount(50, true), "50 o más"); assert.equal(pdCount(4, false), "4"); assert.equal(pdCount(1200, true, true), "1.200+");
  assert.match(pdSectionHtml({ q: bad, state: "ok", data: { groups: [], total: 0 } }), /Tampoco hay .* con «&lt;img/);
  assert.match(pdSectionHtml({ q: "x", state: "err", err: bad }), /No pude buscar en Pipedrive \(&lt;img/);
});

// un link de Pipedrive pegado en un buscador: se abre su ficha, nunca se busca como texto ni dirección
test("pdLinkOf: prospecto, trato, organización y persona", async () => {
  const { pdLinkOf, isPdLink } = await import("../public/js/pdsearch.js");
  assert.deepEqual(pdLinkOf("https://ordereat.pipedrive.com/leads/inbox/00fdb3a0-1b2c-11f0-9a6b-2f6e3c1d4e5f"), { kind: "lead", id: "00fdb3a0-1b2c-11f0-9a6b-2f6e3c1d4e5f", label: "prospecto" });
  assert.equal(pdLinkOf("  ordereat.pipedrive.com/leads/archived/00FDB3A0-1B2C-11F0-9A6B-2F6E3C1D4E5F?x=1 ").id, "00fdb3a0-1b2c-11f0-9a6b-2f6e3c1d4e5f");
  assert.deepEqual(pdLinkOf("https://ordereat.pipedrive.com/deal/6091"), { kind: "deal", id: "6091", label: "trato" });
  assert.equal(pdLinkOf("https://ordereat.pipedrive.com/organization/45#notes").kind, "organization");
  assert.equal(pdLinkOf("https://ordereat.pipedrive.com/person/67").id, "67");
  assert.equal(pdLinkOf("https://ordereat.pipedrive.com/pipeline/3").kind, "other");
  assert.equal(isPdLink("mar del plata"), false);
  assert.equal(isPdLink("Calle 100 # 15-20, Bogotá"), false);
  assert.equal(isPdLink("https://www.colegio.edu.ar/deal/3"), false);
});

test("mineBest: Enter va a lo tuyo de Pipedrive (el prospecto primero; nada si hay muchos tuyos o es de otro)", () => {
  const mine = id => id === 1;
  const items = [
    { type: "organization", id: 10, name: "Colegio Los Ceibos", ownerId: 1 },
    { type: "lead", id: "a", title: "Colegio Ceibos de Prueba (SDR Meta Ads Revival)", ownerId: 1 },
    { type: "deal", id: 20, title: "Colegio Los Ceibos - Trato", ownerId: 1 },
    { type: "person", id: 30, name: "Patricia Ejemplo", ownerId: 1 },
    { type: "lead", id: "b", title: "Ceibos del Norte", ownerId: 2 },
  ];
  assert.equal(mineBest(data(items), "Ceibos", mine)?.id, "a", "el prospecto tuyo");
  assert.equal(mineBest(data(items.filter(x => x.type !== "lead")), "ceibos", mine)?.id, 10, "sin prospecto, la organización");
  assert.equal(mineBest(data(items), "Norte", mine), null, "lo de otra persona no");
  assert.equal(mineBest(data(items), "eibos", mine), null, "una palabra a medias no");
  const many = Array.from({ length: 5 }, (_, i) => ({ type: "lead", id: `m${i}`, title: `Colegio ${i}`, ownerId: 1 }));
  assert.equal(mineBest(data(many), "colegio", mine), null, "con muchos tuyos («colegio») Enter sigue como siempre");
  assert.equal(mineBest(data(items), "Patricia", mine)?.id, 30, "una persona tuya por su nombre");
});
