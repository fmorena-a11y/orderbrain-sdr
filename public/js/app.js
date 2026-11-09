// OrderBrain SDR · arranque, navegación, búsqueda rápida y atajos.
import { $, S, api, esc, norm, icon, hydrateIcons, setSchools, setUnauthorized, initials, pill, closeMenu, isDark, applyTheme, save } from "./core.js";
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

// ---------- login
async function start() {
  try {
    const me = await api("/api/me");
    Object.assign(S, { me: me.user, ai: me.ai, demo: me.demo, goal: me.goal, pdWeb: me.pdWeb, countries: me.countries, markets: me.markets, outcomes: me.outcomes, lostReasons: me.lostReasons, types: me.types });
    enterApp();
  } catch { showLogin(); }
}
async function showLogin() {
  $("app").hidden = true; $("assistant").hidden = true; $("login").hidden = false;
  const cfg = await api("/auth/config").catch(() => ({}));
  if (cfg.devLogin) { $("devLogin").hidden = false; $("devLogin").onclick = () => api("/auth/dev", { body: {} }).then(start).catch(e => ($("loginErr").textContent = e.message)); }
  if (!cfg.googleClientId) { if (!cfg.devLogin) $("loginErr").textContent = "El login con Google todavía no está configurado en el servidor."; return; }
  const init = () => {
    if (!window.google?.accounts?.id) return setTimeout(init, 200);
    google.accounts.id.initialize({ client_id: cfg.googleClientId, callback: async r => {
      try { await api("/auth/google", { body: { credential: r.credential } }); start(); } catch (e) { $("loginErr").textContent = e.message; }
    } });
    google.accounts.id.renderButton($("gbtn"), { theme: "outline", size: "large", text: "signin_with", locale: "es", shape: "pill" });
  };
  init();
}
setUnauthorized(() => showLogin());

async function enterApp() {
  $("login").hidden = true; $("app").hidden = false;
  hydrateIcons();
  drawThemeBtn();
  $("themeBtn").onclick = toggleTheme;
  $("assistBtn").hidden = !S.ai;
  $("assistBtn").onclick = () => openAssistant();
  $("me").innerHTML = `<div class="av">${S.me.picture ? `<img src="${esc(S.me.picture)}" alt="">` : initials(S.me.name)}</div><div class="who"><b>${esc(S.me.name)}</b><small>${S.me.pdUserId ? "Conectado a Pipedrive" : "Sin usuario en Pipedrive"}</small></div><button class="icon-btn" id="logout" aria-label="Salir" title="Salir">${icon("logout")}</button>`;
  $("logout").onclick = async () => { await api("/auth/logout", { body: {} }).catch(() => {}); location.reload(); };
  renderNav();
  const [schools, team] = await Promise.all([api("/api/schools"), api("/api/team").catch(() => [])]);
  setSchools(schools); S.team = team;
  route();
}

