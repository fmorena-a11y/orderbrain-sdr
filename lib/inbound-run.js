// Tus inbound: lee el canal del reparto round robin en Slack (o lo que se pegó), arma la lista de cada persona y, por cada
// lead suyo que todavía no se procesó, deja en Pipedrive el prospecto a su nombre y UNA llamada pendiente (lib/inbound.js
// tiene las reglas puras; las rutas, lib/inbound-api.js).
//
// Antes de crear, las reglas de «Antes de crear» (sales.investigate + existing.decide, por teléfono, mail y el nombre del
// colegio si sirve): lo tuyo o libre se usa (lo libre pasa a tu nombre), lo de otra persona y los clientes no se tocan (se
// avisa), lo dudoso queda «para revisar» (Es este / Es otro). Un «Lead en Pipedrive» (referidos) se usa directo.
// Idempotente por la clave del mensaje (el ts de Slack o la del texto pegado): el estado se guarda en lib/store.js
// (personStore("inbound")) y nada corre dos veces a la vez (candado por clave). Nunca se procesa para otra persona sin pedirlo
// («Crear a nombre de X», solo su líder o dirección).
//
// Slack: SLACK_BOT_TOKEN (scopes channels:history, groups:history —el canal es privado—, users:read y users:read.email; el bot
// tiene que estar en el canal) y SLACK_INBOUND_CHANNEL (por defecto C0CC3QWSSHK, #round-robin-spam-sdrs). Sin token, lo pegado.
// En DEMO_MODE sin token, un Slack de prueba (lib/inbound-demo.js). Nada de datos personales en los logs.
import * as pd from "./pipedrive.js";
import * as sales from "./sales.js";
import * as EX from "./existing.js";
import * as I from "./inbound.js";
import * as DEMO from "./inbound-demo.js";
import { personStore, addVirtual, schools, withLock, getProfiles } from "./store.js";
import { DEAL_FIELDS, OPTIONS, FREE_OWNERS } from "./config.js";
import { canLead } from "./teams.js";
import { buildTimeline, lastContact } from "./timeline.js";
import { todayIn, safeTz } from "./time.js";

const env = process.env;
const lc = e => String(e || "").trim().toLowerCase();
const bad = (msg, status = 400, code = "") => Object.assign(new Error(msg), { status, ...(code ? { code } : {}) });
const TOKEN = () => env.SLACK_BOT_TOKEN || "";
const API = () => (env.SLACK_API_URL || "https://slack.com/api").replace(/\/$/, "");
export const CHANNEL = () => env.SLACK_INBOUND_CHANNEL || "C0CC3QWSSHK";
export const SCOPES = ["channels:history", "groups:history", "users:read", "users:read.email"];
// DEMO_SLACK=0: el demo sin Slack de prueba (para ver la sección como hoy en producción, solo con «Pegá el mensaje»)
const demoSlack = () => pd.DEMO && !TOKEN() && env.DEMO_SLACK !== "0";
export const slackState = () => ({ on: !!TOKEN() || demoSlack(), demo: demoSlack(), channel: CHANNEL(), scopes: SCOPES });

const ST = personStore("inbound"), PM = personStore("inbound_paste"), SP = personStore("slackme");
const FINAL = new Set(["done", "theirs", "client"]);

// ---------- Slack
async function call(method, params = {}) {
  const r = await fetch(`${API()}/${method}?${new URLSearchParams(params)}`, { headers: { authorization: `Bearer ${TOKEN()}` }, signal: AbortSignal.timeout(12000) });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw Object.assign(new Error(`Slack: ${j.error || r.status}`), { slack: j.error || String(r.status) });
  return j;
}
const blockText = b => [b?.text?.text, ...(b?.fields || []).map(f => f.text), ...(b?.elements || []).map(e => e.text || "")].filter(Boolean).join("\n");
const textOf = m => m.text || [...(m.blocks || []).map(blockText), ...(m.attachments || []).map(a => a.text || a.fallback || "")].filter(Boolean).join("\n");
const C = { at: 0, leads: [], notices: [], error: "", inflight: null };
async function readChannel({ refresh = false } = {}) {
  if (!slackState().on) return { leads: [], notices: [], error: "" };
  if (Date.now() - C.at < (refresh ? 15e3 : 90e3)) return C;
  C.inflight ||= (async () => {
    try {
      const oldest = String(Math.floor(Date.now() / 1000) - (I.DAYS_BACK + 1) * 86400);
      let raw = [];
      if (demoSlack()) raw = DEMO.history({ oldest });
      else {
        let cursor = "";
        for (let i = 0; i < 5; i++) {
          const j = await call("conversations.history", { channel: CHANNEL(), oldest, limit: "200", ...(cursor ? { cursor } : {}) });
          raw.push(...(j.messages || []));
          cursor = j.response_metadata?.next_cursor || ""; if (!cursor) break;
        }
      }
      const leads = [], notices = [];
      for (const m of raw) {
        if (m.subtype && m.subtype !== "bot_message") continue; // entradas al canal, ediciones…
        const text = textOf(m); if (!text) continue;
        if (I.isCorrection(text)) { notices.push({ ts: m.ts, at: I.atOf(m.ts), raw: text, text: I.unslack(text).replace(/[*_]/g, "").replace(/\s+\n/g, "\n").trim().replace(/^[^\p{L}]*correcci[oó]n\s*[—–:-]?\s*/iu, "").slice(0, 600) }); continue; }
        const p = I.parseInbound(text, { ts: m.ts, channel: CHANNEL() });
        if (p) leads.push({ key: m.ts, at: I.atOf(m.ts), p, pasted: false });
      }
      Object.assign(C, { leads, notices, error: "", at: Date.now() });
    } catch (e) { C.error = e.slack || e.message; C.at = Date.now() - 60e3; console.warn("Inbound Slack:", C.error); } // reintenta en 30 s
    finally { C.inflight = null; }
  })();
  await C.inflight;
  return C;
}
// (pruebas) volver a leer Slack en el próximo pedido
export const forgetSlack = () => { C.at = 0; UI.clear(); };
// emails de Slack (users.info, con users:read.email): un día; si falla, 10 minutos sin preguntar
const UI = new Map();
async function slackEmails(ids) {
  const out = new Map();
  if (!slackState().on) return out;
  await Promise.all([...new Set(ids.filter(Boolean))].slice(0, 40).map(async id => {
    const c = UI.get(id);
    if (c && Date.now() < c.until) { if (c.email) out.set(id, c.email); return; }
    try {
      const u = demoSlack() ? DEMO.userInfo(id) : (await call("users.info", { user: id })).user;
      const email = lc(u?.profile?.email || "");
      UI.set(id, { email, until: Date.now() + 864e5 }); if (email) out.set(id, email);
    } catch { UI.set(id, { email: "", until: Date.now() + 10 * 60e3 }); }
  }));
  return out;
}
async function permalinkOf(ts) {
  if (!TOKEN() || !/^\d+\.\d+$/.test(String(ts))) return "";
  try { return (await call("chat.getPermalink", { channel: CHANNEL(), message_ts: ts })).permalink || ""; } catch { return ""; }
}

