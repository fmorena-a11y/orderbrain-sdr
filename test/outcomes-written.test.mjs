// Resultados de Registrar por escrito (WhatsApp o mail) y trato abierto propio: solo cambia el texto que se muestra.
// Los ids y los `label` no se tocan: la cadencia, las métricas (`contactResult`) y el Historial (`replyOf`) leen esos.
import test from "node:test";
import assert from "node:assert/strict";
import { OUTCOMES, outcomeById, suggestNext, playbookFor } from "../lib/playbook.js";

test("los resultados conservan ids y etiquetas; por escrito se leen con otro texto", () => {
  assert.deepEqual(OUTCOMES.map(o => o.id), ["no_answer", "gatekeeper", "callback", "info", "demo", "not_now", "not_interested", "bad_data"]);
  assert.deepEqual(OUTCOMES.map(o => o.label), ["No atendió", "Atendió recepción", "Decisor: volver a llamar", "Pidió información", "Demo agendada", "No es el momento", "No le interesa", "Dato erróneo"]);
  assert.deepEqual(outcomeById("no_answer").written, { label: "Sin respuesta todavía", hint: "Mandé y no contestó" });
  assert.equal(outcomeById("gatekeeper").written.label, "Respondió alguien que no decide");
  // ningún texto por escrito habla de atender o de llamar
  for (const o of OUTCOMES) if (o.written) assert.doesNotMatch(`${o.written.label} ${o.written.hint}`, /atendi|llamar|buzón/i, o.id);
});

test("la cadencia no cambia por el canal: sin respuesta por WhatsApp sigue con una llamada", () => {
  const call = suggestNext({ outcome: "no_answer", attempts: 0, channel: "call", today: "2026-11-19" });
  const wa = suggestNext({ outcome: "no_answer", attempts: 0, channel: "whatsapp", today: "2026-11-19" });
  assert.equal(wa.type, "call");
  assert.equal(wa.date, call.date);
});

test("trato abierto: de otra persona manda a coordinar; si es tuyo, no", () => {
  const s = { country: "México", city: "Puebla" };
  const other = playbookFor(s, { status: "open", openDealOwner: "Joaquín Márquez" });
  assert.match(other.situacion, /de Joaquín Márquez\. Coordiná con esa persona/);
  assert.ok(other.propio, "trae la versión para el dueño del trato");
  assert.doesNotMatch(other.propio.situacion, /Coordin/);
  const mine = playbookFor(s, { status: "open", mine: true });
  assert.equal(mine.situacion, other.propio.situacion);
  assert.equal(mine.objetivo, other.propio.objetivo);
  assert.equal(playbookFor(s, { status: "new" }).propio, undefined);
});
