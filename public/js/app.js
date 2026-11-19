// OrderBrain SDR · arranque, navegación, cuenta, búsqueda rápida y atajos.
import { $, S, api, esc, norm, icon, hydrateIcons, setSchools, setUnauthorized, initials, statusPill, closeMenu, openMenu, isDark, applyTheme, save, loadPref, lastUndo, modal, toast, brainTokenMsg, digits, recentSearches, rememberSearch, myRole, territoryFieldHtml, bindTerritoryField, schoolIdx, fmtNum } from "./core.js";
import { renderToday } from "./today.js";
import { renderExplore } from "./explore.js";
import { renderAgenda } from "./agenda.js";
import { renderTeam } from "./team.js";
import { renderRadar } from "./radar.js";
import { renderMetrics } from "./metrics.js";
import { openSchool, closeSchool, drawerOpen, startSession } from "./school.js";
import { openAssistant, closeAssistant } from "./chat.js";
import { loadGmail, gmailReturn } from "./gmail.js";
import { googleLoginHtml, googleBack, googleNotice, hideGoogleNote, drawGoogleProfile } from "./google.js";
import { loadPdMail, mailProfileHtml, bindMailProfile, resetSigMode } from "./pdmail.js";
import { pdSearcher, pdFlat, pdTitle, pdLinesHtml, pdBadge, pdCount, pdNameHit, openPd, isPhoneQ, isMailQ, PD_MIN, pdLinkOf, openPdLink } from "./pdsearch.js";
import { profileExtrasHtml, bindProfileExtras } from "./accounts.js";
import { renderBase } from "./base.js";
import { renderInbound, slackDialog } from "./inbound.js";
import { renderDeals } from "./deals.js";
import { renderSessionsView } from "./sessionsview.js";

const VIEWS = {
  hoy: { label: "Hoy", icon: "sun", render: renderToday },
  // sesiones de trabajo: de hoy, activas, inactivas y terminadas; crear, retomar, editar, terminar y borrar (cada uno las suyas)
  sesiones: { label: "Sesiones", icon: "play", render: renderSessionsView },
  prospectar: { label: "Prospectar", icon: "map", render: renderExplore },
  // tratos abiertos y en qué etapa están (pedido del líder de SDR, para los accounts): la ven todos, solo lectura
  tratos: { label: "Tratos abiertos", short: "Tratos", icon: "deal", render: renderDeals },
  agenda: { label: "Agenda", icon: "calendar", render: renderAgenda },
  radar: { label: "Radar", icon: "target", render: renderRadar },
  base: { label: "Cargar base", short: "Base", icon: "upload", render: renderBase },
  equipo: { label: "Equipo", icon: "users", render: renderTeam },
  metricas: { label: "Métricas", icon: "chart", render: renderMetrics },
  inbound: { label: "Tus inbound", short: "Inbound", icon: "bolt", render: renderInbound },
};
// Métricas: solo líderes y dirección (S.profile.leader; el servidor también corta con 403)
const LEADER_ONLY = new Set(["metricas"]);
// Tus inbound: todos menos los Account Executive
// El menú en el orden de cada rol (myRole de core.js): un account, sus tratos primero; un líder, su equipo y las métricas.
// Nadie pierde una vista: solo cambia el orden (Métricas sigue siendo de líderes y Tus inbound no va para un account).
const MENU = {
  sdr: ["hoy", "sesiones", "prospectar", "tratos", "agenda", "radar", "base", "equipo", "metricas", "inbound"],
  ae: ["hoy", "tratos", "sesiones", "agenda", "equipo", "prospectar", "radar", "base", "metricas", "inbound"],
  lider: ["hoy", "equipo", "metricas", "tratos", "sesiones", "prospectar", "agenda", "inbound", "radar", "base"],
};
const views = () => { const order = MENU[myRole()] || MENU.sdr;
  return Object.entries(VIEWS).filter(([k]) => (!LEADER_ONLY.has(k) || S.profile?.leader) && (k !== "inbound" || S.me?.role !== "ae"))
    .sort((a, b) => (order.indexOf(a[0]) + 1 || 99) - (order.indexOf(b[0]) + 1 || 99)); };
// Celular: la barra de abajo lleva 4 secciones y «Más» (el resto, en una hoja). Las 4 son las primeras del menú de cada rol;
// para un SDR, las que usa todo el día (Hoy, Prospectar, Tus inbound y Agenda). En escritorio el menú no cambia.
const BAR = { sdr: ["hoy", "prospectar", "inbound", "agenda"] }, BAR_N = 4;
const barViews = () => { const all = views().map(([k]) => k), pick = (BAR[myRole()] || []).filter(k => all.includes(k)); return [...pick, ...all.filter(k => !pick.includes(k))].slice(0, BAR_N); };
const show = id => { for (const x of ["boot", "login", "app"]) $(x).hidden = x !== id; };

