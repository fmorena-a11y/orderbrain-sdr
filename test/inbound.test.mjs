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

test("formato A (Lead para llamar de Meta Ads = SDR revival): campos, fuente, campaña, teléfono normalizado y mensaje de varias líneas", () => {
  const p = I.parseInbound(A, { ts: "1763302445.000100" });
  assert.equal(p.kind, "revival"); assert.equal(p.baseKind, "call"); assert.equal(p.kindLabel, "SDR revival · Meta Ads");
  assert.deepEqual(p.to, { slackId: "U0FACU0001", name: "Facu Morena" });
  assert.equal(p.source, "meta"); assert.equal(p.sourceLabel, "Meta Ads"); assert.equal(p.campaign, "120249217681380243");
  assert.equal(p.phone, "1155550000"); assert.equal(p.phoneE164, "+5491155550000"); assert.equal(p.country, "Argentina");
  assert.equal(p.email, "natanael.prueba@gmail.com"); assert.equal(p.name, "Natanael"); assert.equal(p.role, "Otro");
  assert.equal(p.message, "Que el ppff pague antes.\nRealmente es muy chica la cantina.");
  assert.match(p.filter, /puesto no decisor/); assert.equal(p.pd, null);
  assert.equal(I.leadTitleFor(p), "Natanael – 21 de José C. Paz (SDR Meta Ads Revival)");
  assert.equal(I.subjectFor(p), "Llamar · SDR revival Meta Ads · Natanael");
  assert.match(I.noteHtml(p), /<b>Tipo:<\/b> SDR revival · Meta Ads/);
});
test("SDR revival = Meta Ads: Google Ads, orgánico y referido quedan como están; lo pegado antes de la regla también pasa", () => {
  const g = I.parseInbound(A.replace("PAUTA en Meta Ads (Facebook/Instagram)", "PAUTA en Google Ads"), { ts: "2" });
  assert.equal(g.kind, "call"); assert.equal(g.source, "google"); assert.equal(g.kindLabel, "Lead para llamar");
  assert.equal(I.leadTitleFor(g), "Natanael – 21 de José C. Paz (Inbound Google Ads)"); assert.equal(I.subjectFor(g), "Llamar · inbound Google Ads · Natanael");
  const o = I.parseInbound(A.replace(/^:moneybag:.*$/m, ":seedling: Este lead es ORGÁNICO: entró directo a la web, sin UTM"), { ts: "3" });
  assert.equal(o.kind, "call"); assert.equal(o.source, "organic"); assert.match(I.leadTitleFor(o), /\(Inbound orgánico\)$/);
  assert.equal(I.parseInbound(B).kind, "referral");
  // un mensaje pegado y guardado con la lectura de antes (kind call, fuente meta)
  const old = { ...I.parseInbound(A), kind: "call", kindLabel: "Lead para llamar" }; delete old.baseKind;
  const r = I.asRevival(old);
  assert.equal(r.kind, "revival"); assert.equal(r.baseKind, "call"); assert.match(I.leadTitleFor(r), /\(SDR Meta Ads Revival\)$/);
  assert.equal(I.asRevival(g), g);
  // la clave de lo pegado no cambia con la regla (sale del tipo del mensaje)
  const txt = "Lead para llamar — le toca a @Facu Morena\nEste lead viene de PAUTA en Meta Ads\nTeléfono: 1155550000\nNombre: Natanael\nColegio: Prueba";
  const [k] = I.splitPasted(txt);
  assert.equal(k.kind, "revival");
  assert.equal(k.ts, I.splitPasted(txt)[0].ts);
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
  assert.equal(r.kind, "revival"); assert.equal(r.source, "meta"); assert.equal(r.kindLabel, "SDR revival · Meta Ads");
  assert.match(I.leadTitleFor(r), /\(SDR Meta Ads Revival\)$/); assert.match(I.subjectFor(r), /^Llamar · SDR revival Meta Ads · /);
  const solo = I.parseInbound("*SDR revival* — le toca a <@U9|Belu Bargen>\n*Teléfono:* +5215555550000\n*Nombre:* Ana");
  assert.equal(solo.kind, "revival"); assert.equal(solo.source, "revival"); assert.match(I.leadTitleFor(solo), /\(SDR Meta Ads Revival\)$/);
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
  // todo es personal: lo que falta (el aviso de Hoy) cuenta solo lo tuyo, también para dirección (que ve todo pero no tiene nada propio)
  assert.equal(dir.pending, 0); assert.ok(dir.items.every(x => !x.mine));
  assert.equal((await IR.pendingCount({ email: "ceo@ordereat.com" })).pending, 0);
  assert.equal((await IR.pendingCount(jd)).pending, 2);
  assert.equal((await IR.pendingCount(me)).pending, mine.pending);
  // procesar sin nada propio no toca lo de otros
  assert.deepEqual((await IR.processMine({ email: "ceo@ordereat.com", pdUserId: 1 }, {})).results, []);
});

