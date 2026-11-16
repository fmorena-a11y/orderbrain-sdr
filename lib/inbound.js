// Inbound desde Slack (pedido del líder de SDR: «abajo de Métricas, algo que si sos SDR tengas tus prospectos ya creados y
// una actividad pendiente de llamada para los inbound / SDR revival. Tomás los datos de Slack»). Reglas puras: leer los
// mensajes del bot del reparto round robin (#round-robin-spam-sdrs), a quién le toca, si el «Colegio» sirve, el título del
// prospecto, la fuente, el día de la llamada, la nota y quién ve qué. Pruebas en test/inbound.test.mjs.
// Lo que lee Slack y escribe en Pipedrive está en lib/inbound-run.js; las rutas, en lib/inbound-api.js.
//
// Formatos (canal privado, los publica «Salva»):
//  A) «:telephone_receiver: *Lead para llamar* — le toca a <@U…|Nombre>» + «_Entró filtrado como …_» opcional + la fuente
//     («:moneybag: Este lead viene de PAUTA en Meta Ads … · campaña: 1202…», «… PAUTA en Google Ads», «:seedling: Este lead es
//     ORGÁNICO …») + «*Teléfono:* … · <https://wa.me/…|WhatsApp>», «*Nombre:*», «*Colegio:*», «*País:*», «*Email:* <mailto:…>»,
//     «*Puesto:*», «*Mensaje:*» (puede seguir en otras líneas) + «_Reparto hasta ahora — …_».
//  B) «:mortar_board: *Referido de padre* — le toca a <@U…|Nombre>  _(prioridad baja)_» + «*Colegio:* Nombre · Ciudad» +
//     «*Quien decide:* Nombre · Rol · +52…» + «*Lead en Pipedrive:* <https://…pipedrive.com/leads/inbox/<uuid>>» + «_Llamalo antes de 72 h…_».
//  Cualquier otro tipo con el mismo «*Tipo* — le toca a <@U…|Nombre>» y «*Clave:* valor» se lee igual. Pegado desde Slack
//  (sin el token) llega sin asteriscos ni <…>: también se lee.
//  SDR revival (regla de la empresa, 4/5/2026: «que un SDR reviva un Lead Inbound de Meta Ads → la fuente en Pipedrive pasa a
//  ser Inbound - SDR Meta Ads Revival»): todo «Lead para llamar» de Meta Ads del reparto se trabaja como SDR revival
//  (`asRevival`): kind «revival», título «… (SDR Meta Ads Revival)», asunto «Llamar · SDR revival Meta Ads · …» y Fuente 786.
//  Google Ads, orgánico y referido quedan como están.
//  Las correcciones del reparto («:warning: *Corrección* — …») no son leads: van como aviso.
import crypto from "crypto";
import { MARKETS, CLIENT_PIPES, DEAD_STAGES } from "./config.js";
import { replyOf } from "./timeline.js";
import { cleanCell, normPhone, pdLink } from "./import.js";

export const norm = s => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const squash = s => String(s ?? "").replace(/[ \s]+/g, " ").trim();
export const DAYS_BACK = 30, DEADLINE_H = 72;

