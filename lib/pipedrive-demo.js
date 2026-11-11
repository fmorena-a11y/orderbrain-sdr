// Pipedrive de prueba en memoria (DEMO_MODE=1). Sirve para probar la app sin tocar la cuenta real.
import { schools } from "./store.js";
import { OPTIONS, DEAL_FIELDS } from "./config.js";

const hash = s => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const now = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const ago = h => new Date(Date.now() - h * 3600e3).toISOString();
const day = n => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
let seq = 1000;

const users = [
  { id: 1, name: process.env.DEV_LOGIN_EMAIL ? process.env.DEV_LOGIN_EMAIL.split("@")[0] : "Demo", email: (process.env.DEV_LOGIN_EMAIL || "demo@ordereat.com").toLowerCase() },
  { id: 2, name: "Juan Diego", email: "juandiego@ordereat.com" },
  { id: 3, name: "Agustín Tejos", email: "agustin@ordereat.com" },
  { id: 4, name: "Matías Favaro", email: "matias@ordereat.com" },
  // dos más sin datos propios, para armar equipos con líderes y miembros (Equipos)
  { id: 5, name: "Valentina Ríos", email: "valentina@ordereat.com" },
  { id: 6, name: "Camila Soto", email: "camila@ordereat.com" },
];
const pipes = { 1: "ARG - SALES", 2: "CHI - Sales", 3: "UY - SALES", 9: "MX - SALES", 12: "LatAm - SALES", 16: "ONBOARDING", 29: "PE - SALES" };
// etapas con los ids y nombres de la cuenta real, en orden por embudo (LatAm no tiene PROPOSAL SENT)
const stageList = Object.entries({ 1: [[112, "SELLING"], [111, "PROPOSAL SENT"], [235, "HOT DEALS"], [201, "CLOSING"]], 2: [[14, "SELLING"], [23, "PROPOSAL SENT"], [236, "HOT DEALS"], [214, "CLOSING"]],
  3: [[108, "SELLING"], [110, "PROPOSAL SENT"], [237, "HOT DEALS"], [106, "CLOSING"]], 9: [[160, "SELLING"], [159, "PROPOSAL SENT"], [233, "HOT DEALS"], [124, "CLOSING"]],
  12: [[115, "A contactar"], [198, "SELLING"], [118, "NEGOTIATING"], [197, "CLOSING"]], 29: [[258, "SELLING"], [259, "PROPOSAL SENT"], [260, "HOT DEALS"], [261, "CLOSING"]],
  16: [[156, "PENDING TO KICK OFF"], [208, "DROPPED"], [245, "KICK OFF IN PROGRESS"], [161, "PENDING TO ONBOARD"], [167, "ONBOARDING IN PROGRESS"], [164, "READY FOR LAUNCH [active]"], [158, "LAUNCHED [+50]"]] })
  .flatMap(([pipe, l]) => l.map(([id, name], order) => ({ id, name, pipe: Number(pipe), order })));
const stages = Object.fromEntries(stageList.map(x => [x.id, x.name]));
const ENTRY = { 1: 112, 2: 14, 3: 108, 9: 160, 12: 198, 29: 258 }, PROP = { 1: 111, 2: 23, 3: 110, 9: 159, 12: 118, 29: 259 };
const PIPE_BY_COUNTRY = { "México": 9, "Perú": 29, "Argentina": 1, "Chile": 2, "Uruguay": 3 };

const orgs = [], deals = [], notes = [], acts = [], persons = [];
for (const s of schools) {
  const h = hash(s.id) % 100;
  if (h < 50) continue;
  const org = { id: seq++, name: s.name, owner_id: h % 7 === 0 ? 2 : 1, label_ids: h >= 90 ? [1] : [], country: s.country, city: s.city };
  orgs.push(org);
  const pipe = PIPE_BY_COUNTRY[s.country] || 12;
  if (h >= 62 && h < 78) deals.push({ id: seq++, org_id: org.id, owner_id: org.owner_id, title: `${s.name} - Trato`, status: "lost", pipeline_id: pipe, stage_id: h % 2 ? PROP[pipe] : ENTRY[pipe], lost_reason: ["No es prioridad ahora", "No responde más", "Es muy caro", "Ya tiene un software del estilo"][h % 4], lost_time: `${day(-120 - h * 3)} 10:00:00`, update_time: `${day(-120 - h * 3)} 10:00:00` });
  // en LatAm el país va en el campo País (como en la cuenta real); el campo SDR, en algunos
  if (h >= 78 && h < 90) deals.push({ id: seq++, org_id: org.id, owner_id: org.owner_id, title: `${s.name} - Trato`, status: "open", pipeline_id: pipe, stage_id: h % 2 ? PROP[pipe] : ENTRY[pipe], update_time: `${day(-5)} 10:00:00`,
    custom_fields: { [DEAL_FIELDS.pais]: pipe === 12 ? OPTIONS.pais[s.country] || null : null, [DEAL_FIELDS.sdr]: h % 3 ? [2, 3][h % 2] : null } });
  if (h >= 90) deals.push({ id: seq++, org_id: org.id, owner_id: org.owner_id, title: `${s.name} - Cliente`, status: "won", pipeline_id: 16, stage_id: 164, update_time: `${day(-200)} 10:00:00` });
  if (h >= 62) notes.push({ id: seq++, org_id: org.id, add_time: `${day(-130)} 15:20:00`, user: { name: "Juan Diego" }, content: `<b>Llamada</b><br>Habló con la administradora. La ${s.country === "Chile" ? "casino" : "cafetería"} es concesionada; pidió que volvamos a llamar el próximo ciclo.`, organization: { name: s.name } });
}
// Una red con tres planteles (como pasa en la cuenta real): una organización por plantel, a nombre de la cuenta general
// de la empresa (id 99, libre para el equipo), y prospectos con teléfono y dirección. Números de prueba.
const RED = ["Glandorff", "Kennedy", "Cordillera"].map(p => { const o = { id: seq++, name: `Esfer Salesianos Plantel ${p}`, owner_id: 99, label_ids: [] }; orgs.push(o); return o; });
const redLeads = [{ title: "Esfer Salesianos Plantel Kennedy", organization_id: RED[1].id, phone: "614 555 0101", email: "administracion@ejemplo.edu", addr: "Av. Kennedy 1821, Chihuahua, Chih., México" },
  { title: "preparatoria esfer salesianos kennedy", organization_id: null, phone: "614 555 0101 - 614 555 0102", web: "https://www.esfersalesianos.org/", addr: "calle kennedy 1821, chihuahua, chihuahua" },
  { title: "Esfer Salesianos Plantel Cordillera", organization_id: RED[2].id, phone: "+52 614 555 0103", addr: "Cordillera Blanca 9500, Chihuahua, Chih., México", archived: true }];
