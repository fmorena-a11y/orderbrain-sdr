import express from "express";
import crypto from "crypto";
import cookieSession from "cookie-session";
import { OAuth2Client } from "google-auth-library";
import path from "path";
import { fileURLToPath } from "url";
import * as pd from "./lib/pipedrive.js";
import { kv, key as kvKey, schools, byId, sync, flush, kvEnabled, getStudy, setStudy, withLock, addSchools, syncExtras, cacheGet, cacheSet, canonicalId, hiddenOsm, dropOsm, getProfile, setProfile, getProfiles, ROLES, syncArchived, FILE_COUNTS, getAccessMap, setAccess, getTeams, saveTeams } from "./lib/store.js";
import * as ACC from "./lib/access.js";
import * as TM from "./lib/teams.js";
import { writesPipedrive } from "./lib/readonly.js";
import { ARCHIVE_REASONS } from "./lib/archive.js";
import * as scan from "./lib/scan.js";
import { ensureBrain, brainState, brainDown, brainAdmin, saveBrainToken, brainTokenAlert, brainSites } from "./lib/brain.js";
import * as MX from "./lib/metrics.js";
import { boardFor } from "./lib/demos.js";
import { verifyCandidates, enrichSources } from "./lib/enrich.js";
import { research, studyEnabled, studyToHtml } from "./lib/study.js";
import * as sales from "./lib/sales.js";
import * as sessions from "./lib/sessions.js";
import * as ai from "./lib/ai.js";
import * as psync from "./lib/sync.js";
import { photosFor, googleEnabled } from "./lib/photos.js";
import fs from "fs";
import { MARKETS, LOST_REASONS, TYPE_LABEL, DAILY_GOAL } from "./lib/config.js";
import { safeTz, toUtc, todayIn } from "./lib/time.js";
import { composeMessage, templates } from "./lib/playbook.js";
import * as gmail from "./lib/gmail.js";
import { setMailPrefs, once, release, bump } from "./lib/store.js";

const app = express();
const escHtml = v => String(v).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const PORT = process.env.PORT || 3000;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
// Código de equipo: alternativa al login con Google. Entra quien tenga un email del dominio, sea usuario de
// Pipedrive (en modo real) y sepa el código. Con pocos intentos por IP para que no se pueda adivinar.
const TEAM_CODE = process.env.TEAM_ACCESS_CODE || "";
const DOMAIN = (process.env.ALLOWED_EMAIL_DOMAIN || (TEAM_CODE ? "ordereat.com" : "")).toLowerCase();
const DEV_EMAIL = process.env.DEV_LOGIN_EMAIL || "";
const PROD = process.env.NODE_ENV === "production";
// En modo demo (Pipedrive de prueba) se permite entrar sin Google aunque sea producción: no hay datos reales.
const DEV_OK = !!DEV_EMAIL && (!PROD || pd.DEMO);
// Las sesiones quedan atadas al modo (demo o real): al pasar a Pipedrive real, las sesiones de demo dejan de valer.
const MODE = pd.DEMO ? "demo" : "live";
const google = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

if (!process.env.SESSION_SECRET) console.warn("⚠ Falta SESSION_SECRET: las sesiones no son seguras.");
if (pd.DEMO) console.warn("⚠ DEMO_MODE: Pipedrive de prueba en memoria, nada se guarda en la cuenta real.");
else if (!process.env.PIPEDRIVE_API_TOKEN) console.warn("⚠ Falta PIPEDRIVE_API_TOKEN: no va a funcionar nada de Pipedrive.");
if (!ai.aiEnabled()) console.warn("⚠ Falta ANTHROPIC_API_KEY: el asistente, los briefs y el ordenado de notas quedan apagados.");

app.set("trust proxy", 1);
app.use(express.json({ limit: "200kb" }));
// lo que no pasa del lector de JSON también se contesta en JSON (no con la página de error de Express)
app.use((err, req, res, next) => err?.type === "entity.too.large" ? res.status(413).json({ error: "Es demasiado para mandar de una vez." })
  : err?.type === "entity.parse.failed" ? res.status(400).json({ error: "No entendí lo que mandó el navegador." }) : next(err));
app.use(cookieSession({
  name: "obsdr", keys: [process.env.SESSION_SECRET || "dev-only-secret"], maxAge: 14 * 864e5,
  sameSite: "lax", secure: PROD, httpOnly: true,
}));
if (process.env.VERCEL && !kvEnabled) console.warn("⚠ Sin Redis (KV_REST_API_URL): en Vercel la meta, el ranking y la cadencia se reinician cada tanto.");
// Antes de responder, espera que se guarden las escrituras pendientes (en Vercel la función se congela después).
app.use((req, res, next) => {
  const json = res.json.bind(res);
  // si lo que se manda no se puede pasar a JSON (o falla al mandar), 500 en vez de un rechazo suelto que tira el proceso
  const send = body => { try { json(body); } catch (e) { console.error(e); if (!res.headersSent) try { res.status(500); json({ error: "No pudimos armar la respuesta." }); } catch { /* nada más que hacer */ } } };
  res.json = body => { flush().then(() => send(body), () => send(body)); return res; };
  next();
});
// Trae de Redis lo que registraron otras instancias.
app.use("/api", (req, res, next) => { // x-brain-down: cada respuesta dice si ESTA instancia tiene los clientes de World Dominion (si no, el navegador avisa)
  Promise.all([sync(), syncExtras(), syncArchived(), ensureBrain()]).finally(() => { res.setHeader("x-brain-down", brainDown() ? "1" : "0"); next(); }); });

