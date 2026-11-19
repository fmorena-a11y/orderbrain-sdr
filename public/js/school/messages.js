// Ficha del colegio: WhatsApp y mail con plantillas (y el envío por Pipedrive o Gmail).
import { $, S, api, copy, esc, gmailLink, icon, loadPref, localAct, modal, openMenu, patchSchool, save, shortDay, toast, today, waLink } from "../core.js";
import { connectGmail, gmailWaiting, loadGmail, sigLabel, sigPreview } from "../gmail.js";
import { SIG_LABEL, bindTokenForm, loadPdMail, pdCanConnect, pdReady, tokenFormHtml } from "../pdmail.js";
import { D, coarse, newForm } from "./state.js";
import { keepScroll } from "./media.js";
import { sedeCallable, sedesOf } from "./sections.js";
import { sessionRef } from "./session.js";
import { draw, open, showOutcomes, toTabs } from "./render.js";
import { askPdExisting } from "./prep.js";
import { gotLead, mailDefaultNext, suggest } from "./register.js";

// ---------- WhatsApp y mail con plantillas
export function templateMenu(anchor, s, d, channel, to = {}) {
  if (!d) return toast(D.err ? "No se pudo cargar la ficha. Tocá Reintentar." : "Cargando la ficha…", { type: D.err ? "err" : "info" });
  const list = d.templates.filter(t => t.channel === channel);
  // abierta desde el recordatorio «Confirmar demo» de la agenda: va esa plantilla, con el día y la hora de la próxima demo
  const act = D.activityId && d.activities?.find(a => a.id === D.activityId), confirm = act?.type === "deadline" && /^Confirmar demo\b/.test(act.subject || "");
  const demo = confirm && d.activities.filter(a => a.type === "meeting").map(localAct).find(l => l.date >= today());
  const recommended = channel === "whatsapp" ? (confirm ? "confirm_demo" : s.status === "lost" || s.status === "stalled" ? "reactivate" : d.attempts ? "after_call" : "intro") : (s.status === "lost" || s.status === "stalled" ? "mail_reactivate" : "mail_info");
  list.sort((a, b) => (b.id === recommended) - (a.id === recommended));
  openMenu(anchor, [{ head: channel === "whatsapp" ? "Mensaje de WhatsApp" : "Mail" },
    ...list.map(t => ({ label: t.label + (t.id === recommended ? " · sugerido" : ""), sub: channel === "mail" ? t.subject || "" : t.text.split("\n").find(x => x.length > 12) || t.text, fn: () => {
      let text = t.text; if (to.name) text = text.replace(/^Hola(?=[,\s])/, `Hola ${to.name.split(" ")[0]}`);
      if (t.id === "confirm_demo" && demo) text = text.replace("[día]", shortDay(demo.date)).replace("[hora]", demo.time || "[hora]");
      messageModal(s, d, { ...t, text }, { phone: to.phone, email: to.email, name: to.name, logAfter: true });
    } })),
    { label: "Mensaje en blanco", sub: "Escribir desde cero", fn: () => messageModal(s, d, { channel, label: "Mensaje", text: "", subject: "" }, { phone: to.phone, email: to.email, name: to.name, logAfter: true }) },
  ]);
}
// Mail desde la ficha. Primero Pipedrive: con tu Pipedrive conectado, «Enviar» (con 5 s para deshacer) crea el mail en tu
// casilla de Pipedrive ligado al prospecto o al trato y lo manda; queda la actividad, la nota y el próximo paso en Pipedrive
// y en Historial. Sin Pipedrive conectado: «Conectar Pipedrive para enviar desde acá» (una vez) y, mientras tanto, «Abrir
// en Gmail» como siempre. Si conectaste Gmail (y no Pipedrive), sale de tu Gmail, como antes.
const MAIL_RE = /^[^@\s<>()[\]\\,;:"]+@[^@\s<>()[\]\\,;:"]+\.[a-z]{2,}$/i, PH_RE = /\[(d[ií]a|hora|tu nombre)\]/i, SEND_DELAY = 5;
// Gmail: conectado y confirmado en esta sesión (verified: entraste con Google o lo conectaste acá). Conectado pero sin
// confirmar (entraste con tu código en otro dispositivo): se confirma una vez con Google.
const canSend = g => !!(g?.enabled && g.connected && g.verified && !g.readOnly && !g.config);
const needsConfirm = g => !!(g?.enabled && g.connected && !g.verified && !g.readOnly && !g.config);
// por dónde sale ahora: Pipedrive si está listo; si no, Gmail si está listo; si no, nada (se ofrece conectar)
const mailVia = () => pdReady(S.pdmail) ? "pipedrive" : !S.pdmail?.connected && canSend(S.gmail) ? "gmail" : "";
// la firma que va por esa vía (para sacar la despedida con tu nombre de la plantilla)
const viaSig = v => v === "pipedrive" ? S.pdmail?.signature || "" : v === "gmail" ? S.gmail?.signature || "" : "";
const newKey = () => (crypto.randomUUID?.() || String(Math.random()).slice(2) + Date.now()).replace(/[^A-Za-z0-9]/g, "").slice(0, 40);
// la despedida con tu nombre de la plantilla sobra si la firma ya lo dice
const dropSignoff = text => { const n = String(S.me?.name || "").trim(); const re = n ? new RegExp(`\\n${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\nOrderEAT\\s*$`) : /\n[^\n]{2,60}\nOrderEAT\s*$/; return re.test(text) ? text.replace(re, "") : text.replace(/\n[^\n]{2,60}\nOrderEAT\s*$/, ""); };
// Por qué desde acá no se envía, con lo que ya trae la ficha (archivado, cliente, de otra persona). El servidor lo vuelve a
// comprobar al abrir el modal (/mail/check: también el trato abierto de otra persona) y al enviar.
function mailBlockLocal(s, d) {
  const me = S.me?.pdUserId, m = d.match || {}, who = id => (S.team || []).find(u => u.id === id)?.name || "otra persona";
  if (d.archive) return "Está archivado: desarchivalo para escribirle.";
  if (s.status === "client") return "Ya es cliente de OrderEAT: no se prospecta. Si hay algo, avisale al equipo de cuentas.";
  if (s.leadOnly) return d.leadOwnerId && me && d.leadOwnerId !== me ? `El prospecto es de ${who(d.leadOwnerId)} en Pipedrive. Hablalo con esa persona.` : "";
  const owner = m.ownerId || s.ownerId;
  if (owner && me && owner !== me) return `La organización es de ${m.ownerName || s.ownerName || who(owner)} en Pipedrive. Hablalo con esa persona.`;
  return "";
}
export async function messageModal(s, d, t, { phone, email, name = "", logAfter }) {
  const isMail = t.channel === "mail";
  if (isMail) await Promise.all([loadGmail(!!(S.gmail?.problem || S.gmail?.failed)), loadPdMail(!!S.pdmail?.failed)]);
  // para WhatsApp solo sirve un número completo (con código de área): uno local de 7 dígitos de la web no llega
  const full = p => String(p || "").replace(/\D/g, "").length >= 10;
  const defPhone = phone || [...(d.persons || []).map(p => p.phone), s.phone, ...sedesOf(s.id).filter(z => z.here).flatMap(sedeCallable)].find(p => p && (isMail || full(p))) || "";
  const defMail = email || d.persons?.find(p => p.email)?.email || d.mails?.[0]?.to || D.study?.contacto?.emails?.[0] || s.email || "";
  const pre = S.markets[s.country]?.prefix ? `+${S.markets[s.country].prefix} …` : "Teléfono";
  const text0 = isMail && viaSig(mailVia()) ? dropSignoff(t.text) : t.text;
  // phase: edit · checking (comprobando en Pipedrive) · count (5 s para deshacer) · sending · unknown (no se sabe si salió)
  let phase = "edit", left = SEND_DELAY, timer = null, finished = false, again = false;
  // clave de un solo uso por envío: si el pedido se repite, el servidor no lo manda dos veces. «Mandar igual» usa otra.
  let key = newKey();
  // primero el mensaje; «Armar con IA» es un enlace chico que despliega «¿Qué querés decirle?» (abierto si el mensaje va en blanco)
  const aiOpen = !String(text0 || "").trim();
  // «Conectar … para enviar desde acá» es el botón principal solo la primera vez que se ofrece; después va como enlace
  // debajo y el principal es «Abrir en Gmail» (o «Enviar» si ya está conectado)
  const offerSeen = !!loadPref("mail.offerSeen", false);
  const m = modal(`<div class="modal-h"><h3>${isMail ? icon("mail") : icon("whatsapp")} ${esc(t.label)}</h3><button class="icon-btn" id="mClose" aria-label="Cerrar">${icon("x")}</button></div>
    <p class="muted" style="margin:-8px 0 0">${esc(s.name)}</p>
    <label class="field"><span>Para</span><input class="inp" id="mTo" type="${isMail ? "email" : "tel"}" value="${esc(isMail ? defMail : defPhone)}" placeholder="${isMail ? "email@colegio.edu" : esc(pre)}"></label>
    ${isMail ? `<label class="field"><span>Asunto</span><input class="inp" id="mSub" value="${esc(t.subject || "")}" maxlength="200"></label>` : ""}
    <label class="field"><span>Mensaje</span><textarea class="inp" id="mText" rows="${isMail ? 12 : 8}">${esc(text0)}</textarea></label>
    ${/\[(día|hora|tu nombre)\]/.test(t.text) ? `<p class="callout warn" style="margin:0" id="mPh">${icon("alert")}<span>Completá lo que está entre corchetes antes de mandar.</span></p>` : ""}
    <div class="m-ai" id="mCtxBox"><button type="button" class="linkbtn m-ai-t" id="mAiT" aria-expanded="${aiOpen}" aria-controls="mAiBox">${icon("sparkles", "sm")} ${S.ai ? "Armar con IA" : "Armar el mensaje por mí"}</button>
      <div class="field" id="mAiBox" ${aiOpen ? "" : "hidden"}><label for="mCtx"><span>¿Qué querés decirle?</span></label>
      <textarea class="inp" id="mCtx" rows="2" placeholder="Ej: me pasó tu contacto el de sistemas; la concesionaria anterior dejó los planteles y quiero retomar"></textarea>
      <div class="row" style="justify-content:flex-start;margin-top:6px"><button class="btn sm" id="mAi">${icon("sparkles", "sm")} Armar mensaje</button><span class="faint" id="mAiNote" style="font-size:var(--fs-sm)">${S.ai ? "Usa lo que escribas y lo que dice Pipedrive (notas, tratos, contactos)." : "Arma el mensaje con tu contexto y la forma de escribir de la casa."}</span></div></div></div>
    <p class="callout err" id="mErr" role="alert" style="margin:0" hidden></p>
    <div class="stack mact" id="mAct"></div>`, { onClose: () => { if (timer) { clearInterval(timer); timer = null; if (!finished) toast("No se envió: cerraste antes de que salga", { type: "info" }); } } });
  const q = sel => m.querySelector(sel);
  const showErr = msg => { const e = q("#mErr"); e.innerHTML = `${icon("alert")}<span>${esc(msg)}</span>`; e.hidden = !msg; };
  const editable = on => { ["#mTo", "#mSub", "#mText", "#mCtx"].forEach(x => { const el = q(x); if (el) el.readOnly = !on; }); const ai = q("#mAi"); if (ai) ai.disabled = !on; };
  q("#mClose").onclick = () => m.close();
  q("#mAiT").onclick = e => { const box = q("#mAiBox"); box.hidden = !box.hidden; e.currentTarget.setAttribute("aria-expanded", String(!box.hidden)); if (!box.hidden) q("#mCtx").focus(); };
  // Armar el mensaje: con IA, con tu contexto + lo que sabe Pipedrive; sin IA, tu contexto en la plantilla de la casa
  q("#mAi").addEventListener("click", async e => {
    const b = e.currentTarget, ctx = q("#mCtx").value.trim(), cur = q("#mText").value.trim();
    if (!ctx && (!cur || !S.ai)) { q("#mCtx").focus(); return toast("Escribí qué querés decirle y lo armo", { type: "err" }); }
    b.disabled = true; b.innerHTML = `<span class="spin"></span> Armando…`;
    try {
      const r = await api(`/api/schools/${s.id}/draft`, { body: { channel: t.channel, purpose: t.label, contact: name || d.persons?.[0]?.name || "", base: t.text && cur === t.text.trim() && ctx ? "" : cur, context: ctx } });
      if (r.text) q("#mText").value = isMail && viaSig(mailVia()) ? dropSignoff(r.text) : r.text; if (r.subject && q("#mSub") && !q("#mSub").value.trim()) q("#mSub").value = r.subject;
      q("#mAiNote").textContent = r.note || (r.mode === "ia" ? "Listo. Revisalo antes de mandar." : "Armado con la plantilla de la casa. Revisalo antes de mandar.");
    } catch (err) { toast(err.message, { type: "err" }); }
    b.disabled = false; b.innerHTML = `${icon("sparkles", "sm")} Armar mensaje`;
  });
  // Después de abrir WhatsApp o Gmail: Registrar con el canal puesto y «Sin respuesta todavía» ya elegido con su próximo paso
  // (recién mandaste: lo normal es que todavía no haya respuesta), para guardar con un clic. Si ya contestó, se cambia.
  const afterOpen = () => {
    if (!logAfter || D.id !== s.id) return;
    const f = D.form;
    f.channel = isMail ? "mail" : "whatsapp"; D.tab = "log"; D.result = null; f.sent = true;
    if (!f.text) f.text = `Mandé ${isMail ? "mail" : "WhatsApp"}: ${t.label.toLowerCase()}.`;
    const pre = !f.outcome && !f.mail && !d.archive && S.outcomes.some(o => o.id === "no_answer");
    if (pre) { f.outcome = "no_answer"; f.lostReason = ""; f.sentPre = true; }
    draw(); toTabs(); showOutcomes();
    if (pre) suggest(s).then(() => { if (D.id === s.id && D.tab === "log" && !document.querySelector(".modal")) $("drawer").querySelector("#save")?.focus({ preventScroll: true }); });
  };
  const openGmail = () => { open(gmailLink({ to: q("#mTo").value.trim(), subject: q("#mSub").value, body: q("#mText").value })); finished = true; m.close(); afterOpen(); };
  // ¿se puede mandar desde acá? Lo que ya trae la ficha y, al abrir, el servidor (el mismo control que el envío, sin
  // escribir nada). Si el servidor no responde, no se frena: el envío lo vuelve a comprobar.
  let chk = null, checking = null;
  const local = isMail ? mailBlockLocal(s, d) : "";
  if (local) chk = { ok: false, error: local };
  const check = () => chk ? Promise.resolve(chk) : (checking ||= api(`/api/schools/${s.id}/mail/check`).catch(() => ({ ok: true, soft: true })).then(r => { chk = r; checking = null; if (m.isConnected && phase === "edit") drawAct(); return r; }));
  if (isMail && mailVia()) check();
  // el mail sale recién a los 5 s: hasta ahí se puede deshacer (o cerrar la ventana). Antes, se comprueba que se pueda.
  const startSend = async () => {
    const to = q("#mTo").value.trim(), subject = q("#mSub").value.replace(/\s+/g, " ").trim(), text = q("#mText").value;
    const bad = !to ? ["#mTo", "Poné a quién le mandás el mail."] : !MAIL_RE.test(to) ? ["#mTo", "Ese email no parece válido. Revisalo."] : !subject ? ["#mSub", "Poné el asunto."]
      : !text.trim() ? ["#mText", "El mensaje está vacío."] : PH_RE.test(subject) || PH_RE.test(text) ? [PH_RE.test(subject) ? "#mSub" : "#mText", "Completá lo que está entre corchetes ([día], [hora], [tu nombre]) antes de mandar."] : null;
    if (bad) { showErr(bad[1]); q(bad[0]).focus(); return; }
    showErr(""); note = ""; again = false;
    if (!chk) { phase = "checking"; editable(false); drawAct(); await check(); if (!m.isConnected) return; phase = "edit"; editable(true); }
    if (chk && !chk.ok) { drawAct(); return; }
    editable(false); phase = "count"; left = SEND_DELAY; drawAct(); q("#mUndo")?.focus();
    timer = setInterval(() => {
      left--; if (left > 0) { const c = q("#mCount"); if (c) c.textContent = left; return; }
      clearInterval(timer); timer = null; doSend({ to, subject, text });
    }, 1000);
  };
  let note = "", sentVia = "", pdForm = false; // pdForm: pegando el token de Pipedrive (en el lugar de los botones)
  const undo = () => { clearInterval(timer); timer = null; phase = "edit"; note = "No se envió. Seguí editando y mandalo cuando quieras."; editable(true); drawAct(); q("#mSend")?.focus(); };
  // si la ficha se abrió desde una tarea «Mail» de la agenda, se marca como hecha
  const act = D.activityId && d.activities?.find(a => a.id === D.activityId), completeId = act?.type === "task" && D.form?.completeAct !== false ? act.id : null;
  const doSend = async p => {
    phase = "sending"; m.locked = true; drawAct();
    try {
      sentVia = mailVia();
      const r = await api(`/api/schools/${s.id}/mail`, { body: { ...p, key, via: sentVia, completeActivityId: completeId, session: sessionRef() } });
      finished = true; m.locked = false; m.close();
      afterMailSent(s, r, { logAfter, completed: !!completeId });
    } catch (e) {
      m.locked = false; editable(true);
      // no se sabe si salió (Gmail o Pipedrive no respondieron) o esa clave ya se usó: no se vuelve a ofrecer «Enviar» con la misma clave
      if (e.code === "gmail_unknown" || e.code === "pd_unknown" || e.code === "mail_dup") { phase = "unknown"; drawAct(); showErr(e.message); return; }
      phase = "edit";
      // cambió algo en Pipedrive (de otra persona, cliente, archivado): queda el motivo en lugar de «Enviar»
      if (!e.code && [403, 404, 409].includes(e.status)) chk = { ok: false, error: e.message };
      if (e.code === "pd_maybe" || e.code === "pd_theirs") chk = { ok: false, error: e.message, code: e.code, candidates: e.data?.candidates || [] };
      await Promise.all([loadGmail(true), loadPdMail(true)]).catch(() => {}); // pudo vencer, desconectarse o pedir confirmar en este dispositivo
      drawAct(); showErr(chk && !chk.ok ? "" : e.message);
    }
  };
  function drawAct() {
    const a = q("#mAct"), g = S.gmail;
    if (!isMail) {
      a.innerHTML = `<div class="row"><button class="btn" id="mCopy">${icon("copy")} Copiar</button><button class="btn wa main" id="mGo">${icon("whatsapp")} Abrir WhatsApp</button></div>
        <p class="faint" style="margin:0;font-size:var(--fs-sm)">Se abre WhatsApp Web o la app. Si usás Volt, la conversación queda en el CRM automáticamente.</p>`;
      q("#mCopy").onclick = () => copy(q("#mText").value);
      q("#mGo").onclick = () => { const to = q("#mTo").value.trim(); if (!to) return toast("Poné el número", { type: "err" }); open(waLink(to, q("#mText").value, s.country)); finished = true; m.close(); afterOpen(); };
      return;
    }
    if (phase === "count") { a.innerHTML = `<div class="send-bar" role="status" aria-live="polite">${icon("send")}<span>Enviando en <b id="mCount">${left}</b> s</span><button class="btn" id="mUndo">Deshacer</button></div>`; q("#mUndo").onclick = undo; return; }
    q("#mClose").disabled = phase === "sending";
    if (phase === "sending" || phase === "checking") { a.innerHTML = `<div class="send-bar" role="status"><span class="spin"></span><span>${phase === "sending" ? sentVia === "pipedrive" ? "Enviando desde tu Pipedrive…" : "Enviando desde tu Gmail…" : "Comprobando en Pipedrive…"}</span></div>`; return; }
    if (phase === "unknown") {
      const sentUrl = sentVia === "pipedrive" ? `${S.pdmail?.pdWeb || S.pdWeb || ""}/mail/sent` : "https://mail.google.com/mail/#sent";
      a.innerHTML = `<div class="row"><a class="btn" href="${esc(sentUrl)}" target="_blank" rel="noopener">${icon("mail")} Ver Enviados</a>
        ${again ? `<button class="btn" id="mNo">Cancelar</button><button class="btn primary" id="mAgain">Sí, mandarlo de nuevo</button>` : `<button class="btn" id="mAgain">Mandar igual</button>`}</div>
        <p class="faint mail-note">${again ? "Si ya salió, le llega dos veces." : "Si salió, cerrá y registralo en Registrar. Si no está en Enviados, mandalo de nuevo."}</p>`;
      q("#mNo")?.addEventListener("click", () => { again = false; drawAct(); });
      q("#mAgain").onclick = () => { if (!again) { again = true; drawAct(); q("#mAgain")?.focus(); return; } key = newKey(); phase = "edit"; startSend(); };
      return;
    }
    const p = S.pdmail, via = mailVia(), send = !!via, blocked = send && chk && !chk.ok;
    // Pipedrive primero: conectar (o confirmar en este dispositivo). Gmail solo si ya lo tenías conectado (y no Pipedrive).
    const pdOffer = !via && pdCanConnect(p), pdConfirm = pdOffer && p.connected && !p.verified;
    const gConfirm = !via && !pdOffer && needsConfirm(g), gConnect = !via && !pdOffer && !gConfirm && g?.enabled && !g.readOnly && !g.config;
    // pegar el token de Pipedrive: dos pasos en el lugar de los botones; al conectar, vuelve con «Enviar»
    if (pdForm && pdCanConnect(p) && !pdReady(p)) {
      a.innerHTML = tokenFormHtml(p, { confirm: !!p.connected });
      const before = q("#mText").value;
      bindTokenForm(a, {
        onCancel: () => { pdForm = false; drawAct(); q("#mConnect")?.focus(); },
        onDone: () => {
          pdForm = false; if (!m.isConnected) return;
          if (mailVia()) { note = `Pipedrive conectado${S.pdmail.name ? ` como ${S.pdmail.name}` : ""}. Ya podés enviar.`; showErr(""); check(); }
          // con firma, la despedida con tu nombre sobra (solo si no la tocaste)
          if (viaSig(mailVia()) && q("#mText").value === before) q("#mText").value = dropSignoff(before);
          drawAct(); q("#mSend")?.focus();
        },
      });
      return;
    }
    const wait = !pdOffer && gmailWaiting();
    const sigHtml = viaSig(via), sigSrc = via === "pipedrive" ? p.signatureSource : g?.signatureSource;
    // conectar por primera vez (no confirmar lo ya conectado): ya se ofreció antes → enlace debajo, no el botón principal
    const firstTime = (pdOffer && !pdConfirm) || gConnect, soft = !blocked && firstTime && offerSeen && !wait;
    if (!blocked && firstTime && !offerSeen) save("mail.offerSeen", true);
    const connectText = pdOffer ? "Conectar Pipedrive para enviar desde acá" : "Conectar Gmail para enviar desde acá";
    a.innerHTML = `<div class="row"><button class="btn" id="mCopy">${icon("copy")} Copiar</button>
      ${send && !blocked ? `<button class="btn ghost" id="mGo">Abrir en Gmail</button><button class="btn primary" id="mSend">${icon("send")} Enviar</button>`
        : !blocked && !soft && (pdOffer || gConfirm || gConnect) ? `<button class="btn" id="mGo">Abrir en Gmail</button><button class="btn primary" id="mConnect">${wait ? `<span class="spin"></span> Esperando a Google…`
          : pdConfirm ? `${icon("lock")} Confirmá que sos vos` : gConfirm ? `${icon("mail")} Confirmar tu Gmail en este dispositivo` : `${icon("mail")} ${connectText}`}</button>`
        : `<button class="btn primary" id="mGo">${icon("mail")} Abrir en Gmail</button>`}</div>
      ${soft ? `<p class="faint mail-note"><button type="button" class="linkbtn" id="mConnect">${connectText}</button>: una vez, y después mandás con un clic, con tu firma.</p>` : ""}
      ${note ? `<p class="mail-note" role="status" style="color:var(--info)">${esc(note)}</p>` : ""}
      ${blocked && chk.code === "pd_maybe" ? `<p class="mail-block" role="status">${icon("alert", "sm")}<span><b>Antes de mandar:</b> ${esc(chk.error)}</span><button class="btn sm" id="mEx">Ver cuáles</button></p>`
        : blocked ? `<p class="mail-block" role="status">${icon("alert", "sm")}<span><b>Desde acá no se envía.</b> ${esc(chk.error)}</span></p>`
        : via === "pipedrive" ? `<p class="mail-how">${icon("checkCircle", "sm")}<span>Sale de tu correo de Pipedrive${p.name ? ` (${esc(p.name)})` : ""}, ligado al prospecto o al trato, y queda en el historial.</span></p>
          ${sigHtml ? `<details class="gm-sig"><summary>${esc(SIG_LABEL[sigSrc] || SIG_LABEL.armada)}</summary>${sigPreview(sigHtml)}</details>` : `<p class="faint mail-note">Sale sin firma: armala en tu perfil.</p>`}`
        : via === "gmail" ? `<p class="mail-how">${icon("checkCircle", "sm")}<span>Sale de tu Gmail (${esc(g.email)}) y queda en Pipedrive y en el historial.</span></p>
          ${sigHtml ? `<details class="gm-sig"><summary>${esc(sigLabel(g))}</summary>${sigPreview(sigHtml)}</details>` : `<p class="faint mail-note">Tu Gmail no tiene firma: sale sin firma. Podés armar una en tu perfil.</p>`}
          ${pdCanConnect(p) && !p.connected ? `<p class="faint mail-note">Mejor desde Pipedrive (queda en su correo, ligado al prospecto): <button type="button" class="linkbtn" id="mPdLink">Conectar Pipedrive</button></p>` : ""}`
        : p?.readOnly || g?.readOnly ? `<p class="faint mail-note">Modo solo lectura: desde acá no se envía. Usá «Abrir en Gmail».</p>`
        : pdConfirm ? `<p class="faint mail-note">Tu Pipedrive ya está conectado. En este dispositivo pegá de nuevo tu token una vez y después mandás con un clic.</p>`
        : pdOffer && soft ? (p.mismatch ? `<p class="faint mail-note">La conexión guardada no es de tu usuario de Pipedrive.</p>` : "")
        : pdOffer ? `<p class="faint mail-note">${p.mismatch ? "La conexión guardada no es de tu usuario de Pipedrive. " : ""}Pegás tu token de Pipedrive una vez y mandás con un clic desde tu casilla de Pipedrive, con tu firma. Queda ligado al prospecto y en el historial.</p>`
        : p?.noUser ? `<p class="faint mail-note">Tu email no es usuario de Pipedrive: pedí que te den de alta. Mientras, usá «Abrir en Gmail».</p>`
        : g?.config ? `<p class="faint mail-note">Gmail está mal configurado en el servidor (avisale al administrador). Mientras, usá «Abrir en Gmail».</p>`
        : gConfirm ? `<p class="faint mail-note">Tu Gmail (${esc(g.email)}) ya está conectado. En este dispositivo confirmalo una vez con Google y después mandás con un clic.</p>`
        : gConnect && soft ? (g.expired ? `<p class="faint mail-note">Tu conexión con Gmail venció: conectalo de nuevo.</p>` : "")
        : gConnect ? `<p class="faint mail-note">${g.expired ? "Tu conexión con Gmail venció: conectalo de nuevo. " : ""}Lo conectás una vez y después mandás con un clic, con tu firma. Sale de tu Gmail y queda en Pipedrive y en el historial.</p>`
        : `<p class="faint mail-note">Para enviar desde acá falta configurar el servidor (avisale al administrador).</p>`}`;
    q("#mCopy").onclick = () => copy(q("#mText").value);
    q("#mGo").onclick = openGmail;
    // ya hay algo parecido en Pipedrive: se elige (o «Es otro colegio») y se vuelve a comprobar
    q("#mEx")?.addEventListener("click", async () => { if (await askPdExisting(s, chk.candidates || [])) { chk = null; phase = "checking"; editable(false); drawAct(); await check(); if (!m.isConnected) return; phase = "edit"; editable(true); drawAct(); } });
    q("#mSend")?.addEventListener("click", startSend);
    // Pipedrive: pegar el token acá mismo. Gmail (si no se puede Pipedrive): su ventana, sin perder lo escrito.
    const openPd = () => { pdForm = true; note = ""; drawAct(); };
    const connectG = async () => {
      const before = q("#mText").value;
      const pr = connectGmail({ quiet: true }); note = ""; drawAct();
      const r = await pr; if (!m.isConnected) return;
      const v = mailVia();
      showErr(v ? "" : r.error || "");
      if (v) { note = `Gmail conectado como ${S.gmail.email}. Ya podés enviar.`; check(); }
      if (viaSig(v) && q("#mText").value === before) q("#mText").value = dropSignoff(before);
      drawAct(); q("#mSend")?.focus();
    };
    q("#mConnect")?.addEventListener("click", () => pdOffer ? openPd() : connectG());
    q("#mPdLink")?.addEventListener("click", openPd);
  }
  drawAct();
  // en el celular no se abre el teclado de entrada: el foco va a la acción principal
  if (coarse()) setTimeout(() => (q("#mSend") || q("#mGo"))?.focus(), 0);
}
// Después de enviar: Registrar se abre con el mail ya registrado (canal mail y lo enviado) para elegir el próximo paso
function afterMailSent(s, r, { logAfter, completed }) {
  if (r.school) patchSchool(r.school);
  gotLead(s, r);
  S.today = null; S.agenda = null;
  if (S.session) S.session.done++;
  import("../explore.js").then(x => x.refreshExplore());
  // si ya estabas cargando otro contacto en Registrar (con resultado o comentario), no se pisa: solo el aviso
  const busy = D.id === s.id && !D.result && !D.form?.mail && (D.form?.outcome || (D.form?.text?.trim() && !D.form?.sent));
  const warns = (r.done || []).filter(x => x.warn), here = D.id === s.id && logAfter && !busy, pdOk = r.logged?.pipedrive !== false;
  // con Registrar abierto, lo dice ahí (el aviso flotante taparía el pie); si no, aviso
  if (!here) { toast(`Mail enviado a ${r.mail.to}${pdOk ? ". Quedó en Pipedrive" : ""}`); if (warns.length) toast(warns.map(x => x.label).join(" "), { type: "err" }); }
  if (D.id !== s.id) return;
  if (completed) D.activityId = null;
  if (here) {
    // la actividad de la agenda desde la que se abrió la ficha (si el envío no la marcó hecha): se ofrece marcarla
    const a = !completed && D.activityId ? (D.data?.activities || []).find(x => x.id === D.activityId) : null;
    const f = newForm();
    Object.assign(f, { channel: "mail", sent: true, text: `Mandé mail: ${r.mail.subject}`, why: !r.mail.autoNext && !r.mail.pendingNext ? r.suggest?.why || "" : "",
      mail: { ...r.mail, done: r.done || [], logged: r.logged || null, fallback: r.fallback || null, where: r.where || null, act: a && a.type !== "meeting" ? { id: a.id, subject: a.subject, type: a.type } : null } });
    f.completeAct = !!f.mail.act;
    f.next = mailDefaultNext(f);
    D.form = f; D.tab = "log"; D.result = null; draw(); toTabs();
  }
  // la ficha al día (Historial con el mail, pendientes con el próximo paso)
  api(`/api/schools/${s.id}`).then(nd => { if (D.id === s.id) { D.data = nd; keepScroll(draw); } }).catch(() => {});
}