// ---------- quiénes son (para «le toca a»): perfil de la app y usuarios de Pipedrive
async function people() {
  const [profiles, m] = await Promise.all([getProfiles().catch(() => ({})), pd.meta().catch(() => ({ users: [] }))]);
  const by = new Map();
  for (const u of m.users || []) if (u.email && !FREE_OWNERS.has(Number(u.id))) by.set(lc(u.email), { email: lc(u.email), names: [u.name], id: Number(u.id), pdName: u.name });
  for (const [email, p] of Object.entries(profiles || {})) { const x = by.get(lc(email)) || { email: lc(email), names: [] }; if (p?.name) x.names.unshift(p.name); x.profileName = p?.name || ""; by.set(lc(email), x); }
  return [...by.values()];
}
const nameOf = (list, email) => { const x = list.find(p => p.email === lc(email)); return x?.profileName || x?.pdName || ""; };

// ---------- todo lo de los últimos 30 días, con a quién le toca
async function assemble({ refresh = false } = {}) {
  const since = Date.now() - I.DAYS_BACK * 864e5;
  const [ch, pastedAll, prefs, folks] = await Promise.all([readChannel({ refresh }), PM.all().catch(() => ({})), SP.all().catch(() => ({})), people()]);
  const pasted = Object.values(pastedAll || {}).filter(x => x?.p && Date.parse(x.at) >= since).map(x => ({ key: x.key, at: x.at, p: I.asRevival({ ...x.p, ts: x.key, pasted: true }), pasted: true, by: x.by }));
  const fromSlack = ch.leads.filter(x => x.at && Date.parse(x.at) >= since);
  const ids = fromSlack.map(x => x.p.to.slackId);
  const emails = await slackEmails(ids);
  // lo que llegó por Slack y también se pegó: queda el de Slack
  const seen = new Set(fromSlack.map(x => [x.p.phoneE164, x.p.email, x.p.to.name].join("|")));
  const all = [...fromSlack, ...pasted.filter(x => !seen.has([x.p.phoneE164, x.p.email, x.p.to.name].join("|")))].map(x => {
    const a = I.assignee(x.p.to, { prefs, slackEmails: emails, people: folks, me: x.by || "" });
    return { ...x, email: a.email, how: a.how, owner: a.email ? nameOf(folks, a.email) || x.p.to.name : x.p.to.name };
  });
  return { all, ch, prefs, folks };
}
const stateView = st => !st ? null : { status: st.status, kind: st.kind || "", id: st.id || st.leadId || null, url: st.url || "", title: st.title || "", created: !!st.created, owner: st.owner || "",
  callDate: st.callDate || "", callExisting: !!st.callExisting, candidates: st.candidates || [], error: st.error || "", done: (st.done || []).slice(0, 8), warnings: (st.warnings || []).slice(0, 6),
  at: st.at || null, by: st.byName || "", for: st.for || "", ref: I.targetOf(st) };
const needs = st => !st || st.status === "error" || st.status === "partial";
// lo que se sabe sin leer Pipedrive (sin procesar, para revisar, de otra persona, cliente); lo demás llega con /contacts
const quickStage = st => { const v = stateView(st), g = I.inboundStage({ state: v }, null); return g.key === "unknown" ? null : g; };

