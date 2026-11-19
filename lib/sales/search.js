// Búsqueda en toda la base de Pipedrive (Prospectar y la búsqueda rápida) y la ficha de una persona.
import * as pd from "../pipedrive.js";
import { byId, orgToSchool } from "../store.js";
import { FREE_OWNERS, TYPE_LABEL } from "../config.js";
import { DEAL_STATUS, MIN_Q, TYPES, cleanCursor, groupResults, leadTarget, orgTarget, planKey, searchPlan } from "../pdsearch.js";
import { bad } from "../text.js";
import { stripHtml } from "./util.js";
import { appCountry } from "./records.js";

// ---------- búsqueda en toda la base de Pipedrive (Prospectar y la búsqueda rápida; reglas puras en lib/pdsearch.js)
// En vivo (Pipedrive es la fuente de verdad), solo lectura, con una copia de 60 s por término: «222 429 2676» y
// «2224292676» comparten la misma. Texto o email: una búsqueda por tipo (personas, organizaciones, prospectos y tratos, de
// a 50 con su cursor: ninguno tapa a otro y se sabe si hay más). Teléfono: personas por teléfono + itemSearch con los
// dígitos + el número con espacios en los campos de texto; si no aparece nada, los últimos 10 y 7 dígitos. Si una de las
// búsquedas falla se muestra lo demás (partial); si fallan todas, error.
const pdsCache = new Map(), PDS_TTL = 60e3, PDS_PAGE = 50;
export const orgSchoolMap = () => new Map([...orgToSchool()].filter(([, sid]) => byId.has(sid)).map(([oid, sid]) => [Number(oid), sid]));
// nombres de las personas de Pipedrive (también las que ya no están: «X (ya no está en Pipedrive)»)
export const userNames = m => { const act = new Set((m?.users || []).map(u => Number(u.id))); return new Map([...(m?.allUsers || []), ...(m?.users || [])].map(u => [Number(u.id), act.has(Number(u.id)) || !(m?.users || []).length ? u.name : `${u.name} (ya no está en Pipedrive)`])); };
// jobs: [[clave, promesa de { items, next }]] → ok: [[clave, valor]] de las que respondieron
async function settleAll(jobs) {
  const r = await Promise.allSettled(jobs.map(j => j[1])), ok = r.map((x, i) => x.status === "fulfilled" ? [jobs[i][0], x.value || { items: [] }] : null).filter(Boolean);
  if (!ok.length) throw r[0].reason;
  return { ok, raw: ok.flatMap(([, v]) => v.items || []), partial: ok.length < r.length };
}
// ciudad y país de las organizaciones de los resultados: las cruzadas, del colegio; las otras, de Pipedrive (un pedido de
// hasta 100). Si falla, sin ciudad (no rompe la búsqueda).
async function orgPlaces(raw, o2s) {
  const ids = [...new Set(raw.filter(r => r?.item?.type === "organization").map(r => Number(r.item.id)).filter(Boolean))], places = new Map(), ask = [];
  const txt = (city, region, country) => [city || region, country].filter(Boolean).join(", ");
  for (const id of ids) { const sc = byId.get(o2s.get(id)); if (sc?.city || sc?.country) places.set(id, txt(sc.city, "", sc.country)); else ask.push(id); }
  if (ask.length) for (const o of await pd.orgsByIds(ask.slice(0, 100)).catch(() => [])) { const t = txt(o.city, o.region, appCountry(o.country) || o.country); if (t) places.set(Number(o.id), t); }
  return places;
}
async function pdCtx(raw, plan, term) {
  const o2s = orgSchoolMap(), [m, places] = await Promise.all([pd.meta().catch(() => null), orgPlaces(raw, o2s)]);
  return { users: userNames(m), pipes: m?.pipes || {}, free: FREE_OWNERS, o2s, places, web: pd.PD_WEB, plan, term };
}
async function runPdSearch(plan) {
  const first = plan.terms[0];
  if (plan.kind !== "phone") {
    const { ok, raw, partial } = await settleAll(TYPES.map(t => [t, pd.searchItems(first, { types: t, limit: PDS_PAGE })]));
    const next = Object.fromEntries(ok.map(([t, v]) => [t, v.next || null]));
    const g = groupResults(raw, await pdCtx(raw, plan, first), { next });
    return { kind: plan.kind, term: first, ...g, ...(partial ? { partial: true } : {}), at: new Date().toISOString() };
  }
  const phoneJobs = t => [["persons", pd.searchPersonsByPhone(t)], ["items", pd.searchItems(t, { limit: PDS_PAGE })]];
  let term = first, { ok, raw, partial } = await settleAll([...phoneJobs(first), ...plan.spaced.map(v => ["spaced", pd.searchItems(v, { fields: "custom_fields,notes", limit: PDS_PAGE })])]);
  for (const t of plan.terms.slice(1)) {
    if (raw.length) break;
    try { const r = await settleAll(phoneJobs(t)); ok = r.ok; raw = r.raw; partial ||= r.partial; term = t; }
    catch { partial = true; break; } // ya hubo una respuesta (vacía): lo que falta se avisa, no es un error
  }
  // (un teléfono con más de 50 resultados es raro: si pasa, cualquier grupo puede tener más)
  const capped = ok.some(([, v]) => v.next);
  const g = groupResults(raw, await pdCtx(raw, plan, term), { capped });
  return { kind: plan.kind, term, ...g, ...(partial ? { partial: true } : {}), at: new Date().toISOString() };
}
function pdsCached(k, run) {
  const now = Date.now(), hit = pdsCache.get(k);
  if (hit && now - hit.at < PDS_TTL) return hit.p;
  const p = run();
  pdsCache.delete(k); pdsCache.set(k, { at: now, p }); // al final: el orden del Map es el de antigüedad
  p.catch(() => { if (pdsCache.get(k)?.p === p) pdsCache.delete(k); }); // un error no queda guardado
  for (const [kk, v] of pdsCache) if (pdsCache.size > 300 || now - v.at >= PDS_TTL) pdsCache.delete(kk); else break;
  return p;
}
// (devuelve la misma promesa a quien pide lo mismo mientras está en curso o dentro de los 60 s)
export function pdSearch(q) {
  const plan = searchPlan(q);
  if (!plan) return Promise.reject(bad(`Escribí al menos ${MIN_Q} letras o números.`));
  return pdsCached(planKey(plan), () => runPdSearch(plan));
}
// «Ver más» de un grupo: la página siguiente de ese tipo (cursor de la búsqueda anterior; sin cursor, la primera página de
// ese tipo, para cuando la búsqueda mezclada de un teléfono llegó a su tope). term: el que usó la búsqueda (para un
// teléfono, uno de los de respaldo); si no es uno de los de lo escrito, el primero.
export function pdSearchMore(q, type, cursor, term) {
  const plan = searchPlan(q);
  if (!plan) return Promise.reject(bad(`Escribí al menos ${MIN_Q} letras o números.`));
  if (!TYPES.includes(type)) return Promise.reject(bad("Tipo inválido"));
  const cur = cursor ? cleanCursor(cursor) : null;
  if (cursor && !cur) return Promise.reject(bad("Página inválida"));
  const t = plan.terms.includes(String(term ?? "")) ? String(term) : plan.terms[0];
  return pdsCached(`${planKey(plan)}|${t}|${type}|${cur || ""}`, async () => {
    const r = await pd.searchItems(t, { types: type, limit: PDS_PAGE, cursor: cur || undefined });
    const g = groupResults(r.items, await pdCtx(r.items, plan, t), { next: { [type]: r.next } }).groups.find(x => x.type === type);
    return { type, items: g?.items || [], next: r.next || null, more: !!r.next };
  });
}
// Ficha de una persona de Pipedrive (la que se buscó, tenga o no organización): teléfonos, emails, dueño, su organización
// (y a qué ficha lleva), tratos (con el motivo y la fecha si se ganó o perdió), prospectos, actividades pendientes y hechas,
// y las últimas notas. missing: lo que no se pudo leer (se muestra igual lo demás).
export async function personCard(id) {
  const pid = Number(id);
  if (!Number.isInteger(pid) || pid <= 0) throw bad("Persona inválida");
  const p = await pd.getPersonFull(pid);
  if (!p) throw bad("No encontré esa persona en Pipedrive", 404);
  const parts = { meta: pd.meta(), pending: pd.activities({ personId: pid, done: false, limit: 20 }), done: pd.activities({ personId: pid, done: true, limit: 15 }),
    deals: pd.dealsForPerson(pid), leads: pd.leadsForPerson(pid), notes: pd.notesForPerson(pid, 5), org: p.orgId ? pd.orgsByIds([p.orgId]) : Promise.resolve([]) };
  const keys = Object.keys(parts), got = await Promise.allSettled(Object.values(parts)), v = {}, missing = [];
  keys.forEach((k, i) => { if (got[i].status === "fulfilled") v[k] = got[i].value; else { v[k] = null; if (k !== "meta") missing.push({ pending: "actividades", done: "actividades", deals: "tratos", leads: "prospectos", notes: "notas", org: "organización" }[k]); } });
  const users = userNames(v.meta), o2s = orgSchoolMap();
  const who = uid => !uid ? "" : FREE_OWNERS.has(Number(uid)) ? "Cuenta general" : users.get(Number(uid)) || "";
  const act = a => ({ id: a.id, subject: String(a.subject || "").slice(0, 160), type: a.type, typeLabel: TYPE_LABEL[a.type] || a.type, date: a.due_date || "", time: a.due_time || "", done: !!a.done,
    owner: who(a.owner_id ?? a.user_id), note: stripHtml(a.note).slice(0, 300) });
  const o = (v.org || [])[0];
  return { id: pid, name: p.name || "Sin nombre", phones: p.phones, emails: p.emails, owner: who(p.ownerId), url: `${pd.PD_WEB}/person/${pid}`,
    org: o ? { id: o.id, name: o.name, to: orgTarget(o.id, o2s) } : p.orgId ? { id: p.orgId, name: "", to: orgTarget(p.orgId, o2s) } : null,
    deals: (v.deals || []).slice(0, 20).map(d => ({ id: d.id, title: d.title || "Trato", status: DEAL_STATUS[d.status] || "", pipeline: v.meta?.pipes?.[d.pipeline_id] || "", stage: v.meta?.stages?.[d.stage_id] || "",
      owner: who(d.owner_id ?? d.user_id), url: `${pd.PD_WEB}/deal/${d.id}`, to: d.org_id ? orgTarget(d.org_id, o2s) : null,
      ...(d.status === "lost" ? { reason: String(d.lost_reason || "").slice(0, 200), closed: String(d.lost_time || d.close_time || "").slice(0, 10) } : d.status === "won" ? { closed: String(d.won_time || d.close_time || "").slice(0, 10) } : {}) })),
    leads: (v.leads || []).slice(0, 20).map(l => ({ id: l.id, title: l.title || "Prospecto", archived: !!l.archived, owner: who(l.ownerId), url: `${pd.PD_WEB}/leads/inbox/${encodeURIComponent(l.id)}`, to: leadTarget(l.id, l.orgId, o2s) })),
    pending: (v.pending || []).filter(a => !a.is_deleted).map(act), done: (v.done || []).filter(a => !a.is_deleted).map(act),
    notes: (v.notes || []).map(n => ({ at: n.add_time ? String(n.add_time).replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(n.add_time) ? "" : "Z") : null, by: n.user?.name || who(n.user_id), text: stripHtml(n.content).slice(0, 500) })),
    missing: [...new Set(missing)] };
}
