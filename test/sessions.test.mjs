// Sesiones activas (lib/sessions.js): resumen por canal, qué falta, retomar salteando lo trabajado, límites y guardado por persona.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
for (const k of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "PIPEDRIVE_API_TOKEN", "DEMO_MODE"]) delete process.env[k];
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ob-test-"));
const ss = await import("../lib/sessions.js");

const T0 = Date.parse("2026-11-10T13:00:00Z");
const mk = (n = 6, extra = {}) => ss.newSession({ name: "Puebla", origin: { kind: "zone", key: "zone:puebla", filters: { zona: "Puebla" } },
  items: Array.from({ length: n }, (_, i) => ({ ref: `col-${i}`, act: i < 2 ? 100 + i : null, type: i < 2 ? "call" : null, name: `Colegio ${i}`, city: "Puebla" })), ...extra }, T0, "s1");
const contact = (ref, channel, outcome, extra = {}) => ss.contactStep(ref, { channel, outcome, connected: outcome !== "no_answer", by: "ana@ordereat.com", byName: "Ana Pérez", ...extra });

test("newSession: limpia los colegios (sin repetidos ni ids raros), guarda el origen y empieza en 0", () => {
  const s = ss.newSession({ name: "  Puebla  ", origin: { kind: "zone", key: "zone:puebla", filters: { zona: "Puebla", raro: { a: 1 }, territorio: ["México", 3, {}], vacío: "" } },
    items: [{ ref: "a", act: "12", type: "call", name: "Uno" }, { ref: "a" }, { ref: "lead:9f1-2", type: "nada" }, { ref: "<script>" }, { ref: "" }] }, T0, "x");
  assert.equal(s.name, "Puebla");
  assert.deepEqual(s.items.map(i => i.ref), ["a", "lead:9f1-2"]);
  assert.equal(s.items[0].act, 12); assert.equal(s.items[1].type, null);
  assert.deepEqual(s.origin, { kind: "zone", key: "zone:puebla", filters: { zona: "Puebla", territorio: ["México", "3"] } });
  assert.equal(s.pos, 0); assert.equal(s.status, "open"); assert.equal(s.createdAt, new Date(T0).toISOString());
  assert.throws(() => ss.newSession({ items: [] }), /No hay colegios/);
  assert.equal(ss.newSession({ items: [{ ref: "a" }], origin: { kind: "otra" } }).origin.kind, "list");
  assert.equal(ss.newSession({ items: Array.from({ length: 400 }, (_, i) => ({ ref: `c${i}` })) }).items.length, ss.MAX_ITEMS);
});

test("resumen por canal: cada contacto cuenta, con demos, comentarios y salteados", () => {
  const s = mk(8);
  assert.equal(ss.channelSummary(ss.sessionStats(s)), "");
  ss.addStep(s, contact("col-0", "call", "no_answer"), T0 + 1e3);
  ss.addStep(s, contact("col-0", "whatsapp", "info"), T0 + 2e3); // mismo colegio: dos contactos
  ss.addStep(s, contact("col-1", "call", "demo", { demo: { date: "2026-11-12", time: "10:00" } }), T0 + 3e3);
  ss.addStep(s, contact("col-2", "mail", "info"), T0 + 4e3);
  ss.addStep(s, contact("col-3", "call", "callback"), T0 + 5e3);
  ss.addStep(s, ss.commentStep("col-4", { next: { type: "call", date: "2026-11-11" } }), T0 + 6e3);
  ss.addSkip(s, { ref: "col-5", reason: "client" }, T0 + 7e3);
  const st = ss.sessionStats(s);
  assert.deepEqual(st.byChannel, { call: 3, whatsapp: 1, mail: 1, visit: 0 });
  assert.equal(st.contacts, 5); assert.equal(st.demos, 1); assert.equal(st.comments, 1); assert.equal(st.connected, 4);
  assert.deepEqual([st.total, st.worked, st.skipped, st.handled, st.pending], [8, 5, 1, 6, 2]);
  assert.equal(ss.channelSummary(st), "3 llamadas · 1 WhatsApp · 1 mail · 1 demo agendada · 1 comentario · 1 salteado");
  assert.equal(ss.channelSummary({ byChannel: { call: 1, whatsapp: 3, mail: 2, visit: 1 }, demos: 2, comments: 0, skipped: 0 }), "1 llamada · 3 WhatsApp · 2 mails · 1 visita · 2 demos agendadas");
});

