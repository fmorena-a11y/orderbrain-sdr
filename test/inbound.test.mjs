// Tus inbound: el parser de los mensajes del reparto (los dos formatos reales, basura en «Colegio», mailto, wa.me, #ERROR!,
// pegado sin formato), a quién le toca (email de Slack, nombre, preferencia), quién ve qué, el día de la llamada y, de punta a
// punta con el Pipedrive y el Slack de prueba: crea prospecto + llamada una sola vez, lo que ya está (por teléfono, mail o
// link) no se crea, lo de otra persona no se toca, título y fuente, alcance por rol y READ_ONLY. Datos inventados.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
for (const k of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "PIPEDRIVE_API_TOKEN", "ANTHROPIC_API_KEY", "SLACK_BOT_TOKEN", "GOOGLE_MAPS_API_KEY"]) delete process.env[k];
process.env.DEMO_MODE = "1";
process.env.DEV_LOGIN_EMAIL = "demo@example.com";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ob-inbound-"));
globalThis.fetch = async () => { throw new Error("sin red en la prueba"); };
const I = await import("../lib/inbound.js");
const IR = await import("../lib/inbound-run.js");
const DEMO = await import("../lib/inbound-demo.js");
const pd = await import("../lib/pipedrive.js");
const { canLead } = await import("../lib/teams.js");
const { writesPipedrive } = await import("../lib/readonly.js");
const { DEAL_FIELDS } = await import("../lib/config.js");

// ---------- formatos reales (datos cambiados)
const A = [":telephone_receiver: *Lead para llamar* — le toca a <@U0FACU0001|Facu Morena>",
  "_Entró filtrado como puesto no decisor: Otro — igual hay que llamarlo._",
  ":moneybag: Este lead viene de PAUTA en Meta Ads (Facebook/Instagram) · campaña: 120249217681380243", "",
  "*Teléfono:* 1155550000  ·  <https://wa.me/1155550000|WhatsApp>", "*Nombre:* Natanael", "*Colegio:* 21 de José c paz", "*País:* Argentina",
  "*Email:* <mailto:natanael.prueba@gmail.com|natanael.prueba@gmail.com>", "*Puesto:* Otro", "*Mensaje:* Que el ppff pague antes.", "Realmente es muy chica la cantina.",
  "_Reparto hasta ahora — Ariana Moreira: 20 · Facu Morena: 19_"].join("\n");
const B = [":mortar_board: *Referido de padre* — le toca a <@U0ARI00001|Ariana Moreira>  _(prioridad baja)_", "*Colegio:* Lic Raúl Rangel frías · General Escobedo",
  "*Quien decide:* Mireya · Quien opera la cafetería  ·  +528100000033", "", "*Lead en Pipedrive:* <https://ordereat.pipedrive.com/leads/inbox/1d783870-e174-11f1-a926-b1ba2c8edf68>",
  "_Llamalo antes de 72 h. Al agendar la demo convertí el lead en trato._", "_Reparto del piloto — Ariana Moreira 6 (+1)_"].join("\n");

