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

async function googlePhotos(s) {
  if (!GKEY) return [];
  let names = (s.photos || []).map(n => ({ name: n }));
  if (!names.length) {
    const r = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST", signal: AbortSignal.timeout(8000),
      headers: { "content-type": "application/json", "X-Goog-Api-Key": GKEY, "X-Goog-FieldMask": "places.id,places.location,places.photos.name,places.photos.authorAttributions" },
      body: JSON.stringify({ textQuery: `${s.name}, ${s.city}, ${s.country}`, languageCode: "es", maxResultCount: 3, locationBias: { circle: { center: { latitude: s.lat, longitude: s.lng }, radius: 1500 } } }),
    });
    if (!r.ok) throw new Error(`Google Places ${r.status}`);
    const p = ((await r.json()).places || []).find(p => p.location && km(s, { lat: p.location.latitude, lng: p.location.longitude }) < 1.5);
    names = (p?.photos || []).slice(0, 6).map(x => ({ name: x.name, credit: x.authorAttributions?.[0]?.displayName || "" }));
  }
  const out = [];
  for (const n of names.slice(0, 6)) {
    // skipHttpRedirect devuelve una URL pública de la imagen: la clave nunca llega al navegador.
    const r = await fetch(`https://places.googleapis.com/v1/${n.name}/media?maxWidthPx=1200&skipHttpRedirect=true`, { headers: { "X-Goog-Api-Key": GKEY }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) continue;
    const j = await r.json();
    if (j.photoUri) out.push({ url: j.photoUri, kind: "google", credit: n.credit ? `Foto: ${n.credit} · Google Maps` : "Google Maps" });
  }
  return out;
}

async function webImage(s) {
  if (s.img) return [{ url: s.img, kind: "web", credit: "Sitio web del colegio" }];
  if (!s.web || s.img === "") return [];
  const r = await fetch(s.web, { signal: AbortSignal.timeout(6000), redirect: "follow", headers: { "user-agent": "Mozilla/5.0 (compatible; OrderBrain/1.0)", accept: "text/html" } });
  if (!r.ok || !/html/.test(r.headers.get("content-type") || "")) return [];
  const html = (await r.text()).slice(0, 300000);
  const m = html.match(/<meta[^>]+(?:property|name)=["'](?:og:image|og:image:url|twitter:image)["'][^>]*content=["']([^"']+)["']/i) || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:image|twitter:image)["']/i);
  if (!m) return [];
  try { const u = new URL(m[1].replace(/&amp;/g, "&"), r.url); return /^https:/.test(u.href) ? [{ url: u.href, kind: "web", credit: "Sitio web del colegio" }] : []; } catch { return []; }
}

export async function photosFor(id, { refresh = false } = {}) {
  const s = byId.get(id);
  if (!s) return [];
  if (!refresh) { const c = await cacheGet(id); if (c) return c; }
  const [g, w] = await Promise.all([googlePhotos(s).catch(e => { console.warn("Fotos de Google:", e.message); return null; }), webImage(s).catch(() => [])]);
  const list = [...(g || []), ...w];
  // si Google falló, no se guarda en caché para reintentar la próxima vez
  if (g !== null) await cacheSet(id, list);
  return list;
}
