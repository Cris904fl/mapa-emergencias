# HANDOFF — Mapa inteligente de afectaciones

Estado del repositorio en el commit **`e6bc92f`** (rama `main`, sincronizada con
`origin/main`). Documento escrito inspeccionando el código y la base de datos en
ejecución, no de memoria.

> **El sistema está desplegado y en uso.** Desde el 13 de agosto de 2026 hay una
> beta pública recibiendo reportes de personas reales. Las direcciones y el
> estado del despliegue están en la §14; lo que dice este documento sobre
> «pendiente» o «sin verificar» se refiere a esa instalación, no a un entorno
> hipotético.

Convención de este documento:

- **✅ implementado** — escrito, ejecutado y verificado.
- **🟡 parcial** — escrito y compila, pero sin verificación de punta a punta.
- **⬜ pendiente** — no existe.
- **⚠️ incierto** — se indica explícitamente lo que no se comprobó.

---

## 1. CONTEXTO DEL PROYECTO

**Qué es.** Sistema de reporte y priorización de emergencias para Colombia. Un
ciudadano reporta una afectación desde el celular (funciona sin señal), PostGIS
responde las preguntas geoespaciales, un índice de prioridad auditable ordena la
cola de atención de una sala de crisis, y un rescatista atiende el caso desde su
teléfono.

**Problema que resuelve.** En una emergencia los reportes llegan desordenados
—texto libre, por radio, por WhatsApp— y nadie puede decidir a dónde mandar los
equipos primero. Además la red es lo primero que se cae, así que cualquier
sistema que asuma conectividad pierde pedidos de auxilio.

**Objetivo del MVP.** Cerrar el ciclo completo: reporte ciudadano → priorización
explicable → triage humano → atención en campo → cierre, con trazabilidad de
quién hizo qué.

**Usuarios objetivo (tres, con pantallas distintas):**

| Vista | Usuario | Necesita cuenta |
|---|---|---|
| **Reportar** | ciudadano afectado | no |
| **Atender** | rescatista en campo | sí |
| **Tablero** | operador de sala de crisis | solo para actuar; consultar es abierto |

**Alcance actual.** Un despliegue de un solo evento, **público y en uso** desde
el 13 de agosto de 2026. No hay multi-tenancy, ni federación entre entidades, ni
geografía de DIVIPOLA (la tabla `lugares` está vacía en producción). Sí hay
3 388 recursos de emergencia de todo el país.

---

## 2. ESTADO ACTUAL

### ✅ Completamente implementado y verificado

| Pieza | Verificación |
|---|---|
| Esquema PostGIS: 10 tablas de dominio, 11 ENUM, 4 vistas, 12 triggers | 11 migraciones, aplicadas en local (PostGIS 3.5.2) y en Supabase (3.3.7) |
| Índice de prioridad con pesos versionados y desglose explicable | 11 pruebas · **los 5 términos activos en producción** |
| API Fastify: 36 endpoints | 76 pruebas |
| **Despliegue completo en producción** | Cloudflare Workers + Render + Supabase, verificado de punta a punta (§14) |
| **Consulta de un caso por su código público** | verificada contra reportes reales |
| **Notificaciones push a quien reportó** | recibida en un dispositivo real |
| **Medios en Supabase Storage** | subida y descarga con SHA-256 idéntico |
| **3 388 recursos de emergencia de todo Colombia** | cargados desde OpenStreetMap |
| Cron: despierta la API y refresca prioridades cada 10 min | observado refrescando solo |
| PWA offline-first (IndexedDB + service worker + reintentos) | ciclo completo verificado en navegador |
| Tablero GIS: MapLibre, DBSCAN, zonas, cola, filtros por KPI | verificado en navegador |
| Atención en campo: tomar / llegar / cerrar, candado de concurrencia | 17 pruebas + navegador |
| Ruta al caso con detección de vías bloqueadas sobre el trayecto | verificado con OSRM real |
| Extracción de texto libre con Ollama local | medida y calibrada en 3 iteraciones |
| Autenticación JWT + scrypt, roles | verificado |
| Corredor de migraciones con verificación de hash | verificado, idempotente |
| Proceso de trabajadores (BullMQ) arranca; refresco periódico de prioridad | verificado (`refrescados: 10`) |

### 🟡 Parcialmente implementado

- **Extracción por IA vía la cola BullMQ.** El proceso de trabajadores arranca y
  el refresco de prioridades funciona. ⚠️ **Nunca se observó al trabajador
  `triage-ia` procesando un trabajo real**; la extracción se verificó solo por el
  endpoint sincrónico `POST /v1/reportes/:id/triage-ia`.
- **Etiquetado multimodal de fotos** (`servicios/ia/imagen.ts`). Escrito y
  tipado, nunca ejecutado: `qwen2.5:7b` no es multimodal. Requiere `ollama pull
  gemma3:4b` o similar y un `IA_MODELO` con visión.
- **Proveedor `compatible`** (Groq / OpenRouter / vLLM). Escrito, nunca ejecutado
  contra un servicio real; no se midió su calidad con este prompt.
- **Proveedor `anthropic`.** Escrito y tipado contra el SDK instalado; nunca
  ejecutado (no hubo clave).
- **Background Sync del service worker.** El código existe. Se verificó la
  sincronización al recargar la página; ⚠️ **no se verificó el caso de pestaña
  cerrada**, que es el único que Background Sync aporta de más.

### ⬜ Pendiente

- **Geografía de `lugares`: vacía en producción.** No se sembró a propósito (los
  datos de desarrollo son dos barrios de Bogotá y aparecerían como reales), pero
  eso deja **el panel de «Zonas» del tablero sin nada** y ningún reporte resuelve
  su zona por contención espacial. Es el hueco más visible del despliegue.
- Proveedor propio de teselas (hoy: OpenStreetMap, cuya política **no permite
  producción**). Menos urgente de lo que parece: desde que el bundle está
  partido, **el ciudadano no carga el mapa** — las teselas solo las pide el
  tablero y la vista de campo.
- Término propio en el índice para las asignaciones estancadas. Hoy hay alerta
  (mosaico «asignados sin llegada»), pero el reporte sigue sin volver a subir en
  la cola: eso exige repartir de nuevo los cinco pesos y volver a medir.
- Modo sin Redis para despliegue gratuito: la ruta
  `POST /v1/mantenimiento/refrescar-prioridades` existe, pero la extracción por IA
  en ese modo queda solo a demanda.

### Qué funciona ahora mismo

**En producción, con gente real.** Alguien abre la dirección desde su celular,
reporta (con o sin red), recibe un código y puede pedir que le avisen cuando su
caso avance. El reporte entra a la cola ordenado por los cinco términos del
índice, con su desglose. Un operador filtra por KPI y por severidad, toca un
reporte y el mapa vuela hasta el sitio. Un rescatista entra, ve los casos cerca,
calcula la ruta con las vías bloqueadas, toma el caso, marca que llegó y lo
cierra con nota — y a quien reportó le llega una notificación en cada paso. Todo
queda en la bitácora con actor.

### Bugs conocidos

Ninguno abierto y reproducible. Durante el despliegue aparecieron **seis
defectos**, todos corregidos y con prueba de regresión donde aplicaba (§9). El
más grave: el primer reporte real habría tumbado el servicio.

---

## 3. STACK

| Capa | Tecnología | Versión instalada |
|---|---|---|
| Runtime | Node.js | **24.18.0** (mínimo real 22.18: antes de esa versión el borrado de tipos no viene activado por defecto) |
| Lenguaje | TypeScript | 5.9.3 |
| API | Fastify | 5.11.3 |
| Validación | Zod | 3.25.76 |
| Zod → JSON Schema | zod-to-json-schema | 3.25.2 |
| Driver BD | pg | 8.23.0 |
| Colas | BullMQ + ioredis | 5.81.3 / 5.11.1 |
| SDK IA | @anthropic-ai/sdk | 0.70.1 |
| Front | React | 19.2.8 |
| Mapa | maplibre-gl | 5.24.0 |
| IndexedDB | idb | 8.0.3 |
| Build front | Vite | 7.3.6 |
| Base de datos | PostgreSQL + PostGIS | imagen `postgis/postgis:17-3.5`, PostGIS **3.5.2** |
| Caché/colas | Redis | `redis:7-alpine` |
| npm | | 11.16.0 |

**Plugins Fastify:** `@fastify/cors` 11.3.0, `@fastify/jwt` 10.2.1,
`@fastify/multipart` 9.4.0, `@fastify/rate-limit` 10.3.0.

