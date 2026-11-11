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
// para Métricas: cuántos trae el archivo del radar y cuántos de esos se muestran (los demás quedan ocultos)
export const FILE_COUNTS = { total: raw.length, shown: schools.length };

// ---------- Redis por REST (sin dependencias)
const R_URL = (env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL || "").replace(/\/$/, "");
const R_TOKEN = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN || "";
// El modo demo usa otras claves para no mezclar datos de prueba con los reales.
const P = (env.KV_PREFIX || "ob:") + (env.DEMO_MODE === "1" && !env.PIPEDRIVE_API_TOKEN ? "demo:" : "");
export const kvEnabled = !!(R_URL && R_TOKEN);
// timeout: 4 s por defecto; las lecturas grandes (todos los cruces) piden más
export async function kv(cmds, { timeout = 4000 } = {}) {
  const r = await fetch(`${R_URL}/pipeline`, { method: "POST", headers: { authorization: `Bearer ${R_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(cmds), signal: AbortSignal.timeout(timeout) });
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
// Cada escritura también anota el id en match:at (ZSET por hora): las otras instancias leen solo lo cambiado (sync).
// Lo que escribe la app nunca lleva via:"sync" (aunque copie un cruce que vino de la sincronización masiva): así la
// masiva respeta lo que guardó una ficha hace menos de 1 hora (lib/sync.js, decideMatch).
export function setMatch(id, rec) {
  const { created, via, ...clean } = rec;
  cache[id] = { ...clean, v: MATCH_V, checkedAt: new Date().toISOString() };
  if (kvEnabled) track(kv([["HSET", key("match"), id, JSON.stringify(cache[id])], ["ZADD", key("match:at"), String(Date.now()), id]]));
  else persistFile(CACHE_FILE, cache);
  return created ? { ...cache[id], created } : cache[id];
}
// Muchos cruces juntos (sincronización masiva, que sí marca via:"sync"): un HSET por tanda de hasta ~300 KB
// (Upstash corta en 1 MB por pedido). Se espera la escritura para que quien llama sepa hasta dónde se guardó.
export async function setMatches(entries) {
  const at = new Date().toISOString(), out = [];
  for (const [id, rec] of entries) { const { created, ...clean } = rec; cache[id] = { ...clean, v: MATCH_V, checkedAt: at }; out.push([id, JSON.stringify(cache[id])]); }
  if (!kvEnabled) { if (out.length) persistFile(CACHE_FILE, cache); return out.length; }
  const ms = String(Date.now());
  for (let i = 0; i < out.length;) {
    const args = [], ids = []; let bytes = 0;
    while (i < out.length && (bytes < 300e3 || !args.length)) { args.push(out[i][0], out[i][1]); ids.push(ms, out[i][0]); bytes += out[i][0].length + out[i][1].length; i++; }
    await kv([["HSET", key("match"), ...args], ["ZADD", key("match:at"), ...ids]]);
  }
  return out.length;
}
// el más nuevo gana (otra instancia pudo escribir después)
function mergeMatch(id, raw) {
  if (!raw) return null;
  try { const rec = JSON.parse(raw), cur = cache[id]; if (!cur || String(rec.checkedAt) > String(cur.checkedAt)) cache[id] = rec; return rec; } catch { return null; }
}
async function readMatches(ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500), [vals] = await kv([["HMGET", key("match"), ...chunk]], { timeout: 10e3 });
    chunk.forEach((id, j) => { const rec = mergeMatch(id, vals?.[j]); if (rec) out.set(id, rec); });
  }
  return out;
}
// Lo que hay en Redis ahora para estos colegios (y queda en memoria). La sincronización masiva lo mira justo antes de
// escribir cada tanda, para no pisar lo que guardó otra instancia mientras tanto.
export async function latestMatches(ids) {
  if (!kvEnabled || !ids.length) return new Map(ids.filter(id => cache[id]).map(id => [id, cache[id]]));
  return readMatches(ids);
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
export async function withLock(name, fn, { busy = "Otra persona está guardando este colegio, probá de nuevo en unos segundos." } = {}) {
  if (!kvEnabled) return fn();
  const k = key("lock:" + name);
  for (let i = 0; i < 8; i++) {
    let ok = false;
    try { ok = (await kv([["SET", k, "1", "NX", "EX", "30"]]))[0] === "OK"; } catch { return fn(); }
    if (ok) { try { return await fn(); } finally { await kv([["DEL", k]]).catch(() => {}); } }
    await new Promise(r => setTimeout(r, 750));
  }
  throw Object.assign(new Error(busy), { status: 409 });
}
export const STALE_MS = 7 * 864e5;
// MATCH_V: sube cuando cambian las reglas de estado (v2: «Perdido» solo con propuesta, «Contactado sin avance»);
// los cruces guardados con otra versión se vuelven a calcular.
const MATCH_V = 4; // v3: dueño de la organización
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
// Métricas: los contactos que guarda Redis (los últimos MAX_TOUCHES; esta instancia puede tener más en memoria, otra no) y si
// el período quedó cortado por ese tope (el más viejo que queda es de después del comienzo). Sin Redis, el archivo no tiene tope.
export function touchWindow(fromMs) {
  const list = kvEnabled ? touches.slice(-MAX_TOUCHES) : touches, cap = kvEnabled ? MAX_TOUCHES : 50000;
  return { list, max: cap, cut: list.length >= cap && Date.parse(list[0]?.at) > fromMs };
}

// ---------- sincronización con Redis
// Cruces: la primera vez (y cada 30 min, por las dudas) se leen todos de a tandas (HSCAN); en el medio, solo los ids
// que cambiaron desde la última lectura (ZSET match:at, con 2 min de margen por los relojes) y esos registros (HMGET).
// Así una instancia no baja varios MB por minuto cuando la sincronización masiva ya cruzó toda la base.
let lastTouchSync = 0, lastMatchSync = 0, lastMatchFull = 0, matchSince = 0, lastScore = -1, inflight = null;
const MATCH_FULL_MS = 30 * 60e3;
async function loadAllMatches() {
  let cursor = "0";
  do {
    const [[next, arr]] = await kv([["HSCAN", key("match"), cursor, "COUNT", "1000"]], { timeout: 10e3 });
    for (let i = 0; i < (arr || []).length; i += 2) mergeMatch(arr[i], arr[i + 1]);
    cursor = String(next);
  } while (cursor !== "0");
}
export function sync({ force = false } = {}) {
  if (!kvEnabled) return Promise.resolve();
  const now = Date.now();
  const wantT = force || now - lastTouchSync > 10e3, wantM = force || now - lastMatchSync > 60e3;
  if (!wantT && !wantM) return Promise.resolve();
  if (inflight) return inflight;
  inflight = (async () => {
    const cmds = [], t0 = Date.now(), fullM = wantM && (!lastMatchFull || t0 - lastMatchFull > MATCH_FULL_MS);
    if (wantT) cmds.push(lastScore < 0 ? ["ZRANGE", key("touches"), "0", "-1", "WITHSCORES"] : ["ZRANGEBYSCORE", key("touches"), String(Math.max(0, lastScore - 120e3)), "+inf", "WITHSCORES"]);
    if (wantM && !fullM) cmds.push(["ZRANGEBYSCORE", key("match:at"), String(Math.max(0, matchSince - 120e3)), "+inf"]);
    const res = cmds.length ? await kv(cmds) : [];
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
      if (fullM) { await loadAllMatches(); lastMatchFull = t0; }
      else await readMatches(res.shift() || []);
      matchSince = t0; lastMatchSync = Date.now();
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
// varias claves en un solo pedido a Redis (las versiones del Historial)
export async function cacheGetMany(ks) {
  if (kvEnabled) { try { const r = await kv(ks.map(k => ["GET", key("c:" + k)])); return ks.map((_, i) => (r?.[i] ? JSON.parse(r[i]) : null)); } catch { return ks.map(() => null); } }
  return ks.map(k => { const o = memCache.get(k); return o && o.exp > Date.now() ? o.v : null; });
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

// ---------- accesos del equipo asignados desde la app (lib/access.js): { level, title, by, byName, at } por email.
// Hash propio sin vencimiento en Redis (access) o DATA_DIR/access.json. isLeader lo consulta seguido: se relee de Redis
// cada 5 s como mucho (fresh: ya), y lo que cambia esta instancia queda en memoria al instante.
const ACCESS_FILE = path.join(dataDir, "access.json");
let accessMem = kvEnabled ? {} : load(ACCESS_FILE, {}), accessAt = 0;
// Si Redis no responde: con fresh (antes de un cambio) da error 503 y no se sigue (no se cambia nada sobre una lectura vieja o
// vacía); si no, lo último que se leyó (en una instancia nueva, nada: nadie tiene acceso asignado, se cierra).
const READ_FAIL = what => Object.assign(new Error(`No pude leer ${what}. Probá de nuevo en unos segundos.`), { status: 503 });
export async function getAccessMap({ fresh = false } = {}) {
  if (kvEnabled && (fresh || Date.now() - accessAt > 5e3)) {
    try {
      const [arr] = await kv([["HGETALL", key("access")]]); const o = {};
      for (let i = 0; i < (arr || []).length; i += 2) { try { o[arr[i]] = JSON.parse(arr[i + 1]); } catch {} }
      accessMem = o; accessAt = Date.now();
    } catch (e) {
      console.warn("No se pudieron leer los accesos del equipo:", e.message);
      if (fresh) throw READ_FAIL("los accesos del equipo");
      accessAt = Date.now() - 3e3; // no reintentar en cada pedido: de nuevo en 2 s
    }
  }
  return accessMem;
}
export async function setAccess(email, rec) {
  email = String(email || "").trim().toLowerCase();
  accessMem[email] = rec;
  if (kvEnabled) await kv([["HSET", key("access"), email, JSON.stringify(rec)]]);
  else persistFile(ACCESS_FILE, accessMem);
  return rec;
}

// ---------- equipos (lib/teams.js): { teams: [{ id, name, leaders, members, at, by }] }. Un solo valor (los cambios tocan
// varios equipos a la vez: se escriben juntos, con withLock("teams") en server.js). Clave propia sin vencimiento en Redis
// (teams) o DATA_DIR/teams.json. Se relee de Redis cada 5 s como mucho (fresh: ya). Sin equipos: { teams: [] }.
// Si Redis no responde (o el valor está roto): con fresh (dentro de un cambio) error 503, para no guardar arriba de una
// lectura vacía y borrar todos los equipos; si no, lo último que se leyó bien. Si esta instancia nunca los leyó bien,
// { teams: [], unknown: true }: lib/teams.js se cierra (un líder de equipo no pasa a ver todo como si no hubiera equipos).
const TEAMS_FILE = path.join(dataDir, "teams.json");
let teamsMem = kvEnabled ? { teams: [] } : load(TEAMS_FILE, { teams: [] }), teamsAt = 0, teamsOk = !kvEnabled;
export async function getTeams({ fresh = false } = {}) {
  if (kvEnabled && (fresh || Date.now() - teamsAt > 5e3)) {
    try {
      const [v] = await kv([["GET", key("teams")]]), T = v ? JSON.parse(v) : { teams: [] };
      if (!T || typeof T !== "object" || !Array.isArray(T.teams)) throw new Error("el valor guardado no es una lista de equipos");
      teamsMem = T; teamsAt = Date.now(); teamsOk = true;
    } catch (e) {
      console.warn("No se pudieron leer los equipos:", e.message);
      if (fresh) throw READ_FAIL("los equipos");
      teamsAt = Date.now() - 3e3; // no reintentar en cada pedido: de nuevo en 2 s
    }
  }
  return teamsOk ? teamsMem : { teams: [], unknown: true };
}
export async function saveTeams(T) {
  if (T?.unknown) throw READ_FAIL("los equipos"); // nunca se guarda una lectura fallida
  teamsMem = T; teamsAt = Date.now(); teamsOk = true;
  if (kvEnabled) await kv([["SET", key("teams"), JSON.stringify(T)]]);
  else persistFile(TEAMS_FILE, teamsMem);
  return T;
}

// ---------- colegios archivados desde la app (lib/archive.js): { by, byName, at, reason, text, leadIds, orgId }
// Clave propia sin vencimiento en Redis (o DATA_DIR/archived.json). Las lecturas son de memoria; syncArchived trae lo de
// otras instancias y refreshArchived relee uno antes de escribir.
const ARCH_FILE = path.join(dataDir, "archived.json");
let archived = kvEnabled ? {} : load(ARCH_FILE, {}), lastArchSync = 0;
export const allArchived = () => archived;
export const getArchived = id => archived[id] || (aliasesFor.get(id) || []).map(a => archived[a]).find(Boolean) || null;
export async function setArchived(id, rec) {
  if (rec) archived[id] = rec; else delete archived[id];
  if (kvEnabled) await kv([rec ? ["HSET", key("archived"), id, JSON.stringify(rec)] : ["HDEL", key("archived"), id]]);
  else persistFile(ARCH_FILE, archived);
  return rec;
}
export async function refreshArchived(id) {
  if (kvEnabled) { const [v] = await kv([["HGET", key("archived"), id]]); if (v) { try { archived[id] = JSON.parse(v); } catch {} } else delete archived[id]; }
  return getArchived(id);
}
export async function syncArchived() {
  if (!kvEnabled || Date.now() - lastArchSync < 15e3) return;
  lastArchSync = Date.now();
  try { const [arr] = await kv([["HGETALL", key("archived")]]); const o = {}; for (let i = 0; i < (arr || []).length; i += 2) { try { o[arr[i]] = JSON.parse(arr[i + 1]); } catch {} } archived = o; }
  catch (e) { console.warn("No se pudieron leer los archivados:", e.message); }
}

// ---------- token de World Dominion cargado desde Equipo por un líder (lib/brain.js)
// Clave propia en Redis, sin vencimiento y fuera de la cache. Sin Redis, en DATA_DIR/brain-token.json (solo para el
// dueño del proceso; está en .gitignore). Lleva { token, by, at }: el token no sale del servidor.
// getBrainToken tira error si Redis falla (quien lo llama sigue con el que tenía).
const BRAIN_FILE = path.join(dataDir, "brain-token.json");
export async function getBrainToken() {
  if (kvEnabled) {
    const [v] = await kv([["GET", key("brain:token")]]); if (!v) return null;
    try { return JSON.parse(v); } catch { throw new Error("el valor guardado no es JSON"); } // el error de JSON.parse citaría el token
  }
  return load(BRAIN_FILE, null);
}
export async function setBrainToken(rec) {
  if (kvEnabled) { await kv([["SET", key("brain:token"), JSON.stringify(rec)]]); return; }
  fs.writeFileSync(BRAIN_FILE, JSON.stringify(rec), { mode: 0o600 });
}

// ---------- fichas de Pipedrive que no son colegios de la base (prospectos y organizaciones de la agenda)
// Viven solo en byId (no aparecen en listas ni en el mapa) y se pueden rearmar en cualquier instancia.
export function addVirtual(s) { byId.set(s.id, s); return s; }

// ---------- sesiones de trabajo de cada persona (lib/sessions.js)
// En Redis, por email: cada sesión entera en su propia clave (sess:<email>:<id>, con los colegios y los pasos); un índice
// sessidx:<email> (id → resumen: nombre, origen, fechas y números), que es lo único que lee la lista de Hoy; y
// sessrefs:<email> (id → colegios, solo de las abiertas), para anotar un contacto hecho fuera de la sesión sin leer cada
// sesión. Así un contacto o un cambio de posición lee y escribe solo su sesión. Cada escritura renueva el vencimiento
// (SESS_TTL_S): si alguien deja de entrar, lo suyo se borra solo. Sin Redis, en DATA_DIR/sessions.json.
// Se leen siempre de Redis porque se retoman desde otro dispositivo; las escrituras se esperan (quien llama avisa si falla).
// 45 días: una abierta pasa a terminada a los 30 sin movimiento y una terminada queda 14 días
export const SESS_TTL_S = 45 * 86400;
const SESS_FILE = path.join(dataDir, "sessions.json");
let sessFile = kvEnabled ? {} : load(SESS_FILE, {});
const em = e => String(e || "").toLowerCase();
const sKey = (e, id) => key(`sess:${em(e)}:${id}`), sIdx = e => key("sessidx:" + em(e)), sRefs = e => key("sessrefs:" + em(e));
const sFile = e => { const f = sessFile[em(e)]; return f?.idx && f.full && f.refs ? f : (sessFile[em(e)] = { idx: {}, full: {}, refs: {} }); };
const parseJson = v => { try { return JSON.parse(v); } catch { return null; } };
const pairs = arr => { const out = []; for (let i = 0; i < (arr || []).length; i += 2) out.push([arr[i], arr[i + 1]]); return out; };
// los resúmenes de todas las sesiones de una persona
export async function readSessionIndex(email) {
  if (kvEnabled) return pairs((await kv([["HGETALL", sIdx(email)]]))[0]).map(([, v]) => parseJson(v)).filter(v => v?.id);
  return Object.values(sFile(email).idx).map(v => structuredClone(v));
}
// una sesión entera (null si no está)
export async function readSession(email, id) {
  if (kvEnabled) { const [v] = await kv([["GET", sKey(email, id)]]); return v ? parseJson(v) : null; }
  const s = sFile(email).full[id];
  return s ? structuredClone(s) : null;
}
// [[id, [colegios]]] de las sesiones abiertas
export async function readSessionRefs(email) {
  if (kvEnabled) return pairs((await kv([["HGETALL", sRefs(email)]]))[0]).map(([id, v]) => [id, String(v || "").split("\n").filter(Boolean)]);
  return Object.entries(sFile(email).refs).map(([id, r]) => [id, [...r]]);
}
// summary: lo que va al índice. refs: los colegios (al abrirse) o null (al terminarse); sin refs, quedan como estaban.
export async function writeSession(email, s, summary, refs) {
  if (kvEnabled) {
    const ttl = String(SESS_TTL_S);
    const cmds = [["SET", sKey(email, s.id), JSON.stringify(s), "EX", ttl], ["HSET", sIdx(email), s.id, JSON.stringify(summary)], ["EXPIRE", sIdx(email), ttl]];
    if (refs) cmds.push(["HSET", sRefs(email), s.id, refs.join("\n")]);
    else if (refs === null) cmds.push(["HDEL", sRefs(email), s.id]);
    cmds.push(["EXPIRE", sRefs(email), ttl]);
    await kv(cmds);
    return;
  }
  const f = sFile(email);
  f.full[s.id] = structuredClone(s); f.idx[s.id] = structuredClone(summary);
  if (refs) f.refs[s.id] = [...refs]; else if (refs === null) delete f.refs[s.id];
  persistFile(SESS_FILE, sessFile);
}
export async function removeSessions(email, ids) {
  if (!ids.length) return;
  if (kvEnabled) { await kv([["DEL", ...ids.map(id => sKey(email, id))], ["HDEL", sIdx(email), ...ids], ["HDEL", sRefs(email), ...ids]]); return; }
  const f = sFile(email);
  for (const id of ids) { delete f.full[id]; delete f.idx[id]; delete f.refs[id]; }
  persistFile(SESS_FILE, sessFile);
}
// ---------- Gmail de cada persona (lib/gmail.js): { enc, email, scope, at, demo? } por email de la sesión.
// enc es el refresh token cifrado (AES-256-GCM): nunca se guarda en claro ni vuelve al navegador. Hash propio en Redis
// (sin vencimiento) o DATA_DIR/gmail.json (solo para el dueño del proceso, como el token de World Dominion).
const GMAIL_FILE = path.join(dataDir, "gmail.json");
let gmailMem = kvEnabled ? {} : load(GMAIL_FILE, {});
const lc = e => String(e || "").trim().toLowerCase();
const saveFile600 = (f, data) => { try { fs.writeFileSync(f, JSON.stringify(data), { mode: 0o600 }); } catch (e) { console.warn("No se pudo guardar", path.basename(f), e.code || ""); } };
export async function getGmail(email) {
  email = lc(email); if (!email) return null;
  if (kvEnabled) { const [v] = await kv([["HGET", key("gmail"), email]]); if (!v) { delete gmailMem[email]; return null; } try { return (gmailMem[email] = JSON.parse(v)); } catch { return null; } }
  return gmailMem[email] || null;
}
export async function setGmail(email, rec) {
  email = lc(email); gmailMem[email] = rec;
  if (kvEnabled) await kv([["HSET", key("gmail"), email, JSON.stringify(rec)]]);
  else saveFile600(GMAIL_FILE, gmailMem);
}
export async function delGmail(email) {
  email = lc(email); delete gmailMem[email];
  if (kvEnabled) await kv([["HDEL", key("gmail"), email]]);
  else saveFile600(GMAIL_FILE, gmailMem);
}
// preferencias de mail por persona: { signature } (la firma que pegó en su perfil, ya saneada; manda sobre la de Gmail)
const PREFS_FILE = path.join(dataDir, "mail-prefs.json");
let prefsMem = kvEnabled ? {} : load(PREFS_FILE, {});
export async function getMailPrefs(email) {
  email = lc(email); if (!email) return null;
  if (kvEnabled) { try { const [v] = await kv([["HGET", key("mailprefs"), email]]); prefsMem[email] = v ? JSON.parse(v) : null; } catch {} }
  return prefsMem[email] || null;
}
export async function setMailPrefs(email, p) {
  email = lc(email); prefsMem[email] = { ...p, at: new Date().toISOString() };
  if (kvEnabled) await kv([["HSET", key("mailprefs"), email, JSON.stringify(prefsMem[email])]]);
  else persistFile(PREFS_FILE, prefsMem);
  return prefsMem[email];
}
// mails enviados desde la ficha (para Historial, con el cuerpo): un hash por colegio en Redis (mail:<colegio>, campo = id
// del mensaje de Gmail) o DATA_DIR/mails.json. Se guardan los últimos MAX_MAILS por colegio.
const MAILS_FILE = path.join(dataDir, "mails.json"), MAX_MAILS = 40;
let mailsMem = kvEnabled ? {} : load(MAILS_FILE, {});
export async function addMail(schoolId, rec) {
  if (kvEnabled) await mailsFor(schoolId, { own: true });
  const list = (mailsMem[schoolId] ||= []); list.push(rec);
  const gone = list.length > MAX_MAILS ? list.splice(0, list.length - MAX_MAILS) : [];
  if (kvEnabled) await kv([["HSET", key("mail:" + schoolId), rec.id, JSON.stringify(rec)], ...(gone.length ? [["HDEL", key("mail:" + schoolId), ...gone.map(m => m.id)]] : [])]);
  else persistFile(MAILS_FILE, mailsMem);
  return rec;
}
export async function patchMail(schoolId, id, patch) {
  const list = await mailsFor(schoolId, { own: true }), cur = list.find(m => m.id === id); if (!cur) return null;
  Object.assign(cur, patch);
  if (kvEnabled) await kv([["HSET", key("mail:" + schoolId), id, JSON.stringify(cur)]]);
  else persistFile(MAILS_FILE, mailsMem);
  return cur;
}
// los del colegio (y de sus alias), del más viejo al más nuevo
export async function mailsFor(schoolId, { own = false } = {}) {
  const ids = own ? [schoolId] : [schoolId, ...(aliasesFor.get(schoolId) || [])];
  if (kvEnabled) {
    try {
      const res = await kv(ids.map(i => ["HGETALL", key("mail:" + i)]));
      ids.forEach((i, j) => { const arr = res[j] || [], l = []; for (let k = 0; k < arr.length; k += 2) { try { l.push(JSON.parse(arr[k + 1])); } catch {} } mailsMem[i] = l.sort((a, b) => String(a.at).localeCompare(String(b.at))).slice(-MAX_MAILS); });
    } catch (e) { console.warn("No se pudieron leer los mails:", e.message); }
  }
  return ids.flatMap(i => mailsMem[i] || []).sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

// Una sola vez por clave (por ejemplo, el mismo envío reintentado por la red): true la primera vez, false las siguientes.
const onceMem = new Map();
export async function once(k, ttlSec = 900) {
  if (kvEnabled) { try { return (await kv([["SET", key("once:" + k), "1", "NX", "EX", String(ttlSec)]]))[0] === "OK"; } catch {} }
  const now = Date.now(); for (const [x, exp] of onceMem) if (exp < now) onceMem.delete(x);
  if (onceMem.has(k)) return false;
  onceMem.set(k, now + ttlSec * 1000); return true;
}
export async function release(k) { onceMem.delete(k); if (kvEnabled) await kv([["DEL", key("once:" + k)]]).catch(() => {}); }
// Contador con vencimiento (por ejemplo, mails enviados por persona en la última hora): suma 1 y devuelve el total.
const bumpMem = new Map();
export async function bump(k, ttlSec = 3600) {
  if (kvEnabled) { try { const r = await kv([["SET", key("n:" + k), "0", "NX", "EX", String(ttlSec)], ["INCR", key("n:" + k)]]); return Number(r[1]) || 1; } catch {} }
  const now = Date.now(), cur = bumpMem.get(k), n = cur && cur.until > now ? cur.n + 1 : 1;
  bumpMem.set(k, { n, until: cur && cur.until > now ? cur.until : now + ttlSec * 1000 });
  return n;
}
