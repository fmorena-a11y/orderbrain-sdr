import test from "node:test";
import assert from "node:assert/strict";
import { resultMarks, demoResult, outcomeKey, resultLine, withResult, demoPast, people, demoBoard, pastResult, boardFor } from "../lib/demos.js";

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
  assert.deepEqual(r.people, [{ id: 3, name: "Ana Pérez", upcoming: 0, recent: 1 }, { id: 2, name: "Zoe", upcoming: 1, recent: 1 }]);
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

test("demoBoard: entradas automáticas aparte, No Show no queda en «Falta marcar», y un SDR ve solo lo suyo y el total", () => {
  const now = Date.parse("2026-11-10T20:00:00Z"), free = new Set([99]);
  const b = demoBoard([
    { id: 1, due_date: "2026-11-08", due_time: "", owner_id: 4, creator_user_id: 99, done: true }, // automática
    { id: 2, due_date: "2026-11-09", due_time: "", owner_id: 4, creator_user_id: 2 },
    { id: 3, due_date: "2026-10-20", due_time: "", owner_id: 4, creator_user_id: 2, type: "lunch", done: true }, // No Show en Pipedrive
    { id: 4, due_date: "2026-10-21", due_time: "", owner_id: 4, creator_user_id: 3 }, // vieja sin marcar
    { id: 5, due_date: "2026-11-12", due_time: "15:00", owner_id: 4, creator_user_id: 99, by: "Ana Pérez" }, // la nota manda sobre la cuenta general
  ], { users, profiles, free, today: "2026-11-10", tz: "UTC", now });
  assert.deepEqual(b.pending.map(r => r.id), [4]);
  assert.equal(b.recent.find(r => r.id === 1).auto, true);
  assert.deepEqual(b.people.map(p => [p.name, p.recent, p.upcoming, !!p.auto]), [["Ana Pérez", 0, 1, false], ["Zoe", 1, 0, false], ["", 1, 0, true]]);
  assert.equal(boardFor(b, { leader: true }), b);
  const s = boardFor(b, { leader: false, me: 2 });
  assert.ok(!("people" in s));
  assert.deepEqual(s.mine, { id: 2, name: "Zoe", upcoming: 0, recent: 1 });
  assert.deepEqual(s.total, { upcoming: 1, recent: 2 });
  assert.deepEqual(boardFor(b, { me: 77 }).mine, { id: 77, upcoming: 0, recent: 0 });
});
