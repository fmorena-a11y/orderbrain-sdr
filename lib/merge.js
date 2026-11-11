// Fusionar organizaciones duplicadas de Pipedrive desde la ficha de un colegio: reglas puras (test/merge.test.mjs).
// La escritura está en lib/sales.js (dupesFor, mergeOrgs) y lib/pipedrive.js (mergeOrganization).
//
// Cuándo otra organización es el MISMO colegio que la elegida con «Es esta» (dupeOrgs):
//  - mismo nombre propio que el colegio con las reglas del cruce: pd.rate ≥ SURE (todas sus palabras propias, sin otro
//    lugar de la base, sin otro número, sin palabras propias de más), un nombre que no sea solo de palabras comunes
//    («Colegio San José» no alcanza) y ninguna palabra de otra sede o nivel (plantel, campus, norte, primaria…);
//  - y la misma ciudad (en el nombre o en la dirección de Pipedrive), o ninguna ciudad en ningún lado. Esas últimas se
//    ofrecen sin marcar, diciendo cuántos colegios de la base se llaman igual en otras ciudades (puede ser de uno de ellos).
// Nunca: otra ciudad u otro país en la dirección, otro lugar en el nombre («Colegio Valladolid Pachuca» para el de
// Guadalajara) ni una organización vinculada a otro colegio de la base (es otra sede o es otro colegio).
// Y nada si el colegio no tiene ciudad (no se puede decir «la misma ciudad») o si la que queda ya está vinculada a otro
// colegio de la base (mergeStop): juntar ahí mezclaría dos sedes, y en Pipedrive no se deshace.
import { tokens, rate, cityParts, cityIn, eligible, norm, realOwner, LOW, SURE } from "./pipedrive.js";
import { CLIENT_PIPES, MARKETS } from "./config.js";
import { canLead } from "./teams.js";

// Palabras que dicen que es otra sede, otra parte de la ciudad u otro nivel del colegio
export const SEDE_WORDS = new Set(("plantel planteles campus sede sedes unidad anexo filial sucursal seccion norte sur oriente poniente " +
  "centro primaria secundaria preparatoria prepa bachillerato preescolar kinder kindergarten maternal guarderia jardin inicial universidad").split(" "));
const isNum = w => /^\d+$/.test(w);

// ¿La organización se llama como el colegio? k: pd.schoolKey(colegio). null si no; si sí, { city }: nombra su ciudad.
export function sameName(k, name, places) {
  const b = new Set(tokens(name));
  if (!k?.strong || !eligible(k.a, b)) return null;
  const r = rate(k, b, places);
  if (r.score < SURE) return null;
  // de más solo puede tener palabras comunes que no digan sede ni nivel («Internacional» sí, «Norte» o «Primaria» no)
  for (const w of b) if (!k.own.has(w) && !k.place.has(w) && (isNum(w) || SEDE_WORDS.has(w) || !LOW.has(w))) return null;
  return { city: !!r.city };
}

// País como lo usa la app («Mexico», «MX» y «México» son el mismo)
const countryKey = c => { const n = norm(c); if (!n) return ""; const hit = Object.entries(MARKETS).find(([key, m]) => norm(key) === n || String(m.code || "").toLowerCase() === n); return hit ? hit[0] : n; };
// Lo que dice la dirección de Pipedrive (o: { city, region, country }): "same" (su ciudad es la del colegio), "other"
// (otra ciudad u otro país) o null (no dice ciudad ni país distinto).
export function addrPlace(school, o) {
  if (o?.country && school.country && countryKey(o.country) !== countryKey(school.country)) return "other";
  if (!o?.city) return null;
  const parts = cityParts(school.city);
  if (!parts.length) return null;
  return cityIn(parts, new Set(tokens(o.city))) ? "same" : "other";
}

// Colegios de la base en OTRAS ciudades que podrían ser los de una organización sin ciudad, agrupados por nombre:
// primero los que tienen todas las palabras del nombre de la organización («Instituto Valladolid Primaria» de Morelia para
// «INSTITUTO VALLADOLID»), después los que se llaman igual con las reglas del cruce (puntaje ≥ SURE).
// Devuelve [{ name, cities: [...] }] y n: cuántos colegios en total.
const rawWords = name => norm(name).split(" ").filter(w => w.length >= 4);
export function elsewhereOf({ k, ctx, org }) {
  const groups = new Map(), seen = new Set();
  const add = s => {
    if (!s || seen.has(s) || norm(s.city) === k.city) return;
    seen.add(s);
    const key = norm(s.name); let g = groups.get(key);
    if (!g) groups.set(key, g = { name: s.name, cities: [] });
    if (s.city && !g.cities.includes(s.city)) g.cities.push(s.city);
  };
  // pivot: una palabra propia del colegio que está en el nombre de la organización (filtra rápido la base)
  const words = rawWords(org.name), pivot = words.find(w => k.own.has(w));
  const sure = new Set(ctx.claimsOf(org.id, org.name).filter(x => x.k !== k && x.score >= SURE).map(x => x.k));
  const first = [], then = [];
  for (const s of ctx.base) {
    const sk = ctx.key(s); if (sk === k) continue;
    if (pivot && sk.own.has(pivot)) { const n = ` ${sk.nm} `; if (words.every(w => n.includes(` ${w} `))) { first.push(s); continue; } }
    if (sure.has(sk)) then.push(s);
  }
  [...first, ...then].forEach(add);
  return { n: seen.size, at: [...groups.values()] };
}

