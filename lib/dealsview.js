// Tratos abiertos (vista «Tratos abiertos», #/tratos; pedido del líder de SDR: «que sea utilizable por los accounts»).
// Lógica pura: qué tratos entran (embudos de venta, sin los de clientes ni etapas muertas), cómo se arma cada fila (etapa en
// su orden, días en la etapa, próxima actividad en la zona de quien mira, última hecha, propuesta enviada), los indicadores
// y el alcance (míos, una persona, el equipo o toda la cuenta) con las mismas reglas que Métricas y Equipo (lib/teams.js).
// Nunca se inventa: lo que no se sabe va null (la pantalla no lo muestra o pone «?»). Pruebas en test/dealsview.test.mjs.
import { CLIENT_PIPES, DEAD_STAGES } from "./config.js";
import { isoUtc, localDay, userId } from "./metrics.js";
import { fromUtc, safeTz, todayIn } from "./time.js";
import { pickTeam, filterOf, canLead, TEAMS_DOWN } from "./teams.js";
import { lc } from "./text.js";

export const STALE_DAYS = 14;
const err = (status, error) => ({ error: { status, error } });

// abierto y de un embudo de venta: ni los de clientes (ONBOARDING, MX - Clientes, PERFORMANCE) ni las etapas muertas
export const isSalesOpen = (d, { clientPipes = CLIENT_PIPES, deadStages = DEAD_STAGES } = {}) =>
  !!d && d.status === "open" && !d.deleted && !clientPipes.includes(Number(d.pipeline_id)) && !deadStages.includes(Number(d.stage_id));

// días enteros desde que entró a la etapa (stage_change_time; si nunca cambió, desde que se creó). null si no se sabe.
export function daysIn(d, now = Date.now()) {
  const t = Date.parse(isoUtc(d?.stage_change_time || d?.add_time) || "");
  return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / 864e5)) : null;
}
export const isStale = days => days != null && days > STALE_DAYS;

// hora de ahora en la zona de quien mira
export function nowIn(tz, now = Date.now()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: safeTz(tz), hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(now)).map(x => [x.type, x.value]));
  return { date: todayIn(tz, now), hm: `${p.hour}:${p.minute}` };
}
// una actividad sin hacer, en la zona de quien mira: vencida si su día ya pasó o, con hora, si ya pasó la hora (una sin hora
// vence al terminar su día, como en Pipedrive)
export function nextView(a, tz, now = Date.now()) {
  if (!a || a.done || !a.due_date) return null;
  const l = fromUtc(a.due_date, String(a.due_time || "").slice(0, 5), tz), n = nowIn(tz, now);
  const overdue = l.date < n.date || (l.date === n.date && !!l.time && l.time < n.hm);
  return { id: a.id, type: a.type || "", subject: a.subject || "", date: l.date, time: l.time || "", overdue, today: l.date === n.date };
}
// la última hecha: su día (el que se marcó hecha; si no, su vencimiento) y su tipo
export function lastView(a, tz) {
  if (!a || !a.done) return null;
  const date = (a.done_time && localDay(a.done_time, tz)) || (a.due_date ? fromUtc(a.due_date, String(a.due_time || "").slice(0, 5), tz).date : "");
  return date ? { id: a.id, type: a.type || "", date } : null;
}

// etapas de un embudo en orden; la de propuesta por nombre (como pd.proposalStage)
export const stagesOf = (stageList, pipeId) => (stageList || []).filter(x => Number(x.pipe) === Number(pipeId)).sort((a, b) => a.order - b.order || a.id - b.id);
const PROPOSAL = /^(proposal sent|propuesta enviada)$/i;
// ¿ya se mandó la propuesta? en la etapa de propuesta o después (HOT DEALS, CLOSING). Un embudo sin esa etapa (LatAm): null.
export function proposalSent(stageList, pipeId, stageId) {
  const l = stagesOf(stageList, pipeId), i = l.findIndex(x => PROPOSAL.test(String(x.name).trim())), j = l.findIndex(x => Number(x.id) === Number(stageId));
  return i < 0 || j < 0 ? null : j >= i;
}

