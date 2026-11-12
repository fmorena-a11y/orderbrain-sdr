// Historial de la ficha (lib/timeline.js): armado de la línea de tiempo, sin repetir lo que la app dejó en Pipedrive, y el
// «Resumen para la próxima llamada» (por reglas y el control de lo que devuelve la IA). Al final, con el Pipedrive de prueba
// (sales.timelineFor): el prospecto con varias llamadas, un contacto registrado desde la app y un mail.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
for (const k of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "PIPEDRIVE_API_TOKEN", "ANTHROPIC_API_KEY", "PIPEDRIVE_SMART_BCC", "GOOGLE_CLIENT_SECRET"]) delete process.env[k];
process.env.DEMO_MODE = "1";
process.env.SESSION_SECRET = "clave-de-prueba";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ob-test-"));
const T = await import("../lib/timeline.js");
const { buildTimeline, callSummary, actWhen, plain, splitHead, rowsOf, page, groundAi, aiEntries, grounded, relDay } = T;

// ---------- datos con la forma real de Pipedrive (v2 actividades, v1 notas), como el prospecto del caso real (datos de prueba)
const L = "lead-1", TZ = "America/Mexico_City", TODAY = "2026-11-11";
const users = [{ id: 10, name: "Ana Ruiz" }, { id: 20, name: "Pedro Gil" }, { id: 99, name: "OrderEAT" }];
const act = (id, x) => ({ id, type: "call", subject: "Llamada", owner_id: 10, creator_user_id: 10, is_deleted: false, deal_id: null, lead_id: L, person_id: null, org_id: null, due_time: null, done: true, ...x });
const ACTS = [
  act(1, { owner_id: 20, add_time: "2026-06-25T17:10:43Z", due_date: "2026-06-25", marked_as_done_time: "2026-06-25T17:10:43Z", note: "No tienen cafeteria" }),
  act(2, { subject: "Llamada – visita Joaco", add_time: "2026-11-10T19:02:35Z", due_date: "2026-11-10", marked_as_done_time: "2026-11-10T19:11:21Z", note: "287 alumnos. Llamar al (222) 555 0147 (sin WhatsApp). Pedir quien ve la cafetería y ofrecer visita de Joaquín mié 11 tarde / jue 12." }),
  act(3, { add_time: "2026-11-10T19:02:53Z", due_date: "2026-11-10", marked_as_done_time: "2026-11-10T19:02:53Z", note: "esta ocupada la linea" }),
  act(4, { add_time: "2026-11-10T19:03:05Z", due_date: "2026-11-11", marked_as_done_time: "2026-11-10T19:11:01Z", note: null }),
  act(5, { add_time: "2026-11-10T19:06:29Z", due_date: "2026-11-10", marked_as_done_time: "2026-11-10T19:11:14Z", note: "me dijeron de recepción (no me quiso decir su nombre) que llamara mas tarde que no se encontraba ni la directora ni la encargada de la cafetería&nbsp;" }),
  act(6, { add_time: "2026-11-10T19:06:57Z", due_date: "2026-11-10", due_time: "20:15", done: false, marked_as_done_time: null, note: null }),
];
const NOTES = [{ id: 50, user_id: 10, lead_id: L, org_id: null, deal_id: null, person_id: null, active_flag: true, add_time: "2026-11-10 21:38:26", user: { name: "Ana Ruiz" }, lead: { title: "Centro Educativo Prueba" },
  content: "<b>Datos del colegio · OrderBrain SDR</b><br>Enriquecido el 2026-11-10 por Ana Ruiz.<br><ul><li>Teléfono: (222) 555 0147 (Prospecto en Pipedrive)</li><li>Mail: <a href=\"mailto:contacto@ejemplo.mx\">contacto@ejemplo.mx</a> (Web)</li></ul>" }];
const LEAD = { id: L, title: "Centro Educativo Prueba", addTime: "2025-08-05T01:24:36.687Z", creatorId: 99, origin: "Import" };
const caseItems = () => buildTimeline({ acts: ACTS, notes: NOTES, leads: [LEAD], users, mainLeadId: L, types: { call: "Llamada" }, tz: TZ });
const ctx = (x = {}) => ({ school: { name: "Centro Educativo Prueba", city: "Puebla", country: "México" }, status: "lead", today: TODAY, tz: TZ, me: "Ana", meNames: ["Ana Ruiz"],
  pending: [{ label: "Llamada", subject: "Llamada", date: "2026-11-10", time: "14:15", who: "Ana Ruiz", late: true }], ...x });

// ---------- texto y fechas
test("plain: saca HTML, &nbsp; y listas; splitHead y rowsOf leen las notas de la app", () => {
  assert.equal(plain("hola&nbsp;<br>que <b>tal</b>&amp; bien<ul><li>uno</li><li>dos</li></ul>"), "hola\nque tal& bien\n• uno\n• dos");
  assert.deepEqual(splitHead("<b>Comentario</b><br>texto"), { head: "Comentario", rest: "<br>texto" });
  assert.deepEqual(splitHead("sin título"), { head: "", rest: "sin título" });
  assert.deepEqual(rowsOf("<b>Llamada · Atendió recepción</b><br><b>Preguntar por:</b> Marta (Directora)<br><b>Cafetería:</b> Propia<br><br>texto suelto: no es fila"), [["Preguntar por", "Marta (Directora)"], ["Cafetería", "Propia"]]);
});
test("actWhen: con hora va con hora; hecha antes de su fecha va el día que se hizo (early); sin hora, el día y se ordena por cuándo se marcó", () => {
  assert.deepEqual(actWhen({ due_date: "2026-11-10", due_time: "20:15" }, TZ), { at: "2026-11-10T20:15:00.000Z", day: "", timed: true });
  assert.deepEqual(actWhen({ due_date: "2026-11-11", marked_as_done_time: "2026-11-10T19:11:01Z" }, TZ), { at: "2026-11-10T19:11:01.000Z", day: "", timed: false, early: { day: "2026-11-11", time: "" } });
  assert.deepEqual(actWhen({ due_date: "2026-11-10", marked_as_done_time: "2026-11-10T19:02:53Z" }, TZ), { at: "2026-11-10T19:02:53.000Z", day: "2026-11-10", timed: false });
  // marcada hecha mucho después (una limpieza): queda en su fecha y dice cuándo se marcó
  assert.deepEqual(actWhen({ due_date: "2026-06-25", marked_as_done_time: "2026-07-20T10:00:00Z" }, TZ), { at: "2026-06-25T12:00:00.000Z", day: "2026-06-25", timed: false, marked: "2026-07-20" });
  assert.equal(relDay("2026-11-10", TODAY), "ayer"); assert.equal(relDay("2026-11-11", TODAY), "hoy"); assert.equal(relDay("2026-06-25", TODAY), "el 25/06/2026"); assert.equal(relDay("2026-11-09", TODAY), "el lunes");
});

