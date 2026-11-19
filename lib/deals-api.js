// Tratos abiertos (vista «Tratos abiertos», #/tratos, public/js/deals.js): GET /api/deals/open?owner=me|<pdUserId>|team&team=.
// server.js la monta con mountDeals(app, { auth, wrap, viewerFor, leadScopeFor }). SOLO LECTURA: no escribe en Pipedrive.
// Alcance como Métricas y Equipo (lib/dealsview.js scopeOf): «Míos» (dueño o SDR) para todos; una persona o el equipo, un líder
// sobre su gente (leadScopeFor / pickTeam); dirección y los fijos, de cualquiera o toda la cuenta; lo demás, 403.
// Lecturas de Pipedrive (lib/pipedrive.js) con copia de 2 minutos: los abiertos de un dueño o de toda la cuenta (de a 500, hasta
// MAX_PAGES: si se corta, truncated) y, de los que entran, sus actividades (próxima y última) y organizaciones.
import crypto from "node:crypto";
import * as pd from "./pipedrive.js";
import * as DV from "./dealsview.js";
import { cacheGet, cacheSet, orgToSchool, byId, getProfiles } from "./store.js";
import { teamById } from "./teams.js";
import { lc } from "./text.js";

const TTL = 120, MAX_PAGES = 20;
const loading = new Map();
// fresh: se lee de nuevo aunque haya copia (el «Hoy» del account después de registrar algo, lib/ae-api.js)
export async function cached(k, fn, fresh = false, ttl = TTL) {
  const hit = fresh ? null : await cacheGet(k); if (hit) return hit;
  if (!loading.has(k)) loading.set(k, (async () => { const v = await fn(); await cacheSet(k, v, ttl); return v; })().finally(() => loading.delete(k)));
  return loading.get(k);
}
// los abiertos de venta (sin embudos de clientes ni etapas muertas) de un dueño o de toda la cuenta
export function openDeals(plan, { fresh = false } = {}) {
  return cached(`deals:open:${plan.ownerId || "all"}`, async () => {
    const out = []; let cursor = null, truncated = false;
    for (let i = 0; ; i++) {
      if (i === MAX_PAGES) { truncated = true; break; }
      const r = await pd.openDealsPage({ cursor, ownerId: plan.ownerId });
      out.push(...r.items.filter(d => DV.isSalesOpen(d)));
      if (!r.next) break; cursor = r.next;
    }
    return { at: new Date().toISOString(), truncated, deals: out };
  }, fresh);
}
// actividades (próxima y última) y nombres de organizaciones de esos tratos
export function details(deals, { fresh = false } = {}) {
  const acts = [...new Set(deals.flatMap(d => [d.next_activity_id, d.last_activity_id]).filter(Boolean).map(Number))].sort((a, b) => a - b);
  const orgs = [...new Set(deals.map(d => Number(d.org_id)).filter(Boolean))].sort((a, b) => a - b);
  const k = crypto.createHash("sha1").update(`${acts.join(",")}|${orgs.join(",")}`).digest("hex").slice(0, 20);
  return cached(`deals:x:${k}`, async () => {
    const [a, o] = await Promise.all([pd.activitiesByIds(acts), pd.orgsByIdsAll(orgs)]);
    return { acts: a, orgs: o.map(x => ({ id: x.id, name: x.name || "" })) };
  }, fresh);
}
// lo que necesita dealRow además del trato: nombres (el del perfil manda), organizaciones, actividades y colegios cruzados
export function rowCtx({ m, profiles, x, tz, now = Date.now() }) {
  const emailOf = new Map(m.users.map(u => [Number(u.id), lc(u.email)])), pdName = new Map((m.allUsers || m.users).map(u => [Number(u.id), u.name || ""]));
  const name = id => profiles[emailOf.get(Number(id))]?.name || pdName.get(Number(id)) || "";
  const schools = new Map([...orgToSchool()].filter(([, sid]) => byId.has(sid)).map(([oid, sid]) => { const sc = byId.get(sid); return [Number(oid), { id: sid, name: sc.name, city: sc.city || "" }]; }));
  return { stageList: m.stageList, pipes: m.pipes, name, orgs: new Map(x.orgs.map(o => [Number(o.id), o])), acts: new Map(x.acts.map(a => [Number(a.id), a])), schools, tz, now };
}

// Las filas (lib/dealsview.js dealRow) de unos tratos: nombres (el del perfil manda sobre el de Pipedrive, como en Equipo; también
// los que ya no están activos), organización, colegio cruzado y próxima y última actividad en la zona de quien mira.
function rowsOf(deals, x, { m, profiles, tz }) {
  const ctx = rowCtx({ m, profiles, x, tz });
  return { name: ctx.name, rows: deals.map(d => DV.dealRow(d, ctx)) };
}
// «Hoy» del líder (lib/lead-api.js): los tratos abiertos de venta de un equipo (filter: { ids, emails } de lib/teams.js filterOf:
// dueño o SDR de su gente) o de toda la cuenta (null), con las mismas lecturas y copias que la vista «Tratos abiertos».
export async function teamRows({ filter = null, m, profiles, tz }) {
  const raw = await openDeals({ all: true }), s = filter ? { kind: "team", filter } : { kind: "all" };
  const deals = raw.deals.filter(d => DV.inScope(d, s));
  return { at: raw.at, truncated: raw.truncated, rows: rowsOf(deals, await details(deals), { m, profiles, tz }).rows };
}

export function mountDeals(app, { auth, wrap, viewerFor, leadScopeFor }) {
  app.get("/api/deals/open", auth, wrap(async (req, res) => {
    const me = req.session.user, email = lc(me.email);
    const [v, m, profiles] = await Promise.all([viewerFor(email), pd.meta(), getProfiles()]);
    const lead = v.leader ? await leadScopeFor(email) : false;
    const s = DV.scopeOf({ v, T: v.T, lead, users: m.users, me, owner: String(req.query.owner ?? ""), team: String(req.query.team ?? "") });
    if (s.error) return res.status(s.error.status).json({ error: s.error.error });
    const raw = await openDeals(DV.readPlan(s, s.kind === "person" ? profiles[s.email]?.role || "" : ""));
    const deals = raw.deals.filter(d => DV.inScope(d, s));
    const x = await details(deals);
    const built = rowsOf(deals, x, { m, profiles, tz: req.tz }), name = built.name;
    const rows = DV.sortRows(built.rows, "stage");
    res.json({
      at: raw.at, tz: req.tz, truncated: raw.truncated,
      scope: { kind: s.kind, self: !!s.self, person: s.kind === "person" ? { id: s.id, name: name(s.id) } : null, team: s.kind === "team" ? { id: s.id, name: teamById(v.T, s.id)?.name || "" } : null, on: v.on },
      people: DV.peopleFor(lead, m.users, me.pdUserId).map(p => ({ ...p, name: name(p.id) || p.name })).sort((a, b) => a.name.localeCompare(b.name, "es")),
      deals: rows, pipes: DV.pipesView(rows, m.stageList, m.pipes), summary: DV.summarize(rows), staleDays: DV.STALE_DAYS, pdWeb: pd.PD_WEB,
    });
  }));
}
