// Mail desde la ficha: lo puro de lib/gmail.js (validación, MIME, RFC 2047, HTML, firma, cifrado, state) y el envío con el
// Pipedrive de prueba y Gmail simulado (sales.sendMail / mailNext): actividad, nota, próximo paso, contacto y dueño.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
for (const k of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "PIPEDRIVE_API_TOKEN", "ANTHROPIC_API_KEY", "PIPEDRIVE_SMART_BCC", "GOOGLE_CLIENT_SECRET"]) delete process.env[k];
process.env.DEMO_MODE = "1";
process.env.SESSION_SECRET = "clave-de-prueba";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ob-test-"));
const G = await import("../lib/gmail.js");
const sales = await import("../lib/sales.js");
const pd = await import("../lib/pipedrive.js");
const { schools, setMatch, getMatch, touchesFor, mailsFor } = await import("../lib/store.js");
const { writesPipedrive } = await import("../lib/readonly.js");

// ---------- validación
test("validateMail: arma lo que se manda (email en minúscula, asunto en una línea, sin espacios al final)", () => {
  assert.deepEqual(G.validateMail({ to: " Ana@Colegio.EDU.mx ", subject: "Hola\r\nBcc: x@y.com", text: "Hola,\r\n\r\nTe escribo.\n\n  " }), { to: "ana@colegio.edu.mx", subject: "Hola Bcc: x@y.com", text: "Hola,\n\nTe escribo." });
});
test("validateMail: email, asunto, cuerpo y corchetes sin completar", () => {
  assert.match(G.validateMail({ to: "", subject: "a", text: "b" }).error, /a quién/);
  for (const to of ["mal@", "a@b", "a b@c.com", "a@b.com, c@d.com", "x@y.com\nBcc: z@w.com", "<a@b.com>"]) assert.match(G.validateMail({ to, subject: "a", text: "b" }).error, /no parece válido/, to);
  assert.match(G.validateMail({ to: "a@b.co", subject: " ", text: "b" }).error, /asunto/);
  assert.match(G.validateMail({ to: "a@b.co", subject: "a", text: " \n " }).error, /vacío/);
  assert.match(G.validateMail({ to: "a@b.co", subject: "Demo el [día]", text: "b" }).error, /corchetes/);
  assert.match(G.validateMail({ to: "a@b.co", subject: "a", text: "Nos vemos a las [hora]. [tu nombre]" }).error, /corchetes/);
  assert.match(G.validateMail({ to: "a@b.co", subject: "x".repeat(201), text: "b" }).error, /largo/);
  assert.equal(G.validateMail({ to: "a@b.co", subject: "a", text: "Lista: [1] y [2]" }).error, undefined); // otros corchetes sí
});

