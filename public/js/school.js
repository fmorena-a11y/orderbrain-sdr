// Ficha del colegio: preparar el contacto, registrar el resultado e historial. Incluye el modo sesión.
import { $, S, api, esc, icon, pill, statusPill, stageTag, potTag, toast, copy, openMenu, modal, patchSchool, today, addDays, nextBusinessDay, shortDay, dayLabel, localAct, workOrder, ago, TYPE_ICON,
  telLink, waLink, gmailLink, gcalLink, mapsDir, mapsSearch, initials, satLink, satTile, callQueue, callGuess, demoDue, archivedRef, archivedAct, norm, cap } from "./core.js";
import { loadGmail, connectGmail, gmailWaiting, sigPreview, sigLabel } from "./gmail.js";
// «la cafetería», «el casino», «el bar escolar»
const laEsp = mk => `${/^(casino|bar)\b/.test(mk?.espacio || "") ? "el" : "la"} ${mk?.espacio || "cafetería"}`, delaEsp = mk => laEsp(mk).replace(/^el /, "del ").replace(/^la /, "de la ");
const coarse = () => matchMedia("(pointer: coarse)").matches;

const D = { id: null, data: null, tab: "prep", form: null, activityId: null, saving: false, result: null, brief: null, briefLoading: false, err: null, photos: null, study: undefined, studyWorking: false, studyErr: null };
const CH = [["call", "Llamada", "phone"], ["whatsapp", "WhatsApp", "whatsapp"], ["mail", "Mail", "mail"], ["visit", "Visita", "user"]];
const NEXT_TYPES = [["", "Sin próximo paso"], ["call", "Llamada"], ["deadline", "WhatsApp"], ["task", "Mail"], ["contacto_decisor", "Contacto decisor"]];
// Mini calendario del mes (para elegir el día del próximo paso o de la tarea sin abrir otro selector)
const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
function miniCal(sel, min, disabled, month = D.calMonth) {
  const base = month || (sel || min).slice(0, 7);
  const [y, mo] = base.split("-").map(Number), first = new Date(Date.UTC(y, mo - 1, 1)), days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const lead = (first.getUTCDay() + 6) % 7; // semana empieza el lunes
  const ymd = d => `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const cells = [...Array(lead).fill(""), ...Array.from({ length: days }, (_, i) => i + 1)];
  const prevOk = base > min.slice(0, 7);
  return `<div class="mcal${disabled ? " off" : ""}" role="group" aria-label="Elegí el día">
    <div class="mcal-h"><button type="button" class="icon-btn sm" data-cal="-1" ${prevOk && !disabled ? "" : "disabled"} aria-label="Mes anterior">${icon("chevL", "sm")}</button><b>${MONTHS[mo - 1]} ${y}</b><button type="button" class="icon-btn sm" data-cal="1" ${disabled ? "disabled" : ""} aria-label="Mes siguiente">${icon("chevR", "sm")}</button></div>
    <div class="mcal-g">${["L", "M", "M", "J", "V", "S", "D"].map(d => `<span class="dow">${d}</span>`).join("")}${cells.map(d => {
      if (!d) return `<span></span>`;
      const v = ymd(d), past = v < min, wk = [5, 6].includes((lead + d - 1) % 7);
      return `<button type="button" class="d${v === sel ? " on" : ""}${v === min ? " today" : ""}${wk ? " wk" : ""}" data-day="${v}" ${past || disabled ? "disabled" : ""} aria-pressed="${v === sel}" aria-label="${d} de ${MONTHS[mo - 1]}">${d}</button>`;
    }).join("")}</div></div>`;
}
const GOOD = ["callback", "info", "demo"];
// resultados que no necesitan un próximo paso (la demo ya es el próximo paso; el descarte cierra)
const NO_NEXT = ["demo", "not_interested", "bad_data"];
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
// Borradores de Registrar por colegio: si cerrás la ficha a mitad de carga, al volver sigue ahí.
const drafts = new Map();
let pauseToast = null;
export const currentSchoolId = () => (drawerOpen() ? D.id : null);
const newForm = () => ({ channel: "call", outcome: null, contact: { name: "", role: "", phone: "", email: "" }, qual: { cafeteria: "", alumnos: "", niveles: [], sistema: "" },
  demo: { date: nextBusinessDay(today()), time: "10:00", duration: 30, ownerId: "" }, next: { type: "", date: "", time: "", ownerId: "" }, lostReason: "", text: "", ai: true, completeAct: true, nextTouched: false, why: "" });

// ---------- abrir / cerrar
// Abre la ficha de un prospecto (lead) o de una organización de Pipedrive que no está en la base ("lead:…" / "org:…").
export async function openRecord(ref, opts = {}) {
  const [kind, rid] = String(ref).split(/:(.*)/s), ss = S.session;
  try {
    const r = await api(`/api/records/${kind}/${encodeURIComponent(rid)}`); patchSchool(r);
    if (opts.keepSession && (S.session !== ss || ss?.ids[ss.i] !== ref)) return; // la sesión siguió mientras cargaba
    return openSchool(r.id, opts);
  } catch (e) {
    if (opts.keepSession && ss && S.session === ss && ss.ids[ss.i] === ref) { toast(`No pude abrir una tarea de la sesión (${e.message}), la salteé`, { type: "err" }); markSkip(ss, ref, "missing", e.message); return sessionGo(1); }
    toast(e.message, { type: "err" });
  }
}
// En la sesión, las tareas de prospectos u organizaciones fuera de la base van como "lead:…" / "org:…".
const isRef = id => /^(lead|org):/.test(id);
// sref: el colegio de la sesión que se está trabajando (lo que se registre en la ficha queda anotado ahí)
// Un colegio que ya no está en la base (un extra que se sacó, un id viejo) se saltea anotado, como la tarea que no se pudo abrir;
// si la base todavía no cargó (Retomar apenas entrás), se espera.
function openAt(ss, i) {
  ss.i = i; savePos(ss); const r = ss.ids[i];
  if (isRef(r) || S.byId.has(r)) return (isRef(r) ? openRecord : openSchool)(r, { keepSession: true, sref: r, activityId: ss.acts[r] || null, tab: "prep" });
  if (!S.schools.length && !S.baseError && S.baseP) {
    toast("Cargando colegios…", { type: "info" });
    return S.baseP.then(() => { if (S.session === ss && ss.i === i) openAt(ss, i); });
  }
  if (!S.schools.length) { if (!drawerOpen()) S.session = null; return toast(`No pude cargar los colegios${S.baseError ? `: ${S.baseError}` : ""}. Probá de nuevo en un rato.`, { type: "err" }); }
  toast(`${ss.items[i]?.name || "Un colegio de la sesión"} ya no está en la base, lo salteé`, { type: "info" });
  markSkip(ss, r, "missing", "ya no está en la base");
  return sessionGo(1);
}
export async function openSchool(id, { activityId = null, tab = null, keepSession = false, sref = null } = {}) {
  if (!S.byId.has(id)) return toast("Colegio inexistente", { type: "err" });
  if (!keepSession) S.session = null;
  if ($("drawer").hidden) { D.opener = document.activeElement; history.pushState({ ...(history.state || {}), drawer: id }, ""); }
  import("./app.js").then(m => m.rememberSchool(id));
  const draft = drafts.get(id); drafts.delete(id);
  Object.assign(D, { sref: keepSession ? sref || id : null, inCall: false, call: null, id, data: null, form: draft?.form || newForm(), activityId: activityId ?? draft?.activityId ?? null, saving: false, result: null, brief: null, briefLoading: false, err: null, photos: null, study: undefined, studyWorking: false, studyErr: null, tab: draft ? "log" : tab || (activityId ? "log" : "prep") });
  if (draft) toast("Recuperé lo que estabas cargando", { type: "info" });
  $("drawer").hidden = false; $("scrim").hidden = false;
  $("scrim").onclick = closeSchool;
  $("app").inert = true; document.querySelector(".skip").inert = true; // lo de atrás no recibe foco ni clics
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
  return [...(D.photos || []), ...fromStudy, ...(s.lat == null ? [] : [{ url: satLink(s), kind: "sat", credit: "Vista satelital · Esri, Maxar, Earthstar Geographics" }])];
}
const KIND = { google: "Google Maps", web: "Web del colegio", study: "Web", sat: "Satélite" };
function gallery(s) {
  const list = photoList(s);
  return `<div class="gallery" id="gallery" aria-label="Fotos del colegio">${list.map((p, i) => `<button class="ph ${p.kind}" data-ph="${i}" aria-label="Ver foto ${i + 1} (${KIND[p.kind]})"><img src="${esc(p.kind === "sat" ? satLink(s, { w: 480, h: 300 }) : p.url)}" alt="" loading="lazy" referrerpolicy="no-referrer">${p.kind === "sat" ? `<span class="sat-pin" title="El colegio está acá"></span>` : ""}<span class="cap">${esc(KIND[p.kind])}</span></button>`).join("")}${D.photos === null ? `<div class="ph skel" aria-hidden="true"></div>` : ""}</div>`;
}
function bindGallery(s) {
  const g = $("drawer").querySelector("#gallery"); if (!g) return;
  // la satelital nunca se borra: prueba un tamaño menor y la tesela; si todo falla, queda el botón para abrirla
  g.querySelectorAll("img").forEach(img => {
    const sat = img.closest(".ph.sat"), alt = sat ? [satLink(s, { w: 320, h: 200 }), satTile(s)] : [];
    img.addEventListener("error", () => {
      // la tesela no está centrada en el colegio: ahí no va el punto
      if (alt.length) { img.src = alt.shift(); if (!/\/export\?/.test(img.src)) sat?.querySelector(".sat-pin")?.remove(); return; }
      if (sat) return void img.replaceWith(Object.assign(document.createElement("span"), { className: "ph-fail", innerHTML: `${icon("map")}<span>Ver satélite</span>` }));
      img.closest(".ph")?.remove();
    });
  });
  g.querySelectorAll("[data-ph]").forEach(b => b.onclick = () => lightbox(s, +b.dataset.ph));
}
function lightbox(s, start) {
  const list = photoList(s); let i = start;
  const m = modal(`<div class="lb"><div class="lb-wrap"><img id="lbImg" alt="Foto del colegio" referrerpolicy="no-referrer"><span class="sat-pin lg" id="lbPin" hidden title="El colegio está acá"></span></div><div class="lb-fail" id="lbFail" hidden>${icon("alert")}<span>No se pudo cargar esta foto. Abrila con el botón de abajo.</span></div><div class="lb-bar"><span id="lbCap" class="faint"></span><span class="lb-nav"><a class="btn sm" id="lbExt" target="_blank" rel="noopener">${icon("external", "sm")} <span>Abrir</span></a>${list.length > 1 ? `<button class="icon-btn" id="lbPrev" aria-label="Anterior">${icon("arrowLeft")}</button><button class="icon-btn" id="lbNext" aria-label="Siguiente">${icon("arrowRight")}</button>` : ""}<button class="icon-btn" id="lbClose" aria-label="Cerrar">${icon("x")}</button></span></div></div>`, { onClose: () => $("drawer").querySelector(`[data-ph="${i}"]`)?.focus() });
  m.querySelector(".modal-box").classList.add("wide");
  // La foto grande nunca queda rota: si una versión falla (el servicio satelital a veces devuelve error en ciertos
  // tamaños), prueba la siguiente; al final queda la misma de la miniatura o un aviso con el enlace para abrirla afuera.
  const img = m.querySelector("#lbImg"), fail = m.querySelector("#lbFail"), ext = m.querySelector("#lbExt"), pin = m.querySelector("#lbPin");
  let tries = [], seq = 0;
  const show = () => {
    const p = list[i], my = ++seq;
    tries = p.kind === "sat" ? [satLink(s, { w: 1200, h: 750 }), satLink(s, { w: 1024, h: 640 }), satLink(s, { w: 800, h: 480 }), satLink(s, { w: 480, h: 300 }), satTile(s)] : [p.url];
    fail.hidden = true; img.hidden = false; img.classList.add("loading"); pin.hidden = true;
    // el punto rojo marca el colegio: la foto satelital está centrada en su ubicación (salvo la tesela de respaldo)
    img.onload = () => { if (my === seq) { img.classList.remove("loading"); pin.hidden = !(p.kind === "sat" && /\/export\?/.test(img.src)); } };
    img.onerror = () => {
      if (my !== seq) return;
      if (tries.length) { img.src = tries.shift(); return; }
      img.hidden = true; fail.hidden = false;
    };
    img.src = tries.shift();
    ext.href = p.kind === "sat" ? `https://www.google.com/maps/@${s.lat},${s.lng},180m/data=!3m1!1e3` : p.url;
    ext.querySelector("span").textContent = p.kind === "sat" ? "Abrir en Google Maps" : "Abrir la foto";
    m.querySelector("#lbCap").textContent = `${i + 1} de ${list.length} · ${p.kind === "sat" ? "El punto rojo es el colegio · " : ""}${p.credit || KIND[p.kind]}`;
  };
  const go = d => { i = (i + d + list.length) % list.length; show(); };
  m.querySelector("#lbPrev")?.addEventListener("click", () => go(-1));
  m.querySelector("#lbNext")?.addEventListener("click", () => go(1));
  m.querySelector("#lbClose").onclick = () => m.close();
  m.addEventListener("keydown", e => { if (e.key === "ArrowLeft") go(-1); if (e.key === "ArrowRight") go(1); });
  // deslizar para pasar de foto en el celular
  let x0 = null;
  img.addEventListener("pointerdown", e => (x0 = e.clientX));
  img.addEventListener("pointerup", e => { if (x0 === null) return; const dx = e.clientX - x0; x0 = null; if (dx > 40) go(-1); else if (dx < -40) go(1); });
  show();
}
// El botón Atrás del celular cierra la ficha en vez de cambiar la pantalla de abajo.
addEventListener("popstate", () => { if (drawerOpen()) closeSchool({ fromPop: true }); });
export function closeSchool({ fromPop = false } = {}) {
  if (!drawerOpen()) return;
  if (!fromPop && history.state?.drawer) history.back();
  const closedId = D.id, f = D.form;
  if (closedId && D.tab === "log" && !D.result && (f?.outcome || f?.text?.trim())) drafts.set(closedId, { form: f, activityId: D.activityId });
  // después de un mail sin guardar el próximo paso: queda el borrador (al volver, sigue en Registrar). Si no quedó ninguna
  // actividad (ni la automática ni una tuya), se avisa: el colegio se perdería de vista.
  if (closedId && f?.mail && !D.result) {
    drafts.set(closedId, { form: f, activityId: D.activityId });
    if (!liveBase(f)) setTimeout(() => toast("No agendaste el próximo paso del mail", { type: "err", action: { label: "Agendar", fn: () => openSchool(closedId, { tab: "log" }) } }), 0);
  }
  $("drawer").hidden = true; $("scrim").hidden = true; D.id = null;
  $("app").inert = false; document.querySelector(".skip").inert = false;
  pauseToast?.remove(); pauseToast = null;
  const ss = S.session; S.session = null;
  if (ss) leaveSession(ss);
  // el foco vuelve a la fila del colegio (aunque la vista se haya redibujado) o al contenido. Hoy vuelve a leer las
  // sesiones al redibujarse (loadToday), después de lo que se esté guardando (S.sessSaving).
  import("./app.js").then(m => (S.view === "hoy" || S.view === "agenda") && m.rerender()).then(() => {
    const target = D.opener?.isConnected ? D.opener : document.querySelector(`#main [data-school="${closedId}"], #main [data-id="${closedId}"]`);
    (target || $("main")).focus({ preventScroll: !target });
  });
}
// Lo registrado en la sesión, como en la tarjeta de Hoy: «3 llamadas · 1 WhatsApp · 1 comentario · 2 salteados»
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
export function sessionSummary(ss) {
  const c = { call: 0, whatsapp: 0, mail: 0, visit: 0 }; let demos = 0, comments = 0;
  for (const x of ss.steps || []) { if (x.kind === "contact") { c[x.channel] = (c[x.channel] || 0) + 1; if (x.outcome === "demo") demos++; } else if (x.kind === "comment") comments++; }
  const skipped = (ss.items || []).filter(x => x.state === "skipped").length;
  return [c.call && plural(c.call, "llamada", "llamadas"), c.whatsapp && `${c.whatsapp} WhatsApp`, c.mail && plural(c.mail, "mail", "mails"), c.visit && plural(c.visit, "visita", "visitas"),
    demos && plural(demos, "demo agendada", "demos agendadas"), comments && plural(comments, "comentario", "comentarios"), skipped && plural(skipped, "salteado", "salteados")].filter(Boolean).join(" · ");
}
// Al salir de la sesión (se cerró la ficha o se llegó al final): guarda por dónde iba, avisa lo hecho y qué falta, y si no
// falta nada la deja en terminadas.
function leaveSession(ss) {
  pauseToast?.remove(); pauseToast = null;
  let saved = flushPos(ss);
  const left = pendingOf(ss), sum = sessionSummary(ss);
  if (left > 0) pauseToast = toast(`Sesión en pausa: ${[sum, `faltan ${left}`].filter(Boolean).join(" · ")}`, { action: { label: "Retomar", fn: () => resumeSession(ss.id ? ss.id : ss) } });
  else {
    if (ss.id) saved = saved.then(() => api(`/api/sessions/${ss.id}`, { method: "PATCH", body: { status: "done", reason: "completa" } })).then(r => import("./sessions.js").then(m => m.cacheSession(r.session))).catch(() => {});
    toast(sum ? `Sesión terminada: ${sum}` : "Sesión terminada");
  }
  S.sessSaving = saved;
}
// Retomar: la sesión guardada (por id; sin id, la abierta más reciente que tenga algo pendiente) desde el colegio donde
// quedó, salteando lo ya trabajado. at: un colegio puntual de la sesión (desde «Ver detalle»). Se lee de nuevo del
// servidor por si se trabajó desde otro dispositivo. Una sesión que no se pudo guardar se retoma desde memoria.
export async function resumeSession(id, { at = null } = {}) {
  pauseToast?.remove(); pauseToast = null;
  if (id && typeof id === "object") { const ss = id; if (pendingOf(ss) || at != null) { S.session = ss; openAt(ss, at ?? firstPending(ss)); } return; }
  const open = S.sessions?.open || [];
  id = id || (open.find(v => v.resume >= 0) || open[0])?.id;
  if (!id) return toast("No tenés sesiones abiertas.", { type: "err" });
  const sm = await import("./sessions.js");
  let v = sm.cachedSession(id); // la lista trae solo resúmenes: la sesión entera se lee de nuevo (o la última que respondió)
  try { v = (await api(`/api/sessions/${encodeURIComponent(id)}`)).session; sm.cacheSession(v); }
  catch (e) { if (!v) return toast(e.message, { type: "err" }); }
  const i = at ?? v.resume;
  if (i == null || i < 0) return toast("Ya trabajaste todos los colegios de esta sesión.");
  S.session = useSession(v);
  openAt(S.session, i);
  prefetch();
}
async function load(opts = {}) {
  const id = D.id;
  try {
    let d;
    if (opts.match !== undefined) d = await api(`/api/schools/${id}/match`, { body: opts.match });
    else d = await api(`/api/schools/${id}${opts.refresh ? "?refresh=1" : ""}`);
    if (D.id !== id) return;
    D.data = d; D.err = null; patchSchool(d.school);
    // en la sesión no se trabaja un cliente, un trato abierto ajeno ni algo de otra persona: se saltea aunque ya figure
    // salteado (la revisión de adelante pudo anotarlo mientras la ficha se abría); lo ya trabajado no se toca
    const ss = S.session, cur = ss && D.sref && ss.items.find(x => x.ref === D.sref);
    const why = cur && cur.state !== "worked" && !opts.refresh && opts.match === undefined && skipReason(d.school, !!D.activityId && myDeal(d.match));
    if (why) { toast(`${d.school.name}: ${why.text}, lo salteé`); markSkip(ss, D.sref, why.code, why.text); return sessionGo(1); }
    loadSedes(id); loadEnrich(id); loadHistory(id, d);
  } catch (e) { if (D.id === id) D.err = e.message; }
  if (D.id === id) draw();
}

