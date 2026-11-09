// Radar: lo que encuentra el agente de prospección que recorre todas las ciudades cada 2 horas.
import { S, api, esc, icon, ago, toast } from "./core.js";
import { openSchool, startSession } from "./school.js";

let host;
export async function renderRadar(el) {
  host = el;
  el.innerHTML = `<div class="page"><div class="page-head"><div><h1>Radar</h1><p>Cargando lo que encontró el agente…</p></div></div></div>`;
  let r;
  try { r = await api("/api/radar"); } catch (e) { el.innerHTML = `<div class="page"><div class="callout err">${icon("alert")}${esc(e.message)}</div></div>`; return; }
  if (!host?.isConnected) return;
  const last = r.runs[0];
  const cs = Object.entries(r.countries).sort((a, b) => b[1].cities - a[1].cities);
  const totCities = cs.reduce((a, [, c]) => a + c.cities, 0), scanned = cs.reduce((a, [, c]) => a + c.scanned, 0);
  const pct = totCities ? Math.round(scanned / totCities * 100) : 0;
  el.innerHTML = `<div class="page">
    <div class="page-head"><div><h1>Radar</h1><p>Un agente recorre todas las ciudades de más de 40.000 habitantes de cada país cada 2 horas y suma los colegios privados que todavía no tenemos. Los nuevos entran solos en «A quién llamar».</p></div>
      ${r.top.length ? `<button class="btn primary" id="sessNew">${icon("play")} Sesión con los nuevos</button>` : ""}</div>
    <section class="card hero" style="grid-template-columns:auto 1fr">
      <div class="ring" style="--p:${pct}" role="img" aria-label="${pct}% de las ciudades escaneadas"><b>${pct}%<small>ciudades</small></b></div>
      <div><h2>${last ? `Última corrida ${esc(ago(last.at))}` : "El radar todavía no corrió"}</h2>
        <p>${last ? `Revisó ${last.cities.length} ciudades y sumó ${last.added} colegios${last.photos ? `, ${last.photos} con foto` : ""}.` : "La primera corrida arranca sola en GitHub Actions. Mientras, la base tiene los colegios cargados a mano."}</p>
        <div class="kpis"><div class="kpi"><b>${r.total.toLocaleString("es")}</b><span>colegios en la base</span></div><div class="kpi"><b>${r.fromRadar.toLocaleString("es")}</b><span>encontrados por el radar</span></div><div class="kpi"><b>${r.weekNew.toLocaleString("es")}</b><span>nuevos esta semana</span></div><div class="kpi"><b>${scanned}/${totCities}</b><span>ciudades revisadas</span></div></div>
      </div>
    </section>
    ${!r.google ? `<div class="callout info" style="margin-bottom:16px">${icon("sparkles")}<span>Con una clave de Google Maps el radar suma teléfono, rating y fotos de Google de cada colegio nuevo. Hoy usa OpenStreetMap, la web de cada colegio y la vista satelital.</span></div>` : ""}
    <div class="today-grid">
      <section class="card"><div class="card-h"><h2>${icon("flame")} Mejores oportunidades nuevas</h2><span class="sub">últimos 7 días</span></div><div class="card-b">
        ${r.top.length ? r.top.map(q => `<button class="prospect" data-school="${esc(q.id)}"><span class="score ${q.score >= 60 ? "" : q.score >= 40 ? "mid" : "low"}">${q.score}</span><span class="t"><b>${esc(q.name)}</b><small>${esc(q.city)}, ${esc(q.country)}${q.phone ? "" : " · sin teléfono"}</small><span class="why">${[...new Set([...q.opp, ...q.reasons.filter(x => !/Sin revisar|Nuevo en el radar/.test(x))])].slice(0, 4).map(x => `<span class="tag">${esc(x)}</span>`).join("")}</span></span>${icon("arrowRight", "faint")}</button>`).join("")
          : `<div class="empty">${icon("target")}<span>Cuando el radar encuentre colegios nuevos, los mejores aparecen acá.</span></div>`}
      </div></section>
      <div class="stack">
        <section class="card"><div class="card-h"><h2>${icon("globe")} Cobertura por país</h2></div><div class="card-b">
          ${cs.length ? cs.map(([n, c]) => `<div class="cov"><div class="cov-h"><b>${esc(n)}</b><span class="muted">${c.scanned}/${c.cities} ciudades · ${c.schools.toLocaleString("es")} colegios</span></div><div class="bar"><span style="width:${c.cities ? c.scanned / c.cities * 100 : 0}%;background:var(--accent)"></span></div></div>`).join("")
            : `<p class="muted" style="margin:0">Todavía sin datos. Se completa en la primera corrida.</p>`}
        </div></section>
        ${r.topCities.length ? `<section class="card"><div class="card-h"><h2>${icon("map")} Dónde encontró más</h2><span class="sub">esta semana</span></div><div class="card-b">${r.topCities.map(([c, n]) => `<div class="rank" style="grid-template-columns:1fr auto"><span>${esc(c)}</span><span class="num"><b>${n}</b></span></div>`).join("")}</div></section>` : ""}
        <section class="card"><div class="card-h"><h2>${icon("clock")} Corridas</h2></div><div class="card-b">
          ${r.runs.length ? r.runs.map(x => `<div class="feed-item" style="grid-template-columns:1fr"><div><b>${x.added} nuevos</b> en ${x.cities.length} ciudades${x.errors?.length ? ` · <span style="color:var(--err)">${x.errors.length} errores</span>` : ""}<br><small>${esc(ago(x.at))} · ${x.minutes} min${x.cities.length ? " · " + esc(x.cities.slice(0, 4).map(c => c.city).join(", ")) + (x.cities.length > 4 ? "…" : "") : ""}</small></div></div>`).join("")
            : `<p class="muted" style="margin:0">Sin corridas todavía.</p>`}
        </div></section>
      </div>
    </div></div>`;
  el.querySelectorAll("[data-school]").forEach(b => b.onclick = () => openSchool(b.dataset.school));
  el.querySelector("#sessNew")?.addEventListener("click", () => {
    const ids = r.top.filter(q => q.phone).map(q => q.id);
    if (!ids.length) return toast("Los nuevos de esta semana todavía no tienen teléfono", { type: "err" });
    startSession(ids, "nuevos del radar");
  });
}
