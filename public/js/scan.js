// Buscador de zonas: «España», «Madrid», «Provincia de Córdoba», «Pocitos»… Busca colegios privados en OpenStreetMap
// dentro del lugar (su contorno real), verifica cada uno (web, Google e IA si están configurados) y recién ahí
// lo suma a la base y al mapa. Corre en segundo plano y se puede cancelar en el acto.
import { S, api, esc, icon, modal, toast, patchSchool, norm } from "./core.js";

const EXAMPLES = ["España", "Madrid", "Bogotá", "Provincia de Córdoba", "Monterrey", "Santa Cruz de la Sierra"];
const BATCH = 8;
let job = null;
const fmt = n => Number(n || 0).toLocaleString("es-MX");

export const scanRunning = () => !!job?.running;
const busyMsg = () => toast(`Ya estoy buscando en ${job.label}. Esperá a que termine o cancelalo.`, { type: "info" });

// Diálogo: escribir la zona, ver qué se entendió y empezar.
export function openScanDialog(prefill = "") {
  if (job?.running) return busyMsg();
  const m = modal(`<div class="modal-h"><h3>${icon("globe")} Buscar colegios en una zona</h3><button class="icon-btn" id="sxX" aria-label="Cerrar">${icon("x")}</button></div>
    <p class="muted" style="margin:-6px 0 0">País, provincia, ciudad o barrio. Busco los colegios privados que todavía no están, los verifico uno por uno y los sumo al mapa.</p>
    <form id="sxF" class="scan-form"><input class="inp" id="sxQ" placeholder="Ej: España, Madrid, Bogotá" value="${esc(prefill)}" autocomplete="off" aria-label="Zona"><button class="btn primary" id="sxGo">Buscar</button></form>
    <div class="chips" id="sxEx">${EXAMPLES.map(x => `<button class="chip" type="button" data-x="${esc(x)}">${esc(x)}</button>`).join("")}</div>
    <div id="sxOut" aria-live="polite"></div>`);
  const q = m.querySelector("#sxQ"), out = m.querySelector("#sxOut");
  let seq = 0;
  m.querySelector("#sxX").onclick = () => m.close();
  m.querySelectorAll("[data-x]").forEach(b => b.onclick = () => { q.value = b.dataset.x; m.querySelector("#sxF").requestSubmit(); });
  m.querySelector("#sxF").onsubmit = async e => {
    e.preventDefault();
    const my = ++seq, go = m.querySelector("#sxGo"); go.disabled = true;
    out.innerHTML = `<p class="muted"><span class="spin"></span> Buscando «${esc(q.value)}»…</p>`;
    try {
      const place = await api("/api/scan/resolve", { body: { q: q.value } });
      if (my !== seq) return;
      const plan = await planFor(place, msg => { if (my === seq) out.innerHTML = `<p class="muted"><span class="spin"></span> ${esc(msg)}</p>`; });
      if (my !== seq) return;
      out.innerHTML = summary(place, plan);
      m.querySelector("#sxStart").onclick = () => { m.close(); if (job?.running) return busyMsg(); start(place, plan); };
      m.querySelector("#sxStart").focus();
    } catch (err) { if (my === seq) out.innerHTML = `<div class="callout err">${icon("alert")}<span>${esc(err.message)}</span></div>`; }
    go.disabled = false;
  };
  if (prefill) m.querySelector("#sxF").requestSubmit();
}
function summary(place, plan) {
  const known = S.schools.filter(s => s.country === place.country).length;
  const steps = plan.steps.length;
  return `<div class="scan-sum">
    <b>${esc(place.label)}</b>
    <span class="muted">${plan.whole ? "Todo el contorno del lugar" : `${fmt(steps)} ciudades de más de 40.000 habitantes`} · ${known ? `ya hay ${fmt(known)} colegios en ${esc(place.country)}` : "todavía sin colegios en la base"} · cada colegio nuevo se verifica antes de entrar</span>
    <button class="btn primary" id="sxStart">${icon("play")} Buscar en ${plan.whole ? esc(place.name || place.label) : `las ${fmt(steps)} ciudades`}</button>
  </div>`;
}

