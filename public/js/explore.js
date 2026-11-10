// Prospectar: lista por país y ciudad + mapa, con cruce contra Pipedrive y sesión de llamadas.
import { S, api, esc, norm, icon, pill, statusPill, dotColor, PH, ST, cssVar, patchSchool, toast, ago, shortDay, scroller } from "./core.js";
import { openSchool, startSession } from "./school.js";
import { baseErrorCallout } from "./app.js";

const E = S.explore;
// «Para llamar»: todo lo que no es cliente ni está en proceso (incluye los que todavía no se cruzaron con Pipe).
const CALLABLE = ["new", "org", "stalled", "lost", "unk"];
const FILTERS = [["prospect", "Para llamar"], ["new", "Nunca contactado"], ["org", "En Pipe sin trato"], ["stalled", "Contactado sin avance"], ["lost", "Perdido"], ["unk", "Sin revisar"], ["open", "En proceso"], ["client", "Cliente"], ["all", "Todos"]];
const RANK = { new: 0, org: 1, stalled: 2, lost: 3, unk: 4, open: 5, client: 6 };
// Colores fijos para los círculos de ciudad: el número en blanco se lee igual en modo claro y oscuro.
const CITY = { pros: "#00813A", unk: "#6B6B73", none: "#3F3F46" };
const PAGE = 150;
let host, map, layer, canvas, brainLayer, brainBtn, busy = false, shown = PAGE;
// Capa de clientes de OrderEAT (World Dominion de OrderBrain): prendida por defecto, se recuerda por persona.
let showBrain = (() => { try { return localStorage.getItem("ob.brain") !== "0"; } catch { return true; } })();

const scope = () => S.schools.filter(s => (!E.country || s.country === E.country) && (!E.city || s.city === E.city));
const searchList = () => { const q = norm(E.q); return S.schools.filter(s => (!E.country || s.country === E.country) && norm(`${s.name} ${s.city} ${s.addr || ""}`).includes(q)); };
const applyFilter = a => E.filter === "prospect" ? a.filter(s => CALLABLE.includes(s.status)) : E.filter === "all" ? a : a.filter(s => s.status === E.filter);
const sortS = a => a.sort((x, y) => RANK[x.status] - RANK[y.status] || (x.attempts || 0) - (y.attempts || 0) || x.name.localeCompare(y.name));
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
  for (const s of S.schools) {
    if (s.lat == null) continue;
    if (p.geo) {
      if (bb && (s.lat < bb[0][0] || s.lat > bb[1][0] || s.lng < bb[0][1] || s.lng > bb[1][1])) continue;
      if (!inGeo(p.geo, s.lng, s.lat)) continue;
      s._d = kmTo(s, c);
    } else { const d = kmTo(s, c); if (d > (p.radius || 3)) continue; s._d = d; }
    list.push(s);
  }
  list.sort((a, b) => a._d - b._d);
  pm = { p, n: S.schools.length, list };
  return list;
}
// provincia o país con muchos colegios: se agrupan por ciudad (como la vista general)
const placeGrouped = () => placeMode() && (E.place.kind === "country" || E.place.kind === "region") && placeList().length > 150;
const base = () => placeMode() ? placeList() : E.q ? searchList() : scope();
const visible = () => placeMode() ? applyFilter(placeList()) : sortS(applyFilter(E.q ? searchList() : scope()));
const callable = () => visible().filter(s => CALLABLE.includes(s.status) && s.phone);
const placeName = p => p.kind === "spot" && !p.geo ? p.label.split(",")[0] : p.name || p.label.split(",")[0];
function citiesOf(list) {
  const m = new Map();
  list.forEach(s => { const k = s.country + "|" + s.city; if (!m.has(k)) m.set(k, { country: s.country, city: s.city, items: [] }); m.get(k).items.push(s); });
  return [...m.values()].sort((a, b) => a.country.localeCompare(b.country) || b.items.length - a.items.length);
}
const fmt = n => n.toLocaleString("es-MX");

