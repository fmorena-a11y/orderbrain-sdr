#!/usr/bin/env node
// Padrones oficiales → data/schools.json: suma los colegios PRIVADOS (inicial/preescolar, primaria, secundaria o media)
// que faltan en la base y completa campos vacíos de los que ya están, sin duplicar (reglas en lib/padron.js).
//
// Fuentes:
//  - PE: Padrón web de instituciones educativas de ESCALE (MINEDU), un zip con Padron_web.dbf (cp850, ≈180.000 filas):
//        https://escale.minedu.gob.pe/documents/10156/958881/Padron_web_<AAAAMMDD>.zip (cortes semanales, listados en
//        https://escale.minedu.gob.pe/listadosrie/). ESCALE puede pedir una verificación de navegador (Check Point): en ese
//        caso bajá el zip a mano y pasalo con --file (o subilo a un link y pasalo con --url / el input del workflow).
//  - CO: MEN en datos.gov.co (Socrata, sin clave; SOCRATA_APP_TOKEN opcional):
//        establecimientos cfw5-qzt5 (MEN_ESTABLECIMIENTOS_EDUCATIVOS_PREESCOLAR_BÁSICA_Y_MEDIA, el último año, NO_OFICIAL),
//        sedes x5ay-984n (coordenadas de la sede principal, 2019, 2 decimales), niveles upkm-vdjb (2016) y municipios
//        DIVIPOLA gdxc-w37w (centro de cada municipio, para los que no traen punto).
//  - MX: Catálogo de Centros de Trabajo de la SEP (CSV de https://www.datos.gob.mx/dataset/catalogo_centros_trabajo_sep,
//        nacional o por estado). datos.gob.mx bloquea algunos servidores: --file / --url si hace falta.
//
// Uso: node scripts/padron.mjs --country PE|CO|MX [--dry] [--file <zip|dbf|csv|json|carpeta>] [--url <link>]
//        [--cache <carpeta>] [--download-only] [--limit N] [--max N] [--no-inicial] [--out <archivo>] [--summary <archivo>]
//  --max: cuántos colegios nuevos sumar como mucho (los de más prioridad: ciudades donde ya hay colegios, con teléfono o
//         mail, más niveles y más alumnos). Por defecto, lo que falta para llegar a PADRON_CAP (35.000) colegios visibles.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { buildIndex, addTo, notSchool, norm } from "../lib/scan.js";
import * as P from "../lib/padron.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCHOOLS_FILE = path.join(ROOT, "data", "schools.json");
const STATE_FILE = path.join(ROOT, "data", "radar", "state.json");
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf("--" + k); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d; };
const flag = k => argv.includes("--" + k);
const env = process.env;
const CC = String(arg("country", env.PADRON_COUNTRY || "")).toUpperCase();
const DRY = flag("dry");
const LIMIT = Number(arg("limit", 0)) || 0;
const CAP = Number(env.PADRON_CAP || 35000);
const today = new Date().toISOString().slice(0, 10);
const COUNTRY = { PE: "Perú", CO: "Colombia", MX: "México" };
const SRC = { PE: "ESCALE MINEDU", CO: "MEN datos.gov.co", MX: "SEP CCT" };
const log = (...a) => console.log(...a);
const fmt = n => Number(n).toLocaleString("es-AR");

// ---------- descargas
const UA = { "user-agent": "OrderBrain-Padron/1.0 (school directory import)" };
async function get(url, { tries = 3, timeout = 180e3, headers = {} } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { ...UA, ...headers }, signal: AbortSignal.timeout(timeout), redirect: "follow" });
      if (!r.ok) throw Object.assign(new Error(`${url} respondió ${r.status}`), { status: r.status });
      return Buffer.from(await r.arrayBuffer());
    } catch (e) { last = e; if (e.status && e.status < 500 && e.status !== 429) break; await new Promise(r => setTimeout(r, 3000 * (i + 1))); }
  }
  throw last;
}
const isChallenge = buf => /cp-solve-challenge|Check Point CloudGuard|Security Verification/i.test(buf.subarray(0, 20000).toString("latin1"));
const isZip = buf => buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50;
const cachePath = name => { const d = arg("cache", ""); return d ? path.join(d, name) : ""; };
async function cached(name, fetcher) {
  const f = cachePath(name);
  if (f && fs.existsSync(f)) { log(`(uso ${f})`); return fs.readFileSync(f); }
  const buf = await fetcher();
  if (f) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, buf); }
  return buf;
}

