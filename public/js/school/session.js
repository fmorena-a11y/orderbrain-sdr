// Ficha del colegio: modo sesión (empezar, avanzar, saltear, guardar la posición, adelantar estudios).
import { S, ago, api, archivedAct, archivedRef, callQueue, cap, esc, icon, localAct, modal, norm, patchSchool, toast, today, workOrder } from "../core.js";
import { D, drawerOpen } from "./state.js";
import { closeSchool, dropPauseToast, leaveSession, openAt, resumeSession } from "./open.js";

// ---------- sesión de llamadas
// Se guarda en el servidor (/api/sessions, lib/sessions.js): sobrevive a recargar la página y se retoma desde otro dispositivo.
// S.session es la que está abierta en la ficha: items (colegios en orden, con su actividad y su estado: pending, worked o
// skipped), steps (lo que pasó con cada uno) e i (por dónde va). ids y acts se derivan de items.
export function useSession(v) {
  return { ...v, items: v.items.map(x => ({ ...x })), steps: [...(v.steps || [])], i: v.pos || 0, ids: v.items.map(x => x.ref), acts: Object.fromEntries(v.items.filter(x => x.act).map(x => [x.ref, x.act])) };
}
export const pendingOf = ss => ss.items.filter(x => x.state === "pending").length;
export const firstPending = ss => { const n = ss.items.length; for (let k = 0; k < n; k++) { const i = (ss.i + k) % n; if (ss.items[i].state === "pending") return i; } return ss.i; };
// lo que responde el servidor: se toma si no es más viejo que lo que ya hay (los pasos solo crecen)
function mergeSession(ss, v) {
  if (!ss || !v || v.id !== ss.id || (v.steps?.length || 0) < (ss.steps?.length || 0)) return;
  const st = new Map(v.items.map(x => [x.ref, x.state]));
  ss.items.forEach(x => { if (st.has(x.ref)) x.state = st.get(x.ref); });
  Object.assign(ss, { steps: [...v.steps], stats: v.stats, summary: v.summary, updatedAt: v.updatedAt, lastAt: v.lastAt, status: v.status });
  import("../sessions.js").then(m => m.cacheSession(v));
}
// Algo registrado en la ficha dentro de la sesión. Si el servidor no lo anotó (sesión sin guardar o falló), se anota acá.
// sr: la sesión y el colegio de cuando se mandó (la ficha pudo cambiar mientras se guardaba)
export function sessionLogged(r, step, sr) {
  // otras sesiones abiertas tuyas con este colegio: el servidor lo anotó ahí como hecho fuera de la sesión
  if (r.sessions?.length) import("../sessions.js").then(m => r.sessions.forEach(m.cacheSession));
  const ss = S.session; if (!ss || !sr || ss.id !== sr.id) return;
  if (r.session) mergeSession(ss, r.session);
  const it = ss.items.find(x => x.ref === sr.ref); if (!it || (r.session && it.state === "worked")) return;
  it.state = "worked"; ss.steps = [...ss.steps, { ref: sr.ref, at: new Date().toISOString(), ...step }];
}
export const sessionRef = () => (S.session && D.sref ? { id: S.session.id, ref: D.sref } : undefined);
// Saltear (cliente, archivado, de otra persona, a mano…): queda anotado con el motivo. Lo ya trabajado no se saltea.
export function markSkip(ss, ref, reason, why = "") {
  const it = ss?.items.find(x => x.ref === ref); if (!it || it.state !== "pending") return;
  it.state = "skipped"; ss.steps = [...ss.steps, { ref, kind: "skip", reason, ...(why ? { why } : {}), at: new Date().toISOString() }];
  if (ss.id) api(`/api/sessions/${ss.id}`, { method: "PATCH", body: { skip: { ref, reason, why } } }).then(r => mergeSession(ss, r.session)).catch(() => {});
}
// Por dónde va: se guarda al moverse (con un respiro, por los salteos seguidos) y al cerrar la ficha.
let posTimer = null, posFor = null;
export function savePos(ss) { if (!ss.id) return; clearTimeout(posTimer); posFor = ss; posTimer = setTimeout(() => flushPos(ss), 400); }
export function flushPos(ss) {
  if (posFor !== ss || !ss.id) return Promise.resolve();
  clearTimeout(posTimer); posFor = null;
  return api(`/api/sessions/${ss.id}`, { method: "PATCH", body: { pos: ss.i } }).then(r => mergeSession(ss, r.session)).catch(() => {});
}
// Sin ids: lo tuyo de hoy primero, después lo vencido y después los mejores prospectos de la cola.
// acts: actividades (con su fecha local) que se trabajan en ese orden; extra: colegios nuevos que van después.
// origin: de dónde salió ({ kind, key, filters }): si ya hay una sesión abierta con el mismo, se ofrece retomarla.
export async function startSession(ids, label = "tu territorio", { acts = null, extra = [], origin = null } = {}) {
  dropPauseToast();
  if (!ids && !acts) {
    if (!S.today) { try { const { loadToday } = await import("../today.js"); await loadToday(); } catch (e) { return toast(e.message, { type: "err" }); } }
    const t = today();
    acts = workOrder((S.today.activities.items || []).map(a => ({ ...a, ...localAct(a) })).filter(a => a.date <= t), t);
    extra = callQueue(S.today.queue).slice(0, 25).map(q => q.id); // en el mismo orden que la lista de Hoy
    label = `Tu día · ${new Intl.DateTimeFormat("es", { weekday: "short", day: "numeric", month: "short" }).format(new Date()).replace(",", "")}`;
    origin = origin || { kind: "today", key: `today:${t}`, filters: S.territory.length ? { territorio: S.territory } : null };
  }
  const items = [], seen = new Set(), add = (ref, a = null, x = null) => {
    if (!ref || seen.has(ref) || archivedRef(ref) || (a && archivedAct(a))) return; // los archivados no entran en ninguna sesión
    seen.add(ref);
    const sc = S.byId.get(ref) || (a?.schoolId && S.byId.get(a.schoolId));
    items.push({ ref, act: a?.id || null, type: a?.type || null, name: sc?.name || x?.name || a?.who || a?.subject || null, city: sc?.city || x?.city || a?.city || null });
  };
  if (acts) { for (const a of acts) add(a.schoolId || a.record, a); for (const id of extra) add(id); }
  // ids: colegios (id) o { ref, name, city } (una base cargada: bx:… no está en S.byId)
  else for (const id of ids || []) typeof id === "object" ? add(id?.ref, null, id) : add(id);
  if (!items.length) return toast("No hay colegios para esta sesión.", { type: "err" });
  // tope de colegios por sesión: se avisa cuántos entran (el servidor guarda hasta S.sessionMax)
  const max = S.sessionMax || 300;
  if (items.length > max) { toast(`La sesión toma los primeros ${max.toLocaleString("es-MX")} de ${items.length.toLocaleString("es-MX")}.`, { type: "info" }); items.length = max; }
  const body = { name: cap(String(label)), origin: origin || { kind: "list", key: `list:${norm(label)}` }, items };
  let r;
  try { r = await api("/api/sessions", { body }); }
  catch (e) {
    // sin servidor la sesión funciona igual en esta pestaña (si recargás, se pierde)
    toast(`No pude guardar la sesión (${e.message}). Funciona igual, pero si recargás la página se pierde.`, { type: "err" });
    return beginSession({ session: { ...body, id: null, pos: 0, steps: [], items: items.map(x => ({ ...x, state: "pending" })) } });
  }
  if (r.existing) return askExisting(r.existing, body);
  beginSession(r);
}
function beginSession(r) {
  if (r.truncated) toast(`La sesión toma los primeros ${r.session.items.length.toLocaleString("es-MX")} de ${(r.session.items.length + r.truncated).toLocaleString("es-MX")}.`, { type: "info" });
  if (r.bumped?.length) toast(`Terminé «${r.bumped.map(b => b.name).join("», «")}», la sesión con menos movimiento: podés tener hasta 12 abiertas.`, { type: "info" });
  if (r.session.id) import("../sessions.js").then(m => m.cacheSession(r.session));
  S.session = useSession(r.session);
  openAt(S.session, 0);
  prefetch();
}
// Ya hay una abierta con el mismo origen (la misma zona, el mismo día…): retomarla o empezar de cero (la vieja queda en terminadas).
function askExisting(v, body) {
  const st = v.stats, m = modal(`<h3>Ya tenés esta sesión abierta</h3>
    <p style="margin:0"><b>${esc(v.name)}</b>: ${st.handled} de ${st.total} · faltan ${st.pending} · última actividad ${esc(ago(v.lastAt))}.</p>
    ${v.summary ? `<p class="muted" style="margin:0">${esc(v.summary)}</p>` : ""}
    <p class="muted" style="margin:0">Si empezás de cero, la anterior queda en terminadas.</p>
    <div class="row"><button class="btn ghost" id="exNo">Cancelar</button><button class="btn" id="exNew">Empezar de cero</button><button class="btn primary" id="exGo" ${v.resume < 0 ? "disabled" : ""}>${icon("play", "sm")} Retomarla</button></div>`);
  m.querySelector("#exNo").onclick = () => m.close();
  m.querySelector("#exGo").onclick = () => { m.close(); resumeSession(v.id); };
  m.querySelector("#exNew").onclick = async () => {
    m.close();
    try { beginSession(await api("/api/sessions", { body: { ...body, replace: v.id } })); } catch (e) { toast(e.message, { type: "err" }); }
  };
}
// Avanza al próximo colegio sin trabajar ni saltear (para atrás, al anterior, sea cual sea). Al final, cierra la ficha.
export function sessionGo(delta) {
  const ss = S.session; if (!ss) return;
  let i = ss.i + delta;
  if (delta > 0) while (i < ss.ids.length && ss.items[i].state !== "pending") i++;
  if (i >= ss.ids.length) {
    if (drawerOpen()) return closeSchool();
    // se salteó lo último sin llegar a abrir la ficha (por ejemplo, un colegio que ya no está)
    S.session = null; leaveSession(ss);
    return import("../app.js").then(m => ["hoy", "sesiones"].includes(S.view) && m.rerender());
  }
  if (i < 0) return;
  openAt(ss, i);
  prefetch();
}
// «Saltar» a mano: lo que ya se trabajó no queda como salteado
export function skipCurrent() { const ss = S.session; if (ss) markSkip(ss, ss.ids[ss.i], "manual"); sessionGo(1); }
// Estudio adelantado (pedido del líder: «cuando creás una sesión, investigá todos los colegios; no esperes a que salte»):
// apenas empieza o se retoma una sesión, se piden los estudios de todos los colegios que faltan, de a 2 a la vez, en el
// orden de la sesión. El servidor no repite uno que ya existe ni uno que se está haciendo (studying + withLock), así que
// cuando abrís la ficha el estudio ya está o ya va por la mitad. Sin IA en el servidor (enabled: false) no se pide nada.
// Revisa en Pipedrive los próximos colegios de la sesión para no perder tiempo con clientes.
export function prefetch() {
  const ss = S.session; if (!ss) return;
  // los estudios ya NO se adelantan: usan IA paga y solo se hacen con el botón de la ficha (prefetchStudies queda sin usar)
  const ids = ss.ids.slice(ss.i + 1, ss.i + 5).filter(id => ["unk", "new"].includes(S.byId.get(id)?.status));
  if (!ids.length) return;
  api("/api/check", { body: { ids } }).then(r => {
    Object.values(r).forEach(v => !v.error && patchSchool(v));
    if (S.session !== ss) return;
    // solo lo que está adelante de donde va ahora: el colegio abierto lo decide load() con su ficha (si la ficha ya se movió
    // a uno de estos, anotarlo acá lo dejaría abierto y marcado). Con tarea tuya y trato abierto tampoco: load() mira de quién es.
    for (const [id, v] of Object.entries(r)) { const why = !v.error && ss.ids.indexOf(id) > ss.i && skipReason(v, !!ss.acts[id], dealsSession(ss)); if (why) markSkip(ss, id, why.code, why.text); }
  }).catch(() => {});
}

