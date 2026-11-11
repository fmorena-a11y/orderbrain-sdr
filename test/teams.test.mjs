// Equipos (lib/teams.js): quién ve qué equipo, quién puede cambiar qué, que Métricas y Equipo de un equipo no muestren nada
// de otro, que sin equipos todo siga como antes, y el guardado en lib/store.js (Redis).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as TM from "../lib/teams.js";
import * as M from "../lib/metrics.js";
import { demoBoard, boardFor } from "../lib/demos.js";
import { archiveError, canUnarchive } from "../lib/archive.js";
import { mergeBlock } from "../lib/merge.js";
import * as ACC from "../lib/access.js";
import { fakeUpstash } from "./fake-upstash.mjs";

// Pipedrive: 1 dirección (CEO), 2 líder fijo (dueño del token), 3 y 4 líderes de A y B, 5 y 6 miembros de A, 7 de B, 8 sin equipo
const users = [["ceo", 1], ["dueno", 2], ["la", 3], ["lb", 4], ["a1", 5], ["a2", 6], ["b1", 7], ["libre", 8]].map(([n, id]) => ({ id, name: n.toUpperCase(), email: `${n}@x.com` }));
const E = n => `${n}@x.com`;
const T0 = TM.normTeams({ teams: [
  { id: "tsdrmx", name: "SDR México", leaders: [E("la")], members: [E("a1"), E("a2")] },
  { id: "tsdrcs", name: "SDR Cono Sur", leaders: [E("lb")], members: [E("b1")] },
] });
const fixed = { [E("ceo")]: "direccion", [E("dueno")]: "lider" };
const V = (n, T = T0, assigned = null) => TM.viewerOf({ email: E(n), fixed: fixed[E(n)] || null, assigned, T });
const NONE = { teams: [] };

test("normTeams: ids válidos y sin repetir, emails en minúscula, un líder no es miembro y cada uno es miembro de uno solo", () => {
  const T = TM.normTeams({ teams: [
    { id: "tuno1", name: "  Uno <b> ", leaders: ["L@X.com", "l@x.com", "malo"], members: ["l@x.com", "M@x.com", "m@x.com"] },
    { id: "tdos1", name: "Dos", leaders: [], members: ["m@x.com", "n@x.com"] },
    { id: "tuno1", name: "Repetido" }, { id: "__proto__", name: "X" }, { id: "ttres", name: "   " }, null,
  ] });
  assert.deepEqual(T.teams.map(t => [t.id, t.name, t.leaders, t.members]), [["tuno1", "Uno b", ["l@x.com"], ["m@x.com"]], ["tdos1", "Dos", [], ["n@x.com"]]]);
  assert.deepEqual(TM.normTeams(null), { teams: [] });
  assert.equal(TM.hasTeams(TM.normTeams({ teams: "x" })), false);
});

test("sin equipos, como antes: un equipo implícito con todos; los líderes ven y tocan todo", () => {
  const lider = TM.viewerOf({ email: E("x"), assigned: { level: "lider" }, T: NONE });
  assert.deepEqual([lider.leader, lider.all, lider.admin, lider.on], [true, true, false, false]);
  assert.deepEqual(TM.pickTeam(lider, NONE, ""), { id: null });
  assert.deepEqual(TM.pickTeam(lider, NONE, "tsdrmx"), { id: null }); // no hay equipos: siempre todos
  assert.deepEqual(TM.viewFilter(lider, NONE, users), { id: null, filter: null });
  assert.equal(TM.leadScope(lider, NONE, users), true);
  assert.equal(TM.canLead(TM.leadScope(lider, NONE, users), { id: 7 }), true);
  const sdr = TM.viewerOf({ email: E("a1"), T: NONE });
  assert.deepEqual(TM.viewFilter(sdr, NONE, users), { id: null, filter: null }); // un SDR ve las demos y la actividad de todos (como antes)
  assert.equal(TM.leadScope(sdr, NONE, users), false);
  assert.equal(TM.roleLabel({ acc: lider.acc, T: NONE, email: E("x") }), "Líder");
  assert.equal(TM.roleLabel({ acc: sdr.acc, T: NONE, email: E("a1"), base: "SDR" }), "SDR");
  // un filtro null en Métricas = todo (lo mismo que sin equipo)
  const t = [{ at: "2026-11-05T12:00:00Z", by: E("b1"), outcome: "x" }];
  assert.equal(M.contactsSummary(t, { period: { from: "2026-11-01", to: "2026-11-10" }, tz: "UTC", team: null }).totals.n, 1);
});

