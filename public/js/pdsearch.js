// Búsqueda en toda la base de Pipedrive (Prospectar y la búsqueda rápida): /api/pd-search con espera (≈350 ms) y
// cancelación, las filas de cada resultado («Ver más» por grupo, con el cursor de Pipedrive) y la ficha a la que lleva:
// organización o prospecto → el colegio de la base si su organización está cruzada, si no la ficha de Pipedrive; persona →
// su ficha (teléfonos, emails, tratos, actividades, notas y el botón a la de su organización). Todo lo de Pipedrive se escapa.
import { S, api, esc, norm, icon, modal, toast, localAct, shortDay, telLink, waLink, digits, statusPill, copy, ago, today } from "./core.js";
import { openSchool, openRecord } from "./school.js";

export const PD_MIN = 3;
const WAIT = 350, TTL = 60e3;
const ICON = { person: "user", organization: "building", lead: "lead", deal: "deal" };
const KIND = { person: "Persona", organization: "Organización", lead: "Prospecto", deal: "Trato" };
// un teléfono o un email no son lugares: Prospectar no los ubica en el mapa
export const isPhoneQ = q => /^\+?[\d\s\-().\/]+$/.test(String(q || "").trim()) && digits(q).length >= 6;
export const isMailQ = q => /\S@\S/.test(String(q || ""));

// Buscador con espera y cancelación. run(q, cb): cb(null) si es muy corto; si no cb({ q, state: "loading" }) enseguida y
// después cb({ q, state: "ok", data }) o cb({ q, state: "err", err }). Lo que llega tarde (ya escribiste otra cosa) se descarta.
// done: la promesa de la última búsqueda (Prospectar la espera antes de decidir qué hace Enter).
export function pdSearcher() {
  let timer = null, ctrl = null, seq = 0, done = Promise.resolve(null), cur = null;
  const cache = new Map();
  return {
    run(raw, cb) {
      const q = String(raw || "").replace(/\s+/g, " ").trim();
      if (cur?.q === q && cur.state === "loading") return cb(cur); // lo mismo que ya se está buscando: no se corta ni se repite
      clearTimeout(timer); ctrl?.abort(); const my = ++seq;
      const report = st => { cur = st; cb(st); return st; };
      if (q.length < PD_MIN) { done = Promise.resolve(null); return report(null); }
      const hit = cache.get(q.toLowerCase());
      if (hit && Date.now() - hit.at < TTL) { done = Promise.resolve(report({ q, state: "ok", data: hit.data })); return; }
      report({ q, state: "loading" });
      done = new Promise(resolve => {
        timer = setTimeout(async () => {
          const c = ctrl = new AbortController();
          try {
            const data = await api(`/api/pd-search?q=${encodeURIComponent(q)}`, { signal: c.signal });
            cache.set(q.toLowerCase(), { at: Date.now(), data }); if (cache.size > 60) cache.delete(cache.keys().next().value);
            if (my !== seq) return resolve(null);
            resolve(report({ q, state: "ok", data }));
          } catch (e) {
            if (my !== seq || e.name === "AbortError") return resolve(null);
            resolve(report({ q, state: "err", err: e.message }));
          }
        }, WAIT);
      });
    },
    cancel() { clearTimeout(timer); ctrl?.abort(); seq++; cur = null; done = Promise.resolve(null); },
    get done() { return done; },
  };
}

