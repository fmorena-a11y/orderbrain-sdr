// Búsqueda en toda la base de Pipedrive (lib/pdsearch.js): teléfonos, plan de búsqueda, agrupado y a qué ficha lleva cada
// resultado. Al final, de punta a punta con el Pipedrive de prueba (sales.pdSearch y personCard).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { phoneDigits, isPhoneQuery, nationalDigits, spacedVariants, searchPlan, planKey, targetOf, orgTarget, leadTarget, groupResults, itemOut, hintFor, cleanCursor } from "../lib/pdsearch.js";

// ---------- teléfonos
test("isPhoneQuery: dígitos con separadores, al menos 6; letras o pocos dígitos no", () => {
  for (const q of ["2224292676", "222 429 2676", "+52 222 429 2676", "(222) 429-2676", "222.429.2676", "0052 222 429 2676", "222429"]) assert.ok(isPhoneQuery(q), q);
  for (const q of ["22242", "Colegio 2224292676", "tel 2224292676", "2026 EduExperience", "", null]) assert.ok(!isPhoneQuery(q), String(q));
});
test("nationalDigits: saca espacios, guiones, paréntesis y el código de país", () => {
  assert.equal(phoneDigits("+52 (222) 429-2676"), "522224292676");
  assert.equal(nationalDigits("2224292676"), "2224292676");
  assert.equal(nationalDigits("222 429 2676"), "2224292676");
  assert.equal(nationalDigits("+52 222 429 2676"), "2224292676");
  assert.equal(nationalDigits("(222) 429-2676"), "2224292676");
  assert.equal(nationalDigits("0052 222 429 2676"), "2224292676");
  assert.equal(nationalDigits("52 222 429 2676"), "2224292676", "12 dígitos que empiezan con 52: sin el código");
  assert.equal(nationalDigits("+598 2 600 1234"), "26001234", "Uruguay: el código de 3 dígitos antes que otro más corto");
  assert.equal(nationalDigits("+56 9 1234 5678"), "912345678");
  assert.equal(nationalDigits("5512345678"), "5512345678", "10 dígitos que empiezan con 55 (CDMX): no es código de país");
  assert.equal(nationalDigits("+52 1234"), "521234", "si quedan menos de 7 dígitos, no se saca nada");
});
test("spacedVariants: el número con espacios en los formatos comunes y como lo escribió la persona, hasta 3", () => {
  assert.deepEqual(spacedVariants("2224292676"), ["222 429 2676", "22 2429 2676"]);
  assert.deepEqual(spacedVariants("2224292676", "+52 22 24 29 26 76"), ["22 24 29 26 76", "222 429 2676", "22 2429 2676"]);
  assert.deepEqual(spacedVariants("2224292676", "(222) 429-2676"), ["222 429 2676", "22 2429 2676"], "repetido: queda una vez");
  assert.deepEqual(spacedVariants("912345678", "+56 9 1234 5678"), ["9 1234 5678", "912 345 678"]);
  assert.deepEqual(spacedVariants("12345"), []);
});

