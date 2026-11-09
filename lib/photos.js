// Fotos de cada colegio para verlas en la ficha sin salir de la app:
//  - Google Places (si hay GOOGLE_MAPS_API_KEY): fotos de Google Maps, con su atribución.
//  - Web del colegio: imagen de portada (og:image).
//  - Vista satelital (Esri World Imagery): siempre, sin clave. La arma el navegador.
// Se cachean 7 días (en Redis si está configurado, si no en memoria).
import { kvEnabled, kv, key, byId } from "./store.js";

const GKEY = process.env.GOOGLE_MAPS_API_KEY || "";
export const googleEnabled = () => !!GKEY;
const TTL = 7 * 864e5;
const mem = new Map();

async function cacheGet(id) {
  if (kvEnabled) { try { const [v] = await kv([["HGET", key("photos"), id]]); if (v) { const o = JSON.parse(v); if (Date.now() - o.at < TTL) return o.list; } } catch {} return null; }
  const o = mem.get(id); return o && Date.now() - o.at < TTL ? o.list : null;
}
async function cacheSet(id, list) {
  const o = { at: Date.now(), list };
  if (kvEnabled) await kv([["HSET", key("photos"), id, JSON.stringify(o)]]).catch(() => {}); else mem.set(id, o);
}

const km = (a, b) => { const R = 6371, r = x => x * Math.PI / 180; const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };

const NAME_STOP = new Set("colegio instituto institucion educativa escuela school college academy academia liceo unidad centro bilingue internacional international de del la las el los y the san santa santo".split(" "));
const keyTokens = t => String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(w => w.length > 2 && !NAME_STOP.has(w));
const sameName = (a, b) => { const x = keyTokens(a), y = keyTokens(b); if (!x.length) return String(a).toLowerCase() === String(b).toLowerCase(); return y.filter(w => x.includes(w)).length / x.length >= 0.5; };
const gfetch = (url, opts = {}) => fetch(url, { ...opts, signal: AbortSignal.timeout(8000), headers: { "X-Goog-Api-Key": GKEY, ...(opts.headers || {}) } });

// Devuelve las fotos de Google o lanza error si Google falló (para no guardar en caché un resultado vacío por error).
async function googlePhotos(s) {
  if (!GKEY) return [];
  let photos = null;
  if (s.gplace && s.gplace !== "-") {
    // con el id del lugar se piden nombres de foto frescos (los nombres viejos vencen)
    const r = await gfetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(s.gplace)}`, { headers: { "X-Goog-FieldMask": "photos.name,photos.authorAttributions" } });
    if (!r.ok) throw new Error(`Google Places ${r.status}`);
    photos = (await r.json()).photos || [];
  } else {
    const r = await gfetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Goog-FieldMask": "places.id,places.displayName,places.location,places.photos.name,places.photos.authorAttributions" },
      body: JSON.stringify({ textQuery: `${s.name}, ${s.city}, ${s.country}`, languageCode: "es", maxResultCount: 3, locationBias: { circle: { center: { latitude: s.lat, longitude: s.lng }, radius: 500 } } }),
    });
    if (!r.ok) throw new Error(`Google Places ${r.status}`);
    // mismo colegio: a menos de 300 m y con las palabras propias del nombre
    const p = ((await r.json()).places || []).find(p => p.location && km(s, { lat: p.location.latitude, lng: p.location.longitude }) < 0.3 && sameName(s.name, p.displayName?.text));
    photos = p?.photos || [];
  }
  const out = []; let failed = 0;
  for (const n of photos.slice(0, 6)) {
    // skipHttpRedirect devuelve una URL pública de la imagen: la clave nunca llega al navegador.
    const r = await gfetch(`https://places.googleapis.com/v1/${n.name}/media?maxWidthPx=1200&skipHttpRedirect=true`);
    if (!r.ok) { failed++; continue; }
    const j = await r.json();
    const credit = n.authorAttributions?.[0]?.displayName || "";
    if (j.photoUri) out.push({ url: j.photoUri, kind: "google", credit: credit ? `Foto: ${credit} · Google Maps` : "Google Maps" });
  }
  if (photos.length && failed === Math.min(photos.length, 6)) throw new Error("Google no devolvió las fotos");
  return out;
}

async function webImage(s) {
  if (s.img) return [{ url: s.img, kind: "web", credit: "Sitio web del colegio" }];
  if (!s.web || s.img === "") return [];
  const r = await fetch(s.web, { signal: AbortSignal.timeout(6000), redirect: "follow", headers: { "user-agent": "Mozilla/5.0 (compatible; OrderBrain/1.0)", accept: "text/html" } });
  if (!r.ok) throw new Error(`web ${r.status}`);
  if (!/html/.test(r.headers.get("content-type") || "")) return [];
  const html = (await r.text()).slice(0, 300000);
  const m = html.match(/<meta[^>]+(?:property|name)=["'](?:og:image|og:image:url|twitter:image)["'][^>]*content=["']([^"']+)["']/i) || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:image|twitter:image)["']/i);
  if (!m) return [];
  try { const u = new URL(m[1].replace(/&amp;/g, "&"), r.url); return /^https:/.test(u.href) ? [{ url: u.href, kind: "web", credit: "Sitio web del colegio" }] : []; } catch { return []; }
}

export async function photosFor(id, { refresh = false } = {}) {
  const s = byId.get(id);
  if (!s) return [];
  if (!refresh) { const c = await cacheGet(id); if (c) return c; }
  const [g, w] = await Promise.all([
    googlePhotos(s).catch(e => { console.warn("Fotos de Google:", e.message); return null; }),
    webImage(s).catch(() => null),
  ]);
  const list = [...(g || []), ...(w || [])];
  // si alguna fuente falló (corte, 429, 5xx), no se guarda en caché: se reintenta la próxima vez
  if (g !== null && w !== null) await cacheSet(id, list);
  return list;
}
