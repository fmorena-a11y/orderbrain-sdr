// Métricas: tablero del período con lo exacto y su fuente. Arriba los indicadores grandes; abajo, tarjetas con barras y tablas.
// Reglas: un número solo se muestra si su definición es exacta; si no se puede saber (o Pipedrive cortó la lista), «?».
// Un SDR ve lo suyo y los totales del equipo; el desglose por persona es de los líderes (rutas …/people, 403 para los demás),
// en orden alfabético y sin puestos. Los cálculos están en lib/metrics.js; las lecturas, en lib/sales.js.
// Con equipos, todo es del equipo elegido (dirección: uno o «Toda la cuenta»; un líder: el suyo): el servidor filtra y corta con 403.
// Página larga: arriba una barra fija con las secciones (salta a cada tarjeta y marca la que se está leyendo) y en cada tarjeta las
// definiciones plegadas en «Cómo se cuenta» (cerrado por defecto; lo abierto se mantiene al redibujar).
import { S, api, esc, icon, ago, TZ, save, loadPref, teamSelect, teamView, teamQuery, setTeamView, fmtNum, today } from "./core.js";
import { REL, periodHtml, bindPeriod, pickPeriod, storedPeriod, metricsAccepts } from "./period.js";

let host, seq = 0;
// período: 7, 30 o 90 días hasta hoy, o el mes o el trimestre en curso hasta hoy («mes», «trim»: los objetivos son por mes).
// El selector es el de period.js (el mismo de Equipo › Demos); lo elegido se comparte con Equipo (preferencia «period») y, si
// allá se eligió algo que Métricas no entiende (un mes pasado), queda lo último de acá («mx.days»).
const F = { days: 7, country: loadPref("mx.country", "") };
const syncPeriod = () => { F.days = pickPeriod({ shared: storedPeriod(), own: loadPref("mx.days", 7), accepts: metricsAccepts, fallback: 7, today: today() }); };
syncPeriod();
const SECTIONS = ["demos", "inbound", "deals", "contacts", "base", "clients", "archived"], PEOPLE = ["demos", "inbound", "deals", "contacts", "archived", "activity"];
// Inbound: qué tipo se mira (pestañas; se recuerda)
const INB = [["revival", "SDR revival · Meta Ads"], ["meta", "Meta Ads"], ["google", "Google"], ["organic", "Orgánico"], ["referral", "Referido de padre"], ["other", "Otros inbound"], ["all", "Todos los inbound"]];
let inbKind = INB.some(([k]) => k === loadPref("mx.inb", "revival")) ? loadPref("mx.inb", "revival") : "revival";
// «activity» es solo por persona: la pide solo un líder (las dos rutas dan 403 a los demás)
// lo leído por filtro (volver a la vista lo muestra al instante y se actualiza atrás)
const cache = new Map();
const keyOf = () => `${F.days}|${F.country}|${teamView()}`;
let D = { people: {} };

export function renderMetrics(el) {
  host = el;
  syncPeriod();
  D = cache.get(keyOf()) || { people: {} };
  draw();
  load();
}
function load() {
  const tq = teamQuery(), my = ++seq, k = keyOf(), q = `?days=${F.days}&country=${encodeURIComponent(F.country)}${tq ? "&" + tq : ""}`, leader = !!S.profile?.leader;
  const prev = cache.get(k), box = prev ? { ...prev, people: { ...prev.people } } : { people: {} }; cache.set(k, box); D = box;
  // cada respuesta va a la caja de SU filtro (si mientras tanto se cambió el filtro, no pisa lo que se ve)
  const done = () => { if (my === seq && host?.isConnected) draw(); };
  for (const s of SECTIONS) api(`/api/metrics/${s}${q}`).then(data => ({ data }), e => ({ error: e.message })).then(r => { if (!(r.error && box[s]?.data)) box[s] = r; done(); });
  if (leader) for (const s of PEOPLE) api(`/api/metrics/${s}/people${q}`).then(data => ({ data }), e => ({ error: e.message })).then(r => { if (!(r.error && box.people[s]?.data)) box.people[s] = r; done(); });
}

// ---------- formato
// números con la regla de la app (es-AR, «22.645», «4,5»); lo que no se sabe, «?» (nunca 0)
const fmt = n => fmtNum(n, { none: "?", dec: Number.isInteger(Number(n)) ? 0 : 1 });
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
// «Cómo se cuenta»: cada tarjeta junta sus definiciones (how.push) y las muestra plegadas al final (cerrado por defecto)
const howOpen = new Set();
const howBlock = (key, how) => !how.length ? "" : `<details class="mx-how" data-how="${key}"${howOpen.has(key) ? " open" : ""}><summary>Cómo se cuenta</summary><div class="mx-how-b">${how.map(t => /^<(p|dl|ul)\b/.test(t) ? t : `<p>${t}</p>`).join("")}</div></details>`;
// una tarjeta: id de la sección (para la barra de arriba), título, subtítulo, cuerpo y definiciones
const card = ({ key, ic, title, sub, body, how = [], wide = false }) => `<section class="card${wide ? " wide" : ""} mx-sec" id="mx-s-${key}" data-sec="${key}" aria-labelledby="mx-h-${key}"><div class="card-h"><h2 id="mx-h-${key}">${icon(ic)} ${title}</h2><span class="sub">${sub}</span></div><div class="card-b">${body}${howBlock(key, how)}</div></section>`;
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
const leaderOnly = '<span class="mx-tag">solo líderes y dirección</span>';
const peopleOf = s => D.people[s];
const peopleBlock = (s, fn) => { const p = peopleOf(s); return !S.profile?.leader ? "" : !p ? sk(2) : p.error ? err("el detalle por persona", p.error) : fn(p.data); };

