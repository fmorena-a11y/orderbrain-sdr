import express from "express";
import crypto from "crypto";
import cookieSession from "cookie-session";
import { OAuth2Client } from "google-auth-library";
import path from "path";
import { fileURLToPath } from "url";
import * as pd from "./lib/pipedrive.js";
import { kv, key as kvKey, schools, byId, sync, flush, kvEnabled, getStudy, setStudy, withLock, addSchools, syncExtras, cacheGet, cacheSet, canonicalId, hiddenOsm, dropOsm, getProfile, setProfile, getProfiles, ROLES } from "./lib/store.js";
import * as scan from "./lib/scan.js";
import { ensureBrain, brainState, brainDown } from "./lib/brain.js";
import { verifyCandidates, enrichSources } from "./lib/enrich.js";
import { research, studyEnabled, studyToHtml } from "./lib/study.js";
import * as sales from "./lib/sales.js";
import * as ai from "./lib/ai.js";
import { photosFor, googleEnabled } from "./lib/photos.js";
import fs from "fs";
import { MARKETS, LOST_REASONS, TYPE_LABEL, DAILY_GOAL } from "./lib/config.js";
import { safeTz, toUtc } from "./lib/time.js";

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
app.use(express.json({ limit: "200kb" }));
app.use(cookieSession({
  name: "obsdr", keys: [process.env.SESSION_SECRET || "dev-only-secret"], maxAge: 14 * 864e5,
  sameSite: "lax", secure: PROD, httpOnly: true,
}));
if (process.env.VERCEL && !kvEnabled) console.warn("⚠ Sin Redis (KV_REST_API_URL): en Vercel la meta, el ranking y la cadencia se reinician cada tanto.");
// Antes de responder, espera que se guarden las escrituras pendientes (en Vercel la función se congela después).
app.use((req, res, next) => {
  const json = res.json.bind(res);
  res.json = body => { flush().then(() => json(body), () => json(body)); return res; };
  next();
});
// Trae de Redis lo que registraron otras instancias.
app.use("/api", (req, res, next) => { // x-brain-down: cada respuesta dice si ESTA instancia tiene los clientes de World Dominion (si no, el navegador avisa)
  Promise.all([sync(), syncExtras(), ensureBrain()]).finally(() => { res.setHeader("x-brain-down", brainDown() ? "1" : "0"); next(); }); });

// ---------- auth
async function attachPipedriveUser(email) {
  try { const m = await pd.meta(); const u = m.users.find(x => x.email === email.toLowerCase()); return u ? { pdUserId: u.id, pdName: u.name } : {}; }
  catch { return {}; }
}
app.get("/auth/config", (req, res) => res.json({ googleClientId: GOOGLE_CLIENT_ID, devLogin: DEV_OK, codeLogin: !!TEAM_CODE, domain: DOMAIN, demo: pd.DEMO }));
// Líderes: quien conectó Pipedrive (dueño del token) y los emails de LEADER_EMAILS. El rol no se elige: lo define esto.
const LEADERS = (process.env.LEADER_EMAILS || "").split(",").map(e => e.trim().toLowerCase()).filter(Boolean);
async function isLeader(email) {
  email = String(email || "").toLowerCase();
  if (LEADERS.includes(email)) return true;
  try { return (await pd.tokenOwner()).email === email; } catch { return false; }
}
// Código personal: cada persona entra con su email y SU código (derivado del email con la clave del servidor),
// así nadie entra como otro sabiendo un código compartido. El código de equipo solo sirve para los líderes.
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
  const ok = validEmail && (same(code, personalCode(email)) || (same(code, TEAM_CODE.toLowerCase()) && await isLeader(email)));
  await new Promise(r => setTimeout(r, 400));
  if (!ok) return res.status(401).json({ error: DOMAIN && email && !email.endsWith("@" + DOMAIN) ? `Usá tu email @${DOMAIN}.` : "Email o código incorrecto. Tu código personal te lo pasa el líder del equipo." });
  await clearTries(keys);
  const pdu = await attachPipedriveUser(email);
  // con el Pipedrive real, solo entran los usuarios de la cuenta
  if (MODE === "live" && !pdu.pdUserId) return res.status(403).json({ error: "Ese email no es usuario del Pipedrive de OrderEAT." });
  req.session.user = { email, name: pdu.pdName || email.split("@")[0], ...pdu };
  req.session.mode = MODE;
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
    res.json({ user: req.session.user });
  } catch { res.status(401).json({ error: "No se pudo validar el login de Google." }); }
});
app.post("/auth/dev", async (req, res) => {
  if (!DEV_OK) return res.status(404).end();
  const pdu = await attachPipedriveUser(DEV_EMAIL);
  req.session.user = { email: DEV_EMAIL.toLowerCase(), name: pdu.pdName || DEV_EMAIL.split("@")[0], ...pdu };
  req.session.mode = MODE;
  res.json({ user: req.session.user });
});
app.post("/auth/logout", (req, res) => { req.session = null; res.json({ ok: true }); });

