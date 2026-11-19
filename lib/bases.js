// Cargar base: la planilla de un evento (EduExperience…) se carga con el link, un archivo o pegada, se agrupa por institución
// (lib/import.js), se cruza con Pipedrive con las MISMAS reglas de «Antes de crear» (checkSchool + investigate/decide de
// lib/sales.js y lib/existing.js) y se trabaja como sesión (origen «base»). Cada base se guarda por persona con vencimiento
// (lib/store.js); un líder ve las de su gente (canLead). Rutas en lib/bases-api.js. Nada de datos personales en los logs.
//
// Cada institución queda ligada a una ficha: un colegio de la base de la app (mismo nombre propio y ciudad, uno solo) o, si no
// está, una ficha bx-<base>-<n> (como las de Pipedrive, pero no es «virtual»: antes de crear algo pasa por «Antes de crear»),
// que se rearma en cualquier instancia leyendo la base (sales.recordSources.bx). En la sesión va como bx:<base>-<n>.
// Al crear el prospecto (workLead/newLead) el título lleva el evento al final (sales.hooks.leadEvent → import.leadTitle).
import crypto from "crypto";
import * as pd from "./pipedrive.js";
import * as sales from "./sales.js";
import * as EX from "./existing.js";
import * as IM from "./import.js";
import { readXlsx } from "./xlsx.js";
import { schools, byId, addVirtual, getMatch, canonicalId, readBase, writeBase, readBaseIndex, removeBases, getBaseRefs, addBaseRefs, cacheGet, cacheSet, withLock } from "./store.js";
import { FREE_OWNERS, MARKETS } from "./config.js";
import { canLead } from "./teams.js";
import { bad, lc } from "./text.js";

const DRAFT_TTL = 86400, MAX_ITEMS = 400, MAX_CELLS = 150e3;
const newId = () => crypto.randomBytes(6).toString("hex");
const ID_RE = /^[0-9a-f]{12}$/;

// ---------- borrador: lo que se leyó (todas las pestañas), un día, solo para quien lo cargó
function tabView(t, i) {
  const header = IM.findHeader(t.rows), headers = (t.rows[header] || []).map(h => IM.cleanCell(h).slice(0, 80));
  const data = t.rows.slice(header + 1), rows = data.filter(r => r.some(c => String(c ?? "").trim())).length;
  const map = IM.detectColumns(headers, data);
  return { i, name: t.name, gid: t.gid ?? null, rows, header, headers, map, ok: map.inst != null };
}
// la pestaña que más sirve: con institución, personas y contacto, y más filas
const tabScore = v => (v.ok ? 1e6 : 0) + (v.map.name != null ? 2e5 : 0) + (v.map.phone != null || v.map.email != null ? 1e5 : 0) + v.rows;
export async function makeDraft(email, src) {
  const tabs = (src.tabs || []).filter(t => t.rows?.length).slice(0, IM.LIMITS.tabs).map(t => ({ name: String(t.name || "Hoja").slice(0, 100), gid: t.gid ?? null, rows: t.rows.slice(0, IM.LIMITS.rows + 30) }));
  if (!tabs.length) throw bad("La planilla está vacía.", 400, "sheet_empty");
  const cells = tabs.reduce((n, t) => n + t.rows.reduce((m, r) => m + r.length, 0), 0);
  if (cells > MAX_CELLS) throw bad("La planilla es muy grande para cargarla entera: descargá solo la pestaña que vas a trabajar (CSV) y subila.", 413, "sheet_big");
  const id = newId(), title = String(src.title || src.fileName || "").replace(/\.(csv|xlsx|tsv|txt)$/i, "").slice(0, 160);
  const event = IM.eventFromTitle(title), place = IM.placeFromText(event || title);
  const source = { kind: src.kind, via: src.via || "", private: !!src.private, sheetId: src.kind === "sheet" ? src.sheetId || "" : "", fileName: src.fileName ? String(src.fileName).slice(0, 120) : "" };
  await cacheSet(`bdraft:${id}`, { id, by: lc(email), title, source, tabs }, DRAFT_TTL);
  const views = tabs.map(tabView), pick = views.reduce((b, v) => tabScore(v) > tabScore(views[b]) ? v.i : b, 0);
  return { id, title, event, city: place.city, country: place.country, source: { kind: source.kind, via: source.via, private: source.private }, tabs: views, pick };
}
async function loadDraft(email, id) {
  const d = typeof id === "string" && ID_RE.test(id) ? await cacheGet(`bdraft:${id}`) : null;
  if (!d || d.by !== lc(email)) throw bad("Esa carga venció: volvé a cargar la planilla.", 404, "draft_gone");
  return d;
}
export const fromFile = (buf, fileName) => {
  if (!Buffer.isBuffer(buf) || !buf.length) throw bad("El archivo llegó vacío.");
  if (buf[0] === 0x50 && buf[1] === 0x4b) return { ...readXlsx(buf), fileName, kind: "file", via: "xlsx" };
  if (buf[0] === 0xd0 && buf[1] === 0xcf) throw bad("Es un Excel viejo (.xls): guardalo como .xlsx o CSV y subilo de nuevo.");
  const text = buf.toString("utf8");
  if (/\u0000/.test(text.slice(0, 2000))) throw bad("No reconozco ese archivo: subí un CSV o un Excel (.xlsx).");
  return { title: "", fileName, kind: "file", via: "csv", tabs: [{ name: String(fileName || "Archivo").replace(/\.[a-z]+$/i, "").slice(0, 60) || "Archivo", rows: IM.parseCsv(text) }] };
};
export const fromPaste = text => {
  const t = String(text || "");
  if (!t.trim()) throw bad("No pegaste nada: copiá las filas de la planilla (con el encabezado) y pegalas acá.");
  return { title: "", kind: "paste", via: "paste", tabs: [{ name: "Pegado", rows: IM.parseCsv(t, { delimiter: t.includes("\t") ? "\t" : null }) }] };
};

