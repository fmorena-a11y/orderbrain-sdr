// Configuración comercial: mercados, embudos de Pipedrive y campos personalizados.
// Los IDs por defecto son los de la cuenta de OrderEAT; se pueden pisar con variables de entorno.
const env = process.env;
const json = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { console.warn("⚠ JSON inválido en variable de entorno, uso el valor por defecto"); return d; } };

// Mercado por país: vocabulario, tratamiento, zona horaria, embudo de ventas y etapa donde entra un trato nuevo.
// Horario de llamada: ventana habitual de oficina escolar, en hora local del colegio (tz), de lunes a viernes.
// No es un dato de cada colegio: es lo normal en el país. Se ajusta acá, por país (horario: [["08:30","13:00"], …]).
const OFICINA = [["08:00", "12:30"], ["14:00", "16:30"]];
// México tiene varios husos: ciudades fuera del centro (la base tiene Tijuana, Mexicali, Hermosillo, Culiacán, Ciudad Juárez, Cancún).
// Una ciudad que no está en la lista y queda al oeste de -105.5 o al este de -89.1 (longitud) tiene huso desconocido: no se muestra la hora.
const MX_HUSOS = { "America/Tijuana": ["Tijuana", "Mexicali", "Ensenada", "Tecate", "Rosarito", "Playas de Rosarito"],
  "America/Hermosillo": ["Hermosillo", "Ciudad Obregón", "Nogales", "Navojoa", "Guaymas", "San Luis Río Colorado"],
  "America/Mazatlan": ["Culiacán", "Mazatlán", "Los Mochis", "La Paz", "Los Cabos", "Cabo San Lucas", "San José del Cabo", "Tepic"],
  "America/Chihuahua": ["Chihuahua", "Delicias", "Cuauhtémoc", "Hidalgo del Parral"], "America/Ciudad_Juarez": ["Ciudad Juárez"],
  "America/Cancun": ["Cancún", "Playa del Carmen", "Tulum", "Chetumal", "Cozumel"] };
