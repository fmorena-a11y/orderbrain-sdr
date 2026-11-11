// Direcciones escritas a mano (lib/geo.js): normalizar, deducir país y estado, elegir el resultado sin aceptar otra ciudad
// y la cadena de intentos con geocodificadores simulados (sin red).
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAddress, fits, streetMatch, sameName, pickStreet, locateAddress, fromNominatim, fromPhoton, fromGoogle, crossOf, crossPoint, noteFor, photonUrl, cornerQuery } from "../lib/geo.js";

const P = (q, o) => parseAddress(q, o);
const pick = (a, ...ks) => Object.fromEntries(ks.map(k => [k, a[k]]));

// ---------- normalizar
test("MX: «No.», «Col.» pegado y «Pue.» (el caso del líder)", () => {
  const a = P("Calle Bugambilias No. 47, Col.Bosques de Amalucan, Puebla, Pue.");
  assert.deepEqual(pick(a, "street", "number", "colonia", "city", "state", "cc"), { street: "Calle Bugambilias", number: "47", colonia: "Bosques de Amalucan", city: "Puebla", state: "Puebla", cc: "MX" });
  assert.equal(a.isAddress, true);
  assert.equal(a.text, "Calle Bugambilias 47, Bosques de Amalucan, Puebla, México");
  assert.equal(a.label, "Calle Bugambilias 47, Bosques de Amalucan, Puebla");
});
test("MX: minúsculas, paréntesis, «Colonia», estado repetido y «C.P.»", () => {
  const a = P("calle bugambilias No. 47, Colonia lumbreras de amalucan (jardines), puebla, puebla, C.P. 72310");
  assert.deepEqual(pick(a, "street", "number", "colonia", "city", "state", "postcode", "cc"), { street: "Calle Bugambilias", number: "47", colonia: "Lumbreras de Amalucan", city: "Puebla", state: "Puebla", postcode: "72310", cc: "MX" });
});
test("MX: «Blvrd», número al final y la capital como ciudad («Jardines de San Manuel, Puebla»)", () => {
  const a = P("Blvrd 14 Sur 5942, Jardines de San Manuel, Puebla");
  assert.deepEqual(pick(a, "street", "number", "colonia", "city", "state", "cc"), { street: "Boulevard 14 Sur", number: "5942", colonia: "Jardines de San Manuel", city: "Puebla", state: "Puebla", cc: "MX" });
  assert.equal(P("Boulevard 14 Sur, Puebla").number, "", "«14 Sur» es el nombre, no el número");
});
test("MX: como lo escribe Google («C.», «72310 Heroica Puebla de Zaragoza», «Pue.», «México»)", () => {
  const a = P("C. Bugambilias 47, Lumbreras de Amalucan, 72310 Heroica Puebla de Zaragoza, Pue., México");
  assert.deepEqual(pick(a, "street", "number", "colonia", "city", "state", "postcode", "cc"), { street: "Calle Bugambilias", number: "47", colonia: "Lumbreras de Amalucan", city: "Heroica Puebla de Zaragoza", state: "Puebla", postcode: "72310", cc: "MX" });
});
test("MX: sin comas («… Bosques de Amalucan Puebla Pue»)", () => {
  const a = P("Calle Bugambilias 47 Bosques de Amalucan Puebla Pue");
  assert.deepEqual(pick(a, "street", "number", "colonia", "city", "state", "cc"), { street: "Calle Bugambilias", number: "47", colonia: "Bosques de Amalucan", city: "Puebla", state: "Puebla", cc: "MX" });
});
test("MX: CDMX, alcaldía, «S/N», «Int.», «5 Pte.» y «2501 Sur»", () => {
  const a = P("Eje Central Lázaro Cárdenas No. 2, Col. Centro, Cuauhtémoc, C.P. 06000, CDMX");
  assert.deepEqual(pick(a, "street", "number", "colonia", "city", "postcode", "cc"), { street: "Eje Central Lázaro Cárdenas", number: "2", colonia: "Centro", city: "Ciudad de México", postcode: "06000", cc: "MX" });
  assert.deepEqual(a.extra, ["Cuauhtémoc"]);
  const r = P("Paseo de la Reforma s/n, Polanco, Miguel Hidalgo, CDMX");
  assert.deepEqual(pick(r, "street", "number", "colonia", "city"), { street: "Paseo de la Reforma", number: "", colonia: "Polanco", city: "Ciudad de México" });
  const p = P("Calle 5 Pte. 1203 Int. 4, Centro, Puebla, Pue.");
  assert.deepEqual(pick(p, "street", "number", "colonia"), { street: "Calle 5 Poniente", number: "1203", colonia: "Centro" });
  const m = P("Av. Eugenio Garza Sada 2501 Sur, Tecnológico, Monterrey, N.L.");
  assert.deepEqual(pick(m, "street", "number", "colonia", "city", "state"), { street: "Avenida Eugenio Garza Sada", number: "2501", colonia: "Tecnológico", city: "Monterrey", state: "Nuevo León" });
});
test("MX: abreviaturas de estados («Jal.», «N.L.», «Edo. Méx.», «Q. Roo», «S.L.P.») y «Col.» sola es Colima", () => {
  assert.equal(P("Av. Vallarta 3233, Guadalajara, Jal.").state, "Jalisco");
  assert.equal(P("Toluca, Edo. Méx.").state, "Estado de México");
  assert.equal(P("Toluca, Edo. Méx.").city, "Toluca");
  assert.equal(P("Av. Tulum 10, Cancún, Q. Roo").state, "Quintana Roo");
  assert.equal(P("Av. Carranza 500, San Luis Potosí, S.L.P.").state, "San Luis Potosí");
  const c = P("Calle Madero 20, Centro, Manzanillo, Col.");
  assert.deepEqual(pick(c, "colonia", "city", "state", "cc"), { colonia: "Centro", city: "Manzanillo", state: "Colima", cc: "MX" });
});
test("AR: CABA, «Pcia. de Córdoba» y «Bs. As.»", () => {
  assert.deepEqual(pick(P("Av. Cabildo 2040, CABA"), "street", "number", "city", "cc"), { street: "Avenida Cabildo", number: "2040", city: "Buenos Aires", cc: "AR" });
  assert.deepEqual(pick(P("Av. Vélez Sarsfield 361, Nueva Córdoba, Córdoba, Pcia. de Córdoba"), "street", "number", "colonia", "city", "state", "cc"),
    { street: "Avenida Vélez Sarsfield", number: "361", colonia: "Nueva Córdoba", city: "Córdoba", state: "Córdoba", cc: "AR" });
  assert.deepEqual(pick(P("Calle 7 N° 1234, La Plata, Bs. As."), "street", "number", "city", "state", "cc"), { street: "Calle 7", number: "1234", city: "La Plata", state: "Buenos Aires", cc: "AR" });
});
test("CL: comuna y ciudad; «Pte. Riesco» es Presidente; «Región Metropolitana»", () => {
  const a = P("Av. Apoquindo 3000, Las Condes, Santiago");
  assert.deepEqual(pick(a, "street", "number", "colonia", "city", "cc", "soft"), { street: "Avenida Apoquindo", number: "3000", colonia: "Las Condes", city: "Santiago", cc: "", soft: "CL" });
  const b = P("Av. Pte. Riesco 5711, Las Condes, Región Metropolitana");
  assert.deepEqual(pick(b, "street", "number", "city", "cc"), { street: "Avenida Presidente Riesco", number: "5711", city: "Las Condes", cc: "CL" });
});
test("PE: distrito y ciudad; «Lima 33» es Lima", () => {
  assert.deepEqual(pick(P("Av. Javier Prado Este 4200, Surco, Lima"), "street", "number", "colonia", "city", "soft"), { street: "Avenida Javier Prado Este", number: "4200", colonia: "Surco", city: "Lima", soft: "PE" });
  assert.equal(P("Jr. Huancavelica 320, Lima 33").city, "Lima");
  assert.equal(P("Jr. Huancavelica 320, Lima 33").street, "Jirón Huancavelica");
});
test("CO: «Calle 100 # 15-20» (número de placa) y «Cra.», «Bogotá D.C.»", () => {
  const a = P("Calle 100 # 15-20, Bogotá");
  assert.deepEqual(pick(a, "street", "number", "city", "soft"), { street: "Calle 100", number: "15-20", city: "Bogotá", soft: "CO" });
  assert.equal(crossOf(a), "Carrera 15");
  const b = P("Cra. 7 # 72-41, Bogotá D.C.");
  assert.deepEqual(pick(b, "street", "number", "city", "cc"), { street: "Carrera 7", number: "72-41", city: "Bogotá", cc: "CO" });
  assert.equal(crossOf(b), "Calle 72");
  assert.equal(crossOf(P("Calle Bugambilias No. 47, Puebla, Pue.")), null);
});
test("UY: barrio y ciudad; país escrito", () => {
  assert.deepEqual(pick(P("Av. Brasil 2500, Pocitos, Montevideo"), "street", "number", "colonia", "city", "soft"), { street: "Avenida Brasil", number: "2500", colonia: "Pocitos", city: "Montevideo", soft: "UY" });
  assert.deepEqual(pick(P("Av. 18 de Julio 1234, Centro, Montevideo, Uruguay"), "street", "number", "colonia", "city", "cc"), { street: "Avenida 18 de Julio", number: "1234", colonia: "Centro", city: "Montevideo", cc: "UY" });
});
test("deducir país: el texto manda sobre el país elegido en la app; un nombre suelto no es dirección", () => {
  assert.equal(P("Calle X 5, Centro, Puebla, Pue.", { cc: "EC" }).cc, "MX", "el estado escrito gana sobre el chip");
  assert.equal(P("Calle Sucre 12, Centro, Cuenca", { cc: "EC" }).cc, "EC", "sin país en el texto, vale el que escribió aparte");
  assert.equal(P("Calle Sucre 12, Centro, Cuenca").cc, "");
  assert.equal(P("Puebla").isAddress, false);
  assert.equal(P("Lumbreras de Amalucan").name, "Lumbreras de Amalucan");
  assert.equal(P("Col. Centro, Puebla").isAddress, true);
  assert.equal(P("Palermo, Buenos Aires").isAddress, false);
  assert.equal(P("Mex").state, "", "una abreviatura sola no es un estado");
  assert.equal(P("CDMX").city, "Ciudad de México");
  assert.equal(P("Ciudad de México").city, "Ciudad de México");
  assert.equal(P("Calle Madero 5 Centro Ciudad de México").city, "Ciudad de México");
  assert.equal(P("Av. Libertador 1000 Santiago de Chile").city, "Santiago de Chile");
});
test("la clave de la copia es el texto normalizado", () => {
  assert.equal(P("Calle Bugambilias No. 47, Col.Bosques de Amalucan, Puebla, Pue.").key, P("calle bugambilias 47, colonia bosques de amalucan, puebla, puebla").key);
});

