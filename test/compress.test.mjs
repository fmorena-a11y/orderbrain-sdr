// Compresión de JSON grande (lib/compress.js) con un servidor Express de verdad: según el accept-encoding, sin tocar lo
// chico ni lo que no es JSON, con el mismo ETag de antes y 304 si no cambió.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import zlib from "node:zlib";
import express from "express";
import { compressJson, pickEncoding, encode } from "../lib/compress.js";

const big = { rows: Array.from({ length: 800 }, (_, i) => ({ id: i, name: `Colegio número ${i} «ñandú»`, city: "Puebla", stage: "PROPOSAL SENT" })) };
function server(opts) {
  const app = express();
  app.use(compressJson(opts));
  // como en server.js: res.json contesta después (cuando terminaron las escrituras pendientes)
  app.use((req, res, next) => { const json = res.json.bind(res); res.json = body => { Promise.resolve().then(() => json(body)); return res; }; next(); });
  app.get("/big", (req, res) => res.json(big));
  app.post("/big", (req, res) => res.json(big));
  app.get("/small", (req, res) => res.json({ ok: true }));
  app.get("/error", (req, res) => res.status(500).json({ error: "x".repeat(5000) }));
  app.get("/html", (req, res) => res.type("html").send("<p>" + "hola ".repeat(2000) + "</p>"));
  app.get("/pre", (req, res) => res.type("json").set("Content-Encoding", "gzip").send(zlib.gzipSync(JSON.stringify(big))));
  return new Promise(r => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
}
const get = (s, path, headers = {}, method = "GET") => new Promise((resolve, reject) => {
  const req = http.request({ host: "127.0.0.1", port: s.address().port, path, method, headers }, res => { const c = []; res.on("data", d => c.push(d)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c) })); });
  req.on("error", reject); req.end();
});
const plain = Buffer.from(JSON.stringify(big));

test("pickEncoding: br si lo acepta, si no gzip; respeta q=0 y *", () => {
  assert.equal(pickEncoding("gzip, deflate, br, zstd"), "br");
  assert.equal(pickEncoding("gzip, deflate"), "gzip");
  assert.equal(pickEncoding("GZIP"), "gzip");
  assert.equal(pickEncoding("br;q=0, gzip;q=0.5"), "gzip");
  assert.equal(pickEncoding("gzip;q=0"), null);
  assert.equal(pickEncoding("*"), "br"); assert.equal(pickEncoding("*;q=0"), null); assert.equal(pickEncoding("identity"), null);
  assert.equal(pickEncoding(""), null); assert.equal(pickEncoding(undefined), null); assert.equal(pickEncoding("deflate"), null);
});
test("encode: ida y vuelta", async () => {
  assert.deepEqual(zlib.gunzipSync(await encode(plain, "gzip")), plain);
  assert.deepEqual(zlib.brotliDecompressSync(await encode(plain, "br")), plain);
});
test("JSON grande: comprimido según el pedido, mismo contenido, mismo ETag, Vary", async () => {
  const s = await server({ enabled: true });
  try {
    const none = await get(s, "/big");
    assert.equal(none.status, 200); assert.equal(none.headers["content-encoding"], undefined); assert.deepEqual(none.body, plain);
    assert.match(none.headers.vary, /Accept-Encoding/i); assert.equal(Number(none.headers["content-length"]), plain.length);
    const gz = await get(s, "/big", { "accept-encoding": "gzip, deflate" });
    assert.equal(gz.headers["content-encoding"], "gzip"); assert.deepEqual(zlib.gunzipSync(gz.body), plain);
    assert.ok(gz.body.length < plain.length / 5); assert.equal(Number(gz.headers["content-length"]), gz.body.length);
    assert.match(gz.headers["content-type"], /^application\/json; charset=utf-8$/); assert.match(gz.headers.vary, /Accept-Encoding/i);
    const br = await get(s, "/big", { "accept-encoding": "gzip, deflate, br" });
    assert.equal(br.headers["content-encoding"], "br"); assert.deepEqual(zlib.brotliDecompressSync(br.body), plain);
    assert.ok(none.headers.etag); assert.equal(gz.headers.etag, none.headers.etag); assert.equal(br.headers.etag, none.headers.etag);
    const post = await get(s, "/big", { "accept-encoding": "gzip" }, "POST");
    assert.equal(post.headers["content-encoding"], "gzip"); assert.deepEqual(zlib.gunzipSync(post.body), plain);
    // no cambió: 304 sin cuerpo, sin comprimir nada
    const fresh = await get(s, "/big", { "accept-encoding": "gzip, br", "if-none-match": none.headers.etag });
    assert.equal(fresh.status, 304); assert.equal(fresh.body.length, 0); assert.equal(fresh.headers["content-encoding"], undefined);
    const head = await get(s, "/big", { "accept-encoding": "gzip" }, "HEAD");
    assert.equal(head.status, 200); assert.equal(head.body.length, 0);
  } finally { s.close(); }
});
test("no toca lo chico, lo que no es JSON ni lo que ya viene codificado; un error grande también se comprime bien", async () => {
  const s = await server({ enabled: true });
  try {
    const small = await get(s, "/small", { "accept-encoding": "gzip, br" });
    assert.equal(small.headers["content-encoding"], undefined); assert.deepEqual(JSON.parse(small.body), { ok: true });
    const html = await get(s, "/html", { "accept-encoding": "gzip, br" });
    assert.equal(html.headers["content-encoding"], undefined); assert.match(html.body.toString(), /^<p>hola/);
    const pre = await get(s, "/pre", { "accept-encoding": "gzip, br" });
    assert.equal(pre.headers["content-encoding"], "gzip"); assert.deepEqual(zlib.gunzipSync(pre.body), plain, "una sola vez");
    const err = await get(s, "/error", { "accept-encoding": "gzip" });
    assert.equal(err.status, 500); assert.equal(JSON.parse(zlib.gunzipSync(err.body)).error.length, 5000);
  } finally { s.close(); }
});
test("apagada (como en Vercel, donde comprime la plataforma): todo sale igual que antes", async () => {
  const s = await server({ enabled: false });
  try {
    const r = await get(s, "/big", { "accept-encoding": "gzip, br" });
    assert.equal(r.headers["content-encoding"], undefined); assert.deepEqual(r.body, plain); assert.equal(r.headers.vary, undefined);
  } finally { s.close(); }
});
