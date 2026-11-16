// Lector mínimo de .xlsx (Excel o «Archivo › Descargar › Microsoft Excel» de Google Sheets), sin dependencias: un .xlsx es
// un zip con XML. Lee las pestañas con sus valores (texto, números, booleanos; errores como vacío) y los links de las celdas
// (un link de Pipedrive con otro texto queda como link). Topes: tamaño del archivo, de lo descomprimido, filas y columnas.
import zlib from "zlib";
import { LIMITS } from "./import.js";

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const MAX_UNZIP = 60e6;
// el zip: directorio central → { nombre: () => Buffer }
export function unzip(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw bad("No es un archivo de Excel válido.");
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw bad("No es un archivo de Excel válido.");
  const count = buf.readUInt16LE(eocd + 10), files = new Map();
  let p = buf.readUInt32LE(eocd + 16), total = 0;
  for (let k = 0; k < count && p + 46 <= buf.length; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), size = buf.readUInt32LE(p + 24);
    const nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), lo = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nl);
    p += 46 + nl + xl + cl;
    files.set(name, () => {
      if (lo + 30 > buf.length || buf.readUInt32LE(lo) !== 0x04034b50) throw bad("El archivo de Excel está dañado.");
      const start = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28), raw = buf.subarray(start, start + csize);
      total += size; if (size > MAX_UNZIP || total > MAX_UNZIP) throw bad("El archivo es demasiado grande para leerlo.", 413);
      if (method === 0) return raw;
      if (method === 8) return zlib.inflateRawSync(raw, { maxOutputLength: MAX_UNZIP });
      throw bad("El archivo de Excel usa una compresión que no conozco.");
    });
  }
  return files;
}
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
export const xmlText = s => String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e] ?? m);
const attrs = tag => Object.fromEntries([...tag.matchAll(/([\w:]+)="([^"]*)"/g)].map(m => [m[1], xmlText(m[2])]));
// «A1» → [fila, columna] (desde 0)
export function cellRef(ref) {
  const m = /^([A-Z]+)(\d+)$/.exec(String(ref || "")); if (!m) return null;
  let c = 0; for (const ch of m[1]) c = c * 26 + (ch.charCodeAt(0) - 64);
  return [Number(m[2]) - 1, c - 1];
}
const textOf = xml => [...String(xml).matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(m => xmlText(m[1])).join("");
const relsOf = xml => new Map([...String(xml || "").matchAll(/<Relationship\b[^>]*>/g)].map(m => attrs(m[0])).map(a => [a.Id, a]));
const resolve = (base, target) => { if (target.startsWith("/")) return target.slice(1); const parts = base.split("/").slice(0, -1); for (const p of target.split("/")) { if (p === "..") parts.pop(); else if (p !== ".") parts.push(p); } return parts.join("/"); };

export function readXlsx(buf, { max = LIMITS } = {}) {
  const z = unzip(buf), get = n => { const f = z.get(n); return f ? f().toString("utf8") : null; };
  const wb = get("xl/workbook.xml"); if (!wb) throw bad("No es un archivo de Excel válido (.xlsx).");
  const rels = relsOf(get("xl/_rels/workbook.xml.rels"));
  const shared = []; const ss = get("xl/sharedStrings.xml");
  if (ss) for (const m of ss.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(textOf(m[1]));
  const title = xmlText((get("docProps/core.xml") || "").match(/<dc:title>([^<]*)<\/dc:title>/)?.[1] || "");
  const tabs = [];
  for (const m of wb.matchAll(/<sheet\b[^>]*\/?>/g)) {
    if (tabs.length >= max.tabs) break;
    const a = attrs(m[0]), rel = rels.get(a["r:id"]); if (!rel || a.state === "hidden" || a.state === "veryHidden") continue;
    const path = resolve("xl/workbook.xml", rel.Target), xml = get(path); if (!xml) continue;
    // links de las celdas (hoja de relaciones de la pestaña)
    const links = new Map(), srel = relsOf(get(resolve(path, "_rels/" + path.split("/").pop() + ".rels")));
    for (const h of xml.matchAll(/<hyperlink\b[^>]*\/?>/g)) { const ha = attrs(h[0]), t = srel.get(ha["r:id"])?.Target; if (t && /^https?:/i.test(t)) links.set(ha.ref, t); }
    const rows = [];
    for (const r of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>|<row\b[^>]*\/>/g)) {
      if (rows.length > max.rows + 30) break;
      const ra = attrs(r[0].match(/<row\b[^>]*>/)[0]), ri = Number(ra.r) - 1;
      const row = [];
      for (const c of (r[1] || "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ca = attrs(c[1]), pos = cellRef(ca.r), col = pos ? pos[1] : row.length; if (col >= max.cols) continue;
        const inner = c[2] || "", v = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        let val = "";
        if (ca.t === "s") val = shared[Number(v)] ?? "";
        else if (ca.t === "inlineStr") val = textOf(inner);
        else if (ca.t === "b") val = v === "1" ? "TRUE" : "FALSE";
        else if (ca.t === "e") val = "";
        else if (v != null) val = xmlText(v);
        const link = links.get(ca.r); if (link && /pipedrive\.com/i.test(link) && !/pipedrive\.com/i.test(val)) val = link;
        row[col] = String(val).slice(0, max.cell);
      }
      for (let j = 0; j < row.length; j++) if (row[j] === undefined) row[j] = "";
      // las filas vacías del medio se respetan (el encabezado puede estar en la 3)
      if (Number.isInteger(ri) && ri >= rows.length) while (rows.length < ri && rows.length < max.rows + 30) rows.push([]);
      rows.push(row);
    }
    while (rows.length && rows.at(-1).every(c => !String(c).trim())) rows.pop();
    tabs.push({ name: String(a.name || `Hoja ${tabs.length + 1}`).slice(0, 100), rows });
  }
  if (!tabs.length) throw bad("El archivo no tiene pestañas con datos.");
  return { title, tabs };
}
