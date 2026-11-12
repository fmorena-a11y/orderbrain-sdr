// Investigación antes de crear (lib/existing.js): reglas puras y casos REALES de la cuenta (test/fixtures/existing-real.json:
// respuestas de /v2/itemSearch leídas por MCP, solo lectura, con teléfonos, mails y personas falsos).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
for (const k of ["PIPEDRIVE_API_TOKEN", "DEMO_MODE"]) delete process.env[k];
const E = await import("../lib/existing.js");
const pd = await import("../lib/pipedrive.js");
const fx = JSON.parse(fs.readFileSync(new URL("./fixtures/existing-real.json", import.meta.url), "utf8"));
const base = JSON.parse(fs.readFileSync(new URL("../data/schools.json", import.meta.url), "utf8"));
const places = pd.placeWords(base);
const school = (name, city = "Puebla de Zaragoza", more = {}) => ({ name, city, country: "México", ...more });
const lvl = (s, title) => E.nameLevel(E.keyOf(s), title, places);

test("fold y cleanTitle: letras dobles, eventos, códigos del bot y «S.C.»", () => {
  assert.equal(E.fold("Colegio Luz María Serradell"), E.fold("colegio luz maria serradel"));
  assert.equal(E.fold("Pestalozzi 100"), "pestalozi 100");
  assert.equal(E.cleanTitle("Colegio Ángeles  de Puebla · OE-MX-000322"), "Colegio Ángeles de Puebla");
  assert.equal(E.cleanTitle("Juan Enrique Pestalozzi - Lorena (EduExperience Mendoza 2026)"), "Juan Enrique Pestalozzi - Lorena");
  assert.equal(E.cleanTitle("Centro Freinet Prometeo S.C."), "Centro Freinet Prometeo");
});

test("addrParts: municipio y estado de las direcciones de Pipedrive (importadas, de la app y a mano)", () => {
  assert.deepEqual(E.addrParts("calle 13 poniente No. 0, Colonia ninguno, atlixco, puebla, C.P. 0"), { muni: "atlixco", state: "puebla", country: "" });
  assert.deepEqual(E.addrParts("Boulevard de las Torres 1844, Puebla de Zaragoza, México"), { muni: "Puebla de Zaragoza", state: "", country: "México" });
  assert.deepEqual(E.addrParts("Av. 3 Oriente 205 Centro, San Pedro Cholula, Puebla"), { muni: "San Pedro Cholula", state: "Puebla", country: "" });
  assert.equal(E.addrParts("Urb. Los Damascos, 1.ª Etapa G-04 (al costado), Tacna, Perú.").muni, "Tacna");
  assert.equal(E.addrParts("calle hacienda pasteje num. 40 manzana 7 lotes 1, 2, 16 No. 40, Colonia impulsora, nezahualcoyotl, méxico, C.P. 57130").muni, "nezahualcoyotl");
  assert.equal(E.addrParts("sin comas"), null);
});

test("sameCity: «Puebla» es «Puebla de Zaragoza», «Atizapán de Zaragoza» no; CDMX con su alias", () => {
  assert.equal(E.sameCity("puebla", "Puebla de Zaragoza"), true);
  assert.equal(E.sameCity("Heroica Puebla de Zaragoza", "Puebla de Zaragoza"), true);
  assert.equal(E.sameCity("atizapan de zaragoza", "Puebla de Zaragoza"), false);
  assert.equal(E.sameCity("oaxaca de juarez", "Oaxaca de Juárez"), true);
  assert.equal(E.sameCity("cdmx", "Ciudad de México"), true);
  assert.equal(E.sameCity("tlalpan", "Ciudad de México"), false);
  assert.equal(E.sameCity("queretaro", "Santiago de Querétaro"), true);
});

