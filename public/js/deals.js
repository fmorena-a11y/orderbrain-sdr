// Tratos abiertos (#/tratos): en qué etapa está cada trato de venta y qué sigue (pedido del líder de SDR: «que sea utilizable
// por los accounts»). Solo lectura: tocar un trato abre su ficha (el colegio si está cruzado, si no la organización) y al lado
// «Abrir en Pipedrive». Arriba los indicadores de lo filtrado; dos modos: «Por etapa» (columnas del embudo elegido, en orden;
// en el celular pasan a lista) y «Lista» (ordenable por días en la etapa, próxima actividad o valor). El alcance lo decide el
// servidor (GET /api/deals/open, lib/deals-api.js): «Míos» para todos; una persona o el equipo, para líderes y dirección.
// Nunca se inventa: lo que no se sabe no se muestra o va «?».
import { S, api, esc, icon, norm, save, loadPref, dayLabel, toast, TYPE_ICON, teamSelect, teamView, teamQuery, setTeamView, ago } from "./core.js";
import { openSchool, openRecord } from "./school.js";

let host = null, seq = 0;
const cache = new Map(); // lo leído por alcance (volver a la vista lo muestra al instante y se actualiza atrás)
const F = {
  owner: String(loadPref("deals.owner", "me") || "me"), pipe: Number(loadPref("deals.pipe", 0)) || 0, stage: 0,
  mode: loadPref("deals.mode", "board") === "list" ? "list" : "board", sort: ["days", "next", "value"].includes(loadPref("deals.sort", "days")) ? loadPref("deals.sort", "days") : "days",
  noNext: false, stale: false, overdue: false, q: "",
};
let D = null, more = { list: 100, cols: new Set() };
const keyOf = () => `${F.owner}|${F.owner === "team" ? teamView() : ""}`;

// Abrir la vista ya filtrada (desde el «Hoy» del líder, leadhome.js): owner = "team" (el equipo que se mira) o el id de Pipedrive
// de una persona; attention: con el chip que corresponda ("noNext", "stale" u "overdue"). El servidor vuelve a controlar el alcance.
export function showDeals({ owner = "team", attention = "" } = {}) {
  F.owner = String(owner || "me"); save("deals.owner", F.owner);
  F.pipe = 0; F.stage = 0; F.q = ""; F.noNext = attention === "noNext"; F.stale = attention === "stale"; F.overdue = attention === "overdue";
  if (attention) { F.mode = "list"; F.sort = attention === "stale" ? "days" : "next"; }
  more = { list: 100, cols: new Set() };
  if (location.hash !== "#/tratos") location.hash = "#/tratos"; else if (host?.isConnected) renderDeals(host);
}
export function renderDeals(el) {
  host = el;
  if (!S.profile?.leader && F.owner !== "me") F.owner = "me";
  D = cache.get(keyOf()) || null;
  draw();
  load();
}
async function load({ force = false } = {}) {
  const my = ++seq, k = keyOf(), tq = F.owner === "team" ? teamQuery() : "";
  if (force) cache.delete(k);
  try {
    const r = await api(`/api/deals/open?owner=${encodeURIComponent(F.owner)}${tq ? "&" + tq : ""}`);
    cache.set(k, { data: r });
  } catch (e) {
    // otra persona que ya no te toca (o un equipo que no es tuyo): vuelve a «Míos»
    if (e.status === 403 && F.owner !== "me") { F.owner = "me"; save("deals.owner", "me"); toast(e.message, { type: "err" }); return load(); }
    if (!cache.get(k)?.data) cache.set(k, { error: e.message });
  }
  if (my !== seq || !host?.isConnected) return;
  D = cache.get(k); draw();
}

// ---------- formato
const fmtN = n => Number(n).toLocaleString("es");
function money(v, cur) {
  if (v == null) return "";
  try { return new Intl.NumberFormat("es", { style: "currency", currency: cur || "USD", maximumFractionDigits: 0 }).format(v); } catch { return `${fmtN(v)} ${cur || ""}`.trim(); }
}
const typeName = t => S.types?.[t] || t || "Actividad";
const when = a => `${dayLabel(a.date)}${a.time ? " " + a.time : ""}`;
const daysTxt = n => n == null ? "?" : n === 0 ? "hoy" : n === 1 ? "1 día" : `${n} días`;
const pdUrl = id => `${D?.data?.pdWeb || S.pdWeb}/deal/${id}`;
const skel = n => '<div class="skel" style="margin:12px 0"></div>'.repeat(n);

