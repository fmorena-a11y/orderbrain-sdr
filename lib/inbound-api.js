// Rutas de «Tus inbound» (lib/inbound-run.js). server.js las monta con mountInbound(app, { … }).
//  - GET /api/inbound?refresh=1: lo tuyo de los últimos 30 días (un líder, lo de su gente; dirección, todo) con su estado.
//  - GET /api/inbound/count: cuántos tuyos faltan procesar (el aviso de Hoy).
//  - POST /api/inbound/process { refresh }: procesa lo tuyo pendiente (en tandas: more = quedan). Escribe en Pipedrive.
//  - POST /api/inbound/:key/process { as }: uno; as = el email de otra persona («Crear a nombre de X»: su líder o dirección).
//  - POST /api/inbound/:key/existing { pick | none, as }: la respuesta a «¿es alguno de estos?».
//  - POST /api/inbound/paste (texto): los mensajes copiados de Slack (no escribe en Pipedrive).
//  - GET/POST /api/inbound/me { slack }: «Tu usuario de Slack» (vacío = automático) y los nombres que aparecen en el canal.
// READ_ONLY=1 bloquea las tres que escriben en Pipedrive (lib/readonly.js).
import express from "express";
import * as IR from "./inbound-run.js";
import { bump } from "./store.js";

const httpErr = (status, error) => Object.assign(new Error(error), { status });
export function mountInbound(app, { auth, wrap, leadScopeFor }) {
  const text = express.text({ type: () => true, limit: "200kb" });
  const KEY = /^[\w.]{3,40}$/;
  const key = req => { const k = String(req.params.key || ""); if (!KEY.test(k)) throw httpErr(400, "Lead inválido"); return k; };
  const slow = async (req, n = 60) => { if ((await bump(`inb:${String(req.session.user.email).toLowerCase()}`, 600)) > n) throw httpErr(429, "Muchos pedidos seguidos: esperá unos minutos."); };
  app.get("/api/inbound", auth, wrap(async (req, res) => res.json(await IR.listFor(req.session.user, await leadScopeFor(req.session.user.email), { refresh: req.query.refresh === "1" }))));
  app.get("/api/inbound/count", auth, wrap(async (req, res) => res.json(await IR.pendingCount(req.session.user))));
  app.post("/api/inbound/process", auth, wrap(async (req, res) => { await slow(req); res.json(await IR.processMine(req.session.user, { tz: req.tz, refresh: !!req.body?.refresh })); }));
  app.post("/api/inbound/paste", auth, text, wrap(async (req, res) => { await slow(req); res.json(await IR.paste(req.session.user, typeof req.body === "string" ? req.body : req.body?.text || "")); }));
  app.get("/api/inbound/me", auth, wrap(async (req, res) => res.json(await IR.slackPrefFor(req.session.user))));
  app.post("/api/inbound/me", auth, wrap(async (req, res) => res.json(await IR.setSlackPref(req.session.user, req.body?.slack))));
  app.post("/api/inbound/:key/process", auth, wrap(async (req, res) => { await slow(req); res.json(await IR.processOne(req.session.user, await leadScopeFor(req.session.user.email), key(req), { tz: req.tz, as: String(req.body?.as || "") })); }));
  app.post("/api/inbound/:key/existing", auth, wrap(async (req, res) => { await slow(req); res.json(await IR.answerExisting(req.session.user, await leadScopeFor(req.session.user.email), key(req), { tz: req.tz, as: String(req.body?.as || ""), pick: req.body?.pick || "", none: !!req.body?.none })); }));
}