// ---------- indicadores grandes (fila de arriba)
const sum = (o, ...k) => o ? k.reduce((s, x) => s + (o[x] || 0), 0) : null;
// el equipo elegido (lo dice el servidor en cada respuesta); null = sin equipos o toda la cuenta
const teamOf = () => { const sc = (D.demos?.data || D.deals?.data || D.clients?.data)?.scope; return sc?.on && sc.team ? sc.team : null; };
function kpis() {
  const d = D.demos?.data, c = D.deals?.data, cl = D.clients?.data, leader = !!S.profile?.leader;
  // con un equipo elegido, las dos de la derecha no son del equipo: se dice
  const acct = teamOf() ? "de toda la cuenta, no solo del equipo: " : "";
  const pd = (r, k) => r ? `Pipedrive · ${readTxt(k)}` : "";
  // l: qué es; q: qué se cuenta exactamente (visible, corto: cargadas y hechas son dos cosas distintas); sub: un dato aparte
  const tiles = [
    { l: "Demos cargadas", q: "creadas en el período por una persona", v: d && !d.partial.created ? d.loaded.totals.people : null, wait: !D.demos, sub: d && !d.partial.created && (d.loaded.totals.auto || d.loaded.totals.dups) ? `aparte: ${fmt(d.loaded.totals.auto)} entradas automáticas${d.loaded.totals.dups ? ` y ${fmt(d.loaded.totals.dups)} duplicadas` : ""}` : "", src: pd(d, d?.at.created), mine: !leader && d && !d.partial.created ? `vos: ${fmt(d.loaded.mine?.total || 0)}` : "" },
    { l: "Demos hechas", q: "con fecha en el período (no son las cargadas)", v: d && !d.partial.held ? sum(d.held.totals, "appDone", "done") : null, wait: !D.demos, src: pd(d, d?.at.held) },
    { l: "No show", q: "con fecha en el período", v: d && !d.partial.held ? sum(d.held.totals, "appNoshow", "noshow") : null, wait: !D.demos, src: pd(d, d?.at.held) },
    { l: "Tratos ganados", q: "por primera vez en el período", v: c && !c.partial.won ? c.won.n : null, wait: !D.deals, src: pd(c, c?.at), mine: !leader && c && !c.partial.won ? `vos: ${fmt(c.mine.wonOwner)} como dueño · ${fmt(c.mine.wonSdr)} como SDR` : "" },
    { l: "Clientes activos", q: acct + (cl && !cl.enabled ? "sin token de World Dominion" : cl?.unknown ? "World Dominion no respondió" : "con un sitio Activo en World Dominion"), v: cl?.enabled && !cl.unknown ? cl.activeClients : null, wait: !D.clients, sub: cl?.enabled && !cl.unknown ? `${fmt(cl.activeSites)} sitios activos` : "", src: cl?.enabled && !cl.unknown ? `World Dominion · datos de ${dmhm(cl.at)}${cl.demo ? " (prueba)" : ""}` : "" },
    { l: "Colegios para llamar", q: acct + "falta comprobar el cruce con Pipedrive con una muestra revisada a mano", v: null, src: "" },
  ];
  const how = [
    "<b>Demos cargadas</b>: Demo y No show creadas en Pipedrive en el período por una persona. Las entradas automáticas (las crea una cuenta general, como diio) y las duplicadas van aparte.",
    "<b>Demos hechas</b>: no son las cargadas. Son las que tenían fecha en el período y están hechas en Pipedrive o marcadas «se hizo» en la app.",
    "<b>No show</b>: con fecha en el período, pasadas al tipo «No Show» de Pipedrive o marcadas «no se presentó» en la app.",
    "<b>Tratos ganados</b>: embudos de venta, ganados por primera vez en el período (sin archivados).",
    "<b>Clientes activos</b>: clientes con al menos un sitio Activo en World Dominion.",
  ];
  return `<section class="mx-kpis-wrap mx-sec" id="mx-s-top" data-sec="top" aria-label="Indicadores del período"><div class="mx-kpis">${tiles.map(t => `<div class="card mx-kpi"><span class="l">${esc(t.l)}</span>
    ${t.wait ? '<div class="skel" style="height:30px;width:70px;margin:4px 0"></div>' : `<b>${fmt(t.v)}</b>`}<small class="q">${esc(t.q)}</small>${t.sub ? `<small>${esc(t.sub)}</small>` : ""}${t.mine ? `<small class="mine">${esc(t.mine)}</small>` : ""}${t.src ? `<small class="src">${esc(t.src)}</small>` : ""}</div>`).join("")}</div>${howBlock("top", how)}</section>`;
}

// ---------- A. Demos
const HELD = [["appDone", "Se hizo (marcado en la app)"], ["done", "Hecha en Pipedrive"], ["appNoshow", "No se presentó (marcado en la app)"], ["noshow", "No show (tipo en Pipedrive)"],
  ["appCanceled", "Se canceló (marcado en la app)"], ["unmarked", "Sin marcar (ya pasó y no está hecha)"], ["today", "Hoy, sin hora (todavía no se sabe)"], ["upcoming", "Todavía no pasó"]];
