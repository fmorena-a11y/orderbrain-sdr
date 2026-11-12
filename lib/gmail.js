// Mail desde la ficha con el Gmail de cada persona (Google Workspace @ordereat.com).
// La API de Pipedrive no deja enviar mails y la app usa un solo token de Pipedrive: por eso cada SDR conecta su Gmail
// una vez (OAuth 2.0 con código) y el mail sale de su casilla, con su firma. Va en copia oculta a la dirección Smart BCC de
// Pipedrive (PIPEDRIVE_SMART_BCC o, por defecto, la de la cuenta de OrderEAT) y queda en la pestaña de correo de la persona o el trato.
// Scopes: gmail.send (enviar) y gmail.settings.basic (leer la firma y el email principal con users.settings.sendAs).
// El refresh token se guarda cifrado (AES-256-GCM con una clave derivada de SESSION_SECRET) y nunca vuelve al navegador.
// DEMO_MODE: Gmail simulado (conectar sin Google, firma de ejemplo, enviar = guardar el MIME en memoria).
// Lo puro (MIME, codificación, firma, cifrado, state, validación) está arriba y se prueba en test/gmail.test.mjs.
import crypto from "crypto";
import { getGmail, setGmail, delGmail, getMailPrefs } from "./store.js";

const env = process.env;
export const SCOPES = ["https://www.googleapis.com/auth/gmail.send", "https://www.googleapis.com/auth/gmail.settings.basic"];
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const API = "https://gmail.googleapis.com/gmail/v1/users/me";

export const isDemo = () => env.DEMO_MODE === "1" && !env.PIPEDRIVE_API_TOKEN;
const secret = () => env.SESSION_SECRET || "";
// sin GOOGLE_CLIENT_SECRET (o sin SESSION_SECRET, que cifra los tokens) no se ofrece: la ficha sigue con «Abrir en Gmail»
export const gmailEnabled = () => isDemo() || !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && secret());
// Smart BCC: cada mail enviado va en copia oculta a la dirección de la cuenta en Pipedrive y queda en su pestaña de correo.
// Sin PIPEDRIVE_SMART_BCC (o vacía), la de la cuenta de OrderEAT (leída de Pipedrive); «off» la apaga.
export const SMART_BCC_DEFAULT = "ordereat@pipedrivemail.com";
export const smartBcc = () => {
  const v = String(env.PIPEDRIVE_SMART_BCC ?? "").trim();
  if (/^(off|no|0|false|ninguna)$/i.test(v)) return "";
  return EMAIL_RE.test(v) ? v : SMART_BCC_DEFAULT;
};
const bad = (msg, status = 400, code = "") => Object.assign(new Error(msg), { status, code });

// ---------- validación
export const EMAIL_RE = /^[^@\s<>()[\]\\,;:"]+@[^@\s<>()[\]\\,;:"]+\.[a-z]{2,}$/i;
// lo que queda de una plantilla sin completar
export const PLACEHOLDER_RE = /\[(d[ií]a|hora|tu nombre)\]/i;
export function validateMail({ to, subject, text } = {}) {
  const t = String(to || "").trim(), sub = String(subject || "").replace(/[\r\n]+/g, " ").trim(), body = String(text || "").replace(/\r\n?/g, "\n");
  if (!t) return { error: "Poné a quién le mandás el mail." };
  if (!EMAIL_RE.test(t)) return { error: "Ese email no parece válido. Revisalo." };
  if (!sub) return { error: "Poné el asunto." };
  if (sub.length > 200) return { error: "El asunto es muy largo (máximo 200 caracteres)." };
  if (!body.trim()) return { error: "El mensaje está vacío." };
  if (body.length > 20000) return { error: "El mensaje es muy largo." };
  if (PLACEHOLDER_RE.test(sub) || PLACEHOLDER_RE.test(body)) return { error: "Completá lo que está entre corchetes ([día], [hora], [tu nombre]) antes de mandar." };
  return { to: t.toLowerCase(), subject: sub, text: body.replace(/\s+$/, "") };
}