// ---------- login
async function start() {
  try {
    const me = await api("/api/me");
    Object.assign(S, { me: me.user, profile: me.profile, ai: me.ai, study: me.study, demo: me.demo, goal: me.goal, pdWeb: me.pdWeb, sessionMax: me.sessionMax || 300, countries: me.countries, markets: me.markets, outcomes: me.outcomes, lostReasons: me.lostReasons, archiveReasons: me.archiveReasons || [], types: me.types });
    enterApp();
    // la primera vez: nombre completo y rol en el equipo (se usa en saludos, firmas y en Equipo)
    if (!me.profile?.complete) profileDialog({ required: true });
    gmailReturn(); // volviste de conectar Gmail (sin ventana aparte)
    loadGmail(); loadPdMail();
    // Tu Google: si recién entraste con Google, cómo quedó conectado; si entraste con tu código y no lo conectaste, el aviso
    googleNotice(googleBack().st).catch(() => {});
  } catch { showLogin(); }
}
async function showLogin() {
  document.querySelectorAll(".modal").forEach(m => m.remove()); // si la sesión vence con un diálogo abierto
  show("login"); $("assistant").hidden = true; hideGoogleNote();
  const cfg = await api("/auth/config").catch(() => null);
  const err = $("loginErr");
  // volviste de «Entrar con Google» y no se pudo: el motivo (el servidor manda solo un código)
  { const gb = googleBack(cfg?.domain); if (gb.error) err.textContent = gb.error; }
  if (!cfg) { $("gbtn").innerHTML = ""; err.innerHTML = `No pudimos conectar con el servidor. <button class="linkbtn" id="loginRetry">Reintentar</button>`; $("loginRetry").onclick = () => { err.textContent = ""; showLogin(); }; return; }
  if (cfg.devLogin) {
    const b = $("devLogin"); b.hidden = false;
    b.onclick = async () => {
      b.disabled = true; b.textContent = "Entrando…";
      try { await api("/auth/dev", { body: {} }); start(); }
      catch (e) { err.textContent = e.message; b.disabled = false; b.textContent = "Entrar en modo desarrollo"; }
    };
  }
  if (cfg.codeLogin) {
    const f = $("codeLogin"); f.hidden = false;
    if (cfg.domain) $("ceEmail").placeholder = `nombre@${cfg.domain}`;
    f.onsubmit = async e => {
      e.preventDefault(); const go = $("ceGo"); go.disabled = true; go.textContent = "Entrando…"; err.textContent = "";
      try { await api("/auth/code", { body: { email: $("ceEmail").value, code: $("ceCode").value } }); start(); }
      catch (x) { err.textContent = x.message; go.disabled = false; go.textContent = "Entrar"; }
    };
  }
  // «Entrar con Google» en un solo paso (entra y conecta mail, calendario y planillas): solo si el servidor tiene el cliente OAuth
  if (cfg.googleLogin) { $("gbtn").innerHTML = googleLoginHtml({ withCode: !!cfg.codeLogin }); return; }
  if (!cfg.googleClientId) { $("gbtn").innerHTML = ""; if (!cfg.devLogin && !cfg.codeLogin) err.textContent = "El login con Google todavía no está configurado en el servidor."; return; }
  const init = () => {
    if (!window.google?.accounts?.id) return setTimeout(init, 200);
    $("gbtn").innerHTML = "";
    google.accounts.id.initialize({ client_id: cfg.googleClientId, callback: async r => {
      try { await api("/auth/google", { body: { credential: r.credential } }); start(); } catch (e) { err.textContent = e.message; }
    } });
    google.accounts.id.renderButton($("gbtn"), { theme: isDark() ? "filled_black" : "outline", size: "large", text: "signin_with", locale: "es", shape: "pill" });
  };
  init();
}
setUnauthorized(() => showLogin());

async function enterApp() {
  show("app");
  hydrateIcons();
  $("demoPill").hidden = $("demoPill2").hidden = !S.demo;
  $("assistBtn").hidden = $("topAssist").hidden = !S.ai;
  $("assistBtn").onclick = $("topAssist").onclick = () => openAssistant();
  $("topSearch").onclick = $("openPalette").onclick = openPalette;
  drawMe();
  $("me").onclick = $("topMe").onclick = e => accountMenu(e.currentTarget);
  renderNav();
  route(); // las vistas muestran su propio estado de carga
  await loadBase();
}
// Colegios y equipo: si fallan, se avisa y se puede reintentar sin recargar.
// S.baseP: se resuelve cuando terminó de cargar (bien o mal); una sesión que se retoma apenas entrás la espera
function loadBase() { return (S.baseP = readBase()); }
async function readBase() {
  try {
    // clientes de World Dominion: se piden junto con la base (el mapa y Hoy los usan)
    S.brainP ??= api("/api/brain").catch(() => ({ enabled: false }));
    S.brainP.then(b => { S.brain = b; brainBadge(); });
    const [schools, team] = await Promise.all([api("/api/schools"), api("/api/team").catch(() => [])]);
    setSchools(schools); S.team = team; S.baseError = null;
  } catch (e) { S.baseError = e.message; }
  route();
}
export function baseErrorCallout() {
  if (!S.baseError) return "";
  setTimeout(() => document.getElementById("baseRetry")?.addEventListener("click", () => { S.baseError = null; loadBase(); }));
  return `<div class="callout err" style="margin-bottom:16px">${icon("alert")}<span>No pudimos cargar los colegios: ${esc(S.baseError)}. <button class="linkbtn" id="baseRetry">Reintentar</button></span></div>`;
}

