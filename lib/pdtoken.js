// «Conectá tu Pipedrive»: cada persona pega UNA vez su token API personal de Pipedrive (Pipedrive › tu foto › Configuración
// personal › API) para que el mail de la ficha salga de la casilla que tiene conectada en Pipedrive, con un clic, ligado al
// prospecto o al trato (servidor MCP oficial de Pipedrive, lib/pdmcp.js, que acepta el token en el header x-api-token).
// No hace falta que el administrador configure nada (el OAuth de Pipedrive no acepta la vuelta de una app web propia).
//  · Al pegarlo, el servidor pregunta a Pipedrive de quién es (GET /v1/users/me con x-api-token): tiene que ser el MISMO
//    usuario de Pipedrive de la sesión (pdUserId; si trae email, el mismo email) y de la empresa de la app (company_domain).
//    Si no, 403 y no se guarda nada.
//  · Se guarda cifrado por email (AES-256-GCM con SESSION_SECRET y una clave propia, lib/gmail.js). Nunca va al navegador
//    ni a los logs: el estado dice solo conectado, confirmado y el nombre.
//  · Si después Pipedrive lo rechaza (401: lo cambiaron o venció), se borra la conexión y se pide conectar de nuevo.
//  · «Desconectar» borra lo guardado (el token se invalida regenerándolo en Pipedrive).
// DEMO_MODE (sin PIPEDRIVE_MCP_URL): cualquier texto conecta (uno que empieza con «otro» simula el token de otra persona) y
// el envío queda en memoria (lib/pdmcp.js, demoOutbox). Las pruebas (test/pdmail.test.mjs) usan PIPEDRIVE_MCP_URL y
// PIPEDRIVE_API_URL con un Pipedrive falso local.
import { encrypt, decrypt, textToHtml } from "./gmail.js";
import { getPdAuth, setPdAuth, delPdAuth } from "./store.js";
import * as mcp from "./pdmcp.js";

const env = process.env;
const TOKEN_INFO = "pipedrive-api-token";
const secret = () => env.SESSION_SECRET || "";
const lc = s => String(s || "").trim().toLowerCase();
const bad = (msg, status = 400, code = "", extra = {}) => Object.assign(new Error(msg), { status, code, ...extra });

// simulado: el Pipedrive de prueba (DEMO_MODE sin token) y sin un MCP propio para probar el protocolo
export const simulated = () => env.DEMO_MODE === "1" && !env.PIPEDRIVE_API_TOKEN && !env.PIPEDRIVE_MCP_URL;
// sin SESSION_SECRET no se puede cifrar el token: no se ofrece (la ficha sigue con Gmail o «Abrir en Gmail»)
export const enabled = () => simulated() || !!secret();
const companyDomain = () => lc(env.PIPEDRIVE_DOMAIN || "ordereat");
const apiBase = () => String(env.PIPEDRIVE_API_URL || "https://api.pipedrive.com").replace(/\/+$/, "");
const NO_USER = "Tu email no coincide con ningún usuario de Pipedrive: pedí que te den de alta.";
const REVOKED = "Pipedrive no aceptó tu token (lo cambiaste o venció). Conectá tu Pipedrive de nuevo.";

