// «Hoy» del líder (pedido del líder de SDR: «a los líderes hacerles su propia interfaz para lo que les interesa a ellos, que sea
// multitenant y que cada uno entre con su mail»). Lo abre today.js cuando homeMode() es "lead". Para mirar a la mañana y saber
// dónde poner el ojo: arriba los indicadores del equipo, después «Para mirar hoy» (alertas con número, a quién toca y un botón
// que lleva al lugar) y una fila por persona de su gente (tocarla abre su día). Es el día a día: lo histórico sigue en Métricas.
// Datos: GET /api/lead/today?part=…&team= (lib/lead-api.js; lógica y definiciones en lib/leadview.js). Cada parte (actividades,
// demos, inbound, tratos) se pide y se dibuja por separado: si una tarda o falla, las otras se ven igual.
// Regla de números: cada uno con su definición (title y letra chica); lo que no se sabe va «?».
import { S, api, esc, icon, ago, cap, homeSwitchHtml, bindHomeSwitch, teamSelect, teamView, teamQuery, setTeamView, shortDay, TYPE_ICON, modal, toast } from "./core.js";
import { openSchool, openRecord } from "./school.js";
import { showDeals } from "./deals.js";

const PARTS = ["acts", "demos", "inbound", "deals"];
const PART_NAME = { acts: "las actividades", demos: "las demos", inbound: "los inbound", deals: "los tratos" };
const cache = new Map(); // lo leído por equipo (volver a Hoy lo muestra al instante y se actualiza atrás)
let host = null, rerenderHome = null, seq = 0, B = null, showQuiet = false, more = { inbound: false, unmarked: false };

const keyOf = () => teamView() || "";
const blank = () => ({ meta: null, people: null, parts: {}, error: null });

export function renderHome(el, rerender) {
  host = el; rerenderHome = rerender;
  B = cache.get(keyOf()) || blank();
  draw();
  // al entrar, la app dibuja la vista más de una vez seguida: un pedido que recién salió no se repite (dibuja acá al llegar)
  if (!(B.loading?.size && Date.now() - (B.started || 0) < 4000)) load();
}
function load() {
  const my = ++seq, k = keyOf(), tq = teamQuery();
  const box = cache.get(k) || blank(); cache.set(k, box); B = box; box.error = null; box.loading = new Set(PARTS); box.started = Date.now();
  const done = () => { if (my === seq && host?.isConnected) draw(); };
  for (const p of PARTS) api(`/api/lead/today?part=${p}${tq ? "&" + tq : ""}`).then(r => {
    box.meta = { at: r.at, today: r.today, tomorrow: r.tomorrow, tz: r.tz, scope: r.scope, pdWeb: r.pdWeb, defs: r.defs || {}, limits: r.limits || {} };
    box.people = r.people || [];
    // si esta vez falló y había una lectura buena, queda la buena con el aviso
    const got = r.parts?.[p];
    box.parts[p] = got?.error && box.parts[p] && !box.parts[p].error ? { ...box.parts[p], stale: got.error } : got;
  }, e => {
    // 403 / 503: no hay panel (no es líder, el equipo no es suyo o no se pudieron leer los equipos)
    if (e.status === 403 || e.status === 503 || e.status === 404) { box.error = { status: e.status, message: e.message }; if (e.status !== 503) { box.people = null; box.parts = {}; } }
    else if (!box.parts[p] || box.parts[p].error) box.parts[p] = { error: e.message };
    else box.parts[p] = { ...box.parts[p], stale: e.message };
  }).finally(() => { box.loading.delete(p); done(); });
}

// ---------- formato
const fmt = n => n == null || Number.isNaN(n) ? "?" : Number(n).toLocaleString("es", { maximumFractionDigits: 1 });
const part = p => { const x = B?.parts?.[p]; return x && !x.error ? x : null; };
const waiting = p => !B?.parts?.[p] && B?.loading?.has(p);
const def = k => B?.meta?.defs?.[k] || "";
const pname = id => B?.people?.find(x => x.id === Number(id))?.name || "";
const first = n => String(n || "").trim().split(/\s+/)[0] || "";
const ROLE = { sdr: "SDR", ae: "Account" };
const greeting = () => { const h = new Date().getHours(); return h < 12 ? "Buen día" : h < 19 ? "Buenas tardes" : "Buenas noches"; };
const skel = (n, h = 14) => `<div class="skel" style="margin:10px 0;height:${h}px"></div>`.repeat(n);
const whoTxt = (who = [], max = 4) => {
  const l = who.map(w => ({ ...w, name: w.name || pname(w.id) || "?" }));
  // de una persona, el primer nombre; «sin dueño» o «cuentas generales», tal cual
  return l.slice(0, max).map(w => `${w.id ? first(w.name) : w.name} ${fmt(w.n)}`).join(" · ") + (l.length > max ? ` · y ${l.length - max} más` : "");
};
const DEMO_STATE = { done: "hecha", noshow: "no show", booked: "agendada", unmarked: "sin marcar" };
const leftTxt = h => h == null ? "" : h <= 0 ? "Pasaron las 72 h" : `Quedan ${h} h`;

