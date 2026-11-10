// Sesiones de trabajo guardadas («Sesiones activas» de Hoy). Cada persona tiene las suyas, por email: qué colegios
// entraron y en qué orden, por dónde va y qué pasó con cada uno. Lo que se anota sale de lo que se registró de verdad
// en la app (el contacto guardado en Pipedrive, el comentario, el colegio salteado y por qué): nada se deduce ni se completa a mano.
// Las reglas son puras (se prueban en test/sessions.test.mjs); al final van las lecturas y escrituras en lib/store.js.
import crypto from "crypto";
import { readSessionIndex, readSession, readSessionRefs, writeSession, removeSessions, withLock, canonicalId } from "./store.js";
import { TYPE_LABEL } from "./config.js";

// MAX_DONE: terminadas que se guardan (las más recientes); las demás se borran aunque no tengan 14 días
export const MAX_OPEN = 12, MAX_ITEMS = 300, MAX_STEPS = 1000, MAX_DONE = 20;
export const DONE_KEEP_MS = 14 * 864e5, IDLE_MS = 30 * 864e5; // terminadas: 14 días; abiertas sin movimiento: 30 días
// de dónde salió la sesión (el nombre que se ve si no viene otro)
export const ORIGINS = { today: "Tu día", zone: "Zona o evento", agenda: "Tu agenda", explore: "Prospectar", radar: "Nuevos del radar", list: "Lista" };
// por qué se salteó un colegio (lo decide la app al abrirlo, o la persona con «Saltar»)
export const SKIP = { client: "ya es cliente", churn: "es ex cliente", archived: "está archivado", open: "tiene un trato abierto", owner: "es de otra persona", manual: "lo salteaste", missing: "no se pudo abrir" };
// por qué terminó (además de «terminada» a mano y «completa»)
export const END = { replaced: "reemplazada", limit: "límite", idle: "inactiva", otherDay: "otro día" };
export const CHANNELS = ["call", "whatsapp", "mail", "visit"];
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const str = (v, n) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
// colegio de la base (slug), ficha de Pipedrive (pd-…) o tarea de un prospecto u organización fuera de la base (lead:…, org:…)
const REF = /^[\w.:-]{1,140}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/, TIME = /^\d{2}:\d{2}$/;
const iso = ms => new Date(ms).toISOString();

// ---------- armar una sesión
// Los primeros MAX_ITEMS colegios válidos y sin repetir; cut: cuántos quedaron afuera por el tope (se avisa, no se corta en silencio).
export function cleanItems(list, max = MAX_ITEMS) {
  const seen = new Set(), items = [];
  let cut = 0;
  for (const x of Array.isArray(list) ? list : []) {
    const ref = str(x?.ref, 140);
    if (!REF.test(ref) || seen.has(ref)) continue;
    seen.add(ref);
    if (items.length >= max) { cut++; continue; }
    const act = Number(x.act);
    items.push({ ref, act: Number.isInteger(act) && act > 0 ? act : null, type: Object.hasOwn(TYPE_LABEL, x.type) ? x.type : null, name: str(x.name, 120) || null, city: str(x.city, 80) || null });
  }
  return { items, cut };
}
// filtros: lo que eligió la persona (zona, fechas, tipo, territorio). Se guardan tal cual para mostrarlos, con tope de tamaño.
export function cleanOrigin(o) {
  const kind = Object.hasOwn(ORIGINS, o?.kind) ? o.kind : "list";
  let filters = null;
  if (o?.filters && typeof o.filters === "object" && !Array.isArray(o.filters)) {
    const val = v => ["string", "number"].includes(typeof v) ? str(v, 80) : Array.isArray(v) ? v.filter(x => ["string", "number"].includes(typeof x)).slice(0, 20).map(x => str(x, 60)).filter(Boolean) : "";
    const flat = Object.fromEntries(Object.entries(o.filters).slice(0, 12).map(([k, v]) => [str(k, 30), val(v)]).filter(([k, v]) => k && v.length));
    if (Object.keys(flat).length) filters = flat;
  }
  return { kind, key: str(o?.key, 160) || kind, filters };
}
export function newSession(input, now = Date.now(), id = crypto.randomUUID()) {
  const { items, cut } = cleanItems(input?.items);
  if (!items.length) throw bad("No hay colegios para esta sesión.");
  const origin = cleanOrigin(input?.origin), at = iso(now);
  return { id, name: str(input?.name, 80) || ORIGINS[origin.kind], origin, createdAt: at, updatedAt: at, status: "open", pos: 0, items, steps: [], ...(cut ? { cut } : {}) };
}

