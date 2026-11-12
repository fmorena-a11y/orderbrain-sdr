// Cliente mínimo del servidor MCP oficial de Pipedrive (https://mcp.pipedrive.ai/mcp), sin dependencias: JSON-RPC 2.0 por
// «streamable HTTP». La API REST pública de Pipedrive no manda mails; el MCP sí (createMailDraft + sendMailDraft), desde la
// casilla que cada persona tiene conectada en Pipedrive y ligado al prospecto o al trato. El token es el token API personal
// de esa persona (lib/pdtoken.js), en el header x-api-token (el MCP lo pasa a la API de Pipedrive): este módulo nunca lo
// guarda ni lo escribe en los logs ni en los errores.
//
// Cada sesión MCP: initialize → notifications/initialized → tools/call (con el Mcp-Session-Id que devuelve initialize).
// La respuesta puede venir como JSON o como text/event-stream (SSE): se lee hasta encontrar la del pedido.
// Los errores de la API de Pipedrive llegan DENTRO del resultado de la herramienta (texto JSON con «errors» o
// «success: false», o isError), no como error JSON-RPC: se detectan (toolError) y un 401 ahí es un token inválido o vencido.
// Errores con code (lo usa el navegador) y, para el envío, sent: "maybe" cuando no se sabe si salió (red, tiempo, 5xx).
// DEMO_MODE (sin PIPEDRIVE_MCP_URL): nada sale a la red, los borradores y envíos quedan en memoria (demoOutbox).

const env = process.env;
export const PROTOCOL = "2025-06-18";
export const mcpUrl = () => env.PIPEDRIVE_MCP_URL || "https://mcp.pipedrive.ai/mcp";
const bad = (msg, status = 400, code = "", extra = {}) => Object.assign(new Error(msg), { status, code, ...extra });
const CLIENT = { name: "OrderBrain SDRs", version: "1.0" };

// ---------- SSE: cada evento es un bloque separado por una línea vacía; los «data:» se juntan con saltos de línea
export function sseEvents(text) {
  const out = [];
  for (const block of String(text || "").split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter(l => l.startsWith("data:")).map(l => l.slice(5).replace(/^ /, "")).join("\n");
    if (!data) continue;
    try { out.push(JSON.parse(data)); } catch { /* evento que no es JSON: se ignora */ }
  }
  return out;
}
// el mensaje JSON-RPC que responde a `id` (también dentro de un lote)
const answerOf = (msgs, id) => msgs.flat().find(m => m && typeof m === "object" && m.id === id && ("result" in m || "error" in m)) || null;

// Lee un text/event-stream hasta que llega la respuesta a `id` (el servidor puede dejar el stream abierto después).
async function readSse(r, id) {
  if (!r.body?.getReader) return answerOf(sseEvents(await r.text()), id);
  const reader = r.body.getReader(), dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buf += dec.decode(value, { stream: true });
      // eventos completos (hasta la última línea vacía)
      const cut = Math.max(buf.lastIndexOf("\n\n"), buf.lastIndexOf("\r\n\r\n"));
      if (cut >= 0) { const a = answerOf(sseEvents(buf.slice(0, cut)), id); if (a) return a; }
      if (done) return answerOf(sseEvents(buf), id);
    }
  } finally { reader.cancel().catch(() => {}); }
}

const netFail = e => bad(e?.name === "TimeoutError" || e?.name === "AbortError" ? "Pipedrive no respondió a tiempo." : "No pude conectar con Pipedrive.", 502, "pd_net", { noResponse: true });

