// Ficha del colegio: Historial, resumen para la próxima llamada y tu trato arriba de la ficha.
import { $, S, TYPE_ICON, api, copy, dayLabel, demoDue, esc, icon, initials, leadsOver, localAct, shortDay, telLink, toast, today, waLink } from "../core.js";
import { fichaDeals } from "../aedeal.js";
import { D } from "./state.js";
import { load } from "./open.js";
import { keepScroll } from "./media.js";
import { addDecisor, bindDeals, canAddPerson, dealOpsHtml } from "./sections.js";
import { draw } from "./render.js";
import { templateMenu } from "./messages.js";

// ---------- Historial
// La línea de tiempo completa de la ficha, como la de Pipedrive (actividades hechas con su fecha, quién y su nota; notas;
// prospecto y tratos creados, ganados y perdidos) más lo registrado en la app, sin repetir: la arma el servidor
// (/api/schools/:id/timeline, lib/timeline.js) de a 50, de lo más nuevo a lo más viejo. Arriba, el resumen para la próxima llamada.
const whenFull = at => { const x = new Date(at); return isNaN(x) ? "" : x.toLocaleString("es", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }); };
const ddmm = d => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
// día relativo: «hoy», «ayer», «mañana», «vie 13/11» (esta semana o la que viene), «25/06/2026»
function relDay(d) {
  const t = today(), diff = Math.round((new Date(t + "T12:00:00") - new Date(d + "T12:00:00")) / 864e5);
  if (diff === 0) return "hoy"; if (diff === 1) return "ayer"; if (diff === -1) return "mañana";
  if (Math.abs(diff) < 7) return `${new Intl.DateTimeFormat("es", { weekday: "short" }).format(new Date(d + "T12:00:00")).replace(".", "")} ${ddmm(d)}`;
  return `${ddmm(d)}/${d.slice(0, 4)}`;
}
// fecha de una entrada en la zona de quien mira: «hoy 10:32», «ayer», «25/06/2026»
const tlDay = it => it.day || new Date(it.at).toLocaleDateString("sv");
// en los últimos 6 días va el día de la semana, como en el resumen («el lunes»): «lunes 17:07», no «16/11/2026 17:07»
const tlFull = it => { const d = tlDay(it); return `${ddmm(d)}/${d.slice(0, 4)}`; };
function tlWhen(it) {
  const d = tlDay(it), t = today(), diff = Math.round((new Date(t + "T12:00:00") - new Date(d + "T12:00:00")) / 864e5);
  const rel = diff === 0 ? "hoy" : diff === 1 ? "ayer" : diff > 1 && diff < 7 ? new Intl.DateTimeFormat("es", { weekday: "long" }).format(new Date(d + "T12:00:00")) : tlFull(it);
  return it.timed ? `${rel} ${new Date(it.at).toTimeString().slice(0, 5)}` : rel;
}
const dayTime = x => `${relDay(x.day)}${x.time ? ` ${x.time}` : ""}`;
// fechas AAAA-MM-DD dentro de un texto (filas de las notas: «Próximo paso: Llamada el viernes 2026-11-13») → «13/11/2026»
const isoDates = t => String(t || "").replace(/\b(?:(lunes|martes|miércoles|jueves|viernes|sábado|domingo)\s+)?(\d{4})-(\d{2})-(\d{2})\b/g, (_, w, y, m, d) => relDay(`${y}-${m}-${d}`));
// la pendiente que se cerró con esta entrada («cerró la llamada que estaba para ayer 14:15»)
const closedText = c => `cerró ${/^(llamada|demo|tarea|visita|reuni)/i.test(c.label) ? "la" : "el"} ${c.label.toLowerCase()}${c.subject ? ` «${c.subject}»` : ""}${c.day ? ` que estaba para ${dayTime(c)}` : ""}`;
const mailItem = (m, when = "", extra = "") => `<div class="tl tl-mail"><span class="ic">${icon("mail")}</span><div>
    <div class="h tl-top"><span><b>Mail enviado</b> a ${esc(m.to)}</span>${when ? `<span class="tl-date">${esc(when)}</span>` : ""}</div>
    <div class="tl-sub">«${esc(m.subject)}»</div>
    <div class="faint tl-meta">${esc([m.by, when ? "" : whenFull(m.at), extra].filter(Boolean).join(" · "))}${m.next?.type ? ` · próximo paso: ${esc((S.types[m.next.type] || "tarea").toLowerCase())} ${esc(shortDay(m.next.date))}` : ""}</div>
    ${m.body ? `<details class="tl-body"><summary>Ver el mail</summary><p>${esc(m.body)}</p></details>` : ""}</div></div>`;