function demosCard() {
  const r = D.demos, how = [];
  const body = !r ? sk(4) : r.error ? err("las demos", r.error) : (() => {
    const d = r.data, L = d.loaded.totals, H = d.held.totals, A = d.deals, leader = !!S.profile?.leader, pc = d.partial.created, ph = d.partial.held;
    const mineL = d.loaded.mine, mo = d.held.mineOwner, ml = d.held.mineLoader;
    const st = x => x ? `${fmt(sum(x, "appDone", "done"))} hechas, ${fmt(sum(x, "appNoshow", "noshow"))} no show, ${fmt(x.unmarked)} sin marcar` : "";
    how.push(`<b>Cargadas</b>: por la fecha en que se crearon en Pipedrive. Quién la cargó: la nota «Agendada por … desde OrderBrain SDR» o, si no hay, quien la creó. «Cargadas ya hechas»: se marcaron hechas en el primer minuto desde que se crearon (se registraron después). Una demo cargada dos veces (mismo trato, mismo día y mismo tipo, por ejemplo una entrada automática que repite una ya cargada) cuenta una vez, el día en que se cargó la primera.`);
    how.push(`<b>Qué pasó</b>, en este orden: la marca que deja la app, el tipo «No Show» de Pipedrive, hecha en Pipedrive y, si ya pasó y no está hecha, sin marcar. Cuenta actividades, no colegios: una 2ª reunión cuenta aparte; la misma demo cargada dos veces (mismo trato, día y tipo) cuenta una vez. Incluye las que están a nombre de una cuenta general (van en su fila, al final). Sin hora y con fecha de hoy: «hoy, sin hora» hasta que termine el día. La asistencia (%) no se muestra hasta confirmar que todo no show se pasa a «No Show».`);
    how.push(`<b>El trato de esas demos</b>: solo el trato vinculado a la demo en Pipedrive; sin trato, «?».`);
    how.push(`Por mes o por trimestre, con outbound, inbound y cuántas cuentan para el objetivo de cada SDR (2 inbound = 1 outbound): <a href="#/equipo/demos">Equipo › Demos</a> (la misma regla de qué pasó).`);
    return `${src("Pipedrive", readTxt(d.at.created), periodTxt(d))}
      <h3 class="mx-h">Cargadas en el período</h3>
      ${pc ? cut("demos creadas") : ""}
      ${mini([[pc ? "?" : L.total, "Total"], [pc ? "?" : L.demo, "Demo"], [pc ? "?" : L.noshow, "No show"], [pc ? "?" : L.preDone, "Cargadas ya hechas", "Se crearon ya marcadas como hechas: se registraron después"], [pc ? "?" : L.auto, "Entradas automáticas", "Las crea una cuenta general (diio, formularios): no tienen agendador"], [pc ? "?" : L.dups, "Duplicadas (no cuentan)", "Otra actividad de la misma demo: mismo trato, mismo día y mismo tipo"]])}
      ${!leader && !pc ? `<p class="mx-mine">Vos cargaste <b>${fmt(mineL?.total || 0)}</b>${mineL ? ` (${fmt(mineL.demo)} Demo, ${fmt(mineL.noshow)} No show)` : ""}.</p>` : ""}
      ${L.auto ? note(`De las ${fmt(L.auto)} entradas automáticas, ${fmt(L.autoPreDone)} se cargaron ya hechas.`) : ""}
      ${peopleBlock("demos", p => `<h4 class="mx-h4">Quién la cargó ${leaderOnly}</h4>${pc ? "" : table([["demo", "Demo"], ["noshow", "No show"], ["preDone", "Cargadas ya hechas"], ["total", "Total"]], p.loaded)}`)}
      <h3 class="mx-h">Con fecha en el período: qué pasó</h3>
      ${ph ? cut("demos por persona") : bars(HELD.map(([k, l]) => ({ key: l, n: H[k] })).filter(x => x.n), { empty: "No hubo demos con fecha en el período." })}
      ${!ph ? `<p class="mx-note" style="margin-top:0">${fmt(H.total)} en total${H.dups ? ` (sin ${fmt(H.dups)} duplicadas)` : ""}.</p>` : ""}
      ${!leader && !ph ? `<p class="mx-mine">Las que cargaste: <b>${fmt(ml?.total || 0)}</b>${ml ? ` (${st(ml)})` : ""}. Las que diste: <b>${fmt(mo?.total || 0)}</b>${mo ? ` (${st(mo)})` : ""}.</p>` : ""}
      ${peopleBlock("demos", p => ph ? "" : (() => { const cols = [["appDone", "Se hizo (app)"], ["done", "Hecha en Pipedrive"], ["appNoshow", "No se presentó (app)"], ["noshow", "No show"], ["appCanceled", "Se canceló (app)"], ["unmarked", "Sin marcar"], ["today", "Hoy, sin hora"], ["upcoming", "Todavía no"], ["total", "Total"]];
        return `<h4 class="mx-h4">Por quién la da ${leaderOnly}</h4>${table(cols, p.heldByOwner)}<h4 class="mx-h4">Por quién la cargó ${leaderOnly}</h4>${table(cols, p.heldByLoader)}`; })())}
      <h3 class="mx-h">El trato de esas demos, hoy</h3>
      ${ph ? "" : `${mini([[A.won, "Ganados"], [A.lost, "Perdidos"], [A.open, "Abiertos"], [A.unknown, "Demos sin trato (?)", "La demo no tiene trato vinculado en Pipedrive, o no lo encontramos"]])}
      <p class="mx-note" style="margin-top:0">De ${fmt(A.demos)} demos, ${fmt(A.withDeal)} tienen trato (${fmt(A.deals)} tratos distintos).</p>
      ${A.lost ? `<h4 class="mx-h4">Perdidos, por motivo</h4>${bars(A.lostReasons)}` : ""}${A.open ? `<h4 class="mx-h4">Abiertos, por etapa</h4>${bars(A.openStages)}` : ""}`}
      ${src("Tratos", readTxt(d.at.deals))}`;
  })();
  return card({ key: "demos", ic: "video", title: "Demos", sub: "Pipedrive", body, how, wide: true });
}