// ---------- pantalla
function draw() {
  if (!host?.isConnected || !B) return;
  const focusKey = document.activeElement?.dataset?.focusKey, y = document.getElementById("main")?.scrollTop;
  const m = B.meta, team = m?.scope?.team, name = first(S.me?.name);
  const sub = `${cap(new Intl.DateTimeFormat("es", { weekday: "long", day: "numeric", month: "long" }).format(new Date()))} · ${team ? `equipo ${team.name}` : m?.scope?.on ? "toda la cuenta" : "tu equipo"}`;
  host.innerHTML = `<div class="page lh">
    ${homeSwitchHtml()}
    <div class="page-head"><div><h1>${greeting()}${name ? `, ${esc(cap(name))}` : ""}</h1><p>${esc(sub)}</p></div>
      <div class="team-head">${teamSelect("lhTeam")}<button class="btn" id="lhRefresh" data-focus-key="lhRefresh" title="Volver a pedir los datos (las lecturas de Pipedrive se guardan 10 minutos)">${icon("refresh", "sm")} Actualizar</button><a class="btn" href="#/metricas">${icon("chart", "sm")} Métricas</a></div></div>
    ${S.demo ? `<div class="callout warn" style="margin-bottom:16px">${icon("alert")}<span><b>Modo demo.</b> Las personas, las actividades, las demos y los tratos que ves son de prueba.</span></div>` : ""}
    ${B.error ? errorBox() : ""}
    ${B.error && B.error.status !== 503 ? "" : `${kpis()}${alertsCard()}${peopleCard()}<div class="lh-two">${demosCard()}${inboundCard()}</div>${foot()}`}
  </div>`;
  bind();
  if (focusKey) host.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: true });
  if (y != null && document.getElementById("main")) document.getElementById("main").scrollTop = y;
}
function errorBox() {
  const e = B.error;
  return `<div class="callout ${e.status === 503 ? "warn" : "err"}" style="margin-bottom:16px">${icon("alert")}<span>${esc(e.message || "No pudimos traer el panel del equipo.")}${e.status === 403 ? " Mientras, podés pasar a «Prospección» o «Mis tratos» con el selector de arriba." : ""}</span><button class="btn sm" id="lhRetry">Reintentar</button></div>`;
}

// ---------- indicadores del equipo (tocar uno baja a su parte o lleva a su vista)
function kpis() {
  const a = part("acts"), d = part("demos"), i = part("inbound"), t = part("deals");
  const tiles = [
    { k: "demos", l: `Demos que cuentan${d?.period ? ` · ${d.period.label.split(" ")[0]}` : ""}`, v: d?.totals.counts, sub: d ? `${fmt(d.totals.done)} ${d.totals.done === 1 ? "hecha" : "hechas"} en el mes` : "", def: def("counts"), go: "view:equipo", cta: "Ver en Equipo" },
    { k: "demos", l: "Demos de hoy", v: d?.totals.today, sub: d ? `mañana: ${fmt(d.totals.tomorrow)}${d.totals.unmarked ? ` · ${fmt(d.totals.unmarked)} sin marcar` : ""}` : "", def: "Demos del equipo con fecha de hoy, sin las canceladas.", go: "anchor:demos", cta: "Ver cuáles", warn: !!d?.totals.unmarked },
    { k: "acts", l: "Vencidas del equipo", v: a?.totals.overdue, sub: a ? `para hoy: ${fmt(a.totals.today)} · hechas hoy: ${fmt(a.totals.doneToday)}` : "", def: `${def("overdue")} Suma de las personas de la lista.`, go: "anchor:people", cta: "Ver por persona", bad: a?.totals.overdue > 0 },
    { k: "inbound", l: "Inbound sin contactar", v: i?.totals.new, sub: i ? (i.totals.late == null ? "plazo de 72 h: ?" : i.totals.late ? `${fmt(i.totals.late)} ya pasaron las 72 h` : i.totals.soon ? `${fmt(i.totals.soon)} vencen en menos de 24 h` : `de ${fmt(i.totals.entries)} que entraron en 7 días`) : "", def: def("inbNew"), go: "anchor:inbound", cta: "Ver cuáles", bad: i?.totals.late > 0 },
    { k: "deals", l: "Tratos que piden atención", v: t?.totals.attn, sub: t ? `de ${fmt(t.totals.n)} abiertos` : "", def: def("attn"), go: "deals:team", cta: "Ver los tratos" },
  ];
  return `<section class="lh-kpis" aria-label="Indicadores del equipo">${tiles.map((x, n) => {
    const p = B.parts[x.k], err = p?.error;
    return `<button type="button" class="card lh-kpi${x.bad ? " bad" : ""}" data-go="${x.go}" data-focus-key="kpi${n}" title="${esc(x.def)}">
      <span class="l">${esc(x.l)}</span>${!p ? '<span class="skel" style="display:block;height:30px;width:64px;margin:4px 0"></span>' : `<b>${err ? "?" : fmt(x.v)}</b>`}
      <small>${esc(err ? "no se pudo leer" : x.sub)}</small><small class="cta">${esc(x.cta)} ${icon("chevR", "sm")}</small></button>`;
  }).join("")}</section>`;
}

