// Actividad por persona (Métricas): las tres lecturas de lib/sales.js (hechas cambiadas desde el comienzo del período, por
// días; hechas de fecha en el período sin cambios desde entonces; sin hacer por vencimiento hasta mañana) traen todo lo
// que hace falta: el resultado es el mismo que si se leyeran TODAS las actividades. Con el Pipedrive de prueba.
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
const MX = await import("../lib/metrics.js");
const { FREE_OWNERS } = await import("../lib/config.js");
const { todayIn } = await import("../lib/time.js");

async function everything() {
  const out = []; let cursor = null;
  for (;;) { const r = await pd.activitiesPage({ cursor }); out.push(...r.items); if (!r.next) break; cursor = r.next; }
  return out;
}
for (const tz of ["America/Montevideo", "America/Mexico_City", "Asia/Tokyo"]) for (const days of [7, 30, 90]) {
  test(`lecturas completas: ${days} días en ${tz}`, async () => {
    const all = await everything(), m = await pd.meta(), types = await pd.activityTypes(), t = todayIn(tz), period = MX.periodOf(t, days);
    const want = MX.activitySummary({ done: all.filter(a => a.done), pending: all.filter(a => !a.done), types, users: m.users, profiles: {}, free: FREE_OWNERS, period, tz, today: t });
    const got = await sales.metricsActivity(tz, { days });
    assert.deepEqual(got.partial, {});
    assert.deepEqual([got.dated, got.late, got.overdue, got.rows, got.types], [want.dated, want.late, want.overdue, want.rows, want.types]);
    assert.ok(want.dated.total > 0 && want.overdue.n > 0);
  });
}
test("los tipos llevan el nombre de la cuenta (LinkedIn es el tipo email; Aircall con su propio tipo)", async () => {
  const r = await sales.metricsActivity("America/Montevideo", { days: 7 });
  assert.equal(r.typesKnown, true);
  assert.equal(r.types.find(t => t.key === "email")?.name, "LinkedIn");
  assert.ok(r.types.some(t => t.key === "aircall_outbound_unanswere"));
  assert.ok(r.dated.autoByType.task >= 1); // las tareas automáticas de diio (creadas por la cuenta general) van aparte
  // las de Aircall las crea la cuenta general (como en la cuenta real) y van en su columna de tipo, no aparte
  assert.ok(r.dated.byType.aircall_outbound_unanswere >= 1);
  assert.equal(Object.keys(r.dated.autoByType).some(k => k.startsWith("aircall_")), false);
  // las dos cuentas generales tienen vencidas: cada una en su fila
  assert.deepEqual(r.rows.filter(x => x.free && x.overdue.n).map(x => x.id).sort(), [12660561, 13493598]);
  assert.ok(r.late.total >= 1); // vencidas viejas cerradas en el período
});
