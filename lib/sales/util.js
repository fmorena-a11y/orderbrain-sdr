// Utilidades compartidas por los módulos de lib/sales/ (fachada: lib/sales.js).
import { weekday } from "../time.js";

export const stripHtml = h => String(h || "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|li|div)>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\n{3,}/g, "\n\n").trim();
export const nice = d => `${weekday(d)} ${d.slice(8, 10)}/${d.slice(5, 7)}`;
// Quién firma en Pipedrive y en el ranking: el nombre de su usuario de Pipedrive (no se puede elegir el de otro)
export const signer = user => user.pdName || user.name || user.email;