// ---------- cuenta: tema, estado de Pipedrive y salir
function avatar() {
  return `<span class="av">${S.me.picture ? `<img src="${esc(S.me.picture)}" alt="">` : initials(S.me.name)}<span class="dot-status ${S.me.pdUserId ? "" : "off"}"></span></span>`;
}
function drawMe() {
  const off = !S.me.pdUserId;
  // debajo del nombre: «Dirección · CEO», «Líder · SDR México», «SDR · SDR México» (lo arma el servidor con el acceso y el
  // equipo); sin usuario en Pipedrive, eso manda
  $("me").innerHTML = `${avatar()}<span class="who"><b>${esc(S.me.name)}</b>${off ? "<small>Sin usuario en Pipedrive</small>" : S.me.roleLabel ? `<small class="role">${esc(S.me.roleLabel)}</small>` : ""}</span>`;
  $("me").title = off ? "Tu email no coincide con un usuario de Pipedrive" : `${S.me.name}${S.me.roleLabel ? ` · ${S.me.roleLabel}` : ""} · conectado a Pipedrive`;
  $("topMe").innerHTML = avatar();
}
// Vuelve a leer quién sos (por ejemplo, después de cambiar tu propio acceso en Equipo): menú, nombre y vistas al día
export async function refreshMe() {
  try { const me = await api("/api/me"); S.me = me.user; S.profile = me.profile; drawMe(); renderNav(); if (!views().some(([k]) => k === S.view)) route(); } catch {}
}
function accountMenu(anchor) {
  openMenu(anchor, [
    { head: S.me.email, cls: "plain" },
    { label: S.me.pdUserId ? "Conectado a Pipedrive" : "Sin usuario en Pipedrive", sub: S.me.pdUserId ? "Tus actividades y notas se guardan a tu nombre" : "Pedí que te den de alta con este email", fn: () => S.pdWeb && window.open(S.pdWeb, "_blank", "noopener") },
    { label: "Tu perfil", sub: `${S.me.name}${S.me.roleLabel ? " · " + S.me.roleLabel : ""}`, fn: () => profileDialog() },
    ...(S.me.role !== "ae" ? [{ label: "Tu usuario de Slack", sub: "Para ver tus inbound del reparto", fn: () => slackDialog() }] : []),
    { label: isDark() ? "Modo claro" : "Modo oscuro", sub: "Cambiar el tema", fn: toggleTheme },
    { label: "Salir", sub: "Cerrar sesión en este dispositivo", fn: async () => { await api("/auth/logout", { body: {} }).catch(() => {}); location.reload(); } },
  ]);
}
function profileDialog({ required = false } = {}) {
  // «Líder» y «Dirección» los define el servidor (quien conectó Pipedrive, la lista del administrador, dirección en Equipo o
  // liderar un equipo); los demás eligen SDR o AE. El equipo lo arma dirección (o su líder suma a la gente).
  const leader = !!S.profile?.leader, acc = S.profile?.access || {}, sc = S.profile?.scope || {};
  const accWhy = acc.fixed ? "definido por el administrador" : acc.by ? `te lo dio ${acc.by} en Equipo` : "lo asigna dirección en Equipo";
  const teamTxt = acc.stale ? "Eras líder antes de los equipos. Ahora hay equipos: pedile a dirección que te asigne el tuyo (mientras, sin Métricas)."
    : !sc.on ? "" : sc.member ? `Equipo: ${sc.member.name}` : sc.led?.length ? "" : leader ? "" : "Todavía no estás en un equipo: te suma su líder o dirección.";
  const roles = S.profile?.roles || { sdr: "SDR", ae: "Account Executive" };
  const cur = leader ? "lider" : S.me.role && S.me.role !== "lider" ? S.me.role : "";
  const name = S.profile?.complete ? S.me.name : (S.profile?.suggested || "");
  const m = modal(`<div class="modal-h"><h3>${required ? "Contanos quién sos" : "Tu perfil"}</h3>${required ? "" : `<button class="icon-btn" id="pfX" aria-label="Cerrar">${icon("x")}</button>`}</div>
    ${required ? `<p class="muted" style="margin:-6px 0 0">Se usa en los saludos y en Equipo. En Pipedrive tus notas se firman con tu usuario de Pipedrive.</p>` : ""}
    <form id="pfF" class="stack" style="gap:14px">
      <label class="field"><span>Nombre y apellido</span><input class="inp" id="pfName" value="${esc(name)}" autocomplete="name" placeholder="Ej: Javiera Tejos" required></label>
      <div class="field"><span>Rol en el equipo</span>${leader ? `<p class="muted" style="margin:0"><b>${esc(S.me.roleLabel || acc.label || "Líder")}</b> · ${esc(accWhy)}</p>` : `<div class="seg" role="radiogroup" aria-label="Rol en el equipo">${Object.entries(roles).map(([k, l]) => `<button type="button" role="radio" data-role="${k}" aria-checked="${cur === k}" aria-pressed="${cur === k}">${esc(l)}</button>`).join("")}</div>`}${teamTxt ? `<small class="faint">${esc(teamTxt)}</small>` : ""}</div>
      ${profileExtrasHtml()}
      ${required ? "" : `<div class="field" hidden><span>Tu Google</span><div class="gm-box" id="pfGoogle"></div></div>`}
      ${territoryFieldHtml(cur)}
      ${required ? "" : `<div class="field"><span>Mail desde la app</span><div class="gm-box" id="pfMail">${mailProfileHtml(S.pdmail, S.gmail)}</div></div>`}
      <p class="err" id="pfErr" role="alert" style="margin:0;color:var(--err)"></p>
      <button class="btn primary block" id="pfGo">Guardar</button>
      ${required ? `<button type="button" class="btn ghost block" id="pfOut">Salir</button>` : ""}
    </form>`, { locked: required });
  let role = cur;
  // accounts por país (quien no es AE) y calendario para demos (AE o quien dé demos): public/js/accounts.js
  const extras = bindProfileExtras(m, { role: () => role, required });
  // países que trabajás (la cola de Hoy): se piden acá para que el territorio no arranque vacío sin que la persona lo sepa (core.js)
  const terr = bindTerritoryField(m);
  m.querySelectorAll("[data-role]").forEach(b => b.onclick = () => { role = b.dataset.role; m.querySelectorAll("[data-role]").forEach(x => { const on = x === b; x.setAttribute("aria-pressed", on); x.setAttribute("aria-checked", on); }); extras.roleChanged(); });
  m.querySelector("#pfX")?.addEventListener("click", () => m.close());
  // Mail: Pipedrive conectado como…, «Tu firma» (armada con el perfil o la de Pipedrive pegada) y Gmail como otra opción
  const gbox = m.querySelector("#pfMail");
  const gdraw = () => { if (!gbox?.isConnected) return; const open = gbox.querySelector("#pfSig")?.open; gbox.innerHTML = mailProfileHtml(S.pdmail, S.gmail); if (open) gbox.querySelector("#pfSig")?.setAttribute("open", ""); bindMailProfile(gbox, gdraw); drawGoogleProfile(m.querySelector("#pfGoogle"), gdraw); };
  if (gbox) { resetSigMode(); gdraw(); Promise.all([loadPdMail(true), loadGmail(true)]).then(gdraw); }
  m.querySelector("#pfOut")?.addEventListener("click", async () => { await api("/auth/logout", { body: {} }).catch(() => {}); location.reload(); });
  m.querySelector("#pfF").onsubmit = async e => {
    e.preventDefault(); const go = m.querySelector("#pfGo"); go.disabled = true;
    try {
      await extras.save();
      const r = await api("/api/me/profile", { body: { name: m.querySelector("#pfName").value, role: leader ? "lider" : role } });
      terr.save();
      S.me = r.user; S.profile = { ...(S.profile || {}), complete: true }; m.close(); drawMe(); route();
      toast(required ? `Listo, ${S.me.name.split(" ")[0]}` : "Perfil guardado");
    } catch (x) { m.querySelector("#pfErr").textContent = x.message; go.disabled = false; }
  };
}
function toggleTheme() {
  const next = isDark() ? "light" : "dark";
  applyTheme(next); save("theme", next);
  if (S.view === "prospectar") route(); // el mapa cambia de estilo
}

