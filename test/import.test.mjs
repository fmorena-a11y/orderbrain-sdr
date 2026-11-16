// Cargar base (lib/import.js, lib/xlsx.js, lib/bases.js): encabezado y columnas de las tres formas de planilla de un evento
// (inscriptos, reparto por SDR con el encabezado en la fila 3, estudio de mejores colegios), agrupado por institución,
// teléfonos AR/MX, «Otros contactos», «#ERROR!», lo que no es colegio privado, el link (nada de SSRF), el título del
// prospecto con el evento, la sesión «base» y, con el Pipedrive de prueba, el cruce y el prospecto creado. Datos inventados.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
for (const k of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "PIPEDRIVE_API_TOKEN", "ANTHROPIC_API_KEY", "GOOGLE_MAPS_API_KEY", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]) delete process.env[k];
process.env.DEMO_MODE = "1";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ob-test-"));
process.env.ENRICH_WAIT_MS = "50";
globalThis.fetch = async () => { throw new Error("sin red en la prueba"); };
const IM = await import("../lib/import.js");
const { readXlsx } = await import("../lib/xlsx.js");
const SH = await import("../lib/sheets.js");
const SS = await import("../lib/sessions.js");
const FIX = path.join(path.dirname(new URL(import.meta.url).pathname), "fixtures");
const csv = f => IM.parseCsv(fs.readFileSync(path.join(FIX, f), "utf8"));
const named = (headers, map) => Object.fromEntries(Object.entries(map).map(([k, j]) => [k, headers[j]]));
const detect = rows => { const h = IM.findHeader(rows); return { h, map: IM.detectColumns(rows[h], rows.slice(h + 1)), headers: rows[h] }; };

test("CSV: comillas, comas adentro, punto y coma y texto pegado con tabulaciones", () => {
  assert.deepEqual(IM.parseCsv('a,b,c\n"Robles, Fabiana","dijo ""hola""",3\r\n'), [["a", "b", "c"], ["Robles, Fabiana", 'dijo "hola"', "3"]]);
  assert.deepEqual(IM.parseCsv("x;y\n1;2"), [["x", "y"], ["1", "2"]]);
  assert.deepEqual(IM.parseCsv("Nombre\tColegio\nAna, Gómez\tColegio Uno"), [["Nombre", "Colegio"], ["Ana, Gómez", "Colegio Uno"]]);
});

test("Inscriptos: encabezado en la fila 1 y columnas por sinónimos", () => {
  const { h, map, headers } = detect(csv("base-inscriptos.csv"));
  assert.equal(h, 0);
  assert.deepEqual(named(headers, map), { name: "Nombre y apellido", email: "Email", phone: "Teléfono", inst: "Institucion Educativa", role: "Rol", type: "Tipo de organización", students: "Cantidad de alumnos" });
  // «ID» y «Cantidad de acompañantes» no son nada
  assert.ok(!Object.values(map).includes(0) && !Object.values(map).includes(8));
});

test("Reparto por SDR: encabezado en la fila 3, filas vacías, Contactado y los links de Pipedrive", () => {
  const rows = csv("base-reparto.csv"), { h, map, headers } = detect(rows);
  assert.equal(h, 2);
  const n = named(headers, map);
  assert.equal(n.inst, "Nombre de la institución educativa que representa");
  assert.equal(n.name, "Nombre y apellido"); assert.equal(n.email, "Correo electrónico"); assert.equal(n.phone, "Número de Teléfono");
  assert.equal(n.role, "Cargo o rol que desempeña en la institución"); assert.equal(n.contacted, "Contactado");
  assert.equal(n.pd, "Pipe Drive"); assert.equal(n.pdPerson, "Tipo prospecto persona");
  const b = IM.buildBase(rows, { header: h, map, country: "Argentina", city: "Mendoza" });
  assert.equal(b.items.length, 4);
  const andino = b.items.find(i => i.name === "Colegio Andino del Sur");
  assert.deepEqual(andino.pd.map(x => x.kind), ["lead", "person"]);
  assert.equal(andino.pd[0].id, "0d5e0a1c-0000-4000-8000-00000000a001");
  assert.equal(andino.contacted, false);
  assert.equal(b.items.find(i => i.name === "Colegio Congreso").contacted, true);
});

