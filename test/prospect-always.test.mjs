// «Siempre en el prospecto»: un contacto, un comentario o un mail en un colegio sin trato abierto queda en un PROSPECTO
// (el abierto tuyo o libre, o uno nuevo a tu nombre), con la organización y la persona; el prospecto nuevo se enriquece
// (campos vacíos y nota de datos). Con trato abierto, al trato; cliente o de otra persona, a la organización.
// Con el Pipedrive de prueba y sin red (la web del colegio no se lee).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
for (const k of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "PIPEDRIVE_API_TOKEN", "ANTHROPIC_API_KEY", "GOOGLE_MAPS_API_KEY"]) delete process.env[k];
process.env.DEMO_MODE = "1";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ob-test-"));
process.env.ENRICH_ALLOW_PRIVATE = "1"; // sin DNS: la web «lenta» de la última prueba no sale a la red
// sin red: la web del colegio no se lee (salvo «lento.test», que no contesta hasta que se corta por tiempo)
globalThis.fetch = async (url, o = {}) => {
  if (!String(url).includes("lento.test")) throw new Error("sin red en la prueba");
  return new Promise((_, rej) => o.signal?.addEventListener("abort", () => rej(new Error("tiempo"))));
};
const sales = await import("../lib/sales.js");
const pd = await import("../lib/pipedrive.js");
const demo = await import("../lib/pipedrive-demo.js");
const { schools, getMatch, setStudy } = await import("../lib/store.js");
const { DEAL_FIELDS: F, OPTIONS } = await import("../lib/config.js");
const me = { email: "demo@example.com", name: "Demo", pdUserId: 1 };
const used = new Set();
// el primer colegio de México (sin usar en otra prueba) que cumple la condición
async function find(ok) {
  for (const s of schools.filter(x => x.country === "México" && !used.has(x.id))) {
    const r = await sales.checkSchool(s.id);
    if (await ok(r, s)) { used.add(s.id); s.web = ""; return { s, rec: r }; }
  }
  throw new Error("no hay un colegio así en el demo");
}
const noLeads = async r => !(await pd.leadsForOrg(r.orgId)).length;
const all = async where => [...await pd.activities({ ...where, done: true, limit: 100 }), ...await pd.activities({ ...where, done: false, limit: 100 })];
// las actividades que se crearon desde «before» (el demo trae otras de antes)
const since = async (where, before) => (await all(where)).filter(a => !before.has(a.id));
const ids = async where => new Set((await all(where)).map(a => a.id));

test("leadGaps: solo los campos vacíos (o «No encontrado»), nunca pisa lo que ya tiene", () => {
  const want = { [F.telefono]: "222 111 2222", [F.email]: "info@colegio.mx", [F.web]: "https://colegio.mx", [F.direccion]: "Calle 1, Puebla", [F.pais]: 91, [F.niveles]: "497,498", [F.fuente]: "502" };
  const lead = { phone: "999 999 9999", email: "No encontrado", web: "", addr: null, paisOpt: 91, nivelesOpt: null };
  assert.deepEqual(sales.leadGaps(lead, want), { [F.email]: "info@colegio.mx", [F.web]: "https://colegio.mx", [F.direccion]: "Calle 1, Puebla", [F.niveles]: "497,498" });
  assert.deepEqual(sales.leadGaps({ phone: "1", email: "a@b.co", web: "x", addr: "y", paisOpt: 1, ciudadOpt: 2, estadoOpt: 3, nivelesOpt: "4" }, want), {});
  assert.deepEqual(sales.leadGaps({}, { [F.telefono]: "  ", [F.email]: "N/A" }), {});
});

test("clientNow: trato ganado, World Dominion activo o fase activo/onboarding", () => {
  assert.equal(sales.clientNow({ status: "client" }, {}), true);
  assert.equal(sales.clientNow({ status: "org", phase: "onboarding" }, {}), true);
  assert.equal(sales.clientNow({ status: "org" }, { status: "org", phase: "activo" }), true);
  assert.equal(sales.clientNow({ status: "lost", phase: "churn" }, { status: "lost" }), false);
  assert.equal(sales.clientNow({ status: "org" }, { status: "org" }), false);
});

