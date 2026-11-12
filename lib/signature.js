// «Tu firma» (perfil): la que va al final de los mails que salen de la ficha. Ni la API de Pipedrive ni su servidor MCP
// agregan la firma que la persona tiene en Pipedrive, así que la app la pone. Dos opciones:
//  · «armada»: con los datos del perfil, como la firma de Pipedrive del equipo (isotipo de OrderEAT, nombre, cargo,
//    «email | teléfono» y www.ordereat.com). La arma este código: cada dato va escapado, nunca HTML de afuera.
//  · «pegada»: la firma de Pipedrive copiada y pegada (texto o HTML), saneada con sanitizeSignature de lib/gmail.js.
// Con Gmail además puede ir la de su Gmail («gmail»). Lo puro está acá; se prueba en test/pdmail.test.mjs.
import { escapeHtml } from "./gmail.js";

// el cargo por defecto, según el rol del perfil (se puede cambiar en «Tu firma»)
export const ROLE_TITLES = { sdr: "Sales Development Representative", ae: "Account Executive", lider: "Team Lead" };
export const WEB = { label: "www.ordereat.com", url: "https://www.ordereat.com" };
export const LOGO_PATH = "/ordereat-isotipo.png";
export const MODES = ["armada", "pegada", "gmail"];

// cargo: el que escribió; si no, el del acceso (dirección «CEO»), el del rol (SDR, AE) o, para un líder, «Team Lead»
export function titleOf({ prefs = null, role = "", accessTitle = "", leader = false } = {}) {
  const own = cleanLine(prefs?.title, 80);
  if (own) return own;
  return cleanLine(accessTitle, 80) || ROLE_TITLES[role] || (leader ? ROLE_TITLES.lider : "");
}
// una línea de texto: sin saltos ni espacios de más, con tope
export const cleanLine = (v, max = 80) => String(v ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
// teléfono: dígitos, espacios, + - ( ) . / (como lo escribe la persona); si no parece un teléfono, error
export function cleanPhone(v) {
  const t = cleanLine(v, 40);
  if (!t) return { phone: "" };
  if (!/^\+?[\d\s().\/-]{6,30}$/.test(t) || (t.match(/\d/g) || []).length < 6) return { error: "Ese teléfono no parece válido. Escribilo con el código de país, por ejemplo +598 99 123 456." };
  return { phone: t };
}
// la URL pública de la app (el origen del pedido) + el isotipo
export const logoUrl = base => `${String(base || "").replace(/\/+$/, "")}${LOGO_PATH}`;

// La firma armada: tabla simple con estilos en línea (lo que mejor se ve en los clientes de correo). Sin nombre no se arma.
export function builtSignature({ name, title = "", email = "", phone = "", base = "" }) {
  const n = cleanLine(name, 80); if (!n) return "";
  const t = cleanLine(title, 80), e = cleanLine(email, 120), p = cleanLine(phone, 40), logo = base ? logoUrl(base) : "";
  const row = (html, style) => `<tr><td style="${style}">${html}</td></tr>`;
  const font = "font-family:Arial,Helvetica,sans-serif;";
  const contact = [e, p].filter(Boolean).map(escapeHtml).join(" | ");
  return `<table cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse">` +
    (logo ? row(`<img src="${escapeHtml(logo)}" alt="OrderEAT" width="44" height="44" style="display:block;width:44px;height:44px;border:0">`, "padding:0 0 8px 0") : "") +
    row(`<b>${escapeHtml(n)}</b>`, `${font}font-size:14px;color:#18181b;line-height:1.4`) +
    (t ? row(escapeHtml(t), `${font}font-size:13px;color:#52525b;line-height:1.4`) : "") +
    (contact ? row(contact, `${font}font-size:13px;color:#52525b;line-height:1.4;padding-top:4px`) : "") +
    row(`<a href="${WEB.url}" style="color:#E0153F;text-decoration:none">${WEB.label}</a>`, `${font}font-size:13px;line-height:1.4;padding-top:2px`) +
    `</table>`;
}

// Qué firma va. prefs.mode: «armada» | «pegada» | «gmail»; sin elegir (lo que ya había): la pegada si hay, si no la de
// Gmail (con Gmail) o la armada (con Pipedrive, que no agrega ninguna). via: "pipedrive" | "gmail".
// Devuelve { mode, html, source } — html null = la de Gmail (la lee lib/gmail.js).
export function pickSignature({ prefs = null, via = "pipedrive", built = "" }) {
  const custom = String(prefs?.signature || "");
  let mode = MODES.includes(prefs?.mode) ? prefs.mode : custom ? "pegada" : via === "gmail" ? "gmail" : "armada";
  if (mode === "pegada" && !custom) mode = via === "gmail" ? "gmail" : "armada";
  if (mode === "gmail" && via !== "gmail") mode = custom ? "pegada" : "armada";
  if (mode === "gmail") return { mode, html: null, source: "gmail" };
  if (mode === "pegada") return { mode, html: custom, source: "pegada" };
  return { mode, html: built || "", source: built ? "armada" : "" };
}
