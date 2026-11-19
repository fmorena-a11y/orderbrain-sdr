// «Hoy» del líder (lib/leadview.js, lib/lead-api.js): la gente que ve cada líder, los números del día por persona (pendientes de
// hoy, hechas hoy, vencidas, demos, inbound y tratos) con su definición exacta, «?» cuando la lectura vino cortada, y las alertas
// de «Para mirar hoy» en orden. Al final, las rutas GET /api/lead/today y /api/lead/person/:id contra el Pipedrive de prueba
// (DEMO_MODE), sin red: el líder fijo, un SDR común (403) y, con equipos, un líder de equipo que ve SOLO su gente.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
for (const k of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "PIPEDRIVE_API_TOKEN", "ANTHROPIC_API_KEY", "READ_ONLY", "BRAIN_TOKEN", "LEADER_EMAILS", "FOUNDER_EMAILS", "ALLOWED_EMAIL_DOMAIN", "CLIENT_PIPELINE_IDS", "DEAD_STAGE_IDS", "SLACK_BOT_TOKEN"]) delete process.env[k];
Object.assign(process.env, { DEMO_MODE: "1", SESSION_SECRET: "clave-de-prueba", VERCEL: "1", DEV_LOGIN_EMAIL: "demo@ordereat.com", TEAM_ACCESS_CODE: "equipo-prueba", DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "ob-lead-")) });
const LV = await import("../lib/leadview.js");
const TM = await import("../lib/teams.js");

// ---------- lo puro
const TZ = "America/Mexico_City", TODAY = "2026-11-16", TOMORROW = "2026-11-17";
const NOW = Date.parse("2026-11-16T18:00:00Z"); // 12:00 en Ciudad de México
const users = [["lider", 1], ["ana", 2], ["beto", 3], ["caro", 4], ["general", 99], ["otra", 7]].map(([n, id]) => ({ id, name: n.toUpperCase(), email: `${n}@x.com` }));
const E = n => `${n}@x.com`;
const profiles = { [E("ana")]: { name: "Ana Pérez", role: "sdr" }, [E("beto")]: { name: "Beto Díaz", role: "ae" }, [E("lider")]: { name: "La Líder", role: "lider" } };
const FREE = new Set([99]);
const IDS = new Set([2, 3, 4]);

test("peopleFor: la gente del equipo (o todos sin equipo), sin las cuentas generales; rol, quién usa la app y a quién se le puede abrir el día", () => {
  const all = LV.peopleFor({ users, profiles, free: FREE, lead: true, meId: 1, canLead: TM.canLead });
  // SDR, accounts y el resto; adentro, alfabético
  assert.deepEqual(all.map(p => [p.id, p.name, p.role, p.app]), [[2, "Ana Pérez", "sdr", true], [3, "Beto Díaz", "ae", true], [4, "CARO", "", false], [1, "La Líder", "", true], [7, "OTRA", "", false]]);
  assert.ok(all.every(p => p.open), "dirección abre el día de cualquiera");
  assert.equal(all.find(p => p.id === 1).self, true);
  // un líder de equipo: solo su gente; a su colíder (no está en su alcance) no le abre el día
  const team = { ids: new Set([1, 2, 4]), emails: new Set([E("lider"), E("ana"), E("caro")]) }, lead = { ids: new Set([1, 2]), emails: new Set([E("lider"), E("ana")]) };
  const mine = LV.peopleFor({ users, profiles, free: FREE, team, lead, meId: 1, canLead: TM.canLead });
  assert.deepEqual(mine.map(p => [p.id, p.open]), [[2, true], [4, false], [1, true]]);
  // un account por defecto (DEFAULT_ACCOUNTS) es «ae» aunque no tenga perfil
  assert.equal(LV.peopleFor({ users, profiles: {}, ae: new Set([4]) }).find(p => p.id === 4).role, "ae");
});

