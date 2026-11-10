// Agenda: actividades pendientes propias en Pipedrive, con filtros de fecha, zona o evento y tipo.
import { S, api, esc, icon, today, addDays, localAct, dayLabel, shortDay, norm, save, matchZone, zoneOptions, ZONE_KIND, workOrder } from "./core.js";
import { actRow, markDone, moveMenu, demoResultMenu } from "./today.js";
import { openSchool, openRecord, startSession } from "./school.js";

let host, error = null, loading = false;
const PLURAL = { all: "Todas", call: "Llamadas", meeting: "Demos", deadline: "WhatsApp", task: "Mails", contacto_decisor: "Decisores" };
const WHEN = [["all", "Todas"], ["today", "Hoy"], ["late", "Vencidas"], ["yesterday", "Ayer"], ["week", "Próximos 7 días"], ["range", "Fechas…"]];
// los filtros se recuerdan entre pantallas y visitas
const F = Object.assign({ type: "all", when: "all", from: "", to: "", zone: "", q: "" }, (() => { try { return JSON.parse(localStorage.getItem("ob.agendaF") || "{}"); } catch { return {}; } })());
const keep = () => save("agendaF", F);

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
function drawHead() {
  const b = host?.querySelector("#reload"); if (!b) return;
  b.disabled = loading; b.innerHTML = loading ? `<span class="spin"></span>` : icon("refresh");
}
function inWhen(a, t) {
  switch (F.when) {
    case "today": return a.date === t;
    case "late": return a.date < t;
    case "yesterday": return a.date === addDays(t, -1);
    case "week": return a.date > t && a.date <= addDays(t, 7);
    case "range": return (!F.from || a.date >= F.from) && (!F.to || a.date <= F.to);
    default: return true;
  }
}
const whenLabel = t => F.when === "range" ? (F.from && F.to ? `entre ${shortDay(F.from)} y ${shortDay(F.to)}` : F.from ? `desde ${shortDay(F.from)}` : F.to ? `hasta ${shortDay(F.to)}` : "en cualquier fecha")
  : { all: "", today: "de hoy", late: "vencidas", yesterday: "de ayer", week: "de los próximos 7 días" }[F.when] || "";