// ---------- H. Inbound (pedido del líder de SDR): prospectos y tratos de Pipedrive con Fuente inbound que entraron en el período
// y qué pasó con cada uno. Cada número con su definición al lado; lo que no se sabe, «?».
const pct = (n, d) => n == null || !d ? "" : `${Math.round(n / d * 100)}%`;
const hrs = h => h == null ? "?" : h < 1 ? "menos de 1 h" : h < 48 ? `${fmt(Math.round(h * 10) / 10)} h` : `${fmt(Math.round(h / 24 * 10) / 10)} días`;
// una fila del embudo: número, % (y de qué) y qué cuenta; base: el total del que sale el %; bar: dibuja la barra.
// La definición va al pasar el mouse y en «Cómo se cuenta» (defs: la lista de la tarjeta).
function frow(n, label, def, { base = null, of = "", sub = false, bar = false, defs = null } = {}) {
  const p = base ? pct(n, base) : "";
  defs?.push([label, def]);
  return `<div class="mx-fr${sub ? " sub" : ""}"><b>${fmt(n)}</b><span class="pct">${p}${p && of ? `<small>${esc(of)}</small>` : ""}</span>
    <span class="lab" title="${esc(def)}">${esc(label)}${bar && p ? `<span class="bar" aria-hidden="true"><span style="width:${Math.max(1, Math.min(100, n / base * 100))}%"></span></span>` : ""}</span></div>`;
}
const pdLink = (p) => !S.pdWeb ? "" : p.rec === "lead" ? `${S.pdWeb}/leads/inbox/${p.id}` : `${S.pdWeb}/deal/${p.id}`;
function inboundCard() {
  const r = D.inbound, how = [], defs = [];
  const body = !r ? sk(5) : r.error ? err("los inbound", r.error) : (() => {
    const d = r.data, P = d.partial || {}, x = d.kinds?.[inbKind], T = x?.totals, leader = !!S.profile?.leader, kn = d.known || {};
    const fuente = { revival: d.fuente?.revival, meta: d.fuente?.meta, google: d.fuente?.google, organic: d.fuente?.organic, referral: d.fuente?.referral };
    const what = inbKind === "all" ? "con cualquier Fuente «Inbound - …»" : inbKind === "other" ? "con otra Fuente «Inbound - …» (referido de colegio o de cafetería, alianza, nota de prensa…)" : `con la Fuente «${fuente[inbKind] || "?"}»`;
    const cutTxt = [P.leads && "prospectos", P.deals && "tratos", P.acts && "actividades", P.demos && "demos"].filter(Boolean).join(", ");
    const tabs = `<div class="chips mx-kinds" role="group" aria-label="Tipo de inbound">${INB.map(([k, l]) => { const n = d.kinds?.[k]?.totals?.entries;
      return `<button class="chip" data-inb="${k}" aria-pressed="${inbKind === k}">${esc(l)}${n != null ? ` · ${fmt(n)}` : ""}</button>`; }).join("")}</div>`;
    if (!T) return tabs;
    const E = T.entries, C = T.contacted, Dm = T.demo, mine = !leader ? x.mine : null, back = x.back || {};
    const funnel = `<div class="mx-funnel">
      ${frow(E, "Entraron", `Prospectos y tratos ${what} que entraron en el período: ${fmt(T.leads)} prospectos y ${fmt(T.deals)} tratos (un prospecto convertido cuenta una vez, como trato, el día en que se creó el prospecto).`, { defs })}
      ${frow(C, "Contactados", "Con al menos una llamada, WhatsApp o mail marcado hecho en el prospecto o en su trato (también las llamadas de Aircall).", { base: E, of: "de entradas", bar: true, defs })}
      ${frow(T.answered, "Contestaron", `Algún contacto con resultado «atendió» (lo que se elige en Registrar, o Aircall atendida) o una demo agendada${T.answeredDemo ? ` (${fmt(T.answeredDemo)} solo por la demo)` : ""}.`, { base: C, of: "de contactados", sub: true, defs })}
      ${frow(T.noanswer, "No contestaron", "Todos los resultados registrados son «No atendió» (Registrar) o llamadas de Aircall sin respuesta, y no hay demo.", { base: C, of: "de contactados", sub: true, defs })}
      ${T.bad ? frow(T.bad, "Dato erróneo", "Solo «Dato erróneo» en Registrar: teléfono equivocado o no existe.", { base: C, of: "de contactados", sub: true, defs }) : ""}
      ${frow(T.noResult, "Sin resultado registrado", "Contactos cargados a mano en Pipedrive: no dicen si atendieron. No se cuentan como «no contestó».", { base: C, of: "de contactados", sub: true, defs })}
      ${frow(T.notContacted, "Sin contactar todavía", "Ninguna llamada, WhatsApp ni mail hecho todavía.", { base: E, of: "de entradas", bar: true, defs })}
      ${frow(Dm, "Demo agendada", "Alguna Demo o No Show en el prospecto o en su trato (hasta 15 días adelante).", { base: E, of: "de entradas", bar: true, defs })}
      ${frow(T.demoDone, "Demo hecha", "Marcada «se hizo» en la app o hecha en Pipedrive (la regla de Equipo › Demos).", { base: Dm, of: "de agendadas", sub: true, defs })}
      ${frow(T.noshow, "No show", "Pasada a «No Show» o marcada «no se presentó», y ninguna hecha.", { base: Dm, of: "de agendadas", sub: true, defs })}
      ${frow(T.deals, "Pasaron a trato", "Tratos de los embudos de venta (entraron como trato o se convirtió el prospecto).", { base: E, of: "de entradas", bar: true, defs })}
      ${frow(T.won, "Ganados", "Como están hoy en Pipedrive.", { base: E, of: "de entradas", sub: true, defs })}
      ${frow(T.lost, "Perdidos", "Como están hoy en Pipedrive (motivos abajo).", { base: E, of: "de entradas", sub: true, defs })}
      ${frow(T.open, "Abiertos", "Tratos abiertos hoy.", { base: E, of: "de entradas", sub: true, defs })}
      ${frow(T.leadOpen, "Siguen como prospecto", `Prospectos abiertos hoy${T.leadArchived ? `; además ${fmt(T.leadArchived)} ${T.leadArchived === 1 ? "archivado" : "archivados"}` : ""}.`, { base: E, of: "de entradas", defs })}
    </div>`;
    const conv = E ? `<p class="mx-conv">De ${fmt(E)} que entraron: <b>${pct(C, E) || "?"}</b> contactados · <b>${pct(T.answered, E) || "?"}</b> contestaron · <b>${pct(Dm, E) || "?"}</b> con demo · <b>${pct(T.demoDone, E) || "?"}</b> con demo hecha · <b>${pct(T.won, E) || "?"}</b> ganados.</p>` : "";
    return `${src("Pipedrive: prospectos y tratos con Fuente inbound", readTxt(d.at?.leads), periodTxt(d))}
      ${tabs}
      ${cutTxt ? cut(cutTxt) : ""}
      ${mini([[E, "Entraron"], [C, "Contactados"], [T.answered, "Contestaron"], [Dm, "Con demo"], [T.won, "Ganados"], [T.ttfHours == null ? "?" : hrs(T.ttfHours), "Hasta el 1er contacto", "Mediana: desde que entró hasta que se marcó hecho el primer contacto"]])}
      ${mine ? `<p class="mx-mine">Lo tuyo (SDR o dueño): <b>${fmt(mine.entries)}</b> entraron, <b>${fmt(mine.contacted)}</b> contactados, <b>${fmt(mine.demo)}</b> con demo, <b>${fmt(mine.won)}</b> ganados.</p>` : ""}
      ${!E ? `<p class="mx-note">No entró ninguno ${what} en el período.</p>` : funnel + conv}
      ${T.ttfN ? (how.push(`<b>Hasta el primer contacto</b>: la mediana de ${fmt(T.ttfN)} contactados, desde que entró hasta que se marcó hecha la primera llamada, WhatsApp o mail. Es cuando se marcó hecha en Pipedrive, no la hora exacta de la llamada.`), "") : ""}
      ${T.earlier ? note(`${T.earlier === 1 ? "1 ya tenía contactos" : `${fmt(T.earlier)} ya tenían contactos`} de antes de entrar (estaba${T.earlier === 1 ? "" : "n"} en Pipedrive como otro prospecto o trato y Pipedrive le${T.earlier === 1 ? "" : "s"} pasó las actividades): cuenta${T.earlier === 1 ? "" : "n"} como entrada${T.earlier === 1 ? "" : "s"} y contactado${T.earlier === 1 ? "" : "s"}, pero no en la mediana.`) : ""}
      ${T.lost ? `<h3 class="mx-h">Perdidos, por motivo</h3>${bars(x.lostReasons)}` : ""}
      ${peopleBlock("inbound", p => { const k = p.kinds?.[inbKind]; if (!k) return "";
        return `<h4 class="mx-h4">Por persona ${leaderOnly}</h4>${table([["entries", "Entraron"], ["contacted", "Contactados"], ["answered", "Contestaron"], ["noanswer", "No contestaron"], ["noResult", "Sin resultado"], ["notContacted", "Sin contactar"], ["demo", "Demo"], ["demoDone", "Demo hecha"], ["won", "Ganados"], ["lost", "Perdidos"], [z => z.ttfHours, "1er contacto (h)"]], k.people)}
          ${(how.push("<b>Por persona</b>: la del campo SDR; si está vacío, el dueño" + (T.ownerAsSdr ? ` (${fmt(T.ownerAsSdr)} sin SDR cargado)` : "") + ". «1er contacto (h)»: mediana de horas hasta el primer contacto."), "")}
          ${k.pending.length ? `<details class="follow-alert"><summary><b>Sin contactar todavía</b>: ${fmt(T.notContacted)}${T.notContacted > k.pending.length ? ` (los ${fmt(k.pending.length)} más viejos)` : ""}</summary><ul>${k.pending.map(q => `<li>${pdLink(q) ? `<a href="${esc(pdLink(q))}" target="_blank" rel="noopener">${esc(q.title || (q.rec === "lead" ? "Prospecto" : "Trato " + q.id))}</a>` : esc(q.title)} <small class="faint">${q.rec === "lead" ? "prospecto" : "trato"} · entró el ${dm(q.day)} · ${esc(q.free ? "cuenta general" : q.person || "?")}${q.demo ? " · tiene demo" : ""}</small></li>`).join("")}</ul></details>` : ""}`; })}
      ${back.n ? note(`Además, ${back.n === 1 ? "1 prospecto" : `${fmt(back.n)} prospectos`} ${inbKind === "all" ? "inbound" : "de este tipo"} ${back.n === 1 ? "volvió" : "volvieron"} de un trato al Buzón en el período (en Pipedrive: «convertir en prospecto»). No son entradas nuevas y no están arriba; ${back.contacted == null ? "?" : fmt(back.contacted)} con un contacto después de volver.`) : ""}
      ${d.noFuente ? note(`${d.noFuente === 1 ? "1 prospecto o trato entró" : `${fmt(d.noFuente)} prospectos y tratos entraron`} sin Fuente en el período: no se sabe si son inbound y no están acá. Se suman cuando les carguen la Fuente.`) : ""}
      ${T.mixed ? note(`${T.mixed === 1 ? "1 tiene" : `${fmt(T.mixed)} tienen`} también una Fuente outbound: cuenta${T.mixed === 1 ? "" : "n"} acá igual.`) : ""}
      ${d.unknownEntry ? note(`${d.unknownEntry === 1 ? "1 trato inbound viene" : `${fmt(d.unknownEntry)} tratos inbound vienen`} de un prospecto cuya fecha no se pudo saber: no se cuenta${d.unknownEntry === 1 ? "" : "n"}.`) : ""}
`;
  })();
  if (defs.length) how.unshift(`<dl class="mx-defs">${defs.map(([l, t]) => `<dt>${esc(l)}</dt><dd>${esc(t)}</dd>`).join("")}</dl>`);
  if (r?.data) how.push("Fuente de verdad: Pipedrive (lo cargado por la app o a mano). Un tipo por opción de la Fuente; uno con dos opciones inbound va en las dos pestañas y una vez en «Todos». Los prospectos archivados cuentan; los tratos archivados no los devuelve Pipedrive en esta lectura. El país no aplica acá.");
  return card({ key: "inbound", ic: "bolt", title: "Inbound", sub: "Pipedrive", body, how, wide: true });
}