const BASE_MARKETS = {
  "México":     { code: "MX", espacio: "cafetería", espacios: "cafeterías", trato: "tu",  padres: "papás", verbo: "platicamos", cierre: "Saludos", tz: "America/Mexico_City", pipeline: 9,  stage: 160, prefix: "52", horario: OFICINA, husos: MX_HUSOS, husoLng: [-105.5, -89.1] },
  "Perú":       { code: "PE", espacio: "cafetería", espacios: "cafeterías", trato: "tu",  padres: "padres de familia", verbo: "conversamos", cierre: "Saludos", tz: "America/Lima", pipeline: 29, stage: 258, prefix: "51", horario: OFICINA },
  "Argentina":  { code: "AR", espacio: "cantina",   espacios: "cantinas",   trato: "vos", padres: "familias", verbo: "charlamos", cierre: "Abrazo", tz: "America/Argentina/Buenos_Aires", pipeline: 1, stage: 112, prefix: "54", horario: OFICINA },
  "Chile":      { code: "CL", espacio: "casino",    espacios: "casinos",    trato: "tu",  padres: "apoderados", verbo: "conversamos", cierre: "Saludos cordiales", tz: "America/Santiago", pipeline: 2, stage: 14, prefix: "56", horario: OFICINA },
  "Uruguay":    { code: "UY", espacio: "cantina",   espacios: "cantinas",   trato: "tu",  padres: "familias", verbo: "conversamos", cierre: "Saludos", tz: "America/Montevideo", pipeline: 3, stage: 108, prefix: "598", horario: OFICINA },
  "Guatemala":  { code: "GT", espacio: "cafetería", espacios: "cafeterías", trato: "tu",  padres: "padres de familia", verbo: "platicamos", cierre: "Saludos", tz: "America/Guatemala", pipeline: 12, stage: 198, prefix: "502", horario: OFICINA },
  "Costa Rica": { code: "CR", espacio: "soda",      espacios: "sodas",      trato: "tu",  padres: "padres de familia", verbo: "conversamos", cierre: "Saludos", tz: "America/Costa_Rica", pipeline: 12, stage: 198, prefix: "506", horario: OFICINA },
  "Colombia":   { code: "CO", espacio: "cafetería", espacios: "cafeterías", trato: "tu",  padres: "padres de familia", verbo: "hablamos", cierre: "Saludos", tz: "America/Bogota", pipeline: 12, stage: 198, prefix: "57", horario: OFICINA },
  "Ecuador":    { code: "EC", espacio: "bar escolar", espacios: "bares escolares", trato: "tu", padres: "padres de familia", verbo: "conversamos", cierre: "Saludos", tz: "America/Guayaquil", pipeline: 12, stage: 198, prefix: "593", horario: OFICINA },
  "Bolivia":    { code: "BO", espacio: "cafetería", espacios: "cafeterías", trato: "tu",  padres: "padres de familia", verbo: "conversamos", cierre: "Saludos", tz: "America/La_Paz", pipeline: 12, stage: 198, prefix: "591", horario: OFICINA },
  "Paraguay":   { code: "PY", espacio: "cantina",   espacios: "cantinas",   trato: "vos", padres: "familias", verbo: "conversamos", cierre: "Saludos", tz: "America/Asuncion", pipeline: 12, stage: 198, prefix: "595", horario: OFICINA },
  "Venezuela":  { code: "VE", espacio: "cantina",   espacios: "cantinas",   trato: "tu",  padres: "representantes", verbo: "conversamos", cierre: "Saludos", tz: "America/Caracas", pipeline: 12, stage: 198, prefix: "58", horario: OFICINA },
  "Panamá":     { code: "PA", espacio: "cafetería", espacios: "cafeterías", trato: "tu",  padres: "padres de familia", verbo: "conversamos", cierre: "Saludos", tz: "America/Panama", pipeline: 12, stage: 198, prefix: "507", horario: OFICINA },
  "República Dominicana": { code: "DO", espacio: "cafetería", espacios: "cafeterías", trato: "tu", padres: "padres", verbo: "conversamos", cierre: "Saludos", tz: "America/Santo_Domingo", pipeline: 12, stage: 198, prefix: "1", horario: OFICINA },
  "Honduras":   { code: "HN", espacio: "cafetería", espacios: "cafeterías", trato: "tu",  padres: "padres de familia", verbo: "platicamos", cierre: "Saludos", tz: "America/Tegucigalpa", pipeline: 12, stage: 198, prefix: "504", horario: OFICINA },
  "El Salvador": { code: "SV", espacio: "cafetería", espacios: "cafeterías", trato: "tu", padres: "padres de familia", verbo: "platicamos", cierre: "Saludos", tz: "America/El_Salvador", pipeline: 12, stage: 198, prefix: "503", horario: OFICINA },
  "Nicaragua":  { code: "NI", espacio: "cafetería", espacios: "cafeterías", trato: "tu",  padres: "padres de familia", verbo: "conversamos", cierre: "Saludos", tz: "America/Managua", pipeline: 12, stage: 198, prefix: "505", horario: OFICINA },
  "Puerto Rico": { code: "PR", espacio: "cafetería", espacios: "cafeterías", trato: "tu", padres: "padres", verbo: "hablamos", cierre: "Saludos", tz: "America/Puerto_Rico", pipeline: 12, stage: 198, prefix: "1", horario: OFICINA },
  "España":     { code: "ES", espacio: "cafetería", espacios: "cafeterías", trato: "tu",  padres: "familias", verbo: "hablamos", cierre: "Un saludo", tz: "Europe/Madrid", pipeline: 12, stage: 198, prefix: "34", horario: OFICINA },
};
// SALES_PIPELINES='{"México":[9,160],"Perú":[29,258]}' cambia embudo y etapa de entrada por país.
const override = json(env.SALES_PIPELINES, {});
for (const [c, [p, s]] of Object.entries(override)) if (BASE_MARKETS[c]) Object.assign(BASE_MARKETS[c], { pipeline: Number(p), stage: Number(s) });
export const MARKETS = BASE_MARKETS;
const FALLBACK = { code: "LATAM", espacio: "cafetería", espacios: "cafeterías", trato: "tu", padres: "padres de familia", verbo: "conversamos", cierre: "Saludos", tz: "America/Mexico_City", pipeline: 12, stage: 198, prefix: "", horario: OFICINA };
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
  ciudad: "807bb1fbacdd84226fb108be587ceef41d63173a",
  estado: "08a574c4f9cdf0da03fc7459f01c1373a691b19e",
  direccion: "e243289473808fc6f35b27cac1e89163fb93a698",
});
export const OPTIONS = {
  cafeteria: { "Propia": 451, "Externa": 452, "No tiene": 1143 },
  pais: { "México": 91, "Uruguay": 92, "Argentina": 93, "Colombia": 243, "Paraguay": 253, "Ecuador": 254, "Perú": 255, "Bolivia": 256, "Chile": 257, "El Salvador": 258, "Guatemala": 259, "Honduras": 260, "Panamá": 261, "República Dominicana": 262, "Puerto Rico": 263, "Costa Rica": 377, "Nicaragua": 378, "Venezuela": 383, "Brasil": 783 },
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

// Cuentas generales de la empresa en Pipedrive («OrderEAT», «Contacto OrderEAT»): no son personas, así que lo que
// tienen a su nombre está libre para cualquiera del equipo (no bloquea ni se avisa como «de otra persona»).
export const FREE_OWNERS = new Set((env.FREE_OWNER_IDS ?? "13493598,12660561").split(",").map(Number).filter(Boolean));
export const DAILY_GOAL = Number(env.DAILY_GOAL || 40);
// Account Executive que da las demos de cada país (ids de usuarios de Pipedrive): lo que se le sugiere a cada SDR en su perfil
// («(sugerido)») hasta que elige el suyo (lib/accounts.js). DEFAULT_ACCOUNTS='{"México":24821777}' lo cambia.
export const DEFAULT_ACCOUNTS = json(env.DEFAULT_ACCOUNTS, { "México": 24821777, "Argentina": 20758179, "Perú": 26099394 });
