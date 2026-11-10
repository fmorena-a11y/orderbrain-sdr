// Playbook comercial de OrderEAT para SDRs: resultados de contacto, cadencia,
// guion de llamada, manejo de objeciones, plantillas de WhatsApp y mail, y prioridad de prospectos.
import { market, REACTIVABLE } from "./config.js";
import { addBusinessDays, addDays } from "./time.js";

// ---------- resultados de un contacto
// next: próximo paso sugerido. lost: motivo de pérdida sugerido. interest: etiqueta de la organización.
export const OUTCOMES = [
  { id: "no_answer",   label: "No atendió",               hint: "Nadie respondió o buzón de voz", connected: false },
  { id: "gatekeeper",  label: "Atendió recepción",        hint: "No llegaste al decisor", connected: true },
  { id: "callback",    label: "Decisor: volver a llamar", hint: "Habló el decisor y pidió otro momento", connected: true, interest: "medio" },
  { id: "info",        label: "Pidió información",        hint: "Interés: mandar material y seguir", connected: true, interest: "medio" },
  { id: "demo",        label: "Demo agendada",            hint: "Se crea el trato y la demo", connected: true, interest: "alto" },
  { id: "not_now",     label: "No es el momento",         hint: "Volver a intentar en unos meses", connected: true, interest: "bajo", lost: "No es prioridad ahora" },
  { id: "not_interested", label: "No le interesa",        hint: "Cerrar con motivo", connected: true, interest: "bajo", lost: "No le interesa" },
  { id: "bad_data",    label: "Dato erróneo",             hint: "Teléfono equivocado o el colegio no existe", connected: false },
];
// «Mail enviado»: lo registra solo el envío desde la ficha (lib/gmail.js); no se elige en Registrar (hidden)
export const MAIL_SENT = { id: "sent", label: "Mail enviado", hint: "Salió desde la ficha con tu Gmail", connected: false, hidden: true };
export const outcomeById = id => OUTCOMES.find(o => o.id === id) || (id === MAIL_SENT.id ? MAIL_SENT : null);

const NO_ANSWER_GAPS = [1, 2, 2, 3, 5]; // días hábiles entre intentos
export const MAX_ATTEMPTS = 6;

// Sugiere el próximo paso según el resultado, los intentos previos sin respuesta y el canal usado.
export function suggestNext({ outcome, attempts = 0, channel = "call", today }) {
  const o = outcomeById(outcome);
  if (!o) return null;
  switch (o.id) {
    case "no_answer": {
      const n = attempts + 1;
      if (n >= MAX_ATTEMPTS) return { type: null, why: `Van ${n} intentos sin respuesta. Conviene cerrarlo como «No responde más» y reactivarlo en unos meses.`, lost: "No responde más" };
      const gap = NO_ANSWER_GAPS[Math.min(n - 1, NO_ANSWER_GAPS.length - 1)];
      const type = channel === "call" && n % 2 === 1 ? "deadline" : "call";
      return { type, date: type === "deadline" ? today : addBusinessDays(today, gap), why: type === "deadline" ? `Intento ${n} sin respuesta: mandá un WhatsApp hoy para que te reconozcan cuando vuelvas a llamar.` : `Intento ${n} sin respuesta: volvé a llamar en ${gap} día${gap > 1 ? "s" : ""} hábil${gap > 1 ? "es" : ""}, en otro horario.` };
    }
    case "gatekeeper": return { type: "call", date: addBusinessDays(today, 2), why: "Pedí el nombre del decisor y su mejor horario. Volvé a llamar en 2 días hábiles preguntando por esa persona." };
    case "callback": return { type: "call", date: addBusinessDays(today, 1), why: "Agendá la llamada en el día y hora exactos que te dio. Cumplir lo pactado genera confianza." };
    case "info": return { type: "call", date: addBusinessDays(today, 2), why: "Mandá la info hoy y llamá en 2 días hábiles para confirmar que la vio y proponer una demo de 20 minutos." , also: "mail" };
    case "demo": return { type: "call", date: null, why: "Un día antes de la demo, confirmá por WhatsApp. Se crea el trato en el embudo del país." };
    case "not_now": return { type: "call", date: addDays(today, 90), why: "Pedí cuándo planifican el próximo ciclo. Por defecto, reintento en 3 meses.", lost: "No es prioridad ahora" };
    case "not_interested": return { type: null, why: "Registrá el motivo real. Se puede reactivar en 6 meses si cambia la concesión o la dirección.", lost: "No le interesa" };
    case "bad_data": return { type: "task", date: today, why: "Buscá el teléfono correcto en Google Maps, la web o redes antes de descartarlo." };
  }
  return null;
}

