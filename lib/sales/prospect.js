// Crear prospecto, convertir a trato, mover tratos, archivar y agregar un decisor.
import * as pd from "../pipedrive.js";
import { byId, getMatch, refreshArchived, setArchived, setMatch, withLock } from "../store.js";
import { CLIENT_PIPES, LOST_REASONS, MARKETS, OPTIONS, TYPE_LABEL, market } from "../config.js";
import { toUtc } from "../time.js";
import { archiveError, archivePlan, canUnarchive } from "../archive.js";
import { canLead } from "../teams.js";
import { bad, esc } from "../text.js";
import { nice, signer } from "./util.js";
import { countryFromOpt, paisWarn, personLabel, phoneCountry } from "./records.js";
import { checkSchool } from "./match.js";
import { leadView, leadsHere, settleExisting } from "./settle.js";
import { effMatch, schoolSummary } from "./list.js";
import { getEnrich } from "./enrichment.js";
import { contactLine, ensureOrg } from "./contact.js";
import { enrichNewLead, leadUrlOf, newLead } from "./worklead.js";

// ---------- crear prospecto: «lo voy a contactar». Crea (si falta) la organización y el prospecto en Pipedrive a
// nombre de quien lo pide, y busca a quién contactar: la web del colegio (teléfonos, WhatsApp, mails) y, si hay
// estudio con IA, los decisores con nombre y cargo. No inventa nada: lo que no encuentra, no lo carga.
// task: la primera tarea a futuro (siempre conviene dejar una): { type, date, time, ownerId, subject }
const PHONE_RE = /\d/g, okPhone = p => (String(p || "").match(PHONE_RE) || []).length >= 8 && !/sin datos|estimad|no identific/i.test(p);
const okEmail = e => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(String(e || "").trim());
const okName = n => n && !/sin datos|estimad|no identific|desconocid|n\/a/i.test(n);
export async function createProspect(id, user, task = null, tz = "America/Montevideo") {
  const s = byId.get(id);
  if (!s || (s.leadOnly && s.virtual)) throw bad("Colegio inexistente", 404);
  if (!user.pdUserId) throw bad("Tu email no coincide con ningún usuario de Pipedrive: pedí que te den de alta.", 403);
  if (task && (!TYPE_LABEL[task.type] || !/^\d{4}-\d{2}-\d{2}$/.test(task.date || "") || (task.time && !/^\d{2}:\d{2}$/.test(task.time)))) throw bad("Revisá la tarea: tipo, día y hora.");
  return withLock("prospect:" + id, async () => {
    // estado al día (no el de hace una semana): si es de otro, cliente, ex cliente o tiene trato abierto, no se crea
    const cur = await checkSchool(id, { force: true });
    const eff = effMatch(s) || cur;
    if (cur.ownerId && cur.ownerId !== user.pdUserId) throw bad(`La organización es de ${cur.ownerName || "otra persona"} en Pipedrive. Hablalo con esa persona.`, 409);
    if (eff.status === "client") throw bad("Ya es cliente de OrderEAT. No se prospecta.", 409);
    if (eff.status === "churn") throw bad("Es ex cliente de OrderEAT: antes de contactar, hablá con el equipo de cuentas.", 409);
    if (eff.status === "open") throw bad(`Ya tiene un trato abierto${cur.openDealOwner ? ` de ${cur.openDealOwner}` : ""}.`, 409);
    if (eff.status === "archived") throw bad("Está archivado: desarchivalo para prospectarlo.", 409);
    // ¿ya está en Pipedrive? Si ya tiene un prospecto (sin organización), es ese: no se crea otro
    const pre = await settleExisting(id, user);
    if (s.leadOnly) {
      const url = leadUrlOf(s.leadId), title = getMatch(id)?.leadTitle || s.name;
      return { ok: true, done: [...pre.done.filter(d => !/^Ya estaba en Pipedrive/.test(d.label)), { label: `Ya tenía un prospecto en Pipedrive: «${title}». No creé otro.`, url }, ...pre.warnings.map(label => ({ label, warn: true }))],
        warnings: pre.warnings, leadUrl: url, orgUrl: url, found: {}, school: schoolSummary(s), created: false, existing: true, lead: { id: s.leadId, title, ownerId: user.pdUserId, url, created: false } };
    }
    const rec = await ensureOrg(id, user.pdUserId);
    if (rec.ownerId && rec.ownerId !== user.pdUserId) throw bad(`La organización es de ${rec.ownerName || "otra persona"} en Pipedrive. Hablalo con esa persona.`, 409);
    const orgUrl = `${pd.PD_WEB}/organization/${rec.orgId}`;
    const done = [...pre.done, { label: rec.created ? "Organización creada en Pipedrive" : `Organización: ${rec.orgName}`, url: orgUrl }], warnings = [...pre.warnings];
    // ¿ya hay un prospecto abierto? se reusa si es tuyo (sin duplicar persona ni nota); si es de otro, no se crea
    const open = await leadsHere(s, rec.orgId).catch(e => { throw bad(`No pude revisar los prospectos de Pipedrive (${e.message}). Probá de nuevo.`, 502); });
    if (open.find(l => l.ownerId && l.ownerId !== user.pdUserId)) throw bad("Ya hay un prospecto abierto de otra persona para este colegio.", 409);
    let lead = open.find(l => !l.ownerId || l.ownerId === user.pdUserId);
    // lo que estaba a nombre de la cuenta general de la empresa pasa a tu nombre: así nadie más lo toma a la vez
    if (!rec.created && !rec.ownerId && rec.confirmed) { await pd.updateOrganization(rec.orgId, { owner_id: user.pdUserId }); setMatch(id, { ...getMatch(id), ownerId: user.pdUserId, ownerName: signer(user) }); done.push({ label: "La organización pasó a tu nombre (estaba en la cuenta general)" }); }
    if (lead && !lead.ownerId && (rec.confirmed || rec.created)) { await pd.updateLead(lead.id, { owner_id: user.pdUserId }); lead.ownerId = user.pdUserId; done.push({ label: "El prospecto pasó a tu nombre (estaba en la cuenta general)" }); }
    const found = { phones: [], emails: [], whatsapp: "", decisores: [] };
    let personId = lead?.personId || null;
    if (!lead) {
      // a quién contactar: la web del colegio y, si hay estudio con IA, los decisores (sin «sin datos» ni estimaciones)
      if (okPhone(s.phone)) found.phones.push(s.phone);
      if (okEmail(s.email)) found.emails.push(s.email);
      if (s.web) {
        try { const { webInfo } = await import("../enrich.js"); const w = await webInfo(s.web); if (okPhone(w.phone)) found.phones.push(w.phone); if (okEmail(w.email)) found.emails.push(w.email); if (/^\+\d{8,15}$/.test(w.whatsapp || "")) found.whatsapp = w.whatsapp; } catch {}
      }
      const { getStudy } = await import("../store.js");
      const st = await getStudy(id).catch(() => null);
      if (st) {
        found.decisores = (st.decisores || []).filter(d => okName(d.nombre)).map(d => ({ ...d, cargo: okName(d.cargo) ? d.cargo : "" })).slice(0, 3);
        found.phones.push(...(st.contacto?.telefonos || []).filter(okPhone)); found.emails.push(...(st.contacto?.emails || []).filter(okEmail));
        if (!found.whatsapp && /^\+?\d{8,15}$/.test(String(st.contacto?.whatsapp || "").replace(/[\s-]/g, ""))) found.whatsapp = st.contacto.whatsapp;
      }
      found.phones = [...new Set(found.phones)].slice(0, 4); found.emails = [...new Set(found.emails.map(e => e.trim().toLowerCase()))].slice(0, 4);
      // persona: solo el decisor con nombre real. Los teléfonos y mails del colegio quedan en la nota y en el prospecto.
      const d0 = found.decisores[0];
      if (d0) {
        const person = await pd.addPerson({ name: personLabel(d0.nombre, d0.cargo), orgId: rec.orgId, ownerId: user.pdUserId }).catch(() => null);
        if (person?.id) { personId = person.id; done.push({ label: `Contacto: ${personLabel(d0.nombre, d0.cargo)}`, url: `${pd.PD_WEB}/person/${person.id}` }); }
      }
      lead = await newLead(id, rec, user, { personId, found });
      if (!OPTIONS.pais[s.country]) warnings.push(s.country ? paisWarn(s.country) : "No supe el país del colegio: el campo País quedó sin completar.");
      const rows = [
        found.decisores.length ? `<b>Decisores:</b><br>${found.decisores.map(d => `• ${esc(personLabel(d.nombre, d.cargo))}${d.fuente ? ` · ${esc(d.fuente)}` : ""}`).join("<br>")}` : "<b>Decisor:</b> todavía sin nombre. Preguntá en recepción quién maneja la cafetería.",
        found.phones.length ? `<b>Teléfonos:</b> ${found.phones.map(esc).join(" · ")}` : "", found.whatsapp ? `<b>WhatsApp:</b> ${esc(found.whatsapp)}` : "",
        found.emails.length ? `<b>Mails:</b> ${found.emails.map(esc).join(" · ")}` : "", s.web ? `<b>Web:</b> ${esc(s.web)}` : "",
      ].filter(Boolean);
      // en el prospecto (y su organización); si Pipedrive no acepta las dos juntas, en el prospecto
      const html = `<b>Prospecto creado desde OrderBrain SDR</b> por ${esc(signer(user))}<br>${rows.join("<br>")}`;
      await pd.addNote({ content: html, orgId: rec.orgId, leadId: lead.id, personId }).catch(() => pd.addNote({ content: html, leadId: lead.id })).catch(() => {});
    }
    const leadUrl = `${pd.PD_WEB}/leads/inbox/${lead.id}`;
    done.push({ label: open.length ? "Prospecto ya existente (tuyo)" : "Prospecto creado a tu nombre", url: leadUrl });
    // la primera tarea a futuro, atada al prospecto (le aparece a quien la tenga en su agenda)
    if (task) {
      const m = await pd.meta(), owner = task.ownerId ? m.users.find(u => u.id === Number(task.ownerId)) : null;
      const u = toUtc(task.date, task.time, tz);
      await pd.addActivity({ subject: String(task.subject || "").trim().slice(0, 140) || `${TYPE_LABEL[task.type]} · ${s.name}`, type: task.type, dueDate: u.date, dueTime: u.time, orgId: rec.orgId, leadId: lead.id, personId, ownerId: owner?.id || user.pdUserId });
      done.push({ label: `${TYPE_LABEL[task.type]} el ${nice(task.date)}${task.time ? " a las " + task.time : ""} para ${owner && owner.id !== user.pdUserId ? owner.name : "vos"}`, url: leadUrl });
    }
    const fresh = await checkSchool(id, { force: true }).catch(() => getMatch(id));
    setMatch(id, { ...fresh, confirmed: true, auto: false, ownerId: fresh.ownerId || user.pdUserId, leadId: lead.id });
    done.push(...warnings.map(label => ({ label, warn: true })));
    return { ok: true, done, warnings, leadUrl, orgUrl, found, school: schoolSummary(s), created: !open.length, lead: { id: lead.id, title: lead.title || s.name, ownerId: user.pdUserId, url: leadUrl, created: !open.length } };
  }).then(async r => {
    // prospecto nuevo (o datos de «Enriquecer» que no se pudieron guardar porque todavía no estaba en Pipedrive): Enriquecer
    // completa los campos vacíos del prospecto y deja la nota de datos en él (con tope de tiempo)
    const e = r.created ? null : await getEnrich(id).catch(() => null);
    if (r.created || (e && !e.note?.saved)) { const n = r.done.length; await enrichNewLead(id, user, r.done, e?.by || ""); r.school = schoolSummary(byId.get(id)); if (r.done.length > n) r.enriched = true; }
    return r;
  });
}

