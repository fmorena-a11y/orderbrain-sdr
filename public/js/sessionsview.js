// Sesiones (#/sesiones): el espacio dedicado a las sesiones de trabajo (pedido del líder de SDR: «un espacio nuevo que se
// dedique solo a sesiones», con las de hoy, las activas y las inactivas, y crear, borrar, cambiar o modificar).
// Cada uno ve SOLO las suyas (lib/sessions.js, por email). Secciones (reglas puras en sessgroups.js): «De hoy», «Activas»,
// «Inactivas» (abiertas sin movimiento hace 3 días o más) y «Terminadas» (el servidor las guarda 14 días).
// Acciones: Retomar (cambiar de sesión = retomar otra), Ver detalle, Editar (nombre y sacar colegios que faltan:
// PATCH { name, remove }), Terminar, Reabrir (con 12 abiertas el servidor termina la más quieta y se avisa) y Borrar
// (lo registrado en Pipedrive no se borra). «Nueva sesión» ofrece solo los orígenes que el servidor conoce (ORIGINS).
import { S, api, esc, icon, toast, modal, ago, openMenu, loadPref, save, homeMode, fmtNum, emptyState } from "./core.js";
import { resumeSession, startSession } from "./school.js";
import { loadSessions, cacheSession, forgetSession, sessionDetail, endSession, reopenSession, ORIGIN, END, bar, when, filtersText } from "./sessions.js";
import { sessionGroups, idleDays, isIdle, INACTIVE_DAYS, TABS } from "./sessgroups.js";

let host = null, err = null;
const tabOf = () => { const t = loadPref("sessions.tab", "activas"); return TABS.some(([k]) => k === t) ? t : "activas"; };
const HELP = {
  hoy: "Abiertas que se movieron hoy o que empezaste hoy.",
  activas: "Todas las abiertas, la más reciente primero.",
  inactivas: `Abiertas sin movimiento hace ${INACTIVE_DAYS} días o más (ningún contacto, comentario ni salteo). A los 30 días sin movimiento se terminan solas.`,
  terminadas: "Se guardan 14 días (como mucho 20). Podés reabrirlas o borrarlas.",
};
const EMPTY = {
  hoy: "Hoy todavía no trabajaste ninguna sesión.",
  activas: "No tenés sesiones abiertas.",
  inactivas: `Ninguna abierta lleva ${INACTIVE_DAYS} días o más sin movimiento.`,
  terminadas: "No hay sesiones terminadas.",
};
const sid = id => encodeURIComponent(id);
const plural = (n, one, many) => `${fmtNum(n)} ${n === 1 ? one : many}`;

export function renderSessionsView(el) {
  host = el; err = null;
  draw();
  load();
}
async function load() {
  try { await loadSessions(); err = null; } catch (e) { err = e.message; }
  draw();
}
const redraw = () => draw();