// ---------- encabezados (RFC 2047) y MIME
test("encodeHeader: ASCII queda igual; con acentos va en palabras UTF-8 de hasta 75 caracteres que no cortan letras", () => {
  assert.equal(G.encodeHeader("Demo OrderEAT"), "Demo OrderEAT");
  const s = "OrderEAT para la cafetería del Colegio Señora de Guadalupe · ¿lo vemos el miércoles? 🍎 ñandú";
  const enc = G.encodeHeader(s), words = enc.split("\r\n ");
  assert.ok(words.length > 1);
  for (const w of words) { assert.match(w, /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/); assert.ok(w.length <= 75, w); assert.ok(!Buffer.from(w.slice(10, -2), "base64").toString("utf8").includes("�")); }
  assert.equal(G.decodeHeader(enc), s);
  assert.equal(G.encodeHeader("a\r\nBcc: x"), "a Bcc: x"); // sin saltos (no se inyectan encabezados)
  assert.match(G.encodeHeader("=?raro?="), /^=\?UTF-8\?B\?/); // ASCII que parece palabra codificada: se codifica
});
test("addressHeader: nombre entre comillas o codificado; sin nombre, solo la dirección", () => {
  assert.equal(G.addressHeader("Juan Diego", "jd@ordereat.com"), '"Juan Diego" <jd@ordereat.com>');
  assert.equal(G.addressHeader('Ana "la" <x>', "a@ordereat.com"), '"Ana  la   x" <a@ordereat.com>');
  assert.match(G.addressHeader("Juan Pérez", "j@ordereat.com"), /^=\?UTF-8\?B\?.+\?= <j@ordereat.com>$/);
  assert.equal(G.addressHeader("", "j@ordereat.com"), "<j@ordereat.com>");
});
test("buildMime: multipart/alternative con texto y HTML en UTF-8 (base64), CRLF, Bcc solo si hay", () => {
  const body = G.mailBody("Hola Ana,\n\nTe escribo por la cafetería <b>escolar</b> & más.\nhttps://ordereat.com/colegios.\n\nSaludos,", "<b>Juan</b><br>SDR · OrderEAT");
  const mime = G.buildMime({ from: "jd@ordereat.com", fromName: "Juan Pérez", to: "ana@colegio.edu.mx", bcc: "123@pipedrivemail.com", subject: "Cafetería · ñandú", text: body.text, html: body.html, date: new Date("2026-11-10T14:05:00Z"), boundary: "B1" });
  assert.ok(!/[^\r]\n/.test(mime), "todas las líneas terminan en CRLF");
  assert.ok(mime.split("\r\n").every(l => l.length <= 998));
  const m = G.parseMime(mime);
  assert.equal(m.headers.to, "ana@colegio.edu.mx");
  assert.equal(m.headers.bcc, "123@pipedrivemail.com");
  assert.equal(m.headers["mime-version"], "1.0");
  assert.equal(m.headers.date, "Tue, 10 Nov 2026 14:05:00 +0000");
  assert.equal(G.decodeHeader(m.headers.from), "Juan Pérez <jd@ordereat.com>");
  assert.equal(m.subject, "Cafetería · ñandú");
  assert.match(mime, /Content-Type: multipart\/alternative; boundary="B1"/);
  assert.match(mime, /Content-Type: text\/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: base64/);
  assert.match(m.text, /^Hola Ana,\n\nTe escribo por la cafetería <b>escolar<\/b> & más\.\n/);
  assert.match(m.text, /Saludos,\n\nJuan\nSDR · OrderEAT\n$/); // la firma, en texto
  assert.match(m.html, /Te escribo por la cafetería &lt;b&gt;escolar&lt;\/b&gt; &amp; más\.<br>/);
  assert.match(m.html, /<a href="https:\/\/ordereat\.com\/colegios">https:\/\/ordereat\.com\/colegios<\/a>\.<br>/); // el punto final no entra en el link
  assert.match(m.html, /<div class="gmail_signature"[^>]*><b>Juan<\/b><br>SDR · OrderEAT<\/div>/);
  assert.ok(!/^Bcc:/m.test(G.buildMime({ from: "a@b.co", to: "c@d.co", subject: "x", text: "y", html: "y" })));
});
test("b64url: base64 para la API de Gmail (sin + / =)", () => {
  const raw = G.b64url("Asunto: ¿ñ?\r\n>>>???");
  assert.match(raw, /^[A-Za-z0-9_-]+$/);
  assert.equal(Buffer.from(raw, "base64url").toString("utf8"), "Asunto: ¿ñ?\r\n>>>???");
});
test("textToHtml y htmlToText", () => {
  assert.equal(G.textToHtml('a < b & "c"\nd'), "a &lt; b &amp; &quot;c&quot;<br>\nd");
  assert.equal(G.textToHtml("javascript:alert(1) http://x.co/a?b=1&c=2"), 'javascript:alert(1) <a href="http://x.co/a?b=1&amp;c=2">http://x.co/a?b=1&amp;c=2</a>');
  assert.equal(G.htmlToText('<div dir="ltr"><div>Ana Ruiz</div><div>SDR</div></div>'), "Ana Ruiz\nSDR");
  assert.equal(G.htmlToText('<b>Juan</b><br>Tel: 55&nbsp;1234<div><a href="https://ordereat.com">Web</a></div><a href="mailto:j@o.com">j@o.com</a>'), "Juan\nTel: 55 1234\nWeb (https://ordereat.com)\nj@o.com");
});