// ---------- qué pasó con cada colegio
// worked: tiene al menos un contacto o comentario registrado en la sesión; skipped: se salteó (y no se trabajó después).
export function itemStates(sess) {
  const st = new Map();
  for (const s of sess.steps || []) {
    if (s.kind === "contact" || s.kind === "comment") st.set(s.ref, "worked");
    else if (s.kind === "skip" && !st.has(s.ref)) st.set(s.ref, "skipped");
  }
  return st;
}
export const stateOf = (states, ref) => states.get(ref) || "pending";
export const pendingItems = sess => { const st = itemStates(sess); return sess.items.filter(it => stateOf(st, it.ref) === "pending"); };
export function sessionStats(sess) {
  const states = itemStates(sess), byChannel = Object.fromEntries(CHANNELS.map(c => [c, 0]));
  let contacts = 0, demos = 0, comments = 0, connected = 0;
  for (const s of sess.steps || []) {
    if (s.kind === "contact") { contacts++; byChannel[s.channel] = (byChannel[s.channel] || 0) + 1; if (s.outcome === "demo") demos++; if (s.connected) connected++; }
    else if (s.kind === "comment") comments++;
  }
  let worked = 0, skipped = 0;
  for (const it of sess.items) { const v = stateOf(states, it.ref); if (v === "worked") worked++; else if (v === "skipped") skipped++; }
  const total = sess.items.length;
  return { total, worked, skipped, handled: worked + skipped, pending: total - worked - skipped, contacts, connected, demos, comments, byChannel };
}
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
// «8 llamadas · 3 WhatsApp · 1 mail · 2 demos agendadas»: cada contacto registrado cuenta (dos llamadas al mismo colegio son dos)
export function channelSummary(st) {
  const c = st.byChannel || {};
  return [c.call && plural(c.call, "llamada", "llamadas"), c.whatsapp && `${c.whatsapp} WhatsApp`, c.mail && plural(c.mail, "mail", "mails"), c.visit && plural(c.visit, "visita", "visitas"),
    st.demos && plural(st.demos, "demo agendada", "demos agendadas"), st.comments && plural(st.comments, "comentario", "comentarios"), st.skipped && plural(st.skipped, "salteado", "salteados")].filter(Boolean).join(" · ");
}
// Retomar: el colegio donde quedó, o el siguiente sin trabajar ni saltear; si no queda ninguno adelante, el primero que falte. -1: no falta nada.
export function resumeIndex(sess) {
  const st = itemStates(sess), n = sess.items.length, from = Math.min(Math.max(0, Number(sess.pos) || 0), Math.max(0, n - 1));
  for (let k = 0; k < n; k++) { const i = (from + k) % n; if (stateOf(st, sess.items[i].ref) === "pending") return i; }
  return -1;
}
// Lo que manda el servidor: la sesión con el estado de cada colegio, los números y el resumen ya armados.
export function view(sess) {
  const st = itemStates(sess), stats = sessionStats(sess), last = (sess.steps || []).at(-1)?.at;
  return { ...sess, items: sess.items.map(it => ({ ...it, state: stateOf(st, it.ref) })), stats, summary: channelSummary(stats), resume: resumeIndex(sess),
    lastAt: [sess.updatedAt, last].filter(Boolean).sort().at(-1) || sess.createdAt };
}
// Lo que va en la lista (y en el índice guardado): todo menos los colegios y los pasos. El detalle se pide aparte.
export function summaryOf(sess) { const { items, steps, ...v } = view(sess); return v; }