// Algunas actividades pendientes del usuario de prueba
schools.filter(s => hash(s.id) % 100 >= 50 && hash(s.id) % 100 < 62).slice(0, 6).forEach((s, i) => {
  const org = orgs.find(o => o.name === s.name);
  acts.push({ id: seq++, subject: ["Volver a llamar", "Mandar info", "Llamar al decisor"][i % 3] + ` · ${s.name}`, type: ["call", "task", "call", "deadline"][i % 4], due_date: day([-2, 0, 0, 1, 2, 4][i]), due_time: i % 2 ? "14:30:00" : "", org_id: org.id, owner_id: 1, done: false, add_time: ago(24 * (8 + i)) });
});
// demos (hora en UTC, como Pipedrive): una mañana del usuario de prueba y una hoy de otra persona
orgs.filter(o => o.owner_id === 1 && !o.label_ids.length).slice(8, 10).forEach((o, i) => acts.push({ id: seq++, subject: `Demo · ${o.name}`, type: "meeting", due_date: day(1 - i), due_time: "15:00:00", org_id: o.id, owner_id: [1, 2][i], done: false, add_time: ago(30 + 20 * i) }));
// lo hecho en la última semana por cada persona (para Actividad por persona en Métricas): llamadas, WhatsApp, mails y demos, y una tarea vencida de otra persona
orgs.slice(20, 44).forEach((o, i) => { const h = 6 + i * 6 + (i % 5) * 7, t = ["call", "deadline", "task", "call", "meeting", "call"][i % 6];
  acts.push({ id: seq++, subject: `${{ call: "Llamada", deadline: "WhatsApp", task: "Mail", meeting: "Demo" }[t]} · ${o.name}`, type: t, due_date: ago(h).slice(0, 10), due_time: "", org_id: o.id, owner_id: [1, 2, 3, 2][i % 4], done: true, add_time: ago(h + (t === "meeting" ? 72 : 0)), marked_as_done_time: ago(h) }); });
acts.push({ id: seq++, subject: `Volver a llamar · ${orgs[45]?.name || "Colegio"}`, type: "call", due_date: day(-3), due_time: "", org_id: orgs[45]?.id || null, owner_id: 2, done: false, add_time: ago(24 * 10) });
// Actividad por persona (Métricas), como en la cuenta real: un mail cargado con el tipo «LinkedIn» (email), llamadas no
// atendidas de Aircall con su propio tipo (como en la cuenta real, las crea la cuenta general 13493598 a nombre de quien
// llamó), tareas automáticas de diio (tipo Mail, también de la cuenta general), vencidas viejas que se cerraron estos días
// y vencidas sin hacer
orgs.slice(46, 58).forEach((o, i) => {
  const h = 10 + i * 9, owner = [1, 2, 3][i % 3], k = i % 4;
  if (k === 0) acts.push({ id: seq++, subject: `Mandé primer mail pidiendo visita · ${o.name}`, type: "email", due_date: ago(h).slice(0, 10), due_time: "", org_id: o.id, owner_id: owner, creator_user_id: owner, done: true, add_time: ago(h), marked_as_done_time: ago(h) });
  if (k === 1) acts.push({ id: seq++, subject: `Llamada saliente no atendida · ${o.name}`, type: "aircall_outbound_unanswere", due_date: ago(h).slice(0, 10), due_time: ago(h).slice(11, 19), org_id: o.id, owner_id: owner, creator_user_id: 13493598, done: true, add_time: ago(h), marked_as_done_time: ago(h) });
  if (k === 2) acts.push({ id: seq++, subject: `Mandar propuesta (diio) · ${o.name}`, type: "task", due_date: ago(h).slice(0, 10), due_time: "", org_id: o.id, owner_id: owner, creator_user_id: 13493598, done: true, add_time: ago(h), marked_as_done_time: ago(h) });
  if (k === 3) acts.push({ id: seq++, subject: `Volver a llamar · ${o.name}`, type: "call", due_date: day(-40 - i), due_time: "", org_id: o.id, owner_id: owner, creator_user_id: owner, done: true, add_time: ago(24 * (45 + i)), marked_as_done_time: ago(h) });
  acts.push({ id: seq++, subject: `Llamar · ${o.name}`, type: i % 2 ? "call" : "deadline", due_date: day(i < 6 ? -(i + 1) : -(20 + i)), due_time: "", org_id: o.id, owner_id: owner, creator_user_id: owner, done: false, add_time: ago(24 * (30 + i)) });
});
// una llamada de ayer que se marcó hecha hace 10 días (antes de su fecha) y no se tocó más; una de hoy con hora y otra de
// mañana sin hacer (todavía no vencen)
acts.push({ id: seq++, subject: `Llamada · ${orgs[58]?.name || "Colegio"}`, type: "call", due_date: day(-1), due_time: "", org_id: orgs[58]?.id || null, owner_id: 3, creator_user_id: 3, done: true, add_time: ago(24 * 12), marked_as_done_time: ago(24 * 10), update_time: ago(24 * 10) });
acts.push({ id: seq++, subject: `Llamada · ${orgs[59]?.name || "Colegio"}`, type: "call", due_date: day(0), due_time: "12:00:00", org_id: orgs[59]?.id || null, owner_id: 2, creator_user_id: 2, done: false, add_time: ago(24 * 3) });
acts.push({ id: seq++, subject: `WhatsApp · ${orgs[59]?.name || "Colegio"}`, type: "deadline", due_date: day(1), due_time: "", org_id: orgs[59]?.id || null, owner_id: 2, creator_user_id: 2, done: false, add_time: ago(24 * 3) });
// vencidas sin hacer a nombre de las dos cuentas generales (en la cuenta real las dos tienen): cada una en su fila
[[13493598, 2], [12660561, 4], [12660561, 40]].forEach(([g, d]) => acts.push({ id: seq++, subject: "Seguimiento automático", type: "task", due_date: day(-d), due_time: "", org_id: null, owner_id: g, creator_user_id: g, done: false, add_time: ago(24 * (d + 5)) }));
// un trato ganado esta semana
const wonNow = deals.find(d => d.status === "won"); if (wonNow) Object.assign(wonNow, { won_time: ago(50), update_time: ago(50) });