export function renderExplore(el) {
  host = el; map = null; shown = PAGE;
  el.innerHTML = `<div class="explore">
    <section class="explore-list" aria-label="Colegios">
      <div class="explore-top">
        <h1>Prospectar</h1>
        <label class="sr" for="q">Buscar colegio</label>
        <form id="qf" class="q-row" role="search"><input class="inp" id="q" type="search" placeholder="Colegio o ubicación (ciudad, barrio, dirección)" value="${esc(E.q)}" autocomplete="off" enterkeyhint="search"><button type="button" class="btn icon-only" id="locate" title="Ubicar en el mapa" aria-label="Ubicar en el mapa">${icon("nav")}</button></form>
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
    <div class="mapwrap"><div id="map" role="region" aria-label="Mapa de colegios"></div></div>
  </div>`;
  el.querySelectorAll(".scroll-row").forEach(scroller);
  const q = el.querySelector("#q");
  q.oninput = () => { E.q = q.value; E.place = null; locSeq++; shown = PAGE; drawAll(); toTop(); };
  // Enter: si el texto coincide con colegios de la base, se queda en esa lista; si no, ubica el lugar en el mapa.
  // El botón de la flecha siempre ubica.
  el.querySelector("#qf").onsubmit = e => { e.preventDefault(); if (!E.q.trim() || !searchList().length) locate(q.value); };
  el.querySelector("#locate").onclick = () => locate(q.value);
  el.querySelector("#sess").onclick = () => {
    const ids = callable().map(s => s.id);
    if (ids.length) startSession(ids, E.city || (E.place && placeName(E.place)) || E.country || "selección");
  };
  el.querySelector("#csv").onclick = csv;
  initMap();
  drawAll();
  if (E.pendingLocate) { const t = E.pendingLocate; E.pendingLocate = null; q.value = t; locate(t); }
}

// Al cambiar de ciudad, país, filtro o búsqueda, la lista vuelve arriba (en celular scrollea .explore-list; si no, .explore-scroll).
const toTop = () => { for (const sel of [".explore-scroll", ".explore-list"]) { const n = host.querySelector(sel); if (n) n.scrollTop = 0; } };
function drawAll({ fit = true } = {}) {
  host.querySelector(".explore")?.classList.toggle("focused", !!(E.city || E.q || E.place));
  drawCountries(); drawPlace(); drawCrumb(); drawFilters(); drawList(); drawFoot(); drawMap({ fit });
}