const LONG = 320;
function tlItem(it) {
  if (it.inbound) {
    const ib = it.inbound;
    return `<div class="tl tl-bolt tl-inb"><span class="ic">${icon("bolt")}</span><div>
    <div class="h tl-top"><b>Entró como inbound</b><span class="tl-date" title="${esc(tlFull(it))}">${esc(tlWhen(it))}</span></div>
    <div class="faint tl-meta">${esc(["Nota de «Tus inbound»", it.who, it.where].filter(Boolean).join(" · "))}${ib.slack ? ` · <a href="${esc(ib.slack)}" target="_blank" rel="noopener">Mensaje en Slack</a>` : ""}</div>
    ${(it.rows || []).length ? `<div class="tl-rows">${it.rows.map(([k, v]) => `<span><b>${esc(k)}:</b> ${esc(v)}</span>`).join("")}</div>` : ""}
    ${ib.filter ? `<p class="faint tl-txt" style="font-size:var(--fs-sm)">${esc(ib.filter)}</p>` : ""}
    ${it.text ? `<blockquote class="tl-msg"><span class="faint">Mensaje:</span> ${esc(it.text)}</blockquote>` : ""}</div></div>`;
  }
  if (it.kind === "mail") return mailItem({ ...it.mail, by: it.who, at: it.at }, tlWhen(it), it.closed ? closedText(it.closed) : "");
  const head = it.kind === "contact" ? `${it.label} · ${it.title}` : it.kind === "created" || it.kind === "deal" ? it.label : it.title || it.label;
  const meta = [it.kind === "act" && it.title && it.title !== it.label ? it.label : it.kind === "note" && it.title ? "Nota" : "", it.who, it.where,
    it.early ? `hecha antes: estaba para ${dayTime(it.early)}` : "", it.late ? `estaba para ${dayTime(it.late)}` : "", it.marked ? `marcada hecha el ${relDay(it.marked)}` : "",
    it.closed ? closedText(it.closed) : "", it.src === "app" ? "registrado en la app" : it.app && it.kind === "note" ? "desde la app" : ""].filter(Boolean);
  const sub = (it.kind === "created" || it.kind === "deal") && it.title ? (it.url ? `<a href="${esc(it.url)}" target="_blank" rel="noopener">${esc(it.title)}</a>` : esc(it.title)) : "";
  const long = (it.text || "").length > LONG || (it.text || "").split("\n").length > 6;
  return `<div class="tl tl-${esc(it.icon)}${it.aside ? " tl-aside" : ""}"><span class="ic">${icon(it.icon)}</span><div>
    <div class="h tl-top"><b>${esc(head)}</b><span class="tl-date" title="${esc(tlFull(it))}">${esc(tlWhen(it))}</span></div>
    ${sub ? `<div class="tl-sub">${sub}</div>` : ""}
    ${meta.length ? `<div class="faint tl-meta">${esc(meta.join(" · "))}</div>` : ""}
    ${it.text ? `<p class="tl-txt${long ? " clamp" : ""}">${esc(it.text)}</p>${long ? `<button class="linkbtn tl-more" data-tlfull aria-expanded="false">Ver todo</button>` : ""}` : ""}
    ${(it.rows || []).length ? `<div class="tl-rows">${it.rows.map(([k, v]) => `<span><b>${esc(k)}:</b> ${esc(isoDates(v))}</span>`).join("")}</div>` : ""}</div></div>`;
}
// ---------- Resumen para la próxima llamada (arriba de Preparar, del Historial y, chico, de Registrar). Sale solo de lo que
// dicen las actividades y notas; cada dato dice de qué entrada sale. Por reglas al toque; con IA (si hay clave) lo reemplaza
// cuando llega. where: "prep" (entero), "hist" (compacto: lo de abajo es la lista) o "log" (solo la apertura).
const cbList = (l, f) => `<ul class="cb-list">${l.map(f).join("")}</ul>`;
// los datos que salen de la misma entrada van juntos, con UNA línea de fuente debajo (antes cada dato repetía la suya)
function cbBySrc(l, f) {
  const g = new Map();
  for (const x of l) { const k = x.src || ""; if (!g.has(k)) g.set(k, []); g.get(k).push(x); }
  return [...g].map(([k, xs]) => `<div class="cb-grp">${cbList(xs, f)}${k ? `<span class="faint cb-from">${esc(k)}</span>` : ""}</div>`).join("");
}
// un teléfono de las notas se puede tocar (sin WhatsApp si la nota lo dice)
function factVal(f, s) {
  if (f.k !== "Teléfono") return esc(f.v);
  const num = f.v.replace(/\s*\([^)]*\)\s*$/, ""), noWa = /sin\s+whats/i.test(f.v);
  return `<a href="${esc(telLink(num))}">${esc(num)}</a>${f.v !== num ? ` <span class="faint">${esc(f.v.slice(num.length).trim())}</span>` : ""}${noWa ? "" : ` <a class="linkbtn" href="${esc(waLink(num, "", s.country))}" target="_blank" rel="noopener">WhatsApp</a>`}`;
}
export function briefCard(s, where) {
  const t = D.tl?.id === s.id ? D.tl : null;
  const title = `<h3><span class="l">${icon("sparkles")} Resumen para la próxima llamada</span>`;
  if (where === "log") {
    // en Registrar: solo la apertura, si hay historia (el resumen entero está en Preparar)
    const b = t ? t.brief || t.summary : null;
    if (!b || b.cold) return "";
    const me = (S.me.name || "").split(/[\s.@_]/)[0], opening = String(b.opening || "").replace(/\[tu nombre\]/g, me || "[tu nombre]");
    // una línea (los resultados van primero): «Apertura sugerida · Hola, ¿qué tal?… Ver»; abierta, entera con copiar
    return `<details class="cb-line" ${D.cbLogOpen ? "open" : ""}><summary><span class="cb-k">Apertura sugerida</span><span class="cb-one">${esc(opening)}</span><span class="linkbtn cb-see" aria-hidden="true"></span></summary>
      <div class="say cb-say">${esc(opening)}<button class="icon-btn" data-copy="${esc(opening)}" aria-label="Copiar apertura">${icon("copy")}</button></div>
      <p class="faint cb-src"><span>${esc(b.headline)}</span> <button class="linkbtn" data-cbprep>Ver resumen</button></p></details>`;
  }
  if (!t || (!t.summary && !t.err)) return `<section class="sec cb" aria-busy="true">${title}</h3><div class="skel" style="width:70%"></div><div class="skel" style="margin-top:10px"></div><div class="skel" style="margin-top:8px;width:85%"></div><p class="faint" style="margin:10px 0 0;font-size:var(--fs-sm)">Leyendo el historial de Pipedrive…</p></section>`;
  if (!t.summary) return `<div class="callout warn">${icon("alert")}<span>No pude leer el historial de Pipedrive: ${esc(t.err)}</span><button class="btn sm" data-tlretry>Reintentar</button></div>`;
  const b = t.brief || t.summary, me = (S.me.name || "").split(/[\s.@_]/)[0];
  const opening = String(b.opening || "").replace(/\[tu nombre\]/g, me || "[tu nombre]");
  const tools = `<span class="cb-tools">${b.mode === "ia" ? `<span class="tag" title="Lo armó la IA citando las entradas del historial">con IA</span>` : ""}${t.aiLoading ? `<span class="faint cb-ai" aria-live="polite"><span class="spin"></span> IA</span>` : ""}<button class="btn sm ghost icon-only" data-tlrefresh aria-label="Actualizar el historial" title="Volver a leer Pipedrive">${t.loading ? `<span class="spin"></span>` : icon("refresh", "sm")}</button></span>`;
  const warns = b.warnings?.length ? `<div class="callout warn cb-warn">${icon("alert")}<span>${b.warnings.map(w => esc(w.text)).join("<br>")}</span></div>` : "";
  // sin vincular, con candidatas: no se sabe qué pasó en Pipedrive (no es «sin nada»)
  // en Preparar eso va en la línea de estado de Pipedrive (pdLine), junto con lo que se revisó
  if (b.cold && b.unlinked) return where === "prep" ? warns : `<div class="callout info cb-cold">${icon("building")}<span><b>Todavía no está vinculado a Pipedrive.</b> Elegí la organización para ver su historia antes de llamar.</span><button class="btn sm" data-cbcands>Elegir</button></div>`;
  if (b.cold) {
    if (where === "prep" && !b.origin) return warns;
    return `<section class="sec cb">${title}${tools}</h3><p class="cb-head">${esc(b.headline)}</p>${originHtml(b)}
      <div class="say cb-say"><span class="cb-k">Apertura sugerida</span>${esc(opening)}<button class="icon-btn" data-copy="${esc(opening)}" aria-label="Copiar apertura">${icon("copy")}</button></div>
      <p class="faint cb-src">${esc(b.openingSrc)}</p>${b.facts?.length ? cbList(b.facts, f => `<li><b>${esc(f.k)}:</b> ${factVal(f, s)}</li>`) : ""}${warns}</section>`;
  }
  const src = x => x.src ? `<span class="faint cb-from">${esc(x.src)}</span>` : "";
  const full = where === "prep";
  return `<section class="sec cb" aria-label="Resumen para la próxima llamada">${title}${tools}</h3>
    <p class="cb-head">${esc(b.headline)}</p>
    ${b.reach ? `<p class="cb-reach ${b.reach.answered === true ? "ok" : b.reach.answered === false ? "no" : ""}">${icon(b.reach.answered === true ? "checkCircle" : b.reach.answered === false ? "phone" : "clock", "sm")}<span>${esc(b.reach.text)}${src(b.reach)}</span></p>` : ""}
    ${originHtml(b)}
    <div class="say cb-say"><span class="cb-k">Apertura sugerida</span>${esc(opening)}<button class="icon-btn" data-copy="${esc(opening)}" aria-label="Copiar apertura">${icon("copy")}</button></div>
    <p class="faint cb-src">Sale de: ${esc(b.openingSrc)}</p>
    ${b.noted ? `<p class="cb-noted">${esc(b.noted.text)}</p>` : ""}
    ${b.askFor?.length ? `<p class="cb-ask">Preguntá por ${b.askFor.map(a => `<b>${esc(a.text)}</b>`).join(" o ")}.</p>` : ""}
    ${warns}
    <details class="cb-more" ${full ? "open" : ""}><summary>${full ? "Qué pasó, datos y pendientes" : "Qué pasó y datos"}</summary>
      ${b.happened?.length ? `<div class="cb-h">Qué pasó</div>${cbList(b.happened, h => `<li>${h.lead ? `<b>${esc(h.lead)}</b>${h.text ? ": " : ""}` : ""}${h.text ? (h.quote ? `«${esc(h.text)}»` : esc(h.text)) : ""}${src(h)}</li>`)}` : ""}
      ${b.facts?.length ? `<div class="cb-h">Datos de las notas</div>${cbBySrc(b.facts, f => `<li><b>${esc(f.k)}:</b> ${factVal(f, s)}</li>`)}` : ""}
      ${b.plan?.length ? `<div class="cb-h">Plan anotado</div>${cbBySrc(b.plan, p => `<li>«${esc(p.text)}»</li>`)}` : ""}
      ${!full ? "" : b.pending?.length ? `<div class="cb-h">Pendiente</div>${cbList(b.pending, p => `<li class="${p.late ? "late" : ""}">${esc(p.text)}</li>`)}` : `<p class="faint" style="margin:8px 0 0;font-size:var(--fs-sm)">No hay nada pendiente con este colegio.</p>`}
      ${b.thin ? `<p class="faint" style="margin:8px 0 0;font-size:var(--fs-sm)">${esc(b.thin)}</p>` : ""}
      ${[b.aiNote, b.openingNote].filter(Boolean).map(x => `<p class="faint" style="margin:8px 0 0;font-size:var(--fs-sm)">${esc(x)}</p>`).join("")}
    </details></section>`;
}
// lead inbound (la nota de «Tus inbound»): de dónde vino y lo que escribió la persona
const originHtml = b => !b.origin ? "" : `<div class="cb-origin">${icon("bolt", "sm")}<div><b>Entró como inbound</b> ${esc(b.origin.when)}${b.origin.text ? ` · ${esc(b.origin.text)}` : ""}${b.origin.who ? `<br><span class="faint">${esc(b.origin.who)}</span>` : ""}
  ${b.origin.message ? `<blockquote>${esc(b.origin.message)}</blockquote>` : ""}</div></div>`;