test("quién ve qué equipo: dirección y el líder fijo, todos (o uno); un líder, solo el suyo (otro: 403); un miembro, nada de líder", () => {
  for (const n of ["ceo", "dueno"]) {
    const v = V(n);
    assert.deepEqual([v.leader, v.admin, v.all], [true, true, true], n);
    assert.deepEqual(TM.pickTeam(v, T0, ""), { id: null }); // «Todos»
    assert.deepEqual(TM.pickTeam(v, T0, "all"), { id: null });
    assert.deepEqual(TM.pickTeam(v, T0, "tsdrcs"), { id: "tsdrcs" });
    assert.equal(TM.pickTeam(v, T0, "tnoexiste").error.status, 404);
    assert.deepEqual(TM.viewableTeams(v, T0).map(t => t.name), ["SDR Cono Sur", "SDR México"]);
  }
  const la = V("la");
  assert.deepEqual([la.leader, la.admin, la.all, la.led], [true, false, false, ["tsdrmx"]]);
  assert.deepEqual(TM.pickTeam(la, T0, ""), { id: "tsdrmx" });
  assert.deepEqual(TM.pickTeam(la, T0, "tsdrmx"), { id: "tsdrmx" });
  assert.equal(TM.pickTeam(la, T0, "tsdrcs").error.status, 403);
  assert.match(TM.pickTeam(la, T0, "tsdrcs").error.error, /no es tuyo/);
  assert.equal(TM.pickTeam(la, T0, "all").error.status, 403);
  assert.equal(TM.pickTeam(la, T0, "tnoexiste").error.status, 404);
  assert.deepEqual(TM.viewableTeams(la, T0).map(t => t.id), ["tsdrmx"]);
  const a1 = V("a1");
  assert.deepEqual([a1.leader, a1.member], [false, "tsdrmx"]);
  assert.equal(TM.pickTeam(a1, T0, "tsdrmx").error.status, 403);
  assert.deepEqual(TM.viewableTeams(a1, T0), []);
  // un líder de dos equipos elige entre los suyos (en orden alfabético)
  const two = TM.normTeams({ teams: [...T0.teams, { id: "taexec", name: "Account Executives", leaders: [E("la")] }] });
  assert.deepEqual(V("la", two).led, ["taexec", "tsdrmx"]);
  assert.deepEqual(TM.pickTeam(V("la", two), two, ""), { id: "taexec" });
  // lo asignado «lider» de antes de los equipos, sin liderar uno: no ve lo de líder
  const old = V("libre", T0, { level: "lider" });
  assert.deepEqual([old.leader, old.acc.stale], [false, true]);
});

test("Equipo para cada uno: un líder, el equipo elegido; un miembro, su equipo; sin equipo, solo lo suyo", () => {
  const f = (n, want = "") => TM.viewFilter(V(n), T0, users, want);
  assert.deepEqual([...f("la").filter.ids].sort(), [3, 5, 6]);
  assert.deepEqual([...f("a2").filter.ids].sort(), [3, 5, 6]);
  assert.deepEqual([...f("b1").filter.ids].sort(), [4, 7]);
  assert.deepEqual(f("libre"), { id: null, self: true, filter: { emails: new Set([E("libre")]), ids: new Set([8]) } });
  assert.equal(f("ceo").filter, null);
  assert.deepEqual([...f("ceo", "tsdrcs").filter.ids].sort(), [4, 7]);
  assert.equal(f("la", "tsdrcs").error.status, 403);
});

test("sobre lo de quién actúa como líder: dirección, de todos; un líder de equipo, de su gente; un miembro, de nadie", () => {
  const s = n => TM.leadScope(V(n), T0, users);
  assert.equal(s("ceo"), true); assert.equal(s("dueno"), true); assert.equal(s("a1"), false);
  const la = s("la");
  assert.deepEqual([TM.canLead(la, { id: 5 }), TM.canLead(la, { id: 3 }), TM.canLead(la, { id: 7 }), TM.canLead(la, { id: 4 }), TM.canLead(la, { id: null })], [true, true, false, false, false]);
  assert.equal(TM.canLead(la, { email: "A1@x.com" }), true);
  assert.equal(TM.canLead(la, { email: E("b1") }), false);
  assert.equal(TM.canLead(true, {}), true); // sin saber el dueño: solo quien ve todo
  assert.equal(TM.canLead(false, { id: 5 }), false);
  assert.deepEqual(TM.scopeOut(la), { ids: [3, 5, 6], emails: [E("la"), E("a1"), E("a2")] });
  assert.equal(TM.scopeOut(true), "all"); assert.equal(TM.scopeOut(false), null);
  // archivar lo ajeno: el trato abierto de alguien de su equipo sí; el de otro equipo, 403; desarchivar lo que archivó su gente
  assert.equal(archiveError({ status: "open", dealOwner: 5, me: 3, leader: la, reason: "Cerró" }), null);
  assert.equal(archiveError({ status: "open", dealOwner: 7, me: 3, leader: la, reason: "Cerró" }).status, 403);
  assert.equal(archiveError({ status: "open", dealOwner: null, me: 3, leader: la, reason: "Cerró" }).status, 403);
  assert.equal(archiveError({ status: "new", othersOwner: "B1", othersId: 7, me: 3, leader: la, reason: "Cerró" }).status, 403);
  assert.equal(archiveError({ status: "new", othersOwner: "A1", othersId: 5, me: 3, leader: la, reason: "Cerró" }), null);
  assert.equal(canUnarchive({ by: E("a2") }, E("la"), la), true);
  assert.equal(canUnarchive({ by: E("b1") }, E("la"), la), false);
});