// Qué recorrer: un barrio, una ciudad o una provincia con contorno se buscan enteros (exacto);
// un país se recorre ciudad por ciudad; un punto, en un círculo chico.
async function planFor(place, progress = () => {}, signal) {
  if (place.kind === "country") {
    progress(`${place.label}: armando la lista de ciudades (puede tardar un minuto la primera vez)…`);
    const { cities } = await api("/api/scan/cities", { body: { cc: place.cc }, signal });
    if (!cities.length) throw new Error(`No encontré ciudades de más de 40.000 habitantes en ${place.label}.`);
    return { whole: false, steps: cities.map(c => ({ city: c })) };
  }
  if (place.areaId) return { whole: true, steps: [{ city: { name: place.city.name, lat: place.lat, lng: place.lng, pop: place.city.pop }, areaId: place.areaId, whole: true }] };
  return { whole: true, steps: [{ city: { name: place.city.name, lat: place.lat, lng: place.lng, pop: 0 }, radius: place.radius || 3 }] };
}

// Desde el asistente: entiende la zona y arranca directo. Devuelve true si arrancó.
export async function scanZone(q) {
  if (job?.running) { busyMsg(); return false; }
  try { return await scanPlace(await api("/api/scan/resolve", { body: { q } })); } catch (e) { toast(e.message, { type: "err" }); return false; }
}
// Con una zona ya ubicada (por ejemplo, desde el buscador del mapa).
export async function scanPlace(place) {
  if (job?.running) { busyMsg(); return false; }
  // se reserva el trabajo antes de esperar nada: dos clics seguidos no arrancan dos búsquedas
  const ctl = new AbortController();
  job = { label: place.label, place, steps: [], i: 0, added: 0, dropped: [], queue: [], verified: 0, total: 0, errors: 0, running: true, preparing: true, ctl };
  drawJob();
  try {
    const plan = await planFor(place, () => {}, ctl.signal);
    if (job.ctl !== ctl || ctl.signal.aborted) return false;
    job.preparing = false;
    start(place, plan, job);
    return true;
  } catch (e) {
    if (job?.ctl === ctl) { if (!ctl.signal.aborted) toast(e.message, { type: "err" }); finish(job); }
    return false;
  }
}

// ---------- la búsqueda en segundo plano
const aborted = e => e?.name === "AbortError" || /aborted/i.test(e?.message || "");
async function start(place, plan, j = null) {
  if (!j) j = job = { label: place.label, place, i: 0, added: 0, dropped: [], queue: [], verified: 0, total: 0, errors: 0, running: true, ctl: new AbortController() };
  j.steps = plan.steps; j.preparing = false;
  if (!S.countries.includes(place.country)) { S.countries.push(place.country); S.countries.sort(); }
  const { signal } = j.ctl;
  drawJob();
  try {
    for (; j.i < j.steps.length && !signal.aborted; j.i++) {
      const st = j.steps[j.i];
      drawJob();
      let r = null;
      for (let attempt = 0; attempt < 2 && !r && !signal.aborted; attempt++) {
        try { r = await api("/api/scan/city", { body: { cc: place.cc, country: place.country, ...st }, signal }); }
        catch (e) { if (aborted(e)) throw e; if (attempt) { j.errors++; j.lastError = e.message; } else await wait(4000, signal); }
      }
      // una provincia entera no respondió de una vez: se recorre por sus ciudades, siempre dentro del contorno
      if (!r && st.whole && place.kind === "region" && !j.fellBack && !signal.aborted) {
        j.fellBack = true;
        try { const { cities } = await api("/api/scan/cities", { body: { areaId: place.areaId }, signal }); j.steps.push(...cities.map(c => ({ city: c, areaId: place.areaId }))); j.errors = Math.max(0, j.errors - 1); }
        catch (e) { if (aborted(e)) throw e; }
      }
      if (!r) continue;
      // los que ya estaban (otra búsqueda u otra instancia los sumó): que el navegador los tenga
      const before = S.schools.length; (r.seen || []).forEach(patchSchool); if (S.schools.length > before) refresh();
      j.total += r.candidates.length;
      // verificación por tandas: recién entra a la base lo que pasa el control
      for (let k = 0; k < r.candidates.length && !signal.aborted; k += BATCH) {
        drawJob();
        const items = r.candidates.slice(k, k + BATCH);
        try {
          const v = await api("/api/scan/verify", { body: { items }, signal });
          v.added.forEach(patchSchool); j.added += v.added.length; j.dropped.push(...v.dropped); j.verified += items.length;
          j.sources = v.sources; j.temporary = v.temporary;
          if (v.added.length) refresh();
        } catch (e) { if (aborted(e)) throw e; j.errors++; j.lastError = e.message; j.verified += items.length; }
      }
    }
  } catch (e) { if (!aborted(e)) { j.errors++; j.lastError = e.message; } }
  finish(j);
}
const wait = (ms, signal) => new Promise((res, rej) => { const t = setTimeout(res, ms); signal?.addEventListener("abort", () => { clearTimeout(t); rej(new DOMException("aborted", "AbortError")); }, { once: true }); });
function finish(j) {
  if (!j.running) return;
  j.running = false; j.preparing = false; drawJob(); refresh();
  if (j.errors && !j.cancel) toast(`${fmt(j.errors)} parte${j.errors > 1 ? "s" : ""} de ${j.label} no respondi${j.errors > 1 ? "eron" : "ó"}: ${j.lastError}`, { type: j.added ? "info" : "err" });
}
// Cancelar: corta lo que está en curso en el momento; lo que estaba a medio verificar no entra.
function cancel() {
  if (!job?.running) return;
  job.cancel = true; job.ctl.abort();
  finish(job);
}
function refresh() { import("./explore.js").then(m => m.refreshExplore({ fit: false })); S.today = null; }