// En Registrar no se redibuja (se está escribiendo): solo la apertura de arriba y el número de la pestaña Historial.
function redrawTl(id) {
  if (D.id !== id) return;
  if (D.tab !== "log" || !D.data) return keepScroll(draw);
  const el = $("drawer"), tab = el.querySelector("#tab-hist"), n = D.tl?.total;
  if (tab && n != null) { let b = tab.querySelector(".n"); if (!b && n) { b = document.createElement("span"); b.className = "n"; tab.append(b); } if (b) b.textContent = n || ""; }
  const box = el.querySelector("#cbLog"), s = S.byId.get(id);
  if (box && s) { box.innerHTML = briefCard(s, "log"); bindTimeline(s); }
}
// ---------- tu trato arriba de la ficha (sesión «Tus tratos» o abierta desde el Hoy del account): etapa, días en la etapa,
// valor y próxima actividad de tus tratos abiertos de esta organización (GET /api/ae/deals, public/js/aedeal.js)
export async function loadMyDeals({ fresh = false } = {}) {
  const id = D.id; if (!id || !D.dealsOn) return;
  try { const r = await fichaDeals(D.sref || id, { fresh }); if (D.id === id) D.myDeals = r; }
  catch (e) { if (D.id === id && !D.myDeals?.deals) D.myDeals = { error: e.message }; }
  if (D.id === id) keepScroll(draw);
}
// se registró algo en la ficha (un contacto, una actividad nueva o cerrada): el trato se lee de nuevo
let dealTimer = null;
addEventListener("ob:wrote", e => {
  const id = D.id, p = String(e.detail?.path || ""); if (!id || !D.dealsOn) return;
  if (!/^\/api\/(schools|activities|proposals)\//.test(p) || /\/(timeline|call-brief|check|study)(\?|$)/.test(p)) return;
  clearTimeout(dealTimer); dealTimer = setTimeout(() => { if (D.id === id) loadMyDeals({ fresh: true }); }, 900);
});
// algo se escribió de esta ficha (o de una actividad): se vuelve a leer el Historial de Pipedrive, una vez aunque sean varios pedidos
let tlTimer = null;
addEventListener("ob:wrote", e => {
  const id = D.id, p = String(e.detail?.path || ""); if (!id || D.tl?.id !== id) return;
  if (!p.startsWith(`/api/schools/${encodeURIComponent(id)}/`) && !p.startsWith(`/api/schools/${id}/`) && !p.startsWith("/api/activities/") && !p.startsWith("/api/proposals/")) return;
  if (/\/(timeline|call-brief|check)$/.test(p.split("?")[0])) return;
  clearTimeout(tlTimer); tlTimer = setTimeout(() => { if (D.id === id) loadTimeline(id, { fresh: true }); }, 600);
});
// Lo que trae el servidor: { items (las cargadas), total, more, warnings, cut, summary }; brief: el resumen con IA.
// refresh: «Actualizar» (Pipedrive y la IA de nuevo); fresh: recién se escribió algo (Pipedrive de nuevo, la IA por contenido).
export async function loadTimeline(id, { refresh = false, fresh = false } = {}) {
  const cur = D.tl?.id === id ? D.tl : null;
  D.tl = { ...(cur || {}), id, loading: true, err: null, ...(refresh ? { brief: null } : {}) };
  redrawTl(id);
  try {
    const r = await api(`/api/schools/${encodeURIComponent(id)}/timeline?limit=50${refresh ? "&refresh=1" : fresh ? "&fresh=1" : ""}`);
    if (D.id !== id) return;
    // el resumen con IA de antes sirve solo si la línea de tiempo no cambió
    D.tl = { id, items: r.items, total: r.total, more: r.more, warnings: r.warnings || [], cut: r.cut || [], summary: r.summary, ai: !!r.ai, loading: false, err: null, brief: !refresh && cur?.total === r.total ? cur?.brief || null : null };
    if (r.ai && !r.summary.cold) loadBrief(id, { refresh });
  } catch (e) { if (D.id !== id) return; D.tl = { ...(D.tl || {}), id, loading: false, err: e.message }; }
  redrawTl(id);
}
async function loadBrief(id, { refresh = false } = {}) {
  D.tl.aiLoading = true;
  try {
    // refresh: salta solo la copia de la IA (la línea de tiempo es la que se acaba de leer)
    const r = await api(`/api/schools/${encodeURIComponent(id)}/call-brief${refresh ? "?refresh=1" : ""}`);
    if (D.id !== id || D.tl?.id !== id) return;
    D.tl.brief = r.summary?.mode === "ia" ? r.summary : null;
    if (r.summary?.aiNote) D.tl.summary = { ...D.tl.summary, aiNote: r.summary.aiNote };
  } catch (e) { if (D.tl?.id === id) D.tl.summary = { ...D.tl.summary, aiNote: "La IA no está disponible ahora: va el resumen por reglas." }; }
  if (D.tl?.id === id) D.tl.aiLoading = false;
  redrawTl(id);
}
async function moreTimeline(id) {
  const t = D.tl; if (!t || t.id !== id || t.loadingMore) return;
  t.loadingMore = true; redrawTl(id);
  try {
    const r = await api(`/api/schools/${encodeURIComponent(id)}/timeline?offset=${t.items.length}&limit=50`);
    if (D.tl !== t) return;
    // si cambió mientras tanto (alguien registró algo), se vuelve a cargar desde arriba
    if (r.total !== t.total) return loadTimeline(id);
    t.items = [...t.items, ...r.items]; t.more = r.more;
  } catch (e) { toast(e.message, { type: "err" }); }
  t.loadingMore = false;
  redrawTl(id);
}
export function histBody(s, d) {
  const m = d.match, t = D.tl?.id === s.id ? D.tl : null;
  const left = t ? t.total - (t.items?.length || 0) : 0;
  // primero lo que pidió el usuario: el resumen corto y las actividades con su fecha; después contactos, pendientes y tratos
  return `<div class="stack">
    ${briefCard(s, "hist")}
    <div class="sec" id="tlSec"><h3><span class="l">${icon("clock")} Historial${t?.total ? ` <span class="faint tl-count">${t.total}</span>` : ""}</span>${m.checkedAt || t ? `<button class="btn sm ghost" id="refresh">${t?.loading ? `<span class="spin"></span>` : icon("refresh", "sm")} Actualizar</button>` : ""}</h3>
      ${t?.warnings?.length ? `<div class="callout warn" style="margin-bottom:8px">${icon("alert")}<span>No pude leer de Pipedrive ${esc(t.warnings.join(", "))}. Muestro lo demás.</span></div>` : ""}
      ${t?.cut?.length ? `<p class="faint" style="margin:0 0 8px;font-size:var(--fs-sm)">Pipedrive tiene más de 500 entradas en ${esc(t.cut.join(", "))}: acá van las 500 más nuevas. El resto, en Pipedrive.</p>` : ""}
      ${!t || (!t.items && !t.err) ? `<div class="skel" style="width:60%"></div><div class="skel" style="margin-top:10px"></div><div class="skel" style="margin-top:8px;width:80%"></div>`
        : !t.items ? `<div class="callout warn">${icon("alert")}<span>No pude leer el historial: ${esc(t.err)}</span><button class="btn sm" data-tlretry>Reintentar</button></div>`
        : t.items.length ? `<div class="timeline">${t.items.map(tlItem).join("")}</div>${t.more ? `<button class="btn ghost tl-load" id="tlMore">${t.loadingMore ? `<span class="spin"></span> Cargando…` : `Cargar más · faltan ${left}`}</button>` : ""}`
        : `<div class="empty">${icon("note")}<span>Todavía no hay actividades ni notas. Lo que registres aparece acá y en Pipedrive.</span></div>`}
    </div>
    ${d.activities?.length ? `<div class="sec"><h3><span class="l">${icon("calendar")} Pendientes</span></h3>${d.activities.map(a => { const l = localAct(a); return `<div class="act"><span class="ty ${a.type}">${icon(TYPE_ICON[a.type] || "check")}</span><div class="t"><b>${esc(a.subject)}</b><small class="${l.date < today() ? "late" : ""}">${esc(a.typeLabel)} · ${esc(dayLabel(l.date))}${l.time ? ` ${l.time}` : ""} · ${esc(a.owner)}</small></div><div class="ops">${a.type === "meeting" && demoDue(l) ? (a.ownerId === S.me.pdUserId || leadsOver(a.ownerId) ? `<button class="btn sm" data-hdemo="${a.id}" data-time="${esc(l.time)}">¿Se hizo la demo?</button>` : "") : a.ownerId === S.me.pdUserId ? `<button class="icon-btn" data-hdone="${a.id}" aria-label="Marcar como hecha" title="Marcar como hecha">${icon("check")}</button>` : ""}</div></div>`; }).join("")}</div>` : ""}
    ${d.persons?.length || canAddPerson(s) ? `<div class="sec"><h3><span class="l">${icon("users")} Contactos</span>${canAddPerson(s) ? `<button class="btn sm ghost" id="addDec">${icon("plus", "sm")} Agregar decisor</button>` : ""}</h3>${d.persons?.length ? "" : `<p class="muted" style="margin:0">Todavía no hay contactos cargados.</p>`}${(d.persons || []).map(p => `<div class="person"><div class="av" style="width:34px;height:34px;border-radius:50%;background:var(--surface-3);display:grid;place-items:center;font-weight:600;font-size:var(--fs-sm)">${initials(p.name)}</div><div class="t"><b>${esc(p.name)}</b><small>${esc([...(p.phones?.length ? p.phones : [p.phone]), p.email].filter(Boolean).join(" · ") || "Sin datos")}</small></div>
      ${p.phone ? `<a class="icon-btn" href="${esc(telLink(p.phone))}" aria-label="Llamar">${icon("phone")}</a><button class="icon-btn" data-pwa="${esc(p.phone)}" data-pname="${esc(p.name)}" aria-label="WhatsApp">${icon("whatsapp")}</button>` : ""}${p.email ? `<button class="icon-btn" data-pmail="${esc(p.email)}" data-pname="${esc(p.name)}" aria-label="Mail">${icon("mail")}</button>` : ""}</div>`).join("")}</div>` : ""}
    ${d.deals?.length ? `<div class="sec"><h3><span class="l">${icon("deal")} Tratos</span></h3>${d.deals.map(x => `<div class="act"><span class="ty">${icon("deal")}</span><div class="t"><b><a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title)}</a></b><small>${esc(x.pipeline)} · ${esc(x.stage)} · ${x.status === "won" ? "ganado" : x.status === "lost" ? "perdido" + (x.lostReason ? ` (${esc(x.lostReason)})` : "") : "abierto"}${x.owner ? ` · ${esc(x.owner)}` : ""} · ${esc(x.updated)}</small>${dealOpsHtml(x)}</div></div>`).join("")}</div>` : ""}
    ${m.orgId && m.confirmed ? `<p class="faint" style="font-size:var(--fs-sm);margin:0">Vinculado a <a href="${esc(d.orgUrl)}" target="_blank" rel="noopener">${esc(m.orgName)}</a> en Pipedrive · <button class="linkbtn" id="unlink2">no es esta organización</button></p>` : ""}
  </div>`;
}
// lo que se toca en la tarjeta del resumen y en la línea de tiempo (Preparar, Historial y Registrar)
export function bindTimeline(s) {
  const el = $("drawer");
  el.querySelectorAll("[data-tlrefresh]").forEach(b => b.onclick = () => loadTimeline(s.id, { refresh: true }));
  el.querySelectorAll("[data-tlretry]").forEach(b => b.onclick = () => loadTimeline(s.id));
  el.querySelectorAll(".cb [data-copy]").forEach(b => b.onclick = () => copy(b.dataset.copy));
  el.querySelectorAll("[data-cbprep]").forEach(b => b.onclick = () => { D.tab = "prep"; draw(); $("drawer").querySelector("#dBody")?.scrollTo?.({ top: 0 }); });
  el.querySelectorAll("details.cb-line").forEach(x => x.addEventListener("toggle", () => { D.cbLogOpen = x.open; }));
  el.querySelectorAll("[data-cbcands]").forEach(b => b.onclick = () => { if (D.tab !== "prep") { D.tab = "prep"; draw(); } const c = $("drawer").querySelector("#candSec"); c?.scrollIntoView({ behavior: "smooth", block: "start" }); c?.querySelector("button")?.focus({ preventScroll: true }); });
  el.querySelector("#tlMore")?.addEventListener("click", () => moreTimeline(s.id));
  el.querySelectorAll("[data-tlfull]").forEach(b => b.onclick = () => { const p = b.previousElementSibling, closed = p.classList.toggle("clamp"); b.textContent = closed ? "Ver todo" : "Ver menos"; b.setAttribute("aria-expanded", String(!closed)); });
}
export function bindHist(s, d) {
  const el = $("drawer");
  el.querySelector("#refresh")?.addEventListener("click", () => { D.data = null; draw(); load({ refresh: true }); });
  bindTimeline(s);
  el.querySelector("#unlink2")?.addEventListener("click", () => { D.data = null; D.tab = "prep"; draw(); load({ match: { orgId: null } }); });
  el.querySelector("#addDec")?.addEventListener("click", () => addDecisor(s, d));
  bindDeals(s);
  el.querySelectorAll("[data-hdemo]").forEach(b => b.onclick = async () => {
    const { demoResultMenu } = await import("../today.js");
    demoResultMenu(b, { id: Number(b.dataset.hdemo), time: b.dataset.time }, () => load());
  });
  el.querySelectorAll("[data-hdone]").forEach(b => b.onclick = async () => {
    const { markDone } = await import("../today.js");
    markDone(Number(b.dataset.hdone), () => load());
  });
  el.querySelectorAll("[data-pwa]").forEach(b => b.onclick = () => templateMenu(b, s, d, "whatsapp", { phone: b.dataset.pwa, name: b.dataset.pname }));
  el.querySelectorAll("[data-pmail]").forEach(b => b.onclick = () => templateMenu(b, s, d, "mail", { email: b.dataset.pmail, name: b.dataset.pname }));
}
