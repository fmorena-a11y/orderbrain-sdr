// «Entrar con Google» en un solo paso (pedido del líder de SDR: «que automáticamente se conecte con el Calendar y el Drive
// cuando entre en su cuenta de Google»): el mismo OAuth con código de «Conectar Gmail», sin sesión todavía. Lo puro
// (lib/gid.js: id_token, permisos, dominio; el state de lib/gmail.js; los textos de public/js/googlefmt.js) y las rutas del
// servidor de punta a punta contra un Google falso local (test/fake-google.mjs) y el Pipedrive de prueba en memoria: sin red.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { fakeGoogle, ALL } from "./fake-google.mjs";
for (const k of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "PIPEDRIVE_API_TOKEN", "ANTHROPIC_API_KEY", "PIPEDRIVE_SMART_BCC", "READ_ONLY", "TEAM_ACCESS_CODE", "BRAIN_TOKEN", "GMAIL_REDIRECT_URI", "NODE_ENV"]) delete process.env[k];
const F = await fakeGoogle();
Object.assign(process.env, { DEMO_MODE: "1", SESSION_SECRET: "clave-de-prueba", VERCEL: "1", DEV_LOGIN_EMAIL: "demo@ordereat.com", ALLOWED_EMAIL_DOMAIN: "ordereat.com",
  GOOGLE_CLIENT_ID: F.clientId, GOOGLE_CLIENT_SECRET: F.clientSecret, GOOGLE_TEST_URL: F.base, DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "ob-glogin-")) });
const ID = await import("../lib/gid.js");
const G = await import("../lib/gmail.js");
const FMT = await import("../public/js/googlefmt.js");
const store = await import("../lib/store.js");
const { sheetsDirect } = await import("../lib/sheets-export.js");
const { googleSheetsReady } = await import("../lib/sheets.js");
const { default: app } = await import("../server.js");
const web = http.createServer(app);
await new Promise(r => web.listen(0, "127.0.0.1", r));
const APP = `http://127.0.0.1:${web.address().port}`;
after(async () => { web.closeAllConnections?.(); await new Promise(r => web.close(r)); await F.close(); });

