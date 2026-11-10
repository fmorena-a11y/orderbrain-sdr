// Demos (actividades «meeting» de Pipedrive): resultado, lista del equipo y métricas para líderes. Lógica pura.
// El resultado se lee SOLO de la línea fija que deja la app en la nota de la actividad (o del campo outcome de Pipedrive
// si alguna vez viene con valor). Sin esa marca es «?» (null), aunque la actividad esté hecha: no se deduce de otras notas.
import { fromUtc, addDays } from "./time.js";

export const RESULT_TAG = "[Resultado de la demo]";
export const RESULTS = { done: "Se hizo", noshow: "No se presentó", moved: "Se reprogramó", canceled: "Se canceló" };
const BY_LABEL = Object.fromEntries(Object.entries(RESULTS).map(([k, v]) => [v, k]));
const plain = h => String(h || "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li)>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const LINE = /\[Resultado de la demo\]\s*(Se hizo|No se presentó|Se reprogramó|Se canceló)/g;
// todas las marcas de la nota, en orden (una demo reprogramada y después hecha tiene dos)
export const resultMarks = note => [...plain(note).matchAll(LINE)].map(m => BY_LABEL[m[1]]);
// el campo outcome de Pipedrive (hoy siempre null): solo valores reconocibles; cualquier otro queda «?»
export function outcomeKey(v) {
  const t = String(v && typeof v === "object" ? v.label ?? v.value ?? v.name ?? "" : v ?? "").trim().toLowerCase();
  if (!t) return null;
  if (/no.?show|no se present/.test(t)) return "noshow";
  if (/cancel/.test(t)) return "canceled";
  if (/resched|reprogram|reagend/.test(t)) return "moved";
  if (/^(done|held|completed?|hecha|se hizo|realizada)$/.test(t)) return "done";
  return null;
}
export const demoResult = a => resultMarks(a?.note).at(-1) || outcomeKey(a?.outcome) || null;

const escH = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const ddmm = d => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
// «[Resultado de la demo] No se presentó · marcado por X desde OrderBrain SDR el dd/mm»
export const resultLine = (key, { by, day, to = "" }) => `${RESULT_TAG} ${RESULTS[key]} · marcado por ${by} desde OrderBrain SDR el ${ddmm(day)}${to ? ` · nueva fecha: ${to}` : ""}`;
export const withResult = (note, line) => `${String(note || "").trim() ? String(note).trim() + "<br>" : ""}${escH(line)}`;
// ya pasó (fecha y hora UTC de Pipedrive). Sin hora: desde que empieza ese día.
export const demoPast = (a, now = Date.now()) => !!a?.due_date && Date.parse(`${a.due_date}T${a.due_time ? String(a.due_time).slice(0, 5) : "00:00"}:00Z`) <= now;

// Quién la agendó: en las agendadas desde la app, el nombre de la nota (el creador en Pipedrive es el dueño del token);
// si no, creator_user_id. Sin ninguno de los dos: «?».
const key = v => String(v || "").trim().toLowerCase();
export function people(users = [], profiles = {}) {
  const idx = new Map(users.flatMap(u => [[key(u.name), u.id], [key(u.email), u.id], [key(profiles[u.email]?.name), u.id]]).filter(([k]) => k));
  const name = id => { const u = users.find(x => x.id === Number(id)); return u ? profiles[u.email]?.name || u.name : ""; };
  return { name, setter: a => { const id = (a.by && idx.get(key(a.by))) || Number(a.creator_user_id) || null; return { id, name: (id && name(id)) || a.by || "" }; } };
}
const byName = (x, y) => (x.name || "~").localeCompare(y.name || "~", "es", { sensitivity: "base" });
const local = (a, tz) => { const l = fromUtc(a.due_date, a.due_time, tz); return { date: l.date, time: a.due_time ? l.time : "" }; };

// Tarjeta «Demos de la semana» (la ven todos): las de los últimos 7 días y las próximas 14, y cuántas agendó cada uno.
// Sin puestos: orden alfabético.
export function demoBoard(demos, { users, profiles, today, tz, back = 7, ahead = 14 }) {
  const from = addDays(today, -back), to = addDays(today, ahead), P = people(users, profiles);
  const rows = demos.map(a => ({ ...a, ...local(a, tz) })).filter(a => a.date >= from && a.date <= to).map(a => { const s = P.setter(a);
    return { id: a.id, date: a.date, time: a.time, utcDate: a.due_date, utcTime: a.due_time || "", name: a.name || "", schoolId: a.schoolId || null, record: a.record || null,
      setterId: s.id, setter: s.name, ownerId: a.owner_id || null, owner: P.name(a.owner_id), result: a.result || null, done: !!a.done }; })
    .sort((x, y) => (x.date + (x.time || "99")).localeCompare(y.date + (y.time || "99")));
  const count = new Map(); for (const r of rows) { const k = r.setterId || r.setter || "?"; const c = count.get(k) || { name: r.setter, upcoming: 0, recent: 0 }; c[r.date >= today ? "upcoming" : "recent"]++; count.set(k, c); }
  return { from, to, today, upcoming: rows.filter(r => r.date >= today), recent: rows.filter(r => r.date < today).reverse(), people: [...count.values()].sort(byName) };
}

// Qué pasó con el trato de una demo hecha: el de la actividad (deal_id) o, si no tiene, el primero de esa organización
// creado después de la demo (fuera de los embudos de clientes). Si no se puede saber: «unknown» (?).
const iso = v => !v ? null : String(v).includes("T") ? String(v) : String(v).replace(" ", "T") + "Z";
export function dealFor(a, { deals, orgDeals, clientPipes = [] }) {
  if (a.deal_id) return deals.has(a.deal_id) ? deals.get(a.deal_id) : undefined;
  if (!a.org_id || !orgDeals.has(a.org_id)) return undefined;
  const at = `${a.due_date}T${a.due_time ? String(a.due_time).slice(0, 5) : "00:00"}:00Z`;
  return orgDeals.get(a.org_id).filter(d => !clientPipes.includes(Number(d.pipeline_id)) && iso(d.add_time) && iso(d.add_time) >= at).sort((x, y) => iso(x.add_time).localeCompare(iso(y.add_time)))[0] || null;
}
// undefined: no se sabe (?) · null: sin trato
export const dealState = (d, pastProposal) => d === undefined ? "unknown" : d === null ? "none" : d.status === "won" ? "won" : d.status === "lost" ? "lost" : d.status === "open" ? (pastProposal(d) ? "proposal" : "open") : "unknown";

const blank = () => ({ set: 0, marked: 0, done: 0, noshow: 0, moved: 0, canceled: 0, unknown: 0 });
const add = (r, res) => { r.set++; if (res) { r.marked++; r[res]++; } else r.unknown++; };
// % de asistencia SOLO sobre las marcadas como «se hizo» o «no se presentó»; sin ninguna: null (se muestra «?»)
export const attendance = r => r.done + r.noshow ? Math.round(r.done / (r.done + r.noshow) * 100) : null;

// Métricas para líderes: demos con fecha en los últimos `days` días que ya pasaron, por país, quién agendó y quién la dio.
export function demoMetrics(demos, { users, profiles, today, tz, days = 30, country = "", deals = new Map(), orgDeals = new Map(), clientPipes = [], pastProposal = () => false, pipeCountry = {}, now = Date.now() }) {
  const from = addDays(today, -(days - 1)), P = people(users, profiles);
  const all = demos.map(a => ({ ...a, ...local(a, tz) })).filter(a => a.date >= from && a.date <= today && demoPast(a, now)).map(a => {
    const d = dealFor(a, { deals, orgDeals, clientPipes });
    return { ...a, deal: d, country: a.country || (d && pipeCountry[d.pipeline_id]) || "" };
  });
  const countries = [...new Set(all.map(a => a.country || "?"))].sort((x, y) => x === "?" ? 1 : y === "?" ? -1 : x.localeCompare(y, "es"));
  const list = all.filter(a => !country || (a.country || "?") === country);
  const tot = blank(), bySetter = new Map(), byOwner = new Map(), out = { won: 0, lost: 0, proposal: 0, open: 0, none: 0, unknown: 0 }, reasons = new Map(), wonDays = [];
  for (const a of list) {
    add(tot, a.result);
    const s = P.setter(a), sk = s.id || s.name || "?"; if (!bySetter.has(sk)) bySetter.set(sk, { name: s.name, ...blank() }); add(bySetter.get(sk), a.result);
    const ok = a.owner_id || "?"; if (!byOwner.has(ok)) byOwner.set(ok, { name: P.name(a.owner_id), ...blank() }); add(byOwner.get(ok), a.result);
    if (a.result !== "done") continue;
    const st = dealState(a.deal, pastProposal); out[st]++;
    if (st === "lost") { const r = a.deal.lost_reason || "?"; reasons.set(r, (reasons.get(r) || 0) + 1); }
    if (st === "won" && iso(a.deal.won_time)) { const n = (Date.parse(iso(a.deal.won_time)) - Date.parse(`${a.due_date}T${a.due_time ? String(a.due_time).slice(0, 5) : "00:00"}:00Z`)) / 864e5; if (n >= 0) wonDays.push(n); }
  }
  const rows = m => [...m.values()].map(r => ({ ...r, attendance: attendance(r) })).sort(byName);
  return { from, today, days, country, countries, totals: { ...tot, attendance: attendance(tot), movedEver: list.filter(a => a.moved).length },
    deals: { ...out, lostReasons: [...reasons].map(([reason, n]) => ({ reason, n })).sort((x, y) => y.n - x.n || x.reason.localeCompare(y.reason)),
      avgDaysToWon: wonDays.length ? Math.round(wonDays.reduce((s, n) => s + n, 0) / wonDays.length) : null, wonWithDays: wonDays.length },
    bySetter: rows(bySetter), byOwner: rows(byOwner) };
}
