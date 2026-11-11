// Búsqueda en toda la base de Pipedrive (Prospectar y la búsqueda rápida): reglas puras, sin pedidos.
// searchPlan: qué términos se le piden a Pipedrive (un teléfono va sin separadores ni código de país, y si no aparece
// nada se prueba con los últimos 10 y 7 dígitos). groupResults: los resultados de /v2/itemSearch y /v2/persons/search
// agrupados por tipo, con lo justo para mostrarlos (nada de campos que no sirven), si hay más en Pipedrive (cursor) y a qué
// ficha de la app lleva cada uno (targetOf). Las pruebas están en test/pdsearch.test.mjs.
import { MARKETS } from "./config.js";

export const MIN_Q = 3, MAX_Q = 100;
// los tipos que se buscan (uno por pedido: cada grupo trae lo suyo y su cursor, ninguno tapa a otro)
export const TYPES = ["person", "organization", "lead", "deal"];
// códigos de país de los mercados, los más largos primero (598 antes que 59…)
const PREFIXES = [...new Set(Object.values(MARKETS).map(m => m.prefix).filter(Boolean))].sort((a, b) => b.length - a.length);
export const phoneDigits = s => String(s ?? "").replace(/\D/g, "");
// ¿es un teléfono? Solo dígitos y separadores (espacios, guiones, puntos, paréntesis, barra, + adelante) y al menos 6 dígitos.
export const isPhoneQuery = q => /^\+?[\d\s\-().\/]+$/.test(String(q ?? "").trim()) && phoneDigits(q).length >= 6;
// Sin código de país: «+52 222 429 2676», «0052 222…» o «52 222 429 2676» (más de 10 dígitos) → «2224292676».
// Solo si después quedan al menos 7 dígitos.
export function nationalDigits(q) {
  const raw = String(q ?? "").trim();
  let d = phoneDigits(raw);
  const intl = /^(\+|00)/.test(raw);
  if (/^00/.test(raw)) d = d.slice(2);
  if (intl || d.length > 10) { const p = PREFIXES.find(x => d.startsWith(x) && d.length - x.length >= 7); if (p) d = d.slice(p.length); }
  return d;
}
// En los campos de texto (el Teléfono de un prospecto, por ejemplo «222 285 0575») Pipedrive busca por palabras: ahí
// «2222850575» no encuentra nada y «222 285 0575» sí. Por eso el número también se busca escrito con espacios, en los
// formatos más comunes según la cantidad de dígitos, y como lo escribió la persona (sin el código de país). Hasta 3.
const SPLITS = { 10: [[3, 3, 4], [2, 4, 4]], 9: [[3, 3, 3], [1, 4, 4]], 8: [[4, 4]], 7: [[3, 4]] };
export function spacedVariants(d, raw = "") {
  const out = (SPLITS[d.length] || []).map(g => { let i = 0; return g.map(n => d.slice(i, i += n)).join(" "); });
  const typed = String(raw).trim().replace(/^(\+|00)\d{1,3}[\s\-.]+/, "").replace(/\D+/g, " ").trim();
  if (/\s/.test(typed) && phoneDigits(typed) === d) out.unshift(typed);
  return [...new Set(out)].slice(0, 3);
}
// Qué buscar. null: muy corto (menos de 3 letras o números).
// kind phone: terms son los dígitos y, de respaldo si no aparece nada, los últimos 10 y 7; spaced, el número con espacios
// (para los campos de texto). email o text: tal cual.
export function searchPlan(q) {
  let t = String(q ?? "").replace(/\s+/g, " ").trim();
  if (t.length < MIN_Q) return null;
  t = t.slice(0, MAX_Q).trim();
  if (isPhoneQuery(t)) {
    const d = nationalDigits(t), terms = [d];
    if (d.length > 10) terms.push(d.slice(-10));
    if (d.length > 7) terms.push(d.slice(-7));
    return { kind: "phone", terms: [...new Set(terms)], digits: d, spaced: spacedVariants(d, t) };
  }
  return { kind: t.includes("@") ? "email" : "text", terms: [t] };
}
// clave de la copia de 60 s: el mismo pedido escrito de otra forma («222 429 2676», «2224292676») usa la misma
export const planKey = p => p ? `${p.kind}:${p.terms[0].toLowerCase()}` : "";