const S = k => "https://www.googleapis.com/auth/" + k;
const quiet = async fn => { const w = console.warn, e = console.error; console.warn = console.error = () => {}; try { return await fn(); } finally { console.warn = w; console.error = e; } };
// un navegador de juguete: guarda las cookies de la app (y solo a la app se las manda) y no sigue redirecciones solo
function browser() {
  const jar = new Map();
  const go = async (url, opts = {}) => {
    const own = url.startsWith(APP), cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const r = await fetch(url, { redirect: "manual", ...opts, headers: { ...(opts.headers || {}), ...(own && cookie ? { cookie } : {}) } });
    if (own) for (const c of r.headers.getSetCookie()) { const kv = c.split(";")[0], i = kv.indexOf("="), k = kv.slice(0, i), v = kv.slice(i + 1); if (!v || /expires=Thu, 01 Jan 1970/i.test(c)) jar.delete(k); else jar.set(k, v); }
    return r;
  };
  // sigue las redirecciones (app → Google falso → app…) y devuelve dónde terminó y por dónde pasó
  const follow = async (url, max = 10) => {
    const hops = [url]; let r = await go(url);
    while ([301, 302, 303, 307].includes(r.status) && max-- > 0) { url = new URL(r.headers.get("location"), url).href; hops.push(url); r = await go(url); }
    return { r, url, hops };
  };
  const get = async p => { const r = await go(APP + p); return { status: r.status, body: await r.json().catch(() => null) }; };
  const post = async (p, body = {}) => { const r = await go(APP + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };
  return { jar, go, follow, get, post, copy: () => { const b = browser(); for (const [k, v] of jar) b.jar.set(k, v); return b; } };
}
const reset = (user = { email: "juandiego@ordereat.com", verified: true, name: "Juan Diego", hd: "ordereat.com" }) => {
  Object.assign(F, { user, untick: [], deny: false, refresh: "auto", idToken: "ok", tokenDown: false });
  F.authCalls.length = F.tokenCalls.length = F.revoked.length = F.apiCalls.length = 0;
};
const login = async (b = browser()) => ({ b, ...(await b.follow(`${APP}/auth/google/start`)) });
const tail = url => url.slice(APP.length);

// ---------- lo puro
const pair = () => crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwt = (payload, key, head = { alg: "RS256", kid: "k1" }) => { const e = o => Buffer.from(JSON.stringify(o)).toString("base64url"), d = `${e(head)}.${e(payload)}`; return `${d}.${crypto.sign("RSA-SHA256", Buffer.from(d), key).toString("base64url")}`; };
test("verifyIdToken: firma de Google (RS256), cliente, emisor, vencimiento y nonce; nada de eso se saltea", () => {
  const k = pair(), otra = pair(), keys = [{ ...k.publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" }];
  const now = Date.now(), sec = Math.floor(now / 1000);
  const p = { iss: "https://accounts.google.com", aud: "cid", azp: "cid", email: "Ana@OrderEAT.com", email_verified: true, nonce: "n1", iat: sec, exp: sec + 3600, hd: "ordereat.com", name: "Ana" };
  const ok = ID.verifyIdToken(jwt(p, k.privateKey), { keys, audience: "cid", nonce: "n1", now });
  assert.ok(ok.ok);
  assert.deepEqual(ID.identityOf(ok.payload), { email: "ana@ordereat.com", verified: true, name: "Ana", picture: "", hd: "ordereat.com" });
  const why = (payload, key = k.privateKey, opt = {}, head) => ID.verifyIdToken(jwt(payload, key, head), { keys, audience: "cid", nonce: "n1", now, ...opt }).why;
  assert.equal(why(p, otra.privateKey), "firma", "firmado con otra clave");
  assert.equal(why({ ...p, aud: "otro" }), "cliente", "era para otro cliente");
  assert.equal(why({ ...p, azp: "otro" }), "cliente");
  assert.equal(why({ ...p, aud: ["cid", "otro"] }), "cliente");
  assert.equal(why({ ...p, iss: "https://evil.example" }), "emisor");
  assert.equal(why({ ...p, exp: sec - 3600 }), "vencido");
  assert.equal(why({ ...p, iat: sec + 3600 }), "vencido", "emitido en el futuro");
  assert.equal(why({ ...p, nonce: "n2" }), "nonce", "es de otro ingreso");
  assert.equal(why(p, k.privateKey, {}, { alg: "none", kid: "k1" }), "algoritmo", "«alg: none» no pasa");
  assert.equal(ID.verifyIdToken(jwt(p, k.privateKey).split(".").slice(0, 2).join(".") + ".", { keys, audience: "cid", nonce: "n1", now }).ok, false, "sin firma no pasa");
  assert.equal(why(p, k.privateKey, {}, { alg: "HS256", kid: "k1" }), "algoritmo");
  assert.equal(why(p, k.privateKey, {}, { alg: "RS256", kid: "k9" }), "clave");
  assert.equal(why(p, k.privateKey, { audience: "" }), "cliente", "sin cliente configurado nada pasa");
  const t = jwt(p, k.privateKey).split(".");
  const cambiado = `${t[0]}.${Buffer.from(JSON.stringify({ ...p, email: "otro@ordereat.com" })).toString("base64url")}.${t[2]}`;
  assert.equal(ID.verifyIdToken(cambiado, { keys, audience: "cid", nonce: "n1", now }).why, "firma", "cambiar el email rompe la firma");
  for (const bad of ["", "a.b", "a.b.c.d", "..", null]) assert.equal(ID.verifyIdToken(bad, { keys, audience: "cid" }).ok, false);
  assert.equal(ID.identityOf({ email: "a@b.co", email_verified: "false" }).verified, false);
  assert.equal(ID.identityOf({ email: "a@b.co", picture: "javascript:alert(1)" }).picture, "");
});
test("domainOk: mismas reglas que /auth/google (email del dominio) y, si Google dice la organización, tiene que ser esa", () => {
  const id = (email, hd = "") => ({ email, hd });
  assert.ok(ID.domainOk(id("ana@ordereat.com", "ordereat.com"), "ordereat.com"));
  assert.ok(ID.domainOk(id("ana@ordereat.com"), "OrderEAT.com"));
  assert.ok(!ID.domainOk(id("ana@gmail.com"), "ordereat.com"));
  assert.ok(!ID.domainOk(id("ana@ordereat.com.evil.com"), "ordereat.com"));
  assert.ok(!ID.domainOk(id("ana@notordereat.com"), "ordereat.com"));
  assert.ok(!ID.domainOk(id("ana@ordereat.com", "otra.com"), "ordereat.com"));
  assert.ok(ID.domainOk(id("ana@gmail.com"), ""), "sin dominio configurado, como /auth/google");
});
test("permisos: mail, calendario y planillas; lo que falta; una conexión de antes (sin permisos anotados) es solo de mail", () => {
  assert.deepEqual(ID.permsOf(G.SCOPES), { perms: { mail: true, calendar: true, sheets: true }, missing: [] });
  assert.deepEqual(ID.permsOf([S("gmail.send"), S("spreadsheets.readonly")]), { perms: { mail: true, calendar: false, sheets: false }, missing: ["calendar", "sheets"] });
  assert.deepEqual(ID.permsOf("").missing, ["mail", "calendar", "sheets"]);
  assert.deepEqual(ID.recScopes({ enc: "x" }), [S("gmail.send"), S("gmail.settings.basic")]);
  assert.ok(ID.hasScope({ scope: `openid ${S("calendar.freebusy")}` }, S("calendar.freebusy")));
  assert.ok(!ID.hasScope(null, S("gmail.send")));
  assert.deepEqual(ID.usefulScopes(`openid email profile ${S("drive.file")} https://www.googleapis.com/auth/userinfo.email`), [S("drive.file")]);
  assert.deepEqual(G.PERMS.map(p => p.key), FMT.PERM_ORDER);
});
test("state: el de un ingreso va atado a la cookie y no sirve para conectar (ni al revés); tocado, vencido o de otra cookie no pasa", () => {
  const sec = "s3", now = Date.now(), n = G.newNonce();
  const st = G.signState({ nonce: n, kind: "login", at: now }, sec);
  assert.equal(G.stateKind(st, sec), "login");
  assert.deepEqual(G.verifyLoginState(st, { nonce: n, now }, sec), { ok: true, consent: false });
  assert.equal(G.verifyLoginState(G.signState({ nonce: n, kind: "login", consent: true, at: now }, sec), { nonce: n, now }, sec).consent, true);
  assert.equal(G.verifyLoginState(st, { nonce: G.newNonce(), now }, sec).ok, false, "otra cookie");
  assert.equal(G.verifyLoginState(st, { nonce: "", now }, sec).ok, false, "sin cookie");
  assert.equal(G.verifyLoginState(st, { nonce: n, now: now + 11 * 60e3 }, sec).why, "vencido");
  assert.equal(G.verifyLoginState(st, { nonce: n, now }, "otra-clave").ok, false);
  assert.equal(G.verifyLoginState(st.slice(0, -2) + "xx", { nonce: n, now }, sec).ok, false);
  assert.equal(G.verifyState(st, { email: "", nonce: n, now }, sec).ok, false, "un state de ingreso no conecta la cuenta de una sesión");
  const con = G.signState({ email: "a@b.co", nonce: n, at: now }, sec);
  assert.equal(G.stateKind(con, sec), "connect");
  assert.ok(G.verifyState(con, { email: "a@b.co", nonce: n, now }, sec).ok);
  assert.equal(G.verifyLoginState(con, { nonce: n, now }, sec).ok, false, "un state de conexión no hace entrar");
  assert.equal(G.stateKind("cualquier.cosa", sec), "");
  assert.equal(G.stateKind("", sec), "");
  // cambiar el tipo a mano rompe la firma
  const [p, sig] = con.split("."), o = JSON.parse(Buffer.from(p, "base64url").toString());
  assert.equal(G.stateKind(`${Buffer.from(JSON.stringify({ ...o, k: "login" })).toString("base64url")}.${sig}`, sec), "");
  assert.notEqual(G.idNonce(n), n); assert.equal(G.idNonce(n), G.idNonce(n));
});
test("authUrl: pide identidad y los permisos; prompt=consent solo cuando hace falta; hd del dominio; nonce del id_token", () => {
  const u = new URL(G.authUrl({ state: "st", redirectUri: "https://app.test/auth/gmail/callback", consent: false, nonce: "n1" }));
  assert.equal(u.origin + u.pathname, `${F.base}/o/oauth2/v2/auth`);
  assert.deepEqual(u.searchParams.get("scope").split(" "), ["openid", "email", "profile", ...G.SCOPES]);
  assert.equal(u.searchParams.get("access_type"), "offline");
  assert.equal(u.searchParams.get("prompt"), null);
  assert.equal(u.searchParams.get("login_hint"), null);
  assert.equal(u.searchParams.get("hd"), "ordereat.com");
  assert.equal(u.searchParams.get("nonce"), G.idNonce("n1"));
  assert.equal(u.searchParams.get("redirect_uri"), "https://app.test/auth/gmail/callback");
  const c = new URL(G.authUrl({ email: "a@ordereat.com", state: "st", redirectUri: "x" }));
  assert.equal(c.searchParams.get("prompt"), "consent"); assert.equal(c.searchParams.get("login_hint"), "a@ordereat.com");
});
test("el Google de prueba (GOOGLE_TEST_URL) solo vale con el Pipedrive de prueba y en esta máquina; si no, los servidores de Google", () => {
  const keep = { ...process.env }, set = o => Object.assign(process.env, o);
  try {
    assert.equal(ID.testBase(), F.base); assert.equal(ID.endpoints().token, `${F.base}/token`); assert.equal(G.simulated(), false);
    set({ GOOGLE_TEST_URL: "https://evil.example" }); assert.equal(ID.testBase(), ""); assert.equal(ID.endpoints().token, "https://oauth2.googleapis.com/token");
    set({ GOOGLE_TEST_URL: "http://127.0.0.1:9.evil.example" }); assert.equal(ID.testBase(), "");
    set({ GOOGLE_TEST_URL: F.base, PIPEDRIVE_API_TOKEN: "x" }); assert.equal(ID.testBase(), "", "con la cuenta real nunca");
    assert.equal(ID.endpoints().auth, "https://accounts.google.com/o/oauth2/v2/auth"); assert.equal(ID.endpoints().certs, "https://www.googleapis.com/oauth2/v3/certs");
    delete process.env.PIPEDRIVE_API_TOKEN; set({ DEMO_MODE: "0" }); assert.equal(ID.testBase(), "");
    set({ DEMO_MODE: "1" }); delete process.env.GOOGLE_TEST_URL; assert.equal(G.simulated(), true, "demo sin Google de prueba: Google simulado");
  } finally { for (const k of ["GOOGLE_TEST_URL", "PIPEDRIVE_API_TOKEN", "DEMO_MODE"]) { if (keep[k] === undefined) delete process.env[k]; else process.env[k] = keep[k]; } }
});
test("textos del navegador: qué falta, el error de la vuelta (solo por código) y cuándo toca el aviso", () => {
  assert.equal(FMT.permList(["sheets", "mail", "calendar"]), "mail, calendario y planillas");
  assert.equal(FMT.permList(["sheets", "calendar"]), "calendario y planillas");
  assert.equal(FMT.permList(["mail"]), "mail");
  assert.equal(FMT.loginError("domain", "ordereat.com"), "Solo pueden entrar cuentas @ordereat.com.");
  assert.equal(FMT.loginError("<script>"), FMT.LOGIN_ERR.other);
  assert.equal(FMT.loginError("denied"), FMT.LOGIN_ERR.denied);
  const g = (google, extra = {}) => ({ enabled: true, google, ...extra });
  const none = g({ connected: false, missing: ["mail", "calendar", "sheets"] }), ok = g({ connected: true, email: "a@b.co", missing: [] }), part = g({ connected: true, email: "a@b.co", missing: ["calendar"] });
  assert.equal(FMT.googleState(null), "off"); assert.equal(FMT.googleState({ enabled: false }), "off", "sin cliente OAuth no se muestra nada");
  assert.equal(FMT.googleState({ enabled: false, failed: true }), "off"); assert.equal(FMT.googleState(g(none.google, { config: true })), "off");
  assert.equal(FMT.googleState(none), "none"); assert.equal(FMT.googleState(part), "partial"); assert.equal(FMT.googleState(ok), "ok");
  assert.ok(FMT.noticeDue(none, "", "2026-11-19")); assert.ok(FMT.noticeDue(none, "2026-11-18", "2026-11-19"));
  assert.ok(!FMT.noticeDue(none, "2026-11-19", "2026-11-19"), "una vez por día como mucho");
  assert.ok(!FMT.noticeDue(ok, "", "2026-11-19"), "quien ya conectó no ve nada"); assert.ok(!FMT.noticeDue(part, "", "2026-11-19"));
  assert.ok(!FMT.noticeDue({ enabled: false }, "", "2026-11-19"), "sin cliente OAuth, ni aviso");
  assert.equal(FMT.partialText(["calendar", "sheets"]), "Entraste con Google, pero falta el permiso de calendario y planillas.");
  assert.match(FMT.connectedText(part), /sin permiso de calendario/); assert.match(FMT.connectedText(ok), /mail, calendario y planillas/);
});

// ---------- de punta a punta contra el Google falso
test("ingreso nuevo: un solo paso → entra (gmailOk) y queda guardada la conexión cifrada con mail, calendario y planillas", async () => {
  reset();
  assert.equal((await browser().get("/auth/config")).body.googleLogin, true);
  const { b, url, hops } = await login();
  assert.equal(tail(url), "/?google=ok");
  assert.equal(F.authCalls.length, 1, "una sola pasada por Google");
  const q = F.authCalls[0];
  assert.deepEqual(q.scope.split(" "), ["openid", "email", "profile", ...G.SCOPES]);
  assert.equal(q.access_type, "offline"); assert.equal(q.prompt, undefined, "sin prompt=consent: Google lo pide solo la primera vez");
  assert.equal(q.hd, "ordereat.com"); assert.equal(q.redirect_uri, `${APP}/auth/gmail/callback`, "la misma dirección de vuelta de «Conectar Gmail»");
  assert.ok(q.nonce && q.state && q.login_hint === undefined);
  const me = await b.get("/api/me");
  assert.equal(me.status, 200); assert.equal(me.body.user.email, "juandiego@ordereat.com"); assert.equal(me.body.user.name, "Juan Diego"); assert.equal(me.body.user.pdUserId, 2);
  const g = (await b.get("/api/gmail")).body;
  assert.equal(g.enabled, true); assert.equal(g.verified, true, "Google probó que es su cuenta: puede enviar desde este dispositivo");
  assert.equal(g.connected, true); assert.equal(g.demo, false);
  assert.deepEqual(g.google.perms, { mail: true, calendar: true, sheets: true }); assert.deepEqual(g.google.missing, []); assert.equal(g.google.email, "juandiego@ordereat.com");
  assert.equal(g.signatureSource, "gmail");
  // lo guardado: cifrado, con los permisos; nada de tokens al navegador ni en las direcciones
  const rec = await store.getGmail("juandiego@ordereat.com"), rt = [...F.refreshTokens.keys()].at(-1);
  assert.equal(G.decrypt(rec.enc), rt); assert.ok(!JSON.stringify(rec).includes(rt)); assert.equal(rec.via, "login");
  assert.deepEqual(rec.scope.split(" ").sort(), [...ALL].sort());
  const seen = JSON.stringify([hops.filter(h => h.startsWith(APP) && !h.includes("/auth/gmail/callback")), g, me.body, [...b.jar]]);
  for (const t of [...F.refreshTokens.keys(), ...F.accessTokens.keys(), F.clientSecret]) assert.ok(!seen.includes(t), "ni tokens ni el secreto salen del servidor");
  // lo que usa los permisos se prende solo
  assert.equal(googleSheetsReady(), true);
  assert.equal((await b.get("/api/sheets/status")).body.direct, true, "crear la hoja directo queda prendido");
  assert.ok(await G.accessToken("juandiego@ordereat.com", G.FREEBUSY_SCOPE), "libre/ocupado del account");
  assert.ok(await G.accessToken("juandiego@ordereat.com", G.SHEETS_SCOPE), "leer la planilla de Cargar base");
  const sent = await G.send("juandiego@ordereat.com", { to: "direccion@colegio.mx", subject: "Hola", text: "Probando", fromName: "Juan Diego" });
  assert.equal(sent.from, "juandiego@ordereat.com"); assert.equal(F.sent.length, 1); assert.match(F.sent[0].mime, /^From: "Juan Diego" <juandiego@ordereat\.com>/m);
});
test("ingreso sin refresh token (ya había dado el permiso): entra en una pasada y se conserva la conexión guardada, que se prueba", async () => {
  reset();
  const antes = await store.getGmail("juandiego@ordereat.com");
  const { b, url } = await login();
  assert.equal(tail(url), "/?google=ok");
  assert.equal(F.authCalls.length, 1, "sin segunda vuelta");
  assert.deepEqual(F.tokenCalls.map(c => c.grant), ["authorization_code", "refresh_token"], "la guardada se prueba contra Google");
  assert.equal(F.tokenCalls[1].refresh, G.decrypt(antes.enc));
  assert.deepEqual(await store.getGmail("juandiego@ordereat.com"), antes, "lo guardado no cambia");
  const g = (await b.get("/api/gmail")).body;
  assert.ok(g.verified && g.connected && g.google.connected); assert.deepEqual(g.google.missing, []);
});
test("sin refresh token y sin nada guardado (o la guardada ya no sirve): una vuelta más pidiendo el permiso, una sola", async () => {
  reset();
  await store.delGmail("juandiego@ordereat.com"); // se perdió lo guardado, pero en Google el permiso sigue dado
  let x = await login();
  assert.equal(tail(x.url), "/?google=ok");
  assert.equal(F.authCalls.length, 2);
  assert.equal(F.authCalls[0].prompt, undefined);
  assert.equal(F.authCalls[1].prompt, "consent"); assert.equal(F.authCalls[1].login_hint, "juandiego@ordereat.com", "ya con su cuenta elegida");
  assert.notEqual(F.authCalls[1].state, F.authCalls[0].state); assert.notEqual(F.authCalls[1].nonce, F.authCalls[0].nonce);
  let rec = await store.getGmail("juandiego@ordereat.com");
  assert.equal(G.decrypt(rec.enc), [...F.refreshTokens.keys()].at(-1));
  assert.equal((await x.b.get("/api/gmail")).body.google.connected, true);
  // la guardada dejó de servir en Google (invalid_grant): se borra y se pide de nuevo
  reset(); F.refreshTokens.get(G.decrypt(rec.enc)).dead = true;
  x = await login();
  assert.equal(tail(x.url), "/?google=ok"); assert.equal(F.authCalls.length, 2); assert.equal(F.authCalls[1].prompt, "consent");
  const rec2 = await store.getGmail("juandiego@ordereat.com");
  assert.notEqual(rec2.enc, rec.enc); assert.equal(F.refreshTokens.get(G.decrypt(rec2.enc)).dead, undefined);
  // Google no responde al probar la guardada: no se toca ni se pide de nuevo
  reset();
  const b = browser(); let r = await b.go(`${APP}/auth/google/start`); r = await b.go(r.headers.get("location")); // la vuelta, todavía sin seguir
  const backUrl = r.headers.get("location"), real = F.tokenCalls.length;
  const orig = globalThis.fetch; let n = 0;
  globalThis.fetch = (u, o) => String(u) === `${F.base}/token` && ++n === 2 ? Promise.reject(new TypeError("fetch failed")) : orig(u, o);
  try { r = await b.go(backUrl); } finally { globalThis.fetch = orig; }
  assert.equal(r.headers.get("location"), "/?google=ok"); assert.equal(F.tokenCalls.length, real + 1);
  assert.deepEqual(await store.getGmail("juandiego@ordereat.com"), rec2);
  // en la segunda vuelta dice que no: ya entró (probó quién es), queda sin conexión y sin error
  reset(); await store.delGmail("juandiego@ordereat.com");
  const b2 = browser(); r = await b2.go(`${APP}/auth/google/start`); r = await b2.go(r.headers.get("location")); r = await b2.go(r.headers.get("location"));
  assert.match(r.headers.get("location"), /prompt=consent/);
  F.deny = true; r = await b2.go(r.headers.get("location")); r = await b2.go(r.headers.get("location"));
  assert.equal(r.headers.get("location"), "/?google=ok");
  const g = (await b2.get("/api/gmail")).body;
  assert.equal(g.google.connected, false); assert.equal(g.verified, true); assert.equal(FMT.googleState(g), "none");
  reset(); await login(); // queda conectado para las que siguen
});
test("permisos parciales (destildó en Google): entra igual, la app dice cuáles faltan y «Dar permisos» los completa", async () => {
  reset({ email: "agustin@ordereat.com", verified: true, name: "Agustín", hd: "ordereat.com" });
  F.untick = [S("calendar.freebusy"), S("drive.file")];
  const { b, url } = await login();
  assert.equal(tail(url), "/?google=ok");
  let g = (await b.get("/api/gmail")).body;
  assert.equal(g.verified, true); assert.equal(g.connected, true, "el mail sí lo dio");
  assert.deepEqual(g.google.perms, { mail: true, calendar: false, sheets: false }); assert.deepEqual(g.google.missing, ["calendar", "sheets"]);
  assert.equal(FMT.googleState(g), "partial");
  assert.equal((await b.get("/api/sheets/status")).body.direct, false, "sin el permiso, crear la hoja directo sigue apagado");
  assert.equal(await G.accessToken("agustin@ordereat.com", G.FREEBUSY_SCOPE), null);
  assert.ok(await G.accessToken("agustin@ordereat.com", G.SHEETS_SCOPE), "el de leer planillas sí");
  // «Dar los permisos que faltan»: conectar desde la sesión (pide los permisos de nuevo)
  F.untick = []; F.authCalls.length = 0;
  const c = await b.follow(`${APP}/auth/gmail/start`);
  assert.equal(F.authCalls[0].prompt, "consent"); assert.equal(F.authCalls[0].login_hint, "agustin@ordereat.com");
  assert.equal(c.r.status, 200); assert.match(await c.r.text(), /Google conectado como agustin@ordereat\.com\./);
  g = (await b.get("/api/gmail")).body;
  assert.deepEqual(g.google.missing, []); assert.equal((await b.get("/api/sheets/status")).body.direct, true);
  // sin el permiso de mail: entra y conecta lo demás; el mail no se ofrece (y enviar no pasa)
  reset({ email: "sofia@ordereat.com", verified: true, name: "Sofía", hd: "ordereat.com" });
  F.untick = [S("gmail.send"), S("gmail.settings.basic")];
  const s = await login();
  assert.equal(tail(s.url), "/?google=ok");
  g = (await s.b.get("/api/gmail")).body;
  assert.equal(g.google.connected, true); assert.equal(g.connected, false); assert.deepEqual(g.google.missing, ["mail"]);
  await assert.rejects(G.send("sofia@ordereat.com", { to: "a@colegio.mx", subject: "x", text: "y" }), e => e.code === "gmail_scope" && e.status === 409);
  assert.equal(F.apiCalls.length, 0, "sin el permiso no se le pide nada a Gmail");
  // destildó solo leer la configuración de Gmail: el mail sale igual (de la casilla de la conexión), sin la firma de Gmail
  reset({ email: "facundo@ordereat.com", verified: true, name: "Facundo", hd: "ordereat.com" });
  F.untick = [S("gmail.settings.basic")];
  const f = await login();
  g = (await f.b.get("/api/gmail")).body;
  assert.equal(g.connected, true); assert.deepEqual(g.google.missing, []); assert.equal(g.signatureSource !== "gmail", true);
  const out = await G.send("facundo@ordereat.com", { to: "a@colegio.mx", subject: "x", text: "y", fromName: "Facundo" });
  assert.equal(out.from, "facundo@ordereat.com"); assert.ok(F.apiCalls.every(c => !c.path.endsWith("/settings/sendAs")), "sin el permiso no se pide la firma");
  // no dio ningún permiso: entra, sin conexión guardada y sin insistir con otra vuelta
  reset({ email: "mateo@ordereat.com", verified: true, name: "Mateo", hd: "ordereat.com" });
  F.untick = [...ALL];
  const m = await login();
  assert.equal(tail(m.url), "/?google=ok"); assert.equal(F.authCalls.length, 1);
  assert.equal((await m.b.get("/api/me")).body.user.email, "mateo@ordereat.com");
  assert.equal(await store.getGmail("mateo@ordereat.com"), null);
  assert.equal(FMT.googleState((await m.b.get("/api/gmail")).body), "none");
});
test("conectar desde una sesión (código personal): la cuenta de Google tiene que ser la de la sesión; sin id_token, el email de Gmail", async () => {
  // entra sin Google (como con el código) y conecta: prompt=consent, queda verificado en esta sesión
  reset({ email: "demo@ordereat.com", verified: true, name: "Demo", hd: "ordereat.com" });
  const b = browser(); await b.post("/auth/dev");
  assert.equal(FMT.googleState((await b.get("/api/gmail")).body), "none", "sin conectar: le toca el aviso");
  let c = await b.follow(`${APP}/auth/gmail/start`);
  assert.match(await c.r.text(), /Google conectado como demo@ordereat\.com\./);
  assert.equal(F.authCalls[0].prompt, "consent"); assert.ok(F.authCalls[0].scope.split(" ").includes("openid"));
  let g = (await b.get("/api/gmail")).body;
  assert.ok(g.verified && g.connected); assert.deepEqual(g.google.missing, []); assert.equal(FMT.googleState(g), "ok");
  // eligió otra cuenta en Google: no se conecta, se le quita el permiso a la app y lo guardado sigue igual
  const antes = await store.getGmail("demo@ordereat.com");
  reset({ email: "otra.persona@ordereat.com", verified: true, name: "Otra Persona", hd: "ordereat.com" });
  c = await b.follow(`${APP}/auth/gmail/start`);
  assert.match(await c.r.text(), /Conectaste el Gmail de otra\.persona@ordereat\.com/); assert.equal(F.revoked.length, 1);
  assert.deepEqual(await store.getGmail("demo@ordereat.com"), antes);
  assert.equal((await b.get("/api/me")).body.user.email, "demo@ordereat.com", "conectar no cambia quién entró");
  // Google no mandó id_token: se comprueba con el email principal de Gmail (como antes)
  reset({ email: "demo@ordereat.com", verified: true, name: "Demo", hd: "ordereat.com" }); F.idToken = "none";
  c = await b.follow(`${APP}/auth/gmail/start`);
  assert.match(await c.r.text(), /Google conectado como demo@ordereat\.com\./); assert.ok(F.apiCalls.some(x => x.path.endsWith("/settings/sendAs")));
  // un id_token que no pasa (de otro ingreso) no alcanza: cae al email de Gmail; sin ese permiso, no se conecta
  reset({ email: "demo@ordereat.com", verified: true, name: "Demo", hd: "ordereat.com" }); F.idToken = "nonce"; F.untick = [S("gmail.settings.basic")];
  c = await b.follow(`${APP}/auth/gmail/start`);
  assert.match(await c.r.text(), /No pude comprobar qué cuenta/);
  // no tildó nada: no se conecta y lo dice
  reset({ email: "demo@ordereat.com", verified: true, name: "Demo", hd: "ordereat.com" }); F.untick = [...ALL];
  c = await b.follow(`${APP}/auth/gmail/start`);
  assert.match(await c.r.text(), /No diste ningún permiso/);
  reset({ email: "demo@ordereat.com", verified: true, name: "Demo", hd: "ordereat.com" }); await b.follow(`${APP}/auth/gmail/start`);
});
test("dominio incorrecto o email sin verificar: no entra, no queda nada guardado y se le quita el permiso a la app", async () => {
  reset({ email: "alguien@gmail.com", verified: true, name: "Alguien" });
  let x = await login();
  assert.equal(tail(x.url), "/?google=error&m=domain");
  assert.equal((await x.b.get("/api/me")).status, 401, "sin sesión");
  assert.equal(await store.getGmail("alguien@gmail.com"), null);
  assert.equal(F.revoked.length, 1); assert.match(F.revoked[0], /^rt-/);
  reset({ email: "trampa@ordereat.com.evil.example", verified: true });
  assert.equal(tail((await login()).url), "/?google=error&m=domain");
  reset({ email: "ana@ordereat.com", verified: true, hd: "otra-empresa.com" });
  assert.equal(tail((await login()).url), "/?google=error&m=domain", "el email dice el dominio pero la cuenta es de otra organización");
  reset({ email: "nuevo@ordereat.com", verified: false, hd: "ordereat.com" });
  x = await login();
  assert.equal(tail(x.url), "/?google=error&m=unverified"); assert.equal((await x.b.get("/api/me")).status, 401);
  assert.equal(await store.getGmail("nuevo@ordereat.com"), null);
});
test("el email lo dice Google (id_token firmado), no un parámetro: un id_token que no pasa no entra", async () => {
  for (const mode of ["aud", "firma", "nonce", "vencido", "emisor", "none"]) {
    reset(); F.idToken = mode;
    const x = await quiet(() => login());
    assert.equal(tail(x.url), "/?google=error&m=identity", mode);
    assert.equal((await x.b.get("/api/me")).status, 401, mode);
    assert.equal(F.revoked.length, 0, "no se revoca: no se sabe de quién es y podría ser la conexión de alguien");
  }
  // un email en la dirección de vuelta no cambia quién entra
  reset();
  const b = browser(); let r = await b.go(`${APP}/auth/google/start`); r = await b.go(r.headers.get("location"));
  r = await b.go(`${r.headers.get("location")}&email=facundo@ordereat.com&hd=ordereat.com&user=facundo@ordereat.com`);
  assert.equal(r.headers.get("location"), "/?google=ok");
  assert.equal((await b.get("/api/me")).body.user.email, "juandiego@ordereat.com");
});
test("state inválido, repetido, de otra cookie o sin cookie: no entra (y el código no se cambia)", async () => {
  reset();
  // la vuelta de un navegador, usada en otro (sin su cookie)
  const a = browser(); let r = await a.go(`${APP}/auth/google/start`); const antes = a.copy();
  r = await a.go(r.headers.get("location")); const back = r.headers.get("location");
  const otro = browser(); r = await otro.go(back);
  assert.equal(r.headers.get("location"), "/?google=error&m=state"); assert.equal((await otro.get("/api/me")).status, 401);
  // otro navegador que empezó su propio ingreso (otra cookie) con la vuelta ajena
  const c = browser(); await c.go(`${APP}/auth/google/start`); r = await c.go(back);
  assert.equal(r.headers.get("location"), "/?google=error&m=state"); assert.equal((await c.get("/api/me")).status, 401);
  assert.equal(F.tokenCalls.length, 0, "con el state mal, el código ni se le pasa a Google");
  // la buena, una vez
  r = await a.go(back); assert.equal(r.headers.get("location"), "/?google=ok");
  const calls = F.tokenCalls.length;
  // repetida con la cookie como estaba antes de volver (alguien se la guardó): el valor ya se gastó
  r = await antes.go(back);
  assert.equal(r.headers.get("location"), "/?google=error&m=state"); assert.equal((await antes.get("/api/me")).status, 401);
  assert.equal(F.tokenCalls.length, calls);
  // repetida en el mismo navegador: la cookie ya no tiene el valor; sigue con su sesión, no entra de nuevo
  r = await a.go(back); assert.equal(r.headers.get("location"), "/?google=error&m=state");
  // state tocado, inventado o de «conectar» sin sesión: no hay ingreso
  const d = browser(); await d.go(`${APP}/auth/google/start`);
  for (const st of [back.replace(/state=[^&]+/, "state=abc.def"), back.replace(/state=([^&]{6})/, "state=XXXXXX"), `${APP}/auth/gmail/callback?code=x&state=${encodeURIComponent(G.signState({ email: "juandiego@ordereat.com", nonce: "n" }))}`]) {
    const e = d.copy(); r = await e.go(st);
    assert.equal(r.headers.get("location"), "/?google=error&m=state"); assert.equal((await e.get("/api/me")).status, 401);
  }
  // sin haber empezado nada: la página de «conectar» de siempre dice que inicie sesión (no hay sesión nueva)
  const f = browser(); r = await f.go(`${APP}/auth/gmail/callback?code=x&state=abc`);
  assert.equal(r.status, 200); assert.match(await r.text(), /Iniciá sesión en la app/); assert.equal((await f.get("/api/me")).status, 401);
  // un state de ingreso con una sesión abierta no conecta ni cambia la cuenta de esa sesión
  const g = browser(); await g.post("/auth/dev");
  r = await g.go(back); assert.equal(r.headers.get("location"), "/?google=error&m=state");
  assert.equal((await g.get("/api/me")).body.user.email, "demo@ordereat.com");
});
test("dijo que no en Google, Google caído y la vuelta: siempre a una dirección fija de la app (nada de redirecciones a pedido)", async () => {
  reset(); F.deny = true;
  let x = await login();
  assert.equal(tail(x.url), "/?google=error&m=denied"); assert.equal((await x.b.get("/api/me")).status, 401);
  reset(); F.tokenDown = true;
  x = await quiet(() => login());
  assert.equal(tail(x.url), "/?google=error&m=other"); assert.equal((await x.b.get("/api/me")).status, 401);
  reset();
  const b = browser();
  let r = await b.go(`${APP}/auth/google/start?next=https://evil.example&redirect_uri=https://evil.example/cb&redirect=//evil.example`);
  const to = new URL(r.headers.get("location"));
  assert.equal(to.origin, F.base); assert.equal(to.searchParams.get("redirect_uri"), `${APP}/auth/gmail/callback`);
  assert.equal(r.headers.get("cache-control"), "no-store");
  r = await b.go(to.href); r = await b.go(`${r.headers.get("location")}&next=https://evil.example&m=https://evil.example`);
  assert.equal(r.headers.get("location"), "/?google=ok");
  // la página de la app no cree lo que diga la dirección: «ok» sin sesión no entra
  assert.equal((await browser().get("/api/me")).status, 401);
});
test("demo sin Google de prueba: el Google simulado deja probar el ingreso completo (elegir cuenta y permisos, o cancelar)", async () => {
  const keep = process.env.GOOGLE_TEST_URL; delete process.env.GOOGLE_TEST_URL;
  try {
    assert.equal(G.simulated(), true);
    assert.equal((await browser().get("/auth/config")).body.googleLogin, true);
    const b = browser(); let r = await b.go(`${APP}/auth/google/start`);
    const page = r.headers.get("location"); assert.match(page, /^\/auth\/google\/demo\?state=/);
    r = await b.go(APP + page); const html = await r.text();
    assert.equal(r.status, 200); assert.match(html, /Google simulado \(demo\)/); assert.match(html, /name="perms" value="calendar" checked/);
    const state = new URL(APP + page).searchParams.get("state");
    const form = o => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(o) });
    r = await b.go(`${APP}/auth/google/demo`, form([["state", state], ["email", "Facundo@ordereat.com"], ["perms", "mail"], ["perms", "sheets"]]));
    assert.match(r.headers.get("location"), /^\/auth\/gmail\/callback\?state=/);
    r = await b.go(APP + r.headers.get("location"));
    assert.equal(r.headers.get("location"), "/?google=ok");
    assert.equal((await b.get("/api/me")).body.user.email, "facundo@ordereat.com");
    const g = (await b.get("/api/gmail")).body;
    assert.equal(g.demo, true); assert.equal(g.verified, true); assert.equal(g.connected, true);
    assert.deepEqual(g.google.perms, { mail: true, calendar: false, sheets: true }); assert.deepEqual(g.google.missing, ["calendar"]);
    // «dar permisos» en el demo: conectar desde la sesión completa lo que falta; ?perms= simula destildar
    r = await b.go(`${APP}/auth/gmail/start`); assert.match(await r.text(), /Google conectado como facundo@ordereat\.com\./);
    assert.deepEqual((await b.get("/api/gmail")).body.google.missing, []);
    r = await b.go(`${APP}/auth/gmail/start?perms=calendar`); assert.match(await r.text(), /sin permiso de mail ni planillas/);
    assert.equal((await b.get("/api/gmail")).body.connected, false);
    // del dominio, como siempre; cancelar no entra; un state inventado no muestra la pantalla
    const c = browser(); r = await c.go(`${APP}/auth/google/start`); const st2 = new URL(APP + r.headers.get("location")).searchParams.get("state");
    r = await c.go(`${APP}/auth/google/demo`, form({ state: st2, email: "alguien@gmail.com", perms: "mail" })); r = await c.go(APP + r.headers.get("location"));
    assert.equal(r.headers.get("location"), "/?google=error&m=domain"); assert.equal((await c.get("/api/me")).status, 401);
    const d = browser(); r = await d.go(`${APP}/auth/google/start`); const st3 = new URL(APP + r.headers.get("location")).searchParams.get("state");
    r = await d.go(`${APP}/auth/google/demo`, form({ state: st3, email: "demo@ordereat.com", deny: "1" })); r = await d.go(APP + r.headers.get("location"));
    assert.equal(r.headers.get("location"), "/?google=error&m=denied");
    r = await browser().go(`${APP}/auth/google/demo?state=inventado`); assert.equal(r.headers.get("location"), "/");
    // un «código» del demo no sirve con Google de verdad (o el de prueba): ahí el código se le pasa a Google
    process.env.GOOGLE_TEST_URL = keep; reset();
    const e = browser(); r = await e.go(`${APP}/auth/google/start`); const st4 = new URL(r.headers.get("location")).searchParams.get("state");
    r = await quiet(() => e.go(`${APP}/auth/gmail/callback?state=${encodeURIComponent(st4)}&code=${G.demoCode({ email: "facundo@ordereat.com", perms: ["mail"] })}`));
    assert.equal(r.headers.get("location"), "/?google=error&m=other"); assert.equal((await e.get("/api/me")).status, 401);
    r = await e.go(`${APP}/auth/google/demo?state=${encodeURIComponent(st4)}`); assert.equal(r.status, 404, "con Google real (o el de prueba) la pantalla simulada no existe");
  } finally { process.env.GOOGLE_TEST_URL = keep; }
});
test("sin cliente OAuth configurado: nada se ofrece (ni botón ni aviso) y nada falla; la app sigue con el código", async () => {
  const keep = { s: process.env.GOOGLE_CLIENT_SECRET, t: process.env.PIPEDRIVE_API_TOKEN };
  // como en producción hoy: Pipedrive real (acá, un token cualquiera: estas rutas no lo usan) y sin GOOGLE_CLIENT_SECRET
  delete process.env.GOOGLE_CLIENT_SECRET; process.env.PIPEDRIVE_API_TOKEN = "token-que-no-se-usa";
  try {
    assert.equal(G.gmailEnabled(), false); assert.equal(G.simulated(), false);
    const b = browser(), cfg = (await b.get("/auth/config")).body, calls = F.authCalls.length + F.tokenCalls.length;
    assert.equal(cfg.googleLogin, false); assert.equal(cfg.devLogin, true);
    let r = await b.go(`${APP}/auth/google/start`);
    assert.equal(r.status, 302); assert.equal(r.headers.get("location"), "/", "vuelve a la app, sin ir a Google");
    r = await b.go(`${APP}/auth/gmail/callback?code=x&state=${encodeURIComponent(G.signState({ nonce: "n", kind: "login" }))}`);
    assert.equal(r.headers.get("location"), "/?google=error&m=config");
    r = await b.go(`${APP}/auth/google/demo?state=x`); assert.equal(r.status, 404);
    r = await b.go(`${APP}/auth/gmail/start`); assert.equal(r.headers.get("location"), "/", "sin sesión");
    await b.post("/auth/dev");
    const g = (await b.get("/api/gmail")).body;
    assert.equal(g.enabled, false); assert.equal(g.connected, false); assert.equal(g.google.connected, false);
    assert.equal(FMT.googleState(g), "off"); assert.ok(!FMT.noticeDue(g, "", "2026-11-19"));
    assert.equal((await b.get("/api/sheets/status")).body.direct, false);
    r = await b.go(`${APP}/auth/gmail/start`); assert.equal(r.status, 200); assert.match(await r.text(), /falta configurar Gmail/);
    assert.throws(() => G.startLogin({ nonce: "n", redirectUri: "x" }), e => e.status === 404 && e.code === "google_config");
    await assert.rejects(G.finishLogin({ nonce: "n", state: "x", code: "y", redirectUri: "x" }), e => e.code === "google_config");
    assert.equal(F.authCalls.length + F.tokenCalls.length, calls, "a Google no se le pidió nada");
  } finally { process.env.GOOGLE_CLIENT_SECRET = keep.s; if (keep.t === undefined) delete process.env.PIPEDRIVE_API_TOKEN; else process.env.PIPEDRIVE_API_TOKEN = keep.t; }
});
test("entrar con código no prueba quién sos ante Google; /auth/google (token de identidad) sigue igual", async () => {
  const b = browser(); await b.post("/auth/dev");
  const g = (await b.get("/api/gmail")).body;
  assert.equal(g.verified, false);
  assert.equal((await b.post("/api/gmail/disconnect")).status, 409, "desconectar pide haber probado la cuenta en esta sesión");
  const r = await quiet(() => b.post("/auth/google", { credential: "no-es-un-token" }));
  assert.equal(r.status, 401);
});
test("desconectar (después de entrar con Google): se revoca en Google, se borra lo guardado y vuelve el aviso", async () => {
  reset({ email: "agustin@ordereat.com", verified: true, name: "Agustín", hd: "ordereat.com" });
  const { b } = await login();
  const rec = await store.getGmail("agustin@ordereat.com"); assert.ok(rec);
  const r = await b.post("/api/gmail/disconnect");
  assert.equal(r.status, 200); assert.equal(r.body.google.connected, false); assert.equal(FMT.googleState(r.body), "none");
  assert.deepEqual(F.revoked, [G.decrypt(rec.enc)]); assert.equal(await store.getGmail("agustin@ordereat.com"), null);
  assert.equal(await sheetsDirect("agustin@ordereat.com"), false);
  // la próxima vez que entra con Google, Google le muestra los permisos (ya no los tiene dados) y queda conectado de nuevo
  reset({ email: "agustin@ordereat.com", verified: true, name: "Agustín", hd: "ordereat.com" });
  const again = await login();
  assert.equal(tail(again.url), "/?google=ok"); assert.equal(F.authCalls.length, 1);
  assert.equal((await again.b.get("/api/gmail")).body.google.connected, true);
});
test("tope de vueltas por IP: después de muchas en 10 minutos no se le pide más nada a Google (y nadie queda adentro)", async () => {
  reset();
  const b = browser(); let r, n = 0;
  do { r = await b.go(`${APP}/auth/gmail/callback?code=x&state=${encodeURIComponent(G.signState({ nonce: "n", kind: "login" }))}`); } while (r.headers.get("location") === "/?google=error&m=state" && ++n < 200);
  assert.equal(r.headers.get("location"), "/?google=error&m=many"); assert.ok(n > 40, "no corta a un equipo que entra a la vez");
  const x = await login();
  assert.equal(tail(x.url), "/?google=error&m=many"); assert.equal(F.tokenCalls.length, 0); assert.equal((await x.b.get("/api/me")).status, 401);
});
