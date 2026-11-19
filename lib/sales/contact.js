// Registrar un contacto, comentar, ensureOrg y los recordatorios de demo.
import * as pd from "../pipedrive.js";
import { addTouch, byId, getMatch, refreshArchived, refreshMatch, setMatch, touchesFor, withLock } from "../store.js";
import { CHANNEL_TYPE, DEAL_FIELDS, LOST_REASONS, MARKETS, OPTIONS, TYPE_LABEL, market } from "../config.js";
import { countAttempts, outcomeById, suggestNext } from "../playbook.js";
import { addBusinessDays, confirmDay, fromUtc, safeTz, toUtc, todayIn, weekday } from "../time.js";
import { structureNote } from "../ai.js";
import { canLead } from "../teams.js";
import { bad, esc } from "../text.js";
import { nice, signer } from "./util.js";
import { countryFromOpt, paisWarn, personLabel, phoneCountry } from "./records.js";
import { checkSchool } from "./match.js";
import { leadTitleOf, settleExisting } from "./settle.js";
import { effMatch, schoolSummary } from "./list.js";
import { NO_AUTO_NEXT, enrichNewLead, leadUrlOf, markWorked, workLead } from "./worklead.js";
import { withoutEvent } from "./agenda.js";

// Se asegura de que el colegio tenga organización en Pipedrive; si no existe, la crea.
export async function ensureOrg(id, ownerId = null) {
  const s = byId.get(id);
  if (s?.leadOnly) throw bad("Es un prospecto sin organización: lo que registres queda en el prospecto.", 409);
  await refreshMatch(id);
  let rec = await checkSchool(id);
  if (rec.orgId) return rec;
  // nunca se crea sin revisar antes si ya está en Pipedrive (quien llama casi siempre ya lo hizo: queda 2 minutos)
  await settleExisting(id, { pdUserId: ownerId });
  if (s?.leadOnly) throw bad("Este colegio ya tiene un prospecto en Pipedrive: lo que registres queda ahí. Probá de nuevo.", 409);
  rec = getMatch(id);
  if (rec?.orgId) return rec;
  return withLock("org:" + id, async () => {
    // otra instancia pudo haberla creado mientras esperábamos el candado
    await refreshMatch(id);
    rec = await checkSchool(id);
    if (rec.orgId) return rec;
    if (!ownerId) throw bad(pd.NO_OWNER, 403);
    const org = await pd.createOrganization({
      name: s.name, website: s.web, ownerId,
      address: { value: [s.addr, s.city, s.country].filter(Boolean).join(", "), locality: s.city, country: s.country },
    });
    return setMatch(id, { status: "org", detail: "Creado desde OrderBrain SDR", orgId: org.id, orgName: org.name || s.name, confirmed: true, openDealId: null, dealCount: 0, candidates: [], created: true, ownerId: ownerId || null });
  });
}

// Sugerencia de próximo paso para el formulario.
export function nextFor(id, outcome, channel, tz) {
  return suggestNext({ outcome, channel, attempts: countAttempts(touchesFor(id)), today: todayIn(tz) });
}

