// Vista Sesiones (#/sesiones): cómo se reparten las sesiones en «De hoy», «Activas», «Inactivas» y «Terminadas»
// (public/js/sessgroups.js, puro). «Hoy» es el día de quien mira, en su zona.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sessionGroups, localDay, idleDays, isIdle, isToday, INACTIVE_DAYS } from "../public/js/sessgroups.js";

const NOW = Date.parse("2026-11-16T15:00:00Z"); // lunes 16, 9:00 en Ciudad de México
const TZ = "America/Mexico_City", H = 36e5, D = 864e5;
const at = ms => new Date(ms).toISOString();
const mk = (id, created, last, extra = {}) => ({ id, name: id, status: "open", createdAt: at(created), updatedAt: at(last), lastAt: at(last), ...extra });

test("localDay: el día en la zona de quien mira", () => {
  assert.equal(localDay("2026-11-16T05:00:00Z", TZ), "2026-11-15"); // 23:00 del domingo en México
  assert.equal(localDay("2026-11-16T05:00:00Z", "UTC"), "2026-11-16");
  assert.equal(localDay(NOW, TZ), "2026-11-16");
  assert.equal(localDay("cualquier cosa", TZ), "");
});

test("secciones: de hoy (movida o creada hoy), activas (todas las abiertas), inactivas (3 días o más sin movimiento) y terminadas", () => {
  const list = {
    open: [
      mk("hoy-movida", NOW - 5 * D, NOW - 2 * H),
      mk("hoy-creada", NOW - 1 * H, NOW - 1 * H),
      mk("anoche", NOW - 2 * D, NOW - 10 * H), // 23:00 de ayer en México: no es de hoy
      mk("dos-dias", NOW - 9 * D, NOW - 2 * D - 23 * H), // casi 3 días: todavía no está inactiva
      mk("tres-dias", NOW - 9 * D, NOW - 3 * D),
      mk("vieja", NOW - 20 * D, NOW - 12 * D),
    ],
    done: [
      { id: "t1", status: "done", endedAt: at(NOW - 3 * D), createdAt: at(NOW - 4 * D), updatedAt: at(NOW - 3 * D) },
      { id: "t2", status: "done", endedAt: at(NOW - 1 * H), createdAt: at(NOW - 2 * H), updatedAt: at(NOW - 1 * H) },
    ],
  };
  const G = sessionGroups(list, { now: NOW, tz: TZ });
  assert.deepEqual(G.hoy.map(v => v.id), ["hoy-creada", "hoy-movida"]); // la más reciente primero
  assert.deepEqual(G.activas.map(v => v.id), ["hoy-creada", "hoy-movida", "anoche", "dos-dias", "tres-dias", "vieja"]);
  assert.deepEqual(G.inactivas.map(v => v.id), ["tres-dias", "vieja"]);
  assert.deepEqual(G.terminadas.map(v => v.id), ["t2", "t1"]); // la última que terminó primero; una terminada hoy no es «de hoy»
  assert.equal(INACTIVE_DAYS, 3);
  assert.equal(idleDays(list.open[5], NOW), 12);
  assert.equal(idleDays(list.open[0], NOW), 0);
  assert.equal(isIdle(list.done[0], NOW + 30 * D), false); // una terminada no es inactiva
  assert.equal(isToday(list.done[1], NOW, TZ), false);
});

test("secciones: sin lastAt usa updatedAt; lista vacía o sin datos no rompe", () => {
  const v = { id: "x", status: "open", createdAt: at(NOW - 10 * D), updatedAt: at(NOW - 4 * D) };
  assert.deepEqual(sessionGroups({ open: [v] }, { now: NOW, tz: TZ }).inactivas.map(s => s.id), ["x"]);
  assert.deepEqual(sessionGroups(null), { hoy: [], activas: [], inactivas: [], terminadas: [] });
});