// ---------- navegación
// menú de la izquierda achicado a íconos (preferencia rail.mini, en este navegador)
function applyRail() {
  const mini = !!loadPref("rail.mini", false), t = $("railToggle");
  $("app").classList.toggle("rail-mini", mini);
  if (t) { t.setAttribute("aria-pressed", String(mini)); t.setAttribute("aria-label", mini ? "Agrandar el menú" : "Achicar el menú"); t.title = mini ? "Agrandar el menú" : "Achicar el menú"; }
}
$("railToggle")?.addEventListener("click", () => { save("rail.mini", !loadPref("rail.mini", false)); applyRail(); dispatchEvent(new Event("resize")); });
applyRail();
// El menú: en escritorio y tablet, todas las secciones en el orden del rol. En el celular (barra de abajo) se ven solo las 4
// de barViews() (clase in-bar, en ese orden) y «Más» (#navMore, que en escritorio no se muestra), que abre el resto en una
// hoja (moreSheet). La sección actual siempre queda marcada: si está en «Más», se marca «Más» (markNav).
function renderNav() {
  closeMore();
  const bar = barViews(), list = views();
  $("nav").innerHTML = list.map(([k, v], i) => `<button class="nav-item${bar.includes(k) ? " in-bar" : ""}" style="--o:${bar.includes(k) ? bar.indexOf(k) : BAR_N + 1}" data-v="${k}" title="${v.label} (${i + 1})" aria-keyshortcuts="${i + 1}" ${S.view === k ? 'aria-current="page"' : ""}>${icon(v.icon)}<span class="lbl">${v.label}</span>${v.short ? `<span class="lbl-s" aria-hidden="true">${v.short}</span>` : ""}</button>`).join("")
    + (list.length > bar.length ? `<button class="nav-item nav-more" id="navMore" style="--o:${BAR_N}" aria-haspopup="dialog" aria-expanded="false" title="Más secciones">${icon("dots")}<span class="lbl">Más</span></button>` : "");
  $("nav").querySelectorAll("[data-v]").forEach(b => b.onclick = () => { go(b.dataset.v); $("main").focus({ preventScroll: true }); });
  $("navMore")?.addEventListener("click", () => moreEl ? closeMore() : moreSheet());
  markNav();
}
// marca la sección actual en el menú; en el celular, «Más» si la actual está en la hoja, y un punto si ahí hay algo pendiente
function markNav() {
  $("nav").querySelectorAll("[data-v]").forEach(b => { if (b.dataset.v === S.view) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current"); });
  const more = $("navMore"); if (!more) return;
  const rest = [...$("nav").querySelectorAll("[data-v]:not(.in-bar)")], cur = rest.find(b => b.dataset.v === S.view);
  if (cur) more.setAttribute("aria-current", "page"); else more.removeAttribute("aria-current");
  more.title = cur ? `Más secciones (estás en ${VIEWS[S.view].label})` : "Más secciones";
  more.querySelector(".badge")?.remove();
  if (rest.some(b => b.querySelector(".badge"))) more.insertAdjacentHTML("beforeend", `<span class="badge dot" aria-label="Hay pendientes en otras secciones"></span>`);
}
// «Más» (celular): hoja con las secciones que no entran en la barra. Se cierra al elegir, con Esc, tocando afuera o al
// cambiar de sección; el foco vuelve a «Más».
let moreEl = null;
function closeMore({ focus = false } = {}) {
  if (!moreEl) return;
  moreEl.remove(); moreEl = null; $("navMore")?.setAttribute("aria-expanded", "false");
  if (focus) $("navMore")?.focus();
}
function moreSheet() {
  closeMenu();
  const bar = barViews(), rest = views().filter(([k]) => !bar.includes(k)); if (!rest.length) return;
  moreEl = document.createElement("div"); moreEl.className = "nav-sheet";
  moreEl.innerHTML = `<div class="ns-box" role="dialog" aria-modal="true" aria-label="Más secciones"><div class="ns-h"><b>Más secciones</b><button class="icon-btn" data-x aria-label="Cerrar">${icon("x")}</button></div><div class="ns-grid">${rest.map(([k, v]) => {
    const bd = $("nav").querySelector(`[data-v="${k}"] .badge`);
    return `<button class="ns-it" data-v="${k}" ${S.view === k ? 'aria-current="page"' : ""}>${icon(v.icon)}<span>${v.label}</span>${bd ? `<span class="badge" title="${esc(bd.title || "")}">${esc(bd.textContent)}</span>` : ""}</button>`;
  }).join("")}</div></div>`;
  document.body.appendChild(moreEl);
  $("navMore").setAttribute("aria-expanded", "true");
  moreEl.addEventListener("pointerdown", e => { if (e.target === moreEl) closeMore(); });
  moreEl.querySelector("[data-x]").onclick = () => closeMore({ focus: true });
  moreEl.querySelectorAll("[data-v]").forEach(b => b.onclick = () => { const v = b.dataset.v; closeMore(); go(v); $("main").focus({ preventScroll: true }); });
  moreEl.addEventListener("keydown", e => {
    if (e.key === "Escape") { e.stopPropagation(); return closeMore({ focus: true }); }
    if (e.key !== "Tab") return; // el foco no sale de la hoja
    const bs = [...moreEl.querySelectorAll("button")], i = bs.indexOf(document.activeElement);
    if (e.shiftKey && i <= 0) { e.preventDefault(); bs.at(-1).focus(); } else if (!e.shiftKey && i === bs.length - 1) { e.preventDefault(); bs[0].focus(); }
  });
  (moreEl.querySelector('[aria-current="page"]') || moreEl.querySelector(".ns-it")).focus();
}
// si la pantalla deja de ser la del celular (se gira o se agranda), la hoja no queda colgada
addEventListener("resize", () => { if (moreEl && getComputedStyle($("navMore") || document.body).display === "none") closeMore(); });
// n: cantidad pendiente, o "!" con label (un aviso)
export function setBadge(view, n, label = "") {
  const b = $("nav").querySelector(`[data-v="${view}"]`); if (!b) return;
  b.querySelector(".badge")?.remove();
  if (n) b.insertAdjacentHTML("beforeend", `<span class="badge" aria-label="${esc(label || `${n} pendientes`)}" title="${esc(label)}">${n > 99 ? "99+" : n}</span>`);
  markNav();
}
// a los líderes: un punto en Equipo si el token de World Dominion falta, vence o lo rechazaron
export const brainBadge = () => setBadge("equipo", S.brain?.token ? "!" : 0, brainTokenMsg()?.[1] || "");
export function go(view) { if (location.hash !== "#/" + view) location.hash = "#/" + view; else route(); }
function route() {
  closeMenu(); closeMore();
  const v = (location.hash.match(/^#\/(\w+)/) || [])[1];
  S.view = VIEWS[v] && views().some(([k]) => k === v) ? v : "hoy";
  if (v && v !== S.view) history.replaceState(null, "", "#/" + S.view); // una vista que no te toca (Métricas para un SDR) vuelve a Hoy
  // a quien era líder antes de los equipos y quedó sin equipo, decirle por qué no ve Métricas
  if (v === "metricas" && S.view !== v && S.profile?.access?.stale) toast("Ahora hay equipos: pedile a dirección que te asigne el tuyo. Mientras, Métricas no se ve.");
  markNav();
  document.title = `${VIEWS[S.view].label} · OrderBrain SDRs`;
  const main = $("main");
  main.innerHTML = "";
  const host = document.createElement("div"); if (S.view === "prospectar") host.style.height = "100%"; main.appendChild(host);
  VIEWS[S.view].render(host);
  main.scrollTop = 0;
}
addEventListener("hashchange", route);
export function rerender() { route(); }

// ---------- búsqueda rápida (Ctrl K, / o la lupa)
// Vacía: recientes y los siguientes de la cola. Al escribir: colegios (hasta 3 si también se busca en Pipedrive, con «Ver
// todos en Prospectar»), «Ubicar en el mapa», lo que hay en Pipedrive (personas, organizaciones, prospectos y tratos, en vivo
// y con espera de ≈350 ms; primero lo que se llama así) y acciones. Lo de Pipedrive va después de lo que ya estaba: cuando
// llega no corre nada de lugar, y la selección se guarda por ítem (no por posición), así Enter hace lo mismo tarde lo que
// tarde Pipedrive. Con resultados de Pipedrive, arriba un atajo «En Pipedrive: N» para bajar hasta ahí.
const PAL = { items: [], sel: 0, ret: null, pd: null }, PALS = pdSearcher(), PAL_PD = 8, PAL_SCH = 3;
const PD_IC = { person: "user", organization: "building", lead: "lead", deal: "deal" };
// «Tuyo»: el dueño en Pipedrive sos vos (un colegio de la base por su organización; lo de Pipedrive, por su dueño)
const isMine = ownerId => !!ownerId && !!S.me?.pdUserId && Number(ownerId) === Number(S.me.pdUserId);
const MINE_TAG = `<span class="tag mine" title="El dueño en Pipedrive sos vos">Tuyo</span>`;
function palPd() {
  if (pdLinkOf($("palIn").value)) { PALS.cancel(); PAL.pd = null; return; }
  let sync = true;
  PALS.run($("palIn").value, st => { PAL.pd = st; if (!sync && !$("palette").hidden) renderPalette({ keep: true }); });
  sync = false;
}
export function rememberSchool(id) { const r = [id, ...loadPref("recent", []).filter(x => x !== id)].slice(0, 6); save("recent", r); }
function openPalette() {
  closeMenu();
  PAL.ret = document.activeElement;
  $("app").inert = true; document.querySelector(".skip").inert = true;
  $("palette").hidden = false; $("palIn").value = ""; PALS.cancel(); PAL.pd = null; renderPalette(); $("palIn").focus();
}
function closePalette(picked = false) {
  $("palette").hidden = true; PALS.cancel();
  $("app").inert = drawerOpen(); document.querySelector(".skip").inert = drawerOpen();
  if (!picked) PAL.ret?.focus?.();
}
// Prospectar con lo escrito (pd: bajar hasta lo de Pipedrive cuando llegue)
const toExplore = (q, pd = false) => { Object.assign(S.explore, { q, place: null, city: null, pd: null, pdScroll: pd }); go("prospectar"); };
function renderPalette({ keep = false } = {}) {
  const raw = $("palIn").value, q = norm(raw), t = raw.trim();
  const prevKey = keep ? PAL.items[PAL.sel]?.key : null;
  const row = (i, ic, title, sub, right = "") => `<button class="pal-item" role="option" data-i="${i}" aria-selected="${i === 0}">${icon(ic)}<span class="t"><b>${esc(title)}</b><small>${esc(sub)}</small></span>${right}</button>`;
  const sections = [];
  let jump = "";
  if (!q) {
    const recent = loadPref("recent", []).map(id => S.byId.get(id)).filter(Boolean);
    const next = (S.today?.queue || []).filter(s => !recent.some(r => r.id === s.id)).slice(0, 4).map(s => S.byId.get(s.id) || s);
    if (recent.length) sections.push(["Recientes", recent.map(s => ({ s }))]);
    // búsquedas recientes (las mismas que Prospectar): tocarla la vuelve a escribir acá
    const searches = recentSearches().slice(0, 5);
    if (searches.length) sections.push(["Búsquedas recientes", searches.map(x => ({ a: { label: x.t, sub: x.kind === "place" ? "Lugar" : "Búsqueda", ic: x.kind === "place" ? "map" : "search",
      fn: () => { openPalette(); $("palIn").value = x.t; palPd(); renderPalette(); } } }))]);
    if (next.length) sections.push(["Siguientes en tu cola", next.map(s => ({ s }))]);
    sections.push(["Acciones", [{ a: { label: "Empezar sesión de llamadas", sub: "Los mejores prospectos de tu territorio, uno tras otro", ic: "play", fn: () => startSession() } },
      { a: { label: "Buscar colegios en una zona…", sub: "Un país, una provincia o una ciudad: los sumo al mapa", ic: "globe", fn: () => import("./scan.js").then(m => m.openScanDialog()) } },
      ...(S.ai ? [{ a: { label: "Abrir asistente", sub: "Que agende, cargue notas o arme un guion", ic: "sparkles", fn: () => openAssistant() } }] : [])]]);
  } else if (pdLinkOf(t)) {
    // un link de Pipedrive pegado: abrir su ficha (no se busca como texto ni como lugar)
    const l = pdLinkOf(t);
    sections.push(["Pipedrive", [{ a: { key: "a:pdlink", label: l.kind === "other" ? "Abrir en Pipedrive" : `Abrir la ficha de ${l.kind === "organization" || l.kind === "person" ? "esta" : "este"} ${l.label}`,
      sub: "Link de Pipedrive", ic: "external", fn: () => openPdLink(t) } }]]);
  } else {
    // un teléfono también encuentra el colegio por sus dígitos (los últimos 8, con o sin código de país)
    const ph = isPhoneQ(raw) ? digits(raw) : "", key = ph.slice(-Math.min(ph.length, 8));
    // con la búsqueda en Pipedrive, hasta 3 colegios (lo de Pipedrive tiene que verse sin bajar); el tope no depende de
    // lo que responda Pipedrive, para que nada se mueva cuando llega
    // el texto de cada colegio ya está normalizado (schoolIdx de core.js): acá solo se compara
    const pdOn = t.length >= PD_MIN, all = q.length >= 2 ? S.schools.filter(s => { const x = schoolIdx(s); return x.p.includes(q) || (!!key && x.d.includes(key)); }) : [];
    // primero lo tuyo, después lo de tu territorio (o el país elegido en Prospectar) y después el resto, sin cambiar el
    // orden dentro de cada grupo: «Ceibos» + Enter abría un colegio de otro país antes que el de la persona
    const pref = new Set([...(S.territory || []), ...(S.explore.country ? [S.explore.country] : [])]), rk = s => isMine(s.ownerId) ? 0 : pref.has(s.country) ? 1 : 2;
    if (pref.size || S.me?.pdUserId) all.sort((a, b) => rk(a) - rk(b));
    const schools = all.slice(0, pdOn ? PAL_SCH : 8);
    const actions = [
      ...views().filter(([k]) => k !== S.view).map(([k, v]) => ({ label: `Ir a ${v.label}`, sub: "", ic: v.icon, fn: () => go(k) })),
      { label: "Empezar sesión de llamadas", sub: "", ic: "play", fn: () => startSession() },
      { label: isDark() ? "Modo claro" : "Modo oscuro", sub: "Tema", ic: isDark() ? "sun" : "moon", fn: toggleTheme },
      ...(S.ai ? [{ label: "Abrir asistente", sub: "", ic: "sparkles", fn: () => openAssistant() }] : []),
    ].filter(a => norm(a.label + " " + a.sub).includes(q));
    if (schools.length) sections.push(["Colegios", [...schools.map(s => ({ s })),
      ...(all.length > schools.length ? [{ a: { key: "a:schools", label: `Ver los ${fmtNum(all.length)} colegios en Prospectar`, sub: "Todos los de la base que coinciden", ic: "list", fn: () => toExplore(t) } }] : [])]]);
    const place = t.length >= 3 && !isPhoneQ(raw) && !isMailQ(raw);
    if (place) sections.push(["En el mapa", [
      { a: { key: "a:locate", label: `Ubicar «${t}» en el mapa`, sub: "Ciudad, barrio o dirección, con los colegios de alrededor", ic: "nav", fn: () => import("./explore.js").then(m => { m.locateFromOutside(t); go("prospectar"); }) } },
    ]]);
    // «Buscar colegios en…» va con las acciones, al final (así lo de Pipedrive queda más arriba)
    if (place) actions.unshift({ key: "a:scan", label: `Buscar colegios en «${t}»`, sub: "Busca los privados que faltan y los suma al mapa", ic: "globe", fn: () => import("./scan.js").then(m => m.openScanDialog(t)) });
    const pd = PAL.pd;
    if (pd) {
      // primero lo que se llama así (una persona «Laura Gómez» al buscar «laura»), después en el orden de Pipedrive
      // (dentro de cada grupo, primero lo tuyo)
      const flat = pdFlat(pd.data), mineFirst = l => [...l.filter(x => isMine(x.ownerId)), ...l.filter(x => !isMine(x.ownerId))];
      const all = [...mineFirst(flat.filter(x => pdNameHit(x, t))), ...mineFirst(flat.filter(x => !pdNameHit(x, t)))], more = all.length > PAL_PD || pd.data?.more;
      const msg = pd.state === "loading" ? `<div class="pal-msg muted"><span class="spin"></span> Buscando en Pipedrive…</div>`
        : pd.state === "err" ? `<div class="pal-msg callout warn">${icon("alert")}<span>No pude buscar en Pipedrive: ${esc(String(pd.err).replace(/^Pipedrive:\s*/, ""))}</span></div>`
        : !all.length ? `<div class="pal-msg muted">Nada en Pipedrive con «${esc(pd.q)}».</div>` : "";
      const n = all.length ? ` · ${pdCount(all.length, pd.data?.more)}` : "";
      sections.push([`En Pipedrive${n}`, [...(msg ? [{ msg }] : []), ...all.slice(0, PAL_PD).map(x => ({ pd: x })),
        ...(more ? [{ a: { key: "a:pdall", label: pd.data?.more ? "Ver todo en Prospectar" : `Ver ${all.length - PAL_PD === 1 ? "el otro resultado" : `los otros ${all.length - PAL_PD}`} en Prospectar`, sub: "Todo lo que hay en Pipedrive con lo que escribiste, con «Ver más» por grupo", ic: "search", fn: () => toExplore(t, true) } }] : [])], "palPdH"]);
      // si arriba hay otras secciones, un atajo en la primera para bajar hasta lo de Pipedrive
      if (all.length && sections.length > 1) jump = `<button type="button" class="pal-jump" data-pal-jump tabindex="-1">En Pipedrive: ${pdCount(all.length, pd.data?.more, true)} ${icon("chevDown", "sm")}</button>`;
    }
    if (actions.length) sections.push(["Acciones", actions.map(a => ({ a }))]);
  }
  PAL.items = []; let html = "";
  sections.forEach(([h, list, id], si) => {
    html += `<div class="pal-h"${id ? ` id="${id}"` : ""}><span>${esc(h)}</span>${si === 0 ? jump : ""}</div>`;
    for (const it of list) {
      const i = PAL.items.length;
      if (it.msg) { html += it.msg; continue; }
      if (it.s) { PAL.items.push({ key: `s:${it.s.id}`, fn: () => openSchool(it.s.id) }); html += row(i, "building", it.s.name, `${it.s.city}, ${it.s.country}`, (isMine(it.s.ownerId) ? MINE_TAG : "") + (it.s.status ? statusPill(it.s) : "")); }
      else if (it.pd) {
        const x = it.pd; PAL.items.push({ key: `pd:${x.type}:${x.id}`, fn: () => openPd(x) });
        html += `<div class="pal-row"><button class="pal-item" role="option" data-i="${i}" aria-selected="false">${icon(PD_IC[x.type] || "search")}<span class="t"><b>${esc(pdTitle(x))}</b>${pdLinesHtml(x)}</span>${isMine(x.ownerId) ? MINE_TAG : ""}${pdBadge(x)}</button><a class="pal-ext" href="${esc(x.url)}" target="_blank" rel="noopener" title="Abrir en Pipedrive" aria-label="Abrir «${esc(pdTitle(x))}» en Pipedrive">${icon("external", "sm")}</a></div>`;
      }
      else { PAL.items.push({ key: it.a.key || `a:${it.a.label}`, ...it.a }); html += row(i, it.a.ic, it.a.label, it.a.sub); }
    }
  });
  // la selección sigue en el mismo ítem (si ya no está, vuelve al primero); nunca se mueve sola cuando llega Pipedrive
  const at = prevKey ? PAL.items.findIndex(x => x.key === prevKey) : 0;
  PAL.sel = Math.max(0, at);
  $("palList").innerHTML = html || `<div class="empty">Nada coincide con «${esc(raw)}».</div>`;
  $("palList").querySelectorAll("[data-i]").forEach(b => { b.setAttribute("aria-selected", +b.dataset.i === PAL.sel); b.onclick = () => pick(+b.dataset.i); b.onmousemove = () => setSel(+b.dataset.i); });
  const j = $("palList").querySelector("[data-pal-jump]");
  if (j) { j.onmousedown = e => e.preventDefault(); j.onclick = () => { const h = $("palPdH"), L = $("palList"); if (h) L.scrollTo({ top: L.scrollTop + h.getBoundingClientRect().top - L.getBoundingClientRect().top - 4, behavior: "smooth" }); }; }
}
function setSel(i) { PAL.sel = i; $("palList").querySelectorAll("[data-i]").forEach(b => b.setAttribute("aria-selected", +b.dataset.i === i)); $("palList").querySelector(`[data-i="${i}"]`)?.scrollIntoView({ block: "nearest" }); }
function pick(i) { const it = PAL.items[i]; if (!it) return; const typed = $("palIn").value.trim(); if (typed.length >= 2) rememberSearch(typed); closePalette(true); it.fn(); }
$("palIn").addEventListener("input", () => { palPd(); renderPalette(); });
$("palIn").addEventListener("keydown", e => {
  if (e.key === "ArrowDown") { e.preventDefault(); setSel(Math.min(PAL.sel + 1, PAL.items.length - 1)); }
  if (e.key === "ArrowUp") { e.preventDefault(); setSel(Math.max(PAL.sel - 1, 0)); }
  if (e.key === "Enter") { e.preventDefault(); pick(PAL.sel); }
});
$("palette").addEventListener("pointerdown", e => { if (e.target === $("palette")) closePalette(); });

// ---------- atajos de teclado
addEventListener("keydown", e => {
  if ($("app").hidden) return;
  const el = document.activeElement;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(el?.tagName) || el?.isContentEditable;
  const overlay = document.querySelector(".modal, .menu, .nav-sheet");
  // Deshacer lo último (por ejemplo, «marcar como hecha») mientras el aviso está visible
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !typing && lastUndo) { e.preventDefault(); lastUndo.fn(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); if (overlay) return; $("palette").hidden ? openPalette() : closePalette(); return; }
  if (e.key === "Escape") {
    if (!$("palette").hidden) return closePalette();
    if (overlay) return;
    // en un campo de la ficha, Esc solo sale del campo (no cierra la ficha ni pierde lo escrito)
    if (drawerOpen() && typing) { el.blur(); return; }
    if (drawerOpen()) return closeSchool();
    if (!$("assistant").hidden) return closeAssistant();
  }
  if (typing || overlay || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === "/") { e.preventDefault(); openPalette(); }
  if (!drawerOpen()) { const k = views().map(([x]) => x)[Number(e.key) - 1]; if (/^[1-9]$/.test(e.key) && k) { go(k); $("main").focus({ preventScroll: true }); } }
});

start();
