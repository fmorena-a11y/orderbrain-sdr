// Pipedrive de cada persona para mandar mails desde la ficha: estado, «Conectá tu Pipedrive» (pegar una vez el token API
// personal), «Confirmá que sos vos» en otro dispositivo, desconectar y «Tu firma» (perfil). El servidor nunca devuelve el
// token. Los mails salen de la casilla que la persona tiene conectada en Pipedrive, ligados al prospecto o al trato
// (lib/pdtoken.js + lib/pdmcp.js).
import { S, api, esc, icon, toast } from "./core.js";
import { loadGmail, gmailReady, gmailProfileHtml, bindGmailProfile, sigPreview } from "./gmail.js";

let loading = null;
export function loadPdMail(force = false) {
  if (S.pdmail && !force) return Promise.resolve(S.pdmail);
  if (loading && !force) return loading;
  loading = api("/api/pipedrive/mail").then(p => (S.pdmail = p), () => (S.pdmail = S.pdmail || { enabled: false, failed: true })).finally(() => { loading = null; });
  return loading;
}
// listo para enviar desde este dispositivo: conectado (su cuenta) y confirmado en esta sesión
export const pdReady = p => !!(p?.enabled && p.connected && p.verified && !p.readOnly);
// se puede ofrecer conectar o confirmar
export const pdCanConnect = p => !!(p?.enabled && !p.noUser && !p.readOnly);
// la firma que va, dicha corta (en el modal del mail)
export const SIG_LABEL = { armada: "Se agrega tu firma (armada con tu perfil)", pegada: "Se agrega la firma que pegaste", perfil: "Se agrega la firma que pegaste", gmail: "Se agrega tu firma de Gmail" };

// ---------- pegar el token: dos pasos cortos, en el lugar (modal del mail o perfil), sin otra ventana
// confirm: ya está conectado y en este dispositivo hay que probar que sos vos (se pega de nuevo, el mismo usuario).
// Un <div> y no un <form>: en el perfil va adentro de su formulario (no se pueden anidar), así que Enter se maneja acá.
export function tokenFormHtml(p, { confirm = false } = {}) {
  const url = p?.tokenUrl || `${S.pdWeb || ""}/settings/api`;
  return `<div class="pd-form" id="pdForm" role="group" aria-label="${confirm ? "Confirmá que sos vos" : "Conectá tu Pipedrive"}" data-confirm="${confirm ? 1 : 0}">
    <b>${confirm ? "Confirmá que sos vos" : "Conectá tu Pipedrive"}</b>
    ${confirm ? `<p class="mail-note">En este dispositivo, pegá de nuevo tu token de Pipedrive. Tiene que ser el de tu usuario.</p>` : ""}
    <ol class="pd-steps">
      <li><a href="${esc(url)}" target="_blank" rel="noopener">Abrí tu token en Pipedrive ${icon("external", "sm")}</a><small class="faint">Tu foto › Configuración personal › API</small></li>
      <li>Copialo y pegalo acá.<small class="faint">Se guarda cifrado y nadie más lo ve.${p?.demo ? " En el demo sirve cualquier texto." : ""}</small></li>
    </ol>
    <input class="inp" id="pdTok" type="password" aria-label="Tu token de Pipedrive" autocomplete="off" spellcheck="false" autocapitalize="off" placeholder="Pegá tu token" maxlength="200">
    <p class="mail-note pd-err" id="pdErr" role="alert" hidden></p>
    <div class="row" style="justify-content:flex-start;gap:8px"><button type="button" class="btn primary" id="pdGo">${confirm ? "Confirmar" : "Conectar"}</button><button type="button" class="btn ghost" id="pdNo">Cancelar</button></div>
  </div>`;
}
// onDone(estado) al conectar; onCancel al cancelar. El token va solo al servidor y el campo se vacía.
export function bindTokenForm(box, { onDone, onCancel }) {
  const f = box.querySelector("#pdForm"); if (!f) return;
  const inp = f.querySelector("#pdTok"), go = f.querySelector("#pdGo"), err = f.querySelector("#pdErr"), label = f.dataset.confirm === "1" ? "Confirmar" : "Conectar";
  f.querySelector("#pdNo").onclick = () => onCancel?.();
  const submit = async () => {
    if (go.disabled) return;
    const token = inp.value.trim();
    if (!token) { err.textContent = "Pegá tu token de Pipedrive."; err.hidden = false; inp.focus(); return; }
    go.disabled = true; go.innerHTML = `<span class="spin"></span> Comprobando…`; err.hidden = true;
    try {
      S.pdmail = await api("/api/pipedrive/connect", { body: { token } });
      inp.value = "";
      onDone?.(S.pdmail);
    } catch (x) { err.textContent = x.message; err.hidden = false; go.disabled = false; go.textContent = label; inp.select(); }
  };
  go.onclick = submit;
  inp.onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); submit(); } };
  setTimeout(() => inp.focus(), 0);
}
export async function disconnectPipedrive() {
  S.pdmail = await api("/api/pipedrive/disconnect", { body: {} });
  toast("Pipedrive desconectado");
  return S.pdmail;
}

