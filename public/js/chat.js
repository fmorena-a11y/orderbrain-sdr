// Asistente de ventas: chat con herramientas. Todo lo que escribe en Pipedrive se confirma con un botón.
import { $, S, api, esc, icon, toast, shortDay } from "./core.js";
import { currentSchoolId } from "./school.js";

const C = { turns: [], busy: false, started: false };
const focusId = () => currentSchoolId();

function suggestions() {
  const f = focusId(), s = f && S.byId.get(f);
  return s ? [`Armame un guion para ${s.name}`, `¿Qué pasó antes con ${s.name}?`, `Agendá una llamada con ${s.name} para mañana a las 10`, `Escribí un WhatsApp para reactivar a ${s.name}`]
    : ["¿A quién llamo ahora?", "¿Qué tengo agendado esta semana?", "Agendá una demo con Colegio Vallesol el jueves a las 10", "¿Cómo respondo «ya tenemos un sistema»?"];
}
export function openAssistant() {
  if (!S.ai) return;
  $("assistant").hidden = false;
  if (!C.started) {
    C.started = true;
    bubble("a", `Hola ${(S.me.name || "").split(" ")[0]}. Puedo decirte a quién llamar, armarte un guion o un mensaje, agendar llamadas y demos (para vos o para el equipo) y cargar notas en Pipedrive. Antes de guardar algo te lo muestro para que lo confirmes.`);
  }
  drawSugs();
  setTimeout(() => $("chatIn").focus(), 50);
}
export function closeAssistant() { $("assistant").hidden = true; }
function drawSugs() { $("sugs").innerHTML = C.busy ? "" : suggestions().map(s => `<button>${esc(s)}</button>`).join(""); $("sugs").querySelectorAll("button").forEach(b => b.onclick = () => send(b.textContent)); }
function bubble(cls, text) { const d = document.createElement("div"); d.className = "b " + cls; d.textContent = text; $("msgs").appendChild(d); $("msgs").scrollTop = 1e9; return d; }

function propCard(p) {
  const d = document.createElement("div"); d.className = "prop"; $("msgs").appendChild(d);
  const draw = (state, extra = "") => {
    const body = p.kind === "activity"
      ? `<h4>${esc(p.typeLabel)}: ${esc(p.subject)}</h4><dl><dt>Colegio</dt><dd>${esc(p.colegio)}${p.orgId || p.schoolId ? "" : " (se crea en Pipe si no existe)"}</dd><dt>Cuándo</dt><dd>${esc(p.weekday)} ${esc(shortDay(p.date))}${p.time ? " · " + esc(p.time) : ""}</dd><dt>Para</dt><dd>${esc(p.owner.name)}</dd>${p.note ? `<dt>Nota</dt><dd>${esc(p.note)}</dd>` : ""}</dl>`
      : `<h4>Nota para ${esc(p.colegio)}</h4><p style="margin:0 0 10px;white-space:pre-wrap">${esc(p.text)}</p>`;
    const foot = state === "pending" ? `<div class="r"><button class="btn primary sm" data-ok>${icon("check", "sm")} Confirmar</button><button class="btn sm" data-no>Descartar</button></div>`
      : state === "busy" ? `<p class="muted" style="margin:0"><span class="spin"></span> Guardando en Pipedrive…</p>`
      : state === "done" ? `<p class="muted" style="margin:0">${icon("check", "sm")} ${p.kind === "activity" ? "Creada" : "Guardada"} en Pipedrive · <a href="${esc(extra)}" target="_blank" rel="noopener">abrir</a></p>`
      : state === "no" ? `<p class="muted" style="margin:0">Descartada</p>`
      : `<p class="callout err" style="margin:0 0 8px">${esc(extra)}</p><div class="r"><button class="btn sm" data-ok>Reintentar</button></div>`;
    d.className = "prop" + (["done", "no"].includes(state) ? " done" : ""); d.innerHTML = body + foot;
    d.querySelector("[data-ok]")?.addEventListener("click", async () => {
      draw("busy");
      try {
        const r = await api(`/api/proposals/${p.id}/confirm`, { body: {} }); draw("done", r.orgUrl); S.today = null; S.agenda = null;
        toast(p.kind === "activity" ? "Actividad creada en Pipedrive" : "Nota guardada en Pipedrive");
        C.turns.push({ role: "user", content: `(Confirmé: ${p.kind === "activity" ? `${p.typeLabel} "${p.subject}" el ${p.date} para ${p.owner.name}` : "la nota"} en ${p.colegio}.)` }, { role: "assistant", content: "Listo, quedó en Pipedrive." });
      } catch (e) { draw("err", e.message); }
    });
    d.querySelector("[data-no]")?.addEventListener("click", () => { api(`/api/proposals/${p.id}/discard`, { body: {} }).catch(() => {}); draw("no"); C.turns.push({ role: "user", content: `(Descarté la propuesta para ${p.colegio}.)` }, { role: "assistant", content: "Entendido." }); });
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
    (r.proposals || []).forEach(propCard);
  } catch (e) { out.className = "b a"; out.textContent = e.message; C.turns.pop(); }
  C.busy = false; $("chatSend").disabled = false; drawSugs(); $("chatIn").focus();
}
$("assistClose").onclick = closeAssistant;
$("compose").onsubmit = e => { e.preventDefault(); const v = $("chatIn").value; $("chatIn").value = ""; autosize(); send(v); };
const autosize = () => { const t = $("chatIn"); t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 140) + "px"; };
$("chatIn").addEventListener("input", autosize);
$("chatIn").addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("compose").requestSubmit(); } });
