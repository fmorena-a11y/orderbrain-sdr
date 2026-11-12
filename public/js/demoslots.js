// «Proponer demo» (ficha) y los horarios libres del account en Registrar («Demo agendada»). Lo calcula el servidor
// (lib/accounts.js): acá solo se muestra libre/ocupado, nunca qué tiene el account.
//  1) «¿Con qué account es la demo?»: el que te toca por el país del colegio (tu perfil, o el sugerido) va elegido; se puede
//     elegir otro. 2) Sus horarios libres en la hora del colegio (y la tuya entre paréntesis): tres sugeridos y «Ver más
//     horarios». Sin calendario conectado no se afirma nada: «sin confirmar». 3) Marcás 1 a 3 y la app arma el mensaje con el
//     trato del país; se manda con el modal de mensajes de la ficha (WhatsApp o mail).
// En Registrar, con «Demo agendada»: quién da la demo viene con el account que te toca (o el de la propuesta), y debajo sus
// horarios para tocar (los que propusiste, primero). Si la hora elegida choca con algo suyo, avisa (no bloquea).
import { S, api, esc, icon, toast, copy, modal } from "./core.js";

const TTL = 120e3;
const ACC = new Map(), FREE = new Map(), MSG = new Map();
// lo que propusiste desde «Proponer demo» en cada ficha (para Registrar): schoolId → { accountId, ats, at }
const PROPOSED = new Map();
// después de cambiar tus accounts (perfil): el que te toca se vuelve a pedir
export const forgetAccounts = () => ACC.clear();
const REGMORE = new Set();
let CUR = null; // Registrar abierto: { s, f, redraw }

function cached(map, key, url) {
  const c = map.get(key);
  if (c?.data && Date.now() - c.at < TTL) return Promise.resolve(c.data);
  if (c?.p) return c.p;
  const p = api(url).then(d => { map.set(key, { data: d, at: Date.now() }); return d; }, e => { map.set(key, { err: e.message, at: Date.now() }); throw e; });
  map.set(key, { ...(c?.data ? c : {}), p });
  return p;
}
const peek = (map, key) => map.get(key) || null;
const accUrl = sid => `/api/schools/${encodeURIComponent(sid)}/account`;
const freeKey = (id, sid, dur) => `${id}|${sid}|${dur}`;
const freeUrl = (id, sid, dur) => `/api/accounts/${encodeURIComponent(id)}/free?schoolId=${encodeURIComponent(sid)}&duration=${dur}`;
const loadFree = (id, sid, dur) => cached(FREE, freeKey(id, sid, dur), freeUrl(id, sid, dur));
const durOf = n => [30, 45, 60].includes(Number(n)) ? Number(n) : Number(n) > 45 ? 60 : Number(n) > 30 ? 45 : 30;
const short = label => label.replace(/^(\S{3})\S*/, "$1");
const firstOf = n => String(n || "").split(" ")[0];
const placeTxt = f => f?.school?.place ? `hora de ${f.school.place}` : "tu hora";

