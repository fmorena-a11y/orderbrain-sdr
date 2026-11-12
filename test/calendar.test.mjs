// Accounts y calendario: lib/calendar.js (puro: .ics → ocupado, huecos, sugerencias, zonas, URL permitida, bajada del .ics),
// lib/accounts.js (account por país y perfil, horarios libres con el Pipedrive de prueba, privacidad), el mensaje con
// tuteo/voseo (lib/playbook.js), el cifrado de la dirección y quién puede cambiar los accounts de otro (lib/accounts-api.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
for (const k of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "PIPEDRIVE_API_TOKEN", "GOOGLE_CLIENT_SECRET", "DEFAULT_ACCOUNTS"]) delete process.env[k];
process.env.DEMO_MODE = "1";
process.env.SESSION_SECRET = "clave-de-prueba";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ob-cal-"));
const C = await import("../lib/calendar.js");
const A = await import("../lib/accounts.js");
const { demoSlotsMessage, templates } = await import("../lib/playbook.js");
const { encrypt, decrypt } = await import("../lib/gmail.js");
const { personStore } = await import("../lib/store.js");
const { mountAccounts } = await import("../lib/accounts-api.js");
const { DEFAULT_ACCOUNTS } = await import("../lib/config.js");

const Z = s => Date.parse(s);
const iso = ([s, e]) => [new Date(s).toISOString(), new Date(e).toISOString()];
const cal = (...events) => ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Google Inc//Google Calendar 70.9054//EN", "X-WR-CALNAME:joaquin@ordereat.com", "X-WR-TIMEZONE:America/Mexico_City", ...events, "END:VCALENDAR", ""].join("\r\n");
const ev = (uid, lines) => ["BEGIN:VEVENT", `UID:${uid}`, "DTSTAMP:20261101T000000Z", ...lines, "END:VEVENT"].join("\r\n");
const W = { from: Z("2026-11-09T00:00:00Z"), to: Z("2026-12-10T00:00:00Z"), owners: ["joaquin@ordereat.com"], tz: "America/Mexico_City" };

