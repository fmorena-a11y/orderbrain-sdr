// Prospectar: lista por país y ciudad + mapa, con cruce en lote contra Pipedrive.
import { S, api, esc, norm, icon, pill, ST, cssVar, patchSchool, toast, ago } from "./core.js";
import { openSchool, startSession } from "./school.js";

const E = S.explore;
const FILTERS = [["prospect", "Para prospectar"], ["new", "Nunca contactado"], ["org", "En Pipe sin trato"], ["lost", "Perdido"], ["open", "En proceso"], ["client", "Cliente"], ["unk", "Sin revisar"], ["all", "Todos"]];
const PROSPECT = ["new", "org", "lost", "unk"];
const RANK = { new: 0, org: 1, lost: 2, unk: 3, open: 4, client: 5 };
let host, map, layer, canvas, busy = false;

const scope = () => S.schools.filter(s => (!E.country || s.country === E.country) && (!E.city || s.city === E.city));
const searchList = () => { const q = norm(E.q); return S.schools.filter(s => (!E.country || s.country === E.country) && norm(`${s.name} ${s.city} ${s.addr || ""}`).includes(q)); };
const applyFilter = a => E.filter === "prospect" ? a.filter(s => PROSPECT.includes(s.status)) : E.filter === "all" ? a : a.filter(s => s.status === E.filter);
const sortS = a => a.sort((x, y) => RANK[x.status] - RANK[y.status] || (x.attempts || 0) - (y.attempts || 0) || x.name.localeCompare(y.name));
function citiesOf(list) {
  const m = new Map();
  list.forEach(s => { const k = s.country + "|" + s.city; if (!m.has(k)) m.set(k, { country: s.country, city: s.city, items: [] }); m.get(k).items.push(s); });
  return [...m.values()].sort((a, b) => a.country.localeCompare(b.country) || b.items.length - a.items.length);
}

export function renderExplore(el) {
  host = el; map = null;
  el.innerHTML = `<div class="explore">
    <section class="explore-list">
      <div class="explore-top">
        <h1>Prospectar</h1>
        <label class="sr" for="q">Buscar colegio</label>
        <input class="inp" id="q" type="search" placeholder="Buscar colegio, ciudad o dirección" value="${esc(E.q)}">
        <div class="chips" id="countries" role="group" aria-label="País"></div>
        <div class="crumb" id="crumb"></div>
        <div class="chips" id="filters" role="group" aria-label="Estado en Pipedrive"></div>
      </div>
      <div class="explore-scroll" id="list"></div>
      <div class="explore-foot"><span class="prog" id="prog" aria-live="polite"></span>
        <button class="btn sm" id="check" title="Cruza los colegios de esta zona con Pipedrive">${icon("refresh", "sm")} Revisar en Pipe</button>
        <button class="btn sm" id="sess">${icon("play", "sm")} Sesión</button>
        <button class="btn sm icon-only" id="csv" title="Descargar CSV" aria-label="Descargar CSV">${icon("download", "sm")}</button></div>
    </section>
    <div class="mapwrap"><div id="map" aria-label="Mapa de colegios"></div><div class="map-legend">${Object.entries(ST).map(([k, v]) => `<span><i style="background:var(${v.c})"></i>${v.l}</span>`).join("")}</div></div>
  </div>`;
  const q = el.querySelector("#q");
  q.oninput = () => { E.q = q.value; drawAll(); };
  el.querySelector("#check").onclick = checkScope;
  el.querySelector("#sess").onclick = () => {
    const ids = sortS(applyFilter(E.q ? searchList() : scope())).filter(s => PROSPECT.includes(s.status) && s.phone).map(s => s.id);
    if (!ids.length) return toast("No hay colegios para prospectar en esta selección", { type: "err" });
    startSession(ids, E.city || E.country || "selección");
  };
  el.querySelector("#csv").onclick = csv;
  initMap();
  drawAll();
}