test("qué falta: lo que no se trabajó ni se salteó; un salteado que después se trabaja cuenta como trabajado", () => {
  const s = mk(5);
  ss.addSkip(s, { ref: "col-1", reason: "manual" }, T0);
  ss.addStep(s, contact("col-3", "call", "no_answer"), T0);
  assert.deepEqual(ss.pendingItems(s).map(i => i.ref), ["col-0", "col-2", "col-4"]);
  ss.addStep(s, contact("col-1", "call", "info"), T0 + 1);
  assert.equal(ss.itemStates(s).get("col-1"), "worked");
  // lo trabajado no se saltea después, y un salteo no se repite
  assert.equal(ss.addSkip(s, { ref: "col-3", reason: "owner", why: "es de Juan" }, T0), false);
  assert.equal(ss.addSkip(s, { ref: "col-4", reason: "inventado" }, T0), false);
  assert.equal(ss.addSkip(s, { ref: "col-4", reason: "owner", why: "es de Juan" }, T0), true);
  assert.equal(ss.addSkip(s, { ref: "col-4", reason: "manual" }, T0), false);
  assert.equal(s.steps.at(-1).why, "es de Juan");
  // un colegio que no es de la sesión no se anota
  assert.equal(ss.addStep(s, contact("otro", "call", "info"), T0), false);
  const v = ss.view(s);
  assert.deepEqual(v.items.map(i => i.state), ["pending", "worked", "pending", "worked", "skipped"]);
  assert.equal(v.stats.pending, 2);
});

test("retomar: donde quedó, salteando lo trabajado; si adelante no falta nada, el primero que falte; -1 si está todo", () => {
  const s = mk(6);
  assert.equal(ss.resumeIndex(s), 0);
  s.pos = 2; ss.addStep(s, contact("col-2", "call", "no_answer"), T0); ss.addSkip(s, { ref: "col-3", reason: "client" }, T0);
  assert.equal(ss.resumeIndex(s), 4); // quedó en 2 (trabajado) y 3 (salteado): sigue en 4
  ss.addStep(s, contact("col-4", "call", "info"), T0); ss.addStep(s, contact("col-5", "mail", "info"), T0);
  assert.equal(ss.resumeIndex(s), 0); // adelante no queda nada: vuelve al primero que falta
  ss.addStep(s, contact("col-0", "call", "info"), T0); ss.addSkip(s, { ref: "col-1", reason: "manual" }, T0);
  assert.equal(ss.resumeIndex(s), -1);
  assert.equal(ss.view(s).resume, -1);
  s.pos = 99; assert.equal(ss.resumeIndex({ ...s, steps: [] }), 5); // posición fuera de rango: la última
});

test("applyPatch: posición válida, saltear con motivo, terminar (completa o a mano) y reabrir", () => {
  const s = mk(3);
  assert.equal(ss.applyPatch(s, { pos: 2 }, T0 + 60e3), true); assert.equal(s.pos, 2); assert.equal(s.updatedAt, new Date(T0 + 60e3).toISOString());
  assert.throws(() => ss.applyPatch(s, { pos: 3 }), /Posición inválida/);
  assert.throws(() => ss.applyPatch(s, { pos: -1 }), /Posición inválida/);
  assert.throws(() => ss.applyPatch(s, { status: "borrada" }), /Estado inválido/);
  assert.equal(ss.applyPatch(s, { skip: { ref: "col-0", reason: "archived" } }, T0), true);
  assert.equal(ss.applyPatch(s, { status: "done", reason: "completa" }, T0 + 120e3), true);
  assert.equal(s.status, "done"); assert.equal(s.endReason, "completa");
  assert.equal(ss.applyPatch(s, { status: "done" }), false); // ya estaba terminada
  assert.equal(ss.applyPatch(s, { status: "open" }, T0 + 180e3), true);
  assert.equal(s.status, "open"); assert.equal(s.endedAt, undefined);
  ss.applyPatch(s, { status: "done" }); assert.equal(s.endReason, "terminada");
});

