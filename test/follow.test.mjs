// Seguimiento del equipo (followUp en lib/sales.js): lógica pura, sin Pipedrive.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
for (const k of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "PIPEDRIVE_API_TOKEN", "DEMO_MODE"]) delete process.env[k];
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ob-test-"));
const { followUp } = await import("../lib/sales.js");

const users = [{ id: 10, name: "zoe", email: "zoe@x.com" }, { id: 11, name: "Ana", email: "ana@x.com" }, { id: 12, name: "Beto", email: "beto@x.com" }, { id: 13493598, name: "Cuenta general", email: "ventas@x.com" }];
const profiles = { "zoe@x.com": { name: "Zoe Ruiz", role: "sdr" } };
const base = { users, profiles, today: "2026-11-10", tz: "America/Mexico_City" };
const row = (r, id) => r.people.find(p => p.id === id);

test("followUp: entra quien tiene perfil o actividades en la semana, en orden alfabético y sin cuentas generales", () => {
  const r = followUp({ ...base, acts: [{ owner_id: 11, type: "call", done: true, due_date: "2026-11-09", done_time: "2026-11-09T15:00:00Z" }, { owner_id: 13493598, type: "call", done: true, due_date: "2026-11-09", done_time: "2026-11-09T15:00:00Z" }] });
  assert.deepEqual(r.people.map(p => p.name), ["Ana", "Zoe Ruiz"]);
  assert.equal(row(r, 10).role, "SDR");
  assert.equal(r.from, "2026-11-04");
});

test("followUp: cuenta hechos por tipo, demos agendadas y hechas, ganados y vencidas dentro de la semana", () => {
  const acts = [
    { owner_id: 11, type: "call", done: true, due_date: "2026-11-09", done_time: "2026-11-09T15:00:00Z" },
    { owner_id: 11, type: "deadline", done: true, due_date: "2026-11-05", done_time: "2026-11-05T15:00:00Z" },
    { owner_id: 11, type: "task", done: true, due_date: "2026-11-01", done_time: "2026-11-02T15:00:00Z" }, // fuera de la semana
    { owner_id: 11, type: "meeting", done: false, due_date: "2026-11-20", due_time: "16:00:00", add_time: "2026-11-08T10:00:00Z" }, // agendada esta semana
    { owner_id: 11, type: "meeting", done: true, due_date: "2026-11-06", add_time: "2026-10-20T10:00:00Z", done_time: "2026-11-06T18:00:00Z" }, // hecha, agendada antes
    { owner_id: 11, type: "call", done: false, due_date: "2026-11-07" }, // vencida
    { owner_id: 11, type: "call", done: false, due_date: "2026-11-10" }, // es de hoy: no venció
    { owner_id: 11, type: "call", done: false, due_date: "2026-10-30" }, // vencida antes de la semana
  ];
  const won = [{ owner_id: 11, won_time: "2026-11-08T12:00:00Z" }, { owner_id: 11, won_time: "2026-10-01T12:00:00Z" }];
  const a = row(followUp({ ...base, acts, won }), 11);
  assert.deepEqual({ calls: a.calls, whatsapp: a.whatsapp, mails: a.mails, demosSet: a.demosSet, demosDone: a.demosDone, won: a.won, overdue: a.overdue }, { calls: 1, whatsapp: 1, mails: 0, demosSet: 1, demosDone: 1, won: 1, overdue: 1 });
});

test("followUp: la semana se mide en la zona del líder (una llamada a las 2 UTC del 4 es del 3 en México)", () => {
  const acts = [{ owner_id: 11, type: "call", done: true, due_date: "2026-11-04", done_time: "2026-11-04T02:00:00Z" }];
  assert.equal(row(followUp({ ...base, acts, profiles: { "ana@x.com": { name: "Ana", role: "sdr" } } }), 11).calls, 0);
  assert.equal(row(followUp({ ...base, acts, tz: "UTC" }), 11).calls, 1);
});

test("followUp: tratos abiertos de venta sin próxima actividad, por dueño, los más quietos primero y hasta 5", () => {
  const open = [
    { id: 1, title: "A", owner_id: 10, pipeline_id: 9, update_time: "2026-10-01T00:00:00Z" },
    { id: 2, title: "B", owner_id: 10, pipeline_id: 9, update_time: "2026-09-01T00:00:00Z" },
    { id: 3, title: "C", owner_id: 10, pipeline_id: 9, next_activity_id: 77 }, // tiene próxima actividad
    { id: 4, title: "D", owner_id: 10, pipeline_id: 16 }, // embudo de clientes: no es de venta
    ...[5, 6, 7, 8, 9].map(id => ({ id, title: "X" + id, owner_id: 10, pipeline_id: 1, update_time: "2026-11-01T00:00:00Z" })),
  ];
  const z = row(followUp({ ...base, open }), 10);
  assert.equal(z.noNext, 7);
  assert.deepEqual(z.deals.map(d => d.id), [2, 1, 5, 6, 7]);
  assert.equal(z.deals[0].since, "2026-09-01");
});
