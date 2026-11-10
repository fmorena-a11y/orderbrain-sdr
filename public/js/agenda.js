// Agenda: actividades pendientes propias en Pipedrive, agrupadas por día.
import { S, api, esc, icon, today, localAct, dayLabel } from "./core.js";
import { actRow, markDone, moveMenu } from "./today.js";
import { openSchool, openRecord } from "./school.js";

let host, filter = "all", error = null, loading = false;
const PLURAL = { all: "Todas", call: "Llamadas", meeting: "Demos", deadline: "WhatsApp", task: "Mails", contacto_decisor: "Decisores" };

export function renderAgenda(el) {
  host = el; error = null;
  draw();
  refresh(); // si ya había datos se muestran al instante y se actualizan atrás
}
async function refresh() {
  loading = true; drawHead();
  try { S.agenda = await api("/api/my-activities"); error = null; }
  catch (e) { error = e.message; }
  loading = false;
  if (host?.isConnected) draw();
}
function counts(items) {
  const c = { all: items.length };
  for (const a of items) c[a.type] = (c[a.type] || 0) + 1;
  return c;
}
function drawHead() {
  const b = host?.querySelector("#reload"); if (!b) return;
  b.disabled = loading; b.innerHTML = loading ? `<span class="spin"></span>` : icon("refresh");
}
function draw() {
  if (!host) return;
  const t = today();
  const all = (S.agenda?.items || []).map(a => ({ ...a, ...localAct(a) }));
  const c = counts(all);
  const types = [["all", "Todas"], ...Object.entries(S.types || {}).filter(([k]) => c[k])];
  if (filter !== "all" && !c[filter]) filter = "all";
  const items = all.filter(a => filter === "all" || a.type === filter);
  const byDay = new Map();
  for (const a of items) { const k = a.date < t ? "late" : a.date; if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(a); }
  const keys = [...byDay.keys()].sort((a, b) => (a === "late" ? -1 : b === "late" ? 1 : a.localeCompare(b)));
  const late = all.filter(a => a.date < t).length, now = all.filter(a => a.date === t).length;
  const summary = S.agenda ? [late && `${late} vencida${late > 1 ? "s" : ""}`, `${now} para hoy`, `${all.length} en total`].filter(Boolean).join(" · ") : "";
  host.innerHTML = `<div class="page">
    <div class="page-head"><div><h1>Agenda</h1>${summary ? `<p>${esc(summary)}</p>` : ""}</div>
      <button class="icon-btn" id="reload" aria-label="Actualizar desde Pipedrive" title="Actualizar desde Pipedrive">${icon("refresh")}</button></div>
    ${error ? `<div class="callout err" style="margin-bottom:16px">${icon("alert")}<span>No pudimos traer tu agenda de Pipedrive: ${esc(error)}</span><button class="btn sm" id="retry">Reintentar</button></div>` : ""}
    ${S.agenda?.warning ? `<div class="callout warn" style="margin-bottom:16px">${icon("alert")}<span>${esc(S.agenda.warning)}</span></div>` : ""}
    ${!S.agenda && !error ? skeleton() : S.agenda ? `
      ${types.length > 2 ? `<div class="chips" style="margin-bottom:16px" role="group" aria-label="Tipo de actividad">${types.map(([k, l]) => `<button class="chip" data-t="${k}" aria-pressed="${filter === k}">${esc(PLURAL[k] || l)} <b>${c[k] || 0}</b></button>`).join("")}</div>` : ""}
      ${keys.length ? keys.map(k => `<section class="card agenda-day" aria-label="${k === "late" ? "Vencidas" : esc(dayLabel(k))}"><h3 style="${k === "late" ? "color:var(--err)" : ""}">${k === "late" ? "Vencidas" : esc(dayLabel(k))} <small>${byDay.get(k).length}</small></h3>${byDay.get(k).map(a => actRow(a, k === "late")).join("")}</section>`).join("")
        : `<div class="card"><div class="empty">${icon("checkCircle")}<b>Nada pendiente</b><span>Cuando registres un contacto con próximo paso, aparece acá.</span></div></div>`}` : ""}
  </div>`;
  drawHead();
  host.querySelector("#reload").onclick = refresh;
  host.querySelector("#retry")?.addEventListener("click", refresh);
  host.querySelectorAll("[data-t]").forEach(b => b.onclick = () => { filter = b.dataset.t; draw(); host.querySelector(`[data-t="${filter}"]`)?.focus(); });
  host.querySelectorAll("[data-school]").forEach(b => b.onclick = () => openSchool(b.dataset.school, { activityId: Number(b.dataset.act) }));
  host.querySelectorAll("[data-record]").forEach(b => b.onclick = () => openRecord(b.dataset.record, { activityId: Number(b.dataset.act) || null }));
  host.querySelectorAll("[data-done]").forEach(b => b.onclick = () => { b.disabled = true; b.closest(".act")?.setAttribute("aria-busy", "true"); markDone(Number(b.dataset.done), draw); });
  // al reprogramar se actualiza en el momento y se revalida atrás, sin vaciar la lista
  host.querySelectorAll("[data-move]").forEach(b => b.onclick = () => moveMenu(b, Number(b.dataset.move), () => { draw(); refresh(); }));
}
function skeleton() {
  return [1, 2].map(() => `<section class="card agenda-day" style="padding:16px">${'<div class="skel" style="margin:12px 0"></div>'.repeat(3)}</section>`).join("");
}