// ---------- firma saneada
test("sanitizeSignature: texto pegado → escapado y con saltos de línea", () => {
  assert.equal(G.sanitizeSignature("Juan Pérez · SDR\n+52 55 1234 & OrderEAT"), "Juan Pérez · SDR<br>+52 55 1234 &amp; OrderEAT");
  assert.equal(G.sanitizeSignature("  "), "");
});
test("sanitizeSignature: fuera scripts, estilos, eventos, javascript:, imágenes sin https y etiquetas raras", () => {
  const h = G.sanitizeSignature(`<div style="color:#333;position:fixed;background:url(https://x/y.png);font-size:13px" onclick="x()"><b onmouseover=alert(1)>Juan</b><script>alert("x")</script><style>body{display:none}</style>
    <a href="javascript:alert(1)">mal</a> <a href="&#106;avascript:alert(1)">mal2</a> <a href="https://ordereat.com" target="_top" onclick="y()">web</a> <a href="mailto:j@ordereat.com">mail</a>
    <img src="http://x.co/a.png"> <img src="https://x.co/logo.png" width="120" onerror="z()" alt="Logo"> <iframe src="https://x.co">adentro</iframe><custom-tag>queda el texto</custom-tag><svg><script>1</script></svg>`);
  assert.ok(!/script|onclick|onmouseover|onerror|javascript|iframe|adentro|position|url\(|<style|display:none|http:\/\/x\.co|custom-tag|<svg/i.test(h), h);
  assert.match(h, /^<div style="color:#333;font-size:13px"><b>Juan<\/b>/);
  assert.match(h, /<a>mal<\/a> <a>mal2<\/a> <a href="https:\/\/ordereat\.com" target="_blank" rel="noopener noreferrer">web<\/a> <a href="mailto:j@ordereat\.com" target="_blank" rel="noopener noreferrer">mail<\/a>/);
  assert.match(h, /<img src="https:\/\/x\.co\/logo\.png" width="120" alt="Logo">/);
  assert.match(h, /queda el texto/);
  assert.match(h, /<\/div>$/); // lo que quedó abierto se cierra
});
test("sanitizeSignature: tablas y fuentes de firmas de Gmail; entidades válidas quedan, & suelto se escapa", () => {
  const h = G.sanitizeSignature('<table cellpadding="0" style="border-collapse:collapse"><tr><td valign="top" width="80"><font color="#E0153F" face="Arial" size="2">Ana&nbsp;Ruiz &amp; equipo & más</font></td></tr></table><!-- comentario --><p>fin');
  assert.equal(h, '<table cellpadding="0" style="border-collapse:collapse"><tr><td valign="top" width="80"><font color="#E0153F" face="Arial" size="2">Ana&nbsp;Ruiz &amp; equipo &amp; más</font></td></tr></table><p>fin</p>');
  assert.equal(G.sanitizeSignature("<b>a<i>b</b>c"), "<b>a<i>b</i></b>c");
  assert.equal(G.sanitizeSignature("</div>sola"), "sola");
});

// ---------- cifrado del refresh token
test("encrypt/decrypt: AES-256-GCM con clave de SESSION_SECRET; otra clave o alterado → null", () => {
  const a = G.encrypt("1//refresh-token-secreto", "s1"), b = G.encrypt("1//refresh-token-secreto", "s1");
  assert.match(a, /^v1\.[A-Za-z0-9_-]+$/);
  assert.notEqual(a, b); // IV al azar
  assert.ok(!a.includes("refresh"));
  assert.equal(G.decrypt(a, "s1"), "1//refresh-token-secreto");
  assert.equal(G.decrypt(a, "s2"), null);
  const raw = Buffer.from(a.slice(3), "base64url"); raw[raw.length - 1] ^= 1;
  assert.equal(G.decrypt("v1." + raw.toString("base64url"), "s1"), null);
  assert.equal(G.decrypt("basura", "s1"), null);
  assert.equal(G.decrypt("v1.abc", "s1"), null);
  assert.throws(() => G.encrypt("x", ""), /SESSION_SECRET/);
});

// ---------- state del OAuth
test("signState/verifyState: firmado, atado al email y al nonce de la sesión, vence a los 10 minutos", () => {
  const now = 1_800_000_000_000, st = G.signState({ email: "JD@ordereat.com", nonce: "n1", at: now }, "k");
  assert.deepEqual(G.verifyState(st, { email: "jd@ordereat.com", nonce: "n1", now: now + 60e3 }, "k"), { ok: true });
  assert.equal(G.verifyState(st, { email: "otro@ordereat.com", nonce: "n1", now }, "k").why, "otra persona");
  assert.equal(G.verifyState(st, { email: "jd@ordereat.com", nonce: "n2", now }, "k").why, "otra sesión");
  assert.equal(G.verifyState(st, { email: "jd@ordereat.com", nonce: undefined, now }, "k").why, "otra sesión");
  assert.equal(G.verifyState(st, { email: "jd@ordereat.com", nonce: "n1", now: now + 11 * 60e3 }, "k").why, "vencido");
  assert.equal(G.verifyState(st, { email: "jd@ordereat.com", nonce: "n1", now }, "otra-clave").why, "state inválido");
  const [p, sig] = st.split("."), forged = Buffer.from(JSON.stringify({ e: "otro@ordereat.com", n: "n1", t: now })).toString("base64url");
  assert.equal(G.verifyState(`${forged}.${sig}`, { email: "otro@ordereat.com", nonce: "n1", now }, "k").why, "state inválido");
  for (const bad of ["", "a", "a.b.c", `${p}.`, `${p}.${sig}x`]) assert.equal(G.verifyState(bad, { email: "jd@ordereat.com", nonce: "n1", now }, "k").ok, false);
});
test("primarySendAs y sameAccount", () => {
  assert.equal(G.primarySendAs([{ sendAsEmail: "alias@ordereat.com" }, { sendAsEmail: "jd@ordereat.com", isPrimary: true }]).sendAsEmail, "jd@ordereat.com");
  assert.equal(G.primarySendAs([]), null);
  assert.ok(G.sameAccount(" JD@ordereat.com", "jd@ordereat.com"));
  assert.ok(!G.sameAccount("", ""));
  assert.ok(!G.sameAccount("jd@gmail.com", "jd@ordereat.com"));
});
test("READ_ONLY: enviar y el próximo paso del mail no pasan", () => {
  assert.ok(writesPipedrive("POST", "/api/schools/abc/mail"));
  assert.ok(writesPipedrive("POST", "/api/schools/abc/Mail/next"));
  assert.ok(!writesPipedrive("GET", "/api/gmail"));
});

// ---------- Gmail simulado (demo) y el envío con el Pipedrive de prueba
const me = { email: "jd@ordereat.com", name: "Juan Diego", pdUserId: 2 };
test("demo: conectar con otra cuenta se rechaza; con la propia queda conectado, con firma de ejemplo y sin token a la vista", async () => {
  await assert.rejects(G.finishConnect({ email: me.email, demoAs: "otro@ordereat.com" }), e => e.code === "gmail_mismatch" && e.status === 403);
  assert.equal((await G.status(me.email)).connected, false);
  await G.finishConnect({ email: me.email });
  const st = await G.status(me.email, "Juan Diego");
  assert.equal(st.connected, true); assert.equal(st.email, me.email); assert.equal(st.signatureSource, "gmail");
  assert.ok(!JSON.stringify(st).includes("refresh"));
  const stored = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, "gmail.json"), "utf8"))[me.email];
  assert.ok(!JSON.stringify(stored).includes("demo-refresh-token")); // guardado cifrado
  assert.equal((fs.statSync(path.join(process.env.DATA_DIR, "gmail.json")).mode & 0o077), 0);
});
test("demo: send guarda el MIME en la bandeja simulada; Smart BCC si está configurado; la firma del perfil manda", async () => {
  process.env.PIPEDRIVE_SMART_BCC = "ordereat@pipedrivemail.com";
  const { setMailPrefs } = await import("../lib/store.js");
  await setMailPrefs(me.email, { signature: G.sanitizeSignature("Juan Diego · SDR\nOrderEAT") });
  const r = await G.send(me.email, { to: "ana@colegio.edu.mx", subject: "Prueba · ñ", text: "Hola", fromName: "Juan Diego" });
  assert.equal(r.bcc, true); assert.equal(r.signature, "perfil");
  const m = G.parseMime(G.demoOutbox()[0].mime);
  assert.equal(m.headers.bcc, "ordereat@pipedrivemail.com"); assert.equal(m.subject, "Prueba · ñ");
  assert.equal(m.text, "Hola\n\nJuan Diego · SDR\nOrderEAT\n");
  await setMailPrefs(me.email, { signature: "" });
  delete process.env.PIPEDRIVE_SMART_BCC;
  await assert.rejects(G.send("nadie@ordereat.com", { to: "a@b.co", subject: "x", text: "y" }), e => e.code === "gmail_missing");
});

