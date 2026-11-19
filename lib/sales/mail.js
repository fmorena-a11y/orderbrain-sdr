// Mail desde la ficha (Pipedrive o Gmail): controles, envío y lo que queda registrado.
import * as pd from "../pipedrive.js";
import { addMail, addTouch, byId, getMatch, mailsFor, patchMail, refreshArchived, setMatch } from "../store.js";
import { CHANNEL_TYPE, TYPE_LABEL } from "../config.js";
import { MAIL_SENT } from "../playbook.js";
import { addBusinessDays, fromUtc, toUtc, todayIn } from "../time.js";
import { validateMail } from "../gmail.js";
import { bad, esc } from "../text.js";
import { nice, signer } from "./util.js";
import { checkSchool } from "./match.js";
import { leadTitleOf, settleExisting } from "./settle.js";
import { effMatch, schoolSummary } from "./list.js";
import { ensureOrg, whereOf } from "./contact.js";
import { enrichNewLead, leadUrlOf, workLead } from "./worklead.js";

// ---------- mail desde la ficha: sale de la casilla que la persona tiene conectada en Pipedrive (lib/pdtoken.js, via
// "pipedrive") o, como segunda opción, de su Gmail (lib/gmail.js, via "gmail"), por `send`; acá van los controles de dueño
// y lo que queda en Pipedrive y en la app. Primero se revisa todo lo que puede frenar el envío (archivado, cliente, de otra
// persona) y recién después se manda: si después falla Pipedrive, el mail ya salió y se avisa qué falta registrar a mano.
// Con Pipedrive, el borrador va ligado al prospecto o al trato: dónde queda (mailTarget) se resuelve ANTES de mandar.
export const mailOut = m => ({ id: m.id, at: m.at, by: m.byName || "", to: m.to, subject: m.subject, body: m.body || "", next: m.next || null, autoNext: m.autoNext || null, pendingNext: m.pendingNext || null, url: m.url || "", via: m.via || "gmail" });
export const mailNoteHtml = ({ to, subject, text, by, via = "gmail" }) => `<b>Mail enviado</b> a ${esc(to)}<br><b>Asunto:</b> ${esc(subject)}<br><br>${esc(text).replace(/\n/g, "<br>")}<br><br><i>Enviado por ${esc(by)} desde OrderBrain SDR con su ${via === "pipedrive" ? "correo de Pipedrive" : "Gmail"}</i>`;
// «Mail: <asunto> · <colegio>» (sin repetir el colegio si el asunto ya lo nombra)
export const mailActivitySubject = (subject, name) => { const a = `Mail: ${subject}`, b = `${a} · ${name}`; return (b.length <= 250 && !pd.norm(subject).includes(pd.norm(name)) ? b : a).slice(0, 250); };
// Lo que frena un mail antes de mandarlo: archivado, cliente, de otra persona (la organización, su trato abierto o el
// prospecto). Lo usan el envío y el chequeo del modal (antes de la cuenta de 5 s, así no se ofrece «Enviar» donde va a
// fallar). Dueño al día: solo lo tuyo o lo libre (las cuentas generales cuentan como libres).
export async function mailGuard(id, user) {
  const s = byId.get(id);
  if (!s) throw bad("Colegio inexistente", 404);
  if (!user.pdUserId) throw bad("Tu email no coincide con ningún usuario de Pipedrive: pedí que te den de alta.", 403);
  await refreshArchived(id);
  if (effMatch(s)?.status === "archived") throw bad("Está archivado: desarchivalo para escribirle.", 409);
  const me = user.pdUserId;
  // ¿ya está en Pipedrive? (sin escribir: lo que haya que pasar a tu nombre se hace al mandar)
  await settleExisting(id, user, { dry: true });
  if (s.leadOnly) {
    // sin poder leer el prospecto no se sabe de quién es: no se manda (un error pasajero no cuenta como «libre»)
    let lead;
    try { lead = await pd.getLead(s.leadId); } catch { throw bad("No pude comprobar en Pipedrive de quién es el prospecto. Probá de nuevo.", 503); }
    if (!lead) throw bad("Ese prospecto ya no está en Pipedrive (lo borraron o lo pasaron a trato). Actualizá la ficha.", 404);
    if (lead.ownerId && lead.ownerId !== me) { const m = await pd.meta().catch(() => ({ users: [] })); throw bad(`El prospecto es de ${m.users.find(u => u.id === lead.ownerId)?.name || "otra persona"} en Pipedrive. Hablalo con esa persona.`, 409); }
    return { s, lead, cur: null };
  }
  const cur = await checkSchool(id, { force: true });
  const eff = effMatch(s) || cur;
  if (eff.status === "client") throw bad("Ya es cliente de OrderEAT: no se prospecta. Si hay algo, avisale al equipo de cuentas.", 409);
  const dealOwner = cur.openDealId ? pd.realOwner(cur.openDealOwnerId) : null;
  // con un trato abierto TUYO (el account de un colegio que prospectó un SDR) el mail va al trato aunque la organización sea de quien lo prospectó
  if (cur.ownerId && cur.ownerId !== me && dealOwner !== me) throw bad(`La organización es de ${cur.ownerName || "otra persona"} en Pipedrive. Hablalo con esa persona.`, 409);
  if (dealOwner && dealOwner !== me) throw bad(`Tiene un trato abierto de ${cur.openDealOwner || "otra persona"}. Coordiná con esa persona antes de escribirle.`, 409);
  return { s, lead: null, cur };
}
// la actividad pendiente que queda como próximo paso, en la hora local (Registrar la muestra y la puede mover)
const nextOf = (a, tz, extra = {}) => { const l = a.due_time ? fromUtc(a.due_date, a.due_time, tz) : { date: a.due_date, time: "" }; return { id: a.id, type: a.type, date: l.date, time: (l.time || "").slice(0, 5), subject: a.subject || "", ...extra }; };
const kindOf = type => (TYPE_LABEL[type] || "tarea").toLowerCase();
export async function sendMail(id, user, body, tz, { send, by = "", via = "gmail" } = {}) {
  const s0 = byId.get(id);
  if (!s0) throw bad("Colegio inexistente", 404);
  if (!user.pdUserId) throw bad("Tu email no coincide con ningún usuario de Pipedrive: pedí que te den de alta.", 403);
  const v = validateMail(body); if (v.error) throw bad(v.error);
  // primero todo lo que puede frenar el envío; recién después se manda
  const { s, lead } = await mailGuard(id, user);
  let pre = null;
  if (via === "pipedrive") {
    // el borrador de Pipedrive se liga al prospecto o al trato: primero dónde queda (puede crear la organización o el
    // prospecto a tu nombre, como un contacto). Si eso falla, no se manda (y no se sabe dónde quedaría).
    pre = { done: [], warnings: [] };
    try { Object.assign(pre, await mailTarget(id, s, lead, user, v, pre.done, pre.warnings)); }
    catch (e) { throw bad(`No pude preparar el mail en Pipedrive (${e.message}). No se mandó: probá de nuevo.`, e.status === 409 ? 409 : 502); }
  }
  const t = pre?.target || {};
  const sent = await send({ to: v.to, subject: v.subject, text: v.text, leadId: t.dealId ? null : t.leadId || null, dealId: t.dealId || null, toName: pre?.personName || "" });
  // el mail ya salió: cualquier error de acá en adelante lleva sent = true (el servidor no libera la clave del envío)
  try { return await afterMailSent(id, s, lead, user, v, sent, body, tz, by, pre); }
  catch (e) { throw Object.assign(e, { sent: true }); }
}
// Dónde queda un mail en Pipedrive: el prospecto de la ficha, el trato abierto o, sin trato, un prospecto (workLead: el
// abierto tuyo o libre, o uno nuevo a tu nombre); si no se puede, la organización. Primer contacto real: la organización se
// crea (o pasa de la cuenta general) a tu nombre. Escribe en done/warnings lo que hizo.
async function mailTarget(id, s, lead, user, v, done, warnings) {
  const me = user.pdUserId;
  let target, url, personId = null, personName = "", firstTake = false, leadR = null, orgRec = null;
  if (s.leadOnly) {
    target = { leadId: s.leadId }; url = `${pd.PD_WEB}/leads/inbox/${s.leadId}`;
    personId = s.personId || null;
    if (lead && !lead.ownerId) await pd.updateLead(s.leadId, { owner_id: me }).then(() => done.push({ label: "El prospecto pasó a tu nombre (estaba en la cuenta general)" })).catch(() => {});
  } else {
    // primer contacto real: la organización se crea (o pasa de la cuenta general) a tu nombre; antes, lo que ya hay en Pipedrive
    firstTake = !getMatch(id)?.orgId;
    const pre = await settleExisting(id, user); done.push(...pre.done); warnings.push(...pre.warnings);
    const rec = await ensureOrg(id, me);
    if (!rec.created && !rec.ownerId && rec.confirmed) await pd.updateOrganization(rec.orgId, { owner_id: me }).then(() => { setMatch(id, { ...getMatch(id), ownerId: me, ownerName: signer(user) }); done.push({ label: "El colegio pasó a tu nombre en Pipedrive (estaba en la cuenta general)" }); }).catch(() => {});
    if (rec.created) done.push({ label: "Organización creada en Pipedrive a tu nombre", url: `${pd.PD_WEB}/organization/${rec.orgId}` });
    firstTake = firstTake || !!rec.created;
    const p = (await pd.personsForOrg(rec.orgId).catch(() => [])).find(x => String(x.email || "").trim().toLowerCase() === v.to);
    personId = p?.id || null; personName = p?.name || "";
    // sin trato abierto, el mail va a un prospecto (el abierto tuyo o libre, o uno nuevo a tu nombre), como un contacto
    leadR = rec.openDealId ? null : await workLead(id, rec, user, done, warnings, { personId });
    orgRec = rec;
    if (leadR && !personId && leadR.personId) personId = leadR.personId;
    target = leadR ? { orgId: rec.orgId, leadId: leadR.id } : { orgId: rec.orgId, dealId: rec.openDealId || undefined };
    url = leadR ? leadR.url : rec.openDealId ? `${pd.PD_WEB}/deal/${rec.openDealId}` : `${pd.PD_WEB}/organization/${rec.orgId}`;
  }
  target.personId = personId || undefined;
  return { target, url, firstTake, leadR, orgRec, personName };
}
async function afterMailSent(id, s, lead, user, v, sent, body, tz, by, pre = null) {
  const me = user.pdUserId, sign = by || signer(user), viaPd = sent.via === "pipedrive";
  const today = todayIn(tz), at = new Date().toISOString();
  const done = [{ label: `Mail enviado a ${v.to} desde ${viaPd ? "tu correo de Pipedrive" : sent.from || "tu Gmail"}` }], warnings = [...(pre?.warnings || [])];
  if (sent.bcc) done.push({ label: "Copia a Pipedrive (Smart BCC): queda en su pestaña de correo" });
  if (viaPd) done.push(...(pre?.done || []), { label: sent.linked === "deal" ? "Queda en el correo del trato en Pipedrive" : sent.linked === "lead" ? "Queda en el correo del prospecto en Pipedrive" : "Queda en tu correo de Pipedrive (sin prospecto ni trato para ligarlo)", ...(pre?.url ? { url: pre.url } : {}) });
  let target = pre?.target || null, url = pre?.url || "", activityId = null, autoNext = null, pendingNext = null, firstTake = !!pre?.firstTake, pdOk = false, doneActId = null, leadR = pre?.leadR || null, orgRec = pre?.orgRec || null;
  try {
    if (!pre) ({ target, url, firstTake, leadR, orgRec } = await mailTarget(id, s, lead, user, v, done, warnings));
    const a = await pd.addActivity({ subject: mailActivitySubject(v.subject, s.name), type: CHANNEL_TYPE.mail, dueDate: today, ...target, ownerId: me, done: true,
      note: `<b>Para:</b> ${esc(v.to)}<br><b>Asunto:</b> ${esc(v.subject)}<br><br>${esc(v.text).replace(/\n/g, "<br>")}` });
    activityId = a?.id || null;
    done.push({ label: "Actividad «Mail» hecha en Pipedrive, con el asunto y el texto", url });
    const noteHtml = mailNoteHtml({ ...v, by: sign, via: sent.via });
    await pd.addNote({ content: noteHtml, ...target }).catch(e => { if (!(target.leadId && target.orgId)) throw e; return pd.addNote({ content: noteHtml, leadId: target.leadId, personId: target.personId }); });
    done.push({ label: target.leadId ? "Nota en el prospecto" : target.dealId ? "Nota en el trato" : "Nota en la organización", url });
    const doneId = Number(body.completeActivityId) || null;
    if (doneId) await pd.updateActivity(doneId, { done: true }).then(() => { doneActId = doneId; done.push({ label: "Actividad pendiente marcada como hecha" }); }, () => done.push({ label: "No pude marcar la actividad como hecha: hacelo desde la agenda.", warn: true }));
    // Próximo paso, siempre: si ya tenés algo pendiente con este colegio, queda eso (Registrar lo puede mover, sin crear
    // otro). Si no, una llamada a tu nombre: el próximo día hábil si es el primer contacto, si no en 2 días hábiles.
    // Si no se pueden leer los pendientes, se agenda igual (mejor una llamada de más que un colegio sin nada para hacer).
    // (con organización se leen las de la organización: incluye las del prospecto, que también la llevan)
    const pend = await pd.activities({ ...(target.orgId ? { orgId: target.orgId } : { leadId: target.leadId }), done: false, limit: 50 }).catch(() => null);
    const mine = (pend || []).filter(x => !x.done && Number(pd.realOwner(x.owner_id ?? x.user_id)) === me && x.id !== doneId && x.id !== activityId)
      .sort((x, y) => `${x.due_date} ${x.due_time || ""}`.localeCompare(`${y.due_date} ${y.due_time || ""}`));
    if (mine.length) pendingNext = nextOf(mine[0], tz, { count: mine.length });
    else {
      const day = addBusinessDays(today, firstTake ? 1 : 2);
      const n = await pd.addActivity({ subject: `${TYPE_LABEL.call} · ${s.name}`, type: "call", dueDate: day, ...target, ownerId: me, note: `Seguimiento del mail «${esc(v.subject)}» (agendado solo por OrderBrain SDR).` });
      autoNext = { id: n?.id || null, type: "call", date: day, time: "" };
      done.push({ label: `Próximo paso: llamada el ${nice(day)} (automático, lo podés cambiar)` });
    }
    if (!s.leadOnly) { const fresh = await checkSchool(id, { force: true }).catch(() => getMatch(id)); if (fresh && (!fresh.confirmed || fresh.auto)) setMatch(id, { ...fresh, confirmed: true, auto: false }); }
    pdOk = true;
    // prospecto recién creado: sus campos vacíos y la nota de datos del colegio (con tope de tiempo)
    if (leadR?.created) await enrichNewLead(id, user, done, by).catch(() => {});
  } catch (e) {
    console.warn("Mail enviado sin registrar en Pipedrive:", e.message);
    warnings.push(`El mail salió, pero no pude guardarlo en Pipedrive (${e.message}). Registralo a mano.`);
  }
  // el contacto (cadencia, meta y ranking) y el mail con su cuerpo (Historial): una sola entrada «Mail enviado»
  // (si algo de esto falla, el mail ya salió: se avisa, no se tira error, así no se vuelve a mandar)
  let histOk = false;
  const rec = { id: sent.id, threadId: sent.threadId || "", at, by: user.email, byName: sign, to: v.to, subject: v.subject, body: v.text, from: sent.from || "", bcc: !!sent.bcc,
    signature: sent.signature || "", via: viaPd ? "pipedrive" : "gmail", ...(sent.draftId ? { draftId: sent.draftId } : {}), target, url, activityId, autoNext, pendingNext, next: null, pdOk, ...(doneActId ? { doneActId } : {}) };
  try { addTouch({ schoolId: id, by: user.email, byName: signer(user), outcome: MAIL_SENT.id, channel: "mail", connected: false, text: v.subject.slice(0, 200), mailId: sent.id, to: v.to, ...(doneActId ? { doneActId } : {}) }); await addMail(id, rec); histOk = true; }
  catch (e) { console.warn("Mail enviado sin guardar en el historial:", e.message); warnings.push("El mail salió, pero no pude guardarlo en el historial de la app."); }
  done.push(...warnings.map(label => ({ label, warn: true })));
  const fallback = { type: "call", date: addBusinessDays(today, 2) };
  const suggest = autoNext ? { ...autoNext, why: firstTake ? "Es la primera vez que se lo contacta: quedó una llamada a tu nombre para el próximo día hábil. Cambiala si querés."
      : "Quedó una llamada a tu nombre en 2 días hábiles para confirmar que lo vio y proponer una demo de 20 minutos. Cambiala si querés." }
    : pendingNext ? { ...pendingNext, why: `Ya tenés ${pendingNext.type === "meeting" ? "una demo" : `una ${kindOf(pendingNext.type)}`} con este colegio el ${nice(pendingNext.date)}${pendingNext.time ? ` a las ${pendingNext.time}` : ""}: si la cambiás, se mueve esa (no se crea otra).` }
    : { ...fallback, why: "Llamá en 2 días hábiles para confirmar que lo vio y proponer una demo de 20 minutos." };
  return { ok: true, done, warnings, logged: { pipedrive: pdOk, history: histOk }, mail: mailOut(rec), suggest, fallback, orgUrl: url, school: schoolSummary(s),
    ...(s.leadOnly ? whereOf({ lead: { id: s.leadId, title: leadTitleOf(s), url: leadUrlOf(s.leadId) } }) : whereOf({ lead: leadR, dealId: target?.dealId || null, orgId: orgRec?.orgId || null, orgName: orgRec?.orgName || "" })) };
}
// Próximo paso después de un mail enviado (Registrar se abre con el mail ya registrado). Se mueve la actividad que ya
// quedó (moveActivityId: la llamada automática o una tuya pendiente) en vez de crear otra; si el paso es el mismo que ya
// estaba, no se toca. completeActivityId: la de la agenda desde la que se abrió la ficha, marcada como hecha.
// Sin próximo paso se puede, con aviso.
export async function mailNext(id, user, { mailId, next = null, moveActivityId = null, completeActivityId = null } = {}, tz) {
  const s = byId.get(id); if (!s) throw bad("Colegio inexistente", 404);
  const m = (await mailsFor(id)).find(x => x.id === String(mailId || "") && x.by === user.email);
  if (!m) throw bad("No encontré ese mail.", 404);
  if (m.next) throw bad("Ya guardaste el próximo paso de este mail.", 409);
  if (next && (!TYPE_LABEL[next.type] || !/^\d{4}-\d{2}-\d{2}$/.test(next.date || "") || (next.time && !/^\d{2}:\d{2}$/.test(next.time)))) throw bad("Revisá el próximo paso: qué, día y hora.");
  const done = [], target = m.target || (s.leadOnly ? { leadId: s.leadId } : null);
  const doneId = Number(completeActivityId) || null;
  let closedId = null;
  if (doneId) await pd.updateActivity(doneId, { done: true }).then(() => { closedId = doneId; done.push({ label: "Actividad de la agenda marcada como hecha" }); }, () => done.push({ label: "No pude marcar la actividad como hecha: hacelo desde la agenda.", warn: true }));
  // la que queda como próximo paso: la que pidió mover el navegador o, si no, la automática (salvo que se haya marcado hecha)
  const baseId = Number(moveActivityId) || (m.autoNext?.id && Number(m.autoNext.id) !== doneId ? Number(m.autoNext.id) : null);
  const base = baseId && baseId !== doneId ? await pd.getActivity(baseId).catch(() => null) : null;
  const live = base && !base.done ? base : null;
  const isAuto = !!live && Number(m.autoNext?.id) === live.id;
  const what = a => `${isAuto ? "la llamada automática" : `tu ${kindOf(a.type)}`} del ${nice(nextOf(a, tz).date)}`;
  if (next) {
    if (!target) throw bad("Este mail no quedó en Pipedrive: agendá el próximo paso desde Registrar.", 409);
    const u = toUtc(next.date, next.time, tz), owner = Number(next.ownerId) || user.pdUserId;
    const subject = String(next.subject || "").trim().slice(0, 140);
    // igual a lo que ya estaba (qué, día, hora y para quién, sin detalle nuevo): no se toca
    const same = live && live.type === next.type && live.due_date === u.date && String(live.due_time || "").slice(0, 5) === String(u.time || "").slice(0, 5)
      && Number(pd.realOwner(live.owner_id ?? live.user_id) || live.owner_id) === owner && !subject;
    if (same) done.push({ label: `Queda ${what(live)}${live.due_time ? ` a las ${nextOf(live, tz).time}` : ""}`, url: m.url || undefined });
    else {
      let moved = false;
      if (live) moved = await pd.updateActivity(live.id, { type: next.type, subject: subject || `${TYPE_LABEL[next.type]} · ${s.name}`, due_date: u.date, ...(u.time ? { due_time: u.time } : {}), owner_id: owner }).then(() => true, () => false);
      if (!moved) await pd.addActivity({ subject: subject || `${TYPE_LABEL[next.type]} · ${s.name}`, type: next.type, dueDate: u.date, dueTime: u.time, ...target, ownerId: owner, note: `Después del mail «${esc(m.subject)}»` });
      done.push({ label: `Próximo paso: ${TYPE_LABEL[next.type]} el ${nice(next.date)}${next.time ? " a las " + next.time : ""}${moved ? isAuto ? " (cambié la llamada automática)" : " (moví la que ya tenías, no hay otra)" : ""}`, url: m.url || undefined });
    }
  } else done.push(live ? { label: `Queda ${what(live)}` } : { label: "Sin próximo paso: este colegio se puede perder de vista.", warn: true });
  // la de la agenda que se cerró con el mail: en el Historial va en la entrada del mail
  await patchMail(id, m.id, { next: next ? { type: next.type, date: next.date, time: next.time || "" } : { none: true }, nextAt: new Date().toISOString(), ...(closedId && !m.doneActId ? { doneActId: closedId } : {}) });
  return { ok: true, done, orgUrl: m.url || "", school: schoolSummary(s) };
}
