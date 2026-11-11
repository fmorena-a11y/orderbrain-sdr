// Accesos del equipo (lib/access.js): quién es líder o dirección, quién puede cambiar qué, nadie se saca el suyo y lo fijo
// (dueño del token, LEADER_EMAILS, FOUNDER_EMAILS) no se baja desde la app. Más el guardado en lib/store.js con Redis.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LEVELS, parseEmails, fixedLevel, accessOf, accessLabel, changeError, accessRecord, accessChoices, cleanTitle, leaderLevel } from "../lib/access.js";
import { fakeUpstash } from "./fake-upstash.mjs";

const env = { owner: "Dueno@ordereat.com", leaders: parseEmails(" lider@ordereat.com, ,LIDER2@ordereat.com;x"), founders: parseEmails("ceo@ordereat.com") };
const acc = (email, assigned = null) => accessOf({ fixed: fixedLevel(email, env), assigned });

test("parseEmails: separa por coma, espacio o punto y coma, sin mayúsculas ni basura", () => {
  assert.deepEqual(env.leaders, ["lider@ordereat.com", "lider2@ordereat.com"]);
  assert.deepEqual(parseEmails(""), []);
  assert.deepEqual(parseEmails(undefined), []);
  assert.deepEqual(parseEmails("a@x.com a@x.com"), ["a@x.com"]);
});

test("quién es líder: dueño del token, LEADER_EMAILS, FOUNDER_EMAILS (dirección) y lo asignado; los demás, equipo", () => {
  assert.equal(fixedLevel("dueno@ordereat.com", env), "lider");
  assert.equal(fixedLevel("LIDER@ordereat.com", env), "lider");
  assert.equal(fixedLevel("ceo@ordereat.com", env), "direccion");
  assert.equal(fixedLevel("sdr@ordereat.com", env), null);
  assert.equal(fixedLevel("", env), null);
  // sin dueño conocido (Pipedrive no respondió): nadie es líder por eso
  assert.equal(fixedLevel("", { owner: "", leaders: [], founders: [] }), null);
  assert.equal(fixedLevel("x@y.com", { owner: "" }), null);

  assert.deepEqual([acc("dueno@ordereat.com").leader, acc("ceo@ordereat.com").leader, acc("sdr@ordereat.com").leader], [true, true, false]);
  assert.equal(acc("sdr@ordereat.com").level, "equipo");
  // asignado desde la app
  const cto = acc("cto@ordereat.com", { level: "direccion", title: "CTO", byName: "Ana Ruiz", at: "2026-11-11T10:00:00Z" });
  assert.deepEqual({ ...cto }, { level: "direccion", leader: true, fixed: null, title: "CTO", by: "Ana Ruiz", at: "2026-11-11T10:00:00Z" });
  assert.equal(acc("x@ordereat.com", { level: "lider" }).leader, true);
  // sacado (queda el registro de quién lo sacó): vuelve a equipo
  assert.equal(acc("x@ordereat.com", { level: "equipo", by: "ana@ordereat.com" }).leader, false);
  // lo guardado roto o con un nivel que no existe no da acceso
  for (const bad of [{ level: "admin" }, { level: "constructor" }, { level: "__proto__" }, { level: ["lider"] }, {}, "lider"]) assert.equal(acc("x@ordereat.com", bad).leader, false, JSON.stringify(bad));
  assert.equal(leaderLevel("toString"), false);
});

test("lo fijo es un piso: lo asignado no lo baja, pero un líder fijo puede pasar a dirección con cargo", () => {
  assert.equal(acc("dueno@ordereat.com", { level: "equipo" }).level, "lider");
  const up = acc("dueno@ordereat.com", { level: "direccion", title: "CEO" });
  assert.deepEqual([up.level, up.fixed, up.title], ["direccion", "lider", "CEO"]);
  // FOUNDER_EMAILS manda sobre una asignación menor; el cargo se puede poner desde la app
  assert.equal(acc("ceo@ordereat.com", { level: "lider" }).level, "direccion");
  assert.equal(acc("ceo@ordereat.com", { level: "direccion", title: "CEO" }).title, "CEO");
  assert.equal(acc("ceo@ordereat.com").title, "");
});

