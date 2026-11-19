// Ficha completa, contexto para mensajes y «Qué pasó con OrderEAT».
import * as pd from "../pipedrive.js";
import { byId, getArchived, getMatch, mailsFor, setMatch, touchesFor } from "../store.js";
import { CLIENT_PIPES, LOST_REASONS, TYPE_LABEL, market } from "../config.js";
import { countAttempts, outcomeById, playbookFor, templates } from "../playbook.js";
import { todayIn } from "../time.js";
import { brainOf } from "../brain.js";
import { slackEnabled, slackFor } from "../slack.js";
import { addrPlace, linkedText } from "../merge.js";
import { bad } from "../text.js";
import { stripHtml } from "./util.js";
import { checkSchool } from "./match.js";
import { leadsHere } from "./settle.js";
import { linkedElsewhere, linkedSchools } from "./link.js";
import { effMatch, schoolSummary } from "./list.js";
import { sedeCache } from "./sedes.js";
import { mailOut } from "./mail.js";

// ---------- ficha completa
// Tratos abiertos: dueño, embudo y sus etapas (para moverlos desde la ficha) y cuál es «propuesta enviada» en ese embudo.
// Los embudos de clientes (onboarding, clientes, performance) no se tocan desde acá: van sin etapas y el servidor los rechaza.
const dealOps = (d, m) => ({ id: d.id, ownerId: Number(d.owner_id || d.user_id) || null, stageId: d.stage_id, clientPipe: CLIENT_PIPES.includes(Number(d.pipeline_id)),
  ...(d.status === "open" && !CLIENT_PIPES.includes(Number(d.pipeline_id)) ? { stages: pd.pipeStages(m, d.pipeline_id).map(x => ({ id: x.id, name: x.name })), proposalStage: pd.proposalStage(m, d.pipeline_id) } : {}) });
