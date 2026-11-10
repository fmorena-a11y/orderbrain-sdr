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
// Fila que se corre de costado (países, filtros): flechas con mouse, rueda vertical → horizontal,
// bordes difuminados que avisan que hay más, y la opción elegida siempre a la vista.
export function scroller(el) {
  if (!el || el.parentElement?.classList.contains("scroller")) return;
  const w = document.createElement("div"); w.className = "scroller";
  el.before(w); w.appendChild(el);
  const btn = dir => {
    const b = document.createElement("button"); b.type = "button"; b.className = `sc-btn ${dir}`; b.tabIndex = -1;
    b.setAttribute("aria-hidden", "true"); b.innerHTML = icon(dir === "l" ? "chevL" : "chevR");
    b.onclick = () => el.scrollBy({ left: (dir === "l" ? -1 : 1) * Math.max(160, el.clientWidth * 0.7), behavior: "smooth" });
    return b;
  };
  w.append(btn("l"), btn("r"));
  const upd = () => { const max = el.scrollWidth - el.clientWidth; w.classList.toggle("can-l", el.scrollLeft > 2); w.classList.toggle("can-r", el.scrollLeft < max - 2); };
  const reveal = () => {
    const sel = el.querySelector('[aria-pressed="true"]'); const key = sel?.textContent || "";
    if (!sel || el.dataset.sel === key) return; el.dataset.sel = key;
    const a = el.getBoundingClientRect(), b = sel.getBoundingClientRect();
    if (b.left < a.left + 32) el.scrollLeft -= a.left - b.left + 40; else if (b.right > a.right - 32) el.scrollLeft += b.right - a.right + 40;
  };
  el.addEventListener("scroll", upd, { passive: true });
  el.addEventListener("wheel", e => {
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || el.scrollWidth <= el.clientWidth) return;
    e.preventDefault(); el.scrollLeft += e.deltaY;
  }, { passive: false });
  new ResizeObserver(upd).observe(el);
  new MutationObserver(() => { reveal(); upd(); }).observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-pressed"] });
  requestAnimationFrame(() => { reveal(); upd(); });
}
// las fichas de Pipedrive que no son colegios de la base (pd-lead-…, pd-org-…) van solo al índice, no a listas ni al mapa
export function patchSchool(s) { if (!s?.id) return; const cur = S.byId.get(s.id); if (cur) Object.assign(cur, s); else { if (!/^pd-(org|lead)-/.test(s.id)) S.schools.push(s); S.byId.set(s.id, s); } }

