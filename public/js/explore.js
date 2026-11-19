// Prospectar: lista por país y ciudad + mapa, con cruce contra Pipedrive y sesión de llamadas.
import { S, api, esc, norm, icon, pill, statusPill, stageTag, potTag, markOf, PH, ST, cssVar, patchSchool, toast, ago, shortDay, scroller, brainStaleMsg, brainTokenCallout, callPill, digits, recentSearches, rememberSearch, forgetSearch, clearSearches, schoolIdx, fmtNum } from "./core.js";
import { tableCsv } from "./chatfmt.js";
import { save as saveFile } from "./chat.js";
import { openSchool, startSession } from "./school.js";
import { baseErrorCallout } from "./app.js";
import { pdSearcher, pdSectionHtml, bindPd, pdNamed, mineBest, openPd, isPhoneQ, isMailQ, PD_MIN, pdLinkOf, isPdLink, openPdLink } from "./pdsearch.js";

const E = S.explore;
// «Para llamar»: todo lo que no es cliente ni está en proceso (incluye los que todavía no se cruzaron con Pipe).
const CALLABLE = ["new", "org", "stalled", "lost", "unk"];
const FILTERS = [["prospect", "Para llamar"], ["pot", "Alto potencial"], ["new", "Nunca contactado"], ["org", "En Pipe sin trato"], ["stalled", "Contactado sin avance"], ["lost", "Perdido"], ["unk", "Sin revisar"], ["open", "En proceso"], ["churn", "Churn"], ["client", "Cliente"], ["archived", "Archivados"], ["all", "Todos"]];
const RANK = { new: 0, org: 1, stalled: 2, lost: 3, unk: 4, open: 5, churn: 6, client: 7, archived: 8 };
// Burbujas de ciudad (styles.css, claro y oscuro): pros = el color de «para llamar» de cada tema, con el número legible (≥ 4,5:1);
// unk = aro hueco (como «sin revisar» en el mapa de colegios); none = gris lleno.
const CITY = { pros: "var(--city-pros)", unk: "var(--city-unk)", none: "var(--city-none)" };
const PAGE = 150;
let host, map, layer, canvas, brainLayer, brainBtn, busy = false, shown = PAGE;
// Capa de clientes de OrderEAT (World Dominion de OrderBrain): prendida por defecto, se recuerda por persona.
let showBrain = (() => { try { return localStorage.getItem("ob.brain") !== "0"; } catch { return true; } })();

// Lo que se calcula para dibujar (la selección, la búsqueda, el orden, cuántos se pueden llamar) se guarda mientras no cambie
// de qué depende: antes cada tecla recorría los 22.000 colegios seis veces y normalizaba cada texto. key = lo que lo define;
// S.rev sube con cada colegio que cambia (core.js) y ref es el lugar ubicado (se compara por identidad).
const MEMO = new Map();
function memo(slot, key, fn, ref = null) {
  const m = MEMO.get(slot), k = `${S.rev}|${S.schools.length}|${key}`;
  if (m && m.k === k && m.ref === ref) return m.v;
  const v = fn(); MEMO.set(slot, { k, ref, v }); return v;
}
const scope = () => memo("scope", `${E.country}|${E.city}`, () => S.schools.filter(s => (!E.country || s.country === E.country) && (!E.city || s.city === E.city)));
// por nombre, ciudad o dirección; un teléfono, por sus dígitos (los últimos 8: con o sin código de país, con o sin espacios).
// El texto de cada colegio ya viene normalizado (schoolIdx de core.js): acá solo se compara.
const searchList = () => memo("search", `${E.country}|${E.q}`, () => {
  const q = norm(E.q), ph = isPhoneQ(E.q) ? digits(E.q) : "", key = ph.slice(-Math.min(ph.length, 8)), c = E.country;
  return S.schools.filter(s => { if (c && s.country !== c) return false; const x = schoolIdx(s); return x.q.includes(q) || (!!key && x.d.includes(key)); });
});
// de otra persona: la organización en Pipedrive tiene otro dueño (cada uno trabaja lo suyo)
export const othersOwn = s => !!(s.ownerId && S.me?.pdUserId && s.ownerId !== S.me.pdUserId);
const mineId = id => !!id && !!S.me?.pdUserId && Number(id) === Number(S.me.pdUserId);
const canCall = s => CALLABLE.includes(s.status) && !othersOwn(s);
const applyFilter = a => E.filter === "prospect" ? a.filter(canCall) : E.filter === "pot" ? a.filter(s => s.pot && canCall(s)) : E.filter === "all" ? a : a.filter(s => s.status === E.filter);
// orden de la lista: alto potencial para llamar, estado, intentos y nombre. Lo que se compara se calcula una vez por colegio
// (no en cada comparación) y el nombre va con un Intl.Collator que se reutiliza (mismo orden que localeCompare, mucho más rápido).
// Devuelve una lista nueva: nunca reordena la que le pasan (puede ser una guardada).
const byName = new Intl.Collator().compare;
// k junta potencial, estado e intentos en un número («Prospecto en Pipe» no está en RANK: va entre «Sin revisar» y «En proceso»).
const sortS = a => a.map(s => ({ s, k: (canCall(s) && s.pot ? 0 : 1e9) + (RANK[s.status] ?? 4.5) * 1e7 + Math.min(s.attempts || 0, 9999999) }))
  .sort((x, y) => x.k - y.k || byName(x.s.name, y.s.name)).map(x => x.s);
