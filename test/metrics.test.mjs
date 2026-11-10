// Métricas (lib/metrics.js): definiciones exactas sobre lo crudo de Pipedrive y de la app. Lo que no se sabe es «?» (null).
import test from "node:test";
import assert from "node:assert/strict";
import * as M from "../lib/metrics.js";

const users = [{ id: 1, name: "Token", email: "t@x.com" }, { id: 2, name: "Zoe", email: "zoe@x.com" }, { id: 3, name: "ana", email: "ana@x.com" }, { id: 4, name: "Matías", email: "m@x.com" }];
const profiles = { "ana@x.com": { name: "Ana Pérez" } };
const free = new Set([99]);
const TZ = "America/Montevideo"; // UTC-3
const period = { from: "2026-11-04", to: "2026-11-10", days: 7 };

test("período y fechas: contando hoy, en la zona de quien mira", () => {
  assert.deepEqual(M.periodOf("2026-11-10", 7), { from: "2026-11-04", to: "2026-11-10", days: 7 });
  assert.deepEqual(M.periodOf("2026-11-10", 30), { from: "2026-10-12", to: "2026-11-10", days: 30 });
  assert.equal(M.periodOf("2026-11-10", 5).days, 7); // solo 7, 30 o 90
  assert.equal(M.isoUtc("2026-11-04 02:00:00"), "2026-11-04T02:00:00Z");
  assert.equal(M.isoUtc("2026-11-04T02:00:00Z"), "2026-11-04T02:00:00Z");
  assert.equal(M.localDay("2026-11-04T02:00:00Z", TZ), "2026-11-03"); // las 23:00 del 3 en Montevideo
  assert.equal(M.localDay("2026-11-04 02:00:00", "UTC"), "2026-11-04");
  assert.equal(M.localDay(null, TZ), "");
});

const act = (id, extra) => ({ id, type: "meeting", owner_id: 4, creator_user_id: 2, add_time: "2026-11-05T15:00:00Z", due_date: "2026-11-06", due_time: "", done: false, done_time: null, ...extra });

test("A1 demos cargadas: por fecha de creación; la nota de la app manda; cuenta general = entrada automática", () => {
  const acts = [
    act(1), // Zoe la creó
    act(2, { creator_user_id: 1, by: "Ana Pérez" }), // desde la app: la nota dice quién (el creador es el token)
    act(3, { creator_user_id: 1, by: "Alguien de afuera" }), // nota con un nombre que no es usuario: ese nombre
    act(4, { type: "lunch", creator_user_id: 3 }), // pasada a No Show: también cuenta
    act(5, { creator_user_id: 99, done: true, add_time: "2026-11-06T12:00:00Z", done_time: "2026-11-06T12:00:00Z" }), // automática, cargada ya hecha
    act(6, { creator_user_id: 2, done: true, add_time: "2026-11-06T12:00:00Z", done_time: "2026-11-06T12:30:00Z" }), // hecha después: no es «cargada ya hecha»
    act(7, { creator_user_id: 55 }), // usuario que no está activo
    act(8, { add_time: "2026-11-04T02:00:00Z" }), // el 3 en Montevideo: fuera
    act(9, { add_time: "2026-11-11T02:59:00Z" }), // las 23:59 del 10 en Montevideo: adentro
    act(10, { type: "call" }), // no es demo
    act(11, { deleted: true }),
  ];
  const r = M.demosLoaded(acts, { users, profiles, free, period, tz: TZ });
  assert.deepEqual(r.totals, { total: 8, demo: 7, noshow: 1, preDone: 1, auto: 1, autoPreDone: 1, unknown: 0, people: 7, dups: 0 });
  assert.deepEqual(r.people.map(p => [p.name, p.total, p.noshow, !!p.inactive]), [["Alguien de afuera", 1, 0, false], ["Ana Pérez", 2, 1, false], ["Zoe", 3, 0, false], ["", 1, 0, true]]);
  assert.deepEqual(r.others, [{ id: 99, name: "", free: true, auto: true, total: 1, demo: 1, noshow: 0, preDone: 1 }]); // la automática, aparte (no es una persona)
  assert.equal(r.people.find(p => p.name === "Ana Pérez").id, 3);
  assert.ok(!r.people.some(p => "rank" in p || "pos" in p)); // sin puestos
  // filtro por país (sin país: «?»)
  const c = M.demosLoaded([act(1, { country: "México" }), act(2), act(3, { country: "Perú" })], { users, profiles, free, period, tz: TZ, country: "México" });
  assert.equal(c.totals.total, 1);
  assert.equal(M.demosLoaded([act(1, { country: "México" }), act(2)], { users, profiles, free, period, tz: TZ, country: "?" }).totals.total, 1);
});

