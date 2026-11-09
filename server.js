import express from "express";
import cookieSession from "cookie-session";
import { OAuth2Client } from "google-auth-library";
import path from "path";
import { fileURLToPath } from "url";
import * as pd from "./lib/pipedrive.js";
import { schools, byId } from "./lib/store.js";
import * as sales from "./lib/sales.js";
import * as ai from "./lib/ai.js";
import { MARKETS, LOST_REASONS, TYPE_LABEL, DAILY_GOAL } from "./lib/config.js";
import { safeTz, toUtc } from "./lib/time.js";

const app = express();
const PORT = process.env.PORT || 3000;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const DOMAIN = (process.env.ALLOWED_EMAIL_DOMAIN || "").toLowerCase();
const DEV_EMAIL = process.env.DEV_LOGIN_EMAIL || "";
const PROD = process.env.NODE_ENV === "production";
// En modo demo (Pipedrive de prueba) se permite entrar sin Google aunque sea producción: no hay datos reales.
const DEV_OK = !!DEV_EMAIL && (!PROD || pd.DEMO);
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

// ---------- auth
async function attachPipedriveUser(email) {
  try { const m = await pd.meta(); const u = m.users.find(x => x.email === email.toLowerCase()); return u ? { pdUserId: u.id, pdName: u.name } : {}; }
  catch { return {}; }
}
app.get("/auth/config", (req, res) => res.json({ googleClientId: GOOGLE_CLIENT_ID, devLogin: DEV_OK, demo: pd.DEMO }));
app.post("/auth/google", async (req, res) => {
  try {
    if (!google) return res.status(500).json({ error: "El login con Google no está configurado (GOOGLE_CLIENT_ID)." });
    const t = await google.verifyIdToken({ idToken: req.body.credential, audience: GOOGLE_CLIENT_ID });
    const p = t.getPayload();
    if (!p.email_verified) return res.status(403).json({ error: "Tu email de Google no está verificado." });
    if (DOMAIN && !p.email.toLowerCase().endsWith("@" + DOMAIN)) return res.status(403).json({ error: `Solo pueden entrar cuentas @${DOMAIN}.` });
    req.session.user = { email: p.email.toLowerCase(), name: p.name || p.email, picture: p.picture || "", ...(await attachPipedriveUser(p.email)) };
    res.json({ user: req.session.user });
  } catch { res.status(401).json({ error: "No se pudo validar el login de Google." }); }
});
app.post("/auth/dev", async (req, res) => {
  if (!DEV_OK) return res.status(404).end();
  const pdu = await attachPipedriveUser(DEV_EMAIL);
  req.session.user = { email: DEV_EMAIL.toLowerCase(), name: pdu.pdName || DEV_EMAIL.split("@")[0], ...pdu };
  res.json({ user: req.session.user });
});
app.post("/auth/logout", (req, res) => { req.session = null; res.json({ ok: true }); });

const auth = (req, res, next) => {
  if (!req.session?.user) return res.status(401).json({ error: "Iniciá sesión." });
  req.tz = safeTz(req.get("x-tz"));
  next();
};
const wrap = fn => (req, res) => fn(req, res).catch(e => {
  const status = e.status && e.status < 600 ? (e instanceof pd.PipedriveError && e.status >= 500 ? 502 : e.status) : 500;
  if (status >= 500) console.error(e);
  res.status(status).json({ error: e instanceof pd.PipedriveError ? `Pipedrive: ${e.message}` : e.message });
});
const schoolParam = (req, res, next) => byId.has(req.params.id) ? next() : res.status(404).json({ error: "Colegio inexistente" });

