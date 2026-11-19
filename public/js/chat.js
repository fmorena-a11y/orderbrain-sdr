// Asistente de ventas: chat con herramientas. Todo lo que escribe en Pipedrive se confirma con un botón.
import { $, S, api, esc, icon, toast, shortDay } from "./core.js";
import { currentSchoolId } from "./school.js";
// lo puro (Markdown seguro, tablas, CSV/.xlsx, «exportá», dictado) está en chatfmt.js y se prueba con node
import { renderMd, cellText, tableCsv, tableTsv, tableXlsx, fileName, exportIntent, speechLang, speechError, NO_SPEECH } from "./chatfmt.js";

// lastTable: la última tabla que mostró el panel («exportá» la usa sin ir al servidor); sheetsDirect: crear la hoja con la API
// de Google (solo con su Google conectado con el permiso de planillas: lib/sheets-export.js), undefined = sin preguntar todavía
const C = { turns: [], busy: false, started: false, sugs: [], lastTable: null, sheetsDirect: undefined };
const focusId = () => currentSchoolId();

function suggestions() {
  // ya charlando: las que propuso el asistente según la conversación (si no propuso, ninguna: nada fuera de tema)
  if (C.turns.length) return C.sugs || [];
  const f = focusId(), s = f && S.byId.get(f);
  return s ? [`Armame un guion para ${s.name}`, `¿Qué pasó antes con ${s.name}?`, `Agendá una llamada con ${s.name} para mañana a las 10`, `Escribí un WhatsApp para reactivar a ${s.name}`]
    : ["¿A quién llamo ahora?", "Prospectá colegios en España", "¿Qué tengo agendado esta semana?", "¿Cómo respondo «ya tenemos un sistema»?"];
}
export function openAssistant() {
  if (!S.ai) return;
  $("assistant").hidden = false;
  { const w = awLoad(); if (w?.min) { awSave({ ...w, min: false }); awApply(); } } // abrirlo lo agranda si estaba minimizado
  if (!C.started) {
    C.started = true;
    bubble("a", `Hola ${(S.me.name || "").split(" ")[0]}. Puedo decirte a quién llamar, armarte un guion o un mensaje, agendar llamadas y demos (para vos o para el equipo) y cargar notas en Pipedrive. Antes de guardar algo te lo muestro para que lo confirmes.`);
  }
  drawSugs();
  setTimeout(() => $("chatIn").focus(), 50);
}
export function closeAssistant() { micStop(true); $("assistant").hidden = true; }

