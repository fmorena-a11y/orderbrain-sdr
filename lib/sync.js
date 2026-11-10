// Sincronización masiva colegios ↔ Pipedrive: cruza TODA la base con las mismas reglas que checkSchool
// (lib/sales.js), pero sin una búsqueda por colegio: lee todas las organizaciones y todos los tratos de a páginas.
//
// Por qué así: cada página de Pipedrive se guarda tal cual (compacta, por id) en dos hashes de Redis y el cruce se
// calcula al final en memoria, de una sola pasada. Guardar «el mejor candidato por colegio» página a página obligaría
// a leer y reescribir miles de campos por página (con «san», «santa», «maría»… una organización compite con miles de
// colegios) y un corte a mitad dejaría mezclas; así cada paso es idempotente (repetir una página la vuelve a escribir
// igual) y el cierre se puede recalcular entero en cada paso. Lo guardado sirve de foto para las incrementales:
// cada día solo se traen las organizaciones y los tratos cambiados y se recalcula todo.
//
// Fases: orgs (v2 /organizations, cursor) → deals (v2 /deals, cursor) → match (setMatch de cada colegio, por id).
// Estado del trabajo en Redis (sync:state); sin Redis, en memoria. Solo lee de Pipedrive.
import * as pd from "./pipedrive.js";
import { schools, getMatch, setMatches, isFresh, kv, key, kvEnabled, sync as storeSync } from "./store.js";

export const FLOOR = 0;              // sin piso: compiten las mismas que en la búsqueda (pd.eligible), como findOrgCandidates
export const TOP = 6;                // como findOrgCandidates
const HOUR = 3600e3;
const REFRESH_MS = 3 * 864e5;        // un cruce igual se reescribe igual si tiene más de 3 días (vence a los 7)
const FULL_EVERY = 30 * 864e5;       // la automática rehace todo desde cero si la última completa tiene más de 30 días
const iso = ms => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");

// ---------- lógica pura (probada en test/sync.test.mjs)
// Candidatos de cada colegio entre todas las organizaciones, con el puntaje de findOrgCandidates (pd.scoreTokens).
// Compiten las mismas que en la búsqueda (pd.eligible) y se ordenan igual (pd.candBefore). Se guardan los TOP desde FLOOR.
export function candidatesFor(list, orgs, { floor = FLOOR, top = TOP } = {}) {
  const A = list.map(s => pd.tokens(s.name)), C = list.map(pd.cityWord), idx = new Map();
  // pd.eligible exige siempre la primera palabra del colegio: basta indexar cada colegio por esa
  A.forEach((a, i) => { if (!a.length) return; let l = idx.get(a[0]); if (!l) idx.set(a[0], l = []); l.push(i); });
  const out = list.map(() => []), stamp = new Int32Array(list.length).fill(-1);
  let k = 0;
  for (const o of orgs.values ? orgs.values() : orgs) {
    k++;
    const b = new Set(pd.tokens(o.name));
    for (const t of b) for (const i of idx.get(t) || []) {
      if (stamp[i] === k) continue; stamp[i] = k;
      if (!pd.eligible(A[i], b)) continue;
      const score = pd.scoreTokens(A[i], b, C[i]);
      if (score < floor) continue;
      const c = { id: o.id, name: o.name, ownerId: o.ownerId ?? null, score, extra: pd.extraWords(A[i], b, C[i]) }, l = out[i];
      if (l.length >= top && !pd.candBefore(c, l[top - 1])) continue;
      let j = l.length; while (j > 0 && pd.candBefore(c, l[j - 1])) j--;
      l.splice(j, 0, c);
      if (l.length > top) l.pop();
    }
  }
  return out.map(l => l.map(({ extra, ...c }) => c));
}
const sameRec = (cur, rec) => Object.keys(rec).every(k => k === "via" || JSON.stringify(cur[k] ?? null) === JSON.stringify(rec[k] ?? null));
// Qué hacer con un colegio: { rec } para guardar, { same } si no cambió y está al día, { skip } para no tocarlo.
// Mismas reglas que checkSchool: un cruce confirmado (a mano, o por puntaje ≥ SURE) mantiene su organización y solo
// se recalcula con sus tratos; si no, se elige el mejor candidato desde PICK.
// No se pisa: lo que revisó una ficha hace menos de 1 hora (o después de empezada esta sincronización),
// el «no es esta organización» vigente, ni un cruce confirmado cuya organización no está en la foto.
export function decideMatch({ cur, fresh, cands = [], orgs, dealsBy, m, now = Date.now(), startedAt }) {
  if (cur && cur.via !== "sync") {
    const at = Date.parse(cur.checkedAt) || 0;
    if (at > Math.min(now - HOUR, Date.parse(startedAt) || now)) return { skip: "recent" };
    if (cur.unlinked && fresh) return { skip: "unlinked" };
  }
  if (cur?.status === "lead") return { skip: "lead" };
  let rec;
  if (cur?.confirmed && cur.orgId) {
    const o = orgs.get(Number(cur.orgId));
    if (!o) return { skip: "missing" };
    rec = pd.matchRecord({ chosen: { id: o.id, name: cur.orgName || o.name, score: 1 }, deals: dealsBy.get(o.id) || [], m, ownerId: o.ownerId || null, confirmed: true, candidates: [], cur });
  } else {
    const chosen = pd.pickOrg(cands);
    rec = chosen ? pd.matchRecord({ chosen, deals: dealsBy.get(chosen.id) || [], m, ownerId: chosen.ownerId || null, confirmed: chosen.score >= pd.SURE, candidates: cands, cur })
      : pd.noMatchRecord(cands);
  }
  rec.via = "sync";
  if (cur && fresh && sameRec(cur, rec) && now - (Date.parse(cur.checkedAt) || 0) < REFRESH_MS) return { same: true };
  return { rec };
}