test("logContact en un colegio con organización sin prospecto ni trato: crea el prospecto a tu nombre y todo va ahí", async () => {
  const { s, rec } = await find(async r => r.orgId && r.status === "org" && r.ownerId === 1 && !r.openDealId && await noLeads(r));
  // la base tiene mail y dirección pero no teléfono; el estudio del colegio trae un teléfono y una decisora
  s.phone = ""; s.email = "info@colegio-prueba.mx"; s.addr = "Calle Uno 123";
  await setStudy(s.id, { contacto: { telefonos: ["222 111 2222"] }, decisores: [{ nombre: "Laura Gómez", cargo: "Directora" }] });
  const before = await ids({ orgId: rec.orgId });
  const r = await sales.logContact(s.id, me, { outcome: "no_answer", channel: "call", text: "no atendió", next: { type: "call", date: "2026-11-13", time: "10:00" } }, "UTC");
  const leads = await pd.leadsForOrg(rec.orgId);
  assert.equal(leads.length, 1); const l = leads[0];
  assert.equal(l.ownerId, 1); assert.equal(l.title, s.name); assert.equal(getMatch(s.id).leadId, l.id);
  assert.deepEqual(r.where, { kind: "lead", id: l.id, title: s.name, url: `${pd.PD_WEB}/leads/inbox/${l.id}`, created: true });
  assert.equal(r.lead.id, l.id); assert.equal(r.orgUrl, `${pd.PD_WEB}/leads/inbox/${l.id}`);
  assert.ok(r.done.some(d => d.label === `Prospecto creado a tu nombre: «${s.name}»` && d.url.endsWith(l.id)), JSON.stringify(r.done));
  assert.ok(r.done.some(d => d.label === `Guardado en el prospecto «${s.name}»`));
  const acts = await since({ orgId: rec.orgId }, before);
  assert.equal(acts.length, 2);
  for (const a of acts) { assert.equal(a.lead_id, l.id, a.subject); assert.equal(a.org_id, rec.orgId); }
  assert.ok(acts.some(a => a.done && /^Llamada: /.test(a.subject)) && acts.some(a => !a.done && a.type === "call"));
  const notes = await pd.notesForLead(l.id, 20);
  assert.ok(notes.some(n => /<b>Llamada · /.test(n.content) && n.org_id === rec.orgId), "la nota del contacto, en el prospecto y la organización");
  // el prospecto nuevo se enriquece: campos con lo de la base y la nota «Datos del colegio» en el prospecto
  const full = (await pd.leadsByIds([l.id]))[0];
  assert.equal(full.phone, "222 111 2222", "el teléfono del estudio completó el campo vacío"); assert.equal(full.email, "info@colegio-prueba.mx"); assert.match(full.addr, /^Calle Uno 123/); assert.equal(full.paisOpt, OPTIONS.pais["México"]);
  assert.ok(r.done.some(d => d.label === "Datos completados en el prospecto: teléfono"), JSON.stringify(r.done));
  const dn = notes.find(n => /Datos del colegio · OrderBrain SDR/.test(n.content));
  assert.ok(dn && dn.org_id === rec.orgId, "nota de datos en el prospecto (y la organización)"); assert.match(dn.content, /Laura Gómez/);
  // el segundo contacto va al mismo prospecto (no crea otro)
  const r2 = await sales.logContact(s.id, me, { outcome: "no_answer", channel: "whatsapp" }, "UTC");
  assert.equal((await pd.leadsForOrg(rec.orgId)).length, 1); assert.equal(r2.where.created, false); assert.equal(r2.where.id, l.id);
});

test("logContact en un colegio nuevo (sin organización): crea la organización y el prospecto", async () => {
  const { s } = await find(async r => r.status === "new" && !r.orgId && !r.candidates?.length);
  const r = await sales.logContact(s.id, me, { outcome: "gatekeeper", channel: "call", contact: { name: "Rosa", role: "recepción" } }, "UTC");
  const m = getMatch(s.id); assert.ok(m.orgId); assert.ok(m.leadId);
  const l = (await pd.leadsForOrg(m.orgId))[0]; assert.equal(l.id, m.leadId); assert.equal(l.ownerId, 1);
  assert.ok(l.personId, "el prospecto lleva la persona del contacto");
  assert.ok(r.done.some(d => /Organización creada en Pipedrive/.test(d.label)));
  assert.equal(r.where.kind, "lead"); assert.equal(r.where.created, true);
  const acts = await all({ orgId: m.orgId });
  assert.ok(acts.length >= 2); for (const a of acts) assert.equal(a.lead_id, l.id);
});

