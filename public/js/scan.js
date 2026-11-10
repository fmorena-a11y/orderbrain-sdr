// Buscador de zonas: «España», «Madrid», «Provincia de Córdoba»… Busca colegios privados en OpenStreetMap
// ciudad por ciudad y los suma a la base y al mapa. Corre en segundo plano con un indicador de avance.
import { S, api, esc, icon, modal, toast, patchSchool, norm } from "./core.js";

const EXAMPLES = ["España", "Madrid", "Bogotá", "Provincia de Córdoba", "Monterrey", "Santa Cruz de la Sierra"];
let job = null;
const fmt = n => Number(n || 0).toLocaleString("es-MX");

export const scanRunning = () => !!job?.running;

// Diálogo: escribir la zona, ver qué se entendió y empezar.
export function openScanDialog(prefill = "") {
  if (job?.running) return toast(`Ya estoy buscando en ${job.label}. Esperá a que termine o cancelalo.`, { type: "info" });
  const m = modal(`<div class="modal-h"><h3>${icon("globe")} Buscar colegios en una zona</h3><button class="icon-btn" id="sxX" aria-label="Cerrar">${icon("x")}</button></div>
    <p class="muted" style="margin:-6px 0 0">País, provincia o ciudad. Busco los colegios privados que todavía no están y los sumo al mapa.</p>
    <form id="sxF" class="scan-form"><input class="inp" id="sxQ" placeholder="Ej: España, Madrid, Bogotá" value="${esc(prefill)}" autocomplete="off" aria-label="Zona"><button class="btn primary" id="sxGo">Buscar</button></form>
    <div class="chips" id="sxEx">${EXAMPLES.map(x => `<button class="chip" type="button" data-x="${esc(x)}">${esc(x)}</button>`).join("")}</div>
    <div id="sxOut" aria-live="polite"></div>`);
  const q = m.querySelector("#sxQ"), out = m.querySelector("#sxOut");
  m.querySelector("#sxX").onclick = () => m.close();
  m.querySelectorAll("[data-x]").forEach(b => b.onclick = () => { q.value = b.dataset.x; m.querySelector("#sxF").requestSubmit(); });
  m.querySelector("#sxF").onsubmit = async e => {
    e.preventDefault();
    const go = m.querySelector("#sxGo"); go.disabled = true;
    out.innerHTML = `<p class="muted"><span class="spin"></span> Buscando «${esc(q.value)}»…</p>`;
    try {
      const place = await api("/api/scan/resolve", { body: { q: q.value } });
      if (place.kind === "city") {
        out.innerHTML = summary(place, [place.city]);
      } else {
        out.innerHTML = `<p class="muted"><span class="spin"></span> ${esc(place.label)}: armando la lista de ciudades (puede tardar un minuto la primera vez)…</p>`;
        const { cities } = await api("/api/scan/cities", { body: { cc: place.cc, areaId: place.areaId } });
        if (!cities.length) { out.innerHTML = `<div class="callout warn">${icon("alert")}<span>No encontré ciudades de más de 40.000 habitantes en ${esc(place.label)}. Probá con una ciudad puntual.</span></div>`; go.disabled = false; return; }
        out.innerHTML = summary(place, cities);
      }
      m.querySelector("#sxStart").onclick = () => { m.close(); start(place, place.kind === "city" ? [place.city] : JSON.parse(out.querySelector("#sxData").textContent)); };
      m.querySelector("#sxStart").focus();
    } catch (err) { out.innerHTML = `<div class="callout err">${icon("alert")}<span>${esc(err.message)}</span></div>`; }
    go.disabled = false;
  };
  if (prefill) m.querySelector("#sxF").requestSubmit();
}
function summary(place, cities) {
  const known = S.schools.filter(s => s.country === place.country && (place.kind !== "city" || norm(s.city) === norm(place.city.name))).length;
  const mins = Math.max(1, Math.round(cities.length * 0.4));
  return `<div class="scan-sum">
    <b>${esc(place.label)}</b>
    <span class="muted">${place.kind === "city" ? "Ciudad" : `${fmt(cities.length)} ciudades de más de 40.000 habitantes`} · ${known ? `ya hay ${fmt(known)} colegios en la base` : "todavía sin colegios en la base"} · ${place.kind === "city" ? "menos de un minuto" : `unos ${fmt(mins)} min`}</span>
    <script type="application/json" id="sxData">${JSON.stringify(cities).replace(/</g, "\\u003c")}</script>
    <button class="btn primary" id="sxStart">${icon("play")} Buscar en ${place.kind === "city" ? esc(place.name) : `las ${fmt(cities.length)} ciudades`}</button>
  </div>`;
}