// ---------- auth
async function attachPipedriveUser(email) {
  try { const m = await pd.meta(); const u = m.users.find(x => x.email === email.toLowerCase()); return u ? { pdUserId: u.id, pdName: u.name } : {}; }
  catch { return {}; }
}
app.get("/auth/config", (req, res) => res.json({ googleClientId: GOOGLE_CLIENT_ID, devLogin: DEV_OK, codeLogin: !!TEAM_CODE, domain: DOMAIN, demo: pd.DEMO }));
// Acceso de líder (lib/access.js) y equipos (lib/teams.js). Fijo (no se saca desde la app): quien conectó Pipedrive (dueño
// del token) y LEADER_EMAILS son líderes, FOUNDER_EMAILS dirección; los dos ven todos los equipos y los arman. Lo demás lo
// asigna dirección en Equipo (getAccessMap, getTeams). Con equipos, un líder de equipo ve y toca solo lo de su gente.
// El rol no se elige en el perfil: lo define esto.
const LEADERS = ACC.parseEmails(process.env.LEADER_EMAILS), FOUNDERS = ACC.parseEmails(process.env.FOUNDER_EMAILS);
const ownerEmail = async () => { try { return (await pd.tokenOwner()).email || ""; } catch { return ""; } };
const fixedOf = (email, owner) => ACC.fixedLevel(email, { owner, leaders: LEADERS, founders: FOUNDERS });
const lc = e => String(e || "").trim().toLowerCase();
// quién mira: acceso, si es admin (dirección o fijo), si ve todo (all), qué equipos lidera y de cuál es miembro
async function viewerFor(email, { fresh = false } = {}) {
  email = lc(email);
  const [owner, map, raw] = await Promise.all([ownerEmail(), getAccessMap({ fresh }), getTeams({ fresh })]);
  const T = TM.normTeams(raw);
  return { ...TM.viewerOf({ email, fixed: fixedOf(email, owner), assigned: map[email] || null, T }), T, map, owner };
}
const otherViewer = (v, email, T = v.T) => TM.viewerOf({ email, fixed: fixedOf(email, v.owner), assigned: v.map[lc(email)] || null, T });
// sobre lo de quién actúa como líder: true (todos), false (solo lo suyo) o { ids, emails } (la gente de sus equipos sin acceso
// de líder: ni otro líder, ni dirección, ni un fijo, aunque estén en su equipo; eso lo hace un admin)
const scopeOf = (v, users) => TM.leadScope(v, v.T, users, { isLead: e => otherViewer(v, e).leader });
async function leadScopeFor(email) {
  const v = await viewerFor(email); if (!v.leader) return false; if (v.all) return true;
  return scopeOf(v, (await pd.meta()).users);
}
const httpErr = e => Object.assign(new Error(e.error), { status: e.status });
// Código personal: cada persona entra con su email y SU código (derivado del email con la clave del servidor),
// así nadie entra como otro sabiendo un código compartido. El código del equipo (TEAM_ACCESS_CODE) solo sirve para los
// fijos (dueño del token, LEADER_EMAILS, FOUNDER_EMAILS): con equipos, un líder que lo tuviera entraría como dirección o
// como el líder de otro equipo. Los líderes de equipo y la dirección asignada en la app entran con su código personal.
const B32 = "abcdefghjkmnpqrstuvwxyz23456789";
function personalCode(email) {
  const h = crypto.createHmac("sha256", SCAN_SECRET).update("code:" + String(email).toLowerCase()).digest();
  const c = [...h.subarray(0, 8)].map(x => B32[x % B32.length]).join("");
  return `${c.slice(0, 4)}-${c.slice(4)}`;
}
const same = (a, b) => { const x = crypto.createHash("sha256").update(String(a)).digest(), y = crypto.createHash("sha256").update(String(b)).digest(); return crypto.timingSafeEqual(x, y); };
// Intentos fallidos: se cuentan en Redis (todas las instancias) por IP y por email, antes de comparar el código
const memTries = new Map();
async function tooMany(keys) {
  if (kvEnabled) {
    try { const r = await kv(keys.flatMap(k => [["INCR", kvKey("rl:" + k)], ["EXPIRE", kvKey("rl:" + k), "900"]])); return r.filter((_, i) => i % 2 === 0).some(n => Number(n) > 8); } catch {}
  }
  const now = Date.now(); let over = false;
  for (const k of keys) { const t = memTries.get(k); const n = t && t.until > now ? t.n + 1 : 1; memTries.set(k, { n, until: now + 900e3 }); if (n > 8) over = true; }
  return over;
}
async function clearTries(keys) { if (kvEnabled) await kv(keys.map(k => ["DEL", kvKey("rl:" + k)])).catch(() => {}); keys.forEach(k => memTries.delete(k)); }
app.post("/auth/code", async (req, res) => {
  if (!TEAM_CODE) return res.status(404).end();
  const ip = String(req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim();
  const email = String(req.body?.email || "").trim().toLowerCase(), code = String(req.body?.code || "").trim().toLowerCase();
  const keys = ["ip:" + ip, "em:" + email];
  if (await tooMany(keys)) return res.status(429).json({ error: "Demasiados intentos. Probá de nuevo en 15 minutos." });
  const validEmail = /^[^@\s]+@[^@\s]+$/.test(email) && (!DOMAIN || email.endsWith("@" + DOMAIN));
  const ok = validEmail && (same(code, personalCode(email)) || (same(code, TEAM_CODE.toLowerCase()) && ACC.teamCodeOk(fixedOf(email, await ownerEmail()))));
  await new Promise(r => setTimeout(r, 400));
  if (!ok) return res.status(401).json({ error: DOMAIN && email && !email.endsWith("@" + DOMAIN) ? `Usá tu email @${DOMAIN}.` : "Email o código incorrecto. Tu código personal te lo pasa el líder del equipo." });
  await clearTries(keys);
  const pdu = await attachPipedriveUser(email);
  // con el Pipedrive real, solo entran los usuarios de la cuenta
  if (MODE === "live" && !pdu.pdUserId) return res.status(403).json({ error: "Ese email no es usuario del Pipedrive de OrderEAT." });
  req.session.user = { email, name: pdu.pdName || email.split("@")[0], ...pdu };
  req.session.mode = MODE;
  // con un código no se probó ser dueño de la cuenta de Google: para mandar mails hay que conectar Gmail en esta sesión
  req.session.gmailOk = null;
  res.json({ user: req.session.user });
});
app.post("/auth/google", async (req, res) => {
  try {
    if (!google) return res.status(500).json({ error: "El login con Google no está configurado (GOOGLE_CLIENT_ID)." });
    const t = await google.verifyIdToken({ idToken: req.body.credential, audience: GOOGLE_CLIENT_ID });
    const p = t.getPayload();
    if (!p.email_verified) return res.status(403).json({ error: "Tu email de Google no está verificado." });
    if (DOMAIN && !p.email.toLowerCase().endsWith("@" + DOMAIN)) return res.status(403).json({ error: `Solo pueden entrar cuentas @${DOMAIN}.` });
    req.session.user = { email: p.email.toLowerCase(), name: p.name || p.email, picture: p.picture || "", ...(await attachPipedriveUser(p.email)) };
    req.session.mode = MODE;
    req.session.gmailOk = p.email.toLowerCase(); // Google probó que es su cuenta: puede enviar con el Gmail que conectó
    res.json({ user: req.session.user });
  } catch { res.status(401).json({ error: "No se pudo validar el login de Google." }); }
});
app.post("/auth/dev", async (req, res) => {
  if (!DEV_OK) return res.status(404).end();
  const pdu = await attachPipedriveUser(DEV_EMAIL);
  req.session.user = { email: DEV_EMAIL.toLowerCase(), name: pdu.pdName || DEV_EMAIL.split("@")[0], ...pdu };
  req.session.mode = MODE;
  req.session.gmailOk = null;
  res.json({ user: req.session.user });
});
app.post("/auth/logout", (req, res) => { req.session = null; res.json({ ok: true }); });

const auth = (req, res, next) => {
  if (!req.session?.user) return res.status(401).json({ error: "Iniciá sesión." });
  if (req.session.mode !== MODE || (DOMAIN && !req.session.user.email.endsWith("@" + DOMAIN) && MODE === "live")) { req.session = null; return res.status(401).json({ error: "Iniciá sesión." }); }
  req.tz = safeTz(req.get("x-tz"));
  next();
};
// Historial: lo que la app escribe de una ficha (contactos, mails, comentarios, tratos, actividades) cambia la versión de su
// línea de tiempo en el store (todas las instancias dejan de usar su copia), antes de escribir y otra vez justo antes de
// responder (la escritura en Redis se espera con flush), así el próximo pedido la vuelve a leer de Pipedrive.
const dropOnWrite = idOf => (req, res, next) => {
  if (req.method === "GET") return next();
  const id = idOf(req); sales.dropTimeline(id);
  const json = res.json.bind(res); res.json = body => { sales.dropTimeline(id); return json(body); };
  next();
};
app.use("/api/schools/:id", dropOnWrite(req => req.params.id));
app.use("/api/activities", dropOnWrite(() => null));
// READ_ONLY=1: nada se escribe en Pipedrive (para probar contra la cuenta real sin tocarla). Las rutas, en lib/readonly.js.
if (process.env.READ_ONLY === "1") app.use((req, res, next) => writesPipedrive(req.method, req.path) ? res.status(403).json({ error: "Modo solo lectura: no se escribe en Pipedrive." }) : next());
const wrap = fn => (req, res) => fn(req, res).catch(e => {
  if (res.writableEnded || res.destroyed) return; // el navegador ya cortó (canceló): no hay a quién responder
  const status = e.status && e.status < 600 ? (e instanceof pd.PipedriveError && e.status >= 500 ? 502 : e.status) : 500;
  if (status >= 500) console.error(e);
  // code: un identificador corto para que el navegador sepa qué hacer (gmail_reauth, gmail_unknown…); nunca datos
  const code = typeof e.code === "string" && /^[a-z][a-z_]{1,40}$/.test(e.code) ? { code: e.code } : {};
  res.status(status).json({ error: e instanceof pd.PipedriveError ? `Pipedrive: ${e.message}` : e.message, ...code });
});
// Cada uno cambia solo sus actividades (marcar hecha, deshacer, reprogramar); un líder, las de la gente de sus equipos
// (dirección y los fijos, o cualquier líder si no hay equipos: todas).
async function ownActivity(user, id, { missingOk } = {}) {
  const a = await pd.getActivity(Number(id));
  if (!a && missingOk) return null;
  if (!a) throw Object.assign(new Error("No encontré esa actividad en Pipedrive."), { status: 404 });
  const owner = a.owner_id ?? a.user_id ?? a.assigned_to_user_id ?? null;
  if (owner && user.pdUserId && Number(owner) === Number(user.pdUserId)) return a;
  if (TM.canLead(await leadScopeFor(user.email), { id: owner })) return a;
  throw Object.assign(new Error("Esa actividad es de otra persona en Pipedrive: no la podés cambiar."), { status: 403 });
}
// Lo mismo con los tratos: solo el dueño del trato (owner_id/user_id) o un líder (de un equipo: si el dueño es de su gente).
async function ownDeal(user, id) {
  const d = await pd.getDeal(Number(id));
  if (!d) throw Object.assign(new Error("No encontré ese trato en Pipedrive."), { status: 404 });
  const owner = d.owner_id ?? d.user_id ?? null;
  if (owner && user.pdUserId && Number(owner) === Number(user.pdUserId)) return d;
  if (TM.canLead(await leadScopeFor(user.email), { id: owner })) return d;
  throw Object.assign(new Error("Ese trato es de otra persona en Pipedrive: no lo podés cambiar."), { status: 403 });
}
// las fichas de Pipedrive (prospectos y organizaciones fuera de la base) se rearman si esta instancia no las tiene
const schoolParam = (req, res, next) => {
  const go = () => { req.params.id = canonicalId(req.params.id); next(); };
  if (byId.has(req.params.id)) return go();
  sales.ensureRecord(req.params.id).then(ok => ok ? go() : res.status(404).json({ error: "Colegio inexistente" }), () => res.status(404).json({ error: "Colegio inexistente" }));
};

// ---------- API
// Perfil: nombre completo y rol. Si la persona ya lo cargó, manda sobre el nombre que viene de Google o Pipedrive.
// «Líder» y «Dirección» los define el servidor (viewerFor); el perfil solo elige entre SDR y Account Executive (el rol base,
// que vuelve a valer si le sacan el acceso). role: "lider" para los dos (lo que miran los permisos); roleLabel lo que se
// muestra: «Dirección · CEO», «Líder · SDR México», «SDR · SDR México» (con equipos) o «Líder», «SDR» (sin equipos).
const baseRole = pr => pr?.role && pr.role !== "lider" && Object.hasOwn(ROLES, pr.role) ? pr.role : "";
const labelOf = (acc, T, email, pr) => TM.roleLabel({ acc, T, email, base: ROLES[baseRole(pr)] || "" });
const withProfile = (u, pr, v) => {
  const role = v.leader ? "lider" : baseRole(pr);
  return { ...u, ...(pr ? { name: pr.name } : {}), role, roleLabel: labelOf(v.acc, v.T, u.email, pr), access: v.acc.level, title: v.acc.title };
};
const accessView = acc => ({ level: acc.level, label: ACC.accessLabel(acc), title: acc.title, fixed: acc.fixed, by: acc.by, at: acc.at, ...(acc.stale ? { stale: true } : {}) });
// Lo que sabe el navegador de los equipos de quien mira: si hay equipos, si es admin o ve todo, qué equipos puede elegir
// (Métricas y Equipo) y sobre la gente de quién actúa como líder (lead: "all" o { ids, emails }; un miembro, null).
async function scopeView(v) {
  const m = await pd.meta().catch(() => ({ users: [] })), nm = id => TM.teamById(v.T, id)?.name || "";
  return { on: v.on, admin: v.admin, all: v.all, led: v.led.map(id => ({ id, name: nm(id) })), member: v.member ? { id: v.member, name: nm(v.member) } : null,
    teams: TM.viewableTeams(v, v.T).map(t => ({ id: t.id, name: t.name })), lead: TM.scopeOut(scopeOf(v, m.users)), ...(v.unknown ? { unknown: true } : {}) };
}
// el rol al día (no el de la sesión, que puede ser de antes de que le dieran o sacaran el acceso) y sobre quién actúa como líder
const liveUser = async user => { const v = await viewerFor(user.email); return { ...user, role: v.leader ? "lider" : user.role === "lider" ? "" : user.role, leads: v.leader ? v.all || scopeOf(v, (await pd.meta()).users) : false }; };
app.get("/api/me", auth, wrap(async (req, res) => {
  const [pr, v] = await Promise.all([getProfile(req.session.user.email), viewerFor(req.session.user.email)]);
  req.session.user = withProfile(req.session.user, pr, v);
  const roles = v.leader ? { lider: ROLES.lider } : { sdr: ROLES.sdr, ae: ROLES.ae };
  res.json({
  user: req.session.user, profile: { complete: !!(pr?.name && (baseRole(pr) || v.leader || v.acc.stale)), suggested: req.session.user.pdName || "", roles, leader: v.leader, access: accessView(v.acc), scope: await scopeView(v) }, ai: ai.aiEnabled(), study: studyEnabled(), demo: pd.DEMO, goal: DAILY_GOAL, pdWeb: pd.PD_WEB, sessionMax: sessions.MAX_ITEMS,
  countries: [...new Set(schools.map(s => s.country))].sort(), markets: MARKETS, outcomes: sales.OUTCOMES, lostReasons: LOST_REASONS, archiveReasons: ARCHIVE_REASONS, types: TYPE_LABEL,
  });
}));
app.post("/api/me/profile", auth, wrap(async (req, res) => {
  const name = String(req.body?.name || "").replace(/\s+/g, " ").trim().slice(0, 80), role = String(req.body?.role || "");
  if (name.split(" ").filter(w => w.length > 1).length < 2) return res.status(400).json({ error: "Escribí tu nombre y apellido." });
  // Líder y Dirección no se eligen: con acceso de líder se guarda el rol base que tenía (o «lider» si nunca eligió)
  const [v, prev] = await Promise.all([viewerFor(req.session.user.email), getProfile(req.session.user.email)]);
  const r = v.leader ? baseRole(prev) || "lider" : role;
  if (!Object.hasOwn(ROLES, r) || (r === "lider" && !v.leader)) return res.status(400).json({ error: "Elegí tu rol en el equipo (SDR o Account Executive)." });
  const pr = await setProfile(req.session.user.email, { name, role: r });
  req.session.user = withProfile(req.session.user, pr, v);
  res.json({ user: req.session.user });
}));
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
app.get("/api/gmail", auth, wrap(async (req, res) => res.json({ ...(await gmail.status(req.session.user.email, await gmailName(req.session.user))), verified: gmailProven(req), readOnly: process.env.READ_ONLY === "1" })));
// La ventana de Google termina en esta página: le avisa a la app (BroadcastChannel y, si sigue el vínculo, postMessage) y se
// cierra. Si no se abrió en otra ventana (el navegador la bloqueó), vuelve a la app con ?gmail=…
// En la dirección de vuelta va solo un código (state|mismatch|denied|scope|config|session|other): el navegador lo traduce
// a un texto fijo, así nadie arma un link que muestre su propio texto dentro de la app.
const GMAIL_CODES = { gmail_state: "state", gmail_mismatch: "mismatch", gmail_scope: "scope" };
const gmailCode = e => GMAIL_CODES[e?.code] || (e?.status === 404 ? "config" : "other");
function gmailDone(res, r, popup = false) {
  const data = JSON.stringify({ type: "ob-gmail", ok: !!r.ok, ...(r.ok ? { email: r.email } : { code: r.code || "other", error: r.error || "" }) }).replace(/</g, "\\u003c");
  const back = `/?gmail=${r.ok ? "ok" : "error"}${r.ok ? "" : `&m=${encodeURIComponent(r.code || "other")}`}`;
  const msg = r.ok ? `Gmail conectado como ${r.email}.${popup ? " Ya podés cerrar esta ventana." : ""}` : r.error || "No se pudo conectar Gmail.";
  res.set("cache-control", "no-store").type("html").send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Gmail · OrderBrain SDR</title>
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
    const fin = await gmail.finishConnect({ email: user.email, nonce: req.session.gmailNonce, demoAs: r.gmailEmail });
    req.session.gmailNonce = null; req.session.gmailOk = String(user.email).toLowerCase();
    gmailDone(res, { ok: true, email: fin.email }, popup);
  } catch (e) { req.session.gmailNonce = null; gmailDone(res, { ok: false, error: e.message, code: gmailCode(e) }, popup); }
});
app.get("/auth/gmail/callback", async (req, res) => {
  const user = req.session?.user, popup = !!req.session?.gmailPopup;
  if (!user || req.session.mode !== MODE) return gmailDone(res, { ok: false, error: "Iniciá sesión en la app y conectá Gmail de nuevo.", code: "session" });
  const nonce = req.session.gmailNonce; req.session.gmailNonce = null; req.session.gmailPopup = null;
  if (req.query.error) return gmailDone(res, req.query.error === "access_denied" ? { ok: false, error: "No diste permiso: el mail no se puede enviar desde acá. Podés seguir con «Abrir en Gmail».", code: "denied" } : { ok: false, error: "Google no completó la conexión. Probá de nuevo.", code: "other" }, popup);
  try {
    const fin = await gmail.finishConnect({ email: user.email, nonce, state: String(req.query.state || ""), code: String(req.query.code || ""), redirectUri: gmailRedirect(req) });
    req.session.gmailOk = String(user.email).toLowerCase(); // probó ante Google que la cuenta es suya: esta sesión puede enviar
    gmailDone(res, { ok: true, email: fin.email }, popup);
  } catch (e) { if ((e.status || 500) >= 500) console.warn("Gmail:", e.message); gmailDone(res, { ok: false, error: e.message, code: gmailCode(e) }, popup); }
});
app.post("/api/gmail/disconnect", auth, gmailProof, wrap(async (req, res) => { await gmail.disconnect(req.session.user.email); res.json({ ...(await gmail.status(req.session.user.email, await gmailName(req.session.user))), verified: gmailProven(req) }); }));
// Firma propia (la misma que usás en Pipedrive): texto o HTML, se guarda saneada y manda sobre la de Gmail. Vacía = la de Gmail.
app.post("/api/gmail/signature", auth, gmailProof, wrap(async (req, res) => {
  const raw = String(req.body?.signature ?? ""); if (raw.length > 20000) return res.status(400).json({ error: "La firma es muy larga." });
  const html = gmail.sanitizeSignature(raw);
  if (raw.trim() && !html) return res.status(400).json({ error: "No quedó nada de esa firma después de limpiarla. Pegá el texto o un HTML simple." });
  await setMailPrefs(req.session.user.email, { signature: html });
  res.json({ ...(await gmail.status(req.session.user.email, await gmailName(req.session.user))), verified: gmailProven(req) });
}));