// ---------- .ics → bloques ocupados
test("ics: serie semanal con EXDATE y una ocurrencia movida (RECURRENCE-ID), TZID de la IANA sin VTIMEZONE", () => {
  const b = C.busyFromIcs(cal(
    ev("semanal", ["DTSTART;TZID=America/Mexico_City:20261103T100000", "DTEND;TZID=America/Mexico_City:20261103T110000", "RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=6", "EXDATE;TZID=America/Mexico_City:20261117T100000", "SUMMARY:Secreto"]),
    ev("semanal", ["RECURRENCE-ID;TZID=America/Mexico_City:20261124T100000", "DTSTART;TZID=America/Mexico_City:20261124T150000", "DTEND;TZID=America/Mexico_City:20261124T160000", "SUMMARY:Movida"])), W);
  assert.deepEqual(b.map(iso), [
    ["2026-11-10T16:00:00.000Z", "2026-11-10T17:00:00.000Z"], // 10 a 11 de México (UTC-6)
    ["2026-11-24T21:00:00.000Z", "2026-11-24T22:00:00.000Z"], // la del 24, movida a las 15
    ["2026-12-01T16:00:00.000Z", "2026-12-01T17:00:00.000Z"],
    ["2026-12-08T16:00:00.000Z", "2026-12-08T17:00:00.000Z"],
  ]); // la del 17 no está (EXDATE); la del 3 queda antes de la ventana; COUNT=6 corta en la del 8
});
test("ics: una ocurrencia cancelada de la serie no bloquea; la serie sí", () => {
  const b = C.busyFromIcs(cal(
    ev("d", ["DTSTART:20261110T150000Z", "DTEND:20261110T153000Z", "RRULE:FREQ=DAILY;COUNT=3"]),
    ev("d", ["RECURRENCE-ID:20261111T150000Z", "DTSTART:20261111T150000Z", "DTEND:20261111T153000Z", "STATUS:CANCELLED"])), W);
  assert.deepEqual(b.map(iso).map(x => x[0]), ["2026-11-10T15:00:00.000Z", "2026-11-12T15:00:00.000Z"]);
});
test("ics: día entero opaco («fuera de la oficina») bloquea el día en la zona del account; cumpleaños/feriado transparente no", () => {
  const b = C.busyFromIcs(cal(
    ev("ooo", ["DTSTART;VALUE=DATE:20261119", "DTEND;VALUE=DATE:20261120", "SUMMARY:Fuera de la oficina"]),
    ev("cumple", ["DTSTART;VALUE=DATE:20261113", "DTEND;VALUE=DATE:20261114", "TRANSP:TRANSPARENT", "SUMMARY:Cumpleaños"]),
    ev("feriado", ["DTSTART;VALUE=DATE:20261116", "SUMMARY:Feriado", "TRANSP:TRANSPARENT"])), W);
  assert.deepEqual(b.map(iso), [["2026-11-19T06:00:00.000Z", "2026-11-20T06:00:00.000Z"]]);
  // en la zona de otro account (Buenos Aires): el mismo día, otras horas UTC
  const ar = C.busyFromIcs(cal(ev("ooo", ["DTSTART;VALUE=DATE:20261119", "DTEND;VALUE=DATE:20261120"])), { ...W, tz: "America/Argentina/Buenos_Aires" });
  assert.deepEqual(ar.map(iso), [["2026-11-19T03:00:00.000Z", "2026-11-20T03:00:00.000Z"]]);
});
test("ics: no bloquean lo transparente, lo cancelado, lo libre de Outlook ni lo que el dueño rechazó (sí lo que rechazó otro)", () => {
  const t = (uid, extra) => ev(uid, ["DTSTART:20261112T150000Z", "DTEND:20261112T160000Z", ...extra]);
  const b = C.busyFromIcs(cal(
    t("transp", ["TRANSP:TRANSPARENT"]), t("cancel", ["STATUS:CANCELLED"]), t("ms", ["X-MICROSOFT-CDO-BUSYSTATUS:FREE"]),
    t("rech", ["ATTENDEE;CN=Joaquín;PARTSTAT=DECLINED:mailto:Joaquin@OrderEAT.com", "ATTENDEE;PARTSTAT=ACCEPTED:mailto:otro@x.com"]),
    ev("otro-rech", ["DTSTART:20261113T150000Z", "DTEND:20261113T160000Z", "ATTENDEE;PARTSTAT=DECLINED:mailto:otro@x.com", "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:joaquin@ordereat.com"]),
    ev("ok", ["DTSTART:20261114T150000Z", "DTEND:20261114T160000Z", "TRANSP:OPAQUE"])), W);
  assert.deepEqual(b.map(iso).map(x => x[0]), ["2026-11-13T15:00:00.000Z", "2026-11-14T15:00:00.000Z"]);
});
test("ics: el dueño también sale del nombre del calendario (X-WR-CALNAME) y de la dirección de Google", () => {
  const e = ev("rech", ["DTSTART:20261112T150000Z", "DTEND:20261112T160000Z", "ATTENDEE;PARTSTAT=DECLINED:mailto:joaquin@ordereat.com"]);
  assert.equal(C.busyFromIcs(cal(e), { ...W, owners: [] }).length, 0);
  assert.equal(C.calendarOwnerOf("https://calendar.google.com/calendar/ical/joaquin%40ordereat.com/private-0123456789abcdef0123456789abcdef/basic.ics"), "joaquin@ordereat.com");
  assert.equal(C.calendarOwnerOf("https://calendar.google.com/calendar/ical/c_abc123%40group.calendar.google.com/private-0123456789abcdef/basic.ics"), "c_abc123@group.calendar.google.com");
});
test("ics: zona propia del archivo (VTIMEZONE con nombre de Windows, como Outlook), UTC y hora flotante (X-WR-TIMEZONE)", () => {
  const vtz = ["BEGIN:VTIMEZONE", "TZID:Central Standard Time (Mexico)", "BEGIN:STANDARD", "DTSTART:16010101T000000", "TZOFFSETFROM:-0600", "TZOFFSETTO:-0600", "END:STANDARD", "END:VTIMEZONE"].join("\r\n");
  const b = C.busyFromIcs(cal(vtz,
    ev("win", ["DTSTART;TZID=Central Standard Time (Mexico):20261112T090000", "DTEND;TZID=Central Standard Time (Mexico):20261112T100000"]),
    ev("utc", ["DTSTART:20261113T090000Z", "DTEND:20261113T100000Z"]),
    ev("flot", ["DTSTART:20261116T090000", "DTEND:20261116T093000"])), W);
  assert.deepEqual(b.map(iso), [["2026-11-12T15:00:00.000Z", "2026-11-12T16:00:00.000Z"], ["2026-11-13T09:00:00.000Z", "2026-11-13T10:00:00.000Z"], ["2026-11-16T15:00:00.000Z", "2026-11-16T15:30:00.000Z"]]);
});
test("ics: TZID de Chile a ambos lados del cambio de horario (septiembre)", () => {
  const b = C.busyFromIcs(cal(ev("cl", ["DTSTART;TZID=America/Santiago:20260904T090000", "DTEND;TZID=America/Santiago:20260904T100000", "RRULE:FREQ=WEEKLY;BYDAY=FR,MO;COUNT=2"])),
    { ...W, from: Z("2026-09-01T00:00:00Z"), to: Z("2026-09-30T00:00:00Z") });
  assert.deepEqual(b.map(iso).map(x => x[0]), ["2026-09-04T13:00:00.000Z", "2026-09-07T12:00:00.000Z"]); // UTC-4 y después UTC-3
});
test("ics: una serie diaria que empezó hace 26 años igual llega a la ventana (no queda «libre» por el tope)", () => {
  const b = C.busyFromIcs(cal(ev("diaria", ["DTSTART;TZID=America/Mexico_City:20000103T090000", "DTEND;TZID=America/Mexico_City:20000103T091500", "RRULE:FREQ=DAILY"])), W);
  assert.equal(b.length, 31); assert.equal(iso(b[0])[0], "2026-11-09T15:00:00.000Z");
});
test("ics: un archivo que no es iCal tira ics_parse; una serie rota no tira el resto", () => {
  assert.throws(() => C.busyFromIcs("<html>hola</html>", W), e => e.code === "ics_parse");
  const b = C.busyFromIcs(cal(ev("rota", ["DTSTART:20261112T150000Z", "RRULE:FREQ=NADA"]), ev("ok", ["DTSTART:20261113T150000Z", "DTEND:20261113T160000Z"])), W);
  assert.ok(b.some(x => iso(x)[0] === "2026-11-13T15:00:00.000Z"));
});
test("actividades de Pipedrive: solo con hora y que ocupan (busy o demo), con su duración", () => {
  const b = C.busyFromActivities([
    { type: "meeting", due_date: "2026-11-13", due_time: "16:00", duration: "01:30" },
    { type: "call", due_date: "2026-11-13", due_time: "18:00:00", busy: true },
    { type: "call", due_date: "2026-11-13", due_time: "19:00", busy: false },
    { type: "meeting", due_date: "2026-11-14", due_time: "" }, // demo sin hora (la hora está en la nota): no se sabe
    { type: "meeting", due_date: "2026-11-15", due_time: "10:00", done: true },
  ]);
  assert.deepEqual(b.map(iso), [["2026-11-13T16:00:00.000Z", "2026-11-13T17:30:00.000Z"], ["2026-11-13T18:00:00.000Z", "2026-11-13T18:30:00.000Z"]]);
});