**Servicios externos:**

- **Ollama** local (`http://localhost:11434`), modelo `qwen2.5:latest` (7B,
  Q4_K_M, 4.36 GB). Instalado: Ollama 0.32.9.
- **OSRM** servidor de demostración público (`https://router.project-osrm.org`)
  para ruteo. Sin clave. **Su política no permite producción.**
- **OpenStreetMap** teselas raster para el mapa. **Su política no permite
  producción.**

**Hardware de la máquina de desarrollo** (condiciona el trabajo con IA local):
Intel i7-10510U, 4 núcleos, **sin GPU dedicada** (Intel UHD, 1 GB), 23.8 GB RAM.
Inferencia por CPU: ~48 s por reporte con caché de prefijo tibia, 178 s en frío.

**Puertos** (elegidos para no chocar con otros proyectos de la máquina):

| Servicio | Host | Motivo |
|---|---|---|
| PostgreSQL | **5434** | 5432, 5433 (`aduanas_postgres`) y 5435 (`ocr_db`) están ocupados |
| Redis | **6381** | 6380 lo usa `ocr_redis` |
| API | 3010 | |
| PWA (Vite) | 5180 | |

### Variables de entorno

Todas se validan con Zod al arrancar; si falta algo esencial el proceso muere con
un mensaje claro. Definición: `apps/api/src/config.ts`. Plantilla:
`.env.example`. **`.env` no se versiona; `.env.pruebas` sí** (solo valores
locales).

| Variable | Por defecto | Notas |
|---|---|---|
| `NODE_ENV` | `development` | |
| `DATABASE_URL` | — | **obligatoria** |
| `REDIS_URL` | `redis://localhost:6381` | |
| `API_PUERTO` / `API_HOST` | 3010 / 0.0.0.0 | |
| `LOG_NIVEL` | `info` | |
| `JWT_SECRETO` | — | **obligatoria**, mínimo 16 caracteres |
| `ALMACEN_MEDIOS` | `./almacen` | directorio de fotos/audio |
| `SECRETO_MANTENIMIENTO` | — | opcional, mínimo 16; sin él la ruta de mantenimiento responde 400 |
| `IA_PROVEEDOR` | `ninguno` | `ninguno` / `ollama` / `compatible` / `anthropic` |
| `IA_MODELO` | `qwen2.5:latest` | |
| `IA_MAX_TOKENS` | 600 | |
| `IA_TIEMPO_LIMITE_MS` | 180000 | alto porque un 7B en CPU tarda ~48 s |
| `IA_APLICAR_AUTOMATICAMENTE` | `false` | **dejar en false con modelos locales** (§8) |
| `OLLAMA_URL` | `http://localhost:11434` | |
| `IA_URL_COMPATIBLE` | `https://api.groq.com/openai/v1` | |
| `IA_CLAVE_COMPATIBLE` | — | opcional |
| `ANTHROPIC_API_KEY` | — | opcional |
| `IA_IMAGEN_LADO_MAX` | 1568 | px del lado largo al reducir fotos en el cliente |
| `RUTEO_URL` | `https://router.project-osrm.org` | vacío = línea recta |
| `RUTEO_RADIO_OBSTACULO_M` | 60 | radio para considerar un reporte obstáculo de la ruta |

Front (Vite): `VITE_API_URL` (solo para el proxy de desarrollo).

---

## 4. ARQUITECTURA

```
Ciudadano (celular, sin red)
   │  escribe en IndexedDB ANTES de intentar enviar
   ▼
PWA React  ──4 capas de reintento──▶  API Fastify  ──▶  PostgreSQL + PostGIS
   │                                      │                    │
   │ service worker                       │ BullMQ/Redis        │ fn_prioridad_reporte()
   │ (armazón + Background Sync)          ▼                     │ triggers, vistas
   │                                 Trabajadores               │
   │                                 · triage-ia (Ollama)       │
   │                                 · etiquetado imágenes      │
   │                                 · refresco de prioridad ───┘
   ▼
Tablero GIS (operador)          Campo (rescatista)
                                   └─ OSRM (ruta) + PostGIS (obstáculos)
```

### Estructura de carpetas

```
db/
  migrations/   001_extensiones · 002_tipos · 003_tablas · 004_indices
                005_prioridad · 006_triggers · 007_campo · 008_llegada
                009_recursos_nombre_unico · 010_notificaciones · 011_recursos_fuente
  seeds/        001_desarrollo.sql        (UUID fijos, idempotente; NO se corre en producción)
  queries/      consultas-ejemplo.sql    (8 consultas PostGIS ejecutables)
                tiempos-de-llegada.sql   (calibración del umbral de estancados)
  recursos-colombia.json                 (3 374 recursos de OSM, cargados)
  recursos.ejemplo.json                  (plantilla para agregar a mano)
apps/api/src/
  config.ts             configuración validada con Zod
  app.ts                construcción de Fastify, plugins, manejo de errores
  servidor.ts           arranque y apagado ordenado
  db/                   pool, migrar, sembrar, hash-clave (crea operadores)
  esquemas/             dominio.ts (ENUM espejo) · reporte.ts (entrada) · filtros.ts (KPI)
  lib/                  auth (scrypt) · errores · validar
  repositorios/         reportes.ts (SQL + GeoJSON)
  rutas/                reportes · recursos · tablero · campo · sesion · salud · notificaciones
  servicios/            prioridad · triage · ruteo · almacen · notificaciones · ia/{…}
  trabajadores/         colas.ts (BullMQ) · index.ts (proceso aparte)
apps/api/test/          ayudas.ts + 4 archivos de prueba (76 pruebas)
apps/web/src/
  lib/                  bd.ts (IndexedDB) · bandeja.ts · api.ts · geo.ts · imagen.ts
                        frescura.ts (umbrales compartidos) · notificaciones.ts (push)
  paginas/              Reportar.tsx · Campo.tsx · Tablero.tsx
  componentes/          Mapa.tsx · Acceso.tsx · ConsultarCaso.tsx
  App.tsx, main.tsx, estilos.css
apps/web/public/        sw.js (armazón + Background Sync + push) · manifest · icono
worker/index.js         Worker de Cloudflare: sirve la PWA, reenvía /v1, cron
wrangler.jsonc          configuración del Worker (assets, vars, triggers)
docs/                   prioridad · offline · ia-local · campo · despliegue-gratuito
                        HANDOFF · presentacion/index.html (página para compartir)
scripts/                esperar-bd · cargar-recursos · probar-conexion
                        fijar-clave-bd · probar-notificacion
```

### Backend

TypeScript **se ejecuta directo con Node** (borrado de tipos), sin paso de
compilación. `tsc` solo revisa tipos (`--noEmit`) con
**`erasableSyntaxOnly: true`** activado. Consecuencias obligatorias:

- Las importaciones llevan **extensión `.ts` explícita**.
- **Prohibido**: enums, namespaces con valor, propiedades de parámetro en
  constructores (`constructor(readonly x: T)`). `tsc` avisa; si no, el proceso
  falla al arrancar.

### Frontend

React 19 + Vite. Router propio por query param (`?vista=reportar|campo|tablero`),
sin librería de rutas. Las importaciones también llevan extensión explícita.

### API

Validación **manual con Zod** en cada handler (`lib/validar.ts`), no con el
proveedor de tipos de Fastify: se evitó acoplar el proyecto a la compatibilidad
entre versiones de ese plugin y de Zod.

### Base de datos

Todas las columnas espaciales son `geography(...,4326)`, no `geometry`: las
consultas son distancias reales en metros y así no hay que reproyectar por
región. Donde una función solo existe para `geometry` se hace `geom::geometry`
explícito.

### Autenticación

JWT (`@fastify/jwt`, 12 h) + **scrypt de `node:crypto`** para contraseñas (sin
dependencias nativas). Autenticación **opcional en todas las rutas**: un hook
`onRequest` resuelve la sesión si viene un token válido y sigue si no. Las rutas
que exigen personal operativo lo verifican con `puedeOperar()`. Un token vencido
no aborta la petición — un ciudadano con sesión caducada tiene que poder reportar.

`/v1/campo/*` tiene un hook propio que exige `puedeOperar` para toda la sección.

Roles: `CIUDADANO` / `OPERADOR` / `RESPONDIENTE` / `ADMIN`. Operativos son los
tres últimos. **No hay registro público**: las cuentas se crean con
`npm run clave`.

### IA