// El indicador se arma una vez y después solo se actualizan los textos: los botones no se reemplazan,
// así un clic en «Cancelar» nunca cae en un botón que ya no existe.
function drawJob() {
  let el = document.getElementById("scanJob");
  if (!job) return el?.remove();
  if (!el) {
    el = document.createElement("div"); el.id = "scanJob"; el.className = "scan-job"; el.setAttribute("role", "status");
    el.innerHTML = `<div class="sj-bar"><span></span></div>
      <div class="sj-row"><span class="sj-ic"></span><div class="sj-t"><b></b><small class="sj-sub"></small><small class="warn-t" hidden>Se ven por un rato: para que queden para todo el equipo hay que conectar Upstash.</small></div>
      <button class="btn sm" id="sjSee">Ver</button><button class="btn sm ghost" id="sjStop">Cancelar</button><button class="icon-btn" id="sjX" aria-label="Cerrar">${icon("x")}</button></div>`;
    document.body.appendChild(el);
    el.querySelector("#sjSee").onclick = () => {
      const j = job; if (!j) return;
      // vuelve a mostrar el lugar de la búsqueda (con su contorno), no otra zona que hubiera quedado puesta
      Object.assign(S.explore, { place: j.place, country: S.countries.includes(j.place.country) ? j.place.country : null, city: null, q: "", filter: "prospect" });
      import("./app.js").then(m => m.go("prospectar"));
      import("./explore.js").then(m => m.refreshExplore());
    };
    // pointerdown: cancela apenas se toca, sin esperar a que termine el clic
    el.querySelector("#sjStop").addEventListener("pointerdown", e => { e.preventDefault(); cancel(); });
    el.querySelector("#sjStop").addEventListener("click", cancel);
    el.querySelector("#sjX").onclick = () => { job = null; drawJob(); };
  }
  const j = job, n = Math.max(1, j.steps.length);
  const pct = j.preparing ? 3 : Math.round(Math.min(n, j.i + (j.total ? j.verified / j.total : 0)) / n * 100);
  const step = j.steps[Math.min(j.i, n - 1)];
  const where = j.steps.length > 1 ? `${step?.city?.name || ""} · ${fmt(Math.min(j.i + 1, n))}/${fmt(n)} ciudades · ` : "";
  const verifying = j.total ? `verificados ${fmt(j.verified)}/${fmt(j.total)} · ` : "";
  const drop = j.dropped.length ? ` · ${fmt(j.dropped.length)} descartados` : "";
  el.querySelector(".sj-bar span").style.width = `${j.running ? pct : 100}%`;
  const ic = el.querySelector(".sj-ic"), want = j.running ? "run" : j.cancel ? "x" : "ok";
  if (ic.dataset.k !== want) { ic.dataset.k = want; ic.innerHTML = j.running ? `<span class="spin"></span>` : icon(j.cancel ? "x" : "checkCircle"); }
  el.querySelector(".sj-t b").textContent = j.running ? (j.preparing ? `Preparando ${j.label}…` : `Buscando en ${j.label}`) : j.cancel ? `${j.label}: cancelado` : `${j.label}: listo`;
  const sub = el.querySelector(".sj-sub");
  sub.textContent = j.running ? (j.preparing ? "Armando la lista de lugares" : `${where}${verifying}${fmt(j.added)} nuevos${drop}`) : `${fmt(j.added)} colegios nuevos verificados${drop}${j.errors ? ` · ${fmt(j.errors)} sin respuesta` : ""}`;
  sub.title = j.dropped.slice(0, 12).map(d => `${d.name}: ${d.why}`).join("\n");
  el.querySelector(".warn-t").hidden = j.running || !j.temporary;
  el.querySelector("#sjStop").hidden = !j.running;
  el.querySelector("#sjX").hidden = j.running;
}
