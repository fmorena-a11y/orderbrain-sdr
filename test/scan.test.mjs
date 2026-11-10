// Qué es un colegio privado K-12 para el radar y el buscador de zonas (lib/scan.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { notSchool, classify, norm } from "../lib/scan.js";

const no = n => notSchool(norm(n));
test("notSchool: oficios (culinaria, barbería, estética) no son colegios", () => {
  for (const n of ["Escuela Culinaria de Mendoza", "Instituto de Artes Culinarias", "Barbería Escuela Pro", "Instituto de Estética y Cosmetología"]) assert.equal(no(n), true, n);
});
test("notSchool: liceo o colegio técnico de gastronomía sí es colegio", () => {
  for (const n of ["Colegio Técnico Culinario", "Liceo Técnico Profesional de Gastronomía"]) assert.equal(no(n), false, n);
});
test("notSchool: policía y escuelas militares de formación se descartan", () => {
  for (const n of ["Escuela de Policía General San Martín", "Academia de Policía", "Centro de Capacitación Policial", "Escuela Militar de Chorrillos", "Heroico Colegio Militar"]) assert.equal(no(n), true, n);
});
test("notSchool: «Colegio Militar» K-12 se queda", () => {
  for (const n of ["Colegio Militar Leoncio Prado", "Liceo Militar General Paz", "Colegio San José"]) assert.equal(no(n), false, n);
  assert.ok(classify({ name: "Colegio Militar Leoncio Prado" }));
});
test("notSchool: idiomas, manejo y música se descartan siempre", () => {
  for (const n of ["Colegio de Idiomas Berlitz", "Escuela de Manejo Rápido", "Escuela de Música Mozart"]) assert.equal(no(n), true, n);
});

test("classify: «público» en el nombre gana sobre la etiqueta de privado del mapa", () => {
  assert.equal(classify({ name: "Colegio Público San Martín", "operator:type": "private" }), null);
  assert.equal(classify({ name: "Escuela Publica Rivadavia", fee: "yes" }), null);
});
test("classify: «N° NN» en el nombre gana sobre la etiqueta de privado", () => {
  assert.equal(classify({ name: "Escuela N° 23 Belgrano", fee: "yes" }), null);
  assert.equal(classify({ name: "Colegio Santa Ana Nro 12", "operator:type": "private" }), null);
});
test("classify: si el nombre dice privado o particular, el número no lo vuelve público", () => {
  assert.equal(classify({ name: "Colegio Particular N° 12" })?.private, "seguro");
  assert.equal(classify({ name: "Instituto Privado N° 45" })?.private, "seguro");
});
test("classify: «Sede N° 2» es número de sede, no de escuela pública", () => assert.equal(classify({ name: "Colegio San Ignacio Sede N° 2", "operator:type": "private" })?.private, "seguro"));
test("classify: el número de sede no se toma como nivel (ISCED 2 = Secundaria)", { todo: "classify lee «\\b2\\b» del nombre como isced:level 2: «Colegio San Ignacio Sede N° 2» queda con levels [\"Secundaria\"] sin ningún dato de nivel" }, () => {
  assert.deepEqual(classify({ name: "Colegio San Ignacio Sede N° 2", "operator:type": "private" }).levels, []);
});
test("classify: operador público o del gobierno no entra", () => {
  assert.equal(classify({ name: "Colegio Los Andes", "operator:type": "public" }), null);
  assert.equal(classify({ name: "Colegio Los Andes", operator: "Secretaría de Educación Pública" }), null);
});
test("classify: privado del mapa queda «seguro»; solo por el nombre, «probable»", () => {
  assert.equal(classify({ name: "Colegio Los Andes", "operator:type": "private" }).private, "seguro");
  assert.equal(classify({ name: "Colegio Los Andes" }).private, "probable");
});
test("classify: en Costa Rica un «liceo» sin señal fuerte de privado no entra", () => {
  assert.equal(classify({ name: "Liceo de Heredia" }, "CR"), null);
  assert.ok(classify({ name: "Liceo Bilingüe de Heredia" }, "CR"));
});
test("classify: niveles por isced:level y palabras del nombre", () => assert.deepEqual(classify({ name: "Colegio Santa Ana", fee: "yes", "isced:level": "1;2" }).levels, ["Primaria", "Secundaria"]));
