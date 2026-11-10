// Archivar colegios en la app (como en Pipedrive): reglas puras. La escritura está en lib/sales.js (archiveSchool).
export const ARCHIVE_REASONS = ["No es un colegio", "Cerró", "No tiene cafetería", "Duplicado", "No le interesa", "Otro"];
const bad = (msg, status = 400) => ({ msg, status });
// Quién puede archivar: no un cliente, no lo de otra persona (trato abierto, organización o prospecto; salvo un líder), no dos veces.
// dealOwner: dueño del trato abierto (null si no se sabe: entonces solo un líder). othersOwner: nombre del dueño ajeno de la
// organización o de un prospecto (archivePlan().otherOwner); el archivo vale para todo el equipo, así que lo ajeno no.
export function archiveError({ status, dealOwner = null, me = null, leader = false, archived = false, othersOwner = null, reason, text = "" }) {
  if (archived) return bad("Ya está archivado.", 409);
  if (status === "client") return bad("Es cliente de OrderEAT: no se archiva.", 409);
  if (status === "open" && !leader && !(dealOwner && me && Number(dealOwner) === Number(me))) return bad("Tiene un trato abierto de otra persona: no lo podés archivar.", 403);
  if (othersOwner && !leader) return bad(`Es de ${othersOwner === true ? "otra persona" : othersOwner}: hablalo con esa persona o con un líder.`, 403);
  if (!ARCHIVE_REASONS.includes(reason)) return bad("Elegí el motivo.");
  if (reason === "Otro" && !String(text || "").trim()) return bad("Contá el caso: con «Otro» es obligatorio.");
  return null;
}
// En Pipedrive solo se toca lo tuyo o lo libre: los prospectos abiertos tuyos (o sin dueño) se archivan y la organización
// tuya (o libre) lleva la nota. Lo de otra persona (solo lo archiva un líder) queda igual en Pipedrive y se avisa.
// otherOwner: el primer dueño ajeno (de un prospecto, de la organización o del cruce: ownerId), o null.
const mineOrFree = (owner, me) => !owner || (!!me && Number(owner) === Number(me));
export function archivePlan({ leads = [], org = null, me = null, ownerId = null }) {
  const open = leads.filter(l => l && !l.archived);
  return { archive: open.filter(l => mineOrFree(l.ownerId, me)), others: open.filter(l => !mineOrFree(l.ownerId, me)), orgNote: !!org && mineOrFree(org.ownerId, me), orgOthers: !!org && !mineOrFree(org.ownerId, me),
    otherOwner: [...leads.map(l => l?.ownerId), org?.ownerId, ownerId].find(o => o && !mineOrFree(o, me)) || null };
}
// Desarchivar: quien lo archivó, un líder o el dueño actual (organización o prospecto) en Pipedrive.
export const canUnarchive = (rec, email, leader = false, owner = false) => !!rec && (leader || owner || String(rec.by || "").toLowerCase() === String(email || "").toLowerCase());