test("quién arma los equipos: solo dirección y los fijos; nombres sin repetir", () => {
  assert.equal(TM.adminError(V("ceo")), null); assert.equal(TM.adminError(V("dueno")), null);
  assert.equal(TM.adminError(V("la")).status, 403); assert.equal(TM.adminError(V("a1")).status, 403);
  const c = TM.createTeam(T0, { id: "taccexe", name: " Account   Executives ", by: "CEO" });
  assert.deepEqual([c.team.name, c.T.teams.length, T0.teams.length], ["Account Executives", 3, 2]); // no cambia lo de antes
  assert.equal(TM.createTeam(T0, { id: "tdup0", name: "sdr mexico" }).error.status, 409); // sin tildes ni mayúsculas
  assert.equal(TM.createTeam(T0, { id: "tcorto", name: "x" }).error.status, 400);
  assert.equal(TM.createTeam(T0, { id: "mal id", name: "Nuevo" }).error.status, 500);
  assert.equal(TM.renameTeam(T0, "tsdrcs", "SDR México").error.status, 409);
  assert.equal(TM.renameTeam(T0, "tsdrcs", "SDR Sur").T.teams.find(t => t.id === "tsdrcs").name, "SDR Sur");
  assert.equal(TM.renameTeam(T0, "tnada", "Algo").error.status, 404);
  // líderes: el que era miembro de otro equipo deja de serlo; uno que no es de Pipedrive, 404
  const l = TM.setLeaders(T0, "tsdrcs", [E("lb"), E("a2")], { known: e => users.some(u => u.email === e) });
  assert.deepEqual(TM.teamById(l.T, "tsdrcs").leaders, [E("lb"), E("a2")]);
  assert.deepEqual(TM.teamById(l.T, "tsdrmx").members, [E("a1")]);
  assert.equal(TM.setLeaders(T0, "tsdrcs", ["nadie@y.com"], { known: () => false }).error.status, 404);
  // borrar: su gente queda sin equipo
  const d = TM.deleteTeam(T0, "tsdrcs");
  assert.deepEqual(d.T.teams.map(t => t.id), ["tsdrmx"]);
  assert.equal(TM.teamOfPerson(d.T, E("b1")), null);
});

test("miembros: el líder suma gente sin equipo y saca a los suyos; otro equipo, 403; un miembro, 403; nadie se saca a sí mismo", () => {
  const ch = (n, o) => TM.memberChange(V(n), T0, { known: true, ...o });
  const ok = ch("la", { teamId: "tsdrmx", email: E("libre"), add: true });
  assert.deepEqual(TM.teamById(ok.T, "tsdrmx").members, [E("a1"), E("a2"), E("libre")]);
  assert.deepEqual(TM.teamById(ch("la", { teamId: "tsdrmx", email: E("a2"), add: false }).T, "tsdrmx").members, [E("a1")]);
  assert.equal(ch("la", { teamId: "tsdrcs", email: E("libre"), add: true }).error.status, 403); // el equipo de otro
  assert.equal(ch("lb", { teamId: "tsdrmx", email: E("a1"), add: false }).error.status, 403);
  assert.equal(ch("a1", { teamId: "tsdrmx", email: E("libre"), add: true }).error.status, 403); // un miembro no cambia nada
  assert.equal(ch("la", { teamId: "tsdrmx", email: E("b1"), add: true }).error.status, 409); // está en otro equipo: lo pasa dirección
  assert.equal(ch("la", { teamId: "tsdrmx", email: E("la"), add: false }).error.status, 409); // sacarse a sí mismo, no
  assert.equal(ch("la", { teamId: "tsdrmx", email: E("libre"), add: true, known: false }).error.status, 404);
  assert.equal(ch("la", { teamId: "tsdrmx", email: E("libre"), add: true, target: { leader: true } }).error.status, 409); // alguien con acceso de líder: lo suma dirección
  assert.equal(ch("la", { teamId: "tsdrmx", email: E("a1"), add: true }).error.status, 409);
  assert.equal(ch("la", { teamId: "tsdrmx", email: E("b1"), add: false }).error.status, 404);
  // dirección mueve de un equipo a otro (deja el anterior)
  const mv = ch("ceo", { teamId: "tsdrmx", email: E("b1"), add: true });
  assert.deepEqual([TM.teamById(mv.T, "tsdrmx").members.includes(E("b1")), TM.teamById(mv.T, "tsdrcs").members.includes(E("b1"))], [true, false]);
  assert.equal(ch("ceo", { teamId: "tsdrmx", email: E("la"), add: false }).error.status, 409); // a un líder lo cambia dirección con «Líderes»
});

