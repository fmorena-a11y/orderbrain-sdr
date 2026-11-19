// Tu Google, lo puro (sin DOM; pruebas en test/google-login.test.mjs): qué decir de la conexión (mail, calendario,
// planillas), los textos fijos de «Entrar con Google» y cuándo toca el aviso «Conectá tu Google».
export const PERM_ORDER = ["mail", "calendar", "sheets"];
export const PERM_LABEL = { mail: "Mail", calendar: "Calendario", sheets: "Planillas" };
export const PERM_ICON = { mail: "mail", calendar: "calendar", sheets: "table" };
export const PERM_WHAT = {
  mail: "mandar mails desde la ficha, con tu firma",
  calendar: "ver los horarios libres para proponer demos",
  sheets: "leer la planilla de un evento y crear hojas con las tablas del asistente",
};
const listEs = a => a.length <= 1 ? a.join("") : `${a.slice(0, -1).join(", ")} y ${a.at(-1)}`;
// «mail, calendario y planillas»
export const permList = keys => listEs(PERM_ORDER.filter(k => (keys || []).includes(k)).map(k => PERM_LABEL[k].toLowerCase()));

// La vuelta de «Entrar con Google» trae solo un código (?google=error&m=…): el texto lo pone el navegador, así nadie arma un
// link que muestre su propio texto en la pantalla de entrada.
export const LOGIN_ERR = {
  state: "No pude validar el ingreso con Google. Probá de nuevo.",
  denied: "No entraste: cancelaste en la pantalla de Google.",
  unverified: "Tu email de Google no está verificado.",
  identity: "No pude comprobar tu cuenta de Google. Probá de nuevo.",
  config: "Entrar con Google todavía no está configurado.",
  many: "Demasiados intentos. Probá de nuevo en unos minutos.",
  other: "No se pudo entrar con Google. Probá de nuevo.",
};
export const loginError = (code, domain = "") => code === "domain" ? (domain ? `Solo pueden entrar cuentas @${domain}.` : "Esa cuenta de Google no puede entrar.") : LOGIN_ERR[code] || LOGIN_ERR.other;

// Cómo está el Google de quien mira (g = GET /api/gmail): "off" (el servidor no tiene el cliente OAuth, o no se pudo leer:
// no se muestra nada), "none" (sin conectar), "partial" (conectado, faltan permisos) u "ok".
export function googleState(g) {
  if (!g || !g.enabled || g.failed || g.config || !g.google) return "off";
  if (!g.google.connected) return "none";
  return g.google.missing?.length ? "partial" : "ok";
}
// El aviso «Conectá tu Google»: solo a quien no conectó, y como mucho una vez por día (lastDay: el día en que se mostró).
export const noticeDue = (g, lastDay, today) => googleState(g) === "none" && !!today && lastDay !== today;
export const NOTICE_TEXT = "Conectá tu Google: mail, calendario y planillas";
export const partialText = missing => `Entraste con Google, pero falta el permiso de ${permList(missing)}.`;
export const connectedText = g => googleState(g) === "partial" ? `Google conectado como ${g.google.email}, sin permiso de ${permList(g.google.missing)}` : `Google conectado como ${g.google.email}: mail, calendario y planillas`;