test("cómo se muestra: «Dirección · CEO», «Dirección», «Líder» o nada; el cargo solo va con dirección", () => {
  assert.equal(accessLabel(acc("cto@ordereat.com", { level: "direccion", title: "CTO" })), "Dirección · CTO");
  assert.equal(accessLabel(acc("ceo@ordereat.com")), "Dirección");
  assert.equal(accessLabel(acc("x@ordereat.com", { level: "lider", title: "CEO" })), "Líder"); // un cargo viejo no se muestra con líder
  assert.equal(accessLabel(acc("x@ordereat.com")), "");
  assert.equal(accessLabel(null), "");
  assert.equal(cleanTitle("  <Cofundadora>\n y  CEO de todo el universo conocido "), "Cofundadora y CEO de tod"); // una línea, 24 como mucho
  assert.equal(cleanTitle(" CTO\t"), "CTO");
  assert.equal(cleanTitle(null), "");
  assert.deepEqual(accessRecord({ level: "lider", title: "CEO", by: "Ana@X.com", byName: "Ana", at: "t" }), { level: "lider", title: "", by: "ana@x.com", byName: "Ana", at: "t" });
  assert.equal(accessRecord({ level: "direccion", title: " CEO ", by: "a@x.com", at: "t" }).title, "CEO");
});

test("quién puede cambiar qué: un SDR nada (403), ni a otro ni a sí mismo; un líder o dirección, a cualquiera del Pipedrive", () => {
  const sdr = acc("sdr@ordereat.com"), lider = acc("dueno@ordereat.com"), dir = acc("cto@ordereat.com", { level: "direccion", title: "CTO" });
  const ch = (actorEmail, actor, targetEmail, level, known = true) => changeError({ actorEmail, actor, targetEmail, target: acc(targetEmail), level, known });
  for (const [t, l] of [["otro@ordereat.com", "direccion"], ["sdr@ordereat.com", "lider"], ["sdr@ordereat.com", "direccion"], ["dueno@ordereat.com", "equipo"]]) {
    assert.equal(ch("sdr@ordereat.com", sdr, t, l)?.status, 403, `${t} ${l}`);
  }
  // el 403 va antes que todo: un SDR no se entera de si el nivel o la persona existen
  assert.equal(ch("sdr@ordereat.com", sdr, "nadie@ordereat.com", "rey", false)?.status, 403);
  assert.equal(ch("dueno@ordereat.com", lider, "otro@ordereat.com", "direccion"), null);
  assert.equal(ch("dueno@ordereat.com", lider, "otro@ordereat.com", "lider"), null);
  assert.equal(ch("cto@ordereat.com", dir, "otro@ordereat.com", "equipo"), null); // dirección también asigna y saca
  assert.equal(ch("dueno@ordereat.com", lider, "otro@ordereat.com", "rey")?.status, 400);
  assert.equal(ch("dueno@ordereat.com", lider, "otro@ordereat.com", "constructor")?.status, 400);
  assert.equal(ch("dueno@ordereat.com", lider, "fuera@gmail.com", "lider", false)?.status, 404);
});

test("nadie se saca a sí mismo el acceso (sí puede cambiar su cargo o pasar de dirección a líder)", () => {
  const me = "cto@ordereat.com", dir = acc(me, { level: "direccion", title: "CTO" });
  const e = changeError({ actorEmail: me, actor: dir, targetEmail: "CTO@ordereat.com", target: dir, level: "equipo", known: true });
  assert.equal(e?.status, 409); assert.match(e.error, /propio acceso/);
  assert.equal(changeError({ actorEmail: me, actor: dir, targetEmail: me, target: dir, level: "direccion", known: true }), null);
  assert.equal(changeError({ actorEmail: me, actor: dir, targetEmail: me, target: dir, level: "lider", known: true }), null);
  const choices = accessChoices({ actorEmail: me, targetEmail: me, target: dir });
  assert.deepEqual(choices.map(c => [c.level, c.disabled]), [["equipo", true], ["lider", false], ["direccion", false]]);
  assert.match(choices[0].why, /propio acceso/);
});

