# HANDOFF — Mapa inteligente de afectaciones

Estado del repositorio en el commit **`efa74d8`** (rama `main`, sincronizada con
`origin/main`). Documento escrito inspeccionando el código y la base de datos en
ejecución, no de memoria.

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

**Alcance actual.** Un despliegue funcional de un solo evento, con geografía de
prueba sobre coordenadas de Bogotá. No hay multi-tenancy, ni federación entre
entidades, ni datos reales de DIVIPOLA.

---

## 2. ESTADO ACTUAL

### ✅ Completamente implementado y verificado

| Pieza | Verificación |
|---|---|
| Esquema PostGIS: 9 tablas de dominio, 10 ENUM, 4 vistas, 12 triggers | 7 migraciones aplicadas contra PostGIS 3.5.2 |
| Índice de prioridad con pesos versionados y desglose explicable | 11 pruebas |
| API Fastify: 34 endpoints | 48 pruebas |
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
- **`GET /v1/campo/personal`.** Endpoint implementado y funcionando, **sin ningún
  consumidor**: el tablero no muestra dónde está el personal. Hoy es código
  muerto.
- **Background Sync del service worker.** El código existe. Se verificó la
  sincronización al recargar la página; ⚠️ **no se verificó el caso de pestaña
  cerrada**, que es el único que Background Sync aporta de más.
- **Almacenamiento de medios.** Funciona en disco local con deduplicación por
  SHA-256. No hay S3/MinIO.

### ⬜ Pendiente

- Geografía real de DIVIPOLA en `lugares` (hoy: un municipio y dos barrios de
  prueba).
- Proveedor propio de teselas (hoy: OpenStreetMap, cuya política **no permite
  producción**).
- Partición del bundle de la PWA (ver §9 y §11).
- Seguimiento de asignaciones estancadas (un caso `ASIGNADO` al que nadie llegó no
  vuelve a subir en la cola).
- Modo sin Redis para despliegue gratuito: la ruta
  `POST /v1/mantenimiento/refrescar-prioridades` existe, pero la extracción por IA
  en ese modo queda solo a demanda.

### Qué funciona ahora mismo

Con los servicios levantados: se reporta desde el navegador (con o sin red), se
ve en el tablero ordenado por prioridad con su desglose, se filtra por cualquier
KPI, un rescatista entra, ve los casos cerca, calcula la ruta con las vías
bloqueadas, toma el caso, marca que llegó y lo cierra con nota. Todo queda en la
bitácora con actor.

### Bugs conocidos

Ninguno abierto y reproducible. Los dos defectos encontrados durante el
desarrollo se corrigieron y quedaron con prueba de regresión (ver §9).

---

## 3. STACK

| Capa | Tecnología | Versión instalada |
|---|---|---|
| Runtime | Node.js | **24.18.0** (mínimo 22) |
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
                005_prioridad · 006_triggers · 007_campo
  seeds/        001_desarrollo.sql        (UUID fijos, idempotente)
  queries/      consultas-ejemplo.sql    (8 consultas PostGIS ejecutables)
apps/api/src/
  config.ts             configuración validada con Zod
  app.ts                construcción de Fastify, plugins, manejo de errores
  servidor.ts           arranque y apagado ordenado
  db/                   pool, migrar, sembrar, hash-clave
  esquemas/             dominio.ts (ENUM espejo) · reporte.ts (entrada) · filtros.ts (KPI)
  lib/                  auth (scrypt) · errores · validar
  repositorios/         reportes.ts (SQL + GeoJSON)
  rutas/                reportes · recursos · tablero · campo · sesion · salud
  servicios/            prioridad · triage · ruteo · ia/{proveedores,extractor,imagen,cliente}
  trabajadores/         colas.ts (BullMQ) · index.ts (proceso aparte)
apps/api/test/          ayudas.ts + 4 archivos de prueba (59 pruebas)
apps/web/src/
  lib/                  bd.ts (IndexedDB) · bandeja.ts (sincronización) · api.ts · geo.ts · imagen.ts
  paginas/              Reportar.tsx · Campo.tsx · Tablero.tsx
  componentes/          Mapa.tsx · Acceso.tsx
  App.tsx, main.tsx, estilos.css
apps/web/public/        sw.js · manifest.webmanifest · icono.svg
docs/                   prioridad · offline · ia-local · campo · despliegue-gratuito · HANDOFF
scripts/                esperar-bd.mjs
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

Medios en disco (`ALMACEN_MEDIOS`), repartidos en subdirectorios por los dos
primeros bytes del SHA-256, con deduplicación por `(reporte_id, sha256)`.

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

### Tablas (9 de dominio + control)

| Tabla | Propósito | Notas clave |
|---|---|---|
| `organizaciones` | entidades que atienden | nombre único (lower) |
| `usuarios` | personal y ciudadanos | `hash_clave` NULL para ciudadanos; `ultima_posicion` + `posicion_en` (007) |
| `lugares` | geografía administrativa | jerárquica (`padre_id`), `geom` MultiPolygon, `centroide` GENERATED |
| `recursos` | capacidad con ubicación | `movil` para ambulancias/equipos; capacidad total/usada |
| `reportes` | **tabla central**, 33 columnas | ver abajo |
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
- CHECKs: conteos no negativos, `DUPLICADO` exige `duplicado_de_id`, `RESUELTO`
  exige `resuelto_en`, `responsable_id` exige `tomado_en`.

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