// ---------- analizar una pestaña (encabezado, columnas corregidas, cómo queda agrupado)
function pickInput(d, b) {
  const ti = Number(b.tab), t = d.tabs[Number.isInteger(ti) && ti >= 0 && ti < d.tabs.length ? ti : 0];
  const hi = Number(b.header), header = Number.isInteger(hi) && hi >= 0 && hi < Math.min(25, t.rows.length) ? hi : IM.findHeader(t.rows);
  const headers = (t.rows[header] || []).map(h => IM.cleanCell(h).slice(0, 80)), data = t.rows.slice(header + 1);
  const map = b.map && typeof b.map === "object" ? IM.cleanMap(b.map, headers.length) : IM.detectColumns(headers, data);
  const country = MARKETS[b.country] ? b.country : "", city = IM.cleanCell(b.city).slice(0, 60), event = IM.cleanCell(b.event).replace(/[()]/g, "").slice(0, 80);
  return { t, ti: d.tabs.indexOf(t), header, headers, data, map, country, city, event };
}
const samplesOf = (headers, data) => headers.map((h, j) => { const v = data.map(r => IM.cleanCell(r?.[j] ?? "")).find(Boolean) || ""; return v.length > 60 ? v.slice(0, 57) + "…" : v; });
const lite = it => ({ name: it.name, city: it.city, kind: it.kind, out: it.out, contacts: it.contacts.length, decisor: it.contacts.find(c => c.decisor)?.role || "", students: it.students?.label || "", prio: it.prio });
export async function analyze(email, body = {}) {
  const d = await loadDraft(email, body.draft), x = pickInput(d, body);
  const out = { tab: x.ti, header: x.header, headers: x.headers, samples: samplesOf(x.headers, x.data), map: x.map, fields: IM.FIELDS };
  if (x.map.inst == null) return { ...out, counts: null, preview: [], need: "inst" };
  const b = IM.buildBase(x.t.rows, { header: x.header, map: x.map, country: x.country, city: x.city });
  return { ...out, counts: b.counts, preview: b.items.slice(0, 6).map(lite) };
}

