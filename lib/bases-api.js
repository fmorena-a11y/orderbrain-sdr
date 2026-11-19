// Rutas de «Cargar base» (lib/bases.js). server.js las monta con mountBases(app, { … }). Ninguna escribe en Pipedrive: leen
// la planilla (link, archivo o texto pegado), la guardan por persona y la cruzan con Pipedrive (solo lectura). Lo que se crea
// en Pipedrive pasa después, desde la ficha, por las rutas de siempre (Registrar → workLead/newLead).
//  - POST /api/bases/load { url } · POST /api/bases/file (el archivo crudo, x-file-name) · POST /api/bases/paste (texto):
//    devuelven el borrador (pestañas con el encabezado y las columnas detectadas).
//  - POST /api/bases/preview { draft, tab, header, map, country, city, event }: cómo queda agrupado con esas columnas.
//  - POST /api/bases { … }: la guarda. GET /api/bases: las tuyas y (líder) las de tu gente. GET/DELETE /api/bases/:id.
//  - POST /api/bases/:id/check { n, keys }: la siguiente tanda del cruce con Pipedrive.
//  - GET /api/records/bx/:rid: la ficha de una institución que no está en la base de colegios. GET /api/schools/:id/base:
//    los contactos de la planilla para la ficha.
import express from "express";
import * as B from "./bases.js";
import * as pd from "./pipedrive.js";
import * as sales from "./sales.js";
import { readSheet, DEMO_URL } from "./sheets.js";
import { bump } from "./store.js";
import { lc } from "./text.js";

const httpErr = (status, error) => Object.assign(new Error(error), { status });
export function mountBases(app, { auth, wrap, schoolParam, leadScopeFor }) {
  const me = req => lc(req.session.user.email);
  // leer planillas: tope por persona (cada link son varios pedidos a Google)
  const slow = async req => { if ((await bump(`bload:${me(req)}`, 600)) > 40) throw httpErr(429, "Cargaste muchas planillas seguidas: esperá unos minutos."); };
  const raw = express.raw({ type: () => true, limit: "8mb" }), text = express.text({ type: () => true, limit: "4mb" });
  const tooBig = (err, req, res, next) => err?.type === "entity.too.large" ? res.status(413).json({ error: "El archivo es muy grande (hasta 8 MB): descargá solo la pestaña que vas a trabajar." }) : next(err);

  app.get("/api/bases/demo", auth, (req, res) => res.json({ url: pd.DEMO ? DEMO_URL : "" }));
  app.post("/api/bases/load", auth, wrap(async (req, res) => {
    await slow(req);
    const src = await readSheet(String(req.body?.url ?? "").slice(0, 600), { email: me(req), demo: pd.DEMO });
    res.json({ draft: await B.makeDraft(me(req), { ...src, kind: "sheet" }) });
  }));
  app.post("/api/bases/file", auth, raw, tooBig, wrap(async (req, res) => {
    await slow(req);
    let name = ""; try { name = decodeURIComponent(String(req.get("x-file-name") || "")).slice(0, 120); } catch {}
    res.json({ draft: await B.makeDraft(me(req), B.fromFile(req.body, name)) });
  }));
  app.post("/api/bases/paste", auth, text, tooBig, wrap(async (req, res) => {
    await slow(req);
    res.json({ draft: await B.makeDraft(me(req), B.fromPaste(typeof req.body === "string" ? req.body : "")) });
  }));
  app.post("/api/bases/preview", auth, wrap(async (req, res) => res.json(await B.analyze(me(req), req.body || {}))));
  app.post("/api/bases", auth, wrap(async (req, res) => res.json({ base: B.view(await B.saveBase(req.session.user, req.body || {}), req.session.user) })));
  app.get("/api/bases", auth, wrap(async (req, res) => res.json(await B.listFor(me(req), await leadScopeFor(me(req))))));
  app.get("/api/bases/:bid", auth, wrap(async (req, res) => res.json({ base: B.view(await B.readFor(me(req), req.params.bid, await leadScopeFor(me(req))), req.session.user) })));
  app.delete("/api/bases/:bid", auth, wrap(async (req, res) => res.json(await B.deleteFor(me(req), req.params.bid, await leadScopeFor(me(req))))));
  app.post("/api/bases/:bid/check", auth, wrap(async (req, res) => res.json(await B.checkFor(req.session.user, req.params.bid, await leadScopeFor(me(req)), { n: req.body?.n, keys: Array.isArray(req.body?.keys) ? req.body.keys.slice(0, 8) : null }))));
  app.get("/api/records/bx/:rid", auth, wrap(async (req, res) => res.json(await sales.openRecord("bx", req.params.rid))));
  app.get("/api/schools/:id/base", auth, schoolParam, wrap(async (req, res) => res.json(await B.baseFor(req.params.id, me(req), await leadScopeFor(me(req))))));
}
