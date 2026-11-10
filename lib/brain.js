// OrderBrain general (brain.ordereat.com): los sitios de World Dominion son los colegios que ya trabajan con OrderEAT.
// Se cruzan con la base de colegios para no prospectar a un cliente aunque Pipedrive no lo tenga bien cargado.
// Necesita BRAIN_TOKEN (el token de sesión de OrderBrain o, mejor, uno de servicio). Sin token no hace nada.
import { cacheGet, cacheSet, schools } from "./store.js";
import { norm, km, keyTokens } from "./scan.js";
import { DEMO as PD_DEMO } from "./pipedrive.js";

const env = process.env;
const URL_BASE = (env.BRAIN_URL || "https://brain.ordereat.com").replace(/\/$/, "");
const TOKEN = env.BRAIN_TOKEN || "";
// la demo de clientes solo con el Pipedrive de prueba: nunca marcar colegios reales como clientes inventados
const DEMO = !TOKEN && PD_DEMO;
export const brainEnabled = !!TOKEN || DEMO;

// Estados de World Dominion. Cerrado = firmó; Onboarding = arrancando; Activo = operando.
const LABEL = { Closed: "Cerrado", Onboarding: "Onboarding", Active: "Activo", ChurnOnClosed: "Churn", ChurnOnOnboarding: "Churn", ChurnOnActive: "Churn", Churn: "Churn" };
const isChurn = st => /^Churn/.test(st || "");
const TTL = 15 * 60e3;

const B = { sites: [], at: 0, error: "", inflight: null, ver: 0 };
let index = null, memo = new Map(), memoN = -1;

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
// Comparte la copia entre instancias por la cache de Redis y guarda una copia de respaldo de 30 días.
// Si OrderBrain falla y no hay ninguna copia, reintenta al minuto y queda el error a la vista.
export async function ensureBrain() {
  if (!brainEnabled) return;
  if (Date.now() - B.at < TTL) return;
  if (!B.inflight) B.inflight = (async () => {
    try {
      let sites = B.at ? null : await cacheGet("brain:sites");
      if (!sites) {
        sites = DEMO ? demoSites() : await fetchSites();
        await cacheSet("brain:sites", sites, TTL / 1000);
        if (sites.length) await cacheSet("brain:last", sites, 30 * 864e2);
      }
      set(sites); B.error = ""; B.stale = false;
    } catch (e) {
      B.error = e.message; console.error("brain:", e.message);
      if (!B.sites.length) { const last = await cacheGet("brain:last").catch(() => null); if (last?.length) { set(last); B.stale = true; } }
      // reintento rápido: al minuto si no hay nada, a los 5 si quedó una copia
      B.at = Date.now() - TTL + (B.sites.length ? 5 * 60e3 : 60e3);
    } finally { B.inflight = null; }
  })();
  if (!B.at) await B.inflight;
}
// Sin datos de OrderBrain (falló y no hay copia): la app avisa que los clientes pueden aparecer para llamar.
export const brainDown = () => brainEnabled && !!B.error && !B.sites.length;
function set(sites) { B.sites = sites; B.at = Date.now(); B.ver++; index = null; memo = new Map(); sgrid = null; }

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
// Palabras que comparten muchos colegios religiosos: solas no alcanzan para decir que son el mismo.
const LOW = new Set("saint sede maria cristo sagrado corazon jesus senora nuestra virgen santisima rey divino nino inmaculada concepcion pablo pedro jose juan francisco lourdes fatima guadalupe".split(" "));
export function similar(a, b) {
  const x = keyTokens(a), y = keyTokens(b); if (!x.length || !y.length) return false;
  const xs = x.filter(w => !LOW.has(w)), ys = y.filter(w => !LOW.has(w));
  // con una sola palabra propia de un lado, tiene que estar del otro; con más, al menos dos en común
  if (xs.length && ys.length) { const hit = xs.filter(w => ys.includes(w)).length, m = Math.min(xs.length, ys.length); return m === 1 ? hit === 1 : hit >= 2 && hit / m >= 0.5; }
  // nombres hechos solo de palabras comunes («Sagrado Corazón»): tienen que ser iguales
  return x.length === y.length && x.every(w => y.includes(w));
}
// Colegios de la base cerca de un punto (para saber si un sitio tiene un solo colegio al lado).
let sgrid = null, sgridN = -1;
function schoolsNear(p, r) {
  if (!sgrid || sgridN !== schools.length) {
    sgrid = new Map(); sgridN = schools.length;
    for (const s of schools) { if (s.lat == null) continue; const k = cell(s.lat, s.lng); if (!sgrid.has(k)) sgrid.set(k, []); sgrid.get(k).push(s); }
  }
  const out = [], a = Math.floor(p.lat * 100), b = Math.floor(p.lng * 100);
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const s of sgrid.get(`${a + i}|${b + j}`) || []) if (km(p, s) < r) out.push(s);
  return out;
}

// Sitio de OrderBrain que corresponde a este colegio (o null).
// Mismo lugar de Google; nombre parecido a menos de 300 m; o a menos de 60 m si es el único colegio de la base ahí.
function siteFor(s) {
  if (!index) index = buildIndex();
  if (s.gplace && index.place.has(s.gplace)) return index.place.get(s.gplace);
  if (s.lat != null && s.lng != null) {
    let best = null, bd = Infinity;
    for (const x of near(s.lat, s.lng)) {
      const d = km(s, x); if (d >= 0.3 || d >= bd) continue;
      if (similar(s.name, x.name) || (d < 0.06 && schoolsNear(x, 0.15).length === 1)) { best = x; bd = d; }
    }
    if (best) return best;
  }
  const same = index.name.get(norm(s.name)) || [];
  return same.find(x => norm(x.city) && norm(x.city) === norm(s.city)) || null;
}

// Lo que la app necesita saber del colegio: si es cliente (no contactar) o ex cliente.
export function brainOf(s) {
  if (!B.sites.length) return null;
  if (memoN !== schools.length) { memo = new Map(); memoN = schools.length; } // entró un colegio nuevo: puede cambiar el cruce
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
    enabled: true, demo: DEMO, error: B.error, down: brainDown(), stale: !!B.stale, updatedAt: B.at ? new Date(B.at).toISOString() : null,
    sites: B.sites.filter(x => x.lat != null && x.lng != null).map(x => ({ id: x.id, name: x.name, client: x.client, status: x.status, label: LABEL[x.status] || x.status, churn: isChurn(x.status), lat: x.lat, lng: x.lng, city: x.city, country: x.country, schoolId: bySite.get(x.id) || null })),
  };
}
export const brainVersion = () => B.ver;