// «Preguntá por …»: lo último que dijo recepción, de un contacto registrado en la app o de una nota con «Preguntar por:».
// Solo lo que alguien escribió: si no hay, null.
const splitAsk = v => { const t = String(v || "").trim(), m = t.match(/^(.*?)\s*\(([^()]*)\)$/); return m ? { name: m[1].trim(), role: m[2].trim() } : { name: t, role: "" }; };
export function askFor(t, notes = []) {
  const x = [...t].reverse().find(y => y.ask?.name);
  const n = notes.map(n => ({ at: String(n.add_time || "").replace(" ", "T") + "Z", m: stripHtml(n.content).match(/Preguntar por:\s*([^\n]+)/) })).filter(n => n.m).sort((a, b) => b.at.localeCompare(a.at))[0];
  if (n && (!x || n.at > x.at)) { const a = splitAsk(n.m[1]); return a.name ? { ...a, at: n.at } : null; }
  return x ? { name: x.ask.name, role: x.ask.role || "", at: x.at } : null;
}
// Candidatas de «¿Es alguna de estas organizaciones?»: ciudad y dueño en Pipedrive, si la dirección es de otra ciudad y
// a qué otro colegio de la base ya está vinculada. { [orgId]: { place, ownerId, owner, other, linked } }; null si no hay
// candidatas o no se pudo leer (la lista sale igual, sin esos datos).
async function candInfo(s, rec) {
  const c = !rec.confirmed ? rec.candidates || [] : [];
  if (!c.length) return null;
  const [orgs, m] = await Promise.all([pd.orgsByIds(c.map(x => Number(x.id))), pd.meta()]).catch(() => [null, null]);
  if (!orgs) return null;
  const linked = linkedElsewhere(s.id);
  return Object.fromEntries(orgs.map(o => [o.id, { place: [o.city, o.region].filter(Boolean).join(", ") || (o.country && o.country !== s.country ? o.country : ""),
    ownerId: o.ownerId || null, owner: o.ownerId ? m.users.find(u => u.id === o.ownerId)?.name || "" : "", other: addrPlace(s, o) === "other",
    linked: linkedText(linkedSchools(linked.get(o.id))) }]));
}
export async function schoolDetail(id, { user, tz, ...opts } = {}) {
  const s = byId.get(id);
  const rec = await checkSchool(id, opts);
  const t = touchesFor(id);
  // Con el cruce resuelto, todo lo demás se pide JUNTO (antes eran cuatro tandas, una atrás de otra: candidatas, mails, las
  // lecturas de la ficha y los prospectos de la organización). Nada de esto depende de lo otro: solo de `rec`.
  const candsP = candInfo(s, rec), mailsP = mailsFor(id).catch(() => []);
  // mails enviados desde la ficha (Historial los muestra como una sola entrada, con el cuerpo)
  const baseOf = (cands, mails) => ({
    match: rec, cands, school: schoolSummary(s), market: market(s.country), playbook: playbookFor(s, effMatch(s) || rec), brain: brainOf(s),
    attempts: countAttempts(t), touches: t.slice(-15).reverse().map(x => ({ at: x.at, by: x.byName, outcome: outcomeById(x.outcome)?.label || x.outcome, channel: x.channel, text: x.text || "", ...(x.mailId ? { mailId: x.mailId, to: x.to || "" } : {}) })),
    lostReasons: LOST_REASONS, today: todayIn(tz), archive: getArchived(id),
    mails: mails.slice(-15).reverse().map(mailOut),
  });
  if (s.leadOnly) {
    const [cands, mails, notes, lead, acts, m] = await Promise.all([candsP, mailsP, pd.notesForLead(s.leadId).catch(() => []), pd.leadsByIds([s.leadId], user?.pdUserId).then(l => l[0] || null).catch(() => null),
      pd.activities({ leadId: s.leadId, done: false, limit: 20 }).catch(() => []), pd.meta().catch(() => ({ users: [] }))]);
    const base = baseOf(cands, mails);
    const persons = s.personId ? [{ id: s.personId, name: s.personName, phone: s.phone || "", email: s.email || "" }] : [];
    const uname = uid => m.users.find(u => u.id === uid)?.name || "";
    // leadOwnerId: dueño del prospecto (null: libre); sin dato, no va (la ficha no ofrece archivarlo salvo a un líder)
    // lo pendiente del prospecto (Historial lo muestra en «Pendientes», como en una organización)
    const activities = acts.filter(a => !a.done).map(a => ({ id: a.id, subject: a.subject, type: a.type, typeLabel: TYPE_LABEL[a.type] || a.type, date: a.due_date, time: a.due_time || "", owner: uname(a.owner_id), ownerId: a.owner_id }));
    return { ...base, lead: true, orgUrl: `${pd.PD_WEB}/leads/inbox/${s.leadId}`, deals: [], activities, persons, askFor: askFor(t, notes), ...(lead ? { leadOwnerId: lead.ownerId || null } : {}),
      notes: notes.map(n => ({ at: n.add_time, author: n.user?.name || "", deal: "", text: stripHtml(n.content).slice(0, 900) })),
      templates: templates(s, { me: user?.name, contact: s.personName || "" }) };
  }
  if (!rec.orgId) { const [cands, mails] = await Promise.all([candsP, mailsP]); return { ...baseOf(cands, mails), deals: [], notes: [], activities: [], persons: [], askFor: askFor(t), templates: templates(s, { me: user?.name }) }; }
  // prospectos abiertos de la organización: si ya hay uno, no se ofrece crear otro (evita duplicados)
  const [cands, mails, deals, notes, acts, persons, m, open] = await Promise.all([candsP, mailsP, pd.dealsForOrg(rec.orgId), pd.notesForOrg(rec.orgId), pd.activities({ orgId: rec.orgId, done: false, limit: 20 }),
    pd.personsForOrg(rec.orgId).catch(() => []), pd.meta(), leadsHere(s, rec.orgId).catch(() => [])]);
  const base = baseOf(cands, mails);
  const uname = uid => m.users.find(u => u.id === uid)?.name || "";
  const leads = open.map(l => ({ id: l.id, title: l.title, ownerId: l.ownerId || null, owner: uname(l.ownerId), url: `${pd.PD_WEB}/leads/inbox/${l.id}` }));
  if (leads.length === 1 && !getMatch(id)?.leadId) { const mm = getMatch(id); if (mm?.orgId === rec.orgId) setMatch(id, { ...mm, leadId: leads[0].id }); }
  return {
    ...base, orgUrl: `${pd.PD_WEB}/organization/${rec.orgId}`, persons, leads, askFor: askFor(t, notes),
    templates: templates(s, { me: user?.name, contact: persons[0]?.name || "" }),
    deals: deals.map(d => ({ id: d.id, title: d.title, status: d.status, pipeline: m.pipes[d.pipeline_id] || "", stage: m.stages[d.stage_id] || "", lostReason: d.lost_reason, owner: uname(d.owner_id || d.user_id), updated: (d.update_time || "").slice(0, 10), url: `${pd.PD_WEB}/deal/${d.id}`, ...dealOps(d, m) })),
    notes: notes.map(n => ({ at: n.add_time, author: n.user?.name || "", deal: n.deal?.title || "", text: stripHtml(n.content).slice(0, 900) })),
    activities: acts.map(a => ({ id: a.id, subject: a.subject, type: a.type, typeLabel: TYPE_LABEL[a.type] || a.type, date: a.due_date, time: a.due_time || "", owner: uname(a.owner_id), ownerId: a.owner_id })),
  };
}

