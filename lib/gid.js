// Google de cada persona, lo puro: a dónde se le habla a Google, el token de identidad (id_token) que viene con el código y
// qué permisos quedaron dados. Lo usa lib/gmail.js para «Entrar con Google» (un solo paso: entra y queda conectado el mail,
// el calendario y las planillas) y para «Conectar Google» desde una sesión. Pruebas en test/google-login.test.mjs.
import crypto from "crypto";

const env = process.env;
// Google de prueba (test/fake-google.mjs): SOLO con el Pipedrive de prueba (DEMO_MODE sin token real) y solo en esta
// máquina. Con la cuenta real, siempre los servidores de Google.
export function testBase() {
  const v = String(env.GOOGLE_TEST_URL || "").trim().replace(/\/+$/, "");
  if (!v || env.DEMO_MODE !== "1" || env.PIPEDRIVE_API_TOKEN) return "";
  return /^http:\/\/(127\.0\.0\.1|localhost):\d{2,5}$/.test(v) ? v : "";
}
export function endpoints() {
  const b = testBase();
  return b ? { auth: `${b}/o/oauth2/v2/auth`, token: `${b}/token`, revoke: `${b}/revoke`, certs: `${b}/oauth2/v3/certs`, gmail: `${b}/gmail/v1/users/me` }
    : { auth: "https://accounts.google.com/o/oauth2/v2/auth", token: "https://oauth2.googleapis.com/token", revoke: "https://oauth2.googleapis.com/revoke",
      certs: "https://www.googleapis.com/oauth2/v3/certs", gmail: "https://gmail.googleapis.com/gmail/v1/users/me" };
}

// ---------- permisos: lo que Google deja tildar o destildar en su pantalla, agrupado como lo ve la persona
const G = "https://www.googleapis.com/auth/";
export const SCOPE = { send: G + "gmail.send", settings: G + "gmail.settings.basic", freebusy: G + "calendar.freebusy", sheets: G + "spreadsheets.readonly", drive: G + "drive.file" };
// identidad (no son permisos sobre datos): con esto Google manda el id_token con el email verificado
export const ID_SCOPES = ["openid", "email", "profile"];
export const PERMS = [
  { key: "mail", label: "Mail", what: "mandar mails desde la ficha, con tu firma", need: [SCOPE.send] },
  { key: "calendar", label: "Calendario", what: "ver los horarios libres para proponer demos", need: [SCOPE.freebusy] },
  { key: "sheets", label: "Planillas", what: "leer la planilla de un evento y crear hojas con las tablas del asistente", need: [SCOPE.sheets, SCOPE.drive] },
];
const scopeList = s => [...new Set((Array.isArray(s) ? s : String(s || "").split(/\s+/)).map(x => String(x).trim()).filter(Boolean))];
// Una conexión guardada antes de anotar los permisos: se hizo aceptando enviar mails (era obligatorio) y nada más se sabe.
export const recScopes = rec => !rec ? [] : rec.scope ? scopeList(rec.scope) : [SCOPE.send, SCOPE.settings];
export const hasScope = (rec, scope) => recScopes(rec).includes(scope);
// { mail, calendar, sheets } y lo que falta (claves en el orden de PERMS)
export function permsOf(scopes) {
  const have = new Set(scopeList(scopes)), perms = {};
  for (const p of PERMS) perms[p.key] = p.need.every(s => have.has(s));
  return { perms, missing: PERMS.filter(p => !perms[p.key]).map(p => p.key) };
}
// de lo que dio, cuánto es nuestro (sin openid/email/profile): 0 = no dio ningún permiso
export const usefulScopes = scopes => scopeList(scopes).filter(s => Object.values(SCOPE).includes(s));

// ---------- id_token (OpenID Connect): un JWT firmado por Google (RS256). Se comprueba la firma con las claves públicas de
// Google, que es para este cliente (aud), que lo emitió Google (iss), que no venció y que es el de ESTE ingreso (nonce).
const b64json = s => JSON.parse(Buffer.from(String(s), "base64url").toString("utf8"));
const ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);
const fail = why => ({ ok: false, why });
export function verifyIdToken(idToken, { keys = [], audience = "", nonce = "", now = Date.now(), issuers = ISSUERS } = {}) {
  const parts = String(idToken || "").split(".");
  if (parts.length !== 3 || !parts.every(Boolean)) return fail("formato");
  let head, p;
  try { head = b64json(parts[0]); p = b64json(parts[1]); } catch { return fail("formato"); }
  if (!head || head.alg !== "RS256" || !p || typeof p !== "object") return fail("algoritmo");
  const jwk = (keys || []).find(k => k && k.kid === head.kid && k.kty === "RSA" && (!k.alg || k.alg === "RS256") && (!k.use || k.use === "sig"));
  if (!jwk) return fail("clave");
  let good = false;
  try { good = crypto.verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), crypto.createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(parts[2], "base64url")); } catch { good = false; }
  if (!good) return fail("firma");
  if (!issuers.has(p.iss)) return fail("emisor");
  const aud = Array.isArray(p.aud) ? p.aud : [p.aud];
  if (!audience || aud.length !== 1 || aud[0] !== audience || (p.azp && p.azp !== audience)) return fail("cliente");
  const sec = Math.floor(now / 1000);
  if (!(Number(p.exp) > sec - 60) || !(Number(p.iat) < sec + 300)) return fail("vencido");
  if (nonce && p.nonce !== nonce) return fail("nonce");
  return { ok: true, payload: p };
}
// quién es según Google: el email del token (verificado), nunca un parámetro de la dirección
export function identityOf(p) {
  const email = String(p?.email || "").trim().toLowerCase();
  return { email, verified: p?.email_verified === true || p?.email_verified === "true", name: String(p?.name || "").slice(0, 120), picture: /^https:\/\//.test(p?.picture || "") ? String(p.picture).slice(0, 500) : "", hd: String(p?.hd || "").toLowerCase() };
}
// mismas reglas que /auth/google: email verificado y, si hay dominio, del dominio (y si Google dice de qué organización es
// la cuenta, esa también tiene que ser el dominio)
export function domainOk(id, domain) {
  const d = String(domain || "").toLowerCase();
  if (!d) return true;
  return id.email.endsWith("@" + d) && (!id.hd || id.hd === d);
}
// las claves públicas de Google (JWKS), una hora en memoria; si llega un kid que no está, se leen de nuevo una vez
let jwks = { keys: [], exp: 0, url: "" };
async function googleKeys({ fresh = false, fetchImpl = fetch } = {}) {
  const url = endpoints().certs;
  if (!fresh && jwks.url === url && jwks.exp > Date.now() && jwks.keys.length) return jwks.keys;
  const r = await fetchImpl(url, { signal: AbortSignal.timeout(10e3) });
  const j = r.ok ? await r.json().catch(() => null) : null;
  if (!Array.isArray(j?.keys) || !j.keys.length) throw Object.assign(new Error("No pude leer las claves de Google."), { status: 502 });
  jwks = { keys: j.keys, exp: Date.now() + 3600e3, url };
  return jwks.keys;
}
export async function checkIdToken(idToken, { audience, nonce, fetchImpl = fetch } = {}) {
  let v = verifyIdToken(idToken, { keys: await googleKeys({ fetchImpl }), audience, nonce });
  if (!v.ok && v.why === "clave") v = verifyIdToken(idToken, { keys: await googleKeys({ fresh: true, fetchImpl }), audience, nonce });
  return v;
}
