// Google falso para las pruebas de «Entrar con Google» (lib/gid.js, lib/gmail.js), en memoria y en esta máquina:
//  · GET  /o/oauth2/v2/auth  la pantalla de Google: «acepta» sola con lo que diga F (quién entra, qué destilda, si dice que
//    no) y vuelve a redirect_uri con code y state. Como Google: muestra los permisos la primera vez o con prompt=consent, y
//    solo entonces devuelve con qué seguir conectado (refresh_token).
//  · POST /token             cambia el código (de un solo uso) o un refresh_token; el id_token va firmado (RS256).
//  · GET  /oauth2/v3/certs   las claves públicas (JWKS).   · POST /revoke   · Gmail: settings/sendAs y messages/send.
// F (el estado) deja ver qué se pidió y cambiar cómo responde. Suelto: `node test/fake-google.mjs 4599` (para el navegador).
import http from "node:http";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

const G = "https://www.googleapis.com/auth/";
export const ALL = ["gmail.send", "gmail.settings.basic", "calendar.freebusy", "spreadsheets.readonly", "drive.file"].map(x => G + x);
const b64 = o => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");

export async function fakeGoogle({ port = 0, clientId = "cliente-de-prueba.apps.test", clientSecret = "secreto-de-prueba" } = {}) {
  const key = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }), otra = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = "clave-1", jwk = { ...key.publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" };
  const F = {
    clientId, clientSecret,
    user: { email: "juandiego@ordereat.com", verified: true, name: "Juan Diego", hd: "ordereat.com" }, // quién elige la cuenta
    untick: [],        // permisos que destilda en la pantalla (scopes enteros)
    deny: false,       // dice que no
    refresh: "auto",   // auto (como Google) | always | never
    idToken: "ok",     // ok | aud | firma | nonce | vencido | emisor | none
    tokenDown: false,
    authCalls: [], tokenCalls: [], revoked: [], apiCalls: [], sent: [], certCalls: 0,
    grants: new Map(), codes: new Map(), refreshTokens: new Map(), accessTokens: new Map(),
  };
  let n = 0;
  const read = req => new Promise(r => { let b = ""; req.on("data", c => b += c); req.on("end", () => r(b)); });
  const json = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  const sign = (payload, k = key.privateKey, head = { alg: "RS256", kid, typ: "JWT" }) => { const d = `${b64(head)}.${b64(payload)}`; return `${d}.${crypto.sign("RSA-SHA256", Buffer.from(d), k).toString("base64url")}`; };
  F.idTokenFor = (u, nonce, mode = F.idToken) => {
    const now = Math.floor(Date.now() / 1000);
    const p = { iss: mode === "emisor" ? "https://otro.example" : "https://accounts.google.com", aud: mode === "aud" ? "otro-cliente.apps.test" : clientId, azp: mode === "aud" ? "otro-cliente.apps.test" : clientId, sub: "sub-" + u.email,
      email: u.email, email_verified: u.verified !== false, name: u.name || "", picture: u.picture || "", ...(u.hd ? { hd: u.hd } : {}), nonce: mode === "nonce" ? "otro-nonce" : nonce, iat: mode === "vencido" ? now - 7200 : now, exp: mode === "vencido" ? now - 3600 : now + 3600 };
    return sign(p, mode === "firma" ? otra.privateKey : key.privateKey);
  };
  const bearer = req => F.accessTokens.get(String(req.headers.authorization || "").replace(/^Bearer /, "")) || null;
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url, F.base), body = await read(req);
    if (req.method === "GET" && url.pathname === "/oauth2/v3/certs") { F.certCalls++; return json(res, 200, { keys: [jwk] }); }
    if (req.method === "GET" && url.pathname === "/o/oauth2/v2/auth") {
      const q = Object.fromEntries(url.searchParams); F.authCalls.push(q);
      if (q.client_id !== clientId || q.response_type !== "code" || !q.redirect_uri) { res.writeHead(400, { "content-type": "text/plain" }); return res.end("Error 400: invalid_request"); }
      const back = new URL(q.redirect_uri); back.searchParams.set("state", q.state || "");
      if (F.deny) { back.searchParams.set("error", "access_denied"); res.writeHead(302, { location: back.href }); return res.end(); }
      const u = { ...F.user }, asked = String(q.scope || "").split(/\s+/).filter(Boolean), prev = F.grants.get(u.email);
      const consent = q.prompt === "consent" || !prev || asked.some(s => s.startsWith(G) && !prev.has(s));
      const given = consent ? asked.filter(s => !F.untick.includes(s)) : asked.filter(s => prev.has(s) || !s.startsWith(G));
      if (consent) F.grants.set(u.email, new Set(given));
      const code = `code-${++n}-${crypto.randomBytes(6).toString("hex")}`;
      F.codes.set(code, { user: u, scopes: given, nonce: q.nonce || "", redirect: q.redirect_uri, refresh: F.refresh === "always" || (F.refresh === "auto" && consent) });
      back.searchParams.set("code", code); back.searchParams.set("scope", given.join(" "));
      res.writeHead(302, { location: back.href }); return res.end();
    }
    if (req.method === "POST" && url.pathname === "/token") {
      const p = Object.fromEntries(new URLSearchParams(body)); F.tokenCalls.push({ grant: p.grant_type, code: p.code || "", refresh: p.refresh_token || "" });
      if (F.tokenDown) return json(res, 503, { error: "backend_error" });
      if (p.client_id !== clientId || p.client_secret !== clientSecret) return json(res, 401, { error: "invalid_client" });
      if (p.grant_type === "authorization_code") {
        const c = F.codes.get(p.code); F.codes.delete(p.code);
        if (!c || c.redirect !== p.redirect_uri) return json(res, 400, { error: "invalid_grant" });
        const at = `at-${++n}-${crypto.randomBytes(6).toString("hex")}`; F.accessTokens.set(at, { email: c.user.email, name: c.user.name, scopes: c.scopes });
        const out = { access_token: at, expires_in: 3599, token_type: "Bearer", scope: c.scopes.join(" ") };
        if (c.refresh) { out.refresh_token = `rt-${++n}-${crypto.randomBytes(6).toString("hex")}`; F.refreshTokens.set(out.refresh_token, { email: c.user.email, name: c.user.name, scopes: c.scopes }); }
        if (c.scopes.includes("openid") && F.idToken !== "none") out.id_token = F.idTokenFor(c.user, c.nonce);
        return json(res, 200, out);
      }
      if (p.grant_type === "refresh_token") {
        const r = F.refreshTokens.get(p.refresh_token);
        if (!r || r.dead) return json(res, 400, { error: "invalid_grant" });
        const at = `at-${++n}-${crypto.randomBytes(6).toString("hex")}`; F.accessTokens.set(at, { email: r.email, name: r.name, scopes: r.scopes });
        return json(res, 200, { access_token: at, expires_in: 3599, token_type: "Bearer", scope: r.scopes.join(" ") });
      }
      return json(res, 400, { error: "unsupported_grant_type" });
    }
    if (req.method === "POST" && url.pathname === "/revoke") {
      const t = url.searchParams.get("token") || new URLSearchParams(body).get("token") || ""; F.revoked.push(t);
      const who = F.refreshTokens.get(t)?.email || F.accessTokens.get(t)?.email;
      if (who) { for (const r of F.refreshTokens.values()) if (r.email === who) r.dead = true; for (const [k, a] of F.accessTokens) if (a.email === who) F.accessTokens.delete(k); F.grants.delete(who); }
      return json(res, 200, {});
    }
    if (url.pathname.startsWith("/gmail/v1/users/me/")) {
      const a = bearer(req); F.apiCalls.push({ method: req.method, path: url.pathname, ok: !!a });
      if (!a) return json(res, 401, { error: { status: "UNAUTHENTICATED" } });
      if (req.method === "GET" && url.pathname.endsWith("/settings/sendAs")) {
        if (!a.scopes.includes(G + "gmail.settings.basic")) return json(res, 403, { error: { status: "PERMISSION_DENIED" } });
        return json(res, 200, { sendAs: [{ sendAsEmail: a.email, isPrimary: true, displayName: a.name || "", signature: "<b>Firma de Gmail</b>" }] });
      }
      if (req.method === "POST" && url.pathname.endsWith("/messages/send")) {
        if (!a.scopes.includes(G + "gmail.send")) return json(res, 403, { error: { status: "PERMISSION_DENIED" } });
        const raw = JSON.parse(body || "{}").raw || ""; F.sent.push({ from: a.email, mime: Buffer.from(raw, "base64url").toString("utf8") });
        return json(res, 200, { id: `msg-${F.sent.length}`, threadId: `th-${F.sent.length}` });
      }
    }
    // suelto, para probar a mano: cambiar qué destilda (?untick=calendar.freebusy,drive.file; vacío = nada)
    if (F.manual && req.method === "GET" && url.pathname === "/__set") { F.untick = (url.searchParams.get("untick") || "").split(",").map(x => x.trim()).filter(Boolean).map(x => G + x); return json(res, 200, { untick: F.untick }); }
    res.writeHead(404); res.end();
  });
  await new Promise(r => srv.listen(port, "127.0.0.1", r));
  F.base = `http://127.0.0.1:${srv.address().port}`;
  F.close = () => new Promise(r => { srv.closeAllConnections?.(); srv.close(r); });
  return F;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const F = await fakeGoogle({ port: Number(process.argv[2]) || 4599 });
  F.manual = true;
  if (process.env.FAKE_GOOGLE_EMAIL) F.user = { email: process.env.FAKE_GOOGLE_EMAIL, verified: true, name: process.env.FAKE_GOOGLE_NAME || "", hd: process.env.FAKE_GOOGLE_EMAIL.split("@")[1] };
  if (process.env.FAKE_GOOGLE_UNTICK) F.untick = process.env.FAKE_GOOGLE_UNTICK.split(",").map(x => G + x.trim());
  console.log(`Google falso en ${F.base} · GOOGLE_CLIENT_ID=${F.clientId} · entra ${F.user.email}`);
}