test("A2 qué pasó: marca de la app → No Show → hecha en Pipedrive → sin marcar; las que no pasaron, aparte", () => {
  const past = true;
  assert.equal(M.heldState({ mark: "noshow", done: true, type: "meeting" }, past), "appNoshow"); // la marca manda sobre «hecha»
  assert.equal(M.heldState({ mark: "done", type: "lunch" }, past), "appDone");
  assert.equal(M.heldState({ mark: "canceled" }, past), "appCanceled");
  assert.equal(M.heldState({ mark: "moved", type: "lunch" }, past), "noshow"); // reprogramada y la fecha nueva pasó: sigue la regla
  assert.equal(M.heldState({ mark: "moved", done: true }, past), "done");
  assert.equal(M.heldState({ mark: "moved" }, past), "unmarked");
  assert.equal(M.heldState({ mark: "moved" }, false), "upcoming");
  assert.equal(M.heldState({ type: "lunch" }, past), "noshow");
  assert.equal(M.heldState({ type: "meeting", done: true }, false), "done");
  assert.equal(M.heldState({ type: "meeting" }, past), "unmarked");
  const now = Date.parse("2026-11-10T18:00:00Z"); // 15:00 en Montevideo
  const acts = [
    act(1, { due_date: "2026-11-05", done: true }),
    act(2, { due_date: "2026-11-05", type: "lunch", done: true, creator_user_id: 3 }),
    act(3, { due_date: "2026-11-09", creator_user_id: 99 }), // automática, sin marcar
    act(4, { due_date: "2026-11-10", due_time: "20:00", owner_id: 1 }), // hoy a las 17:00: todavía no pasó
    act(5, { due_date: "2026-11-11", due_time: "02:00" }), // las 23:00 del 10 en Montevideo: en el período, no pasó
    act(6, { due_date: "2026-11-03", due_time: "" }), // fuera
    act(7, { due_date: "2026-11-04", due_time: "01:00" }), // las 22:00 del 3: fuera
    act(8, { due_date: "2026-11-08", mark: "done", owner_id: 1, by: "Ana Pérez", creator_user_id: 1 }),
  ];
  const r = M.demosHeld(acts, { users, profiles, free, period, tz: TZ, now });
  assert.deepEqual(r.totals, { total: 6, appDone: 1, appNoshow: 0, appCanceled: 0, noshow: 1, done: 1, unmarked: 1, today: 0, upcoming: 2, dups: 0 });
  assert.deepEqual(r.byOwner.map(x => [x.name, x.total]), [["Matías", 4], ["Token", 2]]);
  assert.deepEqual(r.byLoader.map(x => [x.name, x.total, !!x.auto]), [["Ana Pérez", 2, false], ["Zoe", 3, false], ["", 1, true]]); // la automática al final
  assert.deepEqual(r.items.map(a => a.id).sort(), [1, 2, 3, 4, 5, 8]);
});

test("A3 el trato de cada demo HOY: solo por deal_id; sin trato o no encontrado es «?»; tratos distintos", () => {
  const deals = new Map([[10, { id: 10, status: "won" }], [11, { id: 11, status: "lost", lost_reason: "Es muy caro" }], [12, { id: 12, status: "open", stage_id: 159 }], [13, { id: 13, status: "deleted" }]]);
  const stageOf = id => ({ 159: { name: "PROPOSAL SENT", order: 1 } })[id] || null;
  const r = M.demoDeals([{ deal_id: 10 }, { deal_id: 10 }, { deal_id: 11 }, { deal_id: 12 }, { deal_id: null, org_id: 5 }, { deal_id: 99 }, { deal_id: 13 }], deals, { stageOf });
  assert.equal(r.demos, 7); assert.equal(r.withDeal, 4); assert.equal(r.deals, 3); // la 2ª demo del mismo trato no lo cuenta dos veces
  assert.deepEqual([r.won, r.lost, r.open, r.unknown], [1, 1, 1, 3]); // sin trato (aunque tenga organización), no encontrado y borrado: «?»
  assert.deepEqual(r.lostReasons, [{ key: "Es muy caro", n: 1 }]);
  assert.deepEqual(r.openStages, [{ key: "PROPOSAL SENT", n: 1, order: 1 }]);
});