function drawAll() { drawCountries(); drawCrumb(); drawFilters(); drawList(); drawMap(); }
function drawCountries() {
  const c = host.querySelector("#countries");
  c.innerHTML = [["", "Todos"], ...S.countries.map(x => [x, x])].map(([k, l]) => `<button class="chip" data-c="${esc(k)}" aria-pressed="${(E.country || "") === k}">${esc(l)}</button>`).join("");
  c.querySelectorAll("button").forEach(b => b.onclick = () => { E.country = b.dataset.c || null; E.city = null; drawAll(); });
}
function drawCrumb() {
  const c = host.querySelector("#crumb");
  if (E.city) { c.innerHTML = `<button id="cb">${icon("arrowLeft", "sm")} Ciudades</button><span>· ${esc(E.city)}, ${esc(E.country)}</span>`; c.querySelector("#cb").onclick = () => { E.city = null; drawAll(); }; }
  else c.innerHTML = E.q ? "" : `<span>${E.country ? esc(E.country) + " · " : ""}Elegí una ciudad en la lista o en el mapa</span>`;
}
function drawFilters() {
  const f = host.querySelector("#filters");
  if (!E.city && !E.q) { f.innerHTML = ""; return; }
  const base = E.q ? searchList() : scope(), cnt = {};
  base.forEach(s => cnt[s.status] = (cnt[s.status] || 0) + 1);
  cnt.prospect = PROSPECT.reduce((a, k) => a + (cnt[k] || 0), 0); cnt.all = base.length;
  f.innerHTML = FILTERS.filter(([k]) => k === "prospect" || k === "all" || cnt[k]).map(([k, l]) => `<button class="chip" data-f="${k}" aria-pressed="${E.filter === k}">${ST[k] ? `<span class="dot" style="background:var(${ST[k].c})"></span>` : ""}${l} <b>${cnt[k] || 0}</b></button>`).join("");
  f.querySelectorAll("button").forEach(b => b.onclick = () => { E.filter = b.dataset.f; drawAll(); });
}
function schoolRow(s) {
  const sub = E.city ? (s.lastTouch ? `${s.lastTouch.outcome} · ${ago(s.lastTouch.at)}` : s.detail || s.addr || "") : `${s.city}, ${s.country}`;
  return `<button class="school-row" data-id="${esc(s.id)}"><span class="t"><b>${esc(s.name)}</b><small>${esc(sub)}</small></span>${pill(s.status)}</button>`;
}
function drawList() {
  const L = host.querySelector("#list");
  if (E.q) { const a = sortS(applyFilter(searchList())); L.innerHTML = `<div class="list-h"><span>${a.length} resultados</span></div>` + (a.length ? a.map(schoolRow).join("") : `<div class="empty">Ningún colegio cargado coincide con «${esc(E.q)}».</div>`); bind(); return; }
  if (!E.city) {
    const cs = citiesOf(scope());
    L.innerHTML = `<div class="list-h"><span>${cs.length} ciudades · ${scope().length} colegios</span></div>` + cs.map(c => {
      const n = c.items.length, k = {}; c.items.forEach(s => k[s.status] = (k[s.status] || 0) + 1);
      const rev = n - (k.unk || 0), pros = (k.new || 0) + (k.org || 0) + (k.lost || 0);
      return `<button class="city-row" data-city="${esc(c.city)}" data-country="${esc(c.country)}"><span><b>${esc(c.city)}</b><small>${esc(c.country)} · ${n} colegios · ${rev ? `${pros} para prospectar` : "sin revisar"}</small><span class="bar">${Object.keys(ST).map(x => k[x] ? `<span style="width:${k[x] / n * 100}%;background:var(${ST[x].c})"></span>` : "").join("")}</span></span>${icon("arrowRight", "faint")}</button>`;
    }).join("");
    L.querySelectorAll("[data-city]").forEach(b => b.onclick = () => openCity(b.dataset.country, b.dataset.city));
    return;
  }
  const a = sortS(applyFilter(scope()));
  const unk = scope().filter(s => s.status === "unk").length;
  L.innerHTML = (unk ? `<div class="callout info" style="margin:8px 4px">${icon("refresh")}<span>${unk} colegios sin revisar. <button class="linkbtn" id="ck2">Revisarlos en Pipedrive</button> para saber cuáles conviene llamar.</span></div>` : "")
    + `<div class="list-h"><span>${a.length} colegios</span></div>` + (a.length ? a.map(schoolRow).join("") : `<div class="empty">Nada con este filtro. Probá con «Todos».</div>`);
  L.querySelector("#ck2")?.addEventListener("click", checkScope);
  bind();
}
function bind() { host.querySelectorAll(".school-row[data-id]").forEach(b => b.onclick = () => openSchool(b.dataset.id)); }
function openCity(country, city) { E.country = country; E.city = city; E.q = ""; host.querySelector("#q").value = ""; drawAll(); const unk = scope().filter(s => s.status === "unk"); if (unk.length && unk.length <= 40) checkScope(); }