// ficha de un prospecto (lead) o de una organización de Pipedrive que no está en la base
app.get("/api/records/:kind/:rid", auth, wrap(async (req, res) => {
  if (!["lead", "org"].includes(req.params.kind)) return res.status(400).json({ error: "Ficha inválida" });
  res.json(await sales.openRecord(req.params.kind, req.params.rid));
}));
app.get("/api/schools", auth, (req, res) => res.json(schools.map(sales.schoolListItem)));
// Accesos del equipo (líderes y dirección): el código personal de cada persona, para pasárselo, su acceso (Miembro · Líder ·
// Dirección con cargo) y su equipo. Dirección y los fijos ven a todos y cambian accesos y equipos; un líder de equipo ve a su
// gente (con código) y a la gente sin equipo (free, sin código: para sumarla). Lo fijo (dueño del token, LEADER_EMAILS,
// FOUNDER_EMAILS) se muestra sin poder bajarlo. A quien no es admin nunca le llega el código de alguien con acceso de líder,
// de dirección o fijo (aunque sea colíder o haya quedado en su equipo): con ese código entraría como esa persona.
const teamUsers = m => m.users.filter(u => u.email && (!DOMAIN || u.email.endsWith("@" + DOMAIN)));
async function accessRows(v) {
  const [m, prs] = await Promise.all([pd.meta(), getProfiles()]), T = v.T;
  const rowOf = u => {
    const e = lc(u.email), o = otherViewer(v, e), hide = !TM.showsCode(v, o);
    return { id: u.id, name: prs[e]?.name || u.name, email: e, code: hide ? null : personalCode(e), role: labelOf(o.acc, T, e, prs[e]), me: e === v.email,
      access: accessView(o.acc), team: { member: o.member, led: o.led }, choices: v.admin ? ACC.accessChoices({ actorEmail: v.email, targetEmail: e, target: o.acc }) : null };
  };
  const users = teamUsers(m);
  if (v.admin || !v.on) return { users: users.map(rowOf), free: [] };
  const mine = new Set(v.led.flatMap(id => TM.peopleOf(TM.teamById(T, id))));
  const free = users.filter(u => !mine.has(lc(u.email)) && !TM.teamOfPerson(T, u.email)).map(rowOf).filter(r => !r.access.fixed && r.access.level === "equipo")
    .map(({ id, name, email, role }) => ({ id, name, email, role }));
  return { users: users.filter(u => mine.has(lc(u.email))).map(rowOf), free };
}
const teamList = T => TM.sortedTeams(T).map(t => ({ id: t.id, name: t.name }));
app.get("/api/team/codes", auth, wrap(async (req, res) => {
  const v = await viewerFor(req.session.user.email);
  if (!v.leader) return res.status(403).json({ error: "Solo un líder o alguien de dirección ve los accesos del equipo." });
  res.json({ url: `${req.protocol}://${req.get("host")}`, on: v.on, admin: v.admin, teams: v.admin ? teamList(v.T) : teamList(v.T).filter(t => v.led.includes(t.id)), ...(await accessRows(v)) });
}));
// Cambios de equipos y accesos: de a uno entre instancias (withLock), releyendo todo adentro. No escriben en Pipedrive.
const TEAMS_BUSY = { busy: "Otra persona está cambiando los equipos. Probá de nuevo en unos segundos." };
const byNameOf = async user => (await signName(user)) || user.name || user.email;
// Cambiar el acceso de una persona (solo dirección o un líder fijo): { email, level: equipo|lider|direccion, title, team }.
// team (con equipos): miembro → de ese equipo ("" ninguno) y deja de liderar; líder → lidera ese equipo (obligatorio si no
// lidera ninguno); dirección → sale de todos los equipos (está arriba de todos). Sin team, el equipo no cambia. Reglas:
// lib/access.js changeError.
app.post("/api/team/access", auth, wrap(async (req, res) => {
  const me = lc(req.session.user.email), pre = await viewerFor(me, { fresh: true });
  if (!pre.admin) return res.status(403).json({ error: pre.leader ? "Los accesos los cambia dirección. Vos sumás o sacás gente de tu equipo." : "Solo dirección cambia los accesos del equipo." });
  const email = lc(req.body?.email), level = String(req.body?.level || ""), team = req.body?.team == null ? undefined : String(req.body.team);
  const known = teamUsers(await pd.meta()).some(u => lc(u.email) === email), byName = await byNameOf(req.session.user);
  await withLock("teams", async () => {
    const v = await viewerFor(me, { fresh: true }), T = v.T, t = otherViewer(v, email);
    if (team && !TM.teamById(T, team)) throw httpErr({ status: 404, error: "Ese equipo ya no existe." });
    const err = ACC.changeError({ actorEmail: me, actor: v.acc, targetEmail: email, target: t.acc, level, known, teams: v.on, team, leads: t.led.length });
    if (err) throw httpErr(err);
    let N = null;
    if (v.on && level === "equipo" && (team !== undefined || t.led.length)) N = TM.placeMember(T, email, team !== undefined ? team || null : t.member);
    else if (v.on && level === "lider" && team) N = TM.placeLeader(T, email, team, { isDir: e => fixedOf(e, v.owner) === "direccion" });
    else if (v.on && level === "lider" && team === "") N = TM.placeMember(T, email, null); // un líder fijo sin equipo
    else if (v.on && level === "direccion" && (t.member || t.led.length)) N = TM.placeMember(T, email, null);
    if (N?.error) throw httpErr(N.error);
    await setAccess(email, ACC.accessRecord({ level, title: req.body?.title, by: me, byName, at: new Date().toISOString() }));
    if (N) await saveTeams(TM.normTeams(N.T));
  }, TEAMS_BUSY);
  const v = await viewerFor(me), r = await accessRows(v);
  res.json({ user: r.users.find(u => u.email === email), users: r.users, teams: teamList(v.T) });
}));
app.get("/api/team", auth, wrap(async (req, res) => {
  const [m, prs, v] = await Promise.all([pd.meta(), getProfiles(), viewerFor(req.session.user.email)]);
  res.json(m.users.map(u => { const e = lc(u.email), pr = prs[e]; return { id: u.id, name: pr?.name || u.name, role: labelOf(otherViewer(v, e).acc, v.T, e, pr), team: TM.teamOfPerson(v.T, e) }; }));
}));
// ---------- Equipos (lib/teams.js): dirección (y los fijos) los crean, renombran y borran y eligen sus líderes; el líder de
// un equipo suma o saca miembros (gente sin equipo). Cada uno ve los suyos (dirección, todos). Después de cada cambio, el
// acceso guardado de quien empezó o dejó de liderar queda igual a lo que lidera (accessSync).
async function teamsOut(v, T = v.T) {
  const [m, prs] = await Promise.all([pd.meta(), getProfiles()]), users = new Map(m.users.map(u => [lc(u.email), u]));
  const person = e => ({ email: e, name: prs[e]?.name || users.get(e)?.name || e, id: users.get(e)?.id || null });
  const w = { ...v, ...otherViewer(v, v.email, T) };
  const all = teamUsers(m).map(u => lc(u.email)).map(e => ({ e, o: otherViewer(v, e, T) }));
  // dirección no se suma a ningún equipo: no se ofrece
  const cands = all.filter(x => x.e !== w.email && x.o.acc.level !== "direccion").map(({ e, o }) => ({ ...person(e), team: TM.teamOfPerson(T, e), member: o.member, led: o.led, leads: o.led.length > 0, level: o.acc.level, fixed: !!o.acc.fixed }));
  return { on: TM.hasTeams(T), admin: w.admin, teams: TM.teamsView(w, T, person),
    // para elegir: dirección, toda la gente (con su equipo); un líder de equipo, la gente sin equipo y sin acceso de líder
    people: w.admin ? cands : w.led.length ? cands.filter(c => !c.team && c.level === "equipo" && !c.fixed) : [],
    // a dirección: quienes eran líderes antes de los equipos y todavía no lideran uno (sin equipo no ven Métricas)
    stale: w.admin && TM.hasTeams(T) ? all.filter(x => x.o.acc.stale).map(x => person(x.e)) : [] };
}
app.get("/api/teams", auth, wrap(async (req, res) => res.json(await teamsOut(await viewerFor(req.session.user.email)))));
async function changeTeams(req, fn) {
  const me = lc(req.session.user.email), byName = await byNameOf(req.session.user);
  const { v, T } = await withLock("teams", async () => {
    const v = await viewerFor(me, { fresh: true }), r = await fn(v, v.T);
    if (r.error) throw httpErr(r.error);
    const N = TM.normTeams(r.T), at = new Date().toISOString();
    for (const x of TM.accessSync(v.T, N, v.map)) await setAccess(x.email, ACC.accessRecord({ level: x.level, by: me, byName, at }));
    await saveTeams(N);
    return { v, T: N };
  }, TEAMS_BUSY);
  return teamsOut({ ...v, map: await getAccessMap() }, T);
}
const tid = () => "t" + crypto.randomBytes(6).toString("hex");
app.post("/api/teams", auth, wrap(async (req, res) => {
  const v0 = await viewerFor(req.session.user.email); const e = TM.adminError(v0); if (e) return res.status(e.status).json({ error: e.error });
  const by = await byNameOf(req.session.user);
  res.json(await changeTeams(req, (v, T) => TM.adminError(v) ? { error: TM.adminError(v) } : TM.createTeam(T, { id: tid(), name: req.body?.name, by, at: new Date().toISOString() })));
}));
// { name } renombra; { leaders: [emails] } deja esos líderes (los de otros equipos siguen liderando aquellos; si eran miembros, dejan su equipo)
app.patch("/api/teams/:tid", auth, wrap(async (req, res) => {
  const v0 = await viewerFor(req.session.user.email); const e = TM.adminError(v0); if (e) return res.status(e.status).json({ error: e.error });
  const b = req.body || {}, known = new Set(teamUsers(await pd.meta()).map(u => lc(u.email)));
  if (b.name === undefined && !Array.isArray(b.leaders)) return res.status(400).json({ error: "No hay nada para cambiar." });
  res.json(await changeTeams(req, (v, T) => {
    if (TM.adminError(v)) return { error: TM.adminError(v) };
    let r = { T };
    if (b.name !== undefined) r = TM.renameTeam(r.T, req.params.tid, b.name);
    if (!r.error && Array.isArray(b.leaders)) r = TM.setLeaders(r.T, req.params.tid, b.leaders.slice(0, 20), { known: x => known.has(x), isDir: x => otherViewer(v, x, T).acc.level === "direccion" });
    return r;
  }));
}));
app.delete("/api/teams/:tid", auth, wrap(async (req, res) => {
  const v0 = await viewerFor(req.session.user.email); const e = TM.adminError(v0); if (e) return res.status(e.status).json({ error: e.error });
  res.json(await changeTeams(req, (v, T) => TM.adminError(v) ? { error: TM.adminError(v) } : TM.deleteTeam(T, req.params.tid)));
}));
// { email, action: "add" | "remove" }: el líder de ESE equipo o dirección. Un miembro, 403; el líder de otro equipo, 403.
app.post("/api/teams/:tid/members", auth, wrap(async (req, res) => {
  const v0 = await viewerFor(req.session.user.email);
  if (!v0.leader) return res.status(403).json({ error: "Solo el líder del equipo o dirección cambia quién está en el equipo." });
  const email = lc(req.body?.email), add = req.body?.action === "add";
  if (!add && req.body?.action !== "remove") return res.status(400).json({ error: "¿Sumar o sacar?" });
  const known = teamUsers(await pd.meta()).some(u => lc(u.email) === email);
  res.json(await changeTeams(req, (v, T) => TM.memberChange(v, T, { teamId: req.params.tid, email, add, known, target: otherViewer(v, email).acc })));
}));

