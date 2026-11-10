// Sincronización masiva (lib/sync.js): mismas reglas que el cruce de a uno (checkSchool), contra el Pipedrive de prueba.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
for (const k of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "PIPEDRIVE_API_TOKEN"]) delete process.env[k];
process.env.DEMO_MODE = "1";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ob-sync-"));
const pd = await import("../lib/pipedrive.js");
const store = await import("../lib/store.js");
const sales = await import("../lib/sales.js");
const sync = await import("../lib/sync.js");

// todas las organizaciones del demo, por las páginas (como la sincronización)
async function allOrgs() { const out = new Map(); let cursor = null; do { const r = await pd.orgsPage({ cursor, limit: 500 }); r.items.forEach(o => out.set(o.id, o)); cursor = r.next; } while (cursor); return out; }
const sample = (list, n) => list.filter((_, i) => i % Math.ceil(list.length / n) === 0);
// ¿se cortó alguna de las búsquedas de findOrgCandidates (10 por término)?
const truncated = async s => { const base = pd.tokens(s.name); return (await Promise.all([base.join(" "), base.slice(0, 2).join(" "), s.name].map(t => pd.searchOrganizations(t, 11)))).some(r => r.length > 10); };
const KEYS = ["status", "detail", "phase", "orgId", "orgName", "ownerId", "ownerName", "confirmed", "openDealId", "openDealOwnerId", "lostReason", "lostAt", "dealCount"];
const pick = r => Object.fromEntries(KEYS.map(k => [k, r?.[k] ?? null]));

test("scoreOrg: el puntaje de siempre (palabras propias en común + 0.15 por la ciudad, tope 1)", () => {
  const s = { name: "Colegio San José de Calasanz", city: "Lima" };
  assert.equal(pd.scoreOrg(s, { name: "San José de Calasanz" }), 1);
  assert.equal(pd.scoreOrg(s, { name: "Colegio San Agustín" }), 1 / 3);
  assert.equal(pd.scoreOrg(s, { name: "San José Lima" }), 2 / 3 + 0.15);
  assert.equal(pd.scoreOrg({ name: "Colegio Particular", city: "Lima" }, { name: "Colegio Particular" }), 0);
});

// La búsqueda de Pipedrive devuelve como mucho 10 por término: si se cortó, la sincronización (que ve todas las
// organizaciones) puede encontrar una mejor. Sin corte, tienen que elegir exactamente la misma.
test("candidatesFor elige lo mismo que findOrgCandidates (misma organización y mismo puntaje)", async () => {
  const orgs = await allOrgs(), list = sample(store.schools, 600);
  const bulk = sync.candidatesFor(list, orgs);
  let chosen = 0, same = 0, cut = 0;
  for (const [i, s] of list.entries()) {
    const one = pd.pickOrg(await pd.findOrgCandidates(s)), many = pd.pickOrg(bulk[i]);
    if (one) { chosen++; assert.ok(many && many.score >= one.score, `${s.id}: la masiva no puede elegir peor`); }
    if ((many?.id ?? null) === (one?.id ?? null)) { same++; continue; }
    assert.ok(await truncated(s), `${s.id} ${s.name}: ${one?.id} vs ${many?.id} sin búsqueda cortada`);
    cut++;
  }
  assert.ok(chosen > 100, `se eligió organización en ${chosen} colegios`);
  assert.ok(same / list.length > 0.9, `iguales ${same} de ${list.length} (cortadas ${cut})`);
});

test("candidatesFor: de mayor a menor, empate por la más parecida y después la más vieja; tope y piso", () => {
  const orgs = new Map([[30, { id: 30, name: "San Martín" }], [10, { id: 10, name: "Colegio San Martín" }], [20, { id: 20, name: "San Martín de Porres" }], [40, { id: 40, name: "Martín" }], [50, { id: 50, name: "Otra cosa" }]]);
  const [c] = sync.candidatesFor([{ name: "Colegio San Martín", city: "Lima" }], orgs, { top: 3 });
  assert.deepEqual(c.map(x => x.id), [10, 30, 20]);
  assert.deepEqual(sync.candidatesFor([{ name: "Colegio San Martín", city: "Lima" }], orgs, { top: 2 })[0].map(x => x.id), [10, 30]);
  // «Martín» solo no compite: la búsqueda pide «san martin» (todas o las dos primeras palabras)
  const [d] = sync.candidatesFor([{ name: "Colegio San Martín", city: "Lima" }], orgs);
  assert.deepEqual(d.map(x => [x.id, x.score]), [[10, 1], [30, 1], [20, 1]]);
  const [e] = sync.candidatesFor([{ name: "Colegio San Martín Tours", city: "Lima" }], orgs);
  assert.deepEqual(e.map(x => [x.id, x.score]), [[10, 2 / 3], [30, 2 / 3], [20, 2 / 3]]);
  assert.deepEqual(sync.candidatesFor([{ name: "Colegio San Martín Tours Bello", city: "Lima" }], orgs, { floor: 0.6 })[0], []); // 2/4 = 0.5, bajo el piso

});