test("prune y límite: terminadas 14 días, abiertas quietas 30 días, máximo de abiertas", () => {
  const day = 864e5, at = d => new Date(T0 - d * day).toISOString();
  const list = [
    { id: "a", status: "done", endedAt: at(15), updatedAt: at(20) },
    { id: "b", status: "done", endedAt: at(13), updatedAt: at(13) },
    { id: "c", status: "open", updatedAt: at(31) },
    { id: "d", status: "open", updatedAt: at(1) },
  ];
  const { keep, drop, changed } = ss.prune(list, T0);
  assert.deepEqual(drop, ["a"]);
  assert.deepEqual(keep.map(s => s.id), ["b", "c", "d"]);
  assert.deepEqual(changed.map(s => [s.id, s.status, s.endReason]), [["c", "done", "inactiva"]]);
  const open = Array.from({ length: 12 }, (_, i) => ({ id: `o${i}`, status: "open", updatedAt: at(12 - i) }));
  assert.deepEqual(ss.overLimit(open).map(s => s.id), ["o0"]); // la de menos movimiento deja lugar a la nueva
  assert.deepEqual(ss.overLimit(open.slice(0, 11)), []);
});

test("contactStep y commentStep: canal conocido, próximo paso válido, con quién habló", () => {
  const c = ss.contactStep("lead:abc", { channel: "fax", outcome: "info", connected: true, next: { type: "call", date: "2026-11-11", time: "9:5", ownerId: "3" }, demo: { date: "x" }, contact: { name: "Laura Gómez", role: "Directora" }, by: "a@b.c", byName: "Ana", schoolId: "pd-lead-abc" });
  assert.equal(c.channel, "call"); assert.equal(c.who, "Laura Gómez (Directora)");
  assert.deepEqual(c.next, { type: "call", date: "2026-11-11", time: "", ownerId: 3 });
  assert.equal(c.demo, null); assert.equal(c.schoolId, "pd-lead-abc");
  assert.equal(ss.contactStep("a", { channel: "mail", outcome: "info", next: { type: "inventado", date: "2026-11-11" }, schoolId: "a" }).next, null);
  assert.equal(ss.contactStep("a", { channel: "mail", outcome: "info", schoolId: "a" }).schoolId, undefined);
  assert.deepEqual(ss.commentStep("a", { next: { type: "task", date: "2026-11-12", auto: true } }).next, { type: "task", date: "2026-11-12", time: "", auto: true });
});

test("guardado por persona: crear, mismo origen, reemplazar, anotar, mover, terminar, borrar; nadie ve las de otro", async () => {
  const items = [{ ref: "col-a", name: "A" }, { ref: "col-b", name: "B" }, { ref: "col-c", name: "C" }];
  const r1 = await ss.createFor("Ana@OrderEAT.com", { name: "Puebla", origin: { kind: "zone", key: "zone:puebla" }, items }, T0);
  assert.ok(r1.session.id); assert.deepEqual(r1.bumped, []);
  // mismo origen abierto: se ofrece retomarla en vez de crear otra
  const again = await ss.createFor("ana@ordereat.com", { name: "Puebla", origin: { kind: "zone", key: "zone:puebla" }, items }, T0 + 1);
  assert.equal(again.existing.id, r1.session.id); assert.equal(again.session, undefined);
  // otra persona no la ve
  assert.deepEqual((await ss.listFor("juan@ordereat.com", T0)).open, []);
  await assert.rejects(ss.getFor("juan@ordereat.com", r1.session.id), /No encontré/);
  await assert.rejects(ss.updateFor("juan@ordereat.com", r1.session.id, { status: "done" }), /No encontré/);
  assert.equal(await ss.recordFor("juan@ordereat.com", r1.session.id, contact("col-a", "call", "info")), null);
  // anotar un contacto y moverse
  const v = await ss.recordFor("ana@ordereat.com", r1.session.id, contact("col-a", "whatsapp", "info"), T0 + 60e3);
  assert.equal(v.stats.worked, 1); assert.equal(v.summary, "1 WhatsApp");
  assert.equal(await ss.recordFor("ana@ordereat.com", r1.session.id, contact("col-x", "call", "info")), null); // no es de la sesión
  const u = await ss.updateFor("ana@ordereat.com", r1.session.id, { pos: 1, skip: { ref: "col-b", reason: "owner", why: "es de Juan Diego" } }, T0 + 120e3);
  assert.equal(u.session.pos, 1); assert.equal(u.session.resume, 2); assert.equal(u.session.stats.pending, 1);
  // otra de hoy, y reemplazar la de Puebla: la vieja queda en terminadas
  await ss.createFor("ana@ordereat.com", { name: "Tu día", origin: { kind: "today", key: "today:2026-11-10" }, items }, T0 + 130e3);
  const r2 = await ss.createFor("ana@ordereat.com", { name: "Puebla", origin: { kind: "zone", key: "zone:puebla" }, items, replace: r1.session.id }, T0 + 140e3);
  const L = await ss.listFor("ana@ordereat.com", T0 + 150e3);
  assert.deepEqual(L.open.map(s => s.name), ["Puebla", "Tu día"]); // la más reciente primero
  assert.equal(L.open[0].id, r2.session.id);
  assert.deepEqual(L.done.map(s => [s.id, s.endReason, s.stats.worked]), [[r1.session.id, "reemplazada", 1]]);
  // borrar una terminada; a las 14 días las terminadas se van solas
  assert.deepEqual(await ss.deleteFor("ana@ordereat.com", r1.session.id), { ok: true });
  await assert.rejects(ss.deleteFor("ana@ordereat.com", r1.session.id), /No encontré/);
  await ss.updateFor("ana@ordereat.com", r2.session.id, { status: "done" }, T0 + 160e3);
  assert.equal((await ss.listFor("ana@ordereat.com", T0 + 160e3 + 15 * 864e5)).done.length, 0);
});

