// Fusionar organizaciones duplicadas (lib/merge.js): qué otra organización es el MISMO colegio y quién puede fusionar.
// Los nombres son como los de la cuenta real (buscar «Valladolid» en Pipedrive, solo lectura): «Colegio Valladolid» e
// «INSTITUTO VALLADOLID» sin dirección, y sedes con la ciudad en el nombre («… Pachuca», «… Cancún»).
// Al final, la fusión completa contra el Pipedrive de prueba (lib/pipedrive-demo.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
for (const k of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "PIPEDRIVE_API_TOKEN", "FREE_OWNER_IDS"]) delete process.env[k];
process.env.DEMO_MODE = "1";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ob-merge-"));
const pd = await import("../lib/pipedrive.js");
const { sameName, addrPlace, dupeOrgs, isClient, mergeBlock, mergeError, mergeRequestError, mergeStop, previewWarnings, elsewhereOf, linkedText, SEDE_WORDS } = await import("../lib/merge.js");
const { writesPipedrive } = await import("../lib/readonly.js");

// una base chica: el mismo nombre en varias ciudades (como en la base real)
const base = [
  { id: "gdl", name: "Colegio Valladolid", city: "Guadalajara", country: "México" },
  { id: "pach", name: "Colegio Valladolid", city: "Pachuca", country: "México" },
  { id: "ags", name: "Colegio Valladolid", city: "Aguascalientes", country: "México" },
  { id: "tor", name: "Colegio Valladolid", city: "Torreón", country: "México" },
  { id: "mor", name: "Instituto Valladolid Primaria", city: "Morelia", country: "México" },
  { id: "lima-sj", name: "Colegio San José", city: "Lima", country: "Perú" },
  { id: "pue", name: "Colegio Ypsilanti", city: "Puebla de Zaragoza", country: "México" },
];
const ctx = pd.matchCtx(base, { memo: false }), by = id => base.find(s => s.id === id);
const run = (sid, keep, orgs, linked) => { const s = by(sid); return dupeOrgs({ school: s, k: ctx.key(s), ctx, keep, orgs, linked }); };
const ids = r => r.dupes.map(x => x.id);
const why = (r, id) => r.skipped.find(x => x.id === id)?.why;

const VALLADOLID = [
  { id: 617, name: "Colegio Valladolid" }, { id: 4304, name: "INSTITUTO VALLADOLID" }, { id: 957, name: "Colegio Valladolid Pachuca" },
  { id: 1388, name: "Colegio Valladolid Cancún" }, { id: 44638, name: "Sistema Valladolid" }, { id: 1948, name: "Escuela Preparatoria Valladolid" },
  { id: 2161, name: "Colegio Trilingüe Valladolid" }, { id: 2378, name: "Colegio Valladolid Campus Leon" }, { id: 1687, name: "Valladolid Colegio Querétaro" },
];