Tres proveedores detrás de una interfaz común (`servicios/ia/proveedores.ts`),
seleccionados por `IA_PROVEEDOR`. El esquema Zod es la única fuente de verdad de
la forma de salida; cada adaptador lo traduce (`zodToJsonSchema` para
Ollama/compatible, `betaZodOutputFormat` para Anthropic) y **los tres validan el
resultado con `esquema.parse()`** — la decodificación restringida garantiza JSON
bien formado, no valores con sentido.

### Almacenamiento

Dos implementaciones detrás de una misma interfaz (`servicios/almacen.ts`),
elegidas **por presencia de credenciales** y no por una bandera de modo: una
variable que diga «usar Supabase» sin las claves puestas sería una forma de
fallar en producción y no en desarrollo, que es la peor.

- **Disco** (`ALMACEN_MEDIOS`) — en desarrollo y en servidores con disco propio.
- **Supabase Storage** — lo que corre en producción. Hace falta en cualquier
  hospedaje con disco efímero: en la capa gratuita de Render el sistema de
  archivos se borra en cada redespliegue **y cada vez que la instancia hiberna**,
  así que las fotos se perdían solas y **en silencio** (la subida respondía 201).

La llave es la misma en ambos: `medios_reporte.llave_almacen` siempre fue una
llave derivada del SHA-256, repartida en subdirectorios por sus dos primeros
bytes, no una ruta de archivo. Por eso migrar no tocó el esquema.

`/listo` informa cuál está activo y avisa cuando el disco es efímero.

### Flujo de datos del reporte

1. La PWA escribe en IndexedDB (`bandeja`) **antes** de intentar enviar.
2. `POST /v1/reportes` o `/v1/reportes/sincronizar` (lote de hasta 100).
   Idempotente por `id_cliente` (UUID del cliente).
3. Triggers: código público legible, resolución de zona por contención espacial.
4. `fn_refrescar_prioridad` calcula el puntaje de una vez.
5. Si hay descripción, se encola `triage-ia`.
6. Las fotos se suben aparte, después del texto.

---

## 5. BASE DE DATOS

### Extensiones

`postgis 3.5.2`, `pgcrypto 1.3` (gen_random_uuid), `pg_trgm 1.6` (similitud),
`citext 1.6` (correos), `unaccent 1.1`, `plpgsql`.

### Tablas (10 de dominio + control)

| Tabla | Propósito | Notas clave |
|---|---|---|
| `organizaciones` | entidades que atienden | nombre único (lower) |
| `usuarios` | personal y ciudadanos | `hash_clave` NULL para ciudadanos; `ultima_posicion` + `posicion_en` (007) |
| `lugares` | geografía administrativa | jerárquica (`padre_id`), `geom` MultiPolygon, `centroide` GENERATED. **Vacía en producción** |
| `recursos` | capacidad con ubicación | `movil` para ambulancias/equipos; `fuente` + `fuente_id` para reconciliar importaciones (011) |
| `suscripciones_push` | avisos a quien reportó | atada al **reporte**, no a un usuario: el ciudadano no tiene cuenta (010) |
| `reportes` | **tabla central**, 35 columnas | ver abajo |
| `medios_reporte` | fotos/video/audio | `sha256` con CHECK de formato, único por reporte |
| `extracciones_ia` | propuestas del modelo | se guarda **siempre**, aplicada o no |
| `historial_estado_reporte` | bitácora | la llena un trigger, no la aplicación |
| `pesos_prioridad` | la fórmula, versionada | CHECK: los 5 pesos suman 100; único parcial: una sola activa |
| `migraciones_aplicadas` | control del corredor | nombre + sha256 |

### `reportes` — columnas importantes

- `codigo_publico` — «RPT-7F3K2», alfabeto sin 0/O ni 1/I/L (se dicta por radio).
- `id_cliente` UNIQUE — **clave de idempotencia** generada en el dispositivo. Es
  la pieza que hace posible el modo sin conexión.
- `origen_triage` (`CIUDADANO`/`IA`/`OPERADOR`) — trazabilidad de quién puso los
  números que ordenan la cola.
- `reportado_en` vs `creado_en` — momento del hecho según el cliente vs recepción
  en el servidor. Con sincronización diferida pueden separarse horas.
- `personas_{afectadas,atrapadas,heridas,fallecidas,vulnerables}`,
  `requiere_rescate`.
- `prioridad_{score,componentes,version,calculada_en}` — puntaje materializado y
  su desglose.
- `responsable_id` + `tomado_en` (007) — **quién** tomó el caso en campo, distinto
  de `organizacion_asignada_id`.
- `llegada_en` + `llegada_origen` (008) — cuándo llegó el equipo al sitio y **cómo
  se supo**: `MARCADA` la selló el trigger al pasar a `EN_ATENCION` (es una
  medición), `DECLARADA` la escribió el rescatista al cerrar (es un recuerdo).
  `NULL` significa **no se sabe**, que es distinto de cero. Es la misma decisión
  que ya tomó `origen_triage`: un número que se va a usar para decidir tiene que
  decir de dónde salió.
- CHECKs: conteos no negativos, `DUPLICADO` exige `duplicado_de_id`, `RESUELTO`
  exige `resuelto_en`, `responsable_id` exige `tomado_en`, la llegada va completa
  (hora y procedencia) y nunca antes de `primera_respuesta_en`.

### Índices (39 en total)

Espaciales GiST: `reportes.geom`, `recursos.geom`, `lugares.geom`,
`lugares.centroide`, `medios.geom`, `usuarios.ultima_posicion`.

**Parciales, los que hacen viable la aplicación:**

- `reportes_abiertos_geom_gix` — GiST solo sobre lo no cerrado. Sirve a la
  consulta más frecuente del tablero.
- `recursos_disponibles_geom_gix` — GiST solo sobre `DISPONIBLE`. Lo usa el KNN
  (`<->`) del término de aislamiento.
- `reportes_cola_ix` — `(prioridad_score DESC, reportado_en)` sobre lo abierto.
- `reportes_prioridad_vencida_ix` — para el refresco periódico.

Trigramas GIN: `reportes.descripcion`, `lugares.nombre` (vía `fn_sin_acentos`,
envoltorio IMMUTABLE de `unaccent` — `unaccent` es STABLE y Postgres no la acepta
en un índice).

### Vistas

`v_cola_prioridad_vivo` (recalcula al consultar), `v_resumen_por_lugar`,
`v_cobertura_reportes`, `v_casos_campo` (007).

### Funciones

`fn_prioridad_reporte(uuid)` → jsonb con puntaje + desglose;
`fn_refrescar_prioridad(uuid)`; `fn_refrescar_prioridades_vencidas(interval, int)`;
`fn_generar_codigo_publico()`; `fn_sin_acentos(text)`.

### Triggers (12)

`actualizado_en` en 5 tablas. En `reportes`: `antes_insertar` (código público +
zona), `reubicar` (recalcula zona al mover), `marcas_atencion`
(`primera_respuesta_en`, `resuelto_en`), `marca_tomado`, `bitacora_insertar`,
`bitacora_cambio`, y **`proteger_triage`** — impide que un proceso automático
sobreescriba un reporte con `origen_triage = 'OPERADOR'`.

El actor de la bitácora sale de `current_setting('app.usuario_id')`, que la API
fija con `SET LOCAL` por transacción (`enTransaccion(..., { usuarioId })`).

### Decisiones de base de datos

- **ENUM y no tablas de catálogo**: son valores del dominio de los que depende la
  lógica de priorización; agregar es `ALTER TYPE`, quitar exige migración (y
  borrar una categoría con historial no debe ser fácil).
- **Los agregados se castean a `int` en SQL** (`count(*)::int`): sin el cast el
  driver los entrega como texto (bigint no cabe en un `number`). El único bigint
  que se deja como texto es `medios_reporte.bytes`.
- **La prioridad no puede ser columna GENERATED**: dos de sus cinco términos
  cambian sin que el reporte se modifique.

---

## 6. API

36 endpoints. **Auth**: `—` abierto · `OP` exige `puedeOperar` (OPERADOR /
RESPONDIENTE / ADMIN) · `TOK` requiere token válido · `SEC` secreto compartido.

### Salud

| Método | Ruta | Auth | Propósito |
|---|---|---|---|
| GET | `/salud` | — | latido barato |
| GET | `/listo` | — | comprueba BD, pesos activos y alcanzabilidad del proveedor de IA. 503 si algo esencial falla |

### Sesión

