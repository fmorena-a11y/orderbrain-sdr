// Investigación antes de crear: ¿el colegio ya está en Pipedrive como prospecto, trato u organización? Reglas puras (sin
// pedidos), probadas en test/existing.test.mjs con casos reales de la cuenta (test/fixtures/existing-real.json).
// Los pedidos y lo que se hace con el resultado están en lib/sales.js (investigate, settleExisting, useExisting).
//
// Por qué: en la cuenta muchos prospectos NO tienen organización (los importados de la SEP: «montessori angeles», en
// minúscula, sin «Colegio», con la dirección «…, Colonia …, municipio, estado, C.P. …» en el campo Dirección) y el cruce
// solo miraba organizaciones: el colegio quedaba «Nunca contactado» y la app creaba organización y prospecto nuevos.
//
// Cómo se decide (judge):
//  - nombre (nameLevel), con las reglas del cruce (pd.rate, palabras propias, lugares de la base) y letras dobles juntas
//    («Serradel» = «serradell»): «same» = todas las palabras propias y nada de más salvo palabras comunes que no digan sede ni
//    nivel; «contains» = todas las propias y algo de más («preparatoria la salle del pedregal» para «La Salle del Pedregal»);
//    «close» = la mayoría (pd.rate ≥ PICK);
//  - lugar (placeLevel): la dirección del prospecto o trato («…, atlixco, puebla, C.P. 0»: municipio y estado), su ciudad, el
//    título («… cdmx») o la dirección de la organización: «same» (el municipio es la ciudad del colegio), «near» (otro
//    municipio del mismo estado: el estado se llama como la ciudad, «Atlixco, Puebla» para Puebla), «other» (otra ciudad u
//    otro país), null (no dice);
//  - contacto (contactHit): el mismo teléfono (los últimos 10 dígitos, o 7 u 8 si uno es local), el mismo mail o el mismo
//    dominio de la web (o del mail) que el colegio. Solo eso ya alcanza.
// sure: contacto (salvo otra ciudad), o mismo nombre y misma ciudad. maybe: contacto de otra ciudad, mismo nombre sin ciudad
// o en otro municipio del estado, o nombre parecido en la misma ciudad. Lo demás no cuenta. Un prospecto archivado nunca es
// «sure»: va como dato (info).
import { norm, tokens, schoolKey, rate, cityParts, cityIn, eligible, realOwner, LOW, SURE, PICK } from "./pipedrive.js";
import { SEDE_WORDS } from "./merge.js";
import { nationalDigits, spacedVariants } from "./pdsearch.js";
import { MARKETS } from "./config.js";

// ---------- texto
// letras dobles juntas: «serradell» = «serradel», «pestalozzi» = «pestalozi» (los números no se tocan)
export const fold = s => norm(s).replace(/([a-z])\1+/g, "$1");
// lo que no es nombre: «(EduExperience Puebla 2026)», « · OE-MX-000322», «S.C.», «A.C.»
export const cleanTitle = t => String(t || "").replace(/\s*\([^()]*\b20\d\d\b[^()]*\)\s*/g, " ").replace(/\s*[·|]\s*[A-Z]{2,3}-[A-Z]{2}-\d+\s*$/i, "")
  .replace(/\b([as])\.\s?([cs])\.?(?=\s|$)/gi, " ").replace(/\s+/g, " ").trim();
const NOISE = new Set(["ac", "sc", "sa", "cv", "rl", "srl", "sas", "ltda", "eirl", "iap", "abp"]);
const isNum = w => /^\d+$/.test(w);
const titleWords = t => new Set(tokens(fold(cleanTitle(t))).filter(w => !NOISE.has(w)));
// Clave del colegio para comparar (como pd.schoolKey, con las letras dobles juntas)
export const keyOf = s => schoolKey({ ...s, name: fold(s.name), city: s.city || "", country: s.country || "" });

