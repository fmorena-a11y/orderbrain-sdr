// Ficha del colegio: preparar el contacto, registrar el resultado e historial. Incluye el modo sesión.
import { $, S, api, esc, icon, pill, toast, copy, openMenu, modal, patchSchool, today, addDays, nextBusinessDay, shortDay, dayLabel, localAct, ago, TYPE_ICON,
  telLink, waLink, gmailLink, gcalLink, mapsDir, mapsSearch, initials, satLink } from "./core.js";

const D = { id: null, data: null, tab: "prep", form: null, activityId: null, saving: false, result: null, brief: null, briefLoading: false, err: null, photos: null };
const CH = [["call", "Llamada", "phone"], ["whatsapp", "WhatsApp", "whatsapp"], ["mail", "Mail", "mail"], ["visit", "Visita", "user"]];
const NEXT_TYPES = [["", "Sin próximo paso"], ["call", "Llamada"], ["deadline", "WhatsApp"], ["task", "Mail"]];
const GOOD = ["callback", "info", "demo"];
const CONNECTED = ["gatekeeper", "callback", "info", "demo", "not_now", "not_interested"];
const QUALIFY = ["callback", "info", "demo", "not_now"];
const QUICK = ["Cafetería concesionada", "Cafetería propia", "Ya usan otro sistema", "Pidió que mande mail", "Llamar en otro horario", "Habló el director", "Decisor de vacaciones"];
const NIVELES = ["Preescolar", "Primaria", "Secundaria", "Prepa", "Universidad"];

export const drawerOpen = () => !$("drawer").hidden;
export const currentSchoolId = () => (drawerOpen() ? D.id : null);
const newForm = () => ({ channel: "call", outcome: null, contact: { name: "", role: "", phone: "", email: "" }, qual: { cafeteria: "", alumnos: "", niveles: [], sistema: "" },
  demo: { date: nextBusinessDay(today()), time: "10:00", duration: 30, ownerId: "" }, next: { type: "", date: "", time: "", ownerId: "" }, lostReason: "", text: "", ai: true, completeAct: true, nextTouched: false, why: "" });

// ---------- abrir / cerrar
export async function openSchool(id, { activityId = null, tab = null, keepSession = false } = {}) {
  if (!S.byId.has(id)) return toast("Colegio inexistente", { type: "err" });
  if (!keepSession) S.session = null;
  Object.assign(D, { id, data: null, form: newForm(), activityId, saving: false, result: null, brief: null, briefLoading: false, err: null, photos: null, tab: tab || (activityId ? "log" : "prep") });
  $("drawer").hidden = false; $("scrim").hidden = false;
  $("scrim").onclick = closeSchool;
  draw();
  $("drawer").focus?.();
  load();
  loadPhotos(id);
}
async function loadPhotos(id) {
  let list = [];
  try { list = (await api(`/api/schools/${id}/photos`)).photos || []; } catch {}
  if (D.id !== id) return;
  D.photos = list;
  const g = $("drawer").querySelector("#gallery");
  if (g) { g.outerHTML = gallery(S.byId.get(id)); bindGallery(S.byId.get(id)); }
}
// Fotos: las de Google y la web primero, y siempre la vista satelital al final.
function photoList(s) { return [...(D.photos || []), { url: satLink(s), kind: "sat", credit: "Vista satelital · Esri, Maxar, Earthstar Geographics" }]; }
const KIND = { google: "Google Maps", web: "Web del colegio", sat: "Satélite" };
function gallery(s) {
  const list = photoList(s);
  return `<div class="gallery" id="gallery" aria-label="Fotos del colegio">${list.map((p, i) => `<button class="ph ${p.kind}" data-ph="${i}" aria-label="Ver foto ${i + 1} (${KIND[p.kind]})"><img src="${esc(p.kind === "sat" ? satLink(s, { w: 480, h: 300 }) : p.url)}" alt="" loading="lazy" referrerpolicy="no-referrer"><span class="cap">${esc(KIND[p.kind])}</span></button>`).join("")}${D.photos === null ? `<div class="ph skel" aria-hidden="true"></div>` : ""}</div>`;
}
function bindGallery(s) {
  const g = $("drawer").querySelector("#gallery"); if (!g) return;
  g.querySelectorAll("img").forEach(img => img.addEventListener("error", () => img.closest(".ph")?.remove()));
  g.querySelectorAll("[data-ph]").forEach(b => b.onclick = () => lightbox(s, +b.dataset.ph));
}
function lightbox(s, start) {
  const list = photoList(s); let i = start;
  const m = modal(`<div class="lb"><img id="lbImg" alt=""><div class="lb-bar"><span id="lbCap" class="faint"></span><span class="lb-nav">${list.length > 1 ? `<button class="icon-btn" id="lbPrev" aria-label="Anterior">${icon("arrowLeft")}</button><button class="icon-btn" id="lbNext" aria-label="Siguiente">${icon("arrowRight")}</button>` : ""}<button class="icon-btn" id="lbClose" aria-label="Cerrar">${icon("x")}</button></span></div></div>`);
  m.querySelector(".modal-box").classList.add("wide");
  const show = () => { const p = list[i]; m.querySelector("#lbImg").src = p.kind === "sat" ? satLink(s, { w: 1400, h: 900 }) : p.url; m.querySelector("#lbCap").textContent = `${i + 1} de ${list.length} · ${p.credit || KIND[p.kind]}`; };
  const go = d => { i = (i + d + list.length) % list.length; show(); };
  m.querySelector("#lbPrev")?.addEventListener("click", () => go(-1));
  m.querySelector("#lbNext")?.addEventListener("click", () => go(1));
  m.querySelector("#lbClose").onclick = () => m.close();
  m.addEventListener("keydown", e => { if (e.key === "ArrowLeft") go(-1); if (e.key === "ArrowRight") go(1); });
  show();
}
export function closeSchool() {
  $("drawer").hidden = true; $("scrim").hidden = true; D.id = null;
  if (S.session) { const n = S.session.done; S.session = null; if (n) toast(`Sesión terminada: ${n} contacto${n > 1 ? "s" : ""} registrado${n > 1 ? "s" : ""}`); }
  import("./app.js").then(m => (S.view === "hoy" || S.view === "agenda") && m.rerender());
}
async function load(opts = {}) {
  const id = D.id;
  try {
    let d;
    if (opts.match !== undefined) d = await api(`/api/schools/${id}/match`, { body: opts.match });
    else d = await api(`/api/schools/${id}${opts.refresh ? "?refresh=1" : ""}`);
    if (D.id !== id) return;
    D.data = d; D.err = null; patchSchool(d.school);
    if (S.session && d.school.status === "client" && !opts.refresh && opts.match === undefined) {
      toast(`${d.school.name} ya es cliente: lo salteé`);
      return sessionGo(1);
    }
  } catch (e) { if (D.id === id) D.err = e.message; }
  if (D.id === id) draw();
}