test("formato A (Lead para llamar): campos, fuente, campaña, teléfono normalizado y mensaje de varias líneas", () => {
  const p = I.parseInbound(A, { ts: "1763302445.000100" });
  assert.equal(p.kind, "call"); assert.equal(p.kindLabel, "Lead para llamar");
  assert.deepEqual(p.to, { slackId: "U0FACU0001", name: "Facu Morena" });
  assert.equal(p.source, "meta"); assert.equal(p.sourceLabel, "Meta Ads"); assert.equal(p.campaign, "120249217681380243");
  assert.equal(p.phone, "1155550000"); assert.equal(p.phoneE164, "+5491155550000"); assert.equal(p.country, "Argentina");
  assert.equal(p.email, "natanael.prueba@gmail.com"); assert.equal(p.name, "Natanael"); assert.equal(p.role, "Otro");
  assert.equal(p.message, "Que el ppff pague antes.\nRealmente es muy chica la cantina.");
  assert.match(p.filter, /puesto no decisor/); assert.equal(p.pd, null);
  assert.equal(I.leadTitleFor(p), "Natanael – 21 de José C. Paz (Inbound Meta Ads)");
  assert.equal(I.subjectFor(p), "Llamar · inbound Meta Ads · Natanael");
});
test("formato B (Referido de padre): colegio · ciudad, quien decide, link del prospecto, prioridad y país por el prefijo", () => {
  const p = I.parseInbound(B, { ts: "1" });
  assert.equal(p.kind, "referral"); assert.equal(p.priority, "baja"); assert.equal(p.to.name, "Ariana Moreira");
  assert.equal(p.school, "Lic Raúl Rangel frías"); assert.equal(p.city, "General Escobedo");
  assert.equal(p.name, "Mireya"); assert.equal(p.role, "Quien opera la cafetería"); assert.equal(p.phoneE164, "+528100000033"); assert.equal(p.country, "México");
  assert.deepEqual(p.pd, { kind: "lead", id: "1d783870-e174-11f1-a926-b1ba2c8edf68", url: "https://ordereat.pipedrive.com/leads/inbox/1d783870-e174-11f1-a926-b1ba2c8edf68" });
  assert.equal(I.leadTitleFor(p), "Lic Raúl Rangel Frías (Referido de padre)");
  assert.equal(I.subjectFor(p), "Llamar · referido de padre · Mireya");
});
test("«Colegio» basura (#ERROR!, números, una ciudad, vacío): el título usa la persona y no se busca por nombre", () => {
  const mk = (school, extra = "") => I.parseInbound(`*Lead para llamar* — le toca a <@U1|X Y>\n:seedling: Este lead es ORGÁNICO: entró directo a la web, sin UTM\n*Teléfono:* MX5511112222\n*Nombre:* Carla Ejemplo\n*Colegio:* ${school}\n*País:* México${extra}`);
  assert.equal(I.schoolQuality("#ERROR!"), "empty"); assert.equal(I.schoolQuality("—"), "empty"); assert.equal(I.schoolQuality("S/n"), "empty");
  assert.equal(I.schoolQuality("48222982"), "number"); assert.equal(I.schoolQuality("AJY39"), "number"); assert.equal(I.schoolQuality("Colegio"), "generic"); assert.equal(I.schoolQuality("Privado"), "generic");
  assert.equal(I.schoolQuality("Lima", { places: new Set(["lima"]) }), "city"); assert.equal(I.schoolQuality("Perú"), "city"); assert.equal(I.schoolQuality("Mendoza", { places: new Set(["mendoza"]) }), "city");
  assert.equal(I.schoolQuality("21 de José c paz"), "weak"); assert.equal(I.schoolQuality("Escuela Nro. 224"), "ok"); assert.equal(I.schoolQuality("IE 7094 SASAKAWA"), "ok");
  const e = mk("#ERROR!");
  assert.equal(e.school, ""); assert.equal(e.phoneE164, "+525511112222"); assert.equal(e.source, "organic");
  assert.equal(I.leadTitleFor(e), "Carla Ejemplo (Inbound orgánico)");
  assert.equal(I.leadTitleFor(mk("48222982")), "Carla Ejemplo – 48222982 (Inbound orgánico)");
  assert.equal(I.leadTitleFor(mk("Colegio")), "Carla Ejemplo (Inbound orgánico)");
  assert.equal(I.lookupOf(mk("48222982")).name, ""); assert.equal(I.lookupOf(mk("Colegio Los Pinos")).name, "Colegio Los Pinos");
  // un nombre que es un link (spam) no se usa como persona
  assert.equal(I.personOk("evil.com"), ""); assert.equal(I.personOk("Carla"), "Carla");
});
test("pegado desde Slack (sin asteriscos ni <…>), varios juntos, y lo que no es un lead", () => {
  const txt = `Salva  APP  11:14\n📞 Lead para llamar — le toca a @Facu Morena\nEntró filtrado como puesto no decisor: Otro — igual hay que llamarlo.\nEste lead viene de PAUTA en Google Ads\nTeléfono: +51 921 000 877  ·  WhatsApp\nNombre: Kemury Ejemplo\nColegio: 3080\nPaís: Perú\nEmail: kemury.ejemplo@gmail.com\nPuesto: Otro\nMensaje: Quisiera proponerlo\nReparto hasta ahora — Ariana Moreira: 19 · Facu Morena: 18\nSalva  APP  11:16\n🎓 Referido de padre — le toca a @Ariana Moreira  (prioridad baja)\nColegio: Técnica 74 · Merida\nQuien decide: Bocales · Director o directora  ·  +529990000410\nLead en Pipedrive: https://ordereat.pipedrive.com/leads/inbox/51bc3fb0-e0b5-11f1-84e5-17295d470276`;
  const l = I.splitPasted(txt);
  assert.equal(l.length, 2);
  assert.equal(l[0].to.name, "Facu Morena"); assert.equal(l[0].source, "google"); assert.equal(l[0].phoneE164, "+51921000877"); assert.equal(l[0].email, "kemury.ejemplo@gmail.com");
  assert.equal(l[0].message, "Quisiera proponerlo"); assert.match(l[0].filter, /no decisor/);
  assert.equal(l[1].kind, "referral"); assert.equal(l[1].priority, "baja"); assert.equal(l[1].pd.id, "51bc3fb0-e0b5-11f1-84e5-17295d470276"); assert.equal(l[1].city, "Merida");
  // la misma clave si se pega dos veces
  assert.equal(I.splitPasted(txt)[0].ts, l[0].ts); assert.match(l[0].ts, /^p[0-9a-f]{16}$/);
  // sin «le toca a»: es de quien lo pega
  const solo = I.splitPasted("Teléfono: 2615550000\nNombre: Sofía\nColegio: Colegio Aconcagua\nPaís: Argentina");
  assert.equal(solo.length, 1); assert.deepEqual(solo[0].to, { slackId: "", name: "" });
  assert.equal(I.assignee(solo[0].to, { me: "yo@ordereat.com" }).email, "yo@ordereat.com");
  // correcciones, charla y entradas al canal no son leads
  assert.equal(I.parseInbound(":warning: *Corrección* — *Ivette* (México) le toca a <@U1|Belu Bargen>. Ignoren el anterior."), null);
  assert.equal(I.isCorrection(":broom: *Corrección — el mismo contacto se derivó a varios*\n…"), true);
  assert.equal(I.parseInbound("Este reparto no indica a que AE se lo asignamos?"), null);
});
test("SDR revival y tipos nuevos con el mismo formato", () => {
  const r = I.parseInbound(DEMO.history().find(m => /SDR revival/.test(m.text)).text, { ts: "9" });
  assert.equal(r.kind, "revival"); assert.equal(r.source, "revival"); assert.equal(r.kindLabel, "SDR revival");
  assert.match(I.leadTitleFor(r), /\(SDR revival\)$/); assert.match(I.subjectFor(r), /^Llamar · SDR revival · /);
  const n = I.parseInbound("*Lead de evento* — le toca a <@U9|Belu Bargen>\n*Teléfono:* +59899000111\n*Nombre:* Ana\n*Colegio:* Liceo Prueba");
  assert.equal(n.kind, "other"); assert.equal(n.kindLabel, "Lead de evento"); assert.equal(n.country, "Uruguay"); assert.equal(I.leadTitleFor(n), "Liceo Prueba (Inbound)");
});

