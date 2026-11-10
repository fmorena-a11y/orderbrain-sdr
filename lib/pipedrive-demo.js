// Pipedrive de prueba en memoria (DEMO_MODE=1). Sirve para probar la app sin tocar la cuenta real.
import { schools } from "./store.js";

const hash = s => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const now = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const day = n => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
let seq = 1000;

const users = [
  { id: 1, name: process.env.DEV_LOGIN_EMAIL ? process.env.DEV_LOGIN_EMAIL.split("@")[0] : "Demo", email: (process.env.DEV_LOGIN_EMAIL || "demo@ordereat.com").toLowerCase() },
  { id: 2, name: "Juan Diego", email: "juandiego@ordereat.com" },
  { id: 3, name: "Agustín Tejos", email: "agustin@ordereat.com" },
  { id: 4, name: "Matías Favaro", email: "matias@ordereat.com" },
];
const pipes = { 1: "ARG - SALES", 2: "CHI - Sales", 3: "UY - SALES", 9: "MX - SALES", 12: "LatAm - SALES", 16: "ONBOARDING", 29: "PE - SALES" };
const stages = { 112: "SELLING", 14: "SELLING", 108: "SELLING", 160: "SELLING", 198: "SELLING", 258: "SELLING", 159: "PROPOSAL SENT", 164: "READY FOR LAUNCH" };
const PIPE_BY_COUNTRY = { "México": 9, "Perú": 29, "Argentina": 1, "Chile": 2, "Uruguay": 3 };

const orgs = [], deals = [], notes = [], acts = [], persons = [];
for (const s of schools) {
  const h = hash(s.id) % 100;
  if (h < 50) continue;
  const org = { id: seq++, name: s.name };
  orgs.push(org);
  const pipe = PIPE_BY_COUNTRY[s.country] || 12;
  if (h >= 62 && h < 78) deals.push({ id: seq++, org_id: org.id, title: `${s.name} - Trato`, status: "lost", pipeline_id: pipe, stage_id: h % 2 ? 159 : 160, lost_reason: ["No es prioridad ahora", "No responde más", "Es muy caro", "Ya tiene un software del estilo"][h % 4], lost_time: `${day(-120 - h * 3)} 10:00:00`, update_time: `${day(-120 - h * 3)} 10:00:00` });
  if (h >= 78 && h < 90) deals.push({ id: seq++, org_id: org.id, title: `${s.name} - Trato`, status: "open", pipeline_id: pipe, stage_id: 159, update_time: `${day(-5)} 10:00:00` });
  if (h >= 90) deals.push({ id: seq++, org_id: org.id, title: `${s.name} - Cliente`, status: "won", pipeline_id: 16, stage_id: 164, update_time: `${day(-200)} 10:00:00` });
  if (h >= 62) notes.push({ id: seq++, org_id: org.id, add_time: `${day(-130)} 15:20:00`, user: { name: "Juan Diego" }, content: `<b>Llamada</b><br>Habló con la administradora. La ${s.country === "Chile" ? "casino" : "cafetería"} es concesionada; pidió que volvamos a llamar el próximo ciclo.`, organization: { name: s.name } });
}
// Algunas actividades pendientes del usuario de prueba
schools.filter(s => hash(s.id) % 100 >= 50 && hash(s.id) % 100 < 62).slice(0, 6).forEach((s, i) => {
  const org = orgs.find(o => o.name === s.name);
  acts.push({ id: seq++, subject: ["Volver a llamar", "Mandar info", "Llamar al decisor"][i % 3] + ` · ${s.name}`, type: ["call", "task", "call", "deadline"][i % 4], due_date: day([-2, 0, 0, 1, 2, 4][i]), due_time: i % 2 ? "14:30:00" : "", org_id: org.id, owner_id: 1, done: false });
});

const words = s => String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").split(/\W+/).filter(w => w.length > 2);
export function searchOrganizations(term, limit) {
  const t = words(term);
  return orgs.filter(o => { const w = words(o.name); return t.length && t.every(x => w.includes(x)); }).slice(0, limit).map(o => ({ id: o.id, name: o.name }));
}
export const dealsForOrg = id => deals.filter(d => d.org_id === id);
export const notesForOrg = (id, limit) => notes.filter(n => n.org_id === id).sort((a, b) => b.add_time.localeCompare(a.add_time)).slice(0, limit);
export const recentNotes = limit => [...notes].sort((a, b) => b.add_time.localeCompare(a.add_time)).slice(0, limit);
export const activities = ({ ownerId, orgId, done, limit }) => acts.filter(a => (!ownerId || a.owner_id === ownerId) && (!orgId || a.org_id === orgId) && !!a.done === !!done).sort((a, b) => (a.due_date + a.due_time).localeCompare(b.due_date + b.due_time)).slice(0, limit);
export const orgsByIds = ids => orgs.filter(o => ids.includes(o.id)).map(o => ({ id: o.id, name: o.name }));
export const personsForOrg = id => persons.filter(p => p.org_id === id).map(p => ({ id: p.id, name: p.name, phone: p.phone || "", email: p.email || "" }));
export const meta = () => ({ users, pipes, stages });
export function createOrganization({ name }) { const o = { id: seq++, name }; orgs.push(o); return o; }
export function updateOrganization(id, body) { return { id, ...body }; }
export function addNote({ content, orgId, dealId }) { const n = { id: seq++, org_id: orgId, deal_id: dealId, content, add_time: now(), user: { name: users[0].name }, organization: { name: orgs.find(o => o.id === orgId)?.name || "" } }; notes.push(n); return n; }
export function addActivity({ subject, type, dueDate, dueTime, orgId, dealId, ownerId, note, done }) { const a = { id: seq++, subject, type, due_date: dueDate, due_time: dueTime || "", org_id: orgId, deal_id: dealId, owner_id: ownerId || 1, note, done: !!done }; acts.push(a); return a; }
export function updateActivity(id, body) { const a = acts.find(x => x.id === Number(id)); if (!a) throw Object.assign(new Error("Actividad inexistente"), { status: 404 }); Object.assign(a, body); return a; }
export function createDeal(body) { const d = { id: seq++, status: "open", update_time: now(), ...body }; deals.push(d); return d; }
export function updateDeal(id, body) { const d = deals.find(x => x.id === Number(id)); if (d) Object.assign(d, body, body.status === "lost" ? { lost_time: now() } : {}); return d; }
export function addPerson({ name, orgId, phone, email }) { const p = { id: seq++, name, org_id: orgId, phone, email }; persons.push(p); return p; }