// ---------- sesión de llamadas
export async function startSession(ids, label = "tu territorio") {
  if (!ids) {
    if (!S.today) { try { const { loadToday } = await import("./today.js"); await loadToday(); } catch (e) { return toast(e.message, { type: "err" }); } }
    const t = today(), acts = (S.today.activities.items || []).map(a => ({ ...a, ...localAct(a) })).filter(a => a.schoolId && a.date <= t);
    const seen = new Set(); ids = [];
    S.session = { ids: [], i: 0, label, acts: {}, done: 0 };
    for (const a of acts) if (!seen.has(a.schoolId)) { seen.add(a.schoolId); ids.push(a.schoolId); S.session.acts[a.schoolId] = a.id; }
    for (const q of S.today.queue.slice(0, 25)) if (!seen.has(q.id)) { seen.add(q.id); ids.push(q.id); }
  } else S.session = { ids: [], i: 0, label, acts: {}, done: 0 };
  if (!ids.length) { S.session = null; return toast("No hay colegios para esta sesión. Sumá países a tu territorio.", { type: "err" }); }
  S.session.ids = ids;
  openSchool(ids[0], { keepSession: true, activityId: S.session.acts[ids[0]] || null, tab: "prep" });
  prefetch();
}
function sessionGo(delta) {
  const ss = S.session; if (!ss) return;
  const i = ss.i + delta;
  if (i >= ss.ids.length) { toast("Llegaste al final de la sesión"); return closeSchool(); }
  if (i < 0) return;
  ss.i = i;
  openSchool(ss.ids[i], { keepSession: true, activityId: ss.acts[ss.ids[i]] || null, tab: "prep" });
  prefetch();
}
// Revisa en Pipedrive los próximos colegios de la sesión para no perder tiempo con clientes.
function prefetch() {
  const ss = S.session; if (!ss) return;
  const ids = ss.ids.slice(ss.i + 1, ss.i + 5).filter(id => S.byId.get(id)?.status === "unk");
  if (!ids.length) return;
  api("/api/check", { body: { ids } }).then(r => {
    Object.values(r).forEach(v => !v.error && patchSchool(v));
    if (S.session !== ss) return;
    const skip = new Set(Object.values(r).filter(v => v.status === "client").map(v => v.id));
    if (skip.size) ss.ids = ss.ids.filter((id, k) => k <= ss.i || !skip.has(id));
  }).catch(() => {});
}

// ---------- render
function draw() {
  const el = $("drawer"); if (!D.id) return;
  const s = S.byId.get(D.id), d = D.data, m = d?.match, ss = S.session;
  const phone = s.phone || "";
  const mk = d?.market || S.markets[s.country] || {};
  const nHist = d ? (d.notes?.length || 0) + (d.touches?.length || 0) : 0;
  el.innerHTML = `
  <div class="d-top">
    <div class="d-bar">
      ${ss ? `<div class="session"><span>${icon("play", "sm")} Sesión · <b>${ss.i + 1} de ${ss.ids.length}</b></span><span class="progress"><span style="width:${(ss.i + 1) / ss.ids.length * 100}%"></span></span>
        <button class="btn sm ghost" id="prev" ${ss.i ? "" : "disabled"} aria-label="Anterior">${icon("arrowLeft", "sm")}</button><button class="btn sm" id="skip">${icon("skip", "sm")} Saltar</button></div>` : `<div class="session"></div>`}
      ${d?.orgUrl ? `<a class="icon-btn" href="${esc(d.orgUrl)}" target="_blank" rel="noopener" title="Abrir en Pipedrive" aria-label="Abrir en Pipedrive">${icon("external")}</a>` : ""}
      <button class="icon-btn" id="dClose" aria-label="Cerrar (Esc)" title="Cerrar (Esc)">${icon("x")}</button>
    </div>
    <div class="d-title"><div><h2>${esc(s.name)}</h2><div class="sub">${esc([s.addr, s.city, s.country].filter(Boolean).join(", "))}</div></div>${pill(s.status)}</div>
    <div class="d-meta">
      ${mk.espacio ? `<span class="tag" title="Vocabulario del mercado">${icon("globe", "sm")} ${esc(s.country)} · «${esc(mk.espacio)}» · ${mk.trato === "vos" ? "vos" : "tú"}</span>` : ""}
      ${s.rating ? `<span class="tag">★ ${esc(s.rating)}</span>` : ""}
      ${s.found ? `<span class="tag" title="Encontrado por el radar el ${esc(s.found)}">${icon("target", "sm")} Radar</span>` : ""}
      ${(s.opp || []).map(o => `<span class="tag">${esc(o)}</span>`).join("")}
      ${d?.attempts ? `<span class="tag">${d.attempts} intento${d.attempts > 1 ? "s" : ""} sin respuesta</span>` : ""}
      ${s.lastTouch ? `<span class="tag">Último: ${esc(s.lastTouch.outcome.toLowerCase())} ${esc(ago(s.lastTouch.at))}</span>` : ""}
      ${m?.openDealOwner ? `<span class="tag">${icon("deal", "sm")} Trato de ${esc(m.openDealOwner)}</span>` : ""}
    </div>
    <div class="d-actions">
      ${phone ? `<a class="btn primary" id="aCall" href="${esc(telLink(phone))}">${icon("phone")} Llamar <span class="num" style="opacity:.85;font-weight:400">${esc(phone)}</span></a>` : `<span class="btn" aria-disabled="true">${icon("phone")} Sin teléfono</span>`}
      <button class="btn wa" id="aWa">${icon("whatsapp")} WhatsApp ${icon("chevDown", "sm")}</button>
      <button class="btn" id="aMail">${icon("mail")} Mail ${icon("chevDown", "sm")}</button>
      <button class="btn" id="aDemo">${icon("video")} <span>Demo</span></button>
      <button class="btn icon-only" id="aMore" aria-label="Más: mapa, web y buscar al decisor" title="Mapa, web y buscar al decisor">${icon("nav")}</button>
    </div>
    <div class="tabs" role="tablist">
      ${[["prep", "Preparar"], ["log", "Registrar"], ["hist", "Historial"]].map(([k, l]) => `<button class="tab" role="tab" data-tab="${k}" aria-selected="${D.tab === k}">${l}${k === "hist" && nHist ? `<span class="n">${nHist}</span>` : ""}</button>`).join("")}
    </div>
  </div>
  <div class="d-body" id="dBody">${D.err ? `<div class="callout err">${icon("alert")}<span>${esc(D.err)} <button class="linkbtn" id="retry">Reintentar</button></span></div>` : !d ? loadingBody() : D.tab === "prep" ? prepBody(s, d) : D.tab === "log" ? (D.result ? resultBody(s, d) : logBody(s, d)) : histBody(s, d)}</div>
  ${D.tab === "log" && d && !D.result ? `<div class="d-foot"><div class="sum" id="sum">${summary(s, d)}</div><button class="btn primary lg" id="save" ${D.saving || !D.form.outcome ? "disabled" : ""}>${D.saving ? `<span class="spin"></span> Guardando…` : `${icon("check")} Guardar en Pipedrive`}</button></div>` : ""}`;
  bindTop(s, d);
  if (!d) return;
  if (D.tab === "prep") bindPrep(s, d);
  if (D.tab === "log") D.result ? bindResult(s, d) : bindLog(s, d);
  if (D.tab === "hist") bindHist(s, d);
}
const loadingBody = () => `<div class="stack">${[1, 2, 3].map(() => `<div class="sec"><div class="skel" style="width:40%"></div><div class="skel" style="margin-top:12px"></div><div class="skel" style="margin-top:8px;width:80%"></div></div>`).join("")}</div>`;