test("procesar: crea prospecto + persona + nota + UNA llamada; lo que ya está no se crea; lo de otro no se toca; dos veces no duplica", async () => {
  let r = await IR.processMine(me, { tz: "America/Mexico_City" });
  while (r.more) r = await IR.processMine(me, { tz: "America/Mexico_City" });
  const l = await IR.listFor(me, false);
  assert.equal(l.pending, 0);
  // nuevo de Meta Ads (SDR revival): prospecto a tu nombre, con Fuente 786, país, SDR y teléfono; persona; nota; una llamada
  const pinos = byName(l, "Laura Prueba").state;
  assert.equal(pinos.status, "done"); assert.equal(pinos.created, true); assert.equal(pinos.title, "Colegio Los Pinos del Sur (SDR Meta Ads Revival)");
  const lead = await pd.getLead(pinos.id);
  assert.equal(lead.ownerId, 1); assert.equal(String(lead.fuenteOpt), "786"); assert.equal(String(lead.paisOpt), "93"); assert.equal(lead.phone, "+5491155550123");
  assert.ok(lead.personId);
  assert.ok((await pd.notesForLead(pinos.id, 5)).some(n => /Inbound desde Slack/.test(n.content) && /Queremos ordenar la cantina/.test(n.content)));
  const calls = await pendingCalls(pinos.id);
  assert.equal(calls.length, 1); assert.equal(calls[0].owner_id, 1); assert.equal(calls[0].subject, "Llamar · SDR revival Meta Ads · Laura Prueba"); assert.equal(calls[0].person_id, lead.personId);
  // «Colegio» basura: el título usa la persona; fuente orgánico
  const carla = byName(l, "Carla Ejemplo").state;
  assert.equal(carla.title, "Carla Ejemplo – 3080 (Inbound orgánico)"); assert.equal(String((await pd.getLead(carla.id)).fuenteOpt), "488");
  // revival: fuente «Inbound - SDR Meta Ads Revival»
  const rosa = byName(l, "Rosa Prueba").state;
  assert.equal(rosa.title, "Instituto Jacarandas (SDR Meta Ads Revival)"); assert.equal(String((await pd.getLead(rosa.id)).fuenteOpt), "786");
  // ya estaba por teléfono (prospecto tuyo con llamada pendiente): no se crea otro ni otra llamada; Fuente vacía → revival
  const maria = byName(l, "María Paredes").state;
  assert.equal(maria.status, "done"); assert.equal(maria.created, false); assert.equal(maria.id, "demo-lead-0"); assert.equal(maria.callExisting, true);
  assert.equal((await pendingCalls("demo-lead-0")).length, 1); assert.equal(String((await pd.getLead("demo-lead-0")).fuenteOpt), "786");
  // ya estaba, tuyo con otra Fuente (Cold calling): no se pisa; de la cuenta general con «Inbound - Meta Ads»: pasa a tu nombre y a 786
  const ines = byName(l, "Inés Ejemplo").state;
  assert.equal(ines.status, "done"); assert.equal(ines.created, false); assert.equal(ines.id, "7a1c0000-0000-4000-8000-00000000c001");
  assert.equal(String((await pd.getLead(ines.id)).fuenteOpt), "502"); assert.ok(ines.warnings.some(w => /otra Fuente/.test(w)));
  assert.equal((await pendingCalls(ines.id)).length, 1);
  const raul = byName(l, "Raúl Ejemplo").state;
  assert.equal(raul.status, "done"); assert.equal(raul.created, false);
  const nog = await pd.getLead("7a1c0000-0000-4000-8000-00000000c002");
  assert.equal(nog.ownerId, 1); assert.equal(String(nog.fuenteOpt), "786"); assert.ok(raul.done.some(d => /SDR Meta Ads Revival/.test(d.label)));
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
  assert.equal((await leadsTitled("Colegio Monte Verde (SDR Meta Ads Revival)")).length, 0);

  // otra vuelta (y otra más): nada nuevo
  const before = { pinos: (await leadsTitled("Colegio Los Pinos del Sur (SDR Meta Ads Revival)")).length, calls: (await pendingCalls(pinos.id)).length };
  const again = await IR.processMine(me, { tz: "America/Mexico_City", refresh: true });
  assert.equal(again.results.length, 0);
  const one = await IR.processOne(me, false, byName(l, "Laura Prueba").key, { tz: "America/Mexico_City" });
  assert.equal(one.state.status, "done");
  assert.equal((await leadsTitled("Colegio Los Pinos del Sur (SDR Meta Ads Revival)")).length, before.pinos);
  assert.equal(before.pinos, 1);
  assert.equal((await pendingCalls(pinos.id)).length, before.calls);
  // aunque se pida dos veces a la vez
  await Promise.all([IR.processOne(me, false, byName(l, "Rosa Prueba").key, {}), IR.processOne(me, false, byName(l, "Rosa Prueba").key, {})]);
  assert.equal((await leadsTitled("Instituto Jacarandas (SDR Meta Ads Revival)")).length, 1);
  assert.equal(String((await pd.getLead("7a1c0000-0000-4000-8000-00000000c001")).fuenteOpt), "502");
});

