// Equipo: demos de Pipedrive (la lista y «Falta marcar»; cuántas cargó cada uno solo para líderes, en orden alfabético),
// actividad reciente y, para líderes, equipos, accesos, sincronización y World Dominion. Las métricas están en Métricas.
// Con equipos (lib/teams.js), todo es del equipo: un líder ve el suyo (dirección elige uno o «Toda la cuenta» arriba), un miembro el suyo
// y alguien sin equipo, lo suyo. Sincronizar y World Dominion son de toda la cuenta: los ve quien ve todo.
import { S, api, esc, icon, ago, copy, toast, pill, setSchools, ST, DEMO_RES, shortDay, modal, leadsOver, teamSelect, teamQuery, setTeamView } from "./core.js";
import { openSchool, openRecord } from "./school.js";
import { demoResultMenu } from "./today.js";
import { brainBadge, refreshMe } from "./app.js";

let host;
const CH_ICON = { call: "phone", whatsapp: "whatsapp", mail: "mail", visit: "user" };

export function renderTeam(el) {
  host = el;
  draw();
  refresh(); // si ya había datos se ven al instante y se actualizan atrás
}
let seq = 0;
async function refresh() {
  const my = ++seq, q = teamQuery() ? `?${teamQuery()}` : "";
  const [demos, feed] = await Promise.all([
    api(`/api/team/demos${q}`).catch(e => ({ error: e.message })),
    api(`/api/feed${q}`).catch(e => ({ error: e.message })),
  ]);
  if (my !== seq) return; // se cambió de equipo mientras tanto
  S.team7 = { demos, feed };
  if (host?.isConnected) draw();
}
// Accesos (líderes y dirección): el código personal de cada persona y un botón para copiar la invitación. Dirección (y los
// líderes fijos) además elige el acceso de cada uno (Miembro · Líder · Dirección con cargo) y su equipo; lo fijo (definido
// por el administrador) no se puede bajar y nadie se saca el suyo: el servidor manda qué opciones van deshabilitadas
// (choices) y vuelve a controlar todo al guardar. Un líder de equipo ve a su gente (y la suma o saca en «Equipos»).
let codes = null;
const accDraft = new Map(); // email → { level, title, team, busy, err }: lo que estás eligiendo en cada fila (sobrevive a redibujar)
async function loadCodes() { try { codes = await api("/api/team/codes"); } catch (e) { codes = { error: e.message, users: [] }; } if (host?.isConnected) drawCodes(); }
const fShort = v => new Intl.DateTimeFormat("es", { day: "numeric", month: "short" }).format(new Date(v));
const accTag = u => u.role ? `<span class="acc-tag${u.access?.level !== "equipo" ? " lead" : ""}">${esc(u.role)}</span>` : "";
function accNote(u) {
  const a = u.access, why = [];
  if (a.fixed) why.push(a.fixed === "direccion" ? "Dirección definida por el administrador" : "Líder definido por el administrador: ve todos los equipos");
  if (a.stale) why.push("era líder antes de los equipos: elegí qué equipo lidera");
  if (u.me && a.level !== "equipo") why.push("no podés sacarte tu propio acceso");
  if (a.by && a.at) why.push(`lo cambió ${a.by} el ${fShort(a.at)}`);
  return why.join(" · ");
}
// equipo que se muestra en la fila: el que lidera (si lidera varios, «varios») o del que es miembro
const curTeam = u => u.team?.led?.length > 1 ? "*" : u.team?.led?.[0] || u.team?.member || "";
function accHtml(u) {
  const d = accDraft.get(u.email) || {}, level = d.level ?? u.access.level, title = d.title ?? u.access.title ?? "", team = d.team ?? curTeam(u);
  const dirty = level !== u.access.level || (level === "direccion" && title.trim() !== (u.access.title || "")) || (codes.on && level !== "direccion" && team !== curTeam(u));
  const id = `acc-${u.id}`, note = accNote(u);
  const teamSel = codes.on && level !== "direccion" ? `<label class="acc-f"><span>${level === "lider" ? "Lidera" : "Equipo"}</span><select class="inp" data-acc-team ${d.busy ? "disabled" : ""}>
      ${level === "lider" ? "" : `<option value="" ${team === "" ? "selected" : ""}>Sin equipo</option>`}${level === "lider" && !team ? `<option value="" selected disabled>Elegí el equipo</option>` : ""}
      ${team === "*" ? `<option value="*" selected disabled>Varios (${u.team.led.length})</option>` : ""}${codes.teams.map(t => `<option value="${esc(t.id)}" ${t.id === team ? "selected" : ""}>${esc(t.name)}</option>`).join("")}</select></label>` : "";
  return `<div class="acc" data-acc="${esc(u.email)}">
    <label class="acc-f"><span>Acceso</span><select class="inp" id="${id}" data-acc-level ${d.busy ? "disabled" : ""}>${u.choices.map(c => `<option value="${c.level}" ${c.level === level ? "selected" : ""} ${c.disabled ? "disabled" : ""}>${esc(c.level === "direccion" ? "Dirección (CEO, CTO…)" : c.label)}${c.disabled ? ` (${esc(c.why)})` : ""}</option>`).join("")}</select></label>
    ${teamSel}
    ${level === "direccion" ? `<label class="acc-f acc-title"><span>Cargo <small class="faint">opcional</small></span><input class="inp" data-acc-title maxlength="24" value="${esc(title)}" placeholder="CEO, CTO, COO…" autocomplete="off" ${d.busy ? "disabled" : ""}></label>` : ""}
    <button class="btn sm ${dirty ? "primary" : ""}" data-acc-save ${dirty && !d.busy ? "" : "disabled"}>${d.busy ? "Guardando…" : "Guardar"}</button>
    ${note ? `<small class="acc-note">${esc(note)}</small>` : ""}
    ${d.err ? `<div class="callout err acc-err" role="alert">${icon("alert")}<span>${esc(d.err)}</span></div>` : ""}
  </div>`;
}
// dirección con un equipo elegido arriba: la gente de ese equipo y la que no tiene equipo (para sumarla)
function codeRows(c) {
  const tv = new URLSearchParams(teamQuery()).get("team") || "";
  if (!c.admin || !c.on || !tv || tv === "all") return c.users;
  return c.users.filter(u => u.team?.member === tv || u.team?.led?.includes(tv) || (!u.team?.member && !u.team?.led?.length));
}
const codesHtml = c => c.error ? `<div class="callout err">${icon("alert")}<span>${esc(c.error)}</span></div>`
  : `<p class="faint" style="margin:0 0 6px;font-size:13.5px">${c.admin ? `Dirección ve todos los equipos; cada líder, solo el suyo (Métricas, demos, actividad y estos accesos).${c.on ? " Una persona está en un solo equipo." : " Sin equipos, los líderes ven todo."}` : c.on ? "Tu gente: pasale su código para que entre. Para sumar o sacar a alguien, usá «Equipos»." : "Los accesos los cambia dirección."}</p>
  <div class="codes">${codeRows(c).map(u => `<div class="code-row"><span class="t"><b>${esc(u.name)}${u.me ? " (vos)" : ""} ${accTag(u)}</b><small>${esc(u.email)}</small></span>${u.code ? `<code>${esc(u.code)}</code><button class="btn sm" data-invite="${u.id}">${icon("copy", "sm")} Copiar invitación</button>` : `<small class="faint code-off">Tiene acceso de líder o dirección: su código se lo pasa dirección.</small>`}${u.choices ? accHtml(u) : ""}</div>`).join("") || `<p class="faint" style="margin:0">Nadie en tu equipo todavía.</p>`}</div>`;
