-- ---------------------------------------------------------------------------
-- 011 · Identificar un recurso por su fuente, no por su nombre
-- ---------------------------------------------------------------------------
-- La migración 009 puso un índice único sobre lower(nombre) para poder recargar
-- la lista de recursos sin duplicar. Con catorce recursos escogidos a mano eso
-- funcionaba. Al intentar cargar los de todo el país se ve por qué está mal:
--
--   42 sitios se llaman solo «Hospital»
--   40 se llaman «Puesto de salud»
--   22 se llaman «Bomberos»
--
-- En total, 665 de 3 374 filas colisionarían — y `ON CONFLICT DO UPDATE` las
-- habría fundido en una sola, **en silencio**. El resultado sería un mapa que
-- dice que no hay ayuda en 41 municipios donde sí la hay, y el término de
-- aislamiento del índice de prioridad calculando sobre eso.
--
-- El nombre no identifica un lugar. Su origen sí: OpenStreetMap da
-- identificadores estables por elemento (`node/240954853`).

ALTER TABLE recursos
  ADD COLUMN fuente    text,
  ADD COLUMN fuente_id text;

COMMENT ON COLUMN recursos.fuente IS
  'De dónde salió el registro: «osm», «manual», o el nombre de la entidad que lo aportó.';
COMMENT ON COLUMN recursos.fuente_id IS
  'Identificador estable dentro de esa fuente. Para OSM, «node/123» o «way/456».';

-- O están los dos o no está ninguno: una fuente sin identificador no permite
-- reconciliar nada en la siguiente carga.
ALTER TABLE recursos
  ADD CONSTRAINT recursos_fuente_completa
  CHECK ((fuente IS NULL) = (fuente_id IS NULL));

-- El índice viejo se va: el nombre nunca fue un identificador válido.
DROP INDEX IF EXISTS recursos_nombre_unico_ix;

-- Lo importado se reconcilia por su origen.
CREATE UNIQUE INDEX recursos_fuente_unica_ix
  ON recursos (fuente, fuente_id)
  WHERE fuente IS NOT NULL;

-- Lo que se escribe a mano no tiene fuente, y ahí el nombre sí sirve: son pocos
-- y los pone una persona que sabe cuáles ya existen.
CREATE UNIQUE INDEX recursos_nombre_manual_unico_ix
  ON recursos (lower(nombre))
  WHERE fuente IS NULL;
