// Gmail de cada persona: estado, conectar (ventana de Google), desconectar y firma. El servidor nunca manda tokens.
import { S, api, esc, icon, toast } from "./core.js";

let loading = null;
export function loadGmail(force = false) {
  if (S.gmail && !force) return Promise.resolve(S.gmail);
  if (loading && !force) return loading;
  loading = api("/api/gmail").then(g => (S.gmail = g), () => (S.gmail = S.gmail || { enabled: false, failed: true })).finally(() => { loading = null; });
  return loading;
}
// Abre la conexión con Google en otra ventana: así no se pierde lo que estás escribiendo. La ventana avisa por
// BroadcastChannel (y postMessage) cuando termina; como Google puede cortar el vínculo entre ventanas, además se consulta
// el estado cada 2,5 s mientras se espera (hasta 10 minutos). Si el navegador bloquea la ventana, va en esta pestaña.
let waiting = null;
// Lo que puede salir mal al conectar: el servidor manda solo el código y acá va el texto (nunca texto de la dirección).
export const GMAIL_ERR = {
  state: "No pude validar la conexión con Google. Probá de nuevo desde la app.",
  mismatch: "Conectaste otra cuenta de Gmail. Usá la misma con la que entrás a la app.",
  denied: "No diste permiso: el mail no se puede enviar desde acá. Podés seguir con «Abrir en Gmail».",
  scope: "Para enviar desde acá tenés que aceptar «Enviar correo electrónico en tu nombre». Probá de nuevo.",
  config: "Para enviar desde acá falta configurar Gmail (lo hace el administrador).",
  session: "Iniciá sesión en la app y conectá Gmail de nuevo.",
  other: "No se pudo conectar Gmail. Probá de nuevo.",
};
const errText = code => GMAIL_ERR[code] || GMAIL_ERR.other;
// listo para enviar desde este dispositivo (conectado y confirmado con Google en esta sesión)
export const gmailReady = g => !!(g?.connected && g.verified);
// quiet: sin avisos flotantes (el modal del mail muestra el estado y el error en su lugar). Devuelve el estado (y error, si hubo).
export function connectGmail({ quiet = false } = {}) {
  waiting?.stop(null);
  const w = open("/auth/gmail/start?popup=1", "ob-gmail", "popup,width=520,height=700");
  if (!w) { location.href = "/auth/gmail/start"; return new Promise(() => {}); }
  return new Promise(resolve => {
    const bc = "BroadcastChannel" in window ? new BroadcastChannel("ob-gmail") : null;
    const stop = async r => {
      if (waiting?.stop !== stop) return; waiting = null;
      removeEventListener("message", onMsg); bc?.close(); clearInterval(t); clearTimeout(cap);
      const g = await loadGmail(true), err = gmailReady(g) ? "" : r && r.ok === false ? errText(r.code) : "";
      if (!quiet && gmailReady(g)) toast(`Gmail conectado como ${g.email}`);
      else if (!quiet && err) toast(err, { type: "err" });
      resolve({ ...g, error: err });
    };
    const onMsg = e => { if (e.origin === location.origin && e.data?.type === "ob-gmail") stop(e.data); };
    addEventListener("message", onMsg);
    if (bc) bc.onmessage = e => e.data?.type === "ob-gmail" && stop(e.data);
    const t = setInterval(async () => { const g = await api("/api/gmail").catch(() => null); if (gmailReady(g)) { S.gmail = g; stop({ ok: true }); } }, 2500);
    const cap = setTimeout(() => stop(null), 10 * 60e3);
    waiting = { stop };
  });
}
export const gmailWaiting = () => !!waiting;
export const cancelGmailWait = () => waiting?.stop(null);
export async function disconnectGmail() {
  S.gmail = await api("/api/gmail/disconnect", { body: {} });
  toast("Gmail desconectado");
  return S.gmail;
}
// Vuelta de Google sin ventana aparte (?gmail=ok|error&m=código): aviso con un texto fijo y se limpia la dirección.
// «ok» solo se cree si el servidor dice que quedó conectado (un link con ?gmail=ok no muestra nada).
export function gmailReturn() {
  const q = new URLSearchParams(location.search), st = q.get("gmail"); if (!st) return;
  if (st === "ok") loadGmail(true).then(g => { if (gmailReady(g)) toast(`Gmail conectado como ${g.email}`); });
  else if (st === "error") toast(errText(q.get("m")), { type: "err" });
  q.delete("gmail"); q.delete("m");
  history.replaceState(history.state, "", location.pathname + (q.toString() ? `?${q}` : "") + location.hash);
}
// La firma ya viene saneada del servidor (solo etiquetas básicas, links e imágenes https): se muestra como va a salir.
export const sigPreview = html => html ? `<div class="sig-prev" aria-label="Vista previa de la firma">${html}</div>` : "";
export const sigLabel = g => g.signatureSource === "perfil" || g.signatureSource === "pegada" ? "Se agrega la firma que pegaste" : g.signatureSource === "armada" ? "Se agrega tu firma (armada con tu perfil)" : g.signatureSource === "gmail" ? "Se agrega tu firma de Gmail" : "";

