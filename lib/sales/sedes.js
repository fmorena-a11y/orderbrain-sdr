// Sedes de un colegio (planteles, campus).
import * as pd from "../pipedrive.js";
import { byId, getMatch, schools } from "../store.js";
import { MARKETS } from "../config.js";
import { keyTokens } from "../scan.js";
import { webInfo } from "../enrich.js";
import { appCountry } from "./records.js";

// ---------- sedes de un colegio (planteles, campus): de Pipedrive (organizaciones y prospectos de la misma marca),
// de la base y de lo que publica su web. Solo datos escritos en esas fuentes, con la fuente de cada uno.
const SEDE_WORD = /\b(plantel|planteles|campus|sede|sedes|sucursal|seccion)\b/;
export const sedeCache = new Map();
export const splitPhones = v => String(v || "").split(/\s+[-–]\s+|\s*(?:\/|,|;|\by\b|\bo\b)\s*/).map(x => x.trim()).filter(x => x.replace(/\D/g, "").length >= 7);
export const splitMails = v => String(v || "").split(/[\s,;/]+/).map(x => x.trim().toLowerCase()).filter(x => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(x));
export const capWords = t => String(t).toLowerCase().replace(/(^|\s)\p{L}/gu, m => m.toUpperCase());
// palabras de nombres muy repetidos (santos, próceres, advocaciones): con solo esas, «Sagrado Corazón» o «Simón Bolívar»
// no alcanzan para decir que dos colegios son de la misma red
const COMMON = new Set("sagrado corazon jesus maria jose juan bosco simon bolivar santa rosa lima cristo rey divino nino nina nuestra senora inmaculada concepcion guadalupe francisco asis antonio padua pedro pablo vicente paul ignacio loyola teresa benito juarez miguel hidalgo jose marti sarmiento belgrano artigas moreno valle americano americana ingles britanico frances aleman italiano mexicano argentino chileno peruano uruguayo".split(" "));
// tipo de institución: una universidad o un profesorado no son sede de un colegio
const TIPO = n => /\buniversidad|\buniversit|\buniv\b/.test(n) ? "uni" : /\bprofesorado|\bterciario|\bnormal superior|\binstituto superior/.test(n) ? "ter" : "k12";
let PLACES = null;
// lugares conocidos (países y ciudades de la base): el «nombre del plantel» de otra red suele ser otra ciudad
const places = () => PLACES ||= new Set([...Object.keys(MARKETS).flatMap(k => keyTokens(k)), "mexico", "peru", ...schools.flatMap(o => keyTokens(o.city))]);
export async function sedesFor(id) {
  const s = byId.get(id); if (!s) return { sedes: [] };
  const c = sedeCache.get(id); if (c && Date.now() - c.at < 3600e3) return c.v;
  const rec = getMatch(id) || {};
  const city = pd.norm(s.city), cityT = new Set([...keyTokens(s.city), ...keyTokens(s.country)]), tipo = TIPO(pd.norm(s.name));
  // la marca: las palabras propias del nombre antes de «plantel/campus/sede», sin la ciudad ni el país
  const brandOf = n => { const x = pd.norm(n), i = x.search(SEDE_WORD); return keyTokens(i > 0 ? x.slice(0, i) : x).filter(w => !SEDE_WORD.test(w) && !cityT.has(w)); };
  const brands = [s.name, rec.confirmed ? rec.orgName : ""].filter(Boolean).map(n => ({ n, b: brandOf(n), campus: SEDE_WORD.test(pd.norm(n)) }));
  // «preparatoria esfer salesianos kennedy»: sin la palabra plantel, la última palabra suele ser el plantel
  for (const x of [...brands]) if (!x.campus && x.b.length >= 3) brands.push({ n: x.n, b: x.b.slice(0, -1), campus: false });
  const brand = brands.map(x => x.b).filter(b => b.length).sort((a, b) => a.length - b.length)[0] || [];
  const none = () => { const v = { sedes: [] }; sedeCache.set(id, { at: Date.now(), v }); return v; };
  // una sola palabra («Americano», «Santiago») no alcanza para decir que son la misma red
  if (brand.length < 2) return none();
  const distinct = brand.some(w => !COMMON.has(w));
  const same = (a, b) => a.length === b.length && a.every(w => b.includes(w));
  // mismo colegio: mismo tipo de institución, su marca es igual a la nuestra (o le suma solo el nombre del plantel, que no
  // puede ser otra ciudad o país), y es de la misma ciudad o dice plantel/campus/sede. Con una marca de nombres muy repetidos,
  // tiene que decir plantel/campus/sede y la marca ser exactamente la misma.
  const fits = (name, place = "") => {
    const n = pd.norm(name), b = brandOf(name), campus = SEDE_WORD.test(n);
    if (TIPO(n) !== tipo) return false;
    const extra = b.filter(w => !brand.includes(w));
    if (!(same(b, brand) || (b.length === brand.length + 1 && extra.length === 1))) return false;
    if (extra.length && places().has(extra[0])) return false;
    if (!distinct && !(campus && same(b, brand))) return false;
    const p = ` ${pd.norm(`${name} ${place}`)} `;
    return !!city && p.includes(` ${city} `) || campus && !place;
  };
  const keyOf = name => keyTokens(name).filter(w => !brand.includes(w) && !cityT.has(w) && !SEDE_WORD.test(w)).map(w => w.length > 4 ? w.replace(/s$/, "") : w).join(" ") || "principal";
  const sedes = new Map();
  const get = name => { const k = keyOf(name); if (!sedes.has(k)) sedes.set(k, { key: k, name: "", phones: [], emails: [], web: "", addr: "", orgId: null, url: "", owner: "", ownerId: null, leads: [], schoolId: null, src: [] }); return sedes.get(k); };
  const add = (x, src, { phones = [], emails = [], web = "", addr = "" } = {}) => {
    for (const p of phones) { const d = p.replace(/\D/g, ""); if (!x.phones.some(q => q.replace(/\D/g, "").endsWith(d) || d.endsWith(q.replace(/\D/g, "")))) x.phones.push(p); else if (d.length > 7) x.phones = x.phones.map(q => d.endsWith(q.replace(/\D/g, "")) ? p : q); }
    for (const e of emails) if (!x.emails.includes(e)) x.emails.push(e);
    x.web ||= web; x.addr ||= addr; if (!x.src.includes(src)) x.src.push(src);
  };
  let failed = false;
  const term = brand.join(" "), byName = t => { const b = brandOf(t); return brand.every(w => b.includes(w)); };
  const [found, leads, m] = await Promise.all([
    pd.searchOrganizations(term, 15).catch(() => { failed = true; return []; }),
    pd.searchLeads(term, 6, byName).catch(() => { failed = true; return []; }),
    pd.meta().catch(() => ({ users: [] }))]);
  const uname = uid => uid ? m.users.find(u => u.id === uid)?.name || "" : "";
  // dirección de las organizaciones candidatas, para pedir mismo país y ciudad
  const cand = found.filter(o => byName(o.name));
  const place = new Map((await pd.orgsByIds(cand.map(o => o.id)).catch(() => { failed = true; return []; })).map(o => [o.id, o]));
  for (const o of cand) {
    const pl = place.get(o.id);
    if (pl?.country && appCountry(pl.country) && appCountry(pl.country) !== s.country) continue;
    if (!fits(o.name, [pl?.city, pl?.region].filter(Boolean).join(" "))) continue;
    const x = get(o.name); x.name = o.name; x.orgId = o.id; x.url = `${pd.PD_WEB}/organization/${o.id}`;
    x.ownerId = o.ownerId || null; x.owner = uname(o.ownerId); add(x, "Pipedrive");
  }
  for (const l of leads) {
    const nm = (l.orgId && cand.find(o => o.id === l.orgId)?.name) || l.title;
    if (!fits(nm, l.addr) && !(l.orgId && [...sedes.values()].some(x => x.orgId === l.orgId))) continue;
    const x = get(nm); x.name ||= nm; x.leads.push({ id: l.id, title: l.title, archived: !!l.archived, url: `${pd.PD_WEB}/leads/inbox/${l.id}`, ownerId: l.ownerId || null, owner: uname(l.ownerId) });
    if (!x.ownerId && l.ownerId && !l.archived) { x.ownerId = l.ownerId; x.owner = uname(l.ownerId); }
    add(x, "Pipedrive", { phones: splitPhones(l.phone), emails: splitMails(l.email), web: l.web, addr: l.addr });
  }
  for (const o of schools) if (o.id !== s.id && !o.virtual && o.country === s.country && pd.norm(o.city) === city && fits(o.name, o.city)) {
    const x = get(o.name); x.name ||= o.name; x.schoolId ||= o.id; add(x, "Mapa", { phones: splitPhones(o.phone), emails: splitMails(o.email), web: o.web || "", addr: o.addr || "" });
  }
  // un nombre igual sin plantel no es otra sede (es otro colegio con el mismo nombre, o el mismo cargado dos veces)
  sedes.delete("principal");
  // la web: la del colegio o la de una sede encontrada arriba (se dice de cuál)
  const webSede = s.web ? null : [...sedes.values()].find(x => x.web);
  let web = s.web || webSede?.web || "";
  if (web && !/^https?:\/\//i.test(web)) web = "https://" + web;
  if (web) {
    const w = await webInfo(web, AbortSignal.timeout(9000)).catch(() => null);
    for (const ws of w?.sedes || []) { const x = get(`${ws.kind} ${ws.name}`); x.name ||= capWords(`${ws.kind} ${ws.name}`); add(x, "Web", { phones: ws.phones, web }); }
  }
  // lada: un número local de la web (sin código de área) se completa solo si los otros números fijos de la red en esa
  // ciudad traen todos la misma lada (no 800/900); se guarda el número publicado y de dónde salió la lada
  const nat = p => p.replace(/\D/g, "").replace(/^(00)?52(1)?(?=\d{10}$)/, "");
  const full = [...sedes.values()].flatMap(x => x.phones).map(nat).filter(d => d.length === 10 && !/^(800|900|01)/.test(d));
  for (const x of sedes.values()) x.phones = x.phones.map(p => {
    const d = nat(p); if (d.length >= 10 || /^\+/.test(p) || s.country !== "México") return { n: p };
    const pre = [...new Set(full.map(f => f.slice(0, 10 - d.length)))];
    const f = pre[0] + d; return pre.length === 1 && d.length >= 7 ? { n: `${f.slice(0, 3)} ${f.slice(3, 6)} ${f.slice(6)}`, raw: p, lada: pre[0] } : { n: p, short: true };
  });
  const list = [...sedes.values()].map(x => ({ ...x, here: !!(rec.orgId && x.orgId === rec.orgId) })).sort((a, b) => b.here - a.here || a.name.localeCompare(b.name));
  const v = { sedes: list.length >= 2 ? list : [], web: list.length >= 2 ? web || "" : s.web || "", webFrom: webSede && list.length >= 2 ? webSede.name : "" };
  if (!failed) sedeCache.set(id, { at: Date.now(), v });
  return v;
}
