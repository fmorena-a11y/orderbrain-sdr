// Accounts y calendario (pedido del líder de SDR): cada SDR tiene, por país, el account (Account Executive) que da sus demos;
// «Proponer demo» y Registrar muestran cuándo está libre ese account para proponerle al colegio «¿podés tal día, tal hora?».
//  - Accounts por país: se guardan por email (personStore "accounts" de lib/store.js). Lo de DEFAULT_ACCOUNTS (lib/config.js)
//    se muestra como «(sugerido)» hasta que la persona confirma o cambia. Los edita la persona, dirección o el líder de su equipo
//    (las rutas, en lib/accounts-api.js). El account de un colegio sale del país del colegio.
//  - Calendario del account (personStore "calendars"): la dirección secreta iCal cifrada (enc, AES-256-GCM de lib/gmail.js) y su
//    horario para demos (por defecto lunes a viernes de 9 a 18 en SU zona de Pipedrive). Solo lo cambia el account.
//  - Libre/ocupado (lib/calendar.js): .ics del account o, si no, el free/busy de Google con el Google de quien mira; siempre
//    más sus actividades de Pipedrive con hora. Sin calendario no se afirma que está libre: los horarios van «sin confirmar».
// Privacidad: al navegador solo van bloques ocupados (inicio y fin) y horarios libres; nunca títulos ni detalles.
import crypto from "crypto";
import * as pd from "./pipedrive.js";
import { personStore, getProfiles, cacheGet, cacheSet } from "./store.js";
import { DEFAULT_ACCOUNTS, MARKETS, FREE_OWNERS } from "./config.js";
import { safeTz } from "./time.js";
import * as CAL from "./calendar.js";
import { encrypt, decrypt, accessToken, gmailEnabled, FREEBUSY_SCOPE } from "./gmail.js";
import { demoIcsFor, DEMO_CALENDARS } from "./calendar-demo.js";
import { demoSlotsMessage } from "./playbook.js";

const accStore = personStore("accounts"), calStore = personStore("calendars");
const lc = e => String(e || "").trim().toLowerCase();
const bad = (msg, status = 400, code = "") => Object.assign(new Error(msg), { status, code });
const DAY = 864e5, MIN = 60e3;
const isDemo = () => pd.DEMO;
const first = n => String(n || "").trim().split(/\s+/)[0] || "";

// ---------- puro (test/calendar.test.mjs)
// Países con los que arranca «Tus accounts» (después, «+ otro país»)
export const START_COUNTRIES = ["México", "Argentina", "Perú"];
// El account de un país: lo que eligió la persona (id, o null = «sin account») o lo sugerido de la cuenta. source: perfil | sugerido.
export function accountFor(country, stored = {}, defaults = DEFAULT_ACCOUNTS) {
  if (!country) return null;
  const s = stored?.[country];
  if (s && typeof s === "object" && "id" in s) return s.id ? { id: Number(s.id), source: "perfil" } : null;
  const d = defaults?.[country];
  return d ? { id: Number(d), source: "sugerido" } : null;
}
// Filas de «Tus accounts»: México, Argentina y Perú, lo sugerido y lo que ya eligió (solo países de MARKETS)
export function accountRows(stored = {}, defaults = DEFAULT_ACCOUNTS, start = START_COUNTRIES) {
  const list = [...new Set([...start, ...Object.keys(defaults || {}), ...Object.keys(stored || {})])].filter(c => Object.hasOwn(MARKETS, c));
  return list.map(c => { const a = accountFor(c, stored, defaults); return { country: c, id: a?.id ?? null, suggested: a?.source === "sugerido" }; });
}
// Lo que llega del navegador: { país: id | null }. Solo países de MARKETS y personas del Pipedrive.
export function cleanAccounts(input, { countries = Object.keys(MARKETS), userIds = new Set() } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { error: "No entendí los accounts." };
  const e = Object.entries(input);
  if (e.length > 40) return { error: "Son demasiados países." };
  const out = {};
  for (const [c, v] of e) {
    if (!countries.includes(c)) return { error: "Ese país no está en la lista." };
    const id = v === null || v === "" || v === 0 || v === "0" ? null : Number(v);
    if (id !== null && !(Number.isInteger(id) && userIds.has(id))) return { error: "Elegí una persona del Pipedrive de OrderEAT." };
    out[c] = id;
  }
  return { accounts: out };
}
// Personas para elegir: primero las que en la app son Account Executive (o accounts sugeridos de la cuenta), después el resto.
// Sin las cuentas generales de la empresa.
export function accountPeople(users = [], profiles = {}, defaults = DEFAULT_ACCOUNTS) {
  const dflt = new Set(Object.values(defaults || {}).map(Number));
  return users.filter(u => u?.id && !FREE_OWNERS.has(Number(u.id))).map(u => ({ id: Number(u.id), email: lc(u.email), name: profiles[lc(u.email)]?.name || u.name || "",
    ae: profiles[lc(u.email)]?.role === "ae" || dflt.has(Number(u.id)) }))
    .sort((a, b) => (b.ae - a.ae) || a.name.localeCompare(b.name, "es"));
}
// lo que va al navegador de una persona (sin email)
const personOut = p => ({ id: p.id, name: p.name, ae: p.ae });