// ---------- C. Tratos
function mergeDeals(p) {
  const m = new Map(), key = r => r.free ? "free" : r.none ? "none" : r.id ? `u${r.id}` : `n${r.name}`;
  const add = (rows, f) => { for (const r of rows || []) { const x = m.get(key(r)) || { ...r, wonO: 0, wonS: 0, lostO: 0, lostS: 0 }; x[f] += r.n; m.set(key(r), x); } };
  add(p.won.byOwner, "wonO"); add(p.won.bySdr, "wonS"); add(p.lost.byOwner, "lostO"); add(p.lost.bySdr, "lostS");
  return [...m.values()].sort((x, y) => (!!(x.free || x.none)) - (!!(y.free || y.none)) || (!x.name) - (!y.name) || String(x.name).localeCompare(String(y.name), "es", { sensitivity: "base" }));
}
function dealsCard() {
  const r = D.deals, how = [];
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
      ${P.lost || !c.lost.n ? "" : `<div class="mx-cols"><div><h3 class="mx-h">Perdidos, por motivo</h3>${bars(c.lost.reasons)}${c.lost.freeText ? (how.push("«Texto libre»: el motivo de pérdida no es uno de la lista de Pipedrive."), "") : ""}</div>
        <div><h3 class="mx-h">Perdidos, por etapa en la que se perdió</h3>${bars(lostStages)}${note(`${fmt(c.lost.afterProposal)} en propuesta o más adelante · ${fmt(c.lost.beforeProposal)} antes de la propuesta.`)}</div></div>`}
      ${peopleBlock("deals", p => `<h4 class="mx-h4">Ganados y perdidos por persona ${leaderOnly}</h4>${table([["wonO", "Ganados (dueño)"], ["wonS", "Ganados (SDR)"], ["lostO", "Perdidos (dueño)"], ["lostS", "Perdidos (SDR)"]], mergeDeals(p))}`)}
      <h3 class="mx-h">Abiertos hoy, por embudo y etapa</h3>
      ${P.open ? "" : !c.open.pipes.length ? `<p class="mx-note">No hay tratos abiertos en los embudos de venta${F.country ? " de ese país" : ""}.</p>` : `<div class="follow-wrap"><table class="follow"><thead><tr><th scope="col">Embudo</th><th scope="col" class="num">Abiertos</th><th scope="col" class="num">Sin próxima actividad</th><th scope="col">Por etapa</th></tr></thead>
        <tbody>${c.open.pipes.map(p => `<tr><th scope="row">${esc(p.country || "LatAm")}<small>${esc(p.name || "")}</small></th><td class="num">${fmt(p.total)}</td><td class="num">${fmt(p.noNext)}</td><td class="mx-stages">${p.stages.map(s => `<span>${esc(s.name)} <b>${fmt(s.n)}</b></span>`).join("")}</td></tr>`).join("")}</tbody></table></div>`}
      ${peopleBlock("deals", p => P.open || !p.noNext.length ? "" : `<h4 class="mx-h4">Abiertos sin próxima actividad, por dueño ${leaderOnly}</h4>${p.noNext.map(x => `<details class="follow-alert"><summary><b>${esc(pname(x))}</b>: ${fmt(x.n)}</summary><ul>${x.deals.map(t => `<li>${pdDeal(t.id) ? `<a href="${esc(pdDeal(t.id))}" target="_blank" rel="noopener">${esc(t.title || "Trato " + t.id)}</a>` : esc(t.title)}${t.since ? ` <small class="faint">sin cambios desde el ${dm(t.since)}</small>` : ""}</li>`).join("")}${x.n > x.deals.length ? `<li class="faint">y ${fmt(x.n - x.deals.length)} más en Pipedrive</li>` : ""}</ul></details>`).join("")}`)}
      ${soon("Propuestas enviadas en el período", "Todavía no se pueden contar exactas: el porqué está en «Cómo se cuenta».")}`;
  })();
  how.push("Embudos de venta: Argentina, Chile, Uruguay, México, Perú y LatAm (en LatAm el país sale del campo País). Ganados y perdidos: los que hoy están así; ganados, por la fecha en que se ganaron por primera vez; perdidos, por su fecha de perdido en Pipedrive (esa fecha se puede editar). No incluye tratos archivados (Pipedrive no los devuelve en esta lectura).");
  how.push("<b>Propuestas enviadas, próximamente</b>: Pipedrive v2 no guarda el historial de etapas (solo el último cambio) y hay tratos que se crean directo en PROPOSAL SENT. Para que sea exacto hay que leer el historial de cada trato. Mientras tanto, la foto de abiertos por etapa es exacta.");
  return card({ key: "deals", ic: "deal", title: "Tratos", sub: "Pipedrive", body, how, wide: true });
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
  return card({ key: "contacts", ic: "phone", title: "Contactos desde la app", sub: "OrderBrain", body, how: ["Cuenta los contactos registrados desde OrderBrain, por el día en que se registraron (en tu hora). Lo que se carga directo en Pipedrive no está acá. «Conectó» y «Demo agendada» salen del resultado que se eligió al registrar."] });
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
`;
  })();
  const how = ["La lista de colegios de la app (el archivo del radar, sin públicos ni lo que no es colegio, más lo que se sumó con el buscador). No tiene período: es lo que hay hoy.",
    "<b>Estados, próximamente</b> (para llamar, en Pipe, clientes, sin revisar): dependen del cruce automático con Pipedrive. Los vamos a mostrar, con la fecha del cruce, después de revisar a mano una muestra de cada estado."];
  return card({ key: "base", ic: "building", title: "Base de colegios", sub: `la lista de la app${S.profile?.scope?.on ? " · de toda la cuenta" : ""}`, body, how });
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
`;
  })();
  const how = ["Directo de World Dominion, no del cruce con la base: es lo que está cargado hoy, no tiene período. «Clientes»: distintos, por su id en World Dominion; «Clientes activos»: con al menos un sitio Activo.",
    "<b>Motivos y fechas de churn, próximamente</b>: World Dominion no trae ni fecha ni motivo, y el aviso de Orderito en Slack es texto libre y no siempre llega."];
  return card({ key: "clients", ic: "globe", title: "Clientes de OrderEAT", sub: `World Dominion${S.profile?.scope?.on ? " · de toda la cuenta" : ""}`, body, how });
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
`;
  })();
  return card({ key: "archived", ic: "archive", title: "Archivados", sub: "OrderBrain", body, how: ["Cuenta los registros de archivado de la app, no el estado del colegio (un cliente archivado se sigue mostrando como cliente)."] });
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
  const r = peopleOf("activity"), how = [];
  const body = !r ? sk(4) : r.error ? err("la actividad por persona", r.error) : (() => {
    const a = r.data, P = a.partial || {}, per = periodTxt(a), tz = tzName(a.tz), team = a.scope?.on && a.scope.team ? a.scope.team : null;
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
      ${src(team ? `Pipedrive, actividades de la gente de ${team.name} (no solo las de la app)` : "Pipedrive, actividades de toda la cuenta", readTxt(a.at), per)}
      <h3 class="mx-h">Hechas con fecha en el período, por tipo</h3>
      ${P.updated || P.ahead ? cut("actividades hechas") : ""}
      ${actTable(head, a.rows, x => cells(x.dated), cells(D1))}
      ${(how.push(`<b>Hechas con fecha en el período</b>: actividades marcadas hechas cuya fecha (la de la actividad en Pipedrive, en hora de ${esc(tz)}; si no tiene, el día en que se marcó hecha) cae en el período. Van a nombre del dueño de la actividad, la haya creado quien la haya creado. Una columna por cada tipo con alguna, con el nombre del tipo en Pipedrive. «Cargadas por cuentas generales/automáticas»: las creó una cuenta general de Pipedrive, no una persona (por ejemplo, las tareas automáticas de diio); no están en las columnas de tipo y debajo de cada número dice de qué tipo son.${aircall ? " Las de Aircall van en su columna de tipo aunque las haya creado una cuenta general: Aircall las carga así." : ""} Una marcada hecha antes de su fecha cuenta el día de su fecha.`), "")}
      <h3 class="mx-h">Cerradas en el período con fecha anterior</h3>
      ${P.updated ? cut("actividades hechas") : ""}
      ${actTable(head, a.rows, x => cells(x.late), cells(L))}
      ${(how.push(`<b>Cerradas en el período con fecha anterior</b>: vencidas de antes del período que se marcaron hechas en el período (por el día en que se marcaron). No están en la tabla de arriba. Las columnas cuentan igual que arriba.${L?.unknown ? ` Además, ${fmt(L.unknown)} hechas no tienen hora de hecha en Pipedrive: no se sabe si se cerraron en el período y no se cuentan.` : ""}`), "")}
      <h3 class="mx-h">Vencidas sin hacer, hoy</h3>
      ${P.pending ? cut("actividades sin hacer") : ""}
      ${actTable([["Vencidas", "Sin hacer y con fecha anterior a hoy"], ["Vencieron en el período", `De las vencidas, las que tienen fecha del ${dm(a.period?.from)} en adelante`]], a.rows, x => x.overdue ? [x.overdue.n, x.overdue.inPeriod] : [null, null], O ? [O.n, O.inPeriod] : [null, null])}
      ${(how.push(`<b>Vencidas</b>: sin hacer y con fecha anterior a hoy (${dm(a.period?.to)}, hora de ${esc(tz)}), de cualquier tipo y ${team ? `de la gente de ${esc(team.name)}` : "de toda la cuenta"}. Es la foto de ahora. «Vencieron en el período»: de esas, las que tienen fecha del ${dm(a.period?.from)} en adelante.`), "")}
      ${(how.push("Orden alfabético (con el nombre del perfil de la app); las cuentas generales (cada una en su fila) y los usuarios que ya no están activos en Pipedrive van al final. Aparece quien tiene alguna actividad en estas tablas o usa la app."), "")}`;
  })();
  return card({ key: "activity", ic: "users", title: "Actividad por persona", sub: "solo lo ven los líderes y dirección", body, how, wide: true });
}

// ---------- vista
function countries() {
  const set = new Set([...(S.countries || []), ...Object.keys(S.markets || {})].filter(Boolean));
  return [...set].sort((a, b) => a.localeCompare(b, "es"));
}
// la barra fija de secciones (en el orden de la página); activity solo para líderes
const NAV = [["top", "Resumen"], ["demos", "Demos"], ["inbound", "Inbound"], ["activity", "Actividad"], ["deals", "Tratos"], ["contacts", "Contactos"], ["archived", "Archivados"], ["base", "Base"], ["clients", "Clientes"]];
// navPin: la elegida con la barra queda marcada hasta que la persona mueva la página (rueda, dedo o teclado): al final de la
// página la tarjeta elegida puede no llegar arriba
let navActive = "top", navPin = "", navBound = false;
const navHtml = leader => `<nav class="mx-nav" aria-label="Secciones de Métricas"><div class="mx-nav-in">${NAV.filter(([k]) => leader || k !== "activity").map(([k, l]) => `<button type="button" data-nav="${k}"${navActive === k ? ' aria-current="true"' : ""}>${l}</button>`).join("")}</div></nav>`;
function setActive(k) {
  if (!host?.isConnected) return;
  navActive = k;
  const nav = host.querySelector(".mx-nav-in"); if (!nav) return;
  nav.querySelectorAll("[data-nav]").forEach(b => { if (b.dataset.nav === k) b.setAttribute("aria-current", "true"); else b.removeAttribute("aria-current"); });
  // la elegida siempre a la vista en la barra (en el celular se desliza)
  const b = nav.querySelector(`[data-nav="${k}"]`);
  if (b && (b.offsetLeft < nav.scrollLeft || b.offsetLeft + b.offsetWidth > nav.scrollLeft + nav.clientWidth)) nav.scrollLeft = Math.max(0, b.offsetLeft - 24);
}
// la sección que se está leyendo: la última cuyo borde de arriba ya pasó debajo de la barra (dos tarjetas lado a lado: la primera)
function spy() {
  const main = document.getElementById("main"), nav = host?.isConnected && host.querySelector(".mx-nav");
  if (!main || !nav || navPin) return;
  const y = nav.getBoundingClientRect().bottom + 24, secs = [...host.querySelectorAll(".mx-sec")];
  if (!secs.length) return;
  let pick = secs[0], top = -Infinity;
  for (const el of secs) { const t = Math.round(el.getBoundingClientRect().top); if (t <= y && t > top) { top = t; pick = el; } }
  // al final de la página, la última que se ve entera
  if (main.scrollTop + main.clientHeight >= main.scrollHeight - 4) { const vis = secs.filter(el => el.getBoundingClientRect().top < innerHeight - 40); if (vis.length) pick = vis.filter(el => Math.round(el.getBoundingClientRect().top) === Math.round(vis.at(-1).getBoundingClientRect().top))[0]; }
  if (pick.dataset.sec !== navActive) setActive(pick.dataset.sec);
}
function draw() {
  if (!host) return;
  const leader = !!S.profile?.leader, any = D.demos?.data || D.deals?.data;
  const per = any ? periodTxt(any) : "";
  // de qué equipo son los números (lo dice el servidor en cada respuesta)
  const sc = any?.scope, who = !sc?.on ? "" : sc.team ? `Equipo ${sc.team.name}: totales y personas solo de su gente (base de colegios, clientes y colegios para llamar son de toda la cuenta).` : "Toda la cuenta: también la gente sin equipo y las cuentas generales, por eso no es la suma de los equipos.";
  const navX = host.querySelector(".mx-nav-in")?.scrollLeft || 0;
  host.innerHTML = `<div class="page mx">
    <div class="page-head"><div><h1>Métricas</h1><p>Lo exacto del período, con su fuente y su hora. «?» es que no se puede saber.</p></div></div>
    <div class="mx-filters">
      ${periodHtml({ id: "mxPer", value: F.days, rel: REL.map(([k]) => k), today: today() })}
      ${teamSelect("mxTeam")}
      <label class="field" style="margin:0"><span>País</span><select class="inp" id="mxCountry"><option value="">Todos</option>${countries().map(c => `<option value="${esc(c)}" ${F.country === c ? "selected" : ""}>${esc(c)}</option>`).join("")}<option value="?" ${F.country === "?" ? "selected" : ""}>Sin país</option></select></label>
    </div>
    <p class="mx-src" style="margin:0 0 14px">${esc(per ? per[0].toUpperCase() + per.slice(1) : "")}${per ? " · " : ""}${who ? esc(who) + " " : ""}${leader ? "Ves el total y el detalle por persona (en orden alfabético, para acompañar)." : "Ves tus números y los totales del equipo."}</p>
    ${navHtml(leader)}
    ${kpis()}
    <div class="mx-grid">
      ${demosCard()}
      ${inboundCard()}
      ${leader ? activityCard() : ""}
      ${dealsCard()}
      ${contactsCard()}
      ${archivedCard()}
      ${baseCard()}
      ${clientsCard()}
    </div></div>`;
  const nv = host.querySelector(".mx-nav-in"); if (nv) nv.scrollLeft = navX;
  bindPeriod(host, "mxPer", v => { F.days = v; save("mx.days", v); load(); draw(); }, today());
  host.querySelector("#mxCountry").onchange = e => { F.country = e.target.value; save("mx.country", F.country); load(); draw(); };
  host.querySelector("#mxTeam")?.addEventListener("change", e => { setTeamView(e.target.value); D = cache.get(keyOf()) || { people: {} }; load(); draw(); });
  host.querySelectorAll("[data-inb]").forEach(b => b.onclick = () => { inbKind = b.dataset.inb; save("mx.inb", inbKind); draw(); });
  host.querySelectorAll("[data-mxretry]").forEach(b => b.onclick = () => { cache.delete(keyOf()); load(); draw(); });
  // «Cómo se cuenta»: lo abierto sigue abierto cuando llegan los datos y se redibuja
  host.querySelectorAll("details[data-how]").forEach(d => d.addEventListener("toggle", () => { if (d.open) howOpen.add(d.dataset.how); else howOpen.delete(d.dataset.how); }));
  // barra de secciones: salta a la tarjeta (sin tocar el hash: es la ruta de la app) y marca la que se lee al hacer scroll
  host.querySelectorAll("[data-nav]").forEach(b => b.onclick = () => {
    const el = host.querySelector(`#mx-s-${b.dataset.nav}`); if (!el) return;
    navPin = b.dataset.nav; setActive(b.dataset.nav);
    el.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
    const h = el.querySelector("h2"); if (h) { h.setAttribute("tabindex", "-1"); h.focus({ preventScroll: true }); }
  });
  const main = document.getElementById("main");
  if (main && !navBound) {
    navBound = true; let raf = 0;
    main.addEventListener("scroll", () => { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; spy(); }); }, { passive: true });
    const unpin = () => { navPin = ""; };
    main.addEventListener("wheel", unpin, { passive: true }); main.addEventListener("touchstart", unpin, { passive: true });
    main.addEventListener("keydown", e => { if (/^(Arrow|Page|Home|End| )/.test(e.key)) unpin(); });
  }
  spy();
  // el aviso de deslizar: ahora, cuando terminan de cargar las letras y cada vez que cambia el ancho
  fitSwipe(); document.fonts?.ready.then(() => host?.isConnected && fitSwipe());
  if (!swipeObs && window.ResizeObserver) swipeObs = new ResizeObserver(() => host?.isConnected && fitSwipe());
  if (swipeObs) { swipeObs.disconnect(); swipeObs.observe(host); }
}
