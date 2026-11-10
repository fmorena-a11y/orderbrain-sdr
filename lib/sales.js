import * as pd from "./pipedrive.js";
import { addVirtual, schools, byId, getMatch, setMatch, isFresh, addTouch, touchesFor, touchesSince, orgToSchool, allMatches, refreshMatch, withLock } from "./store.js";
import { market, MARKETS, DEAL_FIELDS, OPTIONS, TYPE_LABEL, CHANNEL_TYPE, LOST_REASONS, DAILY_GOAL } from "./config.js";
import { OUTCOMES, outcomeById, suggestNext, playbookFor, templates, scoreSchool, countAttempts } from "./playbook.js";
import { toUtc, todayIn, weekday, safeTz } from "./time.js";
import { structureNote } from "./ai.js";
import { brainOf } from "./brain.js";

export { TYPE_LABEL };
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const stripHtml = h => String(h || "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|li|div)>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\n{3,}/g, "\n\n").trim();
const nice = d => `${weekday(d)} ${d.slice(8, 10)}/${d.slice(5, 7)}`;
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
// Quién firma en Pipedrive y en el ranking: el nombre de su usuario de Pipedrive (no se puede elegir el de otro)
export const signer = user => user.pdName || user.name || user.email;

// ---------- cruce con Pipedrive (7 días de validez)
// ---------- fichas de la agenda que no son colegios de la base: un prospecto (lead) o una organización de Pipedrive
// Se arman a pedido para poder trabajarlos desde la app (contexto, registrar, próximo paso) sin abrir Pipedrive.
// País como lo usa la app (México, Perú…) a partir de lo que guarda Pipedrive («Mexico», «Perú», código…)
const appCountry = raw => { const n = pd.norm(raw); if (!n) return ""; return Object.keys(MARKETS).find(k => pd.norm(k) === n || MARKETS[k].code.toLowerCase() === n) || ""; };
const countryFromOpt = id => Object.entries(OPTIONS.pais).find(([, v]) => String(v) === String(id))?.[0] || "";
export async function openRecord(kind, rid, extra = {}) {
  if (kind === "org") {
    const o = (await pd.orgsByIds([Number(rid)]))[0];
    if (!o) throw bad("No encontré esa organización en Pipedrive", 404);
    const s = addVirtual({ id: `pd-org-${o.id}`, name: o.name, city: o.city || extra.city || "", country: appCountry(o.country) || extra.country || "", src: "pipedrive", virtual: true, pdOrgId: o.id });
    // el prospecto de esta organización (si la ficha se abrió desde uno) queda guardado en el cruce, no solo en memoria
    if (extra.leadId) { s.leadId = extra.leadId; const mm = getMatch(s.id); if (mm && !mm.leadId) setMatch(s.id, { ...mm, leadId: extra.leadId }); }
    if (!isFresh(getMatch(s.id))) await checkSchool(s.id, { org: { id: o.id, name: o.name, ownerId: o.ownerId } });
    return schoolListItem(s);
  }
  if (kind === "lead") {
    const l = (await pd.leadsByIds([String(rid)]))[0];
    if (!l) throw bad("No encontré ese prospecto en Pipedrive", 404);
    await pd.loadFieldOptions().catch(() => {});
    const country = countryFromOpt(l.paisOpt), city = l.ciudadOpt ? pd.optionLabel(DEAL_FIELDS.ciudad, l.ciudadOpt) || "" : "";
    if (l.orgId) { const r = await openRecord("org", l.orgId, { leadId: l.id, country, city }); return { ...r, leadId: l.id }; }
    const person = l.personId ? await pd.getPerson(l.personId).catch(() => null) : null;
    // si el prospecto ya pasó a trato (otra instancia lo convirtió), se sigue con su organización
    const conv = getMatch(`pd-lead-${l.id}`);
    const s = addVirtual({ id: `pd-lead-${l.id}`, name: l.title || person?.name || "Prospecto", city, country, phone: person?.phone || "", email: person?.email || "",
      src: "pipedrive", virtual: true, leadOnly: true, leadId: l.id, personId: l.personId || null, personName: person?.name || "" });
    if (conv?.orgId) { s.leadOnly = false; s.pdOrgId = conv.orgId; }
    else setMatch(s.id, { status: "lead", detail: "Prospecto en Pipedrive", orgId: null, orgName: null, confirmed: true, leadId: l.id, candidates: [] });
    return schoolListItem(s);
  }
  throw bad("Ficha inválida");
}
// id de ficha virtual → la rearma si esta instancia no la tiene
export async function ensureRecord(id) {
  if (byId.has(id)) return true;
  const m = /^pd-(org|lead)-(.+)$/.exec(id); if (!m) return false;
  const r = await openRecord(m[1], m[2]);
  // un prospecto que ya pasó a organización: la misma id sigue abriendo la ficha (ahora de la organización)
  if (!byId.has(id) && r?.id && byId.has(r.id)) byId.set(id, byId.get(r.id));
  return byId.has(id);
}

export async function checkSchool(id, { force = false, org = null } = {}) {
  const s = byId.get(id);
  if (!s) throw bad("Colegio inexistente", 404);
  if (s.leadOnly) return getMatch(id) || setMatch(id, { status: "lead", detail: "Prospecto en Pipedrive", orgId: null, confirmed: true, leadId: s.leadId, candidates: [] });
  const cur = getMatch(id);
  if (!force && !org && isFresh(cur)) return cur;
  let chosen = null, candidates = [];
  if (org) chosen = { ...org, score: 1 };
  else if (cur?.confirmed && cur.orgId) chosen = { id: cur.orgId, name: cur.orgName, score: 1 };
  else { candidates = await pd.findOrgCandidates(s); chosen = candidates.find(o => o.score >= 0.67) || null; }
  if (!chosen) return setMatch(id, { status: "new", detail: candidates.length ? "Sin coincidencia clara en Pipe" : "No figura en Pipe", orgId: null, orgName: null, confirmed: false, candidates });
  const [deals, m] = await Promise.all([pd.dealsForOrg(chosen.id), pd.meta()]);
  // dueño de la organización en Pipedrive: si es de otra persona, nadie más la prospecta
  let ownerId = chosen.ownerId ?? null;
  if (ownerId === null) ownerId = (await pd.orgsByIds([chosen.id]))[0]?.ownerId || null; // si falla, no se guarda un cruce «sin dueño»
  const status = deals.length ? pd.classify(deals, m) : "org";
  // motivo y fecha del mismo trato que define el estado (si es «Perdido», el perdido con propuesta)
  const open = pd.openSalesDeal(deals), lost = (status === "lost" && pd.lastLostWithProposal(deals, m)) || pd.lastLost(deals);
  return setMatch(id, {
    status, detail: pd.describe(status, deals, m), phase: pd.phaseOf(deals, m), orgId: chosen.id, orgName: chosen.name,
    ownerId, ownerName: ownerId ? m.users.find(u => u.id === ownerId)?.name || "" : "",
    confirmed: !!(org || cur?.confirmed || chosen.score >= 0.95),
    openDealId: open?.id || null, openDealOwner: open ? m.users.find(u => u.id === (open.owner_id || open.user_id))?.name || "" : "",
    lostReason: lost?.lost_reason || "", lostAt: (lost?.lost_time || lost?.update_time || "").slice(0, 10) || null,
    dealCount: deals.length, candidates: candidates.filter(c => c.id !== chosen.id),
    leadId: cur?.orgId === chosen.id ? cur?.leadId || null : null,
  });
}

export function unlinkSchool(id) {
  return setMatch(id, { status: "new", detail: "Sin coincidencia confirmada", orgId: null, orgName: null, confirmed: false, candidates: getMatch(id)?.candidates || [] });
}

// Para la lista (puede haber decenas de miles): solo lo que usa la interfaz. La ficha trae el resto.
const LIST_FIELDS = ["id", "name", "city", "country", "lat", "lng", "addr", "phone", "web", "rating", "found", "fit", "src", "area", "osm"];
const BRAIN_PHASE = st => /^Churn/.test(st) ? "churn" : { Active: "activo", Onboarding: "onboarding", Closed: "cerrado" }[st] || null;
// Cruce efectivo: si OrderBrain dice que ya es cliente, manda eso aunque Pipedrive no lo tenga.
function effMatch(s) {
  const m = getMatch(s.id), fm = isFresh(m) ? m : null, b = brainOf(s);
  if (b?.client) return { ...(fm || {}), status: "client", detail: `Cliente en OrderBrain (${b.label})`, checkedAt: new Date().toISOString() };
  // ex cliente (churn en World Dominion o en Pipedrive): nunca puede ser «nunca contactado»
  if ((b?.churn || fm?.phase === "churn") && fm?.status !== "open") return { ...(fm || {}), status: "churn", churnLabel: b?.label || "Se dio de baja (Pipedrive)", detail: b?.churn ? `${b.label} (OrderBrain)` : "Se dio de baja según Pipedrive", checkedAt: new Date().toISOString() };
  return fm;
}
export function schoolListItem(s) {
  const full = schoolSummary(s), out = {};
  for (const k of [...LIST_FIELDS, "status", "detail", "orgId", "lastTouch", "attempts", "ob", "phase", "ownerId", "ownerName"]) if (full[k] !== undefined && full[k] !== "" && full[k] !== null) out[k] = full[k];
  if (!out.status) out.status = "unk";
  if (!out.attempts) delete out.attempts;
  return out;
}
export function schoolSummary(s) {
  const m = getMatch(s.id);
  const fresh = m && isFresh(m);
  const t = touchesFor(s.id);
  const last = t[t.length - 1];
  const b = brainOf(s);
  const churn = (b?.churn || (fresh && m.phase === "churn")) && !(fresh && m.status === "open");
  return { ...s, status: b?.client ? "client" : churn ? "churn" : fresh ? m.status : "unk",
    detail: b?.client ? `Cliente en OrderBrain (${b.label})` : churn ? (b?.churn ? `${b.label} (OrderBrain)` : "Se dio de baja según Pipedrive") : m?.detail || "", orgId: m?.orgId || null, checkedAt: m?.checkedAt || null,
    ownerId: fresh ? m.ownerId || null : null, ownerName: fresh ? m.ownerName || "" : "",
    ob: b ? { label: b.label, churn: b.churn, site: b.site, client: b.clientName } : null,
    // World Dominion manda; si no está ahí, lo que dicen los tratos de Pipedrive
    phase: b ? BRAIN_PHASE(b.status) : fresh ? m.phase || null : null,
    lastTouch: last ? { at: last.at, by: last.byName, outcome: outcomeById(last.outcome)?.label || "" } : null, attempts: countAttempts(t) };
}

// ---------- ficha completa
export async function schoolDetail(id, { user, tz, ...opts } = {}) {
  const s = byId.get(id);
  const rec = await checkSchool(id, opts);
  const t = touchesFor(id);
  const base = {
    match: rec, school: schoolSummary(s), market: market(s.country), playbook: playbookFor(s, effMatch(s) || rec), brain: brainOf(s),
    attempts: countAttempts(t), touches: t.slice(-15).reverse().map(x => ({ at: x.at, by: x.byName, outcome: outcomeById(x.outcome)?.label || x.outcome, channel: x.channel, text: x.text || "" })),
    lostReasons: LOST_REASONS, today: todayIn(tz),
  };
  if (s.leadOnly) {
    const notes = await pd.notesForLead(s.leadId).catch(() => []);
    const persons = s.personId ? [{ id: s.personId, name: s.personName, phone: s.phone || "", email: s.email || "" }] : [];
    return { ...base, lead: true, orgUrl: `${pd.PD_WEB}/leads/inbox/${s.leadId}`, deals: [], activities: [], persons,
      notes: notes.map(n => ({ at: n.add_time, author: n.user?.name || "", deal: "", text: stripHtml(n.content).slice(0, 900) })),
      templates: templates(s, { me: user?.name, contact: s.personName || "" }) };
  }
  if (!rec.orgId) return { ...base, deals: [], notes: [], activities: [], persons: [], templates: templates(s, { me: user?.name }) };
  const [deals, notes, acts, persons, m] = await Promise.all([pd.dealsForOrg(rec.orgId), pd.notesForOrg(rec.orgId), pd.activities({ orgId: rec.orgId, done: false, limit: 20 }), pd.personsForOrg(rec.orgId).catch(() => []), pd.meta()]);
  const uname = uid => m.users.find(u => u.id === uid)?.name || "";
  return {
    ...base, orgUrl: `${pd.PD_WEB}/organization/${rec.orgId}`, persons,
    templates: templates(s, { me: user?.name, contact: persons[0]?.name || "" }),
    deals: deals.map(d => ({ id: d.id, title: d.title, status: d.status, pipeline: m.pipes[d.pipeline_id] || "", stage: m.stages[d.stage_id] || "", lostReason: d.lost_reason, owner: uname(d.owner_id || d.user_id), updated: (d.update_time || "").slice(0, 10), url: `${pd.PD_WEB}/deal/${d.id}` })),
    notes: notes.map(n => ({ at: n.add_time, author: n.user?.name || "", deal: n.deal?.title || "", text: stripHtml(n.content).slice(0, 900) })),
    activities: acts.map(a => ({ id: a.id, subject: a.subject, type: a.type, typeLabel: TYPE_LABEL[a.type] || a.type, date: a.due_date, time: a.due_time || "", owner: uname(a.owner_id), ownerId: a.owner_id })),
  };
}

// Se asegura de que el colegio tenga organización en Pipedrive; si no existe, la crea.
export async function ensureOrg(id, ownerId = null) {
  const s = byId.get(id);
  if (s?.leadOnly) throw bad("Es un prospecto sin organización: lo que registres queda en el prospecto.", 409);
  await refreshMatch(id);
  let rec = await checkSchool(id);
  if (rec.orgId) return rec;
  return withLock("org:" + id, async () => {
    // otra instancia pudo haberla creado mientras esperábamos el candado
    await refreshMatch(id);
    rec = await checkSchool(id);
    if (rec.orgId) return rec;
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
// Escribe en Pipedrive: actividad hecha (el contacto), nota, persona, trato, demo, próximo paso y pérdida.
export async function logContact(id, user, p, tz) {
  const s = byId.get(id);
  if (!s) throw bad("Colegio inexistente", 404);
  const o = outcomeById(p.outcome);
  if (!o) throw bad("Elegí qué pasó en el contacto.");
  const channel = CHANNEL_TYPE[p.channel] ? p.channel : "call";
  const raw = String(p.text || "").trim().slice(0, 4000);
  const dateRe = /^\d{4}-\d{2}-\d{2}$/, timeRe = /^\d{2}:\d{2}$/;
  if (p.next?.type && !dateRe.test(p.next.date || "")) throw bad("Poné la fecha del próximo paso.");
  if (o.id === "demo" && (!dateRe.test(p.demo?.date || "") || !timeRe.test(p.demo?.time || ""))) throw bad("Poné el día y la hora de la demo.");
  if (p.lost?.reason && !LOST_REASONS.includes(p.lost.reason)) throw bad("Motivo de pérdida inválido.");
  // fichas de Pipedrive sin país: para la demo hace falta saberlo (el trato va al embudo del país)
  if (s.virtual && !s.country && p.country && MARKETS[p.country]) s.country = p.country;
  if (o.id === "demo" && s.virtual && !s.country) throw bad("Elegí el país del colegio: el trato se crea en el embudo de ese país.");
  const mk = market(s.country);
  const today = todayIn(tz);
  const done = [];
  if (s.leadOnly) return logLead(id, s, user, p, tz, { o, channel, raw, today });

  const rec = await ensureOrg(id, user.pdUserId || null);
  const orgUrl = `${pd.PD_WEB}/organization/${rec.orgId}`;
  done.push({ label: rec.created ? "Organización creada en Pipedrive" : `Guardado en ${rec.orgName}`, url: orgUrl });

  // Persona (decisor o contacto). Si viene de un prospecto que ya tenía persona, esa persona pasa a la organización.
  let personId = p._personId || null;
  if (personId) await pd.updatePerson(personId, { org_id: rec.orgId }).catch(() => {});
  const c = p.contact || {};
  if (c.name && String(c.name).trim()) {
    const person = await pd.addPerson({ name: [String(c.name).trim(), c.role ? `(${String(c.role).trim()})` : ""].filter(Boolean).join(" "), orgId: rec.orgId, phone: c.phone, email: c.email, ownerId: user.pdUserId });
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
    const body = { title: `${s.name}`, org_id: rec.orgId, pipeline_id: mk.pipeline, stage_id: mk.stage, owner_id: Number(p.demo.ownerId) || user.pdUserId || undefined,
      custom_fields: { ...custom, [DEAL_FIELDS.fuente]: [OPTIONS.fuente.coldCalling] } };
    if (user.pdUserId) body.custom_fields[DEAL_FIELDS.sdr] = user.pdUserId;
    if (OPTIONS.pais[s.country]) body.custom_fields[DEAL_FIELDS.pais] = OPTIONS.pais[s.country];
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

  // El contacto en sí, como actividad hecha (cuenta para los reportes de Pipedrive).
  const chLabel = { call: "Llamada", whatsapp: "WhatsApp", mail: "Mail", visit: "Visita" }[channel];
  await pd.addActivity({ subject: `${chLabel}: ${o.label} · ${s.name}`, type: CHANNEL_TYPE[channel], dueDate: today, orgId: rec.orgId, dealId, personId, ownerId: user.pdUserId, note: raw ? esc(raw).replace(/\n/g, "<br>") : "", done: true });
  done.push({ label: `${chLabel} registrada como hecha` });

  // Nota ordenada
  const qualRows = [["Cafetería", q.cafeteria], ["Alumnos", q.alumnos], ["Niveles", (q.niveles || []).join(", ")], ["Sistema actual", q.sistema], ["Contacto", c.name ? [c.name, c.role, c.phone, c.email].filter(Boolean).join(" · ") : ""]];
  const head = `<b>${esc(chLabel)} · ${esc(o.label)}</b>`;
  let html = head;
  let structured = null;
  if (raw && p.ai !== false) structured = await structureNote({ school: s, outcome: o.label, text: raw }).catch(() => null);
  const aiRows = structured ? [["Resumen", structured.resumen], ["Decisor", structured.decisor], ["Objeción", structured.objecion], ["Próximo paso", structured.proximo_paso], ["Interés", structured.interes]] : [];
  if (!q.cafeteria && structured?.cafeteria) qualRows[0][1] = structured.cafeteria;
  const rows = [...aiRows, ...qualRows].filter(([, v]) => v && String(v).trim());
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
  }

  // Próximo paso
  if (p.next?.type && TYPE_LABEL[p.next.type]) {
    const u = toUtc(p.next.date, p.next.time, tz);
    await pd.addActivity({ subject: p.next.subject || `${TYPE_LABEL[p.next.type]} · ${s.name}`, type: p.next.type, dueDate: u.date, dueTime: u.time, orgId: rec.orgId, dealId, personId,
      ownerId: Number(p.next.ownerId) || user.pdUserId, note: raw ? esc(raw).slice(0, 1000) : "" });
    html += `<br><b>Próximo paso:</b> ${TYPE_LABEL[p.next.type]} el ${weekday(p.next.date)} ${esc(p.next.date)}${p.next.time ? " " + esc(p.next.time) : ""}`;
    done.push({ label: `Próximo paso: ${TYPE_LABEL[p.next.type]} el ${nice(p.next.date)}${p.next.time ? " a las " + p.next.time : ""}` });
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
  await pd.addNote({ content: html, orgId: rec.orgId, dealId, personId });
  done.push({ label: "Nota guardada" });

  // Etiqueta de interés en la organización
  if (o.interest && rec.status !== "client") await pd.updateOrganization(rec.orgId, { label_ids: [OPTIONS.orgLabel[o.interest]] }).catch(() => {});

  // Marca como hecha la actividad que motivó el contacto
  if (p.completeActivityId) { await pd.updateActivity(p.completeActivityId, { done: true }).catch(() => {}); done.push({ label: "Actividad pendiente marcada como hecha" }); }
  // Un prospecto (lead) que llegó a demo ya es un trato: se archiva el prospecto con una nota
  // (el prospecto puede venir de la ficha, del cruce guardado o de «Crear prospecto»)
  const leadId = s.leadId || getMatch(id)?.leadId || rec.leadId || null;
  if (leadId && o.id === "demo" && dealId) {
    await pd.addNote({ content: `<b>Pasó a trato</b><br>Demo agendada desde OrderBrain SDR por ${esc(signer(user))}.<br><a href="${pd.PD_WEB}/deal/${dealId}">Ver trato</a>`, leadId }).catch(() => {});
    await pd.updateLead(leadId, { is_archived: true }).then(() => done.push({ label: "Prospecto archivado: ya es un trato" })).catch(() => {});
  }

  addTouch({ schoolId: id, by: user.email, byName: signer(user), outcome: o.id, channel, connected: o.connected, text: raw.slice(0, 300), demo: o.id === "demo" });
  const fresh = await checkSchool(id, { force: true }).catch(() => getMatch(id));
  if (!fresh.confirmed) setMatch(id, { ...fresh, confirmed: true });
  return { ok: true, done, orgUrl, dealUrl: dealId ? `${pd.PD_WEB}/deal/${dealId}` : null, school: schoolSummary(s) };
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
      const org = await pd.createOrganization({ name: s.name, ownerId: user.pdUserId || undefined,
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
    const person = await pd.addPerson({ name: [String(c.name).trim(), c.role ? `(${String(c.role).trim()})` : ""].filter(Boolean).join(" "), phone: c.phone, email: c.email, ownerId: user.pdUserId });
    if (person?.id) {
      done.push({ label: `Contacto ${c.name}`, url: `${pd.PD_WEB}/person/${person.id}` });
      if (!personId) { personId = person.id; await pd.updateLead(s.leadId, { person_id: person.id }).catch(() => {}); s.personId = person.id; s.personName = c.name; }
    }
  }
  const chLabel = { call: "Llamada", whatsapp: "WhatsApp", mail: "Mail", visit: "Visita" }[channel];
  await pd.addActivity({ subject: `${chLabel}: ${o.label} · ${s.name}`, type: CHANNEL_TYPE[channel], dueDate: today, leadId: s.leadId, personId, ownerId: user.pdUserId, note: raw ? esc(raw).replace(/\n/g, "<br>") : "", done: true });
  done.push({ label: `${chLabel} registrada como hecha` });
  let html = `<b>${esc(chLabel)} · ${esc(o.label)}</b>`;
  if (raw) html += `<br><br>${esc(raw).replace(/\n/g, "<br>")}`;
  if (p.next?.type && TYPE_LABEL[p.next.type]) {
    const u = toUtc(p.next.date, p.next.time, tz);
    await pd.addActivity({ subject: p.next.subject || `${TYPE_LABEL[p.next.type]} · ${s.name}`, type: p.next.type, dueDate: u.date, dueTime: u.time, leadId: s.leadId, personId, ownerId: Number(p.next.ownerId) || user.pdUserId, note: raw ? esc(raw).slice(0, 1000) : "" });
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
  if (p.completeActivityId) { await pd.updateActivity(p.completeActivityId, { done: true }).catch(() => {}); done.push({ label: "Actividad pendiente marcada como hecha" }); }
  addTouch({ schoolId: id, by: user.email, byName: signer(user), outcome: o.id, channel, connected: o.connected, text: raw.slice(0, 300), demo: false });
  return { ok: true, done, orgUrl: leadUrl, dealUrl: null, school: schoolSummary(s) };
}

// ---------- crear prospecto: «lo voy a contactar». Crea (si falta) la organización y el prospecto en Pipedrive a
// nombre de quien lo pide, y busca a quién contactar: la web del colegio (teléfonos, WhatsApp, mails) y, si hay
// estudio con IA, los decisores con nombre y cargo. No inventa nada: lo que no encuentra, no lo carga.
// Los campos del formulario «Añadir prospecto» de Pipedrive, con los mismos formatos que usa la cuenta:
// listas = número de opción; selección múltiple = números separados por comas; usuario = id; texto y dirección = texto.
export async function leadFields(s, user, found = {}) {
  const F = DEAL_FIELDS, f = {};
  const ciudad = await pd.optionFor(F.ciudad, s.city).catch(() => null); if (ciudad) f[F.ciudad] = ciudad;
  if (s.state) { const est = await pd.optionFor(F.estado, s.state).catch(() => null); if (est) f[F.estado] = est; }
  if (OPTIONS.pais[s.country]) f[F.pais] = OPTIONS.pais[s.country];
  f[F.fuente] = String(OPTIONS.fuente.coldCalling);
  if (user.pdUserId) f[F.sdr] = user.pdUserId;
  const phone = s.phone || found.phones?.[0], email = s.email || found.emails?.[0];
  if (phone) f[F.telefono] = phone;
  if (email) f[F.email] = email;
  if (s.web) f[F.web] = s.web;
  const addr = [s.addr, s.city, s.country].filter(Boolean).join(", "); if (s.addr) f[F.direccion] = addr;
  const niv = (s.levels || []).map(n => OPTIONS.niveles[n]).filter(Boolean); if (niv.length) f[F.niveles] = niv.join(",");
  return f;
}
// task: la primera tarea a futuro (siempre conviene dejar una): { type, date, time, ownerId, subject }
const PHONE_RE = /\d/g, okPhone = p => (String(p || "").match(PHONE_RE) || []).length >= 8 && !/sin datos|estimad|no identific/i.test(p);
const okEmail = e => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(String(e || "").trim());
const okName = n => n && !/sin datos|estimad|no identific|desconocid|n\/a/i.test(n);
export async function createProspect(id, user, task = null, tz = "America/Montevideo") {
  const s = byId.get(id);
  if (!s || s.leadOnly) throw bad("Colegio inexistente", 404);
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
    const rec = await ensureOrg(id, user.pdUserId);
    if (rec.ownerId && rec.ownerId !== user.pdUserId) throw bad(`La organización es de ${rec.ownerName || "otra persona"} en Pipedrive. Hablalo con esa persona.`, 409);
    const orgUrl = `${pd.PD_WEB}/organization/${rec.orgId}`;
    const done = [{ label: rec.created ? "Organización creada en Pipedrive" : `Organización: ${rec.orgName}`, url: orgUrl }];
    // ¿ya hay un prospecto abierto? se reusa si es tuyo (sin duplicar persona ni nota); si es de otro, no se crea
    const open = await pd.leadsForOrg(rec.orgId).catch(e => { throw bad(`No pude revisar los prospectos de Pipedrive (${e.message}). Probá de nuevo.`, 502); });
    if (open.find(l => l.ownerId && l.ownerId !== user.pdUserId)) throw bad("Ya hay un prospecto abierto de otra persona para este colegio.", 409);
    let lead = open.find(l => !l.ownerId || l.ownerId === user.pdUserId);
    const found = { phones: [], emails: [], whatsapp: "", decisores: [] };
    let personId = lead?.personId || null;
    if (!lead) {
      // a quién contactar: la web del colegio y, si hay estudio con IA, los decisores (sin «sin datos» ni estimaciones)
      if (okPhone(s.phone)) found.phones.push(s.phone);
      if (okEmail(s.email)) found.emails.push(s.email);
      if (s.web) {
        try { const { webInfo } = await import("./enrich.js"); const w = await webInfo(s.web); if (okPhone(w.phone)) found.phones.push(w.phone); if (okEmail(w.email)) found.emails.push(w.email); if (/^\+\d{8,15}$/.test(w.whatsapp || "")) found.whatsapp = w.whatsapp; } catch {}
      }
      const { getStudy } = await import("./store.js");
      const st = await getStudy(id).catch(() => null);
      if (st) {
        found.decisores = (st.decisores || []).filter(d => okName(d.nombre) && okName(d.cargo)).slice(0, 3);
        found.phones.push(...(st.contacto?.telefonos || []).filter(okPhone)); found.emails.push(...(st.contacto?.emails || []).filter(okEmail));
        if (!found.whatsapp && /^\+?\d{8,15}$/.test(String(st.contacto?.whatsapp || "").replace(/[\s-]/g, ""))) found.whatsapp = st.contacto.whatsapp;
      }
      found.phones = [...new Set(found.phones)].slice(0, 4); found.emails = [...new Set(found.emails.map(e => e.trim().toLowerCase()))].slice(0, 4);
      // persona: el decisor con nombre (con los datos del colegio solo como referencia en la nota); si no hay
      // decisor, el contacto general del colegio con el teléfono y el mail de su web
      const d0 = found.decisores[0];
      if (d0 || found.phones.length || found.emails.length) {
        const person = await pd.addPerson({ name: d0 ? `${d0.nombre} (${d0.cargo})` : `${s.name} · contacto general`, orgId: rec.orgId,
          phone: d0 ? undefined : found.phones[0] || found.whatsapp, email: d0 ? undefined : found.emails[0], ownerId: user.pdUserId }).catch(() => null);
        if (person?.id) { personId = person.id; done.push({ label: d0 ? `Contacto: ${d0.nombre} (${d0.cargo})` : "Contacto general del colegio (de su web)", url: `${pd.PD_WEB}/person/${person.id}` }); }
      }
      lead = await pd.createLead({ title: s.name, ownerId: user.pdUserId, orgId: rec.orgId, personId, fields: await leadFields(s, user, found) });
      const rows = [
        found.decisores.length ? `<b>Decisores:</b><br>${found.decisores.map(d => `• ${esc(d.nombre)} (${esc(d.cargo)})${d.fuente ? ` · ${esc(d.fuente)}` : ""}`).join("<br>")}` : "<b>Decisor:</b> todavía sin nombre. Preguntá en recepción quién maneja la cafetería.",
        found.phones.length ? `<b>Teléfonos:</b> ${found.phones.map(esc).join(" · ")}` : "", found.whatsapp ? `<b>WhatsApp:</b> ${esc(found.whatsapp)}` : "",
        found.emails.length ? `<b>Mails:</b> ${found.emails.map(esc).join(" · ")}` : "", s.web ? `<b>Web:</b> ${esc(s.web)}` : "",
      ].filter(Boolean);
      await pd.addNote({ content: `<b>Prospecto creado desde OrderBrain SDR</b> por ${esc(signer(user))}<br>${rows.join("<br>")}`, orgId: rec.orgId }).catch(() => {});
    }
    const leadUrl = `${pd.PD_WEB}/leads/inbox/${lead.id}`;
    done.push({ label: open.length ? "Prospecto ya existente (tuyo)" : "Prospecto creado a tu nombre", url: leadUrl });
    // la primera tarea a futuro, atada al prospecto (le aparece a quien la tenga en su agenda)
    if (task) {
      const m = await pd.meta(), owner = task.ownerId ? m.users.find(u => u.id === Number(task.ownerId)) : null;
      const u = toUtc(task.date, task.time, tz);
      await pd.addActivity({ subject: String(task.subject || "").trim().slice(0, 140) || `${TYPE_LABEL[task.type]} · ${s.name}`, type: task.type, dueDate: u.date, dueTime: u.time, leadId: lead.id, personId, ownerId: owner?.id || user.pdUserId });
      done.push({ label: `${TYPE_LABEL[task.type]} el ${nice(task.date)}${task.time ? " a las " + task.time : ""} para ${owner && owner.id !== user.pdUserId ? owner.name : "vos"}`, url: leadUrl });
    }
    const fresh = await checkSchool(id, { force: true }).catch(() => getMatch(id));
    setMatch(id, { ...fresh, confirmed: true, ownerId: fresh.ownerId || user.pdUserId, leadId: lead.id });
    return { ok: true, done, leadUrl, orgUrl, found, school: schoolSummary(s) };
  });
}

// ---------- agenda propia
export async function myActivities(user) {
  if (!user.pdUserId) return { warning: "Tu email no coincide con ningún usuario de Pipedrive.", items: [] };
  const list = await pd.activities({ ownerId: user.pdUserId, done: false, limit: 500 });
  const o2s = orgToSchool();
  // Actividades sin organización: muchas están atadas a un prospecto (lead) o a una persona. Se trae su nombre
  // (y la organización del prospecto, si tiene) para que se sepa de quién es cada una.
  const leads = new Map((await pd.leadsByIds([...new Set(list.filter(a => !a.org_id && a.lead_id).map(a => a.lead_id))], user.pdUserId).catch(() => [])).map(l => [l.id, l]));
  const persons = new Map((await pd.personsByIds([...new Set(list.filter(a => !a.org_id && a.person_id).map(a => a.person_id))]).catch(() => [])).map(p => [p.id, p]));
  const orgOf = a => a.org_id || leads.get(a.lead_id)?.orgId || persons.get(a.person_id)?.orgId || null;
  // Organizaciones que todavía no se cruzaron: se buscan por nombre exacto en la base de colegios.
  const unknown = [...new Set(list.map(orgOf).filter(id => id && !o2s.has(id)))];
  const orgName = new Map();
  if (unknown.length) {
    const byName = new Map(schools.map(s => [pd.norm(s.name), s.id]));
    for (const o of await pd.orgsByIds(unknown).catch(() => [])) { orgName.set(o.id, o.name); const sid = byName.get(pd.norm(o.name)); if (sid) o2s.set(o.id, sid); }
  }
  const strip = h => String(h || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
  return { items: list.map(a => {
    const org = orgOf(a), lead = leads.get(a.lead_id), person = persons.get(a.person_id);
    const who = lead?.title || orgName.get(org) || person?.name || "";
    const url = a.deal_id ? `${pd.PD_WEB}/deal/${a.deal_id}` : a.lead_id ? `${pd.PD_WEB}/leads/inbox/${a.lead_id}` : org ? `${pd.PD_WEB}/organization/${org}` : a.person_id ? `${pd.PD_WEB}/person/${a.person_id}` : `${pd.PD_WEB}/activities/list`;
    return { id: a.id, subject: a.subject, type: a.type, typeLabel: TYPE_LABEL[a.type] || a.type, date: a.due_date, time: a.due_time || "", orgId: org, dealId: a.deal_id, schoolId: o2s.get(org) || null,
      who: who && who !== a.subject ? who.slice(0, 80) : "", kind: lead ? "Prospecto" : person && !org ? "Persona" : "", note: strip(a.note).slice(0, 90), url,
      // para abrir la ficha en la app: el prospecto o la organización de Pipedrive
      record: o2s.get(org) ? null : a.lead_id ? `lead:${a.lead_id}` : org ? `org:${org}` : null };
  }) };
}

// ---------- cola de hoy: a quién contactar ahora
// userId: la persona que pide la cola. No se proponen colegios cuya organización en Pipedrive es de otra persona.
export function prospectQueue({ countries = [], limit = 40, excludeOrgIds = new Set(), userId = null } = {}) {
  // perfiles livianos para la cola
  const out = [];
  for (const s of schools) {
    if (countries.length && !countries.includes(s.country)) continue;
    const m = getMatch(s.id);
    if (m?.orgId && excludeOrgIds.has(m.orgId)) continue;
    if (isFresh(m) && m.ownerId && m.ownerId !== userId) continue;
    const r = scoreSchool(s, effMatch(s), touchesFor(s.id));
    if (r) out.push({ ...schoolListItem(s), score: r.score, reasons: r.reasons });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

export const scoreFor = s => scoreSchool(s, effMatch(s), touchesFor(s.id));

// ---------- métricas propias y del equipo
export function stats(user, tz) {
  const today = todayIn(tz);
  const wk = Date.now() - 7 * 864e5;
  const week = touchesSince(wk);
  const mine = week.filter(t => t.by === user.email);
  const fmt = new Intl.DateTimeFormat("sv-SE", { timeZone: safeTz(tz) });
  const isToday = t => today === fmt.format(new Date(t.at));
  const mToday = mine.filter(isToday);
  const board = new Map();
  for (const t of week) {
    const b = board.get(t.by) || { name: t.byName, touches: 0, connected: 0, demos: 0 };
    b.touches++; if (t.connected) b.connected++; if (t.demo) b.demos++;
    board.set(t.by, b);
  }
  return {
    today, goal: DAILY_GOAL,
    todayTouches: mToday.length, todayConnected: mToday.filter(t => t.connected).length, todayDemos: mToday.filter(t => t.demo).length,
    weekTouches: mine.length, weekConnected: mine.filter(t => t.connected).length, weekDemos: mine.filter(t => t.demo).length,
    leaderboard: [...board.values()].sort((a, b) => b.demos - a.demos || b.connected - a.connected || b.touches - a.touches),
  };
}

// Feed del equipo: contactos registrados en la app + notas de Pipedrive cargadas desde OrderBrain.
export async function teamFeed() {
  const local = touchesSince(Date.now() - 14 * 864e5).slice(-40).reverse().map(t => ({ at: t.at, author: t.byName, org: byId.get(t.schoolId)?.name || "", schoolId: t.schoolId, title: outcomeById(t.outcome)?.label || "", channel: t.channel, demo: !!t.demo }));
  if (local.length >= 10) return local;
  const notes = await pd.recentNotes(80).catch(() => []);
  const o2s = orgToSchool();
  const remote = notes.filter(n => /OrderBrain SDR|desde el asistente/i.test(n.content || "")).slice(0, 25).map(n => ({
    at: String(n.add_time).replace(" ", "T") + "Z", author: n.user?.name || "", org: n.organization?.name || "", schoolId: o2s.get(n.org_id) || null,
    title: (stripHtml(n.content).split("\n")[0] || "").split(" · ").pop() || "Nota",
  }));
  const seen = new Set(local.map(l => l.org + l.title));
  return [...local, ...remote.filter(r => !seen.has(r.org + r.title))].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 30);
}

export { OUTCOMES, allMatches };
