// Accounts y calendario en el perfil (lib/accounts.js):
//  - «Tus accounts» (quien NO es Account Executive): por país, quién da tus demos. Lo sugerido por la cuenta va preseleccionado
//    con «(sugerido)» hasta que guardás el perfil (eso lo confirma). Dirección y el líder de tu equipo también lo cambian (Equipo).
//  - «Tu calendario para las demos» (Account Executive, o cualquiera que dé demos): pegás una vez la dirección secreta iCal de tu
//    Google Calendar, «Probar» dice cuántos eventos ve (nunca títulos) y tu horario para demos. La dirección nunca vuelve del servidor.
import { api, esc, icon, toast, modal } from "./core.js";
import { forgetAccounts } from "./demoslots.js";

const DOWS = [[1, "L"], [2, "M"], [3, "M"], [4, "J"], [5, "V"], [6, "S"], [0, "D"]];
const DOW_NAME = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const fDay = iso => { try { return new Intl.DateTimeFormat("es", { day: "numeric", month: "short" }).format(new Date(iso)); } catch { return ""; } };

// ---------- editor de accounts (perfil y Equipo › Accesos del equipo)
// data: { rows: [{ country, id, suggested }], people: [{ id, name, ae }], countries }. st: { values: { país: id|null }, added: [], touched: Set }
function newDraft(data) { return { values: Object.fromEntries(data.rows.map(r => [r.country, r.id])), added: [], touched: new Set() }; }
function personOpts(data, sel) {
  const ae = data.people.filter(p => p.ae), rest = data.people.filter(p => !p.ae);
  const o = p => `<option value="${p.id}" ${String(sel) === String(p.id) ? "selected" : ""}>${esc(p.name)}</option>`;
  // alguien que ya no está en el Pipedrive (o no se puede elegir): se muestra igual, para no perderlo sin querer
  const gone = sel && !data.people.some(p => String(p.id) === String(sel)) ? `<option value="${esc(sel)}" selected>Otra persona (id ${esc(sel)})</option>` : "";
  return `<option value="" ${sel ? "" : "selected"}>Sin account</option>${gone}${ae.length ? `<optgroup label="Account Executives">${ae.map(o).join("")}</optgroup>` : ""}${rest.length ? `<optgroup label="Otras personas">${rest.map(o).join("")}</optgroup>` : ""}`;
}
function editorHtml(data, st) {
  const sug = new Map(data.rows.map(r => [r.country, r.suggested])), list = [...data.rows.map(r => r.country), ...st.added];
  const free = data.countries.filter(c => !list.includes(c));
  return `<div class="acct-rows">${list.map(c => `<div class="acct-row"><label class="acct-c" for="acct-${esc(c)}">${esc(c)}</label>
      <select class="inp" id="acct-${esc(c)}" data-acct="${esc(c)}">${personOpts(data, st.values[c])}</select>
      ${sug.get(c) && !st.touched.has(c) && st.values[c] ? `<small class="acct-sug">(sugerido)</small>` : `<small class="acct-sug"></small>`}</div>`).join("")}
    ${free.length ? `<div class="acct-add"><select class="inp" data-acct-add aria-label="Sumar otro país"><option value="">+ otro país</option>${free.map(c => `<option>${esc(c)}</option>`).join("")}</select></div>` : ""}</div>`;
}
function bindEditor(box, data, st, redraw) {
  box.querySelectorAll("[data-acct]").forEach(sel => sel.onchange = () => { const c = sel.dataset.acct; st.values[c] = sel.value ? Number(sel.value) : null; st.touched.add(c); redraw(); });
  const add = box.querySelector("[data-acct-add]");
  if (add) add.onchange = () => { const c = add.value; if (!c) return; st.added.push(c); st.values[c] = null; st.touched.add(c); redraw(); box.querySelector(`[data-acct="${CSS.escape(c)}"]`)?.focus(); };
}
const payload = (data, st) => Object.fromEntries([...data.rows.map(r => r.country), ...st.added].map(c => [c, st.values[c] ?? null]));

