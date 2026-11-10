// Hoy: meta del día, agenda propia y a quién contactar ahora.
import { S, api, esc, icon, potTag, save, patchSchool, today, addDays, nextBusinessDay, localAct, shortDay, TYPE_ICON, toast, openMenu, modal, cap, brainStaleMsg, brainTokenCallout, matchZone, zoneOptions, ZONE_KIND, workOrder, norm, callPill, callQueue, hotRows, demoDue, archivedRef, archivedAct } from "./core.js";
import { openSchool, openRecord, startSession, resumeSession } from "./school.js";
import { setBadge, baseErrorCallout } from "./app.js";
import { loadSessions, sessionsCard, bindSessionsCard } from "./sessions.js";

let host = null, showAll = false, hotLeads = null, hotAll = false;
const STATUS_REASONS = /^(Nunca contactado|Sin revisar|En Pipe sin trato)$/;

export async function loadToday() {
  // las sesiones guardadas se leen junto (si fallan, Hoy sigue sin la tarjeta)
  [S.today] = await Promise.all([api(`/api/today?countries=${encodeURIComponent(S.territory.join(","))}`), loadSessions().catch(() => null)]);
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
// Prospectos nuevos para vos (bandeja caliente): aparte, para no frenar Hoy. Si falla, la bandeja queda solo con las demos.
let hotSeq = 0;
function loadHot() { const my = ++hotSeq; api("/api/hot").then(r => { if (my === hotSeq) { hotLeads = r.items || []; if (host?.isConnected) draw(); } }).catch(() => { if (my === hotSeq) { hotLeads = hotLeads || []; if (host?.isConnected) draw(); } }); }
function syncBadge() { const t = today(); setBadge("hoy", (S.today?.activities.items || []).filter(a => localAct(a).date <= t).length); }

export function renderToday(el) {
  host = el; showAll = false; hotAll = false; loadHot();
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
  const late = acts.filter(a => a.date < t).sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time)), now = acts.filter(a => a.date === t), soon = acts.filter(a => a.date > t && a.date <= addDays(t, 7));
  const pct = Math.min(100, Math.round(stats.todayTouches / Math.max(1, stats.goal) * 100));
  // los que están en horario de oficina van primero (orden estable); la sesión llama en este mismo orden (callQueue)
  const order = callQueue(queue), fresh = order.filter(q => q.status !== "lost" && q.status !== "stalled"), revive = order.filter(q => q.status === "lost" || q.status === "stalled");
  const sk = new Set([...late, ...now].map(a => a.schoolId || a.record).filter(Boolean)), sessionCount = sk.size + order.slice(0, 25).filter(q => !sk.has(q.id)).length;
  const left = Math.max(0, stats.goal - stats.todayTouches);
  const msg = !left ? "Meta cumplida. Lo que sumes ahora es extra."
    : now.length ? `Empezá por ${now.length === 1 ? "tu actividad de hoy" : `tus ${now.length} actividades de hoy`}.${late.length ? ` Después siguen ${late.length === 1 ? "la vencida" : `las ${late.length} vencidas`} y los colegios nuevos.` : ` Te faltan ${left} contactos para la meta.`}`
    : late.length ? `Lo de hoy está al día. Seguí con ${late.length === 1 ? "la actividad vencida" : `las ${late.length} vencidas`}, de la más reciente a la más vieja.`
    : `Agenda al día. Te faltan ${left} contactos para la meta.`;
  const rate = stats.weekTouches ? `${Math.round(stats.weekConnected / stats.weekTouches * 100)}%` : "—";
  // El botón grande retoma la sesión más reciente con algo pendiente, solo si se movió hoy y no es la «Tu día» de otro día
  // (esa la termina el servidor al cambiar el día). A la mañana vuelve a mandar «Empezar sesión»; las demás están en la tarjeta.
  const last = (S.sessions?.open || []).find(v => v.resume >= 0 && new Date(v.lastAt).toLocaleDateString("sv") === t && !(v.origin?.kind === "today" && v.origin.key !== `today:${t}`)), resume = !!last;
  const terr = S.territory.length ? (S.territory.length <= 2 ? S.territory.join(", ") : `${S.territory.length} países`) : "Todos los países";
  const list = showAll ? fresh : fresh.slice(0, 6);
  const hot = hotRows((activities.items || []).filter(a => !archivedAct(a)), (hotLeads || []).filter(l => !archivedRef(l.schoolId || l.record)), t), hotList = hotAll ? hot : hot.slice(0, 6);

  host.innerHTML = `<div class="page">
    ${baseErrorCallout()}
    ${S.demo ? `<div class="callout warn" style="margin-bottom:16px">${icon("alert")}<span><b>Modo demo.</b> Pipedrive todavía no está conectado: la agenda, los tratos y las notas que ves son de prueba. Los colegios y los clientes de World Dominion sí son reales.</span></div>` : ""}
    ${S.brainDown || S.brain?.down ? `<div class="callout warn" style="margin-bottom:16px">${icon("alert")}<span>No pudimos leer los clientes de World Dominion: algún cliente puede aparecer en tu cola. Revisá en Pipedrive antes de llamar.</span></div>` : ""}
    ${brainTokenCallout()}
    ${brainStaleMsg() ? `<div class="callout warn" style="margin-bottom:16px">${icon("alert")}<span>${esc(brainStaleMsg())}</span></div>` : ""}
    <div class="page-head"><div><h1>${greeting()}, ${esc(firstName())}</h1><p>${esc(cap(new Intl.DateTimeFormat("es", { weekday: "long", day: "numeric", month: "long" }).format(new Date())))}</p></div></div>
    ${!S.me.pdUserId ? `<div class="callout warn" style="margin-bottom:16px">${icon("alert")}<span>Tu email (${esc(S.me.email)}) no coincide con ningún usuario de Pipedrive, así que no vemos tu agenda. Pedí que te den de alta con ese email.</span></div>` : ""}
    ${hot.length ? `<section class="card hot" aria-labelledby="hH"><div class="card-h"><h2 id="hH">${icon("flame")} Bandeja caliente</h2><span class="sub">${hotLeads ? "demos cerca y prospectos nuevos para vos" : "buscando prospectos nuevos…"}</span></div>
      <div class="card-b">${hotList.map(hotRow).join("")}${hot.length > 6 ? `<button class="btn ghost sm block" id="hotMore" data-focus-key="hotMore">${hotAll ? "Ver menos" : `Ver ${hot.length - 6} más`}</button>` : ""}</div></section>` : ""}
    <section class="card hero" aria-label="Tu día">
      <div class="ring" style="--p:${pct}" role="img" aria-label="${stats.todayTouches} de ${stats.goal} contactos hoy"><b>${stats.todayTouches}<small>de ${stats.goal}</small></b></div>
      <div class="hero-txt"><h2>${esc(msg)}</h2>
        <div class="kpis">
          <div class="kpi"><b>${stats.todayConnected}</b><span>conversaciones hoy</span></div>
          <div class="kpi"><b>${stats.weekDemos}</b><span>demos en 7 días</span></div>
          <div class="kpi" title="${stats.weekConnected} conversaciones de ${stats.weekTouches} contactos"><b>${rate}</b><span>tasa de contacto</span></div>
        </div>
      </div>
      <div class="hero-cta">${resume ? `<button class="btn primary lg" id="resume" aria-label="Retomar «${esc(last.name)}» · faltan ${last.stats.pending}" title="Retomar «${esc(last.name)}»: ${last.stats.handled} de ${last.stats.total}">${icon("play")} <span class="ell">Retomar «${esc(last.name)}»</span><span class="nw">· faltan ${last.stats.pending}</span></button><button class="btn ghost sm" id="go">Empezar una nueva</button>`
        : `<button class="btn primary lg" id="go" ${sessionCount ? "" : "disabled"}>${icon("play")} Empezar sesión · ${sessionCount}</button>`}
        <button class="btn ghost sm" id="zoneGo" aria-haspopup="dialog" data-focus-key="zoneGo">${icon("map", "sm")} Trabajar una zona o evento</button></div>
    </section>
    ${sessionsCard()}
    <div class="today-grid">
      <section class="card" aria-labelledby="hAg">
        <div class="card-h"><h2 id="hAg">${icon("calendar")} Tu agenda</h2><span class="sub">${acts.length} pendientes</span></div>
        <div class="card-b">${late.length + now.length + soon.length ? group("Hoy", now) + group("Vencidas", late, "late") + group("Próximos 7 días", soon) : `<div class="empty">${icon("checkCircle")}<b>Sin pendientes</b><span>Lo que agendes desde una ficha aparece acá.</span></div>`}</div>
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

  host.querySelector("#go")?.addEventListener("click", () => startSession());
  host.querySelector("#resume")?.addEventListener("click", () => resumeSession(last.id));
  bindSessionsCard(host, () => host?.isConnected && draw());
  host.querySelector("#terr").onclick = territoryPicker;
  host.querySelector("#zoneGo")?.addEventListener("click", zoneSession);
  host.querySelector("#more")?.addEventListener("click", () => { showAll = !showAll; draw(); });
  host.querySelector("#hotMore")?.addEventListener("click", () => { hotAll = !hotAll; draw(); });
  host.querySelectorAll("[data-school]").forEach(b => b.onclick = () => openSchool(b.dataset.school, { activityId: b.dataset.act ? Number(b.dataset.act) : null }));
  host.querySelectorAll("[data-record]").forEach(b => b.onclick = () => openRecord(b.dataset.record, { activityId: Number(b.dataset.act) || null }));
  host.querySelectorAll("[data-done]").forEach(b => b.onclick = () => markDone(Number(b.dataset.done)));
  host.querySelectorAll("[data-move]").forEach(b => b.onclick = () => moveMenu(b, Number(b.dataset.move)));
  host.querySelectorAll("[data-demo]").forEach(b => b.onclick = () => demoResultMenu(b, { id: Number(b.dataset.demo), time: b.dataset.time }));
  if (focusKey) host.querySelector(`[data-focus-key="${focusKey}"]`)?.focus();
}

// Sesión especial por zona o evento («hoy quiero trabajar Puebla»): primero tus actividades de ahí (hoy, después vencidas)
// y después los colegios nuevos de esa ciudad que no tienen dueño ni actividad tuya.
function zoneSession() {
  const t = today(), acts = (S.today?.activities.items || []).map(a => ({ ...a, ...localAct(a) })).filter(a => a.date <= t && (a.schoolId || a.record));
  const sug = zoneOptions(acts).slice(0, 12);
  const m = modal(`<h3>Trabajar una zona o evento</h3>
    <p class="muted" style="margin:0">Primero van tus actividades de esa zona (las de hoy y después las vencidas). Al terminar siguen los colegios nuevos de esa ciudad.</p>
    <label class="field"><span>Zona o evento</span><input class="inp" id="zsQ" list="zsL" placeholder="Puebla, Pachuca, EduExperience…" autocomplete="off">
      <datalist id="zsL">${sug.map(z => `<option value="${esc(z.label)}">`).join("")}</datalist></label>
    ${sug.length ? `<div class="zs-sug">${sug.map(z => `<button class="chip" data-z="${esc(z.key)}" data-l="${esc(z.label)}" title="${esc(ZONE_KIND[z.k])}">${esc(z.label)} <b>${z.n}</b></button>`).join("")}</div>` : ""}
    <div class="zs-prev muted" id="zsP" aria-live="polite"></div>
    <div class="row"><button class="btn ghost" id="zsNo">Cancelar</button><button class="btn primary" id="zsGo" disabled>${icon("play", "sm")} Empezar sesión</button></div>`, { onClose: () => host?.querySelector("#zoneGo")?.focus() });
  const inp = m.querySelector("#zsQ"), prev = m.querySelector("#zsP"), go = m.querySelector("#zsGo");
  let plan = null, seq = 0, tm, key = "";
  const preview = async () => {
    const z = inp.value.trim(), my = ++seq; plan = null; go.disabled = true;
    if (norm(z).length < 3) { prev.textContent = ""; return; }
    // un chip filtra por su clave exacta (la ciudad «Mendoza» no trae el evento de Mendoza); lo escrito, por palabras
    const mine = workOrder(acts.filter(a => matchZone(a, key || z)), t);
    prev.textContent = `${mine.length} ${mine.length === 1 ? "actividad tuya" : "actividades tuyas"}. Buscando colegios nuevos…`;
    const ex = [...new Set((S.today?.activities.items || []).map(a => a.orgId).filter(Boolean))].join(",");
    const r = key.startsWith("e:") ? { queue: [] } : await api(`/api/queue?zone=${encodeURIComponent(z)}&exclude=${ex}`).catch(() => null);
    if (my !== seq) return;
    const taken = new Set(mine.map(a => a.schoolId).filter(Boolean)), fresh = (r?.queue || []).filter(q => !taken.has(q.id) && !["client", "open", "churn"].includes(q.status)).map(q => q.id);
    plan = { z, key, mine, fresh };
    prev.textContent = !mine.length && !fresh.length ? `No encontré actividades tuyas ni colegios nuevos en «${z}».`
      : `${mine.length} ${mine.length === 1 ? "actividad tuya" : "actividades tuyas"} y ${fresh.length} ${fresh.length === 1 ? "colegio nuevo" : "colegios nuevos"}${r ? "" : " (no pude traer los nuevos)"}.`;
    go.disabled = !(mine.length + fresh.length);
  };
  inp.addEventListener("input", () => { key = ""; clearTimeout(tm); tm = setTimeout(preview, 400); });
  m.querySelectorAll("[data-z]").forEach(b => b.onclick = () => { inp.value = b.dataset.l; key = b.dataset.z; clearTimeout(tm); preview(); });
  m.querySelector("#zsNo").onclick = () => m.close();
  go.onclick = () => { if (!plan) return; m.close(); startSession(null, plan.z, { acts: plan.mine, extra: plan.fresh, origin: { kind: "zone", key: `zone:${plan.key || norm(plan.z)}`, filters: { zona: plan.z } } }); };
  inp.focus();
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
  const sub = `${s ? `${what} · ` : a.who ? `${a.subject}${a.kind ? ` · ${a.kind.toLowerCase()}` : ""} · ` : ""}${when}${s ? ` · ${s.city}` : a.city ? ` · ${a.city}` : ""}${!s && a.note ? ` · «${a.note}»` : ""}`;
  return `<div class="act"><span class="ty ${a.type}" role="img" aria-label="${esc(a.typeLabel)}" title="${esc(a.typeLabel)}">${icon(TYPE_ICON[a.type] || "check")}</span>
    ${s ? `<button class="t" data-school="${esc(s.id)}" data-act="${a.id}"><b>${esc(title)}</b><small class="${late ? "late" : ""}">${esc(sub)}</small></button>`
      : a.record ? `<button class="t" data-record="${esc(a.record)}" data-act="${a.id}" title="Abrir la ficha"><b>${esc(title)}</b><small class="${late ? "late" : ""}">${esc(sub)}</small></button>`
      : a.url ? `<a class="t" href="${esc(a.url)}" target="_blank" rel="noopener" title="Abrir en Pipedrive"><b>${esc(title)} ${icon("external", "sm")}</b><small class="${late ? "late" : ""}">${esc(sub)}</small></a>`
      : `<div class="t"><b>${esc(title)}</b><small class="${late ? "late" : ""}">${esc(sub)}</small></div>`}
    <div class="ops">${a.type === "meeting" && demoDue(a)
      // demo vencida: solo «¿Se hizo la demo?» (incluye «Se reprogramó…»), para que no se cierre ni se mueva sin resultado
      ? `<button class="btn sm" data-demo="${a.id}" data-date="${esc(a.date)}" data-time="${esc(a.time || "")}">¿Se hizo la demo?</button>`
      : `<button class="icon-btn" data-done="${a.id}" data-focus-key="done-${a.id}" title="Marcar como hecha" aria-label="Marcar como hecha">${icon("check")}</button><button class="icon-btn" data-move="${a.id}" title="Reprogramar" aria-label="Reprogramar">${icon("clock")}</button>`}</div></div>`;
}
// Fila de la bandeja caliente: abre la ficha (colegio o prospecto) y dice por qué está ahí.
function hotRow(r) {
  const s = r.schoolId && S.byId.get(r.schoolId), demo = r.kind === "demo", act = demo ? ` data-act="${r.id}"` : "";
  const title = s?.name || r.title, sub = [r.why, r.event, s?.city || r.city].filter(Boolean).join(" · "), inner = `<b>${esc(title)}</b><small>${esc(sub)}</small>`;
  return `<div class="act"><span class="ty ${demo ? "meeting" : "lead"}" role="img" aria-label="${demo ? "Demo" : "Prospecto nuevo"}" title="${demo ? "Demo" : "Prospecto nuevo"}">${icon(demo ? TYPE_ICON.meeting : "user")}</span>
    ${r.schoolId ? `<button class="t" data-school="${esc(r.schoolId)}"${act}>${inner}</button>` : r.record ? `<button class="t" data-record="${esc(r.record)}"${act} title="Abrir la ficha">${inner}</button>`
      : r.url ? `<a class="t" href="${esc(r.url)}" target="_blank" rel="noopener" title="Abrir en Pipedrive">${inner}</a>` : `<div class="t">${inner}</div>`}</div>`;
}
function prospectRow(q) {
  const cls = q.score >= 60 ? "" : q.score >= 40 ? "mid" : "low";
  const why = q.reasons.filter(r => !STATUS_REASONS.test(r)).slice(0, 3);
  return `<button class="prospect" data-school="${esc(q.id)}"><span class="score ${cls}" title="Prioridad ${q.score} de 100">${q.score}</span><span class="t"><b>${esc(q.name)}${potTag(q) ? ` ${potTag(q)}` : ""}</b><small>${esc(q.city)}, ${esc(q.country)}${q.lastTouch ? ` · último: ${esc(q.lastTouch.outcome.toLowerCase())}` : ""}</small>${callPill(q)}${why.length ? `<span class="why">${why.map(r => `<span class="tag">${esc(r)}</span>`).join("")}</span>` : ""}</span>${icon("arrowRight", "faint")}</button>`;
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
    try { const r = await api(`/api/activities/${id}/move`, { body: { date: d, time: tm } }); toast([`Reprogramada para ${shortDay(d)}${tm ? ` a las ${tm}` : ""}`, ...(r.done || []).map(x => x.label)].join(". "), r.done?.some(x => x.warn) ? { type: "err" } : undefined); }
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

// ¿Se hizo la demo? (tuya, o de cualquiera si sos líder). Queda escrito en la actividad de Pipedrive con una línea fija.
// No se presentó: se propone reagendarla (otra demo). after: redibujar la vista que la abrió.
const RES_TOAST = { done: "Listo: la demo se hizo", noshow: "Listo: no se presentó", canceled: "Listo: la demo se canceló" };
export function demoResultMenu(anchor, a, after) {
  const send = async (result, extra = {}) => {
    let r; try { r = await api(`/api/activities/${a.id}/demo-result`, { body: { result, ...extra } }); } catch (e) { return toast(e.message, { type: "err" }); }
    toast([RES_TOAST[result] || `Demo reprogramada para ${shortDay(extra.date)}${extra.time ? ` a las ${extra.time}` : ""}`, ...(r.done || []).map(x => x.label)].join(". "), r.done?.some(x => x.warn) ? { type: "err" } : undefined);
    await loadToday().catch(() => {}); after ? after() : draw();
    if (result === "noshow") pickDemoDate(anchor, "No se presentó. ¿La reagendamos?", a.time, async (d, tm) => {
      let x; try { x = await api(`/api/activities/${a.id}/demo-rebook`, { body: { date: d, time: tm } }); } catch (e) { return toast(e.message, { type: "err" }); }
      toast((x.done || []).map(y => y.label).join(". "), x.done?.some(y => y.warn) ? { type: "err" } : undefined);
      await loadToday().catch(() => {}); after ? after() : draw();
    }, { needTime: true, ok: "Reagendar", skip: () => toast("Quedó sin demo nueva: acordate de volver a contactarlo.", { type: "err" }) });
  };
  openMenu(anchor, [{ head: "¿Se hizo la demo?" }, { label: "Se hizo", fn: () => send("done") }, { label: "No se presentó (no-show)", sub: "Te proponemos reagendarla", fn: () => send("noshow") },
    { label: "Se reprogramó…", sub: "Elegís la fecha nueva", fn: () => pickDemoDate(anchor, "¿Para cuándo se reprogramó?", a.time, (d, tm) => send("moved", { date: d, time: tm }), { ok: "Reprogramar" }) },
    { label: "Se canceló", fn: () => send("canceled") }]);
}
function pickDemoDate(anchor, title, time, fn, { needTime = false, ok = "Listo", skip = null } = {}) {
  const t = today(), m = modal(`<h3>${esc(title)}</h3><div class="grid2"><label class="field"><span>Día</span><input class="inp" type="date" id="dmD" min="${t}" value="${nextBusinessDay(t)}"></label><label class="field"><span>Hora${needTime ? "" : ' <span class="faint">opcional</span>'}</span><input class="inp" type="time" id="dmT" step="900" value="${esc(time || "")}"></label></div><p class="callout err" id="dmE" hidden></p><div class="row"><button class="btn ghost" id="dmX">${skip ? "Ahora no" : "Cancelar"}</button><button class="btn primary" id="dmOk">${esc(ok)}</button></div>`, { onClose: () => anchor?.isConnected && anchor.focus() });
  m.querySelector("#dmX").onclick = () => { m.close(); skip?.(); };
  m.querySelector("#dmOk").onclick = async () => {
    const d = m.querySelector("#dmD").value, tm = m.querySelector("#dmT").value, e = m.querySelector("#dmE");
    if (!d || (needTime && !tm)) { e.hidden = false; e.textContent = needTime ? "Poné el día y la hora." : "Poné el día."; return; }
    m.close(); await fn(d, tm);
  };
}

function skeleton() {
  return `<div class="page">${baseErrorCallout()}<div class="page-head"><div><div class="skel" style="width:260px;height:28px"></div><div class="skel" style="width:180px;margin-top:10px"></div></div></div>
  <div class="card hero"><div class="ring"><b>…</b></div><div><div class="skel" style="width:70%;height:20px"></div><div class="skel" style="width:50%;margin-top:14px"></div></div></div>
  <div class="today-grid"><div class="card card-b" style="padding:20px">${'<div class="skel" style="margin:14px 0"></div>'.repeat(6)}</div><div class="card card-b" style="padding:20px">${'<div class="skel" style="margin:14px 0"></div>'.repeat(6)}</div></div></div>`;
}