const act = (id, owner, o = {}) => ({ id, type: "call", owner_id: owner, creator_user_id: owner, done: false, due_date: TODAY, due_time: "", done_time: null, subject: "Llamada · Colegio", ...o });
test("actsPart: pendientes de hoy, hechas hoy y vencidas en la zona de quien mira; sin las automáticas ni lo de otra gente", () => {
  const pending = [
    act(1, 2), act(1, 2), // repetida en dos lecturas: una vez
    act(2, 2, { due_date: "2026-11-17", due_time: "02:00:00" }), // 20:00 de hoy en México: es de hoy
    act(3, 2, { due_date: "2026-11-16", due_time: "03:00:00" }), // 21:00 de ayer en México: vencida
    act(4, 2, { due_date: "2026-11-10" }), act(5, 2, { due_date: "2026-11-17" }), // vencida; de mañana (no cuenta)
    act(6, 3, { due_date: "2026-11-15", subject: "Llamar · inbound Google Ads · Marta" }), act(7, 3, { due_date: "2026-11-15", subject: "Llamar · SDR revival Meta Ads · Juan" }),
    act(8, 3, { due_date: "2026-11-15", subject: "Volver a llamar · inbound" }), // no es el asunto que arma Tus inbound
    act(9, 99, { due_date: "2026-11-01" }), act(10, 7, { due_date: "2026-11-01" }), // cuenta general y alguien de otro equipo: no entran
    act(11, 2, { due_date: "" }), act(12, 2, { due_date: "2026-11-01", deleted: true }),
  ];
  const done = [
    act(20, 2, { done: true, done_time: "2026-11-16T15:00:00Z" }), // hoy
    act(21, 2, { done: true, done_time: "2026-11-16T05:30:00Z" }), // 23:30 de ayer en México: no es de hoy
    act(22, 2, { done: true, done_time: "2026-11-17T01:00:00Z", due_date: "2026-11-01" }), // 19:00 de hoy: la marcó hoy aunque fuera vieja
    act(23, 3, { done: true, done_time: "2026-11-16T16:00:00Z", creator_user_id: 99, type: "task" }), // automática (diio): no la hizo la persona
    act(24, 3, { done: true, done_time: "2026-11-16T16:00:00Z", creator_user_id: 99, type: "aircall_outbound_unanswere" }), // Aircall: sí
    act(25, 3, { done: true, done_time: null }), act(26, 7, { done: true, done_time: "2026-11-16T15:00:00Z" }),
  ];
  const r = LV.actsPart({ done, pending, partial: {}, ids: IDS, tz: TZ, today: TODAY, free: FREE });
  assert.deepEqual(r.by[2], { today: 2, doneToday: 2, overdue: 2, inbCalls: 0 });
  assert.deepEqual(r.by[3], { today: 0, doneToday: 1, overdue: 3, inbCalls: 2 });
  assert.deepEqual(r.by[4], { today: 0, doneToday: 0, overdue: 0, inbCalls: 0 }, "una persona sin nada va en cero (se sabe)");
  assert.deepEqual(r.totals, { today: 2, doneToday: 3, overdue: 5, inbCalls: 2 });
  assert.equal(r.by[99], undefined); assert.equal(r.by[7], undefined);
  assert.deepEqual(r.alerts, [], "nadie llega a 10 vencidas");
});
test("actsPart: «muchas vencidas» desde 10; si Pipedrive cortó una lectura, lo que depende de ella queda «?» (null), nunca 0", () => {
  const pending = Array.from({ length: 10 }, (_, i) => act(100 + i, 2, { due_date: "2026-11-0" + (i % 9 + 1) })).concat(Array.from({ length: 9 }, (_, i) => act(200 + i, 3, { due_date: "2026-11-01" })));
  const r = LV.actsPart({ pending, done: [], partial: {}, ids: IDS, tz: TZ, today: TODAY });
  assert.equal(r.alerts.length, 1);
  assert.deepEqual([r.alerts[0].key, r.alerts[0].n, r.alerts[0].who.map(w => [w.id, w.n])], ["lateMany", 1, [[2, 10]]]);
  assert.match(r.alerts[0].text, /^1 persona con 10 o más actividades vencidas$/);
  const cut = LV.actsPart({ pending, done: [act(1, 2, { done: true, done_time: "2026-11-16T15:00:00Z" })], partial: { pending: true }, ids: IDS, tz: TZ, today: TODAY });
  assert.deepEqual(cut.by[2], { today: null, doneToday: 1, overdue: null, inbCalls: null });
  assert.deepEqual(cut.totals, { today: null, doneToday: 1, overdue: null, inbCalls: null });
  assert.deepEqual(cut.alerts, [], "sin la lista entera no se dice quién tiene muchas");
  const cut2 = LV.actsPart({ pending, done: [], partial: { updated: true }, ids: IDS, tz: TZ, today: TODAY });
  assert.deepEqual([cut2.by[2].doneToday, cut2.totals.doneToday, cut2.by[2].overdue], [null, null, 10]);
});