// ---------- armado
test("caso real: 5 llamadas hechas + la nota + «Prospecto creado»; lo sin hacer no entra; de la más nueva a la más vieja, con quién y su nota", () => {
  const it = caseItems();
  assert.equal(it.length, 7);
  assert.deepEqual(it.map(x => x.id), ["n:50", "a:2", "a:5", "a:4", "a:3", "a:1", "l:lead-1"]);
  const [n, a2, a5, a4, a3, a1, l] = it;
  assert.equal(n.title, "Datos del colegio · OrderBrain SDR"); assert.equal(n.who, "Ana Ruiz"); assert.match(n.text, /• Teléfono: \(222\) 555 0147/);
  assert.equal(a2.title, "Llamada – visita Joaco"); assert.equal(a2.label, "Llamada"); assert.equal(a2.day, "2026-11-10"); assert.match(a2.text, /^287 alumnos/);
  assert.equal(a5.text, "me dijeron de recepción (no me quiso decir su nombre) que llamara mas tarde que no se encontraba ni la directora ni la encargada de la cafetería");
  assert.deepEqual(a4.early, { day: "2026-11-11", time: "" }); assert.equal(a4.text, "");
  assert.equal(a3.text, "esta ocupada la linea");
  assert.equal(a1.who, "Pedro Gil"); assert.equal(a1.day, "2026-06-25");
  assert.equal(l.label, "Prospecto creado"); assert.equal(l.who, "OrderEAT"); assert.equal(l.text, "Origen: importado"); assert.equal(l.at, "2025-08-05T01:24:36.687Z");
  assert.ok(!it.some(x => x.id === "a:6"));
});
test("la misma actividad o nota leída por la organización y por la persona va una vez", () => {
  const a = act(7, { org_id: 1, person_id: 5, lead_id: null, due_date: "2026-11-01", marked_as_done_time: "2026-11-01T15:00:00Z", note: "x" });
  const it = buildTimeline({ acts: [a, { ...a }], notes: [NOTES[0], { ...NOTES[0] }], persons: [{ id: 5, name: "Marta" }], users, orgs: [{ id: 1, name: "Colegio", main: true }] });
  assert.equal(it.filter(x => x.id === "a:7").length, 1); assert.equal(it.filter(x => x.id === "n:50").length, 1);
  assert.equal(it.find(x => x.id === "a:7").where, "con Marta");
});
test("contacto registrado en la app: una sola entrada con la actividad, la nota ordenada y el contacto", () => {
  const at = "2026-11-10T15:00:30.000Z";
  const touches = [{ at, by: "ana@ordereat.com", byName: "Ana Ruiz", outcome: "gatekeeper", channel: "call", connected: true, text: "Recepción: llamar después de las 11" }];
  const acts = [act(8, { subject: "Llamada: Atendió recepción · Colegio X", add_time: "2026-11-10T15:00:20Z", due_date: "2026-11-10", marked_as_done_time: "2026-11-10T15:00:20Z", note: "Recepción: llamar después de las 11<br>Pidió que sea con la directora" }),
    act(9, { subject: "Llamada", add_time: "2026-11-10T16:00:00Z", due_date: "2026-11-10", marked_as_done_time: "2026-11-10T16:00:00Z", note: "otra llamada, de Pipedrive" })];
  const notes = [{ id: 60, add_time: "2026-11-10 15:00:25", user: { name: "Ana Ruiz" }, lead_id: L, content: "<b>Llamada · Atendió recepción</b><br><b>Preguntar por:</b> Marta (Directora)<br><br>Recepción: llamar después de las 11<br><br><i>Cargado por Ana Ruiz desde OrderBrain SDR</i>" },
    { id: 61, add_time: "2026-11-10 17:00:00", user: { name: "Ana Ruiz" }, lead_id: L, content: "<b>Comentario</b><br>Vuelvo a probar el jueves<br><br><i>Cargado por Ana Ruiz desde OrderBrain SDR</i>" }];
  const it = buildTimeline({ acts, notes, touches, users, mainLeadId: L });
  assert.equal(it.length, 3);
  const c = it.find(x => x.kind === "contact");
  assert.equal(c.label, "Llamada"); assert.equal(c.title, "Atendió recepción"); assert.equal(c.src, "both"); assert.equal(c.at, at);
  assert.equal(c.text, "Recepción: llamar después de las 11\nPidió que sea con la directora");
  assert.deepEqual(c.rows, [["Preguntar por", "Marta (Directora)"]]);
  assert.ok(it.some(x => x.id === "a:9")); assert.equal(it.find(x => x.id === "n:61").title, "Comentario");
});
test("actividad que dejó la app sin contacto guardado acá (otra instancia): va como actividad y junta su nota", () => {
  const acts = [act(8, { subject: "WhatsApp: No atendió · Colegio X", type: "deadline", add_time: "2026-11-10T15:00:20Z", due_date: "2026-11-10", marked_as_done_time: "2026-11-10T15:00:20Z", note: "" })];
  const notes = [{ id: 60, add_time: "2026-11-10 15:00:25", user: { name: "Ana Ruiz" }, lead_id: L, content: "<b>WhatsApp · No atendió</b><br><b>Próximo paso:</b> Llamada el jueves<br><br><i>Cargado por Ana Ruiz desde OrderBrain SDR</i>" }];
  const it = buildTimeline({ acts, notes, users, mainLeadId: L });
  assert.equal(it.length, 1); assert.equal(it[0].icon, "whatsapp"); assert.deepEqual(it[0].rows, [["Próximo paso", "Llamada el jueves"]]);
});
test("mail enviado desde la ficha: una entrada aunque haya actividad «Mail», nota y contacto; sin id de actividad, por el asunto", () => {
  const at = "2026-11-10T15:00:00.000Z", mails = [{ id: "m1", at, byName: "Ana Ruiz", to: "dir@colegio.mx", subject: "OrderEAT para la cafetería", body: "Hola", activityId: 70 },
    { id: "m2", at: "2026-11-09T15:00:00.000Z", byName: "Ana Ruiz", to: "dir@colegio.mx", subject: "Segundo", body: "Hola 2" }];
  const touches = [{ at, byName: "Ana Ruiz", outcome: "sent", channel: "mail", mailId: "m1", text: "OrderEAT para la cafetería", to: "dir@colegio.mx" },
    { at: "2026-11-09T15:00:00.000Z", byName: "Ana Ruiz", outcome: "sent", channel: "mail", mailId: "m2", text: "Segundo" }];
  const acts = [act(70, { type: "task", subject: "Mail: OrderEAT para la cafetería · Colegio X", add_time: "2026-11-10T15:00:05Z", due_date: "2026-11-10", marked_as_done_time: "2026-11-10T15:00:05Z", note: "<b>Para:</b> dir@colegio.mx" }),
    act(71, { type: "task", subject: "Mail: Segundo · Colegio X", add_time: "2026-11-09T15:00:04Z", due_date: "2026-11-09", marked_as_done_time: "2026-11-09T15:00:04Z", note: "x" })];
  const notes = [{ id: 80, add_time: "2026-11-10 15:00:08", lead_id: L, content: "<b>Mail enviado</b> a dir@colegio.mx<br><b>Asunto:</b> OrderEAT para la cafetería<br><br>Hola<br><br><i>Enviado por Ana Ruiz desde OrderBrain SDR con su Gmail</i>" },
    { id: 81, add_time: "2026-11-09 15:00:09", lead_id: L, content: "<b>Mail enviado</b> a dir@colegio.mx<br><b>Asunto:</b> Segundo<br><br>Hola 2<br><br><i>Enviado por Ana Ruiz desde OrderBrain SDR con su Gmail</i>" }];
  const it = buildTimeline({ acts, notes, touches, mails, users, mainLeadId: L });
  assert.deepEqual(it.map(x => x.id), ["m:m1", "m:m2"]);
  assert.equal(it[0].src, "both"); assert.deepEqual(it[0].mail, { to: "dir@colegio.mx", subject: "OrderEAT para la cafetería", body: "Hola", next: null });
});
test("tratos: creado, ganado y perdido con motivo; borrados no; los de una organización duplicada dicen dónde", () => {
  const deals = [{ id: 1, org_id: 2, title: "Colegio - Trato", status: "lost", pipeline_id: 9, stage_id: 159, add_time: "2026-01-10T10:00:00Z", lost_time: "2026-03-01T10:00:00Z", lost_reason: "No responde  más", creator_user_id: 10, owner_id: 20 },
    { id: 2, org_id: 1, title: "Colegio - Cliente", status: "won", pipeline_id: 16, stage_id: 164, add_time: "2026-04-01T10:00:00Z", won_time: "2026-05-01T10:00:00Z", owner_id: 10 },
    { id: 3, org_id: 1, title: "Borrado", status: "deleted", add_time: "2026-04-01T10:00:00Z" }];
  const it = buildTimeline({ deals, users, orgs: [{ id: 1, name: "Colegio", main: true, sure: true }, { id: 2, name: "COLEGIO", main: false, sure: true }], pipes: { 9: "MX - SALES", 16: "ONBOARDING" }, stages: { 159: "PROPOSAL SENT", 164: "READY" }, web: "https://x.pipedrive.com" });
  assert.deepEqual(it.map(x => `${x.label}|${x.title}`), ["Trato ganado|Colegio - Cliente", "Trato creado|Colegio - Cliente", "Trato perdido|Colegio - Trato", "Trato creado|Colegio - Trato"]);
  const lost = it.find(x => x.label === "Trato perdido");
  assert.equal(lost.text, "Motivo: No responde más\nEtapa: PROPOSAL SENT"); assert.equal(lost.where, "en «COLEGIO» (otra organización de este colegio)"); assert.equal(lost.aside, undefined); assert.equal(lost.url, "https://x.pipedrive.com/deal/1");
  assert.equal(it.find(x => x.id === "d:1:add").who, "Ana Ruiz");
});
test("page: de a 50, con total y si hay más", () => {
  const items = Array.from({ length: 120 }, (_, i) => ({ id: i }));
  assert.deepEqual({ ...page(items, 0, 50), items: undefined }, { items: undefined, total: 120, offset: 0, more: true });
  assert.equal(page(items, 100, 50).items.length, 20); assert.equal(page(items, 100, 50).more, false);
  assert.equal(page(items, "x", "y").items.length, 50);
});

