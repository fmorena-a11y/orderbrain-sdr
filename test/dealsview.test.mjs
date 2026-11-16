// Tratos abiertos (lib/dealsview.js, lib/deals-api.js): qué tratos entran (sin embudos de clientes ni etapas muertas), días en la
// etapa, próxima vencida o sin próxima, etapas en orden, propuesta enviada, indicadores y el alcance por rol (SDR, AE, líder de
// equipo, dirección; 403). Al final, la ruta GET /api/deals/open contra el Pipedrive de prueba (DEMO_MODE), sin red.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
for (const k of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "PIPEDRIVE_API_TOKEN", "ANTHROPIC_API_KEY", "READ_ONLY", "BRAIN_TOKEN", "LEADER_EMAILS", "FOUNDER_EMAILS", "ALLOWED_EMAIL_DOMAIN", "CLIENT_PIPELINE_IDS", "DEAD_STAGE_IDS"]) delete process.env[k];
Object.assign(process.env, { DEMO_MODE: "1", SESSION_SECRET: "clave-de-prueba", VERCEL: "1", DEV_LOGIN_EMAIL: "demo@ordereat.com", TEAM_ACCESS_CODE: "equipo-prueba", DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "ob-deals-")) });
const DV = await import("../lib/dealsview.js");
const TM = await import("../lib/teams.js");

// ---------- lo puro
const NOW = Date.parse("2026-11-16T18:00:00Z"); // 12:00 en Ciudad de México
const TZ = "America/Mexico_City";
const stageList = [[160, "SELLING", 9, 0], [159, "PROPOSAL SENT", 9, 1], [233, "HOT DEALS", 9, 2], [124, "CLOSING", 9, 3],
  [198, "SELLING", 12, 1], [115, "A contactar", 12, 0], [118, "NEGOTIATING", 12, 2], [156, "PENDING TO KICK OFF", 16, 0], [208, "DROPPED", 16, 1]]
  .map(([id, name, pipe, order]) => ({ id, name, pipe, order }));
const pipes = { 9: "MX - SALES", 12: "LatAm - SALES", 16: "ONBOARDING" };