// ---------- pantalla
function draw() {
  if (!host?.isConnected) return;
  const focusKey = document.activeElement?.dataset?.focusKey;
  const L = S.sessions, tab = tabOf();
  const head = `<div class="page-head"><div><h1>Sesiones</h1><p>Tus sesiones de trabajo: retomá una, cambiala o empezá otra. Solo vos ves las tuyas.</p></div>
    <div class="sv-head"><button class="btn sm" id="svRefresh" data-focus-key="svRefresh" title="Volver a leer tus sesiones">${icon("refresh", "sm")} Actualizar</button>
      <button class="btn primary" id="svNew" data-focus-key="svNew" aria-haspopup="menu">${icon("plus", "sm")} Nueva sesión</button></div></div>`;
  if (!L) {
    host.innerHTML = `<div class="page read sv">${head}${err ? `<div class="callout err">${icon("alert")}<span>No pudimos leer tus sesiones: ${esc(err)}</span><button class="btn sm" id="svRetry">Reintentar</button></div>` : '<div class="skel" style="margin:12px 0"></div>'.repeat(4)}</div>`;
    bindHead();
    host.querySelector("#svRetry")?.addEventListener("click", () => { err = null; draw(); load(); });
    return;
  }
  const G = sessionGroups(L), list = G[tab], max = L.max || 12;
  host.innerHTML = `<div class="page read sv">${head}
    ${err ? `<div class="callout warn" style="margin-bottom:12px">${icon("alert")}<span>No pude actualizar la lista (${esc(err)}): ves lo último que leí.</span></div>` : ""}
    <div class="chips sv-tabs" role="group" aria-label="Qué sesiones ver">${TABS.map(([k, l]) => `<button class="chip" data-tab="${k}" data-focus-key="tab-${k}" aria-pressed="${k === tab}">${l} <b>${G[k].length}</b></button>`).join("")}</div>
    <p class="muted sv-help">${esc(HELP[tab])}${tab === "activas" || tab === "hoy" ? ` Podés tener hasta ${max} abiertas.` : ""}</p>
    ${list.length ? `<div class="sv-list">${list.map(row).join("")}</div>`
      : emptyState({ icon: "play", title: EMPTY[tab], action: tab === "terminadas" || tab === "inactivas" ? null : { label: "Nueva sesión", id: "svNew2", icon: "plus", cls: "btn primary sm", attrs: 'aria-haspopup="menu"' } })}
  </div>`;
  bindHead();
  host.querySelectorAll("[data-tab]").forEach(b => b.onclick = () => { save("sessions.tab", b.dataset.tab); draw(); host.querySelector(`[data-tab="${b.dataset.tab}"]`)?.focus(); });
  host.querySelector("#svNew2")?.addEventListener("click", e => newMenu(e.currentTarget));
  host.querySelectorAll("[data-go]").forEach(b => b.onclick = () => resumeSession(b.dataset.go));
  host.querySelectorAll("[data-see]").forEach(b => b.onclick = () => sessionDetail(b.dataset.see, redraw, b));
  host.querySelectorAll("[data-edit]").forEach(b => b.onclick = () => editSession(b.dataset.edit, b));
  host.querySelectorAll("[data-reopen]").forEach(b => b.onclick = async () => { b.disabled = true; await reopenSession(b.dataset.reopen, redraw); if (b.isConnected) b.disabled = false; });
  host.querySelectorAll("[data-del]").forEach(b => b.onclick = () => deleteSession(b.dataset.del, b));
  host.querySelectorAll("[data-more]").forEach(b => b.onclick = () => openMenu(b, [
    { label: "Terminar", sub: "Pasa a terminadas (14 días)", fn: () => endSession(b.dataset.more, redraw, b) },
    { label: "Borrar", sub: "Lo registrado en Pipedrive queda", fn: () => deleteSession(b.dataset.more, b) }]));
  if (focusKey) host.querySelector(`[data-focus-key="${focusKey}"]`)?.focus();
}
function bindHead() {
  host.querySelector("#svRefresh").onclick = () => load();
  host.querySelector("#svNew").onclick = e => newMenu(e.currentTarget);
}

// nombre, de dónde salió, avance, lo registrado, cuándo se movió (o cuándo y por qué terminó) y las acciones
function row(v) {
  const open = v.status === "open", idle = open && isIdle(v), id = esc(v.id), n = esc(v.name);
  const origin = [ORIGIN[v.origin?.kind], filtersText(v.origin)].filter(Boolean).join(" · ");
  const meta = open ? `Última actividad ${ago(v.lastAt)} · empezó ${when(v.createdAt)}`
    : `Terminó ${when(v.endedAt)}${END[v.endReason] ? ` · ${END[v.endReason]}` : ""}`;
  return `<article class="card sv-row${idle ? " idle" : ""}" data-ss="${id}" aria-label="${n}">
    <div class="sv-top"><div class="ss-t"><b>${n}</b>${origin ? `<small>${esc(origin)}</small>` : ""}</div>
      ${idle ? `<span class="tag sv-idle" title="Sin contactos, comentarios ni salteos">${icon("clock", "sm")} ${idleDays(v)} días sin movimiento</span>` : ""}</div>
    ${bar(v)}
    <div class="ss-sum">${v.summary ? esc(v.summary) : `<span class="faint">${open ? "Todavía sin contactos registrados" : "Sin contactos registrados"}</span>`}</div>
    <div class="sv-meta">${esc(meta)}${v.cut ? ` · ${esc(`tomó los primeros ${v.stats.total} de ${v.stats.total + v.cut}`)}` : ""}</div>
    <div class="ss-ops">${open ? `<button class="btn primary sm" data-go="${id}" data-focus-key="go-${id}" ${v.resume < 0 ? `disabled title="No falta nada"` : ""} aria-label="Retomar ${n}">${icon("play", "sm")} Retomar</button>` : ""}
      <button class="btn sm" data-see="${id}" data-focus-key="see-${id}" aria-label="Ver detalle de ${n}">${icon("list", "sm")} Ver detalle</button>
      <button class="btn sm" data-edit="${id}" data-focus-key="edit-${id}" aria-label="Editar ${n}">Editar</button>
      ${open ? `<button class="icon-btn" data-more="${id}" data-focus-key="more-${id}" aria-haspopup="menu" aria-label="Más opciones de ${n}">${icon("dots")}</button>`
        : `<button class="btn sm" data-reopen="${id}" data-focus-key="reopen-${id}" aria-label="Reabrir ${n}">Reabrir</button><button class="btn ghost sm danger-t" data-del="${id}" data-focus-key="del-${id}" aria-label="Borrar ${n}">Borrar</button>`}</div>
  </article>`;
}
const find = id => [...(S.sessions?.open || []), ...(S.sessions?.done || [])].find(v => v.id === id);

