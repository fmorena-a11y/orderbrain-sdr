// Utilidades compartidas: estado, API, íconos, fechas, enlaces y piezas de interfaz.
export const $ = id => document.getElementById(id);
export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const norm = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
export const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
export const today = () => new Date().toLocaleDateString("sv");
export const addDays = (d, n) => { const x = new Date(d + "T12:00:00"); x.setDate(x.getDate() + n); return x.toLocaleDateString("sv"); };
export const nextBusinessDay = d => { let x = addDays(d, 1); while ([0, 6].includes(new Date(x + "T12:00:00").getDay())) x = addDays(x, 1); return x; };

// ---------- estado global
export const S = {
  me: null, ai: false, demo: false, goal: 40, pdWeb: "", countries: [], markets: {}, outcomes: [], lostReasons: [], types: {},
  team: [], schools: [], byId: new Map(), today: null, feed: null, agenda: null,
  territory: load("territory", []), view: "hoy",
  explore: { country: null, city: null, filter: "prospect", q: "" },
  session: null, // { ids: [], i: 0, label }
};
function load(k, d) { try { const v = localStorage.getItem("ob." + k); return v ? JSON.parse(v) : d; } catch { return d; } }
export function save(k, v) { try { localStorage.setItem("ob." + k, JSON.stringify(v)); } catch {} }
export const loadPref = load;
// ---------- modo claro / oscuro (se recuerda; si nunca se eligió, sigue al sistema)
export const isDark = () => document.documentElement.dataset.theme ? document.documentElement.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
export function applyTheme(t) {
  if (t === "dark" || t === "light") document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  document.querySelectorAll('meta[name="theme-color"]').forEach(m => m.setAttribute("content", isDark() ? "#111214" : "#FAFAFA"));
}
applyTheme(load("theme", ""));
export function setSchools(list) { S.schools = list; S.byId = new Map(list.map(s => [s.id, s])); }
export function patchSchool(s) { if (!s?.id) return; const cur = S.byId.get(s.id); if (cur) Object.assign(cur, s); else { S.schools.push(s); S.byId.set(s.id, s); } }