// Lo de líder que se mira por equipo (Métricas, Equipo): ?team= (lib/teams.js pickTeam). Un líder de otro equipo, 403.
const teamInfo = (T, id) => id ? { id, name: TM.teamById(T, id)?.name || "" } : null;
async function viewTeam(req) {
  const v = await viewerFor(req.session.user.email), m = await pd.meta();
  const f = TM.viewFilter(v, v.T, m.users, String(req.query.team || ""));
  if (f.error) throw httpErr(f.error);
  return { v, filter: f.filter, team: teamInfo(v.T, f.id), self: !!f.self, unknown: !!f.unknown };
}
// Demos de la semana: las cargadas en Pipedrive, quién la cargó, quién la da y el resultado. Sin ranking: cuántas cargó
// cada uno solo lo ve un líder; los demás reciben lo suyo y el total (boardFor). Con equipos, solo las de su gente
// (un líder: el equipo elegido; un miembro: su equipo; sin equipo: las suyas).
app.get("/api/team/demos", auth, wrap(async (req, res) => {
  const t = await viewTeam(req), r = await sales.teamDemos(req.tz, t.filter);
  res.json({ ...boardFor(r, { leader: t.v.leader, me: req.session.user.pdUserId }), team: t.team, self: t.self, ...(t.unknown ? { unknown: true } : {}) });
}));
// ---------- Métricas (vista Métricas): solo líderes y dirección (los totales, lo suyo y el desglose por persona; a los demás,
// 403 antes de leer nada). Con equipos, todo es del equipo elegido (?team=, lib/teams.js pickTeam): totales y por persona,
// solo su gente; dirección elige un equipo o «Toda la cuenta»; un líder de equipo, solo los suyos (otro equipo: 403). La base de
// colegios y los clientes de World Dominion son de toda la cuenta. Pipedrive se lee de a páginas y se guarda 10 minutos
// (lib/sales.js); los cálculos están en lib/metrics.js. Cada respuesta dice de cuándo es y si la lista vino cortada (partial).
const mxOpts = (req, team = null) => ({ days: Number(req.query.days) || 7, country: String(req.query.country || "").slice(0, 60), team });
const MX_LOAD = {
  demos: (req, team) => sales.metricsDemos(req.tz, mxOpts(req, team)),
  deals: (req, team) => sales.metricsDeals(req.tz, mxOpts(req, team)),
  contacts: (req, team) => sales.metricsContacts(req.tz, mxOpts(req, team)),
  archived: (req, team) => sales.metricsArchived(req.tz, mxOpts(req, team)),
  // actividad por persona: todo es por persona (solo líderes); el país no aplica (una actividad no dice de qué país es)
  activity: (req, team) => sales.metricsActivity(req.tz, mxOpts(req, team)),
  // base de colegios: exacto (la lista de la app); los estados del cruce no van hasta comprobarlos con una muestra
  base: async req => { const { country } = mxOpts(req), sy = await psync.status().catch(() => null), st = radarState();
    return { country, at: new Date().toISOString(), ...MX.baseSummary(schools, { country }), file: FILE_COUNTS, added: schools.length - FILE_COUNTS.shown, radarAt: st.runs?.[0]?.at || null, syncAt: sy?.last?.finishedAt || null }; },
  // clientes de OrderEAT: los sitios de World Dominion tal cual (sin token: no se inventa nada)
  // World Dominion caído y sin copia (o sin ninguna lectura): no hay números («?»), no 0
  clients: async req => { const { country } = mxOpts(req), b = brainSites();
    if (!b.enabled) return { country, enabled: false };
    if (b.down || (!b.sites.length && (b.error || !b.dataAt))) return { country, enabled: true, unknown: true, demo: b.demo, error: b.error || "" };
    return { country, enabled: true, demo: b.demo, at: b.dataAt, stale: b.stale, error: b.error, ...MX.clientsSummary(b.sites, { country }) }; },
};
// secciones que son solo por persona: las dos rutas cortan con 403 a quien no es líder (antes de leer nada)
const MX_LEADERS = new Set(["activity"]);
// solo las secciones de MX_LOAD (no lo heredado de Object: «constructor», «toString»…)
const mxLoad = section => Object.hasOwn(MX_LOAD, section) ? MX_LOAD[section] : null;
// Métricas entera es solo para líderes y dirección (pedido del líder): a los demás, 403 antes de leer nada. Después, el equipo.
async function mxTeam(req, msg) {
  const v = await viewerFor(req.session.user.email);
  if (!v.leader) throw httpErr(v.unknown ? TM.TEAMS_DOWN : { status: 403, error: v.acc.stale ? TM.STALE_MSG : msg });
  const p = TM.pickTeam(v, v.T, String(req.query.team || ""));
  if (p.error) throw httpErr(p.error);
  return { filter: p.id ? TM.filterOf(v.T, [p.id], (await pd.meta()).users) : null, team: teamInfo(v.T, p.id), on: v.on };
}
const withTeam = (o, t) => o && typeof o === "object" ? { ...o, scope: { team: t.team, on: t.on } } : o;
app.get("/api/metrics/:section", auth, wrap(async (req, res) => {
  const t = await mxTeam(req, "Métricas solo lo ven los líderes y dirección.");
  const load = mxLoad(req.params.section); if (!load) return res.status(404).json({ error: "No existe esa métrica." });
  if (MX_LEADERS.has(req.params.section)) return res.json(withTeam(MX.splitView(req.params.section, await load(req, t.filter)).people, t));
  res.json(withTeam(MX.splitView(req.params.section, await load(req, t.filter), { me: req.session.user.pdUserId, email: req.session.user.email }).pub, t));
}));
app.get("/api/metrics/:section/people", auth, wrap(async (req, res) => {
  const t = await mxTeam(req, "El detalle por persona solo lo ven los líderes y dirección.");
  const load = mxLoad(req.params.section), v = load && MX.splitView(req.params.section, await load(req, t.filter));
  if (!v?.people) return res.status(404).json({ error: "Esa métrica no tiene detalle por persona." });
  res.json(withTeam(v.people, t));
}));
// Sincronizar y World Dominion son de toda la cuenta: quien ve todo (dirección y los fijos; sin equipos, cualquier líder)
async function allOnly(req, res, msg) { const v = await viewerFor(req.session.user.email); if (v.all) return true; res.status(403).json({ error: v.leader ? "Esto es de toda la cuenta: lo maneja dirección." : msg }); return false; }
// ---------- sincronización masiva con Pipedrive (lib/sync.js). Solo lee de Pipedrive: corre también con READ_ONLY=1.
// Cuántos colegios hay en cada estado (lo mismo que ve la lista: World Dominion manda, «unk» = sin revisar)
const stateCounts = () => { const c = {}; for (const s of schools) { const st = sales.schoolListItem(s).status; c[st] = (c[st] || 0) + 1; } return c; };
// cron: hay CRON_SECRET (el cron diario sigue lo que quede en pausa)
const syncView = async r => ({ ...r, counts: stateCounts(), total: schools.length, cron: !!process.env.CRON_SECRET });
app.get("/api/admin/sync", auth, wrap(async (req, res) => {
  if (!(await allOnly(req, res, "Solo un líder sincroniza con Pipedrive."))) return;
  res.json(await syncView(await psync.status(req.session.user.name || req.session.user.email)));
}));
// Hace un paso (hasta ~40 s) y devuelve el progreso; el navegador lo repite hasta terminar.
app.post("/api/admin/sync", auth, wrap(async (req, res) => {
  if (!(await allOnly(req, res, "Solo un líder sincroniza con Pipedrive."))) return;
  res.json(await syncView(await psync.step({ budgetMs: Math.min(280, Math.max(5, Number(process.env.SYNC_STEP_SECONDS) || 40)) * 1e3, full: req.body?.full === true, by: req.session.user.name || req.session.user.email })));
}));
// Vercel Cron (vercel.json): manda «Authorization: Bearer $CRON_SECRET». Sin CRON_SECRET la ruta no existe.
// Sigue una sincronización a medias o hace una incremental (lo cambiado desde la última).
app.get("/api/cron/sync", wrap(async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) return res.status(404).end();
  if (!same(String(req.get("authorization") || ""), `Bearer ${secret}`)) return res.status(401).json({ error: "No autorizado" });
  const secs = Math.min(280, Math.max(20, Number(process.env.SYNC_CRON_SECONDS) || 50));
  const r = await psync.step({ budgetMs: secs * 1e3, by: "cron" });
  res.json({ running: r.running, busy: !!r.busy, phase: r.job?.phase || null, last: r.last, error: r.error });
}));
// ---------- World Dominion (lib/brain.js): estado y token, solo líderes. El token entra acá y nunca vuelve al navegador.
app.get("/api/admin/brain", auth, wrap(async (req, res) => {
  if (!(await allOnly(req, res, "Solo un líder ve el estado de World Dominion."))) return;
  res.json(await brainAdmin());
}));
// Lo prueba contra OrderBrain antes de guardarlo; si falla, 400 con el motivo y no se guarda.
app.post("/api/admin/brain", auth, wrap(async (req, res) => {
  if (!(await allOnly(req, res, "Solo un líder carga el token de World Dominion."))) return;
  res.json(await saveBrainToken(req.body?.token, req.session.user.name || req.session.user.email));
}));

