// Archivar en la app: reglas puras (lib/archive.js) y que un archivado quede fuera de la cola y del alto potencial.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
for (const k of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "PIPEDRIVE_API_TOKEN", "DEMO_MODE"]) delete process.env[k];
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ob-test-"));
const { archiveError, archivePlan, canUnarchive, ARCHIVE_REASONS } = await import("../lib/archive.js");
const { schools, setArchived, getArchived } = await import("../lib/store.js");
const sales = await import("../lib/sales.js");
const { scoreSchool, playbookFor } = await import("../lib/playbook.js");

test("archiveError: motivo de la lista; «Otro» pide el caso", () => {
  assert.equal(archiveError({ status: "new", reason: "Cualquiera" }).msg, "Elegí el motivo.");
  assert.equal(archiveError({ status: "new", reason: "Otro", text: "  " }).status, 400);
  assert.equal(archiveError({ status: "new", reason: "Otro", text: "es una academia" }), null);
  assert.equal(archiveError({ status: "unk", reason: "Cerró" }), null);
  assert.deepEqual(ARCHIVE_REASONS, ["No es un colegio", "Cerró", "No tiene cafetería", "Duplicado", "No le interesa", "Otro"]);
});
test("archiveError: clientes no; ya archivado no", () => {
  assert.equal(archiveError({ status: "client", reason: "Cerró" }).status, 409);
  assert.equal(archiveError({ status: "client", reason: "Cerró", leader: true }).status, 409);
  assert.equal(archiveError({ status: "new", reason: "Cerró", archived: true }).status, 409);
});
test("archiveError: trato abierto solo si es tuyo o sos líder (dueño desconocido: solo líder)", () => {
  assert.equal(archiveError({ status: "open", dealOwner: 8, me: 7, reason: "Cerró" }).status, 403);
  assert.equal(archiveError({ status: "open", dealOwner: null, me: 7, reason: "Cerró" }).status, 403);
  assert.equal(archiveError({ status: "open", dealOwner: 7, me: 7, reason: "Cerró" }), null);
  assert.equal(archiveError({ status: "open", dealOwner: 8, me: 7, reason: "Cerró", leader: true }), null);
});
test("archivePlan: en Pipedrive solo lo tuyo o lo libre", () => {
  const p = archivePlan({ me: 7, leads: [{ id: "a", ownerId: 7 }, { id: "b", ownerId: null }, { id: "c", ownerId: 8 }, { id: "d", ownerId: 7, archived: true }], org: { id: 1, ownerId: 8 } });
  assert.deepEqual(p.archive.map(l => l.id), ["a", "b"]);
  assert.deepEqual(p.others.map(l => l.id), ["c"]);
  assert.equal(p.orgNote, false); assert.equal(p.orgOthers, true);
  assert.equal(archivePlan({ me: 7, org: { id: 1, ownerId: null } }).orgNote, true);
  assert.equal(archivePlan({ me: 7, org: { id: 1, ownerId: 7 } }).orgNote, true);
  assert.deepEqual(archivePlan({ me: 7 }), { archive: [], others: [], orgNote: false, orgOthers: false, otherOwner: null });
});
test("archivePlan.otherOwner y archiveError: lo de otra persona (organización, prospecto o cruce) solo lo archiva un líder", () => {
  assert.equal(archivePlan({ me: 7, leads: [{ id: "a", ownerId: 8 }], org: { id: 1, ownerId: 7 } }).otherOwner, 8);
  assert.equal(archivePlan({ me: 7, org: { id: 1, ownerId: 9 } }).otherOwner, 9);
  assert.equal(archivePlan({ me: 7, ownerId: 5 }).otherOwner, 5);
  assert.equal(archivePlan({ me: 7, leads: [{ id: "a", ownerId: 8, archived: true }] }).otherOwner, 8); // un prospecto sin organización ya archivado en Pipedrive sigue siendo suyo
  assert.equal(archivePlan({ me: 7, leads: [{ id: "a", ownerId: null }], org: { id: 1, ownerId: 7 } }).otherOwner, null);
  assert.equal(archivePlan({ me: null, org: { id: 1, ownerId: 7 } }).otherOwner, 7); // sin usuario de Pipedrive: todo lo que tiene dueño es ajeno
  const e = archiveError({ status: "org", reason: "Cerró", me: 7, othersOwner: "Juan Diego" });
  assert.equal(e.status, 403); assert.equal(e.msg, "Es de Juan Diego: hablalo con esa persona o con un líder.");
  assert.equal(archiveError({ status: "new", reason: "Cerró", othersOwner: true }).msg, "Es de otra persona: hablalo con esa persona o con un líder.");
  assert.equal(archiveError({ status: "org", reason: "Cerró", me: 7, othersOwner: "Juan Diego", leader: true }), null);
  assert.equal(archiveError({ status: "org", reason: "Cerró", me: 7, othersOwner: null }), null);
});
test("canUnarchive: quien archivó (sin importar mayúsculas) o un líder", () => {
  const rec = { by: "ana@ordereat.com" };
  assert.equal(canUnarchive(rec, "Ana@OrderEAT.com"), true);
  assert.equal(canUnarchive(rec, "juan@ordereat.com"), false);
  assert.equal(canUnarchive(rec, "juan@ordereat.com", true), true);
  assert.equal(canUnarchive(null, "ana@ordereat.com", true), false);
  assert.equal(canUnarchive(rec, "juan@ordereat.com", false, true), true); // lo tiene en Pipedrive
});
test("scoreSchool y playbook: un archivado no se puntúa y lo dice", () => {
  assert.equal(scoreSchool({ name: "X", phone: "1" }, { status: "archived" }, []), null);
  assert.match(playbookFor({ country: "México" }, { status: "archived" }).situacion, /archivado/);
});
test("un archivado no entra en la cola ni en el alto potencial, y la lista lo muestra «archived»", async () => {
  const q = sales.prospectQueue({ limit: 1e6 });
  assert.ok(q.length > 0, "la base de prueba tiene colegios para la cola");
  const s = schools.find(x => x.id === (q.find(y => y.pot) || q[0]).id);
  await setArchived(s.id, { by: "ana@ordereat.com", byName: "Ana Pérez", at: new Date().toISOString(), reason: "Cerró", text: "", leadIds: [] });
  assert.equal(getArchived(s.id).reason, "Cerró");
  assert.ok(!sales.prospectQueue({ limit: 1e6 }).some(x => x.id === s.id));
  assert.equal(sales.scoreFor(s), null);
  assert.equal(sales.potentialFor(s, "archived"), null);
  const li = sales.schoolListItem(s);
  assert.equal(li.status, "archived"); assert.equal(li.pot, undefined); assert.equal(li.phase, undefined);
  assert.equal(li.detail, "Archivado: Cerró");
  assert.equal(sales.stateOf(s.id).status, "archived");
  await setArchived(s.id, null);
  assert.equal(getArchived(s.id), null);
  assert.ok(sales.prospectQueue({ limit: 1e6 }).some(x => x.id === s.id));
});
test("logContact: un archivado no registra contactos (primero se desarchiva), como al crear el prospecto", async () => {
  const s = schools.find(x => !x.virtual);
  await setArchived(s.id, { by: "ana@ordereat.com", byName: "Ana Pérez", at: new Date().toISOString(), reason: "Cerró", text: "", leadIds: [] });
  await assert.rejects(sales.logContact(s.id, { email: "ana@ordereat.com", pdUserId: 7 }, { outcome: "no_answer", channel: "call" }, "UTC"),
    e => e.status === 409 && /desarchivalo para registrar/.test(e.message));
  await setArchived(s.id, null);
});
test("archivedRef: el colegio, el prospecto o la organización de Pipedrive (las actividades lo traen como archived)", async () => {
  await setArchived("pd-org-555", { by: "ana@ordereat.com", reason: "Duplicado", leadIds: [] });
  await setArchived("pd-lead-abc", { by: "ana@ordereat.com", reason: "Cerró", leadIds: [] });
  assert.equal(sales.archivedRef({ leadId: "zzz", orgId: 555 }), true); // prospecto con organización: se archiva como su organización
  assert.equal(sales.archivedRef({ leadId: "abc" }), true);
  assert.equal(sales.archivedRef({ leadId: "zzz", orgId: 556 }), false);
  assert.equal(sales.archivedRef({}), false);
  await setArchived("pd-org-555", null); await setArchived("pd-lead-abc", null);
});
test("freshLeads: los archivados en la app quedan fuera de la bandeja caliente", () => {
  const now = Date.now(), L = id => ({ id, ownerId: 7, archived: false, addTime: new Date(now - 3600e3).toISOString() });
  assert.deepEqual(sales.freshLeads([L("a"), L("b")], { me: 7, now, archived: l => l.id === "b" }).map(l => l.id), ["a"]);
});
