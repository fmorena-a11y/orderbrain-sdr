// Ficha del colegio: contactos de la base cargada, estudio con IA y fotos.
import { $, S, api, esc, icon, modal, satLink, satTile, telLink } from "../core.js";
import { D } from "./state.js";
import { draw } from "./render.js";

// ---------- de una base cargada (Cargar base, lib/bases.js): los contactos de la planilla del evento. El primero (quien decide)
// queda elegido para Registrar: al guardar el primer contacto se crea como persona en Pipedrive (se puede cambiar o quitar).
export const BASEINFO = new Map();
export async function loadBaseInfo(id) {
  let r;
  try { r = await api(`/api/schools/${encodeURIComponent(id)}/base`); } catch { return; }
  BASEINFO.set(id, r.bases || []); if (BASEINFO.size > 60) BASEINFO.delete(BASEINFO.keys().next().value);
  if (D.id !== id || !r.bases?.length) return;
  const f = D.form, c = r.bases[0].contacts?.[0];
  if (c && !f.outcome && !f.contact.name && !f.contact.phone && !f.contact.email) { f.contact = { name: c.name || "", role: c.role || "", phone: c.phone || "", email: c.email || "" }; f.fromBase = true; }
  keepScroll(draw);
}
const sameContact = (a, b) => !!a && !!b && (a.name || "") === (b.name || "") && (a.phone || "") === (b.phone || "") && (a.email || "") === (b.email || "");
export function baseSec(s) {
  const L = BASEINFO.get(s.id) || []; if (!L.length) return "";
  return L.map((x, k) => `<section class="sec bx-base"><h3><span class="l">${icon("table")} De la base «${esc(x.base.event)}»</span></h3>
    <p class="muted" style="margin:0 0 8px;font-size:var(--fs-md)">${esc([x.students, x.typeText, `${x.count || x.contacts.length} ${x.count === 1 ? "inscripto" : "inscriptos"}`, x.contacted === true ? "ya figura contactado en la planilla" : ""].filter(Boolean).join(" · "))}</p>
    ${x.out ? `<div class="callout warn" style="margin-bottom:8px">${icon("alert")}<span>${esc(x.out)}: en la planilla figura así.</span></div>` : ""}
    <div class="bx-cs" style="padding-left:0">${x.contacts.map((c, i) => `<div class="bx-c${sameContact(D.form?.contact, c) ? " picked" : ""}"><span class="t"><b>${esc(c.name || "Sin nombre")}</b>${c.role ? ` <span class="faint">${esc(c.role)}</span>` : ""}${c.decisor ? ` <span class="tag">decide</span>` : ""}</span>
      <span class="bx-cl">${c.phone ? `<a href="${esc(telLink(c.phone))}">${icon("phone", "sm")} ${esc(c.phone)}</a><button class="linkbtn" data-bwa="${esc(c.phone)}">${icon("whatsapp", "sm")} WhatsApp</button>` : ""}${c.email ? `<button class="linkbtn" data-bmail="${esc(c.email)}">${icon("mail", "sm")} ${esc(c.email)}</button>` : ""}
      <button class="linkbtn" data-bpick="${k}:${i}">${sameContact(D.form?.contact, c) ? "Elegido para Registrar" : "Usar al registrar"}</button></span></div>`).join("") || `<span class="faint">Sin contactos en la planilla.</span>`}</div>
    ${x.notes ? `<p class="bx-note" style="padding-left:0;margin-top:8px"><b>Notas:</b> ${esc(x.notes)}</p>` : ""}${x.next ? `<p class="bx-note" style="padding-left:0"><b>Próximo paso:</b> ${esc(x.next)}</p>` : ""}
  </section>`).join("");
}
// Estudio: al abrir la ficha solo se lee el que ya existe. Hacerlo (o rehacerlo) usa IA paga: solo con make, después de que
// la persona confirmó el costo (botón «Hacer estudio con IA»).
export const STUDY_COST = "entre US$0,50 y US$1";
export async function loadStudy(id, { refresh = false, make = false } = {}) {
  const redraw = () => { if (D.id === id && D.tab === "prep" && D.data) keepScroll(draw); };
  try {
    if (!make) {
      const r = await api(`/api/schools/${id}/study`);
      if (D.id !== id) return;
      D.studyOn = !!r.enabled;
      D.study = r.study || null; return redraw();
    }
    D.studyWorking = true; D.studyErr = null; redraw();
    let st = null;
    try { st = (await api(`/api/schools/${id}/study`, { body: { refresh, confirm: true } })).study; }
    catch (e) {
      if (e?.code === "ai_budget" || e?.code === "ai_confirm") throw e;
      // si otra persona lo está generando, esperar a que aparezca
      for (let i = 0; i < 24 && !st && D.id === id; i++) { await new Promise(r => setTimeout(r, 8000)); st = (await api(`/api/schools/${id}/study`).catch(() => ({}))).study; }
      if (!st) throw e;
    }
    if (D.id !== id) return;
    D.study = st; D.studyWorking = false; redraw();
  } catch (e) { if (D.id !== id) return; D.studyWorking = false; D.studyErr = e.message; redraw(); }
}
// Redibuja sin perder el scroll (en celular scrollea toda la ficha; en escritorio, el cuerpo).
export function keepScroll(fn) { const dr = $("drawer"), b = dr.querySelector("#dBody"); const t1 = dr.scrollTop, t2 = b?.scrollTop || 0; fn(); dr.scrollTop = t1; const nb = dr.querySelector("#dBody"); if (nb) nb.scrollTop = t2; }
export async function loadPhotos(id) {
  let list = [];
  try { list = (await api(`/api/schools/${id}/photos`)).photos || []; } catch {}
  if (D.id !== id) return;
  D.photos = list;
  const g = $("drawer").querySelector("#gallery");
  if (g) { g.outerHTML = gallery(S.byId.get(id)); bindGallery(S.byId.get(id)); }
}
// Fotos: las de Google y la web primero, y siempre la vista satelital al final.
function photoList(s) {
  const seen = new Set((D.photos || []).map(p => p.url));
  const fromStudy = (D.study?.imagenes || []).filter(x => !seen.has(x.url)).map(x => ({ url: x.url, kind: "study", credit: x.descripcion || "Encontrada en la web" }));
  return [...(D.photos || []), ...fromStudy, ...(s.lat == null ? [] : [{ url: satLink(s), kind: "sat", credit: "Vista satelital · Esri, Maxar, Earthstar Geographics" }])];
}
const KIND = { google: "Google Maps", web: "Web del colegio", study: "Web", sat: "Satélite" };
export function gallery(s) {
  const list = photoList(s);
  return `<div class="gallery" id="gallery" aria-label="Fotos del colegio">${list.map((p, i) => `<button class="ph ${p.kind}" data-ph="${i}" aria-label="Ver foto ${i + 1} (${KIND[p.kind]})"><img src="${esc(p.kind === "sat" ? satLink(s, { w: 480, h: 300 }) : p.url)}" alt="" loading="lazy" referrerpolicy="no-referrer">${p.kind === "sat" ? `<span class="sat-pin" title="El colegio está acá"></span>` : ""}<span class="cap">${esc(KIND[p.kind])}</span></button>`).join("")}${D.photos === null ? `<div class="ph skel" aria-hidden="true"></div>` : ""}</div>`;
}
export function bindGallery(s) {
  const g = $("drawer").querySelector("#gallery"); if (!g) return;
  // la satelital nunca se borra: prueba un tamaño menor y la tesela; si todo falla, queda el botón para abrirla
  g.querySelectorAll("img").forEach(img => {
    const sat = img.closest(".ph.sat"), alt = sat ? [satLink(s, { w: 320, h: 200 }), satTile(s)] : [];
    img.addEventListener("error", () => {
      // la tesela no está centrada en el colegio: ahí no va el punto
      if (alt.length) { img.src = alt.shift(); if (!/\/export\?/.test(img.src)) sat?.querySelector(".sat-pin")?.remove(); return; }
      if (sat) return void img.replaceWith(Object.assign(document.createElement("span"), { className: "ph-fail", innerHTML: `${icon("map")}<span>Ver satélite</span>` }));
      img.closest(".ph")?.remove();
    });
  });
  g.querySelectorAll("[data-ph]").forEach(b => b.onclick = () => lightbox(s, +b.dataset.ph));
}
function lightbox(s, start) {
  const list = photoList(s); let i = start;
  const m = modal(`<div class="lb"><div class="lb-wrap"><img id="lbImg" alt="Foto del colegio" referrerpolicy="no-referrer"><span class="sat-pin lg" id="lbPin" hidden title="El colegio está acá"></span></div><div class="lb-fail" id="lbFail" hidden>${icon("alert")}<span>No se pudo cargar esta foto. Abrila con el botón de abajo.</span></div><div class="lb-bar"><span id="lbCap" class="faint"></span><span class="lb-nav"><a class="btn sm" id="lbExt" target="_blank" rel="noopener">${icon("external", "sm")} <span>Abrir</span></a>${list.length > 1 ? `<button class="icon-btn" id="lbPrev" aria-label="Anterior">${icon("arrowLeft")}</button><button class="icon-btn" id="lbNext" aria-label="Siguiente">${icon("arrowRight")}</button>` : ""}<button class="icon-btn" id="lbClose" aria-label="Cerrar">${icon("x")}</button></span></div></div>`, { onClose: () => $("drawer").querySelector(`[data-ph="${i}"]`)?.focus() });
  m.querySelector(".modal-box").classList.add("wide");
  // La foto grande nunca queda rota: si una versión falla (el servicio satelital a veces devuelve error en ciertos
  // tamaños), prueba la siguiente; al final queda la misma de la miniatura o un aviso con el enlace para abrirla afuera.
  const img = m.querySelector("#lbImg"), fail = m.querySelector("#lbFail"), ext = m.querySelector("#lbExt"), pin = m.querySelector("#lbPin");
  let tries = [], seq = 0;
  const show = () => {
    const p = list[i], my = ++seq;
    tries = p.kind === "sat" ? [satLink(s, { w: 1200, h: 750 }), satLink(s, { w: 1024, h: 640 }), satLink(s, { w: 800, h: 480 }), satLink(s, { w: 480, h: 300 }), satTile(s)] : [p.url];
    fail.hidden = true; img.hidden = false; img.classList.add("loading"); pin.hidden = true;
    // el punto rojo marca el colegio: la foto satelital está centrada en su ubicación (salvo la tesela de respaldo)
    img.onload = () => { if (my === seq) { img.classList.remove("loading"); pin.hidden = !(p.kind === "sat" && /\/export\?/.test(img.src)); } };
    img.onerror = () => {
      if (my !== seq) return;
      if (tries.length) { img.src = tries.shift(); return; }
      img.hidden = true; fail.hidden = false;
    };
    img.src = tries.shift();
    ext.href = p.kind === "sat" ? `https://www.google.com/maps/@${s.lat},${s.lng},180m/data=!3m1!1e3` : p.url;
    ext.querySelector("span").textContent = p.kind === "sat" ? "Abrir en Google Maps" : "Abrir la foto";
    m.querySelector("#lbCap").textContent = `${i + 1} de ${list.length} · ${p.kind === "sat" ? "El punto rojo es el colegio · " : ""}${p.credit || KIND[p.kind]}`;
  };
  const go = d => { i = (i + d + list.length) % list.length; show(); };
  m.querySelector("#lbPrev")?.addEventListener("click", () => go(-1));
  m.querySelector("#lbNext")?.addEventListener("click", () => go(1));
  m.querySelector("#lbClose").onclick = () => m.close();
  m.addEventListener("keydown", e => { if (e.key === "ArrowLeft") go(-1); if (e.key === "ArrowRight") go(1); });
  // deslizar para pasar de foto en el celular
  let x0 = null;
  img.addEventListener("pointerdown", e => (x0 = e.clientX));
  img.addEventListener("pointerup", e => { if (x0 === null) return; const dx = e.clientX - x0; x0 = null; if (dx > 40) go(-1); else if (dx < -40) go(1); });
  show();
}
