// Lo puro del asistente, sin DOM ni imports: Markdown seguro para las respuestas, tablas para exportar (CSV, texto para
// Google Sheets, .xlsx sin dependencias), pedidos de «exportá» y el idioma del dictado. Lo usa public/js/chat.js en el
// navegador y las pruebas con node (test/chatfmt.test.mjs).

// ---------- Markdown chico y seguro
// Primero se escapa TODO y recién después se arman las etiquetas (y solo estas: p, br, ul, ol, li, h4, strong, em, code,
// a, hr, blockquote). Los links solo http(s), mailto y tel; teléfonos, mails y direcciones sueltas también van como link.
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escHtml = s => String(s ?? "").replace(/[&<>"']/g, c => ESC[c]);
const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uE000\uE001]/g;
const SAFE_URL = /^(https?:\/\/|mailto:|tel:)/i;
const L = "abcdefghij", enc = i => String(i).replace(/\d/g, d => L[d]), dec = k => Number(k.replace(/[a-j]/g, c => L.indexOf(c)));
const PH = /\uE000([a-j]+)\uE001/g, PH1 = /\uE000[a-j]+\uE001/;

function anchor(href, label) {
  const ext = /^https?:/i.test(href);
  return `<a href="${escHtml(href)}"${ext ? ' target="_blank" rel="noopener noreferrer"' : ""}>${label}</a>`;
}
const emph = s => s
  .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>$1</strong>")
  .replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, "$1<strong>$2</strong>")
  .replace(/(^|[^*\w])\*(?=[^\s*])([^*]*?[^\s*])\*(?!\*)/g, "$1<em>$2</em>")
  .replace(/(^|[^\w])_(?=[^\s_])([^_]*?[^\s_])_(?!\w)/g, "$1<em>$2</em>");
const isDate = s => /^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}$/.test(s.trim());
export function phoneHref(s) {
  const t = String(s).trim(), d = t.replace(/\D/g, "");
  if (d.length < 8 || d.length > 15 || isDate(t)) return null;
  if (!t.startsWith("+") && d.length < 10) return null;
  return "tel:" + (t.startsWith("+") ? "+" : "") + d;
}

// una línea (o un ítem) de texto SIN escapar → HTML seguro
function inline(raw) {
  const keep = [], ph = html => `\uE000${enc(keep.push(html) - 1)}\uE001`;
  let s = String(raw);
  s = s.replace(/`([^`\n]+)`/g, (_, c) => ph(`<code>${escHtml(c)}</code>`));
  s = s.replace(/\[([^\]\n]+)\]\(\s*<?([^()\s<>]+)>?\s*\)/g, (_, t, u) => ph(SAFE_URL.test(u) ? anchor(u, emph(escHtml(t))) : emph(escHtml(t))));
  s = s.replace(/\bhttps?:\/\/[^\s<>"'`\uE000\uE001]+/gi, u => {
    const m = u.match(/[.,;:!?»”'")\]]+$/), tail = m ? m[0] : "", url = tail ? u.slice(0, -tail.length) : u;
    return ph(anchor(url, escHtml(url))) + tail;
  });
  s = s.replace(/(?<![\w.+-])[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, m => ph(anchor("mailto:" + m, escHtml(m))));
  s = s.replace(/(?<![\w+(\-/.])(\+?\(?\d[\d \u00A0().-]{6,20}\d)(?![\w/])/g, m => { const h = phoneHref(m); return h ? ph(anchor(h, escHtml(m))) : m; });
  s = emph(escHtml(s));
  for (let k = 0; k < 4 && PH1.test(s); k++) s = s.replace(PH, (_, i) => keep[dec(i)] ?? "");
  return s.replace(PH, "");
}
const inlineLines = t => String(t).split("\n").map(inline).join("<br>");

function buildList(items) {
  let i = 0;
  const level = ind => {
    const first = items[i], ol = first.ol;
    let html = ol ? `<ol${first.n > 1 ? ` start="${first.n}"` : ""}>` : "<ul>";
    while (i < items.length && items[i].ind >= ind) {
      if (items[i].ind === ind && items[i].ol !== ol && i > 0 && items[i] !== first) break; // «- …» y después «1. …»: otra lista
      const it = items[i++];
      let li = inlineLines(it.text);
      while (i < items.length && items[i].ind > it.ind) li += level(items[i].ind);
      html += `<li>${li}</li>`;
    }
    return html + (ol ? "</ol>" : "</ul>");
  };
  let html = "";
  while (i < items.length) html += level(items[i].ind);
  return html;
}

export function renderMd(src) {
  const lines = String(src ?? "").replace(/\r\n?/g, "\n").replace(CTRL, "").split("\n");
  const out = []; let para = [], items = [], quote = [];
  const flushPara = () => { if (para.length) out.push(`<p>${para.map(inline).join("<br>")}</p>`); para = []; };
  const flushList = () => { if (items.length) out.push(buildList(items)); items = []; };
  const flushQuote = () => { if (quote.length) out.push(`<blockquote>${quote.map(inline).join("<br>")}</blockquote>`); quote = []; };
  const flush = () => { flushPara(); flushList(); flushQuote(); };
  for (const line of lines) {
    const t = line.replace(/\t/g, "  ").trimEnd(); let m;
    if (!t.trim()) { flush(); continue; }
    if ((m = t.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*$/))) { flush(); out.push(`<h4 class="md-h">${inline(m[1])}</h4>`); continue; }
    if (/^\s{0,3}([-*_])(\s*\1){2,}$/.test(t)) { flush(); out.push("<hr>"); continue; }
    if ((m = t.match(/^\s{0,3}>\s?(.*)$/))) { flushPara(); flushList(); quote.push(m[1]); continue; }
    if ((m = t.match(/^(\s*)[-*+•]\s+(.*)$/))) { flushPara(); flushQuote(); items.push({ ind: m[1].length, ol: false, text: m[2] }); continue; }
    if ((m = t.match(/^(\s*)(\d{1,3})[.)]\s+(.*)$/))) { flushPara(); flushQuote(); items.push({ ind: m[1].length, ol: true, n: Number(m[2]), text: m[3] }); continue; }
    if (items.length && /^\s{2,}\S/.test(t)) { items.at(-1).text += "\n" + t.trim(); continue; }
    flushList(); flushQuote(); para.push(t.trim());
  }
  flush();
  return out.join("");
}

// ---------- tablas: { title, columns: [{ label, type: text|date|time|number|url }], rows: [[...]], note? }
const isoDate = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));
export function cellText(v, type = "text", mode = "view") {
  if (v === null || v === undefined || v === "") return "";
  if (type === "date" && isoDate(v)) {
    const [y, m, d] = String(v).split("-");
    return mode === "tsv" ? `${y}-${m}-${d}` : mode === "view" ? `${d}/${m}/${y.slice(2)}` : `${d}/${m}/${y}`;
  }
  if (type === "number" && typeof v === "number" && isFinite(v)) return mode === "csv" ? String(v).replace(".", ",") : String(v);
  if (Array.isArray(v)) return v.filter(Boolean).join(" · ");
  return String(v);
}
// texto que una planilla tomaría como fórmula (=, +, -, @): con «'» adelante queda como texto (Sheets y Excel lo ocultan
// al escribirlo; en el CSV se ve, pero nada se ejecuta)
const guard = s => /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
const textCell = (v, c, mode) => { const s = cellText(v, c.type, mode); return c.type === "number" || c.type === "date" ? s : guard(s); };