// ---------- filtros (todo en el navegador sobre lo que mandó el servidor)
function filtered({ withPipe = true, withStage = true } = {}) {
  const rows = D?.data?.deals || [], q = norm(F.q);
  return rows.filter(r => (!withPipe || !F.pipe || r.pipe.id === F.pipe) && (!withStage || !F.stage || r.stage.id === F.stage)
    && (!F.noNext || (!r.next && !r.nextUnknown)) && (!F.stale || r.stale) && (!F.overdue || r.next?.overdue)
    && (!q || norm(`${r.title} ${r.org?.name || ""} ${r.school?.name || ""} ${r.school?.city || ""}`).includes(q)));
}
// el embudo que se mira: el elegido si tiene tratos; si no (o «Por etapa» sin elegir), el que más tiene
function pickPipe() {
  const pipes = D?.data?.pipes || [];
  if (F.pipe && !pipes.some(p => p.id === F.pipe)) F.pipe = 0;
  if (F.mode === "board" && !F.pipe && pipes.length) F.pipe = pipes[0].id;
  const p = pipes.find(x => x.id === F.pipe);
  if (F.stage && !p?.stages.some(s => s.id === F.stage)) F.stage = 0;
}
function summary(rows) {
  const by = new Map();
  for (const r of rows) if (r.value != null) by.set(r.currency, (by.get(r.currency) || 0) + r.value);
  return { n: rows.length, value: [...by].sort((a, b) => b[1] - a[1]), noNext: rows.filter(r => !r.next && !r.nextUnknown).length,
    stale: rows.filter(r => r.stale).length, overdue: rows.filter(r => r.next?.overdue).length };
}