// Desde el asistente: entiende la zona y arranca directo.
export async function scanZone(q) {
  if (job?.running) return toast(`Ya estoy buscando en ${job.label}.`, { type: "info" });
  try { await scanPlace(await api("/api/scan/resolve", { body: { q } })); } catch (e) { toast(e.message, { type: "err" }); }
}
// Con una zona ya ubicada (por ejemplo, desde el buscador del mapa).
export async function scanPlace(place) {
  if (job?.running) return toast(`Ya estoy buscando en ${job.label}.`, { type: "info" });
  try {
    if (place.kind !== "city") toast(`Armando la lista de ciudades de ${place.label}…`, { type: "info" });
    const cities = place.kind === "city" ? [place.city] : (await api("/api/scan/cities", { body: { cc: place.cc, areaId: place.areaId } })).cities;
    if (!cities.length) return toast(`No encontré ciudades grandes en ${place.label}. Probá con una ciudad.`, { type: "err" });
    start(place, cities);
  } catch (e) { toast(e.message, { type: "err" }); }
}

// ---------- la búsqueda en segundo plano
async function start(place, cities) {
  job = { label: place.label, place, cities, i: 0, added: 0, found: 0, errors: 0, running: true, cancel: false };
  if (!S.countries.includes(place.country)) { S.countries.push(place.country); S.countries.sort(); }
  drawJob();
  for (; job.i < cities.length && !job.cancel; job.i++) {
    drawJob();
    let ok = false;
    for (let attempt = 0; attempt < 2 && !ok && !job.cancel; attempt++) {
      try {
        const r = await api("/api/scan/city", { body: { cc: place.cc, country: place.country, city: cities[job.i] } });
        r.added.forEach(patchSchool); job.added += r.added.length; job.found += r.found; ok = true;
        if (r.added.length) refresh();
      } catch (e) { if (attempt) { job.errors++; job.lastError = e.message; } else await new Promise(res => setTimeout(res, 4000)); }
    }
  }
  job.running = false; drawJob(); refresh();
  // el indicador ya muestra el resultado; el toast solo avisa si hubo errores
  if (job.errors) toast(`${job.errors} ciudad${job.errors > 1 ? "es" : ""} de ${job.label} no respondi${job.errors > 1 ? "eron" : "ó"}: ${job.lastError}`, { type: job.added ? "info" : "err" });
}
function refresh() { import("./explore.js").then(m => m.refreshExplore()); S.today = null; }
function drawJob() {
  let el = document.getElementById("scanJob");
  if (!job) return el?.remove();
  if (!el) { el = document.createElement("div"); el.id = "scanJob"; el.className = "scan-job"; el.setAttribute("role", "status"); document.body.appendChild(el); }
  const n = job.cities.length, pct = Math.round(Math.min(job.i, n) / n * 100);
  const city = job.cities[Math.min(job.i, n - 1)]?.name || "";
  el.innerHTML = `<div class="sj-bar"><span style="width:${job.running ? pct : 100}%"></span></div>
    <div class="sj-row">${job.running ? `<span class="spin"></span>` : icon("checkCircle")}<div class="sj-t"><b>${job.running ? `Buscando en ${esc(job.label)}` : `${esc(job.label)}: listo`}</b><small>${job.running ? `${esc(city)} · ${fmt(job.i)}/${fmt(n)} ciudades · ` : ""}${fmt(job.added)} colegios nuevos</small></div>
    <button class="btn sm" id="sjSee">Ver</button>${job.running ? `<button class="btn sm ghost" id="sjStop">Cancelar</button>` : `<button class="icon-btn" id="sjX" aria-label="Cerrar">${icon("x")}</button>`}</div>`;
  el.querySelector("#sjSee").onclick = () => {
    S.explore.country = job.place.country; S.explore.city = job.place.kind === "city" ? job.place.city.name : null; S.explore.q = ""; S.explore.filter = "prospect";
    import("./app.js").then(m => m.go("prospectar"));
    import("./explore.js").then(m => m.refreshExplore());
  };
  el.querySelector("#sjStop")?.addEventListener("click", () => { job.cancel = true; });
  el.querySelector("#sjX")?.addEventListener("click", () => { job = null; drawJob(); });
}
