// Claude: ordenar notas, preparar llamadas, redactar mensajes y asistente de ventas con herramientas.
import Anthropic from "@anthropic-ai/sdk";
import crypto from "crypto";
import * as pd from "./pipedrive.js";
import { schools, byId, getMatch, touchesFor, kvEnabled, kv, key } from "./store.js";
import { market, TYPE_LABEL } from "./config.js";
import { playbookFor, countAttempts, outcomeById } from "./playbook.js";
import { todayIn, weekday } from "./time.js";

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";
const client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
export const aiEnabled = () => !!client;
const strip = h => String(h || "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim();
const textOf = r => r.content.filter(b => b.type === "text").map(b => b.text).join("");
const jsonOf = t => { const m = t.match(/\{[\s\S]*\}/); return m ? JSON.parse(m[0]) : null; };

const EXPERT = `Sos un SDR senior de OrderEAT con años de experiencia vendiendo a colegios de Latinoamérica.
OrderEAT es software para la cafetería escolar: app para que las familias carguen saldo, pongan límites y marquen alergias; punto de venta rápido sin efectivo; reportes en tiempo real; tótems e identificación (pulseras, tarjetas, credenciales, huella). Prueba social canónica: hasta +20% en pedidos y unas 90 horas al mes ahorradas. No inventes otros números, clientes ni precios.
Hay dos compradores: el concesionario (opera la cafetería como negocio: le importan ventas, efectivo, filas, mermas) y la dirección del colegio (le importan familias, alergias, imagen, control). Si la cafetería es concesionada, el colegio igual influye: el camino es presentarlo juntos.
Vocabulario por país: México "cafetería" y "papás" (tú); Perú "cafetería" (tú); Argentina "cantina" (vos); Uruguay "cantina" (tú en escrito); Chile "casino" y "apoderados" (tú, más formal); Costa Rica "soda"; Guatemala "cafetería".
El objetivo de cada contacto del SDR es avanzar un paso: llegar al decisor, calificar (cafetería propia o concesionada, cantidad de alumnos, niveles, sistema actual, quién decide) y agendar una demo de 20 a 30 minutos con fecha y hora concretas.`;

// ---------- ordenar una nota de prospección
export async function structureNote({ school, outcome, text }) {
  if (!client) return null;
  const r = await client.messages.create({
    model: MODEL, max_tokens: 600,
    messages: [{ role: "user", content:
      `Ordená lo que anotó un SDR de OrderEAT después de contactar al colegio "${school.name}" (${school.city}, ${school.country}); resultado: ${outcome}. Usá solo lo que dice el texto; si algo no aparece, dejá el campo vacío. Respondé solo JSON con estas claves de texto: resumen (1 oración), decisor, cafeteria ("Propia", "Externa", "No tiene" o ""), objecion, proximo_paso, interes ("alto","medio","bajo","nulo" o "").\n\nTexto del SDR:\n${text}` }],
  });
  return jsonOf(textOf(r));
}

// ---------- preparar una llamada (brief a medida, con el historial de Pipedrive)
const briefCache = new Map();
export async function brief(schoolId, { user } = {}) {
  if (!client) throw Object.assign(new Error("Falta ANTHROPIC_API_KEY en el servidor"), { status: 500 });
  const s = byId.get(schoolId); const m = getMatch(schoolId) || {};
  const key = schoolId + "|" + (m.checkedAt || "") + "|" + touchesFor(schoolId).length;
  const hit = briefCache.get(key); if (hit && Date.now() - hit.at < 6 * 3600e3) return hit.data;
  let history = "";
  if (m.orgId) {
    const [deals, notes] = await Promise.all([pd.dealsForOrg(m.orgId), pd.notesForOrg(m.orgId, 6)]);
    history = `Tratos: ${deals.map(d => `${d.title} (${d.status}${d.lost_reason ? ", " + d.lost_reason : ""})`).join("; ") || "ninguno"}\nNotas recientes:\n${notes.map(n => `- ${(n.add_time || "").slice(0, 10)} ${n.user?.name || ""}: ${strip(n.content).slice(0, 400)}`).join("\n") || "ninguna"}`;
  }
  const t = touchesFor(schoolId).slice(-8).map(x => `- ${x.at.slice(0, 10)} ${x.byName}: ${outcomeById(x.outcome)?.label} por ${x.channel}${x.text ? ` — ${x.text}` : ""}`).join("\n");
  const mk = market(s.country);
  const r = await client.messages.create({
    model: MODEL, max_tokens: 1400, system: EXPERT,
    messages: [{ role: "user", content: `Prepará a ${user?.name || "el SDR"} para contactar a este colegio. Hablá en el registro de ${s.country} (${mk.trato === "vos" ? "voseo" : "tuteo"}, "${mk.espacio}").
Colegio: ${s.name} — ${[s.addr, s.city, s.country].filter(Boolean).join(", ")}${s.rating ? ` — ${s.rating}★ en Google` : ""}${s.web ? ` — ${s.web}` : ""}${s.pitch ? `\nÁngulo conocido: ${s.pitch}` : ""}
Estado en Pipedrive: ${m.detail || "sin revisar"}
${history}
Contactos previos desde OrderBrain:\n${t || "ninguno"}

Respondé solo JSON con: situacion (1-2 oraciones: qué pasó antes y en qué punto está), angulo (qué ángulo usar y por qué, 1-2 oraciones), apertura (lo que dice el SDR en los primeros 15 segundos, natural, sin sonar a guion), preguntas (array de 4 preguntas de descubrimiento, la más importante primero), objeciones (array de 3 objetos {o, r} con las objeciones más probables para ESTE colegio y respuesta corta), cierre (cómo pedir la demo), alerta (algo a evitar, o "").` }],
  });
  const data = jsonOf(textOf(r));
  if (!data) throw new Error("No pude armar el brief, probá de nuevo.");
  briefCache.set(key, { at: Date.now(), data });
  return data;
}

// ---------- redactar un mensaje personalizado
export async function draft(schoolId, { channel, purpose, contact, base, user }) {
  if (!client) throw Object.assign(new Error("Falta ANTHROPIC_API_KEY en el servidor"), { status: 500 });
  const s = byId.get(schoolId); const m = getMatch(schoolId) || {}; const mk = market(s.country);
  const r = await client.messages.create({
    model: MODEL, max_tokens: 700, system: EXPERT,
    messages: [{ role: "user", content: `Reescribí este ${channel === "mail" ? "mail" : "WhatsApp"} para ${s.name} (${s.city}, ${s.country}) con el objetivo: ${purpose}. Lo manda ${user?.name || "el SDR"}${contact ? ` a ${contact}` : ""}. Estado en Pipedrive: ${m.detail || "sin datos"}.${s.pitch ? ` Ángulo: ${s.pitch}.` : ""}
Reglas: registro de ${s.country} (${mk.trato === "vos" ? "voseo" : "tuteo"}, "${mk.espacio}"), ${channel === "mail" ? "máximo 120 palabras, asunto corto" : "máximo 60 palabras, tono de WhatsApp, sin asunto"}, una sola pregunta de cierre concreta, sin emojis salvo uno opcional, sin inventar datos. Dejá [día] y [hora] si hacen falta.
Base:\n${base}\n\nRespondé solo JSON: {"subject": "...", "text": "..."}` }],
  });
  return jsonOf(textOf(r)) || { text: base };
}

// ---------- propuestas pendientes de confirmación
// La propuesta viaja firmada (HMAC con SESSION_SECRET) en vez de quedar en memoria: así funciona aunque
// la confirmación caiga en otra instancia del servidor (Vercel). Vale 1 hora y se usa una sola vez.
const SECRET = process.env.SESSION_SECRET || "dev-only-secret";
const sign = body => crypto.createHmac("sha256", SECRET).update(body).digest("base64url");
function keep(p) {
  const body = Buffer.from(JSON.stringify({ ...p, createdAt: Date.now() })).toString("base64url");
  return `${body}.${sign(body)}`;
}
export function getProposal(token) {
  const [body, sig] = String(token || "").split(".");
  if (!body || !sig) return null;
  const want = sign(body);
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  let p; try { p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { return null; }
  if (!p.createdAt || Date.now() - p.createdAt > 3600e3) return null;
  return { ...p, id: token };
}
// Estado de cada propuesta: "pending" mientras se guarda (vence a los 90 s, por si la función muere),
// después "done" (con el enlace) o "discarded". Así un reintento nunca dice "guardado" si no se guardó.
const used = new Map();
const pkey = token => "prop:" + crypto.createHash("sha256").update(token).digest("hex").slice(0, 32);
const parse = v => { try { return JSON.parse(v); } catch { return { state: "done" }; } };
// Devuelve true si la tomó esta llamada; si no, el estado actual { state, orgUrl }.
export async function claimProposal(token) {
  const k = pkey(token), pending = JSON.stringify({ state: "pending" });
  if (kvEnabled) {
    const [ok, cur] = await kv([["SET", key(k), pending, "NX", "EX", "90"], ["GET", key(k)]]);
    return ok === "OK" ? true : parse(cur);
  }
  const now = Date.now();
  for (const [x, v] of used) if (now > v.exp) used.delete(x);
  if (used.has(k)) return used.get(k).val;
  used.set(k, { val: { state: "pending" }, exp: now + 90e3 }); return true;
}
export async function finishProposal(token, state, orgUrl = "") {
  const k = pkey(token), val = { state, orgUrl };
  if (kvEnabled) await kv([["SET", key(k), JSON.stringify(val), "EX", "7200"]]).catch(e => console.warn("No se pudo marcar la propuesta:", e.message));
  else used.set(k, { val, exp: Date.now() + 7200e3 });
}
export async function releaseProposal(token) {
  const k = pkey(token);
  if (kvEnabled) await kv([["DEL", key(k)]]).catch(() => {}); else used.delete(k);
}

function findUser(users, q, me) {
  if (!q || /^(yo|m[ií]|me|a m[ií]|para m[ií])$/i.test(String(q).trim())) return me ? [me] : [];
  const n = pd.norm(q);
  const exact = users.filter(u => pd.norm(u.name) === n);
  return exact.length ? exact : users.filter(u => n.split(" ").every(w => pd.norm(u.name).includes(w)));
}

const TOOLS = [
  { name: "buscar_colegio", description: "Busca un colegio por nombre en Pipedrive y en la base de OrderBrain. Devuelve organizaciones de Pipedrive (org_id, nombre) y colegios de la base (school_id, ciudad, país, teléfono, estado). Usalo antes de proponer actividades o notas.",
    input_schema: { type: "object", properties: { nombre: { type: "string" } }, required: ["nombre"] } },
  { name: "contexto_colegio", description: "Tratos, últimas notas, actividades pendientes y contactos de una organización de Pipedrive.",
    input_schema: { type: "object", properties: { org_id: { type: "integer" } }, required: ["org_id"] } },
  { name: "actividades_de", description: "Actividades pendientes de una persona del equipo (o 'yo') entre dos fechas, ordenadas por fecha. Las horas vienen en UTC.",
    input_schema: { type: "object", properties: { persona: { type: "string" }, desde: { type: "string", description: "YYYY-MM-DD" }, hasta: { type: "string", description: "YYYY-MM-DD" } }, required: ["persona"] } },
  { name: "a_quien_llamar", description: "Lista priorizada de colegios para contactar ahora (nunca contactados, en Pipe sin trato, perdidos reactivables), con el motivo de la prioridad. Filtra por país o ciudad si se indica.",
    input_schema: { type: "object", properties: { pais: { type: "string" }, ciudad: { type: "string" }, cantidad: { type: "integer" } } } },
  { name: "equipo", description: "Nombres de las personas del equipo a las que se les puede asignar actividades.", input_schema: { type: "object", properties: {} } },
  { name: "proponer_actividad", description: "Prepara una actividad (call=llamada, meeting=demo, deadline=WhatsApp, task=mail) para que el usuario la confirme con un botón. NO la crea. La hora va en la hora local del usuario.",
    input_schema: { type: "object", properties: {
      colegio: { type: "string" }, org_id: { type: "integer" }, school_id: { type: "string" }, deal_id: { type: "integer" },
      tipo: { type: "string", enum: ["call", "meeting", "deadline", "task"] }, fecha: { type: "string", description: "YYYY-MM-DD" },
      hora: { type: "string", description: "HH:MM 24 h, hora local del usuario, opcional" }, duracion_min: { type: "integer" },
      asignar_a: { type: "string", description: "nombre del vendedor o 'yo'" }, asunto: { type: "string" }, nota: { type: "string" } },
      required: ["colegio", "tipo", "fecha", "asunto"] } },
  { name: "proponer_nota", description: "Prepara una nota para la organización del colegio en Pipedrive; el usuario la confirma con un botón. NO la guarda.",
    input_schema: { type: "object", properties: { colegio: { type: "string" }, org_id: { type: "integer" }, school_id: { type: "string" }, deal_id: { type: "integer" }, texto: { type: "string" } }, required: ["colegio", "texto"] } },
];

async function runTool(name, i, ctx) {
  const m = await pd.meta();
  const me = m.users.find(u => u.id === ctx.user.pdUserId) || null;
  if (name === "buscar_colegio") {
    const q = String(i.nombre || "").trim(); if (q.length < 2) throw new Error("nombre muy corto");
    const qt = pd.tokens(q);
    const local = schools.filter(s => pd.norm(s.name).includes(pd.norm(q)) || (qt.length && qt.every(t => pd.norm(s.name).includes(t)))).slice(0, 5)
      .map(s => ({ school_id: s.id, colegio: s.name, ciudad: s.city, pais: s.country, telefono: s.phone || null, org_id: getMatch(s.id)?.orgId || null, estado: getMatch(s.id)?.detail || "sin revisar" }));
    const orgs = await pd.searchOrganizations(qt.join(" ") || q, 8);
    return { pipedrive: orgs.map(o => ({ org_id: o.id, nombre: o.name })), base_orderbrain: local };
  }
  if (name === "contexto_colegio") {
    const id = Number(i.org_id);
    const [d, n, a, p] = await Promise.all([pd.dealsForOrg(id), pd.notesForOrg(id, 5), pd.activities({ orgId: id, done: false, limit: 10 }), pd.personsForOrg(id).catch(() => [])]);
    const un = x => m.users.find(u => u.id === x)?.name || x;
    return {
      tratos: d.map(x => ({ deal_id: x.id, titulo: x.title, estado: x.status, embudo: m.pipes[x.pipeline_id], etapa: m.stages[x.stage_id], motivo_perdida: x.lost_reason, actualizado: (x.update_time || "").slice(0, 10) })),
      notas: n.map(x => ({ fecha: (x.add_time || "").slice(0, 10), autor: x.user?.name, texto: strip(x.content).slice(0, 400) })),
      actividades_pendientes: a.map(x => ({ asunto: x.subject, tipo: TYPE_LABEL[x.type] || x.type, fecha: x.due_date, hora_utc: x.due_time, responsable: un(x.owner_id) })),
      contactos: p,
    };
  }
  if (name === "actividades_de") {
    const us = findUser(m.users, i.persona, me);
    if (us.length !== 1) throw new Error(us.length ? "Hay varias personas: " + us.map(u => u.name).join(", ") : "No encontré a esa persona en el equipo");
    const list = await pd.activities({ ownerId: us[0].id, done: false, limit: 300 });
    const de = i.desde || "0000", ha = i.hasta || "9999";
    return { persona: us[0].name, actividades: list.filter(x => x.due_date >= de && x.due_date <= ha).slice(0, 40).map(x => ({ asunto: x.subject, tipo: TYPE_LABEL[x.type] || x.type, fecha: x.due_date, hora_utc: x.due_time, org_id: x.org_id })) };
  }
  if (name === "a_quien_llamar") {
    const { prospectQueue } = await import("./sales.js");
    const pais = i.pais ? [...new Set(schools.map(s => s.country))].find(c => pd.norm(c) === pd.norm(i.pais)) : null;
    let q = prospectQueue({ countries: pais ? [pais] : [], limit: 200 });
    if (i.ciudad) q = q.filter(s => pd.norm(s.city).includes(pd.norm(i.ciudad)));
    return q.slice(0, Math.min(Number(i.cantidad) || 8, 20)).map(s => ({ school_id: s.id, colegio: s.name, ciudad: s.city, pais: s.country, prioridad: s.score, motivos: s.reasons, telefono: s.phone || null }));
  }
  if (name === "equipo") return m.users.map(u => u.name);
  if (name === "proponer_actividad") {
    const us = findUser(m.users, i.asignar_a || "yo", me);
    if (us.length !== 1) throw new Error(us.length ? "Ambiguo, preguntá cuál: " + us.map(u => u.name).join(", ") : `No encontré a "${i.asignar_a}" en el equipo`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(i.fecha))) throw new Error("fecha inválida, usá YYYY-MM-DD");
    if (i.hora && !/^\d{2}:\d{2}$/.test(String(i.hora))) throw new Error("hora inválida, usá HH:MM");
    if (!TYPE_LABEL[i.tipo]) throw new Error("tipo inválido");
    const p = { kind: "activity", colegio: String(i.colegio), orgId: i.org_id ? Number(i.org_id) : null, schoolId: i.school_id && byId.has(i.school_id) ? i.school_id : null,
      dealId: i.deal_id ? Number(i.deal_id) : null, type: i.tipo, typeLabel: TYPE_LABEL[i.tipo], date: i.fecha, time: i.hora || "", tz: ctx.tz,
      durationMin: i.duracion_min ? Number(i.duracion_min) : (i.tipo === "meeting" ? 30 : 0), owner: { id: us[0].id, name: us[0].name },
      subject: String(i.asunto), note: String(i.nota || ""), weekday: weekday(i.fecha), requestedBy: ctx.user.email };
    p.id = keep(p); ctx.proposals.push(p);
    return "Propuesta mostrada al usuario con botón Confirmar. Todavía NO está creada.";
  }
  if (name === "proponer_nota") {
    const p = { kind: "note", colegio: String(i.colegio), orgId: i.org_id ? Number(i.org_id) : null, schoolId: i.school_id && byId.has(i.school_id) ? i.school_id : null,
      dealId: i.deal_id ? Number(i.deal_id) : null, text: String(i.texto), requestedBy: ctx.user.email };
    p.id = keep(p); ctx.proposals.push(p);
    return "Propuesta mostrada al usuario. Todavía NO está guardada.";
  }
  throw new Error("herramienta desconocida");
}

function system(user, focus, tz) {
  const today = todayIn(tz);
  const s = focus && byId.get(focus); const mt = s && getMatch(s.id);
  return `${EXPERT}

Estás dentro de OrderBrain SDR, la herramienta de prospección del equipo. Respondés en español latinoamericano, breve, concreto y con criterio de vendedor: si ves una oportunidad o un riesgo, decilo en una línea.
Hoy es ${weekday(today)} ${today}; zona horaria del usuario: ${tz}. Calculá vos las fechas relativas ("el jueves", "mañana", "la semana que viene") en formato YYYY-MM-DD. Las horas que vienen de Pipedrive están en UTC: convertilas a la hora del usuario al mostrarlas.
Usuario: ${user.name || user.email}.${s ? ` Tiene abierta la ficha de "${s.name}" (${s.city}, ${s.country}), school_id ${s.id}${mt?.orgId ? `, org_id ${mt.orgId}${mt.openDealId ? `, deal abierto ${mt.openDealId}` : ""}` : ""}; estado: ${mt?.detail || "sin revisar"}; intentos sin respuesta: ${countAttempts(touchesFor(s.id))}.` : ""}
Reglas: para crear algo usá SIEMPRE proponer_actividad o proponer_nota y nunca digas que quedó creado: el usuario lo confirma con un botón. Antes de proponer, buscá el colegio con buscar_colegio y usá su org_id o school_id (si hay varias coincidencias, preguntá cuál). Si no dicen a quién asignar, es para "yo". Si falta la fecha, preguntala. Para "¿a quién llamo?" usá a_quien_llamar. Si piden un mensaje o un guion, escribilo directo en el registro del país. Al final respondé en 1 a 4 oraciones sin repetir lo que muestra la tarjeta.`;
}

export async function chat({ user, messages, focus, tz }) {
  if (!client) throw Object.assign(new Error("Falta ANTHROPIC_API_KEY en el servidor"), { status: 500 });
  const ctx = { user, proposals: [], tz };
  const convo = messages.slice(-16).map(m => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content).slice(0, 4000) }));
  while (convo.length && convo[0].role !== "user") convo.shift();
  for (let round = 0; round < 6; round++) {
    const r = await client.messages.create({ model: MODEL, max_tokens: 1500, system: system(user, focus, tz), tools: TOOLS, messages: convo });
    convo.push({ role: "assistant", content: r.content });
    const uses = r.content.filter(b => b.type === "tool_use");
    if (r.stop_reason !== "tool_use" || !uses.length) {
      return { reply: textOf(r).trim() || "Listo.", proposals: ctx.proposals };
    }
    const results = await Promise.all(uses.map(async u => {
      try { return { type: "tool_result", tool_use_id: u.id, content: JSON.stringify(await runTool(u.name, u.input, ctx)).slice(0, 30000) }; }
      catch (e) { return { type: "tool_result", tool_use_id: u.id, content: "Error: " + e.message, is_error: true }; }
    }));
    convo.push({ role: "user", content: results });
  }
  return { reply: "Me quedé sin pasos para resolverlo. ¿Me lo pedís más concreto?", proposals: ctx.proposals };
}

export { playbookFor };