// ---------- ventana movible (pantallas de 900 px o más): arrastrar desde el título, agrandar desde cualquier borde o esquina, minimizar.
// Dónde quedó se recuerda en este navegador (solo comodidad: si no se puede guardar, vuelve a la derecha).
const AW_KEY = "ob.assistant.win", wide = () => matchMedia("(min-width: 900px)").matches;
const awLoad = () => { try { return JSON.parse(localStorage.getItem(AW_KEY) || "null"); } catch { return null; } };
const awSave = w => { try { w ? localStorage.setItem(AW_KEY, JSON.stringify(w)) : localStorage.removeItem(AW_KEY); } catch { /* sin almacenamiento */ } };
function awApply() {
  const el = $("assistant"), w = awLoad();
  const float = wide() && w && w.float;
  el.classList.toggle("floating", !!float); el.classList.toggle("min", !!(wide() && w?.min));
  $("assistDock").hidden = !float;
  $("assistMin").setAttribute("aria-label", w?.min ? "Agrandar" : "Minimizar"); $("assistMin").title = w?.min ? "Agrandar" : "Minimizar";
  if (!float) { el.style.left = el.style.top = el.style.width = el.style.height = ""; return; }
  const W = Math.min(w.w || 420, innerWidth - 16), H = Math.min(w.h || 640, innerHeight - 16);
  el.style.width = W + "px"; if (!w.min) el.style.height = H + "px";
  el.style.left = Math.max(8, Math.min(w.x ?? innerWidth - W - 24, innerWidth - 120)) + "px";
  el.style.top = Math.max(8, Math.min(w.y ?? 16, innerHeight - 56)) + "px";
}
function awInit() {
  const el = $("assistant"), head = el.querySelector("header");
  head.addEventListener("pointerdown", e => {
    if (!wide() || e.button !== 0 || e.target.closest("button")) return;
    const r = el.getBoundingClientRect(), w = awLoad() || {};
    // la primera vez que se arrastra, se despega de la derecha y queda flotando donde estaba
    if (!w.float) awSave({ ...w, float: true, x: r.left, y: r.top, w: r.width, h: Math.min(r.height, 640) }), awApply();
    const r2 = el.getBoundingClientRect(), dx = e.clientX - r2.left, dy = e.clientY - r2.top;
    el.classList.add("dragging"); head.setPointerCapture(e.pointerId);
    const move = ev => { el.style.left = Math.max(8, Math.min(ev.clientX - dx, innerWidth - 120)) + "px"; el.style.top = Math.max(8, Math.min(ev.clientY - dy, innerHeight - 56)) + "px"; };
    const up = () => { head.removeEventListener("pointermove", move); el.classList.remove("dragging"); const b = el.getBoundingClientRect(); awSave({ ...(awLoad() || {}), float: true, x: b.left, y: b.top }); };
    head.addEventListener("pointermove", move); head.addEventListener("pointerup", up, { once: true }); head.addEventListener("pointercancel", up, { once: true });
  });
  // doble clic en el título: vuelve a la derecha
  head.addEventListener("dblclick", e => { if (wide() && !e.target.closest("button")) { awSave(null); awApply(); } });
  // agrandar/achicar desde los 4 bordes y las 4 esquinas (la flechita doble del cursor): se guarda posición y tamaño.
  // Pegada a la derecha, tirar de un borde la despega y queda flotando donde estaba.
  const MINW = 320, MINH = 260;
  for (const d of ["n", "s", "e", "w", "ne", "nw", "se", "sw"]) {
    const h = document.createElement("div"); h.className = `aw-rz aw-${d}`; h.dataset.d = d; h.setAttribute("aria-hidden", "true"); el.appendChild(h);
    h.addEventListener("pointerdown", e => {
      if (!wide() || e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      let w = awLoad() || {};
      if (w.min) return;
      const r0 = el.getBoundingClientRect();
      if (!w.float) { w = { ...w, float: true, x: r0.left, y: r0.top, w: r0.width, h: r0.height }; awSave(w); awApply(); }
      const r = el.getBoundingClientRect(), sx = e.clientX, sy = e.clientY;
      el.classList.add("resizing"); h.setPointerCapture(e.pointerId);
      const move = ev => {
        const dx = ev.clientX - sx, dy = ev.clientY - sy;
        let L = r.left, T = r.top, W = r.width, H = r.height;
        if (d.includes("e")) W = Math.min(Math.max(MINW, r.width + dx), innerWidth - 8 - L);
        if (d.includes("s")) H = Math.min(Math.max(MINH, r.height + dy), innerHeight - 8 - T);
        if (d.includes("w")) { const nl = Math.max(8, Math.min(r.left + dx, r.right - MINW)); W = r.right - nl; L = nl; }
        if (d.includes("n")) { const nt = Math.max(8, Math.min(r.top + dy, r.bottom - MINH)); H = r.bottom - nt; T = nt; }
        Object.assign(el.style, { left: L + "px", top: T + "px", width: W + "px", height: H + "px" });
      };
      const up = () => { h.removeEventListener("pointermove", move); el.classList.remove("resizing"); const b = el.getBoundingClientRect(); awSave({ ...(awLoad() || {}), float: true, x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) }); };
      h.addEventListener("pointermove", move); h.addEventListener("pointerup", up, { once: true }); h.addEventListener("pointercancel", up, { once: true });
    });
  }
  $("assistMin").onclick = () => { const w = awLoad() || {}, r = el.getBoundingClientRect(); awSave({ ...w, float: true, x: w.float ? w.x : r.left, y: w.float ? w.y : r.top, w: w.w || r.width, min: !w.min }); awApply(); };
  $("assistDock").onclick = () => { awSave(null); awApply(); };
  addEventListener("resize", awApply);
  awApply();
}
function drawSugs() { $("sugs").innerHTML = C.busy ? "" : suggestions().map(s => `<button>${esc(s)}</button>`).join(""); $("sugs").querySelectorAll("button").forEach(b => b.onclick = () => send(b.textContent)); }
function bubble(cls, text) { const d = document.createElement("div"); d.className = "b " + cls; d.textContent = text; $("msgs").appendChild(d); $("msgs").scrollTop = 1e9; return d; }
// respuesta del asistente: Markdown → HTML seguro (renderMd escapa todo antes de armar las etiquetas)
// Respuesta con formato. Un mensaje propuesto para mandar (el modelo lo escribe como cita «> …») lleva «Copiar mensaje»;
// toda respuesta lleva además «Copiar» abajo (pedido del líder: «que me deje copiar el mensaje propuesto, no copiarlo a mano»).
const textOf = node => { const c = node.cloneNode(true); c.querySelectorAll(".md-copy, .md-acts").forEach(x => x.remove()); c.querySelectorAll("br").forEach(b => b.replaceWith("\n")); c.querySelectorAll("p, li, h4, blockquote").forEach(x => x.append("\n")); return c.textContent.replace(/\n{3,}/g, "\n\n").trim(); };
async function copyText(text, btn) {
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch { ok = legacyCopy(text); }
  if (btn) { const old = btn.innerHTML; btn.innerHTML = ok ? `${icon("check", "sm")} Copiado` : "No pude copiar"; setTimeout(() => { if (btn.isConnected) btn.innerHTML = old; }, 1800); }
  return ok;
}
function mdBubble(text, el = bubble("a", "")) {
  el.className = "b a md"; el.innerHTML = renderMd(text);
  el.querySelectorAll("blockquote").forEach(q => {
    const b = document.createElement("button"); b.type = "button"; b.className = "btn sm md-copy"; b.innerHTML = `${icon("copy", "sm")} Copiar mensaje`;
    b.onclick = () => copyText(textOf(q), b); q.after(b);
  });
  if (textOf(el).length > 40) {
    const acts = document.createElement("div"); acts.className = "md-acts";
    const b = document.createElement("button"); b.type = "button"; b.className = "linkbtn"; b.innerHTML = `${icon("copy", "sm")} Copiar respuesta`;
    b.onclick = () => copyText(textOf(el), b); acts.append(b); el.append(acts);
  }
  return el;
}