34 endpoints. **Auth**: `—` abierto · `OP` exige `puedeOperar` (OPERADOR /
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
| GET | `/v1/campo/personal` | personal con posición conocida + antigüedad del dato. 🟡 **sin consumidor** |

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
| Filtros por KPI (10 mosaicos, lista + mapa a la vez) | ✅ con prueba de correspondencia |
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
| Posición del personal en campo | ✅ escritura / 🟡 lectura sin UI |
| Extracción de texto libre (Ollama) | ✅ medida |
| 6 candados sobre lo que la IA puede escribir | ✅ 11 pruebas |
| Etiquetado de fotos | 🟡 sin ejecutar |
| Cola BullMQ para IA | 🟡 el trabajador arranca; no se vio procesar un trabajo de triage |

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

### Validación manual con Zod, no el proveedor de tipos de Fastify

Para no acoplar todas las rutas a la compatibilidad entre dos dependencias que
suben de major por separado.

---

## 9. PROBLEMAS CONOCIDOS

### Deuda técnica con impacto real

1. **El bundle de la PWA es un solo trozo de 1 303 kB (364 kB gzip).** Casi todo
   es MapLibre (1.1 MB sin minificar), que la vista **Reportar** —la del
   ciudadano— no usa. En la red degradada que justifica todo el diseño
   offline-first, eso son decenas de segundos antes de poder llenar un formulario.
   **Es el defecto más grave del camino principal.**
2. **`GET /v1/campo/personal` no tiene consumidor.** Código muerto: o se muestra
   en el tablero o se quita.
3. **Asignaciones estancadas.** Un caso `ASIGNADO` al que el equipo nunca llegó no
   vuelve a subir en la cola, porque el término de espera se apaga con la primera
   respuesta. Necesita su propio término o alerta; documentado en
   `prioridad.md`.

### Limitaciones aceptadas (documentadas)

- **OSRM demo y teselas de OSM**: ninguna permite tráfico de producción.
- **El service worker sincroniza solo el texto**, no las fotos (multipart desde el
  SW suma complejidad; el reporte es lo que ordena un rescate).
- **`v_cola_prioridad_vivo` y `?vivo=true`** hacen una llamada a función por fila.
  Exactos pero O(n); usar con filtros o volúmenes acotados.
- **La geografía es de prueba** (un municipio, dos barrios de Bogotá).
- **Medios en disco efímero**: se pierden en cada redespliegue.

### Sin verificar (⚠️)

- El trabajador `triage-ia` procesando un trabajo real de la cola.
- Background Sync con la pestaña cerrada.
- Etiquetado de fotos (falta modelo con visión).
- Proveedores `compatible` y `anthropic`.
- Cualquier cosa con concurrencia real (varios rescatistas simultáneos en
  producción); el candado está probado con dos usuarios en la suite.

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

Cuatro commits, todos en `origin/main`:

| Commit | Contenido |
|---|---|
| `11073f2` | base completa: PostGIS, API, PWA offline-first, tablero (68 archivos) |
| `854738d` | extracción con Ollama, capa de proveedores, guardas medidas (15 archivos) |
| `3ceaaca` | atención en campo, ruta con vías bloqueadas, filtros por KPI (19 archivos) |
| `efa74d8` | **último**: pantalla de login propia y sesión solo desde «Atender» (6 archivos) |

### Detalle del último commit (`efa74d8`)

**Motivo:** el login era feo (dos campos con placeholder en una cajita) y estaba
duplicado en el tablero.

**Archivos modificados:**

- `apps/web/src/componentes/Acceso.tsx` — reescrito. Etiquetas `<label>` visibles
  en vez de placeholders, botón mostrar/ocultar clave, error en bloque con
  `role="alert"`, tarjeta centrada con ícono y descripción. Se **eliminó** la
  variante `compacto` (quedó sin uso al sacar el login del tablero). Panel de
  cuentas de prueba con autollenado, dentro de `import.meta.env.DEV`.
- `apps/web/src/paginas/Tablero.tsx` — se quitó `<Acceso>`; `autenticado` pasó de
  estado a `tieneSesion()` en render; nueva prop `onIrACampo`; aviso «modo
  consulta» cuando no hay sesión.
- `apps/web/src/paginas/Campo.tsx` — la pantalla de acceso ocupa la vista
  completa.
- `apps/web/src/App.tsx` — pasa `onIrACampo` al tablero.
- `apps/web/src/estilos.css` — estilos de `.pantalla-acceso`, `.tarjeta-acceso`,
  `.campo-acceso`, `.boton-ver`, `.cuentas-demo`, `.aviso-sesion`; se eliminaron
  los de `.acceso-amplio`.
- `docs/campo.md` — sección sobre dónde se abre la sesión.

**Migraciones:** ninguna en este commit. La última fue `007_campo.sql` en
`3ceaaca` (columnas `usuarios.ultima_posicion/posicion_precision_m/posicion_en`,
`reportes.responsable_id/tomado_en`, índices, trigger `marca_tomado`, vista
`v_casos_campo`).

**Comandos ejecutados:** `npx tsc --noEmit` en ambos paquetes,
`node --test` (suite completa), `npx vite build`.

**Pruebas realizadas y resultados:**

- Suite: **59/59 pasando** (prioridad 11, reportes 20, triage 11, campo 17).
- Typecheck: limpio en `apps/api` y `apps/web`.
- Navegador: autollenado de cuenta demo, mostrar/ocultar clave, clave errada →
  error con `role="alert"`, entrada correcta → pantalla de campo con 9 casos;
  tablero con sesión sin aviso ni login; tablero sin sesión con aviso y botón que
  navega a «Atender».
- Build de producción: se comprobó que las cadenas del panel demo **no** quedan en
  `dist/assets/*.js` (sí en el `.js.map`, por diseño).
- Adicional en esta sesión: se verificó por primera vez que
  `npm run trabajadores` arranca y que el refresco periódico funciona
  (`{refrescados: 10}`).

---

## 11. SIGUIENTE PASO

**Partir el bundle de la PWA para que la vista «Reportar» no cargue MapLibre.**

Por qué esto y no otra cosa: el ciudadano en red degradada es el usuario
principal y el caso de uso que justifica toda la arquitectura offline-first. Hoy
descarga **364 kB comprimidos** antes de poder escribir una línea, y la mayor
parte es una librería de mapas que su pantalla no usa. Es el único defecto que
contradice la premisa central del proyecto.

Cómo, concretamente:

1. En `apps/web/src/paginas/Tablero.tsx`, cargar el mapa con
   `React.lazy(() => import('../componentes/Mapa.tsx'))` y envolverlo en
   `<Suspense>` con un marcador de posición.
2. `apps/web/src/componentes/Mapa.tsx` importa `maplibre-gl` y su CSS; al quedar
   detrás de un `import()` dinámico, Rollup lo saca a su propio trozo.
3. Verificar con `npx vite build` que aparecen al menos dos entradas en
   `dist/assets/` y que el trozo de entrada baja de ~100 kB gzip.
4. Confirmar en el navegador que el tablero sigue funcionando (el mapa tarda un
   instante más en aparecer) y que `?vista=reportar` ya no pide el trozo del mapa
   — se ve en `read_network_requests`.

**Segundo paso, inmediatamente después:** decidir qué hacer con
`GET /v1/campo/personal`. O se dibuja el personal en el mapa del tablero (el
endpoint ya devuelve `lat`, `lng`, `antiguedad_s` y `casos_abiertos`, y hay que
mostrar la antigüedad porque una posición de hace dos horas es engañosa), o se
elimina el endpoint. Dejarlo como está es código muerto.

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
npm run probar           # 59 pruebas contra emergencias_test
npm run tipos            # tsc --noEmit en ambos paquetes
```

### Utilidades

```bash
# fijar la clave de un operador
npm run clave --workspace=@emergencias/api -- correo@ejemplo.co clave-larga

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

---

## CHECKPOINT

**Estado actual en una frase.** MVP funcional de punta a punta —reporte ciudadano
offline-first, priorización auditable, triage con IA local, atención en campo con
ruta y obstáculos, tablero con filtros— con 59 pruebas pasando y 4 commits en
`origin/main`.

**Último cambio realizado.** Commit `efa74d8`: pantalla de login rediseñada
(etiquetas visibles, mostrar/ocultar clave, panel de cuentas demo solo en
desarrollo) y sesión iniciable **únicamente** desde la vista «Atender»; el tablero
quedó en modo consulta con un aviso que remite allá.

**Próxima tarea exacta.** Partir el bundle de la PWA: cargar
`componentes/Mapa.tsx` con `React.lazy` + `<Suspense>` desde
`paginas/Tablero.tsx`, para que la vista «Reportar» deje de descargar MapLibre.
Hoy el bundle es un solo trozo de **1 303 kB (364 kB gzip)**. Verificar con
`npx vite build` que se generan trozos separados y con `read_network_requests`
que `?vista=reportar` no pide el del mapa.

**Archivos relevantes para esa tarea.**
`apps/web/src/paginas/Tablero.tsx` · `apps/web/src/componentes/Mapa.tsx` ·
`apps/web/vite.config.ts`

**Bloqueos actuales.** Ninguno técnico. Dos cosas requieren decisión o insumo de
Cristian, no de quien programa:

- Etiquetado de fotos: falta bajar un modelo con visión
  (`ollama pull gemma3:4b`, ~3.3 GB).
- Producción: hace falta decidir proveedor de teselas y de ruteo, porque los
  actuales (OSM y OSRM demo) no permiten tráfico de producción.

**Servicios que quedaron corriendo en esta sesión** (por si hay que reusarlos o
bajarlos): contenedores `emergencias_postgres` (5434) y `emergencias_redis`
(6381); API en 3010; Vite en 5180. Bajar con `docker compose down` y Ctrl+C.