// ---------- a quién le toca
test("a quién le toca: preferencia, email de Slack, nombre abreviado y apodos; ambiguo = nadie", () => {
  const people = [{ email: "fmorena@ordereat.com", names: ["Facundo Morena"] }, { email: "jfabregat@ordereat.com", names: ["Joaquín Fabregat"] }, { email: "bbargen@ordereat.com", names: ["Belén Bargen"] },
    { email: "amoreira@ordereat.com", names: ["Ariana Moreira"] }];
  assert.equal(I.sameName("Facu Morena", "Facundo Morena"), true); assert.equal(I.sameName("Joaco Fabregat", "Joaquín Fabregat"), true);
  assert.equal(I.sameName("Belu Bargen", "Belén Bargen"), true); assert.equal(I.sameName("Facu Morena", "Facundo Martinez"), false);
  assert.deepEqual(I.assignee({ slackId: "U1", name: "Facu Morena" }, { people }), { email: "fmorena@ordereat.com", how: "name" });
  assert.deepEqual(I.assignee({ slackId: "U1", name: "Facu Morena" }, { people, slackEmails: new Map([["U1", "Otro@Ordereat.com"]]) }), { email: "otro@ordereat.com", how: "slack" });
  assert.deepEqual(I.assignee({ slackId: "U1", name: "Facu M" }, { people, prefs: { "fmorena@ordereat.com": { name: "Facu M" } } }), { email: "fmorena@ordereat.com", how: "pref" });
  assert.equal(I.assignee({ slackId: "U2", name: "Facu Morena" }, { people: [...people, { email: "otro.morena@ordereat.com", names: ["Facundo Morena"] }] }).email, "");
});
test("quién ve qué: lo suyo; un líder de equipo, lo de su gente; dirección, todo (también lo sin asignar)", () => {
  const scope = { ids: new Set([2]), emails: new Set(["juandiego@ordereat.com"]) };
  const x = email => ({ email });
  assert.equal(I.visible(x("demo@example.com"), "demo@example.com", false, canLead), true);
  assert.equal(I.visible(x("juandiego@ordereat.com"), "demo@example.com", false, canLead), false);
  assert.equal(I.visible(x("juandiego@ordereat.com"), "lider@ordereat.com", scope, canLead), true);
  assert.equal(I.visible(x("agustin@ordereat.com"), "lider@ordereat.com", scope, canLead), false);
  assert.equal(I.visible(x(""), "lider@ordereat.com", scope, canLead), false);
  assert.equal(I.visible(x(""), "ceo@ordereat.com", true, canLead), true);
});
test("día de la llamada: hoy si entró en horario; de noche o el fin de semana, el próximo día hábil; nunca antes de hoy", () => {
  const tz = "America/Argentina/Buenos_Aires", at = s => new Date(s).toISOString();
  const mon10 = Date.parse("2026-11-16T13:00:00Z"); // lunes 10:00 en Buenos Aires
  assert.equal(I.callDay(at("2026-11-16T12:30:00Z"), tz, mon10), "2026-11-16"); // entró el lunes 9:30
  assert.equal(I.callDay(at("2026-11-14T15:00:00Z"), tz, mon10), "2026-11-16"); // sábado → lunes (hoy)
  assert.equal(I.callDay(at("2026-11-10T13:00:00Z"), tz, mon10), "2026-11-16"); // vieja → hoy
  const fri = Date.parse("2026-11-13T13:00:00Z");
  assert.equal(I.callDay(at("2026-11-13T23:30:00Z"), tz, fri), "2026-11-16"); // viernes 20:30 → lunes
  assert.equal(I.callDay(at("2026-11-13T12:00:00Z"), tz, Date.parse("2026-11-13T22:00:00Z")), "2026-11-16"); // se procesa el viernes 19:00
  assert.equal(I.hoursLeft(at("2026-11-16T10:00:00Z"), Date.parse("2026-11-16T12:00:00Z")), 70);
  assert.ok(I.hoursLeft(at("2026-11-10T10:00:00Z"), mon10) < 0);
});
test("la nota lleva todo lo del mensaje (escapado) y el enlace a Slack", () => {
  const p = I.parseInbound(A.replace("Natanael", "Nata <b>"), { ts: "1" });
  const h = I.noteHtml(p, { by: "Facundo Morena", permalink: "https://ordereat.slack.com/archives/C0/p1" });
  assert.match(h, /Inbound desde Slack/); assert.match(h, /Meta Ads · campaña 120249217681380243/); assert.match(h, /Nata &lt;b&gt;/);
  assert.match(h, /\+5491155550000/); assert.match(h, /Realmente es muy chica/); assert.match(h, /Mensaje en Slack/);
});

