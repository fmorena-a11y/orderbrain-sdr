// La base por país (decisión del líder: «por país»): el navegador baja solo los colegios de los países que trabaja y el resto a
// pedido. Acá va lo puro (sin DOM ni red; pruebas en test/schools-country.test.mjs): qué países cargar al entrar, las ciudades
// de la vista mundial de Prospectar (de lo cargado o del resumen del servidor, GET /api/schools/summary) y cuántos hay para llamar.
// La carga en sí está en public/js/schoolbase.js.

// mismas reglas que explore.js: «para llamar» = todo lo que no es cliente ni está en proceso (incluye «Sin revisar») y no es de
// otra persona; la burbuja de ciudad del mapa cuenta solo los ya revisados (sin «Sin revisar», que va como aro hueco)
export const CALLABLE = new Set(["new", "org", "stalled", "lost", "unk"]);
const PROS = new Set(["new", "org", "stalled", "lost"]);
const ST_KEYS = new Set(["new", "org", "lead", "churn", "lost", "stalled", "open", "client", "unk", "archived"]);
const PH_KEYS = new Set(["activo", "onboarding", "cerrado", "churn", "propuesta"]);
// la marca del mapa (markOf de core.js): la fase manda sobre el estado
export const markKey = s => s?.phase && PH_KEYS.has(s.phase) ? `ph-${s.phase}` : ST_KEYS.has(s?.status) ? s.status : "unk";
// de otra persona: la organización en Pipedrive tiene otro dueño (me: tu usuario de Pipedrive; sin usuario, nada es de otro)
export const othersOwn = (s, me) => !!(s?.ownerId && me && Number(s.ownerId) !== Number(me));

// Qué países se cargan al entrar (y al cambiar el territorio):
//  · elegiste países en tu perfil (ob.territory): esos;
//  · elegiste «Todos»: todos, como siempre;
//  · no elegiste: los países donde trabajaste (workCountries de /api/me: tus contactos de los últimos 90 días y las
//    organizaciones a tu nombre; un líder sin nada propio, lo del equipo de los últimos 30 días);
//  · sin nada de eso: todos, como antes.
// Lo demás se carga a pedido (un chip de país, una ciudad, un lugar, una ficha, una búsqueda).
export function pickCountries({ territory = [], chosen = false, work = [], countries = [] } = {}) {
  const ok = c => countries.includes(c), uniq = l => [...new Set(l.filter(ok))];
  if (chosen && territory.length) { const l = uniq(territory); if (l.length) return { list: l, why: "territory" }; }
  if (chosen && !territory.length) return { list: [...countries], why: "all" };
  const w = uniq(work); if (w.length) return { list: w, why: "work" };
  return { list: [...countries], why: "all" };
}

const r5 = v => Math.round(v * 1e5) / 1e5;
// cuántos para llamar con lo que trae el resumen: lo que no tiene dueño más lo tuyo (sin usuario de Pipedrive, todo)
export function prosOf(pf, po, me) {
  let n = pf || 0;
  for (const [id, v] of Object.entries(po || {})) if (!me || Number(id) === Number(me)) n += v;
  return n;
}
// Ciudades de una lista de colegios cargados: { country, city, n, lat, lng, unk, pros (lista: para llamar, con «Sin revisar»),
// prosMap (burbuja del mapa: sin «Sin revisar»), k: { marca: cuántos }, items }. Mismo orden que la vista general: país y, dentro,
// de la que más colegios tiene a la que menos.
export function aggCities(list, me) {
  const m = new Map();
  for (const s of list) {
    const key = `${s.country}|${s.city}`;
    let c = m.get(key);
    if (!c) m.set(key, c = { country: s.country, city: s.city, n: 0, lat: 0, lng: 0, ll: 0, unk: 0, pros: 0, prosMap: 0, k: {}, items: [] });
    c.n++; c.items.push(s);
    const mk = markKey(s); c.k[mk] = (c.k[mk] || 0) + 1;
    if (typeof s.lat === "number" && typeof s.lng === "number") { c.lat += s.lat; c.lng += s.lng; c.ll++; }
    if (s.status === "unk") c.unk++;
    const mine = !othersOwn(s, me);
    if (CALLABLE.has(s.status) && mine) c.pros++;
    if (PROS.has(s.status) && mine) c.prosMap++;
  }
  return sortCities([...m.values()].map(({ ll, ...c }) => ({ ...c, lat: ll ? r5(c.lat / ll) : null, lng: ll ? r5(c.lng / ll) : null })));
}
// Ciudades del resumen del servidor, con la misma forma (sin items). skip: los países que no van (los que ya están cargados:
// esos salen de lo cargado, que está más al día). only: solo esos países.
export function summaryCities(summary, { me = null, skip = null, only = null } = {}) {
  const out = [];
  for (const c of summary?.countries || []) {
    if (skip?.has(c.country) || (only && !only.has(c.country))) continue;
    for (const [city, n, lat, lng, unk, pf, po, k] of c.cities) {
      const pm = prosOf(pf, po, me);
      out.push({ country: c.country, city, n, lat, lng, unk, pros: pm + unk, prosMap: pm, k: k || {}, items: null });
    }
  }
  return out;
}
export const sortCities = list => list.sort((a, b) => a.country.localeCompare(b.country) || b.n - a.n);
// colegios por país según el resumen (para los chips y para decir cuántos hay en lo que no se cargó)
export const countOf = (summary, country) => (summary?.countries || []).find(c => c.country === country)?.n ?? null;
export const partsOf = (summary, country) => (summary?.countries || []).find(c => c.country === country)?.parts || 1;
// ¿falta cargar algo de lo que se mira? (la vista no puede afirmar un número de lo que no tiene)
export const missing = (wanted, loaded) => [...new Set(wanted.filter(Boolean))].filter(c => !loaded.has(c));