| Método | Ruta | Auth | Propósito |
|---|---|---|---|
| POST | `/v1/sesion` | — | login. `{correo, clave}` → `{token, expira_en, usuario}`. Verifica contra un hash de descarte si el usuario no existe (tiempo constante) |
| GET | `/v1/sesion` | TOK | datos de la sesión actual |

### Reportes

| Método | Ruta | Auth | Propósito |
|---|---|---|---|
| POST | `/v1/reportes` | — | alta. **201** si creó, **200** si era reenvío. Idempotente por `id_cliente` |
| POST | `/v1/reportes/sincronizar` | — | lote 1–100, todo o nada. Devuelve un resultado por `id_cliente` |
| GET | `/v1/reportes` | — | FeatureCollection GeoJSON. Filtros: `bbox`, `estado`, `categoria`, `severidad`, `filtro` (KPI), `incluir_cerrados`, `limite`, `desplazamiento` |
| GET | `/v1/reportes/cercanos` | — | `lat`, `lng`, `radio_m`, `limite`. KNN con `<->` |
| GET | `/v1/reportes/:id` | — | detalle + medios + historial + extracciones de IA |
| GET | `/v1/reportes/codigo/:codigo` | — | consulta por código público (lo que el ciudadano tiene a mano) |
| GET | `/v1/reportes/:id/prioridad` | — | recalcula al vuelo y devuelve desglose + pesos vigentes |
| PATCH | `/v1/reportes/:id/estado` | **OP** | cambio de estado del operador. Fija `origen_triage='OPERADOR'` |
| POST | `/v1/reportes/:id/triage-ia` | **OP** | extracción sincrónica (~48 s con Ollama) |
| POST | `/v1/reportes/:id/medios` | — | multipart, 1 archivo, 12 MB. **200 + `{duplicado:true}`** si el SHA ya existía |
| GET | `/v1/medios/:id` | — | descarga |

### Recursos

| Método | Ruta | Auth | Propósito |
|---|---|---|---|
| GET | `/v1/recursos` | — | GeoJSON. `bbox`, `tipo`, `estado`, `limite` |
| GET | `/v1/recursos/cercanos` | — | `lat`, `lng`, `limite`. Solo `DISPONIBLE` |
| PATCH | `/v1/recursos/:id` | **OP** | estado, capacidad usada, notas, reubicación (`lat`+`lng` juntas o ninguna) |

### Tablero

| Método | Ruta | Auth | Propósito |
|---|---|---|---|
| GET | `/v1/tablero/resumen` | — | cifras de cabecera + espera máxima + recursos |
| GET | `/v1/tablero/cola` | — | cola priorizada. `limite`, `vivo=true` (recalcula), `filtro` (KPI). Devuelve `filtro_etiqueta` y `total` |
| GET | `/v1/tablero/zonas` | — | consolidado por zona administrativa |
| GET | `/v1/tablero/conglomerados` | — | DBSCAN. `radio_m` (def. 300), `minimo` (def. 2) |
| GET | `/v1/tablero/aislados` | — | reportes fuera del alcance de todo recurso. `umbral_m` (def. 5000) |
| GET | `/v1/tablero/posibles-duplicados` | — | pares por proximidad + categoría + ventana + similitud de texto. **Propone, no fusiona** |
| POST | `/v1/mantenimiento/refrescar-prioridades` | **SEC** | cabecera `x-secreto-mantenimiento`. Para cron externo cuando no hay Redis |

### Campo (toda la sección exige **OP** por hook)

| Método | Ruta | Propósito |
|---|---|---|
| POST | `/v1/campo/posicion` | reporta posición del dispositivo (`lat`, `lng`, `precision_m`) |
| GET | `/v1/campo/casos` | casos cercanos. `lat`, `lng`, `radio_m`, `limite`, `orden=prioridad\|distancia`, `solo_libres` |
| GET | `/v1/campo/mis-casos` | los que tomó quien consulta |
| GET | `/v1/campo/casos/:id/ruta` | ruta + **obstáculos reportados sobre el trayecto** |
| POST | `/v1/campo/casos/:id/tomar` | autoasignación. **409** si lo tomó otro (con su nombre) o si está cerrado. Idempotente para uno mismo |
| POST | `/v1/campo/casos/:id/liberar` | lo deja disponible |
| POST | `/v1/campo/casos/:id/en-atencion` | llegó al sitio |
| POST | `/v1/campo/casos/:id/resolver` | cierra. `{nota, personas_atendidas}`. Solo quien lo tomó |
| GET | `/v1/campo/personal` | personal con posición conocida + antigüedad del dato. Lo dibuja el mapa del tablero |

### Notificaciones

| Método | Ruta | Auth | Propósito |
|---|---|---|---|
| GET | `/v1/notificaciones/clave-publica` | — | clave VAPID para que la PWA se suscriba. Se sirve desde la API y no se incrusta en el bundle, para que cambiarla no exija reconstruir |
| POST | `/v1/notificaciones/suscribir` | — | ata un dispositivo a un reporte. Abierta sin cuenta, igual que el alta: lo que la protege es que hay que conocer el **código público** |

### Transversal

- Límite de tasa: **120 peticiones/minuto** por IP, `/salud` y `/listo` exentos.
  Calibrado generoso a propósito: en una emergencia varias personas del mismo
  barrio comparten IP de salida.
- `bodyLimit` 2 MB; multipart 12 MB por archivo.
- Errores: `{error, mensaje, detalles?}`. `ErrorHttp` para los esperados;
  los 5xx se registran con detalle.
- Registro con redacción de `authorization` y `contacto_reportante`.

---

## 7. FUNCIONALIDADES

| Funcionalidad | Estado |
|---|---|
| Reporte ciudadano sin cuenta | ✅ |
| Guardado local antes de enviar (IndexedDB) | ✅ |
| 4 capas de reintento (inmediato, `online`, temporizador 30 s, Background Sync) | ✅ (la 4.ª ⚠️ sin verificar con pestaña cerrada) |
| Idempotencia por `id_cliente` | ✅ con prueba |
| Reducción de fotos en el cliente (1568 px, canvas, EXIF respetado) | ✅ |
| Subida de fotos después del texto | ✅ |
| Código público legible por radio | ✅ |
| Validación de coordenadas al rango de Colombia | ✅ con prueba |
| Resolución de barrio/vereda por contención espacial | ✅ con prueba |
| Índice de prioridad 0–100 con 5 términos normalizados | ✅ 11 pruebas |
| Desglose explicable de cada puntaje | ✅ (suma == puntaje, con prueba) |
| Pesos versionados y editables por SQL | ✅ |
| Refresco periódico de prioridades | ✅ verificado |
| Cola priorizada en el tablero | ✅ |
| Filtros por KPI (11 mosaicos, lista + mapa a la vez) | ✅ con prueba de correspondencia |
| Filtro por severidad desde la leyenda, ortogonal al de KPI | ✅ 2 pruebas |
| Alerta de asignaciones estancadas | ✅ 2 pruebas |
| Conglomerados por densidad (DBSCAN) | ✅ |
| Consolidado por zonas | ✅ |
| Reportes aislados | ✅ |
| Deduplicación asistida | ✅ (propone; no fusiona) |
| Mapa GIS con capas y leyenda | ✅ |
| Login (solo desde «Atender») + logout | ✅ |
| Casos cercanos con dos ordenaciones explícitas | ✅ |
| Ruta al caso (OSRM) | ✅ |
| Obstáculos reportados sobre la ruta | ✅ con 3 pruebas |
| Tomar / liberar / en atención / resolver | ✅ 17 pruebas |
| Candado de concurrencia al tomar | ✅ con prueba de dos usuarios |
| Bitácora con actor y nota | ✅ |
| Posición del personal en campo | ✅ escritura y lectura, con antigüedad en 3 franjas |
| Extracción de texto libre (Ollama) | ✅ medida |
| 6 candados sobre lo que la IA puede escribir | ✅ 11 pruebas |
| Etiquetado de fotos | 🟡 sin ejecutar |
| Cola BullMQ para IA | 🟡 el trabajador arranca; no se vio procesar un trabajo de triage |
| **Consulta de un caso por código público** | ✅ estados en lenguaje de persona + bitácora |
| **Aviso cuando el GPS es impreciso** (>150 m) | ✅ no bloquea el envío |
| **Compartir el código por WhatsApp** | ✅ |
| **Notificaciones push a quien reportó** | ✅ recibida en un dispositivo real |
| **Medios en almacenamiento de objetos** | ✅ SHA-256 idéntico al subir y bajar |
| **Tocar un reporte de la cola lleva el mapa al sitio** | ✅ |
| **Recursos importables desde archivo, idempotente** | ✅ 3 388 cargados |
| Hora de llegada al sitio con su procedencia | ✅ 6 pruebas |
| Alerta de asignaciones estancadas | ✅ 2 pruebas |
| Filtro por severidad desde la leyenda del mapa | ✅ 2 pruebas |

