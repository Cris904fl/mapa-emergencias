# Mapa inteligente de afectaciones

Sistema de reporte y priorización de emergencias: un ciudadano reporta desde el
celular (funciona sin señal), PostGIS responde las preguntas geoespaciales, y un
índice de prioridad auditable ordena la cola de atención de una sala de crisis.

```
Ciudadano → PWA (offline-first) → API Fastify → PostgreSQL + PostGIS
                                       ↓                ↓
                                  Cola BullMQ      índice de prioridad
                                       ↓                ↓
                                 extracción IA  →  Tablero GIS
```

## Qué hay funcionando

| Pieza | Estado |
|---|---|
| Esquema PostGIS (7 tablas + tipos, índices GiST, triggers) | Verificado contra PostGIS 3.5 |
| Índice de prioridad con pesos versionados y desglose explicable | 11 pruebas |
| API Fastify (reportes, recursos, tablero, sesión, medios) | 20 pruebas |
| PWA offline-first (IndexedDB + service worker + Background Sync) | Verificada en navegador |
| Tablero GIS (MapLibre, DBSCAN, zonas, cola priorizada) | Verificado en navegador |
| Extracción de texto libre con Ollama (modelo local, gratis) | Medida y calibrada — [`docs/ia-local.md`](docs/ia-local.md) |
| Los mismos prompts sobre Groq/OpenRouter o Anthropic | Escrito, sin medir |
| Etiquetado multimodal de fotos | Escrito, sin medir (requiere modelo con visión) |

La extracción con Ollama sí se ejecutó de punta a punta y se calibró contra casos
reales: tres iteraciones de esquema y prompt, con las mediciones y los fallos
documentados. La IA es opcional en todo caso — con `IA_PROVEEDOR=ninguno` los
reportes se aceptan igual y quedan con `origen_triage = 'CIUDADANO'`.

## Arrancar