// ---------- «Para mirar hoy»
function alertsCard() {
  const alerts = PARTS.flatMap(p => part(p)?.alerts || []).sort((a, b) => a.rank - b.rank || b.n - a.n);
  const pending = PARTS.filter(p => !B.parts[p]), failed = PARTS.filter(p => B.parts[p]?.error);
  const row = a => `<li class="lh-alert ${a.rank <= 20 ? "hot" : ""}"><b class="n" aria-hidden="true">${fmt(a.n)}</b>
    <div class="t"><b title="${esc(a.def || "")}">${esc(a.text)}</b><small>${esc([a.sub, whoTxt(a.who)].filter(Boolean).join(a.sub && a.who?.length ? ": " : ""))}</small></div>
    <button class="btn sm" data-go="${esc(goOf(a.go))}" data-focus-key="al-${esc(a.key)}">${esc(a.label)}</button></li>`;
  const body = alerts.length ? `<ul class="lh-alerts">${alerts.map(row).join("")}</ul>`
    : pending.length ? "" : failed.length ? "" : `<div class="empty compact lh-ok">${icon("checkCircle")}<b>Todo al día</b><span>Sin demos de hoy, sin demos por marcar, sin inbound esperando, nadie con muchas vencidas y los tratos con próximo paso.</span></div>`;
  return `<section class="card lh-card" aria-labelledby="lhA"><div class="card-h"><h2 id="lhA">${icon("alert")} Para mirar hoy</h2><span class="sub">${alerts.length ? "lo más urgente arriba" : ""}</span></div>
    <div class="card-b">${body}${pending.length ? `<div aria-busy="true">${skel(2, 34)}</div><p class="mx-note">Leyendo ${esc(pending.map(p => PART_NAME[p]).join(", "))}…</p>` : ""}
    ${failed.map(p => `<div class="callout warn" style="margin-top:8px">${icon("alert")}<span>No pude leer ${PART_NAME[p]}: ${esc(B.parts[p].error)} Lo de esa parte no está en esta lista.</span><button class="btn sm" data-retry>Reintentar</button></div>`).join("")}</div></section>`;
}
const goOf = g => g?.anchor ? `anchor:${g.anchor}` : g?.view ? `view:${g.view}` : g?.deals ? `deals:${g.deals}` : "";

