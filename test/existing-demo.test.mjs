// Investigación antes de crear, de punta a punta con el Pipedrive de prueba (lib/pipedrive-demo.js tiene prospectos SIN
// organización calcados de la cuenta real): un colegio cuyo prospecto no tiene organización queda «Prospecto en Pipe» y todo
// va a ese prospecto (sin crear organización); el de otra persona no se toca; lo dudoso se pregunta (409 con las candidatas)
// y no se crea nada hasta que alguien elige; lo archivado es un dato; si Pipedrive falla, no se crea nada.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
for (const k of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "PIPEDRIVE_API_TOKEN", "ANTHROPIC_API_KEY", "GOOGLE_MAPS_API_KEY", "PIPEDRIVE_SMART_BCC"]) delete process.env[k];
process.env.DEMO_MODE = "1";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ob-test-"));
globalThis.fetch = async () => { throw new Error("sin red en la prueba"); };
const sales = await import("../lib/sales.js");
const pd = await import("../lib/pipedrive.js");
const demo = await import("../lib/pipedrive-demo.js");
const psync = await import("../lib/sync.js");
const { byId, getMatch, setMatch } = await import("../lib/store.js");
const G = await import("../lib/gmail.js");
const me = { email: "demo@example.com", name: "Demo", pdUserId: 1 };
const ID = { pestalozzi: "puebla-de-zaragoza-colegio-enrique-pestalozzi", margarita: "puebla-de-zaragoza-colegio-margarita-maza", prometeo: "puebla-de-zaragoza-colegio-prometeo",
  angeles: "puebla-de-zaragoza-colegio-angeles-de-puebla", ypsilanti: "puebla-de-zaragoza-colegio-ypsilanti", velmont: "puebla-de-zaragoza-colegio-velmont-ac",
  vanderbilt: "puebla-de-zaragoza-instituto-vanderbilt", esparza: "puebla-de-zaragoza-colegio-esparza" };
const acts = async where => [...await pd.activities({ ...where, done: true, limit: 100 }), ...await pd.activities({ ...where, done: false, limit: 100 })];
const orgCount = async () => (await demo.orgsPage({ limit: 1e6 })).items.length;
const leadsOf = async term => (await pd.searchItems(term, { types: "lead", fields: "title", limit: 50 })).items.map(i => i.item.id);

test("el cruce encuentra el prospecto sin organización: «Prospecto en Pipe» (aunque la masiva lo haya dejado «Nunca contactado»)", async () => {
  const r = await sales.checkSchool(ID.pestalozzi);
  assert.equal(r.status, "lead"); assert.equal(r.leadId, "demo-sep-pestalozzi"); assert.equal(r.orgId, null);
  assert.equal(r.leadTitle, "colegio enrique pestalozzi ac"); assert.equal(r.ownerId, null); // de la cuenta general: libre
  assert.equal(sales.schoolSummary(byId.get(ID.pestalozzi)).lead, true);
  assert.equal(byId.get(ID.pestalozzi).leadOnly, true);
  // un «Nunca contactado» al día que dejó la masiva (sin buscar prospectos): la ficha los busca igual
  setMatch(ID.margarita, { ...pd.noMatchRecord([]), via: "sync" });
  const m = await sales.checkSchool(ID.margarita);
  assert.equal(m.status, "lead"); assert.equal(m.leadId, "demo-sep-margarita"); assert.equal(m.ownerId, 2);
  // el otro «margarita maza» (Huejotzingo) y los «pestalozzi» de otras ciudades no se tocan
  assert.notEqual(m.leadId, "demo-sep-margarita-huejo");
});