// ---------- perfil: «Mail desde la app» (Pipedrive, «Tu firma» y Gmail como otra opción)
const MODE_LABEL = { armada: "Armada", pegada: "Pegada de Pipedrive", gmail: "La de Gmail" };
const MODE_SUM = { armada: "armada con tu perfil", pegada: "la de Pipedrive, pegada", gmail: "la de tu Gmail" };
let sigMode = null, formOpen = false; // lo elegido en el perfil mientras está abierto (sin guardar)
export function mailProfileHtml(p, g) {
  if (!p) return `<p class="faint" style="margin:0">Cargando…</p>`;
  const ready = pdReady(p), sig = p.sig || {};
  const st = !p.enabled ? `<p class="muted" style="margin:0;font-size:13.5px">${p.failed ? "No pude leer tu conexión con Pipedrive. Probá de nuevo en un rato." : "Para enviar desde Pipedrive falta configurar el servidor (avisale al administrador)."}</p>`
    : p.noUser ? `<p class="muted" style="margin:0;font-size:13.5px">Tu email no es usuario de Pipedrive: pedí que te den de alta.</p>`
    : formOpen && !ready && pdCanConnect(p) ? tokenFormHtml(p, { confirm: p.connected })
    : `<div class="gm-st">${ready
      ? `<span>${icon("checkCircle", "sm")} Pipedrive conectado${p.name ? ` como <b>${esc(p.name)}</b>` : ""}${p.demo ? " (simulado)" : ""}</span><button type="button" class="linkbtn" id="pdOff">Desconectar</button>`
      : p.connected ? `<span class="muted">Tu Pipedrive está conectado. En este dispositivo confirmá que sos vos.</span><button type="button" class="btn sm" id="pdOn">${icon("lock", "sm")} Confirmá que sos vos</button>`
      : `<span class="muted">${p.mismatch ? "La conexión guardada no es de tu usuario de Pipedrive: conectalo de nuevo." : "Conectalo una vez y mandás los mails de la ficha desde tu casilla de Pipedrive, con un clic."}</span><button type="button" class="btn sm" id="pdOn">${icon("mail", "sm")} Conectar Pipedrive</button>`}</div>`;
  const modes = ["armada", "pegada", ...(gmailReady(g) ? ["gmail"] : [])];
  const mode = modes.includes(sigMode) ? sigMode : modes.includes(sig.mode) ? sig.mode : "armada";
  const prev = mode === "armada" ? sig.built : mode === "pegada" ? sig.custom : g?.signatureSource === "gmail" ? g.signature : "";
  const firma = p.verified ? `<details class="gm-sig" id="pfSig"${sigMode ? " open" : ""}><summary>Tu firma · <span class="faint">${esc(MODE_SUM[sig.mode] || MODE_SUM.armada)}</span></summary>
      <div class="seg" role="radiogroup" aria-label="Qué firma va" style="margin-top:8px">${modes.map(k => `<button type="button" role="radio" data-sig="${k}" aria-checked="${k === mode}" aria-pressed="${k === mode}">${esc(MODE_LABEL[k])}</button>`).join("")}</div>
      ${mode === "armada" ? `<div class="sig-grid">
          <label class="field"><span>Cargo</span><input class="inp" id="sgTitle" value="${esc(sig.title || "")}" maxlength="80" placeholder="${esc(sig.titleDefault || "Sales Development Representative")}"></label>
          <label class="field"><span>Teléfono <span class="faint">opcional</span></span><input class="inp" id="sgPhone" type="tel" value="${esc(sig.phone || "")}" maxlength="40" placeholder="+598 99 123 456" autocomplete="tel"></label></div>
        <p class="faint" style="margin:6px 0 0;font-size:12.5px">Con el isotipo de OrderEAT, tu nombre, tu email y www.ordereat.com, como la de Pipedrive.</p>`
      : mode === "pegada" ? `<label class="field" style="margin-top:8px"><span>Pegá tu firma de Pipedrive <span class="faint">texto o HTML</span></span>
          <textarea class="inp" id="sgCustom" rows="4" placeholder="En Pipedrive: Configuración personal › Correo › Firma. Copiala y pegala acá.">${esc(sig.custom || "")}</textarea></label>`
      : `<p class="faint" style="margin:8px 0 0;font-size:12.5px">La que tenés en Gmail. Solo va en los mails que salen por Gmail.</p>`}
      ${prev ? sigPreview(prev) : ""}
      <div class="row" style="justify-content:flex-start;gap:8px;margin-top:8px"><button type="button" class="btn sm" id="sgSave">Guardar firma</button></div>
      <p class="faint" style="margin:6px 0 0;font-size:12.5px">Pipedrive no agrega tu firma a los mails que manda la app: va esta.</p>
    </details>` : p.enabled && !p.noUser && !formOpen ? `<p class="faint" style="margin:0;font-size:12.5px">La firma se elige después de conectar Pipedrive.</p>` : "";
  const alt = g?.enabled ? `<details class="gm-sig"><summary>Gmail · <span class="faint">otra opción, si no conectás Pipedrive</span></summary><div class="gm-box" id="pfGmail" style="margin-top:8px">${gmailProfileHtml(g, { signature: false })}</div></details>` : "";
  return st + firma + alt;
}
export function bindMailProfile(box, redraw) {
  const q = s => box.querySelector(s);
  q("#pdOn")?.addEventListener("click", () => { formOpen = true; redraw(); });
  bindTokenForm(box, { onDone: p => { formOpen = false; toast(`Pipedrive conectado${p.name ? ` como ${p.name}` : ""}`); redraw(); }, onCancel: () => { formOpen = false; redraw(); } });
  q("#pdOff")?.addEventListener("click", async () => { try { await disconnectPipedrive(); } catch (x) { toast(x.message, { type: "err" }); } redraw(); });
  box.querySelectorAll("[data-sig]").forEach(b => b.onclick = () => { sigMode = b.dataset.sig; redraw(); box.querySelector(`[data-sig="${sigMode}"]`)?.focus(); });
  q("#sgSave")?.addEventListener("click", async e => {
    const b = e.currentTarget, mode = box.querySelector('[data-sig][aria-pressed="true"]')?.dataset.sig || "armada";
    const body = { mode, ...(q("#sgTitle") ? { title: q("#sgTitle").value } : {}), ...(q("#sgPhone") ? { phone: q("#sgPhone").value } : {}), ...(q("#sgCustom") ? { signature: q("#sgCustom").value } : {}) };
    b.disabled = true;
    try { const r = await api("/api/mail/signature", { body }); S.pdmail = r.pipedrive; S.gmail = r.gmail; sigMode = null; toast("Firma guardada"); redraw(); box.querySelector("#pfSig")?.setAttribute("open", ""); }
    catch (x) { toast(x.message, { type: "err" }); b.disabled = false; }
  });
  const gbox = q("#pfGmail");
  if (gbox) bindGmailProfile(gbox, redraw);
}
export const resetSigMode = () => { sigMode = null; formOpen = false; };
// estado de las dos vías al día (el modal del mail y el perfil)
export const loadMail = (force = false) => Promise.all([loadPdMail(force), loadGmail(force)]);