// Demos de los últimos 90 días y las próximas 2 semanas, para la lista y las métricas del equipo (Equipo). Las agendan
// Juan Diego (2) y Agustín (3) y las dan Matías (4) o el usuario de prueba (1). Unas con su resultado marcado desde la app,
// otras hechas en Pipedrive sin resultado («?») y otras vencidas sin marcar. Las agendadas desde la app las crea el
// dueño del token (1) y la nota dice quién las agendó, como en la cuenta real.
const RES = { done: "Se hizo", noshow: "No se presentó", moved: "Se reprogramó", canceled: "Se canceló" };
const mark = (k, d) => `[Resultado de la demo] ${RES[k]} · marcado por Matías Favaro desde OrderBrain SDR el ${d.slice(8, 10)}/${d.slice(5, 7)}`;
let nDone = 0;
orgs.filter(o => !o.label_ids.length).slice(60, 92).forEach((o, i) => {
  const off = i < 6 ? i * 2 + 1 : -(i - 5) * 3, due = day(off), setter = [2, 3, 2, 3, 2][i % 5], owner = [4, 1, 4][i % 3], app = i % 4 === 0;
  const res = off > 0 ? (i === 3 ? "moved" : null) : ["done", "noshow", null, "done", "canceled", "done", null, "moved", "done", null][i % 10];
  const note = [app ? `Agendada por ${users.find(u => u.id === setter).name} desde OrderBrain SDR` : "", res ? mark(res, day(Math.min(0, off + 1))) : ""].filter(Boolean).join("<br>");
  // las hechas sin resultado: la mitad marcada como hecha en Pipedrive, la otra mitad vencida sin tocar
  const done = !!res && res !== "moved" || (!res && off < 0 && i % 2 === 0);
  let dealId = null;
  if (res === "done") { // qué pasó con el trato: ganado, perdido, con propuesta, uno de la organización creado después, sin trato, o un trato borrado (?)
    const pipe = PIPE_BY_COUNTRY[o.country] || 12, k = nDone++ % 6, base = { org_id: o.id, owner_id: owner, title: `${o.name} - Demo`, pipeline_id: pipe, add_time: `${day(off - 10)} 12:00:00`, update_time: `${day(Math.min(0, off + 5))} 10:00:00` };
    const d = k === 0 ? { ...base, status: "won", stage_id: PROP[pipe], won_time: `${day(Math.min(0, off + 12))} 16:00:00` } : k === 1 ? { ...base, status: "lost", stage_id: PROP[pipe], lost_reason: "Es muy caro", lost_time: `${day(Math.min(0, off + 8))} 10:00:00` }
      : k === 2 ? { ...base, status: "open", stage_id: PROP[pipe] } : k === 3 ? { ...base, status: "open", stage_id: ENTRY[pipe], add_time: `${day(off + 1)} 12:00:00` } : null;
    if (d) { const x = { id: seq++, ...d }; deals.push(x); if (k !== 3) dealId = x.id; }
    if (k === 5) dealId = 999999;
  }
  acts.push({ id: seq++, subject: `Demo OrderEAT · ${o.name}`, type: "meeting", due_date: due, due_time: i === 9 ? "" : `${String(13 + i % 6).padStart(2, "0")}:00:00`, org_id: o.id, deal_id: dealId, owner_id: owner,
    creator_user_id: app ? 1 : setter, done, note, add_time: ago(24 * (Math.max(0, -off) + 5)), marked_as_done_time: done ? ago(24 * Math.max(0, -off)) : null });
});