// ---------- plan de búsqueda
test("searchPlan: menos de 3 letras o números, nada", () => {
  assert.equal(searchPlan("ab"), null); assert.equal(searchPlan("  a  "), null); assert.equal(searchPlan(""), null); assert.equal(searchPlan(undefined), null);
  assert.ok(searchPlan("abc"));
});
test("searchPlan: teléfono → los dígitos sin código de país, de respaldo los últimos 10 y 7, y con espacios", () => {
  const p = searchPlan("+52 222 429 2676");
  assert.equal(p.kind, "phone"); assert.equal(p.digits, "2224292676");
  assert.deepEqual(p.terms, ["2224292676", "4292676"]);
  assert.deepEqual(p.spaced, ["222 429 2676", "22 2429 2676"]);
  assert.deepEqual(searchPlan("33 3456 7890 1234").terms, ["33345678901234", "5678901234", "8901234"], "más de 10 dígitos: también los últimos 10");
  assert.equal(searchPlan("+52 1 222 429 2676").terms[1], "2224292676", "con el 1 viejo de los celulares de México: de respaldo, los últimos 10");
  assert.deepEqual(searchPlan("2224292").terms, ["2224292"], "7 dígitos: un solo término");
});
test("searchPlan: email y nombres tal cual (sin espacios de más, hasta 100 caracteres)", () => {
  assert.deepEqual(searchPlan(" eduardo@maincatering.mx "), { kind: "email", terms: ["eduardo@maincatering.mx"] });
  assert.deepEqual(searchPlan("Prepa   Tec"), { kind: "text", terms: ["Prepa Tec"] });
  assert.equal(searchPlan("x".repeat(300)).terms[0].length, 100);
});
test("planKey: el mismo teléfono escrito distinto comparte la copia de 60 s; un nombre no distingue mayúsculas", () => {
  assert.equal(planKey(searchPlan("2224292676")), planKey(searchPlan("+52 (222) 429-2676")));
  assert.equal(planKey(searchPlan("Prepa Tec")), planKey(searchPlan("prepa tec")));
  assert.notEqual(planKey(searchPlan("2224292676")), planKey(searchPlan("2224292677")));
});

// ---------- a qué ficha lleva
const o2s = new Map([[45363, "monterrey-prepa-tec-cumbres"]]);
test("targetOf: organización cruzada → ficha del colegio; si no, la ficha de Pipedrive", () => {
  assert.deepEqual(targetOf("organization", { id: 45363 }, o2s), { kind: "school", id: "monterrey-prepa-tec-cumbres", orgId: 45363 });
  assert.deepEqual(targetOf("organization", { id: 3053 }, o2s), { kind: "record", ref: "org:3053" });
  assert.deepEqual(orgTarget("45363", o2s), { kind: "school", id: "monterrey-prepa-tec-cumbres", orgId: 45363 }, "el id como texto también");
});
test("targetOf: prospecto → el colegio de la base si su organización está cruzada (no una copia pd-org); si no, su ficha", () => {
  assert.deepEqual(targetOf("lead", { id: "9e25b2c0-7192", organization: null }), { kind: "record", ref: "lead:9e25b2c0-7192" });
  assert.deepEqual(targetOf("lead", { id: "abc", organization: { id: 45363 } }, o2s), { kind: "school", id: "monterrey-prepa-tec-cumbres", orgId: 45363, leadId: "abc" });
  assert.deepEqual(targetOf("lead", { id: "abc", organization: { id: 3053 } }, o2s), { kind: "record", ref: "lead:abc" }, "organización sin cruzar: la ficha del prospecto");
  assert.deepEqual(leadTarget("x", "45363", o2s).kind, "school", "el id de la organización como texto también");
  assert.deepEqual(leadTarget("x", null, o2s), { kind: "record", ref: "lead:x" });
});
test("targetOf: persona → siempre su ficha (teléfonos, emails, tratos…; de ahí, el botón a su organización)", () => {
  assert.deepEqual(targetOf("person", { id: 747, organization: null }, o2s), { kind: "person", id: 747 });
  assert.deepEqual(targetOf("person", { id: 1, organization: { id: 45363 } }, o2s), { kind: "person", id: 1 });
  assert.deepEqual(targetOf("person", { id: 1, organization: { id: 3053 } }, o2s), { kind: "person", id: 1 });
});
test("targetOf: trato → la ficha de su organización; sin organización, la de su persona; sin ninguna, nada (solo Pipedrive)", () => {
  assert.deepEqual(targetOf("deal", { id: 5583, organization: { id: 45363 }, person: { id: 9 } }, o2s), { kind: "school", id: "monterrey-prepa-tec-cumbres", orgId: 45363 });
  assert.deepEqual(targetOf("deal", { id: 5674, organization: null, person: { id: 23463 } }, o2s), { kind: "person", id: 23463 });
  assert.equal(targetOf("deal", { id: 1, organization: null, person: null }, o2s), null);
  assert.equal(targetOf("product", { id: 1 }, o2s), null);
  assert.equal(targetOf("person", null, o2s), null);
});