Requisitos: Node 22+ (probado en 24), Docker. Opcional: [Ollama](https://ollama.com)
para la extracción de texto libre.

```bash
cp .env.example .env
npm install
npm run bd:arriba      # PostGIS en 5434, Redis en 6381
npm run bd:migrar
npm run bd:sembrar     # datos de prueba sobre coordenadas de Bogotá
ollama pull qwen2.5    # opcional, 4.4 GB
```

Tres procesos, en terminales aparte:

```bash
npm run dev:api        # http://localhost:3010
npm run dev:web        # http://localhost:5180
npm run trabajadores --workspace=@emergencias/api
```

Los puertos 5434 y 6381 se eligieron porque 5432/5433/5435 y 6380 ya están
ocupados en esta máquina por otros proyectos.

Credenciales de prueba del tablero: `operadora@demo.local` / `demo1234`.

## Pruebas

```bash
npm run probar --workspace=@emergencias/api
```

Corren contra `emergencias_test`, una base separada que la suite crea sola. Hay
una salvaguarda que aborta si `DATABASE_URL` no apunta a una base cuyo nombre
termine en `_test`: la suite hace `TRUNCATE`.

## Decisiones que vale la pena conocer

### El índice de prioridad no es la suma de la idea original

La formulación de partida era sumar términos directamente:

```
prioridad = personas + gravedad + distancia_a_recursos + concentración + espera
```

Eso no funciona por dos razones. La primera es que `distancia_a_recursos` en
crudo **premia estar cerca de la ayuda**, que es al revés: quien está lejos
tarda más en ser alcanzado. La segunda es que las unidades no son comparables —
"23 personas" y "1200 metros" no se suman, y el metro dominaría por magnitud.

La implementación normaliza cada término a 0..1 contra un punto de saturación
explícito y lo pondera con pesos que suman 100. Detalle completo en
[`docs/prioridad.md`](docs/prioridad.md).

Los pesos viven en la tabla `pesos_prioridad`, no en el código: durante una
emergencia real se ajustan, y cada reporte guarda con qué versión se calculó.

Cada puntaje trae su desglose por término (`prioridad_componentes`), expuesto en
`GET /v1/reportes/:id/prioridad` y desplegable en el tablero. Un número que
ordena rescates sin explicación no es utilizable por alguien que después tiene
que justificar a dónde mandó el equipo.

### La IA estructura texto; no decide a quién se rescata

Seis candados, y el primero está en la base de datos para que ningún camino de
código pueda evadirlo:

1. Si `origen_triage = 'OPERADOR'`, un proceso automático no puede escribir los
   conteos. Lo impide un trigger.
2. Un conteo que el ciudadano escribió en el formulario no se sobreescribe: solo
   se rellenan los campos que quedaron en cero. Quien está en el sitio contando
   es mejor fuente que un modelo leyendo su prosa.
3. `requiere_rescate` solo puede subir a `true`, nunca bajar. Un falso negativo
   ahí significa no mandar un equipo a donde hacía falta.
4. Si el modelo marca `cantidad_indeterminada` —el texto decía «varias personas»
   sin dar cifra— **ninguno** de sus conteos se aplica.
5. **`personas_atrapadas` no se aplica nunca automáticamente**, ni con confianza
   ALTA. Pesa ×3 en el índice de prioridad y es el campo donde el modelo local
   falla de forma reproducible: ante «se nos inundó la casa, somos 4» propuso 4
   atrapadas. La evidencia está en [`docs/ia-local.md`](docs/ia-local.md).
6. Con un modelo local, `IA_APLICAR_AUTOMATICAMENTE=false` por defecto: la
   propuesta se guarda, se muestra en el tablero, y la aplica un operador.

El orden de los campos del esquema de extracción **es funcional**: poner la
justificación primero y las clasificaciones al final subió la precisión de
categoría de 1/4 a 6/7 con el mismo modelo, porque bajo decodificación restringida
el JSON se emite en el orden del esquema y así el modelo razona antes de
comprometerse. Hay una prueba que falla si alguien lo reordena.

Cada propuesta del modelo se guarda completa en `extracciones_ia` incluso cuando
no se aplica, con su justificación y las discrepancias detectadas frente a lo que
dijo el ciudadano. Sirve para auditar, para medir precisión contra las
correcciones humanas, y para reprocesar con otro modelo.

El etiquetado de fotos describe, no dictamina: puede decir "se observan grietas
en un muro", no "riesgo de colapso". Las etiquetas van a una columna
(`medios_reporte.etiquetas_ia`) que **ninguna consulta de priorización lee**.

### Offline-first en serio

El reporte se escribe en IndexedDB **antes** de intentar enviarlo, siempre. El
botón nunca falla por falta de red.

Cuatro capas de reintento, porque ninguna sola es confiable:

1. Intento inmediato al enviar.
2. Evento `online` del navegador.
3. Temporizador cada 30 s — `navigator.onLine` miente con frecuencia: reporta
   conexión cuando hay wifi asociado pero sin salida real, que es exactamente lo
   que pasa con una antena saturada.
4. Background Sync del service worker — la única capa que funciona con la
   pestaña cerrada.

Todas convergen en la misma función y todas son seguras de repetir, porque el
alta en la API es idempotente por `id_cliente` (un UUID que genera el cliente).

Las fotos se reducen a 1568 px en el teléfono antes de guardarlas y se suben
**después** del texto: el reporte pesa un kilobyte y ordena un rescate, la foto
pesa cientos y es complemento.

Limitación conocida: el service worker sincroniza el texto de los reportes, no
las fotos. Subir multipart desde el service worker es posible pero suma
complejidad; las fotos las sube la página en cuanto se abre de nuevo.

### Otras

- **`geography` y no `geometry`** en todas las columnas espaciales: las consultas
  son distancias reales en metros sobre territorio colombiano, y con `geography`
  no hay que reproyectar por región.
- **Las coordenadas se validan contra el rango de Colombia.** Un GPS sin fijar
  reporta (0,0) —el Golfo de Guinea— y un error de signo pone el reporte en
  China; ambos ensuciarían el término de concentración.
- **`severidad = 'DESCONOCIDA'` vale 0.5, no 0.** Cuando el ciudadano no sabe qué
  tan grave es lo suyo, lo correcto es dejarlo a media tabla para que alguien lo
  mire, no enterrarlo.
- **Las personas fallecidas no entran en la carga humana.** Recuperar cuerpos es
  una tarea distinta de rescatar a alguien con vida, y contarlas ahí desviaría
  equipos de vidas salvables. Hay una prueba que falla si alguien lo cambia.
- **La deduplicación es asistida, no automática.** `GET /v1/tablero/posibles-duplicados`
  propone pares por proximidad, categoría, ventana temporal y similitud de texto;
  la decisión es de una persona. Fusionar mal significa dejar de atender a alguien.
- **Sin dependencias nativas.** Contraseñas con `scrypt` de `node:crypto` en lugar
  de bcrypt, y reducción de imágenes en el cliente con canvas en lugar de sharp.
  Una compilación de node-gyp fallando en el servidor de una alcaldía es el tipo
  de problema que no se quiere tener durante una emergencia.
- **TypeScript se ejecuta directo con Node** (borrado de tipos), sin paso de
  compilación. `tsc` solo revisa tipos, con `erasableSyntaxOnly` activado para
  que avise cuando alguien usa sintaxis que Node no puede borrar.

## Estructura

```
db/
  migrations/    001 extensiones · 002 tipos · 003 tablas · 004 índices
                 005 prioridad · 006 triggers
  seeds/         datos de prueba
  queries/       8 consultas PostGIS de referencia, ejecutables
apps/api/
  src/esquemas/     validación con Zod y valores del dominio
  src/repositorios/ SQL y construcción de GeoJSON
  src/servicios/    prioridad, triage, clientes de IA
  src/rutas/        reportes, recursos, tablero, sesión, salud
  src/trabajadores/ colas BullMQ
  test/             31 pruebas
apps/web/
  src/lib/          IndexedDB, sincronización, geolocalización, imágenes
  src/paginas/      formulario ciudadano, tablero
  public/sw.js      service worker
docs/
```

## Consultas PostGIS de referencia

`db/queries/consultas-ejemplo.sql` es ejecutable y responde las preguntas que
justifican tener geoespacial en la base:

```bash
docker cp db emergencias_postgres:/tmp/db
docker exec emergencias_postgres psql -U emergencias -d emergencias \
  -f /tmp/db/queries/consultas-ejemplo.sql
```

Emergencias a menos de 2 km de un hospital · concentraciones por densidad
(DBSCAN) · zonas con más afectados · solicitudes sin atender · los 3 recursos más
cercanos a cada emergencia (KNN con `<->`) · reportes fuera del alcance de todo
recurso · posibles duplicados · ocupación de albergues.

## Documentos de diseño

- [`docs/prioridad.md`](docs/prioridad.md) — el índice de prioridad, por qué la
  fórmula original no funcionaba y cómo se explica cada puntaje.
- [`docs/offline.md`](docs/offline.md) — el modo sin conexión, las cuatro capas de
  reintento y el defecto que apareció al probarlo.
- [`docs/ia-local.md`](docs/ia-local.md) — Ollama, las tres iteraciones medidas
  del prompt, y qué no se le deja escribir al modelo.
- [`docs/despliegue-gratuito.md`](docs/despliegue-gratuito.md) — cómo publicarlo
  sin pagar, y por qué Ollama no cabe en una capa gratuita.

## Pendientes

- Medir el etiquetado de fotos: `qwen2.5` no es multimodal, hace falta bajar
  `gemma3:4b` o similar.
- Medir la calidad de la ruta `compatible` (Groq/OpenRouter) con este prompt antes
  de confiarle la aplicación automática.
- Almacenamiento de medios en S3/MinIO o Supabase Storage (hoy disco local; el
  esquema no cambia).
- Cargar la geografía real de DIVIPOLA en `lugares` (hoy hay polígonos de prueba).
- Un proveedor de teselas propio: el mapa usa OpenStreetMap, cuya política de uso
  no permite tráfico de producción.
- Seguimiento de asignaciones estancadas: un reporte ASIGNADO al que el equipo
  nunca llegó no vuelve a subir en la cola. Necesita su propio término o alerta,
  no reutilizar el de espera.

## Licencia

MIT.
