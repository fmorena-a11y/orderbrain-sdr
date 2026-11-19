// Padrones oficiales (lib/padron.js): filtro de privados, agrupación de niveles, normalización y unión con la base.
// Datos inventados con el formato exacto de cada fuente en test/fixtures/padron-*.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import zlib from "zlib";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import * as P from "../lib/padron.js";
import { buildIndex, addTo } from "../lib/scan.js";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const FX = path.join(DIR, "fixtures");
const json = f => JSON.parse(fs.readFileSync(path.join(FX, f), "utf8"));
const LIMA = [{ name: "Lima", lat: -12.04598, lng: -77.03059, pop: 9989369 }, { name: "Trujillo", lat: -8.11168, lng: -79.02877, pop: 919899 }, { name: "Cuzco", lat: -13.51709, lng: -71.97854, pop: 428450 }];

// ---------- archivos
// DBF mínimo (dBase III) en cp850, como el Padron_web.dbf de ESCALE
const CP850 = "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒáíóúñÑªº¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐└┴┬├─┼ãÃ╚╔╩╦╠═╬¤ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀ÓßÔÒõÕµþÞÚÛÙýÝ¯´­±‗¾¶§÷¸°¨·¹³²■ ";
const enc850 = s => Buffer.from([...s].map(c => c.charCodeAt(0) < 128 ? c.charCodeAt(0) : 128 + CP850.indexOf(c)));
function dbf(fields, rows, { deleted = [] } = {}) {
  const rlen = 1 + fields.reduce((a, f) => a + f[1], 0), hlen = 32 + fields.length * 32 + 1;
  const b = Buffer.alloc(hlen + rows.length * rlen + 1);
  b[0] = 0x03; b.writeUInt32LE(rows.length, 4); b.writeUInt16LE(hlen, 8); b.writeUInt16LE(rlen, 10); b[29] = 0x02;
  fields.forEach(([name, len], i) => { b.write(name, 32 + i * 32, "latin1"); b[32 + i * 32 + 11] = 67; b[32 + i * 32 + 16] = len; });
  b[hlen - 1] = 0x0d;
  rows.forEach((r, i) => {
    let at = hlen + i * rlen; b[at++] = deleted.includes(i) ? 0x2a : 0x20;
    fields.forEach(([name, len]) => { const v = enc850(String(r[name] ?? "")); b.fill(0x20, at, at + len); v.copy(b, at, 0, Math.min(len, v.length)); if (name === "TELEFONO") b[at + len - 1] = 0; at += len; });
  });
  return b;
}
function zip(name, data) {
  const c = zlib.deflateRawSync(data), n = Buffer.from(name);
  const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(c.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(n.length, 26);
  const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(8, 10); cd.writeUInt32LE(c.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(n.length, 28); cd.writeUInt32LE(0, 42);
  const off = 30 + n.length + c.length;
  const e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(1, 8); e.writeUInt16LE(1, 10); e.writeUInt32LE(46 + n.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([lh, n, c, cd, n, e]);
}

test("DBF en cp850 dentro de un zip: acentos bien, bytes NUL fuera, filas borradas fuera y filtro temprano", () => {
  const fields = [["COD_MOD", 7], ["CEN_EDU", 40], ["GESTION", 1], ["NIV_MOD", 2], ["TELEFONO", 12]];
  const rows = [{ COD_MOD: "1", CEN_EDU: "JARDÍN NIÑO JESÚS", GESTION: "3", NIV_MOD: "A2", TELEFONO: "4567890" }, { COD_MOD: "2", CEN_EDU: "BORRADA", GESTION: "3", NIV_MOD: "B0" }, { COD_MOD: "3", CEN_EDU: "PÚBLICA", GESTION: "1", NIV_MOD: "B0" }];
  const z = P.unzip(zip("Padron_web.dbf", dbf(fields, rows, { deleted: [1] })));
  const out = P.readDbf(z.get("Padron_web.dbf")(), { keep: r => r.GESTION === "3" });
  assert.deepEqual(out, [{ COD_MOD: "1", CEN_EDU: "JARDÍN NIÑO JESÚS", GESTION: "3", NIV_MOD: "A2", TELEFONO: "4567890" }]);
});

test("CSV: comillas, separador ; y BOM", () => {
  assert.deepEqual(P.parseCsv('﻿a;b\n"x;1";"di ""y"""\n'), [{ a: "x;1", b: 'di "y"' }]);
  assert.deepEqual(P.parseCsv("a,b\r\n1,2\r\n"), [{ a: "1", b: "2" }]);
});

// ---------- texto, teléfonos, direcciones
test("nombres en el formato de la base", () => {
  assert.equal(P.titleText("COLEGIO SAN JOSE DE LA MONTAÑA"), "Colegio San José de la Montaña");
  assert.equal(P.titleText("Colegio ya escrito"), "Colegio ya escrito");
  assert.equal(P.namePE("I.E.P. EL PRINCIPITO"), "IEP El Principito");
  assert.equal(P.namePE("SANTA ROSA DE LAS FLORES"), "IEP Santa Rosa de las Flores");
  assert.equal(P.namePE("COLEGIO MARKHAM"), "Colegio Markham");
  assert.equal(P.namePE("CUNA JARDIN LOS PITUFOS"), "Cuna Jardín Los Pitufos");
  assert.equal(P.nameCO("GIMN CAMPESTRE LAS ACACIAS"), "Gimnasio Campestre Las Acacias");
  assert.equal(P.nameCO("JARD INF LA CASITA DE CHENANO"), "Jardín Infantil La Casita de Chenano");
  assert.deepEqual(P.coreTokens("IEP San Agustín"), P.coreTokens("Colegio San Agustin"));
});

test("teléfonos limpios por país", () => {
  assert.equal(P.phonePE("01-4567890", "LIMA"), "+51 1 4567890");
  assert.equal(P.phonePE("987654321 / 4567890", "LIMA"), "+51 987 654 321");
  assert.equal(P.phonePE("044-234567", "LA LIBERTAD"), "+51 44 234567");
  assert.equal(P.phonePE("234567", "PIURA"), "+51 73 234567");
  assert.equal(P.phonePE("S/N", "PIURA"), "");
  assert.equal(P.phoneCO("3042920744 - 3224956282", "76"), "+57 304 292 0744");
  assert.equal(P.phoneCO("4366460  /2521545", "11"), "+57 601 4366460");
  assert.equal(P.phoneCO("6023860211", "76"), "+57 602 3860211");
  assert.equal(P.phoneMX("(222) 285 0575"), "+52 222 285 0575");
  assert.equal(P.phoneMX("01 55 5678 1234"), "+52 555 678 1234");
});

test("mails y webs: el primero que sirve", () => {
  assert.equal(P.cleanMail("1ºugimna@hotmail.com   gimna@hotmail.com"), "gimna@hotmail.com");
  assert.equal(P.cleanMail("NO TIENE"), "");
  assert.equal(P.cleanMail("Rectoria@Colegio.EDU.CO"), "rectoria@colegio.edu.co");
  assert.equal(P.cleanWeb("www.colegio.edu.pe"), "https://www.colegio.edu.pe");
  assert.equal(P.cleanWeb("facebook.com/colegio"), "");
});

test("direcciones de Colombia como las lee la app («Calle 85 # 27-50»)", () => {
  assert.equal(P.addressCO("CL 85 27 50"), "Calle 85 # 27-50");
  assert.equal(P.addressCO("KR 90 A 91 96"), "Carrera 90 A # 91-96");
  assert.equal(P.addressCO("IND TRANSV. 101 NO. 26 O - 18"), "Transversal 101 # 26O-18");
  assert.equal(P.addressCO("KM 1 VIA PANTANO DE VARGAS"), "Km 1 Via Pantano de Vargas");
});

test("ciudad: Lima y Callao son «Lima»; si no, la ciudad del radar; si no, el distrito", () => {
  assert.equal(P.cityPE({ D_PROV: "CALLAO", D_DIST: "BELLAVISTA", lat: -12.06, lng: -77.11 }, LIMA), "Lima");
  assert.equal(P.cityPE({ D_PROV: "TRUJILLO", D_DIST: "VICTOR LARCO HERRERA", lat: -8.13, lng: -79.04 }, LIMA), "Trujillo");
  assert.equal(P.cityPE({ D_PROV: "CUSCO", D_DIST: "SAN SEBASTIAN", lat: -13.53, lng: -71.94 }, LIMA), "Cuzco");
  assert.equal(P.cityPE({ D_PROV: "HUAURA", D_DIST: "HUACHO", lat: -11.1, lng: -77.6 }, LIMA), "Huacho");
  const base = new Map([["cartagena de indias", "Cartagena de Indias"], ["bogota", "Bogotá"], ["cucuta", "Cúcuta"]]);
  assert.equal(P.cityByName("Bogotá, D.C.", base), "Bogotá");
  assert.equal(P.cityByName("Cartagena", base), "Cartagena de Indias");
  assert.equal(P.cityByName("SAN JOSE DE CUCUTA", base), "Cúcuta");
  assert.equal(P.cityByName("Soledad", base), "Soledad");
});

// ---------- Perú
test("Perú: solo privados activos escolarizados de inicial, primaria o secundaria, y un colegio por plantel", () => {
  const rows = P.parseCsv(fs.readFileSync(path.join(FX, "padron-pe.csv"), "utf8"));
  const kept = rows.filter(P.keepPE).map(r => r.COD_MOD);
  // fuera: pública (5), pública de gestión privada (6), CETPRO (7), PRONOEI (8), inactiva (9)
  assert.deepEqual(kept, ["1700001", "1700002", "1700003", "1700004", "1700010"]);
  const g = P.groupPE(rows, { radarCities: LIMA });
  assert.equal(g.length, 3);
  const sr = g.find(x => x.code === "1700003");
  assert.equal(sr.name, "IEP Santa Rosa de las Flores");
  assert.deepEqual([...sr.levels].sort(), ["Preescolar", "Primaria", "Secundaria"]);
  assert.deepEqual(sr.codes.sort(), ["1700001", "1700002", "1700003"]);
  assert.equal(sr.city, "Lima");
  assert.equal(sr.addr, "Av. Los Alamos 123, Miraflores");
  assert.equal(sr.phone, "+51 987 654 321");
  assert.equal(sr.email, "informes@santarosaflores.edu.pe");
  assert.equal(sr.web, "https://www.santarosaflores.edu.pe");
  const tr = g.find(x => x.code === "1700004");
  assert.equal(tr.city, "Trujillo"); assert.equal(tr.phone, "+51 44 234567"); assert.equal(tr.name, "IEP El Principito del Norte");
  // sin coordenadas: queda sin punto hasta placeMissing (centro de su ciudad, marcado aproximado)
  const pi = g.find(x => x.code === "1700010");
  assert.equal(pi.lat, undefined); assert.equal(pi.city, "Piura");
  P.placeMissing(g, new Map([["piura", { lat: -5.19, lng: -80.62 }]]));
  assert.equal(pi.approx, "ciudad"); assert.equal(pi.lat, -5.19);
});

// ---------- Colombia
function coGroups(base = []) {
  return P.groupCO(json("padron-co/establecimientos.json"), {
    sedes: new Map(json("padron-co/sedes.json").map(s => [s.codigo_dane, s])),
    niveles: new Map(json("padron-co/niveles.json").map(n => [n.codigoestablecimiento, n])),
    munis: new Map(json("padron-co/municipios.json").map(m => [m.cod_mpio, m])),
    baseCities: P.baseCityMap(base, "Colombia"),
  });
}
test("Colombia: no oficiales, sin los de adultos; punto de la sede (≈1 km) o centro del municipio", () => {
  const g = coGroups([{ country: "Colombia", city: "Bogotá" }]);
  assert.deepEqual(g.map(x => x.code), ["376001990001", "311001990002"]);
  const [cali, bog] = g;
  assert.equal(cali.name, "Colegio Los Almendros del Sur");
  assert.deepEqual(cali.levels, ["Preescolar", "Primaria", "Secundaria"]);
  assert.equal(cali.approx, "1km"); assert.equal(cali.lat, 3.46); assert.equal(cali.city, "Cali");
  assert.equal(cali.addr, "Calle 85 # 27-50, Alfonso Bonilla Aragon");
  assert.equal(cali.phone, "+57 304 292 0744"); assert.equal(cali.students, 274);
  // sede en 0,0: el centro de Bogotá
  assert.equal(bog.approx, "ciudad"); assert.equal(bog.lat, 4.649251); assert.equal(bog.city, "Bogotá");
  assert.equal(bog.email, "gimnacacias@hotmail.com"); assert.deepEqual(bog.levels, []);
});

// ---------- México
test("México: privados activos de preescolar a media superior; niveles del mismo plantel juntos; CDMX es «Ciudad de México»", () => {
  const rows = P.parseCsv(fs.readFileSync(path.join(FX, "padron-mx.csv"), "utf8"));
  const radar = [{ name: "Ciudad de México", lat: 19.43263, lng: -99.13318, pop: 9209944 }, { name: "Puebla de Zaragoza", lat: 19.0438, lng: -98.19815, pop: 1542232 }];
  const g = P.groupMX(rows, { radarCities: radar });
  assert.deepEqual(g.map(x => x.name).sort(), ["Colegio Arcoiris del Sur", "Instituto Valle de los Volcanes"]);
  const a = g.find(x => x.name === "Colegio Arcoiris del Sur");
  assert.deepEqual([...a.levels].sort(), ["Preescolar", "Primaria", "Secundaria"]);
  assert.equal(a.city, "Ciudad de México");
  assert.equal(a.addr, "Calle Genaro Garcia 125, Col. Del Carmen, Coyoacan, C.P. 04100");
  assert.equal(a.phone, "+52 555 678 1234"); assert.equal(a.web, "https://www.arcoirisdelsur.edu.mx");
  const p = g.find(x => x.name === "Instituto Valle de los Volcanes");
  assert.deepEqual(p.levels, ["Prepa"]); assert.equal(p.city, "Puebla de Zaragoza"); assert.equal(p.code, "21PBH9004D");
  // la clave dice privado («P») aunque falte el control; superior y CAM, fuera
  assert.equal(P.keepMX(P.mxRow({ CLAVECCT: "09PPR0001X", NOMBRECT: "COLEGIO X", NOMBRENIV: "PRIMARIA" })), true);
  assert.equal(P.levelMX({ tipoedu: "SUPERIOR", nivel: "LICENCIATURA" }), "");
  assert.equal(P.levelMX({ tipoedu: "ESPECIAL", nivel: "CAM" }), "");
});

// ---------- unir con la base
const base = () => [
  { id: "lima-colegio-santa-rosa-de-las-flores", name: "Colegio Santa Rosa de las Flores", city: "Lima", country: "Perú", lat: -12.1205, lng: -77.0305, addr: "", phone: "+51 1 9999999", web: "", email: "", levels: [], src: "osm", osm: "n1" },
  { id: "trujillo-colegio-el-principito", name: "Colegio El Principito del Norte Trujillo", city: "Trujillo", country: "Perú", lat: -8.1112, lng: -79.0292, addr: "Jr. Bolívar", phone: "", web: "", email: "", levels: [], src: "osm", osm: "n2" },
];
test("unión: mismo colegio por nombre propio y cercanía completa SOLO campos vacíos; parecido no se toca; lo nuevo se suma", () => {
  const rows = P.parseCsv(fs.readFileSync(path.join(FX, "padron-pe.csv"), "utf8"));
  const g = P.groupPE(rows, { radarCities: LIMA });
  P.placeMissing(g, new Map([["piura", { lat: -5.19, lng: -80.62 }]]));
  const schools = base();
  const p = P.plan(schools, g, { country: "Perú", src: "ESCALE MINEDU", today: "2026-11-19" });
  assert.equal(p.stats.exact, 1);       // Santa Rosa
  assert.equal(p.stats.similar, 1);     // «El Principito del Norte» ≈ «El Principito del Norte Trujillo»: no se suma ni se toca
  assert.equal(p.stats.add, 1);         // Los Pinos del Valle (Piura)
  const f = p.fills[0];
  assert.equal(f.x.osm, "n1");
  assert.equal(f.set.phone, undefined); // ya tenía teléfono: no se pisa
  assert.equal(f.set.email, "informes@santarosaflores.edu.pe");
  assert.equal(f.set.addr, "Av. Los Alamos 123, Miraflores");
  assert.equal(f.set.code, "1700003"); assert.equal(f.set.padron, "ESCALE MINEDU");
  const idx = buildIndex(schools);
  const { added } = P.applyPlan(schools, p, { addTo, idx });
  assert.equal(added.length, 1);
  const r = added[0];
  assert.equal(r.id, "piura-iep-los-pinos-del-valle");
  assert.equal(r.src, "ESCALE MINEDU"); assert.equal(r.private, "seguro"); assert.equal(r.approx, "ciudad"); assert.equal(r.found, "2026-11-19");
  assert.ok(r.opp.includes("Privado según el padrón oficial"));
  assert.equal(schools[0].email, "informes@santarosaflores.edu.pe");
  // correrlo otra vez no suma nada: todo se reconoce por el código oficial
  const again = P.plan(schools, g, { country: "Perú", src: "ESCALE MINEDU" });
  assert.equal(again.stats.add, 0); assert.equal(again.stats.byCode, 2); assert.equal(again.fills.length, 0);
});

test("unión: un colegio de la base se empareja con uno solo (el segundo «San José» de la ciudad es otro)", () => {
  const schools = [{ id: "x", name: "Colegio San José", city: "Bogotá", country: "Colombia", lat: 4.65, lng: -74.1, addr: "", phone: "", web: "", email: "", levels: [] }];
  const g = [
    { name: "Colegio San José", city: "Bogotá", lat: 4.66, lng: -74.1, approx: "1km", levels: [], code: "A" },
    { name: "Colegio San José", city: "Bogotá", lat: 4.651, lng: -74.1, approx: "1km", levels: [], code: "B", phone: "+57 601 1234567" },
  ];
  const p = P.plan(schools, g, { country: "Colombia", src: "MEN datos.gov.co" });
  assert.equal(p.stats.exact, 1); assert.equal(p.stats.add, 1);
  assert.equal(p.fills[0].set.code, "B");            // el más cercano
  assert.equal(p.add[0].rec.code, "A");
  // lo que el radar marcó como no privado no tapa a un colegio del padrón
  const hidden = [{ ...schools[0], private: "no" }];
  assert.equal(P.plan(hidden, g.slice(0, 1), { country: "Colombia", src: "x" }).stats.add, 1);
});

test("prioridad y tope: primero ciudades con colegios, con teléfono o mail, más niveles y alumnos", () => {
  const counts = new Map([["lima", 500]]);
  const a = P.priority({ city: "Lima", phone: "1", email: "a@b.co", levels: ["Primaria", "Secundaria"], students: 600 }, counts);
  const b = P.priority({ city: "Huacho", levels: ["Preescolar"] }, counts);
  const c = P.priority({ city: "Lima", levels: [], approx: "ciudad" }, counts);
  assert.ok(a > c && c > b, `${a} ${c} ${b}`);
  const schools = [{ id: "s", name: "Colegio Uno", city: "Lima", country: "Perú", lat: -12, lng: -77 }];
  const recs = [{ rec: { name: "IEP Dos", city: "Huacho", country: "Perú", lat: -11, lng: -77, levels: [] } }, { rec: { name: "IEP Tres", city: "Lima", country: "Perú", lat: -12.1, lng: -77, phone: "x", levels: ["Primaria"] } }];
  const { added, left } = P.applyPlan(schools, { add: recs, fills: [] }, { max: 1, addTo, idx: buildIndex(schools) });
  assert.deepEqual(added.map(r => r.name), ["IEP Tres"]); assert.deepEqual(left.map(x => x.rec.name), ["IEP Dos"]);
  assert.ok(P.listBytes(schools) > 100);
});

test("el script: --dry con el padrón de muestra de Perú y --out escribe una base válida", () => {
  const out = path.join(os.tmpdir(), `padron-${process.pid}.json`);
  const run = a => execFileSync(process.execPath, [path.join(DIR, "..", "scripts", "padron.mjs"), "--country", "PE", "--file", path.join(FX, "padron-pe.csv"), ...a], { encoding: "utf8" });
  const dry = run(["--dry"]);
  assert.match(dry, /5 servicios privados activos/);
  assert.match(dry, /--dry: no se escribe nada/);
  run(["--out", out, "--max", "10"]);
  const after = JSON.parse(fs.readFileSync(out, "utf8"));
  const orig = JSON.parse(fs.readFileSync(path.join(DIR, "..", "data", "schools.json"), "utf8"));
  assert.ok(after.length >= orig.length && after.length <= orig.length + 3);
  assert.ok(after.some(s => s.src === "ESCALE MINEDU" || s.padron === "ESCALE MINEDU"));
  fs.unlinkSync(out);
});
