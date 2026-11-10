// Potencial de un colegio para OrderEAT: un distintivo «Alto potencial» para contactarlo antes que el resto.
// Solo con datos reales del colegio, y cada punto dice por qué (se muestra tal cual en la lista y la ficha):
//  - privado confirmado en el mapa (los públicos no compran),
//  - bilingüe o internacional (cuota más alta, familias que valoran la app),
//  - varios niveles: de preescolar o primaria hasta secundaria o prepa (más alumnos, más consumo),
//  - parte de una red o congregación (una venta puede abrir varias sedes),
//  - clientes de OrderEAT cerca (referencias de la zona),
//  - el encaje que dio el estudio con IA, si se hizo.
// Las universidades van por otro producto (OrderGO): no llevan este distintivo.
const W = { privado: 2, privadoNombre: 1, bilingue: 2, niveles3: 2, niveles2: 1, red: 1, cerca: 2, fitAlto: 3, fitBajo: -4 };
export const POTENTIAL_MIN = 4;
export function potentialOf(s, { nearClients = 0, fit = s?.fit || "" } = {}) {
  if (!s) return null;
  const opp = s.opp || [], why = [];
  if (opp.includes("Universidad (OrderGO)") || /\buniversi(dad|ty|tario|taria)\b/i.test(s.name || "")) return { points: 0, high: false, why: [] };
  let p = 0;
  if (s.private === "seguro" || opp.includes("Privado confirmado en el mapa")) { p += W.privado; why.push("Privado confirmado"); }
  else if (s.private === "probable") { p += W.privadoNombre; why.push("Privado según su nombre"); }
  if (opp.includes("Bilingüe o internacional")) { p += W.bilingue; why.push("Bilingüe o internacional"); }
  const lv = (s.levels || []).filter(l => l !== "Universidad");
  if (lv.length >= 3) { p += W.niveles3; why.push(`${lv[0]} a ${lv[lv.length - 1].toLowerCase()}`); }
  else if (lv.length === 2) { p += W.niveles2; why.push(`${lv[0]} y ${lv[1].toLowerCase()}`); }
  if (opp.includes("Confesional (puede ser parte de una red)")) { p += W.red; why.push("Puede ser parte de una red"); }
  if (nearClients > 0) { p += W.cerca; why.push(`${nearClients} cliente${nearClients > 1 ? "s" : ""} de OrderEAT a menos de 3 km`); }
  if (fit === "alto") { p += W.fitAlto; why.push("Encaje alto según el estudio"); }
  else if (fit === "bajo") p += W.fitBajo;
  // además de los puntos, hace falta al menos una señal fuerte: si no, cualquier parroquial privado con dos niveles calificaría
  const strong = opp.includes("Bilingüe o internacional") || lv.length >= 3 || nearClients > 0 || fit === "alto";
  return { points: p, high: p >= POTENTIAL_MIN && strong, why };
}