// ---------- calendario para demos (solo el tuyo)
const stepsHtml = `<ol class="cal-steps"><li>En Google Calendar abrí <b>Configuración</b> (la ruedita).</li><li>En «Configuración de mis calendarios» elegí tu calendario y entrá a <b>Integrar el calendario</b>.</li><li>Copiá la <b>Dirección secreta en formato iCal</b> y pegala acá.</li></ol>`;
function calHtml(c, ui) {
  if (!c) return `<p class="faint" style="margin:0">Cargando…</p>`;
  const h = ui.hours || c.hours, kind = c.kind === "outlook" ? "Outlook" : c.kind === "test" ? "calendario de prueba" : "Google Calendar";
  return `${c.connected ? `<div class="gm-st"><span>${icon("checkCircle", "sm")} Conectado · ${esc(kind)}${c.demo ? " (simulado)" : c.at ? ` · desde el ${esc(fDay(c.at))}` : ""}</span>
      <span class="row" style="gap:8px"><button type="button" class="btn sm" id="calTest">${ui.testing ? `<span class="spin"></span> Probando…` : "Probar"}</button>${c.demo ? "" : `<button type="button" class="linkbtn" id="calOff">Desconectar</button>`}</span></div>
      ${ui.test ? `<p class="cal-out" role="status">${esc(ui.test)}</p>` : ""}
      ${c.problem ? `<div class="callout warn">${icon("alert")}<span>${esc(c.problem)} Pegá la dirección de nuevo.</span></div>` : ""}
      ${c.problem || ui.change ? "" : `<button type="button" class="linkbtn cal-change" id="calChange">Cambiar la dirección</button>`}` : ""}
    ${!c.connected || c.problem || ui.change ? `${c.connected ? "" : `<p class="muted" style="margin:0;font-size:13.5px">Así el equipo ve cuándo estás libre y te propone demos en esos horarios. Lo conectás una vez.</p>`}${stepsHtml}
      <div class="cal-url"><input class="inp" id="calUrl" type="text" inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://calendar.google.com/calendar/ical/…/basic.ics" aria-label="Dirección secreta en formato iCal">
        <button type="button" class="btn sm primary" id="calGo">${ui.saving ? `<span class="spin"></span> Probando…` : "Conectar"}</button></div>` : ""}
    ${ui.err ? `<p class="err" role="alert" style="margin:0">${esc(ui.err)}</p>` : ""}
    <div class="cal-hours"><span class="cal-h-l">Horario para demos <small class="faint">tu hora${c.place || c.tz ? ` (${esc(c.place || c.tz)})` : ""}</small></span>
      <div class="chips" role="group" aria-label="Días">${DOWS.map(([d, l]) => `<button type="button" class="chip sm" data-cdow="${d}" aria-pressed="${h.days.includes(d)}" aria-label="${DOW_NAME[d]}">${l}</button>`).join("")}</div>
      <div class="cal-hh"><label>De <input class="inp" type="time" step="900" id="calFrom" value="${esc(h.from)}"></label><label>a <input class="inp" type="time" step="900" id="calTo" value="${esc(h.to)}"></label>
        <button type="button" class="btn sm" id="calHours" ${ui.hours ? "" : "disabled"}>Guardar horario</button></div></div>
    <p class="faint" style="margin:0;font-size:12.5px">${icon("lock", "sm")} Solo se ve libre u ocupado: nadie ve los títulos ni los detalles de tus eventos.</p>`;
}