const stages = [{ id: 160, name: "SELLING", pipe: 9, order: 0 }, { id: 159, name: "PROPOSAL SENT", pipe: 9, order: 1 }, { id: 124, name: "CLOSING", pipe: 9, order: 3 },
  { id: 115, name: "A contactar", pipe: 12, order: 0 }, { id: 198, name: "SELLING", pipe: 12, order: 1 }, { id: 118, name: "NEGOTIATING", pipe: 12, order: 2 }];
const st = new Map(stages.map(s => [s.id, s]));
const ctx = { sales: new Set([9, 12]), pipeCountry: { 9: "México" }, paisOf: d => ({ 243: "Colombia" })[d.pais] || "", stageOf: id => st.get(id) || null, stagesOf: p => stages.filter(s => s.pipe === p), pipeOrder: [9, 12] };
const deal = (id, extra) => ({ id, title: `T${id}`, status: "open", pipeline_id: 9, stage_id: 160, owner_id: 2, sdr: null, pais: null, next_activity_id: 1, update_time: "2026-11-01T10:00:00Z", ...extra });

test("C tratos: ganados y perdidos por su fecha en el período, motivo y etapa; abiertos por embudo y etapa; LatAm por el campo País", () => {
  const won = [deal(1, { status: "won", won_time: "2026-11-09T14:31:00Z", sdr: 3 }), deal(2, { status: "won", won_time: "2026-11-04T02:00:00Z" }), // el 3 en Montevideo: fuera
    deal(3, { status: "won", won_time: "2026-11-06T12:00:00Z", pipeline_id: 16 }), // embudo de clientes: fuera
    deal(4, { status: "won", won_time: "2026-11-06T12:00:00Z", pipeline_id: 12, pais: 243, owner_id: 99, sdr: { id: 2, name: "Zoe" } })];
  const lost = [deal(5, { status: "lost", lost_time: "2026-11-05 10:00:00", lost_reason: "No responde más", stage_id: 159 }), deal(6, { status: "lost", lost_time: "2026-11-05T10:00:00Z", lost_reason: "No responde más", stage_id: 160, sdr: 2 }),
    deal(7, { status: "lost", lost_time: "2026-11-06T10:00:00Z", lost_reason: "Se fue con la competencia", stage_id: 118, pipeline_id: 12 }), deal(8, { status: "lost", lost_time: "2026-11-06T10:00:00Z", lost_reason: "", stage_id: 124 }),
    deal(9, { status: "lost", lost_time: "2026-10-20T10:00:00Z", lost_reason: "Es muy caro" })];
  const open = [deal(20), deal(21, { stage_id: 159, next_activity_id: null, update_time: "2026-10-01T00:00:00Z" }), deal(22, { stage_id: 159, next_activity_id: null, owner_id: 3, update_time: "2026-09-01T00:00:00Z" }),
    deal(23, { pipeline_id: 12, stage_id: 115, pais: 243 }), deal(24, { pipeline_id: 12, stage_id: 118 }), deal(25, { pipeline_id: 16, stage_id: 1 })];
  const lostReasons = ["Es muy caro", "No es fit", "No responde más"];
  const r = M.dealsSummary({ won, lost, open, period, tz: TZ, users, profiles, free, lostReasons, ...ctx });
  assert.equal(r.won.n, 2);
  assert.deepEqual(r.won.byCountry, [{ key: "Colombia", n: 1 }, { key: "México", n: 1 }]);
  assert.deepEqual(r.won.byOwner.map(x => [x.name, x.n, !!x.free]), [["Zoe", 1, false], ["", 1, true]]); // la cuenta general al final
  assert.deepEqual(r.won.bySdr.map(x => [x.name, x.n]), [["Ana Pérez", 1], ["Zoe", 1]]);
  assert.deepEqual(r.won.list.map(d => [d.id, d.day, d.country]), [[4, "2026-11-06", "Colombia"], [1, "2026-11-09", "México"]]);
  assert.equal(r.lost.n, 4);
  assert.deepEqual(r.lost.reasons, [{ key: "No responde más", n: 2 }, { key: "Texto libre", n: 1 }, { key: "Sin motivo", n: 1 }]);
  assert.equal(r.lost.freeText, 2); // texto libre y sin motivo: ninguno es de la lista
  assert.deepEqual([r.lost.beforeProposal, r.lost.afterProposal], [1, 3]);
  assert.deepEqual(r.lost.stages.map(s => [s.key, s.n]), [["SELLING", 1], ["PROPOSAL SENT", 1], ["NEGOTIATING", 1], ["CLOSING", 1]]);
  assert.deepEqual(r.lost.bySdr.map(x => [x.name, x.n, !!x.none]), [["Zoe", 1, false], ["", 3, true]]); // sin SDR cargado, aparte
  assert.equal(r.open.n, 5); assert.equal(r.open.noNext, 2);
  assert.deepEqual(r.open.pipes.map(p => [p.pipe, p.country, p.total, p.stages.map(s => s.n)]), [[9, "México", 3, [1, 2, 0]], [12, "", 2, [1, 0, 1]]]);
  assert.deepEqual(r.open.noNextByOwner.map(x => [x.name, x.n, x.deals.map(d => d.id)]), [["Ana Pérez", 1, [22]], ["Zoe", 1, [21]]]);
  assert.deepEqual(M.dealsMine(r, 2), { wonOwner: 1, wonSdr: 1, lostOwner: 4, lostSdr: 1, noNext: 1 });
  assert.deepEqual(M.dealsMine(r, null), { wonOwner: 0, wonSdr: 0, lostOwner: 0, lostSdr: 0, noNext: 0 });
  // país: México incluye solo su embudo; Colombia sale del campo País en LatAm; LatAm sin País es «?»
  const mx = M.dealsSummary({ won, lost, open, period, tz: TZ, users, profiles, free, lostReasons, ...ctx, country: "México" });
  assert.deepEqual([mx.won.n, mx.lost.n, mx.open.n], [1, 3, 3]);
  const co = M.dealsSummary({ won, lost, open, period, tz: TZ, users, profiles, free, lostReasons, ...ctx, country: "Colombia" });
  assert.deepEqual([co.won.n, co.lost.n, co.open.n], [1, 0, 1]);
  assert.equal(M.dealsSummary({ open, period, tz: TZ, users, lostReasons, ...ctx, country: "?" }).open.n, 1);
  assert.equal(M.userId({ id: 7 }), 7); assert.equal(M.userId("8"), 8); assert.equal(M.userId(null), null);
});