// ---------- piezas
function statusHtml(f, { compact = false } = {}) {
  const who = esc(f.account.first), out = [];
  if (f.calendar === "ok") out.push(`<div class="callout ok ds-st">${icon("checkCircle")}<span>Libre según ${f.source === "google" ? "su Google Calendar" : "su calendario"}${f.pipedrive ? " y su agenda de Pipedrive" : ""}. Horas de ${esc(f.school.place || "el colegio")}${f.days.some(d => d.slots.some(x => x.mine)) ? ", y entre paréntesis la tuya" : ""}.</span></div>`);
  else if (f.calendar === "error") out.push(`<div class="callout err ds-st">${icon("alert")}<span>No pude leer el calendario de ${who}${f.problem ? ` (${esc(f.problem.replace(/\.$/, "").toLowerCase())})` : ""}. Los horarios van «sin confirmar»: confirmalo con ${who} antes de mandarlos.</span></div>`);
  else out.push(`<div class="callout warn ds-st">${icon("alert")}<span><b>${who} todavía no conectó su calendario.</b> ${compact ? "" : `Solo veo su agenda de Pipedrive: los horarios van «sin confirmar». `}</span><button type="button" class="btn sm" data-nudge>${icon("copy", "sm")} Avisarle</button></div>`);
  if (!f.pipedrive) out.push(`<p class="faint ds-note">No pude leer su agenda de Pipedrive.</p>`);
  if (!f.school.sure && !compact) out.push(`<p class="faint ds-note">No sé el huso exacto del colegio: van en hora del centro de ${esc(f.school.place)}.</p>`);
  return out.join("");
}
// day: false en la lista por día (el día ya está arriba: va solo la hora)
const slotChip = (v, { picked = false, unsure = false, attr = "data-at", day = true } = {}) => `<button type="button" class="ds-slot${unsure ? " unsure" : ""}" ${attr}="${esc(v.at)}" aria-pressed="${picked}" aria-label="${esc(`${v.label} a las ${v.time}${v.mine ? ` (${v.mine} tu hora)` : ""}${unsure ? ", sin confirmar" : ""}`)}"><b>${day ? `${esc(short(v.label))} · ` : ""}${esc(v.time)}</b>${v.mine ? `<small>(${esc(v.mine)} tu hora)</small>` : ""}${unsure ? `<small class="ds-uns">sin confirmar</small>` : ""}</button>`;
function nudgeText(name) {
  return `Hola ${firstOf(name)}! Para que el equipo vea cuándo estás libre para demos, conectá tu calendario en OrderBrain SDR (una sola vez): en Google Calendar abrí Configuración, elegí tu calendario, entrá a «Integrar el calendario», copiá la «Dirección secreta en formato iCal» y pegala en la app, en Tu perfil › Tu calendario para las demos. Solo se ve libre u ocupado, nunca los títulos. ${location.origin}`;
}

