// Tablas del asistente: se arman SOLO con lo que devolvieron las herramientas en ese turno (nunca con el texto del modelo),
// con TODAS las filas (al modelo le llega la lista recortada; acá va la completa que guarda runTool en ctx.lists).
// Formato: { title, source, columns: [{ label, type: text|date|time|number|url }], rows: [[...]], note? }
// El navegador las muestra debajo de la respuesta y las exporta (public/js/chatfmt.js: .xlsx, CSV, Google Sheets).
const ddmm = d => /^\d{4}-\d{2}-\d{2}$/.test(String(d || "")) ? `${d.slice(8, 10)}/${d.slice(5, 7)}` : "";
const addDays = (d, n) => new Date(Date.parse(d + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const col = (label, type = "text") => ({ label, type });
const MIN_ROWS = 2, MAX_TABLES = 4;

export function rangeLabel(desde, hasta, today) {
  if (desde && hasta && desde === hasta) {
    if (desde === today) return `de hoy · ${ddmm(desde)}`;
    if (desde === addDays(today, 1)) return `de mañana · ${ddmm(desde)}`;
    if (desde === addDays(today, -1)) return `de ayer · ${ddmm(desde)}`;
    return `del ${ddmm(desde)}`;
  }
  if (desde && hasta) return `del ${ddmm(desde)} al ${ddmm(hasta)}`;
  if (desde) return `desde el ${ddmm(desde)}`;
  if (hasta) return `hasta el ${ddmm(hasta)}`;
  return "pendientes";
}

const BUILD = {
  actividades_de(d, { today }) {
    const who = d.mine ? "Tus actividades" : `Actividades de ${d.persona}`;
    return [{
      title: `${who} ${rangeLabel(d.desde, d.hasta, today)}`,
      columns: [col("Fecha", "date"), col("Hora", "time"), col("Tipo"), col("Asunto"), col("Colegio o prospecto"), col("Evento"), col("Ciudad"), col("Pipedrive", "url")],
      rows: d.items.map(a => [a.date || "", a.time || "", a.typeLabel || a.type || "", a.subject || "", a.who || a.schoolName || "", a.event || "", a.city || "", a.url || ""]),
      ...(d.aviso ? { note: d.aviso } : {}),
    }];
  },
  a_quien_llamar(d, { today }) {
    const f = [d.ciudad, d.pais].filter(Boolean).join(", ");
    return [{
      title: `A quién llamar${f ? " · " + f : ""} · ${ddmm(today)}`,
      columns: [col("Colegio"), col("Ciudad"), col("País"), col("Prioridad", "number"), col("Teléfono"), col("Motivos")],
      rows: d.items.map(s => [s.colegio || "", s.ciudad || "", s.pais || "", typeof s.prioridad === "number" ? s.prioridad : "", s.telefono || "", (s.motivos || []).join(" · ")]),
    }];
  },
  buscar_colegio(d) {
    const rows = [
      ...d.base.map(s => ["Base OrderBrain", s.colegio || "", s.ciudad || "", s.pais || "", s.telefono || "", s.estado || "", s.url || ""]),
      ...d.pipedrive.map(o => ["Pipedrive", o.nombre || "", o.ciudad || "", o.pais || "", "", "", o.url || ""]),
    ];
    return [{ title: `Búsqueda «${d.q}»`, columns: [col("Dónde"), col("Colegio"), col("Ciudad"), col("País"), col("Teléfono"), col("Estado"), col("Pipedrive", "url")], rows }];
  },
  contexto_colegio(d) {
    const of = d.orgName ? ` · ${d.orgName}` : "";
    return [
      { title: `Tratos${of}`, columns: [col("Trato"), col("Estado"), col("Embudo"), col("Etapa"), col("Motivo de pérdida"), col("Actualizado", "date"), col("Pipedrive", "url")],
        rows: d.tratos.map(x => [x.titulo || "", x.estado || "", x.embudo || "", x.etapa || "", x.motivo_perdida || "", x.actualizado || "", x.url || ""]) },
      { title: `Actividades pendientes${of}`, columns: [col("Fecha", "date"), col("Hora", "time"), col("Tipo"), col("Asunto"), col("Responsable")],
        rows: d.actividades.map(x => [x.fecha || "", x.hora || "", x.tipo || "", x.asunto || "", x.responsable || ""]) },
      { title: `Notas${of}`, columns: [col("Fecha", "date"), col("Autor"), col("Nota")], rows: d.notas.map(x => [x.fecha || "", x.autor || "", x.texto || ""]) },
      { title: `Contactos${of}`, columns: [col("Nombre"), col("Teléfono"), col("Email")], rows: d.contactos.map(x => [x.name || "", (x.phones || []).join(" / ") || x.phone || "", x.email || ""]) },
    ];
  },
  equipo(d) { return [{ title: "Equipo", columns: [col("Persona")], rows: d.names.map(n => [n]) }]; },
};

// calls: [{ tool, input, data }] en el orden en que corrieron. Si la misma herramienta corrió dos veces con lo mismo, queda la última.
export function tablesFromTools(calls = [], { today = new Date().toISOString().slice(0, 10) } = {}) {
  const seen = new Map();
  for (const c of calls) if (BUILD[c.tool] && c.data) seen.set(c.tool + JSON.stringify(c.input || {}), c);
  const out = [];
  for (const c of seen.values()) {
    let ts = []; try { ts = BUILD[c.tool](c.data, { today }); } catch { ts = []; }
    for (const t of ts) if (t.rows.length >= MIN_ROWS) out.push({ ...t, source: c.tool });
  }
  // lo último que se pidió, primero; como mucho 4 tablas por respuesta
  return out.reverse().slice(0, MAX_TABLES).reverse();
}