test("Mejores colegios (estudio): «Otros contactos» con « | » y « – », zona, prioridad y «#ERROR!» como vacío", () => {
  const rows = csv("base-estudio.csv"), { h, map, headers } = detect(rows);
  const n = named(headers, map);
  assert.equal(n.inst, "Institución"); assert.equal(n.city, "Zona"); assert.equal(n.students, "Tamaño (alumnos)"); assert.equal(n.name, "Decisor principal");
  assert.equal(n.others, "Otros contactos con datos"); assert.equal(n.pd, "Pipe: link"); assert.equal(n.prio, "Prioridad"); assert.equal(n.next, "Próximo paso sugerido");
  // «Pipe: estado», «Pipe: dueño», «Score» y «Ya en Interesados» no se toman
  for (const x of ["Pipe: estado", "Pipe: dueño", "Score", "Ya en Interesados"]) assert.ok(!Object.values(n).includes(x), x);
  const b = IM.buildBase(rows, { header: h, map, country: "Argentina", city: "Mendoza" });
  const cerros = b.items.find(i => i.name === "Colegio Los Cerros del Sol");
  assert.equal(cerros.city, "Godoy Cruz");
  assert.deepEqual(cerros.contacts.map(c => [c.name, c.role, c.phone, c.email]), [
    ["Sofía Benítez", "Representante legal", "+5492615550104", "sbenitez@cerrosdelsol.example"],
    ["Tomás Arce", "Administrador", "+5492615550120", ""],
    ["Elena Castro", "Secretaria", "", "ecastro@cerrosdelsol.example"]]);
  assert.equal(cerros.pd[0].kind, "organization"); assert.equal(cerros.pd[0].id, 922);
  assert.ok(cerros.prio.why.includes("Prioridad alta en la planilla"));
  // el teléfono «#ERROR!» queda vacío (la directora sigue con su mail)
  const congreso = b.items.find(i => i.name === "Colegio Congreso"), fabiana = congreso.contacts.find(c => c.name === "Fabiana Robles");
  assert.equal(fabiana.phone, ""); assert.equal(fabiana.email, "fabiana.robles@congreso.example");
  assert.equal(congreso.contacts[0].name, "Fabiana Robles"); // la del estudio (decisor principal) primero
});

test("agrupa por institución: mayúsculas, acentos y «Colegio …» = el mismo; nombre «Apellido, Nombre» se arregla", () => {
  const rows = csv("base-inscriptos.csv"), { h, map } = detect(rows);
  const b = IM.buildBase(rows, { header: h, map, country: "Argentina", city: "Mendoza" });
  assert.equal(b.counts.people, 14); assert.equal(b.items.length, 11);
  const congreso = b.items.find(i => i.key === "colegio congreso");
  assert.equal(congreso.name, "Colegio Congreso"); // «COLEGIO CONGRESO» entra en el mismo
  assert.deepEqual(congreso.contacts.map(c => c.name), ["Fabiana Robles", "Martín Quiroga", "Lucía Ferrer"]);
  assert.equal(congreso.contacts[0].decisor, true); assert.equal(congreso.contacts[2].decisor, false);
  // «Marista San Benito Ejemplo» y «Colegio Marista San Benito Ejemplo»: una sola, con los dos
  const marista = b.items.filter(i => /marista san benito/i.test(i.name));
  assert.equal(marista.length, 1); assert.equal(marista[0].name, "Colegio Marista San Benito Ejemplo"); assert.equal(marista[0].contacts.length, 2);
  assert.equal(IM.instKey("Colegio Marista San José"), IM.instKey("colegio marista san jose"));
  assert.equal(IM.instKey("Esc. Nº 12 San Martín"), IM.instKey("Escuela N 12 San Martin"));
  assert.equal(IM.personName("Fabiana, Robles"), "Fabiana Robles"); assert.equal(IM.personName("JUAN PEREZ"), "Juan Perez");
  // ordenadas por prioridad (explicada): Congreso arriba (alumnos, privado, 3 inscriptos, la directora)
  assert.equal(b.items[0].name, "Colegio Congreso");
  assert.deepEqual(b.items[0].prio.why, ["601 a 1.000 alumnos", "Privado", "3 inscriptos", "Se inscribió quien decide (Directora)"]);
  assert.equal(b.items[0].prio.level, "alta");
});

