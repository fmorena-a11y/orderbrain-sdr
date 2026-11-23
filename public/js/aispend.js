// Equipo › «Gasto de IA» (solo quien ve todo): cuánto se gasta en Claude, separado en API (lo que gasta la app con la clave,
// medido por lib/aibudget.js desde el 23/11/2026, más lo de antes cargado a mano desde la consola de Anthropic) y
// suscripciones (precio fijo por mes, cargado a mano). GET /api/admin/ai-spend, POST /api/admin/ai-spend/plan.
import { api, esc, icon, toast } from "./core.js";

const usd = (n, d = 2) => n == null ? "?" : "US$" + Number(n).toLocaleString("es-AR", { minimumFractionDigits: d, maximumFractionDigits: d });
const FEAT = { estudio: "Estudios de colegios", resumen: "Resumen con IA (Historial)", preparar: "Preparar llamada", mensaje: "Armar mensaje con IA", asistente: "Asistente", nota: "Ordenar nota al registrar", verificar: "Verificar colegios (buscador de zonas)" };
const MES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const monthName = m => `${MES[Number(m.slice(5)) - 1]} ${m.slice(0, 4)}`;
let data = null, editing = false;

export async function renderSpend(box, { reload = false } = {}) {
  if (!data || reload) {
    box.innerHTML = '<div class="skel" style="margin:14px 0"></div>'.repeat(4);
    try { data = await api("/api/admin/ai-spend"); }
    catch (e) { box.innerHTML = `<div class="callout err">${icon("alert")}<span>No pude leer el gasto: ${esc(e.message)}</span><button class="btn sm" id="spRetry">Reintentar</button></div>`; box.querySelector("#spRetry").onclick = () => renderSpend(box, { reload: true }); return; }
  }
  draw(box);
}