// ---------- la base guardada
const baseMem = new Map();
async function getBase(id, { fresh = false } = {}) {
  if (!ID_RE.test(String(id))) return null;
  const c = baseMem.get(id); if (!fresh && c && Date.now() - c.at < 30e3) return c.b;
  const b = await readBase(id); if (b) baseMem.set(id, { b, at: Date.now() }); else baseMem.delete(id);
  if (baseMem.size > 50) baseMem.delete(baseMem.keys().next().value);
  return b;
}
const summaryOf = b => ({ id: b.id, by: b.by, byName: b.byName, at: b.at, updatedAt: b.updatedAt, event: b.event, country: b.country, city: b.city, title: b.title,
  counts: { institutions: b.items.length, people: b.counts?.people || 0, out: b.items.filter(i => i.out).length, checked: b.items.filter(i => i.x).length, todo: b.items.filter(i => !i.out).length } });
async function saveB(b) { b.updatedAt = new Date().toISOString(); const { _shared, ...keep } = b; await writeBase(keep, summaryOf(b)); baseMem.set(b.id, { b, at: Date.now() }); }
const bxRef = (b, it) => `bx:${b.id}-${it.n}`;
// la ficha de una institución que no está en la base de colegios de la app
const sharedOf = b => (b._shared ||= IM.sharedDomains(b.items));
function bxRecord(b, it) {
  const c = it.contacts || [], id = `bx-${b.id}-${it.n}`, cur = byId.get(id), shared = sharedOf(b), own = e => e && !shared.has(e.split("@")[1]);
  const rec = { id, name: it.name, city: it.city || b.city || "", country: it.country || b.country || "", phone: c.find(x => x.phone)?.phone || "", email: c.map(x => x.email).find(own) || "",
    phones: [...new Set(c.map(x => x.phone).filter(Boolean))].slice(0, 6), emails: [...new Set(c.map(x => x.email).filter(own))].slice(0, 6), src: "base", fromBase: { id: b.id, n: it.n, event: b.event } };
  return cur ? Object.assign(cur, rec) : addVirtual(rec);
}
// ¿está en la base de colegios de la app? Mismo nombre propio (EX.nameLevel «same»), mismo país y ciudad (o sin ciudad), uno solo.
function findSchool(it, list = schools) {
  const places = pd.matchCtx(schools).places, city = pd.norm(it.city);
  const hits = list.filter(s => s.country === it.country && (!city || pd.norm(s.city) === city || EX.sameCity(s.city, it.city)) && EX.nameLevel(EX.keyOf(s), it.name, places) === "same");
  return hits.length === 1 ? hits[0].id : null;
}
function resolveAll(b) {
  for (const it of b.items) {
    if (it.sid && byId.has(it.sid)) continue;
    const sid = findSchool(it);
    if (sid) { it.sid = sid; it.ref = sid; }
    else { it.sid = `bx-${b.id}-${it.n}`; it.ref = bxRef(b, it); bxRecord(b, it); }
  }
}
const refsOf = (b, it) => ({ [it.sid]: `${b.id}:${it.n}`, ...(it.x?.orgId ? { [`pd-org-${it.x.orgId}`]: `${b.id}:${it.n}` } : {}), ...(it.x?.leadId ? { [`pd-lead-${it.x.leadId}`]: `${b.id}:${it.n}` } : {}) });
export async function saveBase(user, body = {}) {
  const email = lc(user.email), d = await loadDraft(email, body.draft), x = pickInput(d, body);
  if (x.map.inst == null) throw bad("Elegí qué columna tiene el nombre de la institución.");
  const built = IM.buildBase(x.t.rows, { header: x.header, map: x.map, country: x.country, city: x.city });
  if (!built.items.length) throw bad("No encontré instituciones en esa pestaña: revisá la columna de la institución.");
  const now = new Date().toISOString(), event = x.event || IM.eventFromTitle(d.title) || d.title || "Base cargada";
  const url = d.source.kind === "sheet" && !d.source.private && d.source.sheetId ? `https://docs.google.com/spreadsheets/d/${d.source.sheetId}/edit${x.t.gid != null ? `#gid=${x.t.gid}` : ""}` : "";
  const b = { id: newId(), by: email, byName: String(user.name || "").slice(0, 80), byPd: Number(user.pdUserId) || null, at: now, updatedAt: now, event, country: x.country, city: x.city, title: d.title,
    source: { kind: d.source.kind, via: d.source.via, tab: x.t.name, url, file: d.source.fileName || "" }, map: x.map, header: x.header,
    counts: { ...built.counts, cut: Math.max(0, built.items.length - MAX_ITEMS) }, items: built.items.slice(0, MAX_ITEMS) };
  resolveAll(b);
  await saveB(b);
  await addBaseRefs(email, Object.assign({}, ...b.items.map(it => refsOf(b, it))));
  return b;
}