test("isSalesOpen: fuera los embudos de clientes (16, 22, 27), las etapas muertas (208, 249), los cerrados y borrados", () => {
  const d = o => ({ status: "open", pipeline_id: 9, stage_id: 160, ...o });
  assert.equal(DV.isSalesOpen(d()), true);
  for (const p of [16, 22, 27]) assert.equal(DV.isSalesOpen(d({ pipeline_id: p })), false, `embudo ${p}`);
  for (const s of [208, 249]) assert.equal(DV.isSalesOpen(d({ stage_id: s })), false, `etapa ${s}`);
  assert.equal(DV.isSalesOpen(d({ status: "won" })), false);
  assert.equal(DV.isSalesOpen(d({ deleted: true })), false);
  assert.equal(DV.isSalesOpen(null), false);
});
test("daysIn: desde el cambio de etapa; si nunca cambió, desde que se creó; sin fechas, null (no se inventa)", () => {
  assert.equal(DV.daysIn({ stage_change_time: "2026-11-01T18:00:00Z", add_time: "2026-01-01T00:00:00Z" }, NOW), 15);
  assert.equal(DV.daysIn({ add_time: "2026-11-13 17:59:00" }, NOW), 3); // como el demo y v1: sin T ni Z = UTC
  assert.equal(DV.daysIn({ stage_change_time: "2026-11-16T17:00:00Z" }, NOW), 0);
  assert.equal(DV.daysIn({}, NOW), null);
  assert.equal(DV.isStale(14), false); assert.equal(DV.isStale(15), true); assert.equal(DV.isStale(null), false);
});
test("nextView: hora en la zona de quien mira; vencida si pasó el día o la hora; sin hora vence al terminar el día", () => {
  const a = o => ({ id: 1, type: "call", subject: "Llamar", done: false, ...o });
  assert.deepEqual(DV.nextView(a({ due_date: "2026-11-16", due_time: "20:00:00" }), TZ, NOW), { id: 1, type: "call", subject: "Llamar", date: "2026-11-16", time: "14:00", overdue: false, today: true });
  assert.equal(DV.nextView(a({ due_date: "2026-11-16", due_time: "17:30:00" }), TZ, NOW).overdue, true); // 11:30 de hoy, ya pasó
  assert.equal(DV.nextView(a({ due_date: "2026-11-16", due_time: "" }), TZ, NOW).overdue, false); // hoy sin hora: todavía no
  assert.equal(DV.nextView(a({ due_date: "2026-11-15", due_time: "" }), TZ, NOW).overdue, true);
  // las 2 de la mañana UTC del 17 son las 20 del 16 en México: es de hoy, no de mañana
  assert.deepEqual([DV.nextView(a({ due_date: "2026-11-17", due_time: "02:00" }), TZ, NOW).date, DV.nextView(a({ due_date: "2026-11-17", due_time: "02:00" }), TZ, NOW).today], ["2026-11-16", true]);
  assert.equal(DV.nextView(a({ due_date: "2026-11-20", done: true }), TZ, NOW), null);
  assert.equal(DV.nextView(null, TZ, NOW), null);
});
test("proposalSent y stagesOf: etapas en orden por embudo; propuesta = en PROPOSAL SENT o después; un embudo sin esa etapa, null", () => {
  assert.deepEqual(DV.stagesOf(stageList, 12).map(s => s.id), [115, 198, 118]);
  assert.deepEqual([160, 159, 233, 124].map(s => DV.proposalSent(stageList, 9, s)), [false, true, true, true]);
  assert.equal(DV.proposalSent(stageList, 12, 118), null);
  assert.equal(DV.proposalSent(stageList, 9, 999), null);
});

const ctx = (o = {}) => ({ stageList, pipes, name: id => ({ 1: "Ana SDR", 7: "Joaquín AE" })[id] || "", tz: TZ, now: NOW,
  orgs: new Map([[50, { id: 50, name: "COLEGIO PRUEBA" }]]), schools: new Map([[50, { id: "puebla-colegio-prueba", name: "Colegio Prueba", city: "Puebla" }]]),
  acts: new Map([[900, { id: 900, type: "meeting", subject: "Demo", due_date: "2026-11-18", due_time: "16:00:00", done: false }],
    [901, { id: 901, type: "call", subject: "Llamada", due_date: "2026-11-10", due_time: "", done: true, done_time: "2026-11-10T20:00:00Z" }],
    [902, { id: 902, type: "call", subject: "Vencida", due_date: "2026-11-12", due_time: "", done: false }]]), ...o });
const deal = o => ({ id: 1, title: "Colegio Prueba - Trato", status: "open", org_id: 50, pipeline_id: 9, stage_id: 159, owner_id: 7, sdr: 1, value: 42000, currency: "MXN",
  add_time: "2026-10-01T12:00:00Z", stage_change_time: "2026-10-20T12:00:00Z", next_activity_id: 900, last_activity_id: 901, ...o });