// ---------- texto de Slack → texto plano (los links se sacan antes: wa.me y el de Pipedrive)
export function unslack(s) {
  return String(s ?? "")
    .replace(/<mailto:([^|>]+)\|([^>]+)>/g, "$2").replace(/<mailto:([^>]+)>/g, "$1")
    .replace(/<tel:([^|>]+)\|([^>]+)>/g, "$2")
    .replace(/<@([A-Z0-9]+)\|([^>]+)>/g, "@$2").replace(/<@([A-Z0-9]+)>/g, "@$1")
    .replace(/<#([A-Z0-9]+)\|([^>]*)>/g, "#$2")
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2").replace(/<(https?:[^>]+)>/g, "$1")
    .replace(/:[a-z0-9_+'-]+:/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}
const val = v => { const t = cleanCell(String(v ?? "").replace(/^[*_\s]+|[*_\s]+$/g, "")); return /^[—–\-.·\s]*$/.test(t) ? "" : t; };

// ---------- claves de los campos
const KEYS = { telefono: "phone", tel: "phone", celular: "phone", whatsapp: "phone", nombre: "name", colegio: "school", institucion: "school", escuela: "school",
  pais: "country", email: "email", mail: "email", correo: "email", puesto: "role", cargo: "role", mensaje: "message", "quien decide": "decider", decisor: "decider",
  "lead en pipedrive": "pd", "prospecto en pipedrive": "pd", pipedrive: "pd", ciudad: "city", campana: "campaign", fuente: "sourceText" };
const FIELD_LINE = /^\s*\*?\s*([A-Za-zÁÉÍÓÚÜáéíóúüÑñ ]{2,28}?)\s*:\s*\*?\s*(.*)$/;

// ---------- países: el escrito («México», «Mexico», «Perú»…) o el del prefijo del teléfono internacional
const COUNTRY = new Map(Object.entries(MARKETS).flatMap(([n, m]) => [[norm(n), n], [String(m.code).toLowerCase(), n]]));
export const countryOf = t => COUNTRY.get(norm(t)) || "";
export function countryOfPhone(raw) {
  const t = String(raw || "").trim(); if (!/^(\+|00)/.test(t)) return "";
  const d = t.replace(/\D/g, "").replace(/^00/, "");
  const hits = Object.entries(MARKETS).filter(([, m]) => m.prefix && m.prefix !== "1" && d.startsWith(m.prefix)), n = Math.max(0, ...hits.map(([, m]) => m.prefix.length));
  const best = hits.filter(([, m]) => m.prefix.length === n);
  return best.length === 1 ? best[0][0] : "";
}

// ---------- tipo y fuente
export const KIND_LABEL = { call: "Lead para llamar", referral: "Referido de padre", revival: "SDR revival · Meta Ads", other: "Inbound" };
export const SOURCE_LABEL = { meta: "Meta Ads", google: "Google Ads", organic: "orgánico", referral: "referido de padre", revival: "SDR revival", "": "" };
const kindOf = raw => /revival/i.test(raw) ? "revival" : /referid/i.test(raw) ? "referral" : /lead para llamar|para llamar/i.test(raw) ? "call" : "other";
export function sourceOf(text, kind) {
  const n = norm(text);
  if (kind === "referral") return "referral";
  if (/meta ads|facebook|instagram/.test(n)) return "meta";
  if (kind === "revival" || /\brevival\b/.test(n)) return "revival";
  if (/google ads|google/.test(n)) return "google";
  if (/organico|sin utm/.test(n)) return "organic";
  return "";
}
// Un «Lead para llamar» de Meta Ads es un SDR revival (la regla de la empresa: ver arriba). También para lo pegado y guardado
// antes de esta regla. baseKind: el tipo del mensaje (la clave de lo pegado no cambia).
export function asRevival(p) {
  if (!p) return p;
  const baseKind = p.baseKind || p.kind;
  if (p.kind === "revival") return { ...p, baseKind, kindLabel: KIND_LABEL.revival };
  if (p.kind !== "call" || p.source !== "meta") return p.baseKind ? p : { ...p, baseKind };
  return { ...p, kind: "revival", baseKind, kindLabel: KIND_LABEL.revival };
}

// Un mensaje del canal → el lead (o null si no es un lead: charla, entradas al canal, correcciones). ts: el del mensaje de
// Slack (o la clave de lo pegado). Lo que no se puede leer queda vacío; nunca se inventa.
export function parseInbound(text, { ts = "", channel = "" } = {}) {
  const raw = String(text ?? "");
  const lines = raw.split(/\r?\n/);
  const head = lines.find(l => /le\s+toca\s+a/i.test(l));
  if (!head || /correcci[oó]n/i.test(head)) return null;
  const m = head.match(/le\s+toca\s+a\s*(?:<@([A-Z0-9]+)(?:\|([^>]+))?>|@?\s*([^\n_(*<>@]+?))\s*(?:_|\(|\*|$)/i);
  const to = { slackId: m?.[1] || "", name: squash(m?.[2] || m?.[3] || "") };
  const kindRaw = squash(unslack(head.split(/le\s+toca\s+a/i)[0]).replace(/[*_]/g, "").replace(/[—–-]\s*$/, "").replace(/^[^\p{L}\d]+/u, ""));
  const kind = kindOf(kindRaw);
  const prio = (head.match(/\(prioridad\s+([^)]+)\)/i)?.[1] || "").trim();
  const wa = raw.match(/wa\.me\/(\d{6,15})/)?.[1] || "";
  const link = pdLink(raw.match(/https?:\/\/[a-z0-9-]+\.pipedrive\.com\/[^\s|>]+/i)?.[0] || "");
  // campos «*Clave:* valor»; el mensaje puede seguir en las líneas de abajo (hasta la línea en cursiva del reparto)
  const f = {}; let last = "", filter = "", sourceLine = "";
  for (const line of lines) {
    if (line === head) continue;
    const plain = unslack(line).trim();
    if (!plain) { last = ""; continue; }
    if (/^_.*_$/.test(line.trim()) || /^_/.test(line.trim())) {
      if (/entr[oó] filtrad/i.test(plain)) filter = squash(plain.replace(/^_|_$/g, ""));
      last = ""; continue;
    }
    if (/este lead (viene|es)/i.test(plain)) { sourceLine = squash(plain); last = ""; continue; }
    // pegado (sin las cursivas): el filtro y el pie del reparto
    if (/^entr[oó] filtrad/i.test(plain)) { filter = squash(plain); last = ""; continue; }
    if (/^(reparto (hasta ahora|del piloto)|llamalo antes)/i.test(plain)) { last = ""; continue; }
    const fm = line.match(FIELD_LINE);
    const k = fm && KEYS[norm(fm[1])];
    if (k) { f[k] = { raw: fm[2], text: unslack(fm[2]) }; last = k; continue; }
    if (last === "message") f.message.text += "\n" + plain;
  }
  const get = k => val(f[k]?.text || "");
  // teléfono: lo de antes del «·» (después va el link de WhatsApp); si no hay, el número de wa.me
  let phone = val(String(f.phone?.text || "").split(/\s+[·|]\s+/)[0]).replace(/\s*WhatsApp\s*$/i, "").trim();
  let school = get("school"), city = get("city"), name = get("name"), role = get("role");
  if (school.includes("·")) { const [a, ...b] = school.split("·").map(x => x.trim()); school = val(a); city ||= val(b.join(" ")); }
  // B: «Quien decide: Nombre · Rol · +52…»
  if (f.decider) {
    const parts = String(f.decider.text).split("·").map(x => val(x)).filter(Boolean);
    const ph = parts.find(x => /^\+?[\d\s()\-.]{7,}$/.test(x));
    const rest = parts.filter(x => x !== ph);
    name ||= rest[0] || ""; role ||= rest[1] || ""; phone ||= ph || "";
  }
  if (!phone && wa) phone = wa;
  phone = phone.replace(/^[A-Za-z]{1,3}(?=\+?\d)/, ""); // «MX4433508784»
  const email = (get("email").toLowerCase().match(/[^\s@<>(),;:|]+@[^\s@<>(),;:|]+\.[a-z]{2,}/) || [""])[0];
  const msgRaw = String(f.message?.text || "").split("\n").map(squash).filter(Boolean).join("\n");
  const message = val(msgRaw) ? msgRaw.slice(0, 2000) : "";
  const fields = { phone, name, school, city, email, role, message, pd: link };
  // sin ningún dato de contacto ni prospecto: no es un lead (una charla que dice «le toca a»)
  if (!phone && !email && !link && !school && !name) return null;
  const written = get("country"), country = countryOf(written) || countryOfPhone(phone) || (wa ? countryOfPhone("+" + wa) : "");
  const src = sourceOf(`${sourceLine} ${get("sourceText")}`, kind);
  const campaign = (sourceLine.match(/campa[ñn]a:?\s*([\w-]+)/i)?.[1] || get("campaign") || "").slice(0, 40);
  return asRevival({ ts: String(ts), channel, kind, kindLabel: kind === "other" ? (kindRaw || KIND_LABEL.other).slice(0, 60) : KIND_LABEL[kind], to, priority: prio,
    filter, reentry: /re-?entrada|ya la tiene/i.test(filter), source: src, sourceLabel: SOURCE_LABEL[src] || "", sourceLine, campaign,
    ...fields, countryWritten: written, country, phoneE164: normPhone(phone, country) || "" });
}

// ---------- varios mensajes pegados (copiados de Slack): se cortan en cada «… le toca a …» y cada uno se lee. Lo que no
// dice a quién le toca es de quien lo pega (to vacío). La clave es el contenido: pegar lo mismo dos veces es lo mismo.
export function splitPasted(text) {
  const t = String(text ?? "").replace(/\r/g, "").slice(0, 60000);
  const lines = t.split("\n"), out = []; let cur = [];
  const isHead = l => /le\s+toca\s+a/i.test(l) && !/correcci[oó]n/i.test(l);
  for (const l of lines) { if (isHead(l) && cur.some(x => x.trim())) { out.push(cur.join("\n")); cur = []; } cur.push(l); }
  if (cur.some(x => x.trim())) out.push(cur.join("\n"));
  return out.map(chunk => {
    const body = /le\s+toca\s+a/i.test(chunk) ? chunk : `*Lead para llamar* — le toca a @\n${chunk}`;
    const p = parseInbound(body, {});
    if (!p) return null;
    const key = "p" + crypto.createHash("sha1").update([p.baseKind || p.kind, p.to.name, p.phoneE164 || p.phone, p.email, norm(p.name), norm(p.school), p.pd?.id || ""].join("|")).digest("hex").slice(0, 16);
    return { ...p, ts: key, pasted: true };
  }).filter(Boolean);
}
// Corrección del reparto: un aviso para quienes nombra (no es un lead)
export const isCorrection = text => /correcci[oó]n/i.test(String(text ?? "").split("\n").find(l => l.trim()) || "");

// ---------- el «Colegio» que escribió la persona: ¿sirve como nombre?
// empty: vacío, «—», «S/n», «Xxxx», «Prefiero no decirlo»; generic: solo palabras comunes («Colegio», «Privado», «Casa»);
// number: solo números o un código («3080», «48222982», «AJY39»); city: un lugar («Lima»); weak: empieza con un número y no
// dice qué es («21 de José c paz»). ok: lo demás (se usa en el título y para buscar en Pipedrive).
const GENERIC = new Set(("colegio colegios escuela escuelas institucion instituto institucional privado privada privadas publico publica particular casa negocio negocios " +
  "independiente autonomo autonoma diversos varios varias empresa emprendimiento comedor cafeteria cafetin kiosco kiosko gastro te si no otro otros familia padre madre " +
  "hogar trabajo ninguno ninguna nada prueba test sn na xx xxx xxxx xxxxx none").split(" "));
const SCHOOL_WORD = /\b(colegio|escuela|esc|instituto|inst|liceo|ie|i e|cens|bachi|bachillerato|tecnica|secundaria|primaria|jardin|preescolar|kinder|academia|centro|complejo|normal|prepa|preparatoria|cbtis|conalep|cobach|uni|universidad)\b/;
export function schoolQuality(text, { places = null } = {}) {
  const t = val(text), n = norm(t);
  if (!n || /^(s ?n|n ?a|x+|prefiero no( decirlo)?.*|no se|no tengo|ninguno|ninguna)$/.test(n)) return "empty";
  const w = n.split(" ");
  if (!/[a-z]/.test(n) || (w.length === 1 && /\d/.test(n) && n.length <= 8)) return "number";
  if (w.every(x => GENERIC.has(x))) return "generic";
  if (COUNTRY.has(n) || (places && w.every(x => places.has(x) || ["de", "del", "la", "el", "los", "las", "san", "santa"].includes(x)) && !SCHOOL_WORD.test(n))) return "city";
  if (/^\d/.test(n) && !SCHOOL_WORD.test(n)) return "weak";
  return "ok";
}
// Mayúsculas de lo que se escribió todo en minúscula («21 de José c paz» → «21 de José C. Paz»)
const SMALL = new Set(["de", "del", "la", "las", "los", "el", "y", "e", "en", "a", "o", "u"]);
export function titleCase(s) {
  const words = squash(s).split(" ");
  return words.map((w, i) => {
    if (!w || /\d/.test(w) || /[A-ZÁÉÍÓÚÑ]/.test(w)) return w;
    if (i > 0 && SMALL.has(w) && (w.length > 1 || ((words[i - 1] || "").length > 1 && (words[i + 1] || "").length > 1))) return w;
    if (w.length === 1 && /\p{L}/u.test(w)) return w.toUpperCase() + ".";
    return w.replace(/\p{L}/u, c => c.toUpperCase());
  }).join(" ");
}
// Nombre de la persona: lo escrito (sin links ni dominios); si no sirve, vacío
export const personOk = n => { const t = val(n); return t && /\p{L}{2}/u.test(t) && !/https?:|www\.|\.(com|net|org)\b|^@/i.test(t) ? t.slice(0, 80) : ""; };

// ---------- título del prospecto: «<Colegio> (Inbound Google Ads)», «(SDR Meta Ads Revival)»; con un «Colegio» que no sirve, la persona primero:
// «Natanael – 21 de José C. Paz (SDR Meta Ads Revival)» (sin el «Colegio» si está vacío o es solo una palabra común)
export const TAG = { meta: "Inbound Meta Ads", google: "Inbound Google Ads", organic: "Inbound orgánico", referral: "Referido de padre", revival: "SDR Meta Ads Revival", "": "Inbound" };
export function leadTitleFor(p, { places = null } = {}) {
  const q = schoolQuality(p.school, { places }), school = titleCase(val(p.school)), person = titleCase(personOk(p.name));
  const tag = p.kind === "referral" ? TAG.referral : p.kind === "revival" ? TAG.revival : TAG[p.source] || TAG[""];
  let base;
  if (q === "ok") base = school;
  else if (q === "empty" || q === "generic") base = person || school || p.phoneE164 || p.phone || "Sin nombre";
  else base = person ? `${person} – ${school}` : school;
  base = base.slice(0, 200).trim();
  return `${base} (${tag})`;
}
// Lo que se busca en Pipedrive antes de crear: el colegio (si sirve), su ciudad, el país, teléfono y mail
export function lookupOf(p, { places = null } = {}) {
  const ok = schoolQuality(p.school, { places }) === "ok";
  return { name: ok ? val(p.school) : "", city: p.kind === "referral" || ok ? val(p.city) : "", country: p.country || "",
    phone: p.phoneE164 || p.phone || "", phones: [...new Set([p.phoneE164, p.phone].filter(Boolean))], email: p.email || "", emails: p.email ? [p.email] : [] };
}

// ---------- a quién le toca
// Slack «Facu Morena» = Pipedrive «Facundo Morena»: mismo apellido y el nombre igual, abreviado (las primeras 3 letras o
// más) o un apodo conocido. Con dos palabras en cada lado: la última es el apellido.
const NICK = { facu: "facundo", joaco: "joaquin", belu: "belen", agus: "agustin", santi: "santiago", mati: "matias", fer: "fernando", fede: "federico", nico: "nicolas",
  juanma: "juan manuel", lu: "lucia", flor: "florencia", vale: "valentina", cami: "camila", caro: "carolina", sofi: "sofia", guille: "guillermo", maxi: "maximiliano",
  seba: "sebastian", gabi: "gabriela", pato: "patricio", rodri: "rodrigo", coco: "jorge", fran: "francisco", tomi: "tomas", nacho: "ignacio", pepe: "jose", paco: "francisco", lucho: "luis" };
export function sameName(slackName, fullName) {
  const a = norm(slackName).split(" ").filter(Boolean), b = norm(fullName).split(" ").filter(Boolean);
  if (!a.length || !b.length) return false;
  if (a.join(" ") === b.join(" ")) return true;
  if (a.length < 2 || b.length < 2) return false;
  if (a.at(-1) !== b.at(-1) && !b.includes(a.at(-1)) && !a.includes(b.at(-1))) return false;
  const x = a[0], y = b[0];
  return x === y || (x.length >= 3 && y.startsWith(x)) || (y.length >= 3 && x.startsWith(y)) || (NICK[x] || "").split(" ")[0] === y || (NICK[y] || "").split(" ")[0] === x;
}
// to: { slackId, name } del mensaje. ctx: { prefs: { email: { id, name } } («Tu usuario de Slack», manda), slackEmails:
// Map(slackId → email) (users.info, con token), people: [{ email, names: [...] }] (perfil y Pipedrive) }.
// → { email, how: pref|slack|name } o { email: "", how: "" } (no se sabe: lo ve dirección).
export function assignee(to, { prefs = {}, slackEmails = new Map(), people = [], me = "" } = {}) {
  const lc = e => String(e || "").trim().toLowerCase();
  if (!to?.slackId && !to?.name) return { email: lc(me), how: "paste" };
  for (const [email, p] of Object.entries(prefs || {})) {
    if (!p) continue;
    if ((p.id && to.slackId && p.id === to.slackId) || (p.name && to.name && norm(p.name) === norm(to.name))) return { email: lc(email), how: "pref" };
  }
  const se = to.slackId && slackEmails.get(to.slackId);
  if (se) return { email: lc(se), how: "slack" };
  if (to.name) {
    const hits = people.filter(x => x.email && !(prefs?.[lc(x.email)]?.name || prefs?.[lc(x.email)]?.id) && x.names.some(n => sameName(to.name, n)));
    const uniq = [...new Set(hits.map(x => lc(x.email)))];
    if (uniq.length === 1) return { email: uniq[0], how: "name" };
  }
  return { email: "", how: "" };
}

// ---------- quién ve qué: cada uno lo suyo; un líder de equipo, lo de su gente; dirección y los fijos (scope true), todo
// (también lo que no se sabe de quién es). canLead: la de lib/teams.js.
export function visible(item, me, scope, canLead) {
  const e = String(item.email || "").toLowerCase();
  if (e && e === String(me || "").toLowerCase()) return true;
  if (scope === true) return true;
  return !!e && canLead(scope, { email: e });
}

// ---------- tiempos
export const atOf = ts => { const n = Number(String(ts).split(".")[0]); return Number.isFinite(n) && n > 1e9 ? new Date(n * 1000).toISOString() : null; };
// horas que quedan de las 72 (negativo: ya pasaron)
export const hoursLeft = (at, now = Date.now()) => at ? Math.round(DEADLINE_H - (now - Date.parse(at)) / 3600e3) : null;
const localParts = (at, tz) => { const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", weekday: "short" }).formatToParts(new Date(at)).map(x => [x.type, x.value])); return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), wd: p.weekday }; };
const nextBiz = d => { const x = new Date(d + "T12:00:00Z"); do x.setUTCDate(x.getUTCDate() + 1); while ([0, 6].includes(x.getUTCDay())); return x.toISOString().slice(0, 10); };
const isBiz = d => ![0, 6].includes(new Date(d + "T12:00:00Z").getUTCDay());
// Día de la llamada (en la zona de quien la hace): hoy si el lead entró en horario (L a V, de 8 a 18); si entró de noche o
// el fin de semana, el próximo día hábil. Nunca antes de hoy (si se procesa tarde, hoy).
export function callDay(at, tz, now = Date.now()) {
  const today = localParts(now, tz).date;
  let d = today;
  if (at) {
    const e = localParts(at, tz);
    d = isBiz(e.date) && e.hour >= 8 && e.hour < 18 ? e.date : e.hour < 8 && isBiz(e.date) ? e.date : nextBiz(e.date);
  }
  if (d < today) d = today;
  // hoy, pero ya es de noche o fin de semana: el próximo día hábil
  const n = localParts(now, tz);
  if (d === today && (!isBiz(today) || n.hour >= 18)) d = nextBiz(today);
  return d;
}

// ---------- lo que va en Pipedrive
export const subjectFor = p => `Llamar · ${p.kind === "referral" ? "referido de padre" : p.kind === "revival" ? "SDR revival Meta Ads" : `inbound${p.sourceLabel ? " " + p.sourceLabel : ""}`} · ${personOk(p.name) || p.phoneE164 || p.phone || "sin nombre"}`.slice(0, 140);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export function noteHtml(p, { by = "", permalink = "" } = {}) {
  const row = (k, v) => v ? `<b>${k}:</b> ${esc(v)}` : "";
  const rows = [
    row("Tipo", p.kindLabel + (p.priority ? ` (prioridad ${p.priority})` : "")),
    row("Fuente", [p.sourceLabel, p.campaign && `campaña ${p.campaign}`].filter(Boolean).join(" · ") || p.sourceLine),
    p.filter ? `<i>${esc(p.filter)}</i>` : "",
    row("Nombre", p.name), row("Puesto", p.role), row("Colegio", [p.school, p.city].filter(Boolean).join(" · ")), row("País", p.country || p.countryWritten),
    row("Teléfono", p.phoneE164 || p.phone), row("Email", p.email),
    p.message ? `<b>Mensaje:</b><br>${esc(p.message).replace(/\n/g, "<br>")}` : "",
    permalink ? `<a href="${esc(permalink)}">Mensaje en Slack</a>` : p.pasted ? "Pegado desde Slack" : "",
  ].filter(Boolean);
  return `<b>Inbound desde Slack · OrderBrain SDR</b>${by ? ` · ${esc(by)}` : ""}<br>${rows.join("<br>")}`;
}
// Dónde quedó un lead procesado, para abrir su ficha y leer su historial: { kind: lead|deal|org, id, orgId }. Del estado guardado
// (kind e id; el prospecto de un «partial») o, si no, del link de Pipedrive que se guardó (lo de otra persona, un cliente).
export function targetOf(st) {
  if (!st) return null;
  if (st.id && (st.kind === "lead" || st.kind === "deal")) return { kind: st.kind, id: st.kind === "deal" ? Number(st.id) : String(st.id), orgId: st.orgId ? Number(st.orgId) : null };
  if (st.leadId) return { kind: "lead", id: String(st.leadId), orgId: null };
  const u = String(st.url || "");
  let m = /\/leads\/inbox\/([0-9a-f-]{8,})/i.exec(u); if (m) return { kind: "lead", id: m[1], orgId: null };
  m = /\/deal\/(\d+)/.exec(u); if (m) return { kind: "deal", id: Number(m[1]), orgId: null };
  m = /\/organization\/(\d+)/.exec(u); if (m) return { kind: "org", id: Number(m[1]), orgId: null };
  return null;
}
// ---------- en qué está cada lead (pedido del líder de SDR: «ya contactados, los que se sacaron demo, los que no, demo agendada,
// posible demo, archivado, no fit, no quiere, equivocado… o los que tienen actividades pendientes para que haga yo (no un
// account), o prospecto en trato, como para separar y entender cuáles son más importantes»). Solo con lo que está en Pipedrive
// y la app; si no se pudo leer, «Sin datos». Prioridad: demo agendada > en trato > descartado > posible demo > contactado sin
// respuesta > sin contactar; aparte, sin mezclar, de otra persona, cliente, para revisar y sin procesar. rank: el orden por
// importancia de la lista (0 = una pendiente tuya vencida va primero).
// lead: { state } (stateView). info: { items (línea de tiempo de sus actividades hechas y notas), pending (actividades sin
// hacer, crudas), lead (el prospecto: { archived, addTime } o null si se borró), deals (crudos: los del prospecto convertido,
// su organización o su persona), ownerId (el usuario de Pipedrive de quien le tocó), today (en su zona), users { id: nombre },
// stages { id: nombre } } o null (no se pudo leer).
export const STAGES = { pend: "Pendiente tuya", new: "Sin contactar", noreply: "Contactado sin respuesta", maybe: "Posible demo", demo: "Demo agendada", deal: "En trato", out: "Descartado",
  theirs: "De otra persona", client: "Cliente", review: "Para revisar", todo: "Sin procesar", unknown: "Sin datos" };
const RANK = { todo: 1, review: 1, maybe: 2, new: 3, noreply: 4, demo: 5, deal: 6, out: 7, unknown: 8, theirs: 9, client: 10 };
// los resultados de Registrar que dicen que no (lib/playbook.js): descartan aunque el prospecto siga abierto
const NEG = new Set(["not_now", "not_interested", "bad_data"]);
const salesOpen = d => d.status === "open" && !CLIENT_PIPES.includes(Number(d.pipeline_id)) && !DEAD_STAGES.includes(Number(d.stage_id));
const ownerOfAct = a => Number(a.owner_id ?? a.user_id) || null;
export function inboundStage(lead, info) {
  const s = lead?.state, mk = (key, x = {}) => ({ key, label: STAGES[key], rank: RANK[key], detail: "", ...x });
  if (!s || s.status === "error" && !s.ref) return mk("todo", { detail: s ? "no se pudo terminar" : "" });
  if (s.status === "review") return mk("review", { detail: "¿es alguno de los que ya están?" });
  if (s.status === "theirs") return mk("theirs", { detail: s.owner ? `de ${s.owner}` : "" });
  if (s.status === "client") return mk("client", { detail: "no contactar" });
  if (!info) return mk("unknown");
  const { items = [], pending = [], deals = [], ownerId = null, today = "", users = {}, stages = {} } = info;
  const uname = id => users[Number(id)] || "";
  // lo pendiente a nombre de quien le tocó (no del account): la más cercana; vencida si es de antes de hoy
  const minePend = pending.filter(a => !a.done && !a.is_deleted && ownerId && ownerOfAct(a) === Number(ownerId)).sort((a, b) => `${a.due_date}${a.due_time || "99"}`.localeCompare(`${b.due_date}${b.due_time || "99"}`))[0];
  const mine = minePend ? { date: minePend.due_date || "", time: String(minePend.due_time || "").slice(0, 5), late: !!minePend.due_date && !!today && minePend.due_date < today, subject: minePend.subject || "", type: minePend.type || "" } : null;
  const out = (key, x = {}) => { const r = mk(key, x); if (mine) r.mine = mine; if (mine?.late) r.rank = 0; return r; };
  if (deals.some(d => d.status === "won" || (d.status === "open" && CLIENT_PIPES.includes(Number(d.pipeline_id)) && !DEAD_STAGES.includes(Number(d.stage_id)))))
    return mk("client", { detail: "trato ganado" });
  // demo agendada: una demo (meeting) sin hacer de hoy en adelante, en el prospecto o en su trato abierto
  const demo = pending.filter(a => !a.done && !a.is_deleted && a.type === "meeting" && (!today || String(a.due_date || "") >= today)).sort((a, b) => `${a.due_date}${a.due_time || ""}`.localeCompare(`${b.due_date}${b.due_time || ""}`))[0];
  const open = deals.filter(salesOpen).sort((a, b) => String(b.update_time || b.add_time || "").localeCompare(String(a.update_time || a.add_time || "")))[0];
  const whose = id => !id ? "" : Number(id) === Number(ownerId) ? "tuyo" : uname(id) ? `de ${uname(id)}` : "de otra persona";
  if (demo) return out("demo", { detail: [demo.due_date, whose(ownerOfAct(demo)) === "tuyo" ? "" : uname(ownerOfAct(demo)) && `con ${uname(ownerOfAct(demo))}`].filter(Boolean).join(" · "), date: demo.due_date || "", time: String(demo.due_time || "").slice(0, 5) });
  if (open) return out("deal", { detail: [`trato ${whose(open.owner_id ?? open.user_id)}`, stages[open.stage_id]].filter(Boolean).join(" · ") });
  const contacts = items.filter(x => !x.aside && (x.kind === "act" || x.kind === "contact" || x.kind === "mail")).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const reps = contacts.map(it => ({ it, r: replyOf(it), outcome: it.kind === "contact" ? it.outcome : "" }));
  // el motivo: el que se anotó al registrar («Motivo: …»), el resultado que dijo que no o el motivo de pérdida del trato
  const motive = () => { for (const it of contacts) { const m = (it.rows || []).find(([k]) => /^motivo$/i.test(k)); if (m) return m[1]; } const n = reps.find(x => x.r.answered != null); return n && NEG.has(outOf(n)) ? n.r.result : ""; };
  const lost = deals.filter(d => d.status === "lost").sort((a, b) => String(b.lost_time || b.update_time || "").localeCompare(String(a.lost_time || a.update_time || "")))[0];
  if (info.lead?.archived || lost) {
    // archivado porque pasó a trato (y el trato no se pudo leer): no es un descarte
    if (info.lead?.archived && !lost && items.some(x => x.kind === "note" && /^Pasó a trato\b/.test(x.title || ""))) return out("deal", { detail: "pasó a trato" });
    const why = (lost?.lost_reason && String(lost.lost_reason).replace(/\s+/g, " ").trim()) || motive();
    return out("out", { detail: why || (lost ? "trato perdido sin motivo" : "Archivado sin motivo"), reason: why || "" });
  }
  const lastKnown = reps.find(x => x.r.answered != null);
  if (lastKnown && NEG.has(outOf(lastKnown))) return out("out", { detail: motive() || lastKnown.r.result, reason: motive() || lastKnown.r.result });
  const yes = reps.find(x => x.r.answered === true);
  if (yes) return out("maybe", { detail: [yes.r.result, CH_WORD[yes.r.channel]].filter(Boolean).join(" · ").toLowerCase(), at: yes.it.at });
  if (contacts.length) return out("noreply", { detail: `${contacts.length} ${contacts.length === 1 ? "contacto" : "contactos"}`, at: contacts[0].at });
  return out("new");
}
const CH_WORD = { call: "por llamada", whatsapp: "por WhatsApp", mail: "por mail", visit: "en visita", demo: "en demo" };
// el resultado de Registrar de una entrada (el del contacto o el del asunto «Llamada: No le interesa · …»)
const outOf = x => x.outcome || x.r.outcome || "";
// Lo que se muestra de un mensaje (sin el texto crudo)
export const lite = p => ({ ts: p.ts, kind: p.kind, kindLabel: p.kindLabel, priority: p.priority, filter: p.filter, reentry: p.reentry, source: p.source, sourceLabel: p.sourceLabel, campaign: p.campaign,
  name: p.name, role: p.role, school: p.school, city: p.city, country: p.country || p.countryWritten, phone: p.phoneE164 || p.phone, email: p.email, message: String(p.message || "").slice(0, 1200),
  pd: p.pd ? { kind: p.pd.kind, id: p.pd.id, url: p.pd.url } : null, to: p.to, pasted: !!p.pasted });