// ---------- agrupado (formato real de /v2/itemSearch y /v2/persons/search)
const ctx = { users: new Map([[22144333, "Juan Diego"]]), free: new Set([13493598]), pipes: { 16: "ONBOARDING", 9: "MX - SALES" }, o2s, web: "https://x.pipedrive.com" };
const EDU = { result_score: 0.17, item: { id: 747, type: "person", name: "Eduardo Miranda", phones: ["+52 222 429 2676"], emails: [], primary_email: null, visible_to: 3, owner: { id: 13493598 }, organization: null, custom_fields: [],
  notes: ["10/11/2026 (WhatsApp): Facundo le escribió para retomar lo del comedor del Tec"], update_time: "2026-11-11 15:19:57" } };
const ORG = { result_score: 0.36, item: { id: 45363, type: "organization", name: "Prepa Tec campus Cumbres", address: null, visible_to: 3, owner: { id: 22144333 }, custom_fields: [], notes: [] } };
const DEAL = { result_score: 1.32, item: { id: 5583, type: "deal", title: "Prepa Tec campus Cumbres (copia)", value: 4300, currency: "MXN", status: "open", visible_to: 3, owner: { id: 22144333 }, stage: { id: 156, name: "PENDING TO KICK OFF" }, pipeline: { id: 16 },
  person: { id: 23093, name: "Argelio Muñoz González" }, organization: { id: 45363, name: "Prepa Tec campus Cumbres", address: null }, custom_fields: ["Prepa Tec Campus Cumbres, Avenida Lince", "1000"], notes: [], is_archived: false } };
const LEAD = { result_score: 0.2, item: { type: "lead", id: "5a260de0-51c3-11ee", title: "COLEGIO JOSÉ VASCONCELOS", owner: { id: 23765898 }, person: { id: 1862, name: "Colegio José Vasconcelos" }, organization: { id: 1375, name: "Colegio José Vasconcelos" },
  phones: [], emails: [], custom_fields: ["primaria@jvasconcelos.edu.mx", "222 285 0575", "http://www.cjvasconcelospue.com/"], notes: ["Todo es por mail"], value: null, currency: null, visible_to: 3, is_archived: true } };
