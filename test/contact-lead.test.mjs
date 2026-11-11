// Un contacto en un colegio cuya organización tiene un prospecto abierto (tuyo o de la cuenta general) queda en el
// PROSPECTO (actividad, próximo paso y nota), no solo en la organización. Y el próximo paso por defecto es una llamada.
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
const { schools, getMatch } = await import("../lib/store.js");
const { suggestNext } = await import("../lib/playbook.js");
const user = { email: "demo@example.com", name: "Demo", pdUserId: 1 };

test("pickContactLead: el de la ficha si sigue abierto; si no, el único; con varios, el tuyo o el único libre", () => {
  const a = { id: "a", ownerId: 1 }, b = { id: "b", ownerId: null }, c = { id: "c", ownerId: 2 };
  assert.equal(sales.pickContactLead([a, b], "b", 1).id, "b");
  assert.equal(sales.pickContactLead([c], null, 1).id, "c"); // el único (si es de otro, después se avisa y va a la organización)
  assert.equal(sales.pickContactLead([b, c], null, 1).id, "b");
  assert.equal(sales.pickContactLead([a, c], null, 1).id, "a");
  assert.equal(sales.pickContactLead([c, { id: "d", ownerId: 3 }], null, 1), null);
  assert.equal(sales.pickContactLead([], "x", 1), null);
});

test("suggestNext: sin respuesta, siempre una llamada (el WhatsApp va como sugerencia aparte)", () => {
  for (const attempts of [0, 1, 2, 3]) {
    const r = suggestNext({ outcome: "no_answer", attempts, channel: "call", today: "2026-11-11" });
    assert.equal(r.type, "call");
    assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/);
  }
  assert.equal(suggestNext({ outcome: "bad_data", today: "2026-11-11" }).type, "call");
});

async function schoolWithOrg() {
  for (const s of schools.filter(x => x.country === "México").slice(0, 400)) {
    const r = await sales.ensureOrg(s.id, 1).catch(() => null);
    if (r?.orgId && !r.created && !r.openDealId) return { s, rec: r };
  }
  return null;
}

test("logContact con un prospecto abierto de la cuenta general: todo va al prospecto y pasa a tu nombre", async () => {
  const f = await schoolWithOrg(); assert.ok(f, "hay un colegio con organización en el demo");
  const lead = pd.DEMO ? (await import("../lib/pipedrive-demo.js")).createLead({ title: `${f.s.name} (prueba)`, ownerId: 99, orgId: f.rec.orgId }) : null;
  assert.ok(lead);
  const r = await sales.logContact(f.s.id, user, { outcome: "no_answer", channel: "call", text: "no atendió nadie", next: { type: "call", date: "2026-11-13" } }, "UTC");
  assert.ok(r.done.some(d => /Guardado en el prospecto/.test(d.label)), JSON.stringify(r.done));
  const acts = await pd.activities({ leadId: lead.id, done: true, limit: 20 });
  assert.ok(acts.some(a => /no atendió/i.test(a.subject) || a.lead_id === lead.id), "la actividad hecha quedó en el prospecto");
  const pend = await pd.activities({ leadId: lead.id, done: false, limit: 20 });
  assert.ok(pend.some(a => a.type === "call"), "el próximo paso quedó en el prospecto");
  const notes = await pd.notesForLead(lead.id, 20);
  assert.ok(notes.some(n => /OrderBrain SDR/.test(n.content)), "la nota quedó en el prospecto");
  const l2 = (await pd.leadsForOrg(f.rec.orgId)).find(x => x.id === lead.id);
  assert.equal(l2.ownerId, 1, "el prospecto pasó a tu nombre");
  assert.equal(getMatch(f.s.id)?.leadId, lead.id);
});

test("logContact con el prospecto de otra persona: queda en la organización y avisa", async () => {
  const { s, rec } = await schoolWithOrg2();
  const lead = (await import("../lib/pipedrive-demo.js")).createLead({ title: `${s.name} (de otro)`, ownerId: 2, orgId: rec.orgId });
  const r = await sales.logContact(s.id, user, { outcome: "no_answer", channel: "call", next: { type: "call", date: "2026-11-13" } }, "UTC");
  assert.ok((r.warnings || []).some(w => /es de otra persona/.test(w)) || r.done.some(d => /es de otra persona/.test(d.label)), JSON.stringify(r));
  assert.equal((await pd.activities({ leadId: lead.id, done: true, limit: 20 })).length, 0);
});
async function schoolWithOrg2() {
  let skip = true;
  for (const s of schools.filter(x => x.country === "México").slice(0, 400)) {
    const r = await sales.ensureOrg(s.id, 1).catch(() => null);
    if (r?.orgId && !r.created && !r.openDealId && !(await pd.leadsForOrg(r.orgId)).length) { if (skip) { skip = false; continue; } return { s, rec: r }; }
  }
  throw new Error("no hay otro colegio con organización");
}