// ---------- pantalla
function draw() {
  if (!host?.isConnected) return;
  const d = D?.data, leader = !!S.profile?.leader;
  if (d) pickPipe();
  const head = `<div class="page-head"><div><h1>Tratos abiertos</h1><p>En qué etapa está cada trato y qué sigue. Tocá uno para abrir su ficha.</p></div>
    <button class="btn sm" id="dlRefresh" title="Volver a leer de Pipedrive">${icon("refresh", "sm")} Actualizar</button></div>`;
  if (!d) {
    host.innerHTML = `<div class="page dl">${head}${D?.error ? `<div class="callout err">${icon("alert")}<span>No pudimos cargar los tratos: ${esc(D.error)}</span><button class="btn sm" id="dlRetry">Reintentar</button></div>` : skel(4)}</div>`;
    host.querySelector("#dlRetry")?.addEventListener("click", () => { D = null; draw(); load({ force: true }); });
    host.querySelector("#dlRefresh").onclick = () => load({ force: true });
    return;
  }
  const rows = filtered(), k = summary(rows);
  host.innerHTML = `<div class="page dl">${head}
    <div class="mx-filters dl-filters">
      ${leader ? ownerSelect(d) : ""}
      ${leader && F.owner === "team" ? teamSelect("dlTeam") : ""}
      <label class="field" style="margin:0"><span>Embudo</span><select class="inp" id="dlPipe">${F.mode === "list" ? `<option value="0">Todos (${fmtN(d.deals.length)})</option>` : ""}${d.pipes.map(p => `<option value="${p.id}" ${p.id === F.pipe ? "selected" : ""}>${esc(p.name || "Embudo " + p.id)} (${fmtN(p.n)})</option>`).join("")}</select></label>
      ${F.pipe ? `<label class="field" style="margin:0"><span>Etapa</span><select class="inp" id="dlStage"><option value="0">Todas</option>${(d.pipes.find(p => p.id === F.pipe)?.stages || []).map(s => `<option value="${s.id}" ${s.id === F.stage ? "selected" : ""}>${esc(s.name || "?")} (${fmtN(s.n)})</option>`).join("")}</select></label>` : ""}
      <label class="field dl-q" style="margin:0"><span>Buscar</span><input class="inp" id="dlQ" type="search" placeholder="Colegio u organización" value="${esc(F.q)}" autocomplete="off"></label>
    </div>
    <div class="dl-bar">
      <div class="chips" role="group" aria-label="Filtros">
        <button class="chip" data-f="noNext" aria-pressed="${F.noNext}">Sin próximo paso</button>
        <button class="chip" data-f="stale" aria-pressed="${F.stale}">Quietos +${d.staleDays || 14} días</button>
        <button class="chip" data-f="overdue" aria-pressed="${F.overdue}">Con actividad vencida</button>
      </div>
      <div class="chips" role="group" aria-label="Cómo verlos">
        <button class="chip" data-m="board" aria-pressed="${F.mode === "board"}">${icon("table", "sm")} Por etapa</button>
        <button class="chip" data-m="list" aria-pressed="${F.mode === "list"}">${icon("list", "sm")} Lista</button>
      </div>
    </div>
    <p class="mx-src" style="margin:0 0 12px">${esc(scopeTxt(d))} · Pipedrive, leído ${esc(ago(d.at))}</p>
    ${d.truncated ? `<div class="callout warn" style="margin:0 0 12px">${icon("alert")}<span>Pipedrive devolvió la lista cortada: puede haber más tratos que no se ven acá.</span></div>` : ""}
    ${kpis(k)}
    ${!d.deals.length ? `<div class="empty">${icon("deal")}<b>${d.scope.self ? "No tenés tratos abiertos." : "No hay tratos abiertos acá."}</b><span>Solo cuentan los embudos de venta (no los de clientes).</span></div>`
      : !rows.length ? `<div class="empty">${icon("search")}<b>Ningún trato con estos filtros.</b><button class="linkbtn" id="dlClear">Sacar filtros</button></div>`
      : F.mode === "board" ? board(rows) : list(rows)}
  </div>`;
  bind();
}
function ownerSelect(d) {
  // sin equipos, «el equipo» es toda la cuenta; dirección elige al lado un equipo o «Toda la cuenta»; un líder, su equipo
  const sc = S.profile?.scope, teamLbl = sc?.on && sc?.all ? "Un equipo o toda la cuenta" : "Todo el equipo";
  const people = (d.people || []).filter(p => p.id !== S.me?.pdUserId);
  return `<label class="field" style="margin:0"><span>Persona</span><select class="inp" id="dlOwner">
    <option value="me" ${F.owner === "me" ? "selected" : ""}>Míos</option>
    <option value="team" ${F.owner === "team" ? "selected" : ""}>${teamLbl}</option>
    ${people.map(p => `<option value="${p.id}" ${F.owner === String(p.id) ? "selected" : ""}>${esc(p.name || "?")}</option>`).join("")}</select></label>`;
}
function scopeTxt(d) {
  const s = d.scope;
  if (s.kind === "person") return s.self ? "Tus tratos: los que tenés a tu nombre y donde figurás como SDR" : `Tratos de ${s.person?.name || "?"} (dueño o SDR)`;
  if (s.kind === "team") return `Equipo ${s.team?.name || ""}: tratos de su gente (dueño o SDR)`;
  return "Toda la cuenta";
}
function kpis(k) {
  const val = k.value.length ? k.value.map(([c, v]) => `<b class="dl-money">${esc(money(v, c))}</b>`).join("") : "<b>—</b>";
  const tile = (v, l, f, warn) => `<button class="card mx-kpi dl-kpi ${warn && v ? "warn" : ""}" ${f ? `data-k="${f}" aria-pressed="${!!F[f]}"` : "disabled"}><span class="l">${esc(l)}</span><b>${fmtN(v)}</b></button>`;
  return `<div class="mx-kpis dl-kpis">
    ${tile(k.n, "Tratos")}
    <div class="card mx-kpi dl-kpi"><span class="l">Valor</span>${val}<small>suma de los que tienen valor cargado</small></div>
    ${tile(k.noNext, "Sin próximo paso", "noNext", true)}
    ${tile(k.stale, `Quietos +${D?.data?.staleDays || 14} días en la etapa`, "stale", true)}
    ${tile(k.overdue, "Próxima vencida", "overdue", true)}
  </div>`;
}
// una tarjeta de trato (tablero y lista en el celular)
function nextHtml(r) {
  if (r.next) return `<span class="dl-next ${r.next.overdue ? "late" : ""}" title="${esc(r.next.subject)}">${icon(TYPE_ICON[r.next.type] || "calendar", "sm")}<span>${esc(typeName(r.next.type))} · ${esc(when(r.next))}${r.next.overdue ? " · vencida" : ""}</span></span>`;
  if (r.nextUnknown) return `<span class="dl-next" title="Pipedrive dice que tiene una, pero no la pude leer">${icon("calendar", "sm")}<span>Próxima: ?</span></span>`;
  return `<span class="dl-next none">${icon("alert", "sm")}<span>Sin próximo paso</span></span>`;
}
const who = r => [r.owner ? `Dueño: ${r.owner.name || "?"}` : "", r.sdr ? `SDR: ${r.sdr.name || "?"}` : ""].filter(Boolean).join(" · ");
const place = r => r.school ? [r.school.name, r.school.city].filter(Boolean).join(" · ") : r.org?.name || "Sin organización";
function card(r, { stage = false } = {}) {
  return `<article class="dl-card">
    <button class="dl-open" data-open="${r.id}">
      <b class="dl-t">${esc(r.title || "Trato sin título")}</b>
      <small>${r.school ? icon("building", "sm") : ""}${esc(place(r))}</small>
      ${stage ? `<small class="dl-stage">${esc(r.pipe.name)} · ${esc(r.stage.name || "?")}</small>` : ""}
      <span class="dl-meta"><span class="dl-days ${r.stale ? "late" : ""}" title="Días en la etapa">${icon("clock", "sm")}${esc(daysTxt(r.days))} en la etapa</span>${r.value != null ? `<span class="dl-val">${esc(money(r.value, r.currency))}</span>` : ""}${r.proposal ? `<span class="stage-tag deal">Propuesta enviada</span>` : ""}</span>
      ${nextHtml(r)}
      ${r.last ? `<small class="dl-last">Última hecha: ${esc(typeName(r.last.type))} · ${esc(dayLabel(r.last.date))}</small>` : ""}
      ${who(r) ? `<small class="dl-who">${esc(who(r))}</small>` : ""}
    </button>
    <a class="dl-pd" href="${esc(pdUrl(r.id))}" target="_blank" rel="noopener" title="Abrir en Pipedrive" aria-label="Abrir «${esc(r.title)}» en Pipedrive">${icon("external", "sm")}<span>Pipedrive</span></a>
  </article>`;
}
const COL_MAX = 30;
function board(rows) {
  const p = D.data.pipes.find(x => x.id === F.pipe);
  if (!p) return "";
  const stages = p.stages.filter(s => !F.stage || s.id === F.stage);
  return `<div class="dl-board" style="--cols:${stages.length}">${stages.map(s => {
    const l = rows.filter(r => r.stage.id === s.id), open = more.cols.has(s.id), shown = open ? l : l.slice(0, COL_MAX), v = summary(l).value;
    return `<section class="dl-col" aria-label="${esc(s.name)}"><header><b>${esc(s.name || "?")}</b><span class="dl-n">${fmtN(l.length)}</span>${v.length ? `<small>${v.map(([c, x]) => esc(money(x, c))).join(" · ")}</small>` : ""}</header>
      <div class="dl-cards">${shown.map(r => card(r)).join("") || `<p class="dl-none">Ninguno</p>`}${l.length > shown.length ? `<button class="btn sm block" data-more="${s.id}">Ver ${fmtN(l.length - shown.length)} más</button>` : ""}</div></section>`;
  }).join("")}</div>`;
}
function list(rows) {
  const by = { days: (a, b) => (b.days ?? -1) - (a.days ?? -1), value: (a, b) => (b.value ?? -1) - (a.value ?? -1),
    next: (a, b) => (a.next ? a.next.date + (a.next.time || "99:99") : a.nextUnknown ? "9998" : "9999").localeCompare(b.next ? b.next.date + (b.next.time || "99:99") : b.nextUnknown ? "9998" : "9999") }[F.sort];
  const l = [...rows].sort((a, b) => by(a, b) || a.id - b.id), shown = l.slice(0, more.list);
  const th = (k, t) => `<button class="dl-sort" data-sort="${k}" aria-pressed="${F.sort === k}">${esc(t)}${F.sort === k ? icon("chevDown", "sm") : ""}</button>`;
  return `<div class="dl-list" role="list">
    <div class="dl-lh"><span>Trato</span><span>Etapa</span>${th("days", "Días en etapa")}${th("next", "Próxima actividad")}${th("value", "Valor")}<span>Dueño y SDR</span><span></span></div>
    <div class="dl-sorts" role="group" aria-label="Ordenar por">${th("days", "Días en etapa")}${th("next", "Próxima")}${th("value", "Valor")}</div>
    ${shown.map(r => `<div class="dl-row" role="listitem">
      <button class="dl-open" data-open="${r.id}"><b class="dl-t">${esc(r.title || "Trato sin título")}</b><small>${esc(place(r))}</small></button>
      <span class="dl-c-stage">${esc(r.pipe.name)} · <b>${esc(r.stage.name || "?")}</b>${r.proposal ? ` <span class="stage-tag deal">Propuesta enviada</span>` : ""}</span>
      <span class="dl-days ${r.stale ? "late" : ""}">${icon("clock", "sm")}${esc(daysTxt(r.days))}</span>
      ${nextHtml(r)}
      <span class="dl-val">${r.value != null ? esc(money(r.value, r.currency)) : ""}</span>
      <small class="dl-who">${esc(who(r))}</small>
      <a class="dl-pd" href="${esc(pdUrl(r.id))}" target="_blank" rel="noopener" title="Abrir en Pipedrive" aria-label="Abrir «${esc(r.title)}» en Pipedrive">${icon("external", "sm")}<span>Pipedrive</span></a>
    </div>`).join("")}
    ${l.length > shown.length ? `<button class="btn block" id="dlMore">Mostrar ${fmtN(Math.min(100, l.length - shown.length))} más (quedan ${fmtN(l.length - shown.length)})</button>` : ""}
  </div>`;
}

