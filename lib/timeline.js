// Historial de la ficha y «Resumen para la próxima llamada», puro (sin pedidos). lib/sales.js (timelineFor) junta lo de
// Pipedrive (actividades hechas y notas del prospecto, de la organización y sus duplicadas, de sus tratos y personas;
// creación de prospectos y tratos, ganados y perdidos) y lo de la app (contactos registrados y mails enviados). Acá se
// arma una sola línea de tiempo, de lo más nuevo a lo más viejo, sin repetir: un contacto registrado en la app es una
// entrada aunque en Pipedrive haya dejado una actividad y una nota; un mail enviado, también.
// El resumen sale SOLO de lo que dicen las actividades y notas (citas textuales, con la entrada de donde sale cada dato).
import { outcomeById, playbookFor } from "./playbook.js";
import { TYPE_LABEL, CHANNEL_TYPE, market } from "./config.js";
import { todayIn, weekday, fromUtc } from "./time.js";

// ---------- texto
const ENT = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", "#039": "'", apos: "'" };
export const plain = h => String(h ?? "").replace(/<br\s*\/?>/gi, "\n").replace(/<(ul|ol)[^>]*>/gi, "\n").replace(/<\/(p|li|div|h\d|ul|ol)>/gi, "\n").replace(/<li[^>]*>/gi, "• ")
  .replace(/<[^>]+>/g, "").replace(/&(nbsp|amp|lt|gt|quot|#39|#039|apos);/g, (_, k) => ENT[k]).replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
  .replace(/ /g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/\n\n(?=• )/g, "\n").trim();
// primera línea en negrita de una nota («<b>Comentario</b><br>…»): el título; lo demás, el texto
export function splitHead(html) {
  const m = /^\s*<b>([\s\S]*?)<\/b>/i.exec(String(html || ""));
  return m ? { head: plain(m[1]).replace(/\s+/g, " "), rest: String(html).slice(m[0].length) } : { head: "", rest: String(html || "") };
}
// filas «<b>Decisor:</b> Ana» de la nota que deja Registrar
export const rowsOf = html => String(html || "").split(/<br\s*\/?>/i).map(x => /^\s*<b>([^<]{1,40}):<\/b>\s*(.*)$/i.exec(x)).filter(Boolean)
  .map(m => [plain(m[1]), plain(m[2])]).filter(([k, v]) => k && v);

// ---------- fechas (Pipedrive: v2 en ISO con Z; v1 «YYYY-MM-DD HH:MM:SS» en UTC; vencimiento como fecha y hora UTC aparte)
export const iso = v => {
  if (!v) return null;
  let s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s += "T12:00:00Z";
  s = s.replace(" ", "T"); if (!/[zZ]$|[+-]\d\d:?\d\d$/.test(s)) s += "Z";
  const t = Date.parse(s); return isNaN(t) ? null : new Date(t).toISOString();
};
const ms = v => (v ? Date.parse(v) : NaN);
const near = (a, b, min = 15) => !!a && !!b && Math.abs(ms(a) - ms(b)) <= min * 60e3;
// vencimiento de una actividad en la zona de quien mira: { day, time } (sin hora, la fecha queda igual)
export const dueOf = (a, tz) => { const t = String(a.due_time || "").slice(0, 5); if (!a.due_date) return null; if (!/^\d{2}:\d{2}$/.test(t)) return { day: a.due_date, time: "" }; const l = fromUtc(a.due_date, t, tz); return { day: l.date, time: l.time }; };
const LATE_DAYS = 4;
// Cuándo fue una actividad hecha, en la zona de quien mira (tz). Como en Pipedrive, va en su vencimiento (con hora, si
// tiene) si se marcó hecha ese mismo día. Si se marcó antes, fue ese día (early: para cuándo estaba). Si se marcó en los 4
// días siguientes (la vencida de ayer que se llamó hoy), va cuando se marcó (late: para cuándo estaba). Si se marcó mucho
// después (una limpieza), queda en su vencimiento y se dice cuándo se marcó (marked). Siempre coherente: `at` cae en `day`.
// day: fecha sin hora (no se pasa a otra zona). Sin day, la fecha es la de `at` en la zona de quien mira.
export function actWhen(a, tz) {
  const due = dueOf(a, tz), done = iso(a.marked_as_done_time);
  if (!due) return { at: done || iso(a.add_time), day: "", timed: false };
  const timedAt = due.time ? `${a.due_date}T${String(a.due_time).slice(0, 5)}:00.000Z` : null;
  const was = { day: due.day, time: due.time };
  const onDue = () => timedAt ? { at: timedAt, day: "", timed: true } : { at: `${due.day}T12:00:00.000Z`, day: due.day, timed: false };
  if (!done) return onDue();
  const dd = todayIn(tz, ms(done));
  if (dd < due.day) return { at: done, day: "", timed: false, early: was };
  if (dd === due.day) return timedAt ? { at: timedAt, day: "", timed: true } : { at: done, day: due.day, timed: false };
  if (ms(`${dd}T12:00:00Z`) - ms(`${due.day}T12:00:00Z`) <= LATE_DAYS * 864e5) return { at: done, day: "", timed: false, late: was };
  return { ...onDue(), marked: dd };
}

// ---------- íconos y nombres por tipo
export const iconOf = type => /^(call|aircall)/.test(type) ? "phone" : /^(meeting|lunch)$/.test(type) ? "video" : type === "deadline" ? "whatsapp"
  : /^(task|email)$/.test(type) ? "mail" : type === "contacto_decisor" ? "user" : type === "note" ? "note" : type === "lead" ? "lead" : type === "deal" ? "deal" : "check";
const CH_LABEL = { call: "Llamada", whatsapp: "WhatsApp", mail: "Mail", visit: "Visita" };
const ORIGIN = { Import: "importado", ManuallyCreated: "cargado a mano", API: "por la API (la app u otra integración)", WebForms: "formulario web", Prospector: "Prospector", LeadBooster: "LeadBooster", Chatbot: "chatbot", LiveChat: "chat en vivo" };
// la actividad que deja Registrar: «Llamada: Atendió recepción · Colegio X»
const APP_ACT = /^(Llamada|WhatsApp|Mail|Visita): (.+?) · /;
// la firma que deja la app al final de sus notas («Cargado por Ana desde OrderBrain SDR»): no es parte de lo que pasó
const SIG = /\n*\s*\(?(?:Cargado|Enviado|Agendad[oa]|Registrado) por [^\n]{1,80}? desde OrderBrain SDR[^\n]*\)?\s*$/i;
export const noSig = t => String(t || "").replace(SIG, "").trim();
const isMailNote = (n, subject) => { const t = plain(n.content); return /^Mail enviado\b/.test(t) && /desde OrderBrain SDR/.test(t) && (!subject || t.includes(subject)); };
const uniq = (list, key) => { const seen = new Set(); return list.filter(x => { const k = key(x); if (k == null || seen.has(String(k))) return k == null; seen.add(String(k)); return true; }); };
const closest = (list, at, when) => list.length ? list.slice().sort((x, y) => Math.abs(ms(when(x)) - ms(at)) - Math.abs(ms(when(y)) - ms(at)))[0] : null;
const fold = s => String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
// El asunto sin lo que ya se dice: «Llamada · Centro Educativo X» → ""; «Llamada – visita Joaco» → «visita Joaco»
export function cleanSubject(subject, label = "", school = "") {
  let t = String(subject || "").trim();
  if (label && fold(t.slice(0, label.length)) === fold(label) && !/^[\p{L}]/u.test(t.slice(label.length))) t = t.slice(label.length).replace(/^\s*[:·–—-]\s*/, "").trim();
  if (school) { const i = fold(t).indexOf(fold(school)); if (i >= 0 && fold(school)) t = t.replace(new RegExp(`\\s*[·–—-]?\\s*${school.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i"), "").trim(); }
  return t;
}

// ---------- la línea de tiempo
// acts: actividades crudas de v2 (solo las hechas cuentan); notes: notas crudas de v1; leads: { id, title, addTime, creatorId, origin };
// deals: tratos crudos (v2); touches y mails: lo registrado en la app; users: [{ id, name }] (también los inactivos);
// types: { clave: nombre } de los tipos de actividad de la cuenta; persons: [{ id, name }]; orgs: [{ id, name, main, sure }]
// (sure: la vinculada o una duplicada de la misma ciudad; las duplicadas sin ciudad van a la lista con `aside` y no entran en
// el resumen); mainLeadId: el prospecto de la ficha (no se aclara «en el prospecto»); tz: la zona de quien mira.
// Devuelve las entradas de la más nueva a la más vieja.
export function buildTimeline(src = {}) {
  const { acts = [], notes = [], leads = [], deals = [], touches = [], mails = [], users = [], types = {}, persons = [], orgs = [], pipes = {}, stages = {}, web = "", mainLeadId = null, tz } = src;
  const uname = id => (id == null ? "" : users.find(u => Number(u.id) === Number(id))?.name || "");
  const A = uniq(acts.filter(a => a && a.done && !a.is_deleted), a => a.id), N = uniq(notes.filter(n => n && n.active_flag !== false), n => n.id);
  const dealT = new Map(deals.map(d => [Number(d.id), d.title || ""])), leadT = new Map(leads.map(l => [String(l.id), l.title || ""]));
  const personN = new Map(persons.map(p => [Number(p.id), p.name || ""])), orgOf = new Map(orgs.map(o => [Number(o.id), o]));
  // lo de una organización duplicada (mismo nombre) dice de cuál es; si no se sabe su ciudad, queda aparte (aside)
  const dupWhere = id => { const o = id && orgOf.get(Number(id)); return o && !o.main ? `en «${o.name}» (${o.sure === false ? "otra organización con este nombre, sin ciudad" : "otra organización de este colegio"})` : ""; };
  const asideOf = id => { const o = id && orgOf.get(Number(id)); return !!o && !o.main && o.sure === false; };
  const whereAct = a => [a.deal_id && `en el trato «${dealT.get(Number(a.deal_id)) || a.deal_id}»`, a.lead_id && String(a.lead_id) !== String(mainLeadId) && `en el prospecto «${leadT.get(String(a.lead_id)) || "otro"}»`,
    a.person_id && personN.get(Number(a.person_id)) && `con ${personN.get(Number(a.person_id))}`, dupWhere(a.org_id)].filter(Boolean).join(" · ");
  const whereNote = n => [n.deal_id && `en el trato «${n.deal?.title || dealT.get(Number(n.deal_id)) || n.deal_id}»`, n.lead_id && String(n.lead_id) !== String(mainLeadId) && `en el prospecto «${n.lead?.title || leadT.get(String(n.lead_id)) || "otro"}»`,
    n.person_id && (n.person?.name || personN.get(Number(n.person_id))) && `sobre ${n.person?.name || personN.get(Number(n.person_id))}`, dupWhere(n.org_id)].filter(Boolean).join(" · ");
  const typeName = t => types[t] || TYPE_LABEL[t] || t || "Actividad";
  const usedA = new Set(), usedN = new Set(), usedT = new Set(), out = [];
  const markMailNotes = (subject, at) => { for (const n of N) if (!usedN.has(n.id) && isMailNote(n, subject) && near(iso(n.add_time), at, 60)) usedN.add(n.id); };
  // la nota ordenada que dejó un contacto: mismo título, a 15 min o menos y, si hay texto, la que lo tiene (dos contactos
  // seguidos con el mismo resultado no se cruzan)
  const appNote = (head, at, text = "") => {
    const l = N.filter(n => !usedN.has(n.id) && splitHead(n.content).head === head && /OrderBrain SDR/.test(n.content) && near(iso(n.add_time), at, 15));
    const t = String(text || "").replace(/\s+/g, " ").trim().slice(0, 60), has = t ? l.filter(n => plain(n.content).replace(/\s+/g, " ").includes(t)) : [];
    return closest(has.length ? has : l, at, n => iso(n.add_time));
  };
  // La pendiente que se cerró con un contacto, un mail o un comentario de la app (la de la agenda desde la que se abrió la
  // ficha): es el mismo contacto, va en esa entrada («cerró la llamada que estaba para ayer 14:15»). Con su id (lo guarda la
  // app); si falta, la del mismo tipo sin nota propia (o con la que deja la app al agendar) marcada hecha a 15 min o menos.
  const closedBy = (id, at, type) => {
    let a = id ? A.find(x => !usedA.has(x.id) && Number(x.id) === Number(id)) : null;
    if (!a && at) a = closest(A.filter(x => !usedA.has(x.id) && (!type || x.type === type) && !APP_ACT.test(x.subject || "") && !/^Mail: /.test(x.subject || "")
      && (!noSig(plain(x.note)) || /OrderBrain SDR/.test(x.note || "")) && near(iso(x.marked_as_done_time), at, 15) && !(ms(iso(x.add_time)) > ms(at) - 5 * 60e3)), at, x => iso(x.marked_as_done_time));
    if (!a) return null;
    usedA.add(a.id);
    const d = dueOf(a, tz);
    return { label: typeName(a.type), subject: cleanSubject(a.subject, typeName(a.type)), day: d?.day || "", time: d?.time || "" };
  };

  // mails enviados desde la ficha: una entrada (la actividad «Mail», la nota y el contacto son el mismo mail)
  const mailList = [...mails, ...touches.filter(t => t.mailId && !mails.some(m => m.id === t.mailId)).map(t => ({ id: t.mailId, at: t.at, byName: t.byName, to: t.to || "", subject: t.text || "", body: "", doneActId: t.doneActId || null }))];
  // primero las que se cerraron con su id guardado (así la búsqueda por hora no se queda con la de otro contacto)
  const claimed = new Map();
  for (const x of [...mailList.map(m => [m, m.doneActId || touches.find(t => t.mailId && t.mailId === m.id && t.doneActId)?.doneActId]), ...touches.filter(t => !t.mailId).map(t => [t, t.doneActId])])
    if (x[1]) { const c = closedBy(x[1], null); if (c) claimed.set(x[0], c); }
  for (const m of mailList) {
    const at = iso(m.at);
    const act = A.find(a => !usedA.has(a.id) && m.activityId && Number(a.id) === Number(m.activityId))
      || closest(A.filter(a => !usedA.has(a.id) && a.type === CHANNEL_TYPE.mail && m.subject && String(a.subject || "").startsWith(`Mail: ${m.subject}`) && near(iso(a.add_time), at, 30)), at, a => iso(a.add_time));
    if (act) usedA.add(act.id);
    markMailNotes(m.subject, at);
    const tch = touches.filter(t => t.mailId && t.mailId === m.id); for (const t of tch) usedT.add(t);
    const closed = claimed.get(m) || null;
    out.push({ id: `m:${m.id}`, kind: "mail", type: CHANNEL_TYPE.mail, icon: "mail", label: "Mail enviado", title: m.subject || "", who: m.byName || m.by || "", at, timed: true, text: "", src: act ? "both" : "app",
      mail: { to: m.to || "", subject: m.subject || "", body: m.body || "", next: m.next || null }, ...(closed ? { closed } : {}) });
  }
  // contactos registrados en la app: con su actividad hecha y la nota ordenada que dejó en Pipedrive (si están)
  for (const t of touches) {
    if (t.mailId || usedT.has(t)) continue;
    const o = outcomeById(t.outcome), ch = CH_LABEL[t.channel] || "Contacto", type = CHANNEL_TYPE[t.channel] || "call", at = iso(t.at), label = o?.label || t.outcome || "";
    const acts0 = A.filter(a => !usedA.has(a.id) && a.type === type && String(a.subject || "").startsWith(`${ch}: ${label} · `)
      && (a.add_time ? near(iso(a.add_time), at, 15) : Math.abs(ms(`${a.due_date}T12:00:00Z`) - ms(at)) <= 36 * 3600e3));
    const tt = String(t.text || "").replace(/\s+/g, " ").trim().slice(0, 60), withText = tt ? acts0.filter(a => plain(a.note).replace(/\s+/g, " ").includes(tt)) : [];
    const act = closest(withText.length ? withText : acts0, at, a => iso(a.add_time) || `${a.due_date}T12:00:00Z`);
    if (act) usedA.add(act.id);
    const note = appNote(`${ch} · ${label}`, at, t.text); if (note) usedN.add(note.id);
    const closed = claimed.get(t) || (t.doneActId ? null : closedBy(null, at, type));
    out.push({ id: `c:${at}`, kind: "contact", type, channel: t.channel || "call", icon: iconOf(type), label: ch, title: label, who: t.byName || "", at, timed: true,
      text: (act && noSig(plain(act.note))) || t.text || "", rows: note ? rowsOf(note.content) : [], where: act ? whereAct(act) : "", src: act || note ? "both" : "app", outcome: t.outcome || "", ...(closed ? { closed } : {}) });
  }
  // comentarios de la app que cerraron una pendiente (Registrar sin contacto): la pendiente va en el comentario
  const closedByNote = new Map();
  for (const n of N) if (!usedN.has(n.id) && /OrderBrain SDR/.test(n.content || "") && /^Comentario\b/.test(splitHead(n.content).head)) { const c = closedBy(null, iso(n.add_time), null); if (c) closedByNote.set(n.id, c); }
  // actividades hechas en Pipedrive (las que cargó la app sin contacto guardado acá también juntan su nota)
  for (const a of A) {
    if (usedA.has(a.id)) continue;
    const w = actWhen(a, tz), m = APP_ACT.exec(a.subject || ""), added = iso(a.add_time);
    let rows = [];
    if (m && m[1] !== "Mail") { const note = appNote(`${m[1]} · ${m[2]}`, added); if (note) { usedN.add(note.id); rows = rowsOf(note.content); } }
    if (/^Mail: /.test(a.subject || "") && a.type === CHANNEL_TYPE.mail) markMailNotes(String(a.subject).slice(6).split(" · ")[0], added);
    out.push({ id: `a:${a.id}`, kind: "act", type: a.type || "", icon: iconOf(a.type || ""), label: typeName(a.type), title: String(a.subject || "").trim(),
      who: uname(a.owner_id ?? a.user_id), ...w, text: noSig(plain(a.note)), rows, where: whereAct(a), src: "pd", ...(asideOf(a.org_id) ? { aside: true } : {}) });
  }
  // notas
  for (const n of N) {
    if (usedN.has(n.id)) continue;
    const { head, rest } = splitHead(n.content), closed = closedByNote.get(n.id);
    out.push({ id: `n:${n.id}`, kind: "note", type: "note", icon: "note", label: "Nota", title: head, who: n.user?.name || uname(n.user_id), at: iso(n.add_time), timed: true,
      text: noSig(plain(head ? rest : n.content)), where: whereNote(n), src: "pd", app: /OrderBrain SDR/.test(n.content || ""), ...(closed ? { closed } : {}), ...(asideOf(n.org_id) ? { aside: true } : {}) });
  }
  // prospectos creados
  for (const l of leads) if (l?.addTime) out.push({ id: `l:${l.id}`, kind: "created", type: "lead", icon: "lead", label: "Prospecto creado", title: l.title || "", who: uname(l.creatorId),
    at: iso(l.addTime), timed: true, text: l.origin ? `Origen: ${ORIGIN[l.origin] || l.origin}` : "", where: String(l.id) !== String(mainLeadId) && mainLeadId ? "otro prospecto" : "", src: "pd" });
  // tratos: creado, ganado, perdido (con el motivo)
  for (const d of deals) {
    if (!d || d.is_deleted || d.status === "deleted") continue;
    const pipe = pipes[d.pipeline_id] || "", stage = stages[d.stage_id] || "", url = web && d.id ? `${web}/deal/${d.id}` : "",
      base = { kind: "deal", type: "deal", icon: "deal", title: d.title || "", timed: true, src: "pd", url, where: dupWhere(d.org_id), ...(asideOf(d.org_id) ? { aside: true } : {}) };
    if (d.add_time) out.push({ ...base, id: `d:${d.id}:add`, label: "Trato creado", who: uname(d.creator_user_id), at: iso(d.add_time), text: pipe ? `Embudo ${pipe}` : "" });
    if (d.status === "won" && d.won_time) out.push({ ...base, id: `d:${d.id}:won`, label: "Trato ganado", who: uname(d.owner_id ?? d.user_id), at: iso(d.won_time), text: [pipe, stage].filter(Boolean).join(" · ") });
    if (d.status === "lost" && d.lost_time) out.push({ ...base, id: `d:${d.id}:lost`, label: "Trato perdido", who: uname(d.owner_id ?? d.user_id), at: iso(d.lost_time),
      text: [d.lost_reason && `Motivo: ${String(d.lost_reason).replace(/\s+/g, " ").trim()}`, stage && `Etapa: ${stage}`].filter(Boolean).join("\n") });
  }
  return out.filter(x => x.at).sort((x, y) => ms(y.at) - ms(x.at) || String(y.id).localeCompare(String(x.id)));
}
export const page = (items, offset = 0, limit = 50) => { const o = Math.max(0, Number(offset) || 0), l = Math.min(200, Math.max(1, Number(limit) || 50)); return { items: items.slice(o, o + l), total: items.length, offset: o, more: o + l < items.length }; };

// ---------- resumen para la próxima llamada (por reglas)
const CONTACT = new Set(["act", "contact", "mail"]);
export const dayOf = (it, tz) => it.day || todayIn(tz, ms(it.at));
const ddmmyyyy = d => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
export function relDay(day, today) {
  const diff = Math.round((ms(`${today}T12:00:00Z`) - ms(`${day}T12:00:00Z`)) / 864e5);
  if (diff === 0) return "hoy"; if (diff === 1) return "ayer"; if (diff === -1) return "mañana";
  if (diff > 1 && diff < 7) return `el ${weekday(day)}`;
  if (diff < -1 && diff > -7) return `el ${weekday(day).slice(0, 3)} ${day.slice(8, 10)}/${day.slice(5, 7)}`;
  return `el ${ddmmyyyy(day)}`;
}
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const sentences = t => String(t || "").replace(/\s+/g, " ").split(/(?<=[.!?])\s+(?=\S)/).map(x => x.trim()).filter(Boolean);
// palabras que no son nombres de persona (empiezan oraciones o van con mayúscula por costumbre)
const FUNC = new Set(("hola ayer hoy mañana anoche anteayer te me le les lo la las el los un una unos unas no si sí se nos ya aún todavía hay es son fue era " +
  "está están estaba estaban tiene tienen tenía quiere quieren quería querían pidió pidieron dijo dijeron hizo quedó quedaron habló hablé hablamos " +
  "llamé llamamos llamó llamaron atendió atendieron contestó contestaron comentó comentaron mandé mandamos envié enviamos escribí escribimos " +
  "pregunté preguntamos marqué volví recepción recepcionista secretaria secretaría directora director subdirectora subdirector administradora administrador " +
  "rectora rector dueño dueña encargada encargado coordinadora coordinador concesionario concesionaria contadora contador gerente cafetería cantina casino comedor " +
  "kiosco soda colegio escuela instituto centro liceo prepa preparatoria nadie nada alguien todo todos toda todas sin con por para en de del al y o pero que qué " +
  "cómo cuándo dónde quién quiénes cuál según sobre entre desde hasta como cuando donde también tampoco entonces luego después antes primero primera primer " +
  "último última próximo próxima otro otra otros otras este esta estos estas ese esa eso esto usted ustedes vos tú él ella ellos ellas yo nosotros buen bueno " +
  "buena buenos buenas gracias perfecto claro dale llamar volver pedir preguntar ofrecer mandar enviar insistir agendar coordinar proponer intentar seguir " +
  "buscar escribir visitar hablar retomar recordar confirmar lunes martes miércoles jueves viernes sábado domingo enero febrero marzo abril mayo junio julio " +
  "agosto septiembre setiembre octubre noviembre diciembre orderEAT ordereat whatsapp google mail correo llamada nota comentario").split(" "));
const NAME = "[A-ZÁÉÍÓÚÑ][a-záéíóúñü]+", NAMES = `${NAME}(?:\\s+(?:de\\s+)?${NAME}){0,2}`;
const okName = n => !!n && !FUNC.has(n.split(/\s+/)[0].toLowerCase());
// lo que el SDR se anotó para hacer («Llamar al…», «Pedir quien ve…»): es plan, no lo que pasó
const PLAN = /^(llamar|volver a llamar|pedir|ofrecer|mandar|enviar|preguntar|confirmar|agendar|insistir|buscar|hablar con|escribir|intentar|seguir|proponer|coordinar|visitar|ir)\b/i;
const FACT_ONLY = /^\d[\d.,]*\s*(alumnos|estudiantes|ni[ñn]os|chicos)\.?$/i;
const ESPACIO = "cafeter[ií]a|cantina|casino|soda|bar escolar|comedor|kiosco|tienda escolar";
const ROLE_WORDS = `(?:sub)?director(?:a)?|rector(?:a)?|administrador(?:a)?|due[ñn][oa]|concesionari[oa]|coordinador(?:a)?|secretari[oa]|contador(?:a)?|gerente|ec[oó]nom[oa]|encargad[oa]\\s+de\\s+(?:la\\s+|el\\s+)?(?:${ESPACIO}|cocina|compras|administraci[oó]n)`;
const ROLE = new RegExp(`\\b(?:la|el)\\s+(?:${ROLE_WORDS})\\b`, "gi");
const NAME_AFTER = new RegExp(`^,?\\s+(${NAMES})`);
// los cargos que nombra un texto, con el nombre si va pegado («la directora Laura Gómez» → { role: "directora", name: "Laura Gómez" })
function rolePeople(t) {
  const out = [], seen = new Set();
  for (const m of String(t || "").matchAll(new RegExp(ROLE.source, "gi"))) {
    const phrase = m[0].toLowerCase(), role = phrase.replace(/^(la|el)\s+/, ""), nm = NAME_AFTER.exec(t.slice(m.index + m[0].length));
    if (seen.has(phrase)) continue; seen.add(phrase);
    out.push(nm && okName(nm[1]) ? { phrase, role, name: nm[1] } : { phrase, role });
  }
  return out;
}
const askText = p => p.name ? `${p.name} (${p.role})` : p.phrase;
// quién atendió en recepción («Rosa de recepción», «me atendió Rosa en recepción», «la recepcionista Rosa»)
const RECEP_NAME = [new RegExp(`(${NAME}),?\\s+(?:de|en)\\s+(?:la\\s+)?recepci[oó]n\\b`), new RegExp(`\\b(?:[Ll]a|[Ee]l)\\s+recepcionista,?\\s+(${NAME})`)];
const recepName = t => { for (const r of RECEP_NAME) { const m = r.exec(String(t || "")); if (m && okName(m[1])) return m[1]; } return ""; };
const OBJECTION = new RegExp(`\\b(?:no\\s+(?:tiene[n]?|hay)\\s+(?:${ESPACIO})|ya\\s+(?:tiene[n]?|usa[n]?|cuenta[n]?\\s+con|trabaja[n]?\\s+con)\\s+(?:un[ao]?\\s+|otr[oa]\\s+)?(?:sistema|software|app|aplicaci[oó]n|plataforma|proveedor)|(?:es|muy|demasiado)\\s+caro|no\\s+(?:les?\\s+)?interesa|no\\s+es\\s+(?:prioridad|el\\s+momento)|(?:${ESPACIO})\\s+(?:es\\s+|est[aá]\\s+)?concesionad[ao]|no\\s+quiere[n]?\\s+(?:una\\s+)?app|no\\s+hay\\s+presupuesto)`, "i");
const PHONE = /\(?\+?\d[\d\s().-]{6,}\d(?:\s*\((?:sin|con|solo|tiene)[^)]{0,30}\))?/g;
const MAIL_RE = /[^\s@<>()[\]"',;]+@[^\s@<>()[\]"',;]+\.[a-z]{2,}/gi;
const STUDENTS = /(\d{2,5}(?:[.,]\d{3})?)\s*(alumnos|estudiantes)/i;
const NOANSWER = /\b(ocupad[ao]|no\s+contest|no\s+atend|nadie\s+atend|buz[oó]n|no\s+responde|sin\s+respuesta|no\s+son[oó]|fuera\s+de\s+servicio|no\s+(?:da|daba)\s+tono)/i;
const GATE = /\b(recepci[oó]n|recepcionista|secretar[ií]a|conmutador|porter[ií]a)\b/i;
const ABSENT = /\bno\s+(?:se\s+)?(?:encontraba[n]?|estaba[n]?|est[aá][n]?|hab[ií]a\s+nadie)\b/i;
// horarios: «los martes de 9 a 11», «de 9 a 11 hs», «el jueves por la tarde»
const DIAS = "lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bados?";
const HORA = "(?:las\\s+)?\\d{1,2}(?::\\d{2})?(?:\\s*(?:hs|h|am|pm))?";
const RANGO = `(?:de|entre)\\s+${HORA}\\s*(?:a|y|-)\\s*${HORA}`;
const WHEN = `(?:(?:los|el)\\s+(?:${DIAS})(?:\\s*(?:,|y|o|a)\\s*(?:${DIAS}))*(?:\\s+${RANGO}|\\s+(?:por|en)\\s+la\\s+(?:mañana|tarde))?|${RANGO})`;
// quién está cuándo: «la directora Laura Gómez está los martes de 9 a 11»
const SCHED = new RegExp(`\\b(est[aá]n?|atiende[n]?|llega[n]?|viene[n]?|se\\s+encuentra[n]?|trabaja[n]?)\\s+(${WHEN})`, "i");
const TIMECUE = new RegExp(`\\b(?:llam(?:e|ara|ase|ar|en|aran|emos)|volver\\s+a\\s+llamar|marcar|comunicar(?:se|me)?)\\b[^.;\\n]{0,60}?\\b((?:el|la)\\s+pr[oó]xim[oa]\\s+(?:semana|ciclo(?:\\s+escolar)?|año|mes|semestre)|en\\s+(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)|m[aá]s\\s+tarde|despu[eé]s\\s+de\\s+las?\\s+\\d{1,2}(?::\\d{2})?(?:\\s*(?:hs|h|am|pm))?|antes\\s+de\\s+las?\\s+\\d{1,2}(?::\\d{2})?|a\\s+las?\\s+\\d{1,2}(?::\\d{2})?(?:\\s*(?:hs|h|am|pm))?|${WHEN}|por\\s+la\\s+(?:mañana|tarde)|en\\s+la\\s+(?:mañana|tarde)|mañana|otro\\s+d[ií]a|la\\s+semana\\s+que\\s+viene)(?![\\p{L}\\d])`, "iu");
const INFO = /\b(?:mand[eé]|envi[eé]|mandamos|enviamos)\s+(?:la\s+|el\s+|un\s+)?(?:info|informaci[oó]n|mail|correo|propuesta|presentaci[oó]n)|pidi[oó]\s+(?:info|informaci[oó]n|que\s+(?:le\s+)?(?:mande|env[ií]e))/i;
const NAMECUE = new RegExp(`\\b(?:habl[eé]\\s+con|me\\s+atendi[oó]|atendi[oó]|se\\s+llama|preguntar\\s+por|pregunt[aá]\\s+por)\\s+(${NAMES})`);
const SPOKE = new RegExp(`\\bhabl(?:[oó]|[eé]|amos|aron)\\s+con\\s+((?:la|el)\\s+(?:${ROLE_WORDS}))`, "i");
const fixAccent = s => s.replace(/\bmas tarde\b/gi, "más tarde").replace(/\bdespues\b/gi, "después");
const digitsOf = s => String(s).replace(/\D/g, "");
const DATE_LIKE = /^(\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4})$/;
const LABEL_N = { Llamada: ["llamada", "llamadas"], Mail: ["mail", "mails"], "Mail enviado": ["mail", "mails"], WhatsApp: ["WhatsApp", "WhatsApp"], Demo: ["demo", "demos"], Visita: ["visita", "visitas"], "Contacto decisor": ["contacto con decisor", "contactos con decisor"] };
const countText = (label, n) => LABEL_N[label] ? `${n} ${LABEL_N[label][n === 1 ? 0 : 1]}` : `${n} ${label}`;
// por dónde fue un contacto (para no decir «llamé» de una nota o un WhatsApp)
const channelOf = it => it.kind === "contact" ? it.channel || "call" : it.kind === "mail" ? "mail"
  : it.kind === "act" ? (/^(call|aircall)/.test(it.type) ? "call" : it.type === "deadline" ? "whatsapp" : /^(task|email)$/.test(it.type) ? "mail" : "") : "";
const verbOf = (it, yo) => ({ call: yo ? "llamé" : "llamamos", whatsapp: yo ? "escribí por WhatsApp" : "escribimos por WhatsApp", mail: yo ? "mandé un mail" : "mandamos un mail",
  visit: yo ? "fui al colegio" : "fuimos al colegio" })[channelOf(it)] || "";
// nombre y fuente de una entrada, como se muestran en el resumen («Llamada – visita Joaco · ayer · Ana Ruiz»)
const nameOf = it => (it.title && it.title !== it.label ? (it.kind === "contact" ? `${it.label} · ${it.title}` : it.title) : it.label);
export const srcOf = (it, tz, today) => [nameOf(it), relDay(dayOf(it, tz), today), it.who].filter(Boolean).join(" · ");

// ctx: { school, status, today, tz, me (nombre de pila de quien llama), meNames (cómo figura en Pipedrive y en la app),
// pending: [{ label, subject, date, time, who, late }] (sus actividades sin hacer, en hora local), askFor (de Registrar),
// unlinked (sin organización vinculada y con candidatas: no se sabe su historia), unconfirmed (nombre de la organización
// elegida sola, sin confirmar) }. Lo de una organización duplicada sin ciudad (aside) no entra: está en la lista, nada más.
export function callSummary(all, ctx = {}) {
  const { school = {}, status = "", today = todayIn(ctx.tz), tz, me = "", meNames = [], pending = [] } = ctx;
  const items = all.filter(x => !x.aside), asideN = all.length - items.length;
  const mk = market(school.country), vos = mk.trato === "vos";
  const masc = /^(casino|bar)\b/.test(mk.espacio), la = `${masc ? "el" : "la"} ${mk.espacio}`;
  const meName = me || "[tu nombre]", intro = `Hola, ¿qué tal? Te habla ${meName} de OrderEAT.`;
  const mine = who => !!who && meNames.some(n => n && who.toLowerCase().trim() === String(n).toLowerCase().trim());
  const when = it => relDay(dayOf(it, tz), today);
  const src = it => srcOf(it, tz, today);
  const byNew = (x, y) => dayOf(y, tz).localeCompare(dayOf(x, tz)) || ms(y.at) - ms(x.at);
  const contacts = items.filter(x => CONTACT.has(x.kind)).sort(byNew);
  // notas escritas por alguien (no las que arma la app: datos del colegio, estudio, contactos); los comentarios sí cuentan
  const human = x => !x.app || /^(Comentario|Nota desde el asistente)\b/.test(x.title);
  const humanNotes = items.filter(x => x.kind === "note" && human(x)).sort(byNew), dataNotes = items.filter(x => x.kind === "note" && !human(x)).sort(byNew);
  const pend = pending.map(p => { const sub = cleanSubject(p.subject, p.label, school.name);
    return { text: [p.label + (sub ? ` «${sub}»` : ""), p.late ? "vencida" : "", relDay(p.date, today) + (p.time ? ` ${p.time}` : ""), p.who && !mine(p.who) ? `de ${p.who}` : ""].filter(Boolean).join(" "), late: !!p.late }; });
  const base = { mode: "reglas", count: contacts.length, pending: pend };
  const lost = items.find(x => x.kind === "deal" && x.label === "Trato perdido");
  const extraWarn = [
    ctx.unconfirmed ? { text: `La historia es de «${ctx.unconfirmed}», que se eligió sola y todavía no confirmaste: revisá que sea este colegio.`, src: "" } : null,
    asideN ? { text: `${asideN === 1 ? "Hay 1 entrada" : `Hay ${asideN} entradas`} de otra organización con este nombre y sin ciudad: ${asideN === 1 ? "está" : "están"} en el Historial pero no en este resumen.`, src: "" } : null,
  ].filter(Boolean);
  const cold = playbookFor(school, { status: status === "lost" || status === "stalled" ? status : "new" }).apertura.replace(/\[tu nombre\]/g, meName);
  if (!contacts.length && !humanNotes.length) {
    if (ctx.unlinked) return { ...base, cold: true, unlinked: true, headline: "Todavía no está vinculado a Pipedrive: elegí la organización para ver su historia.", counts: "", happened: [], facts: [], askFor: [], plan: [],
      warnings: extraWarn, opening: cold, openingSrc: "Plantilla de primer contacto: sin vincular no se ve lo que pasó en Pipedrive" };
    return { ...base, cold: true, headline: "Todavía no hay contactos: es primer contacto en frío.", counts: "", happened: [], facts: [], askFor: [], plan: [],
      warnings: [...(lost ? [{ text: `Trato perdido ${when(lost)}${lost.text ? `: ${lost.text.split("\n")[0]}` : ""}.`, src: src(lost) }] : []), ...extraWarn],
      opening: cold, openingSrc: "Plantilla de primer contacto (no hay contactos anteriores)" };
  }
  // conteo por tipo y último contacto
  const byLabel = new Map(); for (const c of contacts) { const l = c.kind === "mail" ? "Mail" : c.label; byLabel.set(l, (byLabel.get(l) || 0) + 1); }
  const counts = [...byLabel].map(([l, n]) => countText(l, n)).join(" · ");
  const last = contacts[0], first = contacts.at(-1);
  const headline = last ? `${counts}. Último contacto: ${when(last)}${last.who ? ` (${last.who})` : ""}${first && first !== last && dayOf(first, tz) !== dayOf(last, tz) ? `; primero: ${when(first)}${first.who ? ` (${first.who})` : ""}` : ""}.`
    : `Todavía no hay contactos registrados: ${humanNotes.length === 1 ? "hay 1 nota" : `hay ${humanNotes.length} notas`}.`;
  // qué pasó, datos, plan y objeciones, de la entrada más nueva a la más vieja
  const happened = [], facts = [], plan = [], warnings = [], askFor = [], seenFact = new Set(), seenAsk = new Set();
  // de «Cuándo llamar» vale solo lo más nuevo; de lo demás, cada valor una vez
  const addFact = (k, v, it) => { const key = k === "Cuándo llamar" ? k : k + ":" + (k === "Teléfono" ? digitsOf(v) : v.toLowerCase()); if (seenFact.has(key)) return; seenFact.add(key); facts.push({ k, v, src: src(it) }); };
  // por quién preguntar: lo de la entrada más nueva que lo dice (lo más nuevo manda); «Marta (Directora)» y «Marta · Directora» son una
  let askFrom = null;
  const addAsk = (text, it) => { const key = text.toLowerCase().split(/\s*[(·]/)[0].trim(); if (seenAsk.has(key) || (askFrom && askFrom !== it.id)) return; askFrom = it.id; seenAsk.add(key); askFor.push({ text, src: it.src === "registrar" ? "Registrar" : src(it) }); };
  const result = new Map(); // id → sentencias de lo que pasó (sin plan ni datos sueltos)
  // primero lo que anotó la gente (de lo más nuevo a lo más viejo); las notas de datos de la app solo suman datos
  for (const it of [...[...contacts, ...humanNotes].sort(byNew), ...dataNotes]) {
    const text = [it.text, it.mail?.subject ? `Asunto: ${it.mail.subject}` : ""].filter(Boolean).join("\n"), ss = sentences(it.text), dataOnly = it.kind === "note" && !human(it);
    const res = dataOnly ? [] : ss.filter(x => !PLAN.test(x) && !FACT_ONLY.test(x)), pl = dataOnly ? [] : ss.filter(x => PLAN.test(x));
    result.set(it.id, res.join(" "));
    if (res.length || it.kind === "contact" || it.kind === "mail") happened.push({ lead: `${cap(when(it))} · ${nameOf(it)}${it.who ? ` · ${it.who}` : ""}`, text: res.join(" ") || (it.kind === "mail" ? `Mail a ${it.mail?.to || "?"}: «${it.mail?.subject || ""}»` : ""), quote: !!res.length, id: it.id });
    for (const p of pl) plan.push({ text: p.replace(/[.]$/, ""), src: src(it) });
    const st = STUDENTS.exec(text); if (st) addFact("Alumnos", st[1], it);
    for (const p of (text.match(PHONE) || []).filter(p => digitsOf(p).length >= 8 && digitsOf(p).length <= 15 && !DATE_LIKE.test(p.trim()))) addFact("Teléfono", p.trim(), it);
    for (const m of text.match(MAIL_RE) || []) addFact("Mail", m.toLowerCase(), it);
    if (!dataOnly) {
      const rc = recepName(text); if (rc) addFact("En recepción", rc, it);
      const sc = SCHED.exec(text), tc = TIMECUE.exec(text);
      if (sc) { const who = rolePeople(text.slice(Math.max(0, sc.index - 60), sc.index))[0]; addFact("Cuándo llamar", `${sc[2]}${who ? ` (${who.name || who.phrase})` : ""}`, it); }
      else if (tc) addFact("Cuándo llamar", fixAccent(tc[1].trim()), it);
    }
    const rowAsk = (it.rows || []).find(([k]) => /^preguntar por$/i.test(k)) || (it.rows || []).find(([k]) => /^(decisor|contacto)$/i.test(k));
    if (rowAsk) addAsk(rowAsk[1], it);
    for (const [k, v] of it.rows || []) if (/^(preguntar por|decisor|contacto)$/i.test(k)) continue; else if (/^(cafeter[ií]a|alumnos|niveles|sistema actual|objeci[oó]n|inter[eé]s)$/i.test(k)) addFact(k, v, it);
    if (!dataOnly) {
      const rc = recepName(text), nm = NAMECUE.exec(text);
      if (nm && okName(nm[1]) && nm[1] !== rc) addAsk(nm[1], it);
      const people = rolePeople(text);
      for (const p of people.filter(p => p.name)) addAsk(askText(p), it);
      for (const p of people.filter(p => !p.name && !people.some(q => q.name && q.role === p.role))) addAsk(p.phrase, it);
    }
    const ob = !dataOnly && OBJECTION.exec(text); if (ob) { const s = ss.find(x => OBJECTION.test(x)) || ob[0]; if (!warnings.some(w => w.quote === s)) warnings.push({ text: `${cap(when(it))} ${it.who ? `${it.who} anotó` : "anotaron"} «${s.replace(/[.]$/, "")}». Confirmalo al principio de la llamada.`, quote: s, src: src(it) }); }
  }
  if (lost) warnings.push({ text: `Trato perdido ${when(lost)}${lost.text ? ` (${lost.text.split("\n")[0]})` : ""}.`, src: src(lost) });
  if (ctx.askFor?.name && !askFor.length) addAsk([ctx.askFor.name, ctx.askFor.role && `(${ctx.askFor.role})`].filter(Boolean).join(" "), { id: "registrar", src: "registrar" });

  // apertura: del último día con algo dicho, lo más útil (recepción con horario o con quién hablar > nombre > mail o info > no atendió).
  // Solo se dice «llamé» (o «escribí», «mandé un mail») si esa entrada fue un contacto por ese canal; una nota no es un contacto.
  const comunic = vos ? "comunicás" : "comunicas", I = it => mine(it.who) || !it.who;
  const scen = it => {
    const t = [result.get(it.id), ...(it.rows || []).map(r => r.join(": "))].filter(Boolean).join(" ");
    if (it.kind === "mail") return { k: "mail", p: 3 };
    if (it.kind === "contact") { const o = it.outcome; if (o === "callback") return { k: "callback", p: 5 }; if (o === "demo") return { k: "demo", p: 6 }; if (o === "info") return { k: "info", p: 4 };
      if (o === "gatekeeper") return { k: "gate", p: 5, t }; if (o === "not_now") return { k: "notnow", p: 4 }; if (o === "no_answer") return { k: "noanswer", p: 1, t }; }
    if (!t) return null;
    if (GATE.test(t) || (ABSENT.test(t) && TIMECUE.test(t))) return { k: "gate", p: 5, t };
    if (NAMECUE.test(t) && okName(NAMECUE.exec(t)[1])) return { k: "name", p: 4, t };
    if (INFO.test(t)) return { k: "info", p: 4, t };
    if (NOANSWER.test(t)) return { k: "noanswer", p: 1, t };
    if (SPOKE.test(t)) return { k: "spoke", p: 3, t };
    // algo dicho sin más: sirve para abrir solo si fue un contacto (de una nota no se puede decir «llamé»)
    return verbOf(it, true) ? { k: "said", p: 2, t } : null;
  };
  const cands = [...contacts, ...humanNotes].sort(byNew).map(it => ({ it, s: scen(it) })).filter(x => x.s);
  const lastDay = cands.length ? dayOf(cands[0].it, tz) : null;
  const pick = cands.filter(x => dayOf(x.it, tz) === lastDay).sort((a, b) => b.s.p - a.s.p || byNew(a.it, b.it))[0];
  let opening = "", openingSrc = "";
  if (pick) {
    const { it, s } = pick, rel = cap(when(it)), yo = I(it), t = s.t || "", verb = verbOf(it, yo);
    const me_ = yo ? "me" : "nos";
    if (s.k === "gate") {
      const people = rolePeople(t), roles = people.map(p => p.phrase), rc = recepName(t);
      const where = /recepci/i.test(t) || it.outcome === "gatekeeper" ? "en recepción" : /secretar/i.test(t) ? "en secretaría" : "";
      const cue = TIMECUE.exec(t), sc = SCHED.exec(t);
      // «Marta Díaz (Directora)» → se pide por el nombre
      const asked = ((it.rows || []).find(([k]) => /^preguntar por$/i.test(k))?.[1] || "").replace(/\s*\([^()]*\)$/, "");
      const parts = [];
      if (rc) parts.push(`${me_} atendió ${rc} ${where || "en recepción"}`);
      if (cue && !sc) parts.push(`${rc ? `${me_} pidió` : `${where ? `${where} ` : ""}${me_} pidieron`} que ${yo ? "llame" : "llamemos"} ${fixAccent(cue[1])}${ABSENT.test(t) && roles.length ? ` porque no ${roles.length > 1 ? "estaban" : "estaba"} ${roles.join(" ni ")}` : ""}`);
      else if (!rc && where) parts.push(`${me_} atendieron ${where}`);
      let s1 = verb ? `${rel} ${verb}${parts.length ? ` y ${parts.join("; ")}` : ""}` : `${rel} ${parts.join("; ")}`;
      if (sc) { const who = rolePeople(t.slice(Math.max(0, sc.index - 60), sc.index))[0]; s1 += `: ${me_} ${rc ? "dijo" : "dijeron"} que ${who ? `${who.phrase}${who.name ? ` ${who.name}` : ""} ` : ""}${sc[1].toLowerCase()} ${sc[2]}`; }
      const named = people.filter(p => p.name).map(p => p.name), plainRoles = people.filter(p => !p.name).map(p => p.phrase);
      const who = asked || (named.length ? named.join(" o con ") : plainRoles.length ? plainRoles.join(" o con ") : "");
      opening = `${intro} ${s1.trim()}. ¿Me ${comunic} con ${who || `quien ve ${la}`}?`;
    } else if (s.k === "noanswer") {
      const what = /ocupad/i.test(t) ? "la línea estaba ocupada" : /buz[oó]n/i.test(t) ? "saltó el buzón de voz" : channelOf(it) === "call" || !verb ? "no atendió nadie" : "no respondieron";
      opening = `${intro} ${rel} ${verb ? `${verb} y ` : ""}${what}. Quería hablar con quien ve ${la} del colegio: ¿con quién me comunico?`;
    } else if (s.k === "name") {
      opening = `${intro} ¿Me ${comunic} con ${NAMECUE.exec(t)[1]}, por favor? Es por ${la} del colegio.`;
    } else if (s.k === "mail") {
      opening = `${intro} ${rel} te ${yo ? "mandé" : "mandamos"} un mail${it.mail?.subject ? ` («${it.mail.subject}»)` : ""} sobre ${la} y quería saber si lo pudiste ver. ¿Lo vemos 20 minutos esta semana?`;
    } else if (s.k === "info") {
      opening = `${intro} Te llamo por la información sobre ${la} que ${me_} pediste ${rel.toLowerCase()}. ¿La pudiste ver? Me gustaría mostrártelo en 20 minutos.`;
    } else if (s.k === "callback") {
      opening = `${intro} ${rel} ${me_} pediste que te volviéramos a llamar para seguir hablando de ${la}. ¿${vos ? "Tenés" : "Tienes"} 5 minutos ahora?`;
    } else if (s.k === "demo") {
      opening = `${intro} Te llamo por la demo de OrderEAT que agendamos ${rel.toLowerCase()}.`;
    } else if (s.k === "notnow") {
      opening = `${intro} ${rel} ${me_} dijiste que no era el momento para ver lo de ${la}. ¿Cambió algo desde entonces?`;
    } else if (s.k === "spoke") {
      // «Habló con la administradora…»: se retoma con esa persona (y lo que pidió, si dice cuándo)
      const spoke = SPOKE.exec(t), cue = TIMECUE.exec(t);
      opening = `${intro} ${rel} ${yo ? "hablé" : "hablamos"} con ${spoke[1].toLowerCase()} sobre ${la}${cue ? ` y ${yo ? "me" : "nos"} pidió que ${yo ? "volviera" : "volviéramos"} a llamar ${fixAccent(cue[1])}` : ""}. ¿Me ${comunic} con ${/^la\b/i.test(spoke[1]) ? "ella" : "él"}?`;
    } else opening = `${intro} ${rel} ${it.type === "deadline" ? (yo ? "te escribí" : "te escribimos") + " por WhatsApp" : `${verb} al colegio`} por ${la}. ¿Con quién puedo hablar sobre ${la}?`;
    openingSrc = src(it);
  } else {
    opening = cold;
    openingSrc = contacts.length ? "Plantilla: las actividades no tienen notas que digan qué pasó" : "Plantilla de primer contacto: lo que hay son notas, no contactos";
  }
  // lo último que se anotó (una nota o un comentario más nuevo que lo que abre la llamada): va aparte, sin decir que hubo contacto
  const nt = humanNotes.find(n => n.text && (!pick || byNew(n, pick.it) < 0));
  const noted = nt ? { text: `${mine(nt.who) || !nt.who ? "Anotaste" : `${nt.who} anotó`} ${when(nt)}: «${String(nt.text).replace(/\s+/g, " ").slice(0, 240)}»`, src: src(nt) } : null;
  return { ...base, cold: false, headline, counts, happened: happened.slice(0, 5), facts, askFor: askFor.slice(0, 4), plan: plan.slice(0, 3), warnings: [...warnings.slice(0, 3), ...extraWarn], opening, openingSrc,
    ...(noted ? { noted } : {}), thin: contacts.length && !happened.some(h => h.text) ? "Hay actividades hechas pero sin notas: no se sabe qué pasó en ellas." : "" };
}

// ---------- resumen con IA: las entradas numeradas para el modelo y el control de lo que devuelve
// entries: las entradas que se le pasan (las más nuevas, sin las de una duplicada sin ciudad); cada dato tiene que citar de cuál sale.
export function aiEntries(items, { tz, today, limit = 40 } = {}) {
  return items.filter(x => !x.aside).slice(0, limit).map((it, i) => ({ n: i + 1, it, src: srcOf(it, tz, today),
    line: `[${i + 1}] ${ddmmyyyy(dayOf(it, tz))} (${relDay(dayOf(it, tz), today)}) · ${it.kind === "contact" ? `${it.label}: ${it.title}` : it.title && it.title !== it.label ? `${it.label} «${it.title}»` : it.label}${it.who ? ` · ${it.who}` : ""}${it.where ? ` · ${it.where}` : ""}`
      + `${it.text ? `: ${String(it.text).replace(/\s+/g, " ").slice(0, 600)}` : ""}${(it.rows || []).length ? ` (${it.rows.map(r => r.join(": ")).join("; ")})` : ""}${it.mail ? ` (a ${it.mail.to}: «${it.mail.subject}»)` : ""}` }));
}
const NUMS = s => (String(s).match(/\d+/g) || []);
const OK_NUMS = new Set(["5", "10", "15", "20", "30"]);
const WORDS = s => new Set((String(s).toLowerCase().match(/[\p{L}]+/gu) || []));
// al principio de una oración, una palabra con forma de verbo conjugado o de adverbio no es un nombre («Pidió», «Llamando»)
const VERBISH = /(?:ó|aron|ieron|ando|iendo|mente|aba|aban|amos|emos|imos)$/;
// compromisos: «quedamos/acordaron/pidió/quiere… la propuesta/una demo/una visita…» tienen que estar en la entrada citada
const COMMIT = /\b(?:qued(?:amos|aron|ó)|acord(?:amos|aron|ó)|pidi(?:ó|eron)|quier(?:e|en)|quer[ií]a[n]?|prometi(?:ó|mos)|confirm(?:ó|aron|amos)|acept(?:ó|aron)|agend(?:ó|amos|aron)|interes(?:a|an|ó|ad[oa]s?))(?![\p{L}])/iu;
const COMMIT_OBJ = /\b(propuesta|demo|visita|reuni[oó]n|cotizaci[oó]n|presupuesto|contrato|precio|prueba|cita|info|informaci[oó]n)(?![\p{L}])/giu;
const WHEN_WORDS = /\b(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)(?![\p{L}])/giu;
// ¿Todo lo de un texto está en las fuentes? Los números (salvo los de la propuesta de la casa: 5, 20, 30 minutos); toda
// palabra con mayúscula (también al principio de una oración o después de ¿ ¡ « ( "), salvo palabras de función o que estén
// en las fuentes; los días y meses; y los compromisos (pidió/quedamos… + propuesta/demo/visita…), en la entrada citada.
// corpus: todas las entradas; cited: las citadas (si no se pasa, todas).
export function grounded(text, corpus, extra = [], cited = corpus) {
  const t = String(text || ""), cw = WORDS(corpus), kw = WORDS(cited), nums = new Set(NUMS(corpus));
  if (NUMS(t).some(n => !nums.has(n) && !OK_NUMS.has(n))) return false;
  const ok = new Set([..."OrderEAT WhatsApp Google".split(" "), ...extra.flatMap(x => String(x || "").split(/\s+/))].map(x => x.toLowerCase()).filter(Boolean));
  for (const m of t.matchAll(/[A-ZÁÉÍÓÚÑ][\p{L}]{2,}/gu)) {
    const w = m[0], lw = w.toLowerCase(), before = t.slice(0, m.index), start = !before.trim() || /(?:[.!?…:;]\s*|[¿¡«("“'—–-]\s*)$/.test(before);
    if (ok.has(lw) || cw.has(lw) || FUNC.has(lw) || (start && VERBISH.test(lw))) continue;
    return false;
  }
  for (const w of t.match(WHEN_WORDS) || []) if (!cw.has(w.toLowerCase())) return false;
  // «hoy», «ayer», «anteayer»: el día de la entrada citada (cada línea dice «(ayer)», «(hoy)»…)
  for (const w of t.match(/\b(hoy|ayer|anteayer)(?![\p{L}])/giu) || []) if (!kw.has(w.toLowerCase())) return false;
  for (const s of sentences(t)) if (COMMIT.test(s)) for (const o of s.match(COMMIT_OBJ) || []) if (!kw.has(o.toLowerCase())) return false;
  return true;
}
// raw: lo que devolvió el modelo (JSON). rules: el resumen por reglas (de ahí salen el conteo, lo pendiente y, si la apertura
// no pasa el control, la apertura). Cada texto se revisa oración por oración: la que nombra algo que no está, se descarta.
// Sale con la misma forma que el de reglas (mode: "ia").
export function groundAi(raw, entries, rules, { corpusExtra = "", names = [] } = {}) {
  if (!raw || typeof raw !== "object") return null;
  const lines = entries.map(e => e.line.replace(/^\[\d+\]\s*/, ""));
  const corpus = [lines.join("\n"), (rules.pending || []).map(p => p.text).join("\n"), corpusExtra].join("\n");
  const refs = f => [...new Set((Array.isArray(f) ? f : [f]).map(Number).filter(n => n >= 1 && n <= entries.length))];
  const src = ns => ns.map(n => entries[n - 1].src).join(" · ");
  const list = (arr, map) => (Array.isArray(arr) ? arr : []).map(map).filter(Boolean);
  const cited = x => {
    const ns = refs(x?.fuentes); if (!ns.length) return null;
    const cc = [ns.map(n => lines[n - 1]).join("\n"), corpusExtra].join("\n");
    const keep = sentences(String(x?.texto || "").trim()).filter(s => grounded(s, corpus, names, cc));
    return keep.length ? { text: keep.join(" "), src: src(ns) } : null;
  };
  const happened = list(raw.que_paso, x => { const c = cited(x); return c && { lead: "", text: c.text, quote: false, src: c.src }; });
  const aiFacts = list(raw.datos, x => { const ns = refs(x?.fuentes), k = String(x?.k || "").trim(), v = String(x?.v || "").trim(); return k && v && ns.length && grounded(v, corpus, names, [ns.map(n => lines[n - 1]).join("\n"), corpusExtra].join("\n")) ? { k, v, src: src(ns) } : null; });
  // los datos que sacan las reglas (teléfono, mail, horario…) quedan si la IA no trae ese dato
  const facts = [...aiFacts, ...(rules.facts || []).filter(f => !aiFacts.some(a => a.k.toLowerCase() === f.k.toLowerCase()))];
  const askFor = list(raw.preguntar_por, cited), warnings = list(raw.ojo, cited), plan = list(raw.plan, cited);
  const op = String(raw.apertura || "").trim(), opRefs = refs(raw.apertura_fuentes);
  const opOk = op && opRefs.length && grounded(op, corpus, names, [opRefs.map(n => lines[n - 1]).join("\n"), corpusExtra].join("\n"));
  if (!happened.length && !aiFacts.length) return null;
  return { ...rules, mode: "ia", happened, facts, askFor: askFor.length ? askFor : rules.askFor, warnings: warnings.length ? warnings : rules.warnings, plan: plan.length ? plan : rules.plan,
    opening: opOk ? op : rules.opening, openingSrc: opOk ? src(opRefs) : rules.openingSrc, noted: opOk ? null : rules.noted, openingNote: opOk ? "" : op ? "La apertura de la IA nombraba algo que no está en las notas: va la de reglas." : "" };
}