// ---------- huecos
const MX = "America/Mexico_City", AR = "America/Argentina/Buenos_Aires";
test("huecos: horario del account en SU zona, margen de 15 min alrededor de lo ocupado, nada antes de 2 h desde ahora", () => {
  const now = Z("2026-11-16T16:10:00Z"); // lunes 10:10 en México
  const busy = [[Z("2026-11-16T20:00:00Z"), Z("2026-11-16T21:00:00Z")]]; // 14 a 15 de México
  const { slots } = C.freeSlots({ busy, tz: MX, schoolTz: MX, now, days: 1 });
  const t = slots.map(s => C.partsIn(s.start, MX).time);
  assert.equal(t[0], "12:30"); // 10:10 + 2 h = 12:10 → la primera de a media hora
  assert.ok(t.includes("13:00") && !t.includes("13:30") && !t.includes("14:00") && !t.includes("14:30") && !t.includes("15:00") && t.includes("15:30"), t.join(" "));
  assert.equal(t.at(-1), "17:30"); // termina a las 18
  // 60 minutos: 13:00 a 14:00 pisa el margen (13:45)
  assert.ok(!C.freeSlots({ busy, tz: MX, schoolTz: MX, now, days: 1, duration: 60 }).slots.some(s => C.partsIn(s.start, MX).time === "13:00"));
});
test("huecos: los próximos 10 días hábiles del account (sin sábado ni domingo) y su horario editable", () => {
  const now = Z("2026-11-13T12:00:00Z"); // viernes 6:00 en México
  const r = C.freeSlots({ tz: MX, schoolTz: MX, now });
  assert.deepEqual(r.days, ["2026-11-13", "2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20", "2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26"]);
  const solo = C.freeSlots({ tz: MX, schoolTz: MX, now, hours: { days: [2, 4], from: "10:00", to: "12:00" }, days: 2 });
  assert.deepEqual(solo.days, ["2026-11-17", "2026-11-19"]);
  assert.deepEqual([...new Set(solo.slots.map(s => C.partsIn(s.start, MX).time))], ["10:00", "10:30", "11:00", "11:30"]);
});
test("huecos: un account de México para un colegio de Argentina, en la hora de Argentina y dentro del horario escolar de allá", () => {
  const now = Z("2026-11-16T12:00:00Z");
  const { slots } = C.freeSlots({ tz: MX, schoolTz: AR, now, days: 1 });
  const ar = slots.map(s => C.partsIn(s.start, AR).time);
  assert.equal(ar[0], "12:00"); // 9:00 de México = 12:00 de Argentina
  assert.equal(ar.at(-1), "17:30"); // a las 18 de allá se corta (aunque el account sigue hasta las 18 de México = 21 de allá)
  const v = C.slotView(slots[0], AR, MX);
  assert.equal(v.time, "12:00"); assert.equal(v.mine, "09:00"); assert.equal(v.vTime, "09:00"); assert.equal(v.label, "lunes 16");
  assert.equal(C.slotView(slots[0], MX, MX).mine, undefined); // misma zona: sin paréntesis
});
test("huecos: cambio de horario de Chile (el mismo 9:00 de allá es otra hora UTC y otra hora en México)", () => {
  const now = Z("2026-09-03T12:00:00Z");
  const { slots } = C.freeSlots({ tz: "America/Santiago", schoolTz: "America/Santiago", now, days: 3 });
  const first = d => slots.find(s => C.partsIn(s.start, "America/Santiago").date === d);
  assert.equal(new Date(first("2026-09-04").start).toISOString(), "2026-09-04T13:00:00.000Z");
  assert.equal(new Date(first("2026-09-07").start).toISOString(), "2026-09-07T12:00:00.000Z");
  assert.equal(C.slotView(first("2026-09-04"), "America/Santiago", MX).mine, "07:00");
  assert.equal(C.slotView(first("2026-09-07"), "America/Santiago", MX).mine, "06:00");
});
test("sugerencias: tres días distintos, una de mañana y una de tarde, horas redondas cerca de las 10 y las 16, sin hoy", () => {
  const now = Z("2026-11-16T14:00:00Z");
  const { slots } = C.freeSlots({ tz: MX, schoolTz: MX, now });
  const s = C.pickSuggestions(slots, MX, { now }).map(x => C.partsIn(x.start, MX));
  assert.equal(new Set(s.map(x => x.date)).size, 3);
  assert.ok(!s.some(x => x.date === "2026-11-16"));
  assert.deepEqual(s.map(x => x.time), ["10:00", "16:00", "10:00"]);
  // sin mañanas posibles (México visto desde Argentina): todas de tarde, igual en días distintos
  const s2 = C.pickSuggestions(C.freeSlots({ tz: MX, schoolTz: AR, now }).slots, AR, { now });
  assert.equal(s2.length, 3); assert.ok(s2.every(x => C.partsIn(x.start, AR).h >= 12));
});
test("horario para demos: validación", () => {
  assert.deepEqual(C.cleanHours({ days: [5, 1, 1, "2"], from: "09:00", to: "18:00" }), { days: [1, 2, 5], from: "09:00", to: "18:00" });
  assert.match(C.cleanHours({ days: [], from: "09:00", to: "18:00" }).error, /día/);
  assert.match(C.cleanHours({ days: [1], from: "18:00", to: "09:00" }).error, /antes/);
  assert.match(C.cleanHours({ days: [1], from: "09:10", to: "18:00" }).error, /15 minutos/);
  assert.match(C.cleanHours({ days: [1], from: "09:00", to: "09:30" }).error, /una hora/);
});
test("zona del colegio: la del país; en México, el huso de la ciudad o por longitud; sin saber, la del centro", () => {
  assert.deepEqual(C.schoolZone({ country: "Argentina", city: "Rosario" }), { tz: AR, place: "Argentina", sure: true });
  assert.deepEqual(C.schoolZone({ country: "México", city: "Tijuana" }), { tz: "America/Tijuana", place: "Tijuana", sure: true });
  assert.deepEqual(C.schoolZone({ country: "México", city: "Puebla", lng: -98.2 }), { tz: MX, place: "México", sure: true });
  assert.deepEqual(C.schoolZone({ country: "México", city: "Un pueblo", lng: -110 }), { tz: MX, place: "México", sure: false });
});

