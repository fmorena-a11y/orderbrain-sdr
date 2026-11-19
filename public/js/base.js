// Cargar base: la planilla de un evento (link de Google Sheets, archivo CSV o Excel, o pegada) → columnas detectadas (se
// corrigen) → instituciones con sus contactos → cruce con Pipedrive (las reglas de «Antes de crear», en tandas) → «Trabajar
// esta base» (sesión con lo tuyo o libre, por prioridad). Servidor: lib/bases.js y lib/bases-api.js.
// #/base: cargar y «Bases cargadas». #/base/<id>: una base.
import { S, api, esc, icon, toast, modal, telLink, TZ, ago, fmtNum, emptyState } from "./core.js";
import { openSchool, openRecord, startSession } from "./school.js";
import { connectGoogle } from "./google.js";

let host = null;
// fix: «Corregir» abierto (los selectores de columnas y la fila del encabezado); cerrado, solo el resumen de lo detectado
const st = { draft: null, tab: 0, header: null, map: null, event: "", country: "", city: "", prev: null, prevErr: "", loading: "", err: null, base: null, filter: "work", checking: false, pause: false, list: null, demoUrl: "", open: new Set(), fix: false };
const fmt = n => fmtNum(n);
const MAIN = ["inst", "name", "role", "phone", "email", "city", "students", "type", "pd"];
const MORE = ["pdPerson", "contacted", "others", "count", "prio", "notes", "next"];
// los mismos nombres que lib/import.js (FIELDS)
const FIELDS = { inst: "Institución", name: "Nombre de la persona", role: "Cargo o rol", phone: "Teléfono", email: "Email", city: "Ciudad o zona", students: "Cantidad de alumnos",
  type: "Tipo (público o privado)", pd: "Link de Pipedrive", pdPerson: "Persona en Pipedrive", contacted: "Contactado", others: "Otros contactos", count: "Inscriptos", prio: "Prioridad", notes: "Notas", next: "Próximo paso" };
// nombres cortos para el resumen «Detecté 7 columnas: Institución, Contacto, Teléfono…»
const SHORT = { inst: "Institución", name: "Contacto", role: "Cargo", phone: "Teléfono", email: "Email", city: "Ciudad", students: "Alumnos", type: "Tipo", pd: "Link de Pipedrive",
  pdPerson: "Persona en Pipedrive", contacted: "Contactado", others: "Otros contactos", count: "Inscriptos", prio: "Prioridad", notes: "Notas", next: "Próximo paso" };
