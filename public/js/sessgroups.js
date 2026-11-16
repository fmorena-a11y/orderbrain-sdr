// Secciones de la vista Sesiones (#/sesiones, public/js/sessionsview.js). Puro, sin DOM ni imports: se prueba en
// test/sessions-view.test.mjs. Recibe la lista de GET /api/sessions ({ open, done }, solo resúmenes) y la reparte:
// - «De hoy»: abiertas con movimiento hoy (lastAt) o creadas hoy, en la zona de quien mira.
// - «Activas»: todas las abiertas.
// - «Inactivas»: abiertas sin movimiento hace INACTIVE_DAYS días o más (a los 30 el servidor las termina solas).
// - «Terminadas»: las que guarda el servidor (14 días, hasta 20).
// «Movimiento» es lo que cuenta el servidor en lastAt: un contacto, un comentario, un salteo o moverse de colegio.
export const INACTIVE_DAYS = 3;
const DAY_MS = 864e5;
// YYYY-MM-DD en la zona de quien mira (tz: la del navegador si no viene otra)
export function localDay(t, tz) {
  const d = new Date(typeof t === "number" ? t : Date.parse(t));
  if (Number.isNaN(d.getTime())) return "";
  try { return new Intl.DateTimeFormat("sv", { timeZone: tz || undefined, year: "numeric", month: "2-digit", day: "2-digit" }).format(d); }
  catch { return d.toLocaleDateString("sv"); }
}
const lastOf = v => v.lastAt || v.updatedAt || v.createdAt;
// días enteros sin movimiento (0 si se movió hace menos de un día)
export const idleDays = (v, now = Date.now()) => Math.max(0, Math.floor((now - Date.parse(lastOf(v))) / DAY_MS));
export const isIdle = (v, now = Date.now()) => v.status === "open" && now - Date.parse(lastOf(v)) >= INACTIVE_DAYS * DAY_MS;
export function isToday(v, now = Date.now(), tz) {
  const t = localDay(now, tz);
  return v.status === "open" && (localDay(lastOf(v), tz) === t || localDay(v.createdAt, tz) === t);
}
const recent = (a, b) => String(lastOf(b)).localeCompare(String(lastOf(a)));
export function sessionGroups(list, { now = Date.now(), tz } = {}) {
  const open = (list?.open || []).filter(v => v?.status === "open").sort(recent);
  const done = [...(list?.done || [])].sort((a, b) => String(b.endedAt || "").localeCompare(String(a.endedAt || "")));
  return { hoy: open.filter(v => isToday(v, now, tz)), activas: open, inactivas: open.filter(v => isIdle(v, now)), terminadas: done };
}
export const TABS = [["hoy", "De hoy"], ["activas", "Activas"], ["inactivas", "Inactivas"], ["terminadas", "Terminadas"]];
