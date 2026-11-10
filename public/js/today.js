// Hoy: meta del día, agenda propia y a quién contactar ahora.
import { S, api, esc, icon, save, patchSchool, today, addDays, nextBusinessDay, localAct, shortDay, TYPE_ICON, toast, openMenu, modal, cap, brainStaleMsg } from "./core.js";
import { openSchool, openRecord, startSession, resumeSession } from "./school.js";
import { setBadge, baseErrorCallout } from "./app.js";

let host = null, showAll = false;
const STATUS_REASONS = /^(Nunca contactado|Sin revisar|En Pipe sin trato)$/;

export async function loadToday() {
  S.today = await api(`/api/today?countries=${encodeURIComponent(S.territory.join(","))}`);
  syncBadge();
  verifyQueue();
  return S.today;
}
// Los primeros de la cola que todavía no se cruzaron con Pipedrive se revisan atrás: si su organización es de
// otra persona (o ya es cliente o tiene trato), salen de la cola. Así nunca se propone algo que no es tuyo.
let verifying = false;
async function verifyQueue() {
  const unk = (S.today?.queue || []).slice(0, 25).filter(q => q.status === "unk").map(q => q.id);
  if (verifying || !unk.length) return;
  verifying = true;
  try {
    const r = await api("/api/check", { body: { ids: unk } });
    const out = new Set(Object.entries(r).filter(([, v]) => !v.error && ((v.ownerId && v.ownerId !== S.me.pdUserId) || ["client", "open", "churn"].includes(v.status))).map(([id]) => id));
    Object.values(r).forEach(v => { if (!v.error) patchSchool(v); });
    if (S.today) { S.today.queue = S.today.queue.filter(q => !out.has(q.id)).map(q => r[q.id] && !r[q.id].error ? { ...q, status: r[q.id].status, detail: r[q.id].detail } : q); if (host?.isConnected) draw(); }
  } catch {} finally { verifying = false; }
}
function syncBadge() { const t = today(); setBadge("hoy", (S.today?.activities.items || []).filter(a => localAct(a).date <= t).length); }

export function renderToday(el) {
  host = el; showAll = false;
  if (!S.today) { el.innerHTML = skeleton(); loadToday().then(() => host === el && draw()).catch(e => host === el && drawError(e)); }
  else { draw(); loadToday().then(() => host === el && draw()).catch(e => toast(`No pudimos actualizar tu día: ${e.message}`, { type: "err", action: { label: "Reintentar", fn: () => renderToday(el) } })); }
}
function drawError(e) {
  host.innerHTML = `<div class="page">${baseErrorCallout()}<div class="callout err">${icon("alert")}<span>No pudimos traer tu día de Pipedrive: ${esc(e.message)}</span><button class="btn sm" id="retryToday">Reintentar</button></div></div>`;
  host.querySelector("#retryToday").onclick = () => { S.today = null; renderToday(host); };
}

const greeting = () => { const h = new Date().getHours(); return h < 12 ? "Buen día" : h < 19 ? "Buenas tardes" : "Buenas noches"; };
const firstName = () => cap((S.me.name || "").split(/[\s.@_]/)[0] || "");