// ---------- guardado (Redis o memoria)
const mem = { state: null, hashes: new Map(), lock: false };
const H = (gen, kind) => key(`sync:${gen}:${kind}`);
async function hset(name, entries) {
  if (!entries.length) return;
  if (!kvEnabled) { let h = mem.hashes.get(name); if (!h) mem.hashes.set(name, h = new Map()); for (const [k, v] of entries) h.set(String(k), v); return; }
  for (let i = 0; i < entries.length;) {
    const args = []; let bytes = 0;
    while (i < entries.length && (bytes < 300e3 || !args.length)) { args.push(String(entries[i][0]), entries[i][1]); bytes += entries[i][1].length + 12; i++; }
    await kv([["HSET", name, ...args]]);
  }
}
async function hdel(name, ids) {
  if (!ids.length) return;
  if (!kvEnabled) { const h = mem.hashes.get(name); ids.forEach(id => h?.delete(String(id))); return; }
  for (let i = 0; i < ids.length; i += 1000) await kv([["HDEL", name, ...ids.slice(i, i + 1000).map(String)]]);
}
async function hall(name) {
  if (!kvEnabled) return new Map(mem.hashes.get(name) || []);
  const out = new Map(); let cursor = "0";
  do {
    const [[next, arr]] = await kv([["HSCAN", name, cursor, "COUNT", "5000"]]);
    for (let i = 0; i < (arr || []).length; i += 2) out.set(arr[i], arr[i + 1]);
    cursor = String(next);
  } while (cursor !== "0");
  return out;
}
async function drop(names) {
  if (!kvEnabled) { names.forEach(n => mem.hashes.delete(n)); return; }
  await kv([["DEL", ...names]]);
}
async function loadState() {
  if (!kvEnabled) return mem.state ? structuredClone(mem.state) : {};
  const [v] = await kv([["GET", key("sync:state")]]);
  try { return v ? JSON.parse(v) : {}; } catch { return {}; }
}
async function saveState(st) {
  if (!kvEnabled) { mem.state = structuredClone(st); return; }
  await kv([["SET", key("sync:state"), JSON.stringify(st)]]);
}
// un solo paso a la vez entre todas las instancias (el líder desde Equipo y el cron)
async function takeLock(ttlMs) {
  if (!kvEnabled) { if (mem.lock) return null; mem.lock = true; return "mem"; }
  const tok = Math.random().toString(36).slice(2);
  const [r] = await kv([["SET", key("sync:lock"), tok, "NX", "PX", String(Math.round(ttlMs))]]);
  return r === "OK" ? tok : null;
}
async function releaseLock(tok) {
  if (!kvEnabled) { mem.lock = false; return; }
  try { const [v] = await kv([["GET", key("sync:lock")]]); if (v === tok) await kv([["DEL", key("sync:lock")]]); } catch {}
}