// Una fila por trato. ctx: { stageList, pipes {id: nombre}, name(id) → nombre o "", orgs Map(id → { name }), schools Map(orgId →
// { id, name, city }), acts Map(id → actividad), tz, now }
export function dealRow(d, ctx) {
  const st = (ctx.stageList || []).find(x => Number(x.id) === Number(d.stage_id)) || null;
  const order = st ? stagesOf(ctx.stageList, d.pipeline_id).findIndex(x => x.id === st.id) : -1;
  const org = d.org_id ? { id: Number(d.org_id), name: ctx.orgs?.get(Number(d.org_id))?.name || "" } : null;
  const sch = d.org_id ? ctx.schools?.get(Number(d.org_id)) || null : null;
  const nx = d.next_activity_id ? ctx.acts?.get(Number(d.next_activity_id)) : null, la = d.last_activity_id ? ctx.acts?.get(Number(d.last_activity_id)) : null;
  const days = daysIn(d, ctx.now), sdr = userId(d.sdr), owner = userId(d.owner_id), val = Number(d.value);
  const next = nextView(nx, ctx.tz, ctx.now);
  return {
    id: d.id, title: d.title || "", org, school: sch ? { id: sch.id, name: sch.name || "", city: sch.city || "" } : null,
    pipe: { id: Number(d.pipeline_id), name: ctx.pipes?.[d.pipeline_id] || "" }, stage: { id: Number(d.stage_id), name: st?.name || "", order },
    value: Number.isFinite(val) && val > 0 ? val : null, currency: val > 0 ? String(d.currency || "") : "",
    owner: owner ? { id: owner, name: ctx.name?.(owner) || "" } : null, sdr: sdr ? { id: sdr, name: ctx.name?.(sdr) || "" } : null,
    days, stale: isStale(days), created: d.add_time ? localDay(d.add_time, ctx.tz) || null : null,
    next,
    // tiene próxima en Pipedrive pero no se pudo leer (borrada, o ya hecha y Pipedrive todavía no la cambió): no se sabe
    nextUnknown: !!d.next_activity_id && !next,
    last: lastView(la, ctx.tz),
    proposal: proposalSent(ctx.stageList, d.pipeline_id, d.stage_id),
  };
}

// indicadores: cantidad, valor por moneda (solo los que tienen valor), sin próxima, quietos y con próxima vencida
export function summarize(rows) {
  const by = new Map();
  for (const r of rows) if (r.value != null) by.set(r.currency || "?", (by.get(r.currency || "?") || 0) + r.value);
  return {
    n: rows.length,
    value: [...by].map(([currency, total]) => ({ currency, total })).sort((a, b) => b.total - a.total),
    noValue: rows.filter(r => r.value == null).length,
    noNext: rows.filter(r => !r.next && !r.nextUnknown).length,
    stale: rows.filter(r => r.stale).length,
    overdue: rows.filter(r => r.next?.overdue).length,
  };
}

// embudos con tratos, de más a menos, cada uno con TODAS sus etapas en orden (con cuántos hay en cada una)
export function pipesView(rows, stageList, pipes = {}) {
  const n = new Map(), byStage = new Map();
  for (const r of rows) { n.set(r.pipe.id, (n.get(r.pipe.id) || 0) + 1); byStage.set(r.stage.id, (byStage.get(r.stage.id) || 0) + 1); }
  return [...n].map(([id, k]) => {
    const st = stagesOf(stageList, id).map(s => ({ id: s.id, name: s.name, n: byStage.get(s.id) || 0 }));
    // una etapa que ya no está en la lista de Pipedrive (borrada o de otro embudo): al final, para no perder tratos
    for (const r of rows) if (r.pipe.id === id && !st.some(s => s.id === r.stage.id)) st.push({ id: r.stage.id, name: r.stage.name || "?", n: byStage.get(r.stage.id) || 0 });
    return { id, name: pipes[id] || "", n: k, stages: st };
  }).sort((a, b) => b.n - a.n || String(a.name).localeCompare(String(b.name), "es"));
}
// orden de una lista: por etapa (embudo y orden), días en etapa, próxima actividad o valor
export function sortRows(rows, by = "stage") {
  const nk = r => r.next ? `${r.next.date} ${r.next.time || "99:99"}` : r.nextUnknown ? "9998" : "9999";
  const f = {
    stage: (a, b) => a.pipe.id - b.pipe.id || a.stage.order - b.stage.order || (b.days ?? -1) - (a.days ?? -1),
    days: (a, b) => (b.days ?? -1) - (a.days ?? -1),
    next: (a, b) => nk(a).localeCompare(nk(b)),
    value: (a, b) => (b.value ?? -1) - (a.value ?? -1),
  }[by] || (() => 0);
  return [...rows].sort((a, b) => f(a, b) || a.id - b.id);
}

