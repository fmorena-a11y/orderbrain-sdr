// Radar: colegios nuevos que encuentra el agente que recorre todas las ciudades cada 2 horas.
import { api, esc, icon, ago } from "./core.js";
import { openSchool, startSession } from "./school.js";
import { go } from "./app.js";
import { openCityFromOutside } from "./explore.js";

let host, all = false;
const fmt = n => Number(n || 0).toLocaleString("es-MX");

export async function renderRadar(el) {
  host = el; all = false;
  el.innerHTML = page(`<div class="card hero"><div class="ring"><b>…</b></div><div><div class="skel" style="width:60%;height:20px"></div><div class="skel" style="width:40%;margin-top:14px"></div></div></div>
    <div class="card card-b" style="padding:20px">${'<div class="skel" style="margin:14px 0"></div>'.repeat(6)}</div>`);
  let r;
  try { r = await api("/api/radar"); }
  catch (e) {
    if (!host?.isConnected) return;
    el.innerHTML = page(`<div class="callout err">${icon("alert")}<span>No pudimos cargar el radar: ${esc(e.message)}</span><button class="btn sm" id="retry">Reintentar</button></div>`);
    el.querySelector("#retry").onclick = () => renderRadar(el);
    return;
  }
  if (host?.isConnected) draw(r);
}
const page = body => `<div class="page"><div class="page-head"><div><h1>Radar</h1><p>Colegios nuevos que encontró el agente en los últimos 7 días.</p></div></div>${body}</div>`;

function draw(r) {
  const last = r.runs[0];
  const cs = Object.entries(r.countries).sort((a, b) => b[1].cities - a[1].cities);
  const totCities = cs.reduce((a, [, c]) => a + c.cities, 0), scanned = cs.reduce((a, [, c]) => a + c.scanned, 0);
  const pct = totCities ? Math.round(scanned / totCities * 100) : 0;
  const withPhone = r.top.filter(q => q.phone);
  const list = all ? r.top : r.top.slice(0, 8);
  const status = last ? `Última corrida ${ago(last.at)} · ${fmt(last.cities.length)} ciudades · ${fmt(last.added)} nuevos${last.studies ? ` · ${fmt(last.studies)} estudios` : ""}` : "Todavía no corrió";
  host.innerHTML = page(`
    <section class="card hero" aria-label="Resumen del radar">
      <div class="ring" style="--p:${pct}" role="img" aria-label="El agente revisó el ${pct}% de las ciudades"><b>${pct}%<small>del mapa</small></b></div>
      <div class="hero-txt"><h2>${r.weekNew ? `${fmt(r.weekNew)} colegios nuevos esta semana` : "Sin colegios nuevos esta semana"}</h2>
        <div class="kpis"><div class="kpi"><b>${fmt(r.weekPhone)}</b><span>con teléfono, listos para llamar</span></div><div class="kpi"><b>${fmt(r.fromRadar)}</b><span>encontrados en total</span></div></div>
      </div>
      <div class="hero-cta">${withPhone.length ? `<button class="btn primary lg" id="sessNew">${icon("play")} Llamar a ${withPhone.length < r.weekPhone ? `los ${fmt(withPhone.length)} mejores` : fmt(withPhone.length)}</button>` : ""}</div>
    </section>
    <div class="today-grid">
      <section class="card" aria-labelledby="hOp"><div class="card-h"><h2 id="hOp">${icon("flame")} Mejores oportunidades nuevas</h2></div><div class="card-b">
        ${list.length ? list.map(q => `<button class="prospect" data-school="${esc(q.id)}"><span class="score ${q.score >= 60 ? "" : q.score >= 40 ? "mid" : "low"}" title="Prioridad ${q.score} de 100" aria-label="Prioridad ${q.score} de 100">${q.score}</span><span class="t"><b class="wrap2">${esc(q.name)}</b><small>${esc(q.city)}, ${esc(q.country)}${q.phone ? "" : " · sin teléfono"}</small><span class="why">${[...new Set([...q.opp.filter(o => !/^Privado confirmado/.test(o)), ...q.reasons.filter(x => !/Sin revisar|Nuevo en el radar|Nunca contactado/.test(x))])].slice(0, 3).map(x => `<span class="tag">${esc(x)}</span>`).join("")}</span></span>${icon("arrowRight", "faint")}</button>`).join("")
          + (r.top.length > 8 ? `<button class="btn ghost sm block" id="moreOp">${all ? "Ver menos" : `Ver ${r.top.length - 8} más`}</button>` : "")
          : `<div class="empty">${icon("target")}<span>Cuando el agente encuentre colegios nuevos, los mejores aparecen acá.</span></div>`}
      </div></section>
      <div class="stack">
        ${r.topCities.length ? `<section class="card" aria-labelledby="hCi"><div class="card-h"><h2 id="hCi">${icon("map")} Dónde encontró más</h2></div><div class="card-b">${r.topCities.map(c => `<button class="city-row" data-city="${esc(c.city)}" data-country="${esc(c.country)}"><span class="t"><b>${esc(c.city)}</b><small>${esc(c.country)}</small></span><span class="num"><b>${fmt(c.n)}</b></span></button>`).join("")}</div></section>` : ""}
        <details class="card agent"><summary class="card-h"><h2>${icon("clock")} Estado del agente</h2><span class="sub">${esc(status)}</span></summary><div class="card-b">
          ${cs.length ? cs.map(([n, c]) => `<div class="cov"><div class="cov-h"><b>${esc(n)}</b><span class="muted">${fmt(c.scanned)}/${fmt(c.cities)} ciudades · ${fmt(c.schools)} colegios</span></div><div class="bar"><span style="width:${c.cities ? Math.max(c.scanned / c.cities * 100, c.scanned ? 2 : 0) : 0}%;background:var(--accent)"></span></div></div>`).join("") : `<p class="muted" style="margin:0">Se completa en la primera corrida.</p>`}
          ${r.runs.length ? `<div class="sub-h">Últimas corridas</div>${r.runs.slice(0, 6).map(x => `<div class="run"><b>${fmt(x.added)} nuevos</b> en ${fmt(x.cities.length)} ciudades${x.errors?.length ? ` · <span style="color:var(--err)">${x.errors.length} con error</span>` : ""}<small>${esc(ago(x.at))} · ${Math.round(x.minutes)} min</small></div>`).join("")}` : ""}
        </div></details>
      </div>
    </div>`);
  host.querySelectorAll("[data-school]").forEach(b => b.onclick = () => openSchool(b.dataset.school));
  host.querySelector("#moreOp")?.addEventListener("click", () => { all = !all; draw(r); });
  host.querySelectorAll("[data-city]").forEach(b => b.onclick = () => { openCityFromOutside(b.dataset.country, b.dataset.city); go("prospectar"); });
  host.querySelector("#sessNew")?.addEventListener("click", () => startSession(withPhone.map(q => q.id), "nuevos del radar", { origin: { kind: "radar", key: `radar:${new Date().toLocaleDateString("sv")}` } }));
}
