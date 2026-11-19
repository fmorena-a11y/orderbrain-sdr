import test from "node:test";
import assert from "node:assert/strict";
import { resultMarks, demoResult, outcomeKey, resultLine, withResult, demoPast, people, pastResult, monthBoard, periodOf, periodChoices, pickPeriod, sourceKind, fuenteKindOf, countsFor, heldState } from "../lib/demos.js";

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

test("pastResult: una reprogramada cuya fecha nueva ya pasó queda «?»", () => {
  assert.equal(pastResult({ result: "moved" }, true), null);
  assert.equal(pastResult({ result: "moved" }, false), "moved");
  assert.equal(pastResult({ result: "done" }, true), "done");
});

// ---------- Demos por mes o trimestre (tarjeta «Demos» de Equipo, solo líderes y dirección)
test("períodos: mes, trimestre (Q1 = enero a marzo) y lo que se puede elegir (desde enero del año anterior, nada futuro)", () => {
  assert.deepEqual(periodOf("2026-11"), { kind: "month", key: "2026-11", year: 2026, from: "2026-11-01", to: "2026-11-30", label: "noviembre 2026" });
  assert.deepEqual([periodOf("2026-02").to, periodOf("2028-02").to], ["2026-02-28", "2028-02-29"]);
  assert.deepEqual(periodOf("2026-q4"), { kind: "q", key: "2026-Q4", year: 2026, q: 4, from: "2026-10-01", to: "2026-12-31", label: "Q4 2026 (octubre a diciembre)" });
  assert.deepEqual([periodOf("2026-Q1").to, periodOf("2026-Q2").from], ["2026-03-31", "2026-04-01"]);
  assert.equal(periodOf("2026-13"), null); assert.equal(periodOf("2026-Q5"), null); assert.equal(periodOf("noviembre"), null);
  const c = periodChoices("2026-11-16");
  assert.equal(c.current, "2026-11");
  assert.deepEqual([c.months[0].key, c.months.at(-1).key, c.months.length], ["2026-11", "2025-01", 23]);
  assert.deepEqual(c.quarters.map(q => q.key), ["2025-Q1", "2025-Q2", "2025-Q3", "2025-Q4", "2026-Q1", "2026-Q2", "2026-Q3", "2026-Q4"]);
  assert.deepEqual(periodChoices("2026-02-01").quarters.map(q => q.key).slice(-2), ["2025-Q4", "2026-Q1"]); // Q2 todavía no empezó
  assert.equal(pickPeriod("", "2026-11-16").key, "2026-11");
  assert.equal(pickPeriod("2026-12", "2026-11-16").key, "2026-11"); // futuro: el mes en curso
  assert.equal(pickPeriod("2024-12", "2026-11-16").key, "2026-11"); // más viejo que el año anterior
  assert.equal(pickPeriod("2025-Q2", "2026-11-16").key, "2025-Q2");
});

// las opciones reales del campo Fuente (lib/config.js FUENTE_LABELS, leídas de la cuenta el 16/11/2026)
const LBL = new Map([["502", "Outbound - Cold Calling"], ["503", "Outbound - Evento"], ["684", "Oubound - Contacto Cercano"], ["732", "Outbound - Referral Usuarios"],
  ["773", "Inbound - Meta Ads"], ["786", "Inbound - SDR Meta Ads Revival"], ["489", "Inbound - Búsqueda en Google"], ["505", "Inbound - Expansión de Cuenta"], ["494", "Otro (especificar en actividad de Demo)"]]);
test("Fuente → outbound o inbound por el nombre de la opción; vacía, «Otro», desconocida o las dos a la vez: sin fuente", () => {
  assert.deepEqual([fuenteKindOf("Inbound - Alianza"), fuenteKindOf("Outbound - Mailing"), fuenteKindOf("Oubound - Contacto Cercano"), fuenteKindOf("Otro (especificar…)"), fuenteKindOf("")], ["in", "out", "out", null, null]);
  assert.deepEqual(sourceKind([502], LBL), { kind: "out", label: "Outbound - Cold Calling" }); // v2: lista de ids
  assert.deepEqual(sourceKind("786", LBL), { kind: "in", label: "Inbound - SDR Meta Ads Revival" }); // v1 y prospectos: texto
  assert.equal(sourceKind([684], LBL).kind, "out");
  assert.equal(sourceKind([{ id: 505, label: "Inbound - Expansión de Cuenta" }], LBL).kind, "in");
  assert.deepEqual(sourceKind(null, LBL), { kind: "none", label: "" });
  assert.deepEqual(sourceKind([], LBL), { kind: "none", label: "" });
  assert.deepEqual(sourceKind([494], LBL), { kind: "none", label: "Otro (especificar en actividad de Demo)" });
  assert.deepEqual(sourceKind([9999], LBL), { kind: "none", label: "Opción que no está en la lista" });
  assert.deepEqual(sourceKind("502,773", LBL), { kind: "none", label: "Outbound - Cold Calling, Inbound - Meta Ads", mixed: true });
  assert.equal(sourceKind([494, 773], LBL).kind, "in"); // «Otro» más una inbound: inbound
});