// ---------- alcance. owner: "me" (o vacío, o tu id), el id de Pipedrive de una persona, o "team" (con team: el equipo elegido).
// v: viewerFor(...) de server.js; T: los equipos; lead: leadScopeFor (true, false o { ids, emails }); users: los de Pipedrive.
// Devuelve { kind: "person", id, email, self } | { kind: "team", id, filter } | { kind: "all" } o { error: { status, error } }.
export function scopeOf({ v, T, lead = false, users = [], me = {}, owner = "me", team = "" }) {
  owner = String(owner ?? "").trim() || "me";
  const meId = Number(me.pdUserId) || null;
  if (owner === "me" || (meId && owner === String(meId))) {
    if (!meId) return err(409, "Tu email no es usuario del Pipedrive de OrderEAT: no hay tratos a tu nombre.");
    return { kind: "person", id: meId, email: lc(me.email), self: true };
  }
  if (owner === "team") {
    if (!v?.leader) return v?.unknown ? { error: TEAMS_DOWN } : err(403, "Los tratos del equipo los ven los líderes y dirección. Vos ves los tuyos.");
    const p = pickTeam(v, T, String(team || ""));
    if (p.error) return { error: p.error };
    return p.id ? { kind: "team", id: p.id, filter: filterOf(T, [p.id], users) } : { kind: "all" };
  }
  if (!/^\d+$/.test(owner)) return err(400, "¿De quién son los tratos?");
  const u = users.find(x => Number(x.id) === Number(owner));
  if (!u) return err(404, "Esa persona no es usuaria del Pipedrive de OrderEAT.");
  if (!v?.leader) return err(403, "Ves solo tus tratos.");
  if (!canLead(lead, { id: u.id, email: u.email })) return err(403, "Esa persona no es de tu equipo: sus tratos los ve su líder o dirección.");
  return { kind: "person", id: Number(u.id), email: lc(u.email), self: false };
}
// ¿el trato entra en el alcance? Una persona: dueño o SDR. Un equipo: dueño o SDR de su gente. Toda la cuenta: todos.
export function inScope(d, s) {
  if (!s || s.error) return false;
  if (s.kind === "all") return true;
  const o = userId(d.owner_id), r = userId(d.sdr);
  if (s.kind === "person") return o === s.id || r === s.id;
  if (s.kind === "team") return (o != null && !!s.filter?.ids?.has(o)) || (r != null && !!s.filter?.ids?.has(r));
  return false;
}
// qué leer de Pipedrive: los de un dueño (v2 /deals?owner_id=, menos páginas) solo para un Account Executive (rara vez
// figura como SDR); un SDR, un equipo o toda la cuenta necesitan todos los abiertos (el campo SDR no se puede filtrar en v2)
export const readPlan = (s, role = "") => s?.kind === "person" && role === "ae" ? { ownerId: s.id } : { all: true };
// a quién puede elegir en «Persona»: todos (dirección, fijos o sin equipos), su gente (líder de equipo) o nadie
export function peopleFor(lead, users = [], meId = null) {
  if (lead === true) return users.map(u => ({ id: Number(u.id), name: u.name || "" }));
  if (lead && typeof lead === "object") return users.filter(u => Number(u.id) === Number(meId) || canLead(lead, { id: u.id, email: u.email })).map(u => ({ id: Number(u.id), name: u.name || "" }));
  return [];
}
