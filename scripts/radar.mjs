#!/usr/bin/env node
// Radar de OrderBrain: agente que recorre todas las ciudades de todos los países y busca colegios privados
// que todavía no están en la base. Corre en GitHub Actions cada 2 horas (.github/workflows/radar.yml).
//
// Fuentes:
//  - OpenStreetMap (Overpass): ciudades por país y colegios alrededor de cada ciudad. Gratis, sin clave.
//  - Google Places (opcional, GOOGLE_MAPS_API_KEY): rating, teléfono, web y fotos de los colegios nuevos.
//  - Web del colegio (lib/enrich.js): teléfono, WhatsApp, mail e imagen de portada (og:image).
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
const MINUTES = Math.min(Math.max(Number(arg("minutes", env.RADAR_MINUTES || 20)) || 20, 1), 35);
const MIN_POP = Number(env.RADAR_MIN_POP || 40000);
const RESCAN_DAYS = Number(env.RADAR_RESCAN_DAYS || 30);
const PLACES_MAX = Number(env.RADAR_PLACES_MAX || 150);
const WEB_MAX = Number(env.RADAR_WEB_MAX || 60);
const AI_MAX = Number(env.RADAR_AI_MAX || 120);
const STUDY_MAX = Number(env.RADAR_STUDY_MAX || 8);
const STUDY_DIR = path.join(ROOT, "data", "studies");
const T0 = Date.now();
const timeLeft = () => MINUTES * 60e3 - (Date.now() - T0);
const today = new Date().toISOString().slice(0, 10);
const log = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(0)}s]`, ...a);

export const COUNTRIES = {
  MX: "México", PE: "Perú", AR: "Argentina", CL: "Chile", UY: "Uruguay", GT: "Guatemala", CR: "Costa Rica",
  CO: "Colombia", EC: "Ecuador", BO: "Bolivia", PY: "Paraguay", VE: "Venezuela", PA: "Panamá", DO: "República Dominicana",
  HN: "Honduras", SV: "El Salvador", NI: "Nicaragua", PR: "Puerto Rico", ES: "España",
};
import { notSchool, norm, slug, sleep, km, titleCase, overpass as overpassRaw, citiesFor as citiesForRaw, radiusKm, classify, fromOsm as fromOsmRaw, keyTokens, matchExisting, buildIndex, addTo } from "../lib/scan.js";
export { norm, slug, km, radiusKm, classify };
import { webInfo } from "../lib/enrich.js";
// En el radar, Overpass nunca pasa el tiempo de la corrida.
const overpass = (q, o = {}) => overpassRaw(q, { ...o, deadline: T0 + MINUTES * 60e3 });
const citiesFor = cc => citiesForRaw(cc, { minPop: MIN_POP, deadline: T0 + MINUTES * 60e3 });
const fromOsm = (e, city, cc) => fromOsmRaw(e, city, cc, COUNTRIES[cc], today);
const ONLY = (arg("countries", env.RADAR_COUNTRIES || "") || "").split(",").map(s => s.trim().toUpperCase()).filter(Boolean);


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
  // tiene que estar a menos de 300 m y compartir las palabras propias del nombre
  const mine = keyTokens(s.name);
  const p = (j.places || []).find(p => {
    if (!p.location || km(s, { lat: p.location.latitude, lng: p.location.longitude }) > 0.3) return false;
    const theirs = keyTokens(p.displayName?.text || "");
    if (!mine.length) return norm(p.displayName?.text) === norm(s.name);
    return theirs.filter(w => mine.includes(w)).length / mine.length >= 0.5;
  });
  return p || null;
}
// Evaluación rápida de colegios nuevos (encaje, si es privado y ángulo), con salida estructurada.
async function aiAssess(batch) {
  if (!env.ANTHROPIC_API_KEY || !batch.length) return {};
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic();
  const res = await client.messages.create({
    model: env.ANTHROPIC_MODEL || "claude-opus-5-5", max_tokens: 16000,
    output_config: { effort: "low", format: { type: "json_schema", schema: {
      type: "object", additionalProperties: false, required: ["items"],
      properties: { items: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "fit", "privado", "angulo"],
        properties: { id: { type: "string" }, fit: { type: "string", enum: ["alto", "medio", "bajo"] }, privado: { type: "string", enum: ["si", "probable", "no"] }, angulo: { type: "string" } } } } },
    } } },
    messages: [{ role: "user", content: `Sos SDR senior de OrderEAT (software para la cafetería escolar: app para que las familias carguen saldo, punto de venta sin efectivo, reportes). Para cada colegio de la lista, estimá solo con el nombre, la ciudad y los datos dados: fit (alto, medio o bajo) para OrderEAT, privado (si, probable o no) y angulo: una frase corta y concreta para abrir la llamada. No inventes datos.\n\n` +
      batch.map(s => `${s.id} | ${s.name} | ${s.city}, ${s.country}${s.levels?.length ? " | niveles: " + s.levels.join(", ") : ""}${s.web ? " | web: " + s.web : ""}`).join("\n") }],
  });
  if (res.stop_reason !== "end_turn") throw new Error(`respuesta incompleta (${res.stop_reason})`);
  const t = res.content.filter(b => b.type === "text").map(b => b.text).join("");
  return Object.fromEntries((JSON.parse(t).items || []).map(x => [x.id, x]));
}

// ---------- corrida
async function main() {
  const original = fs.readFileSync(SCHOOLS_FILE, "utf8");
  const schools = JSON.parse(original);
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  let state = { cities: {}, citiesAt: {}, scanned: {}, failed: {}, runs: [] };
  try { state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) }; } catch {}
  const idx = buildIndex(schools);
  const run = { at: new Date().toISOString(), cities: [], added: 0, enriched: 0, photos: 0, contacts: 0, ai: 0, studies: 0, errors: [] };
  const added = [];
  let citiesFetched = 0;
  // guarda lo hecho; también si GitHub corta la corrida (SIGTERM)
  const save = (reason = "") => {
    const json = JSON.stringify(schools, null, 1) + "\n";
    const changed = json !== original;
    if (!changed && !run.cities.length && !citiesFetched) { log("sin cambios: no se escribe nada"); return; }
    const total = schools.filter(s => s.private !== "no" && !notSchool(norm(s.name))).length;
    state.runs = [{ ...run, minutes: +((Date.now() - T0) / 60e3).toFixed(1), total, cities: run.cities.slice(0, 80), errors: run.errors.slice(0, 20), ...(reason ? { cut: reason } : {}) }, ...(state.runs || [])].slice(0, 40);
    if (DRY) { log("--dry: no se escribe nada"); return; }
    if (changed) fs.writeFileSync(SCHOOLS_FILE, json);
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1) + "\n");
  };
  process.once("SIGTERM", () => { log("corrida cortada: guardo lo hecho"); save("cortada"); process.exit(0); });

  // 1. listas de ciudades (se renuevan cada 60 días). Como mucho 2 países por corrida,
  //    para que siempre quede tiempo de escanear colegios (las listas de países grandes tardan).
  let listTries = 0;
  for (const cc of Object.keys(COUNTRIES)) {
    if (ONLY.length && !ONLY.includes(cc)) continue;
    const at = state.citiesAt[cc];
    if (state.cities[cc]?.length && at && (Date.now() - Date.parse(at)) / 864e5 < 60) continue;
    if (timeLeft() < MINUTES * 60e3 * 0.5 || listTries >= 2) break;
    listTries++;
    try {
      const list = await citiesFor(cc);
      if (!list.length) throw new Error("Overpass no devolvió ciudades");
      state.cities[cc] = list; state.citiesAt[cc] = new Date().toISOString(); citiesFetched++;
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
      const k = `${cc}|${c.id ? "n" + c.id : c.name}`, at = state.scanned[k] || state.scanned[`${cc}|${c.name}`];
      if (at && (Date.now() - Date.parse(at)) / 864e5 < RESCAN_DAYS) continue;
      const f = state.failed?.[k];
      // una ciudad que falla espera más cada vez (6 h, 12 h, 24 h…) y va al final de la cola
      if (f && Date.now() - Date.parse(f.at) < Math.min(2 ** (f.n - 1) * 6, 168) * 3600e3) continue;
      queue.push({ cc, c, k, at: at || "", failed: f?.n || 0, rank: at ? Date.parse(at) : -c.pop });
    }
  }
  queue.sort((a, b) => a.failed - b.failed || (a.at ? 1 : 0) - (b.at ? 1 : 0) || a.rank - b.rank);
  log(`${queue.length} ciudades pendientes`);

  // 3. escanear mientras quede tiempo (se reserva un 35% para enriquecer)
  for (const q of queue) {
    if (timeLeft() < MINUTES * 60e3 * 0.35) break;
    const R = Math.round(radiusKm(q.c.pop) * 1000);
    try {
      // (area.a): solo lo que está dentro del país, para no sumar colegios del otro lado de la frontera
      const els = await overpass(`area["ISO3166-1"="${q.cc}"]["boundary"="administrative"]->.a;nwr["amenity"~"^(school|college|university)$"]["name"](around:${R},${q.c.lat},${q.c.lng})(area.a);out center tags;`);
      let n = 0, upd = 0;
      for (const e of els) {
        const s = fromOsm(e, q.c, q.cc); if (!s) continue;
        const hit = matchExisting(schools, idx, s);
        if (hit) {
          const ex = hit.x; let ch = false;
          // solo se completan datos cuando es seguro que es el mismo colegio
          if (hit.exact) {
            for (const f of ["phone", "web", "email", "addr"]) if (!ex[f] && s[f]) { ex[f] = s[f]; ch = true; }
            if (!ex.osm) { ex.osm = s.osm; idx.osm.set(s.osm, ex); ch = true; }
          }
          if (!ex.levels?.length && s.levels.length) { ex.levels = s.levels; ch = true; }
          if (ch) upd++;
          continue;
        }
        added.push(addTo(schools, idx, s)); n++;
      }
      state.scanned[q.k] = new Date().toISOString();
      if (state.failed) delete state.failed[q.k];
      run.cities.push({ cc: q.cc, city: q.c.name, found: n, updated: upd, osm: els.length });
      run.added += n;
      log(`${q.cc} ${q.c.name}: ${els.length} en el mapa, ${n} nuevos, ${upd} actualizados`);
    } catch (e) {
      run.errors.push(`${q.k}: ${e.message}`); log("error", q.k, e.message);
      if (!/sin tiempo/.test(e.message)) { state.failed = state.failed || {}; state.failed[q.k] = { n: (state.failed[q.k]?.n || 0) + 1, at: new Date().toISOString(), error: String(e.message).slice(0, 120) }; }
    }
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
          // las fotos se piden al abrir la ficha con el id del lugar (los nombres de foto de Google vencen)
          if (p.photos?.length) run.photos++;
          if (p.googleMapsUri) s.maps = p.googleMapsUri;
          run.enriched++;
        }
      } catch (e) { run.errors.push(`places ${s.id}: ${e.message}`); if (/40[13]/.test(e.message)) break; }
      await sleep(150);
    }
  }

  // 5. web del colegio: contactos e imagen, sin pisar lo que ya hay. Primero los que no tienen teléfono.
  //    Si la web no se pudo leer, se reintenta a los 14 días.
  const retryOk = s => !s.imgTry || (Date.now() - Date.parse(s.imgTry)) / 864e5 > 14;
  const webTodo = schools.filter(s => s.web && !s.webAt && retryOk(s)).sort((a, b) => !!a.phone - !!b.phone).slice(0, WEB_MAX);
  for (const s of webTodo) {
    if (timeLeft() < 45e3) break;
    try {
      const w = await webInfo(s.web, AbortSignal.timeout(15000));
      if (s.img === undefined) { s.img = w.image || ""; if (s.img) run.photos++; }
      let ch = false;
      if (w.phone && !s.phone) { s.phone = w.phone; ch = true; }
      if (w.whatsapp && !s.whatsapp) { s.whatsapp = w.whatsapp; if (!s.phone) s.phone = w.whatsapp; ch = true; }
      if (w.email && !s.email) { s.email = w.email; ch = true; }
      if (ch) run.contacts++;
      s.webAt = today; delete s.imgTry;
    } catch { s.imgTry = today; }
  }

  // 6. evaluación con IA de los nuevos
  if (env.ANTHROPIC_API_KEY) {
    const todo = schools.filter(s => s.src === "osm" && !s.fit).slice(0, AI_MAX);
    for (let i = 0; i < todo.length && timeLeft() > 30e3; i += 25) {
      const batch = todo.slice(i, i + 25);
      try {
        const res = await aiAssess(batch);
        for (const s of batch) {
          const a = res[s.id]; if (!a) continue;
          s.fit = ["alto", "medio", "bajo"].includes(a.fit) ? a.fit : "medio";
          // no se borra: queda marcado y la app lo oculta (así el radar no lo vuelve a sumar)
          if (a.privado === "no") s.private = "no";
          if (a.angulo && !s.pitch) s.pitch = String(a.angulo).slice(0, 220);
          run.ai++;
        }
      } catch (e) { run.errors.push(`ia: ${e.message}`); if (/401|403|credit|billing/i.test(e.message)) break; }
    }
  }

  // 7. estudios de prospección (Claude con búsqueda web) para los mejores colegios sin estudio
  if (env.ANTHROPIC_API_KEY && STUDY_MAX > 0) {
    const { research } = await import("../lib/study.js");
    fs.mkdirSync(STUDY_DIR, { recursive: true });
    const has = s => fs.existsSync(path.join(STUDY_DIR, s.id + ".json"));
    const rank = s => (s.fit === "alto" ? 30 : s.fit === "bajo" ? -30 : 0) + (s.opp || []).length * 6 + (s.web ? 8 : 0) + (s.phone ? 6 : 0) + (s.pitch ? 4 : 0) + (s.found === today ? 5 : 0) + (s.src !== "osm" ? 12 : 0);
    // sin gastar estudios en lo que no es un colegio (la app ya lo oculta)
    const todo = schools.filter(s => s.private !== "no" && !notSchool(norm(s.name)) && s.fit !== "bajo" && !has(s)).sort((a, b) => rank(b) - rank(a)).slice(0, STUDY_MAX);
    for (const s of todo) {
      if (timeLeft() < 150e3) break;
      try {
        const st = await research(s);
        if (!DRY) fs.writeFileSync(path.join(STUDY_DIR, s.id + ".json"), JSON.stringify(st, null, 1) + "\n");
        if (st.angulo) s.pitch = String(st.angulo).slice(0, 240);
        if (st.fit) s.fit = st.fit;
        s.phone = s.phone || st.contacto?.telefonos?.[0] || "";
        s.email = s.email || st.contacto?.emails?.[0] || "";
        if (!s.web && /^https?:\/\//.test(st.contacto?.web || "")) s.web = st.contacto.web;
        s.studied = st.at.slice(0, 10);
        run.studies++;
        log(`estudio: ${s.name} (${st.fit}, ${st.busquedas} búsquedas)`);
      } catch (e) { run.errors.push(`estudio ${s.id}: ${e.message}`); log("error estudio", s.id, e.message); if (/401|403|credit|billing/i.test(e.message)) break; }
    }
  }

  // 8. guardar
  log(`fin: ${run.added} nuevos, ${run.enriched} enriquecidos con Google, ${run.photos} fotos, ${run.contacts} con contactos de su web, ${run.ai} evaluados con IA, ${run.studies} estudios, ${run.errors.length} errores.`);
  save();
}

// ---------- --merge <carpeta>: une el resultado de la corrida con la versión más nueva de main
// (la usa el workflow antes de hacer push, para no pisar ediciones hechas a mano mientras corría el radar).
// Nunca pisa un dato que ya existe: solo suma colegios nuevos y completa campos vacíos.
// Campos que solo escribe el radar: ahí manda la versión de la corrida.
const RADAR_OWNED = ["private", "fit", "studied", "img", "imgTry", "webAt", "gplace"];
function mergeFrom(dir) {
  const mine = JSON.parse(fs.readFileSync(path.join(dir, "schools.json"), "utf8"));
  const latest = JSON.parse(fs.readFileSync(SCHOOLS_FILE, "utf8"));
  const byId = new Map(latest.map(s => [s.id, s])), byOsm = new Map(latest.filter(s => s.osm).map(s => [s.osm, s]));
  let added = 0, filled = 0;
  for (const r of mine) {
    const cur = byId.get(r.id) || (r.osm && byOsm.get(r.osm));
    if (!cur) { latest.push(r); byId.set(r.id, r); added++; continue; }
    for (const [k, v] of Object.entries(r)) {
      const empty = cur[k] === undefined || cur[k] === "" || (Array.isArray(cur[k]) && !cur[k].length);
      if (RADAR_OWNED.includes(k) ? cur[k] !== v : empty && v !== undefined && v !== "" && !(Array.isArray(v) && !v.length)) { cur[k] = v; filled++; }
    }
  }
  fs.writeFileSync(SCHOOLS_FILE, JSON.stringify(latest, null, 1) + "\n");
  const st = path.join(dir, "state.json"); if (fs.existsSync(st)) fs.copyFileSync(st, STATE_FILE);
  const sd = path.join(dir, "studies");
  if (fs.existsSync(sd)) { fs.mkdirSync(STUDY_DIR, { recursive: true }); for (const f of fs.readdirSync(sd)) if (f.endsWith(".json")) fs.copyFileSync(path.join(sd, f), path.join(STUDY_DIR, f)); }
  console.log(`merge: ${added} colegios nuevos, ${filled} datos completados`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const m = arg("merge", "");
  if (m) mergeFrom(m); else main().catch(e => { console.error(e); process.exit(1); });
}
