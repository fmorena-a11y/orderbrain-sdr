// Búsqueda de colegios privados en OpenStreetMap (Overpass): ciudades por país, colegios por ciudad,
// reglas para descartar públicos y unión con la base sin duplicar. La usan el radar (scripts/radar.mjs)
// y el buscador de la app (/api/scan/*). Sin dependencias.
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
export async function overpass(q, { timeout = 180, deadline = Infinity, reserve = 90, attempts = 6 } = {}) {
  let last;
  for (let attempt = 0; attempt < attempts; attempt++) {
    // nunca pasarse del tiempo disponible: si no alcanza, se corta
    const allowed = Math.floor(Math.min(timeout, (deadline - Date.now()) / 1000 - reserve));
    if (allowed < 25) throw new Error("sin tiempo en esta corrida");
    timeout = allowed;
    const url = MIRRORS[mirror % MIRRORS.length];
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "OrderBrain-Radar/1.0 (school prospecting)" }, body: "data=" + encodeURIComponent(`[out:json][timeout:${timeout}];${q}`), signal: AbortSignal.timeout((timeout + 20) * 1000) });
      if (r.ok) { const j = await r.json(); if (j.remark && /runtime error|timed out/i.test(j.remark)) throw new Error(j.remark); return j.elements || []; }
      last = new Error(`Overpass ${r.status}`);
      if (r.status === 429 || r.status >= 500) { mirror++; await sleep(5000 * (attempt + 1)); continue; }
      throw last;
    } catch (e) { last = e; mirror++; await sleep(3000 * (attempt + 1)); }
  }
  throw last;
}

// ---------- ciudades por país
export async function citiesFor(cc, { minPop = 40000, deadline, reserve } = {}) {
  const els = await overpass(`area["ISO3166-1"="${cc}"]["boundary"="administrative"]->.a;node(area.a)["place"~"^(city|town)$"]["population"];out body;`, { timeout: 120, deadline, reserve });
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
const PRIVATE_RE = /\b(unidad educativa|colegio|instituto|school|college|academy|academia|liceo|montessori|waldorf|bilingue|bilingual|british|american|britanico|americano|aleman|frances|italiano|ingles|internacional|international|iep|i e p|cep|cebp|kinder|preparatoria|prepa|centro educativo|complejo educativo|gimnasio|lycee|deutsche|scuola|universidad|university|escola|colegio)\b/i;
const RELIGIOUS_RE = /\b(san|santa|santo|sagrado|maria|marista|lasalle|la salle|salesian|jesuit|cristo|cristian|adventista|evangel|catolic|parroquial|inmaculad|corazon|guadalupe|teresa|ignacio|agustin|franciscan|dominic|bautista|anglican|hebreo|judio|hebrew)\b/i;
const INTL_RE = /\b(bilingue|bilingual|british|american|britanico|americano|aleman|frances|italiano|internacional|international|lycee|deutsche|scuola|english|ingles|cambridge|ib)\b/i;

// En Costa Rica los «liceos» y muchos «colegios» son públicos: ahí se pide una señal clara de privado.
const STRICT = new Set(["CR"]);
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
  if (!isPrivateTag && PUBLIC_RE.test(n)) return null;
  if (!isPrivateTag && !PRIVATE_RE.test(n)) return null;
  if (!isPrivateTag && STRICT.has(cc) && !STRONG_PRIVATE_RE.test(n)) return null;
  const levels = [];
  const isced = String(tags["isced:level"] || "");
  if (/\b0\b|preescolar|kinder|jardin|inicial/.test(n + " " + isced)) levels.push("Preescolar");
  if (/\b1\b|primaria|primary|elementary/.test(n + " " + isced)) levels.push("Primaria");
  if (/\b2\b|secundaria|secondary|middle/.test(n + " " + isced)) levels.push("Secundaria");
  if (/\b3\b|preparatoria|prepa|bachillerato|high school/.test(n + " " + isced)) levels.push("Prepa");
  if (tags.amenity === "university" || tags.amenity === "college" && /universidad|university/.test(n)) levels.push("Universidad");
  const opp = [];
  if (INTL_RE.test(n)) opp.push("Bilingüe o internacional");
  if (RELIGIOUS_RE.test(n) || tags.religion) opp.push("Confesional (puede ser parte de una red)");
  if (levels.includes("Universidad")) opp.push("Universidad (OrderGO)");
  if (isPrivateTag) opp.push("Privado confirmado en el mapa");
  return { levels, opp, private: isPrivateTag ? "seguro" : "probable" };
}