test("logContact con trato abierto: todo al trato, sin prospecto nuevo", async () => {
  const { s, rec } = await find(async r => r.status === "open" && r.openDealId && r.ownerId === 1 && await noLeads(r));
  const before = await ids({ orgId: rec.orgId });
  const r = await sales.logContact(s.id, me, { outcome: "no_answer", channel: "call", next: { type: "call", date: "2026-11-14" } }, "UTC");
  assert.equal((await pd.leadsForOrg(rec.orgId)).length, 0);
  assert.equal(r.where.kind, "deal"); assert.equal(r.lead, undefined);
  const acts = await since({ orgId: rec.orgId }, before);
  assert.equal(acts.length, 2); for (const a of acts) { assert.equal(a.deal_id, rec.openDealId); assert.equal(a.lead_id, null); }
});

test("logContact en un cliente: no se crea prospecto (queda en la organización)", async () => {
  const { s, rec } = await find(async r => r.status === "client" && r.ownerId === 1 && await noLeads(r));
  const before = await ids({ orgId: rec.orgId });
  const r = await sales.logContact(s.id, me, { outcome: "info", channel: "call" }, "UTC");
  assert.equal((await pd.leadsForOrg(rec.orgId)).length, 0);
  assert.equal(r.where.kind, "org");
  const acts = await since({ orgId: rec.orgId }, before); assert.ok(acts.length);
  for (const a of acts) assert.equal(a.lead_id, null);
});

test("logContact con el prospecto de otra persona: no se toca ni se crea otro, queda en la organización con aviso", async () => {
  const { s, rec } = await find(async r => r.status === "org" && r.ownerId === 1 && await noLeads(r));
  const other = demo.createLead({ title: `${s.name} (de Juan Diego)`, ownerId: 2, orgId: rec.orgId });
  const before = await ids({ orgId: rec.orgId });
  const r = await sales.logContact(s.id, me, { outcome: "no_answer", channel: "call" }, "UTC");
  assert.ok(r.warnings.some(w => /es de otra persona: quedó en la organización/.test(w)), JSON.stringify(r.warnings));
  const leads = await pd.leadsForOrg(rec.orgId); assert.equal(leads.length, 1); assert.equal(leads[0].id, other.id); assert.equal(leads[0].ownerId, 2);
  assert.equal(r.where.kind, "org");
  const acts = await since({ orgId: rec.orgId }, before); assert.ok(acts.length);
  for (const a of acts) assert.equal(a.lead_id, null);
});

test("logContact en una organización de otra persona: no crea prospecto a tu nombre, avisa", async () => {
  const { s, rec } = await find(async r => r.status === "org" && r.ownerId === 2 && await noLeads(r));
  const r = await sales.logContact(s.id, me, { outcome: "no_answer", channel: "call" }, "UTC");
  assert.equal((await pd.leadsForOrg(rec.orgId)).length, 0);
  assert.ok(r.warnings.some(w => /no creé un prospecto/.test(w)), JSON.stringify(r.warnings));
});

test("demo agendada: se crea el trato, el prospecto se archiva y el contacto anterior queda en el prospecto", async () => {
  const { s, rec } = await find(async r => r.status === "org" && r.ownerId === 1 && await noLeads(r));
  await sales.logContact(s.id, me, { outcome: "no_answer", channel: "call" }, "UTC");
  const lid = getMatch(s.id).leadId; assert.ok(lid);
  const d = await sales.logContact(s.id, me, { outcome: "demo", channel: "call", demo: { date: "2026-11-20", time: "11:00", duration: 30 } }, "UTC");
  assert.equal(d.where.kind, "deal"); assert.ok(d.dealUrl);
  assert.equal((await pd.leadsForOrg(rec.orgId)).length, 0, "el prospecto quedó archivado");
  const first = (await pd.activities({ leadId: lid, done: true, limit: 20 })).find(a => /No atendió/i.test(a.subject));
  assert.ok(first, "el contacto anterior sigue en el prospecto");
});