// ---------- mapa
function initMap() {
  if (!window.L) return;
  map = L.map(host.querySelector("#map"), { zoomControl: true, attributionControl: true }).setView([-10, -70], 3);
  const dark = document.documentElement.dataset.theme === "dark" || (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
  const B = "https://server.arcgisonline.com/ArcGIS/rest/services/";
  if (dark) {
    L.tileLayer(B + "Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19, maxNativeZoom: 16, attribution: "© Esri, HERE, OpenStreetMap" }).addTo(map);
    L.tileLayer(B + "Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19, maxNativeZoom: 16 }).addTo(map);
  } else L.tileLayer(B + "World_Street_Map/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19, attribution: "© Esri, HERE, OpenStreetMap" }).addTo(map);
  layer = L.layerGroup().addTo(map);
  canvas = L.canvas({ padding: 0.3 });
  setTimeout(() => map.invalidateSize(), 50);
}
function drawMap() {
  if (!map) return; layer.clearLayers(); const pts = [];
  if (!E.city && !E.q) {
    citiesOf(scope()).forEach(c => {
      const lat = c.items.reduce((a, s) => a + s.lat, 0) / c.items.length, lng = c.items.reduce((a, s) => a + s.lng, 0) / c.items.length;
      const pros = c.items.filter(s => ["new", "org", "lost"].includes(s.status)).length, rev = c.items.filter(s => s.status !== "unk").length;
      const col = cssVar(!rev ? ST.unk.c : pros ? ST.new.c : ST.open.c), size = 24 + Math.sqrt(c.items.length) * 4;
      L.marker([lat, lng], { icon: L.divIcon({ className: "", iconSize: [size, size], html: `<div class="citydot" style="width:${size}px;height:${size}px;background:${col}">${c.items.length}</div>` }), title: c.city, keyboard: true })
        .on("click", () => openCity(c.country, c.city)).bindTooltip(`${c.city}: ${rev ? pros + " para prospectar" : "sin revisar"}`).addTo(layer);
      pts.push([lat, lng]);
    });
  } else {
    // puntos en canvas: aguanta miles de colegios por ciudad sin trabarse
    const colors = Object.fromEntries(Object.entries(ST).map(([k, v]) => [k, cssVar(v.c)]));
    applyFilter(E.q ? searchList() : scope()).forEach(s => {
      L.circleMarker([s.lat, s.lng], { renderer: canvas, radius: 7, color: "#fff", weight: 2, fillColor: colors[s.status], fillOpacity: 1 })
        .on("click", () => openSchool(s.id)).bindTooltip(`${s.name} · ${ST[s.status].l}`).addTo(layer);
      pts.push([s.lat, s.lng]);
    });
  }
  if (pts.length) map.fitBounds(pts, { padding: [40, 40], maxZoom: 14 });
}

// ---------- revisar en lote
async function checkScope() {
  if (busy) return;
  const prog = host.querySelector("#prog");
  const base = E.city || E.country ? scope() : [];
  if (!base.length) { prog.textContent = "Elegí un país o una ciudad para revisar."; return; }
  const todo = base.filter(s => s.status === "unk");
  if (!todo.length) { prog.textContent = "Ya está todo revisado (vale 7 días)."; return; }
  busy = true; host.querySelector("#check").disabled = true; let done = 0, fail = 0;
  for (let i = 0; i < todo.length; i += 6) {
    const chunk = todo.slice(i, i + 6);
    prog.innerHTML = `<span class="spin"></span> Revisando ${Math.min(i + 6, todo.length)} de ${todo.length}…`;
    try {
      const r = await api("/api/check", { body: { ids: chunk.map(s => s.id) } });
      Object.values(r).forEach(v => { if (v.error) fail++; else { done++; patchSchool(v); } });
    } catch (e) { fail += chunk.length; prog.textContent = e.message; break; }
    if (!host.isConnected) break;
    drawList(); drawFilters(); drawMap();
  }
  busy = false;
  if (!host.isConnected) return;
  host.querySelector("#check").disabled = false;
  prog.textContent = fail ? `Revisados ${done}. ${fail} no se pudieron revisar, reintentá en un rato.` : `Listo: ${done} revisados.`;
  S.today = null; drawAll();
}

function csv() {
  const arr = E.city || E.country ? scope() : S.schools;
  const rows = [["Colegio", "Ciudad", "País", "Dirección", "Teléfono", "Web", "Estado en Pipe", "Detalle", "Último contacto"], ...arr.map(s => [s.name, s.city, s.country, s.addr || "", s.phone || "", s.web || "", ST[s.status].l, s.detail || "", s.lastTouch ? `${s.lastTouch.outcome} (${s.lastTouch.at.slice(0, 10)})` : ""])];
  const data = "﻿" + rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([data], { type: "text/csv" }));
  a.download = `orderbrain-${norm(E.city || E.country || "latam").replace(/ /g, "-")}.csv`; a.click();
}

// Refresca la lista si cambió un colegio desde la ficha.
export function refreshExplore() { if (host?.isConnected) drawAll(); }
