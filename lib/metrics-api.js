// Métricas (vista Métricas, GET /api/metrics/:section y /people): solo líderes y dirección, por equipo (mxTeam de server.js).
// Los cálculos están en lib/metrics.js y las lecturas en lib/sales/reports.js. server.js la monta con mountMetrics(app, deps).
import { FILE_COUNTS, schools } from "./store.js";
import { brainSites } from "./brain.js";
import * as MX from "./metrics.js";
import * as sales from "./sales.js";
import * as psync from "./sync.js";

export function mountMetrics(app, { auth, mxTeam, radarState, wrap }) {
  // ---------- Métricas (vista Métricas): solo líderes y dirección (los totales, lo suyo y el desglose por persona; a los demás,
  // 403 antes de leer nada). Con equipos, todo es del equipo elegido (?team=, lib/teams.js pickTeam): totales y por persona,
  // solo su gente; dirección elige un equipo o «Toda la cuenta»; un líder de equipo, solo los suyos (otro equipo: 403). La base de
  // colegios y los clientes de World Dominion son de toda la cuenta. Pipedrive se lee de a páginas y se guarda 10 minutos
  // (lib/sales.js); los cálculos están en lib/metrics.js. Cada respuesta dice de cuándo es y si la lista vino cortada (partial).
  const mxOpts = (req, team = null) => ({ days: MX.periodParam(req.query.days), country: String(req.query.country || "").slice(0, 60), team });
  const MX_LOAD = {
    demos: (req, team) => sales.metricsDemos(req.tz, mxOpts(req, team)),
    deals: (req, team) => sales.metricsDeals(req.tz, mxOpts(req, team)),
    contacts: (req, team) => sales.metricsContacts(req.tz, mxOpts(req, team)),
    archived: (req, team) => sales.metricsArchived(req.tz, mxOpts(req, team)),
    // actividad por persona: todo es por persona (solo líderes); el país no aplica (una actividad no dice de qué país es)
    activity: (req, team) => sales.metricsActivity(req.tz, mxOpts(req, team)),
    // inbound (prospectos y tratos con Fuente inbound, lib/metrics.js inboundSummary): el país no aplica (un prospecto no siempre lo dice)
    inbound: (req, team) => sales.metricsInbound(req.tz, mxOpts(req, team)),
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
}