// ---------- nombre
// k: keyOf(colegio). places: lugares de la base (pd.matchCtx(...).places). null si no se parece.
// Con una sola palabra propia («Colegio Los Ángeles»), «same» no admite nada de más: «Santa María de los Ángeles» es otro.
export function nameLevel(k, title, places) {
  const b = titleWords(title);
  if (!k?.a.length || !b.size) return null;
  const r = rate(k, b, places);
  const all = k.a.every(t => b.has(t));
  if (all && k.strong && r.score >= SURE) {
    // de más solo palabras comunes que no digan sede ni nivel, la ciudad del colegio («… cdmx») o un estado («… PUE»)
    const extra = [...b].filter(w => !k.own.has(w) && !k.place.has(w) && w.length > 2 && !STATE_ABBR.has(w) && !cityWord(k, w));
    if (k.a.length === 1 ? !extra.length : extra.every(w => !isNum(w) && !SEDE_WORDS.has(w) && LOW.has(w))) return "same";
  }
  if (all && eligible(k.a, b)) return "contains";
  return r.score >= PICK ? "close" : null;
}
// la palabra nombra la ciudad del colegio (cdmx, caba…: pd.cityIn con alias)
const cityWord = (k, w) => cityIn(k.parts, new Set([w]));
// abreviaturas de estados que aparecen en los títulos («Colegio Hispanidad PUE»): no cambian el nombre
const STATE_ABBR = new Set("ags bc bcs camp chis chih cdmx df coah dgo gto gro hgo jal edomex mich mor nay nl oax pue qro qroo slp sin son tab tamps tamp tlax ver yuc zac caba".split(" "));

// ---------- lugar
const COUNTRY = new Map(Object.entries(MARKETS).flatMap(([name, m]) => [[norm(name), name], [String(m.code).toLowerCase(), name]]));
for (const [a, b] of [["mexico", "México"], ["peru", "Perú"], ["espana", "España"], ["panama", "Panamá"], ["brasil", "Brasil"], ["estados unidos", "Estados Unidos"]]) COUNTRY.set(a, b);
const countryOf = t => COUNTRY.get(norm(t)) || "";
// ciudades que son también su estado o distrito: ahí «…, coyoacan, ciudad de méxico» es la misma ciudad
const CITY_STATES = new Set(["ciudad de mexico", "mexico", "cdmx", "mexico city", "buenos aires", "ciudad autonoma de buenos aires", "caba", "bogota", "lima", "ciudad de guatemala", "guatemala"]);
const SKIP_PIECE = /^(c ?p|cp|codigo postal|col|colonia|fracc|fraccionamiento|barrio|urb|urbanizacion|unidad habitacional|residencial|ninguno|sin colonia|n|na|s n|sn)\b/;
// Una dirección de Pipedrive en partes: { muni, state, country }. «calle 13 poniente No. 0, Colonia ninguno, atlixco, puebla,
// C.P. 0» → atlixco y puebla; «Boulevard de las Torres 1844, Puebla de Zaragoza, México» → Puebla de Zaragoza (país México).
// La primera parte es la calle; las que tienen números (C.P., «16 No. 40», «1.ª Etapa G-04»), la colonia y el país no son
// lugar. null si no hay al menos calle y lugar.
export function addrParts(text) {
  const pieces = String(text || "").split(",").map(p => p.trim().replace(/[.\s]+$/, "")).filter(Boolean);
  if (pieces.length < 2) return null;
  let country = "";
  const rest = pieces.slice(1).filter(p => {
    const n = norm(p);
    if (!n || /\d/.test(p) || SKIP_PIECE.test(n)) return false;
    const c = countryOf(p); if (c) { country = c; return false; }
    return true;
  });
  if (!rest.length) return country ? { muni: "", state: "", country } : null;
  return rest.length >= 2 ? { muni: rest.at(-2), state: rest.at(-1), country } : { muni: rest[0], state: "", country };
}
// un texto que es solo una ciudad («puebla», «tlalpan», la opción del campo Ciudad): sin números, mails ni webs, corto
const cityLike = t => { const s = String(t || "").trim(); return s.length > 2 && s.length <= 40 && !/[\d@]|https?:|www\.|\.(com|mx|edu|org|net)\b/i.test(s) && s.split(/\s+/).length <= 5; };
const RANK = { same: 3, near: 2, other: 1 };
const best = (a, b) => (RANK[b] || 0) > (RANK[a] || 0) ? b : a;
// Partes de un lugar («Puebla de Zaragoza» → [puebla] y [zaragoza]; «cdmx» → [mexico]), sin «San», «Ciudad», «Heroica»…
const ALIAS = [[/\b(cdmx|cd mx|d f|df|distrito federal)\b/g, "ciudad de mexico"], [/\bcaba\b/g, "buenos aires"], [/\bheroica\b|\bh\b/g, " "]];
const partsOf = t => { let n = norm(t); for (const [re, v] of ALIAS) n = n.replace(re, v); return cityParts(n); };
const same1 = (a, b) => a.length === b.length && a.every(w => b.includes(w));
// ¿el texto es la ciudad del colegio? La primera parte de uno tiene que ser una parte del otro, y al revés: «puebla» =
// «Puebla de Zaragoza», pero «Atizapán de Zaragoza» no (empieza con otra cosa).
export function sameCity(text, city) {
  const a = partsOf(text), b = partsOf(city);
  return !!a.length && !!b.length && b.some(p => same1(p, a[0])) && a.some(p => same1(p, b[0]));
}
// school: { city, country, name }; rec: { texts, title, org: { city, region, country }, country }
export function placeLevel(school, rec = {}) {
  const city = school.city || "";
  if (!partsOf(city).length) return null;
  const inCity = t => !!t && sameCity(t, city);
  const cityState = CITY_STATES.has(norm(city));
  const otherCountry = c => !!c && !!school.country && countryOf(c) && countryOf(c) !== (countryOf(school.country) || school.country);
  if (otherCountry(rec.country)) return "other";
  let out = null;
  for (const t of rec.texts || []) {
    const a = addrParts(t);
    if (a) {
      if (otherCountry(a.country)) { out = best(out, "other"); continue; }
      if (!a.muni) continue;
      if (inCity(a.muni) || (cityState && inCity(a.state))) return "same";
      out = best(out, a.state && inCity(a.state) ? "near" : "other");
    } else if (cityLike(t) && inCity(t)) return "same";
  }
  // el título nombra la ciudad (su primera parte: «… cdmx», «… Oaxaca»), y no porque el colegio la tenga en su nombre
  // («Colegio Ángeles de Puebla»)
  if (rec.title) {
    const head = partsOf(city)[0], own = new Set(tokens(fold(school.name || "")));
    const b = new Set(partsOf(rec.title).flat().filter(w => !own.has(w)));
    if (head.every(w => b.has(w))) return "same";
  }
  const o = rec.org;
  if (o) {
    if (otherCountry(o.country)) return best(out, "other");
    if (o.city) out = best(out, inCity(o.city) ? "same" : o.region && inCity(o.region) ? "near" : "other");
  }
  return out;
}