test("Cuentan: en un SDR 2 inbound = 1 outbound; un AE sin ponderar; si alguna hecha no se pudo leer, «?»", () => {
  assert.equal(countsFor({ out: 6, in: 2, unread: 0 }), 7);
  assert.equal(countsFor({ out: 1, in: 1, unread: 0 }), 1.5);
  assert.equal(countsFor({ out: 6, in: 2, unread: 0 }, true), 8);
  assert.equal(countsFor({ out: 6, in: 2, unread: 1 }), null);
});

test("heldState: la marca de la app manda; No Show; hecha en Pipedrive; de hoy sin hora; sin marcar", () => {
  assert.equal(heldState({ mark: "canceled", done: true }, true), "appCanceled");
  assert.equal(heldState({ type: "lunch", done: true }, true), "noshow");
  assert.equal(heldState({ type: "meeting", done: true }, false), "done"); // hecha antes de la fecha: hecha
  assert.equal(heldState({ type: "meeting" }, true, true), "today");
  assert.equal(heldState({ type: "meeting", mark: "moved" }, false), "upcoming"); // reprogramada a futuro: agendada
  assert.equal(heldState({ type: "meeting", mark: "moved" }, true), "unmarked"); // y si la fecha nueva pasó, falta marcar
});

// Caso real (Pipedrive, solo lectura, 16/11/2026): las demos de noviembre que cargó Joaquin Fabregat (SDR, id 28543627) en las
// agendas de 6 personas. El líder: «tiene hechas 6 outbound, 2 inbound y 4 agendadas». La tarjeta vieja decía 6 «ya pasaron» y
// 3 «próximas» porque miraba del 10 al 16/11 y contaba la del 16 sin hora (y la No Show del 10) como «ya pasaron».
const JF = 28543627, FAV = 20758179, MAR = 24821777, COR = 26099394, FER = 22144333, JDE = 26594042, MAC = 28903866, RIC = 25513259;
const realUsers = [[JF, "Joaquin Fabregat"], [FAV, "Matias Favaro"], [MAR, "Joaquin Márquez"], [COR, "Santiago Correa"], [FER, "Feryenn Berriel"], [JDE, "Juan Diego Etcheverry"], [MAC, "Ignacio Maceiras"], [RIC, "Ricardo"]]
  .map(([id, name]) => ({ id, name, email: `${id}@x.com` }));
