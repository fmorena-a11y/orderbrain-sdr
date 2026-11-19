// Lista de colegios y su resumen (estado efectivo con World Dominion y archivados, alto potencial).
import crypto from "crypto";
import { STALE_MS, byId, canonicalId, getArchived, getMatch, isFresh, schools, storeRev, touchesFor, touchesSince, allMatches } from "../store.js";
import { MARKETS } from "../config.js";
import { norm } from "../text.js";
import { countAttempts, outcomeById } from "../playbook.js";
import { brainOf, brainVersion, nearbyClients } from "../brain.js";
import { potentialOf } from "../potential.js";

// Para la lista (puede haber decenas de miles): solo lo que usa la interfaz. La ficha trae el resto.
// (sin `found` ni `src`: el navegador no los lee de la lista y eran ≈740 KB; el Radar agrega `found` por su cuenta)
const LIST_FIELDS = ["id", "name", "city", "country", "lat", "lng", "addr", "phone", "web", "rating", "fit", "area", "osm"];
const BRAIN_PHASE = st => /^Churn/.test(st) ? "churn" : { Active: "activo", Onboarding: "onboarding", Closed: "cerrado" }[st] || null;
// Cruce efectivo: si OrderBrain dice que ya es cliente, manda eso aunque Pipedrive no lo tenga.
export function effMatch(s) {
  const m = getMatch(s.id), fm = isFresh(m) ? m : null, b = brainOf(s);
  if (b?.client) return { ...(fm || {}), status: "client", detail: `Cliente en OrderBrain (${b.label})`, checkedAt: new Date().toISOString() };
  // archivado en la app: fuera de la cola, del alto potencial y de las sesiones
  const a = getArchived(s.id); if (a) return { ...(fm || {}), status: "archived", detail: archiveDetail(a), checkedAt: new Date().toISOString() };
  // ex cliente (churn en World Dominion o en Pipedrive): nunca puede ser «nunca contactado»
  if ((b?.churn || fm?.phase === "churn") && fm?.status !== "open") return { ...(fm || {}), status: "churn", churnLabel: b?.label || "Se dio de baja (Pipedrive)", detail: b?.churn ? `${b.label} (OrderBrain)` : "Se dio de baja según Pipedrive", checkedAt: new Date().toISOString() };
  return fm;
}
const archiveDetail = a => `Archivado: ${a.reason}${a.text ? ` · ${a.text}` : ""}`;
// Alto potencial (lib/potential.js): solo para lo que se puede contactar (no clientes, ex clientes, tratos abiertos ni archivados).
const potMemo = new Map(); let potV = -1;
export function potentialFor(s, status) {
  if (["client", "churn", "open", "archived"].includes(status)) return null;
  if (potV !== brainVersion()) { potMemo.clear(); potV = brainVersion(); }
  if (!potMemo.has(s.id)) { const r = potentialOf(s, { nearClients: nearbyClients(s.lat, s.lng) }); potMemo.set(s.id, r?.high ? r.why : null); }
  return potMemo.get(s.id);
}
export function schoolListItem(s) {
  const full = schoolSummary(s), out = {};
  if (getMatch(s.id)?.addrManual) full.addr = getMatch(s.id).addrManual;
  for (const k of [...LIST_FIELDS, "status", "detail", "orgId", "lastTouch", "attempts", "ob", "phase", "ownerId", "ownerName", "lead"]) if (full[k] !== undefined && full[k] !== "" && full[k] !== null) out[k] = full[k];
  if (!out.status) out.status = "unk";
  if (!out.attempts) delete out.attempts;
  if (!out.lead) delete out.lead;
  if (full.pot) out.pot = full.pot;
  return out;
}
// La lista para /api/schools, ya en JSON, con su ETag (del contenido: el mismo en cualquier instancia). Armarla y pasarla a
// JSON cuesta (≈120 ms con 22.000) y la pide cada entrada a la app: se guarda mientras nada de lo que muestra haya cambiado
// (storeRev: cruces, contactos, archivados y colegios sumados, también lo que trae sync() de otras instancias; la versión de
// World Dominion), hasta que al primer cruce le toque vencer (isFresh mira la hora) y nunca más de LIST_MAX_MS, por si algún
// día algo cambia un colegio sin subir la versión. `enc`: las copias comprimidas (las llena la ruta).
// Por país (decisión del líder: «por país»; la base va a 50.000–60.000 con los padrones): cada país es su propia copia con su
// ETag, así el navegador baja solo los países que trabaja y cada uno vale 304 por separado. Un país con más de PART_MAX
// colegios se pide en partes (parts = partsFor(n), lo dice el resumen): cada colegio va a la parte hash(id) % parts, igual en
// cualquier instancia. Así ninguna respuesta pasa el tope de 4,5 MB de una función de Vercel (México con su padrón: ≈30.000).
const LIST_MAX_MS = 60e3, PART_MAX = 8000;
const memos = new Map(); // "*" (toda la base) o "país|parte/partes" → { key, until, json, count, etag, enc }
const verKey = () => `${schools.length}:${storeRev()}:${brainVersion()}`;
const etagOf = buf => `W/"${buf.length.toString(16)}-${crypto.createHash("sha1").update(buf).digest("base64").slice(0, 27)}"`;
function memoJson(mk, pick, build, now) {
  const key = verKey(), prev = memos.get(mk);
  if (prev && prev.key === key && now < prev.until) return prev;
  let until = now + LIST_MAX_MS;
  const fresh = s => { const m = getMatch(s.id); if (isFresh(m)) until = Math.min(until, Date.parse(m.checkedAt) + STALE_MS); };
  const data = build(pick(), fresh), json = Buffer.from(JSON.stringify(data)), etag = etagOf(json);
  // se rearmó pero quedó igual (un cruce revisado de nuevo con el mismo resultado): valen las copias comprimidas que ya había
  const L = { key, until, json, count: Array.isArray(data) ? data.length : data.total, etag, enc: prev?.etag === etag ? prev.enc : {} };
  memos.set(mk, L); return L;
}
const asList = (arr, fresh) => arr.map(s => { fresh(s); return schoolListItem(s); });
// colegios por país (se rearma cuando entran colegios nuevos: la base solo crece)
let cIdx = { n: -1, map: new Map() };
function byCountry() {
  if (cIdx.n === schools.length) return cIdx.map;
  const map = new Map();
  for (const s of schools) { const c = s.country || ""; let a = map.get(c); if (!a) map.set(c, a = []); a.push(s); }
  return (cIdx = { n: schools.length, map }).map;
}
export const partsFor = n => Math.max(1, Math.ceil(n / PART_MAX));
// FNV-1a: la misma parte para el mismo id en cualquier instancia
export const partOf = (id, parts) => { let h = 2166136261; for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) % parts; };
// el país de lo que pide el navegador: el nombre como está en la base («México») o su código («MX»); null si no hay colegios de ese país
export function countryParam(v) {
  const t = norm(v); if (!t) return null;
  for (const c of byCountry().keys()) if (c && (norm(c) === t || norm(MARKETS[c]?.code) === t)) return c;
  return null;
}
export function schoolList(now = Date.now(), { country = null, part = 0, parts = 1 } = {}) {
  if (!country) return memoJson("*", () => schools, asList, now);
  const all = byCountry().get(country) || [];
  return memoJson(`${country}|${part}/${parts}`, () => parts > 1 ? all.filter(s => partOf(s.id, parts) === part) : all, asList, now);
}
// ---------- resumen por país y ciudad (GET /api/schools/summary): la vista mundial de Prospectar y los chips de país sin bajar
// la base. Por ciudad: [ciudad, colegios, lat, lng (promedio), sin revisar, para llamar sin dueño (Nunca contactado, En Pipe sin
// trato, Contactado sin avance, Perdido), { dueño: para llamar con dueño }, { marca: cuántos }]. «Para llamar» depende de quién
// mira (lo de otra persona no se llama): el navegador suma lo sin dueño y lo suyo (prosOf de public/js/schoolsum.js).
// La marca es la del mapa (markOf de core.js): la fase manda («ph-activo»…), si no el estado.
const PROS = new Set(["new", "org", "stalled", "lost"]);
export function schoolsSummary(now = Date.now()) {
  return memoJson("summary", () => byCountry(), (map, fresh) => {
    const countries = [];
    let total = 0;
    for (const [country, arr] of [...map.entries()].filter(([c]) => c).sort((a, b) => a[0].localeCompare(b[0]))) {
      const cities = new Map();
      for (const s of arr) {
        fresh(s);
        const x = stateOf(s), k = x.phase ? `ph-${x.phase}` : x.st;
        let c = cities.get(s.city); if (!c) cities.set(s.city, c = { n: 0, lat: 0, lng: 0, ll: 0, unk: 0, pf: 0, po: {}, k: {} });
        c.n++; c.k[k] = (c.k[k] || 0) + 1;
        if (typeof s.lat === "number" && typeof s.lng === "number") { c.lat += s.lat; c.lng += s.lng; c.ll++; }
        if (x.st === "unk") c.unk++;
        else if (PROS.has(x.st)) { if (x.ownerId) c.po[x.ownerId] = (c.po[x.ownerId] || 0) + 1; else c.pf++; }
      }
      const r6 = v => Math.round(v * 1e5) / 1e5;
      countries.push({ country, n: arr.length, parts: partsFor(arr.length), cities: [...cities.entries()].map(([city, c]) => [city || "", c.n, c.ll ? r6(c.lat / c.ll) : null, c.ll ? r6(c.lng / c.ll) : null, c.unk, c.pf, c.po, c.k]) });
      total += arr.length;
    }
    return { total, countries };
  }, now);
}
// ---------- buscar en toda la base (GET /api/schools/search): lo que el navegador no tiene cargado. Por nombre, ciudad,
// dirección y país (sin acentos, como schoolIdx de core.js) o, un teléfono, por sus últimos 8 dígitos. El texto de cada
// colegio se normaliza una vez (se rearma cuando entran colegios).
let sIdx = { n: -1, list: [] };
function searchIdx() {
  if (sIdx.n === schools.length) return sIdx.list;
  return (sIdx = { n: schools.length, list: schools.map(s => ({ s, n: norm(s.name), t: norm([s.name, s.city, s.addr, s.country].filter(Boolean).join(" ")), d: String(s.phone || "").replace(/\D/g, "") })) }).list;
}
export function searchSchools(q, { not = [], only = [], limit = 50 } = {}) {
  const raw = String(q || ""), f = norm(raw), digits = raw.replace(/\D/g, ""), phone = digits.length >= 6 && !/[a-z]/i.test(raw);
  const key = phone ? digits.slice(-Math.min(digits.length, 8)) : "";
  if (!phone && f.length < 2) return { total: 0, items: [] };
  const skip = new Set(not), keep = new Set(only), hits = [];
  for (const x of searchIdx()) {
    if (skip.has(x.s.country) || (keep.size && !keep.has(x.s.country))) continue;
    if (phone ? x.d.includes(key) : x.t.includes(f)) hits.push(x);
  }
  // primero el nombre que empieza con lo escrito, después el nombre que lo contiene, el nombre más corto
  const rk = x => phone ? 0 : x.n.startsWith(f) ? 0 : x.n.includes(f) ? 1 : 2;
  hits.sort((a, b) => rk(a) - rk(b) || a.s.name.length - b.s.name.length);
  return { total: hits.length, items: hits.slice(0, limit).map(x => schoolListItem(x.s)) };
}
// ---------- colegios sueltos (GET /api/schools/items?ids=): la ficha de un colegio de un país que el navegador no cargó (desde
// Hoy, la Agenda, una sesión o una búsqueda). Responde { id pedido: colegio } (un id viejo trae el colegio con su id de ahora).
export function schoolItems(ids) {
  const out = {};
  for (const id of ids) { const s = byId.get(canonicalId(id)); if (s && !s.virtual && !/^(pd-|bx-|in-)/.test(s.id)) out[id] = schoolListItem(s); }
  return out;
}
// ---------- países donde trabaja una persona (los que el navegador carga si todavía no eligió su territorio): sus contactos de los
// últimos 90 días y las organizaciones a su nombre de la base. Va un país si tiene al menos el 10 % de lo suyo (hasta 3, de más
// a menos). Un líder sin nada propio: los contactos de todo el equipo de los últimos 30 días. Nada: [] (el navegador carga todo).
const WORK_MS = 5 * 60e3, workMemo = new Map();
const topCountries = cnt => { const tot = [...cnt.values()].reduce((a, b) => a + b, 0); return [...cnt.entries()].filter(([, n]) => tot && n / tot >= 0.1).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([c]) => c); };
export function workCountries({ email = "", pdUserId = null, leader = false } = {}, now = Date.now()) {
  const mk = `${String(email).toLowerCase()}|${pdUserId || ""}|${leader ? 1 : 0}`, hit = workMemo.get(mk);
  if (hit && now - hit.at < WORK_MS) return hit.list;
  const cnt = new Map(), add = (id, w = 1) => { const c = byId.get(canonicalId(id))?.country; if (c) cnt.set(c, (cnt.get(c) || 0) + w); };
  const me = String(email).toLowerCase();
  for (const t of touchesSince(now - 90 * 864e5)) if (String(t.by || "").toLowerCase() === me) add(t.schoolId);
  if (pdUserId) for (const [id, m] of Object.entries(allMatches())) if (m && Number(m.ownerId) === Number(pdUserId) && isFresh(m)) add(id);
  let list = topCountries(cnt);
  if (!list.length && leader) { const all = new Map(); for (const t of touchesSince(now - 30 * 864e5)) { const c = byId.get(canonicalId(t.schoolId))?.country; if (c) all.set(c, (all.get(c) || 0) + 1); } list = topCountries(all); }
  workMemo.set(mk, { at: now, list }); if (workMemo.size > 500) workMemo.delete(workMemo.keys().next().value);
  return list;
}
// El estado de un colegio (una sola regla para la lista, el resumen y la ficha): World Dominion manda (cliente), después
// archivado, ex cliente (churn) y el cruce al día; sin cruce al día, «Sin revisar».
function stateOf(s) {
  const m = getMatch(s.id), fresh = !!(m && isFresh(m)), b = brainOf(s);
  const churn = (b?.churn || (fresh && m.phase === "churn")) && !(fresh && m.status === "open");
  const arch = !b?.client && getArchived(s.id), st = b?.client ? "client" : arch ? "archived" : churn ? "churn" : fresh ? m.status : "unk";
  // World Dominion manda; si no está ahí, lo que dicen los tratos de Pipedrive
  const phase = arch ? null : b ? BRAIN_PHASE(b.status) : fresh ? m.phase || null : null;
  return { m, fresh, b, churn, arch, st, phase, ownerId: fresh ? m.ownerId || null : null };
}
export function schoolSummary(s) {
  const { m, fresh, b, churn, arch, st, phase, ownerId } = stateOf(s);
  const t = touchesFor(s.id);
  const last = t[t.length - 1];
  return { ...s, status: st,
    detail: b?.client ? `Cliente en OrderBrain (${b.label})` : arch ? archiveDetail(arch) : churn ? (b?.churn ? `${b.label} (OrderBrain)` : "Se dio de baja según Pipedrive") : m?.detail || "", orgId: m?.orgId || null, checkedAt: m?.checkedAt || null,
    ownerId, ownerName: fresh ? m.ownerName || "" : "", lead: !!(fresh && m.leadId && m.status !== "open"),
    ob: b ? { label: b.label, churn: b.churn, site: b.site, client: b.clientName } : null,
    phase,
    lastTouch: last ? { at: last.at, by: last.byName, outcome: outcomeById(last.outcome)?.label || "" } : null, attempts: countAttempts(t),
    pot: potentialFor(s, st) || undefined };
}
