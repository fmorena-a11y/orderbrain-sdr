// Hoy, sesiones de trabajo (lib/sessions.js), bandeja caliente, cola y actividades de la agenda (hecha, deshacer, mover,
// resultado de una demo y reagendarla). server.js la monta con mountAgenda(app, deps).
import * as pd from "./pipedrive.js";
import * as sales from "./sales.js";
import * as sessions from "./sessions.js";
import { toUtc, todayIn } from "./time.js";

export function mountAgenda(app, { auth, leadScopeFor, ownActivity, signName, wrap }) {
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
  app.patch("/api/sessions/:sid", auth, wrap(async (req, res) => res.json(await sessions.updateFor(req.session.user.email, req.params.sid, req.body || {}, Date.now(), todayIn(req.tz)))));
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
  app.post("/api/activities/:id/demo-result", auth, wrap(async (req, res) => {
    const a = await ownActivity(req.session.user, req.params.id), b = req.body || {};
    res.json(await sales.markDemo(a, req.session.user, { result: String(b.result || ""), date: b.date, time: b.time, by: await signName(req.session.user) }, req.tz, await leadScopeFor(req.session.user.email)));
  }));
  app.post("/api/activities/:id/demo-rebook", auth, wrap(async (req, res) => {
    const a = await ownActivity(req.session.user, req.params.id), b = req.body || {};
    res.json(await sales.rebookDemo(a, req.session.user, { date: b.date, time: b.time, by: await signName(req.session.user) }, req.tz));
  }));
}