// ---------- prospecto → trato desde la ficha: conversión de Pipedrive (pasan notas y actividades), en el embudo del país
export async function convertToDeal(id, user, { leader = false, country: chosen = "" } = {}) {
  const s = byId.get(id); if (!s) throw bad("Colegio inexistente", 404);
  return withLock("convert:" + id, async () => {
    const rec = getMatch(id) || {};
    if (rec.status === "open" && rec.openDealId) throw bad("Ya tiene un trato abierto.", 409);
    let lead = null;
    const lid = s.leadId || rec.leadId || null;
    if (lid) lead = (await pd.leadsByIds([lid], user.pdUserId).catch(() => []))[0] || null;
    if ((!lead || lead.archived) && rec.orgId) {
      const open = await leadsHere(s, rec.orgId).catch(e => { throw bad(`No pude revisar los prospectos en Pipedrive (${e.message}).`, 502); });
      lead = open.find(l => l.ownerId === user.pdUserId) || open.find(l => !l.ownerId) || open[0] || null;
    }
    if (!lead || lead.archived) throw bad("No encontré un prospecto abierto para convertir.", 404);
    if (lead.ownerId && lead.ownerId !== user.pdUserId && !canLead(leader, { id: lead.ownerId })) {
      const m = await pd.meta().catch(() => ({ users: [] }));
      throw bad(`El prospecto es de ${m.users.find(u => u.id === lead.ownerId)?.name || "otra persona"} en Pipedrive: hablalo con esa persona.`, 403);
    }
    const country = s.country || countryFromOpt(lead.paisOpt) || (MARKETS[chosen] ? chosen : "") || phoneCountry(s.phone, lead.phone);
    const mk = market(country), done = [];
    // un colegio de la base cuyo prospecto no tiene organización: primero la organización (a tu nombre), así el trato la lleva
    let newOrg = null;
    if (s.leadVia && !lead.orgId && !rec.orgId && user.pdUserId) {
      newOrg = await pd.createOrganization({ name: s.name, website: s.web, ownerId: user.pdUserId, address: { value: [s.addr, s.city, s.country].filter(Boolean).join(", "), locality: s.city, country: s.country } });
      await pd.updateLead(lead.id, { organization_id: newOrg.id });
      done.push({ label: "Organización creada en Pipedrive a tu nombre", url: `${pd.PD_WEB}/organization/${newOrg.id}` });
    }
    const { dealId } = await pd.convertLead(lead.id, { stageId: mk.stage });
    const url = `${pd.PD_WEB}/deal/${dealId}`;
    done.push({ label: `Trato abierto en el embudo ${MARKETS[country] ? country : "LatAm"}`, url });
    if (!MARKETS[country]) done.push({ label: "No supe el país: el trato quedó en el embudo LatAm. Revisalo en Pipedrive.", warn: true });
    done.push({ label: "Las notas y actividades del prospecto pasaron al trato" });
    const orgId = lead.orgId || rec.orgId || newOrg?.id || null;
    if (s.leadOnly && orgId) { s.leadOnly = false; s.pdOrgId = orgId; }
    if (orgId) await checkSchool(id, { org: { id: orgId, name: rec.orgName || newOrg?.name || s.name, ownerId: lead.ownerId || user.pdUserId } }).catch(() => null);
    leadView(s);
    const cur = getMatch(id) || {};
    if (cur.status !== "open") setMatch(id, { ...cur, status: "open", detail: "Trato abierto (desde el prospecto)", openDealId: dealId, openDealOwnerId: lead.ownerId || user.pdUserId, openDealOwner: signer(user), confirmed: true, auto: false });
    setMatch(id, { ...getMatch(id), leadId: null });
    return { ok: true, dealId, url, done, school: schoolSummary(s) };
  });
}

