// Fechas: Pipedrive guarda la hora de las actividades en UTC.
// Crear un Intl.DateTimeFormat cuesta ≈0,1 ms y se piden miles por pedido (la Agenda, Hoy, Métricas): se guarda uno por zona
// (y la respuesta de «¿es una zona válida?»). La zona llega del navegador (x-tz): con tope, para que no crezca sin fin.
const memo = make => { const m = new Map(); return tz => { let v = m.get(tz); if (v === undefined) { if (m.size >= 500) m.clear(); m.set(tz, v = make(tz)); } return v; }; };
const validTz = memo(tz => { try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; } });
export const safeTz = tz => (tz && validTz(tz) ? tz : process.env.DEFAULT_TZ || "America/Montevideo");
const partsFmt = memo(tz => new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }));
const dayFmt = memo(tz => new Intl.DateTimeFormat("sv-SE", { timeZone: tz }));

function offsetMin(d, tz) {
  const p = {}; for (const x of partsFmt(tz).formatToParts(d)) p[x.type] = x.value;
  return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - d.getTime()) / 60000;
}

// Fecha y hora locales (en tz) → fecha y hora UTC para Pipedrive. Sin hora, la fecha queda igual.
export function toUtc(date, time, tz) {
  if (!time) return { date, time: "" };
  const guess = new Date(`${date}T${time.slice(0, 5)}:00Z`);
  const utc = new Date(guess.getTime() - offsetMin(guess, safeTz(tz)) * 60000);
  return { date: utc.toISOString().slice(0, 10), time: utc.toISOString().slice(11, 16) };
}

// Fecha local de hoy (YYYY-MM-DD) en una zona horaria.
export const todayIn = (tz, now = Date.now()) => dayFmt(safeTz(tz)).format(new Date(now));

// Fecha y hora UTC de Pipedrive → fecha y hora locales (en tz). Sin hora, la fecha queda igual.
export function fromUtc(date, time, tz) {
  if (!time) return { date, time: "" };
  const d = new Date(`${date}T${time.slice(0, 5)}:00Z`), l = new Date(d.getTime() + offsetMin(d, safeTz(tz)) * 60000);
  return { date: l.toISOString().slice(0, 10), time: l.toISOString().slice(11, 16) };
}

// n negativo: días hábiles hacia atrás
export function addBusinessDays(date, n) {
  const d = new Date(date + "T12:00:00Z"), step = n < 0 ? -1 : 1;
  let left = Math.abs(n);
  while (left > 0) { d.setUTCDate(d.getUTCDate() + step); const w = d.getUTCDay(); if (w !== 0 && w !== 6) left--; }
  return d.toISOString().slice(0, 10);
}
// Día para confirmar una demo por WhatsApp: el día hábil anterior; si ya pasó (demo hoy, mañana o después del finde), hoy.
// Las dos fechas son locales (YYYY-MM-DD). Una demo pasada no lleva recordatorio (null).
export const confirmDay = (demoDate, today) => demoDate < today ? null : addBusinessDays(demoDate, -1) < today ? today : addBusinessDays(demoDate, -1);
export const addDays = (date, n) => { const d = new Date(date + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const DAYS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
export const weekday = date => DAYS[new Date(date + "T12:00:00Z").getUTCDay()];
