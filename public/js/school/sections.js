// Ficha del colegio: «Qué pasó con OrderEAT», tratos y decisores, Enriquecer y sedes.
import { $, S, api, esc, icon, leadsOver, modal, openMenu, patchSchool, telLink, toast } from "../core.js";
import { D, delaEsp } from "./state.js";
import { load } from "./open.js";
import { keepScroll, loadStudy } from "./media.js";
import { canProspect, draw, goTab } from "./render.js";
import { apiEx } from "./prep.js";

// ---------- Qué pasó con OrderEAT: cliente, onboarding, churn o perdido. World Dominion + Pipedrive + Slack.
export const HIST = new Map();
const wantsHistory = (s, d) => !!(s.ob || s.phase || ["client", "churn", "lost", "stalled"].includes(s.status) || d?.deals?.some(x => x.status !== "open"));
export async function loadHistory(id, d) {
  const s = S.byId.get(id); if (!s || HIST.has(id) || !wantsHistory(s, d)) return;
  HIST.set(id, null);
  try { HIST.set(id, await api(`/api/schools/${encodeURIComponent(id)}/history`)); } catch { HIST.delete(id); return; }
  if (D.id === id && D.tab === "prep") keepScroll(draw);
}
// corta un texto largo con «…» (que no parezca otra cosa: «el 10/1» por «el 10/11»)
const clip = (t, n) => t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t;
const INFO_LABEL = k => k.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ").replace(/^./, c => c.toUpperCase());
export function historySec(s) {
  const h = HIST.get(s.id); if (!h) return "";
  const b = h.brain, day = v => v ? esc(new Intl.DateTimeFormat("es", { day: "numeric", month: "short", year: "numeric" }).format(new Date(String(v).slice(0, 10) + "T12:00:00"))) : "";
  const deals = h.deals.filter(x => x.status !== "open" || x.clientPipe);
  if (!b && !deals.length && !h.notes.length && !h.slack?.msgs?.length) return "";
  return `<section class="sec" id="histSec"><h3><span class="l">${icon("refresh")} Qué pasó con OrderEAT</span></h3>
    ${b ? `<div class="hist-b"><b>World Dominion: ${esc(b.label)}</b>${b.client ? ` · cliente «${esc(b.client)}»` : ""}${b.site && b.site !== s.name ? ` · sitio «${esc(b.site)}»` : ""}${b.start ? ` · inicio ${day(b.start)}` : ""}
      ${Object.keys(b.info || {}).length ? `<div class="faint" style="font-size:var(--fs-sm);margin-top:4px">${Object.entries(b.info).map(([k, v]) => `${esc(INFO_LABEL(k))}: ${esc(/^\d{4}-\d{2}-\d{2}/.test(String(v)) ? day(v) : String(v))}`).join(" · ")}</div>` : ""}</div>` : ""}
    ${deals.length ? `<div class="sub-h">Tratos en Pipedrive${h.orgs > 1 ? ` (${h.orgs} organizaciones con este nombre)` : ""}</div>${deals.map(x => `<div class="act"><span class="ty">${icon("deal")}</span><div class="t"><b><a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title)}</a></b>
      <small>${esc([x.pipeline, x.stage].filter(Boolean).join(" · "))} · ${x.status === "won" ? `ganado ${day(x.won)}` : x.status === "lost" ? `perdido ${day(x.lost)}${x.lostReason ? ` · «${esc(x.lostReason)}»` : ""}` : `abierto desde ${day(x.added)}`}${x.owner ? ` · ${esc(x.owner)}` : ""}</small></div></div>`).join("")}` : ""}
    ${h.notes.length ? `<div class="sub-h">Últimas notas</div>${h.notes.slice(0, 4).map(n => `<details class="obj"><summary>${day(n.at)}${n.author ? ` · ${esc(n.author)}` : ""}${n.deal ? ` · ${esc(n.deal)}` : ""} — ${esc(clip(n.text.split("\n")[0], 90))}</summary><p style="white-space:pre-wrap">${esc(n.text)}</p></details>`).join("")}` : ""}
    ${h.slack?.msgs?.length ? `<div class="sub-h">En Slack (lanzamientos y bajas)</div>${h.slack.msgs.map(m => { const f = m.fields || {};
      const head = m.kind ? `${esc(m.kind)}${f.reason ? ` — ${esc(f.reason.slice(0, 90))}` : ""}` : esc(m.text.slice(0, 90));
      const who = [f.account && `Account: ${f.account}`, f.onboarder && `Onboarder: ${f.onboarder}`, f.author && `Cargó: ${f.author}`].filter(Boolean).join(" · ");
      return `<details class="obj"><summary>${day(m.at)} · ${head}</summary>${m.kind ? `${f.reason ? `<p><b>Motivo:</b> ${esc(f.reason)}</p>` : ""}${f.before ? `<p class="faint">Estado previo: ${esc(f.before)}</p>` : ""}${who ? `<p class="faint">${esc(who)}</p>` : ""}${f.place ? `<p class="faint">${esc(f.site || "")} · ${esc(f.place)}</p>` : ""}` : `<p style="white-space:pre-wrap">${esc(m.text)}</p>`}<a href="${esc(m.url)}" target="_blank" rel="noopener">Abrir en Slack</a></details>`; }).join("")}`
      : h.slackEnabled ? `<p class="faint" style="margin:8px 0 0;font-size:var(--fs-sm)">${h.slack?.error ? `No pude leer Slack: ${esc(h.slack.error)}` : "No hay mensajes en Slack que nombren a este colegio."}</p>` : ""}
  </section>`;
}

