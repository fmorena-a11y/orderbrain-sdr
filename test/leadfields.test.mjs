// Campos del prospecto: siempre con dirección y teléfono/mail limpios (lib/sales.js)
import { test } from "node:test";
import assert from "node:assert/strict";
process.env.DEMO_MODE = "1";
const S = await import("../lib/sales.js");
const { DEAL_FIELDS: F } = await import("../lib/config.js");

test("teléfono y mail limpios (sin las aclaraciones del estudio)", () => {
  assert.equal(S.cleanPhoneVal("0341 421-4278 (San Juan 1650; atención de lunes a viernes de 14 a 17 h)"), "0341 421-4278");
  assert.equal(S.cleanPhoneVal("+54 341 493-2752 y +54 341 493-7350"), "+54 341 493-2752");
  assert.equal(S.cleanMailVal("sec3170_rosario@santafe.gob.ar (casilla oficial; hay que verificar)"), "sec3170_rosario@santafe.gob.ar");
  assert.equal(S.cleanPhoneVal("sin datos"), "");
});
test("dirección sin partes repetidas", () => {
  assert.equal(S.addrLine(["San Juan 1650, Rosario", "Rosario", "Santa Fe", "Argentina"]), "San Juan 1650, Rosario, Santa Fe, Argentina");
  assert.equal(S.addrLine(["Rosario", "", "Argentina"]), "Rosario, Argentina");
});
test("leadGaps: completa lo vacío y limpia el teléfono que quedó con aclaraciones", () => {
  const lead = { phone: "0341 421-4278 (San Juan 1650; atención de lunes a viernes de 14 a 17 h, según la web)", addr: "", email: "a@b.com" };
  const p = S.leadGaps(lead, { [F.direccion]: "Rosario, Santa Fe, Argentina", [F.telefono]: "+54 341 000 0000", [F.email]: "otro@b.com" });
  assert.equal(p[F.telefono], "0341 421-4278");
  assert.equal(p[F.direccion], "Rosario, Santa Fe, Argentina");
  assert.equal(p[F.email], undefined);
  assert.deepEqual(S.leadGaps({ phone: "+54 341 421 4278" }, { [F.telefono]: "x" }), {});
});
test("leadFields: siempre con dirección (la de la base o, sin calle, ciudad y país)", async () => {
  const f1 = await S.leadFields({ name: "X", city: "Rosario", country: "Argentina", addr: "San Juan 1650" }, { pdUserId: 1 });
  assert.equal(f1[F.direccion], "San Juan 1650, Rosario, Argentina");
  const f2 = await S.leadFields({ name: "X", city: "Rosario", country: "Argentina", addr: "", phone: "0341 421-4278 (San Juan 1650; atención…)" }, { pdUserId: 1 });
  assert.equal(f2[F.direccion], "Rosario, Argentina");
  assert.equal(f2[F.telefono], "0341 421-4278");
});
