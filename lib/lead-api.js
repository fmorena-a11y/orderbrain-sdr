// «Hoy» del líder (public/js/leadhome.js; lógica pura en lib/leadview.js). server.js la monta con
// mountLead(app, { auth, wrap, viewerFor, leadScopeFor, teamUsers }). SOLO LECTURA y SOLO líderes y dirección (a los demás, 403
// antes de leer nada; equipos sin leer, 503, como Métricas). Multitenant como Métricas y Equipo (lib/teams.js pickTeam, ?team=):
// un líder de equipo ve solo su gente; dirección y los fijos, un equipo o «Toda la cuenta»; sin equipos, todos.
//  - GET /api/lead/today?team=&part=acts,demos,inbound,deals: la gente (una fila por persona) y las partes pedidas (sin part,
//    las cuatro). Cada parte dice de cuándo es su lectura; si falla, va { error } y las demás siguen. alerts: «Para mirar hoy».
//  - GET /api/lead/person/:id?fresh=1: la agenda de hoy y las vencidas de una persona (su líder, dirección o ella misma).
// No lee nada que no lean ya Métricas («7 días»), Equipo › Demos, Tratos abiertos y Tus inbound: mismas lecturas, mismas copias.
import * as pd from "./pipedrive.js";
import * as sales from "./sales.js";
import * as LV from "./leadview.js";
import * as IR from "./inbound-run.js";
import { teamRows } from "./deals-api.js";
import { getProfiles } from "./store.js";
import { FREE_OWNERS, DEFAULT_ACCOUNTS } from "./config.js";
import { pickTeam, filterOf, teamById, canLead, TEAMS_DOWN, STALE_MSG } from "./teams.js";
import { todayIn, addDays } from "./time.js";
import { lc } from "./text.js";

const httpErr = e => Object.assign(new Error(e.error), { status: e.status });
const MSG = "El panel del equipo solo lo ven los líderes y dirección.";
// la agenda de una persona: copia de 2 minutos en memoria (abrir y cerrar su detalle no vuelve a leer Pipedrive)
const AG = new Map(), AG_TTL = 120e3;
function agenda(id, fresh) {
  const hit = AG.get(id);
  if (!fresh && hit && Date.now() - hit.t < AG_TTL) return hit.p;
  for (const [k, v] of AG) if (Date.now() - v.t >= AG_TTL) AG.delete(k);
  const p = sales.myActivities({ pdUserId: id }).then(r => ({ at: new Date().toISOString(), items: r.items || [] }));
  AG.set(id, { t: Date.now(), p }); p.catch(() => AG.delete(id));
  return p;
}

export function mountLead(app, { auth, wrap, viewerFor, leadScopeFor, teamUsers = m => m.users }) {
  // quién mira y sobre qué gente: 403 a quien no es líder (antes de leer nada), el equipo elegido y su gente
  async function gate(req) {
    const me = req.session.user, email = lc(me.email), v = await viewerFor(email);
    if (!v.leader) throw httpErr(v.unknown ? TEAMS_DOWN : { status: 403, error: v.acc?.stale ? STALE_MSG : MSG });
    const p = pickTeam(v, v.T, String(req.query.team || ""));
    if (p.error) throw httpErr(p.error);
    const [m, profiles, lead] = await Promise.all([pd.meta(), getProfiles(), leadScopeFor(email)]);
    const filter = p.id ? filterOf(v.T, [p.id], m.users) : null;
    const ae = new Set(m.users.filter(u => profiles[lc(u.email)]?.role === "ae" || Object.values(DEFAULT_ACCOUNTS).map(Number).includes(Number(u.id))).map(u => Number(u.id)));
    const people = LV.peopleFor({ users: teamUsers(m), profiles, free: FREE_OWNERS, team: filter, ae, lead, meId: me.pdUserId, canLead });
    return { me, email, v, m, profiles, lead, filter, people, ids: new Set(people.map(x => x.id)), team: p.id ? { id: p.id, name: teamById(v.T, p.id)?.name || "" } : null };
  }
  const LOAD = {
    acts: async (g, tz) => { const r = await sales.leadActs(tz); return LV.actsPart({ ...r, ids: g.ids, free: FREE_OWNERS }); },
    demos: async (g, tz) => { const r = await sales.leadDemos(tz, g.filter); return LV.demosPart({ month: r.month, win: r.window, ids: g.ids, today: r.today, tomorrow: addDays(r.today, 1) }); },
    inbound: async (g, tz) => {
      // Slack aparte: si falla, el inbound de Pipedrive va igual (y al revés no: sin Pipedrive no hay parte)
      const [inb, list] = await Promise.all([sales.metricsInbound(tz, { days: LV.INB_DAYS, team: g.filter }), IR.listFor(g.me, g.lead).catch(() => null)]);
      const slack = list ? { on: !!list.slack?.on, error: list.slack?.error || "", items: (list.items || []).map(x => ({ email: x.assignee?.email || "", hoursLeft: x.hoursLeft, state: x.state })) } : null;
      return LV.inboundPart({ inb, slack: slack && (slack.on || slack.items.length) ? slack : null, ids: g.ids, emails: new Map(g.m.users.map(u => [lc(u.email), Number(u.id)])) });
    },
    deals: async (g, tz) => LV.dealsPart({ ...(await teamRows({ filter: g.filter, m: g.m, profiles: g.profiles, tz })), ids: g.ids }),
  };
  app.get("/api/lead/today", auth, wrap(async (req, res) => {
    const g = await gate(req), tz = req.tz, today = todayIn(tz);
    const asked = String(req.query.part || "").split(",").map(x => x.trim()).filter(x => Object.hasOwn(LOAD, x)), want = asked.length ? asked : LV.PARTS;
    const parts = Object.fromEntries(await Promise.all(want.map(async k => [k, await LOAD[k](g, tz).catch(e => ({ error: e?.message || "No se pudo leer." }))])));
    res.json({ at: new Date().toISOString(), today, tomorrow: addDays(today, 1), tz, scope: { team: g.team, on: g.v.on, all: !!g.v.all }, pdWeb: pd.PD_WEB,
      people: g.people, parts, alerts: LV.alertsOf(parts), defs: LV.DEFS, limits: { lateMany: LV.LATE_MANY, soonHours: LV.SOON_H, inboundDays: LV.INB_DAYS } });
  }));
  app.get("/api/lead/person/:id", auth, wrap(async (req, res) => {
    const g = await gate(req), id = Number(req.params.id);
    const u = /^\d+$/.test(String(req.params.id)) ? g.m.users.find(x => Number(x.id) === id) : null;
    if (!u || FREE_OWNERS.has(id)) return res.status(404).json({ error: "Esa persona no es usuaria del Pipedrive de OrderEAT." });
    if (id !== Number(g.me.pdUserId) && !canLead(g.lead, { id, email: lc(u.email) })) return res.status(403).json({ error: "Esa persona no es de tu equipo: su día lo ve su líder o dirección." });
    const a = await agenda(id, req.query.fresh === "1"), pr = g.profiles[lc(u.email)];
    res.json({ at: a.at, tz: req.tz, today: todayIn(req.tz), person: { id, name: pr?.name || u.name || "" }, ...LV.personDay(a.items, { tz: req.tz, today: todayIn(req.tz) }) });
  }));
}