// ---------- resumen por reglas
test("resumen del caso real: conteo, qué pasó (citas), datos con su fuente, plan, objeción vieja, pendiente y la apertura desde recepción", () => {
  const s = callSummary(caseItems(), ctx());
  assert.equal(s.mode, "reglas"); assert.equal(s.cold, false); assert.equal(s.count, 5);
  assert.equal(s.headline, "5 llamadas. Último contacto: ayer (Ana Ruiz); primero: el 25/06/2026 (Pedro Gil).");
  assert.deepEqual(s.happened.map(h => h.text), ["me dijeron de recepción (no me quiso decir su nombre) que llamara mas tarde que no se encontraba ni la directora ni la encargada de la cafetería", "esta ocupada la linea", "No tienen cafeteria"]);
  assert.deepEqual(s.facts.map(f => `${f.k}: ${f.v}`), ["Alumnos: 287", "Teléfono: (222) 555 0147 (sin WhatsApp)", "Cuándo llamar: más tarde", "Mail: contacto@ejemplo.mx"]);
  assert.equal(s.facts[0].src, "Llamada – visita Joaco · ayer · Ana Ruiz");
  assert.deepEqual(s.askFor.map(a => a.text), ["la directora", "la encargada de la cafetería"]);
  assert.deepEqual(s.plan.map(p => p.text), ["Llamar al (222) 555 0147 (sin WhatsApp)", "Pedir quien ve la cafetería y ofrecer visita de Joaquín mié 11 tarde / jue 12"]);
  assert.equal(s.warnings[0].text, "El 25/06/2026 Pedro Gil anotó «No tienen cafeteria». Confirmalo al principio de la llamada.");
  assert.deepEqual(s.pending, [{ text: "Llamada vencida ayer 14:15", late: true }]);
  assert.equal(s.opening, "Hola, ¿qué tal? Te habla Ana de OrderEAT. Ayer llamé y en recepción me pidieron que llame más tarde porque no estaban la directora ni la encargada de la cafetería. ¿Me comunicas con la directora o con la encargada de la cafetería?");
  assert.equal(s.openingSrc, "Llamada · ayer · Ana Ruiz");
});
test("resumen: no inventa números ni nombres (todo lo de la apertura y los datos está en las notas)", () => {
  const items = caseItems(), s = callSummary(items, ctx()), corpus = items.map(x => `${x.title} ${x.text} ${x.who}`).join(" ");
  for (const f of s.facts) assert.ok(corpus.includes(f.v.replace(/ \(sin WhatsApp\)$/, "")) || corpus.replace(/mas tarde/g, "más tarde").includes(f.v), f.v);
  for (const n of s.opening.match(/\d+/g) || []) assert.ok(corpus.includes(n), n);
  for (const w of ["directora", "encargada de la cafetería", "recepción"]) assert.ok(corpus.includes(w));
});
test("resumen: si la llamada anterior fue de otra persona, la apertura va en plural; en Argentina con vos", () => {
  const s = callSummary(caseItems(), ctx({ me: "Pedro", meNames: ["Pedro Gil"] }));
  assert.match(s.opening, /^Hola, ¿qué tal\? Te habla Pedro de OrderEAT\. Ayer llamamos y en recepción nos pidieron que llamemos más tarde porque no estaban la directora ni la encargada de la cafetería\./);
  const ar = callSummary(caseItems(), ctx({ school: { name: "Colegio", city: "Córdoba", country: "Argentina" } }));
  assert.match(ar.opening, /¿Me comunicás con la directora/);
});
test("resumen: sin contactos es primer contacto en frío, con la apertura de la casa (en Chile, «el casino»)", () => {
  const s = callSummary([], ctx({ school: { name: "Colegio Andino", city: "Santiago", country: "Chile" }, pending: [] }));
  assert.equal(s.cold, true); assert.equal(s.headline, "Todavía no hay contactos: es primer contacto en frío.");
  assert.match(s.opening, /Habla Ana de OrderEAT\. Trabajamos con colegios de Santiago digitalizando el casino/);
  // solo la nota de Enriquecer (la arma la app) no cuenta como contacto
  assert.equal(callSummary(buildTimeline({ notes: NOTES, users }), ctx()).cold, true);
});
test("resumen: solo intentos sin respuesta → apertura de «no atendió»; actividades sin nota lo dicen", () => {
  const acts = [act(3, { add_time: "2026-11-10T19:02:53Z", due_date: "2026-11-10", marked_as_done_time: "2026-11-10T19:02:53Z", note: "esta ocupada la linea" })];
  assert.match(callSummary(buildTimeline({ acts, users }), ctx()).opening, /Ayer llamé y la línea estaba ocupada\. Quería hablar con quien ve la cafetería del colegio: ¿con quién me comunico\?$/);
  const s = callSummary(buildTimeline({ acts: [act(4, { due_date: "2026-11-09", marked_as_done_time: "2026-11-09T19:00:00Z", note: null })], users }), ctx());
  assert.equal(s.thin, "Hay actividades hechas pero sin notas: no se sabe qué pasó en ellas.");
  assert.match(s.openingSrc, /^Plantilla/);
});
test("resumen: contacto de la app con «Preguntar por» → pide por esa persona", () => {
  const touches = [{ at: "2026-11-10T15:00:00.000Z", byName: "Ana Ruiz", outcome: "gatekeeper", channel: "call", text: "" }];
  const notes = [{ id: 60, add_time: "2026-11-10 15:00:05", lead_id: L, content: "<b>Llamada · Atendió recepción</b><br><b>Preguntar por:</b> Marta Díaz (Directora)<br><br><i>Cargado por Ana Ruiz desde OrderBrain SDR</i>" }];
  const s = callSummary(buildTimeline({ touches, notes, users }), ctx());
  assert.equal(s.opening, "Hola, ¿qué tal? Te habla Ana de OrderEAT. Ayer llamé y me atendieron en recepción. ¿Me comunicas con Marta Díaz?");
  assert.deepEqual(s.askFor.map(a => a.text), ["Marta Díaz (Directora)"]);
});