// ---------- contacto
const GENERIC_HOSTS = new Set(("gmail.com hotmail.com hotmail.es outlook.com outlook.es live.com live.com.mx yahoo.com yahoo.com.mx yahoo.es icloud.com " +
  "prodigy.net.mx msn.com aol.com protonmail.com facebook.com fb.com m.facebook.com instagram.com twitter.com x.com linkedin.com youtube.com " +
  "tiktok.com wa.me whatsapp.com linktr.ee google.com sites.google.com goo.gl maps.google.com blogspot.com wordpress.com wixsite.com " +
  "business.site schoolingmx.com").split(" "));
export const hostOf = v => {
  const m = String(v || "").trim().toLowerCase().match(/^(?:https?:\/\/)?(?:www\.)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?:[:/?#]|$)/);
  return m && !GENERIC_HOSTS.has(m[1]) ? m[1] : "";
};
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
export const emailsIn = v => [...new Set(String(v || "").toLowerCase().match(EMAIL_RE) || [])];
// teléfonos de un texto que es solo teléfonos («+52 (55) 5568-2834 / (55) 5568-1483»): los dígitos sin código de país ni 0
export function phonesIn(v) {
  const s = String(v || "").trim();
  if (!/^[\d\s()+\-.\/,;]+$/.test(s)) return [];
  return [...new Set(s.split(/\s*[\/,;]\s*|\s+-\s+/).map(p => nationalDigits(p).replace(/^0+/, "")).filter(d => d.length >= 7))];
}
export const samePhone = (a, b) => { const n = Math.min(a.length, b.length, 10); return n >= 7 && a.slice(-n) === b.slice(-n); };
// lo del colegio para comparar
export function contactOf(s) {
  const phones = [...new Set([s.phone, ...(s.phones || [])].flatMap(p => phonesIn(p).length ? phonesIn(p) : [nationalDigits(p).replace(/^0+/, "")]).filter(d => d.length >= 7))];
  const emails = [...new Set([s.email, ...(s.emails || [])].flatMap(emailsIn))];
  const hosts = [...new Set([hostOf(s.web), ...emails.map(e => hostOf(e.split("@")[1]))].filter(Boolean))];
  return { phones, emails, hosts };
}
// ¿el registro tiene el mismo teléfono, mail o dominio? "phone" | "email" | "web" | null
export function contactHit(c, rec) {
  const texts = rec.texts || [];
  const phones = [...(rec.phones || []).flatMap(p => phonesIn(p).length ? phonesIn(p) : [nationalDigits(p).replace(/^0+/, "")]), ...texts.flatMap(phonesIn)];
  if (c.phones.some(a => phones.some(b => samePhone(a, b)))) return "phone";
  const emails = [...(rec.emails || []).flatMap(emailsIn), ...texts.flatMap(emailsIn)];
  if (c.emails.some(e => emails.includes(e))) return "email";
  const hosts = new Set([...texts.map(hostOf), ...emails.map(e => hostOf(e.split("@")[1]))].filter(Boolean));
  if (c.hosts.some(h => hosts.has(h))) return "web";
  return null;
}

// ---------- qué buscar
// title: el nombre propio (sin «colegio/instituto/escuela…», ni palabras comunes, ni la ciudad), con y sin acentos, en el
// título (Pipedrive exige todas las palabras). local: lo mismo y la ciudad, en título y campos (la dirección del prospecto).
// phones: cada teléfono escrito con espacios (en los campos de texto Pipedrive busca por palabras) y sus dígitos (personas).
export function searchTerms(s) {
  const all = tokens(s.name), place = new Set([...cityParts(s.city).flat(), ...tokens(s.country)]);
  const own = all.filter(w => !LOW.has(w) && !place.has(w) && !NOISE.has(w));
  const words = (own.length ? own : all.filter(w => !NOISE.has(w))).slice(0, 3);
  const t1 = words.join(" ");
  const title = t1.length >= 3 ? [t1] : [];
  // con acentos, como está escrito («ángeles»): solo si cambia algo
  const accented = String(s.name || "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w && words.includes(norm(w)));
  const acc = [...new Set(accented)].sort((a, b) => words.indexOf(norm(a)) - words.indexOf(norm(b))).join(" ");
  if (acc && acc !== t1 && norm(acc) === t1) title.push(acc);
  const cityW = cityParts(s.city).flat().find(w => !LOW.has(w)) || "";
  const local = t1.length >= 3 && cityW ? [...new Set([...words, cityW])].join(" ") : "";
  const c = contactOf(s);
  return { title, local, phones: c.phones.slice(0, 2).map(d => ({ digits: d, spaced: spacedVariants(d).slice(0, 2) })), emails: c.emails.slice(0, 2), hosts: c.hosts.slice(0, 1) };
}

// ---------- registros de Pipedrive, como los da /v2/itemSearch (prospecto, trato, organización o persona)
export function recOf(it, extra = {}) {
  const texts = [...(it.custom_fields || []), ...(it.address ? [it.address] : [])].map(x => typeof x === "object" && x ? x.value ?? x.formatted_address ?? "" : x).map(String).filter(Boolean);
  return { key: `${it.type}:${it.id}`, kind: it.type, id: it.id, title: String(it.title || it.name || ""), ownerId: realOwner(it.owner?.id), orgId: it.organization?.id || null,
    orgName: it.organization?.name || "", personId: it.person?.id || null, personName: it.person?.name || "", archived: !!it.is_archived, status: it.status || null,
    stage: it.stage?.name || "", texts, phones: it.phones || [], emails: it.emails || [], ...extra };
}
// un prospecto como lo da lib/pipedrive.js (leadRec): labels { ciudad, estado, pais } de sus opciones si se conocen
export function recOfLead(l, labels = {}, extra = {}) {
  return { key: `lead:${l.id}`, kind: "lead", id: l.id, title: l.title || "", ownerId: l.ownerId ?? null, orgId: l.orgId || null, orgName: "", personId: l.personId || null,
    archived: !!l.archived, texts: [l.addr, l.phone, l.email, l.web, labels.ciudad, labels.estado].filter(Boolean), country: labels.pais || "", ...extra };
}

// ---------- juicio y decisión
// ctx: { k: keyOf(colegio), places, contact: contactOf(colegio) }
export function judge(school, ctx, rec) {
  const name = nameLevel(ctx.k, rec.title, ctx.places) || (rec.orgName ? nameLevel(ctx.k, rec.orgName, ctx.places) : null);
  const contact = rec.contact || contactHit(ctx.contact, rec);
  if (!name && !contact) return { ...rec, name, contact, place: null, level: null };
  const place = placeLevel(school, rec);
  let level = null, why = "";
  if (contact && place !== "other") { level = "sure"; why = CONTACT_WHY[contact]; }
  else if (contact) { level = "maybe"; why = `${CONTACT_WHY[contact]}, pero de otra ciudad`; }
  else if (name === "same" && place === "same") { level = "sure"; why = "mismo nombre y misma ciudad"; }
  else if (name === "same" && place === "near") { level = "maybe"; why = "mismo nombre, en otro municipio del estado"; }
  else if (name === "same" && !place) { level = "maybe"; why = "mismo nombre, sin ciudad en Pipedrive"; }
  else if (name && place === "same") { level = "maybe"; why = "nombre parecido, misma ciudad"; }
  return { ...rec, name, contact, place, level, why };
}
const CONTACT_WHY = { phone: "mismo teléfono", email: "mismo mail", web: "misma web" };
// orden: prospecto abierto (tuyo, libre, de otra persona), trato con organización, organización, trato sin organización;
// a igual, primero lo que coincide por contacto
const rankOf = (x, me) => (x.kind === "lead" ? 0 : x.kind === "deal" && x.orgId ? 1 : x.kind === "organization" ? 1.5 : 2)
  + (x.kind === "lead" ? (Number(x.ownerId) === Number(me) ? 0 : !x.ownerId ? 0.1 : 0.2) : 0) + (x.contact ? 0 : 0.05) + (x.level === "sure" ? 0 : 0.5);
// list: registros ya juzgados (sin repetir). no: claves descartadas con «Es otro colegio». me: usuario de Pipedrive.
// { verdict: "sure" | "maybe" | "none", pick, maybe: [...], info: [...] }. Un prospecto archivado o un trato perdido sin
// organización nunca se elige solo: van en info (dato, con aviso).
export function decide(list, { no = [], me = null } = {}) {
  const skip = new Set(no), seen = new Set(), out = { verdict: "none", pick: null, maybe: [], info: [] };
  const hits = list.filter(x => x?.level && !seen.has(x.key) && seen.add(x.key)).sort((a, b) => rankOf(a, me) - rankOf(b, me));
  for (const x of hits) {
    if (skip.has(x.key)) continue;
    const dato = (x.kind === "lead" && x.archived) || (x.kind === "deal" && !x.orgId && x.status === "lost");
    if (dato) { out.info.push(x); continue; }
    if (x.level === "sure" && !out.pick) { out.pick = x; continue; }
    out.maybe.push(x);
  }
  out.verdict = out.pick ? "sure" : out.maybe.length ? "maybe" : "none";
  // con uno elegido, las dudosas no cuentan (quedan las otras seguras: el mismo colegio cargado dos veces)
  if (out.pick) { out.also = out.maybe.filter(x => x.level === "sure"); out.maybe = []; }
  return out;
}

// ---------- los pedidos a Pipedrive (los hace lib/sales.js, investigate) y lo que vuelve, juzgado
// types/fields como /v2/itemSearch; { types: "person", fields: "phone" } es /v2/persons/search por teléfono.
// light (el cruce de cada ficha): el nombre en el título y el nombre con la ciudad (2 pedidos). full (antes de crear algo):
// además el nombre con acentos y el teléfono, el mail y la web del colegio en los campos de prospectos, tratos y
// organizaciones, y las personas con ese teléfono o mail.
export function queryPlan(s, { full = false } = {}) {
  const t = searchTerms(s), out = [];
  const add = (types, fields, term, why) => { if (term && !out.some(q => q.types === types && q.fields === fields && q.term === term)) out.push({ types, fields, term, why }); };
  (full ? t.title : t.title.slice(0, 1)).forEach(x => add("lead,deal", "title", x, "name"));
  add("lead,deal", "title,custom_fields", t.local, "local");
  if (full) {
    for (const p of t.phones) { p.spaced.forEach(x => add("lead,deal,organization", "custom_fields", x, "phone")); add("person", "phone", p.digits, "phone"); }
    for (const e of t.emails) { add("lead,deal,organization", "custom_fields", e, "email"); add("person", "email", e, "email"); }
    for (const h of t.hosts) add("lead,deal,organization", "custom_fields", h, "web");
  }
  return out;
}
export const ctxOf = (s, places) => ({ k: keyOf(s), places, contact: contactOf(s) });
// los resultados de los pedidos (sin personas: esas llevan a sus prospectos y tratos), sin repetir y juzgados
export function judgeAll(s, ctx, items) {
  const out = new Map();
  for (const it of items) {
    if (!it?.id || it.type === "person") continue;
    const r = recOf(it); if (!out.has(r.key)) out.set(r.key, judge(s, ctx, r));
  }
  return [...out.values()];
}