// ---------- API
let onUnauthorized = () => {};
export const setUnauthorized = fn => (onUnauthorized = fn);
export async function api(path, opts = {}) {
  const r = await fetch(path, { method: opts.body ? "POST" : "GET", headers: { "content-type": "application/json", "x-tz": TZ }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const j = await r.json().catch(() => ({}));
  // el servidor que respondió no tiene los clientes de World Dominion: hay que avisar que alguno puede aparecer para llamar
  const bd = r.headers.get("x-brain-down"); if (bd !== null) S.brainDown = bd === "1";
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
  chevL: '<path d="m15 18-6-6 6-6"/>',
  chevR: '<path d="m9 18 6-6-6-6"/>',
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
  plus: '<path d="M12 5v14M5 12h14"/>',
  deal: '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>',
  alert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>',
  flame: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.4-.5-2-1-3-1.1-2.1-.2-4 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.2.4-2.3 1-3.3.3 1.6 1.4 2.8 2.5 2.8Z"/>',
  chevDown: '<path d="m6 9 6 6 6-6"/>',
  move: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  building: '<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M9 22v-4h6v4M8 6h.01M16 6h.01M12 6h.01M12 10h.01M12 14h.01M16 10h.01M16 14h.01M8 10h.01M8 14h.01"/>',
  bolt: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8Z"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  archive: '<rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8M10 12h4"/>',
  chart: '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M18 17V9M13 17V5M8 17v-3"/>',
};
export const icon = (n, cls = "") => `<svg class="ico ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[n] || ""}</svg>`;
export function hydrateIcons(root = document) { root.querySelectorAll("[data-icon]").forEach(e => { if (!e.firstChild) e.innerHTML = icon(e.dataset.icon); }); }
// Demos: una ya vencida (fecha y hora locales) pregunta «¿Se hizo la demo?»; el resultado sale de Pipedrive (sin marca: «?»)
export const demoDue = (l, now = new Date()) => { const t = today(); return l.date < t || (l.date === t && (!l.time || l.time <= now.toTimeString().slice(0, 5))); };
export const DEMO_RES = { done: "Se hizo", noshow: "No-show", moved: "Reprogramada", canceled: "Cancelada" };
export const TYPE_ICON = { call: "phone", meeting: "video", deadline: "whatsapp", task: "mail", contacto_decisor: "user" };

// ---------- estados de colegio
// c: variable CSS del color de la marca en el mapa (styles.css, claro y oscuro). sh: forma en el mapa y en el puntito de la pastilla:
// c = círculo (prospecto), q = cuadrado (trato en proceso), d = rombo (cliente), dr = rombo hueco (churn: era cliente),
// ring = aro hueco (sin revisar), x = cruz chica (archivado: descartado, no se llama).
export const ST = {
  new: { l: "Nunca contactado", c: "--st-new", sh: "c" }, org: { l: "En Pipe sin trato", c: "--st-org", sh: "c" },
  lead: { l: "Prospecto en Pipe", c: "--st-org", sh: "c" }, churn: { l: "Churn", c: "--st-churn", sh: "dr" }, lost: { l: "Perdido", c: "--st-lost", sh: "c" }, stalled: { l: "Contactado sin avance", c: "--st-stalled", sh: "c" }, open: { l: "En proceso", c: "--st-open", sh: "q" },
  client: { l: "Cliente", c: "--st-client", sh: "d" }, unk: { l: "Sin revisar", c: "--st-unk", sh: "ring" },
  // reservado: el estado «archivado» todavía no existe en el servidor; ya tiene color (gris) y forma propia (cruz chica)
  archived: { l: "Archivado", c: "--st-archived", sh: "x" },
};
export const cssVar = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
export const pill = st => `<span class="pill ${st}">${ST[st]?.l || st}</span>`;
// Fase comercial (World Dominion o Pipedrive): pisa a la pastilla de estado porque dice más.
// Clientes (activo, onboarding, cerrado) van en rombo, como los sitios de World Dominion; churn en rombo hueco (ya no es cliente:
// así no se confunde con «Activo» aunque se vean parecidos con daltonismo); la propuesta enviada es un trato: cuadrado.
export const PH = {
  activo: { l: "Activo", c: "--ph-activo", sh: "d" }, onboarding: { l: "Onboarding", c: "--ph-onboarding", sh: "d" }, cerrado: { l: "Cerrado", c: "--ph-cerrado", sh: "d" },
  churn: { l: "Churn", c: "--ph-churn", sh: "dr" }, propuesta: { l: "Propuesta enviada", c: "--ph-propuesta", sh: "q" },
};
export const statusPill = s => s?.phase && PH[s.phase] ? `<span class="pill ph-${s.phase}">${s.phase === "churn" && s.ob?.label ? s.ob.label : PH[s.phase].l}</span>` : pill(s?.status);
// etiqueta chica de dónde está en Pipedrive: «Prospecto» (tiene prospecto abierto) o «Trato» (tiene trato abierto)
// distintivo «Alto potencial» (datos reales del colegio; los motivos van al pasar el mouse)
export const potTag = s => s?.pot?.length ? `<span class="pot-tag" title="${esc("Alto potencial: " + s.pot.join(" · "))}">${icon("flame", "sm")} Alto potencial</span>` : "";
export const stageTag = s => s?.status === "open" ? `<span class="stage-tag deal" title="Tiene un trato abierto en Pipedrive">Trato</span>` : s?.lead ? `<span class="stage-tag lead" title="Tiene un prospecto abierto en Pipedrive">Prospecto</span>` : "";
// archivado en la app: fuera de sesiones y de la bandeja caliente. Las actividades lo traen del servidor (archived: también las
// fichas de Pipedrive que no están en la base); el resto, por el colegio cargado (S.byId).
export const archivedRef = id => !!id && S.byId.get(String(id).replace(/^(lead|org):/, "pd-$1-"))?.status === "archived";
export const archivedAct = a => !!a?.archived || archivedRef(a?.schoolId || a?.record);
// cómo se pinta un colegio en el mapa: la fase manda sobre el estado. Devuelve { k, l, c, sh } (k: clave para la leyenda)
export const markOf = s => s?.phase && PH[s.phase] ? { k: "ph-" + s.phase, ...PH[s.phase] } : { k: ST[s?.status] ? s.status : "unk", ...(ST[s?.status] || ST.unk) };
export const dotColor = (s, colors) => colors[markOf(s).k];

// ---------- fechas
const fmtDay = new Intl.DateTimeFormat("es", { weekday: "long", day: "numeric", month: "long" });
const fmtShort = new Intl.DateTimeFormat("es", { weekday: "short", day: "numeric", month: "short" });
// ---------- zona y evento de una actividad (el servidor manda city, region, country y event, solo si Pipedrive o la base los dicen)
export const actZones = a => [a.event && ["e", a.event], a.city && ["c", a.city], a.region && ["r", a.region], a.country && ["p", a.country]].filter(Boolean);
export const zoneKey = (k, v) => `${k}:${norm(v)}`;
export const ZONE_KIND = { e: "Eventos", c: "Ciudades", r: "Estados y provincias", p: "Países" };
// z: una clave de la lista («c:puebla») o texto libre. El texto se compara por palabras con el evento, la ciudad, el estado y el país
// («Puebla» encuentra «Puebla de Zaragoza»). El nombre solo cuenta si la actividad no tiene zona, o con loose (el buscador).
const hasWords = (v, q) => ` ${norm(v)} `.includes(` ${q} `);
export function matchZone(a, z, { loose = false } = {}) {
  if (!z) return true;
  if (/^[ecrp]:/.test(z)) return actZones(a).some(([k, v]) => zoneKey(k, v) === z);
  const q = norm(z); if (!q) return true;
  const sch = a.schoolId && S.byId.get(a.schoolId), zone = [a.event, a.city, a.region, a.country, sch?.city].filter(Boolean);
  if (zone.some(v => hasWords(v, q))) return true;
  return (loose || !a.event && !a.city) && [a.who, a.subject, sch?.name].some(v => loose ? norm(v).includes(q) : hasWords(v, q));
}
// opciones de zona para elegir (los estados no van: los colegios de la base no traen ese dato y quedarían afuera)
export function zoneOptions(items) {
  const m = new Map();
  for (const a of items) for (const [k, v] of actZones(a)) { if (k === "r") continue; const key = zoneKey(k, v); const o = m.get(key) || { key, k, label: v, n: 0 }; o.n++; m.set(key, o); }
  return [...m.values()].sort((a, b) => b.n - a.n || a.label.localeCompare(b.label));
}
// Orden para trabajar: primero lo de hoy (por hora), después lo vencido (lo más reciente primero) y al final lo que viene.
export function workOrder(acts, t = today()) {
  const k = a => a.date + (a.time || "99:99");
  return [...acts.filter(a => a.date === t).sort((a, b) => k(a).localeCompare(k(b))),
    ...acts.filter(a => a.date < t).sort((a, b) => k(b).localeCompare(k(a))),
    ...acts.filter(a => a.date > t).sort((a, b) => k(a).localeCompare(k(b)))];
}
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
// Bandeja caliente de Hoy: tus demos de hoy y mañana sin hacer (de tu agenda) y los prospectos nuevos para vos (/api/hot).
// Cada fila dice por qué está. Si una demo y un prospecto son de la misma ficha, queda la demo.
export const agoText = (iso, now = Date.now()) => { const m = Math.max(1, Math.round((now - Date.parse(iso)) / 60e3)), h = Math.round(m / 60), d = Math.round(m / 1440); return m < 60 ? `${m} min` : m < 1440 ? `${h} h` : `${d} ${d === 1 ? "día" : "días"}`; };
export function hotRows(acts = [], leads = [], t = today(), now = Date.now()) {
  const tm = addDays(t, 1), demos = acts.filter(a => a.type === "meeting").map(a => ({ ...a, ...localAct(a) })).filter(a => a.date === t || a.date === tm).sort((a, b) => (a.date + (a.time || "99")).localeCompare(b.date + (b.time || "99")))
    .map(a => ({ kind: "demo", id: a.id, schoolId: a.schoolId || null, record: a.schoolId ? null : a.record || null, url: a.url || "", title: a.who || a.subject, why: `Demo ${a.date === t ? "hoy" : "mañana"}${a.time ? ` ${a.time}` : ""}`, city: a.city || "", event: a.event || "" }));
  const seen = new Set(demos.map(d => d.schoolId || d.record).filter(Boolean));
  return [...demos, ...leads.filter(l => !seen.has(l.schoolId || l.record)).map(l => ({ kind: "lead", id: l.id, schoolId: l.schoolId || null, record: l.schoolId ? null : l.record, title: l.title, why: `${l.assigned ? "A tu nombre · creado" : "Lo creaste"} hace ${agoText(l.addTime, now)}`, event: l.event || "" }))];
}
// Horario de llamada («llamar a la hora en que atienden»): con la ventana de oficina del país (S.markets[país].horario, en hora
// local del colegio, lunes a viernes) dice si ahora es horario de oficina o cuándo abre. local: la hora allá, solo si es otro huso que el tuyo.
// s: { country, city, lng }. En un país con varios husos (husos/husoLng) sin saber el de la ciudad, null: no se afirma nada.
const WD = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"], hh = t => t.replace(/^0/, "");
const clock = (tz, now) => Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now).map(x => [x.type, x.value]));
export function tzOf(s) {
  const m = S.markets[s?.country]; if (!m?.tz) return null; if (!m.husos) return m.tz;
  const c = norm(s.city), hit = c && Object.entries(m.husos).find(([, l]) => l.some(x => norm(x) === c));
  if (hit) return hit[0];
  return typeof s.lng === "number" && s.lng >= m.husoLng[0] && s.lng <= m.husoLng[1] ? m.tz : null;
}
export function callWindow(s, now = new Date()) {
  const m = S.markets[s?.country], tz = tzOf(s); if (!tz || !m.horario?.length) return null;
  let c; try { c = clock(tz, now); } catch { return null; }
  const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(c.weekday), hm = `${c.hour}:${c.minute}`, days = m.dias || [1, 2, 3, 4, 5], me = clock(TZ, now);
  const local = me.weekday + me.hour + me.minute === c.weekday + c.hour + c.minute ? "" : `allá son las ${hh(hm)}`, span = m.horario.map(([a, b]) => `${hh(a)} a ${hh(b)}`).join(" y ");
  const r = (ok, label) => ({ ok, label, local, span });
  if (days.includes(dow)) { if (m.horario.some(([a, b]) => hm >= a && hm < b)) return r(true, "en horario de oficina"); const nx = m.horario.find(([a]) => hm < a); if (nx) return r(false, `oficina abre ${hh(nx[0])}`); }
  for (let i = 1; i <= 7; i++) { const d = (dow + i) % 7; if (days.includes(d)) return r(false, `oficina abre ${i === 1 ? "mañana" : `el ${WD[d]}`} ${hh(m.horario[0][0])}`); }
  return null;
}
export const callPill = s => { const w = callWindow(s); return w ? `<span class="cw ${w.ok ? "ok" : ""}" title="Horario habitual de oficina escolar en ${esc(s.country)} (no es un dato del colegio), hora local: ${esc(w.span)}">${icon("clock", "sm")}${esc([w.label, w.local].filter(Boolean).join(" · "))}</span>` : ""; };
// La cola de Hoy en el orden en que se muestra y se llama: los nuevos (primero los que están en horario de oficina, orden estable) y después los de reactivar
export const callQueue = (queue, now = new Date()) => { const rv = q => q.status === "lost" || q.status === "stalled", off = q => callWindow(q, now)?.ok ? 0 : 1; return [...queue.filter(q => !rv(q)).sort((a, b) => off(a) - off(b)), ...queue.filter(rv)]; };
// «Registrar en 10 segundos»: cuánto tardó en volver a la app después de tocar Llamar (no es la duración exacta de la llamada). Menos de 25 s casi siempre es que no atendieron:
// se preselecciona «No atendió» (el SDR confirma). Más de una hora no se muestra: es tiempo fuera de la app, no la llamada.
export const SHORT_CALL_S = 25;
export function callGuess(ms) {
  const s = Math.round(ms / 1000);
  if (!(s >= 0) || s > 3600) return null;
  if (s < SHORT_CALL_S) return { outcome: "no_answer", channel: "call", note: `Volviste a los ${s} s: marqué No atendió. Cambialo si no fue así.` };
  return { note: `Volviste a los ${s < 60 ? `${s} s` : `${Math.round(s / 60)} min`}` };
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
// Tesela de World Imagery que contiene al colegio (si el export falla, esta suele andar igual).
export function satTile(s, z = 17) {
  const n = 2 ** z, r = s.lat * Math.PI / 180;
  return `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n)}/${Math.floor((s.lng + 180) / 360 * n)}`;
}
// Copia vieja de World Dominion (OrderBrain no respondió y se usan los últimos datos que hay): se avisa con su fecha.
export function brainStaleMsg() {
  const b = S.brain; if (!b?.stale || b.down || S.brainDown) return "";
  const d = b.updatedAt ? new Date(b.updatedAt) : null, ok = d && !isNaN(d);
  if (ok && Date.now() - d.getTime() < 864e5) return ""; // copia de menos de un día: los clientes están al día, no hace falta avisar
  const when = !ok ? "" : d.toLocaleDateString("sv") === today() ? ` de hoy a las ${d.toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" })}` : ` al ${d.getDate()}/${d.getMonth() + 1}`;
  // si es porque OrderBrain rechazó el token, quién lo arregla (a los líderes se lo dice brainTokenMsg)
  const fix = b.auth && !b.token ? " Un líder tiene que cargar un token nuevo en Equipo." : "";
  return `Clientes de World Dominion${when || " de una copia guardada"}: puede faltar alguno nuevo. Revisá en Pipedrive antes de llamar.${fix}`;
}
// Aviso del token de World Dominion para líderes (/api/brain lo manda en token solo a ellos): [tipo, texto] o null
export function brainTokenMsg() {
  const t = S.brain?.token; if (!t) return null;
  if (t.missing) return ["warn", "Falta el token de World Dominion: la app no sabe qué colegios ya son clientes. Cargalo en Equipo."];
  if (t.rejected) return ["err", "World Dominion rechazó el token: cargá uno nuevo en Equipo."];
  if (t.expiry === "expired") return ["err", "El token de World Dominion venció: cargá uno nuevo en Equipo."];
  const h = (new Date(t.exp) - Date.now()) / 36e5, d = Math.round(h / 24);
  return ["warn", `El token de World Dominion vence ${h < 1 ? "en menos de una hora" : h < 24 ? `en ${Math.round(h)} h` : `en ${d} día${d === 1 ? "" : "s"}`}: cargá uno nuevo en Equipo.`];
}
export const brainTokenCallout = (style = "margin-bottom:16px") => {
  const m = brainTokenMsg(); if (!m) return "";
  return `<div class="callout ${m[0]}" style="${style}">${icon("alert")}<span>${esc(m[1])} <a href="#/equipo">Ir a Equipo</a></span></div>`;
};
export const mapsSearch = s => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(s.name + " " + s.city)}`;

// ---------- piezas de interfaz
// Último «Deshacer» disponible: también se usa con Ctrl+Z mientras el aviso está visible.
export let lastUndo = null;
export function toast(msg, { type = "", action, href, ms } = {}) {
  const t = document.createElement("div"); t.className = "toast " + type; t.setAttribute("role", type === "err" ? "alert" : "status");
  const ic = type === "err" ? "alert" : type === "info" ? "clock" : "checkCircle";
  t.innerHTML = `${icon(ic)}<span>${esc(msg)}</span>${href ? `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(action || "Abrir")}</a>` : action ? `<button data-act>${esc(action.label)}${action.label === "Deshacer" ? '<span class="kbd-hint"> (Ctrl Z)</span>' : ""}</button>` : ""}<button class="x" aria-label="Cerrar aviso">×</button>`;
  const remove = () => { t.remove(); if (lastUndo?.el === t) lastUndo = null; };
  if (action?.fn) { t.querySelector("[data-act]").onclick = () => { action.fn(); remove(); }; if (action.label === "Deshacer") lastUndo = { el: t, fn: () => { action.fn(); remove(); } }; }
  t.querySelector(".x").onclick = remove;
  $("toasts").appendChild(t);
  // los errores y los avisos con acción duran más; se pausan mientras el mouse o el foco están encima
  const total = ms || (type === "err" ? 9000 : action ? 8000 : 4200);
  let left = total, start = Date.now(), timer = setTimeout(remove, left);
  const pause = () => { clearTimeout(timer); left -= Date.now() - start; };
  const resume = () => { start = Date.now(); clearTimeout(timer); timer = setTimeout(remove, Math.max(left, 1500)); };
  t.addEventListener("mouseenter", pause); t.addEventListener("mouseleave", resume);
  t.addEventListener("focusin", pause); t.addEventListener("focusout", resume);
  return t;
}
export async function copy(text) { try { await navigator.clipboard.writeText(text); toast("Copiado"); } catch { toast("No se pudo copiar", { type: "err" }); } }

let menuEl = null;
export function closeMenu() { menuEl?.remove(); menuEl = null; document.removeEventListener("pointerdown", outside, true); }
function outside(e) { if (menuEl && !menuEl.contains(e.target)) closeMenu(); }
// Menú flotante anclado a un botón. items: [{ head } | { label, sub, fn }]
export function openMenu(anchor, items) {
  closeMenu();
  menuEl = document.createElement("div"); menuEl.className = "menu"; menuEl.setAttribute("role", "menu");
  menuEl.innerHTML = items.map((it, i) => it.head ? `<div class="mh ${it.cls || ""}">${esc(it.head)}</div>` : `<button role="menuitem" data-i="${i}"><b>${esc(it.label)}</b>${it.sub ? `<small>${esc(it.sub)}</small>` : ""}</button>`).join("");
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
// locked: no se cierra con Esc ni tocando afuera (por ejemplo, el perfil obligatorio de la primera vez)
export function modal(html, { onClose, locked = false } = {}) {
  const m = document.createElement("div"); m.className = "modal"; m.setAttribute("role", "dialog"); m.setAttribute("aria-modal", "true");
  m.innerHTML = `<div class="modal-box">${html}</div>`;
  const close = () => { m.remove(); document.removeEventListener("keydown", key); onClose?.(); };
  // Esc cierra el modal, salvo que la búsqueda esté abierta encima
  const key = e => { if (!locked && e.key === "Escape" && document.getElementById("palette").hidden) { e.stopPropagation(); close(); } };
  m.addEventListener("pointerdown", e => { if (!locked && e.target === m) close(); });
  document.addEventListener("keydown", key);
  document.body.appendChild(m);
  m.close = close;
  setTimeout(() => m.querySelector("textarea, input, button")?.focus());
  return m;
}
