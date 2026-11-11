// Equipos: los «tenants» dentro de OrderEAT (SDR México, SDR Cono Sur, Account Executives, Account Management…), todos en la
// misma cuenta de Pipedrive. Cada equipo: id, nombre, líderes y miembros (emails de usuarios del Pipedrive de la cuenta).
// Una persona es miembro de UN equipo o de ninguno; un líder lidera uno o más (y no es miembro de otro).
// Sin equipos creados, la app funciona como antes: un equipo implícito «OrderEAT» con todos (los líderes ven todo).
// Quién ve qué (viewerOf):
//  · dirección (FOUNDER_EMAILS o asignada) y los líderes fijos (dueño del token, LEADER_EMAILS) son «admin»: ven todos los
//    equipos (eligen uno o «Toda la cuenta»), los crean, renombran y borran, eligen sus líderes y cambian los accesos.
//    Dirección no está en ningún equipo (está arriba de todos); un líder fijo puede liderar uno, no ser miembro.
//  · líder de equipo: lo de líder (Métricas, Equipo, actuar sobre lo de otros) solo de los equipos que lidera. Suma o saca
//    miembros de su equipo (solo gente sin equipo) y les pasa su código. Sobre otro líder, dirección o un fijo no actúa
//    (aunque esté en su equipo): eso lo hace un admin.
//  · miembro: lo suyo; en Equipo, lo de su equipo (sin equipo: solo lo suyo). No cambia nada (403).
// Equipos desconocidos (T.unknown: Redis no respondió y esta instancia nunca los leyó bien): se cierra, no se abre. Un líder
// que no es admin queda sin lo de líder y un miembro ve solo lo suyo (nunca «sin equipos = todos ven todo»).
// Lógica pura: sin store ni Pipedrive (pruebas en test/teams.test.mjs). El guardado está en lib/store.js (getTeams/saveTeams).
import { accessOf } from "./access.js";

