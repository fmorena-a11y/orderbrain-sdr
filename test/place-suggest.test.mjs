// Sugerencias de lugares mientras se escribe en Prospectar (lib/scan.js placeSuggestions): solo países del equipo,
// sin repetidos, primero el país elegido o escrito, con su id de OpenStreetMap.
import { test } from "node:test";
import assert from "node:assert/strict";
import { placeSuggestions } from "../lib/scan.js";

const F = (name, type, cc, extra = {}) => ({ properties: { name, type, countrycode: cc, country: { AR: "Argentina", UY: "Uruguay", US: "Estados Unidos", MX: "México" }[cc], osm_type: "R", osm_id: Math.floor(Math.random() * 1e6), ...extra } });

test("Mar del Plata: Argentina primero, Uruguay de alternativa, nada de fuera del equipo", () => {
  const feats = [F("Mar del Plata", "city", "UY", { state: "Rocha" }), F("Mar del Plata", "city", "AR", { state: "Buenos Aires", county: "Partido de General Pueyrredón" }), F("Mar del Plata", "city", "US", { state: "Florida" }), F("Mar del Plata", "city", "AR", { state: "Buenos Aires" })];
  const r = placeSuggestions(feats, { codes: ["AR", "UY", "MX"], prefer: "AR" });
  assert.equal(r.length, 2);
  assert.equal(r[0].cc, "AR"); assert.equal(r[0].label, "Mar del Plata, Buenos Aires, Argentina");
  assert.match(r[0].sub, /Partido de General Pueyrredón, Buenos Aires, Argentina/);
  assert.equal(r[1].cc, "UY"); assert.match(r[0].osm, /^R\d+$/);
});
test("sin id de OpenStreetMap no se sugiere", () => {
  assert.equal(placeSuggestions([{ properties: { name: "X", type: "city", countrycode: "MX" } }], { codes: ["MX"] }).length, 0);
});