// ---------- de punta a punta (Pipedrive y Slack de prueba)
const me = { email: "demo@example.com", name: "Demo", pdUserId: 1, pdName: "demo" };
const jd = { email: "juandiego@ordereat.com", name: "Juan Diego", pdUserId: 2, pdName: "Juan Diego" };
const byName = (l, n) => l.items.find(x => x.name === n);
const leadsTitled = async t => (await pd.searchItems(t, { types: "lead", fields: "title", limit: 50 })).items.map(i => i.item).filter(i => i.title === t);
const pendingCalls = async leadId => (await pd.activities({ leadId, done: false, limit: 100 })).filter(a => a.type === "call");

test("cada SDR ve solo los suyos (Slack de prueba: por email y por nombre); dirección ve todo", async () => {
  const mine = await IR.listFor(me, false);
  assert.ok(mine.items.length >= 8 && mine.items.every(x => x.mine && x.assignee.email === "demo@example.com"));
  assert.equal(mine.slack.demo, true); assert.ok(mine.pending >= 8);
  assert.ok(mine.notices.some(n => /^Carla Ejemplo \(Perú/.test(n.text)), JSON.stringify(mine.notices));
  const j = await IR.listFor(jd, false);
  assert.deepEqual(j.items.map(x => x.name).sort(), ["Marta Ejemplo", "Tomás Ejemplo"]);
  const ag = await IR.listFor({ email: "agustin@ordereat.com", pdUserId: 3 }, false);
  assert.deepEqual(ag.items.map(x => [x.name, x.assignee.how]), [["Sofía Ejemplo", "name"]]);
  const lider = await IR.listFor({ email: "lider@ordereat.com" }, { ids: new Set([2]), emails: new Set(["juandiego@ordereat.com"]) });
  assert.deepEqual(lider.items.map(x => x.name).sort(), ["Marta Ejemplo", "Tomás Ejemplo"]);
  const dir = await IR.listFor({ email: "ceo@ordereat.com" }, true);
  assert.equal(dir.items.length, mine.items.length + 3);
});

test("procesar: crea prospecto + persona + nota + UNA llamada; lo que ya está no se crea; lo de otro no se toca; dos veces no duplica", async () => {
  let r = await IR.processMine(me, { tz: "America/Mexico_City" });
  while (r.more) r = await IR.processMine(me, { tz: "America/Mexico_City" });
  const l = await IR.listFor(me, false);
  assert.equal(l.pending, 0);
  // nuevo de Meta Ads: prospecto a tu nombre, con fuente, país, SDR y teléfono; persona; nota; una llamada
  const pinos = byName(l, "Laura Prueba").state;
  assert.equal(pinos.status, "done"); assert.equal(pinos.created, true); assert.equal(pinos.title, "Colegio Los Pinos del Sur (Inbound Meta Ads)");
  const lead = await pd.getLead(pinos.id);
  assert.equal(lead.ownerId, 1); assert.equal(String(lead.fuenteOpt), "773"); assert.equal(String(lead.paisOpt), "93"); assert.equal(lead.phone, "+5491155550123");
  assert.ok(lead.personId);
  assert.ok((await pd.notesForLead(pinos.id, 5)).some(n => /Inbound desde Slack/.test(n.content) && /Queremos ordenar la cantina/.test(n.content)));
  const calls = await pendingCalls(pinos.id);
  assert.equal(calls.length, 1); assert.equal(calls[0].owner_id, 1); assert.equal(calls[0].subject, "Llamar · inbound Meta Ads · Laura Prueba"); assert.equal(calls[0].person_id, lead.personId);
  // «Colegio» basura: el título usa la persona; fuente orgánico
  const carla = byName(l, "Carla Ejemplo").state;
  assert.equal(carla.title, "Carla Ejemplo – 3080 (Inbound orgánico)"); assert.equal(String((await pd.getLead(carla.id)).fuenteOpt), "488");
  // revival: fuente «Inbound - SDR Meta Ads Revival»
  const rosa = byName(l, "Rosa Prueba").state;
  assert.equal(rosa.title, "Instituto Jacarandas (SDR revival)"); assert.equal(String((await pd.getLead(rosa.id)).fuenteOpt), "786");
  // ya estaba por teléfono (prospecto tuyo con llamada pendiente): no se crea otro ni otra llamada
  const maria = byName(l, "María Paredes").state;
  assert.equal(maria.status, "done"); assert.equal(maria.created, false); assert.equal(maria.id, "demo-lead-0"); assert.equal(maria.callExisting, true);
  assert.equal((await pendingCalls("demo-lead-0")).length, 1);
  // referido con link a un prospecto de la cuenta general: pasa a tu nombre y lleva la llamada
  const ana = byName(l, "Ana Ejemplo").state;
  assert.equal(ana.status, "done"); assert.equal(ana.id, DEMO.LEAD_FREE); assert.equal((await pd.getLead(DEMO.LEAD_FREE)).ownerId, 1);
  assert.equal((await pendingCalls(DEMO.LEAD_FREE)).length, 1);
  // link a un prospecto de Juan Diego: no se toca
  const pedro = byName(l, "Pedro Ejemplo").state;
  assert.equal(pedro.status, "theirs"); assert.equal(pedro.owner, "Juan Diego");
  assert.equal((await pd.getLead(DEMO.LEAD_THEIRS)).ownerId, 2); assert.equal((await pendingCalls(DEMO.LEAD_THEIRS)).length, 0);
  // el teléfono es de un cliente: no se contacta, no se crea nada
  const cuyo = byName(l, "Administración Cuyo").state;
  assert.equal(cuyo.status, "client"); assert.equal((await leadsTitled("Cuyo (Inbound Google Ads)")).length, 0);
  // el mismo nombre que un prospecto sin ciudad: se pregunta, no se crea
  const jorge = byName(l, "Jorge Ejemplo").state;
  assert.equal(jorge.status, "review"); assert.equal(jorge.candidates[0].title, "Colegio Monte Verde");
  assert.equal((await leadsTitled("Colegio Monte Verde (Inbound Meta Ads)")).length, 0);

  // otra vuelta (y otra más): nada nuevo
  const before = { pinos: (await leadsTitled("Colegio Los Pinos del Sur (Inbound Meta Ads)")).length, calls: (await pendingCalls(pinos.id)).length };
  const again = await IR.processMine(me, { tz: "America/Mexico_City", refresh: true });
  assert.equal(again.results.length, 0);
  const one = await IR.processOne(me, false, byName(l, "Laura Prueba").key, { tz: "America/Mexico_City" });
  assert.equal(one.state.status, "done");
  assert.equal((await leadsTitled("Colegio Los Pinos del Sur (Inbound Meta Ads)")).length, before.pinos);
  assert.equal(before.pinos, 1);
  assert.equal((await pendingCalls(pinos.id)).length, before.calls);
  // aunque se pida dos veces a la vez
  await Promise.all([IR.processOne(me, false, byName(l, "Rosa Prueba").key, {}), IR.processOne(me, false, byName(l, "Rosa Prueba").key, {})]);
  assert.equal((await leadsTitled("Instituto Jacarandas (SDR revival)")).length, 1);
});

test("«Es este» usa el que estaba (y no duplica la llamada); «Es otro» crea uno nuevo", async () => {
  const l = await IR.listFor(me, false), jorge = byName(l, "Jorge Ejemplo");
  const r = await IR.answerExisting(me, false, jorge.key, { pick: jorge.state.candidates[0].key });
  assert.equal(r.state.status, "done"); assert.equal(r.state.id, "demo-lead-2"); assert.equal(r.state.created, false); assert.equal(r.state.callExisting, true);
  await assert.rejects(IR.answerExisting(me, false, jorge.key, { none: true }), /ya no está para revisar/);
  // otro con el mismo nombre (y otro teléfono): «Es otro» crea uno nuevo y no lo vuelve a preguntar
  await IR.paste(me, "*Lead para llamar* — le toca a @\n*Teléfono:* +52 55 5555 0777\n*Nombre:* Otra Persona\n*Colegio:* Colegio Monte Verde\n*País:* México");
  let x = byName(await IR.listFor(me, false), "Otra Persona");
  assert.equal((await IR.processOne(me, false, x.key, {})).state.status, "review");
  const n = await IR.answerExisting(me, false, x.key, { none: true, tz: "America/Mexico_City" });
  assert.equal(n.state.status, "done"); assert.equal(n.state.created, true); assert.equal(n.state.title, "Colegio Monte Verde (Inbound)");
  assert.equal((await pendingCalls(n.state.id)).length, 1);
});

test("pegar un mensaje: se lee, queda para quien le toca y se procesa igual (sin repetir)", async () => {
  const txt = "Lead para llamar — le toca a @Demo SDR\nEste lead viene de PAUTA en Google Ads\nTeléfono: +52 81 5555 0404  ·  WhatsApp\nNombre: Pablo Pegado\nColegio: Colegio Pegado de Prueba\nPaís: México\nEmail: pablo@pegado-ejemplo.test\nPuesto: Director o directora\nMensaje: Me interesa";
  // «Demo SDR» no es el nombre de Pipedrive del usuario de prueba: con su preferencia de Slack sí es suyo
  await IR.setSlackPref(me, "Demo SDR");
  const p = await IR.paste(me, txt);
  assert.equal(p.added, 1);
  assert.equal((await IR.paste(me, txt)).added, 0);
  let l = await IR.listFor(me, false);
  const it = byName(l, "Pablo Pegado");
  assert.ok(it && it.pasted && it.mine && it.assignee.how === "pref");
  assert.equal(l.pending, 1);
  await IR.processMine(me, { tz: "America/Mexico_City" });
  l = await IR.listFor(me, false);
  const st = byName(l, "Pablo Pegado").state;
  assert.equal(st.status, "done"); assert.equal(st.title, "Colegio Pegado de Prueba (Inbound Google Ads)"); assert.equal(String((await pd.getLead(st.id)).fuenteOpt), "489");
  await assert.rejects(IR.paste(me, "hola, ¿alguien sabe del reparto?"), /No encontré ningún lead/);
});

test("para otra persona: un SDR no puede; su líder solo con «Crear a nombre de X» (a nombre del SDR); de otro equipo, 403", async () => {
  const l = await IR.listFor({ email: "ceo@ordereat.com" }, true), tomas = l.items.find(x => x.name === "Tomás Ejemplo");
  await assert.rejects(IR.processOne(me, false, tomas.key, {}), /No encontré ese lead/);
  const scope = { ids: new Set([2]), emails: new Set(["juandiego@ordereat.com"]) };
  await assert.rejects(IR.processOne({ email: "lider@ordereat.com", pdUserId: 1 }, scope, tomas.key, {}), e => e.status === 409 && /Crear a nombre de/.test(e.message));
  await assert.rejects(IR.processOne({ email: "lider@ordereat.com", pdUserId: 1 }, { ids: new Set([3]), emails: new Set(["agustin@ordereat.com"]) }, tomas.key, { as: "juandiego@ordereat.com" }), e => e.status === 404);
  const r = await IR.processOne({ email: "lider@ordereat.com", pdUserId: 1, name: "Líder" }, scope, tomas.key, { as: "juandiego@ordereat.com", tz: "America/Mexico_City" });
  assert.equal(r.state.status, "done"); assert.equal(r.state.for, "juandiego@ordereat.com");
  const lead = await pd.getLead(r.state.id);
  assert.equal(lead.ownerId, 2);
  assert.equal((await pendingCalls(r.state.id))[0].owner_id, 2);
  // lo procesado para otro no vuelve a pendiente de quien miraba
  assert.equal((await IR.listFor(jd, false)).items.find(x => x.name === "Tomás Ejemplo").state.status, "done");
});

test("un link a un prospecto que ya no está: se busca por teléfono y mail y se crea si no hay nada", async () => {
  const r = await IR.processMine(jd, { tz: "America/Mexico_City" });
  const marta = r.results.map(x => x.state).find(s => /Escuela Sol Naciente/.test(s.title));
  assert.equal(marta.status, "done"); assert.equal(marta.created, true);
  assert.ok(marta.warnings.some(w => /ya no está abierto/.test(w)));
  assert.equal((await pd.getLead(marta.id)).ownerId, 2);
});

test("READ_ONLY: procesar y responder escriben en Pipedrive (se bloquean); pegar y «Tu usuario de Slack» no", () => {
  assert.equal(writesPipedrive("POST", "/api/inbound/process"), true);
  assert.equal(writesPipedrive("POST", "/api/inbound/1794558598.00008/process"), true);
  assert.equal(writesPipedrive("POST", "/api/inbound/p0123456789abcdef/existing"), true);
  assert.equal(writesPipedrive("POST", "/api/Inbound/Process"), true);
  assert.equal(writesPipedrive("POST", "/api/inbound/paste"), false);
  assert.equal(writesPipedrive("POST", "/api/inbound/me"), false);
  assert.equal(writesPipedrive("GET", "/api/inbound"), false);
  assert.ok(DEAL_FIELDS.fuente);
});