// ---------- Qué pasó con OrderEAT: cliente, onboarding, churn o perdido. World Dominion + Pipedrive + Slack.
const HIST = new Map();
const wantsHistory = (s, d) => !!(s.ob || s.phase || ["client", "churn", "lost", "stalled"].includes(s.status) || d?.deals?.some(x => x.status !== "open"));
async function loadHistory(id, d) {
  const s = S.byId.get(id); if (!s || HIST.has(id) || !wantsHistory(s, d)) return;
  HIST.set(id, null);
  try { HIST.set(id, await api(`/api/schools/${encodeURIComponent(id)}/history`)); } catch { HIST.delete(id); return; }
  if (D.id === id && D.tab === "prep") keepScroll(draw);
}
// corta un texto largo con «…» (que no parezca otra cosa: «el 10/1» por «el 10/11»)
const clip = (t, n) => t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t;
const INFO_LABEL = k => k.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ").replace(/^./, c => c.toUpperCase());
function historySec(s) {
  const h = HIST.get(s.id); if (!h) return "";
  const b = h.brain, day = v => v ? esc(new Intl.DateTimeFormat("es", { day: "numeric", month: "short", year: "numeric" }).format(new Date(String(v).slice(0, 10) + "T12:00:00"))) : "";
  const deals = h.deals.filter(x => x.status !== "open" || x.clientPipe);
  if (!b && !deals.length && !h.notes.length && !h.slack?.msgs?.length) return "";
  return `<section class="sec" id="histSec"><h3><span class="l">${icon("refresh")} Qué pasó con OrderEAT</span></h3>
    ${b ? `<div class="hist-b"><b>World Dominion: ${esc(b.label)}</b>${b.client ? ` · cliente «${esc(b.client)}»` : ""}${b.site && b.site !== s.name ? ` · sitio «${esc(b.site)}»` : ""}${b.start ? ` · inicio ${day(b.start)}` : ""}
      ${Object.keys(b.info || {}).length ? `<div class="faint" style="font-size:12.5px;margin-top:4px">${Object.entries(b.info).map(([k, v]) => `${esc(INFO_LABEL(k))}: ${esc(/^\d{4}-\d{2}-\d{2}/.test(String(v)) ? day(v) : String(v))}`).join(" · ")}</div>` : ""}</div>` : ""}
    ${deals.length ? `<div class="sub-h">Tratos en Pipedrive${h.orgs > 1 ? ` (${h.orgs} organizaciones con este nombre)` : ""}</div>${deals.map(x => `<div class="act"><span class="ty">${icon("deal")}</span><div class="t"><b><a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title)}</a></b>
      <small>${esc([x.pipeline, x.stage].filter(Boolean).join(" · "))} · ${x.status === "won" ? `ganado ${day(x.won)}` : x.status === "lost" ? `perdido ${day(x.lost)}${x.lostReason ? ` · «${esc(x.lostReason)}»` : ""}` : `abierto desde ${day(x.added)}`}${x.owner ? ` · ${esc(x.owner)}` : ""}</small></div></div>`).join("")}` : ""}
    ${h.notes.length ? `<div class="sub-h">Últimas notas</div>${h.notes.slice(0, 4).map(n => `<details class="obj"><summary>${day(n.at)}${n.author ? ` · ${esc(n.author)}` : ""}${n.deal ? ` · ${esc(n.deal)}` : ""} — ${esc(clip(n.text.split("\n")[0], 90))}</summary><p style="white-space:pre-wrap">${esc(n.text)}</p></details>`).join("")}` : ""}
    ${h.slack?.msgs?.length ? `<div class="sub-h">En Slack (lanzamientos y bajas)</div>${h.slack.msgs.map(m => { const f = m.fields || {};
      const head = m.kind ? `${esc(m.kind)}${f.reason ? ` — ${esc(f.reason.slice(0, 90))}` : ""}` : esc(m.text.slice(0, 90));
      const who = [f.account && `Account: ${f.account}`, f.onboarder && `Onboarder: ${f.onboarder}`, f.author && `Cargó: ${f.author}`].filter(Boolean).join(" · ");
      return `<details class="obj"><summary>${day(m.at)} · ${head}</summary>${m.kind ? `${f.reason ? `<p><b>Motivo:</b> ${esc(f.reason)}</p>` : ""}${f.before ? `<p class="faint">Estado previo: ${esc(f.before)}</p>` : ""}${who ? `<p class="faint">${esc(who)}</p>` : ""}${f.place ? `<p class="faint">${esc(f.site || "")} · ${esc(f.place)}</p>` : ""}` : `<p style="white-space:pre-wrap">${esc(m.text)}</p>`}<a href="${esc(m.url)}" target="_blank" rel="noopener">Abrir en Slack</a></details>`; }).join("")}`
      : h.slackEnabled ? `<p class="faint" style="margin:8px 0 0;font-size:12.5px">${h.slack?.error ? `No pude leer Slack: ${esc(h.slack.error)}` : "No hay mensajes en Slack que nombren a este colegio."}</p>` : ""}
  </section>`;
}

// ---------- tratos y decisores desde la ficha, sin abrir Pipedrive. Cada uno lo suyo; un líder, todo (el servidor lo vuelve a controlar).
const mineOrLeader = ownerId => !!S.profile?.leader || (!!ownerId && ownerId === S.me.pdUserId);
// Solo tratos de venta abiertos: los de clientes (onboarding, clientes, performance) se cambian en Pipedrive.
const stageAt = (x, id) => (x.stages || []).findIndex(st => st.id === id);
function dealOpsHtml(x) {
  if (x.status !== "open" || !x.id || x.clientPipe || !x.stages || !mineOrLeader(x.ownerId)) return "";
  const b = (op, label, cls = "") => `<button class="btn sm ${cls}" data-deal="${x.id}" data-dop="${op}"${op === "stage" ? ' aria-haspopup="menu"' : ""}>${label}</button>`;
  // «Propuesta enviada» solo si el trato todavía no llegó a esa etapa (no lo manda para atrás)
  return `<div class="deal-ops">${x.proposalStage && stageAt(x, x.stageId) < stageAt(x, x.proposalStage) ? b("proposal", `${icon("mail", "sm")} Propuesta enviada`) : ""}${(x.stages || []).length > 1 ? b("stage", "Mover de etapa") : ""}${b("won", `${icon("check", "sm")} Ganado`)}${b("lost", "Perdido", "ghost")}</div>`;
}
const dealOf = (s, id) => [...(D.data?.deals || []), ...(HIST.get(s.id)?.deals || [])].find(x => x.id === id);
function bindDeals(s) {
  $("drawer").querySelectorAll("[data-deal]").forEach(b => b.onclick = () => {
    const x = dealOf(s, Number(b.dataset.deal)); if (!x) return;
    const op = b.dataset.dop, prop = x.stages?.find(st => st.id === x.proposalStage);
    if (op === "proposal" && prop) return dealConfirm(s, x, { action: "proposal" }, `Propuesta enviada: pasa a ${prop.name}`);
    if (op === "won") return dealConfirm(s, x, { action: "won" }, "Marcar como ganado");
    if (op === "lost") return dealConfirm(s, x, { action: "lost" }, "Marcar como perdido");
    if (op === "stage") openMenu(b, [{ head: "Mover a" }, ...x.stages.filter(st => st.id !== x.stageId).map(st => ({ label: st.name, fn: () => dealConfirm(s, x, { action: "stage", stageId: st.id }, `${stageAt(x, st.id) < stageAt(x, x.stageId) ? "Volver" : "Mover"} a ${st.name}`) }))]);
  });
}
// Confirmación antes de escribir en Pipedrive; después, lo que se hizo (con el enlace al trato)
function dealConfirm(s, x, body, title) {
  const lost = body.action === "lost";
  const m = modal(`<div class="modal-h"><h3>${icon("deal")} ${esc(title)}</h3><button class="icon-btn" id="dcX" aria-label="Cerrar">${icon("x")}</button></div>
    <p class="muted" style="margin:-6px 0 0">${esc(x.title)} · ${esc([x.pipeline, x.stage].filter(Boolean).join(" · "))}</p>
    ${lost ? `<label class="field"><span>Motivo</span><select class="inp" id="dcWhy"><option value="">Elegí el motivo</option>${S.lostReasons.map(r => `<option value="${esc(r)}">${esc(r.replace(/\s+/g, " "))}</option>`).join("")}</select></label>` : ""}
    <p class="muted" style="margin:0;font-size:13.5px">Se cambia en Pipedrive y queda una nota en el trato a tu nombre.</p>
    <div class="row" style="justify-content:flex-end;gap:8px"><button class="btn ghost" id="dcNo">Cancelar</button><button class="btn primary" id="dcGo">${icon("check")} Confirmar</button></div>`);
  m.querySelector("#dcX").onclick = m.querySelector("#dcNo").onclick = () => m.close();
  m.querySelector("#dcGo").onclick = async e => {
    const go = e.currentTarget;
    if (lost) { body.reason = m.querySelector("#dcWhy").value; if (!body.reason) { m.querySelector("#dcWhy").focus(); return toast("Elegí el motivo de pérdida", { type: "err" }); } }
    go.disabled = true; go.innerHTML = `<span class="spin"></span> Guardando…`;
    try {
      const r = await api(`/api/schools/${encodeURIComponent(s.id)}/deals/${x.id}`, { body });
      if (r.school) patchSchool(r.school);
      m.querySelector(".modal-box").innerHTML = `<div class="modal-h"><h3>${icon("checkCircle")} Listo</h3></div>${writesList(r.done)}<button class="btn primary block" id="dcOk">Listo</button>`;
      m.querySelector("#dcOk").onclick = () => m.close(); m.querySelector("#dcOk").focus();
      S.today = null; S.agenda = null;
      if (D.id === s.id) { HIST.delete(s.id); load({ refresh: true }); }
    } catch (err) { go.disabled = false; go.innerHTML = `${icon("check")} Confirmar`; toast(err.message, { type: "err" }); }
  };
}
const writesList = done => `<ul class="writes">${done.map(x => `<li${x.warn ? ' class="warn"' : ""}>${icon(x.warn ? "alert" : "check", "sm")}<span>${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.label)}</a>` : esc(x.label)}</span></li>`).join("")}</ul>`;
// Agregar decisor: persona en la organización (o en el prospecto) a tu nombre. En lo de otra persona, no (salvo líder).
const canAddPerson = s => !!S.me.pdUserId && (!!S.profile?.leader || !(s.ownerId && s.ownerId !== S.me.pdUserId));
function addDecisor(s, d) {
  const where = s.leadOnly ? "en el prospecto" : d.match?.orgId ? `en ${d.match.orgName || "la organización"}` : "en una organización nueva";
  const m = modal(`<div class="modal-h"><h3>${icon("user")} Agregar decisor</h3><button class="icon-btn" id="adX" aria-label="Cerrar">${icon("x")}</button></div>
    <p class="muted" style="margin:-6px 0 0">Se crea en Pipedrive a tu nombre, ${esc(where)}.</p>
    <div class="grid2"><label class="field"><span>Nombre</span><input class="inp" id="adName" placeholder="Ej: Laura Gómez" autocomplete="off" required></label>
      <label class="field"><span>Cargo <span class="faint">opcional</span></span><input class="inp" id="adRole" placeholder="Directora, administrador, concesionario" list="adRoles"></label>
      <label class="field"><span>Teléfono <span class="faint">opcional</span></span><input class="inp" type="tel" id="adPhone" placeholder="${esc(S.markets[s.country]?.prefix ? `+${S.markets[s.country].prefix} …` : "Teléfono")}"></label>
      <label class="field"><span>Mail <span class="faint">opcional</span></span><input class="inp" type="email" id="adMail" placeholder="nombre@colegio.edu"></label></div>
    <datalist id="adRoles"><option>Director/a</option><option>Administrador/a</option><option>Concesionario/a ${esc(delaEsp(d.market))}</option><option>Coordinador/a de servicios</option><option>Dueño/a</option></datalist>
    <div class="row" style="justify-content:flex-end;gap:8px"><button class="btn ghost" id="adNo">Cancelar</button><button class="btn primary" id="adGo">${icon("check")} Guardar en Pipedrive</button></div>`);
  const q = sel => m.querySelector(sel);
  q("#adX").onclick = q("#adNo").onclick = () => m.close();
  setTimeout(() => q("#adName").focus());
  q("#adGo").onclick = async e => {
    const go = e.currentTarget, body = { name: q("#adName").value.trim(), role: q("#adRole").value.trim(), phone: q("#adPhone").value.trim(), email: q("#adMail").value.trim() };
    if (!body.name) { q("#adName").focus(); return toast("Escribí el nombre del decisor", { type: "err" }); }
    go.disabled = true; go.innerHTML = `<span class="spin"></span> Guardando…`;
    try {
      const r = await api(`/api/schools/${encodeURIComponent(s.id)}/persons`, { body });
      if (r.school) patchSchool(r.school);
      q(".modal-box").innerHTML = `<div class="modal-h"><h3>${icon("checkCircle")} Decisor agregado</h3></div>${writesList(r.done)}<button class="btn primary block" id="adOk">Listo</button>`;
      q("#adOk").onclick = () => m.close(); q("#adOk").focus();
      if (D.id === s.id) load();
    } catch (err) { go.disabled = false; go.innerHTML = `${icon("check")} Guardar en Pipedrive`; toast(err.message, { type: "err" }); }
  };
}

// ---------- Enriquecer: juntar todo lo que hay del colegio y dejarlo en Pipedrive
const ENR = new Map();
async function loadEnrich(id) {
  if (ENR.has(id)) return;
  ENR.set(id, null);
  try { const r = await api(`/api/schools/${encodeURIComponent(id)}/enrich`); ENR.set(id, r.data || null); } catch { ENR.delete(id); return; }
  if (D.id === id && ENR.get(id) && D.tab === "prep") keepScroll(draw);
}
const enriching = new Set();
async function enrich(s) {
  if (enriching.has(s.id)) return;
  enriching.add(s.id); D.enriching = s.id; draw();
  try {
    const r = await api(`/api/schools/${encodeURIComponent(s.id)}/enrich`, { body: {} });
    ENR.set(s.id, r.data); SEDES.delete(s.id);
    if (D.id === s.id) D.photos = r.photos || D.photos;
    const n = r.data.nuevos || 0, see = D.id === s.id && D.tab !== "prep" ? { action: { label: "Ver datos", fn: () => goTab("prep") } } : {};
    toast(r.note.saved ? `Listo: ${n} dato${n === 1 ? "" : "s"} nuevo${n === 1 ? "" : "s"} en una nota de Pipedrive` : `${n ? `Encontré ${n} dato${n === 1 ? "" : "s"} nuevo${n === 1 ? "" : "s"}. ` : ""}${r.note.reason || ""}`, r.note.saved ? { href: r.note.url, action: "Abrir" } : { type: n ? "info" : "err", ...see });
    loadSedes(s.id);
    if (S.study && !D.study && !D.studyWorking && S.byId.get(s.id)?.lat != null) loadStudy(s.id, { refresh: true }); // con IA, además el estudio (decisores)
  } catch (e) { toast(e.message, { type: "err" }); }
  enriching.delete(s.id); if (D.enriching === s.id) D.enriching = null;
  if (D.id === s.id) keepScroll(draw);
}
const KIND_E = { tel: ["phone", "Teléfonos"], wa: ["whatsapp", "WhatsApp"], mail: ["mail", "Mails"], web: ["external", "Web"], addr: ["map", "Dirección"] };
function enrichSec(s) {
  const e = ENR.get(s.id); if (!e) return "";
  const mx = s.country === "México";
  const row = x => {
    const v = esc(x.value), src = `<span class="tag${x.known ? " faint" : ""}">${esc(x.known ? `ya estaba · ${x.src}` : x.src)}</span>`;
    const dig = x.value.replace(/\D/g, "").length, short = mx ? dig < 10 && !/^\+/.test(x.value) : dig < 8;
    if (x.kind === "tel") return `<div class="sede-row">${short ? `<span class="sede-tel">${v}</span><span class="tag" title="Sin código de área: así no se puede marcar">${mx ? "sin lada" : "sin código de área"}</span>` : `<a class="sede-tel" href="${esc(telLink(x.value))}">${v}</a><button class="linkbtn" data-sdwa="${v}">WhatsApp</button>`}${src}</div>`;
    if (x.kind === "wa") return `<div class="sede-row"><button class="linkbtn" data-sdwa="${v}">${v}</button>${src}</div>`;
    if (x.kind === "mail") return `<div class="sede-row"><button class="linkbtn" data-sdmail="${v}">${v}</button>${src}</div>`;
    if (x.kind === "web") return `<div class="sede-row"><a href="${v}" target="_blank" rel="noopener">${esc(x.value.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, ""))}</a>${src}</div>`;
    return `<div class="sede-row"><a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(x.value)}" target="_blank" rel="noopener">${v}</a>${src}</div>`;
  };
  const groups = Object.entries(KIND_E).map(([k, [ic, label]]) => [label, ic, e.items.filter(x => x.kind === k)]).filter(([, , l]) => l.length);
  const nt = e.note || {}, fecha = esc(new Intl.DateTimeFormat("es", { day: "numeric", month: "numeric" }).format(new Date(e.at)));
  return `<section class="sec" id="enrichSec"><h3><span class="l">${icon("building")} Datos del colegio</span><span class="faint" style="font-size:12.5px;font-weight:500">Enriquecido el ${fecha} por ${esc(e.by)}</span></h3>
    <p class="faint" style="margin:0 0 10px;font-size:13px">${nt.saved ? `${icon("check", "sm")} Quedó en una nota de Pipedrive · <a href="${esc(nt.url)}" target="_blank" rel="noopener">abrir</a>` : nt.reason ? `${icon("alert", "sm")} ${esc(nt.reason)}` : ""}</p>
    ${groups.length ? `<div class="enr">${groups.map(([label, ic, l]) => `<div class="enr-g"><div class="sub-h">${icon(ic, "sm")} ${esc(label)}</div>${l.map(row).join("")}</div>`).join("")}</div>` : `<p class="muted" style="margin:0">No encontré teléfonos, mails ni web.</p>`}
    ${e.rating ? `<p class="muted" style="margin:8px 0 0">Google Maps: ${esc(String(e.rating.value))}★ · ${esc(String(e.rating.count))} reseñas</p>` : ""}
    ${e.decisores.length ? `<div class="sub-h" style="margin-top:10px">Decisores</div>${e.decisores.map(d => `<div class="sede-row"><b>${esc(d.nombre)}</b>${d.cargo ? `<span class="muted">${esc(d.cargo)}</span>` : ""}</div>`).join("")}` : ""}
    <p class="faint" style="margin:8px 0 0;font-size:12.5px">Buscado en: su web (${esc(e.sources.web)}) · Google Maps (${esc(e.sources.google)}) · estudio (${esc(e.sources.estudio)})${e.photos ? ` · ${e.photos} foto${e.photos === 1 ? "" : "s"}` : ""}</p>
  </section>`;
}

// ---------- sedes del colegio (planteles): se piden aparte para no demorar la ficha
const SEDES = new Map();
async function loadSedes(id) {
  const c = SEDES.get(id); if (c && (c.loading || Date.now() - c.at < 10 * 60e3)) return;
  SEDES.set(id, { loading: true, at: Date.now() });
  try { SEDES.set(id, { v: await api(`/api/schools/${encodeURIComponent(id)}/sedes`), at: Date.now() }); }
  catch { SEDES.delete(id); return; }
  if (D.id === id && SEDES.get(id)?.v?.sedes?.length) keepScroll(draw);
}
const sedesOf = id => SEDES.get(id)?.v?.sedes || [];
// una sede es de otra persona si su organización o su prospecto abierto está a nombre de alguien más en Pipedrive
const sedeAjena = z => !!(z.ownerId && z.ownerId !== S.me.pdUserId);
// teléfonos que sirven para llamar (los locales sin lada no)
const sedeCallable = z => sedeAjena(z) ? [] : z.phones.filter(p => !p.short).map(p => p.n);
function sedesSec(s) {
  const L = sedesOf(s.id); if (!L.length) return "";
  const link = (u, t) => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(t)}</a>`;
  return `<section class="sec" id="sedes"><h3><span class="l">${icon("building")} ${L.length} sedes</span></h3>
    <div class="sedes">${L.map(z => `<div class="sede${z.here ? " here" : ""}">
      <div class="sede-h"><b>${esc(z.name)}</b>${z.here ? `<span class="tag">esta ficha</span>` : ""}${z.ownerId && z.ownerId !== S.me.pdUserId ? `<span class="tag">de ${esc(z.owner || "otra persona")}</span>` : ""}</div>
      ${sedeAjena(z) ? `<div class="sede-row faint">Es de ${esc(z.owner || "otra persona")} en Pipedrive: hablalo con esa persona antes de contactar.</div>` : ""}
      ${z.phones.map(p => `<div class="sede-row">${p.short || sedeAjena(z) ? `<span class="sede-tel">${icon("phone", "sm")} ${esc(p.n)}</span>${p.short ? `<span class="tag" title="La web lo publica sin código de área">sin lada</span>` : ""}`
        : `<a class="sede-tel" href="${esc(telLink(p.n))}">${icon("phone", "sm")} ${esc(p.n)}</a>${p.lada ? `<span class="tag" title="La web publica ${esc(p.raw)}; la lada ${esc(p.lada)} es la de los otros números de la red">lada de la red</span>` : ""}${p.n.replace(/\D/g, "").length >= 10 ? `<button class="linkbtn" data-sdwa="${esc(p.n)}">WhatsApp</button>` : ""}`}</div>`).join("")}
      ${z.emails.map(e => `<div class="sede-row">${sedeAjena(z) ? `<span>${icon("mail", "sm")} ${esc(e)}</span>` : `<button class="linkbtn" data-sdmail="${esc(e)}">${icon("mail", "sm")} ${esc(e)}</button>`}</div>`).join("")}
      ${z.addr ? `<div class="sede-row"><a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(z.addr)}" target="_blank" rel="noopener">${icon("map", "sm")} ${esc(z.addr)}</a></div>` : ""}
      ${!z.phones.length && !z.emails.length && !z.addr ? `<div class="sede-row faint">Sin teléfono ni dirección cargados.</div>` : ""}
      <div class="sede-f">${[z.url && link(z.url, "Organización en Pipedrive"), ...z.leads.map((l, i) => link(l.url, `Prospecto${z.leads.length > 1 ? ` ${i + 1}` : ""}${l.archived ? " (archivado)" : ""}`)),
        z.schoolId && !z.here ? `<button class="linkbtn" data-sdopen="${esc(z.schoolId)}">Abrir su ficha</button>` : "", `Fuente: ${esc(z.src.join(", "))}`].filter(Boolean).join(" · ")}</div>
    </div>`).join("")}</div>
    ${L.some(z => z.phones.some(p => p.short)) ? `<p class="faint" style="margin:8px 0 0;font-size:12.5px">«Sin lada»: la web lo publica sin código de área, así no se puede marcar. Pedilo o buscalo antes de llamar.</p>` : ""}
  </section>`;
}

