// El asistente y la Agenda leen lo mismo: mismas actividades, misma fecha local (pedido del líder: «el asistente dice una cosa y la Agenda otra»)
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
const ai = await import("../lib/ai.js");
const { fromUtc } = await import("../lib/time.js");

test("actividades_de da el mismo total por día que la Agenda, en la zona de quien pregunta", async () => {
  const tz = "America/Montevideo";
  let me = null, ag = [];
  for (const u of (await pd.meta()).users) {
    const items = (await sales.myActivities({ pdUserId: u.id })).items;
    if (items.length > ag.length) { me = u; ag = items.map(a => ({ ...a, ...fromUtc(a.date, a.time, tz) })); }
  }
  const user = { email: me.email, pdUserId: me.id, name: me.name, leads: false };
  assert.ok(ag.length > 0, "el demo tiene actividades");
  const days = [...new Set(ag.map(a => a.date))].slice(0, 5);
  for (const d of days) {
    const r = await ai._runTool("actividades_de", { persona: "yo", desde: d, hasta: d }, { user, proposals: [], tz });
    assert.equal(r.total, ag.filter(a => a.date === d).length, d);
    assert.ok(r.actividades.every(x => x.fecha === d && !("hora_utc" in x)));
  }
  const all = await ai._runTool("actividades_de", { persona: "yo" }, { user, proposals: [], tz });
  assert.equal(all.total, ag.length);
});