// ---------- foto de Pipedrive (organizaciones y tratos guardados) en memoria de esta instancia
let snap = null;
async function snapshot(j) {
  const sig = `${j.gen}|${j.startedAt}`;
  if (snap?.sig === sig) return snap;
  const [o, d] = await Promise.all([hall(H(j.gen, "o")), hall(H(j.gen, "d"))]);
  const orgs = new Map(), dealsBy = new Map();
  for (const [id, v] of o) { try { const [name, ownerId] = JSON.parse(v); orgs.set(Number(id), { id: Number(id), name, ownerId: ownerId || null }); } catch {} }
  for (const [id, v] of d) {
    try {
      const [org_id, status, pipeline_id, stage_id, owner_id, lost_reason, lost_time, update_time] = JSON.parse(v);
      if (!dealsBy.has(org_id)) dealsBy.set(org_id, []);
      dealsBy.get(org_id).push({ id: Number(id), org_id, status, pipeline_id, stage_id, owner_id, lost_reason, lost_time, update_time });
    } catch {}
  }
  // el mismo orden que dealsForOrg (v2 /deals por id)
  for (const l of dealsBy.values()) l.sort((a, b) => a.id - b.id);
  snap = { sig, orgs, dealsBy, cands: null, listSig: "" };
  return snap;
}

// ---------- un paso
function newJob(st, full) {
  const now = Date.now();
  const mode = full || !st.base || !st.lastFullAt || now - Date.parse(st.lastFullAt) > FULL_EVERY ? "full" : "inc";
  return { mode, gen: mode === "full" ? now.toString(36) : st.base, since: mode === "inc" ? st.nextSince || null : null, phase: "orgs", cursor: null,
    startedAt: iso(now), orgs: 0, deals: 0, pages: 0, avgMs: 0, lastId: "", done: 0, written: 0, same: 0, skipped: 0, skip: {} };
}
const byIdOrder = () => [...schools].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
async function pageStep(j) {
  const t = Date.now(), isOrgs = j.phase === "orgs";
  const r = isOrgs ? await pd.orgsPage({ cursor: j.cursor, since: j.since }) : await pd.dealsPage({ cursor: j.cursor, since: j.since });
  const name = H(j.gen, isOrgs ? "o" : "d");
  const keep = isOrgs ? r.items.filter(o => !o.deleted) : r.items.filter(d => !d.deleted && d.org_id);
  await hset(name, keep.map(x => [x.id, JSON.stringify(isOrgs ? [x.name, x.ownerId || null] : [x.org_id, x.status, x.pipeline_id, x.stage_id, x.owner_id, x.lost_reason, x.lost_time, x.update_time])]));
  // en una incremental, lo borrado (o el trato que quedó sin organización) sale de la foto
  if (j.mode === "inc") await hdel(name, r.items.filter(x => !keep.includes(x)).map(x => x.id));
  j[isOrgs ? "orgs" : "deals"] += r.items.length; j.pages++;
  j.avgMs = Math.round(j.avgMs ? j.avgMs * 0.7 + (Date.now() - t) * 0.3 : Date.now() - t);
  if (r.next) j.cursor = r.next;
  else { j.cursor = null; j.phase = isOrgs ? "deals" : "match"; }
}
async function matchStep(st, j, deadline) {
  if (kvEnabled) await storeSync({ force: true }); // los cruces que guardaron otras instancias (para no pisar lo de una ficha)
  const s = await snapshot(j);
  // protección: si la foto quedó vacía (Redis la perdió, el token no ve organizaciones), no se marca todo como «nuevo»
  if (!s.orgs.size || (st.baseOrgs && s.orgs.size < st.baseOrgs * 0.5)) throw new Error(`La foto de Pipedrive tiene ${s.orgs.size} organizaciones${st.baseOrgs ? ` (la última tenía ${st.baseOrgs})` : ""}: no cruzo nada. Probá rehacer desde cero.`);
  const list = byIdOrder(), listSig = `${list.length}|${list[list.length - 1]?.id}`;
  if (!s.cands || s.listSig !== listSig) { s.cands = new Map(candidatesFor(list, s.orgs).map((c, i) => [list[i].id, c])); s.listSig = listSig; }
  const m = await pd.meta(), now = Date.now();
  let i = j.lastId ? list.findIndex(x => x.id > j.lastId) : 0; if (i < 0) i = list.length;
  while (i < list.length) {
    const batch = [];
    for (; i < list.length && batch.length < 400; i++) {
      const sc = list[i], cur = getMatch(sc.id);
      const r = decideMatch({ cur, fresh: isFresh(cur), cands: s.cands.get(sc.id) || [], orgs: s.orgs, dealsBy: s.dealsBy, m, now, startedAt: j.startedAt });
      if (r.rec) batch.push([sc.id, r.rec]); else if (r.same) j.same++; else { j.skipped++; j.skip[r.skip] = (j.skip[r.skip] || 0) + 1; }
      j.done++;
    }
    await setMatches(batch);
    j.written += batch.length; j.lastId = list[i - 1].id;
    if (Date.now() > deadline - 1500) break;
  }
  return i >= list.length;
}
async function finish(st, j) {
  const at = iso(Date.now());
  if (j.mode === "full") {
    const old = st.base;
    st.base = j.gen; st.lastFullAt = at; st.baseOrgs = j.orgs;
    if (old && old !== j.gen) await drop([H(old, "o"), H(old, "d")]).catch(() => {});
  }
  // la próxima incremental trae lo cambiado desde que empezó esta (con 5 minutos de margen)
  st.nextSince = iso(Date.parse(j.startedAt) - 5 * 60e3);
  st.last = { mode: j.mode, startedAt: j.startedAt, finishedAt: at, orgs: j.orgs, deals: j.deals, written: j.written, same: j.same, skipped: j.skipped, skip: j.skip };
  st.job = null; st.error = null;
}