// ---------- registrar un contacto
// el contacto queda en la nota aunque no tenga nombre (teléfono o mail sueltos); la persona se crea solo con nombre
export const contactLine = c => [c.name, c.role, c.phone, c.email].map(x => String(x ?? "").trim()).filter(Boolean).join(" · ");
// Escribe en Pipedrive: actividad hecha (el contacto), nota, persona, trato, demo, próximo paso y pérdida.
// «Atendió recepción»: el nombre y cargo que dieron, para preguntar por esa persona la próxima vez
export const askOf = (o, c) => o.id === "gatekeeper" && String(c?.name || "").trim() ? { name: String(c.name).replace(/\s+/g, " ").trim().slice(0, 80), role: String(c.role || "").replace(/\s+/g, " ").trim().slice(0, 60) } : null;
// Filas de la nota: lo que sacó la IA y lo que cargó el SDR. La cafetería de la IA solo completa la fila «Cafetería» si el SDR no la eligió.
export function noteRows(q = {}, c = {}, ask = null, structured = null) {
  const qualRows = [["Preguntar por", ask && personLabel(ask.name, ask.role)], ["Cafetería", q.cafeteria || structured?.cafeteria], ["Alumnos", q.alumnos], ["Niveles", (q.niveles || []).join(", ")], ["Sistema actual", q.sistema], ["Contacto", contactLine(c)]];
  const aiRows = structured ? [["Resumen", structured.resumen], ["Decisor", structured.decisor], ["Objeción", structured.objecion], ["Próximo paso", structured.proximo_paso], ["Interés", structured.interes]] : [];
  return [...aiRows, ...qualRows].filter(([, v]) => v && String(v).trim());
}
// «Demo blindada»: un WhatsApp «Confirmar demo» el día hábil anterior (o hoy) para quien agenda la demo.
// date y time son locales (tz). Los «Confirmar demo» pendientes de la organización (o del prospecto sin organización):
// al agendar se mueve el tuyo (o cualquiera si sos líder); al mover una demo ya revisada (any) se mueven todos, sin cambiar de dueño.
// Si no hay ninguno se crea a nombre de ownerId (por defecto quien agenda).
export const reminderPlan = (pend, { userId, leader = false, any = false }) => { const move = pend.filter(a => any || canLead(leader, { id: a.owner_id }) || Number(a.owner_id) === Number(userId)); return { move, others: pend.filter(a => !move.includes(a)) }; };
export async function demoReminder({ name, orgId, dealId, personId, leadId, date, time, tz, user, leader = false, any = false, ownerId = null }) {
  const t = todayIn(tz), day = confirmDay(date, t); if (!day) return [];
  const note = `Demo el ${nice(date)}${time ? ` a las ${esc(time)} (hora de ${esc(safeTz(tz))})` : ""}. Confirmala por WhatsApp con la plantilla «Confirmar demo».<br><br><i>Agendado solo por OrderBrain SDR</i>`;
  const where = orgId ? { orgId } : leadId ? { leadId } : null;
  const pend = where ? (await pd.activities({ ...where, done: false, limit: 50 }).catch(() => [])).filter(a => a.type === "deadline" && /^Confirmar demo\b/.test(a.subject || "")) : [];
  const { move, others } = reminderPlan(pend, { userId: user.pdUserId, leader, any }), label = `Recordatorio para confirmar la demo ${day === t ? "hoy" : "el " + nice(day)}`;
  for (const a of move) await pd.updateActivity(a.id, { due_date: day, note });
  if (!move.length) await pd.addActivity({ subject: `Confirmar demo · ${name}`, type: "deadline", dueDate: day, orgId, dealId, personId, leadId, ownerId: ownerId || user.pdUserId, note });
  const theirs = move.some(a => Number(a.owner_id) !== Number(user.pdUserId));
  return [{ label: label + (theirs ? " (es de otra persona: le queda con la fecha nueva)" : "") }, ...(others.length ? [{ label: "Hay otro recordatorio para confirmar esta demo, de otra persona: avisale del cambio.", warn: true }] : [])];
}
// Se movió una demo (actividad de Pipedrive ya revisada con ownActivity): el recordatorio la acompaña, sea de quien sea.
// Si no había, queda para el dueño de la demo (no para el líder que la movió).
export async function demoMoved(a, user, { date, time }, tz, leader = false) {
  if (a?.type !== "meeting" || a.done) return [];
  const org = a.org_id ? (await pd.orgsByIds([a.org_id]).catch(() => []))[0] : null;
  const name = org?.name || String(a.subject || "").split(" · ").slice(1).join(" · ") || "la demo";
  const local = time || (a.due_time ? fromUtc(a.due_date, a.due_time, tz).time : "");
  return demoReminder({ name, orgId: a.org_id || null, dealId: a.deal_id || null, leadId: a.lead_id || null, date, time: local, tz, user, leader, any: true, ownerId: pd.realOwner(a.owner_id) });
}
// Dónde quedó lo registrado (Registrar lo dice arriba; con un prospecto la ficha lo muestra sin recargar)
export const whereOf = ({ lead = null, dealId = null, orgId = null, orgName = "" }) => lead ? { where: { kind: "lead", id: lead.id, title: lead.title, url: lead.url, created: !!lead.created }, lead: { id: lead.id, title: lead.title, ownerId: lead.ownerId, url: lead.url, created: !!lead.created } }
  : dealId ? { where: { kind: "deal", id: dealId, url: `${pd.PD_WEB}/deal/${dealId}` } } : orgId ? { where: { kind: "org", id: orgId, title: orgName || "", url: `${pd.PD_WEB}/organization/${orgId}` } } : {};