// ---------- reglas
test("streetMatch: plural, abreviaturas y calles de número (Calle ≠ Carrera, 100 ≠ 100B)", () => {
  assert.ok(streetMatch("Calle Bugambilias", "Calle Bugambilia"));
  assert.ok(streetMatch("Eje Central Lázaro Cárdenas", "Avenida Lázaro Cárdenas"));
  assert.ok(streetMatch("Avenida Javier Prado Este", "Javier Prado Este"));
  assert.ok(!streetMatch("Avenida Javier Prado Este", "Avenida Javier Prado Oeste"));
  assert.ok(streetMatch("Calle 100", "Avenida Calle 100"));
  assert.ok(!streetMatch("Calle 100", "Carrera 100"));
  assert.ok(!streetMatch("Calle 100", "Calle 100B"));
  assert.ok(streetMatch("Boulevard 14 Sur", "Bulevar 14 Sur"));
  assert.ok(!streetMatch("Calle Bugambilias", "Calle Valle de Puebla"));
});
test("sameName: «Puebla» = «Municipio de Puebla»; «Bogotá D.C.» = «Bogotá, Distrito Capital»", () => {
  assert.ok(sameName("Puebla", "Municipio de Puebla"));
  assert.ok(sameName("Heroica Puebla de Zaragoza", "Puebla de Zaragoza"));
  assert.ok(sameName("Bogotá D.C.", "Bogotá, Distrito Capital"));
  assert.ok(!sameName("Lumbreras de Amalucan", "Bosques de Amalucan Segunda Sección"));
  assert.ok(sameName("Bosques de Amalucan", "Bosques de Amalucan Segunda Sección"));
});

