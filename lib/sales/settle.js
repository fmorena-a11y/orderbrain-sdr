// «Antes de crear»: ¿ya está en Pipedrive? (investigate, decide, settleExisting, useExisting…).
import * as pd from "../pipedrive.js";
import { allMatches, byId, canonicalId, getMatch, schools, setMatch } from "../store.js";
import { DEAL_FIELDS } from "../config.js";
import * as EX from "../existing.js";
import { bad } from "../text.js";
import { signer } from "./util.js";
import { countryFromOpt } from "./records.js";
import { orgSchoolMap, userNames } from "./search.js";
import { checkSchool } from "./match.js";
import { linkSchool } from "./link.js";
import { schoolSummary } from "./list.js";
import { capWords } from "./sedes.js";
import { clientNow, exClientNow, leadUrlOf } from "./worklead.js";

// ---------- ¿ya está en Pipedrive? Investigación antes de crear (reglas puras en lib/existing.js)
// Muchos prospectos de la cuenta no tienen organización (los importados: «montessori angeles», con la dirección en su campo):
// el cruce por organizaciones no los ve. Antes de crear una organización o un prospecto se buscan prospectos, tratos y
// organizaciones por nombre (con y sin la ciudad), teléfono, mail y web, y las personas con ese teléfono o mail.
// Resultado (EX.decide): sure (se usa ese), maybe (se pregunta: 409 con las candidatas) o none (recién ahí se crea).
// En el cruce (checkSchool), sin organización, la versión liviana (solo el nombre): un prospecto seguro deja el colegio en
// «Prospecto en Pipe»; las dudas y el «no hay nada» quedan en el cruce (pdx) para la ficha.
const EX_TTL = 120e3, PDX_DAYS = 3;
const exCache = new Map();
export const needsLeadCheck = m => !!m && m.status === "new" && !m.orgId && !(m.pdx?.at && Date.now() - Date.parse(m.pdx.at) < PDX_DAYS * 864e5);
const pdUrl = x => x.kind === "lead" ? leadUrlOf(x.id) : x.kind === "deal" ? `${pd.PD_WEB}/deal/${x.id}` : `${pd.PD_WEB}/organization/${x.id}`;
// lo que se guarda y se muestra de cada registro encontrado (sin datos de más)
const placeTxt = x => { for (const t of x.texts || []) { const a = EX.addrParts(t); if (a?.muni) return [a.muni, a.state].filter(Boolean).map(capWords).join(", "); } return x.org?.city ? [x.org.city, x.org.region].filter(Boolean).join(", ") : ""; };
const DEAL_TXT = { open: "trato abierto", won: "trato ganado", lost: "trato perdido" };
function exItem(x, users) {
  const kind = x.kind === "lead" ? (x.archived ? "prospecto archivado" : "prospecto") : x.kind === "deal" ? `${DEAL_TXT[x.status] || "trato"}${x.stage ? ` · ${x.stage}` : ""}` : "organización";
  const phone = (x.texts || []).find(t => EX.phonesIn(t).length) || "";
  return { key: x.key, kind: x.kind, id: x.id, title: x.title, what: kind, ownerId: x.ownerId || null, owner: x.ownerId ? users.get(Number(x.ownerId)) || "otra persona" : "",
    orgId: x.orgId || null, orgName: x.kind === "organization" ? "" : x.orgName || "", place: placeTxt(x), phone, why: x.why || "", level: x.level, url: pdUrl(x),
    ...(x.archived ? { archived: true } : {}), ...(x.status ? { status: x.status } : {}) };
}
// un trato como lo da /v2/deals (las personas encontradas por teléfono o mail): lo justo para juzgarlo
const recOfDeal = (d, extra = {}) => ({ key: `deal:${d.id}`, kind: "deal", id: d.id, title: d.title || "", ownerId: pd.realOwner(d.owner_id || d.user_id), orgId: d.org_id || null, orgName: "",
  personId: d.person_id || null, status: d.status || null, stage: "", texts: [], ...extra });
