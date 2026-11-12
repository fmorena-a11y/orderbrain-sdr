// Pipedrive falso para las pruebas del mail desde Pipedrive (lib/pdtoken.js, lib/pdmcp.js), en memoria:
//  · GET /v1/users/me con x-api-token (de quién es el token), como la API de Pipedrive.
//  · El servidor MCP (initialize, notifications/initialized, tools/call de createMailDraft y sendMailDraft) con x-api-token.
//    Como el real: initialize responde aunque el token no valga, y los errores de la API llegan DENTRO del resultado de la
//    herramienta (texto JSON con «errors» o «success: false», o isError), no como error JSON-RPC.
// F (el estado) deja ver qué se pidió y cambiar cómo responde: JSON o SSE, formato del borrador, errores, etc.
import http from "node:http";

export async function fakePipedrive() {
  const F = {
    users: new Map(), dead: new Set(), meCalls: [], usersDown: false,
    sse: false, sseKeepOpen: false, authStyle: "errors", draftFormat: "text-json", sendMode: "ok", createMode: null,
    mcpCalls: [], sessions: new Set(), drafts: [], sent: [], deleted: 0,
  };
  let n = 0;
  const read = req => new Promise(r => { let b = ""; req.on("data", c => b += c); req.on("end", () => r(b)); });
  const json = (res, status, body, headers = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body)); };
  const whoOf = tok => F.users.has(tok) && !F.dead.has(tok) ? F.users.get(tok) : null;
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url, F.base), body = await read(req), tok = String(req.headers["x-api-token"] || "");
    // ---------- API de Pipedrive
    if (req.method === "GET" && url.pathname === "/v1/users/me") {
      F.meCalls.push({ token: tok, auth: req.headers.authorization || null });
      if (F.usersDown) return json(res, 500, { success: false, error: "boom" });
      const u = whoOf(tok);
      if (!u) return json(res, 401, { success: false, error: "unauthorized access", errorCode: 401 });
      return json(res, 200, { success: true, data: { id: u.id, name: u.name, email: u.email, company_id: 77, company_name: "OrderEAT", company_domain: u.company_domain ?? "ordereat" } });
    }
    // ---------- servidor MCP
    if (url.pathname === "/mcp") {
      if (req.method === "DELETE") { F.deleted++; F.sessions.delete(req.headers["mcp-session-id"]); res.writeHead(200); return res.end(); }
      const msg = JSON.parse(body || "{}"), sid = req.headers["mcp-session-id"];
      F.mcpCalls.push({ method: msg.method, name: msg.params?.name, args: msg.params?.arguments, sid, token: tok, auth: req.headers.authorization || null, accept: req.headers.accept, version: req.headers["mcp-protocol-version"] });
      const reply = (result, headers = {}) => {
        const out = { jsonrpc: "2.0", id: msg.id, result };
        if (!F.sse) return json(res, 200, out, headers);
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", ...headers });
        res.write(`: ping\n\nevent: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: {} })}\n\n`);
        res.write(`event: message\nid: 1\ndata: ${JSON.stringify(out)}\n\n`);
        if (F.sseKeepOpen) setTimeout(() => res.end(), 3000); else res.end();
      };
      const text = t => ({ content: [{ type: "text", text: typeof t === "string" ? t : JSON.stringify(t) }] });
      if (msg.method === "initialize") { const s = `sid-${++n}`; F.sessions.add(s); return reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "pipedrive-falso", version: "0" } }, { "mcp-session-id": s }); }
      if (!F.sessions.has(sid)) { res.writeHead(404); return res.end(); }
      if (msg.method === "notifications/initialized") { res.writeHead(202); return res.end(); }
      if (msg.method !== "tools/call") return json(res, 200, { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
      const name = msg.params?.name, args = msg.params?.arguments || {}, who = whoOf(tok);
      // token que no vale: el MCP lo pasa a la API y el 401 vuelve adentro del resultado (o, si se pide, como HTTP 401)
      if (!who) {
        if (F.authStyle === "http") { res.writeHead(401); return res.end(); }
        return reply(F.authStyle === "success" ? text({ success: false, error: "Pipedrive API returned 401: unauthorized access" })
          : F.authStyle === "isError" ? { ...text("Pipedrive API returned 401"), isError: true }
          : text({ errors: { user: "Pipedrive API returned 401", details: { status: 401 } } }));
      }
      if (name === "createMailDraft") {
        if (F.createMode === "nomailbox") return reply(text({ success: false, error: "No connected mailbox found for this user." }));
        const id = 5000 + F.drafts.length + 1; F.drafts.push({ id, args, who, sent: false });
        const f = F.draftFormat;
        return reply(f === "structured" ? { ...text("Draft created."), structuredContent: { success: true, data: { id, subject: args.subject } } }
          : f === "text-json" ? text({ success: true, data: { id, deal_id: args.deal_id || null, lead_id: args.lead_id || null } })
          : f === "text" ? text(`Draft created successfully (draft id: ${id}).`) : text("Draft created."));
      }
      if (name === "sendMailDraft") {
        const d = F.drafts.find(x => x.id === Number(args.id));
        if (F.sendMode === "500") { res.writeHead(500); return res.end("boom"); }
        if (F.sendMode === "cut") return req.socket.destroy();
        if (F.sendMode === "isError") return reply({ ...text("Sending failed: the recipient was rejected."), isError: true });
        if (F.sendMode === "error" || !d) return reply(text({ success: false, error: d ? "Sending failed: the recipient was rejected." : "Draft not found" }));
        d.sent = true; F.sent.push(d);
        return reply(text({ success: true, data: { id: d.id, status: "queued" } }));
      }
      return json(res, 200, { jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "Unknown tool" } });
    }
    res.writeHead(404); res.end();
  });
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  F.base = `http://127.0.0.1:${srv.address().port}`; F.mcp = `${F.base}/mcp`;
  // un token API personal (40 hexadecimales, como los de Pipedrive) para ese usuario
  F.token = (who, tok = Array.from({ length: 40 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("")) => { F.users.set(tok, who); return tok; };
  F.close = () => new Promise(r => { srv.closeAllConnections?.(); srv.close(r); });
  return F;
}
