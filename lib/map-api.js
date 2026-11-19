// Mapa de Google en Prospectar (pedido del líder: «usá el mapa de Google, capaz es mejor que el que tenés»): Map Tiles API
// (2D, roadmap) dentro de Leaflet. Las imágenes del mapa las pide el NAVEGADOR con la clave en la URL, así que va una clave
// APARTE, GOOGLE_MAPS_BROWSER_KEY, limitada en Google Cloud a la Map Tiles API y a orderbrain-sdr.vercel.app (nunca la de
// GOOGLE_MAPS_API_KEY, que es del servidor). Sin esa clave, o si Google no la acepta, el mapa sigue siendo el de Esri.
// GET /api/map/tiles?dark=1 → { key, session, expiry } | { off: true }. La sesión de Google dura ≈2 semanas: se guarda
// (cacheSet) hasta un día antes de que venza, una por tema (claro/oscuro).
import { cacheGet, cacheSet } from "./store.js";

const DARK = [
  { stylers: [{ saturation: -30 }] },
  { elementType: "geometry", stylers: [{ color: "#1f2227" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#a9adb5" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#1f2227" }] },
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#33373e" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#13171c" }] },
  { featureType: "poi", elementType: "geometry", stylers: [{ color: "#262a30" }] },
];
const SITE = process.env.APP_URL || "https://orderbrain-sdr.vercel.app/";

async function newSession(key, dark) {
  const body = { mapType: "roadmap", language: "es-419", region: "AR", ...(dark ? { styles: DARK } : {}) };
  const r = await fetch(`https://tile.googleapis.com/v1/createSession?key=${encodeURIComponent(key)}`, {
    method: "POST", headers: { "Content-Type": "application/json", Referer: SITE }, body: JSON.stringify(body), signal: AbortSignal.timeout(6000),
  });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  return j?.session ? { session: j.session, expiry: Number(j.expiry) || 0 } : null;
}

export function mountMap(app, { auth, wrap }) {
  app.get("/api/map/tiles", auth, wrap(async (req, res) => {
    const key = process.env.GOOGLE_MAPS_BROWSER_KEY;
    if (!key) return res.json({ off: true });
    const dark = req.query.dark === "1", ck = `map:gsess:${dark ? "d" : "l"}`;
    let s = await cacheGet(ck);
    if (!s) {
      s = await newSession(key, dark).catch(() => null);
      if (!s) { await cacheSet(ck, { off: true }, 600); return res.json({ off: true }); } // Google dijo que no: 10 min sin probar
      const ttl = s.expiry ? Math.max(600, s.expiry - Math.floor(Date.now() / 1000) - 86400) : 86400;
      await cacheSet(ck, s, ttl);
    }
    if (s.off) return res.json({ off: true });
    res.json({ key, session: s.session });
  }));
}
