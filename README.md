# OrderBrain SDR

La herramienta de prospección del equipo de ventas de OrderEAT. Le dice a cada SDR a quién llamar, qué decir y deja todo guardado en Pipedrive sin cargar nada a mano.

## Cómo es un día con OrderBrain

1. **Hoy.** Al entrar ves tu meta diaria de contactos, tu agenda de Pipedrive (vencidas, hoy, próximos 7 días) y la lista **A quién llamar ahora**, ordenada por prioridad dentro de tu territorio.
2. **Empezar sesión.** Un botón arma la cola del día: primero los compromisos vencidos y de hoy, después los mejores prospectos. Vas colegio por colegio sin volver a la lista. Los clientes se saltean solos.
3. **Preparar.** Cada ficha trae la situación del colegio en Pipe, el objetivo de la llamada, los primeros 15 segundos, las preguntas para calificar, las respuestas a objeciones y el cierre. Todo en el vocabulario del país (cafetería, cantina, casino, soda; tú o vos). Con IA, **Preparar con IA** lee las notas y tratos de Pipe y arma un brief a medida.
4. **Contactar.** Llamar, WhatsApp o Mail desde la ficha. WhatsApp y Gmail se abren con plantillas listas (primer contacto, después de no atender, mandar info, confirmar demo, reactivar) que se pueden mejorar con IA.
5. **Registrar.** Canal, resultado y, según el resultado, decisor, calificación, demo o motivo de pérdida. La app sugiere el próximo paso con criterio de cadencia (por ejemplo: «intento 1 sin respuesta: mandá un WhatsApp hoy»; «pidió info: mail hoy y llamada en 2 días hábiles»).
6. **Guardar en Pipedrive** (Ctrl + Enter) y pasar al siguiente.

## Agenda por fecha, zona o evento

La Agenda filtra por fecha (hoy, vencidas, ayer, próximos 7 días o un rango), por zona o evento y por tipo. Lo filtrado se trabaja como sesión con un toque. El evento sale del título del prospecto, por ejemplo «(EduExperience Mendoza 2026)». La ciudad sale de la base, de los campos del prospecto o de la dirección de la organización. En Hoy, la sesión arranca por lo de hoy, sigue con lo vencido y después con los colegios nuevos. «Trabajar una zona o evento» arma una sesión especial, por ejemplo Puebla.

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
| **Crear prospecto**: institución, persona y prospecto con Ciudad, País, Fuente, SDR, teléfono, email, web, dirección y niveles, más la tarea pendiente | Prospectos |
| Comentario con tarea para más adelante (mini calendario, asignable a otra persona) | Organización o prospecto |

Después de cada contacto la app propone siempre un próximo paso con fecha. Se puede cerrar sin agendar, pero avisa: la idea es que nunca quede un colegio sin algo pendiente.

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

Para no esperar al radar, cualquiera puede buscar colegios en un lugar puntual:

- **Prospectar**: escribí un país, provincia, ciudad, barrio o dirección y tocá la flecha (o Enter si el texto no coincide con ningún colegio). El mapa dibuja el **contorno real** del lugar y la lista muestra solo los colegios de adentro, del más cercano al más lejano. Si el lugar es un punto (una dirección o un barrio sin límite en OpenStreetMap), se usa un círculo chico. Si el nombre es ambiguo («Puebla»), elige la ciudad y ofrece las otras opciones («Puebla, México» el estado).
- **«Buscar más»** trae de OpenStreetMap los colegios privados que falten **dentro del contorno** (un país se recorre ciudad por ciudad).
- **Ctrl K** → «Buscar colegios en una zona…», o el asistente: «Prospectá colegios en España».

Cada colegio nuevo pasa por un control antes de entrar a la base (`lib/enrich.js`):

1. Filtro estricto (`lib/scan.js`): fuera públicos, academias de idiomas, de manejo, de arte o deportes, centros de estudio, apoyo escolar, etc.
2. Web del colegio: teléfono, WhatsApp, mail y foto de portada.
3. Google Places (con `GOOGLE_MAPS_API_KEY`): que figure como escuela y siga abierta; suma teléfono, web y rating.
4. Claude (con `ANTHROPIC_API_KEY`): que sea un colegio y privado; suma encaje y ángulo de venta.

El indicador de abajo muestra el avance (verificados, nuevos y descartados con el motivo) y **Cancelar** corta en el acto: lo que estaba a medio verificar no entra. Endpoints: `POST /api/scan/resolve` (lugar con contorno), `/api/scan/cities`, `/api/scan/city` (candidatos firmados, no guarda) y `/api/scan/verify` (verifica y guarda). Los colegios nuevos quedan en Redis (`schools:extra`) y los ve todo el equipo; sin Redis viven en la memoria de una instancia y la app lo avisa.

## Estados de cada colegio