function drawCodes() {
  const box = host?.isConnected && host.querySelector("#codes"); if (!box || !codes) return;
  // si estabas escribiendo el cargo, el foco vuelve al mismo campo después de redibujar
  const f = document.activeElement, keep = box.contains(f) ? { email: f.closest("[data-acc]")?.dataset.acc, title: f.matches("[data-acc-title]"), pos: f.selectionStart } : null;
  box.innerHTML = codesHtml(codes);
  box.querySelectorAll("[data-invite]").forEach(b => b.onclick = () => {
    const u = codes.users.find(x => String(x.id) === b.dataset.invite); if (!u?.code) return;
    copy(`Hola ${u.name.split(" ")[0]}! Entrá a OrderBrain SDR: ${codes.url}\nTu email: ${u.email}\nTu código personal: ${u.code}\n(No lo compartas: es solo tuyo.)`);
  });
  box.querySelectorAll("[data-acc]").forEach(row => {
    const email = row.dataset.acc, u = codes.users.find(x => x.email === email); if (!u) return;
    const set = patch => { accDraft.set(email, { ...(accDraft.get(email) || {}), ...patch, err: "" }); drawCodes(); };
    row.querySelector("[data-acc-level]").onchange = e => set({ level: e.target.value, ...(e.target.value === "lider" && !u.team?.led?.length ? { team: "" } : {}) });
    row.querySelector("[data-acc-team]")?.addEventListener("change", e => set({ team: e.target.value }));
    const t = row.querySelector("[data-acc-title]");
    if (t) { t.oninput = () => { accDraft.set(email, { ...(accDraft.get(email) || {}), title: t.value, err: "" }); const b = row.querySelector("[data-acc-save]"), dirty = (accDraft.get(email).level ?? u.access.level) !== u.access.level || t.value.trim() !== (u.access.title || ""); b.disabled = !dirty; b.classList.toggle("primary", dirty); };
      t.onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); saveAccess(u); } }; }
    row.querySelector("[data-acc-save]").onclick = () => saveAccess(u);
  });
  if (keep?.email) { const el = box.querySelector(`[data-acc="${CSS.escape(keep.email)}"] ${keep.title ? "[data-acc-title]" : "[data-acc-level]"}`); if (el && !el.disabled) { el.focus(); if (keep.title && keep.pos != null) try { el.setSelectionRange(keep.pos, keep.pos); } catch {} } }
}
async function saveAccess(u) {
  const d = accDraft.get(u.email) || {}, level = d.level ?? u.access.level, title = (d.title ?? u.access.title ?? "").trim(), team = d.team ?? curTeam(u);
  if (d.busy) return;
  accDraft.set(u.email, { ...d, busy: true, err: "" }); drawCodes();
  try {
    // el equipo va si cambió (o si pasa a líder: el que eligió); «varios» no se toca
    const body = { email: u.email, level, title, ...(codes.on && level !== "direccion" && team !== "*" && (team !== curTeam(u) || level !== u.access.level) ? { team } : {}) };
    const r = await api("/api/team/access", { body });
    codes = { ...codes, users: r.users || codes.users.map(x => x.email === u.email ? r.user : x), teams: r.teams || codes.teams }; accDraft.delete(u.email); drawCodes();
    const first = u.name.split(" ")[0];
    toast(r.user.access.level === "equipo" ? `Listo: ${first} es ${r.user.role || "miembro"}` : `Listo: ${first} ahora es ${r.user.role || r.user.access.label}`);
    afterTeamChange({ codes: false });
  } catch (e) { accDraft.set(u.email, { ...(accDraft.get(u.email) || {}), busy: false, err: e.message }); drawCodes(); }
}
// Después de cambiar equipos o accesos: tu acceso y tus equipos (menú, selector), la lista de equipos, los accesos y lo de arriba
async function afterTeamChange({ codes: reCodes = true, teams = true } = {}) {
  await refreshMe();
  api("/api/team").then(t => { S.team = t; }).catch(() => {}); // los roles que ve el resto de la app
  if (!host?.isConnected) return;
  if (!S.profile?.leader) { draw(); return; }
  if (teams) loadTeams();
  if (reCodes) loadCodes();
  draw(); refresh();
}

