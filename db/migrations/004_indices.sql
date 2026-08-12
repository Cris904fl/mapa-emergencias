-- 004 · Índices
--
-- Los espaciales van primero porque son los que hacen viable la aplicación:
-- sin GiST, cada "¿qué hay a 2 km?" es un recorrido secuencial de toda la
-- tabla de reportes, y en una emergencia esa tabla crece rápido.

-- ---------------------------------------------------------------------------
-- Espaciales (GiST). Habilitan ST_DWithin, ST_Intersects y el operador de
-- vecino más cercano <->, que es lo que usa la función de prioridad.
-- ---------------------------------------------------------------------------
CREATE INDEX reportes_geom_gix       ON reportes       USING GIST (geom);
CREATE INDEX recursos_geom_gix       ON recursos       USING GIST (geom);
CREATE INDEX lugares_geom_gix        ON lugares        USING GIST (geom);
CREATE INDEX lugares_centroide_gix   ON lugares        USING GIST (centroide);
CREATE INDEX medios_geom_gix         ON medios_reporte USING GIST (geom) WHERE geom IS NOT NULL;

-- Índice espacial parcial sobre lo que está sin cerrar. Es el que sirve a la
-- consulta más frecuente del tablero — "emergencias abiertas en este
-- encuadre" — y es mucho más pequeño que el índice completo porque los
-- reportes resueltos, duplicados y descartados quedan fuera.
CREATE INDEX reportes_abiertos_geom_gix ON reportes USING GIST (geom)
  WHERE estado NOT IN ('RESUELTO', 'DUPLICADO', 'DESCARTADO');

-- Recursos que efectivamente se pueden despachar. El término de aislamiento
-- de la prioridad hace un KNN contra este subconjunto.
CREATE INDEX recursos_disponibles_geom_gix ON recursos USING GIST (geom)
  WHERE estado = 'DISPONIBLE';

-- ---------------------------------------------------------------------------
-- Cola de trabajo y filtros del tablero
-- ---------------------------------------------------------------------------
CREATE INDEX reportes_cola_ix ON reportes (prioridad_score DESC NULLS LAST, reportado_en)
  WHERE estado NOT IN ('RESUELTO', 'DUPLICADO', 'DESCARTADO');

CREATE INDEX reportes_estado_ix     ON reportes (estado, reportado_en DESC);
CREATE INDEX reportes_categoria_ix  ON reportes (categoria, estado);
CREATE INDEX reportes_lugar_ix      ON reportes (lugar_id) WHERE lugar_id IS NOT NULL;
CREATE INDEX reportes_reportado_ix  ON reportes (reportado_en DESC);
CREATE INDEX reportes_reportante_ix ON reportes (reportante_id) WHERE reportante_id IS NOT NULL;

-- Reportes cuya prioridad quedó obsoleta: el término de espera crece con el
-- reloj, así que el trabajador en segundo plano recorre este índice para
-- decidir qué recalcular.
CREATE INDEX reportes_prioridad_vencida_ix ON reportes (prioridad_calculada_en NULLS FIRST)
  WHERE estado NOT IN ('RESUELTO', 'DUPLICADO', 'DESCARTADO');

-- ---------------------------------------------------------------------------
-- Texto libre
-- ---------------------------------------------------------------------------
-- Trigramas sobre la descripción: sirve tanto para que un operador busque
-- "parque" como para detectar reportes casi idénticos que llegaron por
-- canales distintos.
CREATE INDEX reportes_descripcion_trgm_ix ON reportes
  USING GIN (descripcion gin_trgm_ops)
  WHERE descripcion IS NOT NULL;

-- `unaccent(text)` es STABLE (depende del diccionario cargado), así que
-- Postgres no la acepta en una expresión de índice. Este envoltorio fija el
-- diccionario y se declara IMMUTABLE, que es la forma canónica de resolverlo.
-- Consecuencia a tener presente: si alguien cambia el diccionario `unaccent`,
-- el índice queda desalineado y hay que reindexar.
CREATE OR REPLACE FUNCTION fn_sin_acentos(texto text)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS $$
  SELECT public.unaccent('public.unaccent'::regdictionary, texto);
$$;

CREATE INDEX lugares_nombre_trgm_ix ON lugares
  USING GIN (fn_sin_acentos(nombre) gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- Tablas satélite
-- ---------------------------------------------------------------------------
CREATE INDEX medios_reporte_ix        ON medios_reporte (reporte_id, creado_en);
CREATE INDEX extracciones_reporte_ix  ON extracciones_ia (reporte_id, creado_en DESC);
CREATE INDEX historial_reporte_ix     ON historial_estado_reporte (reporte_id, creado_en DESC);
CREATE INDEX recursos_tipo_estado_ix  ON recursos (tipo, estado);
CREATE INDEX lugares_padre_ix         ON lugares (padre_id) WHERE padre_id IS NOT NULL;
