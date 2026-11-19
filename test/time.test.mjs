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
// los formateadores se guardan por zona (lib/time.js): tienen que dar lo mismo que uno nuevo, también en los cambios de hora,
// con zonas mezcladas y con una zona inválida (cae en la de por defecto)
test("zonas: formateadores guardados = uno nuevo cada vez (cambios de hora, medias horas, zona inválida)", async () => {
  const { todayIn, safeTz } = await import("../lib/time.js");
  const ref = (d, tz) => { const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(d).map(x => [x.type, x.value])); return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` }; };
  const tzs = ["America/Mexico_City", "America/Santiago", "Europe/Madrid", "America/New_York", "Asia/Kolkata", "Australia/Lord_Howe", "America/Montevideo", "UTC"];
  for (let pass = 0; pass < 2; pass++) for (const tz of tzs) for (let d = Date.UTC(2026, 0, 1, 0, 30); d < Date.UTC(2027, 0, 1); d += 37 * 3600e3) {
    const iso = new Date(d).toISOString();
    assert.deepEqual(fromUtc(iso.slice(0, 10), iso.slice(11, 16), tz), ref(new Date(d), tz), `${tz} ${iso}`);
    assert.equal(todayIn(tz, d), ref(new Date(d), tz).date);
  }
  // Santiago adelanta la hora el 6/9/2026 a las 24:00 (pasa a UTC-3) y Madrid la atrasa el 25/10/2026 (pasa a UTC+1)
  assert.deepEqual(fromUtc("2026-09-06", "03:30", "America/Santiago"), { date: "2026-09-05", time: "23:30" });
  assert.deepEqual(fromUtc("2026-09-06", "04:30", "America/Santiago"), { date: "2026-09-06", time: "01:30" });
  assert.deepEqual(toUtc("2026-10-24", "10:00", "Europe/Madrid"), { date: "2026-10-24", time: "08:00" });
  assert.deepEqual(toUtc("2026-10-26", "10:00", "Europe/Madrid"), { date: "2026-10-26", time: "09:00" });
  const dflt = process.env.DEFAULT_TZ || "America/Montevideo";
  for (const bad of ["No/Existe", "", null, undefined, "x".repeat(300)]) { assert.equal(safeTz(bad), dflt); assert.equal(todayIn(bad, Date.UTC(2026, 10, 19, 2)), "2026-11-18"); }
  assert.equal(safeTz("America/Lima"), "America/Lima");
  for (let i = 0; i < 1200; i++) safeTz(`Inventada/Zona${i}`); // muchas zonas distintas (el header x-tz lo manda el navegador): no crece sin fin ni rompe
  assert.equal(safeTz("America/Lima"), "America/Lima"); assert.equal(todayIn("Asia/Kolkata", Date.UTC(2026, 10, 19, 20)), "2026-11-20");
});
