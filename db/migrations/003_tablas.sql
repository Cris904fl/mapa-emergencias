-- 003 · Tablas núcleo
--
-- Todas las columnas espaciales son `geography(...,4326)` y no `geometry`:
-- las consultas de esta aplicación son de distancia real en metros sobre
-- territorio colombiano (¿qué hospital está a menos de 2 km?), y con geography
-- ST_Distance / ST_DWithin devuelven metros sobre el elipsoide sin tener que
-- reproyectar a un CRS métrico por región. El costo es que unas pocas
-- funciones solo existen para geometry; ahí se hace `geom::geometry` explícito.

-- ---------------------------------------------------------------------------
-- organizaciones
-- ---------------------------------------------------------------------------
CREATE TABLE organizaciones (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre            text NOT NULL,
  tipo              tipo_organizacion NOT NULL,
  sigla             text,
  telefono_contacto text,
  correo_contacto   citext,
  activa            boolean NOT NULL DEFAULT true,
  creado_en         timestamptz NOT NULL DEFAULT now(),
  actualizado_en    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT organizaciones_nombre_no_vacio CHECK (length(btrim(nombre)) > 0)
);

CREATE UNIQUE INDEX organizaciones_nombre_uk ON organizaciones (lower(nombre));

-- ---------------------------------------------------------------------------
-- usuarios
-- ---------------------------------------------------------------------------
-- `hash_clave` es NULL para ciudadanos: reportar no exige cuenta. En una
-- emergencia obligar a registrarse es perder reportes.
CREATE TABLE usuarios (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizacion_id uuid REFERENCES organizaciones (id) ON DELETE SET NULL,
  rol             rol_usuario NOT NULL DEFAULT 'CIUDADANO',
  nombre          text,
  telefono        text,
  correo          citext,
  hash_clave      text,
  activo          boolean NOT NULL DEFAULT true,
  visto_en        timestamptz,
  creado_en       timestamptz NOT NULL DEFAULT now(),
  actualizado_en  timestamptz NOT NULL DEFAULT now(),

  -- Quien hace triage o atiende necesita credenciales y organización.
  CONSTRAINT usuarios_operador_con_clave CHECK (
    rol = 'CIUDADANO' OR hash_clave IS NOT NULL
  ),
  CONSTRAINT usuarios_operador_con_organizacion CHECK (
    rol = 'CIUDADANO' OR organizacion_id IS NOT NULL
  )
);

CREATE UNIQUE INDEX usuarios_telefono_uk ON usuarios (telefono) WHERE telefono IS NOT NULL;
CREATE UNIQUE INDEX usuarios_correo_uk   ON usuarios (correo)   WHERE correo IS NOT NULL;

-- ---------------------------------------------------------------------------
-- lugares · geografía administrativa
-- ---------------------------------------------------------------------------
-- Sirve para agregar reportes por zona ("¿qué barrio concentra más afectados?")
-- sin que el cliente tenga que saber en qué barrio está. Un trigger resuelve
-- `lugar_id` de cada reporte por contención espacial (ver 006).
CREATE TABLE lugares (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  padre_id       uuid REFERENCES lugares (id) ON DELETE SET NULL,
  tipo           tipo_lugar NOT NULL,
  nombre         text NOT NULL,
  codigo         text,               -- DIVIPOLA cuando aplica
  geom           geography(MultiPolygon, 4326) NOT NULL,
  -- ST_Centroid solo existe para geometry; el ida y vuelta es inmutable, así
  -- que la columna puede ser GENERATED y no necesita trigger.
  centroide      geography(Point, 4326)
                 GENERATED ALWAYS AS (ST_Centroid(geom::geometry)::geography) STORED,
  creado_en      timestamptz NOT NULL DEFAULT now(),
  actualizado_en timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT lugares_sin_ciclo CHECK (padre_id IS NULL OR padre_id <> id)
);

CREATE UNIQUE INDEX lugares_codigo_uk ON lugares (codigo) WHERE codigo IS NOT NULL;