function draw() {
  if (!host || !S.today) return;
  const focusKey = document.activeElement?.dataset?.focusKey;
  const { stats, activities, queue } = S.today;
  const t = today();
  const acts = (activities.items || []).map(a => ({ ...a, ...localAct(a) }));
  const late = acts.filter(a => a.date < t), now = acts.filter(a => a.date === t), soon = acts.filter(a => a.date > t && a.date <= addDays(t, 7));
  const pct = Math.min(100, Math.round(stats.todayTouches / Math.max(1, stats.goal) * 100));
  const fresh = queue.filter(q => q.status !== "lost" && q.status !== "stalled"), revive = queue.filter(q => q.status === "lost" || q.status === "stalled");
  const sk = new Set([...late, ...now].map(a => a.schoolId || a.record).filter(Boolean)), sessionCount = sk.size + queue.slice(0, 25).filter(q => !sk.has(q.id)).length;
  const left = Math.max(0, stats.goal - stats.todayTouches);
  const msg = !left ? "Meta cumplida. Lo que sumes ahora es extra."
    : late.length ? `Empezá por ${late.length === 1 ? "la actividad vencida" : `las ${late.length} actividades vencidas`}: son compromisos que ya tomaste.`
    : now.length ? `Tenés ${now.length} ${now.length === 1 ? "actividad" : "actividades"} para hoy. Te faltan ${left} contactos para la meta.`
    : `Agenda al día. Te faltan ${left} contactos para la meta.`;
  const rate = stats.weekTouches ? `${Math.round(stats.weekConnected / stats.weekTouches * 100)}%` : "—";
  const resume = S.lastSession && S.lastSession.i < S.lastSession.ids.length - 1;
  const terr = S.territory.length ? (S.territory.length <= 2 ? S.territory.join(", ") : `${S.territory.length} países`) : "Todos los países";
  const list = showAll ? fresh : fresh.slice(0, 6);

  host.innerHTML = `<div class="page">
    ${baseErrorCallout()}
    ${S.demo ? `<div class="callout warn" style="margin-bottom:16px">${icon("alert")}<span><b>Modo demo.</b> Pipedrive todavía no está conectado: la agenda, los tratos y las notas que ves son de prueba. Los colegios y los clientes de World Dominion sí son reales.</span></div>` : ""}
    ${S.brainDown || S.brain?.down ? `<div class="callout warn" style="margin-bottom:16px">${icon("alert")}<span>No pudimos leer los clientes de World Dominion: algún cliente puede aparecer en tu cola. Revisá en Pipedrive antes de llamar.</span></div>` : ""}
    ${brainStaleMsg() ? `<div class="callout warn" style="margin-bottom:16px">${icon("alert")}<span>${esc(brainStaleMsg())}</span></div>` : ""}
    <div class="page-head"><div><h1>${greeting()}, ${esc(firstName())}</h1><p>${esc(cap(new Intl.DateTimeFormat("es", { weekday: "long", day: "numeric", month: "long" }).format(new Date())))}</p></div></div>
    ${!S.me.pdUserId ? `<div class="callout warn" style="margin-bottom:16px">${icon("alert")}<span>Tu email (${esc(S.me.email)}) no coincide con ningún usuario de Pipedrive, así que no vemos tu agenda. Pedí que te den de alta con ese email.</span></div>` : ""}
    <section class="card hero" aria-label="Tu día">
      <div class="ring" style="--p:${pct}" role="img" aria-label="${stats.todayTouches} de ${stats.goal} contactos hoy"><b>${stats.todayTouches}<small>de ${stats.goal}</small></b></div>
      <div class="hero-txt"><h2>${esc(msg)}</h2>
        <div class="kpis">
          <div class="kpi"><b>${stats.todayConnected}</b><span>conversaciones hoy</span></div>
          <div class="kpi"><b>${stats.weekDemos}</b><span>demos en 7 días</span></div>
          <div class="kpi" title="${stats.weekConnected} conversaciones de ${stats.weekTouches} contactos"><b>${rate}</b><span>tasa de contacto</span></div>
        </div>
      </div>
      <div class="hero-cta">${resume ? `<button class="btn primary lg" id="resume">${icon("play")} Retomar sesión · ${S.lastSession.i + 1} de ${S.lastSession.ids.length}</button><button class="btn ghost sm" id="go">Empezar una nueva</button>`
        : `<button class="btn primary lg" id="go" ${sessionCount ? "" : "disabled"}>${icon("play")} Empezar sesión · ${sessionCount}</button>`}</div>
    </section>
    <div class="today-grid">
      <section class="card" aria-labelledby="hAg">
        <div class="card-h"><h2 id="hAg">${icon("calendar")} Tu agenda</h2><span class="sub">${acts.length} pendientes</span></div>
        <div class="card-b">${late.length + now.length + soon.length ? group("Vencidas", late, "late") + group("Hoy", now) + group("Próximos 7 días", soon) : `<div class="empty">${icon("checkCircle")}<b>Sin pendientes</b><span>Lo que agendes desde una ficha aparece acá.</span></div>`}</div>
      </section>
      <div class="stack" id="right">
        <section class="card" aria-labelledby="hQ">
          <div class="card-h"><h2 id="hQ">${icon("flame")} A quién llamar ahora</h2><button class="btn sm" id="terr" aria-haspopup="dialog" data-focus-key="terr">${icon("globe", "sm")} ${esc(terr)}</button></div>
          <div class="card-b">
            ${list.length ? list.map(prospectRow).join("") + (fresh.length > 6 ? `<button class="btn ghost sm block" id="more" data-focus-key="more">${showAll ? "Ver menos" : `Ver ${fresh.length - 6} más`}</button>` : "")
              : `<div class="empty">${icon("search")}<span>No hay colegios para prospectar en ${esc(terr.toLowerCase())}. Sumá países o revisá ciudades en Prospectar.</span></div>`}
          </div>
        </section>
        ${revive.length ? `<section class="card" aria-labelledby="hR"><div class="card-h"><h2 id="hR">${icon("refresh")} Para reactivar</h2><span class="sub">perdidos hace más de 4 meses</span></div><div class="card-b">${revive.slice(0, 4).map(prospectRow).join("")}</div></section>` : ""}
      </div>
    </div></div>`;

  host.querySelector("#go")?.addEventListener("click", () => { S.lastSession = null; startSession(); });
  host.querySelector("#resume")?.addEventListener("click", () => resumeSession());
  host.querySelector("#terr").onclick = territoryPicker;
  host.querySelector("#more")?.addEventListener("click", () => { showAll = !showAll; draw(); });
  host.querySelectorAll("[data-school]").forEach(b => b.onclick = () => openSchool(b.dataset.school, { activityId: b.dataset.act ? Number(b.dataset.act) : null }));
  host.querySelectorAll("[data-record]").forEach(b => b.onclick = () => openRecord(b.dataset.record, { activityId: Number(b.dataset.act) || null }));
  host.querySelectorAll("[data-done]").forEach(b => b.onclick = () => markDone(Number(b.dataset.done)));
  host.querySelectorAll("[data-move]").forEach(b => b.onclick = () => moveMenu(b, Number(b.dataset.move)));
  if (focusKey) host.querySelector(`[data-focus-key="${focusKey}"]`)?.focus();
}