// ---------- quién ve qué: la propia, o la de alguien de su gente si es líder (leadScopeFor)
const mayRead = (b, email, scope) => !!b && (b.by === lc(email) || canLead(scope, { email: b.by }));
export async function readFor(email, id, scope) {
  const b = await getBase(id, { fresh: true });
  if (!b) throw bad("No encontré esa base: pudo vencer (duran 60 días) o la borraron.", 404);
  if (!mayRead(b, email, scope)) throw bad("Esa base es de otra persona.", 403);
  resolveAll(b);
  return b;
}
export async function listFor(email, scope) {
  const all = await readBaseIndex(), me = lc(email);
  const mine = all.filter(s => s.by === me), team = all.filter(s => s.by !== me && canLead(scope, { email: s.by }));
  const recent = (a, b) => String(b.updatedAt || b.at).localeCompare(String(a.updatedAt || a.at));
  return { mine: mine.sort(recent), team: team.sort(recent) };
}
export async function deleteFor(email, id, scope) {
  const b = await getBase(id, { fresh: true });
  if (!b) return { ok: true };
  if (!mayRead(b, email, scope)) throw bad("Esa base es de otra persona.", 403);
  await removeBases([id]); baseMem.delete(id);
  return { ok: true };
}

// ---------- lo que ve el navegador (standing: con el usuario de Pipedrive de quien mira)
const itemOut = (b, it, me) => ({ n: it.n, name: it.name, city: it.city, country: it.country, kind: it.kind, typeText: it.typeText, out: it.out, students: it.students?.label || "", count: it.count,
  contacts: it.contacts, contacted: it.contacted, notes: it.notes, next: it.next, prio: it.prio, ref: it.ref, sid: it.sid, inApp: !String(it.sid || "").startsWith("bx-"),
  x: it.x ? { state: it.x.state, owner: it.x.owner || "", url: it.x.url || "", title: it.x.title || "", why: it.x.why || "", maybe: it.x.maybe || [], at: it.x.at } : null,
  st: IM.standing(it.x, me, { free: FREE_OWNERS }) });
export function view(b, user) {
  const me = Number(user?.pdUserId) || null, items = b.items.map(it => itemOut(b, it, me));
  return { id: b.id, by: b.by, byName: b.byName, mine: b.by === lc(user?.email), at: b.at, updatedAt: b.updatedAt, event: b.event, country: b.country, city: b.city, title: b.title, source: b.source,
    counts: { ...b.counts, checked: b.items.filter(i => i.x || i.out).length, total: b.items.length, workable: items.filter(i => !i.out && i.st.workable).length }, items };
}