const M = { users: [{ id: 7, name: "Ana" }], pipes: { 1: "ARG - SALES" }, stages: { 112: "SELLING", 111: "PROPOSAL SENT" } };
const orgs = new Map([[5, { id: 5, name: "Colegio Norte", ownerId: 7 }], [6, { id: 6, name: "Norte Sur", ownerId: null }]]);
const dealsBy = new Map([[5, [{ id: 1, org_id: 5, status: "open", pipeline_id: 1, stage_id: 112, owner_id: 7, update_time: "2026-10-01T10:00:00Z" }]]]);
const now = Date.parse("2026-11-10T12:00:00Z"), startedAt = "2026-11-10T11:30:00Z";

test("decideMatch: un cruce confirmado a mano mantiene su organización (aunque haya otra mejor)", () => {
  const cur = { status: "org", orgId: 6, orgName: "Norte Sur", confirmed: true, checkedAt: "2026-11-01T10:00:00Z", leadId: "L1" };
  const cands = [{ id: 5, name: "Colegio Norte", ownerId: 7, score: 1 }];
  const r = sync.decideMatch({ cur, fresh: true, cands, orgs, dealsBy, m: M, now, startedAt });
  assert.equal(r.rec.orgId, 6); assert.equal(r.rec.orgName, "Norte Sur"); assert.equal(r.rec.confirmed, true); assert.equal(r.rec.status, "org"); assert.equal(r.rec.leadId, "L1");
});
test("decideMatch: lo que revisó una ficha hace menos de 1 hora no se toca", () => {
  const cur = { status: "new", orgId: null, confirmed: false, checkedAt: "2026-11-10T11:10:00Z" };
  assert.deepEqual(sync.decideMatch({ cur, fresh: true, cands: [], orgs, dealsBy, m: M, now, startedAt: "2026-11-01T00:00:00Z" }), { skip: "recent" });
  // ni lo que se revisó después de empezada la sincronización (aunque haga más de 1 hora)
  assert.deepEqual(sync.decideMatch({ cur: { ...cur, checkedAt: "2026-11-09T10:00:00Z" }, fresh: true, cands: [], orgs, dealsBy, m: M, now, startedAt: "2026-11-08T00:00:00Z" }), { skip: "recent" });
});
test("decideMatch: «no es esta organización» vigente no se vuelve a elegir", () => {
  const cur = { status: "new", orgId: null, confirmed: false, unlinked: true, checkedAt: "2026-11-05T10:00:00Z" };
  assert.deepEqual(sync.decideMatch({ cur, fresh: true, cands: [{ id: 5, name: "Colegio Norte", ownerId: 7, score: 1 }], orgs, dealsBy, m: M, now, startedAt }), { skip: "unlinked" });
});
test("decideMatch: mismo umbral (0.67 elige, 0.95 confirma) y estado por sus tratos", () => {
  const r = sync.decideMatch({ cur: null, fresh: false, cands: [{ id: 5, name: "Colegio Norte", ownerId: 7, score: 0.8 }], orgs, dealsBy, m: M, now, startedAt });
  assert.equal(r.rec.status, "open"); assert.equal(r.rec.confirmed, false); assert.equal(r.rec.openDealId, 1); assert.equal(r.rec.ownerName, "Ana"); assert.equal(r.rec.via, "sync");
  assert.equal(sync.decideMatch({ cur: null, cands: [{ id: 5, name: "Colegio Norte", ownerId: 7, score: 0.95 }], orgs, dealsBy, m: M, now, startedAt }).rec.confirmed, true);
  const low = sync.decideMatch({ cur: null, cands: [{ id: 6, name: "Norte Sur", score: 0.6 }], orgs, dealsBy, m: M, now, startedAt }).rec;
  assert.equal(low.status, "new"); assert.equal(low.detail, "Sin coincidencia clara en Pipe"); assert.equal(low.candidates.length, 1);
  assert.equal(sync.decideMatch({ cur: null, cands: [], orgs, dealsBy, m: M, now, startedAt }).rec.detail, "No figura en Pipe");
});
test("decideMatch: si nada cambió y está al día, no se reescribe", () => {
  const first = sync.decideMatch({ cur: null, cands: [{ id: 5, name: "Colegio Norte", ownerId: 7, score: 0.8 }], orgs, dealsBy, m: M, now, startedAt }).rec;
  const cur = { ...first, checkedAt: "2026-11-09T10:00:00Z" };
  assert.deepEqual(sync.decideMatch({ cur, fresh: true, cands: [{ id: 5, name: "Colegio Norte", ownerId: 7, score: 0.8 }], orgs, dealsBy, m: M, now, startedAt }), { same: true });
});

