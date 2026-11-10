// Archivar colegios en la app (como en Pipedrive): reglas puras. La escritura está en lib/sales.js (archiveSchool).
export const ARCHIVE_REASONS = ["No es un colegio", "Cerró", "No tiene cafetería", "Duplicado", "No le interesa", "Otro"];
const bad = (msg, status = 400) => ({ msg, status });
// Quién puede archivar: no un cliente, no un trato abierto de otra persona (salvo un líder), no dos veces.
// dealOwner: dueño del trato abierto (null si no se sabe: entonces solo un líder).
export function archiveError({ status, dealOwner = null, me = null, leader = false, archived = false, reason, text = "" }) {
  if (archived) return bad("Ya está archivado.", 409);
  if (status === "client") return bad("Es cliente de OrderEAT: no se archiva.", 409);
  if (status === "open" && !leader && !(dealOwner && me && Number(dealOwner) === Number(me))) return bad("Tiene un trato abierto de otra persona: no lo podés archivar.", 403);
  if (!ARCHIVE_REASONS.includes(reason)) return bad("Elegí el motivo.");
  if (reason === "Otro" && !String(text || "").trim()) return bad("Contá el caso: con «Otro» es obligatorio.");
  return null;
}
// En Pipedrive solo se toca lo tuyo o lo libre: los prospectos abiertos tuyos (o sin dueño) se archivan y la organización
// tuya (o libre) lleva la nota. Lo de otra persona queda igual (se archiva solo en la app y se avisa).
const mineOrFree = (owner, me) => !owner || (!!me && Number(owner) === Number(me));
export function archivePlan({ leads = [], org = null, me = null }) {
  const open = leads.filter(l => l && !l.archived);
  return { archive: open.filter(l => mineOrFree(l.ownerId, me)), others: open.filter(l => !mineOrFree(l.ownerId, me)), orgNote: !!org && mineOrFree(org.ownerId, me), orgOthers: !!org && !mineOrFree(org.ownerId, me) };
}
// Desarchivar: quien lo archivó o un líder.
export const canUnarchive = (rec, email, leader = false) => !!rec && (leader || String(rec.by || "").toLowerCase() === String(email || "").toLowerCase());
