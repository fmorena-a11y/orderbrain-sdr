// Período: un solo selector para Métricas y Equipo › Demos (mismo aspecto, misma forma de elegir) y una preferencia compartida
// («ob.period»: lo último que se eligió en cualquiera de las dos). Cada vista ofrece solo lo que entiende:
//  · Métricas: 7, 30 o 90 días, «Este mes» y «Este trimestre» (hasta hoy).
//  · Equipo › Demos: «Este mes», «Este trimestre» y, en «Otro mes o trimestre», los meses y trimestres desde enero del año
//    anterior (los que manda el servidor en choices: nada del futuro).
// Valores: 7 | 30 | 90 | "mes" | "trim" | "2026-10" (un mes) | "2026-Q3" (un trimestre). El mes o el trimestre en curso escritos
// como clave valen lo mismo que «mes» / «trim» (normPeriod). Lo que una vista no entiende no se usa: vuelve a lo último suyo.
// Módulo puro (sin DOM ni core.js): pruebas en test/period.test.mjs.
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const REL = [[7, "7 días"], [30, "30 días"], [90, "90 días"], ["mes", "Este mes"], ["trim", "Este trimestre"]];
export const isMonthKey = v => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(v));
export const isQuarterKey = v => /^\d{4}-Q[1-4]$/.test(String(v));
export const curMonth = today => String(today).slice(0, 7);
export const curQuarter = today => `${String(today).slice(0, 4)}-Q${Math.floor((+String(today).slice(5, 7) - 1) / 3) + 1}`;
// «7» (de un data-*) → 7; el mes o el trimestre en curso → «mes» / «trim»; lo que no es un período → null
export function normPeriod(v, today) {
  if (v == null || v === "") return null;
  if (/^\d+$/.test(String(v))) return Number(v);
  if (v === "mes" || v === "trim") return v;
  if (isMonthKey(v)) return today && v === curMonth(today) ? "mes" : v;
  if (isQuarterKey(v)) return today && v === curQuarter(today) ? "trim" : v;
  return null;
}
// el valor que usa una vista: lo compartido si lo entiende (accepts); si no, lo último suyo (own); si tampoco, fallback
export function pickPeriod({ shared, own, accepts, fallback, today }) {
  for (const v of [shared, own]) { const n = normPeriod(v, today); if (n != null && accepts(n)) return n; }
  return fallback;
}
// Métricas: días o el mes / trimestre en curso
export const metricsAccepts = v => REL.some(([k]) => k === v);
// Equipo › Demos: el mes o trimestre en curso, o uno de los que se pueden elegir (choices del servidor; sin choices todavía, cualquier clave)
export const demosAccepts = choices => v => v === "mes" || v === "trim" || ((isMonthKey(v) || isQuarterKey(v)) && (!choices || [...(choices.months || []), ...(choices.quarters || [])].some(x => x.key === v)));
// lo que se manda al servidor de Equipo › Demos: «mes» = vacío (el mes en curso en la zona de quien mira), «trim» = el trimestre en curso
export const demosParam = (v, today) => v === "mes" || v == null ? "" : v === "trim" ? curQuarter(today) : String(v);

// La pieza: una fila de opciones (chips) y, si la vista lo entiende, «Otro mes o trimestre» (select). id: para bindPeriod.
// rel: las opciones de la fila (claves de REL). other: { months: [{ key, label, year }], quarters: [{ key, label }] } o null.
export function periodHtml({ id, value, rel = REL.map(([k]) => k), other = null, today = "", label = "Período" }) {
  const chips = REL.filter(([k]) => rel.includes(k)).map(([k, l]) => `<button type="button" class="chip" data-per="${k}" aria-pressed="${value === k}">${l}</button>`).join("");
  let sel = "";
  if (other) {
    const months = (other.months || []).filter(m => m.key !== curMonth(today)), quarters = (other.quarters || []).filter(q => q.key !== curQuarter(today));
    const picked = months.some(m => m.key === value) || quarters.some(q => q.key === value);
    const years = [...new Set(months.map(m => m.year ?? String(m.key).slice(0, 4)))];
    const qYears = [...new Set(quarters.map(q => String(q.key).slice(0, 4)))].sort().reverse();
    sel = `<select class="inp per-other${picked ? " on" : ""}" data-per-other aria-label="Otro mes o trimestre">
      <option value="" ${picked ? "" : "selected"}>Otro mes o trimestre…</option>
      ${qYears.map(y => `<optgroup label="Trimestres ${esc(y)}">${quarters.filter(q => String(q.key).startsWith(y)).map(q => `<option value="${esc(q.key)}" ${q.key === value ? "selected" : ""}>${esc(q.label || q.key)}</option>`).join("")}</optgroup>`).join("")}
      ${years.map(y => `<optgroup label="${esc(y)}">${months.filter(m => String(m.year ?? String(m.key).slice(0, 4)) === String(y)).map(m => `<option value="${esc(m.key)}" ${m.key === value ? "selected" : ""}>${esc(m.label || m.key)}</option>`).join("")}</optgroup>`).join("")}
    </select>`;
  }
  return `<div class="per" id="${esc(id)}" role="group" aria-label="${esc(label)}"><div class="chips per-chips">${chips}</div>${sel}</div>`;
}
// onPick(valor ya normalizado: 7 | "mes" | "2026-10"…); también guarda la preferencia compartida
export function bindPeriod(root, id, onPick, today = "") {
  const box = root?.querySelector(`#${id}`); if (!box) return;
  const pick = v => { const n = normPeriod(v, today); if (n == null) return; savePeriod(n); onPick(n); };
  box.querySelectorAll("[data-per]").forEach(b => b.onclick = () => { if (b.getAttribute("aria-pressed") !== "true") pick(b.dataset.per); });
  box.querySelector("[data-per-other]")?.addEventListener("change", e => { if (e.target.value) pick(e.target.value); });
}
// preferencia compartida (mismo formato que save/loadPref de core.js: «ob.» + JSON)
export function storedPeriod() { try { const v = localStorage.getItem("ob.period"); return v ? JSON.parse(v) : null; } catch { return null; } }
export function savePeriod(v) { try { localStorage.setItem("ob.period", JSON.stringify(v)); } catch {} }