// ---------- filas
export const pdFlat = data => (data?.groups || []).flatMap(g => g.items);
export const pdTitle = it => it.name || it.title || KIND[it.type];
const schoolOf = to => to?.kind === "school" ? S.byId.get(to.id) || null : null;
const join = a => a.filter(Boolean).join(" · ");
const owner = it => it.owner ? `Dueño: ${it.owner}` : "Sin dueño";
// dónde está una organización: su dirección (si no es solo un teléfono) y la ciudad y el país, sin repetir la ciudad
function orgWhere(it) {
  const s = schoolOf(it.to), place = it.place || (s ? [s.city, s.country].filter(Boolean).join(", ") : ""), city = norm(place.split(",")[0]);
  return it.addr ? (city && norm(it.addr).includes(city) ? it.addr : join([it.addr, place])) : place;
}
// Dos renglones: qué es y cómo se contacta (teléfonos, emails, organización, embudo…) y de quién es (cada uno trabaja lo
// suyo: el dueño va siempre en su renglón, que no se corta).
export function pdLines(it) {
  if (it.type === "person") return [join([(it.phones || []).join(", "), (it.emails || []).join(", ")]) || "Sin teléfono ni email", join([owner(it), it.org?.name || "Sin organización"])];
  if (it.type === "organization") return [orgWhere(it) || "Sin dirección ni ciudad en Pipedrive", owner(it)];
  if (it.type === "lead") return [join([it.org?.name || it.person?.name || "", (it.phones || [])[0]]), owner(it)];
  if (it.type === "deal") return [join([[it.pipeline, it.stage].filter(Boolean).join(" › "), it.org?.name || it.person?.name || ""]), owner(it)];
  return [];
}
export const pdSub = it => join(pdLines(it));
export const pdLinesHtml = it => pdLines(it).filter(Boolean).map((l, i) => `<small class="${i ? "pd-who" : "pd-what"}">${esc(l)}</small>`).join("");
// a la derecha: el estado del colegio cruzado (lo mismo que en la lista), si el prospecto está archivado o cómo va el trato
export function pdBadge(it) {
  const s = schoolOf(it.to);
  if (it.type === "organization" && s) return statusPill(s);
  if (it.type === "lead") return it.archived ? `<span class="tag">Archivado</span>` : `<span class="stage-tag lead">Prospecto</span>`;
  if (it.type === "deal" && it.status) return it.status === "Abierto" ? `<span class="stage-tag deal">Abierto</span>` : `<span class="tag">${esc(it.status)}</span>`;
  return "";
}
// ¿hay en Pipedrive algo que se llama así? Una persona con esas palabras en el nombre, o una organización, prospecto o
// trato cuyo nombre empieza con lo escrito. No cuenta si solo aparece al final («Nook Junior School Metepec» no hace de
// «Metepec» un nombre: Enter lo ubica en el mapa) ni en la dirección o las notas.
export function pdNameHit(it, q) { const t = norm(q), n = norm(pdTitle(it)); return !!t && (it.type === "person" ? ` ${n}`.includes(` ${t}`) : n.startsWith(t)); }
export const pdNamed = (data, q) => pdFlat(data).some(it => pdNameHit(it, q));
// adónde lleva, dicho corto (para el título del botón)
const goesTo = it => { const t = it.to; if (!t) return "Solo está en Pipedrive"; if (t.kind === "school") return `Abre la ficha de ${schoolOf(t)?.name || "su colegio"}`; if (t.kind === "person") return "Abre la ficha de la persona"; return t.ref.startsWith("lead:") ? "Abre la ficha del prospecto" : "Abre la ficha de la organización"; };
const extLink = (it, cls = "pd-ext") => `<a class="${cls}" href="${esc(it.url)}" target="_blank" rel="noopener" title="Abrir en Pipedrive" aria-label="Abrir «${esc(pdTitle(it))}» en Pipedrive">${icon("external", "sm")}<span class="lbl">Pipedrive</span></a>`;
// Una fila de Prospectar: el resultado abre su ficha en la app y, al lado, «Abrir en Pipedrive». k: «grupo:fila».
export function pdRow(it, k) {
  return `<div class="pd-row"><button class="school-row" data-pdi="${k}" data-type="${esc(it.type)}" title="${esc(goesTo(it))}"><span class="pd-ic" aria-hidden="true">${icon(ICON[it.type] || "search", "sm")}</span><span class="t"><b>${esc(pdTitle(it))}</b>${pdLinesHtml(it)}${it.hint ? `<small class="pd-hint">Coincide en: ${esc(it.hint)}</small>` : ""}</span>${pdBadge(it)}</button>${extLink(it)}</div>`;
}
// cuántos: «56», o «50 o más» si Pipedrive tiene más de los que trajo
export const pdCount = (n, more, short = false) => `${n.toLocaleString("es-MX")}${more ? short ? "+" : " o más" : ""}`;
export const PD_SHOW = 10, PD_STEP = 25;
const shownOf = g => Math.min(g.items.length, g.shown || PD_SHOW);
// La sección «En Pipedrive» de Prospectar. st: el estado del buscador (null: no se busca).
export function pdSectionHtml(st) {
  if (!st) return "";
  const head = (n, more) => `<div class="list-h pd-h"><span>${icon("search", "sm")} En Pipedrive${n != null ? ` · ${n === 0 ? "nada" : `${pdCount(n, more)} resultado${n === 1 && !more ? "" : "s"}`}` : ""}</span><span class="faint">personas, organizaciones, prospectos y tratos</span></div>`;
  if (st.state === "loading") return head() + `<p class="muted pd-msg"><span class="spin"></span> Buscando en Pipedrive…</p>`;
  if (st.state === "err") return head() + `<div class="callout warn pd-msg">${icon("alert")}<span>No pude buscar en Pipedrive (${esc(String(st.err).replace(/^Pipedrive:\s*/, ""))}). Lo de arriba sale de los colegios de la app y sigue al día.</span><button class="btn sm" data-pd-retry>Reintentar</button></div>`;
  const d = st.data || {}, items = pdFlat(d);
  if (!items.length) return head(0) + `<p class="muted pd-msg">Tampoco hay personas, organizaciones, prospectos ni tratos con «${esc(st.q)}» en Pipedrive.</p>`;
  return head(items.length, d.more) + (d.partial ? `<p class="faint pd-msg">Puede faltar algo: una de las búsquedas de Pipedrive no respondió.</p>` : "")
    + d.groups.map((g, gi) => {
      const n = shownOf(g), hidden = g.items.length - n;
      const more = g.loading ? `<p class="muted pd-more"><span class="spin"></span> Trayendo más de Pipedrive…</p>`
        : hidden > 0 ? `<button class="btn ghost sm block pd-more-btn" data-pd-more="${gi}">Ver ${Math.min(PD_STEP, hidden)} más</button>`
        : g.more ? `<button class="btn ghost sm block pd-more-btn" data-pd-more="${gi}">Ver más ${esc(g.label.toLowerCase())} de Pipedrive</button>` : "";
      return `<div class="pd-gh" id="pdg-${esc(g.type)}">${esc(g.label)} <b>${pdCount(g.items.length, g.more, true)}</b></div>` + g.items.slice(0, n).map((it, i) => pdRow(it, `${gi}:${i}`)).join("")
        + (g.err ? `<p class="callout warn pd-msg">${icon("alert")}<span>No pude traer más (${esc(g.err)}).</span></p>` : "") + more;
    }).join("");
}
// «Ver más» de un grupo: primero los que ya llegaron; después, la página siguiente de Pipedrive (cursor). Sin repetidos.
async function pdMore(st, g, redraw) {
  const n = shownOf(g);
  if (g.items.length > n) { g.shown = n + PD_STEP; return redraw(); }
  if (!g.more || g.loading) return;
  g.loading = true; g.err = ""; redraw();
  try {
    const r = await api(`/api/pd-search?q=${encodeURIComponent(st.q)}&type=${encodeURIComponent(g.type)}&cursor=${encodeURIComponent(g.next || "")}&term=${encodeURIComponent(st.data.term || "")}`);
    const seen = new Set(g.items.map(x => String(x.id)));
    g.items.push(...(r.items || []).filter(x => !seen.has(String(x.id))));
    g.next = r.next || null; g.more = !!r.more; g.shown = n + PD_STEP;
    st.data.total = pdFlat(st.data).length; st.data.more = st.data.groups.some(x => x.more);
  } catch (e) { g.err = e.message; }
  g.loading = false; redraw();
}
// Engancha los clics de la sección (onRetry: volver a buscar; redraw: volver a dibujar la sección)
export function bindPd(root, st, onRetry, redraw) {
  const groups = st?.data?.groups || [];
  root.querySelectorAll("[data-pdi]").forEach(b => b.onclick = () => { const [gi, i] = b.dataset.pdi.split(":").map(Number); openPd(groups[gi]?.items[i]); });
  root.querySelectorAll("[data-pd-more]").forEach(b => b.onclick = () => { const g = groups[+b.dataset.pdMore]; if (g) pdMore(st, g, redraw || (() => {})); });
  root.querySelector("[data-pd-retry]")?.addEventListener("click", onRetry);
}