test("dealRow: colegio cruzado, embudo y etapa con su orden, valor, dueño y SDR, días, próxima y última, propuesta", () => {
  const r = DV.dealRow(deal(), ctx());
  assert.deepEqual(r.school, { id: "puebla-colegio-prueba", name: "Colegio Prueba", city: "Puebla" });
  assert.deepEqual(r.org, { id: 50, name: "COLEGIO PRUEBA" });
  assert.deepEqual([r.pipe, r.stage], [{ id: 9, name: "MX - SALES" }, { id: 159, name: "PROPOSAL SENT", order: 1 }]);
  assert.deepEqual([r.value, r.currency, r.owner, r.sdr], [42000, "MXN", { id: 7, name: "Joaquín AE" }, { id: 1, name: "Ana SDR" }]);
  assert.deepEqual([r.days, r.stale, r.created, r.proposal], [27, true, "2026-10-01", true]);
  assert.deepEqual(r.next, { id: 900, type: "meeting", subject: "Demo", date: "2026-11-18", time: "10:00", overdue: false, today: false });
  assert.deepEqual(r.last, { id: 901, type: "call", date: "2026-11-10" });
  assert.equal(r.nextUnknown, false);
});
test("dealRow: sin próxima, próxima vencida, próxima que no se pudo leer («?»), sin valor (0), SDR como objeto de v2, sin organización", () => {
  assert.equal(DV.dealRow(deal({ next_activity_id: null }), ctx()).next, null);
  assert.equal(DV.dealRow(deal({ next_activity_id: 902 }), ctx()).next.overdue, true);
  const u = DV.dealRow(deal({ next_activity_id: 12345 }), ctx());
  assert.deepEqual([u.next, u.nextUnknown], [null, true]);
  const z = DV.dealRow(deal({ value: 0, sdr: { id: 1, name: "x" }, org_id: null, last_activity_id: 902 }), ctx());
  assert.deepEqual([z.value, z.currency, z.sdr, z.org, z.school, z.last], [null, "", { id: 1, name: "Ana SDR" }, null, null, null]);
  assert.equal(DV.dealRow(deal({ sdr: null }), ctx()).sdr, null);
});
test("summarize, pipesView y sortRows: indicadores, embudos de más a menos con todas sus etapas en orden, orden de la lista", () => {
  const rows = [deal(), deal({ id: 2, stage_id: 160, value: 1000, next_activity_id: null, stage_change_time: "2026-11-15T12:00:00Z" }), deal({ id: 3, stage_id: 160, value: 500, currency: "USD", next_activity_id: 902 }),
    deal({ id: 4, pipeline_id: 12, stage_id: 118, value: 0, next_activity_id: 12345 })].map(d => DV.dealRow(d, ctx()));
  assert.deepEqual(DV.summarize(rows), { n: 4, value: [{ currency: "MXN", total: 43000 }, { currency: "USD", total: 500 }], noValue: 1, noNext: 1, stale: 3, overdue: 1 });
  const p = DV.pipesView(rows, stageList, pipes);
  assert.deepEqual(p.map(x => [x.id, x.name, x.n]), [[9, "MX - SALES", 3], [12, "LatAm - SALES", 1]]);
  assert.deepEqual(p[0].stages.map(s => [s.name, s.n]), [["SELLING", 2], ["PROPOSAL SENT", 1], ["HOT DEALS", 0], ["CLOSING", 0]]);
  assert.deepEqual(DV.sortRows(rows, "stage").map(r => r.id), [3, 2, 1, 4]);
  assert.deepEqual(DV.sortRows(rows, "days").map(r => r.id), [1, 3, 4, 2]); // empate en días: por id
  assert.deepEqual(DV.sortRows(rows, "next").map(r => r.id), [3, 1, 4, 2]); // vencida, la próxima, la que no se sabe, sin próxima
  assert.deepEqual(DV.sortRows(rows, "value").map(r => r.id), [1, 2, 3, 4]);
});

// ---------- alcance: 1 dirección, 2 líder fijo, 3 líder de SDR México (5 y 6 miembros), 4 líder de Cono Sur (7), 8 sin equipo
const users = [["ceo", 1], ["dueno", 2], ["la", 3], ["lb", 4], ["a1", 5], ["a2", 6], ["b1", 7], ["libre", 8]].map(([n, id]) => ({ id, name: n.toUpperCase(), email: `${n}@x.com` }));
const E = n => `${n}@x.com`;
const T0 = TM.normTeams({ teams: [{ id: "tsdrmx", name: "SDR México", leaders: [E("la")], members: [E("a1"), E("a2")] }, { id: "tsdrcs", name: "SDR Cono Sur", leaders: [E("lb")], members: [E("b1")] }] });
const fixed = { [E("ceo")]: "direccion", [E("dueno")]: "lider" };
const who = (n, T = T0) => {
  const v = TM.viewerOf({ email: E(n), fixed: fixed[E(n)] || null, assigned: null, T });
  const lead = TM.leadScope(v, T, users, { isLead: e => TM.viewerOf({ email: e, fixed: fixed[e] || null, T }).leader });
  return { v, T, lead, users, me: { email: E(n), pdUserId: users.find(u => u.email === E(n)).id } };
};
const sc = (n, owner, team = "", T) => DV.scopeOf({ ...who(n, T), owner, team });
const st = s => s.error?.status || s.kind;

