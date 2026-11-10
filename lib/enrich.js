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
const PHONE_OK = p => p.replace(/\D/g, "").length >= 8;
export async function webInfo(url, signal) {
  const r = await fetch(url, { signal: sig(7000, signal), redirect: "follow", headers: { "user-agent": "Mozilla/5.0 (compatible; OrderBrain-SDR/1.0)", accept: "text/html" } });
  if (!r.ok) throw new Error(`web ${r.status}`);
  if (!/html/.test(r.headers.get("content-type") || "")) return { ok: true };
  const html = (await r.text()).slice(0, 400000);
  const dec = s => s.replace(/&amp;/g, "&").replace(/%20/g, " ").trim();
  const tel = [...html.matchAll(/href=["']tel:([^"']+)["']/gi)].map(m => dec(decodeURIComponent(m[1]))).filter(PHONE_OK);
  const wa = [...html.matchAll(/href=["'](?:https?:)?\/\/(?:wa\.me|api\.whatsapp\.com\/send\?phone=|web\.whatsapp\.com\/send\?phone=)\/?(\+?\d{8,15})/gi)].map(m => "+" + m[1].replace(/^\+/, ""));
  const mail = [...html.matchAll(/href=["']mailto:([^"'?]+)/gi)].map(m => dec(m[1]).toLowerCase()).filter(e => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(e));
  const og = html.match(/<meta[^>]+(?:property|name)=["'](?:og:image|og:image:url|twitter:image)["'][^>]*content=["']([^"']+)["']/i) || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:image|twitter:image)["']/i);
  let image = "";
  if (og) { try { const u = new URL(og[1].replace(/&amp;/g, "&"), r.url); if (/^https:/.test(u.href)) image = u.href; } catch {} }
  return { ok: true, phone: tel[0] || "", whatsapp: wa[0] || "", email: mail[0] || "", image };
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