| Estado | Qué significa | De dónde sale |
|---|---|---|
| Nunca contactado | No figura en Pipedrive | Pipedrive |
| En Pipe sin trato | La organización existe pero nunca tuvo un trato | Pipedrive |
| Contactado sin avance | Se lo contactó y no se llegó a mandar propuesta | Trato perdido antes de PROPOSAL SENT |
| Propuesta enviada | La propuesta está mandada y el trato sigue abierto | Etapa PROPOSAL SENT |
| Perdido | Se mandó la propuesta y no se cerró | Trato perdido en PROPOSAL SENT, CLOSING, HOT DEALS o negociación |
| Onboarding | Se está capacitando al personal y poniéndolo en marcha | World Dominion (o embudo ONBOARDING) |
| Activo | Ya funciona con OrderEAT | World Dominion (o embudos de clientes) |
| Churn | Era cliente y se cayó | World Dominion (o etapa Churn) |

## Clientes de OrderEAT (World Dominion)

Con un token de brain.ordereat.com la app lee los sitios de World Dominion en OrderBrain general (`brain.ordereat.com/api/sites` y `/api/clients`) cada 15 minutos (`lib/brain.js`) y los cruza con la base: mismo Google Place, mismo predio (menos de 60 m) o nombre parecido a menos de 300 m.

- Cada colegio lleva una **fase** con color: Activo (verde), Onboarding (amarillo), Cerrado (azul: firmó y no arrancó), Churn (rojo) y Propuesta enviada (violeta). Manda World Dominion; si no está ahí, sale de Pipedrive (embudo ONBOARDING, embudos de clientes, etapas Churn/DROPPED y la etapa de propuesta de los embudos de venta).
- Los sitios en estado Cerrado, Onboarding o Activo quedan como **Cliente**: salen de «Para llamar», de la cola de llamadas y de las sugerencias del asistente, y la ficha avisa que no hay que prospectarlos. Esto pasa aunque Pipedrive no tenga el trato bien cargado.
- Los sitios en Churn quedan marcados como **ex cliente**: se pueden contactar, pero la ficha pide hablar antes con el equipo de cuentas.
- En el mapa de Prospectar, los clientes aparecen como rombos azules y los ex clientes con borde rojo. El botón «Clientes OrderEAT» los muestra u oculta.

Si el token vence, el botón muestra un aviso y la app sigue con la última copia. En modo demo sin token se marcan unos colegios de prueba.

**Token desde la app.** Un líder pega el token (el JWT de sesión de brain.ordereat.com: está en `localStorage.auth_token` del navegador; Equipo explica cómo copiarlo) en Equipo → World Dominion. El servidor lo prueba contra `/api/sites` antes de guardarlo: si OrderBrain lo rechaza o no devuelve sitios, no se guarda y se dice por qué. Si anda, queda en Redis (`ob:brain:token`; sin Redis, en `DATA_DIR/brain-token.json`), manda sobre `BRAIN_TOKEN` y los sitios se actualizan al instante; las otras instancias lo toman en menos de un minuto, desde la copia compartida. El token nunca vuelve al navegador ni va a los logs: Equipo muestra quién lo cargó y cuándo, cuándo vence (el `exp` del JWT; si no es JWT, «sin fecha de vencimiento»), un aviso si venció o vence en menos de 3 días, cuántos sitios hay, de cuándo son los datos y cómo anduvo la última lectura. Si falta, vence pronto, venció o OrderBrain lo rechazó, los líderes lo ven también en Hoy y Prospectar (con enlace a Equipo) y con un «!» en la pestaña Equipo (`token` en `/api/brain`, solo para líderes y sin el token). Si el cargado desde la app venció y el de `BRAIN_TOKEN` no, se usa el de `BRAIN_TOKEN`. Rutas (solo líderes): `GET` y `POST /api/admin/brain`.

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

## Acceso del equipo

Cada persona entra con su **código personal** (o con Google si está configurado). Los líderes ven los códigos en Equipo → «Accesos del equipo» y los copian como invitación. El código del equipo (`TEAM_ACCESS_CODE`) sirve solo para líderes. Son líderes el dueño del token de Pipedrive y los emails de `LEADER_EMAILS`. La primera vez la app pide nombre completo y rol (SDR o Account Executive; el rol de líder lo decide el servidor). Los intentos fallidos se frenan por IP y por email.

Para probar contra la cuenta real sin escribir nada, usá `READ_ONLY=1`: todas las escrituras a Pipedrive se bloquean.

## Sincronización con Pipedrive