test("Ver historial: dónde quedó cada lead (targetOf) y el último contacto por tanda, solo de lo que podés ver", async () => {
  assert.deepEqual(I.targetOf({ status: "done", kind: "lead", id: "abc-1" }), { kind: "lead", id: "abc-1", orgId: null });
  assert.deepEqual(I.targetOf({ status: "done", kind: "deal", id: "7", orgId: 9 }), { kind: "deal", id: 7, orgId: 9 });
  assert.deepEqual(I.targetOf({ status: "partial", leadId: "abc-2" }), { kind: "lead", id: "abc-2", orgId: null });
  assert.deepEqual(I.targetOf({ status: "theirs", url: "https://x.pipedrive.com/leads/inbox/7a1c0000-0000-4000-8000-00000000b002" }), { kind: "lead", id: "7a1c0000-0000-4000-8000-00000000b002", orgId: null });
  assert.deepEqual(I.targetOf({ status: "client", url: "https://x.pipedrive.com/organization/921" }), { kind: "org", id: 921, orgId: null });
  assert.deepEqual(I.targetOf({ status: "theirs", url: "https://x.pipedrive.com/deal/55" }), { kind: "deal", id: 55, orgId: null });
  assert.equal(I.targetOf({ status: "review", candidates: [] }), null); assert.equal(I.targetOf(null), null);

  const l = await IR.listFor(me, false);
  // Patricia ya estaba en Pipedrive (por el teléfono) con historial: no se crea nada y la llamada pendiente es la que tenía
  const pat = byName(l, "Patricia Ejemplo");
  assert.equal(pat.state.status, "done"); assert.equal(pat.state.created, false); assert.equal(pat.state.callExisting, true);
  assert.deepEqual(pat.state.ref, { kind: "lead", id: "7a1c0000-0000-4000-8000-00000000d001", orgId: null });
  const jorge = byName(l, "Jorge Ejemplo"); assert.equal(jorge.state.ref, null); // para revisar: todavía no está en Pipedrive
  const laura = byName(l, "Laura Prueba"), pedro = byName(l, "Pedro Ejemplo");
  const r = await IR.contactsFor(me, false, [pat.key, laura.key, jorge.key, pedro.key, "no-existe"], { tz: "America/Mexico_City" });
  // la llamada atendida de ayer (con el resultado de Registrar en el asunto) y 3 contactos en total
  const P = r.items[pat.key].last;
  assert.equal(P.channel, "call"); assert.equal(P.result, "decisor: volver a llamar"); assert.equal(P.answered, true); assert.equal(P.n, 3);
  assert.equal(r.items[pat.key].stage.key, "maybe"); assert.equal(r.items[pat.key].stage.mine.late, false);
  assert.deepEqual(r.items[laura.key].last, { none: true }); // recién creado: sin contactos
  assert.equal(r.items[laura.key].stage.key, "new"); assert.ok(r.items[laura.key].stage.mine);
  assert.ok(!(jorge.key in r.items) && !("no-existe" in r.items));
  assert.equal(r.items[pedro.key].stage.key, "theirs"); // de Juan Diego, pero el lead te tocó a vos: se ve
  // Juan Diego no ve lo tuyo; un líder de tu equipo sí
  assert.deepEqual((await IR.contactsFor(jd, false, [pat.key], {})).items, {});
  assert.equal((await IR.contactsFor({ email: "lider@ordereat.com" }, { ids: new Set([1]), emails: new Set(["demo@example.com"]) }, [pat.key], {})).items[pat.key].last.answered, true);
  // el demo tiene uno en cada estado
  const keyOf = n => byName(l, n).key, names = ["Gabriel Ejemplo", "Lorena Ejemplo", "Hugo Ejemplo", "Marcela Ejemplo"];
  const all = await IR.contactsFor(me, false, names.map(keyOf), { tz: "America/Mexico_City" });
  const st = n => all.items[keyOf(n)]?.stage || byName(l, n).state;
  assert.deepEqual(names.map(n => st(n).key), ["noreply", "demo", "held", "out"], JSON.stringify(names.map(st)));
  assert.equal(st("Gabriel Ejemplo").mine.late, true); assert.equal(st("Marcela Ejemplo").detail, "Ya tiene un software del estilo");
  assert.match(st("Lorena Ejemplo").detail, /con Joaquín Márquez/); assert.match(st("Hugo Ejemplo").detail, /trato tuyo · PROPOSAL SENT/);
});

