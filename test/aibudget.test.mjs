import { test } from "node:test";
import assert from "node:assert/strict";
process.env.AI_DAILY_USD = "1"; process.env.AI_PERSON_USD = "0.5";
const B = await import("../lib/aibudget.js");

test("costo por usage: tokens y búsquedas", () => {
  assert.equal(+B.costOf("claude-opus-5-5", { input_tokens: 1e6, output_tokens: 1e5 }).toFixed(4), 6);
  assert.equal(+B.costOf("claude-sonnet-5-5", { input_tokens: 1e6 }).toFixed(4), 2);
  assert.equal(+B.costOf("claude-opus-5-5", { server_tool_use: { web_search_requests: 5 } }).toFixed(4), 0.05);
  assert.equal(+B.costOf("modelo-raro", { input_tokens: 1e6 }).toFixed(4), 5); // desconocido: el más caro
});

test("tope por persona y de toda la cuenta", async () => {
  await B.guard("a@x.com");
  await B.charge("a@x.com", "estudio", "claude-opus-5-5", { input_tokens: 125000 }); // US$0,50
  await assert.rejects(B.guard("a@x.com"), e => e.code === "ai_budget" && e.status === 429);
  await B.guard("b@x.com");
  await B.charge("b@x.com", "estudio", "claude-opus-5-5", { input_tokens: 125000 }); // total US$1
  await assert.rejects(B.guard("c@x.com"), e => e.code === "ai_budget" && /todo el equipo/.test(e.message));
  let ran = false;
  await assert.rejects(B.metered("c@x.com", "chat", async () => { ran = true; }));
  assert.equal(ran, false); // no se llama a la IA si se pasó el tope
  const u = await B.usage(1);
  assert.equal(u.days[0].total, 1);
  assert.equal(u.days[0].features.estudio, 1);
});
