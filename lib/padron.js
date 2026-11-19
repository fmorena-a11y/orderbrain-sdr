// Padrones oficiales de colegios (Perú: ESCALE MINEDU; Colombia: MEN en datos.gov.co; México: Catálogo de Centros de Trabajo
// de la SEP): lectura, filtro (solo privados de inicial, primaria, secundaria o media), agrupación de niveles del mismo
// plantel, normalización (nombre, teléfono, dirección, ciudad) y unión con la base sin duplicar. Todo puro y sin
// dependencias: lo usa scripts/padron.mjs (que baja los archivos) y lo prueba test/padron.test.mjs.
import zlib from "zlib";
import { norm, km, keyTokens, radiusKm, notSchool, classify, slug } from "./scan.js";

// ---------- archivos: zip, DBF (cp850) y CSV
// Zip sin zip64 (el padrón de Perú pesa ≈16 MB comprimido y ≈290 MB adentro): { nombre: () => Buffer }
export function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("no es un zip");
  const files = new Map();
  let p = buf.readUInt32LE(eocd + 16);
  for (let k = 0, n = buf.readUInt16LE(eocd + 10); k < n; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), lo = buf.readUInt32LE(p + 42);
    const name = buf.toString("latin1", p + 46, p + 46 + nl);
    p += 46 + nl + xl + cl;
    files.set(name, () => {
      const start = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28), raw = buf.subarray(start, start + csize);
      if (method === 0) return raw;
      if (method === 8) return zlib.inflateRawSync(raw, { maxOutputLength: 2 ** 31 - 1 });
      throw new Error(`compresión ${method} no soportada`);
    });
  }
  return files;
}
// Página de códigos 850 (DOS): así viene el DBF del padrón de Perú («Jard¡n» si se lee como latin1).
const CP850 = "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒáíóúñÑªº¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐└┴┬├─┼ãÃ╚╔╩╦╠═╬¤ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀ÓßÔÒõÕµþÞÚÛÙýÝ¯´­±‗¾¶§÷¸°¨·¹³²■ ";
export function decode(bytes, enc = "cp850") {
  if (enc === "utf8") return Buffer.from(bytes).toString("utf8");
  if (enc === "latin1") return Buffer.from(bytes).toString("latin1");
  let s = "";
  for (const b of bytes) s += b < 128 ? String.fromCharCode(b) : CP850[b - 128];
  return s;
}
const clean = s => String(s ?? "").replace(/\0/g, "").replace(/\s+/g, " ").trim();
// DBF (dBase III): filas como objetos { CAMPO: "texto" }. `keep(row)` descarta temprano (el padrón tiene 180.000 filas).
// La página de códigos sale del byte 29 (0x03/0x57 = Windows; si no, 850, la confirmada del padrón).
export function readDbf(buf, { fields: only, keep, encoding } = {}) {
  const n = buf.readUInt32LE(4), hlen = buf.readUInt16LE(8), rlen = buf.readUInt16LE(10);
  const enc = encoding || ([0x03, 0x57, 0x58].includes(buf[29]) ? "latin1" : "cp850");
  const fields = [];
  for (let p = 32, off = 1; p < hlen - 1 && buf[p] !== 0x0d; p += 32) {
    const name = buf.toString("latin1", p, p + 11).replace(/\0.*$/, "").trim(), len = buf[p + 16];
    fields.push({ name, type: String.fromCharCode(buf[p + 11]), off, len }); off += len;
  }
  const use = only ? fields.filter(f => only.includes(f.name)) : fields, out = [];
  for (let i = 0; i < n; i++) {
    const at = hlen + i * rlen; if (at + rlen > buf.length) break;
    if (buf[at] === 0x2a) continue; // borrada
    const row = {};
    for (const f of use) row[f.name] = clean(decode(buf.subarray(at + f.off, at + f.off + f.len), enc));
    if (!keep || keep(row)) out.push(row);
  }
  return out;
}
// CSV con comillas; separador , ; o tabulación (el que más aparece en el encabezado).
export function parseCsv(text) {
  text = String(text).replace(/^﻿/, "");
  const head = text.slice(0, text.indexOf("\n") + 1 || text.length);
  const sep = [",", ";", "\t"].map(c => [c, head.split(c).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; continue; }
    if (c === '"') q = true;
    else if (c === sep) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [h, ...rest] = rows.filter(r => r.some(x => x.trim()));
  if (!h) return [];
  const keys = h.map(x => x.trim());
  return rest.map(r => Object.fromEntries(keys.map((k, i) => [k, clean(r[i])])));
}
// Texto de un archivo que puede venir en UTF-8 o en Windows-1252 (las descargas de la SEP)
export function textOf(buf) {
  const s = buf.toString("utf8");
  return /�/.test(s.slice(0, 200000)) ? buf.toString("latin1") : s;
}

// ---------- texto
// preposiciones en minúscula; artículos solo después de una preposición («de la Montaña», pero «Colegio Los Pinos»)
const PREP = new Set("de del y e en con para por a al o u da di".split(" ")), ART = new Set("el la las los lo".split(" "));
const UPPER = /^(i{1,3}|iv|vi{0,3}|ix|xi{0,3}|iep|iei|cebe|ceba|sac|srl|eirl|sa|sc|ac|abc|ugel|usa|cct|cbtis|ipn|unam|ib|dc|ii|tic|jfk|sep)$/i;
const ACCENT = Object.fromEntries("maria:maría jose:josé jesus:jesús educacion:educación institucion:institución jardin:jardín bilingue:bilingüe tecnico:técnico tecnica:técnica pedagogico:pedagógico catolico:católico catolica:católica america:américa angeles:ángeles sebastian:sebastián martin:martín agustin:agustín ramon:ramón simon:simón concepcion:concepción asuncion:asunción encarnacion:encarnación anunciacion:anunciación garcia:garcía cristobal:cristóbal nino:niño ninos:niños academico:académico pais:país peru:perú mexico:méxico bogota:bogotá medellin:medellín cucuta:cúcuta ibague:ibagué jesus:jesús adolfo:adolfo".split(" ").map(x => x.split(":")));
// «COLEGIO SAN JOSE DE LA MONTAÑA» → «Colegio San José de la Montaña» (solo si viene en mayúsculas)
export function titleText(s, { accents = true } = {}) {
  s = clean(s); if (!s) return "";
  if (s !== s.toUpperCase()) return s;
  const words = s.toLowerCase().split(" ");
  return words.map((w, i) => {
    if (/^([a-záéíóúñü]\.){2,}$/i.test(w)) return w.toUpperCase();          // I.E.P.
    const bare = w.replace(/[^a-z0-9áéíóúñü]/gi, "");
    if (UPPER.test(bare)) return w.toUpperCase();
    if (i > 0 && (PREP.has(w) || (ART.has(w) && PREP.has(words[i - 1])))) return w;
    const acc = accents && ACCENT[w] ? ACCENT[w] : w;
    return acc.replace(/(^|[-/("'«])([a-záéíóúñü])/g, (m, a, b) => a + b.toUpperCase());
  }).join(" ");
}
// Palabras que no distinguen un colegio (además de las de lib/scan.js): «IEP San Agustín» = «Colegio San Agustín»
const MORE_GENERIC = new Set("iep iei ie cuna nido infantil gimnasio inicial jardin kinder preescolar centro docente educativo educativa particular privada privado cebe instituto institucion colegio escuela liceo general".split(" "));
export const coreTokens = name => keyTokens(name).filter(w => !MORE_GENERIC.has(w) && !/^\d+$/.test(w));

// ---------- teléfonos y mails
// Perú: código de área por departamento (sin código, un fijo de 6 dígitos es de su departamento; Lima y Callao, 7 con el 1)
const PE_AREA = { amazonas: "41", ancash: "43", apurimac: "83", arequipa: "54", ayacucho: "66", cajamarca: "76", callao: "1", cusco: "84", huancavelica: "67", huanuco: "62", ica: "56", junin: "64", "la libertad": "44", lambayeque: "74", lima: "1", loreto: "65", "madre de dios": "82", moquegua: "53", pasco: "63", piura: "73", puno: "51", "san martin": "42", tacna: "52", tumbes: "72", ucayali: "61" };
// Colombia: indicativo fijo (601…608) por departamento (código DANE de 2 dígitos)
const CO_IND = { "11": "1", "25": "1", "19": "2", "52": "2", "76": "2", "05": "4", "23": "4", "27": "4", "08": "5", "13": "5", "20": "5", "44": "5", "47": "5", "70": "5", "88": "5", "17": "6", "63": "6", "66": "6", "54": "7", "68": "7", "81": "7" };
const firstNums = raw => String(raw || "").split(/[\/,;|]|\s{2,}|\s+-+\s*|\s*-+\s+|--+|\by\b|\bo\b/i).map(x => x.replace(/\D/g, "")).filter(x => x.length >= 6);
export function phonePE(raw, dpto = "") {
  for (let d of firstNums(raw)) {
    if (d.startsWith("51") && d.length >= 10) d = d.slice(2);
    d = d.replace(/^0/, "");
    if (/^9\d{8}$/.test(d)) return `+51 ${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}`;
    if (/^1\d{7}$/.test(d)) return `+51 1 ${d.slice(1)}`;
    if (/^[4-8]\d{7}$/.test(d)) return `+51 ${d.slice(0, 2)} ${d.slice(2)}`;
    const area = PE_AREA[norm(dpto)] || "";
    if (/^\d{7}$/.test(d) && area === "1") return `+51 1 ${d}`;
    if (/^\d{6}$/.test(d) && area && area !== "1") return `+51 ${area} ${d}`;
  }
  return "";
}
export function phoneCO(raw, dptoCode = "") {
  for (let d of firstNums(raw)) {
    if (d.startsWith("57") && d.length === 12) d = d.slice(2);
    if (/^3\d{9}$/.test(d)) return `+57 ${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}`;
    if (/^60\d{8}$/.test(d)) return `+57 ${d.slice(0, 3)} ${d.slice(3)}`;
    const ind = CO_IND[String(dptoCode).padStart(2, "0")] || "8";
    if (/^\d{7}$/.test(d)) return `+57 60${ind} ${d}`;
  }
  return "";
}
export function phoneMX(raw) {
  for (let d of firstNums(raw)) {
    d = d.replace(/^52(?=\d{10}$)/, "").replace(/^(01|044|045)(?=\d{10}$)/, "");
    if (/^\d{10}$/.test(d)) return `+52 ${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}`;
  }
  return "";
}
const BAD_MAIL = /^(no|sin|ninguno|na|n\/a|x+)@|@(no|sin|ninguno|correo|mail)\.|example\./i;
// el primero que es un mail entero («1ºugimna@hotmail.com   gimna@hotmail.com» → el segundo)
export function cleanMail(raw) {
  for (const t of String(raw || "").split(/[\s,;\/|]+/)) {
    const m = t.replace(/^[<(]|[>).]$/g, "");
    if (/^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(m) && !BAD_MAIL.test(m)) return m.toLowerCase();
  }
  return "";
}
export const cleanWeb = raw => { const w = clean(raw).toLowerCase(); if (!/^(https?:\/\/)?(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/.test(w) || /facebook|gmail|hotmail/.test(w)) return ""; return /^https?:/.test(w) ? w : "https://" + w; };

// ---------- direcciones
// Colombia: «KR 26 R 107 C 10» → «Carrera 26 R # 107C-10»; «CL 85 27 50» → «Calle 85 # 27-50» (como las lee lib/geo.js)
const CO_VIA = { cl: "Calle", cll: "Calle", calle: "Calle", kr: "Carrera", kra: "Carrera", cra: "Carrera", cr: "Carrera", carrera: "Carrera", ak: "Avenida Carrera", ac: "Avenida Calle", av: "Avenida", avenida: "Avenida", tv: "Transversal", transv: "Transversal", tr: "Transversal", dg: "Diagonal", diag: "Diagonal", cq: "Circular" };
export function addressCO(raw) {
  let s = clean(raw).replace(/^IND\.?\s+/i, "").replace(/\s*-\s*/g, " - ");
  if (!s) return "";
  const m = s.match(/^([A-Za-z]+)\.?\s+(\d+\s?[A-Z]?(?:\s?BIS)?(?:\s(?:SUR|ESTE|NORTE|OESTE))?)\s+(?:#|NO\.?|N°|Nº)?\s*(\d+\s?[A-Z]?(?:\s?BIS)?)\s*(?:-\s*)?(\d+)\b\s*(.*)$/i);
  const via = m && CO_VIA[m[1].toLowerCase()];
  if (via) return `${via} ${m[2].toUpperCase().replace(/\b(SUR|ESTE|NORTE|OESTE)\b/, w => w[0] + w.slice(1).toLowerCase())} # ${m[3].replace(/\s+/g, "").toUpperCase()}-${m[4]}${m[5] ? " " + titleText(m[5], { accents: false }) : ""}`.trim();
  const w = s.split(" "); const v = CO_VIA[w[0].replace(/\.$/, "").toLowerCase()];
  return v ? [v, titleText(w.slice(1).join(" "), { accents: false })].join(" ") : titleText(s, { accents: false });
}
export const joinAddr = (...parts) => { const out = []; for (const p of parts.map(clean).filter(Boolean)) if (!out.some(o => norm(o).includes(norm(p)))) out.push(p); return out.join(", "); };

// ---------- ciudad: la que muestra la app
// Perú: Lima y Callao son «Lima» (el distrito va en la dirección); si no, la ciudad del radar que lo contiene
// (data/radar/state.json, las mismas que agrupan los colegios de OpenStreetMap: «Cuzco», «Chimbote»…); si no, el distrito.
export function cityPE(r, radarCities = [], baseCities = new Map()) {
  const prov = norm(r.D_PROV), dist = titleText(r.D_DIST);
  if (prov === "lima" || prov === "callao") return "Lima";
  if (r.lat != null) {
    let best = null, bd = Infinity;
    for (const c of radarCities) { const d = km(c, r); if (d <= radiusKm(c.pop) && d < bd) { best = c; bd = d; } }
    if (best) return best.name;
  }
  return baseCities.get(norm(dist)) || dist || titleText(r.D_PROV);
}
// Colombia y México: el municipio, con el nombre que ya usa la base («Cartagena» → «Cartagena de Indias», «Bogotá, D.C.» → «Bogotá»)
export function cityByName(raw, baseCities = new Map()) {
  let n = titleText(String(raw || "").replace(/,?\s*D\.?\s*C\.?$/i, "").replace(/\s*\(.*\)$/, ""));
  const k = norm(n); if (!k) return "";
  if (baseCities.has(k)) return baseCities.get(k);
  const starts = [...baseCities].filter(([b]) => b.startsWith(k + " ") || k.endsWith(" " + b) || k.startsWith(b + " de "));
  return starts.length === 1 ? starts[0][1] : n;
}
export function baseCityMap(schools, country) {
  const count = new Map();
  for (const s of schools) if (s.country === country && s.city) { const k = norm(s.city); const m = count.get(k) || new Map(); m.set(s.city, (m.get(s.city) || 0) + 1); count.set(k, m); }
  return new Map([...count].map(([k, m]) => [k, [...m].sort((a, b) => b[1] - a[1])[0][0]]));
}

// ---------- nombres
const SCHOOL_WORD = /\b(colegio|iep|iei|i e p|i e|institucion educativa|cuna|jardin|nido|escuela|liceo|school|college|gimnasio|centro (educativo|docente|de educacion)|instituto|kinder|academia|cebe|wawa|montessori|lycee|preescolar|primaria|secundaria|bachillerato|preparatoria|unidad educativa)\b/;
export function namePE(raw) {
  let s = clean(raw).replace(/^(I\.?\s?E\.?\s?P\.?|INSTITUCION EDUCATIVA PRIVADA|INSTITUCIÓN EDUCATIVA PRIVADA)\s+/i, "IEP ").replace(/^["'«]+|["'»]+$/g, "");
  s = titleText(s);
  return SCHOOL_WORD.test(norm(s)) ? s : `IEP ${s}`;
}
const CO_ABBR = [[/^COLG?\.?\s/i, "COLEGIO "], [/^GIMN?\.?\s/i, "GIMNASIO "], [/^JARD\.?\s+INF\.?\s/i, "JARDIN INFANTIL "], [/^JARD\.?\s/i, "JARDIN "], [/^LIC\.?\s/i, "LICEO "], [/^INST\.?\s+EDUC\.?\s/i, "INSTITUCION EDUCATIVA "], [/^INST\.?\s/i, "INSTITUTO "], [/^CENT\.?\s+EDUC\.?\s/i, "CENTRO EDUCATIVO "], [/^C\.\s?E\.\s/i, "CENTRO EDUCATIVO "], [/^I\.\s?E\.\s/i, "INSTITUCION EDUCATIVA "], [/^ESC\.?\s/i, "ESCUELA "], [/^CENT\.?\s/i, "CENTRO "]];
export function nameCO(raw) {
  let s = clean(raw).toUpperCase();
  for (const [re, to] of CO_ABBR) s = s.replace(re, to);
  return titleText(s);
}
export const nameMX = raw => titleText(clean(raw).replace(/^["'«]+|["'»]+$/g, ""));

// ---------- coordenadas
const BOX = { PE: [-18.6, 0.1, -81.6, -68.4], CO: [-4.3, 13.6, -79.2, -66.8], MX: [14.4, 32.8, -118.5, -86.6] };
export function okPoint(lat, lng, cc) { const b = BOX[cc]; lat = Number(String(lat ?? "").replace(",", ".")); lng = Number(String(lng ?? "").replace(",", ".")); return b && lat && lng && lat >= b[0] && lat <= b[1] && lng >= b[2] && lng <= b[3] ? { lat, lng } : null; }

// ---------- un registro de la base a partir de un grupo
const LEVEL_ORDER = ["Preescolar", "Primaria", "Secundaria", "Prepa"];
const sortLevels = l => LEVEL_ORDER.filter(x => l.includes(x));
function oppOf(name, levels) {
  const c = classify({ name, "operator:type": "private" });
  const opp = (c?.opp || []).filter(o => o !== "Privado confirmado en el mapa" && o !== "Universidad (OrderGO)");
  return [...opp, "Privado según el padrón oficial"];
}
function record(g, { country, src, today }) {
  const rec = {
    name: g.name, city: g.city, country, lat: +g.lat.toFixed(6), lng: +g.lng.toFixed(6), addr: g.addr || "", phone: g.phone || "", web: g.web || "", email: g.email || "",
    levels: sortLevels(g.levels), opp: oppOf(g.name, g.levels), private: "seguro", src, code: g.code, found: today,
  };
  if (g.codes?.length > 1) rec.codes = g.codes;
  if (g.students) rec.students = g.students;
  if (g.approx) rec.approx = g.approx;
  return rec;
}

// ---------- agrupar: los niveles del mismo plantel son un colegio
// Une los servicios que comparten local (o domicilio) y nombre propio, o distrito/municipio y nombre propio.
function groupBy(items, keysOf) {
  const parent = items.map((_, i) => i), find = i => parent[i] === i ? i : (parent[i] = find(parent[i]));
  const seen = new Map();
  items.forEach((it, i) => { for (const k of keysOf(it)) { if (!k) continue; if (seen.has(k)) parent[find(i)] = find(seen.get(k)); else seen.set(k, i); } });
  const out = new Map();
  items.forEach((it, i) => { const r = find(i); if (!out.has(r)) out.set(r, []); out.get(r).push(it); });
  return [...out.values()];
}
const nameKey = n => coreTokens(n).join(" ") || norm(n);
const most = arr => { const m = new Map(); for (const x of arr.filter(Boolean)) m.set(x, (m.get(x) || 0) + 1); return [...m].sort((a, b) => b[1] - a[1])[0]?.[0] || ""; };

// ---------- Perú (Padron_web.dbf de ESCALE)
// Solo privados (GESTION 3 «Privada»; la «Pública de gestión privada» —convenios, Fe y Alegría— es pública), activos,
// escolarizados y de educación básica regular: inicial (cuna, jardín, cuna-jardín), primaria y secundaria. Fuera PRONOEI,
// básica alternativa (adultos), especial, superior y CETPRO.
export const PE_FIELDS = ["COD_MOD", "ANEXO", "CODLOCAL", "CEN_EDU", "NIV_MOD", "D_NIV_MOD", "D_FORMA", "GESTION", "D_GESTION", "TELEFONO", "EMAIL", "PAGWEB", "DIR_CEN", "CODGEO", "D_DPTO", "D_PROV", "D_DIST", "NLAT_IE", "NLONG_IE", "ESTADO", "D_ESTADO", "TALUMNO"];
const PE_LEVEL = { A1: "Preescolar", A2: "Preescolar", A3: "Preescolar", B0: "Primaria", F0: "Secundaria" };
export function keepPE(r) {
  const priv = r.GESTION ? r.GESTION === "3" : /^privad/.test(norm(r.D_GESTION));
  const active = r.ESTADO ? r.ESTADO === "1" : /^activ/.test(norm(r.D_ESTADO));
  const level = r.NIV_MOD ? !!PE_LEVEL[r.NIV_MOD] : /^(inicial (cuna|jardin)|primaria|secundaria)/.test(norm(r.D_NIV_MOD)) && !/no escolarizad/.test(norm(r.D_NIV_MOD));
  const school = !r.D_FORMA || /^escolarizad/.test(norm(r.D_FORMA));
  return priv && active && level && school;
}
const levelPE = r => PE_LEVEL[r.NIV_MOD] || (/primaria/.test(norm(r.D_NIV_MOD)) ? "Primaria" : /secundaria/.test(norm(r.D_NIV_MOD)) ? "Secundaria" : "Preescolar");
export function groupPE(rows, { radarCities = [], baseCities = new Map() } = {}) {
  const items = rows.filter(keepPE).map(r => ({ r, pt: okPoint(r.NLAT_IE, r.NLONG_IE, "PE"), name: namePE(r.CEN_EDU), level: levelPE(r) }));
  const groups = groupBy(items, it => [it.r.CODLOCAL && `l:${it.r.CODLOCAL}|${nameKey(it.name)}`, it.r.CODGEO && `g:${it.r.CODGEO}|${nameKey(it.name)}`]);
  const rank = it => ({ Secundaria: 0, Primaria: 1, Preescolar: 2 }[it.level]);
  return groups.map(g => {
    g.sort((a, b) => rank(a) - rank(b) || a.r.COD_MOD.localeCompare(b.r.COD_MOD));
    const r = g[0].r, pt = g.find(x => x.pt)?.pt;
    const city = cityPE({ ...r, ...(pt || {}) }, radarCities, baseCities);
    const dist = titleText(r.D_DIST);
    const students = g.reduce((s, x) => s + (Number(x.r.TALUMNO) || 0), 0);
    return {
      name: g[0].name, city, lat: pt?.lat, lng: pt?.lng,
      addr: joinAddr(titleText(most(g.map(x => x.r.DIR_CEN)), { accents: false }), norm(dist) !== norm(city) ? dist : ""),
      phone: g.map(x => phonePE(x.r.TELEFONO, r.D_DPTO)).find(Boolean) || "", email: g.map(x => cleanMail(x.r.EMAIL)).find(Boolean) || "", web: g.map(x => cleanWeb(x.r.PAGWEB)).find(Boolean) || "",
      levels: [...new Set(g.map(x => x.level))], code: r.COD_MOD, codes: [...new Set(g.map(x => x.r.COD_MOD))], students: students || undefined,
      region: titleText(r.D_DPTO), dist, prov: titleText(r.D_PROV),
    };
  });
}

// ---------- Colombia (MEN en datos.gov.co)
// Establecimientos (cfw5-qzt5) del último año, sector NO_OFICIAL; coordenadas de la sede principal (x5ay-984n, con 2
// decimales: ≈1 km, `approx: "1km"`) o el centro del municipio (DIVIPOLA gdxc-w37w, `approx: "ciudad"`); niveles de
// upkm-vdjb (2016) cuando el código está ahí. Fuera lo que es solo de adultos.
const CO_ADULT = /\b(adultos|clei|ciclos lectivos|extraedad|validacion|semipresencial|nocturn[oa]|a distancia|virtual)\b/;
export function keepCO(r, nivel) {
  if (!/no.?oficial/i.test(r.sector || "")) return false;
  const n = norm(r.nombre_establecimiento);
  if (!n || notSchool(n) || CO_ADULT.test(n)) return false;
  // solo adultos según el directorio de 2016
  const mods = norm(nivel?.modelos_educativos || "");
  if (mods && /adultos|clei/.test(mods) && !/tradicional|escuela nueva|preescolar|basica|media/.test(mods.replace(/jovenes en extraedad y adultos/g, ""))) return false;
  return true;
}
export function levelsCO(niveles) {
  const n = norm(niveles), out = [];
  if (/preescolar/.test(n)) out.push("Preescolar");
  if (/primaria/.test(n)) out.push("Primaria");
  if (/secundaria|media/.test(n)) out.push("Secundaria");
  return out;
}
export function groupCO(rows, { sedes = new Map(), niveles = new Map(), munis = new Map(), baseCities = new Map() } = {}) {
  const out = [];
  const seen = new Set();
  for (const r of rows) {
    const code = String(r.codigo_dane || "").trim(); if (!code || seen.has(code)) continue;
    const nv = niveles.get(code);
    if (!keepCO(r, nv)) continue;
    seen.add(code);
    const mu = munis.get(String(r.cod_dane_municipio || "").padStart(5, "0"));
    const center = mu && okPoint(mu.latitud, mu.longitud, "CO");
    let pt = null, approx;
    const sd = sedes.get(code), sp = sd && okPoint(sd.coordenada_y_sede, sd.coordenada_x_sede, "CO");
    if (sp && (!center || km(sp, center) < 25)) { pt = sp; approx = "1km"; }
    else if (center) { pt = center; approx = "ciudad"; }
    const city = cityByName(r.municipio || mu?.nom_mpio, baseCities);
    out.push({
      name: nameCO(r.nombre_establecimiento), city, lat: pt?.lat, lng: pt?.lng, approx,
      addr: joinAddr(addressCO(r.direccion || sd?.direccion), titleText(r.barrio_vereda, { accents: false })),
      phone: phoneCO(r.telefono || sd?.telefono, r.cod_dane_departamento), email: cleanMail(r.email), web: cleanWeb(r.web),
      levels: levelsCO(nv?.niveles), code, students: Number(r.total_matricula) || undefined, region: titleText(r.departamento),
    });
  }
  return out;
}

// ---------- México (Catálogo de Centros de Trabajo de la SEP)
// Acepta las dos formas conocidas del CSV: la del catálogo (CV_CCT, C_NOMBRE, SOSTENIMIENTO_C_CONTROL,
// TIPONIVELSUB_C_SERVICION1/2, INMUEBLE_*, CONTACTO_*) y la de SIGED (CLAVECCT, NOMBRECT, NOMBRECONT, NOMBRENIV…).
// Solo privados (control PRIVADO o la «P» de la clave: «09PJN3581T»), activos, escuelas de preescolar, primaria,
// secundaria o media superior (bachillerato, profesional técnico). Fuera superior, CAM/especial, inicial (guarderías),
// adultos y formación para el trabajo.
const pickF = (r, ...ks) => { for (const k of ks) if (r[k] != null && String(r[k]).trim() !== "") return clean(r[k]); return ""; };
export function mxRow(r) {
  const cct = pickF(r, "CV_CCT", "CLAVECCT", "CCT", "CLAVE_CCT", "cct", "clave");
  const num = pickF(r, "INMUEBLE_N_EXTNUM", "NUMEXT", "NUM_EXT");
  const alf = pickF(r, "INMUEBLE_C_EXTALF", "EXTALF");
  const street = pickF(r, "INMUEBLE_C_VIALIDAD_PRINCIPAL", "DOMICILIO", "domicilio", "CALLE");
  const ext = [num && num !== "0" ? num : "", alf && !/^(sn|s\/n|0)$/i.test(alf) ? alf : ""].filter(Boolean).join(" ");
  return {
    cct, name: pickF(r, "C_NOMBRE", "NOMBRECT", "NOMBRE", "nombre", "nombreCT"),
    control: pickF(r, "SOSTENIMIENTO_C_CONTROL", "NOMBRECONT", "CONTROL", "control", "nombreCont"),
    status: pickF(r, "C_ESTATUS", "ESTATUS", "NOMBREESTATUS"), tipo: pickF(r, "C_TIPO", "TIPO", "tipoCtId"),
    tipoedu: pickF(r, "TIPONIVELSUB_C_SERVICION1", "NOMBRETIPO", "TIPOEDUCATIVO", "tipoedu", "nombreTipo"),
    nivel: pickF(r, "TIPONIVELSUB_C_SERVICION2", "NOMBRENIV", "NIVEL", "nivel", "nombreNiv"),
    sub: pickF(r, "TIPONIVELSUB_C_SERVICION3", "NOMBRESUBN", "SUBNIVEL", "subNivel"),
    street: street && !/^ninguno/i.test(street) ? street + (ext ? " " + ext : "") : "",
    colonia: pickF(r, "INMUEBLE_C_NOM_ASEN", "COLONIA", "NOMBRECOL", "colonia"), cp: pickF(r, "INMUEBLE_CV_CODIGO_POSTAL", "CODPOST", "CP", "codPost"),
    mun: pickF(r, "INMUEBLE_C_NOM_MUN", "NOMBREMUN", "MUNICIPIO", "municipio", "nombreMun"), loc: pickF(r, "INMUEBLE_C_NOM_LOC", "NOMBRELOC", "LOCALIDAD", "localidad", "nombreLoc"),
    ent: pickF(r, "INMUEBLE_C_NOM_ENT", "NOMBREENT", "ENTIDAD", "entidad", "nombreEnt"),
    lat: pickF(r, "INMUEBLE_LATITUD", "LATITUD", "latDms", "LAT"), lng: pickF(r, "INMUEBLE_LONGITUD", "LONGITUD", "lonDms", "LON", "LNG"),
    phone: pickF(r, "CONTACTO_C_TELEFONO", "TELEFONO"), cel: pickF(r, "CONTACTO_C_CELULAR", "CELULAR"),
    email: pickF(r, "CONTACTO_C_EMAIL", "CORREOELE", "EMAIL", "CORREO"), web: pickF(r, "CONTACTO_C_PWEB", "PAGINAWEB", "WEB"),
  };
}
export function levelMX(x) {
  const t = norm(`${x.tipoedu} ${x.nivel} ${x.sub}`);
  if (/superior/.test(norm(x.tipoedu)) && !/media superior/.test(norm(x.tipoedu))) return "";
  if (/\b(cam|especial|adultos|formacion para el trabajo|capacitacion|licenciatura|posgrado|normal|inicial)\b/.test(t) && !/preescolar/.test(t)) return "";
  if (/preescolar/.test(t)) return "Preescolar";
  if (/primaria/.test(t)) return "Primaria";
  if (/secundaria/.test(t) && !/media superior/.test(t)) return "Secundaria";
  if (/bachillerato|media superior|profesional tecnico|preparatoria/.test(t)) return "Prepa";
  return "";
}
export function keepMX(x) {
  const priv = x.control ? /privad|particular/.test(norm(x.control)) : /^\d{2}P/i.test(x.cct);
  const active = !x.status || /^(activ|reapert|cambio)/.test(norm(x.status)) || x.status === "1";
  const school = !x.tipo || /escuela|plantel/.test(norm(x.tipo));
  return !!(x.cct && x.name && priv && active && school && levelMX(x) && !notSchool(norm(x.name)));
}
// Ciudad en México: la base agrupa por la ciudad del radar (la de OpenStreetMap: «Ciudad de México» para toda la CDMX,
// «Monterrey», «Guadalajara»…). Igual que Perú: la ciudad del radar que contiene el punto; si no, la localidad (o el
// municipio) con el nombre que ya usa la base. La CDMX siempre es «Ciudad de México» (la alcaldía va en la dirección).
export function cityMX(x, pt, radarCities = [], baseCities = new Map()) {
  if (/^ciudad de mexico|^distrito federal/.test(norm(x.ent))) return baseCities.get("ciudad de mexico") || "Ciudad de México";
  if (pt) {
    let best = null, bd = Infinity;
    for (const c of radarCities) { const d = km(c, pt); if (d <= radiusKm(c.pop) && d < bd) { best = c; bd = d; } }
    if (best) return best.name;
  }
  return cityByName(x.loc || x.mun, baseCities) || cityByName(x.mun, baseCities);
}
export function groupMX(rows, { radarCities = [], baseCities = new Map(), towns = new Map() } = {}) {
  const items = [];
  const seenCct = new Set();
  for (const raw of rows) {
    const x = mxRow(raw); if (!keepMX(x) || seenCct.has(x.cct)) continue;
    seenCct.add(x.cct);
    items.push({ x, pt: okPoint(x.lat, x.lng, "MX"), name: nameMX(x.name), level: levelMX(x), dom: norm(`${x.street} ${x.cp}`) });
  }
  // mismo plantel: mismo domicilio (calle, número y CP) y nombre propio, o mismo municipio y nombre propio
  const groups = groupBy(items, it => [it.dom.length > 6 && `d:${it.dom}|${nameKey(it.name)}`, `m:${norm(it.x.ent)}|${norm(it.x.mun)}|${nameKey(it.name)}`]);
  const rank = it => ({ Prepa: 0, Secundaria: 1, Primaria: 2, Preescolar: 3 }[it.level]);
  return groups.map(g => {
    g.sort((a, b) => rank(a) - rank(b) || a.x.cct.localeCompare(b.x.cct));
    const x = g[0].x, pt0 = g.find(it => it.pt)?.pt;
    let pt = pt0, approx;
    if (!pt) { const t = towns.get(norm(`${x.ent}|${x.mun}`)); if (t) { pt = t; approx = "ciudad"; } }
    const city = cityMX(x, pt0, radarCities, baseCities);
    const mun = titleText(x.mun);
    return {
      name: g[0].name, city, lat: pt?.lat, lng: pt?.lng, approx,
      addr: joinAddr(titleText(x.street, { accents: false }), x.colonia && !/^ninguno/i.test(x.colonia) ? "Col. " + titleText(x.colonia, { accents: false }) : "", norm(mun) !== norm(city) ? mun : "", x.cp && x.cp !== "0" ? "C.P. " + String(x.cp).padStart(5, "0") : ""),
      phone: g.map(it => phoneMX(it.x.phone) || phoneMX(it.x.cel)).find(Boolean) || "", email: g.map(it => cleanMail(it.x.email)).find(Boolean) || "", web: g.map(it => cleanWeb(it.x.web)).find(Boolean) || "",
      levels: [...new Set(g.map(it => it.level))], code: x.cct, codes: [...new Set(g.map(it => it.x.cct))], region: titleText(x.ent),
    };
  });
}

// Sin punto en el padrón: el centro de su ciudad (el de los colegios de la base en esa ciudad, o la ciudad del radar),
// marcado `approx: "ciudad"`. Si la ciudad no está en ninguna de las dos, queda sin punto y no se suma (la app necesita
// lat y lng para el mapa, la cercanía y la cola).
export function cityCenters(schools, country, radarCities = []) {
  const acc = new Map();
  for (const s of schools) if (s.country === country && s.lat != null && s.approx !== "ciudad") { const k = norm(s.city); const a = acc.get(k) || { lat: [], lng: [] }; a.lat.push(s.lat); a.lng.push(s.lng); acc.set(k, a); }
  const med = v => { v = [...v].sort((a, b) => a - b); return v[v.length >> 1]; };
  const out = new Map([...acc].map(([k, a]) => [k, { lat: +med(a.lat).toFixed(5), lng: +med(a.lng).toFixed(5) }]));
  for (const c of radarCities) out.set(norm(c.name), { lat: c.lat, lng: c.lng });
  return out;
}
export function placeMissing(groups, centers) {
  for (const g of groups) if (g.lat == null) { const c = centers.get(norm(g.city)); if (c) { g.lat = c.lat; g.lng = c.lng; g.approx = "ciudad"; } }
  return groups;
}

// ---------- unir con la base
// Índice: código oficial, nombre propio por ciudad y una grilla de 0,1° para buscar cerca.
export function buildPadronIndex(schools, country) {
  const idx = { code: new Map(), byCity: new Map(), grid: new Map() };
  for (const s of schools) {
    if (s.country !== country) continue;
    for (const c of [s.code, ...(s.codes || [])]) if (c) idx.code.set(String(c), s);
    if (s.private === "no") continue; // lo que el radar ocultó no tapa a un colegio del padrón
    const ck = norm(s.city); if (!idx.byCity.has(ck)) idx.byCity.set(ck, []); idx.byCity.get(ck).push(s);
    if (s.lat != null) { const g = `${Math.floor(s.lat * 10)}|${Math.floor(s.lng * 10)}`; if (!idx.grid.has(g)) idx.grid.set(g, []); idx.grid.get(g).push(s); }
  }
  return idx;
}
const near = (idx, p) => { if (p.lat == null) return []; const a = Math.floor(p.lat * 10), b = Math.floor(p.lng * 10), out = []; for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const x of idx.grid.get(`${a + i}|${b + j}`) || []) out.push(x); return out; };
// Candidatos de la base para un colegio del padrón: { x, exact, d }.
//  - exact: mismo nombre propio (las palabras que distinguen, sin «colegio», «IEP», «jardín»…) y cerca: 2 km con punto
//    exacto, 3 km con el de ≈1 km, la misma ciudad (o 10 km) con el centro de la ciudad.
//  - parecido: comparten el 60 % de las palabras propias en los dos sentidos y están a menos de 0,7 km (1,5 km con el
//    punto de ≈1 km). Con el centro de la ciudad no hay parecidos (no hay cómo saber si es el mismo).
export function candidates(idx, g) {
  const mine = coreTokens(g.name); if (!mine.length) return [];
  const key = mine.join(" ");
  const pool = new Set([...near(idx, g), ...(g.approx === "ciudad" ? idx.byCity.get(norm(g.city)) || [] : [])]);
  const out = [];
  for (const x of pool) {
    const theirs = coreTokens(x.name); if (!theirs.length) continue;
    const d = g.lat != null && x.lat != null ? km(g, x) : Infinity, sameCity = norm(x.city) === norm(g.city);
    const eq = theirs.join(" ") === key || [...theirs].sort().join(" ") === [...mine].sort().join(" ");
    const lim = g.approx === "ciudad" ? (sameCity ? Infinity : 10) : g.approx === "1km" ? 3 : 2;
    if (eq && d <= lim) { out.push({ x, exact: true, d }); continue; }
    if (g.approx === "ciudad") continue;
    const shared = theirs.filter(w => mine.includes(w)).length;
    if (shared / theirs.length >= 0.6 && shared / mine.length >= 0.6 && d <= (g.approx === "1km" ? 1.5 : 0.7)) out.push({ x, exact: false, d });
  }
  return out;
}
// Plan: qué se suma y qué se completa. Cada colegio de la base se empareja con un solo colegio del padrón (el más
// seguro y más cercano); un segundo «San José» de la misma ciudad es otro colegio. Solo se completan campos vacíos y
// solo con coincidencia exacta (como el radar).
const FILL = ["phone", "email", "addr", "web"];
export function plan(schools, groups, { country, src, today = new Date().toISOString().slice(0, 10) }) {
  const idx = buildPadronIndex(schools, country);
  const st = { groups: groups.length, noPoint: 0, notSchool: 0, byCode: 0, exact: 0, similar: 0, filled: 0 };
  const pairs = [], fresh = [];
  groups.forEach((g, i) => {
    if (notSchool(norm(g.name))) { st.notSchool++; return; }
    if (g.lat == null) { st.noPoint++; return; }
    const byCode = [g.code, ...(g.codes || [])].map(c => idx.code.get(String(c))).find(Boolean);
    if (byCode) { pairs.push({ i, x: byCode, exact: true, d: -1, code: true }); return; }
    const c = candidates(idx, g);
    if (!c.length) { fresh.push(i); return; }
    for (const k of c) pairs.push({ i, ...k });
  });
  pairs.sort((a, b) => (b.code ? 1 : 0) - (a.code ? 1 : 0) || (b.exact ? 1 : 0) - (a.exact ? 1 : 0) || a.d - b.d);
  const usedX = new Set(), doneG = new Map();
  for (const p of pairs) { if (doneG.has(p.i) || (usedX.has(p.x) && !p.code)) continue; usedX.add(p.x); doneG.set(p.i, p); }
  const fills = [];
  for (const [i, p] of doneG) {
    const g = groups[i];
    if (p.code) st.byCode++; else if (p.exact) st.exact++; else { st.similar++; continue; }
    const set = {};
    for (const f of FILL) if (!p.x[f] && g[f]) set[f] = g[f];
    if (!p.x.levels?.length && g.levels?.length) set.levels = sortLevels(g.levels);
    if (!p.x.code) { set.code = g.code; set.padron = src; if (g.codes?.length > 1) set.codes = g.codes; }
    if (!p.x.students && g.students) set.students = g.students;
    if (Object.keys(set).length) fills.push({ x: p.x, set });
  }
  // los que tenían candidatos pero todos quedaron tomados por otro: son otro colegio
  const lost = [...new Set(pairs.map(p => p.i))].filter(i => !doneG.has(i));
  const add = [...fresh, ...lost].map(i => ({ g: groups[i], rec: record(groups[i], { country, src, today }) }));
  st.filled = fills.length; st.add = add.length;
  return { add, fills, stats: st };
}
// Prioridad para sumar primero (cuando hay tope): ciudades donde ya trabajamos (colegios de la base en esa ciudad),
// con teléfono o mail, más niveles y más alumnos si el padrón los trae. Con el punto en el centro de la ciudad, menos.
export function priority(rec, cityCount = new Map()) {
  let p = 0;
  const inCity = cityCount.get(norm(rec.city)) || 0;
  if (inCity) p += 30 + Math.min(20, Math.log10(inCity + 1) * 10);
  if (rec.phone) p += 20;
  if (rec.email) p += 10;
  if (rec.web) p += 5;
  p += (rec.levels?.length || 0) * 6;
  if (rec.students) p += Math.min(25, Math.log10(rec.students + 1) * 8);
  if (rec.approx === "ciudad") p -= 15;
  if ((rec.opp || []).includes("Bilingüe o internacional")) p += 5;
  return Math.round(p * 10) / 10;
}
export function applyPlan(schools, p, { max = Infinity, addTo, idx } = {}) {
  for (const f of p.fills) Object.assign(f.x, f.set);
  const counts = new Map();
  for (const s of schools) if (s.country === p.add[0]?.rec.country) counts.set(norm(s.city), (counts.get(norm(s.city)) || 0) + 1);
  const ranked = p.add.map(a => ({ ...a, pr: priority(a.rec, counts) })).sort((a, b) => b.pr - a.pr);
  const take = ranked.slice(0, max), left = ranked.slice(max);
  const added = take.map(a => addTo(schools, idx, a.rec));
  return { added, left };
}
// Lo que pesa un colegio en /api/schools (los campos de schoolListItem que salen del archivo, más status «unk»)
const LIST_FIELDS = ["id", "name", "city", "country", "lat", "lng", "addr", "phone", "web", "rating", "fit", "area", "osm"];
export function listBytes(list) {
  let b = 2;
  for (const s of list) { const o = {}; for (const k of LIST_FIELDS) if (s[k] !== undefined && s[k] !== "" && s[k] !== null) o[k] = s[k]; o.status = "unk"; b += Buffer.byteLength(JSON.stringify(o)) + 1; }
  return b;
}
export { slug };
