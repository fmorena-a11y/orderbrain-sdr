// Equipo: ranking de los últimos 7 días y actividad reciente.
import { S, api, esc, icon, ago } from "./core.js";
import { openSchool } from "./school.js";

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
function draw() {
  const t = S.team7;
  const err = (x, what) => `<div class="callout err">${icon("alert")}<span>No pudimos cargar ${what}: ${esc(x.error)}</span><button class="btn sm" data-retry>Reintentar</button></div>`;
  const sk = '<div class="skel" style="margin:14px 0"></div>'.repeat(5);
  let rank = sk, feed = sk;
  if (t) {
    const board = t.stats.error ? null : t.stats.leaderboard || [];
    rank = !board ? err(t.stats, "el ranking") : board.length ? `
      <div class="rank head" role="row"><span>#</span><span>Persona</span><span class="num" title="Contactos registrados">Cont.</span><span class="num" title="Conversaciones (atendió alguien)">Conv.</span><span class="num" title="Ordenado por demos">Demos ↓</span></div>
      ${board.map((p, i) => `<div class="rank ${p.name === S.me.name ? "me" : ""}" role="row"><span class="pos ${["g1", "g2", "g3"][i] || ""}">${i + 1}</span><span class="nm">${esc(p.name)}${p.name === S.me.name ? " (vos)" : ""}</span><span class="num">${p.touches}</span><span class="num">${p.connected}</span><span class="num"><b>${p.demos}</b></span></div>`).join("")}`
      : `<div class="empty">${icon("users")}<span>Todavía no hay contactos registrados desde OrderBrain esta semana.</span></div>`;
    feed = t.feed.error ? err(t.feed, "la actividad") : t.feed.length ? t.feed.map(f => {
      const inner = `<span class="ty ${f.demo ? "meeting" : ""}" role="img" aria-label="${esc(f.title)}">${icon(f.demo ? "video" : CH_ICON[f.channel] || "note")}</span><span class="t"><b>${esc(f.org)}</b><span>${esc(f.title)}</span><small>${esc(f.author)} · ${esc(ago(f.at))}</small></span>`;
      return f.schoolId ? `<button class="feed-item" data-id="${esc(f.schoolId)}">${inner}</button>` : `<div class="feed-item">${inner}</div>`;
    }).join("") : `<div class="empty">${icon("note")}<span>Sin actividad todavía.</span></div>`;
  }
  host.innerHTML = `<div class="page">
    <div class="page-head"><div><h1>Equipo</h1><p>Últimos 7 días</p></div></div>
    <div class="two">
      <section class="card" aria-labelledby="hRk"><div class="card-h"><h2 id="hRk">${icon("flame")} Ranking</h2><span class="sub">por demos, conversaciones y contactos</span></div><div class="card-b" role="table" aria-label="Ranking del equipo">${rank}</div></section>
      <section class="card" aria-labelledby="hFd"><div class="card-h"><h2 id="hFd">${icon("clock")} Actividad reciente</h2></div><div class="card-b">${feed}</div></section>
    </div></div>`;
  host.querySelectorAll("[data-retry]").forEach(b => b.onclick = () => { S.team7 = null; draw(); refresh(); });
  host.querySelectorAll("[data-id]").forEach(b => b.onclick = () => openSchool(b.dataset.id));
}