// un colegio nuevo (nunca contactado) del Pipedrive de prueba
async function newSchool(skip = 0) {
  let n = 0;
  // nuevo de verdad: tampoco aparece nada parecido en Pipedrive (la investigación antes de crear no encuentra nada)
  for (const s of schools.filter(x => x.country === "México")) { const r = await sales.checkSchool(s.id); if (r.status === "new" && (await sales.investigate(s.id)).r.verdict === "none" && n++ >= skip) return s; }
  throw new Error("no hay colegios nuevos en el demo");
}
const fakeSend = () => { const calls = []; const send = async m => { calls.push(m); return { id: `msg-${calls.length}-${Date.now()}`, threadId: "t", from: me.email, bcc: false, signature: "gmail" }; }; return { calls, send }; };

test("sendMail: colegio nuevo → org a tu nombre, actividad «Mail» hecha con asunto y cuerpo, nota, llamada automática, un contacto y el mail para Historial", async () => {
  const s = await newSchool(), f = fakeSend();
  const r = await sales.sendMail(s.id, me, { to: "Direccion@Colegio.edu.mx", subject: "OrderEAT para la cafetería", text: "Hola,\n\n<b>Te escribo</b> por la cafetería." }, "America/Mexico_City", { send: f.send, by: "Juan Diego Pérez" });
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].to, "direccion@colegio.edu.mx");
  assert.equal(r.ok, true);
  const m = getMatch(s.id); assert.ok(m.orgId); assert.equal(m.confirmed, true);
  const acts = [...await pd.activities({ orgId: m.orgId, done: true, limit: 20 }), ...await pd.activities({ orgId: m.orgId, done: false, limit: 20 })];
  const mail = acts.find(a => a.type === "task");
  assert.equal(mail.done, true); assert.equal(mail.owner_id, 2);
  assert.equal(mail.subject, `Mail: OrderEAT para la cafetería · ${s.name}`);
  assert.match(mail.note, /<b>Para:<\/b> direccion@colegio\.edu\.mx<br><b>Asunto:<\/b> OrderEAT para la cafetería<br><br>Hola,<br><br>&lt;b&gt;Te escribo&lt;\/b&gt; por la cafetería\./);
  const call = acts.find(a => a.type === "call" && !a.done);
  assert.ok(call); assert.equal(call.owner_id, 2); assert.deepEqual(r.mail.autoNext, { id: call.id, type: "call", date: call.due_date, time: "" });
  assert.deepEqual(r.logged, { pipedrive: true, history: true });
  // sin trato ni prospecto: el mail queda en un prospecto nuevo a tu nombre (con la organización), que se enriquece
  const notes = (await pd.notesForOrg(m.orgId, 10)).filter(n => /^<b>Mail enviado/.test(n.content));
  assert.equal(notes.length, 1);
  assert.match(notes[0].content, /^<b>Mail enviado<\/b> a direccion@colegio\.edu\.mx<br><b>Asunto:<\/b> OrderEAT para la cafetería<br><br>Hola,/);
  assert.match(notes[0].content, /Enviado por Juan Diego Pérez desde OrderBrain SDR/);
  assert.ok(mail.lead_id); assert.equal(notes[0].lead_id, mail.lead_id); assert.equal(call.lead_id, mail.lead_id);
  assert.equal(r.where.kind, "lead"); assert.equal(r.where.created, true); assert.equal(r.lead.id, mail.lead_id);
  const t = touchesFor(s.id); assert.equal(t.length, 1);
  assert.deepEqual([t[0].outcome, t[0].channel, t[0].mailId, t[0].connected], ["sent", "mail", r.mail.id, false]);
  const ml = await mailsFor(s.id); assert.equal(ml.length, 1); assert.match(ml[0].body, /<b>Te escribo<\/b>/);
  const d = await sales.schoolDetail(s.id, { user: me, tz: "America/Mexico_City" });
  assert.equal(d.mails.length, 1); assert.equal(d.mails[0].subject, "OrderEAT para la cafetería");
  assert.equal(d.touches[0].outcome, "Mail enviado"); assert.equal(d.touches[0].mailId, r.mail.id);
  assert.equal(r.suggest.date, call.due_date);

  // próximo paso: cambia la llamada automática (no crea otra) y no se guarda dos veces
  const n = await sales.mailNext(s.id, me, { mailId: r.mail.id, next: { type: "task", date: "2026-12-01", time: "10:00" } }, "America/Mexico_City");
  assert.match(n.done[0].label, /cambié la llamada automática/);
  const pend = await pd.activities({ orgId: m.orgId, done: false, limit: 20 });
  assert.equal(pend.length, 1); assert.equal(pend[0].id, call.id); assert.equal(pend[0].type, "task"); assert.equal(pend[0].due_date, "2026-12-01"); assert.equal(pend[0].due_time, "16:00");
  await assert.rejects(sales.mailNext(s.id, me, { mailId: r.mail.id, next: null }, "America/Mexico_City"), e => e.status === 409);
  await assert.rejects(sales.mailNext(s.id, { ...me, email: "otro@ordereat.com" }, { mailId: r.mail.id }, "America/Mexico_City"), e => e.status === 404);
});
test("sendMail: el segundo mail al mismo colegio no agenda otra llamada; con persona de la org, queda ligada", async () => {
  const s = await newSchool(1), f = fakeSend();
  await sales.sendMail(s.id, me, { to: "a@colegio.mx", subject: "Uno", text: "Hola" }, "America/Mexico_City", { send: f.send });
  const orgId = getMatch(s.id).orgId;
  const person = await pd.addPerson({ name: "Ana Directora", orgId, email: "Ana@Colegio.mx", ownerId: 2 });
  const r = await sales.sendMail(s.id, me, { to: "ana@colegio.mx", subject: "Dos", text: "Hola Ana" }, "America/Mexico_City", { send: f.send });
  assert.equal(r.mail.autoNext, null);
  assert.equal(r.suggest.type, "call");
  const acts = await pd.activities({ orgId, done: true, limit: 20 });
  assert.equal(acts.find(a => /Dos/.test(a.subject)).person_id, person.id);
  assert.equal((await pd.activities({ orgId, done: false, limit: 20 })).length, 1);
  assert.equal(touchesFor(s.id).length, 2);
});
test("sendMail: lo de otra persona, archivado, sin usuario o con corchetes no se manda (send no se llama)", async () => {
  const s = await newSchool(2), f = fakeSend();
  await sales.sendMail(s.id, me, { to: "a@colegio.mx", subject: "Mío", text: "Hola" }, "America/Mexico_City", { send: f.send });
  const otro = { email: "agustin@ordereat.com", name: "Agustín", pdUserId: 3 };
  await assert.rejects(sales.sendMail(s.id, otro, { to: "a@colegio.mx", subject: "x", text: "y" }, "America/Mexico_City", { send: f.send }), e => e.status === 409 && /es de/.test(e.message));
  await assert.rejects(sales.sendMail(s.id, { ...me, pdUserId: null }, { to: "a@colegio.mx", subject: "x", text: "y" }, "America/Mexico_City", { send: f.send }), e => e.status === 403);
  await assert.rejects(sales.sendMail(s.id, me, { to: "a@colegio.mx", subject: "x", text: "El [día]" }, "America/Mexico_City", { send: f.send }), e => e.status === 400);
  const { setArchived } = await import("../lib/store.js");
  await setArchived(s.id, { by: me.email, byName: "JD", at: new Date().toISOString(), reason: "Otro", text: "" });
  await assert.rejects(sales.sendMail(s.id, me, { to: "a@colegio.mx", subject: "x", text: "y" }, "America/Mexico_City", { send: f.send }), e => e.status === 409 && /archivado/.test(e.message));
  await setArchived(s.id, null);
  assert.equal(f.calls.length, 1);
});
test("sendMail: lo que falla después de mandar no tira error (el mail ya salió): avisa y la tarea «Mail» de la agenda se marca hecha", async () => {
  const s = await newSchool(3), f = fakeSend();
  await sales.sendMail(s.id, me, { to: "a@colegio.mx", subject: "Uno", text: "Hola" }, "America/Mexico_City", { send: f.send });
  const orgId = getMatch(s.id).orgId;
  const task = await pd.addActivity({ subject: "Mail · seguimiento", type: "task", dueDate: "2026-11-10", orgId, ownerId: 2 });
  const ok = await sales.sendMail(s.id, me, { to: "a@colegio.mx", subject: "Dos", text: "Hola", completeActivityId: task.id }, "America/Mexico_City", { send: f.send });
  assert.ok(ok.done.some(x => x.label === "Actividad pendiente marcada como hecha"));
  assert.equal((await pd.getActivity(task.id)).done, true);
  const r = await sales.sendMail(s.id, me, { to: "a@colegio.mx", subject: "Tres", text: "Hola", completeActivityId: 99999999 }, "America/Mexico_City", { send: f.send });
  assert.equal(r.ok, true);
  assert.ok(r.done.some(x => x.warn && /No pude marcar la actividad/.test(x.label)));
  assert.equal((await mailsFor(s.id)).length, 3);
});
test("logContact: «Mail enviado» no se elige a mano en Registrar", async () => {
  const s = await newSchool(4);
  await assert.rejects(sales.logContact(s.id, me, { outcome: "sent", channel: "mail" }, "America/Mexico_City"), e => e.status === 400 && /Elegí qué pasó/.test(e.message));
});
test("mailActivitySubject: no repite el colegio si el asunto ya lo nombra", () => {
  assert.equal(sales.mailActivitySubject("Demo OrderEAT · Colegio Lincoln", "Colegio Lincoln"), "Mail: Demo OrderEAT · Colegio Lincoln");
  assert.equal(sales.mailActivitySubject("Info", "Colegio Lincoln"), "Mail: Info · Colegio Lincoln");
  assert.ok(sales.mailActivitySubject("x".repeat(240), "Colegio Lincoln").length <= 250);
});

