import express from "express";
import crypto from "crypto";
import cookieSession from "cookie-session";
import { OAuth2Client } from "google-auth-library";
import path from "path";
import { fileURLToPath } from "url";
import * as pd from "./lib/pipedrive.js";
import { kv, key as kvKey, schools, byId, sync, flush, kvEnabled, syncExtras, canonicalId, getProfile, setProfile, ROLES, syncArchived, getAccessMap, getTeams, bump } from "./lib/store.js";
import * as ACC from "./lib/access.js";
import * as TM from "./lib/teams.js";
import { writesPipedrive } from "./lib/readonly.js";
import { ARCHIVE_REASONS } from "./lib/archive.js";
import { ensureBrain, brainState, brainDown, brainTokenAlert } from "./lib/brain.js";
import { studyEnabled } from "./lib/study.js";
import * as sales from "./lib/sales.js";
import * as sessions from "./lib/sessions.js";
import * as ai from "./lib/ai.js";
import fs from "fs";
import { MARKETS, LOST_REASONS, TYPE_LABEL, DAILY_GOAL, FOUNDERS_DEFAULT } from "./lib/config.js";
import { safeTz } from "./lib/time.js";
import * as gmail from "./lib/gmail.js";
import { mountAccounts } from "./lib/accounts-api.js";
import { mountBases } from "./lib/bases-api.js";
import { mountInbound } from "./lib/inbound-api.js";
import { mountDeals } from "./lib/deals-api.js";
import { mountLead } from "./lib/lead-api.js";
import { mountAe } from "./lib/ae-api.js";
import { mountConnect } from "./lib/connect-api.js";
import { mountTeam } from "./lib/team-api.js";
import { mountMetrics } from "./lib/metrics-api.js";
import { mountAdmin } from "./lib/admin-api.js";
import { mountSchools } from "./lib/schools-api.js";
import { mountAgenda } from "./lib/agenda-api.js";
import { mountScan } from "./lib/scan-api.js";
import { mountMap } from "./lib/map-api.js";
import { mountAssistant } from "./lib/assistant-api.js";
import { compressJson, pickEncoding, encode, ENABLED as COMPRESS } from "./lib/compress.js";
import { lc } from "./lib/text.js";

