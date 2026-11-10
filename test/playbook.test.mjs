// Mensajes sin IA, plantillas por país y prioridad de la cola (lib/playbook.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { composeMessage, templates, playbookFor, scoreSchool, MAX_ATTEMPTS } from "../lib/playbook.js";
import { MARKETS } from "../lib/config.js";

const chile = { name: "Colegio Andino", city: "Santiago", country: "Chile" };

test("composeMessage: contexto escrito al colegio en primera persona entra tal cual", () => {
  const r = composeMessage(chile, { context: "me pasó tu contacto Juan, el administrador", me: "Ana Pérez", contact: "Luis Soto" });
  assert.equal(r.note, "");
  assert.match(r.text, /^Hola Luis, .*Soy Ana, de OrderEAT\. Me pasó tu contacto Juan, el administrador\.\n\n/);
});
test("composeMessage: contexto en primera persona también entra en el mail", () => {
  const r = composeMessage(chile, { channel: "mail", context: "te escribo porque vi la web", me: "Ana" });
  assert.equal(r.note, "");
  assert.match(r.text, /Soy Ana, de OrderEAT\. Te escribo porque vi la web\./);
});
test("composeMessage: una nota para sí mismo no entra y avisa", () => {
  const r = composeMessage(chile, { context: "llamar el martes, pidió info", me: "Ana" });
  assert.doesNotMatch(r.text, /llamar el martes/i);
  assert.match(r.note, /nota para vos/);
});
test("composeMessage: sin contexto y con un mensaje ya escrito, no lo pisa", () => assert.deepEqual(composeMessage(chile, { base: "Texto ya escrito" }), { text: "Texto ya escrito", unchanged: true }));
test("composeMessage: con contexto, aunque haya base, arma el mensaje con el contexto", () => {
  const r = composeMessage(chile, { base: "Texto ya escrito", context: "te escribo por la feria" });
  assert.notEqual(r.text, "Texto ya escrito"); assert.match(r.text, /Te escribo por la feria\./);
});
test("composeMessage: en Chile dice «el casino» y «los apoderados»", () => {
  const r = composeMessage(chile, {});
  assert.match(r.text, /digitalizando el casino/); assert.match(r.text, /sobre el casino de Colegio Andino/); assert.match(r.text, /los apoderados/);
  assert.doesNotMatch(r.text, /la casino/);
});
test("composeMessage: perdido o sin avance usa la plantilla de reactivar", () => {
  assert.match(composeMessage(chile, { status: "stalled" }).text, /Hace un tiempo conversamos sobre el casino/);
  assert.match(composeMessage(chile, { channel: "mail", status: "lost" }).subject, /¿cómo va el casino este año\?/);
});
test("composeMessage: no inventa nombres (sin me ni contacto queda [tu nombre] y «Hola»)", () => {
  const r = composeMessage(chile, {});
  assert.match(r.text, /^Hola, /); assert.match(r.text, /Soy \[tu nombre\]/);
});

test("templates: artículo correcto en todos los países (nada de «la casino» ni «la bar escolar»)", () => {
  for (const country of Object.keys(MARKETS)) {
    const s = { name: "Colegio X", city: "Y", country };
    const all = JSON.stringify([templates(s, { me: "Ana B", contact: "Luis" }), playbookFor(s, { status: "new" }), composeMessage(s, { channel: "mail" })]);
    assert.doesNotMatch(all, /\b(la|de la|a la) (casino|bar escolar)\b/i, country);
    assert.doesNotMatch(all, /\b(el|del|al) (cafetería|cantina|soda)\b/i, country);
  }
});
test("templates: Chile dice «el casino», Ecuador «el bar escolar», Argentina usa voseo", () => {
  assert.match(templates(chile)[0].text, /digitalizando el casino/);
  assert.match(templates({ name: "U", country: "Ecuador" })[0].text, /digitalizando el bar escolar/);
  assert.match(templates({ name: "C", country: "Argentina" }).find(t => t.id === "mail_info").text, /Proponeme/);
});

const DAY = 864e5, now = Date.parse("2026-11-10T15:00:00Z");
const school = { name: "Colegio X", phone: "+52 55 1234 5678", web: "https://x.mx" };
test("scoreSchool: clientes, tratos abiertos y ex clientes (churn) no van a la cola", () => {
  for (const status of ["client", "open", "churn"]) assert.equal(scoreSchool(school, { status }, [], { now }), null, status);
});
test("scoreSchool: un colegio nuevo puntúa y explica por qué", () => {
  const r = scoreSchool(school, { status: "new" }, [], { now });
  assert.ok(r.score > 0 && r.score <= 100); assert.ok(r.reasons.includes("Nunca contactado"));
});
test("scoreSchool: contactado hoy no vuelve a la cola", () => assert.equal(scoreSchool(school, { status: "new" }, [{ at: new Date(now - 3600e3).toISOString(), outcome: "no_answer" }], { now }), null));
test("scoreSchool: perdido hace menos de 4 meses no se reactiva", () => assert.equal(scoreSchool(school, { status: "lost", lostAt: new Date(now - 60 * DAY).toISOString(), lostReason: "No es prioridad ahora" }, [], { now }), null));
test("scoreSchool: perdido por un motivo no reactivable no vuelve", () => assert.equal(scoreSchool(school, { status: "stalled", lostAt: new Date(now - 300 * DAY).toISOString(), lostReason: "No tiene cafetería" }, [], { now }), null));
test("scoreSchool: perdido reactivable pasados 4 meses vuelve a la cola", () => {
  const r = scoreSchool(school, { status: "stalled", lostAt: new Date(now - 200 * DAY).toISOString(), lostReason: "No responde más" }, [], { now });
  assert.ok(r && r.score > 0); assert.match(r.reasons[0], /Contactado sin avance/);
});
test("scoreSchool: con el máximo de intentos sin respuesta sale de la cola", () => {
  const t = Array.from({ length: MAX_ATTEMPTS }, (_, i) => ({ at: new Date(now - (3 + i) * DAY).toISOString(), outcome: "no_answer" }));
  assert.equal(scoreSchool(school, { status: "new" }, t, { now }), null);
});