test("comentario con tarea en un colegio sin prospecto: crea el prospecto y la nota y la tarea van ahí", async () => {
  const { s, rec } = await find(async r => r.status === "stalled" && r.ownerId === 1 && await noLeads(r));
  const r = await sales.commentSchool(s.id, me, { text: "Llamar a la directora", task: { type: "call", date: "2026-11-18", time: "09:00" } }, "UTC");
  const l = (await pd.leadsForOrg(rec.orgId))[0]; assert.ok(l); assert.equal(l.ownerId, 1);
  assert.equal(r.where.kind, "lead"); assert.equal(r.where.created, true);
  assert.ok(r.done.some(x => x.label === "Comentario en el prospecto"));
  const t = (await pd.activities({ leadId: l.id, done: false, limit: 20 }))[0]; assert.ok(t); assert.equal(t.org_id, rec.orgId); assert.equal(t.due_date, "2026-11-18");
  assert.ok((await pd.notesForLead(l.id, 20)).some(n => /<b>Comentario<\/b>/.test(n.content) && n.org_id === rec.orgId));
  assert.equal(getMatch(s.id).confirmed, true);
});

test("comentario en un colegio con trato abierto: al trato", async () => {
  const { s, rec } = await find(async r => r.status === "open" && r.ownerId === 1 && await noLeads(r));
  const r = await sales.commentSchool(s.id, me, { text: "Pidió la propuesta" }, "UTC");
  assert.equal(r.where.kind, "deal"); assert.equal((await pd.leadsForOrg(rec.orgId)).length, 0);
  assert.ok((await pd.notesForOrg(rec.orgId, 5)).some(n => /Pidió la propuesta/.test(n.content) && n.deal_id === rec.openDealId && !n.lead_id));
});

test("mail en un colegio con organización sin prospecto: crea el prospecto; con trato abierto, al trato", async () => {
  const send = async () => ({ id: `msg-${Date.now()}-${Math.random()}`, threadId: "t", from: me.email, bcc: false });
  const { s, rec } = await find(async r => r.status === "lost" && r.ownerId === 1 && await noLeads(r));
  const before = await ids({ orgId: rec.orgId });
  const r = await sales.sendMail(s.id, me, { to: "direccion@colegio.mx", subject: "OrderEAT", text: "Hola" }, "UTC", { send });
  const l = (await pd.leadsForOrg(rec.orgId))[0]; assert.ok(l);
  assert.equal(r.where.kind, "lead"); assert.equal(r.mail.url, `${pd.PD_WEB}/leads/inbox/${l.id}`);
  const acts = await since({ orgId: rec.orgId }, before); assert.equal(acts.length, 2); for (const a of acts) assert.equal(a.lead_id, l.id);
  // el próximo paso del mail se mueve dentro del prospecto
  const n = await sales.mailNext(s.id, me, { mailId: r.mail.id, next: { type: "task", date: "2026-12-02", time: "" } }, "UTC");
  assert.ok(n.ok); const pend = (await since({ orgId: rec.orgId }, before)).filter(a => !a.done); assert.equal(pend.length, 1); assert.equal(pend[0].lead_id, l.id); assert.equal(pend[0].type, "task");
  const o = await find(async r2 => r2.status === "open" && r2.ownerId === 1 && await noLeads(r2));
  const r3 = await sales.sendMail(o.s.id, me, { to: "a@colegio.mx", subject: "Propuesta", text: "Hola" }, "UTC", { send });
  assert.equal(r3.where.kind, "deal"); assert.equal((await pd.leadsForOrg(o.rec.orgId)).length, 0);
});

