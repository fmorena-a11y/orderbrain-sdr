// Selector de período compartido (public/js/period.js): qué valor usa cada vista y qué se manda al servidor.
import test from "node:test";
import assert from "node:assert/strict";
import { normPeriod, pickPeriod, metricsAccepts, demosAccepts, demosParam, periodHtml, curQuarter } from "../public/js/period.js";

const today = "2026-11-19";
const choices = { months: [{ key: "2026-11", label: "noviembre 2026", year: 2026 }, { key: "2026-10", label: "octubre 2026", year: 2026 }, { key: "2025-12", label: "diciembre 2025", year: 2025 }],
  quarters: [{ key: "2025-Q4", label: "Q4 2025 (octubre a diciembre)" }, { key: "2026-Q3", label: "Q3 2026 (julio a septiembre)" }, { key: "2026-Q4", label: "Q4 2026 (octubre a diciembre)" }] };

test("normPeriod: días como número, mes o trimestre en curso como «mes»/«trim», lo demás tal cual o null", () => {
  assert.equal(normPeriod("30", today), 30);
  assert.equal(normPeriod("2026-11", today), "mes");
  assert.equal(normPeriod("2026-Q4", today), "trim");
  assert.equal(normPeriod("2026-10", today), "2026-10");
  assert.equal(normPeriod("2026-Q3", today), "2026-Q3");
  assert.equal(normPeriod("cualquiera", today), null);
  assert.equal(normPeriod("", today), null);
  assert.equal(curQuarter("2026-01-05"), "2026-Q1");
});

test("Métricas usa lo compartido si lo entiende; si no, lo último suyo", () => {
  const m = shared => pickPeriod({ shared, own: 30, accepts: metricsAccepts, fallback: 7, today });
  assert.equal(m("trim"), "trim");      // elegido en Equipo › Demos: también vale acá
  assert.equal(m("2026-11"), "mes");     // el mes en curso escrito como clave
  assert.equal(m("2026-10"), 30);        // un mes pasado no se entiende acá: lo último de Métricas
  assert.equal(m(90), 90);
  assert.equal(pickPeriod({ shared: null, own: "x", accepts: metricsAccepts, fallback: 7, today }), 7);
});

test("Equipo › Demos: días no; mes o trimestre en curso y los que se pueden elegir sí", () => {
  const d = (shared, c = choices) => pickPeriod({ shared, own: "mes", accepts: demosAccepts(c), fallback: "mes", today });
  assert.equal(d(30), "mes");
  assert.equal(d("trim"), "trim");
  assert.equal(d("2026-10"), "2026-10");
  assert.equal(d("2024-03"), "mes");     // fuera de lo que se puede elegir
  assert.equal(d("2024-03", null), "2024-03"); // sin choices todavía: se pide y el servidor decide
});

test("al servidor: «mes» = vacío (mes en curso en la zona de quien mira), «trim» = el trimestre en curso", () => {
  assert.equal(demosParam("mes", today), "");
  assert.equal(demosParam("trim", today), "2026-Q4");
  assert.equal(demosParam("2026-10", today), "2026-10");
});

test("la pieza: mismas opciones con el mismo aspecto; «Otro mes o trimestre» sin repetir los en curso", () => {
  const mx = periodHtml({ id: "mxPer", value: 30, today });
  assert.match(mx, /data-per="7"/); assert.match(mx, /data-per="30" aria-pressed="true"/); assert.match(mx, /data-per="trim"/);
  assert.doesNotMatch(mx, /per-other/);
  const dm = periodHtml({ id: "dmPer", value: "2026-10", rel: ["mes", "trim"], other: choices, today });
  assert.doesNotMatch(dm, /data-per="7"/);
  assert.match(dm, /class="inp per-other on"/);
  assert.match(dm, /<option value="2026-10" selected>/);
  assert.doesNotMatch(dm, /value="2026-11"/);   // el mes en curso es el chip «Este mes»
  assert.doesNotMatch(dm, /value="2026-Q4"/);   // el trimestre en curso es «Este trimestre»
  assert.match(dm, /Trimestres 2025/);
});