test("logContact en «Prospecto en Pipe»: todo va al prospecto (pasa a tu nombre), no se crea organización", async () => {
  const before = await orgCount();
  const r = await sales.logContact(ID.pestalozzi, me, { outcome: "no_answer", channel: "call", text: "no atendió", next: { type: "call", date: "2026-11-16", time: "10:00" } }, "UTC");
  assert.equal(await orgCount(), before, "no se crea organización");
  assert.equal(getMatch(ID.pestalozzi).orgId, null);
  assert.deepEqual(r.where, { kind: "lead", id: "demo-sep-pestalozzi", title: "colegio enrique pestalozzi ac", url: `${pd.PD_WEB}/leads/inbox/demo-sep-pestalozzi`, created: false });
  assert.ok(r.done.some(d => /pasó a tu nombre/.test(d.label)), JSON.stringify(r.done));
  assert.equal((await pd.getLead("demo-sep-pestalozzi")).ownerId, 1);
  const a = await acts({ leadId: "demo-sep-pestalozzi" });
  assert.ok(a.some(x => x.done && /^Llamada: /.test(x.subject)) && a.some(x => !x.done && x.type === "call"));
  assert.ok((await pd.notesForLead("demo-sep-pestalozzi", 10)).some(n => /Llamada · No atendió/.test(n.content)));
  for (const other of ["demo-sep-pestalozzi-cdmx", "demo-sep-pestalozzi-coatza"]) assert.equal((await acts({ leadId: other })).length, 0);
  // «Crear prospecto» ya no crea otro: es ese
  const c = await sales.createProspect(ID.pestalozzi, me, null, "UTC");
  assert.equal(c.created, false); assert.equal(c.lead.id, "demo-sep-pestalozzi");
  assert.ok(c.done.some(d => /Ya tenía un prospecto en Pipedrive: «colegio enrique pestalozzi ac»/.test(d.label)));
  assert.equal(await orgCount(), before);
});

test("el prospecto sin organización de otra persona no se toca: 409 y nada escrito", async () => {
  const before = (await acts({ leadId: "demo-sep-margarita" })).length, orgs = await orgCount();
  await assert.rejects(sales.logContact(ID.margarita, me, { outcome: "no_answer", channel: "call" }, "UTC"), e => e.status === 409 && e.code === "pd_theirs" && /Juan Diego/.test(e.message) && /colegio margarita maza/.test(e.message));
  await assert.rejects(sales.commentSchool(ID.margarita, me, { text: "hola" }, "UTC"), e => e.code === "pd_theirs");
  await assert.rejects(sales.mailGuard(ID.margarita, me), e => e.status === 409);
  assert.equal((await acts({ leadId: "demo-sep-margarita" })).length, before);
  assert.equal(await orgCount(), orgs);
});

test("algo parecido: 409 con las candidatas y no se crea nada; «Es este» lo usa y lo que se registra va ahí", async () => {
  const orgs = await orgCount(), leads = (await leadsOf("prometeo")).length;
  const r = await sales.checkSchool(ID.prometeo);
  assert.equal(r.status, "new"); assert.deepEqual(r.pdx.maybe.map(x => x.key), ["lead:demo-sep-prometeo"]);
  assert.equal(r.pdx.maybe[0].place, "Puebla, Puebla"); assert.equal(r.pdx.maybe[0].why, "nombre parecido, misma ciudad");
  let err;
  await assert.rejects(sales.commentSchool(ID.prometeo, me, { text: "Pasé por la puerta" }, "UTC"), e => (err = e).status === 409);
  assert.equal(err.code, "pd_maybe"); assert.equal(err.message, "Ya hay algo parecido en Pipedrive: ¿es alguno de estos?");
  assert.deepEqual(err.candidates.map(c => [c.key, c.title, c.what]), [["lead:demo-sep-prometeo", "Centro Freinet Prometeo S.C.", "prospecto"]]);
  assert.equal(await orgCount(), orgs); assert.equal((await leadsOf("prometeo")).length, leads);
  // el mail tampoco se ofrece (antes de la cuenta de 5 s)
  await assert.rejects(sales.mailGuard(ID.prometeo, me), e => e.code === "pd_maybe" && e.candidates.length === 1);
  const u = await sales.useExisting(ID.prometeo, me, "lead:demo-sep-prometeo");
  assert.ok(u.done.some(d => /Ya estaba en Pipedrive: prospecto «Centro Freinet Prometeo S\.C\.»/.test(d.label)));
  assert.equal(getMatch(ID.prometeo).status, "lead"); assert.equal(getMatch(ID.prometeo).confirmed, true); assert.equal(getMatch(ID.prometeo).auto, false);
  const c = await sales.commentSchool(ID.prometeo, me, { text: "Pasé por la puerta" }, "UTC");
  assert.equal(c.where.id, "demo-sep-prometeo");
  assert.ok((await pd.notesForLead("demo-sep-prometeo", 10)).some(n => /Pasé por la puerta/.test(n.content)));
  assert.equal(await orgCount(), orgs);
  // elegido a mano: el cruce lo mantiene
  assert.equal((await sales.checkSchool(ID.prometeo, { force: true })).leadId, "demo-sep-prometeo");
  // «Convertir a trato»: primero la organización a tu nombre, así el trato la lleva (y la ficha pasa a la organización)
  const t = await sales.convertToDeal(ID.prometeo, me, { country: "México" });
  const d = await pd.getDeal(t.dealId), m = getMatch(ID.prometeo);
  assert.ok(d.org_id); assert.equal(m.orgId, d.org_id); assert.equal(m.status, "open");
  assert.equal(byId.get(ID.prometeo).leadOnly, false);
  assert.ok(t.done.some(x => x.label === "Organización creada en Pipedrive a tu nombre"));
});