// Lo que ve quien mira: lo suyo; un líder de equipo, lo de su gente; dirección y los fijos, todo. scope: leadScopeFor.
export async function listFor(user, scope, { refresh = false } = {}) {
  const me = lc(user.email);
  const { all, ch, prefs, folks } = await assemble({ refresh });
  const states = await ST.all().catch(() => ({}));
  const vis = all.filter(x => I.visible(x, me, scope, canLead)).sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const mine = all.filter(x => x.email === me);
  // las correcciones del reparto que te nombran (dirección ve todas)
  const myIds = new Set([prefs[me]?.id, ...mine.map(x => x.p.to.slackId)].filter(Boolean));
  const myNames = [prefs[me]?.name, ...mine.map(x => x.p.to.name)].filter(Boolean);
  const notices = ch.notices.filter(n => Date.now() - Date.parse(n.at) < 7 * 864e5 && (scope === true || [...myIds].some(id => n.raw.includes(id)) || myNames.some(nm => n.text.includes(nm))))
    .map(n => ({ at: n.at, text: n.text })).slice(0, 5);
  return {
    slack: { ...slackState(), error: ch.error || "" },
    me: { email: me, slack: prefs[me] || null, auto: mine[0]?.p.to.name || "", pdUserId: user.pdUserId || null },
    leader: scope !== false, all: scope === true,
    items: vis.map(x => ({ key: x.key, at: x.at, hoursLeft: I.hoursLeft(x.at), ...I.lite(x.p), title: I.leadTitleFor(x.p, { places: placesOf() }),
      assignee: { email: x.email, name: x.owner || "", how: x.how }, mine: x.email === me, state: stateView(states[x.key]), stage: quickStage(states[x.key]) })),
    pending: mine.filter(x => needs(states[x.key])).length,
    // nombres de Slack que aparecen (para elegir «Tu usuario de Slack»)
    names: [...new Map(all.map(x => [x.p.to.name, x.p.to])).values()].filter(t => t.name).map(t => ({ name: t.name, id: t.slackId })).sort((a, b) => a.name.localeCompare(b.name)),
    people: folks.length,
    notices,
  };
}
export async function pendingCount(user) {
  const me = lc(user.email), { all } = await assemble({});
  const states = await ST.all().catch(() => ({}));
  return { pending: all.filter(x => x.email === me && needs(states[x.key])).length, slack: slackState().on };
}

// ---------- «Tu usuario de Slack» (manda sobre el nombre y el email)
export async function slackPrefFor(user) {
  const me = lc(user.email), { all, prefs } = await assemble({});
  const mine = all.find(x => x.email === me);
  return { slack: prefs[me] || null, auto: mine ? { name: mine.p.to.name, how: mine.how } : null, names: [...new Set(all.map(x => x.p.to.name).filter(Boolean))].sort((a, b) => a.localeCompare(b)) };
}
export async function setSlackPref(user, name) {
  const n = String(name ?? "").replace(/\s+/g, " ").trim().slice(0, 80), me = lc(user.email);
  if (!n) { await SP.del(me); return { slack: null }; }
  const { all } = await assemble({});
  const id = all.find(x => I.norm(x.p.to.name) === I.norm(n))?.p.to.slackId || "";
  const rec = await SP.set(me, { name: n, id, at: new Date().toISOString() });
  return { slack: rec };
}

// ---------- pegar mensajes (sin token): se guardan para quien le toca, 30 días
export async function paste(user, text) {
  const list = I.splitPasted(text);
  if (!list.length) throw bad("No encontré ningún lead en lo que pegaste: copiá el mensaje entero de Slack (desde «Lead para llamar» o «Referido de padre» hasta el final).");
  const at = new Date().toISOString(), out = [];
  for (const p of list.slice(0, 30)) {
    const prev = await PM.get(p.ts);
    if (!prev) await PM.set(p.ts, { key: p.ts, at, by: lc(user.email), p });
    out.push({ key: p.ts, name: p.name, school: p.school, kindLabel: p.kindLabel, to: p.to.name, again: !!prev });
  }
  // lo viejo (más de 45 días) se borra
  const all = await PM.all().catch(() => ({}));
  for (const [k, v] of Object.entries(all)) if (!v?.at || Date.now() - Date.parse(v.at) > 45 * 864e5) await PM.del(k).catch(() => {});
  return { added: out.filter(x => !x.again).length, items: out };
}

