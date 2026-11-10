import * as pd from "./pipedrive.js";
import { schools, byId, getMatch, setMatch, isFresh, addTouch, touchesFor, touchesSince, orgToSchool, allMatches, refreshMatch, withLock } from "./store.js";
import { market, DEAL_FIELDS, OPTIONS, TYPE_LABEL, CHANNEL_TYPE, LOST_REASONS, DAILY_GOAL } from "./config.js";
import { OUTCOMES, outcomeById, suggestNext, playbookFor, templates, scoreSchool, countAttempts } from "./playbook.js";
import { toUtc, todayIn, weekday, safeTz } from "./time.js";
import { structureNote } from "./ai.js";
import { brainOf } from "./brain.js";

export { TYPE_LABEL };
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const stripHtml = h => String(h || "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|li|div)>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\n{3,}/g, "\n\n").trim();
const nice = d => `${weekday(d)} ${d.slice(8, 10)}/${d.slice(5, 7)}`;
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

// ---------- cruce con Pipedrive (7 días de validez)
export async function checkSchool(id, { force = false, org = null } = {}) {
  const s = byId.get(id);
  if (!s) throw bad("Colegio inexistente", 404);
  const cur = getMatch(id);
  if (!force && !org && isFresh(cur)) return cur;
  let chosen = null, candidates = [];
  if (org) chosen = { ...org, score: 1 };
  else if (cur?.confirmed && cur.orgId) chosen = { id: cur.orgId, name: cur.orgName, score: 1 };
  else { candidates = await pd.findOrgCandidates(s); chosen = candidates.find(o => o.score >= 0.67) || null; }
  if (!chosen) return setMatch(id, { status: "new", detail: candidates.length ? "Sin coincidencia clara en Pipe" : "No figura en Pipe", orgId: null, orgName: null, confirmed: false, candidates });
  const [deals, m] = await Promise.all([pd.dealsForOrg(chosen.id), pd.meta()]);
  const status = deals.length ? pd.classify(deals, m) : "org";
  const open = pd.openSalesDeal(deals), lost = pd.lastLost(deals);
  return setMatch(id, {
    status, detail: pd.describe(status, deals, m), phase: pd.phaseOf(deals, m), orgId: chosen.id, orgName: chosen.name,
    confirmed: !!(org || cur?.confirmed || chosen.score >= 0.95),
    openDealId: open?.id || null, openDealOwner: open ? m.users.find(u => u.id === (open.owner_id || open.user_id))?.name || "" : "",
    lostReason: lost?.lost_reason || "", lostAt: (lost?.lost_time || lost?.update_time || "").slice(0, 10) || null,
    dealCount: deals.length, candidates: candidates.filter(c => c.id !== chosen.id),
  });
}

export function unlinkSchool(id) {
  return setMatch(id, { status: "new", detail: "Sin coincidencia confirmada", orgId: null, orgName: null, confirmed: false, candidates: getMatch(id)?.candidates || [] });
}

// Para la lista (puede haber decenas de miles): solo lo que usa la interfaz. La ficha trae el resto.
const LIST_FIELDS = ["id", "name", "city", "country", "lat", "lng", "addr", "phone", "web", "rating", "found", "fit", "src"];
const BRAIN_PHASE = st => /^Churn/.test(st) ? "churn" : { Active: "activo", Onboarding: "onboarding", Closed: "cerrado" }[st] || null;
// Cruce efectivo: si OrderBrain dice que ya es cliente, manda eso aunque Pipedrive no lo tenga.
function effMatch(s) {
  const m = getMatch(s.id), fm = isFresh(m) ? m : null, b = brainOf(s);
  return b?.client ? { ...(fm || {}), status: "client", detail: `Cliente en OrderBrain (${b.label})`, checkedAt: new Date().toISOString() } : fm;
}
export function schoolListItem(s) {
  const full = schoolSummary(s), out = {};
  for (const k of [...LIST_FIELDS, "status", "detail", "orgId", "lastTouch", "attempts", "ob", "phase"]) if (full[k] !== undefined && full[k] !== "" && full[k] !== null) out[k] = full[k];
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
  return { ...s, status: b?.client ? "client" : fresh ? m.status : "unk", detail: b?.client ? `Cliente en OrderBrain (${b.label})` : m?.detail || "", orgId: m?.orgId || null, checkedAt: m?.checkedAt || null,
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
export async function ensureOrg(id) {
  const s = byId.get(id);
  await refreshMatch(id);
  let rec = await checkSchool(id);
  if (rec.orgId) return rec;
  return withLock("org:" + id, async () => {
    // otra instancia pudo haberla creado mientras esperábamos el candado
    await refreshMatch(id);
    rec = await checkSchool(id);
    if (rec.orgId) return rec;
    const org = await pd.createOrganization({
      name: s.name, website: s.web,
      address: { value: [s.addr, s.city, s.country].filter(Boolean).join(", "), locality: s.city, country: s.country },
    });
    return setMatch(id, { status: "org", detail: "Creado desde OrderBrain SDR", orgId: org.id, orgName: org.name || s.name, confirmed: true, openDealId: null, dealCount: 0, candidates: [], created: true });
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
  const mk = market(s.country);
  const today = todayIn(tz);
  const done = [];

  const rec = await ensureOrg(id);
  const orgUrl = `${pd.PD_WEB}/organization/${rec.orgId}`;
  done.push({ label: rec.created ? "Organización creada en Pipedrive" : `Guardado en ${rec.orgName}`, url: orgUrl });

  // Persona (decisor o contacto)
  let personId = null;
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
      note: `Agendada por ${esc(user.name || user.email)} desde OrderBrain SDR${raw ? "<br><br>" + esc(raw).replace(/\n/g, "<br>") : ""}` });
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
  html += `<br><br><i>Cargado por ${esc(user.name || user.email)} desde OrderBrain SDR</i>`;
  await pd.addNote({ content: html, orgId: rec.orgId, dealId, personId });
  done.push({ label: "Nota guardada" });

  // Etiqueta de interés en la organización
  if (o.interest && rec.status !== "client") await pd.updateOrganization(rec.orgId, { label_ids: [OPTIONS.orgLabel[o.interest]] }).catch(() => {});

  // Marca como hecha la actividad que motivó el contacto
  if (p.completeActivityId) { await pd.updateActivity(p.completeActivityId, { done: true }).catch(() => {}); done.push({ label: "Actividad pendiente marcada como hecha" }); }

  addTouch({ schoolId: id, by: user.email, byName: user.name || user.email, outcome: o.id, channel, connected: o.connected, text: raw.slice(0, 300), demo: o.id === "demo" });
  const fresh = await checkSchool(id, { force: true }).catch(() => getMatch(id));
  if (!fresh.confirmed) setMatch(id, { ...fresh, confirmed: true });
  return { ok: true, done, orgUrl, dealUrl: dealId ? `${pd.PD_WEB}/deal/${dealId}` : null, school: schoolSummary(s) };
}

// ---------- agenda propia
export async function myActivities(user) {
  if (!user.pdUserId) return { warning: "Tu email no coincide con ningún usuario de Pipedrive.", items: [] };
  const list = await pd.activities({ ownerId: user.pdUserId, done: false, limit: 500 });
  const o2s = orgToSchool();
  // Organizaciones que todavía no se cruzaron: se buscan por nombre exacto en la base de colegios.
  const unknown = [...new Set(list.map(a => a.org_id).filter(id => id && !o2s.has(id)))];
  if (unknown.length) {
    const byName = new Map(schools.map(s => [pd.norm(s.name), s.id]));
    for (const o of await pd.orgsByIds(unknown).catch(() => [])) { const sid = byName.get(pd.norm(o.name)); if (sid) o2s.set(o.id, sid); }
  }
  return { items: list.map(a => ({ id: a.id, subject: a.subject, type: a.type, typeLabel: TYPE_LABEL[a.type] || a.type, date: a.due_date, time: a.due_time || "", orgId: a.org_id, dealId: a.deal_id, schoolId: o2s.get(a.org_id) || null })) };
}

// ---------- cola de hoy: a quién contactar ahora
export function prospectQueue({ countries = [], limit = 40, excludeOrgIds = new Set() } = {}) {
  // perfiles livianos para la cola
  const out = [];
  for (const s of schools) {
    if (countries.length && !countries.includes(s.country)) continue;
    const m = getMatch(s.id);
    if (m?.orgId && excludeOrgIds.has(m.orgId)) continue;
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
