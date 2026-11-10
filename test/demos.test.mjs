import test from "node:test";
import assert from "node:assert/strict";
import { resultMarks, demoResult, outcomeKey, resultLine, withResult, demoPast, people, demoBoard, dealFor, dealState, demoMetrics, attendance, pastResult } from "../lib/demos.js";

test("el resultado sale solo de la línea fija (o de outcome): sin marca es «?» aunque esté hecha", () => {
  const line = resultLine("noshow", { by: "Ana <Ruiz>", day: "2026-11-09" });
  assert.equal(line, "[Resultado de la demo] No se presentó · marcado por Ana <Ruiz> desde OrderBrain SDR el 09/11");
  const note = withResult("Agendada por Ana desde OrderBrain SDR", line);
  assert.match(note, /<br>\[Resultado de la demo\] No se presentó · marcado por Ana &lt;Ruiz&gt;/); // en HTML, escapado
  assert.equal(demoResult({ note, done: true }), "noshow");
  assert.equal(demoResult({ note: "no show, llamo a Marcelo para reagendar", done: true }), null); // texto libre: no se deduce
  assert.equal(demoResult({ note: "", done: true, outcome: null }), null);
  assert.equal(demoResult({ note: null, outcome: "no_show" }), "noshow");
  assert.equal(outcomeKey({ label: "Rescheduled" }), "moved");
  assert.equal(outcomeKey("algo raro"), null);
  // reprogramada y después hecha: manda la última marca; se recuerda que se reprogramó
  const two = withResult(withResult("", resultLine("moved", { by: "Ana", day: "2026-11-01", to: "05/11 10:00" })), resultLine("done", { by: "Ana", day: "2026-11-05" }));
  assert.deepEqual(resultMarks(two), ["moved", "done"]);
  assert.equal(demoResult({ note: two, outcome: "no_show" }), "done"); // la línea manda sobre outcome
});

test("demoPast: fecha y hora UTC; sin hora, desde que empieza el día", () => {
  const now = Date.parse("2026-11-10T15:00:00Z");
  assert.equal(demoPast({ due_date: "2026-11-10", due_time: "14:59" }, now), true);
  assert.equal(demoPast({ due_date: "2026-11-10", due_time: "15:30:00" }, now), false);
  assert.equal(demoPast({ due_date: "2026-11-10", due_time: "" }, now), true);
  assert.equal(demoPast({ due_date: "2026-11-11" }, now), false);
  // sin hora: el día de quien mira, no la medianoche UTC (el 10/11 a las 19:00 en México ya es el 11 en UTC)
  const eve = Date.parse("2026-11-11T01:00:00Z");
  assert.equal(demoPast({ due_date: "2026-11-11" }, eve, "America/Mexico_City"), false);
  assert.equal(demoPast({ due_date: "2026-11-11" }, eve, "UTC"), true);
  assert.equal(demoPast({ due_date: "2026-11-11" }, Date.parse("2026-11-11T06:00:00Z"), "America/Mexico_City"), true);
  assert.equal(demoPast({ due_date: "2026-11-11", due_time: "00:30" }, eve, "America/Mexico_City"), true); // con hora: la hora UTC manda
});

const users = [{ id: 1, name: "Token", email: "t@x.com" }, { id: 2, name: "Zoe", email: "zoe@x.com" }, { id: 3, name: "ana", email: "ana@x.com" }, { id: 4, name: "Matías", email: "m@x.com" }];
const profiles = { "ana@x.com": { name: "Ana Pérez" } };

test("quién la agendó: el nombre de la nota en las de la app (el creador es el token), si no creator_user_id", () => {
  const P = people(users, profiles);
  assert.deepEqual(P.setter({ creator_user_id: 1, by: "Ana Pérez" }), { id: 3, name: "Ana Pérez" });
  assert.deepEqual(P.setter({ creator_user_id: 2 }), { id: 2, name: "Zoe" });
  // con nota «Agendada por» que no es un usuario activo (desactivado, sin Pipedrive, otro nombre): ese nombre, nunca el creador (el token)
  assert.deepEqual(P.setter({ creator_user_id: 1, by: "Alguien de afuera" }), { id: null, name: "Alguien de afuera" });
  assert.deepEqual(P.setter({ creator_user_id: 1, by: "Ex SDR" }), { id: null, name: "Ex SDR" });
  assert.deepEqual(P.setter({}), { id: null, name: "" });
});

