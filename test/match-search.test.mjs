// El cruce de a uno (pd.findOrgCandidates, búsquedas de Pipedrive) y la sincronización masiva (sync.candidatesFor, que ve
// todas las organizaciones) tienen que ver las mismas competidoras: las que tienen las dos primeras palabras del colegio
// (pd.eligible). Con un `fetch` falso que responde /organizations/search como Pipedrive (todas las palabras del término).
import { test } from "node:test";
import assert from "node:assert/strict";
for (const k of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "DEMO_MODE"]) delete process.env[k];
process.env.PIPEDRIVE_API_TOKEN = "token-de-prueba"; process.env.PIPEDRIVE_DOMAIN = "prueba-local";

const ORGS = [
  { id: 9973, name: "Instituto Thomas Jefferson Campus Guadalajara" },
  { id: 9785, name: "Colegio Thomas Jefferson De Guadalajara" },
  { id: 9970, name: "Instituto Thomas Jefferson Campus Valle Real" },
];
const words = s => String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").split(/\W+/).filter(w => w.length > 1);
const searched = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async url => {
  const u = new URL(String(url));
  assert.equal(u.hostname, "prueba-local.pipedrive.com", "ningún pedido sale de la cuenta de prueba");
  assert.ok(u.pathname.endsWith("/organizations/search"), u.pathname);
  const t = words(u.searchParams.get("term")); searched.push(t.join(" "));
  const items = ORGS.filter(o => { const w = new Set(words(o.name)); return t.every(x => w.has(x)); })
    .slice(0, Number(u.searchParams.get("limit") || 10)).map(o => ({ item: { id: o.id, name: o.name, owner: { id: 7 } } }));
  return new Response(JSON.stringify({ success: true, data: { items } }), { status: 200 });
};
test.after(() => { globalThis.fetch = realFetch; });
const pd = await import("../lib/pipedrive.js");
const { candidatesFor } = await import("../lib/sync.js");

const base = [
  { id: "gdl-campus", name: "Instituto Thomas Jefferson Campus Guadalajara", city: "Guadalajara", country: "México" },
  { id: "gdl-colegio", name: "Colegio Thomas Jefferson De Guadalajara", city: "Guadalajara", country: "México" },
  { id: "gdl-valle", name: "Instituto Thomas Jefferson Campus Valle Real", city: "Guadalajara", country: "México" },
];

test("«…Campus Guadalajara»: la búsqueda de a uno ve también la que no tiene «campus» y da lo mismo que la masiva", async () => {
  const ctx = pd.matchCtx(base, { memo: false }), s = base[0], k = ctx.key(s);
  const one = await pd.findOrgCandidates(s, ctx);
  const [bulk] = candidatesFor([s], ORGS.map(o => ({ ...o, ownerId: 7 })), { ctx });
  assert.ok(searched.includes("thomas jefferson"), `buscó con las dos primeras palabras: ${searched.join(" | ")}`);
  assert.deepEqual(one.map(c => [c.id, c.score]), bulk.map(c => [c.id, c.score]));
  // las dos organizaciones empatan en 1: elige la que se llama igual, pero no se confirma sola (antes, de a uno sí)
  assert.equal(pd.pickOrg(one).id, 9973);
  assert.equal(one[1].id, 9785); assert.ok(one[1].score >= pd.SURE);
  assert.equal(pd.isSure(one, k), false);
  assert.equal(pd.isSure(bulk, k), false);
});
