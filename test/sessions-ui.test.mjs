// Detalle de una sesión (public/js/sessions.js): lo que viene de la sesión se muestra escapado (la ciudad puede venir de la
// dirección de la organización en Pipedrive) y en un colegio trabajado no aparecen los salteos.
import { test } from "node:test";
import assert from "node:assert/strict";
globalThis.document = { documentElement: { dataset: {} }, querySelectorAll: () => [], querySelector: () => null, addEventListener: () => {} };
globalThis.matchMedia = () => ({ matches: false });
globalThis.addEventListener = () => {};
const { S } = await import("../public/js/core.js");
const { itemRow } = await import("../public/js/sessions.js");
Object.assign(S, { types: { call: "Llamada", task: "Mail" }, outcomes: [{ id: "no_answer", label: "No atendió" }], me: { pdUserId: 1 } });
const v = { status: "open", resume: 0 };

test("detalle: la ciudad y el nombre de un colegio pendiente van escapados", () => {
  const it = { ref: "a", state: "pending", type: "call", name: "Colegio <b>", city: `<img src=x onerror="window.__xss=1">` };
  const html = itemRow(v, it, 0, []);
  assert.ok(!html.includes("<img"), html);
  assert.ok(html.includes("Llamada pendiente · &lt;img src=x onerror=&quot;window.__xss=1&quot;&gt;"), html);
  assert.ok(html.includes("Colegio &lt;b&gt;"));
  assert.ok(itemRow(v, { ref: "b", state: "pending", city: "Puebla & Cholula" }, 1, []).includes("Puebla &amp; Cholula"));
});

test("detalle: un colegio trabajado no muestra el salteo de antes; lo de fuera de la sesión se marca", () => {
  const at = new Date().toISOString();
  const steps = [{ ref: "a", kind: "skip", reason: "owner", why: "es de demo", at }, { ref: "a", kind: "contact", channel: "call", outcome: "no_answer", at, outside: true }];
  const html = itemRow(v, { ref: "a", state: "worked", name: "Christian Life" }, 0, steps);
  assert.ok(!html.includes("Salteado"), html);
  assert.match(html, /Llamada · No atendió · hoy \d\d:\d\d \(fuera de la sesión\)/);
  // uno salteado sí muestra el motivo
  assert.match(itemRow(v, { ref: "c", state: "skipped", name: "C" }, 2, [steps[0]]), /Salteado: es de demo/);
});
