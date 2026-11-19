// «Hoy» del account (pedido del líder de SDR: «hacerle a los accounts sus propias sesiones y enfocarte en los tratos y darle
// importancia a sus tareas, separando lo que es un SDR o un account»). Lo ve quien tiene rol Account Executive y un líder que
// eligió «Mis tratos» (homeMode de core.js); today.js lo carga con renderHome(el, rerender). Todo es SOLO de quien entra
// (GET /api/ae/today, lib/ae-api.js; la lógica, pura, en lib/aeview.js). En orden de importancia: demos de hoy y de mañana
// (y las de antes sin marcar), tareas vencidas y de hoy agrupadas por trato, y los tratos que piden atención (cada uno una
// vez, con el motivo más grave primero). Arriba, el resumen (tocar un número filtra o lleva a Tratos abiertos) y el botón
// «Trabajar mis tratos»: una sesión (origen «deals») con los tratos que piden atención, en ese orden. Acá no va la cola de
// prospección ni la meta diaria de contactos: eso es del Hoy de SDR. Lo que no se pudo leer va «?» con su aviso.
import { S, api, esc, icon, cap, toast, today, addDays, nextBusinessDay, shortDay, dayLabel, openMenu, modal, ago, TYPE_ICON, demoDue, archivedRef, homeSwitchHtml, bindHomeSwitch, emptyState } from "./core.js";
import { openSchool, openRecord, startSession, resumeSession } from "./school.js";
import { setBadge, baseErrorCallout } from "./app.js";
import { loadSessions, sessionsCard, bindSessionsCard } from "./sessions.js";
import { demoResultMenu, markDone } from "./today.js";
import { fmtN, money, daysTxt, WHY, whyChips, nextHtml, stageLine } from "./aedeal.js";

let host = null, again = null, D = null, err = null, seq = 0, dirty = false;
const F = { late: false, why: "", att: 12, tasks: 12 };

