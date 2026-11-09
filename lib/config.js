// Configuración comercial: mercados, embudos de Pipedrive y campos personalizados.
// Los IDs por defecto son los de la cuenta de OrderEAT; se pueden pisar con variables de entorno.
const env = process.env;
const json = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { console.warn("⚠ JSON inválido en variable de entorno, uso el valor por defecto"); return d; } };

// Mercado por país: vocabulario, tratamiento, zona horaria, embudo de ventas y etapa donde entra un trato nuevo.
const BASE_MARKETS = {
  "México":     { code: "MX", espacio: "cafetería", espacios: "cafeterías", trato: "tu",  padres: "papás", verbo: "platicamos", cierre: "Saludos", tz: "America/Mexico_City", pipeline: 9,  stage: 160, prefix: "52" },
  "Perú":       { code: "PE", espacio: "cafetería", espacios: "cafeterías", trato: "tu",  padres: "padres de familia", verbo: "conversamos", cierre: "Saludos", tz: "America/Lima", pipeline: 29, stage: 258, prefix: "51" },
  "Argentina":  { code: "AR", espacio: "cantina",   espacios: "cantinas",   trato: "vos", padres: "familias", verbo: "charlamos", cierre: "Abrazo", tz: "America/Argentina/Buenos_Aires", pipeline: 1, stage: 112, prefix: "54" },
  "Chile":      { code: "CL", espacio: "casino",    espacios: "casinos",    trato: "tu",  padres: "apoderados", verbo: "conversamos", cierre: "Saludos cordiales", tz: "America/Santiago", pipeline: 2, stage: 14, prefix: "56" },
  "Uruguay":    { code: "UY", espacio: "cantina",   espacios: "cantinas",   trato: "tu",  padres: "familias", verbo: "conversamos", cierre: "Saludos", tz: "America/Montevideo", pipeline: 3, stage: 108, prefix: "598" },
  "Guatemala":  { code: "GT", espacio: "cafetería", espacios: "cafeterías", trato: "tu",  padres: "padres de familia", verbo: "platicamos", cierre: "Saludos", tz: "America/Guatemala", pipeline: 12, stage: 198, prefix: "502" },
  "Costa Rica": { code: "CR", espacio: "soda",      espacios: "sodas",      trato: "tu",  padres: "padres de familia", verbo: "conversamos", cierre: "Saludos", tz: "America/Costa_Rica", pipeline: 12, stage: 198, prefix: "506" },
};
// SALES_PIPELINES='{"México":[9,160],"Perú":[29,258]}' cambia embudo y etapa de entrada por país.
const override = json(env.SALES_PIPELINES, {});
for (const [c, [p, s]] of Object.entries(override)) if (BASE_MARKETS[c]) Object.assign(BASE_MARKETS[c], { pipeline: Number(p), stage: Number(s) });
export const MARKETS = BASE_MARKETS;
const FALLBACK = { code: "LATAM", espacio: "cafetería", espacios: "cafeterías", trato: "tu", padres: "padres de familia", verbo: "conversamos", cierre: "Saludos", tz: "America/Mexico_City", pipeline: 12, stage: 198, prefix: "" };
export const market = country => ({ country, ...(MARKETS[country] || FALLBACK) });

// Embudos de clientes y etapas "muertas" (para clasificar colegios).
export const CLIENT_PIPES = (env.CLIENT_PIPELINE_IDS || "16,22,27").split(",").map(Number);
export const DEAD_STAGES = (env.DEAD_STAGE_IDS || "208,249").split(",").map(Number);

// Campos personalizados de tratos (claves de la cuenta de OrderEAT).
export const DEAL_FIELDS = json(env.DEAL_FIELDS, {
  cafeteria: "2d560b62cb39cf3b7dd0b998778d0045a1c914cc",
  alumnos: "56d5a9db631d0cf7e41af4853ab312a0a8d1f496",
  sdr: "81bc5f8503046b3a9a9fac49d59ebe15a2905987",
  fuente: "7fc9affbe2d9c67549398a207f01d476e47c0b16",
  pais: "2f2b6b402c204a65c5df3f98365135a46b061a4c",
  niveles: "0bc76adbe14ba7caa223b44cb082bae4485fcfc6",
  telefono: "0728cefeeb776424786e7d778144c0906d8dcf5d",
  email: "745c4ce0c407819c453d5704fb7d7c603ca2219e",
  web: "0c0263c7c082d949c650aa68387bc59658a93d64",
});
export const OPTIONS = {
  cafeteria: { "Propia": 451, "Externa": 452, "No tiene": 1143 },
  pais: { "México": 91, "Uruguay": 92, "Argentina": 93, "Perú": 255, "Chile": 257, "Guatemala": 259, "Costa Rica": Number(env.PAIS_CR_OPTION || 0) || undefined },
  niveles: { "Preescolar": 497, "Primaria": 498, "Secundaria": 499, "Prepa": 500, "Universidad": 501 },
  fuente: { coldCalling: Number(env.FUENTE_OPTION || 502) },
  orgLabel: { cliente: 1, alto: 2, medio: 3, bajo: 4 },
};
export const LOST_REASONS = ["No tiene cafetería", "Ya tiene un software del estilo", "Es muy caro", "No le interesa", "Colegio no  existe más", "No es fit", "No es prioridad ahora", "No responde más"];
// Motivos de pérdida que conviene volver a intentar pasado un tiempo.
export const REACTIVABLE = ["No es prioridad ahora", "No responde más", "Es muy caro", "No le interesa", "Ya tiene un software del estilo"];

// Tipos de actividad de la cuenta.
export const TYPE_LABEL = { call: "Llamada", meeting: "Demo", deadline: "WhatsApp", task: "Mail", contacto_decisor: "Contacto decisor" };
export const CHANNEL_TYPE = { call: "call", whatsapp: "deadline", mail: "task", visit: "contacto_decisor" };

export const DAILY_GOAL = Number(env.DAILY_GOAL || 40);
