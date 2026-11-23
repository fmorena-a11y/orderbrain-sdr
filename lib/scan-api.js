// Buscador de zonas (Prospectar: lugares, /api/scan/*; lógica en lib/scan.js, verificación en lib/enrich.js) y el Radar
// (GET /api/radar, radarState de server.js). server.js la monta con mountScan(app, deps).
import crypto from "crypto";
import { addSchools, bump, byId, cacheGet, cacheSet, dropOsm, hiddenOsm, kvEnabled, schools } from "./store.js";
import * as scan from "./scan.js";
import { enrichSources, verifyCandidates } from "./enrich.js";
import * as sales from "./sales.js";
import * as ai from "./ai.js";
import { googleEnabled } from "./photos.js";
import { MARKETS } from "./config.js";

export function mountScan(app, { SCAN_SECRET, auth, radarState, wrap }) {
  // ---------- buscador de zonas: «prospectá España», «Bogotá», «Provincia de Córdoba», «Pocitos»
  // 1) /resolve ubica el lugar con su contorno. 2) /city trae de OpenStreetMap los colegios de una ciudad o de un
  // área exacta y devuelve candidatos firmados (no guarda nada). 3) /verify revisa cada candidato (web, Google, IA)
  // y recién ahí lo suma a la base. Así, cancelar no deja nada a medias y lo que entra está chequeado.
  const SCAN_MIN_POP = Number(process.env.RADAR_MIN_POP || 40000);
  const signRec = rec => crypto.createHmac("sha256", SCAN_SECRET).update("cand:" + JSON.stringify(rec)).digest("base64url");
  const sigOk = (rec, sig) => typeof sig === "string" && /^[A-Za-z0-9_-]{43}$/.test(sig) && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(signRec(rec)));
  // Si el navegador corta el pedido (el usuario canceló), se corta todo lo que dependía de él: no se gastan más
  // consultas a OpenStreetMap, Google ni IA y no se guarda nada.
  function cancelOnClose(req, res) {
    const ac = new AbortController();
    res.on("close", () => { if (!res.writableFinished) { console.log(`buscador: ${req.path} cancelado por el usuario`); ac.abort(new Error("cancelado por el usuario")); } });
    return ac.signal;
  }
  const LATAM = Object.values(MARKETS).map(m => m.code).filter(c => /^[A-Z]{2}$/.test(c) && c !== "ES");
  const CONTINENTS = [
    { re: /^(latinoamerica|latam|america latina|iberoamerica|hispanoamerica)$/, name: "Latinoamérica", codes: LATAM, lat: -8, lng: -70, bbox: [[-56, -118], [33, -34]] },
    { re: /^(sudamerica|suramerica|america del sur|sur america)$/, name: "Sudamérica", codes: ["AR", "BO", "CL", "CO", "EC", "PE", "PY", "UY", "VE"], lat: -20, lng: -62, bbox: [[-56, -82], [13, -34]] },
    { re: /^(centroamerica|america central|centro america)$/, name: "Centroamérica", codes: ["GT", "HN", "SV", "NI", "CR", "PA"], lat: 12.5, lng: -85.5, bbox: [[7, -93], [18.5, -77]] },
    { re: /^(caribe|el caribe)$/, name: "Caribe", codes: ["DO", "PR"], lat: 18.6, lng: -68.5, bbox: [[17.4, -72.1], [19.95, -65.2]] },
    { re: /^(norteamerica|america del norte)$/, name: "Norteamérica (México)", codes: ["MX"], lat: 23.6, lng: -102.5, bbox: [[14.5, -118.5], [32.7, -86.7]] },
    { re: /^(europa)$/, name: "Europa (España)", codes: ["ES"], lat: 40.2, lng: -3.7, bbox: [[35.9, -9.4], [43.8, 4.4]] },
  ];
  const appCountry = place => { const known = Object.entries(MARKETS).find(([, m]) => m.code === place.cc); if (known) place.country = known[0]; return place; };
  // sugerencias de lugares mientras se escribe en Prospectar (solo lectura; copia de un día por texto)
  app.get("/api/places/suggest", auth, wrap(async (req, res) => {
    const q = String(req.query.q || "").trim().slice(0, 120), nq = scan.norm(q);
    if (nq.length < 2) return res.json({ places: [] });
    if ((await bump(`psug:${req.session.user.email}`, 60)) > 120) return res.status(429).json({ error: "Muchas búsquedas seguidas: esperá un minuto." });
    const prefer = /^[A-Z]{2}$/.test(String(req.query.cc || "")) ? String(req.query.cc) : "";
    const k = `psug:${prefer}:${nq}`, hit = await cacheGet(k);
    if (hit) return res.json(hit);
    const r = await scan.suggestPlaces(q, { codes: Object.values(MARKETS).map(m => m.code).filter(c => /^[A-Z]{2}$/.test(c)), prefer });
    if (!r.failed) await cacheSet(k, r, 86400);
    res.json(r);
  }));
  app.post("/api/scan/resolve", auth, wrap(async (req, res) => {
    const osm = String(req.body?.osm || "");
    if (osm) {
      const k = "place:osm:" + osm;
      const place = (await cacheGet(k)) || await scan.lookupPlace(osm);
      if (!place) return res.status(404).json({ error: "No encontré ese lugar." });
      await cacheSet(k, place, place.boundaryFailed ? 600 : 30 * 864e2);
      return res.json(appCountry(place));
    }
    const q = String(req.body?.q || "").trim().slice(0, 200), nq = scan.norm(q);
    if (nq.length < 2) return res.status(400).json({ error: "Escribí un país, una provincia, una ciudad, un barrio o una dirección." });
    // continentes y regiones grandes: los países del equipo que caen ahí
    const cont = CONTINENTS.find(c => c.re.test(nq));
    if (cont) {
      const names = Object.entries(MARKETS).filter(([, m]) => cont.codes.includes(m.code)).map(([n]) => n);
      return res.json({ kind: "continent", name: cont.name, label: cont.name, countries: names, codes: cont.codes, lat: cont.lat, lng: cont.lng, bbox: cont.bbox, city: { name: cont.name, lat: cont.lat, lng: cont.lng, pop: 0 }, alts: [] });
    }
    // se busca en los países donde trabaja el equipo, con prioridad para el país elegido en la app (cc). hard: el país lo
    // escribió la persona («…, México»). Si el texto dice el país o el estado («Pue.», «CABA»), manda el texto.
    const prefer = /^[A-Z]{2}$/.test(req.body?.cc || "") ? req.body.cc : "";
    const given = req.body?.hard && prefer ? prefer : "";
    const a = scan.parseAddress(q, { cc: given });
    // copia por texto normalizado («No. 47» = «47», «Col.» = «Colonia»); el país elegido cuenta solo si el texto no dice otro
    const k = `place5:${a.cc ? "=" + a.cc : prefer}:${a.key}`;
    const cached = await cacheGet(k);
    const codes = Object.values(MARKETS).map(m => m.code).filter(c => /^[A-Z]{2}$/.test(c));
    // un texto suelto («Tlaxcala. La lada 241 corresponde a la zona de Apizaco.»): primero los lugares que nombra, y se dice
    // cuál se usó; si el texto parece una dirección, primero el texto tal cual y después los lugares de adentro
    const cands = cached ? [] : scan.placeCandidates(q).filter(c => scan.norm(c) !== nq), sentence = scan.looksLikeSentence(q);
    const tryCands = async () => {
      const until = Date.now() + 14e3;
      for (const c of cands.slice(0, 4)) {
        if (Date.now() > until) break;
        const p = await scan.resolvePlace(c, { codes, prefer, cc: given, deadline: Math.min(until, Date.now() + 6000) }).catch(e => { if (e.status === 503) throw e; return null; });
        if (p) return { ...p, searched: c, note: [`No encontré el texto tal cual: te muestro «${c}», que sale de lo que escribiste.`, p.note].filter(Boolean).join(" ") };
      }
      return null;
    };
    // Google Maps «buscar texto» (lo que usa World Dominion): entiende frases; lo que devuelve se ubica con su contorno
    const tryGoogle = async () => {
      const g = await scan.googleTextPlace(q, { codes, prefer: given || prefer }).catch(() => null); if (!g) return null;
      const p = await scan.resolvePlace(g.formatted, { codes, prefer: g.cc || prefer, cc: g.cc || given }).catch(e => { if (e.status === 503) throw e; return null; });
      return p ? { ...p, searched: g.formatted, note: [`Google lo ubicó como «${g.name && !g.formatted.includes(g.name) ? `${g.name}, ` : ""}${g.formatted}».`, p.note].filter(Boolean).join(" ") } : null;
    };
    let place = cached || (sentence ? (await tryGoogle()) || (cands.length ? await tryCands() : null) : null);
    if (!place) place = cached || await scan.resolvePlace(q, { codes, prefer, cc: given });
    if (!place && !sentence) place = (await tryGoogle()) || (cands.length ? await tryCands() : null);
    if (!place) {
      const country = Object.entries(MARKETS).find(([, m]) => m.code === a.cc)?.[0] || "";
      const mx = a.cc === "MX" || (!a.cc && a.soft === "MX");
      // una dirección: ni la calle ni la colonia ni la ciudad aparecieron (si la ciudad aparecía, se mostraba la ciudad)
      const error = a.isAddress
        ? `No encontré «${q}»${a.city ? ` ni la ciudad «${a.city}»` : ""}. Escribí ${mx ? "la colonia" : "el barrio"} y la ciudad (por ejemplo: «${mx ? "Col. Centro, Puebla" : "Palermo, Buenos Aires"}»).`
        : `No encontré «${q}». Probá con otro nombre o sumá la ciudad.`;
      return res.status(404).json({ error, country });
    }
    // un error pasajero (contorno, OpenStreetMap a medias) se guarda solo unos minutos para reintentar pronto; un fallo de red
    // no se guarda (resolvePlace tira error y responde 503)
    if (!cached) await cacheSet(k, place, place.boundaryFailed || place.partial ? 600 : 30 * 864e2);
    res.json(appCountry(place));
  }));
  app.post("/api/scan/cities", auth, wrap(async (req, res) => {
    const { cc, areaId } = req.body || {};
    if (!/^[A-Z]{2}$/.test(cc || "") && !Number(areaId)) return res.status(400).json({ error: "Zona inválida" });
    const k = Number(areaId) ? `cities:a${Number(areaId)}` : `cities:${cc}`;
    let list = await cacheGet(k);
    if (!list) {
      const deadline = Date.now() + 240e3, signal = cancelOnClose(req, res);
      list = Number(areaId) ? await scan.citiesInArea(Number(areaId), { minPop: SCAN_MIN_POP, deadline, reserve: 5, signal }) : await scan.citiesFor(cc, { minPop: SCAN_MIN_POP, deadline, reserve: 5, signal });
      if (list.length) await cacheSet(k, list, 60 * 864e2);
    }
    res.json({ cities: list });
  }));
  // whole: todo el área (barrio, ciudad o provincia con contorno). Si no, un círculo alrededor de la ciudad,
  // recortado al área (areaId) o al país.
  app.post("/api/scan/city", auth, wrap(async (req, res) => {
    const { cc, country, city, areaId, radius, whole, region } = req.body || {};
    if (!/^[A-Z]{2}$/.test(cc || "") || !city || !Number.isFinite(+city.lat) || !Number.isFinite(+city.lng) || !String(city.name || "").trim()) return res.status(400).json({ error: "Ciudad inválida" });
    const c = { name: String(city.name).slice(0, 80), lat: +city.lat, lng: +city.lng, pop: Math.max(0, Number(city.pop) || 0) };
    const area = Number(areaId) > 0 ? Number(areaId) : null;
    const signal = cancelOnClose(req, res);
    const opts = { deadline: Date.now() + 240e3, reserve: 5, attempts: 3, signal };
    const els = whole && area ? await scan.scanArea(area, opts) : await scan.scanCity(cc, c, { ...opts, areaId: area, radius });
    // provincia entera: cada colegio lleva su ciudad (la del mapa o la ciudad grande más cercana), no el nombre de la provincia
    let cityOf = null;
    if (whole && area && region) {
      const cities = (await cacheGet(`cities:a${area}`)) || await scan.citiesInArea(area, { minPop: 20000, deadline: Date.now() + 60e3, reserve: 5, signal }).catch(() => []);
      cityOf = (t, lat, lng) => {
        const tagged = String(t["addr:city"] || t["is_in:city"] || "").split(";")[0].trim(); if (tagged) return tagged.slice(0, 80);
        let best = null, bd = Infinity; for (const x of cities) { const d = scan.km({ lat, lng }, x); if (d < bd) { bd = d; best = x; } }
        return best && bd <= scan.radiusKm(best.pop) * 1.5 ? best.name : null;
      };
    }
    // se cruza contra la base y contra lo que va saliendo en esta misma búsqueda (sin duplicados)
    const pool = schools.slice(), idx = scan.buildIndex(pool), candidates = [], seen = [];
    const today = new Date().toISOString().slice(0, 10), cname = String(country || cc).slice(0, 60);
    let skipped = 0;
    for (const e of els) {
      const s = scan.fromOsm(e, c, cc, cname, today, cityOf); if (!s) { skipped++; continue; }
      if (s.osm && hiddenOsm.has(s.osm)) { skipped++; continue; } // el radar ya lo descartó (público o no es colegio)
      const k = scan.matchExisting(pool, idx, s);
      if (k) { if (seen.length < 800 && byId.has(k.x.id)) seen.push(sales.schoolListItem(byId.get(k.x.id))); continue; }
      const rec = scan.addTo(pool, idx, s);
      rec.src = "buscador"; rec.addedBy = req.session.user.email; if (area) rec.area = area;
      candidates.push({ rec, sig: signRec(rec) });
    }
    // una zona enorme: se mandan 3000 y se avisa cuántos quedaron afuera (el navegador sugiere ir por ciudad)
    res.json({ city: c.name, found: els.length, skipped, candidates: candidates.slice(0, 3000), total: candidates.length, truncated: Math.max(0, candidates.length - 3000), seen });
  }));
  app.post("/api/scan/verify", auth, wrap(async (req, res) => {
    const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 10) : [];
    const recs = items.filter(x => x && x.rec && sigOk(x.rec, x.sig)).map(x => ({ ...x.rec }));
    if (items.length && !recs.length) return res.status(400).json({ error: "Candidatos inválidos" });
    // pudo entrar mientras tanto (otra búsqueda u otra instancia): se vuelve a cruzar
    const idx = scan.buildIndex(schools), fresh = [];
    for (const r of recs) {
      if ((r.osm && hiddenOsm.has(r.osm)) || scan.matchExisting(schools, idx, r)) continue;
      let id = r.id, i = 2; while (byId.has(id)) id = `${r.id}-${i++}`; r.id = id;
      fresh.push(r);
    }
    const signal = cancelOnClose(req, res);
    const { keep, drop, cancelled } = await verifyCandidates(fresh, signal, req.session.user?.email);
    if (cancelled || signal.aborted) return; // canceló: no se guarda nada de esta tanda
    const added = addSchools(keep);
    // lo descartado no vuelve a salir como candidato (ni se paga otra vez por verificarlo)
    dropOsm(fresh.filter(r => !keep.includes(r)).map(r => r.osm));
    // sin Redis en Vercel lo sumado vive en la memoria de una instancia: el navegador lo avisa
    res.json({ added: added.map(sales.schoolListItem), dropped: drop, sources: enrichSources(), temporary: !kvEnabled && !!process.env.VERCEL });
  }));

  // Radar (radarState está arriba, con lo compartido)
  const regionNames = new Intl.DisplayNames("es", { type: "region" });
  const regionName = cc => { try { return regionNames.of(cc) || cc; } catch { return cc; } };
  app.get("/api/radar", auth, (req, res) => {
    const st = radarState();
    const countries = {};
    for (const [cc, list] of Object.entries(st.cities || {})) {
      const name = Object.entries(MARKETS).find(([, m]) => m.code === cc)?.[0] || regionName(cc);
      const scanned = list.filter(c => st.scanned?.[`${cc}|${c.id ? "n" + c.id : c.name}`] || st.scanned?.[`${cc}|${c.name}`]).length;
      countries[name] = { cities: list.length, scanned, schools: schools.filter(s => s.country === name).length, found: schools.filter(s => s.country === name && s.src === "osm").length };
    }
    const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
    const fresh = schools.filter(s => s.found && s.found >= weekAgo);
    const top = fresh.map(s => ({ s, r: sales.scoreFor(s) })).filter(x => x.r).sort((a, b) => b.r.score - a.r.score).slice(0, 40)
      .map(({ s, r }) => ({ ...sales.schoolListItem(s), score: r.score, reasons: r.reasons, opp: s.opp || [], found: s.found }));
    const byCity = new Map();
    for (const s of fresh) { const k = `${s.city}|${s.country}`; byCity.set(k, (byCity.get(k) || 0) + 1); }
    res.json({ runs: (st.runs || []).slice(0, 12), countries, total: schools.length, fromRadar: schools.filter(s => s.src === "osm").length, weekNew: fresh.length,
      weekPhone: fresh.filter(s => s.phone).length,
      topCities: [...byCity].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, n]) => { const [city, country] = k.split("|"); return { city, country, n }; }), top, google: googleEnabled(), ai: ai.aiEnabled() });
  });
}