// ---------- ubicar en el mapa
let locSeq = 0;
async function locate(text, { osm } = {}) {
  text = String(text || "").trim(); if (!osm && text.length < 2) return;
  const seq = ++locSeq, box = host.querySelector("#placeBox");
  box.innerHTML = `<p class="muted place-msg"><span class="spin"></span> Ubicando «${esc(text)}»…</p>`;
  try {
    const place = await api("/api/scan/resolve", { body: osm ? { osm } : { q: text } });
    // si mientras tanto escribió otra cosa o pidió otro lugar, esta respuesta ya no sirve
    if (!host.isConnected || seq !== locSeq) return;
    E.place = place; E.q = ""; E.city = null; shown = PAGE; host.querySelector("#q").value = "";
    E.country = S.countries.includes(place.country) ? place.country : null;
    drawAll(); toTop();
  } catch (e) { if (seq === locSeq) box.innerHTML = `<div class="callout err place-msg">${icon("alert")}<span>${esc(e.message)}</span></div>`; }
}
function drawPlace() {
  const box = host.querySelector("#placeBox"), p = E.place;
  if (!p) { box.innerHTML = ""; return; }
  const n = placeList().length;
  const where = p.geo ? `en ${esc(placeName(p))}` : `a menos de ${String(p.radius || 3).replace(".", ",")} km`;
  const kind = { country: "País", region: "Provincia o estado", city: "Ciudad", spot: p.geo || /suburb|neighbourhood|quarter|city_district|borough/.test(p.type || "") ? "Barrio" : /road|street|highway/.test(p.type || "") ? "Calle" : "Dirección" }[p.kind] || "";
  box.innerHTML = `<div class="place-card"><span class="pin">${icon("nav", "sm")}</span><div class="t"><b>${esc(p.label)}</b><small>${kind ? `${kind} · ` : ""}${fmt(n)} colegio${n === 1 ? "" : "s"} ${where}</small></div>
    <button class="btn sm" id="pScan" title="Buscar colegios privados nuevos en esta zona y verificarlos">${icon("refresh", "sm")} ${n ? "Buscar más" : "Buscar colegios"}</button><button class="icon-btn" id="pX" aria-label="Quitar ubicación">${icon("x")}</button></div>
    ${p.alts?.length ? `<div class="place-alts"><span class="faint">¿Buscabas otro?</span>${p.alts.map(a => `<button class="chip sm" data-osm="${esc(a.osm)}">${esc(a.label)}</button>`).join("")}</div>` : ""}`;
  box.querySelector("#pX").onclick = () => { E.place = null; locSeq++; drawAll(); };
  box.querySelector("#pScan").onclick = () => import("./scan.js").then(m => m.scanPlace(p));
  box.querySelectorAll("[data-osm]").forEach(b => b.onclick = () => locate(b.textContent, { osm: b.dataset.osm }));
}
function drawCountries() {
  const c = host.querySelector("#countries");
  c.innerHTML = [["", "Todos"], ...S.countries.map(x => [x, x])].map(([k, l]) => `<button class="chip" data-c="${esc(k)}" aria-pressed="${(E.country || "") === k}">${esc(l)}</button>`).join("");
  c.querySelectorAll("button").forEach(b => b.onclick = () => { E.country = b.dataset.c || null; E.city = null; E.place = null; shown = PAGE; drawAll(); toTop(); });
}
function drawCrumb() {
  const c = host.querySelector("#crumb");
  if (!E.city || E.q || E.place) { c.innerHTML = ""; return; }
  c.innerHTML = `<button id="cb">${icon("arrowLeft", "sm")} Ciudades</button><span>${esc(E.city)}</span>`;
  c.querySelector("#cb").onclick = () => { E.city = null; shown = PAGE; drawAll(); };
}
function drawFilters() {
  const f = host.querySelector("#filters");
  const b = base();
  if ((!E.city && !E.q && !placeMode()) || !b.length || placeGrouped()) { f.innerHTML = ""; return; }
  const cnt = {}; b.forEach(s => cnt[s.status] = (cnt[s.status] || 0) + 1);
  cnt.prospect = CALLABLE.reduce((a, k) => a + (cnt[k] || 0), 0); cnt.all = b.length;
  f.innerHTML = FILTERS.filter(([k]) => k === "prospect" || k === "all" || cnt[k]).map(([k, l]) => `<button class="chip" data-f="${k}" aria-pressed="${E.filter === k}">${ST[k] ? `<span class="sdot" style="background:var(${ST[k].c})"></span>` : ""}${l} <b>${fmt(cnt[k] || 0)}</b></button>`).join("");
  f.querySelectorAll("button").forEach(b => b.onclick = () => { E.filter = b.dataset.f; shown = PAGE; drawAll(); toTop(); });
}
function schoolRow(s) {
  // el subtítulo dice lo que la pastilla no: ciudad, último contacto o motivo de pérdida, intentos, teléfono
  const bits = [];
  if (placeMode() && s._d != null) bits.push(s._d < 1 ? `${Math.round(s._d * 1000)} m` : `${s._d.toFixed(1).replace(".", ",")} km`);
  if (!E.city) bits.push(s.city);
  if (s.lastTouch) bits.push(`${s.lastTouch.outcome} ${ago(s.lastTouch.at)}`);
  else if (s.ob?.churn) bits.push("ex cliente OrderEAT");
  else if (s.status === "lost" && s.detail) bits.push(s.detail.replace(/^Perdido \d{4}-\d{2}-\d{2}( · )?/, "") || "Perdido");
  else if (s.status === "stalled" && s.detail) bits.push(s.detail.replace(/^Contactado \d{4}-\d{2}-\d{2}, sin avance( · )?/, "") || "sin avance");
  if (s.attempts) bits.push(`${s.attempts} intento${s.attempts > 1 ? "s" : ""}`);
  if (!s.phone) bits.push("sin teléfono");
  const single = E.filter !== "prospect" && E.filter !== "all";
  return `<button class="school-row" data-id="${esc(s.id)}"><span class="t"><b>${esc(s.name)}</b>${bits.length ? `<small>${esc(bits.join(" · "))}</small>` : ""}</span>${single && !s.phase ? `<span class="sdot" title="${ST[s.status].l}" style="background:var(${ST[s.status].c})"></span>` : statusPill(s)}</button>`;
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
    const list = placeMode() ? placeList() : scope(), cs = citiesOf(list);
    L.innerHTML = brainWarn() + `<div class="list-h"><span>${fmt(cs.length)} ciudades · ${fmt(list.length)} colegios</span><span class="legend"><i style="background:${CITY.pros}"></i>para llamar <i style="background:${CITY.unk}"></i>sin revisar</span></div>` + checkCallout(list) + cs.map(c => {
      const n = c.items.length, k = {}; c.items.forEach(s => k[s.status] = (k[s.status] || 0) + 1);
      const pros = CALLABLE.reduce((a, x) => a + (k[x] || 0), 0);
      const allUnk = k.unk === n;
      return `<button class="city-row" data-city="${esc(c.city)}" data-country="${esc(c.country)}"><span class="t"><b>${esc(c.city)}</b><small>${E.country || placeMode() ? "" : esc(c.country) + " · "}${fmt(n)} colegios · ${fmt(pros)} para llamar</small>${allUnk ? "" : `<span class="bar" aria-hidden="true">${Object.keys(ST).map(x => k[x] ? `<span data-st="${x}" style="width:${k[x] / n * 100}%;background:var(${ST[x].c})"></span>` : "").join("")}</span>`}</span>${allUnk ? `<span class="tag">Sin revisar</span>` : icon("arrowRight", "faint")}</button>`;
    }).join("");
    L.querySelectorAll("[data-city]").forEach(b => b.onclick = () => openCity(b.dataset.country, b.dataset.city));
    bindCheck(); return;
  }
  const a = visible(), bl = base();
  // hay coincidencias pero el filtro las oculta: decir por qué (clientes, en proceso…) en vez de «no hay nada»
  const why = () => { const c = {}; bl.forEach(s => { c[s.status] = (c[s.status] || 0) + 1; }); return Object.entries(c).map(([k, v]) => `${fmt(v)} ${k === "client" ? `cliente${v > 1 ? "s" : ""} de OrderEAT` : ST[k].l.toLowerCase()}`).join(", "); };
  const empty = bl.length
    ? `<div class="empty">${icon("list")}<span>${bl.length === 1 ? `«${esc(bl[0].name)}» no está` : `${fmt(bl.length)} coinciden pero no están`} en «${esc(FILTERS.find(f => f[0] === E.filter)?.[1] || "")}»: ${esc(why())}.</span><button class="btn sm" id="fAll">Ver ${bl.length === 1 ? "el colegio" : "todos"}</button></div>`
    : placeMode()
    ? `<div class="empty">${icon("nav")}<span>Todavía no hay colegios cargados en ${esc(placeName(E.place))}.</span><button class="btn primary sm" id="nearScan">${icon("refresh", "sm")} Buscar colegios acá</button></div>`
    : E.q
    ? `<div class="empty">${icon("search")}<span>Ningún colegio de la base coincide con «${esc(E.q)}»${E.country ? ` en ${esc(E.country)}` : ""}.</span><button class="btn primary sm" id="loc">${icon("nav", "sm")} Ubicar «${esc(E.q)}» en el mapa</button>${E.country ? `<button class="btn sm" id="allC">Buscar en todos los países</button>` : ""}</div>`
    : `<div class="empty">${icon("list")}<span>Nada con este filtro.</span><button class="btn sm" id="fAll">Ver todos</button></div>`;
  L.innerHTML = brainWarn() + checkCallout(bl) + `<div class="list-h"><span>${fmt(a.length)} colegio${a.length === 1 ? "" : "s"}</span></div>`
    + (a.length ? a.slice(0, shown).map(schoolRow).join("") + (a.length > shown ? `<button class="btn ghost sm block" id="moreS">Ver ${fmt(Math.min(PAGE, a.length - shown))} más</button>` : "") : empty);
  L.querySelector("#allC")?.addEventListener("click", () => { E.country = null; drawAll(); });
  L.querySelector("#loc")?.addEventListener("click", () => locate(E.q));
  L.querySelector("#nearScan")?.addEventListener("click", () => import("./scan.js").then(m => m.scanPlace(E.place)));
  L.querySelector("#clr")?.addEventListener("click", () => { E.q = ""; host.querySelector("#q").value = ""; drawAll(); });
  L.querySelector("#fAll")?.addEventListener("click", () => { E.filter = "all"; drawAll(); });
  L.querySelector("#moreS")?.addEventListener("click", () => { shown += PAGE; drawList(); });
  L.querySelectorAll(".school-row[data-id]").forEach(b => b.onclick = () => openSchool(b.dataset.id));
  bindCheck();
}
function bindCheck() { host.querySelector("#check")?.addEventListener("click", checkScope); }
function drawFoot() {
  const n = S.schools.length ? callable().length : 0;
  const b = host.querySelector("#sess");
  b.innerHTML = `${icon("play")} ${n ? `Llamar a ${fmt(n)}` : "Nadie para llamar"}`;
  b.disabled = !n;
  b.title = n ? "Sesión de llamadas con los colegios de esta selección que tienen teléfono" : "No hay colegios para llamar con teléfono en esta selección";
  host.querySelector("#csv").disabled = !S.schools.length;
}
function openCity(country, city) {
  E.country = country; E.city = city; E.q = ""; E.place = null; shown = PAGE; host.querySelector("#q").value = "";
  drawAll(); toTop();
  const unk = scope().filter(s => s.status === "unk");
  if (unk.length && unk.length <= 40) checkScope();
}
export function openCityFromOutside(country, city) { E.country = country; E.city = city; E.q = ""; E.place = null; E.filter = "prospect"; }
// Desde la búsqueda rápida o el asistente: ir a Prospectar y ubicar un lugar en el mapa.
export function locateFromOutside(text) { E.pendingLocate = text; }

