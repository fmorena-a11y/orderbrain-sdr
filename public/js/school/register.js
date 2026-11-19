// Ficha del colegio: Registrar (resultado, próximo paso, comentario, mail) y los atajos de teclado.
import { $, S, addDays, api, dayLabel, esc, gcalLink, icon, nextBusinessDay, patchSchool, shortDay, toast, today } from "../core.js";
import { bindRegSlots, regSlotsHtml } from "../demoslots.js";
import { CH, CONNECTED, D, GOOD, NEXT_TYPES, NIVELES, NO_NEXT, QUALIFY, WRITTEN, coarse, delaEsp, drawerOpen, laEsp, miniCal, newForm, ocText, quickFor } from "./state.js";
import { closeSchool } from "./open.js";
import { keepScroll } from "./media.js";
import { HIST } from "./sections.js";
import { pendingOf, sessionGo, sessionLogged, sessionRef } from "./session.js";
import { clientWarn, draw, goTab, ownDeal, toTabs } from "./render.js";
import { apiEx } from "./prep.js";
import { bindTimeline, briefCard } from "./history.js";
import { messageModal } from "./messages.js";

// ---------- Registrar
export async function suggest(s) {
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
        <p class="muted" id="nextLine" style="margin:0;font-size:var(--fs-sm)">${esc(nextLine(f))}</p></div></div>` : ""}`;
}
// Registrar después de enviar un mail desde la ficha: el contacto ya quedó (canal mail, «Mail enviado»); falta el próximo paso.
// Siempre queda algo para hacer: la llamada automática que dejó el envío o la actividad tuya que ya estaba (base). Se
// propone esa y, si la cambiás, se mueve esa misma (no se crea otra). Si la ficha se abrió desde una actividad de la agenda
// (una llamada, por ejemplo), se ofrece marcarla como hecha; si era justo la base, se propone una nueva.
const mailBase = f => f.mail?.autoNext || f.mail?.pendingNext || null;
const baseGone = f => !!(f.mail?.act && f.completeAct && mailBase(f)?.id === f.mail.act.id);
export const liveBase = f => baseGone(f) ? null : mailBase(f);
const kindOf = t => t === "meeting" ? "demo" : (S.types[t] || "tarea").toLowerCase();
// «mañana», «el jueves, 12 de noviembre» (+ hora)
const whenOf = b => { const l = dayLabel(b.date).toLowerCase(); return `${/^(hoy|mañana|ayer)$/.test(l) ? l : `el ${l}`}${b.time ? ` a las ${b.time}` : ""}`; };
const baseDesc = (b, auto, art = "tu") => `${auto ? "la llamada automática" : `${art} ${kindOf(b.type)}`} ${whenOf(b)}`;
// el próximo paso del formulario igual a la base (qué, día, hora, para vos y sin detalle): no se cambia nada
const sameAsBase = f => { const b = liveBase(f), n = f.next; return !!b && n.type === b.type && n.date === b.date && (n.time || "") === (b.time || "") && !n.ownerId && !(n.subject || "").trim(); };
// lo que se propone: la base tal cual; si la base se marca hecha (o no hay), una llamada en 2 días hábiles
export const mailDefaultNext = f => { const b = liveBase(f), fb = f.mail.fallback || { type: "call", date: nextBusinessDay(nextBusinessDay(today())) }; return b ? { type: b.type, date: b.date, time: b.time || "", ownerId: "", subject: "" } : { type: fb.type, date: fb.date, time: "", ownerId: "", subject: "" }; };
function mailFollowBody(s, d) {
  const f = D.form, ml = f.mail, warns = (ml.done || []).filter(x => x.warn), pdOk = ml.logged?.pipedrive !== false, histOk = ml.logged?.history !== false;
  const b = liveBase(f), auto = !!b && b === ml.autoNext, act = ml.act;
  const w = ml.where, inPd = w?.kind === "lead" ? `el prospecto <a href="${esc(w.url)}" target="_blank" rel="noopener">«${esc(w.title || "")}»</a>${w.created ? " (creado a tu nombre)" : ""}` : "Pipedrive";
  const where = pdOk && histOk ? `Ya quedó en ${inPd} y en Historial.` : !pdOk ? esc("En Pipedrive no quedó: registralo a mano.") : `Quedó en ${inPd}; en el historial de la app no.`;
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
export function logBody(s, d) {
  const f = D.form;
  if (f.mail) return mailFollowBody(s, d);
  const act = D.activityId && d.activities?.find(a => a.id === D.activityId);
  const connected = CONNECTED.includes(f.outcome), qualify = QUALIFY.includes(f.outcome);
  const lostish = ["not_now", "not_interested"].includes(f.outcome) || (f.outcome === "no_answer" && f.lostReason);
  const t = today();
  const warn = clientWarn(s, d.match), own = ownDeal(s, d.match);
  const pre = S.markets[s.country]?.prefix ? `+${S.markets[s.country].prefix} …` : "Teléfono";
  // recién mandaste un WhatsApp o un mail desde la ficha: quedó elegido «Sin respuesta todavía» (se cambia si ya contestó)
  const noAns = S.outcomes.find(x => x.id === "no_answer"), sentWhat = f.channel === "mail" ? "un mail" : f.channel === "whatsapp" ? "un WhatsApp" : "el mensaje";
  const sentNote = !f.sent ? "" : f.sentPre && f.outcome === "no_answer" ? `Mandaste ${sentWhat}: queda «${ocText(noAns, f.channel).label}» con su próximo paso. Si ya te contestó, elegí qué pasó.` : !f.outcome ? "Elegí qué pasó con el mensaje que mandaste." : "";
  let n = 0;
  // arriba, lo que se viene a hacer: por dónde fue y qué pasó. Lo demás (la apertura, el trato tuyo, la actividad de la
  // agenda) va en una línea o debajo de los resultados. Solo queda arriba la alerta de «no contactar» (de otra persona, cliente).
  return `<div class="stack">
    ${warn && !own ? `<div class="callout warn">${icon("alert")}<span>${esc(warn)}${HIST.get(s.id) ? ` <button class="linkbtn" data-see-hist>Ver qué pasó</button>` : ""}</span></div>` : ""}
    <div id="cbLog">${briefCard(s, "log")}</div>
    <div class="sec step"><div class="step-h"><span class="n">${++n}</span>¿Por dónde fue el contacto?</div>
      <div class="seg" role="group">${CH.map(([k, l, ic]) => `<button data-ch="${k}" aria-pressed="${f.channel === k}">${icon(ic, "sm")} ${l}</button>`).join("")}</div></div>
    <div class="sec step oc-step"><div class="step-h"><span class="n">${++n}</span>¿Qué pasó?</div>
      ${D.call ? `<p class="call-dur muted">${icon("clock", "sm")} ${esc(D.call.note)}</p>` : ""}
      ${sentNote ? `<p class="call-dur muted">${icon("send", "sm")} <span>${esc(sentNote)}</span></p>` : ""}
      <div class="outcomes">${S.outcomes.map((x, i) => { const tx = ocText(x, f.channel); return `<button class="oc ${GOOD.includes(x.id) ? "good" : ""}" data-oc="${x.id}" aria-pressed="${f.outcome === x.id}" ${x.id === "demo" && s.status === "client" ? `disabled title="Ya es cliente"` : ""}><b>${esc(tx.label)}</b><small>${esc(tx.hint)}</small>${i < 9 ? `<span class="kbd-hint oc-k" aria-hidden="true">${i + 1}</span>` : ""}</button>`; }).join("")}</div></div>
    ${warn && own ? `<p class="reg-line">${icon("deal", "sm")}<span>${esc(warn)}${HIST.get(s.id) ? ` <button class="linkbtn" data-see-hist>Ver qué pasó</button>` : ""}</span></p>` : ""}
    ${act ? `<label class="callout info toggle"><input type="checkbox" data-f="completeAct" ${f.completeAct ? "checked" : ""}> Marcar como hecha: <b>${esc(act.subject)}</b></label>` : ""}
    <div class="sec step"><div class="step-h"><span class="n">${++n}</span>Comentario <span class="faint" style="font-weight:400;font-size:var(--fs-sm)">${f.outcome ? "lo que te dijeron, con tus palabras" : contactPending() ? "lo que pasó, con tus palabras" : "opcional · se puede guardar solo, sin registrar un contacto"}</span></div>
      <textarea class="inp" data-f="text" aria-label="Comentario" placeholder="Ej: atendió la secretaria, la cafetería la maneja un concesionario (Don Pedro), llamar después de las 11.">${esc(f.text)}</textarea>
      ${quickFor(f).length ? `<div class="quick">${quickFor(f).map(q => `<button data-quick="${esc(q)}">+ ${esc(q)}</button>`).join("")}</div>` : ""}
      ${S.ai && f.outcome ? `<label class="toggle"><input type="checkbox" data-f="ai" ${f.ai ? "checked" : ""}> Ordenar la nota con IA (resumen, decisor, objeción e interés)</label>` : ""}</div>
    ${f.outcome === "demo" ? `<div class="sec step"><div class="step-h"><span class="n">${++n}</span>La demo</div>
      ${s.virtual && !s.country ? `<label class="field"><span>País del colegio <span class="faint">para crear el trato en su embudo</span></span><select class="inp" data-f="country"><option value="">Elegí el país</option>${Object.keys(S.markets).sort().map(c => `<option ${f.country === c ? "selected" : ""}>${esc(c)}</option>`).join("")}</select></label>` : ""}
      <div class="grid3"><label class="field"><span>Día</span><input class="inp" type="date" data-f="demo.date" value="${esc(f.demo.date)}" min="${t}"></label>
      <label class="field"><span>Hora (tu hora local)</span><input class="inp" type="time" data-f="demo.time" value="${esc(f.demo.time)}" step="900"></label>
      <label class="field"><span>Duración</span><select class="inp" data-f="demo.duration">${[20, 30, 45, 60].map(m => `<option value="${m}" ${+f.demo.duration === m ? "selected" : ""}>${m} min</option>`).join("")}</select></label></div>
      <label class="field"><span>¿Quién da la demo?</span><select class="inp" data-f="demo.ownerId">${ownerOpts(f.demo.ownerId, true).replace("Para mí", "Yo")}</select></label>
      ${regSlotsHtml(s, f)}
      <p class="muted" style="margin:0;font-size:var(--fs-md)">${d.match.openDealId ? "Se agenda en el trato abierto." : `Se crea el trato en <b>${esc(pipeName(s))}</b> con fuente «Outbound - Cold Calling» y vos como SDR.`}</p></div>` : ""}
    ${connected ? `<div class="sec step"><div class="step-h"><span class="n">${++n}</span>${f.outcome === "gatekeeper" ? "¿Por quién preguntar?" : "¿Con quién hablaste?"} <span class="faint" style="font-weight:400;font-size:var(--fs-sm)">${f.outcome === "gatekeeper" ? "opcional · nombre y cargo si te lo dijeron, se crea como contacto" : "opcional, se crea como contacto"}</span></div>
      <div class="grid2"><label class="field"><span>Nombre</span><input class="inp" data-f="contact.name" value="${esc(f.contact.name)}" placeholder="Ej: Laura Gómez" autocomplete="off"></label>
      <label class="field"><span>Cargo</span><input class="inp" data-f="contact.role" value="${esc(f.contact.role)}" placeholder="Directora, administrador, concesionario" list="roles"></label>
      <label class="field"><span>Teléfono / WhatsApp</span><input class="inp" type="tel" data-f="contact.phone" value="${esc(f.contact.phone)}" placeholder="${esc(pre)}"></label>
      <label class="field"><span>Email</span><input class="inp" type="email" data-f="contact.email" value="${esc(f.contact.email)}" placeholder="nombre@colegio.edu"></label></div>
      <datalist id="roles"><option>Director/a</option><option>Administrador/a</option><option>Concesionario/a ${esc(delaEsp(d.market))}</option><option>Coordinador/a de servicios</option><option>Dueño/a</option></datalist></div>` : f.fromBase && f.contact.name ? `<div class="callout info">${icon("user")}<span>Contacto de la base: <b>${esc(personLine(f.contact))}</b>. Se crea como persona en Pipedrive al guardar. <button class="linkbtn" data-unpick>Quitar</button></span></div>` : ""}
    ${qualify ? `<div class="sec step"><div class="step-h"><span class="n">${++n}</span>Calificación <span class="faint" style="font-weight:400;font-size:var(--fs-sm)">lo que sepas</span></div>
      <div class="field"><span>${esc(laEsp(d.market).replace(/^./, c => c.toUpperCase()))} es…</span><div class="seg">${["Propia", "Externa", "No tiene"].map(c => `<button data-caf="${c}" aria-pressed="${f.qual.cafeteria === c}">${c === "Externa" ? "Concesionada" : c}</button>`).join("")}</div></div>
      <div class="grid2"><label class="field"><span>Alumnos</span><input class="inp" type="number" min="0" step="10" data-f="qual.alumnos" value="${esc(f.qual.alumnos)}" placeholder="Ej: 600"></label>
      <label class="field"><span>Sistema actual</span><input class="inp" data-f="qual.sistema" value="${esc(f.qual.sistema)}" placeholder="Efectivo, Excel, otro software…"></label></div>
      <div class="field"><span>Niveles</span><div class="chips">${NIVELES.map(nv => `<button class="chip" data-niv="${nv}" aria-pressed="${f.qual.niveles.includes(nv)}">${nv}</button>`).join("")}</div></div></div>` : ""}
    ${lostish ? `<div class="sec step"><div class="step-h"><span class="n">${++n}</span>Motivo</div>
      <select class="inp" data-f="lostReason"><option value="">Sin motivo (no cerrar)</option>${S.lostReasons.map(r => `<option ${f.lostReason === r ? "selected" : ""}>${esc(r.replace("  ", " "))}</option>`).join("")}</select>
      <p class="muted" style="margin:0;font-size:var(--fs-md)">${d.match.openDealId ? "El trato abierto se marca como perdido con este motivo." : "Queda en la nota. No hay trato abierto para cerrar."}</p></div>` : ""}
    ${f.outcome || !contactPending() ? `<div class="sec step"><div class="step-h"><span class="n">${++n}</span>${f.outcome ? "Próximo paso" : `Tarea para más adelante <span class="faint" style="font-weight:400;font-size:var(--fs-sm)">opcional · para vos o para alguien del equipo</span>`}</div>
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
export const saveDisabled = s => D.form.mail ? D.saving || (!!D.form.next.type && !D.form.next.date) : D.saving || !(D.form.outcome || onlyComment()) || (s.status === "client" && D.form.outcome === "demo");
export const saveLabel = () => `${icon("check")} ${D.form.mail ? (D.form.next.type && !sameAsBase(D.form) ? "Guardar próximo paso" : "Listo") : onlyComment() ? "Guardar comentario" : "Guardar en Pipedrive"}`;
export function summary(s, d) {
  const f = D.form;
  if (f.mail) {
    const b = liveBase(f), auto = !!b && b === f.mail.autoNext, pdOk = f.mail.logged?.pipedrive !== false;
    const tail = pdOk ? "" : " El mail salió, pero no quedó en Pipedrive.";
    if (f.next.type && f.next.date && !sameAsBase(f)) return `<b>Se guarda en Pipedrive:</b> ${esc(kindOf(f.next.type))} ${shortDay(f.next.date)}${f.next.time ? ` ${esc(f.next.time)}` : ""}${b ? auto ? " (cambia la automática)" : " (mueve la que ya tenías)" : ""}${f.mail.act && f.completeAct ? " y la de la agenda queda hecha" : ""}.${esc(tail)}<span class="kbd-hint faint"> · Ctrl + Enter</span>`;
    return esc(`${b ? `Queda ${baseDesc(b, auto)}` : "Sin próximo paso"}${f.mail.act && f.completeAct ? " y la de la agenda queda hecha" : ""}.${tail}`);
  }
  if (onlyComment()) return `<b>Se guarda ${esc(whereNext(s, d))}:</b> comentario${f.next.type && f.next.date ? ` + ${esc((S.types[f.next.type] || "tarea").toLowerCase())} ${shortDay(f.next.date)}${f.next.ownerId ? ` para ${esc((S.team || []).find(u => String(u.id) === String(f.next.ownerId))?.name || "")}` : ""}` : ""}, sin registrar contacto<span class="kbd-hint faint"> · Ctrl + Enter</span>`;
  if (!f.outcome) return contactPending() ? `Elegí qué pasó con ${D.form.sent ? "el mensaje" : "la llamada"} para guardar.` : "Elegí qué pasó o dejá un comentario.";
  if (s.status === "client" && f.outcome === "demo") return "Ya es cliente: no se crea un trato nuevo.";
  const parts = ["contacto hecho", "nota"];
  if (f.contact.name) parts.push("contacto");
  if (f.outcome === "demo") parts.push(`${d.match.openDealId ? "demo" : "trato + demo"} ${f.demo.date ? shortDay(f.demo.date) : ""} ${f.demo.time || ""}`.trim());
  if (f.next.type && f.next.date) parts.push(`${S.types[f.next.type]?.toLowerCase() || "actividad"} ${shortDay(f.next.date)}`);
  if (f.lostReason && d.match.openDealId) parts.push("trato perdido");
  return `<b>Se guarda ${esc(f.outcome === "demo" ? "en Pipedrive" : whereNext(s, d))}:</b> ${esc(parts.join(" · "))}<span class="kbd-hint faint"> · Ctrl + Enter</span>`;
}
// Dónde va a quedar lo que se registra (lo decide el servidor, workLead de lib/sales.js): el trato abierto; si no, el
// prospecto abierto tuyo o libre o, si no tiene, uno nuevo a tu nombre. Cliente o de otra persona: la organización.
function whereNext(s, d) {
  if (s.leadOnly) return "en el prospecto";
  if (d?.match?.openDealId) return "en el trato";
  const l = (d?.leads || []).find(x => !x.ownerId || x.ownerId === S.me.pdUserId);
  if (l) return `en el prospecto «${l.title}»`;
  if (s.virtual || d?.leads?.length || s.status === "client" || s.ob?.client || ["activo", "onboarding"].includes(s.phase) || (s.ownerId && S.me.pdUserId && s.ownerId !== S.me.pdUserId)) return "en Pipedrive";
  return "en un prospecto nuevo a tu nombre";
}
// Lo registrado quedó en un prospecto (quizás recién creado): la ficha lo muestra ya, sin recargar (la etiqueta
// «Prospecto», el botón al prospecto y «Convertir a trato»)
export function gotLead(s, r) {
  const l = r?.lead; if (!l?.id || D.id !== s.id || !D.data || s.leadOnly) return;
  D.data.leads = [{ id: l.id, title: l.title || s.name, ownerId: l.ownerId ?? S.me.pdUserId ?? null, owner: "", url: l.url }, ...(D.data.leads || []).filter(x => x.id !== l.id)];
  if (D.data.match) D.data.match = { ...D.data.match, leadId: l.id };
}
function setPath(obj, path, val) { const ks = path.split("."); let o = obj; ks.slice(0, -1).forEach(k => (o = o[k])); o[ks.at(-1)] = val; }
const personLine = c => [c.name, c.role && `(${c.role})`, c.phone].filter(Boolean).join(" ");
export function bindLog(s, d) {
  const el = $("drawer"), f = D.form;
  bindTimeline(s);
  el.querySelector("[data-unpick]")?.addEventListener("click", () => { f.contact = { name: "", role: "", phone: "", email: "" }; f.fromBase = false; redrawLog(); });
  el.querySelectorAll("[data-ch]").forEach(b => b.onclick = () => { f.channel = b.dataset.ch; redrawLog(); suggest(s); });
  el.querySelectorAll("[data-oc]").forEach(b => b.onclick = () => {
    // tocar el que ya estaba elegido lo quita (por ejemplo, para guardar solo un comentario)
    f.sentPre = false;
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
  if (f.outcome === "demo" && !f.mail) bindRegSlots(s, f, { redraw: redrawLog }); // horarios libres del account (demoslots.js)
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
    const r = await apiEx(s, `/api/schools/${s.id}/log`, { body });
    sessionLogged(r, { kind: "contact", channel: f.channel, outcome: f.outcome }, body.session);
    if (D.id !== s.id) return;
    D.result = { ...r, form: JSON.parse(JSON.stringify(f)) }; D.inCall = false; D.call = null;
    patchSchool(r.school); gotLead(s, r);
    S.today = null; S.agenda = null;
    import("../explore.js").then(m => m.refreshExplore());
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
    D.result = { ...r, where: f.mail.where || null, done: [{ label: `Mail enviado a ${f.mail.to} · «${f.mail.subject}»`, url: f.mail.url || undefined }, ...r.done], form: JSON.parse(JSON.stringify(f)) };
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
    const sr = sessionRef(), r = await apiEx(s, `/api/schools/${s.id}/comment`, { body: { text: f.text, task, completeActivityId: D.activityId && f.completeAct ? D.activityId : null, session: sr } });
    sessionLogged(r, { kind: "comment" }, sr);
    if (D.id !== s.id) return;
    D.result = { ...r, form: JSON.parse(JSON.stringify(f)) };
    if (r.school) patchSchool(r.school);
    gotLead(s, r);
    D.saving = false; draw(); toTabs();
    api(`/api/schools/${s.id}`).then(nd => { if (D.id === s.id) { D.data = nd; if (D.tab !== "log") draw(); } }).catch(() => {});
  } catch (e) { D.saving = false; redrawLog(); toast(e.message, { type: "err" }); }
}
// Arriba del resultado: dónde quedó (con enlace) y si se creó el prospecto
function whereDone(w) {
  const a = (url, t) => url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${t}</a>` : t;
  // (un solo bloque de texto adentro del título: .sec h3 es flex y separaría el enlace)
  if (w?.kind === "lead") return `<h3><span>Guardado en el prospecto ${a(w.url, `«${esc(w.title || "")}»`)}</span></h3>${w.created ? `<p class="muted" style="margin:-4px 0 0">${icon("lead", "sm")} Prospecto creado a tu nombre</p>` : ""}`;
  if (w?.kind === "deal") return `<h3><span>Guardado en el ${a(w.url, "trato")}</span></h3>`;
  if (w?.kind === "org") return `<h3><span>Guardado en la organización ${a(w.url, `«${esc(w.title || "")}»`)}</span></h3>`;
  return `<h3>Guardado en Pipedrive</h3>`;
}
export function resultBody(s, d) {
  const r = D.result, f = r.form, ss = S.session;
  const contact = f.contact?.name ? f.contact : d.persons?.[0] || null;
  const tpl = id => d.templates.find(t => t.id === id);
  const extra = [];
  if (f.outcome === "demo") {
    extra.push(`<a class="btn" href="${esc(gcalLink({ title: `Demo OrderEAT · ${s.name}`, date: f.demo.date, time: f.demo.time, minutes: +f.demo.duration || 30, details: `Demo de OrderEAT para ${laEsp(d.market)} de ${s.name}.\nAgendada desde OrderBrain SDR.`, guests: contact?.email || "" }))}" target="_blank" rel="noopener">${icon("calendar")} Invitación en Google Calendar</a>`);
    extra.push(`<button class="btn wa" data-tpl="confirm_demo">${icon("whatsapp")} Confirmar por WhatsApp</button>`);
  }
  if (f.outcome === "info") extra.push(`<button class="btn" data-tpl="mail_info">${icon("mail")} Mandar la info por mail</button>`, `<button class="btn wa" data-tpl="info">${icon("whatsapp")} Mandar por WhatsApp</button>`);
  if (f.outcome === "no_answer" && !WRITTEN.includes(f.channel) && tpl("after_call")) extra.push(`<button class="btn wa" data-tpl="after_call">${icon("whatsapp")} Mandar WhatsApp ahora</button>`);
  return `<div class="sec done-card">
    <div class="big">${icon("check")}</div>
    ${whereDone(r.where)}
    <ul class="writes">${r.done.map(x => `<li${x.warn ? ' class="warn"' : ""}>${icon(x.warn ? "alert" : "check", "sm")}<span>${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.label)}</a>` : esc(x.label)}</span></li>`).join("")}</ul>
    ${extra.length ? `<div class="d-actions" style="justify-content:center;margin:6px 0 0">${extra.join("")}</div>` : ""}
    <div class="d-actions" style="justify-content:center">
      ${ss ? `<button class="btn primary lg" id="nextSchool">Siguiente colegio ${icon("arrowRight")}</button>` : `<button class="btn primary" id="closeD">Listo</button>`}
      <button class="btn ghost" id="again">Registrar otro contacto</button>
    </div>
    ${ss ? `<p class="faint" style="margin:0;font-size:var(--fs-sm)">${pendingOf(ss) ? `Faltan ${pendingOf(ss)} en la sesión` : "Es el último de la sesión"}</p>` : ""}
  </div>`;
}
export function bindResult(s, d) {
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


// Ctrl + Enter guarda; en la pantalla de resultado, Enter pasa al siguiente de la sesión. En escritorio, 1 a 8 eligen qué pasó
// desde cualquier pestaña de la ficha (fuera de los campos de texto, sin un menú ni una ventana abiertos).
const typing = t => t?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t?.tagName || "");
addEventListener("keydown", e => {
  if (!drawerOpen() || document.querySelector(".modal")) return;
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && D.tab === "log" && !D.result) { e.preventDefault(); $("drawer").querySelector("#save")?.click(); }
  else if (/^[1-9]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey && !e.repeat && !D.result && !D.saving && !coarse() && !typing(e.target) && !document.querySelector(".menu")) {
    if (D.tab === "log") { const b = $("drawer").querySelectorAll("[data-oc]")[+e.key - 1]; if (b && !b.disabled) { e.preventDefault(); b.click(); $("drawer").querySelector(`[data-oc="${b.dataset.oc}"]`)?.focus(); } return; }
    // desde Preparar o Historial: pasa a Registrar con ese resultado elegido (acá no lo quita si ya estaba)
    const s = S.byId.get(D.id), x = S.outcomes[+e.key - 1];
    if (!s || !x || !D.data || D.data.archive || D.form.mail || (x.id === "demo" && s.status === "client")) return;
    e.preventDefault();
    D.form.outcome = x.id; D.form.lostReason = ""; D.form.sentPre = false; if (D.call?.outcome) D.call = null;
    goTab("log"); suggest(s);
    $("drawer").querySelector(`[data-oc="${x.id}"]`)?.focus();
  }
});

// «Ver qué pasó» (desde Registrar): va a la historia con OrderEAT en Preparar
document.addEventListener("click", e => {
  if (!e.target.closest?.("[data-see-hist]")) return;
  goTab("prep"); setTimeout(() => $("drawer").querySelector("#histSec")?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
});