test("Valladolid (Guadalajara): «INSTITUTO VALLADOLID» es el mismo nombre; las sedes de Pachuca, Cancún, Querétaro y León no", () => {
  const r = run("gdl", VALLADOLID[0], VALLADOLID.slice(1));
  assert.deepEqual(ids(r), [4304]);
  for (const id of [957, 1388, 1687, 2378]) assert.equal(why(r, id), "name", `${id}: otra ciudad en el nombre`);
  for (const id of [44638, 1948, 2161]) assert.equal(why(r, id), "name", `${id}: otra palabra propia o un nivel`);
  // sin ciudad en ningún lado: se ofrece, pero sin marcar y diciendo qué colegios de otras ciudades podrían ser los suyos:
  // primero el que tiene todas sus palabras («Instituto Valladolid Primaria» de Morelia), después los que se llaman igual
  assert.equal(r.dupes[0].sameCity, false); assert.equal(r.dupes[0].cityFrom, null);
  assert.equal(r.dupes[0].elsewhere, 4);
  assert.deepEqual(r.dupes[0].elsewhereAt, [{ name: "Instituto Valladolid Primaria", cities: ["Morelia"] }, { name: "Colegio Valladolid", cities: ["Pachuca", "Aguascalientes", "Torreón"] }]);
});
test("elsewhereOf: «Colegio Valladolid» sin ciudad no es el de Morelia («Instituto … Primaria»); nunca la misma ciudad ni el mismo colegio", () => {
  const k = ctx.key(by("gdl"));
  assert.deepEqual(elsewhereOf({ k, ctx, org: { id: 1, name: "Colegio Valladolid" } }), { n: 3, at: [{ name: "Colegio Valladolid", cities: ["Pachuca", "Aguascalientes", "Torreón"] }] });
  assert.deepEqual(elsewhereOf({ k: ctx.key(by("mor")), ctx, org: { id: 2, name: "Instituto Valladolid" } }).at.map(g => g.name), ["Colegio Valladolid"], "desde Morelia: los «Colegio Valladolid»");
});
test("la ciudad: en el nombre o en la dirección de Pipedrive es la misma → misma ciudad (primero); otra ciudad u otro país → nunca", () => {
  const keep = { id: 617, name: "Colegio Valladolid" };
  const r = run("gdl", keep, [
    { id: 1, name: "Colegio Valladolid", city: "Guadalajara", region: "Jalisco", country: "Mexico" },
    { id: 2, name: "COLEGIO VALLADOLID GUADALAJARA" },
    { id: 3, name: "Colegio Valladolid", city: "Aguascalientes", country: "México" },
    { id: 4, name: "Colegio Valladolid", country: "Perú" },
    { id: 5, name: "Colegio Valladolid", city: "Zapopan", country: "México" }, // otro municipio: no se adivina que es el mismo
    { id: 6, name: "INSTITUTO VALLADOLID" },
  ]);
  assert.deepEqual(ids(r), [1, 2, 6]);
  assert.deepEqual(r.dupes.map(x => [x.sameCity, x.cityFrom]), [[true, "addr"], [true, "name"], [false, null]]);
  for (const id of [3, 4, 5]) assert.equal(why(r, id), "place");
});
test("el de Pachuca: «Colegio Valladolid Pachuca» es el mismo; «… Cancún» nunca; uno sin ciudad se ofrece sin marcar", () => {
  const r = run("pach", { id: 957, name: "Colegio Valladolid Pachuca" }, VALLADOLID.filter(o => o.id !== 957).concat([{ id: 9, name: "Colegio Valladolid Pachuca Hidalgo" }]));
  assert.deepEqual(ids(r), [617, 4304]);
  assert.ok(r.dupes.every(x => !x.sameCity));
  assert.equal(why(r, 1388), "name"); assert.equal(why(r, 9), "name", "«Hidalgo»: una palabra propia de más");
});
test("si la elegida no es este colegio (otra ciudad en el nombre o en la dirección), no se ofrece fusionar nada", () => {
  assert.deepEqual(ids(run("gdl", { id: 1388, name: "Colegio Valladolid Cancún" }, VALLADOLID.filter(o => o.id !== 1388))), []);
  const r = run("gdl", { id: 617, name: "Colegio Valladolid", city: "Torreón", country: "México" }, VALLADOLID.slice(1));
  assert.deepEqual(ids(r), []); assert.equal(why(r, 4304), "keep");
});
test("otra sede, otro nivel u otro número no son el mismo colegio; palabras comunes de más sí", () => {
  const k = ctx.key(by("gdl"));
  for (const n of ["Colegio Valladolid Campus Norte", "Colegio Valladolid Plantel Centro", "Colegio Valladolid Sur", "Colegio Valladolid Primaria", "Colegio Valladolid 22", "Colegio Valladolid Secundaria"])
    assert.equal(sameName(k, n, ctx.places), null, n);
  assert.deepEqual(sameName(k, "Colegio Valladolid Internacional", ctx.places), { city: false });
  assert.deepEqual(sameName(k, "Instituto Valladolid A.C.", ctx.places), { city: false });
  assert.deepEqual(sameName(k, "Colegio Valladolid de Guadalajara", ctx.places), { city: true });
  assert.ok(["plantel", "campus", "norte", "primaria", "preparatoria"].every(w => SEDE_WORDS.has(w)));
});
test("un nombre de palabras comunes («Colegio San José») no alcanza para decir que dos organizaciones son el mismo colegio", () => {
  const r = run("lima-sj", { id: 1, name: "Colegio San José" }, [{ id: 2, name: "COLEGIO SAN JOSE" }, { id: 3, name: "I.E.P. San José", city: "Lima", country: "Perú" }]);
  assert.deepEqual(ids(r), []); assert.ok(r.skipped.every(x => x.why === "common"));
});
test("una organización vinculada a otro colegio de la base es otra sede: no se fusiona", () => {
  const r = run("gdl", VALLADOLID[0], [VALLADOLID[1]], new Map([[4304, ["mor"]]]));
  assert.deepEqual(ids(r), []); assert.equal(why(r, 4304), "linked");
});
test("si la que queda ya está vinculada a otro colegio de la base (otra ciudad), no se ofrece nada: se mezclarían dos sedes", () => {
  // el de Guadalajara vinculado a 617, que es la del de Aguascalientes: la 4304 no se ofrece
  const r = run("gdl", VALLADOLID[0], [VALLADOLID[1]], new Map([[617, ["ags"]]]));
  assert.deepEqual(ids(r), []); assert.equal(why(r, 4304), "keepLinked");
  assert.equal(mergeStop({ school: by("gdl"), linkedTo: [{ name: "Colegio Valladolid", city: "Aguascalientes" }] }),
    "Esa organización ya está vinculada a «Colegio Valladolid» de Aguascalientes: revisalo antes de fusionar");
  assert.equal(mergeStop({ school: by("gdl"), linkedTo: [] }), null);
  assert.equal(linkedText([{ name: "A", city: "X" }, { name: "B", city: "" }, { name: "C", city: "Y" }, { name: "D", city: "Z" }]), "«A» de X, «B» y 2 más");
});
test("un colegio sin ciudad (o una ficha de Pipedrive) no ofrece fusionar: no se puede decir «la misma ciudad»", () => {
  const sin = { id: "x", name: "Colegio Valladolid", city: "", country: "México" };
  const r = dupeOrgs({ school: sin, k: ctx.key(sin), ctx, keep: VALLADOLID[0], orgs: [{ id: 5, name: "Colegio Valladolid", city: "Mexicali", country: "México" }, VALLADOLID[1]] });
  assert.deepEqual(ids(r), []); assert.ok(r.skipped.every(x => x.why === "nocity"));
  assert.match(mergeStop({ school: sin }), /no tiene ciudad/);
  assert.match(mergeStop({ school: { ...by("gdl"), virtual: true } }), /ficha de Pipedrive/);
});
test("previewWarnings: ya vinculada a otro colegio, otra ciudad u otro país, y un trato abierto en otra del mismo colegio y ciudad", () => {
  const s = by("gdl");
  assert.deepEqual(previewWarnings({ school: s, org: { city: "", country: "México" } }), []);
  assert.deepEqual(previewWarnings({ school: s, org: { city: "Aguascalientes", country: "México" } }), [{ level: "err", text: "Esta organización es de Aguascalientes, no de Guadalajara" }]);
  assert.deepEqual(previewWarnings({ school: s, org: { city: "", country: "Perú" } }), [{ level: "err", text: "Esta organización es de Perú, no de México" }]);
  assert.deepEqual(previewWarnings({ school: s, org: {}, linkedTo: [{ name: "Colegio Valladolid", city: "Aguascalientes" }] }), [{ level: "err", text: "Ya está vinculada a «Colegio Valladolid» de Aguascalientes" }]);
  const open = [{ id: 903, name: "Colegio Valladolid", ownerId: 2, owner: "Juan Diego" }];
  assert.deepEqual(previewWarnings({ school: s, org: {}, open, me: 3 }), [{ level: "warn", text: "Juan Diego tiene un trato abierto en otra «Colegio Valladolid» de Guadalajara (id 903). Hablalo antes o elegí esa" }]);
  assert.deepEqual(previewWarnings({ school: s, org: {}, open, me: 2 }), [{ level: "warn", text: "Tenés un trato abierto en otra «Colegio Valladolid» de Guadalajara (id 903): elegí esa" }]);
});
test("READ_ONLY: las rutas que escriben en Pipedrive se bloquean también con mayúsculas (Express no las distingue)", () => {
  for (const p of ["/api/schools/gdl/merge-orgs", "/api/schools/gdl/Merge-Orgs", "/api/schools/gdl/MATCH", "/API/schools/gdl/log", "/api/Activities/5/done", "/api/proposals/Confirm"])
    assert.equal(writesPipedrive("POST", p), true, p);
  assert.equal(writesPipedrive("GET", "/api/schools/gdl/dupes"), false);
  assert.equal(writesPipedrive("POST", "/api/schools/gdl/draft"), false);
});
test("addrPlace: Puebla es Puebla de Zaragoza; la dirección sin ciudad no dice nada; «Mexico», «MX» y «México» son el mismo país", () => {
  const s = by("pue");
  assert.equal(addrPlace(s, { city: "Heroica Puebla de Zaragoza", country: "Mexico" }), "same");
  assert.equal(addrPlace(s, { city: "Puebla" }), "same");
  assert.equal(addrPlace(s, { city: "Cholula" }), "other");
  assert.equal(addrPlace(s, { country: "MX" }), null);
  assert.equal(addrPlace(s, { country: "Chile" }), "other");
  assert.equal(addrPlace(s, {}), null);
});

