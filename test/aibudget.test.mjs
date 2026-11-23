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

test("tope del mes", async () => {
  const { limits } = B;
  assert.equal(limits().month, 70);
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

test("tablero: hoy, semana, mes y año separados en API y suscripción", async () => {
  const m = new Date().toISOString().slice(0, 7);
  await B.setPlan({ subs: [{ name: "Max", usd: "100", since: m }, { name: "vieja", usd: "", since: m }], past: [{ month: m, usd: "10,5", note: "consola" }, { month: "mal", usd: 3 }] }, "test");
  const d = await B.dashboard(), P = d.periods, days = new Date(Date.UTC(+m.slice(0, 4), +m.slice(5), 0)).getUTCDate();
  assert.equal(d.plan.subs.length, 2); assert.equal(d.plan.subs[1].usd, 0); assert.equal(d.plan.past.length, 1); // un mes mal escrito no entra
  assert.equal(P.month.subs, 100);
  assert.equal(P.month.api, +(d.monthApp + 10.5).toFixed(2));
  assert.equal(P.day.subs, +(100 / days).toFixed(2));
  assert.ok(P.year.total >= P.month.total && P.month.total >= P.day.total);
  assert.equal(d.weeks.length, 12); assert.equal(d.months.length, 12);
});