test("máximo de abiertas: la nueva termina la que tiene menos movimiento y lo avisa", async () => {
  const items = [{ ref: "x" }];
  for (let i = 0; i < ss.MAX_OPEN; i++) await ss.createFor("max@ordereat.com", { name: `S${i}`, origin: { kind: "list", key: `k${i}` }, items }, T0 + i * 1000);
  const r = await ss.createFor("max@ordereat.com", { name: "Nueva", origin: { kind: "list", key: "nueva" }, items }, T0 + 99e3);
  assert.deepEqual(r.bumped.map(b => b.name), ["S0"]);
  const L = await ss.listFor("max@ordereat.com", T0 + 100e3);
  assert.equal(L.open.length, ss.MAX_OPEN); assert.equal(L.done[0].endReason, "límite");
  // reabrir una terminada también respeta el máximo
  const re = await ss.updateFor("max@ordereat.com", L.done[0].id, { status: "open" }, T0 + 101e3);
  assert.equal(re.session.status, "open"); assert.deepEqual(re.bumped.map(b => b.name), ["S1"]);
});

test("anotar a la vez (contacto + salteo + posición) no pisa nada", async () => {
  const items = Array.from({ length: 5 }, (_, i) => ({ ref: `p${i}` }));
  const { session } = await ss.createFor("par@ordereat.com", { origin: { kind: "list", key: "par" }, items }, T0);
  await Promise.all([
    ss.recordFor("par@ordereat.com", session.id, contact("p0", "call", "info")),
    ss.updateFor("par@ordereat.com", session.id, { skip: { ref: "p1", reason: "client" } }),
    ss.recordFor("par@ordereat.com", session.id, contact("p2", "mail", "info")),
    ss.updateFor("par@ordereat.com", session.id, { pos: 3 }),
  ]);
  const v = await ss.getFor("par@ordereat.com", session.id);
  assert.deepEqual([v.stats.worked, v.stats.skipped, v.pos, v.resume], [2, 1, 3, 3]);
});

test("tope de colegios: toma los primeros MAX_ITEMS y dice cuántos quedaron afuera", async () => {
  const items = Array.from({ length: ss.MAX_ITEMS + 93 }, (_, i) => ({ ref: `t${i}` }));
  assert.deepEqual([ss.cleanItems(items).items.length, ss.cleanItems(items).cut], [ss.MAX_ITEMS, 93]);
  assert.equal(ss.cleanItems([{ ref: "a" }, { ref: "a" }, { ref: "<x>" }]).cut, 0); // repetidos e inválidos no cuentan
  const r = await ss.createFor("tope@ordereat.com", { origin: { kind: "explore", key: "explore:ba" }, items }, T0);
  assert.equal(r.session.items.length, ss.MAX_ITEMS); assert.equal(r.truncated, 93); assert.equal(r.session.cut, 93);
  const small = await ss.createFor("tope@ordereat.com", { origin: { kind: "explore", key: "explore:otra" }, items: items.slice(0, 5) }, T0);
  assert.equal(small.truncated, undefined);
});

