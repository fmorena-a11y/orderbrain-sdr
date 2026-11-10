// Ficha del colegio: preparar el contacto, registrar el resultado e historial. Incluye el modo sesión.
import { $, S, api, esc, icon, pill, toast, copy, openMenu, modal, patchSchool, today, addDays, nextBusinessDay, shortDay, dayLabel, localAct, ago, TYPE_ICON,
  telLink, waLink, gmailLink, gcalLink, mapsDir, mapsSearch, initials, satLink } from "./core.js";
const coarse = () => matchMedia("(pointer: coarse)").matches;

const D = { id: null, data: null, tab: "prep", form: null, activityId: null, saving: false, result: null, brief: null, briefLoading: false, err: null, photos: null, study: undefined, studyWorking: false, studyErr: null };
const CH = [["call", "Llamada", "phone"], ["whatsapp", "WhatsApp", "whatsapp"], ["mail", "Mail", "mail"], ["visit", "Visita", "user"]];
const NEXT_TYPES = [["", "Sin próximo paso"], ["call", "Llamada"], ["deadline", "WhatsApp"], ["task", "Mail"]];
const GOOD = ["callback", "info", "demo"];
const CONNECTED = ["gatekeeper", "callback", "info", "demo", "not_now", "not_interested"];
const QUALIFY = ["callback", "info", "demo", "not_now"];
// Atajos para la nota, según lo que pasó (los datos de calificación tienen sus propios campos).
const QUICK = {
  no_answer: ["Buzón de voz", "Daba ocupado", "Llamar en otro horario"], gatekeeper: ["Pidió que mande mail", "Decisor de vacaciones", "Llamar después de las 11"],
  callback: ["Pidió que llame en otro horario", "Quiere verlo con dirección"], info: ["Pidió precios", "Pidió que mande mail"], demo: ["Quiere verlo con dirección", "Suma al concesionario"],
  not_now: ["Renuevan la concesión el año que viene", "Ya tienen presupuesto cerrado"], not_interested: ["Ya usan otro sistema", "No quieren app para familias"], bad_data: ["Teléfono fuera de servicio", "El colegio cerró"],
};
const NIVELES = ["Preescolar", "Primaria", "Secundaria", "Prepa", "Universidad"];

export const drawerOpen = () => !$("drawer").hidden;
export const currentSchoolId = () => (drawerOpen() ? D.id : null);
const newForm = () => ({ channel: "call", outcome: null, contact: { name: "", role: "", phone: "", email: "" }, qual: { cafeteria: "", alumnos: "", niveles: [], sistema: "" },
  demo: { date: nextBusinessDay(today()), time: "10:00", duration: 30, ownerId: "" }, next: { type: "", date: "", time: "", ownerId: "" }, lostReason: "", text: "", ai: true, completeAct: true, nextTouched: false, why: "" });

