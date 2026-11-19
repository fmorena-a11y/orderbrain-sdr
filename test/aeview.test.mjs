// «Hoy» del account (lib/aeview.js, lib/ae-api.js): demos de hoy, de mañana y sin marcar en la zona de quien mira, tareas
// vencidas y de hoy agrupadas por trato, tratos que piden atención (cada uno una vez, el motivo más grave primero), la sesión
// «Tus tratos», el resumen y los «?» cuando Pipedrive corta una lista. Al final, las rutas GET /api/ae/today y /api/ae/deals
// contra el Pipedrive de prueba (DEMO_MODE), sin red: cada uno ve solo lo suyo.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
for (const k of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "PIPEDRIVE_API_TOKEN", "ANTHROPIC_API_KEY", "READ_ONLY", "BRAIN_TOKEN", "LEADER_EMAILS", "FOUNDER_EMAILS", "ALLOWED_EMAIL_DOMAIN", "CLIENT_PIPELINE_IDS", "DEAD_STAGE_IDS"]) delete process.env[k];
Object.assign(process.env, { DEMO_MODE: "1", SESSION_SECRET: "clave-de-prueba", VERCEL: "1", DEV_LOGIN_EMAIL: "demo@ordereat.com", TEAM_ACCESS_CODE: "equipo-prueba", DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "ob-ae-")) });
const AE = await import("../lib/aeview.js");

// ---------- lo puro. Lunes 16/11/2026, 12:00 en Ciudad de México (18:00 UTC)
const NOW = Date.parse("2026-11-16T18:00:00Z"), TZ = "America/Mexico_City";
// una actividad como las de sales.myActivities (fecha y hora en UTC)
let n = 100;
const act = (type, date, time = "", o = {}) => ({ id: n++, type, typeLabel: { meeting: "Demo", call: "Llamada", task: "Mail" }[type] || type, subject: `${type} ${date}`, date, time, orgId: null, dealId: null, schoolId: null, who: "", record: null, url: "https://pd/x", city: "", ...o });
// una fila como las de dealRow
const row = (id, o = {}) => ({ id, title: `Trato ${id}`, org: { id: 900 + id, name: `Org ${id}` }, school: null, pipe: { id: 9, name: "MX - SALES" }, stage: { id: 160, name: "SELLING", order: 0 },
  value: 1000, currency: "MXN", days: 3, stale: false, next: { id: 1, type: "call", subject: "", date: "2026-11-18", time: "", overdue: false, today: false }, nextUnknown: false, last: null, proposal: false, ...o });