test("groupResults: agrupa por tipo, ordena los grupos por su mejor resultado y arma lo justo para mostrar", () => {
  const r = groupResults([EDU, ORG, DEAL, LEAD], { ...ctx, places: new Map([[45363, "Monterrey, México"]]) });
  assert.deepEqual(r.groups.map(g => g.label), ["Tratos", "Organizaciones", "Prospectos", "Personas"]);
  assert.equal(r.total, 4); assert.equal(r.more, false);
  const [deal] = r.groups[0].items, [org] = r.groups[1].items, [lead] = r.groups[2].items, [p] = r.groups[3].items;
  assert.deepEqual(p, { type: "person", id: 747, owner: "Cuenta general", url: "https://x.pipedrive.com/person/747", to: { kind: "person", id: 747 }, name: "Eduardo Miranda", phones: ["+52 222 429 2676"], emails: [], org: null });
  assert.deepEqual(org, { type: "organization", id: 45363, owner: "Juan Diego", url: "https://x.pipedrive.com/organization/45363", to: { kind: "school", id: "monterrey-prepa-tec-cumbres", orgId: 45363 }, name: "Prepa Tec campus Cumbres", addr: "", place: "Monterrey, México" });
  assert.equal(deal.status, "Abierto"); assert.equal(deal.pipeline, "ONBOARDING"); assert.equal(deal.stage, "PENDING TO KICK OFF");
  assert.deepEqual(deal.org, { id: 45363, name: "Prepa Tec campus Cumbres" }); assert.equal(deal.to.kind, "school");
  assert.equal(lead.archived, true); assert.equal(lead.owner, "", "usuario que no está (inactivo): sin nombre");
  assert.equal(lead.url, "https://x.pipedrive.com/leads/inbox/5a260de0-51c3-11ee");
  // nada de notas, campos personalizados, valores ni visibilidad crudos
  for (const it of r.groups.flatMap(g => g.items)) for (const k of ["notes", "custom_fields", "value", "visible_to", "result_score", "currency"]) assert.ok(!(k in it), `${it.type} sin ${k}`);
});
test("groupResults: organización con un teléfono en la dirección (pasa en la cuenta real) → sin dirección; la ciudad, de places", () => {
  const real = [{ id: 5744, address: "+52 246 466 3966" }, { id: 1370, address: null }, { id: 45108, address: "Av. Juárez 120, Tlaxcala" }].map(o => ({ result_score: 0.5, item: { type: "organization", name: "Colegio Americano", owner: { id: 13493598 }, ...o } }));
  const g = groupResults(real, { ...ctx, places: new Map([[5744, "Tlaxcala, México"], [1370, "Puebla, México"]]) }).groups[0].items;
  assert.deepEqual(g.map(o => [o.addr, o.place]), [["", "Tlaxcala, México"], ["", "Puebla, México"], ["Av. Juárez 120, Tlaxcala", ""]]);
});
test("groupResults: sin repetidos entre búsquedas (queda el de más puntaje); van todos y, con cursor, «hay más» en ese grupo", () => {
  const dupLow = { ...EDU, result_score: 0.01 };
  const many = Array.from({ length: 13 }, (_, i) => ({ result_score: 1 - i / 100, item: { id: 100 + i, type: "organization", name: `Org ${i}`, owner: { id: 1 } } }));
  const r = groupResults([dupLow, EDU, ...many, { result_score: 5, item: { id: 1, type: "product", name: "Producto" } }, { result_score: 1 }], ctx, { next: { organization: "eyJvZmZzZXQiOjUwfQ==" } });
  const people = r.groups.find(g => g.type === "person"), orgs = r.groups.find(g => g.type === "organization");
  assert.equal(people.items.length, 1); assert.equal(people.more, false); assert.equal(people.next, null);
  assert.equal(orgs.items.length, 13); assert.equal(orgs.more, true); assert.equal(orgs.next, "eyJvZmZzZXQiOjUwfQ==");
  assert.equal(orgs.items[0].name, "Org 0"); assert.equal(r.total, 14); assert.equal(r.more, true, "el total dice «o más»");
  assert.ok(!r.groups.some(g => g.type === "product"), "otros tipos (productos, archivos) no van");
  assert.deepEqual(groupResults([], ctx), { groups: [], total: 0, more: false });
  assert.ok(groupResults([EDU], ctx, { capped: true }).groups.every(g => g.more && !g.next), "búsqueda mezclada en su tope: puede haber más de cualquier tipo");
});
test("cleanCursor: solo texto opaco corto (lo que manda Pipedrive), nada raro", () => {
  assert.equal(cleanCursor("eyJmaWVsZCI6ImlkIiwidmFsdWUiOjUwfQ=="), "eyJmaWVsZCI6ImlkIiwidmFsdWUiOjUwfQ==");
  assert.equal(cleanCursor("50"), "50");
  for (const c of ["", null, 5, "a b", "x".repeat(601), "<script>", "a&term=x"]) assert.equal(cleanCursor(c), null, String(c));
});
test("hintFor: dónde coincide si no se ve (el teléfono en el campo del prospecto, una nota); nada si ya se ve", () => {
  const phone = searchPlan("2222850575");
  assert.equal(itemOut("lead", LEAD.item, { ...ctx, plan: phone, term: "222 285 0575" }).hint, "222 285 0575");
  assert.equal(itemOut("person", EDU.item, { ...ctx, plan: searchPlan("2224292676"), term: "2224292676" }).hint, undefined, "el teléfono ya se ve");
  const t = searchPlan("comedor del tec");
  assert.match(itemOut("person", EDU.item, { ...ctx, plan: t, term: "comedor del tec" }).hint, /retomar lo del comedor del Tec/);
  assert.equal(itemOut("organization", ORG.item, { ...ctx, plan: searchPlan("prepa tec"), term: "prepa tec" }).hint, undefined, "está en el nombre");
  assert.equal(hintFor({ notes: ["<b>Habló</b> con la <i>directora</i>"] }, ["x"], searchPlan("con la directora"), "con la directora"), "Habló con la directora", "sin HTML");
  const long = "x ".repeat(200) + "aguja" + " y".repeat(200);
  const h = hintFor({ notes: [long] }, [], searchPlan("aguja"), "aguja");
  assert.ok(h.startsWith("…") && h.endsWith("…") && h.includes("aguja") && h.length < 120, "un pedacito alrededor");
});

