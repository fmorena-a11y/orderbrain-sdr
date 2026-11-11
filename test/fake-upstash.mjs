// Upstash falso para las pruebas: POST /pipeline con los comandos que usa la app (lib/store.js, lib/sync.js).
// Guarda en memoria; log lleva cada comando (para ver qué se pidió) y hooks permite meterse antes de responder
// (por ejemplo, simular que otra instancia escribe justo antes de una lectura).
import http from "node:http";

export async function fakeUpstash() {
  const str = new Map(), hash = new Map(), zset = new Map(), exp = new Map(), log = [], hooks = [];
  const alive = k => { const t = exp.get(k); if (t && t <= Date.now()) { str.delete(k); exp.delete(k); } return str.has(k); };
  const H = k => { let h = hash.get(k); if (!h) hash.set(k, h = new Map()); return h; };
  const Z = k => { let z = zset.get(k); if (!z) zset.set(k, z = new Map()); return z; };
  const sorted = k => [...Z(k).entries()].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1));
  const num = v => v === "+inf" ? Infinity : v === "-inf" ? -Infinity : Number(v);
  function run([cmd, ...a]) {
    switch (String(cmd).toUpperCase()) {
      case "GET": return alive(a[0]) ? str.get(a[0]) : null;
      case "SET": {
        const [k, v, ...o] = a, up = o.map(x => String(x).toUpperCase());
        if (up.includes("NX") && alive(k)) return null;
        str.set(k, String(v)); exp.delete(k);
        const px = up.indexOf("PX"), ex = up.indexOf("EX");
        if (px >= 0) exp.set(k, Date.now() + Number(o[px + 1])); if (ex >= 0) exp.set(k, Date.now() + Number(o[ex + 1]) * 1000);
        return "OK";
      }
      case "MGET": return a.map(k => alive(k) ? str.get(k) : null);
      // vencimiento: en las claves simples se aplica al leer; en hashes y zsets solo se anota (ttl, para las pruebas)
      case "EXPIRE": { if (!(str.has(a[0]) || hash.has(a[0]) || zset.has(a[0]))) return 0; exp.set(a[0], Date.now() + Number(a[1]) * 1000); return 1; }
      case "DEL": { let n = 0; for (const k of a) { exp.delete(k); if (str.delete(k) | hash.delete(k) | zset.delete(k)) n++; } return n; }
      case "HSET": { const h = H(a[0]); for (let i = 1; i < a.length; i += 2) h.set(String(a[i]), String(a[i + 1])); return (a.length - 1) / 2; }
      case "HGET": return hash.get(a[0])?.get(String(a[1])) ?? null;
      case "HMGET": return a.slice(1).map(f => hash.get(a[0])?.get(String(f)) ?? null);
      case "HDEL": { let n = 0; for (const f of a.slice(1)) if (hash.get(a[0])?.delete(String(f))) n++; return n; }
      case "HGETALL": return [...(hash.get(a[0]) || new Map())].flat();
      case "HSCAN": {
        const all = [...(hash.get(a[0]) || new Map())], at = Number(a[1]) || 0, count = Number(a[a.findIndex(x => String(x).toUpperCase() === "COUNT") + 1]) || 10;
        const next = at + count < all.length ? String(at + count) : "0";
        return [next, all.slice(at, at + count).flat()];
      }
      case "ZADD": { const z = Z(a[0]); for (let i = 1; i < a.length; i += 2) z.set(String(a[i + 1]), Number(a[i])); return (a.length - 1) / 2; }
      case "ZRANGE": { const l = sorted(a[0]), s = Number(a[1]), e = Number(a[2]), end = e < 0 ? l.length + e : e; const r = l.slice(s, end + 1); return a.includes("WITHSCORES") ? r.flatMap(([m, sc]) => [m, String(sc)]) : r.map(x => x[0]); }
      case "ZRANGEBYSCORE": { const lo = num(a[1]), hi = num(a[2]), r = sorted(a[0]).filter(([, sc]) => sc >= lo && sc <= hi); return a.includes("WITHSCORES") ? r.flatMap(([m, sc]) => [m, String(sc)]) : r.map(x => x[0]); }
      case "ZREMRANGEBYRANK": { const l = sorted(a[0]), n = l.length, s = Number(a[1]) < 0 ? n + Number(a[1]) : Number(a[1]), e = Number(a[2]) < 0 ? n + Number(a[2]) : Number(a[2]); l.slice(Math.max(0, s), e + 1).forEach(([m]) => Z(a[0]).delete(m)); return 0; }
      default: throw new Error("comando no soportado: " + cmd);
    }
  }
  const state = { down: false }; // down: responde 503 a todo (Redis caído)
  const srv = http.createServer((req, res) => {
    let body = ""; req.on("data", c => body += c);
    req.on("end", async () => {
      if (state.down) { res.writeHead(503); res.end("caído"); return; }
      const cmds = JSON.parse(body || "[]");
      for (const c of cmds) { log.push(c); for (const h of hooks) await h(c, { run }); }
      const out = cmds.map(c => { try { return { result: run(c) }; } catch (e) { return { error: e.message }; } });
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(out));
    });
  });
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${srv.address().port}`, run, log, hooks, hash, str, down: on => { state.down = !!on; }, ttl: k => exp.has(k) ? Math.round((exp.get(k) - Date.now()) / 1000) : -1, close: () => srv.close() };
}
