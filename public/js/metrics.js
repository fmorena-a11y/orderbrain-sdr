// Métricas: tablero del período con lo exacto y su fuente. Arriba los indicadores grandes; abajo, tarjetas con barras y tablas.
// Reglas: un número solo se muestra si su definición es exacta; si no se puede saber (o Pipedrive cortó la lista), «?».
// Un SDR ve lo suyo y los totales del equipo; el desglose por persona es de los líderes (rutas …/people, 403 para los demás),
// en orden alfabético y sin puestos. Los cálculos están en lib/metrics.js; las lecturas, en lib/sales.js.
import { S, api, esc, icon, ago, TZ, save, loadPref } from "./core.js";

let host, seq = 0;
const F = { days: [7, 30, 90].includes(loadPref("mx.days", 7)) ? loadPref("mx.days", 7) : 7, country: loadPref("mx.country", "") };
const SECTIONS = ["demos", "deals", "contacts", "base", "clients", "archived"], PEOPLE = ["demos", "deals", "contacts", "archived", "activity"];
// «activity» es solo por persona: la pide solo un líder (las dos rutas dan 403 a los demás)
// lo leído por filtro (volver a la vista lo muestra al instante y se actualiza atrás)
const cache = new Map();
const keyOf = () => `${F.days}|${F.country}`;
let D = { people: {} };

export function renderMetrics(el) {
  host = el;
  D = cache.get(keyOf()) || { people: {} };
  draw();
  load();
}
function load() {
  const my = ++seq, k = keyOf(), q = `?days=${F.days}&country=${encodeURIComponent(F.country)}`, leader = !!S.profile?.leader;
  const prev = cache.get(k), box = prev ? { ...prev, people: { ...prev.people } } : { people: {} }; cache.set(k, box); D = box;
  // cada respuesta va a la caja de SU filtro (si mientras tanto se cambió el filtro, no pisa lo que se ve)
  const done = () => { if (my === seq && host?.isConnected) draw(); };
  for (const s of SECTIONS) api(`/api/metrics/${s}${q}`).then(data => ({ data }), e => ({ error: e.message })).then(r => { if (!(r.error && box[s]?.data)) box[s] = r; done(); });
  if (leader) for (const s of PEOPLE) api(`/api/metrics/${s}/people${q}`).then(data => ({ data }), e => ({ error: e.message })).then(r => { if (!(r.error && box.people[s]?.data)) box.people[s] = r; done(); });
}

