// Direcciones escritas a mano («Calle Bugambilias No. 47, Col.Bosques de Amalucan, Puebla, Pue.»): normalizarlas, deducir
// país, estado, ciudad y colonia, y ubicarlas con lo que haya, de lo más exacto a lo más amplio: Google (solo con
// GOOGLE_GEOCODING_KEY o GOOGLE_MAPS_API_KEY), Nominatim y Photon (OpenStreetMap). Nunca se acepta un lugar de otra ciudad,
// otro estado u otro país que el escrito. Reglas puras (pruebas en test/geo.test.mjs); los pedidos se inyectan en
// locateAddress para poder simularlos. lib/scan.js (resolvePlace) arma el lugar que ve la app.

// ---------- texto
export const fold = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const STOP = new Set(["de", "del", "la", "las", "los", "el", "y", "e", "en"]);
// palabras de nombres de lugar que no distinguen uno de otro («Municipio de Puebla» = «Puebla»)
const GENERIC = new Set(["municipio", "partido", "provincia", "departamento", "comuna", "localidad", "distrito", "region", "seccion", "sector", "barrio", "colonia", "fraccionamiento", "heroica", "upz", "upzs", "rap", "especial", "pedania"]);
const stem = w => (w.length > 4 ? w.replace(/s$/, "") : w);
const toks = s => fold(s).split(" ").filter(w => w && !STOP.has(w)).map(stem);
const ptoks = s => toks(s).filter(w => w.length > 1 && !GENERIC.has(w));
const subset = (a, b) => a.length > 0 && a.every(w => b.includes(w));
// Mismo lugar: lo escrito está dentro del nombre del mapa («Puebla» ⊂ «Municipio de Puebla») o al revés
// («Heroica Puebla de Zaragoza» ⊃ «Puebla de Zaragoza»).
export function sameName(written, field) {
  const A = ptoks(written), B = ptoks(field);
  return subset(A, B) || subset(B, A);
}
const SMALL = new Set(["de", "del", "la", "las", "los", "el", "y", "e", "en", "con", "a"]);
// «puebla» o «PUEBLA» → «Puebla»; lo escrito con mayúsculas y minúsculas se deja como está
export function nice(s) {
  s = String(s || "").replace(/\s+/g, " ").trim();
  if (!s || (s !== s.toLowerCase() && s !== s.toUpperCase())) return s;
  return s.toLowerCase().split(" ").map((w, i) => (i && SMALL.has(w) ? w : w.replace(/^(\p{L})/u, m => m.toUpperCase()))).join(" ");
}

// ---------- países, estados y provincias
// [código, nombre, alias (sin tildes ni puntos)]
const COUNTRIES = [
  ["MX", "México", ["mexico", "mx", "estados unidos mexicanos"]], ["AR", "Argentina", ["argentina", "republica argentina"]],
  ["CL", "Chile", ["chile"]], ["PE", "Perú", ["peru"]], ["CO", "Colombia", ["colombia"]], ["UY", "Uruguay", ["uruguay"]],
  ["EC", "Ecuador", ["ecuador"]], ["BO", "Bolivia", ["bolivia"]], ["PY", "Paraguay", ["paraguay"]], ["VE", "Venezuela", ["venezuela"]],
  ["GT", "Guatemala", ["guatemala"]], ["CR", "Costa Rica", ["costa rica"]], ["PA", "Panamá", ["panama"]],
  ["DO", "República Dominicana", ["republica dominicana", "rep dominicana"]], ["HN", "Honduras", ["honduras"]],
  ["SV", "El Salvador", ["el salvador"]], ["NI", "Nicaragua", ["nicaragua"]], ["PR", "Puerto Rico", ["puerto rico"]],
  ["ES", "España", ["espana", "spain"]], ["BR", "Brasil", ["brasil", "brazil"]],
];
const COUNTRY_BY = new Map(COUNTRIES.flatMap(([cc, name, al]) => al.map(x => [x, { cc, name }])));
export const countryName = cc => COUNTRIES.find(c => c[0] === cc)?.[1] || "";
// Estados y provincias: [código, nombre, alias, opciones]. abbr: abreviaturas (siempre son el estado). capital: la capital se
// llama igual («Puebla, Puebla»). city: el lugar ya dice la ciudad (CDMX, CABA). soft: el nombre existe en otro país.
const R = (cc, name, al, o = {}) => ({ cc, name, al, ...o });
const REGIONS = [
  R("MX", "Aguascalientes", ["aguascalientes"], { abbr: ["ags"], capital: true }), R("MX", "Baja California", ["baja california"], { abbr: ["b c", "bc"] }),
  R("MX", "Baja California Sur", ["baja california sur"], { abbr: ["b c s", "bcs"] }), R("MX", "Campeche", ["campeche"], { abbr: ["camp"], capital: true }),
  R("MX", "Chiapas", ["chiapas"], { abbr: ["chis"] }), R("MX", "Chihuahua", ["chihuahua"], { abbr: ["chih"], capital: true }),
  R("MX", "Ciudad de México", ["ciudad de mexico", "cdmx", "cd mx", "cd de mexico", "distrito federal", "mexico d f", "mexico df"], { abbr: ["d f", "df", "cdmx"], city: "Ciudad de México" }),
  R("MX", "Coahuila", ["coahuila", "coahuila de zaragoza"], { abbr: ["coah"] }), R("MX", "Colima", ["colima"], { abbr: ["col"], capital: true }),
  R("MX", "Durango", ["durango"], { abbr: ["dgo"], capital: true }), R("MX", "Guanajuato", ["guanajuato"], { abbr: ["gto"], capital: true }),
  R("MX", "Guerrero", ["guerrero"], { abbr: ["gro"] }), R("MX", "Hidalgo", ["hidalgo"], { abbr: ["hgo"] }), R("MX", "Jalisco", ["jalisco"], { abbr: ["jal"] }),
  R("MX", "Estado de México", ["estado de mexico", "edomex", "edo mex", "edo de mex", "edo mexico", "edo de mexico"], { abbr: ["mex", "edo mex", "edo de mex", "edomex"] }),
  R("MX", "Michoacán", ["michoacan", "michoacan de ocampo"], { abbr: ["mich"] }), R("MX", "Morelos", ["morelos"], { abbr: ["mor"] }),
  R("MX", "Nayarit", ["nayarit"], { abbr: ["nay"] }), R("MX", "Nuevo León", ["nuevo leon"], { abbr: ["n l", "nl"] }),
  R("MX", "Oaxaca", ["oaxaca"], { abbr: ["oax"], capital: true }), R("MX", "Puebla", ["puebla"], { abbr: ["pue"], capital: true }),
  R("MX", "Querétaro", ["queretaro", "queretaro de arteaga"], { abbr: ["qro"], capital: true }), R("MX", "Quintana Roo", ["quintana roo"], { abbr: ["q roo", "qroo", "q r"] }),
  R("MX", "San Luis Potosí", ["san luis potosi"], { abbr: ["s l p", "slp"], capital: true }), R("MX", "Sinaloa", ["sinaloa"], { abbr: ["sin"] }),
  R("MX", "Sonora", ["sonora"], { abbr: ["son"] }), R("MX", "Tabasco", ["tabasco"], { abbr: ["tab"] }), R("MX", "Tamaulipas", ["tamaulipas"], { abbr: ["tamps", "tamp"] }),
  R("MX", "Tlaxcala", ["tlaxcala"], { abbr: ["tlax"], capital: true }), R("MX", "Veracruz", ["veracruz", "veracruz de ignacio de la llave"], { abbr: ["ver"] }),
  R("MX", "Yucatán", ["yucatan"], { abbr: ["yuc"] }), R("MX", "Zacatecas", ["zacatecas"], { abbr: ["zac"], capital: true }),
  // Argentina
  R("AR", "Ciudad Autónoma de Buenos Aires", ["ciudad autonoma de buenos aires", "capital federal", "ciudad de buenos aires"], { abbr: ["caba", "c a b a", "cap fed"], city: "Buenos Aires" }),
  R("AR", "Buenos Aires", ["provincia de buenos aires", "pcia de buenos aires", "prov de buenos aires", "pcia buenos aires"], { abbr: ["bs as", "pba", "pcia de bs as", "pcia bs as", "prov bs as", "provincia de bs as", "prov de bs as"] }),
  R("AR", "Córdoba", ["provincia de cordoba", "pcia de cordoba", "prov de cordoba", "pcia cordoba"]), R("AR", "Santa Fe", ["provincia de santa fe", "pcia de santa fe", "prov de santa fe"]),
  R("AR", "Mendoza", ["mendoza"], { capital: true }), R("AR", "Tucumán", ["tucuman"]), R("AR", "Neuquén", ["neuquen"], { capital: true }), R("AR", "Entre Ríos", ["entre rios"]),
  R("AR", "Salta", ["salta"], { capital: true }), R("AR", "Chubut", ["chubut"]), R("AR", "Corrientes", ["corrientes"], { capital: true }), R("AR", "Jujuy", ["jujuy"]),
  R("AR", "La Pampa", ["la pampa"]), R("AR", "Santiago del Estero", ["santiago del estero"], { capital: true }), R("AR", "Catamarca", ["catamarca"]),
  R("AR", "Formosa", ["formosa"], { capital: true }), R("AR", "Río Negro", ["rio negro"], { soft: true }), R("AR", "Misiones", ["misiones"], { soft: true }),
  R("AR", "Chaco", ["chaco"], { soft: true }), R("AR", "Tierra del Fuego", ["tierra del fuego"], { soft: true }),
  // Chile
  R("CL", "Región Metropolitana de Santiago", ["region metropolitana", "region metropolitana de santiago"], { abbr: ["rm", "r m"] }),
  R("CL", "Valparaíso", ["region de valparaiso", "v region", "quinta region"]), R("CL", "Biobío", ["region del biobio", "biobio", "bio bio"]),
  R("CL", "Araucanía", ["region de la araucania", "araucania"]), R("CL", "Antofagasta", ["region de antofagasta"]), R("CL", "Coquimbo", ["region de coquimbo"]),
  R("CL", "Los Lagos", ["region de los lagos"]), R("CL", "Maule", ["region del maule"]),
  // Perú
  R("PE", "Lima", ["lima metropolitana", "departamento de lima", "provincia de lima"], { city: "Lima" }), R("PE", "Callao", ["callao", "provincia constitucional del callao"], { capital: true }),
  R("PE", "Arequipa", ["arequipa"], { capital: true }), R("PE", "Cusco", ["cusco", "cuzco"], { capital: true }), R("PE", "Piura", ["piura"], { capital: true }),
  R("PE", "Lambayeque", ["lambayeque"]), R("PE", "La Libertad", ["la libertad"], { soft: true }),
  // Colombia
  R("CO", "Bogotá D.C.", ["bogota d c", "bogota dc", "distrito capital", "bogota distrito capital", "santa fe de bogota"], { abbr: ["d c", "dc"], city: "Bogotá" }),
  R("CO", "Antioquia", ["antioquia"]), R("CO", "Cundinamarca", ["cundinamarca"]), R("CO", "Atlántico", ["atlantico"]), R("CO", "Valle del Cauca", ["valle del cauca"]),
  R("CO", "Risaralda", ["risaralda"]), R("CO", "Santander", ["santander"], { soft: true }),
  // Uruguay, Ecuador, Paraguay, Bolivia, Guatemala
  R("UY", "Canelones", ["canelones"], { capital: true }), R("UY", "Maldonado", ["maldonado"], { capital: true, soft: true }),
  R("EC", "Pichincha", ["pichincha"]), R("EC", "Guayas", ["guayas"]), R("EC", "Azuay", ["azuay"]), R("EC", "Manabí", ["manabi"]),
  R("PY", "Central", ["departamento central"]), R("BO", "Santa Cruz", ["departamento de santa cruz"]),
  R("GT", "Guatemala", ["ciudad de guatemala", "guatemala city"], { city: "Guatemala" }),
];
const REGION_BY = new Map();
for (const r of REGIONS) { for (const x of r.al) REGION_BY.set(x, { r, abbr: false }); for (const x of r.abbr || []) REGION_BY.set(x, { r, abbr: true }); }
// Ciudades que solo dan una pista de país (se usa para ordenar, nunca para descartar).
const CITY_HINT = new Map(Object.entries({
  lima: "PE", bogota: "CO", medellin: "CO", cali: "CO", barranquilla: "CO", bucaramanga: "CO", montevideo: "UY", "punta del este": "UY",
  "santiago de chile": "CL", "las condes": "CL", vitacura: "CL", "lo barnechea": "CL", nunoa: "CL", "vina del mar": "CL",
  "buenos aires": "AR", "la plata": "AR", "mar del plata": "AR", rosario: "AR", cordoba: "AR",
  guadalajara: "MX", zapopan: "MX", monterrey: "MX", "san pedro garza garcia": "MX", tijuana: "MX", cancun: "MX", toluca: "MX", puebla: "MX", "puebla de zaragoza": "MX", "heroica puebla de zaragoza": "MX",
  quito: "EC", guayaquil: "EC", asuncion: "PY", "santa cruz de la sierra": "BO", cochabamba: "BO", caracas: "VE",
}));