// ---------- abrir / cerrar
export async function openSchool(id, { activityId = null, tab = null, keepSession = false } = {}) {
  if (!S.byId.has(id)) return toast("Colegio inexistente", { type: "err" });
  if (!keepSession) S.session = null;
  if ($("drawer").hidden) D.opener = document.activeElement;
  import("./app.js").then(m => m.rememberSchool(id));
  Object.assign(D, { inCall: false, id, data: null, form: newForm(), activityId, saving: false, result: null, brief: null, briefLoading: false, err: null, photos: null, study: undefined, studyWorking: false, studyErr: null, tab: tab || (activityId ? "log" : "prep") });
  $("drawer").hidden = false; $("scrim").hidden = false;
  $("scrim").onclick = closeSchool;
  $("app").inert = true; // lo de atrás no recibe foco ni clics mientras la ficha está abierta
  $("drawer").scrollTop = 0;
  draw();
  $("drawer").querySelector("#dClose")?.focus();
  load();
  loadPhotos(id);
  loadStudy(id);
}
// Estudio: si no existe, se pide solo (tarda 1 o 2 minutos) y aparece cuando está listo.
async function loadStudy(id, { refresh = false } = {}) {
  const redraw = () => { if (D.id === id && D.tab === "prep" && D.data) keepScroll(draw); };
  try {
    if (!refresh) {
      const r = await api(`/api/schools/${id}/study`);
      if (D.id !== id) return;
      if (r.study) { D.study = r.study; return redraw(); }
      if (!r.enabled) { D.study = null; return redraw(); }
    }
    D.studyWorking = true; D.studyErr = null; redraw();
    let st = null;
    try { st = (await api(`/api/schools/${id}/study`, { body: { refresh } })).study; }
    catch (e) {
      // si otra persona lo está generando, esperar a que aparezca
      for (let i = 0; i < 24 && !st && D.id === id; i++) { await new Promise(r => setTimeout(r, 8000)); st = (await api(`/api/schools/${id}/study`).catch(() => ({}))).study; }
      if (!st) throw e;
    }
    if (D.id !== id) return;
    D.study = st; D.studyWorking = false; redraw();
  } catch (e) { if (D.id !== id) return; D.studyWorking = false; D.studyErr = e.message; redraw(); }
}
// Redibuja sin perder el scroll (en celular scrollea toda la ficha; en escritorio, el cuerpo).
function keepScroll(fn) { const dr = $("drawer"), b = dr.querySelector("#dBody"); const t1 = dr.scrollTop, t2 = b?.scrollTop || 0; fn(); dr.scrollTop = t1; const nb = dr.querySelector("#dBody"); if (nb) nb.scrollTop = t2; }
async function loadPhotos(id) {
  let list = [];
  try { list = (await api(`/api/schools/${id}/photos`)).photos || []; } catch {}
  if (D.id !== id) return;
  D.photos = list;
  const g = $("drawer").querySelector("#gallery");
  if (g) { g.outerHTML = gallery(S.byId.get(id)); bindGallery(S.byId.get(id)); }
}
// Fotos: las de Google y la web primero, y siempre la vista satelital al final.
function photoList(s) {
  const seen = new Set((D.photos || []).map(p => p.url));
  const fromStudy = (D.study?.imagenes || []).filter(x => !seen.has(x.url)).map(x => ({ url: x.url, kind: "study", credit: x.descripcion || "Encontrada en la web" }));
  return [...(D.photos || []), ...fromStudy, { url: satLink(s), kind: "sat", credit: "Vista satelital · Esri, Maxar, Earthstar Geographics" }];
}
const KIND = { google: "Google Maps", web: "Web del colegio", study: "Web", sat: "Satélite" };
function gallery(s) {
  const list = photoList(s);
  return `<div class="gallery" id="gallery" aria-label="Fotos del colegio">${list.map((p, i) => `<button class="ph ${p.kind}" data-ph="${i}" aria-label="Ver foto ${i + 1} (${KIND[p.kind]})"><img src="${esc(p.kind === "sat" ? satLink(s, { w: 480, h: 300 }) : p.url)}" alt="" loading="lazy" referrerpolicy="no-referrer"><span class="cap">${esc(KIND[p.kind])}</span></button>`).join("")}${D.photos === null ? `<div class="ph skel" aria-hidden="true"></div>` : ""}</div>`;
}
function bindGallery(s) {
  const g = $("drawer").querySelector("#gallery"); if (!g) return;
  g.querySelectorAll("img").forEach(img => img.addEventListener("error", () => { img.closest(".ph")?.remove(); if (!g.querySelector(".ph")) g.remove(); }));
  g.querySelectorAll("[data-ph]").forEach(b => b.onclick = () => lightbox(s, +b.dataset.ph));
}
function lightbox(s, start) {
  const list = photoList(s); let i = start;
  const m = modal(`<div class="lb"><img id="lbImg" alt="Foto del colegio"><div class="lb-bar"><span id="lbCap" class="faint"></span><span class="lb-nav">${list.length > 1 ? `<button class="icon-btn" id="lbPrev" aria-label="Anterior">${icon("arrowLeft")}</button><button class="icon-btn" id="lbNext" aria-label="Siguiente">${icon("arrowRight")}</button>` : ""}<button class="icon-btn" id="lbClose" aria-label="Cerrar">${icon("x")}</button></span></div></div>`, { onClose: () => $("drawer").querySelector(`[data-ph="${i}"]`)?.focus() });
  m.querySelector(".modal-box").classList.add("wide");
  const show = () => { const p = list[i]; m.querySelector("#lbImg").src = p.kind === "sat" ? satLink(s, { w: 1400, h: 900 }) : p.url; m.querySelector("#lbCap").textContent = `${i + 1} de ${list.length} · ${p.credit || KIND[p.kind]}`; };
  const go = d => { i = (i + d + list.length) % list.length; show(); };
  m.querySelector("#lbPrev")?.addEventListener("click", () => go(-1));
  m.querySelector("#lbNext")?.addEventListener("click", () => go(1));
  m.querySelector("#lbClose").onclick = () => m.close();
  m.addEventListener("keydown", e => { if (e.key === "ArrowLeft") go(-1); if (e.key === "ArrowRight") go(1); });
  // deslizar para pasar de foto en el celular
  let x0 = null; const img = m.querySelector("#lbImg");
  img.addEventListener("pointerdown", e => (x0 = e.clientX));
  img.addEventListener("pointerup", e => { if (x0 === null) return; const dx = e.clientX - x0; x0 = null; if (dx > 40) go(-1); else if (dx < -40) go(1); });
  show();
}
export function closeSchool() {
  $("drawer").hidden = true; $("scrim").hidden = true; D.id = null;
  $("app").inert = false;
  const ss = S.session; S.session = null;
  if (ss) {
    const n = ss.done, left = ss.ids.length - ss.i - 1;
    if (left > 0) { S.lastSession = ss; toast(`Sesión en pausa: ${n} contacto${n === 1 ? "" : "s"} registrado${n === 1 ? "" : "s"}, faltan ${left}`, { action: { label: "Retomar", fn: resumeSession } }); }
    else { S.lastSession = null; toast(`Sesión terminada: ${n} contacto${n === 1 ? "" : "s"} registrado${n === 1 ? "" : "s"}`); }
  }
  import("./app.js").then(m => (S.view === "hoy" || S.view === "agenda") && m.rerender()).then(() => { if (D.opener?.isConnected) D.opener.focus(); });
}
export function resumeSession() {
  const ss = S.lastSession; if (!ss) return;
  S.lastSession = null; S.session = ss;
  openSchool(ss.ids[ss.i], { keepSession: true, activityId: ss.acts[ss.ids[ss.i]] || null, tab: "prep" });
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
  if (i >= ss.ids.length) { ss.i = ss.ids.length - 1; return closeSchool(); }
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
const focusKey = el => el && (el.id ? `#${el.id}` : ["tab", "oc", "ch", "f", "caf", "niv", "nd", "ph"].map(k => el.dataset?.[k] !== undefined ? `[data-${k}="${el.dataset[k]}"]` : "").find(Boolean));
function clientWarn(s, m) {
  if (s.status === "client") return "Ya es cliente de OrderEAT. No lo prospectes: si hay algo, avisale al equipo de cuentas.";
  if (s.status === "open") return `Tiene un trato abierto${m?.openDealOwner ? ` de ${m.openDealOwner}` : ""}. Coordiná con esa persona antes de contactar.`;
  return "";
}
function draw() {
  const el = $("drawer"); if (!D.id) return;
  const fk = el.contains(document.activeElement) ? focusKey(document.activeElement) : null;
  const s = S.byId.get(D.id), d = D.data, m = d?.match, ss = S.session;
  const phone = s.phone || "";
  const mk = d?.market || S.markets[s.country] || {};
  const nHist = d ? (d.notes?.length || 0) + (d.touches?.length || 0) : 0;
  const notReady = !d ? `disabled title="${D.err ? "No se pudo cargar la ficha" : "Cargando la ficha…"}"` : "";
  el.setAttribute("aria-busy", d ? "false" : "true");
  el.innerHTML = `
  ${ss ? `<div class="d-session"><span class="progress" aria-hidden="true"><span style="width:${(ss.i + 1) / ss.ids.length * 100}%"></span></span>
    <span class="lbl">${icon("play", "sm")} <b>${ss.i + 1}</b>/${ss.ids.length}<span class="hide-sm"> · sesión</span></span>
    <button class="btn sm ghost" id="prev" ${ss.i ? "" : "disabled"} aria-label="Colegio anterior">${icon("arrowLeft", "sm")}</button><button class="btn sm" id="skip">${icon("skip", "sm")} Saltar</button></div>` : ""}
  <div class="d-top">
    <div class="d-title"><div class="tt"><h2 id="dTitle">${esc(s.name)}</h2><div class="sub">${esc([s.addr, s.city, s.country].filter(Boolean).join(", "))}</div></div>
      <div class="d-tr">${pill(s.status)}${d?.orgUrl ? `<a class="icon-btn" href="${esc(d.orgUrl)}" target="_blank" rel="noopener" title="Abrir en Pipedrive" aria-label="Abrir en Pipedrive">${icon("external")}</a>` : ""}<button class="icon-btn" id="dClose" aria-label="Cerrar ficha" title="Cerrar (Esc)">${icon("x")}</button></div></div>
    <div class="d-meta">
      ${pill(s.status)}
      ${mk.espacio ? `<span class="tag" title="Decí «${esc(mk.espacio)}» y tratá de ${mk.trato === "vos" ? "vos" : "tú"}">«${esc(mk.espacio)}» · ${mk.trato === "vos" ? "vos" : "tú"}</span>` : ""}
      ${s.hours ? `<span class="tag" title="Horario">${icon("clock", "sm")} ${esc(s.hours)}</span>` : ""}
      ${s.rating ? `<span class="tag" title="Reseñas en Google">★ ${esc(s.rating)}</span>` : ""}
      ${(s.opp || []).filter(o => !/^Privado confirmado/.test(o)).map(o => `<span class="tag">${esc(o)}</span>`).join("")}
      ${d?.attempts ? `<span class="tag">${d.attempts} intento${d.attempts > 1 ? "s" : ""} sin respuesta</span>` : ""}
      ${s.lastTouch ? `<span class="tag">Último: ${esc(s.lastTouch.outcome.toLowerCase())} ${esc(ago(s.lastTouch.at))}</span>` : ""}
      ${m?.openDealOwner ? `<span class="tag">${icon("deal", "sm")} Trato de ${esc(m.openDealOwner)}</span>` : ""}
    </div>
    <div class="d-actions">
      ${phone ? `<a class="btn primary" id="aCall" href="${esc(telLink(phone))}">${icon("phone")} Llamar <span class="num">${esc(phone)}</span></a>` : `<span class="btn" aria-disabled="true" title="No hay teléfono publicado">${icon("phone")} Sin teléfono</span>`}
      <button class="btn wa" id="aWa" ${notReady} aria-haspopup="menu">${icon("whatsapp")} WhatsApp</button>
      <button class="btn" id="aMail" ${notReady} aria-haspopup="menu">${icon("mail")} Mail</button>
      <button class="btn" id="aDemo" ${notReady} ${s.status === "client" ? `disabled title="Ya es cliente"` : ""}>${icon("video")} Demo</button>
      <button class="btn icon-only" id="aMore" aria-haspopup="menu" aria-label="Más: mapa, web y buscar al decisor" title="Mapa, web y buscar al decisor">${icon("nav")}</button>
    </div>
    ${D.inCall && D.tab !== "log" ? `<button class="call-banner" id="toLog">${icon("phone", "sm")} ¿Cortaste? Registrá cómo te fue ${icon("arrowRight", "sm")}</button>` : ""}
  </div>
  <div class="tabs" role="tablist" aria-label="Secciones de la ficha">
    ${[["prep", "Preparar"], ["log", "Registrar"], ["hist", "Historial"]].map(([k, l]) => `<button class="tab" role="tab" id="tab-${k}" data-tab="${k}" aria-selected="${D.tab === k}" aria-controls="dBody" tabindex="${D.tab === k ? 0 : -1}">${l}${k === "hist" && nHist ? `<span class="n">${nHist}</span>` : ""}</button>`).join("")}
  </div>
  <div class="d-body" id="dBody" role="tabpanel" aria-labelledby="tab-${D.tab}">${D.err ? `<div class="callout err">${icon("alert")}<span>No se pudo cargar la ficha: ${esc(D.err)}</span><button class="btn sm" id="retry">Reintentar</button></div>` : !d ? loadingBody() : D.tab === "prep" ? prepBody(s, d) : D.tab === "log" ? (D.result ? resultBody(s, d) : logBody(s, d)) : histBody(s, d)}</div>
  ${D.tab === "log" && d && !D.result ? `<div class="d-foot"><div class="sum" id="sum">${summary(s, d)}</div><button class="btn primary lg" id="save" ${D.saving || !D.form.outcome || (s.status === "client" && D.form.outcome === "demo") ? "disabled" : ""}>${D.saving ? `<span class="spin"></span> Guardando…` : `${icon("check")} Guardar en Pipedrive`}</button></div>` : ""}`;
  bindTop(s, d);
  if (d) {
    if (D.tab === "prep") bindPrep(s, d);
    if (D.tab === "log") D.result ? bindResult(s, d) : bindLog(s, d);
    if (D.tab === "hist") bindHist(s, d);
  }
  if (fk) el.querySelector(fk)?.focus();
}
const loadingBody = () => `<div class="stack">${[1, 2, 3].map(() => `<div class="sec"><div class="skel" style="width:40%"></div><div class="skel" style="margin-top:12px"></div><div class="skel" style="margin-top:8px;width:80%"></div></div>`).join("")}</div>`;
function goTab(tab) {
  D.tab = tab; draw();
  // en celular la ficha entera scrollea: se lleva a las pestañas; en escritorio, el cuerpo al inicio
  const el = $("drawer"), tabs = el.querySelector(".tabs");
  if (el.scrollTop > tabs.offsetTop) el.scrollTop = tabs.offsetTop;
  el.querySelector("#dBody").scrollTop = 0;
}

function bindTop(s, d) {
  const el = $("drawer");
  el.querySelector("#dClose").onclick = closeSchool;
  el.querySelector("#retry")?.addEventListener("click", () => { D.err = null; draw(); load(); });
  el.querySelector("#prev")?.addEventListener("click", () => sessionGo(-1));
  el.querySelector("#skip")?.addEventListener("click", () => sessionGo(1));
  const tabs = [...el.querySelectorAll("[data-tab]")];
  tabs.forEach((b, k) => {
    b.onclick = () => goTab(b.dataset.tab);
    b.onkeydown = e => { const n = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0; if (n) { e.preventDefault(); const t = tabs[(k + n + tabs.length) % tabs.length]; goTab(t.dataset.tab); $("drawer").querySelector(`[data-tab="${t.dataset.tab}"]`).focus(); } };
  });
  // Llamar no saca del guion: en celular, al volver de la llamada se abre Registrar; en escritorio queda un aviso.
  el.querySelector("#aCall")?.addEventListener("click", () => {
    D.inCall = true; D.form.channel = "call"; draw();
    if (coarse()) {
      const back = () => { if (document.visibilityState !== "visible") return; document.removeEventListener("visibilitychange", back); if (D.inCall && D.id === s.id) { D.result = null; goTab("log"); } };
      document.addEventListener("visibilitychange", back);
    }
  });
  el.querySelector("#toLog")?.addEventListener("click", () => { D.result = null; goTab("log"); });
  el.querySelector("#aWa").onclick = e => templateMenu(e.currentTarget, s, d, "whatsapp");
  el.querySelector("#aMail").onclick = e => templateMenu(e.currentTarget, s, d, "mail");
  el.querySelector("#aDemo").onclick = () => {
    D.result = null; D.form.outcome = "demo"; suggest(s); goTab("log");
    const date = $("drawer").querySelector('[data-f="demo.date"]');
    date?.closest(".step")?.scrollIntoView({ block: "start" }); date?.focus();
  };
  el.querySelector("#aMore").onclick = e => openMenu(e.currentTarget, [
    { label: "Cómo llegar", sub: "Google Maps con la ruta", fn: () => open(mapsDir(s)) },
    { label: "Ver en Google Maps", sub: "Fotos, reseñas y horarios", fn: () => open(mapsSearch(s)) },
    ...(s.web ? [{ label: "Sitio web", sub: s.web.replace(/^https?:\/\/(www\.)?/, ""), fn: () => open(s.web) }] : []),
    { label: "Buscar al decisor en Google", sub: `Director o administración de ${s.name}`, fn: () => open(`https://www.google.com/search?q=${encodeURIComponent(`"${s.name}" ${s.city} director OR administración OR cafetería`)}`) },
  ]);
}
const open = url => window.open(url, "_blank", "noopener");

// ---------- Preparar
const FIT = { alto: ["new", "Encaje alto"], medio: ["lost", "Encaje medio"], bajo: ["client", "Encaje bajo"] };
const known = v => v && !/^(sin datos|desconocid|no (se )?encontr|n\/a|-)/i.test(String(v).trim());
function studyCard(s) {
  if (D.studyWorking) return `<section class="sec study working" aria-live="polite"><h3><span class="l">${icon("sparkles")} Estudio del colegio</span></h3>
    <div class="study-progress"><span class="spin"></span><div><b>Investigando el colegio en la web…</b><p class="muted">Leo su sitio, redes y noticias para armar el perfil y los decisores. Tarda 1 o 2 minutos; podés ir llamando mientras.</p></div></div></section>`;
  if (D.studyErr) return `<div class="callout warn">${icon("alert")}<span>No se pudo hacer el estudio: ${esc(D.studyErr)}</span><button class="btn sm" id="stRetry">Reintentar</button></div>`;
  const st = D.study; if (!st) return "";
  const pf = st.perfil || {};
  const caf = [st.cafeteria?.modelo !== "desconocido" && st.cafeteria?.modelo, st.cafeteria?.detalle].filter(Boolean).join(" · ");
  const facts = [["Niveles", (pf.niveles || []).join(", ")], ["Alumnos", pf.alumnos], ["Cuota", pf.cuota], ["Segmento", pf.segmento], ["Cafetería", caf], ["Red o congregación", pf.red], ["Idiomas", pf.idiomas], ["Sedes", pf.sedes], ["Antigüedad", pf.antiguedad]].filter(([, v]) => known(v));
  const c = st.contacto || {};
  const [fcls, flbl] = FIT[st.fit] || FIT.medio;
  const nf = st.fuentes?.length || 0;
  return `<section class="sec study" aria-labelledby="stH">
    <h3><span class="l" id="stH">${icon("sparkles")} Estudio del colegio</span><span class="pill ${fcls}" title="${esc(st.fit_razon || "")}">${flbl}</span></h3>
    <p class="lead">${esc(st.resumen)}</p>
    ${facts.length ? `<dl class="facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>` : ""}
    ${st.decisores?.length ? `<div class="sub-h">Decisores</div>${st.decisores.map(x => `<div class="person"><div class="t"><b>${esc(x.nombre)}</b><small>${esc(x.cargo)}${x.fuente ? ` · ${/^https?:/.test(x.fuente) ? `<a href="${esc(x.fuente)}" target="_blank" rel="noopener">fuente</a>` : esc(x.fuente)}` : ""}</small></div></div>`).join("")}` : ""}
    ${(c.telefonos?.length || c.emails?.length || c.redes?.length || c.whatsapp) ? `<div class="sub-h">Contacto</div><div class="chips">
      ${(c.telefonos || []).map(t => `<a class="chip" href="${esc(telLink(t))}">${icon("phone", "sm")} ${esc(t)}</a>`).join("")}
      ${[c.whatsapp, ...(c.telefonos || [])].filter(Boolean).slice(0, 1).map(t => `<button class="chip" data-stwa="${esc(t)}">${icon("whatsapp", "sm")} WhatsApp</button>`).join("")}
      ${(c.emails || []).map(m => `<button class="chip" data-stmail="${esc(m)}">${icon("mail", "sm")} ${esc(m)}</button>`).join("")}
      ${(c.redes || []).filter(u => /^https?:\/\//.test(u)).map(u => `<a class="chip" href="${esc(u)}" target="_blank" rel="noopener">${icon("external", "sm")} ${esc(u.replace(/^https?:\/\/(www\.)?/, "").split("/")[0])}</a>`).join("")}</div>` : ""}
    ${(st.senales?.length || st.riesgos?.length) ? `<div class="two-col">
      ${st.senales?.length ? `<div><div class="sub-h">Señales de oportunidad</div><ul class="ticks ok">${st.senales.map(x => `<li>${icon("check", "sm")}<span>${esc(x)}</span></li>`).join("")}</ul></div>` : ""}
      ${st.riesgos?.length ? `<div><div class="sub-h">A tener en cuenta</div><ul class="ticks warn">${st.riesgos.map(x => `<li>${icon("alert", "sm")}<span>${esc(x)}</span></li>`).join("")}</ul></div>` : ""}</div>` : ""}
    <div class="study-foot">
      ${nf ? `<details><summary>${nf} fuente${nf === 1 ? "" : "s"}</summary><ul>${st.fuentes.map(f => `<li><a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.titulo || f.url)}</a></li>`).join("")}</ul></details>` : "<span></span>"}
      <span class="actions"><span class="faint">Actualizado ${esc(ago(st.at))}</span><button class="btn sm ghost" id="stNote">${icon("note", "sm")} Guardar en Pipedrive</button><button class="btn sm ghost icon-only" id="stRefresh" aria-label="Volver a investigar" title="Volver a investigar">${icon("refresh", "sm")}</button></span>
    </div>
  </section>`;
}
function prepBody(s, d) {
  const p = d.playbook, b = D.study || null, m = d.match;
  const me = (S.me.name || "").split(/[\s.@_]/)[0];
  const apertura = (b?.apertura || p.apertura).replace(/\[tu nombre\]/g, me);
  const preguntas = b?.preguntas?.length ? b.preguntas : p.preguntas, objeciones = b?.objeciones?.length ? b.objeciones : p.objeciones;
  const cierre = p.cierre.replace("[día]", shortDay(nextBusinessDay(today()))).replace("[hora]", "10:00");
  const angulo = b?.angulo || s.pitch;
  const decisor = b?.decisores?.[0];
  const warn = clientWarn(s, m);
  const cands = !m.confirmed ? (m.candidates || []) : [];
  return `<div class="stack">
    ${warn ? `<div class="callout warn">${icon("alert")}<span>${esc(warn)}</span></div>` : ""}
    ${cands.length ? `<section class="sec"><h3><span class="l">${icon("building")} ¿Es alguna de estas organizaciones de Pipedrive?</span></h3>${m.orgId ? `<p class="muted" style="margin:0 0 6px">Ahora está vinculado a <b>${esc(m.orgName)}</b>.</p>` : ""}${cands.map(c => `<div class="cand"><span>${esc(c.name)}</span><button class="btn sm" data-org="${c.id}" data-name="${esc(c.name)}">Es esta</button></div>`).join("")}${m.orgId ? `<div class="cand"><span class="muted">Ninguna de estas</span><button class="btn sm ghost" id="unlink">Desvincular</button></div>` : ""}</section>` : ""}
    ${gallery(s)}
    <section class="sec"><h3><span class="l">${icon("phone")} Primeros 15 segundos</span></h3>
      <div class="say">${esc(apertura)}<button class="icon-btn" data-copy="${esc(apertura)}" aria-label="Copiar apertura">${icon("copy")}</button></div>
      <p class="muted" style="margin:10px 0 0;font-size:13.5px">${decisor ? `Preguntá por <b>${esc(decisor.nombre)}</b> (${esc(decisor.cargo)}).` : `Si atiende recepción, pedí el nombre de quien maneja la ${esc(d.market.espacio)} y su mejor horario.`}</p>
    </section>
    <section class="sec"><h3><span class="l">${icon("target")} Situación</span></h3>
      <p style="margin:0">${esc(p.situacion)} <b>${esc(p.objetivo)}</b></p>
      ${angulo ? `<div class="callout ok" style="margin-top:10px">${icon("bolt")}<span><b>Ángulo:</b> ${esc(angulo)}</span></div>` : ""}
    </section>
    <section class="sec"><h3><span class="l">${icon("list")} Preguntas para calificar</span></h3>
      <ol class="qnum">${preguntas.map(q => `<li>${esc(q)}</li>`).join("")}</ol>
    </section>
    <section class="sec"><h3><span class="l">${icon("alert")} Si te dice…</span></h3>${objeciones.map((o, i) => `<details class="obj" ${i === 0 ? "open" : ""}><summary>${esc(o.o)}</summary><p>${esc(o.r)}</p></details>`).join("")}</section>
    <section class="sec"><h3><span class="l">${icon("video")} Cierre</span></h3><div class="say">${esc(cierre)}<button class="icon-btn" data-copy="${esc(cierre)}" aria-label="Copiar cierre">${icon("copy")}</button></div></section>
    ${studyCard(s)}
  </div>`;
}
function bindPrep(s, d) {
  const el = $("drawer");
  bindGallery(s);
  el.querySelector("#stRefresh")?.addEventListener("click", () => loadStudy(s.id, { refresh: true }));
  el.querySelector("#stRetry")?.addEventListener("click", () => loadStudy(s.id));
  el.querySelector("#stNote")?.addEventListener("click", async e => {
    const b = e.currentTarget; b.disabled = true;
    try { const r = await api(`/api/schools/${s.id}/study/note`, { body: {} }); toast("Estudio guardado como nota en Pipedrive", { href: r.orgUrl, action: "Abrir" }); }
    catch (err) { toast(err.message, { type: "err" }); }
    b.disabled = false;
  });
  el.querySelectorAll("[data-stwa]").forEach(b => b.onclick = () => templateMenu(b, s, d, "whatsapp", { phone: b.dataset.stwa }));
  el.querySelectorAll("[data-stmail]").forEach(b => b.onclick = () => templateMenu(b, s, d, "mail", { email: b.dataset.stmail }));
  el.querySelectorAll("[data-copy]").forEach(b => b.onclick = () => copy(b.dataset.copy));
  el.querySelectorAll("[data-org]").forEach(b => b.onclick = () => { D.data = null; draw(); load({ match: { orgId: +b.dataset.org, orgName: b.dataset.name } }); });
  el.querySelector("#unlink")?.addEventListener("click", () => { D.data = null; draw(); load({ match: { orgId: null } }); });
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
function redrawLog() { keepScroll(draw); }

function logBody(s, d) {
  const f = D.form, o = S.outcomes.find(x => x.id === f.outcome);
  const team = S.team || [];
  const ownerOpts = sel => `<option value="">Para mí</option>${team.filter(u => u.id !== S.me.pdUserId).map(u => `<option value="${u.id}" ${String(sel) === String(u.id) ? "selected" : ""}>Para ${esc(u.name)}</option>`).join("")}`;
  const act = D.activityId && d.activities?.find(a => a.id === D.activityId);
  const connected = CONNECTED.includes(f.outcome), qualify = QUALIFY.includes(f.outcome);
  const lostish = ["not_now", "not_interested"].includes(f.outcome) || (f.outcome === "no_answer" && f.lostReason);
  const t = today(), nb = nextBusinessDay(t);
  const warn = clientWarn(s, d.match);
  const pre = S.markets[s.country]?.prefix ? `+${S.markets[s.country].prefix} …` : "Teléfono";
  const dates = [["Hoy", t], ["Mañana", addDays(t, 1)], ...(nb !== addDays(t, 1) ? [["Próx. hábil", nb]] : []), ["En 1 semana", addDays(t, 7)], ["En 1 mes", addDays(t, 30)], ["En 3 meses", addDays(t, 90)]];
  let n = 0;
  return `<div class="stack">
    ${warn ? `<div class="callout warn">${icon("alert")}<span>${esc(warn)}</span></div>` : ""}
    ${act ? `<label class="callout info toggle" style="color:var(--st-org)"><input type="checkbox" data-f="completeAct" ${f.completeAct ? "checked" : ""}> Marcar como hecha: <b>${esc(act.subject)}</b></label>` : ""}
    <div class="sec step"><div class="step-h"><span class="n">${++n}</span>¿Por dónde fue el contacto?</div>
      <div class="seg" role="group">${CH.map(([k, l, ic]) => `<button data-ch="${k}" aria-pressed="${f.channel === k}">${icon(ic, "sm")} ${l}</button>`).join("")}</div></div>
    <div class="sec step"><div class="step-h"><span class="n">${++n}</span>¿Qué pasó?</div>
      <div class="outcomes">${S.outcomes.map(x => `<button class="oc ${GOOD.includes(x.id) ? "good" : ""}" data-oc="${x.id}" aria-pressed="${f.outcome === x.id}" ${x.id === "demo" && s.status === "client" ? `disabled title="Ya es cliente"` : ""}><b>${esc(x.label)}</b><small>${esc(x.hint)}</small></button>`).join("")}</div></div>
    ${f.outcome === "demo" ? `<div class="sec step"><div class="step-h"><span class="n">${++n}</span>La demo</div>
      <div class="grid3"><label class="field"><span>Día</span><input class="inp" type="date" data-f="demo.date" value="${esc(f.demo.date)}" min="${t}"></label>
      <label class="field"><span>Hora (tu hora local)</span><input class="inp" type="time" data-f="demo.time" value="${esc(f.demo.time)}" step="900"></label>
      <label class="field"><span>Duración</span><select class="inp" data-f="demo.duration">${[20, 30, 45, 60].map(m => `<option value="${m}" ${+f.demo.duration === m ? "selected" : ""}>${m} min</option>`).join("")}</select></label></div>
      <label class="field"><span>¿Quién da la demo?</span><select class="inp" data-f="demo.ownerId">${ownerOpts(f.demo.ownerId).replace("Para mí", "Yo")}</select></label>
      <p class="muted" style="margin:0;font-size:13.5px">${d.match.openDealId ? "Se agenda en el trato abierto." : `Se crea el trato en <b>${esc(pipeName(s))}</b> con fuente «Outbound - Cold Calling» y vos como SDR.`}</p></div>` : ""}
    ${connected ? `<div class="sec step"><div class="step-h"><span class="n">${++n}</span>${f.outcome === "gatekeeper" ? "¿Quién es el decisor?" : "¿Con quién hablaste?"} <span class="faint" style="font-weight:400;font-size:13px">opcional, se crea como contacto</span></div>
      <div class="grid2"><label class="field"><span>Nombre</span><input class="inp" data-f="contact.name" value="${esc(f.contact.name)}" placeholder="Ej: Laura Gómez" autocomplete="off"></label>
      <label class="field"><span>Cargo</span><input class="inp" data-f="contact.role" value="${esc(f.contact.role)}" placeholder="Directora, administrador, concesionario" list="roles"></label>
      <label class="field"><span>Teléfono / WhatsApp</span><input class="inp" type="tel" data-f="contact.phone" value="${esc(f.contact.phone)}" placeholder="${esc(pre)}"></label>
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
      ${f.next.type ? `<div class="chips">${dates.map(([l, v]) => `<button class="chip" data-nd="${v}" aria-pressed="${f.next.date === v}">${l}</button>`).join("")}</div>` : ""}</div>` : ""}
    ${f.outcome ? `<div class="sec step"><div class="step-h"><span class="n">${++n}</span>Notas <span class="faint" style="font-weight:400;font-size:13px">lo que te dijeron, con tus palabras</span></div>
      <textarea class="inp" data-f="text" placeholder="Ej: atendió la secretaria, la cafetería la maneja un concesionario (Don Pedro), llamar después de las 11.">${esc(f.text)}</textarea>
      ${(QUICK[f.outcome] || []).length ? `<div class="quick">${QUICK[f.outcome].map(q => `<button data-quick="${esc(q)}">+ ${esc(q)}</button>`).join("")}</div>` : ""}
      ${S.ai ? `<label class="toggle"><input type="checkbox" data-f="ai" ${f.ai ? "checked" : ""}> Ordenar la nota con IA (resumen, decisor, objeción e interés)</label>` : ""}</div>` : ""}
  </div>`;
}
function pipeName(s) { const mk = S.markets[s.country]; return mk ? `${{ MX: "MX - SALES", PE: "PE - SALES", AR: "ARG - SALES", CL: "CHI - Sales", UY: "UY - SALES" }[mk.code] || "LatAm - SALES"}` : "el embudo del país"; }

function summary(s, d) {
  const f = D.form; if (!f.outcome) return "Elegí qué pasó para guardar.";
  if (s.status === "client" && f.outcome === "demo") return "Ya es cliente: no se crea un trato nuevo.";
  const parts = ["contacto hecho", "nota"];
  if (f.contact.name) parts.push("contacto");
  if (f.outcome === "demo") parts.push(`${d.match.openDealId ? "demo" : "trato + demo"} ${f.demo.date ? shortDay(f.demo.date) : ""} ${f.demo.time || ""}`.trim());
  if (f.next.type && f.next.date) parts.push(`${S.types[f.next.type]?.toLowerCase() || "actividad"} ${shortDay(f.next.date)}`);
  if (f.lostReason && d.match.openDealId) parts.push("trato perdido");
  return `<b>Se guarda en Pipedrive:</b> ${esc(parts.join(" · "))}<span class="kbd-hint faint"> · Ctrl + Enter</span>`;
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
    D.result = { ...r, form: JSON.parse(JSON.stringify(f)) }; D.inCall = false;
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
  if (!d) return toast(D.err ? "No se pudo cargar la ficha. Tocá Reintentar." : "Cargando la ficha…", { type: D.err ? "err" : "info" });
  const list = d.templates.filter(t => t.channel === channel);
  const recommended = channel === "whatsapp" ? (s.status === "lost" ? "reactivate" : d.attempts ? "after_call" : "intro") : (s.status === "lost" ? "mail_reactivate" : "mail_info");
  list.sort((a, b) => (b.id === recommended) - (a.id === recommended));
  openMenu(anchor, [{ head: channel === "whatsapp" ? "Mensaje de WhatsApp" : "Mail desde Gmail" },
    ...list.map(t => ({ label: t.label + (t.id === recommended ? " · sugerido" : ""), sub: channel === "mail" ? t.subject || "" : t.text.split("\n").find(x => x.length > 12) || t.text, fn: () => {
      let text = t.text; if (to.name) text = text.replace(/^Hola(?=[,\s])/, `Hola ${to.name.split(" ")[0]}`);
      messageModal(s, d, { ...t, text }, { phone: to.phone, email: to.email, logAfter: true });
    } })),
    { label: "Mensaje en blanco", sub: "Escribir desde cero", fn: () => messageModal(s, d, { channel, label: "Mensaje", text: "", subject: "" }, { phone: to.phone, email: to.email, logAfter: true }) },
  ]);
}
function messageModal(s, d, t, { phone, email, logAfter }) {
  const isMail = t.channel === "mail";
  const defPhone = phone || d.persons?.find(p => p.phone)?.phone || s.phone || "";
  const defMail = email || d.persons?.find(p => p.email)?.email || D.study?.contacto?.emails?.[0] || s.email || "";
  const pre = S.markets[s.country]?.prefix ? `+${S.markets[s.country].prefix} …` : "Teléfono";
  const m = modal(`<div class="modal-h"><h3>${isMail ? icon("mail") : icon("whatsapp")} ${esc(t.label)}</h3><button class="icon-btn" id="mClose" aria-label="Cerrar">${icon("x")}</button></div>
    <p class="muted" style="margin:-8px 0 0">${esc(s.name)}</p>
    <label class="field"><span>Para</span><input class="inp" id="mTo" type="${isMail ? "email" : "tel"}" value="${esc(isMail ? defMail : defPhone)}" placeholder="${isMail ? "email@colegio.edu" : esc(pre)}"></label>
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
  q("#mClose").onclick = () => m.close();
  // en el celular no se abre el teclado de entrada: el foco va a la acción principal
  if (coarse()) setTimeout(() => q("#mGo").focus(), 0);
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