// ---------- API
let onUnauthorized = () => {};
export const setUnauthorized = fn => (onUnauthorized = fn);
export async function api(path, opts = {}) {
  const r = await fetch(path, { method: opts.body ? "POST" : "GET", headers: { "content-type": "application/json", "x-tz": TZ }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && !path.startsWith("/auth")) { onUnauthorized(); throw new Error("Iniciá sesión."); }
  if (!r.ok) throw new Error(j.error || `Error ${r.status}`);
  return j;
}

// ---------- íconos (trazos estilo Lucide)
const P = {
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  map: '<path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2Z"/><path d="M9 4v14M15 6v14"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
  sparkles: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9Z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8Z"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
  phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2Z"/>',
  whatsapp: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/><path d="M9 10a.5.5 0 0 0 1 0V9a.5.5 0 0 0-1 0v1a5 5 0 0 0 5 5h1a.5.5 0 0 0 0-1h-1a.5.5 0 0 0 0 1"/>',
  mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  checkCircle: '<circle cx="12" cy="12" r="10"/><path d="m8 12 3 3 5-6"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  arrowRight: '<path d="M5 12h14M12 5l7 7-7 7"/>',
  arrowLeft: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
  external: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  nav: '<path d="m3 11 19-9-9 19-2-8-8-2Z"/>',
  video: '<path d="m22 8-6 4 6 4V8Z"/><rect x="2" y="6" width="14" height="12" rx="2"/>',
  note: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M16 13H8M16 17H8"/>',
  target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  play: '<path d="m7 4 13 8-13 8Z"/>',
  refresh: '<path d="M21 12a9 9 0 0 1-15 6.7L3 16M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5M3 21v-5h5"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  skip: '<path d="m5 4 10 8-10 8Z"/><path d="M19 5v14"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  deal: '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>',
  alert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>',
  flame: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.4-.5-2-1-3-1.1-2.1-.2-4 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.2.4-2.3 1-3.3.3 1.6 1.4 2.8 2.5 2.8Z"/>',
  chevDown: '<path d="m6 9 6 6 6-6"/>',
  move: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  building: '<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M9 22v-4h6v4M8 6h.01M16 6h.01M12 6h.01M12 10h.01M12 14h.01M16 10h.01M16 14h.01M8 10h.01M8 14h.01"/>',
  bolt: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8Z"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
};
export const icon = (n, cls = "") => `<svg class="ico ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[n] || ""}</svg>`;
export function hydrateIcons(root = document) { root.querySelectorAll("[data-icon]").forEach(e => { if (!e.firstChild) e.innerHTML = icon(e.dataset.icon); }); }
export const TYPE_ICON = { call: "phone", meeting: "video", deadline: "whatsapp", task: "mail", contacto_decisor: "user" };

// ---------- estados de colegio
export const ST = {
  new: { l: "Nunca contactado", c: "--st-new" }, org: { l: "En Pipe sin trato", c: "--st-org" },
  lost: { l: "Perdido", c: "--st-lost" }, open: { l: "En proceso", c: "--st-open" },
  client: { l: "Cliente", c: "--st-client" }, unk: { l: "Sin revisar", c: "--st-unk" },
};
export const cssVar = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
export const pill = st => `<span class="pill ${st}">${ST[st]?.l || st}</span>`;

// ---------- fechas
const fmtDay = new Intl.DateTimeFormat("es", { weekday: "long", day: "numeric", month: "long" });
const fmtShort = new Intl.DateTimeFormat("es", { weekday: "short", day: "numeric", month: "short" });
export const dayLabel = d => { const t = today(); if (d === t) return "Hoy"; if (d === addDays(t, 1)) return "Mañana"; if (d === addDays(t, -1)) return "Ayer"; return cap(fmtDay.format(new Date(d + "T12:00:00"))); };
export const shortDay = d => { const t = today(); if (d === t) return "hoy"; if (d === addDays(t, 1)) return "mañana"; if (d === addDays(t, -1)) return "ayer"; return fmtShort.format(new Date(d + "T12:00:00")); };
export const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
// Actividad de Pipedrive (hora en UTC) → fecha y hora locales.
export function localAct(a) {
  if (!a.time) return { date: a.date, time: "" };
  const d = new Date(`${a.date}T${a.time.slice(0, 5)}:00Z`);
  if (isNaN(d)) return { date: a.date, time: a.time.slice(0, 5) };
  return { date: d.toLocaleDateString("sv"), time: d.toTimeString().slice(0, 5) };
}
export const ago = t => {
  if (!t) return ""; const d = (Date.now() - new Date(t)) / 864e5;
  if (d < 1 / 48) return "recién"; if (d < 1 / 24) return `hace ${Math.round(d * 1440)} min`; if (d < 1) return `hace ${Math.round(d * 24)} h`;
  if (d < 2) return "ayer"; if (d < 30) return `hace ${Math.round(d)} días`; if (d < 365) return `hace ${Math.round(d / 30)} meses`; return `hace ${(d / 365).toFixed(1).replace(".0", "")} años`;
};
export const initials = n => String(n || "?").split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join("").toUpperCase();

// ---------- enlaces a herramientas
export const digits = p => String(p || "").replace(/\D/g, "");
const MOBILE = /^(519\d{8}|521\d{10}|52\d{10}|569\d{8}|549\d{10}|5989\d{7}|502[345]\d{7}|506[678]\d{7})$/;
export const isMobile = p => MOBILE.test(digits(p));
export function waNumber(phone, country) {
  let d = digits(phone); if (!d) return "";
  const pre = S.markets[country]?.prefix || "";
  if (pre && !d.startsWith(pre)) d = pre + d.replace(/^0+/, "");
  return d;
}
export const waLink = (phone, text, country) => { const n = waNumber(phone, country); return `https://wa.me/${n}${text ? `?text=${encodeURIComponent(text)}` : ""}`; };
export const telLink = p => `tel:${String(p || "").replace(/[^\d+]/g, "")}`;
export const gmailLink = ({ to = "", subject = "", body = "" }) => `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(to)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
export function gcalLink({ title, date, time, minutes = 30, details = "", location = "", guests = "" }) {
  const start = new Date(`${date}T${time || "10:00"}:00`), end = new Date(start.getTime() + minutes * 60000);
  const f = d => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(title)}&dates=${f(start)}/${f(end)}&details=${encodeURIComponent(details)}&location=${encodeURIComponent(location)}${guests ? `&add=${encodeURIComponent(guests)}` : ""}`;
}
export const mapsDir = s => `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}`;
// Vista satelital del colegio (Esri World Imagery, sin clave). span en grados de longitud (~250 m por defecto).
export function satLink(s, { w = 800, h = 480, span = 0.0035 } = {}) {
  const dLng = span / 2, dLat = (span * h / w) / 2 * Math.cos(s.lat * Math.PI / 180);
  return `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export?bbox=${s.lng - dLng},${s.lat - dLat},${s.lng + dLng},${s.lat + dLat}&bboxSR=4326&imageSR=3857&size=${w},${h}&format=jpg&f=image`;
}
export const mapsSearch = s => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(s.name + " " + s.city)}`;

// ---------- piezas de interfaz
export function toast(msg, { type = "", action, href, ms } = {}) {
  const t = document.createElement("div"); t.className = "toast " + type; t.setAttribute("role", type === "err" ? "alert" : "status");
  const ic = type === "err" ? "alert" : type === "info" ? "clock" : "checkCircle";
  t.innerHTML = `${icon(ic)}<span>${esc(msg)}</span>${href ? `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(action || "Abrir")}</a>` : action ? `<button data-act>${esc(action.label)}</button>` : ""}<button class="x" aria-label="Cerrar aviso">×</button>`;
  if (action?.fn) t.querySelector("[data-act]").onclick = () => { action.fn(); t.remove(); };
  t.querySelector(".x").onclick = () => t.remove();
  $("toasts").appendChild(t);
  // los errores y los avisos con acción duran más
  setTimeout(() => t.remove(), ms || (type === "err" ? 9000 : action ? 7000 : 4200));
}
export async function copy(text) { try { await navigator.clipboard.writeText(text); toast("Copiado"); } catch { toast("No se pudo copiar", { type: "err" }); } }

let menuEl = null;
export function closeMenu() { menuEl?.remove(); menuEl = null; document.removeEventListener("pointerdown", outside, true); }
function outside(e) { if (menuEl && !menuEl.contains(e.target)) closeMenu(); }
// Menú flotante anclado a un botón. items: [{ head } | { label, sub, fn }]
export function openMenu(anchor, items) {
  closeMenu();
  menuEl = document.createElement("div"); menuEl.className = "menu"; menuEl.setAttribute("role", "menu");
  menuEl.innerHTML = items.map((it, i) => it.head ? `<div class="mh">${esc(it.head)}</div>` : `<button role="menuitem" data-i="${i}"><b>${esc(it.label)}</b>${it.sub ? `<small>${esc(it.sub)}</small>` : ""}</button>`).join("");
  document.body.appendChild(menuEl);
  const r = anchor.getBoundingClientRect(), mw = menuEl.offsetWidth, mh = menuEl.offsetHeight;
  menuEl.style.left = Math.max(12, Math.min(r.left, innerWidth - mw - 12)) + "px";
  menuEl.style.top = (r.bottom + mh + 8 > innerHeight ? Math.max(12, r.top - mh - 6) : r.bottom + 6) + "px";
  menuEl.querySelectorAll("button").forEach(b => b.onclick = () => { const it = items[+b.dataset.i]; closeMenu(); it.fn(); });
  menuEl.querySelector("button")?.focus();
  menuEl.addEventListener("keydown", e => {
    const bs = [...menuEl.querySelectorAll("button")], i = bs.indexOf(document.activeElement);
    if (e.key === "ArrowDown") { e.preventDefault(); bs[(i + 1) % bs.length].focus(); }
    if (e.key === "ArrowUp") { e.preventDefault(); bs[(i - 1 + bs.length) % bs.length].focus(); }
    if (e.key === "Escape") { closeMenu(); anchor.focus(); }
  });
  setTimeout(() => document.addEventListener("pointerdown", outside, true));
}

// Modal simple. Devuelve el elemento; close() lo cierra.
export function modal(html, { onClose } = {}) {
  const m = document.createElement("div"); m.className = "modal"; m.setAttribute("role", "dialog"); m.setAttribute("aria-modal", "true");
  m.innerHTML = `<div class="modal-box">${html}</div>`;
  const close = () => { m.remove(); document.removeEventListener("keydown", key); onClose?.(); };
  const key = e => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
  m.addEventListener("pointerdown", e => { if (e.target === m) close(); });
  document.addEventListener("keydown", key);
  document.body.appendChild(m);
  m.close = close;
  setTimeout(() => m.querySelector("textarea, input, button")?.focus());
  return m;
}
