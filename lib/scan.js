// Búsqueda de colegios privados en OpenStreetMap (Overpass): ciudades por país, colegios por ciudad,
// reglas para descartar públicos y unión con la base sin duplicar. La usan el radar (scripts/radar.mjs)
// y el buscador de la app (/api/scan/*). Sin dependencias.
import { parseAddress, locateAddress, photonSearch, googleGeocode, googleKey, overpassQuick, countryName, sameName as geoSameName } from "./geo.js";
export { parseAddress } from "./geo.js";
// ---------- utilidades
export const norm = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
export const slug = s => norm(s).replace(/ /g, "-").slice(0, 70);
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export function km(a, b) { const R = 6371, r = x => x * Math.PI / 180; const dLa = r(b.lat - a.lat), dLo = r(b.lng - a.lng); const h = Math.sin(dLa / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); }
export const titleCase = s => s && s === s.toUpperCase() && /[A-Z]{4}/.test(s) ? s.toLowerCase().replace(/(^|\s|\.|-)([a-záéíóúñü])/g, (m, a, b) => a + b.toUpperCase()) : s;

// ---------- Overpass
const MIRRORS = (process.env.OVERPASS_URLS || "https://overpass-api.de/api/interpreter,https://overpass.kumi.systems/api/interpreter,https://overpass.private.coffee/api/interpreter").split(",");
let mirror = 0;
// deadline: hora (ms) antes de la cual tiene que terminar; reserve: segundos que se dejan libres antes del límite.
// signal: si se cancela (el usuario cortó la búsqueda), se aborta el pedido en curso y no se reintenta.
export const sleepOr = (ms, signal) => new Promise((res, rej) => {
  if (signal?.aborted) return rej(signal.reason || new Error("cancelado"));
  const t = setTimeout(res, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); rej(signal.reason || new Error("cancelado")); }, { once: true });
});
const withSignal = (ms, signal) => signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
export async function overpass(q, { timeout = 180, deadline = Infinity, reserve = 90, attempts = 6, signal } = {}) {
  let last;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (signal?.aborted) throw signal.reason || new Error("cancelado");
    // nunca pasarse del tiempo disponible: si no alcanza, se corta
    const allowed = Math.floor(Math.min(timeout, (deadline - Date.now()) / 1000 - reserve));
    if (allowed < 25) throw new Error("sin tiempo en esta corrida");
    timeout = allowed;
    const url = MIRRORS[mirror % MIRRORS.length];
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "OrderBrain-Radar/1.0 (school prospecting)" }, body: "data=" + encodeURIComponent(`[out:json][timeout:${timeout}];${q}`), signal: withSignal((timeout + 20) * 1000, signal) });
      if (r.ok) { const j = await r.json(); if (j.remark && /runtime error|timed out/i.test(j.remark)) throw new Error(j.remark); return j.elements || []; }
      last = new Error(`Overpass ${r.status}`);
      if (r.status === 429 || r.status >= 500) { mirror++; await sleepOr(5000 * (attempt + 1), signal); continue; }
      throw last;
    } catch (e) { if (signal?.aborted) throw e; last = e; mirror++; await sleepOr(3000 * (attempt + 1), signal); }
  }
  throw last;
}

// ---------- ciudades por país
export async function citiesFor(cc, { minPop = 40000, deadline, reserve, signal } = {}) {
  const els = await overpass(`area["ISO3166-1"="${cc}"]["boundary"="administrative"]->.a;node(area.a)["place"~"^(city|town)$"]["population"];out body;`, { timeout: 120, deadline, reserve, signal });
  const out = [];
  for (const e of els) {
    const pop = parseInt(String(e.tags.population || "").replace(/[^\d]/g, ""), 10);
    const name = e.tags["name:es"] || e.tags.name;
    if (!name || !(pop >= minPop) || e.lat == null) continue;
    out.push({ id: e.id, name, lat: +e.lat.toFixed(5), lng: +e.lon.toFixed(5), pop });
  }
  // las ciudades muy cercanas a una más grande (conurbados) se escanean dentro de la grande
  out.sort((a, b) => b.pop - a.pop);
  const kept = [];
  for (const c of out) if (!kept.some(k => km(k, c) < radiusKm(k.pop) * 0.6)) kept.push(c);
  return kept;
}
export const radiusKm = pop => pop >= 3e6 ? 28 : pop >= 1e6 ? 18 : pop >= 4e5 ? 12 : pop >= 1.5e5 ? 8 : 5;