// Lugar buscado (país, provincia, ciudad, barrio o dirección): la lista y el mapa muestran solo lo que está ADENTRO
// de su contorno real (o de un círculo chico si el lugar es un punto), del más cercano al más lejano.
const kmTo = (a, b) => { const R = 6371, r = x => x * Math.PI / 180; const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
const center = p => p.kind === "city" && !p.geo ? p.city : { lat: p.lat, lng: p.lng };
function inRing(x, y, ring) { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; }
function inGeo(g, lng, lat) {
  const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
  return polys.some(([outer, ...holes]) => inRing(lng, lat, outer) && !holes.some(h => inRing(lng, lat, h)));
}
const placeMode = () => !!E.place;
// miembros del lugar: se recalcula solo si cambia el lugar o entran colegios nuevos
let pm = { p: null, n: -1, list: [] };
function placeList() {
  const p = E.place; if (!p) return [];
  if (pm.p === p && pm.n === S.schools.length) return pm.list;
  const c = center(p), bb = p.geo && p.bbox;
  const list = [];
  const inCountries = p.kind === "continent" ? new Set(p.countries || []) : null;
  for (const s of S.schools) {
    if (s.lat == null) continue;
    if (inCountries) { if (inCountries.has(s.country)) { s._d = kmTo(s, c); list.push(s); } continue; }
    if (p.geo) {
      const mine = p.areaId && s.area === p.areaId; // lo trajo la búsqueda de este mismo lugar
      if (!mine && bb && (s.lat < bb[0][0] || s.lat > bb[1][0] || s.lng < bb[0][1] || s.lng > bb[1][1])) continue;
      if (!mine && !inGeo(p.geo, s.lng, s.lat)) continue;
      s._d = kmTo(s, c);
    } else { const d = kmTo(s, c); if (d > (p.radius || 3)) continue; s._d = d; }
    list.push(s);
  }
  // primero los de alto potencial que se pueden llamar, después por cercanía
  list.sort((a, b) => (canCall(b) && b.pot ? 1 : 0) - (canCall(a) && a.pot ? 1 : 0) || a._d - b._d);
  pm = { p, n: S.schools.length, list };
  return list;
}
// provincia o país con muchos colegios: se agrupan por ciudad (como la vista general)
const placeGrouped = () => placeMode() && ["country", "region", "continent"].includes(E.place.kind) && placeList().length > 150;
const base = () => placeMode() ? placeList() : E.q ? searchList() : scope();
const selKey = () => `${E.country}|${E.city}|${E.q}|${E.filter}`;
// filtered: lo que pasa el filtro, sin ordenar (para contar y para el mapa); visible: lo mismo en el orden de la lista
const filtered = () => memo("filtered", selKey(), () => applyFilter(base()), E.place);
const visible = () => memo("visible", selKey(), () => placeMode() ? filtered() : sortS(filtered()), E.place);
const callable = () => visible().filter(s => canCall(s) && s.phone);
// cuántos se pueden llamar con y sin teléfono: se cuenta sin ordenar (ordenar 22.000 solo para contar trababa la entrada)
const callStats = () => memo("stats", selKey(), () => { let tel = 0, noTel = 0; for (const s of filtered()) if (canCall(s)) s.phone ? tel++ : noTel++; return { tel, noTel }; }, E.place);
// vista mundial: sin país, ciudad, lugar ni búsqueda (ahí no se arma una sesión: primero se elige dónde)
const worldView = () => !E.country && !E.city && !E.place && !E.q.trim();
const placeName = p => p.kind === "spot" && !p.geo ? p.label.split(",")[0] : p.name || p.label.split(",")[0];
function citiesOf(list) {
  const m = new Map();
  list.forEach(s => { const k = s.country + "|" + s.city; if (!m.has(k)) m.set(k, { country: s.country, city: s.city, items: [] }); m.get(k).items.push(s); });
  return [...m.values()].sort((a, b) => a.country.localeCompare(b.country) || b.items.length - a.items.length);
}
// la selección agrupada por ciudad (vista general, o un país o provincia ubicados): la usan la lista y el mapa
const cityGroups = () => memo("cities", `${E.country}|${E.city}`, () => citiesOf(placeMode() ? placeList() : scope()), E.place);
const fmt = n => fmtNum(n);
const km = d => d < 1 ? `${Math.round(d * 1000)} m` : `${fmtNum(d, { dec: 1 })} km`;

export function renderExplore(el) {
  host = el; map = null; shown = PAGE;
  let off = false; try { off = localStorage.getItem("ob.explore.listOff") === "1"; } catch { /* sin almacenamiento */ }
  el.innerHTML = `<div class="explore${off ? " list-off" : ""}">
    <section class="explore-list" aria-label="Colegios">
      <div class="explore-top">
        <div class="ex-head"><h1>Prospectar</h1><button type="button" class="icon-btn ex-fold" id="listFold" title="Cerrar el panel: más mapa" aria-label="Cerrar el panel de la lista">${icon("chevL")}</button></div>
        <label class="sr" for="q">Buscar colegio, lugar o en Pipedrive</label>
        <form id="qf" class="q-row" role="search"><div class="q-wrap"><input class="inp" id="q" type="search" placeholder="Colegio, lugar, teléfono, email o persona" value="${esc(E.q)}" autocomplete="off" enterkeyhint="search" aria-controls="qHist"><button type="button" class="q-histbtn" id="qHistBtn" title="Búsquedas recientes" aria-label="Búsquedas recientes" aria-controls="qHist">${icon("clock", "sm")}</button><div class="q-hist" id="qHist" role="listbox" aria-label="Búsquedas recientes" hidden></div></div><button type="button" class="btn icon-only" id="locate" title="Ubicar en el mapa" aria-label="Ubicar en el mapa">${icon("nav")}</button></form>
        <div id="placeBox"></div>
        <div class="chips scroll-row" id="countries" role="group" aria-label="País"></div>
        <div class="crumb" id="crumb"></div>
        <div class="chips scroll-row" id="filters" role="group" aria-label="Estado en Pipedrive"></div>
      </div>
      <div class="explore-scroll" id="list" aria-live="polite"></div>
      <div class="explore-foot">
        <button class="btn primary" id="sess"></button>
        <button class="btn icon-only" id="csv" title="Descargar CSV de lo que ves" aria-label="Descargar CSV de lo que ves">${icon("download")}</button>
      </div>
    </section>
    <div class="mapwrap"><div id="map" role="region" aria-label="Mapa de colegios"></div><button type="button" class="btn ex-unfold" id="listUnfold" title="Abrir el panel de la lista" aria-label="Abrir el panel de la lista">${icon("chevR")}<span>Prospectar</span></button></div>
  </div>`;
  el.querySelectorAll(".scroll-row").forEach(scroller);
  // panel de la lista plegable (pedido del líder: «una flechita al lado de Prospectar para cerrar y volver a abrir la solapa»,
  // para ver más mapa); solo con lista y mapa lado a lado (CSS); se recuerda en este navegador
  const fold = on => {
    el.querySelector(".explore").classList.toggle("list-off", on);
    try { localStorage.setItem("ob.explore.listOff", on ? "1" : "0"); } catch { /* sin almacenamiento */ }
    setTimeout(() => { map?.invalidateSize(); (on ? el.querySelector("#listUnfold") : el.querySelector("#listFold"))?.focus(); }, 30);
  };
  el.querySelector("#listFold").onclick = () => fold(true);
  el.querySelector("#listUnfold").onclick = () => fold(false);
  const q = el.querySelector("#q");
  q.oninput = () => {
    // lo escrito queda en el estado en el acto (ninguna tecla se pierde: Enter, la sesión y el CSV leen E.q); la lista y
    // el mapa se redibujan una vez, ≈120 ms después de la última tecla (drawSoon)
    E.q = q.value; E.place = null; locSeq++; shown = PAGE; pdQuery(); drawSoon(); histDraw(); clearTimeout(histT);
    // un link de Pipedrive pegado: se abre su ficha (una vez por link), no se busca como nombre ni como dirección
    if (isPdLink(q.value)) { const k = q.value.trim(); if (k !== lastLink) { lastLink = k; openPdLink(k); } return; }
    histT = setTimeout(() => { if (q.value.trim().length >= 3 && q.value === E.q) rememberSearch(q.value); }, 2500);
  };
  // historial de búsquedas: al tocar el buscador vacío aparecen las últimas; tocarla la vuelve a buscar (un lugar, lo ubica)
  const hist = el.querySelector("#qHist");
  function histDraw(force = false) {
    const list = recentSearches();
    if (!force && document.activeElement === q && q.value.trim()) return sugDraw();
    if (!force && (q.value.trim() || document.activeElement !== q)) { hist.hidden = true; return; }
    SUG.items = [];
    if (!list.length) { hist.innerHTML = `<div class="qh-h"><span>Búsquedas recientes</span></div><p class="qh-empty">Todavía no buscaste nada. Lo que busques (colegios, teléfonos, mails, personas o lugares) va a quedar acá.</p>`; hist.hidden = false; return; }
    hist.innerHTML = `<div class="qh-h"><span>Búsquedas recientes</span><button type="button" class="linkbtn" data-clear>Borrar</button></div>` +
      list.map((x, i) => `<div class="qh-row"><button type="button" class="qh-it" role="option" data-i="${i}">${icon(x.kind === "place" ? "map" : "search", "sm")}<span>${esc(x.t)}</span></button><button type="button" class="icon-btn qh-x" data-x="${i}" aria-label="Sacar «${esc(x.t)}» del historial" title="Sacar">${icon("x", "sm")}</button></div>`).join("");
    hist.hidden = false;
  }
  // Sugerencias mientras escribís (en la misma solapa): lugares (ciudades de la base al instante y de OpenStreetMap con
  // Photon, con su contorno) y colegios de la base. Flechas para elegir, Enter abre la marcada, Esc cierra.
  const SUG = { items: [], sel: -1, t: null, seq: 0, remote: { q: "", places: [], failed: false, loading: false } };
  function sugLocal(t) {
    // con el texto ya normalizado de cada colegio (schoolIdx): una pasada, sin normalizar nada en la comparación del orden
    const f = norm(t), sf = ` ${f}`, words = f.split(" "), sw = words.map(w => ` ${w}`);
    // Los 8 colegios que van (el nombre empieza con lo escrito, del país elegido, el nombre más corto) se eligen en la misma
    // pasada, sin ordenar los miles que coinciden.
    const cities = new Map(), top = [], before = (a, b) => (b.st - a.st) || (b.co - a.co) || (a.len - b.len);
    for (const sc of S.schools) {
      const x = schoolIdx(sc), n = x.n;
      if (x.c && (x.c.startsWith(f) || x.c.includes(sf))) { const k = `${sc.country}|${sc.city}`; const c = cities.get(k) || cities.set(k, { city: sc.city, country: sc.country, n: 0, c: x.c }).get(k); c.n++; }
      if (!(words.every((w, i) => n.startsWith(w) || n.includes(sw[i])) || n.includes(f))) continue;
      const e = { sc, st: n.startsWith(f) ? 1 : 0, co: sc.country === E.country ? 1 : 0, len: sc.name.length };
      if (top.length === 8 && before(e, top[7]) >= 0) continue;
      let i = top.length; while (i > 0 && before(e, top[i - 1]) < 0) i--;
      top.splice(i, 0, e); if (top.length > 8) top.pop();
    }
    const schools = top.map(e => e.sc);
    // primero la ciudad que coincide con lo escrito («Puebla» = «Puebla de Zaragoza»): es la que queda marcada para Enter
    return { cities: [...cities.values()].sort((a, b) => (cityHit(b.c, f) - cityHit(a.c, f)) || (b.c.startsWith(f) - a.c.startsWith(f)) || ((b.country === E.country) - (a.country === E.country)) || b.n - a.n).slice(0, 4), schools };
  }
  function sugFetch(t) {
    clearTimeout(SUG.t); const my = ++SUG.seq;
    if (SUG.remote.q === t) return;
    SUG.remote = { q: t, places: [], failed: false, loading: true };
    SUG.t = setTimeout(async () => {
      try { const r = await api(`/api/places/suggest?q=${encodeURIComponent(t)}&cc=${encodeURIComponent(S.markets[E.country]?.code || "")}`); if (my !== SUG.seq) return; SUG.remote = { q: t, places: r.places || [], failed: !!r.failed, loading: false }; }
      catch { if (my !== SUG.seq) return; SUG.remote = { q: t, places: [], failed: true, loading: false }; }
      if (document.activeElement === q && q.value.trim() === t) sugDraw();
    }, 220);
  }
  function sugDraw() {
    const t = q.value.trim();
    if (t.length < 2 || isPhoneQ(t) || isMailQ(t) || isPdLink(t)) { hist.hidden = true; SUG.items = []; return; }
    const fresh = t !== SUG.lastT;
    if (fresh) { SUG.sel = -1; SUG.lastT = t; }
    sugFetch(t);
    const loc = sugLocal(t), rem = SUG.remote.q === t ? SUG.remote : { places: [], loading: true };
    // la primera sugerencia es una ciudad de la base que coincide con lo escrito: queda marcada y Enter la usa (antes Enter
    // salía a buscar «Puebla» a OpenStreetMap teniendo «Puebla de Zaragoza · 95 colegios» a la vista)
    if (fresh && loc.cities[0] && cityHit(loc.cities[0].c, norm(t))) SUG.sel = 0;
    const items = [], seen = new Set(loc.cities.map(c => norm(`${c.city} ${S.markets[c.country]?.code || ""}`)));
    const row = (i, ic, title, sub) => `<div class="qh-row${i === SUG.sel ? " on" : ""}"><button type="button" class="qh-it" role="option" aria-selected="${i === SUG.sel}" data-s="${i}">${icon(ic, "sm")}<span class="qs-t"><b>${esc(title)}</b>${sub ? `<small>${esc(sub)}</small>` : ""}</span></button></div>`;
    let html = "";
    const places = [...loc.cities.map(c => ({ kind: "city", ...c })), ...rem.places.filter(p => !seen.has(norm(`${p.name} ${p.cc}`))).map(p => ({ kind: "osm", ...p }))].slice(0, 10);
    if (places.length || rem.loading) {
      html += `<div class="qh-h"><span>Lugares</span>${rem.loading ? `<span class="spin" aria-label="Buscando lugares"></span>` : ""}</div>`;
      for (const p of places) { const i = items.push(p) - 1; html += p.kind === "city" ? row(i, "map", p.city, `${p.country} · ${fmt(p.n)} colegio${p.n === 1 ? "" : "s"} en la base`) : row(i, "nav", p.name, [p.kind && p.kind !== "Lugar" ? p.kind : "", p.sub].filter(Boolean).join(" · ")); }
    }
    if (loc.schools.length) {
      html += `<div class="qh-h"><span>Colegios</span></div>`;
      for (const sc of loc.schools) { const i = items.push({ kind: "school", s: sc }) - 1; html += row(i, "building", sc.name, [sc.city, sc.country, ST[sc.status]?.l].filter(Boolean).join(" · ")); }
    }
    if (rem.failed && !places.length) html += `<p class="qh-empty">No pude traer lugares de OpenStreetMap: con Enter igual lo busco.</p>`;
    html += `<div class="qh-row"><button type="button" class="qh-it" data-go>${icon("search", "sm")}<span>Buscar «${esc(t)}»</span></button></div>`;
    SUG.items = items; if (SUG.sel >= items.length) SUG.sel = -1;
    hist.innerHTML = html; hist.hidden = false;
  }
  function sugPick(i) {
    const x = SUG.items[i]; if (!x) return false;
    hist.hidden = true; SUG.sel = -1; drawNow(); // la lista queda con lo escrito mientras se ubica el lugar
    if (x.kind === "school") { if (q.value.trim().length >= 2) rememberSearch(q.value); openSchool(x.s.id); return true; }
    const label = x.kind === "city" ? `${x.city}, ${x.country}` : x.label;
    q.value = label; E.q = label; rememberSearch(label, "place");
    // una ciudad de la base: si el contorno no llega, igual se muestran sus colegios (locate → openCity)
    locate(label, x.kind === "osm" ? { osm: x.osm } : { city: x });
    return true;
  }
  q.addEventListener("keydown", e => {
    if (hist.hidden || !SUG.items.length || !q.value.trim()) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); const n = SUG.items.length; SUG.sel = e.key === "ArrowDown" ? (SUG.sel + 1) % n : (SUG.sel <= 0 ? n - 1 : SUG.sel - 1); sugDraw(); hist.querySelector(".qh-row.on")?.scrollIntoView({ block: "nearest" }); }
    else if (e.key === "Enter" && SUG.sel >= 0) { e.preventDefault(); sugPick(SUG.sel); }
  });
  q.addEventListener("focus", () => histDraw());
  q.addEventListener("click", () => histDraw());
  const hb = el.querySelector("#qHistBtn");
  hb.addEventListener("mousedown", e => e.preventDefault());
  hb.addEventListener("click", () => { if (!hist.hidden) { hist.hidden = true; return; } q.focus(); histDraw(true); });
  q.addEventListener("blur", () => setTimeout(() => { if (!hist.contains(document.activeElement) && document.activeElement !== hb) hist.hidden = true; }, 150));
  q.addEventListener("keydown", e => { if (e.key === "Escape") hist.hidden = true; });
  hist.addEventListener("mousedown", e => e.preventDefault()); // que el input no pierda el foco al tocar una
  hist.addEventListener("click", e => {
    const list = recentSearches(), b = e.target.closest("button"); if (!b) return;
    if (b.dataset.s != null) return sugPick(+b.dataset.s);
    if (b.dataset.go != null) { hist.hidden = true; return el.querySelector("#qf").requestSubmit(); }
    if (b.dataset.clear != null) { clearSearches(); histDraw(true); return; }
    if (b.dataset.x != null) { forgetSearch(list[+b.dataset.x]?.t); histDraw(true); return; }
    const x = list[+b.dataset.i]; if (!x) return;
    hist.hidden = true; q.value = x.t; rememberSearch(x.t, x.kind);
    if (x.kind === "place") return locate(x.t);
    q.dispatchEvent(new Event("input"));
  });
  // Enter: un teléfono o un email se quedan en la lista (colegios y Pipedrive). Un lugar conocido (con coma, o una ciudad o
  // un país de la base) se ubica en el mapa. Si no, se queda en la lista si coincide con colegios de la base o si en
  // Pipedrive hay algo que se llama así (pdNamed: el nombre empieza con lo escrito, o una persona); si no, se ubica
  // («Metepec» se ubica aunque en Pipedrive esté «Nook Junior School Metepec»). El botón de la flecha siempre ubica.
  el.querySelector("#qf").onsubmit = async e => {
    e.preventDefault(); const t = q.value; hist.hidden = true; drawNow();
    if (!t.trim()) return locate(t);
    if (isPdLink(t)) return openPdLink(t);
    rememberSearch(t);
    if (isPhoneQ(t) || isMailQ(t)) return;
    if (looksLikePlace(t)) return locate(t, { city: baseCity(t) });
    const list = searchList(), st = await PDS.done; // lo que encontró Pipedrive con lo escrito (espera si todavía está buscando)
    if (E.q !== t || E.place) return;
    // lo TUYO de Pipedrive primero (pedido del líder: «que Enter vaya a lo mío de Pipedrive»): si ningún colegio de la lista
    // es tuyo y en Pipedrive hay algo tuyo que se llama así (mineBest: el prospecto primero), Enter lo abre
    const mine = !list.some(s => mineId(s.ownerId)) && mineBest(st?.data, t, mineId);
    if (mine) return openPd(mine);
    if (list.length || pdNamed(st?.data, t)) return;
    locate(t);
  };
  el.querySelector("#locate").onclick = () => locate(q.value, { city: baseCity(q.value) });
  // abrir un resultado de Pipedrive (o su enlace) con algo escrito también lo guarda en el historial
  el.addEventListener("click", e => { if (e.target.closest("[data-pdi], .pd-ext") && E.q.trim().length >= 2) rememberSearch(E.q); }, true);
  el.querySelector("#sess").onclick = () => {
    drawNow(); if (worldView()) return;
    const ids = callable().map(s => s.id); // startSession toma los primeros S.sessionMax y lo avisa
    const where = E.city || (E.place && placeName(E.place)) || E.country || "selección", list = FILTERS.find(([k]) => k === E.filter)?.[1] || "";
    if (ids.length) startSession(ids, where, { origin: { kind: "explore", key: `explore:${norm(where)}:${E.filter}:${norm(E.q)}`, filters: { lugar: where, lista: list, buscar: E.q || "" } } });
  };
  el.querySelector("#csv").onclick = () => { drawNow(); csv(); };
  initMap();
  drawAll();
  if (E.pendingLocate) { const t = E.pendingLocate; E.pendingLocate = null; q.value = t; locate(t, { city: baseCity(t) }); }
  else if (E.q) pdQuery(); // volviste a Prospectar con una búsqueda: lo de Pipedrive se trae de nuevo (o de la copia de 60 s)
}