---

## 8. DECISIONES TÉCNICAS

### La fórmula de prioridad original no funcionaba

La formulación de partida sumaba los términos en crudo. Dos problemas:
`distancia_a_recursos` sumada así **premia estar cerca de la ayuda** (es al
revés: quien está lejos tarda más), y las unidades no son comparables — «23
personas» y «1200 metros» no se suman, y el metro domina por magnitud.

Solución: cada término se normaliza a 0..1 contra un punto de saturación
explícito y se pondera con pesos que suman 100. Detalle en
[`prioridad.md`](prioridad.md).

**Descartado:** un puntaje combinado de distancia y urgencia para el rescatista.
La penalización correcta por kilómetro depende de si va a pie o en camión y de
cuántos equipos hay — nada de eso lo sabe el servidor, así que el número
esconderría la decisión en vez de tomarla. Se exponen **dos ordenaciones
explícitas**.

### `personas_fallecidas` no entra en la carga humana

Recuperar cuerpos es una tarea distinta de rescatar a alguien con vida; contarlas
desviaría equipos de vidas salvables. Hay una prueba que falla si alguien lo
cambia.

### `severidad = 'DESCONOCIDA'` vale 0.5, no 0

Quien no sabe qué tan grave es lo suyo debe quedar a media tabla para que alguien
lo mire, no enterrado.

### El término de espera se va a CERO al atender, no se congela

Congelarlo fue el primer intento y estaba mal: un reporte asignado conservaba su
bono de 12 horas para siempre y seguía desplazando a reportes sin mirar. **Lo
encontró una prueba que falló**, no una revisión.

### La IA estructura texto; no decide a quién se rescata

Seis candados, el primero en la base para que ningún camino de código lo evada:

1. Trigger: si `origen_triage='OPERADOR'`, un proceso automático no puede
   escribir.
2. No se sobreescribe un conteo que el ciudadano escribió (solo se rellenan
   ceros).
3. `requiere_rescate` solo sube a `true`.
4. `cantidad_indeterminada` activo → **ningún** conteo se aplica.
5. **`personas_atrapadas` nunca se aplica automáticamente** (pesa ×3 y es donde el
   modelo falla de forma reproducible).
6. `IA_APLICAR_AUTOMATICAMENTE=false` por defecto con modelos locales.

### El orden de los campos del esquema de extracción es funcional

Bajo decodificación restringida el JSON se emite en el orden del esquema.
Con `categoria` primero la precisión medida fue **1/4**; poniendo `justificacion`
primero (donde razona en prosa) y las clasificaciones al final, **6/7**. Hay una
prueba que falla si alguien reordena. Detalle y mediciones en
[`ia-local.md`](ia-local.md).

### La ruta se cruza contra los reportes de vías bloqueadas

Un motor de ruteo usa el grafo vial de un día normal; este sistema ya sabe qué
calles reportaron intransitables. **No recalcula evitándolos** —eso necesita
pgRouting y es otro proyecto— pero avisa, ordenado por metros desde el origen.
Medición que justifica no usar línea recta: 740 m en recta vs **2527 m** por
calles.

### El candado de concurrencia va en el `WHERE`

No se lee y después se escribe: eso deja una ventana. La condición
`(responsable_id IS NULL OR responsable_id = $2)` va en el `UPDATE` mismo, lo que
además lo hace idempotente para uno mismo (reintentar por mala señal no falla).

### Login solo en «Atender»

Tener un solo lugar donde autenticarse evita que alguien quede con sesión abierta
desde una pantalla y crea que la tiene en la otra. El tablero se ve completo en
modo consulta: ponerlo detrás de un login no protege nada y estorba.

### Sin dependencias nativas

`scrypt` de `node:crypto` en vez de bcrypt/argon2; reducción de imágenes con
canvas en el cliente en vez de sharp. Una compilación de node-gyp fallando en el
servidor de una alcaldía es el problema que no se quiere tener durante una
emergencia.

### TypeScript ejecutado directo, sin build

Node 24 borra los tipos. `tsc` solo revisa, con `erasableSyntaxOnly` para que
avise cuando alguien usa sintaxis que Node no puede borrar (se descubrió al
arrancar con una propiedad de parámetro en un constructor).

### El SDK de Anthropic va adelante de lo publicado

En `@anthropic-ai/sdk` 0.70.1 la salida estructurada está en
`client.beta.messages.parse` con `betaZodOutputFormat` de
`helpers/beta/zod`, el formato se pasa como `output_format` y el resultado llega
en **`.parsed_output`** (el propio JSDoc del SDK dice `.parsed`, que no existe en
los tipos). No hay `output_config.effort`. **Verificar `node_modules` antes de
escribir contra este SDK.**

### Recibir un reporte no puede depender de nada opcional

Es la regla que resume el defecto más grave del despliegue. La cola de IA, las
notificaciones, el almacén de fotos y la extracción son comodidades; **el alta de
un reporte no es negociable**. En concreto:

- Si Redis no está, `encolarTriage` no encola y ya. Con `REDIS_URL` vacía ni lo
  intenta, y si está configurado pero caído se rinde a los 2 segundos.
- Si las notificaciones no están configuradas, `notificarCambioDeEstado` devuelve
  `null` en vez de lanzar.
- Notificar nunca puede tumbar la acción que lo provocó: un equipo que marca
  «llegué al sitio» no puede recibir un error porque el teléfono de otra persona
  ya no existe.

Hay pruebas que fijan las tres.

### El permiso de notificaciones se pide después de reportar, nunca al abrir

Un navegador que pregunta «¿permitir notificaciones?» antes de que la persona
sepa para qué sirve el sitio recibe un «no» casi siempre — y ese «no» se recuerda
para siempre, no se puede volver a preguntar. Justo después de enviar el reporte
es el único momento en que «¿le avisamos cuando alguien tome su caso?» tiene una
respuesta obvia. Si ya lo negó antes, ni se ofrece.

Y **el texto de la notificación no dice qué pasó ni dónde**: se ve en la pantalla
bloqueada, y quien pase al lado del teléfono no tiene por qué enterarse de que en
tal casa hay gente atrapada.

### Un recurso se identifica por su origen, no por su nombre

En Colombia hay 42 sitios llamados solo «Hospital» y 40 «Puesto de salud». El
índice único por nombre de la migración 009 habría fundido 665 filas al cargar el
país — dejando el mapa diciendo que no hay ayuda en decenas de municipios donde
sí la hay. La 011 usa `fuente` + `fuente_id` (para OSM, `node/240954853`) y deja
el nombre como clave solo para lo que se escribe a mano.

### Validación manual con Zod, no el proveedor de tipos de Fastify

Para no acoplar todas las rutas a la compatibilidad entre dos dependencias que
suben de major por separado.

---

## 9. PROBLEMAS CONOCIDOS

### Deuda técnica con impacto real

Ninguna abierta. La última —asignaciones estancadas— se cerró con una alerta:
mosaico «asignados sin llegada» y filtro `estancados`. Queda la mitad de fondo,
degradada a pendiente y no a deuda: el reporte estancado **sigue sin volver a
subir en la cola**, porque eso exige un sexto término del índice y repartir de
nuevo los cinco pesos. Con la alerta, el caso deja de ser invisible; sin el
término, sigue dependiendo de que alguien mire. Razonamiento en `prioridad.md`.

### Los seis defectos que apareció el despliegue

Vale la pena conservarlos escritos: **ninguno se parecía a su causa**, y cuatro
de los seis solo aparecen fuera de la máquina de desarrollo.

1. **`--env-file` mata el proceso si el archivo no existe.** En un hospedaje no
   hay `.env`. Los scripts usan `--env-file-if-exists`; `probar` conserva el
   estricto a propósito.
2. **El hospedaje inyecta `PORT`, no `API_PUERTO`.** Sin atenderlo, el proceso
   arranca sin quejarse, escucha en 3010, y la plataforma enruta a otro puerto:
   502 permanente **sin una sola línea de error**. `config.ts` le da prioridad a
   `PORT`.