// ---------- tratos y decisores desde la ficha, sin abrir Pipedrive. Cada uno lo suyo; un líder, lo de la gente de sus equipos
// (dirección: todo). El servidor lo vuelve a controlar.
const mineOrLeader = ownerId => (!!ownerId && ownerId === S.me.pdUserId) || leadsOver(ownerId);
// Solo tratos de venta abiertos: los de clientes (onboarding, clientes, performance) se cambian en Pipedrive.
const stageAt = (x, id) => (x.stages || []).findIndex(st => st.id === id);
export function dealOpsHtml(x) {
  if (x.status !== "open" || !x.id || x.clientPipe || !x.stages || !mineOrLeader(x.ownerId)) return "";
  const b = (op, label, cls = "") => `<button class="btn sm ${cls}" data-deal="${x.id}" data-dop="${op}"${op === "stage" ? ' aria-haspopup="menu"' : ""}>${label}</button>`;
  // «Propuesta enviada» solo si el trato todavía no llegó a esa etapa (no lo manda para atrás)
  return `<div class="deal-ops">${x.proposalStage && stageAt(x, x.stageId) < stageAt(x, x.proposalStage) ? b("proposal", `${icon("mail", "sm")} Propuesta enviada`) : ""}${(x.stages || []).length > 1 ? b("stage", "Mover de etapa") : ""}${b("won", `${icon("check", "sm")} Ganado`)}${b("lost", "Perdido", "ghost")}</div>`;
}
const dealOf = (s, id) => [...(D.data?.deals || []), ...(HIST.get(s.id)?.deals || [])].find(x => x.id === id);
export function bindDeals(s) {
  $("drawer").querySelectorAll("[data-deal]").forEach(b => b.onclick = () => {
    const x = dealOf(s, Number(b.dataset.deal)); if (!x) return;
    const op = b.dataset.dop, prop = x.stages?.find(st => st.id === x.proposalStage);
    if (op === "proposal" && prop) return dealConfirm(s, x, { action: "proposal" }, `Propuesta enviada: pasa a ${prop.name}`);
    if (op === "won") return dealConfirm(s, x, { action: "won" }, "Marcar como ganado");
    if (op === "lost") return dealConfirm(s, x, { action: "lost" }, "Marcar como perdido");
    if (op === "stage") openMenu(b, [{ head: "Mover a" }, ...x.stages.filter(st => st.id !== x.stageId).map(st => ({ label: st.name, fn: () => dealConfirm(s, x, { action: "stage", stageId: st.id }, `${stageAt(x, st.id) < stageAt(x, x.stageId) ? "Volver" : "Mover"} a ${st.name}`) }))]);
  });
}
// Confirmación antes de escribir en Pipedrive; después, lo que se hizo (con el enlace al trato)
function dealConfirm(s, x, body, title) {
  const lost = body.action === "lost";
  const m = modal(`<div class="modal-h"><h3>${icon("deal")} ${esc(title)}</h3><button class="icon-btn" id="dcX" aria-label="Cerrar">${icon("x")}</button></div>
    <p class="muted" style="margin:-6px 0 0">${esc(x.title)} · ${esc([x.pipeline, x.stage].filter(Boolean).join(" · "))}</p>
    ${lost ? `<label class="field"><span>Motivo</span><select class="inp" id="dcWhy"><option value="">Elegí el motivo</option>${S.lostReasons.map(r => `<option value="${esc(r)}">${esc(r.replace(/\s+/g, " "))}</option>`).join("")}</select></label>` : ""}
    <p class="muted" style="margin:0;font-size:var(--fs-md)">Se cambia en Pipedrive y queda una nota en el trato a tu nombre.</p>
    <div class="row" style="justify-content:flex-end;gap:8px"><button class="btn ghost" id="dcNo">Cancelar</button><button class="btn primary" id="dcGo">${icon("check")} Confirmar</button></div>`);
  m.querySelector("#dcX").onclick = m.querySelector("#dcNo").onclick = () => m.close();
  m.querySelector("#dcGo").onclick = async e => {
    const go = e.currentTarget;
    if (lost) { body.reason = m.querySelector("#dcWhy").value; if (!body.reason) { m.querySelector("#dcWhy").focus(); return toast("Elegí el motivo de pérdida", { type: "err" }); } }
    go.disabled = true; go.innerHTML = `<span class="spin"></span> Guardando…`;
    try {
      const r = await api(`/api/schools/${encodeURIComponent(s.id)}/deals/${x.id}`, { body });
      if (r.school) patchSchool(r.school);
      m.querySelector(".modal-box").innerHTML = `<div class="modal-h"><h3>${icon("checkCircle")} Listo</h3></div>${writesList(r.done)}<button class="btn primary block" id="dcOk">Listo</button>`;
      m.querySelector("#dcOk").onclick = () => m.close(); m.querySelector("#dcOk").focus();
      S.today = null; S.agenda = null;
      if (D.id === s.id) { HIST.delete(s.id); load({ refresh: true }); }
    } catch (err) { go.disabled = false; go.innerHTML = `${icon("check")} Confirmar`; toast(err.message, { type: "err" }); }
  };
}
export const writesList = done => `<ul class="writes">${done.map(x => `<li${x.warn ? ' class="warn"' : ""}>${icon(x.warn ? "alert" : "check", "sm")}<span>${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.label)}</a>` : esc(x.label)}</span></li>`).join("")}</ul>`;
// Agregar decisor: persona en la organización (o en el prospecto) a tu nombre. En lo de otra persona, no (salvo líder).
export const canAddPerson = s => !!S.me.pdUserId && !(s.ownerId && s.ownerId !== S.me.pdUserId && !leadsOver(s.ownerId));
export function addDecisor(s, d) {
  const where = s.leadOnly ? "en el prospecto" : d.match?.orgId ? `en ${d.match.orgName || "la organización"}` : "en una organización nueva";
  const m = modal(`<div class="modal-h"><h3>${icon("user")} Agregar decisor</h3><button class="icon-btn" id="adX" aria-label="Cerrar">${icon("x")}</button></div>
    <p class="muted" style="margin:-6px 0 0">Se crea en Pipedrive a tu nombre, ${esc(where)}.</p>
    <div class="grid2"><label class="field"><span>Nombre</span><input class="inp" id="adName" placeholder="Ej: Laura Gómez" autocomplete="off" required></label>
      <label class="field"><span>Cargo <span class="faint">opcional</span></span><input class="inp" id="adRole" placeholder="Directora, administrador, concesionario" list="adRoles"></label>
      <label class="field"><span>Teléfono <span class="faint">opcional</span></span><input class="inp" type="tel" id="adPhone" placeholder="${esc(S.markets[s.country]?.prefix ? `+${S.markets[s.country].prefix} …` : "Teléfono")}"></label>
      <label class="field"><span>Mail <span class="faint">opcional</span></span><input class="inp" type="email" id="adMail" placeholder="nombre@colegio.edu"></label></div>
    <datalist id="adRoles"><option>Director/a</option><option>Administrador/a</option><option>Concesionario/a ${esc(delaEsp(d.market))}</option><option>Coordinador/a de servicios</option><option>Dueño/a</option></datalist>
    <div class="row" style="justify-content:flex-end;gap:8px"><button class="btn ghost" id="adNo">Cancelar</button><button class="btn primary" id="adGo">${icon("check")} Guardar en Pipedrive</button></div>`);
  const q = sel => m.querySelector(sel);
  q("#adX").onclick = q("#adNo").onclick = () => m.close();
  setTimeout(() => q("#adName").focus());
  q("#adGo").onclick = async e => {
    const go = e.currentTarget, body = { name: q("#adName").value.trim(), role: q("#adRole").value.trim(), phone: q("#adPhone").value.trim(), email: q("#adMail").value.trim() };
    if (!body.name) { q("#adName").focus(); return toast("Escribí el nombre del decisor", { type: "err" }); }
    go.disabled = true; go.innerHTML = `<span class="spin"></span> Guardando…`;
    try {
      const r = await apiEx(s, `/api/schools/${encodeURIComponent(s.id)}/persons`, { body });
      if (r.school) patchSchool(r.school);
      q(".modal-box").innerHTML = `<div class="modal-h"><h3>${icon("checkCircle")} Decisor agregado</h3></div>${writesList(r.done)}<button class="btn primary block" id="adOk">Listo</button>`;
      q("#adOk").onclick = () => m.close(); q("#adOk").focus();
      if (D.id === s.id) load();
    } catch (err) { go.disabled = false; go.innerHTML = `${icon("check")} Guardar en Pipedrive`; toast(err.message, { type: "err" }); }
  };
}

// ---------- Enriquecer: juntar todo lo que hay del colegio y dejarlo en Pipedrive
export const ENR = new Map();
export async function loadEnrich(id) {
  if (ENR.has(id)) return;
  ENR.set(id, null);
  try { const r = await api(`/api/schools/${encodeURIComponent(id)}/enrich`); ENR.set(id, r.data || null); } catch { ENR.delete(id); return; }
  if (D.id === id && ENR.get(id) && D.tab === "prep") keepScroll(draw);
}
export const enriching = new Set();
export async function enrich(s) {
  if (enriching.has(s.id)) return;
  enriching.add(s.id); D.enriching = s.id; draw();
  try {
    const r = await api(`/api/schools/${encodeURIComponent(s.id)}/enrich`, { body: {} });
    ENR.set(s.id, r.data); SEDES.delete(s.id);
    if (D.id === s.id) D.photos = r.photos || D.photos;
    const n = r.data.nuevos || 0, see = D.id === s.id && D.tab !== "prep" ? { action: { label: "Ver datos", fn: () => goTab("prep") } } : {};
    // campos del prospecto completados (solo los vacíos) y la nota: lo que pasó con cada uno, corto
    const fl = r.fields?.saved?.length ? `Completé en el prospecto: ${r.fields.saved.join(", ")}.` : "", fw = r.fields?.reason || "";
    const nn = `${n} dato${n === 1 ? "" : "s"} nuevo${n === 1 ? "" : "s"}`;
    // todavía no está en Pipedrive: no es un error (se guarda al crear el prospecto) y se dice una sola vez: en «Datos del
    // colegio» si está a la vista (Preparar); si no, en el aviso
    const waits = !r.note.saved && notInPd(r.note.reason), shown = D.id === s.id && D.tab === "prep";
    const msg = r.note.saved ? [`Listo: ${nn} en una nota ${r.note.lead ? "del prospecto" : "de Pipedrive"}.`, fl, fw]
      : waits ? [fl, n ? `Encontré ${nn}.` : "No encontré datos nuevos.", shown ? "" : "Los guardo en Pipedrive cuando crees el prospecto.", fw]
      : [fl, n ? `Encontré ${nn}.` : "", fl && !n ? "No había nada nuevo para una nota." : r.note.reason || "", fw];
    toast(msg.filter(Boolean).join(" "), r.note.saved || fl ? { href: r.note.url || r.fields.url, action: "Abrir" } : { type: n || waits ? "info" : "err", ...see });
    loadSedes(s.id);
  } catch (e) { toast(e.message, { type: "err" }); }
  enriching.delete(s.id); if (D.enriching === s.id) D.enriching = null;
  if (D.id === s.id) keepScroll(draw);
}
// el motivo «todavía no está en Pipedrive» de enrichSchool (lib/sales.js): dato pendiente, no error
const notInPd = t => /^Todavía no está en Pipedrive/.test(String(t || ""));
const KIND_E = { tel: ["phone", "Teléfonos"], wa: ["whatsapp", "WhatsApp"], mail: ["mail", "Mails"], web: ["external", "Web"], addr: ["map", "Dirección"] };
export function enrichSec(s) {
  const e = ENR.get(s.id); if (!e) return "";
  const mx = s.country === "México";
  const row = x => {
    const v = esc(x.value), src = `<span class="tag${x.known ? " faint" : ""}">${esc(x.known ? `ya estaba · ${x.src}` : x.src)}</span>`;
    const dig = x.value.replace(/\D/g, "").length, short = mx ? dig < 10 && !/^\+/.test(x.value) : dig < 8;
    if (x.kind === "tel") return `<div class="sede-row">${short ? `<span class="sede-tel">${v}</span><span class="tag" title="Sin código de área: así no se puede marcar">${mx ? "sin lada" : "sin código de área"}</span>` : `<a class="sede-tel" href="${esc(telLink(x.value))}">${v}</a><button class="linkbtn" data-sdwa="${v}">WhatsApp</button>`}${src}</div>`;
    if (x.kind === "wa") return `<div class="sede-row"><button class="linkbtn" data-sdwa="${v}">${v}</button>${src}</div>`;
    if (x.kind === "mail") return `<div class="sede-row"><button class="linkbtn" data-sdmail="${v}">${v}</button>${src}</div>`;
    if (x.kind === "web") return `<div class="sede-row"><a href="${v}" target="_blank" rel="noopener">${esc(x.value.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, ""))}</a>${src}</div>`;
    return `<div class="sede-row"><a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(x.value)}" target="_blank" rel="noopener">${v}</a>${src}</div>`;
  };
  const groups = Object.entries(KIND_E).map(([k, [ic, label]]) => [label, ic, e.items.filter(x => x.kind === k)]).filter(([, , l]) => l.length);
  const nt = e.note || {}, fecha = esc(new Intl.DateTimeFormat("es", { day: "numeric", month: "numeric" }).format(new Date(e.at)));
  return `<section class="sec" id="enrichSec"><h3><span class="l">${icon("building")} Datos del colegio</span><span class="faint" style="font-size:var(--fs-sm);font-weight:500">Enriquecido el ${fecha} por ${esc(e.by)}</span></h3>
    <p class="faint" style="margin:0 0 10px;font-size:var(--fs-sm)">${nt.saved ? `${icon("check", "sm")} Quedó en una nota ${nt.lead ? "del prospecto" : "de Pipedrive"} · <a href="${esc(nt.url)}" target="_blank" rel="noopener">abrir</a>` : notInPd(nt.reason) ? `${icon("clock", "sm")} ${esc(nt.reason)}${canProspect(s, D.data?.match) ? ` <button class="linkbtn" data-enr-prospect>Crear prospecto</button>` : ""}` : nt.reason ? `${icon("alert", "sm")} ${esc(nt.reason)}` : ""}${e.fields?.saved?.length ? `<br>${icon("check", "sm")} Completé en el prospecto: ${esc(e.fields.saved.join(", "))}` : ""}</p>
    ${groups.length ? `<div class="enr">${groups.map(([label, ic, l]) => `<div class="enr-g"><div class="sub-h">${icon(ic, "sm")} ${esc(label)}</div>${l.map(row).join("")}</div>`).join("")}</div>` : `<p class="muted" style="margin:0">No encontré teléfonos, mails ni web.</p>`}
    ${e.rating ? `<p class="muted" style="margin:8px 0 0">Google Maps: ${esc(String(e.rating.value))}★ · ${esc(String(e.rating.count))} reseñas</p>` : ""}
    ${e.decisores.length ? `<div class="sub-h" style="margin-top:10px">Decisores</div>${e.decisores.map(d => `<div class="sede-row"><b>${esc(d.nombre)}</b>${d.cargo ? `<span class="muted">${esc(d.cargo)}</span>` : ""}</div>`).join("")}` : ""}
    <p class="faint" style="margin:8px 0 0;font-size:var(--fs-sm)">Buscado en: su web (${esc(e.sources.web)}) · Google Maps (${esc(e.sources.google)}) · estudio (${esc(e.sources.estudio)})${e.photos ? ` · ${e.photos} foto${e.photos === 1 ? "" : "s"}` : ""}</p>
  </section>`;
}

