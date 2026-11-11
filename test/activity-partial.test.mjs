// Actividad por persona: si una lectura pasa su tope de páginas, lo que depende de ella queda «?» (null), nunca un número.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
for (const k of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "PIPEDRIVE_API_TOKEN", "ANTHROPIC_API_KEY"]) delete process.env[k];
process.env.DEMO_MODE = "1";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ob-test-"));
const sales = await import("../lib/sales.js");

test("tope de páginas: hechas y sin hacer cortadas → «?» con aviso (partial)", async () => {
  Object.assign(sales.ACT_PAGES, { updated: 1, ahead: 0, pending: 0 });
  const r = await sales.metricsActivity("America/Montevideo", { days: 7 });
  assert.deepEqual(r.partial, { updated: true, ahead: true, pending: true });
  assert.equal(r.dated, null); assert.equal(r.late, null); assert.equal(r.overdue, null);
  assert.ok(r.rows.every(x => x.dated === null && x.late === null && x.overdue === null));
});
test("solo se cortó la de vencimiento hacia adelante: las cerradas con fecha anterior siguen siendo exactas", async () => {
  Object.assign(sales.ACT_PAGES, { updated: 240, ahead: 0, pending: 60 });
  const r = await sales.metricsActivity("America/Mexico_City", { days: 30 });
  assert.deepEqual(r.partial, { ahead: true });
  assert.equal(r.dated, null); assert.ok(r.late); assert.ok(r.overdue);
});