// ---------- la dirección del calendario (SSRF)
test("URL del calendario: solo Google Calendar (iCal) u Outlook publicado, https, sin usuario, puerto, consulta ni otro host", () => {
  const g = "https://calendar.google.com/calendar/ical/joaquin%40ordereat.com/private-0123456789abcdef0123456789abcdef/basic.ics";
  assert.deepEqual(C.validateIcsUrl(g), { ok: true, url: g, kind: "google" });
  assert.equal(C.validateIcsUrl(` webcal://calendar.google.com/calendar/ical/a%40b.com/public/basic.ics `).url, "https://calendar.google.com/calendar/ical/a%40b.com/public/basic.ics");
  assert.equal(C.validateIcsUrl("https://outlook.office365.com/owa/calendar/abc123@ordereat.com/0f1e2d3c4b5a/calendar.ics").kind, "outlook");
  for (const bad of ["", "hola", "http://calendar.google.com/calendar/ical/a%40b.com/private-0123456789abcdef/basic.ics",
    "https://calendar.google.com:8443/calendar/ical/a%40b.com/private-0123456789abcdef/basic.ics",
    "https://user:pw@calendar.google.com/calendar/ical/a%40b.com/private-0123456789abcdef/basic.ics",
    "https://calendar.google.com@evil.com/calendar/ical/a%40b.com/private-0123456789abcdef/basic.ics",
    "https://calendar.google.com.evil.com/calendar/ical/a%40b.com/private-0123456789abcdef/basic.ics",
    "https://evil.com/calendar/ical/a%40b.com/private-0123456789abcdef/basic.ics",
    "https://calendar.google.com/calendar/ical/a%40b.com/private-0123456789abcdef/basic.ics?redirect=http://169.254.169.254/",
    "https://calendar.google.com/calendar/ical/a%40b.com/private-0123456789abcdef/basic.ics#x",
    "https://calendar.google.com/calendar/ical/a%40b.com/private-xyz/basic.ics",
    "https://calendar.google.com/calendar/ical/../../admin/private-0123456789abcdef/basic.ics",
    "https://calendar.google.com/calendar/embed?src=a%40b.com",
    "http://127.0.0.1:8765/test.ics", "http://169.254.169.254/latest/meta-data/x.ics", "https://[::1]/calendar.ics", "file:///etc/passwd", "javascript:alert(1)"]) {
    assert.ok(C.validateIcsUrl(bad).error, bad);
  }
  // en el demo, además http://127.0.0.1 o localhost (para probar con un .ics servido en la máquina); nunca otra IP
  assert.equal(C.validateIcsUrl("http://127.0.0.1:8765/test.ics", { demo: true }).kind, "test");
  assert.ok(C.validateIcsUrl("http://169.254.169.254/x.ics", { demo: true }).error);
  assert.ok(C.validateIcsUrl("http://127.0.0.1:8765/x.ics?y=1", { demo: true }).error);
});
// fetch de mentira: respuestas en orden
const fakeFetch = list => { const calls = []; const f = async (url, opts) => { calls.push({ url, opts }); const r = list.shift(); if (r instanceof Error) throw r; return r; }; f.calls = calls; return f; };
const resp = (body, { status = 200, headers = {} } = {}) => new Response(body, { status, headers });
const G = "https://calendar.google.com/calendar/ical/a%40b.com/private-0123456789abcdef/basic.ics";
test("bajar el .ics: no sigue redirecciones a otro lado, tope de tamaño, que sea un calendario, dirección vencida", async () => {
  const ok = fakeFetch([resp(cal())]);
  assert.match(await C.fetchIcs(G, { fetchImpl: ok }), /^BEGIN:VCALENDAR/);
  assert.equal(ok.calls[0].opts.redirect, "manual");
  await assert.rejects(C.fetchIcs(G, { fetchImpl: fakeFetch([resp("", { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } })]) }), e => e.code === "ics_url" && !/169\.254/.test(e.message));
  const hop = fakeFetch([resp("", { status: 301, headers: { location: "/calendar/ical/a%40b.com/private-0123456789abcdef/basic.ics" } }), resp(cal())]);
  assert.match(await C.fetchIcs(G, { fetchImpl: hop }), /VCALENDAR/); // una redirección dentro de Google sí
  await assert.rejects(C.fetchIcs(G, { fetchImpl: fakeFetch([resp("x".repeat(2000), { headers: { "content-length": "2000" } })]), maxBytes: 1000 }), e => e.code === "ics_big");
  await assert.rejects(C.fetchIcs(G, { fetchImpl: fakeFetch([resp("BEGIN:VCALENDAR\r\n" + "x".repeat(5000))]), maxBytes: 1000 }), e => e.code === "ics_big");
  await assert.rejects(C.fetchIcs(G, { fetchImpl: fakeFetch([resp("<html>login</html>")]) }), e => e.code === "ics_parse");
  await assert.rejects(C.fetchIcs(G, { fetchImpl: fakeFetch([resp("no", { status: 404 })]) }), e => e.code === "ics_gone" && !e.message.includes("private-"));
  await assert.rejects(C.fetchIcs(G, { fetchImpl: fakeFetch([Object.assign(new Error("t"), { name: "TimeoutError" })]) }), e => e.code === "ics_down" && /tardó/.test(e.message));
  await assert.rejects(C.fetchIcs("http://127.0.0.1:1/x.ics", { fetchImpl: fakeFetch([]) }), e => e.code === "ics_url"); // fuera del demo, nunca
});
test("free/busy de Google: bloques del compañero; si no deja verlo, error sin datos", async () => {
  const f = fakeFetch([resp(JSON.stringify({ calendars: { "j@x.com": { busy: [{ start: "2026-11-13T16:00:00Z", end: "2026-11-13T17:00:00Z" }] } } }))]);
  assert.deepEqual(await C.googleBusy({ token: "t", email: "j@x.com", from: W.from, to: W.to, fetchImpl: f }), [[Z("2026-11-13T16:00:00Z"), Z("2026-11-13T17:00:00Z")]]);
  assert.equal(JSON.parse(f.calls[0].opts.body).items[0].id, "j@x.com");
  await assert.rejects(C.googleBusy({ token: "t", email: "j@x.com", from: 0, to: 1, fetchImpl: fakeFetch([resp(JSON.stringify({ calendars: { "j@x.com": { errors: [{ reason: "notFound" }] } } }))]) }), e => e.code === "fb_hidden");
});

