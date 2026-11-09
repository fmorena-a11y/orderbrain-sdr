// Datos locales: colegios (archivo del repo), cache del cruce con Pipedrive y registro de contactos.
// Pipedrive es la fuente de verdad. El cache y los contactos se guardan en DATA_DIR (por defecto data/);
// si el servidor no tiene disco persistente, el cruce se recalcula solo y los contactos se pierden.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
const repoData = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
const dataDir = process.env.DATA_DIR || repoData;
fs.mkdirSync(dataDir, { recursive: true });
const SCHOOLS_FILE = path.join(repoData, "schools.json");
const CACHE_FILE = path.join(dataDir, "cache.json");
const TOUCH_FILE = path.join(dataDir, "touches.json");

export const schools = JSON.parse(fs.readFileSync(SCHOOLS_FILE, "utf8"));
export const byId = new Map(schools.map(s => [s.id, s]));

const load = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
const timers = {};
const persist = (f, data) => { clearTimeout(timers[f]); timers[f] = setTimeout(() => fs.writeFile(f, JSON.stringify(data), () => {}), 400); };

// ---------- cruce colegio ↔ organización
let cache = load(CACHE_FILE, {});
export const getMatch = id => cache[id] || null;
export const setMatch = (id, rec) => { cache[id] = { ...rec, checkedAt: new Date().toISOString() }; persist(CACHE_FILE, cache); return cache[id]; };
export const allMatches = () => cache;
export const STALE_MS = 7 * 864e5;
export const isFresh = rec => rec?.checkedAt && Date.now() - new Date(rec.checkedAt) < STALE_MS;
export const orgToSchool = () => new Map(Object.entries(cache).filter(([, m]) => m.orgId).map(([id, m]) => [m.orgId, id]));

// ---------- contactos registrados desde la app (para cadencia, metas y ranking)
let touches = load(TOUCH_FILE, []);
const touchIdx = new Map();
const reindex = () => { touchIdx.clear(); for (const t of touches) { if (!touchIdx.has(t.schoolId)) touchIdx.set(t.schoolId, []); touchIdx.get(t.schoolId).push(t); } };
reindex();
export function addTouch(t) {
  const rec = { ...t, at: new Date().toISOString() };
  touches.push(rec);
  if (touches.length > 50000) { touches = touches.slice(-50000); reindex(); }
  else { if (!touchIdx.has(rec.schoolId)) touchIdx.set(rec.schoolId, []); touchIdx.get(rec.schoolId).push(rec); }
  persist(TOUCH_FILE, touches);
  return rec;
}
export const touchesFor = id => touchIdx.get(id) || [];
export const touchesSince = ms => touches.filter(t => new Date(t.at).getTime() >= ms);