test("desde Accesos (dirección): miembro de un equipo o de ninguno, líder de uno; el acceso guardado sigue a lo que lidera", () => {
  const m = TM.placeMember(T0, E("la"), "tsdrcs"); // la líder de A pasa a ser miembro de B: deja de liderar A
  assert.deepEqual([TM.teamById(m.T, "tsdrmx").leaders, TM.teamById(m.T, "tsdrcs").members], [[], [E("b1"), E("la")]]);
  const l = TM.placeLeader(T0, E("a1"), "tsdrcs");
  assert.deepEqual([TM.teamById(l.T, "tsdrcs").leaders, TM.teamById(l.T, "tsdrmx").members], [[E("lb"), E("a1")], [E("a2")]]);
  assert.equal(TM.placeMember(T0, E("a1"), "tnada").error.status, 404);
  assert.deepEqual(TM.teamById(TM.placeMember(T0, E("a1"), null).T, "tsdrmx").members, [E("a2")]);
  const map = { [E("la")]: { level: "lider" } };
  assert.deepEqual(TM.accessSync(T0, l.T, map), [{ email: E("a1"), level: "lider" }]);
  assert.deepEqual(TM.accessSync(T0, m.T, map), [{ email: E("la"), level: "equipo" }]);
  assert.deepEqual(TM.accessSync(T0, TM.deleteTeam(T0, "tsdrcs").T, { [E("lb")]: { level: "direccion" } }), []); // dirección no se toca
  assert.deepEqual(TM.accessSync(T0, T0, map), []);
  // un líder de antes de los equipos (stale) que suman como miembro: su acceso guardado pasa a «equipo» (y deja de ser stale)
  const withLibre = TM.memberChange(V("ceo"), T0, { teamId: "tsdrcs", email: E("libre"), add: true, target: V("libre", T0, { level: "lider" }).acc }).T;
  assert.deepEqual(TM.accessSync(T0, withLibre, { [E("libre")]: { level: "lider" } }), [{ email: E("libre"), level: "equipo" }]);
  assert.equal(TM.roleLabel({ acc: V("libre", withLibre, { level: "lider" }).acc, T: withLibre, email: E("libre"), base: "SDR" }), "SDR · SDR Cono Sur");
});

test("cómo se muestra: «Dirección · CEO», «Líder · SDR México», «SDR · SDR México»", () => {
  assert.equal(TM.roleLabel({ acc: TM.viewerOf({ email: E("ceo"), fixed: "direccion", assigned: { level: "direccion", title: "CEO" }, T: T0 }).acc, T: T0, email: E("ceo") }), "Dirección · CEO");
  assert.equal(TM.roleLabel({ acc: V("la").acc, T: T0, email: E("la") }), "Líder · SDR México");
  assert.equal(TM.roleLabel({ acc: V("dueno").acc, T: T0, email: E("dueno") }), "Líder");
  assert.equal(TM.roleLabel({ acc: V("a1").acc, T: T0, email: E("a1"), base: "SDR" }), "SDR · SDR México");
  assert.equal(TM.roleLabel({ acc: V("b1").acc, T: T0, email: E("b1"), base: "Account Executive" }), "Account Executive · SDR Cono Sur");
  assert.equal(TM.roleLabel({ acc: V("libre").acc, T: T0, email: E("libre"), base: "SDR" }), "SDR");
  const two = TM.normTeams({ teams: [...T0.teams, { id: "taexec", name: "AE", leaders: [E("la")] }] });
  assert.equal(TM.roleLabel({ acc: V("la", two).acc, T: two, email: E("la") }), "Líder · AE y SDR México");
  // lo que ve cada uno en «Equipos»: dirección, todos (y edita); un líder, el suyo; un miembro, el suyo sin cambiar nada
  assert.deepEqual(TM.teamsView(V("ceo"), T0).map(t => [t.id, t.canEdit, t.canMembers]), [["tsdrcs", true, true], ["tsdrmx", true, true]]);
  assert.deepEqual(TM.teamsView(V("la"), T0).map(t => [t.id, t.canEdit, t.canMembers, t.mine]), [["tsdrmx", false, true, true]]);
  assert.deepEqual(TM.teamsView(V("b1"), T0).map(t => [t.id, t.canEdit, t.canMembers]), [["tsdrcs", false, false]]);
  assert.deepEqual(TM.teamsView(V("libre"), T0), []);
});

// ---------- aislamiento de Métricas por equipo: con el filtro de A no aparece nada de B (ni en totales ni por persona)
const TZ = "UTC", period = { from: "2026-11-04", to: "2026-11-10", days: 7 }, free = new Set([99]);
const A = TM.filterOf(T0, ["tsdrmx"], users), Bf = TM.filterOf(T0, ["tsdrcs"], users);
const ids = rows => rows.map(r => r.id).sort();

