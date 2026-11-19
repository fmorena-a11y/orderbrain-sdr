// Tu Google (pedido del líder de SDR: «que automáticamente se conecte con el Calendar y el Drive cuando entre en su cuenta de
// Google»): el botón «Entrar con Google» de la pantalla de entrada (un solo paso: entra y quedan conectados mail, calendario
// y planillas), el aviso discreto «Conectá tu Google» para quien entra con su código y «Tu Google» en el perfil (conectado
// como…, qué permisos tiene, dar los que faltan, reconectar, desconectar). Sin cliente OAuth en el servidor no se muestra nada.
import { S, esc, icon, toast, save, loadPref } from "./core.js";
import { loadGmail, connectGmail, disconnectGmail } from "./gmail.js";
import { PERM_ORDER, PERM_LABEL, PERM_ICON, PERM_WHAT, permList, loginError, googleState, noticeDue, NOTICE_TEXT, partialText, connectedText } from "./googlefmt.js";

const G_LOGO = `<svg class="g-logo" viewBox="0 0 48 48" width="18" height="18" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>`;

// ---------- pantalla de entrada
// el botón (un enlace: va a Google en esta misma pestaña y vuelve ya adentro); withCode: abajo queda el ingreso con código
export const googleLoginHtml = ({ withCode = false } = {}) => `<a class="btn lg g-login" id="gLogin" href="/auth/google/start">${G_LOGO}<span>Entrar con Google</span></a>
  <small class="g-login-sub">Entrás y quedan conectados tu mail, tu calendario y tus planillas.</small>${withCode ? `<div class="login-or" aria-hidden="true"><span>o con tu código personal</span></div>` : ""}`;
// Vuelta de Google (?google=ok|error&m=código): devuelve el texto del error para la pantalla de entrada (o "") y limpia la dirección.
export function googleBack(domain = "") {
  const q = new URLSearchParams(location.search), st = q.get("google"); if (!st) return { st: "", error: "" };
  const error = st === "error" ? loginError(q.get("m"), domain) : "";
  q.delete("google"); q.delete("m");
  history.replaceState(history.state, "", location.pathname + (q.toString() ? `?${q}` : "") + location.hash);
  return { st, error };
}

// ---------- conectar (o dar permisos, o reconectar): la ventana de Google de siempre, y después se dice cómo quedó
const changed = () => dispatchEvent(new Event("ob:google"));
export async function connectGoogle() {
  hideGoogleNote();
  const g = await connectGmail({ quiet: true }), st = googleState(g);
  if (g.error && !(st === "ok")) toast(g.error, { type: "err" });
  else if (st === "ok" || st === "partial") toast(connectedText(g));
  changed();
  return g;
}

