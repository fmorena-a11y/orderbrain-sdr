// Mail desde Pipedrive: «Conectá tu Pipedrive» pegando el token API personal (lib/pdtoken.js: se comprueba con users/me que
// es el mismo usuario y la empresa, se guarda cifrado), el cliente MCP con x-api-token (lib/pdmcp.js: JSON y SSE, errores
// dentro del resultado), el envío ligado al prospecto o trato (sales.sendMail con via "pipedrive"), «Tu firma»
// (lib/signature.js) y las rutas del servidor (sin doble envío, sin mandar desde la cuenta de otro, confirmar por dispositivo).
// Todo contra un Pipedrive falso local (test/fake-pdmcp.mjs) y el Pipedrive de prueba en memoria (DEMO_MODE): sin red.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { fakePipedrive } from "./fake-pdmcp.mjs";
for (const k of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "PIPEDRIVE_API_TOKEN", "ANTHROPIC_API_KEY", "PIPEDRIVE_SMART_BCC", "GOOGLE_CLIENT_SECRET", "READ_ONLY", "TEAM_ACCESS_CODE", "BRAIN_TOKEN", "PIPEDRIVE_DOMAIN"]) delete process.env[k];
Object.assign(process.env, { DEMO_MODE: "1", SESSION_SECRET: "clave-de-prueba", VERCEL: "1", DEV_LOGIN_EMAIL: "demo@ordereat.com", DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "ob-pdm-")) });
const F = await fakePipedrive();
process.env.PIPEDRIVE_API_URL = F.base; process.env.PIPEDRIVE_MCP_URL = F.mcp;
const T = await import("../lib/pdtoken.js");
const M = await import("../lib/pdmcp.js");
const SIG = await import("../lib/signature.js");
const G = await import("../lib/gmail.js");
const sales = await import("../lib/sales.js");
const pd = await import("../lib/pipedrive.js");
const store = await import("../lib/store.js");
const { writesPipedrive } = await import("../lib/readonly.js");
const { default: app } = await import("../server.js");
const web = http.createServer(app);
await new Promise(r => web.listen(0, "127.0.0.1", r));
const APP = `http://127.0.0.1:${web.address().port}`;
after(async () => { web.closeAllConnections?.(); await new Promise(r => web.close(r)); await F.close(); });

const me = { email: "juandiego@ordereat.com", name: "Juan Diego", pdName: "Juan Diego", pdUserId: 2 };
const ME = F.token({ id: 2, name: "Juan Diego", email: "juandiego@ordereat.com" });
const quiet = async fn => { const w = console.warn; console.warn = () => {}; try { return await fn(); } finally { console.warn = w; } };
const stored = email => JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, "pdauth.json"), "utf8"))[email];
const tokenOf = email => G.decrypt(stored(email).enc, "clave-de-prueba", "pipedrive-api-token");
// cada prueba del envío se puede correr sola: si no quedó conectado de antes, se conecta
const ensure = async (user = me, token = ME) => { F.dead.delete(token); if (!(await T.status(user.email, user)).connected || !tokenOf(user.email)) await T.connect({ email: user.email, user, token }); };

