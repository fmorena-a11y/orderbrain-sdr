// Sesiones activas (en Hoy): las sesiones de trabajo guardadas de cada persona, para retomarlas y ver qué se contactó,
// cómo, cuándo y qué falta. Todo lo que se muestra sale de lo que se registró en la app (lib/sessions.js).
import { S, api, esc, icon, toast, modal, ago, shortDay, openMenu, TYPE_ICON } from "./core.js";
import { openSchool, openRecord, resumeSession } from "./school.js";

const CH = { call: ["Llamada", "phone"], whatsapp: ["WhatsApp", "whatsapp"], mail: ["Mail", "mail"], visit: ["Visita", "user"] };
const SKIP = { client: "ya es cliente", churn: "es ex cliente", archived: "está archivado", open: "tiene un trato abierto", owner: "es de otra persona", manual: "lo salteaste", missing: "no se pudo abrir" };
const ORIGIN = { today: "Tu agenda y tu cola", zone: "Zona o evento", agenda: "Agenda con filtros", explore: "Prospectar", radar: "Radar", list: "Lista" };
const END = { terminada: "la terminaste", completa: "se trabajó toda", "reemplazada": "empezaste otra igual", "límite": "había 12 abiertas", inactiva: "30 días sin movimiento", "otro día": "era de otro día" };
// en la tarjeta de Hoy van las más recientes; el resto, en «Ver las N abiertas»
const SHOWN = 2;

let seq = 0;
// La lista trae solo los resúmenes (sin colegios ni pasos). Espera lo que la ficha esté guardando de la sesión
// (la posición al cerrar, la sesión terminada) para no leer algo viejo.
export async function loadSessions() {
  const my = ++seq;
  await Promise.resolve(S.sessSaving).catch(() => {});
  const r = await api("/api/sessions");
  if (my === seq) S.sessions = r;
  return r;
}
// Lo último que respondió el servidor de cada sesión entera, por si después no se puede leer (sin conexión).
const full = new Map();
// Guarda en la lista de Hoy lo último que respondió el servidor de una sesión (sin esperar a releer todo).
export function cacheSession(v) {
  if (!v?.id) return;
  const { items, steps, ...sum } = v;
  if (items) full.set(v.id, v);
  const L = S.sessions || (S.sessions = { open: [], done: [], max: 12 });
  L.open = L.open.filter(x => x.id !== v.id); L.done = L.done.filter(x => x.id !== v.id);
  (sum.status === "open" ? L.open : L.done).push(sum);
  L.open.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}
export const cachedSession = id => full.get(id) || null;
// «hoy 10:20», «ayer 18:05», «lun 3 nov 9:10»
const when = iso => { const d = new Date(iso); return `${shortDay(d.toLocaleDateString("sv"))} ${d.toTimeString().slice(0, 5)}`; };
const pct = st => st.total ? Math.round(st.handled / st.total * 100) : 0;
const bar = (v, cls = "") => `<div class="ss-bar ${cls}"><span class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="${v.stats.total}" aria-valuenow="${v.stats.handled}" aria-label="${v.stats.handled} de ${v.stats.total} trabajados"><span style="width:${pct(v.stats)}%"></span></span><b>${v.stats.handled} de ${v.stats.total}</b><span class="muted">${v.stats.pending ? `faltan ${v.stats.pending}` : "no falta nada"}</span></div>`;