// ---------- cifrado de la dirección
test("la dirección se guarda cifrada (AES-256-GCM): no queda en claro y otra clave no la lee", () => {
  const blob = encrypt(G);
  assert.ok(blob.startsWith("v1.") && !blob.includes("calendar.google.com") && !blob.includes("private-"));
  assert.equal(decrypt(blob), G);
  assert.equal(decrypt(blob, "otra-clave"), null);
  assert.notEqual(encrypt(G), blob); // IV nuevo cada vez
});

// ---------- account sugerido por país y perfil
test("account por país: lo elegido manda (también «sin account»); si no, lo sugerido; filas y validación", () => {
  assert.deepEqual(DEFAULT_ACCOUNTS, { "México": 24821777, "Argentina": 20758179, "Perú": 26099394 });
  assert.deepEqual(A.accountFor("México", {}), { id: 24821777, source: "sugerido" });
  assert.deepEqual(A.accountFor("México", { "México": { id: 5 } }), { id: 5, source: "perfil" });
  assert.equal(A.accountFor("México", { "México": { id: null } }), null);
  assert.equal(A.accountFor("Chile", {}), null);
  assert.equal(A.accountFor("", {}), null);
  assert.deepEqual(A.accountRows({ "Chile": { id: 7 }, "Narnia": { id: 1 } }), [
    { country: "México", id: 24821777, suggested: true }, { country: "Argentina", id: 20758179, suggested: true }, { country: "Perú", id: 26099394, suggested: true }, { country: "Chile", id: 7, suggested: false }]);
  const ids = new Set([1, 2, 24821777]);
  assert.deepEqual(A.cleanAccounts({ "México": "24821777", "Perú": null, "Chile": "" }, { userIds: ids }), { accounts: { "México": 24821777, "Perú": null, "Chile": null } });
  assert.match(A.cleanAccounts({ "Narnia": 1 }, { userIds: ids }).error, /país/);
  assert.match(A.cleanAccounts({ "México": 99 }, { userIds: ids }).error, /Pipedrive/);
  assert.match(A.cleanAccounts([], { userIds: ids }).error, /No entendí/);
  // primero los Account Executive (por perfil o sugeridos), sin las cuentas generales
  const people = A.accountPeople([{ id: 2, name: "Zoe", email: "z@x.com" }, { id: 3, name: "Ana", email: "a@x.com" }, { id: 24821777, name: "Joaquín", email: "j@x.com" }, { id: 13493598, name: "OrderEAT", email: "o@x.com" }], { "z@x.com": { role: "ae", name: "Zoe Ruiz" } });
  assert.deepEqual(people.map(p => [p.name, p.ae]), [["Joaquín", true], ["Zoe Ruiz", true], ["Ana", false]]);
});

