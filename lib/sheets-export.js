// «Crear Google Sheet» del asistente: crea una hoja nueva con una tabla del panel usando la API de Sheets y el Google de
// quien mira (scope drive.file: la app solo ve los archivos que crea ella). SE PRENDE SOLO cuando el servidor tiene el
// cliente OAuth de Google (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET, lo configura el CTO) y la persona tiene su Google
// conectado con ese permiso (lib/gmail.js, DRIVE_FILE_SCOPE): «Entrar con Google» lo deja conectado en el mismo paso.
// Sin eso, `sheetsDirect` da false y el panel usa el camino que anda siempre:
// copiar la tabla con tabulaciones y abrir sheets.new (public/js/chat.js). No escribe en Pipedrive.
import { accessToken, DRIVE_FILE_SCOPE } from "./gmail.js";
import { cellText, sheetName } from "../public/js/chatfmt.js";

const bad = (msg, status = 400, code = "") => Object.assign(new Error(msg), { status, ...(code ? { code } : {}) });
const TYPES = new Set(["text", "date", "time", "number", "url"]);
export const LIMITS = { rows: 5000, cols: 20, cell: 5000 };

export const sheetsDirect = async email => !!(await accessToken(email, DRIVE_FILE_SCOPE).catch(() => null));

// lo que manda el navegador, revisado: título, columnas con tipo conocido y filas de texto o número, con topes
export function cleanTable(t) {
  if (!t || typeof t !== "object" || !Array.isArray(t.columns) || !Array.isArray(t.rows)) throw bad("Falta la tabla.");
  if (!t.columns.length || t.columns.length > LIMITS.cols) throw bad("La tabla tiene demasiadas columnas.");
  if (t.rows.length > LIMITS.rows) throw bad("La tabla es demasiado grande para crear la hoja.", 413);
  const columns = t.columns.map(c => ({ label: String(c?.label ?? "").slice(0, 100), type: TYPES.has(c?.type) ? c.type : "text" }));
  const rows = t.rows.map(r => columns.map((c, j) => { const v = Array.isArray(r) ? r[j] : ""; return typeof v === "number" && isFinite(v) ? v : String(v ?? "").slice(0, LIMITS.cell); }));
  return { title: String(t.title || "Tabla").slice(0, 100), columns, rows };
}

// cuerpo de spreadsheets.create: todo como stringValue (nunca se interpreta como fórmula), números como números y fechas
// como fecha con formato dd/mm/aaaa; encabezado en negrita y fijo
export function sheetBody(t) {
  const serial = v => { const [y, m, d] = v.split("-").map(Number); return (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 864e5; };
  const cell = (v, c) => {
    if (v === "" || v === null || v === undefined) return {};
    if (c.type === "number" && typeof v === "number") return { userEnteredValue: { numberValue: v } };
    if (c.type === "date" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return { userEnteredValue: { numberValue: serial(v) }, userEnteredFormat: { numberFormat: { type: "DATE", pattern: "dd/mm/yyyy" } } };
    return { userEnteredValue: { stringValue: cellText(v, c.type, "csv") } };
  };
  return {
    properties: { title: t.title },
    sheets: [{ properties: { title: sheetName(t.title), gridProperties: { frozenRowCount: 1 } }, data: [{ startRow: 0, startColumn: 0, rowData: [
      { values: t.columns.map(c => ({ userEnteredValue: { stringValue: c.label }, userEnteredFormat: { textFormat: { bold: true } } })) },
      ...t.rows.map(r => ({ values: t.columns.map((c, j) => cell(r[j], c)) })),
    ] }] }],
  };
}

export async function createSheet(email, table) {
  const t = cleanTable(table);
  const token = await accessToken(email, DRIVE_FILE_SCOPE).catch(() => null);
  if (!token) throw bad("Para crear la hoja directo falta conectar tu Google.", 409, "sheets_off");
  let r;
  try {
    r = await fetch("https://sheets.googleapis.com/v4/spreadsheets", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(sheetBody(t)), signal: AbortSignal.timeout(15e3) });
  } catch { throw bad("Google no respondió. Probá de nuevo.", 503, "sheets_down"); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.spreadsheetUrl) throw bad(r.status === 401 || r.status === 403 ? "Google no dejó crear la hoja: volvé a conectar tu Google." : "No pude crear la hoja en Google.", r.status === 401 || r.status === 403 ? 409 : 502, "sheets_fail");
  return { url: j.spreadsheetUrl, id: j.spreadsheetId };
}
