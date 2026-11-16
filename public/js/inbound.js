// Tus inbound (#/inbound, debajo de Métricas; la ve quien no es Account Executive): los leads del reparto round robin de
// Slack que te tocaron (últimos 30 días). Al abrir la vista (y con «Revisar ahora») el servidor deja cada uno en Pipedrive:
// el prospecto a tu nombre (o el que ya estaba, tuyo o libre) y UNA llamada pendiente. Lo de otra persona y los clientes no
// se tocan; lo dudoso se pregunta («Es este» / «Es otro»). Sin el token de Slack: «Pegá el mensaje de Slack».
// Los de Meta Ads son SDR revival (etiqueta «SDR revival · Meta Ads»; el prospecto lleva la Fuente «Inbound - SDR Meta Ads Revival»).
// Un líder ve lo de su gente (y lo crea a su nombre solo con «Crear a nombre de X»); dirección, todo. Servidor:
// lib/inbound.js (reglas), lib/inbound-run.js y lib/inbound-api.js.
import { S, api, esc, icon, toast, telLink, agoText, shortDay, modal, leadsOver, today } from "./core.js";
import { go } from "./app.js";
import { openRecord } from "./school.js";

let host = null;
const st = { data: null, err: null, busy: false, prog: "", who: "mine", pasting: false, pasteErr: "", roErr: "", info: {}, stage: (() => { try { return localStorage.getItem("ob.inbound.stage") || "all"; } catch { return "all"; } })() };
const page = body => `<div class="page inb-page"><div class="page-head"><div><h1>Tus inbound</h1><p>Los leads del reparto de Slack que te tocaron. Cada uno queda en Pipedrive como prospecto a tu nombre, con una llamada pendiente. Los de Meta Ads van como SDR revival (Fuente «Inbound - SDR Meta Ads Revival»).</p></div></div>${body}</div>`;
const SRC_TONE = { meta: "meta", google: "google", organic: "org", referral: "ref", revival: "rev" };