// Revisa varios colegios contra Pipedrive (de a 3 en paralelo).
app.post("/api/check", auth, wrap(async (req, res) => {
  const ids = (req.body.ids || []).filter(id => byId.has(id)).slice(0, 300);
  const out = {}; let i = 0;
  async function worker() { while (i < ids.length) { const id = ids[i++]; try { await sales.checkSchool(id, { force: !!req.body.force }); out[id] = sales.schoolSummary(byId.get(id)); } catch (e) { out[id] = { error: e.message }; } } }
  await Promise.all([worker(), worker(), worker()]);
  res.json(out);
}));

app.get("/api/schools/:id", auth, schoolParam, wrap(async (req, res) => {
  res.json(await sales.schoolDetail(req.params.id, { force: req.query.refresh === "1", user: req.session.user, tz: req.tz }));
}));
app.post("/api/schools/:id/match", auth, schoolParam, wrap(async (req, res) => {
  const { orgId, orgName } = req.body || {};
  if (orgId !== null && !(Number(orgId) > 0)) return res.status(400).json({ error: "Falta la organización." });
  if (orgId === null) sales.unlinkSchool(req.params.id);
  else await sales.linkSchool(req.params.id, { id: Number(orgId), name: String(orgName || "") });
  res.json(await sales.schoolDetail(req.params.id, { user: req.session.user, tz: req.tz }));
}));
// «Es esta» → «¿Estás seguro?»: lo que dice Pipedrive de esa organización, para comparar con el colegio
app.get("/api/schools/:id/org/:orgId", auth, schoolParam, wrap(async (req, res) => res.json(await sales.orgPreview(req.params.id, req.params.orgId, req.session.user))));
// después de vincular: otras organizaciones que parecen el mismo colegio (lib/merge.js) y si podés fusionar cada una
app.get("/api/schools/:id/dupes", auth, schoolParam, wrap(async (req, res) => res.json(await sales.dupesFor(req.params.id, req.session.user, { leader: await leadScopeFor(req.session.user.email) }))));
// «¿Querés fusionar?»: las elegidas pasan a la vinculada (keepId) con la fusión de Pipedrive. Controles en sales.mergeOrgs.
app.post("/api/schools/:id/merge-orgs", auth, schoolParam, wrap(async (req, res) => {
  const b = req.body || {}, user = req.session.user;
  res.json(await sales.mergeOrgs(req.params.id, user, { keepId: b.keepId, mergeIds: b.mergeIds, leader: await leadScopeFor(user.email), by: await signName(user), tz: req.tz }));
}));
app.get("/api/schools/:id/next", auth, schoolParam, (req, res) => res.json(sales.nextFor(req.params.id, req.query.outcome, req.query.channel, req.tz) || {}));
app.post("/api/schools/:id/log", auth, schoolParam, wrap(async (req, res) => {
  const body = { ...(req.body || {}) };
  // si la actividad a completar ya no está en Pipedrive, el contacto se registra igual
  const gone = !!body.completeActivityId && !(await ownActivity(req.session.user, body.completeActivityId, { missingOk: true }));
  if (gone) delete body.completeActivityId;
  const r = await sales.logContact(req.params.id, req.session.user, body, req.tz);
  if (gone) r.done.push({ label: "La actividad ya no está en Pipedrive.", warn: true });
  const o = sales.OUTCOMES.find(x => x.id === body.outcome);
  await inSession(req, r, sessions.contactStep(req.body?.session?.ref, { channel: body.channel, outcome: body.outcome, connected: o?.connected, next: r.next, demo: r.demo, contact: body.contact, ...stepBy(req) }));
  res.json(r);
}));
// Contacto o comentario hecho dentro de una sesión de trabajo ({ session: { id, ref } }): queda anotado en la sesión de quien lo
// registró, después de guardarlo en Pipedrive. Si el colegio está en otras sesiones abiertas suyas (o se registró sin sesión),
// queda anotado ahí como hecho fuera de la sesión (r.sessions). Si no se puede anotar, el registro igual vale (se avisa).
const stepBy = req => ({ by: req.session.user.email, byName: req.session.user.name || sales.signer(req.session.user), schoolId: req.params.id });
async function inSession(req, r, step) {
  const ss = req.body?.session, email = req.session.user.email, sid = ss?.id && ss.ref ? String(ss.id) : null;
  try {
    if (sid) { const v = await sessions.recordFor(email, sid, step); if (v) r.session = v; }
    const others = await sessions.recordOutside(email, req.params.id, step, { except: sid });
    if (others.length) r.sessions = others;
  } catch (e) { console.warn("No se pudo anotar en la sesión:", e.message); r.done.push({ label: "No pude anotarlo en tu sesión de trabajo (en Pipedrive quedó guardado).", warn: true }); }
}