// ---------- lo puro
test("sseEvents: junta los data: de cada evento, ignora comentarios y lo que no es JSON", () => {
  const t = ": ping\n\nevent: message\ndata: {\"a\":\ndata: 1}\n\nevent: x\ndata: no-json\n\r\ndata: {\"id\":2,\"result\":{}}\r\n\r\n";
  assert.deepEqual(M.sseEvents(t), [{ a: 1 }, { id: 2, result: {} }]);
});
test("draftIdOf: structuredContent, JSON en el texto o el texto; sin id → null", () => {
  assert.equal(M.draftIdOf(M.toolData({ structuredContent: { data: { id: 77 } }, content: [] })), 77);
  assert.equal(M.draftIdOf(M.toolData({ content: [{ type: "text", text: '{"success":true,"data":{"id":"88","deal_id":5}}' }] })), 88);
  assert.equal(M.draftIdOf(M.toolData({ content: [{ type: "text", text: '{"draft":{"id":12}}' }] })), 12);
  assert.equal(M.draftIdOf(M.toolData({ content: [{ type: "text", text: "Draft created successfully (draft id: 4321)." }] })), 4321);
  assert.equal(M.draftIdOf(M.toolData({ content: [{ type: "text", text: "Draft created for deal 15." }] })), null);
  assert.equal(M.draftIdOf(M.toolData({ content: [{ type: "text", text: '{"data":{"id":-1}}' }] })), null);
});
test("toolError: el error de la API llega adentro del resultado («errors», «success: false», isError); 401 → pd_auth", () => {
  const r = t => ({ content: [{ type: "text", text: typeof t === "string" ? t : JSON.stringify(t) }] });
  assert.equal(M.toolError(r({ errors: { user: "Pipedrive API returned 401", details: { status: 401 } } })).code, "pd_auth");
  assert.equal(M.toolError(r({ success: false, error: "Pipedrive API returned 401: unauthorized access" })).code, "pd_auth");
  assert.equal(M.toolError({ ...r("Pipedrive API returned 401"), isError: true }).code, "pd_auth");
  assert.equal(M.toolError(r({ errors: ["Pipedrive API returned 403"] })).code, "pd_forbidden");
  const e = M.toolError(r({ success: false, error: "Recipient rejected" }));
  assert.equal(e.code, "pd_tool"); assert.match(e.message, /Recipient rejected/);
  for (const ok of [{ success: true, data: { id: 1 } }, { data: { id: 1 }, errors: [] }, { data: { id: 1 }, errors: {} }, "Draft created."]) assert.equal(M.toolError(r(ok)), null, JSON.stringify(ok));
  assert.ok(!/x-api-token|Bearer/.test(M.toolError(r({ errors: { user: "Pipedrive API returned 401" } })).message));
});
test("sendOutcome: sin respuesta, 5xx o error interno → «no sé si salió»; la herramienta dijo que no, 401 → no salió", () => {
  for (const e of [{ code: "pd_net" }, { code: "pd_server", httpStatus: 502 }, { code: "pd_format" }, { code: "pd_rpc", rpcCode: -32603 }]) assert.equal(M.sendOutcome(Object.assign(new Error("x"), e)).sent, "maybe", e.code);
  for (const e of [{ code: "pd_tool" }, { code: "pd_auth" }, { code: "pd_forbidden" }, { code: "pd_rpc", rpcCode: -32602 }, { code: "mcp_session" }]) assert.ok(!M.sendOutcome(Object.assign(new Error("x"), e)).sent, e.code);
  assert.equal(M.sendOutcome(Object.assign(new Error("Pipedrive: no mailbox connected"), { code: "pd_tool" })).code, "pd_nomailbox");
});
test("cleanToken y mismatch: formato del token; otro usuario, otro email u otra empresa", () => {
  assert.deepEqual(T.cleanToken(` ${"a1".repeat(20)} \n`, { demo: false }), { token: "a1".repeat(20) });
  assert.ok(T.cleanToken("", { demo: false }).error); assert.ok(T.cleanToken("no es un token!", { demo: false }).error); assert.ok(T.cleanToken("abc", { demo: false }).error);
  assert.deepEqual(T.cleanToken("cualquier cosa", { demo: true }), { token: "cualquiercosa" });
  const ctx = { user: me, email: me.email };
  assert.equal(T.mismatch({ id: 2, email: "juandiego@ordereat.com", company: "ordereat" }, ctx), "");
  assert.equal(T.mismatch({ id: 2, email: "", company: "" }, ctx), "");
  assert.match(T.mismatch({ id: 3, name: "Agustín", company: "ordereat" }, ctx), /Agustín/);
  assert.match(T.mismatch({ id: 2, email: "otro@ordereat.com", company: "ordereat" }, ctx), /otro@ordereat\.com/);
  assert.match(T.mismatch({ id: 2, email: "juandiego@ordereat.com", company: "otraempresa" }, ctx), /otra empresa/);
});
test("draftArgs: un mail nuevo con el texto escapado y la firma; trato antes que prospecto, nunca los dos", () => {
  const a = T.draftArgs({ to: "ana@colegio.mx", toName: "Ana", subject: "Hola", text: "Hola <b>Ana</b>,\nhttps://ordereat.com", signatureHtml: "<b>Juan</b>", leadId: "abc", dealId: 9 });
  assert.equal(a.sendmode, "new"); assert.deepEqual(a.to, [{ email_address: "ana@colegio.mx", name: "Ana" }]);
  assert.equal(a.deal_id, 9); assert.equal(a.lead_id, undefined);
  assert.match(a.body, /Hola &lt;b&gt;Ana&lt;\/b&gt;,<br>\n<a href="https:\/\/ordereat\.com">/);
  assert.match(a.body, /<br><div><b>Juan<\/b><\/div>$/);
  assert.equal(T.draftArgs({ to: "a@b.co", subject: "x", text: "y", leadId: "L1" }).lead_id, "L1");
  assert.ok(!("lead_id" in T.draftArgs({ to: "a@b.co", subject: "x", text: "y" })) && !("deal_id" in T.draftArgs({ to: "a@b.co", subject: "x", text: "y" })));
});