const demo = (id, o = {}) => ({ id, date: TODAY, time: "10:00", name: `Colegio ${id}`, schoolId: null, record: `org:${id}`, ownerId: 3, owner: "Beto Díaz", setterId: 2, setter: "Ana Pérez", state: "booked", ...o });
const monthOf = (items, rows, o = {}) => ({ period: { key: "2026-11", label: "noviembre 2026" }, items, rows, totals: { counts: rows.some(r => r.counts == null) ? null : rows.reduce((n, r) => n + r.counts, 0), done: rows.reduce((n, r) => n + (r.done || 0), 0) }, at: "2026-11-16T17:00:00Z", partial: false, ...o });
test("demosPart: las de hoy y mañana (sin canceladas), las pasadas sin marcar del mes y de la ventana, y «Cuentan» del tablero del mes", () => {
  const month = monthOf([demo(1), demo(2, { state: "canceled" }), demo(3, { date: TOMORROW, ownerId: 4, owner: "CARO" }), demo(4, { date: "2026-11-03", state: "unmarked" }), demo(5, { date: "2026-11-05", state: "done" }), demo(6, { state: "done", time: "09:00" })],
    [{ id: 2, counts: 3.5, done: 5, out: 2, in: 3, booked: 2 }, { id: null, auto: true, counts: null, done: 4 }]);
  // la ventana trae una sin marcar del mes pasado (no está en el tablero del mes) y repite la 1
  const win = { items: [demo(1), demo(7, { date: "2026-10-31", state: "unmarked", ownerId: 2, owner: "Ana Pérez", setterId: null, setter: "", auto: true })], partial: false, at: "2026-11-16T17:01:00Z" };
  const r = LV.demosPart({ month: { ...month, totals: { counts: 3.5, done: 9 } }, win, ids: IDS, today: TODAY, tomorrow: TOMORROW });
  assert.equal(r.known, true);
  assert.deepEqual(r.totals, { today: 2, tomorrow: 1, unmarked: 2, counts: 3.5, done: 9 });
  assert.deepEqual(r.today.map(x => x.id), [6, 1], "por hora; la cancelada no va");
  assert.deepEqual(r.unmarked.map(x => x.id), [7, 4], "la más vieja primero");
  // de una persona: la da o la cargó
  assert.deepEqual(r.by[2], { today: 2, tomorrow: 1, unmarked: 2, counts: 3.5, done: 5, out: 2, in: 3, booked: 2 });
  assert.deepEqual(r.by[3], { today: 2, tomorrow: 0, unmarked: 1, counts: 0, done: 0, out: 0, in: 0, booked: 0 });
  assert.deepEqual([r.by[4].today, r.by[4].tomorrow], [0, 1]);
  assert.deepEqual(r.alerts.map(a => [a.key, a.n, a.who.map(w => [w.id, w.n])]), [["demosToday", 2, [[3, 2]]], ["unmarked", 2, [[2, 1], [3, 1]]]]);
  assert.match(r.alerts[0].text, /^2 demos hoy$/); assert.match(r.alerts[1].text, /^2 demos pasadas sin marcar$/);
  assert.deepEqual(r.alerts[1].go, { view: "equipo" });
  // un líder de equipo: si la da un account que no es de su gente, «a quién toca» es quien la cargó (de su equipo)
  const sdrTeam = LV.demosPart({ month: { ...month, totals: { counts: 3.5, done: 9 } }, win, ids: new Set([2]), today: TODAY, tomorrow: TOMORROW });
  assert.deepEqual(sdrTeam.alerts.map(a => a.who.map(w => [w.id, w.name, w.n])), [[[2, "Ana Pérez", 2]], [[2, "Ana Pérez", 2]]]);
});
test("demosPart: lista cortada → todos los números «?»; una persona con una demo hecha sin poder leer su fuente, «Cuentan» «?»", () => {
  const cut = LV.demosPart({ month: monthOf([demo(1)], [{ id: 2, counts: 1 }], { partial: true }), win: { items: [], partial: false }, ids: IDS, today: TODAY, tomorrow: TOMORROW });
  assert.equal(cut.known, false);
  assert.deepEqual(cut.totals, { today: null, tomorrow: null, unmarked: null, counts: null, done: null });
  assert.equal(cut.by[2].today, null); assert.deepEqual(cut.alerts, []);
  assert.equal(cut.today.length, 1, "lo que se pudo leer se muestra igual");
  const unread = LV.demosPart({ month: monthOf([], [{ id: 2, counts: null, done: 2 }]), win: { items: [], partial: false }, ids: IDS, today: TODAY, tomorrow: TOMORROW });
  assert.equal(unread.by[2].counts, null); assert.equal(unread.totals.counts, null); assert.equal(unread.by[3].counts, 0);
  assert.equal(LV.demosPart({ month: null, win: null, ids: IDS, today: TODAY, tomorrow: TOMORROW }).known, false);
});