// ---------- también en Pipedrive: con cualquier búsqueda (aunque sea el nombre de una ciudad: «Rosario», «León» también son
// personas), mientras no se ubicó un lugar, debajo de los colegios de la base va la sección «En Pipedrive» (personas,
// organizaciones, prospectos y tratos de toda la cuenta, en vivo, con «Ver más» por grupo). Si Pipedrive falla, un aviso.
const PDS = pdSearcher();
const pdOn = () => !E.place && E.q.trim().length >= PD_MIN && !isPdLink(E.q);
let lastLink = "";
function pdQuery() {
  if (!pdOn()) { PDS.cancel(); E.pd = null; drawPd(); return; }
  PDS.run(E.q, st => { E.pd = st; drawPd(); });
}
const pdRetry = () => { PDS.cancel(); pdQuery(); };
const pdJumpLabel = () => { const st = E.pd, d = st?.state === "ok" ? st.data : null; return `En Pipedrive${d ? `: ${fmt(d.total ?? 0)}${d.more ? "+" : ""}` : st?.state === "loading" ? "…" : ""}`; };
function drawPd() {
  const box = host?.isConnected && host.querySelector("#pdBox"); if (!box) return;
  const jump = host.querySelector("#pdJump"); if (jump) jump.innerHTML = `${pdJumpLabel()} ${icon("chevDown", "sm")}`;
  box.innerHTML = pdSectionHtml(E.pd);
  bindPd(box, E.pd, pdRetry, drawPd);
  // viniste de «Ver todo en Prospectar» (búsqueda rápida): cuando llega, se baja hasta lo de Pipedrive
  if (E.pdScroll && E.pd?.state !== "loading") { E.pdScroll = false; if (E.pd) requestAnimationFrame(toPd); }
}
// Bajar hasta la sección de Pipedrive sin que quede tapada: en celular la barra de búsqueda queda fija arriba (sticky),
// así que el margen es su alto.
function toPd() {
  const box = host?.isConnected && host.querySelector("#pdBox"); if (!box) return;
  const top = host.querySelector(".explore-top"), fixed = top && getComputedStyle(top).position === "sticky" ? top.getBoundingClientRect().height : 0;
  box.style.scrollMarginTop = `${Math.ceil(fixed) + 8}px`;
  box.scrollIntoView({ behavior: "smooth", block: "start" });
}

// Al cambiar de ciudad, país, filtro o búsqueda, la lista vuelve arriba (en celular scrollea .explore-list; si no, .explore-scroll).
const toTop = () => { for (const sel of [".explore-scroll", ".explore-list"]) { const n = host.querySelector(sel); if (n) n.scrollTop = 0; } };
// lazyMap (al escribir): primero la lista; el mapa (miles de marcas con una búsqueda amplia) va un momento después y se
// cancela si llega otra tecla
let drawT = 0, mapT = 0;
function drawAll({ fit = true, lazyMap = false } = {}) {
  clearTimeout(drawT); clearTimeout(mapT); drawT = mapT = 0;
  host.querySelector(".explore")?.classList.toggle("focused", !!(E.city || E.q || E.place));
  drawCountries(); drawPlace(); drawCrumb(); drawFilters(); drawList(); drawFoot();
  if (!lazyMap) return drawMap({ fit });
  const n = filtered().length; // con miles de marcas el mapa tarda: se espera más a que termines de escribir
  mapT = setTimeout(() => { mapT = 0; if (host?.isConnected) drawMap({ fit }); }, n > 5000 ? 450 : n > 1500 ? 220 : 40);
}
// Al escribir: se espera ≈120 ms desde la última tecla y se redibuja una vez (lo escrito ya está en E.q).
function drawSoon() {
  clearTimeout(drawT); clearTimeout(mapT); mapT = 0;
  drawT = setTimeout(() => { drawT = 0; if (!host?.isConnected) return; drawAll({ lazyMap: true }); toTop(); }, 120);
}
// si quedó un redibujo esperando (recién se escribió), se hace ya: lo que se toca después tiene que ver lo último
function drawNow() { if (drawT && host?.isConnected) { drawAll(); toTop(); } }