// resultados simulados en el formato de cada servicio
const nomi = (o) => ({ osm_type: "way", osm_id: o.id || 1, lat: String(o.lat), lon: String(o.lng), category: o.cat || "highway", type: o.type || "residential", addresstype: o.at || o.type || "road", name: o.name || "",
  address: { road: o.road, house_number: o.num, suburb: o.suburb, neighbourhood: o.nb, city_district: o.cd, city: o.city, town: o.town, county: o.county, state: o.state, postcode: o.pc, country: o.country || "México", country_code: (o.cc || "mx").toLowerCase() } });
const phot = (o) => ({ geometry: { coordinates: [o.lng, o.lat] }, properties: { osm_type: o.ot || "W", osm_id: o.id || 1, type: o.type || "street", name: o.name, street: o.street, housenumber: o.num, district: o.district, locality: o.locality, city: o.city, county: o.county, state: o.state, postcode: o.pc, countrycode: o.cc || "MX", country: o.country || "México", extent: o.extent } });

test("fits: «…, Puebla» no acepta un pueblo del estado de Puebla ni otro país; sí el municipio de Puebla", () => {
  const a = P("Calle Insurgentes Oriente 5, Puebla");
  const otroPueblo = fromNominatim(nomi({ lat: 18.33, lng: -97.47, road: "Calle Insurgentes Oriente", town: "Zapotitlán Salinas", county: "Zapotitlán", state: "Puebla" }));
  const capital = fromNominatim(nomi({ lat: 19.04, lng: -98.2, road: "Calle Insurgentes Oriente", city: "Puebla de Zaragoza", county: "Municipio de Puebla", state: "Puebla" }));
  const otroPais = fromNominatim(nomi({ lat: 40.4, lng: -3.7, road: "Calle Insurgentes Oriente", city: "Puebla de Sanabria", state: "Castilla y León", cc: "es", country: "España" }));
  assert.equal(fits(otroPueblo, a, ["MX"]), false);
  assert.equal(fits(capital, a, ["MX"]), true);
  assert.equal(fits(otroPais, a, ["MX"]), false);
  // sin ciudad, estado ni país escritos: no se acepta nada (no hay con qué comprobar)
  assert.equal(fits(capital, P("Calle Insurgentes Oriente 5"), []), false);
});
test("Photon: se elige la calle de la colonia escrita y nunca una de otra ciudad", () => {
  const a = P("Calle Bugambilias No. 47, Col.Bosques de Amalucan, Puebla, Pue.");
  const feats = [
    phot({ lat: 18.97, lng: -98.27, name: "Calle Bugambilias", city: "San Andrés Cholula", county: "San Andrés Cholula", state: "Puebla", pc: "72830" }),
    phot({ lat: 18.43, lng: -97.37, name: "Calle Bugambilias", city: "Tehuacán", county: "Tehuacán", state: "Puebla" }),
    phot({ lat: 19.0215, lng: -98.148, name: "Calle Bugambilias", city: "Puebla", county: "Municipio de Puebla", state: "Puebla", pc: "72365" }),
    phot({ lat: 19.05498, lng: -98.11858, name: "Calle Bugambilia", district: "Bosques de Amalucan Segunda Sección", city: "Santa María Xonacatepec", county: "Municipio de Puebla", state: "Puebla", pc: "72229" }),
  ];
  const hits = feats.map(fromPhoton).filter(h => fits(h, a, ["MX"]));
  assert.equal(hits.length, 2, "Cholula y Tehuacán quedan afuera");
  const r = pickStreet(hits, a);
  assert.equal(r.level, "street");
  assert.equal(r.hit.lat, 19.05498);
});
test("pickStreet: con colonia escrita y nada que coincida, espera a ubicar la colonia (aunque el número coincida en otra)", () => {
  const a = P("Eje Central Lázaro Cárdenas No. 2, Col. Centro, Cuauhtémoc, C.P. 06000, CDMX");
  // un «2» en otra colonia, con el código postal mal cargado en el mapa
  const otro = fromPhoton(phot({ type: "house", lat: 19.4934, lng: -99.1452, name: "", street: "Eje Central Lázaro Cárdenas", num: "2", locality: "Unidad Habitacional Lindavista Vallejo", city: "Ciudad de México", state: "Ciudad de México", pc: "06000" }));
  assert.ok(pickStreet([otro], a).pending, "no se acepta");
  const centro = fromPhoton(phot({ lat: 19.4326, lng: -99.1411, name: "Avenida Lázaro Cárdenas", locality: "Colonia Centro", city: "Ciudad de México", state: "Ciudad de México", pc: "06000" }));
  const r = pickStreet([otro, centro], a);
  assert.equal(r.hit, centro);
});