function draw() {
  if (!host) return;
  const focusKey = document.activeElement?.dataset?.focusKey, t = today();
  const all = (S.agenda?.items || []).map(a => ({ ...a, ...localAct(a) }));
  const zonesAll = zoneOptions(all);
  // los filtros guardados solo se corrigen con los datos ya cargados (si no, se perderían al recargar)
  if (S.agenda && !loading && F.zone && /^[ecrp]:/.test(F.zone) && !zonesAll.some(z => z.key === F.zone)) { F.zone = ""; keep(); }
  // cada filtro cuenta con los otros dos aplicados, así los números de los chips dicen lo que vas a ver
  const byWhen = a => inWhen(a, t), byZone = a => matchZone(a, F.zone) && matchZone(a, F.q, { loose: true }), byType = a => F.type === "all" || a.type === F.type;
  const base = all.filter(a => byWhen(a) && byZone(a));
  const c = { all: base.length }; for (const a of base) c[a.type] = (c[a.type] || 0) + 1;
  const types = [["all", "Todas"], ...Object.entries(S.types || {}).filter(([k]) => c[k])];
  // las zonas cuentan con la fecha y el tipo elegidos; la elegida queda aunque ahora tenga 0
  const zc = new Map(zoneOptions(all.filter(a => byWhen(a) && byType(a))).map(z => [z.key, z.n]));
  const zones = zonesAll.map(z => ({ ...z, n: zc.get(z.key) || 0 })).filter(z => z.n || z.key === F.zone).sort((a, b) => b.n - a.n || a.label.localeCompare(b.label));
  if (S.agenda && !loading && F.type !== "all" && !c[F.type] && !all.some(a => a.type === F.type)) { F.type = "all"; keep(); }
  const items = base.filter(byType);
  const wc = Object.fromEntries(WHEN.map(([k]) => [k, all.filter(a => byZone(a) && byType(a) && (k === "range" || inWhenK(a, t, k))).length]));
  const byDay = new Map();
  for (const a of items) { const k = a.date < t ? "late" : a.date; if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(a); }
  const keys = [...byDay.keys()].sort((a, b) => (a === "late" ? -1 : b === "late" ? 1 : a.localeCompare(b)));
  // lo vencido, de lo más reciente a lo más viejo: lo de ayer está arriba
  if (byDay.has("late")) byDay.get("late").sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
  const late = all.filter(a => a.date < t).length, now = all.filter(a => a.date === t).length;
  const summary = S.agenda ? [late && `${late} vencida${late > 1 ? "s" : ""}`, `${now} para hoy`, `${all.length} en total`].filter(Boolean).join(" · ") : "";
  const filtered = F.when !== "all" || F.zone || F.q || F.type !== "all";
  const workable = items.filter(a => a.schoolId || a.record), fichas = new Set(workable.map(a => a.schoolId || a.record)).size;
  const zoneName = F.zone ? zones.find(z => z.key === F.zone)?.label : F.q;
  const groups = ["e", "c", "r", "p"].map(k => [k, zones.filter(z => z.k === k)]).filter(([, l]) => l.length);

  host.innerHTML = `<div class="page">
    <div class="page-head"><div><h1>Agenda</h1>${summary ? `<p>${esc(summary)}</p>` : ""}</div>
      <button class="icon-btn" id="reload" aria-label="Actualizar desde Pipedrive" title="Actualizar desde Pipedrive">${icon("refresh")}</button></div>
    ${error ? `<div class="callout err" style="margin-bottom:16px">${icon("alert")}<span>No pudimos traer tu agenda de Pipedrive: ${esc(error)}</span><button class="btn sm" id="retry">Reintentar</button></div>` : ""}
    ${S.agenda?.warning ? `<div class="callout warn" style="margin-bottom:16px">${icon("alert")}<span>${esc(S.agenda.warning)}</span></div>` : ""}
    ${!S.agenda && !error ? skeleton() : S.agenda ? `
      <div class="ag-filters">
        <div class="chips" role="group" aria-label="Cuándo">${WHEN.map(([k, l]) => `<button class="chip" data-w="${k}" data-focus-key="w-${k}" aria-pressed="${F.when === k}">${esc(l)}${k !== "range" ? ` <b>${wc[k]}</b>` : ""}</button>`).join("")}</div>
        ${F.when === "range" ? `<div class="ag-range"><label class="field"><span>Desde</span><input class="inp" type="date" id="agFrom" value="${esc(F.from)}"></label><label class="field"><span>Hasta</span><input class="inp" type="date" id="agTo" value="${esc(F.to)}"></label></div>` : ""}
        <div class="ag-zone">
          <label class="field"><span>Zona o evento</span><select class="inp" id="agZone" data-focus-key="zone">
            <option value="">Todas</option>
            ${groups.map(([k, l]) => `<optgroup label="${esc(ZONE_KIND[k])}">${l.map(z => `<option value="${esc(z.key)}" ${F.zone === z.key ? "selected" : ""}>${esc(z.label)} (${z.n})</option>`).join("")}</optgroup>`).join("")}
          </select></label>
          <label class="field"><span>Buscar</span><input class="inp" type="search" id="agQ" data-focus-key="q" placeholder="Colegio, ciudad o evento" value="${esc(F.q)}"></label>
        </div>
        ${types.length > 2 ? `<div class="chips" role="group" aria-label="Tipo de actividad">${types.map(([k, l]) => `<button class="chip" data-t="${k}" data-focus-key="t-${k}" aria-pressed="${F.type === k}">${esc(PLURAL[k] || l)} <b>${c[k] || 0}</b></button>`).join("")}</div>` : ""}
      </div>
      ${filtered ? `<div class="ag-bar"><span><b>${items.length}</b> ${items.length === 1 ? "actividad" : "actividades"} ${esc([whenLabel(t), zoneName && `· ${zoneName}`].filter(Boolean).join(" "))}</span>
        <span class="ag-bar-act"><button class="btn ghost sm" id="agClear">Limpiar filtros</button>${fichas ? `<button class="btn primary sm" id="agWork">${icon("play", "sm")} ${fichas === 1 ? "Trabajar este colegio" : `Trabajar estos ${fichas} colegios`}</button>` : ""}</span></div>` : ""}
      ${keys.length ? keys.map(k => `<section class="card agenda-day" aria-label="${k === "late" ? "Vencidas" : esc(dayLabel(k))}"><h3 style="${k === "late" ? "color:var(--err)" : ""}">${k === "late" ? "Vencidas" : esc(dayLabel(k))} <small>${byDay.get(k).length}</small></h3>${byDay.get(k).map(a => actRow(a, k === "late")).join("")}</section>`).join("")
        : filtered ? `<div class="card"><div class="empty">${icon("search")}<b>Nada con estos filtros</b><span>Probá con otra fecha o zona.</span></div></div>`
        : `<div class="card"><div class="empty">${icon("checkCircle")}<b>Nada pendiente</b><span>Cuando registres un contacto con próximo paso, aparece acá.</span></div></div>`}` : ""}
  </div>`;
  drawHead();
  const q = s => host.querySelector(s);
  q("#reload").onclick = refresh;
  q("#retry")?.addEventListener("click", refresh);
  const set = (k, v) => { F[k] = v; keep(); draw(); };
  host.querySelectorAll("[data-w]").forEach(b => b.onclick = () => set("when", b.dataset.w));
  host.querySelectorAll("[data-t]").forEach(b => b.onclick = () => set("type", b.dataset.t));
  q("#agFrom")?.addEventListener("change", e => set("from", e.target.value));
  q("#agTo")?.addEventListener("change", e => set("to", e.target.value));
  q("#agZone")?.addEventListener("change", e => set("zone", e.target.value));
  let tm; q("#agQ")?.addEventListener("input", e => { clearTimeout(tm); tm = setTimeout(() => { F.q = e.target.value; keep(); draw(); const i = q("#agQ"); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }, 250); });
  q("#agClear")?.addEventListener("click", () => { Object.assign(F, { type: "all", when: "all", from: "", to: "", zone: "", q: "" }); keep(); draw(); });
  q("#agWork")?.addEventListener("click", () => startSession(null, zoneName || whenLabel(t) || "tu agenda", { acts: workOrder(workable, t) }));
  host.querySelectorAll("[data-school]").forEach(b => b.onclick = () => openSchool(b.dataset.school, { activityId: Number(b.dataset.act) }));
  host.querySelectorAll("[data-record]").forEach(b => b.onclick = () => openRecord(b.dataset.record, { activityId: Number(b.dataset.act) || null }));
  host.querySelectorAll("[data-done]").forEach(b => b.onclick = () => { b.disabled = true; b.closest(".act")?.setAttribute("aria-busy", "true"); markDone(Number(b.dataset.done), draw); });
  // al reprogramar se actualiza en el momento y se revalida atrás, sin vaciar la lista
  host.querySelectorAll("[data-move]").forEach(b => b.onclick = () => moveMenu(b, Number(b.dataset.move), () => { draw(); refresh(); }));
  host.querySelectorAll("[data-demo]").forEach(b => b.onclick = () => demoResultMenu(b, { id: Number(b.dataset.demo), time: b.dataset.time }, () => { draw(); refresh(); }));
  if (focusKey && focusKey !== "q") host.querySelector(`[data-focus-key="${focusKey}"]`)?.focus();
}
function inWhenK(a, t, k) { const w = F.when; F.when = k; const r = inWhen(a, t); F.when = w; return r; }
function skeleton() {
  return [1, 2].map(() => `<section class="card agenda-day" style="padding:16px">${'<div class="skel" style="margin:12px 0"></div>'.repeat(3)}</section>`).join("");
}
