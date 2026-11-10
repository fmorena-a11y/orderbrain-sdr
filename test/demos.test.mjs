import test from "node:test";
import assert from "node:assert/strict";
import { resultMarks, demoResult, outcomeKey, resultLine, withResult, demoPast, people, demoBoard, dealFor, dealState, demoMetrics, attendance } from "../lib/demos.js";

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
});

const users = [{ id: 1, name: "Token", email: "t@x.com" }, { id: 2, name: "Zoe", email: "zoe@x.com" }, { id: 3, name: "ana", email: "ana@x.com" }, { id: 4, name: "Matías", email: "m@x.com" }];
const profiles = { "ana@x.com": { name: "Ana Pérez" } };

test("quién la agendó: el nombre de la nota en las de la app (el creador es el token), si no creator_user_id", () => {
  const P = people(users, profiles);
  assert.deepEqual(P.setter({ creator_user_id: 1, by: "Ana Pérez" }), { id: 3, name: "Ana Pérez" });
  assert.deepEqual(P.setter({ creator_user_id: 2 }), { id: 2, name: "Zoe" });
  assert.deepEqual(P.setter({ creator_user_id: 1, by: "Alguien de afuera" }), { id: 1, name: "Token" });
  assert.deepEqual(P.setter({}), { id: null, name: "" });
});

test("demoBoard: últimos 7 días y próximos 14, conteo por quién agendó en orden alfabético (sin puestos)", () => {
  const d = (id, due_date, due_time, creator, extra = {}) => ({ id, due_date, due_time, creator_user_id: creator, owner_id: 4, ...extra });
  const r = demoBoard([d(1, "2026-11-12", "15:00", 2), d(2, "2026-11-05", "", 3, { result: "done", done: true }), d(3, "2026-11-01", "", 2), d(4, "2026-11-25", "", 2), d(5, "2026-11-10", "02:00", 2)],
    { users, profiles, today: "2026-11-10", tz: "America/Mexico_City" });
  assert.deepEqual(r.upcoming.map(x => x.id), [1]); // la 4 queda fuera (más de 14 días); la 5 es el 9 en México
  assert.deepEqual(r.recent.map(x => x.id), [5, 2]);
  assert.equal(r.upcoming[0].time, "09:00");
  assert.equal(r.recent[1].result, "done");
  assert.equal(r.recent[1].owner, "Matías");
  assert.deepEqual(r.people, [{ name: "Ana Pérez", upcoming: 0, recent: 1 }, { name: "Zoe", upcoming: 1, recent: 1 }]);
  assert.ok(!("pos" in r.people[0]) && !("rank" in r.people[0]));
});

test("dealFor/dealState: el trato de la demo o el de la organización creado después; si no se sabe, «?»", () => {
  const deals = new Map([[10, { id: 10, status: "won" }]]), orgDeals = new Map([[7, [{ id: 20, status: "open", stage_id: 1, add_time: "2026-10-01 10:00:00", pipeline_id: 9 }, { id: 21, status: "open", stage_id: 2, add_time: "2026-11-03T10:00:00Z", pipeline_id: 16 }, { id: 22, status: "lost", add_time: "2026-11-04T10:00:00Z", pipeline_id: 9 }]], [8, []]]);
  const ctx = { deals, orgDeals, clientPipes: [16] };
  assert.equal(dealFor({ deal_id: 10 }, ctx).id, 10);
  assert.equal(dealFor({ deal_id: 99 }, ctx), undefined); // no lo encontramos: no se sabe
  assert.equal(dealFor({ org_id: 7, due_date: "2026-11-02", due_time: "" }, ctx).id, 22); // ni el de antes ni el de onboarding
  assert.equal(dealFor({ org_id: 8, due_date: "2026-11-02" }, ctx), null); // sin trato
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
  assert.deepEqual({ ...r.totals }, { set: 6, marked: 5, done: 2, noshow: 1, moved: 1, canceled: 1, unknown: 1, attendance: 67, movedEver: 1 });
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