function bindTop(s, d) {
  const el = $("drawer");
  el.querySelector("#dClose").onclick = closeSchool;
  el.querySelector("#retry")?.addEventListener("click", () => { D.err = null; draw(); load(); });
  el.querySelector("#prev")?.addEventListener("click", () => sessionGo(-1));
  el.querySelector("#skip")?.addEventListener("click", () => sessionGo(1));
  el.querySelectorAll("[data-tab]").forEach(b => b.onclick = () => { D.tab = b.dataset.tab; draw(); el.querySelector("#dBody").scrollTop = 0; });
  el.querySelector("#aCall")?.addEventListener("click", () => setTimeout(() => { D.form.channel = "call"; D.tab = "log"; D.result = null; draw(); }, 400));
  el.querySelector("#aWa").onclick = e => templateMenu(e.currentTarget, s, d, "whatsapp");
  el.querySelector("#aMail").onclick = e => templateMenu(e.currentTarget, s, d, "mail");
  el.querySelector("#aDemo").onclick = () => { D.tab = "log"; D.result = null; D.form.outcome = "demo"; suggest(s); draw(); };
  el.querySelector("#aMore").onclick = e => openMenu(e.currentTarget, [
    { label: "Cómo llegar", sub: "Google Maps con la ruta", fn: () => open(mapsDir(s)) },
    { label: "Ver en Google Maps", sub: "Fotos, reseñas y horarios", fn: () => open(mapsSearch(s)) },
    ...(s.web ? [{ label: "Sitio web", sub: s.web, fn: () => open(s.web) }] : []),
    { label: "Buscar el decisor en Google", sub: `«director» o «administración» de ${s.name}`, fn: () => open(`https://www.google.com/search?q=${encodeURIComponent(`"${s.name}" ${s.city} director OR administración OR cafetería`)}`) },
  ]);
}
const open = url => window.open(url, "_blank", "noopener");

