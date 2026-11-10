// Equipo: demos de los últimos 7 días (solo demos: no se compite por contactos) y actividad reciente.
import { S, api, esc, icon, ago, copy, toast, pill, setSchools, ST } from "./core.js";
import { openSchool } from "./school.js";
import { brainBadge } from "./app.js";

let host;
const CH_ICON = { call: "phone", whatsapp: "whatsapp", mail: "mail", visit: "user" };

export function renderTeam(el) {
  host = el;
  draw();
  refresh(); // si ya había datos se ven al instante y se actualizan atrás
}
async function refresh() {
  const [stats, feed] = await Promise.all([
    api("/api/stats").catch(e => ({ error: e.message })),
    api("/api/feed").catch(e => ({ error: e.message })),
  ]);
  S.team7 = { stats, feed };
  if (host?.isConnected) draw();
}
// Accesos (solo líderes): el código personal de cada persona y un botón para copiar la invitación
let codes = null;
async function loadCodes() { try { codes = await api("/api/team/codes"); } catch (e) { codes = { error: e.message, users: [] }; } if (host?.isConnected) draw(); }
const codesHtml = c => c.error ? `<div class="callout err">${icon("alert")}<span>${esc(c.error)}</span></div>`
  : `<div class="codes">${c.users.map(u => `<div class="code-row"><span class="t"><b>${esc(u.name)}</b><small>${esc(u.email)}</small></span><code>${esc(u.code)}</code><button class="btn sm" data-invite="${u.id}">${icon("copy", "sm")} Copiar invitación</button></div>`).join("")}</div>`;
