// Datos locales: colegios (archivo del repo), cache del cruce con Pipedrive y registro de contactos.
// Pipedrive es la fuente de verdad. El cruce y los contactos se guardan:
//  - en Redis (Upstash / Vercel Marketplace) si están KV_REST_API_URL y KV_REST_API_TOKEN: sobrevive a reinicios y
//    se comparte entre instancias (necesario en Vercel);
//  - si no, en archivos dentro de DATA_DIR (por defecto data/; en Vercel, /tmp, que se borra cada tanto).
// Las lecturas son síncronas desde memoria; sync() trae lo nuevo de Redis y flush() espera las escrituras pendientes.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { notSchool, norm } from "./scan.js";

const env = process.env;
const repoData = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
const dataDir = env.DATA_DIR || (env.VERCEL ? "/tmp/orderbrain" : repoData);
try { fs.mkdirSync(dataDir, { recursive: true }); } catch {}
const CACHE_FILE = path.join(dataDir, "cache.json");
const TOUCH_FILE = path.join(dataDir, "touches.json");

// require para que Vercel incluya el archivo en la función.
// Los que el radar marcó como no privados quedan en el archivo (para no volver a sumarlos) pero no se muestran.
// Fuera los públicos marcados y lo que no es un colegio aunque haya entrado antes del filtro estricto
// (institutos de idiomas, facultades, academias de belleza o de manejo…). El archivo del radar no se toca.
const isSchool = s => s.private !== "no" && !notSchool(norm(s.name));
const raw = createRequire(import.meta.url)("../data/schools.json");
export const schools = raw.filter(isSchool);
// elementos del mapa que el radar descartó (públicos o no colegios): el buscador no los vuelve a sumar
export const hiddenOsm = new Set(raw.filter(s => s.osm && !isSchool(s)).map(s => s.osm));
export const byId = new Map(schools.map(s => [s.id, s]));