// ---------- mensaje con tuteo y voseo
test("mensaje: tuteo en México, voseo en Argentina, mes si no es el de hoy, 1 a 3 horarios", () => {
  const mx = demoSlotsMessage({ name: "Colegio Patria", country: "México" }, { slots: [{ date: "2026-11-17", time: "10:00" }, { date: "2026-11-18", time: "16:00" }], account: "Joaquín Márquez", contact: "Laura Gómez", today: "2026-11-12", place: "México" });
  assert.equal(mx.text, "Hola Laura, ¿te queda bien el martes 17 a las 10:00 o el miércoles 18 a las 16:00 (hora de México)? Es una videollamada de 30 minutos con Joaquín, de nuestro equipo, para ver cómo funcionaría OrderEAT en la cafetería de Colegio Patria. Si no puedes en esos horarios, dime qué día y horario te queda mejor.");
  const ar = demoSlotsMessage({ name: "Colegio Sur", country: "Argentina" }, { slots: [{ date: "2026-12-01", time: "15:00" }, { date: "2026-12-02", time: "10:30" }, { date: "2026-12-03", time: "11:00" }], account: "Matías Favaro", duration: 45, today: "2026-11-12", place: "Argentina", channel: "mail", me: "Ana Pérez" });
  assert.equal(ar.subject, "Demo de OrderEAT para la cantina de Colegio Sur");
  assert.match(ar.text, /¿Te queda bien el martes 1 de diciembre a las 15:00, el miércoles 2 de diciembre a las 10:30 o el jueves 3 de diciembre a las 11:00 \(hora de Argentina\)\?/);
  assert.match(ar.text, /videollamada de 45 minutos con Matías, de nuestro equipo,/);
  assert.match(ar.text, /Si no podés en esos horarios, decime qué día y horario te queda mejor\.\n\nAbrazo,\nAna Pérez\nOrderEAT$/);
  const cl = demoSlotsMessage({ name: "C", country: "Chile" }, { slots: [{ date: "2026-11-17", time: "10:00" }], account: "X Y", today: "2026-11-12" });
  assert.match(cl.text, /el casino de C\. Si no puedes en ese horario, dime/);
  // la plantilla sin horarios (con [día] y [hora] para completar)
  const t = templates({ name: "C", country: "Argentina" }).find(x => x.id === "demo_slots");
  assert.equal(t.label, "Proponer horarios de demo");
  assert.match(t.text, /\[día\] a las \[hora\] \(hora de Argentina\).*Si no podés/);
});

