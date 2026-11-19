// «Hoy» del account (public/js/aehome.js): GET /api/ae/today[?fresh=1]. server.js la monta con mountAe(app, { auth, wrap }).
// SOLO LECTURA y SOLO de quien entra: sus tratos abiertos de venta (dueño = su usuario de Pipedrive; las mismas lecturas con
// copia de 2 minutos que Tratos abiertos, lib/deals-api.js), sus actividades sin hacer (sales.myActivities, la lectura de la
// Agenda, copia de 1 minuto) y sus actividades hechas más recientes (para contar las demos de la semana, copia de 2 minutos).
// fresh=1 (después de registrar algo o «Actualizar») lee todo de nuevo. Lo que no se pudo leer va null: la pantalla pone «?».
// La lógica (qué es una demo de hoy, qué trato pide atención y por qué) es pura: lib/aeview.js.
import * as pd from "./pipedrive.js";
import * as DV from "./dealsview.js";
import * as AE from "./aeview.js";
import { openDeals, details, rowCtx, cached } from "./deals-api.js";
import { getProfiles, orgToSchool, canonicalId } from "./store.js";
import { demoResult } from "./demos.js";
import { userId } from "./metrics.js";
import { myActivities } from "./sales.js";

const ACTS_TTL = 60, DONE_TTL = 120, ATT_MAX = 300;
const quiet = p => p.catch(e => { console.warn("Hoy del account:", e.message); return null; });

// sus tratos abiertos de venta como filas de dealRow, y cada trato sin organización con su persona (para ubicar su ficha)
async function myDeals(id, tz, fresh) {
  const raw = await openDeals({ ownerId: id }, { fresh });
  const deals = raw.deals.filter(d => userId(d.owner_id) === id);
  const [x, m, profiles] = await Promise.all([details(deals, { fresh }), pd.meta(), getProfiles()]);
  const ctx = rowCtx({ m, profiles, x, tz });
  return { at: raw.at, truncated: !!raw.truncated, rows: DV.sortRows(deals.map(d => DV.dealRow(d, ctx)), "stage"), persons: new Map(deals.filter(d => !d.org_id && d.person_id).map(d => [Number(d.id), Number(d.person_id)])) };
}
// sus actividades hechas, de la más nueva a la más vieja: solo las demos y No Show (con el resultado que dejó la app), cuántas
// se leyeron y el vencimiento de la más vieja (para saber si la semana entró entera)
const myDone = (id, fresh) => cached(`ae:done:${id}`, async () => {
  const l = await pd.activities({ ownerId: id, done: true, limit: AE.ACTS_LIMIT });
  return { n: l.length, oldest: l.reduce((m, a) => (a.due_date && (!m || a.due_date < m) ? a.due_date : m), ""),
    demos: l.filter(a => a.type === "meeting" || a.type === "lunch").map(a => ({ id: a.id, type: a.type, due_date: a.due_date || "", due_time: a.due_time || "", mark: demoResult(a) })) };
}, fresh, DONE_TTL);

export function mountAe(app, { auth, wrap }) {
  app.get("/api/ae/today", auth, wrap(async (req, res) => {
    const me = req.session.user, id = Number(me.pdUserId) || null, fresh = req.query.fresh === "1", tz = req.tz, now = Date.now();
    if (!id) return res.json({ at: new Date(now).toISOString(), tz, noUser: true, staleDays: DV.STALE_DAYS, pdWeb: pd.PD_WEB, ...AE.buildToday({ rows: null, acts: null, done: null, tz, now }), warnings: [] });
    const [d, a, done] = await Promise.all([
      quiet(myDeals(id, tz, fresh)),
      quiet(cached(`ae:acts:${id}`, async () => { const r = await myActivities(me); if (r.warning) throw new Error(r.warning); return { items: r.items }; }, fresh, ACTS_TTL)),
      quiet(myDone(id, fresh)),
    ]);
    // un trato sin organización se abre por la organización de su persona (si tiene)
    const att = d ? AE.attention(d.rows).filter(r => !r.org && d.persons.has(r.id)) : [];
    const ps = att.length ? await pd.personsByIds([...new Set(att.map(r => d.persons.get(r.id)))]).catch(() => []) : [];
    const orgByPerson = new Map(ps.filter(p => p.orgId).map(p => [Number(p.id), Number(p.orgId)]));
    const out = AE.buildToday({ rows: d?.rows || null, acts: a?.items || null, done, tz, now, truncated: !!d?.truncated, orgOf: r => orgByPerson.get(d.persons.get(r.id)) || null });
    // en una cuenta con muchísimos tratos que piden atención, la pantalla recibe los primeros (los más urgentes) y cuántos son
    const more = Math.max(0, out.attention.deals.length - ATT_MAX);
    res.json({ at: d?.at || new Date(now).toISOString(), tz, staleDays: DV.STALE_DAYS, pdWeb: pd.PD_WEB, ...out, attention: { ...out.attention, deals: out.attention.deals.slice(0, ATT_MAX), more },
      session: out.session.slice(0, ATT_MAX), sessionTotal: out.session.length });
  }));
  // Los tratos abiertos de quien entra en una ficha (la franja de arriba de la ficha en una sesión «Tus tratos»): ref = el
  // colegio de la base, «org:<id>» (o pd-org-<id>) o «deal:<id>». Un trato sin organización entra por la de su persona.
  app.get("/api/ae/deals", auth, wrap(async (req, res) => {
    const id = Number(req.session.user.pdUserId) || null, ref = String(req.query.ref || "").slice(0, 140);
    if (!id || !ref) return res.json({ deals: [], pdWeb: pd.PD_WEB });
    const d = await myDeals(id, req.tz, req.query.fresh === "1");
    const m = /^(?:org:|pd-org-)(\d+)$/.exec(ref), dm = /^deal:(\d+)$/.exec(ref), orgs = new Set(m ? [Number(m[1])] : []);
    if (!m && !dm) for (const [oid, sid] of orgToSchool()) if (sid === ref || sid === canonicalId(ref)) orgs.add(Number(oid));
    let viaPerson = new Set();
    if (orgs.size && d.persons.size) {
      const ps = await pd.personsByIds([...new Set(d.persons.values())].slice(0, 100)).catch(() => []), at = new Map(ps.map(p => [Number(p.id), Number(p.orgId) || null]));
      viaPerson = new Set([...d.persons].filter(([, pid]) => orgs.has(at.get(pid))).map(([did]) => did));
    }
    const rows = d.rows.filter(r => (dm ? r.id === Number(dm[1]) : (r.org && orgs.has(r.org.id)) || r.school?.id === ref || viaPerson.has(r.id))).map(r => ({ ...r, why: AE.reasonsOf(r) }));
    res.json({ at: d.at, deals: rows, staleDays: DV.STALE_DAYS, pdWeb: pd.PD_WEB });
  }));
}
