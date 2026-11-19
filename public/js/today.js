// Hoy: meta del día, agenda propia y a quién contactar ahora.
import { S, api, esc, icon, potTag, homeMode, homeSwitchHtml, bindHomeSwitch, patchSchool, today, addDays, nextBusinessDay, localAct, shortDay, TYPE_ICON, toast, openMenu, modal, cap, brainStaleMsg, brainTokenCallout, matchZone, zoneOptions, ZONE_KIND, workOrder, norm, callPill, callQueue, hotRows, demoDue, archivedRef, archivedAct, cleanTitle, subjectSansName, titleTag, territoryChosen, setTerritory } from "./core.js";
import { openSchool, openRecord, startSession, resumeSession } from "./school.js";
import { setBadge, baseErrorCallout } from "./app.js";
import { loadSessions, sessionsCard, bindSessionsCard } from "./sessions.js";
import { inboundNotice } from "./inbound.js";

let host = null, showAll = false, hotLeads = null, hotAll = false;
const STATUS_REASONS = /^(Nunca contactado|Sin revisar|En Pipe sin trato)$/;

// Velocidad: al entrar, la app dibuja Hoy dos veces (apenas entra y cuando llega la base de colegios). Las cargas de Hoy
// comparten el pedido en curso (misma dirección y nada escrito en el medio) y un pedido recién llegado no se repite: antes
// /api/today, /api/sessions, /api/hot y /api/check salían dos veces.
const FRESH_MS = 10e3, todayUrl = () => `/api/today?countries=${encodeURIComponent(S.territory.join(","))}`;
let todayP = null, todayKey = "", todayAt = 0, todayFor = "", todaySess, todaySeq = 0, dirty = false;
// algo se escribió (un contacto, una actividad, una sesión): lo que está en curso o recién leído ya no alcanza
addEventListener("ob:wrote", e => { if (/^\/api\/check(\?|$)/.test(String(e.detail?.path || ""))) return; dirty = true; todayAt = 0; hotAt = 0; });
const todayFresh = () => !!S.today && todayFor === todayUrl() && Date.now() - todayAt < FRESH_MS && S.sessSaving === todaySess;
export function loadToday() {
  const url = todayUrl();
  if (todayP && todayKey === url && !dirty) return todayP;
  dirty = false;
  const sess = S.sessSaving, my = ++todaySeq;
  const p = (async () => {
    // las sesiones guardadas se leen junto (si fallan, Hoy sigue sin la tarjeta)
    const [r] = await Promise.all([api(url), loadSessions().catch(() => null)]);
    if (my !== todaySeq) return todayP || S.today; // se pidió de nuevo (otro territorio, o algo se escribió): vale ese
    S.today = r; todayAt = dirty ? 0 : Date.now(); todayFor = url; todaySess = sess;
    syncBadge();
    verifyQueue();
    return S.today;
  })();
  todayP = p; todayKey = url;
  p.catch(() => {}).finally(() => { if (todayP === p) todayP = null; });
  return p;
}
// Los primeros de la cola que todavía no se cruzaron con Pipedrive se revisan atrás: si su organización es de
// otra persona (o ya es cliente o tiene trato), salen de la cola. Así nunca se propone algo que no es tuyo.
let verifying = false;
async function verifyQueue() {
  // también los «Nunca contactado»: el servidor les busca prospectos sin organización (una vez cada 3 días)
  const unk = (S.today?.queue || []).slice(0, 25).filter(q => q.status === "unk" || q.status === "new").map(q => q.id);
  if (verifying || !unk.length) return;
  verifying = true;
  try {
    const r = await api("/api/check", { body: { ids: unk } });
    const out = new Set(Object.entries(r).filter(([, v]) => !v.error && ((v.ownerId && v.ownerId !== S.me.pdUserId) || ["client", "open", "churn"].includes(v.status))).map(([id]) => id));
    Object.values(r).forEach(v => { if (!v.error) patchSchool(v); });
    if (S.today) { S.today.queue = S.today.queue.filter(q => !out.has(q.id)).map(q => r[q.id] && !r[q.id].error ? { ...q, status: r[q.id].status, detail: r[q.id].detail } : q); if (shown()) draw(); }
  } catch {} finally { verifying = false; }
}
// Prospectos nuevos para vos (bandeja caliente): aparte, para no frenar Hoy. Si falla, la bandeja queda solo con las demos.
let hotP = null, hotAt = 0;
function loadHot() {
  if (hotP || (hotLeads && Date.now() - hotAt < FRESH_MS)) return; // en curso o recién leída
  const p = hotP = api("/api/hot").then(r => { hotLeads = r.items || []; hotAt = Date.now(); }).catch(() => { hotLeads = hotLeads || []; })
    .finally(() => { if (hotP === p) hotP = null; if (shown()) draw(); });
}
// ¿está a la vista el Hoy de prospección? (el mismo lugar lo usan el panel del líder y el del account)
const shown = () => !!host?.isConnected && !!host.querySelector("[data-sdr-today]");
export function syncBadge() { const t = today(); setBadge("hoy", (S.today?.activities.items || []).filter(a => localAct(a).date <= t).length); }