// ---------- nueva sesión: los orígenes que ya existen (lib/sessions.js ORIGINS). Las que salen de una lista (Prospectar,
// agenda, radar, base) se arman allá, con sus filtros: se va a esa vista.
function newMenu(anchor) {
  const to = view => () => { location.hash = "#/" + view; };
  // un account (o un líder que eligió «Mis tratos» en Hoy): primero la sesión de sus tratos que piden atención (aehome.js)
  const deals = homeMode() === "ae" ? [{ label: "Tus tratos", sub: "Los tratos que piden atención: sin próximo paso, con algo vencido o quietos, del más urgente al menos", fn: () => import("./aehome.js").then(m => m.startDealsSession()).catch(e => toast(e.message, { type: "err" })) }] : [];
  openMenu(anchor, [...deals,
    { label: "Tu día", sub: "Tu agenda de hoy, lo vencido y los mejores colegios de tu cola", fn: () => startSession() },
    { label: "Una zona o evento", sub: "Puebla, Pachuca, EduExperience…: lo tuyo de ahí y los colegios nuevos", fn: () => zone(anchor) },
    { label: "Desde tu agenda", sub: "Filtrá la agenda y tocá «Trabajar estos colegios»", fn: to("agenda") },
    { label: "Desde Prospectar", sub: "Elegí una ciudad o una lista y tocá «Llamar a…»", fn: to("prospectar") },
    { label: "Nuevos del radar", sub: "Los colegios nuevos de la semana con teléfono", fn: to("radar") },
    { label: "Desde una base cargada", sub: "Abrí una base y tocá «Trabajar esta base»", fn: to("base") },
  ]);
}
// la zona usa tus actividades de Hoy: si todavía no se leyeron, se leen antes
async function zone(anchor) {
  const t = await import("./today.js");
  if (!S.today) { try { await t.loadToday(); } catch (e) { toast(`No pude leer tu agenda (${e.message}): van solo los colegios nuevos.`, { type: "err" }); } }
  t.zoneSession({ anchor });
}