// ---------- procesar
const placesOf = () => pd.matchCtx(schools).places;
const locks = new Map();
async function mutex(k, fn) {
  while (locks.has(k)) await locks.get(k).catch(() => {});
  const p = fn(); locks.set(k, p);
  try { return await p; } finally { if (locks.get(k) === p) locks.delete(k); }
}
const users = async () => new Map(((await pd.meta().catch(() => ({ users: [] }))).users || []).map(u => [Number(u.id), u.name]));
const whoOf = (U, id) => !id ? "" : FREE_OWNERS.has(Number(id)) ? "Cuenta general" : U.get(Number(id)) || "otra persona";
const leadUrl = id => `${pd.PD_WEB}/leads/inbox/${id}`, dealUrl = id => `${pd.PD_WEB}/deal/${id}`, orgUrl = id => `${pd.PD_WEB}/organization/${id}`;
const theirs = (U, ownerId, title, url) => ({ stop: { status: "theirs", owner: whoOf(U, ownerId), title, url } });
const clientStop = (title, url) => ({ stop: { status: "client", title, url } });
async function orgIsClient(orgId) { const [deals, m] = await Promise.all([pd.dealsForOrg(orgId), pd.meta()]); return { client: pd.classify(deals, m) === "client", deals }; }
// una organización encontrada: cliente (no se toca), trato abierto (tuyo o libre: ahí va la llamada), su prospecto abierto
// (tuyo o libre), o un prospecto nuevo en ella si es tuya o libre
async function resolveOrg(orgId, me, U, done, title = "") {
  const { client, deals } = await orgIsClient(orgId);
  const o = (await pd.orgsByIds([Number(orgId)]))[0];
  const name = o?.name || title || "la organización";
  if (client) return clientStop(name, orgUrl(orgId));
  const d = pd.openSalesDeal(deals);
  if (d) {
    const owner = pd.realOwner(d.owner_id || d.user_id);
    if (owner && owner !== me) return theirs(U, owner, d.title || name, dealUrl(d.id));
    if (!owner) await pd.updateDeal(d.id, { owner_id: me }).then(() => done.push({ label: "El trato pasó a tu nombre (estaba en la cuenta general)", url: dealUrl(d.id) })).catch(() => {});
    return { target: { kind: "deal", id: d.id, title: d.title || name, orgId: Number(orgId), personId: d.person_id || null, url: dealUrl(d.id), created: false } };
  }
  const open = await pd.leadsForOrg(orgId);
  const l = sales.pickContactLead(open, null, me);
  if (l) {
    if (l.ownerId && Number(l.ownerId) !== me) return theirs(U, l.ownerId, l.title || name, leadUrl(l.id));
    if (!l.ownerId) await pd.updateLead(l.id, { owner_id: me }).then(() => done.push({ label: "El prospecto pasó a tu nombre (estaba en la cuenta general)", url: leadUrl(l.id) })).catch(() => {});
    return { target: { kind: "lead", id: l.id, title: l.title || name, orgId: Number(orgId), personId: l.personId || null, url: leadUrl(l.id), created: false } };
  }
  if (open.length) return theirs(U, open.find(x => x.ownerId)?.ownerId, name, orgUrl(orgId));
  if (o?.ownerId && Number(o.ownerId) !== me) return theirs(U, o.ownerId, name, orgUrl(orgId));
  done.push({ label: `Ya estaba en Pipedrive: organización «${name}»`, url: orgUrl(orgId) });
  return { target: { kind: "create", orgId: Number(orgId) } };
}
async function resolveLead(l, me, U, done) {
  if (l.orgId && (await orgIsClient(l.orgId)).client) return clientStop(l.title, leadUrl(l.id));
  if (l.ownerId && Number(l.ownerId) !== me) return theirs(U, l.ownerId, l.title, leadUrl(l.id));
  if (!l.ownerId) await pd.updateLead(l.id, { owner_id: me }).then(() => done.push({ label: "El prospecto pasó a tu nombre (estaba en la cuenta general)", url: leadUrl(l.id) }));
  return { target: { kind: "lead", id: l.id, title: l.title, orgId: l.orgId || null, personId: l.personId || null, url: leadUrl(l.id), created: false } };
}
async function resolveDeal(id, me, U, done) {
  const d = await pd.getDeal(id);
  if (!d || d.is_deleted || d.status === "deleted") return { target: null };
  if (d.status === "won") return clientStop(d.title, dealUrl(d.id));
  if (d.org_id) return resolveOrg(d.org_id, me, U, done, d.title);
  if (d.status === "lost") return { target: null };
  const owner = pd.realOwner(d.owner_id || d.user_id);
  if (owner && owner !== me) return theirs(U, owner, d.title, dealUrl(d.id));
  if (!owner) await pd.updateDeal(d.id, { owner_id: me }).then(() => done.push({ label: "El trato pasó a tu nombre (estaba en la cuenta general)", url: dealUrl(d.id) })).catch(() => {});
  return { target: { kind: "deal", id: d.id, title: d.title, orgId: null, personId: d.person_id || null, url: dealUrl(d.id), created: false } };
}
async function resolvePick(x, me, U, done) {
  if (x.kind === "lead") {
    const l = await pd.getLead(x.id);
    if (!l || l.archived) return { target: null };
    const r = await resolveLead(l, me, U, done);
    if (r.target) done.unshift({ label: `Ya estaba en Pipedrive: prospecto «${l.title}» (${x.why || "coincide"})`, url: leadUrl(l.id) });
    return r;
  }
  if (x.kind === "deal") { const r = await resolveDeal(x.id, me, U, done); if (r.target) done.unshift({ label: `Ya estaba en Pipedrive: trato «${r.target.title}»`, url: r.target.url }); return r; }
  return resolveOrg(x.id, me, U, done, x.title);
}
// lo que dice el link «Lead en Pipedrive» (referidos)
async function fromLink(link, me, U, done, warnings) {
  if (link.kind === "lead") {
    const l = await pd.getLead(link.id);
    if (!l || l.archived) { warnings.push("El prospecto del link ya no está abierto en Pipedrive: lo busqué por teléfono, mail y nombre."); return { target: null }; }
    const r = await resolveLead(l, me, U, done);
    if (r.target) done.unshift({ label: `Prospecto del mensaje: «${l.title}»`, url: leadUrl(l.id) });
    return r;
  }
  if (link.kind === "deal") return resolveDeal(link.id, me, U, done);
  if (link.kind === "organization") return resolveOrg(link.id, me, U, done);
  return { target: null };
}
const DEAL_TXT = { open: "trato abierto", won: "trato ganado", lost: "trato perdido" };
const cand = (x, U) => ({ key: x.key, kind: x.kind, title: x.title, what: x.kind === "lead" ? (x.archived ? "prospecto archivado" : "prospecto") : x.kind === "deal" ? DEAL_TXT[x.status] || "trato" : "organización",
  owner: x.ownerId ? whoOf(U, x.ownerId) : "libre", why: x.why || "", url: x.kind === "lead" ? leadUrl(x.id) : x.kind === "deal" ? dealUrl(x.id) : orgUrl(x.id) });
