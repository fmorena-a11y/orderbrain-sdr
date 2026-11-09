#!/usr/bin/env node
// Radar de OrderBrain: agente que recorre todas las ciudades de todos los países y busca colegios privados
// que todavía no están en la base. Corre en GitHub Actions cada 2 horas (.github/workflows/radar.yml).
//
// Fuentes:
//  - OpenStreetMap (Overpass): ciudades por país y colegios alrededor de cada ciudad. Gratis, sin clave.
//  - Google Places (opcional, GOOGLE_MAPS_API_KEY): rating, teléfono, web y fotos de los colegios nuevos.
//  - Web del colegio: imagen de portada (og:image).
//  - Claude (opcional, ANTHROPIC_API_KEY): encaje con OrderEAT y ángulo de venta de cada colegio nuevo.
//
// Escribe data/schools.json (base de colegios de la app) y data/radar/state.json (ciudades, cobertura y corridas).
// Uso: node scripts/radar.mjs [--minutes 20] [--countries MX,PE] [--dry]
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCHOOLS_FILE = path.join(ROOT, "data", "schools.json");
const STATE_FILE = path.join(ROOT, "data", "radar", "state.json");
const env = process.env;
const arg = (k, d) => { const i = process.argv.indexOf("--" + k); return i > 0 ? process.argv[i + 1] : d; };
const DRY = process.argv.includes("--dry");
const MINUTES = Number(arg("minutes", env.RADAR_MINUTES || 20));
const MIN_POP = Number(env.RADAR_MIN_POP || 40000);
const RESCAN_DAYS = Number(env.RADAR_RESCAN_DAYS || 30);
const PLACES_MAX = Number(env.RADAR_PLACES_MAX || 150);
const WEB_MAX = Number(env.RADAR_WEB_MAX || 150);
const AI_MAX = Number(env.RADAR_AI_MAX || 120);
const T0 = Date.now();
const timeLeft = () => MINUTES * 60e3 - (Date.now() - T0);
const today = new Date().toISOString().slice(0, 10);
const log = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(0)}s]`, ...a);

export const COUNTRIES = { MX: "México", PE: "Perú", AR: "Argentina", CL: "Chile", UY: "Uruguay", GT: "Guatemala", CR: "Costa Rica" };
const ONLY = (arg("countries", env.RADAR_COUNTRIES || "") || "").split(",").map(s => s.trim().toUpperCase()).filter(Boolean);

// ---------- utilidades
export const norm = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
export const slug = s => norm(s).replace(/ /g, "-").slice(0, 70);
const sleep = ms => new Promise(r => setTimeout(r, ms));
export function km(a, b) { const R = 6371, r = x => x * Math.PI / 180; const dLa = r(b.lat - a.lat), dLo = r(b.lng - a.lng); const h = Math.sin(dLa / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); }
const titleCase = s => s && s === s.toUpperCase() && /[A-Z]{4}/.test(s) ? s.toLowerCase().replace(/(^|\s|\.|-)([a-záéíóúñü])/g, (m, a, b) => a + b.toUpperCase()) : s;

// ---------- Overpass
const MIRRORS = (env.OVERPASS_URLS || "https://overpass-api.de/api/interpreter,https://overpass.kumi.systems/api/interpreter,https://overpass.private.coffee/api/interpreter").split(",");
let mirror = 0;
async function overpass(q, { timeout = 180 } = {}) {
  let last;
  for (let attempt = 0; attempt < 6; attempt++) {
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
async function citiesFor(cc) {
  const els = await overpass(`area["ISO3166-1"="${cc}"][admin_level=2]->.a;node(area.a)["place"~"^(city|town)$"]["population"];out body;`, { timeout: 120 });
  const out = [];
  for (const e of els) {
    const pop = parseInt(String(e.tags.population || "").replace(/[^\d]/g, ""), 10);
    const name = e.tags["name:es"] || e.tags.name;
    if (!name || !(pop >= MIN_POP) || e.lat == null) continue;
    out.push({ name, lat: +e.lat.toFixed(5), lng: +e.lon.toFixed(5), pop });
  }
  // las ciudades muy cercanas a una más grande (conurbados) se escanean dentro de la grande
  out.sort((a, b) => b.pop - a.pop);
  const kept = [];
  for (const c of out) if (!kept.some(k => km(k, c) < radiusKm(k.pop) * 0.6)) kept.push(c);
  return kept;
}
export const radiusKm = pop => pop >= 3e6 ? 28 : pop >= 1e6 ? 18 : pop >= 4e5 ? 12 : pop >= 1.5e5 ? 8 : 5;

// ---------- qué es un colegio privado
const PUBLIC_RE = new RegExp([
  "\\b(n[°ºo]?\\.?|nro\\.?|num\\.?|numero)\\s*\\d", "\\bi e\\b(?! p)", "institucion educativa (?!privada)", "\\b[a-f]-?\\s?\\d{1,4}\\b", "\\bno\\.\\s*\\d",
  "escuela (primaria|secundaria|tecnica|normal|rural|urbana|oficial|publica|fiscal|provincial|municipal|nacional|federal|estatal|distrital)",
  "telesecundaria", "\\bconafe\\b", "\\bcetis\\b", "\\bcbtis\\b", "\\bcbta\\b", "\\bconalep\\b", "\\bcecyt", "\\bcobach", "colegio de bachilleres", "\\bdgeti\\b",
  "\\bcetmar\\b", "\\bemsad\\b", "\\bcecati\\b", "\\bcam\\b", "\\busaer\\b", "\\bcendi\\b", "\\bcaic\\b", "\\bpronoei\\b", "\\bcebe\\b", "\\bceba\\b", "\\bprite\\b",
  "liceo (bicentenario|municipal|publico|politecnico)", "escuela basica", "instituto nacional", "colegio nacional", "colegio provincial", "escuela de educacion (secundaria|primaria|tecnica|especial)",
  "universidad (nacional|autonoma|estatal|publica|tecnologica nacional)", "\\bunam\\b", "\\bipn\\b", "\\bliceo departamental", "\\bescuela publica", "\\bjardin de ninos (federal|estatal)",
].join("|"), "i");
const PRIVATE_RE = /\b(colegio|instituto|school|college|academy|academia|liceo|montessori|waldorf|bilingue|bilingual|british|american|britanico|americano|aleman|frances|italiano|ingles|internacional|international|iep|i e p|cep|cebp|kinder|preparatoria|prepa|centro educativo|complejo educativo|gimnasio|lycee|deutsche|scuola|universidad|university)\b/i;
const RELIGIOUS_RE = /\b(san|santa|santo|sagrado|maria|marista|lasalle|la salle|salesian|jesuit|cristo|cristian|adventista|evangel|catolic|parroquial|inmaculad|corazon|guadalupe|teresa|ignacio|agustin|franciscan|dominic|bautista|anglican|hebreo|judio|hebrew)\b/i;
const INTL_RE = /\b(bilingue|bilingual|british|american|britanico|americano|aleman|frances|italiano|internacional|international|lycee|deutsche|scuola|english|ingles|cambridge|ib)\b/i;

export function classify(tags) {
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

const pick = (t, ...ks) => { for (const k of ks) if (t[k]) return String(t[k]).split(";")[0].trim(); return ""; };
function fromOsm(e, city, cc) {
  const t = e.tags || {};
  const c = classify(t); if (!c) return null;
  const lat = e.lat ?? e.center?.lat, lng = e.lon ?? e.center?.lon;
  if (lat == null) return null;
  const street = [pick(t, "addr:street"), pick(t, "addr:housenumber")].filter(Boolean).join(" ");
  const addr = pick(t, "addr:full") || [street, pick(t, "addr:suburb", "addr:neighbourhood")].filter(Boolean).join(", ");
  let web = pick(t, "website", "contact:website", "url");
  if (web && !/^https?:\/\//.test(web)) web = "https://" + web;
  return {
    name: titleCase(String(t.name).trim()), city: city.name, country: COUNTRIES[cc], lat: +lat.toFixed(6), lng: +lng.toFixed(6),
    addr: addr || "", phone: pick(t, "phone", "contact:phone", "contact:mobile"), web, email: pick(t, "email", "contact:email"),
    levels: c.levels, opp: c.opp, private: c.private, src: "osm", osm: `${e.type[0]}${e.id}`, found: today,
  };
}

// ---------- unir con la base existente
function matchExisting(list, idx, s) {
  const n = norm(s.name);
  if (s.osm && idx.osm.has(s.osm)) return idx.osm.get(s.osm);
  for (const x of idx.byName.get(n) || []) if (x.country === s.country && km(x, s) < 2) return x;
  const near = list.filter(x => x.country === s.country && Math.abs(x.lat - s.lat) < 0.003 && Math.abs(x.lng - s.lng) < 0.003);
  const toks = new Set(n.split(" ").filter(w => w.length > 3));
  for (const x of near) { const xt = norm(x.name).split(" ").filter(w => w.length > 3); if (xt.length && xt.filter(w => toks.has(w)).length / xt.length >= 0.5) return x; }
  return null;
}
function buildIndex(list) {
  const idx = { osm: new Map(), byName: new Map(), ids: new Set() };
  for (const s of list) { if (s.osm) idx.osm.set(s.osm, s); const n = norm(s.name); if (!idx.byName.has(n)) idx.byName.set(n, []); idx.byName.get(n).push(s); idx.ids.add(s.id); }
  return idx;
}
function addTo(list, idx, s) {
  let id = `${slug(s.city)}-${slug(s.name)}`, i = 2;
  while (idx.ids.has(id)) id = `${slug(s.city)}-${slug(s.name)}-${i++}`;
  const rec = { id, ...s };
  list.push(rec); idx.ids.add(id); if (rec.osm) idx.osm.set(rec.osm, rec);
  const n = norm(rec.name); if (!idx.byName.has(n)) idx.byName.set(n, []); idx.byName.get(n).push(rec);
  return rec;
}

// ---------- enriquecimiento
async function placesLookup(s) {
  const key = env.GOOGLE_MAPS_API_KEY; if (!key) return null;
  const r = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST", signal: AbortSignal.timeout(15000),
    headers: { "content-type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": "places.id,places.displayName,places.location,places.rating,places.userRatingCount,places.nationalPhoneNumber,places.internationalPhoneNumber,places.websiteUri,places.photos.name,places.formattedAddress,places.googleMapsUri" },
    body: JSON.stringify({ textQuery: `${s.name}, ${s.city}, ${s.country}`, languageCode: "es", maxResultCount: 3, locationBias: { circle: { center: { latitude: s.lat, longitude: s.lng }, radius: 1500 } } }),
  });
  if (!r.ok) throw new Error(`Places ${r.status}`);
  const j = await r.json();
  const p = (j.places || []).find(p => p.location && km(s, { lat: p.location.latitude, lng: p.location.longitude }) < 1.5);
  return p || null;
}
async function ogImage(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: "follow", headers: { "user-agent": "Mozilla/5.0 (compatible; OrderBrain-Radar/1.0)", accept: "text/html" } });
  if (!r.ok || !/html/.test(r.headers.get("content-type") || "")) return null;
  const html = (await r.text()).slice(0, 300000);
  const m = html.match(/<meta[^>]+(?:property|name)=["'](?:og:image|og:image:url|twitter:image)["'][^>]*content=["']([^"']+)["']/i) || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:image|twitter:image)["']/i);
  if (!m) return null;
  try { const u = new URL(m[1].replace(/&amp;/g, "&"), r.url); return /^https:/.test(u.href) ? u.href : null; } catch { return null; }
}
async function aiAssess(batch) {
  const key = env.ANTHROPIC_API_KEY; if (!key || !batch.length) return {};
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", signal: AbortSignal.timeout(90000),
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: env.ANTHROPIC_MODEL || "claude-sonnet-5-5", max_tokens: 4000, messages: [{ role: "user", content:
      `Sos SDR senior de OrderEAT (software para la cafetería escolar: app para que las familias carguen saldo, punto de venta sin efectivo, reportes). Para cada colegio de la lista, estimá solo con el nombre, la ciudad y los datos dados: fit (alto, medio o bajo) para OrderEAT, privado (si, probable, no) y angulo: una frase corta y concreta para abrir la llamada. No inventes datos. Respondé solo JSON: {"<id>": {"fit": "...", "privado": "...", "angulo": "..."}}.\n\n` +
      batch.map(s => `${s.id} | ${s.name} | ${s.city}, ${s.country}${s.levels?.length ? " | niveles: " + s.levels.join(", ") : ""}${s.web ? " | web: " + s.web : ""}`).join("\n") }] }),
  });
  if (!r.ok) throw new Error(`Claude ${r.status}`);
  const j = await r.json();
  const t = (j.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  const m = t.match(/\{[\s\S]*\}/); return m ? JSON.parse(m[0]) : {};
}

// ---------- corrida
async function main() {
  const schools = JSON.parse(fs.readFileSync(SCHOOLS_FILE, "utf8"));
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  let state = { cities: {}, citiesAt: {}, scanned: {}, runs: [] };
  try { state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) }; } catch {}
  const idx = buildIndex(schools);
  const run = { at: new Date().toISOString(), cities: [], added: 0, enriched: 0, photos: 0, ai: 0, errors: [] };
  const added = [];

  // 1. listas de ciudades (se renuevan cada 60 días)
  for (const cc of Object.keys(COUNTRIES)) {
    if (ONLY.length && !ONLY.includes(cc)) continue;
    const at = state.citiesAt[cc];
    if (state.cities[cc]?.length && at && (Date.now() - Date.parse(at)) / 864e5 < 60) continue;
    try {
      const list = await citiesFor(cc);
      if (!list.length) throw new Error("Overpass no devolvió ciudades");
      state.cities[cc] = list; state.citiesAt[cc] = new Date().toISOString();
      log(`${cc}: ${list.length} ciudades de más de ${MIN_POP} habitantes`);
    }
    catch (e) { run.errors.push(`ciudades ${cc}: ${e.message}`); log("error ciudades", cc, e.message); }
    await sleep(2000);
  }

  // 2. cola: primero ciudades nunca escaneadas (las más grandes primero), después las más viejas
  const queue = [];
  for (const [cc, list] of Object.entries(state.cities)) {
    if (ONLY.length && !ONLY.includes(cc)) continue;
    for (const c of list) {
      const k = `${cc}|${c.name}`, at = state.scanned[k];
      if (at && (Date.now() - Date.parse(at)) / 864e5 < RESCAN_DAYS) continue;
      queue.push({ cc, c, k, at: at || "", rank: at ? Date.parse(at) : -c.pop });
    }
  }
  queue.sort((a, b) => (a.at ? 1 : 0) - (b.at ? 1 : 0) || a.rank - b.rank);
  log(`${queue.length} ciudades pendientes`);

  // 3. escanear mientras quede tiempo (se reserva un 35% para enriquecer)
  for (const q of queue) {
    if (timeLeft() < MINUTES * 60e3 * 0.35) break;
    const R = Math.round(radiusKm(q.c.pop) * 1000);
    try {
      const els = await overpass(`nwr["amenity"~"^(school|college|university)$"]["name"](around:${R},${q.c.lat},${q.c.lng});out center tags;`);
      let n = 0, upd = 0;
      for (const e of els) {
        const s = fromOsm(e, q.c, q.cc); if (!s) continue;
        const ex = matchExisting(schools, idx, s);
        if (ex) {
          let ch = false;
          for (const f of ["phone", "web", "email", "addr"]) if (!ex[f] && s[f]) { ex[f] = s[f]; ch = true; }
          if (!ex.osm) { ex.osm = s.osm; idx.osm.set(s.osm, ex); ch = true; }
          if (!ex.levels?.length && s.levels.length) { ex.levels = s.levels; ch = true; }
          if (ch) upd++;
          continue;
        }
        added.push(addTo(schools, idx, s)); n++;
      }
      state.scanned[q.k] = new Date().toISOString();
      run.cities.push({ cc: q.cc, city: q.c.name, found: n, updated: upd, osm: els.length });
      run.added += n;
      log(`${q.cc} ${q.c.name}: ${els.length} en el mapa, ${n} nuevos, ${upd} actualizados`);
    } catch (e) { run.errors.push(`${q.k}: ${e.message}`); log("error", q.k, e.message); }
    await sleep(1500);
  }

  // 4. Google Places para los nuevos (y los que no tienen teléfono), si hay clave
  if (env.GOOGLE_MAPS_API_KEY) {
    const todo = [...added, ...schools.filter(s => !s.gplace && !s.phone && s.src === "osm" && !added.includes(s))].slice(0, PLACES_MAX);
    for (const s of todo) {
      if (timeLeft() < 60e3) break;
      try {
        const p = await placesLookup(s);
        s.gplace = p ? p.id : "-";
        if (p) {
          if (p.rating) s.rating = `${String(p.rating).replace(".", ",")} (${p.userRatingCount || 0})`;
          s.phone = s.phone || p.internationalPhoneNumber || p.nationalPhoneNumber || "";
          s.web = s.web || p.websiteUri || "";
          if (!s.addr && p.formattedAddress) s.addr = p.formattedAddress.split(",").slice(0, 2).join(",");
          if (p.photos?.length) { s.photos = p.photos.slice(0, 4).map(x => x.name); run.photos++; }
          if (p.googleMapsUri) s.maps = p.googleMapsUri;
          run.enriched++;
        }
      } catch (e) { run.errors.push(`places ${s.id}: ${e.message}`); if (/40[13]/.test(e.message)) break; }
      await sleep(150);
    }
  }

  // 5. imagen de la web del colegio
  const webTodo = schools.filter(s => s.web && s.img === undefined).slice(0, WEB_MAX);
  for (const s of webTodo) {
    if (timeLeft() < 45e3) break;
    try { s.img = (await ogImage(s.web)) || ""; if (s.img) run.photos++; } catch { s.img = ""; }
  }

  // 6. evaluación con IA de los nuevos
  if (env.ANTHROPIC_API_KEY) {
    const todo = schools.filter(s => s.src === "osm" && !s.fit).slice(0, AI_MAX);
    for (let i = 0; i < todo.length && timeLeft() > 30e3; i += 40) {
      const batch = todo.slice(i, i + 40);
      try {
        const res = await aiAssess(batch);
        for (const s of batch) {
          const a = res[s.id]; if (!a) continue;
          s.fit = ["alto", "medio", "bajo"].includes(a.fit) ? a.fit : "medio";
          if (a.privado === "no") s.private = "no";
          if (a.angulo && !s.pitch) s.pitch = String(a.angulo).slice(0, 220);
          run.ai++;
        }
      } catch (e) { run.errors.push(`ia: ${e.message}`); break; }
    }
  }

  // 7. guardar
  const cleaned = schools.filter(s => s.private !== "no");
  state.runs = [{ ...run, minutes: +((Date.now() - T0) / 60e3).toFixed(1), total: cleaned.length, cities: run.cities.slice(0, 80), errors: run.errors.slice(0, 20) }, ...(state.runs || [])].slice(0, 40);
  log(`fin: ${run.added} nuevos, ${run.enriched} enriquecidos con Google, ${run.photos} fotos, ${run.ai} evaluados con IA, ${run.errors.length} errores. Total ${cleaned.length}.`);
  if (DRY) { log("--dry: no se escribe nada"); return; }
  fs.writeFileSync(SCHOOLS_FILE, JSON.stringify(cleaned, null, 1) + "\n");
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1) + "\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main().catch(e => { console.error(e); process.exit(1); });
