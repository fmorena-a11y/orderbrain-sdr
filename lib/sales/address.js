// Dirección de la ficha y campos del prospecto nuevo (leadFields).
import * as pd from "../pipedrive.js";
import { byId, getMatch, setMatch } from "../store.js";
import { DEAL_FIELDS, OPTIONS } from "../config.js";
import { reverseAddress } from "../scan.js";
import { bad } from "../text.js";
import { signer } from "./util.js";
import { leadUrlOf } from "./worklead.js";

// ---------- dirección y campos del prospecto
// Un teléfono o un mail «limpio» para el campo del prospecto: lo que encontró el estudio viene con aclaraciones
// («0341 421-4278 (San Juan 1650; atención de lunes a viernes…)»): va solo el número o la dirección de mail.
export const cleanPhoneVal = v => { const m = String(v || "").match(/\+?\d[\d\s().\/-]{5,}\d/); return m ? m[0].replace(/\s+/g, " ").trim() : ""; };
export const cleanMailVal = v => (String(v || "").match(/[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[a-z]{2,}/i) || [""])[0];
// ---------- dirección de la ficha: la que escribió alguien a mano (pedido del líder: «tenés que poner la ubicación de la
// institución a mano») manda; si no, la de la base; si no, la del punto del mapa (OpenStreetMap, marcada «del mapa»).
export async function addressView(id) {
  const s = byId.get(id); if (!s) throw bad("Colegio inexistente", 404);
  const m = getMatch(id) || {};
  if (m.addrManual) return { addr: m.addrManual, src: "manual", by: m.addrBy || "", at: m.addrAt || null };
  if (s.addr) return { addr: s.addr, src: "base" };
  const rev = s.lat != null && s.lng != null && !pd.DEMO ? await reverseAddress(s.lat, s.lng).catch(() => null) : null;
  const near = rev && (!s.city || [rev.city, rev.suburb].some(c => c && (fold(c).includes(fold(s.city)) || fold(s.city).includes(fold(c)))));
  if (near && rev.street) return { addr: addrLine([rev.street, rev.suburb]), src: "mapa", state: rev.state || "" };
  return { addr: "", src: "ciudad" };
}
// Guardar la dirección escrita a mano: en el cruce (la ve todo el equipo) y en Pipedrive, en el prospecto abierto y la
// organización si son tuyos o libres (lo de otra persona no se toca, con aviso).
export async function setAddress(id, user, text) {
  const s = byId.get(id); if (!s) throw bad("Colegio inexistente", 404);
  const addr = String(text || "").replace(/\s+/g, " ").trim().slice(0, 200);
  if (addr.length < 4) throw bad("Escribí la calle y el número (y si querés, el barrio).");
  const me = Number(user.pdUserId) || null, done = [], warnings = [];
  setMatch(id, { ...(getMatch(id) || {}), addrManual: addr, addrBy: signer(user), addrAt: new Date().toISOString() });
  const line = addrLine([addr, s.city, s.state, s.country]);
  const rec = getMatch(id) || {};
  const leadId = s.leadId || rec.leadId || null;
  if (leadId) {
    const l = await pd.getLead(leadId).catch(() => null);
    if (l && !l.archived && (!l.ownerId || Number(l.ownerId) === me)) {
      const r = await pd.fillLead(l.id, { [DEAL_FIELDS.direccion]: line }).catch(e => ({ saved: [], error: e.message }));
      if (r.saved?.length) done.push({ label: "Dirección guardada en el prospecto", url: leadUrlOf(l.id) }); else warnings.push(`No pude guardarla en el prospecto (${r.error || "Pipedrive no la aceptó"}).`);
    } else if (l && l.ownerId && Number(l.ownerId) !== me) warnings.push("El prospecto es de otra persona: la dirección quedó solo en la app.");
  }
  if (rec.orgId) {
    const o = (await pd.orgsByIds([rec.orgId]).catch(() => []))[0];
    if (o && (!pd.realOwner(o.ownerId) || Number(o.ownerId) === me)) {
      await pd.updateOrganization(o.id, { address: { value: line } }).then(() => done.push({ label: "Dirección guardada en la organización", url: `${pd.PD_WEB}/organization/${o.id}` }))
        .catch(e => warnings.push(`No pude guardarla en la organización (${e.message}).`));
    } else if (o) warnings.push("La organización es de otra persona: la dirección quedó solo en la app.");
  }
  return { ok: true, addr, line, done, warnings };
}
export function addrLine(parts) {
  const out = [];
  for (const p of parts.map(x => String(x || "").trim()).filter(Boolean)) if (!out.some(o => fold(o).includes(fold(p)))) out.push(p);
  return out.join(", ");
}
const fold = x => String(x || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
// La dirección del prospecto (pedido del líder: «siempre crea el prospecto con dirección»): la de la base o la que encontró
// Enriquecer; si no hay, la del punto del colegio en el mapa (OpenStreetMap); como mínimo «ciudad, estado, país».
// Partes sin repetir (la dirección de la base a veces ya trae la ciudad).
async function addressFor(s, found = {}) {
  const st = s.state || "";
  const manual = getMatch(s.id)?.addrManual; if (manual) return { line: addrLine([manual, s.city, st, s.country]), state: st };
  if (s.addr) return { line: addrLine([s.addr, s.city, st, s.country]), state: st };
  if (found.addr) return { line: addrLine([found.addr, s.city, st, s.country]), state: st };
  const rev = s.lat != null && s.lng != null && !pd.DEMO ? await reverseAddress(s.lat, s.lng).catch(() => null) : null;
  // el punto del mapa sirve si cae en la misma ciudad (o la base no tiene ciudad)
  const sameCity = rev && (!s.city || [rev.city, rev.suburb].some(c => c && (fold(c).includes(fold(s.city)) || fold(s.city).includes(fold(c)))));
  if (rev && sameCity && rev.street) return { line: addrLine([rev.street, rev.suburb, s.city || rev.city, rev.state, s.country || rev.country]), state: st || rev.state };
  const state = st || (sameCity ? rev?.state || "" : "");
  return { line: addrLine([s.city, state, s.country]), state };
}
// Los campos del formulario «Añadir prospecto» de Pipedrive, con los mismos formatos que usa la cuenta:
// listas = número de opción; selección múltiple = números separados por comas; usuario = id; texto y dirección = texto.
export async function leadFields(s, user, found = {}) {
  const F = DEAL_FIELDS, f = {};
  const ad = await addressFor(s, found);
  const ciudad = await pd.optionFor(F.ciudad, s.city).catch(() => null); if (ciudad) f[F.ciudad] = ciudad;
  if (ad.state) { const est = await pd.optionFor(F.estado, ad.state).catch(() => null); if (est) f[F.estado] = est; }
  if (OPTIONS.pais[s.country]) f[F.pais] = OPTIONS.pais[s.country];
  f[F.fuente] = String(OPTIONS.fuente.coldCalling);
  if (user.pdUserId) f[F.sdr] = user.pdUserId;
  const phone = cleanPhoneVal(s.phone) || (found.phones || []).map(cleanPhoneVal).find(Boolean), email = cleanMailVal(s.email) || (found.emails || []).map(cleanMailVal).find(Boolean);
  if (phone) f[F.telefono] = phone;
  if (email) f[F.email] = email;
  if (s.web) f[F.web] = s.web;
  if (ad.line) f[F.direccion] = ad.line;
  const niv = (s.levels || []).map(n => OPTIONS.niveles[n]).filter(Boolean); if (niv.length) f[F.niveles] = niv.join(",");
  return f;
}