const normTxt = v => String(v || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
const sameCity = (a, b) => !!a && !!b && normTxt(a) === normTxt(b);
const listY = l => l.length < 2 ? l.join("") : `${l.slice(0, -1).join(", ")} y ${l.at(-1)}`;
const col = j => { let s = "", n = j + 1; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
const idOfHash = () => (location.hash.match(/^#\/base\/([0-9a-f]{12})/) || [])[1] || null;
const page = body => `<div class="page read base-page"><div class="page-head"><div><h1>Cargar base</h1><p>Pegá el link de la planilla del evento y trabajala como una sesión: agrupa por colegio, revisa en Pipedrive y deja afuera lo que no se contacta.</p></div></div>${body}</div>`;

export async function renderBase(el) {
  host = el;
  const id = idOfHash();
  if (id) return openBase(id);
  st.base = null;
  draw();
  if (S.demo && !st.demoUrl) api("/api/bases/demo").then(r => { st.demoUrl = r.url || ""; if (host?.isConnected && !st.draft) draw(); }).catch(() => {});
  loadList();
}
async function loadList() {
  try { st.list = await api("/api/bases"); } catch (e) { st.list = { err: e.message }; }
  if (host?.isConnected && !idOfHash()) drawList();
}
function draw() {
  if (!host?.isConnected) return;
  host.innerHTML = page(`<div class="stack base-stack">${loadCard()}<div id="bxDraft">${draftCard()}</div><section class="card" aria-labelledby="hBl"><div class="card-h"><h2 id="hBl">${icon("list")} Bases cargadas</h2></div><div class="card-b" id="bxList">${listHtml()}</div></section></div>`);
  bindLoad(); bindDraft(); bindList();
}
const drawList = () => { const l = host?.querySelector("#bxList"); if (l) { l.innerHTML = listHtml(); bindList(); } };

// ---------- 1) cargar: link, archivo o pegar
function errHtml(e) {
  if (!e) return "";
  if (e.code === "sheet_private") return `<div class="callout warn bx-err" role="alert">${icon("lock")}<div><b>${esc(e.message)}</b><ol class="bx-ways">${S.gmail?.enabled && S.gmail.google && !S.gmail.google.perms?.sheets ? `<li><button class="linkbtn" data-goo>Conectá tu Google</button> (con el permiso de planillas) y cargala de nuevo: la leo con tu cuenta.</li>` : ""}<li>Compartila como <b>«Cualquier persona con el enlace – Lector»</b> y cargala de nuevo.</li><li>O descargala (<b>Archivo › Descargar › CSV o Excel</b>) y <button class="linkbtn" data-up>subila acá</button>.</li></ol></div></div>`;
  return `<div class="callout err bx-err" role="alert">${icon("alert")}<span>${esc(e.message)}</span></div>`;
}
function loadCard() {
  const busy = !!st.loading;
  return `<section class="card" aria-labelledby="hBx"><div class="card-h"><h2 id="hBx">${icon("upload")} Cargar una planilla</h2></div><div class="card-b stack" style="gap:12px">
    <form id="bxForm" class="bx-link"><label class="field" style="flex:1"><span>Link de Google Sheets</span><input class="inp" id="bxUrl" type="url" inputmode="url" autocomplete="off" placeholder="https://docs.google.com/spreadsheets/d/…" ${busy ? "disabled" : ""}></label>
      <button class="btn primary" id="bxGo" ${busy ? "disabled" : ""}>${st.loading === "link" ? `<span class="spin"></span> Leyendo…` : "Cargar"}</button></form>
    <div class="bx-or"><span class="faint">o</span><button class="btn sm" data-up ${busy ? "disabled" : ""}>${st.loading === "file" ? `<span class="spin"></span> Leyendo…` : `${icon("upload", "sm")} Subir CSV o Excel`}</button><button class="btn sm" id="bxPaste" ${busy ? "disabled" : ""}>${icon("copy", "sm")} Pegar desde la planilla</button>
      ${st.demoUrl ? `<button class="linkbtn" id="bxDemo">Probar con la planilla de ejemplo</button>` : ""}</div>
    <input type="file" id="bxFile" accept=".csv,.tsv,.txt,.xlsx,text/csv,text/plain,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden>
    ${errHtml(st.err)}
  </div></section>`;
}
async function rawPost(path, body, type, extra = {}) {
  const r = await fetch(path, { method: "POST", headers: { "content-type": type, "x-tz": TZ, ...extra }, body });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) { location.reload(); throw new Error("Iniciá sesión."); }
  if (!r.ok) throw Object.assign(new Error(j.error || `Error ${r.status}`), { status: r.status, code: j.code || "" });
  return j;
}
async function loadWith(kind, fn) {
  st.loading = kind; st.err = null; draw();
  try { const r = await fn(); gotDraft(r.draft); }
  catch (e) { st.err = { message: e.message, code: e.code || e.data?.code || "" }; st.loading = ""; draw(); }
}
function gotDraft(d) {
  Object.assign(st, { fix: false, draft: d, tab: d.pick, header: d.tabs[d.pick].header, map: { ...d.tabs[d.pick].map }, event: d.event || "", country: d.country || "", city: d.city || "", prev: null, prevErr: "", loading: "", err: null });
  draw(); preview();
  host?.querySelector("#bxDraft")?.scrollIntoView({ behavior: "smooth", block: "start" });
}
function bindLoad() {
  const f = host.querySelector("#bxForm");
  f.onsubmit = e => { e.preventDefault(); const url = host.querySelector("#bxUrl").value.trim(); if (!url) return host.querySelector("#bxUrl").focus(); st.lastUrl = url; loadWith("link", () => api("/api/bases/load", { body: { url } })); };
  const file = host.querySelector("#bxFile");
  host.querySelectorAll("[data-up]").forEach(b => b.onclick = () => file.click());
  // planilla privada: con tu Google conectado (permiso de planillas) se lee con tu cuenta
  host.querySelectorAll("[data-goo]").forEach(b => b.onclick = async () => { b.disabled = true; const g = await connectGoogle(), url = st.lastUrl; if (g?.google?.perms?.sheets && url && host?.isConnected) loadWith("link", () => api("/api/bases/load", { body: { url } })); else if (b.isConnected) b.disabled = false; });
  file.onchange = () => {
    const x = file.files?.[0]; if (!x) return;
    if (x.size > 8e6) { st.err = { message: "El archivo es muy grande (hasta 8 MB): descargá solo la pestaña que vas a trabajar." }; return draw(); }
    loadWith("file", () => rawPost("/api/bases/file", x, "application/octet-stream", { "x-file-name": encodeURIComponent(x.name) }));
  };
  host.querySelector("#bxPaste").onclick = pasteDialog;
  host.querySelector("#bxDemo")?.addEventListener("click", () => { host.querySelector("#bxUrl").value = st.demoUrl; loadWith("link", () => api("/api/bases/load", { body: { url: st.demoUrl } })); });
}
function pasteDialog() {
  const m = modal(`<h3>Pegar desde la planilla</h3>
    <p class="muted" style="margin:0">En la planilla, seleccioná las filas <b>con el encabezado</b>, copialas (Ctrl C) y pegalas acá.</p>
    <textarea class="inp" id="bxTxt" rows="8" aria-label="Filas copiadas de la planilla" placeholder="Nombre y apellido	Email	Teléfono	Institución…"></textarea>
    <div class="row"><button class="btn ghost" id="bxPx">Cancelar</button><button class="btn primary" id="bxPgo">Usar esto</button></div>`);
  m.querySelector("#bxPx").onclick = () => m.close();
  m.querySelector("#bxPgo").onclick = () => {
    const t = m.querySelector("#bxTxt").value; if (!t.trim()) return m.querySelector("#bxTxt").focus();
    m.close(); loadWith("paste", () => rawPost("/api/bases/paste", t, "text/plain;charset=utf-8"));
  };
}

// ---------- 2) pestaña, columnas y cómo queda
const VIA = { google: "con tu Google", public: "compartida con el enlace", demo: "planilla de ejemplo", xlsx: "Excel", csv: "CSV", paste: "pegada" };
function draftCard() {
  const d = st.draft; if (!d) return "";
  const t = d.tabs[st.tab], headers = st.prev?.headers || t.headers, samples = st.prev?.samples || [];
  const opts = f => `<option value="">—</option>${headers.map((h, j) => `<option value="${j}" ${st.map?.[f] === j ? "selected" : ""}>${esc(col(j))} · ${esc(h || "(sin título)")}</option>`).join("")}`;
  const row = f => { const j = st.map?.[f]; return `<label class="bx-col"><span class="bx-f">${esc(FIELDS[f] || f)}${f === "inst" ? ` <span class="req">obligatoria</span>` : ""}</span><select class="inp" data-col="${f}">${opts(f)}</select><small class="faint">${j != null && samples[j] ? `Ej.: ${esc(samples[j])}` : j == null ? "Sin columna" : ""}</small></label>`; };
  const p = st.prev, c = p?.counts, noInst = !!p && (p.need === "inst" || st.map?.inst == null);
  return `<section class="card" aria-labelledby="hBd"><div class="card-h"><h2 id="hBd">${icon("table")} ${esc(d.title || "Planilla")}</h2><span class="sub">${esc(VIA[d.source.via] || "")}</span></div><div class="card-b stack" style="gap:14px">
    ${d.tabs.length > 1 ? `<div class="field"><span>Pestaña</span><div class="chips" role="group" aria-label="Pestaña">${d.tabs.map(x => `<button class="chip" data-tab="${x.i}" aria-pressed="${x.i === st.tab}">${esc(x.name)} <b>${fmt(x.rows)}</b>${x.i === d.pick ? ` <span class="tag">sugerida</span>` : ""}</button>`).join("")}</div></div>` : ""}
    <div class="grid3 bx-ev"><label class="field"><span>Evento</span><input class="inp" id="bxEv" value="${esc(st.event)}" placeholder="Ej.: EduExperience Mendoza 2026"></label>
      <label class="field"><span>País</span><select class="inp" id="bxCo"><option value="">Elegí el país</option>${Object.keys(S.markets || {}).sort((a, b) => a.localeCompare(b, "es")).map(k => `<option ${k === st.country ? "selected" : ""}>${esc(k)}</option>`).join("")}</select></label>
      <label class="field"><span>Ciudad <span class="faint">si la fila no dice otra</span></span><input class="inp" id="bxCi" value="${esc(st.city)}" placeholder="Ej.: Mendoza"></label></div>
    <p class="faint bx-evhelp">El evento va al final del prospecto que se crea: «Colegio … (${esc(st.event || "Evento")})».</p>
    ${detectHtml(t)}
    ${st.fix || noInst ? `<div class="bx-fix" id="bxFixBox">
      <div class="field"><span>Encabezado</span><select class="inp bx-hsel" id="bxHead">${Array.from({ length: Math.min(25, Math.max(1, (st.prev?.header ?? t.header) + 6)) }, (_, i) => `<option value="${i}" ${i === (st.header ?? t.header) ? "selected" : ""}>Fila ${i + 1}${i === t.header ? " (detectada)" : ""}</option>`).join("")}</select></div>
      <div><p class="bx-sub"><b>Columnas</b> <span class="faint">corregí lo que haga falta: la vista de abajo se actualiza sola</span></p>
      <div class="bx-cols">${MAIN.map(row).join("")}</div>
      <details class="bx-more"${MORE.some(f => st.map?.[f] != null) ? " open" : ""}><summary>Más columnas</summary><div class="bx-cols">${MORE.map(row).join("")}</div></details></div>
      ${noInst ? "" : `<button type="button" class="btn sm ghost" id="bxFixDone">Listo</button>`}</div>` : ""}
    <div id="bxPrev">${prevHtml()}</div>
    <div class="row bx-save"><button class="btn ghost" id="bxCancel">Descartar</button><button class="btn primary" id="bxSave" ${!c || !c.institutions || !st.country ? "disabled" : ""}>${icon("check", "sm")} Guardar y revisar en Pipedrive</button></div>
    ${!st.country && c ? `<p class="faint" style="margin:0">Elegí el país: con él se normalizan los teléfonos y se busca en Pipedrive.</p>` : ""}
  </div></section>`;
}
// lo detectado, en una línea; «Corregir» abre los selectores (sin la columna de la institución se abren solos)
function detectHtml(t) {
  const got = [...MAIN, ...MORE].filter(f => st.map?.[f] != null), need = st.prev?.need === "inst" || (st.prev && st.map?.inst == null);
  const head = (st.header ?? t.header) !== t.header ? ` · encabezado en la fila ${(st.header ?? t.header) + 1}` : t.header ? ` · encabezado en la fila ${t.header + 1}` : "";
  const txt = !st.map ? "Leyendo las columnas…" : need ? "No encontré la columna con el nombre de la institución: elegila abajo."
    : `<b>Detecté ${got.length} ${got.length === 1 ? "columna" : "columnas"}:</b> ${esc(listY(got.map(f => SHORT[f] || f)))}${esc(head)}.`;
  return `<div class="bx-detect${need ? " warn" : ""}">${icon(need ? "alert" : "checkCircle", "sm")}<span>${txt}</span>${need || !st.map ? "" : `<button type="button" class="linkbtn" id="bxFix" aria-expanded="${st.fix}" aria-controls="bxFixBox">${st.fix ? "Ocultar columnas" : "Corregir"}</button>`}</div>`;
}
function prevHtml() {
  const p = st.prev;
  if (st.prevErr) return `<div class="callout err">${icon("alert")}<span>${esc(st.prevErr)}</span></div>`;
  if (!p) return `<div class="skel" style="height:60px"></div>`;
  if (p.need === "inst") return `<div class="callout warn">${icon("alert")}<span>Elegí qué columna tiene el nombre de la institución.</span></div>`;
  const c = p.counts;
  return `<div class="callout ok bx-sum">${icon("checkCircle")}<span><b>${fmt(c.institutions)} instituciones</b> · ${fmt(c.people)} personas${c.out ? ` · ${fmt(c.out)} afuera (públicos, universidades u oficinas)` : ""}${c.noInst ? ` · ${fmt(c.noInst)} filas sin institución` : ""}</span></div>
    <div class="bx-prev">${p.preview.map(x => `<div class="bx-pi"><span class="bx-score ${x.prio.level}" title="Prioridad ${esc(x.prio.level)}">${x.prio.score}</span><span class="t"><b>${esc(x.name)}</b><small>${esc([sameCity(x.city, st.city) ? "" : x.city, `${x.contacts} ${x.contacts === 1 ? "contacto" : "contactos"}`, x.students, x.decisor && `decide: ${x.decisor}`].filter(Boolean).join(" · "))}</small>${x.out ? `<span class="tag">${esc(x.out)}</span>` : ""}</span></div>`).join("")}</div>`;
}
let prevTimer = null, prevSeq = 0;
function preview() {
  clearTimeout(prevTimer);
  prevTimer = setTimeout(async () => {
    const my = ++prevSeq, d = st.draft; if (!d) return;
    try {
      const r = await api("/api/bases/preview", { body: { draft: d.id, tab: st.tab, header: st.header, map: st.map, country: st.country, city: st.city, event: st.event } });
      if (my !== prevSeq || st.draft !== d) return;
      st.prev = r; st.prevErr = ""; st.map = { ...r.map }; st.header = r.header;
    } catch (e) { if (my !== prevSeq) return; st.prevErr = e.message; if (e.code === "draft_gone") { st.draft = null; st.err = { message: e.message }; return draw(); } }
    redrawDraft();
  }, 250);
}
function redrawDraft() { const el = host?.querySelector("#bxDraft"); if (!el) return; const y = window.scrollY, m = host.closest("main")?.scrollTop; el.innerHTML = draftCard(); bindDraft(); if (m != null) host.closest("main").scrollTop = m; window.scrollTo(0, y); }
function bindDraft() {
  const el = host?.querySelector("#bxDraft"); if (!el || !st.draft) return;
  el.querySelectorAll("[data-tab]").forEach(b => b.onclick = () => { const t = st.draft.tabs[+b.dataset.tab]; Object.assign(st, { tab: t.i, header: t.header, map: { ...t.map }, prev: null }); redrawDraft(); preview(); });
  el.querySelectorAll("[data-col]").forEach(s => s.onchange = () => {
    const f = s.dataset.col, v = s.value === "" ? null : Number(s.value), map = { ...st.map };
    st.fix = true; // se está corrigiendo: los selectores quedan abiertos aunque ya esté la institución
    if (v != null) for (const k of Object.keys(map)) if (map[k] === v) delete map[k];
    if (v == null) delete map[f]; else map[f] = v;
    st.map = map; preview();
  });
  el.querySelector("#bxFix")?.addEventListener("click", () => { st.fix = !st.fix; redrawDraft(); el.querySelector(st.fix ? "#bxFixBox select" : "#bxFix")?.focus(); });
  el.querySelector("#bxFixDone")?.addEventListener("click", () => { st.fix = false; redrawDraft(); el.querySelector("#bxFix")?.focus(); });
  el.querySelector("#bxHead")?.addEventListener("change", e => { st.header = Number(e.target.value); st.map = null; st.prev = null; redrawDraft(); preview(); });
  el.querySelector("#bxEv").oninput = e => { st.event = e.target.value; const h = el.querySelector(".bx-evhelp"); if (h) h.textContent = `El evento va al final del prospecto que se crea: «Colegio … (${st.event || "Evento"})».`; };
  el.querySelector("#bxCo").onchange = e => { st.country = e.target.value; preview(); };
  el.querySelector("#bxCi").onchange = e => { st.city = e.target.value; preview(); };
  el.querySelector("#bxCancel").onclick = () => { st.draft = null; st.prev = null; draw(); };
  el.querySelector("#bxSave").onclick = async e => {
    const b = e.currentTarget; b.disabled = true; b.innerHTML = `<span class="spin"></span> Guardando…`;
    try {
      const r = await api("/api/bases", { body: { draft: st.draft.id, tab: st.tab, header: st.header, map: st.map, country: st.country, city: st.city, event: st.event } });
      st.draft = null; st.prev = null; st.base = r.base; st.filter = "work";
      toast(`Base «${r.base.event}» guardada: la reviso en Pipedrive`);
      location.hash = `#/base/${r.base.id}`;
    } catch (x) { toast(x.message, { type: "err" }); b.disabled = false; b.innerHTML = `${icon("check", "sm")} Guardar y revisar en Pipedrive`; }
  };
}

// ---------- bases cargadas
function listHtml() {
  const l = st.list;
  if (!l) return `<div class="skel" style="height:44px"></div>`;
  if (l.err) return `<div class="callout err">${icon("alert")}<span>No pude traer tus bases: ${esc(l.err)}</span></div>`;
  const row = (b, other) => `<div class="bx-row"><button class="t" data-open="${esc(b.id)}"><b>${esc(b.event)}</b><small>${esc([[b.city, b.country].filter(Boolean).join(", "), `${fmt(b.counts?.institutions)} instituciones`, `${fmt(b.counts?.checked)} revisadas`, other ? `de ${b.byName || b.by}` : "", `cargada ${ago(b.at)}`].filter(Boolean).join(" · "))}</small></button>
    <button class="icon-btn" data-del="${esc(b.id)}" data-name="${esc(b.event)}" aria-label="Borrar la base ${esc(b.event)}" title="Borrar">${icon("x")}</button></div>`;
  if (!l.mine.length && !l.team.length) return emptyState({ icon: "table", title: "Todavía no cargaste ninguna", text: "Pegá el link de la planilla arriba. Cada base dura 60 días." });
  return `${l.mine.map(b => row(b, false)).join("")}${l.team.length ? `<p class="bx-sub"><b>De tu gente</b></p>${l.team.map(b => row(b, true)).join("")}` : ""}<p class="faint" style="margin:8px 0 0;font-size:var(--fs-sm)">Cada base dura 60 días desde la última vez que se revisó.</p>`;
}
function bindList() {
  host?.querySelectorAll("[data-open]").forEach(b => b.onclick = () => { location.hash = `#/base/${b.dataset.open}`; });
  host?.querySelectorAll("[data-del]").forEach(b => b.onclick = () => {
    const m = modal(`<h3>¿Borrar «${esc(b.dataset.name)}»?</h3><p class="muted" style="margin:0">Se borra la base de la app. Lo que ya está en Pipedrive queda como está.</p><div class="row"><button class="btn ghost" id="dNo">Cancelar</button><button class="btn primary" id="dGo">Borrar</button></div>`);
    m.querySelector("#dNo").onclick = () => m.close();
    m.querySelector("#dGo").onclick = async () => { m.close(); try { await api(`/api/bases/${b.dataset.del}`, { method: "DELETE" }); toast("Base borrada"); loadList(); } catch (e) { toast(e.message, { type: "err" }); } };
  });
}

// ---------- 3) una base: cruce con Pipedrive, filtros y «Trabajar esta base»
async function openBase(id) {
  if (st.base?.id !== id) { st.base = null; st.filter = "work"; st.open = new Set(); }
  host.innerHTML = page(st.base ? baseHtml(st.base) : `<div class="card card-b">${'<div class="skel" style="margin:12px 0"></div>'.repeat(5)}</div>`);
  if (st.base) bindBase();
  try { const r = await api(`/api/bases/${id}`); if (idOfHash() !== id) return; st.base = r.base; }
  catch (e) { if (!host?.isConnected) return; host.innerHTML = page(`<div class="callout err">${icon("alert")}<span>${esc(e.message)}</span> <a class="btn sm" href="#/base">Volver</a></div>`); return; }
  drawBase(); runCheck();
}
const FILTERS = [["work", "Para trabajar"], ["all", "Todas"], ["other", "De otra persona"], ["client", "Clientes y ex clientes"], ["pending", "Sin revisar"], ["out", "Afuera"]];
const inFilter = (it, f) => f === "all" ? true : f === "out" ? !!it.out : it.out ? false : f === "work" ? it.st.workable : f === "other" ? it.st.key === "other" : f === "client" ? ["client", "churn"].includes(it.st.key) : f === "pending" ? ["pending", "err"].includes(it.st.key) : true;
const workItems = b => b.items.filter(it => !it.out && it.st.workable);
function baseHtml(b) {
  const c = b.counts, left = b.items.filter(it => !it.out && !it.x).length, done = c.total - left, work = workItems(b), counts = Object.fromEntries(FILTERS.map(([k]) => [k, b.items.filter(it => inFilter(it, k)).length]));
  const list = b.items.filter(it => inFilter(it, st.filter)), common = commonOf(list, b);
  return `<div class="stack base-stack">
    <section class="card bx-head"><div class="card-b" style="padding-top:16px"><div class="bx-hh"><div><h2>${esc(b.event)}</h2>
      <p class="muted">${esc([[b.city, b.country].filter(Boolean).join(", "), `${fmt(c.total)} instituciones`, `${fmt(c.people)} personas`, b.mine ? `cargada ${ago(b.at)}` : `de ${b.byName || b.by}`, b.source?.tab && `pestaña «${b.source.tab}»`].filter(Boolean).join(" · "))}${b.source?.url ? ` · <a href="${esc(b.source.url)}" target="_blank" rel="noopener">Abrir la planilla</a>` : ""}</p></div>
      <a class="btn sm ghost" href="#/base">${icon("arrowLeft", "sm")} Bases</a></div>
      ${left ? `<div class="bx-prog" role="status"><span>${st.checking ? `<span class="spin"></span> ` : ""}Revisando en Pipedrive: ${fmt(done)} de ${fmt(c.total)}</span><div class="bar"><span style="width:${c.total ? Math.max(3, done / c.total * 100) : 0}%;background:var(--accent)"></span></div>${st.checking ? `<button class="linkbtn" id="bxPause">Pausar</button>` : `<button class="linkbtn" id="bxResume">Seguir revisando</button>`}</div>` : `<p class="bx-ready">${icon("checkCircle", "sm")} Revisada en Pipedrive con las reglas de «Antes de crear».</p>`}
      <div class="bx-cta"><button class="btn primary lg" id="bxWork" ${work.length ? "" : "disabled"}>${icon("play")} Trabajar esta base${work.length ? ` (${fmt(work.length)})` : ""}</button>
        <span class="faint">${work.length ? `Solo lo tuyo o libre y que se puede contactar, por prioridad.${left ? " Las que faltan revisar se suman cuando termine." : ""}` : left ? "Esperá a que termine la revisión." : "No hay instituciones para trabajar."}</span></div>
    </div></section>
    <div class="chips bx-filters" role="group" aria-label="Filtrar">${FILTERS.map(([k, l]) => `<button class="chip" data-f="${k}" aria-pressed="${st.filter === k}">${l} <b>${fmt(counts[k])}</b></button>`).join("")}</div>
    ${common.line ? `<p class="bx-common">${icon("list", "sm")}<span>${esc(common.line)}</span></p>` : ""}
    <section class="card"><div class="card-b bx-items">${list.length ? list.map(it => itemHtml(it, common)).join("") : emptyState({ icon: st.filter === "work" && left ? "clock" : "list", title: st.filter === "work" && left ? "Todavía estoy revisando en Pipedrive" : "Nada con este filtro", text: st.filter === "work" && left ? "Las que se pueden trabajar aparecen acá a medida que las reviso." : "", action: st.filter === "all" ? null : { label: "Ver todas", attrs: 'data-f="all"' } })}</div></section>
  </div>`;
}
// Lo que es igual en todas las filas que se ven (la ciudad de la base, «Privado» en todas…) va una vez arriba de la lista y sale
// de cada fila. La ciudad de la base nunca se repite (ya está en el encabezado). Con una sola fila no hay nada «común».
function commonOf(list, b) {
  const city = list.length && list.every(it => sameCity(it.city, b.city)) ? b.city : "";
  const tags = list.length >= 2 ? (list[0].prio?.why || []).filter(w => list.every(it => (it.prio?.why || []).includes(w))) : [];
  const cityAll = !city && list.length >= 2 && list.every(it => it.city && sameCity(it.city, list[0].city)) ? list[0].city : "";
  const bits = [cityAll && `de ${cityAll}`, ...tags.map(t => t.toLowerCase() === "privado" ? "privadas" : t)].filter(Boolean);
  return { city: city || cityAll, tags: new Set(tags), line: list.length >= 2 && bits.length ? `Todas las de esta lista: ${bits.join(" · ")}.` : "" };
}
const TONE = { mine: "ok", free: "free", none: "free", maybe: "warn", other: "warn", client: "mute", churn: "mute", archived: "mute", pending: "mute", err: "mute" };
function itemHtml(it, common = { city: "", tags: new Set() }) {
  const open = st.open.has(it.n), top = it.contacts[0], baseCity = st.base?.city;
  // sin repetir: la ciudad de la base o la común, los alumnos (ya en el renglón), quién decide (ya en el renglón) y lo común a todas.
  // Todos los motivos de la prioridad siguen en el número (al pasar el mouse).
  const tags = it.prio.why.filter(w => !common.tags.has(w) && w !== it.students && !(top?.decisor && /^Se inscribió quien decide/.test(w)));
  return `<div class="bx-it${it.out ? " out" : ""}">
    <div class="bx-ih"><span class="bx-score ${it.prio.level}" title="Prioridad ${esc(it.prio.level)}: ${esc(it.prio.why.join(", ") || "sin datos")}" aria-label="Prioridad ${esc(it.prio.level)}">${it.prio.score}</span>
      <button class="t" data-go="${it.n}"><b>${esc(it.name)}</b><small>${esc([sameCity(it.city, baseCity) || sameCity(it.city, common.city) ? "" : it.city, `${it.contacts.length} ${it.contacts.length === 1 ? "contacto" : "contactos"}`, common.tags.has(it.students) ? "" : it.students, top?.decisor ? `${top.name}${top.role ? ` (${top.role})` : ""} decide` : ""].filter(Boolean).join(" · "))}</small></button>
      <button class="icon-btn" data-more="${it.n}" aria-expanded="${open}" aria-label="${open ? "Ocultar" : "Ver"} contactos de ${esc(it.name)}">${icon("chevDown")}</button></div>
    <div class="bx-tags">${it.out ? `<span class="bx-st mute">${esc(it.out)}</span>` : `<span class="bx-st ${TONE[it.st.key] || "mute"}">${esc(it.st.label)}</span>`}${it.x?.url ? `<a class="tag" href="${esc(it.x.url)}" target="_blank" rel="noopener">Abrir en Pipedrive ${icon("external", "sm")}</a>` : ""}${tags.slice(0, 3).map(w => `<span class="tag">${esc(w)}</span>`).join("")}${it.inApp ? `<span class="tag">en la base de colegios</span>` : ""}</div>
    ${it.x?.maybe?.length ? `<p class="faint bx-note">Parecido: ${esc(it.x.maybe.map(m => `${m.title} (${m.what}${m.owner ? `, de ${m.owner}` : ""})`).join(" · "))}</p>` : ""}
    ${it.x?.why && it.st.key !== "client" ? `<p class="faint bx-note">${esc(it.x.why)}</p>` : ""}
    ${open ? `<div class="bx-cs">${it.contacts.map(contactHtml).join("") || `<span class="faint">Sin contactos en la planilla.</span>`}${it.notes ? `<p class="bx-note"><b>Notas:</b> ${esc(it.notes)}</p>` : ""}${it.next ? `<p class="bx-note"><b>Próximo paso:</b> ${esc(it.next)}</p>` : ""}</div>` : ""}
  </div>`;
}
const waHref = p => `https://wa.me/${String(p).replace(/\D/g, "")}`;
function contactHtml(c) {
  return `<div class="bx-c"><span class="t"><b>${esc(c.name || "Sin nombre")}</b>${c.role ? ` <span class="faint">${esc(c.role)}</span>` : ""}${c.decisor ? ` <span class="tag">decide</span>` : ""}</span>
    <span class="bx-cl">${c.phone ? `<a href="${esc(telLink(c.phone))}">${icon("phone", "sm")} ${esc(c.phone)}</a><a href="${esc(waHref(c.phone))}" target="_blank" rel="noopener">${icon("whatsapp", "sm")} WhatsApp</a>` : ""}${c.email ? `<a href="mailto:${esc(c.email)}">${icon("mail", "sm")} ${esc(c.email)}</a>` : ""}</span></div>`;
}
function drawBase() {
  if (!host?.isConnected || !st.base || idOfHash() !== st.base.id) return;
  const main = host.closest("main"), y = main?.scrollTop;
  host.innerHTML = page(baseHtml(st.base)); bindBase();
  if (main && y != null) main.scrollTop = y;
}
function bindBase() {
  const b = st.base;
  host.querySelectorAll("[data-f]").forEach(x => x.onclick = () => { st.filter = x.dataset.f; drawBase(); });
  host.querySelectorAll("[data-more]").forEach(x => x.onclick = () => { const n = +x.dataset.more; st.open.has(n) ? st.open.delete(n) : st.open.add(n); drawBase(); });
  host.querySelectorAll("[data-go]").forEach(x => x.onclick = () => { const it = b.items.find(i => i.n === +x.dataset.go); if (it) openItem(it); });
  host.querySelector("#bxPause")?.addEventListener("click", () => { st.pause = true; });
  host.querySelector("#bxResume")?.addEventListener("click", () => runCheck());
  host.querySelector("#bxWork")?.addEventListener("click", () => {
    const list = workItems(b);
    startSession(list.map(it => ({ ref: it.ref, name: it.name, city: it.city })), b.event, { origin: { kind: "base", key: `base:${b.id}`, filters: { evento: b.event } } });
  });
}
const openItem = it => /^(lead|org|bx):/.test(it.ref) ? openRecord(it.ref) : S.byId.has(it.ref) ? openSchool(it.ref) : openRecord(`bx:${String(it.sid || "").replace(/^bx-/, "")}`);
async function runCheck() {
  const b = st.base; if (!b || st.checking) return;
  st.checking = true; st.pause = false; drawBase();
  let fails = 0;
  try {
    while (st.base === b && !st.pause && b.items.some(it => !it.out && !it.x)) {
      let r;
      try { r = await api(`/api/bases/${b.id}/check`, { body: { n: 6 } }); fails = 0; }
      catch (e) { if (++fails >= 3 || e.status === 403 || e.status === 404) { toast(`No pude seguir revisando en Pipedrive: ${e.message}`, { type: "err" }); break; } await new Promise(ok => setTimeout(ok, 1500)); continue; }
      for (const x of r.items) { const i = b.items.findIndex(y => y.n === x.n); if (i >= 0) b.items[i] = x; }
      b.counts.workable = workItems(b).length;
      if (!r.items.length) break;
      drawBase();
    }
  } finally { st.checking = false; if (st.base === b) drawBase(); }
}