test("placeLevel: misma ciudad, otro municipio del estado, otra ciudad o país, o no dice", () => {
  const p = school("Colegio X");
  assert.equal(E.placeLevel(p, { texts: ["privada 63 f oriente No. 0, Colonia villa universitaria, puebla, puebla, C.P. 72589"] }), "same");
  assert.equal(E.placeLevel(p, { texts: ["calle 13 poniente No. 0, Colonia ninguno, atlixco, puebla, C.P. 0"] }), "near");
  assert.equal(E.placeLevel(p, { texts: ["calle colorines No. 88, Colonia jardines, atizapan de zaragoza, méxico, C.P. 52978"] }), "other");
  assert.equal(E.placeLevel(p, { texts: ["Urb. Los Damascos, Tacna, Perú."] }), "other");
  assert.equal(E.placeLevel(p, { texts: ["6865550107", "contacto@example.com"] }), null);
  // la ciudad en el título cuenta, salvo que esté en el nombre del colegio
  const cdmx = school("Colegio Pedregal del Sur", "Ciudad de México");
  assert.equal(E.placeLevel(cdmx, { title: "colegio pedregal del sur cdmx" }), "same");
  assert.equal(E.placeLevel(cdmx, { texts: ["calle chichimecas No. 434, Colonia ajusco, coyoacan, ciudad de méxico, C.P. 4300"] }), "same");
  assert.equal(E.placeLevel(school("Colegio Ángeles De Puebla"), { title: "Colegio Ángeles de Puebla · OE-MX-000322" }), null);
  // organización con ciudad (de su dirección)
  assert.equal(E.placeLevel(p, { org: { city: "Puebla", region: "Puebla", country: "México" } }), "same");
  assert.equal(E.placeLevel(p, { org: { city: "Veracruz", region: "Veracruz", country: "México" } }), "other");
});

test("nameLevel: mismo nombre, con algo de más, parecido o nada (con las reglas del cruce)", () => {
  assert.equal(lvl(school("Montessori Ángeles"), "montessori angeles"), "same");
  assert.equal(lvl(school("colegio enrique pestalozzi"), "colegio enrique pestalozzi ac"), "same");
  assert.equal(lvl(school("Colegio Luz Maria Serradel"), "colegio luz maria serradell ac"), "same");
  assert.equal(lvl(school("Colegio Hispanidad"), "Colegio Hispanidad PUE"), "same"); // «PUE» es el estado
  assert.equal(lvl(school("Colegio Pedregal del Sur", "Ciudad de México"), "colegio pedregal del sur cdmx"), "same");
  assert.equal(lvl(school("Colegio Ángeles De Puebla"), "Colegio Ángeles  de Puebla · OE-MX-000322"), "same");
  // un nivel o una sede de más: no es «el mismo»
  assert.equal(lvl(school("La Salle del Pedregal", "Ciudad de México"), "preparatoria la salle del pedregal"), "contains");
  // con una sola palabra propia, nada de más: «Santa María de los Ángeles» es otro colegio
  assert.equal(lvl(school("Colegio Los Ángeles", "Torreón"), "Colegio Santa Maria de los Angeles"), "contains");
  assert.equal(lvl(school("Colegio Los Ángeles", "Torreón"), "COLEGIO LOS ANGELES"), "same");
  // dos palabras propias de más («Tlaxco Mexicail»): a lo sumo «contiene»
  assert.equal(lvl(school("Colegio Ángeles De Puebla"), "Angeles de puebla Tlaxco Mexicail 714"), "contains");
  assert.equal(lvl(school("Colegio Ángeles De Puebla"), "angeles de atlixco"), null);
  assert.equal(lvl(school("Colegio Pedregal del Sur", "Ciudad de México"), "pedregal del bosque"), null);
});

test("contactHit: teléfono (con o sin +52, espacios o guiones), mail o web (no gmail ni facebook)", () => {
  const c = E.contactOf(school("Colegio X", undefined, { phone: "+52 222 555 0248", web: "https://www.colegio-x.edu.mx/inicio", email: "Direccion@Colegio-X.edu.mx" }));
  assert.equal(E.contactHit(c, { texts: ["222 555 0248"] }), "phone");
  assert.equal(E.contactHit(c, { texts: ["(222) 555-0248 / 222 555 0000"] }), "phone");
  assert.equal(E.contactHit(c, { phones: ["2225550248"] }), "phone");
  assert.equal(E.contactHit(c, { texts: ["direccion@colegio-x.edu.mx"] }), "email");
  assert.equal(E.contactHit(c, { texts: ["colegio-x.edu.mx"] }), "web");
  assert.equal(E.contactHit(c, { texts: ["otra@colegio-x.edu.mx"] }), "web"); // el dominio del mail es la web del colegio
  assert.equal(E.contactHit(c, { texts: ["222 555 0249", "https://www.facebook.com/colegiox"] }), null);
  const g = E.contactOf(school("Colegio Y", undefined, { email: "colegioy@gmail.com", web: "https://facebook.com/colegioy" }));
  assert.deepEqual(g.hosts, []); // un gmail o una página de Facebook no identifican al colegio
  assert.equal(E.contactHit(g, { texts: ["otro@gmail.com"] }), null);
  // un número local (7 dígitos) contra el completo
  assert.equal(E.samePhone("2461092", "2222461092"), true);
  assert.equal(E.samePhone("461092", "2222461092"), false);
});

