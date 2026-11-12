// Calendario del account (quien da las demos): cuándo está libre, para proponerle horarios al colegio.
// Fuentes (lib/accounts.js decide cuál usa):
//  A) la «Dirección secreta en formato iCal» de su Google Calendar (o el .ics publicado de Outlook), que el account pega una
//     vez en su perfil. Se guarda cifrada y nunca vuelve al navegador ni a los logs. El servidor baja el .ics (con tope de
//     tamaño y tiempo) y saca SOLO bloques ocupados: nunca títulos, lugares, invitados ni descripciones.
//  B) con Google configurado (GOOGLE_CLIENT_ID/SECRET) y el Google de quien mira conectado: POST /calendar/v3/freeBusy con el
//     email del account (dentro del Workspace el libre/ocupado de un compañero se ve).
//  y siempre las actividades de Pipedrive del account con hora (ocupado o tipo demo).
// Lo puro (URL permitida, .ics → bloques, huecos, sugerencias, zonas y formato) está arriba y se prueba en
// test/calendar.test.mjs. Las recurrencias las expande ical.js (Mozilla): RRULE, RDATE, EXDATE y RECURRENCE-ID.
import ICAL from "ical.js";
import { MARKETS } from "./config.js";

const bad = (msg, status = 400, code = "") => Object.assign(new Error(msg), { status, code });
const MIN = 60e3, DAY = 864e5;
export const DEFAULT_HOURS = { days: [1, 2, 3, 4, 5], from: "09:00", to: "18:00" };
export const DURATIONS = [30, 45, 60];
export const MARGIN_MIN = 15, LEAD_MIN = 120, STEP_MIN = 30, BUSINESS_DAYS = 10;
// el colegio recibe la propuesta: nada antes de las 8 ni después de las 18 de allá, ni el fin de semana
export const SCHOOL_HOURS = ["08:00", "18:00"];
export const DOW = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
export const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