// ---------- API
app.get("/api/me", auth, (req, res) => res.json({
  user: req.session.user, ai: ai.aiEnabled(), demo: pd.DEMO, goal: DAILY_GOAL, pdWeb: pd.PD_WEB,
  countries: [...new Set(schools.map(s => s.country))].sort(), markets: MARKETS, outcomes: sales.OUTCOMES, lostReasons: LOST_REASONS, types: TYPE_LABEL,
}));
app.get("/api/schools", auth, (req, res) => res.json(schools.map(sales.schoolSummary)));
app.get("/api/team", auth, wrap(async (req, res) => { const m = await pd.meta(); res.json(m.users.map(u => ({ id: u.id, name: u.name }))); }));

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
  res.json(await sales.logContact(req.params.id, req.session.user, req.body || {}, req.tz));
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
  res.json({ stats: sales.stats(req.session.user, req.tz), activities: mine, queue: sales.prospectQueue({ countries, limit: 60, excludeOrgIds: busyOrgs }) });
}));
app.get("/api/my-activities", auth, wrap(async (req, res) => res.json(await sales.myActivities(req.session.user))));
app.post("/api/activities/:id/done", auth, wrap(async (req, res) => { await pd.updateActivity(Number(req.params.id), { done: true }); res.json({ ok: true }); }));
app.post("/api/activities/:id/move", auth, wrap(async (req, res) => {
  const { date, time } = req.body || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) return res.status(400).json({ error: "Fecha inválida" });
  const u = toUtc(date, time && /^\d{2}:\d{2}$/.test(time) ? time : "", req.tz);
  await pd.updateActivity(Number(req.params.id), { due_date: u.date, ...(u.time ? { due_time: u.time } : {}) });
  res.json({ ok: true });
}));
app.get("/api/feed", auth, wrap(async (req, res) => res.json(await sales.teamFeed())));
app.get("/api/stats", auth, (req, res) => res.json(sales.stats(req.session.user, req.tz)));

// ---------- asistente
app.post("/api/chat", auth, wrap(async (req, res) => {
  const messages = Array.isArray(req.body.messages) ? req.body.messages : [];
  if (!messages.length) return res.status(400).json({ error: "Mensaje vacío" });
  res.json(await ai.chat({ user: req.session.user, messages, focus: byId.has(req.body.focus) ? req.body.focus : null, tz: req.tz }));
}));
app.post("/api/proposals/:id/confirm", auth, wrap(async (req, res) => {
  const p = ai.getProposal(req.params.id);
  if (!p) return res.status(404).json({ error: "La propuesta venció. Pedila de nuevo en el chat." });
  if (p.requestedBy !== req.session.user.email) return res.status(403).json({ error: "Esta propuesta es de otra persona." });
  if (p.done) return res.json({ ok: true, already: true, orgUrl: p.orgUrl });
  let orgId = p.orgId, dealId = p.dealId;
  if (!orgId && p.schoolId) { const rec = await sales.ensureOrg(p.schoolId); orgId = rec.orgId; dealId = dealId || rec.openDealId; }
  if (!orgId) {
    const hits = await pd.searchOrganizations(p.colegio, 5);
    const exact = hits.find(h => pd.norm(h.name) === pd.norm(p.colegio));
    orgId = exact ? exact.id : (await pd.createOrganization({ name: p.colegio })).id;
  }
  const by = req.session.user.name || req.session.user.email;
  if (p.kind === "activity") {
    const u = toUtc(p.date, p.time, p.tz || req.tz);
    await pd.addActivity({ subject: p.subject, type: p.type, dueDate: u.date, dueTime: u.time, durationMin: p.durationMin, orgId, dealId, ownerId: p.owner.id, note: p.note ? `${p.note}\n\n(Agendado por ${by} desde OrderBrain SDR)` : `Agendado por ${by} desde OrderBrain SDR` });
  } else {
    const esc = s => String(s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
    await pd.addNote({ content: `<b>Nota desde el asistente</b><br>${esc(p.text).replace(/\n/g, "<br>")}<br><br><i>Cargado por ${esc(by)} desde OrderBrain SDR</i>`, orgId, dealId });
  }
  p.done = true; p.orgUrl = `${pd.PD_WEB}/organization/${orgId}`;
  res.json({ ok: true, orgUrl: p.orgUrl });
}));
app.post("/api/proposals/:id/discard", auth, (req, res) => { ai.dropProposal(req.params.id); res.json({ ok: true }); });

// ---------- frontend
const pub = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
app.use(express.static(pub, { extensions: ["html"], maxAge: PROD ? "5m" : 0 }));
app.get("*", (req, res) => res.sendFile(path.join(pub, "index.html"), err => err && res.redirect("/")));

// En Vercel la app se exporta como función; en cualquier otro lado levanta su propio servidor.
if (!process.env.VERCEL) app.listen(PORT, () => console.log(`OrderBrain SDR en http://localhost:${PORT}`));
export default app;
