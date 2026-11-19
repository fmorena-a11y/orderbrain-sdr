// Cruce colegio ↔ organización de Pipedrive (checkSchool): las mismas reglas que la sincronización masiva.
import * as pd from "../pipedrive.js";
import { MATCH_VERSION, byId, getMatch, isFresh, schools, setMatch, touchesFor } from "../store.js";
import { bad } from "../text.js";
import { leadCheck, leadView, needsLeadCheck, setLeadMatch, viewed } from "./settle.js";

// ---------- cruce con Pipedrive (7 días de validez)
export async function checkSchool(id, { force = false, org = null } = {}) {
  const s = byId.get(id);
  if (!s) throw bad("Colegio inexistente", 404);
  if (s.leadOnly && s.virtual) return getMatch(id) || setMatch(id, { status: "lead", detail: "Prospecto en Pipedrive", orgId: null, confirmed: true, leadId: s.leadId, candidates: [] });
  const cur = getMatch(id);
  // al día, salvo un «Nunca contactado» al que todavía no se le buscaron prospectos (lo dejó así la sincronización masiva,
  // que solo mira organizaciones): ahí se buscan, para que «Nunca contactado» quiera decir que no hay nada en Pipedrive
  // un «Nunca contactado» cruzado con reglas viejas (antes de «Hnos.» = hermanos, v6) se vuelve a cruzar entero
  const redoNew = !!cur && cur.status === "new" && !cur.orgId && (cur.v || 0) < MATCH_VERSION;
  if (!force && !org && isFresh(cur) && !redoNew && !needsLeadCheck(cur)) return leadView(s), cur;
  // la ficha y su Historial se piden juntos: el mismo cruce una sola vez
  if (!force && !org) {
    if (checking.has(id)) return checking.get(id);
    const p = (isFresh(cur) && !redoNew ? leadCheck(id, s, cur) : matchSchool(id, s, cur, {})).finally(() => checking.delete(id));
    checking.set(id, p); return p;
  }
  return matchSchool(id, s, cur, { org });
}
const checking = new Map();
async function matchSchool(id, s, cur, { org = null }) {
  // un prospecto sin organización (el cruce dice «Prospecto en Pipe»): si sigue abierto y alguien lo eligió («Es este»), se
  // mantiene; si ahora tiene organización, el colegio pasa a esa (con el prospecto). Elegido solo (auto): se recalcula.
  let keepLead = null;
  if (!org && cur?.status === "lead" && cur.leadId && !s.virtual) {
    let l;
    try { l = await pd.getLead(cur.leadId); } catch { return leadView(s), cur; } // sin saber, queda como estaba
    if (l && !l.archived) {
      if (l.orgId) { org = { id: l.orgId, name: cur.orgName || (await pd.orgsByIds([l.orgId]).catch(() => []))[0]?.name || l.title, ownerId: null }; keepLead = l; }
      else if (cur.confirmed && !cur.auto) return setLeadMatch(id, l, { cur, confirmed: true });
    }
  }
  let chosen = null, candidates = [], auto = false;
  const keep = pd.keepsOrg(cur, s, touchesFor(id).length > 0); // elegido a mano: se mantiene su organización
  if (org) chosen = { ...org, score: 1 };
  else if (keep) chosen = { id: cur.orgId, name: cur.orgName, score: 1 };
  else {
    const ctx = pd.matchCtx(schools);
    candidates = await pd.findOrgCandidates(s, ctx); chosen = pd.pickOrg(candidates);
    auto = !!chosen && pd.isSure(candidates, ctx.key(s));
  }
  if (!chosen) return leadCheck(id, s, { ...pd.noMatchRecord(candidates), ...(cur?.pdx ? { pdx: cur.pdx } : {}) });
  const [deals, m] = await Promise.all([pd.dealsForOrg(chosen.id), pd.meta()]);
  // dueño de la organización en Pipedrive: si es de otra persona, nadie más la prospecta
  let ownerId = chosen.ownerId ?? null;
  if (ownerId === null) ownerId = (await pd.orgsByIds([chosen.id]))[0]?.ownerId || null; // si falla, no se guarda un cruce «sin dueño»
  // las mismas reglas que la sincronización masiva (lib/sync.js): pd.matchRecord es puro
  const rec = pd.matchRecord({ chosen, deals, m, ownerId, confirmed: !!(org || keep), auto, candidates, cur });
  if (keepLead) rec.leadId = keepLead.id;
  return viewed(s, setMatch(id, rec));
}