// Un pedido (o una notificación, sin id) al servidor MCP. Devuelve { result, sid, httpStatus }.
async function post(url, token, sid, msg, { timeout = 20e3, version = "" } = {}) {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", "x-api-token": token,
    ...(sid ? { "mcp-session-id": sid } : {}), ...(version ? { "mcp-protocol-version": version } : {}) };
  let r;
  try { r = await fetch(url, { method: "POST", headers, body: JSON.stringify(msg), signal: AbortSignal.timeout(timeout) }); }
  catch (e) { throw netFail(e); }
  const fail = (m, status, code = "", extra = {}) => bad(m, status, code, { httpStatus: r.status, ...extra });
  const newSid = r.headers.get("mcp-session-id") || sid;
  if (r.status === 401) { r.body?.cancel?.().catch(() => {}); throw fail(AUTH_MSG, 409, "pd_auth"); }
  if (r.status === 403) { r.body?.cancel?.().catch(() => {}); throw fail(FORBIDDEN_MSG, 409, "pd_forbidden"); }
  if (r.status === 404 && sid) { r.body?.cancel?.().catch(() => {}); throw fail("La sesión con Pipedrive se cerró.", 502, "mcp_session"); }
  if (msg.id === undefined) { r.body?.cancel?.().catch(() => {}); if (!r.ok) throw fail(`Pipedrive respondió ${r.status}.`, 502); return { result: null, sid: newSid, httpStatus: r.status }; }
  if (!r.ok) { r.body?.cancel?.().catch(() => {}); throw fail(`Pipedrive respondió ${r.status}.`, 502, r.status >= 500 ? "pd_server" : ""); }
  const ct = String(r.headers.get("content-type") || "").toLowerCase();
  let ans;
  try {
    if (ct.includes("text/event-stream")) ans = await readSse(r, msg.id);
    else { const t = await r.text(); ans = t.trim() ? answerOf([JSON.parse(t)], msg.id) : null; }
  } catch (e) { throw e?.name === "TimeoutError" || e?.name === "AbortError" ? netFail(e) : fail("Pipedrive respondió algo que no entiendo.", 502, "pd_format", { noResponse: true }); }
  if (!ans) throw fail("Pipedrive respondió algo que no entiendo.", 502, "pd_format", { noResponse: true });
  if (ans.error) throw fail(`Pipedrive: ${String(ans.error.message || "error").slice(0, 200)}`, 502, "pd_rpc", { rpcCode: ans.error.code });
  return { result: ans.result, sid: newSid, httpStatus: r.status };
}

const AUTH_MSG = "Pipedrive no aceptó tu token (lo cambiaste o venció). Conectá tu Pipedrive de nuevo.";
const FORBIDDEN_MSG = "Pipedrive no te dio permiso para esto (tu usuario no puede mandar mails desde la API).";
// el texto de un resultado de herramienta (content[].text) y su JSON (structuredContent o el texto, si es JSON)
export function toolData(result) {
  const text = (result?.content || []).filter(c => c?.type === "text" && typeof c.text === "string").map(c => c.text).join("\n");
  let data = result?.structuredContent && typeof result.structuredContent === "object" ? result.structuredContent : null;
  if (!data) for (const c of result?.content || []) { if (c?.type !== "text") continue; try { const j = JSON.parse(c.text); if (j && typeof j === "object") { data = j; break; } } catch { /* texto */ } }
  return { data, text };
}