test("lo de env o del dueño del token no se saca desde la app (y se muestra fijo)", () => {
  const lider = acc("x@ordereat.com", { level: "lider" });
  for (const [t, l, st] of [["dueno@ordereat.com", "equipo", 409], ["lider@ordereat.com", "equipo", 409], ["ceo@ordereat.com", "lider", 409], ["ceo@ordereat.com", "equipo", 409]]) {
    const e = changeError({ actorEmail: "x@ordereat.com", actor: lider, targetEmail: t, target: acc(t), level: l, known: true });
    assert.equal(e?.status, st, `${t} → ${l}`); assert.match(e.error, /administrador/);
  }
  // subir a un líder fijo a dirección sí se puede; a un founder de env, ponerle el cargo también
  assert.equal(changeError({ actorEmail: "x@ordereat.com", actor: lider, targetEmail: "dueno@ordereat.com", target: acc("dueno@ordereat.com"), level: "direccion", known: true }), null);
  assert.equal(changeError({ actorEmail: "x@ordereat.com", actor: lider, targetEmail: "ceo@ordereat.com", target: acc("ceo@ordereat.com"), level: "direccion", known: true }), null);
  assert.deepEqual(accessChoices({ actorEmail: "x@ordereat.com", targetEmail: "dueno@ordereat.com", target: acc("dueno@ordereat.com") }).map(c => c.disabled), [true, false, false]);
  assert.deepEqual(accessChoices({ actorEmail: "x@ordereat.com", targetEmail: "ceo@ordereat.com", target: acc("ceo@ordereat.com") }).map(c => c.disabled), [true, true, false]);
  assert.deepEqual(accessChoices({ actorEmail: "x@ordereat.com", targetEmail: "sdr@ordereat.com", target: acc("sdr@ordereat.com") }).map(c => c.disabled), [false, false, false]);
  assert.deepEqual(Object.keys(LEVELS), ["equipo", "lider", "direccion"]);
});

// ---------- guardado: Redis (clave propia «access», sin vencimiento) y lectura de otra instancia
for (const k of ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "PIPEDRIVE_API_TOKEN", "DEMO_MODE"]) delete process.env[k];
const R = await fakeUpstash();
process.env.KV_REST_API_URL = R.url; process.env.KV_REST_API_TOKEN = "x"; process.env.KV_PREFIX = "acc:";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ob-acc-"));
const store = await import("../lib/store.js");
after(() => R.close());

test("store: se guarda por email en un hash sin vencimiento; otra instancia lo ve al releer", async () => {
  const rec = accessRecord({ level: "direccion", title: "CEO", by: "ana@ordereat.com", byName: "Ana Ruiz", at: "2026-11-11T12:00:00Z" });
  await store.setAccess("Mati@OrderEAT.com", rec);
  assert.deepEqual(JSON.parse(R.hash.get("acc:access").get("mati@ordereat.com")), rec);
  assert.equal(R.ttl ? R.ttl("acc:access") : -1, -1); // sin vencimiento
  // otra instancia lo saca: esta lo ve al releer (fresh, o pasados 5 s)
  R.run(["HSET", "acc:access", "mati@ordereat.com", JSON.stringify({ ...rec, level: "equipo", title: "" })]);
  assert.equal((await store.getAccessMap({ fresh: true }))["mati@ordereat.com"].level, "equipo");
  // un valor roto se ignora (no da acceso ni rompe la lectura)
  R.run(["HSET", "acc:access", "roto@ordereat.com", "{no es json"]);
  const m = await store.getAccessMap({ fresh: true });
  assert.equal(m["roto@ordereat.com"], undefined);
  assert.equal(accessOf({ assigned: m["roto@ordereat.com"] }).leader, false);
});
