// El cliente de Pipedrive de la búsqueda contra la API (fetch simulado, sin red): qué pide y cómo lee la respuesta.
// itemSearch con su tipo y cursor, prospectos de una persona (abiertos y archivados: dos pedidos) y todos los teléfonos
// de las personas de una organización.
import { test } from "node:test";
import assert from "node:assert/strict";
for (const k of ["DEMO_MODE", "KV_REST_API_URL", "KV_REST_API_TOKEN"]) delete process.env[k];
process.env.PIPEDRIVE_API_TOKEN = "token-de-prueba";
const calls = [];
globalThis.fetch = async url => {
  const u = new URL(url); calls.push(u.pathname + u.search);
  const json = data => ({ ok: true, status: 200, json: async () => data, headers: new Headers() });
  if (u.pathname.endsWith("/v2/itemSearch")) return json({ success: true, data: { items: [{ result_score: 1, item: { id: 1, type: u.searchParams.get("item_types") } }] }, additional_data: { next_cursor: u.searchParams.get("cursor") ? null : "eyJvIjo1MH0=" } });
  if (u.pathname.endsWith("/v1/leads/archived")) return json({ success: true, data: [{ id: "b", title: "Viejo", person_id: 7, update_time: "2025-01-01 10:00:00" }, { id: "a", title: "Repetido", person_id: 7, update_time: "2026-02-01 10:00:00" }] });
  if (u.pathname.endsWith("/v1/leads")) return json({ success: true, data: [{ id: "a", title: "Abierto", person_id: 7, update_time: "2026-02-01 10:00:00" }] });
  if (u.pathname.endsWith("/v2/persons")) return json({ success: true, data: [{ id: 3, name: "Laura", phones: [{ value: "+52 (55) 1234-5678" }, { value: " 55 8765 4321 " }, { value: "" }], emails: [{ value: "l@x.mx" }] }] });
  return json({ success: true, data: [] });
};
const pd = await import("../lib/pipedrive.js");

test("searchItems: un tipo por pedido, hasta 100, y el cursor de la página siguiente (null si no hay más)", async () => {
  const r = await pd.searchItems("Colegio Americano", { types: "organization", limit: 50 });
  assert.deepEqual(r.next, "eyJvIjo1MH0="); assert.equal(r.items[0].item.type, "organization");
  const q = new URL("http://x" + calls.at(-1)).searchParams;
  assert.equal(q.get("item_types"), "organization"); assert.equal(q.get("limit"), "50"); assert.equal(q.get("term"), "Colegio Americano"); assert.equal(q.get("cursor"), null);
  const r2 = await pd.searchItems("Colegio Americano", { types: "organization", cursor: "eyJvIjo1MH0=", limit: 500 });
  assert.equal(r2.next, null); assert.equal(new URL("http://x" + calls.at(-1)).searchParams.get("cursor"), "eyJvIjo1MH0="); assert.equal(new URL("http://x" + calls.at(-1)).searchParams.get("limit"), "100");
});
test("leadsForPerson: /v1/leads (no archivados) y /v1/leads/archived a la vez, sin repetidos, lo último primero", async () => {
  calls.length = 0;
  const l = await pd.leadsForPerson(7);
  assert.deepEqual(calls.map(c => c.split("?")[0]).sort(), ["/api/v1/leads", "/api/v1/leads/archived"]);
  assert.ok(calls.every(c => !c.includes("archived_status")), "GET /v1/leads no acepta archived_status");
  assert.deepEqual(l.map(x => [x.id, x.archived]), [["a", false], ["b", true]]);
});
test("personsForOrg: todos los teléfonos (phone, el primero)", async () => {
  const [p] = await pd.personsForOrg(9);
  assert.deepEqual(p.phones, ["+52 (55) 1234-5678", "55 8765 4321"]); assert.equal(p.phone, "+52 (55) 1234-5678"); assert.equal(p.email, "l@x.mx");
});
