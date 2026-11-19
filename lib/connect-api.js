// Cuentas conectadas de cada persona: Gmail (conectar, firma, desconectar), «Entrar con Google», «Tu firma» y «Conectá tu
// Pipedrive» (lib/gmail.js, lib/signature.js, lib/pdtoken.js). server.js la monta con mountConnect(app, deps) en el mismo
// lugar donde estaban estas rutas y recibe los controles que usan las rutas del mail de la ficha (pdProof, mailSig…).
import express from "express";
import * as pd from "./pipedrive.js";
import { bump, getMailPrefs, getProfile, once, setMailPrefs } from "./store.js";
import * as sales from "./sales.js";
import * as gmail from "./gmail.js";
import * as pdtoken from "./pdtoken.js";
import * as SIG from "./signature.js";

const escHtml = v => String(v).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export function mountConnect(app, { DEV_EMAIL, DEV_OK, DOMAIN, MODE, attachPipedriveUser, auth, baseRole, googleLoginOn, signName, viewerFor, wrap }) {
  // ---------- Gmail de cada persona (lib/gmail.js): conectar una vez, firma y estado. Nada de esto devuelve tokens.
  // El redirect tiene que ser exactamente el que está cargado en el cliente OAuth de Google (GMAIL_REDIRECT_URI lo fija).
  const gmailRedirect = req => process.env.GMAIL_REDIRECT_URI || `${req.protocol}://${req.get("host")}/auth/gmail/callback`;
  const gmailName = async user => (await signName(user)) || sales.signer(user);
  // El Gmail guardado es de un email, pero solo lo usa una sesión que probó ser de esa persona ante Google: conectó Gmail
  // en esta sesión (finishConnect) o entró con Google. Con el código personal (que un líder ve) no alcanza para mandar desde
  // su casilla, cambiar su firma ni desconectarlo: en cada dispositivo nuevo se conecta una vez.
  const gmailProven = req => !!req.session?.gmailOk && req.session.gmailOk === String(req.session.user?.email || "").toLowerCase();
  const gmailProof = (req, res, next) => gmailProven(req) ? next() : res.status(409).json({ error: "Conectá tu Gmail en este dispositivo.", code: "gmail_reauth" });
  // Límite de mails por persona por hora (MAIL_PER_HOUR, 60 por defecto)
  const MAIL_PER_HOUR = Math.max(1, Number(process.env.MAIL_PER_HOUR) || 60);
  const READ_ONLY = process.env.READ_ONLY === "1";
  const gmailView = async req => ({ ...(await gmail.status(req.session.user.email, await gmailName(req.session.user), gmailPick(await mailSig(req, "gmail")))), verified: gmailProven(req), readOnly: READ_ONLY });
  app.get("/api/gmail", auth, wrap(async (req, res) => res.json(await gmailView(req))));
  // La ventana de Google termina en esta página: le avisa a la app (BroadcastChannel y, si sigue el vínculo, postMessage) y se
  // cierra. Si no se abrió en otra ventana (el navegador la bloqueó), vuelve a la app con ?gmail=…
  // En la dirección de vuelta va solo un código (state|mismatch|denied|scope|config|session|other): el navegador lo traduce
  // a un texto fijo, así nadie arma un link que muestre su propio texto dentro de la app.
  const GMAIL_CODES = { gmail_state: "state", gmail_mismatch: "mismatch", gmail_scope: "scope", gmail_noperms: "noperms" };
  const gmailCode = e => GMAIL_CODES[e?.code] || (e?.status === 404 ? "config" : "other");
  function gmailDone(res, r, popup = false) {
    const miss = (r.missing || []).map(k => gmail.PERMS.find(x => x.key === k)?.label.toLowerCase()).filter(Boolean);
    const data = JSON.stringify({ type: "ob-gmail", ok: !!r.ok, ...(r.ok ? { email: r.email, missing: r.missing || [] } : { code: r.code || "other", error: r.error || "" }) }).replace(/</g, "\\u003c");
    const back = `/?gmail=${r.ok ? "ok" : "error"}${r.ok ? "" : `&m=${encodeURIComponent(r.code || "other")}`}`;
    const msg = r.ok ? `Google conectado como ${r.email}${miss.length ? ` (sin permiso de ${miss.join(" ni ")})` : ""}.${popup ? " Ya podés cerrar esta ventana." : ""}` : r.error || "No se pudo conectar Google.";
    res.set("cache-control", "no-store").type("html").send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Google · OrderBrain SDR</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#FAFAFA;color:#18181b;padding:16px;box-sizing:border-box;text-align:center}@media (prefers-color-scheme:dark){body{background:#111214;color:#ececec}}a{color:inherit}</style></head>
<body><p>${escHtml(msg)}<br><a href="${escHtml(back)}">Volver a la app</a></p>
<script>(function(){var r=${data};try{var c=new BroadcastChannel("ob-gmail");c.postMessage(r);c.close()}catch(e){}try{if(window.opener&&!window.opener.closed)window.opener.postMessage(r,location.origin)}catch(e){}
${popup ? "setTimeout(function(){window.close()},400)" : `location.replace(${JSON.stringify(back)})`}})()</script></body></html>`);
  }
  app.get("/auth/gmail/start", async (req, res) => {
    const user = req.session?.user;
    if (!user || req.session.mode !== MODE) return res.redirect("/");
    const popup = req.query.popup === "1";
    try {
      req.session.gmailNonce = gmail.newNonce(); req.session.gmailPopup = popup;
      // demo: ?as= simula conectar otra cuenta (para probar el rechazo); con Google real no se usa
      const demoAs = pd.DEMO ? String(req.query.as || "").slice(0, 120) : "";
      const r = await gmail.startConnect({ email: user.email, nonce: req.session.gmailNonce, redirectUri: gmailRedirect(req), demoAs });
      if (r.url) return res.redirect(r.url);
      // demo: ?perms=mail,calendar simula que destildó permisos en la pantalla de Google
      const demoPerms = pd.DEMO && req.query.perms !== undefined ? String(req.query.perms).split(",").map(x => x.trim()).filter(Boolean).slice(0, 5) : null;
      const fin = await gmail.finishConnect({ email: user.email, nonce: req.session.gmailNonce, demoAs: r.gmailEmail, demoPerms });
      req.session.gmailNonce = null; req.session.gmailOk = String(user.email).toLowerCase();
      gmailDone(res, { ok: true, email: fin.email, missing: fin.missing }, popup);
    } catch (e) { req.session.gmailNonce = null; gmailDone(res, { ok: false, error: e.message, code: gmailCode(e) }, popup); }
  });
  app.get("/auth/gmail/callback", async (req, res) => {
    // la misma vuelta sirve para «Entrar con Google» (sin sesión todavía): lo dice el state firmado, no un parámetro
    if (gmail.stateKind(String(req.query.state || "")) === "login" || (!req.session?.user && req.session?.glogin)) return googleLoginBack(req, res);
    const user = req.session?.user, popup = !!req.session?.gmailPopup;
    if (!user || req.session.mode !== MODE) return gmailDone(res, { ok: false, error: "Iniciá sesión en la app y conectá Gmail de nuevo.", code: "session" });
    const nonce = req.session.gmailNonce; req.session.gmailNonce = null; req.session.gmailPopup = null;
    if (req.query.error) return gmailDone(res, req.query.error === "access_denied" ? { ok: false, error: "No diste permiso: el mail no se puede enviar desde acá. Podés seguir con «Abrir en Gmail».", code: "denied" } : { ok: false, error: "Google no completó la conexión. Probá de nuevo.", code: "other" }, popup);
    try {
      const fin = await gmail.finishConnect({ email: user.email, nonce, state: String(req.query.state || ""), code: String(req.query.code || ""), redirectUri: gmailRedirect(req) });
      req.session.gmailOk = String(user.email).toLowerCase(); // probó ante Google que la cuenta es suya: esta sesión puede enviar
      gmailDone(res, { ok: true, email: fin.email, missing: fin.missing }, popup);
    } catch (e) { if ((e.status || 500) >= 500) console.warn("Gmail:", e.message); gmailDone(res, { ok: false, error: e.message, code: gmailCode(e) }, popup); }
  });
  // ---------- «Entrar con Google» en un solo paso (pedido del líder de SDR: «que automáticamente se conecte con el Calendar y
  // el Drive cuando entre en su cuenta de Google»). GET /auth/google/start manda a Google con el mismo OAuth con código de
  // «Conectar Gmail» y vuelve a /auth/gmail/callback (la única dirección de vuelta cargada en el cliente OAuth): ahí entra
  // (misma sesión que /auth/google, con gmailOk) y queda guardada la conexión para mail, calendario y planillas.
  // Todavía no hay sesión: el state va firmado (HMAC) y atado a un valor de un solo uso que queda en la cookie (glogin) y se
  // gasta en la vuelta (once). Quién entra lo dice el id_token de Google, nunca un parámetro. La vuelta termina siempre en
  // «/?google=ok|error&m=código» (dirección fija: no hay a dónde redirigir a pedido) y el navegador pone el texto.
  const GOOGLE_CODES = { google_state: "state", google_domain: "domain", google_unverified: "unverified", google_identity: "identity", google_config: "config" };
  const clientIp = req => String(req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim();
  const GLOGIN_MAX = 150; // una oficina entera sale por la misma IP
  app.get("/auth/google/start", (req, res) => {
    res.set("cache-control", "no-store");
    if (!googleLoginOn()) return res.redirect("/");
    try {
      const nonce = gmail.newNonce();
      req.session.glogin = { n: nonce, t: Date.now() };
      const r = gmail.startLogin({ nonce, redirectUri: gmailRedirect(req) });
      res.redirect(r.url || `/auth/google/demo?state=${encodeURIComponent(r.state)}`);
    } catch { res.redirect("/?google=error&m=config"); }
  });
  async function googleLoginBack(req, res) {
    res.set("cache-control", "no-store");
    const back = (ok, m = "") => res.redirect(`/?google=${ok ? "ok" : "error"}${m ? `&m=${m}` : ""}`);
    const nonce = String(req.session?.glogin?.n || ""); if (req.session) req.session.glogin = null; // de un solo uso
    const had = !!req.session?.user && req.session.mode === MODE;
    if (!googleLoginOn()) return back(false, "config");
    // dijo que no en la pantalla de Google. En la segunda vuelta (la que pide el permiso de nuevo) ya entró: sigue adentro.
    if (req.query.error) return had ? back(true) : back(false, req.query.error === "access_denied" ? "denied" : "other");
    try {
      if ((await bump(`glogin:${clientIp(req)}`, 600)) > GLOGIN_MAX) return back(false, "many"); // tope de vueltas por IP cada 10 minutos
      // el mismo state no pasa dos veces, aunque alguien se haya guardado la cookie
      if (!nonce || !(await once(`glogin:${nonce}`, 900))) throw Object.assign(new Error("state repetido"), { status: 400, code: "google_state" });
      const fin = await gmail.finishLogin({ nonce, state: String(req.query.state || ""), code: String(req.query.code || ""), redirectUri: gmailRedirect(req), domain: DOMAIN });
      const pdu = await attachPipedriveUser(fin.email);
      req.session.user = { email: fin.email, name: fin.name || pdu.pdName || fin.email.split("@")[0], picture: fin.picture || "", ...pdu };
      req.session.mode = MODE;
      req.session.gmailOk = fin.email; // Google probó que es su cuenta
      req.session.pdOk = null;
      if (fin.again) { // no quedó con qué seguir conectado: una vuelta más, pidiendo el permiso (prompt=consent), ya con su cuenta elegida
        const n2 = gmail.newNonce(), r = gmail.startLogin({ nonce: n2, redirectUri: gmailRedirect(req), consent: true, email: fin.email });
        if (r.url) { req.session.glogin = { n: n2, t: Date.now() }; return res.redirect(r.url); }
      }
      back(true);
    } catch (e) {
      if ((e.status || 500) >= 500) console.warn("Google:", e.message);
      back(false, GOOGLE_CODES[e.code] || "other");
    }
  }
  // Demo: la pantalla del Google simulado (elegís con qué cuenta entrar y qué permisos tildás). Solo con el Pipedrive de prueba
  // y el ingreso de desarrollo habilitado; con Google real estas rutas no existen.
  const demoGoogle = (req, res, next) => gmail.simulated() && DEV_OK ? next() : res.status(404).end();
  app.get("/auth/google/demo", demoGoogle, (req, res) => {
    const state = String(req.query.state || "");
    if (gmail.stateKind(state) !== "login") return res.redirect("/");
    res.set("cache-control", "no-store").type("html").send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Google simulado · OrderBrain SDR</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#FAFAFA;color:#18181b;padding:16px;box-sizing:border-box}
form{width:100%;max-width:380px;background:#fff;border:1px solid #e4e4e7;border-radius:16px;padding:22px;box-sizing:border-box;display:grid;gap:14px}
h1{font-size:18px;margin:0}p{margin:0;color:#52525b;font-size:13.5px}label{display:flex;gap:8px;align-items:flex-start}label.f{display:grid;gap:4px;font-size:13px;color:#52525b}
input[type=email]{font:inherit;padding:9px 11px;border:1px solid #d4d4d8;border-radius:10px;background:transparent;color:inherit;width:100%;box-sizing:border-box}
small{color:#71717a;display:block}.row{display:flex;flex-direction:row-reverse;gap:8px;justify-content:flex-start}button{font:inherit;font-weight:600;padding:9px 16px;border-radius:999px;border:1px solid #d4d4d8;background:transparent;color:inherit;cursor:pointer}
button.p{background:#18181b;color:#fff;border-color:#18181b}
@media (prefers-color-scheme:dark){body{background:#111214;color:#ececec}form{background:#1a1b1e;border-color:#2e3035}p,label.f{color:#a1a1aa}input[type=email],button{border-color:#3f3f46}button.p{background:#ececec;color:#111214;border-color:#ececec}}</style></head>
<body><form method="post" action="/auth/google/demo"><input type="hidden" name="state" value="${escHtml(state)}">
<h1>Google simulado (demo)</h1><p>OrderBrain SDR quiere entrar con tu cuenta y usar estos permisos. Nada sale a Google.</p>
<label class="f">Cuenta<input type="email" name="email" required value="${escHtml(DEV_EMAIL.toLowerCase())}" autocomplete="off"></label>
${gmail.PERMS.map(x => `<label><input type="checkbox" name="perms" value="${escHtml(x.key)}" checked><span><b>${escHtml(x.label)}</b><small>${escHtml(x.what)}</small></span></label>`).join("\n")}
<div class="row"><button class="p" id="demoGoogleGo">Continuar</button><button name="deny" value="1" formnovalidate>Cancelar</button></div></form></body></html>`);
  });
  app.post("/auth/google/demo", demoGoogle, express.urlencoded({ extended: false, limit: "10kb" }), (req, res) => {
    const b = req.body || {}, state = String(b.state || "");
    if (gmail.stateKind(state) !== "login") return res.redirect("/");
    const q = new URLSearchParams({ state });
    if (b.deny) q.set("error", "access_denied");
    else q.set("code", gmail.demoCode({ email: String(b.email || "").slice(0, 120), perms: [].concat(b.perms || []).map(String).slice(0, 5) }));
    res.redirect(`/auth/gmail/callback?${q}`);
  });
  app.post("/api/gmail/disconnect", auth, gmailProof, wrap(async (req, res) => { await gmail.disconnect(req.session.user.email); res.json(await gmailView(req)); }));
  // Firma propia (la misma que usás en Pipedrive): texto o HTML, se guarda saneada y manda sobre la de Gmail. Vacía = la de Gmail.
  app.post("/api/gmail/signature", auth, gmailProof, wrap(async (req, res) => {
    const raw = String(req.body?.signature ?? ""); if (raw.length > 20000) return res.status(400).json({ error: "La firma es muy larga." });
    const html = gmail.sanitizeSignature(raw);
    if (raw.trim() && !html) return res.status(400).json({ error: "No quedó nada de esa firma después de limpiarla. Pegá el texto o un HTML simple." });
    const { at, ...prev } = (await getMailPrefs(req.session.user.email).catch(() => null)) || {};
    await setMailPrefs(req.session.user.email, { ...prev, signature: html, mode: html ? "pegada" : "gmail" });
    res.json(await gmailView(req));
  }));

  // ---------- «Tu firma» (lib/signature.js): la armada con el perfil (isotipo, nombre, cargo, email | teléfono, web), la de
  // Pipedrive pegada (saneada) o, con Gmail, la de tu Gmail. Ni Pipedrive ni su MCP agregan la firma: la pone la app.
  // La URL pública de la app (el isotipo de la firma, con dirección absoluta): el host del pedido.
  const appBase = req => `${req.protocol}://${req.get("host")}`;
  async function sigInfo(req) {
    const email = req.session.user.email;
    const [prefs, pr, v] = await Promise.all([getMailPrefs(email).catch(() => null), getProfile(email).catch(() => null), viewerFor(email)]);
    const role = baseRole(pr), titleDefault = SIG.titleOf({ role, accessTitle: v.acc.title, leader: v.leader });
    const title = SIG.titleOf({ prefs, role, accessTitle: v.acc.title, leader: v.leader });
    return { prefs, titleDefault, built: SIG.builtSignature({ name: pr?.name || req.session.user.name, title, email, phone: prefs?.phone, base: appBase(req) }) };
  }
  // la firma que va por esa vía: { mode, html, source } (html null = la de Gmail)
  const mailSig = async (req, via) => { const i = await sigInfo(req); return SIG.pickSignature({ prefs: i.prefs, via, built: i.built }); };
  const gmailPick = pk => pk.html === null ? null : { html: pk.html, source: pk.source };

  // ---------- Pipedrive de cada persona (lib/pdtoken.js): «Conectá tu Pipedrive» pegando una vez su token API personal, para
  // que los mails de la ficha salgan de su casilla de Pipedrive (servidor MCP oficial, lib/pdmcp.js). Nada de esto devuelve
  // el token. La conexión guardada es de un email, pero solo la usa una sesión que probó ser esa persona: pegó su token en
  // esta sesión (pdOk; en otro dispositivo, «Confirmá que sos vos» lo pide de nuevo y tiene que ser el mismo usuario de
  // Pipedrive) o entró con Google / conectó su Gmail (gmailOk). Con el código personal (que un líder ve) no alcanza.
  const pdProven = req => { const e = String(req.session?.user?.email || "").toLowerCase(); return !!e && (req.session.pdOk === e || req.session.gmailOk === e); };
  const pdProof = (req, res, next) => pdProven(req) ? next() : res.status(409).json({ error: "Confirmá que sos vos: pegá de nuevo tu token de Pipedrive.", code: "pd_reauth" });
  async function pdView(req) {
    const u = req.session.user, i = await sigInfo(req), pk = SIG.pickSignature({ prefs: i.prefs, via: "pipedrive", built: i.built });
    return { ...(await pdtoken.status(u.email, u)), verified: pdProven(req), readOnly: READ_ONLY, pdWeb: pd.PD_WEB, tokenUrl: `${pd.PD_WEB}/settings/api`, signature: pk.html || "", signatureSource: pk.source,
      sig: { mode: pk.mode, chosen: i.prefs?.mode || "", custom: i.prefs?.signature || "", phone: i.prefs?.phone || "", title: i.prefs?.title || "", titleDefault: i.titleDefault, built: i.built } };
  }
  app.get("/api/pipedrive/mail", auth, wrap(async (req, res) => res.json(await pdView(req))));
  // Conectar o confirmar: { token }. Pipedrive dice de quién es (users/me): tiene que ser el usuario de la sesión. Con tope
  // de intentos por persona (cada intento le pregunta a Pipedrive).
  app.post("/api/pipedrive/connect", auth, wrap(async (req, res) => {
    const email = String(req.session.user.email).toLowerCase();
    if ((await bump(`pdconn:${email}`, 600)) > 12) return res.status(429).json({ error: "Muchos intentos seguidos: esperá unos minutos." });
    await pdtoken.connect({ email, user: req.session.user, token: req.body?.token });
    req.session.pdOk = email; // pegó su propio token en esta sesión: puede enviar desde acá
    res.json(await pdView(req));
  }));
  app.post("/api/pipedrive/disconnect", auth, pdProof, wrap(async (req, res) => { await pdtoken.disconnect(req.session.user.email); res.json(await pdView(req)); }));
  // Guardar «Tu firma»: { mode: armada|pegada|gmail, signature (la pegada), phone, title }. Solo una sesión que probó ser la
  // persona (igual que para enviar): nadie cambia la firma de otro.
  app.post("/api/mail/signature", auth, pdProof, wrap(async (req, res) => {
    const b = req.body || {}, email = req.session.user.email, mode = String(b.mode || "");
    if (!SIG.MODES.includes(mode)) return res.status(400).json({ error: "Elegí qué firma va en tus mails." });
    const { at, ...prev } = (await getMailPrefs(email).catch(() => null)) || {};
    const next = { ...prev, mode };
    if (b.title !== undefined) next.title = SIG.cleanLine(b.title, 80);
    if (b.phone !== undefined) { const ph = SIG.cleanPhone(b.phone); if (ph.error) return res.status(400).json({ error: ph.error }); next.phone = ph.phone; }
    if (b.signature !== undefined) {
      const raw = String(b.signature ?? ""); if (raw.length > 20000) return res.status(400).json({ error: "La firma es muy larga." });
      const html = gmail.sanitizeSignature(raw);
      if (raw.trim() && !html) return res.status(400).json({ error: "No quedó nada de esa firma después de limpiarla. Pegá el texto o un HTML simple." });
      next.signature = html;
    }
    if (mode === "pegada" && !next.signature) return res.status(400).json({ error: "Pegá tu firma de Pipedrive (Configuración personal › Correo › Firma)." });
    await setMailPrefs(email, next);
    res.json({ pipedrive: await pdView(req), gmail: await gmailView(req) });
  }));
  return { MAIL_PER_HOUR, gmailName, gmailPick, gmailProven, mailSig, pdProof, pdProven };
}