// ---------- accounts por país (por email)
export async function accountsOf(email) { return (await accStore.get(email).catch(() => null))?.map || {}; }
export async function accountsView(email) {
  const [m, prs, rec] = await Promise.all([pd.meta(), getProfiles(), accStore.get(email).catch(() => null)]);
  const people = accountPeople(m.users, prs).filter(p => p.email !== lc(email));
  return { rows: accountRows(rec?.map || {}), people: people.map(personOut), countries: Object.keys(MARKETS).sort((a, b) => a.localeCompare(b, "es")),
    confirmed: !!rec, at: rec?.at || null, byOther: !!rec?.by && rec.by !== lc(email) ? (prs[rec.by]?.name || rec.by) : "" };
}
export async function saveAccounts(email, input, { by = "" } = {}) {
  const m = await pd.meta();
  const c = cleanAccounts(input, { userIds: new Set(m.users.map(u => Number(u.id))) });
  if (c.error) throw bad(c.error);
  await accStore.set(email, { map: Object.fromEntries(Object.entries(c.accounts).map(([k, id]) => [k, { id }])), at: new Date().toISOString(), by: lc(by || email) });
  return accountsView(email);
}

// ---------- el account (usuario de Pipedrive) y su zona
async function userById(id) { const m = await pd.meta(); return m.users.find(u => Number(u.id) === Number(id)) || null; }
async function userByEmail(email) { const m = await pd.meta(); return m.users.find(u => lc(u.email) === lc(email)) || null; }
// la zona de su usuario de Pipedrive; si no tiene, la del país del que es account sugerido; si no, la de la cuenta
const tzOfUser = u => CAL.validTz(u?.tz) ? u.tz : MARKETS[Object.keys(DEFAULT_ACCOUNTS).find(c => Number(DEFAULT_ACCOUNTS[c]) === Number(u?.id))]?.tz || safeTz();
const demoCal = id => isDemo() && !!DEMO_CALENDARS[Number(id)];