-- ---------------------------------------------------------------------------
-- recursos · capacidad de respuesta con ubicación
-- ---------------------------------------------------------------------------
CREATE TABLE recursos (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizacion_id  uuid REFERENCES organizaciones (id) ON DELETE SET NULL,
  tipo             tipo_recurso NOT NULL,
  nombre           text NOT NULL,
  estado           estado_recurso NOT NULL DEFAULT 'DISPONIBLE',
  geom             geography(Point, 4326) NOT NULL,
  -- Una ambulancia o un equipo de rescate se mueven: su geom es la última
  -- posición conocida, no un dato maestro. `movil` avisa a quien consulta
  -- que debe mirar `actualizado_en` antes de confiar en la distancia.
  movil            boolean NOT NULL DEFAULT false,
  capacidad_total  integer,
  capacidad_usada  integer NOT NULL DEFAULT 0,
  telefono         text,
  notas            text,
  creado_en        timestamptz NOT NULL DEFAULT now(),
  actualizado_en   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT recursos_capacidad_valida CHECK (
    capacidad_total IS NULL OR (capacidad_total >= 0 AND capacidad_usada <= capacidad_total)
  ),
  CONSTRAINT recursos_capacidad_usada_no_negativa CHECK (capacidad_usada >= 0)
);

-- ---------------------------------------------------------------------------
-- reportes · el corazón del sistema
-- ---------------------------------------------------------------------------
CREATE TABLE reportes (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Código corto y legible para dar por radio o teléfono: "RPT-7F3K2".
  -- Un socorrista no dicta un UUID.
  codigo_publico        text NOT NULL,

  -- Clave de idempotencia generada en el cliente (crypto.randomUUID()).
  -- Es la pieza que hace posible el modo sin conexión: la PWA puede reintentar
  -- el envío tantas veces como quiera y el servidor no duplica el reporte.
  id_cliente            uuid NOT NULL,

  reportante_id         uuid REFERENCES usuarios (id) ON DELETE SET NULL,
  -- Contacto libre (celular, radio, nombre de un vecino) para reportes
  -- anónimos. No se exige.
  contacto_reportante   text,

  categoria             categoria_reporte NOT NULL,
  severidad             severidad_reporte NOT NULL DEFAULT 'DESCONOCIDA',
  estado                estado_reporte NOT NULL DEFAULT 'RECIBIDO',

  -- Texto tal como lo escribió la persona. Nunca se sobreescribe: es la
  -- evidencia contra la que se audita cualquier extracción automática.
  descripcion           text,

  geom                  geography(Point, 4326) NOT NULL,
  precision_ubicacion_m numeric(8, 1),   -- del GPS del dispositivo
  lugar_id              uuid REFERENCES lugares (id) ON DELETE SET NULL,

  personas_afectadas    integer NOT NULL DEFAULT 0,
  personas_atrapadas    integer NOT NULL DEFAULT 0,
  personas_heridas      integer NOT NULL DEFAULT 0,
  personas_fallecidas   integer NOT NULL DEFAULT 0,
  -- Menores, adultos mayores, personas con discapacidad, gestantes: el conteo
  -- agregado alcanza para priorizar sin volver el formulario un censo.
  personas_vulnerables  integer NOT NULL DEFAULT 0,
  requiere_rescate      boolean NOT NULL DEFAULT false,

  -- De dónde salieron los conteos y la severidad de arriba. Arranca en
  -- CIUDADANO, la IA puede pasarlo a IA, y en el momento en que una persona
  -- toca el reporte queda en OPERADOR y la IA ya no lo vuelve a pisar.
  origen_triage         origen_dato NOT NULL DEFAULT 'CIUDADANO',

  -- Momento del hecho según el cliente. Distinto de `creado_en` (recepción en
  -- el servidor): con sincronización diferida pueden separarse horas, y el
  -- tiempo de espera se mide desde que la persona reportó, no desde que
  -- volvió la señal.
  reportado_en          timestamptz NOT NULL DEFAULT now(),
  creado_en             timestamptz NOT NULL DEFAULT now(),
  actualizado_en        timestamptz NOT NULL DEFAULT now(),
  primera_respuesta_en  timestamptz,
  resuelto_en           timestamptz,

  organizacion_asignada_id uuid REFERENCES organizaciones (id) ON DELETE SET NULL,
  recurso_asignado_id      uuid REFERENCES recursos (id) ON DELETE SET NULL,
  duplicado_de_id          uuid REFERENCES reportes (id) ON DELETE SET NULL,

  -- Prioridad materializada por el trabajador en segundo plano. Existe para
  -- poder ordenar con índice; la vista v_cola_prioridad_vivo la recalcula al
  -- vuelo cuando importa la exactitud. `componentes` guarda el desglose para
  -- que un operador pueda ver POR QUÉ un reporte está arriba en la cola.
  prioridad_score       numeric(6, 2),
  prioridad_componentes jsonb,
  prioridad_version     integer,
  prioridad_calculada_en timestamptz,

  CONSTRAINT reportes_conteos_no_negativos CHECK (
    personas_afectadas   >= 0 AND
    personas_atrapadas   >= 0 AND
    personas_heridas     >= 0 AND
    personas_fallecidas  >= 0 AND
    personas_vulnerables >= 0
  ),
  CONSTRAINT reportes_duplicado_no_es_si_mismo CHECK (
    duplicado_de_id IS NULL OR duplicado_de_id <> id
  ),
  -- Marcar DUPLICADO sin decir de qué deja el dato inutilizable para deduplicar.
  CONSTRAINT reportes_duplicado_con_referencia CHECK (
    estado <> 'DUPLICADO' OR duplicado_de_id IS NOT NULL
  ),
  CONSTRAINT reportes_resuelto_con_fecha CHECK (
    estado <> 'RESUELTO' OR resuelto_en IS NOT NULL
  ),
  CONSTRAINT reportes_precision_positiva CHECK (
    precision_ubicacion_m IS NULL OR precision_ubicacion_m >= 0
  )
);