// ---------- con el Pipedrive de prueba: horarios libres, sin calendario, calendario caído y privacidad
test("horarios libres (demo): con calendario simulado son seguros; la respuesta nunca trae títulos ni detalles", async () => {
  const school = { id: "x", name: "Colegio Prueba", country: "México", city: "Puebla", lng: -98.2 };
  const r = await A.freeFor(24821777, { school, viewerEmail: "sdr@ordereat.com", viewerTz: AR });
  assert.equal(r.calendar, "ok"); assert.equal(r.source, "ics"); assert.equal(r.sure, true);
  assert.equal(r.account.name, "Joaquín Márquez"); assert.equal(r.school.tz, MX);
  assert.ok(r.days.length >= 5 && r.suggested.length === 3 && r.busy.length > 0);
  assert.ok(r.days.every(d => d.slots.every(s => s.mine))); // quien mira está en Argentina: va su hora entre paréntesis
  const json = JSON.stringify(r);
  for (const secret of ["Reunión", "privado", "secreto", "Cumpleaños", "Fuera de la oficina", "Demo Colegio", "Invitación", "SUMMARY", "joaquin@"]) assert.ok(!json.includes(secret), secret);
});
test("horarios libres (demo): sin calendario conectado no se afirma nada (solo Pipedrive, «sin confirmar»)", async () => {
  const r = await A.freeFor(26099394, { school: { name: "C", country: "Perú", city: "Lima" }, viewerTz: "America/Lima" });
  assert.equal(r.calendar, "missing"); assert.equal(r.sure, false); assert.equal(r.source, "pipedrive");
  assert.ok(r.days.length > 0);
});
test("horarios libres: si el .ics falla, «error» y nada seguro; la dirección no aparece en ningún lado", async () => {
  const url = "http://127.0.0.1:1/caido.ics";
  await personStore("calendars").set("santiago@ordereat.com", { enc: encrypt(url), kind: "test", at: new Date().toISOString() });
  const r = await A.freeFor(26099394, { school: { name: "C", country: "Perú" }, viewerTz: "America/Lima" });
  assert.equal(r.calendar, "error"); assert.equal(r.sure, false); assert.ok(r.problem);
  assert.ok(!JSON.stringify(r).includes("127.0.0.1"));
  const v = await A.calendarView("santiago@ordereat.com");
  assert.equal(v.connected, true); assert.ok(!JSON.stringify(v).includes("127.0.0.1") && !("enc" in v));
  const raw = fs.readFileSync(path.join(process.env.DATA_DIR, "calendars.json"), "utf8");
  assert.ok(!raw.includes("127.0.0.1") && !raw.includes("caido"));
  assert.equal((fs.statSync(path.join(process.env.DATA_DIR, "calendars.json")).mode & 0o777).toString(8), "600");
  await A.disconnectCalendar("santiago@ordereat.com");
  assert.equal((await A.calendarView("santiago@ordereat.com")).connected, false);
});
test("una dirección guardada que ya no se puede leer: el account lo ve en su perfil; desconectar la borra", async () => {
  await personStore("calendars").set("santiago@ordereat.com", { enc: encrypt("https://calendar.google.com/calendar/ical/s%40x.com/private-0123456789abcdef/basic.ics", "otra-clave"), kind: "google", at: "2026-11-01T00:00:00.000Z", hours: { days: [1, 2], from: "10:00", to: "12:00" } });
  const r = await A.freeFor(26099394, { school: { name: "C", country: "Perú" }, viewerTz: "America/Lima" });
  assert.equal(r.calendar, "error"); assert.equal(r.hours.from, "10:00");
  assert.match((await A.calendarView("santiago@ordereat.com")).problem, /pegarla de nuevo/);
  const v = await A.disconnectCalendar("santiago@ordereat.com");
  assert.equal(v.connected, false); assert.equal(v.hours.from, "10:00"); // el horario queda
  assert.deepEqual(await personStore("calendars").get("santiago@ordereat.com"), { hours: { days: [1, 2], from: "10:00", to: "12:00" } });
  await personStore("calendars").del("santiago@ordereat.com");
});
test("el account del colegio según el país y el perfil de quien mira; el mensaje no acepta horarios pasados", async () => {
  const s = { id: "x", name: "Colegio Prueba", country: "Argentina" };
  const a = await A.schoolAccount(s, "sdr1@ordereat.com");
  assert.equal(a.mine.id, 20758179); assert.equal(a.mine.source, "sugerido"); assert.deepEqual(a.mine.countries, ["Argentina"]);
  assert.ok(a.accounts.some(p => p.id === 26099394 && p.calendar === false) && a.accounts.some(p => p.id === 24821777 && p.calendar === true));
  await A.saveAccounts("sdr1@ordereat.com", { "Argentina": 24821777, "México": null }, { by: "sdr1@ordereat.com" });
  const b = await A.schoolAccount(s, "sdr1@ordereat.com");
  assert.equal(b.mine.id, 24821777); assert.equal(b.mine.source, "perfil");
  assert.equal((await A.schoolAccount({ name: "M", country: "México" }, "sdr1@ordereat.com")).mine, null); // eligió «sin account»
  await assert.rejects(A.saveAccounts("sdr1@ordereat.com", { "México": 424242 }), /Pipedrive/);
  await assert.rejects(A.demoMessage(s, { pdUserId: 24821777, ats: ["2020-01-01T10:00:00Z"] }), /pasó/);
  await assert.rejects(A.demoMessage(s, { pdUserId: 24821777, ats: [] }), /1 a 3/);
  const m = await A.demoMessage(s, { pdUserId: 24821777, ats: [new Date(Date.now() + 3 * 864e5).toISOString()], channel: "whatsapp" });
  assert.match(m.text, /con Joaquín, de nuestro equipo,.*cantina.*Si no podés/);
});