// ---------- firma
test("firma armada: isotipo con URL absoluta, nombre, cargo, «email | teléfono» y www.ordereat.com; todo escapado", () => {
  const h = SIG.builtSignature({ name: "Facundo Morena", title: "Sales Development Representative", email: "fmorena@ordereat.com", phone: "+598 99 672 474", base: "https://orderbrain-sdr.vercel.app/" });
  assert.match(h, /<img src="https:\/\/orderbrain-sdr\.vercel\.app\/ordereat-isotipo\.png" alt="OrderEAT"/);
  assert.equal(G.htmlToText(h), "Facundo Morena\nSales Development Representative\nfmorena@ordereat.com | +598 99 672 474\nwww.ordereat.com");
  assert.match(h, /<a href="https:\/\/www\.ordereat\.com"[^>]*>www\.ordereat\.com<\/a>/);
  const x = SIG.builtSignature({ name: 'Ana <script>alert(1)</script>"', title: "<img src=x onerror=y>", email: "a@b.co" });
  assert.ok(!/<script|<img src=x/.test(x), x); // el texto queda escapado (&lt;…&gt;), nunca como etiqueta
  assert.match(x, /Ana &lt;script&gt;/);
  assert.equal(SIG.builtSignature({ name: " " }), "");
  assert.ok(!/\|/.test(SIG.builtSignature({ name: "Ana", email: "a@b.co" })));
});
test("firma: cargo por rol, teléfono válido y qué firma va según lo elegido y la vía", () => {
  assert.equal(SIG.titleOf({ role: "sdr" }), "Sales Development Representative");
  assert.equal(SIG.titleOf({ role: "ae" }), "Account Executive");
  assert.equal(SIG.titleOf({ role: "sdr", accessTitle: "CEO", leader: true }), "CEO");
  assert.equal(SIG.titleOf({ role: "", leader: true }), "Team Lead");
  assert.equal(SIG.titleOf({ prefs: { title: "  SDR   Uruguay " }, role: "sdr" }), "SDR Uruguay");
  assert.deepEqual(SIG.cleanPhone(" +598 99 672 474 "), { phone: "+598 99 672 474" });
  assert.ok(SIG.cleanPhone("llamame").error); assert.ok(SIG.cleanPhone("12").error); assert.deepEqual(SIG.cleanPhone(""), { phone: "" });
  const built = "<b>armada</b>";
  assert.deepEqual(SIG.pickSignature({ prefs: null, via: "pipedrive", built }), { mode: "armada", html: built, source: "armada" });
  assert.deepEqual(SIG.pickSignature({ prefs: null, via: "gmail", built }), { mode: "gmail", html: null, source: "gmail" });
  assert.deepEqual(SIG.pickSignature({ prefs: { signature: "<i>p</i>" }, via: "pipedrive", built }), { mode: "pegada", html: "<i>p</i>", source: "pegada" });
  assert.deepEqual(SIG.pickSignature({ prefs: { mode: "armada", signature: "<i>p</i>" }, via: "gmail", built }), { mode: "armada", html: built, source: "armada" });
  assert.equal(SIG.pickSignature({ prefs: { mode: "gmail" }, via: "pipedrive", built }).mode, "armada");
  assert.equal(SIG.pickSignature({ prefs: { mode: "pegada", signature: "" }, via: "pipedrive", built }).mode, "armada");
});