// ---------- texto y HTML
export const escapeHtml = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// el texto del SDR en HTML: escapado, con los saltos de línea y los links (http/https) clickeables
export function textToHtml(text) {
  return escapeHtml(text).replace(/\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)]/g, u => `<a href="${u}">${u}</a>`).replace(/\r?\n/g, "<br>\n");
}
const ENT = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'" };
export const decodeEntities = s => String(s || "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e) => {
  if (e[0] === "#") { const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ""; }
  return ENT[e.toLowerCase()] ?? m;
});
// HTML → texto (la parte de texto plano del mail y la vista previa corta)
export function htmlToText(html) {
  return decodeEntities(String(html || "")
    .replace(/<a\b[^>]*href\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (m, href, label) => { const l = label.replace(/<[^>]+>/g, "").trim(), h = decodeEntities(href); return !l ? h : h && h !== l && !/^mailto:/i.test(h) && !h.includes(l) ? `${l} (${h})` : l; })
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/?(p|div|tr|li|ul|ol|h\d|table|blockquote)\b[^>]*>/gi, "\u0001").replace(/<\/t[dh]>/gi, " ").replace(/<[^>]+>/g, ""))
    // los bordes de bloque seguidos (<div><div>…) son un solo salto de línea
    .replace(/[ \t]*\u0001[\s\u0001]*/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ---------- firma: la de Gmail (sendAs) o la que la persona pega en su perfil (texto o HTML). Siempre saneada:
// solo etiquetas básicas, links http/https/mailto, imágenes https y estilos simples. Lo demás se descarta (con su contenido
// si es <script>, <style>, etc.). La salida la arma este código, nunca pasa HTML de afuera tal cual.
const TAGS = new Set("a b strong i em u s br p div span img table tbody thead tfoot tr td th ul ol li small hr font blockquote sub sup center".split(" "));
const VOID = new Set(["br", "hr", "img"]);
const DROP = new Set("script style head title iframe object embed noscript template svg math textarea select option button form input xml frameset frame applet base link meta".split(" "));
const CSS_PROPS = new Set(("color background-color font-size font-family font-weight font-style font-variant text-decoration text-transform line-height letter-spacing text-align vertical-align white-space " +
  "margin margin-top margin-right margin-bottom margin-left padding padding-top padding-right padding-bottom padding-left border border-top border-right border-bottom border-left border-color border-style border-width " +
  "border-collapse border-spacing border-radius width height max-width max-height min-width display").split(" "));
const COLOR = /^(#[0-9a-f]{3,8}|[a-z]{3,20}|rgba?\(\s*[\d.\s,%]+\))$/i;
const DIGITS = /^\d{1,4}%?$/;
function cleanStyle(v) {
  const out = [];
  for (const decl of String(v).split(";")) {
    const i = decl.indexOf(":"); if (i < 1) continue;
    const prop = decl.slice(0, i).trim().toLowerCase(), val = decl.slice(i + 1).trim();
    if (!CSS_PROPS.has(prop) || !val || val.length > 120) continue;
    if (/url\s*\(|expression|javascript|behavior|binding|@|\\|<|>|\/\*/i.test(val) || !/^[#\w\s.,%'"()+-]*$/.test(val)) continue;
    if (prop === "display" && !/^(block|inline|inline-block|table|table-cell|table-row|none)$/i.test(val)) continue;
    out.push(`${prop}:${val}`);
  }
  return out.join(";");
}
function cleanUrl(v, { img = false } = {}) {
  const u = decodeEntities(v).replace(/[\u0000-\u0020\u007f]+/g, "");
  if (img) return /^https:\/\/[^\s"'<>]+$/i.test(u) ? u : "";
  return /^(https?:\/\/|mailto:)[^\s"'<>]+$/i.test(u) ? u : "";
}
function attrsOf(tag, raw) {
  const out = [], re = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(raw))) {
    const name = m[1].toLowerCase(), val = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
    let v = null;
    if (name === "style") v = cleanStyle(val) || null;
    else if (name === "align" && /^(left|right|center|justify)$/i.test(val)) v = val.toLowerCase();
    else if (tag === "a" && name === "href") v = cleanUrl(val) || null;
    else if ((tag === "a" || tag === "img") && (name === "title" || name === "alt")) v = val.slice(0, 200);
    else if (tag === "img" && name === "src") v = cleanUrl(val, { img: true }) || null;
    else if (["img", "td", "th", "table"].includes(tag) && ["width", "height"].includes(name) && DIGITS.test(val)) v = val;
    else if (["td", "th"].includes(tag) && ["colspan", "rowspan"].includes(name) && /^\d{1,2}$/.test(val)) v = val;
    else if (["td", "th"].includes(tag) && name === "valign" && /^(top|middle|bottom|baseline)$/i.test(val)) v = val.toLowerCase();
    else if (tag === "table" && ["cellpadding", "cellspacing", "border"].includes(name) && /^\d{1,2}$/.test(val)) v = val;
    else if (["td", "th", "table", "tr"].includes(tag) && name === "bgcolor" && COLOR.test(val)) v = val;
    else if (tag === "font" && name === "color" && COLOR.test(val)) v = val;
    else if (tag === "font" && name === "size" && /^[+-]?[1-7]$/.test(val)) v = val;
    else if (tag === "font" && name === "face" && /^[\w\s,'"-]{1,80}$/.test(val)) v = val;
    if (v !== null && !out.some(([n]) => n === name)) out.push([name, v]);
  }
  if (tag === "img" && !out.some(([n]) => n === "src")) return null; // imagen sin https: afuera
  if (tag === "a" && out.some(([n]) => n === "href")) out.push(["target", "_blank"], ["rel", "noopener noreferrer"]);
  return out.map(([n, v]) => ` ${n}="${escapeHtml(v)}"`).join("");
}
// el texto entre etiquetas: se conservan las entidades válidas y se escapa todo lo demás
const cleanText = t => t.replace(/&(?!(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,31});)/gi, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export function sanitizeSignature(input, { max = 20000 } = {}) {
  const src = String(input || "").slice(0, max).trim();
  if (!src) return "";
  if (!/<[a-z!\/]/i.test(src)) return escapeHtml(src).replace(/\r?\n/g, "<br>"); // texto pegado: los saltos de línea quedan
  const re = /<!--[\s\S]*?(?:-->|$)|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|<[!?][^>]*>?/g;
  let out = "", last = 0, m; const stack = [];
  while ((m = re.exec(src))) {
    out += cleanText(src.slice(last, m.index)); last = re.lastIndex;
    if (!m[2]) continue; // comentario o declaración
    const close = m[1] === "/", tag = m[2].toLowerCase();
    if (DROP.has(tag)) {
      if (!close && !/\/\s*$/.test(m[3])) { // se descarta con su contenido
        const end = new RegExp(`</${tag}\\s*>`, "ig"); end.lastIndex = re.lastIndex;
        const e = end.exec(src); last = re.lastIndex = e ? end.lastIndex : src.length;
      }
      continue;
    }
    if (!TAGS.has(tag)) continue; // etiqueta desconocida: se saca la etiqueta, queda el texto
    if (close) {
      const at = stack.lastIndexOf(tag); if (at < 0) continue;
      while (stack.length > at) out += `</${stack.pop()}>`;
      continue;
    }
    const attrs = attrsOf(tag, m[3]); if (attrs === null) continue;
    out += `<${tag}${attrs}>`;
    if (!VOID.has(tag)) stack.push(tag);
  }
  out += cleanText(src.slice(last));
  while (stack.length) out += `</${stack.pop()}>`;
  return out.trim();
}

// ---------- MIME (RFC 5322 + 2045/2046/2047), UTF-8, multipart/alternative texto + HTML
const CRLF = "\r\n";
const isPlain = s => /^[\x20-\x7e]*$/.test(s) && !s.includes("=?");
// palabras codificadas de hasta 75 caracteres (45 bytes de UTF-8 cada una), sin cortar un carácter al medio
export function encodeHeader(str) {
  const s = String(str || "").replace(/[\r\n]+/g, " ");
  if (isPlain(s)) return s;
  const words = []; let cur = "";
  for (const ch of s) {
    if (Buffer.byteLength(cur + ch) > 45) { words.push(cur); cur = ""; }
    cur += ch;
  }
  if (cur) words.push(cur);
  return words.map(w => `=?UTF-8?B?${Buffer.from(w, "utf8").toString("base64")}?=`).join(CRLF + " ");
}
// inversa (para la bandeja del demo y las pruebas): junta las palabras codificadas
export function decodeHeader(v) {
  return String(v || "").replace(/\?=\s+=\?/g, "?==?").replace(/=\?UTF-8\?([BQ])\?([^?]*)\?=/gi, (m, enc, data) =>
    enc.toUpperCase() === "B" ? Buffer.from(data, "base64").toString("utf8") : decodeURIComponent(data.replace(/_/g, " ").replace(/=([0-9a-f]{2})/gi, "%$1")));
}
export function addressHeader(name, email) {
  const n = String(name || "").replace(/[\r\n"\\<>]+/g, " ").trim();
  if (!n) return `<${email}>`;
  return `${isPlain(n) ? `"${n}"` : encodeHeader(n)} <${email}>`;
}
const b64lines = s => Buffer.from(s, "utf8").toString("base64").replace(/.{76}(?=.)/g, "$&" + CRLF);
// RFC 5322: «Tue, 10 Nov 2026 14:05:00 +0000»
export const mailDate = (d = new Date()) => d.toUTCString().replace(/GMT$/, "+0000");
export function buildMime({ from, fromName = "", to, bcc = "", subject, text, html, date = new Date(), boundary = "" }) {
  const b = boundary || "ob_" + crypto.randomBytes(12).toString("hex");
  const head = [
    `From: ${addressHeader(fromName, from)}`,
    `To: ${to}`,
    ...(bcc ? [`Bcc: ${bcc}`] : []),
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${mailDate(date)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${b}"`,
  ];
  const part = (type, body) => [`--${b}`, `Content-Type: ${type}; charset="UTF-8"`, "Content-Transfer-Encoding: base64", "", b64lines(body)].join(CRLF);
  return [...head, "", part("text/plain", text), part("text/html", html), `--${b}--`, ""].join(CRLF);
}
// el cuerpo con la firma al final: en texto plano y en HTML (el texto escapado, con sus saltos de línea)
export function mailBody(text, signatureHtml = "") {
  const sigText = signatureHtml ? htmlToText(signatureHtml) : "";
  const plain = `${text}${sigText ? `\n\n${sigText}` : ""}\n`;
  const html = `<!doctype html><html><body><div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222">${textToHtml(text)}</div>` +
    (signatureHtml ? `<br><div class="gmail_signature" style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#444">${signatureHtml}</div>` : "") + "</body></html>";
  return { text: plain, html };
}
export const b64url = s => Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
// lee un MIME armado por buildMime (demo y pruebas): encabezados y las dos partes ya decodificadas
export function parseMime(mime) {
  const [head, ...rest] = String(mime).split(CRLF + CRLF), body = rest.join(CRLF + CRLF);
  const headers = {};
  for (const line of head.replace(/\r\n[ \t]+/g, " ").split(CRLF)) { const i = line.indexOf(":"); if (i > 0) headers[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim(); }
  const bnd = (headers["content-type"] || "").match(/boundary="([^"]+)"/)?.[1];
  const parts = {};
  if (bnd) for (const p of body.split("--" + bnd).slice(1, -1)) {
    const [ph, ...pb] = p.replace(/^\r\n/, "").split(CRLF + CRLF), type = (ph.match(/Content-Type:\s*([^;\r\n]+)/i) || [])[1];
    if (type) parts[type.trim().toLowerCase()] = Buffer.from(pb.join("").replace(/\s+/g, ""), "base64").toString("utf8");
  }
  return { headers, subject: decodeHeader(headers.subject), text: parts["text/plain"] || "", html: parts["text/html"] || "" };
}

// ---------- cifrado del refresh token: AES-256-GCM, clave derivada de SESSION_SECRET con HKDF
const keyOf = sec => Buffer.from(crypto.hkdfSync("sha256", Buffer.from(String(sec)), Buffer.from("orderbrain-sdr"), Buffer.from("gmail-refresh-token"), 32));
export function encrypt(plain, sec = secret()) {
  if (!sec) throw bad("Falta SESSION_SECRET en el servidor: no se puede guardar la conexión con Gmail.", 500);
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", keyOf(sec), iv);
  const ct = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return "v1." + Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64url");
}
// null si no se puede descifrar (otra clave, alterado): no se dice por qué ni se muestra nada del contenido
export function decrypt(blob, sec = secret()) {
  try {
    const m = /^v1\.([A-Za-z0-9_-]+)$/.exec(String(blob || "")); if (!m || !sec) return null;
    const raw = Buffer.from(m[1], "base64url"); if (raw.length < 29) return null;
    const d = crypto.createDecipheriv("aes-256-gcm", keyOf(sec), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
  } catch { return null; }
}

// ---------- state del OAuth: firmado (HMAC) y atado a la sesión (email + nonce guardado en la cookie), vence en 10 minutos
const hmac = (sec, data) => crypto.createHmac("sha256", String(sec)).update("gmail-state:" + data).digest("base64url");
export function signState({ email, nonce, at = Date.now() }, sec = secret() || "dev-only-secret") {
  const p = Buffer.from(JSON.stringify({ e: String(email).toLowerCase(), n: nonce, t: at })).toString("base64url");
  return `${p}.${hmac(sec, p)}`;
}
export function verifyState(state, { email, nonce, now = Date.now(), maxAgeMs = 10 * 60e3 }, sec = secret() || "dev-only-secret") {
  const [p, sig, extra] = String(state || "").split(".");
  if (!p || !sig || extra !== undefined) return { ok: false, why: "state inválido" };
  const want = hmac(sec, p);
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return { ok: false, why: "state inválido" };
  let o; try { o = JSON.parse(Buffer.from(p, "base64url").toString("utf8")); } catch { return { ok: false, why: "state inválido" }; }
  if (!nonce || o.n !== nonce) return { ok: false, why: "otra sesión" };
  if (o.e !== String(email || "").toLowerCase()) return { ok: false, why: "otra persona" };
  if (!(now - o.t >= -60e3 && now - o.t <= maxAgeMs)) return { ok: false, why: "vencido" };
  return { ok: true };
}
export const newNonce = () => crypto.randomBytes(16).toString("base64url");

// el email principal de la cuenta (y su firma) en la lista de users.settings.sendAs
export const primarySendAs = list => (list || []).find(x => x.isPrimary) || (list || [])[0] || null;
// el email de Google tiene que ser el mismo de la sesión (no se conecta el Gmail de otra persona)
export const sameAccount = (a, b) => !!a && String(a).trim().toLowerCase() === String(b || "").trim().toLowerCase();

// ---------- Google (red). Errores sin el contenido de las respuestas (podrían traer tokens).
async function postForm(url, params) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params), signal: AbortSignal.timeout(15e3) });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, j };
}
export function authUrl({ email, state, redirectUri }) {
  const q = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, redirect_uri: redirectUri, response_type: "code", scope: SCOPES.join(" "),
    access_type: "offline", prompt: "consent", include_granted_scopes: "false", login_hint: email, state });
  if (env.ALLOWED_EMAIL_DOMAIN || env.TEAM_ACCESS_CODE) q.set("hd", (env.ALLOWED_EMAIL_DOMAIN || "ordereat.com").toLowerCase());
  return `${AUTH_URL}?${q}`;
}
async function exchangeCode(code, redirectUri) {
  const r = await postForm(TOKEN_URL, { code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: redirectUri, grant_type: "authorization_code" });
  if (!r.ok || !r.j.access_token) throw bad(`Google no aceptó la conexión (${r.j.error || r.status}).`, 502);
  return { access: r.j.access_token, refresh: r.j.refresh_token || "", expiresIn: Number(r.j.expires_in) || 3600, scope: String(r.j.scope || "") };
}
// Solo invalid_grant quiere decir que la persona quitó el permiso (o venció): ahí se borra lo guardado. Un 401 con
// invalid_client, unauthorized_client o deleted_client es el cliente OAuth del servidor (GOOGLE_CLIENT_SECRET mal copiado,
// rotado o borrado): no se borra nada, así un secreto mal configurado no desconecta a todo el equipo.
export const CONFIG_ERRORS = new Set(["invalid_client", "unauthorized_client", "deleted_client", "invalid_request"]);
async function refreshAccess(refresh) {
  const r = await postForm(TOKEN_URL, { refresh_token: refresh, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, grant_type: "refresh_token" });
  if (r.j.error === "invalid_grant") throw bad("Tu conexión con Gmail venció o la quitaste en Google. Conectalo de nuevo.", 409, "gmail_revoked");
  if (CONFIG_ERRORS.has(r.j.error) || r.status === 401) {
    console.error("Gmail: el endpoint de token rechazó el cliente OAuth:", String(r.j.error || r.status).slice(0, 40));
    throw bad("Gmail está mal configurado en el servidor (avisale al administrador).", 500, "gmail_config");
  }
  if (!r.ok || !r.j.access_token) throw bad(`Google no respondió (${r.j.error || r.status}). Probá de nuevo en un rato.`, 502);
  return { access: r.j.access_token, expiresIn: Number(r.j.expires_in) || 3600 };
}
// httpStatus queda en el error: con 4xx Gmail no aceptó el pedido (para el envío: seguro que no salió)
async function gapi(access, path, { method = "GET", body } = {}) {
  const r = await fetch(API + path, { method, headers: { authorization: `Bearer ${access}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20e3) });
  const j = await r.json().catch(() => ({}));
  const fail = (msg, status, code = "") => Object.assign(bad(msg, status, code), { httpStatus: r.status });
  if (r.status === 401) throw fail("Tu conexión con Gmail venció. Conectalo de nuevo.", 409, "gmail_revoked");
  if (r.status === 403) throw fail(`Gmail no dio permiso (${j.error?.status || 403}). Conectalo de nuevo y aceptá enviar mails.`, 409, "gmail_scope");
  if (!r.ok) throw fail(`Gmail respondió ${r.status}${j.error?.message ? `: ${String(j.error.message).slice(0, 160)}` : ""}.`, 502);
  return j;
}
const revoke = token => fetch(`${REVOKE_URL}?token=${encodeURIComponent(token)}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, signal: AbortSignal.timeout(10e3) }).catch(() => null);

// ---------- demo: nada sale a Google
const DEMO_SIG = name => `<b>${escapeHtml(name || "Tu nombre")}</b><br>SDR · OrderEAT<br><a href="https://ordereat.com">ordereat.com</a> · <span style="color:#666">Gmail simulado (demo)</span>`;
const outbox = [];
export const demoOutbox = () => outbox;

// access tokens en memoria (por instancia), nunca en disco ni en Redis
const access = new Map();
async function accessFor(email, rec) {
  const a = access.get(email); if (a && a.exp > Date.now() + 60e3) return a.token;
  if (rec.demo) return "demo-access";
  const refresh = decrypt(rec.enc); if (!refresh) throw bad("No pude leer tu conexión con Gmail. Conectalo de nuevo.", 409, "gmail_revoked");
  try {
    const t = await refreshAccess(refresh);
    access.set(email, { token: t.access, exp: Date.now() + t.expiresIn * 1000 });
    return t.access;
  } catch (e) { if (e.code === "gmail_revoked") { access.delete(email); await delGmail(email).catch(() => {}); } throw e; }
}
// firma y email principal de Gmail (10 minutos en memoria)
const sigCache = new Map();
async function gmailIdentity(email, rec, name = "") {
  if (rec.demo) return { email: rec.email, name, signature: DEMO_SIG(name) };
  const c = sigCache.get(email); if (c && c.exp > Date.now()) return c.v;
  // un 401 con el access token en memoria: se descarta y la próxima vez se pide otro (si el permiso se quitó, ahí da invalid_grant)
  const p = primarySendAs((await gapi(await accessFor(email, rec), "/settings/sendAs").catch(e => { if (e.httpStatus === 401) access.delete(email); throw e; })).sendAs);
  const v = { email: (p?.sendAsEmail || rec.email).toLowerCase(), name: p?.displayName || "", signature: sanitizeSignature(p?.signature || "") };
  sigCache.set(email, { v, exp: Date.now() + 600e3 });
  return v;
}

// ---------- lo que usa el servidor
// Comienzo del OAuth: la URL de Google (o, en el demo, se conecta solo con el email de la sesión).
export async function startConnect({ email, nonce, redirectUri, demoAs = "" }) {
  if (!gmailEnabled()) throw bad("Para enviar desde acá falta configurar Gmail (lo hace el administrador).", 404);
  if (isDemo()) return { demo: true, gmailEmail: demoAs || email };
  return { url: authUrl({ email, state: signState({ email, nonce }), redirectUri }) };
}
// Vuelta de Google: valida el state, cambia el código por tokens, comprueba la cuenta y guarda el refresh token cifrado.
export async function finishConnect({ email, nonce, state, code, redirectUri, demoAs = "" }) {
  if (isDemo()) {
    const ge = String(demoAs || email).toLowerCase();
    if (!sameAccount(ge, email)) throw bad(`Conectaste el Gmail de ${ge}, pero entraste a la app como ${email}. Usá tu propia cuenta.`, 403, "gmail_mismatch");
    await setGmail(email, { enc: encrypt("demo-refresh-token", secret() || "demo"), email: ge, demo: true, scope: SCOPES.join(" "), at: new Date().toISOString() });
    return { email: ge };
  }
  const v = verifyState(state, { email, nonce });
  if (!v.ok) throw bad(v.why === "vencido" ? "La conexión tardó demasiado. Probá de nuevo." : "No pude validar la conexión con Google. Probá de nuevo desde la app.", 400, "gmail_state");
  const t = await exchangeCode(code, redirectUri);
  const granted = t.scope.split(/\s+/);
  if (!granted.includes(SCOPES[0])) { await revoke(t.refresh || t.access); throw bad("Para enviar desde acá tenés que aceptar «Enviar correo electrónico en tu nombre». Probá de nuevo.", 400, "gmail_scope"); }
  if (!t.refresh) throw bad("Google no devolvió el permiso para seguir conectado. Probá de nuevo.", 502);
  // el email principal de la cuenta de Google (sendAs) tiene que ser el de la sesión
  let ge = "";
  try { ge = primarySendAs((await gapi(t.access, "/settings/sendAs")).sendAs)?.sendAsEmail || ""; } catch { ge = ""; }
  if (!sameAccount(ge, email)) { await revoke(t.refresh); throw bad(ge ? `Conectaste el Gmail de ${ge}, pero entraste a la app como ${email}. Usá tu propia cuenta.` : "No pude comprobar qué cuenta de Gmail conectaste. Probá de nuevo.", 403, "gmail_mismatch"); }
  await setGmail(email, { enc: encrypt(t.refresh), email: ge.toLowerCase(), scope: t.scope, at: new Date().toISOString() });
  access.set(email, { token: t.access, exp: Date.now() + t.expiresIn * 1000 }); sigCache.delete(email);
  return { email: ge.toLowerCase() };
}
// Desconectar: revoca en Google (si se puede) y borra lo guardado.
export async function disconnect(email) {
  const rec = await getGmail(email).catch(() => null);
  if (rec && !rec.demo) { const t = decrypt(rec.enc); if (t) await revoke(t); }
  access.delete(email); sigCache.delete(email);
  await delGmail(email);
  return { ok: true };
}
// La firma que se agrega: la del perfil manda sobre la de Gmail.
export async function signatureFor(email, rec, name = "") {
  const prefs = await getMailPrefs(email).catch(() => null);
  if (prefs?.signature) return { html: prefs.signature, source: "perfil" };
  if (!rec) return { html: "", source: "" };
  try { const id = await gmailIdentity(email, rec, name); return { html: id.signature, source: id.signature ? "gmail" : "" }; }
  catch (e) { return { html: "", source: "", error: e.message, code: e.code || "" }; }
}
// Estado para el navegador: sin tokens.
export async function status(email, name = "") {
  const enabled = gmailEnabled(), rec = enabled ? await getGmail(email).catch(() => null) : null;
  const sig = enabled ? await signatureFor(email, rec, name) : { html: "", source: "" };
  const prefs = await getMailPrefs(email).catch(() => null);
  // revocado: hay que conectar de nuevo. Mal configurado en el servidor: sigue conectado (no se borra), pero no se ofrece enviar.
  return { enabled, demo: isDemo(), connected: !!rec && sig.code !== "gmail_revoked", email: rec?.email || "", signature: sig.html, signatureSource: sig.source, custom: prefs?.signature || "", smartBcc: !!smartBcc(),
    ...(sig.code === "gmail_revoked" ? { expired: true } : sig.code === "gmail_config" ? { config: true, problem: sig.error } : sig.error ? { problem: sig.error } : {}) };
}
// Envía el mail desde el Gmail de la persona. Devuelve el id del mensaje de Gmail.
// Lo que pasa si falla el POST a messages/send. Con 4xx (400, 401, 403, 429…) Gmail no lo aceptó: no salió y se puede
// reintentar. Sin respuesta (red, se cortó a los 20 s) o con 5xx, Gmail pudo haberlo mandado igual: sent = "maybe" y el
// servidor no libera la clave del envío, así un segundo clic no lo manda de nuevo.
export const UNKNOWN_MSG = "No sé si salió: mirá Enviados en tu Gmail antes de mandarlo de nuevo.";
export function sendOutcome(e) {
  if (e?.httpStatus && e.httpStatus < 500) return e;
  return Object.assign(bad(UNKNOWN_MSG, 502, "gmail_unknown"), { sent: "maybe" });
}
export async function send(email, { to, subject, text, fromName = "" }) {
  if (!gmailEnabled()) throw bad("Para enviar desde acá falta configurar Gmail (lo hace el administrador).", 404);
  const rec = await getGmail(email);
  if (!rec) throw bad("Conectá tu Gmail para enviar desde acá.", 409, "gmail_missing");
  const id = await gmailIdentity(email, rec, fromName);
  // defensa extra: la casilla que manda tiene que ser la de la sesión (ya se comprobó al conectar)
  if (!sameAccount(id.email, email) || (rec.email && !sameAccount(rec.email, email))) throw bad("La cuenta de Gmail conectada no es la tuya. Conectá tu Gmail de nuevo.", 409, "gmail_mismatch");
  const sig = await signatureFor(email, rec, fromName);
  const bcc = smartBcc();
  const body = mailBody(text, sig.html);
  const mime = buildMime({ from: id.email, fromName: fromName || id.name, to, bcc, subject, text: body.text, html: body.html });
  if (rec.demo) {
    // demo: x@timeout.test simula que Gmail no respondió (no se sabe si salió); x@rechazo.test, que lo rechazó (no salió)
    if (/@timeout\.test$/i.test(to)) throw sendOutcome(Object.assign(new Error("simulado"), { name: "TimeoutError" }));
    if (/@rechazo\.test$/i.test(to)) throw sendOutcome(Object.assign(bad("Gmail respondió 400: destinatario rechazado (simulado).", 502), { httpStatus: 400 }));
    const msg = { id: `demo-${crypto.randomBytes(6).toString("hex")}`, threadId: `demo-t-${outbox.length + 1}`, at: new Date().toISOString(), from: id.email, to, bcc, mime };
    outbox.unshift(msg); outbox.length = Math.min(outbox.length, 50);
    return { id: msg.id, threadId: msg.threadId, from: id.email, bcc: !!bcc, signature: sig.source };
  }
  const token = await accessFor(email, rec);
  let r;
  try { r = await gapi(token, "/messages/send", { method: "POST", body: { raw: b64url(mime) } }); }
  catch (e) {
    if (e.httpStatus === 401) access.delete(email);
    const out = sendOutcome(e);
    if (out.sent === "maybe") console.warn("Gmail: no se sabe si salió el mail:", e.httpStatus || e.name || "error");
    throw out;
  }
  return { id: String(r.id || ""), threadId: String(r.threadId || ""), from: id.email, bcc: !!bcc, signature: sig.source };
}