// ---------- Google simulado con fetch (sin red): refresh, envío incierto y casilla equivocada
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
async function withFetch(fake, fn) {
  const real = globalThis.fetch, errs = console.error, warns = console.warn;
  globalThis.fetch = fake; console.error = () => {}; console.warn = () => {};
  try { return await fn(); } finally { globalThis.fetch = real; console.error = errs; console.warn = warns; }
}
test("refresh: invalid_client es configuración (500, no borra la conexión de nadie); solo invalid_grant la borra", async () => {
  const { setGmail, getGmail } = await import("../lib/store.js");
  const email = "cfg@ordereat.com"; await setGmail(email, { enc: G.encrypt("rt-cfg"), email });
  const calls = [];
  await withFetch(async url => { calls.push(String(url)); return json({ error: "invalid_client", error_description: "Unauthorized" }, 401); }, async () => {
    const st = await G.status(email);
    assert.equal(st.connected, true); assert.equal(st.config, true); assert.equal(st.expired, undefined);
    assert.ok(await getGmail(email), "la conexión sigue guardada");
    await assert.rejects(G.send(email, { to: "a@b.co", subject: "x", text: "y" }), e => e.code === "gmail_config" && e.status === 500 && /mal configurado/.test(e.message));
    assert.ok(await getGmail(email));
  });
  assert.ok(calls.every(u => u === "https://oauth2.googleapis.com/token"));
  for (const error of ["unauthorized_client", "deleted_client"]) await withFetch(async () => json({ error }, 400), async () => assert.equal((await G.status(email)).config, true));
  await withFetch(async () => json({ error: "invalid_grant" }, 400), async () => {
    const st = await G.status(email);
    assert.equal(st.connected, false); assert.equal(st.expired, true);
  });
  assert.equal(await getGmail(email), null);
});
test("send: sin respuesta de Gmail (tiempo, red o 5xx) queda sent='maybe' (no se libera la clave); con 4xx no salió", async () => {
  const { setGmail } = await import("../lib/store.js");
  const email = "snd@ordereat.com"; await setGmail(email, { enc: G.encrypt("rt-snd"), email });
  let posts = 0, mode = "timeout";
  await withFetch(async url => {
    url = String(url);
    if (url === "https://oauth2.googleapis.com/token") return json({ access_token: "at-1", expires_in: 3600 });
    if (url.endsWith("/settings/sendAs")) return json({ sendAs: [{ sendAsEmail: email, isPrimary: true, signature: "<b>Firma</b>" }] });
    if (url.endsWith("/messages/send")) {
      posts++;
      if (mode === "timeout") throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
      if (mode === "red") throw new TypeError("fetch failed");
      if (mode === "500") return json({ error: { message: "Backend Error" } }, 500);
      if (mode === "400") return json({ error: { message: "Invalid To header" } }, 400);
      if (mode === "429") return json({ error: { message: "Rate limit" } }, 429);
      return json({ id: "m-ok", threadId: "t-ok" });
    }
    throw new Error("url inesperada " + url);
  }, async () => {
    for (mode of ["timeout", "red", "500"]) await assert.rejects(G.send(email, { to: "a@b.co", subject: "x", text: "y" }), e => e.sent === "maybe" && e.code === "gmail_unknown" && e.message === G.UNKNOWN_MSG, mode);
    for (mode of ["400", "429"]) await assert.rejects(G.send(email, { to: "a@b.co", subject: "x", text: "y" }), e => !e.sent && e.httpStatus === Number(mode), mode);
    mode = "ok"; const r = await G.send(email, { to: "a@b.co", subject: "x", text: "y" });
    assert.equal(r.id, "m-ok"); assert.equal(r.signature, "gmail");
  });
  assert.equal(posts, 6);
});
test("send: si la casilla de Gmail no es la de la sesión, no manda (no hay POST a messages/send)", async () => {
  const { setGmail } = await import("../lib/store.js");
  const email = "mis@ordereat.com"; await setGmail(email, { enc: G.encrypt("rt-mis"), email });
  let posts = 0;
  await withFetch(async url => {
    url = String(url);
    if (url === "https://oauth2.googleapis.com/token") return json({ access_token: "at-2", expires_in: 3600 });
    if (url.endsWith("/settings/sendAs")) return json({ sendAs: [{ sendAsEmail: "otro@ordereat.com", isPrimary: true }] });
    if (url.endsWith("/messages/send")) { posts++; return json({ id: "x" }); }
    throw new Error("url inesperada " + url);
  }, async () => assert.rejects(G.send(email, { to: "a@b.co", subject: "x", text: "y" }), e => e.code === "gmail_mismatch"));
  assert.equal(posts, 0);
});
test("sendOutcome: 4xx pasa tal cual; sin estado o 5xx es «no sé si salió»", () => {
  const e4 = Object.assign(new Error("x"), { httpStatus: 403 });
  assert.equal(G.sendOutcome(e4), e4);
  assert.equal(G.sendOutcome(Object.assign(new Error("x"), { httpStatus: 503 })).sent, "maybe");
  assert.equal(G.sendOutcome(new Error("socket hang up")).sent, "maybe");
});

