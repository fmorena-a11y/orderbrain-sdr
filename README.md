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
| `DATA_DIR` | Carpeta para el cruce con Pipe y el registro de contactos | Un disco persistente en producción |
| `SALES_PIPELINES` | Opcional: embudo y etapa de entrada por país en JSON | Ver `.env.example` |

Los IDs de embudos, etapas y campos personalizados de la cuenta de OrderEAT están en `lib/config.js`. Si cambian en Pipedrive, se actualizan ahí (o con `SALES_PIPELINES` y `DEAL_FIELDS`).

Sin `ANTHROPIC_API_KEY` todo funciona igual con el playbook fijo: lo único que se apaga es el asistente, el brief con IA, la mejora de mensajes y el ordenado de notas.

Las actividades se asignan al usuario de Pipedrive cuyo email coincide con el de Google. Si alguien entra con un email que no está en Pipedrive, la app se lo avisa.

## Publicarlo (DigitalOcean App Platform)

1. En DigitalOcean: Create → App → elegí este repo. Detecta Node solo (`npm start`).
2. Cargá las variables de entorno de la tabla (marcá como secretas las claves) y `NODE_ENV=production`.
3. Para no perder el ranking y la cadencia al reiniciar, montá un volumen y apuntá `DATA_DIR` ahí.
4. Agregá la URL que te da DigitalOcean como origen autorizado en el cliente OAuth de Google.

También funciona en Render o Railway, o con el `Dockerfile` incluido.

## Cómo está armado

```
server.js              Express: login, API y archivos estáticos
lib/config.js          Mercados por país, embudos, campos personalizados y motivos de pérdida
lib/playbook.js        Resultados de contacto, cadencia, guion, objeciones, plantillas y prioridad
lib/pipedrive.js       Cliente de la API de Pipedrive (v1 y v2) y cruce colegio ↔ organización
lib/pipedrive-demo.js  Pipedrive de prueba en memoria (DEMO_MODE=1)
lib/sales.js           Ficha, registro de contactos, cola de prioridad, agenda y métricas
lib/ai.js              Claude: notas, brief de llamada, mensajes y asistente con herramientas
lib/store.js           Colegios, cache del cruce y registro de contactos (DATA_DIR)
lib/time.js            Zonas horarias y días hábiles
public/                Frontend sin build: HTML, CSS y módulos JS (mapa con Leaflet)
```

Pipedrive es la fuente de verdad. El cruce colegio ↔ organización dura 7 días y se recalcula solo. El registro local de contactos (`touches.json`) alimenta la cadencia, la meta diaria y el ranking.

## Agregar colegios

Sumá objetos a `data/schools.json` con `id`, `name`, `city`, `country`, `lat`, `lng` y, si los tenés, `addr`, `phone`, `web`, `rating` (ej. `"4,6 (120)"`), `hours`, `zone`, `pitch`. El `id` tiene que ser único (por ejemplo `ciudad-nombre-del-colegio`).