const jf = (id, owner, due_date, due_time, type, done, deal_id) => ({ id, type, owner_id: owner, creator_user_id: JF, due_date, due_time, done, deal_id, add_time: "2026-10-30T12:00:00Z" });
const JF_NOV = [
  jf(100479, MAC, "2026-11-02", "", "meeting", true, 6417), // St. Tomás de Aquino College Salta · 502 Outbound - Cold Calling
  jf(100514, COR, "2026-11-02", "", "meeting", true, 6419), // Universidad Cayetano Heredia · 786 Inbound - SDR Meta Ads Revival
  jf(99967, RIC, "2026-11-03", "", "lunch", true, 4816), // No Show
  jf(99015, MAR, "2026-11-05", "17:00", "meeting", true, 6370), // Liceo del Valle · 502
  jf(102494, JDE, "2026-11-06", "", "meeting", true, 6449), // Justo Juez - Arequipa · 786
  jf(101435, FER, "2026-11-10", "", "meeting", true, 6435), // COLEGIO LA PAZ VERACRUZ · 502
  jf(102835, JDE, "2026-11-10", "", "meeting", true, 6460), // Colegio Jean Piaget La Tinguiña · 502
  jf(103273, MAR, "2026-11-10", "", "lunch", true, 6470), // No Show (Paty Chávez · 786)
  jf(103485, FER, "2026-11-11", "", "meeting", true, 6473), // Colegio Cristobal Colon Veracruz · 502
  jf(103994, FAV, "2026-11-13", "", "meeting", true, 6485), // CENTRO EDUCATIVO DIOS PADRE · 503 Outbound - Evento
  jf(103817, FER, "2026-11-16", "", "meeting", false, 6483), // Colegio Buckingham · sin Fuente · hoy, sin hora
  jf(104555, FAV, "2026-11-17", "", "meeting", false, 6495), // Instituto Ayelén · 502
  jf(103685, FAV, "2026-11-19", "12:00", "meeting", false, 6477), // Adventist Institute Mendoza · sin Fuente
  jf(103705, COR, "2026-11-19", "", "meeting", false, 6478), // Colegio Adventista El Faro · 502
  jf(98860, MAC, "2026-10-29", "22:15", "meeting", true, 6363), // octubre: no entra
];
const JF_FUENTE = { 6417: [502], 6419: [786], 4816: null, 6370: [502], 6449: [786], 6435: [502], 6460: [502], 6470: [786], 6473: [502], 6485: [503], 6483: null, 6495: [502], 6477: null, 6478: [502], 6363: [502] };
const jfSource = a => sourceKind(JF_FUENTE[a.deal_id], LBL);
test("monthBoard, caso real: Joaquin Fabregat en noviembre = 6 outbound y 2 inbound hechas (cuentan 7), 4 agendadas, 2 No Show", () => {
  const now = Date.parse("2026-11-16T15:00:00Z"), tz = "America/Argentina/Buenos_Aires";
  const b = monthBoard(JF_NOV, { users: realUsers, profiles: {}, period: periodOf("2026-11"), tz, now, sourceOf: jfSource, ae: new Set([FAV, MAR, COR]) });
  const r = b.rows.find(x => x.id === JF);
  assert.deepEqual([r.out, r.in, r.none, r.done, r.counts, r.booked, r.noshow, r.unmarked, r.role], [6, 2, 0, 8, 7, 4, 2, 0, "sdr"]);
  assert.equal(b.rows.length, 1);
  assert.equal(b.items.length, 14); // la de octubre no
  assert.equal(b.items.find(x => x.id === 103817).state, "booked"); // hoy sin hora: agendada hasta que termine el día
  assert.deepEqual(b.items.filter(x => x.state === "booked").map(x => [x.id, x.kind]), [[103817, "none"], [104555, "out"], [103685, "none"], [103705, "out"]]);
  assert.deepEqual([b.totals.out, b.totals.in, b.totals.counts, b.totals.booked], [6, 2, 7, 4]);
  // el trimestre (Q4) también la incluye a la de octubre
  const q = monthBoard(JF_NOV, { users: realUsers, profiles: {}, period: periodOf("2026-Q4"), tz, now, sourceOf: jfSource });
  assert.deepEqual([q.rows[0].out, q.rows[0].in, q.rows[0].counts], [7, 2, 8]);
});

test("monthBoard: sin fuente y sin poder leer van aparte (nunca como outbound); AE sin ponderar; automáticas aparte; reprogramada, cancelada y sin marcar", () => {
  const users = [{ id: 2, name: "Zoe", email: "z@x.com" }, { id: 3, name: "Ana", email: "a@x.com" }, { id: 4, name: "Matías", email: "m@x.com" }], free = new Set([99]);
  const now = Date.parse("2026-11-16T15:00:00Z"), tz = "UTC";
  const d = (id, creator, due_date, x = {}) => ({ id, type: "meeting", owner_id: 4, creator_user_id: creator, due_date, due_time: "", done: true, deal_id: id, add_time: "2026-11-01T10:00:00Z", ...x });
  const src = { 1: [502], 2: [773], 3: null, 4: "unread", 5: [494], 6: [786], 7: [502], 8: [502], 9: [502], 10: [489], 11: [786] };
  const sourceOf = a => src[a.deal_id] === "unread" ? { kind: "unread", label: "" } : sourceKind(src[a.deal_id], LBL);
  const b = monthBoard([
    d(1, 2, "2026-11-02"), d(2, 2, "2026-11-03"), d(3, 2, "2026-11-04"), d(5, 2, "2026-11-05"),
    d(4, 3, "2026-11-06"), d(6, 3, "2026-11-06"), // a Ana no se le pudo leer una: «?»
    d(7, 2, "2026-11-09", { mark: "canceled" }), d(8, 2, "2026-11-12", { done: false }), // cancelada y sin marcar (pasó y no está hecha)
    d(9, 2, "2026-11-20", { done: false, mark: "moved", moved: true }), // reprogramada a futuro: agendada
    d(10, 4, "2026-11-10"), d(11, 4, "2026-11-11"), // Matías (AE) cargó las suyas: sin ponderar
    d(12, 99, "2026-11-11"), // entrada automática: aparte, sin «Cuentan»
    d(13, 2, "2026-12-01"), // diciembre: no entra
  ], { users, profiles: {}, free, period: periodOf("2026-11"), tz, now, sourceOf, ae: new Set([4]) });
  const by = Object.fromEntries(b.rows.map(r => [r.auto ? "auto" : r.name, r]));
  assert.deepEqual(b.rows.map(r => r.auto ? "auto" : r.name), ["Ana", "Matías", "Zoe", "auto"]);
  assert.deepEqual([by.Zoe.out, by.Zoe.in, by.Zoe.none, by.Zoe.counts, by.Zoe.canceled, by.Zoe.unmarked, by.Zoe.booked], [1, 1, 2, 1.5, 1, 1, 1]);
  assert.deepEqual([by.Ana.in, by.Ana.unread, by.Ana.counts], [1, 1, null]);
  assert.deepEqual([by.Matías.in, by.Matías.counts, by.Matías.role], [2, 2, "ae"]);
  assert.deepEqual([by.auto.done, by.auto.counts, by.auto.role], [1, null, null]);
  assert.equal(b.totals.counts, null); // una persona con «?»: el total también
  assert.equal(b.items.find(x => x.id === 3).kind, "none");
});

