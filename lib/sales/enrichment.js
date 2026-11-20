// Enriquecer y los campos vacíos del prospecto (leadGaps, fillLeadGaps).
import crypto from "crypto";
import * as pd from "../pipedrive.js";
import { byId, cacheGet, cacheSet, getMatch, getStudy, withLock } from "../store.js";
import { DEAL_FIELDS } from "../config.js";
import { placesLookup, webInfo } from "../enrich.js";
import { photosFor } from "../photos.js";
import { bad, esc } from "../text.js";
import { signer } from "./util.js";
import { checkSchool } from "./match.js";
import { leadsHere } from "./settle.js";
import { joinY } from "./link.js";
import { sedeCache, sedesFor, splitMails, splitPhones } from "./sedes.js";
import { pickContactLead } from "./worklead.js";
import { cleanMailVal, cleanPhoneVal, leadFields } from "./address.js";

// ---------- Enriquecer: el SDR ve que falta información y pide juntar todo lo que hay del colegio.
// Junta Pipedrive (prospectos y sedes), su web, Google Maps (si hay clave) y el estudio (si existe), lo guarda para la ficha
// y lo deja como nota en Pipedrive (solo si es tuyo o libre, y sin repetir la misma nota). Nada se deduce: cada dato lleva su fuente.
export const getEnrich = id => cacheGet("enrich:" + id);
// lo que ya estaba (en la base o en Pipedrive: la persona o el propio prospecto) no cuenta como dato nuevo para la nota
const BASE_SRC = new Set(["Base de colegios", "Persona en Pipedrive", "Prospecto en Pipedrive"]);
// photos: false (el automático de un prospecto nuevo) no busca fotos: son para la ficha, no para Pipedrive
export async function enrichSchool(id, user, by = "", { photos: withPhotos = true } = {}) {
  const s = byId.get(id); if (!s) throw bad("Colegio inexistente", 404);
  return withLock("enrich:" + id, async () => {
    const prev = await getEnrich(id).catch(() => null);
    // dueño al día antes de escribir nada
    const rec = s.leadOnly ? getMatch(id) || {} : await checkSchool(id, { force: true }).catch(() => getMatch(id) || {});
    // el prospecto del colegio: el de la ficha, el único abierto o el tuyo (como al registrar un contacto)
    const open = s.leadOnly || !rec.orgId ? [] : await leadsHere(s, rec.orgId).catch(() => []);
    const own = s.leadOnly ? (await pd.leadsByIds([s.leadId]).catch(() => []))[0] : pickContactLead(open, s.leadId || rec.leadId || null, user.pdUserId) || open[0] || null;
    // no se vuelve a consultar todo (Google cobra por consulta) si se enriqueció hace menos de 6 horas
    const fresh = prev && Date.now() - new Date(prev.at).getTime() < 6 * 3600e3;
    let data = prev, photos = null;
    if (!fresh) {
      if (!sedeCache.get(id) || Date.now() - sedeCache.get(id).at > 600e3) sedeCache.delete(id);
      const sd = await sedesFor(id).catch(() => ({ sedes: [] }));
      // la web y de dónde salió (sus teléfonos, mails y fotos llevan esa misma fuente)
      let web = s.web || own?.web || sd.web || "", webSrc = s.web ? "Web del colegio" : own?.web ? "Web cargada en Pipedrive" : sd.webFrom ? `Web de la red (${sd.webFrom})` : "Web del colegio";
      if (web && !/^https?:\/\//i.test(web)) web = "https://" + web;
      const [w, g, st] = await Promise.all([
        web ? webInfo(web, AbortSignal.timeout(9000)).catch(e => ({ error: e.message })) : null,
        s.lat != null ? placesLookup(s, AbortSignal.timeout(12000)).catch(() => null) : null,
        getStudy(id).catch(() => null)]);
      const items = [], seen = new Set();
      const put = (kind, value, src) => { const v = String(value || "").trim(); const k = kind + ":" + v.toLowerCase().replace(/[^\da-z@.]/g, ""); if (!v || seen.has(k)) return; seen.add(k); items.push({ kind, value: v, src }); };
      const baseSrc = s.virtual ? "Persona en Pipedrive" : "Base de colegios";
      if (s.phone) put("tel", s.phone, baseSrc);
      splitPhones(own?.phone).forEach(p => put("tel", p, "Prospecto en Pipedrive"));
      (w?.phones || []).forEach(p => put("tel", p, webSrc));
      if (g?.internationalPhoneNumber) put("tel", g.internationalPhoneNumber, "Google Maps");
      (st?.contacto?.telefonos || []).forEach(p => put("tel", p, "Estudio"));
      if (w?.whatsapp) put("wa", w.whatsapp, webSrc);
      if (st?.contacto?.whatsapp) put("wa", st.contacto.whatsapp, "Estudio");
      if (s.email) put("mail", s.email, baseSrc);
      splitMails(own?.email).forEach(e => put("mail", e, "Prospecto en Pipedrive"));
      (w?.emails || []).forEach(e => put("mail", e, webSrc));
      (st?.contacto?.emails || []).forEach(e => put("mail", e, "Estudio"));
      if (web) put("web", web, s.web ? "Base de colegios" : own?.web ? "Prospecto en Pipedrive" : webSrc);
      if (g?.websiteUri) put("web", g.websiteUri, "Google Maps");
      // la web que encontró el estudio (la IA la lee de su sitio): antes no se mostraba en ningún lado
      if (st?.contacto?.web) put("web", /^https?:\/\//i.test(st.contacto.web) ? st.contacto.web : "https://" + st.contacto.web, "Estudio");
      if (s.addr) put("addr", [s.addr, s.city].filter(Boolean).join(", "), baseSrc);
      if (own?.addr) put("addr", own.addr, "Prospecto en Pipedrive");
      if (g?.formattedAddress) put("addr", g.formattedAddress, "Google Maps");
      if (st?.contacto?.direccion) put("addr", st.contacto.direccion, "Estudio");
      // los teléfonos que repiten otro con otro formato («4131045» y «614 413 1045») quedan una vez
      const tels = items.filter(x => x.kind === "tel");
      for (const x of tels) { const d = x.value.replace(/\D/g, ""); if (tels.some(y => y !== x && y.value.replace(/\D/g, "").length > d.length && y.value.replace(/\D/g, "").endsWith(d))) x.dup = true; }
      data = {
        at: new Date().toISOString(), by: by || signer(user), web, webSrc,
        items: items.filter(x => !x.dup).map(x => ({ ...x, known: BASE_SRC.has(x.src) })),
        rating: g?.rating ? { value: g.rating, count: g.userRatingCount || 0 } : null,
        decisores: (st?.decisores || []).filter(d => d?.nombre && !/sin datos|desconocid/i.test(d.nombre)).slice(0, 5),
        // el número tal cual lo publica la fuente; si la app completó la lada, se dice
        sedes: sd.sedes.map(x => ({ name: x.name, src: x.src, phones: x.phones.map(p => p.lada ? `${p.raw} (sin lada en la web; ${p.lada} es la de la red)` : p.n), emails: x.emails, addr: x.addr, here: x.here })),
        sources: { web: web ? (w?.error ? `no se pudo leer: ${w.error}` : "leída") : "no tiene", google: g ? "encontrado" : process.env.GOOGLE_MAPS_API_KEY ? "no lo encontró" : "no disponible", estudio: st ? "hecho" : "no hay" },
      };
      if (withPhotos) { photos = await photosFor(id, { refresh: true, web, webSrc }).catch(() => []); data.photos = photos.length; }
      else data.photos = prev?.photos || 0;
    }
    // nota en Pipedrive: en el prospecto (con su organización) si tiene uno abierto y no hay trato abierto; si no, en la
    // organización (confirmada) y su trato abierto tuyo. Solo si es tuyo o libre. Los datos van además a los campos vacíos
    // del prospecto (leadGaps: nunca se pisa lo que ya tiene).
    let note = { saved: false }, fields = null;
    const theirs = (uid, name) => uid && uid !== user.pdUserId ? `No guardé la nota: es de ${name || "otra persona"} en Pipedrive. Hablalo con esa persona.` : "";
    const nuevos = data.items.filter(x => !x.known).length + data.sedes.length + data.decisores.length;
    const m = await pd.meta().catch(() => ({ users: [] })), uname = uid => m.users.find(u => u.id === uid)?.name || "";
    const leadT = !s.leadOnly && own && !own.archived && !rec.openDealId ? own.id : null;
    const target = s.leadOnly ? { leadId: s.leadId } : rec.orgId && (rec.confirmed || rec.created)
      ? leadT ? { orgId: rec.orgId, leadId: leadT } : { orgId: rec.orgId, dealId: rec.openDealId && (!rec.openDealOwnerId || rec.openDealOwnerId === user.pdUserId) ? rec.openDealId : undefined } : null;
    if (!target) note.reason = rec.orgId ? "No guardé la nota: confirmá primero cuál es su organización en Pipedrive (en Historial)." : "Todavía no está en Pipedrive: lo guardo cuando crees el prospecto.";
    else if (s.leadOnly && own?.ownerId && own.ownerId !== user.pdUserId) note.reason = theirs(own.ownerId, uname(own.ownerId));
    else if (!s.leadOnly && rec.ownerId && rec.ownerId !== user.pdUserId) note.reason = theirs(rec.ownerId, rec.ownerName);
    else if (!s.leadOnly && own?.ownerId && own.ownerId !== user.pdUserId) note.reason = theirs(own.ownerId, uname(own.ownerId));
    const blocked = !!note.reason;
    // los datos van a los campos vacíos del prospecto aunque no haya nada nuevo para la nota (lo de la base también cuenta)
    if (target?.leadId && !blocked) fields = await fillLeadGaps(target.leadId, s, data, user);
    if (blocked) { /* el motivo ya está en note.reason */ }
    else if (!nuevos) note.reason = "No encontré nada que no estuviera ya: no hice nota.";
    else {
      const html = enrichHtml(s, data), key = `enrichnote:${target.leadId ? "lead:" + target.leadId : "org:" + target.orgId}`;
      const hash = crypto.createHash("sha1").update(JSON.stringify([data.items, data.sedes, data.decisores])).digest("hex");
      if ((await cacheGet(key)) === hash) note.reason = "Esto ya estaba en una nota de Pipedrive.";
      else {
        // en el prospecto y su organización; si Pipedrive no acepta las dos juntas, en el prospecto
        const add = () => pd.addNote({ content: html, ...target }).catch(e => { if (!(target.leadId && target.orgId)) throw e; return pd.addNote({ content: html, leadId: target.leadId }); });
        try { await add(); await cacheSet(key, hash, 365 * 86400); note = { saved: true, at: new Date().toISOString(), url: target.leadId ? `${pd.PD_WEB}/leads/inbox/${target.leadId}` : `${pd.PD_WEB}/organization/${target.orgId}`, ...(target.leadId ? { lead: true } : {}) }; }
        catch (e) { note.reason = `No pude guardar la nota en Pipedrive (${e.message}). Probá de nuevo.`; }
      }
    }
    data = { ...data, nuevos, note: note.saved ? note : data.note?.saved ? data.note : note, ...(fields?.saved.length ? { fields: { ...fields, at: new Date().toISOString() } } : {}) };
    await cacheSet("enrich:" + id, data, 180 * 86400);
    return { data, note, fields: fields || { saved: [] }, photos: withPhotos ? photos ?? await photosFor(id).catch(() => []) : [] };
  });
}
const SRC_LABEL = { tel: "Teléfono", wa: "WhatsApp", mail: "Mail", web: "Web", addr: "Dirección" };
function enrichHtml(s, d) {
  const li = x => `<li>${esc(x)}</li>`;
  const rows = ["tel", "wa", "mail", "web", "addr"].flatMap(k => d.items.filter(x => x.kind === k).map(x => li(`${SRC_LABEL[k]}: ${x.value} (${x.src})`)));
  return [`<b>Datos del colegio · OrderBrain SDR</b>`, `Enriquecido el ${d.at.slice(0, 10)} por ${esc(d.by)}. Cada dato dice de dónde salió.`,
    rows.length ? `<ul>${rows.join("")}</ul>` : "",
    d.rating ? `Google Maps: ${d.rating.value}★ (${d.rating.count} reseñas)` : "",
    d.decisores.length ? `<b>Decisores (estudio)</b><ul>${d.decisores.map(x => li(`${x.nombre}${x.cargo ? ` · ${x.cargo}` : ""}${x.fuente ? ` · ${x.fuente}` : ""}`)).join("")}</ul>` : "",
    d.sedes.length ? `<b>Sedes (${d.sedes.length})</b><ul>${d.sedes.map(x => li([x.name, ...x.phones, ...x.emails, x.addr].filter(Boolean).join(" · ") + ` (${x.src.join(", ")})`)).join("")}</ul>` : "",
  ].filter(Boolean).join("<br>");
}

// ---------- campos del prospecto: lo que encontró «Enriquecer» (y la base) va a los campos VACÍOS del prospecto; nunca se
// pisa lo que ya tiene. «No encontrado», «sin datos», «N/A» o «-» cuentan como vacíos (no son un dato).
const F_LEAD = { telefono: "phone", email: "email", web: "web", direccion: "addr", pais: "paisOpt", ciudad: "ciudadOpt", estado: "estadoOpt", niveles: "nivelesOpt" };
export const LEAD_FIELD_LABEL = { telefono: "teléfono", email: "mail", web: "web", direccion: "dirección", pais: "país", ciudad: "ciudad", estado: "estado", niveles: "niveles" };
const PLACEHOLDER = /^(no encontrad[oa]s?|sin datos|no tiene|n\/?a|-+|\.+)$/i;
const blank = v => v == null || (typeof v === "object" ? !Object.keys(v).length : !String(v).trim() || PLACEHOLDER.test(String(v).trim()));
// lead: el prospecto como lo devuelve lib/pipedrive.js (phone, email, web, addr, paisOpt…); want: { clave de DEAL_FIELDS: valor }
export function leadGaps(lead, want) {
  const out = {};
  for (const [name, prop] of Object.entries(F_LEAD)) {
    const k = DEAL_FIELDS[name], v = want?.[k], cur = lead?.[prop];
    if (!k) continue;
    // teléfono o mail con aclaraciones pegadas (lo que dejó una versión anterior: «0341 421-4278 (San Juan 1650; atención…)»):
    // queda solo el número o el mail que ya estaba
    if ((name === "telefono" || name === "email") && !blank(cur)) {
      const clean = name === "telefono" ? cleanPhoneVal(cur) : cleanMailVal(cur);
      if (clean && String(cur).trim().length > clean.length + 8 && /[(;]|según|segun|estudio|horario|atenci/i.test(String(cur))) out[k] = clean;
      continue;
    }
    if (blank(v) || !blank(cur)) continue;
    out[k] = v;
  }
  return out;
}
const fieldNames = keys => keys.map(k => LEAD_FIELD_LABEL[Object.keys(F_LEAD).find(n => DEAL_FIELDS[n] === k)] || k);
// Lo que se quiere en el prospecto: lo de la base (como al crearlo, sin fuente ni SDR) y, si la base no lo tiene, lo
// primero que encontró Enriquecer con su fuente (web, Google Maps, estudio).
async function leadWants(s, data, user) {
  const pick = k => (data?.items || []).filter(x => x.kind === k && x.src !== "Prospecto en Pipedrive").map(x => x.value);
  const f = await leadFields(s, user, { phones: pick("tel"), emails: pick("mail"), addr: pick("addr")[0] || "" });
  delete f[DEAL_FIELDS.fuente]; delete f[DEAL_FIELDS.sdr];
  if (!f[DEAL_FIELDS.web] && (data?.web || pick("web")[0])) f[DEAL_FIELDS.web] = data.web || pick("web")[0];
  return f;
}
// Completa los campos vacíos del prospecto (solo si es tuyo o de la cuenta general; se lee al día antes de escribir).
// { saved: [nombres], url, reason }
async function fillLeadGaps(leadId, s, data, user) {
  const url = `${pd.PD_WEB}/leads/inbox/${leadId}`;
  let lead;
  try { lead = await pd.getLead(leadId); } catch (e) { return { saved: [], url, reason: `No pude leer el prospecto en Pipedrive para completarlo (${e.message}).` }; }
  if (!lead) return { saved: [], url, reason: "El prospecto ya no está en Pipedrive." };
  if (lead.ownerId && lead.ownerId !== user.pdUserId) return { saved: [], url, reason: "No completé el prospecto: es de otra persona." };
  const patch = leadGaps(lead, await leadWants(s, data, user));
  if (!Object.keys(patch).length) return { saved: [], url };
  const r = await pd.fillLead(leadId, patch).catch(e => ({ saved: [], failed: Object.keys(patch), error: e.message }));
  return { saved: fieldNames(r.saved), url, ...(r.failed?.length ? { reason: `No pude completar ${joinY(fieldNames(r.failed))} en el prospecto (${r.error || "Pipedrive no lo aceptó"}).` } : {}) };
}