test("demoBoard: últimos 7 días y próximos 14, conteo por quién agendó en orden alfabético (sin puestos)", () => {
  const d = (id, due_date, due_time, creator, extra = {}) => ({ id, due_date, due_time, creator_user_id: creator, owner_id: 4, ...extra });
  const now = Date.parse("2026-11-10T20:00:00Z"); // 14:00 en México
  const r = demoBoard([d(1, "2026-11-12", "15:00", 2), d(2, "2026-11-05", "", 3, { result: "done", done: true }), d(3, "2026-10-01", "", 2), d(4, "2026-11-25", "", 2), d(5, "2026-11-10", "02:00", 2),
    d(6, "2026-10-25", "16:00", 2), d(7, "2026-10-26", "16:00", 2, { result: "canceled" })],
    { users, profiles, today: "2026-11-10", tz: "America/Mexico_City", now });
  assert.deepEqual(r.upcoming.map(x => x.id), [1]); // la 4 queda fuera (más de 14 días); la 5 es el 9 en México
  assert.deepEqual(r.recent.map(x => x.id), [5, 2]);
  assert.deepEqual(r.pending.map(x => x.id), [6]); // antes de los 7 días y sin resultado (la 3 es de hace más de 30 días; la 7 tiene resultado)
  assert.equal(r.upcoming[0].time, "09:00");
  assert.equal(r.recent[1].result, "done");
  assert.equal(r.recent[1].owner, "Matías");
  assert.deepEqual(r.people, [{ name: "Ana Pérez", upcoming: 0, recent: 1 }, { name: "Zoe", upcoming: 1, recent: 1 }]);
  assert.ok(!("pos" in r.people[0]) && !("rank" in r.people[0]));
});

test("demoBoard: una demo de hoy que ya pasó va a «ya pasaron»; una reprogramada cuya fecha nueva pasó queda «?»", () => {
  const now = Date.parse("2026-11-10T20:01:00Z"); // 14:01 en México
  const r = demoBoard([{ id: 1, due_date: "2026-11-10", due_time: "15:00", owner_id: 4 }, { id: 2, due_date: "2026-11-10", due_time: "22:00", owner_id: 4 },
    { id: 3, due_date: "2026-11-09", due_time: "15:00", owner_id: 4, result: "moved", moved: true }, { id: 4, due_date: "2026-11-12", due_time: "15:00", owner_id: 4, result: "moved", moved: true }],
    { users, profiles, today: "2026-11-10", tz: "America/Mexico_City", now });
  assert.deepEqual(r.upcoming.map(x => [x.id, x.result]), [[2, null], [4, "moved"]]); // la reprogramada a futuro dice «Reprogramada»
  assert.deepEqual(r.recent.map(x => [x.id, x.past, x.result, x.moved]), [[1, true, null, false], [3, true, null, true]]);
  assert.equal(pastResult({ result: "moved" }, true), null);
  assert.equal(pastResult({ result: "moved" }, false), "moved");
  assert.equal(pastResult({ result: "done" }, true), "done");
});

test("dealFor/dealState: el trato de la demo o el de la organización creado después; si no se sabe, «?»", () => {
  const deals = new Map([[10, { id: 10, status: "won" }]]), orgDeals = new Map([[7, [{ id: 20, status: "open", stage_id: 1, add_time: "2026-10-01 10:00:00", pipeline_id: 9 }, { id: 21, status: "open", stage_id: 2, add_time: "2026-11-03T10:00:00Z", pipeline_id: 16 }, { id: 22, status: "lost", add_time: "2026-11-04T10:00:00Z", pipeline_id: 9 }]], [8, []]]);
  const ctx = { deals, orgDeals, clientPipes: [16] };
  assert.equal(dealFor({ deal_id: 10 }, ctx).id, 10);
  assert.equal(dealFor({ deal_id: 99 }, ctx), undefined); // no lo encontramos: no se sabe
  assert.equal(dealFor({ org_id: 7, due_date: "2026-11-02", due_time: "" }, ctx).id, 22); // ni el de antes ni el de onboarding
  assert.equal(dealFor({ org_id: 8, due_date: "2026-11-02" }, ctx), null); // sin trato: la organización no tiene ninguno
  // tiene tratos, pero ninguno creado después de la demo (uno reabierto, uno sin vincular): no se sabe, «?»
  assert.equal(dealFor({ org_id: 7, due_date: "2026-11-05", due_time: "15:00" }, ctx), undefined);
  assert.equal(dealState(dealFor({ org_id: 10, due_date: "2026-10-20", due_time: "15:00" }, { ...ctx, orgDeals: new Map([[10, [{ id: 30, status: "open", add_time: "2026-10-19 10:00:00", pipeline_id: 9 }]]]) }), () => false), "unknown");
  // solo tratos de los embudos de clientes: tampoco se afirma «sin trato»
  assert.equal(dealFor({ org_id: 11, due_date: "2026-11-02" }, { ...ctx, orgDeals: new Map([[11, [{ id: 31, status: "open", add_time: "2026-11-03 10:00:00", pipeline_id: 16 }]]]) }), undefined);
  assert.equal(dealFor({ org_id: 9, due_date: "2026-11-02" }, ctx), undefined); // no se consultó
  assert.equal(dealFor({ lead_id: "x" }, ctx), undefined);
  const pp = d => d.stage_id === 2;
  assert.equal(dealState(undefined, pp), "unknown");
  assert.equal(dealState(null, pp), "none");
  assert.equal(dealState({ status: "open", stage_id: 2 }, pp), "proposal");
  assert.equal(dealState({ status: "open", stage_id: 1 }, pp), "open");
  assert.equal(dealState({ status: "lost" }, pp), "lost");
});

