# OrderBrain SDR

La herramienta de prospección del equipo de ventas de OrderEAT. Le dice a cada SDR a quién llamar, qué decir y deja todo guardado en Pipedrive sin cargar nada a mano.

## Cómo es un día con OrderBrain

1. **Hoy.** Al entrar ves tu meta diaria de contactos, tu agenda de Pipedrive (vencidas, hoy, próximos 7 días) y la lista **A quién llamar ahora**, ordenada por prioridad dentro de tu territorio.
2. **Empezar sesión.** Un botón arma la cola del día: primero los compromisos vencidos y de hoy, después los mejores prospectos. Vas colegio por colegio sin volver a la lista. Los clientes se saltean solos.
3. **Preparar.** Cada ficha trae la situación del colegio en Pipe, el objetivo de la llamada, los primeros 15 segundos, las preguntas para calificar, las respuestas a objeciones y el cierre. Todo en el vocabulario del país (cafetería, cantina, casino, soda; tú o vos). Con IA, **Preparar con IA** lee las notas y tratos de Pipe y arma un brief a medida.
4. **Contactar.** Llamar, WhatsApp o Mail desde la ficha. WhatsApp y Gmail se abren con plantillas listas (primer contacto, después de no atender, mandar info, confirmar demo, reactivar) que se pueden mejorar con IA.
5. **Registrar.** Canal, resultado y, según el resultado, decisor, calificación, demo o motivo de pérdida. La app sugiere el próximo paso con criterio de cadencia (por ejemplo: «intento 1 sin respuesta: mandá un WhatsApp hoy»; «pidió info: mail hoy y llamada en 2 días hábiles»).
6. **Guardar en Pipedrive** (Ctrl + Enter) y pasar al siguiente.

## Qué se escribe en Pipedrive

Cada registro hace, según el caso:

| Qué | Dónde |
|---|---|
| El contacto como actividad **hecha** (Llamada, WhatsApp, Mail o Contacto decisor) | Organización (y trato abierto si hay) |
| Nota ordenada: resultado, calificación, contacto y, con IA, resumen, decisor, objeción e interés | Organización / trato |
| Persona con nombre, cargo, teléfono y email | Organización |
| **Trato nuevo** al agendar una demo, en el embudo del país (MX, PE, ARG, CHI, UY o LatAm), etapa SELLING, con Fuente «Outbound - Cold Calling», SDR, País, Cafetería, Cantidad de alumnos, Niveles, teléfono y web | Embudo de ventas |
| Demo (actividad «Demo») asignada a quien la da | Trato |
| Próximo paso (llamada, WhatsApp o mail) para vos o alguien del equipo | Trato / organización |
| Trato perdido con el motivo de la cuenta (No es prioridad ahora, No responde más, etc.) | Trato |
| Etiqueta de interés de la organización (muy, algo o poco interesado) | Organización |
| Organización nueva si el colegio no existía | Pipedrive |

Las horas se guardan en UTC, como pide Pipedrive, y se muestran en la hora local de cada persona.

Después de una demo aparecen los atajos para crear la invitación en **Google Calendar** y confirmar por **WhatsApp**. WhatsApp se abre en la app o en WhatsApp Web; si el equipo usa **Volt**, la conversación queda registrada en el CRM.

## Prioridad de prospectos

Cada colegio recibe un puntaje de 1 a 100 con los motivos visibles: nunca contactado, en Pipe sin trato, perdido hace más de 4 meses por un motivo reactivable, reseñas en Google (tamaño del colegio), teléfono publicado, ángulo de venta conocido y cantidad de intentos sin respuesta. No aparecen clientes, colegios con trato abierto, los contactados hoy ni los que ya tienen una actividad pendiente. Después de 6 intentos sin respuesta la app sugiere cerrarlo como «No responde más».

## Otras pantallas

- **Prospectar:** mapa y lista por país y ciudad, cruce en lote con Pipedrive, filtros por estado, sesión de llamadas de una ciudad y descarga en CSV.
- **Agenda:** tus actividades pendientes por día, con hecha, reprogramar y abrir ficha.
- **Equipo:** ranking semanal (demos, conversaciones y contactos) y actividad reciente.
- **Asistente (con IA):** «¿a quién llamo ahora?», «agendá una demo con Vallesol el jueves a las 10 para Juan Diego», «armame un guion para San José Obrero», «¿cómo respondo "ya tenemos un sistema"?». Todo lo que escribe en Pipedrive se confirma con un botón.
- **Búsqueda rápida:** Ctrl K o `/`. Atajos 1 a 4 para cambiar de sección y Esc para cerrar.

## Radar: el agente que busca colegios 24/7

`scripts/radar.mjs` corre en GitHub Actions cada 2 horas (`.github/workflows/radar.yml`), también a mano desde Actions → «Radar de colegios» → Run workflow.

