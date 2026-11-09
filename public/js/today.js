// Hoy: meta del día, agenda propia y a quién contactar ahora.
import { S, api, esc, icon, pill, save, today, addDays, nextBusinessDay, localAct, shortDay, TYPE_ICON, toast, openMenu } from "./core.js";
import { openSchool, startSession } from "./school.js";
import { setBadge } from "./app.js";

let host = null;
export async function loadToday() {
  S.today = await api(`/api/today?countries=${encodeURIComponent(S.territory.join(","))}`);
  const t = today();
  setBadge("hoy", (S.today.activities.items || []).filter(a => localAct(a).date <= t).length);
  return S.today;
}

export function renderToday(el) {
  host = el;
  if (!S.today) { el.innerHTML = skeleton(); loadToday().then(draw).catch(e => (el.innerHTML = `<div class="page"><div class="callout err">${icon("alert")}${esc(e.message)}</div></div>`)); }
  else { draw(); loadToday().then(() => host === el && draw()).catch(() => {}); }
}

function greeting() { const h = new Date().getHours(); return h < 12 ? "Buen día" : h < 19 ? "Buenas tardes" : "Buenas noches"; }

function draw() {
  if (!host || !S.today) return;
  const { stats, activities, queue } = S.today;
  const t = today();
  const acts = (activities.items || []).map(a => ({ ...a, ...localAct(a) }));
  const late = acts.filter(a => a.date < t), now = acts.filter(a => a.date === t), soon = acts.filter(a => a.date > t && a.date <= addDays(t, 7));
  const pct = Math.min(100, Math.round(stats.todayTouches / Math.max(1, stats.goal) * 100));
  const fresh = queue.filter(q => q.status !== "lost"), revive = queue.filter(q => q.status === "lost");
  const sessionCount = late.filter(a => a.schoolId).length + now.filter(a => a.schoolId).length + Math.min(queue.length, 25);
  const first = (S.me.name || "").split(" ")[0];
  const msg = stats.todayTouches >= stats.goal ? "Meta cumplida. Todo lo que sumes ahora es extra."
    : late.length ? `Empezá por ${late.length === 1 ? "la actividad vencida" : `las ${late.length} actividades vencidas`}: son compromisos que ya tomaste.`
    : now.length ? `Tenés ${now.length} ${now.length === 1 ? "actividad" : "actividades"} para hoy y ${queue.length} colegios listos para contactar.`
    : `Agenda al día. Hay ${queue.length} colegios priorizados para que avances.`;

  host.innerHTML = `<div class="page">
    <div class="page-head"><div><h1>${greeting()}, ${esc(first)}</h1><p>${esc(cap(new Intl.DateTimeFormat("es", { weekday: "long", day: "numeric", month: "long" }).format(new Date())))}</p></div></div>
    ${!S.me.pdUserId ? `<div class="callout warn" style="margin-bottom:16px">${icon("alert")}<span>Tu email (${esc(S.me.email)}) no coincide con ningún usuario de Pipedrive, así que no vemos tu agenda. Pedí que te den de alta con ese email.</span></div>` : ""}
    <section class="card hero">
      <div class="ring" style="--p:${pct}" role="img" aria-label="${stats.todayTouches} de ${stats.goal} contactos hoy"><b>${stats.todayTouches}<small>de ${stats.goal}</small></b></div>
      <div><h2>${stats.todayTouches ? "Vas bien" : "Arranquemos"}</h2><p>${esc(msg)}</p>
        <div class="kpis"><div class="kpi"><b>${stats.todayConnected}</b><span>conversaciones hoy</span></div><div class="kpi"><b>${stats.weekDemos}</b><span>demos esta semana</span></div><div class="kpi"><b>${stats.weekTouches}</b><span>contactos esta semana</span></div><div class="kpi"><b>${stats.weekTouches ? Math.round(stats.weekConnected / stats.weekTouches * 100) : 0}%</b><span>tasa de contacto</span></div></div>
      </div>
      <div class="hero-cta"><button class="btn primary lg" id="go">${icon("play")} Empezar sesión</button><small class="muted" style="text-align:center">${sessionCount} colegios en orden de prioridad</small></div>
    </section>
    <div class="today-grid">
      <section class="card">
        <div class="card-h"><h2>${icon("calendar")} Tu agenda</h2><span class="sub">${acts.length} pendientes en Pipedrive</span></div>
        <div class="card-b">${late.length + now.length + soon.length ? group("Vencidas", late, "late") + group("Hoy", now) + group("Próximos 7 días", soon) : `<div class="empty">${icon("checkCircle")}<b>Sin pendientes</b><span>Todo lo que agendes desde una ficha aparece acá.</span></div>`}</div>
      </section>
      <div class="stack">
        <section class="card">
          <div class="card-h"><h2>${icon("flame")} A quién llamar ahora</h2></div>
          <div class="card-b">
            <div class="territory"><span class="lbl">Tu territorio:</span><div class="chips" id="terr">${S.countries.map(c => `<button class="chip" data-c="${esc(c)}" aria-pressed="${S.territory.includes(c)}">${esc(c)}</button>`).join("")}</div></div>
            ${fresh.length ? fresh.slice(0, 10).map(prospectRow).join("") : `<div class="empty">${icon("search")}<span>No hay colegios para prospectar con este filtro. Probá sumar países o revisar ciudades en Prospectar.</span></div>`}
          </div>
        </section>
        ${revive.length ? `<section class="card"><div class="card-h"><h2>${icon("refresh")} Para reactivar</h2><span class="sub">Perdidos hace más de 4 meses</span></div><div class="card-b">${revive.slice(0, 6).map(prospectRow).join("")}</div></section>` : ""}
      </div>
    </div></div>`;

  host.querySelector("#go").onclick = () => startSession();
  host.querySelectorAll("#terr [data-c]").forEach(b => b.onclick = async () => {
    const c = b.dataset.c; S.territory = S.territory.includes(c) ? S.territory.filter(x => x !== c) : [...S.territory, c]; save("territory", S.territory);
    b.setAttribute("aria-pressed", S.territory.includes(c));
    await loadToday().catch(() => {}); draw();
  });
  host.querySelectorAll("[data-school]").forEach(b => b.onclick = () => openSchool(b.dataset.school, { activityId: b.dataset.act ? Number(b.dataset.act) : null }));
  host.querySelectorAll("[data-done]").forEach(b => b.onclick = () => markDone(Number(b.dataset.done)));
  host.querySelectorAll("[data-move]").forEach(b => b.onclick = () => moveMenu(b, Number(b.dataset.move)));
}
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