test("Enriquecer con prospecto: completa solo los campos vacíos (tuyo o libre) y la nota va al prospecto", async () => {
  const { s, rec } = await find(async r => r.status === "org" && r.ownerId === 1 && await noLeads(r));
  await sales.linkSchool(s.id, { id: rec.orgId, name: rec.orgName, ownerId: 1 });
  s.phone = "222 333 4444"; s.email = "hola@colegio-enr.mx"; s.addr = "Av. Reforma 10";
  await setStudy(s.id, { contacto: { emails: ["direccion@colegio-enr.mx"] }, decisores: [] }); // algo nuevo para la nota
  const l = demo.createLead({ title: s.name, ownerId: 99, orgId: rec.orgId, fields: { [F.telefono]: "999 000 1111", [F.email]: "No encontrado" } });
  const r = await sales.enrichSchool(s.id, me, "Demo");
  const after = (await pd.leadsByIds([l.id]))[0];
  assert.equal(after.phone, "999 000 1111", "no pisa el teléfono que ya tenía");
  assert.equal(after.email, "hola@colegio-enr.mx", "«No encontrado» cuenta como vacío");
  assert.match(after.addr, /^Av\. Reforma 10/); assert.equal(after.paisOpt, OPTIONS.pais["México"]);
  assert.deepEqual(r.fields.saved.sort(), ["dirección", "mail", "país"].sort());
  assert.equal(r.note.saved, true); assert.equal(r.note.url, `${pd.PD_WEB}/leads/inbox/${l.id}`);
  const note = (await pd.notesForLead(l.id, 5)).find(n => /Datos del colegio · OrderBrain SDR/.test(n.content));
  assert.ok(note); assert.equal(note.org_id, rec.orgId);
  // de otra persona: ni campos ni nota
  const { s: s2, rec: rec2 } = await find(async x => x.status === "org" && x.ownerId === 1 && await noLeads(x));
  await sales.linkSchool(s2.id, { id: rec2.orgId, name: rec2.orgName, ownerId: 1 });
  s2.email = "otro@colegio.mx";
  const l2 = demo.createLead({ title: s2.name, ownerId: 2, orgId: rec2.orgId });
  const r2 = await sales.enrichSchool(s2.id, me, "Demo");
  assert.equal((await pd.leadsByIds([l2.id]))[0].email, ""); assert.equal(r2.note.saved, false); assert.deepEqual(r2.fields.saved, []);
});

test("Crear prospecto: los campos salen de la base, la nota de creación y la de datos van al prospecto", async () => {
  const { s, rec } = await find(async r => r.status === "org" && r.ownerId === 1 && await noLeads(r));
  s.phone = "222 555 6666"; s.addr = "Calle Dos 2";
  const r = await sales.createProspect(s.id, me, { type: "call", date: "2026-11-19" }, "UTC");
  assert.equal(r.lead.created, true);
  const l = (await pd.leadsByIds([r.lead.id]))[0];
  assert.equal(l.phone, "222 555 6666"); assert.match(l.addr, /^Calle Dos 2/);
  const notes = await pd.notesForLead(l.id, 10);
  assert.ok(notes.some(n => /Prospecto creado desde OrderBrain SDR/.test(n.content) && n.org_id === rec.orgId));
  const task = (await pd.activities({ leadId: l.id, done: false, limit: 5 }))[0]; assert.equal(task.lead_id, l.id); assert.equal(task.org_id, rec.orgId);
});

test("el enriquecimiento del prospecto nuevo tiene tope de tiempo: si tarda, avisa que quedó pendiente", async () => {
  const { s, rec } = await find(async r => r.status === "org" && r.ownerId === 1 && await noLeads(r));
  s.web = "https://lento.test"; // su web no contesta (la lectura se corta sola a los 7 s)
  const keep = sales.ENRICH_WAIT.ms; sales.ENRICH_WAIT.ms = 50;
  try {
    const t = Date.now(), r = await sales.logContact(s.id, me, { outcome: "no_answer", channel: "call" }, "UTC");
    assert.ok(Date.now() - t < 3000, "no espera a la web");
    assert.ok(r.done.some(d => d.pending && /Sigo buscando los datos del colegio/.test(d.label)), JSON.stringify(r.done));
    assert.ok((await pd.leadsForOrg(rec.orgId)).length === 1, "el contacto y el prospecto ya quedaron");
  } finally { sales.ENRICH_WAIT.ms = keep; }
});
