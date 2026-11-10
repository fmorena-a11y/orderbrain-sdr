// Fechas de lib/time.js: días hábiles, UTC ↔ local y el día para confirmar una demo («Demo blindada»).
import { test } from "node:test";
import assert from "node:assert/strict";
import { addBusinessDays, confirmDay, toUtc, fromUtc } from "../lib/time.js";

// 2026-11-09 es lunes
test("addBusinessDays: hacia atrás salta el finde", () => { assert.equal(addBusinessDays("2026-11-09", -1), "2026-11-06"); assert.equal(addBusinessDays("2026-11-11", -2), "2026-11-09"); });
test("addBusinessDays: hacia adelante sigue igual", () => assert.equal(addBusinessDays("2026-11-06", 1), "2026-11-09"));
test("confirmDay: el día hábil anterior a la demo", () => assert.equal(confirmDay("2026-11-12", "2026-11-09"), "2026-11-11"));
test("confirmDay: demo el lunes, se confirma el viernes", () => assert.equal(confirmDay("2026-11-16", "2026-11-10"), "2026-11-13"));
test("confirmDay: demo mañana → hoy", () => assert.equal(confirmDay("2026-11-11", "2026-11-10"), "2026-11-10"));
test("confirmDay: demo hoy → hoy", () => assert.equal(confirmDay("2026-11-10", "2026-11-10"), "2026-11-10"));
test("confirmDay: agendada el sábado para el lunes → hoy (el viernes ya pasó)", () => assert.equal(confirmDay("2026-11-16", "2026-11-14"), "2026-11-14"));
test("confirmDay: agendada el domingo para el martes → el lunes", () => assert.equal(confirmDay("2026-11-17", "2026-11-15"), "2026-11-16"));
test("confirmDay: demo pasada no lleva recordatorio", () => assert.equal(confirmDay("2026-11-09", "2026-11-10"), null));
test("fromUtc: deshace toUtc", () => {
  for (const tz of ["America/Mexico_City", "America/Montevideo", "Europe/Madrid"]) { const u = toUtc("2026-11-12", "21:30", tz); assert.deepEqual(fromUtc(u.date, u.time, tz), { date: "2026-11-12", time: "21:30" }); }
  assert.deepEqual(fromUtc("2026-11-13", "03:30", "America/Mexico_City"), { date: "2026-11-12", time: "21:30" });
  assert.deepEqual(fromUtc("2026-11-13", "", "America/Mexico_City"), { date: "2026-11-13", time: "" });
});