// «Antes de crear» con lo del mensaje (teléfono, mail y el colegio si sirve)
async function lookup(x, me, U, done, warnings, { pick = null, no = [] } = {}) {
  const look = I.lookupOf(x.p, { places: placesOf() });
  const s = addVirtual({ id: `in-${String(x.key).replace(/[^\w]/g, "")}`, ...look, src: "inbound" });
  const inv = await sales.investigate(s.id, { full: true, force: !pick, me });
  // un prospecto con el mismo teléfono o mail que ya está vinculado a un colegio de la base sigue siendo «el mismo»
  const judged = inv.judged.map(y => y.level === "maybe" && y.contact && y.place !== "other" && /ya está vinculado a/.test(y.why || "") ? { ...y, level: "sure" } : y);
  if (pick) { const y = judged.find(z => z.key === pick); if (!y) throw bad("Eso ya no aparece en Pipedrive.", 404); return resolvePick(y, me, U, done); }
  const r = EX.decide(judged, { no, me });
  for (const y of r.info.slice(0, 2)) warnings.push(`En Pipedrive hay ${y.kind === "lead" ? "un prospecto archivado" : "un trato perdido"} parecido: «${y.title}»${y.ownerId ? ` (de ${whoOf(U, y.ownerId)})` : ""}. Lo dejé como estaba.`);
  if (r.verdict === "maybe") return { stop: { status: "review", candidates: r.maybe.slice(0, 6).map(y => cand(y, U)) } };
  if (r.verdict === "sure") { const out = await resolvePick(r.pick, me, U, done); if (out.target || out.stop) return out; }
  return { target: { kind: "create", orgId: null } };
}
// una persona que ya está con ese teléfono o mail (tuya o libre): se usa en vez de crear otra
async function findPerson(p, me) {
  const look = I.lookupOf(p), c = EX.contactOf(look), items = [];
  if (c.phones[0]) items.push(...((await pd.searchPersonsByPhone(c.phones[0], 10).catch(() => ({ items: [] }))).items || []));
  if (c.emails[0]) items.push(...((await pd.searchItems(c.emails[0], { types: "person", fields: "email", limit: 10 }).catch(() => ({ items: [] }))).items || []));
  const hit = items.map(i => i.item).find(it => it && EX.contactHit(c, { phones: it.phones || [], emails: it.emails || [] }) && (!pd.realOwner(it.owner?.id) || pd.realOwner(it.owner?.id) === me));
  return hit?.id || null;
}
async function fieldsFor(p, owner) {
  const F = DEAL_FIELDS, f = {};
  if (OPTIONS.pais[p.country]) f[F.pais] = OPTIONS.pais[p.country];
  const src = p.kind === "referral" ? "referral" : p.kind === "revival" ? "revival" : p.source, opt = OPTIONS.fuente.inbound?.[src];
  if (opt) f[F.fuente] = String(opt);
  if (owner.pdUserId) f[F.sdr] = owner.pdUserId;
  if (p.phoneE164 || p.phone) f[F.telefono] = p.phoneE164 || p.phone;
  if (p.email) f[F.email] = p.email;
  if (p.city) { const c = await pd.optionFor(F.ciudad, p.city).catch(() => null); if (c) f[F.ciudad] = c; }
  // siempre con dirección (pedido del líder): lo que se sabe del lugar, sin inventar calle
  const addr = sales.addrLine([p.city, p.country || p.countryWritten]); if (addr) f[F.direccion] = addr;
  return f;
}
async function create(x, owner, orgId, done, warnings, savePartial) {
  const p = x.p, me = Number(owner.pdUserId), title = I.leadTitleFor(p, { places: placesOf() });
  let personId = await findPerson(p, me);
  if (personId) done.push({ label: "Usé la persona que ya estaba en Pipedrive con ese teléfono o mail", url: `${pd.PD_WEB}/person/${personId}` });
  else {
    const name = I.titleCase(I.personOk(p.name)) || "Contacto inbound", role = /^otro$/i.test(p.role) ? "" : p.role;
    const per = await pd.addPerson({ name: sales.personLabel(name, role), orgId: orgId || undefined, phone: p.phoneE164 || p.phone || undefined, email: p.email || undefined, ownerId: me }).catch(() => null);
    personId = per?.id || null;
    if (!personId) warnings.push("No pude crear la persona en Pipedrive: el teléfono y el mail quedan en el prospecto.");
  }
  const lead = await pd.createLead({ title, ownerId: me, orgId: orgId || undefined, personId: personId || undefined, fields: await fieldsFor(p, owner) });
  if (!lead?.id) throw bad("Pipedrive no devolvió el prospecto.", 502);
  await savePartial({ status: "partial", leadId: lead.id, personId });
  done.push({ label: `Prospecto creado a tu nombre: «${title}»`, url: leadUrl(lead.id) });
  if (!OPTIONS.pais[p.country]) warnings.push(p.country || p.countryWritten ? `País ${p.country || p.countryWritten}: no está en el campo País de Pipedrive, quedó sin completar.` : "No supe el país: el campo País quedó sin completar.");
  const permalink = x.pasted ? "" : await permalinkOf(x.key);
  await pd.addNote({ content: I.noteHtml(p, { by: sales.signer(owner), permalink }), leadId: lead.id, personId: personId || undefined, orgId: orgId || undefined })
    .catch(() => pd.addNote({ content: I.noteHtml(p, { by: sales.signer(owner), permalink }), leadId: lead.id })).catch(() => warnings.push("No pude dejar la nota con el mensaje de Slack."));
  return { kind: "lead", id: lead.id, title, orgId: orgId || null, personId, url: leadUrl(lead.id), created: true };
}
// SDR revival con un prospecto que ya estaba (tuyo o de la cuenta general): su Fuente pasa a «Inbound - SDR Meta Ads Revival»
// si estaba vacía o era «Inbound - Meta Ads». Otra fuente no se pisa; de otra persona no se toca.
async function revivalFuente(t, x, me, done, warnings) {
  if (x.p.kind !== "revival" || t.kind !== "lead" || t.created) return;
  const F = DEAL_FIELDS.fuente, rv = OPTIONS.fuente.inbound?.revival, meta = OPTIONS.fuente.inbound?.meta;
  if (!F || !rv) return;
  const l = await pd.getLead(t.id).catch(() => null);
  if (!l || (l.ownerId && Number(l.ownerId) !== me)) return;
  const cur = l.fuenteOpt == null || l.fuenteOpt === "" ? "" : String(l.fuenteOpt);
  if (cur === String(rv)) return;
  if (cur && cur !== String(meta)) { warnings.push("El prospecto ya tenía otra Fuente en Pipedrive: la dejé como estaba."); return; }
  await pd.updateLead(t.id, { [F]: String(rv) })
    .then(() => done.push({ label: "Fuente: «Inbound - SDR Meta Ads Revival»", url: t.url }))
    .catch(() => warnings.push("No pude poner la Fuente «Inbound - SDR Meta Ads Revival» en el prospecto: ponela a mano."));
}
// UNA llamada pendiente a tu nombre: si ya tenés una pendiente en ese prospecto (o trato), es esa
async function ensureCall(t, owner, x, tz) {
  const me = Number(owner.pdUserId);
  const pend = t.kind === "lead" ? await pd.activities({ leadId: t.id, done: false, limit: 100 })
    : (await pd.activities({ ownerId: me, done: false, limit: 500 })).filter(a => Number(a.deal_id) === Number(t.id));
  const mine = pend.filter(a => !a.is_deleted && Number(a.owner_id ?? a.user_id) === me).sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)));
  if (mine.length) return { id: mine[0].id, date: mine[0].due_date, existing: true };
  const date = I.callDay(x.at, tz);
  const a = await pd.addActivity({ subject: I.subjectFor(x.p), type: "call", dueDate: date, leadId: t.kind === "lead" ? t.id : undefined, dealId: t.kind === "deal" ? t.id : undefined,
    orgId: t.orgId || undefined, personId: t.personId || undefined, ownerId: me, note: x.p.message ? `Mensaje: ${x.p.message.slice(0, 400)}` : undefined });
  return { id: a?.id || null, date, existing: false };
}
// Un lead: idempotente (lo ya hecho no se repite). opts.pick / opts.none: la respuesta a «¿es alguno de estos?».
async function runOne(x, owner, actor, { tz = "America/Mexico_City", pick = null, none = false } = {}) {
  return mutex(x.key, () => withLock("inbound:" + x.key, async () => {
    let st = await ST.get(x.key);
    if ((pick || none) && st?.status !== "review") throw bad("Ese lead ya no está para revisar.", 409);
    if (st && FINAL.has(st.status)) return st;
    if (!owner.pdUserId) throw bad("Tu email no coincide con ningún usuario de Pipedrive: pedí que te den de alta.", 403);
    const me = Number(owner.pdUserId), U = await users(), done = [], warnings = [];
    const no = [...new Set([...(st?.no || []), ...(none ? (st?.candidates || []).map(c => c.key) : [])])].slice(-30);
    const base = { key: x.key, for: lc(owner.email), by: lc(actor.email), byName: sales.signer(actor), at: new Date().toISOString(), title: I.leadTitleFor(x.p, { places: placesOf() }), no };
    const save = async rec => (st = await ST.set(x.key, { ...base, ...rec }));
    try {
      let target = st?.status === "partial" && st.leadId ? { kind: "lead", id: st.leadId, title: st.title, personId: st.personId || null, orgId: null, url: leadUrl(st.leadId), created: true } : null;
      if (!target && x.p.pd && !pick && !none) { const r = await fromLink(x.p.pd, me, U, done, warnings); if (r.stop) return save({ ...r.stop, done, warnings }); target = r.target; }
      if (!target) { const r = await lookup(x, me, U, done, warnings, { pick, no }); if (r.stop) return save({ ...r.stop, done, warnings }); target = r.target; }
      if (target.kind === "create") target = await create(x, owner, target.orgId, done, warnings, save);
      else await revivalFuente(target, x, me, done, warnings);
      // ya estaba y está descartado (archivado, trato perdido o el último resultado fue que no): no se le agenda otra llamada
      const gone = target.created ? null : await discarded(target, owner, tz);
      if (gone) {
        warnings.push(`Está descartado (${gone}): no agendé llamada. Si querés retomarlo, agendala desde su ficha.`);
        return save({ status: "done", kind: target.kind, id: target.id, orgId: target.orgId || null, url: target.url, title: target.title, created: false, personId: target.personId || st?.personId || null,
          activityId: null, callDate: "", callExisting: false, discarded: gone, done, warnings });
      }
      const c = await ensureCall(target, owner, x, tz);
      done.push(c.existing ? { label: `Ya tenías una actividad pendiente con este ${target.kind === "deal" ? "trato" : "prospecto"} (${c.date}): no creé otra`, url: target.url }
        : { label: `Llamada pendiente a tu nombre para el ${c.date}`, url: target.url });
      return save({ status: "done", kind: target.kind, id: target.id, orgId: target.orgId || null, url: target.url, title: target.title, created: !!target.created, personId: target.personId || st?.personId || null,
        activityId: c.id, callDate: c.date, callExisting: c.existing, done, warnings });
    } catch (e) {
      if (e.status && e.status < 500 && e.status !== 409 && !(e instanceof pd.PipedriveError)) throw e;
      return save({ status: st?.leadId ? "partial" : "error", leadId: st?.leadId || null, personId: st?.personId || null, error: e.status === 503 || e instanceof pd.PipedriveError ? `Pipedrive no respondió (${e.message}). Probá de nuevo.` : e.message, done, warnings });
    }
  }, { busy: "Ya se está procesando ese lead: probá de nuevo en unos segundos." }));
}