test("inboundStage: un estado por lead, en orden de prioridad, solo con lo que dicen Pipedrive y la app", async () => {
  const T = await import("../lib/timeline.js");
  const S = st => ({ state: { status: "done", ref: { kind: "lead", id: "L" }, ...st } });
  const call = (id, x) => ({ id, type: "call", subject: "Llamada", owner_id: 1, lead_id: "L", done: true, add_time: x.at, due_date: x.at.slice(0, 10), marked_as_done_time: x.at, ...x });
  const info = (x = {}) => ({ items: T.buildTimeline({ acts: x.acts || [], notes: x.notes || [], tz: "America/Mexico_City" }), pending: x.pending || [], lead: x.lead === undefined ? { archived: false } : x.lead, deals: x.deals || [], ownerId: 1, today: "2026-11-16", users: { 1: "Demo", 7: "Joaquín Márquez" }, stages: { 160: "SELLING", 159: "PROPOSAL SENT" } });
  // lo que no necesita Pipedrive
  assert.equal(I.inboundStage({ state: null }, null).key, "todo");
  assert.equal(I.inboundStage({ state: { status: "review" } }, null).key, "review");
  assert.equal(I.inboundStage({ state: { status: "theirs", owner: "Juan Diego" } }, null).detail, "de Juan Diego");
  assert.equal(I.inboundStage({ state: { status: "client" } }, null).key, "client");
  assert.equal(I.inboundStage(S(), null).key, "unknown"); // no se pudo leer: «Sin datos», nunca un estado inventado
  // sin contactos
  assert.equal(I.inboundStage(S(), info()).key, "new");
  // solo intentos sin respuesta (el resultado del asunto o la nota)
  const no = [call(1, { at: "2026-11-14T15:00:00Z", subject: "Llamada: No atendió · X" }), call(2, { at: "2026-11-15T15:00:00Z", note: "buzón de voz" })];
  const g = I.inboundStage(S(), info({ acts: no }));
  assert.equal(g.key, "noreply"); assert.equal(g.detail, "2 contactos"); assert.equal(g.label, "Contactado sin respuesta");
  // contestó y no dijo que no: posible demo (aunque después no atendiera)
  const yes = [...no, call(3, { at: "2026-11-13T15:00:00Z", subject: "Llamada: Pidió información · X" })];
  assert.equal(I.inboundStage(S(), info({ acts: yes })).key, "maybe");
  assert.equal(I.inboundStage(S(), info({ acts: [call(4, { at: "2026-11-13T15:00:00Z", type: "deadline", subject: "WhatsApp", note: "Respondió que el lunes puede" })] })).detail, "respondió · por whatsapp");
  // dijo que no: descartado con el motivo anotado (o el resultado)
  const neg = [call(5, { at: "2026-11-15T15:00:00Z", subject: "Llamada: No le interesa · X" })];
  assert.deepEqual([I.inboundStage(S(), info({ acts: neg })).key, I.inboundStage(S(), info({ acts: neg })).detail], ["out", "No le interesa"]);
  const negNote = [{ id: 9, lead_id: "L", add_time: "2026-11-15 15:01:00", user: { name: "Demo" }, content: "<b>Llamada · No le interesa</b><br><b>Motivo:</b> No es fit<br><i>Cargado por Demo desde OrderBrain SDR</i>" }];
  assert.equal(I.inboundStage(S(), info({ acts: neg, notes: negNote })).detail, "No es fit");
  // archivado (sin motivo) o trato perdido (con su motivo de Pipedrive)
  assert.equal(I.inboundStage(S(), info({ lead: { archived: true } })).detail, "Archivado sin motivo");
  assert.equal(I.inboundStage(S(), info({ deals: [{ id: 3, status: "lost", lost_reason: "Número equivocado", pipeline_id: 9 }] })).detail, "Número equivocado");
  // archivado porque pasó a trato: no es descarte
  const conv = [{ id: 10, lead_id: "L", add_time: "2026-11-15 15:01:00", content: "<b>Pasó a trato</b><br>Demo agendada desde OrderBrain SDR por Demo.<br><a href=\"x/deal/5\">Ver trato</a>" }];
  assert.equal(I.inboundStage(S(), info({ lead: { archived: true }, notes: conv })).key, "deal");
  // trato abierto (de quién) y demo agendada (gana a todo)
  const open = { id: 5, status: "open", pipeline_id: 9, stage_id: 159, owner_id: 7 };
  assert.equal(I.inboundStage(S(), info({ deals: [open], acts: no })).detail, "trato de Joaquín Márquez · PROPOSAL SENT");
  const demo = { id: 20, type: "meeting", owner_id: 7, due_date: "2026-11-19", due_time: "16:00", done: false, deal_id: 5 };
  const d = I.inboundStage(S(), info({ deals: [open], pending: [demo], lead: { archived: true } }));
  assert.equal(d.key, "demo"); assert.equal(d.detail, "2026-11-19 · con Joaquín Márquez");
  assert.equal(I.inboundStage(S(), info({ pending: [{ ...demo, due_date: "2026-11-10" }] })).key, "new"); // una demo vieja sin marcar no es «agendada»
  // ganado: cliente
  assert.equal(I.inboundStage(S(), info({ deals: [{ id: 6, status: "won", pipeline_id: 9 }] })).key, "client");
  // pendiente tuya (no la del account): la más cercana; vencida va primero (rank 0)
  const mine = I.inboundStage(S(), info({ pending: [{ id: 30, type: "call", owner_id: 1, due_date: "2026-11-15", subject: "Volver a llamar", done: false }, demo] }));
  assert.equal(mine.mine.late, true); assert.equal(mine.mine.date, "2026-11-15"); assert.equal(mine.rank, 0);
  assert.equal(I.inboundStage(S(), info({ pending: [demo] })).mine, undefined);
});

