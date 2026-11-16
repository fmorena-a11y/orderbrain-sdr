// Slack de prueba para «Tus inbound» (DEMO_MODE sin SLACK_BOT_TOKEN): mensajes como los del bot del reparto round robin, con
// datos INVENTADOS (nombres, teléfonos y mails de prueba). Los ts se fijan al arrancar (son la clave de cada lead: procesar dos
// veces no crea dos prospectos). Los prospectos de los links («Lead en Pipedrive») están en lib/pipedrive-demo.js.
//  - para el usuario de prueba (U0DEMO1): uno nuevo de Meta Ads (se crea), uno orgánico con «Colegio» basura (el título usa la
//    persona), uno con el teléfono de un prospecto suyo (ya estaba: no crea, y ya tenía llamada), un referido con link a un
//    prospecto de la cuenta general (pasa a su nombre), uno con link a un prospecto de Juan Diego (no se toca), un SDR revival,
//    uno con el teléfono de un cliente (no contactar) y uno con el mismo nombre que un prospecto sin ciudad (se pregunta);
//  - para Juan Diego (U0DEMO2) dos, y uno para «Agus Tejos» (U0DEMO3, sin email en Slack: se reconoce por el nombre);
//  - una corrección del reparto que nombra al usuario de prueba.
const env = process.env;
const ME = (env.DEV_LOGIN_EMAIL || "demo@ordereat.com").toLowerCase();
export const USERS = { U0DEMO1: { real_name: "Demo SDR", email: ME }, U0DEMO2: { real_name: "Juan Diego", email: "juandiego@ordereat.com" }, U0DEMO3: { real_name: "Agus Tejos", email: "" } };
export const LEAD_FREE = "7a1c0000-0000-4000-8000-00000000b001", LEAD_THEIRS = "7a1c0000-0000-4000-8000-00000000b002", LEAD_GONE = "7a1c0000-0000-4000-8000-00000000b0ff";
const T0 = Math.floor(Date.now() / 1000);
const ts = (hAgo, n) => `${T0 - Math.round(hAgo * 3600)}.${String(100000 + n).slice(1)}`;
const to = (id, name) => `<@${id}|${name}>`;
const reparto = "_Reparto hasta ahora — Demo SDR: 8 · Juan Diego: 8 · Agus Tejos: 7_";
const callMsg = ({ who, src, phone, name, school, country, email, role = "Otro", msg = "—", filtro = true }) => [
  `:telephone_receiver: *Lead para llamar* — le toca a ${who}`,
  filtro ? `_Entró filtrado como puesto no decisor: ${role} — igual hay que llamarlo._` : "",
  src === "meta" ? ":moneybag: Este lead viene de PAUTA en Meta Ads (Facebook/Instagram) · campaña: 120200000000000001" : src === "google" ? ":moneybag: Este lead viene de PAUTA en Google Ads" : ":seedling: Este lead es ORGÁNICO: entró directo a la web, sin UTM (no se sabe la plataforma)",
  "", `*Teléfono:* ${phone}  ·  <https://wa.me/${phone.replace(/\D/g, "")}|WhatsApp>`, `*Nombre:* ${name}`, `*Colegio:* ${school}`, `*País:* ${country}`,
  email ? `*Email:* <mailto:${email}|${email}>` : "*Email:* —", `*Puesto:* ${role}`, `*Mensaje:* ${msg}`, reparto].filter(x => x !== "").join("\n");
const referral = ({ who, school, decider, link, prio = false }) => [
  `:mortar_board: *Referido de padre* — le toca a ${who}${prio ? "  _(prioridad baja)_" : ""}`, `*Colegio:* ${school}`, `*Quien decide:* ${decider}`, "",
  `*Lead en Pipedrive:* <https://ordereat.pipedrive.com/leads/inbox/${link}>`, "_Llamalo antes de 72 h. Al agendar la demo convertí el lead en trato._", "_Reparto del piloto — Demo SDR 3 (+1)_"].join("\n");
