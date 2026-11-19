// Compresión de las respuestas JSON grandes (la lista de colegios pesa ≈5 MB; Tratos abiertos, ≈1 MB), con zlib de Node.
// Express no comprime solo. En Vercel comprime la plataforma: ahí queda APAGADA para no comprimir dos veces (se puede forzar
// con JSON_COMPRESS=1, o apagar en cualquier lado con JSON_COMPRESS=0). Siempre según el `accept-encoding` del pedido.
import zlib from "zlib";
import { promisify } from "util";
const gzip = promisify(zlib.gzip), brotli = promisify(zlib.brotliCompress);

export const ENABLED = process.env.JSON_COMPRESS ? process.env.JSON_COMPRESS !== "0" : !process.env.VERCEL;
const MIN_BYTES = 1400; // menos que esto entra en un paquete: comprimirlo no ahorra nada

// «br» si el navegador lo acepta (más chico y más rápido que gzip a este nivel), si no «gzip»; null si no acepta ninguno.
export function pickEncoding(header) {
  const q = new Map();
  for (const part of String(header || "").toLowerCase().split(",")) {
    const [name, ...params] = part.trim().split(";").map(x => x.trim()); if (!name) continue;
    const qv = params.find(p => p.startsWith("q=")), n = qv ? Number(qv.slice(2)) : 1;
    q.set(name, Number.isFinite(n) ? n : 0);
  }
  const ok = name => (q.has(name) ? q.get(name) : q.get("*") || 0) > 0;
  return ok("br") ? "br" : ok("gzip") ? "gzip" : null;
}
// brotli 4 y gzip 6: en la lista de colegios (5,1 MB) ≈60 y ≈90 ms en otro hilo (no frena al servidor) y queda en ≈1 MB
export const encode = (buf, enc) => enc === "br" ? brotli(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length } }) : gzip(buf, { level: 6 });

// Middleware: comprime lo que sale por res.json / res.send con Content-Type JSON, de MIN_BYTES para arriba, si el pedido lo
// acepta y nadie lo codificó antes. El ETag es el de Express sobre el cuerpo SIN comprimir (el mismo de antes), así un
// If-None-Match sigue dando 304 sin comprimir nada. Archivos estáticos y respuestas por partes (res.write) no pasan por acá.
export function compressJson({ enabled = ENABLED, min = MIN_BYTES } = {}) {
  return (req, res, next) => {
    if (!enabled) return next();
    const send = res.send;
    res.send = function (body) {
      const plain = () => send.call(this, body);
      if (typeof body !== "string" && !Buffer.isBuffer(body)) return plain();
      if (req.method === "HEAD" || res.get("Content-Encoding") || !/json/i.test(String(res.get("Content-Type") || ""))) return plain();
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
      if (buf.length < min) return plain();
      res.vary("Accept-Encoding");
      const enc = pickEncoding(req.headers["accept-encoding"]);
      if (!enc) return plain();
      if (!res.get("ETag")) { const fn = req.app.get("etag fn"), tag = fn && fn(buf, "utf8"); if (tag) res.set("ETag", tag); }
      if (req.fresh) return plain(); // Express contesta 304 sin cuerpo
      encode(buf, enc).then(out => { res.set("Content-Encoding", enc); send.call(this, out); })
        .catch(() => { if (!res.headersSent) { res.removeHeader("Content-Encoding"); send.call(this, body); } });
      return this;
    };
    next();
  };
}