// ---------- formato
const fmt = n => n == null || Number.isNaN(n) ? "?" : Number(n).toLocaleString("es-MX");
const dm = d => d ? `${String(d).slice(8, 10)}/${String(d).slice(5, 7)}` : "?";
const hm = iso => { const d = iso ? new Date(iso) : null; return d && !isNaN(d) ? d.toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" }) : ""; };
const dmhm = iso => { const d = iso ? new Date(iso) : null; return d && !isNaN(d) ? `${d.getDate()}/${d.getMonth() + 1} ${hm(iso)}` : "?"; };
const tzName = tz => String(tz || TZ).split("/").pop().replace(/_/g, " ");
const periodTxt = r => r?.period ? `del ${dm(r.period.from)} al ${dm(r.period.to)} (hora de ${tzName(r.tz)})` : "";
const readTxt = iso => iso ? `leído ${ago(iso)} (${hm(iso)})` : "";
const src = (...parts) => `<p class="mx-src">${parts.filter(Boolean).map(esc).join(" · ")}</p>`;
const pname = r => r.auto ? "Entrada automática, sin agendador" : r.free ? "Cuentas generales de Pipedrive" : r.none ? "Sin SDR cargado" : r.inactive ? "Usuario no activo en Pipedrive" : r.name || "?";
const sk = n => '<div class="skel" style="margin:12px 0"></div>'.repeat(n);
const err = (what, e) => `<div class="callout err">${icon("alert")}<span>No pudimos cargar ${what}: ${esc(e)}</span><button class="btn sm" data-mxretry>Reintentar</button></div>`;
const cut = what => `<div class="callout warn" style="margin:6px 0 10px">${icon("alert")}<span>Pipedrive devolvió la lista cortada (${what}): esos números quedan en «?».</span></div>`;
const note = t => `<p class="mx-note">${t}</p>`;
const soon = (title, why) => `<div class="mx-soon"><b>${esc(title)}: próximamente.</b> <span>${esc(why)}</span></div>`;
// barras horizontales de una sola serie (el número al lado, en texto; la barra no lleva color de significado)
function bars(rows, { label = r => r.key, empty = "Ninguno." } = {}) {
  if (!rows?.length) return `<p class="mx-note" style="margin:4px 0 8px">${esc(empty)}</p>`;
  const max = Math.max(1, ...rows.map(r => r.n));
  return `<div class="mx-bars">${rows.map(r => { const l = label(r); return `<div class="mx-bar" title="${esc(l)}: ${fmt(r.n)}"><span class="t">${esc(l)}</span><span class="track" aria-hidden="true"><span class="fill" style="width:${r.n ? Math.max(1.5, r.n / max * 100) : 0}%"></span></span><b>${fmt(r.n)}</b></div>`; }).join("")}</div>`;
}
const mini = items => `<div class="kpis mx-mini">${items.map(([v, l, t]) => `<div class="kpi"${t ? ` title="${esc(t)}"` : ""}><b>${typeof v === "string" ? esc(v) : fmt(v)}</b><span>${esc(l)}</span></div>`).join("")}</div>`;
// tabla por persona (solo líderes): orden alfabético tal cual viene del servidor; las cuentas generales y automáticas al final
function table(cols, rows, first = "Persona") {
  if (!rows?.length) return `<p class="mx-note">Nadie en este período.</p>`;
  return `<div class="follow-wrap"><table class="follow"><thead><tr><th scope="col">${esc(first)}</th>${cols.map(([, l]) => `<th scope="col" class="num">${esc(l)}</th>`).join("")}</tr></thead>
    <tbody>${rows.map(r => `<tr><th scope="row">${esc(pname(r))}</th>${cols.map(([k]) => `<td class="num">${fmt(typeof k === "function" ? k(r) : r[k])}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}
const leaderOnly = '<span class="mx-tag">solo líderes</span>';
const peopleOf = s => D.people[s];
const peopleBlock = (s, fn) => { const p = peopleOf(s); return !S.profile?.leader ? "" : !p ? sk(2) : p.error ? err("el detalle por persona", p.error) : fn(p.data); };

// ---------- indicadores grandes (fila de arriba)
const sum = (o, ...k) => o ? k.reduce((s, x) => s + (o[x] || 0), 0) : null;
function kpis() {
  const d = D.demos?.data, c = D.deals?.data, cl = D.clients?.data, leader = !!S.profile?.leader;
  const pd = (r, k) => r ? `Pipedrive · ${readTxt(k)}` : "";
  const tiles = [
    { l: "Demos cargadas por el equipo", v: d && !d.partial.created ? d.loaded.totals.people : null, wait: !D.demos, sub: d && !d.partial.created ? `creadas en Pipedrive en el período por una persona (Demo y No Show). Aparte: ${fmt(d.loaded.totals.auto)} entradas automáticas${d.loaded.totals.dups ? ` y ${fmt(d.loaded.totals.dups)} duplicadas` : ""}` : "creadas en Pipedrive en el período por una persona (Demo y No Show)", src: pd(d, d?.at.created), mine: !leader && d && !d.partial.created ? `vos: ${fmt(d.loaded.mine?.total || 0)}` : "" },
    { l: "Demos hechas", v: d && !d.partial.held ? sum(d.held.totals, "appDone", "done") : null, wait: !D.demos, sub: "las que tenían fecha en el período (no son las cargadas): hechas en Pipedrive o marcadas «se hizo» en la app", src: pd(d, d?.at.held) },
    { l: "No-show", v: d && !d.partial.held ? sum(d.held.totals, "appNoshow", "noshow") : null, wait: !D.demos, sub: "con fecha en el período, pasadas a «No Show» o marcadas en la app", src: pd(d, d?.at.held) },
    { l: "Tratos ganados", v: c && !c.partial.won ? c.won.n : null, wait: !D.deals, sub: "embudos de venta, ganados por primera vez en el período (sin archivados)", src: pd(c, c?.at), mine: !leader && c && !c.partial.won ? `vos: ${fmt(c.mine.wonOwner)} como dueño · ${fmt(c.mine.wonSdr)} como SDR` : "" },
    { l: "Clientes activos", v: cl?.enabled && !cl.unknown ? cl.activeClients : null, wait: !D.clients, sub: cl && !cl.enabled ? "sin token de World Dominion" : cl?.unknown ? "World Dominion no respondió" : `clientes con al menos un sitio Activo en World Dominion${cl ? ` (${fmt(cl.activeSites)} sitios activos)` : ""}`, src: cl?.enabled && !cl.unknown ? `World Dominion · datos de ${dmhm(cl.at)}${cl.demo ? " (prueba)" : ""}` : "" },
    { l: "Colegios para llamar", v: null, sub: "falta comprobar el cruce con Pipedrive con una muestra revisada a mano", src: "" },
  ];
  return `<section class="mx-kpis" aria-label="Indicadores del período">${tiles.map(t => `<div class="card mx-kpi"><span class="l">${esc(t.l)}</span>
    ${t.wait ? '<div class="skel" style="height:30px;width:70px;margin:4px 0"></div>' : `<b>${fmt(t.v)}</b>`}<small>${esc(t.sub)}</small>${t.mine ? `<small class="mine">${esc(t.mine)}</small>` : ""}${t.src ? `<small class="src">${esc(t.src)}</small>` : ""}</div>`).join("")}</section>`;
}

// ---------- A. Demos
const HELD = [["appDone", "Se hizo (marcado en la app)"], ["done", "Hecha en Pipedrive"], ["appNoshow", "No se presentó (marcado en la app)"], ["noshow", "No Show (tipo en Pipedrive)"],
  ["appCanceled", "Se canceló (marcado en la app)"], ["unmarked", "Sin marcar (ya pasó y no está hecha)"], ["today", "Hoy, sin hora (todavía no se sabe)"], ["upcoming", "Todavía no pasó"]];
function demosCard() {
  const r = D.demos;
  const body = !r ? sk(4) : r.error ? err("las demos", r.error) : (() => {
    const d = r.data, L = d.loaded.totals, H = d.held.totals, A = d.deals, leader = !!S.profile?.leader, pc = d.partial.created, ph = d.partial.held;
    const mineL = d.loaded.mine, mo = d.held.mineOwner, ml = d.held.mineLoader;
    const st = x => x ? `${fmt(sum(x, "appDone", "done"))} hechas, ${fmt(sum(x, "appNoshow", "noshow"))} no-show, ${fmt(x.unmarked)} sin marcar` : "";
    return `${src("Pipedrive", readTxt(d.at.created), periodTxt(d))}
      <h3 class="mx-h">Cargadas en el período</h3>
      ${pc ? cut("demos creadas") : ""}
      ${mini([[pc ? "?" : L.total, "Total"], [pc ? "?" : L.demo, "Demo"], [pc ? "?" : L.noshow, "No Show"], [pc ? "?" : L.preDone, "Cargadas ya hechas", "Se crearon ya marcadas como hechas: se registraron después"], [pc ? "?" : L.auto, "Entradas automáticas", "Las crea una cuenta general (diio, formularios): no tienen agendador"], [pc ? "?" : L.dups, "Duplicadas (no cuentan)", "Otra actividad de la misma demo: mismo trato, mismo día y mismo tipo"]])}
      ${!leader && !pc ? `<p class="mx-mine">Vos cargaste <b>${fmt(mineL?.total || 0)}</b>${mineL ? ` (${fmt(mineL.demo)} Demo, ${fmt(mineL.noshow)} No Show)` : ""}.</p>` : ""}
      ${note(`Por la fecha en que se crearon en Pipedrive. Quién la cargó: la nota «Agendada por … desde OrderBrain SDR» o, si no hay, quien la creó. «Cargadas ya hechas»: se marcaron hechas en el primer minuto desde que se crearon (se registraron después). Una demo cargada dos veces (mismo trato, mismo día y mismo tipo, por ejemplo una entrada automática que repite una ya cargada) cuenta una vez, el día en que se cargó la primera. ${L.auto ? `De las ${fmt(L.auto)} entradas automáticas, ${fmt(L.autoPreDone)} se cargaron ya hechas.` : ""}`)}
      ${peopleBlock("demos", p => `<h4 class="mx-h4">Quién la cargó ${leaderOnly}</h4>${pc ? "" : table([["demo", "Demo"], ["noshow", "No Show"], ["preDone", "Cargadas ya hechas"], ["total", "Total"]], p.loaded)}`)}
      <h3 class="mx-h">Con fecha en el período: qué pasó</h3>
      ${ph ? cut("demos por persona") : bars(HELD.map(([k, l]) => ({ key: l, n: H[k] })).filter(x => x.n), { empty: "No hubo demos con fecha en el período." })}
      ${!ph ? `<p class="mx-note" style="margin-top:0">${fmt(H.total)} en total${H.dups ? ` (sin ${fmt(H.dups)} duplicadas)` : ""}.</p>` : ""}
      ${!leader && !ph ? `<p class="mx-mine">Las que cargaste: <b>${fmt(ml?.total || 0)}</b>${ml ? ` (${st(ml)})` : ""}. Las que diste: <b>${fmt(mo?.total || 0)}</b>${mo ? ` (${st(mo)})` : ""}.</p>` : ""}
      ${peopleBlock("demos", p => ph ? "" : (() => { const cols = [["appDone", "Se hizo (app)"], ["done", "Hecha en Pipedrive"], ["appNoshow", "No se presentó (app)"], ["noshow", "No Show"], ["appCanceled", "Se canceló (app)"], ["unmarked", "Sin marcar"], ["today", "Hoy, sin hora"], ["upcoming", "Todavía no"], ["total", "Total"]];
        return `<h4 class="mx-h4">Por quién la da ${leaderOnly}</h4>${table(cols, p.heldByOwner)}<h4 class="mx-h4">Por quién la cargó ${leaderOnly}</h4>${table(cols, p.heldByLoader)}`; })())}
      ${note("Qué pasó, en este orden: la marca que deja la app, el tipo «No Show», hecha en Pipedrive y, si ya pasó y no está hecha, sin marcar. Cuenta actividades, no colegios: una 2ª reunión cuenta aparte; la misma demo cargada dos veces (mismo trato, día y tipo) cuenta una vez. Incluye las que están a nombre de una cuenta general (van en su fila, al final). Sin hora y con fecha de hoy: «hoy, sin hora» hasta que termine el día. La asistencia (%) no se muestra hasta confirmar que todo no-show se pasa a «No Show».")}
      <h3 class="mx-h">El trato de esas demos, hoy</h3>
      ${ph ? "" : `${mini([[A.won, "Ganados"], [A.lost, "Perdidos"], [A.open, "Abiertos"], [A.unknown, "Demos sin trato (?)", "La demo no tiene trato vinculado en Pipedrive, o no lo encontramos"]])}
      <p class="mx-note" style="margin-top:0">De ${fmt(A.demos)} demos, ${fmt(A.withDeal)} tienen trato (${fmt(A.deals)} tratos distintos). Solo el trato vinculado a la demo en Pipedrive; sin trato, «?».</p>
      ${A.lost ? `<h4 class="mx-h4">Perdidos, por motivo</h4>${bars(A.lostReasons)}` : ""}${A.open ? `<h4 class="mx-h4">Abiertos, por etapa</h4>${bars(A.openStages)}` : ""}`}
      ${src("Tratos", readTxt(d.at.deals))}`;
  })();
  return `<section class="card wide" aria-labelledby="mxA"><div class="card-h"><h2 id="mxA">${icon("video")} Demos</h2><span class="sub">Pipedrive</span></div><div class="card-b">${body}</div></section>`;
}

// ---------- C. Tratos
function mergeDeals(p) {
  const m = new Map(), key = r => r.free ? "free" : r.none ? "none" : r.id ? `u${r.id}` : `n${r.name}`;
  const add = (rows, f) => { for (const r of rows || []) { const x = m.get(key(r)) || { ...r, wonO: 0, wonS: 0, lostO: 0, lostS: 0 }; x[f] += r.n; m.set(key(r), x); } };
  add(p.won.byOwner, "wonO"); add(p.won.bySdr, "wonS"); add(p.lost.byOwner, "lostO"); add(p.lost.bySdr, "lostS");
  return [...m.values()].sort((x, y) => (!!(x.free || x.none)) - (!!(y.free || y.none)) || (!x.name) - (!y.name) || String(x.name).localeCompare(String(y.name), "es", { sensitivity: "base" }));
}
function dealsCard() {
  const r = D.deals;
  const body = !r ? sk(4) : r.error ? err("los tratos", r.error) : (() => {
    const c = r.data, P = c.partial || {}, leader = !!S.profile?.leader, pdDeal = id => S.pdWeb ? `${S.pdWeb}/deal/${id}` : "";
    const lostStages = c.lost.stages.map(s => ({ key: s.key, n: s.n }));
    return `${src("Pipedrive", readTxt(c.at), periodTxt(c))}
      ${P.won || P.lost || P.open ? cut([P.won && "ganados", P.lost && "perdidos", P.open && "abiertos"].filter(Boolean).join(", ")) : ""}
      ${mini([[P.won ? "?" : c.won.n, "Ganados"], [P.lost ? "?" : c.lost.n, "Perdidos"], [P.open ? "?" : c.open.n, "Abiertos hoy"], [P.open ? "?" : c.open.noNext, "Abiertos sin próxima actividad"]])}
      ${!leader ? `<p class="mx-mine">Vos: <b>${fmt(c.mine.wonOwner)}</b> ganados y <b>${fmt(c.mine.lostOwner)}</b> perdidos como dueño; <b>${fmt(c.mine.wonSdr)}</b> y <b>${fmt(c.mine.lostSdr)}</b> en el campo SDR. Abiertos tuyos sin próxima actividad: <b>${fmt(c.mine.noNext)}</b>.</p>` : ""}
      <div class="mx-cols">
        <div><h3 class="mx-h">Ganados, por país</h3>${P.won ? "" : bars(c.won.byCountry, { label: x => x.key === "?" ? "Sin país" : x.key, empty: "Ninguno en el período." })}
          ${peopleBlock("deals", p => p.won.list.length ? `<h4 class="mx-h4">Cuáles ${leaderOnly}</h4><ul class="mx-list">${p.won.list.map(w => `<li>${pdDeal(w.id) ? `<a href="${esc(pdDeal(w.id))}" target="_blank" rel="noopener">${esc(w.title || "Trato " + w.id)}</a>` : esc(w.title)} <small class="faint">${esc(w.country === "?" ? "sin país" : w.country)} · ${dm(w.day)} · dueño ${esc(w.owner || "?")} · SDR ${esc(w.sdr || "sin cargar")}</small></li>`).join("")}</ul>` : "")}</div>
        <div><h3 class="mx-h">Perdidos, por país</h3>${P.lost ? "" : bars(c.lost.byCountry, { label: x => x.key === "?" ? "Sin país" : x.key, empty: "Ninguno en el período." })}</div>
      </div>
      ${P.lost || !c.lost.n ? "" : `<div class="mx-cols"><div><h3 class="mx-h">Perdidos, por motivo</h3>${bars(c.lost.reasons)}${c.lost.freeText ? note("«Texto libre»: el motivo no es uno de la lista de Pipedrive.") : ""}</div>
        <div><h3 class="mx-h">Perdidos, por etapa en la que se perdió</h3>${bars(lostStages)}${note(`${fmt(c.lost.afterProposal)} en propuesta o más adelante · ${fmt(c.lost.beforeProposal)} antes de la propuesta.`)}</div></div>`}
      ${peopleBlock("deals", p => `<h4 class="mx-h4">Ganados y perdidos por persona ${leaderOnly}</h4>${table([["wonO", "Ganados (dueño)"], ["wonS", "Ganados (SDR)"], ["lostO", "Perdidos (dueño)"], ["lostS", "Perdidos (SDR)"]], mergeDeals(p))}`)}
      <h3 class="mx-h">Abiertos hoy, por embudo y etapa</h3>
      ${P.open ? "" : !c.open.pipes.length ? `<p class="mx-note">No hay tratos abiertos en los embudos de venta${F.country ? " de ese país" : ""}.</p>` : `<div class="follow-wrap"><table class="follow"><thead><tr><th scope="col">Embudo</th><th scope="col" class="num">Abiertos</th><th scope="col" class="num">Sin próxima actividad</th><th scope="col">Por etapa</th></tr></thead>
        <tbody>${c.open.pipes.map(p => `<tr><th scope="row">${esc(p.country || "LatAm")}<small>${esc(p.name || "")}</small></th><td class="num">${fmt(p.total)}</td><td class="num">${fmt(p.noNext)}</td><td class="mx-stages">${p.stages.map(s => `<span>${esc(s.name)} <b>${fmt(s.n)}</b></span>`).join("")}</td></tr>`).join("")}</tbody></table></div>`}
      ${peopleBlock("deals", p => P.open || !p.noNext.length ? "" : `<h4 class="mx-h4">Abiertos sin próxima actividad, por dueño ${leaderOnly}</h4>${p.noNext.map(x => `<details class="follow-alert"><summary><b>${esc(pname(x))}</b>: ${fmt(x.n)}</summary><ul>${x.deals.map(t => `<li>${pdDeal(t.id) ? `<a href="${esc(pdDeal(t.id))}" target="_blank" rel="noopener">${esc(t.title || "Trato " + t.id)}</a>` : esc(t.title)}${t.since ? ` <small class="faint">sin cambios desde el ${dm(t.since)}</small>` : ""}</li>`).join("")}${x.n > x.deals.length ? `<li class="faint">y ${fmt(x.n - x.deals.length)} más en Pipedrive</li>` : ""}</ul></details>`).join("")}`)}
      ${soon("Propuestas enviadas en el período", "Pipedrive v2 no guarda el historial de etapas (solo el último cambio) y hay tratos que se crean directo en PROPOSAL SENT. Para que sea exacto hay que leer el historial de cada trato. Mientras tanto, la foto de abiertos por etapa es exacta.")}
      ${note("Embudos de venta: Argentina, Chile, Uruguay, México, Perú y LatAm (en LatAm el país sale del campo País). Ganados y perdidos: los que hoy están así; ganados, por la fecha en que se ganaron por primera vez; perdidos, por su fecha de perdido en Pipedrive (esa fecha se puede editar). No incluye tratos archivados (Pipedrive no los devuelve en esta lectura).")}`;
  })();
  return `<section class="card wide" aria-labelledby="mxC"><div class="card-h"><h2 id="mxC">${icon("deal")} Tratos</h2><span class="sub">Pipedrive</span></div><div class="card-b">${body}</div></section>`;
}

// ---------- D. Contactos registrados desde la app
const CH = [["call", "Llamada"], ["whatsapp", "WhatsApp"], ["mail", "Mail"], ["visit", "Visita"], ["other", "Otro"]];
function contactsCard() {
  const r = D.contacts;
  const body = !r ? sk(3) : r.error ? err("los contactos", r.error) : (() => {
    const c = r.data, T = c.totals, P = c.partial, leader = !!S.profile?.leader;
    return `<div class="callout info" style="margin-bottom:10px">${icon("alert")}<span>Solo lo registrado desde OrderBrain. Lo que se carga directo en Pipedrive no está acá.</span></div>
      ${src("Registro de contactos de la app", `al ${hm(c.at)}`, periodTxt(c))}
      ${P ? `<div class="callout warn" style="margin:6px 0 10px">${icon("alert")}<span>Se guardan los últimos ${fmt(c.max)} contactos y el período empieza antes: los números quedan en «?».</span></div>` : ""}
      ${mini([[P ? "?" : T.n, "Contactos"], [P ? "?" : T.connected, "Conectó"], [P ? "?" : T.demo, "Demo agendada"]])}
      ${!leader && !P ? `<p class="mx-mine">Vos: <b>${fmt(c.mine?.n || 0)}</b> contactos${c.mine ? ` (${fmt(c.mine.connected)} conectó, ${fmt(c.mine.demo)} con demo)` : ""}.</p>` : ""}
      ${P || !T.n ? (T.n || P ? "" : `<p class="mx-note">Nadie registró contactos desde la app en el período.</p>`) : `<h3 class="mx-h">Por canal</h3>${bars(CH.map(([k, l]) => ({ key: l, n: T.channels[k] || 0 })).filter(x => x.n))}<h3 class="mx-h">Por resultado</h3>${bars(c.outcomes, { label: x => x.label })}`}
      ${peopleBlock("contacts", p => P ? "" : `<h4 class="mx-h4">Por persona ${leaderOnly}</h4>${table([["n", "Contactos"], ["connected", "Conectó"], ["demo", "Demo"], ...CH.slice(0, 4).map(([k, l]) => [x => x.channels[k] || 0, l])], p.people)}`)}`;
  })();
  return `<section class="card" aria-labelledby="mxD"><div class="card-h"><h2 id="mxD">${icon("phone")} Contactos desde la app</h2><span class="sub">OrderBrain</span></div><div class="card-b">${body}</div></section>`;
}

// ---------- E. Base de colegios
function baseCard() {
  const r = D.base;
  const body = !r ? sk(3) : r.error ? err("la base", r.error) : (() => {
    const b = r.data, hidden = b.file.total - b.file.shown;
    const rows = F.country ? [...b.cities, ...(b.otherCities ? [{ key: `Otras ${fmt(b.cityCount - b.cities.length)} ciudades`, n: b.otherCities }] : [])] : b.byCountry.slice(0, 12).concat(b.byCountry.length > 12 ? [{ key: `Otros ${b.byCountry.length - 12} países`, n: b.byCountry.slice(12).reduce((s, x) => s + x.n, 0) }] : []);
    return `${src("Base de colegios", b.radarAt ? `radar del ${dmhm(b.radarAt)}` : "radar: sin corridas", b.syncAt ? `último cruce con Pipedrive ${dmhm(b.syncAt)}` : "sin cruce masivo todavía")}
      ${mini([[b.total, F.country ? `Colegios en ${F.country === "?" ? "sin país" : F.country}` : "Colegios en la app"]])}
      ${F.country ? "" : note(`De ${fmt(b.file.total)} en el archivo del radar se muestran ${fmt(b.file.shown)} (${fmt(hidden)} ocultos: públicos o que no son colegios)${b.added ? ` y se sumaron ${fmt(b.added)} con el buscador` : ""}.`)}
      <h3 class="mx-h">${F.country ? "Por ciudad" : "Por país"}</h3>${bars(rows, { label: x => x.key === "?" ? "Sin dato" : x.key })}
      ${soon("Estados (para llamar, en Pipe, clientes, sin revisar)", "dependen del cruce automático con Pipedrive. Los vamos a mostrar, con la fecha del cruce, después de revisar a mano una muestra de cada estado.")}`;
  })();
  return `<section class="card" aria-labelledby="mxE"><div class="card-h"><h2 id="mxE">${icon("building")} Base de colegios</h2><span class="sub">la lista de la app</span></div><div class="card-b">${body}</div></section>`;
}

// ---------- F. Clientes de OrderEAT (World Dominion)
function clientsCard() {
  const r = D.clients;
  const body = !r ? sk(3) : r.error ? err("los clientes", r.error) : (() => {
    const c = r.data;
    if (!c.enabled) return `<div class="callout warn">${icon("alert")}<span>Sin token de World Dominion: no sabemos cuántos clientes hay. Un líder lo carga en Equipo.</span></div>`;
    if (c.unknown) return `<div class="callout err">${icon("alert")}<span>World Dominion no respondió y no hay copia guardada: no sabemos cuántos sitios ni clientes hay («?»).${c.error ? ` ${esc(c.error)}` : ""}</span></div>${mini([["?", "Sitios"], ["?", "Clientes"]])}`;
    return `${src("World Dominion", `datos de ${dmhm(c.at)}${c.stale ? " (copia guardada)" : ""}`, c.demo ? "datos de prueba (modo demo)" : "")}
      ${c.error && c.stale ? `<div class="callout warn" style="margin:6px 0 10px">${icon("alert")}<span>La última lectura falló: son los datos de la copia.</span></div>` : ""}
      ${mini([[c.sites, "Sitios"], [c.clients, "Clientes", c.clients == null ? "Algún sitio no dice de qué cliente es" : "Clientes distintos (por su id en World Dominion)"], [c.activeSites, "Sitios activos"], [c.activeClients, "Clientes activos", c.activeClients == null ? "Algún sitio activo no dice de qué cliente es" : "Con al menos un sitio Activo"]])}
      <h3 class="mx-h">Por estado</h3>${bars(c.byStatus, { empty: "Ningún sitio." })}
      ${F.country ? "" : `<h3 class="mx-h">Por país</h3>${bars(c.byCountry, { label: x => x.key === "?" ? "Sin país" : x.key })}`}
      ${note("Directo de World Dominion, no del cruce con la base: es lo que está cargado hoy, no tiene período.")}
      ${soon("Motivos y fechas de churn", "World Dominion no trae ni fecha ni motivo, y el aviso de Orderito en Slack es texto libre y no siempre llega.")}`;
  })();
  return `<section class="card" aria-labelledby="mxF"><div class="card-h"><h2 id="mxF">${icon("globe")} Clientes de OrderEAT</h2><span class="sub">World Dominion</span></div><div class="card-b">${body}</div></section>`;
}

// ---------- G. Archivados
function archivedCard() {
  const r = D.archived;
  const body = !r ? sk(3) : r.error ? err("los archivados", r.error) : (() => {
    const a = r.data, leader = !!S.profile?.leader;
    return `${src("Registro de archivados de la app", `al ${hm(a.at)}`, periodTxt(a))}
      ${mini([[a.n, "Archivados en el período"], [a.everN, "Desde que se archiva en la app"]])}
      ${a.since ? note(`El registro empieza el ${dmhm(a.since)} (el primer archivado).`) : note("Todavía nadie archivó colegios desde la app.")}
      ${!leader ? `<p class="mx-mine">Vos archivaste <b>${fmt(a.mine?.n || 0)}</b> en el período.</p>` : ""}
      ${a.n ? `<h3 class="mx-h">Por motivo</h3>${bars(a.reasons)}` : ""}
      ${peopleBlock("archived", p => p.people.length ? `<h4 class="mx-h4">Por persona ${leaderOnly}</h4>${table([["n", "Archivados"]], p.people)}` : "")}
      ${note("Cuenta los registros de archivado, no el estado del colegio (un cliente archivado se sigue mostrando como cliente).")}`;
  })();
  return `<section class="card" aria-labelledby="mxG"><div class="card-h"><h2 id="mxG">${icon("archive")} Archivados</h2><span class="sub">OrderBrain</span></div><div class="card-b">${body}</div></section>`;
}

// ---------- B. Actividad por persona (solo líderes): lo cargado en Pipedrive, por dueño y por tipo TAL COMO ESTÁ
// (el tipo no siempre dice el canal: se avisa arriba, fijo). Tres tablas que no se mezclan; orden alfabético, sin puestos.
const apname = r => r.free ? (r.name ? `${r.name} (cuenta general)` : `Cuenta general de Pipedrive (${r.id})`) : r.inactive ? `Usuario no activo en Pipedrive (${r.id})` : r.name || "Sin dueño";
// head: [nombre, title]; un valor de celda puede ser { n, sub }: el número y debajo, chico, qué lo compone
// el aviso de deslizar va en cada tabla pero se muestra solo si de verdad no entra (fitSwipe, después de dibujar)
function actTable(head, rows, cells, total) {
  const td = v => v && typeof v === "object" ? `<td class="num">${fmt(v.n)}${v.sub ? `<small class="mx-sub">${esc(v.sub)}</small>` : ""}</td>` : `<td class="num">${fmt(v)}</td>`;
  return `<p class="mx-swipe" hidden>Deslizá la tabla de costado para ver todas las columnas.</p><div class="follow-wrap"><table class="follow mx-act"><thead><tr><th scope="col">A nombre de</th>${head.map(([l, t]) => `<th scope="col" class="num${l.length > 24 ? " long" : ""}"${t ? ` title="${esc(t)}"` : ""}>${esc(l)}</th>`).join("")}</tr></thead>
    <tbody>${rows.map(r => `<tr><th scope="row">${esc(apname(r))}</th>${cells(r).map(td).join("")}</tr>`).join("")}</tbody>
    <tfoot><tr><th scope="row">Total</th>${total.map(td).join("")}</tr></tfoot></table></div>`;
}
function fitSwipe() { host?.querySelectorAll(".mx-swipe").forEach(p => { const w = p.nextElementSibling; p.hidden = !(w && w.scrollWidth > w.clientWidth + 1); }); }
let swipeObs = null;
function activityCard() {
  const r = peopleOf("activity");
  const body = !r ? sk(4) : r.error ? err("la actividad por persona", r.error) : (() => {
    const a = r.data, P = a.partial || {}, per = periodTxt(a), tz = tzName(a.tz);
    // columnas: los tipos con alguna en las dos primeras tablas (las de cuentas generales van en su columna)
    const cols = a.types.filter(t => a.dated?.byType[t.key] || a.late?.byType[t.key]);
    const head = [...cols.map(t => [t.name + (t.active ? "" : " (desactivado)"), t.known ? `Tipo «${t.name}» en Pipedrive` : "Este tipo no está en la lista de tipos de la cuenta: se muestra su clave"]),
      ["Cargadas por cuentas generales/\u200bautomáticas", "Las creó una cuenta general de Pipedrive, no una persona (por ejemplo, las tareas automáticas de diio). Debajo de cada número, de qué tipo son. Las de Aircall no van acá: van en su columna de tipo."], ["Total"]];
    // las de cuentas generales, con su desglose por tipo debajo del número («Mail 2 · Demo 1»)
    const tname = k => a.types.find(t => t.key === k)?.name || k;
    const autoSub = b => Object.entries(b.autoByType || {}).sort((x, y) => y[1] - x[1] || tname(x[0]).localeCompare(tname(y[0]), "es")).map(([k, n]) => `${tname(k)} ${fmt(n)}`).join(" · ");
    const cells = b => b ? [...cols.map(t => b.byType[t.key] || 0), { n: b.auto, sub: autoSub(b) }, b.total] : [...cols.map(() => null), null, null];
    const aircall = a.types.some(t => /^aircall_/i.test(t.key) && (a.dated?.byType[t.key] || a.late?.byType[t.key]));
    const D1 = a.dated, L = a.late, O = a.overdue;
    return `<div class="callout warn" style="margin-bottom:10px">${icon("alert")}<span>Es lo que cada uno cargó en Pipedrive con ese tipo: si alguien carga un mail como LinkedIn o un WhatsApp como llamada, se cuenta como ese tipo.</span></div>
      ${F.country ? `<div class="callout info" style="margin-bottom:10px">${icon("alert")}<span>El filtro de país no aplica acá: una actividad no dice de qué país es. Se cuenta todo.</span></div>` : ""}
      ${a.typesKnown ? "" : `<div class="callout warn" style="margin-bottom:10px">${icon("alert")}<span>No pudimos leer los nombres de los tipos de la cuenta: cada columna lleva la clave del tipo.</span></div>`}
      ${src("Pipedrive, actividades de toda la cuenta", readTxt(a.at), per)}
      <h3 class="mx-h">Hechas con fecha en el período, por tipo</h3>
      ${P.updated || P.ahead ? cut("actividades hechas") : ""}
      ${actTable(head, a.rows, x => cells(x.dated), cells(D1))}
      ${note(`Actividades marcadas hechas cuya fecha (la de la actividad en Pipedrive, en hora de ${esc(tz)}; si no tiene, el día en que se marcó hecha) cae en el período. Van a nombre del dueño de la actividad, la haya creado quien la haya creado. Una columna por cada tipo con alguna, con el nombre del tipo en Pipedrive. «Cargadas por cuentas generales/automáticas»: las creó una cuenta general de Pipedrive, no una persona (por ejemplo, las tareas automáticas de diio); no están en las columnas de tipo y debajo de cada número dice de qué tipo son.${aircall ? " Las de Aircall van en su columna de tipo aunque las haya creado una cuenta general: Aircall las carga así." : ""} Una marcada hecha antes de su fecha cuenta el día de su fecha.`)}
      <h3 class="mx-h">Cerradas en el período con fecha anterior</h3>
      ${P.updated ? cut("actividades hechas") : ""}
      ${actTable(head, a.rows, x => cells(x.late), cells(L))}
      ${note(`Vencidas de antes del período que se marcaron hechas en el período (por el día en que se marcaron). No están en la tabla de arriba. Las columnas cuentan igual que arriba.${L?.unknown ? ` Además, ${fmt(L.unknown)} hechas no tienen hora de hecha en Pipedrive: no se sabe si se cerraron en el período y no se cuentan.` : ""}`)}
      <h3 class="mx-h">Vencidas sin hacer, hoy</h3>
      ${P.pending ? cut("actividades sin hacer") : ""}
      ${actTable([["Vencidas", "Sin hacer y con fecha anterior a hoy"], ["Vencieron en el período", `De las vencidas, las que tienen fecha del ${dm(a.period?.from)} en adelante`]], a.rows, x => x.overdue ? [x.overdue.n, x.overdue.inPeriod] : [null, null], O ? [O.n, O.inPeriod] : [null, null])}
      ${note(`«Vencidas»: sin hacer y con fecha anterior a hoy (${dm(a.period?.to)}, hora de ${esc(tz)}), de cualquier tipo y de toda la cuenta. Es la foto de ahora. «Vencieron en el período»: de esas, las que tienen fecha del ${dm(a.period?.from)} en adelante.`)}
      ${note("Orden alfabético (con el nombre del perfil de la app); las cuentas generales (cada una en su fila) y los usuarios que ya no están activos en Pipedrive van al final. Aparece quien tiene alguna actividad en estas tablas o usa la app.")}`;
  })();
  return `<section class="card wide" aria-labelledby="mxB"><div class="card-h"><h2 id="mxB">${icon("users")} Actividad por persona</h2><span class="sub">solo lo ven los líderes</span></div><div class="card-b">${body}</div></section>`;
}

// ---------- vista
function countries() {
  const set = new Set([...(S.countries || []), ...Object.keys(S.markets || {})].filter(Boolean));
  return [...set].sort((a, b) => a.localeCompare(b, "es"));
}
function draw() {
  if (!host) return;
  const leader = !!S.profile?.leader, any = D.demos?.data || D.deals?.data;
  const per = any ? periodTxt(any) : "";
  host.innerHTML = `<div class="page mx">
    <div class="page-head"><div><h1>Métricas</h1><p>Lo exacto del período, con su fuente y su hora. «?» es que no se puede saber.</p></div></div>
    <div class="mx-filters">
      <div class="chips" role="group" aria-label="Período">${[7, 30, 90].map(n => `<button class="chip" data-mxd="${n}" aria-pressed="${F.days === n}">${n} días</button>`).join("")}</div>
      <label class="field" style="margin:0"><span>País</span><select class="inp" id="mxCountry"><option value="">Todos</option>${countries().map(c => `<option value="${esc(c)}" ${F.country === c ? "selected" : ""}>${esc(c)}</option>`).join("")}<option value="?" ${F.country === "?" ? "selected" : ""}>Sin país</option></select></label>
    </div>
    <p class="mx-src" style="margin:0 0 14px">${esc(per ? per[0].toUpperCase() + per.slice(1) : "")}${per ? " · " : ""}${leader ? "Ves el total y el detalle por persona (en orden alfabético, para acompañar)." : "Ves tus números y los totales del equipo."}</p>
    ${kpis()}
    <div class="mx-grid">
      ${demosCard()}
      ${leader ? activityCard() : ""}
      ${dealsCard()}
      ${contactsCard()}
      ${archivedCard()}
      ${baseCard()}
      ${clientsCard()}
    </div></div>`;
  host.querySelectorAll("[data-mxd]").forEach(b => b.onclick = () => { F.days = Number(b.dataset.mxd); save("mx.days", F.days); load(); draw(); });
  host.querySelector("#mxCountry").onchange = e => { F.country = e.target.value; save("mx.country", F.country); load(); draw(); };
  host.querySelectorAll("[data-mxretry]").forEach(b => b.onclick = () => { cache.delete(keyOf()); load(); draw(); });
  // el aviso de deslizar: ahora, cuando terminan de cargar las letras y cada vez que cambia el ancho
  fitSwipe(); document.fonts?.ready.then(() => host?.isConnected && fitSwipe());
  if (!swipeObs && window.ResizeObserver) swipeObs = new ResizeObserver(() => host?.isConnected && fitSwipe());
  if (swipeObs) { swipeObs.disconnect(); swipeObs.observe(host); }
}
