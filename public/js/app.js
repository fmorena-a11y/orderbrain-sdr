// OrderBrain SDR · arranque, navegación, cuenta, búsqueda rápida y atajos.
import { $, S, api, esc, norm, icon, hydrateIcons, setSchools, setUnauthorized, initials, pill, statusPill, closeMenu, openMenu, isDark, applyTheme, save, loadPref, lastUndo, modal, toast, brainTokenMsg } from "./core.js";
import { renderToday } from "./today.js";
import { renderExplore } from "./explore.js";
import { renderAgenda } from "./agenda.js";
import { renderTeam } from "./team.js";
import { renderRadar } from "./radar.js";
import { openSchool, closeSchool, drawerOpen, startSession } from "./school.js";
import { openAssistant, closeAssistant } from "./chat.js";

const VIEWS = {
  hoy: { label: "Hoy", icon: "sun", render: renderToday },
  prospectar: { label: "Prospectar", icon: "map", render: renderExplore },
  agenda: { label: "Agenda", icon: "calendar", render: renderAgenda },
  radar: { label: "Radar", icon: "target", render: renderRadar },
  equipo: { label: "Equipo", icon: "users", render: renderTeam },
};
const show = id => { for (const x of ["boot", "login", "app"]) $(x).hidden = x !== id; };