// ---------- permisos
const users = { 2: "Juan Diego", 3: "Agustín Tejos" }, nameOf = id => users[id] || "";
const GENERAL = 13493598; // cuenta general de la empresa (FREE_OWNERS): cuenta como libre
test("mergeBlock: cada uno fusiona lo suyo o lo libre; lo de otra persona no (dueño, trato abierto o prospecto abierto)", () => {
  const me = 3;
  assert.equal(mergeBlock({ org: { ownerId: null }, me, nameOf }), null, "libre");
  assert.equal(mergeBlock({ org: { ownerId: 3 }, me, nameOf }), null, "tuya");
  assert.equal(mergeBlock({ org: { ownerId: 2 }, me, nameOf }), "Es de Juan Diego");
  assert.equal(mergeBlock({ org: { ownerId: 2 }, me: null, nameOf }), "Es de Juan Diego", "sin usuario de Pipedrive, solo lo libre");
  assert.equal(mergeBlock({ org: { ownerId: null }, deals: [{ status: "open", pipeline_id: 9, owner_id: 2 }], me, nameOf }), "Tiene un trato de Juan Diego");
  assert.equal(mergeBlock({ org: { ownerId: null }, deals: [{ status: "open", pipeline_id: 9, owner_id: GENERAL }], me, nameOf }), null, "trato de la cuenta general");
  assert.equal(mergeBlock({ org: { ownerId: null }, deals: [{ status: "lost", pipeline_id: 9, owner_id: 2 }], me, nameOf }), null, "un trato perdido de otro no traba");
  assert.equal(mergeBlock({ org: { ownerId: null }, leads: [{ ownerId: 2, archived: false }], me, nameOf }), "Tiene un prospecto de Juan Diego");
  assert.equal(mergeBlock({ org: { ownerId: null }, leads: [{ ownerId: 2, archived: true }], me, nameOf }), null);
  assert.equal(mergeBlock({ org: { ownerId: null }, leadsUnknown: true, me, nameOf }), "No pude ver sus prospectos");
  assert.equal(mergeBlock({ org: { ownerId: 99 }, me, nameOf }), "Es de otra persona");
  // actividades sin hacer: las de otra persona traban (pasarían a la que queda sin que nadie le avise)
  assert.equal(mergeBlock({ org: { ownerId: null }, acts: [{ owner_id: 2, done: false }], me, nameOf }), "Tiene una actividad de Juan Diego");
  assert.equal(mergeBlock({ org: { ownerId: null }, acts: [{ owner_id: 3, done: false }, { owner_id: GENERAL, done: false }], me, nameOf }), null, "tuya o de la cuenta general");
  assert.equal(mergeBlock({ org: { ownerId: null }, actsUnknown: true, me, nameOf }), "No pude ver sus actividades");
  assert.equal(mergeBlock({ org: { ownerId: null }, acts: [{ owner_id: 2, done: false }], me, nameOf, leader: true }), null);
});
test("cliente (trato ganado o en un embudo de clientes, aunque sea de baja): solo un líder; un líder puede todo", () => {
  assert.equal(isClient([{ status: "won", pipeline_id: 9 }]), true);
  assert.equal(isClient([{ status: "lost", pipeline_id: 16, stage_id: 208 }]), true, "onboarding caído: ex cliente");
  assert.equal(isClient([{ status: "open", pipeline_id: 22 }]), true);
  assert.equal(isClient([{ status: "lost", pipeline_id: 9 }, { status: "open", pipeline_id: 9 }]), false);
  assert.equal(mergeBlock({ org: { ownerId: 3 }, deals: [{ status: "won", pipeline_id: 9, owner_id: 3 }], me: 3 }), "Es cliente de OrderEAT: la fusiona un líder");
  assert.equal(mergeBlock({ org: { ownerId: 2 }, deals: [{ status: "won", pipeline_id: 16, owner_id: 2 }], leads: [{ ownerId: 2 }], me: 3, leader: true }), null);
});
test("mergeError: la que queda es la vinculada a mano; cada una tiene que ser duplicada y se tiene que poder", () => {
  const rec = { orgId: 617, confirmed: true, auto: false };
  const dupes = [{ id: 4304, name: "INSTITUTO VALLADOLID", block: null }, { id: 5, name: "Colegio Valladolid", block: "Es de Juan Diego" }];
  assert.equal(mergeError({ rec, keepId: 617, mergeIds: [4304], dupes }), null);
  assert.equal(mergeError({ rec, keepId: 617, mergeIds: [], dupes }).status, 400);
  assert.equal(mergeError({ rec, keepId: 617, mergeIds: [1, 2, 3, 4, 5, 6, 7], dupes }).status, 400);
  assert.equal(mergeError({ rec, keepId: 617, mergeIds: [617], dupes }).status, 400);
  assert.equal(mergeError({ rec, keepId: 4304, mergeIds: [617], dupes }).status, 409, "la que queda tiene que ser la vinculada");
  assert.equal(mergeError({ rec: { ...rec, auto: true }, keepId: 617, mergeIds: [4304], dupes }).status, 409, "confirmada sola: no");
  assert.equal(mergeError({ rec: { ...rec, confirmed: false }, keepId: 617, mergeIds: [4304], dupes }).status, 409);
  assert.equal(mergeError({ rec: null, keepId: 617, mergeIds: [4304], dupes }).status, 409);
  const other = mergeError({ rec, keepId: 617, mergeIds: [957], dupes });
  assert.equal(other.status, 400); assert.match(other.msg, /no parece el mismo colegio/);
  assert.deepEqual(mergeError({ rec, keepId: 617, mergeIds: [4304, 5], dupes }), { msg: "Colegio Valladolid: Es de Juan Diego.", status: 403 });
  assert.equal(mergeError({ rec, keepId: 617, mergeIds: [4304], dupes, keepBlock: "Es de Juan Diego" }).status, 403);
  assert.deepEqual(mergeError({ rec, keepId: 617, mergeIds: [4304], dupes, stop: "Esa organización ya está vinculada a «X»" }), { msg: "Esa organización ya está vinculada a «X».", status: 409 });
  assert.equal(mergeRequestError({ rec, keepId: 617, mergeIds: [4304] }), null);
});

