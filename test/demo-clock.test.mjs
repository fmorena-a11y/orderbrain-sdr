// El Pipedrive de prueba a cualquier hora. Sus datos son relativos a «ahora» y sus fechas van en UTC (day() de
// lib/pipedrive-demo.js); quien mira está en su zona. Dos pruebas pasaban de día y fallaban de 0 a 10 UTC (la tarde y la noche
// en América) sin que cambiara el código:
// - test/sync.test.mjs: los tratos de las demos de hoy en adelante tenían el último cambio «hoy a las 10:00 UTC»; antes de esa
//   hora era un cambio en el futuro y cada sincronización incremental los traía como recién cambiados (5 tratos en vez de 1);
// - test/inbound.test.mjs: la pendiente «vencida» de Olivos era de «ayer en UTC», que de 18 a 24 en México todavía es hoy.
// Acá el demo se arma con el reloj fijo en varias horas (también las que fallaban), sin depender de cuándo corre la prueba.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
for (const k of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "PIPEDRIVE_API_TOKEN"]) delete process.env[k];
process.env.DEMO_MODE = "1";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ob-demo-clock-"));
const { todayIn } = await import("../lib/time.js");
const I = await import("../lib/inbound.js");

// el demo como si se hubiera levantado en ese instante: el módulo se evalúa de nuevo (otra URL) con el reloj fijo
const RealDate = Date, loaded = new Map();
function demoAt(at) {
  if (!loaded.has(at)) loaded.set(at, (async () => {
    const t0 = RealDate.parse(at);
    globalThis.Date = class extends RealDate { constructor(...a) { if (a.length) super(...a); else super(t0); } static now() { return t0; } };
    try { return await import(`../lib/pipedrive-demo.js?reloj=${encodeURIComponent(at)}`); } finally { globalThis.Date = RealDate; }
  })());
  return loaded.get(at);
}
const allPages = async (fn, since) => { const out = []; let cursor = null; do { const r = await fn({ cursor, since, limit: 500 }); out.push(...r.items); cursor = r.next; } while (cursor); return out; };
// jueves 19/11 a las 0:10 UTC (cuando fallaban: 18:10 del miércoles en México), justo antes y después de las 10 UTC, de tarde,
// casi a medianoche, y un domingo que además es 1.º de mes
const CLOCKS = ["2026-11-19T00:10:00Z", "2026-11-19T09:59:00Z", "2026-11-19T10:02:00Z", "2026-11-19T15:00:00Z", "2026-11-19T23:50:00Z", "2026-11-01T03:00:00Z"];
const OLIVOS = "7a1c0000-0000-4000-8000-00000000d002";

for (const at of CLOCKS) {
  const t0 = Date.parse(at);
  test(`demo levantado a las ${at}: nada cambiado en el futuro (una incremental sin cambios no trae tratos ni organizaciones)`, async () => {
    const D = await demoAt(at);
    // lo que pide una sincronización incremental que empezó ahora: lo cambiado desde hace 5 minutos. En el demo, nada.
    const since = new Date(t0 - 5 * 60e3).toISOString();
    const deals = await allPages(D.dealsPage, since), orgs = await allPages(D.orgsPage, since);
    assert.deepEqual(deals.map(d => `${d.id} ${d.update_time}`), [], "tratos «cambiados» en los últimos 5 minutos o en el futuro");
    assert.deepEqual(orgs.map(o => o.id), []);
    // los tratos del demo siguen estando, todos con su último cambio en el pasado
    const all = await allPages(D.dealsPage, null);
    assert.ok(all.length > 100 && all.every(d => !d.update_time || String(d.update_time).replace(" ", "T").slice(0, 19) < since.slice(0, 19)));
  });
  test(`demo levantado a las ${at}: la pendiente vencida de Olivos está vencida en la zona de quien mira`, async () => {
    const D = await demoAt(at);
    const pending = D.activities({ leadId: OLIVOS, done: false });
    assert.equal(pending.length, 1); assert.equal(pending[0].due_time, "");
    // desde México (donde fallaba), Hawái, Buenos Aires o Tokio
    for (const tz of ["America/Mexico_City", "Pacific/Honolulu", "America/Argentina/Buenos_Aires", "Asia/Tokyo"]) {
      const st = I.inboundStage({ state: { status: "done", ref: { kind: "lead", id: OLIVOS } } }, { items: [], pending, lead: { archived: false }, deals: [], ownerId: 1, today: todayIn(tz, t0), users: {}, stages: {} });
      assert.equal(st.mine?.late, true, `${tz}: vence ${pending[0].due_date}, hoy es ${todayIn(tz, t0)}`); assert.equal(st.rank, 0);
    }
  });
}