const hAgo = h => new Date(NOW - h * 3600e3).toISOString();
const inbOf = (pending, people, totals, known = { entries: true, contacts: true, demos: true }) => ({ period: { from: "2026-11-10", to: TODAY }, at: { leads: "x" }, known, kinds: { all: { totals, people, pending } } });
test("inboundPart: sin contactar por persona (la cuenta de Métricas), el plazo de 72 h y lo del reparto de Slack sin procesar", () => {
  const pending = [
    { id: "l1", rec: "lead", title: "Colegio Uno (Inbound Google Ads)", entry: hAgo(100), personId: 2, person: "Ana Pérez" }, // pasaron las 72 h
    { id: 50, rec: "deal", title: "Colegio Dos", entry: hAgo(72), personId: 2, person: "Ana Pérez" }, // justo 72: ya pasó
    { id: "l3", rec: "lead", title: "Tres", entry: hAgo(60), personId: 4, person: "CARO" }, // quedan 12: por vencer
    { id: "l4", rec: "lead", title: "Cuatro", entry: hAgo(10), personId: null, person: "", free: true }, // quedan 62
  ];
  const people = [{ id: 2, name: "Ana Pérez", notContacted: 2, entries: 6 }, { id: 4, name: "CARO", notContacted: 1, entries: 1 }, { id: 99, name: "", free: true, notContacted: 1, entries: 2 }];
  const slack = { on: true, items: [{ email: E("ana"), hoursLeft: 10, state: null }, { email: E("ana"), hoursLeft: 60, state: { status: "error" } }, { email: E("ana"), hoursLeft: 5, state: { status: "done" } },
    { email: E("caro"), hoursLeft: -4, state: { status: "partial" } }, { email: E("otra"), hoursLeft: 1, state: null }, { email: "", hoursLeft: 1, state: null }, { email: E("ana"), hoursLeft: 1, state: { status: "review" } }] };
  const r = LV.inboundPart({ inb: inbOf(pending, people, { notContacted: 4, entries: 9 }), slack, ids: IDS, emails: new Map(users.map(u => [u.email, u.id])), now: NOW });
  assert.equal(r.known, true); assert.equal(r.cut, false);
  assert.deepEqual(r.totals, { new: 4, entries: 9, late: 2, soon: 1 });
  assert.deepEqual(r.by[2], { new: 2, entries: 6, late: 2, soon: 0, todo: 2 });
  assert.deepEqual(r.by[4], { new: 1, entries: 1, late: 0, soon: 1, todo: 1 });
  assert.deepEqual(r.by[3], { new: 0, entries: 0, late: 0, soon: 0, todo: 0 });
  assert.deepEqual(r.list.map(x => [x.id, x.left]), [["l1", -28], [50, 0], ["l3", 12], ["l4", 62]]);
  // lo de Slack: solo la gente que se mira; lo que no se sabe de quién es, aparte; «para revisar» no es «sin procesar»
  assert.deepEqual(r.slack, { on: true, error: "", todo: 3, soon: 2, unassigned: 1 });
  assert.deepEqual(r.alerts.map(a => [a.key, a.n]), [["inbDeadline", 4], ["inbTodo", 3]]);
  assert.match(r.alerts[0].text, /^4 inbound sin contactar: 2 ya pasaron las 72 h y 1 vence en menos de 24 h$/);
  assert.deepEqual(r.alerts[0].who.map(w => [w.id, w.name, w.n]), [[2, "Ana Pérez", 2], [4, "CARO", 1], [99, "cuentas generales", 1]]);
  // sin apuro: ninguno cerca del plazo
  const calm = LV.inboundPart({ inb: inbOf([pending[3]], [people[2]], { notContacted: 1, entries: 2 }), slack: null, ids: IDS, now: NOW });
  assert.deepEqual([calm.alerts[0].key, calm.alerts[0].text, calm.slack], ["inbNew", "1 inbound sin contactar", null]);
  assert.equal(calm.by[2].todo, undefined, "sin Slack no hay número del reparto");
  assert.deepEqual(LV.inboundPart({ inb: inbOf([], [], { notContacted: 0, entries: 3 }), ids: IDS, now: NOW }).alerts, []);
});
test("inboundPart: con más sin contactar que los 40 de la lista, el plazo solo se dice si se sabe; lecturas cortadas, «?»", () => {
  // 45 sin contactar, la lista trae los 40 más viejos y TODOS ya pasaron las 72 h: puede haber más → «?»
  const old = Array.from({ length: 40 }, (_, i) => ({ id: `l${i}`, rec: "lead", title: "x", entry: hAgo(200 - i), personId: 2, person: "Ana Pérez" }));
  const a = LV.inboundPart({ inb: inbOf(old, [{ id: 2, name: "Ana Pérez", notContacted: 45, entries: 50 }], { notContacted: 45, entries: 50 }), ids: IDS, now: NOW });
  assert.deepEqual([a.cut, a.totals.new, a.totals.late, a.totals.soon, a.by[2].late], [true, 45, null, null, null]);
  assert.match(a.alerts[0].text, /^45 inbound sin contactar: 40 o más ya pasaron las 72 h$/);
  assert.equal(a.alerts[0].key, "inbDeadline");
  // el más nuevo de la lista todavía tiene más de 24 h: los que pasaron el plazo y los por vencer están todos en la lista
  const mixed = [...old.slice(0, 39), { id: "nuevo", rec: "lead", title: "x", entry: hAgo(20), personId: 2, person: "Ana Pérez" }];
  const b = LV.inboundPart({ inb: inbOf(mixed, [{ id: 2, name: "Ana Pérez", notContacted: 45, entries: 50 }], { notContacted: 45, entries: 50 }), ids: IDS, now: NOW });
  assert.deepEqual([b.totals.late, b.totals.soon, b.by[2].late], [39, 0, 39]);
  // Pipedrive cortó las actividades: no se sabe quién fue contactado
  const c = LV.inboundPart({ inb: inbOf(old, [], { notContacted: null, entries: 5 }, { entries: true, contacts: false, demos: true }), ids: IDS, now: NOW });
  assert.deepEqual([c.known, c.totals.new, c.totals.late, c.by[2].new, c.list.length, c.alerts.length], [false, null, null, null, 0, 0]);
  assert.equal(LV.inboundPart({ inb: null, ids: IDS, now: NOW }).known, false);
});

