// Lista de colegios y su resumen (estado efectivo con World Dominion y archivados, alto potencial).
import crypto from "crypto";
import { STALE_MS, getArchived, getMatch, isFresh, schools, storeRev, touchesFor } from "../store.js";
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
// La lista entera para /api/schools, ya en JSON, con su ETag (del contenido: el mismo en cualquier instancia). Armarla y
// pasarla a JSON cuesta ≈120 ms y la pide cada entrada a la app: se guarda mientras nada de lo que muestra haya cambiado
// (storeRev: cruces, contactos, archivados y colegios sumados, también lo que trae sync() de otras instancias; la versión de
// World Dominion), hasta que al primer cruce le toque vencer (isFresh mira la hora) y nunca más de LIST_MAX_MS, por si algún
// día algo cambia un colegio sin subir la versión. `enc`: las copias comprimidas (las llena la ruta).
const LIST_MAX_MS = 60e3;
let listMemo = null;
export function schoolList(now = Date.now()) {
  const key = `${schools.length}:${storeRev()}:${brainVersion()}`;
  if (listMemo && listMemo.key === key && now < listMemo.until) return listMemo;
  let until = now + LIST_MAX_MS;
  const list = schools.map(s => { const m = getMatch(s.id); if (isFresh(m)) until = Math.min(until, Date.parse(m.checkedAt) + STALE_MS); return schoolListItem(s); });
  const json = Buffer.from(JSON.stringify(list)), etag = `W/"${json.length.toString(16)}-${crypto.createHash("sha1").update(json).digest("base64").slice(0, 27)}"`;
  // se rearmó pero quedó igual (un cruce revisado de nuevo con el mismo resultado): valen las copias comprimidas que ya había
  return listMemo = { key, until, json, count: list.length, etag, enc: listMemo?.etag === etag ? listMemo.enc : {} };
}
export function schoolSummary(s) {
  const m = getMatch(s.id);
  const fresh = m && isFresh(m);
  const t = touchesFor(s.id);
  const last = t[t.length - 1];
  const b = brainOf(s);
  const churn = (b?.churn || (fresh && m.phase === "churn")) && !(fresh && m.status === "open");
  const arch = !b?.client && getArchived(s.id), st = b?.client ? "client" : arch ? "archived" : churn ? "churn" : fresh ? m.status : "unk";
  return { ...s, status: st,
    detail: b?.client ? `Cliente en OrderBrain (${b.label})` : arch ? archiveDetail(arch) : churn ? (b?.churn ? `${b.label} (OrderBrain)` : "Se dio de baja según Pipedrive") : m?.detail || "", orgId: m?.orgId || null, checkedAt: m?.checkedAt || null,
    ownerId: fresh ? m.ownerId || null : null, ownerName: fresh ? m.ownerName || "" : "", lead: !!(fresh && m.leadId && m.status !== "open"),
    ob: b ? { label: b.label, churn: b.churn, site: b.site, client: b.clientName } : null,
    // World Dominion manda; si no está ahí, lo que dicen los tratos de Pipedrive
    phase: arch ? null : b ? BRAIN_PHASE(b.status) : fresh ? m.phase || null : null,
    lastTouch: last ? { at: last.at, by: last.byName, outcome: outcomeById(last.outcome)?.label || "" } : null, attempts: countAttempts(t),
    pot: potentialFor(s, st) || undefined };
}
