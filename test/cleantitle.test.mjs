// Títulos de Pipedrive sin etiquetas internas en Hoy, Agenda y la Bandeja caliente (cleanTitle y subjectSansName de
// public/js/core.js): las mismas reglas que msgSchoolName de lib/playbook.js, pero lo que sale del título queda como chip.
import { test } from "node:test";
import assert from "node:assert/strict";
globalThis.document = { documentElement: { dataset: {} }, querySelectorAll: () => [] };
globalThis.matchMedia = () => ({ matches: false });
const { cleanTitle, subjectSansName, titleTag, callQueue, callWindow, S } = await import("../public/js/core.js");
const { msgSchoolName } = await import("../lib/playbook.js");

test("cleanTitle: saca la etiqueta interna del final y la deja como chip corto", () => {
  assert.deepEqual(cleanTitle("Colegio Olivos de Prueba (SDR Meta Ads Revival)"), { name: "Colegio Olivos de Prueba", tag: "SDR revival", tags: ["SDR revival"] });
  assert.deepEqual(cleanTitle("Escuela Nueva Era (Inbound Google Ads)"), { name: "Escuela Nueva Era", tag: "Inbound Google", tags: ["Inbound Google"] });
  assert.equal(cleanTitle("Colegio Sin Fuente (Inbound)").tag, "Inbound");
  assert.equal(cleanTitle("Colegio Sin Fuente (Inbound)").name, "Colegio Sin Fuente");
  assert.equal(cleanTitle("Colegio del Sol (Inbound orgánico)").tag, "Inbound orgánico");
  assert.equal(cleanTitle("Colegio del Sol (Referido de padre)").tag, "Referido de padre");
  assert.deepEqual(cleanTitle("Colegio Andino del Sur (EduExperience Mendoza 2026)"), { name: "Colegio Andino del Sur", tag: "EduExperience Mendoza 2026", tags: ["EduExperience Mendoza 2026"] });
  assert.deepEqual(cleanTitle("Colegio Andino del Sur – EduExperience 2026"), { name: "Colegio Andino del Sur", tag: "EduExperience 2026", tags: ["EduExperience 2026"] });
  assert.deepEqual(cleanTitle("Instituto Patria · OE-MX-1042"), { name: "Instituto Patria", tag: "OE-MX-1042", tags: ["OE-MX-1042"] });
  assert.deepEqual(cleanTitle("Colegio Patria – Inbound Meta Ads"), { name: "Colegio Patria", tag: "Inbound Meta", tags: ["Inbound Meta"] });
  assert.deepEqual(cleanTitle("Colegio Patria [Inbound]"), { name: "Colegio Patria", tag: "Inbound", tags: ["Inbound"] });
});
test("cleanTitle: varias etiquetas, en el orden del título; sin etiqueta queda igual", () => {
  assert.deepEqual(cleanTitle("Colegio Patria (EduExperience Puebla 2026) · OE-MX-7"), { name: "Colegio Patria", tag: "EduExperience Puebla 2026 · OE-MX-7", tags: ["EduExperience Puebla 2026", "OE-MX-7"] });
  assert.deepEqual(cleanTitle("Colegio San Ignacio de Loyola"), { name: "Colegio San Ignacio de Loyola", tag: "", tags: [] });
  assert.deepEqual(cleanTitle("  Colegio   San   José  "), { name: "Colegio San José", tag: "", tags: [] });
  // un guion que es parte del nombre no se toca
  assert.equal(cleanTitle("Colegio Franco-Mexicano").name, "Colegio Franco-Mexicano");
  assert.equal(cleanTitle("Carla Ejemplo – 3080 (Inbound orgánico)").name, "Carla Ejemplo – 3080");
  // el paréntesis del medio no es una etiqueta del final
  assert.deepEqual(cleanTitle("Colegio (sede norte) San José"), { name: "Colegio (sede norte) San José", tag: "", tags: [] });
});
test("cleanTitle: un título que es solo la etiqueta (o vacío) no queda vacío ni inventa nada", () => {
  assert.deepEqual(cleanTitle("(Inbound)"), { name: "(Inbound)", tag: "", tags: [] });
  assert.deepEqual(cleanTitle(""), { name: "", tag: "", tags: [] });
  assert.deepEqual(cleanTitle(null), { name: "", tag: "", tags: [] });
  assert.equal(cleanTitle("Colegio Patria ()").name, "Colegio Patria");
  assert.equal(cleanTitle("Colegio Patria ()").tag, "");
});
test("cleanTitle: el nombre limpio es el mismo que usan los mensajes (msgSchoolName)", () => {
  for (const t of ["Colegio Olivos de Prueba (SDR Meta Ads Revival)", "Escuela Nueva Era (Inbound Google Ads)", "Colegio Sin Fuente (Inbound)", "Colegio Andino del Sur (EduExperience Mendoza 2026)",
    "Instituto Patria · OE-MX-1042", "Colegio Patria – Inbound Meta Ads", "Colegio Andino del Sur – EduExperience 2026", "Colegio San Ignacio de Loyola", "Colegio Patria (EduExperience Puebla 2026) · OE-MX-7"])
    assert.equal(cleanTitle(t).name, msgSchoolName({ name: t }), t);
});
test("subjectSansName: el nombre sale del asunto aunque no esté al final (y con su etiqueta)", () => {
  const who = "Colegio Olivos de Prueba (SDR Meta Ads Revival)";
  assert.equal(subjectSansName("Volver a llamar · Colegio Olivos de Prueba", who), "Volver a llamar");
  assert.equal(subjectSansName("Volver a llamar · Colegio Olivos de Prueba · prospecto", who), "Volver a llamar · prospecto");
  assert.equal(subjectSansName("Colegio Olivos de Prueba (SDR Meta Ads Revival) · Llamar", who), "Llamar");
  assert.equal(subjectSansName("Llamar · colegio olivos de prueba", who), "Llamar");
  // otro nombre no se toca; el asunto que es solo el nombre queda vacío (la fila pone el tipo de actividad)
  assert.equal(subjectSansName("Llamar · SDR revival Meta Ads · Laura Prueba", who), "Llamar · SDR revival Meta Ads · Laura Prueba");
  assert.equal(subjectSansName("Colegio Olivos de Prueba", who), "");
  assert.equal(subjectSansName("Llamar", ""), "Llamar");
  assert.equal(subjectSansName(null, who), "");
});
test("titleTag: el chip va escapado y sin etiqueta no hay chip", () => {
  assert.equal(titleTag(""), "");
  assert.match(titleTag("SDR revival"), /^<span class="row-tag" title="SDR revival">SDR revival<\/span>$/);
  assert.ok(!titleTag('<img src=x onerror="1">').includes("<img"));
});
test("callQueue: «en horario» se calcula una vez por colegio y el orden es el de siempre (en horario primero, estable; reactivar al final)", () => {
  S.markets = { México: { tz: "America/Mexico_City", horario: [["08:00", "14:00"]] }, Argentina: { tz: "America/Argentina/Buenos_Aires", horario: [["08:00", "12:00"]] } };
  const now = new Date("2026-11-18T16:00:00Z"); // miércoles: 10:00 en México (en horario), 13:00 en Argentina (fuera)
  const q = [{ id: "a1", country: "Argentina", status: "new" }, { id: "m1", country: "México", status: "new" }, { id: "x", country: "México", status: "lost" },
    { id: "a2", country: "Argentina", status: "org" }, { id: "m2", country: "México", status: "unk" }, { id: "s", country: "Argentina", status: "stalled" }, { id: "z", country: "Chile", status: "new" }];
  assert.equal(callWindow(q[1], now).ok, true);
  assert.equal(callWindow(q[0], now).ok, false);
  assert.equal(callWindow(q[6], now), null);
  assert.deepEqual(callQueue(q, now).map(x => x.id), ["m1", "m2", "a1", "a2", "z", "x", "s"]);
  // otra hora, otro resultado (la hora guardada por zona es por minuto): 9:00 en Argentina, 6:00 en México
  const early = new Date("2026-11-18T12:00:00Z");
  assert.deepEqual(callQueue(q, early).map(x => x.id), ["a1", "a2", "m1", "m2", "z", "x", "s"]);
  assert.deepEqual(callQueue(q, now).map(x => x.id), ["m1", "m2", "a1", "a2", "z", "x", "s"]);
  // una zona inválida no rompe: no se afirma nada
  S.markets.Roto = { tz: "No/Existe", horario: [["08:00", "14:00"]] };
  assert.equal(callWindow({ country: "Roto" }, now), null);
  assert.equal(q.length, 7);
});