// ---------- conectar con el token
test("conectar: Pipedrive dice que es el mismo usuario (users/me con x-api-token) → se guarda cifrado; el estado no trae el token", async () => {
  const calls = F.meCalls.length;
  assert.deepEqual(await T.connect({ email: me.email, user: me, token: ME }), { name: "Juan Diego" });
  assert.equal(F.meCalls.length, calls + 1); assert.equal(F.meCalls.at(-1).token, ME); assert.equal(F.meCalls.at(-1).auth, null);
  const rec = stored(me.email);
  assert.equal(rec.pdUserId, 2); assert.equal(rec.company, "ordereat");
  assert.ok(!JSON.stringify(rec).includes(ME), "el token va cifrado");
  assert.equal(tokenOf(me.email), ME);
  assert.equal(fs.statSync(path.join(process.env.DATA_DIR, "pdauth.json")).mode & 0o077, 0);
  const st = await T.status(me.email, me);
  assert.deepEqual(st, { enabled: true, demo: false, connected: true, name: "Juan Diego" });
  assert.ok(!JSON.stringify(st).includes(ME));
  // la conexión guardada de otro usuario de Pipedrive no cuenta como conectada
  assert.equal((await T.status(me.email, { ...me, pdUserId: 3 })).connected, false);
});
test("conectar: token de otra persona, de otro email, de otra empresa o inválido → no se guarda nada", async () => {
  const u = { email: "agustin@ordereat.com", name: "Agustín", pdName: "Agustín Tejos", pdUserId: 3 };
  await assert.rejects(T.connect({ email: u.email, user: u, token: ME }), e => e.code === "pd_mismatch" && e.status === 403 && /Juan Diego/.test(e.message));
  const otroMail = F.token({ id: 3, name: "Agustín", email: "otro@ordereat.com" });
  await assert.rejects(T.connect({ email: u.email, user: u, token: otroMail }), e => e.code === "pd_mismatch" && /otro@ordereat\.com/.test(e.message));
  const otraEmpresa = F.token({ id: 3, name: "Agustín", email: "agustin@ordereat.com", company_domain: "otraempresa" });
  await assert.rejects(T.connect({ email: u.email, user: u, token: otraEmpresa }), e => e.code === "pd_mismatch" && /otra empresa/.test(e.message));
  await assert.rejects(T.connect({ email: u.email, user: u, token: "f".repeat(40) }), e => e.code === "pd_badtoken" && e.status === 400);
  await assert.rejects(T.connect({ email: u.email, user: u, token: "no sirve!" }), e => e.code === "pd_badtoken");
  F.usersDown = true;
  try { await assert.rejects(T.connect({ email: u.email, user: u, token: F.token({ id: 3, name: "Agustín", email: u.email }) }), e => e.status === 502); } finally { F.usersDown = false; }
  await assert.rejects(T.connect({ email: "x@ordereat.com", user: { email: "x@ordereat.com" }, token: ME }), e => e.code === "pd_nouser");
  assert.equal(await store.getPdAuth(u.email), null);
});
test("MCP con x-api-token (sin Bearer): respuesta JSON y SSE (aunque el stream quede abierto); Mcp-Session-Id y versión", async () => {
  await ensure();
  for (const [sse, keep] of [[false, false], [true, false], [true, true]]) {
    F.sse = sse; F.sseKeepOpen = keep;
    const t0 = Date.now(), r = await T.send(me.email, me, { to: "ana@colegio.mx", subject: `sse ${sse} ${keep}`, text: "Hola" });
    assert.ok(F.sent.some(d => d.id === r.draftId), `sse=${sse}`);
    assert.ok(Date.now() - t0 < 2500, "no espera a que se cierre el stream");
  }
  F.sse = false; F.sseKeepOpen = false;
  const calls = F.mcpCalls.slice(-12);
  assert.ok(calls.every(c => c.token === ME && c.auth === null), "x-api-token y nada de Authorization");
  assert.ok(calls.every(c => /application\/json/.test(c.accept) && /text\/event-stream/.test(c.accept)));
  const init = calls.findIndex(c => c.method === "initialize"), ci = calls[init + 1], tc = calls[init + 2];
  assert.equal(ci.method, "notifications/initialized"); assert.ok(ci.sid); assert.equal(ci.version, "2025-06-18");
  assert.equal(tc.name, "createMailDraft"); assert.equal(tc.sid, ci.sid);
  assert.equal(calls[init + 3].name, "sendMailDraft"); assert.equal(calls[init + 3].sid, ci.sid, "los dos pasos en la misma sesión");
});
test("401 después de conectado (el token se cambió en Pipedrive), en el resultado o por HTTP: borra la conexión y pide reconectar", async () => {
  for (const style of ["errors", "success", "isError", "http"]) {
    const u = { email: `vence-${style}@ordereat.com`, name: "Vence", pdUserId: 4 };
    const tok = F.token({ id: 4, name: "Matías", email: u.email });
    await T.connect({ email: u.email, user: u, token: tok });
    F.dead.add(tok); F.authStyle = style;
    const drafts = F.drafts.length;
    try { await assert.rejects(T.send(u.email, u, { to: "a@b.co", subject: "x", text: "y" }), e => e.code === "pd_revoked" && e.status === 409 && !e.sent, style); }
    finally { F.authStyle = "errors"; }
    assert.equal(await store.getPdAuth(u.email), null, style);
    assert.equal(F.drafts.length, drafts);
    assert.equal((await T.status(u.email, u)).connected, false);
  }
});
test("desconectar: borra lo guardado", async () => {
  const u = { email: "chau@ordereat.com", name: "Chau", pdUserId: 5 };
  await T.connect({ email: u.email, user: u, token: F.token({ id: 5, name: "Valentina", email: u.email }) });
  await T.disconnect(u.email);
  assert.equal(await store.getPdAuth(u.email), null);
  await assert.rejects(T.send(u.email, u, { to: "a@b.co", subject: "x", text: "y" }), e => e.code === "pd_missing");
});
test("send: casilla de otro, sin casilla en Pipedrive, error adentro del resultado y «no sé si salió»", async () => {
  await ensure();
  const drafts = F.drafts.length;
  await assert.rejects(T.send(me.email, { ...me, pdUserId: 3 }, { to: "a@b.co", subject: "x", text: "y" }), e => e.code === "pd_mismatch");
  assert.equal(F.drafts.length, drafts);
  F.createMode = "nomailbox";
  try { await assert.rejects(T.send(me.email, me, { to: "a@b.co", subject: "x", text: "y" }), e => e.code === "pd_nomailbox" && !e.sent); } finally { F.createMode = null; }
  for (const mode of ["error", "isError"]) {
    F.sendMode = mode;
    try { await assert.rejects(T.send(me.email, me, { to: "a@b.co", subject: "x", text: "y" }), e => e.code === "pd_tool" && !e.sent && /rejected/.test(e.message) && /borrador/.test(e.message), mode); } finally { F.sendMode = "ok"; }
  }
  for (const mode of ["500", "cut"]) {
    F.sendMode = mode;
    try { await quiet(() => assert.rejects(T.send(me.email, me, { to: "a@b.co", subject: "x", text: "y" }), e => e.code === "pd_unknown" && e.sent === "maybe", mode)); } finally { F.sendMode = "ok"; }
  }
  assert.ok(await store.getPdAuth(me.email), "un rechazo o un «no sé» no desconecta");
  for (const f of ["structured", "text"]) { F.draftFormat = f; const r = await T.send(me.email, me, { to: "a@b.co", subject: f, text: "y" }); assert.ok(F.sent.some(d => d.id === r.draftId), f); }
  F.draftFormat = "none";
  const sent = F.sent.length;
  try { await assert.rejects(T.send(me.email, me, { to: "a@b.co", subject: "x", text: "y" }), e => e.code === "pd_nodraft" && !e.sent); } finally { F.draftFormat = "text-json"; }
  assert.equal(F.sent.length, sent);
});
test("READ_ONLY: la ruta del envío no pasa y el cliente MCP no crea ni manda", async () => {
  await ensure();
  assert.ok(writesPipedrive("POST", "/api/schools/abc/mail"));
  assert.ok(writesPipedrive("POST", "/api/schools/abc/MAIL"));
  assert.ok(!writesPipedrive("GET", "/api/pipedrive/mail"));
  process.env.READ_ONLY = "1";
  const drafts = F.drafts.length;
  try { await assert.rejects(T.send(me.email, me, { to: "a@b.co", subject: "x", text: "y" }), e => e.code === "read_only" && e.status === 403); }
  finally { delete process.env.READ_ONLY; }
  assert.equal(F.drafts.length, drafts);
});