test("Métricas por equipo: demos cargadas y con fecha, solo de la gente del equipo", () => {
  const d = (id, x) => ({ id, type: "meeting", owner_id: 2, creator_user_id: 5, add_time: "2026-11-05T15:00:00Z", due_date: "2026-11-06", due_time: "", done: true, ...x });
  const acts = [d(1), d(2, { creator_user_id: 7 }), d(3, { creator_user_id: 6, owner_id: 7 }), d(4, { creator_user_id: 99 }), d(5, { creator_user_id: 1, by: "B1" }), d(6, { creator_user_id: 7, owner_id: 3 })];
  const all = M.demosLoaded(acts, { users, free, period, tz: TZ });
  const a = M.demosLoaded(acts, { users, free, period, tz: TZ, team: A }), b = M.demosLoaded(acts, { users, free, period, tz: TZ, team: Bf });
  assert.deepEqual([all.totals.total, a.totals.total, b.totals.total], [6, 2, 3]);
  assert.deepEqual([ids(a.people), ids(b.people)], [[5, 6], [7]]); // por quien la cargó; la nota de la app («B1») manda
  assert.equal(a.totals.auto, 0); assert.deepEqual(a.others, []); // las automáticas no son de ningún equipo
  // con fecha: la da o la cargó alguien del equipo; por persona, solo su gente
  const h = M.demosHeld(acts, { users, free, period, tz: TZ, now: Date.parse("2026-11-11T00:00:00Z"), team: A });
  assert.equal(h.totals.total, 3); // 1 y 3 las cargó A (5 y 6); 6 la da la líder de A (3)
  assert.deepEqual([ids(h.byOwner), ids(h.byLoader)], [[3], [5, 6]]);
  assert.ok(!h.items.some(x => x.id === 2 || x.id === 5));
});

test("Métricas por equipo: tratos (dueño o SDR del equipo), actividad, contactos y archivados", () => {
  const ctx = { sales: new Set([9]), pipeCountry: { 9: "México" }, paisOf: () => "", stageOf: () => ({ name: "SELLING", order: 0 }), stagesOf: () => [] };
  const deal = (id, x) => ({ id, status: "won", pipeline_id: 9, stage_id: 1, owner_id: 2, sdr: null, won_time: "2026-11-06T12:00:00Z", ...x });
  const won = [deal(1, { owner_id: 5 }), deal(2, { owner_id: 7 }), deal(3, { owner_id: 2, sdr: 6 }), deal(4, { owner_id: 4, sdr: { id: 7 } })];
  const open = [deal(10, { status: "open", owner_id: 5, next_activity_id: null }), deal(11, { status: "open", owner_id: 7, next_activity_id: null }), deal(12, { status: "open", owner_id: 2, sdr: 5, next_activity_id: null })];
  const r = M.dealsSummary({ won, open, period, tz: TZ, users, free, team: A, ...ctx });
  assert.deepEqual([r.won.n, ids(r.won.byOwner), ids(r.won.bySdr)], [2, [5], [6]]);
  assert.deepEqual(r.won.list.map(x => x.id), [1, 3]);
  assert.deepEqual([r.open.n, r.open.noNext, ids(r.open.noNextByOwner)], [2, 2, [5]]); // el 12 es del equipo por su SDR; su dueño (2) no aparece por persona
  assert.equal(M.dealsSummary({ won, open, period, tz: TZ, users, free, team: Bf, ...ctx }).won.n, 2);
  // actividad: a nombre de alguien del equipo; las filas, solo su gente (aunque la incluyan por usar la app)
  const act = (id, owner, x) => ({ id, type: "call", owner_id: owner, creator_user_id: owner, done: true, due_date: "2026-11-06", due_time: "", done_time: "2026-11-06T15:00:00Z", ...x });
  const s = M.activitySummary({ done: [act(1, 5), act(2, 6), act(3, 7), act(4, 99)], pending: [act(5, 7, { done: false, due_date: "2026-11-05" }), act(6, 5, { done: false, due_date: "2026-11-05" })], users, free, include: [5, 6, 7, 8], period, tz: TZ, today: "2026-11-10", team: A });
  assert.deepEqual([s.dated.total, s.overdue.n, ids(s.rows)], [2, 1, [5, 6]]);
  // contactos y archivados de la app: por email de quien los registró
  const t = (by, at = "2026-11-05T12:00:00Z") => ({ at, by, byName: by, schoolId: "s", outcome: "x", channel: "call" });
  const c = M.contactsSummary([t(E("a1")), t("A2@x.com"), t(E("b1")), t(E("libre"))], { period, tz: TZ, team: A });
  assert.deepEqual([c.totals.n, c.people.map(p => p.email).sort()], [2, [E("a1"), E("a2")]]);
  const arch = M.archivedSummary({ s1: { at: "2026-11-05T12:00:00Z", by: E("a1"), reason: "Cerró" }, s2: { at: "2026-11-05T12:00:00Z", by: E("b1"), reason: "Cerró" }, s3: { at: "2026-10-01T12:00:00Z", by: E("b1"), reason: "Otro" } }, { period, tz: TZ, team: A });
  assert.deepEqual([arch.n, arch.everN, arch.people.map(p => p.email)], [1, 1, [E("a1")]]);
});