test("searchTerms y queryPlan: el nombre propio (con y sin acentos), con la ciudad, y en la completa teléfono, mail y web", () => {
  const t = E.searchTerms(school("Colegio Ángeles De Puebla"));
  assert.deepEqual(t.title, ["angeles", "ángeles"]); assert.equal(t.local, "angeles puebla");
  assert.deepEqual(E.searchTerms(school("Colegio Luz Maria Serradel")).title, ["luz serradel"]);
  const light = E.queryPlan(school("Montessori Ángeles"));
  assert.deepEqual(light.map(q => [q.types, q.fields, q.term]), [["lead,deal", "title", "montessori angeles"], ["lead,deal", "title,custom_fields", "montessori angeles puebla"]]);
  const full = E.queryPlan(school("Colegio Ypsilanti", undefined, { phone: "+52 222 555 0248", web: "https://www.colegio-ypsilanti.edu.mx" }), { full: true });
  assert.ok(full.some(q => q.fields === "custom_fields" && q.term === "222 555 0248" && q.types.includes("organization")));
  assert.ok(full.some(q => q.types === "person" && q.fields === "phone" && q.term === "2225550248"));
  assert.ok(full.some(q => q.fields === "custom_fields" && q.term === "colegio-ypsilanti.edu.mx"));
});

test("decide: archivado o trato perdido sin organización = dato; elige el prospecto abierto (tuyo, libre, de otro); «Es otro colegio» descarta", () => {
  const S = (key, more) => ({ key, kind: key.split(":")[0], id: key.split(":")[1], title: "x", level: "sure", why: "", ...more });
  const r = E.decide([S("lead:a", { archived: true }), S("deal:1", { status: "lost" }), S("lead:b", { ownerId: 7 }), S("lead:c", { ownerId: null }), S("lead:d", { ownerId: 5 })], { me: 5 });
  assert.equal(r.verdict, "sure"); assert.equal(r.pick.key, "lead:d");
  assert.deepEqual(r.info.map(x => x.key), ["lead:a", "deal:1"]);
  assert.deepEqual(r.also.map(x => x.key).sort(), ["lead:b", "lead:c"]);
  const m = E.decide([S("lead:e", { level: "maybe" }), S("deal:2", { level: "maybe", orgId: 3 })]);
  assert.equal(m.verdict, "maybe"); assert.equal(m.maybe.length, 2);
  assert.equal(E.decide([S("lead:e", { level: "maybe" })], { no: ["lead:e"] }).verdict, "none");
});

// ---------- casos reales: con los pedidos que arma queryPlan, lo que respondió Pipedrive y la decisión
const run = s => {
  const plan = E.queryPlan(s, { full: true });
  const items = plan.flatMap(q => q.types.split(",").flatMap(t => fx.queries[`${t}|${q.fields}|${q.term}`] || []));
  return { plan, used: plan.filter(q => q.types.split(",").some(t => fx.queries[`${t}|${q.fields}|${q.term}`])), r: E.decide(E.judgeAll(s, E.ctxOf(s, places), items)) };
};
for (const c of fx.cases) {
  test(`real: ${c.id} → ${c.expect.verdict}${c.expect.pick ? ` ${c.expect.pick}` : ""} (${c.why})`, () => {
    const { r, used } = run(c.school);
    assert.ok(used.length > 0, "los pedidos que arma la app son los que se probaron en la cuenta");
    assert.equal(r.verdict, c.expect.verdict, JSON.stringify({ pick: r.pick?.key, maybe: r.maybe.map(x => x.key) }));
    if (c.expect.pick) assert.equal(r.pick.key, c.expect.pick);
    for (const k of c.expect.maybe || []) assert.ok(r.maybe.some(x => x.key === k), `${k} entre los dudosos`);
    for (const k of c.expect.info || []) assert.ok(r.info.some(x => x.key === k), `${k} como dato`);
    for (const k of c.expect.not || []) assert.ok(r.pick?.key !== k && !r.maybe.some(x => x.key === k), `${k} no es este colegio`);
  });
}
test("real: un colegio con nombre parecido de otra ciudad nunca es «sure» (Puebla vs. Atlixco, Mexicali, Huejotzingo)", () => {
  const { r } = run(school("Colegio Ángeles De Puebla"));
  assert.equal(r.pick, null);
  assert.deepEqual(r.maybe.map(x => x.key), ["deal:6091"]);
  const { r: r2 } = run(school("Colegio Ángeles de Atlixco", "Atlixco"));
  assert.equal(r2.pick.key, "lead:36a32c80-7193-11f0-ae7b-258e5b6a816f");
});
