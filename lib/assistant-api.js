// Asistente (lib/ai.js): la charla, la exportación a Google Sheets (apagada) y las propuestas firmadas que se confirman
// (la escritura real en Pipedrive pasa acá, de uso único) o se descartan. server.js la monta con mountAssistant(app, deps).
import * as pd from "./pipedrive.js";
import { byId } from "./store.js";
import * as TM from "./teams.js";
import * as sales from "./sales.js";
import * as ai from "./ai.js";
import { toUtc } from "./time.js";
import { createSheet, sheetsDirect } from "./sheets-export.js";

export function mountAssistant(app, { auth, liveUser, wrap }) {
  // ---------- asistente
  app.post("/api/chat", auth, wrap(async (req, res) => {
    const messages = Array.isArray(req.body.messages) ? req.body.messages : [];
    if (!messages.length) return res.status(400).json({ error: "Mensaje vacío" });
    res.json(await ai.chat({ user: await liveUser(req.session.user), messages, focus: byId.has(req.body.focus) ? req.body.focus : null, tz: req.tz }));
  }));
  // tablas del asistente → hoja de Google Sheets directo. Apagado mientras no esté el cliente OAuth de Google y la persona no
  // haya conectado su Google con drive.file: el panel copia la tabla y abre sheets.new (lib/sheets-export.js)
  app.get("/api/sheets/status", auth, wrap(async (req, res) => res.json({ direct: await sheetsDirect(req.session.user.email) })));
  app.post("/api/sheets/export", auth, wrap(async (req, res) => res.json(await createSheet(req.session.user.email, req.body?.table))));
  app.post("/api/proposals/confirm", auth, wrap(async (req, res) => {
    const token = String(req.body?.id || "");
    const p = ai.getProposal(token);
    if (!p) return res.status(404).json({ error: "La propuesta venció. Pedila de nuevo en el chat." });
    if (p.requestedBy !== req.session.user.email) return res.status(403).json({ error: "Esta propuesta es de otra persona." });
    const claim = await ai.claimProposal(token);
    if (claim !== true) {
      if (claim.state === "done") return res.json({ ok: true, already: true, orgUrl: claim.orgUrl || pd.PD_WEB });
      if (claim.state === "discarded") return res.status(410).json({ error: "Esta propuesta se descartó. Pedila de nuevo en el chat." });
      return res.status(409).json({ error: "Se está guardando. Esperá unos segundos y actualizá." });
    }
    let out;
    try { out = await confirmProposal(p, req); }
    catch (e) { await ai.releaseProposal(token); throw e; }
    await ai.finishProposal(token, "done", out.orgUrl);
    // la nota o la actividad nueva tiene que verse ya en el Historial de esa ficha
    await sales.dropTimeline(out.schoolId || p.schoolId || null);
    res.json(out);
  }));
  async function confirmProposal(p, req) {
    const user = await liveUser(req.session.user);
    let orgId = p.orgId, dealId = p.dealId, leadId = null, sid = p.schoolId, rec = null;
    // un colegio de la base sin organización: antes de crear nada, ¿ya está en Pipedrive? (puede quedar en su prospecto)
    if (sid && byId.has(sid)) await sales.settleExisting(sid, user).catch(e => { if (e.code === "pd_maybe") e.message = "Ya hay algo parecido en Pipedrive: abrí la ficha del colegio y elegí si es alguno de esos (o si es otro colegio)."; throw e; });
    const vs = sid && byId.get(sid);
    if (vs?.leadOnly) leadId = vs.leadId; // ficha de un prospecto sin organización: se escribe en el prospecto
    else {
      if (!orgId && !sid) {
        const hits = await pd.searchOrganizations(p.colegio, 5);
        const exact = hits.find(h => pd.norm(h.name) === pd.norm(p.colegio));
        // sin ficha ni organización con ese nombre: si hay un prospecto o un trato que se llama así, no se crea otra
        if (!exact) { const named = await sales.namedInPipedrive(p.colegio); if (named.length) throw Object.assign(new Error(`Ya hay algo con ese nombre en Pipedrive (${named.map(x => `«${x.title}»`).join(", ")}). Abrilo desde la búsqueda y registralo en su ficha.`), { status: 409 }); }
        orgId = exact ? exact.id : (await pd.createOrganization({ name: p.colegio, ownerId: user.pdUserId })).id;
      }
      // la ficha de esa organización (el colegio cruzado o la de Pipedrive): su trato abierto o su prospecto
      if (orgId) sid = (await sales.openRecord("org", orgId).catch(() => null))?.id || null;
      if (sid) { rec = await sales.ensureOrg(sid, user.pdUserId); orgId = rec.orgId; dealId = dealId || rec.openDealId || null; }
    }
    // cada uno trabaja lo suyo: una organización de otra persona solo admite agendarle una demo (o lo hace un líder: de un
    // equipo, si es de su gente)
    if (orgId && !(p.kind === "activity" && p.type === "meeting") && user.leads !== true) {
      const o = (await pd.orgsByIds([orgId]))[0];
      if (o?.ownerId && user.pdUserId && o.ownerId !== user.pdUserId && !TM.canLead(user.leads, { id: o.ownerId })) throw Object.assign(new Error("Esa organización es de otra persona en Pipedrive."), { status: 409 });
    }
    const by = sales.signer(user), done = [], warns = [];
    // sin trato abierto, como un contacto: al prospecto abierto tuyo o libre, o a uno nuevo a tu nombre (con su organización)
    const leadR = !leadId && !dealId && sid && rec ? await sales.workLead(sid, rec, user, done, warns) : null;
    if (leadR) leadId = leadR.id;
    const target = leadR ? { orgId, leadId, personId: leadR.personId || undefined } : leadId ? { leadId } : { orgId, dealId };
    if (p.kind === "activity") {
      const u = toUtc(p.date, p.time, p.tz || req.tz);
      await pd.addActivity({ subject: p.subject, type: p.type, dueDate: u.date, dueTime: u.time, durationMin: p.durationMin, ...target, ownerId: p.owner.id, note: p.note ? `${p.note}\n\n(Agendado por ${by} desde OrderBrain SDR)` : `Agendado por ${by} desde OrderBrain SDR` });
      if (p.type === "meeting") await sales.demoReminder({ name: (sid && byId.get(sid)?.name) || vs?.name || p.colegio, ...target, date: p.date, time: p.time, tz: p.tz || req.tz, user }).catch(e => console.warn("Recordatorio de demo:", e.message));
    } else {
      const esc = s => String(s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
      const html = `<b>Nota desde el asistente</b><br>${esc(p.text).replace(/\n/g, "<br>")}<br><br><i>Cargado por ${esc(by)} desde OrderBrain SDR</i>`;
      await pd.addNote({ content: html, ...target }).catch(e => { if (!leadR) throw e; return pd.addNote({ content: html, leadId }); });
    }
    if (leadR?.created) { await sales.markWorked(sid, rec).catch(() => {}); await sales.enrichNewLead(sid, user, done).catch(() => {}); }
    for (const w of warns) done.push({ label: w, warn: true });
    const where = leadId ? sales.whereOf({ lead: leadR || { id: leadId, title: vs?.name || p.colegio, url: `${pd.PD_WEB}/leads/inbox/${leadId}` } }) : sales.whereOf({ dealId, orgId, orgName: (sid && byId.get(sid)?.name) || p.colegio });
    return { ok: true, orgUrl: leadId ? `${pd.PD_WEB}/leads/inbox/${leadId}` : `${pd.PD_WEB}/organization/${orgId}`, done, ...where, schoolId: sid || null };
  }
  app.post("/api/proposals/discard", auth, wrap(async (req, res) => {
    const token = String(req.body?.id || "");
    if (ai.getProposal(token)?.requestedBy === req.session.user.email && (await ai.claimProposal(token)) === true) await ai.finishProposal(token, "discarded");
    res.json({ ok: true });
  }));
}
