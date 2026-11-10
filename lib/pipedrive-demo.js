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
  const org = { id: seq++, name: s.name, owner_id: h % 7 === 0 ? 2 : 1, label_ids: h >= 90 ? [1] : [] };
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
  return orgs.filter(o => { const w = words(o.name); return t.length && t.every(x => w.includes(x)); }).slice(0, limit).map(o => ({ id: o.id, name: o.name, ownerId: o.owner_id || 1 }));
}
export const dealsForOrg = id => deals.filter(d => d.org_id === id);
export const notesForOrg = (id, limit) => notes.filter(n => n.org_id === id).sort((a, b) => b.add_time.localeCompare(a.add_time)).slice(0, limit);
export const recentNotes = limit => [...notes].sort((a, b) => b.add_time.localeCompare(a.add_time)).slice(0, limit);
export const activities = ({ ownerId, orgId, done, limit }) => acts.filter(a => (!ownerId || a.owner_id === ownerId) && (!orgId || a.org_id === orgId) && !!a.done === !!done).sort((a, b) => (a.due_date + a.due_time).localeCompare(b.due_date + b.due_time)).slice(0, limit);
export const leadsByIds = ids => leads.filter(l => ids.includes(l.id)).map(l => ({ id: l.id, title: l.title, orgId: l.organization_id, personId: l.person_id, ownerId: l.owner_id || 1, paisOpt: l.paisOpt || null, ciudadOpt: null, fuenteOpt: l.fuenteOpt || null }));
export const personsByIds = ids => [];
export const orgsByIds = ids => orgs.filter(o => ids.includes(o.id)).map(o => ({ id: o.id, name: o.name, ownerId: o.owner_id || 1, labelIds: o.label_ids || [] }));
export const getActivity = id => acts.find(x => x.id === Number(id)) || null;
export const personsForOrg = id => persons.filter(p => p.org_id === id).map(p => ({ id: p.id, name: p.name, phone: p.phone || "", email: p.email || "" }));
export const meta = () => ({ users, pipes, stages });
export function createOrganization({ name, ownerId }) { const o = { id: seq++, name, owner_id: ownerId || 1 }; orgs.push(o); return o; }
export function updateOrganization(id, body) { const o = orgs.find(x => x.id === Number(id)); if (o) Object.assign(o, body); return o || { id, ...body }; }
export function addNote({ content, orgId, dealId, leadId }) { const n = { id: seq++, org_id: orgId, deal_id: dealId, lead_id: leadId, content, add_time: now(), user: { name: users[0].name }, organization: { name: orgs.find(o => o.id === orgId)?.name || "" } }; notes.push(n); return n; }
export function addActivity({ subject, type, dueDate, dueTime, orgId, dealId, leadId, ownerId, note, done }) { const a = { id: seq++, subject, type, due_date: dueDate, due_time: dueTime || "", org_id: orgId, deal_id: dealId, lead_id: leadId || null, owner_id: ownerId || 1, note, done: !!done }; acts.push(a); return a; }
// prospectos (leads) de prueba: unos pocos sin organización, con persona y una llamada pendiente para el usuario 1
const leads = [["Centro Educativo Los Álamos", "María Paredes", "+52 55 5555 0101"], ["Instituto Bilingüe del Valle", "Jorge Ruiz", "+52 33 3333 0202"], ["Colegio Monte Verde", "", ""]].map(([title, pname, phone], i) => {
  const p = pname ? { id: seq++, name: pname, phone, email: "", org_id: null } : null; if (p) persons.push(p);
  const l = { id: `demo-lead-${i}`, title, organization_id: null, person_id: p?.id || null, is_archived: false, owner_id: 1, paisOpt: i < 2 ? 91 : null };
  acts.push({ id: seq++, subject: "Llamada", type: "call", due_date: day(i - 1), due_time: "", org_id: null, deal_id: null, lead_id: l.id, owner_id: 1, note: i === 0 ? "hacerle seguimiento" : "", done: false });
  return l;
});
export const notesForLead = (id, limit) => notes.filter(n => n.lead_id === id).sort((a, b) => b.add_time.localeCompare(a.add_time)).slice(0, limit);
export const getPerson = id => { const p = persons.find(x => x.id === Number(id)); return p ? { id: p.id, name: p.name, phone: p.phone || "", email: p.email || "", orgId: p.org_id || null } : null; };
export function updatePerson(id, body) { const p = persons.find(x => x.id === Number(id)); if (p) Object.assign(p, body); return p; }
export const tokenOwner = () => ({ id: users[0].id, email: users[0].email, name: users[0].name });
export function updateLead(id, body) { const l = leads.find(x => x.id === id); if (l) Object.assign(l, body); return l; }
export function createLead({ title, ownerId, orgId, personId }) { const l = { id: `demo-lead-${seq++}`, title, organization_id: orgId || null, person_id: personId || null, owner_id: ownerId || 1, is_archived: false }; leads.push(l); return l; }
export const leadsForOrg = id => leads.filter(l => l.organization_id === id && !l.is_archived).map(l => ({ id: l.id, title: l.title, ownerId: l.owner_id || 1, personId: l.person_id || null }));
export function updateActivity(id, body) { const a = acts.find(x => x.id === Number(id)); if (!a) throw Object.assign(new Error("Actividad inexistente"), { status: 404 }); Object.assign(a, body); return a; }
export function createDeal(body) { const d = { id: seq++, status: "open", update_time: now(), ...body }; deals.push(d); return d; }
export function updateDeal(id, body) { const d = deals.find(x => x.id === Number(id)); if (d) Object.assign(d, body, body.status === "lost" ? { lost_time: now() } : {}); return d; }
export function addPerson({ name, orgId, phone, email }) { const p = { id: seq++, name, org_id: orgId, phone, email }; persons.push(p); return p; }