const deal = (id, o = {}) => ({ id, owner: { id: 3, name: "Beto Díaz" }, sdr: { id: 2, name: "Ana Pérez" }, next: { date: TOMORROW, overdue: false }, nextUnknown: false, stale: false, days: 3, ...o });
test("dealsPart: piden atención = sin próxima, próxima vencida o más de 14 días en la etapa; por dueño o SDR; cortada, «?»", () => {
  const rows = [deal(1), deal(2, { next: null }), deal(3, { next: null, nextUnknown: true }), deal(4, { next: { date: "2026-11-10", overdue: true } }), deal(5, { stale: true, days: 20 }),
    deal(6, { next: null, stale: true, owner: { id: 4, name: "CARO" }, sdr: null }), deal(7, { next: null, owner: null, sdr: null })];
  assert.deepEqual(rows.map(LV.needsAttention), [false, true, false, true, true, true, true]);
  const r = LV.dealsPart({ rows, ids: IDS });
  assert.deepEqual(r.totals, { n: 7, attn: 5, noNext: 3, stale: 2, overdue: 1 }, "cada trato una vez (el 6 es sin próxima y quieto)");
  assert.deepEqual(r.by[3], { n: 5, attn: 3, noNext: 1, stale: 1, overdue: 1 });
  assert.deepEqual(r.by[2], r.by[3], "como SDR ve los mismos cinco");
  assert.deepEqual(r.by[4], { n: 1, attn: 1, noNext: 1, stale: 1, overdue: 0 });
  assert.deepEqual([r.alerts[0].key, r.alerts[0].n, r.alerts[0].text], ["deals", 5, "5 tratos piden atención"]);
  assert.equal(r.alerts[0].sub, "3 sin próximo paso · 1 con la próxima vencida · 2 quietos (más de 14 días en la etapa)");
  assert.deepEqual(r.alerts[0].who.map(w => [w.id, w.name, w.n]), [[3, "Beto Díaz", 3], [4, "CARO", 1], [null, "sin dueño", 1]]);
  assert.deepEqual(r.alerts[0].go, { deals: "team" });
  // mirando solo a los SDR: los tratos entran por su SDR y a ella le tocan (la dueña no es de su gente)
  assert.deepEqual(LV.dealsPart({ rows: rows.slice(0, 5), ids: new Set([2]) }).alerts[0].who.map(w => [w.id, w.name, w.n]), [[2, "Ana Pérez", 3]]);
  const cut = LV.dealsPart({ rows, truncated: true, ids: IDS });
  assert.deepEqual([cut.known, cut.totals.n, cut.totals.attn, cut.by[3].n, cut.alerts.length], [false, null, null, null, 0]);
  assert.deepEqual(LV.dealsPart({ rows: [deal(1)], ids: IDS }).alerts, []);
});

test("alertsOf: lo más urgente arriba (demos de hoy, el plazo de inbound, demos sin marcar, vencidas, reparto, tratos); sin nada, vacío", () => {
  const parts = {
    deals: { alerts: [{ key: "deals", rank: LV.RANK.deals, n: 9 }] },
    acts: { alerts: [{ key: "lateMany", rank: LV.RANK.lateMany, n: 2 }] },
    inbound: { alerts: [{ key: "inbTodo", rank: LV.RANK.inbTodo, n: 1 }, { key: "inbDeadline", rank: LV.RANK.inbDeadline, n: 3 }] },
    demos: { alerts: [{ key: "unmarked", rank: LV.RANK.unmarked, n: 4 }, { key: "demosToday", rank: LV.RANK.demosToday, n: 1 }] },
  };
  assert.deepEqual(LV.alertsOf(parts).map(a => a.key), ["demosToday", "inbDeadline", "unmarked", "lateMany", "inbTodo", "deals"]);
  assert.deepEqual(LV.alertsOf({ acts: { alerts: [] }, demos: { error: "x" } }), []);
  assert.deepEqual(LV.alertsOf(null), []);
  // cada número que muestra la pantalla tiene su definición
  for (const k of ["today", "doneToday", "overdue", "inbCalls", "demosToday", "demosTomorrow", "unmarked", "counts", "inbNew", "inbLate", "inbSoon", "inbTodo", "deals", "attn"]) assert.ok(LV.DEFS[k]?.length > 20, k);
});