// ¿La herramienta falló? isError, o el JSON con «errors» (no vacío), «success: false» o «error». Devuelve el error (con
// code: pd_auth si Pipedrive dijo 401, pd_forbidden si 403, si no pd_tool) o null.
const filled = v => v != null && v !== false && v !== "" && !(Array.isArray(v) && !v.length) && !(typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length);
const flat = v => v == null ? [] : typeof v === "object" ? Object.values(v).flatMap(flat) : [String(v)];
export function toolError(result, { data, text } = toolData(result)) {
  const d = data && typeof data === "object" ? data : null;
  if (!result?.isError && !(d && (filled(d.errors) || d.success === false || (filled(d.error) && !d.data)))) return null;
  const parts = d ? [...flat(d.errors), ...flat(d.error), ...flat(d.message)] : [];
  const msg = (parts.length ? parts.join(" · ") : text || "no pudo hacerlo").replace(/\s+/g, " ").trim().slice(0, 240);
  if (/\b401\b|unauthori[sz]ed|invalid (api )?token|token (is )?(invalid|expired)/i.test(msg)) return bad(AUTH_MSG, 409, "pd_auth", { toolError: true });
  if (/\b403\b|forbidden/i.test(msg)) return bad(FORBIDDEN_MSG, 409, "pd_forbidden", { toolError: true });
  return bad(`Pipedrive: ${msg}`, 502, "pd_tool", { toolError: true });
}
// Una sesión MCP con el token de una persona. call(name, args) devuelve { data, text } o tira el error de la herramienta.
export async function connect(token, { url = mcpUrl(), timeout = 15e3 } = {}) {
  if (!token) throw bad("Falta la conexión con Pipedrive.", 409, "pd_missing");
  const init = await post(url, token, null, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT } }, { timeout });
  const sid = init.sid || "", version = String(init.result?.protocolVersion || PROTOCOL);
  await post(url, token, sid, { jsonrpc: "2.0", method: "notifications/initialized" }, { timeout, version });
  let n = 1;
  return {
    sid,
    async call(name, args = {}, { timeout: t = 30e3 } = {}) {
      const { result } = await post(url, token, sid, { jsonrpc: "2.0", id: ++n, method: "tools/call", params: { name, arguments: args } }, { timeout: t, version });
      const out = toolData(result), err = toolError(result, out);
      if (err) throw err;
      return out;
    },
    // se cierra la sesión (si el servidor no lo soporta, da igual)
    close: () => sid ? fetch(url, { method: "DELETE", headers: { "x-api-token": token, "mcp-session-id": sid, "mcp-protocol-version": version }, signal: AbortSignal.timeout(5e3) }).then(r => r.body?.cancel?.(), () => {}).catch(() => {}) : Promise.resolve(),
  };
}