test("trato abierto sin organización de otra persona: se pregunta, «Es este» avisa y no lo toca; «Es otro colegio» crea lo suyo", async () => {
  const orgs = await orgCount();
  await assert.rejects(sales.logContact(ID.angeles, me, { outcome: "no_answer", channel: "call" }, "UTC"),
    e => e.code === "pd_maybe" && e.candidates.map(c => c.key).join() === "deal:6091" && e.candidates[0].what === "trato abierto · SELLING" && e.candidates[0].owner === "Juan Diego");
  await assert.rejects(sales.useExisting(ID.angeles, me, "deal:6091"), e => e.code === "pd_theirs" && /trato abierto de Juan Diego/.test(e.message));
  assert.equal((await pd.getDeal(6091)).org_id, null);
  assert.equal(await orgCount(), orgs);
  // lo que no se ofreció no se puede elegir
  await assert.rejects(sales.useExisting(ID.angeles, me, "lead:demo-rick-tlaxco"), e => e.status === 404);
  await sales.dismissExisting(ID.angeles);
  assert.deepEqual(getMatch(ID.angeles).pdx.no, ["deal:6091"]);
  const r = await sales.logContact(ID.angeles, me, { outcome: "no_answer", channel: "call" }, "UTC");
  assert.equal(await orgCount(), orgs + 1);
  assert.equal(r.where.kind, "lead"); assert.equal(r.where.created, true);
  // «angeles de atlixco» y «Angeles de puebla Tlaxco Mexicail 714» no son este colegio: no se tocaron
  for (const id of ["demo-sep-atlixco", "demo-rick-tlaxco"]) { assert.equal((await acts({ leadId: id })).length, 0); assert.equal((await pd.getLead(id)).orgId, null); }
});

test("un prospecto archivado es un dato: se crea lo nuevo y se avisa (no se reusa sin avisar)", async () => {
  const r = await sales.logContact(ID.ypsilanti, me, { outcome: "no_answer", channel: "call" }, "UTC");
  assert.equal(r.where.created, true);
  assert.ok(r.done.some(d => d.warn && /prospecto archivado de este colegio: «colegio ypsilanti» \(de Agustín Tejos\)/.test(d.label)), JSON.stringify(r.done));
  const l = await pd.getLead("demo-sep-ypsilanti");
  assert.equal(l.archived, true); assert.equal(l.orgId, null);
});