test("resumen: solo notas («Habló con la administradora… volvamos a llamar el próximo ciclo») → retoma con esa persona", () => {
  const notes = [{ id: 90, org_id: 1, add_time: "2026-07-04 15:20:00", user: { name: "Pedro Gil" }, content: "<b>Llamada</b><br>Habló con la administradora. La cafetería es concesionada; pidió que volvamos a llamar el próximo ciclo." }];
  const s = callSummary(buildTimeline({ notes, users, orgs: [{ id: 1, name: "Colegio", main: true }] }), ctx({ pending: [] }));
  assert.equal(s.cold, false); assert.equal(s.headline, "Todavía no hay contactos registrados: hay 1 nota.");
  assert.equal(s.opening, "Hola, ¿qué tal? Te habla Ana de OrderEAT. El 04/07/2026 hablamos con la administradora sobre la cafetería y nos pidió que volviéramos a llamar el próximo ciclo. ¿Me comunicas con ella?");
  assert.match(s.warnings[0].text, /^El 04\/07\/2026 Pedro Gil anotó «La cafetería es concesionada; pidió que volvamos a llamar el próximo ciclo»/);
});

// ---------- control de la IA
test("groundAi: va lo que cita una entrada y no nombra números ni nombres que no están; si la apertura inventa, va la de reglas", () => {
  const items = caseItems(), rules = callSummary(items, ctx()), entries = aiEntries(items, { tz: TZ, today: TODAY });
  assert.match(entries[2].line, /^\[3\] 10\/11\/2026 \(ayer\) · Llamada · Ana Ruiz: me dijeron de recepción/);
  const raw = { que_paso: [{ texto: "Recepción pidió que llame más tarde: no estaban la directora ni la encargada de la cafetería.", fuentes: [3] }, { texto: "Hablaron con Roberto, el dueño.", fuentes: [3] }, { texto: "Sin fuente", fuentes: [] }],
    datos: [{ k: "Alumnos", v: "287", fuentes: [2] }, { k: "Alumnos", v: "350", fuentes: [2] }, { k: "Mail", v: "contacto@ejemplo.mx", fuentes: [99] }],
    ojo: [{ texto: "En junio anotaron que no tienen cafetería.", fuentes: [6] }],
    apertura: "Hola, ¿qué tal? Te habla Ana de OrderEAT. Ayer me pidieron en recepción que llame más tarde; ¿me comunicas con la directora?", apertura_fuentes: [3] };
  const s = groundAi(raw, entries, rules, { names: ["Ana"] });
  assert.equal(s.mode, "ia");
  assert.deepEqual(s.happened.map(h => h.text), ["Recepción pidió que llame más tarde: no estaban la directora ni la encargada de la cafetería."]);
  assert.equal(s.happened[0].src, "Llamada · ayer · Ana Ruiz", "la fuente se lee como en el Historial, sin el número que ve el modelo");
  assert.deepEqual(s.facts.map(f => f.v), ["287", "(222) 555 0147 (sin WhatsApp)", "más tarde", "contacto@ejemplo.mx"], "lo de la IA y, de las reglas, lo que la IA no trajo");
  assert.equal(s.opening, raw.apertura); assert.equal(s.count, 5); assert.deepEqual(s.pending, rules.pending);
  const bad = groundAi({ ...raw, apertura: "Hola, te habla Ana. ¿Me comunicas con Roberto a las 9?" }, entries, rules, { names: ["Ana"] });
  assert.equal(bad.opening, rules.opening); assert.match(bad.openingNote, /va la de reglas/);
  assert.equal(groundAi({ que_paso: [], datos: [] }, entries, rules), null);
  assert.equal(grounded("Llamá a las 9", "nada"), false); assert.equal(grounded("Lo vemos 20 minutos", "nada"), true);
});