// ---------- sesión de llamadas
// Se guarda en el servidor (/api/sessions, lib/sessions.js): sobrevive a recargar la página y se retoma desde otro dispositivo.
// S.session es la que está abierta en la ficha: items (colegios en orden, con su actividad y su estado: pending, worked o
// skipped), steps (lo que pasó con cada uno) e i (por dónde va). ids y acts se derivan de items.
export function useSession(v) {
  return { ...v, items: v.items.map(x => ({ ...x })), steps: [...(v.steps || [])], i: v.pos || 0, ids: v.items.map(x => x.ref), acts: Object.fromEntries(v.items.filter(x => x.act).map(x => [x.ref, x.act])) };
}
const pendingOf = ss => ss.items.filter(x => x.state === "pending").length;
const firstPending = ss => { const n = ss.items.length; for (let k = 0; k < n; k++) { const i = (ss.i + k) % n; if (ss.items[i].state === "pending") return i; } return ss.i; };
// lo que responde el servidor: se toma si no es más viejo que lo que ya hay (los pasos solo crecen)
function mergeSession(ss, v) {
  if (!ss || !v || v.id !== ss.id || (v.steps?.length || 0) < (ss.steps?.length || 0)) return;
  const st = new Map(v.items.map(x => [x.ref, x.state]));
  ss.items.forEach(x => { if (st.has(x.ref)) x.state = st.get(x.ref); });
  Object.assign(ss, { steps: [...v.steps], stats: v.stats, summary: v.summary, updatedAt: v.updatedAt, lastAt: v.lastAt, status: v.status });
  import("./sessions.js").then(m => m.cacheSession(v));
}
// Algo registrado en la ficha dentro de la sesión. Si el servidor no lo anotó (sesión sin guardar o falló), se anota acá.
// sr: la sesión y el colegio de cuando se mandó (la ficha pudo cambiar mientras se guardaba)
function sessionLogged(r, step, sr) {
  // otras sesiones abiertas tuyas con este colegio: el servidor lo anotó ahí como hecho fuera de la sesión
  if (r.sessions?.length) import("./sessions.js").then(m => r.sessions.forEach(m.cacheSession));
  const ss = S.session; if (!ss || !sr || ss.id !== sr.id) return;
  if (r.session) mergeSession(ss, r.session);
  const it = ss.items.find(x => x.ref === sr.ref); if (!it || (r.session && it.state === "worked")) return;
  it.state = "worked"; ss.steps = [...ss.steps, { ref: sr.ref, at: new Date().toISOString(), ...step }];
}
const sessionRef = () => (S.session && D.sref ? { id: S.session.id, ref: D.sref } : undefined);
// Saltear (cliente, archivado, de otra persona, a mano…): queda anotado con el motivo. Lo ya trabajado no se saltea.
export function markSkip(ss, ref, reason, why = "") {
  const it = ss?.items.find(x => x.ref === ref); if (!it || it.state !== "pending") return;
  it.state = "skipped"; ss.steps = [...ss.steps, { ref, kind: "skip", reason, ...(why ? { why } : {}), at: new Date().toISOString() }];
  if (ss.id) api(`/api/sessions/${ss.id}`, { method: "PATCH", body: { skip: { ref, reason, why } } }).then(r => mergeSession(ss, r.session)).catch(() => {});
}
// Por dónde va: se guarda al moverse (con un respiro, por los salteos seguidos) y al cerrar la ficha.
let posTimer = null, posFor = null;
function savePos(ss) { if (!ss.id) return; clearTimeout(posTimer); posFor = ss; posTimer = setTimeout(() => flushPos(ss), 400); }
function flushPos(ss) {
  if (posFor !== ss || !ss.id) return Promise.resolve();
  clearTimeout(posTimer); posFor = null;
  return api(`/api/sessions/${ss.id}`, { method: "PATCH", body: { pos: ss.i } }).then(r => mergeSession(ss, r.session)).catch(() => {});
}
// Sin ids: lo tuyo de hoy primero, después lo vencido y después los mejores prospectos de la cola.
// acts: actividades (con su fecha local) que se trabajan en ese orden; extra: colegios nuevos que van después.
// origin: de dónde salió ({ kind, key, filters }): si ya hay una sesión abierta con el mismo, se ofrece retomarla.
export async function startSession(ids, label = "tu territorio", { acts = null, extra = [], origin = null } = {}) {
  pauseToast?.remove(); pauseToast = null;
  if (!ids && !acts) {
    if (!S.today) { try { const { loadToday } = await import("./today.js"); await loadToday(); } catch (e) { return toast(e.message, { type: "err" }); } }
    const t = today();
    acts = workOrder((S.today.activities.items || []).map(a => ({ ...a, ...localAct(a) })).filter(a => a.date <= t), t);
    extra = callQueue(S.today.queue).slice(0, 25).map(q => q.id); // en el mismo orden que la lista de Hoy
    label = `Tu día · ${new Intl.DateTimeFormat("es", { weekday: "short", day: "numeric", month: "short" }).format(new Date()).replace(",", "")}`;
    origin = origin || { kind: "today", key: `today:${t}`, filters: S.territory.length ? { territorio: S.territory } : null };
  }
  const items = [], seen = new Set(), add = (ref, a = null) => {
    if (!ref || seen.has(ref) || archivedRef(ref) || (a && archivedAct(a))) return; // los archivados no entran en ninguna sesión
    seen.add(ref);
    const sc = S.byId.get(ref) || (a?.schoolId && S.byId.get(a.schoolId));
    items.push({ ref, act: a?.id || null, type: a?.type || null, name: sc?.name || a?.who || a?.subject || null, city: sc?.city || a?.city || null });
  };
  if (acts) { for (const a of acts) add(a.schoolId || a.record, a); for (const id of extra) add(id); }
  else for (const id of ids || []) add(id);
  if (!items.length) return toast("No hay colegios para esta sesión.", { type: "err" });
  // tope de colegios por sesión: se avisa cuántos entran (el servidor guarda hasta S.sessionMax)
  const max = S.sessionMax || 300;
  if (items.length > max) { toast(`La sesión toma los primeros ${max.toLocaleString("es-MX")} de ${items.length.toLocaleString("es-MX")}.`, { type: "info" }); items.length = max; }
  const body = { name: cap(String(label)), origin: origin || { kind: "list", key: `list:${norm(label)}` }, items };
  let r;
  try { r = await api("/api/sessions", { body }); }
  catch (e) {
    // sin servidor la sesión funciona igual en esta pestaña (si recargás, se pierde)
    toast(`No pude guardar la sesión (${e.message}). Funciona igual, pero si recargás la página se pierde.`, { type: "err" });
    return beginSession({ session: { ...body, id: null, pos: 0, steps: [], items: items.map(x => ({ ...x, state: "pending" })) } });
  }
  if (r.existing) return askExisting(r.existing, body);
  beginSession(r);
}
function beginSession(r) {
  if (r.truncated) toast(`La sesión toma los primeros ${r.session.items.length.toLocaleString("es-MX")} de ${(r.session.items.length + r.truncated).toLocaleString("es-MX")}.`, { type: "info" });
  if (r.bumped?.length) toast(`Terminé «${r.bumped.map(b => b.name).join("», «")}», la sesión con menos movimiento: podés tener hasta 12 abiertas.`, { type: "info" });
  if (r.session.id) import("./sessions.js").then(m => m.cacheSession(r.session));
  S.session = useSession(r.session);
  openAt(S.session, 0);
  prefetch();
}
// Ya hay una abierta con el mismo origen (la misma zona, el mismo día…): retomarla o empezar de cero (la vieja queda en terminadas).
function askExisting(v, body) {
  const st = v.stats, m = modal(`<h3>Ya tenés esta sesión abierta</h3>
    <p style="margin:0"><b>${esc(v.name)}</b>: ${st.handled} de ${st.total} · faltan ${st.pending} · última actividad ${esc(ago(v.lastAt))}.</p>
    ${v.summary ? `<p class="muted" style="margin:0">${esc(v.summary)}</p>` : ""}
    <p class="muted" style="margin:0">Si empezás de cero, la anterior queda en terminadas.</p>
    <div class="row"><button class="btn ghost" id="exNo">Cancelar</button><button class="btn" id="exNew">Empezar de cero</button><button class="btn primary" id="exGo" ${v.resume < 0 ? "disabled" : ""}>${icon("play", "sm")} Retomarla</button></div>`);
  m.querySelector("#exNo").onclick = () => m.close();
  m.querySelector("#exGo").onclick = () => { m.close(); resumeSession(v.id); };
  m.querySelector("#exNew").onclick = async () => {
    m.close();
    try { beginSession(await api("/api/sessions", { body: { ...body, replace: v.id } })); } catch (e) { toast(e.message, { type: "err" }); }
  };
}
// Avanza al próximo colegio sin trabajar ni saltear (para atrás, al anterior, sea cual sea). Al final, cierra la ficha.
function sessionGo(delta) {
  const ss = S.session; if (!ss) return;
  let i = ss.i + delta;
  if (delta > 0) while (i < ss.ids.length && ss.items[i].state !== "pending") i++;
  if (i >= ss.ids.length) {
    if (drawerOpen()) return closeSchool();
    // se salteó lo último sin llegar a abrir la ficha (por ejemplo, un colegio que ya no está)
    S.session = null; leaveSession(ss);
    return import("./app.js").then(m => S.view === "hoy" && m.rerender());
  }
  if (i < 0) return;
  openAt(ss, i);
  prefetch();
}
// «Saltar» a mano: lo que ya se trabajó no queda como salteado
function skipCurrent() { const ss = S.session; if (ss) markSkip(ss, ss.ids[ss.i], "manual"); sessionGo(1); }
// Revisa en Pipedrive los próximos colegios de la sesión para no perder tiempo con clientes.
function prefetch() {
  const ss = S.session; if (!ss) return;
  const ids = ss.ids.slice(ss.i + 1, ss.i + 5).filter(id => S.byId.get(id)?.status === "unk");
  if (!ids.length) return;
  api("/api/check", { body: { ids } }).then(r => {
    Object.values(r).forEach(v => !v.error && patchSchool(v));
    if (S.session !== ss) return;
    // solo lo que está adelante de donde va ahora: el colegio abierto lo decide load() con su ficha (si la ficha ya se movió
    // a uno de estos, anotarlo acá lo dejaría abierto y marcado). Con tarea tuya y trato abierto tampoco: load() mira de quién es.
    for (const [id, v] of Object.entries(r)) { const why = !v.error && ss.ids.indexOf(id) > ss.i && skipReason(v, !!ss.acts[id]); if (why) markSkip(ss, id, why.code, why.text); }
  }).catch(() => {});
}

