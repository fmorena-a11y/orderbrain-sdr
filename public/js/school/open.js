// Ficha del colegio: abrir y cerrar, dirección del encabezado, pausa y retomar sesión, carga de la ficha.
import { $, S, api, esc, fold, icon, loadPref, patchSchool, save, toast } from "../core.js";
import { D, drafts, drawerOpen, newForm } from "./state.js";
import { keepScroll, loadBaseInfo, loadPhotos, loadStudy } from "./media.js";
import { loadEnrich, loadHistory, loadSedes } from "./sections.js";
import { dealsSession, firstPending, flushPos, markSkip, myDeal, pendingOf, prefetch, savePos, sessionGo, skipReason, useSession } from "./session.js";
import { draw } from "./render.js";
import { liveBase } from "./register.js";
import { loadMyDeals, loadTimeline } from "./history.js";

// ---------- abrir / cerrar
// Abre la ficha de un prospecto (lead) o de una organización de Pipedrive que no está en la base ("lead:…" / "org:…").
// La dirección para mostrar y copiar (pedido del líder: «un título que diga Dirección y que se pueda copiar con un clic»):
// la de la base, si no la que encontró el estudio, y si no la ciudad y el país.
export const phoneOnly = v => (String(v || "").match(/\+?\d[\d\s().\/-]{5,}\d/) || [""])[0].trim();
export function fullAddr(street, s) {
  const out = [];
  for (const p of [street, s.city, s.country].map(x => String(x || "").trim()).filter(Boolean)) if (!out.some(o => fold(o).includes(fold(p)))) out.push(p);
  return out.join(", ");
}
// D.addr: lo que dice el servidor (/address): escrita a mano, de la base o del punto del mapa
export function addrRow(s) {
  const A = D.id === s.id ? D.addr : null;
  if (D.id === s.id && D.addrEdit) return `<form class="sub d-addr edit" id="addrF"><span class="k">Dirección</span><input class="inp sm" id="addrIn" value="${esc(A?.src === "manual" ? A.addr : s.addr || A?.addr || "")}" placeholder="Calle y número, barrio" maxlength="200" autocomplete="off"><button class="btn sm primary" type="submit">Guardar</button><button class="btn sm ghost" type="button" id="addrNo">Cancelar</button></form>`;
  const street = (A?.src === "manual" && A.addr) || s.addr || (A?.src === "mapa" && A.addr) || (D.id === s.id ? D.study?.contacto?.direccion : "") || "";
  const line = fullAddr(street, s);
  const tag = A?.src === "manual" ? ` <span class="faint" title="${esc([A.by && `Cargada a mano por ${A.by}`, A.at && new Date(A.at).toLocaleDateString()].filter(Boolean).join(" · "))}">(a mano)</span>` : A?.src === "mapa" && !s.addr ? ` <span class="faint" title="Sale del punto del colegio en el mapa (OpenStreetMap): revisala">(del mapa)</span>` : !street ? " (solo ciudad)" : "";
  return `<div class="sub d-addr"><span class="k">Dirección${tag}</span> <span class="v">${esc(line || "sin dirección")}</span>${line ? `<button class="icon-btn sm" data-copy="${esc(line)}" aria-label="Copiar la dirección" title="Copiar la dirección">${icon("copy", "sm")}</button>` : ""}<button class="icon-btn sm" id="addrEd" aria-label="Escribir la dirección a mano" title="Escribir la dirección a mano">${icon("edit", "sm")}</button></div>`;
}
async function loadAddr(id) {
  try { const r = await api(`/api/schools/${encodeURIComponent(id)}/address`); if (D.id !== id) return; D.addr = r; keepScroll(draw); } catch { /* sin dirección del servidor: queda la de la base */ }
}
export function bindAddr(s) {
  const el = $("drawer");
  el.querySelector("#addrEd")?.addEventListener("click", () => { D.addrEdit = true; draw(); const i = el.querySelector("#addrIn"); i?.focus(); i?.select(); });
  el.querySelector("#addrNo")?.addEventListener("click", () => { D.addrEdit = false; draw(); });
  el.querySelector("#addrIn")?.addEventListener("keydown", e => { if (e.key === "Escape") { e.preventDefault(); D.addrEdit = false; draw(); } });
  el.querySelector("#addrF")?.addEventListener("submit", async e => {
    e.preventDefault();
    const b = e.currentTarget.querySelector("button[type=submit]"), v = el.querySelector("#addrIn").value.trim();
    b.disabled = true; b.innerHTML = `<span class="spin"></span>`;
    try {
      const r = await api(`/api/schools/${encodeURIComponent(s.id)}/address`, { body: { addr: v } });
      D.addr = { addr: r.addr, src: "manual", by: S.me?.name || "", at: new Date().toISOString() }; D.addrEdit = false;
      patchSchool({ id: s.id, addr: r.addr });
      toast([`Dirección guardada: ${r.line}`, ...(r.done || []).map(x => x.label), ...(r.warnings || [])].join(" · "), r.warnings?.length ? { type: "info", ms: 8000 } : {});
      draw();
    } catch (x) { toast(x.message, { type: "err" }); b.disabled = false; b.textContent = "Guardar"; }
  });
}
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
const isRef = id => /^(lead|org|bx):/.test(id);
// sref: el colegio de la sesión que se está trabajando (lo que se registre en la ficha queda anotado ahí)
// Un colegio que ya no está en la base (un extra que se sacó, un id viejo) se saltea anotado, como la tarea que no se pudo abrir;
// si la base todavía no cargó (Retomar apenas entrás), se espera.
// stay: se eligió a mano un colegio salteado (desde «Ver detalle»): se abre en la sesión y no se vuelve a saltear solo.
// Datos de la ficha pedidos por adelantado (pedido del líder: «más rápido entre elección y selección»): la ficha espera a
// /api/schools/:id, que revisa Pipedrive y tarda; se pide apenas el mouse se queda sobre un colegio (200 ms), al apretar
// (antes de soltar) y, en una sesión, el siguiente. Vale 45 s, una vez, y cualquier escritura (ob:wrote) lo descarta.
const PF = new Map(), PF_MS = 45000;
export function prefetchSchool(id) {
  if (!id || !S.byId.has(id) || D.id === id) return;
  const hit = PF.get(id); if (hit && Date.now() - hit.at < PF_MS) return;
  PF.set(id, { at: Date.now(), p: api(`/api/schools/${encodeURIComponent(id)}`).catch(() => null) });
  if (PF.size > 12) PF.delete(PF.keys().next().value);
}
function takePrefetch(id) { const hit = PF.get(id); PF.delete(id); return hit && Date.now() - hit.at < PF_MS ? hit.p : null; }
addEventListener("ob:wrote", () => PF.clear());
const pfId = el => { const r = el?.closest?.("[data-school], [data-id]"); const id = r?.dataset.school || r?.dataset.id; return id && S.byId.has(id) ? id : null; };
let pfT = 0;
document.addEventListener("pointerover", e => { const id = pfId(e.target); clearTimeout(pfT); if (id) pfT = setTimeout(() => prefetchSchool(id), 200); }, { passive: true });
document.addEventListener("pointerdown", e => prefetchSchool(pfId(e.target)), { passive: true, capture: true });
document.addEventListener("focusin", e => { const id = pfId(e.target); if (id) prefetchSchool(id); });
export function openAt(ss, i, { stay = false } = {}) {
  ss.i = i; savePos(ss); const r = ss.ids[i];
  // el que sigue en la sesión ya se va pidiendo mientras trabajás este
  for (let j = i + 1; j < ss.ids.length; j++) { const it = ss.items[j]; if (it && it.state !== "pending") continue; prefetchSchool(ss.ids[j]); break; }
  // sesión «Tus tratos»: un trato sin organización (ni su persona tiene) no tiene ficha: se saltea con el motivo
  if (/^deal:\d+$/.test(r)) { toast(`${ss.items[i]?.name || "Un trato"} no tiene organización en Pipedrive, lo salteé`, { type: "info", href: `${S.pdWeb}/deal/${r.slice(5)}`, action: "Abrir en Pipedrive" }); markSkip(ss, r, "missing", "el trato no tiene organización en Pipedrive"); return sessionGo(1); }
  if (isRef(r) || S.byId.has(r)) return (isRef(r) ? openRecord : openSchool)(r, { keepSession: true, sref: r, activityId: ss.acts[r] || null, tab: "prep", noSkip: stay });
  if (!S.schools.length && !S.baseError && S.baseP) {
    toast("Cargando colegios…", { type: "info" });
    return S.baseP.then(() => { if (S.session === ss && ss.i === i) openAt(ss, i, { stay }); });
  }
  if (!S.schools.length) { if (!drawerOpen()) S.session = null; return toast(`No pude cargar los colegios${S.baseError ? `: ${S.baseError}` : ""}. Probá de nuevo en un rato.`, { type: "err" }); }
  toast(`${ss.items[i]?.name || "Un colegio de la sesión"} ya no está en la base, lo salteé`, { type: "info" });
  markSkip(ss, r, "missing", "ya no está en la base");
  return sessionGo(1);
}
// cbOpen: «Ver historial» de Tus inbound: abre en Historial con el resumen compacto y lleva la vista a la línea de tiempo.
export async function openSchool(id, { activityId = null, tab = null, keepSession = false, sref = null, cbOpen = false, noSkip = false, deals = false } = {}) {
  if (!S.byId.has(id)) return toast("Colegio inexistente", { type: "err" });
  if (!keepSession) S.session = null;
  if ($("drawer").hidden) { D.opener = document.activeElement; history.pushState({ ...(history.state || {}), drawer: id }, ""); }
  import("../app.js").then(m => m.rememberSchool(id));
  const draft = drafts.get(id); drafts.delete(id);
  Object.assign(D, { sref: keepSession ? sref || id : null, inCall: false, call: null, id, data: null, form: draft?.form || newForm(), activityId: activityId ?? draft?.activityId ?? null, saving: false, result: null, brief: null, briefLoading: false, err: null, photos: null, study: undefined, studyWorking: false, studyErr: null, tl: null, addr: null, addrEdit: false, toTl: !!cbOpen && !draft, noSkip: !!noSkip, cbLogOpen: false, tab: draft ? "log" : tab || (activityId ? "log" : "prep"),
    // tu trato arriba de la ficha: en una sesión «Tus tratos» o si se abrió desde el Hoy del account (deals)
    dealsOn: !!deals || (keepSession && dealsSession(S.session)), myDeals: null });
  if (draft) toast("Recuperé lo que estabas cargando", { type: "info" });
  $("drawer").hidden = false; $("scrim").hidden = false;
  $("scrim").onclick = closeSchool;
  $("app").inert = true; document.querySelector(".skip").inert = true; // lo de atrás no recibe foco ni clics
  $("drawer").scrollTop = 0;
  draw();
  $("drawer").querySelector("#dClose")?.focus();
  load();
  loadMyDeals();
  loadTimeline(id);
  loadPhotos(id);
  loadStudy(id);
  loadAddr(id);
  loadBaseInfo(id);
}
// El botón Atrás del celular cierra la ficha en vez de cambiar la pantalla de abajo.
addEventListener("popstate", () => { if (drawerOpen()) closeSchool({ fromPop: true }); });
// el aviso «Sesión en pausa» (uno solo a la vez)
let pauseToast = null;
export const dropPauseToast = () => { pauseToast?.remove(); pauseToast = null; };
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
  dropPauseToast();
  const ss = S.session; S.session = null;
  if (ss) leaveSession(ss);
  // el foco vuelve a la fila del colegio (aunque la vista se haya redibujado) o al contenido. Hoy vuelve a leer las
  // sesiones al redibujarse (loadToday), después de lo que se esté guardando (S.sessSaving).
  import("../app.js").then(m => ["hoy", "agenda", "sesiones"].includes(S.view) && m.rerender()).then(() => {
    const target = D.opener?.isConnected ? D.opener : document.querySelector(`#main [data-school="${closedId}"], #main [data-id="${closedId}"]`);
    (target || $("main")).focus({ preventScroll: !target });
  });
}
// Lo registrado en la sesión, como en la tarjeta de Hoy: «3 llamadas · 1 WhatsApp · 1 comentario · 2 salteados»
export const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
function sessionSummary(ss) {
  const c = { call: 0, whatsapp: 0, mail: 0, visit: 0 }; let demos = 0, comments = 0;
  for (const x of ss.steps || []) { if (x.kind === "contact") { c[x.channel] = (c[x.channel] || 0) + 1; if (x.outcome === "demo") demos++; } else if (x.kind === "comment") comments++; }
  const skipped = (ss.items || []).filter(x => x.state === "skipped").length;
  return [c.call && plural(c.call, "llamada", "llamadas"), c.whatsapp && `${c.whatsapp} WhatsApp`, c.mail && plural(c.mail, "mail", "mails"), c.visit && plural(c.visit, "visita", "visitas"),
    demos && plural(demos, "demo agendada", "demos agendadas"), comments && plural(comments, "comentario", "comentarios"), skipped && plural(skipped, "salteado", "salteados")].filter(Boolean).join(" · ");
}
// Al salir de la sesión (se cerró la ficha o se llegó al final): guarda por dónde iba, avisa lo hecho y qué falta, y si no
// falta nada la deja en terminadas.
// «Sesión en pausa» tapaba la pantalla 8 s cada vez que se cerraba una ficha: va solo la primera vez de cada sesión y más
// corto (después se retoma desde Hoy o desde Sesiones). Una sesión sin guardar (sin id) avisa siempre: el aviso es la única
// forma de retomarla.
const PAUSE_KEY = "sess.pauseSeen";
function pauseFirst(ss) {
  if (!ss.id) return true;
  const seen = loadPref(PAUSE_KEY, []) || [];
  if (seen.includes(ss.id)) return false;
  save(PAUSE_KEY, [...seen, ss.id].slice(-40));
  return true;
}
export function leaveSession(ss) {
  dropPauseToast();
  let saved = flushPos(ss);
  const left = pendingOf(ss), sum = sessionSummary(ss);
  if (left > 0) { if (pauseFirst(ss)) pauseToast = toast(`Sesión en pausa: ${[sum, `faltan ${left}`].filter(Boolean).join(" · ")}`, { ms: ss.id ? 5000 : 8000, action: { label: "Retomar", fn: () => resumeSession(ss.id ? ss.id : ss) } }); }
  else {
    if (ss.id) saved = saved.then(() => api(`/api/sessions/${ss.id}`, { method: "PATCH", body: { status: "done", reason: "completa" } })).then(r => import("../sessions.js").then(m => m.cacheSession(r.session))).catch(() => {});
    toast(sum ? `Sesión terminada: ${sum}` : "Sesión terminada");
  }
  S.sessSaving = saved;
}
// Retomar: la sesión guardada (por id; sin id, la abierta más reciente que tenga algo pendiente) desde el colegio donde
// quedó, salteando lo ya trabajado. at: un colegio puntual de la sesión (desde «Ver detalle»). Se lee de nuevo del
// servidor por si se trabajó desde otro dispositivo. Una sesión que no se pudo guardar se retoma desde memoria.
export async function resumeSession(id, { at = null } = {}) {
  dropPauseToast();
  if (id && typeof id === "object") { const ss = id; if (pendingOf(ss) || at != null) { S.session = ss; openAt(ss, at ?? firstPending(ss)); prefetch(); } return; }
  // at: un colegio puntual (desde «Ver detalle»): uno que falta o uno salteado (ese se abre en la sesión sin volver a saltearlo)
  const open = S.sessions?.open || [];
  id = id || (open.find(v => v.resume >= 0) || open[0])?.id;
  if (!id) return toast("No tenés sesiones abiertas.", { type: "err" });
  const sm = await import("../sessions.js");
  let v = sm.cachedSession(id); // la lista trae solo resúmenes: la sesión entera se lee de nuevo (o la última que respondió)
  try { v = (await api(`/api/sessions/${encodeURIComponent(id)}`)).session; sm.cacheSession(v); }
  catch (e) { if (!v) return toast(e.message, { type: "err" }); }
  const i = at ?? v.resume;
  if (i == null || i < 0) return toast("Ya trabajaste todos los colegios de esta sesión.");
  S.session = useSession(v);
  openAt(S.session, i, { stay: at != null && S.session.items[i]?.state === "skipped" });
  prefetch();
}
export async function load(opts = {}) {
  const id = D.id;
  try {
    let d;
    if (opts.match !== undefined) d = await api(`/api/schools/${id}/match`, { body: opts.match });
    else d = (!opts.refresh && await takePrefetch(id)) || await api(`/api/schools/${id}${opts.refresh ? "?refresh=1" : ""}`);
    if (D.id !== id) return;
    D.data = d; D.err = null; patchSchool(d.school);
    // en la sesión no se trabaja un cliente, un trato abierto ajeno ni algo de otra persona: se saltea aunque ya figure
    // salteado (la revisión de adelante pudo anotarlo mientras la ficha se abría); lo ya trabajado no se toca
    const ss = S.session, cur = ss && D.sref && ss.items.find(x => x.ref === D.sref);
    const why = cur && cur.state !== "worked" && !D.noSkip && !opts.refresh && opts.match === undefined && skipReason(d.school, !!D.activityId && myDeal(d.match), dealsSession(ss));
    if (why) { toast(`${d.school.name}: ${why.text}, lo salteé`); markSkip(ss, D.sref, why.code, why.text); return sessionGo(1); }
    loadSedes(id); loadEnrich(id); loadHistory(id, d);
    if (opts.refresh || opts.match !== undefined) loadTimeline(id, { refresh: !!opts.refresh });
  } catch (e) { if (D.id === id) D.err = e.message; }
  if (D.id === id) draw();
}