// ---------- rutas: lo tuyo pendiente (en tandas), uno (también «Crear a nombre de X») y la respuesta a «¿es alguno de estos?»
const ownerOf = async email => {
  const m = await pd.meta(), u = (m.users || []).find(x => lc(x.email) === lc(email));
  if (!u) throw bad("Esa persona no es usuario del Pipedrive de OrderEAT.", 404);
  const pr = (await getProfiles().catch(() => ({})))[lc(email)];
  return { email: lc(email), name: pr?.name || u.name, pdUserId: Number(u.id), pdName: u.name };
};
export async function processMine(user, { tz, refresh = false, max = 8 } = {}) {
  const me = lc(user.email), { all } = await assemble({ refresh });
  const states = await ST.all().catch(() => ({}));
  const todo = all.filter(x => x.email === me && needs(states[x.key])).sort((a, b) => String(a.at).localeCompare(String(b.at)));
  if (todo.length && !user.pdUserId) throw bad("Tu email no coincide con ningún usuario de Pipedrive: pedí que te den de alta.", 403);
  const t0 = Date.now(), out = [];
  for (const x of todo) {
    if (out.length >= max || Date.now() - t0 > 20e3) break;
    out.push({ key: x.key, state: stateView(await runOne(x, user, user, { tz })) });
  }
  return { results: out, more: todo.length > out.length };
}
async function itemFor(user, scope, key, as) {
  const me = lc(user.email), { all } = await assemble({});
  const x = all.find(y => y.key === String(key));
  if (!x || !I.visible(x, me, scope, canLead)) throw bad("No encontré ese lead (o no es tuyo).", 404);
  if (x.email === me) return { x, owner: user };
  if (!x.email) throw bad("No sé a quién le tocó: que esa persona elija su usuario de Slack en «Tus inbound».", 409);
  // para otra persona: solo su líder o dirección, y pidiéndolo («Crear a nombre de X»)
  if (!canLead(scope, { email: x.email })) throw bad("Ese lead es de otra persona.", 403);
  if (lc(as) !== x.email) throw bad(`Es de ${x.owner || x.email}: lo procesa esa persona, o vos con «Crear a nombre de ${x.owner || x.email}».`, 409, "inbound_other");
  return { x, owner: await ownerOf(x.email) };
}
export async function processOne(user, scope, key, { tz, as = "" } = {}) {
  const { x, owner } = await itemFor(user, scope, key, as);
  return { key: x.key, state: stateView(await runOne(x, owner, user, { tz })) };
}
export async function answerExisting(user, scope, key, { pick = "", none = false, as = "", tz } = {}) {
  const { x, owner } = await itemFor(user, scope, key, as);
  if (!pick && !none) throw bad("Elegí uno, o «Es otro».");
  return { key: x.key, state: stateView(await runOne(x, owner, user, { tz, pick: pick ? String(pick) : null, none: !!none })) };
}

