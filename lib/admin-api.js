// Sincronización masiva con Pipedrive (lib/sync.js) y token de World Dominion (lib/brain.js): de toda la cuenta, solo
// quien ve todo (allOnly de server.js); el cron de Vercel con CRON_SECRET. server.js la monta con mountAdmin(app, deps).
import { schools } from "./store.js";
import { brainAdmin, saveBrainToken } from "./brain.js";
import * as sales from "./sales.js";
import * as psync from "./sync.js";
import { usage as aiUsage, dashboard as aiDashboard, setPlan as aiSetPlan } from "./aibudget.js";
import { getProfiles } from "./store.js";

export function mountAdmin(app, { allOnly, auth, same, wrap }) {
  // ---------- sincronización masiva con Pipedrive (lib/sync.js). Solo lee de Pipedrive: corre también con READ_ONLY=1.
  // Cuántos colegios hay en cada estado (lo mismo que ve la lista: World Dominion manda, «unk» = sin revisar)
  const stateCounts = () => { const c = {}; for (const s of schools) { const st = sales.schoolListItem(s).status; c[st] = (c[st] || 0) + 1; } return c; };
  // cron: hay CRON_SECRET (el cron diario sigue lo que quede en pausa)
  const syncView = async r => ({ ...r, counts: stateCounts(), total: schools.length, cron: !!process.env.CRON_SECRET });
  app.get("/api/admin/sync", auth, wrap(async (req, res) => {
    if (!(await allOnly(req, res, "Solo un líder sincroniza con Pipedrive."))) return;
    res.json(await syncView(await psync.status(req.session.user.name || req.session.user.email)));
  }));
  // Gasto de IA de los últimos 7 días (total, por persona y por función) y los topes: solo quien ve todo.
  app.get("/api/admin/ai-usage", auth, wrap(async (req, res) => {
    if (!(await allOnly(req, res, "Solo dirección ve el gasto de IA."))) return;
    res.json(await aiUsage(Math.min(31, Math.max(1, Number(req.query.days) || 7))));
  }));
  // Tablero de gasto (Equipo › Gasto de IA): API medida por la app + lo cargado a mano + suscripciones. Solo quien ve todo.
  app.get("/api/admin/ai-spend", auth, wrap(async (req, res) => {
    if (!(await allOnly(req, res, "Solo dirección ve el gasto de IA."))) return;
    const d = await aiDashboard(), prof = await getProfiles().catch(() => ({}));
    res.json({ ...d, names: Object.fromEntries(Object.keys(Object.assign({}, ...d.days.map(x => x.people))).map(e => [e, prof[e]?.name || (e === "-" ? "Sin persona (procesos automáticos)" : e)])) });
  }));
  app.post("/api/admin/ai-spend/plan", auth, wrap(async (req, res) => {
    if (!(await allOnly(req, res, "Solo dirección carga el gasto de IA."))) return;
    res.json({ plan: await aiSetPlan(req.body || {}, req.session.user.name || req.session.user.email) });
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
}