// ---------- tablas para exportar (las arma el servidor con lo que devolvieron las herramientas: lib/aitables.js)
const PREVIEW = 5;
function save(blob, name) {
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
function legacyCopy(text) {
  const ta = document.createElement("textarea"); ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.appendChild(ta); ta.select(); let ok = false; try { ok = document.execCommand("copy"); } catch { ok = false; } ta.remove(); return ok;
}
async function toSheets(t, say) {
  if (C.sheetsDirect) {
    // con Google conectado (drive.file): la hoja se crea directo. La pestaña se abre antes de esperar, para que no la bloqueen.
    const w = window.open("about:blank", "_blank");
    try { const r = await api("/api/sheets/export", { body: { table: t } }); if (w) w.location.href = r.url; else window.open(r.url, "_blank"); say("Hoja creada en tu Google Drive."); return; }
    catch { w?.close(); C.sheetsDirect = false; }
  }
  // sin configurar nada: copiar con tabulaciones (con encabezados) y abrir una hoja nueva para pegar
  const text = tableTsv(t);
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch { ok = legacyCopy(text); }
  const w = window.open("https://sheets.new", "_blank"); if (w) try { w.opener = null; } catch { /* otra pestaña */ }
  if (!ok) return say("No pude copiarla. Descargá el Excel y abrilo en Google Sheets (Archivo › Importar).", true);
  say(w ? "Copiada: pegala con Ctrl+V (⌘V en Mac) en la hoja nueva." : "Copiada. Abrí sheets.new en otra pestaña y pegala con Ctrl+V.");
}
// conectó o desconectó su Google (public/js/google.js): se vuelve a preguntar si la hoja se crea directo
addEventListener("ob:google", () => { C.sheetsDirect = undefined; });
function tableCard(t, { focus = "" } = {}) {
  if (C.sheetsDirect === undefined) { C.sheetsDirect = false; api("/api/sheets/status").then(r => { C.sheetsDirect = !!r.direct; }).catch(() => {}); }
  C.lastTable = t;
  const d = document.createElement("div"); d.className = "tcard"; $("msgs").appendChild(d);
  const n = t.rows.length, td = (v, c) => {
    if (c.type === "url") return /^https:\/\//.test(String(v || "")) ? `<td><a href="${esc(v)}" target="_blank" rel="noopener noreferrer">Abrir</a></td>` : "<td></td>";
    const s = cellText(v, c.type, "view"); return `<td title="${esc(s)}">${esc(s)}</td>`;
  };
  const btn = (x, ic, label) => `<button type="button" class="btn sm${focus === x ? " primary" : ""}" data-x="${x}">${icon(ic, "sm")} ${label}</button>`;
  d.innerHTML = `<div class="tc-h">${icon("table", "sm")}<div><h4>${esc(t.title)}</h4><small>${n === 1 ? "1 fila" : `${n} filas`}${t.note ? " · " + esc(t.note) : ""}</small></div></div>
    <div class="tc-scroll" tabindex="0" role="region" aria-label="Vista previa de ${esc(t.title)}"><table><thead><tr>${t.columns.map(c => `<th>${esc(c.label)}</th>`).join("")}</tr></thead>
    <tbody>${t.rows.slice(0, PREVIEW).map(r => `<tr>${t.columns.map((c, j) => td(r[j], c)).join("")}</tr>`).join("")}</tbody></table></div>
    ${n > PREVIEW ? `<p class="tc-more">${n - PREVIEW === 1 ? "Y 1 más" : `Y ${n - PREVIEW} más`} en el archivo.</p>` : ""}
    <div class="tc-act">${btn("xlsx", "download", "Descargar Excel")}${btn("csv", "download", "Descargar CSV")}${btn("sheets", "table", "Llevar a Google Sheets")}</div>
    <p class="tc-msg" role="status" aria-live="polite" hidden></p>`;
  const msg = d.querySelector(".tc-msg"), say = (s, err = false) => { msg.hidden = !s; msg.textContent = s; msg.classList.toggle("err", err); };
  d.querySelector('[data-x="xlsx"]').onclick = () => { save(new Blob([tableXlsx(t)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), fileName(t.title, "xlsx")); say("Excel descargado."); };
  d.querySelector('[data-x="csv"]').onclick = () => { save(new Blob([tableCsv(t)], { type: "text/csv;charset=utf-8" }), fileName(t.title, "csv")); say("CSV descargado (separado con «;», abre directo en Excel)."); };
  d.querySelector('[data-x="sheets"]').onclick = e => { const b = e.currentTarget; b.disabled = true; toSheets(t, say).finally(() => { b.disabled = false; }); };
  $("msgs").scrollTop = 1e9;
  return d;
}

function propCard(p) {
  const d = document.createElement("div"); d.className = "prop"; $("msgs").appendChild(d);
  if (p.kind === "scan") {
    d.innerHTML = `<h4>${icon("globe", "sm")} Buscar colegios en ${esc(p.zona)}</h4><p class="muted" style="margin:0 0 10px">Busco los colegios privados que todavía no están y los sumo al mapa. Podés seguir trabajando mientras.</p><div class="r"><button class="btn primary sm" data-go>${icon("play", "sm")} Buscar ahora</button></div>`;
    const go = d.querySelector("[data-go]");
    go.onclick = async () => {
      go.disabled = true;
      const ok = await import("./scan.js").then(m => m.scanZone(p.zona)).catch(() => false);
      // solo se dice «en marcha» si de verdad arrancó; si no, el botón queda para reintentar
      if (ok) d.querySelector(".r").innerHTML = `<p class="muted" style="margin:0">${icon("check", "sm")} Búsqueda en marcha: mirá el avance abajo a la izquierda.</p>`;
      else go.disabled = false;
    };
    $("msgs").scrollTop = 1e9; return;
  }
  const draw = (state, extra = "") => {
    const body = p.kind === "activity"
      ? `<h4>${esc(p.typeLabel)}: ${esc(p.subject)}</h4><dl><dt>Colegio</dt><dd>${esc(p.colegio)}${p.orgId || p.schoolId ? "" : " (se crea en Pipe si no existe)"}</dd><dt>Cuándo</dt><dd>${esc(p.weekday)} ${esc(shortDay(p.date))}${p.time ? " · " + esc(p.time) : ""}</dd><dt>Para</dt><dd>${esc(p.owner.name)}</dd>${p.note ? `<dt>Nota</dt><dd>${esc(p.note)}</dd>` : ""}</dl>`
      : `<h4>Nota para ${esc(p.colegio)}</h4><p style="margin:0 0 10px;white-space:pre-wrap">${esc(p.text)}</p>`;
    const foot = state === "pending" ? `<div class="r"><button class="btn primary sm" data-ok>${icon("check", "sm")} Confirmar</button><button class="btn sm" data-no>Descartar</button></div>`
      : state === "busy" ? `<p class="muted" style="margin:0"><span class="spin"></span> Guardando en Pipedrive…</p>`
      : state === "done" ? `<p class="muted" style="margin:0">${icon("check", "sm")} ${p.kind === "activity" ? "Creada" : "Guardada"} ${extra?.where?.kind === "lead" ? `en el prospecto «${esc(extra.where.title || p.colegio)}»${extra.where.created ? " (creado a tu nombre)" : ""}` : "en Pipedrive"} · <a href="${esc(extra?.orgUrl || extra)}" target="_blank" rel="noopener">abrir</a></p>${(extra?.done || []).filter(x => x.warn).map(x => `<p class="callout warn" style="margin:6px 0 0">${esc(x.label)}</p>`).join("")}`
      : state === "no" ? `<p class="muted" style="margin:0">Descartada</p>`
      : `<p class="callout err" style="margin:0 0 8px">${esc(extra)}</p><div class="r"><button class="btn sm" data-ok>Reintentar</button></div>`;
    d.className = "prop" + (["done", "no"].includes(state) ? " done" : ""); d.innerHTML = body + foot;
    d.querySelector("[data-ok]")?.addEventListener("click", async () => {
      draw("busy");
      try {
        const r = await api("/api/proposals/confirm", { body: { id: p.id } }); draw("done", r); S.today = null; S.agenda = null;
        toast(p.kind === "activity" ? "Actividad creada en Pipedrive" : "Nota guardada en Pipedrive");
        C.turns.push({ role: "user", content: `(Confirmé: ${p.kind === "activity" ? `${p.typeLabel} "${p.subject}" el ${p.date} para ${p.owner.name}` : "la nota"} en ${p.colegio}.)` }, { role: "assistant", content: "Listo, quedó en Pipedrive." });
      } catch (e) { draw("err", e.message); }
    });
    d.querySelector("[data-no]")?.addEventListener("click", () => { api("/api/proposals/discard", { body: { id: p.id } }).catch(() => {}); draw("no"); C.turns.push({ role: "user", content: `(Descarté la propuesta para ${p.colegio}.)` }, { role: "assistant", content: "Entendido." }); });
  };
  draw("pending"); $("msgs").scrollTop = 1e9;
}
async function send(text) {
  text = text.trim(); if (C.busy || !text) return;
  micStop(true, true);
  C.busy = true; $("chatSend").disabled = true; drawSugs();
  bubble("u", text);
  // «exportá», «pasalo a un Excel», «llevalo a Google Sheets» sin otro pedido: la última tabla del panel, sin ir al servidor
  const ex = C.lastTable && exportIntent(text);
  if (ex) {
    const t = C.lastTable, n = t.rows.length;
    mdBubble(`Acá está **${t.title}** (${n === 1 ? "1 fila" : `${n} filas`}). ${ex.format === "sheets" ? "Tocá **Llevar a Google Sheets**: la copio y abro una hoja nueva para que la pegues." : ex.format === "csv" ? "Tocá **Descargar CSV**." : "Tocá **Descargar Excel**."}`);
    tableCard(t, { focus: ex.format });
    C.turns.push({ role: "user", content: text }, { role: "assistant", content: `(Te mostré la tabla «${t.title}» con los botones para exportarla.)` });
    C.busy = false; $("chatSend").disabled = false; drawSugs(); return;
  }
  C.turns.push({ role: "user", content: text });
  const out = bubble("a typing", ""); out.innerHTML = `<span class="typing-dots"><i></i><i></i><i></i></span>`;
  try {
    const r = await api("/api/chat", { body: { messages: C.turns, focus: focusId() } });
    mdBubble(r.reply, out); C.turns.push({ role: "assistant", content: r.reply });
    C.sugs = Array.isArray(r.suggestions) ? r.suggestions.slice(0, 4) : [];
    (r.proposals || []).forEach(propCard);
    (Array.isArray(r.tables) ? r.tables : []).filter(t => t && Array.isArray(t.columns) && Array.isArray(t.rows)).forEach(t => tableCard(t));
  } catch (e) { out.className = "b a"; out.textContent = e.message; C.turns.pop(); }
  C.busy = false; $("chatSend").disabled = false; drawSugs(); $("chatIn").focus();
}
$("assistClose").onclick = closeAssistant;
awInit();
$("compose").onsubmit = e => { e.preventDefault(); const v = $("chatIn").value; $("chatIn").value = ""; autosize(); send(v); };
const autosize = () => { const t = $("chatIn"); t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 140) + "px"; };
$("chatIn").addEventListener("input", autosize);
$("chatIn").addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("compose").requestSubmit(); } });