// Lo que impide fusionar a cualquiera (también a un líder), antes de mirar las duplicadas: null si nada.
// school: el colegio de la ficha. linkedTo: colegios de la base ([{ name, city }]) vinculados a la que queda.
export const linkedText = l => {
  const x = l.slice(0, 2).map(s => `«${s.name}»${s.city ? ` de ${s.city}` : ""}`);
  return l.length > 2 ? `${x.join(", ")} y ${l.length - 2} más` : x.join(" y ");
};
export function mergeStop({ school, linkedTo = [] }) {
  if (school?.virtual) return "Es una ficha de Pipedrive, no de la base: fusioná desde la ficha del colegio";
  if (!cityParts(school?.city).length) return "El colegio no tiene ciudad en la base: no ofrezco fusionar, podría juntar sedes de otras ciudades";
  if (linkedTo.length) return `Esa organización ya está vinculada a ${linkedText(linkedTo)}: revisalo antes de fusionar`;
  return null;
}

// Avisos de «¿Estás seguro?» antes de vincular (level "err": casi seguro que no es esta; "warn": revisalo).
// org: la organización elegida ({ city, country } de su dirección en Pipedrive). linkedTo: colegios de la base ya
// vinculados a ella ([{ name, city }]). open: otras organizaciones del mismo colegio y la misma ciudad con un trato abierto
// ([{ id, name, ownerId, owner }]). me: tu usuario de Pipedrive.
export function previewWarnings({ school, org, linkedTo = [], open = [], me = null }) {
  const out = [];
  if (linkedTo.length) out.push({ level: "err", text: `Ya está vinculada a ${linkedText(linkedTo)}` });
  if (addrPlace(school, org) === "other") {
    const otherCountry = org.country && school.country && countryKey(org.country) !== countryKey(school.country);
    out.push({ level: "err", text: otherCountry ? `Esta organización es de ${org.country}, no de ${school.country}` : `Esta organización es de ${org.city}, no de ${school.city}` });
  }
  for (const o of open) {
    const where = `otra «${o.name}» de ${school.city} (id ${o.id})`;
    out.push({ level: "warn", text: me && Number(o.ownerId) === Number(me) ? `Tenés un trato abierto en ${where}: elegí esa`
      : `${o.owner || "Otra persona"} tiene un trato abierto en ${where}. Hablalo antes o elegí esa` });
  }
  return out;
}

// Las otras organizaciones que son el mismo colegio (ver arriba). keep y orgs: { id, name, city, region, country } (la
// dirección de Pipedrive, pd.orgsByIds). ctx: pd.matchCtx(base). linked: orgId → ids de OTROS colegios de la base
// vinculados a esa organización. Devuelve { dupes: [{ id, name, sameCity, cityFrom, elsewhere, elsewhereAt }], skipped: [{ id, why }] }:
// las de la misma ciudad primero. Ninguna si la elegida no se llama como el colegio, su dirección es de otra ciudad, el
// colegio no tiene ciudad o la elegida está vinculada a otro colegio de la base.
export function dupeOrgs({ school, k, ctx, keep, orgs = [], linked = new Map() }) {
  const dupes = [], skipped = [];
  const keepWhy = !k?.strong ? "common" : !cityParts(school.city).length ? "nocity" : !keep || !sameName(k, keep.name, ctx.places) || addrPlace(school, keep) === "other" ? "keep"
    : (linked.get(keep.id) || []).length ? "keepLinked" : null;
  for (const o of orgs) {
    if (!o || o.id === keep?.id) continue;
    if (keepWhy) { skipped.push({ id: o.id, why: keepWhy }); continue; }
    const n = sameName(k, o.name, ctx.places);
    if (!n) { skipped.push({ id: o.id, why: "name" }); continue; }
    const at = addrPlace(school, o);
    if (at === "other") { skipped.push({ id: o.id, why: "place" }); continue; }
    if ((linked.get(o.id) || []).length) { skipped.push({ id: o.id, why: "linked" }); continue; }
    const sameCity = n.city || at === "same";
    // sin ciudad: qué colegios de la base en otras ciudades podrían ser los de esa organización
    const ew = sameCity ? { n: 0, at: [] } : elsewhereOf({ k, ctx, org: o });
    dupes.push({ id: o.id, name: o.name, sameCity, cityFrom: at === "same" ? "addr" : n.city ? "name" : null, elsewhere: ew.n, elsewhereAt: ew.at });
  }
  dupes.sort((a, b) => b.sameCity - a.sameCity || a.elsewhere - b.elsewhere || a.id - b.id);
  return { dupes, skipped };
}