1. Arma la lista de ciudades de más de 40.000 habitantes de cada país (México, Perú, Argentina, Chile, Uruguay, Guatemala y Costa Rica) con OpenStreetMap. Las ciudades pegadas a una más grande se revisan dentro de ella.
2. Revisa primero las ciudades nunca escaneadas, de la más grande a la más chica, y después vuelve a cada una cada 30 días.
3. Por ciudad busca colegios, institutos, preparatorias y universidades, descarta los públicos (escuelas numeradas, federales, estatales, CONALEP, I.E. N°, liceos públicos, etc.) y se queda con los privados.
4. No duplica: si el colegio ya está en la base, solo completa teléfono, web, email o dirección.
5. Marca oportunidades: bilingüe o internacional, confesional (redes de colegios), universidad (OrderGO) y privado confirmado. Eso sube su prioridad en «A quién llamar».
6. Opcional, con secretos del repo (Settings → Secrets and variables → Actions):
   - `GOOGLE_MAPS_API_KEY`: rating, teléfono, web y fotos de Google de cada colegio nuevo.
   - `ANTHROPIC_API_KEY`: encaje con OrderEAT (alto, medio, bajo) y ángulo de venta de cada colegio nuevo.
7. Guarda `data/schools.json` y `data/radar/state.json` con un commit en `main`; Vercel publica la base nueva sola.

En la app, la sección **Radar** muestra la cobertura por país, las corridas y las mejores oportunidades nuevas, con un botón para hacer una sesión de llamadas con ellas.

## Buscador de zonas

Para no esperar al radar, cualquiera puede buscar colegios en una zona puntual:

- **Prospectar**: escribí una ciudad, barrio o dirección y apretá Enter. La marca en el mapa con un círculo y lista los colegios cercanos por distancia. «Buscar más» trae los que falten en esa zona.
- **Ctrl K** (o la lupa) → «Buscar colegios en una zona…»: sirve para un país o provincia entera («España», «Provincia de Córdoba»). Arma la lista de ciudades de más de 40.000 habitantes y las recorre en segundo plano, con un indicador de avance que se puede cancelar.
- **Asistente**: «Prospectá colegios en España» propone la búsqueda y arranca con un botón.

Usa la misma lógica que el radar (`lib/scan.js`: Nominatim para ubicar, Overpass para buscar, mismos filtros de privados y deduplicado). Endpoints: `POST /api/scan/resolve`, `/api/scan/cities`, `/api/scan/city`. Los colegios nuevos quedan en Redis (`schools:extra`) y los ve todo el equipo; sin Redis viven en memoria hasta que reinicia el servidor, y el radar los vuelve a encontrar en su próxima pasada.

Variables: `RADAR_MIN_POP` (40000), `RADAR_RESCAN_DAYS` (30), `RADAR_MINUTES` (20), `RADAR_PLACES_MAX`, `RADAR_WEB_MAX`, `RADAR_AI_MAX`.

## Fotos de cada colegio

La ficha muestra una galería sin salir de la app: fotos de Google Maps (si el servidor tiene `GOOGLE_MAPS_API_KEY`), la imagen de portada de la web del colegio y siempre una vista satelital del predio (sirve para estimar el tamaño). Se toca una foto para verla grande.

## Probarlo sin tocar Pipedrive

```bash
npm install
```

```bash
npm run demo
```

Abrí http://localhost:3000 y entrá con «Entrar en modo desarrollo». Usa un Pipedrive de prueba en memoria: nada se guarda en la cuenta real.

## Correrlo con la cuenta real

Necesitás Node 20 o más nuevo.

```bash
cp .env.example .env
```

```bash
npm run dev
```

Para probar sin configurar Google, poné `DEV_LOGIN_EMAIL=tu-email@ordereat.com` en `.env`: aparece el botón «Entrar en modo desarrollo». Ese botón no existe en producción.

## Variables de entorno

| Variable | Qué es | Dónde se saca |
|---|---|---|
| `PIPEDRIVE_API_TOKEN` | Token de API de un usuario admin | Pipedrive → foto de perfil → Configuración personal → API |
| `PIPEDRIVE_DOMAIN` | Subdominio (`ordereat`) | La URL de Pipedrive |
| `ANTHROPIC_API_KEY` | Clave para el asistente, los briefs, los mensajes y el ordenado de notas | console.anthropic.com → API Keys |
| `ANTHROPIC_MODEL` | Modelo de Claude (por defecto `claude-sonnet-5-5`) | |
| `GOOGLE_CLIENT_ID` | ID de cliente OAuth tipo «Aplicación web» | Google Cloud Console → APIs y servicios → Credenciales. Agregar como orígenes autorizados `http://localhost:3000` y la URL de producción |
| `ALLOWED_EMAIL_DOMAIN` | Dominio permitido para entrar (ej. `ordereat.com`) | |
| `SESSION_SECRET` | Texto largo y aleatorio | `openssl rand -hex 32` |
| `DAILY_GOAL` | Meta diaria de contactos por SDR (por defecto 40) | |
| `DATA_DIR` | Carpeta para el cruce con Pipe y el registro de contactos (si no hay Redis) | Un disco persistente en producción |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | Redis de Upstash para guardar cruce y contactos | Vercel → Storage → Upstash for Redis (se cargan solas) |
| `SALES_PIPELINES` | Opcional: embudo y etapa de entrada por país en JSON | Ver `.env.example` |

