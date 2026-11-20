// Ficha del colegio: dibujo de la ficha, pestañas, encabezado y «Más», crear prospecto, convertir y archivar.
import { $, S, ago, api, callGuess, copy, dayLabel, esc, icon, leadsAll, leadsOver, mapsDir, mapsSearch, modal, nextBusinessDay, openMenu, patchSchool, potTag, stageTag, statusPill, telLink, toast, today } from "../core.js";
import { proposeDemo } from "../demoslots.js";
import { dealBarHtml } from "../aedeal.js";
import { D, NEXT_TYPES, coarse, miniCal } from "./state.js";
import { addrRow, bindAddr, closeSchool, load, webOf } from "./open.js";
import { ENR, enrich, enriching, loadEnrich, sedeCallable, sedesOf } from "./sections.js";
import { myDeal, sessionGo, skipCurrent } from "./session.js";
import { apiEx, bindPrep, prepBody } from "./prep.js";
import { bindLog, bindResult, gotLead, logBody, resultBody, saveDisabled, saveLabel, suggest, summary } from "./register.js";
import { bindHist, histBody } from "./history.js";
import { messageModal, templateMenu } from "./messages.js";

// ---------- render
const focusKey = el => el && (el.id ? `#${el.id}` : ["tab", "oc", "ch", "f", "caf", "niv", "nd", "ph"].map(k => el.dataset?.[k] !== undefined ? `[data-${k}="${el.dataset[k]}"]` : "").find(Boolean));
// «Lo voy a contactar»: se puede crear el prospecto si no es cliente, no tiene trato abierto ni prospecto, y no es de otra persona
// Prospecto → trato: si tiene un prospecto abierto tuyo (o sin dueño) y todavía no hay trato abierto
function canConvert(s, d) {
  if (!d || !S.me.pdUserId || d.match?.status === "open" || d.archive || ["client", "churn", "archived"].includes(s.status)) return false;
  if (s.leadOnly) return !s.ownerId || s.ownerId === S.me.pdUserId || leadsOver(s.ownerId);
  return !!d.leads?.some(l => !l.ownerId || l.ownerId === S.me.pdUserId || leadsOver(l.ownerId));
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
export function canProspect(s, m) {
  if (s.virtual || !D.data || m?.leadId || D.data.leads?.length || !S.me.pdUserId) return false;
  if (["client", "open", "churn", "archived"].includes(s.status) || s.ob?.client || D.data.archive) return false;
  if (s.ownerId && S.me.pdUserId && s.ownerId !== S.me.pdUserId) return false;
  return true;
}
// «Crear prospecto»: antes de crearlo se elige la primera tarea a futuro (siempre conviene dejar algo para hacer).
// Viene precargada: llamada el próximo día hábil, para vos. Se puede cambiar, asignar a otra persona o, si de verdad
// no hace falta, crear sin tarea.
export function createProspect(s) {
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
        <p class="muted" style="margin:0;font-size:var(--fs-sm)">${esc(S.types[st.type] || "Tarea")} el ${esc(dayLabel(st.date).toLowerCase())}${st.time ? ` a las ${esc(st.time)}` : ""} · para ${esc(st.ownerId ? team.find(u => String(u.id) === String(st.ownerId))?.name || "" : "vos")}</p></div></div>`;
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
    const r = await apiEx(s, `/api/schools/${s.id}/prospect`, { body: { task } });
    patchSchool(r.school); gotLead(s, r);
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
    import("../explore.js").then(x => x.refreshExplore({ fit: false }));
  } catch (e) { if (D.prospecting === s.id) D.prospecting = false; if (D.id === s.id) draw(); toast(e.message, { type: "err" }); }
}
// ---------- archivar en la app: no clientes ni lo de otra persona (trato abierto, organización o prospecto; salvo un líder).
// Desarchiva quien archivó, quien lo tiene en Pipedrive o un líder. El servidor revisa lo mismo.
// de otra persona que no es de tu gente (si sos líder de un equipo, lo de tu gente cuenta como tuyo)
const theirs = id => !!id && id !== S.me.pdUserId && !leadsOver(id);
const othersOwn = (s, d) => theirs(s.ownerId) || !!d.leads?.some(l => theirs(l.ownerId)) || (!!s.leadOnly && (!("leadOwnerId" in d) || theirs(d.leadOwnerId)));
const ownsIt = (s, d) => !!S.me.pdUserId && (s.ownerId === S.me.pdUserId || !!d?.leads?.some(l => l.ownerId === S.me.pdUserId) || d?.leadOwnerId === S.me.pdUserId);
const canArchive = (s, d) => !!d && !d.archive && s.status !== "client" && !s.ob?.client && (leadsAll() || (!(d.match?.status === "open" && !myDeal(d.match) && !leadsOver(d.match.openDealOwnerId)) && !othersOwn(s, d)));
const canUnarchive = (a, s, d) => !!a && (leadsOver(null, a.by) || String(a.by || "").toLowerCase() === String(S.me.email || "").toLowerCase() || ownsIt(s, d));
const ddmmOf = iso => { const t = new Date(iso); return isNaN(t) ? "?" : `${String(t.getDate()).padStart(2, "0")}/${String(t.getMonth() + 1).padStart(2, "0")}`; };
const archBox = (a, s, d) => `<div class="arch-box">${icon("archive")}<span>Archivado por <b>${esc(a.byName || "?")}</b> el ${ddmmOf(a.at)}: ${esc(a.reason)}${a.text ? ` — ${esc(a.text)}` : ""}</span>${canUnarchive(a, s, d) ? `<button class="btn sm" id="aUnarch">${D.archiving ? `<span class="spin"></span> Desarchivando…` : "Desarchivar"}</button>` : ""}</div>`;
async function afterArchive(s, r) {
  if (r.school) patchSchool(r.school);
  toast(r.done.map(x => x.label).join(" · "), r.done.some(x => x.warn) ? { type: "info", ms: 10000 } : {});
  if (D.id === s.id) { D.data = await api(`/api/schools/${encodeURIComponent(s.id)}`).catch(() => D.data); }
  S.today = null; S.agenda = null;
  import("../explore.js").then(x => x.refreshExplore({ fit: false }));
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
export function clientWarn(s, m) {
  // con un trato abierto TUYO (un account con el trato de un colegio que prospectó un SDR) no va el aviso de «es de otra
  // persona» ni el de «coordiná con quien tiene el trato»: lo trabajás vos. Cliente y ex cliente se avisan igual.
  const mine = myDeal(m);
  if (!mine && s.ownerId && S.me.pdUserId && s.ownerId !== S.me.pdUserId && s.status !== "client") return `Esta organización es de ${s.ownerName || "otra persona"} en Pipedrive. No la contactes: si te interesa, hablalo con esa persona.`;
  if (s.status === "client") return s.ob && !s.ob.churn ? `Ya es cliente de OrderEAT en OrderBrain (${s.ob.label}${s.ob.client && s.ob.client !== s.name ? `, ${s.ob.client}` : ""}). No lo prospectes: si hay algo, avisale al equipo de cuentas.` : "Ya es cliente de OrderEAT. No lo prospectes: si hay algo, avisale al equipo de cuentas.";
  if (s.ob?.churn || s.phase === "churn") return s.ob?.label && s.ob.label !== "Churn" ? `${s.ob.label} en OrderEAT (firmó y no llegó a usarlo). Antes de contactar, hablá con el equipo de cuentas para saber qué pasó.` : "Ex cliente de OrderEAT (era activo y se dio de baja). Antes de contactar, hablá con el equipo de cuentas para saber por qué se fue.";
  if (s.status === "open") {
    // el trato es tuyo: no hay con quién coordinar (va como dato, no como alerta: ownDeal)
    if (myDeal(m)) { const st = openStage(m); return `Tenés un trato abierto${st ? ` (${st})` : ""}: lo que registres va al trato.`; }
    return `Tiene un trato abierto${m?.openDealOwner ? ` de ${m.openDealOwner}` : ""}. Coordiná con esa persona antes de contactar.`;
  }
  return "";
}
// la etapa del trato abierto (de los tratos que trae la ficha)
const openStage = m => (D.data?.deals || []).find(x => x.status === "open" && (!m?.openDealId || x.id === m.openDealId))?.stage || "";
// el aviso de arriba es por un trato abierto TUYO (dato) y no por algo de otra persona, un cliente o un ex cliente (alerta)
export const ownDeal = (s, m) => s.status === "open" && myDeal(m) && !(s.ownerId && S.me.pdUserId && s.ownerId !== S.me.pdUserId) && !(s.ob?.churn || s.phase === "churn");
export function draw() {
  const el = $("drawer"); if (!D.id) return;
  const fk = el.contains(document.activeElement) ? focusKey(document.activeElement) : null;
  const s = S.byId.get(D.id), d = D.data, m = d?.match, ss = S.session;
  if (d?.archive && D.tab === "log") D.tab = "prep"; // archivado: no se registran contactos (primero se desarchiva)
  const here = sedesOf(s.id).find(z => z.here), sedePhones = sedesOf(s.id).filter(z => sedeCallable(z).length).length;
  const phone = s.phone || (here && sedeCallable(here)[0]) || "";
  const mk = d?.market || S.markets[s.country] || {};
  const nHist = D.tl?.id === s.id && D.tl.total != null ? D.tl.total : 0;
  const notReady = !d ? `disabled title="${D.err ? "No se pudo cargar la ficha" : "Cargando la ficha…"}"` : "";
  // arriba quedan 4 acciones (Llamar, WhatsApp, Mail y Demo); el resto, con texto, en «Más» (moreItems). Lo que se está
  // haciendo desde «Más» (crear el prospecto, enriquecer…) se ve en ese botón.
  const demoOff = !d ? "" : s.status === "client" ? "Ya es cliente" : d.archive ? "Está archivado: desarchivalo para registrar" : "";
  const topBusy = D.prospecting === s.id ? "Creando…" : D.converting === s.id ? "Convirtiendo…" : enriching.has(s.id) ? "Buscando…" : D.archiving === s.id && !d?.archive ? "Archivando…" : "";
  el.innerHTML = `
  ${ss ? `<div class="d-session"><span class="progress" aria-hidden="true"><span style="width:${(ss.i + 1) / ss.ids.length * 100}%"></span></span>
    <span class="lbl">${icon("play", "sm")} <span class="ell"><b>${ss.i + 1}</b>/${ss.ids.length}<span class="hide-sm"> · ${esc(ss.name || "sesión")}</span></span></span>
    <button class="btn sm ghost" id="prev" ${ss.i ? "" : "disabled"} aria-label="Colegio anterior">${icon("arrowLeft", "sm")}</button><button class="btn sm" id="skip">${icon("skip", "sm")} Saltar</button></div>` : ""}
  ${D.dealsOn ? dealBarHtml(D.myDeals) : ""}
  <div class="d-top">
    <div class="d-title"><div class="tt"><h2 id="dTitle">${esc(s.name)}</h2>${addrRow(s)}</div>
      <div class="d-tr">${statusPill(s)}${d?.orgUrl ? `<a class="icon-btn" href="${esc(d.orgUrl)}" target="_blank" rel="noopener" title="Abrir en Pipedrive" aria-label="Abrir en Pipedrive">${icon("external")}</a>` : ""}<button class="icon-btn" id="dClose" aria-label="Cerrar ficha" title="Cerrar (Esc)">${icon("x")}</button></div></div>
    <div class="d-meta">
      ${statusPill(s)}${stageTag({ ...s, status: m?.status === "open" ? "open" : s.status, lead: s.lead || !!d?.leads?.length || !!s.leadOnly })}${potTag(s)}
      ${mk.espacio ? `<span class="tag" title="Decí «${esc(mk.espacio)}» y tratá de ${mk.trato === "vos" ? "vos" : "tú"}">«${esc(mk.espacio)}» · ${mk.trato === "vos" ? "vos" : "tú"}</span>` : ""}
      ${s.hours ? `<span class="tag" title="Horario">${icon("clock", "sm")} ${esc(s.hours)}</span>` : ""}
      ${s.rating ? `<span class="tag" title="Reseñas en Google">★ ${esc(s.rating)}</span>` : ""}
      ${(s.opp || []).filter(o => !/^Privado confirmado/.test(o)).map(o => `<span class="tag">${esc(o)}</span>`).join("")}
      ${d?.attempts ? `<span class="tag">${d.attempts} intento${d.attempts > 1 ? "s" : ""} sin respuesta</span>` : ""}
      ${s.lastTouch ? `<span class="tag">Último: ${esc(s.lastTouch.outcome.toLowerCase())} ${esc(ago(s.lastTouch.at))}</span>` : ""}
      ${m?.openDealOwner || (m?.openDealId && myDeal(m)) ? `<span class="tag">${icon("deal", "sm")} ${myDeal(m) ? "Trato tuyo" : `Trato de ${esc(m.openDealOwner)}`}</span>` : ""}
    </div>
    ${d?.archive ? archBox(d.archive, s, d) : ""}
    <div class="d-actions">
      ${phone ? `<a class="btn primary" id="aCall" href="${esc(telLink(phone))}">${icon("phone")} Llamar <span class="num">${esc(phone)}</span></a>` : sedePhones ? `<button class="btn primary" id="aSedes">${icon("phone")} Teléfonos de ${sedePhones} sede${sedePhones > 1 ? "s" : ""}</button>` : ""}
      <button class="btn wa" id="aWa" ${notReady} aria-haspopup="menu">${icon("whatsapp")} WhatsApp</button>
      <button class="btn" id="aMail" ${notReady} aria-haspopup="menu">${icon("mail")} Mail</button>
      <button class="btn" id="aDemo" ${notReady} ${demoOff ? `disabled title="${demoOff}"` : `title="Proponerle horarios al colegio o registrar la demo que ya agendaste"`} aria-haspopup="menu">${icon("video")} Demo ${icon("chevDown", "sm")}</button>
      <button class="btn" id="aMore" aria-haspopup="menu" title="${esc(moreItems(s, d).filter(x => x.label).map(x => x.label).join(" · "))}">${topBusy ? `<span class="spin"></span> ${topBusy}` : `Más ${icon("chevDown", "sm")}`}</button>
      ${phone || sedePhones ? "" : `<span class="no-phone">${icon("phone", "sm")} Sin teléfono publicado</span>`}
    </div>
    ${D.inCall && D.tab !== "log" && !d?.archive ? `<button class="call-banner" id="toLog">${icon("phone", "sm")} ¿Cortaste? Registrá cómo te fue ${icon("arrowRight", "sm")}</button>` : ""}
  </div>
  <div class="tabs" role="tablist" aria-label="Secciones de la ficha">
    ${[["prep", "Preparar"], ["log", "Registrar"], ["hist", "Historial"]].filter(([k]) => k !== "log" || !d?.archive).map(([k, l]) => `<button class="tab" role="tab" id="tab-${k}" data-tab="${k}" aria-selected="${D.tab === k}" aria-controls="dBody" tabindex="${D.tab === k ? 0 : -1}"${k === "log" && !coarse() ? ` title="Atajo: con las teclas 1 a ${Math.min(9, S.outcomes.length)} elegís qué pasó desde cualquier pestaña"` : ""}>${l}${k === "hist" && nHist ? `<span class="n">${nHist}</span>` : ""}</button>`).join("")}
  </div>
  <div class="d-body" id="dBody" role="tabpanel" aria-labelledby="tab-${D.tab}" aria-busy="${!d && !D.err}">${S.demo ? `<p class="demo-note" title="Pipedrive todavía no está conectado: los tratos, notas y personas de esta ficha son inventados y no son los de tu cuenta.">${icon("alert", "sm")}<span><b>Datos de prueba.</b> Pipedrive no está conectado: lo de esta ficha es inventado.</span></p>` : ""}${D.err ? `<div class="callout err">${icon("alert")}<span>No se pudo cargar la ficha: ${esc(D.err)}</span><button class="btn sm" id="retry">Reintentar</button></div>` : !d ? loadingBody() : D.tab === "prep" ? prepBody(s, d) : D.tab === "log" ? (D.result ? resultBody(s, d) : logBody(s, d)) : histBody(s, d)}</div>
  ${D.tab === "log" && d && !D.result ? `<div class="d-foot"><div class="sum" id="sum">${summary(s, d)}</div><button class="btn primary lg" id="save" ${saveDisabled(s) ? "disabled" : ""}>${D.saving ? `<span class="spin"></span> Guardando…` : saveLabel()}</button></div>` : ""}`;
  bindTop(s, d);
  el.querySelectorAll(".d-addr [data-copy]").forEach(b => b.onclick = () => copy(b.dataset.copy));
  bindAddr(s);
  if (d) {
    if (D.tab === "prep") bindPrep(s, d);
    if (D.tab === "log") D.result ? bindResult(s, d) : bindLog(s, d);
    if (D.tab === "hist") bindHist(s, d);
  }
  if (fk) el.querySelector(fk)?.focus();
  // «Ver historial» (Tus inbound): con la línea de tiempo ya leída, la vista va ahí (una vez; el resumen compacto queda arriba)
  if (D.toTl && D.tab === "hist" && d && D.tl?.id === s.id && D.tl.items) { D.toTl = false; const id = s.id; requestAnimationFrame(() => { if (D.id === id && D.tab === "hist") $("drawer").querySelector("#tlSec")?.scrollIntoView({ block: "start" }); }); }
}
const loadingBody = () => `<div class="stack">${[1, 2, 3].map(() => `<div class="sec"><div class="skel" style="width:40%"></div><div class="skel" style="margin-top:12px"></div><div class="skel" style="margin-top:8px;width:80%"></div></div>`).join("")}</div>`;
export function goTab(tab) {
  D.tab = tab; D.toTl = false; draw();
  // en celular la ficha entera scrollea: se lleva a las pestañas; en escritorio, el cuerpo al inicio
  toTabs();
  if (tab === "log") showOutcomes();
}
// Registrar: «¿Qué pasó?» tiene que quedar a la vista. En el celular (scrollea toda la ficha y el encabezado ocupa media
// pantalla) se sube lo justo; si ya se ve entero, no se mueve nada.
export function showOutcomes() {
  const el = $("drawer"), st = el.querySelector(".oc-step"), foot = el.querySelector(".d-foot"); if (!st || D.result) return;
  const r = st.getBoundingClientRect(), bottom = foot ? foot.getBoundingClientRect().top : innerHeight;
  if (r.bottom > bottom - 8) st.scrollIntoView({ block: "end" });
}
// Lleva el scroll a las pestañas (en celular scrollea toda la ficha; las pestañas son fijas y su offsetTop no sirve).
export function toTabs() {
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
  el.querySelector("#aUnarch")?.addEventListener("click", () => unarchiveSchool(s));
  // «Demo ▾»: proponerle horarios al colegio (lo que era «Proponer demo») o registrar la que ya se agendó (lo que era «Demo»)
  el.querySelector("#aDemo").onclick = e => openMenu(e.currentTarget, [
    { label: "Proponer horarios", sub: "Elegí con qué account, mirá cuándo está libre y mandale 2 o 3 horarios", fn: () => d && proposeDemo(s, d, { send: t => messageModal(s, d, t, { logAfter: true }) }) },
    { label: "Ya la agendé", sub: "Registrar la demo con día y hora: se crea el trato", fn: () => {
      D.result = null; D.form.outcome = "demo"; suggest(s); goTab("log");
      const date = $("drawer").querySelector('[data-f="demo.date"]');
      date?.closest(".step")?.scrollIntoView({ block: "start" }); date?.focus();
    } },
  ]);
  el.querySelector("#aMore").onclick = e => { if (!D.prospecting && !D.converting) openMenu(e.currentTarget, moreItems(s, d)); };
}
export const open = url => window.open(url, "_blank", "noopener");
// «Más ▾»: todo lo que no es contactar, con texto (antes eran 5 a 7 botones sueltos más un menú de íconos). No se pierde
// ninguna acción: crear el prospecto o convertirlo, enriquecer, archivar, abrir en Pipedrive, mapa, web y buscar al decisor.
function moreItems(s, d) {
  const m = d?.match, l = !s.virtual && d?.leads?.length ? d.leads : [], it = [];
  if (d) {
    if (canProspect(s, m)) it.push({ label: "Crear prospecto", sub: "A tu nombre en Pipedrive, con su primera tarea", fn: () => createProspect(s) });
    if (canConvert(s, d)) it.push({ label: "Convertir a trato", sub: "El prospecto pasa a trato en el embudo del país, con sus notas", fn: () => convertDeal(s) });
    it.push({ label: "Enriquecer", sub: "Buscar teléfonos, mails, web y sedes y dejarlos en Pipedrive", fn: () => enrich(s) });
    if (canArchive(s, d)) it.push({ label: "Archivar", sub: "No es un colegio, cerró, duplicado…: sale de la cola y de las sesiones", fn: () => archiveSchool(s) });
  }
  it.push({ head: "Abrir" });
  if (l.length) it.push({ label: l.length > 1 ? `Prospectos en Pipedrive (${l.length})` : "Prospecto en Pipedrive", sub: l.length > 1 ? `Tiene ${l.length} prospectos abiertos: abre el primero` : `«${l[0].title || s.name}»${l[0].ownerId && l[0].ownerId !== S.me.pdUserId && l[0].owner ? ` · de ${l[0].owner}` : ""} · ya tiene, no se crea otro`, fn: () => open(l[0].url) });
  if (d?.orgUrl) it.push({ label: s.leadOnly ? "Abrir en Pipedrive" : "Organización en Pipedrive", sub: m?.orgName || s.name, fn: () => open(d.orgUrl) });
  if (s.lat != null) it.push({ label: "Cómo llegar", sub: "Google Maps con la ruta", fn: () => open(mapsDir(s)) });
  it.push({ label: "Ver en Google Maps", sub: "Fotos, reseñas y horarios", fn: () => open(mapsSearch(s)) });
  const web = webOf(s);
  if (web) it.push({ label: "Sitio web", sub: web.replace(/^https?:\/\/(www\.)?/, ""), fn: () => open(web) });
  it.push({ label: "Buscar al decisor en Google", sub: `Director o administración de ${s.name}`, fn: () => open(`https://www.google.com/search?q=${encodeURIComponent(`"${s.name}" ${s.city} director OR administración OR cafetería`)}`) });
  return it;
}