// Colegios de un círculo alrededor de una ciudad, solo dentro del país (sin cruzar fronteras).
export function scanCity(cc, city, opts = {}) {
  const R = Math.round(radiusKm(city.pop || 0) * 1000);
  return overpass(`area["ISO3166-1"="${cc}"]["boundary"="administrative"]->.a;nwr["amenity"~"^(school|college|university)$"]["name"](around:${R},${city.lat},${city.lng})(area.a);out center tags;`, opts);
}
const pick = (t, ...ks) => { for (const k of ks) if (t[k]) return String(t[k]).split(";")[0].trim(); return ""; };
export function fromOsm(e, city, cc, countryName, today = new Date().toISOString().slice(0, 10)) {
  const t = e.tags || {};
  const c = classify(t, cc); if (!c) return null;
  const lat = e.lat ?? e.center?.lat, lng = e.lon ?? e.center?.lon;
  if (lat == null) return null;
  const street = [pick(t, "addr:street"), pick(t, "addr:housenumber")].filter(Boolean).join(" ");
  const addr = pick(t, "addr:full") || [street, pick(t, "addr:suburb", "addr:neighbourhood")].filter(Boolean).join(", ");
  let web = pick(t, "website", "contact:website", "url");
  if (web && !/^https?:\/\//.test(web)) web = "https://" + web;
  return {
    name: titleCase(String(t.name).trim()), city: city.name, country: countryName, lat: +lat.toFixed(6), lng: +lng.toFixed(6),
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

// ---------- zona que pide el usuario («España», «Madrid», «Provincia de Buenos Aires»)
// Usa Nominatim (OpenStreetMap). Devuelve país, región (con id de área para Overpass) o ciudad.
export async function resolvePlace(q) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=jsonv2&addressdetails=1&extratags=1&limit=5&accept-language=es`;
  const r = await fetch(url, { headers: { "user-agent": "OrderBrain-SDR/1.0 (school prospecting)" }, signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`No pude buscar la zona (${r.status})`);
  const list = await r.json();
  const p = list.find(x => x.address?.country_code) ; if (!p) return null;
  const cc = p.address.country_code.toUpperCase(), country = p.address.country;
  const type = p.addresstype || p.type;
  const base = { cc, country, lat: +p.lat, lng: +p.lon, label: p.display_name.split(",").map(x => x.trim()).filter(x => x && !/^[\d\s-]+$/.test(x)).slice(0, 3).join(", ") };
  if (type === "country") return { ...base, kind: "country", name: country };
  const isCity = /^(city|town|village|municipality)$/.test(type);
  if (isCity) {
    const pop = parseInt(String(p.extratags?.population || "").replace(/[^\d]/g, ""), 10) || 150000;
    return { ...base, kind: "city", name: p.name || p.address.city || p.address.town, city: { name: p.name || p.address.city || p.address.town, lat: +(+p.lat).toFixed(5), lng: +(+p.lon).toFixed(5), pop } };
  }
  // provincia, estado, región: se buscan sus ciudades dentro del área
  if (p.osm_type === "relation") return { ...base, kind: "region", name: p.name, areaId: 3600000000 + Number(p.osm_id) };
  // barrio, calle o dirección: se busca en un radio chico
  return { ...base, kind: "city", precise: true, name: p.name || p.display_name.split(",")[0], city: { name: p.address.city || p.address.town || p.address.village || p.name, lat: +(+p.lat).toFixed(5), lng: +(+p.lon).toFixed(5), pop: 0 } };
}
// Ciudades de una región (área de Overpass) con su población.
export async function citiesInArea(areaId, { minPop = 40000, deadline, reserve } = {}) {
  const els = await overpass(`area(${Number(areaId)})->.a;node(area.a)["place"~"^(city|town)$"]["population"];out body;`, { timeout: 120, deadline, reserve });
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
