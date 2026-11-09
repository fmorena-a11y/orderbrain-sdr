// Estudio de prospección de un colegio: Claude investiga en la web (buscador + páginas del colegio)
// y devuelve un informe para el SDR: perfil, cafetería, decisores, contacto, señales, riesgos, encaje,
// ángulo, guion, imágenes y fuentes. Lo usan la app (al abrir un colegio) y el radar (en lote).
// No guarda nada: quien llama decide dónde (Redis, archivo en data/studies o nota en Pipedrive).
import Anthropic from "@anthropic-ai/sdk";

const MODEL = process.env.STUDY_MODEL || process.env.ANTHROPIC_MODEL || "claude-opus-5-5";
const client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
export const studyEnabled = () => !!client;

const SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["resumen", "perfil", "cafeteria", "decisores", "contacto", "senales", "riesgos", "fit", "fit_razon", "angulo", "apertura", "preguntas", "objeciones", "proximo_paso", "imagenes"],
  properties: {
    resumen: { type: "string", description: "3 o 4 oraciones: qué colegio es y por qué importa para OrderEAT" },
    perfil: {
      type: "object", additionalProperties: false,
      required: ["tipo", "niveles", "alumnos", "cuota", "segmento", "idiomas", "confesional", "red", "antiguedad", "sedes"],
      properties: {
        tipo: { type: "string" }, niveles: { type: "array", items: { type: "string" } },
        alumnos: { type: "string", description: "cantidad o rango estimado, con la base de la estimación" },
        cuota: { type: "string", description: "colegiatura o arancel mensual si aparece, si no rango estimado o 'sin datos'" },
        segmento: { type: "string", description: "nivel socioeconómico estimado" },
        idiomas: { type: "string" }, confesional: { type: "string" }, red: { type: "string", description: "red, grupo o congregación a la que pertenece, o ''" },
        antiguedad: { type: "string" }, sedes: { type: "string" },
      },
    },
    cafeteria: {
      type: "object", additionalProperties: false, required: ["modelo", "detalle"],
      properties: { modelo: { type: "string", enum: ["propia", "concesionada", "no tiene", "desconocido"] }, detalle: { type: "string" } },
    },
    decisores: { type: "array", items: { type: "object", additionalProperties: false, required: ["nombre", "cargo", "fuente"], properties: { nombre: { type: "string" }, cargo: { type: "string" }, fuente: { type: "string" } } } },
    contacto: {
      type: "object", additionalProperties: false, required: ["telefonos", "emails", "whatsapp", "web", "redes"],
      properties: { telefonos: { type: "array", items: { type: "string" } }, emails: { type: "array", items: { type: "string" } }, whatsapp: { type: "string" }, web: { type: "string" }, redes: { type: "array", items: { type: "string" } } },
    },
    senales: { type: "array", items: { type: "string" }, description: "señales concretas de oportunidad encontradas" },
    riesgos: { type: "array", items: { type: "string" } },
    fit: { type: "string", enum: ["alto", "medio", "bajo"] },
    fit_razon: { type: "string" },
    angulo: { type: "string", description: "el ángulo de venta para este colegio en una o dos oraciones" },
    apertura: { type: "string", description: "lo que dice el SDR en los primeros 15 segundos de la llamada" },
    preguntas: { type: "array", items: { type: "string" } },
    objeciones: { type: "array", items: { type: "object", additionalProperties: false, required: ["o", "r"], properties: { o: { type: "string" }, r: { type: "string" } } } },
    proximo_paso: { type: "string" },
    imagenes: { type: "array", items: { type: "object", additionalProperties: false, required: ["url", "descripcion"], properties: { url: { type: "string" }, descripcion: { type: "string" } } }, description: "URLs directas (https) de fotos del colegio vistas en las páginas leídas" },
  },
};

const SYSTEM = `Sos un investigador de prospección B2B senior para OrderEAT, software para la cafetería escolar: app para que las familias carguen saldo, pongan límites y marquen alergias; punto de venta rápido sin efectivo; reportes; tótems e identificación (pulseras, tarjetas, credenciales, huella). Vende a colegios privados, preparatorias y universidades de Latinoamérica y España. Hay dos compradores: el concesionario (opera la cafetería como negocio: ventas, efectivo, filas, mermas) y la dirección (familias, alergias, imagen, control).
Tu trabajo: investigar a fondo un colegio en la web y preparar al SDR para la primera llamada. Usá el buscador y leé la web del colegio (inicio, nosotros, admisiones o colegiaturas, contacto, servicios, cafetería o comedor), sus redes y notas de prensa.
Reglas: solo datos que encontraste o estimaciones marcadas como tales ("estimado", "sin datos"). No inventes nombres, teléfonos, cifras ni clientes. Los decisores llevan la fuente donde aparecen. Escribí en el español del país del colegio, frases cortas y concretas. Las imágenes son URLs directas a fotos del colegio que viste en las páginas, no logos ni íconos; si no hay, dejá la lista vacía.`;

const fmt = s => `Colegio: ${s.name}\nUbicación: ${[s.addr, s.city, s.country].filter(Boolean).join(", ")}\n${s.web ? `Web: ${s.web}\n` : ""}${s.phone ? `Teléfono conocido: ${s.phone}\n` : ""}${s.levels?.length ? `Niveles conocidos: ${s.levels.join(", ")}\n` : ""}${s.rating ? `Google: ${s.rating}\n` : ""}`;