test("nada en Pipedrive: «Revisé en Pipedrive» (pdx) y recién ahí se crea; si la búsqueda falla, no se crea nada (503)", async () => {
  const r = await sales.checkSchool(ID.velmont);
  assert.equal(r.status, "new"); assert.equal(r.pdx.verdict, "none"); assert.ok(r.pdx.at); assert.equal(r.pdx.full, false);
  const c = await sales.createProspect(ID.velmont, me, null, "UTC");
  assert.equal(c.created, true);
  // un colegio cuya búsqueda falla en Pipedrive (el demo simula la caída)
  const s = byId.get(ID.vanderbilt); s.name = "Instituto Pipedrive-Caido";
  const orgs = await orgCount();
  const m = await sales.checkSchool(ID.vanderbilt);
  assert.equal(m.status, "new"); assert.equal(m.pdx, undefined, "sin búsqueda real, la ficha no dice «revisé»");
  await assert.rejects(sales.logContact(ID.vanderbilt, me, { outcome: "no_answer", channel: "call" }, "UTC"), e => e.status === 503 && e.message === "No pude revisar si ya existe en Pipedrive: probá de nuevo.");
  await assert.rejects(sales.createProspect(ID.vanderbilt, me, null, "UTC"), e => e.status === 503);
  assert.equal(await orgCount(), orgs); assert.equal(getMatch(ID.vanderbilt).orgId, null);
});

test("una organización con prospectos de otras ciudades: el de otra ciudad no es de este colegio (se crea el suyo)", async () => {
  const o = demo.createOrganization({ name: "Colegio Esparza", ownerId: 99 });
  const far = demo.createLead({ title: "colegio esparza", ownerId: 99, orgId: o.id, fields: { [(await import("../lib/config.js")).DEAL_FIELDS.direccion]: "calle de prueba 10, Colonia centro, merida, yucatan, C.P. 97000" } });
  await sales.linkSchool(ID.esparza, { id: o.id, name: o.name, ownerId: null });
  assert.deepEqual(await sales.leadsHere(byId.get(ID.esparza), o.id), []);
  const r = await sales.logContact(ID.esparza, me, { outcome: "no_answer", channel: "call" }, "UTC");
  assert.equal(r.where.kind, "lead"); assert.notEqual(r.where.id, far.id); assert.equal(r.where.created, true);
  assert.equal((await acts({ leadId: far.id })).length, 0);
  assert.equal((await pd.getLead(far.id)).ownerId, null, "el de Mérida sigue libre");
});

test("la sincronización masiva no borra lo que encontró la ficha (pdx) ni pisa un «Prospecto en Pipe»", () => {
  const pdx = { at: new Date().toISOString(), verdict: "maybe", maybe: [{ key: "lead:x" }] };
  const old = new Date(Date.now() - 5 * 864e5).toISOString();
  const r = psync.decideMatch({ cur: { ...pd.noMatchRecord([]), pdx, via: "sync", checkedAt: old }, fresh: true, cands: [], orgs: new Map(), dealsBy: new Map(), m: { users: [], pipes: {}, stages: {} }, startedAt: new Date().toISOString() });
  assert.deepEqual(r.rec.pdx, pdx);
  assert.deepEqual(psync.decideMatch({ cur: { status: "lead", leadId: "x", via: "sync", checkedAt: old }, fresh: true, cands: [], orgs: new Map(), dealsBy: new Map(), m: {}, startedAt: new Date().toISOString() }), { skip: "lead" });
});

test("el asistente sin ficha: si hay un prospecto o trato abierto que se llama así, no crea otra organización", async () => {
  assert.deepEqual((await sales.namedInPipedrive("Colegio Margarita Maza")).map(x => x.title), ["colegio margarita maza"]);
  assert.deepEqual(await sales.namedInPipedrive("Colegio Inexistente Zzz"), []);
});

test("Smart BCC: sin PIPEDRIVE_SMART_BCC va la de la cuenta de OrderEAT; «off» la apaga", () => {
  delete process.env.PIPEDRIVE_SMART_BCC;
  assert.equal(G.smartBcc(), "ordereat@pipedrivemail.com");
  process.env.PIPEDRIVE_SMART_BCC = "otra@pipedrivemail.com"; assert.equal(G.smartBcc(), "otra@pipedrivemail.com");
  process.env.PIPEDRIVE_SMART_BCC = "off"; assert.equal(G.smartBcc(), "");
  delete process.env.PIPEDRIVE_SMART_BCC;
});