// ---------- zonas horarias (Intl, sin dependencias)
const fmts = new Map();
const fmtOf = tz => {
  let f = fmts.get(tz);
  if (!f) { f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short" }); fmts.set(tz, f); }
  return f;
};
export const validTz = tz => { if (!tz || typeof tz !== "string") return false; try { fmtOf(tz); return true; } catch { return false; } };
const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const pad = n => String(n).padStart(2, "0");
// fecha y hora en una zona: { y, m, d, h, mi, dow, date: "YYYY-MM-DD", time: "HH:MM" }
export function partsIn(ms, tz) {
  const p = Object.fromEntries(fmtOf(tz).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  const y = +p.year, m = +p.month, d = +p.day, h = +p.hour % 24, mi = +p.minute;
  return { y, m, d, h, mi, s: +p.second, dow: WD[p.weekday], date: `${y}-${pad(m)}-${pad(d)}`, time: `${pad(h)}:${pad(mi)}` };
}
// minutos al este de UTC en ese momento
export function offsetMin(ms, tz) { const p = partsIn(ms, tz); return Math.round((Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000) / MIN); }
// hora de pared en una zona → instante (ms). En el salto de horario (la hora que no existe) queda la de después.
export function wallToUtc(y, m, d, h = 0, mi = 0, s = 0, tz = "UTC") {
  const guess = Date.UTC(y, m - 1, d, h, mi, s);
  const o1 = offsetMin(guess, tz), t1 = guess - o1 * MIN, o2 = offsetMin(t1, tz);
  return o2 === o1 ? t1 : guess - o2 * MIN;
}
const ymd = date => date.split("-").map(Number);
export const atLocal = (date, time, tz) => { const [y, m, d] = ymd(date), [h, mi] = String(time || "00:00").split(":").map(Number); return wallToUtc(y, m, d, h, mi, 0, tz); };
export const addDaysTo = (date, n) => { const [y, m, d] = ymd(date); return new Date(Date.UTC(y, m - 1, d + n, 12)).toISOString().slice(0, 10); };
export const dowOf = date => { const [y, m, d] = ymd(date); return new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay(); };

// Zona del colegio (para mostrar los horarios y decirlos en el mensaje): la del país en MARKETS; en México, el huso de la ciudad
// (MX_HUSOS) o, sin ciudad conocida, por la longitud. place: lo que va en «(hora de …)». sure: false si no se sabe el huso
// (se usa el del centro del país y se avisa).
const norm = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
export function schoolZone(s, markets = MARKETS) {
  const m = markets[s?.country];
  if (!m?.tz) return { tz: "America/Mexico_City", place: s?.country || "México", sure: false };
  if (!m.husos) return { tz: m.tz, place: s.country, sure: true };
  const c = norm(s.city);
  for (const [tz, list] of Object.entries(m.husos)) { const hit = c && list.find(x => norm(x) === c); if (hit) return { tz, place: hit, sure: true }; }
  if (typeof s.lng === "number" && s.lng >= m.husoLng[0] && s.lng <= m.husoLng[1]) return { tz: m.tz, place: s.country, sure: true };
  return { tz: m.tz, place: s.country, sure: false };
}

// ---------- la dirección del calendario: solo Google Calendar (dirección secreta o pública en formato iCal) u Outlook
// publicado. Nada de otros hosts, puertos, usuarios, consultas ni http (SSRF). En el demo, además, http://127.0.0.1 o
// localhost (para probar con un .ics servido en la máquina).
const GOOGLE_PATH = /^\/calendar\/ical\/[^/?#\s]{3,200}\/(private-[0-9a-f]{16,64}|public)\/basic\.ics$/i;
const OUTLOOK_HOSTS = new Set(["outlook.office365.com", "outlook.office.com", "outlook.live.com"]);
const OUTLOOK_PATH = /^\/owa\/calendar\/[^/?#\s]{3,200}\/[^/?#\s]{3,200}\/(calendar|reachcalendar)\.ics$/i;
export const URL_HELP = "Tiene que ser la «Dirección secreta en formato iCal» de tu Google Calendar (empieza con https://calendar.google.com/calendar/ical/…).";
export function validateIcsUrl(raw, { demo = false } = {}) {
  const s = String(raw ?? "").trim();
  if (!s) return { error: "Pegá la dirección de tu calendario." };
  if (s.length > 600 || /[\s<>"'`\\]/.test(s)) return { error: URL_HELP };
  let u; try { u = new URL(s.replace(/^webcal:\/\//i, "https://")); } catch { return { error: URL_HELP }; }
  if (u.username || u.password || u.hash) return { error: URL_HELP };
  const host = u.hostname.toLowerCase();
  if (demo && u.protocol === "http:" && (host === "127.0.0.1" || host === "localhost") && /\.ics$/i.test(u.pathname) && !u.search) return { ok: true, url: u.toString(), kind: "test" };
  if (u.protocol !== "https:" || (u.port && u.port !== "443") || u.search) return { error: URL_HELP };
  if (host === "calendar.google.com" && GOOGLE_PATH.test(u.pathname)) return { ok: true, url: `https://calendar.google.com${u.pathname}`, kind: "google" };
  if (OUTLOOK_HOSTS.has(host) && OUTLOOK_PATH.test(u.pathname)) return { ok: true, url: `https://${host}${u.pathname}`, kind: "outlook" };
  return { error: URL_HELP };
}
// el email del dueño del calendario que dice la dirección de Google (para saber qué invitaciones rechazó)
export function calendarOwnerOf(url) {
  const m = /\/calendar\/ical\/([^/]+)\//.exec(String(url || "")); if (!m) return "";
  let id = ""; try { id = decodeURIComponent(m[1]); } catch { return ""; }
  return /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(id) ? id.toLowerCase() : "";
}

// ---------- .ics → bloques ocupados [inicio, fin] en ms. No bloquean: STATUS:CANCELLED, TRANSP:TRANSPARENT («libre»: los
// cumpleaños y feriados de día entero), X-MICROSOFT-CDO-BUSYSTATUS:FREE, ni una invitación que el dueño rechazó
// (PARTSTAT=DECLINED en su ATTENDEE). Un día entero opaco («fuera de la oficina») bloquea el día en la zona del account.
// owners: emails del dueño (el del account y el de la dirección). tz: zona del account (días enteros y horas sin zona).
const lc = s => String(s || "").trim().toLowerCase();
function blocks(comp, owners) {
  if (lc(comp.getFirstPropertyValue("status")) === "cancelled") return false;
  if (lc(comp.getFirstPropertyValue("transp")) === "transparent") return false;
  if (lc(comp.getFirstPropertyValue("x-microsoft-cdo-busystatus")) === "free") return false;
  for (const a of comp.getAllProperties("attendee")) {
    const who = lc(String(a.getFirstValue() || "").replace(/^mailto:/i, ""));
    if (owners.has(who) && lc(a.getParameter("partstat")) === "declined") return false;
  }
  return true;
}
// instante de un ICAL.Time: con TZID de la IANA (Google), por Intl; con VTIMEZONE propio (Outlook), lo que dice el archivo;
// en UTC («Z»), tal cual; sin zona (flotante), en la zona del calendario
function msOf(t, tzid, { tz, floatTz }) {
  if (t.isDate) return wallToUtc(t.year, t.month, t.day, 0, 0, 0, tz);
  if (t.zone === ICAL.Timezone.utcTimezone || t.zone?.tzid === "UTC") return Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second);
  if (tzid && validTz(tzid)) return wallToUtc(t.year, t.month, t.day, t.hour, t.minute, t.second, tzid);
  if (t.zone && t.zone !== ICAL.Timezone.localTimezone && t.zone.tzid && t.zone.tzid !== "floating") return t.toUnixTime() * 1000;
  return wallToUtc(t.year, t.month, t.day, t.hour, t.minute, t.second, floatTz);
}
const tzidOf = (comp, name) => comp.getFirstProperty(name)?.getParameter("tzid") || "";
// ical.js rechaza el archivo entero si un solo evento está mal escrito (una RRULE rara): entonces se lee de a un evento y se
// saltean los que no se entienden. Si lo de afuera (el calendario) no se entiende, no es un iCal.
const BAD_ICS = () => bad("El calendario no se pudo leer (el archivo no es un iCal válido).", 422, "ics_parse");
function parseCalendar(text) {
  const src = String(text || "");
  try { const c = new ICAL.Component(ICAL.parse(src)); if (c.name === "vcalendar") return c; } catch { /* de a uno */ }
  const events = src.match(/^BEGIN:VEVENT\r?$[\s\S]*?^END:VEVENT\r?$/gim) || [];
  let cal;
  try { cal = new ICAL.Component(ICAL.parse(src.replace(/^BEGIN:VEVENT\r?$[\s\S]*?^END:VEVENT\r?$\n?/gim, ""))); } catch { throw BAD_ICS(); }
  if (cal.name !== "vcalendar") throw BAD_ICS();
  for (const e of events) {
    try { const one = new ICAL.Component(ICAL.parse(`BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${e}\r\nEND:VCALENDAR\r\n`)); const ve = one.getFirstSubcomponent("vevent"); if (ve) cal.addSubcomponent(ve); } catch { /* ese evento no se entiende */ }
  }
  return cal;
}
// maxPerEvent: tope de ocurrencias por serie (una diaria desde el 2000 son ≈ 10.000)
export function busyFromIcs(text, { from, to, owners = [], tz = "UTC", maxPerEvent = 50000 } = {}) {
  const cal = parseCalendar(text);
  const wr = cal.getFirstPropertyValue("x-wr-timezone"), name = cal.getFirstPropertyValue("x-wr-calname");
  const own = new Set([...owners, name].map(lc).filter(e => e.includes("@")));
  const zones = { tz: validTz(tz) ? tz : "UTC", floatTz: validTz(wr) ? wr : validTz(tz) ? tz : "UTC" };
  const out = [];
  const add = (s, e) => { if (Number.isFinite(s) && Number.isFinite(e) && e > s && e > from && s < to) out.push([s, e]); };
  // por UID: el evento (o la serie) y sus excepciones (RECURRENCE-ID)
  const groups = new Map();
  for (const ve of cal.getAllSubcomponents("vevent")) {
    const uid = String(ve.getFirstPropertyValue("uid") || "") || `__${groups.size}`;
    const g = groups.get(uid) || { master: null, ex: [] };
    if (ve.hasProperty("recurrence-id")) g.ex.push(ve); else if (!g.master) g.master = ve; else groups.set(`${uid}__${groups.size}`, { master: ve, ex: [] });
    groups.set(uid, g);
  }
  for (const { master, ex } of groups.values()) {
    if (master) {
      let ev;
      try { ev = new ICAL.Event(master, { exceptions: ex }); } catch { ev = null; }
      if (ev && master.hasProperty("dtstart")) {
        const on = blocks(master, own), sTz = tzidOf(master, "dtstart"), eTz = tzidOf(master, "dtend") || sTz;
        try {
          if (ev.isRecurring()) {
            const it = ev.iterator();
            for (let n = 0, next; n < maxPerEvent && (next = it.next()); n++) {
              // la hora de pared leída como UTC difiere del instante en menos de un día: lo lejano se saltea sin convertir
              const wall = Date.UTC(next.year, next.month - 1, next.day, next.hour, next.minute);
              if (wall < from - 2 * DAY) continue;
              if (wall > to + 2 * DAY) break;
              const det = ev.getOccurrenceDetails(next);
              const s = msOf(det.startDate, sTz, zones);
              if (s >= to) break;
              if (det.item !== ev || !on) continue; // la excepción va aparte, con lo suyo
              add(s, msOf(det.endDate, sTz, zones));
            }
          } else if (on) add(msOf(ev.startDate, sTz, zones), msOf(ev.endDate, master.hasProperty("dtend") ? eTz : sTz, zones));
        } catch { /* una serie rota no tira el calendario entero */ }
      }
    }
    // excepciones: el horario nuevo de esa ocurrencia (o cancelada, o «libre»)
    for (const x of ex) {
      try {
        if (!x.hasProperty("dtstart") || !blocks(x, own)) continue;
        const xe = new ICAL.Event(x), sTz = tzidOf(x, "dtstart"), eTz = tzidOf(x, "dtend") || sTz;
        add(msOf(xe.startDate, sTz, zones), msOf(xe.endDate, x.hasProperty("dtend") ? eTz : sTz, zones));
      } catch { /* sigue */ }
    }
  }
  return out.sort((a, b) => a[0] - b[0]);
}
// junta los bloques que se pisan o se tocan
export function mergeBlocks(list) {
  const out = [];
  for (const [s, e] of [...list].sort((a, b) => a[0] - b[0])) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e); else out.push([s, e]);
  }
  return out;
}

// ---------- actividades de Pipedrive del account: las que tienen hora y ocupan (busy o demo). Pipedrive guarda la hora en UTC.
const durMin = v => { if (typeof v === "number") return v; const m = /^(\d{1,2}):(\d{2})/.exec(String(v || "")); return m ? +m[1] * 60 + +m[2] : 0; };
export function busyFromActivities(acts = []) {
  const out = [];
  for (const a of acts) {
    const t = String(a.due_time || "").slice(0, 5);
    if (a.done || !a.due_date || !/^\d{2}:\d{2}$/.test(t)) continue;
    if (!(a.busy === true || a.busy_flag === true || a.type === "meeting")) continue;
    const s = Date.parse(`${a.due_date}T${t}:00Z`), d = durMin(a.duration) || (a.type === "meeting" ? 60 : 30);
    if (Number.isFinite(s)) out.push([s, s + d * MIN]);
  }
  return out;
}

// ---------- horario para demos del account: días (0 domingo … 6 sábado) y de qué hora a qué hora, en SU zona
const HM = /^([01]\d|2[0-3]):([0-5]\d)$/;
export function cleanHours(h) {
  if (!h || typeof h !== "object") return null;
  const days = [...new Set((Array.isArray(h.days) ? h.days : []).map(Number).filter(d => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
  const from = String(h.from || ""), to = String(h.to || "");
  if (!days.length) return { error: "Elegí al menos un día." };
  if (!HM.test(from) || !HM.test(to) || +from.slice(3) % 15 || +to.slice(3) % 15) return { error: "Poné las horas de a 15 minutos (por ejemplo 09:00 a 18:00)." };
  if (from >= to) return { error: "La hora de inicio tiene que ser antes que la de fin." };
  if ((+to.slice(0, 2) * 60 + +to.slice(3)) - (+from.slice(0, 2) * 60 + +from.slice(3)) < 60) return { error: "Dejá al menos una hora para demos." };
  return { days, from, to };
}

// ---------- huecos libres: los próximos `days` días hábiles del account (sus días de demos, desde hoy en su zona), en su
// horario, de `duration` minutos, cada STEP_MIN, con `margin` minutos libres antes y después de lo ocupado, nada antes de
// `lead` minutos desde ahora y, del lado del colegio, de lunes a viernes entre SCHOOL_HOURS (hora de allá).
export function freeSlots({ busy = [], hours = DEFAULT_HOURS, tz, schoolTz = tz, duration = 30, margin = MARGIN_MIN, now = Date.now(), lead = LEAD_MIN,
  days = BUSINESS_DAYS, step = STEP_MIN, schoolHours = SCHOOL_HOURS, maxCalendarDays = 31 } = {}) {
  const h = hours?.days?.length ? hours : DEFAULT_HOURS, B = mergeBlocks(busy), dur = duration * MIN, gap = margin * MIN, min = now + lead * MIN;
  const out = [], dayList = [];
  let date = partsIn(now, tz).date;
  for (let i = 0; i < maxCalendarDays && dayList.length < days; i++, date = addDaysTo(date, 1)) {
    if (!h.days.includes(dowOf(date))) continue;
    dayList.push(date);
    const end = atLocal(date, h.to, tz);
    for (let t = atLocal(date, h.from, tz); t + dur <= end; t += step * MIN) {
      if (t < min) continue;
      const e = t + dur;
      if (B.some(([b0, b1]) => t < b1 + gap && e > b0 - gap)) continue;
      if (schoolHours) {
        const sp = partsIn(t, schoolTz), ep = partsIn(e, schoolTz);
        if (sp.dow === 0 || sp.dow === 6 || sp.date !== ep.date || sp.time < schoolHours[0] || ep.time > schoolHours[1]) continue;
      }
      out.push({ start: t, end: e });
    }
  }
  return { slots: out, days: dayList, until: dayList.length ? atLocal(addDaysTo(dayList[dayList.length - 1], 1), "00:00", tz) : now };
}

// ---------- tres propuestas en días distintos (del colegio): una de mañana y una de tarde cuando se pueda, en horas «redondas»
// cerca de las 10 y de las 16 de allá. Si hay al menos tres días que no son hoy, hoy no se propone.
const minsOf = time => +time.slice(0, 2) * 60 + +time.slice(3, 5);
export function pickSuggestions(slots, schoolTz, { now = Date.now(), n = 3 } = {}) {
  const today = partsIn(now, schoolTz).date, byDay = new Map();
  for (const sl of slots) { const p = partsIn(sl.start, schoolTz); const l = byDay.get(p.date) || []; l.push({ ...sl, time: p.time, part: p.h < 12 ? "am" : "pm" }); byDay.set(p.date, l); }
  let dates = [...byDay.keys()].sort();
  if (dates.filter(d => d !== today).length >= n) dates = dates.filter(d => d !== today);
  const best = (list, part) => {
    const c = list.filter(x => x.part === part); if (!c.length) return null;
    const target = part === "am" ? 600 : 960, score = x => Math.abs(minsOf(x.time) - target) + (x.time.endsWith(":00") ? 0 : 20);
    return c.reduce((a, b) => (score(b) < score(a) ? b : a));
  };
  const picks = [];
  for (const d of dates) {
    if (picks.length >= n) break;
    const want = picks.length % 2 === 0 ? "am" : "pm", list = byDay.get(d);
    picks.push(best(list, want) || best(list, want === "am" ? "pm" : "am"));
  }
  // si quedaron todas de mañana (o de tarde) y alguno de esos días tiene la otra, se cambia la última que se pueda
  const parts = new Set(picks.map(x => x.part));
  if (picks.length >= 2 && parts.size === 1) {
    const other = [...parts][0] === "am" ? "pm" : "am";
    for (let i = picks.length - 1; i >= 1; i--) { const alt = best(byDay.get(partsIn(picks[i].start, schoolTz).date), other); if (alt) { picks[i] = alt; break; } }
  }
  return picks.sort((a, b) => a.start - b.start);
}

// ---------- cómo se muestra un horario: en la hora del colegio y, si es distinta, en la de quien mira
export function slotView(sl, schoolTz, viewerTz) {
  const p = partsIn(sl.start, schoolTz), v = partsIn(sl.start, viewerTz), same = p.date === v.date && p.time === v.time;
  return { at: new Date(sl.start).toISOString(), end: new Date(sl.end).toISOString(), date: p.date, time: p.time, part: p.h < 12 ? "am" : "pm",
    label: `${DOW[p.dow]} ${p.d}`, vDate: v.date, vTime: v.time, ...(same ? {} : { mine: v.date === p.date ? v.time : `${DOW[v.dow].slice(0, 3)} ${v.d} ${v.time}` }) };
}
// «el martes 17 a las 10:00» (con el mes si no es el de hoy)
export function whenText(date, time, today = "") {
  const [y, m, d] = ymd(date), dow = DOW[dowOf(date)];
  return `el ${dow} ${d}${today && today.slice(0, 7) !== date.slice(0, 7) ? ` de ${MONTHS[m - 1]}` : ""} a las ${time}`;
}
export const joinOr = list => list.length <= 1 ? list.join("") : `${list.slice(0, -1).join(", ")} o ${list[list.length - 1]}`;

// ---------- red. Errores sin la dirección (es secreta) ni el contenido.
// Baja el .ics: sin seguir redirecciones a otro lado (cada una se vuelve a validar), con tope de tiempo y de tamaño.
export const MAX_ICS_BYTES = 8 * 1024 * 1024;
export async function fetchIcs(url, { fetchImpl = globalThis.fetch, timeoutMs = 8000, maxBytes = MAX_ICS_BYTES, demo = false } = {}) {
  let cur = url;
  for (let hop = 0; hop < 3; hop++) {
    const v = validateIcsUrl(cur, { demo });
    if (!v.ok) throw bad("La dirección del calendario no es válida.", 400, "ics_url");
    let r;
    try { r = await fetchImpl(v.url, { redirect: "manual", headers: { accept: "text/calendar, */*;q=0.5", "user-agent": "OrderBrain-SDR/2 (calendario)" }, signal: AbortSignal.timeout(timeoutMs) }); }
    catch (e) { throw bad(e?.name === "TimeoutError" || e?.name === "AbortError" ? "El calendario tardó demasiado en responder." : "No pude conectar con el calendario.", 502, "ics_down"); }
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get("location"); await r.body?.cancel?.().catch(() => {});
      if (!loc) throw bad("El calendario respondió con una redirección rara.", 502, "ics_down");
      try { cur = new URL(loc, v.url).toString(); } catch { throw bad("El calendario respondió con una redirección rara.", 502, "ics_down"); }
      continue;
    }
    if ([401, 403, 404, 410].includes(r.status)) { await r.body?.cancel?.().catch(() => {}); throw bad("Esa dirección ya no funciona: puede que se haya cambiado en Google Calendar. Pegá la nueva.", 409, "ics_gone"); }
    if (!r.ok) { await r.body?.cancel?.().catch(() => {}); throw bad(`El calendario respondió ${r.status}.`, 502, "ics_down"); }
    if (Number(r.headers.get("content-length")) > maxBytes) { await r.body?.cancel?.().catch(() => {}); throw bad("El calendario es demasiado grande para leerlo.", 413, "ics_big"); }
    const chunks = []; let total = 0;
    try {
      const reader = r.body.getReader();
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        total += value.byteLength;
        if (total > maxBytes) { await reader.cancel().catch(() => {}); throw bad("El calendario es demasiado grande para leerlo.", 413, "ics_big"); }
        chunks.push(value);
      }
    } catch (e) { if (e.code === "ics_big") throw e; throw bad("El calendario tardó demasiado en responder.", 502, "ics_down"); }
    const text = Buffer.concat(chunks.map(c => Buffer.from(c))).toString("utf8");
    if (!/^﻿?\s*BEGIN:VCALENDAR/i.test(text)) throw bad("Esa dirección no devuelve un calendario. Revisá que sea la «Dirección secreta en formato iCal».", 422, "ics_parse");
    return text;
  }
  throw bad("El calendario redirige demasiadas veces.", 502, "ics_down");
}
// Google free/busy de un compañero (Fuente B): con el access token de quien mira (scope calendar.freebusy).
export const FREEBUSY_SCOPE = "https://www.googleapis.com/auth/calendar.freebusy";
export async function googleBusy({ token, email, from, to, fetchImpl = globalThis.fetch }) {
  let r;
  try {
    r = await fetchImpl("https://www.googleapis.com/calendar/v3/freeBusy", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ timeMin: new Date(from).toISOString(), timeMax: new Date(to).toISOString(), items: [{ id: email }] }), signal: AbortSignal.timeout(8000) });
  } catch { throw bad("Google no respondió.", 502, "fb_down"); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw bad(`Google respondió ${r.status}.`, 502, r.status === 401 || r.status === 403 ? "fb_scope" : "fb_down");
  const c = j?.calendars?.[email] || j?.calendars?.[lc(email)];
  if (!c || c.errors?.length) throw bad("Google no deja ver ese calendario.", 403, "fb_hidden");
  return (c.busy || []).map(b => [Date.parse(b.start), Date.parse(b.end)]).filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && e > s);
}
