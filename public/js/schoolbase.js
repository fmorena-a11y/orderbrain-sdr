// La base de colegios en el navegador, por país (decisión del líder: «por país»; con los padrones la base pasa de 23.000 a
// 50.000–60.000 colegios y bajarla entera al entrar se volvía lenta). Al entrar se bajan solo los países que trabajás
// (pickCountries de schoolsum.js: tu territorio, o los países donde trabajaste) y el resumen por país y ciudad (≈40 KB) para la
// vista mundial de Prospectar; el resto se carga a pedido (ensureCountry): al tocar el chip de un país, abrir una ciudad o un
// lugar, o buscar colegios de una zona. Una ficha de otro país (desde Hoy, la Agenda, una sesión o una búsqueda) trae solo ese
// colegio (ensureSchools). Buscar sin país también pregunta al servidor por los países que no tenés cargados (searchOther).
// Cada país (o parte de un país grande) es su propio pedido con su ETag: el navegador lo guarda y, si no cambió, recibe 304.
// Avisa con el evento «ob:schools» ({ countries, kind: load | drop | error | items }) para que las vistas se redibujen.
import { S, api, norm, addCountrySchools, dropCountrySchools, rememberLoose, territoryChosen } from "./core.js";
import { pickCountries, partsOf, missing } from "./schoolsum.js";

const LOADING = new Map();
const fire = (countries, kind) => dispatchEvent(new CustomEvent("ob:schools", { detail: { countries, kind } }));
export const isLoaded = c => S.loaded.has(c);
export const notLoaded = () => S.countries.filter(c => !S.loaded.has(c));
export const allLoaded = () => !notLoaded().length;
export const loadingCountry = c => LOADING.has(c);
export const loadError = c => S.loadErr?.get(c) || "";
// de una lista de países, los que faltan cargar (los que no son de la base no cuentan)
export const toLoad = list => missing((list || []).filter(c => S.countries.includes(c)), S.loaded);

export function loadSummary({ force = false } = {}) {
  if (S.summaryP && !force) return S.summaryP;
  const p = S.summaryP = api("/api/schools/summary").then(r => { S.summary = r; CITIES.k = ""; S.rev = (S.rev || 0) + 1; return r; }).catch(e => { if (S.summaryP === p) S.summaryP = null; throw e; });
  return p;
}
// baja un país (en partes si es grande: cuántas lo dice el resumen) y lo suma a S.schools
export function ensureCountry(c) {
  if (!c || !S.countries.includes(c) || S.loaded.has(c)) return Promise.resolve(true);
  if (LOADING.has(c)) return LOADING.get(c);
  const p = (async () => {
    const parts = partsOf(await loadSummary().catch(() => null), c);
    const url = i => `/api/schools?cc=${encodeURIComponent(c)}${parts > 1 ? `&part=${i}&parts=${parts}` : ""}`;
    const chunks = await Promise.all(Array.from({ length: parts }, (_, i) => api(url(i))));
    addCountrySchools(c, chunks.flat()); S.loadErr?.delete(c); CITIES.k = "";
    fire([c], "load");
    return true;
  })().catch(e => { (S.loadErr ||= new Map()).set(c, e.message); fire([c], "error"); throw e; }).finally(() => LOADING.delete(c));
  LOADING.set(c, p);
  return p;
}
export const ensureCountries = list => Promise.all(toLoad(list).map(ensureCountry));