// ---------- tarjeta de Hoy: las 2 más recientes en filas cortas; Ver detalle y Terminar van en el menú «⋯»
const left = st => (st.pending ? `faltan ${st.pending}` : "no falta nada");
export function sessionsCard() {
  const L = S.sessions; if (!L) return "";
  const open = L.open || [], done = L.done || [];
  if (!open.length && !done.length) return "";
  const links = [open.length > SHOWN && `<button class="linkbtn" id="ssAll" data-focus-key="ssAll">Ver las ${open.length} abiertas</button>`,
    done.length && `<button class="linkbtn" id="ssDone" data-focus-key="ssDone">Terminadas (${done.length})</button>`].filter(Boolean);
  return `<section class="card ss-card" aria-labelledby="hSs">
    <div class="card-h"><h2 id="hSs">${icon("play")} Sesiones activas</h2><span class="sub">${open.length ? `${open.length} abierta${open.length > 1 ? "s" : ""}` : "ninguna abierta"}</span></div>
    <div class="card-b">${open.length ? open.slice(0, SHOWN).map(mini).join("") : `<p class="muted ss-empty">No tenés sesiones abiertas.</p>`}
      ${links.length ? `<div class="ss-links">${links.join("")}</div>` : ""}</div>
  </section>`;
}
// nombre, «3 de 61 · faltan 58», lo registrado y cuándo; Retomar y «⋯»
function mini(v) {
  const st = v.stats;
  return `<div class="ss ss-c" data-ss="${esc(v.id)}">
    <div class="ss-t"><b>${esc(v.name)}</b>
      <small><span class="ss-n">${st.handled} de ${st.total} · ${left(st)}</span> · ${esc([v.summary || "sin contactos todavía", ago(v.lastAt)].join(" · "))}</small>
      <span class="progress" aria-hidden="true"><span style="width:${pct(st)}%"></span></span></div>
    <button class="btn primary sm" data-ss-go="${esc(v.id)}" data-focus-key="go-${esc(v.id)}" ${v.resume < 0 ? `disabled title="No falta nada"` : ""} aria-label="Retomar ${esc(v.name)}">${icon("play", "sm")} Retomar</button>
    <button class="icon-btn" data-ss-menu="${esc(v.id)}" data-focus-key="menu-${esc(v.id)}" aria-haspopup="menu" aria-label="Más opciones de ${esc(v.name)}">${icon("dots")}</button>
  </div>`;
}
// la fila completa (en «Ver las N abiertas»)
function row(v) {
  return `<div class="ss" data-ss="${esc(v.id)}">
    <div class="ss-top"><div class="ss-t"><b>${esc(v.name)}</b><small>Empezó ${esc(when(v.createdAt))} · última actividad ${esc(ago(v.lastAt))}</small></div>
      <button class="btn primary sm" data-ss-go="${esc(v.id)}" ${v.resume < 0 ? `disabled title="No falta nada"` : ""}>${icon("play", "sm")} Retomar</button></div>
    ${bar(v)}
    <div class="ss-sum">${v.summary ? esc(v.summary) : `<span class="faint">Todavía sin contactos registrados</span>`}</div>
    <div class="ss-ops"><button class="btn sm" data-ss-see="${esc(v.id)}">${icon("list", "sm")} Ver detalle</button><button class="btn ghost sm" data-ss-end="${esc(v.id)}">Terminar</button></div>
  </div>`;
}
// redraw: redibujar la vista que muestra la tarjeta
export function bindSessionsCard(host, redraw) {
  host.querySelectorAll("[data-ss-go]").forEach(b => b.onclick = () => resumeSession(b.dataset.ssGo));
  host.querySelectorAll("[data-ss-menu]").forEach(b => b.onclick = () => openMenu(b, [
    { label: "Ver detalle", sub: "Qué se contactó, cómo, cuándo y qué falta", fn: () => detail(b.dataset.ssMenu, redraw, b) },
    { label: "Terminar", sub: "Pasa a terminadas", fn: () => endSession(b.dataset.ssMenu, redraw, b) }]));
  host.querySelector("#ssAll")?.addEventListener("click", e => openList(redraw, e.currentTarget));
  host.querySelector("#ssDone")?.addEventListener("click", e => doneList(redraw, e.currentTarget));
}
function openList(redraw, anchor) {
  const L = S.sessions?.open || [];
  const m = modal(`<div class="ss-dh"><h3>Sesiones abiertas</h3><button class="icon-btn" id="olX" aria-label="Cerrar">${icon("x")}</button></div>
    <p class="muted" style="margin:0">Podés tener hasta ${S.sessions?.max || 12}. La más reciente primero.</p>
    <div class="ss-list">${L.map(row).join("")}</div>
    <div class="row"><button class="btn" id="olOk">Cerrar</button></div>`, { onClose: () => anchor?.isConnected && anchor.focus() });
  m.querySelector(".modal-box").classList.add("ss-modal");
  m.querySelector("#olX").onclick = m.querySelector("#olOk").onclick = () => m.close();
  m.querySelectorAll("[data-ss-go]").forEach(b => b.onclick = () => { m.close(); resumeSession(b.dataset.ssGo); });
  m.querySelectorAll("[data-ss-see]").forEach(b => b.onclick = () => { m.close(); detail(b.dataset.ssSee, redraw, anchor); });
  m.querySelectorAll("[data-ss-end]").forEach(b => b.onclick = () => { m.close(); endSession(b.dataset.ssEnd, redraw, anchor); });
}
const find = id => [...(S.sessions?.open || []), ...(S.sessions?.done || [])].find(v => v.id === id);