test("scopeOf: «Míos» para todos (dueño o SDR); sin usuario de Pipedrive, 409", () => {
  assert.deepEqual(sc("a1", "me"), { kind: "person", id: 5, email: "a1@x.com", self: true });
  assert.deepEqual(sc("a1", ""), sc("a1", "me"));
  assert.equal(sc("a1", "5").self, true); // su propio id es «Míos»
  assert.equal(st(DV.scopeOf({ ...who("a1"), me: { email: "nadie@x.com" }, owner: "me" })), 409);
});
test("scopeOf: un SDR o un AE (miembro) no ve los de otro ni los del equipo: 403", () => {
  assert.equal(st(sc("a1", "6")), 403);
  assert.equal(st(sc("a1", "team")), 403);
  assert.equal(st(sc("libre", "5")), 403);
  assert.equal(st(sc("a1", "999")), 404); // no es usuario
  assert.equal(st(sc("a1", "abc")), 400);
});
test("scopeOf: un líder de equipo ve a su gente y su equipo; no a otro equipo, a otro líder ni a dirección (403)", () => {
  assert.equal(sc("la", "5").kind, "person");
  assert.equal(st(sc("la", "7")), 403); // miembro de otro equipo
  assert.equal(st(sc("la", "4")), 403); // otro líder
  assert.equal(st(sc("la", "1")), 403); // dirección
  const t = sc("la", "team");
  assert.deepEqual([t.kind, t.id, [...t.filter.ids].sort()], ["team", "tsdrmx", [3, 5, 6]]);
  assert.equal(st(sc("la", "team", "tsdrcs")), 403);
  assert.equal(st(sc("la", "team", "all")), 403);
});
test("scopeOf: dirección y los fijos ven a cualquiera, un equipo o toda la cuenta; sin equipos, cualquier líder ve todo", () => {
  for (const n of ["ceo", "dueno"]) {
    assert.equal(sc(n, "7").kind, "person"); assert.equal(sc(n, "3").kind, "person");
    assert.equal(sc(n, "team").kind, "all"); assert.equal(sc(n, "team", "all").kind, "all");
    assert.equal(sc(n, "team", "tsdrcs").id, "tsdrcs");
    assert.equal(st(sc(n, "team", "tnoexiste")), 404);
  }
  const NONE = TM.normTeams({ teams: [] });
  const lider = { ...who("la", NONE), v: TM.viewerOf({ email: E("la"), assigned: { level: "lider" }, T: NONE }) };
  lider.lead = TM.leadScope(lider.v, NONE, users);
  assert.equal(DV.scopeOf({ ...lider, owner: "7" }).kind, "person");
  assert.equal(DV.scopeOf({ ...lider, owner: "team" }).kind, "all");
  // equipos que no se pudieron leer: un líder de equipo no ve lo de otros (503), nunca «todos ven todo»
  const U = TM.normTeams({ unknown: true });
  assert.equal(st(DV.scopeOf({ ...who("la", U), owner: "team" })), 503);
});
test("inScope, readPlan y peopleFor: dueño o SDR; un AE se lee por dueño, lo demás entero; a quién se puede elegir", () => {
  const d = (owner_id, sdr) => ({ owner_id, sdr });
  const me = sc("a1", "me"), team = sc("la", "team"), all = sc("ceo", "team");
  assert.deepEqual([d(5, null), d(9, 5), d(9, { id: 5 }), d(9, 6)].map(x => DV.inScope(x, me)), [true, true, true, false]);
  assert.deepEqual([d(6, null), d(9, 3), d(7, 8), d(7, null)].map(x => DV.inScope(x, team)), [true, true, false, false]);
  assert.equal(DV.inScope(d(99, null), all), true);
  assert.equal(DV.inScope(d(5, null), { error: {} }), false);
  assert.deepEqual(DV.readPlan(me, "ae"), { ownerId: 5 });
  assert.deepEqual(DV.readPlan(me, "sdr"), { all: true });
  assert.deepEqual(DV.readPlan(team, "ae"), { all: true });
  assert.deepEqual(DV.peopleFor(who("la").lead, users, 3).map(p => p.id), [3, 5, 6]);
  assert.equal(DV.peopleFor(true, users, 1).length, 8);
  assert.deepEqual(DV.peopleFor(false, users, 5), []);
});

