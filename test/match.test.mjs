// Reglas del cruce colegio ↔ organización (lib/pipedrive.js): las comparten el cruce de a uno y la sincronización masiva.
// Los nombres de organizaciones son como los de la cuenta real (leídos de Pipedrive, solo lectura).
import { test } from "node:test";
import assert from "node:assert/strict";
for (const k of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "PIPEDRIVE_API_TOKEN"]) delete process.env[k];
process.env.DEMO_MODE = "1";
const pd = await import("../lib/pipedrive.js");

// una base chica: lo que importa es qué colegios comparten nombre y en qué ciudades
const base = [
  { id: "piura-obrero", name: "San José Obrero", city: "Piura", country: "Perú" },
  { id: "sd-obrero", name: "Colegio San Jose Obrero", city: "Santo Domingo", country: "República Dominicana" },
  { id: "lima-bosco", name: "Colegio Don Bosco", city: "Lima", country: "Perú" },
  { id: "cdmx-bosco", name: "Colegio Don Bosco", city: "Ciudad de México", country: "México" },
  { id: "mad-juanita", name: "Centro Privado de Educación Infantil Mamá Juanita", city: "Madrid", country: "España" },
  { id: "med-nicolas", name: "Centro Educativo San Nicolás", city: "Medellín", country: "Colombia" },
  { id: "aca-juarez", name: "Colegio Juarez", city: "Acapulco", country: "México" },
  { id: "lima-fe13", name: "Institución Educativa Inicial Fe y Alegría 13", city: "Lima", country: "Perú" },
  { id: "lima-romero", name: "Colegio Romero", city: "Lima", country: "Perú" },
  { id: "pue-ypsi", name: "Colegio Ypsilanti", city: "Puebla de Zaragoza", country: "México" },
  { id: "pue-andes", name: "Colegio Andes Puebla", city: "Puebla de Zaragoza", country: "México" },
  // para que «piura», «lima» y «mexico» cuenten como lugares (3 colegios o más)
  ...["Piura", "Lima", "Ciudad de México"].flatMap(c => ["Uno", "Dos", "Tres"].map(n => ({ id: `${c}-${n}`, name: `Colegio Prueba ${n}`, city: c, country: c === "Ciudad de México" ? "México" : "Perú" }))),
];
const ctx = pd.matchCtx(base);
const by = id => base.find(s => s.id === id);
// candidatos como los arma findOrgCandidates (sin pedir nada: la lista de organizaciones ya viene)
function cands(s, names) {
  const k = ctx.key(s);
  const l = names.map(([id, name]) => { const b = new Set(pd.tokens(name)); return pd.eligible(k.a, b) ? { id, name, ownerId: null, ...pd.rate(k, b, ctx.places) } : null; }).filter(Boolean);
  return pd.finishCandidates(k, l, ctx);
}
const pick = (s, names) => pd.pickOrg(cands(s, names))?.id ?? null;