// ---------- una fila por persona
const quiet = p => !p.app && !p.self && PARTS.every(k => !B.parts[k] || B.parts[k].error || Object.values(B.parts[k].by?.[p.id] || {}).every(v => !v));
function peopleCard() {
  const ppl = B.people;
  if (!ppl) return `<section class="card lh-card" id="lh-people"><div class="card-h"><h2>${icon("users")} Tu gente hoy</h2></div><div class="card-b" aria-busy="true">${skel(5, 30)}</div></section>`;
  const allIn = PARTS.every(k => B.parts[k]), scoped = !!B.meta?.scope?.team;
  // sin equipo elegido están todos los usuarios de Pipedrive: los que no usan la app y no tienen nada hoy van aparte
  const hidden = !scoped && allIn ? ppl.filter(quiet) : [], rows = showQuiet ? ppl : ppl.filter(p => !hidden.includes(p));
  const a = B.parts.acts, d = B.parts.demos, i = B.parts.inbound, t = B.parts.deals;
  const cell = (label, p, html, title = "", na = false) => `<span class="c${na ? " na" : ""}" ${title ? `title="${esc(title)}"` : ""}><span class="k">${esc(label)}</span>${!p ? '<span class="skel" style="display:inline-block;width:28px;height:14px"></span>' : p.error ? "<b>?</b>" : html}</span>`;
  const num = (v, cls = "") => `<b class="${v == null ? "unk" : !v ? "zero" : cls}">${fmt(v)}</b>`;
  const sm = t2 => t2 ? `<small>${t2}</small>` : "";
  const line = p => {
    const A = a?.by?.[p.id], Dm = d?.by?.[p.id], I = i?.by?.[p.id], T = t?.by?.[p.id], many = A?.overdue >= (B.meta?.limits?.lateMany || 10);
    const inb = p.role === "ae" ? `<b class="zero">—</b>` : `${num(I?.new, I?.late ? "bad" : "")}${sm([I?.late ? `<span class="bad">${fmt(I.late)} +72 h</span>` : I?.late == null && I?.new ? "72 h: ?" : "", I?.todo ? `${fmt(I.todo)} sin procesar` : "", A?.inbCalls ? `${fmt(A.inbCalls)} ${A.inbCalls === 1 ? "llamada vencida" : "llamadas vencidas"}` : ""].filter(Boolean).join(" · "))}`;
    const deals = p.role === "sdr" || (p.role !== "ae" && !T?.n) ? `<b class="zero">—</b>` : `${num(T?.n)}${sm(T?.attn ? `<span class="warn">${fmt(T.attn)} piden atención</span>` : "")}`;
    const cells = `<span class="who"><b>${esc(p.name)}${p.self ? " <i>(vos)</i>" : ""}</b><small>${esc(ROLE[p.role] || (p.app ? "Sin rol elegido" : "No entró a la app"))}</small></span>
      ${cell("Para hoy", a, num(A?.today), def("today"))}
      ${cell("Hechas hoy", a, num(A?.doneToday, "ok"), def("doneToday"))}
      ${cell("Vencidas", a, num(A?.overdue, many ? "bad" : "warn"), def("overdue"))}
      ${cell("Demos hoy · mañana", d, `${num(Dm?.today)}<b class="sep">·</b>${num(Dm?.tomorrow)}${sm(Dm?.unmarked ? `<span class="warn">${fmt(Dm.unmarked)} sin marcar</span>` : "")}`, `${def("demosToday")} ${def("demosTomorrow")}`)}
      ${cell("Cuentan en el mes", d, `${num(Dm?.counts)}${sm(Dm?.done ? `${fmt(Dm.done)} ${Dm.done === 1 ? "hecha" : "hechas"}` : "")}`, def("counts"))}
      ${cell("Inbound sin contactar", p.role === "ae" ? {} : i, inb, p.role === "ae" ? "No aplica a un account." : `${def("inbNew")} ${def("inbCalls")}`, p.role === "ae")}
      ${cell("Tratos abiertos", p.role === "sdr" ? {} : t, deals, p.role === "sdr" ? "Los tratos se miran en los accounts." : `${def("deals")} ${def("attn")}`, p.role === "sdr")}`;
    return p.open ? `<button type="button" class="lh-row" data-person="${p.id}" data-focus-key="p${p.id}" aria-label="${esc(p.name)}: abrir su día">${cells}<span class="go" aria-hidden="true">${icon("chevR", "sm")}</span></button>`
      : `<div class="lh-row" title="Su día lo ve su líder o dirección.">${cells}<span class="go"></span></div>`;
  };
  const head = `<div class="lh-row head" aria-hidden="true"><span class="who">Persona</span>${["Para hoy", "Hechas hoy", "Vencidas", "Demos hoy · mañana", "Cuentan en el mes", "Inbound sin contactar", "Tratos abiertos"].map(h => `<span class="c">${h}</span>`).join("")}<span class="go"></span></div>`;
  return `<section class="card lh-card" id="lh-people" aria-labelledby="lhP"><div class="card-h"><h2 id="lhP">${icon("users")} Tu gente hoy</h2><span class="sub">${rows.length} ${rows.length === 1 ? "persona" : "personas"} · tocá una para ver su día</span></div>
    <div class="card-b">${rows.length ? `<div class="lh-table">${head}${rows.map(line).join("")}</div>` : `<div class="empty compact"><b>Todavía no hay nadie en este equipo</b><span>Sumá a tu gente en Equipo › Equipos.</span></div>`}
    ${hidden.length ? `<button class="btn ghost sm" id="lhQuiet" data-focus-key="lhQuiet" style="margin-top:8px">${showQuiet ? "Ocultar" : "Ver"} ${hidden.length} ${hidden.length === 1 ? "persona" : "personas"} sin nada hoy que no ${hidden.length === 1 ? "entró" : "entraron"} a la app</button>` : ""}
    <p class="mx-note">En orden alfabético (SDR, accounts y el resto). Cada número es de hoy, en tu hora; pasá el mouse para ver qué cuenta. «?» = no se pudo saber.</p></div></section>`;
}