// ---------- qué es un colegio privado
export const PUBLIC_RE = new RegExp([
  "\\b(n[°ºo]?\\.?|nro\\.?|num\\.?|numero)\\s*\\d", "\\bi e\\b(?! p)", "institucion educativa (?!privada)", "\\b[a-f]-?\\s?\\d{1,4}\\b", "\\bno\\.\\s*\\d",
  "escuela (primaria|secundaria|tecnica|normal|rural|urbana|oficial|publica|fiscal|provincial|municipal|nacional|federal|estatal|distrital)",
  "telesecundaria", "\\bconafe\\b", "\\bcetis\\b", "\\bcbtis\\b", "\\bcbta\\b", "\\bconalep\\b", "\\bcecyt", "\\bcobach", "colegio de bachilleres", "\\bdgeti\\b",
  "\\bcetmar\\b", "\\bemsad\\b", "\\bcecati\\b", "\\bcam\\b", "\\busaer\\b", "\\bcendi\\b", "\\bcaic\\b", "\\bpronoei\\b", "\\bcebe\\b", "\\bceba\\b", "\\bprite\\b",
  "liceo (bicentenario|municipal|publico|politecnico)", "escuela basica", "instituto nacional", "colegio nacional", "colegio provincial", "escuela de educacion (secundaria|primaria|tecnica|especial)",
  "universidad (nacional|autonoma|estatal|publica|tecnologica nacional)",
  "\\b(ceip|ies|ceo|cra|cepa|cpi|cpr|eso)\\b", "colegio publico", "instituto de educacion secundaria", "escuela oficial", "centro publico",
  "unidad educativa (fiscal|fiscomisional|municipal|nacional|del milenio)", "\\bfiscal\\b", "escuela basica", "colegio nacional", "u e n\\b",
  "\\bpublic[oa]s?\\b", "instituto tecnologico de", "universidad politecnica", "tecnologico publico", "superior tecnologico publico", "\\badultos\\b", "educacion de adultos", "\\bnocturn[oa]\\b", "universidad de chile", "escuela de ingenieria", "colegio (municipal|tecnico profesional)", "\\bctp\\b", "por cooperativa", "\\bcindea\\b", "\\bipec\\b",
  "\\b(uba|udelar|uchile|usach|unmsm|unal|uncuyo|unlp|unr|utn|uaem|uanl|udg|buap|uady|uson)\\b",
  "escola (estadual|municipal|publica)", "colegio estadual", "\\b(ee|emef|emei|cemei|ciep)\\b", "instituto federal",
  "institucion educativa (distrital|departamental|municipal|oficial)", "colegio distrital", "colegio departamental", "\\bied\\b", "\\binem\\b", "\\bunam\\b", "\\bipn\\b", "\\bliceo departamental", "\\bescuela publica", "\\bjardin de ninos (federal|estatal)",
].join("|"), "i");
const PRIVATE_RE = /\b(unidad educativa|colegio|instituto|school|college|academy|academia|liceo|montessori|waldorf|bilingue|bilingual|british|american|britanico|americano|aleman|frances|italiano|ingles|internacional|international|iep|i e p|cep|cebp|kinder|preparatoria|prepa|centro educativo|complejo educativo|gimnasio|lycee|deutsche|scuola|universidad|university)\b/i;
// «escola» es colegio en portugués; en Cataluña, Valencia y Baleares suele ser pública, así que solo cuenta en BR y PT.
const PRIVATE_PT_RE = /\b(escola|colegio)\b/i;
const privateWord = (n, cc) => PRIVATE_RE.test(n) || ((cc === "BR" || cc === "PT") && PRIVATE_PT_RE.test(n));
// Lo que no es un colegio aunque en el mapa figure como «school». HARD descarta siempre (academias de idiomas,
// de manejo, escuelas de música o fútbol…); SOFT solo si el nombre no dice colegio, escuela, liceo, kinder, etc.
const NOT_SCHOOL_HARD = new RegExp([
  "\\b(idiomas?|language|languages|english center|berlitz|wall street english)\\b",
  "\\b(autoescuela|conduccion|driving)\\b", "escuela de manejo",
  "escuela de (arte|artes|musica|danza|teatro|cine|fotografia|diseno|modelaje|belleza|cocina|gastronomia|futbol|natacion|tenis|surf|enfermeria|policia|oficiales|suboficiales|cadetes|aviacion|pilotos|vela|equitacion|circo|tango|yoga|bomberos|negocios)",
  "academia de (baile|danza|musica|ingles|idiomas|futbol|natacion|tenis|belleza|peluqueria|manejo|conduccion|policia|cocina|gastronomia|computacion|informatica|programacion|preparacion|ingreso|artes marciales|karate|ballet|canto|teatro|modelaje|costura|corte)",
  "\\b(conservatorio|yoga|pilates|crossfit|karate|taekwondo|judo|boxeo|kung fu|capoeira)\\b",
  "\\b(apoyo escolar|clases particulares|regularizacion|fonoaudiolog|psicopedagog|posgrado|postgrado|maestria|mba|business school)\\b",
  "\\bcetpro\\b", "\\bescuela militar\\b", "^(el )?heroico colegio militar",
].join("|"), "i");
// Oficios (cocina, barbería, estética): se descartan salvo que sea un liceo o colegio técnico (secundaria con esa especialidad).
const NOT_SCHOOL_TRADE = /\b(culinari|gastronom|barber|estetica|estilismo|cosmetolog)/i;
const K12_TECH = /\b(liceo|colegio) tecnico|tecnico profesional/i;
const NOT_SCHOOL_SOFT = /\b(centro (latinoamericano|cultural|de investigacion|de estudios|de formacion|de capacitacion|de computacion|de apoyo|de rehabilitacion|de terapia|comunitario|de salud)|economia|investigacion|investigaciones|cursos?|capacitacion|formacion profesional|terapia|rehabilitacion|seminario (mayor|menor|diocesano|teologico|conciliar|evangelico|biblico)|facultad|biblioteca|museo|ong|alianza francesa|preuniversitari[oa]|pre universitari[oa]|guarderia|estancia infantil|sala cuna|(?<!(academia|instituto) )militar|polici(a|as|al|ales))\b/i;
// (los colegios con nombre de instituto cultural, como Dante Alighieri o Goethe, siguen siendo colegios)
const SCHOOL_WORD = /\b(colegios?|escuelas?|schools?|liceos?|kinder|kindergarten|jardin|unidad educativa|institucion educativa|gimnasio|preparatoria|preescolar|lycee|scuola|escola|montessori|waldorf|educativa|educativo|iep|i e p)\b/i;
export const notSchool = n => NOT_SCHOOL_HARD.test(n) || (NOT_SCHOOL_TRADE.test(n) && !K12_TECH.test(n)) || (NOT_SCHOOL_SOFT.test(n) && !SCHOOL_WORD.test(n));
const RELIGIOUS_RE = /\b(san|santa|santo|sagrado|maria|marista|lasalle|la salle|salesian|jesuit|cristo|cristian|adventista|evangel|catolic|parroquial|inmaculad|corazon|guadalupe|teresa|ignacio|agustin|franciscan|dominic|bautista|anglican|hebreo|judio|hebrew)\b/i;
const INTL_RE = /\b(bilingue|bilingual|british|american|britanico|americano|aleman|frances|italiano|internacional|international|lycee|deutsche|scuola|english|ingles|cambridge|ib)\b/i;

