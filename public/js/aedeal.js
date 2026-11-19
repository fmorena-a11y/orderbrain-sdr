// Piezas del trato que comparten el «Hoy» del account (aehome.js) y la ficha (school.js): cómo se dice por qué un trato pide
// atención, su próxima actividad y la franja «tu trato» que va arriba de la ficha en una sesión «Tus tratos». Sin estado de
// pantalla: solo formato y la lectura de los tratos de una ficha (GET /api/ae/deals, lib/ae-api.js). Nunca se inventa: lo que
// no se sabe va «?».
import { S, api, esc, icon, dayLabel, TYPE_ICON } from "./core.js";

export const fmtN = n => Number(n).toLocaleString("es");
export function money(v, cur) {
  if (v == null) return "";
  try { return new Intl.NumberFormat("es", { style: "currency", currency: cur || "USD", maximumFractionDigits: 0 }).format(v); } catch { return `${fmtN(v)} ${cur || ""}`.trim(); }
}
export const typeName = t => S.types?.[t] || t || "Actividad";
export const daysTxt = n => n == null ? "? días" : n === 0 ? "desde hoy" : n === 1 ? "1 día" : `${fmtN(n)} días`;
export const whenTxt = a => `${dayLabel(a.date)}${a.time ? " " + a.time : ""}`;
// por qué pide atención (lib/aeview.js reasonsOf): el más grave primero
export const WHY = { proposal: "Propuesta sin seguimiento", overdue: "Próxima vencida", noNext: "Sin próximo paso", stale: "Quieto en la etapa" };
export const whyChips = r => (r.why || []).map((k, i) => `<span class="ae-why ${i ? "" : "main"} ${k}">${esc(WHY[k] || k)}</span>`).join("");
export function nextHtml(r) {
  if (r.next) return `<span class="dl-next ${r.next.overdue ? "late" : ""}" title="${esc(r.next.subject)}">${icon(TYPE_ICON[r.next.type] || "calendar", "sm")}<span>${esc(typeName(r.next.type))} · ${esc(whenTxt(r.next))}${r.next.overdue ? " · vencida" : ""}</span></span>`;
  if (r.nextUnknown) return `<span class="dl-next" title="Pipedrive dice que tiene una, pero no la pude leer">${icon("calendar", "sm")}<span>Próxima: ?</span></span>`;
  return `<span class="dl-next none">${icon("alert", "sm")}<span>Sin próximo paso</span></span>`;
}
// etapa, días en la etapa y valor («sin valor» si es 0 o no está cargado)
export const stageLine = r => `<span class="dl-meta"><span>${esc(r.pipe?.name || "")}${r.pipe?.name ? " · " : ""}<b>${esc(r.stage?.name || "?")}</b></span><span class="dl-days ${r.stale ? "late" : ""}" title="Días en la etapa">${icon("clock", "sm")}${esc(daysTxt(r.days))} en la etapa</span><span class="dl-val ${r.value == null ? "none" : ""}">${r.value != null ? esc(money(r.value, r.currency)) : "sin valor"}</span></span>`;

// ---------- la ficha: tus tratos abiertos de esa organización o colegio
export const fichaDeals = (ref, { fresh = false } = {}) => api(`/api/ae/deals?ref=${encodeURIComponent(ref)}${fresh ? "&fresh=1" : ""}`);
// x: lo que respondió fichaDeals ({ deals, pdWeb }), { error } o null mientras carga
export function dealBarHtml(x) {
  const row = r => `<div class="d-deal-row">
    <div class="d-deal-t">${icon("deal", "sm")}<b>${esc(r.title || "Trato sin título")}</b><a href="${esc(`${x.pdWeb || S.pdWeb}/deal/${r.id}`)}" target="_blank" rel="noopener" title="Abrir el trato en Pipedrive" aria-label="Abrir el trato en Pipedrive">${icon("external", "sm")}</a></div>
    ${stageLine(r)}
    <div class="d-deal-n">${r.next || r.nextUnknown || !r.why?.includes("noNext") ? nextHtml(r) : ""}${r.last ? `<small>Última hecha: ${esc(typeName(r.last.type))} · ${esc(dayLabel(r.last.date))}</small>` : ""}${whyChips(r)}</div>
  </div>`;
  return `<div class="d-deal" role="region" aria-label="Tu trato de esta ficha">${!x ? `<div class="skel" style="width:70%"></div>`
    : x.error ? `<small class="muted">${icon("alert", "sm")} No pude leer tu trato: ${esc(x.error)}</small>`
    : x.deals?.length ? x.deals.map(row).join("")
    : `<small class="muted">${icon("deal", "sm")} No encontré un trato abierto tuyo en esta ficha: pudo cerrarse o cambiar de dueño.</small>`}</div>`;
}