test("palabras comunes solas no alcanzan: «Mamá Juanita» no es «…Ágora International School Madrid»", () => {
  const s = by("mad-juanita");
  const c = cands(s, [[14070, "Centro Privado de Educación Infantil, Primaria y Secundaria Ágora International School Madrid"], [10232, "Centro Integral de Educación Infantil"]]);
  assert.ok(c[0].score < 0.5, `puntaje ${c[0].score}`); assert.equal(pd.pickOrg(c), null);
});
test("«Centro Educativo San Nicolás» no es «CENTRO EDUCATIVO SAN JOSE» (antes daba 0.75 y se elegía)", () => {
  assert.equal(pick(by("med-nicolas"), [[76, "CENTRO EDUCATIVO SAN JOSE"]]), null);
  assert.equal(pick(by("med-nicolas"), [[76, "CENTRO EDUCATIVO SAN JOSE"], [77, "Centro Educativo San Nicolás"]]), 77);
});
// resultados reales de buscar «san jose obrero» en Pipedrive
const OBRERO = [[45756, "Colegio San Jose Obrero Piura"], [41048, "ESCUELA PARTICULAR SAN JOSE OBRERO"], [7023, "ESCUELA SAN JOSE OBRERO"], [8230, "San Jose Obrero"], [8270, "Instituto San Jose Obrero"], [7543, "Colegio San José Obrero"]];
test("la que nombra la ciudad del colegio gana; la que nombra otra ciudad no se elige para otro", () => {
  const p = cands(by("piura-obrero"), OBRERO);
  assert.equal(p[0].id, 45756); assert.ok(pd.isSure(p, ctx.key(by("piura-obrero"))), "sin dudas: las otras son ambiguas");
  // en Santo Domingo, «…Piura» es de otro lugar y el resto es ambiguo (el de Piura encaja igual): ninguna
  const sd = cands(by("sd-obrero"), OBRERO);
  assert.equal(pd.pickOrg(sd), null); assert.ok(sd.length > 0, "quedan como candidatas en la ficha");
});
test("mismo nombre en dos ciudades y una organización sin ciudad: no se elige para ninguno", () => {
  const BOSCO = [[1053, "COLEGIO DON BOSCO"], [4298, "INSTITUTO DON BOSCO"], [4635, "Colegio Don Bosco"], [4563, "Don Bosco Bolivia"]];
  assert.equal(pick(by("lima-bosco"), BOSCO), null);
  assert.equal(pick(by("cdmx-bosco"), BOSCO), null);
});
test("otro número u otras palabras propias de más: candidata, pero no se elige sola", () => {
  assert.equal(pick(by("lima-fe13"), [[1, "Institución Educativa Inicial Fe y Alegría 08"]]), null);
  assert.equal(pick(by("lima-fe13"), [[2, "Institución Educativa Inicial Fe y Alegría 13"]]), 2);
  assert.equal(pick(by("lima-romero"), [[3, "Colegio Óscar Arnulfo Romero"]]), null);
  assert.equal(pick(by("aca-juarez"), [[4, "Colegio Benito Juárez"]]), null);
});
test("isSure: una sola palabra propia, o empate arriba, no se confirma sola", () => {
  const j = cands(by("aca-juarez"), [[5, "Instituto Juárez"]]);
  assert.equal(pd.pickOrg(j)?.id, 5); assert.equal(pd.isSure(j, ctx.key(by("aca-juarez"))), false);
  const y = cands(by("pue-ypsi"), [[45771, "Colegio Ypsilanti"]]);
  assert.equal(pd.isSure(y, ctx.key(by("pue-ypsi"))), false); // «ypsilanti» es la única palabra propia
  const a = by("pue-andes"), two = cands(a, [[10, "Colegio Andes Puebla"], [11, "Instituto Andes Puebla"]]);
  assert.equal(pd.pickOrg(two).id, 10); assert.equal(pd.isSure(two, ctx.key(a)), false);
  assert.equal(pd.isSure(cands(a, [[10, "Colegio Andes Puebla"]]), ctx.key(a)), true);
});
test("ciudad: sin «San», «Ciudad»…, y la parte que la nombra («Puebla» por «Puebla de Zaragoza»)", () => {
  assert.deepEqual(pd.cityParts("San Miguel de Tucumán"), [["tucuman"]]);
  assert.deepEqual(pd.cityParts("Ciudad de México"), [["mexico"]]);
  assert.deepEqual(pd.cityParts("Santiago de Querétaro"), [["queretaro"]]);
  assert.equal(pd.cityIn(pd.cityParts("Puebla de Zaragoza"), new Set(["andes", "puebla"])), true);
  assert.equal(pd.cityIn(pd.cityParts("San Luis Potosí"), new Set(["luis"])), false); // «luis» solo no es la ciudad
  assert.equal(pd.cityIn(pd.cityParts("Mendoza"), new Set(["solcito", "mza"])), true); // abreviatura
});
test("keepsOrg: se mantiene lo elegido a mano; lo confirmado solo se recalcula; lo viejo, según cómo se guardó", () => {
  const s = by("lima-bosco");
  assert.equal(pd.keepsOrg({ confirmed: true, orgId: 1, auto: false }), true);
  assert.equal(pd.keepsOrg({ confirmed: true, orgId: 1, auto: true }), false);
  // viejo (sin «auto»), con otras candidatas y todas las palabras en la organización: lo confirmó el puntaje viejo
  const old = { confirmed: true, orgId: 1053, orgName: "COLEGIO DON BOSCO", candidates: [{ id: 4635, name: "Colegio Don Bosco", score: 1 }] };
  assert.equal(pd.keepsOrg(old, s), false);
  assert.equal(pd.keepsOrg(old, s, true), true); // alguien registró contactos: se respeta
  assert.equal(pd.keepsOrg({ ...old, leadId: "L1" }, s), true); // tiene prospecto
  assert.equal(pd.keepsOrg({ ...old, candidates: [] }, s), true); // elegido con «Es esta» (sin candidatas)
  assert.equal(pd.keepsOrg({ ...old, orgName: "Salesianos" }, s), true); // otra organización: la eligió una persona
});
test("matchRecord: confirmado solo nace sin candidatas; los candidatos guardados son pocos y livianos", () => {
  const M = { users: [], pipes: {}, stages: {} };
  const many = Array.from({ length: 6 }, (_, i) => ({ id: 100 + i, name: `Org ${i}`, ownerId: null, score: 0.9 - i * 0.12 }));
  const auto = pd.matchRecord({ chosen: { id: 1, name: "X" }, deals: [], m: M, ownerId: null, auto: true, candidates: many });
  assert.deepEqual([auto.confirmed, auto.auto, auto.candidates], [true, true, []]);
  const loose = pd.matchRecord({ chosen: { id: 1, name: "X" }, deals: [], m: M, ownerId: null, candidates: many });
  assert.deepEqual(loose.candidates.map(c => c.id), [100, 101, 102, 103]); // hasta 4, desde 0.3
  assert.deepEqual(Object.keys(loose.candidates[0]), ["id", "name", "ownerId", "score"]);
  assert.equal(pd.noMatchRecord([{ id: 9, name: "Y", score: 0.2 }]).detail, "No figura en Pipe");
});