const labelsOf = l => ({ ciudad: l.ciudadOpt ? pd.optionLabel(DEAL_FIELDS.ciudad, l.ciudadOpt) || "" : "", estado: l.estadoOpt ? pd.optionLabel(DEAL_FIELDS.estado, l.estadoOpt) || "" : "", pais: countryFromOpt(l.paisOpt) });
async function runExQuery(q) {
  if (q.types === "person") return (q.fields === "phone" ? await pd.searchPersonsByPhone(q.term, 10) : await pd.searchItems(q.term, { types: "person", fields: "email", limit: 10 })).items.map(i => i.item);
  return (await pd.searchItems(q.term, { types: q.types, fields: q.fields, limit: 50 })).items.map(i => i.item);
}
// full: todo (antes de crear). Devuelve { at, full, judged, r: EX.decide(...) }. Un pedido que falla: 503 (no se crea nada).
export async function investigate(id, { full = true, force = false, me = null } = {}) {
  const s = byId.get(id); if (!s) throw bad("Colegio inexistente", 404);
  const c = exCache.get(id);
  if (!force && c && Date.now() - c.at < EX_TTL && (c.full || !full)) return { ...c, r: EX.decide(c.judged, { no: getMatch(id)?.pdx?.no || [], me }) };
  const ctx = EX.ctxOf(s, pd.matchCtx(schools).places), plan = EX.queryPlan(s, { full });
  const fail = () => bad("No pude revisar si ya existe en Pipedrive: probá de nuevo.", 503);
  let items;
  try { items = (await Promise.all(plan.map(runExQuery))).flat(); } catch (e) { console.warn("Investigación en Pipedrive:", e.message); throw fail(); }
  const judged = EX.judgeAll(s, ctx, items);
  if (full) {
    try {
      await pd.loadFieldOptions().catch(() => {});
      // las personas con el mismo teléfono o mail: sus prospectos, sus tratos y su organización (de a 2 personas)
      const persons = items.filter(it => it?.type === "person" && EX.contactHit(ctx.contact, { phones: it.phones || [], emails: it.emails || [] })).slice(0, 2);
      for (const p of persons) {
        const contact = EX.contactHit(ctx.contact, { phones: p.phones || [], emails: p.emails || [] }), extra = { contact, personId: p.id, personName: p.name || "" };
        const [leads, deals] = await Promise.all([pd.leadsForPerson(p.id), pd.dealsForPerson(p.id)]);
        for (const l of leads) judged.push(EX.judge(s, ctx, EX.recOfLead(l, labelsOf(l), extra)));
        for (const d of deals) judged.push(EX.judge(s, ctx, recOfDeal(d, extra)));
        if (p.organization?.id) judged.push(EX.judge(s, ctx, { key: `organization:${p.organization.id}`, kind: "organization", id: p.organization.id, title: p.organization.name || "", orgId: p.organization.id, texts: [p.organization.address].filter(Boolean), ...extra }));
      }
      // las organizaciones candidatas del cruce, con su ciudad (casi ninguna trae dirección)
      const cur = getMatch(id) || {}, cands = [...(cur.candidates || []), ...(cur.seen || [])].filter(x => x?.id && !cur.unlinked);
      const orgs = cands.length ? await pd.orgsByIds([...new Set(cands.map(x => Number(x.id)))]) : [];
      // una organización sin ciudad ni dirección: la dirección de sus prospectos abiertos dice dónde está (pedido del líder:
      // «no ofrecer colegios de otra ciudad»: «Instituto San Francisco Solano» de Ituzaingó no es el de Rosario)
      const leadTexts = new Map();
      await Promise.all(orgs.filter(o => !o.city && !o.addr).slice(0, 4).map(async o => {
        const ls = await pd.leadsForOrg(o.id).catch(() => []);
        leadTexts.set(o.id, ls.flatMap(l => [l.addr, ...Object.values(labelsOf(l)).filter(Boolean).length > 1 ? [[labelsOf(l).ciudad, labelsOf(l).estado, labelsOf(l).pais].filter(Boolean).join(", ")] : []]).filter(Boolean));
      }));
      for (const o of orgs) judged.push(EX.judge(s, ctx, { key: `organization:${o.id}`, kind: "organization", id: o.id, title: o.name, ownerId: o.ownerId || null, orgId: o.id, org: { city: o.city, region: o.region, country: o.country }, texts: [o.addr, ...(leadTexts.get(o.id) || [])].filter(Boolean) }));
    } catch (e) { console.warn("Investigación en Pipedrive:", e.message); throw fail(); }
  }
  // lo que ya está vinculado a OTRO colegio de la base (su organización o el prospecto) no se elige solo: se pregunta
  const o2s = orgSchoolMap(), leadOf = new Map(Object.entries(allMatches()).filter(([sid, m]) => m?.leadId && !sid.startsWith("pd-") && canonicalId(sid) !== id).map(([sid, m]) => [String(m.leadId), sid]));
  for (const x of judged) {
    if (x.level !== "sure") continue;
    const oid = x.kind === "organization" ? Number(x.id) : Number(x.orgId) || null, other = (oid && o2s.get(oid)) || (x.kind === "lead" && leadOf.get(String(x.id)));
    if (other && canonicalId(other) !== id) { x.level = "maybe"; x.why += `, pero ya está vinculado a «${byId.get(other)?.name || "otro colegio"}» de la base`; }
  }
  const out = { at: Date.now(), full, judged: [...new Map(judged.filter(x => x.level).map(x => [x.key, x])).values()] };
  exCache.set(id, out); if (exCache.size > 300) exCache.delete(exCache.keys().next().value);
  return { ...out, r: EX.decide(out.judged, { no: getMatch(id)?.pdx?.no || [], me }) };
}
// lo que queda en el cruce (pdx): cuándo se buscó, qué tan a fondo y lo dudoso (para la ficha), sin perder los descartados
async function pdxOf(id, inv, extra = {}) {
  const m = await pd.meta().catch(() => ({ users: [] })), users = userNames(m), prev = getMatch(id)?.pdx || {};
  const phone = !!EX.contactOf(byId.get(id) || {}).phones.length;
  return { at: new Date(inv.at).toISOString(), full: !!(inv.full || (prev.full && prev.at && Date.now() - Date.parse(prev.at) < PDX_DAYS * 864e5)), phone: inv.full ? phone : !!prev.phone, verdict: inv.r.verdict,
    maybe: inv.r.maybe.slice(0, 6).map(x => exItem(x, users)), info: inv.r.info.slice(0, 3).map(x => exItem(x, users)), ...(prev.no?.length ? { no: prev.no } : {}), ...extra };
}
// el colegio queda «Prospecto en Pipe» con ese prospecto (sin organización)
export async function setLeadMatch(id, l, { cur = getMatch(id), confirmed = true, auto = false, pdx = undefined } = {}) {
  const m = await pd.meta().catch(() => ({ users: [] }));
  const person = l.personId ? await pd.getPerson(l.personId).catch(() => null) : null;
  const rec = setMatch(id, { status: "lead", detail: "Prospecto en Pipedrive (sin organización)", orgId: null, orgName: null, leadId: l.id, leadTitle: l.title || "",
    ownerId: l.ownerId || null, ownerName: l.ownerId ? m.users.find(u => u.id === l.ownerId)?.name || "" : "", personId: l.personId || null, personName: person?.name || "",
    confirmed: !!(confirmed || auto), auto: !!auto && !confirmed, candidates: cur?.candidates || [], ...(pdx || cur?.pdx ? { pdx: pdx || cur.pdx } : {}) });
  leadView(byId.get(id));
  return rec;
}
// Un link a un prospecto que trae una base cargada (Cargar base): sin organización, el colegio queda «Prospecto en Pipe» con ese
// prospecto (como «Es este»); con organización, el colegio pasa a esa. Solo lectura en Pipedrive. null si no está o está archivado.
export async function adoptLead(id, leadId) {
  const l = await pd.getLead(leadId); if (!l || l.archived) return null;
  if (!l.orgId) return setLeadMatch(id, l, { confirmed: true });
  const name = (await pd.orgsByIds([l.orgId]).catch(() => []))[0]?.name || l.title;
  await checkSchool(id, { org: { id: l.orgId, name, ownerId: null } });
  return setMatch(id, { ...getMatch(id), leadId: l.id });
}
// Un colegio de la base cuyo cruce es un prospecto sin organización se trabaja como la ficha de un prospecto (leadOnly):
// lo que se registre va al prospecto y no se crea organización. Se rearma desde el cruce (otra instancia pudo cambiarlo).
export const viewed = (s, rec) => (leadView(s), rec);
// el título del prospecto de la ficha (un colegio de la base en «Prospecto en Pipe» tiene el suyo: «montessori angeles»)
export const leadTitleOf = s => (s.leadVia && getMatch(s.id)?.leadTitle) || s.name;
export function leadView(s) {
  if (!s || s.virtual) return s;
  const m = getMatch(s.id);
  if (m?.status === "lead" && m.leadId && !m.orgId) Object.assign(s, { leadOnly: true, leadVia: true, leadId: m.leadId, personId: m.personId || null, personName: m.personName || "" });
  else if (s.leadVia) { s.leadOnly = false; delete s.leadVia; delete s.leadId; delete s.personId; delete s.personName; }
  return s;
}
// El paso liviano del cruce, sin organización: un prospecto seguro → «Prospecto en Pipe» (o su organización, si tiene); si no,
// queda lo que había (rec) con lo dudoso o el «no hay nada» (pdx). Si Pipedrive falla, sin pdx (la ficha no dice «revisé»).
export async function leadCheck(id, s, rec) {
  let inv;
  try { inv = await investigate(id, { full: false }); } catch { return viewed(s, setMatch(id, rec)); }
  const pick = inv.r.pick;
  if (pick?.kind === "lead" && !pick.archived) {
    const l = await pd.getLead(pick.id).catch(() => null);
    if (l && !l.archived) {
      const pdx = await pdxOf(id, inv, { pick: pick.key });
      if (!l.orgId) return setLeadMatch(id, l, { cur: rec, confirmed: false, auto: true, pdx });
      const o = (await pd.orgsByIds([l.orgId]).catch(() => []))[0];
      if (o) {
        const [deals, m] = await Promise.all([pd.dealsForOrg(o.id), pd.meta()]);
        const out = pd.matchRecord({ chosen: { id: o.id, name: o.name, score: 1 }, deals, m, ownerId: o.ownerId || null, auto: true, candidates: rec.candidates || [], cur: rec });
        return viewed(s, setMatch(id, { ...out, leadId: l.id, pdx }));
      }
    }
  }
  return viewed(s, setMatch(id, { ...rec, pdx: await pdxOf(id, inv) }));
}
const maybeErr = (msg, items, code = "pd_maybe", extra = {}) => Object.assign(bad(msg, 409), { code, candidates: items }, extra);
// «Ya hablé con X: pasámelo» (pedido del líder de SDR: «dame una opción que diga ya hablé y cambialo, o que te diga de quién
// es, así decido»): el prospecto de otra persona pasa a tu nombre, desarchivado si hacía falta, con una nota que lo dice.
async function takeLead(l, user, ownerName, done) {
  const me = Number(user.pdUserId); if (!me) throw bad("Tu email no coincide con ningún usuario de Pipedrive.", 403);
  await pd.updateLead(l.id, { owner_id: me, ...(l.archived ? { is_archived: false } : {}) });
  const who = signer(user);
  await pd.addNote({ leadId: l.id, content: `<b>Prospecto pasado a ${escH(who)}</b><br>Era de ${escH(ownerName)}. ${escH(who)} dijo que ya lo habló con esa persona. · Desde OrderBrain SDR` }).catch(() => {});
  done.push({ label: `El prospecto «${l.title}» pasó a tu nombre (era de ${ownerName})`, url: leadUrlOf(l.id) });
  return { ...l, ownerId: me, archived: false };
}
const escH = v => String(v ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
// Antes de escribir algo de un colegio sin organización (o con organización pero sin prospecto ni trato para él): la
// investigación completa y su decisión. sure: se usa (applyPick). maybe: 409 con las candidatas (la ficha pregunta «¿es
// alguno de estos?»; con «Es este» o «Es otro colegio» se vuelve a pedir). none: sigue (quien llama crea). Un colegio que ya
// es «Prospecto en Pipe»: el prospecto tiene que seguir abierto y ser tuyo o libre (uno de la cuenta general pasa a tu nombre).
// dry: sin escribir en Pipedrive (el chequeo de antes de mandar un mail). Devuelve { done: [...], warnings: [...] }.
export async function settleExisting(id, user, { dry = false } = {}) {
  const s = byId.get(id), done = [], warnings = [];
  if (!s || s.virtual) return { done, warnings };
  const me = Number(user?.pdUserId) || null;
  let rec = await checkSchool(id);
  if (s.leadOnly) { await guardLead(id, s, me, done, { dry }); return { done, warnings }; }
  if (rec.orgId && rec.openDealId) return { done, warnings };
  // con organización: si es cliente, ex cliente o de otra persona, no se va a crear nada (workLead lo deja en la organización)
  if (rec.orgId && (clientNow(schoolSummary(s), rec) || exClientNow(schoolSummary(s), rec) || (rec.ownerId && Number(rec.ownerId) !== me))) return { done, warnings };
  if (rec.orgId) {
    let open;
    try { open = await leadsHere(s, rec.orgId); } catch { throw bad("No pude revisar los prospectos en Pipedrive: probá de nuevo.", 503); }
    if (open.length) return { done, warnings };
  }
  const inv = await investigate(id, { full: true, me });
  let r = inv.r;
  // con organización, solo cuentan los prospectos de afuera (sin organización u otra) y los tratos sin organización
  if (rec.orgId) r = EX.decide(inv.judged.filter(x => (x.kind === "lead" && x.orgId !== rec.orgId) || (x.kind === "deal" && !x.orgId)), { no: getMatch(id)?.pdx?.no || [], me });
  setMatch(id, { ...getMatch(id), pdx: await pdxOf(id, { ...inv, r }) });
  const users = userNames(await pd.meta().catch(() => ({ users: [] })));
  if (r.verdict === "maybe") throw maybeErr("Ya hay algo parecido en Pipedrive: ¿es alguno de estos?", r.maybe.slice(0, 6).map(x => exItem(x, users)));
  if (r.verdict === "sure") await applyPick(id, user, r.pick, { dry, done, auto: true });
  for (const x of r.info) warnings.push(`En Pipedrive hay ${x.kind === "lead" ? "un prospecto archivado" : "un trato perdido sin organización"} de este colegio: «${x.title}»${x.ownerId ? ` (de ${users.get(Number(x.ownerId)) || "otra persona"})` : ""}. Lo dejé como estaba.`);
  return { done, warnings };
}
// el prospecto de un colegio «Prospecto en Pipe»: al día, abierto y tuyo o libre
async function guardLead(id, s, me, done, { dry = false } = {}) {
  let l;
  try { l = await pd.getLead(s.leadId); } catch { throw bad("No pude comprobar en Pipedrive de quién es el prospecto. Probá de nuevo.", 503); }
  if (!l || l.archived) { exCache.delete(id); setMatch(id, { ...pd.noMatchRecord(getMatch(id)?.candidates || []), pdx: undefined }); leadView(s); throw bad(`El prospecto «${getMatch(id)?.leadTitle || s.name}» ya no está abierto en Pipedrive. Probá de nuevo: lo vuelvo a buscar.`, 409); }
  if (l.orgId) { await checkSchool(id, { force: true }); return; } // ahora tiene organización: se sigue con ella
  if (l.ownerId && l.ownerId !== me) {
    const owner = userNames(await pd.meta().catch(() => ({ users: [] }))).get(Number(l.ownerId)) || "otra persona";
    throw maybeErr(`Ya hay un prospecto de ${owner} para este colegio en Pipedrive: «${l.title}». Hablalo con esa persona.`, [], "pd_theirs", { take: { key: `lead:${l.id}`, owner } });
  }
  if (!l.ownerId && !dry && me) await pd.updateLead(l.id, { owner_id: me }).then(() => { setMatch(id, { ...getMatch(id), ownerId: me }); done.push({ label: "El prospecto pasó a tu nombre (estaba en la cuenta general)", url: leadUrlOf(l.id) }); }).catch(() => {});
}
// Usar un registro de Pipedrive para el colegio (lo eligió la investigación o una persona con «Es este»).
// prospecto: con organización, el colegio pasa a esa (con el prospecto); sin organización, queda «Prospecto en Pipe» (si el
// colegio ya tiene organización, el prospecto pasa a ella). trato: su organización; sin organización, uno abierto tuyo o libre
// queda en una organización nueva a tu nombre, uno de otra persona no se toca (409), uno ganado es cliente (409).
// organización: «Es esta». auto: lo eligió la investigación (se vuelve a calcular).
async function applyPick(id, user, x, { dry = false, done = [], auto = false, take = false } = {}) {
  const s = byId.get(id), me = Number(user?.pdUserId) || null, users = userNames(await pd.meta().catch(() => ({ users: [] })));
  const who = oid => users.get(Number(oid)) || "otra persona";
  const cur = getMatch(id) || {};
  if (x.kind === "organization") { await linkSchool(id, { id: Number(x.id), name: x.title, ownerId: x.ownerId ?? null }); done.push({ label: `Ya estaba en Pipedrive: organización «${x.title}»`, url: pdUrl(x) }); return; }
  if (x.kind === "lead") {
    let l = await pd.getLead(x.id).catch(() => { throw bad("No pude leer ese prospecto en Pipedrive. Probá de nuevo.", 503); });
    if (!l) throw bad("Ese prospecto ya no está en Pipedrive.", 404);
    if (take && !dry && l.ownerId && l.ownerId !== me) l = await takeLead(l, user, who(l.ownerId), done);
    const theirs = l.ownerId && l.ownerId !== me, takeInfo = { take: { key: `lead:${l.id}`, owner: who(l.ownerId) } };
    if (l.archived) {
      if (theirs) throw maybeErr(`Ese prospecto es de ${who(l.ownerId)} y está archivado: hablalo con esa persona.`, [], "pd_theirs", takeInfo);
      if (!dry) { await pd.updateLead(l.id, { is_archived: false, ...(me && !l.ownerId ? { owner_id: me } : {}) }); done.push({ label: `Desarchivé el prospecto «${l.title}»`, url: leadUrlOf(l.id) }); }
    }
    if (l.orgId && !(cur.orgId && cur.orgId !== l.orgId)) {
      const name = x.orgName || (await pd.orgsByIds([l.orgId]).catch(() => []))[0]?.name || l.title;
      await checkSchool(id, { org: { id: l.orgId, name, ownerId: null } });
      setMatch(id, { ...getMatch(id), leadId: l.id, ...(auto ? { auto: true, confirmed: true } : {}) });
    } else if (cur.orgId && !l.orgId) {
      // el colegio ya tiene organización: el prospecto suelto pasa a ella (si es tuyo o libre)
      if (theirs) { setMatch(id, { ...cur, leadOther: { id: l.id, title: l.title, ownerId: l.ownerId, owner: who(l.ownerId) } }); return; }
      if (!dry) { await pd.updateLead(l.id, { organization_id: cur.orgId, ...(me && !l.ownerId ? { owner_id: me } : {}) }); setMatch(id, { ...getMatch(id), leadId: l.id }); done.push({ label: `El prospecto «${l.title}» (sin organización) quedó en ${cur.orgName || "la organización"}`, url: leadUrlOf(l.id) }); }
      return;
    } else if (!l.orgId) await setLeadMatch(id, l, { confirmed: !auto, auto });
    else throw maybeErr("Ese prospecto está en otra organización de Pipedrive: vinculá el colegio a esa organización desde la ficha.", [], "pd_other_org");
    leadView(s);
    // sin organización, el prospecto es el único lugar donde escribir: si es de otra persona, no se toca
    if (theirs && s.leadOnly) throw maybeErr(`Ya hay un prospecto de ${who(l.ownerId)} para este colegio en Pipedrive: «${l.title}». Hablalo con esa persona.`, [], "pd_theirs", takeInfo);
    if (!l.ownerId && !dry && me) await pd.updateLead(l.id, { owner_id: me }).then(() => done.push({ label: "El prospecto pasó a tu nombre (estaba en la cuenta general)", url: leadUrlOf(l.id) })).catch(() => {});
    done.unshift({ label: `Ya estaba en Pipedrive: prospecto «${l.title}»`, url: leadUrlOf(l.id) });
    return;
  }
  // trato
  const d = await pd.getDeal(x.id).catch(() => { throw bad("No pude leer ese trato en Pipedrive. Probá de nuevo.", 503); });
  if (!d || d.is_deleted || d.status === "deleted") throw bad("Ese trato ya no está en Pipedrive.", 404);
  if (d.org_id) { await linkSchool(id, { id: Number(d.org_id), name: x.orgName || d.title, ownerId: null }); done.push({ label: `Ya estaba en Pipedrive: trato «${d.title}»`, url: pdUrl(x) }); return; }
  const owner = pd.realOwner(d.owner_id || d.user_id);
  if (d.status === "won") throw maybeErr(`Ya es cliente de OrderEAT: trato ganado «${d.title}» en Pipedrive.`, [], "pd_client");
  if (d.status === "lost") { setMatch(id, { ...getMatch(id), pdx: { ...(getMatch(id)?.pdx || {}), no: [...new Set([...(getMatch(id)?.pdx?.no || []), x.key])] } }); return; }
  if (owner && owner !== me) throw maybeErr(`Tiene un trato abierto de ${who(owner)} en Pipedrive («${d.title}», sin organización). Coordiná con esa persona.`, [], "pd_theirs");
  if (dry) return;
  // tuyo o libre y sin organización: queda en la organización del colegio (o en una nueva a tu nombre)
  let orgId = cur.orgId || null, orgName = cur.orgName || s.name;
  if (!orgId) {
    if (!me) throw bad(pd.NO_OWNER, 403);
    const o = await pd.createOrganization({ name: s.name, website: s.web, ownerId: me, address: { value: [s.addr, s.city, s.country].filter(Boolean).join(", "), locality: s.city, country: s.country } });
    orgId = o.id; orgName = o.name || s.name; done.push({ label: "Organización creada en Pipedrive a tu nombre", url: `${pd.PD_WEB}/organization/${orgId}` });
  }
  await pd.updateDeal(d.id, { org_id: orgId, ...(me && !owner ? { owner_id: me } : {}) });
  await checkSchool(id, { org: { id: orgId, name: orgName, ownerId: me } });
  done.push({ label: `El trato «${d.title}» (sin organización) quedó en ${orgName}`, url: `${pd.PD_WEB}/deal/${d.id}` });
}
// «Es este» (desde la pregunta o la ficha): solo uno de los que se ofrecieron (pdx) o que vuelve a encontrar la investigación
export async function useExisting(id, user, key, { take = false } = {}) {
  const s = byId.get(id); if (!s) throw bad("Colegio inexistente", 404);
  if (s.virtual) throw bad("Es una ficha de Pipedrive.", 400);
  const k = String(key || "");
  const offered = m => [...(m?.pdx?.maybe || []), ...(m?.pdx?.info || [])].find(x => x.key === k);
  let x = offered(getMatch(id));
  if (!x) { const inv = await investigate(id, { full: true, me: user.pdUserId }); x = inv.judged.find(y => y.key === k); }
  // pasar a tu nombre el prospecto de la ficha (el que ya tiene el colegio): no hace falta que aparezca en la búsqueda
  if (!x && take && /^lead:/.test(k) && getMatch(id)?.leadId === k.slice(5)) x = { key: k, kind: "lead", id: k.slice(5), title: getMatch(id)?.leadTitle || s.name };
  if (!x) throw bad("Eso ya no aparece en Pipedrive para este colegio.", 404);
  const done = [];
  await applyPick(id, user, { ...x, texts: x.texts || [] }, { done, take });
  // ya se eligió: la pregunta no vuelve
  const m = getMatch(id); if (m?.pdx) setMatch(id, { ...m, pdx: { ...m.pdx, maybe: [], verdict: "sure", pick: k } });
  exCache.delete(id);
  return { ok: true, done };
}
// «Es otro colegio, crear prospecto nuevo»: lo que se preguntó queda descartado (la próxima investigación no lo vuelve a ofrecer)
export async function dismissExisting(id, keys = null) {
  const m = getMatch(id) || {}, list = keys?.length ? keys.map(String) : (m.pdx?.maybe || []).map(x => x.key);
  if (!list.length) return { ok: true };
  setMatch(id, { ...m, pdx: { ...(m.pdx || {}), at: m.pdx?.at || new Date().toISOString(), maybe: [], verdict: "none", no: [...new Set([...(m.pdx?.no || []), ...list])].slice(-30) } });
  return { ok: true };
}
// El asistente sin ficha («agendale a Colegio X»): ¿hay un prospecto o un trato abierto que se llame así? (mismo nombre)
export async function namedInPipedrive(name) {
  const s = { name, city: "", country: "" }, ctx = EX.ctxOf(s, pd.matchCtx(schools).places), t = EX.searchTerms(s).title[0];
  if (!t) return [];
  const items = await runExQuery({ types: "lead,deal", fields: "title", term: t }).catch(() => { throw bad("No pude revisar si ya existe en Pipedrive: probá de nuevo.", 503); });
  return items.filter(it => it.type !== "person" && !it.is_archived && it.status !== "lost" && EX.nameLevel(ctx.k, it.title || "", ctx.places) === "same").slice(0, 3).map(it => ({ title: it.title }));
}
// Los prospectos abiertos de la organización que son de ESTE colegio: una organización puede juntar prospectos de varias
// ciudades («COLEGIO LOS ANGELES» con los de Tlalpan, Los Cabos y Oaxaca): los de otra ciudad no son de este.
export async function leadsHere(s, orgId) {
  const open = await pd.leadsForOrg(orgId);
  if (!open.length || !s || s.virtual) return open;
  await pd.loadFieldOptions().catch(() => {});
  return open.filter(l => EX.placeLevel(s, EX.recOfLead(l, labelsOf(l))) !== "other");
}
