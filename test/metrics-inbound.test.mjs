// Métricas › Inbound (lib/metrics.js inboundSummary): prospectos y tratos con Fuente inbound que entraron en el período, sus
// contactos (con resultado solo donde está escrito) y en qué terminaron. Lo que no se sabe es «?» (null).
import test from "node:test";
import assert from "node:assert/strict";
import * as M from "../lib/metrics.js";
import { OUTCOMES } from "../lib/playbook.js";
import { FUENTE_LABELS, LOST_REASONS } from "../lib/config.js";

const TZ = "America/Montevideo"; // UTC-3
const period = { from: "2026-11-01", to: "2026-11-16", days: 16, kind: "mes" };
const NOW = Date.parse("2026-11-16T21:00:00Z");
const users = [{ id: 1, name: "Lucía", email: "l@x.com" }, { id: 2, name: "Facundo", email: "f@x.com" }, { id: 7, name: "Joaquín", email: "j@x.com" }];
const free = new Set([99]);
const labels = new Map(Object.entries(FUENTE_LABELS).map(([id, l]) => [String(id), l]));
const ids = { meta: 773, google: 489, organic: 488, referral: 492, revival: 786 };
const kindsOf = v => M.inboundKinds(v, { ids, labels });
const base = { period, tz: TZ, now: NOW, users, free, sales: new Set([1, 9, 29]), kindsOf, outcomes: OUTCOMES, lostReasons: LOST_REASONS };
// UUID v1 de un prospecto creado en ese momento (como los de Pipedrive)
const uuid = when => { const t = BigInt(Date.parse(when)) * 10000n + 122192928000000000n, h = (x, w) => x.toString(16).padStart(w, "0");
  return `${h(t & 0xffffffffn, 8)}-${h((t >> 32n) & 0xffffn, 4)}-1${h((t >> 48n) & 0xfffn, 3)}-8000-000000000001`; };

test("la hora de creación sale del id del prospecto (UUID v1), al milisegundo", () => {
  // casos de la cuenta real: «Maria Luisa (SDR Meta Ads Revival)» se creó el 2026-11-16T20:19:45.927Z
  assert.equal(M.uuidTime("10c03970-e1fb-11f1-9b23-c1202d0f9083"), "2026-11-16T20:19:45.927Z");
  assert.equal(M.uuidTime("3ada9500-d64f-11f1-ae0f-adad1dcb5000"), "2026-11-01T23:52:00.336Z");
  assert.equal(M.uuidTime(uuid("2026-11-03T12:00:00.000Z")), "2026-11-03T12:00:00.000Z");
  // otra versión o algo que no es un UUID: no se sabe
  assert.equal(M.uuidTime("26d0f710-e1c2-41f1-9b23-c1202d0f9083"), null);
  assert.equal(M.uuidTime("demo-lead-1"), null);
  assert.equal(M.uuidTime(null), null);
});

test("tipos de inbound por la opción de la Fuente", () => {
  assert.deepEqual(kindsOf("786"), { kinds: ["revival"], mixed: false });
  assert.deepEqual(kindsOf([773]), { kinds: ["meta"], mixed: false });
  assert.deepEqual(kindsOf("786,773"), { kinds: ["revival", "meta"], mixed: false }); // las dos pestañas; en «todos», una vez
  assert.deepEqual(kindsOf([502, 786]), { kinds: ["revival"], mixed: true }); // también outbound: se avisa
  assert.deepEqual(kindsOf("491"), { kinds: ["other"], mixed: false }); // «Inbound - Referral de Colegio»
  assert.equal(kindsOf("502"), null); // outbound
  assert.equal(kindsOf("494"), null); // «Otro»
  assert.equal(kindsOf(null), null);
  assert.equal(kindsOf([{ id: 489, label: "Inbound - Búsqueda en Google" }]).kinds[0], "google"); // con include_option_labels
});

test("resultado de un contacto: solo el asunto de Registrar o el tipo de Aircall", () => {
  const r = (subject, type = "call") => M.contactResult({ subject, type }, OUTCOMES);
  assert.equal(r("Llamada: No atendió · Colegio X"), "noanswer");
  assert.equal(r("WhatsApp: Atendió recepción · Colegio X", "deadline"), "answered");
  assert.equal(r("Llamada: Demo agendada · Colegio X"), "answered");
  assert.equal(r("Llamada: No le interesa · Colegio X"), "answered");
  assert.equal(r("Llamada: Dato erróneo · Colegio X"), "bad");
  assert.equal(r("Llamada"), null); // cargada a mano: no se sabe
  assert.equal(r("Mail: «¿Pudiste verlo?»", "task"), null); // no es un resultado de la lista
  assert.equal(r("Llamada: na mande wpp · X"), null);
  assert.equal(r("Outbound unanswered call on Lucia", "aircall_outbound_unanswere"), "noanswer");
  assert.equal(r("Outbound answered call", "aircall_outbound_answered_call"), "answered");
  assert.ok(M.isContact({ type: "deadline" }) && M.isContact({ type: "email" }) && M.isContact({ type: "aircall_outbound_unanswere" }));
  assert.ok(!M.isContact({ type: "meeting" }) && !M.isContact({ type: "tarea_interna" }));
});

