// Helpers de la agenda y del alta de prospectos en lib/sales.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// sin Redis ni Pipedrive: el store lee y escribe en una carpeta temporal
for (const k of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "PIPEDRIVE_API_TOKEN", "DEMO_MODE"]) delete process.env[k];
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ob-test-"));
const { eventOf, withoutEvent, splitPhones, splitMails, phoneCountry, personLabel } = await import("../lib/sales.js");

test("eventOf: el evento va entre paréntesis al final con año", () => assert.equal(eventOf("Colegio Magna – MZA (EduExperience Mendoza 2026)"), "EduExperience Mendoza 2026"));
test("eventOf: o después de un guion largo con año", () => assert.equal(eventOf("Bethel Chaco – EduExperience 2026"), "EduExperience 2026"));
test("eventOf: paréntesis sin año no es evento (es parte del nombre)", () => assert.equal(eventOf("Colegio Londres de Pachuca (Escoses)"), ""));
test("eventOf: guion sin año no es evento («– MZA»)", () => assert.equal(eventOf("Colegio Magna – MZA"), ""));
test("eventOf: vacío o nulo no rompe", () => { assert.equal(eventOf(""), ""); assert.equal(eventOf(null), ""); });

test("withoutEvent: saca el evento del título para nombrar la organización", () => {
  assert.equal(withoutEvent("Colegio Magna – MZA (EduExperience Mendoza 2026)"), "Colegio Magna – MZA");
  assert.equal(withoutEvent("Bethel Chaco – EduExperience 2026"), "Bethel Chaco");
});
test("withoutEvent: sin evento deja el nombre igual", () => assert.equal(withoutEvent("Colegio Londres de Pachuca (Escoses)"), "Colegio Londres de Pachuca (Escoses)"));
test("withoutEvent: solo saca el paréntesis del evento, no otro", () => assert.equal(withoutEvent("Colegio X (Puebla) (Expo 2026)"), "Colegio X (Puebla)"));

test("splitPhones: separa por /, y, o, coma y guion con espacios; descarta números cortos", () => {
  assert.deepEqual(splitPhones("442 123 4567 / 442 765 4321 y 55 1234 5678 - 123"), ["442 123 4567", "442 765 4321", "55 1234 5678"]);
  assert.deepEqual(splitPhones("+52 (55) 1234-5678, 55 8765 4321; 1234"), ["+52 (55) 1234-5678", "55 8765 4321"]);
  assert.deepEqual(splitPhones(""), []);
  assert.deepEqual(splitPhones(null), []);
});
test("splitMails: separa, pasa a minúsculas y descarta lo que no es mail", () => {
  assert.deepEqual(splitMails("Info@Colegio.EDU.mx; admin@colegio.mx, sin-mail / x@y"), ["info@colegio.edu.mx", "admin@colegio.mx"]);
  assert.deepEqual(splitMails(undefined), []);
});

test("phoneCountry: país por prefijo internacional (+ o 00)", () => {
  assert.equal(phoneCountry("+52 55 1234 5678"), "México");
  assert.equal(phoneCountry("0054 11 4444 5555"), "Argentina");
  assert.equal(phoneCountry("+598 99 123 456"), "Uruguay");
  assert.equal(phoneCountry("+51 1 234 5678"), "Perú");
});
test("phoneCountry: prefijo compartido (+1) no se adivina", () => assert.equal(phoneCountry("+1 787 555 1234"), ""));
test("phoneCountry: sin prefijo internacional no se adivina", () => assert.equal(phoneCountry("55 1234 5678"), ""));
test("phoneCountry: prueba los teléfonos en orden hasta encontrar uno", () => assert.equal(phoneCountry("", "442 123", "+56 9 1234 5678"), "Chile"));

test("personLabel: nombre y cargo entre paréntesis, sin espacios de más", () => {
  assert.equal(personLabel("Ana Pérez", "Directora"), "Ana Pérez (Directora)");
  assert.equal(personLabel(" Ana ", " "), "Ana");
  assert.equal(personLabel("", "Rector"), "(Rector)");
  assert.equal(personLabel(), "");
});
