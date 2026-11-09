// Agenda: actividades pendientes propias en Pipedrive, agrupadas por día.
import { S, api, esc, icon, today, localAct, dayLabel } from "./core.js";
import { actRow, markDone, moveMenu } from "./today.js";
import { openSchool } from "./school.js";

let host, filter = "all";
const TYPES = [["all", "Todas"], ["call", "Llamadas"], ["meeting", "Demos"], ["deadline", "WhatsApp"], ["task", "Mails"]];

export function renderAgenda(el) {
  host = el;
  if (!S.agenda) { el.innerHTML = `<div class="page"><div class="page-head"><div><h1>Agenda</h1><p>Cargando desde Pipedrive…</p></div></div></div>`; load(); }
  else draw();
}
async function load() {
  try { S.agenda = await api("/api/my-activities"); } catch (e) { host.innerHTML = `<div class="page"><div class="callout err">${icon("alert")}${esc(e.message)}</div></div>`; return; }
  if (host?.isConnected) draw();
}
function draw() {
  const t = today();
  const items = (S.agenda.items || []).map(a => ({ ...a, ...localAct(a) })).filter(a => filter === "all" || a.type === filter);
  const byDay = new Map();
  for (const a of items) { const k = a.date < t ? "late" : a.date; if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(a); }
  const keys = [...byDay.keys()].sort((a, b) => (a === "late" ? -1 : b === "late" ? 1 : a.localeCompare(b)));
  const count = k => (S.agenda.items || []).filter(a => k === "all" || a.type === k).length;
  host.innerHTML = `<div class="page">
    <div class="page-head"><div><h1>Agenda</h1><p>Tus actividades pendientes en Pipedrive. Tocá una para abrir la ficha y registrar el resultado.</p></div>
      <button class="btn" id="reload">${icon("refresh")} Actualizar</button></div>
    ${S.agenda.warning ? `<div class="callout warn" style="margin-bottom:16px">${icon("alert")}<span>${esc(S.agenda.warning)}</span></div>` : ""}
    <div class="chips" style="margin-bottom:18px">${TYPES.map(([k, l]) => `<button class="chip" data-t="${k}" aria-pressed="${filter === k}">${l} <b>${count(k)}</b></button>`).join("")}</div>
    ${keys.length ? keys.map(k => `<section class="card agenda-day" style="padding:6px 14px 8px"><h3 style="padding-top:10px;${k === "late" ? "color:var(--err)" : ""}">${k === "late" ? "Vencidas" : esc(dayLabel(k))} <small>${byDay.get(k).length}</small></h3>${byDay.get(k).map(a => actRow(a, k === "late")).join("")}</section>`).join("")
      : `<div class="card"><div class="empty">${icon("checkCircle")}<b>Nada pendiente</b><span>Cuando registres un contacto con próximo paso, aparece acá.</span></div></div>`}
  </div>`;
  host.querySelector("#reload").onclick = () => { S.agenda = null; renderAgenda(host); };
  host.querySelectorAll("[data-t]").forEach(b => b.onclick = () => { filter = b.dataset.t; draw(); });
  host.querySelectorAll("[data-school]").forEach(b => b.onclick = () => openSchool(b.dataset.school, { activityId: Number(b.dataset.act) }));
  host.querySelectorAll("[data-done]").forEach(b => b.onclick = () => markDone(Number(b.dataset.done), draw));
  host.querySelectorAll("[data-move]").forEach(b => b.onclick = () => moveMenu(b, Number(b.dataset.move), () => { S.agenda = null; renderAgenda(host); }));
}