test("D contactos registrados desde la app: período, canal, resultado y por persona (por email)", () => {
  const t = (at, extra) => ({ at, by: "zoe@x.com", byName: "Zoe", schoolId: "s1", outcome: "no_answer", channel: "call", connected: false, demo: false, ...extra });
  const touches = [t("2026-11-05T12:00:00Z"), t("2026-11-05T13:00:00Z", { outcome: "demo", connected: true, demo: true, channel: "whatsapp" }), t("2026-11-06T13:00:00Z", { by: "ANA@x.com", byName: "ana", outcome: "gatekeeper", connected: true, schoolId: "s2" }),
    t("2026-11-04T02:00:00Z"), t("2026-11-07T13:00:00Z", { channel: "fax" })];
  const outcomes = [{ id: "no_answer", label: "No atendió" }, { id: "gatekeeper", label: "Atendió recepción" }, { id: "demo", label: "Demo agendada" }];
  const r = M.contactsSummary(touches, { period, tz: TZ, outcomes, profiles, countryOf: x => ({ s1: "México", s2: "Perú" })[x.schoolId] });
  assert.deepEqual(r.totals, { n: 4, connected: 2, demo: 1, channels: { call: 2, whatsapp: 1, other: 1 } });
  assert.deepEqual(r.outcomes.map(o => [o.key, o.n, o.label]), [["no_answer", 2, "No atendió"], ["gatekeeper", 1, "Atendió recepción"], ["demo", 1, "Demo agendada"]]);
  assert.deepEqual(r.people.map(p => [p.email, p.name, p.n]), [["ana@x.com", "Ana Pérez", 1], ["zoe@x.com", "Zoe", 3]]);
  assert.equal(r.partial, false);
  assert.equal(M.contactsSummary(touches, { period, tz: TZ, country: "Perú", countryOf: x => ({ s1: "México", s2: "Perú" })[x.schoolId] }).totals.n, 1);
  assert.equal(M.contactsSummary([], { period, tz: TZ, cut: true }).partial, true);
});

