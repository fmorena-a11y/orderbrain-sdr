// Cargar base (pedido del líder de SDR: «una sección que sea cargar base de datos, con el link nomás»). Reglas puras: leer
// CSV o texto pegado, validar el link de Google Sheets, encontrar la fila de encabezado y las columnas, juntar las filas por
// institución con sus contactos, normalizar teléfonos, dejar afuera lo que no es colegio privado, la prioridad (explicada) y
// qué hacer con cada una según Pipedrive. Las lecturas (Google, Pipedrive, store) están en lib/sheets.js y lib/bases.js.
// Pruebas en test/import.test.mjs.
import { MARKETS } from "./config.js";

export const norm = s => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const squash = s => String(s ?? "").replace(/[ \s]+/g, " ").trim();
// lo que muestra una planilla cuando una fórmula falla, o un «no hay dato»: vacío
const ERR_CELL = /^(#(error!?|n\/a|ref!|value!|name\?|div\/0!|num!|null!|spill!|calc!)|n\/a|s\/d|sin dato(s)?|-+|\.+|null|undefined)$/i;
export const cleanCell = v => { const t = squash(v); return ERR_CELL.test(t) ? "" : t; };
export const LIMITS = { rows: 5000, cols: 60, cell: 600, tabs: 12 };

// ---------- CSV y texto pegado
// Separador: el que más aparece fuera de comillas en las primeras líneas (coma, punto y coma o tabulación).
export function sniffDelimiter(text) {
  const head = String(text).slice(0, 8000), n = { ",": 0, ";": 0, "\t": 0 };
  let q = false;
  for (const ch of head) { if (ch === '"') q = !q; else if (!q && ch in n) n[ch]++; else if (!q && ch === "\n" && n["\t"] + n[","] + n[";"] > 50) break; }
  return n["\t"] >= n[","] && n["\t"] >= n[";"] && n["\t"] > 0 ? "\t" : n[";"] > n[","] ? ";" : ",";
}
export function parseCsv(text, { delimiter = null, max = LIMITS } = {}) {
  const s = String(text ?? "").replace(/^﻿/, ""), d = delimiter || sniffDelimiter(s), rows = [];
  let row = [], cell = "", q = false, i = 0;
  const endCell = () => { row.push(cell.length > max.cell ? cell.slice(0, max.cell) : cell); cell = ""; };
  const endRow = () => { endCell(); if (row.length > max.cols) row.length = max.cols; rows.push(row); row = []; };
  while (i < s.length && rows.length < max.rows + 30) {
    const ch = s[i];
    if (q) {
      if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i += 2; continue; } q = false; i++; continue; }
      cell += ch; i++; continue;
    }
    if (ch === '"' && cell === "") { q = true; i++; continue; }
    if (ch === d) { endCell(); i++; continue; }
    if (ch === "\r") { i++; continue; }
    if (ch === "\n") { endRow(); i++; continue; }
    cell += ch; i++;
  }
  if (cell !== "" || row.length) endRow();
  while (rows.length && rows.at(-1).every(c => !String(c).trim())) rows.pop();
  return rows;
}

