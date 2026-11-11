// Accesos del equipo: quién ve lo de líder (Métricas, Accesos del equipo, sincronizar, World Dominion, lo de otros…).
// Niveles: «equipo» (SDR o Account Executive, lo elige cada uno en su perfil), «lider» y «direccion» (founders: CEO,
// CTO, COO…; ve exactamente lo mismo que un líder, cambia solo cómo se muestra: «Dirección · CEO»).
// Fijo (definido por el administrador, no se saca desde la app): el dueño del token de Pipedrive y LEADER_EMAILS son
// líderes; FOUNDER_EMAILS, dirección. Lo demás lo asigna un líder (o alguien de dirección) en Equipo › Accesos del equipo
// y se guarda en lib/store.js (getAccessMap/setAccess). Lógica pura: sin store ni Pipedrive (pruebas en test/access.test.mjs).
export const LEVELS = { equipo: "Equipo", lider: "Líder", direccion: "Dirección" };
const RANK = { equipo: 0, lider: 1, direccion: 2 };
export const TITLE_MAX = 24;
const lc = e => String(e || "").trim().toLowerCase();
export const isLevel = l => typeof l === "string" && Object.hasOwn(LEVELS, l);
export const leaderLevel = l => isLevel(l) && RANK[l] >= RANK.lider;
// LEADER_EMAILS / FOUNDER_EMAILS: separados por coma (o espacio, o punto y coma), sin distinguir mayúsculas
export const parseEmails = s => [...new Set(String(s || "").split(/[,;\s]+/).map(lc).filter(e => /^[^@\s]+@[^@\s]+$/.test(e)))];
// Lo que viene del servidor: dirección (FOUNDER_EMAILS) gana sobre líder (dueño del token, LEADER_EMAILS).
export function fixedLevel(email, { owner = "", leaders = [], founders = [] } = {}) {
  email = lc(email); if (!email) return null;
  if (founders.includes(email)) return "direccion";
  if (leaders.includes(email) || (owner && lc(owner) === email)) return "lider";
  return null;
}
// cargo: texto corto en una línea («CEO», «CTO», «Cofundadora»)
export const cleanTitle = t => String(t ?? "").replace(/[\x00-\x1f\x7f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, TITLE_MAX).trim();
// El acceso que vale: el mayor entre lo fijo y lo asignado (lo fijo es un piso: se puede subir de líder a dirección, no
// bajar). El cargo solo acompaña a dirección. by/at: quién lo cambió en la app y cuándo (si alguien lo cambió).
export function accessOf({ fixed = null, assigned = null } = {}) {
  const a = isLevel(assigned?.level) ? assigned.level : "equipo", f = isLevel(fixed) && fixed !== "equipo" ? fixed : null;
  const level = f && RANK[f] >= RANK[a] ? f : a;
  return { level, leader: leaderLevel(level), fixed: f, title: level === "direccion" ? cleanTitle(assigned?.title) : "",
    by: assigned ? String(assigned.byName || assigned.by || "") : "", at: assigned?.at || null };
}
export const accessLabel = a => !a ? "" : a.level === "direccion" ? (a.title ? `Dirección · ${a.title}` : "Dirección") : a.level === "lider" ? "Líder" : "";
// ¿Puede `actor` dejarle a `target` el nivel `level`? null si puede; si no, { status, error }. Reglas:
//  - solo un líder o alguien de dirección cambia accesos (un SDR, nada: ni a otro ni a sí mismo);
//  - solo a usuarios del Pipedrive de la cuenta (known);
//  - lo fijo no se baja desde la app (sí se puede subir: un líder fijo puede pasar a dirección);
//  - nadie se saca a sí mismo el acceso (así nunca se queda el equipo sin líderes por error).
export function changeError({ actorEmail, actor, targetEmail, target, level, known }) {
  if (!actor?.leader) return { status: 403, error: "Solo un líder o alguien de dirección cambia los accesos del equipo." };
  if (!isLevel(level)) return { status: 400, error: "Elegí Equipo, Líder o Dirección." };
  if (lc(actorEmail) === lc(targetEmail) && !leaderLevel(level)) return { status: 409, error: "No podés sacarte tu propio acceso. Si hace falta, que lo haga otro líder." };
  if (!known) return { status: 404, error: "Esa persona no es usuaria del Pipedrive de OrderEAT." };
  if (target?.fixed && RANK[level] < RANK[target.fixed]) return { status: 409, error: `${target.fixed === "direccion" ? "Su acceso de dirección" : "Su acceso de líder"} lo definió el administrador: no se saca desde la app.` };
  return null;
}
// Lo que se guarda: el nivel, el cargo (solo con dirección), quién lo cambió y cuándo.
export const accessRecord = ({ level, title, by, byName, at }) => ({ level, title: level === "direccion" ? cleanTitle(title) : "", by: lc(by), byName: String(byName || "").slice(0, 80), at });
// Para la lista de Accesos del equipo: qué se puede elegir para esa persona (lo de abajo de lo fijo y, para uno mismo,
// «Equipo», van deshabilitados) y por qué.
export function accessChoices({ actorEmail, targetEmail, target }) {
  const self = lc(actorEmail) === lc(targetEmail);
  return Object.keys(LEVELS).map(k => {
    const below = target?.fixed && RANK[k] < RANK[target.fixed];
    const why = below ? "definido por el administrador" : self && !leaderLevel(k) ? "no podés sacarte tu propio acceso" : "";
    return { level: k, label: LEVELS[k], disabled: !!why, why };
  });
}