export async function renderInbound(el) {
  host = el;
  draw();
  await load();
  autoRun();
}
async function load({ refresh = false } = {}) {
  try { st.data = await api(`/api/inbound${refresh ? "?refresh=1" : ""}`); st.err = null; S.inboundPending = st.data.pending; }
  catch (e) { st.err = e.message; }
  draw();
  loadLast({ fresh: refresh });
}
// ---------- «Último: llamada · no atendió · hace 2 días»: de a 20 leads ya en Pipedrive (el servidor guarda 2 min lo leído).
// Si no se pudo leer, la tarjeta no dice nada. Se pinta en su lugar (sin redibujar: no se pierde lo que estés pegando).
let lastSeq = 0;
async function loadLast({ fresh = false } = {}) {
  const keys = (st.data?.items || []).filter(x => x.state?.ref).map(x => x.key), my = ++lastSeq;
  for (let i = 0; i < keys.length; i += 20) {
    let r; try { r = await api(`/api/inbound/contacts?keys=${encodeURIComponent(keys.slice(i, i + 20).join(","))}${fresh ? "&fresh=1" : ""}`); } catch { return; }
    if (my !== lastSeq) return;
    Object.assign(st.info, r.items || {});
    drawList();
  }
}
// registraste algo en una ficha (un contacto, un WhatsApp, una actividad): al volver, la línea de cada lead se lee de nuevo
let lastTimer = null;
addEventListener("ob:wrote", e => {
  const p = String(e.detail?.path || "");
  if (!/^\/api\/(schools|activities|proposals)\//.test(p) || /\/(timeline|call-brief|check)(\?|$)/.test(p)) return;
  clearTimeout(lastTimer); lastTimer = setTimeout(() => { if (host?.isConnected && S.view === "inbound" && st.data) loadLast({ fresh: true }); }, 1500);
});
const CH = { call: "llamada", whatsapp: "WhatsApp", mail: "mail", visit: "visita", demo: "demo" };
function lastHtml(key, v = st.info[key]?.last) {
  if (!v) return `<p class="inb-last" data-last="${esc(key)}" hidden></p>`;
  if (v.none) return `<p class="inb-last mute" data-last="${esc(key)}">${icon("clock", "sm")}<span>Sin contactos cargados todavía</span></p>`;
  const what = [CH[v.channel] || String(v.label || "contacto").toLowerCase(), v.result && !/^(enviado)$/.test(v.result) ? v.result : v.channel === "mail" ? "enviado" : "", `hace ${agoText(v.at)}`].filter(Boolean).join(" · ");
  return `<p class="inb-last ${v.answered === true ? "ok" : v.answered === false ? "no" : ""}" data-last="${esc(key)}" title="${esc(new Date(v.at).toLocaleString())}">${icon(v.channel === "whatsapp" ? "whatsapp" : v.channel === "mail" ? "mail" : "phone", "sm")}<span>Último: ${esc(what)}${v.n > 1 ? ` <span class="faint">· ${v.n} contactos</span>` : ""}</span></p>`;
}
// ---------- abrir la ficha del lead en el Historial (con el resumen arriba, abierto): prospecto sin organización, su
// organización (o el colegio cruzado: el servidor lo resuelve) o la organización del trato.
async function openLead(x, btn) {
  const s = x.state, ref = s?.ref;
  if (!ref) {
    if (s?.status === "review") return toast("Todavía no está en Pipedrive: elegí en la tarjeta si es alguno de estos o creá uno nuevo.", { type: "info" });
    if (!x.mine && !s) return toast(`Todavía no está en Pipedrive: lo crea ${x.assignee.name || "esa persona"} al abrir «Tus inbound».`, { type: "info" });
    return toast("Todavía no está en Pipedrive: tocá Revisar ahora.", { type: "info", action: x.mine && !st.busy ? { label: "Revisar ahora", fn: () => host?.querySelector("#inRun")?.click() } : undefined });
  }
  const opts = { tab: "hist", cbOpen: true };
  if (btn) { btn.disabled = true; btn.setAttribute("aria-busy", "true"); }
  try {
    if (ref.kind === "lead") return await openRecord(`lead:${ref.id}`, opts);
    if (ref.kind === "org") return await openRecord(`org:${ref.id}`, opts);
    let orgId = ref.orgId;
    if (!orgId) { const d = await api(`/api/pd-deal/${encodeURIComponent(ref.id)}`); orgId = d.orgId; if (!orgId && d.personId) { const { openPerson } = await import("./pdsearch.js"); return openPerson(d.personId); } }
    if (orgId) return await openRecord(`org:${orgId}`, opts);
    toast("Ese trato no tiene organización ni persona: lo abro en Pipedrive.", { type: "info" }); if (s.url) window.open(s.url, "_blank", "noopener");
  } catch (e) { toast(e.message, { type: "err" }); }
  finally { if (btn?.isConnected) { btn.disabled = false; btn.removeAttribute("aria-busy"); } }
}
// lo tuyo que falta: el servidor lo procesa en tandas (more = quedan)
async function autoRun({ refresh = false } = {}) {
  if (st.busy || !st.data?.pending || !S.me?.pdUserId) return;
  st.busy = true; st.roErr = ""; st.prog = "Dejando tus leads en Pipedrive…"; draw();
  let n = 0;
  try {
    for (let i = 0; i < 10; i++) {
      const r = await api("/api/inbound/process", { body: { refresh: refresh && i === 0 } });
      n += r.results.length;
      for (const x of r.results) patch(x.key, x.state);
      st.prog = `Dejando tus leads en Pipedrive… ${n}`; draw();
      if (!r.more) break;
    }
  } catch (e) { if (e.status === 403 && /solo lectura/i.test(e.message)) st.roErr = e.message; else toast(`No pude terminar: ${e.message}`, { type: "err" }); }
  finally { st.busy = false; st.prog = ""; }
  await load();
}
function patch(key, state) { const it = st.data?.items.find(x => x.key === key); if (it) it.state = state; }

function draw() {
  if (!host?.isConnected) return;
  const d = st.data;
  if (!d && !st.err) { host.innerHTML = page(`<div class="card card-b">${'<div class="skel" style="margin:12px 0;height:64px"></div>'.repeat(3)}</div>`); return; }
  if (!d) { host.innerHTML = page(`<div class="callout err">${icon("alert")}<span>No pude traer tus inbound: ${esc(st.err)}</span><button class="btn sm" id="inRetry">Reintentar</button></div>`); host.querySelector("#inRetry").onclick = () => { st.err = null; draw(); load().then(() => autoRun()); }; return; }
  host.innerHTML = page(`<div class="stack inb-stack">
    ${slackCallout(d)}
    ${st.roErr ? `<div class="callout warn">${icon("lock")}<span>${esc(st.roErr)} Los leads se ven, pero no se crea nada.</span></div>` : ""}
    ${!S.me?.pdUserId ? `<div class="callout warn">${icon("alert")}<span>Tu email no coincide con un usuario de Pipedrive: no puedo crear los prospectos a tu nombre. Pedí que te den de alta.</span></div>` : ""}
    ${d.notices?.length ? d.notices.map(n => `<div class="callout warn">${icon("alert")}<span><b>Corrección del reparto</b> (${esc(agoText(n.at))}): ${esc(n.text)}</span></div>`).join("") : ""}
    ${pasteCard(d)}
    <div class="inb-bar">
      <button class="btn primary" id="inRun" ${st.busy ? "disabled" : ""}>${st.busy ? `<span class="spin"></span> ${esc(st.prog || "Revisando…")}` : `${icon("refresh", "sm")} Revisar ahora`}</button>
      <span class="faint inb-me">${meLine(d)}</span>
    </div>
    <div id="inbList" class="stack inb-stack">${listHtml(d)}</div>
  </div>`);
  bind();
  bindList();
}
// ---------- la lista: quién (líderes), estado (chips con contador) y las tarjetas en orden de importancia. Se redibuja sola
// cuando llegan los estados (sin tocar lo de arriba: la caja de pegar no se pierde).
function listHtml(d) {
  const mineList = filtered(d), list = mineList.filter(x => inStage(x, st.stage)).sort(byImportance);
  return `${whoChips(d)}${stageChips(mineList)}
    <section class="card" aria-labelledby="hInb"><div class="card-h"><h2 id="hInb">${icon("bolt")} ${st.who === "mine" ? "Te tocaron" : st.who === "all" ? "Todos" : esc(st.who)} <span class="faint">· últimos 30 días${st.stage !== "all" ? ` · ${esc(STAGE_CHIPS.find(c => c[0] === st.stage)?.[1] || "")}` : ""}</span></h2></div>
      <div class="card-b inb-items">${list.length ? list.map(itemHtml).join("") : mineList.length ? `<div class="empty">${icon("bolt")}<span>Nada en «${esc(STAGE_CHIPS.find(c => c[0] === st.stage)?.[1] || "este estado")}». <button class="linkbtn" data-stage="all">Ver todos</button></span></div>` : emptyHtml(d)}</div></section>`;
}
function drawList() {
  const el = host?.isConnected && host.querySelector("#inbList"); if (!el || !st.data) return;
  const f = document.activeElement, focusSel = f && el.contains(f) ? (f.dataset.stage != null ? `[data-stage="${CSS.escape(f.dataset.stage)}"]` : f.dataset.hist ? `[data-hist="${CSS.escape(f.dataset.hist)}"]` : f.dataset.who != null ? `[data-who="${CSS.escape(f.dataset.who)}"]` : "") : "";
  el.innerHTML = listHtml(st.data); bindList();
  if (focusSel) el.querySelector(focusSel)?.focus();
}
// el estado de un lead: el que llegó por tanda (/api/inbound/contacts) o el que se sabe sin leer (sin procesar, de otra persona…)
const stageOf = x => st.info[x.key]?.stage || x.stage || null;
const STAGE_CHIPS = [["all", "Todos los estados"], ["pend", "Pendiente tuya"], ["new", "Sin contactar"], ["noreply", "Contactado sin respuesta"], ["maybe", "Posible demo"], ["demo", "Demo agendada"], ["deal", "En trato"], ["out", "Descartado"],
  ["review", "Para revisar"], ["todo", "Sin procesar"], ["theirs", "De otra persona"], ["client", "Cliente"], ["unknown", "Sin datos"]];
const FIXED = new Set(["all", "pend", "new", "noreply", "maybe", "demo", "deal", "out"]);
const inStage = (x, k) => k === "all" ? true : k === "pend" ? !!stageOf(x)?.mine : stageOf(x)?.key === k;
// orden por importancia: pendiente tuya vencida, posible demo, sin contactar, sin respuesta, demo, trato, descartado; lo que
// todavía no llegó, al final de lo suyo; dentro de cada uno, lo más nuevo primero
const byImportance = (a, b) => (stageOf(a)?.rank ?? 8) - (stageOf(b)?.rank ?? 8) || String(b.at).localeCompare(String(a.at));
function stageChips(list) {
  const n = k => list.filter(x => inStage(x, k)).length, known = list.filter(x => stageOf(x)).length, waiting = list.length - known;
  const chips = STAGE_CHIPS.filter(([k]) => FIXED.has(k) || n(k) || st.stage === k);
  return `<div class="chips inb-stages" role="group" aria-label="Estado">${chips.map(([k, l]) => `<button class="chip${k === "pend" ? " pend" : ""}" data-stage="${k}" aria-pressed="${st.stage === k}"${k === "pend" ? ` title="Con una actividad sin hacer a nombre de quien le tocó (no del account)"` : ""}>${esc(l)} <b>${k === "all" ? list.length : n(k)}</b></button>`).join("")}
    ${waiting && st.data?.items.some(x => x.state?.ref) ? `<span class="faint inb-wait" aria-live="polite"><span class="spin"></span> Leyendo ${waiting} de Pipedrive…</span>` : ""}</div>`;
}
function stageTag(x) {
  const g = stageOf(x); if (!g) return "";
  return `<span class="inb-stage s-${esc(g.key)}" title="${esc([g.label, g.detail].filter(Boolean).join(": "))}">${esc(g.label)}${g.detail && g.key !== "new" ? `<small>${esc(g.key === "demo" && g.date ? [shortDay(g.date) + (g.time ? ` ${g.time}` : ""), g.detail.split(" · ").slice(1).join(" · ")].filter(Boolean).join(" · ") : g.detail)}</small>` : ""}</span>`;
}
function pendHtml(x) {
  const p = stageOf(x)?.mine; if (!p) return "";
  const who = x.mine ? "Pendiente tuya" : `Pendiente de ${x.assignee.name || "quien le tocó"}`;
  return `<p class="inb-pend${p.late ? " late" : ""}">${icon("calendar", "sm")}<span><b>${esc(who)}:</b> ${esc(p.subject || "actividad")} · ${esc(shortDay(p.date))}${p.time ? ` ${esc(p.time)}` : ""}${p.late ? " · vencida" : ""}</span></p>`;
}
const filtered = d => d.items.filter(x => st.who === "all" ? true : st.who === "mine" ? x.mine : (x.assignee.name || "Sin asignar") === st.who);
function whoChips(d) {
  if (!d.leader) return "";
  const names = [...new Set(d.items.filter(x => !x.mine).map(x => x.assignee.name || "Sin asignar"))].sort((a, b) => a.localeCompare(b));
  if (!names.length) return "";
  const n = k => k === "all" ? d.items.length : k === "mine" ? d.items.filter(x => x.mine).length : d.items.filter(x => (x.assignee.name || "Sin asignar") === k).length;
  return `<div class="chips inb-who" role="group" aria-label="De quién">${[["mine", "Míos"], ["all", "Todos"], ...names.map(x => [x, x])].map(([k, l]) => `<button class="chip" data-who="${esc(k)}" aria-pressed="${st.who === k}">${esc(l)} <b>${n(k)}</b></button>`).join("")}</div>`;
}
function meLine(d) {
  const s = d.me?.slack;
  return s?.name ? `Tu usuario de Slack: <b>${esc(s.name)}</b> · <button class="linkbtn" id="inSlackMe">Cambiar</button>`
    : d.me?.auto ? `En Slack sos <b>${esc(d.me.auto)}</b> · <button class="linkbtn" id="inSlackMe">No soy yo</button>` : `<button class="linkbtn" id="inSlackMe">¿No ves los tuyos? Elegí tu usuario de Slack</button>`;
}
function emptyHtml(d) {
  if (st.who !== "mine") return `<div class="empty">${icon("bolt")}<span>Nada por acá.</span></div>`;
  return `<div class="empty">${icon("bolt")}<span>${d.slack.on ? "No te tocó ningún lead en los últimos 30 días." : "Todavía no hay mensajes: pegá abajo los de Slack."}</span>${d.names?.length && !d.me?.slack ? `<button class="linkbtn" data-slackme>¿Tu nombre en Slack es otro? Elegilo</button>` : ""}</div>`;
}
const SLACK_ERR = { not_in_channel: "la app de Slack no está en el canal: hay que sumarla (/invite).", channel_not_found: "la app de Slack no ve el canal: hay que sumarla (/invite).", missing_scope: "a la app de Slack le faltan permisos.", invalid_auth: "el token de Slack no es válido.", not_authed: "falta el token de Slack.", account_inactive: "el token de Slack es de una app desactivada.", ratelimited: "Slack pidió esperar un poco." };
function slackCallout(d) {
  const s = d.slack, scopes = (s.scopes || []).map(x => `<code>${esc(x)}</code>`).join(", ");
  if (s.demo) return `<div class="callout warn">${icon("alert")}<span><b>Slack de prueba.</b> Los mensajes son inventados (modo demo). Con el token real se leen del canal del reparto.</span></div>`;
  if (!s.on) return `<div class="callout warn inb-need">${icon("alert")}<div><b>Todavía no leemos Slack solos.</b> Para leer Slack solos, un admin de Slack crea la app y pega el token en Vercel: <code>SLACK_BOT_TOKEN</code>, con estos permisos: ${scopes}. Después la suma al canal #round-robin-spam-sdrs. <span class="faint">Mientras, pegá abajo el mensaje de Slack y hago lo mismo.</span></div></div>`;
  if (s.error) return `<div class="callout err">${icon("alert")}<span>No pude leer Slack: ${esc(SLACK_ERR[s.error] || s.error)} Mientras, podés pegar los mensajes arriba.</span></div>`;
  return "";
}
function pasteCard(d) {
  const open = !d.slack.on || st.pasting;
  return `<details class="card inb-paste" ${open ? "open" : ""}><summary class="card-h"><h2>${icon("copy")} Pegá el mensaje de Slack</h2></summary><div class="card-b stack" style="gap:10px">
    <p class="muted" style="margin:0">Copiá uno o varios mensajes del canal (desde «Lead para llamar» o «Referido de padre» hasta el final) y pegalos acá. Lo que no dice a quién le toca queda para vos.</p>
    <textarea class="inp" id="inPaste" rows="3" placeholder="Lead para llamar — le toca a @…&#10;Teléfono: …&#10;Nombre: …&#10;Colegio: …"></textarea>
    ${st.pasteErr ? `<p class="err" role="alert" style="margin:0;color:var(--err)">${esc(st.pasteErr)}</p>` : ""}
    <div><button class="btn" id="inPasteGo">Leer mensajes</button></div></div></details>`;
}
const fmtLeft = h => h == null ? "" : h > 0 ? `Quedan ${h} h` : "Pasaron las 72 h";
function stateHtml(x) {
  const s = x.state, other = !x.mine ? (x.assignee.name || "esa persona") : "";
  const link = (u, t) => u ? ` <a href="${esc(u)}" target="_blank" rel="noopener">${esc(t)} ${icon("external", "sm")}</a>` : "";
  if (!s) {
    if (x.mine) return `<div class="inb-st mute">${st.busy ? `<span class="spin"></span> En cola…` : "Sin procesar"}</div>`;
    const can = !!x.assignee.email && leadsOver(null, x.assignee.email);
    return `<div class="inb-st mute">Sin procesar · lo crea ${esc(other)} al abrir «Tus inbound»${can ? ` <button class="btn sm" data-as="${esc(x.key)}" data-email="${esc(x.assignee.email)}">Crear a nombre de ${esc(other)}</button>` : ""}</div>`;
  }
  const day = s.callDate ? shortDay(s.callDate) : "";
  const whose = x.mine ? "a tu nombre" : `a nombre de ${other}`;
  const what = s.kind === "deal" ? "trato" : "prospecto";
  if (s.status === "done") {
    const call = s.callExisting ? `ya ${x.mine ? "tenías" : "tenía"} una actividad pendiente (${esc(day)})` : `llamada pendiente ${esc(day)}`;
    return `<div class="inb-st ok">${icon("checkCircle", "sm")}<span>${s.created ? `Prospecto creado ${whose}` : `Ya estaba: ${what} «${esc(s.title)}»`} · ${call}${link(s.url, "Abrir")}</span></div>${warnHtml(s)}`;
  }
  if (s.status === "theirs") return `<div class="inb-st warn">${icon("alert", "sm")}<span>Ya estaba: «${esc(s.title)}» de ${esc(s.owner || "otra persona")}. No lo toqué: coordiná con esa persona.${link(s.url, "Ver")}</span></div>`;
  if (s.status === "client") return `<div class="inb-st warn">${icon("alert", "sm")}<span>Cliente de OrderEAT («${esc(s.title)}»): no contactar.${link(s.url, "Ver")}</span></div>`;
  if (s.status === "review") return `<div class="inb-st warn">${icon("alert", "sm")}<span>Ya hay algo parecido en Pipedrive: ¿es alguno de estos?</span></div>
    <div class="inb-cands">${s.candidates.map(c => `<div class="inb-c"><span class="t"><b>${esc(c.title)}</b><small>${esc([c.what, c.owner === "libre" ? "libre" : `de ${c.owner}`, c.why].filter(Boolean).join(" · "))}</small></span>
      <span class="inb-ca"><a href="${esc(c.url)}" target="_blank" rel="noopener" class="linkbtn">Ver ${icon("external", "sm")}</a><button class="btn sm" data-pick="${esc(c.key)}" data-k="${esc(x.key)}" ${x.mine ? "" : `data-email="${esc(x.assignee.email)}"`}>Es este</button></span></div>`).join("")}
      <button class="btn sm ghost" data-none="${esc(x.key)}" ${x.mine ? "" : `data-email="${esc(x.assignee.email)}"`}>Es otro: crear prospecto nuevo</button></div>`;
  return `<div class="inb-st err">${icon("alert", "sm")}<span>No pude terminar${s.status === "partial" ? " (el prospecto quedó creado)" : ""}: ${esc(s.error || "error")}</span>${x.mine ? ` <button class="btn sm" data-retry="${esc(x.key)}">Reintentar</button>` : ""}</div>`;
}
const warnHtml = s => s.warnings?.length ? `<p class="faint inb-note">${esc(s.warnings.join(" "))}</p>` : "";
function itemHtml(x) {
  const left = x.hoursLeft, late = left != null && left <= 0;
  const wa = x.phone ? `https://wa.me/${String(x.phone).replace(/\D/g, "")}` : "";
  const place = [x.school && x.city ? `${x.school} · ${x.city}` : x.school || x.city, x.country].filter(Boolean).join(" · ");
  const can = !!x.state?.ref;
  return `<article class="inb-it${can ? " can-open" : ""}" data-key="${esc(x.key)}">
    <div class="inb-tags">${stageTag(x)}<span class="inb-k ${esc(x.kind)}">${esc(x.kindLabel)}</span>${x.sourceLabel && x.kind !== "referral" && x.kind !== "revival" ? `<span class="inb-src ${SRC_TONE[x.source] || ""}">${esc(x.sourceLabel)}</span>` : ""}${x.priority ? `<span class="tag">prioridad ${esc(x.priority)}</span>` : ""}
      <span class="tag" title="${esc(new Date(x.at).toLocaleString())}">${x.pasted ? "pegado " : ""}hace ${esc(agoText(x.at))}</span><span class="tag ${late ? "late" : left != null && left < 24 ? "soon" : ""}">${esc(fmtLeft(left))}</span>${!x.mine ? `<span class="tag">de ${esc(x.assignee.name || "sin asignar")}</span>` : ""}</div>
    <div class="inb-main"><b>${esc(x.name || "Sin nombre")}</b>${x.role && !/^otro$/i.test(x.role) ? ` <span class="faint">· ${esc(x.role)}</span>` : ""}<small>${esc(place || "Sin colegio")}</small><small class="faint">En Pipedrive: «${esc(x.title)}»</small></div>
    <div class="inb-cl">${x.phone ? `<a href="${esc(telLink(x.phone))}">${icon("phone", "sm")} ${esc(x.phone)}</a><a href="${esc(wa)}" target="_blank" rel="noopener">${icon("whatsapp", "sm")} WhatsApp</a>` : ""}${x.email ? `<a href="mailto:${esc(x.email)}">${icon("mail", "sm")} ${esc(x.email)}</a>` : ""}${x.pd?.url ? `<a href="${esc(x.pd.url)}" target="_blank" rel="noopener">${icon("lead", "sm")} Lead del mensaje</a>` : ""}</div>
    ${x.message ? `<blockquote class="inb-msg">${esc(x.message).replace(/\n/g, "<br>")}</blockquote>` : ""}
    ${x.filter ? `<p class="faint inb-note">${esc(x.filter)}</p>` : ""}
    ${stateHtml(x)}
    ${pendHtml(x)}
    <div class="inb-foot">${can ? lastHtml(x.key) : `<p class="inb-last mute">${icon("clock", "sm")}<span>${x.state?.status === "review" ? "Todavía no está en Pipedrive: elegí arriba" : "Todavía no está en Pipedrive"}</span></p>`}
      <button class="btn sm ${can ? "" : "ghost"}" data-hist="${esc(x.key)}" aria-label="Ver historial de ${esc(x.name || x.title || "este lead")}">${icon("clock", "sm")} Ver historial</button></div>
  </article>`;
}
async function act(btn, path, body, ok) {
  btn.disabled = true; const old = btn.innerHTML; btn.innerHTML = `<span class="spin"></span>`;
  try { const r = await api(path, { body }); patch(r.key, r.state); if (ok) toast(ok); draw(); }
  catch (e) { btn.disabled = false; btn.innerHTML = old; toast(e.message, { type: "err" }); }
}
function bind() {
  host.querySelector("#inRun")?.addEventListener("click", async () => { await load({ refresh: true }); autoRun({ refresh: true }); });
  host.querySelectorAll("#inSlackMe").forEach(b => b.onclick = () => slackDialog());
  const det = host.querySelector(".inb-paste"); if (det) det.ontoggle = () => { st.pasting = det.open; };
  host.querySelector("#inPasteGo")?.addEventListener("click", async e => {
    const ta = host.querySelector("#inPaste"), text = ta.value.trim(), b = e.currentTarget;
    if (!text) { ta.focus(); return; }
    b.disabled = true; b.innerHTML = `<span class="spin"></span> Leyendo…`; st.pasteErr = "";
    try {
      const r = await api("/api/inbound/paste", { body: { text } });
      st.pasting = false;
      toast(r.added ? `Leí ${r.added === 1 ? "1 lead" : `${r.added} leads`}` : "Esos ya estaban");
      await load(); autoRun();
    } catch (x) { st.pasteErr = x.message; st.pasting = true; draw(); }
  });
}
function bindList() {
  const box = host?.querySelector("#inbList"); if (!box) return;
  box.querySelectorAll("[data-slackme]").forEach(b => b.onclick = () => slackDialog());
  box.querySelectorAll("[data-who]").forEach(b => b.onclick = () => { st.who = b.dataset.who; drawList(); });
  box.querySelectorAll("[data-retry]").forEach(b => b.onclick = () => act(b, `/api/inbound/${encodeURIComponent(b.dataset.retry)}/process`, {}, "Listo"));
  box.querySelectorAll("[data-as]").forEach(b => b.onclick = () => act(b, `/api/inbound/${encodeURIComponent(b.dataset.as)}/process`, { as: b.dataset.email }, "Listo: quedó a su nombre"));
  box.querySelectorAll("[data-pick]").forEach(b => b.onclick = () => act(b, `/api/inbound/${encodeURIComponent(b.dataset.k)}/existing`, { pick: b.dataset.pick, as: b.dataset.email || "" }, "Listo"));
  box.querySelectorAll("[data-none]").forEach(b => b.onclick = () => act(b, `/api/inbound/${encodeURIComponent(b.dataset.none)}/existing`, { none: true, as: b.dataset.email || "" }, "Listo"));
  const itemOf = k => st.data?.items.find(y => y.key === k);
  box.querySelectorAll("[data-hist]").forEach(b => b.onclick = () => { const x = itemOf(b.dataset.hist); if (x) openLead(x, b); });
  // toda la tarjeta abre el historial (salvo lo que ya es un link o un botón, y si estás seleccionando texto)
  box.querySelectorAll(".inb-it.can-open").forEach(a => a.onclick = e => {
    if (e.target.closest("a, button, input, textarea, select, summary, details, label") || String(getSelection?.() || "").trim()) return;
    const x = itemOf(a.dataset.key); if (x) openLead(x, a.querySelector("[data-hist]"));
  });
  box.querySelectorAll("[data-stage]").forEach(b => b.onclick = () => { st.stage = b.dataset.stage; try { localStorage.setItem("ob.inbound.stage", st.stage); } catch {} drawList(); });
}
// (la caja de pegar va arriba de todo, pedido del líder: «es incómodo bajar cada vez que tenés que pegar uno»)
// «Tu usuario de Slack»: el nombre con el que te nombra el bot (manda sobre el email y el nombre)
export async function slackDialog() {
  const r = await api("/api/inbound/me").catch(() => ({ names: [], slack: null }));
  const m = modal(`<div class="modal-h"><h3>Tu usuario de Slack</h3><button class="icon-btn" id="slX" aria-label="Cerrar">${icon("x")}</button></div>
    <p class="muted" style="margin:-6px 0 0">El nombre con el que te nombra el reparto («le toca a …»). Con esto ves tus leads aunque tu nombre en Slack sea distinto al de Pipedrive.</p>
    <label class="field"><span>Nombre en Slack</span><input class="inp" id="slName" list="slNames" value="${esc(r.slack?.name || "")}" placeholder="${esc(r.auto?.name ? `Automático: ${r.auto.name}` : "Ej: Facu Morena")}"><datalist id="slNames">${(r.names || []).map(n => `<option value="${esc(n)}">`).join("")}</datalist></label>
    <p class="faint" style="margin:0;font-size:12.5px">Vacío = automático (por tu email de Slack o tu nombre).</p>
    <div class="row"><button class="btn ghost" id="slNo">Cancelar</button><button class="btn primary" id="slGo">Guardar</button></div>`);
  m.querySelector("#slX").onclick = m.querySelector("#slNo").onclick = () => m.close();
  m.querySelector("#slGo").onclick = async () => {
    try { await api("/api/inbound/me", { body: { slack: m.querySelector("#slName").value } }); m.close(); toast("Guardado"); if (host?.isConnected && S.view === "inbound") { await load(); autoRun(); } }
    catch (e) { toast(e.message, { type: "err" }); }
  };
}
// ---------- Hoy: «Tenés N inbound nuevos · Ver» (si los hay sin procesar)
let countAt = 0, countP = null;
export function inboundNotice(el) {
  if (!el || S.me?.role === "ae") return;
  const show = n => { if (!el.isConnected) return; el.innerHTML = n ? `<div class="callout warn inb-notice" style="margin-bottom:16px">${icon("bolt")}<span>Tenés ${n === 1 ? "1 inbound nuevo" : `${n} inbound nuevos`}. <button class="linkbtn" id="inbGo">Ver</button></span></div>` : ""; el.querySelector("#inbGo")?.addEventListener("click", () => go("inbound")); };
  if (S.inboundPending != null) show(S.inboundPending);
  // una vez por minuto como mucho; la vista «Tus inbound» lo deja al día (S.inboundPending)
  if (!countP || Date.now() - countAt >= 60e3) { countAt = Date.now(); countP = api("/api/inbound/count").then(r => { S.inboundPending = r.pending; }).catch(() => {}); }
  countP.then(() => show(S.inboundPending || 0));
}