Los IDs de embudos, etapas y campos personalizados de la cuenta de OrderEAT están en `lib/config.js`. Si cambian en Pipedrive, se actualizan ahí (o con `SALES_PIPELINES` y `DEAL_FIELDS`).

Sin `ANTHROPIC_API_KEY` todo funciona igual con el playbook fijo: lo único que se apaga es el asistente, el brief con IA, la mejora de mensajes y el ordenado de notas.

Las actividades se asignan al usuario de Pipedrive cuyo email coincide con el de Google. Si alguien entra con un email que no está en Pipedrive, la app se lo avisa.

## Publicarlo en Vercel

1. En Vercel: Add New → Project → importá `orderbrain-sdr`. No hace falta tocar nada del build: `vercel.json` ya dice que los archivos de `public/` se sirven directo y que `/api` y `/auth` corren en la función `api/index.js`.
2. **Base de datos (recomendado):** en el proyecto, Storage → Create Database → **Upstash for Redis** (plan gratis) → Connect. Vercel carga solo `KV_REST_API_URL` y `KV_REST_API_TOKEN`. Ahí se guardan la meta diaria, el ranking, la cadencia y el cruce con Pipedrive. Sin esto la app anda igual, pero esos datos se reinician cada tanto.
3. En Settings → Environment Variables cargá `PIPEDRIVE_API_TOKEN`, `PIPEDRIVE_DOMAIN`, `GOOGLE_CLIENT_ID`, `ALLOWED_EMAIL_DOMAIN`, `SESSION_SECRET` y, si querés IA, `ANTHROPIC_API_KEY`. Después, Deployments → Redeploy.
4. Agregá la URL de Vercel (por ejemplo `https://orderbrain-sdr.vercel.app`) como origen autorizado en el cliente OAuth de Google.

Para mirarla sin datos reales: `DEMO_MODE=1`, `DEV_LOGIN_EMAIL=tu-email@ordereat.com` y `SESSION_SECRET`, sin `PIPEDRIVE_API_TOKEN`. Aparece el botón «Entrar en modo desarrollo».

## Publicarlo (DigitalOcean App Platform)

1. En DigitalOcean: Create → App → elegí este repo. Detecta Node solo (`npm start`).
2. Cargá las variables de entorno de la tabla (marcá como secretas las claves) y `NODE_ENV=production`.
3. Para no perder el ranking y la cadencia al reiniciar, montá un volumen y apuntá `DATA_DIR` ahí.
4. Agregá la URL que te da DigitalOcean como origen autorizado en el cliente OAuth de Google.

También funciona en Render o Railway, o con el `Dockerfile` incluido.

## Cómo está armado

```
server.js              Express: login, API y archivos estáticos
api/index.js           Entrada para Vercel (reexporta la app)
lib/config.js          Mercados por país, embudos, campos personalizados y motivos de pérdida
lib/playbook.js        Resultados de contacto, cadencia, guion, objeciones, plantillas y prioridad
lib/pipedrive.js       Cliente de la API de Pipedrive (v1 y v2) y cruce colegio ↔ organización
lib/pipedrive-demo.js  Pipedrive de prueba en memoria (DEMO_MODE=1)
lib/sales.js           Ficha, registro de contactos, cola de prioridad, agenda y métricas
lib/ai.js              Claude: notas, brief de llamada, mensajes y asistente con herramientas
lib/store.js           Colegios, cache del cruce y registro de contactos (Redis o DATA_DIR)
lib/time.js            Zonas horarias y días hábiles
lib/photos.js          Fotos de cada colegio (Google, web y satélite)
lib/scan.js            Búsqueda en OpenStreetMap compartida por el radar y el buscador de zonas
scripts/radar.mjs      Radar: busca colegios privados en todas las ciudades (GitHub Actions)
public/                Frontend sin build: HTML, CSS y módulos JS (mapa con Leaflet)
```

Pipedrive es la fuente de verdad. El cruce colegio ↔ organización dura 7 días y se recalcula solo. El registro local de contactos (`touches.json`) alimenta la cadencia, la meta diaria y el ranking.

## Agregar colegios

Sumá objetos a `data/schools.json` con `id`, `name`, `city`, `country`, `lat`, `lng` y, si los tenés, `addr`, `phone`, `web`, `rating` (ej. `"4,6 (120)"`), `hours`, `zone`, `pitch`. El `id` tiene que ser único (por ejemplo `ciudad-nombre-del-colegio`).