// ---------- hallazgos de la revisión
test("duplicada de otra organización con este nombre y sin ciudad: va a la lista (aside) pero no al resumen (teléfono, mail, conteo ni apertura)", () => {
  const orgs = [{ id: 1, name: "Colegio Americano", main: true, sure: true }, { id: 2, name: "Colegio Americano", main: false, sure: false }];
  const acts = [act(30, { lead_id: null, org_id: 1, due_date: "2026-11-01", marked_as_done_time: "2026-11-01T16:00:00Z", note: "Habló con la administradora. Pidió que volvamos a llamar el próximo mes." }),
    act(31, { lead_id: null, org_id: 2, owner_id: 20, due_date: "2026-11-10", marked_as_done_time: "2026-11-10T17:00:00Z", note: "Atendió recepción: que llame a las 10" })];
  const notes = [{ id: 70, org_id: 2, add_time: "2026-10-10 16:00:00", user: { name: "Pedro Gil" }, content: "<b>Llamada</b><br>Conmutador 229 555 0130. Mail recepcion@ejemplo-veracruz.edu.mx. Llamar la semana que viene." }];
  const it = buildTimeline({ acts, notes, users, orgs, tz: TZ });
  assert.deepEqual(it.map(x => [x.id, !!x.aside]), [["a:31", true], ["a:30", false], ["n:70", true]]);
  assert.equal(it[0].where, "en «Colegio Americano» (otra organización con este nombre, sin ciudad)");
  const sm = callSummary(it, ctx({ pending: [] }));
  assert.equal(sm.count, 1); assert.match(sm.headline, /^1 llamada\. Último contacto: el 01\/11\/2026 \(Ana Ruiz\)\.$/);
  assert.ok(!sm.facts.some(f => /229|veracruz/.test(f.v)), JSON.stringify(sm.facts));
  assert.match(sm.opening, /hablé con la administradora sobre la cafetería y me pidió que volviera a llamar el próximo mes/);
  assert.ok(sm.warnings.some(w => /2 entradas de otra organización con este nombre y sin ciudad/.test(w.text)));
});
test("actividad sin hora de ayer marcada hecha hoy: va hoy (estaba para ayer) y el último contacto es el de verdad", () => {
  const touches = [{ at: "2026-11-11T15:30:00.000Z", byName: "Ana Ruiz", outcome: "gatekeeper", channel: "call", text: "que llame a las 11 para hablar con la directora" }];
  const acts = [act(40, { subject: "Llamada", add_time: "2026-11-09T15:00:00Z", due_date: "2026-11-10", marked_as_done_time: "2026-11-11T15:37:58Z", note: "hacerle seguimiento" })];
  const it = buildTimeline({ acts, touches, users, tz: TZ });
  const a = it.find(x => x.id === "a:40");
  assert.deepEqual([a.at, a.day, a.late], ["2026-11-11T15:37:58.000Z", "", { day: "2026-11-10", time: "" }]);
  assert.equal(T.dayOf(a, TZ), "2026-11-11", "la fecha que se ve es la que ordena");
  const sm = callSummary(it, ctx({ pending: [] }));
  assert.equal(sm.headline, "2 llamadas. Último contacto: hoy (Ana Ruiz).");
  assert.match(sm.opening, /Hoy llamé y en recepción me pidieron que llame a las 11/);
});
test("contacto o mail desde la agenda que cerró la pendiente: una sola entrada (con el id guardado o, si falta, por la hora)", () => {
  const at = "2026-11-11T15:00:30.000Z";
  const pendiente = act(50, { subject: "Llamada · Colegio X", add_time: "2026-11-09T15:00:00Z", due_date: "2026-11-10", due_time: "20:15", marked_as_done_time: "2026-11-11T15:00:40Z", note: null });
  const propia = act(51, { subject: "Llamada: Atendió recepción · Colegio X", add_time: "2026-11-11T15:00:20Z", due_date: "2026-11-11", marked_as_done_time: "2026-11-11T15:00:20Z", note: "que llame después de las 11" });
  const t = { at, byName: "Ana Ruiz", outcome: "gatekeeper", channel: "call", text: "que llame después de las 11" };
  for (const touch of [{ ...t, doneActId: 50 }, t]) {
    const it = buildTimeline({ acts: [pendiente, propia], touches: [touch], users, tz: TZ });
    assert.equal(it.length, 1, JSON.stringify(it.map(x => x.id)));
    assert.deepEqual(it[0].closed, { label: "Llamada", subject: "Colegio X", day: "2026-11-10", time: "14:15" });
    assert.equal(callSummary(it, ctx({ pending: [] })).count, 1);
  }
  // otra llamada sin nota marcada hecha una hora después no es la misma
  const otra = { ...pendiente, marked_as_done_time: "2026-11-11T16:30:00Z" };
  assert.equal(buildTimeline({ acts: [otra, propia], touches: [t], users, tz: TZ }).length, 2);
  // mail enviado desde la agenda (mailNext guarda doneActId en el mail)
  const mails = [{ id: "m9", at, byName: "Ana Ruiz", to: "x@y.mx", subject: "Hola", body: "b", doneActId: 50 }];
  const im = buildTimeline({ acts: [pendiente], mails, users, tz: TZ });
  assert.deepEqual(im.map(x => x.id), ["m:m9"]); assert.equal(im[0].closed.time, "14:15");
  // un comentario que cerró la pendiente (no guarda nada en la app): va en el comentario
  const notes = [{ id: 71, add_time: "2026-11-11 15:00:35", lead_id: L, user: { name: "Ana Ruiz" }, content: "<b>Comentario</b><br>Revisé la web: tienen comedor propio<br><br><i>Cargado por Ana Ruiz desde OrderBrain SDR</i>" }];
  const ic = buildTimeline({ acts: [pendiente], notes, users, tz: TZ });
  assert.deepEqual(ic.map(x => x.id), ["n:71"]); assert.equal(ic[0].closed.label, "Llamada");
});
test("comentario o nota sola: la apertura no dice «llamé» (va la de primer contacto) y el dato va aparte; sin la firma de la app", () => {
  const notes = [{ id: 72, add_time: "2026-11-11 15:00:00", lead_id: L, user: { name: "Ana Ruiz" }, content: "<b>Comentario</b><br>Revisé la web: tienen comedor propio y 450 alumnos. Parece buen candidato.<br><br><i>Cargado por Ana Ruiz desde OrderBrain SDR</i>" }];
  const it = buildTimeline({ notes, users, tz: TZ });
  assert.equal(it[0].text, "Revisé la web: tienen comedor propio y 450 alumnos. Parece buen candidato.");
  const sm = callSummary(it, ctx({ pending: [] }));
  assert.equal(sm.cold, false); assert.equal(sm.headline, "Todavía no hay contactos registrados: hay 1 nota.");
  assert.doesNotMatch(sm.opening, /llam[eé]|escrib/); assert.match(sm.opening, /^Hola, ¿qué tal\? Habla Ana de OrderEAT\. Trabajamos con colegios de Puebla/);
  assert.match(sm.openingSrc, /^Plantilla de primer contacto/);
  assert.equal(sm.noted.text, "Anotaste hoy: «Revisé la web: tienen comedor propio y 450 alumnos. Parece buen candidato.»");
  assert.deepEqual(sm.facts.map(f => `${f.k}: ${f.v}`), ["Alumnos: 450"]);
  assert.ok(sm.happened.every(h => !/OrderBrain SDR/.test(h.text)));
  // un WhatsApp sin respuesta no es «llamé»
  const wa = buildTimeline({ acts: [act(60, { type: "deadline", subject: "WhatsApp", due_date: "2026-11-10", marked_as_done_time: "2026-11-10T17:00:00Z", note: "no responde" })], users, tz: TZ });
  assert.match(callSummary(wa, ctx({ pending: [] })).opening, /Ayer escribí por WhatsApp y no respondieron\./);
});
test("sin vincular y con candidatas: no dice «sin nada en Pipedrive», pide elegir la organización", () => {
  const sm = callSummary([], ctx({ pending: [], unlinked: true }));
  assert.equal(sm.cold, true); assert.equal(sm.unlinked, true); assert.match(sm.headline, /^Todavía no está vinculado a Pipedrive/);
  assert.equal(callSummary([], ctx({ pending: [] })).unlinked, undefined);
});
test("nombres y horarios recién anotados: «Rosa de recepción», «la directora Laura Gómez está los martes de 9 a 11»; de «Cuándo llamar» solo lo más nuevo", () => {
  const touches = [{ at: "2026-11-11T15:00:00.000Z", byName: "Ana Ruiz", outcome: "gatekeeper", channel: "call", text: "Atendió Rosa de recepción. La directora Laura Gómez está los martes de 9 a 11." }];
  const sm = callSummary(buildTimeline({ acts: ACTS, touches, users, mainLeadId: L, tz: TZ }), ctx({ pending: [] }));
  assert.deepEqual(sm.askFor.map(a => a.text), ["Laura Gómez (directora)"]);
  assert.deepEqual(sm.facts.filter(f => /Cuándo|recepción/.test(f.k)).map(f => `${f.k}: ${f.v}`), ["En recepción: Rosa", "Cuándo llamar: los martes de 9 a 11 (Laura Gómez)"]);
  assert.equal(sm.opening, "Hola, ¿qué tal? Te habla Ana de OrderEAT. Hoy llamé y me atendió Rosa en recepción: me dijo que la directora Laura Gómez está los martes de 9 a 11. ¿Me comunicas con Laura Gómez?");
});
test("pendientes y fechas: sin repetir el tipo ni el colegio; los próximos días con día y fecha", () => {
  const sm = callSummary(caseItems(), ctx({ school: { name: "Centro Educativo Las Bugambilias", city: "Puebla", country: "México" },
    pending: [{ label: "Llamada", subject: "Llamada · Centro Educativo Las Bugambilias", date: "2026-11-13", time: "", who: "Ana Ruiz", late: false },
      { label: "Llamada", subject: "Llamada – visita Joaco", date: "2026-11-10", time: "14:15", who: "Pedro Gil", late: true }] }));
  assert.deepEqual(sm.pending.map(p => p.text), ["Llamada el vie 13/11", "Llamada «visita Joaco» vencida ayer 14:15 de Pedro Gil"]);
  assert.equal(relDay("2026-11-12", TODAY), "mañana"); assert.equal(relDay("2026-11-16", TODAY), "el lun 16/11");
});
test("control de la IA: un nombre al principio de una oración o después de ¿ también; los compromisos tienen que estar en la entrada citada; el plan pasa", () => {
  const corpus = "me dijeron de recepción que llamara mas tarde que no se encontraba ni la directora ni la encargada de la cafetería";
  assert.equal(grounded("Roberto, el dueño, pidió la propuesta.", corpus), false);
  assert.equal(grounded("¿Me comunicas con la directora? Roberto dijo que sí.", corpus), false);
  assert.equal(grounded("«Roberto» atiende.", corpus), false);
  assert.equal(grounded("Recepción pidió llamar más tarde.", corpus), true);
  assert.equal(grounded("Pidió que llame más tarde.", corpus), true, "un verbo al principio no es un nombre");
  assert.equal(grounded("Quedamos en mandar la propuesta.", corpus), false, "compromiso que no está");
  assert.equal(grounded("Quieren la demo el viernes.", corpus + " quieren ver la demo", [], corpus), false, "la demo está en otra entrada, no en la citada");
  assert.equal(grounded("Ayer recepción pidió llamar más tarde.", "x (hoy) " + corpus, [], "(hoy) " + corpus), false, "dice «ayer» de una entrada de hoy");
  assert.equal(grounded("Ayer recepción pidió llamar más tarde.", "(ayer) " + corpus, [], "(ayer) " + corpus), true);
  const items = caseItems(), rules = callSummary(items, ctx()), entries = aiEntries(items, { tz: TZ, today: TODAY });
  const raw = { que_paso: [{ texto: "Recepción pidió llamar más tarde. Roberto, el dueño, quiere la propuesta el viernes.", fuentes: [3] }], datos: [{ k: "Alumnos", v: "287", fuentes: [2] }],
    plan: [{ texto: "Pedir quién ve la cafetería y ofrecer la visita de Joaquín.", fuentes: [2] }], apertura: "Hola, ¿qué tal? Te habla Ana de OrderEAT.", apertura_fuentes: [3] };
  const s = groundAi(raw, entries, rules, { names: ["Ana"] });
  assert.deepEqual(s.happened.map(h => h.text), ["Recepción pidió llamar más tarde."], "la oración inventada se descarta");
  assert.deepEqual(s.plan.map(p => p.text), ["Pedir quién ve la cafetería y ofrecer la visita de Joaquín."]); assert.equal(s.plan[0].src, "Llamada – visita Joaco · ayer · Ana Ruiz");
  assert.deepEqual(groundAi({ ...raw, plan: [] }, entries, rules, { names: ["Ana"] }).plan, rules.plan, "sin plan de la IA queda el de reglas");
});

