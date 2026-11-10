// Verificación de colegios nuevos del buscador antes de sumarlos a la base.
// - Web del colegio (siempre): teléfono, WhatsApp, mail e imagen de portada.
// - Google Places (si hay GOOGLE_MAPS_API_KEY): que sea una escuela, que siga abierta, teléfono y web.
// - Claude (si hay ANTHROPIC_API_KEY): si es colegio, si es privado, encaje con OrderEAT y ángulo de venta.
// Devuelve { keep, drop } con el motivo de cada descarte.
import { norm, km, keyTokens } from "./scan.js";
const sig = (ms, signal) => signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);

const env = process.env;
export const enrichSources = () => ({ web: true, google: !!env.GOOGLE_MAPS_API_KEY, ai: !!env.ANTHROPIC_API_KEY });

// ---------- web del colegio
// La URL sale de OpenStreetMap (la puede editar cualquiera): solo http/https a puertos públicos y a IPs públicas,
// siguiendo como mucho 3 redirecciones y revisando cada una. Así nadie hace que el servidor consulte su red interna.
const PRIVATE_IP = [/^0\./, /^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, /^(22[4-9]|2[3-5]\d)\./, /^::1?$/, /^f[cd]/i, /^fe[89ab]/i, /^::ffff:(0|10|127|169\.254|172\.(1[6-9]|2\d|3[01])|192\.168)\./i];
async function safeUrl(raw) {
  let u; try { u = new URL(raw); } catch { throw new Error("web inválida"); }
  if (!/^https?:$/.test(u.protocol) || (u.port && !["80", "443"].includes(u.port)) || u.username || u.password) throw new Error("web no permitida");
  if (env.ENRICH_ALLOW_PRIVATE === "1") return u; // solo para pruebas locales
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (/^[\d.]+$/.test(host) || host.includes(":") || /^localhost$|\.local$|\.internal$/i.test(host)) throw new Error("web no permitida");
  const { lookup } = await import("dns/promises");
  const addrs = await lookup(host, { all: true });
  if (!addrs.length || addrs.some(a => PRIVATE_IP.some(re => re.test(a.address)))) throw new Error("web no permitida");
  return u;
}
// Lee como mucho 900 KB del cuerpo y corta la descarga (una página enorme o infinita no llena la memoria).
async function readCapped(r, max = 900000) {
  if (!r.body) return "";
  const reader = r.body.getReader(), chunks = []; let size = 0;
  while (size < max) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); size += value.length; }
  reader.cancel().catch(() => {});
  return new TextDecoder().decode(Buffer.concat(chunks.map(c => Buffer.from(c))).subarray(0, max));
}
const PHONE_OK = p => p.replace(/\D/g, "").length >= 8;
const decode = s => { try { return decodeURIComponent(s); } catch { return s; } };
// Sedes que la web publica con su teléfono: «PLANTEL GLANDORFF 4131045», «Sede Norte: (614) 410-1032 y 416 0339».
// Solo lo que está escrito: nombre de la sede y números tal cual (sin agregar códigos de área).
const ENT = { amp: "&", nbsp: " ", quot: '"', apos: "'", lt: "<", gt: ">", aacute: "á", eacute: "é", iacute: "í", oacute: "ó", uacute: "ú", ntilde: "ñ", Aacute: "Á", Eacute: "É", Iacute: "Í", Oacute: "Ó", Uacute: "Ú", Ntilde: "Ñ" };
const NUM = String.raw`\+?\(?\d[\d\s().-]{5,16}\d`;
const SEDE_RE = new RegExp(String.raw`\b(plantel|sede|campus|sucursal)\s+([A-Za-zÁÉÍÓÚÜÑáéíóúüñ.' ]{2,40}?)\s*[:\-–—]?\s*(?:tel[ée]?f?o?n?o?s?\.?:?\s*)?(${NUM}(?:\s*(?:y|,|\/|o|-)\s*${NUM})*)`, "gi");
const YEARISH = /^(19|20)\d{2}(\s*[-–\/]\s*((19|20)?\d{2}))?$/;
// Texto visible de un HTML, en tiempo lineal (sin regex con retroceso: una página rota no traba el servidor)
export function htmlText(html, max = 300000) {
  let h = String(html), out = "", i = 0;
  while (i < h.length && out.length < max) {
    const lt = h.indexOf("<", i);
    if (lt < 0) { out += h.slice(i); break; }
    out += h.slice(i, lt) + " ";
    const tag = h.slice(lt + 1, lt + 10).toLowerCase();
    const skip = ["script", "style", "noscript"].find(t => tag.startsWith(t));
    if (skip) { const end = h.indexOf(`</${skip}`, lt); i = end < 0 ? h.length : h.indexOf(">", end) + 1 || h.length; continue; }
    const gt = h.indexOf(">", lt); i = gt < 0 ? h.length : gt + 1;
  }
  return out.slice(0, max).replace(/&(#\d+|[a-zA-Z]+);/g, (m, e) => e[0] === "#" ? String.fromCharCode(+e.slice(1)) : ENT[e] ?? m).replace(/\s+/g, " ");
}
export function sedesFromHtml(html) {
  const text = htmlText(html), out = new Map();
  for (const m of text.matchAll(SEDE_RE)) {
    const name = m[2].trim().replace(/\s+(tel|tels|telefono|teléfono|whatsapp)\.?$/i, "").replace(/[.,;:]+$/, "").trim();
    if (/^(habitacional|deportiva|educativa|de\s)/i.test(name)) continue;
    const phones = m[3].split(/\s*(?:\by\b|,|\/|\bo\b|\s[-–]\s)\s*/).map(x => x.trim()).filter(x => x.replace(/\D/g, "").length >= 7 && !YEARISH.test(x));
    const key = name.toLowerCase();
    if (!phones.length || name.length < 2 || out.has(key)) continue;
    out.set(key, { kind: m[1].toLowerCase(), name, phones });
    if (out.size >= 8) break;
  }
  return [...out.values()];
}
// Fotos del colegio en su propia web (portada y galería): solo https, sin logos, íconos, redes ni imágenes chicas.
const NOT_PHOTO = /logo|icon|sprite|avatar|favicon|flag|bandera|whatsapp|facebook|instagram|twitter|youtube|tiktok|linkedin|pixel|blank|loader|spinner|arrow|flecha|badge|sello|placeholder|emoji|menu|nav[-_]|header|footer|banner-?ad|thumb|miniatura|\.svg|\.gif/i;
export function siteImages(html, base, first = "") {
  const out = first ? [first] : [];
  for (const m of String(html).matchAll(/<img\b[^>]{0,2000}>/gi)) {
    const tag = m[0], src = (tag.match(/\s(?:data-src|data-lazy-src|src)=["']([^"']+)["']/i) || [])[1];
    if (!src || src.startsWith("data:")) continue;
    const alt = (tag.match(/\salt=["']([^"']*)["']/i) || [])[1] || "", w = +((tag.match(/\swidth=["']?(\d+)/i) || [])[1] || 0);
    const qw = +((src.match(/[?&](?:width|w)=(\d+)/i) || [])[1] || 0);
    if (NOT_PHOTO.test(src + " " + alt) || (w && w < 300) || (qw && qw < 400)) continue;
    let u; try { u = new URL(src.replace(/&amp;/g, "&"), base); } catch { continue; }
    if (u.protocol !== "https:" || !/\.(jpe?g|webp|png)(\?|$|\/)|wixstatic\.com\/media|googleusercontent|cloudinary|squarespace-cdn|cdn\.shopify|wp-content\/uploads/i.test(u.href)) continue;
    // Wix: pedir una versión grande de la misma foto
    const href = u.href.replace(/(wixstatic\.com\/media\/[^/]+)\/v1\/.*$/, "$1");
    // la misma foto en otro tamaño cuenta una vez
    const path = href.split("?")[0];
    if (!out.some(x => x.split("?")[0] === path)) out.push(href);
    if (out.length >= 8) break;
  }
  return out;
}
// Motivo entendible cuando una web no se puede leer (se muestra en «Datos del colegio»)
const why = e => { const c = String(e?.cause?.code || e?.cause?.message || e?.code || e?.message || ""); return /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ALTNAME|ERR_SSL|EPROTO/i.test(c) ? "su certificado de seguridad está vencido o mal configurado" : /ENOTFOUND|EAI_AGAIN/.test(c) ? "la dirección no existe" : /ECONNREFUSED|ECONNRESET|socket/i.test(c) ? "la web no responde" : /abort|timeout/i.test(c) ? "la web tardó demasiado" : e?.message || "no responde"; };
export async function webInfo(url, signal) {
  let u = await safeUrl(url), r;
  for (let hop = 0; ; hop++) {
    try { r = await fetch(u, { signal: sig(7000, signal), redirect: "manual", headers: { "user-agent": "Mozilla/5.0 (compatible; OrderBrain-SDR/1.0)", accept: "text/html" } }); }
    catch (e) { if (signal?.aborted) throw e; throw new Error(why(e)); }
    if (r.status < 300 || r.status >= 400) break;
    r.body?.cancel().catch(() => {});
    if (hop >= 3 || !r.headers.get("location")) throw new Error("demasiadas redirecciones");
    u = await safeUrl(new URL(r.headers.get("location"), u).href);
  }
  if (!r.ok) { r.body?.cancel().catch(() => {}); throw new Error(`web ${r.status}`); }
  if (!/html/.test(r.headers.get("content-type") || "")) { r.body?.cancel().catch(() => {}); return { ok: true }; }
  const html = await readCapped(r);
  const dec = s => s.replace(/&amp;/g, "&").replace(/%20/g, " ").trim();
  const tel = [...html.matchAll(/href=["']tel:([^"']+)["']/gi)].map(m => dec(decode(m[1]))).filter(PHONE_OK);
  const wa = [...html.matchAll(/href=["'](?:https?:)?\/\/(?:wa\.me|api\.whatsapp\.com\/send\?phone=|web\.whatsapp\.com\/send\?phone=)\/?(\+?\d{8,15})/gi)].map(m => "+" + m[1].replace(/^\+/, ""));
  const mail = [...html.matchAll(/href=["']mailto:([^"'?]+)/gi)].map(m => dec(decode(m[1])).toLowerCase()).filter(e => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(e));
  const og = html.match(/<meta[^>]+(?:property|name)=["'](?:og:image|og:image:url|twitter:image)["'][^>]*content=["']([^"']+)["']/i) || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:image|twitter:image)["']/i);
  let image = "";
  if (og) { try { const iu = new URL(og[1].replace(/&amp;/g, "&"), u); if (/^https:/.test(iu.href)) image = iu.href; } catch {} }
  return { ok: true, phone: tel[0] || "", phones: [...new Set(tel)].slice(0, 6), whatsapp: wa[0] || "", email: mail[0] || "", emails: [...new Set(mail)].slice(0, 6), image, images: siteImages(html, u, image), sedes: sedesFromHtml(html) };
}

// ---------- Google Places
// Tipos de Google que no son un colegio o una universidad.
const NOT_K12 = /^(language_school|driving_school|dance_school|music_school|art_school|cooking_school|sports_school|swimming_school|tutoring_service|training_center|research_institute|educational_consultant|library|museum|church|place_of_worship|gym|sports_club)$/;
const SCHOOLISH = /school|university|preschool|kindergarten|education/;
export async function placesLookup(s, signal) {
  const key = env.GOOGLE_MAPS_API_KEY; if (!key) return null;
  const r = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST", signal: sig(12000, signal),
    headers: { "content-type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": "places.id,places.displayName,places.location,places.rating,places.userRatingCount,places.internationalPhoneNumber,places.nationalPhoneNumber,places.websiteUri,places.formattedAddress,places.types,places.primaryType,places.businessStatus" },
    body: JSON.stringify({ textQuery: `${s.name}, ${s.city}, ${s.country}`, languageCode: "es", maxResultCount: 3, locationBias: { circle: { center: { latitude: s.lat, longitude: s.lng }, radius: 1500 } } }),
  });
  if (!r.ok) throw new Error(`Places ${r.status}`);
  const j = await r.json();
  // tiene que estar a menos de 300 m y compartir las palabras propias del nombre
  const mine = keyTokens(s.name);
  return (j.places || []).find(p => {
    if (!p.location || km(s, { lat: p.location.latitude, lng: p.location.longitude }) > 0.3) return false;
    const theirs = keyTokens(p.displayName?.text || "");
    if (!mine.length) return norm(p.displayName?.text) === norm(s.name);
    return theirs.filter(w => mine.includes(w)).length / mine.length >= 0.5;
  }) || null;
}

// ---------- Claude
async function aiAssess(batch, signal) {
  if (!env.ANTHROPIC_API_KEY || !batch.length) return {};
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic();
  const res = await client.messages.create({
    model: env.ANTHROPIC_MODEL || "claude-opus-5-5", max_tokens: 8000,
    output_config: { effort: "low", format: { type: "json_schema", schema: {
      type: "object", additionalProperties: false, required: ["items"],
      properties: { items: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "tipo", "privado", "fit", "angulo"],
        properties: { id: { type: "string" }, tipo: { type: "string", enum: ["colegio", "universidad", "otro"] }, privado: { type: "string", enum: ["si", "probable", "no"] },
          fit: { type: "string", enum: ["alto", "medio", "bajo"] }, angulo: { type: "string" } } } } },
    } } },
    messages: [{ role: "user", content: `Sos SDR senior de OrderEAT (software para la cafetería escolar: app para que las familias carguen saldo, punto de venta sin efectivo, reportes). Para cada lugar de la lista decí:
- tipo: «colegio» si es un colegio o jardín de educación formal (inicial, primaria, secundaria o bachillerato), «universidad» si es una universidad o instituto terciario, «otro» si es una academia de idiomas, de manejo, de arte o deportes, un centro de estudios, una ONG, un apoyo escolar u otra cosa.
- privado: si, probable o no.
- fit para OrderEAT: alto, medio o bajo.
- angulo: una frase corta y concreta para abrir la llamada.
Usá solo los datos dados y lo que sepas con seguridad. No inventes.

` + batch.map(s => `${s.id} | ${s.name} | ${s.city}, ${s.country}${s.levels?.length ? " | niveles: " + s.levels.join(", ") : ""}${s.web ? " | web: " + s.web : ""}${s.addr ? " | " + s.addr : ""}`).join("\n") }],
  }, { signal });
  if (res.stop_reason !== "end_turn") throw new Error(`respuesta incompleta (${res.stop_reason})`);
  const t = res.content.filter(b => b.type === "text").map(b => b.text).join("");
  return Object.fromEntries((JSON.parse(t).items || []).map(x => [x.id, x]));
}

// ---------- todo junto
const pool = async (items, n, fn) => { let i = 0; await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } })); };
// signal: si el usuario cancela, no se hace ninguna consulta más (ni web, ni Google, ni IA) y no se guarda nada.
export async function verifyCandidates(list, signal) {
  const keep = [], drop = [];
  const today = new Date().toISOString().slice(0, 10);
  await pool(list, 6, async s => {
    if (signal?.aborted) return;
    const v = { at: today, web: false, google: false, ai: false };
    // 1) Google: que exista como escuela y siga abierta
    try {
      const p = await placesLookup(s, signal);
      if (p) {
        v.google = true;
        if (p.businessStatus === "CLOSED_PERMANENTLY") return drop.push({ name: s.name, why: "cerró según Google" });
        const types = (p.types || []).join(" ");
        if ((p.primaryType && NOT_K12.test(p.primaryType)) || (types && !SCHOOLISH.test(types))) return drop.push({ name: s.name, why: `Google lo tiene como ${String(p.primaryType || p.types?.[0] || "otra cosa").replace(/_/g, " ")}` });
        s.gplace = p.id;
        if (p.internationalPhoneNumber && !s.phone) s.phone = p.internationalPhoneNumber;
        if (p.websiteUri && !s.web) s.web = p.websiteUri;
        if (p.formattedAddress && !s.addr) s.addr = p.formattedAddress;
        if (p.rating) s.rating = `${String(p.rating).replace(".", ",")} (${p.userRatingCount || 0})`;
      }
    } catch (e) { if (signal?.aborted) return; v.googleError = e.message; }
    // 2) web: contactos e imagen
    if (s.web) {
      try {
        if (signal?.aborted) return;
        const w = await webInfo(s.web, signal);
        v.web = true;
        if (w.phone && !s.phone) s.phone = w.phone;
        if (w.whatsapp) { s.whatsapp = w.whatsapp; if (!s.phone) s.phone = w.whatsapp; }
        if (w.email && !s.email) s.email = w.email;
        if (w.image) s.img = w.image;
      } catch { if (signal?.aborted) return; v.webDown = true; }
    }
    s.verified = v;
    keep.push(s);
  });
  // 3) Claude, en un solo pedido por tanda
  if (signal?.aborted) return { keep: [], drop, cancelled: true };
  if (keep.length && env.ANTHROPIC_API_KEY) {
    try {
      const ai = await aiAssess(keep, signal);
      for (let i = keep.length - 1; i >= 0; i--) {
        const s = keep[i], a = ai[s.id]; if (!a) continue;
        s.verified.ai = true;
        if (a.tipo === "otro") { drop.push({ name: s.name, why: "no es un colegio" }); keep.splice(i, 1); continue; }
        if (a.privado === "no") { drop.push({ name: s.name, why: "es público" }); keep.splice(i, 1); continue; }
        s.fit = a.fit; if (a.angulo) s.pitch = a.angulo;
        if (a.privado === "si") s.private = "seguro";
      }
    } catch (e) { if (signal?.aborted) return { keep: [], drop, cancelled: true }; for (const s of keep) s.verified.aiError = e.message; }
  }
  if (signal?.aborted) return { keep: [], drop, cancelled: true };
  return { keep, drop };
}
