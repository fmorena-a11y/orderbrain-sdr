// Leer una planilla de Google Sheets por su link (Cargar base). Tres caminos, en orden:
//  1) con el Google de quien mira (si el servidor tiene GOOGLE_CLIENT_ID/SECRET y la persona conectó Google con el permiso
//     de ver sus hojas de cálculo, SHEETS_SCOPE): API de Sheets v4, pestañas, valores y links de las celdas. La planilla puede
//     ser privada (no se guarda el link).
//  2) compartida «cualquier persona con el enlace»: la vista htmlview para las pestañas y el título, y el CSV de cada pestaña.
//  3) si no se puede: error sheet_private (la app ofrece compartirla o descargarla y subirla).
// Solo se sale a docs.google.com y, en las redirecciones del CSV, a *.googleusercontent.com (sheetLink, okRedirect): nada de
// otros hosts. Tope de tamaño y de tiempo en cada pedido. Nada de lo leído va a los logs.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { sheetLink, exportCsvUrl, htmlViewUrl, okRedirect, isLoginRedirect, tabsFromHtml, titleFromHtml, parseCsv, LIMITS } from "./import.js";
import { accessToken, gmailEnabled, SHEETS_SCOPE } from "./gmail.js";

export { SHEETS_SCOPE };
const MAX_BYTES = 8e6, TIMEOUT = 12e3, MAX_TABS = 8;
const bad = (msg, status = 400, code = "") => Object.assign(new Error(msg), { status, ...(code ? { code } : {}) });
export const PRIVATE_MSG = "No pude abrir la planilla: es privada.";
const privateErr = () => bad(PRIVATE_MSG, 403, "sheet_private");

// GET con redirecciones a mano (cada una se revisa) y tope de bytes
async function get(url, { headers = {}, hops = 4 } = {}) {
  let u = url;
  for (let k = 0; k <= hops; k++) {
    let r;
    try { r = await fetch(u, { headers, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT) }); }
    catch { throw bad("Google no respondió. Probá de nuevo en un rato.", 502, "sheet_down"); }
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get("location"); if (!loc) throw bad("Google respondió raro. Probá de nuevo.", 502, "sheet_down");
      const next = new URL(loc, u).toString();
      if (isLoginRedirect(next)) throw privateErr();
      if (!okRedirect(next)) throw bad("Google mandó a otro sitio: no lo sigo.", 502, "sheet_down");
      u = next; continue;
    }
    if (r.status === 401 || r.status === 403) throw privateErr();
    if (r.status === 404) throw bad("No encontré esa planilla: revisá el link.", 404, "sheet_missing");
    if (!r.ok) throw bad(`Google respondió ${r.status}. Probá de nuevo en un rato.`, 502, "sheet_down");
    if (Number(r.headers.get("content-length")) > MAX_BYTES) throw bad("La planilla es demasiado grande para leerla de una vez: descargá la pestaña que necesitás (CSV) y subila.", 413, "sheet_big");
    const reader = r.body.getReader(), parts = []; let n = 0;
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      n += value.length; if (n > MAX_BYTES) { reader.cancel().catch(() => {}); throw bad("La planilla es demasiado grande para leerla de una vez: descargá la pestaña que necesitás (CSV) y subila.", 413, "sheet_big"); }
      parts.push(value);
    }
    return { text: Buffer.concat(parts).toString("utf8"), type: r.headers.get("content-type") || "" };
  }
  throw bad("Demasiadas redirecciones de Google.", 502, "sheet_down");
}