// ---------- prospectos: dueño al día y sin saberlo no se manda
test("sendMail en un prospecto: si Pipedrive no responde o el prospecto ya no está, no se manda; si es de otra persona, tampoco", async () => {
  const { addVirtual } = await import("../lib/store.js");
  const mk = (id, leadId) => addVirtual({ id, leadOnly: true, leadId, virtual: true, name: `Prospecto ${id}`, country: "México", city: "Puebla" });
  const f = fakeSend();
  mk("pd-lead-caido", "demo-lead-caido"); mk("pd-lead-borrado", "demo-lead-no-existe"); mk("pd-lead-otro", "demo-lead-otro");
  await assert.rejects(sales.sendMail("pd-lead-caido", me, { to: "a@colegio.mx", subject: "x", text: "y" }, "America/Mexico_City", { send: f.send }), e => e.status === 503 && /de quién es el prospecto/.test(e.message));
  await assert.rejects(sales.sendMail("pd-lead-borrado", me, { to: "a@colegio.mx", subject: "x", text: "y" }, "America/Mexico_City", { send: f.send }), e => e.status === 404 && /ya no está/.test(e.message));
  await assert.rejects(sales.sendMail("pd-lead-otro", { ...me, pdUserId: 3 }, { to: "a@colegio.mx", subject: "x", text: "y" }, "America/Mexico_City", { send: f.send }), e => e.status === 409 && /El prospecto es de/.test(e.message));
  assert.equal(f.calls.length, 0);
  // el chequeo previo del modal da lo mismo, sin escribir nada
  await assert.rejects(sales.mailGuard("pd-lead-otro", { ...me, pdUserId: 3 }), e => e.status === 409);
  const ok = await sales.mailGuard("pd-lead-otro", me); assert.equal(ok.lead.ownerId, 2);
});