// ---------- guion y objeciones (versión sin IA)
const v = (m, tu, vos) => (m.trato === "vos" ? vos : tu);
// artículo del espacio: «la cafetería», «el casino», «el bar escolar»
const masc = m => /^(casino|bar)\b/.test(m.espacio);
const la = m => `${masc(m) ? "el" : "la"} ${m.espacio}`, dela = m => `${masc(m) ? "del" : "de la"} ${m.espacio}`, ala = m => `${masc(m) ? "al" : "a la"} ${m.espacio}`;
const La = m => la(m).replace(/^./, c => c.toUpperCase());
const losPadres = m => (m.padres === "familias" ? "las familias" : `los ${m.padres}`);

export function playbookFor(school, match = {}) {
  const m = market(school.country);
  const status = match.status || "unk";
  const situacion = {
    new: "Nunca hubo contacto con OrderEAT: es un primer contacto en frío.",
    org: "Está en Pipedrive pero nunca tuvo un trato. Puede haber notas viejas: revisalas en Historial antes de llamar.",
    lost: `Se le mandó la propuesta y no se cerró${match.detail ? ` (${match.detail})` : ""}. Abrí reconociendo esa propuesta y preguntá qué cambió desde entonces.`,
    stalled: `Ya se lo contactó y no avanzó${match.detail ? ` (${match.detail})` : ""}. Abrí retomando ese contacto y buscá llegar al decisor.`,
    open: "Tiene un trato abierto con alguien del equipo. Coordiná con el dueño del trato antes de llamar.",
    client: "Ya es cliente. No prospectar: si hay algo, avisale al equipo de cuentas.",
    unk: "Todavía no se cruzó con Pipedrive. Se revisa al abrir la ficha.",
    archived: "Está archivado en la app: no se prospecta. Si cambió algo, desarchivalo primero.",
    churn: /onboarding/i.test(match.churnLabel || "") ? "Firmó con OrderEAT y se cayó durante el onboarding, antes de arrancar a usarlo. Antes de contactar, hablá con el equipo de cuentas para saber qué pasó."
      : /antes de arrancar/i.test(match.churnLabel || "") ? "Firmó con OrderEAT y se cayó antes de arrancar. Antes de contactar, hablá con el equipo de cuentas para saber qué pasó."
      : /pipedrive/i.test(match.churnLabel || "") ? "Se dio de baja según Pipedrive (no sabemos si llegó a estar activo). Antes de contactar, hablá con el equipo de cuentas."
      : "Fue cliente activo de OrderEAT y se dio de baja. Antes de contactar, hablá con el equipo de cuentas para saber por qué se fue.",
    lead: "Es un prospecto (lead) en Pipedrive, todavía sin organización. Lo que registres queda en el prospecto; si agendás la demo, se crea la organización y el trato.",
  }[status];
  const apertura = status === "lost" || status === "stalled"
    ? `Hola, ¿qué tal? ${v(m, "Te habla", "Te habla")} [tu nombre] de OrderEAT. Hace un tiempo ${m.verbo === "platicamos" ? "platicamos" : "conversamos"} sobre ${la(m)} del colegio y quería saber cómo les está yendo hoy. ¿Siguen con el mismo esquema?`
    : `Hola, ¿qué tal? Habla [tu nombre] de OrderEAT. Trabajamos con colegios${school.city ? ` de ${school.city}` : ""} digitalizando ${la(m)}: ${losPadres(m)} cargan saldo desde una app y ven qué consumen sus hijos, y se termina el efectivo. ¿Con quién ${v(m, "puedo", "puedo")} hablar sobre ${la(m)}?`;
  return {
    mercado: m,
    situacion,
    objetivo: status === "lost" || status === "stalled" || status === "org" ? "Reabrir la conversación y agendar una demo de 20 minutos." : "Llegar al decisor, calificar y agendar una demo de 20 minutos.",
    apertura,
    preguntas: [
      `¿${La(m)} es propia del colegio o está concesionada?`,
      "¿Cuántos alumnos tienen y qué niveles (preescolar, primaria, secundaria, prepa)?",
      `¿Cómo pagan hoy los chicos: efectivo, ${m.code === "MX" ? "fiado" : "cuenta corriente"}, tarjeta?`,
      `¿Qué es lo que más les molesta hoy: filas, manejo de efectivo, control de lo que consumen?`,
      `¿Quién decide sobre ${la(m)}: dirección, administración o el concesionario?`,
      "¿Usan algún sistema hoy? ¿Qué le falta?",
    ],
    objeciones: [
      { o: `«Mandame información por mail»`, r: `${v(m, "Claro, te la mando ahora", "Dale, te la mando ahora")}. Para mandarte lo que sirve: ¿cuántos alumnos tienen y ${la(m)} es propia o concesionada? Y ${v(m, "agendemos", "agendemos")} 20 minutos para mostrártelo con tus números, ¿te queda bien el jueves?` },
      { o: "«Ya tenemos un sistema»", r: "Perfecto, eso quiere decir que ya ven el valor de digitalizar. ¿Qué es lo que más les cuesta con el actual? Muchos colegios llegan a OrderEAT por el control que les da a las familias y por los reportes." },
      { o: `«${La(m)} es concesionada, no decidimos nosotros»`, r: `Justo por eso: para el concesionario es más venta y menos efectivo, y para el colegio es control y tranquilidad para ${losPadres(m)}. ${v(m, "¿Me pasas", "¿Me pasás")} el contacto del concesionario y lo presentamos juntos?` },
      { o: "«Es caro» / «No tenemos presupuesto»", r: "Es una inversión que se recupera: los colegios que usan OrderEAT ven hasta +20% en pedidos y ahorran unas 90 horas al mes. ¿Lo vemos con tus números en una demo corta?" },
      { o: "«No es prioridad ahora»", r: `Entiendo. ¿Cuándo arman el próximo ciclo o cambian la concesión? ${v(m, "Te escribo", "Te escribo")} unas semanas antes para que lo tengan en cuenta.` },
      { o: `«Los ${m.padres} no van a usar una app»`, r: "La carga de saldo es tan simple como pagar cualquier servicio, y el colegio decide si convive con el efectivo al principio. Lo podemos ver en la demo con casos de colegios parecidos." },
    ],
    cierre: `Propuesta concreta: «${v(m, "¿Te parece", "¿Te parece")} si lo vemos 20 minutos el [día] a las [hora]? ${v(m, "Te mando", "Te mando")} la invitación por mail y WhatsApp».`,
  };
}