// ---------- su calendario (lo ve y lo cambia solo el account: email de la sesión)
export async function calendarView(email) {
  const [rec, u] = await Promise.all([calStore.get(email).catch(() => null), userByEmail(email)]);
  const sim = !rec?.enc && demoCal(u?.id);
  return { connected: !!rec?.enc || sim, kind: rec?.enc ? rec.kind || "google" : sim ? "google" : "", demo: sim, at: rec?.enc ? rec.at || null : null,
    hours: rec?.hours || CAL.DEFAULT_HOURS, custom: !!rec?.hours, tz: tzOfUser(u), place: tzPlace(tzOfUser(u)), ...(rec?.fail && rec.enc ? { problem: rec.fail.msg || "No pude leer tu calendario." } : {}) };
}
const countIn14 = (blocks, now) => blocks.filter(([s, e]) => e > now && s < now + 14 * DAY).length;
// Conectar: valida la dirección (lib/calendar.js), la prueba bajando el .ics y recién ahí la guarda cifrada.
export async function connectCalendar(email, url, { now = Date.now() } = {}) {
  const v = CAL.validateIcsUrl(url, { demo: isDemo() });
  if (v.error) throw bad(v.error, 400, "ics_url");
  const u = await userByEmail(email), tz = tzOfUser(u);
  const text = await CAL.fetchIcs(v.url, { demo: isDemo() });
  const blocks = CAL.busyFromIcs(text, { from: now, to: now + 14 * DAY, owners: [email, CAL.calendarOwnerOf(v.url)], tz });
  let enc; try { enc = encrypt(v.url); } catch { throw bad("Falta SESSION_SECRET en el servidor: no se puede guardar el calendario.", 500); }
  const prev = await calStore.get(email).catch(() => null);
  await calStore.set(email, { ...(prev || {}), enc, kind: v.kind, at: new Date(now).toISOString(), fail: null });
  return { ...(await calendarView(email)), events: countIn14(blocks, now) };
}
// Probar: «Veo N eventos en las próximas 2 semanas» (nunca títulos)
export async function testCalendar(email, { now = Date.now() } = {}) {
  const u = await userByEmail(email), rec = await calStore.get(email).catch(() => null);
  if (!rec?.enc && !demoCal(u?.id)) throw bad("Todavía no conectaste tu calendario.", 409, "ics_missing");
  const blocks = await icsBlocks({ email, id: u?.id, tz: tzOfUser(u) }, rec, { fresh: true, now });
  return { ...(await calendarView(email)), events: countIn14(blocks, now) };
}
export async function disconnectCalendar(email) {
  const rec = await calStore.get(email).catch(() => null);
  if (rec?.hours) await calStore.set(email, { hours: rec.hours }); else if (rec) await calStore.del(email);
  return calendarView(email);
}
export async function saveHours(email, hours) {
  const h = CAL.cleanHours(hours);
  if (!h || h.error) throw bad(h?.error || "Elegí días y horario.");
  const rec = await calStore.get(email).catch(() => null);
  await calStore.set(email, { ...(rec || {}), hours: h });
  return calendarView(email);
}

// ---------- ocupado del account. Copias: .ics y Google 5 minutos, Pipedrive 2. Un fallo del .ics, 1 minuto.
const WIN = now => ({ from: now - DAY, to: now + 32 * DAY });
const hashOf = s => crypto.createHash("sha256").update(String(s)).digest("base64url").slice(0, 16);
const errMem = new Map();
// marca (o limpia) el fallo releyendo lo guardado: solo si sigue siendo la misma conexión (si se desconectó o pegó otra
// dirección mientras tanto, no se toca: nunca vuelve una dirección vieja)
async function markFail(email, rec, fail) {
  const cur = await calStore.get(email).catch(() => null);
  if (cur?.enc && cur.at === rec.at && (fail || cur.fail)) await calStore.set(email, { ...cur, fail }).catch(() => {});
}
async function icsBlocks(acc, rec, { fresh = false, now = Date.now() } = {}) {
  const k = `calbusy:${hashOf(`${lc(acc.email)}|${rec?.enc ? rec.at : "demo"}`)}`;
  if (!fresh) {
    const c = await cacheGet(k); if (c && c.to >= now + 15 * DAY) return c.blocks;
    const e = errMem.get(k); if (e && e.exp > Date.now()) throw e.err;
  }
  const w = WIN(now);
  try {
    let text, owners = [acc.email];
    if (rec?.enc) {
      const url = decrypt(rec.enc);
      if (!url) throw bad("No pude leer la dirección guardada del calendario: hay que pegarla de nuevo.", 409, "ics_key");
      owners.push(CAL.calendarOwnerOf(url));
      text = await CAL.fetchIcs(url, { demo: isDemo() });
    } else text = demoIcsFor(acc.id, now);
    // sin juntar: «Probar» cuenta eventos (ocurrencias); para los huecos se juntan después
    const blocks = CAL.busyFromIcs(text, { ...w, owners, tz: acc.tz });
    await cacheSet(k, { blocks, to: w.to }, 300);
    if (rec?.fail) await markFail(acc.email, rec, null);
    return blocks;
  } catch (err) {
    errMem.set(k, { exp: Date.now() + 60e3, err });
    // la dirección dejó de andar: el account lo ve en su perfil
    if (rec?.enc && ["ics_gone", "ics_key", "ics_parse"].includes(err.code)) await markFail(acc.email, rec, { code: err.code, msg: err.message, at: new Date().toISOString() });
    throw err;
  }
}
const googleOn = () => !isDemo() && gmailEnabled() && !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
async function googleBlocks(viewerEmail, acc, now) {
  if (!googleOn() || !viewerEmail || !acc.email) return null;
  const k = `fbbusy:${hashOf(`${lc(viewerEmail)}|${lc(acc.email)}`)}`, c = await cacheGet(k);
  if (c && c.to >= now + 15 * DAY) return c.blocks;
  const token = await accessToken(viewerEmail, FREEBUSY_SCOPE); if (!token) return null;
  const w = WIN(now), blocks = await CAL.googleBusy({ token, email: acc.email, from: w.from, to: w.to });
  await cacheSet(k, { blocks, to: w.to }, 300);
  return blocks;
}
async function pipedriveBlocks(acc, now) {
  const w = WIN(now), from = new Date(w.from).toISOString().slice(0, 10), to = new Date(w.to).toISOString().slice(0, 10);
  const k = `pdbusy:${acc.id}:${from}`, c = await cacheGet(k); if (c) return c;
  const blocks = CAL.busyFromActivities(await pd.upcomingActivities(acc.id, from, to));
  await cacheSet(k, blocks, 120);
  return blocks;
}
// lo que se le dice a quien mira cuando falla el calendario de otro (sin la dirección ni el detalle)
const SAFE_MSG = { ics_gone: "La dirección de su calendario dejó de funcionar.", ics_down: "Su calendario no respondió.", ics_parse: "Su calendario no se pudo leer.", ics_big: "Su calendario es demasiado grande para leerlo.", ics_key: "Hay que volver a conectar su calendario.", ics_url: "La dirección guardada no es válida." };