test("lo que no es colegio privado queda afuera (público, supervisión DEP, universidad) y se puede ver igual", () => {
  const rows = csv("base-inscriptos.csv"), { h, map } = detect(rows), b = IM.buildBase(rows, { header: h, map, country: "Argentina" });
  const out = Object.fromEntries(b.items.filter(i => i.out).map(i => [i.name, i.kind]));
  assert.deepEqual(out, { "Escuela Nº 1-901 Ejemplo": "public", "Supervisión DEP Sección 9": "office", "Universidad de Ejemplo del Cuyo": "uni" });
  assert.equal(b.counts.out, 3);
  assert.equal(IM.instKind("Colegio Privado / Particular", "Colegio Uno"), "private");
  assert.equal(IM.instKind("Colegio Publico", "Escuela Dos"), "public");
  assert.equal(IM.instKind("", "Escuela Tres"), "");
  assert.equal(IM.instKind("Público de gestión privada", "Colegio Cuatro"), "private");
});

test("teléfonos con el prefijo del país: Argentina (celular con 9, sin 0 ni 15) y México", () => {
  assert.equal(IM.normPhone("5492615532690", "Argentina"), "+5492615532690");
  assert.equal(IM.normPhone("2613001468", "Argentina"), "+5492613001468");
  assert.equal(IM.normPhone("0261 15-300-1468", "Argentina"), "+5492613001468");
  assert.equal(IM.normPhone("+54 9 261 553-2690", "Argentina"), "+5492615532690");
  assert.equal(IM.normPhone("222 285 0575", "México"), "+522222850575");
  assert.equal(IM.normPhone("+52 1 222 285 0575", "México"), "+522222850575");
  assert.equal(IM.normPhone("52 222 285 0575", "México"), "+522222850575");
  assert.equal(IM.normPhone("#ERROR!", "Argentina"), "");
  assert.equal(IM.normPhone("123", "Argentina"), "");
  assert.equal(IM.waLink("+5492615532690"), "https://wa.me/5492615532690");
});

test("«Otros contactos»: varios con « | », partes con « – », teléfono y mail donde estén", () => {
  assert.deepEqual(IM.splitOthers("Juan Pérez – Rector – +54 9 261 555 0101 | Ana Gómez – Administradora – ana@colegio.example | #ERROR!", "Argentina"), [
    { name: "Juan Pérez", role: "Rector", phone: "+5492615550101", email: "" }, { name: "Ana Gómez", role: "Administradora", phone: "", email: "ana@colegio.example" }]);
  for (const v of ["#ERROR!", "#N/A", "#REF!", "N/A", "-", "  "]) assert.equal(IM.cleanCell(v), "", v);
  assert.deepEqual(IM.parseStudents("601 a 1.000 alumnos"), { min: 601, max: 1000, label: "601 a 1.000 alumnos" });
  assert.equal(IM.parseStudents("Más de 1.000 alumnos").min, 1001);
  assert.equal(IM.parseStudents("Hasta 300 alumnos").max, 300);
  assert.equal(IM.yesNo("TRUE"), true); assert.equal(IM.yesNo("FALSE"), false); assert.equal(IM.yesNo(""), null);
  assert.equal(IM.isDecisor("Representante legal"), true); assert.equal(IM.isDecisor("Directora de nivel"), true); assert.equal(IM.isDecisor("Docente"), false); assert.equal(IM.isDecisor("Administrativo"), false);
});