// Territorio: un solo botón que abre la lista de países (ninguno elegido = todos).
function territoryPicker() {
  let sel = [...S.territory];
  const m = modal(`<h3>Tu territorio</h3><p class="muted" style="margin:0">Elegí los países que trabajás. Sin ninguno elegido se muestran todos.</p>
    <div class="chips" id="tc">${S.countries.map(c => `<button class="chip" data-c="${esc(c)}" aria-pressed="${sel.includes(c)}">${esc(c)}</button>`).join("")}</div>
    <div class="row"><button class="btn ghost" id="tAll">Todos</button><button class="btn primary" id="tOk">Listo</button></div>`, { onClose: () => host.querySelector("#terr")?.focus() });
  m.querySelectorAll("[data-c]").forEach(b => b.onclick = () => { const c = b.dataset.c; sel = sel.includes(c) ? sel.filter(x => x !== c) : [...sel, c]; b.setAttribute("aria-pressed", sel.includes(c)); });
  const apply = async () => {
    m.close();
    S.territory = sel; save("territory", sel);
    const r = host.querySelector("#right"); r?.setAttribute("aria-busy", "true");
    await loadToday().catch(e => toast(e.message, { type: "err" }));
    draw();
  };
  m.querySelector("#tAll").onclick = () => { sel = []; apply(); };
  m.querySelector("#tOk").onclick = apply;
}