export async function logContact(id, user, p, tz) {
  const s = byId.get(id);
  if (!s) throw bad("Colegio inexistente", 404);
  // archivado (como al crear el prospecto): primero se desarchiva
  await refreshArchived(id);
  if (effMatch(s)?.status === "archived") throw bad("Está archivado: desarchivalo para registrar contactos.", 409);
  const o = outcomeById(p.outcome);
  if (!o || o.hidden) throw bad("Elegí qué pasó en el contacto.");
  const channel = CHANNEL_TYPE[p.channel] ? p.channel : "call";
  const raw = String(p.text || "").trim().slice(0, 4000);
  const dateRe = /^\d{4}-\d{2}-\d{2}$/, timeRe = /^\d{2}:\d{2}$/;
  if (p.next?.type && !dateRe.test(p.next.date || "")) throw bad("Poné la fecha del próximo paso.");
  if (o.id === "demo" && (!dateRe.test(p.demo?.date || "") || !timeRe.test(p.demo?.time || ""))) throw bad("Poné el día y la hora de la demo.");
  if (p.lost?.reason && !LOST_REASONS.includes(p.lost.reason)) throw bad("Motivo de pérdida inválido.");
  // país del trato (embudo y campo País): el del registro, el del prospecto, el elegido o el prefijo del teléfono
  const lid0 = o.id === "demo" ? s.leadId || getMatch(id)?.leadId || null : null;
  const lead0 = lid0 ? (await pd.leadsByIds([lid0], user.pdUserId).catch(() => []))[0] || null : null;
  const country = s.country || countryFromOpt(lead0?.paisOpt) || (MARKETS[p.country] ? p.country : "") || phoneCountry(s.phone, p.contact?.phone);
  if (s.virtual && !s.country && country) s.country = country;
  if (o.id === "demo" && s.virtual && !s.country) throw bad("Elegí el país del colegio: el trato se crea en el embudo de ese país.");
  const mk = market(country);
  const today = todayIn(tz);
  const done = [], warnings = [];
  // antes de crear nada: ¿ya está en Pipedrive? (puede quedar como «Prospecto en Pipe»: entonces todo va a ese prospecto)
  const pre = await settleExisting(id, user);
  if (s.leadOnly) { const r = await logLead(id, s, user, p, tz, { o, channel, raw, today }); r.done.unshift(...pre.done); r.done.push(...pre.warnings.map(label => ({ label, warn: true }))); return r; }
  done.push(...pre.done); warnings.push(...pre.warnings);

  // ¿lo está tomando por primera vez? (nunca contactado: no tenía organización en Pipedrive)
  const firstTake = !getMatch(id)?.orgId;
  const rec = await ensureOrg(id, user.pdUserId);
  // si estaba a nombre de la cuenta general de la empresa, pasa a quien lo trabaja
  if (!rec.created && !rec.ownerId && rec.confirmed) {
    await pd.updateOrganization(rec.orgId, { owner_id: user.pdUserId }).then(() => { setMatch(id, { ...getMatch(id), ownerId: user.pdUserId, ownerName: signer(user) }); done.push({ label: "El colegio pasó a tu nombre en Pipedrive (estaba en la cuenta general)" }); }).catch(() => {});
  }
  const orgUrl = `${pd.PD_WEB}/organization/${rec.orgId}`;
  // (si todo va a un prospecto, esta línea pasa a decir solo cuál es la organización)
  const orgLine = { label: rec.created ? "Organización creada en Pipedrive a tu nombre" : `Guardado en ${rec.orgName}`, url: orgUrl };
  done.push(orgLine);

  // Persona (decisor o contacto). Si viene de un prospecto que ya tenía persona, esa persona pasa a la organización.
  let personId = p._personId || null;
  if (personId) await pd.updatePerson(personId, { org_id: rec.orgId }).catch(() => {});
  const c = p.contact || {};
  if (c.name && String(c.name).trim()) {
    const person = await pd.addPerson({ name: personLabel(c.name, c.role), orgId: rec.orgId, phone: c.phone, email: c.email, ownerId: user.pdUserId });
    personId = person?.id || null;
    done.push({ label: `Contacto ${c.name}`, url: personId ? `${pd.PD_WEB}/person/${personId}` : orgUrl });
  }

  // Trato: se crea cuando se agenda la demo (o si se pide calificar y no hay uno abierto).
  let dealId = rec.openDealId || null;
  const q = p.qual || {};
  const custom = {};
  if (q.cafeteria && OPTIONS.cafeteria[q.cafeteria]) custom[DEAL_FIELDS.cafeteria] = OPTIONS.cafeteria[q.cafeteria];
  if (Number(q.alumnos) > 0) custom[DEAL_FIELDS.alumnos] = Number(q.alumnos);
  const niveles = (q.niveles || []).map(n => OPTIONS.niveles[n]).filter(Boolean);
  if (niveles.length) custom[DEAL_FIELDS.niveles] = niveles;
  if (o.id === "demo" && !dealId) {
    // la fuente del prospecto, si tiene; si no, cold calling
    const fuente = String(lead0?.fuenteOpt ?? "").split(",").map(Number).filter(n => n > 0);
    const body = { title: `${s.name}`, org_id: rec.orgId, pipeline_id: mk.pipeline, stage_id: mk.stage, owner_id: Number(p.demo.ownerId) || user.pdUserId || undefined,
      custom_fields: { ...custom, [DEAL_FIELDS.fuente]: fuente.length ? fuente : [OPTIONS.fuente.coldCalling] } };
    if (user.pdUserId) body.custom_fields[DEAL_FIELDS.sdr] = user.pdUserId;
    if (OPTIONS.pais[country]) body.custom_fields[DEAL_FIELDS.pais] = OPTIONS.pais[country];
    else warnings.push(country ? paisWarn(country) : "No supe el país: el trato quedó en el embudo LatAm. Revisalo en Pipedrive.");
    const ciudad = await pd.optionFor(DEAL_FIELDS.ciudad, s.city).catch(() => null); if (ciudad) body.custom_fields[DEAL_FIELDS.ciudad] = ciudad;
    if (s.phone) body.custom_fields[DEAL_FIELDS.telefono] = s.phone;
    if (s.web) body.custom_fields[DEAL_FIELDS.web] = s.web;
    if (personId) body.person_id = personId;
    let deal;
    try { deal = await pd.createDeal(body); }
    catch (e) { // si algún campo personalizado no coincide con la cuenta, se crea el trato sin ellos
      console.warn("Trato sin campos personalizados:", e.message);
      deal = await pd.createDeal({ title: body.title, org_id: body.org_id, pipeline_id: body.pipeline_id, stage_id: body.stage_id, owner_id: body.owner_id, person_id: body.person_id });
    }
    dealId = deal.id;
    done.push({ label: "Trato creado en el embudo de ventas", url: `${pd.PD_WEB}/deal/${dealId}` });
  } else if (dealId && Object.keys(custom).length) {
    await pd.updateDeal(dealId, { custom_fields: custom }).catch(e => console.warn("No se pudo calificar el trato:", e.message));
  }

  // Sin trato abierto, el contacto, el próximo paso y la nota van a un PROSPECTO (y a la organización y la persona), como se
  // trabaja en Pipedrive: el abierto de la organización (tuyo o de la cuenta general, que pasa a tu nombre) o uno nuevo a tu
  // nombre (workLead). Si el prospecto o la organización es de otra persona, o es cliente, queda en la organización (con
  // aviso). Con una demo se crea el trato (y el prospecto, si tenía, se archiva más abajo).
  const leadR = !dealId && o.id !== "demo" ? await workLead(id, rec, user, done, warnings, { personId }) : null, leadT = leadR?.id || null;
  if (leadT && !rec.created) orgLine.label = `Organización: ${rec.orgName}`;
  // la persona del prospecto, si no se cargó otra (como lo hace el equipo en Pipedrive: prospecto + organización + persona)
  if (leadR && !personId && leadR.personId) personId = leadR.personId;
  const tgt = leadT ? { orgId: rec.orgId, leadId: leadT } : { orgId: rec.orgId, dealId };

  // El contacto en sí, como actividad hecha (cuenta para los reportes de Pipedrive).
  const chLabel = { call: "Llamada", whatsapp: "WhatsApp", mail: "Mail", visit: "Visita" }[channel];
  await pd.addActivity({ subject: `${chLabel}: ${o.label} · ${s.name}`, type: CHANNEL_TYPE[channel], dueDate: today, ...tgt, personId, ownerId: user.pdUserId, note: raw ? esc(raw).replace(/\n/g, "<br>") : "", done: true });
  done.push({ label: `${chLabel} registrada como hecha` });

  // Nota ordenada
  const ask = askOf(o, c);
  let html = `<b>${esc(chLabel)} · ${esc(o.label)}</b>`;
  let structured = null;
  if (raw && p.ai !== false) structured = await structureNote({ school: s, outcome: o.label, text: raw }).catch(() => null);
  const rows = noteRows(q, c, ask, structured);
  if (rows.length) html += "<br>" + rows.map(([k, v]) => `<b>${k}:</b> ${esc(v)}`).join("<br>");
  if (raw) html += `<br><br>${structured ? "<i>Lo que anotó el SDR:</i> " : ""}${esc(raw).replace(/\n/g, "<br>")}`;

  // Demo
  if (o.id === "demo") {
    const owner = Number(p.demo.ownerId) || user.pdUserId;
    const u = toUtc(p.demo.date, p.demo.time, tz);
    await pd.addActivity({ subject: `Demo OrderEAT · ${s.name}`, type: "meeting", dueDate: u.date, dueTime: u.time, durationMin: Number(p.demo.duration) || 30, orgId: rec.orgId, dealId, personId, ownerId: owner,
      note: `Agendada por ${esc(signer(user))} desde OrderBrain SDR${raw ? "<br><br>" + esc(raw).replace(/\n/g, "<br>") : ""}` });
    html += `<br><b>Demo:</b> ${nice(p.demo.date)} ${esc(p.demo.time)} (hora de ${esc(tz)})`;
    done.push({ label: `Demo el ${nice(p.demo.date)} a las ${p.demo.time}` });
    done.push(...await demoReminder({ name: s.name, orgId: rec.orgId, dealId, personId, date: p.demo.date, time: p.demo.time, tz, user }).catch(e => [{ label: `No pude agendar el recordatorio para confirmar la demo: ${e.message}`, warn: true }]));
  }

  // Próximo paso (nextRec: lo que quedó agendado, para la sesión de trabajo)
  let nextRec = null;
  if (p.next?.type && TYPE_LABEL[p.next.type]) {
    const u = toUtc(p.next.date, p.next.time, tz);
    await pd.addActivity({ subject: p.next.subject || `${TYPE_LABEL[p.next.type]} · ${s.name}`, type: p.next.type, dueDate: u.date, dueTime: u.time, ...tgt, personId,
      ownerId: Number(p.next.ownerId) || user.pdUserId, note: raw ? esc(raw).slice(0, 1000) : "" });
    nextRec = { type: p.next.type, date: p.next.date, time: p.next.time || "", ownerId: Number(p.next.ownerId) || user.pdUserId || null };
    html += `<br><b>Próximo paso:</b> ${TYPE_LABEL[p.next.type]} el ${weekday(p.next.date)} ${esc(p.next.date)}${p.next.time ? " " + esc(p.next.time) : ""}`;
    done.push({ label: `Próximo paso: ${TYPE_LABEL[p.next.type]} el ${nice(p.next.date)}${p.next.time ? " a las " + p.next.time : ""}` });
  }

  // Colegio nuevo sin próximo paso elegido: queda una llamada para el próximo día hábil, a tu nombre (se cambia desde la agenda)
  else if ((firstTake || rec.created) && !NO_AUTO_NEXT.includes(o.id)) {
    const day = addBusinessDays(today, 1);
    await pd.addActivity({ subject: `${TYPE_LABEL.call} · ${s.name}`, type: "call", dueDate: day, ...tgt, personId, ownerId: user.pdUserId, note: "Seguimiento del primer contacto (agendado solo por OrderBrain SDR)." });
    nextRec = { type: "call", date: day, time: "", ownerId: user.pdUserId || null, auto: true };
    html += `<br><b>Próximo paso:</b> ${TYPE_LABEL.call} el ${weekday(day)} ${day}`;
    done.push({ label: `Próximo paso: llamada el ${nice(day)} (automático, cambialo en la agenda si querés)` });
  }

  // Pérdida
  if (p.lost?.reason) {
    if (dealId) {
      await pd.updateDeal(dealId, { status: "lost", lost_reason: p.lost.reason });
      done.push({ label: `Trato perdido: ${p.lost.reason}` });
    }
    html += `<br><b>Motivo:</b> ${esc(p.lost.reason)}`;
  }
  html += `<br><br><i>Cargado por ${esc(signer(user))} desde OrderBrain SDR</i>`;
  // la nota, en el prospecto y la organización; si Pipedrive no acepta las dos juntas, en el prospecto
  if (leadT) await pd.addNote({ content: html, orgId: rec.orgId, leadId: leadT, personId }).catch(() => pd.addNote({ content: html, leadId: leadT }));
  else await pd.addNote({ content: html, orgId: rec.orgId, dealId, personId });
  done.push({ label: leadT ? "Nota guardada en el prospecto" : "Nota guardada" });

  // Etiqueta de interés en la organización
  // se cambia solo la de interés (alto, medio, bajo); las demás etiquetas quedan. Si no se pueden leer, no se toca nada.
  if (o.interest && rec.status !== "client") {
    const org = (await pd.orgsByIds([rec.orgId]).catch(() => []))[0], lv = [OPTIONS.orgLabel.alto, OPTIONS.orgLabel.medio, OPTIONS.orgLabel.bajo];
    if (org) await pd.updateOrganization(rec.orgId, { label_ids: [...new Set([...(org.labelIds || []).map(Number).filter(x => !lv.includes(x)), OPTIONS.orgLabel[o.interest]])] }).catch(() => {});
  }

  // Marca como hecha la actividad que motivó el contacto
  let doneActId = null;
  if (p.completeActivityId) await pd.updateActivity(Number(p.completeActivityId), { done: true }).then(() => { doneActId = Number(p.completeActivityId); done.push({ label: "Actividad pendiente marcada como hecha" }); }, () => done.push({ label: "No pude marcar la actividad como hecha: hacelo desde la agenda.", warn: true }));
  // Un prospecto (lead) que llegó a demo ya es un trato: se archiva el prospecto con una nota
  // (el prospecto puede venir de la ficha, del cruce guardado o de «Crear prospecto»)
  const leadId = s.leadId || getMatch(id)?.leadId || rec.leadId || null;
  if (leadId && o.id === "demo" && dealId) {
    await pd.addNote({ content: `<b>Pasó a trato</b><br>Demo agendada desde OrderBrain SDR por ${esc(signer(user))}.<br><a href="${pd.PD_WEB}/deal/${dealId}">Ver trato</a>`, leadId }).catch(() => {});
    await pd.updateLead(leadId, { is_archived: true }).then(() => done.push({ label: "Prospecto archivado: ya es un trato" })).catch(() => {});
  }

  // doneActId: la pendiente de la agenda que se cerró con este contacto (en el Historial va en la misma entrada)
  addTouch({ schoolId: id, by: user.email, byName: signer(user), outcome: o.id, channel, connected: o.connected, text: raw.slice(0, 300), demo: o.id === "demo", ...(ask ? { ask } : {}), ...(doneActId ? { doneActId } : {}) });
  const fresh = await checkSchool(id, { force: true }).catch(() => getMatch(id));
  if (!fresh.confirmed || fresh.auto) setMatch(id, { ...fresh, confirmed: true, auto: false }); // ya se trabajó con esta organización
  // prospecto recién creado: sus campos vacíos y la nota de datos del colegio (con tope de tiempo; lo registrado ya quedó)
  if (leadR?.created) await enrichNewLead(id, user, done);
  done.push(...warnings.map(label => ({ label, warn: true })));
  return { ok: true, done, warnings, orgUrl: leadR ? leadR.url : orgUrl, dealUrl: dealId ? `${pd.PD_WEB}/deal/${dealId}` : null, school: schoolSummary(s),
    next: nextRec, demo: o.id === "demo" ? { date: p.demo.date, time: p.demo.time } : null, ...whereOf({ lead: leadR, dealId, orgId: rec.orgId, orgName: rec.orgName }) };
}