// ---------- de punta a punta con el Pipedrive de prueba
for (const k of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "PIPEDRIVE_API_TOKEN", "ANTHROPIC_API_KEY"]) delete process.env[k];
process.env.DEMO_MODE = "1";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ob-test-"));
const sales = await import("../lib/sales.js");
const pd = await import("../lib/pipedrive.js");
test("pdSearch (demo): «2224292676» encuentra a la persona sin organización y lleva a su ficha", async () => {
  for (const q of ["2224292676", "222 429 2676", "+52 222 429 2676"]) {
    const r = await sales.pdSearch(q);
    const p = r.groups.find(g => g.type === "person")?.items[0];
    assert.equal(p?.name, "Eduardo Miranda", q); assert.deepEqual(p.to, { kind: "person", id: 747 }); assert.equal(r.kind, "phone");
  }
});
test("pdSearch (demo): un teléfono que solo está escrito con espacios en el campo del prospecto aparece igual", async () => {
  const r = await sales.pdSearch("6145550101");
  const leads = r.groups.find(g => g.type === "lead")?.items || [];
  assert.ok(leads.some(l => l.title === "Esfer Salesianos Plantel Kennedy" && l.hint === "614 555 0101"), JSON.stringify(r.groups));
});
test("pdSearch (demo): copia de 60 s por término y error si es muy corto", async () => {
  const a = sales.pdSearch("Main Catering"), b = sales.pdSearch("main catering");
  assert.equal(a, b, "el mismo pedido");
  assert.equal((await a).groups[0].items[0].title, "Main Catering - Comedor Tec Puebla");
  await assert.rejects(sales.pdSearch("ab"), e => e.status === 400);
});
test("pdSearch (demo): si falla una de las búsquedas se muestra lo demás (partial); si fallan todas, error y no queda en la copia", async () => {
  const r = await sales.pdSearch("555 000 0503"); // la búsqueda general falla; personas por teléfono y «555 000 0503» responden
  assert.equal(r.partial, true); assert.deepEqual(r.groups, []);
  await assert.rejects(sales.pdSearch("pipedrive-caido"), e => e.status === 503 && /simulado/.test(e.message));
  await assert.rejects(sales.pdSearch("pipedrive-caido"), e => e.status === 503, "se vuelve a pedir (el error no se guardó)");
  assert.equal((await sales.pdSearch("Eduardo")).partial, undefined);
});
test("personCard (demo): datos, tratos (con motivo y fecha de la pérdida), prospectos, actividades y notas; 404 y 400", async () => {
  const p = await sales.personCard(747);
  assert.equal(p.name, "Eduardo Miranda"); assert.equal(p.org, null); assert.equal(p.owner, "Cuenta general");
  assert.deepEqual(p.phones, [{ value: "+52 222 429 2676", label: "work" }]);
  assert.equal(p.deals[0].title, "Main Catering - Comedor Tec Puebla"); assert.equal(p.deals[0].status, "Perdido"); assert.equal(p.deals[0].to, null);
  assert.equal(p.deals[0].reason, "No responde más"); assert.equal(p.deals[0].closed, "2024-09-02");
  assert.deepEqual(p.leads[0].to, { kind: "record", ref: "lead:demo-lead-tec-puebla" }); assert.equal(p.leads[0].archived, true, "los archivados también");
  assert.equal(p.pending.length, 1); assert.ok(p.done.length >= 2); assert.ok(p.done[0].date >= p.done[1].date, "hechas: lo último primero");
  assert.ok(p.notes.length >= 2); assert.deepEqual(p.missing, []);
  await assert.rejects(sales.personCard(99999999), e => e.status === 404);
  await assert.rejects(sales.personCard("abc"), e => e.status === 400);
  await assert.rejects(sales.personCard(-3), e => e.status === 400);
});
test("pdSearch (demo): la persona con organización abre su ficha (no la del colegio) y sus dos teléfonos se ven en Contactos", async () => {
  const r = await sales.pdSearch("laura.gomez@colegio-ejemplo.mx");
  const p = r.groups.find(g => g.type === "person").items[0];
  assert.equal(p.name, "Laura Gómez"); assert.deepEqual(p.to, { kind: "person", id: p.id }); assert.ok(p.org?.id);
  const card = await sales.personCard(p.id);
  assert.deepEqual(card.phones.map(x => x.value), ["+52 (55) 1234-5678", "55 8765 4321"]); assert.equal(card.org.id, p.org.id);
  const c = (await pd.personsForOrg(p.org.id)).find(x => x.name === "Laura Gómez");
  assert.deepEqual(c.phones, ["+52 (55) 1234-5678", "55 8765 4321"]); assert.equal(c.phone, "+52 (55) 1234-5678");
});
test("pdSearch (demo): un grupo por tipo con su cursor; «Ver más» trae la página siguiente sin repetidos; cursor raro, 400", async () => {
  const r = await sales.pdSearch("Colegio");
  const orgs = r.groups.find(g => g.type === "organization");
  assert.equal(orgs.items.length, 50); assert.equal(orgs.more, true); assert.ok(orgs.next); assert.equal(r.more, true);
  assert.ok(r.groups.every(g => g.items.length <= 50), "cada tipo con su tope: ninguno tapa a otro");
  const m = await sales.pdSearchMore("Colegio", "organization", orgs.next, r.term);
  assert.equal(m.type, "organization"); assert.ok(m.items.length > 0);
  const ids = new Set(orgs.items.map(x => x.id)); assert.ok(m.items.every(x => !ids.has(x.id)), "la página siguiente, no la misma");
  await assert.rejects(sales.pdSearchMore("Colegio", "product", null), e => e.status === 400);
  await assert.rejects(sales.pdSearchMore("Colegio", "organization", "a&b"), e => e.status === 400);
  await assert.rejects(sales.pdSearchMore("ab", "organization", null), e => e.status === 400);
});
test("cruzada con un colegio de la base: la organización, su prospecto y lo que se busque llevan al colegio (no a una copia pd-org)", async () => {
  const { schools, getMatch } = await import("../lib/store.js");
  let s = null, m = null;
  for (const x of schools.slice(0, 120)) { await sales.checkSchool(x.id).catch(() => {}); const mm = getMatch(x.id); if (mm?.orgId) { s = x; m = mm; break; } }
  assert.ok(s, "algún colegio cruzado en el demo");
  assert.equal((await sales.openRecord("org", m.orgId)).id, s.id, "openRecord(org) devuelve el colegio");
  const lead = await pd.createLead({ title: `${s.name} (prueba de búsqueda)`, ownerId: 1, orgId: m.orgId });
  const lr = await sales.openRecord("lead", lead.id);
  assert.equal(lr.id, s.id, "el prospecto abre el colegio"); assert.equal(lr.leadId, undefined);
  const r = await sales.pdSearch(`${s.name} (prueba`);
  const L = r.groups.find(g => g.type === "lead")?.items.find(x => x.id === lead.id);
  assert.deepEqual(L?.to, { kind: "school", id: s.id, orgId: m.orgId, leadId: lead.id });
  const r2 = await sales.pdSearch(s.name), O = r2.groups.find(g => g.type === "organization")?.items.find(x => x.id === m.orgId);
  assert.deepEqual(O?.to, { kind: "school", id: s.id, orgId: m.orgId }); assert.equal(O.place, [s.city, s.country].filter(Boolean).join(", "), "ciudad y país del colegio");
  const other = r2.groups.find(g => g.type === "organization")?.items.find(x => x.to.kind === "record");
  if (other) assert.ok(other.place, "las que no están cruzadas también traen su ciudad (orgsByIds)");
});