// CSV para Excel en español: BOM UTF-8, separador «;», comillas dobles cuando hace falta
export function tableCsv(t) {
  const q = s => /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  const lines = [t.columns.map(c => q(guard(c.label))), ...t.rows.map(r => t.columns.map((c, j) => q(textCell(r[j], c, "csv"))))];
  return "\uFEFF" + lines.map(l => l.join(";")).join("\r\n") + "\r\n";
}
// texto con tabulaciones (con encabezados) para pegar en una hoja de Google Sheets
export function tableTsv(t) {
  const one = s => s.replace(/[\t\r\n]+/g, " ");
  return [t.columns.map(c => one(c.label)), ...t.rows.map(r => t.columns.map((c, j) => one(textCell(r[j], c, "tsv"))))].map(l => l.join("\t")).join("\n");
}
export function fileName(title, ext) {
  const base = String(title || "tabla").replace(/\//g, "-").replace(/[\\:*?"<>|·]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "tabla";
  return `${base}.${ext}`;
}

// ---------- .xlsx sin dependencias: un zip (sin comprimir) con el XML mínimo de una hoja
const te = new TextEncoder();
let CRC = null;
export function crc32(b) {
  if (!CRC) { CRC = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c >>> 0; } }
  let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
export function zipStore(files) {
  const parts = [], central = []; let off = 0;
  for (const f of files) {
    const name = te.encode(f.name), data = typeof f.data === "string" ? te.encode(f.data) : f.data, crc = crc32(data);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
    h.setUint16(10, 0, true); h.setUint16(12, 0x21, true); h.setUint32(14, crc, true); h.setUint32(18, data.length, true);
    h.setUint32(22, data.length, true); h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
    parts.push(new Uint8Array(h.buffer), name, data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
    c.setUint16(10, 0, true); c.setUint16(12, 0, true); c.setUint16(14, 0x21, true); c.setUint32(16, crc, true);
    c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, name.length, true);
    c.setUint32(42, off, true);
    central.push(new Uint8Array(c.buffer), name);
    off += 30 + name.length + data.length;
  }
  const cd = central.reduce((a, b) => a + b.length, 0), e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
  e.setUint32(12, cd, true); e.setUint32(16, off, true);
  const all = [...parts, ...central, new Uint8Array(e.buffer)], out = new Uint8Array(all.reduce((a, b) => a + b.length, 0));
  let p = 0; for (const a of all) { out.set(a, p); p += a.length; }
  return out;
}
const xml = s => String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "").replace(/[&<>"]/g, c => ESC[c]).slice(0, 32767);
export const colName = j => { let s = ""; for (j++; j > 0; j = Math.floor((j - 1) / 26)) s = String.fromCharCode(65 + ((j - 1) % 26)) + s; return s; };
const serial = v => { const [y, m, d] = String(v).split("-").map(Number); return (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 864e5; };
export const sheetName = t => String(t || "").replace(/[[\]:*?/\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 31) || "Hoja1";

export function tableXlsx(t) {
  const name = sheetName(t.title), n = t.rows.length + 1, last = colName(Math.max(0, t.columns.length - 1));
  const width = t.columns.map((c, j) => Math.min(60, Math.max(8, c.label.length + 2, ...t.rows.slice(0, 300).map(r => cellText(r[j], c.type, "csv").length + 1))));
  const cell = (v, c, ref) => {
    if (v === null || v === undefined || v === "") return "";
    if (c.type === "number" && typeof v === "number" && isFinite(v)) return `<c r="${ref}"><v>${v}</v></c>`;
    if (c.type === "date" && isoDate(v)) return `<c r="${ref}" s="2"><v>${serial(v)}</v></c>`;
    return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(cellText(v, c.type, "csv"))}</t></is></c>`;
  };
  const head = `<row r="1">${t.columns.map((c, j) => `<c r="${colName(j)}1" t="inlineStr" s="1"><is><t xml:space="preserve">${xml(c.label)}</t></is></c>`).join("")}</row>`;
  const body = t.rows.map((r, i) => `<row r="${i + 2}">${t.columns.map((c, j) => cell(r[j], c, colName(j) + (i + 2))).join("")}</row>`).join("");
  const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"', RNS = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const X = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  return zipStore([
    { name: "[Content_Types].xml", data: X + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>` },
    { name: "_rels/.rels", data: X + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: "xl/workbook.xml", data: X + `<workbook ${NS} ${RNS}><sheets><sheet name="${xml(name)}" sheetId="1" r:id="rId1"/></sheets><definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'${xml(name.replace(/'/g, "''"))}'!$A$1:$${last}$${n}</definedName></definedNames></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", data: X + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: "xl/styles.xml", data: X + `<styleSheet ${NS}><numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>` },
    { name: "xl/worksheets/sheet1.xml", data: X + `<worksheet ${NS} ${RNS}><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${width.map((w, j) => `<col min="${j + 1}" max="${j + 1}" width="${w}" customWidth="1"/>`).join("")}</cols><sheetData>${head}${body}</sheetData><autoFilter ref="A1:${last}${n}"/></worksheet>` },
  ]);
}

// ---------- «exportá», «pasalo a un Excel», «llevalo a Google Sheets»: sin otro pedido adentro, se usa la última tabla del panel
const norm = s => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]+/g, " ");
const ASK = /\b(export\w*|excel|xlsx|csv|planilla\w*|sheets?|google|hoja|descarg\w*|bajal\w*|bajam\w*|bajar)\b/;
const FILLER = new Set(("export exporta exportar exportame exportalo exportala exportamelo exportamela exportalas exportalos excel xlsx csv planilla google sheet sheets hoja de calculo " +
  "descarga descargar descargame descargalo descargala descargamelo bajalo bajala bajamelo bajame bajar pasa pasalo pasala pasame pasamelo pasamela pasas pasar " +
  "lleva llevalo llevala llevame llevar arma armame armalo arma haceme hacelo hace hacer manda mandame mandalo dame quiero queria podes puedes podrias me lo la las los le " +
  "a al en un una el eso esto esa ese esta este tabla lista listado como por favor porfa dale ok si archivo y o con todo toda todas todos ahora nueva nuevo tambien")
  .split(" "));
export function exportIntent(text) {
  const n = norm(text); if (!ASK.test(n)) return null;
  const rest = n.split(/\s+/).filter(w => w && !FILLER.has(w) && !/^(export|descarg|planilla|pas|llev|arm|hac|mand|baj|pod|quer|necesit)/.test(w));
  if (rest.length) return null;
  return { format: /\b(sheets?|google|hoja)\b/.test(n) ? "sheets" : /\bcsv\b/.test(n) ? "csv" : "xlsx" };
}

// ---------- dictado (Web Speech API): el idioma del navegador si es español con país; si no, español de Argentina
export const speechLang = nav => /^es-[a-z0-9]{2,3}$/i.test(String(nav || "")) ? String(nav) : "es-AR";
export function speechError(code) {
  if (code === "not-allowed" || code === "service-not-allowed") return "No tengo permiso para usar el micrófono. Tocá el candado al lado de la dirección › Micrófono › Permitir, y probá de nuevo.";
  if (code === "no-speech") return "No te escuché. Probá de nuevo, más cerca del micrófono.";
  if (code === "audio-capture") return "No encontré un micrófono. Revisá que esté conectado.";
  if (code === "network") return "El dictado necesita internet. Probá de nuevo.";
  if (code === "language-not-supported") return "Tu navegador no dicta en español. Probá con Chrome.";
  return "No pude escucharte. Probá de nuevo.";
}
export const NO_SPEECH = "Tu navegador no deja dictar: probá con Chrome.";