// ---------- tratos desde la ficha: propuesta enviada, otra etapa de su embudo, ganado o perdido (solo tratos abiertos).
// El dueño del trato (o un líder) lo controla server.js antes de llamar; acá se valida la etapa y queda una nota en el trato.
// Solo tratos de venta de la organización del colegio: los de clientes y los de otra organización no.
export async function dealAction(id, deal, user, b = {}) {
  const s = byId.get(id), orgId = s && !s.leadOnly ? getMatch(id)?.orgId : null;
  if (!orgId || Number(deal.org_id) !== Number(orgId)) throw bad("Ese trato no es de la organización de este colegio.");
  if (CLIENT_PIPES.includes(Number(deal.pipeline_id))) throw bad("Ese trato es de clientes: cambialo en Pipedrive.", 409);
  if (deal.status !== "open") throw bad("Ese trato ya está cerrado en Pipedrive.", 409);
  const m = await pd.meta(), from = m.stages[deal.stage_id] || "", stages = pd.pipeStages(m, deal.pipeline_id), at = sid => stages.findIndex(x => x.id === sid);
  let body, label;
  if (b.action === "stage" || b.action === "proposal") {
    const st = b.action === "proposal" ? stages.find(x => x.id === pd.proposalStage(m, deal.pipeline_id)) : stages.find(x => x.id === Number(b.stageId));
    if (!st) throw bad(b.action === "proposal" ? "Ese embudo no tiene etapa de propuesta enviada." : "Esa etapa no es del embudo del trato.");
    if (st.id === deal.stage_id) throw bad(`El trato ya está en ${st.name}.`, 409);
    // «Propuesta enviada» solo avanza: si el trato ya pasó esa etapa, no lo manda para atrás
    if (b.action === "proposal" && at(deal.stage_id) > at(st.id)) throw bad(`El trato ya está en ${from || "una etapa posterior"}, después de ${st.name}.`, 409);
    body = { stage_id: st.id }; label = at(st.id) < at(deal.stage_id) ? `Volvió a ${st.name}` : `Pasó a ${st.name}`;
  } else if (b.action === "won") { body = { status: "won" }; label = "Ganado"; }
  else if (b.action === "lost") {
    if (!LOST_REASONS.includes(b.reason)) throw bad("Elegí el motivo de pérdida.");
    body = { status: "lost", lost_reason: b.reason }; label = `Perdido: ${b.reason.replace(/\s+/g, " ")}`;
  } else throw bad("Acción inválida.");
  await pd.updateDeal(deal.id, body);
  const url = `${pd.PD_WEB}/deal/${deal.id}`, done = [{ label: `${deal.title || "Trato"} · ${label}`, url }];
  await pd.addNote({ content: `<b>${esc(label)}</b>${from ? `<br>Estaba en ${esc(from)}` : ""}<br><br><i>Cambiado por ${esc(signer(user))} desde OrderBrain SDR</i>`, dealId: deal.id, orgId: deal.org_id || undefined })
    .then(() => done.push({ label: "Nota en el trato" }), () => done.push({ label: "No pude dejar la nota en el trato.", warn: true }));
  await checkSchool(id, { force: true }).catch(() => {});
  return { ok: true, done, school: schoolSummary(s) };
}