export function renderHome(el, rerender) {
  host = el; again = rerender; F.att = 12; F.tasks = 12;
  draw();
  load({ fresh: dirty });
}
async function load({ fresh = false } = {}) {
  const my = ++seq;
  try {
    // las sesiones guardadas se leen junto (si fallan, la pantalla sigue sin la tarjeta)
    const [r] = await Promise.all([api(`/api/ae/today${fresh ? "?fresh=1" : ""}`), loadSessions().catch(() => null)]);
    if (my !== seq) return;
    D = r; err = null; if (fresh) dirty = false;
  } catch (e) { if (my !== seq) return; err = e.message; }
  if (host?.isConnected) draw();
}
// registraste algo en una ficha o cerraste una actividad: la próxima vez se lee todo de nuevo (sin la copia de 2 minutos)
let wroteTimer = null;
addEventListener("ob:wrote", e => {
  const p = String(e.detail?.path || "");
  if (!/^\/api\/(schools|activities|proposals)\//.test(p) || /\/(timeline|call-brief|check|study)(\?|$)/.test(p)) return;
  dirty = true;
  clearTimeout(wroteTimer); wroteTimer = setTimeout(() => { if (host?.isConnected && S.view === "hoy" && dirty) load({ fresh: true }); }, 1500);
});

// ---------- sesión «Tus tratos»: los que piden atención, en ese orden (también desde Sesiones › «Nueva sesión»)
const sessLabel = () => `Tus tratos · ${new Intl.DateTimeFormat("es", { weekday: "short", day: "numeric", month: "short" }).format(new Date()).replace(",", "")}`;
export async function startDealsSession() {
  let d = D;
  if (!d || dirty) { try { d = D = await api("/api/ae/today?fresh=1"); dirty = false; } catch (e) { return toast(`No pude leer tus tratos: ${e.message}`, { type: "err" }); } }
  if (d.noUser) return toast("Tu email no coincide con ningún usuario de Pipedrive: no hay tratos a tu nombre.", { type: "err" });
  const items = (d.session || []).filter(x => !archivedRef(x.ref));
  if (!items.length) return toast(d.attention?.complete === false ? "No pude leer tus tratos de Pipedrive: probá de nuevo." : "Ningún trato tuyo pide atención ahora.", { type: "info" });
  if (d.sessionTotal > items.length) toast(`La sesión toma los ${fmtN(items.length)} más urgentes de ${fmtN(d.sessionTotal)}.`, { type: "info" });
  return startSession(items, sessLabel(), { origin: { kind: "deals", key: `deals:${today()}` } });
}

// ---------- formato
const greeting = () => { const h = new Date().getHours(); return h < 12 ? "Buen día" : h < 19 ? "Buenas tardes" : "Buenas noches"; };
const firstName = () => cap((S.me.name || "").split(/[\s.@_]/)[0] || "");
const q = n => (n == null ? "?" : fmtN(n));
const pl = (n, one, many) => `${fmtN(n)} ${n === 1 ? one : many}`;
const skel = n => '<div class="skel" style="margin:14px 0"></div>'.repeat(n);
// el colegio o la organización de una fila (el de la base manda) y su asunto sin repetir ese nombre
const nameOf = a => (a.schoolId && S.byId.get(a.schoolId)?.name) || a.who || a.name || "";
const subjectOf = (a, name) => name ? String(a.subject || "").replace(new RegExp(`\\s*·\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`), "") : a.subject || "";
const dealTxt = d => d ? [`Trato en ${[d.pipe, d.stage].filter(Boolean).join(" · ") || "?"}`, d.days != null && `${daysTxt(d.days)} en la etapa`].filter(Boolean).join(" · ") : "";
// a dónde lleva una fila: el colegio de la base, la ficha del prospecto u organización, o Pipedrive
function titleBtn(a, inner, { act = null } = {}) {
  const at = a.schoolId && S.byId.has(a.schoolId) ? `data-school="${esc(a.schoolId)}"` : a.record ? `data-record="${esc(a.record)}"` : "";
  if (at) return `<button class="t" ${at} ${act ? `data-act="${act}"` : ""} ${a.deal ? `data-deals="1"` : ""} title="Abrir la ficha">${inner}</button>`;
  return a.url ? `<a class="t" href="${esc(a.url)}" target="_blank" rel="noopener" title="Abrir en Pipedrive">${inner}</a>` : `<div class="t">${inner}</div>`;
}

// ---------- pantalla
function head() {
  return `${homeSwitchHtml()}${baseErrorCallout()}
    ${S.demo ? `<div class="callout warn" style="margin-bottom:16px">${icon("alert")}<span><b>Modo demo.</b> Pipedrive todavía no está conectado: los tratos, las demos y las tareas que ves son de prueba.</span></div>` : ""}
    <div class="page-head"><div><h1>${greeting()}, ${esc(firstName())}</h1><p>${esc(cap(new Intl.DateTimeFormat("es", { weekday: "long", day: "numeric", month: "long" }).format(new Date())))} · tus demos, tus tareas y tus tratos</p></div>
      <button class="btn sm" id="aeRefresh" title="Volver a leer de Pipedrive">${icon("refresh", "sm")} Actualizar</button></div>`;
}
function draw() {
  if (!host?.isConnected) return;
  const fk = document.activeElement?.dataset?.focusKey;
  if (!D) {
    host.innerHTML = `<div class="page ae">${head()}${err ? `<div class="callout err">${icon("alert")}<span>No pudimos traer tu día de Pipedrive: ${esc(err)}</span><button class="btn sm" id="aeRetry">Reintentar</button></div>`
      : `<div class="mx-kpis dl-kpis">${'<div class="card mx-kpi"><div class="skel" style="width:60%"></div><div class="skel" style="height:26px;width:40%;margin-top:8px"></div></div>'.repeat(4)}</div><div class="card card-b" style="padding:20px">${skel(5)}</div>`}</div>`;
    bindTop();
    return;
  }
  const d = D, sm = d.summary, t = today();
  const demos = [...d.demos.unmarked, ...d.demos.today, ...d.demos.tomorrow];
  const nSess = (d.session || []).length;
  // el botón grande retoma la sesión «Tus tratos» de hoy si quedó algo; si no, arma una nueva
  const last = (S.sessions?.open || []).find(v => v.origin?.kind === "deals" && v.resume >= 0 && v.origin.key === `deals:${t}`);
  host.innerHTML = `<div class="page ae">${head()}
    ${d.noUser ? `<div class="callout warn" style="margin-bottom:16px">${icon("alert")}<span>Tu email (${esc(S.me.email)}) no coincide con ningún usuario de Pipedrive, así que no vemos tus tratos ni tu agenda. Pedí que te den de alta con ese email.</span></div>` : ""}
    ${err ? `<div class="callout warn" style="margin-bottom:16px">${icon("alert")}<span>No pude actualizar (${esc(err)}): ves lo último que leí.</span></div>` : ""}
    ${(d.warnings || []).map(w => `<div class="callout warn" style="margin-bottom:16px">${icon("alert")}<span>${esc(w)}</span></div>`).join("")}
    ${kpis(sm, d)}
    <section class="card ae-cta" aria-label="Trabajar tus tratos">
      <div><h2>${esc(message(d))}</h2><p class="muted">${nSess ? `La sesión abre uno por uno ${nSess === 1 ? "el trato que pide atención" : d.sessionTotal > nSess ? `los ${fmtN(nSess)} tratos más urgentes de los ${fmtN(d.sessionTotal)} que piden atención` : `los ${fmtN(nSess)} tratos que piden atención`}, del más urgente al menos, con el trato arriba de la ficha.` : "Cuando un trato quede sin próximo paso, con algo vencido o quieto, aparece acá para trabajarlo."}</p></div>
      <div class="hero-cta">${last ? `<button class="btn primary lg" id="aeResume" title="Retomar «${esc(last.name)}»: ${last.stats.handled} de ${last.stats.total}">${icon("play")} <span class="ell">Retomar «${esc(last.name)}»</span><span class="nw">· faltan ${last.stats.pending}</span></button><button class="btn ghost sm" id="aeGo" ${nSess ? "" : "disabled"}>Empezar una nueva</button>`
        : `<button class="btn primary lg" id="aeGo" data-focus-key="aeGo" ${nSess ? "" : "disabled"}>${icon("play")} Trabajar mis tratos${nSess ? ` · ${fmtN(nSess)}` : ""}</button>`}
        <a class="btn ghost sm" href="#/tratos">${icon("deal", "sm")} Ver todos mis tratos</a></div>
    </section>
    <div class="today-grid ae-grid">
      <div class="stack">
        <section class="card" id="aeDemos" aria-labelledby="hAeD" tabindex="-1">
          <div class="card-h"><h2 id="hAeD">${icon("video")} Demos de hoy y de mañana</h2><span class="sub">${q(d.demos.n)}</span></div>
          <div class="card-b">${demos.length ? demoGroup("Sin marcar", d.demos.unmarked, "late") + demoGroup("Hoy", d.demos.today) + demoGroup("Mañana", d.demos.tomorrow)
            : emptyState({ title: d.demos.complete ? "Sin demos hoy ni mañana" : "No se pudieron leer tus demos", text: d.demos.complete ? "Las que te agenden aparecen acá con su hora." : "", compact: true })}</div>
        </section>
        <section class="card" id="aeTasks" aria-labelledby="hAeT" tabindex="-1">
          <div class="card-h"><h2 id="hAeT">${icon("check")} Tareas vencidas y de hoy</h2><span class="sub">${q(d.tasks.n)}${d.tasks.late ? ` · ${pl(d.tasks.late, "vencida", "vencidas")}` : ""}</span></div>
          <div class="card-b">${tasksHtml(d)}</div>
        </section>
      </div>
      <section class="card" id="aeAtt" aria-labelledby="hAeA" tabindex="-1">
        <div class="card-h"><h2 id="hAeA">${icon("alert")} Tratos que piden atención</h2><span class="sub">${q(d.attention.n)}</span></div>
        <div class="card-b">${attHtml(d)}</div>
      </section>
    </div>
    ${sessionsCard()}</div>`;
  bindTop();
  bindHomeSwitch(host, again);
  bindSessionsCard(host, () => host?.isConnected && draw());
  const $q = s => host.querySelector(s);
  $q("#aeGo")?.addEventListener("click", () => startDealsSession());
  $q("#aeResume")?.addEventListener("click", () => resumeSession(last.id));
  host.querySelectorAll("[data-k]").forEach(b => b.onclick = () => kpiGo(b.dataset.k));
  host.querySelectorAll("[data-why]").forEach(b => b.onclick = () => { F.why = F.why === b.dataset.why ? "" : b.dataset.why; F.att = 12; draw(); });
  $q("#aeLate")?.addEventListener("click", () => { F.late = !F.late; F.tasks = 12; draw(); });
  $q("#aeMoreT")?.addEventListener("click", () => { F.tasks += 20; draw(); });
  $q("#aeMoreA")?.addEventListener("click", () => { F.att += 30; draw(); });
  host.querySelectorAll("[data-school]").forEach(b => b.onclick = () => openSchool(b.dataset.school, { activityId: Number(b.dataset.act) || null, deals: !!b.dataset.deals }));
  host.querySelectorAll("[data-record]").forEach(b => b.onclick = () => openRecord(b.dataset.record, { activityId: Number(b.dataset.act) || null, deals: !!b.dataset.deals }));
  host.querySelectorAll("[data-deal]").forEach(b => b.onclick = () => openDeal(Number(b.dataset.deal)));
  host.querySelectorAll("[data-demo]").forEach(b => b.onclick = () => demoResultMenu(b, { id: Number(b.dataset.demo), time: b.dataset.time }, refresh));
  host.querySelectorAll("[data-done]").forEach(b => b.onclick = () => { const id = Number(b.dataset.done); markDone(id, () => { drop(id); refresh(); }); });
  host.querySelectorAll("[data-move]").forEach(b => b.onclick = () => moveMenu(b, Number(b.dataset.move), b.dataset.time || ""));
  // el número del menú: lo que tenés para hoy (demos de hoy y sin marcar, tareas vencidas y de hoy)
  setBadge("hoy", d.demos.today.length + d.demos.unmarked.length + d.tasks.groups.reduce((n, g) => n + g.items.length, 0));
  if (fk) host.querySelector(`[data-focus-key="${fk}"]`)?.focus();
}
function bindTop() {
  host.querySelector("#aeRefresh")?.addEventListener("click", () => { toast("Leyendo de Pipedrive…", { type: "info", ms: 1500 }); load({ fresh: true }); });
  host.querySelector("#aeRetry")?.addEventListener("click", () => { err = null; draw(); load({ fresh: true }); });
  bindHomeSwitch(host, again);
}
// después de cerrar, mover o marcar algo: se lee de nuevo (lo que se sacó en el momento ya no está)
const refresh = () => { dirty = true; if (host?.isConnected) load({ fresh: true }); };
// la tarea que se acaba de cerrar sale en el momento (si se deshace, vuelve con la lectura)
function drop(id) {
  if (!D) return;
  const groups = D.tasks.groups.map(g => ({ ...g, items: g.items.filter(a => a.id !== id) })).filter(g => g.items.length).map(g => ({ ...g, late: g.items.filter(a => a.late).length }));
  const n = groups.reduce((k, g) => k + g.items.length, 0), late = groups.reduce((k, g) => k + g.late, 0);
  if (n === D.tasks.groups.reduce((k, g) => k + g.items.length, 0)) return;
  D = { ...D, tasks: { ...D.tasks, groups, n: D.tasks.n == null ? null : n, late: D.tasks.late == null ? null : late }, summary: { ...D.summary, overdue: D.summary.overdue == null ? null : late } };
  if (host?.isConnected) draw();
}

// lo más importante de hoy, en una frase
function message(d) {
  const now = d.demos.today.filter(a => !demoDue(a)), un = d.demos.unmarked.length + d.demos.today.filter(a => demoDue(a)).length, late = d.tasks.late || 0, att = d.attention.n || 0;
  const rest = [late && pl(late, "tarea vencida", "tareas vencidas"), att && pl(att, "trato que pide atención", "tratos que piden atención")].filter(Boolean).join(" y ");
  if (now.length) return `${now.length === 1 ? "Tenés una demo hoy" : `Tenés ${now.length} demos hoy`}${now[0].time ? `: la próxima a las ${now[0].time}` : ""}.${rest ? ` Después, ${rest}.` : ""}`;
  if (un) return `${un === 1 ? "Te queda una demo sin marcar" : `Te quedan ${un} demos sin marcar`}: decí cómo ${un === 1 ? "fue" : "fueron"}.${rest ? ` Después, ${rest}.` : ""}`;
  if (rest) return `Sin demos hoy. Tenés ${rest}.`;
  if (d.demos.n == null || d.tasks.n == null || d.attention.n == null) return "No se pudo leer todo de Pipedrive: mirá los avisos de arriba.";
  return d.demos.tomorrow.length ? `Hoy estás al día. Mañana tenés ${pl(d.demos.tomorrow.length, "demo", "demos")}.` : "Estás al día: sin demos, tareas vencidas ni tratos que pidan atención.";
}
// resumen: tocar un número lleva a Tratos abiertos o a su sección (y filtra)
function kpis(sm, d) {
  const val = sm.value == null ? "<b>?</b>" : sm.value.length ? sm.value.map(v => `<b class="dl-money">${esc(money(v.total, v.currency))}</b>`).join("") : "<b>—</b>";
  const w = sm.demosWeek, wk = w ? [w.held && pl(w.held, "hecha", "hechas"), w.upcoming && `${fmtN(w.upcoming)} por dar`, w.unmarked && `${fmtN(w.unmarked)} sin marcar`, w.noshow && `${fmtN(w.noshow)} no show`, w.canceled && pl(w.canceled, "cancelada", "canceladas")].filter(Boolean).join(" · ") : "";
  const tile = (k, l, v, sub = "", warn = false) => `<button class="card mx-kpi dl-kpi ${warn && v ? "warn" : ""}" data-k="${k}"><span class="l">${esc(l)}</span>${typeof v === "string" && v.startsWith("<") ? v : `<b>${q(v)}</b>`}${sub ? `<small>${esc(sub)}</small>` : ""}</button>`;
  return `<div class="mx-kpis dl-kpis ae-kpis">
    ${tile("deals", "Tratos abiertos", sm.deals, sm.noValue ? `${fmtN(sm.noValue)} sin valor` : "")}
    ${tile("value", "Valor", val, sm.value == null ? "" : "suma de los que tienen valor cargado")}
    ${tile("week", "Demos esta semana", w ? w.total : null, w ? wk || "de lunes a domingo" : "no se pudo leer entera")}
    ${tile("late", "Tareas vencidas", sm.overdue, "", true)}
    ${tile("att", "Piden atención", sm.attention, "", true)}
  </div>`;
}
function kpiGo(k) {
  if (k === "deals" || k === "value") { location.hash = "#/tratos"; return; }
  if (k === "late") { F.late = !!D?.tasks.late; draw(); }
  const el = host.querySelector({ week: "#aeDemos", late: "#aeTasks", att: "#aeAtt" }[k]);
  el?.scrollIntoView({ behavior: "smooth", block: "start" }); el?.focus({ preventScroll: true });
}

// ---------- demos
function demoGroup(title, list, cls = "") {
  if (!list.length) return "";
  return `<div class="group-h ${cls}">${title} <span class="n">${list.length}</span></div>` + list.map(a => {
    const due = demoDue(a), name = nameOf(a), when = cls === "late" ? `${cap(shortDay(a.date))}${a.time ? ` · ${a.time}` : ""}` : a.time || "sin hora";
    const sub = [when, name ? subjectOf(a, name) : "", a.city, dealTxt(a.deal)].filter(Boolean).join(" · ");
    return `<div class="act ae-act"><span class="ty meeting" role="img" aria-label="Demo" title="Demo">${icon("video")}</span>
      ${titleBtn(a, `<b>${esc(name || a.subject || "Demo")}</b><small class="${cls === "late" ? "late" : ""}">${esc(sub)}</small>`)}
      <div class="ops">${due ? `<button class="btn sm" data-demo="${a.id}" data-time="${esc(a.time || "")}" data-focus-key="demo-${a.id}">Marcar resultado</button>` : ""}</div></div>`;
  }).join("");
}

// ---------- tareas: por trato, la más vieja primero
function tasksHtml(d) {
  const all = d.tasks.groups, groups = F.late ? all.filter(g => g.late).map(g => ({ ...g, items: g.items.filter(x => x.late) })) : all;
  if (!all.length) return emptyState({ title: d.tasks.complete ? "Sin tareas vencidas ni para hoy" : "No se pudieron leer tus tareas", compact: true });
  const shown = groups.slice(0, F.tasks);
  return `${d.tasks.late ? `<div class="chips ae-filter"><button class="chip" id="aeLate" aria-pressed="${F.late}" data-focus-key="aeLate">Solo vencidas <b>${fmtN(d.tasks.late)}</b></button></div>` : ""}
    ${shown.map(g => { const name = nameOf(g); return `<div class="ae-group">
      <div class="ae-gh">${titleBtn(g, `<b>${esc(name || g.deal?.title || g.items[0].subject)}</b><small>${esc([g.city, g.deal ? [g.deal.pipe, g.deal.stage].filter(Boolean).join(" · ") : g.dealId ? "Trato que no es tuyo o ya no está abierto" : "Sin trato", g.deal?.days != null && `${daysTxt(g.deal.days)} en la etapa`].filter(Boolean).join(" · "))}</small>`)}</div>
      ${g.items.map(a => `<div class="act ae-act ae-task"><span class="ty ${esc(a.type)}" role="img" aria-label="${esc(a.typeLabel)}" title="${esc(a.typeLabel)}">${icon(TYPE_ICON[a.type] || "check")}</span>
        ${titleBtn(a, `<b>${esc(subjectOf(a, name) || a.typeLabel)}</b><small class="${a.late ? "late" : ""}">${esc(`${a.late ? `Vencida ${shortDay(a.date)}` : "Hoy"}${a.time ? ` · ${a.time}` : ""}`)}</small>`, { act: a.id })}
        <div class="ops"><button class="icon-btn" data-done="${a.id}" data-focus-key="done-${a.id}" title="Marcar como hecha" aria-label="Marcar como hecha">${icon("check")}</button><button class="icon-btn" data-move="${a.id}" data-time="${esc(a.time || "")}" title="Reprogramar" aria-label="Reprogramar">${icon("clock")}</button></div></div>`).join("")}
    </div>`; }).join("")}
    ${groups.length > shown.length ? `<button class="btn ghost sm block" id="aeMoreT" data-focus-key="aeMoreT">Ver ${fmtN(groups.length - shown.length)} más</button>` : ""}`;
}
// Reprogramar una tarea (como en la Agenda): la hora se mantiene
function moveMenu(anchor, id, time) {
  const t = today(), nb = nextBusinessDay(t);
  const opts = [["Mañana", addDays(t, 1)], ...(nb !== addDays(t, 1) ? [["Próximo día hábil", nb]] : []), ["En 3 días", addDays(t, 3)], ["En una semana", addDays(t, 7)]];
  const go = async (d, tm) => {
    try { const r = await api(`/api/activities/${id}/move`, { body: { date: d, time: tm } }); toast([`Reprogramada para ${shortDay(d)}${tm ? ` a las ${tm}` : ""}`, ...(r.done || []).map(x => x.label)].join(". "), r.done?.some(x => x.warn) ? { type: "err" } : undefined); }
    catch (e) { return toast(e.message, { type: "err" }); }
    refresh();
  };
  const abs = d => new Intl.DateTimeFormat("es", { weekday: "short", day: "numeric", month: "short" }).format(new Date(d + "T12:00:00"));
  openMenu(anchor, [{ head: "Reprogramar para" }, ...opts.map(([l, d]) => ({ label: l, sub: abs(d), fn: () => go(d, time) })),
    { label: "Elegir fecha y hora…", sub: "", fn: () => {
      const m = modal(`<h3>Reprogramar</h3><div class="grid2"><label class="field"><span>Día</span><input class="inp" type="date" id="mvD" min="${t}" value="${addDays(t, 1)}"></label><label class="field"><span>Hora <span class="faint">opcional</span></span><input class="inp" type="time" id="mvT" step="900" value="${esc(time)}"></label></div><div class="row"><button class="btn ghost" id="mvX">Cancelar</button><button class="btn primary" id="mvOk">Reprogramar</button></div>`, { onClose: () => anchor.isConnected && anchor.focus() });
      m.querySelector("#mvX").onclick = () => m.close();
      m.querySelector("#mvOk").onclick = () => { const d = m.querySelector("#mvD").value; if (!d) return; m.close(); go(d, m.querySelector("#mvT").value); };
    } }]);
}

// ---------- tratos que piden atención: cada uno una vez, con el motivo más grave primero
function attHtml(d) {
  const all = d.attention.deals;
  if (!all.length) return emptyState({ title: d.attention.complete ? "Ningún trato pide atención" : "No se pudieron leer tus tratos", text: d.attention.complete ? `Todos tienen próximo paso al día y se movieron en los últimos ${d.staleDays} días.` : "", compact: true });
  const n = k => d.attention.counts?.[k] ?? all.filter(r => r.why.includes(k)).length, list = F.why ? all.filter(r => r.why.includes(F.why)) : all, shown = list.slice(0, F.att);
  return `<div class="chips ae-filter" role="group" aria-label="Por qué piden atención">${Object.keys(WHY).filter(k => n(k)).map(k => `<button class="chip" data-why="${k}" aria-pressed="${F.why === k}" data-focus-key="why-${k}">${esc(k === "stale" ? `Quietos +${d.staleDays} días` : WHY[k])} <b>${fmtN(n(k))}</b></button>`).join("")}</div>
    <div class="dl-cards">${shown.map(r => `<article class="dl-card ae-deal">
      <button class="dl-open" data-deal="${r.id}">
        <b class="dl-t">${esc(r.title || "Trato sin título")}</b>
        <small>${r.school ? icon("building", "sm") : ""}${esc(r.school ? [r.school.name, r.school.city].filter(Boolean).join(" · ") : r.org?.name || "Sin organización en Pipedrive")}</small>
        <span class="ae-whys">${whyChips(r)}</span>
        ${stageLine(r)}
        ${r.next || r.nextUnknown ? nextHtml(r) : ""}
        ${r.last ? `<small class="dl-last">Última hecha: ${esc(S.types?.[r.last.type] || r.last.type || "actividad")} · ${esc(dayLabel(r.last.date))}</small>` : ""}
      </button>
      <a class="dl-pd" href="${esc(`${d.pdWeb || S.pdWeb}/deal/${r.id}`)}" target="_blank" rel="noopener" title="Abrir en Pipedrive" aria-label="Abrir «${esc(r.title)}» en Pipedrive">${icon("external", "sm")}<span>Pipedrive</span></a>
    </article>`).join("")}</div>
    ${list.length > shown.length ? `<button class="btn ghost sm block" id="aeMoreA" data-focus-key="aeMoreA">Ver ${fmtN(Math.min(30, list.length - shown.length))} más (quedan ${fmtN(list.length - shown.length)})</button>` : ""}
    ${d.attention.more ? `<p class="mx-src">Hay ${fmtN(d.attention.more)} más que no entran acá: están en <a href="#/tratos">Tratos abiertos</a>.</p>` : ""}
    <p class="mx-src" style="margin:10px 0 0">Pipedrive, leído ${esc(ago(d.at))}</p>`;
}
// la ficha: el colegio de la base si la organización está cruzada; si no, la de la organización de Pipedrive
function openDeal(id) {
  const r = D?.attention.deals.find(x => x.id === id); if (!r) return;
  if (r.school && S.byId.has(r.school.id)) return openSchool(r.school.id, { deals: true });
  if (r.org) return openRecord(`org:${r.org.id}`, { deals: true });
  toast("Este trato no tiene organización: abrilo en Pipedrive.", { type: "info", href: `${D.pdWeb || S.pdWeb}/deal/${r.id}`, action: "Abrir en Pipedrive" });
}
