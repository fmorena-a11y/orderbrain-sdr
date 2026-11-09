# OrderBrain SDR — notas para Claude Code

App Node 20 + Express sin build. Frontend en `public/` con módulos ES nativos (`public/js/*.js`) y Leaflet desde CDN. Sin base de datos: Pipedrive es la fuente de verdad; `DATA_DIR` (por defecto `data/`) guarda `cache.json` (cruce colegio ↔ organización) y `touches.json` (contactos registrados, para cadencia, meta y ranking).

- Correr: `npm run dev` (usa `.env`). Sin Pipedrive ni Google: `npm run demo` (Pipedrive en memoria, `lib/pipedrive-demo.js`). Todo lo que se agregue a `lib/pipedrive.js` necesita su versión en el demo.
- Pipedrive: header `x-api-token`. Lecturas en v2 salvo notas y usuarios (v1). Las horas de actividades van en UTC: convertir con `lib/time.js` (`toUtc`) en el servidor y `localAct` en el frontend. El navegador manda su zona horaria en el header `x-tz`.
- IDs de la cuenta (embudos por país, etapas de entrada, campos personalizados de tratos, opciones, motivos de pérdida, etiquetas de organización) en `lib/config.js`.
- Embudos de clientes: 16 (ONBOARDING), 22 (MX - Clientes), 27 (PERFORMANCE). Etapas muertas: 208 (DROPPED), 249 (Churn).
- Tipos de actividad: `call` = Llamada, `meeting` = Demo, `deadline` = WhatsApp, `task` = Mail, `contacto_decisor` = Contacto decisor.
- Lógica comercial (resultados, cadencia, guion, objeciones, plantillas, puntaje) en `lib/playbook.js`. Vocabulario por país en `MARKETS` de `lib/config.js`.
- Asistente: `lib/ai.js`. Las herramientas de escritura solo PROPONEN; la escritura real ocurre en `POST /api/proposals/:id/confirm`. Mantener ese patrón.
- Textos de la UI en español latinoamericano con voseo, frases cortas, sin mayúsculas sostenidas. Mensajes a colegios: tuteo o voseo según el país.
- Ideas pendientes: carga masiva de colegios desde padrones oficiales (ESCALE Perú, SEP México, MINEDUC Chile) y Google Places; persistir cache y contactos en Postgres si se despliega sin disco; mandar WhatsApp directo por la API de Volt.