// el token como lo pega la persona: sin espacios. Los de Pipedrive son 40 caracteres hexadecimales.
export function cleanToken(raw, { demo = simulated() } = {}) {
  const t = String(raw ?? "").replace(/\s+/g, "");
  if (!t) return { error: "Pegá tu token de Pipedrive." };
  if (demo) return { token: t.slice(0, 200) };
  if (!/^[A-Za-z0-9]{20,100}$/.test(t)) return { error: "Eso no parece un token de Pipedrive: copialo entero desde Configuración personal › API." };
  return { token: t };
}
// De quién es el token (GET /v1/users/me). null si Pipedrive dice que no vale (401/403). Errores sin el contenido de la respuesta.
export async function whoIs(token) {
  let r;
  try { r = await fetch(`${apiBase()}/v1/users/me`, { headers: { "x-api-token": token, accept: "application/json" }, signal: AbortSignal.timeout(10e3) }); }
  catch { throw bad("No pude conectar con Pipedrive. Probá de nuevo en un rato.", 502, "pd_net"); }
  if (r.status === 401 || r.status === 403) { r.body?.cancel?.().catch(() => {}); return null; }
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.data?.id) throw bad(`Pipedrive respondió ${r.status}. Probá de nuevo en un rato.`, 502, "pd_net");
  const u = j.data;
  return { id: Number(u.id), name: String(u.name || "").slice(0, 120), email: lc(u.email), company: lc(u.company_domain) };
}
// Por qué ese token no es de quien está en la sesión ("" si es suyo): otro usuario, otro email u otra empresa
export function mismatch(who, { user, email }) {
  if (!who?.id || !user?.pdUserId || Number(who.id) !== Number(user.pdUserId)) return `Ese token es de ${who?.name || "otra persona"} en Pipedrive, pero entraste a la app como ${email}. Pegá el tuyo.`;
  if (who.email && who.email !== lc(email)) return `Ese token es de ${who.email}, pero entraste a la app como ${email}. Pegá el tuyo.`;
  if (who.company && who.company !== companyDomain()) return `Ese token es de otra empresa de Pipedrive (${who.company}). Pegá el de tu usuario de OrderEAT.`;
  return "";
}

// ---------- lo que usa el servidor
// Conectar (o confirmar en otro dispositivo: se pega de nuevo y tiene que ser el mismo usuario). Devuelve { name }.
export async function connect({ email, user, token: raw }) {
  if (!enabled()) throw bad("Para conectar Pipedrive falta SESSION_SECRET en el servidor (avisale al administrador).", 404, "pd_config");
  if (!user?.pdUserId) throw bad(NO_USER, 403, "pd_nouser");
  const c = cleanToken(raw); if (c.error) throw bad(c.error, 400, "pd_badtoken");
  const at = new Date().toISOString();
  if (simulated()) {
    if (/^otro/i.test(c.token)) throw bad(`Ese token es de otra persona en Pipedrive, pero entraste a la app como ${email}. Pegá el tuyo.`, 403, "pd_mismatch");
    const name = user.pdName || user.name || "";
    await setPdAuth(email, { demo: true, pdUserId: Number(user.pdUserId), name, company: companyDomain(), at });
    return { name };
  }
  const who = await whoIs(c.token);
  if (!who) throw bad("Pipedrive no aceptó ese token. Copialo de nuevo desde Configuración personal › API.", 400, "pd_badtoken");
  const why = mismatch(who, { user, email });
  if (why) throw bad(why, 403, "pd_mismatch");
  const name = who.name || user.pdName || "";
  await setPdAuth(email, { enc: encrypt(c.token, secret(), TOKEN_INFO), pdUserId: who.id, name, company: who.company || companyDomain(), at });
  return { name };
}
// Desconectar: borra lo guardado.
export async function disconnect(email) { await delPdAuth(email); return { ok: true }; }
// Estado para el navegador: sin el token. Conectado solo si es la cuenta de Pipedrive de quien mira.
export async function status(email, user) {
  const on = enabled(), rec = on ? await getPdAuth(email).catch(() => null) : null;
  const mine = !!rec && !!user?.pdUserId && Number(rec.pdUserId) === Number(user.pdUserId);
  return { enabled: on, demo: simulated(), connected: mine, name: mine ? rec.name || "" : "", ...(rec && !mine ? { mismatch: true } : {}), ...(!user?.pdUserId ? { noUser: true } : {}) };
}
// ¿tiene una conexión guardada que sea suya? (para elegir por dónde sale el mail). Si no se puede leer lo guardado, tira
// error: el servidor responde 503 en vez de elegir otra vía.
export async function connected(email, user) {
  if (!enabled() || !user?.pdUserId) return false;
  const rec = await getPdAuth(email);
  return !!rec && Number(rec.pdUserId) === Number(user.pdUserId);
}

// ---------- envío
// el cuerpo del borrador: el texto del SDR en HTML (escapado, con saltos y links) y la firma al final
export const draftBody = (text, signatureHtml = "") => `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222">${textToHtml(text)}</div>` +
  (signatureHtml ? `<br><div>${signatureHtml}</div>` : "");