// ---------- con el Pipedrive de prueba
const sales = await import("../lib/sales.js");
const { setMatch, getMatch } = await import("../lib/store.js");
const me = { email: "demo@ordereat.com", name: "Demo", pdUserId: 1 };
test("timelineFor (demo): el prospecto con varias llamadas da 7 entradas, el resumen y la apertura desde recepción", async () => {
  const r = await sales.openRecord("lead", "demo-lead-historial");
  const t = await sales.timelineFor(r.id, { user: me, tz: TZ, me: "Demo" });
  assert.equal(t.total, 7); assert.equal(t.more, false); assert.deepEqual(t.warnings, []);
  assert.deepEqual(t.items.map(x => x.kind), ["note", "act", "act", "act", "act", "act", "created"]);
  assert.equal(t.summary.count, 5);
  assert.match(t.summary.opening, /en recepción me pidieron que llame más tarde porque no estaban la directora ni la encargada de la cafetería/);
  assert.ok(t.summary.pending.some(p => p.late));
  // la ficha del prospecto ahora trae sus pendientes
  const d = await sales.schoolDetail(r.id, { user: me, tz: TZ });
  assert.equal(d.activities.length, 2);
});
test("timelineFor (demo): registrar un contacto suma UNA entrada (actividad + nota + contacto) y la paginación respeta el total", async () => {
  const r = await sales.openRecord("lead", "demo-lead-historial");
  await sales.logContact(r.id, me, { outcome: "gatekeeper", channel: "call", text: "Atendió recepción: llamar después de las 11", contact: { name: "Marta", role: "Directora" } }, TZ);
  sales.dropTimeline(r.id);
  const t = await sales.timelineFor(r.id, { user: me, tz: TZ, me: "Demo", limit: 3 });
  assert.equal(t.total, 8); assert.equal(t.items.length, 3); assert.equal(t.more, true);
  const c = t.items[0];
  assert.equal(c.kind, "contact"); assert.equal(c.src, "both"); assert.equal(c.title, "Atendió recepción"); assert.equal(c.text, "Atendió recepción: llamar después de las 11");
  assert.ok(c.rows.some(([k, v]) => k === "Preguntar por" && v === "Marta (Directora)"));
  const rest = await sales.timelineFor(r.id, { user: me, tz: TZ, offset: 3, limit: 50 });
  assert.equal(rest.items.length, 5); assert.equal(rest.more, false);
  assert.match(t.summary.opening, /^Hola, ¿qué tal\? Te habla Demo de OrderEAT\. Hoy llamé y en recepción me pidieron que llame después de las 11\. ¿Me comunicas con Marta\?$/);
});
test("timelineFor (demo): un mail enviado desde la ficha es UNA entrada (no se repite como actividad, nota ni contacto)", async () => {
  const r = await sales.openRecord("lead", "demo-lead-historial");
  sales.dropTimeline(r.id);
  const before = (await sales.timelineFor(r.id, { user: me, tz: TZ })).total;
  const send = async () => ({ id: `msg-${Date.now()}`, threadId: "t", from: me.email, bcc: false, signature: "gmail" });
  await sales.sendMail(r.id, me, { to: "dir@ejemplo.edu.mx", subject: "OrderEAT para la cafetería", text: "Hola" }, TZ, { send });
  sales.dropTimeline(r.id);
  const t = await sales.timelineFor(r.id, { user: me, tz: TZ });
  assert.equal(t.total, before + 1);
  assert.equal(t.items[0].kind, "mail"); assert.equal(t.items[0].src, "both"); assert.equal(t.items[0].mail.subject, "OrderEAT para la cafetería");
  assert.ok(!t.items.some(x => x.kind === "note" && /^Mail enviado/.test(x.title)));
});
test("timelineFor (demo): si Pipedrive falla, sale lo que se pudo leer con el aviso (y no se guarda)", async () => {
  const { addVirtual } = await import("../lib/store.js");
  addVirtual({ id: "pd-lead-demo-lead-caido", name: "Prospecto caído", city: "", country: "México", src: "pipedrive", virtual: true, leadOnly: true, leadId: "demo-lead-caido" });
  setMatch("pd-lead-demo-lead-caido", { status: "lead", detail: "Prospecto en Pipedrive", orgId: null, confirmed: true, leadId: "demo-lead-caido", candidates: [] });
  const t = await sales.timelineFor("pd-lead-demo-lead-caido", { user: me, tz: TZ });
  assert.deepEqual(t.warnings, ["las actividades del prospecto"]);
  assert.equal(t.summary.cold, true);
  assert.equal(getMatch("pd-lead-demo-lead-caido").leadId, "demo-lead-caido");
});
test("timelineFor (demo): «Colegio Americano» de Puebla no muestra lo de la de Veracruz; la sin ciudad va aparte y fuera del resumen", async () => {
  const id = "puebla-de-zaragoza-colegio-americano";
  setMatch(id, { status: "org", detail: "Existe en Pipe", orgId: 911, orgName: "Colegio Americano", confirmed: true, auto: false, candidates: [] });
  const t = await sales.timelineFor(id, { user: me, tz: TZ, me: "Demo" });
  const txt = JSON.stringify(t);
  assert.ok(!/229 555 0130|ejemplo-veracruz|que llame a las 10/.test(txt), "nada de la organización de Veracruz");
  assert.deepEqual(t.items.map(x => [x.text, !!x.aside]), [["Habló con la administradora. Pidió que volvamos a llamar el próximo mes.", false], ["No contestaron", true]]);
  assert.equal(t.summary.count, 1);
  assert.match(t.summary.opening, /hablé con la administradora/);
});
test("timelineFor (demo): la copia de 2 minutos se deja de usar cuando otra instancia escribió (versión en el store)", async () => {
  const { cacheSet } = await import("../lib/store.js"), pd = await import("../lib/pipedrive.js");
  const r = await sales.openRecord("lead", "demo-lead-historial");
  await sales.dropTimeline(r.id);
  await new Promise(ok => setTimeout(ok, 5));
  const n0 = (await sales.timelineFor(r.id, { user: me, tz: TZ })).total;
  await pd.addNote({ content: "<b>Nota</b><br>escrita por otra instancia", leadId: "demo-lead-historial" });
  assert.equal((await sales.timelineFor(r.id, { user: me, tz: TZ })).total, n0, "sin cambio de versión, la copia");
  await new Promise(ok => setTimeout(ok, 5));
  await cacheSet(`tl:ver:${r.id}`, Date.now(), 600); // lo que hace dropTimeline en la instancia que escribió
  assert.equal((await sales.timelineFor(r.id, { user: me, tz: TZ })).total, n0 + 1);
});
test("timelineFor (demo): registrar desde la llamada vencida de la agenda (la marca hecha) deja UNA entrada; el prospecto sin persona usa su teléfono", async () => {
  const pd = await import("../lib/pipedrive.js");
  const r = await sales.openRecord("lead", "demo-lead-historial");
  assert.equal(r.phone, "(222) 555 0147");
  await sales.dropTimeline(r.id);
  const before = (await sales.timelineFor(r.id, { user: me, tz: TZ })).total;
  const pend = (await pd.activities({ leadId: "demo-lead-historial", done: false })).find(a => a.due_time === "20:15");
  await sales.logContact(r.id, me, { outcome: "gatekeeper", channel: "call", text: "Atendió Rosa de recepción. La directora Laura Gómez está los martes de 9 a 11.", completeActivityId: pend.id }, TZ);
  await sales.dropTimeline(r.id);
  const t = await sales.timelineFor(r.id, { user: me, tz: TZ, me: "Demo" });
  assert.equal(t.total, before + 1);
  assert.ok(!t.items.some(x => x.id === `a:${pend.id}`)); assert.deepEqual(t.items[0].closed, { label: "Llamada", subject: "", day: pend.due_date, time: "14:15" }); // vencía ayer a las 20:15 UTC = 14:15 en México, el mismo día
  assert.match(t.summary.opening, /me atendió Rosa en recepción: me dijo que la directora Laura Gómez está los martes de 9 a 11\. ¿Me comunicas con Laura Gómez\?$/);
});
