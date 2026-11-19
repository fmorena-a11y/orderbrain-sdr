// El prospecto donde va lo registrado (workLead) y el prospecto nuevo de un colegio (newLead, enrichNewLead).
import * as pd from "../pipedrive.js";
import { byId, getMatch, setMatch, withLock } from "../store.js";
import { OPTIONS } from "../config.js";
import { leadTitle } from "../import.js";
import { bad } from "../text.js";
import { hooks, paisWarn } from "./records.js";
import { checkSchool } from "./match.js";
import { leadsHere } from "./settle.js";
import { joinY } from "./link.js";
import { schoolSummary } from "./list.js";
import { enrichSchool } from "./enrichment.js";
import { leadFields } from "./address.js";

// resultados que cierran o ya tienen su propio paso (la demo): ahí no se agenda solo un seguimiento
export const NO_AUTO_NEXT = ["demo", "not_interested", "bad_data"];
// El prospecto abierto de la organización donde va un contacto: el de la ficha o el cruce si sigue abierto; si no, el único
// abierto de la organización (o el tuyo, si hay varios). Solo tuyo o de la cuenta general (FREE_OWNERS → pasa a tu nombre).
export function pickContactLead(open, known, me) {
  const mine = l => Number(l.ownerId) === Number(me), free = l => !l.ownerId;
  const k = known && open.find(l => l.id === known);
  if (k) return k;
  if (open.length === 1) return open[0];
  return open.find(mine) || (open.filter(free).length === 1 ? open.find(free) : null);
}
// Cliente de OrderEAT (no se prospecta): trato ganado o en un embudo de clientes, activo en World Dominion, o fase activo u
// onboarding. sum: schoolSummary; rec: el cruce al día.
export const clientNow = (sum, rec = {}) => sum?.status === "client" || rec?.status === "client" || ["activo", "onboarding"].includes(sum?.phase) || ["activo", "onboarding"].includes(rec?.phase);
// ex cliente de OrderEAT (churn, por World Dominion o Pipedrive): no se le crea prospecto (pedido del líder)
export const exClientNow = (sum, rec = {}) => sum?.status === "churn" || rec?.status === "churn" || sum?.phase === "churn" || rec?.phase === "churn" || !!sum?.ob?.churn;
export const leadUrlOf = lid => `${pd.PD_WEB}/leads/inbox/${lid}`;
// El prospecto nuevo de un colegio con organización: a tu nombre, título = nombre del colegio y los campos del formulario
// de Pipedrive (leadFields). Queda en el cruce. Lo usan «Crear prospecto» y el prospecto automático (workLead).
export async function newLead(id, rec, user, { personId = null, found = {} } = {}) {
  const s = byId.get(id);
  // de una base cargada (Cargar base): el evento al final del título, como en la cuenta («… (EduExperience Mendoza 2026)»)
  const ev = await hooks.leadEvent(id, user).catch(() => "");
  const lead = await pd.createLead({ title: ev ? leadTitle(s.name, ev) : s.name, ownerId: user.pdUserId, orgId: rec.orgId, personId, fields: await leadFields(s, user, found) });
  if (!lead?.id) throw bad("Pipedrive no devolvió el prospecto.", 502);
  const mm = getMatch(id); if (mm?.orgId === rec.orgId) setMatch(id, { ...mm, leadId: lead.id });
  return lead;
}
// Dónde va lo que se registra de un colegio de la base sin trato abierto (un contacto, un comentario, un mail, lo que
// confirma el asistente): SIEMPRE un prospecto, como se trabaja en el Buzón de prospectos de Pipedrive. El abierto de la
// organización (el de la ficha, el único o el tuyo; uno de la cuenta general pasa a tu nombre) o, si no tiene ninguno,
// uno nuevo a tu nombre (newLead). null = queda en la organización: trato abierto, cliente, organización o prospecto de otra
// persona, varios prospectos sin uno tuyo, o no se pudieron leer los prospectos (con aviso en warnings, salvo el cliente).
// Devuelve { id, title, ownerId, personId, url, created }.
export async function workLead(id, rec, user, done, warnings, { personId = null } = {}) {
  const s = byId.get(id), me = Number(user.pdUserId) || null;
  if (!s || s.leadOnly || !rec?.orgId || rec.openDealId || !me) return null;
  const known = s.leadId || getMatch(id)?.leadId || rec.leadId || null;
  let open = [];
  if (!rec.created) {
    try { open = await leadsHere(s, rec.orgId); }
    catch { warnings.push("No pude revisar los prospectos en Pipedrive: quedó en la organización."); return null; }
  }
  const l = pickContactLead(open, known, me);
  const keep = (x, created) => {
    const mm = getMatch(id); if (mm && mm.leadId !== x.id) setMatch(id, { ...mm, leadId: x.id });
    done.push({ label: `Guardado en el prospecto «${x.title || s.name}»`, url: leadUrlOf(x.id) });
    return { id: x.id, title: x.title || s.name, ownerId: me, personId: x.personId || x.person_id || null, url: leadUrlOf(x.id), created };
  };
  if (l) {
    if (l.ownerId && Number(l.ownerId) !== me) { warnings.push(`El prospecto «${l.title || "sin título"}» es de otra persona: quedó en la organización.`); return null; }
    if (!l.ownerId) await pd.updateLead(l.id, { owner_id: me }).then(() => done.push({ label: "El prospecto pasó a tu nombre (estaba en la cuenta general)" })).catch(() => {});
    return keep(l, false);
  }
  if (open.length) { warnings.push(open.some(x => !x.ownerId) ? "Tiene varios prospectos abiertos en Pipedrive y ninguno es tuyo: quedó en la organización." : "Tiene prospectos abiertos de otras personas: quedó en la organización."); return null; }
  // la investigación encontró un prospecto suelto (sin organización) de otra persona para este colegio: no se crea otro
  const other = getMatch(id)?.leadOther;
  if (other) { warnings.push(`Ya hay un prospecto de ${other.owner || "otra persona"} para este colegio en Pipedrive («${other.title}»): no creé otro, quedó en la organización.`); return null; }
  const sum = schoolSummary(s);
  if (clientNow(sum, rec)) return null;
  if (exClientNow(sum, rec)) { warnings.push("Es ex cliente de OrderEAT: no creé un prospecto, quedó en la organización."); return null; }
  if (rec.ownerId && Number(rec.ownerId) !== me) { warnings.push(`La organización es de ${rec.ownerName || "otra persona"}: no creé un prospecto, quedó en la organización.`); return null; }
  // nadie más lo está creando a la vez (otra instancia o «Crear prospecto»): se vuelve a mirar adentro del candado
  return withLock("prospect:" + id, async () => {
    if (!rec.created) { const again = await leadsHere(s, rec.orgId).catch(() => []); const x = pickContactLead(again, null, me); if (x && (!x.ownerId || Number(x.ownerId) === me)) return keep(x, false); if (again.length) { warnings.push("Ya hay otro prospecto abierto para este colegio: quedó en la organización."); return null; } }
    let lead;
    try { lead = await newLead(id, rec, user, { personId }); }
    catch (e) { warnings.push(`No pude crear el prospecto en Pipedrive (${e.message}): quedó en la organización.`); return null; }
    done.push({ label: `Prospecto creado a tu nombre: «${lead.title || s.name}»`, url: leadUrlOf(lead.id) });
    if (!OPTIONS.pais[s.country]) warnings.push(s.country ? paisWarn(s.country) : "No supe el país del colegio: el campo País del prospecto quedó sin completar.");
    return keep({ ...lead, title: lead.title || s.name }, true);
  });
}
// El prospecto abierto tuyo o libre de la organización (sin trato abierto), sin escribir nada: para notas de datos (estudio).
export async function openLeadFor(id, rec, me) {
  if (!rec?.orgId || rec.openDealId) return null;
  const open = await leadsHere(byId.get(id), rec.orgId).catch(() => []);
  const l = pickContactLead(open, byId.get(id)?.leadId || getMatch(id)?.leadId || rec.leadId || null, me);
  return l && (!l.ownerId || Number(l.ownerId) === Number(me)) ? l : null;
}
// Después de crear un prospecto: Enriquecer completa sus campos vacíos y deja la nota «Datos del colegio» en él. Con tope de
// tiempo (en Vercel no hay segundo plano): si no termina, se avisa que quedó pendiente (en un servidor común sigue y termina
// solo). Nunca tira error: lo registrado ya quedó.
export const ENRICH_WAIT = { ms: Number(process.env.ENRICH_WAIT_MS) || 4000 };
export async function enrichNewLead(id, user, done, by = "") {
  let timer;
  const job = enrichSchool(id, user, by, { photos: false }).catch(e => ({ failed: e }));
  const r = await Promise.race([job, new Promise(ok => { timer = setTimeout(ok, ENRICH_WAIT.ms, null); })]).finally(() => clearTimeout(timer));
  if (!r) { done.push({ label: "Sigo buscando los datos del colegio para el prospecto. Si en un rato no están, tocá «Enriquecer».", pending: true }); return { pending: true }; }
  if (r.failed) { done.push({ label: `No pude completar los datos del prospecto (${r.failed.message}). Tocá «Enriquecer».`, warn: true }); return { failed: true }; }
  if (r.fields?.saved?.length) done.push({ label: `Datos completados en el prospecto: ${joinY(r.fields.saved)}`, url: r.fields.url });
  if (r.fields?.reason) done.push({ label: r.fields.reason, warn: true });
  if (r.note?.saved) done.push({ label: "Nota «Datos del colegio» en el prospecto", url: r.note.url });
  return r;
}
// Se trabajó con esta organización (contacto, comentario, mail): el cruce queda confirmado y ya no se recalcula solo
export async function markWorked(id, rec) {
  const fresh = await checkSchool(id, { force: true }).catch(() => getMatch(id));
  if (fresh?.orgId && fresh.orgId === rec?.orgId && (!fresh.confirmed || fresh.auto)) setMatch(id, { ...fresh, confirmed: true, auto: false });
}