// ---------- Redis por REST (sin dependencias)
const R_URL = (env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL || "").replace(/\/$/, "");
const R_TOKEN = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN || "";
// El modo demo usa otras claves para no mezclar datos de prueba con los reales.
const P = (env.KV_PREFIX || "ob:") + (env.DEMO_MODE === "1" && !env.PIPEDRIVE_API_TOKEN ? "demo:" : "");
export const kvEnabled = !!(R_URL && R_TOKEN);
export async function kv(cmds) {
  const r = await fetch(`${R_URL}/pipeline`, { method: "POST", headers: { authorization: `Bearer ${R_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(cmds), signal: AbortSignal.timeout(4000) });
  const j = await r.json().catch(() => null);
  if (!r.ok || !Array.isArray(j)) throw new Error(`Redis respondió ${r.status}`);
  return j.map(x => { if (x?.error) throw new Error(`Redis: ${x.error}`); return x?.result; });
}
export const key = k => P + k;
const MAX_TOUCHES = 8000;

const load = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
const timers = {};
const persistFile = (f, data) => { clearTimeout(timers[f]); timers[f] = setTimeout(() => fs.writeFile(f, JSON.stringify(data), () => {}), 400); };

// Escrituras pendientes a Redis: el servidor las espera antes de responder (en Vercel la función se congela después).
const pending = new Set();
function track(p) { const q = p.catch(e => console.warn("No se pudo guardar en Redis:", e.message)).finally(() => pending.delete(q)); pending.add(q); return q; }
export const flush = () => Promise.all([...pending]);

// ---------- cruce colegio ↔ organización
let cache = kvEnabled ? {} : load(CACHE_FILE, {});
// alias: colegios del buscador que después trajo el radar con otro id (mismo elemento del mapa).
// El id viejo apunta al nuevo y se conservan su cruce y sus contactos.
const aliasOf = new Map(), aliasesFor = new Map();
export const getMatch = id => cache[id] || (aliasesFor.get(id) || []).map(a => cache[a]).find(Boolean) || null;
export function setMatch(id, rec) {
  const { created, ...clean } = rec;
  cache[id] = { ...clean, v: MATCH_V, checkedAt: new Date().toISOString() };
  if (kvEnabled) track(kv([["HSET", key("match"), id, JSON.stringify(cache[id])]]));
  else persistFile(CACHE_FILE, cache);
  return created ? { ...cache[id], created } : cache[id];
}
export const allMatches = () => cache;
// Antes de escribir (crear organización, vincular), trae de Redis el cruce de ese colegio por si otra instancia lo cambió.
export async function refreshMatch(id) {
  if (!kvEnabled) return getMatch(id);
  try {
    const [raw] = await kv([["HGET", key("match"), id]]);
    if (raw) { const rec = JSON.parse(raw); const cur = cache[id]; if (!cur || String(rec.checkedAt) >= String(cur.checkedAt)) cache[id] = rec; }
  } catch (e) { console.warn("No se pudo leer Redis:", e.message); }
  return getMatch(id);
}
// Candado corto entre instancias (por ejemplo, para no crear dos veces la misma organización).
export async function withLock(name, fn) {
  if (!kvEnabled) return fn();
  const k = key("lock:" + name);
  for (let i = 0; i < 8; i++) {
    let ok = false;
    try { ok = (await kv([["SET", k, "1", "NX", "EX", "30"]]))[0] === "OK"; } catch { return fn(); }
    if (ok) { try { return await fn(); } finally { await kv([["DEL", k]]).catch(() => {}); } }
    await new Promise(r => setTimeout(r, 750));
  }
  throw Object.assign(new Error("Otra persona está guardando este colegio, probá de nuevo en unos segundos."), { status: 409 });
}
export const STALE_MS = 7 * 864e5;
// MATCH_V: sube cuando cambian las reglas de estado (v2: «Perdido» solo con propuesta, «Contactado sin avance»);
// los cruces guardados con otra versión se vuelven a calcular.
const MATCH_V = 3; // v3: dueño de la organización
export const isFresh = rec => rec?.checkedAt && rec.v === MATCH_V && Date.now() - new Date(rec.checkedAt) < STALE_MS;
// las fichas virtuales (pd-org-…, pd-lead-…) no cuentan: la agenda las abre como fichas de Pipedrive
export const orgToSchool = () => new Map(Object.entries(cache).filter(([id, m]) => m.orgId && !id.startsWith("pd-")).map(([id, m]) => [m.orgId, id]));

// ---------- contactos registrados desde la app (para cadencia, metas y ranking)
let touches = kvEnabled ? [] : load(TOUCH_FILE, []);
const touchIdx = new Map();
const seen = new Set();
const tkey = t => `${t.at}|${t.by}|${t.schoolId}`;
function index(t) { if (!touchIdx.has(t.schoolId)) touchIdx.set(t.schoolId, []); touchIdx.get(t.schoolId).push(t); seen.add(tkey(t)); }
function reindex() { touchIdx.clear(); seen.clear(); touches.sort((a, b) => a.at.localeCompare(b.at)); touches.forEach(index); }
reindex();
export function addTouch(t) {
  const rec = { ...t, text: String(t.text || "").slice(0, 200), at: new Date().toISOString() };
  touches.push(rec); index(rec);
  if (touches.length > 50000) { touches = touches.slice(-50000); reindex(); }
  if (kvEnabled) {
    const k = key("touches");
    track(kv([["ZADD", k, String(Date.parse(rec.at)), JSON.stringify(rec)], ["ZREMRANGEBYRANK", k, "0", String(-MAX_TOUCHES - 1)]]));
  } else persistFile(TOUCH_FILE, touches);
  return rec;
}
export const touchesFor = id => {
  const own = touchIdx.get(id) || [], extra = (aliasesFor.get(id) || []).flatMap(a => touchIdx.get(a) || []);
  return extra.length ? [...own, ...extra].sort((a, b) => a.at.localeCompare(b.at)) : own;
};
export const touchesSince = ms => touches.filter(t => new Date(t.at).getTime() >= ms);

// ---------- sincronización con Redis
let lastTouchSync = 0, lastMatchSync = 0, lastScore = -1, inflight = null;
export function sync({ force = false } = {}) {
  if (!kvEnabled) return Promise.resolve();
  const now = Date.now();
  const wantT = force || now - lastTouchSync > 10e3, wantM = force || now - lastMatchSync > 60e3;
  if (!wantT && !wantM) return Promise.resolve();
  if (inflight) return inflight;
  inflight = (async () => {
    const cmds = [];
    if (wantT) cmds.push(lastScore < 0 ? ["ZRANGE", key("touches"), "0", "-1", "WITHSCORES"] : ["ZRANGEBYSCORE", key("touches"), String(Math.max(0, lastScore - 120e3)), "+inf", "WITHSCORES"]);
    if (wantM) cmds.push(["HGETALL", key("match")]);
    const res = await kv(cmds);
    if (wantT) {
      const arr = res.shift() || [];
      let added = 0;
      for (let i = 0; i < arr.length; i += 2) {
        let t; try { t = JSON.parse(arr[i]); } catch { continue; }
        lastScore = Math.max(lastScore, Number(arr[i + 1]));
        if (!seen.has(tkey(t))) { touches.push(t); added++; }
      }
      if (lastScore < 0) lastScore = 0;
      if (added) reindex();
      lastTouchSync = Date.now();
    }
    if (wantM) {
      const arr = res.shift() || [];
      for (let i = 0; i < arr.length; i += 2) {
        try { const rec = JSON.parse(arr[i + 1]); const cur = cache[arr[i]]; if (!cur || String(rec.checkedAt) > String(cur.checkedAt)) cache[arr[i]] = rec; } catch {}
      }
      lastMatchSync = Date.now();
    }
  })().catch(e => {
    console.warn("No se pudo leer Redis:", e.message);
    // si Redis falla, no volver a esperarlo en cada pedido hasta el próximo intervalo
    if (wantT) lastTouchSync = Date.now(); if (wantM) lastMatchSync = Date.now();
  }).finally(() => { inflight = null; });
  return inflight;
}

// ---------- estudios de prospección (lib/study.js)
// Se leen de Redis (los que se hicieron desde la app), de data/studies/<id>.json (los que hizo el radar)
// o de memoria. Se guardan en Redis si está configurado; si no, en DATA_DIR/studies.
const studyMem = new Map();
const safeId = id => String(id).replace(/[^a-z0-9-]/gi, "").slice(0, 120);
export async function getStudy(id) {
  if (studyMem.has(id)) return studyMem.get(id);
  if (kvEnabled) { try { const [v] = await kv([["HGET", key("study"), id]]); if (v) { const s = JSON.parse(v); studyMem.set(id, s); return s; } } catch (e) { console.warn("No se pudo leer el estudio:", e.message); } }
  for (const dir of [path.join(repoData, "studies"), path.join(dataDir, "studies")]) {
    try { const s = JSON.parse(fs.readFileSync(path.join(dir, safeId(id) + ".json"), "utf8")); studyMem.set(id, s); return s; } catch {}
  }
  return null;
}
export async function setStudy(id, study) {
  studyMem.set(id, study);
  if (kvEnabled) return track(kv([["HSET", key("study"), id, JSON.stringify(study)]]));
  try { const dir = path.join(dataDir, "studies"); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, safeId(id) + ".json"), JSON.stringify(study)); } catch {}
}

// ---------- colegios sumados desde el buscador de la app (fuera de la corrida del radar)
// Se agregan a `schools` en memoria y se guardan en Redis (o en DATA_DIR/extra-schools.json).
const EXTRA_FILE = path.join(dataDir, "extra-schools.json");
// si el radar ya lo sumó al archivo (mismo elemento del mapa), gana el del archivo
const osmRec = new Map(schools.filter(s => s.osm).map(s => [s.osm, s]));
function pushSchool(s) {
  if (byId.has(s.id) || !isSchool(s)) return false;
  const same = s.osm && osmRec.get(s.osm);
  if (same) {
    if (same.id !== s.id && !aliasOf.has(s.id)) {
      aliasOf.set(s.id, same.id); byId.set(s.id, same);
      if (!aliasesFor.has(same.id)) aliasesFor.set(same.id, []); aliasesFor.get(same.id).push(s.id);
    }
    return false;
  }
  schools.push(s); byId.set(s.id, s); if (s.osm) osmRec.set(s.osm, s); return true;
}
export const canonicalId = id => aliasOf.get(id) || id;
if (!kvEnabled) { try { for (const s of JSON.parse(fs.readFileSync(EXTRA_FILE, "utf8"))) pushSchool(s); } catch {} }
const extras = new Map();
export function addSchools(list) {
  const added = [];
  for (const s of list) if (pushSchool(s)) { added.push(s); extras.set(s.id, s); }
  if (!added.length) return added;
  if (kvEnabled) track(kv([["HSET", key("schools:extra"), ...added.flatMap(s => [s.id, JSON.stringify(s)])]]));
  else persistFile(EXTRA_FILE, [...extras.values()]);
  return added;
}
// Lo que el buscador descartó al verificar (no es colegio, público, cerrado): se suma a hiddenOsm para no volver a
// proponerlo ni gastar otra vez en verificarlo. Se guardan los últimos MAX_DROPPED en Redis (o en DATA_DIR/dropped-osm.json).
const DROP_FILE = path.join(dataDir, "dropped-osm.json"), MAX_DROPPED = 5000;
let dropped = kvEnabled ? [] : load(DROP_FILE, []);
dropped.forEach(o => hiddenOsm.add(o));
export function dropOsm(ids) {
  const add = [...new Set(ids.filter(Boolean).map(String))].filter(o => !hiddenOsm.has(o));
  if (!add.length) return;
  add.forEach(o => hiddenOsm.add(o));
  if (kvEnabled) { const k = key("schools:dropped"), now = String(Date.now()); track(kv([["ZADD", k, ...add.flatMap(o => [now, o])], ["ZREMRANGEBYRANK", k, "0", String(-MAX_DROPPED - 1)]])); }
  else { dropped = [...dropped, ...add].slice(-MAX_DROPPED); persistFile(DROP_FILE, dropped); }
}
// Trae los que sumaron (o descartaron) otras instancias (se llama junto con sync()).
let lastExtraSync = 0;
export async function syncExtras() {
  if (!kvEnabled || Date.now() - lastExtraSync < 60e3) return;
  lastExtraSync = Date.now();
  try {
    const [arr, drop] = await kv([["HGETALL", key("schools:extra")], ["ZRANGE", key("schools:dropped"), "0", "-1"]]);
    for (let i = 0; i < (arr || []).length; i += 2) { try { pushSchool(JSON.parse(arr[i + 1])); } catch {} }
    for (const o of drop || []) hiddenOsm.add(o);
  }
  catch (e) { console.warn("No se pudieron leer los colegios sumados:", e.message); }
}
// Cache simple con vencimiento (listas de ciudades por país o región).
const memCache = new Map();
export async function cacheGet(k) {
  if (kvEnabled) { try { const [v] = await kv([["GET", key("c:" + k)]]); return v ? JSON.parse(v) : null; } catch { return null; } }
  const o = memCache.get(k); return o && o.exp > Date.now() ? o.v : null;
}
export async function cacheSet(k, v, ttlSec) {
  if (kvEnabled) return track(kv([["SET", key("c:" + k), JSON.stringify(v), "EX", String(ttlSec)]]));
  memCache.set(k, { v, exp: Date.now() + ttlSec * 1000 });
}

// ---------- perfil de cada persona del equipo (nombre completo y rol)
// Se guarda por email en Redis (o en DATA_DIR/profiles.json). Lo pide la app la primera vez que alguien entra.
export const ROLES = { sdr: "SDR", ae: "Account Executive", lider: "Líder" };
const PROFILE_FILE = path.join(dataDir, "profiles.json");
let profiles = kvEnabled ? {} : load(PROFILE_FILE, {});
export async function getProfiles() {
  if (kvEnabled) { try { const [arr] = await kv([["HGETALL", key("profiles")]]); const o = {}; for (let i = 0; i < (arr || []).length; i += 2) { try { o[arr[i]] = JSON.parse(arr[i + 1]); } catch {} } profiles = o; } catch {} }
  return profiles;
}
export async function getProfile(email) {
  email = String(email || "").toLowerCase();
  if (kvEnabled) { try { const [v] = await kv([["HGET", key("profiles"), email]]); if (v) profiles[email] = JSON.parse(v); } catch {} }
  return profiles[email] || null;
}
export async function setProfile(email, p) {
  email = String(email || "").toLowerCase();
  profiles[email] = { name: p.name, role: p.role, at: new Date().toISOString() };
  if (kvEnabled) await kv([["HSET", key("profiles"), email, JSON.stringify(profiles[email])]]);
  else persistFile(PROFILE_FILE, profiles);
  return profiles[email];
}

// ---------- fichas de Pipedrive que no son colegios de la base (prospectos y organizaciones de la agenda)
// Viven solo en byId (no aparecen en listas ni en el mapa) y se pueden rearmar en cualquier instancia.
export function addVirtual(s) { byId.set(s.id, s); return s; }