const auth = (req, res, next) => {
  if (!req.session?.user) return res.status(401).json({ error: "Iniciá sesión." });
  if (req.session.mode !== MODE || (DOMAIN && !req.session.user.email.endsWith("@" + DOMAIN) && MODE === "live")) { req.session = null; return res.status(401).json({ error: "Iniciá sesión." }); }
  req.tz = safeTz(req.get("x-tz"));
  next();
};
// READ_ONLY=1: nada se escribe en Pipedrive (para probar contra la cuenta real sin tocarla)
if (process.env.READ_ONLY === "1") app.use((req, res, next) => req.method === "POST" && /^\/api\/(schools\/[^/]+\/(match|log|comment|prospect|study\/note)|activities\/|proposals\/confirm)/.test(req.path) ? res.status(403).json({ error: "Modo solo lectura: no se escribe en Pipedrive." }) : next());
const wrap = fn => (req, res) => fn(req, res).catch(e => {
  if (res.writableEnded || res.destroyed) return; // el navegador ya cortó (canceló): no hay a quién responder
  const status = e.status && e.status < 600 ? (e instanceof pd.PipedriveError && e.status >= 500 ? 502 : e.status) : 500;
  if (status >= 500) console.error(e);
  res.status(status).json({ error: e instanceof pd.PipedriveError ? `Pipedrive: ${e.message}` : e.message });
});
// Cada uno cambia solo sus actividades (marcar hecha, deshacer, reprogramar); un líder puede con todas.
async function ownActivity(user, id, { missingOk } = {}) {
  const a = await pd.getActivity(Number(id));
  if (!a && missingOk) return null;
  if (!a) throw Object.assign(new Error("No encontré esa actividad en Pipedrive."), { status: 404 });
  const owner = a.owner_id ?? a.user_id ?? a.assigned_to_user_id ?? null;
  if (owner && user.pdUserId && Number(owner) === Number(user.pdUserId)) return a;
  if (await isLeader(user.email)) return a;
  throw Object.assign(new Error("Esa actividad es de otra persona en Pipedrive: no la podés cambiar."), { status: 403 });
}
// las fichas de Pipedrive (prospectos y organizaciones fuera de la base) se rearman si esta instancia no las tiene
const schoolParam = (req, res, next) => {
  const go = () => { req.params.id = canonicalId(req.params.id); next(); };
  if (byId.has(req.params.id)) return go();
  sales.ensureRecord(req.params.id).then(ok => ok ? go() : res.status(404).json({ error: "Colegio inexistente" }), () => res.status(404).json({ error: "Colegio inexistente" }));
};