// ---------- aviso discreto: «Conectá tu Google» (una vez por día como mucho, se puede cerrar)
const today = () => { const d = new Date(), p = n => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
export function hideGoogleNote() { document.getElementById("gnote")?.remove(); }
// Dónde va: en el menú de la izquierda, arriba de tu cuenta (escritorio con el menú entero: no tapa nada); con el menú
// achicado, en tablet o en el celular, una tarjeta chica abajo a la izquierda (arriba de la barra en el celular).
const inRail = () => matchMedia("(min-width: 1081px)").matches && !document.getElementById("app")?.classList.contains("rail-mini");
function place(d) {
  const foot = document.querySelector(".rail-foot"), rail = inRail() && !!foot, to = rail ? foot : document.body;
  d.classList.toggle("in-rail", rail);
  if (d.parentElement !== to) rail ? foot.prepend(d) : document.body.appendChild(d);
}
addEventListener("resize", () => { const d = document.getElementById("gnote"); if (d) place(d); });
function showNote(text, action) {
  hideGoogleNote();
  const d = document.createElement("div"); d.id = "gnote"; d.className = "gnote"; d.setAttribute("role", "status");
  d.innerHTML = `${G_LOGO}<span class="gnote-t">${esc(text)}</span><button type="button" class="icon-btn" id="gnoteX" aria-label="Cerrar aviso" title="Cerrar">${icon("x")}</button><button type="button" class="btn sm" id="gnoteGo">${esc(action)}</button>`;
  place(d);
  d.querySelector("#gnoteX").onclick = hideGoogleNote;
  d.querySelector("#gnoteGo").onclick = () => connectGoogle();
}
// Al entrar a la app. back: "ok" si recién volvió de «Entrar con Google» (se cuenta cómo quedó). Quien ya conectó no ve nada.
export async function googleNotice(back = "") {
  const g = await loadGmail(back === "ok"), st = googleState(g);
  if (st === "off") return;
  if (back === "ok" && st === "ok") return toast("Entraste con Google: mail, calendario y planillas conectados");
  if (back === "ok" && st === "partial") return showNote(partialText(g.google.missing), "Dar permisos");
  if (!noticeDue(g, loadPref("google.note", ""), today())) return;
  save("google.note", today());
  showNote(NOTICE_TEXT, "Conectar");
}

// ---------- perfil: «Tu Google»
function googleProfileHtml(g) {
  const st = googleState(g); if (st === "off") return "";
  if (st === "none") return `<div class="gm-st"><span class="muted">${g.expired ? "Tu conexión con Google venció. " : ""}Conectalo una vez: mandás mails desde la ficha, ves los horarios libres para las demos y leés o creás planillas.</span><button type="button" class="btn sm" id="goOn">${G_LOGO} Conectar Google</button></div>`;
  const go = g.google, miss = go.missing || [];
  const chips = PERM_ORDER.map(k => { const on = !!go.perms?.[k]; return `<span class="gperm ${on ? "on" : "off"}" title="${esc(`${PERM_LABEL[k]}: ${PERM_WHAT[k]}`)}">${icon(PERM_ICON[k], "sm")}${esc(PERM_LABEL[k])}<small>${on ? "sí" : "falta"}</small></span>`; }).join("");
  return `<div class="gm-st"><span>${icon("checkCircle", "sm")} Conectado como <b>${esc(go.email)}</b>${g.demo ? " (simulado)" : ""}</span></div>
    <div class="gperms" role="list" aria-label="Permisos de tu Google">${chips}</div>
    ${miss.length ? `<p class="muted g-miss">Falta el permiso de ${esc(permList(miss))}: sin eso no podés ${esc(miss.map(k => PERM_WHAT[k]).join(" ni "))}.</p>` : ""}
    ${!g.verified ? `<p class="faint g-miss">En este dispositivo confirmalo una vez con Google para mandar mails o desconectarlo.</p>` : ""}
    <div class="g-acts">${miss.length ? `<button type="button" class="btn sm primary" id="goOn">Dar los permisos que faltan</button>` : !g.verified ? `<button type="button" class="btn sm" id="goOn">Confirmar con Google</button>` : `<button type="button" class="linkbtn" id="goOn">Reconectar</button>`}
      ${g.verified ? `<button type="button" class="linkbtn" id="goOff">Desconectar</button>` : ""}</div>`;
}
// dibuja «Tu Google» en el perfil (el campo entero se esconde si el servidor no tiene Google); redraw: vuelve a dibujar el perfil
export function drawGoogleProfile(box, redraw) {
  if (!box?.isConnected) return;
  const html = googleProfileHtml(S.gmail), field = box.closest(".field");
  if (field) field.hidden = !html;
  box.innerHTML = html;
  box.querySelector("#goOn")?.addEventListener("click", async e => { const b = e.currentTarget; b.disabled = true; b.innerHTML = `<span class="spin"></span> Esperando a Google…`; await connectGoogle(); redraw(); });
  box.querySelector("#goOff")?.addEventListener("click", async e => {
    e.currentTarget.disabled = true;
    try { await disconnectGmail(); changed(); } catch (x) { toast(x.message, { type: "err" }); }
    redraw();
  });
}