// ---------- el link: solo docs.google.com/spreadsheets/d/<id> (nada de otros hosts: el servidor no sale a cualquier lado)
export function sheetLink(raw) {
  let u;
  try { u = new URL(String(raw ?? "").trim()); } catch { return null; }
  if (u.protocol !== "https:" || u.hostname !== "docs.google.com" || u.port || u.username || u.password) return null;
  const m = u.pathname.match(/^\/spreadsheets\/(?:u\/\d{1,2}\/)?d\/([A-Za-z0-9_-]{20,100})(?:\/|$)/);
  if (!m) return null;
  const gid = (u.hash.match(/gid=(\d{1,12})/) || u.search.match(/[?&]gid=(\d{1,12})/) || [])[1] ?? null;
  return { id: m[1], gid };
}
export const exportCsvUrl = (id, gid) => `https://docs.google.com/spreadsheets/d/${encodeURIComponent(id)}/export?format=csv${gid != null ? `&gid=${encodeURIComponent(gid)}` : ""}`;
export const htmlViewUrl = id => `https://docs.google.com/spreadsheets/d/${encodeURIComponent(id)}/htmlview`;
// Google manda el CSV desde otro host (…googleusercontent.com): una redirección solo se sigue a esos dos
export function okRedirect(raw) {
  let u; try { u = new URL(raw); } catch { return false; }
  return u.protocol === "https:" && !u.port && !u.username && !u.password && (u.hostname === "docs.google.com" || /^[a-z0-9-]+\.googleusercontent\.com$/.test(u.hostname));
}
// accounts.google.com (pide iniciar sesión): la planilla es privada
export const isLoginRedirect = raw => { try { const u = new URL(raw); return /(^|\.)accounts\.google\.com$/.test(u.hostname) || /ServiceLogin|signin/i.test(u.pathname); } catch { return false; } };
const jsUnescape = s => s.replace(/\\x([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\(["'\\/])/g, "$1");
const htmlUnescape = s => String(s).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|#39);/gi, (m, e) => e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[e.toLowerCase()] ?? m);
// pestañas de la vista htmlview de una planilla compartida: items.push({name: "Inscriptos", …, gid: "0", …})
export function tabsFromHtml(html) {
  const out = [], seen = new Set();
  for (const m of String(html || "").matchAll(/items\.push\(\{name:\s*"((?:[^"\\]|\\.)*)"[^}]*?gid:\s*"(\d+)"/g)) {
    if (seen.has(m[2])) continue; seen.add(m[2]);
    out.push({ name: squash(jsUnescape(m[1])).slice(0, 100), gid: m[2] });
  }
  return out;
}
export function titleFromHtml(html) {
  const t = (String(html || "").match(/<title>([^<]*)<\/title>/i) || [])[1];
  return t ? squash(htmlUnescape(t)).replace(/\s+-\s+(Google (Drive|Sheets|Docs)|Hojas de c[aá]lculo de Google|Planilhas Google)$/i, "") : "";
}

// ---------- el evento y el lugar, desde el título del archivo
// «Base de Inscriptos EduExperience Mendoza 2026 (OrderEAT) (1)» → «EduExperience Mendoza 2026»
export function eventFromTitle(title) {
  let t = squash(title).replace(/\.(xlsx|xls|csv|ods|tsv)$/i, "").replace(/\s+-\s+(Google (Drive|Sheets)|Hojas de c[aá]lculo de Google)$/i, "").replace(/^(copia de|copy of)\s+/i, "");
  for (let k = 0; k < 6; k++) {
    const m = t.match(/\s*\(([^()]*)\)\s*$/); if (!m) break;
    if (/\b20\d\d\b/.test(m[1]) && !/^\s*\d+\s*$/.test(m[1])) { t = m[1]; break; }
    t = t.slice(0, m.index).trim();
  }
  t = t.replace(/^(base|listado|lista|planilla|registro|reporte|export(ación)?)(\s+(de|del)\s+datos)?(\s+(de|del))?\s+/i, "")
    .replace(/^(inscriptos|inscritos|inscripciones|asistentes|participantes|registrados|interesados|leads)(\s+(de|del|al|a|en))?\s+/i, "")
    .replace(/^(el|la)\s+/i, "");
  return squash(t).slice(0, 80);
}
// ciudades de eventos que se repiten (y los países por nombre): Mendoza → Argentina
const CITIES = [["Mendoza", "Argentina"], ["Córdoba", "Argentina"], ["Rosario", "Argentina"], ["Buenos Aires", "Argentina"], ["CABA", "Argentina"], ["La Plata", "Argentina"], ["Tucumán", "Argentina"],
  ["Salta", "Argentina"], ["Neuquén", "Argentina"], ["Mar del Plata", "Argentina"], ["San Juan", "Argentina"], ["Bahía Blanca", "Argentina"], ["Santa Fe", "Argentina"],
  ["Montevideo", "Uruguay"], ["Punta del Este", "Uruguay"], ["Santiago", "Chile"], ["Viña del Mar", "Chile"], ["Concepción", "Chile"], ["Lima", "Perú"], ["Arequipa", "Perú"], ["Trujillo", "Perú"],
  ["Ciudad de México", "México"], ["CDMX", "México"], ["Monterrey", "México"], ["Guadalajara", "México"], ["Puebla", "México"], ["Querétaro", "México"], ["Mérida", "México"], ["Tijuana", "México"],
  ["León", "México"], ["Cancún", "México"], ["Toluca", "México"], ["Chihuahua", "México"], ["Bogotá", "Colombia"], ["Medellín", "Colombia"], ["Cali", "Colombia"], ["Quito", "Ecuador"], ["Guayaquil", "Ecuador"],
  ["Asunción", "Paraguay"], ["La Paz", "Bolivia"], ["Santa Cruz", "Bolivia"], ["Panamá", "Panamá"], ["Guatemala", "Guatemala"]];
const hasWords = (hay, w) => ` ${hay} `.includes(` ${w} `);
export function placeFromText(text) {
  const n = norm(text);
  for (const [city, country] of CITIES) if (hasWords(n, norm(city))) return { city: city === "CDMX" ? "Ciudad de México" : city === "CABA" ? "Buenos Aires" : city, country };
  const c = Object.keys(MARKETS).find(k => hasWords(n, norm(k)));
  return { city: "", country: c || "" };
}

// ---------- columnas
export const FIELDS = {
  inst: "Institución", name: "Nombre de la persona", role: "Cargo o rol", phone: "Teléfono", email: "Email", city: "Ciudad o zona", students: "Cantidad de alumnos",
  type: "Tipo (público o privado)", pd: "Link de Pipedrive", pdPerson: "Persona en Pipedrive", contacted: "Contactado", others: "Otros contactos", count: "Inscriptos",
  prio: "Prioridad", notes: "Notas", next: "Próximo paso",
};
// sinónimos (sin acentos ni signos). exact: el encabezado es eso; start: empieza así; word: lo contiene como palabras.
const SYN = {
  inst: { exact: ["institucion", "institucion educativa", "colegio", "escuela", "nombre del colegio", "nombre de la institucion", "establecimiento", "nombre de la escuela", "organizacion", "empresa", "instituciones"],
    start: ["nombre de la institucion", "institucion educativa", "nombre del colegio", "nombre del establecimiento", "colegio al que", "institucion a la que", "institucion que"], word: ["institucion", "colegio", "escuela", "establecimiento"],
    not: /^(tipo|cantidad|ya en)\b|\balumnos\b|\bciudad\b|\bdireccion\b/ },
  name: { exact: ["nombre y apellido", "nombre completo", "apellido y nombre", "nombre", "nombres", "decisor principal", "decisor", "contacto", "persona", "responsable", "participante", "inscripto", "asistente"],
    start: ["nombre y apellido", "nombre completo", "apellido y nombre"], word: ["nombre y apellido", "apellido"],
    not: /institucion|colegio|escuela|organizacion|empresa|establecimiento|otros|evento|usuario/ },
  role: { exact: ["rol", "cargo", "cargo o rol", "rol o cargo", "puesto", "funcion", "ocupacion"], start: ["cargo", "rol", "puesto", "funcion que"], word: ["cargo", "puesto"], not: /prospecto|pipe/ },
  phone: { exact: ["telefono", "tel", "celular", "whatsapp", "movil", "numero de telefono", "numero de celular", "telefono celular", "telefono de contacto", "numero", "whatsapp de contacto"],
    start: ["telefono", "numero de telefono", "numero de celular", "celular", "whatsapp"], word: ["telefono", "celular", "whatsapp"], not: /otros/ },
  email: { exact: ["email", "e mail", "mail", "correo", "correo electronico", "direccion de correo electronico", "direccion de correo", "email de contacto"], start: ["correo", "email", "e mail", "direccion de correo"], word: ["email", "correo", "mail"], not: /otros/ },
  city: { exact: ["ciudad", "zona", "localidad", "departamento", "provincia", "municipio", "comuna", "barrio", "region", "partido"], start: ["ciudad", "localidad", "zona"], word: ["ciudad", "localidad", "zona"], not: /alumnos|telefono/ },
  students: { exact: ["cantidad de alumnos", "alumnos", "matricula", "tamano", "tamano alumnos", "estudiantes", "cantidad de estudiantes", "numero de alumnos", "total de alumnos"],
    start: ["cantidad de alumnos", "tamano", "matricula", "numero de alumnos", "cantidad de estudiantes"], word: ["alumnos", "estudiantes", "matricula"], not: /acompanantes|inscriptos/ },
  type: { exact: ["tipo de organizacion", "tipo", "tipo de institucion", "gestion", "sector", "dependencia", "tipo de colegio", "tipo de escuela"], start: ["tipo de organizacion", "tipo de institucion", "tipo de colegio", "gestion"],
    word: ["tipo de organizacion", "gestion"], not: /prospecto|persona|pipe/ },
  pd: { exact: ["pipe drive", "pipedrive", "pipe link", "link pipedrive", "link de pipedrive", "pipe", "link", "url pipedrive", "link prospecto"], start: ["link de pipe", "link pipe", "pipedrive link", "pipe drive"], word: ["pipedrive"], not: /estado|dueno|owner|persona/ },
  pdPerson: { exact: ["tipo prospecto persona", "persona pipedrive", "link persona", "persona en pipedrive", "persona pipe"], start: ["tipo prospecto persona", "link persona"], word: ["prospecto persona"], not: /estado|dueno/ },
  contacted: { exact: ["contactado", "contactada", "llamado", "ya contactado", "contacto realizado", "se contacto", "llamada"], start: ["contactado"], word: ["contactado"], not: /otros/ },
  others: { exact: ["otros contactos", "otros contactos con datos", "mas contactos", "otros"], start: ["otros contactos"], word: ["otros contactos"], not: null },
  count: { exact: ["inscriptos", "cantidad de inscriptos", "inscritos", "asistentes"], start: ["cantidad de inscriptos"], word: [], not: null },
  prio: { exact: ["prioridad", "prio"], start: ["prioridad"], word: ["prioridad"], not: null },
  notes: { exact: ["notas", "nota", "observaciones", "comentarios", "comentario", "obs"], start: ["notas", "observaciones", "comentarios"], word: ["notas", "observaciones"], not: null },
  next: { exact: ["proximo paso", "proximo paso sugerido", "siguiente paso"], start: ["proximo paso"], word: ["proximo paso"], not: null },
};
export const IGNORED = /^(id|n|nro|numero de orden|marca temporal|timestamp|fecha|cantidad de acompanantes|acompanantes|ya en interesados|pipe estado|pipe dueno|score|puntaje)$/;
export function headerScore(field, header) {
  const h = norm(header), r = SYN[field];
  if (!h || !r || IGNORED.test(h) || (r.not && r.not.test(h))) return 0;
  if (r.exact.includes(h)) return 100;
  if (r.start.some(p => h.startsWith(p + " ") || h === p)) return 80;
  if (r.word.some(p => hasWords(h, p))) return 60;
  return 0;
}
const isMail = v => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(String(v).trim());
const isPhoneish = v => { const t = String(v).trim(); return (t.match(/\d/g) || []).length >= 8 && !/[a-z]{3,}/i.test(t.replace(/\b(ext|int|cel|tel)\b/gi, "")); };
export const PD_LINK = /^https?:\/\/[a-z0-9-]+\.pipedrive\.com\/(leads\/inbox\/|leads\/|lead\/|deal\/|organization\/|person\/)/i;
// ¿Qué fila es el encabezado? La que más celdas tiene que parecen nombres de columna (en las primeras 25).
export function findHeader(rows) {
  let best = 0, bestScore = 0;
  for (let i = 0; i < Math.min(rows.length, 25); i++) {
    const r = rows[i] || [], filled = r.filter(c => String(c).trim()).length;
    if (filled < 2) continue;
    let sc = 0;
    for (const c of r) { const top = Math.max(...Object.keys(SYN).map(f => headerScore(f, c))); if (top >= 60) sc += top / 100; }
    // una fila de datos (mails, teléfonos, links) no es encabezado
    if (r.some(c => isMail(c) || PD_LINK.test(String(c)))) sc -= 2;
    if (sc > bestScore + 0.01) { best = i; bestScore = sc; }
  }
  return bestScore >= 1.5 ? best : 0;
}
const colValues = (rows, j, n = 60) => rows.slice(0, n).map(r => cleanCell(r?.[j] ?? "")).filter(Boolean);
// { campo: índice de columna } con el encabezado y, si no alcanza, el contenido (mails, teléfonos, links de Pipedrive)
export function detectColumns(headers, data = []) {
  const map = {}, used = new Set(), pairs = [];
  headers.forEach((h, j) => { for (const f of Object.keys(SYN)) { const sc = headerScore(f, h); if (sc) pairs.push([sc, f, j]); } });
  pairs.sort((a, b) => b[0] - a[0] || a[2] - b[2]);
  for (const [, f, j] of pairs) if (!(f in map) && !used.has(j)) { map[f] = j; used.add(j); }
  // por contenido
  const free = headers.map((h, j) => j).filter(j => !used.has(j));
  const share = (j, test) => { const v = colValues(data, j); return v.length ? v.filter(test).length / v.length : 0; };
  for (const j of free) {
    if (used.has(j)) continue;
    const links = colValues(data, j).filter(v => PD_LINK.test(v));
    if (links.length && share(j, v => PD_LINK.test(v)) >= 0.5) {
      const person = links.filter(v => /\/person\//i.test(v)).length > links.length / 2;
      const f = person ? "pdPerson" : "pd";
      if (!(f in map)) { map[f] = j; used.add(j); }
    }
  }
  // un link de Pipedrive que cayó por encabezado en el campo equivocado (persona ↔ prospecto)
  if (map.pd != null && map.pdPerson == null) { const v = colValues(data, map.pd); if (v.length && v.filter(x => /\/person\//i.test(x)).length > v.length / 2) { map.pdPerson = map.pd; delete map.pd; } }
  if (map.email == null) { const j = free.find(j => !used.has(j) && share(j, isMail) >= 0.6); if (j != null) { map.email = j; used.add(j); } }
  if (map.phone == null) { const j = free.find(j => !used.has(j) && share(j, isPhoneish) >= 0.6); if (j != null) { map.phone = j; used.add(j); } }
  return map;
}
// lo que viene del navegador (la persona corrigió una columna): solo campos conocidos e índices válidos, sin repetir
export function cleanMap(raw, ncols) {
  const out = {}, used = new Set();
  for (const f of Object.keys(FIELDS)) {
    const v = raw?.[f]; if (v === null || v === undefined || v === "") continue;
    const j = Number(v); if (!Number.isInteger(j) || j < 0 || j >= ncols || used.has(j)) continue;
    out[f] = j; used.add(j);
  }
  return out;
}

// ---------- valores
// «Fabiana, Robles» (nombre, apellido) → «Fabiana Robles»; TODO EN MAYÚSCULAS o minúsculas → con mayúscula inicial
export function personName(v) {
  let t = cleanCell(v).replace(/\s*,\s*/g, ", ");
  const parts = t.split(", ");
  if (parts.length === 2 && parts[0] && parts[1]) t = `${parts[0]} ${parts[1]}`;
  t = t.replace(/,/g, " ").replace(/\s+/g, " ").trim();
  if (t && (t === t.toUpperCase() || t === t.toLowerCase())) t = t.toLowerCase().replace(/(^|[\s'-])\p{L}/gu, m => m.toUpperCase());
  return t.slice(0, 80);
}
const capFirst = t => t ? t[0].toUpperCase() + t.slice(1) : t;
export const roleText = v => { const t = cleanCell(v); return capFirst(t === t.toUpperCase() && t.length > 4 ? t.toLowerCase() : t).slice(0, 80); };
export const emailOf = v => { const m = cleanCell(v).toLowerCase().match(/[^\s@<>(),;:]+@[^\s@<>(),;:]+\.[a-z]{2,}/); return m ? m[0] : ""; };
// Teléfono con el prefijo del país (E.164, «+5492615532690»). Argentina: los celulares van con 9 después del 54 (se saca el 0
// de la característica y el 15); un número local de 10 dígitos se toma como celular (es lo que se pide en un formulario).
// México: 10 dígitos (sin el 1 viejo de los celulares ni 01/044/045). Otros países: su prefijo de MARKETS.
export function normPhone(raw, country = "") {
  const t = cleanCell(raw); if (!t) return "";
  let plus = /^\s*(\+|00)/.test(t), d = t.replace(/\D/g, "");
  if (d.startsWith("00")) { d = d.slice(2); plus = true; }
  if (d.length < 7 || d.length > 15) return "";
  const pre = MARKETS[country]?.prefix || "";
  const ar = (local) => {
    let x = local.replace(/^0/, "");
    if (x.length === 12) for (const k of [2, 3, 4]) if (x.slice(k, k + 2) === "15") { x = x.slice(0, k) + x.slice(k + 2); break; }
    return x.length === 10 ? "+549" + x : "";
  };
  const mx = local => { let x = local.replace(/^(01|044|045)/, ""); if (x.length === 11 && x.startsWith("1")) x = x.slice(1); return x.length === 10 ? "+52" + x : ""; };
  if (plus || (pre && d.startsWith(pre) && d.length >= pre.length + 9)) {
    if (d.startsWith("54")) { const r = d.slice(2); if (r.startsWith("9") && r.length === 11) return "+" + d; return ar(r) || "+" + d; }
    if (d.startsWith("52")) { let r = d.slice(2); if (r.length === 11 && r.startsWith("1")) r = r.slice(1); return r.length === 10 ? "+52" + r : "+" + d; }
    return "+" + d;
  }
  if (country === "Argentina") return ar(d) || (pre ? `+${pre}${d.replace(/^0/, "")}` : "");
  if (country === "México") return mx(d) || "";
  return pre ? `+${pre}${d.replace(/^0/, "")}` : d;
}
export const waLink = e164 => e164 ? `https://wa.me/${e164.replace(/\D/g, "")}` : "";
// «601 a 1.000 alumnos» → { min: 601, max: 1000 }; «Más de 1.000» → { min: 1001, max: null }; «850» → { min: 850, max: 850 }
export function parseStudents(v) {
  const t = cleanCell(v); if (!t) return null;
  const nums = (t.match(/\d{1,3}(?:[.,]\d{3})+|\d+/g) || []).map(x => Number(x.replace(/[.,]/g, ""))).filter(n => n > 0 && n < 100000);
  if (!nums.length) return null;
  const n = norm(t), label = t.slice(0, 40);
  if (/\b(mas de|mayor|arriba de|over)\b/.test(n) || /\+\s*$/.test(t)) return { min: nums[0] + 1, max: null, label };
  if (/\b(hasta|menos de|menor|under)\b/.test(n)) return { min: 0, max: nums[0], label };
  if (nums.length >= 2) return { min: Math.min(nums[0], nums[1]), max: Math.max(nums[0], nums[1]), label };
  return { min: nums[0], max: nums[0], label };
}
export function yesNo(v) {
  const n = norm(cleanCell(v));
  if (!n) return null;
  if (/^(true|verdadero|si|yes|x|ok|1|contactado|contactada|hecho|listo)$/.test(n)) return true;
  if (/^(false|falso|no|0|pendiente)$/.test(n)) return false;
  return null;
}
// link de Pipedrive de una celda: { kind: lead|deal|organization|person, id, url }
export function pdLink(v) {
  const t = String(v ?? "").trim().match(/https?:\/\/[a-z0-9-]+\.pipedrive\.com\/[^\s"'<>]+/i)?.[0]; if (!t) return null;
  let u; try { u = new URL(t); } catch { return null; }
  let m;
  if ((m = u.pathname.match(/^\/leads?\/(?:inbox\/)?([0-9a-f-]{8,40})(?:\/|$)/i))) return { kind: "lead", id: m[1].toLowerCase(), url: `${u.origin}/leads/inbox/${m[1].toLowerCase()}` };
  if ((m = u.pathname.match(/^\/(deal|organization|person)\/(\d{1,12})(?:\/|$)/i))) return { kind: m[1].toLowerCase(), id: Number(m[2]), url: `${u.origin}/${m[1].toLowerCase()}/${m[2]}` };
  return null;
}
// «Nombre – Cargo – +54 9 … | Otro – Cargo – mail@…» → [{ name, role, phone, email }]
export function splitOthers(v, country = "") {
  const out = [];
  for (const part of cleanCell(v).split(/\s*\|\s*|\s*\n\s*/)) {
    if (!part) continue;
    const bits = part.split(/\s+[–—-]\s+|\s*;\s*/).map(cleanCell).filter(Boolean), c = { name: "", role: "", phone: "", email: "" }, rest = [];
    for (const b of bits) { if (!c.email && emailOf(b)) c.email = emailOf(b); else if (!c.phone && isPhoneish(b)) c.phone = normPhone(b, country); else rest.push(b); }
    c.name = personName(rest[0] || ""); c.role = roleText(rest.slice(1).join(" – "));
    if (c.name || c.phone || c.email) out.push(c);
  }
  return out;
}
// quien decide (o puede abrir la puerta a quien decide): dirección, rectoría, representante legal, administración, dueños
const DECISOR = /\b(director|directora|directivo|directiva|direccion|rector|rectora|rectoria|vicedirector|vicedirectora|vicerrector|vicerrectora|representante legal|apoderado legal|apoderada legal|administrador|administradora|administracion|dueno|duena|duenos|propietario|propietaria|fundador|fundadora|presidente|presidenta|gerente|socio|socia|legal|sostenedor|sostenedora|titular)\b/;
export const isDecisor = role => DECISOR.test(norm(role)) && !/\b(asistente|auxiliar|secretaria de)\b/.test(norm(role));

// ---------- tipo de institución: lo que no es colegio privado queda afuera (se puede ver igual)
const TYPE_WORD = /^(colegio|escuela|instituto|liceo|jardin|jardin de infantes|centro educativo|complejo educativo|unidad educativa|school|college)\s+/;
export function instKind(typeText, name) {
  const t = norm(typeText), n = norm(name), raw = String(name || "");
  if (/\b(supervision|supervisora|supervisor|inspeccion|ministerio|direccion general de escuelas|secretaria de educacion|consejo de educacion|delegacion)\b/.test(n) || /\b(DEP|DGE|DEGE)\b/.test(raw)) return "office";
  if (/\b(universidad|facultad|universitario|universitaria)\b/.test(n)) return "uni";
  if (/\bprivad|\bparticular|\bparroquial|\bconfesional|\bsubvencionad|\bconcertad/.test(t)) return "private";
  if (/\bpublic|\bestatal|\boficial|\bfiscal|\bmunicipal|\bdel estado|\bgobierno/.test(t)) return "public";
  if (/\buniversi|\bterciari|\bsuperior/.test(t)) return "uni";
  return "";
}
export const KIND_OUT = { public: "Es público", office: "No es un colegio (supervisión u oficina)", uni: "Universidad o terciario" };
// clave para juntar: «Colegio Marista San José» = «colegio marista san jose» (con «Esc.», «Inst.», «Nº» escritos de otra forma)
const ABBR = { esc: "escuela", inst: "instituto", col: "colegio", nro: "n", num: "n", no: "n", nd: "n", gral: "general", sta: "santa", sto: "santo", ntra: "nuestra", sra: "senora" };
export const instKey = name => norm(String(name || "").replace(/n[°º]/gi, "n ")).split(" ").map(w => ABBR[w] || w).join(" ").trim();
const coreKey = k => k.replace(TYPE_WORD, "");
// el nombre que se muestra: el más repetido, preferido con «Colegio…» y sin TODO EN MAYÚSCULAS
function bestName(names) {
  const c = new Map(); for (const n of names) c.set(n, (c.get(n) || 0) + 1);
  const score = n => (c.get(n) || 0) * 10 + (TYPE_WORD.test(norm(n) + " ") ? 3 : 0) + (n !== n.toUpperCase() ? 2 : 0) + Math.min(n.length, 60) / 100;
  let best = [...c.keys()].sort((a, b) => score(b) - score(a))[0] || "";
  if (best && best === best.toUpperCase()) best = best.toLowerCase().replace(/(^|[\s'"(-])\p{L}/gu, m => m.toUpperCase());
  return best.slice(0, 120);
}
const mostOf = list => { const c = new Map(); for (const x of list.filter(Boolean)) c.set(x, (c.get(x) || 0) + 1); return [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || ""; };

// ---------- la base: filas → instituciones con sus contactos
const cell = (r, j) => j == null ? "" : cleanCell(r?.[j] ?? "");
export function buildBase(rows, { header = 0, map = {}, country = "", city = "" } = {}) {
  const data = rows.slice(header + 1), groups = new Map(), order = [];
  let people = 0, noInst = 0, empty = 0;
  for (const r of data) {
    if (!r || r.every(c => !String(c ?? "").trim())) { empty++; continue; }
    const name = cell(r, map.inst);
    if (!name) { if (cell(r, map.name) || cell(r, map.email) || cell(r, map.phone)) noInst++; else empty++; continue; }
    const k = instKey(name); if (!k) { noInst++; continue; }
    let g = groups.get(k);
    if (!g) { g = { key: k, names: [], cities: [], types: [], students: [], rows: [] }; groups.set(k, g); order.push(k); }
    g.names.push(name); g.cities.push(cell(r, map.city)); g.types.push(cell(r, map.type)); g.students.push(cell(r, map.students)); g.rows.push(r);
  }
  // «Marista San José» y «Colegio Marista San José»: el mismo (solo si el nombre corto tiene 2 palabras o más)
  for (const k of [...order]) {
    const g = groups.get(k); if (!g || TYPE_WORD.test(k + " ") || k.split(" ").length < 2) continue;
    const into = order.find(o => o !== k && groups.has(o) && TYPE_WORD.test(o + " ") && coreKey(o) === k);
    if (into) { const t = groups.get(into); for (const f of ["names", "cities", "types", "students", "rows"]) t[f].push(...g[f]); groups.delete(k); }
  }
  const items = [];
  for (const k of order) {
    const g = groups.get(k); if (!g) continue;
    const name = bestName(g.names), typeText = mostOf(g.types), kind = instKind(typeText, name);
    const st = g.students.map(parseStudents).filter(Boolean).sort((a, b) => (b.max ?? b.min) - (a.max ?? a.min))[0] || null;
    const contacts = [], seen = new Set(), pd = [], pdSeen = new Set();
    let contacted = null, count = 0;
    const notes = new Set(), next = new Set(), prio = new Set();
    const addC = c => {
      const id = c.email || c.phone || norm(c.name); if (!id || seen.has(id)) { const o = contacts.find(x => (c.email && x.email === c.email) || (c.phone && x.phone === c.phone)); if (o) { o.role ||= c.role; o.phone ||= c.phone; o.email ||= c.email; } return; }
      seen.add(id); contacts.push({ ...c, decisor: isDecisor(c.role) });
    };
    for (const r of g.rows) {
      const phoneRaw = cell(r, map.phone), c = { name: personName(cell(r, map.name)), role: roleText(cell(r, map.role)), phone: normPhone(phoneRaw, country), email: emailOf(cell(r, map.email)) };
      if (c.name || c.phone || c.email) { people++; addC(c); }
      for (const o of map.others != null ? splitOthers(cell(r, map.others), country) : []) addC({ ...o, other: true });
      for (const j of [map.pd, map.pdPerson]) { const l = j == null ? null : pdLink(r?.[j]); if (l && !pdSeen.has(l.url)) { pdSeen.add(l.url); pd.push(l); } }
      const y = yesNo(cell(r, map.contacted)); if (y === true) contacted = true; else if (y === false && contacted === null) contacted = false;
      const n = Number(cell(r, map.count).replace(/\D/g, "")); if (n > count) count = n;
      if (cell(r, map.notes)) notes.add(cell(r, map.notes).slice(0, 300));
      if (cell(r, map.next)) next.add(cell(r, map.next).slice(0, 200));
      if (cell(r, map.prio)) prio.add(cell(r, map.prio).slice(0, 30));
    }
    contacts.sort((a, b) => b.decisor - a.decisor || (!!a.other - !!b.other) || (!!b.phone - !!a.phone));
    const it = { n: items.length, key: k, name, city: mostOf(g.cities) || city, country, kind, typeText: typeText.slice(0, 60), students: st, contacts: contacts.slice(0, 12),
      count: Math.max(count, contacts.filter(c => !c.other).length), pd: pd.slice(0, 4), contacted, notes: [...notes].join(" · ").slice(0, 500), next: [...next].join(" · ").slice(0, 300), sheetPrio: [...prio][0] || "" };
    it.out = KIND_OUT[it.kind] || "";
    it.prio = priorityOf(it);
    items.push(it);
  }
  items.sort((a, b) => b.prio.score - a.prio.score || b.contacts.length - a.contacts.length || a.name.localeCompare(b.name, "es"));
  items.forEach((it, i) => { it.n = i; });
  return { items, counts: { rows: data.length - empty, people, institutions: items.length, out: items.filter(i => i.out).length, noInst } };
}
// Prioridad simple y explicada, solo con lo que trae la planilla (sin inventar): alumnos, privado, cuántos se inscribieron,
// si vino alguien que decide y la prioridad que ya traía la planilla (el estudio).
export function priorityOf(it) {
  let score = 0; const why = [];
  const add = (n, t) => { score += n; why.push(t); };
  const s = it.students, top = s ? (s.max ?? s.min) : 0;
  if (s && (top > 1000 || (s.max == null && s.min > 1000))) add(3, s.label && /\d/.test(s.label) ? s.label : "Más de 1.000 alumnos");
  else if (top > 600) add(2, s.label || `${top} alumnos`);
  else if (top > 300) add(1, s.label || `${top} alumnos`);
  if (it.kind === "private") add(2, "Privado");
  const k = it.count || 0;
  if (k >= 3) add(2, `${k} inscriptos`); else if (k === 2) add(1, "2 inscriptos");
  const d = (it.contacts || []).find(c => c.decisor);
  if (d) add(3, `Se inscribió quien decide${d.role ? ` (${d.role})` : ""}`);
  const p = norm(it.sheetPrio);
  if (/^(alta|high|1|a|muy alta)$/.test(p)) add(2, "Prioridad alta en la planilla"); else if (/^(media|medium|2|b)$/.test(p)) add(1, "Prioridad media en la planilla");
  return { score, level: score >= 6 ? "alta" : score >= 3 ? "media" : "baja", why };
}

// Dominios de mail que aparecen en dos instituciones o más de la misma base (el mail del ministerio, un proveedor que no
// está en la lista): no dicen de qué colegio es la persona, así que no sirven para buscarla en Pipedrive por dominio.
export function sharedDomains(items) {
  const by = new Map();
  for (const it of items) for (const c of it.contacts || []) { const d = String(c.email || "").split("@")[1]; if (d) { if (!by.has(d)) by.set(d, new Set()); by.get(d).add(it.key || it.name); } }
  return new Set([...by].filter(([, s]) => s.size >= 2).map(([d]) => d));
}

// ---------- el prospecto que crea la app para un colegio de la base: el evento al final, como en la cuenta
// «Colegio Marista San José (EduExperience Mendoza 2026)»
export function leadTitle(name, event) {
  const n = squash(name), e = squash(event).replace(/[()]/g, "");
  if (!e || norm(n).includes(norm(e))) return n.slice(0, 255);
  const tail = ` (${e})`;
  return n.slice(0, Math.max(10, 255 - tail.length)).trim() + tail;
}

// ---------- qué hacer con cada una según lo que hay en Pipedrive (x: lo que encontró el cruce; me: el usuario de quien mira)
// state: none · maybe · lead · org · open · lost · stalled · client · churn · archived · err
const WHAT = { none: "Nada en Pipe", maybe: "Parecido en Pipe", lead: "Prospecto", org: "En Pipe sin trato", open: "Trato abierto", lost: "Perdido", stalled: "Contactado sin avance", client: "Cliente", churn: "Ex cliente", archived: "Archivado en la app", err: "No pude revisar" };
export function standing(x, me, { free = new Set() } = {}) {
  if (!x) return { key: "pending", what: "Sin revisar", label: "Sin revisar en Pipedrive", who: "", workable: false, tone: "unk" };
  const what = WHAT[x.state] || x.state;
  if (x.state === "err") return { key: "err", what, label: "No pude revisar en Pipedrive", who: "", workable: false, tone: "unk" };
  if (x.state === "client") return { key: "client", what, label: "Cliente: no contactar", who: "", workable: false, tone: "client" };
  if (x.state === "churn") return { key: "churn", what, label: "Ex cliente: no contactar", who: "", workable: false, tone: "churn" };
  if (x.state === "archived") return { key: "archived", what, label: "Archivado en la app", who: "", workable: false, tone: "archived" };
  const o = Number(x.ownerId) || null, who = !o || free.has(o) ? "free" : me && o === Number(me) ? "mine" : "other";
  if (who === "other") return { key: "other", what, label: `Es de ${x.owner || "otra persona"}: coordinar con quien lo tiene`, who, workable: false, tone: "other" };
  if (who === "mine") return { key: "mine", what, label: x.state === "none" ? "Nada en Pipe" : `Es tuyo · ${what.toLowerCase()}`, who, workable: true, tone: "mine" };
  return { key: x.state === "none" ? "none" : x.state === "maybe" ? "maybe" : "free", what, label: x.state === "none" ? "Nada en Pipe: libre" : x.state === "maybe" ? "Parecido en Pipe: lo confirmás al abrirlo" : `${what} · libre`, who, workable: true, tone: x.state === "maybe" ? "maybe" : "free" };
}