test("el link: solo docs.google.com/spreadsheets/d/<id> por https (nada de otros hosts: sin SSRF)", () => {
  const id = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
  assert.deepEqual(IM.sheetLink(`https://docs.google.com/spreadsheets/d/${id}/edit#gid=123`), { id, gid: "123" });
  assert.deepEqual(IM.sheetLink(`https://docs.google.com/spreadsheets/u/0/d/${id}/edit?gid=7`), { id, gid: "7" });
  assert.deepEqual(IM.sheetLink(`  https://docs.google.com/spreadsheets/d/${id}  `), { id, gid: null });
  for (const bad of [`http://docs.google.com/spreadsheets/d/${id}`, `https://docs.google.com.evil.example/spreadsheets/d/${id}`, `https://evil.example/spreadsheets/d/${id}`,
    `https://docs.google.com@evil.example/spreadsheets/d/${id}`, `https://user:pw@docs.google.com/spreadsheets/d/${id}`, `https://docs.google.com:8443/spreadsheets/d/${id}`,
    `https://docs.google.com/document/d/${id}`, "https://docs.google.com/spreadsheets/d/corto", "https://127.0.0.1/spreadsheets/d/" + id, "file:///etc/passwd", "javascript:alert(1)", "", null])
    assert.equal(IM.sheetLink(bad), null, String(bad));
  assert.equal(IM.exportCsvUrl(id, "123"), `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=123`);
  // redirecciones: solo docs.google.com y *.googleusercontent.com por https
  assert.ok(IM.okRedirect("https://doc-08-4o-sheets.googleusercontent.com/export/abc?format=csv"));
  assert.ok(IM.okRedirect("https://docs.google.com/spreadsheets/d/x/export"));
  for (const bad of ["https://googleusercontent.com.evil.example/x", "http://doc-1.googleusercontent.com/x", "https://169.254.169.254/latest", "https://evil.example/x", "https://a.b.googleusercontent.com/x"]) assert.equal(IM.okRedirect(bad), false, bad);
  assert.ok(IM.isLoginRedirect("https://accounts.google.com/ServiceLogin?continue=x"));
});

test("pestañas y título de la vista htmlview; evento y lugar desde el título del archivo", () => {
  const html = `<title>Base de Inscriptos EduExperience Mendoza 2026 (OrderEAT) (1) - Google Drive</title><script>items.push({name: "Inscriptos", pageUrl: "https:\\/\\/docs.google.com\\/x?gid\\x3d0", gid: "0",initialSheet: ("0" == gid)});items.push({name: "Mejores Colegios (Estudio)", pageUrl: "u", gid: "1854", initialSheet: false});</script>`;
  assert.deepEqual(IM.tabsFromHtml(html), [{ name: "Inscriptos", gid: "0" }, { name: "Mejores Colegios (Estudio)", gid: "1854" }]);
  assert.equal(IM.titleFromHtml(html), "Base de Inscriptos EduExperience Mendoza 2026 (OrderEAT) (1)");
  assert.equal(IM.eventFromTitle("Base de Inscriptos EduExperience Mendoza 2026 (OrderEAT) (1)"), "EduExperience Mendoza 2026");
  assert.equal(IM.eventFromTitle("Copia de Asistentes Expo Colegios CDMX 2026.xlsx"), "Expo Colegios CDMX 2026");
  assert.deepEqual(IM.placeFromText("EduExperience Mendoza 2026"), { city: "Mendoza", country: "Argentina" });
  assert.deepEqual(IM.placeFromText("Expo Colegios CDMX 2026"), { city: "Ciudad de México", country: "México" });
});