// En Costa Rica los «liceos» y muchos «colegios» son públicos: ahí se pide una señal clara de privado.
const STRICT = new Set(["CR"]);
const PUBLIC_NAME_RE = /\bpublic[oa]s?\b|(?<!\b(sede|plantel|recinto|campus|sucursal) )\b(n|no|nro|num|numero)\s+\d/;
const STRONG_PRIVATE_RE = /\b(school|college|academy|bilingue|bilingual|international|internacional|montessori|waldorf|cristiano|adventista|saint|st|british|american|lycee|deutsche|privad|particular)\b/i;
export function classify(tags, cc = "") {
  const name = String(tags.name || "").trim();
  if (!name || name.length < 4) return null;
  const n = norm(name);
  const opType = String(tags["operator:type"] || "").toLowerCase();
  const op = norm(tags.operator || "");
  if (/^(public|government|state|municipal|public_school)$/.test(opType)) return null;
  if (/secretaria|ministerio|sep\b|gobierno|municipalidad|intendencia|anep|codicen|mineduc|provincia|estado de/.test(op)) return null;
  const isPrivateTag = /^(private|religious|ngo|community|private_nonprofit|private_forprofit)$/.test(opType) || tags.fee === "yes" || /privad|particular/.test(norm(tags["school:type"] || "") + " " + n);
  if (notSchool(n)) return null;
  // «público» o un número de escuela en el nombre ganan sobre la etiqueta de privado del mapa (salvo que el nombre diga privado)
  if (PUBLIC_NAME_RE.test(n) && !/privad|particular|incorporad|\b(part|inc|iep|i e p)\b/.test(n)) return null;
  // ONG o comunidad sin palabra de colegio en el nombre: suele ser un centro, no un colegio
  if (/^(ngo|community)$/.test(opType) && !privateWord(n, cc) && !SCHOOL_WORD.test(n)) return null;
  if (!isPrivateTag && PUBLIC_RE.test(n)) return null;
  if (!isPrivateTag && !privateWord(n, cc)) return null;
  if (!isPrivateTag && STRICT.has(cc) && !STRONG_PRIVATE_RE.test(n)) return null;
  const levels = [];
  const isced = String(tags["isced:level"] || "");
  // los números solo valen en isced:level («Sede N° 2» en el nombre no es un nivel); las palabras, en el nombre
  if (/\b0\b/.test(isced) || /preescolar|kinder|jardin|inicial/.test(n)) levels.push("Preescolar");
  if (/\b1\b/.test(isced) || /primaria|primary|elementary/.test(n)) levels.push("Primaria");
  if (/\b2\b/.test(isced) || /secundaria|secondary|middle/.test(n)) levels.push("Secundaria");
  if (/\b3\b/.test(isced) || /preparatoria|prepa|bachillerato|high school/.test(n)) levels.push("Prepa");
  if (tags.amenity === "university" || tags.amenity === "college" && /universidad|university/.test(n)) levels.push("Universidad");
  const opp = [];
  if (INTL_RE.test(n)) opp.push("Bilingüe o internacional");
  if (RELIGIOUS_RE.test(n) || [tags.religion, tags.denomination].some(x => x && !/^(no|none)$/i.test(String(x).trim()))) opp.push("Confesional (puede ser parte de una red)");
  if (levels.includes("Universidad")) opp.push("Universidad (OrderGO)");
  if (isPrivateTag) opp.push("Privado confirmado en el mapa");
  return { levels, opp, private: isPrivateTag ? "seguro" : "probable" };
}