// ---------- dictado con la Web Speech API del navegador (Chrome, Edge, Safari): el audio lo procesa el navegador, nada
// pasa por nuestro servidor. Lo que va entendiendo se ve en el campo; termina al tocar de nuevo o tras un silencio, y se
// manda solo si está «Mandar al terminar de hablar» (preferencia de este navegador, encendida por defecto). Esc cancela.
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const MIC_KEY = "ob.assistant.micAuto";
const M = { rec: null, base: "", heard: "", err: "", cancel: false, quiet: false };
function micBar(msg = "", { listening = false, err = false } = {}) {
  $("micBar").hidden = !msg; $("micBar").classList.toggle("err", err); $("micMsg").textContent = msg; $("micAutoWrap").hidden = !listening;
}
function micUi(on) {
  const b = $("chatMic"); b.classList.toggle("rec", on); b.setAttribute("aria-pressed", String(on));
  b.setAttribute("aria-label", on ? "Dejar de escuchar" : "Dictar un mensaje"); b.title = on ? "Dejar de escuchar" : "Dictar";
}
// cancel: deja el campo como estaba; quiet: sin avisos (se mandó el mensaje o se cerró el panel)
function micStop(cancel = false, quiet = false) {
  if (!M.rec) return;
  M.cancel = cancel; M.quiet = quiet;
  try { cancel ? M.rec.abort() : M.rec.stop(); } catch { /* ya terminó */ }
}
function micStart() {
  if (!SR) return micBar(NO_SPEECH, { err: true });
  if (C.busy) return;
  let r; try { r = new SR(); } catch { return micBar(NO_SPEECH, { err: true }); }
  Object.assign(M, { rec: r, base: $("chatIn").value.trim(), heard: "", err: "", cancel: false, quiet: false });
  r.lang = speechLang(navigator.language); r.interimResults = true; r.continuous = false; r.maxAlternatives = 1;
  r.onresult = e => {
    let t = ""; for (let k = 0; k < e.results.length; k++) t += e.results[k][0].transcript;
    M.heard = t.replace(/\s+/g, " ").trim(); $("chatIn").value = [M.base, M.heard].filter(Boolean).join(" "); autosize();
  };
  r.onerror = e => { M.err = e.error || "error"; };
  r.onend = () => {
    const was = M; M.rec = null; micUi(false);
    if (was.quiet) return micBar("");
    if (was.cancel) { $("chatIn").value = was.base; autosize(); return micBar(""); }
    if (!was.heard) return micBar(speechError(was.err && was.err !== "aborted" ? was.err : "no-speech"), { err: true });
    micBar("");
    if ($("micAuto").checked) $("compose").requestSubmit();
    else { $("chatIn").focus(); micBar("Revisá el texto y mandalo cuando quieras."); }
  };
  try { r.start(); } catch { M.rec = null; return micBar(speechError(""), { err: true }); }
  micUi(true); micBar("Escuchando… Tocá el micrófono para terminar.", { listening: true });
}
try { $("micAuto").checked = localStorage.getItem(MIC_KEY) !== "0"; } catch { /* sin almacenamiento: queda encendido */ }
$("micAuto").onchange = e => { try { localStorage.setItem(MIC_KEY, e.target.checked ? "1" : "0"); } catch { /* sin almacenamiento */ } };
$("chatMic").onclick = () => M.rec ? micStop(false) : micStart();
$("assistant").addEventListener("keydown", e => { if (e.key === "Escape" && M.rec) { e.preventDefault(); e.stopPropagation(); micStop(true); } });