Equipo → «Sincronizar con Pipedrive» (solo líderes) cruza toda la base de una vez, con las mismas reglas que la ficha (`lib/sync.js`): lee todas las organizaciones y todos los tratos de a páginas de 500, los guarda compactos en Redis y al final elige la organización de cada colegio. Cada pedido trabaja ~40 s y el navegador lo repite hasta terminar; se puede pausar y seguir (si cerrás la pestaña queda en pausa; con `CRON_SECRET` la sigue el cron). Si la está siguiendo otra pestaña, otro líder o el cron, Equipo lo dice y no ofrece «Seguir». No pisa los cruces elegidos a mano, lo que guardó la app en la última hora (también si otra instancia lo guarda mientras cruza: relee cada tanda antes de escribir) ni el «no es esta organización». Solo lee de Pipedrive, así que funciona con `READ_ONLY=1`.

Cómo se elige la organización (`lib/pipedrive.js`, igual en la ficha y en la masiva):
- Puntaje: qué parte de las palabras del colegio tiene la organización. Las palabras que comparten muchísimos colegios (centro, educativo, infantil, san, santa, maría, josé…) valen 0.35; solas no alcanzan. +0.15 si la organización nombra la ciudad (sin «San», «Ciudad»…: «Puebla» por «Puebla de Zaragoza»).
- Desde 0.67 se elige, salvo que la organización nombre otro lugar de la base («…Obrero Piura» para el de Lima), tenga otro número («Fe y Alegría 08» para el 13), tenga tantas palabras propias de más como las que comparte, o encaje igual con colegios de otras ciudades (o con 4 o más): ahí queda como candidata en la ficha, sin elegirse sola.
- Se confirma sola (`auto`) desde 0.95 solo si ninguna otra llega a 0.95 y el colegio tiene dos palabras o más y alguna no es común. Lo confirmado solo se recalcula; lo elegido a mano, no.
- Equipo muestra qué cambió de verdad en cada pasada (estado, organización o fase), no las reescrituras de mantenimiento.
- Un trabajo trabado se puede descartar con «Rehacer desde cero». Si la foto de Pipedrive quedó vacía, o un paso falla 3 veces seguidas, el trabajo se cierra solo y la próxima vuelve a empezar (completa, si la foto no servía).
- Cada instancia lee los cruces de Redis enteros (de a 1000) al arrancar y cada 30 min; en el medio, solo los cambiados (`match:at`).

Con `CRON_SECRET` en Vercel, el cron diario (`vercel.json`, 08:17 UTC) sigue una sincronización a medias o trae solo lo cambiado desde la última. Sin `CRON_SECRET`, `/api/cron/sync` no existe.

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
| `TEAM_ACCESS_CODE` | Código de entrada para líderes | Texto que elijas; rotarlo si se compartió |
| `LEADER_EMAILS` | Emails de líderes separados por coma | |
| `BRAIN_TOKEN` | Token de World Dominion (brain.ordereat.com) para saber clientes activos, onboarding y churn. Opcional si un líder lo carga en Equipo (ese manda) | |
| `GOOGLE_MAPS_API_KEY` | Fotos, teléfono, horario y reseñas de Google Maps (Places API New), con tope de gasto | Google Cloud → APIs y servicios |
| `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_ID` | Mensajes del canal de colegios lanzados en «Qué pasó con OrderEAT» (scopes `channels:history` y `users:read`; el bot tiene que estar en el canal) | api.slack.com/apps |
| `FREE_OWNER_IDS` | Cuentas generales de Pipedrive cuyos colegios están libres (por defecto «OrderEAT» y «Contacto OrderEAT») | |
| `READ_ONLY` | `1` bloquea las escrituras a Pipedrive (para probar) | |
| `CRON_SECRET` | Activa el cron diario de sincronización con Pipedrive (Vercel lo manda como `Authorization: Bearer …`) | `openssl rand -hex 32` |
| `SYNC_STEP_SECONDS`, `SYNC_CRON_SECONDS` | Opcional: segundos por paso de sincronización desde Equipo (40) y desde el cron (50), hasta 280 | |
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
lib/brain.js           Sitios de World Dominion (OrderBrain) para marcar clientes
lib/scan.js            Búsqueda en OpenStreetMap compartida por el radar y el buscador de zonas
scripts/radar.mjs      Radar: busca colegios privados en todas las ciudades (GitHub Actions)
public/                Frontend sin build: HTML, CSS y módulos JS (mapa con Leaflet)
```

Pipedrive es la fuente de verdad. El cruce colegio ↔ organización dura 7 días y se recalcula solo. El registro local de contactos (`touches.json`) alimenta la cadencia, la meta diaria y el ranking.

## Agregar colegios

Sumá objetos a `data/schools.json` con `id`, `name`, `city`, `country`, `lat`, `lng` y, si los tenés, `addr`, `phone`, `web`, `rating` (ej. `"4,6 (120)"`), `hours`, `zone`, `pitch`. El `id` tiene que ser único (por ejemplo `ciudad-nombre-del-colegio`).