// Lo que sabe Pipedrive de un colegio, en texto corto, para redactar mensajes con contexto (IA).
export async function draftContext(id, user = {}) {
  const s = byId.get(id); if (!s) return "";
  const m = effMatch(s) || getMatch(id) || {}, out = [];
  out.push(`Estado: ${m.detail || m.status || "sin datos"}${s.ob?.label ? ` · World Dominion: ${s.ob.label}` : ""}`);
  const [notes, deals, persons] = await Promise.all([
    s.leadOnly ? pd.notesForLead(s.leadId, 6).catch(() => []) : m.orgId ? pd.notesForOrg(m.orgId, 6).catch(() => []) : [],
    m.orgId ? pd.dealsForOrg(m.orgId).catch(() => []) : [],
    m.orgId ? pd.personsForOrg(m.orgId).catch(() => []) : [],
  ]);
  if (deals.length) out.push("Tratos: " + deals.slice(0, 4).map(d => `${d.title} (${d.status === "won" ? "ganado" : d.status === "lost" ? `perdido${d.lost_reason ? `: ${d.lost_reason}` : ""}` : "abierto"})`).join("; "));
  if (persons.length) out.push("Personas: " + persons.slice(0, 5).map(p => p.name).join(", "));
  if (notes.length) out.push("Notas (de la más nueva):\n" + notes.map(n => `- ${(n.add_time || "").slice(0, 10)}: ${stripHtml(n.content).replace(/\s+/g, " ").slice(0, 350)}`).join("\n"));
  const t = touchesFor(id).slice(-4).reverse();
  if (t.length) out.push("Contactos registrados en la app:\n" + t.map(x => `- ${x.at.slice(0, 10)} ${x.channel}: ${outcomeById(x.outcome)?.label || x.outcome}${x.text ? ` · ${x.text.slice(0, 200)}` : ""}`).join("\n"));
  const sd = sedeCache.get(id)?.v?.sedes || [];
  if (sd.length) {
    out.push(`Sedes: ${sd.map(x => x.name).join("; ")}`);
    // lo hablado en las otras sedes de la misma red (suele ser la misma gente o la misma concesión)
    const src = sd.filter(x => !x.here && (!x.ownerId || x.ownerId === user.pdUserId)).flatMap(x => [x.orgId && x.orgId !== m.orgId && { org: x.orgId, name: x.name }, ...x.leads.map(l => ({ lead: l.id, name: x.name }))]).filter(Boolean).slice(0, 4);
    const more = await Promise.all(src.map(async x => (await (x.org ? pd.notesForOrg(x.org, 2) : pd.notesForLead(x.lead, 2)).catch(() => [])).map(n => `- ${x.name}, ${(n.add_time || "").slice(0, 10)}: ${stripHtml(n.content).replace(/\s+/g, " ").slice(0, 300)}`)));
    if (more.flat().length) out.push("Notas de otras sedes:\n" + more.flat().join("\n"));
  }
  return out.join("\n");
}