test("Demos de la semana por equipo: las que da o cargó su gente; a un miembro, el total de su equipo", () => {
  const today = "2026-11-10", dm = (id, owner, creator, day = "2026-11-09") => ({ id, type: "meeting", owner_id: owner, creator_user_id: creator, due_date: day, due_time: "15:00", add_time: "2026-11-01T10:00:00Z", subject: `Demo · C${id}` });
  const demos = [dm(1, 2, 5), dm(2, 2, 7), dm(3, 7, 6), dm(4, 4, 4, "2026-11-12"), dm(5, 99, 99)];
  const opts = { users, profiles: {}, free, today, tz: TZ, now: Date.parse("2026-11-10T12:00:00Z") };
  const all = demoBoard(demos, opts), a = demoBoard(demos, { ...opts, team: A }), b = demoBoard(demos, { ...opts, team: Bf });
  assert.equal(all.recent.length + all.upcoming.length, 5);
  assert.deepEqual(a.recent.map(r => r.id).sort(), [1, 3]); assert.deepEqual(a.upcoming, []);
  assert.deepEqual([b.recent.map(r => r.id).sort(), b.upcoming.map(r => r.id)], [[2, 3], [4]]);
  assert.deepEqual(a.people.map(p => p.id).sort(), [5, 6]); // quién cargó: solo gente del equipo
  assert.deepEqual(b.people.map(p => p.id).sort(), [4, 7]); // la 3 la da alguien de B pero la cargó alguien de A: a A no se lo cuenta en B
  const mine = boardFor(a, { leader: false, me: 5 });
  assert.deepEqual([mine.mine.recent, mine.total.recent, mine.people], [1, 2, undefined]);
});

// ---------- lo que un líder de equipo NO toca aunque esté en su equipo: otro líder, dirección o un fijo (eso lo hace un admin)
// SDR México con dos líderes (la y lb) y, de miembros, a1, ceo (dirección fija), dueno (líder fijo) y libre (dirección asignada)
const T2 = TM.normTeams({ teams: [{ id: "tsdrmx", name: "SDR México", leaders: [E("la"), E("lb")], members: [E("a1"), E("ceo"), E("dueno"), E("libre")] }] });
const map2 = { [E("libre")]: { level: "direccion", title: "CTO" } };
const O2 = n => TM.viewerOf({ email: E(n), fixed: fixed[E(n)] || null, assigned: map2[E(n)] || null, T: T2 });

test("códigos: un líder de equipo no recibe el de su colíder ni el de alguien de dirección o fijo de su equipo (sí el suyo y el de sus miembros)", () => {
  const la = O2("la");
  assert.deepEqual([la.leader, la.admin, la.all], [true, false, false]);
  const sees = n => TM.showsCode(la, O2(n));
  assert.deepEqual(["la", "a1", "lb", "ceo", "dueno", "libre"].map(sees), [true, true, false, false, false, false]);
  // un admin ve todos
  assert.ok(["la", "lb", "ceo", "dueno", "libre", "a1"].every(n => TM.showsCode(O2("dueno"), O2(n))));
  // sin equipos, un líder asignado tampoco recibe el de dirección ni el de un fijo (con él entraría como esa persona)
  const old = TM.viewerOf({ email: E("x"), assigned: { level: "lider" }, T: NONE }), oN = n => TM.viewerOf({ email: E(n), fixed: fixed[E(n)] || null, T: NONE });
  assert.deepEqual([TM.showsCode(old, oN("a1")), TM.showsCode(old, oN("ceo")), TM.showsCode(old, oN("dueno"))], [true, false, false]);
  // un miembro no ve códigos ajenos de líderes (y la ruta igual le da 403)
  assert.equal(TM.showsCode(O2("a1"), O2("la")), false);
});

test("código del equipo (TEAM_ACCESS_CODE): solo lo fijo (dueño del token, LEADER_EMAILS, FOUNDER_EMAILS); un líder de equipo o dirección asignada, no", () => {
  const fx = e => ACC.fixedLevel(e, { owner: E("dueno"), leaders: [E("lfijo")], founders: [E("ceo")] });
  assert.deepEqual([E("dueno"), E("lfijo"), E("ceo")].map(e => ACC.teamCodeOk(fx(e))), [true, true, true]);
  assert.deepEqual([E("la"), E("libre"), E("a1"), ""].map(e => ACC.teamCodeOk(fx(e))), [false, false, false, false]);
  assert.equal(O2("libre").admin, true); // dirección asignada en la app: admin, pero entra solo con su código personal
});