// lo de entrada: el resumen y los países de pickCountries (si un país falla, el error sube: «No pudimos cargar los colegios»)
export async function loadInitial() {
  const pick = S.basePick = pickCountries({ territory: S.territory, chosen: territoryChosen(), work: S.workCountries || [], countries: S.countries });
  const sum = loadSummary().catch(() => null);
  await ensureCountries(pick.list);
  await sum;
  S.baseReady = true;
  syncTerritory(); // si mientras cargaba eligió su territorio (el perfil de la primera vez), se acomoda
}
// Cambió el territorio (perfil o Hoy): se cargan los países nuevos y salen de las listas los que ya no están (salvo el que estás
// mirando en Prospectar). Lo que sale sigue en S.byId: una ficha o una sesión abierta no se rompen.
export function syncTerritory() {
  if (!S.baseReady) return;
  const pick = S.basePick = pickCountries({ territory: S.territory, chosen: territoryChosen(), work: S.workCountries || [], countries: S.countries });
  const E = S.explore || {}, keep = new Set([...pick.list, E.country, E.place?.country, ...(E.place?.countries || [])].filter(Boolean));
  const drop = [...S.loaded].filter(c => S.countries.includes(c) && !keep.has(c));
  if (drop.length) { dropCountrySchools(drop); CITIES.k = ""; fire(drop, "drop"); }
  ensureCountries(pick.list).catch(() => {});
}
addEventListener("ob:territory", syncTerritory);
// después de sincronizar con Pipedrive o World Dominion (Equipo): los países cargados y el resumen, de nuevo
export async function reloadSchools() {
  const list = [...S.loaded].filter(c => S.countries.includes(c));
  await loadSummary({ force: true }).catch(() => null);
  list.forEach(c => S.loaded.delete(c));
  await Promise.all(list.map(c => ensureCountry(c).catch(() => S.loaded.add(c))));
}

// colegios sueltos de países no cargados (la ficha de uno de Hoy, la Agenda, una sesión): solo esos, de a 100
const MISSING = new Set();
export async function ensureSchools(ids) {
  const want = [...new Set(ids || [])].filter(id => typeof id === "string" && id && !/[:]/.test(id) && !/^(pd-|bx-)/.test(id) && !S.byId.has(id) && !MISSING.has(id));
  for (let i = 0; i < want.length; i += 100) {
    const chunk = want.slice(i, i + 100), r = await api(`/api/schools/items?ids=${encodeURIComponent(chunk.join(","))}`);
    for (const id of chunk) {
      const s = r?.[id];
      if (!s) { MISSING.add(id); continue; }
      rememberLoose([s]);
      if (s.id !== id && !S.byId.has(id)) S.byId.set(id, S.byId.get(s.id)); // un id viejo: el colegio con su id de ahora
    }
  }
  if (want.length) fire([], "items");
}

// Buscar en los países que no tenés cargados (Prospectar sin país y Ctrl K): hasta 50, con el total. Copia de 60 s por texto.
const OTHER = new Map();
export function searchOther(q) {
  const t = String(q || "").trim(), rest = notLoaded();
  if (!rest.length || t.length < 3) return Promise.resolve(null);
  const k = `${norm(t) || t}|${rest.join(",")}`, hit = OTHER.get(k);
  if (hit && Date.now() - hit.at < 60e3) return hit.p;
  const p = api(`/api/schools/search?q=${encodeURIComponent(t)}&only=${encodeURIComponent(rest.join(","))}`)
    .then(r => ({ q: t, total: r.total || 0, items: r.items || [], countries: rest }));
  p.catch(() => OTHER.delete(k));
  OTHER.set(k, { at: Date.now(), p }); if (OTHER.size > 40) OTHER.delete(OTHER.keys().next().value);
  return p;
}
// abrir un colegio que vino de searchOther: queda suelto en S.byId (su país no se carga entero)
export const keepFound = items => rememberLoose(items);

// Ciudades de toda la base (las cargadas, de lo cargado; el resto, del resumen): { country, city, n, c (normalizada) }.
// Para las sugerencias de Prospectar, «¿lo escrito es una ciudad?» y la ciudad de la base cuando el mapa no responde.
const CITIES = { k: "", list: [] };
export function cityList() {
  const k = `${S.rev}|${S.loaded.size}|${S.schools.length}|${!!S.summary}`;
  if (CITIES.k === k) return CITIES.list;
  const m = new Map();
  for (const s of S.schools) { const key = `${s.country}|${s.city}`; const c = m.get(key); if (c) c.n++; else m.set(key, { country: s.country, city: s.city, n: 1 }); }
  for (const c of S.summary?.countries || []) {
    if (S.loaded.has(c.country)) continue;
    for (const [city, n] of c.cities) m.set(`${c.country}|${city}`, { country: c.country, city, n });
  }
  const list = [...m.values()].filter(c => c.city).map(c => ({ ...c, c: norm(c.city) }));
  CITIES.k = k; CITIES.list = list;
  return list;
}