// ---------- API
// Perfil: nombre completo y rol. Si la persona ya lo cargó, manda sobre el nombre que viene de Google o Pipedrive.
// El rol «Líder» lo define el servidor (isLeader); el perfil solo elige entre SDR y Account Executive.
const withProfile = (u, pr, leader) => {
  const role = leader ? "lider" : pr?.role === "lider" ? "sdr" : pr?.role || "";
  return pr ? { ...u, name: pr.name, role, roleLabel: ROLES[role] || "" } : { ...u, role, roleLabel: ROLES[role] || "" };
};
app.get("/api/me", auth, wrap(async (req, res) => {
  const [pr, leader] = await Promise.all([getProfile(req.session.user.email), isLeader(req.session.user.email)]);
  req.session.user = withProfile(req.session.user, pr, leader);
  const roles = leader ? { lider: ROLES.lider } : { sdr: ROLES.sdr, ae: ROLES.ae };
  res.json({
  user: req.session.user, profile: { complete: !!(pr?.name && (pr?.role || leader)), suggested: req.session.user.pdName || "", roles, leader }, ai: ai.aiEnabled(), study: studyEnabled(), demo: pd.DEMO, goal: DAILY_GOAL, pdWeb: pd.PD_WEB,
  countries: [...new Set(schools.map(s => s.country))].sort(), markets: MARKETS, outcomes: sales.OUTCOMES, lostReasons: LOST_REASONS, types: TYPE_LABEL,
  });
}));
app.post("/api/me/profile", auth, wrap(async (req, res) => {
  const name = String(req.body?.name || "").replace(/\s+/g, " ").trim().slice(0, 80), role = String(req.body?.role || "");
  if (name.split(" ").filter(w => w.length > 1).length < 2) return res.status(400).json({ error: "Escribí tu nombre y apellido." });
  const leader = await isLeader(req.session.user.email);
  const r = leader ? "lider" : role;
  if (!Object.hasOwn(ROLES, r) || (r === "lider" && !leader)) return res.status(400).json({ error: "Elegí tu rol en el equipo (SDR o Account Executive)." });
  const pr = await setProfile(req.session.user.email, { name, role: r });
  req.session.user = withProfile(req.session.user, pr, leader);
  res.json({ user: req.session.user });
}));
// ficha de un prospecto (lead) o de una organización de Pipedrive que no está en la base
app.get("/api/records/:kind/:rid", auth, wrap(async (req, res) => {
  if (!["lead", "org"].includes(req.params.kind)) return res.status(400).json({ error: "Ficha inválida" });
  res.json(await sales.openRecord(req.params.kind, req.params.rid));
}));
app.get("/api/schools", auth, (req, res) => res.json(schools.map(sales.schoolListItem)));
// Accesos del equipo: el código personal de cada persona (solo lo ve un líder, para pasárselo)
app.get("/api/team/codes", auth, wrap(async (req, res) => {
  if (!(await isLeader(req.session.user.email))) return res.status(403).json({ error: "Solo un líder ve los accesos del equipo." });
  const m = await pd.meta();
  res.json({ url: `${req.protocol}://${req.get("host")}`, users: m.users.filter(u => u.email && (!DOMAIN || u.email.endsWith("@" + DOMAIN))).map(u => ({ id: u.id, name: u.name, email: u.email, code: personalCode(u.email) })) });
}));
app.get("/api/team", auth, wrap(async (req, res) => {
  const [m, prs] = await Promise.all([pd.meta(), getProfiles()]);
  res.json(m.users.map(u => { const pr = prs[u.email]; return { id: u.id, name: pr?.name || u.name, role: pr ? ROLES[pr.role] : "" }; }));
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
  const { orgId, orgName } = req.body;
  if (orgId === null) sales.unlinkSchool(req.params.id);
  res.json(await sales.schoolDetail(req.params.id, { user: req.session.user, tz: req.tz, ...(orgId === null ? {} : { org: { id: Number(orgId), name: String(orgName || "") } }) }));
}));
app.get("/api/schools/:id/next", auth, schoolParam, (req, res) => res.json(sales.nextFor(req.params.id, req.query.outcome, req.query.channel, req.tz) || {}));
app.post("/api/schools/:id/log", auth, schoolParam, wrap(async (req, res) => {
  const body = { ...(req.body || {}) };
  // si la actividad a completar ya no está en Pipedrive, el contacto se registra igual
  const gone = !!body.completeActivityId && !(await ownActivity(req.session.user, body.completeActivityId, { missingOk: true }));
  if (gone) delete body.completeActivityId;
  const r = await sales.logContact(req.params.id, req.session.user, body, req.tz);
  if (gone) r.done.push({ label: "La actividad ya no está en Pipedrive.", warn: true });
  res.json(r);
}));
const escHtml = v => String(v).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
// Comentario suelto: queda como nota en la organización de Pipedrive, sin registrar un contacto.
app.post("/api/schools/:id/prospect", auth, schoolParam, wrap(async (req, res) => res.json(await sales.createProspect(req.params.id, req.session.user, req.body?.task || null, req.tz))));
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
  res.json({ done, school: sales.schoolSummary(s), orgUrl: url });
}));
app.get("/api/schools/:id/photos", auth, schoolParam, wrap(async (req, res) => {
  res.set("cache-control", "private, max-age=3600");
  res.json({ photos: await photosFor(req.params.id, { refresh: req.query.refresh === "1" }), google: googleEnabled() });
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
app.post("/api/schools/:id/draft", auth, schoolParam, wrap(async (req, res) => {
  const { channel, purpose, contact, base } = req.body || {};
  res.json(await ai.draft(req.params.id, { channel: channel === "mail" ? "mail" : "whatsapp", purpose: String(purpose || "avanzar a una demo").slice(0, 200), contact: String(contact || "").slice(0, 80), base: String(base || "").slice(0, 3000), user: req.session.user }));
}));

// Hoy: métricas, agenda propia y a quién contactar.
app.get("/api/today", auth, wrap(async (req, res) => {
  const countries = String(req.query.countries || "").split(",").filter(Boolean);
  const mine = await sales.myActivities(req.session.user).catch(e => ({ warning: e.message, items: [] }));
  const busyOrgs = new Set(mine.items.map(a => a.orgId).filter(Boolean));
  res.json({ stats: sales.stats(req.session.user, req.tz), activities: mine, queue: sales.prospectQueue({ countries, limit: 60, excludeOrgIds: busyOrgs, userId: req.session.user.pdUserId || null }) });
}));
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
  await ownActivity(req.session.user, req.params.id);
  const u = toUtc(date, time && /^\d{2}:\d{2}$/.test(time) ? time : "", req.tz);
  await pd.updateActivity(Number(req.params.id), { due_date: u.date, ...(u.time ? { due_time: u.time } : {}) });
  res.json({ ok: true });
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
app.get("/api/brain", auth, (req, res) => res.json(brainState()));
app.get("/api/feed", auth, wrap(async (req, res) => res.json(await sales.teamFeed())));
app.get("/api/stats", auth, (req, res) => res.json(sales.stats(req.session.user, req.tz)));

// ---------- asistente
app.post("/api/chat", auth, wrap(async (req, res) => {
  const messages = Array.isArray(req.body.messages) ? req.body.messages : [];
  if (!messages.length) return res.status(400).json({ error: "Mensaje vacío" });
  res.json(await ai.chat({ user: req.session.user, messages, focus: byId.has(req.body.focus) ? req.body.focus : null, tz: req.tz }));
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
  res.json(out);
}));
async function confirmProposal(p, req) {
  const user = req.session.user;
  let orgId = p.orgId, dealId = p.dealId, leadId = null;
  const vs = p.schoolId && byId.get(p.schoolId);
  if (vs?.leadOnly) leadId = vs.leadId; // ficha de un prospecto sin organización: se escribe en el prospecto
  else if (!orgId && p.schoolId) { const rec = await sales.ensureOrg(p.schoolId, user.pdUserId); orgId = rec.orgId; dealId = dealId || rec.openDealId; }
  if (!orgId && !leadId) {
    const hits = await pd.searchOrganizations(p.colegio, 5);
    const exact = hits.find(h => pd.norm(h.name) === pd.norm(p.colegio));
    orgId = exact ? exact.id : (await pd.createOrganization({ name: p.colegio, ownerId: user.pdUserId })).id;
  }
  // cada uno trabaja lo suyo: una organización de otra persona solo admite agendarle una demo (o lo hace un líder)
  if (orgId && !(p.kind === "activity" && p.type === "meeting") && user.role !== "lider") {
    const o = (await pd.orgsByIds([orgId]))[0];
    if (o?.ownerId && user.pdUserId && o.ownerId !== user.pdUserId) throw Object.assign(new Error("Esa organización es de otra persona en Pipedrive."), { status: 409 });
  }
  const by = sales.signer(user);
  const target = leadId ? { leadId } : { orgId, dealId };
  if (p.kind === "activity") {
    const u = toUtc(p.date, p.time, p.tz || req.tz);
    await pd.addActivity({ subject: p.subject, type: p.type, dueDate: u.date, dueTime: u.time, durationMin: p.durationMin, ...target, ownerId: p.owner.id, note: p.note ? `${p.note}\n\n(Agendado por ${by} desde OrderBrain SDR)` : `Agendado por ${by} desde OrderBrain SDR` });
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