// Investiga un colegio. context: texto extra (estado en Pipedrive, notas previas).
export async function research(s, { context = "", effort = process.env.STUDY_EFFORT || "high" } = {}) {
  if (!client) throw Object.assign(new Error("Falta ANTHROPIC_API_KEY para hacer el estudio"), { status: 500 });
  const messages = [{ role: "user", content: `${fmt(s)}${context ? `\nContexto interno:\n${context}\n` : ""}\nInvestigá este colegio y devolvé el estudio.` }];
  const base = {
    model: MODEL, max_tokens: 32000, system: SYSTEM,
    betas: ["server-side-fallback-2026-07-01"], fallbacks: "default",
    thinking: { type: "adaptive" }, output_config: { effort, format: { type: "json_schema", schema: SCHEMA } },
    tools: [
      { type: "web_search_20260209", name: "web_search", max_uses: 8, ...(s.country ? { user_location: { type: "approximate", city: s.city, country: ISO[s.country] || undefined } } : {}) },
      { type: "web_fetch_20260209", name: "web_fetch", max_uses: 8, max_content_tokens: 20000 },
    ],
  };
  if (!base.tools[0].user_location?.country) delete base.tools[0].user_location;
  let res, searches = 0;
  const call = async () => {
    try { return await client.beta.messages.stream({ ...base, messages }).finalMessage(); }
    catch (e) {
      // si la combinación de formato estructurado y herramientas web no está disponible, se pide el JSON por instrucción
      if (e instanceof Anthropic.BadRequestError && base.output_config.format && /format|schema|output_config/i.test(e.message)) {
        delete base.output_config.format;
        base.system = SYSTEM + `\nRespondé al final solo con un objeto JSON que cumpla este esquema, sin texto alrededor: ${JSON.stringify(SCHEMA)}`;
        return client.beta.messages.stream({ ...base, messages }).finalMessage();
      }
      throw e;
    }
  };
  for (let i = 0; i < 5; i++) {
    res = await call();
    searches += res.usage?.server_tool_use?.web_search_requests || 0;
    if (res.stop_reason !== "pause_turn") break;
    // el loop de herramientas del servidor se pausó: se reenvía tal cual y retoma solo
    messages.push({ role: "assistant", content: res.content });
  }
  if (res.stop_reason === "refusal") throw new Error("El modelo no pudo hacer este estudio.");
  const all = [...messages.filter(m => m.role === "assistant").flatMap(m => m.content), ...res.content];
  // el JSON es el último bloque de texto (antes puede haber notas de avance entre búsquedas)
  let study = null;
  for (const b of res.content.filter(b => b.type === "text").reverse()) {
    const m = b.text.match(/\{[\s\S]*\}/);
    if (m) { try { study = JSON.parse(m[0]); break; } catch {} }
  }
  if (!study) throw new Error("El estudio vino vacío, probá de nuevo.");
  // fuentes: resultados de búsqueda y páginas leídas
  const fuentes = new Map();
  for (const b of all) {
    if (b.type === "web_search_tool_result" && Array.isArray(b.content)) for (const r of b.content) if (r.url) fuentes.set(r.url, r.title || r.url);
    if (b.type === "web_fetch_tool_result" && b.content?.url) fuentes.set(b.content.url, b.content.content?.title || b.content.url);
  }
  study.imagenes = (study.imagenes || []).filter(x => /^https:\/\/[^\s]+$/i.test(x.url) && !/logo|icon|favicon|sprite/i.test(x.url)).slice(0, 8);
  return { ...study, fuentes: [...fuentes].slice(0, 15).map(([url, titulo]) => ({ url, titulo })), at: new Date().toISOString(), modelo: res.model, busquedas: searches };
}

const ISO = { "México": "MX", "Perú": "PE", "Argentina": "AR", "Chile": "CL", "Uruguay": "UY", "Guatemala": "GT", "Costa Rica": "CR", "Colombia": "CO", "Ecuador": "EC", "Bolivia": "BO", "Paraguay": "PY", "Venezuela": "VE", "Panamá": "PA", "República Dominicana": "DO", "Honduras": "HN", "El Salvador": "SV", "Nicaragua": "NI", "Puerto Rico": "PR", "España": "ES" };

// Nota para Pipedrive (HTML simple).
export function studyToHtml(s, st) {
  const e = x => String(x ?? "").replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const li = a => (a || []).filter(Boolean).map(x => `• ${e(x)}`).join("<br>");
  const p = st.perfil || {};
  return [`<b>Estudio de prospección · ${e(s.name)}</b>`, e(st.resumen),
    `<b>Perfil:</b> ${e([p.tipo, (p.niveles || []).join(", "), p.alumnos && `alumnos: ${p.alumnos}`, p.cuota && `cuota: ${p.cuota}`, p.segmento, p.red].filter(Boolean).join(" · "))}`,
    `<b>Cafetería:</b> ${e(st.cafeteria?.modelo)}${st.cafeteria?.detalle ? ` · ${e(st.cafeteria.detalle)}` : ""}`,
    st.decisores?.length ? `<b>Decisores:</b><br>${st.decisores.map(d => `• ${e(d.nombre)} (${e(d.cargo)})`).join("<br>")}` : "",
    st.senales?.length ? `<b>Señales:</b><br>${li(st.senales)}` : "", st.riesgos?.length ? `<b>Riesgos:</b><br>${li(st.riesgos)}` : "",
    `<b>Encaje:</b> ${e(st.fit)} · ${e(st.fit_razon)}`, `<b>Ángulo:</b> ${e(st.angulo)}`, `<b>Próximo paso:</b> ${e(st.proximo_paso)}`,
    st.fuentes?.length ? `<b>Fuentes:</b><br>${st.fuentes.slice(0, 6).map(f => `• ${e(f.url)}`).join("<br>")}` : "",
    `<i>Generado por OrderBrain SDR</i>`].filter(Boolean).join("<br><br>");
}