// 1) API de Sheets v4 con el token de quien mira: valores con formato y el link de cada celda (un link de Pipedrive con otro texto)
async function viaApi(L, token) {
  const f = "properties.title,sheets(properties(sheetId,title,hidden),data(rowData(values(formattedValue,hyperlink))))";
  const { text } = await get(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(L.id)}?includeGridData=true&fields=${encodeURIComponent(f)}`, { headers: { authorization: `Bearer ${token}` } });
  const j = JSON.parse(text);
  const tabs = (j.sheets || []).filter(s => !s.properties?.hidden).slice(0, LIMITS.tabs).map(s => ({
    name: String(s.properties?.title || "Hoja").slice(0, 100), gid: String(s.properties?.sheetId ?? ""),
    rows: (s.data?.[0]?.rowData || []).slice(0, LIMITS.rows + 30).map(r => (r.values || []).slice(0, LIMITS.cols).map(c => {
      const v = String(c?.formattedValue ?? ""), h = String(c?.hyperlink || "");
      return (h && /pipedrive\.com/i.test(h) && !/pipedrive\.com/i.test(v) ? h : v).slice(0, LIMITS.cell);
    })),
  }));
  return { title: String(j.properties?.title || ""), tabs, via: "google", private: true };
}
// 2) compartida con el enlace: htmlview (pestañas y título) + el CSV de cada pestaña
async function viaPublic(L) {
  let tabs = [], title = "";
  try { const h = await get(htmlViewUrl(L.id)); tabs = tabsFromHtml(h.text); title = titleFromHtml(h.text); }
  catch (e) { if (e.code === "sheet_private" || e.code === "sheet_missing") throw e; }
  if (!tabs.length) tabs = [{ name: "Hoja", gid: L.gid ?? "0" }];
  // la del link primero (si el link apunta a una pestaña), las demás después
  if (L.gid != null) tabs.sort((a, b) => (b.gid === L.gid) - (a.gid === L.gid));
  const out = [];
  for (const t of tabs.slice(0, MAX_TABS)) {
    try { const { text, type } = await get(exportCsvUrl(L.id, t.gid)); if (/text\/html/i.test(type)) throw privateErr(); out.push({ ...t, rows: parseCsv(text) }); }
    catch (e) { if (e.code === "sheet_private" && !out.length) throw e; if (!out.length && t === tabs[0]) throw e; }
  }
  return { title, tabs: out, via: "public", private: false };
}

// ---------- demo: la planilla de ejemplo (test/fixtures/base-*.csv) con un link inventado; otro link simula una privada
const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures");
export const DEMO_SHEET = "demo-eduexperience-mendoza-2026";
export const DEMO_PRIVATE = "demo-planilla-privada-0000000000";
export const DEMO_URL = `https://docs.google.com/spreadsheets/d/${DEMO_SHEET}/edit#gid=0`;
export function demoSheet() {
  const read = f => parseCsv(fs.readFileSync(path.join(FIX, f), "utf8"));
  return { title: "Base de Inscriptos EduExperience Mendoza 2026 (OrderEAT) (1)", via: "demo", private: false,
    tabs: [{ name: "Inscriptos", gid: "0", rows: read("base-inscriptos.csv") }, { name: "FACU", gid: "101", rows: read("base-reparto.csv") }, { name: "Mejores Colegios (Estudio)", gid: "202", rows: read("base-estudio.csv") }] };
}

export const googleSheetsReady = () => gmailEnabled() && !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
// { title, tabs: [{ name, gid, rows }], via: google|public|demo, private, sheetId }
export async function readSheet(raw, { email = "", demo = false } = {}) {
  const L = sheetLink(raw);
  if (!L) throw bad("Ese link no es de una planilla de Google. Copialo desde la barra del navegador (docs.google.com/spreadsheets/d/…).", 400, "sheet_link");
  if (demo && L.id === DEMO_SHEET) return { ...demoSheet(), sheetId: L.id };
  if (demo && L.id === DEMO_PRIVATE) throw privateErr();
  let token = null;
  if (!demo && googleSheetsReady()) token = await accessToken(email, SHEETS_SCOPE).catch(() => null);
  if (token) {
    try { return { ...await viaApi(L, token), sheetId: L.id }; }
    catch (e) { if (!["sheet_private", "sheet_missing"].includes(e.code)) throw e; } // sin permiso con su Google: se prueba como compartida
  }
  return { ...await viaPublic(L), sheetId: L.id };
}