// Colegios de un círculo alrededor de una ciudad, solo dentro del país (sin cruzar fronteras)
// o, si se pasa areaId, solo dentro de esa área (una provincia, un municipio).
const AMENITY = `nwr["amenity"~"^(school|college|university|kindergarten)$"]["name"]`;
const areaClause = (cc, areaId) => areaId ? `area(${Number(areaId)})->.a;` : `area["ISO3166-1"="${cc}"]["boundary"="administrative"]->.a;`;
export function scanCity(cc, city, { areaId, radius, ...opts } = {}) {
  const R = Math.round((Number(radius) > 0 ? Math.min(Number(radius), 40) : radiusKm(city.pop || 0)) * 1000);
  return overpass(`${areaClause(cc, areaId)}${AMENITY}(around:${R},${Number(city.lat)},${Number(city.lng)})(area.a);out center tags;`, opts);
}
// Todos los colegios dentro de un área exacta (barrio, ciudad, provincia).
export function scanArea(areaId, opts = {}) {
  return overpass(`area(${Number(areaId)})->.a;${AMENITY}(area.a);out center tags;`, opts);
}
const pick = (t, ...ks) => { for (const k of ks) if (t[k]) return String(t[k]).split(";")[0].trim(); return ""; };
// cityOf: en una búsqueda de provincia entera, la ciudad de cada colegio (no el nombre de la provincia).
export function fromOsm(e, city, cc, countryName, today = new Date().toISOString().slice(0, 10), cityOf = null) {
  const t = e.tags || {};
  const c = classify(t, cc); if (!c) return null;
  const lat = e.lat ?? e.center?.lat, lng = e.lon ?? e.center?.lon;
  if (lat == null) return null;
  const street = [pick(t, "addr:street"), pick(t, "addr:housenumber")].filter(Boolean).join(" ");
  const addr = pick(t, "addr:full") || [street, pick(t, "addr:suburb", "addr:neighbourhood")].filter(Boolean).join(", ");
  let web = pick(t, "website", "contact:website", "url");
  if (web && !/^https?:\/\//.test(web)) web = "https://" + web;
  return {
    name: titleCase(String(t.name).trim()), city: (cityOf && cityOf(t, lat, lng)) || city.name, country: countryName, lat: +lat.toFixed(6), lng: +lng.toFixed(6),
    addr: addr || "", phone: pick(t, "phone", "contact:phone", "contact:mobile"), web, email: pick(t, "email", "contact:email"),
    levels: c.levels, opp: c.opp, private: c.private, src: "osm", osm: `${e.type[0]}${e.id}`, found: today,
  };
}

// ---------- unir con la base existente
// Palabras que no distinguen un colegio de otro.
const GENERIC = new Set("colegio colegios instituto institucion educativa escuela school college academy academia liceo unidad centro educacional educativo complejo bilingue bilingual internacional international kinder jardin preparatoria prepa primaria secundaria nivel inicial particular privado privada sede campus de del la las el los y the of san santa santo".split(" "));
export const keyTokens = s => norm(s).split(" ").filter(w => w.length > 2 && !GENERIC.has(w));
// Devuelve { x, exact }: exact = mismo elemento del mapa o mismo nombre; si no, coincidencia aproximada por cercanía.
export function matchExisting(list, idx, s) {
  const n = norm(s.name);
  if (s.osm && idx.osm.has(s.osm)) return { x: idx.osm.get(s.osm), exact: true };
  for (const x of idx.byName.get(n) || []) if (x.country === s.country && km(x, s) < 2) return { x, exact: true };
  const mine = keyTokens(s.name); if (!mine.length) return null;
  const near = list.filter(x => x.country === s.country && Math.abs(x.lat - s.lat) < 0.003 && Math.abs(x.lng - s.lng) < 0.003);
  for (const x of near) {
    const theirs = keyTokens(x.name); if (!theirs.length) continue;
    const shared = theirs.filter(w => mine.includes(w)).length;
    // hace falta compartir las palabras propias del nombre en los dos sentidos
    if (shared / theirs.length >= 0.6 && shared / mine.length >= 0.6) return { x, exact: false };
  }
  return null;
}
export function buildIndex(list) {
  const idx = { osm: new Map(), byName: new Map(), ids: new Set() };
  for (const s of list) { if (s.osm) idx.osm.set(s.osm, s); const n = norm(s.name); if (!idx.byName.has(n)) idx.byName.set(n, []); idx.byName.get(n).push(s); idx.ids.add(s.id); }
  return idx;
}
export function addTo(list, idx, s) {
  let id = `${slug(s.city)}-${slug(s.name)}`, i = 2;
  while (idx.ids.has(id)) id = `${slug(s.city)}-${slug(s.name)}-${i++}`;
  const rec = { id, ...s };
  list.push(rec); idx.ids.add(id); if (rec.osm) idx.osm.set(rec.osm, rec);
  const n = norm(rec.name); if (!idx.byName.has(n)) idx.byName.set(n, []); idx.byName.get(n).push(rec);
  return rec;
}

// ---------- zona que pide el usuario («España», «Madrid», «Provincia de Buenos Aires», «Pocitos», una dirección)
// Usa Nominatim (OpenStreetMap) y trae el contorno real del lugar para dibujarlo y buscar solo adentro. Las direcciones
// escritas a mano pasan por lib/geo.js (Google si hay clave, Nominatim y Photon, de lo más exacto a lo más amplio).
const NOM = "https://nominatim.openstreetmap.org";
const UA = { "user-agent": "OrderBrain-SDR/1.0 (school prospecting)" };
let nomNext = 0;
// deadline: si el turno (un pedido por segundo) llega tarde, no se pide (error con skip: no es una falla de la red)
async function nominatim(path, { deadline = Infinity, timeout = 15000 } = {}) {
  const wait = nomNext - Date.now();
  if (Date.now() + Math.max(0, wait) > deadline - 400) throw Object.assign(new Error("sin tiempo"), { skip: true });
  // política de Nominatim: un pedido por segundo
  nomNext = Math.max(Date.now(), nomNext) + 1100;
  if (wait > 0) await sleep(wait);
  const r = await fetch(`${NOM}/${path}&format=jsonv2&addressdetails=1&extratags=1&accept-language=es&polygon_geojson=1&polygon_threshold=0.0008`, { headers: UA, signal: AbortSignal.timeout(Math.min(timeout, Math.max(1500, deadline - Date.now()))) });
  if (!r.ok) throw Object.assign(new Error(`No pude buscar la zona (OpenStreetMap respondió ${r.status}). Probá de nuevo en un rato.`), { status: 503 });
  return r.json();
}
// búsqueda libre (q) o estructurada (street, city, state, country, postalcode) para lib/geo.js
const nominatimSearch = (params, opts) => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) if (v) u.set(k, v);
  u.set("limit", "10");
  return nominatim(`search?${u}`, opts);
};
// Recorta el polígono a ~6000 puntos y 5 decimales (alcanza para dibujar y para saber si un colegio está adentro).
function slim(g) {
  if (!g || !/Polygon/.test(g.type)) return null;
  const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
  const total = polys.reduce((a, p) => a + p.reduce((b, r) => b + r.length, 0), 0);
  const step = Math.max(1, Math.ceil(total / 6000));
  const ring = r => { const out = r.filter((_, i) => i % step === 0).map(([x, y]) => [+x.toFixed(5), +y.toFixed(5)]); if (out.length < 4) return null; out.push(out[0]); return out; };
  const out = polys.map(p => p.map(ring).filter(Boolean)).filter(p => p.length);
  if (!out.length) return null;
  return out.length === 1 ? { type: "Polygon", coordinates: out[0] } : { type: "MultiPolygon", coordinates: out };
}
const areaOf = p => p.osm_type === "relation" ? 3600000000 + Number(p.osm_id) : p.osm_type === "way" ? 2400000000 + Number(p.osm_id) : null;
const SUB = /^(suburb|city_district|borough|quarter|neighbourhood|neighborhood|hamlet|isolated_dwelling|residential|road|postcode|amenity|building|house|place|square|street|highway)$/;
const CITY = /^(city|town|village|municipality)$/;
const BARRIO = /^(suburb|city_district|borough|quarter|neighbourhood|neighborhood)$/;
const short = p => p.display_name.split(",").map(x => x.trim()).filter(x => x && !/^[\d\s-]+$/.test(x)).slice(0, 3).join(", ");
const popOf = p => parseInt(String(p.extratags?.population || "").replace(/[^\d]/g, ""), 10) || 0;