// Perú: el corte más nuevo de Padron_web_AAAAMMDD.zip
const ESCALE = "https://escale.minedu.gob.pe";
const decodeEnt = s => s.replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCharCode(parseInt(h, 16))).replace(/&#(\d+);/g, (m, d) => String.fromCharCode(d)).replace(/&amp;/g, "&");
async function peZip() {
  const direct = arg("url", env.PADRON_PE_URL || "");
  if (direct) { const b = await get(direct); if (!isZip(b)) throw new Error(`${direct} no es un zip`); return b; }
  const blocked = () => new Error("ESCALE pide una verificación de navegador (Check Point) y no deja bajar el padrón desde este servidor. Bajá el zip desde " + ESCALE + "/listadosrie/ en un navegador y corré con --file <zip>, o subilo a un link y pasalo con --url.");
  const links = new Set();
  try {
    const html = decodeEnt((await get(`${ESCALE}/listadosrie/`, { tries: 2, timeout: 30e3 })).toString("utf8"));
    if (/cp-solve-challenge|Security Verification/.test(html)) throw blocked();
    for (const m of html.matchAll(/\/documents\/10156\/958881\/Padron_web_\d{8}\.zip/g)) links.add(ESCALE + m[0]);
    // páginas intermedias de Liferay (el id más alto es el corte más nuevo)
    if (!links.size) {
      const pages = [...new Set([...html.matchAll(/href="([^"]*listadosrie[^"]*?(\d{5,})[^"]*)"/g)].map(m => [m[1], +m[2]]))].sort((a, b) => b[1] - a[1]).slice(0, 3);
      for (const [href] of pages) {
        const sub = decodeEnt((await get(new URL(href, ESCALE).href, { tries: 1, timeout: 30e3 })).toString("utf8"));
        for (const m of sub.matchAll(/\/documents\/10156\/958881\/Padron_web_\d{8}\.zip/g)) links.add(ESCALE + m[0]);
      }
    }
  } catch (e) { if (/verificación/.test(e.message)) throw e; log("no pude leer el listado de cortes:", e.message); }
  // si no, los nombres siguen la fecha del corte: se prueban los últimos 60 días
  const tries = [...links].sort().reverse();
  if (!tries.length) for (let d = 0; d < 60; d++) tries.push(`${ESCALE}/documents/10156/958881/Padron_web_${new Date(Date.now() - d * 864e5).toISOString().slice(0, 10).replace(/-/g, "")}.zip`);
  for (const u of tries) {
    try { const b = await get(u, { tries: 1 }); if (isZip(b)) { log("padrón:", u); return b; } if (isChallenge(b)) throw blocked(); } catch (e) { if (/verificación/.test(e.message)) throw e; }
  }
  throw new Error("no encontré el zip del padrón en ESCALE (probá con --url o --file)");
}
function peRows(buf, name = "") {
  const keep = r => P.keepPE(r);
  const fromDbf = b => P.readDbf(b, { fields: P.PE_FIELDS, keep, encoding: arg("encoding", "") || undefined });
  if (isZip(buf)) {
    const z = P.unzip(buf), dbf = [...z.keys()].find(n => /padron.*\.dbf$/i.test(n)) || [...z.keys()].find(n => /\.dbf$/i.test(n));
    if (dbf) return fromDbf(z.get(dbf)());
    const csv = [...z.keys()].find(n => /\.csv$/i.test(n)); if (csv) return P.parseCsv(P.textOf(z.get(csv)())).filter(keep);
    throw new Error("el zip no tiene Padron_web.dbf");
  }
  if (/\.dbf$/i.test(name) || buf[0] === 0x03 || buf[0] === 0x83) return fromDbf(buf);
  return P.parseCsv(P.textOf(buf)).filter(keep);
}

// Colombia: Socrata
const SODA = "https://www.datos.gov.co/resource";
async function soda(id, params) {
  const out = [];
  for (let off = 0; ; off += 50000) {
    const q = new URLSearchParams({ ...params, $limit: "50000", $offset: String(off), $order: ":id" });
    const page = JSON.parse((await get(`${SODA}/${id}.json?${q}`, { headers: env.SOCRATA_APP_TOKEN ? { "X-App-Token": env.SOCRATA_APP_TOKEN } : {} })).toString("utf8"));
    out.push(...page);
    if (page.length < 50000) return out;
  }
}
async function coData() {
  const file = arg("file", "");
  const read = async (name, fetcher) => {
    if (file && fs.statSync(file).isDirectory() && fs.existsSync(path.join(file, name))) return JSON.parse(fs.readFileSync(path.join(file, name), "utf8"));
    if (file && !fs.statSync(file).isDirectory()) { if (name === "establecimientos.json") return /\.json$/i.test(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : P.parseCsv(P.textOf(fs.readFileSync(file))); }
    return JSON.parse((await cached(name, async () => Buffer.from(JSON.stringify(await fetcher())))).toString("utf8"));
  };
  const est = await read("establecimientos.json", async () => {
    const [{ max_a_o: year }] = JSON.parse((await get(`${SODA}/cfw5-qzt5.json?$select=max(a_o)%20as%20max_a_o`)).toString("utf8"));
    log(`MEN: establecimientos de ${year}`);
    return soda("cfw5-qzt5", { $where: `sector='NO_OFICIAL' AND a_o='${year}'` });
  });
  const opt = async (name, fetcher) => { try { return await read(name, fetcher); } catch (e) { log(`sin ${name}: ${e.message}`); return []; } };
  const sedes = await opt("sedes.json", () => soda("x5ay-984n", { $where: "cte_id_sector='NO OFICIAL' AND principal='S'", $select: "codigo_dane,coordenada_x_sede,coordenada_y_sede,direccion,telefono" }));
  const niveles = await opt("niveles.json", () => soda("upkm-vdjb", { $where: "codigoestablecimiento >= 300000000000", $select: "codigoestablecimiento,niveles,modelos_educativos" }));
  const munis = await opt("municipios.json", () => soda("gdxc-w37w", {}));
  return {
    rows: est,
    sedes: new Map(sedes.map(s => [String(s.codigo_dane), s])),
    niveles: new Map(niveles.map(n => [String(n.codigoestablecimiento), n])),
    munis: new Map(munis.map(m => [String(m.cod_mpio).padStart(5, "0"), m])),
  };
}

// México: CSV del catálogo (CKAN de datos.gob.mx: el recurso nacional, o todos los estatales)
async function mxRows() {
  const file = arg("file", "");
  const parse = (buf, name) => {
    if (isZip(buf)) { const z = P.unzip(buf); return [...z.keys()].filter(n => /\.csv$/i.test(n)).flatMap(n => P.parseCsv(P.textOf(z.get(n)()))); }
    return /\.json$/i.test(name) ? JSON.parse(buf.toString("utf8")) : P.parseCsv(P.textOf(buf));
  };
  if (file) {
    if (fs.statSync(file).isDirectory()) return fs.readdirSync(file).filter(n => /\.(csv|zip|json)$/i.test(n)).flatMap(n => parse(fs.readFileSync(path.join(file, n)), n));
    return parse(fs.readFileSync(file), file);
  }
  const direct = arg("url", env.PADRON_MX_URL || "");
  if (direct) return parse(await cached("mx-" + path.basename(new URL(direct).pathname), () => get(direct)), direct);
  const meta = JSON.parse((await get("https://www.datos.gob.mx/api/3/action/package_show?id=catalogo_centros_trabajo_sep", { tries: 2, timeout: 30e3 })).toString("utf8")).result;
  const res = (meta.resources || []).filter(r => /csv|zip/i.test(r.format || r.url));
  const nat = res.filter(r => /nacional/i.test(r.name || "")).sort((a, b) => String(b.last_modified || b.created).localeCompare(String(a.last_modified || a.created)));
  const pick = nat.length ? [nat[0]] : res;
  log(`SEP: ${pick.length} archivo(s) del catálogo`);
  const rows = [];
  for (const r of pick) rows.push(...parse(await cached("mx-" + path.basename(new URL(r.url).pathname), () => get(r.url)), r.url));
  return rows;
}

// ---------- corrida
async function main() {
  if (!COUNTRY[CC]) { console.error("Uso: node scripts/padron.mjs --country PE|CO|MX [--dry] [--file …] [--max N]"); process.exit(2); }
  const country = COUNTRY[CC], src = SRC[CC];
  let groups, schools;
  if (CC === "PE") {
    const file = arg("file", "");
    const buf = file ? fs.readFileSync(file) : await cached("padron-pe.zip", peZip);
    if (flag("download-only")) return log("descargado");
    schools = JSON.parse(fs.readFileSync(SCHOOLS_FILE, "utf8"));
    const rows = peRows(buf, file);
    log(`ESCALE: ${fmt(rows.length)} servicios privados activos de inicial, primaria o secundaria`);
    const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    groups = P.groupPE(rows, { radarCities: state.cities?.PE || [], baseCities: P.baseCityMap(schools, country) });
    P.placeMissing(groups, P.cityCenters(schools, country, state.cities?.PE || []));
  } else if (CC === "CO") {
    const d = await coData();
    if (flag("download-only")) return log("descargado");
    schools = JSON.parse(fs.readFileSync(SCHOOLS_FILE, "utf8"));
    log(`MEN: ${fmt(d.rows.length)} establecimientos no oficiales`);
    groups = P.groupCO(d.rows, { ...d, baseCities: P.baseCityMap(schools, country) });
    P.placeMissing(groups, P.cityCenters(schools, country, []));
  } else {
    const rows = await mxRows();
    if (flag("download-only")) return log("descargado");
    schools = JSON.parse(fs.readFileSync(SCHOOLS_FILE, "utf8"));
    const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    log(`SEP: ${fmt(rows.length)} centros de trabajo en el archivo`);
    groups = P.groupMX(rows, { radarCities: state.cities?.MX || [], baseCities: P.baseCityMap(schools, country) });
    P.placeMissing(groups, P.cityCenters(schools, country, state.cities?.MX || []));
  }
  const allGroups = groups.length;
  if (flag("no-inicial")) groups = groups.filter(g => !g.levels.length || g.levels.some(l => l !== "Preescolar"));
  if (LIMIT) groups = groups.slice(0, LIMIT);
  log(`${fmt(allGroups)} colegios (niveles del mismo plantel juntos)${groups.length !== allGroups ? `, ${fmt(groups.length)} después de filtros` : ""}; solo preescolar/inicial: ${fmt(groups.filter(g => g.levels.length && g.levels.every(l => l === "Preescolar")).length)}`);

  const visible = list => list.filter(s => s.private !== "no" && !notSchool(norm(s.name)));
  const before = visible(schools), bytesBefore = P.listBytes(before);
  const p = P.plan(schools, groups, { country, src, today });
  const room = Math.max(0, CAP - before.length);
  const max = arg("max", "") !== "" ? Math.max(0, Number(arg("max"))) : room;
  const idx = buildIndex(schools);
  const { added, left } = P.applyPlan(schools, p, { max, addTo, idx });
  const after = visible(schools), bytesAfter = P.listBytes(after);

  const s = p.stats;
  log(`\nResultado (${country}${DRY ? ", --dry: no se escribe nada" : ""}):`);
  log(`  ya estaban: ${fmt(s.byCode)} por código oficial, ${fmt(s.exact)} por nombre y lugar (se completaron campos vacíos en ${fmt(s.filled)}), ${fmt(s.similar)} parecidos que no se tocan`);
  log(`  nuevos: ${fmt(s.add)}; se suman ${fmt(added.length)}${left.length ? ` (tope ${fmt(max)}: quedan ${fmt(left.length)} para otra vez)` : ""}`);
  log(`  sin ubicar (sin punto ni ciudad conocida, no se suman): ${fmt(s.noPoint)}; descartados por el nombre: ${fmt(s.notSchool)}`);
  log(`  con punto aproximado: ${fmt(added.filter(r => r.approx === "1km").length)} a ≈1 km, ${fmt(added.filter(r => r.approx === "ciudad").length)} en el centro de su ciudad`);
  log(`  con teléfono ${fmt(added.filter(r => r.phone).length)}, con mail ${fmt(added.filter(r => r.email).length)}`);
  log(`  colegios visibles: ${fmt(before.length)} → ${fmt(after.length)}; /api/schools ≈ ${fmt(bytesBefore)} → ${fmt(bytesAfter)} bytes sin comprimir`);
  const byCity = new Map(); for (const r of added) byCity.set(r.city, (byCity.get(r.city) || 0) + 1);
  log("  por ciudad:", [...byCity].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([c, n]) => `${c} ${n}`).join(", "));
  const sample = [...added].sort(() => Math.random() - 0.5).slice(0, 10);
  log("  muestra:"); for (const r of sample) log(`   - ${r.code} · ${r.name} · ${r.city} · ${r.addr} · ${r.phone || "sin teléfono"} · ${r.levels.join("/") || "sin niveles"}${r.approx ? ` · punto ${r.approx}` : ""}`);
  const summary = { country, src, groups: allGroups, ...s, added: added.length, left: left.length, visible: [before.length, after.length], bytes: [bytesBefore, bytesAfter], byCity: Object.fromEntries([...byCity].sort((a, b) => b[1] - a[1]).slice(0, 20)) };
  if (env.PADRON_DEBUG) for (const f of p.fills.slice(0, Number(env.PADRON_DEBUG))) log(`   = ${f.x.name} (${f.x.city}) ← ${JSON.stringify(f.set)}`);
  const sf = arg("summary", ""); if (sf) fs.writeFileSync(sf, JSON.stringify(summary, null, 1) + "\n");
  if (DRY) return;
  const out = arg("out", SCHOOLS_FILE);
  fs.writeFileSync(out, JSON.stringify(schools, null, 1) + "\n");
  log(`escrito ${out}`);
}

main().catch(e => { console.error(e.message || e); process.exit(1); });