test("demoMetrics: asistencia solo sobre las marcadas, sin resultado aparte, país, tratos y días a ganar", () => {
  const now = Date.parse("2026-11-10T20:00:00Z");
  const base = { owner_id: 4, creator_user_id: 2, due_time: "15:00" };
  const demos = [
    { ...base, id: 1, due_date: "2026-11-02", result: "done", deal_id: 10, country: "México" },
    { ...base, id: 2, due_date: "2026-11-03", result: "done", deal_id: 11, country: "México" },
    { ...base, id: 3, due_date: "2026-11-04", result: "noshow", country: "México" },
    { ...base, id: 4, due_date: "2026-11-05", result: null, done: true, country: "Perú" }, // hecha en Pipedrive sin marca: «?»
    { ...base, id: 5, due_date: "2026-11-06", result: "canceled", creator_user_id: 3, owner_id: 1, deal_id: 12 },
    { ...base, id: 6, due_date: "2026-11-07", result: "moved", moved: true, creator_user_id: 3 },
    { ...base, id: 7, due_date: "2026-11-10", due_time: "23:00", result: null }, // todavía no pasó
    { ...base, id: 8, due_date: "2026-08-01", result: "done" }, // fuera del período
  ];
  const deals = new Map([[10, { id: 10, status: "won", pipeline_id: 9, won_time: "2026-11-12T15:00:00Z" }], [11, { id: 11, status: "lost", lost_reason: "Es muy caro", pipeline_id: 9 }], [12, { id: 12, status: "open", pipeline_id: 29 }]]);
  const r = demoMetrics(demos, { users, profiles, today: "2026-11-10", tz: "UTC", days: 30, deals, pipeCountry: { 29: "Perú" }, now });
  // la 6 (reprogramada, su fecha nueva ya pasó sin marca) es «?», no «con resultado»; se cuenta aparte que se reprogramó
  assert.deepEqual({ ...r.totals }, { set: 6, marked: 4, done: 2, noshow: 1, canceled: 1, unknown: 2, movedEver: 1, attendance: 67 });
  assert.equal(r.bySetter.find(x => x.name === "Ana Pérez").unknown, 1);
  assert.equal(r.bySetter.find(x => x.name === "Ana Pérez").movedEver, 1);
  assert.equal(r.deals.won, 1); assert.equal(r.deals.lost, 1);
  assert.deepEqual(r.deals.lostReasons, [{ reason: "Es muy caro", n: 1 }]);
  assert.equal(r.deals.avgDaysToWon, 10);
  assert.deepEqual(r.countries, ["México", "Perú", "?"]); // Perú también sale del embudo del trato
  assert.deepEqual(r.bySetter.map(x => [x.name, x.set, x.attendance]), [["Ana Pérez", 2, null], ["Zoe", 4, 67]]);
  assert.deepEqual(r.byOwner.map(x => x.name), ["Matías", "Token"]);
  const pe = demoMetrics(demos, { users, profiles, today: "2026-11-10", tz: "UTC", days: 30, deals, pipeCountry: { 29: "Perú" }, now, country: "Perú" });
  assert.equal(pe.totals.set, 2); assert.equal(pe.totals.attendance, null); // ninguna marcada como hecha o no-show: «?»
  assert.equal(attendance({ done: 0, noshow: 0 }), null);
});
