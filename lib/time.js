// Fechas: Pipedrive guarda la hora de las actividades en UTC.
const validTz = tz => { try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; } };
export const safeTz = tz => (tz && validTz(tz) ? tz : process.env.DEFAULT_TZ || "America/Montevideo");

function offsetMin(d, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(d).map(x => [x.type, x.value]));
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
export const todayIn = tz => new Intl.DateTimeFormat("sv-SE", { timeZone: safeTz(tz) }).format(new Date());

export function addBusinessDays(date, n) {
  const d = new Date(date + "T12:00:00Z");
  let left = n;
  while (left > 0) { d.setUTCDate(d.getUTCDate() + 1); const w = d.getUTCDay(); if (w !== 0 && w !== 6) left--; }
  return d.toISOString().slice(0, 10);
}
export const addDays = (date, n) => { const d = new Date(date + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export const DAYS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
export const weekday = date => DAYS[new Date(date + "T12:00:00Z").getUTCDay()];