function toPlace(p) {
  const cc = p.address.country_code.toUpperCase(), country = p.address.country;
  const type = p.addresstype || p.type;
  const kind = type === "country" ? "country" : CITY.test(type) ? "city" : SUB.test(type) ? "spot" : p.osm_type === "relation" ? "region" : "spot";
  const geo = slim(p.geojson);
  const name = p.name || p.display_name.split(",")[0];
  const city = { name: kind === "city" ? name : p.address.city || p.address.town || p.address.village || p.address.municipality || name, lat: +(+p.lat).toFixed(5), lng: +(+p.lon).toFixed(5), pop: popOf(p) };
  const bb = (p.boundingbox || []).map(Number);
  const a = p.address || {};
  const label = /^(amenity|building|house|shop|office|place|road|highway)$/.test(type) && a.road
    ? [[a.road, a.house_number].filter(Boolean).join(" "), a.suburb || a.neighbourhood, a.city || a.town || a.village].filter(Boolean).join(", ") : short(p);
  return {
    cc, country, kind, type, name, label, lat: +p.lat, lng: +p.lon, city,
    osm: `${p.osm_type[0].toUpperCase()}${p.osm_id}`, areaId: geo ? areaOf(p) : null, geo,
    bbox: bb.length === 4 ? [[bb[0], bb[2]], [bb[1], bb[3]]] : null,
    // sin contorno (un punto o una dirección): se busca en un círculo
    radius: geo ? null : kind === "city" ? Math.max(3, radiusKm(popOf(p) || 150000) - 2) : type === "suburb" || type === "neighbourhood" || type === "quarter" ? 1.5 : 1,
  };
}
// Una ciudad que Nominatim devuelve como punto: se busca el límite del municipio que la contiene.
async function withBoundary(place, { deadline } = {}) {
  if (place.geo || place.kind !== "city") return place;
  // zoom 10 = ciudad; zoom 8 = municipio o partido (en México la ciudad suele ser un punto dentro del «Municipio de…»)
  let failed = false;
  for (const z of [10, 8]) {
    try {
      const r = await nominatim(`reverse?lat=${place.lat}&lon=${place.lng}&zoom=${z}`, { deadline });
      const g = slim(r?.geojson);
      if (g && r.osm_type !== "node" && /^(city|municipality|town|county)$/.test(r.addresstype)) {
        const bb = (r.boundingbox || []).map(Number);
        return { ...place, geo: g, areaId: areaOf(r), radius: null, boundary: short(r), bbox: bb.length === 4 ? [[bb[0], bb[2]], [bb[1], bb[3]]] : place.bbox };
      }
    } catch { failed = true; }
  }
  // si falló por un error (no porque no haya límite), el servidor no lo guarda por mucho tiempo
  return failed ? { ...place, boundaryFailed: true } : place;
}
const REGION_WORDS = /\b(estado|provincia|departamento|region|comunidad|state|province|municipio|partido|canton|distrito)\b/;
const REGION_TYPES = /^(state|province|region|county|state_district|department|municipality)$/;
// codes: países donde trabaja el equipo (se busca primero ahí); prefer: el país elegido en la app, si hay uno.
// cc: país que la persona escribió (manda sobre prefer). Si el texto dice el país, el estado o la provincia («Pue.», «CABA»,
// «México»), se busca solo ahí y el país elegido en la app no cuenta.
// Con nombres repetidos («Guadalajara», «Santiago», «Córdoba», «Monterrey») gana la ciudad más importante,
// con prioridad para el país elegido; las otras quedan como alternativas.
export async function resolvePlace(q, { codes = [], prefer = "", cc: given = "", deadline = Date.now() + 8000 } = {}) {
  const a = parseAddress(q, { cc: given });
  const lim = a.cc ? [a.cc] : codes, pref = a.cc || a.soft || prefer;
  const ccParam = l => (l.length ? `&countrycodes=${l.map(c => c.toLowerCase()).join(",")}` : "");
  const rawSearch = async (_, o = {}) => {
    let list = (await nominatim(`search?q=${encodeURIComponent(q)}&limit=10${ccParam(lim)}`, o)).filter(x => x.address?.country_code);
    if (!list.length && lim.length && !a.cc) list = (await nominatim(`search?q=${encodeURIComponent(q)}&limit=10`, o)).filter(x => x.address?.country_code);
    return list;
  };
  // un nombre de lugar («Puebla», «Pocitos», «Estado de Puebla»): como siempre
  if (!a.isAddress) {
    let list;
    try { list = await rawSearch(); } catch (e) { throw Object.assign(new Error("No pude buscar el lugar: OpenStreetMap no respondió. Probá de nuevo en un rato."), { status: 503 }); }
    if (list.length) return byName(q, list, pref);
  }
  // una dirección (o un nombre que Nominatim no encontró): la cadena de intentos
  // (un nombre que Nominatim no encontró tiene su propio tiempo: la primera búsqueda ya pasó)
  const r = await locateAddress(a, { raw: a.isAddress ? rawSearch : [], nominatim: nominatimSearch, photon: photonSearch, google: googleKey() ? googleGeocode : null, overpass: overpassQuick, codes, prefer: pref, deadline: a.isAddress ? deadline : Math.max(deadline, Date.now() + 5000) });
  if (!r) return null;
  if (r.failed) throw Object.assign(new Error("No pude buscar la dirección: OpenStreetMap no respondió. Probá de nuevo en un rato."), { status: 503 });
  return placeFrom(r, a, deadline);
}
// El lugar que ve la app a partir de lo que encontró la cadena: con contorno (ciudad, región, colonia con límite) o un
// punto con un círculo chico (dirección, calle, colonia sin límite, código postal). found y note dicen qué se encontró.
async function placeFrom(r, a, deadline) {
  const h = r.hit, lvl = r.level;
  let place = null;
  const poly = !!h.raw?.geojson && /Polygon/.test(h.raw.geojson.type);
  if (h.src === "nominatim" && h.raw?.osm_type && (lvl === "city" || lvl === "region" || (lvl === "colonia" && poly && !h.approx))) {
    place = toPlace(h.raw);
    if (lvl === "city") place = await withBoundary(place, { deadline: deadline + 2500 });
  } else if ((lvl === "city" || lvl === "region") && /^[NWR]\d+$/.test(h.osm || "")) {
    place = await lookupPlace(h.osm, { deadline: deadline + 2500 }).catch(() => null);
  }
  if (!place) place = pointPlace(h, a, lvl);
  place.found = lvl;
  if (r.note) place.note = r.note;
  if (r.partial) place.partial = true;
  const altLabel = x => [x.road || x.name, x.colonias?.[0], x.postcode && `C.P. ${x.postcode}`].filter(Boolean).join(", ");
  place.alts = (r.alts || []).filter(x => /^[NWR]\d+$/.test(x.osm || "")).map(x => ({ osm: x.osm, label: altLabel(x), kind: x.level })).slice(0, 3);
  return place;
}
const EXACT = new Set(["house", "near", "corner", "street"]);
function pointPlace(h, a, lvl) {
  const lat = +(+h.lat).toFixed(6), lng = +(+h.lng).toFixed(6);
  // la ciudad como figura en el mapa si es la escrita («Puebla de Zaragoza»); si no, la escrita
  const cityName = h.city && a.city && geoSameName(a.city, h.city) && !/^(municipio|partido|departamento|provincia|comuna|distrito)\b/i.test(h.city) ? h.city : a.city || h.city || "";
  const label = EXACT.has(lvl) ? a.label
    : lvl === "colonia" ? [a.colonia || h.name, a.city || h.city].filter(Boolean).join(", ")
    : lvl === "postcode" ? [`C.P. ${a.postcode}`, a.city || h.city].filter(Boolean).join(", ")
    : [h.name, h.state].filter(Boolean).join(", ");
  return {
    cc: h.cc, country: h.country || countryName(h.cc), kind: "spot", type: lvl === "house" || lvl === "near" ? "house" : lvl === "street" || lvl === "corner" ? "road" : lvl === "postcode" ? "postcode" : "suburb",
    name: label.split(",")[0], label, lat, lng, city: { name: cityName, lat, lng, pop: 0 }, osm: h.osm || "", areaId: null, geo: null, bbox: null,
    // un punto: se buscan los colegios en un círculo chico alrededor
    radius: lvl === "house" ? 1 : lvl === "colonia" || lvl === "postcode" ? 1.5 : 1.2,
  };
}
// Un nombre suelto: se ordena por importancia, tamaño y país elegido.
function byName(q, list, prefer) {
  const first = list[0];
  // un nombre suelto (sin coma ni números): se ordena por importancia, tamaño y país elegido.
  // Un barrio de una ciudad («Pocitos», «Palermo», «Polanco») le gana a un pueblo o paraje con el mismo nombre.
  if (!/[,\d]/.test(q)) {
    const nq = norm(q), pr = String(prefer || "").toLowerCase();
    const score = x => {
      const t = x.addresstype, a = x.address, exact = norm(x.name) === nq, inCity = BARRIO.test(t) && (a.city || a.town) && norm(a.city || a.town) !== norm(x.name);
      return (Number(x.importance) || 0) * 2 + (t === "country" ? 0.3 : exact && /^(city|town|municipality)$/.test(t) ? 0.15 : 0)
        + Math.min(popOf(x), 5e6) / 1e6 * 0.6 + (pr && a.country_code === pr ? 1.2 : 0) + (exact ? 0.1 : 0)
        + (inCity ? 0.3 : SUB.test(t) || t === "village" ? -0.2 : 0);
    };
    list = list.map((x, i) => ({ x, s: score(x) - i * 0.01 })).sort((a, b) => b.s - a.s).map(o => o.x);
  }
  return pickMain(q, list, first);
}
async function pickMain(q, list, first) {
  // «Puebla»: el estado y la ciudad se llaman igual. Para prospectar suele servir más la ciudad,
  // salvo que la búsqueda diga «estado», «provincia»… La otra opción queda como alternativa.
  let main = list[0];
  const wantsRegion = REGION_WORDS.test(norm(q));
  if (wantsRegion) {
    // «Estado de Puebla»: Nominatim no entiende bien la palabra; se busca sin ella y se elige la región
    let r = list.find(x => REGION_TYPES.test(x.addresstype));
    if (!r) {
      const bare = norm(q).replace(new RegExp(REGION_WORDS.source, "g"), " ").replace(/\b(de|del|la|el)\b/g, " ").trim();
      if (bare) { const more = (await nominatim(`search?q=${encodeURIComponent(bare)}&limit=6`)).filter(x => x.address?.country_code); r = more.find(x => REGION_TYPES.test(x.addresstype)); if (r) list.splice(0, 0, r); }
    }
    if (r) main = r;
  } else if (!CITY.test(main.addresstype) && !BARRIO.test(main.addresstype) && main.addresstype !== "country") {
    const c = list.find(x => CITY.test(x.addresstype) && norm(x.name).startsWith(norm(q).split(" ")[0]));
    if (c) main = c;
  }
  const place = await withBoundary(toPlace(main));
  // alternativas sin repetidos (mismo nombre visible) ni la elegida; el primer resultado de Nominatim siempre está
  const seenAlt = new Set([norm(place.label), norm(short(main))]);
  const alt = x => ({ osm: `${x.osm_type[0].toUpperCase()}${x.osm_id}`, label: short(x), kind: x.addresstype });
  const top = first.osm_id !== main.osm_id && !seenAlt.has(norm(short(first))) ? [alt(first)] : [];
  for (const a of top) seenAlt.add(norm(a.label));
  place.alts = top.concat(list.filter(x => x !== main && x !== first && x.osm_id !== main.osm_id).map(alt)
    .filter(a => !seenAlt.has(norm(a.label)) && seenAlt.add(norm(a.label))).slice(0, 3 - top.length));
  return place;
}
// Un lugar puntual elegido entre las alternativas («R12345», «N678»).
export async function lookupPlace(osm, { deadline } = {}) {
  if (!/^[NWR]\d{1,12}$/.test(osm)) return null;
  const [p] = await nominatim(`lookup?osm_ids=${osm}`, { deadline });
  if (!p?.address?.country_code) return null;
  return withBoundary(toPlace(p), { deadline });
}
// Ciudades de una región (área de Overpass) con su población.
export async function citiesInArea(areaId, { minPop = 40000, deadline, reserve, signal } = {}) {
  const els = await overpass(`area(${Number(areaId)})->.a;node(area.a)["place"~"^(city|town)$"]["population"];out body;`, { timeout: 120, deadline, reserve, signal });
  const out = [];
  for (const e of els) {
    const pop = parseInt(String(e.tags.population || "").replace(/[^\d]/g, ""), 10);
    const name = e.tags["name:es"] || e.tags.name;
    if (!name || !(pop >= minPop) || e.lat == null) continue;
    out.push({ id: e.id, name, lat: +e.lat.toFixed(5), lng: +e.lon.toFixed(5), pop });
  }
  out.sort((a, b) => b.pop - a.pop);
  const kept = [];
  for (const c of out) if (!kept.some(k => km(k, c) < radiusKm(k.pop) * 0.6)) kept.push(c);
  return kept;
}