test("monthBoard por equipo: la lista, las que da o cargó su gente; las filas, solo su gente", () => {
  const users = [{ id: 5, name: "A1" }, { id: 6, name: "A2" }, { id: 7, name: "B1" }, { id: 2, name: "AE" }], A = { ids: new Set([5, 6]) };
  const dm = (id, owner, creator) => ({ id, type: "meeting", owner_id: owner, creator_user_id: creator, due_date: "2026-11-09", due_time: "15:00", done: true, add_time: "2026-11-01T10:00:00Z" });
  const b = monthBoard([dm(1, 2, 5), dm(2, 2, 7), dm(3, 7, 6), dm(4, 99, 99)], { users, free: new Set([99]), period: periodOf("2026-11"), tz: "UTC", now: Date.parse("2026-11-16T12:00:00Z"), team: A, sourceOf: () => ({ kind: "out", label: "" }) });
  assert.deepEqual(b.items.map(r => r.id), [1, 3]);
  assert.deepEqual(b.rows.map(r => r.id), [5, 6]);
});

// Hoy del líder (leadhome.js) muestra «Demos que cuentan» con «de N hechas en el mes» al lado: son dos números distintos y la
// pantalla lo dice. Hechas = todas las hechas del mes (con o sin fuente, también las automáticas); Cuentan = outbound + inbound ÷ 2
// de las personas (sin fuente ni automáticas). Equipo › Demos muestra los mismos dos totales (fila Total: «Cuentan» y la suma de
// outbound, inbound y sin fuente).
test("Hoy del líder: «Cuentan» y «hechas en el mes» salen del mismo tablero y miden cosas distintas", async () => {
  const { demosPart } = await import("../lib/leadview.js");
  const users = [{ id: 2, name: "Zoe", email: "z@x.com" }], free = new Set([99]), now = Date.parse("2026-11-16T15:00:00Z"), tz = "UTC";
  const d = (id, creator, x = {}) => ({ id, type: "meeting", owner_id: 2, creator_user_id: creator, due_date: "2026-11-10", due_time: "", done: true, deal_id: id, add_time: "2026-11-01T10:00:00Z", ...x });
  const src = { 1: [502], 2: [786], 3: [786], 4: null, 5: [502] };
  const b = monthBoard([d(1, 2), d(2, 2), d(3, 2), d(4, 2), d(5, 99)], { users, profiles: {}, free, period: periodOf("2026-11"), tz, now, sourceOf: a => sourceKind(src[a.deal_id], LBL) });
  // Zoe: 1 outbound + 2 inbound + 1 sin fuente; la automática (cuenta general 99): 1 outbound
  assert.deepEqual([b.totals.done, b.totals.out, b.totals.in, b.totals.none, b.totals.counts], [5, 2, 2, 1, 2]);
  const p = demosPart({ month: { ...b, partial: false }, win: { items: [], partial: false }, ids: new Set([2]), today: "2026-11-16", tomorrow: "2026-11-17" });
  assert.equal(p.totals.done, 5);   // «de 5 hechas en el mes»
  assert.equal(p.totals.counts, 2); // «Demos que cuentan»: 1 + 2 ÷ 2
  assert.deepEqual([p.by[2].done, p.by[2].counts], [4, 2]);
});