test("alcance de un líder de equipo: su gente sin acceso de líder (ni colíder, ni dirección, ni fijo); sacarlos lo hace un admin", () => {
  const la = O2("la"), isLead = e => TM.viewerOf({ email: e, fixed: fixed[e] || null, assigned: map2[e] || null, T: T2 }).leader;
  const sc = TM.leadScope(la, T2, users, { isLead });
  assert.deepEqual([...sc.ids].sort(), [3, 5]); // la (ella misma) y a1
  assert.deepEqual([1, 2, 4, 8].map(id => TM.canLead(sc, { id })), [false, false, false, false]);
  assert.equal(TM.canLead(sc, { email: E("ceo") }), false);
  // aunque el servidor no diga quién es líder, el colíder queda afuera
  assert.deepEqual([...TM.leadScope(la, T2, users).ids].sort(), [1, 2, 3, 5, 8]);
  // sacar del equipo: a un miembro sí; a dirección o un fijo, 409 (lo saca dirección)
  const rm = (v, n) => TM.memberChange(v, T2, { teamId: "tsdrmx", email: E(n), add: false, target: O2(n).acc });
  assert.deepEqual(TM.teamById(rm(la, "a1").T, "tsdrmx").members, [E("ceo"), E("dueno"), E("libre")]);
  for (const n of ["ceo", "dueno", "libre"]) assert.equal(rm(la, n).error?.status, 409, n);
  assert.match(rm(la, "ceo").error.error, /lo saca dirección/);
  assert.equal(rm(O2("dueno"), "ceo").error, undefined); // un admin, sí
  assert.equal(rm(la, "lb").error.status, 409); // a un colíder lo cambia dirección
});

test("dirección no está en ningún equipo y un líder fijo no es miembro: no se suma, no se pone de líder y al pasar a dirección sale", () => {
  const ceo = V("ceo"), dueno = V("dueno"), isDir = e => e === E("ceo");
  const add = (v, n, acc) => TM.memberChange(v, T0, { teamId: "tsdrcs", email: E(n), add: true, target: acc });
  assert.match(add(dueno, "ceo", V("ceo").acc).error.error, /dirección/);
  assert.equal(add(dueno, "ceo", V("ceo").acc).error.status, 409);
  assert.match(add(ceo, "dueno", V("dueno").acc).error.error, /líder fijo/);
  assert.equal(TM.setLeaders(T0, "tsdrcs", [E("lb"), E("ceo")], { isDir }).error.status, 409);
  assert.equal(TM.setLeaders(T0, "tsdrcs", [E("lb"), E("dueno")], { isDir }).error, undefined); // un líder fijo puede liderar uno
  assert.equal(TM.placeLeader(T0, E("ceo"), "tsdrcs", { isDir }).error.status, 409);
  assert.equal(TM.placeMember(T0, E("ceo"), "tsdrcs", { isDir }).error.status, 409);
  // al pasar a dirección (Accesos): sale de todos (placeMember con null)
  const out = TM.placeMember(T2, E("libre"), null);
  assert.deepEqual(TM.teamById(out.T, "tsdrmx").members, [E("a1"), E("ceo"), E("dueno")]);
});

test("fusionar un cliente: un líder de equipo solo si todos sus tratos de cliente son de su gente; si no, dirección", () => {
  const la = TM.leadScope(V("la"), T0, users), org = { ownerId: 5 };
  const blk = (deals, leader = la, me = 3) => mergeBlock({ org, deals, me, leader });
  assert.equal(blk([{ status: "won", pipeline_id: 9, owner_id: 5 }]), null); // ganado por alguien de su equipo
  assert.equal(blk([{ status: "won", pipeline_id: 9, owner_id: 3 }]), null); // ganado por ella
  assert.match(blk([{ status: "won", pipeline_id: 9, owner_id: 7 }]), /la fusiona dirección/); // de otro equipo (B)
  assert.match(blk([{ status: "won", pipeline_id: 9, owner_id: 5 }, { status: "lost", pipeline_id: 16, owner_id: 7 }]), /la fusiona dirección/); // onboarding de otro equipo
  assert.match(blk([{ status: "won", pipeline_id: 9, owner_id: 99 }]), /la fusiona dirección/); // de una cuenta general: no se sabe de quién es
  assert.match(blk([{ status: "won", pipeline_id: 9, owner_id: null }]), /la fusiona dirección/);
  assert.equal(blk([{ status: "won", pipeline_id: 9, owner_id: 7 }], false, 5), "Es cliente de OrderEAT: la fusiona un líder"); // un SDR
  assert.equal(blk([{ status: "won", pipeline_id: 9, owner_id: 7 }], true), null); // dirección, los fijos (o sin equipos, un líder)
});

