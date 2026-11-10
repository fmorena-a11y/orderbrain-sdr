// Estados y fase comercial de un colegio a partir de sus tratos de Pipedrive (classify y phaseOf).
// Etapas y embudos con los ids y nombres reales de la cuenta.
import { test } from "node:test";
import assert from "node:assert/strict";
for (const k of ["PIPEDRIVE_API_TOKEN", "CLIENT_PIPELINE_IDS", "DEAD_STAGE_IDS", "ONBOARDING_PIPELINE_ID"]) delete process.env[k];
const { classify, phaseOf } = await import("../lib/pipedrive.js");

const m = {
  pipes: { 1: "ARG - SALES", 9: "MX - SALES", 12: "LatAm - SALES", 15: "OrderEAT - Clientes UY", 16: "ONBOARDING", 22: "MX - Clientes", 27: "PERFORMANCE", 29: "PE - SALES" },
  stages: {
    111: "PROPOSAL SENT", 112: "SELLING", 201: "CLOSING", 235: "HOT DEALS", // ARG
    124: "CLOSING", 159: "PROPOSAL SENT", 160: "SELLING", 233: "HOT DEALS", // MX
    115: "A contactar", 118: "NEGOTIATING", 197: "CLOSING", 198: "SELLING", // LatAm
    147: "Propuesta enviada", 148: "Negociación comenzada", 145: "Contacto establecido", // UY clientes (viejo)
    156: "PENDING TO KICK OFF", 158: "LAUNCHED [+50]", 161: "PENDING TO ONBOARD", 164: "READY FOR LAUNCH [active]", 167: "ONBOARDING IN PROGRESS", 208: "DROPPED", // ONBOARDING
    209: "Primer mes BIEN", 213: "VERDE", // MX - Clientes
    246: "Underperforming", 249: "Churn", 251: "PLUS+ Upsell", // PERFORMANCE
  },
};
const deal = (pipeline_id, stage_id, status = "open", extra = {}) => ({ id: Math.random(), pipeline_id, stage_id, status, update_time: "2026-01-10 10:00:00", ...extra });

// ---------- classify
test("classify: sin tratos es «org» (está en Pipe sin trato)", () => assert.equal(classify([], m), "org"));
test("classify: un trato ganado en cualquier embudo es cliente", () => assert.equal(classify([deal(9, 124, "won")], m), "client"));
test("classify: trato abierto en embudos de clientes 16/22/27 es cliente", () => {
  assert.equal(classify([deal(16, 161)], m), "client");
  assert.equal(classify([deal(22, 213)], m), "client");
  assert.equal(classify([deal(27, 246)], m), "client");
});
test("classify: abierto en etapa muerta (208 DROPPED, 249 Churn) no es cliente ni «en proceso»", () => {
  for (const d of [deal(16, 208), deal(27, 249)]) { const s = classify([d], m); assert.notEqual(s, "client"); assert.notEqual(s, "open"); }
});
test("classify: trato abierto en un embudo de ventas es «open»", () => assert.equal(classify([deal(9, 160)], m), "open"));
test("classify: cliente manda sobre un trato de ventas abierto", () => assert.equal(classify([deal(9, 160), deal(22, 209)], m), "client"));
test("classify: «open» manda sobre perdidos", () => assert.equal(classify([deal(1, 111, "lost"), deal(1, 112)], m), "open"));
test("classify: perdido en PROPOSAL SENT, CLOSING, HOT DEALS o negociación es «lost»", () => {
  for (const [p, s] of [[9, 159], [1, 111], [1, 201], [9, 124], [1, 235], [9, 233], [12, 118], [12, 197], [15, 147], [15, 148]])
    assert.equal(classify([deal(p, s, "lost")], m), "lost", `etapa ${m.stages[s]}`);
});
test("classify: perdido antes de la propuesta (SELLING, A contactar) es «stalled»", () => {
  for (const [p, s] of [[9, 160], [1, 112], [12, 115], [12, 198], [15, 145]]) assert.equal(classify([deal(p, s, "lost")], m), "stalled", `etapa ${m.stages[s]}`);
});
test("classify: con un perdido con propuesta y otro sin, es «lost»", () => assert.equal(classify([deal(9, 160, "lost"), deal(9, 159, "lost")], m), "lost"));
test("classify: sin nombres de etapas no se inventa «lost» (queda «stalled»)", () => {
  assert.equal(classify([deal(9, 159, "lost")], {}), "stalled");
  assert.equal(classify([deal(9, 159, "lost")]), "stalled");
});

// ---------- phaseOf
test("phaseOf: en ONBOARDING sin lanzar es «onboarding»", () => {
  for (const s of [156, 161, 167]) assert.equal(phaseOf([deal(16, s)], m), "onboarding", m.stages[s]);
});
test("phaseOf: READY FOR LAUNCH [active], LAUNCHED o ganado en ONBOARDING es «activo»", () => {
  assert.equal(phaseOf([deal(16, 164)], m), "activo");
  assert.equal(phaseOf([deal(16, 158)], m), "activo");
  assert.equal(phaseOf([deal(16, 161, "won")], m), "activo");
});
test("phaseOf: vivo en MX - Clientes o PERFORMANCE es «activo», aunque tenga otro en onboarding", () => {
  assert.equal(phaseOf([deal(22, 213)], m), "activo");
  assert.equal(phaseOf([deal(27, 251)], m), "activo");
  assert.equal(phaseOf([deal(16, 161), deal(22, 209)], m), "activo");
});
test("phaseOf: en embudos de clientes solo con etapas muertas o perdidos es «churn»", () => {
  assert.equal(phaseOf([deal(16, 208)], m), "churn");
  assert.equal(phaseOf([deal(27, 249)], m), "churn");
  assert.equal(phaseOf([deal(22, 213, "lost")], m), "churn");
});
test("phaseOf: ganado en ventas sin embudo de clientes es «cerrado» (firmó y no arrancó)", () => assert.equal(phaseOf([deal(9, 124, "won")], m), "cerrado"));
test("phaseOf: abierto en PROPOSAL SENT, HOT DEALS o negociación es «propuesta»", () => {
  for (const [p, s] of [[9, 159], [1, 235], [12, 118]]) assert.equal(phaseOf([deal(p, s)], m), "propuesta", m.stages[s]);
});
test("phaseOf: abierto en SELLING o sin tratos no tiene fase", () => {
  assert.equal(phaseOf([deal(9, 160)], m), null);
  assert.equal(phaseOf([], m), null);
  assert.equal(phaseOf([deal(9, 159, "lost")], m), null);
});