// ---------- normalizar una dirección
// Tipos de calle: la abreviatura (sin punto, en minúscula) y cómo se escribe.
const TYPE_ABBR = { av: "Avenida", avda: "Avenida", ave: "Avenida", avenida: "Avenida", blvd: "Boulevard", blvrd: "Boulevard", blvr: "Boulevard", blv: "Boulevard", bvd: "Boulevard", bv: "Boulevard", bvar: "Boulevard", bulevar: "Boulevard", boulevard: "Boulevard",
  calz: "Calzada", prol: "Prolongación", priv: "Privada", cda: "Cerrada", cto: "Circuito", carr: "Carretera", cra: "Carrera", kra: "Carrera", kr: "Carrera", cr: "Carrera",
  cll: "Calle", cl: "Calle", dg: "Diagonal", diag: "Diagonal", tv: "Transversal", transv: "Transversal", pje: "Pasaje", psje: "Pasaje", jr: "Jirón", ak: "Avenida Carrera", ac: "Avenida Calle" };
// Palabras abreviadas dentro del nombre.
const WORD_ABBR = { gral: "General", pdte: "Presidente", sta: "Santa", sto: "Santo", fco: "Francisco", dr: "Doctor", lic: "Licenciado", ing: "Ingeniero", prof: "Profesor", gob: "Gobernador", cnel: "Coronel", tte: "Teniente", mtro: "Maestro", sgo: "Santiago", edo: "Estado" };
const CARD = { nte: "Norte", ote: "Oriente", pte: "Poniente" };
// tipos de calle (para comparar nombres: «Calle Bugambilias» = «Bugambilia»; «Calle 100» ≠ «Carrera 100»)
const STREET_TYPES = new Set(["calle", "avenida", "av", "boulevard", "bulevar", "blvd", "calzada", "privada", "cerrada", "andador", "prolongacion", "circuito", "carretera", "camino", "carrera", "diagonal", "transversal", "pasaje", "jiron", "retorno", "callejon", "autopista", "via", "rambla", "ruta", "periferico", "cerrada", "vialidad", "corredor"]);
const CARDINAL = new Set(["norte", "sur", "oriente", "poniente", "este", "oeste"]);
const TYPE_START = /^(calle|c\.|cl+\.?|av\.?|avda\.?|avenida|blvd\.?|blvrd\.?|blvr\.?|bv\.?|bvar\.?|bulevar|boulevard|calz\.?|calzada|carr\.?|carretera|cra\.?|kra\.?|kr\.?|carrera|diag\.?|diagonal|tv\.?|transv\.?|transversal|jr\.?|jir[oó]n|pje\.?|psje\.?|pasaje|camino|privada|priv\.?|cerrada|cda\.?|andador|prol\.?|prolongaci[oó]n|circuito|cto\.?|perif[eé]rico|anillo|viaducto|circunvalaci[oó]n|paseo|eje|ruta|rambla|costanera|malec[oó]n|ak\.?|ac\.?|callej[oó]n|retorno|autopista)\s/i;
const COLONIA_MARK = /^(col\.?|colonia|fracc\.?|fraccionamiento|barrio|b[º°]\.?|urb\.?|urbanizaci[oó]n)\s+/i;
const NUM_MARK = /(?:^|\s)(?:no\.?|n[º°]\.?|n\.[º°]|n[uú]m\.?|n[uú]mero|nro\.?|#|ext\.?|exterior)\s*(?=\d)/i;
const EXTRA = /\b(?:int\.?|interior|depto\.?|dpto\.?|departamento|piso|of\.?|oficina|local|loc\.|torre|mz\.?|manzana|lt\.?|lote|edif\.?|edificio|bloque|apto\.?|apartamento)\s*(?:[a-z]?\d+[a-z]?|[a-z])\b\.?/gi;
const NUMBER = /^\d+[a-z]?(?:-\d+[a-z]?)?$/i;

function expandWords(seg, { street = false } = {}) {
  const ws = seg.split(" ").filter(Boolean);
  return ws.map((w, i) => {
    const k = fold(w).replace(/ /g, "");
    if (street && i === 0 && /^c\.$/i.test(w)) return "Calle";
    if (street && i === 0 && TYPE_ABBR[k] && (k !== "cr" || /\./.test(w))) return TYPE_ABBR[k];
    // «5 Pte.» = poniente (México); «Pte. Riesco» = presidente
    if (CARD[k] && (/\.$/.test(w) || (i > 0 && /\d/.test(ws[i - 1])))) return i > 0 && /\d/.test(ws[i - 1]) ? CARD[k] : k === "pte" ? "Presidente" : CARD[k];
    if (WORD_ABBR[k] && (/\.$/.test(w) || w.length > 2)) return WORD_ABBR[k];
    return w.replace(/\.$/, "");
  }).join(" ");
}
const isType = w => { const k = fold(w).replace(/ /g, ""); return STREET_TYPES.has(k) || !!TYPE_ABBR[k] || /^c\.$/i.test(w); };
const matchRegion = seg => REGION_BY.get(fold(seg)) || null;
const matchCountry = seg => COUNTRY_BY.get(fold(seg)) || null;
const COLONIA_STRIP = /^(col\.?|colonia|fracc\.?|fraccionamiento|b[º°]\.?|urb\.?|urbanizaci[oó]n)\s+/i;
function looksStreet(seg) {
  return TYPE_START.test(seg + " ") || NUM_MARK.test(seg) || /\p{L}.*\s\d+[a-z]?(?:-\d+[a-z]?)?(?:\s+(?:sur|norte|oriente|poniente|este|oeste|nte|ote|pte)\.?)?$/iu.test(seg);
}

// Parte el texto en calle, número, colonia, ciudad, estado, país y código postal, y arma el texto normalizado.
// cc: país que la persona escribió aparte (la app separa «…, México» antes de mandar).
export function parseAddress(input, { cc: given = "" } = {}) {
  const raw = String(input || "").replace(/\s+/g, " ").trim();
  let s = raw.replace(/\([^)]*\)/g, " ").replace(/[;|]/g, ",")
    // pegados: «Col.Bosques», «No.47», «Edo.Méx.», «N°47», «#47»
    .replace(/(\p{L}{2,})\.(?=[\p{L}\d])/gu, "$1. ").replace(/(\b[nN][º°])(?=\d)/g, "$1 ").replace(/#(?=\d)/g, "# ");
  let postcode = "";
  s = s.replace(/(?:^|\s|,)(?:c\.?\s?p\.?|c[oó]digo\s+postal)\s*:?\s*([a-z]?\d{4,7}[a-z]{0,3})\b/gi, (_, p) => { postcode ||= p.toUpperCase(); return ","; });
  s = s.replace(/(?:^|\s)(?:s\/n|s\.\s?n\.|sin\s+n[uú]mero)(?=\s|,|$)/gi, " ").replace(EXTRA, " ");
  // la colonia en el mismo tramo que la calle: «Calle X 12 Col. Centro» → «Calle X 12, Col. Centro»
  s = s.replace(/\s+(?=(?:col\.|colonia|fracc\.|fraccionamiento|urb\.|urbanizaci[oó]n)\s+\p{L})/giu, ", ");
  let segs = s.split(",").map(x => x.replace(/\s+/g, " ").replace(/^[\s.\-–]+|[\s\-–]+$/g, "").trim()).filter(x => x && /[\p{L}\d]/u.test(x));
  // sin comas: «Calle Bugambilias 47 Bosques de Amalucan Puebla» → la calle hasta el número y el resto aparte
  if (segs.length === 1 && (TYPE_START.test(segs[0] + " ") || NUM_MARK.test(segs[0]))) {
    const ws = segs[0].split(" ");
    let cut = -1;
    const mk = ws.findIndex((w, i) => i > 0 && /^(no\.?|n[º°]\.?|n[uú]m\.?|nro\.?|#|ext\.?)$/i.test(w) && /^\d/.test(ws[i + 1] || ""));
    if (mk > 0) cut = mk + 1;
    else for (let i = 1; i < ws.length - 1; i++) if (NUMBER.test(ws[i]) && ws.slice(0, i).some(w => !isType(w) && !/^\d/.test(w))) { cut = i; break; }
    if (cut > 0 && cut < ws.length - 1) segs = [ws.slice(0, cut + 1).join(" "), ws.slice(cut + 1).join(" ")];
  }
  const out = { raw, street: "", number: "", colonia: "", city: "", cityAlt: "", state: "", country: "", cc: "", soft: "", postcode, extra: [], marked: false };
  // del final hacia atrás: país y código postal
  for (let guard = 0; segs.length && guard < 4; guard++) {
    const last = segs[segs.length - 1];
    const c = matchCountry(last);
    if (c && !out.cc && segs.length > 1) { out.cc = c.cc; out.country = c.name; segs.pop(); continue; }
    const pc = last.match(/^([a-z]?\d{4,7}[a-z]{0,3})(?:\s+(.+))?$/i);
    if (pc && segs.length > 1 && !out.postcode && /\d{4}/.test(pc[1]) && !(segs.length === 2 && looksStreet(segs[0]) && !/\d/.test(segs[0]) && !pc[2])) {
      out.postcode = pc[1].toUpperCase(); if (pc[2]) segs[segs.length - 1] = pc[2]; else segs.pop(); continue;
    }
    break;
  }
  // el estado: una abreviatura («Pue.», «N.L.»), CDMX o CABA siempre; un nombre completo, también, salvo que la capital se
  // llame igual y no se repita («Jardines de San Manuel, Puebla»: Puebla es la ciudad, en el estado de Puebla)
  if (segs.length) {
    const last = segs[segs.length - 1], m = matchRegion(last);
    const alone = segs.length === 1 && looksStreet(last);
    // una abreviatura sola («Mex», «Col», «Ver») no es un estado: hace falta algo antes
    if (m && !alone && !(m.abbr && segs.length === 1 && !m.r.city) && (!out.cc || out.cc === m.r.cc)) {
      const before = segs.slice(0, -1), prev = before[before.length - 1];
      const prevSame = !!prev && fold(prev) === fold(last);
      segs.pop();
      if (m.r.city) out.city = m.r.city; // CDMX, CABA, Bogotá D.C.: el lugar es la ciudad
      else {
        out.state = m.r.name;
        if (m.r.capital && !prevSame && !m.abbr) {
          out.city = m.r.name;
          // el tramo de antes puede ser la colonia o la ciudad (otra del mismo estado): vale cualquiera de los dos
          if (prev && !COLONIA_MARK.test(prev) && !(before.length === 1 && looksStreet(prev))) out.cityAlt = prev;
        }
      }
      if (!m.r.soft) out.cc ||= m.r.cc; else out.soft ||= m.r.cc;
    }
  }
  // la calle: el primer tramo si empieza con un tipo de calle o tiene número
  if (segs.length && looksStreet(segs[0]) && !COLONIA_MARK.test(segs[0])) {
    let st = segs.shift().replace(/\s+/g, " ").trim(), num = "";
    const mk = st.match(NUM_MARK);
    if (mk) { const rest = st.slice(mk.index + mk[0].length).trim(); num = (rest.match(/^\d+[a-z]?(?:\s?-\s?\d+[a-z]?)?/i) || [""])[0].replace(/\s/g, ""); st = st.slice(0, mk.index).trim(); }
    else {
      const ws = st.split(" ");
      // número al final («Cabildo 2040») o antes de un punto cardinal («Garza Sada 2501 Sur»); «Boulevard 14 Sur» no tiene número
      let k = ws.length - 1;
      if (k > 0 && CARDINAL.has(fold(expandWords(ws[k], { street: false }))) && NUMBER.test(ws[k - 1])) k--;
      if (k > 0 && NUMBER.test(ws[k]) && ws.slice(0, k).some(w => !isType(w) && !/^\d/.test(w))) { num = ws[k]; st = ws.slice(0, k).join(" "); }
    }
    out.street = nice(expandWords(st, { street: true }));
    out.number = num;
  }
  // el número en su propio tramo («Av. Cabildo, 2040, CABA»)
  if (out.street && !out.number && segs.length && NUMBER.test(segs[0])) out.number = segs.shift();
  // lo que queda: la colonia (marcada, o la primera de varias) y la ciudad (la última)
  // «72310 Heroica Puebla de Zaragoza» (como lo escribe Google): el código postal y la ciudad; «Lima 33» → «Lima»
  const mid = segs.map(x => {
    const m = x.match(/^([a-z]?\d{4,7}[a-z]{0,3})\s+(\p{L}.*)$/iu);
    if (m && /\d{4}/.test(m[1])) { out.postcode ||= m[1].toUpperCase(); x = m[2]; }
    return x.replace(/\s+\d{1,3}$/, "").trim();
  }).filter(Boolean);
  const mi = mid.findIndex(x => COLONIA_MARK.test(x));
  if (mi >= 0) { out.colonia = nice(expandWords(mid[mi].replace(COLONIA_STRIP, ""))); out.marked = true; mid.splice(mi, 1); }
  if (!out.city && mid.length) out.city = nice(expandWords(mid.pop()));
  if (!out.colonia && mid.length) out.colonia = nice(expandWords(mid.shift()));
  out.extra = mid.map(x => nice(expandWords(x)));
  if (out.cityAlt) out.cityAlt = nice(expandWords(out.cityAlt.replace(COLONIA_STRIP, "")));
  splitTail(out);
  if (given && !out.cc) out.cc = given;
  if (!out.cc && !out.soft) {
    const hint = [out.city, out.cityAlt, ...out.extra, out.colonia].map(fold).find(x => CITY_HINT.has(x));
    if (hint) out.soft = CITY_HINT.get(hint);
  }
  if (out.cc && !out.country) out.country = countryName(out.cc);
  const streetFull = [out.street, out.number].filter(Boolean).join(" ");
  out.isAddress = !!(out.street || out.marked || out.postcode);
  // un nombre suelto («Lumbreras de Amalucan»): se busca por nombre
  if (!out.isAddress && !out.colonia && !out.state && out.city) out.name = out.city;
  out.text = [streetFull, out.colonia, out.city, out.state !== out.city ? out.state : "", out.country].filter(Boolean).join(", ");
  out.label = [streetFull, out.colonia, out.city || out.state].filter(Boolean).join(", ") || raw;
  out.key = fold(out.text || raw);
  return out;
}
// Sin comas, el final puede ser el estado o la ciudad: «… Bosques de Amalucan Puebla Pue», «… Puerto Vallarta Jalisco»
function splitTail(out) {
  if (out.state || !out.city || out.colonia || matchRegion(out.city) || CITY_HINT.has(fold(out.city))) return;
  const ws = out.city.split(" ");
  for (let n = Math.min(4, ws.length - 1); n >= 1; n--) {
    const tail = ws.slice(-n).join(" "), head = ws.slice(0, -n).join(" "), m = matchRegion(tail), c = matchCountry(tail);
    // «Ciudad de México», «Santiago de Chile»: el país es parte del nombre
    if (/\b(de|del|la|las|los|el)$/i.test(head)) continue;
    if (c) { out.cc ||= c.cc; out.country ||= c.name; out.city = nice(head); return splitTail(out); }
    if (!m || (out.cc && out.cc !== m.r.cc)) continue;
    // «… Centro Ciudad de México»: la ciudad y, antes, la colonia
    if (m.r.city) { out.city = m.r.city; out.cc ||= m.r.cc; out.colonia = nice(head); return; }
    out.state = m.r.name; if (!m.r.soft) out.cc ||= m.r.cc; else out.soft ||= m.r.cc;
    const h = head.split(" "), m2 = matchRegion(h[h.length - 1]);
    if (m.abbr && m2 && m2.r === m.r) { out.city = m.r.name; if (h.length > 1) out.colonia = nice(h.slice(0, -1).join(" ")); }
    else if (m.r.capital && !m.abbr) { out.city = m.r.name; out.colonia = nice(head); out.cityAlt = out.colonia; }
    else out.city = nice(head);
    return;
  }
}

// ---------- resultados de cada servicio, en un formato común
const ROAD_T = /^(residential|primary|secondary|tertiary|trunk|motorway|living_street|service|unclassified|pedestrian|road|track|footway|steps)(_link)?$/;
const COLONIA_T = /^(suburb|quarter|neighbourhood|neighborhood|hamlet|city_district|borough|residential|isolated_dwelling|allotments)$/;
const CITY_T = /^(city|town|village|municipality)$/;
const REGION_T = /^(state|province|region|county|state_district|department)$/;
export function fromNominatim(p, rank = 0) {
  if (!p || p.lat == null) return null;
  const ad = p.address || {}, t = p.addresstype || p.type, cat = p.category || p.class;
  const level = ad.house_number && (ad.road || ad.pedestrian) ? "house"
    : cat === "highway" && ROAD_T.test(p.type) ? "street"
    : COLONIA_T.test(t) || (cat === "landuse" && p.type === "residential") || (cat === "place" && /^(suburb|quarter|neighbourhood|hamlet|locality)$/.test(p.type)) ? "colonia"
    : CITY_T.test(t) ? "city" : t === "postcode" ? "postcode" : t === "country" ? "country" : REGION_T.test(t) ? "region" : "poi";
  const name = p.name || "";
  return {
    src: "nominatim", rank, level, name, road: ad.road || ad.pedestrian || (level === "street" ? name : ""), num: ad.house_number || "",
    lat: +p.lat, lng: +p.lon, cc: String(ad.country_code || "").toUpperCase(), country: ad.country || "",
    colonias: [level === "colonia" ? name : "", ad.neighbourhood, ad.suburb, ad.quarter, ad.hamlet, ad.residential].filter(Boolean),
    broad: [ad.city_district, ad.borough, ad.district].filter(Boolean),
    places: [ad.city, ad.town, ad.village, ad.municipality, ad.county, ad.city_district, ad.district, ad.borough, ad.suburb, ad.quarter, ad.neighbourhood, ad.hamlet, ad.state_district, ad.region, level === "city" || level === "colonia" ? name : ""].filter(Boolean),
    city: ad.city || ad.town || ad.village || ad.municipality || ad.county || "", state: ad.state || "", postcode: ad.postcode || "",
    osm: p.osm_type && p.osm_id ? `${p.osm_type[0].toUpperCase()}${p.osm_id}` : "", raw: p,
  };
}
export function fromPhoton(f, rank = 0) {
  const p = f?.properties, c = f?.geometry?.coordinates;
  if (!p || !c) return null;
  const level = p.type === "house" ? (p.housenumber ? "house" : p.street ? "street" : "poi") : p.type === "street" ? "street"
    : p.type === "district" || p.type === "locality" ? "colonia" : p.type === "city" ? "city" : p.type === "county" || p.type === "state" ? "region" : p.type === "country" ? "country"
    : (p.osm_key === "landuse" && p.osm_value === "residential") || (p.osm_key === "place" && /^(suburb|neighbourhood|quarter|hamlet)$/.test(p.osm_value)) ? "colonia" : "poi";
  const name = p.name || "";
  return {
    src: "photon", rank, level, name, road: p.type === "street" ? name : p.street || "", num: p.housenumber || "",
    lat: +c[1], lng: +c[0], cc: String(p.countrycode || "").toUpperCase(), country: p.country || "",
    colonias: [level === "colonia" ? name : "", p.locality, p.district].filter(Boolean), broad: [],
    places: [p.city, p.county, p.district, p.locality, level === "city" || level === "colonia" ? name : ""].filter(Boolean),
    city: p.city || p.county || "", state: p.state || "", postcode: p.postcode || "",
    osm: p.osm_type && p.osm_id ? `${p.osm_type}${p.osm_id}` : "", extent: p.extent || null,
  };
}
export function fromGoogle(r, rank = 0) {
  const loc = r?.geometry?.location; if (!loc) return null;
  const comp = (...ts) => r.address_components?.find(c => ts.some(t => c.types.includes(t)));
  const ty = r.types || [];
  const level = ty.some(t => /^(street_address|premise|subpremise)$/.test(t)) ? "house" : ty.includes("route") ? "street"
    : ty.some(t => /^(neighborhood|sublocality)/.test(t)) ? "colonia" : ty.includes("locality") ? "city" : ty.includes("postal_code") ? "postcode" : ty.some(t => /^administrative_area/.test(t)) ? "region" : "poi";
  const ln = (...ts) => comp(...ts)?.long_name || "";
  return {
    src: "google", rank, level, name: r.formatted_address || "", road: ln("route"), num: ln("street_number"), lat: +loc.lat, lng: +loc.lng,
    cc: comp("country")?.short_name || "", country: ln("country"), approx: r.geometry.location_type === "APPROXIMATE" || !!r.partial_match,
    colonias: [ln("neighborhood"), ln("sublocality_level_1"), ln("sublocality")].filter(Boolean), broad: [],
    places: [ln("locality"), ln("administrative_area_level_2"), ln("administrative_area_level_3"), ln("sublocality_level_1"), ln("sublocality"), ln("neighborhood")].filter(Boolean),
    city: ln("locality") || ln("administrative_area_level_2"), state: ln("administrative_area_level_1"), postcode: ln("postal_code"), osm: "", label: r.formatted_address || "",
  };
}

// ---------- reglas: ¿es lo escrito?
// Mismo país (si se sabe), mismo estado (si se escribió) y la ciudad escrita en alguno de sus lugares (ciudad, municipio,
// localidad…; nunca solo el estado: «Puebla» no acepta un pueblo del estado de Puebla).
export function fits(h, a, ccs = []) {
  if (!h || !h.cc) return false;
  if (ccs.length && !ccs.includes(h.cc)) return false;
  if (a.state && h.state && !sameName(a.state, h.state)) return false;
  if (a.city) {
    const ok = n => sameName(a.city, n) || (a.cityAlt && sameName(a.cityAlt, n));
    // la capital escrita como ciudad («…, Puebla») vale también para la región del mismo nombre
    if (!h.places.some(ok) && !(h.level === "region" && ok(h.name))) return false;
  } else if (!a.state && !a.cc) {
    // sin ciudad, estado ni país escritos: alguno de sus lugares tiene que estar nombrado en el texto
    const t = ptoks(a.raw);
    if (!h.places.some(n => subset(ptoks(n), t)) && !subset(ptoks(h.state), t)) return false;
  }
  return true;
}
const streetParts = name => {
  const w = fold(name).split(" ").filter(Boolean);
  const types = [], core = [];
  for (const x of w) { if (!core.length && STREET_TYPES.has(x)) types.push(x === "bulevar" || x === "blvd" ? "boulevard" : x === "av" ? "avenida" : x); else if (!STOP.has(x)) core.push(stem(x)); }
  return { types, core };
};
// «Calle Bugambilias» = «Calle Bugambilia»; «Eje Central Lázaro Cárdenas» ≈ «Avenida Lázaro Cárdenas»;
// los nombres que son solo un número («Calle 100», «14 Sur») piden el mismo tipo de calle (Calle ≠ Carrera).
export function streetMatch(written, road) {
  if (!written || !road) return false;
  const A = streetParts(written), B = streetParts(road);
  if (!A.core.length || !B.core.length) return false;
  const numeric = A.core.every(w => /^\d+[a-z]?$/.test(w) || CARDINAL.has(w));
  if (numeric) {
    if (!(subset(A.core, B.core) && subset(B.core, A.core))) return false;
    return !A.types.length || !B.types.length || A.types.some(t => B.types.includes(t));
  }
  return subset(A.core, B.core) || (subset(B.core, A.core) && B.core.some(w => !/^\d/.test(w) && w.length > 3));
}
const cleanNum = n => fold(n).replace(/ /g, "");
export const sameNumber = (a, b) => !!a && !!b && String(b).split(/[,;]/).some(x => cleanNum(x) === cleanNum(a));
// 2: la colonia o el barrio del lugar; 1: una zona más grande con ese nombre («Zona Centro» de Guadalajara es también un distrito)
// (también si lo escrito como colonia es su municipio o distrito: «Surco» = Santiago de Surco, «Las Condes»)
export const colLevel = (h, a) => !a.colonia ? 0 : h.colonias.some(n => sameName(a.colonia, n)) ? 2
  : (h.broad || []).concat(h.places || []).some(n => sameName(a.colonia, n) && !(a.city && sameName(a.city, n))) ? 1 : 0;
export const pcMatch = (h, a) => !!a.postcode && !!h.postcode && fold(h.postcode).replace(/ /g, "") === fold(a.postcode).replace(/ /g, "");
// el código postal ancla salvo que el lugar diga estar en otra colonia que la escrita (en el mapa hay códigos mal cargados)
const pcOk = (h, a) => pcMatch(h, a) && (!a.colonia || !h.colonias.length || colLevel(h, a) > 0);
export function km(a, b) { const R = 6371, r = x => x * Math.PI / 180; const dLa = r(b.lat - a.lat), dLo = r(b.lng - a.lng); const h = Math.sin(dLa / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); }
const clustered = (list, d = 2.5) => list.every(x => km(x, list[0]) <= d);
const order = (a, pref) => (x, y) => score(y, a, pref) - score(x, a, pref);
function score(h, a, pref) {
  return colLevel(h, a) * 2 + (pcOk(h, a) ? 4 : 0) + (sameNumber(a.number, h.num) ? 6 : 0) + (h.level === "house" ? 0.5 : 0)
    + (pref && h.cc === pref ? 0.5 : 0) + (h.src === "google" ? 0.3 : h.src === "nominatim" ? 0.2 : 0) - h.rank * 0.02;
}
const numOf = n => { const m = String(n || "").match(/^\d+/); return m ? +m[0] : NaN; };
// El mismo número o el más cercano de la misma calle (hasta 300 de diferencia: unas cuadras).
function byNumber(pool, a) {
  if (!a.number) return null;
  const exact = pool.filter(h => sameNumber(a.number, h.num));
  if (exact.length) return { hit: exact[0], level: "house" };
  // «15-20» (Colombia) no es un número de puerta: solo vale el mismo
  const n = numOf(a.number); if (!Number.isFinite(n) || /-/.test(a.number)) return null;
  const near = pool.filter(h => h.level === "house" && Number.isFinite(numOf(h.num)) && Math.abs(numOf(h.num) - n) <= 300).sort((x, y) => Math.abs(numOf(x.num) - n) - Math.abs(numOf(y.num) - n));
  return near.length ? { hit: near[0], level: "near" } : null;
}
// Entre las calles encontradas: anclada por colonia, código postal o número exacto; si no se escribió colonia ni código
// postal, la mejor. Si se escribió y nada coincide, se espera a ubicar la colonia (pending).
export function pickStreet(hits, a, pref = "") {
  if (!a.street) return null;
  const S = hits.filter(h => (h.level === "house" || h.level === "street") && streetMatch(a.street, h.road)).sort(order(a, pref));
  if (!S.length) return null;
  // anclada: en la colonia escrita (la colonia misma antes que una zona más grande) o con el código postal escrito
  const fine = S.filter(h => colLevel(h, a) === 2 || pcOk(h, a));
  const anchored = fine.length ? fine : S.filter(h => colLevel(h, a) === 1);
  if (anchored.length) {
    const pool = anchored.concat(S.filter(h => !anchored.includes(h) && anchored.some(x => km(x, h) < 1.2)));
    return byNumber(pool, a) || { hit: anchored[0], level: "street" };
  }
  // con colonia o código postal escritos y nada que coincida, ni el número exacto alcanza (en CDMX la numeración vuelve a
  // empezar en cada colonia): primero se ubica la colonia
  if (a.colonia || a.postcode) return { pending: S };
  const r = byNumber(S.filter(h => sameNumber(a.number, h.num)).concat(S), a) || { hit: S[0], level: "street" };
  // la misma calle en otra punta de la ciudad (otro barrio): se ofrecen como alternativas
  const far = S.filter(h => km(h, r.hit) > 2.5 && h.osm);
  if (far.length) r.alts = far.filter((h, i) => far.findIndex(x => km(x, h) < 1) === i).slice(0, 3);
  return r;
}
// Calles candidatas cerca de un punto (la colonia o el código postal ubicados): la del número, si no la más cercana.
function streetNear(S, p, a, d = 1.5) {
  const near = S.filter(h => km(h, p) <= d).sort((x, y) => km(x, p) - km(y, p));
  if (!near.length) return null;
  return byNumber(near, a) || { hit: near[0], level: "street" };
}

// ---------- Colombia: «Calle 100 # 15-20» es la Calle 100 a la altura de la Carrera 15 (el cruce de las dos calles)
const CROSS = { calle: "Carrera", "avenida calle": "Carrera", carrera: "Calle", "avenida carrera": "Calle", diagonal: "Transversal", transversal: "Diagonal" };
export function crossOf(a) {
  if (a.cc && a.cc !== "CO") return null;
  const m = String(a.number || "").match(/^(\d+[a-z]?)-\d+/i); if (!m) return null;
  const t = fold(a.street).match(/^(avenida calle|avenida carrera|calle|carrera|diagonal|transversal)\b/); if (!t) return null;
  return `${CROSS[t[1]]} ${m[1].toUpperCase()}`;
}
const reEsc = s => s.replace(/[.*+?^${}()|[\]\\"]/g, "[$&]");
// Nombre de una calle para Overpass: «Calle 100» → «^(Avenida |Av[.]? )?Calle 100( Bis)?$»
export const streetRegex = name => { const n = String(name).replace(/^Avenida\s+/i, ""); return `^(Avenida |Av[.]? )?${reEsc(n)}( Bis)?$`; };
export function cornerQuery(street, cross, pts) {
  const pad = 0.02, la = pts.map(h => h.lat), ln = pts.map(h => h.lng);
  const bb = [Math.min(...la) - pad, Math.min(...ln) - pad, Math.max(...la) + pad, Math.max(...ln) + pad].map(x => x.toFixed(4)).join(",");
  return `way(${bb})["highway"]["name"~"${streetRegex(street)}",i]->.a;way(${bb})["highway"]["name"~"${streetRegex(cross)}",i]->.b;node(w.a)(w.b);out 5;`;
}

// Sin Overpass: el cruce por los recuadros (extent de Photon: [oeste, norte, este, sur]) de los tramos de las dos calles.
// Del par más cercano (a menos de 600 m), la latitud de la que corre de este a oeste y la longitud de la que corre de norte a sur.
export function crossPoint(A, B, maxKm = 0.6) {
  const box = h => { const [w, n, e, s] = h.extent; const cos = Math.cos(((n + s) / 2) * Math.PI / 180); return { w, n, e, s, lat: (n + s) / 2, lng: (w + e) / 2, ew: (e - w) * cos >= n - s, cos }; };
  let best = null;
  for (const a of A) for (const b of B) {
    if (!a.extent || !b.extent) continue;
    const x = box(a), y = box(b);
    const dx = Math.max(0, Math.max(x.w, y.w) - Math.min(x.e, y.e)) * 111.32 * x.cos, dy = Math.max(0, Math.max(x.s, y.s) - Math.min(x.n, y.n)) * 110.57;
    const d = Math.hypot(dx, dy);
    if (d > maxKm || (best && d >= best.d)) continue;
    const pt = x.ew && !y.ew ? { lat: x.lat, lng: y.lng } : !x.ew && y.ew ? { lat: y.lat, lng: x.lng } : { lat: (x.lat + y.lat) / 2, lng: (x.lng + y.lng) / 2 };
    best = { ...pt, d };
  }
  return best;
}

// ---------- la cadena de intentos
// providers (se inyectan): nominatim(params, { timeout, deadline }), photon(params, …), google(params, …)?, overpass(query, …)?
// Devuelven la respuesta cruda o tiran error; un error con skip: true es «no hubo tiempo» (no cuenta como falla).
// raw: lo que ya devolvió Nominatim con el texto tal cual (o una función que lo trae).
// Devuelve { hit, level, note, alts, partial } o null; { failed: true } si algo no respondió y no se encontró nada.
// Niveles: house (el número), near (otro número de la misma calle), corner (cruce), street, colonia, postcode, city, region.
export async function locateAddress(a, { raw = [], nominatim, photon, google = null, overpass = null, codes = [], prefer = "", deadline = Date.now() + 9000, now = () => Date.now() } = {}) {
  const ccs = a.cc ? [a.cc] : codes, pref = a.cc || a.soft || prefer;
  const hits = [], st = { failed: 0, skipped: 0 };
  let rank = 0;
  const left = () => deadline - now();
  const add = (list, conv) => { const out = []; for (const x of Array.isArray(list) ? list : []) { const h = conv(x, rank++); if (h && fits(h, a, ccs)) { hits.push(h); out.push(h); } } return out; };
  // cada pedido, con su tope (4,5 s); end: hasta cuándo puede empezar (la ciudad tiene 1,5 s de gracia)
  const call = async (fn, arg, min = 700, end = deadline, cap = 4500) => {
    if (!fn) return null;
    const rest = end - now();
    if (rest < min) { st.skipped++; return null; }
    try { return await fn(arg, { timeout: Math.max(1000, Math.min(cap, rest - 200)), deadline: end }); } catch (e) { if (e?.skip) st.skipped++; else st.failed++; return null; }
  };
  const nom = async (params, min, end) => add(await call(nominatim, { countrycodes: ccs.join(","), ...params }, min, end), fromNominatim);
  const pho = async params => add((await call(photon, { cc: ccs, ...params }))?.features, fromPhoton);
  const streets = () => hits.filter(h => (h.level === "house" || h.level === "street") && streetMatch(a.street, h.road)).sort(order(a, pref));
  // Colombia: antes de quedarse con «la Calle 100» (que cruza media ciudad), el cruce con la Carrera 15
  const cross = crossOf(a);
  let cornerTried = false;
  const corner = async S => {
    if (!cross || cornerTried || !S.length || left() < 1500) return null;
    cornerTried = true;
    // el cruce exacto en Overpass; si no responde, por los tramos de las dos calles en Photon
    if (overpass && left() > 3000) {
      const els = await call(overpass, cornerQuery(a.street, cross, S.slice(0, 12)), 2500, deadline, 3000);
      const n = (Array.isArray(els) ? els : []).find(e => e.lat != null);
      if (n) return { hit: { ...S[0], lat: +n.lat, lng: +n.lon, src: "overpass", num: "" }, level: "corner", cross };
    }
    const near = { lat: S.reduce((t, h) => t + h.lat, 0) / S.length, lng: S.reduce((t, h) => t + h.lng, 0) / S.length };
    const q = name => ({ q: [name, a.city].filter(Boolean).join(" "), layer: ["street"], cc: ccs, near, limit: 15 });
    const [ra, rb] = await Promise.all([call(photon, q(a.street), 1200), call(photon, q(cross), 1200)]);
    const conv = (r, name) => (r?.features || []).map(f => fromPhoton(f, 0)).filter(h => h && h.extent && streetMatch(name, h.road) && fits(h, a, ccs));
    const p = crossPoint(conv(ra, a.street), conv(rb, cross));
    return p ? { hit: { ...S[0], lat: p.lat, lng: p.lng, src: "photon", num: "" }, level: "corner", cross } : null;
  };
  // una calle sin el número escrito se guarda y se sigue buscando el número en Nominatim (pasos 4 y 5) antes de quedarse con ella
  let held = null;
  const RANKL = { house: 4, corner: 3.5, near: 3, street: 2 };
  const settle = r => {
    if (!r?.hit) return false;
    if (r.level === "house" || (!a.number && !cross)) return true;
    if (!held || RANKL[r.level] > RANKL[held.level]) held = r;
    return false;
  };
  const finish = async r => {
    if (r && r.level === "street" && cross) r = (await corner(streets())) || r;
    const partial = st.failed + st.skipped > 0;
    return r && { ...r, note: noteFor(r, a, { partial }), alts: r.alts || [], partial };
  };
  const streetFull = [a.street, a.number].filter(Boolean).join(" ");
  const notCity = x => (x && x !== a.city ? x : "");
  const placeWords = [a.colonia, a.city, notCity(a.state)].filter(Boolean).join(" ");

  // 1) Google (solo con clave): direcciones con calle, al número o a la calle
  if (google && a.street) {
    const g = await call(google, { address: a.text, cc: a.cc || "", region: (a.cc || pref || "").toLowerCase() });
    const gh = add(g?.results, fromGoogle).filter(h => !h.approx);
    const r = pickStreet(gh, a, pref);
    if (r?.hit) return finish(r);
  }
  // 2) Photon arranca ya, en paralelo con Nominatim (que va de a un pedido por segundo)
  const P = [];
  if (a.street) {
    P.push(pho({ q: [streetFull, placeWords].filter(Boolean).join(" "), layer: ["house", "street"] }));
    if (a.postcode) P.push(pho({ q: `${a.street} ${a.postcode}`, layer: ["house", "street"] }));
  } else if (a.colonia || a.name) P.push(pho({ q: [a.colonia || a.name, a.city !== a.name ? a.city : "", notCity(a.state)].filter(Boolean).join(" ") }));
  // 3) Nominatim con el texto tal cual
  add(typeof raw === "function" ? await call(raw, null) : raw, fromNominatim);
  let r = pickStreet(hits, a, pref);
  if (settle(r)) return finish(r);
  // 4) el texto normalizado (sin «No.», «Col.», «C.P.»; estado y país escritos completos)
  if (a.text && fold(a.text) !== fold(a.raw)) { await nom({ q: a.text }); r = pickStreet(hits, a, pref); if (settle(r)) return finish(r); }
  await Promise.all(P);
  r = pickStreet(hits, a, pref); if (settle(r)) return finish(r);
  // Colombia: con la calle ya ubicada, el cruce antes que nada más. Sin el cruce, una calle larga no dice dónde: la ciudad.
  let crossMiss = false;
  if (cross && streets().length) {
    const c = await corner(streets()); if (c) return finish(c);
    if (clustered(streets())) return finish({ hit: streets()[0], level: "street" });
    crossMiss = true; held = null;
  }
  // 5) Nominatim estructurado: calle y número, ciudad, estado y país (sin la colonia, que suele faltar en el mapa)
  if (a.street && (a.city || a.state) && !crossMiss && (!held || left() > 2500)) {
    await nom({ street: [a.number, a.street].filter(Boolean).join(" "), city: a.city || "", state: notCity(a.state), country: a.country || "" });
    r = pickStreet(hits, a, pref); if (settle(r)) return finish(r);
  }
  if (held) return finish(held);
  // 6) Photon solo con la calle y la ciudad (la colonia o el número a veces lo confunden)
  if (a.street && !streets().length && !crossMiss) {
    await pho({ q: [a.street, a.city, notCity(a.state)].filter(Boolean).join(" "), layer: ["street", "house"] });
    r = pickStreet(hits, a, pref); if (r?.hit) return finish(r);
  }
  const S = crossMiss ? [] : streets();
  const c0 = await corner(S);
  if (c0) return finish(c0);
  // 7) la colonia o el barrio: si la calle aparece cerca, la calle; si no, la colonia (7 y 8, solo si queda tiempo para la ciudad)
  if (a.colonia && left() > 1800) {
    const real = () => hits.filter(h => h.level === "colonia" && sameName(a.colonia, h.name)).sort(order(a, pref))[0];
    let col = real();
    if (!col) { await nom({ q: [a.colonia, a.city, notCity(a.state), a.country].filter(Boolean).join(", ") }); col = real(); }
    if (!col && a.street) { await pho({ q: [a.colonia, a.city, notCity(a.state)].filter(Boolean).join(" ") }); col = real(); }
    // sin la colonia como lugar: calles que dicen estar en ella (aproximado)
    if (!col) {
      const cand = hits.filter(h => h.level !== "city" && h.level !== "region"), fine = cand.filter(h => colLevel(h, a) === 2);
      const inside = fine.length ? fine : cand.filter(h => colLevel(h, a) === 1);
      if (inside.length) col = { ...inside[0], level: "colonia", approx: true };
    }
    if (col) {
      const s = streetNear(S, col, a);
      return finish(s ? { ...s, via: "colonia" } : { hit: col, level: "colonia" });
    }
  }
  // 8) el código postal
  if (a.postcode && left() > 1500) {
    let pc = hits.find(h => h.level === "postcode" && pcMatch(h, a));
    if (!pc) { await nom({ postalcode: a.postcode, country: a.country || "" }); pc = hits.find(h => h.level === "postcode"); }
    if (pc) {
      const s = streetNear(S, pc, a, 1.2);
      return finish(s ? { ...s, via: "postcode" } : { hit: pc, level: "postcode" });
    }
  }
  // 9) la calle sin colonia confirmada: si todas las que aparecen están juntas, es esa
  const ex = S.filter(h => sameNumber(a.number, h.num));
  if (ex.length && clustered(ex)) return finish({ hit: ex[0], level: "house", unconfirmed: true });
  if (S.length && clustered(S)) return finish({ ...(byNumber(S, a) || { hit: S[0], level: "street" }), unconfirmed: true });
  // 10) un nombre suelto que Nominatim no encontró: solo si el nombre del mapa lo contiene entero
  if (a.name) {
    const nm = hits.filter(h => !["street", "house", "poi"].includes(h.level) && subset(ptoks(a.name), ptoks(h.name))).sort(order(a, pref))[0];
    if (nm) return finish({ hit: nm, level: nm.level === "city" || nm.level === "region" ? nm.level : "colonia" });
    if (!a.state && !a.cc) return st.failed || st.skipped ? { failed: true } : null;
  }
  // 11) la ciudad (o el estado)
  if (a.city || a.state) {
    const isCity = h => a.city ? (h.level === "city" || h.level === "region") && (sameName(a.city, h.name) || (h.level === "city" && sameName(h.name, a.city)))
      : h.level === "region" && sameName(a.state, h.name);
    const best = () => hits.filter(isCity).sort((x, y) => (y.level === "city") - (x.level === "city") || order(a, pref)(x, y))[0];
    let c = best();
    if (!c || c.level !== "city") { await nom({ q: [a.city, notCity(a.state), a.country].filter(Boolean).join(", ") }, 500, deadline + 1500); c = best(); }
    if (c) return finish({ hit: c, level: a.city ? "city" : "region", ambiguous: S.length > 1, crossMiss: crossMiss && cross, alts: S.filter(h => h.osm).slice(0, 3) });
  }
  return st.failed || st.skipped ? { failed: true } : null;
}

// ---------- qué se encontró y qué no, en palabras (va debajo del lugar en Prospectar)
// partial: algún pedido no respondió, así que no se puede decir que algo «no figura» (se dice que no apareció).
export function noteFor(r, a, { partial = false } = {}) {
  const t = noteText(r, a);
  if (!partial || !/no figuran? en OpenStreetMap/.test(t)) return t;
  return t.replace(/no (figura|figuran) en OpenStreetMap/g, (_, v) => (v === "figura" ? "no apareció" : "no aparecieron")).replace(/\.$/, " (OpenStreetMap respondió a medias: probá de nuevo en un rato).");
}
function noteText(r, a) {
  const h = r.hit, mx = (a.cc || h.cc) === "MX";
  const colW = mx ? "la colonia" : "el barrio";
  const city = a.city || h.city || "";
  const where = (h.colonias?.[0] && !sameName(h.colonias[0], city) ? h.colonias[0] : "") || "";
  const street = h.road || a.street;
  switch (r.level) {
    case "house": return r.unconfirmed && a.colonia ? `Ubiqué el número en ${street}${where ? ` (${where})` : ""}; no encontré ${colW} ${a.colonia}.` : "";
    case "near": return `El ${a.number} no figura en OpenStreetMap: ubiqué el ${h.num} de ${street}${where ? ` (${where})` : ""}.`;
    case "corner": return `Ubiqué ${a.street} a la altura de la ${r.cross}.`;
    case "street": {
      const miss = [a.number && `el número ${a.number} no figura en OpenStreetMap`, r.unconfirmed && a.colonia && `no encontré ${colW} ${a.colonia}`].filter(Boolean);
      if (miss.length) return `Ubiqué ${street}${where ? ` (${where})` : ""}; ${miss.join(" y ")}.`;
      return r.alts?.length ? `Ubiqué ${street}${where ? ` (${where})` : ""}. También aparece en otras partes de ${city || "la ciudad"}: sumá ${colW} para precisar.` : "";
    }
    case "colonia": {
      const nm = a.colonia || h.name;
      return `Ubiqué ${colW} ${nm}${city && !sameName(city, nm) ? ` (${city})` : ""}${a.street ? "; la calle exacta no figura en OpenStreetMap" : ""}${h.approx ? " (aproximado)" : ""}.`;
    }
    case "postcode": {
      const miss = [a.street && "la calle", a.colonia && colW].filter(Boolean);
      return `Ubiqué el código postal ${a.postcode}${city ? ` (${city})` : ""}${miss.length ? `; ${miss.join(" y ")} no ${miss.length > 1 ? "figuran" : "figura"} en OpenStreetMap` : ""}.`;
    }
    case "city": case "region": {
      const nm = r.level === "region" ? a.state || h.name : a.city || h.name;
      const miss = [a.street && "la calle", a.colonia && colW].filter(Boolean);
      if (r.crossMiss) return `No ubiqué el cruce de ${a.street} con la ${r.crossMiss}: te muestro ${nm}.`;
      if (r.ambiguous && a.colonia) return `${a.street} aparece en varias partes de ${nm} y no encontré ${colW} ${a.colonia}: te muestro ${nm}.`;
      if (r.ambiguous) return `${a.street} aparece en varias partes de ${nm}: sumá ${colW} para precisar. Te muestro ${nm}.`;
      return miss.length ? `Ubiqué ${nm}; ${miss.join(" y ")} no ${miss.length > 1 ? "figuran" : "figura"} en OpenStreetMap.` : "";
    }
    default: return "";
  }
}

// ---------- servicios (los usa lib/scan.js; las pruebas los simulan)
const UA = { "user-agent": "OrderBrain-SDR/1.0 (school prospecting)" };
// Photon no filtra por país: con un solo país se le pasa su recuadro
const BBOX = { MX: [-118.6, 14.3, -86.5, 32.8], AR: [-73.6, -55.1, -53.6, -21.7], CL: [-76, -56, -66.4, -17.4], PE: [-81.4, -18.4, -68.6, 0], CO: [-79.1, -4.3, -66.8, 13.5],
  UY: [-58.5, -35.1, -53, -30], EC: [-81.1, -5.1, -75.2, 1.7], BO: [-69.7, -23, -57.4, -9.6], PY: [-62.7, -27.6, -54.2, -19.3], VE: [-73.4, 0.6, -59.7, 12.3],
  GT: [-92.3, 13.7, -88.2, 17.9], CR: [-86, 8, -82.5, 11.3], PA: [-83.1, 7.1, -77.1, 9.7], DO: [-72.1, 17.4, -68.3, 20], HN: [-89.4, 12.9, -83.1, 16.6],
  SV: [-90.2, 13.1, -87.6, 14.5], NI: [-87.7, 10.7, -82.6, 15.1], PR: [-67.3, 17.9, -65.2, 18.6], ES: [-9.4, 35.9, 4.4, 43.8] };
// near: { lat, lng } prioriza lo cercano (sin descartar lo demás)
export const photonUrl = ({ q, layer = [], cc = [], near = null, limit = 12 }, base = process.env.PHOTON_URL || "https://photon.komoot.io") => {
  const u = new URLSearchParams({ q, limit: String(limit) });
  for (const l of layer) u.append("layer", l);
  if (cc.length === 1 && BBOX[cc[0]]) u.set("bbox", BBOX[cc[0]].join(","));
  if (near) { u.set("lat", near.lat.toFixed(5)); u.set("lon", near.lng.toFixed(5)); }
  return `${base.replace(/\/$/, "")}/api/?${u}`;
};
export async function photonSearch(params, { timeout = 6000 } = {}) {
  const r = await fetch(photonUrl(params), { headers: UA, signal: AbortSignal.timeout(timeout) });
  if (!r.ok) throw new Error(`Photon ${r.status}`);
  return r.json();
}
// Google Geocoding (opcional): con un país, se limita a ese país; si no, solo lo prefiere (region).
export const googleKey = () => process.env.GOOGLE_GEOCODING_KEY || process.env.GOOGLE_MAPS_API_KEY || "";
let googleWarned = false;
export async function googleGeocode({ address, cc, region }, { timeout = 6000 } = {}) {
  const key = googleKey(); if (!key) return null;
  const u = new URLSearchParams({ address, key, language: "es" });
  if (cc) u.set("components", `country:${cc}`); else if (region) u.set("region", region);
  const r = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?${u}`, { signal: AbortSignal.timeout(timeout) });
  if (!r.ok) throw new Error(`Google ${r.status}`);
  const j = await r.json();
  if (j.status === "ZERO_RESULTS") return { results: [] };
  if (j.status !== "OK") {
    // REQUEST_DENIED: la clave no tiene habilitada la Geocoding API. Se avisa una vez en el log y se sigue con OpenStreetMap.
    if (!googleWarned) { googleWarned = true; console.warn(`⚠ Google Geocoding: ${j.status}${j.error_message ? ` (${j.error_message})` : ""}. Sigo con OpenStreetMap.`); }
    return { results: [] };
  }
  return j;
}
const OVERPASS = (process.env.OVERPASS_URLS || "https://overpass-api.de/api/interpreter").split(",")[0];
export async function overpassQuick(q, { timeout = 5000 } = {}) {
  const t = Math.max(2, Math.floor(timeout / 1000));
  const r = await fetch(OVERPASS, { method: "POST", headers: { ...UA, "content-type": "application/x-www-form-urlencoded" }, body: "data=" + encodeURIComponent(`[out:json][timeout:${t}];${q}`), signal: AbortSignal.timeout(timeout) });
  if (!r.ok) throw new Error(`Overpass ${r.status}`);
  return (await r.json()).elements || [];
}