// ---------- el envío desde la ficha (sales.sendMail con via "pipedrive"), con el Pipedrive de prueba
async function newSchool(skip = 0) {
  let n = 0;
  for (const s of store.schools.filter(x => x.country === "México")) { const r = await sales.checkSchool(s.id); if (r.status === "new" && n++ >= skip) return s; }
  throw new Error("no hay colegios nuevos en el demo");
}
const viaPd = (user = me, sig = { html: "<b>Juan Diego</b>", source: "armada" }) => ({ send: m => T.send(user.email, user, { ...m, signature: sig }), by: "Juan Diego Pérez", via: "pipedrive" });
test("sendMail por Pipedrive, colegio nuevo: prospecto a tu nombre ANTES de mandar, borrador ligado a su lead_id, actividad, nota, llamada y una entrada", async () => {
  await ensure();
  const s = await newSchool(10), tz = "America/Mexico_City", drafts = F.drafts.length;
  const r = await sales.sendMail(s.id, me, { to: "Direccion@Colegio.edu.mx", subject: "OrderEAT para la cafetería", text: "Hola,\n\nTe escribo." }, tz, viaPd());
  assert.equal(F.drafts.length, drafts + 1);
  const d = F.drafts.at(-1);
  assert.ok(d.sent);
  assert.equal(d.args.lead_id, r.lead.id); assert.equal(d.args.deal_id, undefined);
  assert.deepEqual(d.args.to, [{ email_address: "direccion@colegio.edu.mx" }]);
  assert.equal(d.args.subject, "OrderEAT para la cafetería"); assert.equal(d.args.sendmode, "new");
  assert.match(d.args.body, /Hola,<br>\n<br>\nTe escribo\.<\/div><br><div><b>Juan Diego<\/b><\/div>$/);
  assert.equal(r.where.kind, "lead"); assert.equal(r.where.created, true);
  assert.equal(r.done[0].label, "Mail enviado a direccion@colegio.edu.mx desde tu correo de Pipedrive");
  assert.ok(r.done.some(x => x.label === "Queda en el correo del prospecto en Pipedrive"));
  assert.ok(!r.done.some(x => /Smart BCC/.test(x.label)));
  const m = store.getMatch(s.id);
  const acts = [...await pd.activities({ orgId: m.orgId, done: true, limit: 20 }), ...await pd.activities({ orgId: m.orgId, done: false, limit: 20 })];
  const mail = acts.find(a => a.type === "task"), call = acts.find(a => a.type === "call" && !a.done);
  assert.equal(mail.done, true); assert.equal(mail.lead_id, r.lead.id); assert.equal(mail.owner_id, 2);
  assert.ok(call); assert.equal(call.lead_id, r.lead.id); assert.equal(r.mail.autoNext.id, call.id);
  const note = (await pd.notesForOrg(m.orgId, 10)).find(n => /^<b>Mail enviado/.test(n.content));
  assert.match(note.content, /con su correo de Pipedrive<\/i>$/); assert.equal(note.lead_id, r.lead.id);
  assert.equal(r.mail.via, "pipedrive"); assert.equal(r.mail.id, `pd-${d.id}`);
  const t = store.touchesFor(s.id); assert.equal(t.length, 1); assert.deepEqual([t[0].outcome, t[0].channel, t[0].mailId], ["sent", "mail", r.mail.id]);
  const ml = await store.mailsFor(s.id); assert.equal(ml.length, 1); assert.equal(ml[0].via, "pipedrive"); assert.equal(ml[0].draftId, d.id);
  // Historial: una sola entrada «Mail enviado» (la actividad y la nota se juntan con el mail de la app)
  const tl = await sales.timelineFor(s.id, { user: me, tz, force: true });
  const mails = tl.items.filter(x => x.kind === "mail" || /mail/i.test(`${x.label} ${x.title}`));
  assert.equal(mails.length, 1, JSON.stringify(tl.items.map(x => [x.kind, x.label, x.title])));
  assert.equal(mails[0].kind, "mail"); assert.equal(mails[0].title, "OrderEAT para la cafetería");
});
test("sendMail por Pipedrive con trato abierto: el borrador va ligado al deal_id; en un prospecto de la ficha, a su lead_id", async () => {
  await ensure();
  const s = await newSchool(11), tz = "America/Mexico_City";
  await sales.sendMail(s.id, me, { to: "a@colegio.mx", subject: "Uno", text: "Hola" }, tz, viaPd());
  const orgId = store.getMatch(s.id).orgId;
  const deal = await pd.createDeal({ title: s.name, org_id: orgId, pipeline_id: 9, stage_id: 160, owner_id: 2 });
  await sales.checkSchool(s.id, { force: true });
  const r = await sales.sendMail(s.id, me, { to: "a@colegio.mx", subject: "Dos", text: "Hola" }, tz, viaPd());
  assert.equal(F.drafts.at(-1).args.deal_id, deal.id); assert.equal(F.drafts.at(-1).args.lead_id, undefined);
  assert.equal(r.where.kind, "deal");
  assert.ok(r.done.some(x => x.label === "Queda en el correo del trato en Pipedrive"));
  const lead = await pd.createLead({ title: "Colegio Prospecto Suelto", ownerId: 2 });
  store.addVirtual({ id: `pd-lead-${lead.id}`, leadOnly: true, leadId: lead.id, virtual: true, name: "Colegio Prospecto Suelto", country: "México", city: "Puebla" });
  const r2 = await sales.sendMail(`pd-lead-${lead.id}`, me, { to: "b@colegio.mx", subject: "Tres", text: "Hola" }, tz, viaPd());
  assert.equal(F.drafts.at(-1).args.lead_id, lead.id); assert.equal(r2.where.kind, "lead");
});
test("sendMail por Pipedrive: lo de otra persona, archivado o con corchetes no se manda (ni se crea el borrador)", async () => {
  await ensure();
  const s = await newSchool(12), tz = "America/Mexico_City";
  await sales.sendMail(s.id, me, { to: "a@colegio.mx", subject: "Mío", text: "Hola" }, tz, viaPd());
  const drafts = F.drafts.length, otro = { email: "agustin@ordereat.com", name: "Agustín", pdUserId: 3 };
  await assert.rejects(sales.sendMail(s.id, otro, { to: "a@colegio.mx", subject: "x", text: "y" }, tz, viaPd(otro)), e => e.status === 409 && /es de/.test(e.message));
  await assert.rejects(sales.sendMail(s.id, me, { to: "a@colegio.mx", subject: "x", text: "El [día]" }, tz, viaPd()), e => e.status === 400);
  await store.setArchived(s.id, { by: me.email, byName: "JD", at: new Date().toISOString(), reason: "Otro", text: "" });
  await assert.rejects(sales.sendMail(s.id, me, { to: "a@colegio.mx", subject: "x", text: "y" }, tz, viaPd()), e => e.status === 409 && /archivado/.test(e.message));
  await store.setArchived(s.id, null);
  assert.equal(F.drafts.length, drafts);
});