// ---------- cambios
const touch = (sess, now) => { sess.updatedAt = iso(now); };
function push(sess, step, now) {
  if (!sess.items.some(it => it.ref === step.ref)) return false;
  sess.steps = [...(sess.steps || []), { ...step, at: iso(now) }].slice(-MAX_STEPS);
  touch(sess, now);
  return true;
}
const cleanNext = n => n && Object.hasOwn(TYPE_LABEL, n.type) && DAY.test(n.date || "") ? { type: n.type, date: n.date, time: TIME.test(n.time || "") ? n.time : "", ...(Number(n.ownerId) > 0 ? { ownerId: Number(n.ownerId) } : {}), ...(n.auto ? { auto: true } : {}) } : null;
// Contacto registrado (después de guardarlo en Pipedrive): cómo, qué pasó, quién lo registró y el próximo paso o la demo que quedaron agendados.
// who: con quién habló, si lo cargó (nombre y cargo).
export function contactStep(ref, { channel, outcome, connected, next, demo, contact, by, byName, schoolId }) {
  const who = str([str(contact?.name, 60), str(contact?.role, 40) && `(${str(contact.role, 40)})`].filter(Boolean).join(" "), 110);
  return { ref: str(ref, 140), kind: "contact", channel: CHANNELS.includes(channel) ? channel : "call", outcome: str(outcome, 30), connected: !!connected, ...(str(contact?.name, 60) ? { who } : {}),
    next: cleanNext(next), demo: demo && DAY.test(demo.date || "") ? { date: demo.date, time: TIME.test(demo.time || "") ? demo.time : "" } : null,
    by: str(by, 120), byName: str(byName, 80), ...(schoolId && schoolId !== ref ? { schoolId: str(schoolId, 140) } : {}) };
}
// Comentario o tarea sin registrar contacto
export function commentStep(ref, { next, by, byName, schoolId }) {
  return { ref: str(ref, 140), kind: "comment", next: cleanNext(next), by: str(by, 120), byName: str(byName, 80), ...(schoolId && schoolId !== ref ? { schoolId: str(schoolId, 140) } : {}) };
}
// Saltear: solo lo que todavía no se trabajó ni se salteó (un colegio trabajado no pasa a salteado)
export function addSkip(sess, { ref, reason, why }, now = Date.now()) {
  ref = str(ref, 140);
  if (!Object.hasOwn(SKIP, reason) || itemStates(sess).has(ref)) return false;
  return push(sess, { ref, kind: "skip", reason, ...(str(why, 120) ? { why: str(why, 120) } : {}) }, now);
}
export const addStep = (sess, step, now = Date.now()) => push(sess, step, now);
export function finish(sess, reason = "terminada", now = Date.now()) {
  if (sess.status !== "open") return false;
  Object.assign(sess, { status: "done", endedAt: iso(now), endReason: reason });
  return true;
}
// { pos } por dónde va · { skip: { ref, reason, why } } · { status: "done" | "open" } terminar (reason «completa»: se trabajó toda) o reabrir · { name }
export function applyPatch(sess, p, now = Date.now()) {
  let changed = false;
  if (p.pos !== undefined) {
    const pos = Number(p.pos);
    if (!Number.isInteger(pos) || pos < 0 || pos >= sess.items.length) throw bad("Posición inválida.");
    if (pos !== sess.pos) { sess.pos = pos; touch(sess, now); changed = true; }
  }
  if (p.skip) changed = addSkip(sess, p.skip, now) || changed;
  if (p.name !== undefined) { const n = str(p.name, 80); if (!n) throw bad("Poné un nombre."); if (n !== sess.name) { sess.name = n; changed = true; } }
  if (p.status === "done") changed = finish(sess, p.reason === "completa" ? "completa" : "terminada", now) || changed;
  else if (p.status === "open" && sess.status !== "open") { sess.status = "open"; delete sess.endedAt; delete sess.endReason; touch(sess, now); changed = true; }
  else if (p.status !== undefined && !["done", "open"].includes(p.status)) throw bad("Estado inválido.");
  return changed;
}
// «Tu día» de un día anterior (day: la fecha local de hoy, YYYY-MM-DD): ya no es tu día, se termina sola.
const pastDay = (s, day) => !!day && s.origin?.kind === "today" && /^today:\d{4}-\d{2}-\d{2}$/.test(s.origin.key || "") && s.origin.key.slice(6) < day;
// Limpieza al leer (sobre los resúmenes): las terminadas hace más de 14 días se borran y de las demás quedan las MAX_DONE
// más recientes; las abiertas sin movimiento en 30 días y la «Tu día» de otro día pasan a terminadas (changed).
export function prune(list, now = Date.now(), day = null) {
  const drop = [], changed = [], keep = [];
  for (const s of list) {
    if (s.status !== "open" && now - Date.parse(s.endedAt || s.updatedAt) > DONE_KEEP_MS) { drop.push(s.id); continue; }
    if (s.status === "open" && now - Date.parse(s.updatedAt) > IDLE_MS) { finish(s, END.idle, now); changed.push(s); }
    else if (s.status === "open" && pastDay(s, day)) { finish(s, END.otherDay, now); changed.push(s); }
    keep.push(s);
  }
  const done = keep.filter(s => s.status !== "open").sort((a, b) => String(b.endedAt).localeCompare(String(a.endedAt)));
  const extra = new Set(done.slice(MAX_DONE).map(s => s.id));
  return { keep: keep.filter(s => !extra.has(s.id)), drop: [...drop, ...extra], changed: changed.filter(s => !extra.has(s.id)) };
}
// Para abrir una nueva sin pasar el máximo: se terminan las abiertas con menos movimiento.
export function overLimit(list, max = MAX_OPEN) {
  const open = list.filter(s => s.status === "open").sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  return open.slice(0, Math.max(0, open.length - max + 1));
}
const recent = (a, b) => b.updatedAt.localeCompare(a.updatedAt);