const ME_ID = to("U0DEMO1", "Demo SDR"), JD = to("U0DEMO2", "Juan Diego"), AG = to("U0DEMO3", "Agus Tejos");
const MSGS = [
  [1.5, callMsg({ who: ME_ID, src: "meta", phone: "+54 11 5555 0123", name: "Laura Prueba", school: "Colegio Los Pinos del Sur", country: "Argentina", email: "laura@pinosdelsur-ejemplo.test", msg: "Queremos ordenar la cantina y los pagos de las familias." })],
  [5, callMsg({ who: ME_ID, src: "organic", phone: "955000111", name: "Carla Ejemplo", school: "3080", country: "Perú", email: "carla.ejemplo3080@correo-ejemplo.test", role: "Familia", msg: "Info" })],
  [9, callMsg({ who: ME_ID, src: "meta", phone: "+52 55 5555 0101", name: "María Paredes", school: "Centro Educativo Los Álamos", country: "México", email: "", msg: "Quiero saber precios." })],
  [20, referral({ who: ME_ID, school: "Colegio Bosque Azul · Zapopan", decider: "Ana Ejemplo · Quien opera la cafetería  ·  +523300000101", link: LEAD_FREE })],
  [30, referral({ who: ME_ID, school: "Instituto Ríos de Prueba · Monterrey", decider: "Pedro Ejemplo · Director o directora  ·  +528100000202", link: LEAD_THEIRS, prio: true })],
  [40, [`:recycle: *SDR revival* — le toca a ${ME_ID}`, "_Lead de Meta Ads que no se pudo contactar: volvé a intentarlo._", ":moneybag: Este lead viene de PAUTA en Meta Ads (Facebook/Instagram) · campaña: 120200000000000002", "",
    "*Teléfono:* +52 33 5555 0177  ·  <https://wa.me/523355550177|WhatsApp>", "*Nombre:* Rosa Prueba", "*Colegio:* Instituto Jacarandas", "*País:* México", "*Email:* <mailto:rosa@jacarandas-ejemplo.test|rosa@jacarandas-ejemplo.test>", "*Puesto:* Director o directora", "*Mensaje:* —", reparto].join("\n")],
  [50, callMsg({ who: ME_ID, src: "google", phone: "+54 261 555 0921", name: "Administración Cuyo", school: "Cuyo", country: "Argentina", email: "", msg: "Ya usamos OrderEAT, consulta." })],
  [60, callMsg({ who: ME_ID, src: "meta", phone: "+52 55 5555 0999", name: "Jorge Ejemplo", school: "Colegio Monte Verde", country: "México", email: "", msg: "—" })],
  [80, callMsg({ who: ME_ID, src: "meta", phone: "+52 55 5555 0888", name: "Lucía Vencida", school: "Colegio Atardecer", country: "México", email: "lucia@atardecer-ejemplo.test", msg: "Hace 3 días que nadie me llama." })],
  [3, callMsg({ who: JD, src: "google", phone: "+52 222 555 0333", name: "Tomás Ejemplo", school: "Colegio Puebla de Prueba", country: "México", email: "tomas@puebla-ejemplo.test" })],
  [12, referral({ who: JD, school: "Escuela Sol Naciente · Querétaro", decider: "Marta Ejemplo · Director o directora  ·  +524420000303", link: LEAD_GONE })],
  [7, callMsg({ who: AG, src: "meta", phone: "2615550444", name: "Sofía Ejemplo", school: "Colegio Aconcagua de Prueba", country: "Argentina", email: "sofia@aconcagua-ejemplo.test" })],
  [2, `:warning: *Corrección* — *Carla Ejemplo* (Perú, 955000111) le toca a ${ME_ID}. El aviso anterior salió duplicado; ignorá el otro.`],
].map(([h, text], i) => ({ type: "message", ts: ts(h, i), text, user: "U0SALVA", username: "Salva" }));
export const history = ({ oldest = 0 } = {}) => MSGS.filter(m => Number(m.ts) >= Number(oldest)).sort((a, b) => b.ts.localeCompare(a.ts));
export const userInfo = id => USERS[id] ? { id, real_name: USERS[id].real_name, profile: { real_name: USERS[id].real_name, email: USERS[id].email || undefined } } : null;
