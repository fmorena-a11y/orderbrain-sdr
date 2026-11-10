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
// Las etiquetas dicen exactamente lo que dice World Dominion: el churn distingue en qué momento se cayó.
// Churn = era activo y se cayó. Si se cayó durante el onboarding o antes de arrancar, nunca estuvo activo.
const LABEL = { Closed: "Cerrado", Onboarding: "Onboarding", Active: "Activo", ChurnOnActive: "Churn", ChurnOnOnboarding: "Se cayó en onboarding", ChurnOnClosed: "Se cayó antes de arrancar", Churn: "Churn" };
const COUNTRY = { Mexico: "México", Peru: "Perú", DominicanRepublic: "República Dominicana", CostaRica: "Costa Rica", Brasil: "Brasil", Brazil: "Brasil", Spain: "España", Panama: "Panamá" };
const isChurn = st => /^Churn/.test(st || "");
const TTL = 15 * 60e3;

// at: cuándo se refrescó esta instancia (para el TTL). dataAt: de cuándo son los datos (la lectura a OrderBrain).
const B = { sites: [], at: 0, dataAt: 0, error: "", stale: false, inflight: null, ver: 0 };
let index = null, memo = new Map(), memoN = -1;

async function get(p) {
  const r = await fetch(URL_BASE + p, { headers: { authorization: `Bearer ${TOKEN}`, accept: "application/json" }, signal: AbortSignal.timeout(15000) });
  if (r.status === 401 || r.status === 403) throw new Error("OrderBrain rechazó el token (BRAIN_TOKEN vencido o sin permiso para World Dominion)");
  if (!r.ok) throw new Error(`OrderBrain respondió ${r.status}`);
  return r.json();
}
const arr = x => Array.isArray(x) ? x : Array.isArray(x?.data) ? x.data : Array.isArray(x?.items) ? x.items : [];

// Datos extra que manda World Dominion sobre cada sitio (fechas, motivo, responsable…): se muestran tal cual, con su nombre.
const INFO_KEY = /(date|fecha|at)$|reason|motivo|churn|note|comment|owner|csm|manager|responsable|plan|students|alumnos/i;
const pickInfo = s => Object.fromEntries(Object.entries(s || {}).filter(([k, v]) => INFO_KEY.test(k) && !/^(updatedAt|deletedAt|startDate)$/.test(k)
  && (typeof v === "string" || typeof v === "number") && String(v).trim() && String(v).length < 300).slice(0, 10));