// Para Métricas: entradas automáticas (las crea la cuenta general 13493598 ya hechas, como diio), demos pasadas a «No Show»
// (tipo lunch; una con la nota de la app), una cargada por un usuario que ya no está activo, y tratos ganados y perdidos
// en los últimos días (con motivo de la lista, uno con texto libre, y en LatAm con el campo País).
const GENERAL = 13493598;
["México", "Argentina", "Colombia", "Perú", "Chile", "México", "Uruguay", "México"].map((c, i) => orgs.filter(o => !o.label_ids.length && o.country === c)[30 + i]).filter(Boolean).forEach((o, i) => {
  const pipe = PIPE_BY_COUNTRY[o.country] || 12, off = -(i + 1), owner = [4, 1, 4, 2][i % 4];
  const d = { id: seq++, org_id: o.id, owner_id: owner, title: `${o.name} - Trato`, pipeline_id: pipe, add_time: `${day(off - 20)} 12:00:00`,
    custom_fields: { [DEAL_FIELDS.sdr]: [2, 3, null, 2][i % 4], [DEAL_FIELDS.pais]: pipe === 12 ? OPTIONS.pais[o.country] || null : null } };
  if (i < 2) Object.assign(d, { status: "won", stage_id: PROP[pipe], won_time: `${day(off)} 16:00:00`, update_time: `${day(off)} 16:00:00` });
  else Object.assign(d, { status: "lost", stage_id: i % 2 ? PROP[pipe] : ENTRY[pipe], lost_reason: ["No responde más", "Es muy caro", "No es prioridad ahora", "Se fue con otra empresa del barrio", "No responde más", "No le interesa"][i - 2], lost_time: `${day(off)} 11:00:00`, update_time: `${day(off)} 11:00:00` });
  deals.push(d);
  const at = ago(24 * (i + 1) + 3), t = i % 4;
  if (t === 0) acts.push({ id: seq++, subject: `Demo · ${o.name}`, type: "meeting", due_date: day(off), due_time: "", org_id: o.id, deal_id: d.id, owner_id: owner, creator_user_id: GENERAL, done: true, note: "", add_time: at, marked_as_done_time: at });
  if (t === 1) acts.push({ id: seq++, subject: `Demo · ${o.name}`, type: "lunch", due_date: day(off), due_time: "15:00:00", org_id: o.id, deal_id: d.id, owner_id: owner, creator_user_id: 1, done: true, note: "Agendada por Juan Diego desde OrderBrain SDR", add_time: ago(24 * (i + 4)), marked_as_done_time: at });
  if (t === 2) acts.push({ id: seq++, subject: `Demo · ${o.name}`, type: "lunch", due_date: day(off), due_time: "", org_id: o.id, deal_id: d.id, owner_id: owner, creator_user_id: 3, done: true, note: "", add_time: ago(24 * (i + 3)), marked_as_done_time: at });
  if (t === 3) acts.push({ id: seq++, subject: `Demo · ${o.name}`, type: "meeting", due_date: day(off), due_time: "", org_id: o.id, deal_id: null, owner_id: owner, creator_user_id: 77, done: false, note: "", add_time: ago(24 * (i + 2)) });
  // una entrada automática que repite la No Show de arriba (mismo trato, mismo día): cuenta una sola vez
  if (t === 1) acts.push({ id: seq++, subject: `No Show · ${o.name}`, type: "lunch", due_date: day(off), due_time: "", org_id: o.id, deal_id: d.id, owner_id: owner, creator_user_id: GENERAL, done: true, note: "", add_time: ago(24 * i + 2), marked_as_done_time: ago(24 * i + 2) });
  // una demo a nombre de la cuenta general (dueña): también se lee
  if (i === 2) acts.push({ id: seq++, subject: `Demo · ${o.name}`, type: "meeting", due_date: day(off), due_time: "17:00:00", org_id: o.id, deal_id: d.id, owner_id: GENERAL, creator_user_id: 2, done: true, note: "", add_time: ago(24 * (i + 6)), marked_as_done_time: ago(24 * i) });
});

