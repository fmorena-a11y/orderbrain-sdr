// Asistente en el navegador (lo puro de public/js/chatfmt.js): Markdown seguro, CSV, texto para Google Sheets, .xlsx,
// «exportá» y el idioma del dictado. Pedido del líder de SDR: «que sea más lindo a la vista» y «poder exportar».
import { test } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { renderMd, tableCsv, tableTsv, tableXlsx, zipStore, crc32, fileName, exportIntent, speechLang, speechError, phoneHref, colName, sheetName } from "../public/js/chatfmt.js";
import { unzip, readXlsx } from "../lib/xlsx.js";

const tags = html => [...html.matchAll(/<\/?([a-z0-9]+)/gi)].map(m => m[1].toLowerCase());
const ALLOWED = new Set(["p", "br", "ul", "ol", "li", "h4", "strong", "em", "code", "a", "hr", "blockquote"]);

test("renderMd: escapa todo lo que no es Markdown (script, onerror, javascript:)", () => {
  const h = renderMd(`<script>alert(1)</script>\n<img src=x onerror="alert(1)">\n[clic](javascript:alert)\n[otro](JaVaScRiPt:alert)\n[data](data:text/html;base64,PHNjcmlwdD4=)\n<a href="javascript:x">y</a>\n**<b>negrita</b>**\n\`<i>code</i>\``);
  assert.ok(!/<script|<img|<b>|<i>|<a href="javascript/i.test(h), h);
  assert.ok(!/href="(javascript|data):/i.test(h), h);
  assert.ok(!/<[^>]*\son\w+=/i.test(h), "ningún atributo on*");
  assert.ok(tags(h).every(t => ALLOWED.has(t)), tags(h).join(","));
  assert.match(h, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(h, /clic/); // el texto del link peligroso queda como texto
  assert.match(h, /<strong>&lt;b&gt;negrita&lt;\/b&gt;<\/strong>/);
  assert.match(h, /<code>&lt;i&gt;code&lt;\/i&gt;<\/code>/);
  // comillas en una URL no cortan el atributo
  const q = renderMd(`[x](https://a.com/"onmouseover="alert(1))`);
  assert.ok(!/<a [^>]*onmouseover/i.test(q), q);
});

test("renderMd: párrafos, saltos, listas, títulos, negrita, itálica y links", () => {
  const h = renderMd("### Hoy\nTenés **3 llamadas** y *una* demo.\nSegunda línea.\n\n- **10:00** Colegio A\n- Colegio B\n  - sede norte\n\n1. Primero\n2. Segundo\n\nMirá [la ficha](https://ordereat.pipedrive.com/deal/12?a=1&b=2).");
  assert.match(h, /^<h4 class="md-h">Hoy<\/h4>/);
  assert.match(h, /<p>Tenés <strong>3 llamadas<\/strong> y <em>una<\/em> demo\.<br>Segunda línea\.<\/p>/);
  assert.match(h, /<ul><li><strong>10:00<\/strong> Colegio A<\/li><li>Colegio B<ul><li>sede norte<\/li><\/ul><\/li><\/ul>/);
  assert.match(h, /<ol><li>Primero<\/li><li>Segundo<\/li><\/ol>/);
  assert.match(h, /<a href="https:\/\/ordereat\.pipedrive\.com\/deal\/12\?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">la ficha<\/a>\./);
  // una lista con viñetas seguida de una numerada son dos listas; la numeración escrita se respeta
  assert.equal(renderMd("- a\n1. b\n\n3. c"), "<ul><li>a</li></ul><ol><li>b</li></ol><ol start=\"3\"><li>c</li></ol>");
  // snake_case y asteriscos sueltos no se vuelven itálica
  assert.equal(renderMd("school_id y 3 * 4"), "<p>school_id y 3 * 4</p>");
});

test("renderMd: teléfonos, mails y direcciones sueltas como links; fechas y números no", () => {
  const h = renderMd("Llamá al +52 222 285 0575 o al (261) 412-3456, escribí a direccion@colegio.edu.mx o mirá https://colegio.edu.mx/contacto.");
  assert.match(h, /<a href="tel:\+522222850575">\+52 222 285 0575<\/a>/);
  assert.match(h, /<a href="tel:2614123456">\(261\) 412-3456<\/a>/);
  assert.match(h, /<a href="mailto:direccion@colegio\.edu\.mx">direccion@colegio\.edu\.mx<\/a>/);
  assert.match(h, /<a href="https:\/\/colegio\.edu\.mx\/contacto" target="_blank" rel="noopener noreferrer">https:\/\/colegio\.edu\.mx\/contacto<\/a>\./);
  const n = renderMd("El 2026-11-16 a las 10:30, 1.500 alumnos, DNI 12.345.678, ciclo 2025-2026.");
  assert.ok(!n.includes("<a "), n);
  assert.equal(phoneHref("16/11/2026"), null);
  assert.equal(phoneHref("+54 9 261 412 3456"), "tel:+5492614123456");
  // un link [..](tel:) y [..](mailto:) se respetan
  assert.match(renderMd("[Rosa](tel:+5492614123456)"), /<a href="tel:\+5492614123456">Rosa<\/a>/);
});

const T = {
  title: "Tus actividades de hoy · 16/11",
  columns: [{ label: "Fecha", type: "date" }, { label: "Hora", type: "time" }, { label: "Asunto", type: "text" }, { label: "Prioridad", type: "number" }, { label: "Pipedrive", type: "url" }],
  rows: [
    ["2026-11-16", "10:00", "Llamar; \"Colegio\" Andino\ncon salto", 72.5, "https://ordereat.pipedrive.com/deal/1"],
    ["2026-11-17", "", "=HYPERLINK(\"http://x\")", 3, ""],
    ["", "", "+52 222 285 0575", "", ""],
  ],
};

test("CSV para Excel en español: BOM, «;», comillas, saltos y fórmulas neutralizadas", () => {
  const csv = tableCsv(T);
  assert.ok(csv.startsWith("\uFEFF"));
  const lines = csv.slice(1).split("\r\n");
  assert.equal(lines[0], "Fecha;Hora;Asunto;Prioridad;Pipedrive");
  // el salto de línea queda adentro de las comillas (las filas se separan con \r\n)
  assert.equal(lines[1], "16/11/2026;10:00;\"Llamar; \"\"Colegio\"\" Andino\ncon salto\";72,5;https://ordereat.pipedrive.com/deal/1");
  assert.equal(lines[2], "17/11/2026;;\"'=HYPERLINK(\"\"http://x\"\")\";3;");
  assert.equal(lines[3], ";;'+52 222 285 0575;;");
  assert.ok(csv.endsWith("\r\n"));
});

test("texto para Google Sheets: tabulaciones, encabezados, una fila por línea y sin fórmulas", () => {
  const tsv = tableTsv(T).split("\n");
  assert.equal(tsv.length, 4);
  assert.equal(tsv[0], "Fecha\tHora\tAsunto\tPrioridad\tPipedrive");
  assert.equal(tsv[1], "2026-11-16\t10:00\tLlamar; \"Colegio\" Andino con salto\t72.5\thttps://ordereat.pipedrive.com/deal/1");
  assert.equal(tsv[2].split("\t")[2], "'=HYPERLINK(\"http://x\")");
  assert.equal(tsv[3].split("\t")[2], "'+52 222 285 0575");
});

test(".xlsx: zip válido (CRC, directorio central) que lee lib/xlsx.js y con las piezas que pide Excel", () => {
  const buf = Buffer.from(tableXlsx(T));
  assert.equal(buf.readUInt32LE(0), 0x04034b50);
  const z = unzip(buf);
  for (const n of ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/worksheets/sheet1.xml"]) assert.ok(z.has(n), n);
  // CRC de cada archivo, como lo revisa Excel
  for (let p = 0; p + 4 <= buf.length && buf.readUInt32LE(p) === 0x04034b50;) {
    const crc = buf.readUInt32LE(p + 14), size = buf.readUInt32LE(p + 18), nl = buf.readUInt16LE(p + 26);
    assert.equal(crc32(buf.subarray(p + 30 + nl, p + 30 + nl + size)), crc);
    p += 30 + nl + size;
  }
  const sheet = z.get("xl/worksheets/sheet1.xml")().toString("utf8");
  assert.match(sheet, /<c r="A2" s="2"><v>46342<\/v><\/c>/); // 16/11/2026 como fecha de Excel
  assert.match(sheet, /<c r="D2"><v>72.5<\/v><\/c>/);
  assert.match(sheet, /<autoFilter ref="A1:E4"\/>/);
  assert.ok(!sheet.includes("<f>"), "nunca fórmulas");
  const wb = readXlsx(buf);
  assert.equal(wb.tabs[0].name, "Tus actividades de hoy · 16 11");
  const rows = wb.tabs[0].rows;
  assert.deepEqual(rows[0], ["Fecha", "Hora", "Asunto", "Prioridad", "Pipedrive"]);
  assert.equal(rows[1][2], "Llamar; \"Colegio\" Andino\ncon salto");
  assert.equal(rows[2][2], "=HYPERLINK(\"http://x\")"); // texto en línea: Excel no lo calcula
  assert.equal(rows[3][2], "+52 222 285 0575");
  // los XML se pueden leer
  for (const [n, f] of z) assert.match(f().toString("utf8"), /^<\?xml version="1.0"/, n);
  assert.equal(colName(0), "A"); assert.equal(colName(25), "Z"); assert.equal(colName(26), "AA"); assert.equal(colName(701), "ZZ");
  assert.equal(sheetName("a/b:c*d?e[f]g\\h"), "a b c d e f g h");
});

test("zipStore: lo descomprime cualquier lector (también con zlib a mano)", () => {
  const z = zipStore([{ name: "a.txt", data: "hola ñandú" }, { name: "b/c.xml", data: "<x/>" }]);
  const files = unzip(Buffer.from(z));
  assert.equal(files.get("a.txt")().toString("utf8"), "hola ñandú");
  assert.equal(files.get("b/c.xml")().toString("utf8"), "<x/>");
  assert.equal(crc32(Buffer.from("123456789")), 0xCBF43926);
  assert.ok(zlib); // sin compresión: método 0
});

test("nombre de archivo y «exportá» sin otro pedido", () => {
  assert.equal(fileName("Tus actividades de hoy · 16/11", "xlsx"), "Tus actividades de hoy 16-11.xlsx");
  assert.equal(fileName("", "csv"), "tabla.csv");
  assert.deepEqual(exportIntent("Exportá"), { format: "xlsx" });
  assert.deepEqual(exportIntent("pasalo a un Excel"), { format: "xlsx" });
  assert.deepEqual(exportIntent("¿Me lo llevás a Google Sheets?"), { format: "sheets" });
  assert.deepEqual(exportIntent("armame una hoja de cálculo"), { format: "sheets" });
  assert.deepEqual(exportIntent("descargalo en CSV por favor"), { format: "csv" });
  assert.equal(exportIntent("exportá las actividades de mañana"), null); // pide otra lista: va al asistente
  assert.equal(exportIntent("¿qué tengo para hoy?"), null);
  assert.equal(exportIntent("pasame el teléfono del colegio"), null);
});

test("dictado: idioma y mensajes", () => {
  assert.equal(speechLang("es-MX"), "es-MX");
  assert.equal(speechLang("es-419"), "es-419");
  assert.equal(speechLang("es"), "es-AR");
  assert.equal(speechLang("en-US"), "es-AR");
  assert.equal(speechLang(undefined), "es-AR");
  assert.match(speechError("not-allowed"), /candado.*Micrófono.*Permitir/);
  assert.match(speechError("no-speech"), /No te escuché/);
});