function group(title, list, cls = "") {
  if (!list.length) return "";
  return `<div class="group-h ${cls}">${title} <span class="n">${list.length}</span></div>` + list.slice(0, 30).map(a => actRow(a, cls === "late")).join("");
}
// Fila de actividad: el colegio primero, después qué hay que hacer y cuándo. El tipo lo dice el ícono.
export function actRow(a, late) {
  const s = a.schoolId && S.byId.get(a.schoolId);
  const when = `${late ? `Vencida ${shortDay(a.date)}` : shortDay(a.date)}${a.time ? ` · ${a.time}` : ""}`;
  const what = s ? a.subject.replace(new RegExp(`\\s*·\\s*${s.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`), "") : a.subject;
  // sin colegio de la base: el nombre del prospecto, la persona o la organización de Pipedrive
  const title = s ? s.name : a.who || a.subject;
  const sub = `${s ? `${what} · ` : a.who ? `${a.subject}${a.kind ? ` · ${a.kind.toLowerCase()}` : ""} · ` : ""}${when}${s ? ` · ${s.city}` : ""}${!s && a.note ? ` · «${a.note}»` : ""}`;
  return `<div class="act"><span class="ty ${a.type}" role="img" aria-label="${esc(a.typeLabel)}" title="${esc(a.typeLabel)}">${icon(TYPE_ICON[a.type] || "check")}</span>
    ${s ? `<button class="t" data-school="${esc(s.id)}" data-act="${a.id}"><b>${esc(title)}</b><small class="${late ? "late" : ""}">${esc(sub)}</small></button>`
      : a.record ? `<button class="t" data-record="${esc(a.record)}" data-act="${a.id}" title="Abrir la ficha"><b>${esc(title)}</b><small class="${late ? "late" : ""}">${esc(sub)}</small></button>`
      : a.url ? `<a class="t" href="${esc(a.url)}" target="_blank" rel="noopener" title="Abrir en Pipedrive"><b>${esc(title)} ${icon("external", "sm")}</b><small class="${late ? "late" : ""}">${esc(sub)}</small></a>`
      : `<div class="t"><b>${esc(title)}</b><small class="${late ? "late" : ""}">${esc(sub)}</small></div>`}
    <div class="ops"><button class="icon-btn" data-done="${a.id}" data-focus-key="done-${a.id}" title="Marcar como hecha" aria-label="Marcar como hecha">${icon("check")}</button><button class="icon-btn" data-move="${a.id}" title="Reprogramar" aria-label="Reprogramar">${icon("clock")}</button></div></div>`;
}
function prospectRow(q) {
  const cls = q.score >= 60 ? "" : q.score >= 40 ? "mid" : "low";
  const why = q.reasons.filter(r => !STATUS_REASONS.test(r)).slice(0, 3);
  return `<button class="prospect" data-school="${esc(q.id)}"><span class="score ${cls}" title="Prioridad ${q.score} de 100">${q.score}</span><span class="t"><b>${esc(q.name)}</b><small>${esc(q.city)}, ${esc(q.country)}${q.lastTouch ? ` · último: ${esc(q.lastTouch.outcome.toLowerCase())}` : ""}</small>${why.length ? `<span class="why">${why.map(r => `<span class="tag">${esc(r)}</span>`).join("")}</span>` : ""}</span>${icon("arrowRight", "faint")}</button>`;
}