// Mail desde la ficha con el Gmail de quien escribe (lib/gmail.js) y registro en Pipedrive (sales.sendMail).
// key: la que arma el navegador para cada envío; si el pedido se repite (la red), no se manda dos veces.
// Antes de la cuenta de 5 s, el modal pregunta si se puede (archivado, cliente, de otra persona): así no se ofrece «Enviar»
// donde después va a fallar. No escribe nada. El envío vuelve a comprobar todo.
app.get("/api/schools/:id/mail/check", auth, schoolParam, wrap(async (req, res) => {
  try { await sales.mailGuard(req.params.id, req.session.user); res.json({ ok: true }); }
  catch (e) { if ((e.status || 500) >= 500) throw e; res.json({ ok: false, error: e.message }); }
}));
app.post("/api/schools/:id/mail", auth, gmailProof, schoolParam, wrap(async (req, res) => {
  const user = req.session.user, b = req.body || {};
  const k = /^[A-Za-z0-9_-]{8,64}$/.test(b.key || "") ? `mail:${user.email}:${b.key}` : null;
  if (k && !(await once(k, 1800))) return res.status(409).json({ error: "Ese mail ya se mandó (o se está mandando). Mirá Historial antes de mandarlo de nuevo.", code: "mail_dup" });
  if ((await bump(`mailrate:${user.email}`, 3600)) > MAIL_PER_HOUR) { if (k) await release(k); return res.status(429).json({ error: `Llegaste a ${MAIL_PER_HOUR} mails en una hora desde la app. Esperá un rato o usá «Abrir en Gmail».` }); }
  try {
    let doneId = Number(b.completeActivityId) || null;
    if (doneId && !(await ownActivity(user, doneId, { missingOk: true }))) doneId = null;
    const name = await gmailName(user);
    const r = await sales.sendMail(req.params.id, user, { to: b.to, subject: b.subject, text: b.text, completeActivityId: doneId }, req.tz,
      { send: m => gmail.send(user.email, { ...m, fromName: name }), by: name });
    // el mail cuenta como contacto en la sesión de trabajo (y en las otras abiertas que tengan este colegio)
    if (r && Array.isArray(r.done)) await inSession(req, r, sessions.contactStep(b.session?.ref, { channel: "mail", outcome: "sent", next: null, ...stepBy(req) }));
    res.json(r);
  } catch (e) {
    // la clave se libera solo si es seguro que no salió (antes de llamar a Gmail, o Gmail lo rechazó con 4xx).
    // sent = "maybe" (red, tiempo o 5xx de Gmail) o true (salió y falló algo después): no se libera, no se manda dos veces
    if (k && !e.sent) await release(k);
    throw e;
  }
}));
app.post("/api/schools/:id/mail/next", auth, gmailProof, schoolParam, wrap(async (req, res) => {
  const b = req.body || {}, n = b.next, user = req.session.user;
  const next = n && n.type ? { type: String(n.type), date: String(n.date || ""), time: n.time ? String(n.time) : "", ownerId: n.ownerId ? Number(n.ownerId) : undefined, subject: n.subject ? String(n.subject) : "" } : null;
  // mover una actividad pendiente (la automática o una tuya ya agendada) en vez de crear otra; marcar hecha la de la agenda
  let moveId = Number(b.moveActivityId) || null, doneId = Number(b.completeActivityId) || null;
  if (moveId && !(await ownActivity(user, moveId, { missingOk: true }))) moveId = null;
  if (doneId && !(await ownActivity(user, doneId, { missingOk: true }))) doneId = null;
  res.json(await sales.mailNext(req.params.id, user, { mailId: String(b.mailId || ""), next, moveActivityId: moveId, completeActivityId: doneId }, req.tz));
}));
// Demo: lo que quedó en el Pipedrive de prueba y en la bandeja de Gmail simulada para este colegio (para comprobar el envío)
if (pd.DEMO) app.get("/api/demo/mail/:id", auth, schoolParam, wrap(async (req, res) => {
  const m = sales.allMatches()[req.params.id] || {}, s = byId.get(req.params.id), where = s.leadOnly ? { leadId: s.leadId } : m.orgId ? { orgId: m.orgId } : null;
  const acts = where ? [...await pd.activities({ ...where, done: true, limit: 50 }), ...await pd.activities({ ...where, done: false, limit: 50 })] : [];
  const notes = where ? await (where.leadId ? pd.notesForLead(where.leadId, 20) : pd.notesForOrg(where.orgId, 20)) : [];
  res.json({ where, activities: acts.map(a => ({ id: a.id, subject: a.subject, type: a.type, done: !!a.done, due: a.due_date, orgId: a.org_id || null, dealId: a.deal_id || null, leadId: a.lead_id || null, personId: a.person_id || null, owner: a.owner_id, note: a.note || "" })),
    notes: notes.map(n => ({ id: n.id, orgId: n.org_id || null, dealId: n.deal_id || null, leadId: n.lead_id || null, personId: n.person_id || null, content: n.content })),
    outbox: gmail.demoOutbox().map(x => ({ id: x.id, at: x.at, from: x.from, to: x.to, bcc: x.bcc, ...gmail.parseMime(x.mime) })) });
}));
// Comentario suelto: queda como nota en la organización de Pipedrive, sin registrar un contacto.
app.post("/api/schools/:id/prospect", auth, schoolParam, wrap(async (req, res) => res.json(await sales.createProspect(req.params.id, req.session.user, req.body?.task || null, req.tz))));
// prospecto → trato (conversión de Pipedrive). Solo el dueño del prospecto o un líder.
app.post("/api/schools/:id/convert", auth, schoolParam, wrap(async (req, res) => res.json(await sales.convertToDeal(req.params.id, req.session.user, { leader: await leadScopeFor(req.session.user.email), country: String(req.body?.country || "") }))));
// Comentario y/o tarea para más adelante (para quien registra o para otra persona del equipo), sin registrar un contacto.
app.post("/api/schools/:id/comment", auth, schoolParam, wrap(async (req, res) => {
  const text = String(req.body?.text || "").trim().slice(0, 5000), t = req.body?.task || null, user = req.session.user;
  const task = t && TYPE_LABEL[t.type] && /^\d{4}-\d{2}-\d{2}$/.test(t.date || "") ? t : null;
  if (t && !task) return res.status(400).json({ error: "Elegí el tipo y el día de la tarea." });
  if (task?.time && !/^\d{2}:\d{2}$/.test(task.time)) return res.status(400).json({ error: "Hora inválida." });
  if (!text && !task) return res.status(400).json({ error: "Escribí el comentario o elegí una tarea." });
  let doneId = Number(req.body?.completeActivityId) || null;
  const gone = !!doneId && !(await ownActivity(user, doneId, { missingOk: true }));
  if (gone) doneId = null;
  const s = byId.get(req.params.id), by = sales.signer(user);
  const m = await pd.meta(), owner = task?.ownerId ? m.users.find(u => u.id === Number(task.ownerId)) : null;
  if (task?.ownerId && !owner) return res.status(400).json({ error: "Esa persona no está en el equipo." });
  const rec = s.leadOnly ? null : await sales.ensureOrg(req.params.id, user.pdUserId);
  const target = s.leadOnly ? { leadId: s.leadId } : { orgId: rec.orgId, dealId: rec.openDealId || undefined };
  const url = s.leadOnly ? `${pd.PD_WEB}/leads/inbox/${s.leadId}` : `${pd.PD_WEB}/organization/${rec.orgId}`;
  const done = [];
  if (task) {
    const u = toUtc(task.date, task.time, req.tz);
    await pd.addActivity({ subject: String(task.subject || "").trim().slice(0, 140) || `${TYPE_LABEL[task.type]} · ${s.name}`, type: task.type, dueDate: u.date, dueTime: u.time, ...target, ownerId: owner?.id || user.pdUserId, note: text ? escHtml(text).slice(0, 1000) : "" });
    done.push({ label: `${TYPE_LABEL[task.type]} el ${task.date.slice(8, 10)}/${task.date.slice(5, 7)}${task.time ? " a las " + task.time : ""} para ${owner && owner.id !== user.pdUserId ? owner.name : "vos"}`, url });
  }
  const taskLine = task ? `<br><b>Tarea:</b> ${escHtml(TYPE_LABEL[task.type])} el ${escHtml(task.date)}${task.time ? " " + escHtml(task.time) : ""} para ${escHtml(owner?.name || by)}` : "";
  await pd.addNote({ content: `<b>Comentario</b>${text ? "<br>" + escHtml(text).replace(/\n/g, "<br>") : ""}${taskLine}<br><br><i>Cargado por ${escHtml(by)} desde OrderBrain SDR</i>`, ...target });
  done.push({ label: s.leadOnly ? "Comentario en el prospecto" : "Comentario en Pipedrive", url });
  if (doneId) await pd.updateActivity(doneId, { done: true }).then(() => done.push({ label: "Actividad pendiente marcada como hecha" }), () => done.push({ label: "No pude marcar la actividad como hecha: hacelo desde la agenda.", warn: true }));
  if (gone) done.push({ label: "La actividad ya no está en Pipedrive.", warn: true });
  const out = { done, school: sales.schoolSummary(s), orgUrl: url };
  await inSession(req, out, sessions.commentStep(req.body?.session?.ref, { next: task ? { ...task, ownerId: owner?.id || user.pdUserId } : null, ...stepBy(req) }));
  res.json(out);
}));
// Tratos desde la ficha: { action: "stage", stageId } (propuesta enviada u otra etapa de su embudo), { action: "won" } o { action: "lost", reason }
app.post("/api/schools/:id/deals/:dealId", auth, schoolParam, wrap(async (req, res) => {
  if (!/^\d+$/.test(req.params.dealId)) return res.status(400).json({ error: "Trato inválido" });
  res.json(await sales.dealAction(req.params.id, await ownDeal(req.session.user, req.params.dealId), req.session.user, req.body || {}));
}));
// Archivar en la app (y en Pipedrive solo lo tuyo o lo libre). No clientes ni tratos abiertos de otra persona (salvo un líder).
// Desarchivar: quien lo archivó o un líder. Las reglas están en lib/archive.js.
app.post("/api/schools/:id/archive", auth, schoolParam, wrap(async (req, res) => {
  const user = req.session.user, b = req.body || {};
  res.json(await sales.archiveSchool(req.params.id, user, { leader: await leadScopeFor(user.email), by: await signName(user), reason: String(b.reason || ""), text: String(b.text || "") }));
}));
app.post("/api/schools/:id/unarchive", auth, schoolParam, wrap(async (req, res) => {
  const user = req.session.user;
  res.json(await sales.unarchiveSchool(req.params.id, user, { leader: await leadScopeFor(user.email), by: await signName(user) }));
}));
// Agregar un decisor (persona) a la organización del colegio o al prospecto: en lo ajeno solo un líder
app.post("/api/schools/:id/persons", auth, schoolParam, wrap(async (req, res) => res.json(await sales.addDecisor(req.params.id, req.session.user, await leadScopeFor(req.session.user.email), req.body || {}))));
app.get("/api/schools/:id/photos", auth, schoolParam, wrap(async (req, res) => {
  res.set("cache-control", "private, max-age=3600");
  // sin web en la base, la que encontró «Enriquecer» (de Pipedrive o de una sede), con su fuente
  const e = byId.get(req.params.id)?.web ? null : await sales.getEnrich(req.params.id).catch(() => null);
  res.json({ photos: await photosFor(req.params.id, { refresh: req.query.refresh === "1", web: e?.web || "", webSrc: e?.webSrc || "" }), google: googleEnabled() });
}));
// Estudio de prospección: se genera solo la primera vez que alguien abre el colegio.
const studying = new Map();
app.get("/api/schools/:id/study", auth, schoolParam, wrap(async (req, res) => {
  res.json({ study: await getStudy(req.params.id), enabled: studyEnabled(), working: studying.has(req.params.id) });
}));
app.post("/api/schools/:id/study", auth, schoolParam, wrap(async (req, res) => {
  const id = req.params.id, force = !!req.body?.refresh;
  if (!force) { const cur = await getStudy(id); if (cur) return res.json({ study: cur }); }
  if (!studyEnabled()) return res.status(400).json({ error: "El estudio automático necesita ANTHROPIC_API_KEY en el servidor." });
  if (!studying.has(id)) studying.set(id, withLock("study:" + id, async () => {
    if (!force) { const cur = await getStudy(id); if (cur) return cur; }
    const m = await sales.checkSchool(id).catch(() => null);
    const st = await research(byId.get(id), { context: m ? `Estado en Pipedrive: ${m.detail || "sin datos"}` : "" });
    await setStudy(id, st);
    return st;
  }).finally(() => studying.delete(id)));
  res.json({ study: await studying.get(id) });
}));
app.post("/api/schools/:id/study/note", auth, schoolParam, wrap(async (req, res) => {
  const st = await getStudy(req.params.id);
  if (!st) return res.status(404).json({ error: "Todavía no hay estudio de este colegio." });
  const s = byId.get(req.params.id);
  if (s.leadOnly) { // prospecto sin organización: el estudio va al prospecto
    await pd.addNote({ content: studyToHtml(s, st), leadId: s.leadId });
    return res.json({ ok: true, orgUrl: `${pd.PD_WEB}/leads/inbox/${s.leadId}` });
  }
  const rec = await sales.ensureOrg(req.params.id, req.session.user.pdUserId);
  await pd.addNote({ content: studyToHtml(s, st), orgId: rec.orgId, dealId: rec.openDealId });
  res.json({ ok: true, orgUrl: `${pd.PD_WEB}/organization/${rec.orgId}` });
}));
app.get("/api/schools/:id/brief", auth, schoolParam, wrap(async (req, res) => res.json(await ai.brief(req.params.id, { user: req.session.user }))));
app.get("/api/schools/:id/enrich", auth, schoolParam, wrap(async (req, res) => res.json({ data: await sales.getEnrich(req.params.id) })));
app.post("/api/schools/:id/enrich", auth, schoolParam, wrap(async (req, res) => res.json(await sales.enrichSchool(req.params.id, req.session.user, (await getProfile(req.session.user.email).catch(() => null))?.name))));
// Historial completo (de a 50, «Cargar más» con offset) y el resumen para la próxima llamada por reglas; con IA, aparte.
const meName = async req => (await getProfile(req.session.user.email).catch(() => null))?.name || req.session.user.name || "";
// refresh=1 («Actualizar») y fresh=1 (recién escribió algo de esta ficha): se vuelve a leer Pipedrive
app.get("/api/schools/:id/timeline", auth, schoolParam, wrap(async (req, res) => res.json(await sales.timelineFor(req.params.id,
  { user: req.session.user, tz: req.tz, me: await meName(req), offset: req.query.offset, limit: req.query.limit, force: req.query.refresh === "1" || req.query.fresh === "1" }))));
app.get("/api/schools/:id/call-brief", auth, schoolParam, wrap(async (req, res) => res.json(await sales.callBriefFor(req.params.id, { user: req.session.user, tz: req.tz, me: await meName(req), force: req.query.refresh === "1" }))));
app.get("/api/schools/:id/history", auth, schoolParam, wrap(async (req, res) => res.json(await sales.historyFor(req.params.id))));
app.get("/api/schools/:id/sedes", auth, schoolParam, wrap(async (req, res) => res.json(await sales.sedesFor(req.params.id))));
// Redactar un mensaje: con IA usa el contexto que escribe el SDR + lo que sabe Pipedrive; sin IA, la plantilla de la casa.
app.post("/api/schools/:id/draft", auth, schoolParam, wrap(async (req, res) => {
  const b = req.body || {}, channel = b.channel === "mail" ? "mail" : "whatsapp", user = req.session.user;
  const p = { channel, purpose: String(b.purpose && b.purpose !== "Mensaje" ? b.purpose : "avanzar un paso: llegar al decisor o agendar una demo").slice(0, 200), contact: String(b.contact || "").slice(0, 80), base: String(b.base || "").slice(0, 3000), context: String(b.context || "").slice(0, 2000) };
  const s = byId.get(req.params.id), me = (await getProfile(user.email).catch(() => null))?.name || sales.signer(user);
  if (!ai.aiEnabled()) return res.json({ ...composeMessage(s, { channel, context: p.context, contact: p.contact, me, base: p.base, ...sales.stateOf(req.params.id) }), mode: "plantilla" });
  const examples = templates(s, { me, contact: p.contact }).filter(t => t.channel === channel).slice(0, 3).map(t => t.text);
  res.json({ ...await ai.draft(req.params.id, { ...p, pdContext: await sales.draftContext(req.params.id, user).catch(() => ""), examples, user: { ...user, name: me } }), mode: "ia" });
}));