// ---------- demos de hoy y de mañana, y las pasadas sin marcar
function demoRow(it, late = false) {
  const who = [it.owner ? `la da ${first(it.owner)}` : "", it.setter && it.setterId !== it.ownerId ? `la cargó ${first(it.setter)}` : it.auto ? "entrada automática" : ""].filter(Boolean).join(" · ");
  const sub = `${late ? `${cap(shortDay(it.date))}` : it.time || "sin hora"}${late && it.time ? ` ${it.time}` : ""}${who ? ` · ${who}` : ""}${!late && it.state !== "booked" ? ` · ${DEMO_STATE[it.state] || it.state}` : ""}`;
  const inner = `<b>${esc(it.name || "Demo")}</b><small class="${late ? "late" : ""}">${esc(sub)}</small>`;
  return `<div class="act"><span class="ty meeting" role="img" aria-label="Demo">${icon(TYPE_ICON.meeting)}</span>
    ${it.schoolId && S.byId.has(it.schoolId) ? `<button class="t" data-school="${esc(it.schoolId)}">${inner}</button>` : it.record ? `<button class="t" data-record="${esc(it.record)}">${inner}</button>` : `<div class="t">${inner}</div>`}</div>`;
}
function demosCard() {
  const p = B.parts.demos, d = part("demos");
  const body = !p ? `<div aria-busy="true">${skel(4, 30)}</div>` : p.error ? `<div class="callout warn">${icon("alert")}<span>No pude leer las demos: ${esc(p.error)}</span><button class="btn sm" data-retry>Reintentar</button></div>`
    : `${!d.known ? `<div class="callout warn" style="margin-bottom:8px">${icon("alert")}<span>Pipedrive devolvió la lista de demos cortada: los números quedan en «?». Esto es lo que se pudo leer.</span></div>` : ""}
      ${group("Hoy", d.today, d.totals.today)}${group("Mañana", d.tomorrow, d.totals.tomorrow)}
      ${!d.today.length && !d.tomorrow.length ? `<div class="empty compact">${icon("calendar")}<b>Sin demos hoy ni mañana</b></div>` : ""}
      ${d.unmarked.length ? `<div class="group-h late">Pasadas sin marcar <span class="n">${fmt(d.totals.unmarked)}</span></div>${(more.unmarked ? d.unmarked : d.unmarked.slice(0, 4)).map(it => demoRow(it, true)).join("")}
        <div class="lh-more">${d.unmarked.length > 4 ? `<button class="btn ghost sm" data-more="unmarked" data-focus-key="moreU">${more.unmarked ? "Ver menos" : `Ver ${d.unmarked.length - 4} más`}</button>` : ""}<a class="btn sm" href="#/equipo">Marcar en Equipo</a></div>` : ""}`;
  return `<section class="card lh-card" id="lh-demos" aria-labelledby="lhD"><div class="card-h"><h2 id="lhD">${icon("video")} Demos de hoy y mañana</h2><a class="sub" href="#/equipo">Demos del mes en Equipo</a></div><div class="card-b">${body}
    <p class="mx-note" title="${esc(def("unmarked"))}">Las que da o cargó tu gente, sin las canceladas. Sin marcar: ya pasaron (este mes o en los últimos 7 días) y nadie dijo si se hicieron.</p></div></section>`;
}
const group = (title, list, n) => list.length ? `<div class="group-h">${title} <span class="n">${fmt(n)}</span></div>${list.map(it => demoRow(it)).join("")}` : "";