test("el prospecto que crea la app lleva el evento al final; quién lo tiene en Pipedrive", () => {
  assert.equal(IM.leadTitle("Colegio Marista San José", "EduExperience Mendoza 2026"), "Colegio Marista San José (EduExperience Mendoza 2026)");
  assert.equal(IM.leadTitle("Colegio Uno (EduExperience Mendoza 2026)", "EduExperience Mendoza 2026"), "Colegio Uno (EduExperience Mendoza 2026)");
  assert.equal(IM.leadTitle("Colegio Uno", ""), "Colegio Uno");
  assert.ok(IM.leadTitle("x".repeat(400), "Evento 2026").endsWith(" (Evento 2026)") && IM.leadTitle("x".repeat(400), "Evento 2026").length <= 255);
  const free = new Set([13493598]);
  assert.equal(IM.standing({ state: "lead", ownerId: 1 }, 1, { free }).label, "Es tuyo · prospecto");
  assert.equal(IM.standing({ state: "lead", ownerId: 3, owner: "Agustín" }, 1, { free }).label, "Es de Agustín: coordinar con quien lo tiene");
  assert.equal(IM.standing({ state: "lead", ownerId: 3 }, 1, { free }).workable, false);
  assert.equal(IM.standing({ state: "client" }, 1).label, "Cliente: no contactar");
  assert.equal(IM.standing({ state: "churn" }, 1).workable, false);
  assert.equal(IM.standing({ state: "org", ownerId: 13493598 }, 1, { free }).who, "free");
  assert.equal(IM.standing({ state: "none" }, 1).workable, true);
  assert.equal(IM.standing(null, 1).workable, false);
  // un dominio de mail que aparece en dos instituciones no dice de qué colegio es
  assert.deepEqual([...IM.sharedDomains([{ key: "a", contacts: [{ email: "x@correo.example" }, { email: "y@a.example" }] }, { key: "b", contacts: [{ email: "z@correo.example" }] }])], ["correo.example"]);
});

test("la sesión «base»: origen con el nombre del evento y las fichas bx:", () => {
  const s = SS.newSession({ name: "EduExperience Mendoza 2026", origin: { kind: "base", key: "base:abc123abc123", filters: { evento: "EduExperience Mendoza 2026" } }, items: [{ ref: "bx:abc123abc123-4", name: "Colegio Uno" }, { ref: "mendoza-colegio-congreso" }] });
  assert.equal(s.origin.kind, "base"); assert.equal(s.name, "EduExperience Mendoza 2026"); assert.equal(s.items[0].ref, "bx:abc123abc123-4");
  assert.equal(SS.ORIGINS.base, "Base cargada");
  assert.ok(SS.refsFor("bx-abc123abc123-4").has("bx:abc123abc123-4"));
});