// ---------- plantillas de WhatsApp y mail
export function templates(school, { me = "", contact = "" } = {}) {
  const m = market(school.country);
  const hola = contact ? `Hola ${contact.split(" ")[0]}` : "Hola";
  const yo = me ? me.split(" ")[0] : "[tu nombre]";
  const firma = me ? `\n\n${m.cierre},\n${me}\nOrderEAT` : `\n\n${m.cierre},\nOrderEAT`;
  return [
    { id: "intro", channel: "whatsapp", label: "Primer contacto", text: `${hola}, ¿cómo ${v(m, "estás", "estás")}? Soy ${yo}, de OrderEAT. Trabajamos con colegios${school.city ? ` de ${school.city}` : ""} digitalizando ${la(m)}: ${losPadres(m)} cargan saldo desde una app, ven qué consumen sus hijos y se termina el manejo de efectivo.\n\n¿Con quién ${v(m, "puedo", "puedo")} hablar sobre ${la(m)} de ${school.name}?` },
    { id: "after_call", channel: "whatsapp", label: "Después de no atender", text: `${hola}, soy ${yo} de OrderEAT. Te ${v(m, "intenté", "intenté")} llamar recién por ${la(m)} de ${school.name}. ¿Qué día y horario te queda cómodo para una llamada de 5 minutos?` },
    { id: "info", channel: "whatsapp", label: "Mandar información", text: `${hola}, como ${m.verbo}, te comparto información de OrderEAT. En resumen:\n\n• App para ${m.padres}: saldo, límites diarios y alergias\n• Punto de venta rápido para ${la(m)}, sin efectivo\n• Reportes de ventas en tiempo real\n\n¿${v(m, "Te parece", "Te parece")} si lo vemos 20 minutos esta semana?` },
    { id: "confirm_demo", channel: "whatsapp", label: "Confirmar demo", text: `${hola}, ${v(m, "te escribo", "te escribo")} para confirmar nuestra reunión de [día] a las [hora] para ver OrderEAT en ${la(m)} de ${school.name}. Te llega la invitación por mail. ¡Nos vemos!` },
    { id: "reactivate", channel: "whatsapp", label: "Reactivar", text: `${hola}, ¿cómo ${v(m, "estás", "estás")}? Soy ${yo} de OrderEAT. Hace un tiempo ${m.verbo} sobre ${la(m)} de ${school.name}. ¿Cómo les está yendo este año? Sumamos mejoras que pueden servirles y me gustaría mostrártelas en 20 minutos.` },
    { id: "mail_info", channel: "mail", label: "Información por mail", subject: `OrderEAT para ${la(m)} de ${school.name}`, text: `${hola},\n\nComo ${m.verbo}, te comparto cómo OrderEAT ayuda a colegios como ${school.name}:\n\n• Los ${m.padres} cargan saldo desde una app, ponen límites diarios y marcan alergias.\n• ${La(m)} cobra con un punto de venta rápido, sin efectivo y con menos filas.\n• Reportes de ventas en tiempo real para la administración.\n\nLos colegios que lo usan ven hasta +20% en pedidos y ahorran unas 90 horas al mes.\n\n¿${v(m, "Te parece", "Te parece")} si lo vemos 20 minutos esta semana? ${v(m, "Proponme", "Proponeme")} un día y horario.${firma}` },
    { id: "mail_demo", channel: "mail", label: "Confirmación de demo", subject: `Demo OrderEAT · ${school.name}`, text: `${hola},\n\nGracias por el tiempo. Te confirmo la demo de OrderEAT para el [día] a las [hora]. Vamos a ver en 20 minutos cómo funcionaría en ${la(m)} de ${school.name} y a responder todas las dudas.\n\nSi se suma alguien más (dirección, administración o el concesionario), mejor.${firma}` },
    { id: "mail_reactivate", channel: "mail", label: "Reactivar por mail", subject: `${school.name}: ¿cómo va ${la(m)} este año?`, text: `${hola},\n\nHace un tiempo ${m.verbo} sobre ${la(m)} de ${school.name}. Desde entonces sumamos mejoras en OrderEAT que pueden servirles, sobre todo en control para ${losPadres(m)} y reportes.\n\n¿${v(m, "Te parece", "Te parece")} si lo vemos 20 minutos? ${v(m, "Proponme", "Proponeme")} un día y horario.${firma}` },
  ];
}