// ---------- Preparar
function prepBody(s, d) {
  const p = d.playbook, b = D.brief, m = d.match;
  const sit = b?.situacion || p.situacion, apertura = b?.apertura || p.apertura, preguntas = b?.preguntas || p.preguntas, objeciones = b?.objeciones || p.objeciones, cierre = b?.cierre || p.cierre;
  const warn = s.status === "client" ? "Ya es cliente de OrderEAT. No lo prospectes: si hay algo, avisale al equipo de cuentas." : s.status === "open" ? `Tiene un trato abierto${m.openDealOwner ? ` de ${m.openDealOwner}` : ""}. Coordiná con esa persona antes de contactar.` : "";
  const cands = !m.confirmed ? (m.candidates || []) : [];
  const me = (S.me.name || "").split(" ")[0];
  return `<div class="stack">
    ${gallery(s)}
    ${warn ? `<div class="callout warn">${icon("alert")}<span>${esc(warn)}</span></div>` : ""}
    ${cands.length ? `<div class="sec"><h3><span class="l">${icon("building")} ¿Es alguna de estas organizaciones de Pipedrive?</span></h3>${m.orgId ? `<p class="muted" style="margin:0 0 6px">Ahora está vinculado a <b>${esc(m.orgName)}</b>.</p>` : ""}${cands.map(c => `<div class="cand"><span>${esc(c.name)}</span><button class="btn sm" data-org="${c.id}" data-name="${esc(c.name)}">Es esta</button></div>`).join("")}${m.orgId ? `<div class="cand"><span class="muted">Ninguna de estas</span><button class="btn sm ghost" id="unlink">Desvincular</button></div>` : ""}</div>` : ""}
    <div class="sec">
      <h3><span class="l">${icon("target")} Situación y objetivo</span>${b ? `<span class="ai-badge">${icon("sparkles", "sm")} Brief con IA</span>` : S.ai ? `<button class="btn sm" id="brief" ${D.briefLoading ? "disabled" : ""}>${D.briefLoading ? `<span class="spin"></span> Leyendo Pipedrive…` : `${icon("sparkles", "sm")} Preparar con IA`}</button>` : ""}</h3>
      <p style="margin:0 0 8px">${esc(sit)}</p>
      ${b?.angulo ? `<p style="margin:0 0 8px"><b>Ángulo:</b> ${esc(b.angulo)}</p>` : ""}
      <p class="muted" style="margin:0"><b>Objetivo:</b> ${esc(p.objetivo)}</p>
      ${b?.alerta ? `<div class="callout warn" style="margin-top:10px">${icon("alert")}<span>${esc(b.alerta)}</span></div>` : ""}
      ${s.pitch ? `<div class="callout info" style="margin-top:10px">${icon("bolt")}<span>${esc(s.pitch)}</span></div>` : ""}
    </div>
    <div class="sec"><h3><span class="l">${icon("phone")} Primeros 15 segundos</span></h3>
      <div class="say">${esc(apertura.replace(/\[tu nombre\]/g, me))}<button class="icon-btn" data-copy="${esc(apertura.replace(/\[tu nombre\]/g, me))}" aria-label="Copiar">${icon("copy")}</button></div>
      <p class="muted" style="margin:10px 0 0;font-size:13.5px">Si atiende recepción: pedí el nombre de quien maneja la ${esc(d.market.espacio)} y el mejor horario. Anotalo en Registrar.</p>
    </div>
    <div class="sec"><h3><span class="l">${icon("list")} Preguntas para calificar</span><span class="faint" style="font-size:12.5px;font-weight:500">Marcá las que ya respondió</span></h3>
      <ul class="qlist">${preguntas.map((q, i) => `<li><label><input type="checkbox" data-q="${i}" ${D.form.asked?.[i] ? "checked" : ""}><span>${esc(q)}</span></label></li>`).join("")}</ul>
    </div>
    <div class="sec"><h3><span class="l">${icon("alert")} Si te dice…</span></h3>${objeciones.map((o, i) => `<details class="obj" ${i === 0 ? "open" : ""}><summary>${esc(o.o)}</summary><p>${esc(o.r)}</p></details>`).join("")}</div>
    <div class="sec"><h3><span class="l">${icon("video")} Cierre</span></h3><div class="say">${esc(cierre)}<button class="icon-btn" data-copy="${esc(cierre)}" aria-label="Copiar">${icon("copy")}</button></div></div>
    <div class="sec"><h3><span class="l">${icon("building")} Datos del colegio</span></h3>
      <div class="grid2" style="font-size:14px">
        <div><span class="muted">Teléfono</span><br>${s.phone ? `<a href="${esc(telLink(s.phone))}">${esc(s.phone)}</a>` : "No publicado"}</div>
        <div><span class="muted">Web</span><br>${s.web ? `<a href="${esc(s.web)}" target="_blank" rel="noopener">${esc(s.web.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, ""))}</a>` : "—"}</div>
        ${s.hours ? `<div><span class="muted">Horario</span><br>${esc(s.hours)}</div>` : ""}${s.zone ? `<div><span class="muted">Zona</span><br>${esc(s.zone)}</div>` : ""}
        <div><span class="muted">En Pipedrive</span><br>${esc(m.detail || "—")}</div>
      </div>
    </div>
    <button class="btn primary lg block" id="toLog">${icon("note")} Registrar qué pasó</button>
  </div>`;
}
function bindPrep(s, d) {
  const el = $("drawer");
  bindGallery(s);
  el.querySelector("#brief")?.addEventListener("click", async () => {
    D.briefLoading = true; draw();
    try { D.brief = await api(`/api/schools/${s.id}/brief`); } catch (e) { toast(e.message, { type: "err" }); }
    D.briefLoading = false; if (D.id === s.id) draw();
  });
  el.querySelectorAll("[data-copy]").forEach(b => b.onclick = () => copy(b.dataset.copy));
  el.querySelectorAll("[data-q]").forEach(c => c.onchange = () => { D.form.asked = { ...(D.form.asked || {}), [c.dataset.q]: c.checked }; });
  el.querySelectorAll("[data-org]").forEach(b => b.onclick = () => { D.data = null; draw(); load({ match: { orgId: +b.dataset.org, orgName: b.dataset.name } }); });
  el.querySelector("#unlink")?.addEventListener("click", () => { D.data = null; draw(); load({ match: { orgId: null } }); });
  el.querySelector("#toLog").onclick = () => { D.tab = "log"; draw(); };
}

// ---------- Registrar
async function suggest(s) {
  const f = D.form; if (!f.outcome) return;
  try {
    const r = await api(`/api/schools/${s.id}/next?outcome=${f.outcome}&channel=${f.channel}`);
    if (D.id !== s.id) return;
    f.why = r.why || "";
    if (!f.nextTouched) { f.next.type = r.type || ""; f.next.date = r.date || (r.type ? nextBusinessDay(today()) : ""); }
    if (r.lost && !f.lostReason) f.lostReason = r.lost;
    if (f.outcome === "demo" && !f.nextTouched) { f.next.type = ""; }
    redrawLog();
  } catch {}
}
function redrawLog() { const b = $("drawer").querySelector("#dBody"); const top = b?.scrollTop || 0; draw(); const nb = $("drawer").querySelector("#dBody"); if (nb) nb.scrollTop = top; }