function group(title, list, cls = "") {
  if (!list.length) return "";
  return `<div class="group-h ${cls}">${title} <span class="n">${list.length}</span></div>` + list.slice(0, 30).map(a => actRow(a, cls === "late")).join("");
}
export function actRow(a, late) {
  const s = a.schoolId && S.byId.get(a.schoolId);
  const when = `${late ? `Vencida ${shortDay(a.date)}` : shortDay(a.date)}${a.time ? ` · ${a.time}` : ""}`;
  return `<div class="act"><span class="ty ${a.type}">${icon(TYPE_ICON[a.type] || "check")}</span>
    ${s ? `<button class="t" data-school="${esc(s.id)}" data-act="${a.id}"><b>${esc(a.subject)}</b><small class="${late ? "late" : ""}">${esc(a.typeLabel)} · ${esc(when)} · ${esc(s.city)}</small></button>`
      : `<div class="t"><b>${esc(a.subject)}</b><small class="${late ? "late" : ""}">${esc(a.typeLabel)} · ${esc(when)}</small></div>`}
    <div class="ops"><button class="icon-btn" data-done="${a.id}" title="Marcar como hecha" aria-label="Marcar como hecha">${icon("check")}</button><button class="icon-btn" data-move="${a.id}" title="Reprogramar" aria-label="Reprogramar">${icon("clock")}</button>${a.orgId ? `<a class="icon-btn" href="${esc(S.pdWeb)}/organization/${a.orgId}" target="_blank" rel="noopener" title="Abrir en Pipedrive" aria-label="Abrir en Pipedrive">${icon("external")}</a>` : ""}</div></div>`;
}
function prospectRow(q) {
  const cls = q.score >= 60 ? "" : q.score >= 40 ? "mid" : "low";
  return `<button class="prospect" data-school="${esc(q.id)}"><span class="score ${cls}" title="Prioridad">${q.score}</span><span class="t"><b>${esc(q.name)}</b><small>${esc(q.city)}, ${esc(q.country)}${q.lastTouch ? ` · último contacto ${esc(q.lastTouch.outcome.toLowerCase())}` : ""}</small><span class="why">${q.reasons.slice(0, 3).map(r => `<span class="tag">${esc(r)}</span>`).join("")}</span></span>${icon("arrowRight", "faint")}</button>`;
}

export async function markDone(id, after) {
  try { await api(`/api/activities/${id}/done`, { body: {} }); toast("Actividad marcada como hecha"); }
  catch (e) { return toast(e.message, { type: "err" }); }
  if (S.today) S.today.activities.items = S.today.activities.items.filter(a => a.id !== id);
  if (S.agenda) S.agenda.items = S.agenda.items.filter(a => a.id !== id);
  after ? after() : draw();
}
export function moveMenu(anchor, id, after) {
  const t = today();
  const opts = [["Mañana", addDays(t, 1)], ["Próximo día hábil", nextBusinessDay(t)], ["En 3 días", addDays(t, 3)], ["En una semana", addDays(t, 7)], ["En un mes", addDays(t, 30)]];
  openMenu(anchor, [{ head: "Reprogramar para" }, ...opts.map(([l, d]) => ({ label: l, sub: shortDay(d), fn: async () => {
    const all = [...(S.today?.activities.items || []), ...(S.agenda?.items || [])];
    const a = all.find(x => x.id === id); const time = a ? localAct(a).time : "";
    try { await api(`/api/activities/${id}/move`, { body: { date: d, time } }); toast(`Reprogramada para ${shortDay(d)}`); }
    catch (e) { return toast(e.message, { type: "err" }); }
    S.agenda = null; await loadToday().catch(() => {}); after ? after() : draw();
  } }))]);
}

function skeleton() {
  return `<div class="page"><div class="page-head"><div><div class="skel" style="width:260px;height:28px"></div><div class="skel" style="width:180px;margin-top:10px"></div></div></div>
  <div class="card hero"><div class="ring"><b>…</b></div><div><div class="skel" style="width:60%;height:20px"></div><div class="skel" style="width:85%;margin-top:12px"></div></div></div>
  <div class="today-grid"><div class="card card-b" style="padding:20px">${'<div class="skel" style="margin:14px 0"></div>'.repeat(6)}</div><div class="card card-b" style="padding:20px">${'<div class="skel" style="margin:14px 0"></div>'.repeat(6)}</div></div></div>`;
}