// ---------- ubicar en el mapa
// ¿lo escrito es un lugar? «Puebla», «México, Puebla», «Palermo, Buenos Aires»: con coma, o igual a una ciudad o un país
// de la base («Puebla» también es «Puebla de Zaragoza»), o una dirección («Calle Bugambilias 47», «Col. Centro»).
// Entonces Enter ubica y contornea en vez de buscar por nombre.
let CITY_SET = null;
const ADDRESS_RE = /^\s*(calle|c\.|av\.?|avda\.?|avenida|blvd\.?|blvrd\.?|boulevard|bulevar|calz\.?|calzada|carrera|cra\.?|cl+\.?|diagonal|transversal|jr\.?|jir[oó]n|pasaje|camino|privada|prolongaci[oó]n|paseo|eje|perif[eé]rico|circuito|cerrada|andador|ruta)\s+\S.*\d|\b(col\.|colonia|fracc\.|c\.\s?p\.)\s*\S/i;
function looksLikePlace(text) {
  const t = norm(text); if (!t) return false;
  if (/,/.test(text) || ADDRESS_RE.test(text)) return true;
  CITY_SET ||= new Set(S.schools.map(x => norm(x.city)).filter(Boolean));
  return S.countries.some(c => norm(c) === t) || CITY_SET.has(t) || [...CITY_SET].some(c => c.startsWith(t + " de "));
}
// «México, Puebla» → busca «Puebla» en México (el país se usa para elegir, no como parte del nombre)
function splitCountry(text) {
  const parts = String(text).split(",").map(x => x.trim()).filter(Boolean);
  const i = parts.findIndex(x => S.countries.some(c => norm(c) === norm(x)));
  if (i < 0 || parts.length < 2) return { q: text, cc: "" };
  const c = S.countries.find(c => norm(c) === norm(parts[i]));
  return { q: parts.filter((_, j) => j !== i).join(", "), cc: S.markets[c]?.code || "" };
}
// ¿la ciudad (normalizada) es lo que se escribió? Igual, o «Puebla» por «Puebla de Zaragoza» (la misma regla que looksLikePlace)
const cityHit = (c, f) => f.length >= 3 && (c === f || c.startsWith(f + " de "));
// la ciudad de la base que coincide con lo escrito («Puebla», «Puebla, México»): primero la del país elegido, después la
// que más colegios tiene. null si ninguna.
function baseCity(text) {
  const sc = splitCountry(text), f = norm(sc.q); if (f.length < 3) return null;
  const m = new Map();
  for (const s of S.schools) {
    const c = schoolIdx(s).c; if (!cityHit(c, f) || (sc.cc && S.markets[s.country]?.code !== sc.cc)) continue;
    const k = `${s.country}|${s.city}`, x = m.get(k) || m.set(k, { city: s.city, country: s.country, n: 0 }).get(k); x.n++;
  }
  return [...m.values()].sort((a, b) => ((b.country === E.country) - (a.country === E.country)) || b.n - a.n)[0] || null;
}
let locSeq = 0;
let histT = null;
// city: la ciudad de la base que se eligió o que coincide ({ city, country }): si el lugar no se puede ubicar (OpenStreetMap
// no responde o no lo encuentra), se muestran igual sus colegios en vez de un error.
async function locate(text, { osm, city } = {}) {
  text = String(text || "").trim(); if (!osm && text.length < 2) return;
  drawNow(); // si recién se escribió, primero la lista al día (si no, el redibujo pendiente borraría el «Ubicando…»)
  const seq = ++locSeq, box = host.querySelector("#placeBox");
  box.innerHTML = `<p class="muted place-msg"><span class="spin"></span> Ubicando «${esc(text)}»…</p>`;
  try {
    const sc = splitCountry(text);
    // hard: el país lo escribió la persona; si no, el chip elegido solo da prioridad (si el texto dice otro país, manda el texto)
    const place = await api("/api/scan/resolve", { body: osm ? { osm } : { q: sc.q, cc: sc.cc || S.markets[E.country]?.code || "", hard: !!sc.cc } });
    // si mientras tanto escribió otra cosa o pidió otro lugar, esta respuesta ya no sirve
    if (!host.isConnected || seq !== locSeq) return;
    E.place = place; E.q = ""; E.city = null; E.filter = "prospect"; shown = PAGE; host.querySelector("#q").value = ""; PDS.cancel(); E.pd = null;
    if (!osm) rememberSearch(text, "place");
    // el país del lugar (o «Todos» si no hay colegios de ese país), aunque el chip dijera otro
    E.country = S.countries.includes(place.country) ? place.country : null;
    drawAll(); toTop();
  } catch (e) {
    if (seq !== locSeq) return;
    if (city && S.schools.some(s => s.country === city.country && s.city === city.city)) {
      const n = S.schools.filter(s => s.country === city.country && s.city === city.city).length;
      box.innerHTML = ""; openCity(city.country, city.city);
      toast(`No pude traer el contorno de ${city.city}: te muestro ${n === 1 ? "el colegio" : `los ${fmt(n)} colegios`} que la base tiene ahí.`, { type: "info" });
      return;
    }
    // no se encontró, pero el texto dice otro país que el chip («…, Pue.» con «Ecuador» elegido): la lista deja de decir «en Ecuador»
    const c = e.data?.country;
    if (c && E.country && c !== E.country) { E.country = S.countries.includes(c) ? c : null; drawCountries(); drawList(); drawMap(); }
    box.innerHTML = `<div class="callout err place-msg">${icon("alert")}<span>${esc(e.message)}</span></div>`;
  }
}
function drawPlace() {
  const box = host.querySelector("#placeBox"), p = E.place;
  if (!p) { box.innerHTML = ""; return; }
  const n = placeList().length;
  const where = p.kind === "continent" ? `en ${fmt((p.countries || []).length)} país${(p.countries || []).length === 1 ? "" : "es"}` : p.geo ? `en ${esc(placeName(p))}` : `a menos de ${fmtNum(p.radius || 3, { dec: Number.isInteger(p.radius || 3) ? 0 : 1 })} km`;
  // found: qué encontró la búsqueda de una dirección (el número, la calle, la colonia, el código postal o la ciudad)
  const col = p.cc === "MX" ? "Colonia" : "Barrio";
  const kind = { house: "Dirección", near: "Dirección aproximada", corner: "Cruce de calles", street: "Calle", colonia: col, postcode: "Código postal", city: "Ciudad", region: "Provincia o estado" }[p.found]
    || { continent: "Región del mundo", country: "País", region: "Provincia o estado", city: "Ciudad", spot: p.geo || /suburb|neighbourhood|quarter|city_district|borough/.test(p.type || "") ? "Barrio" : /road|street|highway/.test(p.type || "") ? "Calle" : "Dirección" }[p.kind] || "";
  box.innerHTML = `<div class="place-card"><span class="pin">${icon("nav", "sm")}</span><div class="t"><b title="${esc(p.label)}">${esc(p.label)}</b><small>${kind ? `${kind} · ` : ""}${fmt(n)} colegio${n === 1 ? "" : "s"} ${where}</small></div>
    <button class="btn sm" id="pScan" title="Buscar colegios privados nuevos en esta zona y verificarlos">${icon("refresh", "sm")} ${n ? "Buscar más" : "Buscar colegios"}</button><button class="icon-btn" id="pX" aria-label="Quitar ubicación">${icon("x")}</button>
    ${p.note ? `<p class="place-note">${esc(p.note)}</p>` : ""}</div>
    ${p.alts?.length ? `<div class="place-alts"><span class="faint">¿Buscabas otro?</span>${p.alts.map(a => `<button class="chip sm" data-osm="${esc(a.osm)}">${esc(a.label)}</button>`).join("")}</div>` : ""}`;
  box.querySelector("#pX").onclick = () => { E.place = null; locSeq++; drawAll(); };
  box.querySelector("#pScan").onclick = () => import("./scan.js").then(m => m.scanPlace(p));
  box.querySelectorAll("[data-osm]").forEach(b => b.onclick = () => locate(b.textContent, { osm: b.dataset.osm }));
}
function drawCountries() {
  const c = host.querySelector("#countries");
  c.innerHTML = [["", "Todos"], ...S.countries.map(x => [x, x])].map(([k, l]) => `<button class="chip" data-c="${esc(k)}" aria-pressed="${(E.country || "") === k}">${esc(l)}</button>`).join("");
  c.querySelectorAll("button").forEach(b => b.onclick = () => { E.country = b.dataset.c || null; E.city = null; E.place = null; locSeq++; shown = PAGE; drawAll(); toTop(); });
}
function drawCrumb() {
  const c = host.querySelector("#crumb");
  if (!E.city || E.q || E.place) { c.innerHTML = ""; return; }
  c.innerHTML = `<button id="cb">${icon("arrowLeft", "sm")} Ciudades</button><span>${esc(E.city)}</span>`;
  c.querySelector("#cb").onclick = () => { E.city = null; locSeq++; shown = PAGE; drawAll(); };
}
function drawFilters() {
  const f = host.querySelector("#filters");
  const b = base();
  if ((!E.city && !E.q && !placeMode()) || !b.length || placeGrouped()) { f.innerHTML = ""; return; }
  const cnt = {}, marks = {}, col = {}; // marks: por estado, cómo se ven en el mapa (la fase manda: «Cliente» puede ser Activo, Cerrado…)
  // se agrupan por color real y forma (churn de estado y de fase son la misma marca)
  b.forEach(s => { cnt[s.status] = (cnt[s.status] || 0) + 1; const m = markOf(s), id = (col[m.c] ??= cssVar(m.c)) + m.sh, g = marks[s.status] ||= new Map(); g.set(id, { m, n: (g.get(id)?.n || 0) + 1 }); });
  cnt.prospect = b.filter(canCall).length; cnt.all = b.length; cnt.pot = b.filter(s => s.pot && canCall(s)).length;
  // el puntito del filtro es el mismo del mapa; si el grupo se ve de varias formas o colores, van los que hay (hasta 3, el más común primero)
  const dots = k => { const ms = [...(marks[k]?.values() || [])].sort((x, y) => y.n - x.n).slice(0, 3); return ms.length ? `<span class="sdots" aria-hidden="true">${ms.map(({ m }) => `<span class="sdot sh-${m.sh}" style="--pd:var(${m.c});background:var(--pd)"></span>`).join("")}</span>` : ""; };
  f.innerHTML = FILTERS.filter(([k]) => k === "prospect" || k === "all" || cnt[k]).map(([k, l]) => `<button class="chip" data-f="${k}" aria-pressed="${E.filter === k}">${ST[k] ? dots(k) : ""}${l} <b>${fmt(cnt[k] || 0)}</b></button>`).join("");
  f.querySelectorAll("button").forEach(b => b.onclick = () => { E.filter = b.dataset.f; shown = PAGE; drawAll(); toTop(); });
}
// Horario de oficina de un colegio para llamar (la pastilla del reloj). Depende solo del país y, donde hay varios husos, de
// la ciudad: se arma una vez por lugar en cada dibujo, no una vez por fila.
let cwMemo = new Map();
function cwPill(s) {
  if (!CALLABLE.includes(s.status) || othersOwn(s) || s.phase) return "";
  const m = S.markets[s.country], k = !m ? "" : m.husos ? `${s.country}|${s.city}|${typeof s.lng === "number" && s.lng >= m.husoLng?.[0] && s.lng <= m.husoLng?.[1]}` : s.country;
  let h = cwMemo.get(k); if (h === undefined) cwMemo.set(k, h = callPill(s));
  return h;
}
// Lo que se repetía igual en todas las filas («oficina abre mañana 8:00», «Sin revisar») va una sola vez en el encabezado.
// cw: el horario, si es el mismo en todas las filas que lo muestran; st: el estado, si todas tienen el mismo (y ninguna
// lleva otra etiqueta: fase o «De X»).
function sameFor(list) {
  const out = { cw: "", st: "" }; if (list.length < 2) return out;
  let cw = null, n = 0;
  for (const s of list) { const p = cwPill(s); if (!p) continue; if (cw === null) cw = p; else if (p !== cw) { cw = ""; break; } n++; }
  if (cw && n > 1) out.cw = cw;
  const st = list[0].status, single = E.filter !== "prospect" && E.filter !== "all";
  if (!single && ST[st] && list.every(s => s.status === st && !s.phase && !(othersOwn(s) && CALLABLE.includes(s.status)))) out.st = st;
  return out;
}
function schoolRow(s, same = {}) {
  // el subtítulo dice lo que la pastilla no: ciudad, último contacto o motivo de pérdida, intentos, teléfono
  const bits = [];
  if (placeMode() && s._d != null) bits.push(km(s._d));
  if (!E.city) bits.push(s.city);
  if (s.lastTouch) bits.push(`${s.lastTouch.outcome} ${ago(s.lastTouch.at)}`);
  else if (s.ob?.churn) bits.push(/activo|^churn$/i.test(s.ob.label) ? "ex cliente OrderEAT" : "firmó y no arrancó");
  else if (s.status === "lost" && s.detail) bits.push(s.detail.replace(/^Perdido \d{4}-\d{2}-\d{2}( · )?/, "") || "Perdido");
  else if (s.status === "stalled" && s.detail) bits.push(s.detail.replace(/^Contactado \d{4}-\d{2}-\d{2}, sin avance( · )?/, "") || "sin avance");
  if (s.attempts) bits.push(`${s.attempts} intento${s.attempts > 1 ? "s" : ""}`);
  if (!s.phone) bits.push("sin teléfono");
  const single = same.st || (E.filter !== "prospect" && E.filter !== "all");
  return `<button class="school-row" data-id="${esc(s.id)}"><span class="t"><b>${esc(s.name)}${stageTag(s) ? ` ${stageTag(s)}` : ""}${canCall(s) && potTag(s) ? ` ${potTag(s)}` : ""}</b>${bits.length ? `<small>${esc(bits.join(" · "))}</small>` : ""}${same.cw ? "" : cwPill(s)}</span>${othersOwn(s) && CALLABLE.includes(s.status) ? `<span class="pill owner" title="Su organización en Pipedrive es de ${esc(s.ownerName || "otra persona")}">De ${esc((s.ownerName || "otra persona").split(" ")[0])}</span>` : single && !s.phase ? `<span class="sdot sh-${ST[s.status].sh}" title="${ST[s.status].l}" style="--pd:var(${ST[s.status].c});background:var(--pd)"></span>` : statusPill(s)}</button>`;
}
function checkCallout(list) {
  const unk = list.filter(s => s.status === "unk").length;
  if (!unk || !(E.city || E.country || E.q || E.place)) return "";
  return `<div class="callout info check">${icon("refresh")}<span id="prog">${busy ? `<span class="spin"></span> Revisando en Pipedrive…` : `${fmt(unk)} sin revisar en Pipedrive: revisalos para descartar clientes y tratos abiertos.`}</span>${busy ? "" : `<button class="btn sm" id="check">Revisar</button>`}</div>`;
}
function drawList() {
  const L = host.querySelector("#list");
  if (!S.schools.length) {
    L.innerHTML = S.baseError ? `<div style="padding:12px 6px">${baseErrorCallout()}</div>` : '<div class="skel" style="margin:16px 10px"></div>'.repeat(6);
    return;
  }
  if ((!E.city && !E.q && !placeMode()) || placeGrouped()) {
    const list = placeMode() ? placeList() : scope(), cs = cityGroups();
    L.innerHTML = noticeTab(brainWarn() + checkCallout(list)) + `<div class="list-h"><span>${fmt(cs.length)} ciudad${cs.length === 1 ? "" : "es"} · ${fmt(list.length)} colegio${list.length === 1 ? "" : "s"}</span></div>` + cs.map(c => {
      // la barrita usa los mismos colores que el mapa (la fase manda sobre el estado), en el orden de las referencias
      const n = c.items.length, k = {}; c.items.forEach(s => { const m = markOf(s); (k[m.k] ||= { m, n: 0 }).n++; });
      const pros = c.items.filter(canCall).length;
      const allUnk = k.unk?.n === n;
      return `<button class="city-row" data-city="${esc(c.city)}" data-country="${esc(c.country)}"><span class="t"><b>${esc(c.city)}</b><small>${E.country || placeMode() ? "" : esc(c.country) + " · "}${fmt(n)} colegios · ${fmt(pros)} para llamar</small>${allUnk ? "" : `<span class="bar" aria-hidden="true">${LEG.map(x => k[x] ? `<span data-st="${x}" style="width:${k[x].n / n * 100}%;background:var(${k[x].m.c})"></span>` : "").join("")}</span>`}</span>${allUnk ? `<span class="tag">Sin revisar</span>` : icon("arrowRight", "faint")}</button>`;
    }).join("");
    L.querySelectorAll("[data-city]").forEach(b => b.onclick = () => openCity(b.dataset.country, b.dataset.city));
    bindCheck(); return;
  }
  cwMemo = new Map();
  const a = visible(), bl = base(), same = sameFor(a);
  // «106 colegios · todos [Sin revisar]» y, al lado, el horario de oficina (uno para toda la lista)
  const sameSt = same.st ? ` · ${a.length === 2 ? "los dos" : "todos"} ${pill(same.st)}` : "", sameCw = same.cw ? `<span class="list-same">${same.cw}</span>` : "";
  // hay coincidencias pero el filtro las oculta: decir por qué (clientes, en proceso…) en vez de «no hay nada»
  const why = () => { const c = {}; bl.forEach(s => { c[s.status] = (c[s.status] || 0) + 1; }); return Object.entries(c).map(([k, v]) => `${fmt(v)} ${k === "client" ? `cliente${v > 1 ? "s" : ""} de OrderEAT` : ST[k].l.toLowerCase()}`).join(", "); };
  const empty = bl.length
    ? `<div class="empty">${icon("list")}<span>${bl.length === 1 ? `«${esc(bl[0].name)}» no está` : `${fmt(bl.length)} coinciden pero no están`} en «${esc(FILTERS.find(f => f[0] === E.filter)?.[1] || "")}»: ${esc(why())}.</span><button class="btn sm" id="fAll">Ver ${bl.length === 1 ? "el colegio" : "todos"}</button></div>`
    : placeMode()
    ? `<div class="empty">${icon("nav")}<span>Todavía no hay colegios cargados en ${esc(placeName(E.place))}.</span><button class="btn primary sm" id="nearScan">${icon("refresh", "sm")} Buscar colegios acá</button></div>`
    : E.q && pdLinkOf(E.q)
    // un link de Pipedrive no es un nombre: nunca «no hay nada», se abre su ficha
    ? (l => `<div class="empty">${icon("external")}<span>${l.kind === "other" ? "Es un link de Pipedrive que no reconozco." : `Es el link de un${l.kind === "organization" || l.kind === "person" ? "a" : ""} ${esc(l.label)} de Pipedrive.`}</span><button class="btn primary sm" id="openLink">${icon("arrowRight", "sm")} ${l.kind === "other" ? "Abrir en Pipedrive" : `Abrir su ficha`}</button></div>`)(pdLinkOf(E.q))
    : E.q
    // «del mapa»: son los colegios de la app; lo que hay en Pipedrive va abajo (no quiere decir que no exista)
    ? `<div class="empty${pdOn() ? " compact" : ""}">${icon("search")}<span>Ningún colegio del mapa coincide con «${esc(E.q)}»${E.country ? ` en ${esc(E.country)}` : ""}.${pdOn() ? " Abajo, lo que hay en Pipedrive." : ""}</span>${isPhoneQ(E.q) || isMailQ(E.q) ? "" : `<button class="btn ${pdOn() ? "" : "primary "}sm" id="loc">${icon("nav", "sm")} Ubicar «${esc(E.q)}» en el mapa</button>`}${E.country ? `<button class="btn sm" id="allC">Buscar en todos los países</button>` : ""}</div>`
    : `<div class="empty">${icon("list")}<span>Nada con este filtro.</span><button class="btn sm" id="fAll">Ver todos</button></div>`;
  L.innerHTML = noticeTab(brainWarn() + checkCallout(bl)) + `<div class="list-h"><span>${fmt(a.length)} colegio${a.length === 1 ? "" : "s"}${E.q && pdOn() ? " del mapa" : ""}${sameSt}</span>${sameCw}${E.q && pdOn() && a.length > 3 ? `<button class="btn ghost sm pd-jump" id="pdJump">${pdJumpLabel()} ${icon("chevDown", "sm")}</button>` : ""}</div>`
    + (a.length ? a.slice(0, shown).map(s => schoolRow(s, same)).join("") + (a.length > shown ? `<button class="btn ghost sm block" id="moreS">Ver ${fmt(Math.min(PAGE, a.length - shown))} más</button>` : "") : empty)
    + (E.q && !placeMode() && !isPdLink(E.q) ? `<div id="pdBox" class="pd-box">${pdSectionHtml(E.pd)}</div>` : "");
  if (E.q && !placeMode() && !isPdLink(E.q)) bindPd(L.querySelector("#pdBox"), E.pd, pdRetry, drawPd);
  // con muchos colegios, lo de Pipedrive queda abajo: este botón lleva hasta ahí
  L.querySelector("#pdJump")?.addEventListener("click", toPd);
  L.querySelector("#allC")?.addEventListener("click", () => { E.country = null; drawAll(); });
  L.querySelector("#loc")?.addEventListener("click", () => locate(E.q));
  L.querySelector("#openLink")?.addEventListener("click", () => openPdLink(E.q));
  L.querySelector("#nearScan")?.addEventListener("click", () => import("./scan.js").then(m => m.scanPlace(E.place)));
  L.querySelector("#clr")?.addEventListener("click", () => { E.q = ""; host.querySelector("#q").value = ""; drawAll(); });
  L.querySelector("#fAll")?.addEventListener("click", () => { E.filter = "all"; drawAll(); });
  L.querySelector("#moreS")?.addEventListener("click", () => { shown += PAGE; drawList(); });
  // abrir un resultado de lo que escribiste también lo guarda en el historial de búsquedas
  L.querySelectorAll(".school-row[data-id]").forEach(b => b.onclick = () => { if (E.q.trim().length >= 2) rememberSearch(E.q); openSchool(b.dataset.id); });
  bindCheck();
}
function bindCheck() { host.querySelector("#check")?.addEventListener("click", checkScope); }
function drawFoot() {
  const b = host.querySelector("#sess"), max = S.sessionMax || 300;
  host.querySelector("#csv").disabled = !S.schools.length;
  // vista mundial (sin país, ciudad, lugar ni búsqueda): «Llamar a los primeros 300» de 22.000 no dice nada. Se pide elegir
  // dónde; con una selección, la sesión se arma como siempre.
  if (S.schools.length && worldView()) {
    b.innerHTML = `${icon("nav")} <span class="sess-main">Elegí un país o un lugar para llamar</span>`; b.disabled = true;
    b.title = "Elegí un país arriba, una ciudad de la lista o ubicá un lugar: la sesión de llamadas se arma con los colegios de esa selección";
    return;
  }
  // «Para llamar 106» y «Llamar a 65»: la diferencia son los que no tienen teléfono. El botón dice las dos cosas con el
  // mismo número del filtro: «Llamar a 65 con teléfono (de 106)»; si no entran todos en una sesión, «Llamar a los primeros
  // 300 (de 1.238 con teléfono)». Se cuenta sin ordenar (callStats).
  const { tel: n, noTel } = S.schools.length ? callStats() : { tel: 0, noTel: 0 };
  // una sesión lleva hasta S.sessionMax colegios: el botón no promete más de lo que entra
  b.innerHTML = `${icon("play")} <span class="sess-main">${!n ? (noTel ? `${fmt(noTel)} sin teléfono` : "Nadie para llamar") : n > max ? `Llamar a los primeros ${fmt(max)}` : `Llamar a ${fmt(n)}`}${n > max ? ` <small class="sess-sub">(de ${fmt(n)}${noTel ? " con teléfono" : ""})</small>` : n && noTel ? ` <small class="sess-sub">con teléfono (de ${fmt(n + noTel)})</small>` : ""}</span>`;
  b.disabled = !n;
  b.title = !n ? (noTel ? `Los ${fmt(noTel)} de esta selección no tienen teléfono: abrí uno y tocá «Enriquecer» para buscarlo` : "No hay colegios para llamar con teléfono en esta selección") : n > max ? `Hay ${fmt(n)} con teléfono en esta selección: la sesión toma los primeros ${fmt(max)}, en el orden de la lista` : `Sesión de llamadas con los ${fmt(n)} de esta selección que tienen teléfono${noTel ? ` (${fmt(noTel)} no tienen: abrilos y tocá «Enriquecer» para buscarlo)` : ""}`;
}
function openCity(country, city) {
  E.country = country; E.city = city; E.q = ""; E.place = null; locSeq++; shown = PAGE; host.querySelector("#q").value = "";
  drawAll(); toTop();
  const unk = scope().filter(s => s.status === "unk");
  if (unk.length && unk.length <= 40) checkScope();
}
export function openCityFromOutside(country, city) { E.country = country; E.city = city; E.q = ""; E.place = null; E.filter = "prospect"; locSeq++; }
// Desde la búsqueda rápida o el asistente: ir a Prospectar y ubicar un lugar en el mapa.
export function locateFromOutside(text) { E.pendingLocate = text; }