// Pipedrive guarda en UTC la fecha y la hora de una actividad con hora: 20:00 del 18/11 en México es 19/11 02:00
test("inboundStage: una pendiente con hora se ve y se marca vencida en la zona de quien mira", () => {
  const tz = "America/Mexico_City", S = { state: { status: "done", ref: { kind: "lead", id: "L" } } };
  const st = (pending, today, zone = tz) => I.inboundStage(S, { items: [], pending, deals: [], lead: { archived: false }, ownerId: 1, today, tz: zone, users: { 7: "Joaquín Márquez" }, stages: {} });
  const call = { id: 1, type: "call", owner_id: 1, subject: "Llamar", done: false, due_date: "2026-11-19", due_time: "02:00:00" };
  // mirando el 19/11 desde México: era de ayer a las 20:00 → vencida y primera
  const late = st([call], "2026-11-19");
  assert.deepEqual([late.mine.date, late.mine.time, late.mine.late, late.rank], ["2026-11-18", "20:00", true, 0]);
  // mirando el 18/11 desde México: es de hoy, no está vencida
  const now = st([call], "2026-11-18");
  assert.deepEqual([now.mine.date, now.mine.time, now.mine.late], ["2026-11-18", "20:00", false]); assert.notEqual(now.rank, 0);
  // la misma, mirando el 19/11 desde Madrid (03:00 del 19/11): tampoco
  assert.deepEqual([st([call], "2026-11-19", "Europe/Madrid").mine.date, st([call], "2026-11-19", "Europe/Madrid").mine.time, st([call], "2026-11-19", "Europe/Madrid").mine.late], ["2026-11-19", "03:00", false]);
  // sin hora, la fecha queda como está: del 19/11 es de hoy el 19/11 y vencida el 20/11
  const day = { ...call, due_time: null };
  assert.deepEqual([st([day], "2026-11-19").mine.date, st([day], "2026-11-19").mine.time, st([day], "2026-11-19").mine.late], ["2026-11-19", "", false]);
  assert.equal(st([day], "2026-11-20").mine.late, true);
  // la más cercana se elige por la hora local: la de las 20:00 del 18/11 va antes que una sin hora del 19/11
  assert.equal(st([{ ...day, id: 2, subject: "Sin hora" }, call], "2026-11-18").mine.subject, "Llamar");
  // demo «de hoy en adelante»: la de las 20:00 del 18/11 (19/11 02:00 UTC) ya no es «agendada» el 19/11; el 18/11 sí, con su día y hora
  const demo = { id: 3, type: "meeting", owner_id: 7, done: false, due_date: "2026-11-19", due_time: "02:00" };
  assert.equal(st([demo], "2026-11-19").key, "new");
  const d = st([demo], "2026-11-18");
  assert.deepEqual([d.key, d.date, d.time, d.detail], ["demo", "2026-11-18", "20:00", "2026-11-18 · con Joaquín Márquez"]);
  // y una demo de las 23:00 UTC del 18/11 vista desde Madrid (00:00 del 19/11) sigue agendada el 19/11
  assert.equal(st([{ ...demo, due_date: "2026-11-18", due_time: "23:00" }], "2026-11-19", "Europe/Madrid").key, "demo");
  // demo realizada: el día también es el de quien mira
  assert.equal(st([], "2026-11-19").key, "new");
  const held = I.inboundStage(S, { items: [], acts: [{ ...demo, done: true }], pending: [], deals: [], ownerId: 1, today: "2026-11-19", tz, users: { 7: "Joaquín Márquez" }, stages: {} });
  assert.deepEqual([held.key, held.date], ["held", "2026-11-18"]);
});

