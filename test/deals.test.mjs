// Tratos desde la ficha (dealAction), «Preguntá por …» (askFor, askOf, noteRows) y horario de llamada (callWindow), con el Pipedrive de prueba.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
for (const k of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "PIPEDRIVE_API_TOKEN", "ANTHROPIC_API_KEY"]) delete process.env[k];
process.env.DEMO_MODE = "1";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ob-test-"));
const sales = await import("../lib/sales.js");
const pd = await import("../lib/pipedrive.js");
const { schools, setMatch, getMatch } = await import("../lib/store.js");
const { MARKETS } = await import("../lib/config.js");

const user = { email: "demo@example.com", name: "Demo", pdUserId: 1 };
// un colegio de México con su organización de prueba y un trato abierto en MX - SALES
const s = schools.find(x => x.country === "México");
const ORG = 999001;
setMatch(s.id, { ...(getMatch(s.id) || {}), orgId: ORG, orgName: s.name, confirmed: true, status: "open", checkedAt: Date.now() });
const deal = (o = {}) => ({ id: 1, org_id: ORG, owner_id: 1, title: "Trato", status: "open", pipeline_id: 9, stage_id: 160, ...o });
const rejects = async (o, b, status, re) => assert.rejects(sales.dealAction(s.id, deal(o), user, b), e => e.status === status && re.test(e.message));

test("dealAction: trato de otra organización, 400", () => rejects({ org_id: 123 }, { action: "won" }, 400, /no es de la organización/));
test("dealAction: trato en un embudo de clientes (ONBOARDING), 409", () => rejects({ pipeline_id: 16, stage_id: 167 }, { action: "stage", stageId: 208 }, 409, /es de clientes/));
test("dealAction: trato cerrado, 409", () => rejects({ status: "won" }, { action: "won" }, 409, /cerrado/));
test("dealAction: etapa de otro embudo, 400", () => rejects({}, { action: "stage", stageId: 111 }, 400, /no es del embudo/));
test("dealAction: propuesta enviada desde CLOSING no lo manda para atrás, 409", () => rejects({ stage_id: 124 }, { action: "proposal" }, 409, /ya está en CLOSING/));
test("dealAction: propuesta enviada en un embudo sin esa etapa (LatAm), 400", () => rejects({ pipeline_id: 12, stage_id: 198 }, { action: "proposal" }, 400, /no tiene etapa de propuesta/));
test("dealAction: perdido sin motivo, 400", () => rejects({}, { action: "lost" }, 400, /motivo/));
test("dealAction: propuesta enviada desde SELLING pasa a PROPOSAL SENT", async () => {
  const r = await sales.dealAction(s.id, deal(), user, { action: "proposal" });
  assert.equal(r.ok, true);
  assert.match(r.done[0].label, /Pasó a PROPOSAL SENT/);
});
test("proposalStage y pipeStages: etapas en orden y la de propuesta por nombre", async () => {
  const m = await pd.meta();
  assert.deepEqual(pd.pipeStages(m, 9).map(x => x.id), [160, 159, 233, 124]);
  assert.equal(pd.proposalStage(m, 9), 159);
  assert.equal(pd.proposalStage(m, 12), null);
});