// ---------- «Proponer demo»
export function proposeDemo(s, d, { send }) {
  const st = { step: "who", id: null, dur: 30, picked: [], more: false, preview: "", previewKey: "", working: false, err: "" };
  const m = modal(`<div class="ds" id="dsBox"><p class="faint" style="margin:0"><span class="spin"></span> Cargando…</p></div>`);
  const box = m.querySelector("#dsBox");
  const contact = d?.persons?.[0]?.name || "";
  let acc = null, accErr = "";
  const free = () => peek(FREE, freeKey(st.id, s.id, st.dur));
  const nameOf = id => acc?.accounts.find(p => p.id === id)?.name || acc?.others.find(p => p.id === id)?.name || "";
  const draw = () => { if (!m.isConnected) return; box.innerHTML = st.step === "who" ? whoHtml() : whenHtml(); bind(); };
  function whoHtml() {
    const head = `<div class="modal-h"><h3>${icon("video")} Proponer demo</h3><button type="button" class="icon-btn" data-x aria-label="Cerrar">${icon("x")}</button></div><p class="muted" style="margin:-8px 0 0">${esc(s.name)}</p>`;
    if (accErr) return `${head}<div class="callout err">${icon("alert")}<span>${esc(accErr)}</span></div>`;
    if (!acc) return `${head}<p class="faint" style="margin:0"><span class="spin"></span> Cargando…</p>`;
    const sub = p => [p.me ? "vos" : "", acc.mine?.id === p.id ? "" : p.countries?.length ? p.countries.join(", ") : "", p.calendar ? "con calendario" : "sin calendario conectado"].filter(Boolean).join(" · ");
    const toca = p => acc.mine?.id === p.id && acc.country ? ` <span class="ds-toca">(te toca por ${esc(acc.country)})</span>` : "";
    const inList = acc.accounts.some(p => p.id === st.id);
    return `${head}
      <fieldset class="ds-who"><legend>¿Con qué account es la demo?</legend>
        ${acc.mine ? "" : `<div class="callout info">${icon("alert")}<span>${acc.country ? `No tenés account para ${esc(acc.country)}: elegí quién da la demo (y guardalo en tu perfil para la próxima).` : "El colegio no tiene país: elegí quién da la demo."}</span></div>`}
        <div class="ds-accs" role="radiogroup">${acc.accounts.map(p => `<label class="ds-acc"><input type="radio" name="dsAcc" value="${p.id}" ${st.id === p.id ? "checked" : ""}><span><b>${esc(p.name)}${toca(p)}</b><small>${esc(sub(p))}</small></span></label>`).join("")}</div>
        ${acc.others.length ? `<label class="field"><span>Otra persona</span><select class="inp" id="dsOther"><option value="">Elegí…</option>${acc.others.map(o => `<option value="${o.id}" ${st.id === o.id && !inList ? "selected" : ""}>${esc(o.name)}</option>`).join("")}</select></label>` : ""}
      </fieldset>
      <div class="row"><button type="button" class="btn" data-x>Cancelar</button><button type="button" class="btn primary" id="dsNext" ${st.id ? "" : "disabled"}>Ver sus horarios ${icon("arrowRight", "sm")}</button></div>`;
  }
  function whenHtml() {
    const fr = free(), f = fr?.data, name = f?.account.name || nameOf(st.id), first = firstOf(name);
    const head = `<div class="modal-h"><h3><button type="button" class="icon-btn" id="dsBack" aria-label="Elegir otro account" title="Elegir otro account">${icon("arrowLeft")}</button> Horarios de ${esc(first)}</h3><button type="button" class="icon-btn" data-x aria-label="Cerrar">${icon("x")}</button></div>
      <p class="muted" style="margin:-8px 0 0">${esc(name)} · ${esc(s.name)}</p>
      <div class="ds-bar"><span class="muted">Duración</span><div class="seg" role="group" aria-label="Duración">${[30, 45, 60].map(n => `<button type="button" data-dur="${n}" aria-pressed="${st.dur === n}">${n} min</button>`).join("")}</div></div>`;
    if (!f && fr?.err) return `${head}<div class="callout err">${icon("alert")}<span>No pude ver sus horarios: ${esc(fr.err)}</span><button type="button" class="btn sm" id="dsRetry">Reintentar</button></div>`;
    if (!f) return `${head}<p class="faint" style="margin:0"><span class="spin"></span> Buscando cuándo está libre…</p>`;
    const all = f.days.flatMap(x => x.slots), byAt = new Map(all.map(v => [v.at, v])), unsure = !f.sure;
    const sug = f.suggested.map(a => byAt.get(a)).filter(Boolean);
    const n = st.picked.length;
    return `${head}${statusHtml(f)}
      ${!all.length ? `<div class="callout warn">${icon("alert")}<span>No encontré horarios libres de ${esc(first)} en los próximos 10 días hábiles (su horario para demos: ${esc(f.hours.from)} a ${esc(f.hours.to)}, ${esc(placeOf(f))}). Probá con otra duración u otro account.</span></div>` : `
      <div class="ds-sec"><span class="ds-h">${unsure ? "Posibles horarios" : "Te sugiero"}</span><div class="ds-slots">${sug.map(v => slotChip(v, { picked: st.picked.includes(v.at), unsure })).join("")}</div></div>
      <button type="button" class="linkbtn" id="dsMore" aria-expanded="${st.more}">${st.more ? "Ver menos" : "Ver más horarios"}</button>
      ${st.more ? `<div class="ds-days">${f.days.map(x => `<div class="ds-day"><span class="ds-h">${esc(x.label)}</span><div class="ds-slots">${x.slots.map(v => slotChip(v, { picked: st.picked.includes(v.at), unsure, day: false })).join("")}</div></div>`).join("")}</div>` : ""}
      <p class="faint ds-count" role="status">${n ? `${n} de 3 elegido${n > 1 ? "s" : ""}.` : "Marcá de 1 a 3 horarios."}${unsure && n ? ` Confirmalo con ${esc(first)} antes de mandarlo.` : ""}</p>
      <div class="ds-msg" id="dsMsg" aria-live="polite">${n ? (st.preview ? esc(st.preview) : `<span class="faint"><span class="spin"></span> Armando el mensaje…</span>`) : `<span class="faint">Elegí al menos un horario y armo el mensaje.</span>`}</div>
      ${st.err ? `<p class="err" role="alert" style="margin:0">${esc(st.err)}</p>` : ""}
      <div class="row"><button type="button" class="btn wa" id="dsWa" ${n && !st.working ? "" : "disabled"}>${icon("whatsapp")} WhatsApp</button><button type="button" class="btn" id="dsMail" ${n && !st.working ? "" : "disabled"}>${icon("mail")} Mail</button></div>`}`;
  }
  const placeOf = f => `hora de ${f.account.place || f.school.place || "allá"}`;
  const msgKey = ch => `${s.id}|${st.id}|${st.dur}|${ch}|${[...st.picked].sort().join(",")}|${contact}`;
  const msgUrl = ch => `/api/schools/${encodeURIComponent(s.id)}/demo-message?account=${st.id}&duration=${st.dur}&channel=${ch}&contact=${encodeURIComponent(contact)}&${st.picked.map(a => `at=${encodeURIComponent(a)}`).join("&")}`;
  const message = ch => cached(MSG, msgKey(ch), msgUrl(ch));
  let pt = null;
  const preview = () => {
    clearTimeout(pt); st.preview = "";
    if (!st.picked.length) return;
    const k = msgKey("whatsapp");
    pt = setTimeout(() => message("whatsapp").then(r => { if (msgKey("whatsapp") !== k) return; st.preview = r.text; const el = m.querySelector("#dsMsg"); if (el) el.textContent = r.text; }, e => { st.err = e.message; draw(); }), 200);
  };
  const loadSlots = () => { draw(); loadFree(st.id, s.id, st.dur).finally(draw); };
  function bind() {
    box.querySelectorAll("[data-x]").forEach(b => b.onclick = () => m.close());
    box.querySelectorAll('input[name="dsAcc"]').forEach(r => r.onchange = () => { st.id = Number(r.value); const o = box.querySelector("#dsOther"); if (o) o.value = ""; box.querySelector("#dsNext").disabled = false; });
    box.querySelector("#dsOther")?.addEventListener("change", e => { if (!e.target.value) return; st.id = Number(e.target.value); box.querySelectorAll('input[name="dsAcc"]').forEach(r => (r.checked = false)); box.querySelector("#dsNext").disabled = false; });
    box.querySelector("#dsNext")?.addEventListener("click", () => { st.step = "when"; st.picked = []; st.preview = ""; st.err = ""; loadSlots(); });
    box.querySelector("#dsBack")?.addEventListener("click", () => { st.step = "who"; draw(); });
    box.querySelector("#dsRetry")?.addEventListener("click", () => { FREE.delete(freeKey(st.id, s.id, st.dur)); loadSlots(); });
    box.querySelectorAll("[data-dur]").forEach(b => b.onclick = () => { st.dur = Number(b.dataset.dur); st.picked = []; st.preview = ""; loadSlots(); });
    box.querySelector("#dsMore")?.addEventListener("click", () => { st.more = !st.more; draw(); });
    box.querySelector("[data-nudge]")?.addEventListener("click", () => copy(nudgeText(free()?.data?.account.name || nameOf(st.id))));
    box.querySelectorAll("[data-at]").forEach(b => b.onclick = () => {
      const a = b.dataset.at, i = st.picked.indexOf(a);
      if (i >= 0) st.picked.splice(i, 1); else if (st.picked.length >= 3) return toast("Hasta 3 horarios: sacá uno para elegir otro", { type: "info" }); else st.picked.push(a);
      st.err = ""; preview(); draw(); box.querySelector(`[data-at="${CSS.escape(a)}"]`)?.focus();
    });
    const go = ch => async () => {
      st.working = true; st.err = ""; draw();
      try {
        const r = await message(ch);
        PROPOSED.set(s.id, { accountId: st.id, ats: [...st.picked].sort(), dur: st.dur, at: Date.now() });
        m.close();
        send({ channel: ch, label: "Proponer horarios de demo", text: r.text, subject: r.subject || "" });
      } catch (e) { st.working = false; st.err = e.message; draw(); }
    };
    box.querySelector("#dsWa")?.addEventListener("click", go("whatsapp"));
    box.querySelector("#dsMail")?.addEventListener("click", go("mail"));
  }
  draw();
  cached(ACC, s.id, accUrl(s.id)).then(a => {
    acc = a;
    // el de la propuesta anterior de esta ficha o el que te toca; si no, nadie elegido
    const prev = PROPOSED.get(s.id)?.accountId;
    st.id = [prev, a.mine?.id].find(id => id && (a.accounts.some(p => p.id === id) || a.others.some(p => p.id === id))) || null;
    draw();
  }, e => { accErr = `No pude cargar los accounts: ${e.message}`; draw(); });
}