// ---------- login
async function start() {
  try {
    const me = await api("/api/me");
    Object.assign(S, { me: me.user, profile: me.profile, ai: me.ai, study: me.study, demo: me.demo, goal: me.goal, pdWeb: me.pdWeb, countries: me.countries, markets: me.markets, outcomes: me.outcomes, lostReasons: me.lostReasons, types: me.types });
    enterApp();
    // la primera vez: nombre completo y rol en el equipo (se usa en saludos, firmas y en Equipo)
    if (!me.profile?.complete) profileDialog({ required: true });
  } catch { showLogin(); }
}
async function showLogin() {
  document.querySelectorAll(".modal").forEach(m => m.remove()); // si la sesión vence con un diálogo abierto
  show("login"); $("assistant").hidden = true;
  const cfg = await api("/auth/config").catch(() => null);
  const err = $("loginErr");
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
async function loadBase() {
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
  $("me").innerHTML = `${avatar()}<span class="who"><b>${esc(S.me.name)}</b>${off ? "<small>Sin usuario en Pipedrive</small>" : ""}</span>`;
  $("me").title = off ? "Tu email no coincide con un usuario de Pipedrive" : `${S.me.name} · conectado a Pipedrive`;
  $("topMe").innerHTML = avatar();
}
function accountMenu(anchor) {
  openMenu(anchor, [
    { head: S.me.email, cls: "plain" },
    { label: S.me.pdUserId ? "Conectado a Pipedrive" : "Sin usuario en Pipedrive", sub: S.me.pdUserId ? "Tus actividades y notas se guardan a tu nombre" : "Pedí que te den de alta con este email", fn: () => S.pdWeb && window.open(S.pdWeb, "_blank", "noopener") },
    { label: "Tu perfil", sub: `${S.me.name}${S.me.roleLabel ? " · " + S.me.roleLabel : ""}`, fn: () => profileDialog() },
    { label: isDark() ? "Modo claro" : "Modo oscuro", sub: "Cambiar el tema", fn: toggleTheme },
    { label: "Salir", sub: "Cerrar sesión en este dispositivo", fn: async () => { await api("/auth/logout", { body: {} }).catch(() => {}); location.reload(); } },
  ]);
}
function profileDialog({ required = false } = {}) {
  // el rol «Líder» lo define el servidor (quien conectó Pipedrive o la lista de líderes); los demás eligen SDR o AE
  const leader = !!S.profile?.leader;
  const roles = S.profile?.roles || { sdr: "SDR", ae: "Account Executive" };
  const cur = leader ? "lider" : S.me.role && S.me.role !== "lider" ? S.me.role : "";
  const name = S.profile?.complete ? S.me.name : (S.profile?.suggested || "");
  const m = modal(`<div class="modal-h"><h3>${required ? "Contanos quién sos" : "Tu perfil"}</h3>${required ? "" : `<button class="icon-btn" id="pfX" aria-label="Cerrar">${icon("x")}</button>`}</div>
    ${required ? `<p class="muted" style="margin:-6px 0 0">Se usa en los saludos y en Equipo. En Pipedrive tus notas se firman con tu usuario de Pipedrive.</p>` : ""}
    <form id="pfF" class="stack" style="gap:14px">
      <label class="field"><span>Nombre y apellido</span><input class="inp" id="pfName" value="${esc(name)}" autocomplete="name" placeholder="Ej: Javiera Tejos" required></label>
      <div class="field"><span>Rol en el equipo</span>${leader ? `<p class="muted" style="margin:0">Líder (por ser quien conectó Pipedrive o estar en la lista de líderes)</p>` : `<div class="seg" role="radiogroup" aria-label="Rol en el equipo">${Object.entries(roles).map(([k, l]) => `<button type="button" role="radio" data-role="${k}" aria-checked="${cur === k}" aria-pressed="${cur === k}">${esc(l)}</button>`).join("")}</div>`}</div>
      <p class="err" id="pfErr" role="alert" style="margin:0;color:var(--err)"></p>
      <button class="btn primary block" id="pfGo">Guardar</button>
      ${required ? `<button type="button" class="btn ghost block" id="pfOut">Salir</button>` : ""}
    </form>`, { locked: required });
  let role = cur;
  m.querySelectorAll("[data-role]").forEach(b => b.onclick = () => { role = b.dataset.role; m.querySelectorAll("[data-role]").forEach(x => { const on = x === b; x.setAttribute("aria-pressed", on); x.setAttribute("aria-checked", on); }); });
  m.querySelector("#pfX")?.addEventListener("click", () => m.close());
  m.querySelector("#pfOut")?.addEventListener("click", async () => { await api("/auth/logout", { body: {} }).catch(() => {}); location.reload(); });
  m.querySelector("#pfF").onsubmit = async e => {
    e.preventDefault(); const go = m.querySelector("#pfGo"); go.disabled = true;
    try {
      const r = await api("/api/me/profile", { body: { name: m.querySelector("#pfName").value, role: leader ? "lider" : role } });
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
function renderNav() {
  $("nav").innerHTML = Object.entries(VIEWS).map(([k, v], i) => `<button class="nav-item" data-v="${k}" title="${v.label} (${i + 1})" aria-keyshortcuts="${i + 1}" ${S.view === k ? 'aria-current="page"' : ""}>${icon(v.icon)}<span class="lbl">${v.label}</span></button>`).join("");
  $("nav").querySelectorAll("[data-v]").forEach(b => b.onclick = () => { go(b.dataset.v); $("main").focus({ preventScroll: true }); });
}
// n: cantidad pendiente, o "!" con label (un aviso)
export function setBadge(view, n, label = "") {
  const b = $("nav").querySelector(`[data-v="${view}"]`); if (!b) return;
  b.querySelector(".badge")?.remove();
  if (n) b.insertAdjacentHTML("beforeend", `<span class="badge" aria-label="${esc(label || `${n} pendientes`)}" title="${esc(label)}">${n > 99 ? "99+" : n}</span>`);
}
// a los líderes: un punto en Equipo si el token de World Dominion falta, vence o lo rechazaron
export const brainBadge = () => setBadge("equipo", S.brain?.token ? "!" : 0, brainTokenMsg()?.[1] || "");
export function go(view) { if (location.hash !== "#/" + view) location.hash = "#/" + view; else route(); }
function route() {
  closeMenu();
  const v = (location.hash.match(/^#\/(\w+)/) || [])[1];
  S.view = VIEWS[v] ? v : "hoy";
  $("nav").querySelectorAll("[data-v]").forEach(b => { if (b.dataset.v === S.view) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current"); });
  document.title = `${VIEWS[S.view].label} · OrderBrain SDR`;
  const main = $("main");
  main.innerHTML = "";
  const host = document.createElement("div"); if (S.view === "prospectar") host.style.height = "100%"; main.appendChild(host);
  VIEWS[S.view].render(host);
  main.scrollTop = 0;
}
addEventListener("hashchange", route);
export function rerender() { route(); }

// ---------- búsqueda rápida (Ctrl K, / o la lupa)
// Vacía: recientes y los siguientes de la cola. Al escribir: colegios y acciones.
const PAL = { items: [], sel: 0, ret: null };
export function rememberSchool(id) { const r = [id, ...loadPref("recent", []).filter(x => x !== id)].slice(0, 6); save("recent", r); }
function openPalette() {
  closeMenu();
  PAL.ret = document.activeElement;
  $("app").inert = true; document.querySelector(".skip").inert = true;
  $("palette").hidden = false; $("palIn").value = ""; renderPalette(); $("palIn").focus();
}
function closePalette(picked = false) {
  $("palette").hidden = true;
  $("app").inert = drawerOpen(); document.querySelector(".skip").inert = drawerOpen();
  if (!picked) PAL.ret?.focus?.();
}
function renderPalette() {
  const raw = $("palIn").value, q = norm(raw);
  const row = (i, ic, title, sub, right = "") => `<button class="pal-item" role="option" data-i="${i}" aria-selected="${i === 0}">${icon(ic)}<span class="t"><b>${esc(title)}</b><small>${esc(sub)}</small></span>${right}</button>`;
  const sections = [];
  if (!q) {
    const recent = loadPref("recent", []).map(id => S.byId.get(id)).filter(Boolean);
    const next = (S.today?.queue || []).filter(s => !recent.some(r => r.id === s.id)).slice(0, 4).map(s => S.byId.get(s.id) || s);
    if (recent.length) sections.push(["Recientes", recent.map(s => ({ s }))]);
    if (next.length) sections.push(["Siguientes en tu cola", next.map(s => ({ s }))]);
    sections.push(["Acciones", [{ a: { label: "Empezar sesión de llamadas", sub: "Los mejores prospectos de tu territorio, uno tras otro", ic: "play", fn: () => startSession() } },
      { a: { label: "Buscar colegios en una zona…", sub: "Un país, una provincia o una ciudad: los sumo al mapa", ic: "globe", fn: () => import("./scan.js").then(m => m.openScanDialog()) } },
      ...(S.ai ? [{ a: { label: "Abrir asistente", sub: "Que agende, cargue notas o arme un guion", ic: "sparkles", fn: () => openAssistant() } }] : [])]]);
  } else {
    const schools = q.length >= 2 ? S.schools.filter(s => norm(`${s.name} ${s.city} ${s.country}`).includes(q)).slice(0, 8) : [];
    const actions = [
      ...Object.entries(VIEWS).filter(([k]) => k !== S.view).map(([k, v]) => ({ label: `Ir a ${v.label}`, sub: "", ic: v.icon, fn: () => go(k) })),
      { label: "Empezar sesión de llamadas", sub: "", ic: "play", fn: () => startSession() },
      { label: isDark() ? "Modo claro" : "Modo oscuro", sub: "Tema", ic: isDark() ? "sun" : "moon", fn: toggleTheme },
      ...(S.ai ? [{ label: "Abrir asistente", sub: "", ic: "sparkles", fn: () => openAssistant() }] : []),
    ].filter(a => norm(a.label + " " + a.sub).includes(q));
    if (schools.length) sections.push(["Colegios", schools.map(s => ({ s }))]);
    if (raw.trim().length >= 3) sections.push(["En el mapa", [
      { a: { label: `Ubicar «${raw.trim()}» en el mapa`, sub: "Ciudad, barrio o dirección, con los colegios de alrededor", ic: "nav", fn: () => import("./explore.js").then(m => { m.locateFromOutside(raw.trim()); go("prospectar"); }) } },
      { a: { label: `Buscar colegios en «${raw.trim()}»`, sub: "Busca los privados que faltan y los suma al mapa", ic: "globe", fn: () => import("./scan.js").then(m => m.openScanDialog(raw.trim())) } },
    ]]);
    if (actions.length) sections.push(["Acciones", actions.map(a => ({ a }))]);
  }
  PAL.items = []; let html = "";
  for (const [h, list] of sections) {
    html += `<div class="pal-h">${h}</div>`;
    for (const it of list) {
      const i = PAL.items.length;
      if (it.s) { PAL.items.push({ fn: () => openSchool(it.s.id) }); html += row(i, "building", it.s.name, `${it.s.city}, ${it.s.country}`, it.s.status ? statusPill(it.s) : ""); }
      else { PAL.items.push(it.a); html += row(i, it.a.ic, it.a.label, it.a.sub); }
    }
  }
  PAL.sel = 0;
  $("palList").innerHTML = html || `<div class="empty">Nada coincide con «${esc(raw)}».</div>`;
  $("palList").querySelectorAll("[data-i]").forEach(b => { b.onclick = () => pick(+b.dataset.i); b.onmousemove = () => setSel(+b.dataset.i); });
}
function setSel(i) { PAL.sel = i; $("palList").querySelectorAll("[data-i]").forEach(b => b.setAttribute("aria-selected", +b.dataset.i === i)); $("palList").querySelector(`[data-i="${i}"]`)?.scrollIntoView({ block: "nearest" }); }
function pick(i) { const it = PAL.items[i]; if (!it) return; closePalette(true); it.fn(); }
$("palIn").addEventListener("input", renderPalette);
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
  const overlay = document.querySelector(".modal, .menu");
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
  if (!drawerOpen()) { const k = { 1: "hoy", 2: "prospectar", 3: "agenda", 4: "radar", 5: "equipo" }[e.key]; if (k) { go(k); $("main").focus({ preventScroll: true }); } }
});

start();