test("personDay: la agenda de una persona en la zona de quien mira: hoy por hora, vencidas de la más reciente a la más vieja; con 500, «?»", () => {
  const it = (id, date, time = "", o = {}) => ({ id, subject: `Llamada · ${id}`, type: "call", typeLabel: "Llamada", date, time, who: "", schoolId: null, record: `org:${id}`, url: "u", note: "privada", ...o });
  const items = [it(1, TODAY, "20:00:00"), it(2, TODAY), it(3, "2026-11-17", "02:00:00"), it(4, "2026-11-16", "03:00:00"), it(5, "2026-11-10"), it(6, "2026-11-18"), it(7, "2026-11-14", "15:00:00")];
  const r = LV.personDay(items, { tz: TZ, today: TODAY });
  assert.deepEqual(r.today.map(a => [a.id, a.time]), [[1, "14:00"], [3, "20:00"], [2, ""]]);
  assert.deepEqual(r.overdue.map(a => [a.id, a.date]), [[4, "2026-11-15"], [7, "2026-11-14"], [5, "2026-11-10"]]);
  assert.deepEqual(r.n, { today: 3, overdue: 3, next: 1 }); assert.equal(r.cut, false);
  assert.equal(r.today[0].note, undefined, "la nota de la actividad no viaja");
  const big = LV.personDay(Array.from({ length: 500 }, (_, i) => it(i, "2026-11-01")), { tz: TZ, today: TODAY, max: 5 });
  assert.deepEqual([big.cut, big.n.today, big.n.overdue, big.overdue.length], [true, null, null, 5]);
});