async function fetchSites() {
  const [sites, clients] = await Promise.all([get("/api/sites"), get("/api/clients").catch(() => [])]);
  const cname = new Map(arr(clients).map(c => [c.id, c.name]));
  return arr(sites).map(s => ({
    id: s.id, name: (s.name || "").trim(), client: (s.clientName || cname.get(s.clientId) || s.client?.name || "").trim(), status: s.status || "",
    country: COUNTRY[s.country] || s.country || "", city: s.city || "", placeId: s.placeId || null, start: s.startDate || null,
    lat: s.latitude != null ? +s.latitude : null, lng: s.longitude != null ? +s.longitude : null, info: pickInfo(s),
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
// Las copias guardan la fecha de los datos ({ at, sites }); las viejas (solo la lista) quedan sin fecha.
// Si OrderBrain falla, queda stale con la fecha de los datos que se siguen usando (los de memoria o la copia).
// Si no hay ninguna copia, reintenta al minuto y queda el error a la vista.
const unpack = v => Array.isArray(v) ? { sites: v, at: 0 } : v && Array.isArray(v.sites) ? { sites: v.sites, at: Number(v.at) || 0 } : null;
export async function ensureBrain() {
  if (!brainEnabled) return;
  if (Date.now() - B.at < TTL) return;
  if (!B.inflight) B.inflight = (async () => {
    try {
      let got = B.at ? null : unpack(await cacheGet("brain:sites"));
      if (got && !got.at) got.at = Date.now(); // copia compartida de formato viejo: dura 15 min, es de recién
      if (!got) {
        got = { sites: DEMO ? demoSites() : await fetchSites(), at: Date.now() };
        await cacheSet("brain:sites", got, TTL / 1000);
        if (got.sites.length) await cacheSet("brain:last", got, 30 * 864e2);
      }
      set(got.sites, got.at); B.error = ""; B.stale = false;
    } catch (e) {
      B.error = e.message; console.error("brain:", e.message);
      if (B.sites.length) B.stale = true;
      else { const last = unpack(await cacheGet("brain:last").catch(() => null)); if (last?.sites.length) { set(last.sites, last.at); B.stale = true; } }
      // reintento rápido: al minuto si no hay nada, a los 5 si quedó una copia
      B.at = Date.now() - TTL + (B.sites.length ? 5 * 60e3 : 60e3);
    } finally { B.inflight = null; }
  })();
  if (!B.at) await B.inflight;
}
// Sin datos de OrderBrain (falló y no hay copia): la app avisa que los clientes pueden aparecer para llamar.
export const brainDown = () => brainEnabled && !!B.error && !B.sites.length;
function set(sites, dataAt) { B.sites = sites; B.at = Date.now(); B.dataAt = dataAt || 0; B.ver++; index = null; memo = new Map(); sgrid = null; }

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
const stem = w => { let x = w; if (x.length > 4) x = x.replace(/s$/, ""); if (x.length > 5) x = x.replace(/[ao]$/, ""); return x; };
const LOW = new Set("saint sede maria cristo sagrado corazon jesus senora nuestra virgen santisima rey divino nino inmaculada concepcion pablo pedro jose juan francisco lourdes fatima guadalupe primaria secundaria preescolar campus".split(" ").map(stem));
function lev(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 9;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
// misma palabra, o casi (un error de tipeo en palabras largas: «Valvidia» / «Valdivia»)
// una letra de diferencia si empiezan igual; dos solo en palabras largas que comparten las 3 primeras letras
// («Valvidia» / «Valdivia» sí; «Mexicano» / «Americano» no)
const same = (x, y) => {
  if (x === y) return true;
  const m = Math.min(x.length, y.length); if (m < 6 || x[0] !== y[0]) return false;
  const d = lev(x, y);
  return d <= 1 || (d === 2 && m >= 7 && x.slice(0, 3) === y.slice(0, 3));
};
// palabras propias del nombre, sin las de la ciudad («Jesús María Buenos Aires» → jesus, maria)
const toks = (name, cityWords) => [...new Set(keyTokens(name).map(stem).filter(w => !cityWords.has(w)))];
const inAll = (small, big) => small.every(w => big.some(z => same(w, z)));
// d: distancia en km. Cuanto más cerca, menos parecido hace falta.
export function similar(a, b, d = 0, cities = []) {
  const cw = new Set(cities.flatMap(c => norm(c).split(" ")).filter(w => w.length > 3).map(stem));
  let x = toks(a, cw), y = toks(b, cw); if (!x.length || !y.length) return false;
  if (x.length > y.length) [x, y] = [y, x];
  const xs = x.filter(w => !LOW.has(w)), ys = y.filter(w => !LOW.has(w));
  if (xs.length && ys.length) {
    // todas las palabras propias del nombre corto están en el largo
    // más allá de 150 m, además tienen que empezar igual («St Brendan's - Punta Carretas» no es «Colegio Punta Carretas»)
    if (inAll(xs, ys)) return d < 0.15 || (same(xs[0], ys[0]) && ((xs.length >= 2 && d < 0.5) || (ys.length <= 2 && d < 0.3)));
    const hit = xs.filter(w => ys.some(z => same(w, z))).length, m = Math.min(xs.length, ys.length);
    return d < 0.3 && hit >= 2 && hit / m >= 0.5;
  }
  // nombres hechos solo de palabras comunes («Colegio Jesús María», «Sagrado Corazón»): tiene que estar entero y muy cerca
  if (!xs.length) return inAll(x, y) && d < 0.15;
  return false;
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
      const d = km(s, x); if (d >= 0.5 || d >= bd) continue;
      if (similar(s.name, x.name, d, [s.city, x.city]) || (d < 0.06 && schoolsNear(x, 0.15).length === 1)) { best = x; bd = d; }
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
  const r = x ? { client: !isChurn(x.status), churn: isChurn(x.status), status: x.status, label: LABEL[x.status] || x.status, site: x.name, clientName: x.client, start: x.start || null, info: x.info || {} } : null;
  memo.set(s.id, r);
  return r;
}

// Para el mapa: todos los sitios con coordenadas y, si cruzan, el colegio de la base.
export function brainState() {
  if (!brainEnabled) return { enabled: false };
  const bySite = new Map();
  for (const s of schools) { const b = brainOf(s); if (b) { const x = siteFor(s); if (x && !bySite.has(x.id)) bySite.set(x.id, s.id); } }
  return {
    enabled: true, demo: DEMO, error: B.error, down: brainDown(), stale: !!B.stale, updatedAt: B.dataAt ? new Date(B.dataAt).toISOString() : null,
    sites: B.sites.filter(x => x.lat != null && x.lng != null).map(x => ({ id: x.id, name: x.name, client: x.client, status: x.status, label: LABEL[x.status] || x.status, churn: isChurn(x.status), lat: x.lat, lng: x.lng, city: x.city, country: x.country, schoolId: bySite.get(x.id) || null })),
  };
}
export const brainVersion = () => B.ver;