// ---------- mapa
function initMap() {
  if (!window.L) return;
  const touch = matchMedia("(pointer: coarse)").matches;
  map = L.map(host.querySelector("#map"), { zoomControl: !touch, attributionControl: true }).setView([-10, -70], 3);
  const dark = document.documentElement.dataset.theme === "dark" || (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
  const B = "https://server.arcgisonline.com/ArcGIS/rest/services/";
  if (dark) {
    L.tileLayer(B + "Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19, maxNativeZoom: 16, attribution: "© Esri, HERE, OpenStreetMap" }).addTo(map);
    L.tileLayer(B + "Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19, maxNativeZoom: 16 }).addTo(map);
  } else L.tileLayer(B + "World_Street_Map/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19, attribution: "© Esri, HERE, OpenStreetMap" }).addTo(map);
  layer = L.layerGroup().addTo(map);
  canvas = L.canvas({ padding: 0.3 });
  brainLayer = L.layerGroup(); if (showBrain) brainLayer.addTo(map);
  loadBrain();
  setTimeout(() => map.invalidateSize(), 50);
}
// fit: encuadrar solo cuando cambia lo que se mira (país, ciudad, búsqueda o lugar), no en cada refresco.
let lastView = "";
function drawMap({ fit = true } = {}) {
  if (!map) return; layer.clearLayers(); const pts = [];
  const view = JSON.stringify([E.country, E.city, E.q, E.place?.osm || E.place?.label || ""]);
  const refit = fit && view !== lastView; lastView = view;
  const grouped = placeGrouped();
  if ((!E.city && !E.q && !placeMode()) || grouped) {
    citiesOf(grouped ? placeList() : scope()).forEach(c => {
      const lat = c.items.reduce((a, s) => a + s.lat, 0) / c.items.length, lng = c.items.reduce((a, s) => a + s.lng, 0) / c.items.length;
      const pros = c.items.filter(s => ["new", "org", "stalled", "lost"].includes(s.status)).length, unk = c.items.filter(s => s.status === "unk").length;
      const n = pros || unk || c.items.length, col = pros ? CITY.pros : unk ? CITY.unk : CITY.none, size = Math.min(56, 24 + Math.sqrt(n) * 3);
      L.marker([lat, lng], { icon: L.divIcon({ className: "", iconSize: [size, size], html: `<div class="citydot" style="width:${size}px;height:${size}px;background:${col}">${n > 999 ? Math.round(n / 1000) + "k" : n}</div>` }), title: c.city, keyboard: true })
        .on("click", () => openCity(c.country, c.city)).bindTooltip(esc(`${c.city}: ${pros ? `${pros} para llamar` : unk ? `${unk} sin revisar` : "sin colegios para llamar"}`)).addTo(layer);
      pts.push([lat, lng]);
    });
  } else {
    const colors = Object.fromEntries(Object.entries(ST).map(([k, v]) => [k, cssVar(v.c)]));
    (placeMode() ? visible() : applyFilter(E.q ? searchList() : scope())).forEach(s => {
      L.circleMarker([s.lat, s.lng], { renderer: canvas, radius: s.phase ? 8 : 7, color: "#fff", weight: 2, fillColor: dotColor(s, colors), fillOpacity: 1 })
        .on("click", () => openSchool(s.id)).bindTooltip(esc(`${s.name} · ${s.phase ? PH[s.phase].l : ST[s.status].l}`)).addTo(layer);
      pts.push([s.lat, s.lng]);
    });
  }
  if (E.place) {
    const p = E.place, accent = cssVar("--accent");
    // el contorno real del lugar (o el círculo, si es un punto)
    const shape = p.geo
      ? L.geoJSON(p.geo, { interactive: false, style: { color: accent, weight: 2.5, opacity: 0.9, fillColor: accent, fillOpacity: 0.06 } })
      : L.circle([center(p).lat, center(p).lng], { radius: (p.radius || 3) * 1000, color: accent, weight: 2, dashArray: "6 6", fillOpacity: 0.05, interactive: false });
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
  brainBtn.setAttribute("aria-pressed", showBrain);
  brainBtn.title = S.brain?.error ? `OrderBrain: ${S.brain.error}` : "Mostrar u ocultar los colegios que ya son clientes de OrderEAT (World Dominion)";
  const c = { activo: 0, onboarding: 0, cerrado: 0, churn: 0 };
  for (const x of S.brain?.sites || []) c[x.churn ? "churn" : { Active: "activo", Onboarding: "onboarding", Closed: "cerrado" }[x.status] || "activo"]++;
  brainBtn.innerHTML = `<span class="mt-h"><i class="ob-dot"></i>Clientes OrderEAT <b>${fmt(n)}</b>${S.brain?.demo ? ` <em class="demo-t">demo</em>` : ""}${S.brain?.error ? ` ${icon("alert", "sm")}` : ""}</span>
    <span class="mt-legend">${Object.entries(c).filter(([, v]) => v).map(([k, v]) => `<span><i style="background:${PH[k].dot}"></i>${PH[k].l} ${fmt(v)}</span>`).join("")}</span>`;
}
function toggleBrain() {
  showBrain = !showBrain; try { localStorage.setItem("ob.brain", showBrain ? "1" : "0"); } catch {}
  showBrain ? brainLayer.addTo(map) : brainLayer.remove(); paintBrainBtn();
}
function drawBrain() {
  if (!brainLayer) return; brainLayer.clearLayers();
  for (const x of S.brain?.sites || []) {
    const ph = x.churn ? "churn" : { Active: "activo", Onboarding: "onboarding", Closed: "cerrado" }[x.status] || "activo";
    const html = `<div class="ob-site" style="background:${PH[ph].dot}" aria-hidden="true"></div>`;
    L.marker([x.lat, x.lng], { icon: L.divIcon({ className: "", iconSize: [16, 16], html }), zIndexOffset: 500, keyboard: false })
      .bindTooltip(esc(`${x.name}${x.client && x.client !== x.name ? ` (${x.client})` : ""} · ${x.churn ? "Churn: ex cliente" : `${x.label}: cliente de OrderEAT, no contactar`}`))
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
  const arr = E.city || E.country || E.q || E.place ? visible() : sortS(applyFilter([...S.schools]));
  const rows = [["Colegio", "Ciudad", "País", "Dirección", "Teléfono", "Web", "Estado en Pipe", "Detalle", "Último contacto"], ...arr.map(s => [s.name, s.city, s.country, s.addr || "", s.phone || "", s.web || "", ST[s.status].l, s.detail || "", s.lastTouch ? `${s.lastTouch.outcome} (${shortDay(s.lastTouch.at.slice(0, 10))})` : ""])];
  const data = "﻿" + rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([data], { type: "text/csv" }));
  const label = FILTERS.find(([k]) => k === E.filter)?.[1] || "";
  a.download = `orderbrain-${norm([E.city || (E.place && placeName(E.place)) || E.country || "latam", E.filter !== "all" ? label : ""].filter(Boolean).join(" ")).replace(/ /g, "-")}.csv`; a.click();
}

// Refresca la lista si cambió un colegio desde la ficha.
// fit:false = no mover el mapa (por ejemplo, mientras corre una búsqueda en segundo plano).
export function refreshExplore({ fit = true } = {}) { if (host?.isConnected) drawAll({ fit }); }
// Aviso de OrderBrain caído (sin datos de clientes): los clientes pueden aparecer para llamar.
export const brainWarn = () => S.brain?.down ? `<div class="callout warn">${icon("alert")}<span>No pudimos leer los clientes de World Dominion (${esc(S.brain.error || "OrderBrain no respondió")}). Hasta que vuelva, revisá en Pipedrive antes de llamar.</span></div>` : "";