// ---------- rutas del servidor: conectar con la sesión, confirmar por dispositivo, sin doble envío, sin mandar desde la cuenta de otro
function jar() {
  const c = new Map();
  const req = async (p, { method = "GET", body } = {}) => {
    const r = await fetch(APP + p, { method, redirect: "manual", headers: { cookie: [...c].map(([k, v]) => `${k}=${v}`).join("; "), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    for (const h of r.headers.getSetCookie?.() || []) { const [kv] = h.split(";"), i = kv.indexOf("="); c.set(kv.slice(0, i), kv.slice(i + 1)); }
    return r;
  };
  return { req, json: async (p, o) => { const r = await req(p, o); return { status: r.status, body: await r.json().catch(() => null) }; } };
}
// el usuario del demo que entra con /auth/dev: demo@ordereat.com, id 1
const DEMO = F.token({ id: 1, name: "Demo Uno", email: "demo@ordereat.com" });
const login = async j => assert.equal((await j.json("/auth/dev", { method: "POST", body: {} })).status, 200);
test("rutas: pegar el token conecta y confirma esta sesión; el estado no trae el token", async () => {
  const j = jar(); await login(j);
  const st0 = await j.json("/api/pipedrive/mail");
  assert.equal(st0.body.connected, false); assert.match(st0.body.tokenUrl, /\/settings\/api$/);
  const r = await j.json("/api/pipedrive/connect", { method: "POST", body: { token: ` ${DEMO} ` } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.connected, true); assert.equal(r.body.verified, true); assert.equal(r.body.name, "Demo Uno");
  const st = await j.json("/api/pipedrive/mail");
  assert.ok(!JSON.stringify(st.body).includes(DEMO), "el token nunca vuelve al navegador");
  assert.equal(st.body.sig.mode, "armada"); assert.match(st.body.signature, /ordereat-isotipo\.png/);
  // el token de otra persona: 403 y no pisa lo guardado
  const bad = await j.json("/api/pipedrive/connect", { method: "POST", body: { token: ME } });
  assert.equal(bad.status, 403); assert.equal(bad.body.code, "pd_mismatch");
  assert.equal(tokenOf("demo@ordereat.com"), DEMO);
});
test("rutas: Enviar por Pipedrive una sola vez por clave; otro dispositivo confirma pegando el token (el de otro no sirve); firma", async () => {
  const j = jar(); await login(j);
  assert.equal((await j.json("/api/pipedrive/connect", { method: "POST", body: { token: DEMO } })).status, 200);
  const s = await newSchool(13), drafts = F.drafts.length, key = () => "k" + crypto.randomBytes(8).toString("hex");
  const sg = await j.json("/api/mail/signature", { method: "POST", body: { mode: "armada", title: "Sales Development Representative", phone: "+598 99 672 474" } });
  assert.equal(sg.status, 200); assert.match(sg.body.pipedrive.signature, /\+598 99 672 474/);
  assert.equal((await j.json("/api/mail/signature", { method: "POST", body: { mode: "armada", phone: "llamame" } })).status, 400);
  const body = { to: "dir@colegio.mx", subject: "Hola", text: "Hola,\n\nTe escribo.", key: key(), via: "pipedrive" };
  const r1 = await j.json(`/api/schools/${s.id}/mail`, { method: "POST", body });
  assert.equal(r1.status, 200, JSON.stringify(r1.body)); assert.equal(r1.body.mail.via, "pipedrive");
  assert.equal(F.drafts.length, drafts + 1); assert.ok(F.drafts.at(-1).sent); assert.equal(F.drafts.at(-1).who.id, 1);
  assert.match(F.drafts.at(-1).args.body, /ordereat-isotipo\.png[\s\S]*Sales Development Representative[\s\S]*demo@ordereat\.com \| \+598 99 672 474/);
  const r2 = await j.json(`/api/schools/${s.id}/mail`, { method: "POST", body });
  assert.equal(r2.status, 409); assert.equal(r2.body.code, "mail_dup");
  assert.equal(F.drafts.length, drafts + 1, "no se mandó dos veces");
  // otro dispositivo (por ejemplo, un líder que entró con el código de esa persona): no manda, no cambia la firma ni desconecta
  const k2 = jar(); await login(k2);
  const v2 = await k2.json("/api/pipedrive/mail"); assert.equal(v2.body.connected, true); assert.equal(v2.body.verified, false);
  const r3 = await k2.json(`/api/schools/${s.id}/mail`, { method: "POST", body: { ...body, key: key() } });
  assert.equal(r3.status, 409); assert.equal(r3.body.code, "pd_reauth");
  assert.equal((await k2.json("/api/mail/signature", { method: "POST", body: { mode: "pegada", signature: "<b>otra</b>" } })).status, 409);
  assert.equal((await k2.json("/api/pipedrive/disconnect", { method: "POST", body: {} })).status, 409);
  // «Confirmá que sos vos» con el token de otra persona: no; con el suyo: sí
  assert.equal((await k2.json("/api/pipedrive/connect", { method: "POST", body: { token: ME } })).status, 403);
  assert.equal((await k2.json("/api/pipedrive/mail")).body.verified, false);
  assert.equal((await k2.json("/api/pipedrive/connect", { method: "POST", body: { token: DEMO } })).body.verified, true);
  assert.equal((await k2.json(`/api/schools/${s.id}/mail`, { method: "POST", body: { ...body, key: key() } })).status, 200);
  assert.equal(F.drafts.length, drafts + 2);
  // «no sé si salió»: la clave no se libera (un segundo intento con la misma clave no manda)
  F.sendMode = "500"; const k3 = key();
  const r4 = await quiet(() => j.json(`/api/schools/${s.id}/mail`, { method: "POST", body: { ...body, key: k3 } }));
  F.sendMode = "ok";
  assert.equal(r4.status, 502); assert.equal(r4.body.code, "pd_unknown");
  assert.equal((await j.json(`/api/schools/${s.id}/mail`, { method: "POST", body: { ...body, key: k3 } })).body.code, "mail_dup");
  // Pipedrive dijo que no (adentro del resultado): la clave se libera y se puede reintentar con la misma
  F.sendMode = "error"; const k4 = key();
  const r5 = await j.json(`/api/schools/${s.id}/mail`, { method: "POST", body: { ...body, key: k4 } });
  F.sendMode = "ok";
  assert.equal(r5.status, 502); assert.equal(r5.body.code, "pd_tool");
  assert.equal((await j.json(`/api/schools/${s.id}/mail`, { method: "POST", body: { ...body, key: k4 } })).status, 200);
  // el token se cambió en Pipedrive: 409 pd_revoked, se desconecta y el estado pide conectar de nuevo
  F.dead.add(DEMO);
  const r6 = await j.json(`/api/schools/${s.id}/mail`, { method: "POST", body: { ...body, key: key() } });
  F.dead.delete(DEMO);
  assert.equal(r6.status, 409); assert.equal(r6.body.code, "pd_revoked");
  assert.equal((await j.json("/api/pipedrive/mail")).body.connected, false);
});
test("rutas: sin Pipedrive conectado, pedir via pipedrive da pd_missing; desconectar vuelve a «sin conectar»", async () => {
  const j = jar(); await login(j);
  assert.equal((await j.json("/api/pipedrive/connect", { method: "POST", body: { token: DEMO } })).status, 200);
  assert.equal((await j.json("/api/pipedrive/disconnect", { method: "POST", body: {} })).body.connected, false);
  const s = await newSchool(14);
  const r = await j.json(`/api/schools/${s.id}/mail`, { method: "POST", body: { to: "a@b.co", subject: "x", text: "y", key: "k" + crypto.randomBytes(8).toString("hex"), via: "pipedrive" } });
  assert.equal(r.status, 409); assert.equal(r.body.code, "pd_missing");
});
