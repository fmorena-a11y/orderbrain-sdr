// Lectura de la web del colegio en lib/enrich.js: sedes con teléfono, texto visible y fotos.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sedesFromHtml, htmlText, siteImages } from "../lib/enrich.js";

test("sedesFromHtml: planteles de Esfer con uno o dos teléfonos, tal cual están escritos", () => {
  const html = `<div><p>PLANTEL GLANDORFF 4131045</p><p>PLANTEL CORDILLERAS 4988334 y 4988698</p></div>`;
  assert.deepEqual(sedesFromHtml(html), [
    { kind: "plantel", name: "GLANDORFF", phones: ["4131045"] },
    { kind: "plantel", name: "CORDILLERAS", phones: ["4988334", "4988698"] },
  ]);
});
test("sedesFromHtml: sede con dos puntos y teléfonos con formato", () => assert.deepEqual(sedesFromHtml("<p>Sede Norte: (614) 410-1032 y 416 0339</p>"), [{ kind: "sede", name: "Norte", phones: ["(614) 410-1032", "416 0339"] }]));
test("sedesFromHtml: un ciclo escolar «2024 - 2025» no es teléfono", () => {
  assert.deepEqual(sedesFromHtml("<p>Plantel Sur 2024 - 2025</p><p>Ciclo 2024 - 2025</p>"), []);
});
test("sedesFromHtml: «Unidad Educativa» o «Sede Educativa» no son sedes", () => {
  assert.deepEqual(sedesFromHtml("<p>Unidad Educativa San José 4131045</p><p>Unidad Educativa 2024 - 2025</p><p>Sede Educativa 4988334</p><p>Unidad Deportiva 4988698</p>"), []);
});
test("sedesFromHtml: la misma sede repetida cuenta una vez", () => assert.equal(sedesFromHtml("<p>Plantel Centro 4131045</p><footer>Plantel Centro 4131045</footer>").length, 1));

test("htmlText: saca etiquetas, scripts y estilos, y decodifica entidades", () => {
  assert.equal(htmlText(`<p>Colegio&nbsp;San&nbsp;Jos&eacute;</p><script>var x = "<b>no</b>";</script><style>p{}</style><b>Tel&#233;fono</b>`).trim(), "Colegio San José Teléfono");
});
test("htmlText: un script sin cerrar no deja pasar su contenido", () => assert.equal(htmlText("Hola<script>alert('x')").trim(), "Hola"));
test("htmlText: lineal, 900 KB de «<» en menos de 200 ms", () => {
  for (const html of ["<".repeat(900000), "<a".repeat(450000), "<script".repeat(128000)]) {
    const t = performance.now(); htmlText(html); sedesFromHtml(html);
    assert.ok(performance.now() - t < 200, `${(performance.now() - t).toFixed(0)} ms`);
  }
});

test("siteImages: descarta logos, íconos, data:, http, chicas por width o ?width=322 y la misma foto en otro tamaño", () => {
  const html = `<img src="/img/logo.png"><img src="https://x.com/icons/a.jpg"><img src="data:image/png;base64,xx">
    <img src="https://cdn.x.com/foto.jpg?width=322"><img src="https://cdn.x.com/patio.jpg?width=1200"><img src="https://cdn.x.com/patio.jpg?width=800">
    <img src="https://x.com/wp-content/uploads/aula.jpg" width="120"><img src="http://x.com/b.jpg"><img alt="Logo del colegio" src="https://x.com/escudo.jpg">
    <img data-src="https://x.com/wp-content/uploads/2024/05/patio-grande.jpg" src="data:,">
    <img src="https://x.com/c.webp">`;
  assert.deepEqual(siteImages(html, "https://x.com/"), ["https://cdn.x.com/patio.jpg?width=1200", "https://x.com/wp-content/uploads/2024/05/patio-grande.jpg", "https://x.com/c.webp"]);
});
test("siteImages: resuelve rutas relativas y pone primero la portada sin repetirla", () => {
  assert.deepEqual(siteImages(`<img src="/fotos/portada.jpg?v=2"><img src="/fotos/aula.jpg">`, "https://colegio.edu.mx/inicio", "https://colegio.edu.mx/fotos/portada.jpg"),
    ["https://colegio.edu.mx/fotos/portada.jpg", "https://colegio.edu.mx/fotos/aula.jpg"]);
});
test("siteImages: como mucho 8 fotos", () => assert.equal(siteImages(Array.from({ length: 20 }, (_, i) => `<img src="https://x.com/f${i}.jpg">`).join(""), "https://x.com/").length, 8));