// ---------- horarios libres del account para un colegio (GET /api/accounts/:id/free)
export async function freeFor(pdUserId, { school = null, viewerEmail = "", viewerTz = "UTC", duration = 30, days = CAL.BUSINESS_DAYS, now = Date.now() } = {}) {
  const u = await userById(pdUserId);
  if (!u || FREE_OWNERS.has(Number(u.id))) throw bad("Esa persona no está en el Pipedrive de OrderEAT.", 404);
  const [prs, rec] = await Promise.all([getProfiles(), calStore.get(u.email).catch(() => null)]);
  const name = prs[lc(u.email)]?.name || u.name || "", acc = { id: Number(u.id), email: lc(u.email), tz: tzOfUser(u) };
  const dur = CAL.DURATIONS.includes(Number(duration)) ? Number(duration) : 30, nDays = Math.max(1, Math.min(15, Number(days) || CAL.BUSINESS_DAYS));
  const zone = school ? CAL.schoolZone(school) : { tz: safeTz(viewerTz), place: "", sure: false }, vtz = safeTz(viewerTz);
  const blocks = [];
  let calendar = "missing", source = "pipedrive", problem = "";
  if (rec?.enc || demoCal(acc.id)) {
    try { blocks.push(...await icsBlocks(acc, rec, { now })); calendar = "ok"; source = "ics"; }
    catch (e) { calendar = "error"; problem = SAFE_MSG[e.code] || "Su calendario no respondió."; }
  }
  if (calendar !== "ok") {
    try { const g = await googleBlocks(viewerEmail, acc, now); if (g) { blocks.push(...g); calendar = "ok"; source = "google"; problem = ""; } } catch { /* sin Google: queda lo de antes */ }
  }
  let pipedrive = true;
  try { blocks.push(...await pipedriveBlocks(acc, now)); } catch { pipedrive = false; }
  const busy = CAL.mergeBlocks(blocks), hours = rec?.hours || CAL.DEFAULT_HOURS;
  const { slots, until } = CAL.freeSlots({ busy, hours, tz: acc.tz, schoolTz: zone.tz, duration: dur, now, days: nDays });
  const views = slots.map(sl => CAL.slotView(sl, zone.tz, vtz)), byDay = new Map();
  for (const v of views) { const l = byDay.get(v.date) || { date: v.date, label: v.label, slots: [] }; l.slots.push(v); byDay.set(v.date, l); }
  const suggested = CAL.pickSuggestions(slots, zone.tz, { now }).map(sl => new Date(sl.start).toISOString());
  return {
    account: { id: acc.id, name, first: first(name), tz: acc.tz, ...(acc.tz !== zone.tz ? { place: tzPlace(acc.tz) } : {}) },
    calendar, source, sure: calendar === "ok", pipedrive, ...(problem ? { problem } : {}),
    hours: { ...hours, tz: acc.tz }, duration: dur, school: { tz: zone.tz, place: zone.place, sure: zone.sure }, viewerTz: vtz, today: CAL.partsIn(now, zone.tz).date,
    days: [...byDay.values()], suggested,
    // libre/ocupado (sin títulos) para avisar en Registrar si la hora elegida choca
    busy: busy.filter(([s, e]) => e > now && s < until).map(([s, e]) => [new Date(s).toISOString(), new Date(e).toISOString()]),
  };
}
const tzPlace = tz => Object.entries(MARKETS).find(([, m]) => m.tz === tz)?.[0] || tz.split("/").pop().replace(/_/g, " ");