// ---------- modo claro / oscuro
function drawThemeBtn() {
  const dark = isDark();
  $("themeBtn").innerHTML = `${icon(dark ? "sun" : "moon")}<span class="lbl">${dark ? "Modo claro" : "Modo oscuro"}</span>`;
  $("themeBtn").setAttribute("aria-label", dark ? "Cambiar a modo claro" : "Cambiar a modo oscuro");
}
function toggleTheme() {
  const next = isDark() ? "light" : "dark";
  applyTheme(next); save("theme", next); drawThemeBtn();
  if (S.view === "prospectar") route(); // el mapa cambia de estilo
}
// ---------- navegación
function renderNav(badges = {}) {
  $("nav").innerHTML = Object.entries(VIEWS).map(([k, v]) => `<button class="nav-item" data-v="${k}" ${S.view === k ? 'aria-current="page"' : ""}>${icon(v.icon)}<span class="lbl">${v.label}</span>${badges[k] ? `<span class="badge">${badges[k]}</span>` : ""}</button>`).join("");
  $("nav").querySelectorAll("[data-v]").forEach(b => b.onclick = () => go(b.dataset.v));
}
export function setBadge(view, n) { const b = $("nav").querySelector(`[data-v="${view}"]`); if (!b) return; b.querySelector(".badge")?.remove(); if (n) b.insertAdjacentHTML("beforeend", `<span class="badge">${n > 99 ? "99+" : n}</span>`); }
export function go(view) { if (location.hash !== "#/" + view) location.hash = "#/" + view; else route(); }
function route() {
  const v = (location.hash.match(/^#\/(\w+)/) || [])[1];
  S.view = VIEWS[v] ? v : "hoy";
  $("nav").querySelectorAll("[data-v]").forEach(b => { if (b.dataset.v === S.view) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current"); });
  const main = $("main");
  main.innerHTML = S.demo ? `<div class="demo-banner">Modo demo: Pipedrive de prueba, nada se guarda en la cuenta real.</div>` : "";
  const host = document.createElement("div"); host.style.height = S.view === "prospectar" ? (S.demo ? "calc(100% - 37px)" : "100%") : ""; main.appendChild(host);
  VIEWS[S.view].render(host);
  main.scrollTop = 0;
}
addEventListener("hashchange", route);
export function rerender() { route(); }

// ---------- búsqueda rápida (Ctrl K)
const PAL = { items: [], sel: 0 };
function openPalette() {
  closeMenu();
  $("palette").hidden = false; $("palIn").value = ""; renderPalette(); $("palIn").focus();
}
function closePalette() { $("palette").hidden = true; }
function renderPalette() {
  const q = norm($("palIn").value);
  const actions = [
    { label: "Ir a Hoy", sub: "Tu agenda y a quién llamar", ic: "sun", fn: () => go("hoy") },
    { label: "Empezar sesión de llamadas", sub: "Los mejores prospectos de tu territorio, uno tras otro", ic: "play", fn: () => startSession() },
    { label: "Prospectar en el mapa", sub: "Colegios por país y ciudad", ic: "map", fn: () => go("prospectar") },
    { label: "Mi agenda", sub: "Actividades pendientes en Pipedrive", ic: "calendar", fn: () => go("agenda") },
    { label: isDark() ? "Modo claro" : "Modo oscuro", sub: "Cambiar el tema de la app", ic: isDark() ? "sun" : "moon", fn: toggleTheme },
    { label: "Radar de colegios", sub: "Lo que encontró el agente que recorre todas las ciudades", ic: "target", fn: () => go("radar") },
    { label: "Ranking del equipo", sub: "Contactos y demos de la semana", ic: "users", fn: () => go("equipo") },
    ...(S.ai ? [{ label: "Abrir asistente", sub: "Pedile que agende, cargue notas o arme un guion", ic: "sparkles", fn: () => openAssistant() }] : []),
  ].filter(a => !q || norm(a.label + " " + a.sub).includes(q));
  const schools = q.length >= 2 ? S.schools.filter(s => norm(`${s.name} ${s.city} ${s.country}`).includes(q)).slice(0, 8) : [];
  PAL.items = [...schools.map(s => ({ school: s, fn: () => openSchool(s.id) })), ...actions];
  PAL.sel = 0;
  $("palList").innerHTML = (schools.length ? `<div class="pal-h">Colegios</div>` + schools.map((s, i) => `<button class="pal-item" role="option" data-i="${i}" aria-selected="${i === 0}">${icon("building")}<span class="t"><b>${esc(s.name)}</b><small>${esc(s.city)}, ${esc(s.country)}</small></span>${pill(s.status)}</button>`).join("") : "")
    + (actions.length ? `<div class="pal-h">Acciones</div>` + actions.map((a, j) => { const i = schools.length + j; return `<button class="pal-item" role="option" data-i="${i}" aria-selected="${i === 0}">${icon(a.ic)}<span class="t"><b>${esc(a.label)}</b><small>${esc(a.sub)}</small></span></button>`; }).join("") : "")
    || `<div class="empty">Nada coincide con «${esc($("palIn").value)}».</div>`;
  $("palList").querySelectorAll("[data-i]").forEach(b => { b.onclick = () => pick(+b.dataset.i); b.onmousemove = () => setSel(+b.dataset.i); });
}
function setSel(i) { PAL.sel = i; $("palList").querySelectorAll("[data-i]").forEach(b => b.setAttribute("aria-selected", +b.dataset.i === i)); $("palList").querySelector(`[data-i="${i}"]`)?.scrollIntoView({ block: "nearest" }); }
function pick(i) { const it = PAL.items[i]; if (!it) return; closePalette(); it.fn(); }
$("palIn").addEventListener("input", renderPalette);
$("palIn").addEventListener("keydown", e => {
  if (e.key === "ArrowDown") { e.preventDefault(); setSel(Math.min(PAL.sel + 1, PAL.items.length - 1)); }
  if (e.key === "ArrowUp") { e.preventDefault(); setSel(Math.max(PAL.sel - 1, 0)); }
  if (e.key === "Enter") { e.preventDefault(); pick(PAL.sel); }
});
$("palette").addEventListener("pointerdown", e => { if (e.target === $("palette")) closePalette(); });
$("openPalette").onclick = openPalette;

// ---------- atajos de teclado
addEventListener("keydown", e => {
  if ($("app").hidden) return;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); $("palette").hidden ? openPalette() : closePalette(); return; }
  if (e.key === "Escape") {
    if (!$("palette").hidden) return closePalette();
    if (document.querySelector(".modal") || document.querySelector(".menu")) return;
    if (drawerOpen()) return closeSchool();
    if (!$("assistant").hidden) return closeAssistant();
  }
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === "/") { e.preventDefault(); openPalette(); }
  if (!drawerOpen()) {
    const k = { 1: "hoy", 2: "prospectar", 3: "agenda", 4: "radar", 5: "equipo" }[e.key]; if (k) go(k);
  }
});

start();
