// «Registrar en 10 segundos»: duración de la llamada → preselección de «No atendió» (public/js/core.js).
import { test } from "node:test";
import assert from "node:assert/strict";
globalThis.document = { documentElement: { dataset: {} }, querySelectorAll: () => [] };
globalThis.matchMedia = () => ({ matches: false });
const { callGuess, SHORT_CALL_S } = await import("../public/js/core.js");
const { OUTCOMES } = await import("../lib/playbook.js");

test("callGuess: menos de 25 s preselecciona No atendió por llamada, con aviso", () => {
  assert.equal(SHORT_CALL_S, 25);
  const g = callGuess(12_400);
  assert.deepEqual(g, { outcome: "no_answer", channel: "call", note: "La llamada duró 12 s: marqué No atendió. Cambialo si no fue así." });
  assert.ok(OUTCOMES.some(o => o.id === g.outcome && o.label === "No atendió"));
  assert.equal(callGuess(0).outcome, "no_answer");
  assert.equal(callGuess(24_400).outcome, "no_answer");
});

test("callGuess: 25 s o más no preselecciona, solo dice cuánto duró", () => {
  assert.deepEqual(callGuess(25_000), { note: "Duró 25 s" });
  assert.deepEqual(callGuess(150_000), { note: "Duró 3 min" });
  assert.deepEqual(callGuess(3600_000), { note: "Duró 60 min" });
});

test("callGuess: sin dato o más de una hora fuera de la app, nada", () => {
  assert.equal(callGuess(NaN), null);
  assert.equal(callGuess(-5000), null);
  assert.equal(callGuess(3601_000), null);
});