// ---------- abrir
export function openTo(to, url) {
  if (!to) { window.open(url, "_blank", "noopener"); return; }
  if (to.kind === "school") return S.byId.has(to.id) ? openSchool(to.id) : openRecord(`org:${to.orgId}`);
  if (to.kind === "record") return openRecord(to.ref);
  if (to.kind === "person") return openPerson(to.id);
}
export const openPd = it => it && openTo(it.to, it.url);

// Ficha de una persona de Pipedrive (la que se buscó): sus teléfonos y emails, su organización (botón a su ficha), tratos,
// prospectos, actividades y notas. Para corroborar sin entrar a Pipedrive.
export async function openPerson(id) {
  const m = modal(`<div class="modal-h"><h3>${icon("user")} Persona de Pipedrive</h3><button class="icon-btn" data-x aria-label="Cerrar">${icon("x")}</button></div><p class="muted"><span class="spin"></span> Trayendo sus datos de Pipedrive…</p>`);
  m.querySelector(".modal-box").classList.add("mid");
  m.querySelector("[data-x]").onclick = () => m.close();
  let p;
  try { p = await api(`/api/pd-person/${encodeURIComponent(id)}`); }
  catch (e) { if (!m.isConnected) return; m.close(); return toast(e.message, { type: "err" }); }
  if (!m.isConnected) return;
  const wa = ph => /^(\+|00)/.test(ph.trim()) || digits(ph).length > 10;
  const lbl = { work: "trabajo", mobile: "celular", home: "casa", other: "otro" };
  const line = (main, extra = "") => `<div class="pp-line">${main}${extra}</div>`;
  const day = d => d ? shortDay(d) + (d.slice(0, 4) !== today().slice(0, 4) ? ` ${d.slice(0, 4)}` : "") : ""; // con el año si no es este
  const act = a => { const l = localAct(a); return `<li><span class="pp-ic" aria-hidden="true">${icon({ call: "phone", meeting: "video", deadline: "whatsapp", task: "mail", contacto_decisor: "user" }[a.type] || "calendar", "sm")}</span><span class="t"><b>${esc(a.subject || a.typeLabel)}</b><small>${esc(join([a.typeLabel, l.date ? day(l.date) + (l.time ? ` ${l.time}` : "") : "", a.owner]))}</small>${a.note ? `<small class="pp-note">${esc(a.note)}</small>` : ""}</span></li>`; };
  const sec = (h, body) => body ? `<section class="pp-sec"><h4>${h}</h4>${body}</section>` : "";
  // tratos: embudo y etapa; cómo terminó (fecha y motivo, sin cortar); dueño. Prospectos: si está archivado y el dueño.
  const rowBtn = (x, i, kind) => `<div class="pd-row"><button class="school-row" data-pp="${kind}:${i}" ${x.to ? `title="${x.to.kind === "school" ? "Abre la ficha del colegio" : kind === "lead" ? "Abre la ficha del prospecto" : "Abre la ficha de su organización"}"` : "disabled"}><span class="pd-ic" aria-hidden="true">${icon(kind, "sm")}</span><span class="t"><b>${esc(x.title)}</b>${(kind === "deal" ? [[x.pipeline, x.stage].filter(Boolean).join(" › "), join([x.status ? `${x.status}${x.closed ? ` ${day(x.closed)}` : ""}` : "", x.reason ? `«${x.reason}»` : ""]), x.owner ? `Dueño: ${x.owner}` : ""]
      : [join([x.archived ? "Archivado" : "Abierto", x.owner ? `Dueño: ${x.owner}` : ""])]).filter(Boolean).map(l => `<small class="pd-what">${esc(l)}</small>`).join("")}</span>${x.to ? icon("arrowRight", "faint") : ""}</button><a class="pd-ext" href="${esc(x.url)}" target="_blank" rel="noopener" aria-label="Abrir «${esc(x.title)}» en Pipedrive" title="Abrir en Pipedrive">${icon("external", "sm")}<span class="lbl">Pipedrive</span></a></div>`;
  m.querySelector(".modal-box").innerHTML = `<div class="modal-h"><h3>${icon("user")} ${esc(p.name)}</h3><button class="icon-btn" data-x aria-label="Cerrar">${icon("x")}</button></div>
    <p class="muted" style="margin:-6px 0 0">${esc(join(["Persona en Pipedrive", p.org ? `de ${p.org.name || "una organización"}` : "sin organización", p.owner ? `Dueño: ${p.owner}` : ""]))}</p>
    ${p.missing?.length ? `<div class="callout warn">${icon("alert")}<span>No pude leer ${esc(p.missing.join(", "))} de Pipedrive. Lo demás está al día.</span></div>` : ""}
    ${sec("Teléfonos", p.phones.map((ph, i) => line(`<span class="v">${esc(ph.value)}</span>${ph.label ? `<span class="faint">${esc(lbl[ph.label] || ph.label)}</span>` : ""}`,
      `<span class="pp-act"><a class="btn sm" href="${esc(telLink(ph.value))}">${icon("phone", "sm")} Llamar</a>${wa(ph.value) ? `<a class="btn sm" href="${esc(waLink(ph.value))}" target="_blank" rel="noopener">${icon("whatsapp", "sm")} WhatsApp</a>` : ""}<button class="icon-btn sm" data-copy="ph:${i}" aria-label="Copiar ${esc(ph.value)}">${icon("copy", "sm")}</button></span>`)).join(""))}
    ${sec("Emails", p.emails.map((em, i) => line(`<a class="v" href="mailto:${esc(em.value)}">${esc(em.value)}</a>`, `<span class="pp-act"><button class="icon-btn sm" data-copy="em:${i}" aria-label="Copiar ${esc(em.value)}">${icon("copy", "sm")}</button></span>`)).join(""))}
    ${p.org ? `<button class="btn" data-org>${icon("building", "sm")} Abrir la ficha de ${esc(p.org.name || "su organización")}</button>` : ""}
    ${sec("Prospectos", p.leads.map((l, i) => rowBtn(l, i, "lead")).join(""))}
    ${sec("Tratos", p.deals.map((d, i) => rowBtn(d, i, "deal")).join(""))}
    ${sec(`Actividades pendientes <b>${p.pending.length}</b>`, p.pending.length ? `<ul class="pp-acts">${p.pending.map(act).join("")}</ul>` : "")}
    ${sec("Hechas, lo último", p.done.length ? `<ul class="pp-acts">${p.done.map(act).join("")}</ul>` : "")}
    ${sec("Notas", p.notes.map(n => `<div class="pp-notep"><small class="faint">${esc(join([n.by, n.at ? ago(n.at) : ""]))}</small><p>${esc(n.text)}</p></div>`).join(""))}
    ${!p.phones.length && !p.emails.length && !p.leads.length && !p.deals.length && !p.pending.length && !p.done.length && !p.notes.length ? `<p class="muted">No tiene teléfonos, emails, tratos, prospectos, actividades ni notas en Pipedrive.</p>` : ""}
    <div class="row"><a class="btn" href="${esc(p.url)}" target="_blank" rel="noopener">${icon("external", "sm")} Abrir en Pipedrive</a><button class="btn primary" data-x2>Cerrar</button></div>`;
  const box = m.querySelector(".modal-box");
  box.querySelector("[data-x]").onclick = box.querySelector("[data-x2]").onclick = () => m.close();
  box.querySelectorAll("[data-copy]").forEach(b => b.onclick = () => { const [k, i] = b.dataset.copy.split(":"); copy((k === "ph" ? p.phones : p.emails)[+i].value); });
  box.querySelector("[data-org]")?.addEventListener("click", () => { m.close(); openTo(p.org.to); });
  box.querySelectorAll("[data-pp]").forEach(b => b.onclick = () => { const [k, i] = b.dataset.pp.split(":"), x = (k === "lead" ? p.leads : p.deals)[+i]; if (!x?.to) return; m.close(); openTo(x.to, x.url); });
  box.querySelector("[data-x]").focus();
}