// ---------- archivar en la app (lib/archive.js). En Pipedrive solo lo tuyo o lo libre: el prospecto abierto se archiva
// con una nota y la organización lleva la nota. Lo de otra persona no se toca (se avisa). by: nombre del perfil.
const archNote = (title, a, by) => `<b>${esc(title)}</b><br>Motivo: ${esc(a.reason)}${a.text ? `<br>Caso: ${esc(a.text).replace(/\n/g, "<br>")}` : ""}<br><br><i>${esc(by)} desde OrderBrain SDR</i>`;
export async function archiveSchool(id, user, { leader = false, by = "", reason, text = "" } = {}) {
  const s = byId.get(id); if (!s) throw bad("Colegio inexistente", 404);
  text = String(text || "").replace(/\s+/g, " ").trim().slice(0, 500);
  return withLock("archive:" + id, async () => {
    const was = await refreshArchived(id);
    const cur = s.leadOnly ? getMatch(id) || {} : await checkSchool(id).catch(() => getMatch(id) || {});
    const eff = effMatch(s) || cur;
    const err = archiveError({ status: eff.status, dealOwner: cur.openDealOwnerId, me: user.pdUserId, leader, archived: !!was, reason, text });
    if (err) throw bad(err.msg, err.status);
    const pdErr = e => bad(`No pude revisar Pipedrive (${e.message}). Probá de nuevo.`, 502);
    const orgId = s.leadOnly ? null : cur.orgId || null;
    const leads = s.leadOnly ? await pd.leadsByIds([s.leadId], user.pdUserId).catch(e => { throw pdErr(e); }) : orgId ? await leadsHere(s, orgId).catch(e => { throw pdErr(e); }) : [];
    // de un prospecto sin organización hay que saber de quién es (si no, solo un líder lo archiva)
    if (s.leadOnly && !leads.length && leader !== true) throw bad("No pude revisar el prospecto en Pipedrive. Probá de nuevo.", 502);
    const org = orgId ? (await pd.orgsByIds([orgId]).catch(e => { throw pdErr(e); }))[0] || null : null;
    const plan = archivePlan({ leads, org, me: user.pdUserId, ownerId: s.leadOnly ? null : cur.ownerId }), a = { reason, text }, done = [], leadIds = [];
    const m = plan.otherOwner ? await pd.meta().catch(() => ({ users: [] })) : null, uname = uid => m?.users.find(u => u.id === uid)?.name || "otra persona";
    // lo de otra persona (organización o prospecto) solo lo archiva un líder (de un equipo: si es de su gente): el archivo vale para todo el equipo
    const blocked = plan.otherOwners.find(o => !canLead(leader, { id: o })) || null;
    const err2 = archiveError({ status: eff.status, dealOwner: cur.openDealOwnerId, me: user.pdUserId, leader, othersOwner: blocked && uname(blocked), othersId: blocked, reason, text });
    if (err2) throw bad(err2.msg, err2.status);
    for (const l of plan.archive) {
      try {
        await pd.updateLead(l.id, { is_archived: true }); leadIds.push(l.id);
        done.push({ label: "Prospecto archivado en Pipedrive", url: `${pd.PD_WEB}/leads/inbox/${l.id}` });
        await pd.addNote({ content: archNote("Archivado", a, `Archivado por ${by || signer(user)}`), leadId: l.id }).then(() => done.push({ label: "Nota en el prospecto" }), () => done.push({ label: "No pude dejar la nota en el prospecto.", warn: true }));
      } catch (e) { done.push({ label: `No pude archivar el prospecto en Pipedrive (${e.message}).`, warn: true }); }
    }
    for (const l of plan.others) done.push({ label: `El prospecto es de ${uname(l.ownerId)}: en Pipedrive no se tocó, quedó archivado solo en la app.`, warn: true });
    if (plan.orgNote) await pd.addNote({ content: archNote("Archivado", a, `Archivado por ${by || signer(user)}`), orgId: org.id })
      .then(() => done.push({ label: "Nota en la organización", url: `${pd.PD_WEB}/organization/${org.id}` }), () => done.push({ label: "No pude dejar la nota en la organización.", warn: true }));
    else if (plan.orgOthers) done.push({ label: `La organización es de ${uname(org.ownerId)}: no le dejé nota, quedó archivado solo en la app.`, warn: true });
    const rec = await setArchived(id, { by: String(user.email || "").toLowerCase(), byName: by || signer(user), at: new Date().toISOString(), reason, text, leadIds, orgId: plan.orgNote ? org.id : null });
    done.unshift({ label: `Archivado: ${reason}` });
    return { ok: true, done, archive: rec, school: schoolSummary(s) };
  });
}
export async function unarchiveSchool(id, user, { leader = false, by = "" } = {}) {
  const s = byId.get(id); if (!s) throw bad("Colegio inexistente", 404);
  return withLock("archive:" + id, async () => {
    const rec = await refreshArchived(id);
    if (!rec) throw bad("No está archivado.", 409);
    // también lo desarchiva quien lo tiene hoy en Pipedrive (la organización o el prospecto son suyos)
    const me = user.pdUserId, owner = leader === true || canUnarchive(rec, user.email, leader) || !me ? false : s.leadOnly ? (await pd.leadsByIds([s.leadId], me).catch(() => []))[0]?.ownerId === me
      : await checkSchool(id).catch(() => getMatch(id) || {}).then(async c => Number(c?.ownerId) === me || (!!c?.orgId && (await leadsHere(s, c.orgId).catch(() => [])).some(l => l.ownerId === me)));
    if (!canUnarchive(rec, user.email, leader, owner)) throw bad(`Lo archivó ${rec.byName || "otra persona"}: lo desarchiva esa persona, quien lo tiene en Pipedrive o un líder.`, 403);
    const done = [], who = `Desarchivado por ${by || signer(user)}`;
    for (const lid of rec.leadIds || []) {
      try {
        await pd.updateLead(lid, { is_archived: false });
        done.push({ label: "Prospecto desarchivado en Pipedrive", url: `${pd.PD_WEB}/leads/inbox/${lid}` });
        await pd.addNote({ content: archNote(`Desarchivado (lo había archivado ${rec.byName || "otra persona"})`, rec, who), leadId: lid }).then(() => done.push({ label: "Nota en el prospecto" }), () => done.push({ label: "No pude dejar la nota en el prospecto.", warn: true }));
      } catch (e) { done.push({ label: `No pude desarchivar el prospecto en Pipedrive (${e.message}): hacelo desde Pipedrive.`, warn: true }); }
    }
    // la organización que llevó la nota de archivado lleva la de desarchivado (si sigue siendo tuya o libre)
    if (rec.orgId) {
      const o = (await pd.orgsByIds([rec.orgId]).catch(() => []))[0];
      if (o && archivePlan({ org: o, me: user.pdUserId }).orgNote) await pd.addNote({ content: archNote(`Desarchivado (lo había archivado ${rec.byName || "otra persona"})`, rec, who), orgId: o.id }).then(() => done.push({ label: "Nota en la organización", url: `${pd.PD_WEB}/organization/${o.id}` }), () => done.push({ label: "No pude dejar la nota en la organización.", warn: true }));
    }
    await setArchived(id, null);
    done.unshift({ label: "Desarchivado" });
    return { ok: true, done, school: schoolSummary(s) };
  });
}