// ---------- el account que le toca a quien mira para un colegio, y los demás para elegir (GET /api/schools/:id/account)
export async function schoolAccount(school, viewerEmail) {
  const [m, prs, stored, cals] = await Promise.all([pd.meta(), getProfiles(), accountsOf(viewerEmail), calStore.all().catch(() => ({}))]);
  const people = accountPeople(m.users, prs), byIdP = new Map(people.map(p => [p.id, p]));
  const calOn = p => !!cals[p.email]?.enc || demoCal(p.id);
  // en qué países es account (lo sugerido de la cuenta y lo que eligió quien mira)
  const countriesOf = id => Object.keys(MARKETS).filter(c => accountFor(c, stored)?.id === id);
  const a = accountFor(school?.country, stored), mine = a && byIdP.get(a.id);
  // me: quien mira (un account que propone su propia demo se elige a sí mismo)
  const out = p => ({ ...personOut(p), first: first(p.name), calendar: calOn(p), countries: countriesOf(p.id), ...(p.email === lc(viewerEmail) ? { me: true } : {}) });
  const listed = new Set([...people.filter(p => p.ae).map(p => p.id), ...Object.keys(MARKETS).map(c => accountFor(c, stored)?.id).filter(Boolean)]);
  return { country: school?.country || "", mine: mine ? { ...out(mine), source: a.source } : null,
    accounts: people.filter(p => listed.has(p.id)).map(out), others: people.filter(p => !listed.has(p.id) && p.email !== lc(viewerEmail)).map(p => ({ id: p.id, name: p.name })) };
}

// ---------- el mensaje con los horarios elegidos (GET /api/schools/:id/demo-message)
export async function demoMessage(school, { pdUserId, ats = [], duration = 30, channel = "whatsapp", contact = "", me = "", now = Date.now() } = {}) {
  const u = await userById(pdUserId);
  if (!u) throw bad("Esa persona no está en el Pipedrive de OrderEAT.", 404);
  const list = [...new Set((Array.isArray(ats) ? ats : [ats]).map(x => Date.parse(String(x))))].filter(Number.isFinite).sort((a, b) => a - b);
  if (!list.length || list.length > 3) throw bad("Elegí de 1 a 3 horarios.");
  if (list.some(t => t < now - 5 * MIN)) throw bad("Uno de los horarios ya pasó. Elegí otro.");
  const prs = await getProfiles(), zone = CAL.schoolZone(school);
  const slots = list.map(t => { const p = CAL.partsIn(t, zone.tz); return { date: p.date, time: p.time }; });
  return demoSlotsMessage(school, { slots, account: prs[lc(u.email)]?.name || u.name || "", duration: CAL.DURATIONS.includes(Number(duration)) ? Number(duration) : 30,
    contact: String(contact || "").slice(0, 80), me: String(me || "").slice(0, 80), channel: channel === "mail" ? "mail" : "whatsapp", today: CAL.partsIn(now, zone.tz).date, place: zone.place });
}