// Hoy: métricas, agenda propia y a quién contactar.
app.get("/api/today", auth, wrap(async (req, res) => {
  const countries = String(req.query.countries || "").split(",").filter(Boolean);
  const mine = await sales.myActivities(req.session.user).catch(e => ({ warning: e.message, items: [] }));
  const busyOrgs = new Set(mine.items.map(a => a.orgId).filter(Boolean));
  res.json({ stats: sales.stats(req.session.user, req.tz), activities: mine, queue: sales.prospectQueue({ countries, limit: 60, excludeOrgIds: busyOrgs, userId: req.session.user.pdUserId || null }) });
}));
// Sesiones de trabajo guardadas (Sesiones activas de Hoy): cada uno ve y cambia solo las suyas (van por su email).
// la lista lleva solo los resúmenes; el detalle (colegios y pasos) va por /api/sessions/:sid
app.get("/api/sessions", auth, wrap(async (req, res) => res.json(await sessions.listFor(req.session.user.email, Date.now(), todayIn(req.tz)))));
app.get("/api/sessions/:sid", auth, wrap(async (req, res) => res.json({ session: await sessions.getFor(req.session.user.email, req.params.sid) })));
app.post("/api/sessions", auth, wrap(async (req, res) => res.json(await sessions.createFor(req.session.user.email, req.body || {}, Date.now(), todayIn(req.tz)))));
app.patch("/api/sessions/:sid", auth, wrap(async (req, res) => res.json(await sessions.updateFor(req.session.user.email, req.params.sid, req.body || {}))));
app.delete("/api/sessions/:sid", auth, wrap(async (req, res) => res.json(await sessions.deleteFor(req.session.user.email, req.params.sid))));
// Bandeja caliente de Hoy: los prospectos nuevos para vos (solo los tuyos). Va aparte para no frenar la carga de Hoy.
app.get("/api/hot", auth, wrap(async (req, res) => res.json(await sales.newForMe(req.session.user))));
// Cola de prospectos nuevos de una zona («hoy quiero trabajar Puebla»). El navegador manda las organizaciones que ya tienen
// actividad tuya (exclude) para no repetirlas; la regla del dueño la aplica prospectQueue igual.
app.get("/api/queue", auth, wrap(async (req, res) => {
  const zone = String(req.query.zone || "").trim().slice(0, 80); if (!zone) return res.status(400).json({ error: "Falta la zona." });
  const exclude = new Set(String(req.query.exclude || "").split(",").slice(0, 2000).map(Number).filter(Boolean));
  res.json({ zone, queue: sales.prospectQueue({ zone, limit: 60, excludeOrgIds: exclude, userId: req.session.user.pdUserId || null }) });
}));
app.get("/api/my-activities", auth, wrap(async (req, res) => res.json(await sales.myActivities(req.session.user))));
app.post("/api/activities/:id/done", auth, wrap(async (req, res) => { await ownActivity(req.session.user, req.params.id); await pd.updateActivity(Number(req.params.id), { done: true }); res.json({ ok: true }); }));
app.post("/api/activities/:id/undone", auth, wrap(async (req, res) => { await ownActivity(req.session.user, req.params.id); await pd.updateActivity(Number(req.params.id), { done: false }); res.json({ ok: true }); }));
app.post("/api/activities/:id/move", auth, wrap(async (req, res) => {
  const { date, time } = req.body || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) return res.status(400).json({ error: "Fecha inválida" });
  const a = await ownActivity(req.session.user, req.params.id), tm = time && /^\d{2}:\d{2}$/.test(time) ? time : "";
  const u = toUtc(date, tm, req.tz);
  await pd.updateActivity(Number(req.params.id), { due_date: u.date, ...(u.time ? { due_time: u.time } : {}) });
  // si es una demo, el recordatorio para confirmarla se mueve con ella
  const done = await sales.demoMoved(a, req.session.user, { date, time: tm }, req.tz, await leadScopeFor(req.session.user.email)).catch(e => [{ label: `No pude mover el recordatorio para confirmar la demo: ${e.message}`, warn: true }]);
  res.json({ ok: true, done });
}));
// Resultado de una demo (tuya, o cualquiera si sos líder): se hizo, no se presentó, se reprogramó o se canceló.
// Queda escrito en la nota de la actividad con una línea fija; si no se presentó, se puede reagendar (otra demo).
const signName = async user => (await getProfile(user.email).catch(() => null))?.name || "";
app.post("/api/activities/:id/demo-result", auth, wrap(async (req, res) => {
  const a = await ownActivity(req.session.user, req.params.id), b = req.body || {};
  res.json(await sales.markDemo(a, req.session.user, { result: String(b.result || ""), date: b.date, time: b.time, by: await signName(req.session.user) }, req.tz, await leadScopeFor(req.session.user.email)));
}));
app.post("/api/activities/:id/demo-rebook", auth, wrap(async (req, res) => {
  const a = await ownActivity(req.session.user, req.params.id), b = req.body || {};
  res.json(await sales.rebookDemo(a, req.session.user, { date: b.date, time: b.time, by: await signName(req.session.user) }, req.tz));
}));
// ---------- buscador de zonas: «prospectá España», «Bogotá», «Provincia de Córdoba», «Pocitos»
// 1) /resolve ubica el lugar con su contorno. 2) /city trae de OpenStreetMap los colegios de una ciudad o de un
// área exacta y devuelve candidatos firmados (no guarda nada). 3) /verify revisa cada candidato (web, Google, IA)
// y recién ahí lo suma a la base. Así, cancelar no deja nada a medias y lo que entra está chequeado.
const SCAN_MIN_POP = Number(process.env.RADAR_MIN_POP || 40000);
const SCAN_SECRET = process.env.SESSION_SECRET || "dev-only-secret";
const signRec = rec => crypto.createHmac("sha256", SCAN_SECRET).update("cand:" + JSON.stringify(rec)).digest("base64url");
const sigOk = (rec, sig) => typeof sig === "string" && /^[A-Za-z0-9_-]{43}$/.test(sig) && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(signRec(rec)));
// Si el navegador corta el pedido (el usuario canceló), se corta todo lo que dependía de él: no se gastan más
// consultas a OpenStreetMap, Google ni IA y no se guarda nada.
function cancelOnClose(req, res) {
  const ac = new AbortController();
  res.on("close", () => { if (!res.writableFinished) { console.log(`buscador: ${req.path} cancelado por el usuario`); ac.abort(new Error("cancelado por el usuario")); } });
  return ac.signal;
}
const LATAM = Object.values(MARKETS).map(m => m.code).filter(c => /^[A-Z]{2}$/.test(c) && c !== "ES");
const CONTINENTS = [
  { re: /^(latinoamerica|latam|america latina|iberoamerica|hispanoamerica)$/, name: "Latinoamérica", codes: LATAM, lat: -8, lng: -70, bbox: [[-56, -118], [33, -34]] },
  { re: /^(sudamerica|suramerica|america del sur|sur america)$/, name: "Sudamérica", codes: ["AR", "BO", "CL", "CO", "EC", "PE", "PY", "UY", "VE"], lat: -20, lng: -62, bbox: [[-56, -82], [13, -34]] },
  { re: /^(centroamerica|america central|centro america)$/, name: "Centroamérica", codes: ["GT", "HN", "SV", "NI", "CR", "PA"], lat: 12.5, lng: -85.5, bbox: [[7, -93], [18.5, -77]] },
  { re: /^(caribe|el caribe)$/, name: "Caribe", codes: ["DO", "PR"], lat: 18.6, lng: -68.5, bbox: [[17.4, -72.1], [19.95, -65.2]] },
  { re: /^(norteamerica|america del norte)$/, name: "Norteamérica (México)", codes: ["MX"], lat: 23.6, lng: -102.5, bbox: [[14.5, -118.5], [32.7, -86.7]] },
  { re: /^(europa)$/, name: "Europa (España)", codes: ["ES"], lat: 40.2, lng: -3.7, bbox: [[35.9, -9.4], [43.8, 4.4]] },
];
const appCountry = place => { const known = Object.entries(MARKETS).find(([, m]) => m.code === place.cc); if (known) place.country = known[0]; return place; };
app.post("/api/scan/resolve", auth, wrap(async (req, res) => {
  const osm = String(req.body?.osm || "");
  if (osm) {
    const k = "place:osm:" + osm;
    const place = (await cacheGet(k)) || await scan.lookupPlace(osm);
    if (!place) return res.status(404).json({ error: "No encontré ese lugar." });
    await cacheSet(k, place, place.boundaryFailed ? 600 : 30 * 864e2);
    return res.json(appCountry(place));
  }
  const q = String(req.body?.q || "").trim().slice(0, 120), nq = scan.norm(q);
  if (nq.length < 2) return res.status(400).json({ error: "Escribí un país, una provincia, una ciudad o un barrio." });
  // continentes y regiones grandes: los países del equipo que caen ahí
  const cont = CONTINENTS.find(c => c.re.test(nq));
  if (cont) {
    const names = Object.entries(MARKETS).filter(([, m]) => cont.codes.includes(m.code)).map(([n]) => n);
    return res.json({ kind: "continent", name: cont.name, label: cont.name, countries: names, codes: cont.codes, lat: cont.lat, lng: cont.lng, bbox: cont.bbox, city: { name: cont.name, lat: cont.lat, lng: cont.lng, pop: 0 }, alts: [] });
  }
  // se busca en los países donde trabaja el equipo, con prioridad para el país elegido en la app
  const prefer = /^[A-Z]{2}$/.test(req.body?.cc || "") ? req.body.cc : "";
  const k = `place4:${prefer}:${nq}`;
  const cached = await cacheGet(k);
  const place = cached || await scan.resolvePlace(q, { codes: Object.values(MARKETS).map(m => m.code).filter(c => /^[A-Z]{2}$/.test(c)), prefer });
  if (!place) return res.status(404).json({ error: `No encontré «${q}». Probá con otro nombre.` });
  // si el contorno falló por un error pasajero, se guarda solo unos minutos para reintentar pronto
  if (!cached) await cacheSet(k, place, place.boundaryFailed ? 600 : 30 * 864e2);
  res.json(appCountry(place));
}));
app.post("/api/scan/cities", auth, wrap(async (req, res) => {
  const { cc, areaId } = req.body || {};
  if (!/^[A-Z]{2}$/.test(cc || "") && !Number(areaId)) return res.status(400).json({ error: "Zona inválida" });
  const k = Number(areaId) ? `cities:a${Number(areaId)}` : `cities:${cc}`;
  let list = await cacheGet(k);
  if (!list) {
    const deadline = Date.now() + 240e3, signal = cancelOnClose(req, res);
    list = Number(areaId) ? await scan.citiesInArea(Number(areaId), { minPop: SCAN_MIN_POP, deadline, reserve: 5, signal }) : await scan.citiesFor(cc, { minPop: SCAN_MIN_POP, deadline, reserve: 5, signal });
    if (list.length) await cacheSet(k, list, 60 * 864e2);
  }
  res.json({ cities: list });
}));
// whole: todo el área (barrio, ciudad o provincia con contorno). Si no, un círculo alrededor de la ciudad,
// recortado al área (areaId) o al país.
app.post("/api/scan/city", auth, wrap(async (req, res) => {
  const { cc, country, city, areaId, radius, whole, region } = req.body || {};
  if (!/^[A-Z]{2}$/.test(cc || "") || !city || !Number.isFinite(+city.lat) || !Number.isFinite(+city.lng) || !String(city.name || "").trim()) return res.status(400).json({ error: "Ciudad inválida" });
  const c = { name: String(city.name).slice(0, 80), lat: +city.lat, lng: +city.lng, pop: Math.max(0, Number(city.pop) || 0) };
  const area = Number(areaId) > 0 ? Number(areaId) : null;
  const signal = cancelOnClose(req, res);
  const opts = { deadline: Date.now() + 240e3, reserve: 5, attempts: 3, signal };
  const els = whole && area ? await scan.scanArea(area, opts) : await scan.scanCity(cc, c, { ...opts, areaId: area, radius });
  // provincia entera: cada colegio lleva su ciudad (la del mapa o la ciudad grande más cercana), no el nombre de la provincia
  let cityOf = null;
  if (whole && area && region) {
    const cities = (await cacheGet(`cities:a${area}`)) || await scan.citiesInArea(area, { minPop: 20000, deadline: Date.now() + 60e3, reserve: 5, signal }).catch(() => []);
    cityOf = (t, lat, lng) => {
      const tagged = String(t["addr:city"] || t["is_in:city"] || "").split(";")[0].trim(); if (tagged) return tagged.slice(0, 80);
      let best = null, bd = Infinity; for (const x of cities) { const d = scan.km({ lat, lng }, x); if (d < bd) { bd = d; best = x; } }
      return best && bd <= scan.radiusKm(best.pop) * 1.5 ? best.name : null;
    };
  }
  // se cruza contra la base y contra lo que va saliendo en esta misma búsqueda (sin duplicados)
  const pool = schools.slice(), idx = scan.buildIndex(pool), candidates = [], seen = [];
  const today = new Date().toISOString().slice(0, 10), cname = String(country || cc).slice(0, 60);
  let skipped = 0;
  for (const e of els) {
    const s = scan.fromOsm(e, c, cc, cname, today, cityOf); if (!s) { skipped++; continue; }
    if (s.osm && hiddenOsm.has(s.osm)) { skipped++; continue; } // el radar ya lo descartó (público o no es colegio)
    const k = scan.matchExisting(pool, idx, s);
    if (k) { if (seen.length < 800 && byId.has(k.x.id)) seen.push(sales.schoolListItem(byId.get(k.x.id))); continue; }
    const rec = scan.addTo(pool, idx, s);
    rec.src = "buscador"; rec.addedBy = req.session.user.email; if (area) rec.area = area;
    candidates.push({ rec, sig: signRec(rec) });
  }
  // una zona enorme: se mandan 3000 y se avisa cuántos quedaron afuera (el navegador sugiere ir por ciudad)
  res.json({ city: c.name, found: els.length, skipped, candidates: candidates.slice(0, 3000), total: candidates.length, truncated: Math.max(0, candidates.length - 3000), seen });
}));
app.post("/api/scan/verify", auth, wrap(async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 10) : [];
  const recs = items.filter(x => x && x.rec && sigOk(x.rec, x.sig)).map(x => ({ ...x.rec }));
  if (items.length && !recs.length) return res.status(400).json({ error: "Candidatos inválidos" });
  // pudo entrar mientras tanto (otra búsqueda u otra instancia): se vuelve a cruzar
  const idx = scan.buildIndex(schools), fresh = [];
  for (const r of recs) {
    if ((r.osm && hiddenOsm.has(r.osm)) || scan.matchExisting(schools, idx, r)) continue;
    let id = r.id, i = 2; while (byId.has(id)) id = `${r.id}-${i++}`; r.id = id;
    fresh.push(r);
  }
  const signal = cancelOnClose(req, res);
  const { keep, drop, cancelled } = await verifyCandidates(fresh, signal);
  if (cancelled || signal.aborted) return; // canceló: no se guarda nada de esta tanda
  const added = addSchools(keep);
  // lo descartado no vuelve a salir como candidato (ni se paga otra vez por verificarlo)
  dropOsm(fresh.filter(r => !keep.includes(r)).map(r => r.osm));
  // sin Redis en Vercel lo sumado vive en la memoria de una instancia: el navegador lo avisa
  res.json({ added: added.map(sales.schoolListItem), dropped: drop, sources: enrichSources(), temporary: !kvEnabled && !!process.env.VERCEL });
}));

