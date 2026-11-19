// Utilidades de texto del servidor (puras, sin dependencias): una sola copia de lo que estaba repetido en varios módulos.
// email o clave en minúsculas y sin espacios alrededor
export const lc = e => String(e || "").trim().toLowerCase();
// sin acentos, en minúsculas, solo letras, números y un espacio entre palabras (null, undefined, 0 y false dan "")
export const norm = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
// lo mismo para celdas y campos que pueden traer números: 0 queda "0" (solo null y undefined dan "")
export const normVal = s => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
// escapa para HTML (también las comillas simples)
export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// error con status HTTP (y code solo si viene)
export const bad = (msg, status = 400, code = "") => Object.assign(new Error(msg), { status, ...(code ? { code } : {}) });