test("weekOf: lunes a domingo, también desde un domingo o cruzando el mes", () => {
  assert.deepEqual(AE.weekOf("2026-11-16"), { from: "2026-11-16", to: "2026-11-22" });
  assert.deepEqual(AE.weekOf("2026-11-22"), { from: "2026-11-16", to: "2026-11-22" });
  assert.deepEqual(AE.weekOf("2026-12-02"), { from: "2026-11-30", to: "2026-12-06" });
});
test("localOf: la hora UTC de Pipedrive pasa a la zona de quien mira; vencida y «ya pasó»", () => {
  const l = a => { const x = AE.localOf(a, TZ, NOW); return [x.date, x.time, x.today, x.late, x.past]; };
  assert.deepEqual(l(act("meeting", "2026-11-17", "02:00")), ["2026-11-16", "20:00", true, false, false], "02:00 UTC del 17 son las 20:00 del 16 en México");
  assert.deepEqual(l(act("meeting", "2026-11-16", "16:00")), ["2026-11-16", "10:00", true, false, true], "a las 10:00 ya pasó");
  assert.deepEqual(l(act("call", "2026-11-16")), ["2026-11-16", "", true, false, true], "sin hora y de hoy: ya se puede marcar, no está vencida");
  assert.deepEqual(l(act("call", "2026-11-13")), ["2026-11-13", "", false, true, true]);
  assert.deepEqual(l(act("call", "2026-11-17")), ["2026-11-17", "", false, false, false]);
});
test("completeUntil: con 500 justas la lista pudo cortarse; solo se sabe hasta antes de la última", () => {
  const list = k => Array.from({ length: k }, (_, i) => act("call", i < k - 1 ? "2026-11-01" : "2026-11-20"));
  assert.equal(AE.completeUntil(list(10), "2026-11-30", 500), true, "menos del tope: está entera");
  assert.equal(AE.completeUntil(list(5), "2026-11-16", 5), true, "cortada, pero la última vence el 20: hasta el 16 está todo");
  assert.equal(AE.completeUntil(list(5), "2026-11-19", 5), false, "un día de margen por la zona horaria");
  assert.equal(AE.completeUntil(list(5), "2026-11-22", 5), false);
});
test("demoSections: hoy, mañana y las de antes sin marcar; la de hoy que ya pasó se puede marcar; nada que no sea demo", () => {
  const deals = new Map([[7, row(7, { school: { id: "cdmx-colegio-uno", name: "Colegio Uno", city: "CDMX" }, stage: { id: 159, name: "PROPOSAL SENT", order: 1 } })]]);
  const acts = [act("meeting", "2026-11-16", "16:00", { dealId: 7 }), act("meeting", "2026-11-16", "23:00", { who: "Colegio Dos", record: "org:55" }), act("meeting", "2026-11-17", "15:00"),
    act("meeting", "2026-11-18", "15:00"), act("meeting", "2026-11-12", "15:00"), act("meeting", "2026-11-10", ""), act("call", "2026-11-16", "15:00"), act("meeting", "2026-11-17", "02:30")];
  const d = AE.demoSections(acts, { tz: TZ, now: NOW, deals });
  assert.deepEqual(d.today.map(a => [a.time, a.past]), [["10:00", true], ["17:00", false], ["20:30", false]], "la de las 02:30 UTC del 17 es de hoy a las 20:30");
  assert.deepEqual(d.tomorrow.map(a => a.time), ["09:00"]);
  assert.deepEqual(d.unmarked.map(a => a.date), ["2026-11-12", "2026-11-10"], "sin marcar: la más reciente primero");
  // el trato y a dónde lleva: el colegio cruzado del trato, o la ficha de la organización
  assert.deepEqual([d.today[0].deal.stage, d.today[0].schoolId, d.today[0].record, d.today[0].who, d.today[0].city], ["PROPOSAL SENT", "cdmx-colegio-uno", null, "Colegio Uno", "CDMX"]);
  assert.deepEqual([d.today[1].deal, d.today[1].schoolId, d.today[1].record], [null, null, "org:55"]);
});
test("weekDemos: las de la semana una vez cada una, hechas, no show, canceladas, por dar y sin marcar (regla de Métricas)", () => {
  const mark = k => `[Resultado de la demo] ${{ done: "Se hizo", noshow: "No se presentó", canceled: "Se canceló" }[k]} · marcado por X desde OrderBrain SDR el 16/11`;
  const pending = [act("meeting", "2026-11-16", "16:00"), act("meeting", "2026-11-16", "23:00"), act("meeting", "2026-11-20", "15:00"), act("meeting", "2026-11-23", "15:00"), act("meeting", "2026-11-13", "15:00"), act("call", "2026-11-17")];
  const done = [{ id: 1, type: "meeting", due_date: "2026-11-16", due_time: "14:00", note: "" }, { id: 2, type: "lunch", due_date: "2026-11-16", due_time: "", note: "" },
    { id: 3, type: "meeting", due_date: "2026-11-17", due_time: "01:00", note: mark("canceled") }, { id: 4, type: "meeting", due_date: "2026-11-16", due_time: "15:00", mark: "noshow" },
    { id: 5, type: "meeting", due_date: "2026-11-15", due_time: "15:00", note: mark("done") }, { id: 6, type: "call", due_date: "2026-11-16", due_time: "", note: "" }, { id: 1, type: "meeting", due_date: "2026-11-16", due_time: "14:00", note: "" }];
  assert.deepEqual(AE.weekDemos(pending, done, { tz: TZ, now: NOW }), { total: 7, held: 1, noshow: 2, canceled: 1, upcoming: 2, unmarked: 1, from: "2026-11-16", to: "2026-11-22" });
  // una de hoy sin hora todavía no se sabe si pasó: cuenta como «por dar», no como sin marcar
  assert.deepEqual([AE.weekDemos([act("meeting", "2026-11-16")], [], { tz: TZ, now: NOW })].map(w => [w.total, w.upcoming, w.unmarked]), [[1, 1, 0]]);
});
test("taskGroups: lo vencido y lo de hoy que no es demo, por trato, la más vieja primero", () => {
  const deals = new Map([[7, row(7, { days: 9 })], [8, row(8)]]);
  const acts = [act("task", "2026-11-16", "", { dealId: 7 }), act("call", "2026-11-10", "", { dealId: 7 }), act("call", "2026-11-13", "", { dealId: 8 }), act("call", "2026-11-05", "", { schoolId: "cdmx-x", who: "X" }),
    act("call", "2026-11-12", "", { schoolId: "cdmx-x", who: "X" }), act("call", "2026-11-14", "", { dealId: 99, who: "De otro" }), act("task", "2026-11-11"), act("call", "2026-11-17", "", { dealId: 7 }), act("meeting", "2026-11-10", "", { dealId: 7 })];
  const g = AE.taskGroups(acts, { tz: TZ, now: NOW, deals });
  assert.deepEqual(g.map(x => [x.key.replace(/\d+$/, m => (x.key.startsWith("a") ? "" : m)), x.items.length, x.late, x.oldest]), [["scdmx-x", 2, 2, "2026-11-05"], ["d7", 2, 1, "2026-11-10"], ["a", 1, 1, "2026-11-11"], ["d8", 1, 1, "2026-11-13"], ["d99", 1, 1, "2026-11-14"]]);
  assert.deepEqual(g[1].items.map(a => [a.date, a.late, a.today]), [["2026-11-10", true, false], ["2026-11-16", false, true]], "dentro del trato, la más vieja primero; la de mañana y la demo no entran");
  assert.deepEqual([g[1].deal.days, g[1].name, g[1].record], [9, "Org 7", "org:907"], "sin colegio cruzado abre la organización del trato");
  assert.deepEqual([g[4].deal, g[4].dealId, g[4].name], [null, 99, "De otro"], "una tarea en un trato que no es tuyo (o ya cerrado): sin datos del trato");
});
test("reasonsOf y attention: cada trato una vez, el motivo más grave primero; lo que no se sabe no cuenta", () => {
  const late = { id: 2, type: "call", subject: "", date: "2026-11-10", time: "", overdue: true, today: false }, later = { ...late, date: "2026-11-14" };
  const rows = [
    row(1), // al día
    row(2, { stale: true, days: 20 }), // solo quieto
    row(3, { next: null }), // sin próximo paso
    row(4, { next: later }), // próxima vencida
    row(5, { next: late, value: 5 }), // vencida hace más
    row(6, { proposal: true, next: null, stale: true, days: 30 }), // propuesta sin nada por delante y quieto
    row(7, { proposal: true, next: late }), // propuesta con la próxima vencida
    row(8, { proposal: true }), // propuesta con seguimiento al día: no pide atención
    row(9, { next: null, nextUnknown: true }), // Pipedrive dice que tiene una y no se leyó: no se sabe
    row(10, { next: null, nextUnknown: true, stale: true, days: 40 }), // …pero quieto sí se sabe
    row(11, { proposal: null, next: null, days: 16, stale: true }), // embudo sin etapa de propuesta (LatAm)
    row(12, { next: null, value: null, currency: "" }),
  ];
  assert.deepEqual(rows.map(r => AE.reasonsOf(r).join("+")), ["", "stale", "noNext", "overdue", "overdue", "proposal+noNext+stale", "proposal+overdue", "", "", "stale", "noNext+stale", "noNext"]);
  const att = AE.attention(rows);
  assert.deepEqual(att.map(r => r.id), [6, 7, 5, 4, 11, 3, 12, 10, 2], "propuesta sin seguimiento, vencidas (la más vieja antes), sin próximo paso (lo más quieto antes) y quietos");
  assert.equal(new Set(att.map(r => r.id)).size, att.length);
  assert.deepEqual(att[0].why, ["proposal", "noNext", "stale"]);
});
test("sessionItems: el colegio cruzado, la organización, la de su persona o «deal:» (se saltea); dos tratos de una organización, un ítem", () => {
  const list = [row(1, { school: { id: "cdmx-uno", name: "Colegio Uno", city: "CDMX" } }), row(2), row(3, { org: null }), row(4, { org: null }), row(5, { org: { id: 902, name: "Org 2" } })];
  assert.deepEqual(AE.sessionItems(list, r => (r.id === 3 ? 777 : null)), [
    { ref: "cdmx-uno", name: "Colegio Uno", city: "CDMX", deal: 1 }, { ref: "org:902", name: "Org 2", city: "", deal: 2 }, { ref: "org:777", name: "Trato 3", city: "", deal: 3 }, { ref: "deal:4", name: "Trato 4", city: "", deal: 4 }]);
});
test("buildToday: todo junto, y «?» (null) con aviso cuando no se pudo leer o Pipedrive cortó la lista", () => {
  const rows = [row(1), row(2, { next: null }), row(3, { value: null, currency: "", stale: true, days: 20 }), row(4, { value: 50, currency: "USD" })];
  const acts = [act("meeting", "2026-11-16", "16:00", { dealId: 1 }), act("meeting", "2026-11-17", "16:00"), act("call", "2026-11-13", "", { dealId: 2 }), act("task", "2026-11-16", "", { dealId: 2 }), act("call", "2026-11-25")];
  const done = { n: 3, oldest: "2026-11-01", demos: [{ id: 1, type: "meeting", due_date: "2026-11-16", due_time: "14:00", mark: null }] };
  const r = AE.buildToday({ rows, acts, done, tz: TZ, now: NOW });
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.summary, { deals: 4, value: [{ currency: "MXN", total: 2000 }, { currency: "USD", total: 50 }], noValue: 1, demosWeek: { total: 3, held: 1, noshow: 0, canceled: 0, upcoming: 1, unmarked: 1, from: "2026-11-16", to: "2026-11-22" }, overdue: 1, attention: 2 });
  assert.deepEqual([r.demos.n, r.demos.today.length, r.demos.tomorrow.length, r.tasks.n, r.tasks.late, r.attention.n, r.attention.counts], [2, 1, 1, 2, 1, 2, { proposal: 0, overdue: 0, noNext: 1, stale: 1 }]);
  assert.deepEqual(r.session.map(x => x.ref), ["org:902", "org:903"]);
  // la lista de tratos cortada: cuántos son, cuánto suman y cuántos piden atención no se sabe
  const t = AE.buildToday({ rows, acts, done, tz: TZ, now: NOW, truncated: true });
  assert.deepEqual([t.summary.deals, t.summary.value, t.summary.attention, t.attention.n, t.attention.deals.length, t.warnings.length], [null, null, null, null, 2, 1]);
  // 500 actividades sin hacer y la última vence antes de mañana: hoy puede estar incompleto
  const cut = AE.buildToday({ rows, acts: acts.slice(0, 4), done, tz: TZ, now: NOW, limit: 4 });
  assert.deepEqual([cut.demos.n, cut.tasks.n, cut.summary.overdue, cut.summary.demosWeek, cut.warnings.length], [null, null, null, null, 1]);
  assert.match(cut.warnings[0], /Pipedrive cortó la lista/);
  // …pero si la última vence más adelante, lo de hoy y mañana está entero (la semana no)
  const far = AE.buildToday({ rows, acts, done, tz: TZ, now: NOW, limit: 5 });
  assert.deepEqual([far.demos.n, far.tasks.n, far.summary.overdue, far.summary.demosWeek, far.warnings], [2, 2, 1, { ...r.summary.demosWeek }, []]);
  // las hechas cortadas antes de llegar al lunes: las demos de la semana no se saben
  assert.equal(AE.buildToday({ rows, acts, done: { ...done, n: 500, oldest: "2026-11-16" }, tz: TZ, now: NOW }).summary.demosWeek, null);
  assert.equal(AE.buildToday({ rows, acts, done: { ...done, n: 500, oldest: "2026-11-10" }, tz: TZ, now: NOW }).summary.demosWeek.total, 3);
  // no se pudo leer nada: todo «?», sin ceros inventados
  const no = AE.buildToday({ rows: null, acts: null, done: null, tz: TZ, now: NOW });
  assert.deepEqual([no.summary, no.demos.n, no.tasks.n, no.attention.n, no.session, no.warnings.length], [{ deals: null, value: null, noValue: null, demosWeek: null, overdue: null, attention: null }, null, null, null, [], 2]);
});

