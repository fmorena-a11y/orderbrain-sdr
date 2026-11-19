// La cola de Hoy (prospectQueue de lib/sales.js) puntúa todos los colegios y arma la ficha de lista solo de los que entran.
// Tiene que dar EXACTAMENTE lo mismo (orden y contenido) que la versión anterior, que armaba la ficha de todos: se compara
// contra esa versión (copiada acá) sobre la base del demo con cruces, contactos y archivados de todo tipo.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
for (const k of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "PIPEDRIVE_API_TOKEN"]) delete process.env[k];
process.env.DEMO_MODE = "1";
const dir = process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ob-test-"));
// cruces y contactos sembrados antes de cargar el store (los lee de DATA_DIR): por posición en la base, siempre los mismos
const raw = JSON.parse(fs.readFileSync(new URL("../data/schools.json", import.meta.url), "utf8"));
const now = Date.now(), iso = d => new Date(now - d * 864e5).toISOString();
const STATES = ["new", "org", "lead", "lost", "stalled", "open", "client", "new", "org", "new"];
const cache = {}, touches = [], archived = {};
raw.forEach((s, i) => {
  if (i % 3 === 0) { // un tercio cruzado: todos los estados, dueños 1, 2 o libre, perdidos viejos y nuevos, algunos vencidos o de otra versión
    const st = STATES[(i / 3) % STATES.length];
    cache[s.id] = { status: st, detail: `estado ${st}`, orgId: st === "new" ? null : 5000 + i, orgName: s.name, ownerId: [1, 2, null][(i / 3) % 3], ownerName: ["Demo", "Otra", ""][(i / 3) % 3],
      ...(st === "lost" || st === "stalled" ? { lostReason: ["", "No es prioridad ahora", "Ya tiene un software del estilo"][i % 3], lostAt: iso(i % 2 ? 30 : 300) } : {}),
      ...(st === "lead" ? { leadId: `lead-${i}` } : {}), ...(i % 45 === 0 ? { phase: "churn" } : {}), ...(i % 51 === 0 ? { addrManual: "Calle a mano 123" } : {}),
      v: i % 39 === 0 ? 3 : i % 33 === 0 ? 4 : 6, checkedAt: iso(i % 27 === 0 ? 9 : 1) };
  }
  if (i % 7 === 0) for (let k = 0; k < 1 + (i % 4); k++) touches.push({ at: iso([0.2, 1.5, 3, 12][(i + k) % 4] + k), by: "demo@ordereat.com", byName: "Demo", schoolId: s.id, outcome: ["no_answer", "no_answer", "gatekeeper", "no_answer"][(i + k) % 4], channel: "call", connected: (i + k) % 4 === 2, text: "" });
  if (i % 211 === 0) archived[s.id] = { by: "demo@ordereat.com", byName: "Demo", at: iso(2), reason: "Cerró", text: "", leadIds: [] };
});
fs.writeFileSync(path.join(dir, "cache.json"), JSON.stringify(cache));
fs.writeFileSync(path.join(dir, "touches.json"), JSON.stringify(touches));
fs.writeFileSync(path.join(dir, "archived.json"), JSON.stringify(archived));
const { schools, getMatch, isFresh } = await import("../lib/store.js");
const pd = await import("../lib/pipedrive.js");
const sales = await import("../lib/sales.js");

// la versión anterior, tal cual (scoreFor es el mismo puntaje con el alto potencial)
function oldQueue({ countries = [], limit = 40, excludeOrgIds = new Set(), userId = null, zone = "" } = {}) {
  const out = [], z = pd.norm(zone);
  for (const s of schools) {
    if (countries.length && !countries.includes(s.country)) continue;
    if (z && !` ${pd.norm(s.city)} `.includes(` ${z} `) && pd.norm(s.country) !== z) continue;
    const m = getMatch(s.id);
    if (m?.orgId && excludeOrgIds.has(m.orgId)) continue;
    if (isFresh(m) && m.ownerId && m.ownerId !== userId) continue;
    const r = sales.scoreFor(s);
    if (r) out.push({ ...sales.schoolListItem(s), score: r.score, reasons: r.reasons });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

test("la base sembrada tiene de todo (si no, la comparación no prueba nada)", () => {
  assert.ok(schools.length > 1000);
  const st = new Set(schools.map(s => sales.schoolListItem(s).status));
  for (const k of ["unk", "new", "org", "lead", "lost", "stalled", "open", "client", "archived"]) assert.ok(st.has(k), `falta el estado ${k}`);
  const q = oldQueue({ limit: 1e6, userId: 1 });
  assert.ok(q.length > 1000 && q.length < schools.length);
  assert.ok(q.some(x => x.attempts) && q.some(x => x.lastTouch) && q.some(x => x.addr === "Calle a mano 123"));
  assert.ok(new Set(q.slice(0, 60).map(x => x.score)).size < 60, "hay empates de puntaje entre los primeros (el orden entre ellos también se compara)");
});
test("prospectQueue da lo mismo que la versión anterior: mismos colegios, mismo orden, mismo contenido", () => {
  const exclude = new Set(Object.values(cache).map(m => m.orgId).filter((id, i) => id && i % 5 === 0));
  const country = schools[0].country, city = schools.find(s => s.city && s.city.split(" ").length === 1).city;
  const cases = [
    { limit: 60, userId: 1 }, { limit: 60, userId: 2 }, { limit: 60 }, { limit: 40, userId: 1, excludeOrgIds: exclude }, { countries: [country], limit: 60, userId: 1 },
    { countries: ["México", "Argentina"], limit: 200, userId: 1 }, { zone: city, limit: 60, userId: 1 }, { zone: "Puebla", limit: 60, userId: 1, excludeOrgIds: exclude },
    { zone: country, limit: 60, userId: 2 }, { zone: "no existe esta zona", limit: 60, userId: 1 }, { limit: 1, userId: 1 }, { limit: 0, userId: 1 }, { limit: 1e6, userId: 1 }, {},
  ];
  let total = 0;
  for (const c of cases) {
    // effMatch pone la hora de ahora en clientes y archivados, pero no llega a la ficha de lista: se puede comparar entero
    const a = sales.prospectQueue(c), b = oldQueue(c);
    assert.equal(a.length, b.length, JSON.stringify({ ...c, excludeOrgIds: undefined }));
    assert.deepEqual(a.map(x => x.id), b.map(x => x.id), "mismo orden");
    assert.deepEqual(a, b);
    total += a.length;
  }
  assert.ok(total > 2000);
});