// ---------- terminar, reabrir, borrar
function endSession(id, redraw, anchor) {
  const v = find(id); if (!v) return;
  const m = modal(`<h3>¿Terminar esta sesión?</h3>
    <p style="margin:0"><b>${esc(v.name)}</b>: ${v.stats.handled} de ${v.stats.total}${v.stats.pending ? `, faltan ${v.stats.pending}` : ""}.</p>
    <p class="muted" style="margin:0">Sale de las activas y queda en terminadas 14 días. Lo registrado en Pipedrive no cambia.</p>
    <div class="row"><button class="btn ghost" id="enNo">Cancelar</button><button class="btn primary" id="enOk">Terminar</button></div>`, { onClose: () => anchor?.isConnected && anchor.focus() });
  m.querySelector("#enNo").onclick = () => m.close();
  m.querySelector("#enOk").onclick = async () => {
    m.close();
    try { const r = await api(`/api/sessions/${encodeURIComponent(id)}`, { method: "PATCH", body: { status: "done" } }); cacheSession(r.session); }
    catch (e) { return toast(e.message, { type: "err" }); }
    toast(`Terminaste «${v.name}»`, { action: { label: "Deshacer", fn: () => reopen(id, redraw) } });
    redraw();
  };
}
async function reopen(id, redraw) {
  try { const r = await api(`/api/sessions/${encodeURIComponent(id)}`, { method: "PATCH", body: { status: "open" } }); cacheSession(r.session); if (r.bumped?.length) await loadSessions(); }
  catch (e) { return toast(e.message, { type: "err" }); }
  redraw();
}
function doneList(redraw, anchor) {
  const L = S.sessions?.done || [];
  const m = modal(`<h3>Sesiones terminadas</h3><p class="muted" style="margin:0">Se guardan 14 días.</p>
    <div class="ss-list">${L.map(v => `<div class="ss" data-ss="${esc(v.id)}"><div class="ss-top"><div class="ss-t"><b>${esc(v.name)}</b><small>Terminó ${esc(when(v.endedAt))}${END[v.endReason] ? ` · ${esc(END[v.endReason])}` : ""}</small></div></div>
      ${bar(v)}<div class="ss-sum">${v.summary ? esc(v.summary) : `<span class="faint">Sin contactos registrados</span>`}</div>
      <div class="ss-ops"><button class="btn sm" data-dsee="${esc(v.id)}">${icon("list", "sm")} Ver detalle</button><button class="btn ghost sm" data-dopen="${esc(v.id)}">Reabrir</button><button class="btn ghost sm" data-ddel="${esc(v.id)}">Borrar</button></div></div>`).join("") || `<p class="muted">No hay sesiones terminadas.</p>`}</div>
    <div class="row"><button class="btn" id="dlX">Cerrar</button></div>`, { onClose: () => anchor?.isConnected && anchor.focus() });
  m.querySelector(".modal-box").classList.add("ss-modal");
  m.querySelector("#dlX").onclick = () => m.close();
  m.querySelectorAll("[data-dsee]").forEach(b => b.onclick = () => { m.close(); detail(b.dataset.dsee, redraw); });
  m.querySelectorAll("[data-dopen]").forEach(b => b.onclick = async () => { m.close(); await reopen(b.dataset.dopen, redraw); });
  m.querySelectorAll("[data-ddel]").forEach(b => b.onclick = async () => {
    if (b.dataset.sure !== "1") { b.dataset.sure = "1"; b.textContent = "¿Seguro? Borrar"; b.classList.add("danger"); return; }
    try { await api(`/api/sessions/${encodeURIComponent(b.dataset.ddel)}`, { method: "DELETE" }); } catch (e) { return toast(e.message, { type: "err" }); }
    S.sessions.done = S.sessions.done.filter(x => x.id !== b.dataset.ddel);
    b.closest(".ss").remove(); redraw();
  });
}

