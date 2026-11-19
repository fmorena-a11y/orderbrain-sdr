// Fichas que no son colegios de la base: un prospecto o una organización de Pipedrive, o una institución de una base cargada.
import * as pd from "../pipedrive.js";
import { addVirtual, byId, getMatch, isFresh, setMatch } from "../store.js";
import { DEAL_FIELDS, MARKETS, OPTIONS } from "../config.js";
import { bad } from "../text.js";
import { orgSchoolMap } from "./search.js";
import { checkSchool } from "./match.js";
import { schoolListItem } from "./list.js";

// ---------- fichas de la agenda que no son colegios de la base: un prospecto (lead) o una organización de Pipedrive
// Se arman a pedido para poder trabajarlos desde la app (contexto, registrar, próximo paso) sin abrir Pipedrive.
// País como lo usa la app (México, Perú…) a partir de lo que guarda Pipedrive («Mexico», «Perú», código…)
export const appCountry = raw => { const n = pd.norm(raw); if (!n) return ""; return Object.keys(MARKETS).find(k => pd.norm(k) === n || MARKETS[k].code.toLowerCase() === n) || ""; };
export const countryFromOpt = id => Object.entries(OPTIONS.pais).find(([, v]) => String(v) === String(id))?.[0] || "";
// País por el prefijo de un teléfono internacional (+52…, 0052…). Si el prefijo es de más de un país (+1), no se adivina.
export const phoneCountry = (...phones) => {
  for (const x of phones) {
    const t = String(x || "").trim(); if (!/^(\+|00)/.test(t)) continue;
    const d = t.replace(/\D/g, "").replace(/^00/, "");
    const hits = Object.entries(MARKETS).filter(([, m]) => m.prefix && d.startsWith(m.prefix)), n = Math.max(0, ...hits.map(([, m]) => m.prefix.length));
    const best = hits.filter(([, m]) => m.prefix.length === n); if (best.length === 1) return best[0][0];
  }
  return "";
};
export const paisWarn = c => `País ${c}: no existe en el campo País de Pipedrive, quedó sin completar.`;
export const personLabel = (name, role) => [String(name || "").trim(), String(role || "").trim() && `(${String(role).trim()})`].filter(Boolean).join(" ");
// Otras fichas que no son colegios de la base ni de Pipedrive (bx: una institución de una base cargada, lib/bases.js).
// Cada fuente devuelve el colegio (ya en byId) o null. leadEvent: el evento de la base para el título del prospecto nuevo.
export const recordSources = {}, hooks = { leadEvent: async () => "" };
export async function openRecord(kind, rid, extra = {}) {
  if (recordSources[kind]) { const s = await recordSources[kind](String(rid)); if (!s) throw bad("No encontré esa institución: la base pudo vencer o borrarse.", 404); return schoolListItem(s); }
  if (kind === "org") {
    // cruzada con un colegio de la base: la ficha es la del colegio (no una copia pd-org-*: lo que se registre ahí tiene que
    // quedar en el colegio, para su cadencia, la meta, el ranking y su estado)
    const sid = orgSchoolMap().get(Number(rid));
    if (sid) return schoolListItem(byId.get(sid));
    const o = (await pd.orgsByIds([Number(rid)]))[0];
    if (!o) throw bad("No encontré esa organización en Pipedrive", 404);
    const s = addVirtual({ id: `pd-org-${o.id}`, name: o.name, city: o.city || extra.city || "", country: appCountry(o.country) || extra.country || "", src: "pipedrive", virtual: true, pdOrgId: o.id });
    // el prospecto de esta organización (si la ficha se abrió desde uno) queda guardado en el cruce, no solo en memoria
    if (extra.leadId) { s.leadId = extra.leadId; const mm = getMatch(s.id); if (mm && !mm.leadId) setMatch(s.id, { ...mm, leadId: extra.leadId }); }
    if (!isFresh(getMatch(s.id))) await checkSchool(s.id, { org: { id: o.id, name: o.name, ownerId: o.ownerId } });
    return schoolListItem(s);
  }
  if (kind === "lead") {
    const l = (await pd.leadsByIds([String(rid)]))[0];
    if (!l) throw bad("No encontré ese prospecto en Pipedrive", 404);
    await pd.loadFieldOptions().catch(() => {});
    const country = countryFromOpt(l.paisOpt), city = l.ciudadOpt ? pd.optionLabel(DEAL_FIELDS.ciudad, l.ciudadOpt) || "" : "";
    if (l.orgId) { const r = await openRecord("org", l.orgId, { leadId: l.id, country, city }); return String(r.id).startsWith("pd-") ? { ...r, leadId: l.id } : r; }
    const person = l.personId ? await pd.getPerson(l.personId).catch(() => null) : null;
    // si el prospecto ya pasó a trato (otra instancia lo convirtió), se sigue con su organización
    const conv = getMatch(`pd-lead-${l.id}`);
    // sin persona (o sin su teléfono), el del prospecto (campo personalizado Teléfono)
    const s = addVirtual({ id: `pd-lead-${l.id}`, name: l.title || person?.name || "Prospecto", city, country, phone: person?.phone || l.phone || "", email: person?.email || l.email || "",
      src: "pipedrive", virtual: true, leadOnly: true, leadId: l.id, personId: l.personId || null, personName: person?.name || "" });
    if (conv?.orgId) { s.leadOnly = false; s.pdOrgId = conv.orgId; }
    else setMatch(s.id, { status: "lead", detail: "Prospecto en Pipedrive", orgId: null, orgName: null, confirmed: true, leadId: l.id, candidates: [] });
    return schoolListItem(s);
  }
  throw bad("Ficha inválida");
}
// id de ficha virtual → la rearma si esta instancia no la tiene
export async function ensureRecord(id) {
  if (byId.has(id)) return true;
  const b = /^(bx)-(.+)$/.exec(id); if (b && recordSources[b[1]]) return !!(await recordSources[b[1]](b[2]).catch(() => null)) && byId.has(id);
  const m = /^pd-(org|lead)-(.+)$/.exec(id); if (!m) return false;
  const r = await openRecord(m[1], m[2]);
  // un prospecto que ya pasó a organización: la misma id sigue abriendo la ficha (ahora de la organización)
  if (!byId.has(id) && r?.id && byId.has(r.id)) byId.set(id, byId.get(r.id));
  return byId.has(id);
}