// ---------- perfil: los dos bloques. Devuelve { roleChanged, save } para app.js (save confirma los accounts).
export const profileExtrasHtml = () => `<div class="field" id="pfAccounts" hidden></div><div id="pfCal" hidden></div>`;
export function bindProfileExtras(m, { role, required = false } = {}) {
  const aBox = m.querySelector("#pfAccounts"), cBox = m.querySelector("#pfCal");
  let data = null, st = null, loadErr = "", cal = null;
  const ui = { hours: null, test: "", err: "", saving: false, testing: false, change: false };
  const isAe = () => role() === "ae";
  const drawA = () => {
    if (!aBox?.isConnected) return;
    aBox.hidden = isAe();
    if (aBox.hidden) return;
    aBox.innerHTML = `<span>Tus accounts <small class="faint">quién da tus demos en cada país</small></span>${loadErr ? `<p class="err" style="margin:0">${esc(loadErr)}</p>` : !data ? `<p class="faint" style="margin:0">Cargando…</p>`
      : `${editorHtml(data, st)}${data.byOther ? `<small class="faint">Los cambió ${esc(data.byOther)}.</small>` : ""}`}`;
    if (data) bindEditor(aBox, data, st, drawA);
  };
  const drawC = () => {
    if (!cBox?.isConnected) return;
    // AE: abierto; los demás, plegado («¿Das demos?»). En el perfil obligatorio de la primera vez, solo un AE.
    cBox.hidden = required && !isAe();
    if (cBox.hidden) return;
    const open = isAe() || cal?.connected || cBox.querySelector("details")?.open;
    cBox.innerHTML = `<details class="cal-box"${open ? " open" : ""}><summary><b>Tu calendario para las demos</b>${isAe() ? "" : ` <span class="faint">· si das demos</span>`}${cal?.connected ? ` <span class="pill res-ok">conectado</span>` : ""}</summary><div class="cal-in">${calHtml(cal, ui)}</div></details>`;
    bindCal();
  };
  const calDo = async (fn, busy) => {
    ui.err = ""; if (busy) { ui[busy] = true; drawC(); }
    try { cal = await fn(); } catch (e) { ui.err = e.message; }
    if (busy) ui[busy] = false; drawC();
  };
  function bindCal() {
    const q = s => cBox.querySelector(s);
    q("#calGo")?.addEventListener("click", () => {
      const url = q("#calUrl").value.trim(); if (!url) { ui.err = "Pegá la dirección de tu calendario."; drawC(); return; }
      calDo(async () => { const r = await api("/api/me/calendar", { body: { url } }); ui.change = false; ui.test = `Listo. Veo ${r.events} evento${r.events === 1 ? "" : "s"} en las próximas 2 semanas.`; toast("Calendario conectado"); return r; }, "saving");
    });
    q("#calUrl")?.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); q("#calGo").click(); } });
    q("#calTest")?.addEventListener("click", () => calDo(async () => { const r = await api("/api/me/calendar/test", { body: {} }); ui.test = `Veo ${r.events} evento${r.events === 1 ? "" : "s"} en las próximas 2 semanas.`; return r; }, "testing"));
    q("#calOff")?.addEventListener("click", () => calDo(async () => { const r = await api("/api/me/calendar/disconnect", { body: {} }); ui.test = ""; toast("Calendario desconectado"); return r; }));
    q("#calChange")?.addEventListener("click", () => { ui.change = true; drawC(); cBox.querySelector("#calUrl")?.focus(); });
    const h = () => (ui.hours ||= { ...cal.hours, days: [...cal.hours.days] });
    cBox.querySelectorAll("[data-cdow]").forEach(b => b.onclick = () => { const d = +b.dataset.cdow, x = h(); x.days = x.days.includes(d) ? x.days.filter(y => y !== d) : [...x.days, d]; drawC(); });
    q("#calFrom")?.addEventListener("change", e => { h().from = e.target.value; drawC(); });
    q("#calTo")?.addEventListener("change", e => { h().to = e.target.value; drawC(); });
    q("#calHours")?.addEventListener("click", () => calDo(async () => { const r = await api("/api/me/calendar/hours", { body: ui.hours }); ui.hours = null; toast("Horario guardado"); return r; }));
  }
  api("/api/me/accounts").then(r => { data = r; st = newDraft(r); }, e => { loadErr = `No pude cargar tus accounts: ${e.message}`; }).finally(drawA);
  api("/api/me/calendar").then(r => { cal = r; }, e => { ui.err = e.message; cal = { connected: false, hours: { days: [1, 2, 3, 4, 5], from: "09:00", to: "18:00" }, tz: "" }; }).finally(drawC);
  drawA(); drawC();
  return {
    roleChanged() { drawA(); drawC(); },
    // guardar el perfil confirma los accounts (también los sugeridos). Si no cargaron, no se toca nada.
    async save() { if (isAe() || !data) return; data = await api("/api/me/accounts", { body: { accounts: payload(data, st) } }); st = newDraft(data); forgetAccounts(); },
  };
}

// ---------- Equipo › Accesos del equipo: los accounts de otra persona (dirección o el líder de su equipo; el servidor controla)
export function openPersonAccounts(u) {
  let data = null, st = null, err = "", busy = false;
  const m = modal(`<div class="modal-h"><h3>${icon("users")} Accounts de ${esc(u.name.split(" ")[0])}</h3><button class="icon-btn" id="paX" aria-label="Cerrar">${icon("x")}</button></div>
    <p class="muted" style="margin:-8px 0 0">Quién da las demos de ${esc(u.name)} en cada país. Se lo propone la app al agendar.</p>
    <div id="paBox"><p class="faint" style="margin:0">Cargando…</p></div>
    <p class="err" id="paErr" role="alert" style="margin:0"></p>
    <div class="row"><button class="btn" id="paNo">Cancelar</button><button class="btn primary" id="paGo" disabled>Guardar</button></div>`);
  const q = s => m.querySelector(s), path = `/api/team/accounts/${encodeURIComponent(u.email)}`;
  const draw = () => { if (!m.isConnected || !data) return; q("#paBox").innerHTML = editorHtml(data, st); bindEditor(q("#paBox"), data, st, draw); q("#paGo").disabled = busy; };
  q("#paX").onclick = q("#paNo").onclick = () => m.close();
  api(path).then(r => { data = r; st = newDraft(r); draw(); }, e => { err = e.message; q("#paBox").innerHTML = `<div class="callout err">${icon("alert")}<span>${esc(err)}</span></div>`; });
  q("#paGo").onclick = async () => {
    busy = true; draw(); q("#paErr").textContent = "";
    try { data = await api(path, { body: { accounts: payload(data, st) } }); st = newDraft(data); m.close(); toast(`Accounts de ${u.name.split(" ")[0]} guardados`); }
    catch (e) { busy = false; draw(); q("#paErr").textContent = e.message; }
  };
}