test("prune: quedan las MAX_DONE terminadas más recientes y la «Tu día» de otro día se termina sola", () => {
  const at = m => new Date(T0 - m * 60e3).toISOString();
  const done = Array.from({ length: ss.MAX_DONE + 3 }, (_, i) => ({ id: `d${i}`, status: "done", endedAt: at(i), updatedAt: at(i) }));
  const open = [
    { id: "ayer", status: "open", updatedAt: at(1), origin: { kind: "today", key: "today:2026-11-09" } },
    { id: "hoy", status: "open", updatedAt: at(1), origin: { kind: "today", key: "today:2026-11-10" } },
    { id: "zona", status: "open", updatedAt: at(1), origin: { kind: "zone", key: "zone:2026-11-01" } },
  ];
  const r = ss.prune([...done, ...open], T0, "2026-11-10");
  assert.deepEqual(r.changed.map(s => [s.id, s.status, s.endReason]), [["ayer", "done", "otro día"]]);
  // las más viejas de las terminadas; «ayer» pasa a terminada (la más reciente) y cuenta para el tope: sale una más
  assert.deepEqual(r.drop, ["d19", "d20", "d21", "d22"]);
  assert.equal(r.keep.filter(s => s.status === "done").length, ss.MAX_DONE);
  assert.deepEqual(r.keep.filter(s => s.status === "open").map(s => s.id), ["hoy", "zona"]);
  // sin la fecha de hoy no se termina ninguna «Tu día»
  assert.equal(ss.prune(open.map(s => ({ ...s, status: "open" })), T0).changed.length, 0);
});

test("lista: solo resúmenes; la «Tu día» de ayer pasa a terminadas al listar con la fecha de hoy", async () => {
  const E = "dia@ordereat.com", items = [{ ref: "a", name: "A", city: "Puebla" }, { ref: "b" }];
  const y = (await ss.createFor(E, { name: "Tu día · lun 9 nov", origin: { kind: "today", key: "today:2026-11-09" }, items }, T0 - 864e5)).session;
  await ss.recordFor(E, y.id, contact("a", "call", "no_answer"), T0 - 864e5 + 60e3);
  const L = await ss.listFor(E, T0, "2026-11-10");
  assert.deepEqual(L.open, []);
  assert.deepEqual(L.done.map(s => [s.id, s.endReason, s.summary]), [[y.id, "otro día", "1 llamada"]]);
  assert.equal(L.done[0].items, undefined); assert.equal(L.done[0].steps, undefined); assert.equal(L.maxItems, ss.MAX_ITEMS);
  // el detalle sí trae todo
  const v = await ss.getFor(E, y.id);
  assert.deepEqual(v.items.map(i => i.state), ["worked", "pending"]);
});

test("refsFor: el id de la ficha, el de la base y el lead:/org: de una ficha de Pipedrive", () => {
  assert.deepEqual([...ss.refsFor("col-1")], ["col-1"]);
  assert.deepEqual([...ss.refsFor("pd-lead-9f1")].sort(), ["lead:9f1", "pd-lead-9f1"]);
  assert.deepEqual([...ss.refsFor("pd-org-12")].sort(), ["org:12", "pd-org-12"]);
  assert.deepEqual([...ss.refsFor("")], []);
});

test("fuera de la sesión (sin Redis): cuenta como trabajado, no se anota en la sesión de donde vino", async () => {
  const E = "fuera2@ordereat.com";
  const a = (await ss.createFor(E, { name: "Zona", origin: { kind: "zone", key: "zone:z" }, items: [{ ref: "x" }, { ref: "y" }] }, T0)).session;
  const out = await ss.recordOutside(E, "x", contact("", "call", "no_answer", { schoolId: "x" }), { now: T0 + 1e3 });
  assert.deepEqual(out.map(v => [v.id, v.stats.worked, v.resume, v.items]), [[a.id, 1, 1, undefined]]);
  assert.deepEqual(await ss.recordOutside(E, "y", contact("y", "mail", "info", { schoolId: "y" }), { except: a.id }), []);
  assert.equal((await ss.getFor(E, a.id)).steps[0].outside, true);
});
