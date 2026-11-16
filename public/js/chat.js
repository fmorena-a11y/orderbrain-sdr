// Asistente de ventas: chat con herramientas. Todo lo que escribe en Pipedrive se confirma con un botón.
import { $, S, api, esc, icon, toast, shortDay } from "./core.js";
import { currentSchoolId } from "./school.js";

const C = { turns: [], busy: false, started: false, sugs: [] };
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
export function closeAssistant() { $("assistant").hidden = true; }

// ---------- ventana movible (pantallas de 900 px o más): arrastrar desde el título, agrandar desde la esquina, minimizar.
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
  // agrandar/achicar desde la esquina (resize de CSS): se guarda el tamaño
  new ResizeObserver(() => { const w = awLoad(); if (!wide() || !w?.float || w.min || el.hidden) return; const b = el.getBoundingClientRect(); if (Math.abs(b.width - (w.w || 0)) > 2 || Math.abs(b.height - (w.h || 0)) > 2) awSave({ ...w, w: Math.round(b.width), h: Math.round(b.height) }); }).observe(el);
  $("assistMin").onclick = () => { const w = awLoad() || {}, r = el.getBoundingClientRect(); awSave({ ...w, float: true, x: w.float ? w.x : r.left, y: w.float ? w.y : r.top, w: w.w || r.width, min: !w.min }); awApply(); };
  $("assistDock").onclick = () => { awSave(null); awApply(); };
  addEventListener("resize", awApply);
  awApply();
}
function drawSugs() { $("sugs").innerHTML = C.busy ? "" : suggestions().map(s => `<button>${esc(s)}</button>`).join(""); $("sugs").querySelectorAll("button").forEach(b => b.onclick = () => send(b.textContent)); }
function bubble(cls, text) { const d = document.createElement("div"); d.className = "b " + cls; d.textContent = text; $("msgs").appendChild(d); $("msgs").scrollTop = 1e9; return d; }

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
  C.busy = true; $("chatSend").disabled = true; drawSugs();
  bubble("u", text); C.turns.push({ role: "user", content: text });
  const out = bubble("a typing", ""); out.innerHTML = `<span class="typing-dots"><i></i><i></i><i></i></span>`;
  try {
    const r = await api("/api/chat", { body: { messages: C.turns, focus: focusId() } });
    out.className = "b a"; out.textContent = r.reply; C.turns.push({ role: "assistant", content: r.reply });
    C.sugs = Array.isArray(r.suggestions) ? r.suggestions.slice(0, 4) : [];
    (r.proposals || []).forEach(propCard);
  } catch (e) { out.className = "b a"; out.textContent = e.message; C.turns.pop(); }
  C.busy = false; $("chatSend").disabled = false; drawSugs(); $("chatIn").focus();
}
$("assistClose").onclick = closeAssistant;
awInit();
$("compose").onsubmit = e => { e.preventDefault(); const v = $("chatIn").value; $("chatIn").value = ""; autosize(); send(v); };
const autosize = () => { const t = $("chatIn"); t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 140) + "px"; };
$("chatIn").addEventListener("input", autosize);
$("chatIn").addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("compose").requestSubmit(); } });