test("«Es este» usa el que estaba (y no duplica la llamada); «Es otro» crea uno nuevo", async () => {
  const l = await IR.listFor(me, false), jorge = byName(l, "Jorge Ejemplo");
  const r = await IR.answerExisting(me, false, jorge.key, { pick: jorge.state.candidates[0].key });
  assert.equal(r.state.status, "done"); assert.equal(r.state.id, "demo-lead-2"); assert.equal(r.state.created, false); assert.equal(r.state.callExisting, true);
  assert.equal(String((await pd.getLead("demo-lead-2")).fuenteOpt), "786");
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

// demo ya realizada y no show (pedido del líder: separar por demo realizada)
test("inboundStage: demo realizada, no show y trato perdido después de la demo", async () => {
  const { inboundStage } = await import("../lib/inbound.js");
  const base = { items: [], pending: [], deals: [], ownerId: 1, today: "2026-11-16", users: { 2: "Joaquín" }, stages: {} };
  const meet = (x = {}) => ({ id: 1, type: "meeting", done: true, due_date: "2026-11-10", owner_id: 2, ...x });
  const s = info => inboundStage({ state: { status: "done" } }, { ...base, ...info });
  assert.equal(s({ acts: [meet()] }).key, "held");
  assert.match(s({ acts: [meet()] }).detail, /con Joaquín/);
  assert.equal(s({ acts: [meet({ type: "lunch" })] }).key, "noshow");
  assert.equal(s({ acts: [meet({ done: false, note: "[Resultado de la demo] No se presentó · marcado por X desde OrderBrain SDR el 10/11" })] }).key, "noshow");
  assert.equal(s({ acts: [meet()], deals: [{ id: 9, status: "lost", lost_reason: "No es fit" }] }).key, "out");
  assert.equal(s({ acts: [meet()], pending: [{ type: "meeting", done: false, due_date: "2026-11-20", owner_id: 2 }] }).key, "demo");
  assert.equal(s({ acts: [] }).key, "new");
});