const gk = sales.OUTCOMES.find(o => o.id === "gatekeeper"), other = sales.OUTCOMES.find(o => o.id !== "gatekeeper");
test("askOf: solo «Atendió recepción» con nombre", () => {
  assert.deepEqual(sales.askOf(gk, { name: " Laura  Gómez ", role: "Directora" }), { name: "Laura Gómez", role: "Directora" });
  assert.equal(sales.askOf(gk, { name: "" }), null);
  assert.equal(sales.askOf(other, { name: "Laura" }), null);
});
test("noteRows: la cafetería de la IA va en «Cafetería», no en «Preguntar por»", () => {
  const ai = { resumen: "Atendió recepción", cafeteria: "Externa" };
  const rows = Object.fromEntries(sales.noteRows({}, { name: "Laura Gómez", role: "Directora" }, { name: "Laura Gómez", role: "Directora" }, ai));
  assert.equal(rows["Preguntar por"], "Laura Gómez (Directora)");
  assert.equal(rows["Cafetería"], "Externa");
  const sinAsk = Object.fromEntries(sales.noteRows({}, {}, null, ai));
  assert.equal(sinAsk["Preguntar por"], undefined);
  assert.equal(sinAsk["Cafetería"], "Externa");
  assert.equal(Object.fromEntries(sales.noteRows({ cafeteria: "Propia" }, {}, null, ai))["Cafetería"], "Propia");
});
test("askFor: lo más nuevo entre la app y las notas; una nota sin «Preguntar por» no cuenta", () => {
  const t = [{ at: "2026-11-01T10:00:00Z", ask: { name: "Laura Gómez", role: "Directora" } }];
  assert.deepEqual(sales.askFor(t, []), { name: "Laura Gómez", role: "Directora", at: "2026-11-01T10:00:00Z" });
  const notes = [{ add_time: "2026-11-05 10:00:00", content: "<b>Llamada · Atendió recepción</b><br><b>Preguntar por:</b> Pedro Ruiz (Administrador)<br><b>Cafetería:</b> Externa" },
    { add_time: "2026-11-09 10:00:00", content: "<b>Llamada · No atendió</b><br><b>Cafetería:</b> Externa" }];
  assert.deepEqual(sales.askFor(t, notes), { name: "Pedro Ruiz", role: "Administrador", at: "2026-11-05T10:00:00Z" });
  assert.equal(sales.askFor([], [notes[1]]), null);
});

// callWindow corre en el navegador: un document mínimo para importar core.js
globalThis.document = { documentElement: { dataset: {} }, querySelectorAll: () => [] };
globalThis.matchMedia = () => ({ matches: false });
const core = await import("../public/js/core.js");
core.S.markets = MARKETS;
const at = new Date("2026-11-10T13:30:00Z"); // martes: 7:30 en CDMX, 5:30 en Tijuana
test("callWindow: el huso de la ciudad en México (Tijuana no es CDMX)", () => {
  assert.equal(core.tzOf({ country: "México", city: "Tijuana", lng: -117 }), "America/Tijuana");
  assert.equal(core.tzOf({ country: "México", city: "Culiacán", lng: -107.4 }), "America/Mazatlan");
  assert.equal(core.tzOf({ country: "México", city: "Puebla", lng: -98.2 }), "America/Mexico_City");
  assert.match(core.callWindow({ country: "México", city: "Tijuana", lng: -117 }, at).local, /5:30/);
  assert.equal(core.callWindow({ country: "México", city: "Puebla", lng: -98.2 }, at).label, "oficina abre 8:00");
});
test("callWindow: en México sin saber el huso (ciudad no listada en el noroeste o sin coordenadas) no dice nada", () => {
  assert.equal(core.callWindow({ country: "México", city: "Caborca", lng: -112.1 }, at), null);
  assert.equal(core.callWindow({ country: "México", city: "Pueblo X" }, at), null);
});
test("callWindow: en horario de oficina y fin de semana", () => {
  assert.equal(core.callWindow({ country: "Argentina", city: "Mendoza" }, new Date("2026-11-10T13:30:00Z")).label, "en horario de oficina"); // 10:30
  assert.equal(core.callWindow({ country: "Argentina", city: "Mendoza" }, new Date("2026-11-14T13:30:00Z")).label, "oficina abre el lunes 8:00"); // sábado
});
test("callQueue: en horario primero (orden estable) y los de reactivar al final", () => {
  const q = [{ id: "a", country: "México", city: "Puebla", lng: -98, status: "new" }, { id: "b", country: "Argentina", status: "lost" }, { id: "c", country: "Argentina", status: "new" }, { id: "d", country: "Argentina", status: "new" }];
  assert.deepEqual(core.callQueue(q, new Date("2026-11-10T13:30:00Z")).map(x => x.id), ["c", "d", "a", "b"]);
});