// ---------- sedes del colegio (planteles): se piden aparte para no demorar la ficha
export const SEDES = new Map();
export async function loadSedes(id) {
  const c = SEDES.get(id); if (c && (c.loading || Date.now() - c.at < 10 * 60e3)) return;
  SEDES.set(id, { loading: true, at: Date.now() });
  try { SEDES.set(id, { v: await api(`/api/schools/${encodeURIComponent(id)}/sedes`), at: Date.now() }); }
  catch { SEDES.delete(id); return; }
  if (D.id === id && SEDES.get(id)?.v?.sedes?.length) keepScroll(draw);
}
export const sedesOf = id => SEDES.get(id)?.v?.sedes || [];
// una sede es de otra persona si su organización o su prospecto abierto está a nombre de alguien más en Pipedrive
const sedeAjena = z => !!(z.ownerId && z.ownerId !== S.me.pdUserId);
// teléfonos que sirven para llamar (los locales sin lada no)
export const sedeCallable = z => sedeAjena(z) ? [] : z.phones.filter(p => !p.short).map(p => p.n);
export function sedesSec(s) {
  const L = sedesOf(s.id); if (!L.length) return "";
  const link = (u, t) => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(t)}</a>`;
  return `<section class="sec" id="sedes"><h3><span class="l">${icon("building")} ${L.length} sedes</span></h3>
    <div class="sedes">${L.map(z => `<div class="sede${z.here ? " here" : ""}">
      <div class="sede-h"><b>${esc(z.name)}</b>${z.here ? `<span class="tag">esta ficha</span>` : ""}${z.ownerId && z.ownerId !== S.me.pdUserId ? `<span class="tag">de ${esc(z.owner || "otra persona")}</span>` : ""}</div>
      ${sedeAjena(z) ? `<div class="sede-row faint">Es de ${esc(z.owner || "otra persona")} en Pipedrive: hablalo con esa persona antes de contactar.</div>` : ""}
      ${z.phones.map(p => `<div class="sede-row">${p.short || sedeAjena(z) ? `<span class="sede-tel">${icon("phone", "sm")} ${esc(p.n)}</span>${p.short ? `<span class="tag" title="La web lo publica sin código de área">sin lada</span>` : ""}`
        : `<a class="sede-tel" href="${esc(telLink(p.n))}">${icon("phone", "sm")} ${esc(p.n)}</a>${p.lada ? `<span class="tag" title="La web publica ${esc(p.raw)}; la lada ${esc(p.lada)} es la de los otros números de la red">lada de la red</span>` : ""}${p.n.replace(/\D/g, "").length >= 10 ? `<button class="linkbtn" data-sdwa="${esc(p.n)}">WhatsApp</button>` : ""}`}</div>`).join("")}
      ${z.emails.map(e => `<div class="sede-row">${sedeAjena(z) ? `<span>${icon("mail", "sm")} ${esc(e)}</span>` : `<button class="linkbtn" data-sdmail="${esc(e)}">${icon("mail", "sm")} ${esc(e)}</button>`}</div>`).join("")}
      ${z.addr ? `<div class="sede-row"><a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(z.addr)}" target="_blank" rel="noopener">${icon("map", "sm")} ${esc(z.addr)}</a></div>` : ""}
      ${!z.phones.length && !z.emails.length && !z.addr ? `<div class="sede-row faint">Sin teléfono ni dirección cargados.</div>` : ""}
      <div class="sede-f">${[z.url && link(z.url, "Organización en Pipedrive"), ...z.leads.map((l, i) => link(l.url, `Prospecto${z.leads.length > 1 ? ` ${i + 1}` : ""}${l.archived ? " (archivado)" : ""}`)),
        z.schoolId && !z.here ? `<button class="linkbtn" data-sdopen="${esc(z.schoolId)}">Abrir su ficha</button>` : "", `Fuente: ${esc(z.src.join(", "))}`].filter(Boolean).join(" · ")}</div>
    </div>`).join("")}</div>
    ${L.some(z => z.phones.some(p => p.short)) ? `<p class="faint" style="margin:8px 0 0;font-size:var(--fs-sm)">«Sin lada»: la web lo publica sin código de área, así no se puede marcar. Pedilo o buscalo antes de llamar.</p>` : ""}
  </section>`;
}