// Registrar el contacto con un prospecto (lead) de Pipedrive que todavía no tiene organización.
// Todo queda en el prospecto: la actividad hecha, la nota, la persona y el próximo paso. Si llega a demo,
// se crea la organización, se registra como siempre (trato + demo) y el prospecto se archiva.
async function logLead(id, s, user, p, tz, { o, channel, raw, today }) {
  const done = [], leadUrl = `${pd.PD_WEB}/leads/inbox/${s.leadId}`;
  const c = p.contact || {};
  if (o.id === "demo") {
    // pasa a organización (a nombre de quien registra) y se registra con el flujo normal: trato en el embudo del país
    // + demo. La persona se crea una sola vez (en logContact, ya con la organización); la que tenía el prospecto se mueve.
    return withLock("lead:" + s.leadId, async () => {
      const cur = getMatch(id);
      if (cur?.orgId && !s.leadOnly) return logContact(id, user, p, tz); // otra instancia ya lo convirtió
      const org = await pd.createOrganization({ name: withoutEvent(s.name), ownerId: user.pdUserId,
        address: s.city || s.country ? { value: [s.city, s.country].filter(Boolean).join(", "), locality: s.city || undefined, country: s.country || undefined } : undefined });
      await pd.updateLead(s.leadId, { organization_id: org.id }).catch(() => {});
      // la misma ficha sigue funcionando: ahora es la del colegio (organización), con el prospecto guardado en el cruce
      s.leadOnly = false; s.pdOrgId = org.id;
      setMatch(id, { status: "org", detail: "Creado desde OrderBrain SDR", orgId: org.id, orgName: org.name || s.name, confirmed: true, ownerId: user.pdUserId || null, leadId: s.leadId, candidates: [] });
      const r = await logContact(id, user, { ...p, _personId: c.name ? null : s.personId || null }, tz);
      return { ...r, done: [{ label: "Organización creada desde el prospecto", url: `${pd.PD_WEB}/organization/${org.id}` }, ...r.done] };
    });
  }
  let personId = s.personId || null;
  if (c.name && String(c.name).trim()) {
    const person = await pd.addPerson({ name: personLabel(c.name, c.role), phone: c.phone, email: c.email, ownerId: user.pdUserId });
    if (person?.id) {
      done.push({ label: `Contacto ${c.name}`, url: `${pd.PD_WEB}/person/${person.id}` });
      if (!personId) { personId = person.id; await pd.updateLead(s.leadId, { person_id: person.id }).catch(() => {}); s.personId = person.id; s.personName = c.name; }
    }
  }
  const chLabel = { call: "Llamada", whatsapp: "WhatsApp", mail: "Mail", visit: "Visita" }[channel];
  await pd.addActivity({ subject: `${chLabel}: ${o.label} · ${s.name}`, type: CHANNEL_TYPE[channel], dueDate: today, leadId: s.leadId, personId, ownerId: user.pdUserId, note: raw ? esc(raw).replace(/\n/g, "<br>") : "", done: true });
  done.push({ label: `${chLabel} registrada como hecha` });
  let html = `<b>${esc(chLabel)} · ${esc(o.label)}</b>`;
  const ask = askOf(o, c);
  if (ask) html += `<br><b>Preguntar por:</b> ${esc(personLabel(ask.name, ask.role))}`;
  if (contactLine(c)) html += `<br><b>Contacto:</b> ${esc(contactLine(c))}`;
  if (raw) html += `<br><br>${esc(raw).replace(/\n/g, "<br>")}`;
  let nextRec = null;
  if (p.next?.type && TYPE_LABEL[p.next.type]) {
    const u = toUtc(p.next.date, p.next.time, tz);
    await pd.addActivity({ subject: p.next.subject || `${TYPE_LABEL[p.next.type]} · ${s.name}`, type: p.next.type, dueDate: u.date, dueTime: u.time, leadId: s.leadId, personId, ownerId: Number(p.next.ownerId) || user.pdUserId, note: raw ? esc(raw).slice(0, 1000) : "" });
    nextRec = { type: p.next.type, date: p.next.date, time: p.next.time || "", ownerId: Number(p.next.ownerId) || user.pdUserId || null };
    html += `<br><b>Próximo paso:</b> ${TYPE_LABEL[p.next.type]} el ${weekday(p.next.date)} ${esc(p.next.date)}${p.next.time ? " " + esc(p.next.time) : ""}`;
    done.push({ label: `Próximo paso: ${TYPE_LABEL[p.next.type]} el ${nice(p.next.date)}${p.next.time ? " a las " + p.next.time : ""}` });
  }
  // descartado (no le interesa, no es el momento con motivo, dato erróneo): el prospecto se archiva con el motivo
  const discard = !!p.lost?.reason;
  if (p.lost?.reason) html += `<br><b>Motivo:</b> ${esc(p.lost.reason)}`;
  html += `<br><br><i>Cargado por ${esc(signer(user))} desde OrderBrain SDR</i>`;
  await pd.addNote({ content: html, leadId: s.leadId });
  done.push({ label: "Nota guardada en el prospecto", url: leadUrl });
  if (discard) await pd.updateLead(s.leadId, { is_archived: true }).then(() => done.push({ label: "Prospecto archivado" })).catch(() => {});
  let doneActId = null;
  if (p.completeActivityId) await pd.updateActivity(Number(p.completeActivityId), { done: true }).then(() => { doneActId = Number(p.completeActivityId); done.push({ label: "Actividad pendiente marcada como hecha" }); }, () => done.push({ label: "No pude marcar la actividad como hecha: hacelo desde la agenda.", warn: true }));
  addTouch({ schoolId: id, by: user.email, byName: signer(user), outcome: o.id, channel, connected: o.connected, text: raw.slice(0, 300), demo: false, ...(ask ? { ask } : {}), ...(doneActId ? { doneActId } : {}) });
  return { ok: true, done, orgUrl: leadUrl, dealUrl: null, school: schoolSummary(s), next: nextRec, demo: null, ...whereOf({ lead: { id: s.leadId, title: leadTitleOf(s), url: leadUrl } }) };
}