3. **`hash-clave.ts` solo hacía UPDATE.** En una base limpia no había forma de
   crear el primer operador — y crearlo por SQL tampoco, porque la tabla exige
   que todo operador tenga organización. Ahora lo crea, y resuelve la
   organización sin adivinar.
4. **La base de pruebas nunca recibía migraciones nuevas.** `ayudas.ts` se
   saltaba las migraciones si la tabla `reportes` ya existía, así que una
   migración nueva no llegaba jamás a la suite: seguía verde contra un esquema
   viejo. Ahora guarda la lista de archivos aplicados y reconstruye si cambió.
5. **Un Redis ausente tumbaba el alta de reportes.** Dos fallos sumados:
   `maxRetriesPerRequest: null` —que BullMQ exige— hace que `add()` no se
   resuelva **ni se rechace**, así que el `await` de la ruta colgaba para
   siempre; y la conexión de ioredis no tenía oyente de `error`, lo que convierte
   cada intento fallido en excepción no capturada. **El primer reporte real
   habría tumbado el servicio, y el reporte habría quedado guardado sin que el
   ciudadano recibiera confirmación.** Se ve como «la app no funciona» cuando en
   realidad sí guardaba.
6. **El nombre no identifica un recurso.** El índice único de la migración 009
   habría fundido 665 filas al cargar el país entero: hay 42 sitios llamados solo
   «Hospital» y 40 «Puesto de salud». La 011 lo cambia por el identificador
   estable de la fuente.

### Limitaciones aceptadas (documentadas)

- **OSRM demo y teselas de OSM**: ninguna permite tráfico de producción. Ver §2
  sobre por qué es menos urgente de lo que suena.
- **El service worker sincroniza solo el texto**, no las fotos (multipart desde el
  SW suma complejidad; el reporte es lo que ordena un rescate).
- **`v_cola_prioridad_vivo` y `?vivo=true`** hacen una llamada a función por fila.
  Exactos pero O(n); usar con filtros o volúmenes acotados.
- **`lugares` está vacía en producción**, así que no hay resolución de zona ni
  panel de zonas.
- **Los recursos son de OpenStreetMap**: dato comunitario, sin verificar. Para el
  término de aislamiento sirve —un error de 200 m no cambia una decisión— pero
  `GET /v1/recursos/cercanos` sí se le podría mostrar a un rescatista, y ahí la
  exigencia es otra. Cada registro lo dice en su campo `notas`.
- **Un medio de antes del cambio a Supabase Storage quedó huérfano**: la fila
  existe en `medios_reporte` y el archivo no. Es de cuando los medios iban al
  disco efímero de Render.

### Sin verificar (⚠️)

- El trabajador `triage-ia` procesando un trabajo real de la cola.
- Background Sync con la pestaña cerrada.
- Etiquetado de fotos (falta modelo con visión).
- Proveedores `compatible` y `anthropic`.
- Cualquier cosa con concurrencia real (varios rescatistas simultáneos en
  producción); el candado está probado con dos usuarios en la suite.
- **Notificaciones push en iPhone.** Se verificó en Chrome de escritorio. En iOS
  solo llegan si la persona agregó la app a la pantalla de inicio; en Safari a
  secas no funcionan nunca. Es limitación de Apple, y conviene saberlo antes de
  que alguien lo reporte como fallo.

### Sobre la instancia gratuita de Render

Medido durante el despliegue: **alrededor de una de cada tres peticiones falla en
la capa de red** mientras la instancia despierta, con errores de TLS que no
vienen de la aplicación. Para el ciudadano está cubierto por diseño —la PWA
guarda el reporte antes de enviarlo y reintenta— pero para quien mira el tablero
significa recargar de vez en cuando. **No es un fallo del código.**

El cron cada 10 minutos existe justo para reducirlo, y el manejador del Worker
reintenta una vez con pausa por la misma razón.

### Detalles menores

- Los source maps de producción van habilitados (`sourcemap: true`), así que el
  código fuente queda expuesto. Para un proyecto MIT es aceptable, pero es una
  decisión, no un descuido.
- `apps/web/src/lib/api.ts` duplica los nombres de filtro que define
  `apps/api/src/esquemas/filtros.ts`. No hay nada que fuerce que coincidan.
- `.claude/launch.json` existe pero el tooling de esta máquina lee el del
  directorio de trabajo primario, así que no se usó.

---

## 10. ÚLTIMO TRABAJO REALIZADO

**El 13 de agosto de 2026 el proyecto pasó de correr en una máquina a estar
desplegado y recibiendo reportes de personas reales.** Dieciséis commits en un
día. Lo relevante, agrupado:

### El despliegue

| Commit | Qué |
|---|---|
| `1807b54` | que la aplicación pueda arrancar fuera de esta máquina (`--env-file-if-exists`, `PORT`) |
| `801a5d4` | fijar Node 24 y poder crear el primer operador en una base limpia |
| `4232941` | servir la PWA desde un Worker de Cloudflare que reenvía `/v1` a la API |
| `a15fd5b` | versionar `API_ORIGEN` para que el despliegue no la borre |
| `93be188` | cron que despierta la API y refresca prioridades cada 10 min |

### Los arreglos que salieron de usarlo

| Commit | Qué |
|---|---|
| `eac195c` | **que un Redis ausente no tumbe el alta de reportes** — el más grave |
| `2771e49` | consultar caso por código, almacén de medios intercambiable, cargador de recursos |
| `726ea99` | tocar un reporte lleva el mapa al sitio; la bandeja deja de ofrecer lo que ya hace sola |
| `908cdb0` | notificaciones push a quien reportó |
| `e6bc92f` | los 3 374 recursos de emergencia de Colombia desde OpenStreetMap |

### Lo que se aprendió midiendo, no suponiendo

Tres cosas salieron de mirar datos reales y cambiaron decisiones:

**El índice funcionaba a dos de cinco términos.** Con la base recién desplegada,
`espera` estaba congelada en 0 —el refresco no corría, porque el secreto no había
llegado al Worker— y `aislamiento` daba los 15 puntos completos a todos, porque
no había ni un recurso cargado. Se veía ordenando bien y no lo estaba.

**Un reporte del Caquetá parecía el más urgente y era un artefacto.** Salía a
364 km del recurso más cercano; al cargar los recursos del país resultó tener un
hospital a **1 411 m**. Su prioridad bajó de 48.42 a 37.65 y la cola se reordenó.

**No se puede calibrar el umbral de «asignados sin llegada».** Al medir la
bitácora, 2 de cada 5 casos cerrados nunca pasaron por `EN_ATENCION`: el dato no
se estaba recogiendo. **El instrumento estaba roto, no la muestra** — esperar más
tiempo no lo habría arreglado. Eso llevó a la migración 008 —hora de llegada
**con su procedencia**, `MARCADA` o `DECLARADA`— y a la pregunta al cerrar. El
reloj de esa medición empieza ahí.

## 11. SIGUIENTE PASO

**Escuchar la beta. No construir nada grande todavía.**

El sistema está desplegado y recibiendo reportes reales desde el 13 de agosto.
La deuda técnica con impacto real está en cero. Lo que falta ahora no se decide
leyendo código: se decide viendo qué hace la gente con él.

### La pregunta de fondo, que es de producto y no técnica

**Hoy el sistema supone que existe un coordinador mirando el tablero.** Y la
propia beta ya dio evidencia en contra: los primeros cinco reportes reales
entraron y **se quedaron en `RECIBIDO`** hasta que se movió uno a mano para
probar las notificaciones. Nadie hizo triage. Nadie tomó un caso.

Hay dos caminos y son distintos:

| Camino | Lo que implica |
|---|---|
| **Herramienta de triage** (lo que es hoy) | Necesita que una alcaldía, una junta o un cuerpo de socorro la adopte. Lo que falta no es código: es convencer a una institución. |
| **Ayuda mutua** | Sirve sola desde el primer día. Pero deja de ser un sistema de coordinación y pasa a ser una plataforma de vecinos. |

**Riesgo que hay que resolver antes de abrir el «tomar caso» a cualquiera:** un
«voy para allá» falso es peor que nada — el reporte se ve atendido y nadie llega.
Hoy eso no puede pasar porque solo entra personal autenticado y queda en la
bitácora con nombre. Ese es justo el valor que se perdería.

**Camino intermedio, si se quiere avanzar sin pivotar:** el tablero ya es público
en modo consulta. Falta que quien reportó vea que alguien viene, y un rol de
«respondiente» al que uno se **registra** —no anónimo— conservando la
trazabilidad.

