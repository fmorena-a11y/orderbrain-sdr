// OrderBrain general (brain.ordereat.com): los sitios de World Dominion son los colegios que ya trabajan con OrderEAT.
// Se cruzan con la base de colegios para no prospectar a un cliente aunque Pipedrive no lo tenga bien cargado.
// Necesita BRAIN_TOKEN (el token de sesión de OrderBrain o, mejor, uno de servicio). Sin token no hace nada.
import { cacheGet, cacheSet, schools } from "./store.js";
import { norm, km, keyTokens } from "./scan.js";

const env = process.env;
const URL_BASE = (env.BRAIN_URL || "https://brain.ordereat.com").replace(/\/$/, "");
const TOKEN = env.BRAIN_TOKEN || "";
const DEMO = !TOKEN && env.DEMO_MODE === "1";
export const brainEnabled = !!TOKEN || DEMO;

// Estados de World Dominion. Cerrado = firmó; Onboarding = arrancando; Activo = operando.
const LABEL = { Closed: "Cerrado", Onboarding: "Onboarding", Active: "Activo", ChurnOnClosed: "Churn", ChurnOnOnboarding: "Churn", ChurnOnActive: "Churn", Churn: "Churn" };
const isChurn = st => /^Churn/.test(st || "");
const TTL = 15 * 60e3;

const B = { sites: [], at: 0, error: "", inflight: null, ver: 0 };
let index = null, memo = new Map();

async function get(p) {
  const r = await fetch(URL_BASE + p, { headers: { authorization: `Bearer ${TOKEN}`, accept: "application/json" }, signal: AbortSignal.timeout(15000) });
  if (r.status === 401 || r.status === 403) throw new Error("OrderBrain rechazó el token (BRAIN_TOKEN vencido o sin permiso para World Dominion)");
  if (!r.ok) throw new Error(`OrderBrain respondió ${r.status}`);
  return r.json();
}
const arr = x => Array.isArray(x) ? x : Array.isArray(x?.data) ? x.data : Array.isArray(x?.items) ? x.items : [];

async function fetchSites() {
  const [sites, clients] = await Promise.all([get("/api/sites"), get("/api/clients").catch(() => [])]);
  const cname = new Map(arr(clients).map(c => [c.id, c.name]));
  return arr(sites).map(s => ({
    id: s.id, name: s.name || "", client: cname.get(s.clientId) || s.client?.name || "", status: s.status || "",
    country: s.countryName || s.country || "", city: s.city || "", placeId: s.placeId || null,
    lat: s.latitude != null ? +s.latitude : null, lng: s.longitude != null ? +s.longitude : null,
  }));
}
// Demo sin token: un puñado de colegios de la base aparecen como clientes, para ver cómo se marcan.
function demoSites() {
  const pick = [3, 17, 42, 88, 131, 205].map(i => schools[i]).filter(Boolean);
  const st = ["Active", "Active", "Onboarding", "Closed", "ChurnOnActive", "Active"];
  return pick.map((s, i) => ({ id: "demo-" + i, name: s.name, client: "Cliente de prueba", status: st[i], country: s.country, city: s.city, placeId: null, lat: s.lat, lng: s.lng }));
}

// Trae los sitios si pasaron 15 min (o nunca). La primera vez espera; después actualiza atrás.
// Comparte la copia entre instancias por la cache de Redis.
export async function ensureBrain() {
  if (!brainEnabled) return;
  if (Date.now() - B.at < TTL) return;
  if (!B.inflight) B.inflight = (async () => {
    try {
      let sites = B.at ? null : await cacheGet("brain:sites");
      if (!sites) { sites = DEMO ? demoSites() : await fetchSites(); await cacheSet("brain:sites", sites, TTL / 1000); }
      set(sites); B.error = "";
    } catch (e) { B.error = e.message; if (!B.sites.length) set([]); else B.at = Date.now() - TTL + 60e3; console.error("brain:", e.message); }
    finally { B.inflight = null; }
  })();
  if (!B.at) await B.inflight;
}
function set(sites) { B.sites = sites; B.at = Date.now(); B.ver++; index = null; memo = new Map(); }

// Índice por celda de ~1 km para buscar sitios cercanos rápido.
const cell = (lat, lng) => `${Math.floor(lat * 100)}|${Math.floor(lng * 100)}`;
function buildIndex() {
  const grid = new Map(), place = new Map(), name = new Map();
  for (const s of B.sites) {
    if (s.placeId) place.set(s.placeId, s);
    const n = norm(s.name); if (n) { if (!name.has(n)) name.set(n, []); name.get(n).push(s); }
    if (s.lat == null || s.lng == null) continue;
    const k = cell(s.lat, s.lng); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(s);
  }
  return { grid, place, name };
}
function near(lat, lng) {
  const out = [], a = Math.floor(lat * 100), b = Math.floor(lng * 100);
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) out.push(...(index.grid.get(`${a + i}|${b + j}`) || []));
  return out;
}
const similar = (a, b) => {
  const x = keyTokens(a), y = new Set(keyTokens(b)); if (!x.length || !y.size) return false;
  const hit = x.filter(w => y.has(w)).length;
  return hit / Math.min(x.length, y.size) >= 0.5;
};

// Sitio de OrderBrain que corresponde a este colegio (o null).
function siteFor(s) {
  if (!index) index = buildIndex();
  if (s.gplace && index.place.has(s.gplace)) return index.place.get(s.gplace);
  if (s.lat != null && s.lng != null) {
    let best = null, bd = Infinity;
    for (const x of near(s.lat, s.lng)) {
      const d = km(s, x);
      // mismo predio (60 m) o cerca y con nombre parecido (300 m)
      if ((d < 0.06 || (d < 0.3 && similar(s.name, x.name))) && d < bd) { best = x; bd = d; }
    }
    if (best) return best;
  }
  const same = index.name.get(norm(s.name)) || [];
  return same.find(x => norm(x.city) && norm(x.city) === norm(s.city)) || null;
}

// Lo que la app necesita saber del colegio: si es cliente (no contactar) o ex cliente.
export function brainOf(s) {
  if (!B.sites.length) return null;
  if (memo.has(s.id)) return memo.get(s.id);
  const x = siteFor(s);
  const r = x ? { client: !isChurn(x.status), churn: isChurn(x.status), status: x.status, label: LABEL[x.status] || x.status, site: x.name, clientName: x.client } : null;
  memo.set(s.id, r);
  return r;
}

// Para el mapa: todos los sitios con coordenadas y, si cruzan, el colegio de la base.
export function brainState() {
  if (!brainEnabled) return { enabled: false };
  const bySite = new Map();
  for (const s of schools) { const b = brainOf(s); if (b) { const x = siteFor(s); if (x && !bySite.has(x.id)) bySite.set(x.id, s.id); } }
  return {
    enabled: true, demo: DEMO, error: B.error, updatedAt: B.at ? new Date(B.at).toISOString() : null,
    sites: B.sites.filter(x => x.lat != null && x.lng != null).map(x => ({ id: x.id, name: x.name, client: x.client, status: x.status, label: LABEL[x.status] || x.status, churn: isChurn(x.status), lat: x.lat, lng: x.lng, city: x.city, country: x.country, schoolId: bySite.get(x.id) || null })),
  };
}
export const brainVersion = () => B.ver;