// ---------- lo que se lee de las respuestas
// El id del borrador en la respuesta de createMailDraft: el formato exacto no está documentado, así que se busca en los
// lugares razonables (structuredContent o el JSON del texto: id, draft_id, data.id, draft.id…) y, si no, en el texto.
const intId = v => { const n = typeof v === "number" ? v : /^\d{1,15}$/.test(String(v ?? "").trim()) ? Number(v) : NaN; return Number.isSafeInteger(n) && n > 0 ? n : null; };
export function draftIdOf({ data, text } = {}) {
  const objs = [data, data?.data, data?.draft, data?.data?.draft, data?.result, data?.mail_message, data?.data?.mail_message, data?.message];
  for (const o of objs) if (o && typeof o === "object" && !Array.isArray(o)) for (const k of ["draft_id", "draftId", "id"]) { const v = intId(o[k]); if (v) return v; }
  const t = String(text || "");
  const m = t.match(/\bdraft[\s_-]*(?:id)?\b["'\s:=#]*(\d{1,15})\b/i) || t.match(/\bdraft\b[^\n]{0,40}?\bid\b["'\s:=#]*(\d{1,15})\b/i) || t.match(/^\s*\{?\s*"?id"?\s*[:=]\s*(\d{1,15})\b/i);
  return m ? intId(m[1]) : null;
}
// Pipedrive no tiene una casilla conectada para esta persona
export const noMailbox = msg => /mailbox|nylas|no (connected )?(e-?mail )?account|not connected|sin casilla/i.test(String(msg || ""));

// ---------- las dos herramientas del mail. token: el access token de la persona o una sesión ya abierta (connect).
// READ_ONLY=1: nada se crea ni se manda (además del corte por ruta de lib/readonly.js).
const readOnly = () => { if (env.READ_ONLY === "1") throw bad("Modo solo lectura: no se escribe en Pipedrive.", 403, "read_only"); };
async function withSession(token, fn) {
  if (typeof token !== "string") return fn(token);
  const s = await connect(token);
  try { return await fn(s); } finally { s.close(); }
}
// Crea el borrador en la casilla conectada de la persona (no lo manda). Devuelve { id } o tira error: sin id no se sigue.
export async function createMailDraft(token, args) {
  readOnly();
  return withSession(token, async s => {
    let out;
    try { out = await s.call("createMailDraft", args); }
    catch (e) { if (e.code === "pd_tool" && noMailbox(e.message)) throw mailboxErr(); throw e; }
    const id = draftIdOf(out);
    if (!id) throw bad("Pipedrive no devolvió el borrador: el mail no salió. Mirá Borradores en tu correo de Pipedrive.", 502, "pd_nodraft");
    return { id };
  });
}
const mailboxErr = () => bad("No tenés una casilla conectada en Pipedrive. Conectala en Pipedrive (Configuración personal › Correo) y probá de nuevo.", 409, "pd_nomailbox");
export const UNKNOWN_MSG = "No sé si salió: mirá Enviados en tu correo de Pipedrive antes de mandarlo de nuevo.";
// Lo que quiere decir un error de sendMailDraft: sin respuesta (red, tiempo), respuesta ilegible, 5xx o error interno del
// servidor → no se sabe si salió (sent = "maybe": el servidor no libera la clave del envío). La herramienta dijo que no
// (isError o un error adentro del resultado), 401/403 o la sesión vencida → no salió y se puede reintentar.
export function sendOutcome(e) {
  if (e?.code === "pd_tool") return noMailbox(e.message) ? mailboxErr() : e;
  if (["read_only", "pd_auth", "pd_forbidden", "mcp_session"].includes(e?.code)) return e;
  if (e?.code === "pd_rpc" && e.rpcCode !== -32603) return e;
  return bad(UNKNOWN_MSG, 502, "pd_unknown", { sent: "maybe" });
}
// Manda el borrador (queda en la cola de Pipedrive y sale a los pocos segundos).
export async function sendMailDraft(token, id) {
  readOnly();
  if (!intId(id)) throw bad("Falta el borrador.", 400);
  return withSession(token, async s => {
    try { await s.call("sendMailDraft", { id: Number(id) }); return { id: Number(id) }; }
    catch (e) { throw sendOutcome(e); }
  });
}

// ---------- demo: nada sale a la red
const outbox = [];
export const demoOutbox = () => outbox;
// x@timeout.test simula que Pipedrive no respondió al enviar (no se sabe si salió); x@rechazo.test, que no lo mandó;
// x@sinbuzon.test, que la persona no tiene casilla conectada en Pipedrive.
export function demoCreate(args, { from = "", name = "" } = {}) {
  const to = String(args?.to?.[0]?.email_address || "");
  if (/@sinbuzon\.test$/i.test(to)) throw bad("No tenés una casilla conectada en Pipedrive. Conectala en Pipedrive (Configuración personal › Correo) y probá de nuevo.", 409, "pd_nomailbox");
  const d = { id: 7000 + outbox.length + 1, args: JSON.parse(JSON.stringify(args)), from, name, at: new Date().toISOString(), sent: false };
  outbox.unshift(d); outbox.length = Math.min(outbox.length, 50);
  return d.id;
}
export function demoSend(id) {
  const d = outbox.find(x => x.id === Number(id));
  if (!d) throw bad("Pipedrive: ese borrador no existe.", 502, "pd_tool", { toolError: true });
  const to = String(d.args?.to?.[0]?.email_address || "");
  if (/@timeout\.test$/i.test(to)) throw bad("Pipedrive no respondió a tiempo.", 502, "pd_net", { noResponse: true });
  if (/@rechazo\.test$/i.test(to)) throw bad("Pipedrive: no se pudo enviar (simulado).", 502, "pd_tool", { toolError: true });
  d.sent = true; d.sentAt = new Date().toISOString();
  return { id: d.id };
}