// En una sesión de llamadas no se llama a clientes, ex clientes, tratos abiertos ni organizaciones de otra persona.
// El trato abierto solo no se saltea si el colegio entró por una tarea tuya y el trato es tuyo (si no se sabe de quién es, se saltea).
export const myDeal = m => m?.openDealOwnerId ? m.openDealOwnerId === S.me.pdUserId : !!(m?.openDealOwner && S.me.pdName && m.openDealOwner === S.me.pdName);
// Sesión «Tus tratos» (origen deals, el Hoy del account): cada colegio entró por un trato abierto tuyo, así que no se saltea
// por tener trato, por ser cliente (una venta nueva a un cliente) ni porque la organización sea de quien lo prospectó.
export const dealsSession = ss => ss?.origin?.kind === "deals";
export function skipReason(v, mine = false, deals = false) {
  if (deals) return v.status === "archived" ? { code: "archived", text: "está archivado" } : null;
  if (v.status === "client") return { code: "client", text: "ya es cliente" };
  if (v.status === "churn") return { code: "churn", text: "es ex cliente" };
  if (v.status === "archived") return { code: "archived", text: "está archivado" };
  if (v.status === "open" && !mine) return { code: "open", text: "tiene un trato abierto" };
  if (v.ownerId && S.me.pdUserId && v.ownerId !== S.me.pdUserId) return { code: "owner", text: `es de ${v.ownerName || "otra persona"}` };
  return null;
}