// Hace trabajo hasta budgetMs y devuelve el progreso. Si no hay una en curso, empieza una:
// completa (full, o si nunca se hizo o la última tiene más de 30 días) o incremental (lo cambiado desde la última).
// maxPages: tope de páginas por paso (para probar pausar y seguir).
export async function step({ budgetMs = 40e3, full = false, by = "", maxPages = Infinity } = {}) {
  const deadline = Date.now() + budgetMs;
  const tok = await takeLock(budgetMs + 60e3);
  if (!tok) return { ...(await status()), busy: true };
  let st = {};
  try {
    st = await loadState();
    if (!st.job) { st.job = newJob(st, full); st.job.by = by; }
    st.error = null;
    let pages = 0;
    while (st.job) {
      const j = st.job;
      if (j.phase === "match") {
        if (await matchStep(st, j, deadline)) await finish(st, j);
        await saveState(st);
        break;
      }
      if (pages >= maxPages || (pages && Date.now() + Math.max(1500, j.avgMs * 1.5) > deadline)) break;
      await pageStep(j); pages++;
      await saveState(st);
    }
  } catch (e) {
    console.warn("Sincronización con Pipedrive:", e.message);
    st.error = { at: iso(Date.now()), message: String(e.message || e).slice(0, 300), phase: st.job?.phase || "" };
    await saveState(st).catch(() => {});
  } finally { await releaseLock(tok); }
  return view(st);
}
const view = st => ({ running: !!st.job, job: st.job ? { ...st.job, total: schools.length, approxOrgs: st.baseOrgs || null } : null, last: st.last || null, lastFullAt: st.lastFullAt || null, error: st.error || null });
export async function status() { return view(await loadState()); }
// para las pruebas (estado en memoria)
export function _reset() { mem.state = null; mem.hashes.clear(); mem.lock = false; snap = null; }