// Equipos: dirección (y los fijos) crea, renombra y borra equipos y elige sus líderes y miembros; el líder de un equipo
// suma gente sin equipo o la saca. Sin equipos, la app funciona como siempre (todos ven todo).
let tdata = null, tBusy = false, tEdit = null, tNew = "";
async function loadTeams() { try { tdata = await api("/api/teams"); } catch (e) { tdata = { error: e.message }; } drawTeams(); }
const teamName = id => tdata?.teams?.find(t => t.id === id)?.name || "";
function chip(p, rm) {
  return `<span class="tm-chip">${esc(p.name)}${p.email === S.me.email ? " (vos)" : ""}${rm ? `<button class="tm-x" data-tm-rm="${rm}" data-email="${esc(p.email)}" aria-label="Sacar a ${esc(p.name)}" title="Sacar" ${tBusy ? "disabled" : ""}>${icon("x", "sm")}</button>` : ""}</span>`;
}
// dónde está hoy esa persona: «· líder de SDR México», «· en SDR Cono Sur» (dirección no se ofrece: no está en equipos)
const ledNames = p => (p.led || []).map(teamName).filter(Boolean);
const whereOf = (p, t) => { const l = (p.led || []).filter(id => id !== t.id); return l.length > 1 ? ` · líder de ${l.length} equipos` : l.length ? ` · líder de ${teamName(l[0])}` : p.member && p.member !== t.id ? ` · en ${teamName(p.member)}` : p.fixed ? " · líder fijo" : ""; };
function addSelect(kind, t) {
  const inT = new Set([...t.leaders, ...t.members].map(p => p.email));
  // un líder fijo puede liderar un equipo, no ser miembro
  const ppl = (tdata.people || []).filter(p => !inT.has(p.email) && p.level !== "direccion" && !(kind === "member" && p.fixed));
  if (!ppl.length) return kind === "member" && !tdata.admin ? `<span class="faint">Nadie sin equipo para sumar</span>` : "";
  const where = p => whereOf(p, t);
  return `<select class="inp tm-add" data-tm-add="${kind}" aria-label="Sumar ${kind === "leader" ? "líder" : "miembro"} a ${esc(t.name)}" ${tBusy ? "disabled" : ""}><option value="">+ ${kind === "leader" ? "Líder" : "Miembro"}</option>${ppl.map(p => `<option value="${esc(p.email)}">${esc(p.name + where(p))}</option>`).join("")}</select>`;
}
function teamsHtml() {
  if (!tdata) return '<div class="skel" style="margin:14px 0"></div>'.repeat(2);
  if (tdata.error) return `<div class="callout err">${icon("alert")}<span>${esc(tdata.error)}</span><button class="btn sm" id="tmRetry">Reintentar</button></div>`;
  const admin = tdata.admin;
  const intro = admin ? (tdata.on ? "Cada líder ve y maneja solo su equipo: Métricas, demos, actividad y accesos. Dirección ve todos. Cada persona está en un solo equipo."
      : "Sin equipos, todos los líderes ven todo (como hasta ahora). Armá equipos (SDR México, SDR Cono Sur, Account Executives…) para que cada líder vea solo lo de su gente.")
    : "Ves y manejás tu equipo. Sumá gente sin equipo; pasar a alguien de otro equipo lo hace dirección.";
  const card = t => `<div class="tm" data-tm="${esc(t.id)}">
    <div class="tm-h">${admin && tEdit === t.id ? `<input class="inp" data-tm-name value="${esc(t.name)}" maxlength="40" aria-label="Nombre del equipo"><button class="btn sm primary" data-tm-save ${tBusy ? "disabled" : ""}>Guardar</button><button class="btn sm ghost" data-tm-cancel>Cancelar</button>`
      : `<b>${esc(t.name)}</b>${t.mine ? '<span class="acc-tag">tu equipo</span>' : ""}<span class="tm-sp"></span>${admin ? `<button class="btn sm ghost" data-tm-edit>Renombrar</button><button class="btn sm ghost" data-tm-del>Borrar</button>` : ""}`}</div>
    <div class="tm-row"><span class="tm-l">Líderes</span><div class="tm-chips">${t.leaders.map(p => chip(p, admin && "leader")).join("") || '<span class="faint">Sin líder</span>'}${admin ? addSelect("leader", t) : ""}</div></div>
    <div class="tm-row"><span class="tm-l">Miembros</span><div class="tm-chips">${t.members.map(p => chip(p, t.canMembers && "member")).join("") || '<span class="faint">Nadie todavía</span>'}${t.canMembers ? addSelect("member", t) : ""}</div></div>
  </div>`;
  // a dirección: quienes eran líderes antes de los equipos y todavía no lideran uno (sin equipo no ven Métricas)
  const st = admin && tdata.stale?.length ? tdata.stale : [];
  const stTxt = !st.length ? "" : st.length === 1 ? `${st[0].name} era líder antes de los equipos y todavía no lidera ninguno: sin equipo no ve Métricas. Elegí su equipo con «+ Líder» o «+ Miembro».`
    : `${st.length} líderes de antes de los equipos todavía no lideran ninguno (${st.map(x => x.name).join(", ")}): sin equipo no ven Métricas. Elegí el equipo de cada uno con «+ Líder» o «+ Miembro».`;
  return `<p class="faint" style="margin:0 0 10px;font-size:13.5px">${esc(intro)}</p>
    ${stTxt ? `<div class="callout warn" style="margin-bottom:10px">${icon("alert")}<span>${esc(stTxt)}</span></div>` : ""}
    ${tdata.teams.map(card).join("") || (admin ? "" : `<p class="faint" style="margin:0">Todavía no liderás ningún equipo: te lo asigna dirección.</p>`)}
    ${admin ? `<form class="tm-new" id="tmNew"><input class="inp" id="tmNewName" maxlength="40" placeholder="Nombre del equipo nuevo (SDR México…)" value="${esc(tNew)}" autocomplete="off" aria-label="Nombre del equipo nuevo"><button class="btn primary" ${tBusy ? "disabled" : ""}>${icon("plus", "sm")} Crear equipo</button></form>` : ""}
    <div id="tmMsg" role="alert"></div>`;
}
function drawTeams() {
  const box = host?.isConnected && host.querySelector("#teamsBox"); if (!box) return;
  box.innerHTML = teamsHtml();
  const sub = host.querySelector("#tmSub"), n = tdata?.teams?.length;
  if (sub && n != null) sub.textContent = tdata.admin ? (n ? `${n} equipo${n === 1 ? "" : "s"}` : "todavía no hay") : n > 1 ? "tus equipos" : "tu equipo";
  box.querySelector("#tmRetry")?.addEventListener("click", () => { tdata = null; drawTeams(); loadTeams(); });
  const nn = box.querySelector("#tmNewName"); if (nn) nn.oninput = () => { tNew = nn.value; };
  box.querySelector("#tmNew")?.addEventListener("submit", e => { e.preventDefault(); if (!tNew.trim()) return teamMsg("Poné el nombre del equipo."); teamDo(() => api("/api/teams", { body: { name: tNew } }), () => { tNew = ""; const n = tdata.stale?.length || 0; return `Equipo creado${n ? ` · ${n === 1 ? "1 líder todavía no tiene equipo" : `${n} líderes todavía no tienen equipo`}` : ""}`; }); });
  box.querySelectorAll("[data-tm]").forEach(el => {
    const id = el.dataset.tm, t = tdata.teams.find(x => x.id === id); if (!t) return;
    el.querySelector("[data-tm-edit]")?.addEventListener("click", () => { tEdit = id; drawTeams(); el.isConnected; box.querySelector(`[data-tm="${CSS.escape(id)}"] [data-tm-name]`)?.focus(); });
    el.querySelector("[data-tm-cancel]")?.addEventListener("click", () => { tEdit = null; drawTeams(); });
    const save = () => { const v = el.querySelector("[data-tm-name]")?.value || ""; teamDo(() => api(`/api/teams/${id}`, { method: "PATCH", body: { name: v } }), () => { tEdit = null; return "Nombre cambiado"; }); };
    el.querySelector("[data-tm-save]")?.addEventListener("click", save);
    el.querySelector("[data-tm-name]")?.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); save(); } if (e.key === "Escape") { tEdit = null; drawTeams(); } });
    el.querySelector("[data-tm-del]")?.addEventListener("click", () => askDelete(t));
    el.querySelectorAll("[data-tm-add]").forEach(sel => sel.onchange = () => {
      const email = sel.value, p = (tdata.people || []).find(x => x.email === email); if (!email || !p) return;
      const leader = sel.dataset.tmAdd === "leader", mv = moveOf(p, t, leader);
      const go = () => leader ? teamDo(() => api(`/api/teams/${id}`, { method: "PATCH", body: { leaders: [...t.leaders.map(x => x.email), email] } }), () => mv.toast)
        : teamDo(() => api(`/api/teams/${id}/members`, { body: { email, action: "add" } }), () => mv.toast);
      if (mv.lost.length) askMove(p, t, mv, go, () => { sel.value = ""; }); else go();
    });
    el.querySelectorAll("[data-tm-rm]").forEach(b => b.onclick = () => {
      const email = b.dataset.email, p = [...t.leaders, ...t.members].find(x => x.email === email), first = firstName(p?.name || email);
      if (b.dataset.tmRm === "leader") teamDo(() => api(`/api/teams/${id}`, { method: "PATCH", body: { leaders: t.leaders.map(x => x.email).filter(e => e !== email) } }), () => `${first} ya no lidera ${t.name}${t.leaders.length === 1 ? ` · ${t.name} quedó sin líder` : ""}`);
      else teamDo(() => api(`/api/teams/${id}/members`, { body: { email, action: "remove" } }), () => `${first} salió de ${t.name}`);
    });
  });
}
// Qué pierde alguien al pasar a este equipo (t): dejar el equipo del que es miembro y, al pasar de miembro, dejar de liderar
// los suyos (si era el único líder, ese equipo queda sin líder). Como líder de otro equipo puede liderar este también.
const firstName = n => String(n || "").split(" ")[0];
function moveOf(p, t, asLeader) {
  const first = firstName(p.name), lost = [], orphan = [];
  if (p.member && p.member !== t.id) lost.push(`deja ${teamName(p.member)}`);
  if (!asLeader) for (const id of (p.led || []).filter(x => x !== t.id)) {
    const o = tdata.teams.find(x => x.id === id), alone = !!o && o.leaders.length <= 1;
    lost.push(`deja de liderar ${teamName(id)}${alone ? " y ese equipo queda sin líder" : ""}`); if (alone) orphan.push(teamName(id));
  }
  const losesAccess = !asLeader && (p.led || []).length > 0 && !p.fixed;
  const toast = asLeader ? `${first} ahora lidera ${t.name}${p.member && p.member !== t.id ? ` · dejó ${teamName(p.member)}` : ""}${ledNames(p).length ? ` (y sigue liderando ${ledNames(p).join(", ")})` : ""}`
    : `${first} pasó a ${t.name}${orphan.length ? ` · ${orphan.join(" y ")} quedó sin líder` : ""}`;
  return { lost, losesAccess, toast, asLeader };
}
function askMove(p, t, mv, go, cancel) {
  const first = firstName(p.name), list = mv.lost.join("; ");
  let ok = false; // Esc, clic afuera o Cancelar: el selector vuelve a «+ …»
  const m = modal(`<div class="modal-h"><h3>${mv.asLeader ? `¿${esc(first)} pasa a liderar ${esc(t.name)}?` : `¿Pasás a ${esc(first)} a ${esc(t.name)}?`}</h3><button class="icon-btn" data-x aria-label="Cerrar">${icon("x")}</button></div>
    <p class="muted" style="margin:0 0 8px">${esc(first)} ${esc(list)}.</p>
    ${mv.losesAccess ? `<p class="muted" style="margin:0 0 14px">Como miembro deja de ver Métricas y lo de líder.</p>` : `<div style="height:6px"></div>`}
    <div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap"><button class="btn ghost" data-x>Cancelar</button><button class="btn primary" data-go>Sí, pasar a ${esc(t.name)}</button></div>`, { onClose: () => { if (!ok) cancel(); } });
  m.querySelectorAll("[data-x]").forEach(b => b.onclick = () => m.close());
  m.querySelector("[data-go]").onclick = () => { ok = true; m.close(); go(); };
}
const teamMsg = m => { const b = host?.querySelector("#tmMsg"); if (b) b.innerHTML = m ? `<div class="callout err" style="margin-top:10px">${icon("alert")}<span>${esc(m)}</span></div>` : ""; };
async function teamDo(call, ok) {
  if (tBusy) return;
  tBusy = true; drawTeams();
  try { tdata = await call(); tBusy = false; const m = ok(); drawTeams(); toast(m); afterTeamChange({ teams: false }); }
  catch (e) { tBusy = false; drawTeams(); teamMsg(e.message); }
}
function askDelete(t) {
  const n = t.leaders.length + t.members.length;
  const m = modal(`<div class="modal-h"><h3>¿Borrar «${esc(t.name)}»?</h3><button class="icon-btn" data-x aria-label="Cerrar">${icon("x")}</button></div>
    <p class="muted" style="margin:0 0 14px">${n ? `${n === 1 ? "La persona queda" : `Las ${n} personas quedan`} sin equipo${t.leaders.length ? " y sus líderes dejan de ver lo de líder (salvo que lideren otro)" : ""}.` : "No tiene gente."} En Pipedrive no cambia nada.</p>
    <div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn ghost" data-x>Cancelar</button><button class="btn primary" data-go>Borrar equipo</button></div>`);
  m.querySelectorAll("[data-x]").forEach(b => b.onclick = () => m.close());
  m.querySelector("[data-go]").onclick = () => { m.close(); teamDo(() => api(`/api/teams/${t.id}`, { method: "DELETE" }), () => "Equipo borrado"); };
}
// Sincronizar con Pipedrive (solo líderes): cruza toda la base de una vez. El servidor trabaja ~40 s por pedido y
// el navegador repite hasta terminar; «Pausar» deja de pedir (lo hecho queda guardado y se sigue después).
// Si la está siguiendo otra pestaña, otro líder o el cron (sync.active), no se ofrece «Seguir»: se mira cada 5 s.
let sync = null, syncing = false, pausing = false, starting = false, askFull = false, pollT = 0;
const fmt = n => Number(n || 0).toLocaleString("es-MX");
const ORDER = ["unk", "new", "org", "stalled", "lost", "open", "churn", "client", "lead"];
async function loadSync() {
  try { sync = await api("/api/admin/sync"); } catch (e) { sync = { error: { message: e.message } }; }
  drawSync();
  clearTimeout(pollT);
  if (sync?.active && !syncing) pollT = setTimeout(() => { if (host?.isConnected && !syncing) loadSync(); }, 5000);
}
// Sin total conocido (la primera completa, o una incremental) la barra va y viene: un % fijo parece trabado.
function progress(j) {
  if (j.phase === "orgs") { const tot = j.mode === "full" ? j.approxOrgs : null; return { text: `Leyendo organizaciones de Pipedrive: ${fmt(j.orgs)}${tot ? ` de unas ${fmt(tot)}` : ""}`, pct: tot ? Math.min(60, j.orgs / tot * 60) : null }; }
  if (j.phase === "deals") { const tot = j.mode === "full" ? j.approxDeals : null; return { text: `Leyendo tratos: ${fmt(j.deals)}${tot ? ` de unos ${fmt(tot)}` : ""}`, pct: tot ? 60 + Math.min(10, j.deals / tot * 10) : null }; }
  return { text: `Cruzando colegios: ${fmt(j.done)} de ${fmt(j.total)}`, pct: 70 + Math.min(30, j.done / Math.max(1, j.total) * 30) };
}
// Qué dejó la última: lo que cambió de verdad (estado, organización o fase), lo revisado por primera vez y lo que no se tocó.
// Las reescrituras de mantenimiento (para que el cruce no venza) no se cuentan.
function lastHtml(last) {
  const when = `Última: ${esc(ago(last.finishedAt))} (${last.mode === "full" ? "completa" : "solo cambios"})`;
  if (last.changed === undefined) return `${when} · ${fmt(last.written)} colegios revisados`; // de antes de contar cambios
  const to = Object.entries(last.to || {}).sort((x, y) => y[1] - x[1]).map(([k, n]) => `${fmt(n)} a ${esc(ST[k]?.l || k)}`);
  const parts = [];
  if (last.changed) parts.push(`<b>${fmt(last.changed)} cambiaron</b>${to.length ? `: ${to.join(", ")}` : ""}`);
  if (last.first) parts.push(`${fmt(last.first)} revisados por primera vez`);
  if (!last.changed && !last.first) parts.push("sin cambios");
  if (last.skipped) parts.push(`${fmt(last.skipped)} sin tocar (revisados recién o elegidos a mano)`);
  return `${when} · ${parts.join(" · ")}`;
}
function syncHtml() {
  if (!sync) return '<div class="skel" style="margin:14px 0"></div>'.repeat(2);
  const j = sync.job, last = sync.last, c = sync.counts || {};
  const other = !syncing && !!sync.active; // la está siguiendo otra pestaña, otro líder o el cron
  const p = j ? progress(j) : starting ? { text: "Empezando…", pct: null } : null;
  const who = a => a?.by === "cron" ? "el cron diario" : a?.by || "otra pestaña";
  const state = syncing || starting ? "" : other ? ` · la está siguiendo ${esc(who(sync.active))}` : " · quedó en pausa";
  const counts = ORDER.filter(k => c[k]).map(k => `<span class="sync-count">${pill(k)}<b>${fmt(c[k])}</b></span>`).join("");
  const bar = p ? `<div class="prog${p.pct == null ? " ind" : ""}" role="progressbar" aria-label="Progreso" ${p.pct != null ? `aria-valuenow="${Math.round(p.pct)}" aria-valuemin="0" aria-valuemax="100"` : ""}><div ${p.pct != null ? `style="width:${p.pct}%"` : ""}></div></div>` : "";
  const hint = syncing || starting || other ? `<small class="faint" style="display:block;margin-top:4px">Tarda unos minutos. Si cerrás la pestaña queda en pausa y la seguís después${sync.cron ? " (o la sigue el cron diario)" : ""}.</small>` : "";
  const buttons = syncing || starting ? `<button class="btn" id="syncPause" ${pausing ? "disabled" : ""}>${pausing ? "Pausando…" : "Pausar"}</button>`
    : other ? `<button class="btn" id="syncLook">${icon("refresh", "sm")} Ver cómo va</button>`
    : askFull ? `<div class="callout warn" style="flex-basis:100%">${icon("alert")}<span>Vuelve a leer todo Pipedrive. Tarda unos minutos.${j ? " Lo avanzado en la que quedó a medias se descarta." : ""}</span></div>
        <button class="btn primary" id="syncFullYes">Sí, rehacer</button><button class="btn ghost" id="syncFullNo">Cancelar</button>`
    : `<button class="btn primary" id="syncGo">${icon("refresh", "sm")} ${j ? "Seguir" : "Sincronizar con Pipedrive"}</button>${j || last ? `<button class="btn ghost" id="syncFull" title="Vuelve a leer todas las organizaciones y tratos">Rehacer desde cero</button>` : ""}`;
  return `
    ${sync.error ? `<div class="callout err" style="margin-bottom:10px">${icon("alert")}<span>${esc(sync.error.message)}</span></div>` : ""}
    ${p ? `<div style="margin:4px 0 12px"><p style="margin:0 0 6px">${esc(p.text)}${j ? state : ""}</p>${bar}
      ${j ? `<small class="faint">${j.mode === "full" ? "Completa" : "Solo lo cambiado desde la última"}${j.by ? ` · la empezó ${esc(j.by === "cron" ? "el cron diario" : j.by)}` : ""}${sync.busy ? " · hay otro paso corriendo, espero…" : ""}</small>` : ""}${hint}</div>` : ""}
    ${last ? `<p class="faint" style="margin:0 0 10px;font-size:13.5px">${lastHtml(last)}</p>`
      : !p ? `<p class="faint" style="margin:0 0 10px;font-size:13.5px">Todavía no se sincronizó: cada colegio se revisa recién cuando alguien abre su ficha.</p>` : ""}
    <div style="display:flex;flex-wrap:wrap;gap:8px 14px;margin:0 0 14px">${counts}</div>
    <div style="display:flex;flex-wrap:wrap;gap:8px">${buttons}</div>`;
}
function drawSync() {
  const box = host?.isConnected && host.querySelector("#syncBox"); if (!box) return;
  box.innerHTML = syncHtml();
  box.querySelector("#syncGo")?.addEventListener("click", () => runSync(false));
  box.querySelector("#syncFull")?.addEventListener("click", () => { askFull = true; drawSync(); });
  box.querySelector("#syncFullYes")?.addEventListener("click", () => { askFull = false; runSync(true); });
  box.querySelector("#syncFullNo")?.addEventListener("click", () => { askFull = false; drawSync(); });
  box.querySelector("#syncLook")?.addEventListener("click", () => loadSync());
  box.querySelector("#syncPause")?.addEventListener("click", () => { pausing = true; drawSync(); });
}
async function runSync(full) {
  if (syncing) return;
  clearTimeout(pollT);
  syncing = true; pausing = false; starting = !sync?.job; drawSync();
  let first = true;
  try {
    while (!pausing) {
      sync = await api("/api/admin/sync", { body: { full: first && full } }); first = false; starting = false;
      drawSync();
      if (sync.error || !sync.running) break;
      if (sync.busy) await new Promise(r => setTimeout(r, 4000));
    }
  } catch (e) { sync = { ...(sync || {}), error: { message: e.message } }; }
  const done = !sync?.running && !sync?.error;
  syncing = false; pausing = false; starting = false; drawSync();
  if (done) {
    toast("Listo: la base quedó cruzada con Pipedrive");
    try { setSchools(await api("/api/schools")); } catch {} // la lista y el mapa con los estados nuevos
  }
}
// World Dominion (solo líderes): de cuándo son los clientes, cómo anduvo la última lectura y el token de brain.ordereat.com.
// El token se pega acá; el servidor lo prueba antes de guardarlo y nunca lo devuelve (solo quién lo cargó y cuándo vence).
let wd = null, wdAt = 0, wdBusy = false, wdDraft = "";
async function loadWd() { wdAt = Date.now(); try { wd = await api("/api/admin/brain"); } catch (e) { wd = { fail: e.message }; } drawWd(); }
const fDay = v => new Intl.DateTimeFormat("es", { day: "numeric", month: "short", year: "numeric" }).format(new Date(v));
const fWhen = v => new Intl.DateTimeFormat("es", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(v));
const until = v => { const h = (new Date(v) - Date.now()) / 36e5, d = Math.round(h / 24); return h < 1 ? "en menos de una hora" : h < 24 ? `en ${Math.round(h)} h` : `en ${d} día${d === 1 ? "" : "s"}`; };
function wdHtml() {
  if (!wd) return '<div class="skel" style="margin:14px 0"></div>'.repeat(2);
  if (wd.fail) return `<div class="callout err">${icon("alert")}<span>${esc(wd.fail)}</span><button class="btn sm" id="wdRetry">Reintentar</button></div>`;
  const which = wd.source === "env" ? "El token de Vercel" : "El token", lr = wd.lastRead;
  // OrderBrain lo rechazó: eso manda sobre la fecha del token (que puede decir que todavía no venció)
  const rejected = !!(lr && !lr.ok && lr.auth);
  const notes = [];
  // si la copia de los clientes es reciente, el token vencido no es urgente: se dice tranquilo
  const freshCopy = wd.dataAt && Date.now() - new Date(wd.dataAt).getTime() < 3 * 864e5;
  if ((rejected || wd.expiry === "expired") && freshCopy) notes.push(["warn", `${rejected ? "OrderBrain ya no acepta el token" : `${which} venció el ${fWhen(wd.exp)}`}, pero los clientes siguen al día con la copia de ${ago(wd.dataAt)} (se usa hasta 30 días). Cuando quieras actualizarla, pegá uno nuevo abajo.`]);
  else if (rejected) notes.push(["err", `OrderBrain ya no acepta ${which === "El token" ? "este token" : "el token de Vercel"}${wd.exp && wd.expiry !== "expired" ? ` (aunque su fecha dice que vence el ${fDay(wd.exp)})` : ""}. Pegá uno nuevo abajo.`]);
  else if (wd.expiry === "expired") notes.push(["err", `${which} venció el ${fWhen(wd.exp)}. Pegá uno nuevo abajo.`]);
  else if (wd.expiry === "soon") notes.push(["warn", `${which} vence ${until(wd.exp)} (${fWhen(wd.exp)}). Conviene cargar uno nuevo antes.`]);
  if (wd.loaded && !wd.loaded.inUse) notes.push(["warn", `El token que cargó ${wd.loaded.by || "un líder"} venció: se usa el de Vercel.`]);
  const here = t => String(t || "").replace(/ Un líder puede cargar uno nuevo en Equipo\.$/, ""); // ya está en Equipo
  if (lr && !lr.ok && !rejected) notes.push(["err", `La última lectura falló (${ago(lr.at)}): ${here(lr.error)}`]);
  else if (!lr && wd.error) notes.push(["err", here(wd.error)]);
  if (!wd.source && !wd.demo) notes.push(["warn", "Sin token: la app no sabe qué colegios ya son clientes. Pegá uno abajo."]);
  const tokTxt = wd.source === "app" ? `Token cargado por <b>${esc(wd.loaded.by || "un líder")}</b> el ${esc(fDay(wd.loaded.at))}`
    : wd.source === "env" ? "Token de Vercel (BRAIN_TOKEN)" : "";
  const expTxt = !wd.source ? "" : rejected ? ` · rechazado ${esc(ago(lr.at))}` : wd.exp ? ` · ${wd.expiry === "expired" ? "venció" : "vence"} el ${esc(fDay(wd.exp))}` : " · sin fecha de vencimiento";
  return `
    ${notes.map(([k, t]) => `<div class="callout ${k}" style="margin-bottom:10px">${icon("alert")}<span>${esc(t)}</span></div>`).join("")}
    <p style="margin:0 0 4px"><b>${fmt(wd.sites)}</b> ${wd.demo ? "sitios de prueba (modo demo, sin token)" : `sitio${wd.sites === 1 ? "" : "s"}`}${wd.dataAt ? ` · datos <span title="${esc(fWhen(wd.dataAt))}">${esc(ago(wd.dataAt))}</span>` : ""}${wd.stale ? " (copia guardada)" : ""}</p>
    ${tokTxt ? `<p class="faint" style="margin:0 0 4px;font-size:13.5px">${tokTxt}${expTxt}</p>` : ""}
    ${lr?.ok ? `<p class="faint" style="margin:0 0 4px;font-size:13.5px">Última lectura ${esc(ago(lr.at))}: anduvo${lr.n != null ? ` (${fmt(lr.n)} sitios)` : ""}.</p>` : ""}
    <div class="field" style="margin-top:14px"><span><label for="wdTok">${wd.source ? "Cambiar el token" : "Cargar el token"}</label></span>
      <div class="scan-form"><input class="inp" id="wdTok" type="password" autocomplete="off" spellcheck="false" placeholder="Pegá el token acá" aria-describedby="wdHelp">
      <button class="btn primary" id="wdSave">Probar y guardar</button></div>
      <small class="faint" id="wdHelp">Es el token de sesión de ${esc(wd.host || "brain.ordereat.com")}. Lo probamos antes de guardarlo y después no se muestra más.</small>
      <details style="margin-top:6px;font-size:13.5px"><summary>Cómo conseguirlo</summary>
        <ol style="margin:6px 0 0;padding-left:20px;line-height:1.5">
          <li>En una computadora, entrá a <a href="https://${esc(wd.host || "brain.ordereat.com")}" target="_blank" rel="noopener">${esc(wd.host || "brain.ordereat.com")}</a> con una cuenta que vea World Dominion.</li>
          <li>Abrí las herramientas del navegador (F12, o clic derecho → Inspeccionar) y andá a la pestaña Consola.</li>
          <li>Escribí <code>localStorage.getItem("auth_token")</code> y apretá Enter.</li>
          <li>Copiá el texto que aparece (con o sin comillas, da igual) y pegalo acá. No lo mandes por chat: es tu sesión.</li>
        </ol>
        <p class="faint" style="margin:6px 0 0">Vence cuando vence tu sesión de OrderBrain: te avisamos en Hoy y acá unos días antes.</p>
      </details>
      <div id="wdMsg" role="alert"></div></div>`;
}
function drawWd() {
  const box = host?.isConnected && host.querySelector("#wdBox"); if (!box) return;
  box.innerHTML = wdHtml();
  box.querySelector("#wdRetry")?.addEventListener("click", () => { wd = null; drawWd(); loadWd(); });
  const inp = box.querySelector("#wdTok"); if (!inp) return;
  inp.value = wdDraft; inp.oninput = () => { wdDraft = inp.value; };
  inp.onkeydown = e => { if (e.key === "Enter") saveWd(); };
  box.querySelector("#wdSave").onclick = saveWd;
  if (wdBusy) busyWd(box, true);
}
const busyWd = (box, on) => { const b = box.querySelector("#wdSave"); if (b) { b.disabled = on; b.textContent = on ? "Probando…" : "Probar y guardar"; } };
async function saveWd() {
  const box = host.querySelector("#wdBox"), msg = box?.querySelector("#wdMsg");
  if (wdBusy || !box) return;
  if (!wdDraft.trim()) { msg.innerHTML = `<div class="callout err" style="margin-top:8px">${icon("alert")}<span>Pegá el token.</span></div>`; return; }
  wdBusy = true; busyWd(box, true); msg.innerHTML = "";
  try {
    wd = await api("/api/admin/brain", { body: { token: wdDraft } }); wdAt = Date.now(); wdDraft = "";
    wdBusy = false; drawWd();
    toast(`Listo: token guardado. ${fmt(wd.sites)} sitios de World Dominion.`);
    // el mapa, Hoy y la lista con los clientes nuevos
    S.brainP = api("/api/brain").catch(() => ({ enabled: false })); S.brainP.then(b => { S.brain = b; brainBadge(); });
    try { setSchools(await api("/api/schools")); } catch {}
  } catch (e) {
    wdBusy = false;
    const b = host.querySelector("#wdBox"); if (!b) return;
    busyWd(b, false);
    b.querySelector("#wdMsg").innerHTML = `<div class="callout err" style="margin-top:8px">${icon("alert")}<span>${esc(e.message)}</span></div>`;
  }
}
// Demos (todos): la lista, con quién la cargó, quién la da y qué pasó. Cuántas cargó cada uno solo lo ve un líder
// (el servidor a los demás les manda lo suyo y el total). Las métricas de demos están en Métricas.
// El resultado es el que quedó marcado (desde la app o en Pipedrive); sin marca, «?». Pasada a «No Show» en Pipedrive: ya tiene resultado.
// «Se hizo» con el color de lo positivo (res-ok), para que no se confunda con el «?» gris.
const RES_PILL = { done: "res-ok", noshow: "lost", moved: "org", canceled: "stalled" };
const resPill = r => r.result ? `<span class="pill ${RES_PILL[r.result]}">${esc(DEMO_RES[r.result])}</span>`
  : r.noShowType ? `<span class="pill lost" title="En Pipedrive la pasaron al tipo «No Show»">No Show</span>`
  : r.done ? `<span class="pill res-ok" title="En Pipedrive está hecha; nadie marcó qué pasó desde la app">Hecha en Pipedrive</span>`
  : r.past ? `<span class="pill unk" title="${r.moved ? "Se reprogramó y la fecha nueva ya pasó: falta marcar qué pasó" : "Falta marcar qué pasó con la demo"}">?</span>` : "";