// ---------- quién cambia los accounts de otra persona (lib/accounts-api.js)
test("rutas: uno mismo sí; dirección sí; el líder de su equipo sí; otro líder, un miembro o alguien de otro equipo, 403", async () => {
  const routes = {};
  const app = { get: (p, ...h) => (routes[`GET ${p}`] = h.at(-1)), post: (p, ...h) => (routes[`POST ${p}`] = h.at(-1)) };
  const wrap = fn => (req, res) => fn(req, res).catch(e => res.status(e.status || 500).json({ error: e.message }));
  const viewers = { "dir@ordereat.com": { admin: true, leader: true }, "lider@ordereat.com": { admin: false, leader: true }, "sdr1@ordereat.com": { admin: false, leader: false } };
  const scopes = { "lider@ordereat.com": { ids: new Set([2]), emails: new Set(["juandiego@ordereat.com"]) } };
  mountAccounts(app, { auth: null, wrap, schoolParam: null, viewerFor: async e => viewers[e] || { leader: false }, leadScopeFor: async e => scopes[e] || false });
  const call = async (method, p, who, email, body) => {
    let status = 200, out; const res = { status(s) { status = s; return res; }, json(b) { out = b; return res; }, set() { return res; } };
    await routes[`${method} ${p}`]({ session: { user: { email: who } }, params: { email }, body, query: {} }, res);
    return { status, out };
  };
  const T = "/api/team/accounts/:email";
  assert.equal((await call("GET", T, "sdr1@ordereat.com", "agustin@ordereat.com")).status, 403);
  assert.equal((await call("POST", T, "sdr1@ordereat.com", "agustin@ordereat.com", { accounts: { "México": 2 } })).status, 403);
  assert.equal((await call("GET", T, "lider@ordereat.com", "agustin@ordereat.com")).status, 403); // no es de su equipo
  assert.equal((await call("GET", T, "lider@ordereat.com", "juandiego@ordereat.com")).status, 200);
  const ok = await call("POST", T, "lider@ordereat.com", "juandiego@ordereat.com", { accounts: { "Perú": 20758179 } });
  assert.equal(ok.status, 200); assert.equal(ok.out.rows.find(r => r.country === "Perú").id, 20758179);
  assert.equal((await call("POST", T, "dir@ordereat.com", "agustin@ordereat.com", { accounts: { "México": 2 } })).status, 200);
  assert.equal((await call("GET", T, "sdr1@ordereat.com", "sdr1@ordereat.com")).status, 404); // no es usuaria del Pipedrive de prueba
  assert.equal((await call("GET", T, "dir@ordereat.com", "nadie@ordereat.com")).status, 404);
  // el calendario solo es el propio: no hay ruta con el email de otro
  assert.ok(!Object.keys(routes).some(k => /calendar/.test(k) && /:email/.test(k)));
});
