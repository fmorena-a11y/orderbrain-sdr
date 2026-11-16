// El nombre del colegio en un mensaje (lib/playbook.js msgSchoolName): sin etiquetas internas y sin inventar.
import { test } from "node:test";
import assert from "node:assert/strict";
import { msgSchoolName, templates } from "../lib/playbook.js";

const n = (name, contact = "") => msgSchoolName({ name }, { contact });
test("saca las etiquetas internas del título del prospecto", () => {
  assert.equal(n("Miguel Grau (Inbound)", "julio barrena"), "Miguel Grau");
  assert.equal(n("Colegio Andino del Sur (EduExperience Mendoza 2026)"), "Colegio Andino del Sur");
  assert.equal(n("CEI · OE-MX-000400"), "");
  assert.equal(n("Colegio San Andrés – Inbound Meta Ads"), "Colegio San Andrés");
  assert.equal(n("Natanael – 21 de José C. Paz (SDR Meta Ads Revival)", "Natanael"), "21 de José C. Paz");
  assert.equal(n("Colegio Monte Verde"), "Colegio Monte Verde");
});
test("si no se sabe el colegio, vacío (no se inventa)", () => {
  assert.equal(n("Maria luisa (SDR Meta Ads Revival)", "Maria luisa"), "");
  assert.equal(n("Maria luisa (SDR Meta Ads Revival)", "Maria"), "");
  assert.equal(n("48222982 (Inbound orgánico)"), "");
  assert.equal(n("AJY39"), "");
  assert.equal(n("Institucion (SDR Meta Ads Revival)"), "");
});
test("los mensajes dicen «tu colegio» y nunca la etiqueta", () => {
  const t = templates({ name: "Maria luisa (SDR Meta Ads Revival)", country: "Argentina" }, { me: "Facundo Morena", contact: "Maria luisa" });
  const after = t.find(x => x.id === "after_call").text;
  assert.doesNotMatch(after, /Revival|Inbound|Maria luisa \(/);
  assert.match(after, /tu colegio/);
  const g = templates({ name: "Miguel Grau (Inbound)", country: "Perú" }, { contact: "julio barrena" }).find(x => x.id === "after_call").text;
  assert.match(g, /de Miguel Grau\./); assert.doesNotMatch(g, /Inbound/);
});
