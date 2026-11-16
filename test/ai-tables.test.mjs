// Tablas del asistente para exportar (pedido del líder de SDR: «exportar, tipo una base de datos… armar un Google Sheet»):
// salen SOLO de lo que devolvieron las herramientas (nunca del texto del modelo) y van TODAS las filas.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
for (const k of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "PIPEDRIVE_API_TOKEN", "ANTHROPIC_API_KEY", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]) delete process.env[k];
process.env.DEMO_MODE = "1";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ob-test-"));
const sales = await import("../lib/sales.js");
const pd = await import("../lib/pipedrive.js");
const ai = await import("../lib/ai.js");
const { tablesFromTools, rangeLabel } = await import("../lib/aitables.js");
const { todayIn } = await import("../lib/time.js");
const SX = await import("../lib/sheets-export.js");

const TZ = "America/Argentina/Buenos_Aires";
async function demoUser() {
  let me = null, n = -1;
  for (const u of (await pd.meta()).users) { const k = (await sales.myActivities({ pdUserId: u.id })).items.length; if (k > n) { me = u; n = k; } }
  return { email: me.email, pdUserId: me.id, name: me.name, leads: false };
}

test("tablesFromTools: todas las filas (aunque al modelo le lleguen 60), título con el rango y sin tabla de 1 fila", () => {
  const today = "2026-11-16";
  const items = Array.from({ length: 150 }, (_, k) => ({ date: today, time: `${String(8 + (k % 10)).padStart(2, "0")}:00`, typeLabel: "Llamada", subject: `Llamar ${k}`, who: `Colegio ${k}`, event: k % 2 ? "EduExperience Mendoza 2026" : "", city: "Mendoza", url: `https://x.pipedrive.com/deal/${k}` }));
  const [t] = tablesFromTools([{ tool: "actividades_de", input: { persona: "yo", desde: today, hasta: today }, data: { persona: "Demo", mine: true, desde: today, hasta: today, items } }], { today });
  assert.equal(t.title, "Tus actividades de hoy · 16/11");
  assert.equal(t.rows.length, 150);
  assert.deepEqual(t.columns.map(c => c.label), ["Fecha", "Hora", "Tipo", "Asunto", "Colegio o prospecto", "Evento", "Ciudad", "Pipedrive"]);
  assert.deepEqual(t.rows[1], [today, "09:00", "Llamada", "Llamar 1", "Colegio 1", "EduExperience Mendoza 2026", "Mendoza", "https://x.pipedrive.com/deal/1"]);
  assert.equal(rangeLabel("2026-11-17", "2026-11-17", today), "de mañana · 17/11");
  assert.equal(rangeLabel("2026-11-16", "2026-11-20", today), "del 16/11 al 20/11");
  assert.equal(rangeLabel("", "", today), "pendientes");
  const one = tablesFromTools([{ tool: "actividades_de", input: {}, data: { persona: "Juan Diego", mine: false, items: items.slice(0, 1) } }], { today });
  assert.equal(one.length, 0);
  const q = tablesFromTools([{ tool: "a_quien_llamar", input: { pais: "México" }, data: { pais: "México", ciudad: "", items: [
    { colegio: "A", ciudad: "Puebla", pais: "México", prioridad: 80, telefono: "+52 222", motivos: ["Nunca contactado", "Alto potencial"] },
    { colegio: "B", ciudad: "Puebla", pais: "México", prioridad: 60, telefono: null, motivos: [] }] } }], { today });
  assert.equal(q[0].title, "A quién llamar · México · 16/11");
  assert.deepEqual(q[0].rows[0], ["A", "Puebla", "México", 80, "+52 222", "Nunca contactado · Alto potencial"]);
  // herramientas que escriben (propuestas) o desconocidas no arman tablas; la misma búsqueda dos veces, una sola tabla
  assert.equal(tablesFromTools([{ tool: "proponer_nota", input: {}, data: { x: 1 } }, { tool: "otra", input: {}, data: {} }]).length, 0);
  const b = { tool: "buscar_colegio", input: { nombre: "andino" }, data: { q: "andino", base: [{ colegio: "Andino", ciudad: "Mendoza", url: "" }], pipedrive: [{ nombre: "COLEGIO ANDINO", url: "u" }] } };
  assert.equal(tablesFromTools([b, b]).length, 1);
});