const lead = (id, add_time, extra = {}) => ({ id, title: `Prospecto ${id}`, add_time, owner_id: 1, sdr: 1, fuente: "786", archived: false, source_deal_id: null, ...extra });
const deal = (id, add_time, extra = {}) => ({ id, title: `Trato ${id}`, add_time, source_lead_id: null, status: "open", pipeline_id: 9, stage_id: 159, owner_id: 7, sdr: 1, fuente: [786], lost_reason: null, ...extra });
const done = (id, extra) => ({ id, type: "call", subject: "Llamada", done: true, done_time: "2026-11-05T15:00:00Z", due_date: "2026-11-05", due_time: "", ...extra });

test("embudo: entradas, contactados, contestó / no contestó / sin resultado, demos y tratos", () => {
  const L1 = uuid("2026-11-04T13:00:00Z"), L2 = uuid("2026-10-20T13:00:00Z");
  const leads = [
    lead("a", "2026-11-05T12:00:00Z"), // contestó (resultado de la app)
    lead("b", "2026-11-05T12:00:00Z"), // no contestó (Aircall y «No atendió»)
    lead("c", "2026-11-06T12:00:00Z"), // sin resultado (llamada cargada a mano)
    lead("d", "2026-11-06T12:00:00Z", { archived: true }), // dato erróneo, archivado
    lead("e", "2026-11-07T12:00:00Z", { sdr: null, owner_id: 2 }), // sin contactar; el SDR vacío: cuenta el dueño
    lead("f", "2026-11-01T02:00:00Z"), // el 31/10 a las 23 en Montevideo: fuera del período
    lead("g", "2026-11-08T12:00:00Z", { fuente: "502" }), // outbound: no es inbound
    lead("h", "2026-11-08T12:00:00Z", { fuente: null }), // sin Fuente: aparte
    lead("i", "2026-11-16T12:00:00Z", { source_deal_id: 5636 }), // volvió de un trato: no es una entrada nueva
  ];
  const deals = [
    deal(10, "2026-11-04T14:00:00Z", { source_lead_id: L1, status: "won" }), // entró el 4 (su prospecto); demo hecha
    deal(11, "2026-11-05T14:00:00Z", { source_lead_id: L2, status: "lost" }), // su prospecto es de octubre: no entró en el período
    deal(12, "2026-11-06T14:00:00Z", { status: "lost", lost_reason: "No es fit", fuente: [773], sdr: null, owner_id: 7 }), // Meta Ads con No Show, sin contactar
    deal(13, "2026-11-06T14:00:00Z", { pipeline_id: 16 }), // ONBOARDING: no es de venta
    deal(14, "2026-11-07T14:00:00Z", { source_lead_id: "no-es-uuid" }), // no se sabe cuándo entró
  ];
  const acts = [
    done(1, { lead_id: "a", subject: "Llamada: Pidió información · Prospecto a", done_time: "2026-11-05T13:30:00Z" }),
    done(2, { lead_id: "b", type: "aircall_outbound_unanswere", done_time: "2026-11-05T12:30:00Z" }),
    done(3, { lead_id: "b", subject: "Llamada: No atendió · Prospecto b", done_time: "2026-11-05T14:00:00Z" }),
    done(4, { lead_id: "c", done_time: "2026-11-06T16:00:00Z" }),
    done(5, { lead_id: "d", subject: "Llamada: Dato erróneo · Prospecto d", done_time: "2026-11-06T13:00:00Z" }),
    { id: 6, lead_id: "e", type: "call", subject: "Llamar", done: false, due_date: "2026-11-17" }, // pendiente: no es un contacto
    done(7, { lead_id: "e", type: "meeting", done: false }), // una demo sin hacer tampoco es un contacto (pero es demo agendada)
    done(8, { deal_id: 10, type: "deadline", subject: "WhatsApp", done_time: "2026-11-04T13:00:00Z" }), // hecha antes de entrar: 0 h
    done(9, { lead_id: "i", done_time: "2026-11-16T15:00:00Z" }), // el que volvió, llamado después
    done(30, { deal_id: 10, done_time: "2026-11-04T12:59:30Z" }), // 30 s antes de entrar: se creó junto con el prospecto (no es «de antes»)
    done(31, { lead_id: "c", done_time: "2026-10-01T10:00:00Z" }), // c ya tenía un contacto de octubre (venía de otro prospecto o trato)
  ];
  const demos = [
    { id: 20, type: "meeting", deal_id: 10, done: true, mark: "done", due_date: "2026-11-06", due_time: "15:00" },
    { id: 21, type: "lunch", deal_id: 12, done: true, due_date: "2026-11-07", due_time: "" },
    { id: 7, type: "meeting", lead_id: "e", done: false, due_date: "2026-11-20", due_time: "" }, // la misma de acts (vale esta)
  ];
  const r = M.inboundSummary({ ...base, leads, deals, acts, demos });
  const T = r.kinds.all.totals;
  assert.deepEqual({ entries: T.entries, leads: T.leads, deals: T.deals }, { entries: 7, leads: 5, deals: 2 });
  assert.deepEqual({ contacted: T.contacted, notContacted: T.notContacted }, { contacted: 5, notContacted: 2 });
  assert.deepEqual({ answered: T.answered, answeredDemo: T.answeredDemo, noanswer: T.noanswer, bad: T.bad, noResult: T.noResult }, { answered: 2, answeredDemo: 1, noanswer: 1, bad: 1, noResult: 1 });
  assert.deepEqual({ demo: T.demo, demoDone: T.demoDone, noshow: T.noshow }, { demo: 3, demoDone: 1, noshow: 1 });
  assert.deepEqual({ won: T.won, lost: T.lost, open: T.open, leadOpen: T.leadOpen, leadArchived: T.leadArchived }, { won: 1, lost: 1, open: 0, leadOpen: 4, leadArchived: 1 });
  // horas hasta el primer contacto: a 1,5 · b 0,5 · d 1 · trato 10 0 (30 s antes de entrar) → mediana 0,75; c no entra (contacto de antes)
  assert.equal(T.ttfHours, 0.8); assert.equal(T.ttfN, 4); assert.equal(T.earlier, 1);
  assert.deepEqual(r.kinds.meta.totals.entries, 1); assert.deepEqual(r.kinds.meta.lostReasons, [{ key: "No es fit", n: 1 }]);
  assert.equal(r.kinds.revival.totals.entries, 6);
  assert.equal(r.noFuente, 1); assert.equal(r.unknownEntry, 1);
  assert.deepEqual(r.kinds.all.back, { n: 1, contacted: 1 }); assert.deepEqual(r.kinds.meta.back, { n: 0, contacted: 0 });
  // sin contactar, los más viejos primero (con su persona); por persona: el SDR, o el dueño si está vacío
  assert.deepEqual(r.kinds.all.pending.map(p => [p.id, p.person]), [["12", "Joaquín"], ["e", "Facundo"]].map(([id, n]) => [isNaN(id) ? id : Number(id), n]));
  assert.deepEqual(r.kinds.all.people.map(p => [p.name, p.entries, p.contacted]), [["Facundo", 1, 0], ["Joaquín", 1, 0], ["Lucía", 5, 5]]);
  assert.equal(T.ownerAsSdr, 2);
});