// ---------- Registrar («Demo agendada»)
const ownerId = f => f.demo.ownerId ? Number(f.demo.ownerId) : S.me?.pdUserId || null;
const fmt = new Map();
function partsTz(ms, tz) {
  let f = fmt.get(tz);
  if (!f) { f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }); fmt.set(tz, f); }
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { dow: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday), date: `${p.year}-${p.month}-${p.day}`, time: `${String(+p.hour % 24).padStart(2, "0")}:${p.minute}` };
}
const DAYN = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
const daysTxt = days => { const s = [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)); return s.join() === "1,2,3,4,5" ? "lunes a viernes" : s.map(d => DAYN[d]).join(", "); };
// ¿choca con algo del account? (o está fuera de su horario para demos). { kind: warn|info, text } o null
export function clashOf(f, data, now = Date.now()) {
  if (!f?.demo?.date || !f.demo.time || !data) return null;
  const t = new Date(`${f.demo.date}T${f.demo.time}:00`).getTime(); if (!Number.isFinite(t) || t < now - 60e3) return null;
  const e = t + (Number(f.demo.duration) || 30) * 60e3, who = data.account.first;
  if (data.busy.some(([a, b]) => t < Date.parse(b) && e > Date.parse(a))) return { kind: "warn", text: `${who} tiene algo a esa hora${data.sure ? "" : " en Pipedrive"}. Elegí otro horario o confirmalo con ${who}.` };
  const h = data.hours, p = partsTz(t, h.tz), q = partsTz(e - 60e3, h.tz);
  if (!h.days.includes(p.dow) || p.time < h.from || q.time >= h.to || p.date !== q.date) return { kind: "info", text: `Está fuera de su horario para demos (${daysTxt(h.days)} de ${h.from} a ${h.to}, hora de ${data.account.place || data.school.place}).` };
  return null;
}
const localOf = at => { const d = new Date(at); return { vDate: d.toLocaleDateString("sv"), vTime: d.toTimeString().slice(0, 5) }; };
function regInner(s, f) {
  const a = peek(ACC, s.id)?.data, id = ownerId(f); if (!id) return "";
  const fr = peek(FREE, freeKey(id, s.id, durOf(f.demo.duration))), data = fr?.data;
  const mine = a?.mine, out = [];
  if (mine) out.push(`<p class="ds-note">${icon("user", "sm")} ${mine.id === id ? `Te toca <b>${esc(mine.name)}</b>${a.country ? ` (por ${esc(a.country)})` : ""}. ¿Otra persona? Cambiala arriba.` : `Por ${esc(a.country)} te toca ${esc(mine.name)}; elegiste a ${esc(data?.account.name || "otra persona")}.`}</p>`);
  if (!data) { out.push(fr?.err && !fr.p ? `<p class="faint ds-note">No pude ver sus horarios: ${esc(fr.err)}</p>` : `<p class="faint ds-note"><span class="spin"></span> Buscando cuándo está libre…</p>`); return out.join(""); }
  const c = clashOf(f, data);
  if (c) out.push(`<div class="callout ${c.kind} ds-clash" role="status">${icon("alert")}<span>${esc(c.text)}</span></div>`);
  out.push(statusHtml(data, { compact: true }));
  const all = data.days.flatMap(x => x.slots), byAt = new Map(all.map(v => [v.at, v])), unsure = !data.sure, cur = `${f.demo.date}T${f.demo.time}`;
  const on = v => `${v.vDate}T${v.vTime}` === cur;
  // los que propusiste desde esta ficha (con este account), primero; uno que ya no está libre va tachado
  const prop = PROPOSED.get(s.id), props = prop && prop.accountId === id ? prop.ats.filter(x => Date.parse(x) > Date.now()) : [];
  if (props.length) out.push(`<div class="ds-sec"><span class="ds-h">Los que propusiste</span><div class="ds-slots">${props.map(x => { const v = byAt.get(x); if (v) return slotChip(v, { picked: on(v), unsure, attr: "data-rat" }); const l = localOf(x), p = partsTz(Date.parse(x), data.school.tz); return `<button type="button" class="ds-slot gone" data-rat="${esc(x)}" aria-pressed="${`${l.vDate}T${l.vTime}` === cur}"><b>${esc(DAYN[p.dow])} ${+p.date.slice(8)} · ${p.time}</b><small>ya no está libre</small></button>`; }).join("")}</div></div>`);
  const sug = data.suggested.map(x => byAt.get(x)).filter(v => v && !props.includes(v.at));
  if (!all.length) out.push(`<p class="faint ds-note">No encontré horarios libres en los próximos 10 días hábiles.</p>`);
  else {
    out.push(`<div class="ds-sec"><span class="ds-h">${unsure ? "Posibles horarios" : "Horarios libres"} <small class="faint">${esc(placeTxt(data))}</small></span><div class="ds-slots">${sug.map(v => slotChip(v, { picked: on(v), unsure, attr: "data-rat" })).join("")}</div></div>`);
    out.push(`<button type="button" class="linkbtn" data-rmore aria-expanded="${REGMORE.has(s.id)}">${REGMORE.has(s.id) ? "Ver menos" : "Ver más horarios"}</button>`);
    if (REGMORE.has(s.id)) out.push(`<div class="ds-days">${data.days.map(x => `<div class="ds-day"><span class="ds-h">${esc(x.label)}</span><div class="ds-slots">${x.slots.map(v => slotChip(v, { picked: on(v), unsure, attr: "data-rat", day: false })).join("")}</div></div>`).join("")}</div>`);
  }
  return out.join("");
}
export const regSlotsHtml = (s, f) => `<div class="ds-reg" id="dsReg" data-sid="${esc(s.id)}">${regInner(s, f)}</div>`;
function rerender() {
  const c = CUR, el = document.getElementById("dsReg"); if (!c || !el || el.dataset.sid !== c.s.id) return;
  el.innerHTML = regInner(c.s, c.f); bindInner(el, c);
}
function bindInner(el, { s, f }) {
  const dr = el.closest(".drawer") || document, all = () => { const d = peek(FREE, freeKey(ownerId(f), s.id, durOf(f.demo.duration)))?.data; return d ? d.days.flatMap(x => x.slots) : []; };
  el.querySelectorAll("[data-rat]").forEach(b => b.onclick = () => {
    const v = all().find(x => x.at === b.dataset.rat) || localOf(b.dataset.rat);
    f.demo.date = v.vDate; f.demo.time = v.vTime;
    const di = dr.querySelector('[data-f="demo.date"]'), ti = dr.querySelector('[data-f="demo.time"]');
    if (di) di.value = v.vDate; if (ti) ti.value = v.vTime;
    rerender(); toast(`Demo: ${b.querySelector("b")?.textContent || v.vTime}`, { type: "info", ms: 2500 });
  });
  el.querySelector("[data-rmore]")?.addEventListener("click", () => { if (REGMORE.has(s.id)) REGMORE.delete(s.id); else REGMORE.add(s.id); rerender(); });
  el.querySelector("[data-nudge]")?.addEventListener("click", () => { const d = peek(FREE, freeKey(ownerId(f), s.id, durOf(f.demo.duration)))?.data; copy(nudgeText(d?.account.name || "")); });
}
// school.js lo llama al final de bindLog con «Demo agendada» (después de sus propios oyentes de los campos)
export function bindRegSlots(s, f, { redraw }) {
  const el = document.getElementById("dsReg"); if (!el) return;
  CUR = { s, f, redraw };
  const ensureFree = () => { const id = ownerId(f); if (id) loadFree(id, s.id, durOf(f.demo.duration)).then(rerender, rerender); };
  // quién da la demo: el account de la propuesta o el que te toca (si está en la lista del equipo y no es uno mismo)
  const preselect = a => {
    if (f.demo.ownerTouched || f.demo.auto || f.demo.ownerId) return;
    const id = PROPOSED.get(s.id)?.accountId || a?.mine?.id;
    if (!id || id === S.me?.pdUserId) { f.demo.auto = true; return; }
    if (!(S.team || []).some(u => u.id === id)) return; // el equipo todavía no cargó: se intenta en el próximo dibujo
    f.demo.auto = true; f.demo.ownerId = String(id); redraw();
  };
  const a = peek(ACC, s.id);
  if (a?.data) preselect(a.data);
  else cached(ACC, s.id, accUrl(s.id)).then(d => { if (CUR?.f === f) { preselect(d); rerender(); } }, rerender);
  ensureFree();
  el.closest(".drawer")?.querySelector('[data-f="demo.ownerId"]')?.addEventListener("change", () => { f.demo.ownerTouched = true; ensureFree(); rerender(); });
  for (const k of ["demo.date", "demo.time", "demo.duration"]) el.closest(".drawer")?.querySelector(`[data-f="${k}"]`)?.addEventListener(k === "demo.duration" ? "change" : "input", () => { if (k === "demo.duration") ensureFree(); rerender(); });
  bindInner(el, CUR);
}