// «Hoy» según quién entra (homeMode de core.js): un líder ve el panel de su equipo (leadhome.js), un account sus tratos y
// tareas (aehome.js) y un SDR la prospección de siempre. Si el módulo del rol no carga, queda el Hoy de siempre.
export function renderToday(el) {
  const mode = homeMode();
  if (mode === "lead" || mode === "ae") {
    host = el; const mod = mode === "lead" ? "./leadhome.js" : "./aehome.js";
    el.innerHTML = skeleton();
    import(mod).then(m => { if (host === el && homeMode() === mode) m.renderHome(el, () => renderToday(el)); })
      .catch(() => { if (host === el) renderSdrToday(el); });
    return;
  }
  renderSdrToday(el);
}
function renderSdrToday(el) {
  host = el; showAll = false; hotAll = false; loadHot();
  if (!S.today) { el.innerHTML = skeleton(); loadToday().then(() => host === el && shown() && draw()).catch(e => host === el && shown() && drawError(e)); }
  else if (todayFresh()) draw(); // recién leído (la app redibuja Hoy cuando llega la base de colegios): no se pide de nuevo
  else { draw(); loadToday().then(() => host === el && shown() && draw()).catch(e => toast(`No pudimos actualizar tu día: ${e.message}`, { type: "err", action: { label: "Reintentar", fn: () => renderToday(el) } })); }
}
function drawError(e) {
  host.innerHTML = `<div class="page" data-sdr-today>${baseErrorCallout()}<div class="callout err">${icon("alert")}<span>No pudimos traer tu día de Pipedrive: ${esc(e.message)}</span><button class="btn sm" id="retryToday">Reintentar</button></div></div>`;
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
  // el botón dice qué retoma en corto («Retomar tu día · faltan 34»); el nombre completo va debajo, en chico
  const resumeWhat = last?.origin?.kind === "today" ? "Retomar tu día" : "Retomar la sesión";
  const terr = S.territory.length ? (S.territory.length <= 2 ? S.territory.join(", ") : `${S.territory.length} países`) : "Todos los países";
  const list = showAll ? fresh : fresh.slice(0, 6);
  const hot = hotRows((activities.items || []).filter(a => !archivedAct(a)), (hotLeads || []).filter(l => !archivedRef(l.schoolId || l.record)), t), hotList = hotAll ? hot : hot.slice(0, 6);

  // Orden (pedido del líder: «más simple»): el saludo y, primero, tu día con el botón grande de la sesión; después los avisos
  // de todos los días (inbound nuevos, modo demo), la bandeja caliente, las otras sesiones y las listas. Arriba del saludo
  // quedan solo los avisos de algo que anda mal (la base o World Dominion no se pudieron leer).
  host.innerHTML = `<div class="page" data-sdr-today>
    ${homeSwitchHtml()}
    ${baseErrorCallout()}
    ${S.brainDown || S.brain?.down ? `<div class="callout warn" style="margin-bottom:16px">${icon("alert")}<span>No pudimos leer los clientes de World Dominion: algún cliente puede aparecer en tu cola. Revisá en Pipedrive antes de llamar.</span></div>` : ""}
    ${brainTokenCallout()}
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
      <div class="hero-cta">${resume ? `<button class="btn primary lg" id="resume" data-focus-key="resume" aria-label="Retomar «${esc(last.name)}» · faltan ${last.stats.pending}" title="Retomar «${esc(last.name)}»: ${last.stats.handled} de ${last.stats.total}">${icon("play")} <span class="nw">${resumeWhat} · faltan ${last.stats.pending}</span></button><small class="cta-name" title="${esc(last.name)}">${esc(last.name)} · ${last.stats.handled} de ${last.stats.total}</small><button class="btn ghost sm" id="go">Empezar una nueva</button>`
        : `<button class="btn primary lg" id="go" ${sessionCount ? "" : "disabled"}>${icon("play")} Empezar sesión · ${sessionCount}</button>`}
        <button class="btn ghost sm" id="zoneGo" aria-haspopup="dialog" data-focus-key="zoneGo">${icon("map", "sm")} Trabajar una zona o evento</button></div>
    </section>
    <div id="inbNote"></div>
    ${S.demo ? `<div class="callout warn" style="margin-bottom:16px">${icon("alert")}<span><b>Modo demo.</b> Pipedrive todavía no está conectado: la agenda, los tratos y las notas que ves son de prueba. Los colegios y los clientes de World Dominion sí son reales.</span></div>` : ""}
    ${hot.length ? `<section class="card hot" aria-labelledby="hH"><div class="card-h"><h2 id="hH">${icon("flame")} Bandeja caliente</h2><span class="sub">${hotLeads ? "demos cerca y prospectos nuevos para vos" : "buscando prospectos nuevos…"}</span></div>
      <div class="card-b">${hotList.map(hotRow).join("")}${hot.length > 6 ? `<button class="btn ghost sm block" id="hotMore" data-focus-key="hotMore">${hotAll ? "Ver menos" : `Ver ${hot.length - 6} más`}</button>` : ""}</div></section>` : ""}
    ${sessionsCard({ skip: last?.id || null })}
    <div class="today-grid">
      <section class="card" aria-labelledby="hAg">
        <div class="card-h"><h2 id="hAg">${icon("calendar")} Tu agenda</h2><span class="sub">${acts.length} pendientes</span></div>
        <div class="card-b">${late.length + now.length + soon.length ? group("Hoy", now) + group("Vencidas", late, "late") + group("Próximos 7 días", soon) : `<div class="empty">${icon("checkCircle")}<b>Sin pendientes</b><span>Lo que agendes desde una ficha aparece acá.</span></div>`}</div>
      </section>
      <div class="stack" id="right">
        <section class="card" aria-labelledby="hQ">
          <div class="card-h"><h2 id="hQ">${icon("flame")} A quién llamar ahora</h2><button class="btn sm" id="terr" aria-haspopup="dialog" data-focus-key="terr">${icon("globe", "sm")} ${esc(terr)}</button></div>
          <div class="card-b">
            ${territoryChosen() ? "" : `<p class="terr-hint">${icon("globe", "sm")}<span>Estás viendo todos los países · <button class="linkbtn" id="terrPick" data-focus-key="terrPick">Elegir</button></span></p>`}
            ${list.length ? list.map(prospectRow).join("") + (fresh.length > 6 ? `<button class="btn ghost sm block" id="more" data-focus-key="more">${showAll ? "Ver menos" : `Ver ${fresh.length - 6} más`}</button>` : "")
              : `<div class="empty">${icon("search")}<span>No hay colegios para prospectar en ${esc(terr.toLowerCase())}. Sumá países o revisá ciudades en Prospectar.</span></div>`}
          </div>
        </section>
        ${revive.length ? `<section class="card" aria-labelledby="hR"><div class="card-h"><h2 id="hR">${icon("refresh")} Para reactivar</h2><span class="sub">perdidos hace más de 4 meses</span></div><div class="card-b">${revive.slice(0, 4).map(prospectRow).join("")}</div></section>` : ""}
      </div>
    </div></div>`;

  host.querySelector("#go")?.addEventListener("click", () => startSession());
  host.querySelector("#resume")?.addEventListener("click", () => resumeSession(last.id));
  bindHomeSwitch(host, () => renderToday(host));
  bindSessionsCard(host, () => host?.isConnected && draw());
  inboundNotice(host.querySelector("#inbNote")); // «Tenés N inbound nuevos · Ver»
  host.querySelector("#terr").onclick = territoryPicker;
  host.querySelector("#terrPick")?.addEventListener("click", territoryPicker);
  host.querySelector("#zoneGo")?.addEventListener("click", () => zoneSession());
  host.querySelector("#more")?.addEventListener("click", () => { showAll = !showAll; draw(); });
  host.querySelector("#hotMore")?.addEventListener("click", () => { hotAll = !hotAll; draw(); });
  host.querySelectorAll("[data-school]").forEach(b => b.onclick = () => openSchool(b.dataset.school, { activityId: b.dataset.act ? Number(b.dataset.act) : null }));
  host.querySelectorAll("[data-record]").forEach(b => b.onclick = () => openRecord(b.dataset.record, { activityId: Number(b.dataset.act) || null }));
  host.querySelectorAll("[data-done]").forEach(b => b.onclick = () => checkAct(Number(b.dataset.done)));
  host.querySelectorAll("[data-move]").forEach(b => b.onclick = () => moveMenu(b, Number(b.dataset.move)));
  host.querySelectorAll("[data-demo]").forEach(b => b.onclick = () => demoResultMenu(b, { id: Number(b.dataset.demo), time: b.dataset.time }));
  if (focusKey) host.querySelector(`[data-focus-key="${focusKey}"]`)?.focus();
}