// un .xlsx mínimo armado acá (zip con deflate): texto compartido, texto en línea, número, error y un link de Pipedrive
function zip(files) {
  const parts = [], cd = []; let off = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text), comp = zlib.deflateRawSync(data), nb = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nb.length, 26);
    parts.push(lh, nb, comp);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
    cd.push(ch, nb); off += 30 + nb.length + comp.length;
  }
  const cdb = Buffer.concat(cd), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(cd.length / 2, 8); end.writeUInt16LE(cd.length / 2, 10); end.writeUInt32LE(cdb.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cdb, end]);
}
test("Excel (.xlsx): pestañas, filas vacías arriba, valores y el link de Pipedrive de una celda", () => {
  const buf = zip({
    "xl/workbook.xml": `<workbook xmlns:r="r"><sheets><sheet name="FACU" sheetId="1" r:id="rId1"/><sheet name="Oculta" sheetId="2" state="hidden" r:id="rId2"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Type="ws" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="ws" Target="worksheets/sheet2.xml"/></Relationships>`,
    "xl/sharedStrings.xml": `<sst><si><t>Nombre y apellido</t></si><si><t>Institución</t></si><si><t>Teléfono</t></si><si><t>Pipe Drive</t></si><si><r><t>Ana, </t></r><r><t>Gómez</t></r></si><si><t>Colegio Uno &amp; Dos</t></si><si><t>Ver prospecto</t></si></sst>`,
    "xl/worksheets/sheet1.xml": `<worksheet><sheetData><row r="3"><c r="A3" t="s"><v>0</v></c><c r="B3" t="s"><v>1</v></c><c r="C3" t="s"><v>2</v></c><c r="D3" t="s"><v>3</v></c></row><row r="4"><c r="A4" t="s"><v>4</v></c><c r="B4" t="s"><v>5</v></c><c r="C4"><v>5492615550199</v></c><c r="D4" t="s"><v>6</v></c><c r="E4" t="e"><v>#REF!</v></c></row><row r="5"><c r="A5" t="inlineStr"><is><t>Luis Paz</t></is></c><c r="B5" t="s"><v>5</v></c></row></sheetData><hyperlinks><hyperlink ref="D4" r:id="rId9"/></hyperlinks></worksheet>`,
    "xl/worksheets/_rels/sheet1.xml.rels": `<Relationships><Relationship Id="rId9" Type="hl" Target="https://ordereat.pipedrive.com/leads/inbox/0d5e0a1c-0000-4000-8000-00000000a009" TargetMode="External"/></Relationships>`,
    "xl/worksheets/sheet2.xml": `<worksheet><sheetData/></worksheet>`,
  });
  const x = readXlsx(buf);
  assert.deepEqual(x.tabs.map(t => t.name), ["FACU"]);
  const rows = x.tabs[0].rows;
  assert.deepEqual(rows[0], []); assert.deepEqual(rows[2], ["Nombre y apellido", "Institución", "Teléfono", "Pipe Drive"]);
  assert.deepEqual(rows[3], ["Ana, Gómez", "Colegio Uno & Dos", "5492615550199", "https://ordereat.pipedrive.com/leads/inbox/0d5e0a1c-0000-4000-8000-00000000a009", ""]);
  const { h, map } = detect(rows), b = IM.buildBase(rows, { header: h, map, country: "Argentina" });
  assert.equal(h, 2); assert.equal(b.items.length, 1); assert.equal(b.items[0].contacts.length, 2); assert.equal(b.items[0].pd[0].kind, "lead");
  assert.throws(() => readXlsx(Buffer.from("no es un zip")), /Excel/);
});

test("demo: el link de ejemplo carga las tres pestañas; uno privado da sheet_private (sin salir a la red)", async () => {
  const r = await SH.readSheet(SH.DEMO_URL, { demo: true });
  assert.deepEqual(r.tabs.map(t => t.name), ["Inscriptos", "FACU", "Mejores Colegios (Estudio)"]);
  await assert.rejects(SH.readSheet(`https://docs.google.com/spreadsheets/d/${SH.DEMO_PRIVATE}/edit`, { demo: true }), e => e.code === "sheet_private");
  await assert.rejects(SH.readSheet("https://evil.example/spreadsheets/d/xxxxxxxxxxxxxxxxxxxxxxxx", { demo: true }), e => e.code === "sheet_link");
});

