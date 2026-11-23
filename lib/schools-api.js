// Rutas de la ficha de un colegio (/api/check y /api/schools/:id/…): cruce, «Antes de crear», fusionar, Registrar,
// comentario, mail, prospecto, trato, dirección, archivar, decisor, fotos, estudio, Enriquecer, Historial, sedes y
// borradores (la lógica en lib/sales.js). server.js la monta con mountSchools(app, deps) en el mismo lugar de antes.
import * as pd from "./pipedrive.js";
import { bump, byId, getProfile, getStudy, once, release, setStudy, withLock } from "./store.js";
import { research, studyEnabled, studyToHtml } from "./study.js";
import * as sales from "./sales.js";
import * as sessions from "./sessions.js";
import * as ai from "./ai.js";
import { googleEnabled, photosFor } from "./photos.js";
import { TYPE_LABEL } from "./config.js";
import { composeMessage, templates } from "./playbook.js";
import * as gmail from "./gmail.js";
import * as pdtoken from "./pdtoken.js";
import * as pdmcp from "./pdmcp.js";

export function mountSchools(app, { MAIL_PER_HOUR, auth, gmailName, gmailPick, gmailProven, leadScopeFor, mailSig, meName, ownActivity, ownDeal, pdProof, pdProven, schoolParam, signName, wrap }) {
  // Revisa varios colegios contra Pipedrive (de a 3 en paralelo).
  app.post("/api/check", auth, wrap(async (req, res) => {
    const ids = (req.body.ids || []).filter(id => byId.has(id)).slice(0, 300);
    const out = {}; let i = 0;
    async function worker() { while (i < ids.length) { const id = ids[i++]; try { await sales.checkSchool(id, { force: !!req.body.force }); out[id] = sales.schoolSummary(byId.get(id)); } catch (e) { out[id] = { error: e.message }; } } }
    await Promise.all([worker(), worker(), worker()]);
    res.json(out);
  }));

  app.get("/api/schools/:id", auth, schoolParam, wrap(async (req, res) => {
    res.json(await sales.schoolDetail(req.params.id, { force: req.query.refresh === "1", user: req.session.user, tz: req.tz }));
  }));
  app.post("/api/schools/:id/match", auth, schoolParam, wrap(async (req, res) => {
    const { orgId, orgName } = req.body || {};
    if (orgId !== null && !(Number(orgId) > 0)) return res.status(400).json({ error: "Falta la organización." });
    if (orgId === null) sales.unlinkSchool(req.params.id);
    else await sales.linkSchool(req.params.id, { id: Number(orgId), name: String(orgName || "") });
    res.json(await sales.schoolDetail(req.params.id, { user: req.session.user, tz: req.tz }));
  }));
  // Lo que ya hay en Pipedrive y se parece al colegio (sales.settleExisting): «Es este» { key } lo usa (prospecto, trato u
  // organización); «Es otro colegio» { none: true } lo descarta y lo próximo que se registre crea lo suyo.
  app.post("/api/schools/:id/existing", auth, schoolParam, wrap(async (req, res) => {
    const b = req.body || {}, user = req.session.user;
    const r = b.none ? await sales.dismissExisting(req.params.id) : await sales.useExisting(req.params.id, user, String(b.key || ""), { take: b.take === true });
    res.json({ ...r, detail: await sales.schoolDetail(req.params.id, { user, tz: req.tz }) });
  }));
  // «Es esta» → «¿Estás seguro?»: lo que dice Pipedrive de esa organización, para comparar con el colegio
  app.get("/api/schools/:id/org/:orgId", auth, schoolParam, wrap(async (req, res) => res.json(await sales.orgPreview(req.params.id, req.params.orgId, req.session.user))));
  // después de vincular: otras organizaciones que parecen el mismo colegio (lib/merge.js) y si podés fusionar cada una
  app.get("/api/schools/:id/dupes", auth, schoolParam, wrap(async (req, res) => res.json(await sales.dupesFor(req.params.id, req.session.user, { leader: await leadScopeFor(req.session.user.email) }))));
  // «¿Querés fusionar?»: las elegidas pasan a la vinculada (keepId) con la fusión de Pipedrive. Controles en sales.mergeOrgs.
  app.post("/api/schools/:id/merge-orgs", auth, schoolParam, wrap(async (req, res) => {
    const b = req.body || {}, user = req.session.user;
    res.json(await sales.mergeOrgs(req.params.id, user, { keepId: b.keepId, mergeIds: b.mergeIds, leader: await leadScopeFor(user.email), by: await signName(user), tz: req.tz }));
  }));
  app.get("/api/schools/:id/next", auth, schoolParam, (req, res) => res.json(sales.nextFor(req.params.id, req.query.outcome, req.query.channel, req.tz) || {}));
  app.post("/api/schools/:id/log", auth, schoolParam, wrap(async (req, res) => {
    const body = { ...(req.body || {}) };
    // si la actividad a completar ya no está en Pipedrive, el contacto se registra igual
    const gone = !!body.completeActivityId && !(await ownActivity(req.session.user, body.completeActivityId, { missingOk: true }));
    if (gone) delete body.completeActivityId;
    const r = await sales.logContact(req.params.id, req.session.user, body, req.tz);
    if (gone) r.done.push({ label: "La actividad ya no está en Pipedrive.", warn: true });
    const o = sales.OUTCOMES.find(x => x.id === body.outcome);
    await inSession(req, r, sessions.contactStep(req.body?.session?.ref, { channel: body.channel, outcome: body.outcome, connected: o?.connected, next: r.next, demo: r.demo, contact: body.contact, ...stepBy(req) }));
    res.json(r);
  }));
  // Contacto o comentario hecho dentro de una sesión de trabajo ({ session: { id, ref } }): queda anotado en la sesión de quien lo
  // registró, después de guardarlo en Pipedrive. Si el colegio está en otras sesiones abiertas suyas (o se registró sin sesión),
  // queda anotado ahí como hecho fuera de la sesión (r.sessions). Si no se puede anotar, el registro igual vale (se avisa).
  const stepBy = req => ({ by: req.session.user.email, byName: req.session.user.name || sales.signer(req.session.user), schoolId: req.params.id });
  async function inSession(req, r, step) {
    const ss = req.body?.session, email = req.session.user.email, sid = ss?.id && ss.ref ? String(ss.id) : null;
    try {
      if (sid) { const v = await sessions.recordFor(email, sid, step); if (v) r.session = v; }
      const others = await sessions.recordOutside(email, req.params.id, step, { except: sid });
      if (others.length) r.sessions = others;
    } catch (e) { console.warn("No se pudo anotar en la sesión:", e.message); r.done.push({ label: "No pude anotarlo en tu sesión de trabajo (en Pipedrive quedó guardado).", warn: true }); }
  }

  // Mail desde la ficha: sale de la casilla de Pipedrive de quien escribe (lib/pdtoken.js + lib/pdmcp.js) o, si no conectó
  // Pipedrive, de su Gmail (lib/gmail.js); el registro en Pipedrive lo hace sales.sendMail.
  // key: la que arma el navegador para cada envío; si el pedido se repite (la red), no se manda dos veces.
  // Antes de la cuenta de 5 s, el modal pregunta si se puede (archivado, cliente, de otra persona): así no se ofrece «Enviar»
  // donde después va a fallar. No escribe nada. El envío vuelve a comprobar todo.
  app.get("/api/schools/:id/mail/check", auth, schoolParam, wrap(async (req, res) => {
    try { await sales.mailGuard(req.params.id, req.session.user); res.json({ ok: true }); }
    catch (e) { if ((e.status || 500) >= 500) throw e; res.json({ ok: false, error: e.message, ...(e.code ? { code: e.code } : {}), ...(Array.isArray(e.candidates) ? { candidates: e.candidates } : {}) }); }
  }));
  // Por dónde sale: via del navegador («pipedrive» | «gmail», lo que mostró el modal) o, sin decirlo, Pipedrive si está
  // conectado. Cada vía exige su conexión (la de la persona de la sesión) y que esta sesión haya probado ser esa persona.
  async function pickVia(req) {
    const u = req.session.user, want = req.body?.via;
    const pdOn = pdtoken.enabled() && await pdtoken.connected(u.email, u).catch(() => null);
    if (pdOn === null && want !== "gmail") return { status: 503, error: "No pude leer tu conexión con Pipedrive. Probá de nuevo en unos segundos." };
    const via = want === "gmail" ? "gmail" : want === "pipedrive" || pdOn ? "pipedrive" : "gmail";
    if (via === "pipedrive") {
      if (!pdOn) return { error: "Conectá tu Pipedrive para enviar desde acá.", code: "pd_missing" };
      if (!pdProven(req)) return { error: "Confirmá que sos vos: pegá de nuevo tu token de Pipedrive.", code: "pd_reauth" };
    } else if (!gmailProven(req)) return { error: "Conectá tu Gmail en este dispositivo.", code: "gmail_reauth" };
    return { via };
  }
  const mailVia = (req, res, next) => pickVia(req).then(({ status = 409, ...r }) => { if (r.error) return res.status(status).json(r); req.mailVia = r.via; next(); }, next);
  app.post("/api/schools/:id/mail", auth, mailVia, schoolParam, wrap(async (req, res) => {
    const user = req.session.user, b = req.body || {}, via = req.mailVia;
    const k = /^[A-Za-z0-9_-]{8,64}$/.test(b.key || "") ? `mail:${user.email}:${b.key}` : null;
    if (k && !(await once(k, 1800))) return res.status(409).json({ error: "Ese mail ya se mandó (o se está mandando). Mirá Historial antes de mandarlo de nuevo.", code: "mail_dup" });
    if ((await bump(`mailrate:${user.email}`, 3600)) > MAIL_PER_HOUR) { if (k) await release(k); return res.status(429).json({ error: `Llegaste a ${MAIL_PER_HOUR} mails en una hora desde la app. Esperá un rato o usá «Abrir en Gmail».` }); }
    try {
      let doneId = Number(b.completeActivityId) || null;
      if (doneId && !(await ownActivity(user, doneId, { missingOk: true }))) doneId = null;
      const name = await gmailName(user), sig = await mailSig(req, via);
      // Pipedrive: el borrador ligado al prospecto o trato (lo resuelve sendMail antes de mandar), con la firma elegida
      const send = via === "pipedrive" ? m => pdtoken.send(user.email, user, { ...m, signature: sig })
        : m => gmail.send(user.email, { to: m.to, subject: m.subject, text: m.text, fromName: name, signature: gmailPick(sig) });
      const r = await sales.sendMail(req.params.id, user, { to: b.to, subject: b.subject, text: b.text, completeActivityId: doneId }, req.tz, { send, by: name, via });
      // el mail cuenta como contacto en la sesión de trabajo (y en las otras abiertas que tengan este colegio)
      if (r && Array.isArray(r.done)) await inSession(req, r, sessions.contactStep(b.session?.ref, { channel: "mail", outcome: "sent", next: null, ...stepBy(req) }));
      res.json(r);
    } catch (e) {
      // la clave se libera solo si es seguro que no salió (antes de mandar, o Gmail/Pipedrive dijeron que no).
      // sent = "maybe" (red, tiempo o 5xx) o true (salió y falló algo después): no se libera, no se manda dos veces
      if (k && !e.sent) await release(k);
      throw e;
    }
  }));
  // el próximo paso después del mail (no manda nada): una sesión que probó ser la persona (por Pipedrive o Google)
  app.post("/api/schools/:id/mail/next", auth, pdProof, schoolParam, wrap(async (req, res) => {
    const b = req.body || {}, n = b.next, user = req.session.user;
    const next = n && n.type ? { type: String(n.type), date: String(n.date || ""), time: n.time ? String(n.time) : "", ownerId: n.ownerId ? Number(n.ownerId) : undefined, subject: n.subject ? String(n.subject) : "" } : null;
    // mover una actividad pendiente (la automática o una tuya ya agendada) en vez de crear otra; marcar hecha la de la agenda
    let moveId = Number(b.moveActivityId) || null, doneId = Number(b.completeActivityId) || null;
    if (moveId && !(await ownActivity(user, moveId, { missingOk: true }))) moveId = null;
    if (doneId && !(await ownActivity(user, doneId, { missingOk: true }))) doneId = null;
    res.json(await sales.mailNext(req.params.id, user, { mailId: String(b.mailId || ""), next, moveActivityId: moveId, completeActivityId: doneId }, req.tz));
  }));
  // Demo: lo que quedó en el Pipedrive de prueba, en la bandeja de Gmail simulada y en el correo de Pipedrive simulado
  // (borradores creados con createMailDraft y enviados con sendMailDraft) para este colegio (para comprobar el envío)
  if (pd.DEMO) app.get("/api/demo/mail/:id", auth, schoolParam, wrap(async (req, res) => {
    const m = sales.allMatches()[req.params.id] || {}, s = byId.get(req.params.id), where = s.leadOnly ? { leadId: s.leadId } : m.orgId ? { orgId: m.orgId } : null;
    const acts = where ? [...await pd.activities({ ...where, done: true, limit: 50 }), ...await pd.activities({ ...where, done: false, limit: 50 })] : [];
    const notes = where ? await (where.leadId ? pd.notesForLead(where.leadId, 20) : pd.notesForOrg(where.orgId, 20)) : [];
    res.json({ where, activities: acts.map(a => ({ id: a.id, subject: a.subject, type: a.type, done: !!a.done, due: a.due_date, orgId: a.org_id || null, dealId: a.deal_id || null, leadId: a.lead_id || null, personId: a.person_id || null, owner: a.owner_id, note: a.note || "" })),
      notes: notes.map(n => ({ id: n.id, orgId: n.org_id || null, dealId: n.deal_id || null, leadId: n.lead_id || null, personId: n.person_id || null, content: n.content })),
      outbox: gmail.demoOutbox().map(x => ({ id: x.id, at: x.at, from: x.from, to: x.to, bcc: x.bcc, ...gmail.parseMime(x.mime) })),
      pdOutbox: pdmcp.demoOutbox().filter(d => d.from === req.session.user.email).map(d => ({ id: d.id, at: d.at, sent: d.sent, sentAt: d.sentAt || null, from: d.from, to: d.args.to, subject: d.args.subject, body: d.args.body, leadId: d.args.lead_id || null, dealId: d.args.deal_id || null })) });
  }));
  // Comentario suelto: queda como nota en la organización de Pipedrive, sin registrar un contacto.
  app.post("/api/schools/:id/prospect", auth, schoolParam, wrap(async (req, res) => res.json(await sales.createProspect(req.params.id, req.session.user, req.body?.task || null, req.tz))));
  // prospecto → trato (conversión de Pipedrive). Solo el dueño del prospecto o un líder.
  app.post("/api/schools/:id/convert", auth, schoolParam, wrap(async (req, res) => res.json(await sales.convertToDeal(req.params.id, req.session.user, { leader: await leadScopeFor(req.session.user.email), country: String(req.body?.country || "") }))));
  // Comentario y/o tarea para más adelante (para quien registra o para otra persona del equipo), sin registrar un contacto.
  app.post("/api/schools/:id/comment", auth, schoolParam, wrap(async (req, res) => {
    const text = String(req.body?.text || "").trim().slice(0, 5000), t = req.body?.task || null, user = req.session.user;
    const task = t && TYPE_LABEL[t.type] && /^\d{4}-\d{2}-\d{2}$/.test(t.date || "") ? t : null;
    if (t && !task) return res.status(400).json({ error: "Elegí el tipo y el día de la tarea." });
    if (task?.time && !/^\d{2}:\d{2}$/.test(task.time)) return res.status(400).json({ error: "Hora inválida." });
    if (!text && !task) return res.status(400).json({ error: "Escribí el comentario o elegí una tarea." });
    let doneId = Number(req.body?.completeActivityId) || null;
    const gone = !!doneId && !(await ownActivity(user, doneId, { missingOk: true }));
    if (gone) doneId = null;
    const m = await pd.meta(), owner = task?.ownerId ? m.users.find(u => u.id === Number(task.ownerId)) : null;
    if (task?.ownerId && !owner) return res.status(400).json({ error: "Esa persona no está en el equipo." });
    const out = await sales.commentSchool(req.params.id, user, { text, task, owner, doneId, gone, by: await signName(user) }, req.tz);
    await inSession(req, out, sessions.commentStep(req.body?.session?.ref, { next: task ? { ...task, ownerId: owner?.id || user.pdUserId } : null, ...stepBy(req) }));
    res.json(out);
  }));
  // Tratos desde la ficha: { action: "stage", stageId } (propuesta enviada u otra etapa de su embudo), { action: "won" } o { action: "lost", reason }
  app.post("/api/schools/:id/deals/:dealId", auth, schoolParam, wrap(async (req, res) => {
    if (!/^\d+$/.test(req.params.dealId)) return res.status(400).json({ error: "Trato inválido" });
    res.json(await sales.dealAction(req.params.id, await ownDeal(req.session.user, req.params.dealId), req.session.user, req.body || {}));
  }));
  // Archivar en la app (y en Pipedrive solo lo tuyo o lo libre). No clientes ni tratos abiertos de otra persona (salvo un líder).
  // Desarchivar: quien lo archivó o un líder. Las reglas están en lib/archive.js.
  // dirección de la ficha: ver (manual, base o del mapa) y escribirla a mano (también en el prospecto y la organización si son tuyos o libres)
  app.get("/api/schools/:id/address", auth, schoolParam, wrap(async (req, res) => res.json(await sales.addressView(req.params.id))));
  app.post("/api/schools/:id/address", auth, schoolParam, wrap(async (req, res) => res.json(await sales.setAddress(req.params.id, req.session.user, req.body?.addr))));
  app.post("/api/schools/:id/archive", auth, schoolParam, wrap(async (req, res) => {
    const user = req.session.user, b = req.body || {};
    res.json(await sales.archiveSchool(req.params.id, user, { leader: await leadScopeFor(user.email), by: await signName(user), reason: String(b.reason || ""), text: String(b.text || "") }));
  }));
  app.post("/api/schools/:id/unarchive", auth, schoolParam, wrap(async (req, res) => {
    const user = req.session.user;
    res.json(await sales.unarchiveSchool(req.params.id, user, { leader: await leadScopeFor(user.email), by: await signName(user) }));
  }));
  // Agregar un decisor (persona) a la organización del colegio o al prospecto: en lo ajeno solo un líder
  app.post("/api/schools/:id/persons", auth, schoolParam, wrap(async (req, res) => res.json(await sales.addDecisor(req.params.id, req.session.user, await leadScopeFor(req.session.user.email), req.body || {}))));
  app.get("/api/schools/:id/photos", auth, schoolParam, wrap(async (req, res) => {
    res.set("cache-control", "private, max-age=3600");
    // sin web en la base, la que encontró «Enriquecer» (de Pipedrive o de una sede), con su fuente
    const e = byId.get(req.params.id)?.web ? null : await sales.getEnrich(req.params.id).catch(() => null);
    res.json({ photos: await photosFor(req.params.id, { refresh: req.query.refresh === "1", web: e?.web || "", webSrc: e?.webSrc || "" }), google: googleEnabled() });
  }));
  // Estudio de prospección: SOLO cuando alguien lo pide con el botón y confirma el costo (confirm: true). Nunca solo al abrir
  // la ficha ni adelantado en una sesión (gastó US$60 en IA). Pasa por el tope diario (lib/aibudget.js).
  const studying = new Map();
  app.get("/api/schools/:id/study", auth, schoolParam, wrap(async (req, res) => {
    res.json({ study: await getStudy(req.params.id), enabled: studyEnabled(), working: studying.has(req.params.id) });
  }));
  app.post("/api/schools/:id/study", auth, schoolParam, wrap(async (req, res) => {
    const id = req.params.id, force = !!req.body?.refresh;
    if (!force) { const cur = await getStudy(id); if (cur) return res.json({ study: cur }); }
    if (req.body?.confirm !== true) return res.status(409).json({ error: "El estudio usa IA paga: pedilo con el botón.", code: "ai_confirm" });
    // como mucho 2 estudios a la vez por persona y 4 en la instancia: el tope suma el costo recién al terminar, así que muchos
    // seguidos lo pasarían antes de enterarse
    const who = req.session.user?.email || "-", mine = [...studying.values()].filter(x => x.by === who).length;
    if (!studying.has(id) && (mine >= 2 || studying.size >= 4)) return res.status(429).json({ error: mine >= 2 ? "Ya tenés 2 estudios en curso: esperá a que terminen." : "Hay varios estudios en curso: probá en un minuto.", code: "ai_busy" });
    if (!studyEnabled()) return res.status(400).json({ error: "El estudio automático necesita ANTHROPIC_API_KEY en el servidor." });
    if (!studying.has(id)) studying.set(id, Object.assign(withLock("study:" + id, async () => {
      if (!force) { const cur = await getStudy(id); if (cur) return cur; }
      const m = await sales.checkSchool(id).catch(() => null);
      const st = await research(byId.get(id), { context: m ? `Estado en Pipedrive: ${m.detail || "sin datos"}` : "", email: req.session.user?.email });
      await setStudy(id, st);
      return st;
    }).finally(() => studying.delete(id)), { by: who }));
    res.json({ study: await studying.get(id) });
  }));
  app.post("/api/schools/:id/study/note", auth, schoolParam, wrap(async (req, res) => {
    const st = await getStudy(req.params.id);
    if (!st) return res.status(404).json({ error: "Todavía no hay estudio de este colegio." });
    const s = byId.get(req.params.id);
    await sales.settleExisting(req.params.id, req.session.user); // ¿ya está en Pipedrive? (antes de crear la organización)
    if (s.leadOnly) { // prospecto sin organización: el estudio va al prospecto
      await pd.addNote({ content: studyToHtml(s, st), leadId: s.leadId });
      return res.json({ ok: true, orgUrl: `${pd.PD_WEB}/leads/inbox/${s.leadId}` });
    }
    const rec = await sales.ensureOrg(req.params.id, req.session.user.pdUserId);
    // con un prospecto abierto tuyo o libre (y sin trato abierto), en el prospecto y su organización
    const l = await sales.openLeadFor(req.params.id, rec, req.session.user.pdUserId), html = studyToHtml(s, st);
    if (l) await pd.addNote({ content: html, orgId: rec.orgId, leadId: l.id }).catch(() => pd.addNote({ content: html, leadId: l.id }));
    else await pd.addNote({ content: html, orgId: rec.orgId, dealId: rec.openDealId });
    res.json({ ok: true, orgUrl: l ? `${pd.PD_WEB}/leads/inbox/${l.id}` : `${pd.PD_WEB}/organization/${rec.orgId}` });
  }));
  app.get("/api/schools/:id/brief", auth, schoolParam, wrap(async (req, res) => res.json(await ai.brief(req.params.id, { user: req.session.user }))));
  app.get("/api/schools/:id/enrich", auth, schoolParam, wrap(async (req, res) => res.json({ data: await sales.getEnrich(req.params.id) })));
  app.post("/api/schools/:id/enrich", auth, schoolParam, wrap(async (req, res) => res.json(await sales.enrichSchool(req.params.id, req.session.user, (await getProfile(req.session.user.email).catch(() => null))?.name))));
  // Historial completo (de a 50, «Cargar más» con offset) y el resumen para la próxima llamada por reglas; con IA, aparte.
  // refresh=1 («Actualizar») y fresh=1 (recién escribió algo de esta ficha): se vuelve a leer Pipedrive
  app.get("/api/schools/:id/timeline", auth, schoolParam, wrap(async (req, res) => res.json(await sales.timelineFor(req.params.id,
    { user: req.session.user, tz: req.tz, me: await meName(req), offset: req.query.offset, limit: req.query.limit, force: req.query.refresh === "1" || req.query.fresh === "1" }))));
  app.get("/api/schools/:id/call-brief", auth, schoolParam, wrap(async (req, res) => res.json(await sales.callBriefFor(req.params.id, { user: req.session.user, tz: req.tz, me: await meName(req), force: req.query.refresh === "1" }))));
  app.get("/api/schools/:id/history", auth, schoolParam, wrap(async (req, res) => res.json(await sales.historyFor(req.params.id))));
  app.get("/api/schools/:id/sedes", auth, schoolParam, wrap(async (req, res) => res.json(await sales.sedesFor(req.params.id))));
  // Redactar un mensaje: con IA usa el contexto que escribe el SDR + lo que sabe Pipedrive; sin IA, la plantilla de la casa.
  app.post("/api/schools/:id/draft", auth, schoolParam, wrap(async (req, res) => {
    const b = req.body || {}, channel = b.channel === "mail" ? "mail" : "whatsapp", user = req.session.user;
    const p = { channel, purpose: String(b.purpose && b.purpose !== "Mensaje" ? b.purpose : "avanzar un paso: llegar al decisor o agendar una demo").slice(0, 200), contact: String(b.contact || "").slice(0, 80), base: String(b.base || "").slice(0, 3000), context: String(b.context || "").slice(0, 2000) };
    const s = byId.get(req.params.id), me = (await getProfile(user.email).catch(() => null))?.name || sales.signer(user);
    if (!ai.aiEnabled()) return res.json({ ...composeMessage(s, { channel, context: p.context, contact: p.contact, me, base: p.base, ...sales.stateOf(req.params.id) }), mode: "plantilla" });
    const examples = templates(s, { me, contact: p.contact }).filter(t => t.channel === channel).slice(0, 3).map(t => t.text);
    res.json({ ...await ai.draft(req.params.id, { ...p, pdContext: await sales.draftContext(req.params.id, user).catch(() => ""), examples, user: { ...user, name: me } }), mode: "ia" });
  }));
}