test("E base, F clientes de World Dominion y G archivados: lo exacto; clientes distintos solo si todos dicen de quién son", () => {
  const sch = [{ country: "México", city: "Puebla" }, { country: "México", city: "Puebla" }, { country: "México", city: "León" }, { country: "Perú", city: "Lima" }];
  assert.deepEqual(M.baseSummary(sch), { total: 4, byCountry: [{ key: "México", n: 3 }, { key: "Perú", n: 1 }], cities: [], cityCount: 0, otherCities: 0 });
  assert.deepEqual(M.baseSummary(sch, { country: "México", top: 1 }), { total: 3, byCountry: [{ key: "México", n: 3 }, { key: "Perú", n: 1 }], cities: [{ key: "Puebla", n: 2 }], cityCount: 2, otherCities: 1 });
  const sites = [{ label: "Churn", country: "México", client: "A", clientId: 1 }, { label: "Activo", country: "México", client: "A", clientId: 1 }, { label: "Activo", country: "Uruguay", client: "b", clientId: 2 }, { label: "Se cayó en onboarding", country: "México", client: "C", clientId: 3 }];
  const f = M.clientsSummary(sites);
  assert.deepEqual(f.byStatus, [{ key: "Activo", n: 2 }, { key: "Churn", n: 1 }, { key: "Se cayó en onboarding", n: 1 }]);
  assert.equal(f.sites, 4); assert.equal(f.clients, 3);
  assert.deepEqual([f.activeSites, f.activeClients], [2, 2]);
  assert.equal(M.clientsSummary([...sites, { label: "Activo", country: "México", client: "", clientId: null }]).clients, null); // un sitio sin cliente: no se sabe
  assert.equal(M.clientsSummary([...sites, { label: "Activo", country: "México", client: "", clientId: null }]).activeClients, null);
  // por clientId, no por nombre: dos clientes «Jesus Maria» distintos son dos; dos sitios activos del mismo cliente, uno
  const jm = M.clientsSummary([{ label: "Activo", client: "Jesus Maria", clientId: 10 }, { label: "Activo", client: "Jesus Maria", clientId: 11 }, { label: "Activo", client: "X", clientId: 12 }, { label: "Activo", client: "X", clientId: 12 }]);
  assert.deepEqual([jm.sites, jm.clients, jm.activeSites, jm.activeClients], [4, 3, 4, 3]);
  assert.equal(M.clientsSummary(sites, { country: "Uruguay" }).sites, 1);
  const recs = { a: { by: "zoe@x.com", byName: "Zoe", at: "2026-11-05T12:00:00Z", reason: "Cerró" }, b: { by: "ana@x.com", byName: "ana", at: "2026-11-06T12:00:00Z", reason: "Otro", text: "academia" },
    c: { by: "zoe@x.com", at: "2026-10-01T12:00:00Z", reason: "Duplicado" }, d: { by: "zoe@x.com", at: "2026-11-06T12:00:00Z", reason: "Cerró" } };
  const g = M.archivedSummary(recs, { period, tz: TZ, reasons: ["No es un colegio", "Cerró", "Duplicado", "Otro"], profiles, countryOf: id => id === "d" ? "Perú" : "México" });
  assert.deepEqual([g.n, g.everN, g.since], [3, 4, "2026-10-01T12:00:00Z"]);
  assert.deepEqual(g.reasons, [{ key: "Cerró", n: 2 }, { key: "Otro", n: 1 }]);
  assert.deepEqual(g.people.map(p => [p.name, p.n]), [["Ana Pérez", 1], ["Zoe", 2]]);
  assert.equal(M.archivedSummary(recs, { period, tz: TZ, country: "Perú", countryOf: id => id === "d" ? "Perú" : "México" }).n, 1);
});