// Sesión especial por zona o evento («hoy quiero trabajar Puebla»): primero tus actividades de ahí (hoy, después vencidas)
// y después los colegios nuevos de esa ciudad que no tienen dueño ni actividad tuya. También desde Sesiones › «Nueva sesión»
// (anchor: dónde vuelve el foco al cerrar).
export function zoneSession({ anchor = null } = {}) {
  const t = today(), acts = (S.today?.activities.items || []).map(a => ({ ...a, ...localAct(a) })).filter(a => a.date <= t && (a.schoolId || a.record));
  const sug = zoneOptions(acts).slice(0, 12);
  const m = modal(`<h3>Trabajar una zona o evento</h3>
    <p class="muted" style="margin:0">Primero van tus actividades de esa zona (las de hoy y después las vencidas). Al terminar siguen los colegios nuevos de esa ciudad.</p>
    <label class="field"><span>Zona o evento</span><input class="inp" id="zsQ" list="zsL" placeholder="Puebla, Pachuca, EduExperience…" autocomplete="off">
      <datalist id="zsL">${sug.map(z => `<option value="${esc(z.label)}">`).join("")}</datalist></label>
    ${sug.length ? `<div class="zs-sug">${sug.map(z => `<button class="chip" data-z="${esc(z.key)}" data-l="${esc(z.label)}" title="${esc(ZONE_KIND[z.k])}">${esc(z.label)} <b>${z.n}</b></button>`).join("")}</div>` : ""}
    <div class="zs-prev muted" id="zsP" aria-live="polite"></div>
    <div class="row"><button class="btn ghost" id="zsNo">Cancelar</button><button class="btn primary" id="zsGo" disabled>${icon("play", "sm")} Empezar sesión</button></div>`, { onClose: () => (anchor?.isConnected ? anchor : host?.querySelector("#zoneGo"))?.focus() });
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
    setTerritory(sel);
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
// El título va sin las etiquetas internas de Pipedrive («Colegio Olivos (SDR Meta Ads Revival)» → «Colegio Olivos» + chip «SDR
// revival», cleanTitle de core.js) y el subtítulo no repite el nombre, esté donde esté en el asunto.
const titleB = (ct, extra = "") => `<b${ct.tag ? ' class="has-tag"' : ""}><span class="nm">${esc(ct.name)}${extra}</span>${titleTag(ct.tag)}</b>`;
export function actRow(a, late) {
  const s = a.schoolId && S.byId.get(a.schoolId);
  const when = `${late ? `Vencida ${shortDay(a.date)}` : shortDay(a.date)}${a.time ? ` · ${a.time}` : ""}`;
  // sin colegio de la base: el nombre del prospecto, la persona o la organización de Pipedrive
  const raw = s ? s.name : a.who || a.subject, ct = s ? { name: s.name, tag: "" } : cleanTitle(raw);
  // qué hay que hacer: el asunto sin el nombre (si el asunto era solo el nombre, el tipo de actividad)
  const what = s || a.who ? subjectSansName(a.subject, raw) || a.typeLabel || "" : "";
  const sub = [what, !s && a.who && a.kind ? a.kind.toLowerCase() : "", when, s ? s.city : a.city, !s && a.note ? `«${a.note}»` : ""].filter(Boolean).join(" · ");
  const small = `<small class="${late ? "late" : ""}">${esc(sub)}</small>`, logs = logsFirst(a);
  return `<div class="act"><span class="ty ${a.type}" role="img" aria-label="${esc(a.typeLabel)}" title="${esc(a.typeLabel)}">${icon(TYPE_ICON[a.type] || "check")}</span>
    ${s ? `<button class="t" data-school="${esc(s.id)}" data-act="${a.id}">${titleB(ct)}${small}</button>`
      : a.record ? `<button class="t" data-record="${esc(a.record)}" data-act="${a.id}" title="Abrir la ficha">${titleB(ct)}${small}</button>`
      : a.url ? `<a class="t" href="${esc(a.url)}" target="_blank" rel="noopener" title="Abrir en Pipedrive">${titleB(ct, ` ${icon("external", "sm")}`)}${small}</a>`
      : `<div class="t">${titleB(ct)}${small}</div>`}
    <div class="ops">${a.type === "meeting" && demoDue(a)
      // demo vencida: solo «¿Se hizo la demo?» (incluye «Se reprogramó…»), para que no se cierre ni se mueva sin resultado
      ? `<button class="btn sm" data-demo="${a.id}" data-date="${esc(a.date)}" data-time="${esc(a.time || "")}">¿Se hizo la demo?</button>`
      // llamada, WhatsApp o mail con ficha: el ✓ abre Registrar con esa actividad (resultado y próximo paso); el resto se cierra
      : `<button class="icon-btn" data-done="${a.id}" data-focus-key="done-${a.id}" title="${logs ? "Registrar cómo te fue y marcarla como hecha" : "Marcar como hecha"}" aria-label="${logs ? "Registrar cómo te fue y marcarla como hecha" : "Marcar como hecha"}"${logs ? ' aria-haspopup="dialog"' : ""}>${icon("check")}</button><button class="icon-btn" data-move="${a.id}" title="Reprogramar" aria-label="Reprogramar">${icon("clock")}</button>`}</div></div>`;
}
// Fila de la bandeja caliente: abre la ficha (colegio o prospecto) y dice por qué está ahí.
function hotRow(r) {
  const s = r.schoolId && S.byId.get(r.schoolId), demo = r.kind === "demo", act = demo ? ` data-act="${r.id}"` : "";
  // el título sin etiquetas internas («(Inbound Google Ads)» → chip «Inbound Google») y el evento como chip, no en el subtítulo
  const ct0 = s ? { name: s.name, tag: "", tags: [] } : cleanTitle(r.title), tags = [...ct0.tags, ...(r.event && !ct0.tags.some(x => norm(x) === norm(r.event)) ? [r.event] : [])];
  const sub = [r.why, s?.city || r.city].filter(Boolean).join(" · "), inner = `${titleB({ name: ct0.name, tag: tags.join(" · ") })}<small>${esc(sub)}</small>`;
  return `<div class="act"><span class="ty ${demo ? "meeting" : "lead"}" role="img" aria-label="${demo ? "Demo" : "Prospecto nuevo"}" title="${demo ? "Demo" : "Prospecto nuevo"}">${icon(demo ? TYPE_ICON.meeting : "user")}</span>
    ${r.schoolId ? `<button class="t" data-school="${esc(r.schoolId)}"${act}>${inner}</button>` : r.record ? `<button class="t" data-record="${esc(r.record)}"${act} title="Abrir la ficha">${inner}</button>`
      : r.url ? `<a class="t" href="${esc(r.url)}" target="_blank" rel="noopener" title="Abrir en Pipedrive">${inner}</a>` : `<div class="t">${inner}</div>`}</div>`;
}
function prospectRow(q) {
  const cls = q.score >= 60 ? "" : q.score >= 40 ? "mid" : "low";
  // «Alto potencial» ya va en el distintivo amarillo del nombre: no se repite como motivo
  const why = q.reasons.filter(r => !STATUS_REASONS.test(r) && !(q.pot?.length && r === "Alto potencial")).slice(0, 3);
  return `<button class="prospect" data-school="${esc(q.id)}"><span class="score ${cls}" title="Prioridad ${q.score} de 100">${q.score}</span><span class="t"><b>${esc(q.name)}${potTag(q) ? ` ${potTag(q)}` : ""}</b><small>${esc(q.city)}, ${esc(q.country)}${q.lastTouch ? ` · último: ${esc(q.lastTouch.outcome.toLowerCase())}` : ""}</small>${callPill(q)}${why.length ? `<span class="why">${why.map(r => `<span class="tag">${esc(r)}</span>`).join("")}</span>` : ""}</span>${icon("arrowRight", "faint")}</button>`;
}

// Enfoca la fila que sigue a la actividad (o la anterior si era la última), en la vista que esté abierta.
function nextFocusKey(id) {
  const btns = [...document.querySelectorAll("#main [data-done]")], k = btns.findIndex(b => b.dataset.done === String(id));
  const n = btns[k + 1] || btns[k - 1];
  return n ? n.dataset.done : null;
}
const focusDone = id => (id && document.querySelector(`#main [data-done="${id}"]`) || document.getElementById("main"))?.focus({ preventScroll: !id });
// ---------- el ✓ de una fila (Hoy y Agenda). Una llamada, un WhatsApp o un mail con ficha no se cierran a ciegas: el ✓ abre la
// ficha en Registrar con esa actividad («Marcar como hecha» ya viene tildado), así queda el resultado y el próximo paso. El
// resto (demo que todavía no pasó, contacto decisor, otros tipos, o sin colegio ni ficha) se cierra como siempre y el aviso de
// deshacer suma «¿Cómo te fue? Registrar».
const LOG_TYPES = new Set(["call", "deadline", "task"]);
const findAct = id => (S.today?.activities.items || []).find(a => a.id === id) || (S.agenda?.items || []).find(a => a.id === id) || null;
const fichaOf = a => a?.schoolId && S.byId.has(a.schoolId) ? { school: a.schoolId } : a?.record ? { record: a.record } : null;
const openFicha = (f, opts) => f.school ? openSchool(f.school, opts) : openRecord(f.record, opts);
// (un archivado no se registra: su ficha no deja; se cierra como siempre)
export const logsFirst = a => !!a && LOG_TYPES.has(a.type) && !!fichaOf(a) && !archivedAct(a);
export function checkAct(id, after) {
  const a = findAct(id);
  if (logsFirst(a)) return openFicha(fichaOf(a), { activityId: id, tab: "log" });
  return markDone(id, after);
}
// un segundo botón en un aviso (toast de core.js), antes de «Deshacer»
function toastMore(t, label, fn) {
  const b = document.createElement("button"); b.type = "button"; b.textContent = label;
  b.onclick = () => { t.querySelector(".x")?.click(); fn(); };
  (t.querySelector("[data-act]") || t.querySelector(".x"))?.before(b);
}
// La actividad en las listas que ya están (Hoy y Agenda), sin volver a pedir todo: fn devuelve la actividad cambiada (queda
// en su lugar por fecha y hora, como las manda Pipedrive) o null (sale de la lista).
const actLists = () => [S.today?.activities, S.agenda].filter(L => Array.isArray(L?.items));
function placeAct(items, a) { const k = x => `${x.date}T${x.time || ""}`, j = items.findIndex(x => k(x) > k(a)); if (j < 0) items.push(a); else items.splice(j, 0, a); }
function patchAct(id, fn) {
  for (const L of actLists()) {
    const i = L.items.findIndex(a => a.id === id); if (i < 0) continue;
    const [old] = L.items.splice(i, 1), n = fn(old);
    if (n) placeAct(L.items, n);
  }
  syncBadge();
}
// día y hora locales → como los guarda Pipedrive (UTC); sin hora, cambia solo el día (el servidor hace lo mismo)
const utcOf = (d, tm) => { if (!tm) return { date: d }; const x = new Date(`${d}T${tm}:00`); return isNaN(x) ? { date: d } : { date: x.toISOString().slice(0, 10), time: x.toISOString().slice(11, 16) }; };
// lo que cambió además de la fila (el recordatorio de una demo): se lee atrás, sin frenar
const reloadSoon = () => { loadToday().then(() => shown() && draw()).catch(() => {}); };
export async function markDone(id, after) {
  const nextId = nextFocusKey(id);
  const removed = findAct(id);
  const f = removed && !archivedAct(removed) ? fichaOf(removed) : null;
  try { await api(`/api/activities/${id}/done`, { body: {} }); }
  catch (e) { return toast(e.message, { type: "err" }); }
  // sale de las listas como están AHORA (mientras se esperaba pudo llegar la agenda o releerse Hoy); se anota dónde estaba
  const was = new Map();
  for (const L of actLists()) { const i = L.items.findIndex(a => a.id === id); if (i >= 0) { was.set(L, i); L.items.splice(i, 1); } }
  syncBadge();
  const tEl = toast(f ? "Hecha. ¿Cómo te fue?" : "Actividad marcada como hecha", { action: { label: "Deshacer", fn: async () => {
    try { await api(`/api/activities/${id}/undone`, { body: {} }); } catch (e) { return toast(e.message, { type: "err" }); }
    // vuelve a su lugar en la lista, no al final (en una lista que llegó después, por fecha)
    if (removed) for (const L of actLists()) { if (L.items.some(a => a.id === id)) continue; if (was.has(L)) L.items.splice(Math.min(was.get(L), L.items.length), 0, removed); else placeAct(L.items, removed); }
    syncBadge(); after ? after() : draw();
  } } });
  // quedó cerrada sin resultado ni próximo paso: el aviso ofrece registrarlo en la ficha
  if (f) toastMore(tEl, "Registrar", () => openFicha(f, { tab: "log" }));
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
    // la actividad cambia de día en la lista que ya está (antes se volvía a pedir todo /api/today y había que esperar)
    patchAct(id, x => ({ ...x, ...utcOf(d, tm) }));
    after ? after() : draw();
    if (a?.type === "meeting" && !after) reloadSoon(); // una demo mueve también su recordatorio
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
    // en la lista que ya está: hecha, no-show o cancelada salen; reprogramada cambia de día (su recordatorio se lee atrás)
    patchAct(a.id, x => result === "moved" ? { ...x, ...utcOf(extra.date, extra.time) } : null);
    after ? after() : draw();
    if (result === "moved" && !after) reloadSoon();
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
  return `<div class="page" data-sdr-today>${baseErrorCallout()}<div class="page-head"><div><div class="skel" style="width:260px;height:28px"></div><div class="skel" style="width:180px;margin-top:10px"></div></div></div>
  <div class="card hero"><div class="ring"><b>…</b></div><div><div class="skel" style="width:70%;height:20px"></div><div class="skel" style="width:50%;margin-top:14px"></div></div></div>
  <div class="today-grid"><div class="card card-b" style="padding:20px">${'<div class="skel" style="margin:14px 0"></div>'.repeat(6)}</div><div class="card card-b" style="padding:20px">${'<div class="skel" style="margin:14px 0"></div>'.repeat(6)}</div></div></div>`;
}