// ---------- la cadena de intentos, con servicios simulados
function fakes({ nom = () => [], pho = () => ({ features: [] }), google = null, overpass = null } = {}) {
  const calls = [];
  return {
    calls,
    nominatim: async p => { calls.push(["nominatim", p]); return nom(p); },
    photon: async p => { calls.push(["photon", p]); return pho(p); },
    google: google && (async p => { calls.push(["google", p]); return google(p); }),
    overpass: overpass && (async q => { calls.push(["overpass", q]); return overpass(q); }),
  };
}
const run = (q, f, o = {}) => locateAddress(P(q, o), { raw: [], codes: ["MX", "AR", "CL", "PE", "CO", "UY", "EC"], deadline: Date.now() + 5000, ...f, ...o });

test("cadena: la calle de Photon en la colonia escrita; la nota dice que el número no figura", async () => {
  const f = fakes({ pho: p => ({ features: p.layer?.includes("street") ? [phot({ lat: 19.05498, lng: -98.11858, name: "Calle Bugambilia", district: "Bosques de Amalucan Segunda Sección", city: "Santa María Xonacatepec", county: "Municipio de Puebla", state: "Puebla" })] : [] }) });
  const r = await run("Calle Bugambilias No. 47, Col.Bosques de Amalucan, Puebla, Pue.", f);
  assert.equal(r.level, "street");
  assert.equal(r.note, "Ubiqué Calle Bugambilia (Bosques de Amalucan Segunda Sección); el número 47 no figura en OpenStreetMap.");
  // se busca primero tal cual y después normalizado y estructurado en Nominatim, con el país del texto (no el del chip)
  assert.ok(f.calls.some(([k, p]) => k === "nominatim" && p.q === "Calle Bugambilias 47, Bosques de Amalucan, Puebla, México" && p.countrycodes === "MX"));
});
test("cadena: sin la calle, la colonia (con la nota de qué se encontró y qué no)", async () => {
  const f = fakes({
    nom: p => (p.q && /^Bosques de Amalucan/.test(p.q) ? [nomi({ id: 9, cat: "place", type: "hamlet", at: "hamlet", name: "Bosques de Amalucan Segunda Sección", lat: 19.058, lng: -98.1108, town: "Santa María Xonacatepec", county: "Municipio de Puebla", state: "Puebla" })] : []),
  });
  const r = await run("Calle Bugambilias No. 47, Col.Bosques de Amalucan, Puebla, Pue.", f);
  assert.equal(r.level, "colonia");
  assert.equal(r.note, "Ubiqué la colonia Bosques de Amalucan (Puebla); la calle exacta no figura en OpenStreetMap.");
});
test("cadena: sin calle ni colonia, la ciudad; nunca una calle de otra ciudad", async () => {
  const f = fakes({
    pho: () => ({ features: [phot({ lat: 18.97, lng: -98.27, name: "Calle Bugambilias", city: "San Andrés Cholula", county: "San Andrés Cholula", state: "Puebla" })] }),
    nom: p => (p.q === "Puebla, México" ? [nomi({ id: 5, cat: "boundary", type: "administrative", at: "city", name: "Puebla de Zaragoza", lat: 19.04, lng: -98.2, city: "Puebla de Zaragoza", county: "Municipio de Puebla", state: "Puebla" })] : []),
  });
  const r = await run("Calle Bugambilias No. 47, Col. Lumbreras de Amalucan, Puebla, Pue.", f);
  assert.equal(r.level, "city");
  assert.equal(r.hit.name, "Puebla de Zaragoza");
  assert.equal(r.note, "Ubiqué Puebla; la calle y la colonia no figuran en OpenStreetMap.");
});
test("cadena: el código postal cuando no está la colonia; varias calles con el mismo nombre no se eligen al azar", async () => {
  const calles = [[19.0749, -98.2313, "72130"], [19.0303, -98.1407, "72365"], [19.0204, -98.2207, "72453"]].map(([lat, lng, pc], i) => nomi({ id: 20 + i, lat, lng, road: "Calle Ignacio Aldama", name: "Calle Ignacio Aldama", city: "Puebla de Zaragoza", county: "Municipio de Puebla", state: "Puebla", pc }));
  const f = fakes({ nom: p => (p.postalcode ? [{ ...nomi({ lat: 19.0254, lng: -98.1909, county: "Municipio de Puebla", state: "Puebla", pc: "72540" }), osm_type: undefined, category: "place", type: "postcode", addresstype: "postcode" }] : p.street ? calles : []) });
  const r = await run("Calle Ignacio Aldama No. 109, Col. Insurgentes Oriente, Puebla, C.P. 72540", f);
  assert.equal(r.level, "postcode");
  assert.match(r.note, /^Ubiqué el código postal 72540 \(Puebla\); la calle y la colonia no figuran/);
});
test("cadena: nada de nada → null; si un servicio falló, no se dice que no existe (failed)", async () => {
  assert.equal(await run("Calle Inventada 5, Col. Nada, Ciudadfalsa", fakes()), null);
  const down = fakes({ nom: () => { throw new Error("fetch failed"); }, pho: () => { throw new Error("fetch failed"); } });
  assert.deepEqual(await run("Calle Bugambilias No. 47, Col.Bosques de Amalucan, Puebla, Pue.", down), { failed: true });
});
test("cadena: sin tiempo no se pide más (y tampoco se dice que no existe)", async () => {
  const f = fakes({ nom: () => [], pho: () => ({ features: [] }) });
  // (la ciudad tiene 1,5 s de gracia después del tope: acá ya pasó todo)
  const r = await locateAddress(P("Calle Bugambilias No. 47, Puebla, Pue."), { raw: [], deadline: Date.now() - 2000, ...f });
  assert.deepEqual(r, { failed: true });
  assert.equal(f.calls.length, 0);
});
test("cadena: Google primero si hay clave (y no acepta un resultado de otra ciudad)", async () => {
  const g = (city, lat) => ({ results: [{ types: ["street_address"], formatted_address: "x", geometry: { location: { lat, lng: -98.1 }, location_type: "ROOFTOP" },
    address_components: [{ types: ["street_number"], long_name: "47" }, { types: ["route"], long_name: "Calle Bugambilias" }, { types: ["sublocality_level_1"], long_name: "Lumbreras de Amalucan" }, { types: ["locality"], long_name: city }, { types: ["administrative_area_level_1"], long_name: "Puebla" }, { types: ["country"], long_name: "México", short_name: "MX" }] }] });
  const ok = fakes({ google: () => g("Heroica Puebla de Zaragoza", 19.0523) });
  const r = await run("Calle Bugambilias No. 47, Col. Lumbreras de Amalucan, Puebla, Pue.", ok);
  assert.equal(r.level, "house");
  assert.equal(r.hit.src, "google");
  assert.equal(ok.calls[0][1].cc, "MX");
  const otra = fakes({ google: () => g("Tehuacán", 18.4) });
  const r2 = await run("Calle Bugambilias No. 47, Col. Lumbreras de Amalucan, Puebla, Pue.", otra);
  assert.notEqual(r2?.hit?.src, "google");
});
test("cadena: Colombia, el cruce de las dos calles (Overpass; si no responde, los tramos de Photon)", async () => {
  const calle100 = [nomi({ id: 31, lat: 4.692, lng: -74.0736, road: "Calle 100", name: "Calle 100", city: "Bogotá", state: "Bogotá, Distrito Capital", cc: "co", country: "Colombia" }), nomi({ id: 32, lat: 4.6863, lng: -74.0533, road: "Avenida Calle 100", name: "Avenida Calle 100", city: "Bogotá", state: "Bogotá, Distrito Capital", cc: "co", country: "Colombia" })];
  const f = fakes({ nom: () => calle100, overpass: q => (/Carrera 15/.test(q) ? [{ type: "node", id: 1, lat: 4.68605, lon: -74.04778 }] : []) });
  const r = await locateAddress(P("Calle 100 # 15-20, Bogotá"), { raw: calle100, codes: ["CO", "MX"], deadline: Date.now() + 6000, ...f });
  assert.equal(r.level, "corner");
  assert.equal(r.hit.lat, 4.68605);
  assert.equal(r.note, "Ubiqué Calle 100 a la altura de la Carrera 15.");
  // Overpass caído: por los recuadros de los tramos
  const g = fakes({
    nom: () => calle100, overpass: () => { throw new Error("reset"); },
    pho: p => ({ features: /Carrera 15/.test(p.q) ? [phot({ cc: "CO", country: "Colombia", lat: 4.6854, lng: -74.0478, name: "Avenida Carrera 15", city: "Bogotá", state: "Bogotá, Distrito Capital", extent: [-74.0478288, 4.685612, -74.0477316, 4.6852822] })]
      : /^Calle 100 Bogotá$/.test(p.q) ? [phot({ cc: "CO", country: "Colombia", lat: 4.686, lng: -74.0535, name: "Avenida Calle 100", city: "Bogotá", state: "Bogotá, Distrito Capital", extent: [-74.0549046, 4.6862719, -74.0521592, 4.685779] })] : [] }),
  });
  const r2 = await locateAddress(P("Calle 100 # 15-20, Bogotá"), { raw: calle100, codes: ["CO", "MX"], deadline: Date.now() + 6000, ...g });
  assert.equal(r2.level, "corner");
  assert.ok(Math.abs(r2.hit.lat - 4.686) < 0.001 && Math.abs(r2.hit.lng + 74.0478) < 0.001);
});
test("crossPoint: la latitud de la calle que corre de este a oeste y la longitud de la que corre de norte a sur", () => {
  const A = [{ extent: [-74.0549, 4.6863, -74.0522, 4.6858] }], B = [{ extent: [-74.04783, 4.68561, -74.04773, 4.68528] }];
  const p = crossPoint(A, B);
  assert.ok(Math.abs(p.lat - 4.68605) < 1e-4 && Math.abs(p.lng + 74.04778) < 1e-4);
  assert.equal(crossPoint(A, [{ extent: [-74.0, 4.75, -73.99, 4.74] }]), null, "lejos: no hay cruce");
  assert.match(cornerQuery("Calle 100", "Carrera 15", [{ lat: 4.69, lng: -74.07 }]), /\^\(Avenida \|Av\[\.\]\? \)\?Calle 100\( Bis\)\?\$/);
});
test("notas: con un servicio caído no se dice «no figura»", () => {
  const h = fromPhoton(phot({ lat: 1, lng: 1, name: "Calle Bugambilia", district: "Bosques", city: "Puebla", state: "Puebla" }));
  const a = P("Calle Bugambilias No. 47, Puebla, Pue.");
  assert.equal(noteFor({ hit: h, level: "street" }, a), "Ubiqué Calle Bugambilia (Bosques); el número 47 no figura en OpenStreetMap.");
  assert.equal(noteFor({ hit: h, level: "street" }, a, { partial: true }), "Ubiqué Calle Bugambilia (Bosques); el número 47 no apareció (OpenStreetMap respondió a medias: probá de nuevo en un rato).");
  assert.equal(noteFor({ hit: h, level: "house" }, a, { partial: true }), "");
});
test("Photon: recuadro del país y capas", () => {
  const u = new URL(photonUrl({ q: "Calle Bugambilias 47", layer: ["house", "street"], cc: ["MX"] }, "https://photon.test"));
  assert.equal(u.searchParams.get("bbox"), "-118.6,14.3,-86.5,32.8");
  assert.deepEqual(u.searchParams.getAll("layer"), ["house", "street"]);
  assert.equal(new URL(photonUrl({ q: "x", cc: ["MX", "AR"] }, "https://photon.test")).searchParams.get("bbox"), null);
});
test("Google: el resultado aproximado no cuenta como dirección", () => {
  const h = fromGoogle({ types: ["route"], geometry: { location: { lat: 1, lng: 2 }, location_type: "APPROXIMATE" }, address_components: [{ types: ["country"], short_name: "MX", long_name: "México" }] });
  assert.equal(h.approx, true);
  assert.equal(h.level, "street");
});