// ---------- las rutas, contra el Pipedrive de prueba
const { default: app } = await import("../server.js");
const web = http.createServer(app);
await new Promise(r => web.listen(0, "127.0.0.1", r));
const APP = `http://127.0.0.1:${web.address().port}`;
after(async () => { web.closeAllConnections?.(); await new Promise(r => web.close(r)); });
const B32 = "abcdefghjkmnpqrstuvwxyz23456789";
const codeOf = email => { const h = crypto.createHmac("sha256", "clave-de-prueba").update("code:" + email).digest(); const c = [...h.subarray(0, 8)].map(x => B32[x % B32.length]).join(""); return `${c.slice(0, 4)}-${c.slice(4)}`; };
async function login(p, body) {
  const r = await fetch(APP + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal(r.status, 200, await r.clone().text());
  const cookie = r.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
  return async (q, opts = {}) => { const x = await fetch(APP + q, { ...opts, headers: { cookie, "content-type": "application/json", "x-tz": "UTC", ...(opts.headers || {}) } }); return { status: x.status, body: await x.json() }; };
}
// (x-tz UTC: los datos de prueba ponen «hoy» con la fecha UTC del momento; así «hoy» es el mismo día a cualquier hora que corra)
const as = async (who, role) => { const email = `${who}@ordereat.com`, j = await login("/auth/code", { email, code: codeOf(email) });
  if (role) assert.equal((await j("/api/me/profile", { method: "POST", body: JSON.stringify({ name: `${who[0].toUpperCase()}${who.slice(1)} Prueba`, role }) })).status, 200); return j; };
const JOAQUIN = 24821777, MATIAS = 20758179;
const post = (j, p, body, method = "POST") => j(p, { method, body: JSON.stringify(body) });

test("GET /api/lead/today: el líder fijo ve a toda la gente con sus cuatro partes y las alertas; cada parte se puede pedir sola", async () => {
  const me = await login("/auth/dev", {});
  const r = await me("/api/lead/today");
  assert.equal(r.status, 200);
  const d = r.body;
  assert.deepEqual([d.scope.team, d.scope.on, d.scope.all], [null, false, true]);
  assert.deepEqual(Object.keys(d.parts).sort(), ["acts", "deals", "demos", "inbound"]);
  for (const k of Object.keys(d.parts)) assert.equal(d.parts[k].error, undefined, k);
  const ids = d.people.map(p => p.id);
  for (const id of [1, 2, 3, 5, 6, JOAQUIN, MATIAS]) assert.ok(ids.includes(id), `falta ${id}`);
  assert.ok(!ids.includes(13493598) && !ids.includes(99), "sin las cuentas generales");
  assert.ok(d.people.every(p => p.open));
  assert.equal(d.people.find(p => p.id === JOAQUIN).role, "ae");
  // Valentina (5): 3 para hoy, 12 vencidas (datos de prueba) → entra en «muchas vencidas»; Camila (6): una llamada de inbound vencida
  const A = d.parts.acts;
  assert.deepEqual([A.by[5].today, A.by[5].overdue], [3, 12]);
  assert.deepEqual([A.by[6].today, A.by[6].overdue, A.by[6].inbCalls], [2, 3, 1]);
  assert.ok(A.by[5].doneToday <= 2 && A.by[6].doneToday <= 4);
  assert.equal(A.totals.overdue, Object.values(A.by).reduce((n, x) => n + x.overdue, 0), "el total es la suma de las filas");
  const late = d.alerts.find(a => a.key === "lateMany");
  assert.ok(late && late.who.some(w => w.id === 5 && w.n === 12));
  // demos: lo mismo que Equipo › Demos del mes en curso
  const eq = (await me("/api/team/demos")).body, D = d.parts.demos;
  assert.equal(D.totals.counts, eq.totals.counts);
  for (const row of eq.rows.filter(x => ids.includes(x.id))) assert.equal(D.by[row.id]?.counts, row.counts, `Cuentan de ${row.name}`);
  assert.equal(D.totals.unmarked, D.unmarked.length);
  assert.ok(D.today.every(x => x.date === d.today && x.state !== "canceled") && D.tomorrow.every(x => x.date === d.tomorrow));
  // inbound: lo mismo que Métricas › Inbound con 7 días
  const mx = (await me("/api/metrics/inbound?days=7")).body, I = d.parts.inbound;
  assert.equal(I.totals.new, mx.kinds.all.totals.notContacted);
  assert.ok(I.list.every(x => typeof x.left === "number"));
  // tratos: lo mismo que Tratos abiertos de toda la cuenta
  const tr = (await me("/api/deals/open?owner=team")).body, T = d.parts.deals;
  assert.deepEqual([T.totals.n, T.totals.noNext, T.totals.stale, T.totals.overdue], [tr.summary.n, tr.summary.noNext, tr.summary.stale, tr.summary.overdue]);
  assert.ok(T.by[JOAQUIN].n >= 7 && T.by[JOAQUIN].attn >= 1);
  // las alertas, en orden de urgencia
  assert.deepEqual(d.alerts.map(a => a.rank), [...d.alerts.map(a => a.rank)].sort((x, y) => x - y));
  // una sola parte
  const one = (await me("/api/lead/today?part=acts")).body;
  assert.deepEqual(Object.keys(one.parts), ["acts"]);
  assert.ok(one.alerts.every(a => a.key === "lateMany"));
  assert.equal(one.people.length, d.people.length);
  assert.deepEqual(Object.keys((await me("/api/lead/today?part=nada,__proto__")).body.parts).sort(), ["acts", "deals", "demos", "inbound"], "una parte que no existe: van las cuatro");
});

test("GET /api/lead/person/:id: el día de una persona (pendientes de hoy y vencidas); cuentas generales y desconocidos, 404", async () => {
  const me = await login("/auth/dev", {});
  const all = (await me("/api/lead/today?part=acts")).body.parts.acts;
  const v = await me("/api/lead/person/5");
  assert.equal(v.status, 200);
  assert.deepEqual([v.body.person.id, v.body.n.today, v.body.n.overdue, v.body.cut], [5, all.by[5].today, all.by[5].overdue, false]);
  assert.equal(v.body.overdue.length, 12);
  assert.ok(v.body.overdue.every((a, i, l) => !i || l[i - 1].date >= a.date), "de la más reciente a la más vieja");
  assert.ok(v.body.today.every(a => a.date === v.body.today[0].date) && v.body.today.every(a => a.subject && a.typeLabel));
  for (const bad of ["13493598", "424242", "abc", "5x"]) assert.equal((await me(`/api/lead/person/${bad}`)).status, 404, bad);
});

test("un SDR común: 403 en el panel y en el día de cualquiera (ni el suyo); su Hoy de siempre sigue andando", async () => {
  const jd = await as("juandiego", "sdr");
  const r = await jd("/api/lead/today");
  assert.equal(r.status, 403); assert.match(r.body.error, /solo lo ven los líderes y dirección/);
  assert.equal(r.body.people, undefined);
  for (const p of ["/api/lead/today?part=acts", "/api/lead/today?team=all", "/api/lead/person/2", "/api/lead/person/5"]) assert.equal((await jd(p)).status, 403, p);
  assert.equal((await jd("/api/today")).status, 200);
  assert.equal((await jd("/api/me")).body.profile.leader, false);
  // un account, igual
  const jq = await as("joaquin", "ae");
  assert.equal((await jq("/api/lead/today")).status, 403);
  // sin sesión
  assert.equal((await fetch(APP + "/api/lead/today")).status, 401);
});

test("con equipos: un líder de equipo ve SOLO su gente (otro equipo o toda la cuenta, 403); dirección elige equipo o toda la cuenta", async () => {
  const dir = await login("/auth/dev", {});
  // SDR México: lidera Agustín, miembros Juan Diego y Valentina. Cono Sur: lidera Matías, miembro Camila.
  const mk = async (name, leader, members) => {
    const c = await post(dir, "/api/teams", { name }); assert.equal(c.status, 200, JSON.stringify(c.body));
    const id = c.body.teams.find(t => t.name === name).id;
    assert.equal((await post(dir, `/api/teams/${id}`, { name, leaders: [leader] }, "PATCH")).status, 200);
    for (const m of members) assert.equal((await post(dir, `/api/teams/${id}/members`, { email: m, action: "add" })).status, 200, m);
    return id;
  };
  const MX = await mk("SDR México", "agustin@ordereat.com", ["juandiego@ordereat.com", "valentina@ordereat.com"]);
  const CS = await mk("SDR Cono Sur", "matias@ordereat.com", ["camila@ordereat.com"]);

  const ag = await as("agustin", "sdr");
  assert.equal((await ag("/api/me")).body.profile.leader, true);
  const r = await ag("/api/lead/today");
  assert.equal(r.status, 200);
  const d = r.body;
  assert.deepEqual([d.scope.team.id, d.scope.team.name, d.scope.on, d.scope.all], [MX, "SDR México", true, false]);
  assert.deepEqual(d.people.map(p => p.id).sort((a, b) => a - b), [2, 3, 5], "su equipo: él, Juan Diego y Valentina");
  assert.ok(d.people.every(p => p.open));
  for (const k of ["acts", "demos", "inbound", "deals"]) assert.deepEqual(Object.keys(d.parts[k].by).map(Number).sort((a, b) => a - b), [2, 3, 5], k);
  // nada de otra gente: ni en los totales ni en las listas ni en «a quién toca»
  const full = (await dir("/api/lead/today?team=all")).body;
  assert.equal(d.parts.acts.totals.overdue, [2, 3, 5].reduce((n, id) => n + full.parts.acts.by[id].overdue, 0));
  assert.ok(d.parts.acts.totals.overdue < full.parts.acts.totals.overdue);
  const mine = new Set([2, 3, 5]);
  for (const it of [...d.parts.demos.today, ...d.parts.demos.tomorrow, ...d.parts.demos.unmarked]) assert.ok(mine.has(it.ownerId) || mine.has(it.setterId), `demo ${it.id} no es de su gente`);
  assert.ok(d.parts.deals.totals.n < full.parts.deals.totals.n);
  const tr = (await ag("/api/deals/open?owner=team")).body;
  assert.equal(d.parts.deals.totals.n, tr.summary.n, "los mismos tratos que su Tratos abiertos del equipo");
  assert.ok(d.parts.inbound.totals.new <= full.parts.inbound.totals.new);
  for (const a of d.alerts.filter(x => x.key !== "inbDeadline" && x.key !== "inbNew")) assert.ok(a.who.every(w => mine.has(w.id)), `«a quién toca» de ${a.key}: ${JSON.stringify(a.who)}`);
  assert.ok(d.alerts.some(a => a.key === "lateMany" && a.who.some(w => w.id === 5)), "Valentina es de su equipo");
  // otro equipo, toda la cuenta o un equipo que no existe
  assert.equal((await ag(`/api/lead/today?team=${CS}`)).status, 403);
  assert.equal((await ag("/api/lead/today?team=all")).status, 403);
  assert.equal((await ag("/api/lead/today?team=tnoexiste")).status, 404);
  // el día de su gente sí; el de alguien de otro equipo, un account sin equipo o dirección, no
  assert.equal((await ag("/api/lead/person/2")).status, 200);
  assert.equal((await ag("/api/lead/person/3")).status, 200, "el suyo");
  for (const id of [6, JOAQUIN, MATIAS, 1]) { const x = await ag(`/api/lead/person/${id}`); assert.equal(x.status, 403, String(id)); assert.match(x.body.error, /no es de tu equipo/); }

  // el otro líder ve lo suyo
  const mt = await as("matias", "ae");
  const o = (await mt("/api/lead/today")).body;
  assert.deepEqual([o.scope.team.id, o.people.map(p => p.id).sort((a, b) => a - b)], [CS, [6, MATIAS]]);
  assert.equal(o.parts.acts.by[6].inbCalls, 1);
  assert.ok(!o.alerts.some(a => a.key === "lateMany"), "nadie de Cono Sur tiene 10 vencidas");

  // dirección: toda la cuenta por defecto, o un equipo
  const def = (await dir("/api/lead/today")).body;
  assert.deepEqual([def.scope.team, def.scope.on, def.scope.all], [null, true, true]);
  assert.ok(def.people.length >= 8);
  const pick = (await dir(`/api/lead/today?team=${CS}`)).body;
  assert.deepEqual(pick.people.map(p => p.id).sort((a, b) => a - b), [6, MATIAS]);
  assert.deepEqual(pick.parts.acts.by, o.parts.acts.by, "dirección mirando Cono Sur ve lo mismo que su líder");

  // los miembros siguen sin panel; y sin el equipo, Agustín deja de ser líder: 403
  assert.equal((await (await as("juandiego"))("/api/lead/today")).status, 403);
  assert.equal((await dir(`/api/teams/${MX}`, { method: "DELETE" })).status, 200);
  const gone = await ag("/api/lead/today");
  assert.equal(gone.status, 403);
});