// lo que se le pasa a createMailDraft: un mail nuevo, ligado al trato abierto o al prospecto (nunca los dos)
export function draftArgs({ to, toName = "", subject, text, signatureHtml = "", leadId = null, dealId = null }) {
  const rcpt = { email_address: to, ...(toName ? { name: String(toName).slice(0, 120) } : {}) };
  return { sendmode: "new", to: [rcpt], subject, body: draftBody(text, signatureHtml),
    ...(Number(dealId) > 0 ? { deal_id: Number(dealId) } : leadId ? { lead_id: String(leadId) } : {}) };
}
// Envía el mail desde la casilla de Pipedrive de la persona: crea el borrador ligado al prospecto o trato y lo manda.
// Devuelve { id, draftId, from, via, signature, linked }. Errores con code; sent = "maybe" si no se sabe si salió.
export async function send(email, user, { to, toName = "", subject, text, signature = null, leadId = null, dealId = null }) {
  if (!enabled()) throw bad("Para enviar desde Pipedrive falta SESSION_SECRET en el servidor (avisale al administrador).", 404, "pd_config");
  const rec = await getPdAuth(email);
  if (!rec) throw bad("Conectá tu Pipedrive para enviar desde acá.", 409, "pd_missing");
  // defensa extra: la cuenta conectada tiene que ser la de la sesión (ya se comprobó al conectar)
  if (!user?.pdUserId || Number(rec.pdUserId) !== Number(user.pdUserId)) throw bad("La cuenta de Pipedrive conectada no es la tuya. Conectá tu Pipedrive de nuevo.", 409, "pd_mismatch");
  const args = draftArgs({ to, toName, subject, text, signatureHtml: signature?.html || "", leadId, dealId });
  const out = id => ({ id: `pd-${id}`, draftId: id, from: rec.name || "", via: "pipedrive", signature: signature?.html ? signature.source || "" : "", linked: args.deal_id ? "deal" : args.lead_id ? "lead" : "" });
  if (rec.demo) {
    if (env.READ_ONLY === "1") throw bad("Modo solo lectura: no se escribe en Pipedrive.", 403, "read_only");
    const id = mcp.demoCreate(args, { from: email, name: rec.name });
    try { mcp.demoSend(id); } catch (e) { throw sendFail(mcp.sendOutcome(e), true); }
    return out(id);
  }
  const token = decrypt(rec.enc, secret(), TOKEN_INFO);
  if (!token) { await delPdAuth(email).catch(() => {}); throw bad(REVOKED, 409, "pd_revoked"); }
  // una sesión MCP para los dos pasos; si Pipedrive cerró la sesión (404), se abre otra y se reintenta ese paso una vez
  let s = null, draft = null;
  const run = async op => {
    for (let i = 0; ; i++) {
      try { if (!s) s = await mcp.connect(token); return await op(s); }
      catch (e) { if (i || e.code !== "mcp_session") throw e; s?.close(); s = null; }
    }
  };
  try {
    draft = await run(x => mcp.createMailDraft(x, args));
    await run(x => mcp.sendMailDraft(x, draft.id));
    return out(draft.id);
  } catch (e) {
    // 401 de Pipedrive (HTTP o dentro del resultado): el token ya no vale → se borra la conexión y se pide conectar de nuevo
    if (e.code === "pd_auth") { await delPdAuth(email).catch(() => {}); throw sendFail(bad(REVOKED, 409, "pd_revoked"), !!draft); }
    throw sendFail(e, !!draft);
  } finally { s?.close(); }
}
// si no se sabe si salió, se avisa en el log (sin datos); si no salió y ya había borrador, quedó en el correo de Pipedrive
function sendFail(e, drafted) {
  if (e.sent === "maybe") console.warn("Pipedrive: no se sabe si salió el mail:", e.code || "error");
  else if (drafted) e.message = `${String(e.message).replace(/\.?\s*$/, ".")} No salió: quedó como borrador en tu correo de Pipedrive.`;
  return e;
}