// ---------- agregar un decisor desde la ficha: persona en la organización del colegio (o en el prospecto si no tiene
// organización), a nombre de quien la carga. En lo ajeno no (salvo un líder).
export async function addDecisor(id, user, leader, c = {}) {
  const s = byId.get(id); if (!s) throw bad("Colegio inexistente", 404);
  const clean = (v, n) => String(v || "").replace(/\s+/g, " ").trim().slice(0, n);
  const name = clean(c.name, 80), role = clean(c.role, 60), phone = clean(c.phone, 40), email = clean(c.email, 120).toLowerCase();
  if (!name || !okName(name)) throw bad("Escribí el nombre del decisor.");
  if (phone && !okPhone(phone)) throw bad("Revisá el teléfono: tiene que tener al menos 8 dígitos.");
  if (email && !okEmail(email)) throw bad("Revisá el mail.");
  if (!user.pdUserId) throw bad("Tu usuario no está vinculado a Pipedrive: no puedo crear el contacto a tu nombre.", 403);
  const pre = await settleExisting(id, user);
  const label = personLabel(name, role), done = [...pre.done];
  if (s.leadOnly) {
    const lead = (await pd.leadsByIds([s.leadId], user.pdUserId))[0];
    if (!lead) throw bad("No encontré el prospecto en Pipedrive.", 404);
    if (lead.ownerId && lead.ownerId !== user.pdUserId && !canLead(leader, { id: lead.ownerId })) throw bad("Ese prospecto es de otra persona en Pipedrive: no le podés agregar contactos.", 403);
    const p = await pd.addPerson({ name: label, phone, email, ownerId: user.pdUserId });
    const url = `${pd.PD_WEB}/person/${p.id}`;
    done.push({ label: `Contacto ${name}`, url });
    // el prospecto tiene una sola persona: si ya tenía, el decisor queda anotado en el prospecto
    if (!s.personId) { await pd.updateLead(s.leadId, { person_id: p.id }); s.personId = p.id; s.personName = label; done.push({ label: "Vinculado al prospecto" }); }
    else { await pd.addNote({ content: `<b>Decisor</b><br>${esc(contactLine({ name, role, phone, email }))}<br><a href="${url}">Ver contacto</a><br><br><i>Cargado por ${esc(signer(user))} desde OrderBrain SDR</i>`, leadId: s.leadId }); done.push({ label: "Anotado en el prospecto (ya tenía un contacto)" }); }
    return { ok: true, done, person: { id: p.id, name: label, phone, email } };
  }
  // sin organización todavía: se crea a tu nombre (como al registrar o comentar)
  const rec = await ensureOrg(id, user.pdUserId);
  if (rec.ownerId && rec.ownerId !== user.pdUserId && !canLead(leader, { id: rec.ownerId })) throw bad(`La organización es de ${rec.ownerName || "otra persona"} en Pipedrive: no le podés agregar contactos.`, 403);
  if (rec.created) done.push({ label: "Organización creada a tu nombre", url: `${pd.PD_WEB}/organization/${rec.orgId}` });
  const p = await pd.addPerson({ name: label, orgId: rec.orgId, phone, email, ownerId: user.pdUserId });
  done.push({ label: `Contacto ${name} en ${rec.orgName || s.name}`, url: `${pd.PD_WEB}/person/${p.id}` });
  return { ok: true, done, person: { id: p.id, name: label, phone, email }, school: schoolSummary(s) };
}