// ---------- a qué ficha de la app lleva cada resultado
// organización: el colegio de la base si está cruzada, si no la ficha de Pipedrive (org:id). prospecto: igual, el colegio
// de la base si su organización está cruzada (lo que se registre queda en el colegio, no en una copia); si no, su ficha
// (lead:id). persona: siempre su ficha (teléfonos, emails, tratos, actividades, notas y el botón a la de su organización).
// trato: la ficha de su organización (o de su persona). o2s: organización → colegio de la base (orgToSchool de lib/store.js).
const schoolOf = (o2s, id) => o2s?.get(Number(id)) ?? o2s?.get(String(id)) ?? null;
// (orgId también en el colegio: si el navegador todavía no tiene ese colegio, abre la ficha de Pipedrive)
export function orgTarget(id, o2s) { const sid = schoolOf(o2s, id); return sid ? { kind: "school", id: sid, orgId: Number(id) } : { kind: "record", ref: `org:${Number(id)}` }; }
// prospecto: orgId su organización (o null)
export function leadTarget(id, orgId, o2s) { const sid = orgId ? schoolOf(o2s, orgId) : null; return sid ? { kind: "school", id: sid, orgId: Number(orgId), leadId: String(id) } : { kind: "record", ref: `lead:${id}` }; }
export function targetOf(type, it, o2s = new Map()) {
  if (!it?.id) return null;
  if (type === "organization") return orgTarget(it.id, o2s);
  if (type === "lead") return leadTarget(it.id, it.organization?.id, o2s);
  if (type === "person") return { kind: "person", id: Number(it.id) };
  if (type === "deal") return it.organization?.id ? orgTarget(it.organization.id, o2s) : it.person?.id ? { kind: "person", id: Number(it.person.id) } : null;
  return null;
}