// ---------- inbound sin contactar (los más viejos primero)
function inboundCard() {
  const p = B.parts.inbound, d = part("inbound"), pdWeb = B.meta?.pdWeb || S.pdWeb;
  const row = x => {
    const cls = x.left == null ? "" : x.left <= 0 ? "bad" : x.left <= (B.meta?.limits?.soonHours || 24) ? "warn" : "";
    const who = x.person || (x.free ? "Cuenta general" : "Sin dueño"), url = x.rec === "deal" ? `${pdWeb}/deal/${x.id}` : `${pdWeb}/leads/inbox/${x.id}`;
    const inner = `<b>${esc(x.title || (x.rec === "deal" ? "Trato" : "Prospecto"))}</b><small>${esc(`${who} · entró ${ago(x.entry)}${x.rec === "deal" ? " · trato" : ""}`)}</small>`;
    return `<div class="act"><span class="ty lead" role="img" aria-label="Inbound">${icon("bolt")}</span>
      ${x.rec === "lead" ? `<button class="t" data-record="lead:${esc(x.id)}" data-tab="hist">${inner}</button>` : `<a class="t" href="${esc(url)}" target="_blank" rel="noopener">${inner}</a>`}
      <div class="ops"><span class="lh-left ${cls}">${esc(leftTxt(x.left))}</span><a class="icon-btn" href="${esc(url)}" target="_blank" rel="noopener" title="Abrir en Pipedrive" aria-label="Abrir en Pipedrive">${icon("external", "sm")}</a></div></div>`;
  };
  const list = d?.list || [], shown = more.inbound ? list : list.slice(0, 6);
  const body = !p ? `<div aria-busy="true">${skel(4, 30)}</div>` : p.error ? `<div class="callout warn">${icon("alert")}<span>No pude leer los inbound: ${esc(p.error)}</span><button class="btn sm" data-retry>Reintentar</button></div>`
    : `${!d.known ? `<div class="callout warn" style="margin-bottom:8px">${icon("alert")}<span>Pipedrive devolvió alguna lista cortada: cuántos hay sin contactar queda en «?».</span></div>` : ""}
      ${list.length ? shown.map(row).join("") : d.known ? `<div class="empty compact">${icon("checkCircle")}<b>Ninguno sin contactar</b><span>${fmt(d.totals.entries)} entraron en los últimos 7 días.</span></div>` : ""}
      ${list.length > 6 ? `<div class="lh-more"><button class="btn ghost sm" data-more="inbound" data-focus-key="moreI">${more.inbound ? "Ver menos" : `Ver ${list.length - 6} más`}</button></div>` : ""}
      ${d.cut ? `<p class="mx-note">Se ven los ${list.length} más viejos de ${fmt(d.totals.new)}. El resto, en Métricas › Inbound.</p>` : ""}
      ${d.slack?.todo ? `<div class="callout" style="margin-top:10px">${icon("bolt")}<span title="${esc(def("inbTodo"))}"><b>${fmt(d.slack.todo)} del reparto sin procesar</b>: todavía no están en Pipedrive${d.slack.soon ? ` (a ${fmt(d.slack.soon)} les quedan 24 h o menos)` : ""}.</span><a class="btn sm" href="#/inbound">Tus inbound</a></div>` : ""}
      ${d.slack?.unassigned ? `<p class="mx-note">${fmt(d.slack.unassigned)} del reparto sin procesar no se sabe a quién le tocaron: están en Tus inbound.</p>` : ""}`;
  return `<section class="card lh-card" id="lh-inbound" aria-labelledby="lhI"><div class="card-h"><h2 id="lhI">${icon("bolt")} Inbound sin contactar</h2><a class="sub" href="#/metricas">Conversión en Métricas</a></div><div class="card-b">${body}
    <p class="mx-note" title="${esc(def("inbNew"))}">Entraron en los últimos 7 días con Fuente «Inbound - …» y nadie los llamó ni les escribió todavía. El plazo es de 72 h desde que entraron.</p></div></section>`;
}
function foot() {
  const a = part("acts"), d = part("demos"), t = part("deals"), i = part("inbound");
  const bits = [a?.at && `actividades leídas ${ago(a.at)}`, d?.at?.window && `demos ${ago(d.at.window)}`, i?.at?.leads && `inbound ${ago(i.at.leads)}`, t?.at && `tratos ${ago(t.at)}`].filter(Boolean);
  const stale = PARTS.filter(p => B.parts[p]?.stale);
  return `${stale.length ? `<div class="callout warn" style="margin-top:12px">${icon("alert")}<span>No pude actualizar ${esc(stale.map(p => PART_NAME[p]).join(", "))}: ves la lectura anterior.</span><button class="btn sm" data-retry>Reintentar</button></div>` : ""}
    <p class="mx-src" style="margin-top:14px">${esc(bits.length ? `Pipedrive · ${bits.join(" · ")}. Las lecturas se guardan hasta 10 minutos.` : "")} Esto es el día a día: lo histórico, por período y por persona, está en <a href="#/metricas">Métricas</a> y las demos del mes en <a href="#/equipo">Equipo</a>.</p>`;
}

