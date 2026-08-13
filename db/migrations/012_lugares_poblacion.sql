-- ---------------------------------------------------------------------------
-- 012 · Población de cada lugar, y la lectura por habitante
-- ---------------------------------------------------------------------------
--
-- Por qué: once reportes en un municipio de tres mil habitantes y once en Bogotá
-- son el mismo número y significan cosas distintas. El primero es una comunidad
-- entera afectada; el segundo, en una ciudad de siete millones, puede ser una
-- tarde normal. Sin denominador, la cola y el panel de zonas no pueden decir la
-- diferencia, y quien mira el tablero tampoco.
--
-- Esto NO entra en el índice de prioridad. Sería la tentación obvia y está
-- prohibido por la misma razón que las capas de amenaza: el índice tiene cinco
-- términos con pesos que suman 100, y un sexto obliga a repartirlos de nuevo y a
-- volver a medir contra reportes reales. Acá la población es una lectura del
-- consolidado por zona, no una entrada del puntaje: cambia lo que el operador
-- entiende, no el orden en que el sistema atiende.

ALTER TABLE lugares
  ADD COLUMN poblacion      integer,
  ADD COLUMN poblacion_anio smallint;

-- El año va al lado del número y no en un comentario, por lo mismo que
-- `origen_triage` y `llegada_origen` existen: un dato que se va a usar para
-- decidir tiene que decir de dónde salió. La población del censo de 2018 leída
-- en 2026 tiene ocho años, y quien divida por ella merece saberlo sin ir a
-- buscar el script que la cargó.
ALTER TABLE lugares
  ADD CONSTRAINT lugares_poblacion_no_negativa
    CHECK (poblacion IS NULL OR poblacion >= 0),
  ADD CONSTRAINT lugares_poblacion_completa
    CHECK ((poblacion IS NULL) = (poblacion_anio IS NULL));

COMMENT ON COLUMN lugares.poblacion IS
  'Habitantes según la fuente indicada en poblacion_anio. NULL = no se sabe, que es distinto de cero.';

-- ---------------------------------------------------------------------------
-- La vista, con el denominador
-- ---------------------------------------------------------------------------
--
-- Se recrea completa porque CREATE OR REPLACE VIEW no admite quitar ni reordenar
-- columnas, solo agregar al final. Las nuevas van al final a propósito.
--
-- Las dos razones se devuelven como `float8` y no como `numeric`: el driver
-- entrega numeric como texto —igual que bigint— y quien consuma esto lo quiere
-- para ordenar y comparar, no para imprimir. Es la misma razón por la que los
-- conteos llevan `::int`.
CREATE OR REPLACE VIEW v_resumen_por_lugar AS
SELECT
  l.id                AS lugar_id,
  l.nombre            AS lugar,
  l.tipo              AS tipo_lugar,
  l.codigo,
  count(r.id)::int                                      AS reportes_abiertos,
  coalesce(sum(r.personas_afectadas), 0)::int           AS personas_afectadas,
  coalesce(sum(r.personas_atrapadas), 0)::int           AS personas_atrapadas,
  coalesce(sum(r.personas_heridas), 0)::int             AS personas_heridas,
  coalesce(sum(r.personas_vulnerables), 0)::int         AS personas_vulnerables,
  (count(*) FILTER (WHERE r.requiere_rescate))::int     AS con_rescate_pendiente,
  (count(*) FILTER (WHERE r.severidad = 'CRITICA'))::int AS criticos,
  max(r.prioridad_score)                             AS prioridad_maxima,
  min(r.reportado_en)                                AS reporte_mas_antiguo,
  ST_Y(l.centroide::geometry)                        AS lat,
  ST_X(l.centroide::geometry)                        AS lng,

  l.poblacion,
  l.poblacion_anio,

  -- Reportes por cada diez mil habitantes. Sirve incluso cuando nadie llenó los
  -- conteos de personas, que es el caso frecuente: un reporte existe siempre.
  (count(r.id) * 10000.0 / nullif(l.poblacion, 0))::float8   AS reportes_por_diez_mil,

  -- Afectados por cada mil habitantes: qué proporción de la comunidad está
  -- pidiendo ayuda. Es la cifra que distingue «hubo un accidente» de «este
  -- pueblo se quedó sin nada», y queda en NULL cuando no hay población conocida
  -- o cuando nadie reportó cuántos son.
  (coalesce(sum(r.personas_afectadas), 0) * 1000.0 / nullif(l.poblacion, 0))::float8
                                                     AS afectados_por_mil
FROM lugares l
LEFT JOIN reportes r
       ON r.lugar_id = l.id
      AND r.estado NOT IN ('RESUELTO', 'DUPLICADO', 'DESCARTADO')
GROUP BY l.id, l.nombre, l.tipo, l.codigo, l.centroide, l.poblacion, l.poblacion_anio;
