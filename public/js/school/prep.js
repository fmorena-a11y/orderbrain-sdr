// Ficha del colegio: Preparar, «Ya hay algo parecido en Pipedrive» y «Es esta» → vincular → fusionar.
import { $, S, addDays, ago, api, cap, copy, esc, icon, loadPref, modal, nextBusinessDay, patchSchool, save, telLink, toast, today } from "../core.js";
import { D, laEsp } from "./state.js";
import { fullAddr, load, openSchool, phoneOnly, plural, webOf } from "./open.js";
import { BASEINFO, STUDY_COST, baseSec, bindGallery, gallery, keepScroll, loadStudy } from "./media.js";
import { HIST, SEDES, enrichSec, historySec, loadHistory, loadSedes, sedesSec, writesList } from "./sections.js";
import { clientWarn, createProspect, draw, ownDeal } from "./render.js";
import { bindTimeline, briefCard, loadTimeline } from "./history.js";
import { templateMenu } from "./messages.js";

// ---------- Preparar
const FIT = { alto: ["new", "Encaje alto"], medio: ["lost", "Encaje medio"], bajo: ["client", "Encaje bajo"] };
const known = v => v && !/^(sin datos|desconocid|no (se )?encontr|n\/a|-)/i.test(String(v).trim());
function studyCard(s) {
  if (D.studyWorking) return `<section class="sec study working" aria-live="polite"><h3><span class="l">${icon("sparkles")} Estudio del colegio</span></h3>
    <div class="study-progress"><span class="spin"></span><div><b>Investigando el colegio en la web…</b><p class="muted">Leo su sitio, redes y noticias para armar el perfil y los decisores. Tarda 1 o 2 minutos; podés ir llamando mientras.</p></div></div></section>`;
  if (D.studyErr) return `<div class="callout warn">${icon("alert")}<span>No se pudo hacer el estudio: ${esc(D.studyErr)}</span><button class="btn sm" id="stRetry">Reintentar</button></div>`;
  const st = D.study;
  if (!st) return D.studyOn && D.study === null ? `<div class="callout">${icon("sparkles")}<span>Estudio del colegio con IA: perfil, decisores y ángulo de venta. Cuesta ${STUDY_COST} y tarda 1 o 2 minutos.</span><button class="btn sm" id="stMake">Hacer estudio</button></div>` : "";
  const pf = st.perfil || {};
  const caf = [st.cafeteria?.modelo !== "desconocido" && st.cafeteria?.modelo, st.cafeteria?.detalle].filter(Boolean).join(" · ");
  const facts = [["Niveles", (pf.niveles || []).join(", ")], ["Alumnos", pf.alumnos], ["Cuota", pf.cuota], ["Segmento", pf.segmento], ["Cafetería", caf], ["Red o congregación", pf.red], ["Idiomas", pf.idiomas], ["Sedes", pf.sedes], ["Antigüedad", pf.antiguedad]].filter(([, v]) => known(v));
  const c = st.contacto || {};
  const [fcls, flbl] = FIT[st.fit] || FIT.medio;
  const nf = st.fuentes?.length || 0;
  return `<section class="sec study" aria-labelledby="stH">
    <h3><span class="l" id="stH">${icon("sparkles")} Estudio del colegio</span><span class="pill ${fcls}" title="${esc(st.fit_razon || "")}">${flbl}</span></h3>
    <p class="lead">${esc(st.resumen)}</p>
    ${facts.length ? `<dl class="facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>` : ""}
    ${st.decisores?.length ? `<div class="sub-h">Decisores</div>${st.decisores.map(x => `<div class="person"><div class="t"><b>${esc(x.nombre)}</b><small>${esc(x.cargo)}${x.fuente ? ` · ${/^https?:/.test(x.fuente) ? `<a href="${esc(x.fuente)}" target="_blank" rel="noopener">fuente</a>` : esc(x.fuente)}` : ""}</small></div></div>`).join("")}` : ""}
    ${(c.telefonos?.length || c.emails?.length || c.redes?.length || c.whatsapp || c.direccion || c.web) ? `<div class="sub-h">Contacto</div>
      ${c.direccion ? `<div class="copy-row"><span class="k">Dirección</span><span class="v">${esc(c.direccion)}</span><button class="btn sm" data-copy="${esc(fullAddr(c.direccion, s))}" aria-label="Copiar la dirección">${icon("copy", "sm")} Copiar</button></div>` : ""}
      <div class="chips">
      ${(w => w ? `<a class="chip" href="${esc(w)}" target="_blank" rel="noopener" title="${esc(w)}">${icon("globe", "sm")} <span>${esc(w.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/$/, ""))}</span></a>` : "")(c.web ? (/^https?:\/\//i.test(c.web) ? c.web : "https://" + c.web) : webOf(s))}
      ${(c.telefonos || []).map(t => { const n = phoneOnly(t), note = n ? String(t).replace(n, "").replace(/^[\s,;·-]*\(?|\)?\s*$/g, "").trim() : ""; return `<a class="chip${note ? " has-note" : ""}" href="${esc(telLink(n || t))}" title="${esc(t)}">${icon("phone", "sm")} <span>${esc(n || t)}${note ? `<small>${esc(note)}</small>` : ""}</span></a>`; }).join("")}
      ${[c.whatsapp, ...(c.telefonos || [])].filter(Boolean).slice(0, 1).map(t => `<button class="chip" data-stwa="${esc(t)}">${icon("whatsapp", "sm")} WhatsApp</button>`).join("")}
      ${(c.emails || []).map(m => { const e = (String(m).match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/) || [""])[0], note = e ? String(m).replace(e, "").replace(/^[\s,;·-]*\(?|\)?\s*$/g, "").trim() : ""; return `<button class="chip${note ? " has-note" : ""}" data-stmail="${esc(e || m)}" title="${esc(m)}">${icon("mail", "sm")} <span>${esc(e || m)}${note ? `<small>${esc(note)}</small>` : ""}</span></button>`; }).join("")}
      ${(c.redes || []).filter(u => /^https?:\/\//.test(u)).map(u => `<a class="chip" href="${esc(u)}" target="_blank" rel="noopener">${icon("external", "sm")} ${esc(u.replace(/^https?:\/\/(www\.)?/, "").split("/")[0])}</a>`).join("")}</div>` : ""}
    ${(st.senales?.length || st.riesgos?.length) ? `<div class="two-col">
      ${st.senales?.length ? `<div><div class="sub-h">Señales de oportunidad</div><ul class="ticks ok">${st.senales.map(x => `<li>${icon("check", "sm")}<span>${esc(x)}</span></li>`).join("")}</ul></div>` : ""}
      ${st.riesgos?.length ? `<div><div class="sub-h">A tener en cuenta</div><ul class="ticks warn">${st.riesgos.map(x => `<li>${icon("alert", "sm")}<span>${esc(x)}</span></li>`).join("")}</ul></div>` : ""}</div>` : ""}
    <div class="study-foot">
      ${nf ? `<details><summary>${nf} fuente${nf === 1 ? "" : "s"}</summary><ul>${st.fuentes.map(f => `<li><a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.titulo || f.url)}</a></li>`).join("")}</ul></details>` : "<span></span>"}
      <span class="actions"><span class="faint">Actualizado ${esc(ago(st.at))}</span><button class="btn sm ghost" id="stNote">${icon("note", "sm")} Guardar en Pipedrive</button><button class="btn sm ghost icon-only" id="stRefresh" aria-label="Volver a investigar" title="Volver a investigar">${icon("refresh", "sm")}</button></span>
    </div>
  </section>`;
}
export function prepBody(s, d) {
  const p = d.playbook, b = D.study || null, m = d.match;
  const me = (S.me.name || "").split(/[\s.@_]/)[0];
  const apertura = (b?.apertura || p.apertura).replace(/\[tu nombre\]/g, me);
  const preguntas = b?.preguntas?.length ? b.preguntas : p.preguntas, objeciones = b?.objeciones?.length ? b.objeciones : p.objeciones;
  const nd = nextBusinessDay(today());
  const dia = nd === addDays(today(), 1) ? "mañana" : `el ${new Intl.DateTimeFormat("es", { weekday: "long", day: "numeric" }).format(new Date(nd + "T12:00:00"))}`;
  const cierre = p.cierre.replace(/el \[día\]|\[día\]/, dia).replace("[hora]", "10:00");
  const angulo = b?.angulo || s.pitch;
  const decisor = b?.decisores?.[0];
  const warn = clientWarn(s, m), own = ownDeal(s, m);
  // trato abierto tuyo: la situación no manda a coordinar con nadie (propio, de lib/playbook.js)
  const sit = own && p.propio ? p.propio : p;
  const cands = !m.confirmed ? (m.candidates || []) : [];
  // con historia, la apertura sale del resumen (arriba); en frío, la de siempre
  const tb = D.tl?.id === s.id ? D.tl.brief || D.tl.summary : null, fromHist = !!tb && !tb.cold;
  const fromStudy = x => (x ? ` <span class="tag" title="Las armó el estudio para este colegio">de este colegio</span>` : "");
  return `<div class="stack">
    ${warn ? `<div class="callout ${own ? "info" : "warn"}">${icon(own ? "deal" : "alert")}<span>${esc(warn)}</span></div>` : ""}
    ${pdLine(s, m)}
    ${existingSec(s, m)}
    ${baseSec(s)}
    ${briefCard(s, "prep")}
    ${historySec(s)}
    ${s.lat == null && !(D.photos || []).length ? "" : gallery(s)}
    ${enrichSec(s)}
    ${sedesSec(s)}
    ${fromHist ? "" : `<section class="sec"><h3><span class="l">${icon("phone")} Primeros 15 segundos</span></h3>
      <div class="say">${esc(apertura)}<button class="icon-btn" data-copy="${esc(apertura)}" aria-label="Copiar apertura">${icon("copy")}</button></div>
      <p class="muted" style="margin:10px 0 0;font-size:var(--fs-md)">${d.askFor ? `Preguntá por <b>${esc(d.askFor.name)}</b>${d.askFor.role ? ` (${esc(d.askFor.role)})` : ""}. <span class="faint">Lo dijeron en recepción ${esc(ago(d.askFor.at))}.</span>` : decisor ? `Preguntá por <b>${esc(decisor.nombre)}</b>${decisor.cargo ? ` (${esc(decisor.cargo)})` : ""}.` : `Si atiende recepción, pedí el nombre de quien maneja ${esc(laEsp(d.market))} y su mejor horario.`}</p>
    </section>`}
    <section class="sec"><h3><span class="l">${icon("target")} Situación</span></h3>
      <p style="margin:0">${esc(sit.situacion)} <b>${esc(sit.objetivo)}</b></p>
      ${angulo ? `<div class="callout ok" style="margin-top:10px">${icon("bolt")}<span><b>Ángulo:</b> ${esc(angulo)}</span></div>` : ""}
    </section>
    ${cands.length ? `<section class="sec" id="candSec"><h3><span class="l">${icon("building")} ¿Es alguna de estas organizaciones de Pipedrive?</span></h3>${m.orgId ? `<p class="muted" style="margin:0 0 6px">Ahora está vinculado a <b>${esc(m.orgName)}</b>.</p>` : ""}${cands.map(c => candRow(c, d.cands?.[c.id])).join("")}${m.orgId ? `<div class="cand"><span class="muted">Ninguna de estas</span><button class="btn sm ghost" id="unlink">Desvincular</button></div>` : ""}</section>` : ""}
    ${!cands.length && !s.virtual && m.confirmed && !m.auto && m.dupeCount > 0 ? `<section class="sec"><div class="cand"><span class="cand-b"><b>${icon("merge", "sm")} Parece cargada ${m.dupeCount === 1 ? "1 vez más" : `${m.dupeCount} veces más`} en Pipedrive</b><small>Además de «${esc(m.orgName)}». Podés revisarlas y fusionarlas.</small></span><button class="btn sm" id="dupReview">Revisar</button></div></section>` : ""}
    ${foldSec("preguntas", "list", `Preguntas para calificar${fromStudy(b?.preguntas?.length)}`, preguntas.length, `<ol class="qnum">${preguntas.map(q => `<li>${esc(q)}</li>`).join("")}</ol>`)}
    ${foldSec("objeciones", "alert", `Si te dice…${fromStudy(b?.objeciones?.length)}`, objeciones.length, objeciones.map((o, i) => `<details class="obj" ${i === 0 ? "open" : ""}><summary>${esc(o.o)}</summary><p>${esc(o.r)}</p></details>`).join(""))}
    ${foldSec("cierre", "video", "Cierre", "", `<div class="say">${esc(cierre)}<button class="icon-btn" data-copy="${esc(cierre)}" aria-label="Copiar cierre">${icon("copy")}</button></div>`)}
    ${s.lat == null ? "" : studyCard(s)}
  </div>`;
}
// Preguntas, «Si te dice…» y Cierre son casi iguales en todos los colegios: van plegados y cada uno se acuerda de cómo lo
// dejaste (localStorage ob.prep.fold), para que arriba se vea lo que cambia: resumen, apertura y datos.
const FOLD_KEY = "prep.fold";
const foldOpen = k => !!(loadPref(FOLD_KEY, {}) || {})[k];
const foldSec = (k, ic, title, n, body) => `<details class="sec fold" data-fold="${k}" ${foldOpen(k) ? "open" : ""}><summary><h3><span class="l">${icon(ic)} ${title}</span><span class="fold-n">${n ? `<span class="n">${n}</span>` : ""}${icon("chevDown", "sm")}</span></h3></summary><div class="fold-b">${body}</div></details>`;
export function bindPrep(s, d) {
  const el = $("drawer");
  bindGallery(s);
  bindTimeline(s);
  el.querySelectorAll("details[data-fold]").forEach(x => x.addEventListener("toggle", () => { const v = loadPref(FOLD_KEY, {}) || {}; if (!!v[x.dataset.fold] !== x.open) save(FOLD_KEY, { ...v, [x.dataset.fold]: x.open }); }));
  el.querySelector("[data-enr-prospect]")?.addEventListener("click", () => createProspect(s));
  // el estudio usa IA paga: siempre se confirma el costo antes
  const makeStudy = async refresh => { if (await confirmCost(refresh)) loadStudy(s.id, { refresh, make: true }); };
  el.querySelector("#stMake")?.addEventListener("click", () => makeStudy(false));
  el.querySelector("#stRefresh")?.addEventListener("click", () => makeStudy(true));
  el.querySelector("#stRetry")?.addEventListener("click", () => makeStudy(false));
  el.querySelector("#stNote")?.addEventListener("click", async e => {
    const b = e.currentTarget; b.disabled = true;
    try { const r = await apiEx(s, `/api/schools/${s.id}/study/note`, { body: {} }); toast("Estudio guardado como nota en Pipedrive", { href: r.orgUrl, action: "Abrir" }); }
    catch (err) { toast(err.message, { type: "err" }); }
    b.disabled = false;
  });
  el.querySelectorAll("[data-stwa]").forEach(b => b.onclick = () => templateMenu(b, s, d, "whatsapp", { phone: b.dataset.stwa }));
  el.querySelectorAll("[data-sdwa]").forEach(b => b.onclick = () => templateMenu(b, s, d, "whatsapp", { phone: b.dataset.sdwa }));
  el.querySelectorAll("[data-bwa]").forEach(b => b.onclick = () => templateMenu(b, s, d, "whatsapp", { phone: b.dataset.bwa }));
  el.querySelectorAll("[data-bmail]").forEach(b => b.onclick = () => templateMenu(b, s, d, "mail", { email: b.dataset.bmail }));
  el.querySelectorAll("[data-bpick]").forEach(b => b.onclick = () => {
    const [k, i] = b.dataset.bpick.split(":").map(Number), c = BASEINFO.get(s.id)?.[k]?.contacts?.[i]; if (!c) return;
    D.form.contact = { name: c.name || "", role: c.role || "", phone: c.phone || "", email: c.email || "" }; D.form.fromBase = true;
    toast(`${c.name || "Ese contacto"} queda para Registrar: se crea como persona en Pipedrive al guardar`, { type: "info" }); keepScroll(draw);
  });
  el.querySelectorAll("[data-sdmail]").forEach(b => b.onclick = () => templateMenu(b, s, d, "mail", { email: b.dataset.sdmail }));
  el.querySelectorAll("[data-sdopen]").forEach(b => b.onclick = () => openSchool(b.dataset.sdopen));
  el.querySelectorAll("[data-stmail]").forEach(b => b.onclick = () => templateMenu(b, s, d, "mail", { email: b.dataset.stmail }));
  el.querySelectorAll("[data-copy]").forEach(b => b.onclick = () => copy(b.dataset.copy));
  el.querySelectorAll("[data-org]").forEach(b => b.onclick = () => confirmOrg(s, +b.dataset.org, b.dataset.name, b));
  el.querySelectorAll("[data-exkey]").forEach(b => b.onclick = () => chooseExisting(s, { key: b.dataset.exkey }, b));
  el.querySelectorAll("[data-extake]").forEach(b => b.onclick = () => takeExisting(s, b.dataset.extake, b.dataset.owner, b));
  el.querySelector("#exNone")?.addEventListener("click", e => chooseExisting(s, { none: true }, e.currentTarget));
  el.querySelector("#unlink")?.addEventListener("click", () => { D.data = null; draw(); load({ match: { orgId: null } }); });
  el.querySelector("#dupReview")?.addEventListener("click", e => reviewDupes(s, e.currentTarget));
}

// ---------- ¿ya está en Pipedrive? Antes de crear algo, el servidor busca prospectos (también sin organización), tratos y
// organizaciones por nombre, ciudad, teléfono, mail y web (sales.settleExisting). Si hay algo parecido, 409 pd_maybe con las
// candidatas: se pregunta «¿es alguno de estos?» y, con la respuesta, se vuelve a pedir lo mismo.
const exOwner = c => c.ownerId && c.ownerId === S.me.pdUserId ? "tuyo" : c.ownerId ? `de ${c.owner || "otra persona"}` : "libre";
function exRow(c) {
  const sub = [c.what, exOwner(c), c.place || "sin ciudad en Pipedrive", c.phone].filter(Boolean).join(" · ");
  return `<div class="cand"><span class="cand-b"><span>${esc(c.title)}</span><small>${esc(sub)}</small>${c.why ? `<small class="cand-why">${esc(cap(c.why))}</small>` : ""}</span>
    <span class="cand-a"><a class="icon-btn" href="${esc(c.url)}" target="_blank" rel="noopener" title="Ver en Pipedrive" aria-label="Ver «${esc(c.title)}» en Pipedrive">${icon("external")}</a>${theirsLead(c) ? `<button class="btn sm" data-extake="${esc(c.key)}" data-owner="${esc(c.owner || "otra persona")}" title="Pasa a tu nombre en Pipedrive, con una nota">Ya hablé con ${esc(firstName(c.owner))}: pasámelo</button>` : ""}<button class="btn sm" data-exkey="${esc(c.key)}">Es este</button></span></div>`;
}
const theirsLead = c => c.kind === "lead" && c.ownerId && c.ownerId !== S.me.pdUserId;
const firstName = n => String(n || "esa persona").replace(/\s*\(.*\)$/, "").split(" ")[0] || "esa persona";
// Antes de gastar IA: confirma el costo
function confirmCost(again) {
  return new Promise(resolve => {
    let ok = false;
    const m = modal(`<h3>${again ? "¿Volver a investigar?" : "¿Hacer el estudio?"}</h3>
      <p style="margin:0">Usa IA paga: cuesta ${STUDY_COST} por colegio. Hay un tope de gasto por día para todo el equipo.</p>
      <div class="row"><button class="btn ghost" id="ccNo">Cancelar</button><button class="btn primary" id="ccGo">Sí, hacerlo</button></div>`, { onClose: () => resolve(ok) });
    m.querySelector("#ccNo").onclick = () => m.close();
    m.querySelector("#ccGo").onclick = () => { ok = true; m.close(); };
  });
}
// «Ya hablé con X: pasámelo»: confirma y pasa el prospecto de otra persona a tu nombre (con una nota en Pipedrive)
function confirmTake(owner, msg = "") {
  return new Promise(resolve => {
    let ok = false;
    const m = modal(`<h3>¿Lo pasás a tu nombre?</h3>
      ${msg ? `<p class="muted" style="margin:0">${esc(msg)}</p>` : ""}
      <p style="margin:0">El prospecto es de <b>${esc(owner || "otra persona")}</b>. Si ya lo hablaste, pasa a tu nombre en Pipedrive y queda una nota que lo dice.</p>
      <div class="row"><button class="btn ghost" id="tkNo">No, lo dejo</button><button class="btn primary" id="tkGo">Ya lo hablé: pasámelo</button></div>`, { onClose: () => resolve(ok) });
    m.querySelector("#tkNo").onclick = () => m.close();
    m.querySelector("#tkGo").onclick = () => { ok = true; m.close(); };
  });
}
async function takeExisting(s, key, owner, btn, msg = "") {
  if (!(await confirmTake(owner, msg))) return false;
  return chooseExisting(s, { key, take: true }, btn);
}
// «Es este» o «Es otro colegio» (desde la ficha o desde la pregunta): queda en el cruce y la ficha se actualiza
async function chooseExisting(s, choice, btn) {
  if (btn) { btn.disabled = true; btn.innerHTML = `<span class="spin"></span>`; }
  try {
    const r = await api(`/api/schools/${encodeURIComponent(s.id)}/existing`, { body: choice });
    if (r.detail) { patchSchool(r.detail.school); if (D.id === s.id) { D.data = r.detail; draw(); } }
    S.today = null;
    toast(choice.none ? "Listo: lo próximo que registres crea el prospecto de este colegio" : (r.done || []).map(x => x.label).join(" · ") || "Listo: queda vinculado");
    return true;
  } catch (e) {
    if (e.code === "pd_theirs" && e.data?.take && !choice.take) { if (D.id === s.id) draw(); return takeExisting(s, e.data.take.key, e.data.take.owner, null, e.message); }
    toast(e.message, { type: "err", ms: 9000 }); if (D.id === s.id) draw(); return false;
  }
}
export function askPdExisting(s, cands) {
  return new Promise(resolve => {
    let out = false;
    const m = modal(`<div class="modal-h"><h3>${icon("search")} Ya hay algo parecido en Pipedrive</h3><button class="icon-btn" id="pdxX" aria-label="Cerrar">${icon("x")}</button></div>
      <p class="muted" style="margin:-6px 0 0">¿Es alguno de estos? Así no se carga dos veces el mismo colegio.</p>
      <div class="cmp-h" style="margin-top:4px">${icon("map", "sm")} ${esc(s.name)}${s.city ? ` · ${esc(s.city)}` : ""}</div>
      <div id="pdxList">${cands.map(exRow).join("")}</div>
      <div class="row"><button class="btn ghost" id="pdxNo">Cancelar</button><button class="btn" id="pdxNew">${icon("plus")} Es otro colegio, crear prospecto nuevo</button></div>`, { onClose: () => resolve(out) });
    const q = sel => m.querySelector(sel);
    q(".modal-box").classList.add("mid", "pdx");
    q("#pdxX").onclick = q("#pdxNo").onclick = () => m.close();
    const pick = async (choice, b) => { m.locked = true; const ok = await chooseExisting(s, choice, b); m.locked = false; if (ok) { out = true; m.close(); } else if (b) { b.disabled = false; b.textContent = choice.none ? "Es otro colegio, crear prospecto nuevo" : "Es este"; } };
    m.querySelectorAll("[data-exkey]").forEach(b => b.onclick = () => pick({ key: b.dataset.exkey }, b));
    m.querySelectorAll("[data-extake]").forEach(b => b.onclick = async () => { m.locked = true; const ok = await takeExisting(s, b.dataset.extake, b.dataset.owner, b); m.locked = false; if (ok) { out = true; m.close(); } });
    q("#pdxNew").onclick = e => pick({ none: true }, e.currentTarget);
  });
}
export async function apiEx(s, path, opts) {
  for (let i = 0; ; i++) {
    try { return await api(path, opts); }
    catch (e) {
      // de otra persona: «Ya hablé con X: pasámelo» y se vuelve a pedir lo mismo
      if (e.code === "pd_theirs" && e.data?.take && i < 2) { if (await takeExisting(s, e.data.take.key, e.data.take.owner, null, e.message)) continue; throw e; }
      if (e.code !== "pd_maybe" || !e.data?.candidates?.length || i >= 2) throw e;
      if (!(await askPdExisting(s, e.data.candidates))) throw new Error("No guardé nada: primero decí si es alguno de esos o si es otro colegio.");
    }
  }
}
// En la ficha: lo dudoso que encontró la última búsqueda (con «Es este» y «Es otro colegio»)
function existingSec(s, m) {
  const l = !s.virtual && !s.leadOnly && !m?.orgId && m?.pdx?.maybe?.length ? m.pdx.maybe : [];
  if (!l.length) return "";
  return `<section class="sec" id="exSec"><h3><span class="l">${icon("search")} Ya hay algo parecido en Pipedrive</span></h3>
    <p class="muted" style="margin:0 0 6px">¿Es alguno de estos? Si no lo decís, te lo pregunto al registrar.</p>${l.map(exRow).join("")}
    <div class="cand"><span class="muted">Ninguno es este colegio</span><button class="btn sm ghost" id="exNone">Es otro colegio</button></div></section>`;
}
// «Nunca contactado» con una búsqueda real detrás: lo dice (y los prospectos archivados, como dato)
function pdChecked(s, m) {
  const x = m?.pdx;
  if (s.virtual || s.leadOnly || !x?.at || m.orgId || s.status !== "new" || x.maybe?.length) return "";
  const info = (x.info || []).map(c => `<a href="${esc(c.url)}" target="_blank" rel="noopener">«${esc(c.title)}»</a> (${esc(c.what)}, ${esc(exOwner(c))})`).join(", ");
  // con organizaciones parecidas sin elegir (las muestra la ficha aparte), no se dice que no hay organización
  const what = (m.candidates || []).length ? "prospecto ni trato" : "prospecto, organización ni trato";
  return `Revisé en Pipedrive ${esc(ago(x.at))}: no hay ${what} con este nombre${x.phone ? " ni este teléfono" : ""}.${info ? ` Solo ${info}.` : ""}`;
}
// El estado de Pipedrive de un colegio sin historia, en UNA línea (antes eran dos o tres avisos apilados: el verde «Revisé en
// Pipedrive…», el azul «Todavía no está vinculado…» o «Primer contacto en frío»): qué se revisó, si falta elegir la
// organización (con «Elegir») y si es un primer contacto en frío.
function pdLine(s, m) {
  const t = D.tl?.id === s.id ? D.tl : null, b = t ? t.brief || t.summary : null;
  const chk = pdChecked(s, m), unlinked = !!(b?.cold && b.unlinked), cold = !!(b?.cold && !b.unlinked && !b.origin);
  if (!chk && !unlinked && !cold) return "";
  const n = (m?.candidates || []).length;
  const rest = unlinked ? `<b>Todavía no está vinculado${n ? `: hay ${n} ${n === 1 ? "organización parecida" : "organizaciones parecidas"}` : " a Pipedrive"}.</b>`
    : cold ? `<b>Primer contacto en frío:</b> ${chk ? "usá" : "no hay llamadas, mensajes ni notas en Pipedrive ni en la app. Usá"} la apertura de abajo.` : "";
  return `<div class="pd-line${unlinked ? " ask" : ""}" role="status">${icon(unlinked ? "building" : chk ? "checkCircle" : "phone", "sm")}<span>${[chk, rest].filter(Boolean).join(" ")}</span>${unlinked ? `<button class="btn sm" data-cbcands title="Elegí cuál es para ver su historia antes de llamar">Elegir</button>` : ""}</div>`;
}

// ---------- «Es esta» → ¿Estás seguro? (comparar) → vincular → ¿Querés fusionar? (otras organizaciones del mismo colegio)
const DEAL_ST = { open: "abierto", won: "ganado", lost: "perdido" };
const placeOf = o => [o.city, o.region, o.country].filter(Boolean).join(", ");
const ownerOf = o => o.owner || (o.ownerId ? "otra persona" : "libre (cuenta general)");
const callout = (level, text) => `<div class="callout ${level}">${icon("alert")}<span>${esc(text)}</span></div>`;
// una candidata de la lista: ciudad y dueño en Pipedrive (con cuatro «Colegio Valladolid», es lo que las distingue)
function candRow(c, x) {
  const mine = x?.ownerId && x.ownerId === S.me.pdUserId;
  const sub = x ? [x.place || "sin ciudad en Pipedrive", mine ? "tuya" : x.ownerId ? `de ${x.owner || "otra persona"}` : "libre", `id ${c.id}`].join(" · ") : `id ${c.id}`;
  const flag = x?.linked ? `Ya está vinculada a ${x.linked}` : x?.other ? "Es de otra ciudad" : "";
  return `<div class="cand"><span class="cand-b"><span>${esc(c.name)}</span><small>${esc(sub)}</small>${flag ? `<small class="cand-flag">${icon("alert", "sm")}<span>${esc(flag)}</span></small>` : ""}</span><button class="btn sm" data-org="${c.id}" data-name="${esc(c.name)}">Es esta</button></div>`;
}
// los tratos, prospectos y actividades de una organización, uno por línea
const dealLine = x => [x.title, x.pipeline, x.stage, DEAL_ST[x.status] || x.status, x.owner && `de ${x.owner}`].filter(Boolean).join(" · ");
const actLine = x => [x.subject, x.due && fmtDay(x.due), x.owner && `de ${x.owner}`].filter(Boolean).join(" · ");
const fmtDay = v => new Intl.DateTimeFormat("es", { day: "numeric", month: "short" }).format(new Date(v + "T12:00:00"));
const listOr = (l, line, none) => l?.length ? `<ul>${l.slice(0, 5).map(x => `<li>${esc(line(x))}</li>`).join("")}${l.length > 5 ? `<li class="faint">y ${l.length - 5} más</li>` : ""}</ul>` : `<span class="faint">${none}</span>`;
const personsTxt = o => o.persons == null ? "no pude verlas" : o.personsMore ? "20 o más" : String(o.persons);
function orgFacts(o) {
  return `<dl class="kv"><dt>Nombre</dt><dd><b>${esc(o.name)}</b>${o.client ? ` <span class="tag">Cliente</span>` : ""} <span class="faint">id ${o.id}</span></dd>
    <dt>Ciudad</dt><dd>${placeOf(o) ? esc(placeOf(o)) : `<span class="faint">sin ciudad en Pipedrive</span>`}</dd>
    ${o.addr ? `<dt>Dirección</dt><dd>${esc(o.addr)}</dd>` : ""}
    <dt>Dueño</dt><dd>${esc(ownerOf(o))}</dd>
    <dt>Tratos</dt><dd>${listOr(o.deals, dealLine, "ninguno")}</dd>
    <dt>Prospectos</dt><dd>${o.leads == null ? `<span class="faint">no pude verlos</span>` : listOr(o.leads, x => [x.title, x.owner && `de ${x.owner}`].filter(Boolean).join(" · "), "ninguno abierto")}</dd>
    <dt>Pendientes</dt><dd>${o.acts == null ? `<span class="faint">no pude verlas</span>` : listOr(o.acts, actLine, "ninguna")}</dd>
    <dt>Personas</dt><dd>${esc(personsTxt(o))}</dd></dl>`;
}
// después de vincular: lo que se vio de la ficha depende de la organización, se vuelve a pedir (como en load)
function afterLink(s, d) {
  HIST.delete(s.id); SEDES.delete(s.id); S.today = null; S.agenda = null;
  if (D.id === s.id) { D.data = d; patchSchool(d.school); draw(); loadSedes(s.id); loadHistory(s.id, d); loadTimeline(s.id); }
}
// por qué no se ofrece fusionar (dupesFor sin duplicadas)
const noDupesMsg = (name, r) => r.stop ? `Vinculado a «${name}». ${r.stop}.` : `Vinculado a «${name}»`;
function confirmOrg(s, orgId, orgName, anchor) {
  const m = modal(`<div class="modal-h"><h3>${icon("building")} ¿Estás seguro?</h3><button class="icon-btn" id="coX" aria-label="Cerrar">${icon("x")}</button></div>
    <p class="muted" style="margin:-6px 0 0">Compará antes de vincular el colegio con esta organización de Pipedrive.</p>
    <div id="coWarn" aria-live="polite"></div>
    <div class="cmp">
      <div class="cmp-col"><div class="cmp-h">${icon("map", "sm")} En la base</div><dl class="kv"><dt>Nombre</dt><dd><b>${esc(s.name)}</b></dd>
        <dt>Ciudad</dt><dd>${esc([s.city, s.country].filter(Boolean).join(", ")) || `<span class="faint">sin ciudad</span>`}</dd>${s.addr ? `<dt>Dirección</dt><dd>${esc(s.addr)}</dd>` : ""}</dl></div>
      <div class="cmp-col"><div class="cmp-h">${icon("building", "sm")} En Pipedrive</div><div id="coOrg" aria-live="polite"><p class="muted" style="margin:0"><span class="spin"></span> Trayendo ${esc(orgName)}…</p></div></div>
    </div>
    <div class="row"><button class="btn ghost" id="coNo">Cancelar</button><button class="btn primary" id="coGo" disabled>${icon("check")} Sí, es esta</button></div>`, { onClose: () => anchor?.isConnected && anchor.focus() });
  const q = sel => m.querySelector(sel), url = `/api/schools/${encodeURIComponent(s.id)}`;
  q(".modal-box").classList.add("mid");
  q("#coX").onclick = q("#coNo").onclick = () => m.close();
  api(`${url}/org/${orgId}`).then(r => {
    q("#coOrg").innerHTML = `${orgFacts(r.org)}<a class="btn sm ghost" href="${esc(r.org.url)}" target="_blank" rel="noopener">${icon("external", "sm")} Abrir en Pipedrive</a>`;
    // primero lo que dice que no es esta (rojo), después lo que conviene revisar (ámbar)
    q("#coWarn").innerHTML = (r.warnings || []).map(w => callout(w.level === "err" ? "err" : "warn", w.text)).join("");
    orgName = r.org.name || orgName;
  }).catch(e => { q("#coOrg").innerHTML = callout("err", `No pude traer lo que dice Pipedrive: ${e.message}`); })
    .finally(() => { if (m.isConnected) q("#coGo").disabled = false; });
  q("#coGo").onclick = async e => {
    const go = e.currentTarget; go.disabled = true; go.innerHTML = `<span class="spin"></span> Vinculando…`;
    // mientras vincula y busca duplicadas, no se cierra (Esc o tocar afuera lo cerraban sin avisar el resultado)
    m.locked = true; q("#coX").disabled = q("#coNo").disabled = true;
    let d;
    try { d = await api(`${url}/match`, { body: { orgId, orgName } }); }
    catch (err) { m.locked = false; q("#coX").disabled = q("#coNo").disabled = false; go.disabled = false; go.innerHTML = `${icon("check")} Sí, es esta`; return toast(err.message, { type: "err" }); }
    afterLink(s, d);
    q(".modal-box").innerHTML = `<div class="modal-h"><h3>${icon("checkCircle")} Vinculado a ${esc(orgName)}</h3></div><p class="muted" style="margin:0"><span class="spin"></span> Buscando si está cargada más de una vez…</p>`;
    let r;
    try { r = await api(`${url}/dupes`); }
    catch (err) { m.close(); return toast(`Vinculado a «${orgName}». No pude buscar duplicadas: ${err.message}`, { type: "info", ms: 8000 }); }
    seenDupes(s, r);
    if (!r.dupes?.length) { m.close(); return toast(noDupesMsg(orgName, r), r.stop ? { type: "info", ms: 9000 } : {}); }
    m.locked = false;
    mergeStep(s, m, r, { linked: true });
  };
}
// lo que encontró /dupes también lo guarda el servidor (dupeCount): la ficha de atrás muestra «Parece cargada N veces más»
function seenDupes(s, r) {
  const n = r.stop ? 0 : r.dupes?.length || 0;
  if (D.id === s.id && D.data?.match && (D.data.match.dupeCount || 0) !== n) { D.data.match.dupeCount = n; keepScroll(draw); }
}
// «Revisar» desde la ficha (Parece cargada N veces más): la misma pregunta, sin volver a vincular
async function reviewDupes(s, anchor) {
  const m = modal(`<div class="modal-h"><h3>${icon("merge")} Buscando duplicadas…</h3></div><p class="muted" style="margin:0"><span class="spin"></span> Buscando si está cargada más de una vez…</p>`, { locked: true, onClose: () => anchor?.isConnected && anchor.focus() });
  m.querySelector(".modal-box").classList.add("mid");
  let r;
  try { r = await api(`/api/schools/${encodeURIComponent(s.id)}/dupes`); }
  catch (err) { m.close(); return toast(`No pude buscar duplicadas: ${err.message}`, { type: "err" }); }
  seenDupes(s, r);
  if (!r.dupes?.length) { m.close(); return toast(r.stop ? `${r.stop}.` : "Ya no hay otras organizaciones para fusionar", { type: "info", ms: r.stop ? 9000 : 4200 }); }
  m.locked = false;
  mergeStep(s, m, r, { linked: false });
}
// qué dice cada organización en «¿Querés fusionar?»: ciudad, dueño, tratos, prospectos, pendientes, personas e id
const orgSub = o => [placeOf(o) || "sin ciudad en Pipedrive", o.owner ? `de ${o.owner}` : o.ownerId ? "de otra persona" : "libre",
  o.deals.length ? plural(o.deals.length, "trato", "tratos") + ` (${[...new Set(o.deals.map(x => DEAL_ST[x.status] || x.status))].join(", ")})` : "sin tratos",
  o.leads == null ? "" : o.leads.length ? plural(o.leads.length, "prospecto", "prospectos") : "",
  o.acts?.length ? plural(o.acts.length, "pendiente", "pendientes") : "",
  o.persons == null ? "" : !o.persons ? "sin personas" : plural(o.personsMore ? 20 : o.persons, "persona", "personas") + (o.personsMore ? " o más" : ""), `id ${o.id}`].filter(Boolean).join(" · ");
// «También hay «Instituto Valladolid Primaria» en Morelia y «Colegio Valladolid» en Aguascalientes, Mexicali y 6 más»
const joinY = l => l.length > 1 ? `${l.slice(0, -1).join(", ")} y ${l.at(-1)}` : l[0] || "";
const citiesTxt = c => c.length > 3 ? `${c.slice(0, 2).join(", ")} y ${c.length - 2} más` : joinY(c);
function elsewhereTxt(o) {
  const g = o.elsewhereAt || [];
  if (!g.length) return o.elsewhere ? `hay ${plural(o.elsewhere, "colegio", "colegios")} con este nombre en otras ciudades` : "";
  const parts = g.slice(0, 3).map(x => `«${x.name}» en ${x.cities.length ? citiesTxt(x.cities) : "otra ciudad"}`);
  const rest = g.slice(3).reduce((n, x) => n + Math.max(1, x.cities.length), 0);
  return `también hay ${joinY(rest ? [...parts, `${plural(rest, "colegio", "colegios")} más`] : parts)}`;
}
// lo bloqueado: qué hacer (un cliente ya dice que lo fusiona un líder; si no se pudo leer, probar después)
const blockHint = b => /líder/.test(b) ? "" : /^No pude/.test(b) ? ": probá de nuevo en un rato" : ": avisale a esa persona o a un líder";
function mergeStep(s, m, r, { linked = true } = {}) {
  const q = sel => m.querySelector(sel), k = r.keep;
  q(".modal-box").classList.add("mid");
  q(".modal-box").innerHTML = `<div class="modal-h"><h3>${icon("merge")} ¿Querés fusionar?</h3><button class="icon-btn" id="mgX" aria-label="Cerrar">${icon("x")}</button></div>
    <p class="muted" style="margin:-6px 0 0">${linked ? "Quedó vinculado. " : ""}${r.dupes.length === 1 ? "Esta organización parece el mismo colegio" : "Estas organizaciones parecen el mismo colegio"}. Las que marques pasan a la que queda.</p>
    <div class="dup keep"><span class="dup-b"><span class="dup-k">Queda</span><b>${esc(k.name)}</b>${k.client ? ` <span class="tag">Cliente</span>` : ""}<small>${esc(orgSub(k))}</small></span>
      <a class="icon-btn" href="${esc(k.url)}" target="_blank" rel="noopener" aria-label="Abrir ${esc(k.name)} en Pipedrive" title="Abrir en Pipedrive">${icon("external")}</a></div>
    <div class="dups" role="group" aria-label="Organizaciones para fusionar">${r.dupes.map(o => `<div class="dup${o.block ? " off" : ""}"><label><input type="checkbox" data-mid="${o.id}" ${o.block ? "disabled" : o.sameCity ? "checked" : ""}>
      <span class="dup-b"><b>${esc(o.name)}</b>${o.client ? ` <span class="tag">Cliente</span>` : ""}<small>${esc(orgSub(o))}</small>
      ${o.block ? `<small class="dup-lock">${icon("lock", "sm")}<span>${esc(o.block + blockHint(o.block))}</span></small>` : !o.sameCity ? `<small class="dup-why">${icon("alert", "sm")}<span>${esc(`No dice la ciudad${o.elsewhere ? ` y ${elsewhereTxt(o)}` : ""}: fijate que sea este.`)}</span></small>` : ""}</span></label>
      <a class="icon-btn" href="${esc(o.url)}" target="_blank" rel="noopener" aria-label="Abrir ${esc(o.name)} en Pipedrive" title="Abrir en Pipedrive">${icon("external")}</a></div>`).join("")}</div>
    ${callout("warn", `Las marcadas se borran de Pipedrive y todo (tratos, prospectos, personas, notas y actividades) pasa a «${k.name}» (id ${k.id}). No se puede deshacer.`)}
    ${r.keepBlock ? callout("err", `«${k.name}»: ${r.keepBlock}. Avisale a esa persona o a un líder.`) : r.dupes.some(o => o.client) ? `<div class="callout info">${icon("alert")}<span>Hay un cliente: revisá que sea la misma sede antes de fusionar.</span></div>` : ""}
    <div class="row"><button class="btn ghost" id="mgNo">No fusionar</button><button class="btn primary" id="mgGo">${icon("merge")} Fusionar</button></div>`;
  const boxes = [...m.querySelectorAll("[data-mid]")], go = q("#mgGo");
  const check = () => { go.disabled = !!r.keepBlock || !boxes.some(b => b.checked); };
  boxes.forEach(b => b.onchange = check); check();
  // sin fusionar: la ficha sigue mostrando «Parece cargada N veces más · Revisar»
  q("#mgX").onclick = q("#mgNo").onclick = () => { m.close(); toast(`${linked ? `Vinculado a «${k.name}». ` : ""}Podés fusionar después desde la ficha.`, { type: "info" }); };
  (boxes.find(b => !b.disabled) || q("#mgNo")).focus();
  go.onclick = async () => {
    const mergeIds = boxes.filter(b => b.checked).map(b => +b.dataset.mid);
    go.disabled = true; go.innerHTML = `<span class="spin"></span> Fusionando…`; boxes.forEach(b => b.disabled = true);
    // mientras fusiona, no se cierra: la fusión sigue igual en Pipedrive y no se vería el resultado
    m.locked = true; q("#mgX").disabled = q("#mgNo").disabled = true;
    try {
      const x = await api(`/api/schools/${encodeURIComponent(s.id)}/merge-orgs`, { body: { keepId: k.id, mergeIds } });
      if (x.school) patchSchool(x.school);
      m.locked = false;
      if (m.isConnected) {
        q(".modal-box").innerHTML = `<div class="modal-h"><h3>${icon("checkCircle")} ${x.done.some(y => y.warn) ? "Fusionado en parte" : "Listo"}</h3></div>${writesList(x.done)}<button class="btn primary block" id="mgOk">Listo</button>`;
        q("#mgOk").onclick = () => m.close(); q("#mgOk").focus();
      } else toast(`Listo: ${x.done[0]?.label || "fusionado"}`, { type: x.done.some(y => y.warn) ? "info" : "", ms: 9000 });
      HIST.delete(s.id); SEDES.delete(s.id); S.today = null; S.agenda = null;
      if (D.id === s.id) load({ refresh: true });
    } catch (err) {
      m.locked = false; q("#mgX").disabled = q("#mgNo").disabled = false;
      toast(err.message, { type: "err" });
      boxes.forEach((b, i) => b.disabled = !!r.dupes[i].block); go.innerHTML = `${icon("merge")} Fusionar`; check();
    }
  };
}