function logBody(s, d) {
  const f = D.form, o = S.outcomes.find(x => x.id === f.outcome);
  const team = S.team || [];
  const ownerOpts = sel => `<option value="">Para mí</option>${team.filter(u => u.id !== S.me.pdUserId).map(u => `<option value="${u.id}" ${String(sel) === String(u.id) ? "selected" : ""}>Para ${esc(u.name)}</option>`).join("")}`;
  const act = D.activityId && d.activities?.find(a => a.id === D.activityId);
  const connected = CONNECTED.includes(f.outcome), qualify = QUALIFY.includes(f.outcome);
  const lostish = ["not_now", "not_interested"].includes(f.outcome) || (f.outcome === "no_answer" && f.lostReason);
  const t = today();
  let n = 0;
  return `<div class="stack">
    ${act ? `<label class="callout info toggle" style="color:var(--st-org)"><input type="checkbox" data-f="completeAct" ${f.completeAct ? "checked" : ""}> Marcar como hecha: <b>${esc(act.subject)}</b></label>` : ""}
    <div class="sec step"><div class="step-h"><span class="n">${++n}</span>¿Por dónde fue el contacto?</div>
      <div class="seg" role="group">${CH.map(([k, l, ic]) => `<button data-ch="${k}" aria-pressed="${f.channel === k}">${icon(ic, "sm")} ${l}</button>`).join("")}</div></div>
    <div class="sec step"><div class="step-h"><span class="n">${++n}</span>¿Qué pasó?</div>
      <div class="outcomes">${S.outcomes.map(x => `<button class="oc ${GOOD.includes(x.id) ? "good" : ""}" data-oc="${x.id}" aria-pressed="${f.outcome === x.id}"><b>${esc(x.label)}</b><small>${esc(x.hint)}</small></button>`).join("")}</div></div>
    ${f.outcome === "demo" ? `<div class="sec step"><div class="step-h"><span class="n">${++n}</span>La demo</div>
      <div class="grid3"><label class="field"><span>Día</span><input class="inp" type="date" data-f="demo.date" value="${esc(f.demo.date)}" min="${t}"></label>
      <label class="field"><span>Hora (tu hora local)</span><input class="inp" type="time" data-f="demo.time" value="${esc(f.demo.time)}" step="900"></label>
      <label class="field"><span>Duración</span><select class="inp" data-f="demo.duration">${[20, 30, 45, 60].map(m => `<option value="${m}" ${+f.demo.duration === m ? "selected" : ""}>${m} min</option>`).join("")}</select></label></div>
      <label class="field"><span>¿Quién da la demo?</span><select class="inp" data-f="demo.ownerId">${ownerOpts(f.demo.ownerId).replace("Para mí", "Yo")}</select></label>
      <p class="muted" style="margin:0;font-size:13.5px">${d.match.openDealId ? "Se agenda en el trato abierto." : `Se crea el trato en <b>${esc(pipeName(s))}</b> con fuente «Outbound - Cold Calling» y vos como SDR.`}</p></div>` : ""}
    ${connected ? `<div class="sec step"><div class="step-h"><span class="n">${++n}</span>${f.outcome === "gatekeeper" ? "¿Quién es el decisor?" : "¿Con quién hablaste?"} <span class="faint" style="font-weight:400;font-size:13px">opcional, se crea como contacto</span></div>
      <div class="grid2"><label class="field"><span>Nombre</span><input class="inp" data-f="contact.name" value="${esc(f.contact.name)}" placeholder="Ej: Laura Gómez" autocomplete="off"></label>
      <label class="field"><span>Cargo</span><input class="inp" data-f="contact.role" value="${esc(f.contact.role)}" placeholder="Directora, administrador, concesionario" list="roles"></label>
      <label class="field"><span>Teléfono / WhatsApp</span><input class="inp" type="tel" data-f="contact.phone" value="${esc(f.contact.phone)}" placeholder="+52 …"></label>
      <label class="field"><span>Email</span><input class="inp" type="email" data-f="contact.email" value="${esc(f.contact.email)}" placeholder="nombre@colegio.edu"></label></div>
      <datalist id="roles"><option>Director/a</option><option>Administrador/a</option><option>Concesionario/a de la ${esc(d.market.espacio)}</option><option>Coordinador/a de servicios</option><option>Dueño/a</option></datalist></div>` : ""}
    ${qualify ? `<div class="sec step"><div class="step-h"><span class="n">${++n}</span>Calificación <span class="faint" style="font-weight:400;font-size:13px">lo que sepas</span></div>
      <div class="field"><span>La ${esc(d.market.espacio)} es…</span><div class="seg">${["Propia", "Externa", "No tiene"].map(c => `<button data-caf="${c}" aria-pressed="${f.qual.cafeteria === c}">${c === "Externa" ? "Concesionada" : c}</button>`).join("")}</div></div>
      <div class="grid2"><label class="field"><span>Alumnos</span><input class="inp" type="number" min="0" step="10" data-f="qual.alumnos" value="${esc(f.qual.alumnos)}" placeholder="Ej: 600"></label>
      <label class="field"><span>Sistema actual</span><input class="inp" data-f="qual.sistema" value="${esc(f.qual.sistema)}" placeholder="Efectivo, Excel, otro software…"></label></div>
      <div class="field"><span>Niveles</span><div class="chips">${NIVELES.map(nv => `<button class="chip" data-niv="${nv}" aria-pressed="${f.qual.niveles.includes(nv)}">${nv}</button>`).join("")}</div></div></div>` : ""}
    ${lostish ? `<div class="sec step"><div class="step-h"><span class="n">${++n}</span>Motivo</div>
      <select class="inp" data-f="lostReason"><option value="">Sin motivo (no cerrar)</option>${S.lostReasons.map(r => `<option ${f.lostReason === r ? "selected" : ""}>${esc(r.replace("  ", " "))}</option>`).join("")}</select>
      <p class="muted" style="margin:0;font-size:13.5px">${d.match.openDealId ? "El trato abierto se marca como perdido con este motivo." : "Queda en la nota. No hay trato abierto para cerrar."}</p></div>` : ""}
    ${f.outcome ? `<div class="sec step"><div class="step-h"><span class="n">${++n}</span>Próximo paso</div>
      ${f.why ? `<div class="callout">${icon("sparkles")}<span>${esc(f.why)}</span></div>` : ""}
      <div class="grid2"><label class="field"><span>Qué</span><select class="inp" data-f="next.type" data-touch>${NEXT_TYPES.map(([k, l]) => `<option value="${k}" ${f.next.type === k ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      <label class="field"><span>Para</span><select class="inp" data-f="next.ownerId" ${f.next.type ? "" : "disabled"}>${ownerOpts(f.next.ownerId)}</select></label>
      <label class="field"><span>Día</span><input class="inp" type="date" data-f="next.date" data-touch value="${esc(f.next.date)}" min="${t}" ${f.next.type ? "" : "disabled"}></label>
      <label class="field"><span>Hora <span class="faint">opcional</span></span><input class="inp" type="time" data-f="next.time" data-touch value="${esc(f.next.time)}" step="900" ${f.next.type ? "" : "disabled"}></label></div>
      ${f.next.type ? `<div class="chips">${[["Hoy", t], ["Mañana", addDays(t, 1)], ["Próx. hábil", nextBusinessDay(t)], ["En 1 semana", addDays(t, 7)], ["En 1 mes", addDays(t, 30)], ["En 3 meses", addDays(t, 90)]].map(([l, v]) => `<button class="chip" data-nd="${v}" aria-pressed="${f.next.date === v}">${l}</button>`).join("")}</div>` : ""}</div>` : ""}
    ${f.outcome ? `<div class="sec step"><div class="step-h"><span class="n">${++n}</span>Notas <span class="faint" style="font-weight:400;font-size:13px">lo que te dijeron, con tus palabras</span></div>
      <textarea class="inp" data-f="text" placeholder="Ej: atendió la secretaria, la cafetería la maneja un concesionario (Don Pedro), llamar después de las 11.">${esc(f.text)}</textarea>
      <div class="quick">${QUICK.map(q => `<button data-quick="${esc(q)}">+ ${esc(q)}</button>`).join("")}</div>
      ${S.ai ? `<label class="toggle"><input type="checkbox" data-f="ai" ${f.ai ? "checked" : ""}> Ordenar la nota con IA (resumen, decisor, objeción e interés)</label>` : ""}</div>` : ""}
  </div>`;
}
function pipeName(s) { const mk = S.markets[s.country]; return mk ? `${{ MX: "MX - SALES", PE: "PE - SALES", AR: "ARG - SALES", CL: "CHI - Sales", UY: "UY - SALES" }[mk.code] || "LatAm - SALES"}` : "el embudo del país"; }

function summary(s, d) {
  const f = D.form; if (!f.outcome) return "Elegí qué pasó para guardar.";
  const parts = ["contacto hecho", "nota"];
  if (f.contact.name) parts.push("contacto");
  if (f.outcome === "demo") parts.push(d.match.openDealId ? "demo" : "trato + demo");
  if (f.next.type && f.next.date) parts.push(`${S.types[f.next.type]?.toLowerCase() || "actividad"} ${shortDay(f.next.date)}`);
  if (f.lostReason && d.match.openDealId) parts.push("trato perdido");
  return `<b>Se guarda en Pipedrive:</b> ${esc(parts.join(" · "))}<br><span class="faint">Ctrl + Enter para guardar</span>`;
}
function setPath(obj, path, val) { const ks = path.split("."); let o = obj; ks.slice(0, -1).forEach(k => (o = o[k])); o[ks.at(-1)] = val; }
function bindLog(s, d) {
  const el = $("drawer"), f = D.form;
  el.querySelectorAll("[data-ch]").forEach(b => b.onclick = () => { f.channel = b.dataset.ch; redrawLog(); suggest(s); });
  el.querySelectorAll("[data-oc]").forEach(b => b.onclick = () => { f.outcome = b.dataset.oc; f.lostReason = ""; redrawLog(); suggest(s); });
  el.querySelectorAll("[data-caf]").forEach(b => b.onclick = () => { f.qual.cafeteria = f.qual.cafeteria === b.dataset.caf ? "" : b.dataset.caf; redrawLog(); });
  el.querySelectorAll("[data-niv]").forEach(b => b.onclick = () => { const v = b.dataset.niv; f.qual.niveles = f.qual.niveles.includes(v) ? f.qual.niveles.filter(x => x !== v) : [...f.qual.niveles, v]; b.setAttribute("aria-pressed", f.qual.niveles.includes(v)); });
  el.querySelectorAll("[data-nd]").forEach(b => b.onclick = () => { f.next.date = b.dataset.nd; f.nextTouched = true; redrawLog(); });
  el.querySelectorAll("[data-quick]").forEach(b => b.onclick = () => { const ta = el.querySelector('[data-f="text"]'); ta.value = (ta.value.trim() ? ta.value.trim() + ". " : "") + b.dataset.quick; f.text = ta.value; ta.focus(); });
  el.querySelectorAll("[data-f]").forEach(inp => {
    const ev = inp.tagName === "SELECT" || inp.type === "checkbox" ? "change" : "input";
    inp.addEventListener(ev, () => {
      setPath(f, inp.dataset.f, inp.type === "checkbox" ? inp.checked : inp.value);
      if (inp.hasAttribute("data-touch")) f.nextTouched = true;
      if (inp.dataset.f === "next.type") { if (inp.value && !f.next.date) f.next.date = nextBusinessDay(today()); redrawLog(); }
      else if (inp.dataset.f === "lostReason") redrawLog();
      else { const sum = el.querySelector("#sum"); if (sum) sum.innerHTML = summary(s, d); }
    });
  });
  el.querySelector("#save")?.addEventListener("click", () => saveLog(s, d));
}

async function saveLog(s, d) {
  const f = D.form;
  if (!f.outcome) return toast("Elegí qué pasó", { type: "err" });
  if (f.next.type && !f.next.date) return toast("Poné la fecha del próximo paso", { type: "err" });
  if (f.outcome === "demo" && (!f.demo.date || !f.demo.time)) return toast("Poné el día y la hora de la demo", { type: "err" });
  D.saving = true; redrawLog();
  const body = {
    outcome: f.outcome, channel: f.channel, text: f.text, ai: f.ai,
    contact: f.contact.name ? f.contact : null, qual: f.qual,
    demo: f.outcome === "demo" ? { ...f.demo, ownerId: f.demo.ownerId ? Number(f.demo.ownerId) : undefined } : null,
    next: f.next.type ? { type: f.next.type, date: f.next.date, time: f.next.time || undefined, ownerId: f.next.ownerId ? Number(f.next.ownerId) : undefined } : null,
    lost: f.lostReason ? { reason: f.lostReason } : null,
    completeActivityId: D.activityId && f.completeAct ? D.activityId : null,
  };
  try {
    const r = await api(`/api/schools/${s.id}/log`, { body });
    if (D.id !== s.id) return;
    D.result = { ...r, form: JSON.parse(JSON.stringify(f)) };
    patchSchool(r.school);
    S.today = null; S.agenda = null;
    if (S.session) S.session.done++;
    import("./explore.js").then(m => m.refreshExplore());
    D.saving = false; draw();
    // refresca la ficha en segundo plano para que Historial muestre lo nuevo
    api(`/api/schools/${s.id}`).then(nd => { if (D.id === s.id) { D.data = nd; if (D.tab !== "log") draw(); } }).catch(() => {});
  } catch (e) { D.saving = false; redrawLog(); toast(e.message, { type: "err" }); }
}

function resultBody(s, d) {
  const r = D.result, f = r.form, ss = S.session;
  const contact = f.contact?.name ? f.contact : d.persons?.[0] || null;
  const tpl = id => d.templates.find(t => t.id === id);
  const extra = [];
  if (f.outcome === "demo") {
    extra.push(`<a class="btn" href="${esc(gcalLink({ title: `Demo OrderEAT · ${s.name}`, date: f.demo.date, time: f.demo.time, minutes: +f.demo.duration || 30, details: `Demo de OrderEAT para la ${d.market.espacio} de ${s.name}.\nAgendada desde OrderBrain SDR.`, guests: contact?.email || "" }))}" target="_blank" rel="noopener">${icon("calendar")} Invitación en Google Calendar</a>`);
    extra.push(`<button class="btn wa" data-tpl="confirm_demo">${icon("whatsapp")} Confirmar por WhatsApp</button>`);
  }
  if (f.outcome === "info") extra.push(`<button class="btn" data-tpl="mail_info">${icon("mail")} Mandar la info por mail</button>`, `<button class="btn wa" data-tpl="info">${icon("whatsapp")} Mandar por WhatsApp</button>`);
  if (f.outcome === "no_answer" && tpl("after_call")) extra.push(`<button class="btn wa" data-tpl="after_call">${icon("whatsapp")} Mandar WhatsApp ahora</button>`);
  return `<div class="sec done-card">
    <div class="big">${icon("check")}</div>
    <h3>Guardado en Pipedrive</h3>
    <ul class="writes">${r.done.map(x => `<li>${icon("check", "sm")}<span>${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.label)}</a>` : esc(x.label)}</span></li>`).join("")}</ul>
    ${extra.length ? `<div class="d-actions" style="justify-content:center;margin:6px 0 0">${extra.join("")}</div>` : ""}
    <div class="d-actions" style="justify-content:center">
      ${ss ? `<button class="btn primary lg" id="nextSchool">Siguiente colegio ${icon("arrowRight")}</button>` : `<button class="btn primary" id="closeD">Listo</button>`}
      <button class="btn ghost" id="again">Registrar otro contacto</button>
    </div>
    ${ss ? `<p class="faint" style="margin:0;font-size:13px">${ss.ids.length - ss.i - 1} colegios restantes en la sesión</p>` : ""}
  </div>`;
}
function bindResult(s, d) {
  const el = $("drawer"), f = D.result.form;
  el.querySelector("#nextSchool")?.addEventListener("click", () => sessionGo(1));
  el.querySelector("#closeD")?.addEventListener("click", closeSchool);
  el.querySelector("#again").onclick = () => { D.result = null; D.form = newForm(); D.activityId = null; draw(); };
  el.querySelectorAll("[data-tpl]").forEach(b => b.onclick = () => {
    const t = d.templates.find(x => x.id === b.dataset.tpl); if (!t) return;
    let text = t.text;
    if (f.outcome === "demo") text = text.replace("[día]", `${shortDay(f.demo.date)}`).replace("[hora]", f.demo.time);
    if (f.contact?.name) text = text.replace(/^Hola(?=[,\s])/, `Hola ${f.contact.name.split(" ")[0]}`);
    messageModal(s, d, { ...t, text }, { phone: f.contact?.phone, email: f.contact?.email, logAfter: false });
  });
  el.querySelector("#nextSchool")?.focus();
}

// ---------- Historial
function histBody(s, d) {
  const items = [
    ...(d.touches || []).map(t => ({ at: t.at, ic: { call: "phone", whatsapp: "whatsapp", mail: "mail", visit: "user" }[t.channel] || "note", h: `<b>${esc(t.by)}</b> · ${esc(t.outcome)}`, p: t.text })),
    ...(d.notes || []).filter(n => !/OrderBrain SDR/.test(n.text) || !(d.touches || []).length).map(n => ({ at: String(n.at).replace(" ", "T") + "Z", ic: "note", h: `<b>${esc(n.author)}</b> · nota${n.deal ? ` en ${esc(n.deal)}` : ""}`, p: n.text })),
  ].sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const m = d.match;
  return `<div class="stack">
    ${d.persons?.length ? `<div class="sec"><h3><span class="l">${icon("users")} Contactos</span></h3>${d.persons.map(p => `<div class="person"><div class="av" style="width:34px;height:34px;border-radius:50%;background:var(--surface-3);display:grid;place-items:center;font-weight:600;font-size:13px">${initials(p.name)}</div><div class="t"><b>${esc(p.name)}</b><small>${esc([p.phone, p.email].filter(Boolean).join(" · ") || "Sin datos")}</small></div>
      ${p.phone ? `<a class="icon-btn" href="${esc(telLink(p.phone))}" aria-label="Llamar">${icon("phone")}</a><button class="icon-btn" data-pwa="${esc(p.phone)}" data-pname="${esc(p.name)}" aria-label="WhatsApp">${icon("whatsapp")}</button>` : ""}${p.email ? `<button class="icon-btn" data-pmail="${esc(p.email)}" data-pname="${esc(p.name)}" aria-label="Mail">${icon("mail")}</button>` : ""}</div>`).join("")}</div>` : ""}
    ${d.activities?.length ? `<div class="sec"><h3><span class="l">${icon("calendar")} Pendientes</span></h3>${d.activities.map(a => { const l = localAct(a); return `<div class="act"><span class="ty ${a.type}">${icon(TYPE_ICON[a.type] || "check")}</span><div class="t"><b>${esc(a.subject)}</b><small class="${l.date < today() ? "late" : ""}">${esc(a.typeLabel)} · ${esc(dayLabel(l.date))}${l.time ? ` ${l.time}` : ""} · ${esc(a.owner)}</small></div><div class="ops">${a.ownerId === S.me.pdUserId ? `<button class="icon-btn" data-hdone="${a.id}" aria-label="Marcar como hecha" title="Marcar como hecha">${icon("check")}</button>` : ""}</div></div>`; }).join("")}</div>` : ""}
    ${d.deals?.length ? `<div class="sec"><h3><span class="l">${icon("deal")} Tratos</span></h3>${d.deals.map(x => `<div class="act"><span class="ty">${icon("deal")}</span><div class="t"><b><a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title)}</a></b><small>${esc(x.pipeline)} · ${esc(x.stage)} · ${x.status === "won" ? "ganado" : x.status === "lost" ? "perdido" + (x.lostReason ? ` (${esc(x.lostReason)})` : "") : "abierto"}${x.owner ? ` · ${esc(x.owner)}` : ""} · ${esc(x.updated)}</small></div></div>`).join("")}</div>` : ""}
    <div class="sec"><h3><span class="l">${icon("clock")} Historial</span>${m.checkedAt ? `<button class="btn sm ghost" id="refresh">${icon("refresh", "sm")} Actualizar</button>` : ""}</h3>
      ${items.length ? `<div class="timeline">${items.map(i => `<div class="tl"><span class="ic">${icon(i.ic)}</span><div><div class="h">${i.h} · ${esc(ago(i.at))}</div>${i.p ? `<p>${esc(i.p)}</p>` : ""}</div></div>`).join("")}</div>` : `<div class="empty">${icon("note")}<span>Todavía no hay contactos ni notas. Lo que registres aparece acá y en Pipedrive.</span></div>`}
    </div>
    ${m.orgId && m.confirmed ? `<p class="faint" style="font-size:13px;margin:0">Vinculado a <a href="${esc(d.orgUrl)}" target="_blank" rel="noopener">${esc(m.orgName)}</a> en Pipedrive · <button class="linkbtn" id="unlink2">no es esta organización</button></p>` : ""}
  </div>`;
}
function bindHist(s, d) {
  const el = $("drawer");
  el.querySelector("#refresh")?.addEventListener("click", () => { D.data = null; draw(); load({ refresh: true }); });
  el.querySelector("#unlink2")?.addEventListener("click", () => { D.data = null; D.tab = "prep"; draw(); load({ match: { orgId: null } }); });
  el.querySelectorAll("[data-hdone]").forEach(b => b.onclick = async () => {
    const { markDone } = await import("./today.js");
    markDone(Number(b.dataset.hdone), () => load());
  });
  el.querySelectorAll("[data-pwa]").forEach(b => b.onclick = () => templateMenu(b, s, d, "whatsapp", { phone: b.dataset.pwa, name: b.dataset.pname }));
  el.querySelectorAll("[data-pmail]").forEach(b => b.onclick = () => templateMenu(b, s, d, "mail", { email: b.dataset.pmail, name: b.dataset.pname }));
}

// ---------- WhatsApp y mail con plantillas
function templateMenu(anchor, s, d, channel, to = {}) {
  if (!d) return toast("Esperá a que cargue la ficha");
  const list = d.templates.filter(t => t.channel === channel);
  const recommended = channel === "whatsapp" ? (s.status === "lost" ? "reactivate" : d.attempts ? "after_call" : "intro") : (s.status === "lost" ? "mail_reactivate" : "mail_info");
  list.sort((a, b) => (b.id === recommended) - (a.id === recommended));
  openMenu(anchor, [{ head: channel === "whatsapp" ? "Mensaje de WhatsApp" : "Mail desde Gmail" },
    ...list.map(t => ({ label: t.label + (t.id === recommended ? " · sugerido" : ""), sub: t.text.split("\n")[0], fn: () => {
      let text = t.text; if (to.name) text = text.replace(/^Hola(?=[,\s])/, `Hola ${to.name.split(" ")[0]}`);
      messageModal(s, d, { ...t, text }, { phone: to.phone, email: to.email, logAfter: true });
    } })),
    { label: "Mensaje en blanco", sub: "Escribir desde cero", fn: () => messageModal(s, d, { channel, label: "Mensaje", text: "", subject: "" }, { phone: to.phone, email: to.email, logAfter: true }) },
  ]);
}
function messageModal(s, d, t, { phone, email, logAfter }) {
  const isMail = t.channel === "mail";
  const defPhone = phone || d.persons?.find(p => p.phone)?.phone || s.phone || "";
  const defMail = email || d.persons?.find(p => p.email)?.email || "";
  const m = modal(`<h3>${isMail ? icon("mail") : icon("whatsapp")} ${esc(t.label)} · ${esc(s.name)}</h3>
    <label class="field"><span>Para</span><input class="inp" id="mTo" value="${esc(isMail ? defMail : defPhone)}" placeholder="${isMail ? "email@colegio.edu" : "+52 …"}"></label>
    ${isMail ? `<label class="field"><span>Asunto</span><input class="inp" id="mSub" value="${esc(t.subject || "")}"></label>` : ""}
    <label class="field"><span>Mensaje</span><textarea class="inp" id="mText" rows="${isMail ? 12 : 8}">${esc(t.text)}</textarea></label>
    ${/\[(día|hora|tu nombre)\]/.test(t.text) ? `<p class="callout warn" style="margin:0">${icon("alert")}<span>Completá lo que está entre corchetes antes de mandar.</span></p>` : ""}
    <div class="row">
      ${S.ai ? `<button class="btn ghost" id="mAi">${icon("sparkles")} Mejorar con IA</button>` : ""}
      <button class="btn" id="mCopy">${icon("copy")} Copiar</button>
      <button class="btn ${isMail ? "primary" : "wa"}" id="mGo">${isMail ? `${icon("mail")} Abrir en Gmail` : `${icon("whatsapp")} Abrir WhatsApp`}</button>
    </div>
    ${!isMail ? `<p class="faint" style="margin:0;font-size:12.5px">Se abre WhatsApp Web o la app. Si usás Volt, la conversación queda en el CRM automáticamente.</p>` : ""}`);
  const q = sel => m.querySelector(sel);
  q("#mCopy").onclick = () => copy(q("#mText").value);
  q("#mAi")?.addEventListener("click", async e => {
    const b = e.currentTarget; b.disabled = true; b.innerHTML = `<span class="spin"></span> Reescribiendo…`;
    try { const r = await api(`/api/schools/${s.id}/draft`, { body: { channel: t.channel, purpose: t.label, contact: d.persons?.[0]?.name || "", base: q("#mText").value } }); q("#mText").value = r.text || q("#mText").value; if (r.subject && q("#mSub")) q("#mSub").value = r.subject; }
    catch (err) { toast(err.message, { type: "err" }); }
    b.disabled = false; b.innerHTML = `${icon("sparkles")} Mejorar con IA`;
  });
  q("#mGo").onclick = () => {
    const to = q("#mTo").value.trim(), text = q("#mText").value;
    if (isMail) open(gmailLink({ to, subject: q("#mSub").value, body: text }));
    else { if (!to) return toast("Poné el número", { type: "err" }); open(waLink(to, text, s.country)); }
    m.close();
    if (logAfter) { D.form.channel = isMail ? "mail" : "whatsapp"; D.tab = "log"; D.result = null; if (!D.form.text) D.form.text = `Mandé ${isMail ? "mail" : "WhatsApp"}: ${t.label.toLowerCase()}.`; draw(); toast("Cuando tengas respuesta (o no), registralo acá"); }
  };
}

// Ctrl + Enter guarda; en la pantalla de resultado, Enter pasa al siguiente de la sesión.
addEventListener("keydown", e => {
  if (!drawerOpen() || document.querySelector(".modal")) return;
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && D.tab === "log" && !D.result) { e.preventDefault(); $("drawer").querySelector("#save")?.click(); }
});