// Cliente: un trato ganado o un trato en un embudo de clientes (ONBOARDING, MX - Clientes, PERFORMANCE), aunque sea de baja.
export const clientDeal = d => d.status === "won" || CLIENT_PIPES.includes(Number(d.pipeline_id));
export const isClient = deals => deals.some(clientDeal);

// Qué impide fusionar una organización (o juntar en ella): null si se puede; si no, el motivo para mostrar.
// Cada uno fusiona lo suyo o lo libre (las cuentas generales cuentan como libres: pd.realOwner): la organización, sus
// tratos abiertos, sus prospectos abiertos y sus actividades sin hacer tienen que ser tuyos o libres. Un líder puede todo.
// Un cliente (isClient) solo lo fusiona un líder: puede ser otra sede de la misma red con el mismo nombre (dos clientes
// distintos) y sus tratos son del equipo de cuentas; fusionarlo mal mezcla dos cuentas y en Pipedrive no se deshace.
// Un líder de equipo, solo si todos sus tratos de cliente (ganados o de embudos de clientes) son de su gente o suyos (uno de
// otro equipo, de una cuenta general o sin dueño: lo fusiona dirección).
// leadsUnknown / actsUnknown: no se pudieron leer sus prospectos o actividades (sin eso no se sabe si hay algo de otra persona).
// leader: true (puede todo), false o { ids, emails } (líder de equipo: lo de la gente de sus equipos cuenta como suyo).
export function mergeBlock({ org, deals = [], leads = [], leadsUnknown = false, acts = [], actsUnknown = false, me = null, leader = false, nameOf = () => "" }) {
  if (leader === true) return null;
  const free = id => !id || (!!me && Number(id) === Number(me)) || canLead(leader, { id });
  const who = id => nameOf(id) || "otra persona";
  if (isClient(deals) && !leader) return "Es cliente de OrderEAT: la fusiona un líder";
  if (isClient(deals)) {
    const c = deals.filter(clientDeal).find(d => { const o = d.owner_id ?? d.user_id ?? null; return !(o && ((!!me && Number(o) === Number(me)) || canLead(leader, { id: o }))); });
    if (c) { const o = realOwner(c.owner_id ?? c.user_id); return `Es cliente de OrderEAT${o ? ` con tratos de ${who(o)}` : ""}: la fusiona dirección`; }
  }
  if (!free(org?.ownerId)) return `Es de ${who(org.ownerId)}`;
  const d = deals.find(x => x.status === "open" && !free(realOwner(x.owner_id ?? x.user_id)));
  if (d) return `Tiene un trato de ${who(realOwner(d.owner_id ?? d.user_id))}`;
  if (leadsUnknown) return "No pude ver sus prospectos";
  const l = leads.find(x => !x.archived && !free(x.ownerId));
  if (l) return `Tiene un prospecto de ${who(l.ownerId)}`;
  if (actsUnknown) return "No pude ver sus actividades";
  const a = acts.find(x => !x.done && !free(realOwner(x.owner_id ?? x.user_id)));
  if (a) return `Tiene una actividad de ${who(realOwner(a.owner_id ?? a.user_id))}`;
  return null;
}

// Qué pide el servidor para fusionar. Antes de buscar (mergeRequestError): algo elegido, no la misma, y la que queda es la
// organización vinculada a mano al colegio (rec: su cruce). Después (mergeError): nada lo impide para todos (stop:
// mergeStop), cada una es duplicada (dupesFor) y se puede (mergeBlock), y se puede juntar en la que queda (keepBlock). Devuelven null o { msg, status }.
const bad = (msg, status = 400) => ({ msg, status });
export function mergeRequestError({ rec, keepId, mergeIds }) {
  if (!mergeIds.length) return bad("Elegí qué organizaciones fusionar.");
  if (mergeIds.length > 6) return bad("Son demasiadas juntas: de a 6 como mucho.");
  if (mergeIds.includes(keepId)) return bad("No se puede fusionar una organización consigo misma.");
  if (!rec?.orgId || Number(rec.orgId) !== keepId || !rec.confirmed || rec.auto) return bad("La que queda tiene que ser la organización vinculada al colegio. Volvé a abrir la ficha.", 409);
  return null;
}
export function mergeError({ rec, keepId, mergeIds, dupes = [], keepBlock = null, stop = null }) {
  const pre = mergeRequestError({ rec, keepId, mergeIds }); if (pre) return pre;
  if (stop) return bad(`${stop}.`, 409);
  if (keepBlock) return bad(`La que queda: ${keepBlock}.`, 403);
  for (const id of mergeIds) {
    const x = dupes.find(o => o.id === id);
    if (!x) return bad(`La organización ${id} no parece el mismo colegio: no la fusiono.`);
    if (x.block) return bad(`${x.name}: ${x.block}.`, 403);
  }
  return null;
}