function bind() {
  const $q = s => host.querySelector(s);
  $q("#dlRefresh").onclick = () => load({ force: true });
  $q("#dlOwner")?.addEventListener("change", e => { F.owner = e.target.value; save("deals.owner", F.owner); F.pipe = 0; reset(); D = cache.get(keyOf()) || null; draw(); load(); });
  $q("#dlTeam")?.addEventListener("change", e => { setTeamView(e.target.value); F.pipe = 0; reset(); D = cache.get(keyOf()) || null; draw(); load(); });
  $q("#dlPipe")?.addEventListener("change", e => { F.pipe = Number(e.target.value) || 0; F.stage = 0; save("deals.pipe", F.pipe); reset(); draw(); });
  $q("#dlStage")?.addEventListener("change", e => { F.stage = Number(e.target.value) || 0; reset(); draw(); });
  const q = $q("#dlQ"); let t = null;
  q.oninput = () => { clearTimeout(t); t = setTimeout(() => { F.q = q.value; reset(); draw(); const n = host.querySelector("#dlQ"); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }, 200); };
  host.querySelectorAll("[data-f],[data-k]").forEach(b => b.onclick = () => { const f = b.dataset.f || b.dataset.k; F[f] = !F[f]; reset(); draw(); });
  host.querySelectorAll("[data-m]").forEach(b => b.onclick = () => { F.mode = b.dataset.m; save("deals.mode", F.mode); reset(); draw(); });
  host.querySelectorAll("[data-sort]").forEach(b => b.onclick = () => { F.sort = b.dataset.sort; save("deals.sort", F.sort); draw(); });
  host.querySelectorAll("[data-more]").forEach(b => b.onclick = () => { more.cols.add(Number(b.dataset.more)); draw(); });
  $q("#dlMore")?.addEventListener("click", () => { more.list += 100; draw(); });
  $q("#dlClear")?.addEventListener("click", () => { Object.assign(F, { noNext: false, stale: false, overdue: false, q: "", stage: 0 }); reset(); draw(); });
  host.querySelectorAll("[data-open]").forEach(b => b.onclick = () => openDeal(Number(b.dataset.open)));
}
const reset = () => { more = { list: 100, cols: new Set() }; };
// la ficha: el colegio de la base si la organización está cruzada; si no, la de la organización de Pipedrive
function openDeal(id) {
  const r = D?.data?.deals.find(x => x.id === id); if (!r) return;
  if (r.school && S.byId.has(r.school.id)) return openSchool(r.school.id);
  if (r.org) return openRecord(`org:${r.org.id}`);
  toast("Este trato no tiene organización: abrilo en Pipedrive.", { type: "info", href: pdUrl(r.id), action: "Abrir en Pipedrive" });
}