// Sincronizar con Pipedrive (solo líderes): cruza toda la base de una vez. El servidor trabaja ~40 s por pedido y
// el navegador repite hasta terminar; «Pausar» deja de pedir (lo hecho queda guardado y se sigue después).
// Si la está siguiendo otra pestaña, otro líder o el cron (sync.active), no se ofrece «Seguir»: se mira cada 5 s.
let sync = null, syncing = false, pausing = false, starting = false, askFull = false, pollT = 0;
const fmt = n => Number(n || 0).toLocaleString("es-MX");
const ORDER = ["unk", "new", "org", "stalled", "lost", "open", "churn", "client", "lead"];
async function loadSync() {
  try { sync = await api("/api/admin/sync"); } catch (e) { sync = { error: { message: e.message } }; }
  drawSync();
  clearTimeout(pollT);
  if (sync?.active && !syncing) pollT = setTimeout(() => { if (host?.isConnected && !syncing) loadSync(); }, 5000);
}
// Sin total conocido (la primera completa, o una incremental) la barra va y viene: un % fijo parece trabado.
function progress(j) {
  if (j.phase === "orgs") { const tot = j.mode === "full" ? j.approxOrgs : null; return { text: `Leyendo organizaciones de Pipedrive: ${fmt(j.orgs)}${tot ? ` de unas ${fmt(tot)}` : ""}`, pct: tot ? Math.min(60, j.orgs / tot * 60) : null }; }
  if (j.phase === "deals") { const tot = j.mode === "full" ? j.approxDeals : null; return { text: `Leyendo tratos: ${fmt(j.deals)}${tot ? ` de unos ${fmt(tot)}` : ""}`, pct: tot ? 60 + Math.min(10, j.deals / tot * 10) : null }; }
  return { text: `Cruzando colegios: ${fmt(j.done)} de ${fmt(j.total)}`, pct: 70 + Math.min(30, j.done / Math.max(1, j.total) * 30) };
}
// Qué dejó la última: lo que cambió de verdad (estado, organización o fase), lo revisado por primera vez y lo que no se tocó.
// Las reescrituras de mantenimiento (para que el cruce no venza) no se cuentan.
function lastHtml(last) {
  const when = `Última: ${esc(ago(last.finishedAt))} (${last.mode === "full" ? "completa" : "solo cambios"})`;
  if (last.changed === undefined) return `${when} · ${fmt(last.written)} colegios revisados`; // de antes de contar cambios
  const to = Object.entries(last.to || {}).sort((x, y) => y[1] - x[1]).map(([k, n]) => `${fmt(n)} a ${esc(ST[k]?.l || k)}`);
  const parts = [];
  if (last.changed) parts.push(`<b>${fmt(last.changed)} cambiaron</b>${to.length ? `: ${to.join(", ")}` : ""}`);
  if (last.first) parts.push(`${fmt(last.first)} revisados por primera vez`);
  if (!last.changed && !last.first) parts.push("sin cambios");
  if (last.skipped) parts.push(`${fmt(last.skipped)} sin tocar (revisados recién o elegidos a mano)`);
  return `${when} · ${parts.join(" · ")}`;
}
function syncHtml() {
  if (!sync) return '<div class="skel" style="margin:14px 0"></div>'.repeat(2);
  const j = sync.job, last = sync.last, c = sync.counts || {};
  const other = !syncing && !!sync.active; // la está siguiendo otra pestaña, otro líder o el cron
  const p = j ? progress(j) : starting ? { text: "Empezando…", pct: null } : null;
  const who = a => a?.by === "cron" ? "el cron diario" : a?.by || "otra pestaña";
  const state = syncing || starting ? "" : other ? ` · la está siguiendo ${esc(who(sync.active))}` : " · quedó en pausa";
  const counts = ORDER.filter(k => c[k]).map(k => `<span class="sync-count">${pill(k)}<b>${fmt(c[k])}</b></span>`).join("");
  const bar = p ? `<div class="prog${p.pct == null ? " ind" : ""}" role="progressbar" aria-label="Progreso" ${p.pct != null ? `aria-valuenow="${Math.round(p.pct)}" aria-valuemin="0" aria-valuemax="100"` : ""}><div ${p.pct != null ? `style="width:${p.pct}%"` : ""}></div></div>` : "";
  const hint = syncing || starting || other ? `<small class="faint" style="display:block;margin-top:4px">Tarda unos minutos. Si cerrás la pestaña queda en pausa y la seguís después${sync.cron ? " (o la sigue el cron diario)" : ""}.</small>` : "";
  const buttons = syncing || starting ? `<button class="btn" id="syncPause" ${pausing ? "disabled" : ""}>${pausing ? "Pausando…" : "Pausar"}</button>`
    : other ? `<button class="btn" id="syncLook">${icon("refresh", "sm")} Ver cómo va</button>`
    : askFull ? `<div class="callout warn" style="flex-basis:100%">${icon("alert")}<span>Vuelve a leer todo Pipedrive. Tarda unos minutos.${j ? " Lo avanzado en la que quedó a medias se descarta." : ""}</span></div>
        <button class="btn primary" id="syncFullYes">Sí, rehacer</button><button class="btn ghost" id="syncFullNo">Cancelar</button>`
    : `<button class="btn primary" id="syncGo">${icon("refresh", "sm")} ${j ? "Seguir" : "Sincronizar con Pipedrive"}</button>${j || last ? `<button class="btn ghost" id="syncFull" title="Vuelve a leer todas las organizaciones y tratos">Rehacer desde cero</button>` : ""}`;
  return `
    ${sync.error ? `<div class="callout err" style="margin-bottom:10px">${icon("alert")}<span>${esc(sync.error.message)}</span></div>` : ""}
    ${p ? `<div style="margin:4px 0 12px"><p style="margin:0 0 6px">${esc(p.text)}${j ? state : ""}</p>${bar}
      ${j ? `<small class="faint">${j.mode === "full" ? "Completa" : "Solo lo cambiado desde la última"}${j.by ? ` · la empezó ${esc(j.by === "cron" ? "el cron diario" : j.by)}` : ""}${sync.busy ? " · hay otro paso corriendo, espero…" : ""}</small>` : ""}${hint}</div>` : ""}
    ${last ? `<p class="faint" style="margin:0 0 10px;font-size:13.5px">${lastHtml(last)}</p>`
      : !p ? `<p class="faint" style="margin:0 0 10px;font-size:13.5px">Todavía no se sincronizó: cada colegio se revisa recién cuando alguien abre su ficha.</p>` : ""}
    <div style="display:flex;flex-wrap:wrap;gap:8px 14px;margin:0 0 14px">${counts}</div>
    <div style="display:flex;flex-wrap:wrap;gap:8px">${buttons}</div>`;
}
function drawSync() {
  const box = host?.isConnected && host.querySelector("#syncBox"); if (!box) return;
  box.innerHTML = syncHtml();
  box.querySelector("#syncGo")?.addEventListener("click", () => runSync(false));
  box.querySelector("#syncFull")?.addEventListener("click", () => { askFull = true; drawSync(); });
  box.querySelector("#syncFullYes")?.addEventListener("click", () => { askFull = false; runSync(true); });
  box.querySelector("#syncFullNo")?.addEventListener("click", () => { askFull = false; drawSync(); });
  box.querySelector("#syncLook")?.addEventListener("click", () => loadSync());
  box.querySelector("#syncPause")?.addEventListener("click", () => { pausing = true; drawSync(); });
}
async function runSync(full) {
  if (syncing) return;
  clearTimeout(pollT);
  syncing = true; pausing = false; starting = !sync?.job; drawSync();
  let first = true;
  try {
    while (!pausing) {
      sync = await api("/api/admin/sync", { body: { full: first && full } }); first = false; starting = false;
      drawSync();
      if (sync.error || !sync.running) break;
      if (sync.busy) await new Promise(r => setTimeout(r, 4000));
    }
  } catch (e) { sync = { ...(sync || {}), error: { message: e.message } }; }
  const done = !sync?.running && !sync?.error;
  syncing = false; pausing = false; starting = false; drawSync();
  if (done) {
    toast("Listo: la base quedó cruzada con Pipedrive");
    try { setSchools(await api("/api/schools")); } catch {} // la lista y el mapa con los estados nuevos
  }
}
// World Dominion (solo líderes): de cuándo son los clientes, cómo anduvo la última lectura y el token de brain.ordereat.com.
// El token se pega acá; el servidor lo prueba antes de guardarlo y nunca lo devuelve (solo quién lo cargó y cuándo vence).
let wd = null, wdAt = 0, wdBusy = false, wdDraft = "";
async function loadWd() { wdAt = Date.now(); try { wd = await api("/api/admin/brain"); } catch (e) { wd = { fail: e.message }; } drawWd(); }
const fDay = v => new Intl.DateTimeFormat("es", { day: "numeric", month: "short", year: "numeric" }).format(new Date(v));
const fWhen = v => new Intl.DateTimeFormat("es", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(v));
const until = v => { const h = (new Date(v) - Date.now()) / 36e5, d = Math.round(h / 24); return h < 1 ? "en menos de una hora" : h < 24 ? `en ${Math.round(h)} h` : `en ${d} día${d === 1 ? "" : "s"}`; };
function wdHtml() {
  if (!wd) return '<div class="skel" style="margin:14px 0"></div>'.repeat(2);
  if (wd.fail) return `<div class="callout err">${icon("alert")}<span>${esc(wd.fail)}</span><button class="btn sm" id="wdRetry">Reintentar</button></div>`;
  const which = wd.source === "env" ? "El token de Vercel" : "El token", lr = wd.lastRead;
  // OrderBrain lo rechazó: eso manda sobre la fecha del token (que puede decir que todavía no venció)
  const rejected = !!(lr && !lr.ok && lr.auth);
  const notes = [];
  // si la copia de los clientes es reciente, el token vencido no es urgente: se dice tranquilo
  const freshCopy = wd.dataAt && Date.now() - new Date(wd.dataAt).getTime() < 3 * 864e5;
  if ((rejected || wd.expiry === "expired") && freshCopy) notes.push(["warn", `${rejected ? "OrderBrain ya no acepta el token" : `${which} venció el ${fWhen(wd.exp)}`}, pero los clientes siguen al día con la copia de ${ago(wd.dataAt)} (se usa hasta 30 días). Cuando quieras actualizarla, pegá uno nuevo abajo.`]);
  else if (rejected) notes.push(["err", `OrderBrain ya no acepta ${which === "El token" ? "este token" : "el token de Vercel"}${wd.exp && wd.expiry !== "expired" ? ` (aunque su fecha dice que vence el ${fDay(wd.exp)})` : ""}. Pegá uno nuevo abajo.`]);
  else if (wd.expiry === "expired") notes.push(["err", `${which} venció el ${fWhen(wd.exp)}. Pegá uno nuevo abajo.`]);
  else if (wd.expiry === "soon") notes.push(["warn", `${which} vence ${until(wd.exp)} (${fWhen(wd.exp)}). Conviene cargar uno nuevo antes.`]);
  if (wd.loaded && !wd.loaded.inUse) notes.push(["warn", `El token que cargó ${wd.loaded.by || "un líder"} venció: se usa el de Vercel.`]);
  const here = t => String(t || "").replace(/ Un líder puede cargar uno nuevo en Equipo\.$/, ""); // ya está en Equipo
  if (lr && !lr.ok && !rejected) notes.push(["err", `La última lectura falló (${ago(lr.at)}): ${here(lr.error)}`]);
  else if (!lr && wd.error) notes.push(["err", here(wd.error)]);
  if (!wd.source && !wd.demo) notes.push(["warn", "Sin token: la app no sabe qué colegios ya son clientes. Pegá uno abajo."]);
  const tokTxt = wd.source === "app" ? `Token cargado por <b>${esc(wd.loaded.by || "un líder")}</b> el ${esc(fDay(wd.loaded.at))}`
    : wd.source === "env" ? "Token de Vercel (BRAIN_TOKEN)" : "";
  const expTxt = !wd.source ? "" : rejected ? ` · rechazado ${esc(ago(lr.at))}` : wd.exp ? ` · ${wd.expiry === "expired" ? "venció" : "vence"} el ${esc(fDay(wd.exp))}` : " · sin fecha de vencimiento";
  return `
    ${notes.map(([k, t]) => `<div class="callout ${k}" style="margin-bottom:10px">${icon("alert")}<span>${esc(t)}</span></div>`).join("")}
    <p style="margin:0 0 4px"><b>${fmt(wd.sites)}</b> ${wd.demo ? "sitios de prueba (modo demo, sin token)" : `sitio${wd.sites === 1 ? "" : "s"}`}${wd.dataAt ? ` · datos <span title="${esc(fWhen(wd.dataAt))}">${esc(ago(wd.dataAt))}</span>` : ""}${wd.stale ? " (copia guardada)" : ""}</p>
    ${tokTxt ? `<p class="faint" style="margin:0 0 4px;font-size:13.5px">${tokTxt}${expTxt}</p>` : ""}
    ${lr?.ok ? `<p class="faint" style="margin:0 0 4px;font-size:13.5px">Última lectura ${esc(ago(lr.at))}: anduvo${lr.n != null ? ` (${fmt(lr.n)} sitios)` : ""}.</p>` : ""}
    <div class="field" style="margin-top:14px"><span><label for="wdTok">${wd.source ? "Cambiar el token" : "Cargar el token"}</label></span>
      <div class="scan-form"><input class="inp" id="wdTok" type="password" autocomplete="off" spellcheck="false" placeholder="Pegá el token acá" aria-describedby="wdHelp">
      <button class="btn primary" id="wdSave">Probar y guardar</button></div>
      <small class="faint" id="wdHelp">Es el token de sesión de ${esc(wd.host || "brain.ordereat.com")}. Lo probamos antes de guardarlo y después no se muestra más.</small>
      <details style="margin-top:6px;font-size:13.5px"><summary>Cómo conseguirlo</summary>
        <ol style="margin:6px 0 0;padding-left:20px;line-height:1.5">
          <li>En una computadora, entrá a <a href="https://${esc(wd.host || "brain.ordereat.com")}" target="_blank" rel="noopener">${esc(wd.host || "brain.ordereat.com")}</a> con una cuenta que vea World Dominion.</li>
          <li>Abrí las herramientas del navegador (F12, o clic derecho → Inspeccionar) y andá a la pestaña Consola.</li>
          <li>Escribí <code>localStorage.getItem("auth_token")</code> y apretá Enter.</li>
          <li>Copiá el texto que aparece (con o sin comillas, da igual) y pegalo acá. No lo mandes por chat: es tu sesión.</li>
        </ol>
        <p class="faint" style="margin:6px 0 0">Vence cuando vence tu sesión de OrderBrain: te avisamos en Hoy y acá unos días antes.</p>
      </details>
      <div id="wdMsg" role="alert"></div></div>`;
}
function drawWd() {
  const box = host?.isConnected && host.querySelector("#wdBox"); if (!box) return;
  box.innerHTML = wdHtml();
  box.querySelector("#wdRetry")?.addEventListener("click", () => { wd = null; drawWd(); loadWd(); });
  const inp = box.querySelector("#wdTok"); if (!inp) return;
  inp.value = wdDraft; inp.oninput = () => { wdDraft = inp.value; };
  inp.onkeydown = e => { if (e.key === "Enter") saveWd(); };
  box.querySelector("#wdSave").onclick = saveWd;
  if (wdBusy) busyWd(box, true);
}
const busyWd = (box, on) => { const b = box.querySelector("#wdSave"); if (b) { b.disabled = on; b.textContent = on ? "Probando…" : "Probar y guardar"; } };
async function saveWd() {
  const box = host.querySelector("#wdBox"), msg = box?.querySelector("#wdMsg");
  if (wdBusy || !box) return;
  if (!wdDraft.trim()) { msg.innerHTML = `<div class="callout err" style="margin-top:8px">${icon("alert")}<span>Pegá el token.</span></div>`; return; }
  wdBusy = true; busyWd(box, true); msg.innerHTML = "";
  try {
    wd = await api("/api/admin/brain", { body: { token: wdDraft } }); wdAt = Date.now(); wdDraft = "";
    wdBusy = false; drawWd();
    toast(`Listo: token guardado. ${fmt(wd.sites)} sitios de World Dominion.`);
    // el mapa, Hoy y la lista con los clientes nuevos
    S.brainP = api("/api/brain").catch(() => ({ enabled: false })); S.brainP.then(b => { S.brain = b; brainBadge(); });
    try { setSchools(await api("/api/schools")); } catch {}
  } catch (e) {
    wdBusy = false;
    const b = host.querySelector("#wdBox"); if (!b) return;
    busyWd(b, false);
    b.querySelector("#wdMsg").innerHTML = `<div class="callout err" style="margin-top:8px">${icon("alert")}<span>${esc(e.message)}</span></div>`;
  }
}
function draw() {
  const t = S.team7;
  const err = (x, what) => `<div class="callout err">${icon("alert")}<span>No pudimos cargar ${what}: ${esc(x.error)}</span><button class="btn sm" data-retry>Reintentar</button></div>`;
  const sk = '<div class="skel" style="margin:14px 0"></div>'.repeat(5);
  let rank = sk, feed = sk;
  if (t) {
    const board = t.stats.error ? null : t.stats.leaderboard || [];
    rank = !board ? err(t.stats, "el ranking") : board.length ? `
      <div class="rank head" role="row"><span>#</span><span>Persona</span><span class="num">Demos</span></div>
      ${board.map((p, i) => `<div class="rank ${p.name === S.me.name ? "me" : ""}" role="row"><span class="pos ${["g1", "g2", "g3"][i] || ""}">${i + 1}</span><span class="nm">${esc(p.name)}${p.name === S.me.name ? " (vos)" : ""}</span><span class="num"><b>${p.demos}</b></span></div>`).join("")}`
      : `<div class="empty">${icon("video")}<span>Todavía no hay demos agendadas esta semana.</span></div>`;
    feed = t.feed.error ? err(t.feed, "la actividad") : t.feed.length ? t.feed.map(f => {
      const inner = `<span class="ty ${f.demo ? "meeting" : ""}" role="img" aria-label="${esc(f.title)}">${icon(f.demo ? "video" : CH_ICON[f.channel] || "note")}</span><span class="t"><b>${esc(f.org)}</b><span>${esc(f.title)}</span><small>${esc(f.author)} · ${esc(ago(f.at))}</small></span>`;
      return f.schoolId ? `<button class="feed-item" data-id="${esc(f.schoolId)}">${inner}</button>` : `<div class="feed-item">${inner}</div>`;
    }).join("") : `<div class="empty">${icon("note")}<span>Sin actividad todavía.</span></div>`;
  }
  host.innerHTML = `<div class="page">
    <div class="page-head"><div><h1>Equipo</h1><p>Últimos 7 días</p></div></div>
    <div class="two">
      <section class="card" aria-labelledby="hRk"><div class="card-h"><h2 id="hRk">${icon("video")} Demos de la semana</h2><span class="sub">agendadas desde OrderBrain</span></div><div class="card-b" role="table" aria-label="Ranking del equipo">${rank}</div></section>
      <section class="card" aria-labelledby="hFd"><div class="card-h"><h2 id="hFd">${icon("clock")} Actividad reciente</h2></div><div class="card-b">${feed}</div></section>
    </div>
    ${S.profile?.leader ? `<section class="card" style="margin-top:16px" aria-labelledby="hAc"><div class="card-h"><h2 id="hAc">${icon("user")} Accesos del equipo</h2><span class="sub">cada persona entra con su email y su código personal</span></div>
      <div class="card-b" id="codes">${codes ? codesHtml(codes) : '<div class="skel" style="margin:14px 0"></div>'.repeat(3)}</div></section>
    <section class="card" style="margin-top:16px" aria-labelledby="hSy"><div class="card-h"><h2 id="hSy">${icon("refresh")} Sincronizar con Pipedrive</h2><span class="sub">cruza toda la base de colegios de una vez</span></div>
      <div class="card-b" id="syncBox" aria-live="polite"></div></section>
    <section class="card" style="margin-top:16px" aria-labelledby="hWd"><div class="card-h"><h2 id="hWd">${icon("globe")} World Dominion</h2><span class="sub">qué colegios ya son clientes de OrderEAT</span></div>
      <div class="card-b" id="wdBox"></div></section>` : ""}
    </div>`;
  host.querySelectorAll("[data-retry]").forEach(b => b.onclick = () => { S.team7 = null; draw(); refresh(); });
  if (S.profile?.leader && !codes) loadCodes();
  if (S.profile?.leader) { drawSync(); if (!syncing) loadSync(); }
  if (S.profile?.leader) { drawWd(); if (!wdBusy && Date.now() - wdAt > 20e3) loadWd(); }
  host.querySelectorAll("[data-invite]").forEach(b => b.onclick = () => {
    const u = codes.users.find(x => String(x.id) === b.dataset.invite); if (!u) return;
    copy(`Hola ${u.name.split(" ")[0]}! Entrá a OrderBrain SDR: ${codes.url}\nTu email: ${u.email}\nTu código personal: ${u.code}\n(No lo compartas: es solo tuyo.)`);
  });
  host.querySelectorAll("[data-id]").forEach(b => b.onclick = () => openSchool(b.dataset.id));
}
