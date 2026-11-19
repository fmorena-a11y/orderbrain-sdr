// public/styles.css: las llaves tienen que cerrar (un @media sin cerrar deja todo lo que sigue solo para el celular: pasó al
// juntar dos cambios a mano) y ningún bloque de primer nivel puede quedar abierto al final.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("styles.css: llaves balanceadas y sin marcas de conflicto", () => {
  const css = fs.readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /^(<<<<<<<|=======|>>>>>>>)/m);
  const s = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, "");
  let depth = 0, max = 0;
  for (const c of s) { if (c === "{") max = Math.max(max, ++depth); else if (c === "}") { depth--; assert.ok(depth >= 0, "hay una llave de cierre de más"); } }
  assert.equal(depth, 0, "queda un bloque sin cerrar");
  assert.ok(max <= 3, "un bloque anidado de más: ¿falta cerrar un @media?");
  // un @media adentro de otro @media casi seguro es uno sin cerrar
  let d = 0, inMedia = 0;
  for (const m of s.matchAll(/@media[^{]*\{|\{|\}/g)) {
    if (m[0].startsWith("@media")) { assert.equal(inMedia, 0, `@media adentro de otro cerca de «${s.slice(m.index, m.index + 60).replace(/\s+/g, " ")}»`); inMedia = d + 1; d++; }
    else if (m[0] === "{") d++;
    else { d--; if (inMedia && d < inMedia) inMedia = 0; }
  }
});
