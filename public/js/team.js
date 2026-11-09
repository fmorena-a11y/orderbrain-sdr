// Equipo: ranking de la semana y actividad reciente.
import { S, api, esc, icon, ago, initials } from "./core.js";
import { openSchool } from "./school.js";

let host;
export async function renderTeam(el) {
  host = el;
  el.innerHTML = `<div class="page"><div class="page-head"><div><h1>Equipo</h1><p>Cargando…</p></div></div></div>`;
  const [stats, feed] = await Promise.all([api("/api/stats").catch(() => null), api("/api/feed").catch(() => [])]);
  if (!host?.isConnected) return;
  S.feed = feed;
  const board = stats?.leaderboard || [];
  const top = board.slice(0, 3);
  const order = top.length === 3 ? [top[1], top[0], top[2]] : top;
  const cls = p => ["g1", "g2", "g3"][board.indexOf(p)];
  el.innerHTML = `<div class="page">
    <div class="page-head"><div><h1>Equipo</h1><p>Últimos 7 días. Ordenado por demos, después conversaciones y después contactos.</p></div></div>
    <div class="two">
      <section class="card"><div class="card-h"><h2>${icon("flame")} Ranking de la semana</h2></div><div class="card-b">
        ${board.length ? `${top.length === 3 ? `<div class="podium">${order.map(p => `<div class="pod ${cls(p)}"><div class="medal">${board.indexOf(p) + 1}°</div><b>${esc(p.name)}</b><small>${p.demos} demos · ${p.connected} conv.</small></div>`).join("")}</div>` : ""}
          <div class="rank head"><span></span><span>Persona</span><span class="num">Contactos</span><span class="num">Conv.</span><span class="num">Demos</span></div>
          ${board.map((p, i) => `<div class="rank"><span class="num faint">${i + 1}</span><span>${esc(p.name)}</span><span class="num">${p.touches}</span><span class="num">${p.connected}</span><span class="num"><b>${p.demos}</b></span></div>`).join("")}`
        : `<div class="empty">${icon("users")}<span>Todavía no hay contactos registrados desde OrderBrain esta semana.</span></div>`}
      </div></section>
      <section class="card"><div class="card-h"><h2>${icon("clock")} Actividad reciente</h2></div><div class="card-b">
        ${feed.length ? feed.map(f => `<div class="feed-item"><span class="av">${initials(f.author)}</span><div>${f.schoolId ? `<button data-id="${esc(f.schoolId)}">${esc(f.org)}</button>` : `<b>${esc(f.org)}</b>`}<div>${esc(f.title)}${f.demo ? " 🎯" : ""}</div><small>${esc(f.author)} · ${esc(ago(f.at))}</small></div></div>`).join("")
          : `<div class="empty">${icon("note")}<span>Sin actividad todavía.</span></div>`}
      </div></section>
    </div></div>`;
  el.querySelectorAll("[data-id]").forEach(b => b.onclick = () => openSchool(b.dataset.id));
}