const words = s => String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").split(/\W+/).filter(w => w.length > 2);
const wordCache = new Map(), orgWords = name => { let w = wordCache.get(name); if (!w) wordCache.set(name, w = new Set(words(name))); return w; };
export function searchOrganizations(term, limit) {
  const t = words(term);
  return orgs.filter(o => { const w = orgWords(o.name); return t.length && t.every(x => w.has(x)); }).slice(0, limit).map(o => ({ id: o.id, name: o.name, ownerId: o.owner_id === 99 ? null : o.owner_id || 1 }));
}
export const dealsForOrg = id => deals.filter(d => d.org_id === id);
export const notesForOrg = (id, limit) => notes.filter(n => n.org_id === id).sort((a, b) => b.add_time.localeCompare(a.add_time)).slice(0, limit);
export const recentNotes = limit => [...notes].sort((a, b) => b.add_time.localeCompare(a.add_time)).slice(0, limit);
export const activities = ({ ownerId, orgId, leadId, done, limit }) => acts.filter(a => (!ownerId || a.owner_id === ownerId) && (!orgId || a.org_id === orgId) && (!leadId || a.lead_id === leadId) && !!a.done === !!done).sort((a, b) => (a.due_date + a.due_time).localeCompare(b.due_date + b.due_time)).slice(0, limit);
export const leadsByIds = ids => leads.filter(l => ids.includes(l.id)).map(l => ({ ...leadOut(l), paisOpt: l.paisOpt || null, ciudadOpt: null, estadoOpt: null, fuenteOpt: l.fuenteOpt || null }));
// «demo-lead-caido» simula que Pipedrive no responde (para probar que sin saber el dueño no se manda nada)
export const getLead = id => { if (id === "demo-lead-caido") throw Object.assign(new Error("Pipedrive no responde (simulado)"), { status: 503 }); return leadsByIds([id])[0] || null; };
export const personsByIds = ids => [];
export const orgsByIds = ids => orgs.filter(o => ids.includes(o.id)).map(o => ({ id: o.id, name: o.name, ownerId: o.owner_id === 99 ? null : o.owner_id || 1, labelIds: o.label_ids || [], country: o.country || "", city: o.city || "", region: o.region || "", addr: o.addr || "" }));
export const getActivity = id => acts.find(x => x.id === Number(id)) || null;
export const personsForOrg = id => persons.filter(p => p.org_id === id).map(p => ({ id: p.id, name: p.name, phone: p.phone || "", email: p.email || "" }));
// allUsers: también las cuentas generales y alguien que ya no está (el Historial dice quién hizo cada cosa)
const allUsers = [...users, { id: 99, name: "OrderEAT" }, { id: 13493598, name: "OrderEAT" }, { id: 12660561, name: "Contacto OrderEAT" }, { id: 5, name: "Lucía Benítez" }];
export const meta = () => ({ users, allUsers, pipes, stages, stageList });
// Historial: actividades hechas y notas de un prospecto, una organización, un trato o una persona (las más nuevas primero)
const hits = (x, { orgId, leadId, personId, dealId }) => (!orgId || x.org_id === Number(orgId)) && (!leadId || x.lead_id === leadId) && (!personId || x.person_id === Number(personId)) && (!dealId || x.deal_id === Number(dealId));
export function doneActivities({ orgId, leadId, personId, dealId, limit = 500 }) {
  if (leadId === "demo-lead-caido" || orgId === -1) throw Object.assign(new Error("Pipedrive no responde (simulado)"), { status: 503 });
  const l = acts.filter(a => a.done && (orgId || leadId || personId || dealId) && hits(a, { orgId, leadId, personId, dealId })).sort((a, b) => (b.due_date + (b.due_time || "")).localeCompare(a.due_date + (a.due_time || "")))
    .map(a => ({ ...a, add_time: iso(a.add_time), marked_as_done_time: iso(a.marked_as_done_time), creator_user_id: a.creator_user_id || a.owner_id || 1 }));
  return { items: l.slice(0, limit), more: l.length > limit };
}
export function notesAll({ orgId, leadId, personId, dealId, limit = 500 }) {
  const l = notes.filter(n => (orgId || leadId || personId || dealId) && hits(n, { orgId, leadId, personId, dealId })).sort((a, b) => String(b.add_time).localeCompare(String(a.add_time)));
  return { items: l.slice(0, limit), more: l.length > limit };
}
export const getDeal = id => deals.find(d => d.id === Number(id)) || null;
export function createOrganization({ name, ownerId }) { const o = { id: seq++, name, owner_id: ownerId || 1, update_time: now() }; orgs.push(o); return o; }
export function updateOrganization(id, body) { const o = orgs.find(x => x.id === Number(id)); if (o) Object.assign(o, body, { update_time: now() }); return o || { id, ...body }; }
// Listados por páginas como v2 (cursor opaco: acá, la posición). since: solo lo cambiado desde esa fecha.
const changedSince = (x, since) => !since || String(x.update_time || "").replace(" ", "T").slice(0, 19) >= String(since).slice(0, 19);
// un cursor que no es de este listado: 400, como la API real
function page(list, { cursor, limit }) {
  if (cursor != null && !/^\d+$/.test(String(cursor))) throw Object.assign(new Error("Pipedrive respondió 400: el cursor no es válido"), { status: 400 });
  const at = Number(cursor) || 0, items = list.slice(at, at + limit); return { items, next: at + limit < list.length ? String(at + limit) : null };
}
// DEMO_PD_LAG_MS: demora por página (para probar el progreso y la pausa como con la cuenta real)
const lag = () => new Promise(r => setTimeout(r, Number(process.env.DEMO_PD_LAG_MS) || 0));
export async function orgsPage({ cursor, since, limit = 500 }) {
  await lag();
  const r = page(orgs.filter(o => changedSince(o, since)), { cursor, limit });
  return { items: r.items.map(o => ({ id: o.id, name: o.name, ownerId: realOwner(o.owner_id), deleted: false })), next: r.next };
}
export async function dealsPage({ cursor, since, limit = 500 }) {
  await lag();
  const r = page(deals.filter(d => changedSince(d, since)), { cursor, limit });
  return { items: r.items.map(d => ({ id: d.id, org_id: d.org_id || null, status: d.status, pipeline_id: d.pipeline_id, stage_id: d.stage_id, owner_id: d.owner_id || null, lost_reason: d.lost_reason || null, lost_time: d.lost_time || null, update_time: d.update_time || null, deleted: false })), next: r.next };
}
export function addNote({ content, orgId, dealId, leadId, personId }) { const n = { id: seq++, org_id: orgId, deal_id: dealId, lead_id: leadId, person_id: personId || null, content, add_time: now(), user_id: users[0].id, user: { name: users[0].name }, organization: { name: orgs.find(o => o.id === orgId)?.name || "" } }; notes.push(n); return n; }
export function addActivity({ subject, type, dueDate, dueTime, orgId, dealId, leadId, personId, ownerId, note, done }) { const a = { id: seq++, subject, type, due_date: dueDate, due_time: dueTime || "", org_id: orgId, deal_id: dealId, lead_id: leadId || null, person_id: personId || null, owner_id: ownerId || 1, creator_user_id: users[0].id, note, done: !!done, add_time: ago(0), update_time: ago(0), marked_as_done_time: done ? ago(0) : null }; acts.push(a); return a; }
// como v2: fechas en UTC con Z; el último cambio (update_time), o si no hay, la de hecha o la de creación
const iso = v => v ? (String(v).includes("T") ? String(v) : String(v).replace(" ", "T") + "Z") : null;
const touched = x => iso(x.update_time || x.marked_as_done_time || x.add_time) || "";
// Actividad por persona (Métricas): como v2 (done, ventana de último cambio y orden por id, vencimiento, último cambio o creación)
export async function activitiesPage({ cursor, done, updatedSince, updatedUntil, sortBy = "id", sortDirection = "asc", limit = 500 }) {
  await lag();
  const key = a => sortBy === "due_date" ? a.due_date || "" : sortBy === "update_time" ? touched(a) : sortBy === "add_time" ? iso(a.add_time) || "" : String(a.id).padStart(12, "0");
  const l = acts.filter(a => (done == null || !!a.done === !!done) && (!updatedSince || touched(a) >= updatedSince) && (!updatedUntil || touched(a) < updatedUntil))
    .sort((a, b) => key(a).localeCompare(key(b)) * (sortDirection === "desc" ? -1 : 1) || a.id - b.id);
  const r = page(l, { cursor, limit });
  return { items: r.items.map(a => ({ ...a, add_time: iso(a.add_time), update_time: touched(a), marked_as_done_time: iso(a.marked_as_done_time), creator_user_id: a.creator_user_id || a.owner_id || 1 })), next: r.next };
}
// los tipos de actividad de la cuenta real (nombre con el que se ven en Pipedrive), en su orden
const TYPES = [["call", "Llamada"], ["meeting", "Demo"], ["task", "Mail"], ["deadline", "WhatsApp"], ["email", "LinkedIn"], ["lunch", "No Show"], ["contacto_decisor", "Contacto decisor"], ["aircall_outbound_unanswere", "Llamada saliente no atendida (Aircall)"]];
export const activityTypes = () => TYPES.map(([key, name]) => ({ key, name, active: true }));
// demos del equipo: actividades crudas de una persona por vencimiento (de la más lejana a la más vieja), como v2
export async function demoActsPage({ cursor, ownerId, limit = 500 }) {
  await lag();
  const due = a => a.due_date + (a.due_time || "");
  const r = page(acts.filter(a => !ownerId || Number(a.owner_id || 1) === Number(ownerId)).sort((a, b) => due(b).localeCompare(due(a))), { cursor, limit });
  return { items: r.items.map(a => ({ ...a, creator_user_id: a.creator_user_id || a.owner_id || 1, outcome: null })), next: r.next };
}
export const dealsByIds = ids => deals.filter(d => ids.includes(d.id));
// Métricas: actividades como v2 (por creación o por último cambio, o por ids) y tratos con la próxima actividad y los campos SDR y País
export async function activitiesV2({ cursor, sortBy = "add_time", sortDirection = "desc", updatedSince, ids, limit = 500 }) {
  await lag();
  const want = ids?.length ? new Set(ids.map(Number)) : null;
  const key = a => sortBy === "update_time" ? touched(a) : sortBy === "id" ? String(a.id).padStart(12, "0") : iso(a.add_time) || "";
  const l = acts.filter(a => want ? want.has(a.id) : !updatedSince || touched(a) >= updatedSince).sort((a, b) => key(a).localeCompare(key(b)) * (sortDirection === "desc" ? -1 : 1) || a.id - b.id);
  const r = page(l, { cursor, limit });
  return { items: r.items.map(a => ({ ...a, add_time: iso(a.add_time), marked_as_done_time: iso(a.marked_as_done_time), update_time: touched(a), creator_user_id: a.creator_user_id || a.owner_id || 1, outcome: null })), next: r.next };
}
export async function metricDealsPage({ cursor, status, since, limit = 500 }) {
  await lag();
  const r = page(deals.filter(d => (!status || d.status === status) && (!since || touched(d) >= since)), { cursor, limit });
  return { items: r.items.map(d => ({ id: d.id, title: d.title || "", status: d.status, pipeline_id: d.pipeline_id, stage_id: d.stage_id, owner_id: d.owner_id || null, won_time: iso(d.won_time), lost_time: iso(d.lost_time),
    lost_reason: d.lost_reason || null, update_time: iso(d.update_time), next_activity_id: acts.find(a => a.deal_id === d.id && !a.done)?.id || null, sdr: d.custom_fields?.[DEAL_FIELDS.sdr] ?? null, pais: d.custom_fields?.[DEAL_FIELDS.pais] ?? null })), next: r.next };
}
// prospectos (leads) de prueba: unos pocos sin organización, con persona y una llamada pendiente para el usuario 1
const leads = [...redLeads.map((l, i) => ({ id: `demo-red-${i}`, person_id: null, is_archived: !!l.archived, owner_id: 99, ...l })), ...[["Centro Educativo Los Álamos", "María Paredes", "+52 55 5555 0101"], ["Instituto Bilingüe del Valle (EduExperience Puebla 2026)", "Jorge Ruiz", "+52 33 3333 0202"], ["Colegio Monte Verde", "", ""]].map(([title, pname, phone], i) => {
  const p = pname ? { id: seq++, name: pname, phone, email: "", org_id: null } : null; if (p) persons.push(p);
  // creados hace 2 horas, 1 día y 20 días (los dos primeros entran en la bandeja caliente de Hoy)
  const l = { id: `demo-lead-${i}`, title, organization_id: null, person_id: p?.id || null, is_archived: false, owner_id: 1, creator_id: 99, add_time: ago([2, 26, 480][i]), paisOpt: i < 2 ? 91 : null };
  acts.push({ id: seq++, subject: "Llamada", type: "call", due_date: day(i - 1), due_time: "", org_id: null, deal_id: null, lead_id: l.id, owner_id: 1, note: i === 0 ? "hacerle seguimiento" : "", done: false });
  return l;
})];
// Un prospecto con historia, como en la cuenta real: importado hace más de un año por la cuenta general, una llamada de
// junio de otra persona («No tienen cafeteria») y ayer varias del usuario de prueba (ocupado, recepción que pidió llamar
// más tarde, una con el plan, una que estaba para hoy y se marcó hecha antes), una nota de Enriquecer y dos llamadas sin
// hacer (una vencida). Números de prueba.
{
  const L = "demo-lead-historial", y = day(-1), at = (d, hm) => `${d}T${hm}:00Z`;
  leads.push({ id: L, title: "Centro Educativo Las Bugambilias", organization_id: null, person_id: null, is_archived: false, owner_id: 1, creator_id: 13493598, origin: "Import",
    add_time: "2025-08-05T01:24:36.687Z", paisOpt: 91, phone: "(222) 555 0147", addr: "calle de prueba 47, Puebla, Puebla" });
  const a = (x) => acts.push({ id: seq++, type: "call", org_id: null, deal_id: null, person_id: null, lead_id: L, owner_id: 1, creator_user_id: x.owner_id || 1, done: true, due_time: "", ...x });
  a({ subject: "Llamada", owner_id: 2, due_date: day(-139), add_time: at(day(-139), "17:10"), marked_as_done_time: at(day(-139), "17:10"), note: "No tienen cafeteria" });
  a({ subject: "Llamada – visita Joaco", due_date: y, add_time: at(y, "19:02"), marked_as_done_time: at(y, "19:11"), note: "287 alumnos. Llamar al (222) 555 0147 (sin WhatsApp). Pedir quien ve la cafetería y ofrecer visita de Joaquín el miércoles por la tarde o el jueves." });
  a({ subject: "Llamada", due_date: y, add_time: at(y, "19:03"), marked_as_done_time: at(y, "19:03"), note: "esta ocupada la linea" });
  a({ subject: "Llamada", due_date: day(0), add_time: at(y, "19:03"), marked_as_done_time: at(y, "19:10"), note: null });
  a({ subject: "Llamada", due_date: y, add_time: at(y, "19:06"), marked_as_done_time: at(y, "19:10"), note: "me dijeron de recepción (no me quiso decir su nombre) que llamara mas tarde que no se encontraba ni la directora ni la encargada de la cafetería&nbsp;" });
  a({ subject: "Llamada", due_date: y, due_time: "20:15", add_time: at(y, "19:07"), done: false, marked_as_done_time: null, note: null });
  a({ subject: "Llamada", due_date: day(0), due_time: "16:00", add_time: at(y, "19:08"), done: false, marked_as_done_time: null, note: null });
  notes.push({ id: seq++, lead_id: L, org_id: null, deal_id: null, person_id: null, user_id: 1, user: { name: users[0].name }, lead: { title: "Centro Educativo Las Bugambilias" }, add_time: `${y} 21:38:26`,
    content: `<b>Datos del colegio · OrderBrain SDR</b><br>Enriquecido el ${y} por ${users[0].name}. Cada dato dice de dónde salió.<br><ul><li>Teléfono: (222) 555 0147 (Prospecto en Pipedrive)</li><li>Mail: <a href="mailto:contacto@ejemplo.edu.mx">contacto@ejemplo.edu.mx</a> (Web cargada en Pipedrive)</li></ul>` });
}
// uno nuevo de otra persona (no tiene que aparecerle a nadie más)
leads.push({ id: "demo-lead-otro", title: "Colegio San Ignacio (EduExperience Puebla 2026)", organization_id: null, person_id: null, is_archived: false, owner_id: 2, creator_id: 99, add_time: ago(1) });
// El mismo colegio cargado varias veces en Pipedrive (como «Colegio Valladolid» en la cuenta real) y sedes de la misma
// marca en otras ciudades, para probar «Es esta» y fusionar. Van primeras (la búsqueda las devuelve antes) y con ids
// bajos (en un empate de candidatas gana la más vieja). Números y direcciones de prueba.
const DUP = schools.find(s => s.id === "guadalajara-colegio-valladolid");
if (DUP) {
  const o = (id, name, owner, place = {}) => ({ id, name, owner_id: owner, label_ids: [], ...place });
  const gdl = { city: "Guadalajara", region: "Jalisco", country: "México", addr: "Av. de prueba 123, Guadalajara, Jal., México" };
  const dup = [o(901, "Colegio Valladolid", 99), o(902, "INSTITUTO VALLADOLID", 99), o(903, "Colegio Valladolid", 2, gdl),
    o(904, "Colegio Valladolid Pachuca", 99, { city: "Pachuca", region: "Hidalgo", country: "México" }), o(905, "Colegio Valladolid Cancún", 99, { city: "Cancún", region: "Quintana Roo", country: "México" })];
  orgs.unshift(...dup);
  deals.push({ id: seq++, org_id: 901, owner_id: 99, title: "Colegio Valladolid - Trato", status: "lost", pipeline_id: 9, stage_id: 160, lost_reason: "No responde más", lost_time: `${day(-400)} 10:00:00`, update_time: `${day(-400)} 10:00:00` },
    { id: seq++, org_id: 903, owner_id: 2, title: "Colegio Valladolid", status: "open", pipeline_id: 9, stage_id: 160, update_time: `${day(-3)} 10:00:00` },
    { id: seq++, org_id: 905, owner_id: 3, title: "Colegio Valladolid Cancún", status: "won", pipeline_id: 16, stage_id: 158, won_time: `${day(-90)} 10:00:00`, update_time: `${day(-90)} 10:00:00` });
  notes.push({ id: seq++, org_id: 901, add_time: `${day(-400)} 11:00:00`, user: { name: "Juan Diego" }, content: "<b>Llamada</b><br>Atendió recepción, la cafetería la maneja la escuela.", organization: { name: "Colegio Valladolid" } });
  persons.push({ id: seq++, name: "Recepción Colegio Valladolid", phone: "+52 33 5555 0901", email: "", org_id: 901 }, { id: seq++, name: "Administración Instituto Valladolid", phone: "+52 33 5555 0902", email: "", org_id: 902 });
  leads.push({ id: "demo-lead-valladolid", title: "Instituto Valladolid", organization_id: 902, person_id: null, is_archived: false, owner_id: 99, creator_id: 99, add_time: ago(24 * 30) });
  acts.push({ id: seq++, subject: "Volver a llamar · INSTITUTO VALLADOLID", type: "call", due_date: day(2), due_time: "", org_id: 902, owner_id: 1, done: false, add_time: ago(48) });
}
// Historial con organizaciones del mismo nombre (como «Colegio Americano» en la cuenta real): la de Puebla (la del colegio),
// una de Veracruz con conmutador y mail en una nota (no tiene que aparecer en la ficha de Puebla) y una sin ciudad (va a la
// lista, no al resumen). Números y mails de prueba.
if (schools.some(s => s.id === "puebla-de-zaragoza-colegio-americano")) {
  const y = day(-1), o = (id, place = {}) => ({ id, name: "Colegio Americano", owner_id: 99, label_ids: [], ...place });
  orgs.unshift(o(911, { city: "Puebla", region: "Puebla", country: "México", addr: "Calle de prueba 10, Puebla, Pue., México" }), o(912, { city: "Veracruz", region: "Veracruz", country: "México", addr: "Calle de prueba 20, Veracruz, Ver., México" }), o(913));
  notes.push({ id: seq++, org_id: 912, add_time: `${day(-30)} 16:00:00`, user: { name: "Juan Diego" }, content: "<b>Llamada</b><br>Conmutador 229 555 0130. Mail recepcion@ejemplo-veracruz.edu.mx. Llamar la semana que viene." });
  acts.push({ id: seq++, subject: "Llamada", type: "call", due_date: y, due_time: "", org_id: 912, owner_id: 3, done: true, add_time: `${y}T17:00:00Z`, marked_as_done_time: `${y}T17:05:00Z`, note: "Atendió recepción: que llame a las 10 para hablar con la directora" },
    { id: seq++, subject: "Llamada", type: "call", due_date: day(-20), due_time: "", org_id: 913, owner_id: 2, done: true, add_time: `${day(-20)}T17:00:00Z`, marked_as_done_time: `${day(-20)}T17:05:00Z`, note: "No contestaron" },
    { id: seq++, subject: "Llamada", type: "call", due_date: day(-6), due_time: "", org_id: 911, owner_id: 1, done: true, add_time: `${day(-6)}T17:00:00Z`, marked_as_done_time: `${day(-6)}T17:05:00Z`, note: "Habló con la administradora. Pidió que volvamos a llamar el próximo mes." });
}
export const recentLeads = (ownerId, limit) => leads.filter(l => realOwner(l.owner_id) === ownerId && !l.is_archived).sort((a, b) => String(b.add_time || "").localeCompare(String(a.add_time || ""))).slice(0, limit).map(leadOut);
export const notesByUser = (userId, startDate, limit) => notes.filter(n => n.user_id === userId && n.add_time >= startDate).slice(0, limit);
export const notesForLead = (id, limit) => notes.filter(n => n.lead_id === id).sort((a, b) => b.add_time.localeCompare(a.add_time)).slice(0, limit);
export const getPerson = id => { const p = persons.find(x => x.id === Number(id)); return p ? { id: p.id, name: p.name, phone: p.phone || "", email: p.email || "", orgId: p.org_id || null } : null; };
export function updatePerson(id, body) { const p = persons.find(x => x.id === Number(id)); if (p) Object.assign(p, body); return p; }
export const tokenOwner = () => ({ id: users[0].id, email: users[0].email, name: users[0].name });
export function updateLead(id, body) { const l = leads.find(x => x.id === id); if (l) Object.assign(l, body); return l; }
export function createLead({ title, ownerId, orgId, personId }) { const l = { id: `demo-lead-${seq++}`, title, organization_id: orgId || null, person_id: personId || null, owner_id: ownerId || 1, creator_id: users[0].id, add_time: ago(0), is_archived: false }; leads.push(l); return l; }
const realOwner = id => id === 99 ? null : id || 1;
const leadOut = l => ({ id: l.id, title: l.title, orgId: l.organization_id || null, personId: l.person_id || null, ownerId: realOwner(l.owner_id), archived: !!l.is_archived, phone: l.phone || "", email: l.email || "", web: l.web || "", addr: l.addr || "", addTime: l.add_time || null, creatorId: l.creator_id || null, origin: l.origin || "" });
export const leadsForOrg = id => leads.filter(l => l.organization_id === id && !l.is_archived).map(leadOut);
export const searchLeads = (term, limit, keep = () => true) => { const t = String(term).toLowerCase().split(" "); return leads.filter(l => t.every(w => l.title.toLowerCase().includes(w)) && keep(l.title)).slice(0, limit).map(leadOut); };
export function updateActivity(id, body) { const a = acts.find(x => x.id === Number(id)); if (!a) throw Object.assign(new Error("Actividad inexistente"), { status: 404 }); Object.assign(a, body, { update_time: ago(0) }, "done" in body ? { marked_as_done_time: body.done ? ago(0) : null } : {}); return a; }
// conversión de prueba: el trato hereda título, organización, persona y dueño; las actividades y notas pasan al trato
export function convertLead(id, { pipelineId, stageId } = {}) {
  const l = leads.find(x => x.id === id); if (!l || l.is_archived) throw Object.assign(new Error("Prospecto inexistente"), { status: 404 });
  const d = { id: seq++, status: "open", update_time: now(), title: l.title, org_id: l.organization_id || null, person_id: l.person_id || null, owner_id: l.owner_id || 1, pipeline_id: pipelineId || 12, stage_id: stageId || 198 };
  deals.push(d); l.is_archived = true;
  for (const a of acts) if (a.lead_id === id) { a.lead_id = null; a.deal_id = d.id; a.org_id ||= d.org_id; }
  for (const n of notes) if (n.lead_id === id) { n.lead_id = null; n.deal_id = d.id; n.org_id ||= d.org_id; }
  return { dealId: d.id };
}
export function createDeal(body) { const d = { id: seq++, status: "open", update_time: now(), ...body }; deals.push(d); return d; }
export function updateDeal(id, body) { const d = deals.find(x => x.id === Number(id)); if (d) Object.assign(d, body, { update_time: now() }, body.status === "lost" ? { lost_time: now() } : body.status === "won" ? { won_time: now() } : {}); return d; }
export function addPerson({ name, orgId, phone, email, ownerId }) { const p = { id: seq++, name, org_id: orgId, phone, email, owner_id: ownerId || 1 }; persons.push(p); return p; }
// fusión de prueba (como PUT /v1/organizations/{id}/merge): queda mergeWithId; tratos, prospectos, personas, notas y
// actividades de la otra pasan a esa y la otra se borra
export function mergeOrganization(id, mergeWithId) {
  const i = orgs.findIndex(o => o.id === Number(id)), keep = orgs.find(o => o.id === Number(mergeWithId));
  if (i < 0 || !keep) throw Object.assign(new Error("Pipedrive respondió 404: esa organización no existe"), { status: 404 });
  const gone = orgs[i], at = now();
  for (const d of deals) if (d.org_id === gone.id) Object.assign(d, { org_id: keep.id, update_time: at });
  for (const l of leads) if (l.organization_id === gone.id) l.organization_id = keep.id;
  for (const p of persons) if (p.org_id === gone.id) p.org_id = keep.id;
  for (const n of notes) if (n.org_id === gone.id) Object.assign(n, { org_id: keep.id, organization: { name: keep.name } });
  for (const a of acts) if (a.org_id === gone.id) a.org_id = keep.id;
  orgs.splice(i, 1); keep.update_time = at;
  return { id: keep.id };
}