const app = express();
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
// JSON grande comprimido (gzip o brotli según el accept-encoding del pedido). En Vercel ya comprime la plataforma: apagado ahí.
app.use(compressJson());
// JSON de 200 kb; la tabla que el asistente lleva a Google Sheets puede ser más grande (lib/sheets-export.js topa filas)
{ const json = express.json({ limit: "200kb" }), big = express.json({ limit: "4mb" }); app.use((req, res, next) => (req.path === "/api/sheets/export" ? big : json)(req, res, next)); }
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
// googleLogin: «Entrar con Google» en un solo paso (entra y conecta mail, calendario y planillas): solo con el cliente OAuth
// completo (GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET) o, en el demo, con el Google simulado. Sin eso, la pantalla queda como hoy.
const googleLoginOn = () => gmail.gmailEnabled() && (!gmail.simulated() || DEV_OK);
app.get("/auth/config", (req, res) => res.json({ googleClientId: GOOGLE_CLIENT_ID, googleLogin: googleLoginOn(), devLogin: DEV_OK, codeLogin: !!TEAM_CODE, domain: DOMAIN, demo: pd.DEMO }));
// Acceso de líder (lib/access.js) y equipos (lib/teams.js). Fijo (no se saca desde la app): quien conectó Pipedrive (dueño
// del token) y LEADER_EMAILS son líderes, FOUNDER_EMAILS dirección; los dos ven todos los equipos y los arman. Lo demás lo
// asigna dirección en Equipo (getAccessMap, getTeams). Con equipos, un líder de equipo ve y toca solo lo de su gente.
// El rol no se elige en el perfil: lo define esto.
const LEADERS = ACC.parseEmails(process.env.LEADER_EMAILS), FOUNDERS = ACC.parseEmails([process.env.FOUNDER_EMAILS || "", ...FOUNDERS_DEFAULT].join(","));
const ownerEmail = async () => { try { return (await pd.tokenOwner()).email || ""; } catch { return ""; } };
const fixedOf = (email, owner) => ACC.fixedLevel(email, { owner, leaders: LEADERS, founders: FOUNDERS });
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
// clave de los códigos personales y de los candidatos firmados del buscador de zonas
const SCAN_SECRET = process.env.SESSION_SECRET || "dev-only-secret";
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
  // con un código (el líder ve los códigos) no se probó ser dueño de la cuenta: para mandar mails desde su Pipedrive o su
  // Gmail hay que conectarlo (o confirmarlo) en esta sesión
  req.session.gmailOk = null; req.session.pdOk = null;
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
    req.session.gmailOk = p.email.toLowerCase(); // Google probó que es su cuenta: puede enviar con el Gmail o el Pipedrive que conectó
    req.session.pdOk = null;
    res.json({ user: req.session.user });
  } catch { res.status(401).json({ error: "No se pudo validar el login de Google." }); }
});
app.post("/auth/dev", async (req, res) => {
  if (!DEV_OK) return res.status(404).end();
  const pdu = await attachPipedriveUser(DEV_EMAIL);
  req.session.user = { email: DEV_EMAIL.toLowerCase(), name: pdu.pdName || DEV_EMAIL.split("@")[0], ...pdu };
  req.session.mode = MODE;
  req.session.gmailOk = null; req.session.pdOk = null;
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
  // un error de la IA (Anthropic: 401 clave, 429 cupo, 5xx) nunca sale con su status: un 401 de ellos le cerraría la sesión
  // a la persona. Va como 502 con code ai_down y un texto fijo (sin el detalle del proveedor).
  if (ai.isAiError(e)) { console.error(`IA: ${e.status || ""} ${String(e.message || "").slice(0, 200)}`); return res.status(502).json({ error: "La IA no está disponible ahora. Probá de nuevo en un rato.", code: "ai_down" }); }
  const status = e.status && e.status < 600 ? (e instanceof pd.PipedriveError && e.status >= 500 ? 502 : e.status) : 500;
  if (status >= 500) console.error(e);
  // code: un identificador corto para que el navegador sepa qué hacer (gmail_reauth, gmail_unknown…); nunca datos
  const code = typeof e.code === "string" && /^[a-z][a-z_]{1,40}$/.test(e.code) ? { code: e.code } : {};
  // candidates: lo que ya hay en Pipedrive y se parece al colegio (sales.settleExisting): la ficha pregunta «¿es alguno de estos?»
  const cands = Array.isArray(e.candidates) ? { candidates: e.candidates } : {};
  // take: el prospecto de otra persona que se puede pasar a tu nombre («Ya hablé con X: pasámelo»): clave y dueño
  const take = e.take && typeof e.take.key === "string" ? { take: { key: e.take.key, owner: String(e.take.owner || "") } } : {};
  res.status(status).json({ error: e instanceof pd.PipedriveError ? `Pipedrive: ${e.message}` : e.message, ...code, ...cands, ...take });
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
  // un colegio cuyo cruce es un prospecto sin organización se trabaja como la ficha de ese prospecto (sales.leadView)
  const go = () => { req.params.id = canonicalId(req.params.id); sales.leadView(byId.get(req.params.id)); next(); };
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
  countries: [...new Set(schools.map(s => s.country))].sort(), workCountries: sales.workCountries({ email: req.session.user.email, pdUserId: req.session.user.pdUserId, leader: v.leader }), markets: MARKETS, outcomes: sales.OUTCOMES, lostReasons: LOST_REASONS, archiveReasons: ARCHIVE_REASONS, types: TYPE_LABEL,
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
// ---------- lo que comparten las rutas de lib/*-api.js (nombres del perfil, equipo elegido, Radar)
// el nombre del perfil (manda sobre el de Google o Pipedrive en firmas y saludos)
const signName = async user => (await getProfile(user.email).catch(() => null))?.name || "";
const meName = async req => (await getProfile(req.session.user.email).catch(() => null))?.name || req.session.user.name || "";
// usuarios del Pipedrive con email del dominio del equipo (Equipo, accesos, «Hoy» del líder)
const teamUsers = m => m.users.filter(u => u.email && (!DOMAIN || u.email.endsWith("@" + DOMAIN)));
// Lo de líder que se mira por equipo (Métricas, Equipo): ?team= (lib/teams.js pickTeam). Un líder de otro equipo, 403.
const teamInfo = (T, id) => id ? { id, name: TM.teamById(T, id)?.name || "" } : null;
async function viewTeam(req) {
  const v = await viewerFor(req.session.user.email), m = await pd.meta();
  const f = TM.viewFilter(v, v.T, m.users, String(req.query.team || ""));
  if (f.error) throw httpErr(f.error);
  return { v, filter: f.filter, team: teamInfo(v.T, f.id), self: !!f.self, unknown: !!f.unknown };
}
// Métricas entera es solo para líderes y dirección (pedido del líder): a los demás, 403 antes de leer nada. Después, el equipo.
async function mxTeam(req, msg) {
  const v = await viewerFor(req.session.user.email);
  if (!v.leader) throw httpErr(v.unknown ? TM.TEAMS_DOWN : { status: 403, error: v.acc.stale ? TM.STALE_MSG : msg });
  const p = TM.pickTeam(v, v.T, String(req.query.team || ""));
  if (p.error) throw httpErr(p.error);
  return { filter: p.id ? TM.filterOf(v.T, [p.id], (await pd.meta()).users) : null, team: teamInfo(v.T, p.id), on: v.on };
}
// Sincronizar y World Dominion son de toda la cuenta: quien ve todo (dirección y los fijos; sin equipos, cualquier líder)
async function allOnly(req, res, msg) { const v = await viewerFor(req.session.user.email); if (v.all) return true; res.status(403).json({ error: v.leader ? "Esto es de toda la cuenta: lo maneja dirección." : msg }); return false; }
// Radar: lo que encontró el agente de prospección (scripts/radar.mjs). Se lee en cada pedido (es chico): así refleja la
// última corrida aunque el servidor siga vivo. Lo usan el Radar (lib/scan-api.js) y la base de Métricas.
const RADAR_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "data", "radar", "state.json");
function radarState() { try { return JSON.parse(fs.readFileSync(RADAR_FILE, "utf8")); } catch { return { cities: {}, scanned: {}, runs: [] }; } }

// Gmail, «Entrar con Google», «Tu firma» y «Conectá tu Pipedrive» (lib/connect-api.js); devuelve lo que usan las rutas del mail
const { MAIL_PER_HOUR, gmailName, gmailPick, gmailProven, mailSig, pdProof, pdProven } = mountConnect(app, { DEV_EMAIL, DEV_OK, DOMAIN, MODE, attachPipedriveUser, auth, baseRole, googleLoginOn, signName, viewerFor, wrap });

// Accounts por país y calendario para demos (lib/accounts.js, rutas en lib/accounts-api.js)
mountAccounts(app, { auth, wrap, schoolParam, viewerFor, leadScopeFor, meName: req => meName(req) });
// Cargar base: la planilla de un evento por link, archivo o pegada, cruzada con Pipedrive (lib/bases.js, rutas en lib/bases-api.js)
mountBases(app, { auth, wrap, schoolParam, leadScopeFor });
mountInbound(app, { auth, wrap, leadScopeFor });
// Tratos abiertos (vista para los accounts): solo lectura, con el alcance de Métricas y Equipo (lib/deals-api.js, lib/dealsview.js)
mountDeals(app, { auth, wrap, viewerFor, leadScopeFor });
// «Hoy» del líder (panel del día de su gente): solo lectura, solo líderes y dirección, por equipo (lib/lead-api.js, lib/leadview.js)
mountLead(app, { auth, wrap, viewerFor, leadScopeFor, teamUsers: m => teamUsers(m) });
// «Hoy» del account: sus demos, sus tareas y sus tratos que piden atención (lib/ae-api.js, lib/aeview.js). Solo lectura, solo lo suyo.
mountAe(app, { auth, wrap });

// ficha de un prospecto (lead) o de una organización de Pipedrive que no está en la base
app.get("/api/records/:kind/:rid", auth, wrap(async (req, res) => {
  if (!["lead", "org"].includes(req.params.kind)) return res.status(400).json({ error: "Ficha inválida" });
  res.json(await sales.openRecord(req.params.kind, req.params.rid));
}));
// Búsqueda en toda la base de Pipedrive (personas, organizaciones, prospectos y tratos), en vivo y solo lectura: cualquiera
// con sesión (es la misma cuenta de Pipedrive). Tope por persona para que una búsqueda trabada no agote la cuota del token.
// type (+ cursor, term): «Ver más» de un grupo, la página siguiente de ese tipo.
app.get("/api/pd-search", auth, wrap(async (req, res) => {
  const str = k => typeof req.query[k] === "string" ? req.query[k] : "";
  if ((await bump(`pds:${req.session.user.email}`, 60)) > 90) return res.status(429).json({ error: "Muchas búsquedas seguidas: esperá un minuto." });
  res.json(await (str("type") ? sales.pdSearchMore(str("q"), str("type"), str("cursor"), str("term")) : sales.pdSearch(str("q"))));
}));
// un trato pegado como link en un buscador: a qué ficha lleva (su organización o su persona), solo lectura
app.get("/api/pd-deal/:id", auth, wrap(async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: "Trato inválido" });
  const d = await pd.getDeal(req.params.id);
  if (!d) return res.status(404).json({ error: "No encontré ese trato en Pipedrive: puede estar borrado." });
  const id = x => (x && typeof x === "object" ? x.value ?? x.id : x) || null;
  res.json({ id: d.id, title: d.title || "", orgId: id(d.org_id ?? d.orgId), personId: id(d.person_id ?? d.personId) });
}));
// ficha de una persona de Pipedrive (sus datos, su organización, tratos, prospectos, actividades y notas)
app.get("/api/pd-person/:id", auth, wrap(async (req, res) => res.json(await sales.personCard(req.params.id))));
// La lista de colegios: sales.schoolList la guarda armada mientras nada cambió, con su ETag. El navegador la guarda
// (Cache-Control: private, no-cache = siempre pregunta) y, si no cambió, recibe un 304 sin cuerpo. Comprimida una vez por versión.
// Por país (decisión del líder: «por país»): ?cc=México (o MX) trae solo ese país; con muchos colegios, en partes
// (&part=0&parts=3, cuántas lo dice el resumen). Sin cc, toda la base como siempre (compatibilidad: el navegador ya no la pide).
async function sendJsonMemo(req, res, L) {
  res.set({ ETag: L.etag, "Cache-Control": "private, no-cache" }); res.vary("Accept-Encoding");
  await flush();
  if (req.fresh) return res.status(304).end();
  res.type("application/json");
  const enc = COMPRESS ? pickEncoding(req.headers["accept-encoding"]) : null;
  if (!enc) return res.send(L.json);
  let out = null; try { out = await (L.enc[enc] ||= encode(L.json, enc)); } catch { delete L.enc[enc]; } // si no se pudo comprimir, va sin comprimir
  if (!out) return res.send(L.json);
  res.set("Content-Encoding", enc).send(out);
}
app.get("/api/schools", auth, wrap(async (req, res) => {
  if (req.query.cc === undefined) return sendJsonMemo(req, res, sales.schoolList());
  const country = sales.countryParam(String(req.query.cc));
  if (!country) return res.status(400).json({ error: "País inválido" });
  const parts = Number(req.query.parts ?? 1), part = Number(req.query.part ?? 0);
  if (!Number.isInteger(parts) || parts < 1 || parts > 16 || !Number.isInteger(part) || part < 0 || part >= parts) return res.status(400).json({ error: "Parte inválida" });
  await sendJsonMemo(req, res, sales.schoolList(Date.now(), { country, part, parts }));
}));
// resumen por país y ciudad (vista mundial de Prospectar y chips de país): ≈40 KB, con su ETag
app.get("/api/schools/summary", auth, wrap(async (req, res) => sendJsonMemo(req, res, sales.schoolsSummary())));
// buscar en toda la base lo que el navegador no tiene cargado: ?q=&not=Argentina,Chile (países que ya tiene) o &only=… ; hasta 50
const csvList = v => typeof v === "string" ? v.split(",").map(x => sales.countryParam(x)).filter(Boolean) : [];
app.get("/api/schools/search", auth, wrap(async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.slice(0, 120) : "";
  if ((await bump(`ssearch:${req.session.user.email}`, 60)) > 240) return res.status(429).json({ error: "Muchas búsquedas seguidas: esperá un minuto." });
  res.json(sales.searchSchools(q, { not: csvList(req.query.not), only: csvList(req.query.only), limit: Math.min(50, Math.max(1, Number(req.query.limit) || 50)) }));
}));
// colegios sueltos de países que el navegador no cargó (una ficha desde Hoy, la Agenda, una sesión): ?ids=a,b (hasta 100)
app.get("/api/schools/items", auth, (req, res) => {
  const ids = String(req.query.ids || "").split(",").map(x => x.trim()).filter(Boolean).slice(0, 100);
  res.json(sales.schoolItems(ids));
});
// Equipo: accesos, equipos y «Demos» (lib/team-api.js); Métricas (lib/metrics-api.js); sincronización y World Dominion (lib/admin-api.js)
mountTeam(app, { FOUNDERS, LEADERS, accessView, auth, fixedOf, httpErr, labelOf, mxTeam, otherViewer, personalCode, signName, teamUsers, viewerFor, wrap });
mountMetrics(app, { auth, mxTeam, radarState, wrap });
mountAdmin(app, { allOnly, auth, same, wrap });
// la ficha de un colegio: /api/check y /api/schools/:id/… (lib/schools-api.js)
mountSchools(app, { MAIL_PER_HOUR, auth, gmailName, gmailPick, gmailProven, leadScopeFor, mailSig, meName, ownActivity, ownDeal, pdProof, pdProven, schoolParam, signName, wrap });
// Hoy, sesiones, cola y actividades de la agenda (lib/agenda-api.js); buscador de zonas y Radar (lib/scan-api.js)
mountAgenda(app, { auth, leadScopeFor, ownActivity, signName, wrap });
// mapa de Google en Prospectar (solo con GOOGLE_MAPS_BROWSER_KEY; si no, Esri)
mountMap(app, { auth, wrap });
mountScan(app, { SCAN_SECRET, auth, radarState, wrap });
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
// asistente: charla, exportar y propuestas firmadas (lib/assistant-api.js)
mountAssistant(app, { auth, liveUser, wrap });

// ---------- frontend
const pub = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
app.use(express.static(pub, { extensions: ["html"], maxAge: PROD ? "5m" : 0 }));
app.get("*", (req, res) => res.sendFile(path.join(pub, "index.html"), err => err && res.redirect("/")));

// En Vercel la app se exporta como función; en cualquier otro lado levanta su propio servidor.
if (!process.env.VERCEL) app.listen(PORT, () => console.log(`OrderBrain SDR en http://localhost:${PORT}`));
export default app;
