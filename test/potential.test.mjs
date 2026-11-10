import { test } from "node:test";
import assert from "node:assert/strict";
import { potentialOf, POTENTIAL_MIN } from "../lib/potential.js";

const priv = "Privado confirmado en el mapa", bil = "Bilingüe o internacional", red = "Confesional (puede ser parte de una red)";
test("alto potencial: privado + bilingüe + de preescolar a prepa", () => {
  const r = potentialOf({ opp: [priv, bil], private: "seguro", levels: ["Preescolar", "Primaria", "Secundaria", "Prepa"] });
  assert.equal(r.high, true);
  assert.deepEqual(r.why, ["Privado confirmado", "Bilingüe o internacional", "Preescolar a prepa"]);
});
test("un colegio sin datos no es alto potencial (no se inventa)", () => assert.equal(potentialOf({ name: "Colegio X" }).high, false));
test("solo privado no alcanza", () => assert.equal(potentialOf({ private: "seguro", opp: [priv] }).high, false));
test("clientes cerca suman y se dice cuántos", () => {
  const r = potentialOf({ private: "seguro", opp: [priv, red], levels: ["Primaria", "Secundaria"] }, { nearClients: 2 });
  assert.equal(r.points >= POTENTIAL_MIN, true);
  assert.ok(r.why.includes("2 clientes de OrderEAT a menos de 3 km"));
});
test("el estudio con encaje bajo baja el potencial", () => {
  const base = { private: "seguro", opp: [priv, bil], levels: ["Preescolar", "Primaria", "Secundaria"] };
  assert.equal(potentialOf(base).high, true);
  assert.equal(potentialOf(base, { fit: "bajo" }).high, false);
});
test("la universidad no cuenta como nivel escolar", () => assert.equal(potentialOf({ levels: ["Universidad"] }).points, 0));
