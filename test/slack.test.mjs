import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOrderito, mentions } from "../lib/slack.js";
import { keyTokens, norm } from "../lib/scan.js";

const churn = ":red_circle: *CHURN (Onboarding)* :skull: :sob:\n\n*CLIENTE*\n*Sitio:* Colegio América Latina\n*Cliente:* Paola\n*Ubicación:* Ciudad Nezahualcóyotl, Mexico\n\n*RESPONSABLES*\n*Account:* Feryenn Berriel\n*Onboarder:* Belen Forneiro\n\n*CAMBIO*\n*Autor:* Belen Forneiro\n*Motivo:* Contesta cuando quiere y es imposible lanzarlo sin comunicación fluida.";
const viejo = ":small_red_triangle_down: *CHURN* :disappointed:\n\n*Estado Previo:* ChurnOnClosed\n*Colegio:* Instituto David Livingstone\n*Ubicación:* Piedras Negras, Mexico\n*Cliente:* Instituto David Livingstone\n\n*Autor:* Belen Forneiro\n*Motivo:* Se habia caido, volvio a aparecer, dejó de contestar";
const msg = (text, o = parseOrderito(text)) => ({ text, o, n: ` ${norm(text)} `, site: o?.fields.site ? keyTokens(o.fields.site) : null });

test("lee el formato nuevo de Orderito: tipo, motivo y responsables", () => {
  const o = parseOrderito(churn);
  assert.equal(o.kind, "Churn (Onboarding)");
  assert.equal(o.fields.site, "Colegio América Latina");
  assert.equal(o.fields.account, "Feryenn Berriel");
  assert.equal(o.fields.onboarder, "Belen Forneiro");
  assert.match(o.fields.reason, /comunicación fluida/);
});
test("lee el formato viejo («Colegio», «Estado Previo»)", () => {
  const o = parseOrderito(viejo);
  assert.equal(o.kind, "Churn"); assert.equal(o.fields.site, "Instituto David Livingstone"); assert.equal(o.fields.before, "ChurnOnClosed");
});
test("un lanzamiento se reconoce", () => assert.equal(parseOrderito(":large_green_circle: *LANZAMIENTO FAAAAAAA*\n*Colegio:* Liceo Excellens").kind, "Lanzamiento"));
test("un mensaje de una persona no es de Orderito", () => assert.equal(parseOrderito("Genia Mika, vamos!"), null));
test("el sitio tiene que ser el mismo colegio, no uno que comparte palabras", () => {
  const m = msg(churn);
  assert.equal(mentions(m, ["Colegio América Latina"], "Nezahualcóyotl"), true);
  assert.equal(mentions(m, ["Colegio América"], "Ciudad de México"), false);
  assert.equal(mentions(m, ["Colegio América Latina de Puebla"], "Puebla"), true);
});
test("en un mensaje de una persona hacen falta todas las palabras propias (y al menos dos)", () => {
  const m = msg("Lancé uno y no llegó! Colegio Bilingue Miguel de Cervantes Saavedra");
  assert.equal(mentions(m, ["Colegio Miguel de Cervantes Saavedra"]), true);
  assert.equal(mentions(m, ["Colegio Cervantes"]), false);
});