// ---------- la ruta, contra el Pipedrive de prueba
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
const JOAQUIN = 24821777;

test("GET /api/deals/open: Joaquín (AE) ve sus tratos de venta en orden, sin ONBOARDING ni DROPPED; los de otro o del equipo, 403", async () => {
  const j = await login("/auth/code", { email: "joaquin@ordereat.com", code: codeOf("joaquin@ordereat.com") });
  assert.equal((await j("/api/me/profile", { method: "POST", body: JSON.stringify({ name: "Joaquín Márquez", role: "ae" }) })).status, 200);
  const r = await j("/api/deals/open");
  assert.equal(r.status, 200);
  const d = r.body;
  assert.deepEqual([d.scope.kind, d.scope.self, d.truncated, d.people], ["person", true, false, []]);
  assert.ok(d.deals.length >= 7);
  assert.ok(d.deals.every(x => x.owner?.id === JOAQUIN || x.sdr?.id === JOAQUIN));
  assert.ok(d.deals.every(x => ![16, 22, 27].includes(x.pipe.id) && ![208, 249].includes(x.stage.id)));
  assert.equal(d.pipes[0].name, "MX - SALES");
  assert.deepEqual(d.pipes[0].stages.map(s => s.name), ["SELLING", "PROPOSAL SENT", "HOT DEALS", "CLOSING"]);
  assert.ok(d.summary.noNext >= 1 && d.summary.stale >= 1 && d.summary.overdue >= 1);
  assert.ok(d.deals.some(x => x.proposal === true) && d.deals.some(x => x.next?.overdue) && d.deals.some(x => !x.next && !x.nextUnknown));
  assert.equal((await j("/api/deals/open?owner=1")).status, 403);
  assert.equal((await j("/api/deals/open?owner=team")).status, 403);
});
test("GET /api/deals/open: el usuario de prueba (líder fijo) ve los suyos y donde es SDR; los de Joaquín y toda la cuenta", async () => {
  const me = await login("/auth/dev", {});
  const mine = (await me("/api/deals/open")).body;
  assert.ok(mine.deals.some(x => x.owner?.id === JOAQUIN && x.sdr?.id === 1), "donde figura como SDR");
  assert.ok(mine.deals.every(x => x.owner?.id === 1 || x.sdr?.id === 1));
  assert.ok(mine.people.some(p => p.id === JOAQUIN));
  const jq = (await me(`/api/deals/open?owner=${JOAQUIN}`)).body;
  assert.deepEqual([jq.scope.kind, jq.scope.self, jq.scope.person.name], ["person", false, "Joaquín Márquez"]);
  const all = (await me("/api/deals/open?owner=team")).body;
  assert.equal(all.scope.kind, "all");
  assert.ok(all.deals.length > mine.deals.length);
  assert.equal((await me("/api/deals/open?owner=424242")).status, 404);
});