// ---------- próximo paso: siempre queda algo, sin duplicar
test("sendMail: colegio ya tuyo sin nada pendiente → llamada automática en 2 días hábiles; guardar lo mismo no la toca", async () => {
  const s = await newSchool(5), f = fakeSend(), tz = "America/Mexico_City";
  const r1 = await sales.sendMail(s.id, me, { to: "a@colegio.mx", subject: "Uno", text: "Hola" }, tz, { send: f.send });
  const orgId = getMatch(s.id).orgId;
  await pd.updateActivity(r1.mail.autoNext.id, { done: true }); // la llamada del primer mail ya se hizo
  const { todayIn, addBusinessDays } = await import("../lib/time.js");
  const r = await sales.sendMail(s.id, me, { to: "a@colegio.mx", subject: "Dos", text: "Hola de nuevo" }, tz, { send: f.send });
  assert.ok(r.mail.autoNext); assert.equal(r.mail.pendingNext, null);
  assert.equal(r.mail.autoNext.date, addBusinessDays(todayIn(tz), 2));
  const pend = await pd.activities({ orgId, done: false, limit: 20 });
  assert.equal(pend.length, 1); assert.equal(pend[0].id, r.mail.autoNext.id);
  const before = JSON.stringify(await pd.getActivity(r.mail.autoNext.id));
  const n = await sales.mailNext(s.id, me, { mailId: r.mail.id, next: { type: "call", date: r.mail.autoNext.date, time: "" } }, tz);
  assert.match(n.done[0].label, /^Queda la llamada automática del /);
  assert.ok(!/cambié/.test(n.done[0].label));
  assert.equal(JSON.stringify(await pd.getActivity(r.mail.autoNext.id)), before, "no se tocó");
});
test("sendMail: con una actividad tuya pendiente no crea otra; mailNext la mueve, o la marca hecha y crea la próxima", async () => {
  const s = await newSchool(6), f = fakeSend(), tz = "America/Mexico_City";
  const r1 = await sales.sendMail(s.id, me, { to: "a@colegio.mx", subject: "Uno", text: "Hola" }, tz, { send: f.send });
  const orgId = getMatch(s.id).orgId, callId = r1.mail.autoNext.id;
  const r2 = await sales.sendMail(s.id, me, { to: "a@colegio.mx", subject: "Dos", text: "Hola" }, tz, { send: f.send });
  assert.equal(r2.mail.autoNext, null); assert.equal(r2.mail.pendingNext.id, callId); assert.equal(r2.suggest.id, callId);
  assert.match(r2.suggest.why, /Ya tenés una llamada/);
  assert.equal((await pd.activities({ orgId, done: false, limit: 20 })).length, 1);
  // la mueve (no crea otra)
  const n2 = await sales.mailNext(s.id, me, { mailId: r2.mail.id, next: { type: "call", date: "2026-12-03", time: "" }, moveActivityId: callId }, tz);
  assert.match(n2.done[0].label, /moví la que ya tenías/);
  let pend = await pd.activities({ orgId, done: false, limit: 20 });
  assert.deepEqual(pend.map(a => [a.id, a.due_date]), [[callId, "2026-12-03"]]);
  // la ficha abierta desde esa llamada: se marca hecha y queda una nueva
  const r3 = await sales.sendMail(s.id, me, { to: "a@colegio.mx", subject: "Tres", text: "Hola" }, tz, { send: f.send });
  assert.equal(r3.mail.pendingNext.id, callId);
  const n3 = await sales.mailNext(s.id, me, { mailId: r3.mail.id, next: { type: "call", date: "2026-12-07", time: "11:00" }, completeActivityId: callId }, tz);
  assert.ok(n3.done.some(x => /marcada como hecha/.test(x.label)));
  assert.equal((await pd.getActivity(callId)).done, true);
  pend = await pd.activities({ orgId, done: false, limit: 20 });
  assert.equal(pend.length, 1); assert.notEqual(pend[0].id, callId); assert.equal(pend[0].due_date, "2026-12-07");
});