// ---------- detalle: lo trabajado (colegio, cómo, cuándo, resultado, próximo paso), lo salteado y lo que falta
const outcomeLabel = id => (S.outcomes || []).find(o => o.id === id)?.label || id;
const teamName = id => (S.team || []).find(u => Number(u.id) === Number(id))?.name || "";
const lower = t => (t === "WhatsApp" ? t : t.toLowerCase());
function nextText(n) {
  if (!n) return "";
  const who = n.ownerId && Number(n.ownerId) !== Number(S.me.pdUserId) ? teamName(n.ownerId) : "";
  return `próximo: ${lower(S.types[n.type] || "tarea")} ${shortDay(n.date)}${n.time ? ` ${n.time}` : ""}${who ? ` para ${who}` : ""}${n.auto ? " (automático)" : ""}`;
}
// outside: registrado desde la ficha sin la sesión (o desde otra sesión)
function stepText(s) {
  const out = s.outside ? " (fuera de la sesión)" : "";
  if (s.kind === "skip") return `Salteado: ${s.why || SKIP[s.reason] || "sin motivo"} · ${when(s.at)}`;
  if (s.kind === "comment") return ["Comentario", when(s.at) + out, nextText(s.next)].filter(Boolean).join(" · ");
  return [CH[s.channel]?.[0] || "Contacto", outcomeLabel(s.outcome), s.who && `con ${s.who}`, when(s.at) + out, s.demo ? `demo ${shortDay(s.demo.date)}${s.demo.time ? ` ${s.demo.time}` : ""}` : "", nextText(s.next)].filter(Boolean).join(" · ");
}
// Un colegio del detalle. Todo lo que viene de la sesión (nombre, ciudad, motivos) pasa por esc(): la ciudad puede venir
// de la dirección de la organización en Pipedrive. En uno trabajado no se muestran los salteos (lo que vale es lo registrado).
export function itemRow(v, it, i, steps) {
  if (it.state === "worked") steps = steps.filter(s => s.kind !== "skip");
  const last = steps.filter(s => s.kind !== "skip").at(-1) || steps.at(-1);
  const ty = it.state === "worked" && last ? (last.kind === "comment" ? ["", "note"] : [last.outcome === "demo" ? "meeting" : { call: "call", whatsapp: "deadline", mail: "task" }[last.channel] || "", CH[last.channel]?.[1] || "check"])
    : it.state === "skipped" ? ["", "skip"] : [it.type || "", TYPE_ICON[it.type] || "building"];
  const sub = it.state === "pending" ? [it.type && `${S.types[it.type] || "Tarea"} pendiente`, it.city].filter(Boolean).map(esc).join(" · ") || "Sin actividad" : steps.map(stepText).map(esc).join("<br>");
  return `<div class="act ss-it"><span class="ty ${ty[0]}" aria-hidden="true">${icon(ty[1])}</span>
    <button class="t" data-it="${i}" data-st="${it.state}"><b>${esc(it.name || S.byId.get(it.ref)?.name || "Sin nombre")}</b><small>${sub}</small></button>
    ${it.state === "pending" && v.status === "open" && i === v.resume ? `<span class="ops"><span class="tag">Sigue</span></span>` : "<span></span>"}</div>`;
}
const filtersText = o => !o?.filters ? "" : Object.entries(o.filters).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`).join(" · ");
async function detail(id, redraw, anchor) {
  let v = cachedSession(id);
  try { v = (await api(`/api/sessions/${encodeURIComponent(id)}`)).session; cacheSession(v); } catch (e) { if (!v) return toast(e.message, { type: "err" }); }
  const by = new Map(); for (const s of v.steps || []) { if (!by.has(s.ref)) by.set(s.ref, []); by.get(s.ref).push(s); }
  const idx = v.items.map((it, i) => [it, i]), part = st => idx.filter(([it]) => it.state === st);
  const worked = part("worked").sort(([a], [b]) => String(by.get(b.ref).at(-1).at).localeCompare(String(by.get(a.ref).at(-1).at))), skipped = part("skipped"), pending = part("pending");
  const sec = (title, list, max = Infinity) => list.length ? `<div class="sub-h">${title} <span class="n">${list.length}</span></div>${list.slice(0, max).map(([it, i]) => itemRow(v, it, i, by.get(it.ref) || [])).join("")}${list.length > max ? `<button class="btn ghost sm block" id="sdMore">Ver los ${list.length - max} que siguen</button>` : ""}` : "";
  const open = v.status === "open";
  const m = modal(`<div class="ss-dh"><h3>${esc(v.name)}</h3><button class="icon-btn" id="sdX" aria-label="Cerrar">${icon("x")}</button></div>
    <p class="muted" style="margin:0">${esc([`Empezó ${when(v.createdAt)}`, open ? `última actividad ${ago(v.lastAt)}` : `terminó ${when(v.endedAt)}`, ORIGIN[v.origin?.kind], filtersText(v.origin), v.cut && `tomó los primeros ${v.stats.total} de ${v.stats.total + v.cut}`].filter(Boolean).join(" · "))}</p>
    ${bar(v)}
    ${v.summary ? `<p style="margin:0">${esc(v.summary)}</p>` : ""}
    <div class="ss-items">${sec("Trabajados", worked)}${sec("Salteados", skipped)}<div id="sdPend">${sec("Faltan", pending, 20)}</div></div>
    ${open && pending.length ? `<p class="faint" style="margin:0;font-size:12.5px">Tocá uno de los que faltan para seguir la sesión desde ahí.</p>` : ""}
    <div class="row">${open ? `<button class="btn ghost" id="sdEnd">Terminar</button>` : `<button class="btn ghost" id="sdOpen">Reabrir</button>`}${open && v.resume >= 0 ? `<button class="btn primary" id="sdGo">${icon("play", "sm")} Retomar</button>` : ""}</div>`, { onClose: () => anchor?.isConnected && anchor.focus() });
  m.querySelector(".modal-box").classList.add("ss-modal");
  m.querySelector("#sdX").onclick = () => m.close();
  m.querySelector("#sdMore")?.addEventListener("click", () => { m.querySelector("#sdPend").innerHTML = sec("Faltan", pending); bindItems(); });
  m.querySelector("#sdGo")?.addEventListener("click", () => { m.close(); resumeSession(v.id); });
  m.querySelector("#sdEnd")?.addEventListener("click", () => { m.close(); endSession(v.id, redraw, anchor); });
  m.querySelector("#sdOpen")?.addEventListener("click", async () => { m.close(); await reopen(v.id, redraw); });
  // lo que falta (en una sesión abierta) sigue la sesión desde ahí; lo demás abre la ficha sola
  const bindItems = () => m.querySelectorAll("[data-it]").forEach(b => b.onclick = () => {
    const i = Number(b.dataset.it), it = v.items[i]; m.close();
    if (open && b.dataset.st === "pending") return resumeSession(v.id, { at: i });
    if (/^(lead|org):/.test(it.ref)) return openRecord(it.ref);
    if (S.byId.has(it.ref)) return openSchool(it.ref);
    const sid = (by.get(it.ref) || []).find(s => s.schoolId)?.schoolId;
    return sid && S.byId.has(sid) ? openSchool(sid) : toast("No encontré ese colegio en la base.", { type: "err" });
  });
  bindItems();
}