// En una sesión de llamadas no se llama a clientes, ex clientes, tratos abiertos ni organizaciones de otra persona.
// El trato abierto solo no se saltea si el colegio entró por una tarea tuya y el trato es tuyo (si no se sabe de quién es, se saltea).
const myDeal = m => m?.openDealOwnerId ? m.openDealOwnerId === S.me.pdUserId : !!(m?.openDealOwner && S.me.pdName && m.openDealOwner === S.me.pdName);
function skipReason(v, mine = false) {
  if (v.status === "client") return { code: "client", text: "ya es cliente" };
  if (v.status === "churn") return { code: "churn", text: "es ex cliente" };
  if (v.status === "archived") return { code: "archived", text: "está archivado" };
  if (v.status === "open" && !mine) return { code: "open", text: "tiene un trato abierto" };
  if (v.ownerId && S.me.pdUserId && v.ownerId !== S.me.pdUserId) return { code: "owner", text: `es de ${v.ownerName || "otra persona"}` };
  return null;
}
// ---------- render
const focusKey = el => el && (el.id ? `#${el.id}` : ["tab", "oc", "ch", "f", "caf", "niv", "nd", "ph"].map(k => el.dataset?.[k] !== undefined ? `[data-${k}="${el.dataset[k]}"]` : "").find(Boolean));
// «Lo voy a contactar»: se puede crear el prospecto si no es cliente, no tiene trato abierto ni prospecto, y no es de otra persona
// Prospecto → trato: si tiene un prospecto abierto tuyo (o sin dueño) y todavía no hay trato abierto
function canConvert(s, d) {
  if (!d || !S.me.pdUserId || d.match?.status === "open" || d.archive || ["client", "churn", "archived"].includes(s.status)) return false;
  if (s.leadOnly) return !s.ownerId || s.ownerId === S.me.pdUserId || S.profile?.leader;
  return !!d.leads?.some(l => !l.ownerId || l.ownerId === S.me.pdUserId) || (!!S.profile?.leader && !!d.leads?.length);
}
function convertDeal(s) {
  if (D.converting) return;
  const needCountry = !s.country;
  const m = modal(`<div class="modal-h"><h3>${icon("deal")} Convertir a trato</h3><button class="icon-btn" id="cvX" aria-label="Cerrar">${icon("x")}</button></div>
    <p class="muted" style="margin:-6px 0 0">${esc(s.name)} pasa a trato en Pipedrive${s.country ? `, en el embudo de ${esc(s.country)}` : ""}. Las notas, actividades y mails del prospecto pasan al trato y el prospecto se cierra.</p>
    ${needCountry ? `<label class="field"><span>País del colegio</span><select class="inp" id="cvC"><option value="">No sé (queda en LatAm)</option>${S.countries.map(c => `<option>${esc(c)}</option>`).join("")}</select></label>` : ""}
    <div class="row"><button class="btn ghost" id="cvNo">Cancelar</button><button class="btn primary" id="cvGo">${icon("check")} Convertir</button></div>`);
  m.querySelector("#cvX").onclick = m.querySelector("#cvNo").onclick = () => m.close();
  m.querySelector("#cvGo").onclick = async () => {
    const country = m.querySelector("#cvC")?.value || ""; m.close();
    D.converting = s.id; draw();
    try {
      const r = await api(`/api/schools/${encodeURIComponent(s.id)}/convert`, { body: { country } });
      if (r.school) patchSchool(r.school);
      toast(r.done.map(x => x.label).join(" · "), { href: r.url, action: "Abrir trato" });
      if (D.id === s.id) { D.data = await api(`/api/schools/${encodeURIComponent(s.id)}`).catch(() => D.data); }
    } catch (e) { toast(e.message, { type: "err" }); }
    D.converting = null; if (D.id === s.id) draw();
  };
}
function canProspect(s, m) {
  if (s.virtual || !D.data || m?.leadId || D.data.leads?.length || !S.me.pdUserId) return false;
  if (["client", "open", "churn", "archived"].includes(s.status) || s.ob?.client || D.data.archive) return false;
  if (s.ownerId && S.me.pdUserId && s.ownerId !== S.me.pdUserId) return false;
  return true;
}
// «Crear prospecto»: antes de crearlo se elige la primera tarea a futuro (siempre conviene dejar algo para hacer).
// Viene precargada: llamada el próximo día hábil, para vos. Se puede cambiar, asignar a otra persona o, si de verdad
// no hace falta, crear sin tarea.
function createProspect(s) {
  if (D.prospecting) return;
  const t = today(), team = S.team || [];
  const st = { type: "call", date: nextBusinessDay(t), time: "10:00", ownerId: "", subject: "", month: null };
  const m = modal(`<div class="modal-h"><h3>${icon("plus")} Crear prospecto</h3><button class="icon-btn" id="cpX" aria-label="Cerrar">${icon("x")}</button></div>
    <p class="muted" style="margin:-6px 0 0">Se crea en Pipedrive a tu nombre: la institución, el prospecto y el contacto que encontremos. ¿Cuándo lo contactás?</p>
    <div id="cpBody"></div>
    <div class="r" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px"><button class="btn primary" id="cpGo">${icon("check")} Crear y agendar</button><button class="btn ghost" id="cpNo" title="No es lo ideal: sin una tarea a futuro el colegio se pierde de vista">Crear sin tarea</button></div>`);
  const body = m.querySelector("#cpBody");
  const paint = () => {
    body.innerHTML = `<div class="grid2" style="margin-top:12px"><label class="field"><span>Qué</span><select class="inp" id="cpType">${NEXT_TYPES.filter(([k]) => k).map(([k, l]) => `<option value="${k}" ${st.type === k ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      <label class="field"><span>Para</span><select class="inp" id="cpOwner"><option value="">Para mí</option>${team.filter(u => u.id !== S.me.pdUserId).map(u => `<option value="${u.id}" ${String(st.ownerId) === String(u.id) ? "selected" : ""}>Para ${esc(u.name)}</option>`).join("")}</select></label></div>
      <div class="next-when">${miniCal(st.date, t, false, st.month)}<div class="next-side">
        <label class="field"><span>Hora <span class="faint">opcional</span></span><input class="inp" type="time" id="cpTime" value="${esc(st.time)}" step="900"></label>
        <label class="field"><span>Detalle <span class="faint">opcional</span></span><input class="inp" id="cpSub" value="${esc(st.subject)}" placeholder="Ej: preguntar por quien maneja la cafetería" maxlength="140"></label>
        <p class="muted" style="margin:0;font-size:13px">${esc(S.types[st.type] || "Tarea")} el ${esc(dayLabel(st.date).toLowerCase())}${st.time ? ` a las ${esc(st.time)}` : ""} · para ${esc(st.ownerId ? team.find(u => String(u.id) === String(st.ownerId))?.name || "" : "vos")}</p></div></div>`;
    body.querySelector("#cpType").onchange = e => { st.type = e.target.value; paint(); };
    body.querySelector("#cpOwner").onchange = e => { st.ownerId = e.target.value; paint(); };
    body.querySelector("#cpTime").onchange = e => { st.time = e.target.value; paint(); };
    body.querySelector("#cpSub").oninput = e => { st.subject = e.target.value; };
    body.querySelectorAll("[data-day]").forEach(b => b.onclick = () => { st.date = b.dataset.day; paint(); });
    body.querySelectorAll("[data-cal]").forEach(b => b.onclick = () => { const [y, mo] = (st.month || st.date.slice(0, 7)).split("-").map(Number), d = new Date(Date.UTC(y, mo - 1 + Number(b.dataset.cal), 1)); st.month = d.toISOString().slice(0, 7); paint(); });
  };
  paint();
  m.querySelector("#cpX").onclick = () => m.close();
  const go = async withTask => {
    const task = withTask ? { type: st.type, date: st.date, time: st.time || undefined, ownerId: st.ownerId ? Number(st.ownerId) : undefined, subject: st.subject || undefined } : null;
    m.close(); await runProspect(s, task);
  };
  m.querySelector("#cpGo").onclick = () => go(true);
  m.querySelector("#cpNo").onclick = () => go(false);
}
async function runProspect(s, task) {
  D.prospecting = s.id; draw();
  try {
    const r = await api(`/api/schools/${s.id}/prospect`, { body: { task } });
    patchSchool(r.school);
    ENR.delete(s.id); loadEnrich(s.id); // la nota de «Enriquecer» pudo quedar guardada recién
    if (D.id === s.id) api(`/api/schools/${encodeURIComponent(s.id)}`).then(nd => { if (D.id === s.id) { D.data = nd; draw(); } }).catch(() => {});
    if (D.prospecting === s.id) D.prospecting = false;
    const f = r.found || {};
    const html = `<div class="modal-h"><h3>${icon("checkCircle")} Prospecto creado · ${esc(s.name)}</h3><button class="icon-btn" id="cpX" aria-label="Cerrar">${icon("x")}</button></div>
      <ul class="writes">${r.done.map(x => `<li${x.warn ? ' class="warn"' : ""}>${icon(x.warn ? "alert" : "check", "sm")}<span>${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.label)}</a>` : esc(x.label)}</span></li>`).join("")}</ul>
      ${task ? "" : `<p class="callout warn" style="margin:0">${icon("alert")}<span>Quedó sin tarea a futuro. Agendá un próximo paso para que no se pierda de vista.</span></p>`}
      <div class="sub-h">A quién contactar</div>
      ${f.decisores?.length ? `<ul class="ticks">${f.decisores.map(d => `<li>${icon("user", "sm")}<span><b>${esc(d.nombre)}</b> · ${esc(d.cargo)}</span></li>`).join("")}</ul>` : `<p class="muted" style="margin:0">Todavía no tenemos el nombre del decisor. Preguntá en recepción quién maneja la cafetería${S.ai ? " o hacé el estudio del colegio" : ""}.</p>`}
      ${f.phones?.length || f.emails?.length || f.whatsapp ? `<p style="margin:8px 0 0">${[...(f.phones || []).map(esc), f.whatsapp ? `WhatsApp ${esc(f.whatsapp)}` : "", ...(f.emails || []).map(esc)].filter(Boolean).join(" · ")}</p>` : ""}
      <button class="btn primary block" id="cpGo" style="margin-top:14px">Listo</button>`;
    // el resultado se muestra sobre la ficha correcta; si ya estás en otro colegio, alcanza con un aviso
    if (D.id === s.id) { const m = modal(html); m.querySelector("#cpX").onclick = m.querySelector("#cpGo").onclick = () => m.close(); }
    else toast(`Prospecto creado: ${s.name}`);
    api(`/api/schools/${s.id}`).then(nd => { if (D.id === s.id) { D.data = nd; draw(); } }).catch(() => {});
    S.today = null; S.agenda = null;
    import("./explore.js").then(x => x.refreshExplore({ fit: false }));
  } catch (e) { if (D.prospecting === s.id) D.prospecting = false; if (D.id === s.id) draw(); toast(e.message, { type: "err" }); }
}
// ---------- archivar en la app: no clientes ni lo de otra persona (trato abierto, organización o prospecto; salvo un líder).
// Desarchiva quien archivó, quien lo tiene en Pipedrive o un líder. El servidor revisa lo mismo.
const theirs = id => !!id && id !== S.me.pdUserId;
const othersOwn = (s, d) => theirs(s.ownerId) || !!d.leads?.some(l => theirs(l.ownerId)) || (!!s.leadOnly && (!("leadOwnerId" in d) || theirs(d.leadOwnerId)));
const ownsIt = (s, d) => !!S.me.pdUserId && (s.ownerId === S.me.pdUserId || !!d?.leads?.some(l => l.ownerId === S.me.pdUserId) || d?.leadOwnerId === S.me.pdUserId);
const canArchive = (s, d) => !!d && !d.archive && s.status !== "client" && !s.ob?.client && (!!S.profile?.leader || (!(d.match?.status === "open" && !myDeal(d.match)) && !othersOwn(s, d)));
const canUnarchive = (a, s, d) => !!a && (!!S.profile?.leader || String(a.by || "").toLowerCase() === String(S.me.email || "").toLowerCase() || ownsIt(s, d));
const ddmmOf = iso => { const t = new Date(iso); return isNaN(t) ? "?" : `${String(t.getDate()).padStart(2, "0")}/${String(t.getMonth() + 1).padStart(2, "0")}`; };
const archBox = (a, s, d) => `<div class="arch-box">${icon("archive")}<span>Archivado por <b>${esc(a.byName || "?")}</b> el ${ddmmOf(a.at)}: ${esc(a.reason)}${a.text ? ` — ${esc(a.text)}` : ""}</span>${canUnarchive(a, s, d) ? `<button class="btn sm" id="aUnarch">${D.archiving ? `<span class="spin"></span> Desarchivando…` : "Desarchivar"}</button>` : ""}</div>`;
async function afterArchive(s, r) {
  if (r.school) patchSchool(r.school);
  toast(r.done.map(x => x.label).join(" · "), r.done.some(x => x.warn) ? { type: "info", ms: 10000 } : {});
  if (D.id === s.id) { D.data = await api(`/api/schools/${encodeURIComponent(s.id)}`).catch(() => D.data); }
  S.today = null; S.agenda = null;
  import("./explore.js").then(x => x.refreshExplore({ fit: false }));
}
function archiveSchool(s) {
  if (D.archiving) return;
  const reasons = S.archiveReasons || [];
  const m = modal(`<div class="modal-h"><h3>${icon("archive")} Archivar</h3><button class="icon-btn" id="arX" aria-label="Cerrar">${icon("x")}</button></div>
    <p class="muted" style="margin:-6px 0 0">${esc(s.name)} sale de la cola, de las sesiones y de «para llamar». En Pipedrive solo se toca lo tuyo o lo libre.</p>
    <label class="field"><span>Motivo</span><select class="inp" id="arWhy"><option value="">Elegí el motivo</option>${reasons.map(r => `<option>${esc(r)}</option>`).join("")}</select></label>
    <label class="field"><span>Caso <span class="faint" id="arOpt">opcional</span></span><textarea class="inp" id="arTxt" rows="3" maxlength="500" placeholder="Ej: es una academia de inglés, no un colegio"></textarea></label>
    <div class="row"><button class="btn ghost" id="arNo">Cancelar</button><button class="btn primary" id="arGo" disabled>${icon("archive")} Archivar</button></div>`);
  const why = m.querySelector("#arWhy"), txt = m.querySelector("#arTxt"), go = m.querySelector("#arGo");
  const check = () => { const otro = why.value === "Otro"; m.querySelector("#arOpt").textContent = otro ? "obligatorio" : "opcional"; go.disabled = !why.value || (otro && !txt.value.trim()); };
  why.onchange = txt.oninput = check;
  m.querySelector("#arX").onclick = m.querySelector("#arNo").onclick = () => m.close();
  go.onclick = async () => {
    const body = { reason: why.value, text: txt.value.trim() }; m.close();
    D.archiving = s.id; draw();
    try { await afterArchive(s, await api(`/api/schools/${encodeURIComponent(s.id)}/archive`, { body })); }
    catch (e) { toast(e.message, { type: "err" }); }
    D.archiving = null; if (D.id === s.id) draw();
  };
}
async function unarchiveSchool(s) {
  if (D.archiving) return;
  D.archiving = s.id; draw();
  try { await afterArchive(s, await api(`/api/schools/${encodeURIComponent(s.id)}/unarchive`, { body: {} })); }
  catch (e) { toast(e.message, { type: "err" }); }
  D.archiving = null; if (D.id === s.id) draw();
}
function clientWarn(s, m) {
  if (s.ownerId && S.me.pdUserId && s.ownerId !== S.me.pdUserId && s.status !== "client") return `Esta organización es de ${s.ownerName || "otra persona"} en Pipedrive. No la contactes: si te interesa, hablalo con esa persona.`;
  if (s.status === "client") return s.ob && !s.ob.churn ? `Ya es cliente de OrderEAT en OrderBrain (${s.ob.label}${s.ob.client && s.ob.client !== s.name ? `, ${s.ob.client}` : ""}). No lo prospectes: si hay algo, avisale al equipo de cuentas.` : "Ya es cliente de OrderEAT. No lo prospectes: si hay algo, avisale al equipo de cuentas.";
  if (s.ob?.churn || s.phase === "churn") return s.ob?.label && s.ob.label !== "Churn" ? `${s.ob.label} en OrderEAT (firmó y no llegó a usarlo). Antes de contactar, hablá con el equipo de cuentas para saber qué pasó.` : "Ex cliente de OrderEAT (era activo y se dio de baja). Antes de contactar, hablá con el equipo de cuentas para saber por qué se fue.";
  if (s.status === "open") return `Tiene un trato abierto${m?.openDealOwner ? ` de ${m.openDealOwner}` : ""}. Coordiná con esa persona antes de contactar.`;
  return "";
}
function draw() {
  const el = $("drawer"); if (!D.id) return;
  const fk = el.contains(document.activeElement) ? focusKey(document.activeElement) : null;
  const s = S.byId.get(D.id), d = D.data, m = d?.match, ss = S.session;
  if (d?.archive && D.tab === "log") D.tab = "prep"; // archivado: no se registran contactos (primero se desarchiva)
  const here = sedesOf(s.id).find(z => z.here), sedePhones = sedesOf(s.id).filter(z => sedeCallable(z).length).length;
  const phone = s.phone || (here && sedeCallable(here)[0]) || "";
  const mk = d?.market || S.markets[s.country] || {};
  const nHist = d ? histItems(d).length : 0;
  const notReady = !d ? `disabled title="${D.err ? "No se pudo cargar la ficha" : "Cargando la ficha…"}"` : "";
  el.innerHTML = `
  ${ss ? `<div class="d-session"><span class="progress" aria-hidden="true"><span style="width:${(ss.i + 1) / ss.ids.length * 100}%"></span></span>
    <span class="lbl">${icon("play", "sm")} <span class="ell"><b>${ss.i + 1}</b>/${ss.ids.length}<span class="hide-sm"> · ${esc(ss.name || "sesión")}</span></span></span>
    <button class="btn sm ghost" id="prev" ${ss.i ? "" : "disabled"} aria-label="Colegio anterior">${icon("arrowLeft", "sm")}</button><button class="btn sm" id="skip">${icon("skip", "sm")} Saltar</button></div>` : ""}
  <div class="d-top">
    <div class="d-title"><div class="tt"><h2 id="dTitle">${esc(s.name)}</h2><div class="sub">${esc([s.addr, s.city, s.country].filter(Boolean).join(", "))}</div></div>
      <div class="d-tr">${statusPill(s)}${d?.orgUrl ? `<a class="icon-btn" href="${esc(d.orgUrl)}" target="_blank" rel="noopener" title="Abrir en Pipedrive" aria-label="Abrir en Pipedrive">${icon("external")}</a>` : ""}<button class="icon-btn" id="dClose" aria-label="Cerrar ficha" title="Cerrar (Esc)">${icon("x")}</button></div></div>
    <div class="d-meta">
      ${statusPill(s)}${stageTag({ ...s, status: m?.status === "open" ? "open" : s.status, lead: s.lead || !!d?.leads?.length || !!s.leadOnly })}${potTag(s)}
      ${mk.espacio ? `<span class="tag" title="Decí «${esc(mk.espacio)}» y tratá de ${mk.trato === "vos" ? "vos" : "tú"}">«${esc(mk.espacio)}» · ${mk.trato === "vos" ? "vos" : "tú"}</span>` : ""}
      ${s.hours ? `<span class="tag" title="Horario">${icon("clock", "sm")} ${esc(s.hours)}</span>` : ""}
      ${s.rating ? `<span class="tag" title="Reseñas en Google">★ ${esc(s.rating)}</span>` : ""}
      ${(s.opp || []).filter(o => !/^Privado confirmado/.test(o)).map(o => `<span class="tag">${esc(o)}</span>`).join("")}
      ${d?.attempts ? `<span class="tag">${d.attempts} intento${d.attempts > 1 ? "s" : ""} sin respuesta</span>` : ""}
      ${s.lastTouch ? `<span class="tag">Último: ${esc(s.lastTouch.outcome.toLowerCase())} ${esc(ago(s.lastTouch.at))}</span>` : ""}
      ${m?.openDealOwner ? `<span class="tag">${icon("deal", "sm")} Trato de ${esc(m.openDealOwner)}</span>` : ""}
    </div>
    ${d?.archive ? archBox(d.archive, s, d) : ""}
    <div class="d-actions">
      ${phone ? `<a class="btn primary" id="aCall" href="${esc(telLink(phone))}">${icon("phone")} Llamar <span class="num">${esc(phone)}</span></a>` : sedePhones ? `<button class="btn primary" id="aSedes">${icon("phone")} Teléfonos de ${sedePhones} sede${sedePhones > 1 ? "s" : ""}</button>` : `<span class="btn" aria-disabled="true" title="No hay teléfono publicado">${icon("phone")} Sin teléfono</span>`}
      <button class="btn wa" id="aWa" ${notReady} aria-haspopup="menu">${icon("whatsapp")} WhatsApp</button>
      <button class="btn" id="aMail" ${notReady} aria-haspopup="menu">${icon("mail")} Mail</button>
      <button class="btn" id="aDemo" ${notReady} ${s.status === "client" ? `disabled title="Ya es cliente"` : d?.archive ? `disabled title="Está archivado: desarchivalo para registrar"` : ""}>${icon("video")} Demo</button>
      ${!s.virtual && d?.leads?.length ? `<a class="btn" href="${esc(d.leads[0].url)}" target="_blank" rel="noopener" title="${esc(d.leads.length > 1 ? `Tiene ${d.leads.length} prospectos abiertos en Pipedrive` : `Ya tiene prospecto en Pipedrive${d.leads[0].owner ? ` (de ${d.leads[0].owner})` : ""}: no se crea otro`)}">${icon("lead")} Prospecto${d.leads.length > 1 ? `s (${d.leads.length})` : ""}${d.leads[0].ownerId && d.leads[0].ownerId !== S.me.pdUserId && d.leads[0].owner ? ` de ${esc(d.leads[0].owner.split(" ")[0])}` : ""}</a>` : ""}
      ${canConvert(s, d) ? `<button class="btn" id="aConvert" title="Pasa el prospecto a trato en el embudo del país. Las notas y actividades pasan al trato.">${D.converting === s.id ? `<span class="spin"></span> Convirtiendo…` : `${icon("deal")} Convertir a trato`}</button>` : ""}
      ${canProspect(s, m) ? `<button class="btn" id="aProspect" title="Crear el prospecto (y la organización si falta) a tu nombre en Pipedrive y buscar a quién contactar">${D.prospecting === s.id ? `<span class="spin"></span> Creando…` : `${icon("plus")} Crear prospecto`}</button>` : ""}
      <button class="btn" id="aEnrich" ${notReady} title="Buscar todo lo que hay del colegio (Pipedrive, su web, Google Maps y sedes) y dejarlo en una nota en Pipedrive">${enriching.has(s.id) ? `<span class="spin"></span> Buscando…` : `${icon("sparkles")} Enriquecer`}</button>
      ${canArchive(s, d) ? `<button class="btn" id="aArchive" title="No es un colegio, cerró, duplicado…: sale de la cola y de las sesiones">${D.archiving === s.id ? `<span class="spin"></span> Archivando…` : `${icon("archive")} Archivar`}</button>` : ""}
      <button class="btn icon-only" id="aMore" aria-haspopup="menu" aria-label="Más: mapa, web y buscar al decisor" title="Mapa, web y buscar al decisor">${icon("nav")}</button>
    </div>
    ${D.inCall && D.tab !== "log" && !d?.archive ? `<button class="call-banner" id="toLog">${icon("phone", "sm")} ¿Cortaste? Registrá cómo te fue ${icon("arrowRight", "sm")}</button>` : ""}
  </div>
  <div class="tabs" role="tablist" aria-label="Secciones de la ficha">
    ${[["prep", "Preparar"], ["log", "Registrar"], ["hist", "Historial"]].filter(([k]) => k !== "log" || !d?.archive).map(([k, l]) => `<button class="tab" role="tab" id="tab-${k}" data-tab="${k}" aria-selected="${D.tab === k}" aria-controls="dBody" tabindex="${D.tab === k ? 0 : -1}">${l}${k === "hist" && nHist ? `<span class="n">${nHist}</span>` : ""}</button>`).join("")}
  </div>
  <div class="d-body" id="dBody" role="tabpanel" aria-labelledby="tab-${D.tab}" aria-busy="${!d && !D.err}">${S.demo ? `<div class="callout warn demo-note">${icon("alert")}<span><b>Datos de prueba.</b> Pipedrive todavía no está conectado: los tratos, notas y personas de esta ficha son inventados y no son los de tu cuenta.</span></div>` : ""}${D.err ? `<div class="callout err">${icon("alert")}<span>No se pudo cargar la ficha: ${esc(D.err)}</span><button class="btn sm" id="retry">Reintentar</button></div>` : !d ? loadingBody() : D.tab === "prep" ? prepBody(s, d) : D.tab === "log" ? (D.result ? resultBody(s, d) : logBody(s, d)) : histBody(s, d)}</div>
  ${D.tab === "log" && d && !D.result ? `<div class="d-foot"><div class="sum" id="sum">${summary(s, d)}</div><button class="btn primary lg" id="save" ${saveDisabled(s) ? "disabled" : ""}>${D.saving ? `<span class="spin"></span> Guardando…` : saveLabel()}</button></div>` : ""}`;
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
  toTabs();
}
// Lleva el scroll a las pestañas (en celular scrollea toda la ficha; las pestañas son fijas y su offsetTop no sirve).
function toTabs() {
  const el = $("drawer"), top = el.querySelector(".d-top");
  const natural = top.offsetTop + top.offsetHeight - (el.querySelector(".d-session")?.offsetHeight || 0);
  if (el.scrollTop > natural) el.scrollTop = natural;
  const b = el.querySelector("#dBody"); if (b) b.scrollTop = 0;
}

function bindTop(s, d) {
  const el = $("drawer");
  el.querySelector("#dClose").onclick = closeSchool;
  el.querySelector("#retry")?.addEventListener("click", () => { D.err = null; draw(); load(); });
  el.querySelector("#prev")?.addEventListener("click", () => sessionGo(-1));
  el.querySelector("#skip")?.addEventListener("click", skipCurrent);
  const tabs = [...el.querySelectorAll("[data-tab]")];
  tabs.forEach((b, k) => {
    b.onclick = () => goTab(b.dataset.tab);
    b.onkeydown = e => { const n = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0; if (n) { e.preventDefault(); const t = tabs[(k + n + tabs.length) % tabs.length]; goTab(t.dataset.tab); $("drawer").querySelector(`[data-tab="${t.dataset.tab}"]`).focus(); } };
  });
  // Llamar no saca del guion: en celular, al volver de la llamada se abre Registrar; en escritorio queda un aviso.
  el.querySelector("#aSedes")?.addEventListener("click", () => { if (D.tab !== "prep") goTab("prep"); setTimeout(() => $("drawer").querySelector("#sedes")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50); });
  el.querySelector("#aCall")?.addEventListener("click", () => {
    D.inCall = true; D.form.channel = "call"; D.call = null; draw();
    if (coarse()) {
      // al volver: cuánto duró. Corta (<25 s) preselecciona «No atendió» con su próximo paso; nada se guarda solo, el SDR confirma.
      const t0 = Date.now(), back = () => {
        if (document.visibilityState !== "visible") return; document.removeEventListener("visibilitychange", back);
        if (!D.inCall || D.id !== s.id) return;
        const g = callGuess(Date.now() - t0), pre = g?.outcome && !D.form.outcome && S.outcomes.some(o => o.id === g.outcome);
        D.call = g && (pre || !g.outcome) ? { note: g.note, outcome: pre ? g.outcome : null } : null;
        if (pre) { D.form.outcome = g.outcome; D.form.channel = g.channel; D.form.lostReason = ""; }
        D.result = null; goTab("log"); if (D.call) $("drawer").querySelector(".call-dur")?.scrollIntoView({ block: "center" }); if (pre) suggest(s);
      };
      document.addEventListener("visibilitychange", back);
    }
  });
  el.querySelector("#toLog")?.addEventListener("click", () => { D.result = null; goTab("log"); });
  el.querySelector("#aWa").onclick = e => templateMenu(e.currentTarget, s, d, "whatsapp");
  el.querySelector("#aMail").onclick = e => templateMenu(e.currentTarget, s, d, "mail");
  el.querySelector("#aProspect")?.addEventListener("click", () => createProspect(s));
  el.querySelector("#aConvert")?.addEventListener("click", () => convertDeal(s));
  el.querySelector("#aEnrich")?.addEventListener("click", () => enrich(s));
  el.querySelector("#aArchive")?.addEventListener("click", () => archiveSchool(s));
  el.querySelector("#aUnarch")?.addEventListener("click", () => unarchiveSchool(s));
  el.querySelector("#aDemo").onclick = () => {
    D.result = null; D.form.outcome = "demo"; suggest(s); goTab("log");
    const date = $("drawer").querySelector('[data-f="demo.date"]');
    date?.closest(".step")?.scrollIntoView({ block: "start" }); date?.focus();
  };
  el.querySelector("#aMore").onclick = e => openMenu(e.currentTarget, [
    ...(s.lat == null ? [] : [{ label: "Cómo llegar", sub: "Google Maps con la ruta", fn: () => open(mapsDir(s)) }]),
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
  const nd = nextBusinessDay(today());
  const dia = nd === addDays(today(), 1) ? "mañana" : `el ${new Intl.DateTimeFormat("es", { weekday: "long", day: "numeric" }).format(new Date(nd + "T12:00:00"))}`;
  const cierre = p.cierre.replace(/el \[día\]|\[día\]/, dia).replace("[hora]", "10:00");
  const angulo = b?.angulo || s.pitch;
  const decisor = b?.decisores?.[0];
  const warn = clientWarn(s, m);
  const cands = !m.confirmed ? (m.candidates || []) : [];
  return `<div class="stack">
    ${warn ? `<div class="callout warn">${icon("alert")}<span>${esc(warn)}</span></div>` : ""}
    ${historySec(s)}
    ${s.lat == null && !(D.photos || []).length ? "" : gallery(s)}
    ${enrichSec(s)}
    ${sedesSec(s)}
    <section class="sec"><h3><span class="l">${icon("phone")} Primeros 15 segundos</span></h3>
      <div class="say">${esc(apertura)}<button class="icon-btn" data-copy="${esc(apertura)}" aria-label="Copiar apertura">${icon("copy")}</button></div>
      <p class="muted" style="margin:10px 0 0;font-size:13.5px">${d.askFor ? `Preguntá por <b>${esc(d.askFor.name)}</b>${d.askFor.role ? ` (${esc(d.askFor.role)})` : ""}. <span class="faint">Lo dijeron en recepción ${esc(ago(d.askFor.at))}.</span>` : decisor ? `Preguntá por <b>${esc(decisor.nombre)}</b>${decisor.cargo ? ` (${esc(decisor.cargo)})` : ""}.` : `Si atiende recepción, pedí el nombre de quien maneja ${esc(laEsp(d.market))} y su mejor horario.`}</p>
    </section>
    <section class="sec"><h3><span class="l">${icon("target")} Situación</span></h3>
      <p style="margin:0">${esc(p.situacion)} <b>${esc(p.objetivo)}</b></p>
      ${angulo ? `<div class="callout ok" style="margin-top:10px">${icon("bolt")}<span><b>Ángulo:</b> ${esc(angulo)}</span></div>` : ""}
    </section>
    ${cands.length ? `<section class="sec"><h3><span class="l">${icon("building")} ¿Es alguna de estas organizaciones de Pipedrive?</span></h3>${m.orgId ? `<p class="muted" style="margin:0 0 6px">Ahora está vinculado a <b>${esc(m.orgName)}</b>.</p>` : ""}${cands.map(c => candRow(c, d.cands?.[c.id])).join("")}${m.orgId ? `<div class="cand"><span class="muted">Ninguna de estas</span><button class="btn sm ghost" id="unlink">Desvincular</button></div>` : ""}</section>` : ""}
    ${!cands.length && !s.virtual && m.confirmed && !m.auto && m.dupeCount > 0 ? `<section class="sec"><div class="cand"><span class="cand-b"><b>${icon("merge", "sm")} Parece cargada ${m.dupeCount === 1 ? "1 vez más" : `${m.dupeCount} veces más`} en Pipedrive</b><small>Además de «${esc(m.orgName)}». Podés revisarlas y fusionarlas.</small></span><button class="btn sm" id="dupReview">Revisar</button></div></section>` : ""}
    <section class="sec"><h3><span class="l">${icon("list")} Preguntas para calificar</span></h3>
      <ol class="qnum">${preguntas.map(q => `<li>${esc(q)}</li>`).join("")}</ol>
    </section>
    <section class="sec"><h3><span class="l">${icon("alert")} Si te dice…</span></h3>${objeciones.map((o, i) => `<details class="obj" ${i === 0 ? "open" : ""}><summary>${esc(o.o)}</summary><p>${esc(o.r)}</p></details>`).join("")}</section>
    <section class="sec"><h3><span class="l">${icon("video")} Cierre</span></h3><div class="say">${esc(cierre)}<button class="icon-btn" data-copy="${esc(cierre)}" aria-label="Copiar cierre">${icon("copy")}</button></div></section>
    ${s.lat == null ? "" : studyCard(s)}
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
  el.querySelectorAll("[data-sdwa]").forEach(b => b.onclick = () => templateMenu(b, s, d, "whatsapp", { phone: b.dataset.sdwa }));
  el.querySelectorAll("[data-sdmail]").forEach(b => b.onclick = () => templateMenu(b, s, d, "mail", { email: b.dataset.sdmail }));
  el.querySelectorAll("[data-sdopen]").forEach(b => b.onclick = () => openSchool(b.dataset.sdopen));
  el.querySelectorAll("[data-stmail]").forEach(b => b.onclick = () => templateMenu(b, s, d, "mail", { email: b.dataset.stmail }));
  el.querySelectorAll("[data-copy]").forEach(b => b.onclick = () => copy(b.dataset.copy));
  el.querySelectorAll("[data-org]").forEach(b => b.onclick = () => confirmOrg(s, +b.dataset.org, b.dataset.name, b));
  el.querySelector("#unlink")?.addEventListener("click", () => { D.data = null; draw(); load({ match: { orgId: null } }); });
  el.querySelector("#dupReview")?.addEventListener("click", e => reviewDupes(s, e.currentTarget));
}

// ---------- «Es esta» → ¿Estás seguro? (comparar) → vincular → ¿Querés fusionar? (otras organizaciones del mismo colegio)
const DEAL_ST = { open: "abierto", won: "ganado", lost: "perdido" };
const placeOf = o => [o.city, o.region, o.country].filter(Boolean).join(", ");
const ownerOf = o => o.owner || (o.ownerId ? "otra persona" : "libre (cuenta general)");
const callout = (level, text) => `<div class="callout ${level}">${icon("alert")}<span>${esc(text)}</span></div>`;
// una candidata de la lista: ciudad y dueño en Pipedrive (con cuatro «Colegio Valladolid», es lo que las distingue)
function candRow(c, x) {
  const mine = x?.ownerId && x.ownerId === S.me.pdUserId;
  const sub = x ? [x.place || "sin ciudad en Pipedrive", mine ? "tuya" : x.ownerId ? `de ${x.owner || "otra persona"}` : "libre", `id ${c.id}`].join(" · ") : `id ${c.id}`;
  const flag = x?.linked ? `Ya está vinculada a ${x.linked}` : x?.other ? "Es de otra ciudad" : "";
  return `<div class="cand"><span class="cand-b"><span>${esc(c.name)}</span><small>${esc(sub)}</small>${flag ? `<small class="cand-flag">${icon("alert", "sm")}<span>${esc(flag)}</span></small>` : ""}</span><button class="btn sm" data-org="${c.id}" data-name="${esc(c.name)}">Es esta</button></div>`;
}
// los tratos, prospectos y actividades de una organización, uno por línea
const dealLine = x => [x.title, x.pipeline, x.stage, DEAL_ST[x.status] || x.status, x.owner && `de ${x.owner}`].filter(Boolean).join(" · ");
const actLine = x => [x.subject, x.due && fmtDay(x.due), x.owner && `de ${x.owner}`].filter(Boolean).join(" · ");
const fmtDay = v => new Intl.DateTimeFormat("es", { day: "numeric", month: "short" }).format(new Date(v + "T12:00:00"));
const listOr = (l, line, none) => l?.length ? `<ul>${l.slice(0, 5).map(x => `<li>${esc(line(x))}</li>`).join("")}${l.length > 5 ? `<li class="faint">y ${l.length - 5} más</li>` : ""}</ul>` : `<span class="faint">${none}</span>`;
const personsTxt = o => o.persons == null ? "no pude verlas" : o.personsMore ? "20 o más" : String(o.persons);
function orgFacts(o) {
  return `<dl class="kv"><dt>Nombre</dt><dd><b>${esc(o.name)}</b>${o.client ? ` <span class="tag">Cliente</span>` : ""} <span class="faint">id ${o.id}</span></dd>
    <dt>Ciudad</dt><dd>${placeOf(o) ? esc(placeOf(o)) : `<span class="faint">sin ciudad en Pipedrive</span>`}</dd>
    ${o.addr ? `<dt>Dirección</dt><dd>${esc(o.addr)}</dd>` : ""}
    <dt>Dueño</dt><dd>${esc(ownerOf(o))}</dd>
    <dt>Tratos</dt><dd>${listOr(o.deals, dealLine, "ninguno")}</dd>
    <dt>Prospectos</dt><dd>${o.leads == null ? `<span class="faint">no pude verlos</span>` : listOr(o.leads, x => [x.title, x.owner && `de ${x.owner}`].filter(Boolean).join(" · "), "ninguno abierto")}</dd>
    <dt>Pendientes</dt><dd>${o.acts == null ? `<span class="faint">no pude verlas</span>` : listOr(o.acts, actLine, "ninguna")}</dd>
    <dt>Personas</dt><dd>${esc(personsTxt(o))}</dd></dl>`;
}
// después de vincular: lo que se vio de la ficha depende de la organización, se vuelve a pedir (como en load)
function afterLink(s, d) {
  HIST.delete(s.id); SEDES.delete(s.id); S.today = null; S.agenda = null;
  if (D.id === s.id) { D.data = d; patchSchool(d.school); draw(); loadSedes(s.id); loadHistory(s.id, d); }
}
// por qué no se ofrece fusionar (dupesFor sin duplicadas)
const noDupesMsg = (name, r) => r.stop ? `Vinculado a «${name}». ${r.stop}.` : `Vinculado a «${name}»`;
function confirmOrg(s, orgId, orgName, anchor) {
  const m = modal(`<div class="modal-h"><h3>${icon("building")} ¿Estás seguro?</h3><button class="icon-btn" id="coX" aria-label="Cerrar">${icon("x")}</button></div>
    <p class="muted" style="margin:-6px 0 0">Compará antes de vincular el colegio con esta organización de Pipedrive.</p>
    <div id="coWarn" aria-live="polite"></div>
    <div class="cmp">
      <div class="cmp-col"><div class="cmp-h">${icon("map", "sm")} En la base</div><dl class="kv"><dt>Nombre</dt><dd><b>${esc(s.name)}</b></dd>
        <dt>Ciudad</dt><dd>${esc([s.city, s.country].filter(Boolean).join(", ")) || `<span class="faint">sin ciudad</span>`}</dd>${s.addr ? `<dt>Dirección</dt><dd>${esc(s.addr)}</dd>` : ""}</dl></div>
      <div class="cmp-col"><div class="cmp-h">${icon("building", "sm")} En Pipedrive</div><div id="coOrg" aria-live="polite"><p class="muted" style="margin:0"><span class="spin"></span> Trayendo ${esc(orgName)}…</p></div></div>
    </div>
    <div class="row"><button class="btn ghost" id="coNo">Cancelar</button><button class="btn primary" id="coGo" disabled>${icon("check")} Sí, es esta</button></div>`, { onClose: () => anchor?.isConnected && anchor.focus() });
  const q = sel => m.querySelector(sel), url = `/api/schools/${encodeURIComponent(s.id)}`;
  q(".modal-box").classList.add("mid");
  q("#coX").onclick = q("#coNo").onclick = () => m.close();
  api(`${url}/org/${orgId}`).then(r => {
    q("#coOrg").innerHTML = `${orgFacts(r.org)}<a class="btn sm ghost" href="${esc(r.org.url)}" target="_blank" rel="noopener">${icon("external", "sm")} Abrir en Pipedrive</a>`;
    // primero lo que dice que no es esta (rojo), después lo que conviene revisar (ámbar)
    q("#coWarn").innerHTML = (r.warnings || []).map(w => callout(w.level === "err" ? "err" : "warn", w.text)).join("");
    orgName = r.org.name || orgName;
  }).catch(e => { q("#coOrg").innerHTML = callout("err", `No pude traer lo que dice Pipedrive: ${e.message}`); })
    .finally(() => { if (m.isConnected) q("#coGo").disabled = false; });
  q("#coGo").onclick = async e => {
    const go = e.currentTarget; go.disabled = true; go.innerHTML = `<span class="spin"></span> Vinculando…`;
    // mientras vincula y busca duplicadas, no se cierra (Esc o tocar afuera lo cerraban sin avisar el resultado)
    m.locked = true; q("#coX").disabled = q("#coNo").disabled = true;
    let d;
    try { d = await api(`${url}/match`, { body: { orgId, orgName } }); }
    catch (err) { m.locked = false; q("#coX").disabled = q("#coNo").disabled = false; go.disabled = false; go.innerHTML = `${icon("check")} Sí, es esta`; return toast(err.message, { type: "err" }); }
    afterLink(s, d);
    q(".modal-box").innerHTML = `<div class="modal-h"><h3>${icon("checkCircle")} Vinculado a ${esc(orgName)}</h3></div><p class="muted" style="margin:0"><span class="spin"></span> Buscando si está cargada más de una vez…</p>`;
    let r;
    try { r = await api(`${url}/dupes`); }
    catch (err) { m.close(); return toast(`Vinculado a «${orgName}». No pude buscar duplicadas: ${err.message}`, { type: "info", ms: 8000 }); }
    seenDupes(s, r);
    if (!r.dupes?.length) { m.close(); return toast(noDupesMsg(orgName, r), r.stop ? { type: "info", ms: 9000 } : {}); }
    m.locked = false;
    mergeStep(s, m, r, { linked: true });
  };
}
// lo que encontró /dupes también lo guarda el servidor (dupeCount): la ficha de atrás muestra «Parece cargada N veces más»
function seenDupes(s, r) {
  const n = r.stop ? 0 : r.dupes?.length || 0;
  if (D.id === s.id && D.data?.match && (D.data.match.dupeCount || 0) !== n) { D.data.match.dupeCount = n; keepScroll(draw); }
}
// «Revisar» desde la ficha (Parece cargada N veces más): la misma pregunta, sin volver a vincular
async function reviewDupes(s, anchor) {
  const m = modal(`<div class="modal-h"><h3>${icon("merge")} Buscando duplicadas…</h3></div><p class="muted" style="margin:0"><span class="spin"></span> Buscando si está cargada más de una vez…</p>`, { locked: true, onClose: () => anchor?.isConnected && anchor.focus() });
  m.querySelector(".modal-box").classList.add("mid");
  let r;
  try { r = await api(`/api/schools/${encodeURIComponent(s.id)}/dupes`); }
  catch (err) { m.close(); return toast(`No pude buscar duplicadas: ${err.message}`, { type: "err" }); }
  seenDupes(s, r);
  if (!r.dupes?.length) { m.close(); return toast(r.stop ? `${r.stop}.` : "Ya no hay otras organizaciones para fusionar", { type: "info", ms: r.stop ? 9000 : 4200 }); }
  m.locked = false;
  mergeStep(s, m, r, { linked: false });
}
// qué dice cada organización en «¿Querés fusionar?»: ciudad, dueño, tratos, prospectos, pendientes, personas e id
const orgSub = o => [placeOf(o) || "sin ciudad en Pipedrive", o.owner ? `de ${o.owner}` : o.ownerId ? "de otra persona" : "libre",
  o.deals.length ? plural(o.deals.length, "trato", "tratos") + ` (${[...new Set(o.deals.map(x => DEAL_ST[x.status] || x.status))].join(", ")})` : "sin tratos",
  o.leads == null ? "" : o.leads.length ? plural(o.leads.length, "prospecto", "prospectos") : "",
  o.acts?.length ? plural(o.acts.length, "pendiente", "pendientes") : "",
  o.persons == null ? "" : !o.persons ? "sin personas" : plural(o.personsMore ? 20 : o.persons, "persona", "personas") + (o.personsMore ? " o más" : ""), `id ${o.id}`].filter(Boolean).join(" · ");
// «También hay «Instituto Valladolid Primaria» en Morelia y «Colegio Valladolid» en Aguascalientes, Mexicali y 6 más»
const joinY = l => l.length > 1 ? `${l.slice(0, -1).join(", ")} y ${l.at(-1)}` : l[0] || "";
const citiesTxt = c => c.length > 3 ? `${c.slice(0, 2).join(", ")} y ${c.length - 2} más` : joinY(c);
function elsewhereTxt(o) {
  const g = o.elsewhereAt || [];
  if (!g.length) return o.elsewhere ? `hay ${plural(o.elsewhere, "colegio", "colegios")} con este nombre en otras ciudades` : "";
  const parts = g.slice(0, 3).map(x => `«${x.name}» en ${x.cities.length ? citiesTxt(x.cities) : "otra ciudad"}`);
  const rest = g.slice(3).reduce((n, x) => n + Math.max(1, x.cities.length), 0);
  return `también hay ${joinY(rest ? [...parts, `${plural(rest, "colegio", "colegios")} más`] : parts)}`;
}
// lo bloqueado: qué hacer (un cliente ya dice que lo fusiona un líder; si no se pudo leer, probar después)
const blockHint = b => /líder/.test(b) ? "" : /^No pude/.test(b) ? ": probá de nuevo en un rato" : ": avisale a esa persona o a un líder";
function mergeStep(s, m, r, { linked = true } = {}) {
  const q = sel => m.querySelector(sel), k = r.keep;
  q(".modal-box").classList.add("mid");
  q(".modal-box").innerHTML = `<div class="modal-h"><h3>${icon("merge")} ¿Querés fusionar?</h3><button class="icon-btn" id="mgX" aria-label="Cerrar">${icon("x")}</button></div>
    <p class="muted" style="margin:-6px 0 0">${linked ? "Quedó vinculado. " : ""}${r.dupes.length === 1 ? "Esta organización parece el mismo colegio" : "Estas organizaciones parecen el mismo colegio"}. Las que marques pasan a la que queda.</p>
    <div class="dup keep"><span class="dup-b"><span class="dup-k">Queda</span><b>${esc(k.name)}</b>${k.client ? ` <span class="tag">Cliente</span>` : ""}<small>${esc(orgSub(k))}</small></span>
      <a class="icon-btn" href="${esc(k.url)}" target="_blank" rel="noopener" aria-label="Abrir ${esc(k.name)} en Pipedrive" title="Abrir en Pipedrive">${icon("external")}</a></div>
    <div class="dups" role="group" aria-label="Organizaciones para fusionar">${r.dupes.map(o => `<div class="dup${o.block ? " off" : ""}"><label><input type="checkbox" data-mid="${o.id}" ${o.block ? "disabled" : o.sameCity ? "checked" : ""}>
      <span class="dup-b"><b>${esc(o.name)}</b>${o.client ? ` <span class="tag">Cliente</span>` : ""}<small>${esc(orgSub(o))}</small>
      ${o.block ? `<small class="dup-lock">${icon("lock", "sm")}<span>${esc(o.block + blockHint(o.block))}</span></small>` : !o.sameCity ? `<small class="dup-why">${icon("alert", "sm")}<span>${esc(`No dice la ciudad${o.elsewhere ? ` y ${elsewhereTxt(o)}` : ""}: fijate que sea este.`)}</span></small>` : ""}</span></label>
      <a class="icon-btn" href="${esc(o.url)}" target="_blank" rel="noopener" aria-label="Abrir ${esc(o.name)} en Pipedrive" title="Abrir en Pipedrive">${icon("external")}</a></div>`).join("")}</div>
    ${callout("warn", `Las marcadas se borran de Pipedrive y todo (tratos, prospectos, personas, notas y actividades) pasa a «${k.name}» (id ${k.id}). No se puede deshacer.`)}
    ${r.keepBlock ? callout("err", `«${k.name}»: ${r.keepBlock}. Avisale a esa persona o a un líder.`) : r.dupes.some(o => o.client) ? `<div class="callout info">${icon("alert")}<span>Hay un cliente: revisá que sea la misma sede antes de fusionar.</span></div>` : ""}
    <div class="row"><button class="btn ghost" id="mgNo">No fusionar</button><button class="btn primary" id="mgGo">${icon("merge")} Fusionar</button></div>`;
  const boxes = [...m.querySelectorAll("[data-mid]")], go = q("#mgGo");
  const check = () => { go.disabled = !!r.keepBlock || !boxes.some(b => b.checked); };
  boxes.forEach(b => b.onchange = check); check();
  // sin fusionar: la ficha sigue mostrando «Parece cargada N veces más · Revisar»
  q("#mgX").onclick = q("#mgNo").onclick = () => { m.close(); toast(`${linked ? `Vinculado a «${k.name}». ` : ""}Podés fusionar después desde la ficha.`, { type: "info" }); };
  (boxes.find(b => !b.disabled) || q("#mgNo")).focus();
  go.onclick = async () => {
    const mergeIds = boxes.filter(b => b.checked).map(b => +b.dataset.mid);
    go.disabled = true; go.innerHTML = `<span class="spin"></span> Fusionando…`; boxes.forEach(b => b.disabled = true);
    // mientras fusiona, no se cierra: la fusión sigue igual en Pipedrive y no se vería el resultado
    m.locked = true; q("#mgX").disabled = q("#mgNo").disabled = true;
    try {
      const x = await api(`/api/schools/${encodeURIComponent(s.id)}/merge-orgs`, { body: { keepId: k.id, mergeIds } });
      if (x.school) patchSchool(x.school);
      m.locked = false;
      if (m.isConnected) {
        q(".modal-box").innerHTML = `<div class="modal-h"><h3>${icon("checkCircle")} ${x.done.some(y => y.warn) ? "Fusionado en parte" : "Listo"}</h3></div>${writesList(x.done)}<button class="btn primary block" id="mgOk">Listo</button>`;
        q("#mgOk").onclick = () => m.close(); q("#mgOk").focus();
      } else toast(`Listo: ${x.done[0]?.label || "fusionado"}`, { type: x.done.some(y => y.warn) ? "info" : "", ms: 9000 });
      HIST.delete(s.id); SEDES.delete(s.id); S.today = null; S.agenda = null;
      if (D.id === s.id) load({ refresh: true });
    } catch (err) {
      m.locked = false; q("#mgX").disabled = q("#mgNo").disabled = false;
      toast(err.message, { type: "err" });
      boxes.forEach((b, i) => b.disabled = !!r.dupes[i].block); go.innerHTML = `${icon("merge")} Fusionar`; check();
    }
  };
}

// ---------- Registrar
async function suggest(s) {
  const f = D.form; if (!f.outcome) return;
  try {
    const r = await api(`/api/schools/${s.id}/next?outcome=${f.outcome}&channel=${f.channel}`);
    if (D.id !== s.id) return;
    f.why = r.why || "";
    if (!f.nextTouched) { f.next.type = r.type || ""; f.next.date = r.date || (r.type ? nextBusinessDay(today()) : ""); }
    // siempre conviene dejar algo a futuro: si la sugerencia no trae nada (y no es demo ni descarte), una llamada el próximo hábil
    if (!f.nextTouched && !f.next.type && !NO_NEXT.includes(f.outcome)) { f.next.type = "call"; f.next.date = nextBusinessDay(today()); }
    if (r.lost && !f.lostReason) f.lostReason = r.lost;
    if (f.outcome === "demo" && !f.nextTouched) { f.next.type = ""; }
    redrawLog();
  } catch {}
}
function redrawLog() { keepScroll(draw); }

// el próximo paso es tuyo (cada uno trabaja lo suyo); un líder puede asignarlo a otra persona. La demo sí la puede dar otro.
const ownerOpts = (sel, any = true) => `<option value="">Para mí</option>${any ? (S.team || []).filter(u => u.id !== S.me.pdUserId).map(u => `<option value="${u.id}" ${String(sel) === String(u.id) ? "selected" : ""}>Para ${esc(u.name)}</option>`).join("") : ""}`;
const quickDates = () => { const t = today(), nb = nextBusinessDay(t); return [["Hoy", t], ["Mañana", addDays(t, 1)], ...(nb !== addDays(t, 1) ? [["Próx. hábil", nb]] : []), ["En 1 semana", addDays(t, 7)], ["En 1 mes", addDays(t, 30)], ["En 3 meses", addDays(t, 90)]]; };
// qué, para quién, día (mini calendario y atajos), hora y detalle del próximo paso (Registrar y después de un mail)
function nextFields(f, none = "Sin tarea") {
  const t = today();
  return `<div class="grid2"><label class="field"><span>Qué</span><select class="inp" data-f="next.type" data-touch>${NEXT_TYPES.map(([k, l]) => `<option value="${k}" ${f.next.type === k ? "selected" : ""}>${k ? l : none}</option>`).join("")}</select></label>
      <label class="field"><span>Para</span><select class="inp" data-f="next.ownerId" ${f.next.type ? "" : "disabled"}>${ownerOpts(f.next.ownerId)}</select></label></div>
      ${f.next.type ? `<div class="next-when">${miniCal(f.next.date, t, false)}
        <div class="next-side"><div class="chips">${quickDates().map(([l, v]) => `<button class="chip sm" data-nd="${v}" aria-pressed="${f.next.date === v}">${l}</button>`).join("")}</div>
        <label class="field"><span>Hora <span class="faint">opcional</span></span><input class="inp" type="time" data-f="next.time" data-touch value="${esc(f.next.time)}" step="900"></label>
        <label class="field"><span>Detalle <span class="faint">opcional</span></span><input class="inp" data-f="next.subject" value="${esc(f.next.subject || "")}" placeholder="Ej: llamar a la directora después de las 11" maxlength="140"></label>
        <p class="muted" id="nextLine" style="margin:0;font-size:13px">${esc(nextLine(f))}</p></div></div>` : ""}`;
}
// Registrar después de enviar un mail desde la ficha: el contacto ya quedó (canal mail, «Mail enviado»); falta el próximo paso.
// Siempre queda algo para hacer: la llamada automática que dejó el envío o la actividad tuya que ya estaba (base). Se
// propone esa y, si la cambiás, se mueve esa misma (no se crea otra). Si la ficha se abrió desde una actividad de la agenda
// (una llamada, por ejemplo), se ofrece marcarla como hecha; si era justo la base, se propone una nueva.
const mailBase = f => f.mail?.autoNext || f.mail?.pendingNext || null;
const baseGone = f => !!(f.mail?.act && f.completeAct && mailBase(f)?.id === f.mail.act.id);
const liveBase = f => baseGone(f) ? null : mailBase(f);
const kindOf = t => t === "meeting" ? "demo" : (S.types[t] || "tarea").toLowerCase();
// «mañana», «el jueves, 12 de noviembre» (+ hora)
const whenOf = b => { const l = dayLabel(b.date).toLowerCase(); return `${/^(hoy|mañana|ayer)$/.test(l) ? l : `el ${l}`}${b.time ? ` a las ${b.time}` : ""}`; };
const baseDesc = (b, auto, art = "tu") => `${auto ? "la llamada automática" : `${art} ${kindOf(b.type)}`} ${whenOf(b)}`;
// el próximo paso del formulario igual a la base (qué, día, hora, para vos y sin detalle): no se cambia nada
const sameAsBase = f => { const b = liveBase(f), n = f.next; return !!b && n.type === b.type && n.date === b.date && (n.time || "") === (b.time || "") && !n.ownerId && !(n.subject || "").trim(); };
// lo que se propone: la base tal cual; si la base se marca hecha (o no hay), una llamada en 2 días hábiles
const mailDefaultNext = f => { const b = liveBase(f), fb = f.mail.fallback || { type: "call", date: nextBusinessDay(nextBusinessDay(today())) }; return b ? { type: b.type, date: b.date, time: b.time || "", ownerId: "", subject: "" } : { type: fb.type, date: fb.date, time: "", ownerId: "", subject: "" }; };
function mailFollowBody(s, d) {
  const f = D.form, ml = f.mail, warns = (ml.done || []).filter(x => x.warn), pdOk = ml.logged?.pipedrive !== false, histOk = ml.logged?.history !== false;
  const b = liveBase(f), auto = !!b && b === ml.autoNext, act = ml.act;
  const where = pdOk && histOk ? "Ya quedó en Pipedrive y en Historial." : !pdOk ? "En Pipedrive no quedó: registralo a mano." : "Quedó en Pipedrive; en el historial de la app no.";
  return `<div class="stack">
    <div class="callout ${pdOk ? "ok" : "warn"}">${icon(pdOk ? "checkCircle" : "alert")}<span><b>${pdOk ? "Mail enviado" : "Salió el mail"}</b> a ${esc(ml.to)} · «${esc(ml.subject)}». ${where}</span></div>
    ${warns.map(x => `<div class="callout warn">${icon("alert")}<span>${esc(x.label)}</span></div>`).join("")}
    <div class="sec step"><div class="step-h"><span class="n">1</span>¿Por dónde fue el contacto?</div>
      <div class="seg" role="group">${CH.map(([k, l, ic]) => `<button aria-pressed="${k === "mail"}" disabled>${icon(ic, "sm")} ${l}</button>`).join("")}</div></div>
    <div class="sec step"><div class="step-h"><span class="n">2</span>¿Qué pasó?</div>
      <div class="outcomes"><button class="oc good" aria-pressed="true" disabled><b>Mail enviado</b><small>Ya está registrado. Si te responde, registralo como un contacto nuevo.</small></button></div>
      <details class="obj"><summary>Lo que mandaste</summary><p style="white-space:pre-wrap">${esc(ml.body)}</p></details></div>
    <div class="sec step"><div class="step-h"><span class="n">3</span>Próximo paso</div>
      ${act ? `<label class="callout info toggle"><input type="checkbox" data-f="completeAct" ${f.completeAct ? "checked" : ""}> Marcar como hecha: <b>${esc(act.subject)}</b></label>` : ""}
      ${b ? `<div class="callout info">${icon("calendar")}<span>${auto ? "Quedó" : "Ya tenés"} ${esc(baseDesc(b, auto, ["call", "meeting"].includes(b.type) ? "una" : "un"))}${!auto && ml.pendingNext?.count > 1 ? ` (y ${ml.pendingNext.count - 1} más)` : ""}. Si la cambiás, se mueve esa: no se crea otra.</span></div>`
        : baseGone(f) ? `<div class="callout info">${icon("calendar")}<span>La de la agenda queda hecha: dejá la próxima.</span></div>` : ""}
      ${!b && !baseGone(f) && f.why ? `<div class="callout">${icon("sparkles")}<span>${esc(f.why)}</span></div>` : ""}
      ${!f.next.type && !b ? `<div class="callout warn">${icon("alert")}<span>Sin próximo paso este colegio se pierde de vista. Conviene dejar algo para hacer.</span></div>` : ""}
      ${nextFields(f, b ? "Dejar como está" : "Sin próximo paso")}</div>
  </div>`;
}
function logBody(s, d) {
  const f = D.form, o = S.outcomes.find(x => x.id === f.outcome);
  if (f.mail) return mailFollowBody(s, d);
  const act = D.activityId && d.activities?.find(a => a.id === D.activityId);
  const connected = CONNECTED.includes(f.outcome), qualify = QUALIFY.includes(f.outcome);
  const lostish = ["not_now", "not_interested"].includes(f.outcome) || (f.outcome === "no_answer" && f.lostReason);
  const t = today();
  const warn = clientWarn(s, d.match);
  const pre = S.markets[s.country]?.prefix ? `+${S.markets[s.country].prefix} …` : "Teléfono";
  let n = 0;
  return `<div class="stack">
    ${warn ? `<div class="callout warn">${icon("alert")}<span>${esc(warn)}${HIST.get(s.id) ? ` <button class="linkbtn" data-see-hist>Ver qué pasó</button>` : ""}</span></div>` : ""}
    ${act ? `<label class="callout info toggle"><input type="checkbox" data-f="completeAct" ${f.completeAct ? "checked" : ""}> Marcar como hecha: <b>${esc(act.subject)}</b></label>` : ""}
    <div class="sec step"><div class="step-h"><span class="n">${++n}</span>¿Por dónde fue el contacto?</div>
      <div class="seg" role="group">${CH.map(([k, l, ic]) => `<button data-ch="${k}" aria-pressed="${f.channel === k}">${icon(ic, "sm")} ${l}</button>`).join("")}</div></div>
    <div class="sec step"><div class="step-h"><span class="n">${++n}</span>¿Qué pasó?</div>
      ${D.call ? `<p class="call-dur muted">${icon("clock", "sm")} ${esc(D.call.note)}</p>` : ""}
      <div class="outcomes">${S.outcomes.map((x, i) => `<button class="oc ${GOOD.includes(x.id) ? "good" : ""}" data-oc="${x.id}" aria-pressed="${f.outcome === x.id}" ${x.id === "demo" && s.status === "client" ? `disabled title="Ya es cliente"` : ""}><b>${esc(x.label)}</b><small>${esc(x.hint)}</small>${i < 9 ? `<span class="kbd-hint oc-k" aria-hidden="true">${i + 1}</span>` : ""}</button>`).join("")}</div></div>
    <div class="sec step"><div class="step-h"><span class="n">${++n}</span>Comentario <span class="faint" style="font-weight:400;font-size:13px">${f.outcome ? "lo que te dijeron, con tus palabras" : contactPending() ? "lo que pasó, con tus palabras" : "opcional · se puede guardar solo, sin registrar un contacto"}</span></div>
      <textarea class="inp" data-f="text" aria-label="Comentario" placeholder="Ej: atendió la secretaria, la cafetería la maneja un concesionario (Don Pedro), llamar después de las 11.">${esc(f.text)}</textarea>
      ${(QUICK[f.outcome] || []).length ? `<div class="quick">${QUICK[f.outcome].map(q => `<button data-quick="${esc(q)}">+ ${esc(q)}</button>`).join("")}</div>` : ""}
      ${S.ai && f.outcome ? `<label class="toggle"><input type="checkbox" data-f="ai" ${f.ai ? "checked" : ""}> Ordenar la nota con IA (resumen, decisor, objeción e interés)</label>` : ""}</div>
    ${f.outcome === "demo" ? `<div class="sec step"><div class="step-h"><span class="n">${++n}</span>La demo</div>
      ${s.virtual && !s.country ? `<label class="field"><span>País del colegio <span class="faint">para crear el trato en su embudo</span></span><select class="inp" data-f="country"><option value="">Elegí el país</option>${Object.keys(S.markets).sort().map(c => `<option ${f.country === c ? "selected" : ""}>${esc(c)}</option>`).join("")}</select></label>` : ""}
      <div class="grid3"><label class="field"><span>Día</span><input class="inp" type="date" data-f="demo.date" value="${esc(f.demo.date)}" min="${t}"></label>
      <label class="field"><span>Hora (tu hora local)</span><input class="inp" type="time" data-f="demo.time" value="${esc(f.demo.time)}" step="900"></label>
      <label class="field"><span>Duración</span><select class="inp" data-f="demo.duration">${[20, 30, 45, 60].map(m => `<option value="${m}" ${+f.demo.duration === m ? "selected" : ""}>${m} min</option>`).join("")}</select></label></div>
      <label class="field"><span>¿Quién da la demo?</span><select class="inp" data-f="demo.ownerId">${ownerOpts(f.demo.ownerId, true).replace("Para mí", "Yo")}</select></label>
      <p class="muted" style="margin:0;font-size:13.5px">${d.match.openDealId ? "Se agenda en el trato abierto." : `Se crea el trato en <b>${esc(pipeName(s))}</b> con fuente «Outbound - Cold Calling» y vos como SDR.`}</p></div>` : ""}
    ${connected ? `<div class="sec step"><div class="step-h"><span class="n">${++n}</span>${f.outcome === "gatekeeper" ? "¿Por quién preguntar?" : "¿Con quién hablaste?"} <span class="faint" style="font-weight:400;font-size:13px">${f.outcome === "gatekeeper" ? "opcional · nombre y cargo si te lo dijeron, se crea como contacto" : "opcional, se crea como contacto"}</span></div>
      <div class="grid2"><label class="field"><span>Nombre</span><input class="inp" data-f="contact.name" value="${esc(f.contact.name)}" placeholder="Ej: Laura Gómez" autocomplete="off"></label>
      <label class="field"><span>Cargo</span><input class="inp" data-f="contact.role" value="${esc(f.contact.role)}" placeholder="Directora, administrador, concesionario" list="roles"></label>
      <label class="field"><span>Teléfono / WhatsApp</span><input class="inp" type="tel" data-f="contact.phone" value="${esc(f.contact.phone)}" placeholder="${esc(pre)}"></label>
      <label class="field"><span>Email</span><input class="inp" type="email" data-f="contact.email" value="${esc(f.contact.email)}" placeholder="nombre@colegio.edu"></label></div>
      <datalist id="roles"><option>Director/a</option><option>Administrador/a</option><option>Concesionario/a ${esc(delaEsp(d.market))}</option><option>Coordinador/a de servicios</option><option>Dueño/a</option></datalist></div>` : ""}
    ${qualify ? `<div class="sec step"><div class="step-h"><span class="n">${++n}</span>Calificación <span class="faint" style="font-weight:400;font-size:13px">lo que sepas</span></div>
      <div class="field"><span>${esc(laEsp(d.market).replace(/^./, c => c.toUpperCase()))} es…</span><div class="seg">${["Propia", "Externa", "No tiene"].map(c => `<button data-caf="${c}" aria-pressed="${f.qual.cafeteria === c}">${c === "Externa" ? "Concesionada" : c}</button>`).join("")}</div></div>
      <div class="grid2"><label class="field"><span>Alumnos</span><input class="inp" type="number" min="0" step="10" data-f="qual.alumnos" value="${esc(f.qual.alumnos)}" placeholder="Ej: 600"></label>
      <label class="field"><span>Sistema actual</span><input class="inp" data-f="qual.sistema" value="${esc(f.qual.sistema)}" placeholder="Efectivo, Excel, otro software…"></label></div>
      <div class="field"><span>Niveles</span><div class="chips">${NIVELES.map(nv => `<button class="chip" data-niv="${nv}" aria-pressed="${f.qual.niveles.includes(nv)}">${nv}</button>`).join("")}</div></div></div>` : ""}
    ${lostish ? `<div class="sec step"><div class="step-h"><span class="n">${++n}</span>Motivo</div>
      <select class="inp" data-f="lostReason"><option value="">Sin motivo (no cerrar)</option>${S.lostReasons.map(r => `<option ${f.lostReason === r ? "selected" : ""}>${esc(r.replace("  ", " "))}</option>`).join("")}</select>
      <p class="muted" style="margin:0;font-size:13.5px">${d.match.openDealId ? "El trato abierto se marca como perdido con este motivo." : "Queda en la nota. No hay trato abierto para cerrar."}</p></div>` : ""}
    ${f.outcome || !contactPending() ? `<div class="sec step"><div class="step-h"><span class="n">${++n}</span>${f.outcome ? "Próximo paso" : `Tarea para más adelante <span class="faint" style="font-weight:400;font-size:13px">opcional · para vos o para alguien del equipo</span>`}</div>
      ${f.outcome && f.why ? `<div class="callout">${icon("sparkles")}<span>${esc(f.why)}</span></div>` : ""}
      ${!f.next.type && f.outcome && !NO_NEXT.includes(f.outcome) && !d.match?.orgId && !s.leadOnly ? `<div class="callout info">${icon("calendar")}<span>Es la primera vez que se lo contacta: al guardar queda a tu nombre en Pipedrive y, si no elegís otro paso, con una llamada para el ${esc(dayLabel(nextBusinessDay(today())).toLowerCase())}.</span></div>`
        : !f.next.type && (f.outcome ? !NO_NEXT.includes(f.outcome) : !!f.text?.trim()) ? `<div class="callout warn">${icon("alert")}<span>Sin ${f.outcome ? "próximo paso" : "tarea a futuro"} este colegio se pierde de vista. Conviene dejar algo para hacer.</span></div>` : ""}
      ${nextFields(f, f.outcome ? "Sin próximo paso" : "Sin tarea")}</div>` : ""}
  </div>`;
}
// «Llamada el domingo, 20 de diciembre a las 11:30 · para Juan Diego»
function nextLine(f) {
  if (!f.next.type || !f.next.date) return "";
  const who = f.next.ownerId ? (S.team || []).find(u => String(u.id) === String(f.next.ownerId))?.name : "";
  const dl = dayLabel(f.next.date).toLowerCase();
  return `${S.types[f.next.type] || "Tarea"} ${["hoy", "mañana", "ayer"].includes(dl) ? dl : `el ${dl}`}${f.next.time ? ` a las ${f.next.time}` : ""} · para ${who || "vos"}`;
}
function pipeName(s) { const mk = S.markets[s.country]; return mk ? `${{ MX: "MX - SALES", PE: "PE - SALES", AR: "ARG - SALES", CL: "CHI - Sales", UY: "UY - SALES" }[mk.code] || "LatAm - SALES"}` : "el embudo del país"; }

// Comentario suelto: solo si no hay un contacto en curso (recién llamaste o mandaste un mensaje desde la ficha).
const contactPending = () => D.inCall || D.form.sent;
// comentario y/o tarea para más adelante, sin registrar un contacto
const onlyComment = () => !D.form.outcome && !contactPending() && (!!D.form.text?.trim() || !!(D.form.next.type && D.form.next.date));
const saveDisabled = s => D.form.mail ? D.saving || (!!D.form.next.type && !D.form.next.date) : D.saving || !(D.form.outcome || onlyComment()) || (s.status === "client" && D.form.outcome === "demo");
const saveLabel = () => `${icon("check")} ${D.form.mail ? (D.form.next.type && !sameAsBase(D.form) ? "Guardar próximo paso" : "Listo") : onlyComment() ? "Guardar comentario" : "Guardar en Pipedrive"}`;
function summary(s, d) {
  const f = D.form;
  if (f.mail) {
    const b = liveBase(f), auto = !!b && b === f.mail.autoNext, pdOk = f.mail.logged?.pipedrive !== false;
    const tail = pdOk ? "" : " El mail salió, pero no quedó en Pipedrive.";
    if (f.next.type && f.next.date && !sameAsBase(f)) return `<b>Se guarda en Pipedrive:</b> ${esc(kindOf(f.next.type))} ${shortDay(f.next.date)}${f.next.time ? ` ${esc(f.next.time)}` : ""}${b ? auto ? " (cambia la automática)" : " (mueve la que ya tenías)" : ""}${f.mail.act && f.completeAct ? " y la de la agenda queda hecha" : ""}.${esc(tail)}<span class="kbd-hint faint"> · Ctrl + Enter</span>`;
    return esc(`${b ? `Queda ${baseDesc(b, auto)}` : "Sin próximo paso"}${f.mail.act && f.completeAct ? " y la de la agenda queda hecha" : ""}.${tail}`);
  }
  if (onlyComment()) return `<b>Se guarda en Pipedrive:</b> comentario${f.next.type && f.next.date ? ` + ${esc((S.types[f.next.type] || "tarea").toLowerCase())} ${shortDay(f.next.date)}${f.next.ownerId ? ` para ${esc((S.team || []).find(u => String(u.id) === String(f.next.ownerId))?.name || "")}` : ""}` : ""}, sin registrar contacto<span class="kbd-hint faint"> · Ctrl + Enter</span>`;
  if (!f.outcome) return contactPending() ? `Elegí qué pasó con ${D.form.sent ? "el mensaje" : "la llamada"} para guardar.` : "Elegí qué pasó o dejá un comentario.";
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
  el.querySelectorAll("[data-oc]").forEach(b => b.onclick = () => {
    // tocar el que ya estaba elegido lo quita (por ejemplo, para guardar solo un comentario)
    if (f.outcome === b.dataset.oc) { if (D.call?.outcome) D.call = null; f.outcome = null; f.lostReason = ""; f.why = ""; if (!f.nextTouched) f.next = { type: "", date: "", time: "", ownerId: f.next.ownerId }; redrawLog(); return; }
    f.outcome = b.dataset.oc; f.lostReason = ""; if (D.call?.outcome) D.call = null; redrawLog(); suggest(s);
  });
  el.querySelectorAll("[data-caf]").forEach(b => b.onclick = () => { f.qual.cafeteria = f.qual.cafeteria === b.dataset.caf ? "" : b.dataset.caf; redrawLog(); });
  el.querySelectorAll("[data-niv]").forEach(b => b.onclick = () => { const v = b.dataset.niv; f.qual.niveles = f.qual.niveles.includes(v) ? f.qual.niveles.filter(x => x !== v) : [...f.qual.niveles, v]; b.setAttribute("aria-pressed", f.qual.niveles.includes(v)); });
  el.querySelectorAll("[data-nd]").forEach(b => b.onclick = () => { f.next.date = b.dataset.nd; D.calMonth = null; f.nextTouched = true; redrawLog(); });
  el.querySelectorAll("[data-day]").forEach(b => b.onclick = () => { f.next.date = b.dataset.day; f.nextTouched = true; redrawLog(); });
  el.querySelectorAll("[data-cal]").forEach(b => b.onclick = () => {
    const [y, m] = (D.calMonth || (f.next.date || today()).slice(0, 7)).split("-").map(Number), d = new Date(Date.UTC(y, m - 1 + Number(b.dataset.cal), 1));
    D.calMonth = d.toISOString().slice(0, 7); redrawLog();
  });
  el.querySelectorAll("[data-quick]").forEach(b => b.onclick = () => { const ta = el.querySelector('[data-f="text"]'); ta.value = (ta.value.trim() ? ta.value.trim() + ". " : "") + b.dataset.quick; f.text = ta.value; ta.focus(); });
  el.querySelectorAll("[data-f]").forEach(inp => {
    const ev = inp.tagName === "SELECT" || inp.type === "checkbox" ? "change" : "input";
    inp.addEventListener(ev, () => {
      setPath(f, inp.dataset.f, inp.type === "checkbox" ? inp.checked : inp.value);
      if (inp.hasAttribute("data-touch")) f.nextTouched = true;
      if (inp.dataset.f === "next.type") { if (inp.value && !f.next.date) f.next.date = nextBusinessDay(today()); redrawLog(); }
      // después de un mail: marcar hecha la actividad de la agenda cambia lo que se propone (si era la base, una nueva)
      else if (inp.dataset.f === "completeAct" && f.mail) { if (!f.nextTouched) f.next = mailDefaultNext(f); redrawLog(); }
      else if (inp.dataset.f === "lostReason") redrawLog();
      // comentario suelto: al empezar a escribir se prende la tarea a futuro (llamada el próximo hábil, para vos)
      else if (inp.dataset.f === "text" && !f.outcome && !contactPending() && !f.nextTouched && !f.next.type && inp.value.trim()) { f.next.type = "call"; f.next.date = nextBusinessDay(today()); redrawLog(); }
      else {
        const sum = el.querySelector("#sum"); if (sum) sum.innerHTML = summary(s, d);
        const nl = el.querySelector("#nextLine"); if (nl) nl.textContent = nextLine(f);
        const sv = el.querySelector("#save"); if (sv && !D.saving) { sv.disabled = saveDisabled(s); sv.innerHTML = saveLabel(); }
      }
    });
  });
  el.querySelector("#save")?.addEventListener("click", () => saveLog(s, d));
}

async function saveLog(s, d) {
  const f = D.form;
  if (f.mail) return saveMailNext(s);
  if (onlyComment()) return saveComment(s);
  if (!f.outcome) return toast("Elegí qué pasó o dejá un comentario", { type: "err" });
  if (f.next.type && !f.next.date) return toast("Poné la fecha del próximo paso", { type: "err" });
  if (f.outcome === "demo" && (!f.demo.date || !f.demo.time)) return toast("Poné el día y la hora de la demo", { type: "err" });
  if (f.outcome === "demo" && s.virtual && !s.country && !f.country) return toast("Elegí el país del colegio para crear el trato", { type: "err" });
  D.saving = true; redrawLog();
  const body = {
    outcome: f.outcome, channel: f.channel, text: f.text, ai: f.ai, country: f.country || undefined,
    contact: f.contact.name || f.contact.phone || f.contact.email ? f.contact : null, qual: f.qual,
    demo: f.outcome === "demo" ? { ...f.demo, ownerId: f.demo.ownerId ? Number(f.demo.ownerId) : undefined } : null,
    next: f.next.type ? { type: f.next.type, date: f.next.date, time: f.next.time || undefined, ownerId: f.next.ownerId ? Number(f.next.ownerId) : undefined, subject: f.next.subject || undefined } : null,
    lost: f.lostReason ? { reason: f.lostReason } : null,
    completeActivityId: D.activityId && f.completeAct ? D.activityId : null,
    session: sessionRef(),
  };
  try {
    const r = await api(`/api/schools/${s.id}/log`, { body });
    sessionLogged(r, { kind: "contact", channel: f.channel, outcome: f.outcome }, body.session);
    if (D.id !== s.id) return;
    D.result = { ...r, form: JSON.parse(JSON.stringify(f)) }; D.inCall = false; D.call = null;
    patchSchool(r.school);
    S.today = null; S.agenda = null;
    import("./explore.js").then(m => m.refreshExplore());
    D.saving = false; draw(); toTabs();
    // refresca la ficha en segundo plano para que Historial muestre lo nuevo
    api(`/api/schools/${s.id}`).then(nd => { if (D.id === s.id) { D.data = nd; if (D.tab !== "log") draw(); } }).catch(() => {});
  } catch (e) { D.saving = false; redrawLog(); toast(e.message, { type: "err" }); }
}

// el próximo paso después de un mail enviado (si había llamada automática, se cambia esa)
async function saveMailNext(s) {
  const f = D.form;
  if (f.next.type && !f.next.date) return toast("Poné la fecha del próximo paso", { type: "err" });
  D.saving = true; redrawLog();
  try {
    const next = f.next.type ? { type: f.next.type, date: f.next.date, time: f.next.time || undefined, ownerId: f.next.ownerId ? Number(f.next.ownerId) : undefined, subject: f.next.subject || undefined } : null;
    const b = liveBase(f), doneId = f.mail.act && f.completeAct ? f.mail.act.id : null;
    const r = await api(`/api/schools/${s.id}/mail/next`, { body: { mailId: f.mail.id, next, moveActivityId: b?.id || null, completeActivityId: doneId } });
    if (D.id !== s.id) return;
    if (doneId) D.activityId = null;
    D.result = { ...r, done: [{ label: `Mail enviado a ${f.mail.to} · «${f.mail.subject}»`, url: f.mail.url || undefined }, ...r.done], form: JSON.parse(JSON.stringify(f)) };
    if (r.school) patchSchool(r.school);
    S.today = null; S.agenda = null;
    D.saving = false; draw(); toTabs();
    api(`/api/schools/${s.id}`).then(nd => { if (D.id === s.id) { D.data = nd; if (D.tab !== "log") draw(); } }).catch(() => {});
  } catch (e) { D.saving = false; redrawLog(); toast(e.message, { type: "err" }); }
}
async function saveComment(s) {
  const f = D.form;
  D.saving = true; redrawLog();
  try {
    const task = f.next.type && f.next.date ? { type: f.next.type, date: f.next.date, time: f.next.time || undefined, ownerId: f.next.ownerId ? Number(f.next.ownerId) : undefined, subject: f.next.subject || undefined } : null;
    const sr = sessionRef(), r = await api(`/api/schools/${s.id}/comment`, { body: { text: f.text, task, completeActivityId: D.activityId && f.completeAct ? D.activityId : null, session: sr } });
    sessionLogged(r, { kind: "comment" }, sr);
    if (D.id !== s.id) return;
    D.result = { ...r, form: JSON.parse(JSON.stringify(f)) };
    if (r.school) patchSchool(r.school);
    D.saving = false; draw(); toTabs();
    api(`/api/schools/${s.id}`).then(nd => { if (D.id === s.id) { D.data = nd; if (D.tab !== "log") draw(); } }).catch(() => {});
  } catch (e) { D.saving = false; redrawLog(); toast(e.message, { type: "err" }); }
}
function resultBody(s, d) {
  const r = D.result, f = r.form, ss = S.session;
  const contact = f.contact?.name ? f.contact : d.persons?.[0] || null;
  const tpl = id => d.templates.find(t => t.id === id);
  const extra = [];
  if (f.outcome === "demo") {
    extra.push(`<a class="btn" href="${esc(gcalLink({ title: `Demo OrderEAT · ${s.name}`, date: f.demo.date, time: f.demo.time, minutes: +f.demo.duration || 30, details: `Demo de OrderEAT para ${laEsp(d.market)} de ${s.name}.\nAgendada desde OrderBrain SDR.`, guests: contact?.email || "" }))}" target="_blank" rel="noopener">${icon("calendar")} Invitación en Google Calendar</a>`);
    extra.push(`<button class="btn wa" data-tpl="confirm_demo">${icon("whatsapp")} Confirmar por WhatsApp</button>`);
  }
  if (f.outcome === "info") extra.push(`<button class="btn" data-tpl="mail_info">${icon("mail")} Mandar la info por mail</button>`, `<button class="btn wa" data-tpl="info">${icon("whatsapp")} Mandar por WhatsApp</button>`);
  if (f.outcome === "no_answer" && tpl("after_call")) extra.push(`<button class="btn wa" data-tpl="after_call">${icon("whatsapp")} Mandar WhatsApp ahora</button>`);
  return `<div class="sec done-card">
    <div class="big">${icon("check")}</div>
    <h3>Guardado en Pipedrive</h3>
    <ul class="writes">${r.done.map(x => `<li${x.warn ? ' class="warn"' : ""}>${icon(x.warn ? "alert" : "check", "sm")}<span>${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.label)}</a>` : esc(x.label)}</span></li>`).join("")}</ul>
    ${extra.length ? `<div class="d-actions" style="justify-content:center;margin:6px 0 0">${extra.join("")}</div>` : ""}
    <div class="d-actions" style="justify-content:center">
      ${ss ? `<button class="btn primary lg" id="nextSchool">Siguiente colegio ${icon("arrowRight")}</button>` : `<button class="btn primary" id="closeD">Listo</button>`}
      <button class="btn ghost" id="again">Registrar otro contacto</button>
    </div>
    ${ss ? `<p class="faint" style="margin:0;font-size:13px">${pendingOf(ss) ? `Faltan ${pendingOf(ss)} en la sesión` : "Es el último de la sesión"}</p>` : ""}
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
  (el.querySelector("#nextSchool") || el.querySelector("#closeD"))?.focus();
}

// ---------- Historial
// La línea de tiempo: contactos registrados, mails enviados y notas de Pipedrive. Un mail enviado es una sola entrada
// («Mail enviado»): no se repite como contacto registrado ni como la nota que dejó en Pipedrive.
function histItems(d) {
  const mails = d.mails || [], ids = new Set(mails.map(m => m.id));
  const subjects = [...mails.map(m => m.subject), ...(d.touches || []).filter(t => t.mailId).map(t => t.text)].filter(Boolean);
  const mailNote = n => /^Mail enviado\b/.test(n.text) && /OrderBrain SDR/.test(n.text) && subjects.some(x => n.text.includes(x));
  return [
    ...mails.map(m => ({ at: m.at, mail: m })),
    ...(d.touches || []).filter(t => !(t.mailId && ids.has(t.mailId))).map(t => t.mailId ? { at: t.at, mail: { to: t.to, subject: t.text, by: t.by, body: "", at: t.at } }
      : { at: t.at, ic: { call: "phone", whatsapp: "whatsapp", mail: "mail", visit: "user" }[t.channel] || "note", h: `<b>${esc(t.by)}</b> · ${esc(t.outcome)}`, p: t.text }),
    // las notas de «Registrar» ya se ven como contactos; los comentarios sueltos y las del asistente, no: esas se muestran
    ...(d.notes || []).filter(n => !mailNote(n) && (!/OrderBrain SDR/.test(n.text) || /^(Comentario|Nota desde el asistente)\b/.test(n.text) || !(d.touches || []).length)).map(n => ({ at: String(n.at).replace(" ", "T") + "Z", ic: "note", h: `<b>${esc(n.author)}</b> · nota${n.deal ? ` en ${esc(n.deal)}` : ""}`, p: n.text })),
  ].sort((a, b) => String(b.at).localeCompare(String(a.at)));
}
const whenFull = at => { const x = new Date(at); return isNaN(x) ? "" : x.toLocaleString("es", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }); };
const mailItem = m => `<div class="tl tl-mail"><span class="ic">${icon("mail")}</span><div>
    <div class="h"><b>Mail enviado</b> a ${esc(m.to)} · ${esc(ago(m.at))}</div>
    <div class="tl-sub">«${esc(m.subject)}»</div>
    <div class="faint tl-meta">${esc([m.by, whenFull(m.at)].filter(Boolean).join(" · "))}${m.next?.type ? ` · próximo paso: ${esc((S.types[m.next.type] || "tarea").toLowerCase())} ${esc(shortDay(m.next.date))}` : ""}</div>
    ${m.body ? `<details class="tl-body"><summary>Ver el mail</summary><p>${esc(m.body)}</p></details>` : ""}</div></div>`;
function histBody(s, d) {
  const items = histItems(d);
  const m = d.match;
  return `<div class="stack">
    ${d.persons?.length || canAddPerson(s) ? `<div class="sec"><h3><span class="l">${icon("users")} Contactos</span>${canAddPerson(s) ? `<button class="btn sm ghost" id="addDec">${icon("plus", "sm")} Agregar decisor</button>` : ""}</h3>${d.persons?.length ? "" : `<p class="muted" style="margin:0">Todavía no hay contactos cargados.</p>`}${(d.persons || []).map(p => `<div class="person"><div class="av" style="width:34px;height:34px;border-radius:50%;background:var(--surface-3);display:grid;place-items:center;font-weight:600;font-size:13px">${initials(p.name)}</div><div class="t"><b>${esc(p.name)}</b><small>${esc([p.phone, p.email].filter(Boolean).join(" · ") || "Sin datos")}</small></div>
      ${p.phone ? `<a class="icon-btn" href="${esc(telLink(p.phone))}" aria-label="Llamar">${icon("phone")}</a><button class="icon-btn" data-pwa="${esc(p.phone)}" data-pname="${esc(p.name)}" aria-label="WhatsApp">${icon("whatsapp")}</button>` : ""}${p.email ? `<button class="icon-btn" data-pmail="${esc(p.email)}" data-pname="${esc(p.name)}" aria-label="Mail">${icon("mail")}</button>` : ""}</div>`).join("")}</div>` : ""}
    ${d.activities?.length ? `<div class="sec"><h3><span class="l">${icon("calendar")} Pendientes</span></h3>${d.activities.map(a => { const l = localAct(a); return `<div class="act"><span class="ty ${a.type}">${icon(TYPE_ICON[a.type] || "check")}</span><div class="t"><b>${esc(a.subject)}</b><small class="${l.date < today() ? "late" : ""}">${esc(a.typeLabel)} · ${esc(dayLabel(l.date))}${l.time ? ` ${l.time}` : ""} · ${esc(a.owner)}</small></div><div class="ops">${a.type === "meeting" && demoDue(l) ? (a.ownerId === S.me.pdUserId || S.profile?.leader ? `<button class="btn sm" data-hdemo="${a.id}" data-time="${esc(l.time)}">¿Se hizo la demo?</button>` : "") : a.ownerId === S.me.pdUserId ? `<button class="icon-btn" data-hdone="${a.id}" aria-label="Marcar como hecha" title="Marcar como hecha">${icon("check")}</button>` : ""}</div></div>`; }).join("")}</div>` : ""}
    ${d.deals?.length ? `<div class="sec"><h3><span class="l">${icon("deal")} Tratos</span></h3>${d.deals.map(x => `<div class="act"><span class="ty">${icon("deal")}</span><div class="t"><b><a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title)}</a></b><small>${esc(x.pipeline)} · ${esc(x.stage)} · ${x.status === "won" ? "ganado" : x.status === "lost" ? "perdido" + (x.lostReason ? ` (${esc(x.lostReason)})` : "") : "abierto"}${x.owner ? ` · ${esc(x.owner)}` : ""} · ${esc(x.updated)}</small>${dealOpsHtml(x)}</div></div>`).join("")}</div>` : ""}
    <div class="sec"><h3><span class="l">${icon("clock")} Historial</span>${m.checkedAt ? `<button class="btn sm ghost" id="refresh">${icon("refresh", "sm")} Actualizar</button>` : ""}</h3>
      ${items.length ? `<div class="timeline">${items.map(i => i.mail ? mailItem(i.mail) : `<div class="tl"><span class="ic">${icon(i.ic)}</span><div><div class="h">${i.h} · ${esc(ago(i.at))}</div>${i.p ? `<p>${esc(i.p)}</p>` : ""}</div></div>`).join("")}</div>` : `<div class="empty">${icon("note")}<span>Todavía no hay contactos ni notas. Lo que registres aparece acá y en Pipedrive.</span></div>`}
    </div>
    ${m.orgId && m.confirmed ? `<p class="faint" style="font-size:13px;margin:0">Vinculado a <a href="${esc(d.orgUrl)}" target="_blank" rel="noopener">${esc(m.orgName)}</a> en Pipedrive · <button class="linkbtn" id="unlink2">no es esta organización</button></p>` : ""}
  </div>`;
}
function bindHist(s, d) {
  const el = $("drawer");
  el.querySelector("#refresh")?.addEventListener("click", () => { D.data = null; draw(); load({ refresh: true }); });
  el.querySelector("#unlink2")?.addEventListener("click", () => { D.data = null; D.tab = "prep"; draw(); load({ match: { orgId: null } }); });
  el.querySelector("#addDec")?.addEventListener("click", () => addDecisor(s, d));
  bindDeals(s);
  el.querySelectorAll("[data-hdemo]").forEach(b => b.onclick = async () => {
    const { demoResultMenu } = await import("./today.js");
    demoResultMenu(b, { id: Number(b.dataset.hdemo), time: b.dataset.time }, () => load());
  });
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
  // abierta desde el recordatorio «Confirmar demo» de la agenda: va esa plantilla, con el día y la hora de la próxima demo
  const act = D.activityId && d.activities?.find(a => a.id === D.activityId), confirm = act?.type === "deadline" && /^Confirmar demo\b/.test(act.subject || "");
  const demo = confirm && d.activities.filter(a => a.type === "meeting").map(localAct).find(l => l.date >= today());
  const recommended = channel === "whatsapp" ? (confirm ? "confirm_demo" : s.status === "lost" || s.status === "stalled" ? "reactivate" : d.attempts ? "after_call" : "intro") : (s.status === "lost" || s.status === "stalled" ? "mail_reactivate" : "mail_info");
  list.sort((a, b) => (b.id === recommended) - (a.id === recommended));
  openMenu(anchor, [{ head: channel === "whatsapp" ? "Mensaje de WhatsApp" : "Mail desde Gmail" },
    ...list.map(t => ({ label: t.label + (t.id === recommended ? " · sugerido" : ""), sub: channel === "mail" ? t.subject || "" : t.text.split("\n").find(x => x.length > 12) || t.text, fn: () => {
      let text = t.text; if (to.name) text = text.replace(/^Hola(?=[,\s])/, `Hola ${to.name.split(" ")[0]}`);
      if (t.id === "confirm_demo" && demo) text = text.replace("[día]", shortDay(demo.date)).replace("[hora]", demo.time || "[hora]");
      messageModal(s, d, { ...t, text }, { phone: to.phone, email: to.email, name: to.name, logAfter: true });
    } })),
    { label: "Mensaje en blanco", sub: "Escribir desde cero", fn: () => messageModal(s, d, { channel, label: "Mensaje", text: "", subject: "" }, { phone: to.phone, email: to.email, name: to.name, logAfter: true }) },
  ]);
}
// Mail con Gmail conectado: «Enviar» manda desde tu Gmail (con 5 s para deshacer) y queda en Pipedrive y en Historial.
// Sin Gmail conectado: «Conectar Gmail» (una vez) y, mientras tanto, «Abrir en Gmail» como siempre.
const MAIL_RE = /^[^@\s<>()[\]\\,;:"]+@[^@\s<>()[\]\\,;:"]+\.[a-z]{2,}$/i, PH_RE = /\[(d[ií]a|hora|tu nombre)\]/i, SEND_DELAY = 5;
// Enviar: Gmail conectado y confirmado en esta sesión (verified: entraste con Google o lo conectaste acá). Conectado pero
// sin confirmar (entraste con tu código en otro dispositivo): se confirma una vez con Google.
const canSend = g => !!(g?.enabled && g.connected && g.verified && !g.readOnly && !g.config);
const needsConfirm = g => !!(g?.enabled && g.connected && !g.verified && !g.readOnly && !g.config);
const newKey = () => (crypto.randomUUID?.() || String(Math.random()).slice(2) + Date.now()).replace(/[^A-Za-z0-9]/g, "").slice(0, 40);
// la despedida con tu nombre de la plantilla sobra si la firma ya lo dice
const dropSignoff = text => { const n = String(S.me?.name || "").trim(); const re = n ? new RegExp(`\\n${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\nOrderEAT\\s*$`) : /\n[^\n]{2,60}\nOrderEAT\s*$/; return re.test(text) ? text.replace(re, "") : text.replace(/\n[^\n]{2,60}\nOrderEAT\s*$/, ""); };
// Por qué desde acá no se envía, con lo que ya trae la ficha (archivado, cliente, de otra persona). El servidor lo vuelve a
// comprobar al abrir el modal (/mail/check: también el trato abierto de otra persona) y al enviar.
function mailBlockLocal(s, d) {
  const me = S.me?.pdUserId, m = d.match || {}, who = id => (S.team || []).find(u => u.id === id)?.name || "otra persona";
  if (d.archive) return "Está archivado: desarchivalo para escribirle.";
  if (s.status === "client") return "Ya es cliente de OrderEAT: no se prospecta. Si hay algo, avisale al equipo de cuentas.";
  if (s.leadOnly) return d.leadOwnerId && me && d.leadOwnerId !== me ? `El prospecto es de ${who(d.leadOwnerId)} en Pipedrive. Hablalo con esa persona.` : "";
  const owner = m.ownerId || s.ownerId;
  if (owner && me && owner !== me) return `La organización es de ${m.ownerName || s.ownerName || who(owner)} en Pipedrive. Hablalo con esa persona.`;
  return "";
}
async function messageModal(s, d, t, { phone, email, name = "", logAfter }) {
  const isMail = t.channel === "mail";
  if (isMail) await loadGmail(!!(S.gmail?.problem || S.gmail?.failed));
  // para WhatsApp solo sirve un número completo (con código de área): uno local de 7 dígitos de la web no llega
  const full = p => String(p || "").replace(/\D/g, "").length >= 10;
  const defPhone = phone || [...(d.persons || []).map(p => p.phone), s.phone, ...sedesOf(s.id).filter(z => z.here).flatMap(sedeCallable)].find(p => p && (isMail || full(p))) || "";
  const defMail = email || d.persons?.find(p => p.email)?.email || d.mails?.[0]?.to || D.study?.contacto?.emails?.[0] || s.email || "";
  const pre = S.markets[s.country]?.prefix ? `+${S.markets[s.country].prefix} …` : "Teléfono";
  const text0 = isMail && canSend(S.gmail) && S.gmail.signature ? dropSignoff(t.text) : t.text;
  // phase: edit · checking (comprobando en Pipedrive) · count (5 s para deshacer) · sending · unknown (no se sabe si salió)
  let phase = "edit", left = SEND_DELAY, timer = null, finished = false, again = false;
  // clave de un solo uso por envío: si el pedido se repite, el servidor no lo manda dos veces. «Mandar igual» usa otra.
  let key = newKey();
  const m = modal(`<div class="modal-h"><h3>${isMail ? icon("mail") : icon("whatsapp")} ${esc(t.label)}</h3><button class="icon-btn" id="mClose" aria-label="Cerrar">${icon("x")}</button></div>
    <p class="muted" style="margin:-8px 0 0">${esc(s.name)}</p>
    <label class="field"><span>Para</span><input class="inp" id="mTo" type="${isMail ? "email" : "tel"}" value="${esc(isMail ? defMail : defPhone)}" placeholder="${isMail ? "email@colegio.edu" : esc(pre)}"></label>
    ${isMail ? `<label class="field"><span>Asunto</span><input class="inp" id="mSub" value="${esc(t.subject || "")}" maxlength="200"></label>` : ""}
    <div class="field" id="mCtxBox"><label for="mCtx"><span>¿Qué querés decirle?</span></label>
      <textarea class="inp" id="mCtx" rows="2" placeholder="Ej: me pasó tu contacto el de sistemas; la concesionaria anterior dejó los planteles y quiero retomar"></textarea>
      <div class="row" style="justify-content:flex-start;margin-top:6px"><button class="btn sm" id="mAi">${icon("sparkles", "sm")} Armar mensaje</button><span class="faint" id="mAiNote" style="font-size:12.5px">${S.ai ? "Usa lo que escribas y lo que dice Pipedrive (notas, tratos, contactos)." : "Arma el mensaje con tu contexto y la forma de escribir de la casa."}</span></div></div>
    <label class="field"><span>Mensaje</span><textarea class="inp" id="mText" rows="${isMail ? 12 : 8}">${esc(text0)}</textarea></label>
    ${/\[(día|hora|tu nombre)\]/.test(t.text) ? `<p class="callout warn" style="margin:0" id="mPh">${icon("alert")}<span>Completá lo que está entre corchetes antes de mandar.</span></p>` : ""}
    <p class="callout err" id="mErr" role="alert" style="margin:0" hidden></p>
    <div class="stack mact" id="mAct"></div>`, { onClose: () => { if (timer) { clearInterval(timer); timer = null; if (!finished) toast("No se envió: cerraste antes de que salga", { type: "info" }); } } });
  const q = sel => m.querySelector(sel);
  const showErr = msg => { const e = q("#mErr"); e.innerHTML = `${icon("alert")}<span>${esc(msg)}</span>`; e.hidden = !msg; };
  const editable = on => { ["#mTo", "#mSub", "#mText", "#mCtx"].forEach(x => { const el = q(x); if (el) el.readOnly = !on; }); const ai = q("#mAi"); if (ai) ai.disabled = !on; };
  q("#mClose").onclick = () => m.close();
  // Armar el mensaje: con IA, con tu contexto + lo que sabe Pipedrive; sin IA, tu contexto en la plantilla de la casa
  q("#mAi").addEventListener("click", async e => {
    const b = e.currentTarget, ctx = q("#mCtx").value.trim(), cur = q("#mText").value.trim();
    if (!ctx && (!cur || !S.ai)) { q("#mCtx").focus(); return toast("Escribí qué querés decirle y lo armo", { type: "err" }); }
    b.disabled = true; b.innerHTML = `<span class="spin"></span> Armando…`;
    try {
      const r = await api(`/api/schools/${s.id}/draft`, { body: { channel: t.channel, purpose: t.label, contact: name || d.persons?.[0]?.name || "", base: t.text && cur === t.text.trim() && ctx ? "" : cur, context: ctx } });
      if (r.text) q("#mText").value = isMail && canSend(S.gmail) && S.gmail.signature ? dropSignoff(r.text) : r.text; if (r.subject && q("#mSub") && !q("#mSub").value.trim()) q("#mSub").value = r.subject;
      q("#mAiNote").textContent = r.note || (r.mode === "ia" ? "Listo. Revisalo antes de mandar." : "Armado con la plantilla de la casa. Revisalo antes de mandar.");
    } catch (err) { toast(err.message, { type: "err" }); }
    b.disabled = false; b.innerHTML = `${icon("sparkles", "sm")} Armar mensaje`;
  });
  const afterOpen = () => {
    if (logAfter) { D.form.channel = isMail ? "mail" : "whatsapp"; D.tab = "log"; D.result = null; D.form.sent = true; if (!D.form.text) D.form.text = `Mandé ${isMail ? "mail" : "WhatsApp"}: ${t.label.toLowerCase()}.`; draw(); toast("Cuando tengas respuesta (o no), registralo acá"); }
  };
  const openGmail = () => { open(gmailLink({ to: q("#mTo").value.trim(), subject: q("#mSub").value, body: q("#mText").value })); finished = true; m.close(); afterOpen(); };
  // ¿se puede mandar desde acá? Lo que ya trae la ficha y, al abrir, el servidor (el mismo control que el envío, sin
  // escribir nada). Si el servidor no responde, no se frena: el envío lo vuelve a comprobar.
  let chk = null, checking = null;
  const local = isMail ? mailBlockLocal(s, d) : "";
  if (local) chk = { ok: false, error: local };
  const check = () => chk ? Promise.resolve(chk) : (checking ||= api(`/api/schools/${s.id}/mail/check`).catch(() => ({ ok: true, soft: true })).then(r => { chk = r; checking = null; if (m.isConnected && phase === "edit") drawAct(); return r; }));
  if (isMail && canSend(S.gmail)) check();
  // el mail sale recién a los 5 s: hasta ahí se puede deshacer (o cerrar la ventana). Antes, se comprueba que se pueda.
  const startSend = async () => {
    const to = q("#mTo").value.trim(), subject = q("#mSub").value.replace(/\s+/g, " ").trim(), text = q("#mText").value;
    const bad = !to ? ["#mTo", "Poné a quién le mandás el mail."] : !MAIL_RE.test(to) ? ["#mTo", "Ese email no parece válido. Revisalo."] : !subject ? ["#mSub", "Poné el asunto."]
      : !text.trim() ? ["#mText", "El mensaje está vacío."] : PH_RE.test(subject) || PH_RE.test(text) ? [PH_RE.test(subject) ? "#mSub" : "#mText", "Completá lo que está entre corchetes ([día], [hora], [tu nombre]) antes de mandar."] : null;
    if (bad) { showErr(bad[1]); q(bad[0]).focus(); return; }
    showErr(""); note = ""; again = false;
    if (!chk) { phase = "checking"; editable(false); drawAct(); await check(); if (!m.isConnected) return; phase = "edit"; editable(true); }
    if (chk && !chk.ok) { drawAct(); return; }
    editable(false); phase = "count"; left = SEND_DELAY; drawAct(); q("#mUndo")?.focus();
    timer = setInterval(() => {
      left--; if (left > 0) { const c = q("#mCount"); if (c) c.textContent = left; return; }
      clearInterval(timer); timer = null; doSend({ to, subject, text });
    }, 1000);
  };
  let note = "";
  const undo = () => { clearInterval(timer); timer = null; phase = "edit"; note = "No se envió. Seguí editando y mandalo cuando quieras."; editable(true); drawAct(); q("#mSend")?.focus(); };
  // si la ficha se abrió desde una tarea «Mail» de la agenda, se marca como hecha
  const act = D.activityId && d.activities?.find(a => a.id === D.activityId), completeId = act?.type === "task" && D.form?.completeAct !== false ? act.id : null;
  const doSend = async p => {
    phase = "sending"; m.locked = true; drawAct();
    try {
      const r = await api(`/api/schools/${s.id}/mail`, { body: { ...p, key, completeActivityId: completeId, session: sessionRef() } });
      finished = true; m.locked = false; m.close();
      afterMailSent(s, r, { logAfter, completed: !!completeId });
    } catch (e) {
      m.locked = false; editable(true);
      // no se sabe si salió (Gmail no respondió) o esa clave ya se usó: no se vuelve a ofrecer «Enviar» con la misma clave
      if (e.code === "gmail_unknown" || e.code === "mail_dup") { phase = "unknown"; drawAct(); showErr(e.message); return; }
      phase = "edit";
      // cambió algo en Pipedrive (de otra persona, cliente, archivado): queda el motivo en lugar de «Enviar»
      if (!e.code && [403, 404, 409].includes(e.status)) chk = { ok: false, error: e.message };
      await loadGmail(true).catch(() => {}); // pudo vencer, desconectarse o pedir confirmar en este dispositivo
      drawAct(); showErr(chk && !chk.ok ? "" : e.message);
    }
  };
  function drawAct() {
    const a = q("#mAct"), g = S.gmail;
    if (!isMail) {
      a.innerHTML = `<div class="row"><button class="btn" id="mCopy">${icon("copy")} Copiar</button><button class="btn wa" id="mGo">${icon("whatsapp")} Abrir WhatsApp</button></div>
        <p class="faint" style="margin:0;font-size:12.5px">Se abre WhatsApp Web o la app. Si usás Volt, la conversación queda en el CRM automáticamente.</p>`;
      q("#mCopy").onclick = () => copy(q("#mText").value);
      q("#mGo").onclick = () => { const to = q("#mTo").value.trim(); if (!to) return toast("Poné el número", { type: "err" }); open(waLink(to, q("#mText").value, s.country)); finished = true; m.close(); afterOpen(); };
      return;
    }
    if (phase === "count") { a.innerHTML = `<div class="send-bar" role="status" aria-live="polite">${icon("send")}<span>Enviando en <b id="mCount">${left}</b> s</span><button class="btn" id="mUndo">Deshacer</button></div>`; q("#mUndo").onclick = undo; return; }
    q("#mClose").disabled = phase === "sending";
    if (phase === "sending" || phase === "checking") { a.innerHTML = `<div class="send-bar" role="status"><span class="spin"></span><span>${phase === "sending" ? "Enviando desde tu Gmail…" : "Comprobando en Pipedrive…"}</span></div>`; return; }
    if (phase === "unknown") {
      a.innerHTML = `<div class="row"><a class="btn" href="https://mail.google.com/mail/#sent" target="_blank" rel="noopener">${icon("mail")} Ver Enviados</a>
        ${again ? `<button class="btn" id="mNo">Cancelar</button><button class="btn primary" id="mAgain">Sí, mandarlo de nuevo</button>` : `<button class="btn" id="mAgain">Mandar igual</button>`}</div>
        <p class="faint mail-note">${again ? "Si ya salió, le llega dos veces." : "Si salió, cerrá y registralo en Registrar. Si no está en Enviados, mandalo de nuevo."}</p>`;
      q("#mNo")?.addEventListener("click", () => { again = false; drawAct(); });
      q("#mAgain").onclick = () => { if (!again) { again = true; drawAct(); q("#mAgain")?.focus(); return; } key = newKey(); phase = "edit"; startSend(); };
      return;
    }
    const send = canSend(g), confirm = needsConfirm(g), wait = gmailWaiting(), blocked = send && chk && !chk.ok;
    a.innerHTML = `<div class="row"><button class="btn" id="mCopy">${icon("copy")} Copiar</button>
      ${send && !blocked ? `<button class="btn ghost" id="mGo">Abrir en Gmail</button><button class="btn primary" id="mSend">${icon("send")} Enviar</button>`
        : !blocked && g?.enabled && !g.readOnly && !g.config ? `<button class="btn" id="mGo">Abrir en Gmail</button><button class="btn primary" id="mConnect">${wait ? `<span class="spin"></span> Esperando a Google…` : confirm ? `${icon("mail")} Confirmar tu Gmail en este dispositivo` : `${icon("mail")} Conectar Gmail para enviar desde acá`}</button>`
        : `<button class="btn primary" id="mGo">${icon("mail")} Abrir en Gmail</button>`}</div>
      ${note ? `<p class="mail-note" role="status" style="color:var(--info)">${esc(note)}</p>` : ""}
      ${blocked ? `<p class="mail-block" role="status">${icon("alert", "sm")}<span><b>Desde acá no se envía.</b> ${esc(chk.error)}</span></p>`
        : send ? `<p class="mail-how">${icon("checkCircle", "sm")}<span>Sale de tu Gmail (${esc(g.email)}) y queda en Pipedrive y en el historial.</span></p>
          ${g.signature ? `<details class="gm-sig"><summary>${esc(sigLabel(g))}</summary>${sigPreview(g.signature)}</details>` : `<p class="faint mail-note">Tu Gmail no tiene firma: sale sin firma. Podés pegar una en tu perfil.</p>`}`
        : g?.readOnly ? `<p class="faint mail-note">Modo solo lectura: desde acá no se envía. Usá «Abrir en Gmail».</p>`
        : g?.config ? `<p class="faint mail-note">Gmail está mal configurado en el servidor (avisale al administrador). Mientras, usá «Abrir en Gmail».</p>`
        : confirm ? `<p class="faint mail-note">Tu Gmail (${esc(g.email)}) ya está conectado. En este dispositivo confirmalo una vez con Google y después mandás con un clic.</p>`
        : g?.enabled ? `<p class="faint mail-note">${g.expired ? "Tu conexión con Gmail venció: conectalo de nuevo. " : ""}Lo conectás una vez y después mandás con un clic, con tu firma. Sale de tu Gmail y queda en Pipedrive y en el historial.</p>`
        : `<p class="faint mail-note">Para enviar desde acá falta configurar Gmail (lo hace el administrador).</p>`}`;
    q("#mCopy").onclick = () => copy(q("#mText").value);
    q("#mGo").onclick = openGmail;
    q("#mSend")?.addEventListener("click", startSend);
    q("#mConnect")?.addEventListener("click", async () => {
      const before = q("#mText").value;
      const p = connectGmail({ quiet: true }); note = ""; drawAct();
      const g2 = await p; if (!m.isConnected) return;
      showErr(canSend(g2) ? "" : g2.error || "");
      if (canSend(g2)) { note = `Gmail conectado como ${g2.email}. Ya podés enviar.`; check(); }
      // con firma, la despedida con tu nombre sobra (solo si no la tocaste)
      if (canSend(g2) && g2.signature && q("#mText").value === before) q("#mText").value = dropSignoff(before);
      drawAct(); q("#mSend")?.focus();
    });
  }
  drawAct();
  // en el celular no se abre el teclado de entrada: el foco va a la acción principal
  if (coarse()) setTimeout(() => (q("#mSend") || q("#mGo"))?.focus(), 0);
}
// Después de enviar: Registrar se abre con el mail ya registrado (canal mail y lo enviado) para elegir el próximo paso
function afterMailSent(s, r, { logAfter, completed }) {
  if (r.school) patchSchool(r.school);
  S.today = null; S.agenda = null;
  if (S.session) S.session.done++;
  import("./explore.js").then(x => x.refreshExplore());
  // si ya estabas cargando otro contacto en Registrar (con resultado o comentario), no se pisa: solo el aviso
  const busy = D.id === s.id && !D.result && !D.form?.mail && (D.form?.outcome || (D.form?.text?.trim() && !D.form?.sent));
  const warns = (r.done || []).filter(x => x.warn), here = D.id === s.id && logAfter && !busy, pdOk = r.logged?.pipedrive !== false;
  // con Registrar abierto, lo dice ahí (el aviso flotante taparía el pie); si no, aviso
  if (!here) { toast(`Mail enviado a ${r.mail.to}${pdOk ? ". Quedó en Pipedrive" : ""}`); if (warns.length) toast(warns.map(x => x.label).join(" "), { type: "err" }); }
  if (D.id !== s.id) return;
  if (completed) D.activityId = null;
  if (here) {
    // la actividad de la agenda desde la que se abrió la ficha (si el envío no la marcó hecha): se ofrece marcarla
    const a = !completed && D.activityId ? (D.data?.activities || []).find(x => x.id === D.activityId) : null;
    const f = newForm();
    Object.assign(f, { channel: "mail", sent: true, text: `Mandé mail: ${r.mail.subject}`, why: !r.mail.autoNext && !r.mail.pendingNext ? r.suggest?.why || "" : "",
      mail: { ...r.mail, done: r.done || [], logged: r.logged || null, fallback: r.fallback || null, act: a && a.type !== "meeting" ? { id: a.id, subject: a.subject, type: a.type } : null } });
    f.completeAct = !!f.mail.act;
    f.next = mailDefaultNext(f);
    D.form = f; D.tab = "log"; D.result = null; draw(); toTabs();
  }
  // la ficha al día (Historial con el mail, pendientes con el próximo paso)
  api(`/api/schools/${s.id}`).then(nd => { if (D.id === s.id) { D.data = nd; keepScroll(draw); } }).catch(() => {});
}

// Ctrl + Enter guarda; en la pantalla de resultado, Enter pasa al siguiente de la sesión. En escritorio, 1 a 8 eligen qué pasó (fuera de los campos de texto).
const typing = t => t?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t?.tagName || "");
addEventListener("keydown", e => {
  if (!drawerOpen() || document.querySelector(".modal")) return;
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && D.tab === "log" && !D.result) { e.preventDefault(); $("drawer").querySelector("#save")?.click(); }
  else if (/^[1-9]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey && D.tab === "log" && !D.result && !D.saving && !coarse() && !typing(e.target)) {
    const b = $("drawer").querySelectorAll("[data-oc]")[+e.key - 1]; if (b && !b.disabled) { e.preventDefault(); b.click(); $("drawer").querySelector(`[data-oc="${b.dataset.oc}"]`)?.focus(); }
  }
});

// «Ver qué pasó» (desde Registrar): va a la historia con OrderEAT en Preparar
document.addEventListener("click", e => {
  if (!e.target.closest?.("[data-see-hist]")) return;
  goTab("prep"); setTimeout(() => $("drawer").querySelector("#histSec")?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
});