let chartBy = "day";
try { chartBy = localStorage.getItem("ob.spend.by") || "day"; } catch {}
const ddmm = d => `${d.slice(8)}/${d.slice(5, 7)}`;
function draw(box) {
  const d = data, L = d.limits, P = d.periods, cur = d.months[0];
  const pct = (a, b) => b > 0 ? Math.min(100, Math.round(a / b * 100)) : 0;
  const bar = (a, b) => `<span class="sp-meter" role="img" aria-label="${pct(a, b)} % del tope"><i style="width:${pct(a, b)}%" class="${pct(a, b) >= 80 ? "hot" : ""}"></i></span>`;
  const split = x => `<span class="sp-two"><span>${icon("bolt", "sm")} API ${usd(x.api)}</span><span>${icon("user", "sm")} Suscripción ${usd(x.subs)}</span></span>`;
  const tiles = [
    { l: "Hoy", x: P.day, m: bar(d.days[0].total, L.day), s: `API de la app: ${usd(d.days[0].total)} de ${usd(L.day, 0)} (tope del día)` },
    { l: "Esta semana", x: P.week, s: `de lunes ${ddmm(d.weeks[0].from)} a hoy` },
    { l: `Este mes`, x: P.month, m: bar(d.monthApp, L.month), s: `API de la app: ${usd(d.monthApp)} de ${usd(L.month, 0)} (tope del mes)${cur.manual ? ` · ${usd(cur.manual)} cargado a mano` : ""}` },
    { l: `Este año (${d.today.slice(0, 4)})`, x: P.year, s: "de enero a hoy" },
  ];
  // serie elegida: por día (31), por semana (12) o por mes (12), de la más vieja a la más nueva; API y suscripción apiladas
  const S = chartBy === "week" ? [...d.weeks].reverse().map(w => ({ k: ddmm(w.from), t: `Semana del ${ddmm(w.from)}`, api: w.api, subs: w.subs }))
    : chartBy === "month" ? [...d.months].reverse().map(m => ({ k: `${MES[Number(m.month.slice(5)) - 1].slice(0, 3)} ${m.month.slice(2, 4)}`, t: monthName(m.month), api: m.api, subs: m.subs }))
    : [...d.days].reverse().map(x => ({ k: ddmm(x.day), t: ddmm(x.day), api: x.total, subs: (d.months.find(m => m.month === x.day.slice(0, 7))?.subs || 0) / new Date(Date.UTC(+x.day.slice(0, 4), +x.day.slice(5, 7), 0)).getUTCDate() }));
  const cap = chartBy === "day" ? L.day : chartBy === "month" ? L.month : null;
  const max = Math.max(cap || 0, ...S.map(x => x.api)) || 1;
  const chart = `<div class="sp-by" role="group" aria-label="Ver por">${[["day", "Por día"], ["week", "Por semana"], ["month", "Por mes"]].map(([k, l]) => `<button type="button" class="chip" aria-pressed="${chartBy === k}" data-by="${k}">${l}</button>`).join("")}</div>
    <div class="sp-chart" role="img" aria-label="Gasto ${chartBy === "day" ? "por día" : chartBy === "week" ? "por semana" : "por mes"}">
    ${cap ? `<span class="sp-cap" style="bottom:${cap / max * 100}%"><span>tope de la API ${usd(cap, 0)}</span></span>` : ""}
    ${S.map(x => `<span class="sp-col" title="${esc(`${x.t}: API ${usd(x.api)}`)}"><i style="height:${x.api / max * 100}%" class="${cap && x.api >= cap ? "hot" : x.api ? "" : "zero"}"></i></span>`).join("")}
  </div><div class="sp-axis"><span>${esc(S[0].k)}</span><span class="sp-leg">solo la API (lo que varía con el uso; la suscripción es fija)</span><span>${esc(S[S.length - 1].k)}</span></div>`;
  // por función y por persona: el mes en curso (suma de los días del mes)
  const inMonth = d.days.filter(x => x.day.startsWith(cur.month)), sum = k => { const o = {}; for (const x of inMonth) for (const [n, v] of Object.entries(x[k])) o[n] = (o[n] || 0) + v; return Object.entries(o).sort((a, b) => b[1] - a[1]); };
  const rows = (list, name) => list.length ? `<div class="sp-rows">${list.map(([n, v]) => `<div class="sp-row"><span>${esc(name(n))}</span><b>${usd(v)}</b></div>`).join("")}</div>` : `<p class="muted">Sin gasto registrado este mes.</p>`;
  const months = `<div class="sp-rows">${d.months.map(m => `<div class="sp-row"><span>${esc(monthName(m.month))}</span><span class="sp-split"><span title="API">${icon("bolt", "sm")} ${usd(m.api)}</span><span title="Suscripciones">${icon("user", "sm")} ${usd(m.subs)}</span><b>${usd(m.api + m.subs)}</b></span></div>`).join("")}</div>`;
  box.innerHTML = `<p class="muted sp-intro"><b>API</b>: lo que gasta la app OrderBrain SDR con la clave de Anthropic (se cobra por uso; la app lo mide desde el 23/11/2026 y lo de antes se carga a mano). <b>Suscripciones</b>: los planes de Claude de cada persona (precio fijo por mes; cargalos abajo). Lo que usás en Claude Code o en claude.ai sale de la suscripción, no de la API.</p>
    ${d.plan.unknown ? `<div class="callout warn">${icon("alert")}<span>No pude leer lo cargado a mano: probá de nuevo en un rato.</span></div>` : ""}
    <div class="mx-kpis sp-kpis">${tiles.map(t => `<div class="card mx-kpi"><span class="l">${esc(t.l)}</span><b>${usd(t.x.total)}</b>${split(t.x)}${t.m || ""}<small>${esc(t.s)}</small></div>`).join("")}</div>
    <p class="faint sp-note">La suscripción es un precio por mes: en el día y la semana va la parte que le toca (precio ÷ días del mes).</p>
    <h3 class="sp-h">Evolución de la API</h3>${chart}
    <div class="sp-cols"><div><h3 class="sp-h">En qué se gastó (este mes)</h3>${rows(sum("features"), n => FEAT[n] || n)}</div>
    <div><h3 class="sp-h">Quién lo gastó (este mes)</h3>${rows(sum("people"), n => d.names?.[n] || n)}</div></div>
    <h3 class="sp-h">Por mes</h3>${months}
    <h3 class="sp-h">Cargado a mano <button class="linkbtn" id="spEdit">${editing ? "Cerrar" : "Editar"}</button></h3>
    ${editing ? editHtml(d.plan) : `<p class="muted">${d.plan.subs?.length ? d.plan.subs.map(x => `${esc(x.name || "Suscripción")}: ${usd(x.usd)} por mes${x.since ? ` desde ${esc(monthName(x.since))}` : ""}`).join(" · ") : "Sin suscripciones cargadas."}${d.plan.past?.length ? "<br>" + d.plan.past.map(x => `API ${esc(monthName(x.month))}: ${usd(x.usd)}${x.note ? ` (${esc(x.note)})` : ""}`).join(" · ") : ""}</p>`}
    <p class="faint sp-foot">Topes de la app: ${usd(L.day, 0)} por día, ${usd(L.person, 0)} por persona por día y ${usd(L.month, 0)} por mes. Al llegar, la app deja de usar la IA hasta el día o el mes siguiente. Se cambian en Vercel (AI_DAILY_USD, AI_PERSON_USD, AI_MONTHLY_USD).</p>`;
  box.querySelectorAll("[data-by]").forEach(b => b.onclick = () => { chartBy = b.dataset.by; try { localStorage.setItem("ob.spend.by", chartBy); } catch {} draw(box); });
  box.querySelector("#spEdit").onclick = () => { editing = !editing; draw(box); };
  if (editing) bindEdit(box);
}