// Mensaje sin IA: la plantilla de la casa que corresponde al estado del colegio y, si el SDR escribió el contexto como se lo
// diría al colegio («me pasó tu contacto…», «te escribo porque…»), se suma tal cual. Si parece una nota para sí mismo,
// no se mete en el mensaje (se avisa). No agrega datos.
const AL_COLEGIO = /^(me|te|le|les|nos|quiero|quer[ií]a|quisiera|habl[eé]|estuve|vi|vimos|como|seg[uú]n|gracias|perd[oó]n|disculp|tal como|siguiendo|retomando|retomo|por recomendaci[oó]n)\b/i;
export function composeMessage(school, { channel = "whatsapp", context = "", contact = "", me = "", base = "", status = "", attempts = 0 } = {}) {
  const ctx = String(context).trim().replace(/\s+/g, " ").replace(/^./, c => c.toUpperCase()).replace(/([^.!?])$/, "$1.");
  if (!ctx && base) return { text: base, unchanged: true };
  const m = market(school.country), mail = channel === "mail", revive = status === "lost" || status === "stalled";
  const t = templates(school, { me, contact }), pick = id => t.find(x => x.id === id);
  const note = ctx && !AL_COLEGIO.test(ctx) ? "Lo que escribiste parece una nota para vos: no lo puse en el mensaje. Escribilo como se lo dirías al colegio («me pasó tu contacto…», «te escribo porque…») y lo sumo." : "";
  const add = ctx && !note ? ctx : "";
  if (!mail) {
    const base0 = pick(revive ? "reactivate" : attempts ? "after_call" : "intro").text, i = base0.indexOf("OrderEAT.");
    return { text: add && i > 0 ? `${base0.slice(0, i + 9)} ${add}\n\n${base0.slice(i + 9).trim()}` : base0, note };
  }
  if (revive) { const r = pick("mail_reactivate"); return { subject: r.subject, text: add ? r.text.replace(/^(.*?,)\n\n/, `$1\n\n${add}\n\n`) : r.text, note }; }
  const hola = contact ? `Hola ${contact.split(" ")[0]}` : "Hola", yo = me ? me.split(" ")[0] : "[tu nombre]";
  const firma = me ? `${m.cierre},\n${me}\nOrderEAT` : `${m.cierre},\nOrderEAT`;
  return { subject: `OrderEAT para ${la(m)} de ${school.name}`, note, text: [`${hola},`, `Soy ${yo}, de OrderEAT.${add ? ` ${add}` : ""}`,
    `Trabajamos con colegios${school.city ? ` de ${school.city}` : ""} digitalizando ${la(m)}: ${losPadres(m)} cargan saldo desde una app, ven qué consumen sus hijos y se termina el manejo de efectivo.`,
    `¿${v(m, "Te parece", "Te parece")} si lo vemos 20 minutos esta semana?`, firma].join("\n\n") };
}