// ---------- cruce con Pipedrive, en tandas (el navegador pide la siguiente hasta que no quede ninguna)
async function pool(list, n, fn) { let i = 0; await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => { while (i < list.length) { const k = i++; await fn(list[k], k); } })); }
const leadUrl = id => `${pd.PD_WEB}/leads/inbox/${id}`, orgUrl = id => `${pd.PD_WEB}/organization/${id}`, dealUrl = id => `${pd.PD_WEB}/deal/${id}`;
// el cruce guardado de un colegio de la app que alguien eligió a mano no se cambia por un link de la planilla
const replaceable = sid => { const m = getMatch(sid); return !m?.orgId || !m.confirmed || !!m.auto; };
async function adoptLinks(sid, links) {
  if (!replaceable(sid)) return;
  for (const l of links) {
    try {
      if (l.kind === "lead") { if (await sales.adoptLead(sid, l.id)) return; continue; }
      let orgId = null, name = "";
      if (l.kind === "organization") { const o = (await pd.orgsByIds([l.id]))[0]; if (o) { orgId = o.id; name = o.name; } }
      if (l.kind === "deal") { const d = await pd.getDeal(l.id); if (d?.org_id) orgId = Number(d.org_id); }
      if (l.kind === "person") {
        const p = await pd.getPerson(l.id);
        if (p?.orgId) orgId = Number(p.orgId);
        else if (p) { const open = (await pd.leadsForPerson(l.id)).filter(x => !x.archived); if (open.length === 1 && await sales.adoptLead(sid, open[0].id)) return; }
      }
      if (orgId) { if (!name) name = (await pd.orgsByIds([orgId]).catch(() => []))[0]?.name || ""; await sales.checkSchool(sid, { org: { id: orgId, name, ownerId: null } }); return; }
    } catch { /* un link roto no corta el cruce: sigue con las reglas de siempre */ }
  }
}
async function crossOne(it, user) {
  const me = Number(user?.pdUserId) || null, sid = it.sid, s = byId.get(sid), at = new Date().toISOString();
  if (!s) return { state: "err", at, why: "No encontré la ficha." };
  const users = new Map(((await pd.meta().catch(() => null))?.users || []).map(u => [Number(u.id), u.name]));
  const who = id => (id ? users.get(Number(id)) || "otra persona" : "");
  if (it.pd?.length) await adoptLinks(sid, it.pd);
  const rec = await sales.checkSchool(sid), sum = sales.schoolSummary(s), base = { at, orgId: rec.orgId || null };
  if (sum.status === "client") return { ...base, state: "client", why: sum.detail || "", url: rec.orgId ? orgUrl(rec.orgId) : "" };
  if (sum.status === "archived") return { ...base, state: "archived", why: sum.detail || "" };
  if (sum.status === "churn") return { ...base, state: "churn", why: sum.detail || "", url: rec.orgId ? orgUrl(rec.orgId) : "" };
  if (rec.orgId) {
    if (rec.status === "client") return { ...base, state: "client", why: rec.detail || "", url: orgUrl(rec.orgId) };
    if (rec.openDealId) { const o = rec.openDealOwnerId || rec.ownerId; return { ...base, state: "open", ownerId: o || null, owner: rec.openDealOwner || who(o), url: dealUrl(rec.openDealId), title: rec.orgName || "" }; }
    let open = [];
    try { open = await sales.leadsHere(s, rec.orgId); } catch { /* sin los prospectos: lo de la organización */ }
    const l = sales.pickContactLead(open, rec.leadId || null, me) || open[0];
    if (l) return { ...base, state: "lead", ownerId: l.ownerId || null, owner: who(l.ownerId), url: leadUrl(l.id), leadId: l.id, title: l.title || "" };
    return { ...base, state: ["lost", "stalled"].includes(rec.status) ? rec.status : "org", ownerId: rec.ownerId || null, owner: rec.ownerName || who(rec.ownerId), url: orgUrl(rec.orgId), title: rec.orgName || "", why: rec.lostReason || "" };
  }
  if (rec.status === "lead" && rec.leadId) return { ...base, state: "lead", ownerId: rec.ownerId || null, owner: rec.ownerName || who(rec.ownerId), url: leadUrl(rec.leadId), leadId: rec.leadId, title: rec.leadTitle || "" };
  // sin organización: la investigación completa de «Antes de crear» (prospectos y tratos sin organización, teléfono, mail…)
  const r = (await sales.investigate(sid, { full: true, me })).r;
  if (r.verdict === "sure") {
    const x = r.pick, url = x.kind === "lead" ? leadUrl(x.id) : x.kind === "deal" ? dealUrl(x.id) : orgUrl(x.id);
    if (x.kind === "deal") return { ...base, state: x.status === "won" ? "client" : x.status === "lost" ? "lost" : "open", ownerId: x.ownerId || null, owner: who(x.ownerId), url, title: x.title || "" };
    if (x.kind === "lead") return { ...base, state: "lead", ownerId: x.ownerId || null, owner: who(x.ownerId), url, leadId: x.id, title: x.title || "" };
    return { ...base, state: "org", ownerId: x.ownerId || null, owner: who(x.ownerId), url, orgId: Number(x.id), title: x.title || "" };
  }
  if (r.verdict === "maybe") return { ...base, state: "maybe", maybe: r.maybe.slice(0, 3).map(x => ({ title: String(x.title || "").slice(0, 120), what: x.kind === "lead" ? "prospecto" : x.kind === "deal" ? "trato" : "organización", owner: who(x.ownerId) })) };
  return { ...base, state: "none", why: r.info.length ? `En Pipedrive hay ${r.info[0].kind === "lead" ? "un prospecto archivado" : "un trato perdido"}: «${String(r.info[0].title || "").slice(0, 80)}»` : "" };
}
// n por tanda (tope 8), de a 3 a la vez. keys: volver a revisar esas (n de la base).
export async function checkFor(user, id, scope, { n = 6, keys = null } = {}) {
  const b = await readFor(user.email, id, scope);
  const want = Array.isArray(keys) ? new Set(keys.map(Number)) : null;
  const todo = b.items.filter(it => !it.out && (want ? want.has(it.n) : !it.x)).slice(0, Math.max(1, Math.min(8, Number(n) || 6)));
  const got = new Map();
  await pool(todo, 3, async it => {
    try { got.set(it.n, await crossOne(it, user)); }
    catch (e) { got.set(it.n, { state: "err", at: new Date().toISOString(), why: e.status === 503 ? "Pipedrive no respondió" : "No pude revisar" }); }
  });
  // se guarda sobre lo último (otra pestaña pudo revisar otras a la vez)
  const saved = await withLock("base:" + id, async () => {
    const cur = (await getBase(id, { fresh: true })) || b;
    for (const it of cur.items) if (got.has(it.n)) { it.x = got.get(it.n); if (!it.sid) { const o = b.items[it.n]; it.sid = o?.sid; it.ref = o?.ref; } }
    resolveAll(cur);
    await saveB(cur);
    return cur;
  }, { busy: "Se está guardando esta base: probá de nuevo en unos segundos." });
  const refs = Object.assign({}, ...saved.items.filter(it => got.has(it.n)).map(it => refsOf(saved, it)));
  await addBaseRefs(saved.by, refs);
  if (lc(user.email) !== saved.by) await addBaseRefs(user.email, refs);
  const me = Number(user.pdUserId) || null;
  return { items: saved.items.filter(it => got.has(it.n)).map(it => itemOut(saved, it, me)), left: saved.items.filter(it => !it.out && !it.x).length };
}