// ---------- en qué está cada lead (I.inboundStage) y «Último: llamada · no atendió · hace 2 días» (la tarjeta de cada lead ya
// procesado). Por tanda (hasta 30, de a 4) y con copia de 2 min por lead (fresh: sin la copia, después de registrar algo).
// Por lead: el prospecto (archivado o no), sus actividades hechas, notas y pendientes, y los tratos de su organización o su
// persona (los perdidos, solo si son de después del prospecto) con las pendientes del abierto; para un trato o una organización,
// lo mismo de ellos. De lo que no se pudo leer no se dice nada (stage «Sin datos»). Solo lo que quien mira puede ver (lo suyo;
// un líder, lo de su gente). Lo de otra persona y los clientes: solo la línea «Último» (no se lee más).
const LC = new Map(), LC_TTL = 120e3;
// el trato al que pasó el prospecto (la nota «Pasó a trato» que deja Registrar con el link al trato)
const dealIdsIn = notes => [...new Set(notes.filter(n => /^\s*<b>Pasó a trato<\/b>/i.test(n.content || "")).flatMap(n => [...String(n.content).matchAll(/\/deal\/(\d+)/g)].map(m => Number(m[1]))))];
async function readTarget(t, light) {
  const k = t.kind === "lead" ? "leadId" : t.kind === "deal" ? "dealId" : "orgId";
  const [done, notes, pend] = await Promise.all([pd.doneActivities({ [k]: t.id, limit: 100 }), light ? { items: [] } : pd.notesAll({ [k]: t.id, limit: 50 }), light ? [] : pd.activities({ [k]: t.id, done: false, limit: 50 })]);
  const raw = { acts: done.items || [], notes: notes.items || [], pending: pend || [], lead: undefined, deals: [] };
  if (light) return raw;
  if (t.kind === "lead") {
    raw.lead = await pd.getLead(t.id);
    const l = raw.lead, since = l?.addTime ? Date.parse(l.addTime) - 864e5 : 0;
    const lists = await Promise.all([l?.orgId ? pd.dealsForOrg(l.orgId) : [], l?.personId ? pd.dealsForPerson(l.personId) : []]);
    const seen = new Set(), noted = new Set(dealIdsIn(raw.notes));
    raw.deals = lists.flat().filter(d => d && !d.is_deleted && d.status !== "deleted" && !seen.has(d.id) && seen.add(d.id))
      .filter(d => d.status === "open" || noted.has(Number(d.id)) || Date.parse(String(d.add_time || "").replace(" ", "T") + (/Z|[+-]\d\d:?\d\d$/.test(d.add_time || "") ? "" : "Z")) >= since);
    for (const id of noted) if (!seen.has(id)) { const d = await pd.getDeal(id).catch(() => null); if (d) { raw.deals.push(d); seen.add(id); } }
  } else if (t.kind === "deal") { const d = await pd.getDeal(t.id); raw.deals = d ? [d] : []; }
  else raw.deals = await pd.dealsForOrg(t.id);
  // las pendientes del trato abierto (la demo con el account va ahí) y las hechas de sus tratos (la demo realizada o el No Show)
  const open = raw.deals.filter(d => d.status === "open" && Number(d.id) !== (t.kind === "deal" ? Number(t.id) : -1)).slice(0, 2);
  for (const d of open) raw.pending.push(...(await pd.activities({ dealId: d.id, done: false, limit: 50 })));
  const others = raw.deals.filter(d => Number(d.id) !== (t.kind === "deal" ? Number(t.id) : -1)).slice(0, 3);
  for (const d of others) raw.dealActs = [...(raw.dealActs || []), ...((await pd.doneActivities({ dealId: d.id, limit: 50 }).catch(() => ({ items: [] }))).items || [])];
  return raw;
}
// ¿El prospecto o trato que ya estaba está descartado? (el mismo estado que muestra la vista: inboundStage «out»). Devuelve el
// motivo o "" si no; si no se puede leer, null (en la duda se agenda la llamada, como antes).
async function discarded(t, owner, tz) {
  if (!t?.id || !["lead", "deal"].includes(t.kind)) return null;
  try {
    const raw = await readTarget(t, false), m = await pd.meta().catch(() => ({ users: [] }));
    const me = (m.users || []).find(u => lc(u.email) === lc(owner.email));
    const g = I.inboundStage({ state: { status: "done" } }, { items: buildTimeline({ acts: raw.acts, notes: raw.notes, tz }), acts: [...raw.acts, ...(raw.dealActs || [])], pending: raw.pending, lead: raw.lead, deals: raw.deals, ownerId: me ? Number(me.id) : Number(owner.pdUserId) || null, today: todayIn(tz), tz: safeTz(tz), users: {}, stages: {} });
    return g.key === "out" ? (g.detail || "sin motivo") : null;
  } catch { return null; }
}
export async function contactsFor(user, scope, keys, { tz, fresh = false } = {}) {
  const me = lc(user.email), states = await ST.all().catch(() => ({})), out = {};
  const todo = [...new Set(keys)].slice(0, 30).map(k => [k, states[k]]).filter(([, st]) => st && (lc(st.for) === me || canLead(scope, { email: lc(st.for) })))
    .map(([k, st]) => [k, st, I.targetOf(st)]).filter(([, , t]) => t);
  if (!todo.length) return { items: out };
  const m = await pd.meta().catch(() => ({ users: [], stages: {} }));
  const idOf = new Map((m.users || []).map(u => [lc(u.email), Number(u.id)])), names = Object.fromEntries((m.allUsers || m.users || []).map(u => [Number(u.id), u.name]));
  const day = todayIn(tz);
  const one = async ([k, st, t]) => {
    const light = st.status === "theirs" || st.status === "client", ck = `${t.kind}:${t.id}:${light ? 1 : 0}`, hit = LC.get(ck);
    let raw = !fresh && hit && Date.now() - hit.at < LC_TTL ? hit.raw : null;
    if (!raw) {
      try { raw = await readTarget(t, light); } catch { out[k] = { stage: I.inboundStage({ state: stateView(st) }, null) }; return; }
      LC.set(ck, { at: Date.now(), raw }); if (LC.size > 500) LC.delete(LC.keys().next().value);
    }
    const items = buildTimeline({ acts: raw.acts, notes: raw.notes, tz }), last = lastContact(items);
    const stage = I.inboundStage({ state: stateView(st) }, { items, acts: [...raw.acts, ...(raw.dealActs || [])], pending: raw.pending, lead: raw.lead, deals: raw.deals, ownerId: idOf.get(lc(st.for)) || null, today: day, tz: safeTz(tz), users: names, stages: m.stages || {} });
    out[k] = { last: last ? { at: last.at, channel: last.channel, label: last.label, result: last.result, answered: last.answered, n: last.n } : { none: true }, stage };
  };
  for (let i = 0; i < todo.length; i += 4) await Promise.all(todo.slice(i, i + 4).map(one));
  return { items: out };
}