test("runTool guarda la lista COMPLETA para la tabla y al modelo le devuelve la misma cantidad que dice total", async () => {
  const user = await demoUser(), ctx = { user, proposals: [], tz: TZ, lists: [] };
  const r = await ai._runTool("actividades_de", { persona: "yo" }, ctx);
  assert.equal(ctx.lists.length, 1);
  assert.equal(ctx.lists[0].data.items.length, r.total);
  assert.equal(r.actividades.length, Math.min(60, r.total));
  assert.ok(ctx.lists[0].data.items.every(x => x.url && x.url.startsWith(pd.PD_WEB)));
  // sin ctx.lists (como lo llama otra prueba) no se rompe
  await ai._runTool("equipo", {}, { user, proposals: [], tz: TZ });
});

test("chat con un modelo falso: Markdown y SUGERENCIAS como antes, y la tabla sale de la herramienta, no del texto", async () => {
  const user = await demoUser(), today = todayIn(TZ), calls = [];
  const replies = [
    { stop_reason: "tool_use", content: [{ type: "text", text: "Busco tu agenda." }, { type: "tool_use", id: "t1", name: "actividades_de", input: { persona: "yo" } }] },
    { stop_reason: "end_turn", content: [{ type: "text", text: "### Tu agenda\nTenés **varias** actividades.\n\n| Fecha | Asunto |\n|---|---|\n| 01/01 | INVENTADO POR EL MODELO |\n\nSUGERENCIAS: [\"¿Cuáles son de hoy?\", \"Exportá\"]" }] },
  ];
  ai._setClient({ messages: { create: async req => { calls.push(req); return replies[calls.length - 1]; } } });
  try {
    const r = await ai.chat({ user, messages: [{ role: "user", content: "exportame todo lo que tengo pendiente" }], focus: null, tz: TZ });
    assert.equal(calls.length, 2);
    assert.match(calls[0].system, /Markdown simple/);
    assert.match(calls[0].system, /SUGERENCIAS:/);
    assert.match(calls[0].system, /Nada de tablas Markdown/);
    assert.match(r.reply, /^### Tu agenda/);
    assert.deepEqual(r.suggestions, ["¿Cuáles son de hoy?", "Exportá"]);
    assert.equal(r.tables.length, 1);
    const t = r.tables[0], all = (await sales.myActivities({ pdUserId: user.pdUserId })).items;
    assert.equal(t.source, "actividades_de");
    assert.equal(t.title, "Tus actividades pendientes");
    assert.equal(t.rows.length, all.length);
    assert.ok(!JSON.stringify(r.tables).includes("INVENTADO"), "nada del texto del modelo");
    assert.ok(t.rows.every(row => /^\d{4}-\d{2}-\d{2}$/.test(row[0])));
    assert.ok(today);
    // sin herramientas, sin tablas
    replies.push({ stop_reason: "end_turn", content: [{ type: "text", text: "Hola.\n\n- uno\n- dos" }] });
    const r2 = await ai.chat({ user, messages: [{ role: "user", content: "hola" }], focus: null, tz: TZ });
    assert.deepEqual(r2.tables, []);
  } finally { ai._setClient(null); }
});

test("Google Sheets directo: apagado sin Google conectado; la tabla se revisa y nada se toma como fórmula", async () => {
  assert.equal(await SX.sheetsDirect("demo@ordereat.com"), false);
  await assert.rejects(SX.createSheet("demo@ordereat.com", { title: "x", columns: [{ label: "A" }], rows: [["1"]] }), e => e.status === 409 && e.code === "sheets_off");
  assert.throws(() => SX.cleanTable({ columns: [], rows: [] }), /columnas/);
  assert.throws(() => SX.cleanTable({ columns: [{ label: "A" }], rows: Array(6000).fill(["x"]) }), e => e.status === 413);
  const t = SX.cleanTable({ title: "Tus actividades de hoy · 16/11", columns: [{ label: "Fecha", type: "date" }, { label: "Asunto", type: "<script>" }, { label: "N", type: "number" }], rows: [["2026-11-16", "=IMPORTXML(\"x\")", 3], ["", { a: 1 }, "4"]] });
  assert.equal(t.columns[1].type, "text");
  const body = SX.sheetBody(t), rows = body.sheets[0].data[0].rowData;
  assert.equal(body.sheets[0].properties.gridProperties.frozenRowCount, 1);
  assert.deepEqual(rows[0].values[0], { userEnteredValue: { stringValue: "Fecha" }, userEnteredFormat: { textFormat: { bold: true } } });
  assert.equal(rows[1].values[0].userEnteredValue.numberValue, 46342);
  assert.deepEqual(rows[1].values[1].userEnteredValue, { stringValue: "=IMPORTXML(\"x\")" });
  assert.deepEqual(rows[1].values[2].userEnteredValue, { numberValue: 3 });
  assert.ok(!JSON.stringify(body).includes("formulaValue"));
});