// ---------- la ficha: los contactos de la planilla (de las bases de quien mira que tienen este colegio)
// scope: leadScopeFor de quien mira (una ficha bx de la base de otra persona muestra los contactos solo a su dueño o su líder)
export async function baseFor(schoolId, email, scope = false) {
  const s = byId.get(schoolId), m = getMatch(schoolId) || {};
  const refs = { ...(await getBaseRefs(email, [schoolId, canonicalId(schoolId), m.orgId && `pd-org-${m.orgId}`, m.leadId && `pd-lead-${m.leadId}`, s?.pdOrgId && `pd-org-${s.pdOrgId}`, s?.leadId && `pd-lead-${s.leadId}`])) };
  if (s?.fromBase) refs[schoolId] = `${s.fromBase.id}:${s.fromBase.n}`;
  const out = [], seen = new Set();
  for (const v of Object.values(refs)) {
    const [bid, n] = String(v).split(":"); if (seen.has(bid) || out.length >= 3) continue; seen.add(bid);
    const b = await getBase(bid).catch(() => null), it = b?.items?.[Number(n)];
    if (!it || !mayRead(b, email, scope)) continue;
    out.push({ base: { id: b.id, event: b.event, at: b.at }, name: it.name, kind: it.kind, typeText: it.typeText, out: it.out, students: it.students?.label || "", count: it.count, contacts: it.contacts, contacted: it.contacted, notes: it.notes, next: it.next, prio: it.prio });
  }
  return { bases: out };
}
// el evento para el título del prospecto que crea la app (sales.newLead)
async function leadEvent(id, user) {
  const s = byId.get(id); if (s?.fromBase?.event) return s.fromBase.event;
  if (!user?.email) return "";
  const r = await baseFor(id, user.email).catch(() => ({ bases: [] }));
  return r.bases[0]?.base.event || "";
}
// una ficha bx-<base>-<n> en cualquier instancia
async function bxSource(rid) {
  const m = /^([0-9a-f]{12})-(\d{1,4})$/.exec(rid); if (!m) return null;
  const b = await getBase(m[1]), it = b?.items?.[Number(m[2])];
  return it ? bxRecord(b, it) : null;
}
sales.recordSources.bx = bxSource;
sales.hooks.leadEvent = leadEvent;