// Sección «Mail» del perfil: estado de Gmail y firma (la que usás en Pipedrive, si querés que mande sobre la de Gmail).
// La firma y desconectar solo con Gmail confirmado en esta sesión (el servidor lo exige igual).
// signature: false cuando la firma se elige en «Tu firma» (public/js/pdmail.js), para Pipedrive y Gmail a la vez.
export function gmailProfileHtml(g, { signature = true } = {}) {
  if (!g) return `<p class="faint" style="margin:0">Cargando…</p>`;
  if (!g.enabled) return `<p class="muted" style="margin:0;font-size:13.5px">Para enviar mails desde la app falta configurar Gmail (lo hace el administrador).</p>`;
  if (g.config) return `<p class="muted" style="margin:0;font-size:13.5px">Gmail está mal configurado en el servidor (avisale al administrador).</p>`;
  const ready = gmailReady(g);
  return `<div class="gm-st">${ready
      ? `<span>${icon("checkCircle", "sm")} Gmail conectado como <b>${esc(g.email)}</b>${g.demo ? " (simulado)" : ""}</span><button type="button" class="linkbtn" id="gmOff">Desconectar</button>`
      : g.connected ? `<span class="muted">Tu Gmail (${esc(g.email)}) está conectado. En este dispositivo confirmalo una vez.</span><button type="button" class="btn sm" id="gmOn">${icon("mail", "sm")} Confirmar Gmail</button>`
      : `<span class="muted">${g.expired ? "Tu conexión con Gmail venció." : "Conectalo una vez y mandás mails desde la ficha, con tu firma."}</span><button type="button" class="btn sm" id="gmOn">${icon("mail", "sm")} Conectar Gmail</button>`}</div>
    ${!signature ? "" : ready ? `<details class="gm-sig"${g.custom ? " open" : ""}><summary>Firma de los mails · <span class="faint">${esc(g.custom ? "la de tu perfil" : g.signatureSource === "gmail" ? "la de tu Gmail" : "tu Gmail no tiene firma")}</span></summary>
      ${sigPreview(g.signature)}
      <label class="field" style="margin-top:8px"><span>Pegá la misma firma que usás en Pipedrive <span class="faint">texto o HTML · manda sobre la de Gmail</span></span>
        <textarea class="inp" id="gmSig" rows="4" placeholder="Juan Pérez · SDR · OrderEAT&#10;+52 55 1234 5678 · ordereat.com">${esc(g.custom || "")}</textarea></label>
      <div class="row" style="justify-content:flex-start;gap:8px;margin-top:6px"><button type="button" class="btn sm" id="gmSigSave">Guardar firma</button>${g.custom ? `<button type="button" class="btn sm ghost" id="gmSigClear">Usar la de Gmail</button>` : ""}</div>
      <p class="faint" style="margin:6px 0 0;font-size:12.5px">Pipedrive no deja leer tu firma: copiala desde Pipedrive (Configuración del correo) y pegala acá.</p>
    </details>` : `<p class="faint" style="margin:0;font-size:12.5px">La firma se elige después de conectar Gmail: por defecto, la de tu Gmail.</p>`}`;
}
export function bindGmailProfile(box, redraw) {
  const q = s => box.querySelector(s);
  q("#gmOn")?.addEventListener("click", async e => { const b = e.currentTarget; b.disabled = true; b.innerHTML = `<span class="spin"></span> Esperando a Google…`; await connectGmail(); redraw(); });
  q("#gmOff")?.addEventListener("click", async () => { try { await disconnectGmail(); } catch (x) { toast(x.message, { type: "err" }); } redraw(); });
  const saveSig = async v => {
    try { S.gmail = await api("/api/gmail/signature", { body: { signature: v } }); toast(v ? "Firma guardada" : "Vuelve la firma de Gmail"); redraw(); }
    catch (x) { toast(x.message, { type: "err" }); }
  };
  q("#gmSigSave")?.addEventListener("click", () => saveSig(q("#gmSig").value));
  q("#gmSigClear")?.addEventListener("click", () => saveSig(""));
}
