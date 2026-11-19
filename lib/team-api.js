// Equipo: accesos del equipo (códigos y niveles), la lista de Equipo, los equipos (crear, renombrar, borrar, líderes y
// miembros) y la tarjeta «Demos» (lib/access.js, lib/teams.js). server.js la monta con mountTeam(app, deps).
import crypto from "crypto";
import * as pd from "./pipedrive.js";
import { getAccessMap, getProfiles, saveTeams, setAccess, withLock } from "./store.js";
import * as ACC from "./access.js";
import * as TM from "./teams.js";
import * as sales from "./sales.js";
import { lc } from "./text.js";

export function mountTeam(app, { FOUNDERS, LEADERS, accessView, auth, fixedOf, httpErr, labelOf, mxTeam, otherViewer, personalCode, signName, teamUsers, viewerFor, wrap }) {
  // Accesos del equipo (líderes y dirección): el código personal de cada persona, para pasárselo, su acceso (Miembro · Líder ·
  // Dirección con cargo) y su equipo. Dirección y los fijos ven a todos y cambian accesos y equipos; un líder de equipo ve a su
  // gente (con código) y a la gente sin equipo (free, sin código: para sumarla). Lo fijo (dueño del token, LEADER_EMAILS,
  // FOUNDER_EMAILS) se muestra sin poder bajarlo. A quien no es admin nunca le llega el código de alguien con acceso de líder,
  // de dirección o fijo (aunque sea colíder o haya quedado en su equipo): con ese código entraría como esa persona.
  async function accessRows(v) {
    const [m, prs] = await Promise.all([pd.meta(), getProfiles()]), T = v.T;
    const rowOf = u => {
      const e = lc(u.email), o = otherViewer(v, e), hide = !TM.showsCode(v, o);
      return { id: u.id, name: prs[e]?.name || u.name, email: e, code: hide ? null : personalCode(e), role: labelOf(o.acc, T, e, prs[e]), me: e === v.email,
        access: accessView(o.acc), team: { member: o.member, led: o.led }, choices: v.admin ? ACC.accessChoices({ actorEmail: v.email, targetEmail: e, target: o.acc }) : null };
    };
    const users = teamUsers(m);
    // a dirección también le aparecen los fijos que no son usuarios de Pipedrive (los dueños de FOUNDERS_DEFAULT): así ve su
    // código personal y les pasa la invitación
    if (v.admin) {
      const known = new Set(users.map(u => lc(u.email)));
      const extra = [...FOUNDERS, ...LEADERS].filter(e => !known.has(e)).map(e => ({ ...rowOf({ id: `x-${e}`, name: prs[e]?.name || e, email: e }), choices: null }));
      return { users: [...users.map(rowOf), ...extra], free: [] };
    }
    if (!v.on) return { users: users.map(rowOf), free: [] };
    const mine = new Set(v.led.flatMap(id => TM.peopleOf(TM.teamById(T, id))));
    const free = users.filter(u => !mine.has(lc(u.email)) && !TM.teamOfPerson(T, u.email)).map(rowOf).filter(r => !r.access.fixed && r.access.level === "equipo")
      .map(({ id, name, email, role }) => ({ id, name, email, role }));
    return { users: users.filter(u => mine.has(lc(u.email))).map(rowOf), free };
  }
  const teamList = T => TM.sortedTeams(T).map(t => ({ id: t.id, name: t.name }));
  app.get("/api/team/codes", auth, wrap(async (req, res) => {
    const v = await viewerFor(req.session.user.email);
    if (!v.leader) return res.status(403).json({ error: "Solo un líder o alguien de dirección ve los accesos del equipo." });
    res.json({ url: `${req.protocol}://${req.get("host")}`, on: v.on, admin: v.admin, teams: v.admin ? teamList(v.T) : teamList(v.T).filter(t => v.led.includes(t.id)), ...(await accessRows(v)) });
  }));
  // Cambios de equipos y accesos: de a uno entre instancias (withLock), releyendo todo adentro. No escriben en Pipedrive.
  const TEAMS_BUSY = { busy: "Otra persona está cambiando los equipos. Probá de nuevo en unos segundos." };
  const byNameOf = async user => (await signName(user)) || user.name || user.email;
  // Cambiar el acceso de una persona (solo dirección o un líder fijo): { email, level: equipo|lider|direccion, title, team }.
  // team (con equipos): miembro → de ese equipo ("" ninguno) y deja de liderar; líder → lidera ese equipo (obligatorio si no
  // lidera ninguno); dirección → sale de todos los equipos (está arriba de todos). Sin team, el equipo no cambia. Reglas:
  // lib/access.js changeError.
  app.post("/api/team/access", auth, wrap(async (req, res) => {
    const me = lc(req.session.user.email), pre = await viewerFor(me, { fresh: true });
    if (!pre.admin) return res.status(403).json({ error: pre.leader ? "Los accesos los cambia dirección. Vos sumás o sacás gente de tu equipo." : "Solo dirección cambia los accesos del equipo." });
    const email = lc(req.body?.email), level = String(req.body?.level || ""), team = req.body?.team == null ? undefined : String(req.body.team);
    const known = teamUsers(await pd.meta()).some(u => lc(u.email) === email), byName = await byNameOf(req.session.user);
    await withLock("teams", async () => {
      const v = await viewerFor(me, { fresh: true }), T = v.T, t = otherViewer(v, email);
      if (team && !TM.teamById(T, team)) throw httpErr({ status: 404, error: "Ese equipo ya no existe." });
      const err = ACC.changeError({ actorEmail: me, actor: v.acc, targetEmail: email, target: t.acc, level, known, teams: v.on, team, leads: t.led.length });
      if (err) throw httpErr(err);
      let N = null;
      if (v.on && level === "equipo" && (team !== undefined || t.led.length)) N = TM.placeMember(T, email, team !== undefined ? team || null : t.member);
      else if (v.on && level === "lider" && team) N = TM.placeLeader(T, email, team, { isDir: e => fixedOf(e, v.owner) === "direccion" });
      else if (v.on && level === "lider" && team === "") N = TM.placeMember(T, email, null); // un líder fijo sin equipo
      else if (v.on && level === "direccion" && (t.member || t.led.length)) N = TM.placeMember(T, email, null);
      if (N?.error) throw httpErr(N.error);
      await setAccess(email, ACC.accessRecord({ level, title: req.body?.title, by: me, byName, at: new Date().toISOString() }));
      if (N) await saveTeams(TM.normTeams(N.T));
    }, TEAMS_BUSY);
    const v = await viewerFor(me), r = await accessRows(v);
    res.json({ user: r.users.find(u => u.email === email), users: r.users, teams: teamList(v.T) });
  }));
  app.get("/api/team", auth, wrap(async (req, res) => {
    const [m, prs, v] = await Promise.all([pd.meta(), getProfiles(), viewerFor(req.session.user.email)]);
    res.json(m.users.map(u => { const e = lc(u.email), pr = prs[e]; return { id: u.id, name: pr?.name || u.name, role: labelOf(otherViewer(v, e).acc, v.T, e, pr), team: TM.teamOfPerson(v.T, e) }; }));
  }));
  // ---------- Equipos (lib/teams.js): dirección (y los fijos) los crean, renombran y borran y eligen sus líderes; el líder de
  // un equipo suma o saca miembros (gente sin equipo). Cada uno ve los suyos (dirección, todos). Después de cada cambio, el
  // acceso guardado de quien empezó o dejó de liderar queda igual a lo que lidera (accessSync).
  async function teamsOut(v, T = v.T) {
    const [m, prs] = await Promise.all([pd.meta(), getProfiles()]), users = new Map(m.users.map(u => [lc(u.email), u]));
    const person = e => ({ email: e, name: prs[e]?.name || users.get(e)?.name || e, id: users.get(e)?.id || null });
    const w = { ...v, ...otherViewer(v, v.email, T) };
    const all = teamUsers(m).map(u => lc(u.email)).map(e => ({ e, o: otherViewer(v, e, T) }));
    // dirección no se suma a ningún equipo: no se ofrece
    const cands = all.filter(x => x.e !== w.email && x.o.acc.level !== "direccion").map(({ e, o }) => ({ ...person(e), team: TM.teamOfPerson(T, e), member: o.member, led: o.led, leads: o.led.length > 0, level: o.acc.level, fixed: !!o.acc.fixed }));
    return { on: TM.hasTeams(T), admin: w.admin, teams: TM.teamsView(w, T, person),
      // para elegir: dirección, toda la gente (con su equipo); un líder de equipo, la gente sin equipo y sin acceso de líder
      people: w.admin ? cands : w.led.length ? cands.filter(c => !c.team && c.level === "equipo" && !c.fixed) : [],
      // a dirección: quienes eran líderes antes de los equipos y todavía no lideran uno (sin equipo no ven Métricas)
      stale: w.admin && TM.hasTeams(T) ? all.filter(x => x.o.acc.stale).map(x => person(x.e)) : [] };
  }
  app.get("/api/teams", auth, wrap(async (req, res) => res.json(await teamsOut(await viewerFor(req.session.user.email)))));
  async function changeTeams(req, fn) {
    const me = lc(req.session.user.email), byName = await byNameOf(req.session.user);
    const { v, T } = await withLock("teams", async () => {
      const v = await viewerFor(me, { fresh: true }), r = await fn(v, v.T);
      if (r.error) throw httpErr(r.error);
      const N = TM.normTeams(r.T), at = new Date().toISOString();
      for (const x of TM.accessSync(v.T, N, v.map)) await setAccess(x.email, ACC.accessRecord({ level: x.level, by: me, byName, at }));
      await saveTeams(N);
      return { v, T: N };
    }, TEAMS_BUSY);
    return teamsOut({ ...v, map: await getAccessMap() }, T);
  }
  const tid = () => "t" + crypto.randomBytes(6).toString("hex");
  app.post("/api/teams", auth, wrap(async (req, res) => {
    const v0 = await viewerFor(req.session.user.email); const e = TM.adminError(v0); if (e) return res.status(e.status).json({ error: e.error });
    const by = await byNameOf(req.session.user);
    res.json(await changeTeams(req, (v, T) => TM.adminError(v) ? { error: TM.adminError(v) } : TM.createTeam(T, { id: tid(), name: req.body?.name, by, at: new Date().toISOString() })));
  }));
  // { name } renombra; { leaders: [emails] } deja esos líderes (los de otros equipos siguen liderando aquellos; si eran miembros, dejan su equipo)
  app.patch("/api/teams/:tid", auth, wrap(async (req, res) => {
    const v0 = await viewerFor(req.session.user.email); const e = TM.adminError(v0); if (e) return res.status(e.status).json({ error: e.error });
    const b = req.body || {}, known = new Set(teamUsers(await pd.meta()).map(u => lc(u.email)));
    if (b.name === undefined && !Array.isArray(b.leaders)) return res.status(400).json({ error: "No hay nada para cambiar." });
    res.json(await changeTeams(req, (v, T) => {
      if (TM.adminError(v)) return { error: TM.adminError(v) };
      let r = { T };
      if (b.name !== undefined) r = TM.renameTeam(r.T, req.params.tid, b.name);
      if (!r.error && Array.isArray(b.leaders)) r = TM.setLeaders(r.T, req.params.tid, b.leaders.slice(0, 20), { known: x => known.has(x), isDir: x => otherViewer(v, x, T).acc.level === "direccion" });
      return r;
    }));
  }));
  app.delete("/api/teams/:tid", auth, wrap(async (req, res) => {
    const v0 = await viewerFor(req.session.user.email); const e = TM.adminError(v0); if (e) return res.status(e.status).json({ error: e.error });
    res.json(await changeTeams(req, (v, T) => TM.adminError(v) ? { error: TM.adminError(v) } : TM.deleteTeam(T, req.params.tid)));
  }));
  // { email, action: "add" | "remove" }: el líder de ESE equipo o dirección. Un miembro, 403; el líder de otro equipo, 403.
  app.post("/api/teams/:tid/members", auth, wrap(async (req, res) => {
    const v0 = await viewerFor(req.session.user.email);
    if (!v0.leader) return res.status(403).json({ error: "Solo el líder del equipo o dirección cambia quién está en el equipo." });
    const email = lc(req.body?.email), add = req.body?.action === "add";
    if (!add && req.body?.action !== "remove") return res.status(400).json({ error: "¿Sumar o sacar?" });
    const known = teamUsers(await pd.meta()).some(u => lc(u.email) === email);
    res.json(await changeTeams(req, (v, T) => TM.memberChange(v, T, { teamId: req.params.tid, email, add, known, target: otherViewer(v, email).acc })));
  }));

  // Demos del mes o del trimestre (tarjeta «Demos» de Equipo): SOLO líderes y dirección (a los demás, 403 antes de leer nada).
  // ?period=2026-11 o 2026-Q4 (sin elegir: el mes en curso). Con equipos, el equipo elegido (?team=, como Métricas): la lista, las
  // que da o cargó alguien del equipo; por persona, solo su gente. Outbound/inbound por la Fuente (lib/demos.js monthBoard).
  app.get("/api/team/demos", auth, wrap(async (req, res) => {
    const t = await mxTeam(req, "Las demos del equipo solo las ven los líderes y dirección.");
    res.json({ ...(await sales.demosMonth(req.tz, String(req.query.period || "").slice(0, 10), t.filter)), team: t.team, on: t.on });
  }));
}