test("splitView: a cada uno, los totales y lo suyo; el desglose por persona va aparte (solo líderes)", () => {
  const loaded = M.demosLoaded([act(1), act(2, { creator_user_id: 3 })], { users, profiles, free, period, tz: TZ });
  const held = M.demosHeld([act(1)], { users, profiles, free, period, tz: TZ, now: Date.parse("2026-11-10T18:00:00Z") });
  const d = M.splitView("demos", { period, tz: TZ, at: {}, partial: {}, loaded, held: { totals: held.totals, byOwner: held.byOwner, byLoader: held.byLoader }, deals: {} }, { me: 2 });
  assert.equal(d.pub.loaded.mine.name, "Zoe"); assert.equal(d.pub.loaded.mine.total, 1);
  assert.equal(d.pub.held.mineOwner, null); assert.equal(d.pub.held.mineLoader.total, 1);
  assert.ok(!JSON.stringify(d.pub).includes("Ana Pérez")); // nada de otra persona
  assert.deepEqual(d.people.loaded.map(p => p.name), ["Ana Pérez", "Zoe"]);
  const deals = M.dealsSummary({ won: [deal(1, { status: "won", won_time: "2026-11-09T14:31:00Z", owner_id: 3 })], period, tz: TZ, users, profiles, lostReasons: [], ...ctx });
  const v = M.splitView("deals", { period, tz: TZ, at: "x", partial: {}, ...deals }, { me: 3 });
  assert.equal(v.pub.won.n, 1); assert.equal(v.pub.mine.wonOwner, 1);
  assert.ok(!("list" in v.pub.won) && !("byOwner" in v.pub.won) && !("noNextByOwner" in v.pub.open));
  assert.equal(v.people.won.list[0].owner, "Ana Pérez");
  const c = M.splitView("contacts", { period, totals: {}, people: [{ email: "zoe@x.com", n: 2 }, { email: "ana@x.com", n: 1 }] }, { email: "ZOE@x.com" });
  assert.deepEqual(c.pub.mine, { email: "zoe@x.com", n: 2 }); assert.ok(!("people" in c.pub)); assert.equal(c.people.people.length, 2);
  assert.equal(M.splitView("base", { total: 1 }).people, null);
});

// Muestra real (Pipedrive, 04–10/11, leída con MCP): las «Demo» y «No Show» creadas en la semana, reducidas a lo que usa A1.
// Resultado comprobado a mano: 48 (43 Demo + 5 No Show), 12 automáticas y todas cargadas ya hechas.
test("A1 con la forma real de Pipedrive v2 (fechas con Z, No Show = lunch, cuenta general 13493598)", () => {
  const g = new Set([13493598]), U = [{ id: 26099383, name: "Ariana Moreira", email: "a@x" }, { id: 24821777, name: "Joaquin Márquez", email: "j@x" }];
  const acts = [
    { id: 103218, type: "meeting", add_time: "2026-11-10T15:00:18Z", done_time: "2026-11-10T15:00:18Z", done: true, creator_user_id: 13493598, owner_id: 26594042 },
    { id: 102854, type: "meeting", add_time: "2026-11-09T19:12:00Z", done: false, creator_user_id: 26099383, owner_id: 26099383 },
    { id: 101967, type: "meeting", add_time: "2026-11-05T14:00:00Z", done: false, creator_user_id: 26099383, owner_id: 26594042 },
    { id: 101724, type: "lunch", add_time: "2026-11-04T17:32:33Z", done_time: "2026-11-10T03:36:42Z", done: true, creator_user_id: 24821777, owner_id: 24821777 },
    { id: 101261, type: "lunch", add_time: "2026-11-03T15:43:00Z", done: true, creator_user_id: 28543616, owner_id: 24821777 }, // creada el 03/11: fuera
  ];
  const r = M.demosLoaded(acts, { users: U, free: g, period, tz: TZ });
  assert.deepEqual(r.totals, { total: 4, demo: 3, noshow: 1, preDone: 1, auto: 1, autoPreDone: 1, unknown: 0, people: 3, dups: 0 });
  assert.deepEqual(r.people.map(p => [p.name, p.total]), [["Ariana Moreira", 2], ["Joaquin Márquez", 1]]); // a quien la creó, no a quien la da
});

