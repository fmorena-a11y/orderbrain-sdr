// DEMO_MODE: calendarios simulados de los accounts (Google Calendar «conectado» sin Google). Se arman como un .ics de verdad,
// relativo a hoy, y pasan por el mismo lector que uno real (lib/calendar.js): ocupados sueltos, una reunión semanal con una
// excepción, un día entero «fuera de la oficina» (bloquea), un cumpleaños de día entero «libre» (no bloquea), un evento
// cancelado y una invitación rechazada (no bloquean). Santiago Correa (Perú) no conectó su calendario.
import { partsIn, addDaysTo, dowOf } from "./calendar.js";

const stamp = (date, time) => `${date.replace(/-/g, "")}T${time.replace(":", "")}00`;
const busyDays = (today, n) => { const out = []; for (let d = today; out.length < n; d = addDaysTo(d, 1)) if (![0, 6].includes(dowOf(d))) out.push(d); return out; };
function ics(tz, email, events) {
  const ev = events.map(e => ["BEGIN:VEVENT", `UID:${e.uid}@demo.ordereat`, "DTSTAMP:20260101T000000Z",
    e.allDay ? `DTSTART;VALUE=DATE:${e.date.replace(/-/g, "")}` : `DTSTART;TZID=${tz}:${stamp(e.date, e.from)}`,
    e.allDay ? `DTEND;VALUE=DATE:${addDaysTo(e.date, 1).replace(/-/g, "")}` : `DTEND;TZID=${tz}:${stamp(e.date, e.to)}`,
    ...(e.rrule ? [`RRULE:${e.rrule}`] : []), ...(e.recurrenceId ? [`RECURRENCE-ID;TZID=${tz}:${e.recurrenceId}`] : []), ...(e.exdate ? [`EXDATE;TZID=${tz}:${e.exdate}`] : []),
    `SUMMARY:${e.title}`, ...(e.transp ? [`TRANSP:${e.transp}`] : []), ...(e.status ? [`STATUS:${e.status}`] : []),
    ...(e.declined ? [`ATTENDEE;CN=Account;PARTSTAT=DECLINED:mailto:${email}`] : []), "END:VEVENT"].join("\r\n"));
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//OrderBrain SDR//Demo//ES", `X-WR-CALNAME:${email}`, `X-WR-TIMEZONE:${tz}`, ...ev, "END:VCALENDAR", ""].join("\r\n");
}
// pdUserId → { tz, email, ics(now) }
export const DEMO_CALENDARS = {
  // Joaquín Márquez (México)
  24821777: { tz: "America/Mexico_City", email: "joaquin@ordereat.com", build(now = Date.now()) {
    const tz = this.tz, today = partsIn(now, tz).date, d = busyDays(addDaysTo(today, 1), 8), first = addDaysTo(today, -21);
    // la semanal (martes y jueves 10 a 11): una semana se movió a las 15
    const tue = d.find(x => dowOf(x) === 2) || d[1];
    return ics(tz, this.email, [
      { uid: "equipo", title: "Reunión de equipo (privado)", date: first, from: "10:00", to: "11:00", rrule: "FREQ=WEEKLY;BYDAY=TU,TH" },
      { uid: "equipo", title: "Reunión de equipo movida", date: tue, from: "15:00", to: "16:00", recurrenceId: stamp(tue, "10:00") },
      { uid: "demo1", title: "Demo Colegio Privado (secreto)", date: d[0], from: "12:00", to: "13:30" },
      { uid: "demo2", title: "Demo otra escuela", date: d[1], from: "16:00", to: "17:00" },
      { uid: "uno-a-uno", title: "1:1 con dirección", date: d[2], from: "09:00", to: "10:00" },
      { uid: "ooo", title: "Fuera de la oficina", date: d[4], allDay: true },
      { uid: "cumple", title: "Cumpleaños de Ana", date: d[0], allDay: true, transp: "TRANSPARENT" },
      { uid: "cancelada", title: "Reunión cancelada", date: d[1], from: "11:00", to: "12:00", status: "CANCELLED" },
      { uid: "rechazada", title: "Invitación rechazada", date: d[0], from: "15:00", to: "16:00", declined: true },
    ]);
  } },
  // Matías Favaro (Argentina)
  20758179: { tz: "America/Argentina/Buenos_Aires", email: "matias@ordereat.com", build(now = Date.now()) {
    const tz = this.tz, today = partsIn(now, tz).date, d = busyDays(addDaysTo(today, 1), 6);
    return ics(tz, this.email, [
      { uid: "planning", title: "Planning semanal", date: addDaysTo(today, -14), from: "09:00", to: "12:00", rrule: "FREQ=WEEKLY;BYDAY=MO" },
      { uid: "m1", title: "Onboarding cliente", date: d[0], from: "14:00", to: "15:30" },
      { uid: "m2", title: "Demo colegio", date: d[2], from: "10:00", to: "11:00" },
    ]);
  } },
};
export const demoIcsFor = (pdUserId, now) => DEMO_CALENDARS[Number(pdUserId)]?.build(now) || null;