// ---------- Qué pasó con OrderEAT: para un cliente, un onboarding o un churn (o algo perdido), lo que dicen World Dominion,
// Pipedrive (tratos y notas de la organización vinculada y de sus duplicadas con el mismo nombre) y Slack (si está conectado).
// la organización vinculada (primera) y las duplicadas con el mismo nombre (de la búsqueda, hasta 10)
async function relatedOrgIds(rec) {
  let orgIds = rec.orgId ? [rec.orgId] : [];
  if (rec.orgName) {
    const same = (await pd.searchOrganizations(rec.orgName, 10).catch(() => [])).filter(o => pd.norm(o.name) === pd.norm(rec.orgName)).map(o => o.id);
    orgIds = [...new Set([...orgIds, ...same])];
  }
  return orgIds;
}
// De esas, las que pueden ser este colegio (hasta 4): nunca las de otra ciudad u otro país (su dirección en Pipedrive, como
// en lib/merge.js). sure: la vinculada o una de la misma ciudad; sin ciudad en la dirección, sure false (en el Historial va
// a la lista pero no al resumen). Si no se pueden leer las direcciones, solo la vinculada.
export async function relatedOrgs(s, rec) {
  const ids = await relatedOrgIds(rec); if (!ids.length) return [];
  const main = ids[0], list = ids.length > 1 ? await pd.orgsByIds(ids).catch(() => null) : [];
  if (!list) return [{ id: main, name: rec.orgName || "", main: true, sure: true }];
  return ids.map(id => list.find(o => Number(o.id) === Number(id)) || (id === main ? { id, name: rec.orgName || "" } : null)).filter(Boolean)
    .map(o => ({ id: o.id, name: o.name, main: o.id === main, place: o.id === main ? "same" : addrPlace(s, o) }))
    .filter(o => o.main || o.place !== "other").slice(0, 4).map(o => ({ id: o.id, name: o.name, main: o.main, sure: o.main || o.place === "same" }));
}
export async function historyFor(id) {
  const s = byId.get(id); if (!s) throw bad("Colegio inexistente", 404);
  const ob = brainOf(s), rec = getMatch(id) || {};
  const orgIds = (await relatedOrgs(s, rec)).map(o => o.id);
  const m = await pd.meta().catch(() => ({ users: [], pipes: {}, stages: {} })), uname = uid => m.users.find(u => u.id === uid)?.name || "";
  const [deals, notes, slack] = await Promise.all([
    Promise.all(orgIds.map(o => pd.dealsForOrg(o).catch(() => []))).then(x => x.flat()),
    Promise.all(orgIds.map(o => pd.notesForOrg(o, 6).catch(() => []))).then(x => x.flat()),
    slackFor([s.name, ob?.site], s.city).catch(e => ({ msgs: [], error: e.message })),
  ]);
  const d10 = v => v ? String(v).slice(0, 10) : "";
  return {
    brain: ob ? { label: ob.label, status: ob.status, client: ob.clientName, site: ob.site, start: ob.start, info: ob.info || {} } : null,
    orgs: orgIds.length,
    deals: deals.sort((a, b) => String(b.add_time).localeCompare(String(a.add_time))).map(d => ({
      title: d.title, pipeline: m.pipes[d.pipeline_id] || "", stage: m.stages[d.stage_id] || "", status: d.status, lostReason: d.lost_reason || "",
      added: d10(d.add_time), won: d10(d.won_time), lost: d10(d.lost_time), owner: uname(d.owner_id || d.user_id), clientPipe: CLIENT_PIPES.includes(d.pipeline_id), url: `${pd.PD_WEB}/deal/${d.id}`, ...dealOps(d, m) })),
    notes: notes.sort((a, b) => String(b.add_time).localeCompare(String(a.add_time))).slice(0, 6).map(n => ({ at: d10(n.add_time), author: n.user?.name || "", deal: n.deal?.title || "", text: stripHtml(n.content).replace(/\n{3,}/g, "\n\n").slice(0, 700) })),
    slack, slackEnabled: slackEnabled(),
  };
}