// ---------- lecturas y escrituras (Redis o DATA_DIR, lib/store.js)
// Una cola por persona en esta instancia y un candado corto entre instancias: un contacto que se anota mientras otro
// dispositivo mueve la posición no pisa al otro.
const chains = new Map();
function serial(email, fn) {
  const prev = chains.get(email) || Promise.resolve();
  const p = prev.then(() => withLock("sess:" + email, fn));
  const tail = p.catch(() => {}); chains.set(email, tail);
  tail.then(() => { if (chains.get(email) === tail) chains.delete(email); });
  return p;
}
const mail = e => String(e || "").toLowerCase();
// Los colegios del buscador que después trajo el radar con otro id se leen con el id nuevo (el que tiene la base).
const isRec = r => /^(lead|org):/.test(r);
const canonRef = r => (isRec(r) ? r : canonicalId(r));
function canon(s) {
  if (!s) return s;
  s.items = (s.items || []).map(it => ({ ...it, ref: canonRef(it.ref) }));
  s.steps = (s.steps || []).map(st => ({ ...st, ref: canonRef(st.ref) }));
  return s;
}
const getFull = async (email, id) => canon(await readSession(email, id));
// prev: el estado antes del cambio (los colegios de las abiertas van aparte, para anotar lo hecho fuera de la sesión)
const save = (email, s, prev) => writeSession(email, s, summaryOf(s), s.status === "open" ? (prev === "open" ? undefined : s.items.map(it => it.ref)) : prev === "open" ? null : undefined);
async function finishById(email, id, reason, now) {
  const s = await getFull(email, id);
  if (!s) { await removeSessions(email, [id]); return; }
  if (finish(s, reason, now)) await save(email, s, "open");
}
// el índice (resúmenes) ya limpio; lo que hay que terminar se lee entero, se termina y se guarda
async function loadIndex(email, now, day) {
  const { keep, drop, changed } = prune(await readSessionIndex(email), now, day);
  for (const c of changed) {
    const s = await getFull(email, c.id);
    if (!s) { drop.push(c.id); continue; }
    finish(s, c.endReason, now); await save(email, s, "open");
    Object.assign(c, summaryOf(s));
  }
  if (drop.length) await removeSessions(email, drop);
  const gone = new Set(drop);
  return keep.filter(s => !gone.has(s.id));
}
// day: la fecha local de hoy (para terminar la «Tu día» de otro día)
export async function listFor(email, now = Date.now(), day = null) {
  const all = await serial(mail(email), () => loadIndex(mail(email), now, day));
  return { open: all.filter(s => s.status === "open").sort(recent), done: all.filter(s => s.status !== "open").sort((a, b) => String(b.endedAt).localeCompare(String(a.endedAt))), max: MAX_OPEN, maxItems: MAX_ITEMS };
}
export async function getFor(email, id) {
  const s = await getFull(mail(email), String(id));
  if (!s) throw bad("No encontré esa sesión.", 404);
  return view(s);
}
// Nueva sesión. Si ya hay una abierta con el mismo origen (la misma zona, el mismo día…), la devuelve en `existing` sin crear
// otra, para ofrecer retomarla; con `replace` (su id) la termina y empieza de cero. Si se pasa del máximo, termina la más quieta (`bumped`).
// truncated: cuántos colegios quedaron afuera por el tope de MAX_ITEMS.
export async function createFor(email, body, now = Date.now(), day = null) {
  email = mail(email);
  const s = newSession(body, now);
  return serial(email, async () => {
    const open = (await loadIndex(email, now, day)).filter(x => x.status === "open");
    const same = open.find(x => x.origin?.key === s.origin.key && x.id !== body?.replace);
    if (same && !body?.force) { const full = await getFull(email, same.id); if (full) return { existing: view(full) }; await removeSessions(email, [same.id]); }
    const old = body?.replace && open.find(x => x.id === body.replace);
    if (old) await finishById(email, old.id, END.replaced, now);
    const bumped = overLimit(open.filter(x => x.id !== old?.id));
    for (const b of bumped) await finishById(email, b.id, END.limit, now);
    await save(email, s, null);
    return { session: view(s), bumped: bumped.map(b => ({ id: b.id, name: b.name })), ...(s.cut ? { truncated: s.cut } : {}) };
  });
}
export async function updateFor(email, id, patch, now = Date.now()) {
  email = mail(email); id = String(id);
  return serial(email, async () => {
    const s = await getFull(email, id);
    if (!s) throw bad("No encontré esa sesión.", 404);
    const prev = s.status;
    let bumped = [];
    if (patch?.status === "open" && s.status !== "open") {
      bumped = overLimit((await loadIndex(email, now)).filter(x => x.status === "open" && x.id !== id));
      for (const b of bumped) await finishById(email, b.id, END.limit, now);
    }
    if (patch?.skip) patch = { ...patch, skip: { ...patch.skip, ref: canonRef(str(patch.skip.ref, 140)) } };
    if (applyPatch(s, patch || {}, now)) await save(email, s, prev);
    return { session: view(s), bumped: bumped.map(b => ({ id: b.id, name: b.name })) };
  });
}
// Lo llama el servidor después de guardar un contacto o un comentario con { session: { id, ref } }. null si la sesión
// ya no está o ese colegio no es de la sesión (el contacto quedó en Pipedrive igual).
export async function recordFor(email, id, step, now = Date.now()) {
  email = mail(email);
  return serial(email, async () => {
    const s = await getFull(email, String(id));
    if (!s || !addStep(s, { ...step, ref: canonRef(step.ref) }, now)) return null;
    await save(email, s, s.status);
    return view(s);
  });
}
// Los ids con que puede figurar en una sesión el colegio de la ficha (schoolId): el suyo, el de la base si era un alias,
// y lead:…/org:… si es la ficha de un prospecto u organización de Pipedrive (pd-lead-…/pd-org-…).
export function refsFor(schoolId) {
  const id = String(schoolId || ""), out = new Set([id, canonicalId(id)]), m = /^pd-(lead|org)-(.+)$/.exec(id);
  if (m) out.add(`${m[1]}:${m[2]}`);
  out.delete("");
  return out;
}
// Contacto o comentario registrado fuera de una sesión (o dentro de otra, except): se anota con outside en cada sesión
// abierta de esa persona que tiene el colegio, para que cuente como trabajado y se vea qué se hizo. Devuelve sus resúmenes.
export async function recordOutside(email, schoolId, step, { except = null, now = Date.now() } = {}) {
  email = mail(email);
  const want = refsFor(schoolId);
  if (!want.size) return [];
  const hits = (await readSessionRefs(email)).filter(([id, refs]) => id !== except && refs.some(r => want.has(canonRef(r)))).map(([id]) => id);
  if (!hits.length) return [];
  return serial(email, async () => {
    const out = [];
    for (const id of hits) {
      const s = await getFull(email, id);
      const it = s?.status === "open" && s.items.find(x => want.has(x.ref));
      if (!it) continue;
      const { schoolId: _, ...rest } = step;
      if (addStep(s, { ...rest, ref: it.ref, outside: true, ...(schoolId !== it.ref ? { schoolId: str(schoolId, 140) } : {}) }, now)) { await save(email, s, "open"); out.push(summaryOf(s)); }
    }
    return out;
  });
}
export async function deleteFor(email, id) {
  email = mail(email); id = String(id);
  return serial(email, async () => {
    if (!(await readSessionIndex(email)).some(x => x.id === id) && !(await readSession(email, id))) throw bad("No encontré esa sesión.", 404);
    await removeSessions(email, [id]);
    return { ok: true };
  });
}