// ---------- editar: el nombre y, en una abierta, sacar colegios que faltan (lo trabajado o salteado queda)
async function editSession(id, anchor) {
  let v = find(id); if (!v) return;
  const open = v.status === "open";
  let pend = [];
  if (open) {
    try { v = (await api(`/api/sessions/${sid(id)}`)).session; cacheSession(v); } catch (e) { return toast(e.message, { type: "err" }); }
    pend = v.items.map((it, i) => ({ it, i })).filter(x => x.it.state === "pending");
  }
  const done = v.items ? v.items.length - pend.length : v.stats.handled;
  const m = modal(`<div class="ss-dh"><h3>Editar sesión</h3><button class="icon-btn" id="seX" aria-label="Cerrar">${icon("x")}</button></div>
    <label class="field"><span>Nombre</span><input class="inp" id="seName" maxlength="80" value="${esc(v.name)}" autocomplete="off"></label>
    ${open ? pend.length ? `<div class="field"><span>Sacar colegios que faltan <span class="faint" style="font-weight:500">(${pend.length})</span></span>
        <small class="faint">Marcá los que no vas a trabajar. ${done ? `Los ${done} que ya trabajaste o salteaste quedan.` : ""}</small>
        <div class="se-list" role="group" aria-label="Colegios que faltan">${pend.map(({ it }) => `<label class="se-it"><input type="checkbox" value="${esc(it.ref)}"><span><b>${esc(it.name || S.byId.get(it.ref)?.name || "Sin nombre")}</b>${[it.city, it.type && `${S.types?.[it.type] || "Tarea"} pendiente`].filter(Boolean).length ? `<small>${esc([it.city, it.type && `${S.types?.[it.type] || "Tarea"} pendiente`].filter(Boolean).join(" · "))}</small>` : ""}</span></label>`).join("")}</div></div>`
      : `<p class="muted" style="margin:0">No falta ningún colegio: no hay nada para sacar.</p>`
      : `<p class="muted" style="margin:0">Para sacar colegios, reabrila.</p>`}
    <p class="err" id="seErr" role="alert" style="margin:0;color:var(--err)"></p>
    <div class="row"><button class="btn ghost" id="seNo">Cancelar</button><button class="btn primary" id="seOk">Guardar</button></div>`, { onClose: () => anchor?.isConnected && anchor.focus() });
  m.querySelector(".modal-box").classList.add("ss-modal");
  const ok = m.querySelector("#seOk"), boxes = [...m.querySelectorAll(".se-list input")], errEl = m.querySelector("#seErr");
  const picked = () => boxes.filter(b => b.checked).map(b => b.value);
  const label = () => {
    const n = picked().length, all = n && n === pend.length && !done;
    ok.textContent = n ? `Sacar ${n} y guardar` : "Guardar";
    ok.disabled = !!all;
    errEl.textContent = all ? "No podés sacar todos: si no la vas a usar, borrala." : "";
  };
  boxes.forEach(b => b.addEventListener("change", label));
  m.querySelector("#seX").onclick = m.querySelector("#seNo").onclick = () => m.close();
  ok.onclick = async () => {
    const name = m.querySelector("#seName").value.trim(), remove = picked(), body = {};
    if (!name) { errEl.textContent = "Poné un nombre."; return m.querySelector("#seName").focus(); }
    if (name !== v.name) body.name = name;
    if (remove.length) body.remove = remove;
    if (!Object.keys(body).length) return m.close();
    ok.disabled = true; ok.textContent = "Guardando…";
    let r;
    try { r = await api(`/api/sessions/${sid(id)}`, { method: "PATCH", body }); }
    catch (e) { errEl.textContent = e.message; ok.disabled = false; return label(); }
    cacheSession(r.session); m.close();
    // otro dispositivo pudo trabajar alguno mientras tanto: esos no se sacan
    const kept = remove.length - (r.removed || 0);
    toast([body.name && "Nombre cambiado", r.removed && `saqué ${plural(r.removed, "colegio", "colegios")}`, kept > 0 && `${plural(kept, "quedó porque ya lo trabajaste", "quedaron porque ya los trabajaste")}`].filter(Boolean).join(" · ").replace(/^./, c => c.toUpperCase()) || "Sin cambios");
    draw();
  };
  label();
}

// ---------- borrar (con confirmación: cuántos colegios tenía y que Pipedrive no cambia)
function deleteSession(id, anchor) {
  const v = find(id); if (!v) return;
  const st = v.stats;
  const m = modal(`<h3>¿Borrar esta sesión?</h3>
    <p style="margin:0"><b>${esc(v.name)}</b>: ${plural(st.total, "colegio", "colegios")}${st.handled ? `, ${st.handled} trabajados o salteados` : ""}${v.status === "open" && st.pending ? `, faltan ${st.pending}` : ""}.</p>
    <p class="muted" style="margin:0">Se borra de la app la lista y lo que anotaste en ella. Lo que registraste en Pipedrive (llamadas, notas, actividades) no se borra.</p>
    <div class="row"><button class="btn ghost" id="sdlNo">Cancelar</button><button class="btn danger" id="sdlOk">Borrar</button></div>`, { onClose: () => anchor?.isConnected && anchor.focus() });
  m.querySelector("#sdlNo").onclick = () => m.close();
  m.querySelector("#sdlOk").onclick = async () => {
    const b = m.querySelector("#sdlOk"); b.disabled = true; b.textContent = "Borrando…";
    try { await api(`/api/sessions/${sid(id)}`, { method: "DELETE" }); }
    catch (e) {
      if (e.status !== 404) { b.disabled = false; b.textContent = "Borrar"; return toast(e.message, { type: "err" }); }
    }
    if (S.session?.id === id) S.session.id = null; // si se estaba trabajando, sigue en esta pestaña sin guardarse
    forgetSession(id); m.close();
    toast(`Borraste «${v.name}»`);
    draw();
  };
}