**Recomendación: no decidirlo aún.** La beta lleva un día. Si en dos semanas
nadie de una junta o de la Defensa Civil ha mirado el tablero, la respuesta ya
estará dada.

#### Un dato real, del mismo día

Horas después de desplegar, a Cristian le llegó por WhatsApp un mensaje sobre
**incendios forestales en zonas rurales de Ocaña, Norte de Santander**. Vale la
pena conservar qué pedía, porque es evidencia directa para esta decisión:

> «hacemos un llamado a las personas que tengan experiencia o conocimientos en el
> manejo y control de este tipo de incendios para que puedan sumarse y brindar
> apoyo en las labores de control y extinción»

**No pedía que alguien reportara dónde hay fuego. Pedía voluntarios con
experiencia.** Es decir: lo que circula de verdad en una emergencia colombiana se
parece más a la mitad de ayuda mutua que a la de triage.

Es un solo caso y no decide nada por sí mismo. Pero vale más que cualquier
razonamiento de escritorio, y por eso queda escrito.

(Ocaña quedó cubierta por la carga nacional de recursos: seis, cinco de ellos a
menos de 730 m del centro. Si entra un reporte de allá, el índice ya lo ordena
bien.)

### Lo demás, que sí es concreto

**Sembrar `lugares`.** Es el hueco más visible: sin geografía no hay resolución
de zona y el panel de «Zonas» del tablero está vacío. Hace falta DIVIPOLA real,
no los dos barrios de prueba.

**El umbral de «asignados sin llegada» sigue sin poder calibrarse.** La cobertura
de horas de llegada era del 43 % con 3 datos, dos de ellos de 0.0 minutos porque
salieron de clics seguidos en una sesión de pruebas. Hay que esperar uso real y
mirar `db/queries/tiempos-de-llegada.sql`, que reporta la cobertura **antes** que
cualquier percentil justamente por esto.

**Recursos fuera de las ciudades cubiertas.** Ya no urge: están los 3 388 del
país. Y el término **satura a los 5 000 m**, así que solo importa lo que haya
dentro de ese radio de donde llegan reportes — no hace falta perfección lejana.

**El etiquetado de fotos** sigue sin ejecutarse nunca. Solo necesita
`ollama pull gemma3:4b` y un `IA_MODELO` con visión. Es lo más visible que se
puede hacer sin decidir nada de producto.

---

## 12. COMANDOS IMPORTANTES

### Instalar

```bash
cp .env.example .env
npm install
```

### Servicios

```bash
npm run bd:arriba        # PostGIS en 5434, Redis en 6381
npm run bd:abajo
npm run bd:reiniciar     # borra volúmenes, migra y siembra de cero
```

### Base de datos

```bash
npm run bd:migrar        # corredor idempotente, verifica hash de lo ya aplicado
npm run bd:sembrar       # datos de prueba (idempotente, UUID fijos)
```

### Desarrollo (tres terminales)

```bash
npm run dev:api          # http://localhost:3010  (--watch)
npm run dev:web          # http://localhost:5180
npm run trabajadores --workspace=@emergencias/api
```

### Pruebas y tipos

```bash
npm run probar           # 76 pruebas contra emergencias_test
npm run tipos            # tsc --noEmit en ambos paquetes
```

### Utilidades

```bash
# crear un operador, o cambiarle la clave si ya existe
# (crea la organización si hace falta: todo operador necesita una)
npm run clave --workspace=@emergencias/api -- correo@ejemplo.co clave-larga ADMIN "Nombre de la organización"

# comprobar que DATABASE_URL conecta y que PostGIS está
# traduce los tres errores típicos, que no se parecen a su causa
npm run bd:probar-conexion

# cambiar la contraseña dentro de DATABASE_URL, codificándola bien
# (un @ o un # sin codificar parten la URL en dos)
npm run bd:clave -- 'la-clave-nueva'

# cargar recursos de emergencia desde un archivo (idempotente)
node --env-file-if-exists=.env scripts/cargar-recursos.mjs db/recursos-colombia.json

# probar una notificación push de punta a punta
# cambia el estado POR LA API, que es lo que dispara el aviso
node --env-file-if-exists=.env scripts/probar-notificacion.mjs RPT-XXXXX "clave" [ESTADO]

# medir tiempos de llegada (calibración del umbral de estancados)
docker exec -i emergencias_postgres psql -U emergencias -d emergencias \
  < db/queries/tiempos-de-llegada.sql

# consultas PostGIS de referencia
docker cp db emergencias_postgres:/tmp/db
docker exec emergencias_postgres psql -U emergencias -d emergencias \
  -f /tmp/db/queries/consultas-ejemplo.sql

# psql interactivo
docker exec -it emergencias_postgres psql -U emergencias -d emergencias

# IA local
ollama pull qwen2.5
ollama list
```

### Cuentas de prueba (semilla, clave `demo1234`)

`socorrista@demo.local` (RESPONDIENTE) · `operadora@demo.local` (OPERADOR) ·
`admin@demo.local` (ADMIN). En desarrollo la pantalla de acceso las lista y las
llena con un toque.

---

## 13. REGLAS PARA CONTINUAR

### Git

- **No hacer commits ni push automáticamente.** Cristian ejecuta todo lo de git.
  Dejar los cambios en *staging* y entregarle los comandos.
- **Nunca** poner `Co-Authored-By` de Claude ni firmas de Claude en commits o PRs.
- Este repo usa la identidad **personal** (`Cris904fl / cristiafl3@gmail.com`) con
  `credential.https://github.com.username = Cris904fl` local. **No tocar el
  `.gitconfig` global ni la credencial guardada de `cristianflorez-j`**: los repos
  del trabajo dependen de ella.
- Mensajes de commit en estilo convencional, en español, sin tildes en el asunto.

### Entorno de la máquina

- Shell: **Windows PowerShell 5.1** — sin `&&` ni `||`. Dar comandos sueltos o
  `; if ($?) { }`. (El Bash de Git también está disponible; `MSYS_NO_PATHCONV=1`
  para rutas de contenedor.)
- **No matar ni relanzar procesos de otros proyectos** de Cristian
  (`aduanas_*`, `ocr_*`, `cls_postgres_dev`). Los puertos 5434 y 6381 se eligieron
  por eso.

### Código

- **Extensión `.ts`/`.tsx` explícita en todas las importaciones**, en API y en
  web.
- **Nada de sintaxis no borrable**: sin enums, sin namespaces con valor, sin
  propiedades de parámetro en constructores. Node ejecuta el TypeScript borrando
  tipos.
- Todo en **español**: nombres de variables, funciones, columnas, rutas,
  comentarios. Es consistente en todo el repositorio.
- **Nunca editar una migración ya aplicada.** El corredor guarda su SHA-256 y
  falla si cambia. Crear una nueva (`008_*.sql`).
- Al agregar un valor a un ENUM de la base, actualizar también
  `apps/api/src/esquemas/dominio.ts`.
- `count()`/`sum()` en SQL van con `::int` si el resultado va a JSON.

### Invariantes que NO se deben romper

1. **La IA no escribe sobre triage humano.** El trigger `reportes_proteger_triage`
   lo impide; no quitarlo. Y `personas_atrapadas` sigue excluida de la aplicación
   automática (`calcularActualizacion` en `servicios/triage.ts`).
2. **`personas_fallecidas` fuera de la carga humana** del índice de prioridad.
3. **El orden de los campos de `EsquemaExtraccion`** — hay una prueba que lo fija;
   si se cambia, hay que volver a medir (ver `ia-local.md`).
4. **El alta de reportes es idempotente por `id_cliente`.** Todo el modo sin
   conexión depende de eso.
5. **El reporte se guarda en IndexedDB antes de intentar enviarlo**, y se avisa a
   la interfaz en ese momento (no al sincronizar): ese fue un defecto real que
   dejaba al ciudadano sin saber si su reporte quedó registrado.
6. **El candado de concurrencia va en el `WHERE` del `UPDATE`**, no en una lectura
   previa.
7. **Los filtros de KPI se definen en un solo archivo** (`esquemas/filtros.ts`)
   porque la cola, el mapa y el resumen tienen que coincidir exactamente.

### Convenciones de la suite

- Las pruebas corren contra `emergencias_test`, que la suite crea sola. Hay una
  salvaguarda que aborta si `DATABASE_URL` no termina en `_test` (la suite hace
  `TRUNCATE`).
- **Ninguna prueba debe salir a la red**: `IA_PROVEEDOR=ninguno` y `RUTEO_URL=`
  vacío en `.env.pruebas`.