// ---------- prioridad de prospectos
// Devuelve { score 0-100, reasons[] } o null si no conviene contactarlo ahora.
export function scoreSchool(s, match, touches = [], { now = Date.now() } = {}) {
  const st = match?.status || "unk";
  if (st === "client" || st === "open" || st === "churn" || st === "archived") return null; // ex clientes: se coordinan con cuentas, no van a la cola; archivados tampoco
  const last = touches.length ? Math.max(...touches.map(t => new Date(t.at).getTime())) : 0;
  const daysSince = last ? (now - last) / 864e5 : Infinity;
  const attempts = countAttempts(touches);
  if (daysSince < 1) return null; // ya se contactó hoy
  let score = 0; const reasons = [];
  if (st === "new") { score += 40; reasons.push("Nunca contactado"); }
  else if (st === "org") { score += 32; reasons.push("En Pipe sin trato"); }
  else if (st === "lost" || st === "stalled") {
    const reason = match.lostReason || "";
    const months = match.lostAt ? (now - new Date(match.lostAt)) / (30 * 864e5) : 99;
    if (months < 4) return null;
    if (REACTIVABLE.some(r => reason.includes(r)) || !reason) { score += st === "stalled" ? 30 : 28; reasons.push(`${st === "stalled" ? "Contactado sin avance" : "Perdido con propuesta"} hace ${Math.round(months)} meses${reason ? ` · ${reason}` : ""}`); }
    else return null;
  } else { score += 20; reasons.push("Sin revisar"); }
  const [, rv, rn] = String(s.rating || "").match(/([\d.,]+)\s*(?:\((\d+)\))?/) || [];
  const rating = parseFloat(String(rv || "").replace(",", ".")), reviews = Number(rn || 0);
  if (rating >= 4.3 && reviews >= 20) { score += 10; reasons.push(`${rv}★ (${reviews} reseñas)`); } else if (rating >= 4) score += 4;
  if (reviews >= 100) { score += 6; if (!(rating >= 4.3)) reasons.push(`Muchas reseñas (${reviews})`); }
  if (s.phone) score += 12; else { score -= 20; reasons.push("Sin teléfono"); }
  if (s.pitch) { score += 8; reasons.push("Tiene ángulo de venta"); }
  if (s.fit === "alto") { score += 10; reasons.push("Encaje alto según IA"); } else if (s.fit === "bajo") score -= 12;
  if (s.found && (now - Date.parse(s.found)) / 864e5 <= 14) { score += 6; reasons.push("Nuevo en el radar"); }
  for (const o of s.opp || []) {
    if (o.startsWith("Bilingüe")) { score += 6; reasons.push("Bilingüe o internacional"); }
    else if (o.startsWith("Universidad")) { score += 3; reasons.push("Universidad (OrderGO)"); }
    else if (o.startsWith("Confesional")) score += 2;
  }
  if (s.private === "probable") score -= 3;
  if (s.web) score += 4;
  if (attempts) { score += Math.max(0, 10 - attempts * 3); reasons.push(`${attempts} intento${attempts > 1 ? "s" : ""} sin respuesta`); if (daysSince < 2) score -= 15; }
  if (attempts >= MAX_ATTEMPTS) return null;
  return { score: Math.max(1, Math.min(100, Math.round(score))), reasons, attempts };
}

// Intentos sin respuesta consecutivos (desde el último contacto efectivo).
export function countAttempts(touches) {
  let n = 0;
  for (const t of [...touches].sort((a, b) => String(b.at).localeCompare(String(a.at)))) {
    if (t.connected) break;
    if (t.outcome === "no_answer") n++;
  }
  return n;
}