const subRow = (x = {}) => `<div class="sp-ed" data-sub><input class="input" placeholder="Plan (ej.: Claude Max · Facundo)" maxlength="60" value="${esc(x.name || "")}" aria-label="Nombre del plan"><input class="input" inputmode="decimal" placeholder="US$ por mes" value="${x.usd ?? ""}" aria-label="US$ por mes"><input class="input" type="month" value="${esc(x.since || new Date().toISOString().slice(0, 7))}" aria-label="Desde qué mes" title="Desde qué mes"><button class="icon-btn" data-del aria-label="Sacar">${icon("x")}</button></div>`;
const pastRow = (x = {}) => `<div class="sp-ed" data-past><input class="input" type="month" value="${esc(x.month || "")}" aria-label="Mes"><input class="input" inputmode="decimal" placeholder="US$" value="${x.usd ?? ""}" aria-label="US$"><input class="input" placeholder="Nota (ej.: consola de Anthropic)" maxlength="80" value="${esc(x.note || "")}" aria-label="Nota"><button class="icon-btn" data-del aria-label="Sacar">${icon("x")}</button></div>`;
function editHtml(p) {
  return `<div class="sp-edit"><p class="muted">Suscripciones (lo que paga cada persona o el equipo por su plan de Claude, por mes, y desde qué mes):</p>
    <div id="spSubs">${(p.subs?.length ? p.subs : [{}]).map(subRow).join("")}</div><button class="linkbtn" id="spAddSub">+ Otra suscripción</button>
    <p class="muted" style="margin-top:14px">API de antes de que la app lo midiera (lo que dice la consola de Anthropic, por mes):</p>
    <div id="spPast">${(p.past?.length ? p.past : [{}]).map(pastRow).join("")}</div><button class="linkbtn" id="spAddPast">+ Otro mes</button>
    <div class="row" style="margin-top:14px"><button class="btn primary" id="spSave">Guardar</button></div></div>`;
}
function bindEdit(box) {
  const del = () => box.querySelectorAll("[data-del]").forEach(b => b.onclick = () => b.parentElement.remove());
  del();
  box.querySelector("#spAddSub").onclick = () => { box.querySelector("#spSubs").insertAdjacentHTML("beforeend", subRow()); del(); };
  box.querySelector("#spAddPast").onclick = () => { box.querySelector("#spPast").insertAdjacentHTML("beforeend", pastRow()); del(); };
  box.querySelector("#spSave").onclick = async e => {
    const b = e.currentTarget; b.disabled = true;
    const subs = [...box.querySelectorAll("[data-sub]")].map(r => { const [n, u, f] = r.querySelectorAll("input"); return { name: n.value, usd: u.value, since: f.value }; });
    const past = [...box.querySelectorAll("[data-past]")].map(r => { const [m, u, n] = r.querySelectorAll("input"); return { month: m.value, usd: u.value, note: n.value }; });
    try { await api("/api/admin/ai-spend/plan", { body: { subs, past } }); editing = false; toast("Guardado"); renderSpend(box, { reload: true }); }
    catch (er) { b.disabled = false; toast(er.message, { type: "err" }); }
  };
}