test("líder de antes de los equipos (stale): etiqueta «Líder · sin equipo» y el 403 de Métricas dice qué hacer", () => {
  const old = V("libre", T0, { level: "lider" });
  assert.equal(TM.roleLabel({ acc: old.acc, T: T0, email: E("libre"), base: "" }), "Líder · sin equipo");
  assert.deepEqual(TM.pickTeam(old, T0, ""), { error: { status: 403, error: TM.STALE_MSG } });
  // sin equipos sigue siendo líder (como antes)
  const before = V("libre", NONE, { level: "lider" });
  assert.deepEqual([before.leader, TM.roleLabel({ acc: before.acc, T: NONE, email: E("libre") })], [true, "Líder"]);
});

test("equipos desconocidos (Redis no respondió y nunca se leyeron): se cierra; nadie pasa a ver todo como si no hubiera equipos", () => {
  const U = TM.normTeams({ teams: [], unknown: true });
  assert.equal(U.unknown, true);
  const la = TM.viewerOf({ email: E("la"), assigned: { level: "lider" }, T: U });
  assert.deepEqual([la.leader, la.all, la.on, la.unknown, !!la.acc.stale], [false, false, true, true, false]);
  assert.equal(TM.pickTeam(la, U, "tsdrcs").error.status, 503);
  assert.equal(TM.leadScope(la, U, users), false);
  const a1 = TM.viewFilter(TM.viewerOf({ email: E("a1"), T: U }), U, users);
  assert.deepEqual([a1.self, a1.unknown, [...a1.filter.ids]], [true, true, [5]]); // un miembro, solo lo suyo
  const ceo = TM.viewerOf({ email: E("ceo"), fixed: "direccion", T: U }); // dirección sigue viendo todo
  assert.deepEqual([ceo.admin, ceo.all, TM.pickTeam(ceo, U, "")], [true, true, { id: null }]);
});

// ---------- guardado: Redis (clave propia «teams», un solo valor sin vencimiento) y lectura de otra instancia
for (const k of ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "PIPEDRIVE_API_TOKEN", "DEMO_MODE"]) delete process.env[k];
const R = await fakeUpstash();
process.env.KV_REST_API_URL = R.url; process.env.KV_REST_API_TOKEN = "x"; process.env.KV_PREFIX = "teams:";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ob-teams-"));
const store = await import("../lib/store.js");
after(() => R.close());

test("store: los equipos se guardan juntos en un valor sin vencimiento; otra instancia los ve al releer", async () => {
  assert.deepEqual(await store.getTeams({ fresh: true }), { teams: [] }); // sin nada guardado: sin equipos
  await store.saveTeams(T0);
  assert.deepEqual(JSON.parse(R.run(["GET", "teams:teams"])), T0);
  assert.equal(R.ttl ? R.ttl("teams:teams") : -1, -1);
  const other = TM.deleteTeam(T0, "tsdrcs").T;
  R.run(["SET", "teams:teams", JSON.stringify(other)]); // otra instancia borró un equipo
  assert.deepEqual((await store.getTeams({ fresh: true })).teams.map(t => t.id), ["tsdrmx"]);
  // un valor roto: para leer, lo último que leyó bien; para cambiar (fresh), 503 (no se guarda arriba)
  R.run(["SET", "teams:teams", "{roto"]);
  await assert.rejects(store.getTeams({ fresh: true }), e => e.status === 503);
  assert.deepEqual((await store.getTeams()).teams.map(t => t.id), ["tsdrmx"]);
});

test("store con Redis caído: un cambio da 503 (no borra los equipos) y una instancia nueva queda «desconocido» (se cierra)", async () => {
  await store.saveTeams(T0);
  R.down(true);
  try {
    await assert.rejects(store.getTeams({ fresh: true }), e => e.status === 503 && /equipos/.test(e.message));
    await assert.rejects(store.getAccessMap({ fresh: true }), e => e.status === 503 && /accesos/.test(e.message));
    assert.deepEqual((await store.getTeams()).teams.map(t => t.id), ["tsdrmx", "tsdrcs"]); // esta instancia ya los leyó: sigue
    // instancia nueva (otra copia del módulo) que nunca pudo leerlos
    const other = await import("../lib/store.js?instancia-nueva");
    const U = await other.getTeams();
    assert.deepEqual(U, { teams: [], unknown: true });
    const la = TM.viewerOf({ email: E("la"), assigned: { level: "lider" }, T: TM.normTeams(U) });
    assert.deepEqual([la.leader, la.all, TM.pickTeam(la, TM.normTeams(U), "tsdrcs").error.status], [false, false, 503]);
    await assert.rejects(other.saveTeams(U), e => e.status === 503); // nunca se guarda una lectura fallida
    await assert.rejects(other.getTeams({ fresh: true }), e => e.status === 503); // crear un equipo no sigue
    assert.deepEqual(JSON.parse(R.run(["GET", "teams:teams"])).teams.map(t => t.id), ["tsdrmx", "tsdrcs"]); // nada se borró
    R.down(false);
    const back = await other.getTeams({ fresh: true });
    assert.deepEqual([back.unknown, back.teams.map(t => t.id)], [undefined, ["tsdrmx", "tsdrcs"]]);
  } finally { R.down(false); }
});
