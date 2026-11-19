// Ficha del colegio: estado compartido (D), constantes de Registrar y el formulario nuevo (fachada: public/js/school.js).
import { $, icon, nextBusinessDay, today } from "../core.js";

// Ficha del colegio: preparar el contacto, registrar el resultado e historial. Incluye el modo sesión.
// «la cafetería», «el casino», «el bar escolar»
export const laEsp = mk => `${/^(casino|bar)\b/.test(mk?.espacio || "") ? "el" : "la"} ${mk?.espacio || "cafetería"}`, delaEsp = mk => laEsp(mk).replace(/^el /, "del ").replace(/^la /, "de la ");
export const coarse = () => matchMedia("(pointer: coarse)").matches;

export const D = { id: null, data: null, tab: "prep", form: null, activityId: null, saving: false, result: null, brief: null, briefLoading: false, err: null, photos: null, study: undefined, studyWorking: false, studyErr: null, tl: null };
export const CH = [["call", "Llamada", "phone"], ["whatsapp", "WhatsApp", "whatsapp"], ["mail", "Mail", "mail"], ["visit", "Visita", "user"]];
export const NEXT_TYPES = [["", "Sin próximo paso"], ["call", "Llamada"], ["deadline", "WhatsApp"], ["task", "Mail"], ["contacto_decisor", "Contacto decisor"]];
// Mini calendario del mes (para elegir el día del próximo paso o de la tarea sin abrir otro selector)
const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
export function miniCal(sel, min, disabled, month = D.calMonth) {
  const base = month || (sel || min).slice(0, 7);
  const [y, mo] = base.split("-").map(Number), first = new Date(Date.UTC(y, mo - 1, 1)), days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const lead = (first.getUTCDay() + 6) % 7; // semana empieza el lunes
  const ymd = d => `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const cells = [...Array(lead).fill(""), ...Array.from({ length: days }, (_, i) => i + 1)];
  const prevOk = base > min.slice(0, 7);
  return `<div class="mcal${disabled ? " off" : ""}" role="group" aria-label="Elegí el día">
    <div class="mcal-h"><button type="button" class="icon-btn sm" data-cal="-1" ${prevOk && !disabled ? "" : "disabled"} aria-label="Mes anterior">${icon("chevL", "sm")}</button><b>${MONTHS[mo - 1]} ${y}</b><button type="button" class="icon-btn sm" data-cal="1" ${disabled ? "disabled" : ""} aria-label="Mes siguiente">${icon("chevR", "sm")}</button></div>
    <div class="mcal-g">${["L", "M", "M", "J", "V", "S", "D"].map(d => `<span class="dow">${d}</span>`).join("")}${cells.map(d => {
      if (!d) return `<span></span>`;
      const v = ymd(d), past = v < min, wk = [5, 6].includes((lead + d - 1) % 7);
      return `<button type="button" class="d${v === sel ? " on" : ""}${v === min ? " today" : ""}${wk ? " wk" : ""}" data-day="${v}" ${past || disabled ? "disabled" : ""} aria-pressed="${v === sel}" aria-label="${d} de ${MONTHS[mo - 1]}">${d}</button>`;
    }).join("")}</div></div>`;
}
export const GOOD = ["callback", "info", "demo"];
// resultados que no necesitan un próximo paso (la demo ya es el próximo paso; el descarte cierra)
export const NO_NEXT = ["demo", "not_interested", "bad_data"];
export const CONNECTED = ["gatekeeper", "callback", "info", "demo", "not_now", "not_interested"];
export const QUALIFY = ["callback", "info", "demo", "not_now"];
// Atajos para la nota, según lo que pasó (los datos de calificación tienen sus propios campos).
const QUICK = {
  no_answer: ["Buzón de voz", "Daba ocupado", "Llamar en otro horario"], gatekeeper: ["Pidió que mande mail", "Decisor de vacaciones", "Llamar después de las 11"],
  callback: ["Pidió que llame en otro horario", "Quiere verlo con dirección"], info: ["Pidió precios", "Pidió que mande mail"], demo: ["Quiere verlo con dirección", "Suma al concesionario"],
  not_now: ["Renuevan la concesión el año que viene", "Ya tienen presupuesto cerrado"], not_interested: ["Ya usan otro sistema", "No quieren app para familias"], bad_data: ["Teléfono fuera de servicio", "El colegio cerró"],
};
export const NIVELES = ["Preescolar", "Primaria", "Secundaria", "Prepa", "Universidad"];
// Contacto por escrito (WhatsApp o mail): los MISMOS resultados se leen con otro texto (written, en OUTCOMES de
// lib/playbook.js): «No atendió» = «Sin respuesta todavía». El id que se guarda no cambia.
export const WRITTEN = ["whatsapp", "mail"];
export const ocText = (x, ch) => (WRITTEN.includes(ch) && x?.written) || x;
const QUICK_W = { no_answer: ["Lo leyó y no contestó", "Todavía no lo leyó", "Probar con una llamada"], gatekeeper: ["Pidió que mande mail", "Pasó el contacto de quien decide"], bad_data: ["El número no tiene WhatsApp", "El mail rebotó"] };
export const quickFor = f => (WRITTEN.includes(f.channel) && QUICK_W[f.outcome]) || QUICK[f.outcome] || [];

export const drawerOpen = () => !$("drawer").hidden;
// Borradores de Registrar por colegio: si cerrás la ficha a mitad de carga, al volver sigue ahí.
export const drafts = new Map();
export const currentSchoolId = () => (drawerOpen() ? D.id : null);
export const newForm = () => ({ channel: "call", outcome: null, contact: { name: "", role: "", phone: "", email: "" }, qual: { cafeteria: "", alumnos: "", niveles: [], sistema: "" },
  demo: { date: nextBusinessDay(today()), time: "10:00", duration: 30, ownerId: "" }, next: { type: "", date: "", time: "", ownerId: "" }, lostReason: "", text: "", ai: true, completeAct: true, nextTouched: false, why: "" });
