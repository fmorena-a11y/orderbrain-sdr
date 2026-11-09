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

const env = process.env;
const repoData = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
const dataDir = env.DATA_DIR || (env.VERCEL ? "/tmp/orderbrain" : repoData);
try { fs.mkdirSync(dataDir, { recursive: true }); } catch {}
const CACHE_FILE = path.join(dataDir, "cache.json");
const TOUCH_FILE = path.join(dataDir, "touches.json");

// require para que Vercel incluya el archivo en la función.
export const schools = createRequire(import.meta.url)("../data/schools.json");
export const byId = new Map(schools.map(s => [s.id, s]));

// ---------- Redis por REST (sin dependencias)
const R_URL = (env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL || "").replace(/\/$/, "");
const R_TOKEN = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN || "";
const P = env.KV_PREFIX || "ob:";
export const kvEnabled = !!(R_URL && R_TOKEN);
export async function kv(cmds) {
  const r = await fetch(`${R_URL}/pipeline`, { method: "POST", headers: { authorization: `Bearer ${R_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(cmds) });
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
export const getMatch = id => cache[id] || null;
export function setMatch(id, rec) {
  const { created, ...clean } = rec;
  cache[id] = { ...clean, checkedAt: new Date().toISOString() };
  if (kvEnabled) track(kv([["HSET", key("match"), id, JSON.stringify(cache[id])]]));
  else persistFile(CACHE_FILE, cache);
  return created ? { ...cache[id], created } : cache[id];
}
export const allMatches = () => cache;
export const STALE_MS = 7 * 864e5;
export const isFresh = rec => rec?.checkedAt && Date.now() - new Date(rec.checkedAt) < STALE_MS;
export const orgToSchool = () => new Map(Object.entries(cache).filter(([, m]) => m.orgId).map(([id, m]) => [m.orgId, id]));

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
export const touchesFor = id => touchIdx.get(id) || [];
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
    if (wantT) cmds.push(lastScore < 0 ? ["ZRANGE", key("touches"), "0", "-1", "WITHSCORES"] : ["ZRANGEBYSCORE", key("touches"), String(lastScore), "+inf", "WITHSCORES"]);
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
  })().catch(e => console.warn("No se pudo leer Redis:", e.message)).finally(() => { inflight = null; });
  return inflight;
}