// ---------- acciones
function goTo(spec) {
  const [kind, to] = String(spec || "").split(":");
  if (kind === "anchor") { const el = host.querySelector(`#lh-${CSS.escape(to)}`); el?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" }); el?.querySelector("h2")?.setAttribute("tabindex", "-1"); el?.querySelector("h2")?.focus({ preventScroll: true }); }
  else if (kind === "view") location.hash = `#/${to}`;
  else if (kind === "deals") showDeals({ owner: to });
}
function bind() {
  bindHomeSwitch(host, () => rerenderHome?.());
  host.querySelector("#lhTeam")?.addEventListener("change", e => { setTeamView(e.target.value); showQuiet = false; B = cache.get(keyOf()) || blank(); draw(); load(); });
  host.querySelector("#lhRefresh")?.addEventListener("click", () => { load(); toast("Actualizando…", { ms: 1500 }); });
  host.querySelector("#lhRetry")?.addEventListener("click", () => { cache.delete(keyOf()); B = blank(); draw(); load(); });
  host.querySelectorAll("[data-retry]").forEach(b => b.onclick = () => load());
  host.querySelectorAll("[data-go]").forEach(b => b.onclick = () => goTo(b.dataset.go));
  host.querySelectorAll("[data-person]").forEach(b => b.onclick = () => personModal(Number(b.dataset.person)));
  host.querySelectorAll("[data-more]").forEach(b => b.onclick = () => { more[b.dataset.more] = !more[b.dataset.more]; draw(); });
  host.querySelector("#lhQuiet")?.addEventListener("click", () => { showQuiet = !showQuiet; draw(); });
  bindOpen(host);
}
function bindOpen(root, before = () => {}) {
  root.querySelectorAll("[data-school]").forEach(b => b.onclick = () => { before(); openSchool(b.dataset.school, { activityId: Number(b.dataset.act) || null }); });
  root.querySelectorAll("[data-record]").forEach(b => b.onclick = () => { before(); openRecord(b.dataset.record, { activityId: Number(b.dataset.act) || null, ...(b.dataset.tab ? { tab: b.dataset.tab } : {}) }); });
}

// ---------- el día de una persona: sus pendientes de hoy y vencidas (su agenda), sus demos y sus tratos
function actRow(a, late) {
  const s = a.schoolId && S.byId.get(a.schoolId), title = s ? s.name : a.who || a.subject;
  // con colegio, el asunto sin su nombre repetido («Llamada · Colegio X» → «Llamada»)
  const what = s ? a.subject.replace(new RegExp(`\\s*·\\s*${s.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`), "") : a.who ? a.subject : "";
  const sub = [what || (s ? a.typeLabel : ""), late ? `vencida ${shortDay(a.date)}${a.time ? ` ${a.time}` : ""}` : a.time, s?.city || a.city].filter(Boolean).join(" · ") || a.typeLabel;
  const inner = `<b>${esc(title)}</b><small class="${late ? "late" : ""}">${esc(sub)}</small>`;
  return `<div class="act"><span class="ty ${esc(a.type)}" role="img" aria-label="${esc(a.typeLabel)}" title="${esc(a.typeLabel)}">${icon(TYPE_ICON[a.type] || "check")}</span>
    ${s ? `<button class="t" data-school="${esc(s.id)}" data-act="${a.id}">${inner}</button>` : a.record ? `<button class="t" data-record="${esc(a.record)}" data-act="${a.id}">${inner}</button>`
      : a.url ? `<a class="t" href="${esc(a.url)}" target="_blank" rel="noopener" title="Abrir en Pipedrive">${inner}</a>` : `<div class="t">${inner}</div>`}</div>`;
}
function personModal(id) {
  const p = B.people?.find(x => x.id === id); if (!p) return;
  const A = part("acts")?.by?.[id], Dm = part("demos"), I = part("inbound")?.by?.[id], T = part("deals")?.by?.[id];
  const mine = l => (l || []).filter(it => Number(it.ownerId) === id || Number(it.setterId) === id);
  let data = null, error = null, moreLate = false;
  const m = modal("", {});
  m.querySelector(".modal-box").classList.add("mid", "lh-person");
  const paint = () => {
    const demos = Dm ? [...mine(Dm.today).map(it => demoRow(it)), ...mine(Dm.tomorrow).map(it => demoRow({ ...it, time: `mañana ${it.time || ""}`.trim() })), ...mine(Dm.unmarked).map(it => demoRow(it, true))] : [];
    const late = data?.overdue || [], lateShown = moreLate ? late : late.slice(0, 8);
    m.querySelector(".modal-box").innerHTML = `<div class="modal-h"><h3>${icon("user")} ${esc(p.name)}</h3><button type="button" class="icon-btn" data-x aria-label="Cerrar">${icon("x")}</button></div>
      <p class="muted" style="margin:-8px 0 0">${esc(ROLE[p.role] || "Sin rol elegido")} · su día, en tu hora</p>
      <div class="kpis lh-pk">
        <div class="kpi" title="${esc(def("today"))}"><b>${fmt(data ? data.n.today : A?.today)}</b><span>para hoy</span></div>
        <div class="kpi" title="${esc(def("doneToday"))}"><b>${fmt(A?.doneToday)}</b><span>hechas hoy</span></div>
        <div class="kpi" title="${esc(def("overdue"))}"><b>${fmt(data ? data.n.overdue : A?.overdue)}</b><span>vencidas</span></div>
        ${Dm?.by?.[id] ? `<div class="kpi" title="${esc(def("counts"))}"><b>${fmt(Dm.by[id].counts)}</b><span>demos que cuentan en el mes</span></div>` : ""}
      </div>
      ${error ? `<div class="callout err">${icon("alert")}<span>No pude leer su agenda: ${esc(error)}</span><button class="btn sm" data-again>Reintentar</button></div>` : !data ? `<div aria-busy="true">${skel(4, 30)}</div>` : `
        ${data.cut ? `<div class="callout warn">${icon("alert")}<span>Tiene 500 o más actividades sin hacer: Pipedrive manda las 500 más viejas, así que puede faltar algo de hoy.</span></div>` : ""}
        <div><div class="group-h">Pendientes de hoy <span class="n">${fmt(data.n.today)}</span></div>${data.today.length ? data.today.map(a => actRow(a, false)).join("") : `<p class="mx-note" style="margin:4px 6px">Nada para hoy.</p>`}</div>
        <div><div class="group-h late">Vencidas <span class="n">${fmt(data.n.overdue)}</span></div>${late.length ? lateShown.map(a => actRow(a, true)).join("") : `<p class="mx-note" style="margin:4px 6px">Sin vencidas.</p>`}
          ${late.length > 8 ? `<button class="btn ghost sm" data-late style="margin-top:6px">${moreLate ? "Ver menos" : `Ver ${late.length - 8} más`}</button>` : ""}
          ${data.n.overdue > late.length ? `<p class="mx-note">Se ven las ${late.length} más recientes.</p>` : ""}</div>`}
      ${demos.length ? `<div><div class="group-h">Sus demos <span class="n">${demos.length}</span></div>${demos.join("")}</div>` : ""}
      ${p.role !== "ae" && I ? `<p class="lh-pline" title="${esc(def("inbNew"))}">${icon("bolt", "sm")} <span><b>Inbound:</b> ${fmt(I.new)} sin contactar${I.late ? ` (${fmt(I.late)} ya pasaron las 72 h)` : ""}${I.todo ? ` · ${fmt(I.todo)} del reparto sin procesar` : ""}${A?.inbCalls ? ` · ${fmt(A.inbCalls)} ${A.inbCalls === 1 ? "llamada de inbound vencida" : "llamadas de inbound vencidas"}` : ""}.</span></p>` : ""}
      <div class="row lh-prow">${T ? `<span class="muted" title="${esc(def("deals"))} ${esc(def("attn"))}">${icon("deal", "sm")} ${fmt(T.n)} ${T.n === 1 ? "trato abierto" : "tratos abiertos"}${T.attn ? ` · ${fmt(T.attn)} piden atención` : ""}</span>` : ""}
        <button type="button" class="btn" data-deals>${icon("deal", "sm")} Ver sus tratos</button></div>`;
    m.querySelector("[data-x]").onclick = () => m.close();
    m.querySelector("[data-deals]").onclick = () => { m.close(); showDeals({ owner: p.self ? "me" : id }); };
    m.querySelector("[data-late]")?.addEventListener("click", () => { moreLate = !moreLate; paint(); });
    m.querySelector("[data-again]")?.addEventListener("click", () => { error = null; paint(); read(); });
    bindOpen(m, () => m.close());
  };
  const read = () => api(`/api/lead/person/${id}${teamQuery() ? "?" + teamQuery() : ""}`).then(r => { data = r; }, e => { error = e.message; }).finally(() => { if (m.isConnected) paint(); });
  paint(); read();
}