test("demo de punta a punta: guardar la base, cruzar con Pipedrive (reglas de «Antes de crear») y crear el prospecto con el evento", async () => {
  const B = await import("../lib/bases.js");
  const sales = await import("../lib/sales.js");
  const pd = await import("../lib/pipedrive.js");
  const me = { email: "demo@example.com", name: "Demo", pdUserId: 1 };
  const d = await B.makeDraft(me.email, { ...SH.demoSheet(), kind: "sheet", sheetId: SH.DEMO_SHEET });
  assert.equal(d.event, "EduExperience Mendoza 2026"); assert.equal(d.country, "Argentina"); assert.equal(d.city, "Mendoza");
  assert.equal(d.tabs[d.pick].name, "Inscriptos");
  // corregir una columna: sin «Tipo», nadie queda afuera por público
  const p = await B.analyze(me.email, { draft: d.id, tab: 0, map: { ...d.tabs[0].map, type: null }, country: "Argentina", city: "Mendoza" });
  assert.equal(p.map.type, undefined); assert.equal(p.counts.out, 2); // la supervisión y la universidad, por el nombre
  // otra persona no usa tu borrador
  await assert.rejects(B.analyze("otra@example.com", { draft: d.id, tab: 0 }), e => e.status === 404);
  const b = await B.saveBase(me, { draft: d.id, tab: 0, country: "Argentina", city: "Mendoza", event: "EduExperience Mendoza 2026" });
  // «Colegio Congreso» está en la base de colegios de la app; «Colegio Marista San Benito Ejemplo» no: ficha bx
  assert.equal(b.items.find(i => i.name === "Colegio Congreso").ref, "mendoza-colegio-congreso");
  const marista = b.items.find(i => /Marista/.test(i.name));
  assert.match(marista.ref, /^bx:[0-9a-f]{12}-\d+$/);
  let left = 1;
  for (let k = 0; k < 5 && left; k++) left = (await B.checkFor(me, b.id, true, { n: 8 })).left;
  assert.equal(left, 0);
  const v = B.view(await B.readFor(me.email, b.id, false), me), by = Object.fromEntries(v.items.map(i => [i.name, i]));
  assert.equal(by["Colegio Andino del Sur"].st.key, "other"); // prospecto sin organización de Agustín (demo)
  assert.match(by["Colegio Andino del Sur"].st.label, /^Es de Agustín/);
  assert.equal(by["Instituto Cuyo Andino"].st.label, "Cliente: no contactar");
  assert.equal(by["Colegio Los Cerros del Sol"].st.key, "free"); // organización de la cuenta general
  assert.equal(by["Escuela Nº 1-901 Ejemplo"].x, null); // afuera: no se revisa
  assert.ok(by[marista.name].st.workable);
  // otra persona sin acceso de líder no la ve
  await assert.rejects(B.readFor("otra@example.com", b.id, false), e => e.status === 403);
  // un líder con esa persona en su gente sí (y en su lista de «De tu gente»)
  assert.equal((await B.readFor("lider@example.com", b.id, { ids: new Set(), emails: new Set(["demo@example.com"]) })).id, b.id);
  assert.deepEqual((await B.listFor("lider@example.com", { ids: new Set(), emails: new Set(["demo@example.com"]) })).team.map(x => x.id), [b.id]);
  assert.deepEqual((await B.listFor("otra@example.com", false)).team, []);
  // la ficha bx se rearma y muestra los contactos de la planilla; al registrar, el prospecto lleva el evento
  const sid = marista.ref.replace(/^bx:/, "bx-");
  assert.ok(await sales.ensureRecord(sid));
  const info = await B.baseFor(sid, me.email);
  assert.equal(info.bases[0].base.event, "EduExperience Mendoza 2026"); assert.equal(info.bases[0].contacts[0].name, "Gabriel Funes");
  assert.deepEqual((await B.baseFor(sid, "otra@example.com")).bases, []); // la ficha de la base de otra persona: sin sus contactos
  const c = info.bases[0].contacts[0];
  const r = await sales.logContact(sid, me, { outcome: "no_answer", channel: "call", contact: { name: c.name, role: c.role, phone: c.phone, email: c.email } }, "America/Argentina/Buenos_Aires");
  assert.equal(r.where.kind, "lead");
  assert.equal(r.where.title, "Colegio Marista San Benito Ejemplo (EduExperience Mendoza 2026)");
  const lead = await pd.getLead(r.where.id);
  assert.ok(lead.personId, "con la persona del contacto elegido");
  assert.equal((await pd.getPerson(lead.personId)).name, "Gabriel Funes (Rector)");
  // un colegio de la base de la app que está en tu base: también con el evento
  const r2 = await sales.logContact("mendoza-colegio-nuestra-senora-de-la-consolata", me, { outcome: "no_answer", channel: "call" }, "America/Argentina/Buenos_Aires");
  assert.equal(r2.where.title, "Colegio Nuestra Señora de la Consolata (EduExperience Mendoza 2026)");
});