// ---------- de punta a punta contra el Pipedrive de prueba (el caso «Colegio Valladolid» de lib/pipedrive-demo.js)
const store = await import("../lib/store.js");
const sales = await import("../lib/sales.js");
const GDL = "guadalajara-colegio-valladolid", hasDemo = store.byId.has(GDL);
const sdr = { email: "agustin@ordereat.com", pdUserId: 3, pdName: "Agustín Tejos" }, lead = { email: "demo@ordereat.com", pdUserId: 1, pdName: "Demo" };
test("demo: «Es esta» → duplicadas → un SDR fusiona lo libre; lo de otra persona solo un líder; todo pasa a la que queda", { skip: !hasDemo && "sin el colegio del caso de prueba" }, async () => {
  const c = await sales.checkSchool(GDL, { force: true });
  assert.equal(c.confirmed, false); assert.ok(c.candidates.some(x => x.id === 901), "«Colegio Valladolid» (901) es candidata");
  // otra ficha que apunta a la que se va a fusionar y otro colegio que la tiene como candidata
  store.setMatch("pd-org-902", { status: "org", detail: "Existe en Pipe, sin tratos", orgId: 902, orgName: "INSTITUTO VALLADOLID", confirmed: true, auto: false, candidates: [] });
  store.setMatch("morelia-instituto-valladolid-primaria", { status: "new", detail: "Sin coincidencia clara en Pipe", orgId: null, confirmed: false, auto: false, candidates: [{ id: 902, name: "INSTITUTO VALLADOLID", score: 0.66 }, { id: 13116, name: "Instituto Valladolid Primaria", score: 0.66 }] });
  // antes de vincular no hay nada que fusionar
  assert.deepEqual((await sales.dupesFor(GDL, sdr)).dupes, []);
  const pre = await sales.orgPreview(GDL, 901, sdr);
  assert.equal(pre.org.name, "Colegio Valladolid"); assert.equal(pre.org.city, ""); assert.equal(pre.org.deals[0].status, "lost"); assert.equal(pre.org.persons, 1);
  // la 903 (misma ciudad, mismo nombre) tiene un trato abierto de Juan Diego: «¿Estás seguro?» lo dice
  assert.deepEqual(pre.warnings, [{ level: "warn", text: "Juan Diego tiene un trato abierto en otra «Colegio Valladolid» de Guadalajara (id 903). Hablalo antes o elegí esa" }]);
  assert.deepEqual(pre.linkedTo, []);
  const mxl = (await sales.orgPreview(GDL, 11730, sdr)).warnings;
  assert.deepEqual(mxl[0], { level: "err", text: "Esta organización es de Mexicali, no de Guadalajara" }, "primero lo que dice que no es esta");
  assert.match(mxl[1].text, /^Juan Diego tiene un trato abierto en otra «Colegio Valladolid» de Guadalajara \(id 903\)/);
  await assert.rejects(sales.orgPreview(GDL, 904), /no es candidata/);
  const rec = await sales.linkSchool(GDL, { id: 901, name: "Colegio Valladolid" });
  assert.equal(rec.confirmed, true); assert.equal(rec.auto, false); assert.ok(rec.seen.some(x => x.id === 903));

  const d = await sales.dupesFor(GDL, sdr);
  assert.equal(d.keep.id, 901); assert.equal(d.keepBlock, null);
  // la 902 tiene una llamada pendiente de Demo (user 1): el SDR no la fusiona
  assert.deepEqual(d.dupes.map(x => [x.id, x.sameCity, x.block]), [[903, true, "Es de Juan Diego"], [902, false, "Tiene una actividad de Demo"]]);
  assert.ok(d.dupes.every(x => !("_deals" in x) && !("_acts" in x)), "lo crudo no sale al navegador");
  assert.deepEqual(d.dupes[1].leads.map(l => l.title), ["Instituto Valladolid"]);
  assert.deepEqual(d.dupes[1].acts.map(a => [a.subject, a.owner]), [["Volver a llamar · INSTITUTO VALLADOLID", "Demo"]]);
  assert.deepEqual(d.dupes[1].elsewhereAt[0], { name: "Instituto Valladolid Primaria", cities: ["Morelia"] }, "dice qué colegio de otra ciudad podría ser");
  assert.equal(store.getMatch(GDL).dupeCount, 2, "la ficha muestra «Parece cargada 2 veces más · Revisar»");

  await assert.rejects(sales.mergeOrgs(GDL, sdr, { keepId: 901, mergeIds: [903] }), e => e.status === 403 && /Juan Diego/.test(e.message));
  await assert.rejects(sales.mergeOrgs(GDL, sdr, { keepId: 901, mergeIds: [902] }), e => e.status === 403 && /actividad de Demo/.test(e.message));
  await assert.rejects(sales.mergeOrgs(GDL, sdr, { keepId: 901, mergeIds: [904] }), e => e.status === 400 && /no parece el mismo colegio/.test(e.message));
  await assert.rejects(sales.mergeOrgs(GDL, sdr, { keepId: 902, mergeIds: [901] }), e => e.status === 409);

  // Demo, sin ser líder: la actividad es suya y lo demás es libre
  const r = await sales.mergeOrgs(GDL, lead, { keepId: 901, mergeIds: [902], by: "Demo", tz: "America/Mexico_City" });
  assert.deepEqual(r.merged, [902]);
  assert.equal(r.done[0].label, "«INSTITUTO VALLADOLID» (id 902) quedó dentro de «Colegio Valladolid»");
  assert.ok(r.done.every(x => !x.warn), JSON.stringify(r.done));
  assert.deepEqual(await pd.orgsByIds([902]), [], "la fusionada ya no existe");
  assert.ok(!(await pd.searchOrganizations("valladolid", 50)).some(o => o.id === 902));
  assert.ok((await pd.personsForOrg(901)).some(p => p.name === "Administración Instituto Valladolid"), "pasó la persona");
  assert.ok((await pd.leadsForOrg(901)).some(l => l.title === "Instituto Valladolid"), "pasó el prospecto");
  assert.ok((await pd.activities({ orgId: 901, done: false })).some(a => /INSTITUTO VALLADOLID/.test(a.subject)), "pasó la actividad");
  // fecha y autor primero (en «Últimas notas» se ve el comienzo)
  const note = (await pd.notesForOrg(901, 10)).find(n => /^Fusión/.test(n.content));
  assert.match(note.content, /^Fusión \d\d\/\d\d \(Demo, OrderBrain SDR\): se juntó «INSTITUTO VALLADOLID» \(id 902\)$/);
  assert.equal(store.getMatch(GDL).dupeCount, 1, "queda una");
  // la otra ficha pasa a la que queda (sigue elegida a mano) y la candidata borrada sale del otro colegio
  assert.equal(store.getMatch("pd-org-902").orgId, 901); assert.equal(store.getMatch("pd-org-902").confirmed, true);
  assert.deepEqual(store.getMatch("morelia-instituto-valladolid-primaria").candidates.map(x => x.id), [13116]);
  assert.equal(store.getMatch(GDL).orgId, 901); assert.equal(store.getMatch(GDL).confirmed, true);

  // lo de Juan Diego (con su trato abierto) lo fusiona un líder: el colegio queda «En proceso» con ese trato
  const dl = await sales.dupesFor(GDL, lead, { leader: true });
  assert.deepEqual(dl.dupes.map(x => [x.id, x.block]), [[903, null]]);
  const r2 = await sales.mergeOrgs(GDL, lead, { keepId: 901, mergeIds: [903], leader: true, by: "Líder" });
  assert.deepEqual(r2.merged, [903]);
  assert.equal(r2.done[0].label, "«Colegio Valladolid» (id 903) quedó dentro de «Colegio Valladolid» (id 901)", "con el mismo nombre, las dos con su id");
  assert.ok((await pd.dealsForOrg(901)).some(x => x.status === "open" && x.owner_id === 2), "el trato abierto de Juan Diego pasó");
  assert.equal(store.getMatch(GDL).status, "open");
  assert.deepEqual((await sales.dupesFor(GDL, lead, { leader: true })).dupes, [], "ya no queda ninguna");
  assert.equal(store.getMatch(GDL).dupeCount || 0, 0, "la ficha ya no muestra «Revisar»");
});
test("demo: si la organización ya está vinculada a otro colegio de la base (otra ciudad), «¿Estás seguro?» lo dice y nadie fusiona ahí", { skip: !hasDemo && "sin el caso de prueba" }, async () => {
  const AGS = "aguascalientes-colegio-valladolid";
  if (!store.byId.has(AGS)) return;
  const prev = store.getMatch(AGS);
  store.setMatch(AGS, { status: "org", detail: "Existe en Pipe", orgId: 901, orgName: "Colegio Valladolid", confirmed: true, auto: false, candidates: [] });
  try {
    const pre = await sales.orgPreview(GDL, 901, sdr);
    assert.deepEqual(pre.linkedTo.map(x => [x.id, x.city]), [[AGS, "Aguascalientes"]]);
    assert.deepEqual(pre.warnings[0], { level: "err", text: "Ya está vinculada a «Colegio Valladolid» de Aguascalientes" });
    // ni un líder: se mezclarían dos sedes
    const d = await sales.dupesFor(GDL, lead, { leader: true });
    assert.deepEqual(d.dupes, []); assert.match(d.stop, /ya está vinculada a «Colegio Valladolid» de Aguascalientes/);
    assert.equal(store.getMatch(GDL).dupeCount || 0, 0);
    await assert.rejects(sales.mergeOrgs(GDL, lead, { keepId: 901, mergeIds: [904], leader: true }), e => e.status === 409 && /Aguascalientes/.test(e.message));
  } finally { if (prev) store.setMatch(AGS, prev); }
});
test("demo: mergeOrganization mueve tratos, prospectos, personas, notas y actividades, y borra la fusionada", { skip: !hasDemo && "sin el caso de prueba" }, async () => {
  await assert.rejects(pd.mergeOrganization(905, 905), /inválida/);
  const before = (await pd.dealsForOrg(905)).length;
  await pd.mergeOrganization(905, 904);
  assert.equal((await pd.dealsForOrg(904)).length, before); assert.deepEqual(await pd.orgsByIds([905]), []);
  await assert.rejects(pd.mergeOrganization(905, 904), e => e.status === 404);
});
