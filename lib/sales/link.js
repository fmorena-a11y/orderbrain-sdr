// «Es esta», vincular y fusionar organizaciones duplicadas.
import * as pd from "../pipedrive.js";
import { allMatches, byId, canonicalId, getMatch, isFresh, refreshMatch, schools, setMatch, touchesFor, withLock } from "../store.js";
import { CLIENT_PIPES } from "../config.js";
import { todayIn } from "../time.js";
import { brainOf } from "../brain.js";
import { ddmm } from "../demos.js";
import { addrPlace, dupeOrgs, isClient, mergeBlock, mergeError, mergeRequestError, mergeStop, previewWarnings, sameName } from "../merge.js";
import * as psync from "../sync.js";
import { bad, esc } from "../text.js";
import { signer } from "./util.js";
import { checkSchool } from "./match.js";
import { schoolSummary } from "./list.js";
import { sedeCache } from "./sedes.js";

// ---------- «Es esta» y fusionar organizaciones duplicadas (reglas puras en lib/merge.js)
// «Es esta»: queda vinculada a mano. Las otras candidatas que vio la persona (y la que estaba elegida sola) quedan en el
// cruce (seen) para buscar entre ellas las duplicadas del mismo colegio (dupesFor): la masiva ve todas las organizaciones
// y la búsqueda de Pipedrive puede no traerlas.
const candRef = c => ({ id: Number(c.id), name: String(c.name || ""), ownerId: c.ownerId ?? null });
export async function linkSchool(id, org) {
  const cur = (await refreshMatch(id)) || {}, seen = new Map();
  for (const c of [...(cur.candidates || []), ...(cur.orgId ? [{ id: cur.orgId, name: cur.orgName, ownerId: cur.ownerId }] : []), ...(cur.seen || [])])
    if (c?.id && Number(c.id) !== Number(org.id) && !seen.has(Number(c.id))) seen.set(Number(c.id), candRef(c));
  const rec = await checkSchool(id, { org });
  return seen.size ? setMatch(id, { ...rec, seen: [...seen.values()].slice(0, 8) }) : rec;
}
// Lo que dice Pipedrive de una organización, para comparar: dirección, dueño, tratos, prospectos abiertos, actividades sin
// hacer y personas. _deals, _leads y _acts (crudos) son para los permisos y no salen al navegador (cardOut). leads, acts o
// persons null: no se pudieron leer.
async function orgCard(o, m) {
  const [deals, leads, acts, persons] = await Promise.all([pd.dealsForOrg(o.id), pd.leadsForOrg(o.id).catch(() => null),
    pd.activities({ orgId: o.id, done: false, limit: 50 }).catch(() => null), pd.personsForOrg(o.id).catch(() => null)]);
  const uname = uid => uid ? m.users.find(u => u.id === Number(uid))?.name || "" : "";
  return { id: o.id, name: o.name, city: o.city || "", region: o.region || "", country: o.country || "", addr: o.addr || "", ownerId: o.ownerId || null, owner: uname(o.ownerId),
    url: `${pd.PD_WEB}/organization/${o.id}`, client: isClient(deals),
    deals: deals.map(d => ({ id: d.id, title: d.title || "", status: d.status, pipeline: m.pipes[d.pipeline_id] || "", stage: m.stages[d.stage_id] || "", owner: uname(pd.realOwner(d.owner_id || d.user_id)), clientPipe: CLIENT_PIPES.includes(Number(d.pipeline_id)) })),
    leads: leads && leads.map(l => ({ id: l.id, title: l.title, owner: uname(l.ownerId) })),
    acts: acts && acts.filter(x => !x.done).map(x => ({ id: x.id, subject: x.subject || "", type: x.type || "", due: x.due_date || "", owner: uname(pd.realOwner(x.owner_id ?? x.user_id)) })),
    persons: persons && persons.length, personsMore: (persons?.length || 0) >= 20,
    _deals: deals, _leads: leads, _acts: acts };
}
const cardOut = ({ _deals, _leads, _acts, ...c }) => c;
// Organizaciones vinculadas a OTROS colegios de la base (no a fichas de Pipedrive): orgId → [ids de colegios]
export function linkedElsewhere(id) {
  const out = new Map();
  for (const [sid, m] of Object.entries(allMatches())) {
    if (!m?.orgId || sid.startsWith("pd-") || canonicalId(sid) === id) continue;
    const o = Number(m.orgId); if (!out.has(o)) out.set(o, []); out.get(o).push(sid);
  }
  return out;
}
// ids de colegios → [{ id, name, city }] (sin repetir ni los que ya no están en la base)
export const linkedSchools = (ids = []) => [...new Map(ids.map(sid => byId.get(sid)).filter(Boolean).map(x => [x.id, { id: x.id, name: x.name, city: x.city || "" }])).values()];
// «¿Estás seguro?»: solo una organización que la ficha ofrece (candidata, la elegida o una vista antes). Con avisos
// (lib/merge.js, previewWarnings): ya vinculada a otro colegio de la base, de otra ciudad, u otra organización del mismo
// colegio en la misma ciudad con un trato abierto (de otra persona o tuyo).
export async function orgPreview(id, orgId, user = null) {
  const s = byId.get(id); if (!s) throw bad("Colegio inexistente", 404);
  const rec = getMatch(id) || {}, oid = Number(orgId);
  const offered = [...(rec.orgId ? [{ id: rec.orgId, name: rec.orgName }] : []), ...(rec.candidates || []), ...(rec.seen || [])];
  if (!oid || !offered.some(c => Number(c.id) === oid)) throw bad("Esa organización no es candidata de este colegio.", 404);
  // las otras que se llaman como el colegio: si alguna es de la misma ciudad y tiene un trato abierto, se avisa
  const ctx = pd.matchCtx(schools), k = ctx.key(s);
  const others = [...new Map(offered.filter(c => Number(c.id) !== oid && sameName(k, c.name, ctx.places)).map(c => [Number(c.id), c])).keys()].slice(0, 4);
  const [orgs, m] = await Promise.all([pd.orgsByIds([oid, ...others]), pd.meta()]);
  const o = orgs.find(x => x.id === oid);
  if (!o) throw bad("No encontré esa organización en Pipedrive: puede que la hayan fusionado o borrado.", 404);
  const same = orgs.filter(x => x.id !== oid && addrPlace(s, x) !== "other" && (sameName(k, x.name, ctx.places)?.city || addrPlace(s, x) === "same"));
  const open = (await Promise.all(same.map(x => pd.dealsForOrg(x.id).then(d => ({ x, d }), () => null)))).filter(Boolean).flatMap(({ x, d }) => {
    const deal = pd.openSalesDeal(d) || d.find(y => y.status === "open"), owner = deal && pd.realOwner(deal.owner_id ?? deal.user_id);
    return owner ? [{ id: x.id, name: x.name, ownerId: owner, owner: m.users.find(u => u.id === owner)?.name || "" }] : [];
  });
  const linkedTo = linkedSchools(linkedElsewhere(id).get(oid));
  return { org: cardOut(await orgCard(o, m)), linkedTo, warnings: previewWarnings({ school: s, org: o, linkedTo, open, me: user?.pdUserId || null }) };
}
// Cuántas duplicadas encontró la última búsqueda (dupesFor): la ficha muestra «Está cargada N veces más · Revisar»
function saveDupeCount(id, orgId, n) {
  const cur = getMatch(id);
  if (cur && Number(cur.orgId) === Number(orgId) && (cur.dupeCount || 0) !== n) setMatch(id, { ...cur, dupeCount: n });
}
// Después de «Es esta» (o desde «Revisar» en la ficha): las otras organizaciones que son el mismo colegio (dupeOrgs) con lo
// que tiene cada una y qué impide fusionarla para quien pregunta (mergeBlock); keepBlock: lo que impide juntar en la
// vinculada; stop (mergeStop): lo que lo impide para todos (colegio sin ciudad, ficha de Pipedrive o la vinculada ya es de
// otro colegio de la base; linkedTo: cuáles). Solo si la eligió una persona (confirmada a mano). Salen de las candidatas
// vistas (seen) y de buscar el nombre propio del colegio en Pipedrive.
export async function dupesFor(id, user, { leader = false } = {}) {
  const s = byId.get(id); if (!s) throw bad("Colegio inexistente", 404);
  const rec = (await refreshMatch(id)) || {};
  const none = { keep: null, keepBlock: null, stop: null, linkedTo: [], dupes: [], leader: !!leader };
  if (s.leadOnly || !rec.orgId || !rec.confirmed || rec.auto) return none;
  const keepId = Number(rec.orgId), linked = linkedElsewhere(id), linkedTo = linkedSchools(linked.get(keepId));
  const stop = mergeStop({ school: s, linkedTo });
  if (stop) { saveDupeCount(id, keepId, 0); return { ...none, stop, linkedTo }; }
  const ctx = pd.matchCtx(schools), k = ctx.key(s);
  const found = new Map((rec.seen || []).map(c => [Number(c.id), c]));
  if (k.strong) for (const t of new Set([k.a.join(" "), k.a.slice(0, 2).join(" ")]))
    for (const o of await pd.searchOrganizations(t, 50, { nameOnly: true })) if (!found.has(Number(o.id))) found.set(Number(o.id), o);
  found.delete(keepId);
  // primero por nombre (sin pedidos); la dirección, solo de las que pasan
  const named = [...found.values()].filter(o => sameName(k, o.name, ctx.places)).slice(0, 20);
  const [orgs, m] = await Promise.all([pd.orgsByIds([keepId, ...named.map(o => Number(o.id))]), pd.meta()]);
  const keepO = orgs.find(o => o.id === keepId);
  if (!keepO) throw bad("No encontré la organización vinculada en Pipedrive: puede que la hayan fusionado o borrado.", 404);
  const { dupes } = dupeOrgs({ school: s, k, ctx, keep: keepO, orgs: orgs.filter(o => o.id !== keepId), linked });
  const top = dupes.slice(0, 6);
  const me = user?.pdUserId || null, nameOf = uid => m.users.find(u => u.id === Number(uid))?.name || "";
  const [keep, ...cards] = await Promise.all([orgCard(keepO, m), ...top.map(x => orgCard(orgs.find(o => o.id === x.id), m))]);
  const block = c => mergeBlock({ org: c, deals: c._deals, leads: c._leads || [], leadsUnknown: !c._leads, acts: c._acts || [], actsUnknown: !c._acts, me, leader, nameOf });
  // cliente en OrderBrain: lo fusiona quien ve todo (dirección, los fijos o, sin equipos, un líder); un líder de equipo no
  // (no se sabe de qué equipo es la cuenta)
  const keepBlock = block(keep) || (leader !== true && brainOf(s)?.client ? `Es cliente en OrderBrain: la fusiona ${leader ? "dirección" : "un líder"}` : null);
  saveDupeCount(id, keepId, top.length);
  return { keep: cardOut(keep), keepBlock, stop: null, linkedTo, leader: !!leader,
    dupes: cards.map((c, i) => ({ ...cardOut(c), sameCity: top[i].sameCity, cityFrom: top[i].cityFrom, elsewhere: top[i].elsewhere, elsewhereAt: top[i].elsewhereAt, block: block(c) })) };
}
export const joinY = l => l.length > 1 ? `${l.slice(0, -1).join(", ")} y ${l.at(-1)}` : l[0] || "";
// Fusionar en la vinculada (keepId) las duplicadas elegidas (mergeIds), con los controles de lib/merge.js (mergeError):
// la que queda es la elegida a mano, cada una es duplicada según dupesFor y es tuya o libre (o sos líder; un cliente, solo
// un líder). De a una con la fusión de Pipedrive (queda keepId). Después: nota en la que queda, los cruces que apuntaban a
// las borradas pasan a la que queda (lo elegido a mano sigue elegido a mano), las borradas salen de las candidatas de los
// cruces, de la foto de la sincronización masiva y de las sedes, y el colegio se recalcula con todos los tratos juntos.
export async function mergeOrgs(id, user, { keepId, mergeIds = [], leader = false, by = "", tz = "America/Mexico_City" } = {}) {
  const s = byId.get(id); if (!s) throw bad("Colegio inexistente", 404);
  keepId = Number(keepId);
  const ids = [...new Set((Array.isArray(mergeIds) ? mergeIds : []).map(Number))].filter(n => Number.isInteger(n) && n > 0);
  // una fusión por vez entre instancias: dos cruzadas (A en B y B en A) borrarían las dos
  return withLock("merge-orgs", async () => {
    const rec = await refreshMatch(id);
    const pre = mergeRequestError({ rec, keepId, mergeIds: ids }); if (pre) throw bad(pre.msg, pre.status);
    const d = await dupesFor(id, user, { leader });
    const err = mergeError({ rec, keepId, mergeIds: ids, dupes: d.dupes, keepBlock: d.keepBlock, stop: d.stop }); if (err) throw bad(err.msg, err.status);
    const keep = d.keep, names = new Map(d.dupes.map(x => [x.id, x.name])), done = [], merged = [];
    for (const mid of ids) {
      try { await pd.mergeOrganization(mid, keepId); merged.push(mid); done.push({ label: `«${names.get(mid)}» (id ${mid}) quedó dentro de «${keep.name}»${names.get(mid) === keep.name ? ` (id ${keepId})` : ""}`, url: keep.url }); }
      catch (e) { done.push({ label: `No pude fusionar «${names.get(mid)}»: ${e.message}`, warn: true }); break; }
    }
    if (!merged.length) throw bad(done[0].label, 502);
    // queda merge_with_id: si la vinculada no está en Pipedrive después de fusionar, no toco nada más (que lo revise una persona)
    const after = await pd.orgsByIds([keepId]).catch(() => null);
    if (after && !after.length) {
      done.push({ label: `Pipedrive no muestra «${keep.name}» después de fusionar: revisalo en Pipedrive antes de seguir.`, warn: true });
      return { done, merged, keep: { id: keepId, name: keep.name, url: keep.url }, school: schoolSummary(s) };
    }
    // fecha y autor primero: «Últimas notas» muestra el comienzo
    const who = by || signer(user), list = joinY(merged.map(mid => `«${names.get(mid)}» (id ${mid})`));
    await pd.addNote({ content: esc(`Fusión ${ddmm(todayIn(tz))} (${who}, OrderBrain SDR): ${merged.length === 1 ? "se juntó" : "se juntaron"} ${list}`), orgId: keepId })
      .then(() => done.push({ label: `Nota en «${keep.name}»: fusionada con ${list}`, url: keep.url }))
      .catch(e => done.push({ label: `No pude dejar la nota en «${keep.name}»: ${e.message}`, warn: true }));
    const n = await afterMerge(id, { id: keepId, name: keep.name, ownerId: keep.ownerId }, merged);
    if (n) done.push({ label: n === 1 ? `Otro colegio que apuntaba a una fusionada ahora apunta a «${keep.name}»` : `${n} colegios que apuntaban a las fusionadas ahora apuntan a «${keep.name}»` });
    const fresh = await checkSchool(id, { org: { id: keepId, name: keep.name, ownerId: keep.ownerId } }).catch(() => getMatch(id));
    const rest = (rec.seen || []).filter(c => !merged.includes(Number(c.id)));
    if (fresh) setMatch(id, { ...fresh, seen: rest, dupeCount: Math.max(0, d.dupes.length - merged.length) });
    return { done, merged, keep: { id: keepId, name: keep.name, url: keep.url }, school: schoolSummary(s) };
  });
}
// Lo que apuntaba a las borradas (gone). Devuelve cuántos colegios de la base pasaron a la que queda.
async function afterMerge(id, keep, gone) {
  const g = new Set(gone.map(Number)), drop = l => (l || []).filter(c => !g.has(Number(c.id)));
  sedeCache.clear();
  const [deals, m] = await Promise.all([pd.dealsForOrg(keep.id).catch(() => null), pd.meta().catch(() => null)]);
  let moved = 0;
  for (const [sid, rec] of Object.entries(allMatches())) {
    if (!rec || canonicalId(sid) === id) continue;
    if (g.has(Number(rec.orgId))) {
      // vinculado a una borrada: pasa a la que queda (si alguien la eligió a mano, sigue elegida a mano)
      const hand = pd.keepsOrg(rec, byId.get(sid) || null, touchesFor(sid).length > 0);
      const next = deals && m ? pd.matchRecord({ chosen: { id: keep.id, name: keep.name, score: 1 }, deals, m, ownerId: keep.ownerId ?? null, confirmed: hand, candidates: drop(rec.candidates), cur: rec })
        : { ...rec, orgId: keep.id, orgName: keep.name, candidates: drop(rec.candidates) };
      setMatch(sid, rec.seen ? { ...next, seen: drop(rec.seen) } : next);
      if (!sid.startsWith("pd-")) moved++;
      continue;
    }
    // candidatas (o vistas) que ya no existen: fuera de la ficha
    if (isFresh(rec) && [rec.candidates, rec.seen].some(l => l && drop(l).length !== l.length))
      setMatch(sid, { ...rec, ...(rec.candidates ? { candidates: drop(rec.candidates) } : {}), ...(rec.seen ? { seen: drop(rec.seen) } : {}) });
  }
  await psync.forgetOrgs([...g]).catch(e => console.warn("No pude sacar las fusionadas de la foto de Pipedrive:", e.message));
  return moved;
}


// «no es esta organización»: queda marcado (unlinked) para que la sincronización masiva no la vuelva a elegir mientras dure
export function unlinkSchool(id) {
  return setMatch(id, { status: "new", detail: "Sin coincidencia confirmada", orgId: null, orgName: null, confirmed: false, auto: false, unlinked: true, candidates: getMatch(id)?.candidates || [] });
}
