// Rutas de accounts y calendario (lib/accounts.js). server.js las monta con mountAccounts(app, { … }) y les pasa sus
// guardas (auth, wrap, schoolParam) y quién mira (viewerFor, leadScopeFor). Ninguna escribe en Pipedrive.
//  - /api/me/accounts: los accounts por país de quien mira. /api/team/accounts/:email: los de otra persona, para dirección
//    (o un líder fijo) y el líder de su equipo (leadScopeFor: nunca sobre otro líder o dirección); los demás, 403.
//  - /api/me/calendar…: el calendario para demos de quien mira (nadie cambia el de otro). Nunca devuelven la dirección.
//  - /api/schools/:id/account, /api/accounts/:id/free, /api/schools/:id/demo-message: cualquiera con sesión, solo lectura.
import * as A from "./accounts.js";
import * as pd from "./pipedrive.js";
import { canLead } from "./teams.js";
import { byId, canonicalId, bump } from "./store.js";

const lc = e => String(e || "").trim().toLowerCase();
const httpErr = (status, error) => Object.assign(new Error(error), { status });
export function mountAccounts(app, { auth, wrap, schoolParam, viewerFor, leadScopeFor, meName = async () => "" }) {
  const me = req => lc(req.session.user.email);
  // ¿puede quien mira cambiar los accounts de esa persona?
  async function canEdit(req, email) {
    const m = await pd.meta();
    if (!m.users.some(u => lc(u.email) === email)) throw httpErr(404, "Esa persona no es usuaria del Pipedrive de OrderEAT.");
    if (email === me(req)) return;
    const v = await viewerFor(me(req));
    if (v.admin) return;
    if (v.leader && canLead(await leadScopeFor(me(req)), { email })) return;
    throw httpErr(403, v.leader ? "Sus accounts los cambia dirección: no es de tu equipo." : "Los accounts de otra persona los cambia dirección o el líder de su equipo.");
  }
  app.get("/api/me/accounts", auth, wrap(async (req, res) => res.json(await A.accountsView(me(req)))));
  app.post("/api/me/accounts", auth, wrap(async (req, res) => res.json(await A.saveAccounts(me(req), req.body?.accounts, { by: me(req) }))));
  app.get("/api/team/accounts/:email", auth, wrap(async (req, res) => { const e = lc(req.params.email); await canEdit(req, e); res.json(await A.accountsView(e)); }));
  app.post("/api/team/accounts/:email", auth, wrap(async (req, res) => { const e = lc(req.params.email); await canEdit(req, e); res.json(await A.saveAccounts(e, req.body?.accounts, { by: me(req) })); }));

  // calendario para demos: solo el propio
  const slow = async (req, k, n, sec) => { if ((await bump(`${k}:${me(req)}`, sec)) > n) throw httpErr(429, "Probaste muchas veces seguidas: esperá un rato."); };
  app.get("/api/me/calendar", auth, wrap(async (req, res) => res.json(await A.calendarView(me(req)))));
  app.post("/api/me/calendar", auth, wrap(async (req, res) => { await slow(req, "calset", 10, 600); res.json(await A.connectCalendar(me(req), String(req.body?.url ?? ""))); }));
  app.post("/api/me/calendar/test", auth, wrap(async (req, res) => { await slow(req, "caltest", 20, 600); res.json(await A.testCalendar(me(req))); }));
  app.post("/api/me/calendar/hours", auth, wrap(async (req, res) => res.json(await A.saveHours(me(req), req.body || {}))));
  app.post("/api/me/calendar/disconnect", auth, wrap(async (req, res) => res.json(await A.disconnectCalendar(me(req)))));

  // el account que te toca para este colegio (por su país y tu perfil) y los demás
  app.get("/api/schools/:id/account", auth, schoolParam, wrap(async (req, res) => res.json(await A.schoolAccount(byId.get(req.params.id), me(req)))));
  // horarios libres de un account (cualquiera con sesión): solo libre/ocupado
  app.get("/api/accounts/:pdUserId/free", auth, wrap(async (req, res) => {
    if ((await bump(`free:${me(req)}`, 60)) > 60) return res.status(429).json({ error: "Muchos pedidos seguidos: esperá un minuto." });
    const sid = typeof req.query.schoolId === "string" && req.query.schoolId ? canonicalId(req.query.schoolId) : "";
    const school = sid ? byId.get(sid) : null;
    if (sid && !school) return res.status(404).json({ error: "Colegio inexistente" });
    res.set("cache-control", "no-store");
    res.json(await A.freeFor(req.params.pdUserId, { school, viewerEmail: me(req), viewerTz: req.tz, duration: req.query.duration, days: req.query.days }));
  }));
  // el mensaje con los horarios elegidos (?account=&at=…&at=…&duration=&channel=whatsapp|mail&contact=)
  app.get("/api/schools/:id/demo-message", auth, schoolParam, wrap(async (req, res) => {
    const at = [].concat(req.query.at || []).map(String).slice(0, 5);
    res.json(await A.demoMessage(byId.get(req.params.id), { pdUserId: req.query.account, ats: at, duration: req.query.duration, channel: String(req.query.channel || ""), contact: String(req.query.contact || ""), me: await meName(req) }));
  }));
}