// ---------- armado
const clean = s => String(s ?? "").replace(/<br\s*\/?>/gi, " ").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
// textos de una lista (o un valor suelto): strings u objetos { value } como los manda v2
const texts = a => (Array.isArray(a) ? a : a == null ? [] : [a]).map(x => clean(x && typeof x === "object" ? x.value ?? x.formatted_address ?? "" : x)).filter(Boolean);
const fold = s => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const ref = x => x?.id ? { id: x.id, name: clean(x.name) } : null;
const cut = (s, n) => s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
const excerpt = (s, at, len) => { const a = Math.max(0, at - 40), b = Math.min(s.length, at + len + 60); return (a ? "…" : "") + s.slice(a, b).trim() + (b < s.length ? "…" : ""); };
// Dónde coincide, si no se ve en lo que ya se muestra (nombre, teléfonos, emails…): el pedacito de la nota o del campo
// personalizado (por ejemplo, el teléfono que el prospecto tiene en su campo Teléfono). "" si se ve o no se encuentra.
export function hintFor(it, shown, plan, term) {
  if (!plan || !term) return "";
  const pool = [...texts(it.custom_fields), ...texts(typeof it.address === "string" ? it.address : it.address?.value), ...texts(it.notes)];
  if (plan.kind === "phone") {
    const d = phoneDigits(term); if (!d) return "";
    if (shown.some(s => phoneDigits(s).includes(d))) return "";
    const re = new RegExp(d.split("").join("[^\\d]{0,3}"));
    for (const s of pool) { const m = re.exec(s); if (m) return excerpt(s, m.index, m[0].length); }
    return "";
  }
  const t = fold(term);
  if (shown.some(s => fold(s).includes(t))) return "";
  for (const s of pool) { const i = fold(s).indexOf(t); if (i >= 0) return excerpt(s, i, t.length); }
  return "";
}
export const DEAL_STATUS = { open: "Abierto", won: "Ganado", lost: "Perdido", deleted: "Borrado" };
const LABEL = { person: "Personas", organization: "Organizaciones", lead: "Prospectos", deal: "Tratos" };
const PATH = { person: "person", organization: "organization", lead: "leads/inbox", deal: "deal" };
// ctx: { users: Map id → nombre, free: Set de cuentas generales, pipes: { id: nombre }, o2s, web: https://x.pipedrive.com, plan, term }
const ownerName = (o, ctx) => { const id = Number(o?.id ?? o); if (!id) return ""; if (ctx.free?.has(id)) return "Cuenta general"; return ctx.users?.get(id) || ""; };
export function itemOut(type, it, ctx = {}) {
  const base = { type, id: it.id, owner: ownerName(it.owner ?? it.owner_id, ctx), url: `${ctx.web || ""}/${PATH[type]}/${encodeURIComponent(it.id)}`, to: targetOf(type, it, ctx.o2s) };
  let out, shown;
  if (type === "person") {
    out = { ...base, name: clean(it.name) || "Sin nombre", phones: texts(it.phones).slice(0, 4), emails: texts(it.emails).slice(0, 4), org: ref(it.organization) };
    shown = [out.name, ...out.phones, ...out.emails, out.org?.name || ""];
  } else if (type === "organization") {
    // dirección: como está en Pipedrive, salvo que sea solo un teléfono (pasa: «+52 246 466 3966»); place: ciudad y país
    // (del colegio cruzado o de la organización), porque casi ninguna trae dirección y hay muchas con el mismo nombre
    const addr = texts(typeof it.address === "string" ? it.address : it.address?.value)[0] || "";
    out = { ...base, name: clean(it.name) || "Sin nombre", addr: isPhoneQuery(addr) ? "" : cut(addr, 140), place: ctx.places?.get(Number(it.id)) || "" };
    shown = [out.name, out.addr, out.place];
  } else if (type === "lead") {
    out = { ...base, title: clean(it.title) || "Prospecto", org: ref(it.organization), person: ref(it.person), archived: !!it.is_archived, phones: texts(it.phones).slice(0, 3), emails: texts(it.emails).slice(0, 3) };
    shown = [out.title, out.org?.name || "", out.person?.name || "", ...out.phones, ...out.emails];
  } else if (type === "deal") {
    out = { ...base, title: clean(it.title) || "Trato", status: DEAL_STATUS[it.status] || "", pipeline: ctx.pipes?.[it.pipeline?.id ?? it.pipeline_id] || "", stage: clean(it.stage?.name), org: ref(it.organization), person: ref(it.person) };
    shown = [out.title, out.org?.name || "", out.person?.name || ""];
  } else return null;
  const hint = hintFor(it, shown, ctx.plan, ctx.term);
  return hint ? { ...out, hint: cut(hint, 160) } : out;
}
// raw: [{ result_score, item: { type, id, … } }] de una o varias búsquedas. Sin repetidos (queda la de más puntaje),
// agrupados por tipo y los grupos ordenados por su mejor resultado. Van todos los que trajo Pipedrive (la pantalla muestra
// unos pocos y el resto con «Ver más»). next: { tipo: cursor } de las búsquedas por tipo (hay más en Pipedrive: se piden
// con ese cursor); capped: una búsqueda mezclada llegó a su tope (puede haber más de cualquier tipo). more: puede haber más.
export function groupResults(raw, ctx = {}, { next = {}, capped = false } = {}) {
  const seen = new Set(), groups = new Map();
  const list = (raw || []).filter(r => r?.item?.id && LABEL[r.item.type]).map((r, i) => ({ r, i })).sort((a, b) => (b.r.result_score || 0) - (a.r.result_score || 0) || a.i - b.i);
  for (const { r } of list) {
    const k = `${r.item.type}:${r.item.id}`; if (seen.has(k)) continue; seen.add(k);
    const out = itemOut(r.item.type, r.item, ctx); if (!out) continue;
    if (!groups.has(r.item.type)) groups.set(r.item.type, { type: r.item.type, label: LABEL[r.item.type], top: r.result_score || 0, items: [] });
    groups.get(r.item.type).items.push(out);
  }
  const out = [...groups.values()].map(g => ({ ...g, next: next[g.type] || null, more: !!(next[g.type] || capped) }));
  out.sort((a, b) => b.top - a.top);
  return { groups: out.map(({ top, ...g }) => g), total: out.reduce((n, g) => n + g.items.length, 0), more: out.some(g => g.more) };
}
// Cursor de Pipedrive que vuelve del navegador para «Ver más»: texto opaco corto (base64 o parecido). null si no sirve.
export const cleanCursor = c => typeof c === "string" && c.length <= 600 && /^[\w\-+=\/.:]+$/.test(c) ? c : null;
