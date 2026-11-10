// OrderBrain general (brain.ordereat.com): los sitios de World Dominion son los colegios que ya trabajan con OrderEAT.
// Se cruzan con la base de colegios para no prospectar a un cliente aunque Pipedrive no lo tenga bien cargado.
// Token: el que pega un líder en Equipo (se prueba antes de guardarlo y queda en Redis, lib/store.js) manda sobre
// BRAIN_TOKEN del entorno. Sin ninguno no hace nada (salvo la demo). El token nunca se devuelve ni se escribe en logs.
import { cacheGet, cacheSet, schools, getBrainToken, setBrainToken } from "./store.js";
import { norm, km, keyTokens } from "./scan.js";
import { DEMO as PD_DEMO } from "./pipedrive.js";

const env = process.env;
const URL_BASE = (env.BRAIN_URL || "https://brain.ordereat.com").replace(/\/$/, "");
const ENV_TOKEN = String(env.BRAIN_TOKEN || "").trim();

// ---------- token
// Vencimiento de un JWT (en ms), leído sin verificar la firma: solo sirve para avisar. Si no es JWT o no trae exp, null.
export function tokenExp(t) {
  const p = String(t || "").split(".");
  if (p.length !== 3) return null;
  try { const exp = JSON.parse(Buffer.from(p[1], "base64url").toString("utf8"))?.exp; return Number.isFinite(exp) && exp > 0 ? exp * 1000 : null; }
  catch { return null; }
}
// "expired" venció, "soon" vence en menos de 3 días, "ok", "none" sin fecha de vencimiento
export const SOON_MS = 3 * 864e5;
export const expiryState = (exp, now = Date.now()) => exp == null ? "none" : exp <= now ? "expired" : exp - now < SOON_MS ? "soon" : "ok";
// Lo que pega un líder: sin «Bearer», comillas ni espacios alrededor. Solo caracteres que pueden ir en un header
// (así un error de fetch nunca repite el token).
export function cleanToken(raw) {
  const bad = msg => Object.assign(new Error(msg), { status: 400 });
  let t = String(raw ?? "").trim();
  const q = t.match(/^(["'])(.*)\1$/s); if (q) t = q[2].trim();
  t = t.replace(/^bearer(\s+|$)/i, "").trim();
  if (!t) throw bad("Pegá el token.");
  if (t.length > 8192) throw bad("Eso es demasiado largo para ser un token.");
  if (!/^[\x21-\x7e]+$/.test(t)) throw bad("El token tiene espacios o caracteres raros: copialo de nuevo, entero.");
  return t;
}
// Cuál se usa: el cargado desde la app, salvo que ya haya vencido y el del entorno no.
export function pickToken(stored, envToken, now = Date.now()) {
  const dead = t => expiryState(tokenExp(t), now) === "expired";
  if (stored && !(envToken && dead(stored) && !dead(envToken))) return { token: stored, source: "app" };
  return envToken ? { token: envToken, source: "env" } : null;
}
// stored: { token, by, at } de Redis. checked: última lectura de Redis. gen: sube cada vez que cambia el token en uso.
const T = { stored: null, checked: 0, inflight: null, gen: 0 };
const active = () => pickToken(T.stored?.token, ENV_TOKEN);
// la demo de clientes solo con el Pipedrive de prueba y sin token: nunca marcar colegios reales como clientes inventados
const isDemo = () => !active() && PD_DEMO;
const enabled = () => !!active() || PD_DEMO;

// Estados de World Dominion. Cerrado = firmó; Onboarding = arrancando; Activo = operando.
// Las etiquetas dicen exactamente lo que dice World Dominion: el churn distingue en qué momento se cayó.
// Churn = era activo y se cayó. Si se cayó durante el onboarding o antes de arrancar, nunca estuvo activo.
const LABEL = { Closed: "Cerrado", Onboarding: "Onboarding", Active: "Activo", ChurnOnActive: "Churn", ChurnOnOnboarding: "Se cayó en onboarding", ChurnOnClosed: "Se cayó antes de arrancar", Churn: "Churn" };
const COUNTRY = { Mexico: "México", Peru: "Perú", DominicanRepublic: "República Dominicana", CostaRica: "Costa Rica", Brasil: "Brasil", Brazil: "Brasil", Spain: "España", Panama: "Panamá" };
const isChurn = st => /^Churn/.test(st || "");
const TTL = 15 * 60e3;

// at: cuándo se refrescó esta instancia (para el TTL). dataAt: de cuándo son los datos (la lectura a OrderBrain).
// since: la copia compartida tiene que ser de después del último cambio de token. read: la última lectura con token.
const B = { sites: [], at: 0, dataAt: 0, error: "", auth: false, stale: false, inflight: null, inflightGen: -1, ver: 0, since: 0, read: null };
let index = null, memo = new Map(), memoN = -1;

// Los mensajes de error nunca llevan el token (ni la respuesta cruda).
async function get(p, token) {
  let r;
  try { r = await fetch(URL_BASE + p, { headers: { authorization: `Bearer ${token}`, accept: "application/json" }, signal: AbortSignal.timeout(15000) }); }
  catch (e) { throw new Error(e?.name === "TimeoutError" ? "OrderBrain no respondió a tiempo" : "No pudimos conectar con OrderBrain"); }
  if (r.status === 401 || r.status === 403) throw Object.assign(new Error("OrderBrain rechazó el token (venció o no tiene permiso para World Dominion)"), { code: "auth" });
  if (!r.ok) throw new Error(`OrderBrain respondió ${r.status}`);
  try { return await r.json(); } catch { throw new Error("OrderBrain no respondió con datos (¿el token es de otra cosa?)"); }
}
const list = x => Array.isArray(x) ? x : Array.isArray(x?.data) ? x.data : Array.isArray(x?.items) ? x.items : null;
const arr = x => list(x) || [];

// Datos extra que manda World Dominion sobre cada sitio (fechas, motivo, responsable…): se muestran tal cual, con su nombre.
const INFO_KEY = /(date|fecha|at)$|reason|motivo|churn|note|comment|owner|csm|manager|responsable|plan|students|alumnos/i;
const pickInfo = s => Object.fromEntries(Object.entries(s || {}).filter(([k, v]) => INFO_KEY.test(k) && !/^(updatedAt|deletedAt|startDate)$/.test(k)
  && (typeof v === "string" || typeof v === "number") && String(v).trim() && String(v).length < 300).slice(0, 10));
async function fetchSites(token) {
  const [sites, clients] = await Promise.all([get("/api/sites", token), get("/api/clients", token).catch(() => [])]);
  if (!list(sites)) throw new Error("OrderBrain no devolvió la lista de sitios");
  const cname = new Map(arr(clients).map(c => [c.id, c.name]));
  return list(sites).map(s => ({
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
// Última lectura con token (anduvo o no): se comparte entre instancias para mostrarla en Equipo.
async function noteRead(r) { B.read = { ...r, at: new Date().toISOString() }; await cacheSet("brain:read", B.read, 30 * 864e2); }

// El token guardado en Redis se relee cada minuto: si otra instancia cargó uno nuevo, se toma su copia de los sitios.
async function loadToken(force = false) {
  if (!force && Date.now() - T.checked < 60e3) return;
  if (!T.inflight) T.inflight = (async () => {
    try {
      const rec = await getBrainToken();
      const before = active()?.token;
      T.stored = rec?.token ? rec : null;
      if (active()?.token !== before) tokenChanged(Date.parse(T.stored?.at) || Date.now());
    } catch (e) { console.warn("brain: no se pudo leer el token guardado:", e.message); }
    finally { T.checked = Date.now(); T.inflight = null; }
  })();
  await T.inflight;
}
// Cambió el token en uso: lo que se esté leyendo con el anterior se descarta y se vuelve a leer (primero la copia compartida,
// si es de después del cambio).
function tokenChanged(since) {
  T.gen++; B.since = since; B.error = ""; B.auth = false; B.stale = false; B.read = null;
  if (enabled()) B.at = 0; else set([], 0);
}

// Trae los sitios si pasaron 15 min (o nunca). La primera vez espera; después actualiza atrás.
// Comparte la copia entre instancias por la cache de Redis y guarda una copia de respaldo de 30 días.
// Las copias guardan la fecha de los datos ({ at, sites }); las viejas (solo la lista) quedan sin fecha.
// Si OrderBrain falla, queda stale con la fecha de los datos que se siguen usando (los de memoria o la copia).
// Si no hay ninguna copia, reintenta al minuto y queda el error a la vista.
const unpack = v => Array.isArray(v) ? { sites: v, at: 0 } : v && Array.isArray(v.sites) ? { sites: v.sites, at: Number(v.at) || 0 } : null;
function refresh() {
  const gen = T.gen;
  const p = (async () => {
    try {
      let got = B.at ? null : unpack(await cacheGet("brain:sites"));
      if (got && !got.at) got.at = Date.now(); // copia compartida de formato viejo: dura 15 min, es de recién
      if (got && got.at < B.since) got = null; // de antes del token nuevo
      if (!got) {
        const tok = active();
        got = { sites: tok ? await fetchSites(tok.token) : demoSites(), at: Date.now() };
        if (gen !== T.gen) return; // mientras tanto cambió el token: esta lectura no vale
        await cacheSet("brain:sites", got, TTL / 1000);
        if (got.sites.length) await cacheSet("brain:last", got, 30 * 864e2);
        if (tok) await noteRead({ ok: true, n: got.sites.length });
      }
      if (gen !== T.gen) return;
      set(got.sites, got.at); B.error = ""; B.auth = false; B.stale = false;
    } catch (e) {
      if (gen !== T.gen) return;
      B.auth = e.code === "auth";
      B.error = B.auth ? `${e.message}. Un líder puede cargar uno nuevo en Equipo.` : e.message;
      console.error("brain:", B.error);
      await noteRead({ ok: false, error: B.error, auth: B.auth }).catch(() => {});
      if (B.sites.length) B.stale = true;
      else { const last = unpack(await cacheGet("brain:last").catch(() => null)); if (last?.sites.length) { set(last.sites, last.at); B.stale = true; } }
      // reintento rápido: al minuto si no hay nada, a los 5 si quedó una copia
      B.at = Date.now() - TTL + (B.sites.length ? 5 * 60e3 : 60e3);
    } finally { if (B.inflight === p) B.inflight = null; }
  })();
  B.inflight = p; B.inflightGen = gen;
  return p;
}
export async function ensureBrain() {
  await loadToken();
  if (!enabled()) return;
  if (Date.now() - B.at < TTL) return;
  if (!B.inflight || B.inflightGen !== T.gen) refresh();
  if (!B.at) await B.inflight;
}
// Sin datos de OrderBrain (falló y no hay copia): la app avisa que los clientes pueden aparecer para llamar.
export const brainDown = () => enabled() && !!B.error && !B.sites.length;
function set(sites, dataAt) { B.sites = sites; B.at = Date.now(); B.dataAt = dataAt || 0; B.ver++; index = null; memo = new Map(); sgrid = null; }

// ---------- token desde Equipo (solo líderes; las rutas están en server.js)
// Se prueba contra /api/sites ANTES de guardarlo: si falla, no se guarda y se dice por qué.
// Si anda, se usan los sitios recién leídos y se deja la copia compartida antes de guardar el token,
// así las otras instancias, al ver el token nuevo (en menos de un minuto), toman esta copia.
export async function saveBrainToken(raw, by) {
  const token = cleanToken(raw);
  let sites;
  try { sites = await fetchSites(token); }
  catch (e) { throw Object.assign(new Error(`No lo guardé: ${e.message}.`), { status: 400 }); }
  if (!sites.length) throw Object.assign(new Error("No lo guardé: OrderBrain respondió sin sitios. ¿Es de una cuenta que ve World Dominion?"), { status: 400 });
  const at = Date.now(), got = { sites, at }, read = { ok: true, n: sites.length, at: new Date(at).toISOString() }; // la lectura que acaba de andar
  await cacheSet("brain:sites", got, TTL / 1000);
  await cacheSet("brain:last", got, 30 * 864e2);
  await cacheSet("brain:read", read, 30 * 864e2);
  const rec = { token, by: String(by || "").slice(0, 120), at: new Date(at).toISOString() };
  await setBrainToken(rec);
  T.stored = rec; T.checked = Date.now();
  tokenChanged(at);
  set(sites, at); B.read = read;
  return brainAdmin({ fresh: true });
}
// la última lectura con token, de esta instancia o de cualquiera (copia compartida)
const lastRead = async () => [B.read, await cacheGet("brain:read")].filter(r => r?.at).sort((a, b) => String(b.at).localeCompare(String(a.at)))[0] || null;
// Estado para Equipo (solo líderes). Nunca lleva el token: quién y cuándo lo cargó, cuándo vence y cómo anduvo la última lectura.
// lastRead.auth: OrderBrain rechazó el token (aunque su fecha diga que todavía no venció).
export async function brainAdmin({ fresh = false } = {}) {
  // lo último, aunque lo haya cargado otra instancia; si hay una lectura en curso, su resultado
  if (!fresh) { await loadToken(true); await ensureBrain(); if (B.inflight) await B.inflight; }
  const read = await lastRead();
  const tok = active(), exp = tok ? tokenExp(tok.token) : null, sexp = T.stored ? tokenExp(T.stored.token) : null;
  return {
    host: URL_BASE.replace(/^https?:\/\//, ""), demo: isDemo(), enabled: enabled(),
    source: tok?.source || null, envToken: !!ENV_TOKEN,
    exp: exp ? new Date(exp).toISOString() : null, expiry: tok ? expiryState(exp) : null,
    loaded: T.stored ? { by: T.stored.by || "", at: T.stored.at, exp: sexp ? new Date(sexp).toISOString() : null, expiry: expiryState(sexp), inUse: tok?.source === "app" } : null,
    sites: B.sites.length, dataAt: B.dataAt ? new Date(B.dataAt).toISOString() : null, stale: !!B.stale, error: B.error || "", down: brainDown(),
    lastRead: read && { ok: !!read.ok, at: read.at, error: read.error || "", n: read.n ?? null, auth: !!read.auth },
  };
}
// Aviso para los líderes fuera de Equipo (Hoy y la pestaña Equipo), sin el token: null si no hay nada que hacer.
// missing: no hay token; rejected: OrderBrain lo rechazó en la última lectura; expiry: "expired" o "soon" (vence en < 3 días).
export async function brainTokenAlert() {
  if (isDemo()) return null;
  const tok = active();
  if (!tok) return { missing: true };
  const read = await lastRead(), exp = tokenExp(tok.token), expiry = expiryState(exp);
  const rejected = !!(read && !read.ok && read.auth);
  if (!rejected && expiry !== "expired" && expiry !== "soon") return null;
  return { rejected, expiry, exp: exp ? new Date(exp).toISOString() : null };
}

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
  if (!enabled()) return { enabled: false };
  const bySite = new Map();
  for (const s of schools) { const b = brainOf(s); if (b) { const x = siteFor(s); if (x && !bySite.has(x.id)) bySite.set(x.id, s.id); } }
  return {
    enabled: true, demo: isDemo(), error: B.error, auth: !!(B.error && B.auth), down: brainDown(), stale: !!B.stale, updatedAt: B.dataAt ? new Date(B.dataAt).toISOString() : null,
    sites: B.sites.filter(x => x.lat != null && x.lng != null).map(x => ({ id: x.id, name: x.name, client: x.client, status: x.status, label: LABEL[x.status] || x.status, churn: isChurn(x.status), lat: x.lat, lng: x.lng, city: x.city, country: x.country, schoolId: bySite.get(x.id) || null })),
  };
}
export const brainVersion = () => B.ver;
// Clientes activos (no churn) de OrderEAT a menos de r km: referencias de la zona. Grilla de ~5 km por versión de datos.
let cgrid = null, cgridV = -1;
export function nearbyClients(lat, lng, r = 3) {
  if (lat == null || lng == null || !B.sites.length) return 0;
  if (!cgrid || cgridV !== B.ver) {
    cgrid = new Map(); cgridV = B.ver;
    for (const x of B.sites) if (x.lat != null && x.lng != null && !isChurn(x.status)) { const k = `${Math.floor(x.lat * 20)}|${Math.floor(x.lng * 20)}`; if (!cgrid.has(k)) cgrid.set(k, []); cgrid.get(k).push(x); }
  }
  const a = Math.floor(lat * 20), b = Math.floor(lng * 20), p = { lat, lng }; let n = 0;
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const x of cgrid.get(`${a + i}|${b + j}`) || []) if (km(p, x) < r && km(p, x) > 0.05) n++;
  return n;
}