CREATE UNIQUE INDEX reportes_id_cliente_uk     ON reportes (id_cliente);
CREATE UNIQUE INDEX reportes_codigo_publico_uk ON reportes (codigo_publico);

-- ---------------------------------------------------------------------------
-- medios_reporte · fotos, video, audio
-- ---------------------------------------------------------------------------
CREATE TABLE medios_reporte (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporte_id    uuid NOT NULL REFERENCES reportes (id) ON DELETE CASCADE,
  tipo          tipo_medio NOT NULL,

  -- Ruta en el almacén de objetos. En desarrollo es un archivo local; en
  -- producción una llave de S3/MinIO. El esquema no cambia.
  llave_almacen text NOT NULL,
  tipo_mime     text NOT NULL,
  bytes         bigint NOT NULL,
  ancho         integer,
  alto          integer,
  -- Deduplicación: la misma foto reenviada tras recuperar señal no se
  -- almacena dos veces, y varios reportes del mismo evento pueden compartir
  -- evidencia.
  sha256        text NOT NULL,

  capturado_en  timestamptz,
  geom          geography(Point, 4326),   -- de los datos EXIF, si vienen

  -- Señales preliminares de un modelo multimodal. Va aparte de los campos
  -- canónicos del reporte a propósito: es información auxiliar, no un
  -- diagnóstico estructural. Nada en la priorización lee esta columna.
  etiquetas_ia  jsonb,
  modelo_ia     text,
  analizado_en  timestamptz,

  creado_en     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT medios_bytes_positivos CHECK (bytes > 0),
  CONSTRAINT medios_sha256_valido   CHECK (sha256 ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX medios_reporte_sha_uk ON medios_reporte (reporte_id, sha256);

-- ---------------------------------------------------------------------------
-- extracciones_ia · lo que el modelo propuso, sin mezclarlo con lo canónico
-- ---------------------------------------------------------------------------
-- Guardar acá la salida cruda permite reprocesar con otro modelo, medir
-- precisión contra las correcciones de los operadores, y explicar una decisión
-- meses después.
CREATE TABLE extracciones_ia (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporte_id        uuid NOT NULL REFERENCES reportes (id) ON DELETE CASCADE,
  modelo            text NOT NULL,
  version_prompt    text NOT NULL,
  -- Objeto estructurado que devolvió el modelo, verbatim.
  propuesta         jsonb NOT NULL,
  -- Justificación breve en lenguaje natural, para que el operador la lea.
  justificacion     text,
  -- ¿Se promovió a los campos canónicos del reporte?
  aplicada          boolean NOT NULL DEFAULT false,
  aplicada_en       timestamptz,
  tokens_entrada    integer,
  tokens_salida     integer,
  latencia_ms       integer,
  creado_en         timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- historial_estado_reporte · bitácora de triage
-- ---------------------------------------------------------------------------
-- Se llena por trigger (006), no desde la aplicación: así ningún camino de
-- código puede cambiar un estado sin dejar rastro.
CREATE TABLE historial_estado_reporte (
  id              bigserial PRIMARY KEY,
  reporte_id      uuid NOT NULL REFERENCES reportes (id) ON DELETE CASCADE,
  estado_anterior estado_reporte,
  estado_nuevo    estado_reporte NOT NULL,
  cambiado_por    uuid REFERENCES usuarios (id) ON DELETE SET NULL,
  organizacion_id uuid REFERENCES organizaciones (id) ON DELETE SET NULL,
  nota            text,
  creado_en       timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- pesos_prioridad · la fórmula, versionada y editable sin desplegar
-- ---------------------------------------------------------------------------
-- Los pesos viven en datos y no en el código de la función porque durante una
-- emergencia real se ajustan: si el cuello de botella es transporte, sube
-- `peso_aislamiento`; si hay riesgo de colapso, sube `peso_severidad`. Cada
-- ajuste es una fila nueva, y cada reporte guarda con qué versión se calculó.
CREATE TABLE pesos_prioridad (
  version               integer PRIMARY KEY,
  descripcion           text NOT NULL,

  peso_personas         numeric(5, 2) NOT NULL,
  peso_severidad        numeric(5, 2) NOT NULL,
  peso_aislamiento      numeric(5, 2) NOT NULL,
  peso_concentracion    numeric(5, 2) NOT NULL,
  peso_espera           numeric(5, 2) NOT NULL,

  -- Puntos de saturación: valor a partir del cual el término normalizado
  -- vale 1. Son la parte que hace comparable un conteo de personas con una
  -- distancia en metros.
  personas_saturacion   numeric(6, 2) NOT NULL DEFAULT 30,
  distancia_saturacion_m numeric(9, 1) NOT NULL DEFAULT 5000,
  radio_concentracion_m numeric(9, 1) NOT NULL DEFAULT 300,
  vecinos_saturacion    integer       NOT NULL DEFAULT 10,
  horas_saturacion      numeric(6, 2) NOT NULL DEFAULT 12,

  activa                boolean NOT NULL DEFAULT false,
  creado_en             timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT pesos_suman_cien CHECK (
    peso_personas + peso_severidad + peso_aislamiento
      + peso_concentracion + peso_espera = 100
  ),
  CONSTRAINT pesos_no_negativos CHECK (
    peso_personas      >= 0 AND
    peso_severidad     >= 0 AND
    peso_aislamiento   >= 0 AND
    peso_concentracion >= 0 AND
    peso_espera        >= 0
  ),
  CONSTRAINT pesos_saturaciones_positivas CHECK (
    personas_saturacion    > 0 AND
    distancia_saturacion_m > 0 AND
    radio_concentracion_m  > 0 AND
    vecinos_saturacion     > 0 AND
    horas_saturacion       > 0
  )
);

-- Solo una versión activa a la vez.
CREATE UNIQUE INDEX pesos_prioridad_activa_uk ON pesos_prioridad (activa) WHERE activa;

INSERT INTO pesos_prioridad (
  version, descripcion,
  peso_personas, peso_severidad, peso_aislamiento, peso_concentracion, peso_espera,
  activa
) VALUES (
  1,
  'Línea base: la vida humana domina, el aislamiento y la espera desempatan.',
  35, 25, 15, 10, 15,
  true
);