const canMark = r => !r.noShowType && (!!(r.ownerId && r.ownerId === S.me.pdUserId) || leadsOver(r.ownerId));
// a un SDR el servidor solo le manda quién cargó las suyas («cargaste vos»); en las demás no va (no se cuenta por persona)
const setterTxt = r => r.auto ? "entrada automática" : r.mineLoaded || (r.setterId && r.setterId === S.me.pdUserId) ? "cargaste vos"
  : "setter" in r || "setterId" in r ? `cargó ${r.setter || (r.setterId ? "un usuario no activo" : "?")}` : "";
function demoRow(r) {
  const when = `${shortDay(r.date)}${r.time ? ` · ${r.time}` : ""}`, inner = `<b>${esc(r.name || "Colegio sin nombre")}</b><small style="white-space:normal">${esc([when, setterTxt(r), `la da ${r.owner || (r.ownerFree ? "una cuenta general" : "?")}`].filter(Boolean).join(" · "))}</small>`;
  const open = r.schoolId ? `<button class="t" data-dsch="${esc(r.schoolId)}">${inner}</button>` : r.record ? `<button class="t" data-drec="${esc(r.record)}" title="Abrir la ficha">${inner}</button>` : `<div class="t">${inner}</div>`;
  const mark = r.past && !r.result && canMark(r) ? `<button class="btn sm" data-dres="${r.id}" data-time="${esc(r.time)}">Marcar</button>` : "";
  return `<div class="act"><span class="ty meeting" role="img" aria-label="Demo">${icon("video")}</span>${open}<div class="ops">${resPill(r)}${mark}</div></div>`;
}
function demosHtml(d) {
  const intro = `<p class="faint" style="margin:0 0 8px;font-size:13.5px">Quién la cargó: en las de la app, quien dice la nota; si no, quien la creó en Pipedrive. Del ${esc(shortDay(d.from))} al ${esc(shortDay(d.to))}${d.at ? ` · Pipedrive, leído ${esc(ago(d.at))}` : ""}.${S.profile?.leader ? ' Las métricas están en <a href="#/metricas">Métricas</a>.' : ""}</p>`;
  // por persona solo a los líderes (orden alfabético, sin puestos); a los demás, lo suyo y el total
  const ppl = d.people ? (d.people.length ? `<div class="follow-wrap"><table class="follow"><thead><tr><th scope="col">Cargó <span class="mx-tag">solo líderes y dirección</span></th><th scope="col" class="num">Ya pasaron</th><th scope="col" class="num">Próximas</th></tr></thead>
    <tbody>${d.people.map(p => `<tr><th scope="row">${esc(p.auto ? "Entrada automática, sin agendador" : p.name || (p.id ? "Usuario no activo en Pipedrive" : "?"))}${p.id && p.id === S.me.pdUserId ? " (vos)" : ""}</th><td class="num">${p.recent}</td><td class="num">${p.upcoming}</td></tr>`).join("")}</tbody></table></div>` : "")
    : d.mine ? `<p style="margin:0 0 6px;font-size:14px">Cargadas por vos: <b>${d.mine.recent}</b> ya pasaron y <b>${d.mine.upcoming}</b> próximas. ${d.self ? "Las tuyas" : d.team ? `${esc(d.team.name)}` : "Todo el equipo"}: ${d.total.recent} y ${d.total.upcoming}.</p>` : "";
  const sec = (h, l) => `<h3 style="margin:14px 0 4px;font-size:14px">${h} <small class="faint">${l.length}</small></h3>${l.length ? l.map(demoRow).join("") : `<p class="faint" style="margin:0;font-size:13.5px">Ninguna.</p>`}`;
  // las de antes de los 7 días que quedaron sin resultado: solo las que podés marcar (las tuyas; un líder, todas)
  // hechas en Pipedrive (sin marca de la app) no son «falta marcar»: Métricas las cuenta como «Hecha en Pipedrive»
  const pending = (d.pending || []).filter(r => !r.done && canMark(r)), unk = [...d.recent, ...pending].some(r => !r.result && !r.noShowType && !r.done);
  return `${intro}${d.partial ? `<div class="callout warn" style="margin-bottom:10px">${icon("alert")}<span>Pipedrive devolvió demasiado: puede faltar alguna.</span></div>` : ""}${ppl}
    ${sec("Próximas", d.upcoming)}${sec("Ya pasaron (7 días)", d.recent)}${pending.length ? sec(`Falta marcar (desde el ${esc(shortDay(d.pendingFrom))})`, pending) : ""}
    ${unk ? `<p class="faint" style="margin:10px 0 0;font-size:13px">«?»: falta marcar qué pasó con la demo. La marca quien la da (o un líder).</p>` : ""}`;
}
function draw() {
  const t = S.team7;
  const err = (x, what) => `<div class="callout err">${icon("alert")}<span>No pudimos cargar ${what}: ${esc(x.error)}</span><button class="btn sm" data-retry>Reintentar</button></div>`;
  const sk = '<div class="skel" style="margin:14px 0"></div>'.repeat(5);
  let rank = sk, feed = sk;
  if (t) {
    rank = t.demos.error ? err(t.demos, "las demos") : demosHtml(t.demos);
    feed = t.feed.error ? err(t.feed, "la actividad") : t.feed.length ? t.feed.map(f => {
      const inner = `<span class="ty ${f.demo ? "meeting" : ""}" role="img" aria-label="${esc(f.title)}">${icon(f.demo ? "video" : CH_ICON[f.channel] || "note")}</span><span class="t"><b>${esc(f.org)}</b><span>${esc(f.title)}</span><small>${esc(f.author)} · ${esc(ago(f.at))}</small></span>`;
      return f.schoolId ? `<button class="feed-item" data-id="${esc(f.schoolId)}">${inner}</button>` : `<div class="feed-item">${inner}</div>`;
    }).join("") : `<div class="empty">${icon("note")}<span>Sin actividad todavía.</span></div>`;
  }
  const sc = S.profile?.scope || {}, leader = !!S.profile?.leader, shown = t?.demos?.team?.name;
  // de qué equipo es lo que ves (con equipos)
  const stale = !!S.profile?.access?.stale, unknown = !!sc.unknown || !!t?.demos?.unknown;
  const sub = unknown && !sc.admin ? "No pude leer los equipos: ves lo tuyo. Probá de nuevo en unos segundos."
    : !sc.on ? "Demos y actividad reciente" : leader ? (shown ? `Demos y actividad de ${shown}` : sc.all ? "Demos y actividad de toda la cuenta, también de gente sin equipo" : "Demos y actividad de tu equipo")
    : sc.member ? `Demos y actividad de ${sc.member.name}` : stale ? "Ves lo tuyo." : "Todavía no estás en un equipo: ves lo tuyo. Te suma su líder o dirección.";
  host.innerHTML = `<div class="page">
    <div class="page-head"><div><h1>Equipo</h1><p>${esc(sub)}</p></div><div class="team-head">${teamSelect("teamPick")}${leader ? `<a class="btn" href="#/metricas">${icon("chart", "sm")} Ver métricas</a>` : ""}</div></div>
    ${stale && !leader ? `<div class="callout warn" style="margin-bottom:14px">${icon("alert")}<span>Eras líder antes de los equipos. Ahora hay equipos: pedile a dirección que te asigne el tuyo. Mientras, ves lo tuyo (sin Métricas).</span></div>` : ""}
    <div class="two">
      <section class="card" aria-labelledby="hRk"><div class="card-h"><h2 id="hRk">${icon("video")} Demos</h2><span class="sub">últimos 7 días y próximas 2 semanas</span></div><div class="card-b">${rank}</div></section>
      <section class="card" aria-labelledby="hFd"><div class="card-h"><h2 id="hFd">${icon("clock")} Actividad reciente</h2></div><div class="card-b">${feed}</div></section>
    </div>
    ${leader && (sc.admin || sc.on) ? `<section class="card" style="margin-top:16px" aria-labelledby="hTm"><div class="card-h"><h2 id="hTm">${icon("users")} Equipos</h2><span class="sub" id="tmSub">${sc.admin ? "" : "tu equipo"}</span></div>
      <div class="card-b" id="teamsBox">${'<div class="skel" style="margin:14px 0"></div>'.repeat(2)}</div></section>` : ""}
    ${leader ? `<section class="card" style="margin-top:16px" aria-labelledby="hAc"><div class="card-h"><h2 id="hAc">${icon("user")} Accesos del equipo</h2><span class="sub">cada persona entra con su email y su código personal</span></div>
      <div class="card-b" id="codes">${'<div class="skel" style="margin:14px 0"></div>'.repeat(3)}</div></section>` : ""}
    ${leader && sc.all ? `<section class="card" style="margin-top:16px" aria-labelledby="hSy"><div class="card-h"><h2 id="hSy">${icon("refresh")} Sincronizar con Pipedrive</h2><span class="sub">cruza toda la base de colegios de una vez</span></div>
      <div class="card-b" id="syncBox" aria-live="polite"></div></section>
    <section class="card" style="margin-top:16px" aria-labelledby="hWd"><div class="card-h"><h2 id="hWd">${icon("globe")} World Dominion</h2><span class="sub">qué colegios ya son clientes de OrderEAT</span></div>
      <div class="card-b" id="wdBox"></div></section>` : ""}
    </div>`;
  host.querySelectorAll("[data-retry]").forEach(b => b.onclick = () => { S.team7 = null; draw(); refresh(); });
  host.querySelector("#teamPick")?.addEventListener("change", e => { setTeamView(e.target.value); S.team7 = null; draw(); refresh(); drawCodes(); });
  if (leader && (sc.admin || sc.on)) { if (!tdata) loadTeams(); else drawTeams(); }
  if (leader) { if (!codes) loadCodes(); else drawCodes(); }
  if (leader && sc.all) { drawSync(); if (!syncing) loadSync(); }
  if (leader && sc.all) { drawWd(); if (!wdBusy && Date.now() - wdAt > 20e3) loadWd(); }
  host.querySelectorAll("[data-id]").forEach(b => b.onclick = () => openSchool(b.dataset.id));
  host.querySelectorAll("[data-dsch]").forEach(b => b.onclick = () => openSchool(b.dataset.dsch));
  host.querySelectorAll("[data-drec]").forEach(b => b.onclick = () => openRecord(b.dataset.drec));
  host.querySelectorAll("[data-dres]").forEach(b => b.onclick = () => demoResultMenu(b, { id: Number(b.dataset.dres), time: b.dataset.time }, () => refresh()));
}
