import express from "express";
import cookieSession from "cookie-session";
import { OAuth2Client } from "google-auth-library";
import path from "path";
import { fileURLToPath } from "url";
import * as pd from "./lib/pipedrive.js";
import { schools, byId, sync, flush, kvEnabled, getStudy, setStudy, withLock, addSchools, syncExtras, cacheGet, cacheSet } from "./lib/store.js";
import * as scan from "./lib/scan.js";
import { ensureBrain, brainState } from "./lib/brain.js";
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
const DOMAIN = (process.env.ALLOWED_EMAIL_DOMAIN || "").toLowerCase();
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
app.use("/api", (req, res, next) => { Promise.all([sync(), syncExtras(), ensureBrain()]).then(() => next(), () => next()); });

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
const wrap = fn => (req, res) => fn(req, res).catch(e => {
  const status = e.status && e.status < 600 ? (e instanceof pd.PipedriveError && e.status >= 500 ? 502 : e.status) : 500;
  if (status >= 500) console.error(e);
  res.status(status).json({ error: e instanceof pd.PipedriveError ? `Pipedrive: ${e.message}` : e.message });
});
const schoolParam = (req, res, next) => byId.has(req.params.id) ? next() : res.status(404).json({ error: "Colegio inexistente" });

// ---------- API
app.get("/api/me", auth, (req, res) => res.json({
  user: req.session.user, ai: ai.aiEnabled(), study: studyEnabled(), demo: pd.DEMO, goal: DAILY_GOAL, pdWeb: pd.PD_WEB,
  countries: [...new Set(schools.map(s => s.country))].sort(), markets: MARKETS, outcomes: sales.OUTCOMES, lostReasons: LOST_REASONS, types: TYPE_LABEL,
}));
app.get("/api/schools", auth, (req, res) => res.json(schools.map(sales.schoolListItem)));
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
  const rec = await sales.ensureOrg(req.params.id);
  await pd.addNote({ content: studyToHtml(byId.get(req.params.id), st), orgId: rec.orgId, dealId: rec.openDealId });
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
  res.json({ stats: sales.stats(req.session.user, req.tz), activities: mine, queue: sales.prospectQueue({ countries, limit: 60, excludeOrgIds: busyOrgs }) });
}));
app.get("/api/my-activities", auth, wrap(async (req, res) => res.json(await sales.myActivities(req.session.user))));
app.post("/api/activities/:id/done", auth, wrap(async (req, res) => { await pd.updateActivity(Number(req.params.id), { done: true }); res.json({ ok: true }); }));
app.post("/api/activities/:id/undone", auth, wrap(async (req, res) => { await pd.updateActivity(Number(req.params.id), { done: false }); res.json({ ok: true }); }));
app.post("/api/activities/:id/move", auth, wrap(async (req, res) => {
  const { date, time } = req.body || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) return res.status(400).json({ error: "Fecha inválida" });
  const u = toUtc(date, time && /^\d{2}:\d{2}$/.test(time) ? time : "", req.tz);
  await pd.updateActivity(Number(req.params.id), { due_date: u.date, ...(u.time ? { due_time: u.time } : {}) });
  res.json({ ok: true });
}));
// ---------- buscador de zonas: «prospectá España», «Bogotá», «Provincia de Córdoba»
// El navegador recorre las ciudades de a una (así cada pedido es corto y se ve el avance).
const SCAN_MIN_POP = Number(process.env.RADAR_MIN_POP || 40000);
app.post("/api/scan/resolve", auth, wrap(async (req, res) => {
  const q = String(req.body?.q || "").trim().slice(0, 120);
  if (q.length < 2) return res.status(400).json({ error: "Escribí un país, una provincia o una ciudad." });
  const cached = await cacheGet("place:" + scan.norm(q));
  const place = cached || await scan.resolvePlace(q);
  if (!place) return res.status(404).json({ error: `No encontré «${q}». Probá con otro nombre.` });
  if (!cached) await cacheSet("place:" + scan.norm(q), place, 30 * 864e2);
  // nombre del país como lo usa la app (México, Perú…) si es uno de los mercados conocidos
  const known = Object.entries(MARKETS).find(([, m]) => m.code === place.cc);
  if (known) place.country = known[0];
  res.json(place);
}));
app.post("/api/scan/cities", auth, wrap(async (req, res) => {
  const { cc, areaId } = req.body || {};
  if (!/^[A-Z]{2}$/.test(cc || "") && !areaId) return res.status(400).json({ error: "Zona inválida" });
  const k = areaId ? `cities:a${Number(areaId)}` : `cities:${cc}`;
  let list = await cacheGet(k);
  if (!list) {
    const deadline = Date.now() + 240e3;
    list = areaId ? await scan.citiesInArea(areaId, { minPop: SCAN_MIN_POP, deadline, reserve: 5 }) : await scan.citiesFor(cc, { minPop: SCAN_MIN_POP, deadline, reserve: 5 });
    if (list.length) await cacheSet(k, list, 60 * 864e2);
  }
  res.json({ cities: list });
}));
app.post("/api/scan/city", auth, wrap(async (req, res) => {
  const { cc, country, city } = req.body || {};
  if (!/^[A-Z]{2}$/.test(cc || "") || !city || !Number.isFinite(+city.lat) || !Number.isFinite(+city.lng) || !String(city.name || "").trim()) return res.status(400).json({ error: "Ciudad inválida" });
  const c = { name: String(city.name).slice(0, 80), lat: +city.lat, lng: +city.lng, pop: Math.max(0, Number(city.pop) || 0) };
  const els = await scan.scanCity(cc, c, { deadline: Date.now() + 200e3, reserve: 5, attempts: 3 });
  const idx = scan.buildIndex(schools), fresh = [];
  let updated = 0;
  const today = new Date().toISOString().slice(0, 10);
  for (const e of els) {
    const s = scan.fromOsm(e, c, cc, String(country || cc).slice(0, 60), today); if (!s) continue;
    if (scan.matchExisting(schools, idx, s)) { updated++; continue; }
    // se arma el registro igual que en el radar, con id único
    const tmp = []; const rec = scan.addTo(tmp, { ...idx, ids: new Set([...idx.ids, ...fresh.map(x => x.id)]), osm: idx.osm, byName: idx.byName }, s);
    rec.src = "buscador"; rec.addedBy = req.session.user.email;
    fresh.push(rec);
  }
  const added = addSchools(fresh);
  res.json({ city: c.name, found: els.length, added: added.map(sales.schoolListItem), known: updated });
}));

// Radar: lo que encontró el agente de prospección (scripts/radar.mjs).
// Se lee en cada pedido (es chico): así refleja la última corrida aunque el servidor siga vivo.
const RADAR_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "data", "radar", "state.json");
function radarState() { try { return JSON.parse(fs.readFileSync(RADAR_FILE, "utf8")); } catch { return { cities: {}, scanned: {}, runs: [] }; } }
app.get("/api/radar", auth, (req, res) => {
  const st = radarState();
  const countries = {};
  for (const [cc, list] of Object.entries(st.cities || {})) {
    const name = { MX: "México", PE: "Perú", AR: "Argentina", CL: "Chile", UY: "Uruguay", GT: "Guatemala", CR: "Costa Rica" }[cc] || cc;
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
  return { ok: true, orgUrl: `${pd.PD_WEB}/organization/${orgId}` };
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