// ---------- mapa
// Fondo del mapa: el de Google (Map Tiles API, GET /api/map/tiles de lib/map-api.js) si está prendido; si no, si tarda más de
// 2,5 s o si sus imágenes fallan, el de Esri de siempre. La sesión de Google se pide una vez por tema y por carga de la app.
const TILES = {};
function googleTiles(dark) {
  const k = dark ? "d" : "l";
  if (!TILES[k]) TILES[k] = Promise.race([api(`/api/map/tiles${dark ? "?dark=1" : ""}`).catch(() => null), new Promise(r => setTimeout(() => r(null), 2500))])
    .then(t => t?.session && t.key ? t : null);
  return TILES[k];
}
function esriTiles(m, dark) {
  const B = "https://server.arcgisonline.com/ArcGIS/rest/services/";
  if (dark) {
    L.tileLayer(B + "Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19, maxNativeZoom: 16, attribution: "© Esri, HERE, OpenStreetMap" }).addTo(m);
    L.tileLayer(B + "Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19, maxNativeZoom: 16 }).addTo(m);
  } else L.tileLayer(B + "World_Street_Map/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19, attribution: "© Esri, HERE, OpenStreetMap" }).addTo(m);
}
function baseTiles(m, dark) {
  googleTiles(dark).then(t => {
    if (m !== map) return; // se volvió a armar la pantalla
    if (!t) return esriTiles(m, dark);
    const q = `session=${encodeURIComponent(t.session)}&key=${encodeURIComponent(t.key)}`;
    const g = L.tileLayer(`https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}?${q}`, { maxZoom: 21, attribution: "Google" });
    let errs = 0, ok = 0;
    g.on("tileload", () => { ok++; });
    // si Google no da las imágenes (clave sin la API, cuota), vuelve el de Esri
    g.on("tileerror", () => { if (++errs === 4 && ok === 0) { TILES[dark ? "d" : "l"] = Promise.resolve(null); m.removeLayer(g); esriTiles(m, dark); } });
    g.addTo(m);
    // los derechos de lo que se ve (Google los pide por zona): «Google · Datos del mapa ©2026 INEGI…»
    let cur = "Google", tm = 0;
    const credit = () => { clearTimeout(tm); tm = setTimeout(async () => {
      if (!m.hasLayer(g)) return;
      const b = m.getBounds(), u = `https://tile.googleapis.com/tile/v1/viewport?${q}&zoom=${m.getZoom()}&north=${b.getNorth()}&south=${b.getSouth()}&east=${b.getEast()}&west=${b.getWest()}`;
      const j = await fetch(u).then(r => r.ok ? r.json() : null).catch(() => null);
      const next = j?.copyright ? `Google · ${j.copyright}` : "Google";
      if (next !== cur && m.attributionControl) { m.attributionControl.removeAttribution(cur); m.attributionControl.addAttribution(esc(next)); cur = next; }
    }, 400); };
    g.getAttribution = () => null; // la pone credit()
    m.attributionControl?.addAttribution(cur); m.on("moveend", credit); credit();
  });
}
function initMap() {
  if (!window.L) return;
  const touch = matchMedia("(pointer: coarse)").matches;
  map = L.map(host.querySelector("#map"), { zoomControl: !touch, attributionControl: true }).setView([-10, -70], 3);
  lastView = ""; // mapa nuevo: hay que volver a encuadrar
  const dark = document.documentElement.dataset.theme === "dark" || (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
  baseTiles(map, dark);
  layer = L.layerGroup().addTo(map);
  canvas = L.canvas({ padding: 0.3 });
  markClass();
  const Leg = L.Control.extend({ options: { position: "bottomleft" }, onAdd() {
    const d = L.DomUtil.create("details", "map-legend"); d.open = matchMedia("(min-width: 600px)").matches; d.hidden = true;
    d.innerHTML = `<summary>Referencias</summary><ul></ul>`; L.DomEvent.disableClickPropagation(d); L.DomEvent.disableScrollPropagation(d); legendEl = d; return d;
  } });
  map.addControl(new Leg());
  brainLayer = L.layerGroup(); if (showBrain) brainLayer.addTo(map);
  loadBrain();
  setTimeout(() => map.invalidateSize(), 50);
}
// Marca de un colegio en el lienzo: círculo (prospecto), cuadrado (trato en proceso), rombo (cliente), rombo hueco (churn) o cruz (archivado). Es el
// CircleMarker de Leaflet (mismo clic, tooltip y zona de toque) con otra figura dibujada; el radio es la mitad de la diagonal del rombo.
// Los círculos los dibuja Leaflet y redondea el radio a entero: por eso los radios de los círculos son enteros.
let Mark;
function markClass() {
  if (Mark || !window.L) return;
  Mark = L.CircleMarker.extend({
    _updatePath() {
      const sh = this.options.shape, r = this._renderer;
      if ((sh !== "d" && sh !== "dr" && sh !== "q" && sh !== "x") || !r._ctx) return L.CircleMarker.prototype._updatePath.call(this);
      if (!r._drawing || this._empty()) return;
      const p = this._point, ctx = r._ctx, k = this._radius;
      ctx.beginPath();
      if (sh === "x") { // cruz: dos trazos con un borde blanco debajo, sin relleno
        ctx.moveTo(p.x - k, p.y - k); ctx.lineTo(p.x + k, p.y + k); ctx.moveTo(p.x + k, p.y - k); ctx.lineTo(p.x - k, p.y + k);
        ctx.save(); ctx.lineCap = "round"; ctx.lineWidth = this.options.weight + 3; ctx.strokeStyle = "#fff"; ctx.stroke();
        ctx.lineWidth = this.options.weight; ctx.strokeStyle = this.options.color; ctx.stroke(); ctx.restore(); return;
      }
      if (sh === "d" || sh === "dr") { ctx.moveTo(p.x, p.y - k); ctx.lineTo(p.x + k, p.y); ctx.lineTo(p.x, p.y + k); ctx.lineTo(p.x - k, p.y); }
      else { const h = k * 0.85; ctx.rect(p.x - h, p.y - h, 2 * h, 2 * h); }
      ctx.closePath();
      // rombo hueco: un borde blanco por fuera, como el resto de las marcas (sin él, en oscuro y con protanopía casi no se ve)
      if (sh === "dr") { ctx.save(); ctx.lineJoin = "round"; ctx.lineWidth = this.options.weight + 3; ctx.strokeStyle = "#fff"; ctx.stroke(); ctx.restore(); }
      r._fillStroke(ctx, this);
    },
  });
}
// orden de dibujo: lo apagado abajo, después lo que está para llamar («nunca contactado» encima de los demás) y arriba de todo los
// clientes y ex clientes: son pocos y avisan «no llamar», así que no pueden quedar tapados. «Para llamar» resalta igual por color y tamaño.
const Z = { archived: 0, unk: 1, stalled: 3, lost: 3, org: 4, lead: 4, open: 5, "ph-propuesta": 5, new: 7, client: 8, churn: 8, "ph-churn": 8, "ph-cerrado": 9, "ph-onboarding": 9, "ph-activo": 9 };
// Referencias del mapa (abajo a la izquierda): solo lo que se ve, con cuántos hay. En el celular arranca cerrada.
const LEG = ["new", "org", "lead", "stalled", "lost", "unk", "archived", "open", "ph-propuesta", "ph-activo", "ph-onboarding", "ph-cerrado", "ph-churn", "churn", "client"];
let legendEl = null;
function paintLegend(seen) {
  if (!legendEl) return;
  const item = (c, sh, l, n, big) => `<li><i class="lgd sh-${sh}${big ? " big" : ""}" style="--pd:${c}"></i>${esc(l)}${n ? ` <b>${fmt(n)}</b>` : ""}</li>`;
  let items;
  if (!seen) items = [item(CITY.pros, "c", "Ciudad con colegios para llamar", 0, true), item(CITY.unk, "ring", "Solo sin revisar"), item(CITY.none, "c", "Nada para llamar")];
  else {
    const n = k => seen.get(k) || 0, both = n("churn") + n("ph-churn");
    items = LEG.filter(k => k !== "churn" && n(k) || k === "churn" && !n("ph-churn") && n(k)).map(k => {
      const m = k.startsWith("ph-") ? PH[k.slice(3)] : ST[k];
      // «nunca contactado» (no «para llamar»: el filtro «Para llamar» incluye también En Pipe, Sin avance, Perdido y Sin revisar)
      return item(`var(${m.c})`, m.sh, m.l, /churn$/.test(k) ? both : n(k), k === "new");
    });
  }
  legendEl.hidden = !items.length;
  legendEl.querySelector("ul").innerHTML = items.join("");
}
// fit: encuadrar solo cuando cambia lo que se mira (país, ciudad, búsqueda o lugar), no en cada refresco.
let lastView = "";
function drawMap({ fit = true } = {}) {
  if (!map) return; layer.clearLayers(); const pts = [];
  const view = JSON.stringify([E.country, E.city, E.q, E.place?.osm || E.place?.label || ""]);
  const refit = fit && view !== lastView; lastView = view;
  const grouped = placeGrouped();
  if ((!E.city && !E.q && !placeMode()) || grouped) {
    cityGroups().forEach(c => {
      const lat = c.items.reduce((a, s) => a + s.lat, 0) / c.items.length, lng = c.items.reduce((a, s) => a + s.lng, 0) / c.items.length;
      const pros = c.items.filter(s => ["new", "org", "stalled", "lost"].includes(s.status) && !othersOwn(s)).length, unk = c.items.filter(s => s.status === "unk").length;
      const n = pros || unk || c.items.length, kind = pros ? "pros" : unk ? "unk" : "none", size = Math.min(56, 24 + Math.sqrt(n) * 3);
      L.marker([lat, lng], { icon: L.divIcon({ className: "", iconSize: [size, size], html: `<div class="citydot ${kind}" style="width:${size}px;height:${size}px">${n > 999 ? Math.round(n / 1000) + "k" : n}</div>` }), title: c.city, keyboard: true })
        .on("click", () => openCity(c.country, c.city)).bindTooltip(esc(`${c.city}: ${pros ? `${pros} para llamar` : unk ? `${unk} sin revisar` : "sin colegios para llamar"}`)).addTo(layer);
      pts.push([lat, lng]);
    });
    paintLegend(null);
  } else {
    const colors = Object.fromEntries([...Object.entries(ST).map(([k, v]) => [k, cssVar(v.c)]), ...Object.entries(PH).map(([k, v]) => ["ph-" + k, cssVar(v.c)])]);
    const hole = cssVar("--surface") || "#fff", seen = new Map();
    // «para llamar» arriba de todo; lo apagado (archivado, sin revisar) abajo
    const list = filtered().map(s => [s, markOf(s)]).sort((a, b) => (Z[a[1].k] ?? 5) - (Z[b[1].k] ?? 5));
    for (const [s, m] of list) {
      seen.set(m.k, (seen.get(m.k) || 0) + 1);
      const base = { renderer: canvas, color: "#fff", weight: 2, fillColor: colors[m.k], fillOpacity: 1, shape: m.sh };
      // radios: «nunca contactado» 9 (18 px), los demás círculos 6 (12 px); rombo 8,5 (17 px de diagonal), cuadrado 7,5 (13 px de lado);
      // rombo hueco 7,5 (con su borde de color y el blanco queda del tamaño del rombo lleno); cruz 4 (8 px)
      const o = m.sh === "ring" ? { ...base, radius: 5, color: colors[m.k], weight: 2.5, fillColor: hole } : m.sh === "x" ? { ...base, radius: 4, color: colors[m.k], weight: 2.5 }
        : m.sh === "dr" ? { ...base, radius: 7.5, color: colors[m.k], weight: 3, fillColor: hole }
        : m.sh === "d" ? { ...base, radius: 8.5 } : m.sh === "q" ? { ...base, radius: 7.5 } : { ...base, radius: m.k === "new" ? 9 : 6 };
      new Mark([s.lat, s.lng], o).on("click", () => openSchool(s.id)).bindTooltip(esc(`${s.name} · ${s.phase === "churn" && s.ob?.label ? s.ob.label : m.l}`)).addTo(layer);
      pts.push([s.lat, s.lng]);
    }
    paintLegend(seen);
  }
  if (E.place?.kind === "continent") {
    // un continente: se encuadra la región y se ven los colegios agrupados por ciudad (sin contorno propio)
    if (refit && E.place.bbox) map.flyToBounds(E.place.bbox, { padding: [20, 20], duration: 0.8 });
    return;
  }
  if (E.place) {
    const p = E.place;
    // el contorno real del lugar (o el círculo, si es un punto)
    // la ciudad (o zona) como una capa del rojo de OrderEAT: relleno muy suave y semitransparente, contorno del mismo
    // rojo con un borde claro debajo, y afuera apenas más tenue para que se lea el límite con los vecinos
    const BRAND = "#E0153F", dark = document.documentElement.dataset.theme === "dark" || (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
    if (p.geo) {
      const polys = p.geo.type === "Polygon" ? [p.geo.coordinates] : p.geo.coordinates;
      const holes = polys.map(poly => poly[0].map(([x, y]) => [y, x]));
      L.polygon([[[-89, -360], [-89, 360], [89, 360], [89, -360]], ...holes], { stroke: false, fillColor: dark ? "#000" : "#fff", fillOpacity: dark ? 0.16 : 0.22, interactive: false }).addTo(layer);
      L.geoJSON(p.geo, { interactive: false, style: { color: "#fff", weight: 5, opacity: dark ? 0.25 : 0.7, fill: false } }).addTo(layer);
    }
    const shape = p.geo
      ? L.geoJSON(p.geo, { interactive: false, style: { color: BRAND, weight: 2.5, opacity: 0.95, fillColor: BRAND, fillOpacity: dark ? 0.16 : 0.1, lineJoin: "round" } })
      : L.circle([center(p).lat, center(p).lng], { radius: (p.radius || 3) * 1000, color: BRAND, weight: 2.5, dashArray: "8 6", fillColor: BRAND, fillOpacity: dark ? 0.16 : 0.1, interactive: false });
    shape.addTo(layer);
    if (!p.geo || p.kind === "spot") L.marker([p.lat, p.lng], { icon: L.divIcon({ className: "", iconSize: [30, 40], iconAnchor: [15, 38], html: `<div class="place-pin" aria-hidden="true"></div>` }), zIndexOffset: 2000, title: p.label, keyboard: false }).bindTooltip(esc(p.label)).addTo(layer);
    if (refit) { const bb = shape.getBounds(); if (bb.isValid()) map.flyToBounds(bb, { padding: [30, 30], maxZoom: 16, duration: 0.8 }); }
    return;
  }
  if (refit && pts.length) map.fitBounds(pts, { padding: [40, 40], maxZoom: 14 });
}

// ---------- clientes de OrderEAT (World Dominion)
async function loadBrain() {
  const m = map;
  S.brainP ??= api("/api/brain").catch(() => ({ enabled: false }));
  S.brain = await S.brainP;
  // si mientras tanto se volvió a armar la pantalla, el control va en el mapa nuevo (y una sola vez)
  if (!m || m !== map || !S.brain.enabled || m._obCtl) return;
  m._obCtl = true;
  drawBrain();
  const Ctl = L.Control.extend({ options: { position: "topright" }, onAdd() {
    const b = L.DomUtil.create("button", "map-toggle"); brainBtn = b; b.type = "button";
    L.DomEvent.disableClickPropagation(b); b.onclick = () => toggleBrain(); paintBrainBtn(); return b;
  } });
  map.addControl(new Ctl());
}
function paintBrainBtn() {
  if (!brainBtn) return;
  const n = (S.brain?.sites || []).length;
  brainBtn.setAttribute("aria-pressed", showBrain); brainBtn.setAttribute("aria-label", `Clientes OrderEAT en el mapa: ${n}`);
  brainBtn.title = S.brain?.error ? `OrderBrain: ${S.brain.error}` : "Mostrar u ocultar los colegios que ya son clientes de OrderEAT (World Dominion)";
  const c = { activo: 0, onboarding: 0, cerrado: 0, churn: 0 };
  for (const x of S.brain?.sites || []) c[x.churn ? "churn" : { Active: "activo", Onboarding: "onboarding", Closed: "cerrado" }[x.status] || "activo"]++;
  brainBtn.innerHTML = `<span class="mt-h"><i class="ob-dot"></i><span class="mt-l">Clientes OrderEAT</span> <b>${fmt(n)}</b>${S.brain?.demo ? ` <em class="demo-t">demo</em>` : ""}${S.brain?.error ? ` ${icon("alert", "sm")}` : ""}</span>
    <span class="mt-legend">${Object.entries(c).filter(([, v]) => v).map(([k, v]) => `<span><i class="${k}" style="background:var(${PH[k].c})"></i>${PH[k].l} ${fmt(v)}</span>`).join("")}</span>`;
}
function toggleBrain() {
  showBrain = !showBrain; try { localStorage.setItem("ob.brain", showBrain ? "1" : "0"); } catch {}
  showBrain ? brainLayer.addTo(map) : brainLayer.remove(); paintBrainBtn();
}
function drawBrain() {
  if (!brainLayer) return; brainLayer.clearLayers();
  for (const x of S.brain?.sites || []) {
    const ph = x.churn ? "churn" : { Active: "activo", Onboarding: "onboarding", Closed: "cerrado" }[x.status] || "activo";
    const html = ph === "churn" ? `<div class="ob-site churn" aria-hidden="true"></div>` : `<div class="ob-site" style="background:var(${PH[ph].c})" aria-hidden="true"></div>`;
    L.marker([x.lat, x.lng], { icon: L.divIcon({ className: "", iconSize: [16, 16], html }), zIndexOffset: 500, keyboard: false })
      .bindTooltip(esc(`${x.name}${x.client && x.client !== x.name ? ` (${x.client})` : ""} · ${x.churn ? (x.label === "Churn" ? "Churn: era cliente activo" : `${x.label}`) : `${x.label}: cliente de OrderEAT, no contactar`}`))
      .on("click", () => { if (x.schoolId && S.byId.has(x.schoolId)) openSchool(x.schoolId); })
      .addTo(brainLayer);
  }
}

// ---------- revisar en Pipedrive (de a 6)
async function checkScope() {
  if (busy) return;
  const todo = base().filter(s => s.status === "unk");
  if (!todo.length) return;
  busy = true; let done = 0, fail = 0;
  const prog = () => host.querySelector("#prog");
  drawList();
  for (let i = 0; i < todo.length; i += 6) {
    const chunk = todo.slice(i, i + 6);
    if (prog()) prog().innerHTML = `<span class="spin"></span> Revisando ${fmt(Math.min(i + 6, todo.length))} de ${fmt(todo.length)}…`;
    try {
      const r = await api("/api/check", { body: { ids: chunk.map(s => s.id) } });
      Object.values(r).forEach(v => { if (v.error) fail++; else { done++; patchSchool(v); } });
    } catch (e) { fail += chunk.length; toast(e.message, { type: "err" }); break; }
    if (!host.isConnected) break;
  }
  busy = false;
  S.today = null;
  if (!host.isConnected) return;
  drawAll();
  toast(fail ? `Revisados ${fmt(done)}. ${fmt(fail)} no se pudieron revisar, probá de nuevo en un rato.` : `Listo: ${fmt(done)} revisados en Pipedrive`, { type: fail ? "err" : "" });
}

function csv() {
  // el mismo CSV que las tablas del asistente (tableCsv de chatfmt.js): BOM, «;» (abre directo en Excel en español) y lo que
  // empieza con = + - @ lleva «'» adelante (una planilla no lo toma como fórmula); la descarga, con el mismo helper (chat.js)
  const table = { columns: ["Colegio", "Ciudad", "País", "Dirección", "Teléfono", "Web", "Estado en Pipe", "Detalle", "Último contacto"].map(label => ({ label, type: "text" })),
    rows: visible().map(s => [s.name, s.city, s.country, s.addr || "", s.phone || "", s.web || "", s.phase === "churn" && s.ob?.label ? s.ob.label : ST[s.status]?.l || s.status, s.detail || "", s.lastTouch ? `${s.lastTouch.outcome} (${shortDay(s.lastTouch.at.slice(0, 10))})` : ""]) };
  const label = FILTERS.find(([k]) => k === E.filter)?.[1] || "";
  saveFile(new Blob([tableCsv(table)], { type: "text/csv;charset=utf-8" }), `orderbrain-${norm([E.city || (E.place && placeName(E.place)) || E.country || "latam", E.filter !== "all" ? label : ""].filter(Boolean).join(" ")).replace(/ /g, "-")}.csv`);
}

// Refresca la lista si cambió un colegio desde la ficha.
// fit:false = no mover el mapa (por ejemplo, mientras corre una búsqueda en segundo plano).
export function refreshExplore({ fit = true } = {}) { if (host?.isConnected) drawAll({ fit }); }
// Aviso de OrderBrain caído (sin datos de clientes): los clientes pueden aparecer para llamar.
// Los avisos de arriba de la lista (World Dominion, sin revisar) en una solapa que se abre y se cierra; si la cerraste,
// queda cerrada (en este navegador) y muestra cuántos hay. Un aviso de error la abre una vez si es nuevo.
const NT_KEY = "ob.notices.closed", NT_GONE = "ob.notices.gone";
// la ✕ la saca del todo (pedido del líder: «que se cierre si yo quiero, para que me deje más vista al mapa») hasta que cambie
// lo que dicen los avisos: se guarda la firma del texto (sin fechas ni números, que cambian solos)
const ntSig = html => html.replace(/<[^>]+>/g, " ").replace(/[\d/.:]+/g, "").replace(/\s+/g, " ").trim();
function noticeTab(html) {
  const n = (html.match(/class="callout /g) || []).length; if (!n) return "";
  let closed = false, gone = ""; try { closed = localStorage.getItem(NT_KEY) === "1"; gone = localStorage.getItem(NT_GONE) || ""; } catch { /* sin almacenamiento */ }
  const sig = ntSig(html); if (gone && gone === sig) return "";
  const err = /class="callout err/.test(html);
  return `<details class="notice-tab" data-sig="${esc(sig)}"${closed ? "" : " open"}><summary>${icon("alert", "sm")}<b>Avisos</b><span class="nt-n${err ? " err" : ""}">${n}</span><span class="nt-hint">${closed ? "Ver" : "Ocultar"}</span>${icon("chevDown", "sm")}<button type="button" class="nt-x" aria-label="Cerrar los avisos" title="Cerrar: vuelven si aparece un aviso nuevo">×</button></summary><div class="nt-body">${html}</div></details>`;
}
// la ✕: se resuelve al apretar, como la solapa (la lista se redibuja seguido)
const ntGone = d => {
  try { localStorage.setItem(NT_GONE, d.dataset.sig || ""); } catch { /* sin almacenamiento */ }
  document.querySelectorAll("details.notice-tab").forEach(x => x.remove());
  toast("Avisos cerrados: vuelven si aparece uno nuevo.", { type: "info" });
};
// se guarda al instante del clic: si la lista se redibuja enseguida (revisando la zona, cargando Pipedrive), el «toggle» llega a
// un elemento que ya no está y la solapa volvía a aparecer abierta
// Con el mouse se resuelve al apretar (pointerdown): si la lista se redibuja entre apretar y soltar, el «click» no llega nunca.
let ntPress = 0;
const ntSet = (d, open) => {
  try { localStorage.setItem(NT_KEY, open ? "0" : "1"); } catch { /* sin almacenamiento */ }
  d.open = open; const h = d.querySelector(".nt-hint"); if (h) h.textContent = open ? "Ocultar" : "Ver";
  // las otras solapas dibujadas (si la lista se redibujó) quedan igual
  document.querySelectorAll("details.notice-tab").forEach(x => { if (x !== d) x.open = open; });
};
document.addEventListener("pointerdown", e => {
  if (e.button !== 0) return;
  const sm = e.target.closest?.(".notice-tab > summary"); if (!sm) return;
  ntPress = Date.now();
  if (e.target.closest(".nt-x")) { e.preventDefault(); return ntGone(sm.parentElement); }
  ntSet(sm.parentElement, !sm.parentElement.open);
}, true);
document.addEventListener("click", e => {
  const sm = e.target.closest?.(".notice-tab > summary"); if (!sm) return;
  e.preventDefault(); // la solapa la abre o cierra ntSet, no el navegador
  if (Date.now() - ntPress < 1500) return; // ya lo resolvió el pointerdown
  if (e.target.closest(".nt-x")) return ntGone(sm.parentElement); // teclado
  ntSet(sm.parentElement, !sm.parentElement.open); // teclado (Enter o espacio)
}, true);
document.addEventListener("toggle", e => {
  // solo el texto: el estado lo guarda el clic (el «toggle» de una solapa recién dibujada abierta no tiene que pisar lo elegido)
  const d = e.target; if (!d?.classList?.contains("notice-tab")) return;
  const h = d.querySelector(".nt-hint"); if (h) h.textContent = d.open ? "Ocultar" : "Ver";
}, true);
const brainWarn = () => brainTokenCallout("") + (S.brainDown || S.brain?.down ? `<div class="callout warn">${icon("alert")}<span>No pudimos leer los clientes de World Dominion (${esc(S.brain?.error || "OrderBrain no respondió")}). Hasta que vuelva, revisá en Pipedrive antes de llamar.</span></div>` : brainStaleMsg() ? `<div class="callout warn">${icon("alert")}<span>${esc(brainStaleMsg())}</span></div>` : "");