test("A2: la cuenta general (13493598) también es dueña de demos: entran, en la fila de la cuenta general (al final)", () => {
  const g = new Set([13493598]), U = [{ id: 25513259, name: "Belén", email: "b@x" }], now = Date.parse("2026-11-10T20:00:00Z");
  const acts = [
    { id: 97836, type: "meeting", owner_id: 13493598, creator_user_id: 25513259, deal_id: 1, due_date: "2026-11-05", due_time: "15:00", done: true, add_time: "2026-11-01T10:00:00Z" },
    { id: 95608, type: "lunch", owner_id: 13493598, creator_user_id: 25513259, deal_id: 2, due_date: "2026-11-06", due_time: "", done: true, add_time: "2026-11-01T10:00:00Z" },
    { id: 1, type: "meeting", owner_id: 25513259, creator_user_id: 25513259, deal_id: 3, due_date: "2026-11-06", due_time: "15:00", done: false, add_time: "2026-11-01T10:00:00Z" },
  ];
  const r = M.demosHeld(acts, { users: U, free: g, period, tz: TZ, now });
  assert.equal(r.totals.total, 3); assert.equal(r.totals.done, 1); assert.equal(r.totals.noshow, 1); assert.equal(r.totals.unmarked, 1);
  assert.deepEqual(r.byOwner.map(x => [x.name, x.total, !!x.free]), [["Belén", 1, false], ["", 2, true]]);
});

test("cargada ya hecha: marcada hecha en el primer minuto (101852: creada 00:22:09, hecha 00:22:11)", () => {
  assert.equal(M.preDone({ done: true, add_time: "2026-11-05T00:22:09Z", done_time: "2026-11-05T00:22:11Z" }), true);
  assert.equal(M.preDone({ done: true, add_time: "2026-11-05T00:22:09Z", done_time: "2026-11-05T00:22:09Z" }), true);
  assert.equal(M.preDone({ done: true, add_time: "2026-11-05T00:22:09Z", done_time: "2026-11-05T00:23:10Z" }), false); // 61 s
  assert.equal(M.preDone({ done: false, add_time: "2026-11-05T00:22:09Z", done_time: "2026-11-05T00:22:11Z" }), false);
  assert.equal(M.preDone({ done: true, add_time: "2026-11-05T00:22:09Z", done_time: "2026-11-05T00:22:00Z" }), false); // hecha antes de creada: no
});