// Radar: lo que encontró el agente de prospección (scripts/radar.mjs).
// Se lee en cada pedido (es chico): así refleja la última corrida aunque el servidor siga vivo.
const RADAR_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "data", "radar", "state.json");
const regionNames = new Intl.DisplayNames("es", { type: "region" });
const regionName = cc => { try { return regionNames.of(cc) || cc; } catch { return cc; } };
function radarState() { try { return JSON.parse(fs.readFileSync(RADAR_FILE, "utf8")); } catch { return { cities: {}, scanned: {}, runs: [] }; } }
app.get("/api/radar", auth, (req, res) => {
  const st = radarState();
  const countries = {};
  for (const [cc, list] of Object.entries(st.cities || {})) {
    const name = Object.entries(MARKETS).find(([, m]) => m.code === cc)?.[0] || regionName(cc);
    const scanned = list.filter(c => st.scanned?.[`${cc}|${c.id ? "n" + c.id : c.name}`] || st.scanned?.[`${cc}|${c.name}`]).length;
    countries[name] = { cities: list.length, scanned, schools: schools.filter(s => s.country === name).length, found: schools.filter(s => s.country === name && s.src === "osm").length };
  }
  const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  const fresh = schools.filter(s => s.found && s.found >= weekAgo);
  const top = fresh.map(s => ({ s, r: sales.scoreFor(s) })).filter(x => x.r).sort((a, b) => b.r.score - a.r.score).slice(0, 40)
    .map(({ s, r }) => ({ ...sales.schoolListItem(s), score: r.score, reasons: r.reasons, opp: s.opp || [], found: s.found }));
  const byCity = new Map();
  for (const s of fresh) { const k = `${s.city}|${s.country}`; byCity.set(k, (byCity.get(k) || 0) + 1); }
  res.json({ runs: (st.runs || []).slice(0, 12), countries, total: schools.length, fromRadar: schools.filter(s => s.src === "osm").length, weekNew: fresh.length,
    weekPhone: fresh.filter(s => s.phone).length,
    topCities: [...byCity].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, n]) => { const [city, country] = k.split("|"); return { city, country, n }; }), top, google: googleEnabled(), ai: ai.aiEnabled() });
});
// OrderBrain general: sitios de World Dominion (clientes de OrderEAT) para el mapa.
// a los líderes, además, si el token de World Dominion falta, venció, vence pronto o lo rechazaron (sin el token)
app.get("/api/brain", auth, wrap(async (req, res) => {
  const out = brainState();
  if ((await viewerFor(req.session.user.email)).all) out.token = await brainTokenAlert();
  res.json(out);
}));
// actividad reciente: con equipos, solo lo de su gente (un líder: el equipo elegido; un miembro: su equipo; sin equipo: lo suyo)
app.get("/api/feed", auth, wrap(async (req, res) => { const t = await viewTeam(req); res.json(await sales.teamFeed(t.filter)); }));
app.get("/api/stats", auth, (req, res) => res.json(sales.stats(req.session.user, req.tz)));

// ---------- asistente
app.post("/api/chat", auth, wrap(async (req, res) => {
  const messages = Array.isArray(req.body.messages) ? req.body.messages : [];
  if (!messages.length) return res.status(400).json({ error: "Mensaje vacío" });
  res.json(await ai.chat({ user: await liveUser(req.session.user), messages, focus: byId.has(req.body.focus) ? req.body.focus : null, tz: req.tz }));
}));
app.post("/api/proposals/confirm", auth, wrap(async (req, res) => {
  const token = String(req.body?.id || "");
  const p = ai.getProposal(token);
  if (!p) return res.status(404).json({ error: "La propuesta venció. Pedila de nuevo en el chat." });
  if (p.requestedBy !== req.session.user.email) return res.status(403).json({ error: "Esta propuesta es de otra persona." });
  const claim = await ai.claimProposal(token);
  if (claim !== true) {
    if (claim.state === "done") return res.json({ ok: true, already: true, orgUrl: claim.orgUrl || pd.PD_WEB });
    if (claim.state === "discarded") return res.status(410).json({ error: "Esta propuesta se descartó. Pedila de nuevo en el chat." });
    return res.status(409).json({ error: "Se está guardando. Esperá unos segundos y actualizá." });
  }
  let out;
  try { out = await confirmProposal(p, req); }
  catch (e) { await ai.releaseProposal(token); throw e; }
  await ai.finishProposal(token, "done", out.orgUrl);
  // la nota o la actividad nueva tiene que verse ya en el Historial de esa ficha
  await sales.dropTimeline(p.schoolId || null);
  res.json(out);
}));
async function confirmProposal(p, req) {
  const user = await liveUser(req.session.user);
  let orgId = p.orgId, dealId = p.dealId, leadId = null;
  const vs = p.schoolId && byId.get(p.schoolId);
  if (vs?.leadOnly) leadId = vs.leadId; // ficha de un prospecto sin organización: se escribe en el prospecto
  else if (!orgId && p.schoolId) { const rec = await sales.ensureOrg(p.schoolId, user.pdUserId); orgId = rec.orgId; dealId = dealId || rec.openDealId; }
  if (!orgId && !leadId) {
    const hits = await pd.searchOrganizations(p.colegio, 5);
    const exact = hits.find(h => pd.norm(h.name) === pd.norm(p.colegio));
    orgId = exact ? exact.id : (await pd.createOrganization({ name: p.colegio, ownerId: user.pdUserId })).id;
  }
  // cada uno trabaja lo suyo: una organización de otra persona solo admite agendarle una demo (o lo hace un líder: de un
  // equipo, si es de su gente)
  if (orgId && !(p.kind === "activity" && p.type === "meeting") && user.leads !== true) {
    const o = (await pd.orgsByIds([orgId]))[0];
    if (o?.ownerId && user.pdUserId && o.ownerId !== user.pdUserId && !TM.canLead(user.leads, { id: o.ownerId })) throw Object.assign(new Error("Esa organización es de otra persona en Pipedrive."), { status: 409 });
  }
  const by = sales.signer(user);
  const target = leadId ? { leadId } : { orgId, dealId };
  if (p.kind === "activity") {
    const u = toUtc(p.date, p.time, p.tz || req.tz);
    await pd.addActivity({ subject: p.subject, type: p.type, dueDate: u.date, dueTime: u.time, durationMin: p.durationMin, ...target, ownerId: p.owner.id, note: p.note ? `${p.note}\n\n(Agendado por ${by} desde OrderBrain SDR)` : `Agendado por ${by} desde OrderBrain SDR` });
    if (p.type === "meeting") await sales.demoReminder({ name: vs?.name || p.colegio, ...target, date: p.date, time: p.time, tz: p.tz || req.tz, user }).catch(e => console.warn("Recordatorio de demo:", e.message));
  } else {
    const esc = s => String(s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
    await pd.addNote({ content: `<b>Nota desde el asistente</b><br>${esc(p.text).replace(/\n/g, "<br>")}<br><br><i>Cargado por ${esc(by)} desde OrderBrain SDR</i>`, ...target });
  }
  return { ok: true, orgUrl: leadId ? `${pd.PD_WEB}/leads/inbox/${leadId}` : `${pd.PD_WEB}/organization/${orgId}` };
}
app.post("/api/proposals/discard", auth, wrap(async (req, res) => {
  const token = String(req.body?.id || "");
  if (ai.getProposal(token)?.requestedBy === req.session.user.email && (await ai.claimProposal(token)) === true) await ai.finishProposal(token, "discarded");
  res.json({ ok: true });
}));

// ---------- frontend
const pub = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
app.use(express.static(pub, { extensions: ["html"], maxAge: PROD ? "5m" : 0 }));
app.get("*", (req, res) => res.sendFile(path.join(pub, "index.html"), err => err && res.redirect("/")));

// En Vercel la app se exporta como función; en cualquier otro lado levanta su propio servidor.
if (!process.env.VERCEL) app.listen(PORT, () => console.log(`OrderBrain SDR en http://localhost:${PORT}`));
export default app;