- `test/ayudas.ts` cierra las colas además del pool. Sin eso el proceso de
  pruebas no termina y el síntoma es desconcertante (la suite pasa pero el
  comando se cuelga si la salida está en una tubería).
- **La base de pruebas se reconstruye sola cuando llega una migración nueva.**
  `ayudas.ts` guarda la lista de archivos aplicados en `migraciones_pruebas`; si
  no coincide con `db/migrations/`, tira el esquema y lo aplica todo de cero.
  Antes se saltaba las migraciones si la tabla `reportes` ya existía, así que una
  migración nueva **nunca** llegaba a las pruebas: la suite seguía verde contra
  un esquema viejo hasta que algo fallaba con un 500 sin relación aparente. Una
  suite verde contra un esquema desactualizado no prueba lo que dice probar.

---

## 14. EL DESPLIEGUE

Puesto en producción el 13 de agosto de 2026. Recibiendo reportes de personas
reales desde ese día.

### Direcciones

| Qué | Dónde |
|---|---|
| **La aplicación** (lo que se comparte) | `https://mapa-emergencias.humanitario.workers.dev` |
| API | `https://mapa-emergencias.onrender.com` |
| Base de datos | Supabase, proyecto `xzjwrahxmmaphtrxzdgh`, región `us-east-2` |
| Página de presentación | `docs/presentacion/index.html` |

### Topología, y por qué

```
Navegador
   │
   ▼
Cloudflare Workers ──── sirve la PWA (assets estáticos)
   │                    y REENVÍA /v1 a la API
   ▼
Render (API Fastify, plan Free)
   │
   ▼
Supabase (PostgreSQL 17.6 + PostGIS 3.3.7 + Storage)
```

**El reenvío de `/v1` desde el Worker no es un capricho.** La PWA llama a la API
con rutas relativas, y eso es de lo que depende el modo sin conexión: un service
worker **solo ve peticiones de su propio origen**. Si la PWA llamara directo a
`onrender.com`, la bandeja de salida —lo que reintenta el reporte cuando vuelve
la señal— dejaría de funcionar. En desarrollo lo resuelve el proxy de Vite; en
producción, `worker/index.js`.

Ese mismo Worker reenvía la IP real del visitante en `X-Forwarded-For`. Sin eso,
el límite de 120 peticiones por minuto —que es **por IP**— se convertiría en 120
para todo el mundo junto, y reventaría justo cuando varios vecinos reporten a la
vez.

### El cron

`wrangler.jsonc` declara `*/10 * * * *`. El manejador `scheduled` de
`worker/index.js` hace dos cosas, con un reintento cada una:

1. **Despierta la API** (`GET /salud`). La instancia gratuita de Render hiberna
   tras unos 15 minutos sin tráfico y tarda hasta un minuto en volver.
2. **Refresca las prioridades** (`POST /v1/mantenimiento/refrescar-prioridades`).
   Sin esto, dos términos del índice se congelan: la espera deja de crecer con el
   reloj y un reporte de 12 horas pesa igual que uno de 10 minutos. **Ocurrió en
   producción** hasta que el secreto llegó al Worker.

### Configuración: qué va dónde

| Sitio | Variables |
|---|---|
| **Render** | `DATABASE_URL`, `JWT_SECRETO`, `SECRETO_MANTENIMIENTO`, `NODE_ENV`, `IA_PROVEEDOR=ninguno`, `REDIS_URL=` (vacía), `SUPABASE_URL`, `SUPABASE_CLAVE_SERVICIO`, `VAPID_CLAVE_PUBLICA`, `VAPID_CLAVE_PRIVADA`, `VAPID_CONTACTO` |
| **Cloudflare** | `API_ORIGEN` va en `wrangler.jsonc` (no es secreta); `SECRETO_MANTENIMIENTO` va como **Secret** en el panel |

**Por qué `API_ORIGEN` está versionada y el secreto no:** `wrangler deploy`
reescribe las variables del Worker con las del archivo en cada despliegue. Una
variable puesta a mano en el panel funciona hasta el siguiente push y desaparece
**sin avisar**. Los *secrets* sobreviven; las *variables* no.

### Trampas del despliegue, para no repetirlas

- **`DATABASE_URL` debe ser la del pooler**, no la directa. `db.<ref>.supabase.co`
  es **solo IPv6** y muchas redes —incluida la de desarrollo— no lo tienen: falla
  con `ENOTFOUND`, que no se parece a su causa. El pooler es
  `aws-N-REGION.pooler.supabase.com` y **el usuario cambia** a
  `postgres.<ref-del-proyecto>`.
- **La cadena necesita `uselibpqcompat=true&sslmode=require`.** Sin lo primero,
  `pg` valida la cadena de certificados del pooler y falla con
  `self-signed certificate`.
- **El build de Render debe estar acotado al workspace de la API.** Un
  `npm install` en la raíz baja MapLibre, Vite, React y TypeScript —unos 111 MB
  que la API nunca carga. El comando correcto es
  `npm ci --omit=dev --workspace=@emergencias/api --include-workspace-root`.
  El `--omit=dev` es seguro: Node ejecuta el TypeScript borrando tipos, así que
  `typescript` no hace falta en ejecución.
- **Cloudflare ya no ofrece crear proyectos de Pages** desde el panel (agosto de
  2026); todo pasa por Workers con binding de assets. Por eso el proxy vive en
  `worker/index.js` y no en un directorio `functions/`.
- **Cambiar el subdominio de `workers.dev`** rompe la URL anterior de inmediato y
  la nueva tarda unos minutos en tener certificado. Hacerlo antes de compartir
  nada.

### Datos cargados

- **3 388 recursos** de emergencia de todo Colombia, desde OpenStreetMap
  (`db/recursos-colombia.json`). Hospitales, puestos de salud, estaciones de
  bomberos y de ambulancias.
- **`lugares` está vacía.** No se sembró a propósito: los datos de desarrollo son
  dos barrios de Bogotá y aparecerían como reales.
- **Ningún dato de prueba en `reportes`.** Los que hay son de personas reales.

### Verificación de que sigue vivo

```bash
curl -s https://mapa-emergencias.onrender.com/listo
```

Debe responder `{"estado":"listo"}` con cuatro comprobaciones en `ok`, incluida
`almacen_medios: Supabase Storage`. Si dice `disco`, alguna de las dos variables
de Supabase no llegó y **las fotos se están perdiendo en silencio**.

```bash
node --env-file-if-exists=.env scripts/probar-conexion.mjs
```

Comprueba la base y traduce los tres errores típicos, que no se parecen a su
causa.

---

## CHECKPOINT

**Estado actual en una frase.** Sistema **desplegado y en uso**: reporte
ciudadano offline-first, priorización auditable con sus cinco términos activos,
consulta por código, notificaciones push, atención en campo con ruta y
obstáculos, tablero con filtros cruzables — con **76 pruebas** pasando, todo en
`origin/main` y **reportes de personas reales entrando**.

**Último cambio realizado.** Commit `e6bc92f`: carga de los 3 374 recursos de
emergencia de Colombia desde OpenStreetMap, con la migración `011` que cambia la
identidad de un recurso del nombre a su identificador de origen. Sin ese cambio,
665 filas se habrían fundido en silencio.

**Próxima tarea exacta.** Ninguna urgente, y eso es deliberado: **la beta lleva
un día y lo que falta se decide escuchándola**. Ver §11 para la pregunta de fondo
—si esto es una herramienta de triage o una plataforma de ayuda mutua— y por qué
conviene no responderla todavía.

Lo accionable sin decidir nada de producto:

1. **Sembrar `lugares`** con DIVIPOLA real. Es el hueco más visible: sin
   geografía no hay resolución de zona y el panel de «Zonas» está vacío.
2. **Etiquetado de fotos** — solo necesita `ollama pull gemma3:4b`.

**Archivos relevantes.** `db/seeds/` y `apps/api/src/db/sembrar.ts` para lo
primero; `apps/api/src/servicios/ia/imagen.ts` y `docs/ia-local.md` para lo
segundo.

**Bloqueos actuales.** Ninguno técnico.

**Advertencia que no debe perderse.** El sistema tiene usuarios reales. Cualquier
cambio que toque el alta de reportes, la bandeja de salida o el índice de
prioridad afecta a gente que está pidiendo auxilio. Las reglas de §13 no son
formalidades: la idempotencia por `id_cliente`, el guardado local antes de
enviar, y que **recibir un reporte no dependa de nada opcional** son lo que
sostiene eso.