test("con equipo: solo lo que tiene de dueño o de SDR a su gente; por persona, solo su gente", () => {
  const team = { ids: new Set([2]), emails: new Set(["f@x.com"]) };
  const leads = [lead("a", "2026-11-05T12:00:00Z"), lead("b", "2026-11-05T12:00:00Z", { owner_id: 2 }), lead("c", "2026-11-05T12:00:00Z", { sdr: 2, owner_id: 7 })];
  const r = M.inboundSummary({ ...base, team, leads, deals: [], acts: [], demos: [] });
  assert.equal(r.kinds.all.totals.entries, 2); // b (dueño Facundo, SDR Lucía) y c (SDR Facundo)
  assert.deepEqual(r.kinds.all.people.map(p => [p.name, p.entries]), [["Facundo", 1]]); // b va a Lucía (su SDR), que no es del equipo
});

test("lista cortada o lectura que falló: «?» en lo que depende de ella, nunca 0", () => {
  const leads = [lead("a", "2026-11-05T12:00:00Z")], acts = [done(1, { lead_id: "a" })];
  const c = M.inboundSummary({ ...base, leads, deals: [], acts, demos: [], partial: { acts: true } }).kinds.all.totals;
  assert.equal(c.entries, 1); assert.equal(c.contacted, null); assert.equal(c.notContacted, null); assert.equal(c.ttfHours, null); assert.equal(c.answered, null);
  const d = M.inboundSummary({ ...base, leads, deals: [], acts, demos: [], partial: { demos: true } }).kinds.all.totals;
  assert.equal(d.contacted, 1); assert.equal(d.demo, null); assert.equal(d.answered, null); assert.equal(d.noResult, null);
  const e = M.inboundSummary({ ...base, leads, deals: [], acts, demos: [], partial: { leads: true } });
  assert.equal(e.kinds.all.totals.entries, null); assert.equal(e.kinds.all.totals.won, null); assert.equal(e.noFuente, null); assert.deepEqual(e.kinds.all.back, { n: null, contacted: null });
});

test("qué ve cada uno: totales y lo tuyo; por persona y los sin contactar, solo en people", () => {
  const r = { period, tz: TZ, at: {}, partial: {}, ...M.inboundSummary({ ...base, leads: [lead("a", "2026-11-05T12:00:00Z"), lead("b", "2026-11-05T12:00:00Z", { sdr: 2, owner_id: 2 })], deals: [], acts: [], demos: [] }) };
  const v = M.splitView("inbound", r, { me: 2 });
  assert.equal(v.pub.kinds.all.totals.entries, 2);
  assert.equal(v.pub.kinds.all.mine.entries, 1);
  assert.equal(v.pub.kinds.all.people, undefined); assert.equal(v.pub.kinds.all.pending, undefined);
  assert.equal(v.people.kinds.all.people.length, 2); assert.equal(v.people.kinds.all.pending.length, 2);
});