// Enfoca la fila que sigue a la actividad (o la anterior si era la última), en la vista que esté abierta.
function nextFocusKey(id) {
  const btns = [...document.querySelectorAll("#main [data-done]")], k = btns.findIndex(b => b.dataset.done === String(id));
  const n = btns[k + 1] || btns[k - 1];
  return n ? n.dataset.done : null;
}
const focusDone = id => (id && document.querySelector(`#main [data-done="${id}"]`) || document.getElementById("main"))?.focus({ preventScroll: !id });
export async function markDone(id, after) {
  const nextId = nextFocusKey(id);
  const all = S.today?.activities.items || [], agenda = S.agenda?.items || [];
  const removed = all.find(a => a.id === id) || agenda.find(a => a.id === id);
  const iT = all.findIndex(a => a.id === id), iA = agenda.findIndex(a => a.id === id);
  try { await api(`/api/activities/${id}/done`, { body: {} }); }
  catch (e) { return toast(e.message, { type: "err" }); }
  if (S.today) S.today.activities.items = all.filter(a => a.id !== id);
  if (S.agenda) S.agenda.items = agenda.filter(a => a.id !== id);
  syncBadge();
  toast("Actividad marcada como hecha", { action: { label: "Deshacer", fn: async () => {
    try { await api(`/api/activities/${id}/undone`, { body: {} }); } catch (e) { return toast(e.message, { type: "err" }); }
    // vuelve a su lugar en la lista, no al final
    if (removed) { if (S.today && iT >= 0) S.today.activities.items.splice(iT, 0, removed); if (S.agenda && iA >= 0) S.agenda.items.splice(iA, 0, removed); }
    syncBadge(); after ? after() : draw();
  } } });
  after ? after() : draw();
  focusDone(nextId);
}
export function moveMenu(anchor, id, after) {
  const t = today(), nb = nextBusinessDay(t);
  const opts = [["Mañana", addDays(t, 1)], ...(nb !== addDays(t, 1) ? [["Próximo día hábil", nb]] : []), ["En 3 días", addDays(t, 3)], ["En una semana", addDays(t, 7)], ["En un mes", addDays(t, 30)]];
  const all = [...(S.today?.activities.items || []), ...(S.agenda?.items || [])];
  const a = all.find(x => x.id === id); const time = a ? localAct(a).time : "";
  const done = async (d, tm) => {
    try { await api(`/api/activities/${id}/move`, { body: { date: d, time: tm } }); toast(`Reprogramada para ${shortDay(d)}${tm ? ` a las ${tm}` : ""}`); }
    catch (e) { return toast(e.message, { type: "err" }); }
    const nextId = nextFocusKey(id);
    await loadToday().catch(() => {}); after ? after() : draw();
    focusDone(document.querySelector(`#main [data-done="${id}"]`) ? id : nextId);
  };
  const abs = d => new Intl.DateTimeFormat("es", { weekday: "short", day: "numeric", month: "short" }).format(new Date(d + "T12:00:00"));
  openMenu(anchor, [{ head: "Reprogramar para" }, ...opts.map(([l, d]) => ({ label: l, sub: abs(d), fn: () => done(d, time) })),
    { label: "Elegir fecha y hora…", sub: "", fn: () => {
      const m = modal(`<h3>Reprogramar</h3><div class="grid2"><label class="field"><span>Día</span><input class="inp" type="date" id="mvD" min="${t}" value="${addDays(t, 1)}"></label><label class="field"><span>Hora <span class="faint">opcional</span></span><input class="inp" type="time" id="mvT" step="900" value="${esc(time)}"></label></div><div class="row"><button class="btn ghost" id="mvX">Cancelar</button><button class="btn primary" id="mvOk">Reprogramar</button></div>`, { onClose: () => anchor.focus() });
      m.querySelector("#mvX").onclick = () => m.close();
      m.querySelector("#mvOk").onclick = () => { const d = m.querySelector("#mvD").value; if (!d) return; m.close(); done(d, m.querySelector("#mvT").value); };
    } }]);
}

function skeleton() {
  return `<div class="page">${baseErrorCallout()}<div class="page-head"><div><div class="skel" style="width:260px;height:28px"></div><div class="skel" style="width:180px;margin-top:10px"></div></div></div>
  <div class="card hero"><div class="ring"><b>…</b></div><div><div class="skel" style="width:70%;height:20px"></div><div class="skel" style="width:50%;margin-top:14px"></div></div></div>
  <div class="today-grid"><div class="card card-b" style="padding:20px">${'<div class="skel" style="margin:14px 0"></div>'.repeat(6)}</div><div class="card card-b" style="padding:20px">${'<div class="skel" style="margin:14px 0"></div>'.repeat(6)}</div></div></div>`;
}