// ---------- comentario y/o tarea para más adelante (para quien registra o para otra persona del equipo), sin registrar un
// contacto. server.js valida el texto, la tarea y su dueño (owner: usuario de Pipedrive) y si la de la agenda sigue (doneId).
// Sin trato abierto van a un PROSPECTO (el abierto tuyo o libre, o uno nuevo a tu nombre: workLead) con su organización y
// su persona; con trato abierto, al trato; prospecto u organización de otra persona, o cliente: a la organización.
export async function commentSchool(id, user, { text = "", task = null, owner = null, doneId = null, gone = false, by = "" } = {}, tz = "UTC") {
  const s = byId.get(id); if (!s) throw bad("Colegio inexistente", 404);
  const sign = signer(user);
  const pre = await settleExisting(id, user);
  const rec = s.leadOnly ? null : await ensureOrg(id, user.pdUserId);
  const done = [...pre.done], warns = [...pre.warnings];
  const leadR = !s.leadOnly && !rec.openDealId ? await workLead(id, rec, user, done, warns) : null, leadT = leadR?.id || null;
  if (rec?.created) done.unshift({ label: "Organización creada en Pipedrive a tu nombre", url: `${pd.PD_WEB}/organization/${rec.orgId}` });
  const target = s.leadOnly ? { leadId: s.leadId } : leadT ? { orgId: rec.orgId, leadId: leadT, personId: leadR.personId || undefined } : { orgId: rec.orgId, dealId: rec.openDealId || undefined };
  const url = s.leadOnly || leadT ? leadUrlOf(s.leadOnly ? s.leadId : leadT) : rec.openDealId ? `${pd.PD_WEB}/deal/${rec.openDealId}` : `${pd.PD_WEB}/organization/${rec.orgId}`;
  if (task) {
    const u = toUtc(task.date, task.time, tz);
    await pd.addActivity({ subject: String(task.subject || "").trim().slice(0, 140) || `${TYPE_LABEL[task.type]} · ${s.name}`, type: task.type, dueDate: u.date, dueTime: u.time, ...target, ownerId: owner?.id || user.pdUserId, note: text ? esc(text).slice(0, 1000) : "" });
    done.push({ label: `${TYPE_LABEL[task.type]} el ${task.date.slice(8, 10)}/${task.date.slice(5, 7)}${task.time ? " a las " + task.time : ""} para ${owner && owner.id !== user.pdUserId ? owner.name : "vos"}`, url });
  }
  const taskLine = task ? `<br><b>Tarea:</b> ${esc(TYPE_LABEL[task.type])} el ${esc(task.date)}${task.time ? " " + esc(task.time) : ""} para ${esc(owner?.name || sign)}` : "";
  const noteHtml = `<b>Comentario</b>${text ? "<br>" + esc(text).replace(/\n/g, "<br>") : ""}${taskLine}<br><br><i>Cargado por ${esc(sign)} desde OrderBrain SDR</i>`;
  // en el prospecto y su organización; si Pipedrive no acepta las dos juntas, en el prospecto
  await pd.addNote({ content: noteHtml, ...target }).catch(e => { if (!leadT) throw e; return pd.addNote({ content: noteHtml, leadId: leadT }); });
  done.push({ label: s.leadOnly || leadT ? "Comentario en el prospecto" : rec.openDealId ? "Comentario en el trato" : "Comentario en la organización", url });
  if (doneId) await pd.updateActivity(doneId, { done: true }).then(() => done.push({ label: "Actividad pendiente marcada como hecha" }), () => done.push({ label: "No pude marcar la actividad como hecha: hacelo desde la agenda.", warn: true }));
  if (gone) done.push({ label: "La actividad ya no está en Pipedrive.", warn: true });
  // se trabajó con esta organización (como al registrar un contacto); un prospecto nuevo se completa con los datos del colegio
  if (rec) await markWorked(id, rec).catch(() => {});
  if (leadR?.created) await enrichNewLead(id, user, done, by);
  for (const w of warns) done.push({ label: w, warn: true });
  return { done, school: schoolSummary(s), orgUrl: url, ...(s.leadOnly ? whereOf({ lead: { id: s.leadId, title: leadTitleOf(s), url } }) : whereOf({ lead: leadR, dealId: rec.openDealId || null, orgId: rec.orgId, orgName: rec.orgName })) };
}