test("de punta a punta en el demo: se pausa y se sigue, y da lo mismo que checkSchool", async () => {
  sync._reset();
  const list = store.schools.filter(s => !s.id.startsWith("pd-"));
  // un cruce confirmado a mano antes de sincronizar (a otra organización que la que elegiría el puntaje)
  const manual = list.find(s => !store.getMatch(s.id)), org = (await allOrgs()).values().next().value;
  store.setMatch(manual.id, { status: "org", detail: "Existe en Pipe, sin tratos", orgId: org.id, orgName: org.name, confirmed: true, candidates: [] });
  // hace 2 horas: la sincronización lo puede recalcular, pero sin cambiar la organización
  store.allMatches()[manual.id].checkedAt = new Date(Date.now() - 2 * 3600e3).toISOString();
  let r = await sync.step({ maxPages: 1 }); // una página y pausa: queda a medias
  assert.equal(r.running, true); assert.equal(r.job.phase, "orgs"); assert.equal(r.job.orgs, 500);
  let steps = 1;
  while (r.running && steps < 200) { r = await sync.step({ maxPages: 3 }); steps++; assert.equal(r.error, null, r.error?.message); }
  assert.equal(r.running, false); assert.ok(steps > 2, `pasos: ${steps}`);
  assert.equal(r.last.mode, "full"); assert.ok(r.last.written >= list.length - 5, `escritos ${r.last.written} de ${list.length}`);
  assert.equal(list.filter(s => sales.schoolListItem(s).status === "unk").length, 0);
  const mm = store.getMatch(manual.id); assert.equal(mm.orgId, org.id); assert.equal(mm.confirmed, true);
  // la misma respuesta que el cruce de a uno, en una muestra
  let compared = 0;
  for (const s of sample(list, 300)) {
    if (s.id === manual.id || (!store.getMatch(s.id)?.confirmed && await truncated(s))) continue;
    compared++;
    const bulk = pick(store.getMatch(s.id)), one = pick(await sales.checkSchool(s.id, { force: true }));
    assert.deepEqual(bulk, one, `${s.id} ${s.name}`);
  }
  assert.ok(compared > 250, `comparados ${compared}`);
  // las siguientes son incrementales. La primera reescribe los confirmados por puntaje (≥ 0.95): como en checkSchool,
  // un confirmado se recalcula con su organización y sin otros candidatos. Después, si nada cambió, no reescribe nada.
  r = await sync.step({ budgetMs: 30e3 });
  assert.equal(r.running, false); assert.equal(r.last.mode, "inc"); assert.equal(r.last.orgs, 0);
  r = await sync.step({ budgetMs: 30e3 });
  assert.equal(r.last.mode, "inc"); assert.equal(r.last.written, 0); assert.ok(r.last.same + r.last.skipped >= list.length - 5); assert.ok(r.last.skip.recent >= 250, "lo que se revisó recién por ficha no se toca");
  // un trato nuevo en Pipedrive: la incremental lo trae y cambia el estado de ese colegio
  const target = list.find(s => store.getMatch(s.id)?.status === "org" && store.getMatch(s.id)?.via === "sync");
  const tm = store.getMatch(target.id);
  await pd.createDeal({ title: "Prueba", org_id: tm.orgId, pipeline_id: 1, stage_id: 112, owner_id: 2 });
  await new Promise(res => setTimeout(res, 1100)); // el demo guarda la hora al segundo
  r = await sync.step({ budgetMs: 30e3 });
  assert.equal(r.last.mode, "inc"); assert.equal(r.last.deals, 1);
  assert.equal(store.getMatch(target.id).status, "open"); assert.equal(store.getMatch(target.id).openDealOwnerId, 2);
});