export const NAME_MAX = 40, MAX_TEAMS = 30, MAX_LEADERS = 6;
const lc = e => String(e || "").trim().toLowerCase();
const okEmail = e => /^[^@\s]+@[^@\s]+$/.test(e);
const uniq = l => [...new Set((Array.isArray(l) ? l : []).map(lc).filter(okEmail))];
const fold = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
const err = (status, error) => ({ error: { status, error } });
export const ID_RE = /^t[a-z0-9]{4,24}$/;
// nombre: una línea, sin < >, 40 como mucho
export const cleanName = n => String(n ?? "").replace(/[\x00-\x1f\x7f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, NAME_MAX).trim();

// Lo guardado, saneado: ids válidos y sin repetir, nombre, emails en minúscula sin repetir. Un líder no es miembro de ningún
// equipo; cada persona es miembro de uno solo (el primero en el orden guardado).
export function normTeams(raw) {
  const list = Array.isArray(raw?.teams) ? raw.teams : [], out = [], ids = new Set();
  const unknown = raw?.unknown === true ? { unknown: true } : {};
  for (const t of list) {
    const id = String(t?.id || ""), name = cleanName(t?.name);
    if (!ID_RE.test(id) || ids.has(id) || !name) continue;
    ids.add(id);
    out.push({ id, name, leaders: uniq(t.leaders).slice(0, MAX_LEADERS), members: uniq(t.members), at: t.at || null, by: String(t.by || "").slice(0, 80) });
  }
  const leaders = new Set(out.flatMap(t => t.leaders)), seen = new Set();
  for (const t of out) t.members = t.members.filter(e => !leaders.has(e) && !seen.has(e) && seen.add(e));
  return { teams: out, ...unknown };
}
export const hasTeams = T => !!T?.teams?.length;
export const teamById = (T, id) => (T?.teams || []).find(t => t.id === String(id)) || null;
export const peopleOf = t => t ? [...new Set([...t.leaders, ...t.members])] : [];
const byName = (a, b) => a.name.localeCompare(b.name, "es", { sensitivity: "base" }) || a.id.localeCompare(b.id);
export const sortedTeams = T => [...(T?.teams || [])].sort(byName);
// los equipos que lidera (en orden alfabético) y del que es miembro
export const ledBy = (T, email) => sortedTeams(T).filter(t => t.leaders.includes(lc(email))).map(t => t.id);
export const memberOf = (T, email) => (T?.teams || []).find(t => t.members.includes(lc(email)))?.id || null;
export const teamOfPerson = (T, email) => memberOf(T, email) || ledBy(T, email)[0] || null;

// Quién mira: su acceso (con equipos: líder = líder de un equipo), si es admin, si ve todo (all) y sus equipos.
// all: ve todos los equipos (admin, o cualquier líder si no hay equipos: como antes).
// unknown (no se pudieron leer los equipos): como con equipos pero sin saber quién lidera qué; solo un admin sigue de líder.
export function viewerOf({ email, fixed = null, assigned = null, T }) {
  email = lc(email);
  const unknown = !!T?.unknown, on = hasTeams(T) || unknown, led = on && !unknown ? ledBy(T, email) : [], member = on && !unknown ? memberOf(T, email) : null;
  const acc = accessOf({ fixed, assigned, leads: led.length > 0, teams: on });
  if (unknown) delete acc.stale;
  return { email, acc, on, ...(unknown ? { unknown: true } : {}), leader: acc.leader, admin: acc.admin, all: acc.leader && (acc.admin || !on), led, member };
}
export const TEAMS_DOWN = { status: 503, error: "No pude leer los equipos. Probá de nuevo en unos segundos." };
// a quien era líder antes de los equipos (stale) y quedó sin equipo
export const STALE_MSG = "Ahora hay equipos: pedile a dirección que te asigne el tuyo. Mientras, ves lo tuyo (sin Métricas).";
// Los equipos que puede mirar como líder (selector de Métricas y Equipo)
export const viewableTeams = (v, T) => !v?.leader ? [] : v.all ? sortedTeams(T) : sortedTeams(T).filter(t => v.led.includes(t.id));

// ?team= en Métricas y Equipo. "" = el de siempre (dirección: toda la cuenta; un líder: su primer equipo); "all" = toda la cuenta (solo quien ve
// todo). Devuelve { id } (null = toda la cuenta) o { error: { status, error } }. Sin equipos, siempre toda la cuenta (como antes).
export function pickTeam(v, T, want = "") {
  want = String(want ?? "");
  if (!v?.leader) return v?.unknown ? { error: TEAMS_DOWN } : err(403, v?.acc?.stale ? STALE_MSG : "Esto solo lo ven los líderes y dirección.");
  if (T?.unknown && !v.admin) return { error: TEAMS_DOWN };
  if (!hasTeams(T)) return { id: null };
  if (v.all) { if (!want || want === "all") return { id: null }; return teamById(T, want) ? { id: want } : err(404, "Ese equipo ya no existe."); }
  if (!v.led.length) return err(403, "Todavía no liderás ningún equipo. Pedile a dirección que te asigne uno.");
  if (!want) return { id: v.led[0] };
  if (want === "all") return err(403, "Ves solo los equipos que liderás.");
  if (v.led.includes(want)) return { id: want };
  return teamById(T, want) ? err(403, "Ese equipo no es tuyo: lo ve su líder o dirección.") : err(404, "Ese equipo ya no existe.");
}
// Filtro de datos de uno o más equipos: emails e ids de Pipedrive de su gente (líderes y miembros). users: los de Pipedrive.
export function filterOf(T, teamIds, users = []) {
  const emails = new Set(teamIds.flatMap(id => peopleOf(teamById(T, id))));
  const byEmail = new Map(users.map(u => [lc(u.email), Number(u.id)]));
  return { emails, ids: new Set([...emails].map(e => byEmail.get(e)).filter(Boolean)) };
}
// ¿Esta persona (id de Pipedrive o email) está en el filtro? Sin filtro (null), todos.
export const inFilter = (f, { id = null, email = "" } = {}) => !f || (id != null && f.ids?.has(Number(id))) || (!!email && f.emails?.has(lc(email)));
// Sobre lo de quién actúa como líder (marcar la demo de otro, archivar o fusionar lo ajeno, convertir su prospecto…):
// true = de todos (dirección, fijos, o sin equipos); false = de nadie (solo lo suyo); { ids, emails } = la gente de sus equipos
// sin acceso de líder: ni los otros líderes de su equipo ni alguien de dirección o fijo que haya quedado de miembro (eso, un
// admin). isLead(email): esa persona tiene acceso de líder, dirección o fijo (el servidor lo sabe con los accesos guardados).
export function leadScope(v, T, users = [], { isLead = () => false } = {}) {
  if (!v?.leader) return false; if (v.all) return true;
  const f = filterOf(T, v.led, users), lead = new Set(v.led.flatMap(id => teamById(T, id)?.leaders || []));
  const emails = new Set([...f.emails].filter(e => e === v.email || (!lead.has(e) && !isLead(e))));
  const byEmail = new Map(users.map(u => [lc(u.email), Number(u.id)]));
  return { emails, ids: new Set([...emails].map(e => byEmail.get(e)).filter(Boolean)) };
}
// canLead(scope, dueño): true si scope es true (aunque no se sepa el dueño) o si el dueño está en sus equipos
export const canLead = (scope, who = {}) => scope === true || (!!scope && typeof scope === "object" && ((who.id != null && !!scope.ids?.has(Number(who.id))) || (!!who.email && !!scope.emails?.has(lc(who.email)))));
// ¿Le llega el código personal de esa persona (o: su viewerOf)? Un admin, el de todos; los demás, el suyo y el de la gente sin
// acceso de líder, de dirección ni fijo (aunque sea colíder o haya quedado en su equipo): con ese código entraría como ella.
export const showsCode = (v, o) => !!v?.admin || (!!o && (o.email === v?.email || (!o.acc?.leader && !o.acc?.fixed)));
// para el navegador (sin Sets): "all", o { ids, emails }; un miembro, null
export const scopeOut = s => s === true ? "all" : s && typeof s === "object" ? { ids: [...s.ids], emails: [...s.emails] } : null;

// Equipo (Demos de la semana, Falta marcar, actividad reciente): un líder, el equipo elegido (pickTeam); un miembro, su
// equipo; sin equipo, solo lo suyo. Sin equipos creados: todos (filter null), como antes.
export function viewFilter(v, T, users = [], want = "") {
  if (T?.unknown && !v?.admin) return selfFilter(v, users, { unknown: true });
  if (!hasTeams(T)) return { id: null, filter: null };
  if (v.leader) { const p = pickTeam(v, T, want); return p.error ? p : { id: p.id, filter: p.id ? filterOf(T, [p.id], users) : null }; }
  if (v.member) return { id: v.member, filter: filterOf(T, [v.member], users) };
  return selfFilter(v, users);
}
function selfFilter(v, users, extra = {}) {
  const me = users.find(u => lc(u.email) === v.email);
  return { id: null, self: true, ...extra, filter: { emails: new Set([v.email]), ids: new Set(me ? [Number(me.id)] : []) } };
}

// Cómo se muestra: «Dirección · CEO», «Líder · SDR México», «SDR · SDR México» (rol del perfil y su equipo).
const andY = l => l.length > 1 ? `${l.slice(0, -1).join(", ")} y ${l.at(-1)}` : l[0] || "";
export function roleLabel({ acc, T, email, base = "" }) {
  if (acc?.level === "direccion") return acc.title ? `Dirección · ${acc.title}` : "Dirección";
  if (acc?.leader) { const n = ledBy(T, email).map(id => teamById(T, id).name); return n.length > 2 ? `Líder · ${n.length} equipos` : n.length ? `Líder · ${andY(n)}` : "Líder"; }
  if (acc?.stale && !memberOf(T, email)) return "Líder · sin equipo"; // era líder antes de los equipos: todavía no le asignaron el suyo
  const t = teamById(T, memberOf(T, email));
  return [base, t?.name].filter(Boolean).join(" · ");
}

// ---------- cambios (devuelven { T } con lo nuevo o { error: { status, error } }). Quién puede: adminError / memberChange.
export const adminError = v => v?.admin ? null : { status: 403, error: v?.leader ? "Los equipos los arma dirección. Vos sumás o sacás gente de tu equipo." : "Solo dirección arma los equipos." };
const clone = T => normTeams({ teams: (T?.teams || []).map(t => ({ ...t, leaders: [...t.leaders], members: [...t.members] })) });
const nameTaken = (T, name, except = null) => (T?.teams || []).some(t => t.id !== except && fold(t.name) === fold(name));
// saca a esa persona de todo (miembro y líder): para moverla
const detach = (T, email) => { for (const t of T.teams) { t.members = t.members.filter(e => e !== email); t.leaders = t.leaders.filter(e => e !== email); } };
export function createTeam(T, { id, name, by = "", at = null }) {
  const n = cleanName(name);
  if (n.length < 2) return err(400, "Poné el nombre del equipo.");
  if (!ID_RE.test(String(id || ""))) return err(500, "No pude crear el equipo.");
  if ((T?.teams || []).length >= MAX_TEAMS) return err(409, `Son demasiados equipos: ${MAX_TEAMS} como mucho.`);
  if (nameTaken(T, n)) return err(409, `Ya hay un equipo «${n}».`);
  const N = clone(T); N.teams.push({ id, name: n, leaders: [], members: [], at, by: String(by || "").slice(0, 80) });
  return { T: N, team: teamById(N, id) };
}
export function renameTeam(T, id, name) {
  const n = cleanName(name), t = teamById(T, id);
  if (!t) return err(404, "Ese equipo ya no existe.");
  if (n.length < 2) return err(400, "Poné el nombre del equipo.");
  if (nameTaken(T, n, t.id)) return err(409, `Ya hay un equipo «${n}».`);
  const N = clone(T); teamById(N, id).name = n;
  return { T: N };
}
// Borrar: su gente queda sin equipo (los líderes que no lideran otro, pasan a miembros sin equipo)
export function deleteTeam(T, id) {
  if (!teamById(T, id)) return err(404, "Ese equipo ya no existe.");
  const N = clone(T); N.teams = N.teams.filter(t => t.id !== String(id));
  return { T: N };
}
// Líderes de un equipo (exactamente estos): cada uno deja de ser miembro de cualquier equipo. known(email): es usuario de Pipedrive.
// isDir(email): es de dirección (está arriba de todos los equipos: no lidera ni es miembro de uno).
const DIR_MSG = "es de dirección: ya ve todos los equipos y no se suma a uno.";
export function setLeaders(T, id, emails, { known = () => true, isDir = () => false } = {}) {
  if (!teamById(T, id)) return err(404, "Ese equipo ya no existe.");
  const l = uniq(emails);
  if (l.length > MAX_LEADERS) return err(400, `Son muchos líderes: ${MAX_LEADERS} como mucho.`);
  const bad = l.find(e => !known(e)); if (bad) return err(404, `${bad} no es usuario del Pipedrive de OrderEAT.`);
  const dir = l.find(e => isDir(e)); if (dir) return err(409, `${dir} ${DIR_MSG}`);
  const N = clone(T);
  for (const e of l) for (const t of N.teams) t.members = t.members.filter(x => x !== e);
  teamById(N, id).leaders = l;
  return { T: N };
}
// Miembro de un equipo (o de ninguno: teamId null) desde Accesos (solo admin): deja cualquier otro equipo y de liderar.
// Con null también sirve para sacar a alguien de todos los equipos (al pasar a dirección).
export function placeMember(T, email, teamId, { isDir = () => false } = {}) {
  email = lc(email);
  if (teamId && !teamById(T, teamId)) return err(404, "Ese equipo ya no existe.");
  if (teamId && isDir(email)) return err(409, `${email} ${DIR_MSG}`);
  const N = clone(T); detach(N, email);
  if (teamId) teamById(N, teamId).members.push(email);
  return { T: normTeams(N) };
}
// Líder de UN equipo desde Accesos (solo admin): deja de ser miembro y de liderar otros.
export function placeLeader(T, email, teamId, { isDir = () => false } = {}) {
  email = lc(email); const t = teamById(T, teamId);
  if (!t) return err(404, "Ese equipo ya no existe.");
  if (isDir(email)) return err(409, `${email} ${DIR_MSG}`);
  if (!t.leaders.includes(email) && t.leaders.length >= MAX_LEADERS) return err(409, `«${t.name}» ya tiene ${MAX_LEADERS} líderes.`);
  const N = clone(T); detach(N, email); teamById(N, teamId).leaders.push(email);
  return { T: normTeams(N) };
}
// Sumar o sacar un miembro (líder del equipo o admin). target: el acceso de esa persona (accessOf). known: es usuario de Pipedrive.
// Un líder de equipo solo suma gente sin equipo y sin acceso de líder, y solo saca a quien no tiene acceso de líder; mover de
// un equipo a otro lo hace dirección. Dirección no es miembro de ningún equipo y un líder fijo tampoco (puede liderar uno).
// Nadie se saca a sí mismo (un líder no se va de su equipo desde acá).
export function memberChange(v, T, { teamId, email, add, known = true, target = null }) {
  email = lc(email);
  if (!v?.leader) return err(403, "Solo el líder del equipo o dirección cambia quién está en el equipo.");
  const t = teamById(T, teamId);
  if (!t) return err(404, "Ese equipo ya no existe.");
  if (!v.all && !v.led.includes(t.id)) return err(403, "Ese equipo no es tuyo: lo cambia su líder o dirección.");
  if (!okEmail(email)) return err(400, "Elegí a la persona.");
  if (email === v.email) return err(409, add ? "Ya estás en tu equipo." : "No podés sacarte de tu equipo. Si hace falta, que lo haga dirección.");
  if (add) {
    if (!known) return err(404, "Esa persona no es usuaria del Pipedrive de OrderEAT.");
    if (t.members.includes(email)) return err(409, "Ya está en el equipo.");
    if (t.leaders.includes(email)) return err(409, "Ya es líder de este equipo.");
    const other = (T.teams || []).find(x => x.id !== t.id && (x.members.includes(email) || x.leaders.includes(email)));
    if (other && !v.admin) return err(409, `Está en ${other.name}: que lo saque su líder o dirección.`);
    if (target?.level === "direccion") return err(409, "Es de dirección: ya ve todos los equipos y no se suma a uno.");
    if (target?.fixed) return err(409, "Es líder fijo (lo definió el administrador): puede liderar un equipo, no ser miembro.");
    if (target?.leader && !v.admin) return err(409, "Tiene acceso de líder o dirección: lo suma dirección.");
    const N = clone(T); detach(N, email); teamById(N, t.id).members.push(email);
    return { T: normTeams(N) };
  }
  if (t.leaders.includes(email)) return err(409, "Es líder del equipo: lo cambia dirección.");
  if (!t.members.includes(email)) return err(404, "No está en este equipo.");
  if (target?.leader && !v.admin) return err(409, "Tiene acceso de líder o dirección: lo saca dirección.");
  const N = clone(T); teamById(N, t.id).members = teamById(N, t.id).members.filter(e => e !== email);
  return { T: N };
}
// Después de cambiar los equipos: a quién hay que cambiarle el acceso guardado para que coincida con lo que lidera.
// Pasó a liderar → «lider» (si lo guardado era menos); dejó de liderar todo → «equipo» (si lo guardado era «lider»); quedó de
// miembro sin liderar nada y lo guardado era «lider» (un líder de antes de los equipos al que lo suman a uno) → «equipo».
// Así, si se borran todos los equipos, nadie queda de líder por haberlo sido de un equipo. map: lo guardado por email.
export function accessSync(before, after, map = {}) {
  const leads = T => new Set((T?.teams || []).flatMap(t => t.leaders));
  const a = leads(before), b = leads(after), out = [], seen = new Set();
  const push = (email, level) => { if (!seen.has(email)) { seen.add(email); out.push({ email, level }); } };
  for (const e of b) if (!a.has(e) && !["lider", "direccion"].includes(map[e]?.level)) push(e, "lider");
  for (const e of a) if (!b.has(e) && map[e]?.level === "lider") push(e, "equipo");
  for (const e of (after?.teams || []).flatMap(t => t.members)) if (!b.has(e) && map[e]?.level === "lider") push(e, "equipo");
  return out;
}
// Lo que ve cada uno de los equipos (GET /api/teams): admin, todos; un líder, los suyos; un miembro, el suyo (sin cambiar nada).
// person(email) → { email, name, id } para mostrar.
export function teamsView(v, T, person = e => ({ email: e })) {
  const vis = !v ? [] : v.admin || (v.all && !hasTeams(T)) ? sortedTeams(T) : sortedTeams(T).filter(t => v.led.includes(t.id) || t.id === v.member);
  return vis.map(t => ({ id: t.id, name: t.name, leaders: t.leaders.map(person), members: t.members.map(person),
    mine: v.led.includes(t.id) || v.member === t.id, canEdit: !!v.admin, canMembers: !!v.admin || v.led.includes(t.id) }));
}