test("duplicados: la misma demo (trato + día + tipo) cuenta una vez; la automática que repite una ya cargada no suma", () => {
  const g = new Set([13493598]), U = [{ id: 24821777, name: "Joaquin Márquez", email: "j@x" }, { id: 20, name: "Ricardo", email: "r@x" }], now = Date.parse("2026-11-10T22:00:00Z");
  const acts = [
    // trato 6462: la No Show de Joaquín del 09/11 y dos automáticas creadas hoy (103533 y 103537)
    { id: 102871, type: "lunch", deal_id: 6462, owner_id: 24821777, creator_user_id: 24821777, due_date: "2026-11-09", due_time: "", done: true, add_time: "2026-11-08T12:00:00Z", done_time: "2026-11-09T20:00:00Z" },
    { id: 103533, type: "lunch", deal_id: 6462, owner_id: 24821777, creator_user_id: 13493598, due_date: "2026-11-09", due_time: "", done: true, add_time: "2026-11-10T21:08:00Z", done_time: "2026-11-10T21:08:00Z" },
    { id: 103537, type: "lunch", deal_id: 6462, owner_id: 24821777, creator_user_id: 13493598, due_date: "2026-11-09", due_time: "", done: true, add_time: "2026-11-10T21:12:00Z", done_time: "2026-11-10T21:12:00Z" },
    // trato 6436: dos No Show en días distintos (04/11 y 10/11): son dos
    { id: 1, type: "lunch", deal_id: 6436, owner_id: 24821777, creator_user_id: 24821777, due_date: "2026-11-04", due_time: "18:00", done: true, add_time: "2026-11-02T12:00:00Z" },
    { id: 2, type: "lunch", deal_id: 6436, owner_id: 24821777, creator_user_id: 24821777, due_date: "2026-11-10", due_time: "15:00", done: true, add_time: "2026-11-05T12:00:00Z" },
    // trato 6394: la Demo 101852 de Ricardo (cargada ya hecha) y la automática 101854, las dos del 03/11 (Montevideo: 05/11 de creación)
    { id: 101852, type: "meeting", deal_id: 6394, owner_id: 20, creator_user_id: 20, due_date: "2026-11-05", due_time: "", done: true, add_time: "2026-11-05T13:22:09Z", done_time: "2026-11-05T13:22:11Z" },
    { id: 101854, type: "meeting", deal_id: 6394, owner_id: 20, creator_user_id: 13493598, due_date: "2026-11-05", due_time: "", done: true, add_time: "2026-11-05T13:24:52Z", done_time: "2026-11-05T13:24:52Z" },
  ];
  const h = M.demosHeld(acts, { users: U, free: g, period, tz: TZ, now });
  assert.equal(h.totals.total, 4); assert.equal(h.totals.dups, 3); assert.equal(h.totals.noshow, 3); assert.equal(h.totals.done, 1);
  assert.equal(h.byOwner.find(x => x.id === 24821777).noshow, 3); // Joaquín: 3 eventos distintos, no 5
  assert.deepEqual(h.byLoader.map(x => [x.name, x.total, !!x.auto]), [["Joaquin Márquez", 3, false], ["Ricardo", 1, false]]); // queda la de la persona
  // A1: la automática no suma; la que cuenta es la primera cargada (102871, del 08/11)
  const l = M.demosLoaded(acts, { users: U, free: g, period, tz: TZ });
  assert.deepEqual([l.totals.total, l.totals.auto, l.totals.dups, l.totals.people, l.totals.preDone], [3, 0, 3, 3, 1]); // la 1 de 6436 se cargó el 02/11: fuera
  // la primera cargada fuera del período: la automática de hoy tampoco cuenta como cargada en el período
  const late = M.demosLoaded(acts.filter(a => a.deal_id === 6462), { users: U, free: g, period: { from: "2026-11-10", to: "2026-11-10", days: 1 }, tz: TZ });
  assert.deepEqual([late.totals.total, late.totals.dups], [0, 2]);
});

test("A2: sin hora y con fecha de hoy es «hoy, sin hora» (no «sin marcar») hasta que termine el día", () => {
  const now = Date.parse("2026-11-10T13:00:00Z"); // 10:00 en Montevideo
  const acts = [act(1, { due_date: "2026-11-10", due_time: "" }), act(2, { due_date: "2026-11-10", due_time: "", done: true }), act(3, { due_date: "2026-11-09", due_time: "" })];
  const r = M.demosHeld(acts, { users, profiles, free, period, tz: TZ, now });
  assert.deepEqual([r.totals.today, r.totals.done, r.totals.unmarked], [1, 1, 1]);
  assert.equal(M.heldState({ type: "meeting" }, true, true), "today");
  assert.equal(M.heldState({ type: "lunch" }, true, true), "noshow");
});

test("C1 ganados por la primera fecha de ganado (won_time se puede editar)", () => {
  const ctx2 = { sales: new Set([9]), pipeCountry: { 9: "México" }, paisOf: () => "", stageOf: () => null, stagesOf: () => [], pipeOrder: [9] };
  const won = [
    { id: 6313, status: "won", pipeline_id: 9, owner_id: 2, won_time: "2026-10-30T12:00:00Z", first_won_time: "2026-11-03T12:00:00Z" }, // ganado el 03/11
    { id: 4133, status: "won", pipeline_id: 9, owner_id: 2, won_time: "2026-11-05T12:00:00Z", first_won_time: "2023-05-01T12:00:00Z" }, // ganado por primera vez en 2023
    { id: 5391, status: "won", pipeline_id: 9, owner_id: 2, won_time: "2026-11-09T14:31:00Z" }, // sin first_won_time: won_time
  ];
  const r = M.dealsSummary({ won, period: { from: "2026-11-01", to: "2026-11-10", days: 10 }, tz: TZ, users, ...ctx2 });
  assert.deepEqual(r.won.list.map(d => d.id), [6313, 5391]);
});