// ---------- las rutas, contra el Pipedrive de prueba
const { default: app } = await import("../server.js");
const web = http.createServer(app);
await new Promise(r => web.listen(0, "127.0.0.1", r));
const APP = `http://127.0.0.1:${web.address().port}`;
after(async () => { web.closeAllConnections?.(); await new Promise(r => web.close(r)); });
const B32 = "abcdefghjkmnpqrstuvwxyz23456789";
const codeOf = email => { const h = crypto.createHmac("sha256", "clave-de-prueba").update("code:" + email).digest(); const c = [...h.subarray(0, 8)].map(x => B32[x % B32.length]).join(""); return `${c.slice(0, 4)}-${c.slice(4)}`; };
async function login(path, body) {
  const r = await fetch(APP + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal(r.status, 200, await r.clone().text());
  const cookie = r.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
  return async (p, opts = {}) => { const x = await fetch(APP + p, { ...opts, headers: { cookie, "content-type": "application/json", "x-tz": "America/Mexico_City", ...(opts.headers || {}) } }); return { status: x.status, body: await x.json() }; };
}
const asCode = email => login("/auth/code", { email, code: codeOf(email) });
const JOAQUIN = 24821777;

test("GET /api/ae/today: Joaquín (account) ve sus demos, sus tareas por trato y sus tratos que piden atención, solo lo suyo", async () => {
  const j = await asCode("joaquin@ordereat.com");
  assert.equal((await j("/api/me/profile", { method: "POST", body: JSON.stringify({ name: "Joaquín Márquez", role: "ae" }) })).status, 200);
  const r = await j("/api/ae/today");
  assert.equal(r.status, 200);
  const d = r.body;
  assert.deepEqual([d.noUser, d.warnings, d.tz, d.staleDays], [undefined, [], "America/Mexico_City", 14]);
  // sus tratos: todos de él (dueño), sin embudos de clientes; el resumen coincide con Tratos abiertos filtrado por dueño
  const open = (await j("/api/deals/open")).body.deals.filter(x => x.owner?.id === JOAQUIN);
  assert.equal(d.summary.deals, open.length);
  assert.ok(d.summary.deals >= 7 && d.summary.value.some(v => v.currency === "MXN") && d.summary.noValue >= 1);
  // demos: la de hace 2 horas (para marcar) y la de dentro de 3 (según la hora, de hoy, de ayer o de mañana en su zona)
  const demos = [...d.demos.unmarked, ...d.demos.today, ...d.demos.tomorrow];
  assert.equal(d.demos.n, demos.length);
  assert.ok(demos.length >= 2 && demos.every(a => a.type === "meeting"));
  assert.ok(demos.some(a => a.past && /Demo OrderEAT/.test(a.subject) && a.deal?.stage === "SELLING"), "la demo que ya pasó, con su trato");
  assert.ok(demos.some(a => /Demo con dirección/.test(a.subject) && a.deal?.stage === "CLOSING" && (a.schoolId || a.record)));
  assert.ok(d.summary.demosWeek.total >= 2 && d.summary.demosWeek.total === ["held", "noshow", "canceled", "upcoming", "unmarked"].reduce((k, x) => k + d.summary.demosWeek[x], 0));
  // tareas: ninguna demo, nada de mañana, dos en el mismo trato (la más vieja primero) y una sin trato
  const items = d.tasks.groups.flatMap(g => g.items);
  assert.equal(d.tasks.n, items.length);
  assert.ok(items.every(a => a.type !== "meeting" && a.date <= d.today));
  const two = d.tasks.groups.find(g => g.items.length === 2 && g.deal);
  assert.ok(two && two.deal.stage === "PROPOSAL SENT" && two.items[0].late && two.items[0].date < two.items[1].date, "dos tareas del mismo trato");
  assert.ok(d.tasks.groups.some(g => !g.dealId && g.items.some(a => /Llamar a la administración/.test(a.subject))), "una tarea sin trato");
  assert.equal(d.summary.overdue, items.filter(a => a.late).length);
  for (let i = 1; i < d.tasks.groups.length; i++) assert.ok(d.tasks.groups[i - 1].oldest <= d.tasks.groups[i].oldest, "los grupos, por su tarea más vieja");
  // tratos que piden atención: de los cuatro motivos, cada uno una vez, el más grave primero
  const att = d.attention.deals;
  assert.equal(d.attention.n, att.length);
  assert.equal(new Set(att.map(x => x.id)).size, att.length);
  assert.ok(att.every(x => x.owner?.id === JOAQUIN && x.why.length));
  for (const k of AE.WHY) assert.ok(d.attention.counts[k] >= 1, `algún trato con ${k}`);
  const rank = x => AE.WHY.indexOf(x.why[0]);
  for (let i = 1; i < att.length; i++) assert.ok(rank(att[i - 1]) <= rank(att[i]), "ordenados por el motivo más grave");
  assert.ok(att.some(x => x.value == null) && att.some(x => x.value > 0), "con valor y sin valor");
  assert.ok(open.filter(x => !x.next && !x.nextUnknown).every(x => att.some(y => y.id === x.id)), "todos los que no tienen próximo paso están");
  // la sesión: un ítem por ficha, en ese orden; el trato sin organización va como «deal:» (la sesión lo saltea con el motivo)
  assert.equal(new Set(d.session.map(x => x.ref)).size, d.session.length);
  assert.equal(d.sessionTotal, d.session.length);
  const noOrg = att.find(x => /Sin Organización de Prueba/.test(x.title));
  assert.ok(noOrg && !noOrg.org && d.session.some(x => x.ref === `deal:${noOrg.id}`));
  assert.ok(d.session.every(x => /^(org:\d+|deal:\d+|[\w.-]+)$/.test(x.ref) && x.name));
  // la ficha: su trato de esa organización; en la de otra persona, nada
  const withOrg = att.find(x => x.org);
  const mine = (await j(`/api/ae/deals?ref=org:${withOrg.org.id}`)).body;
  assert.deepEqual([mine.deals.map(x => x.id), mine.deals[0].why, mine.deals[0].stage.name], [[withOrg.id], withOrg.why, withOrg.stage.name]);
  assert.deepEqual((await j(`/api/ae/deals?ref=deal:${noOrg.id}`)).body.deals.map(x => x.id), [noOrg.id]);
  assert.deepEqual((await j("/api/ae/deals?ref=org:424242")).body.deals, []);
});
test("GET /api/ae/today: cada uno lo suyo (multitenant): el usuario de prueba no ve nada de Joaquín, y al revés; fresh lee de nuevo", async () => {
  const me = await login("/auth/dev", {}), j = await asCode("joaquin@ordereat.com");
  const [a, b] = [(await me("/api/ae/today")).body, (await j("/api/ae/today?fresh=1")).body];
  assert.ok(a.attention.deals.length && a.attention.deals.every(x => x.owner?.id === 1), "solo los tratos a su nombre (no donde figura como SDR)");
  const ids = l => new Set([...l.demos.unmarked, ...l.demos.today, ...l.demos.tomorrow, ...l.tasks.groups.flatMap(g => g.items)].map(x => x.id));
  const [ia, ib] = [ids(a), ids(b)];
  assert.ok(ia.size && ib.size && ![...ia].some(x => ib.has(x)), "ninguna actividad en común");
  assert.ok(!a.attention.deals.some(x => b.attention.deals.some(y => y.id === x.id)));
  // el trato de Joaquín no aparece en la ficha para otra persona
  const his = b.attention.deals.find(x => x.org);
  assert.deepEqual((await me(`/api/ae/deals?ref=org:${his.org.id}`)).body.deals, []);
  // el usuario de prueba tiene miles de tratos de prueba: llegan los más urgentes y cuántos faltan (no se corta en silencio)
  assert.ok(a.attention.deals.length <= 300 && a.attention.n === a.attention.deals.length + a.attention.more && a.session.length <= 300 && a.sessionTotal >= a.session.length);
});
test("GET /api/ae/today: sin usuario de Pipedrive, todo «?» y sin tratos; sin sesión, 401", async () => {
  const x = await asCode("nadie@ordereat.com");
  const d = (await x("/api/ae/today")).body;
  assert.deepEqual([d.noUser, d.summary.deals, d.demos.n, d.tasks.n, d.attention.n, d.session, d.warnings], [true, null, null, null, null, [], []]);
  assert.deepEqual((await x("/api/ae/deals?ref=org:1")).body.deals, []);
  assert.equal((await fetch(APP + "/api/ae/today")).status, 401);
});
