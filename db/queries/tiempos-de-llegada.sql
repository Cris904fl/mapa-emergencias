-- ---------------------------------------------------------------------------
-- Tiempos de llegada al sitio · para calibrar el umbral de «asignados sin
-- llegada» (filtro `estancados` en apps/api/src/esquemas/filtros.ts)
-- ---------------------------------------------------------------------------
-- Ejecutar con:
--   docker exec -i emergencias_postgres psql -U emergencias -d emergencias \
--     < db/queries/tiempos-de-llegada.sql
--
-- Lo que hay que mirar antes que cualquier percentil es la COBERTURA: si la
-- mayoría de los casos cerrados no tiene hora de llegada, los percentiles se
-- calculan sobre los pocos que sí la anotaron, que no son una muestra al azar
-- —es más probable que la anote quien tuvo un turno tranquilo—. Con cobertura
-- baja, el número correcto que reportar es «todavía no se puede calibrar».
--
-- Y hay que mirar MARCADA y DECLARADA por separado. La primera se midió al
-- llegar; la segunda es un recuerdo escrito al cerrar y tiende a redondearse a
-- números cómodos. Sirven las dos, pero no valen lo mismo.

\pset border 2
\echo '=== 1. Cobertura: ¿de cuántos casos sabemos la hora de llegada? ==='

SELECT count(*) FILTER (WHERE primera_respuesta_en IS NOT NULL)          AS asignados_alguna_vez,
       count(*) FILTER (WHERE llegada_en IS NOT NULL)                    AS con_hora_de_llegada,
       count(*) FILTER (WHERE llegada_origen = 'MARCADA')                AS marcadas,
       count(*) FILTER (WHERE llegada_origen = 'DECLARADA')              AS declaradas,
       round(100.0 * count(*) FILTER (WHERE llegada_en IS NOT NULL)
             / nullif(count(*) FILTER (WHERE primera_respuesta_en IS NOT NULL), 0), 1)
                                                                         AS cobertura_pct
  FROM reportes;

\echo ''
\echo '=== 2. Distribución del tiempo de llegada, por procedencia ==='

WITH minutos AS (
  SELECT llegada_origen::text AS origen,
         extract(epoch FROM (llegada_en - primera_respuesta_en)) / 60.0 AS m
    FROM reportes
   WHERE llegada_en IS NOT NULL
     AND primera_respuesta_en IS NOT NULL
     -- Un descartado o un duplicado tiene hora de llegada pero no es una
     -- atención real; contarlo mueve la mediana sin que haya pasado nada.
     AND estado NOT IN ('DUPLICADO', 'DESCARTADO')
)
SELECT origen,
       count(*)                                                          AS casos,
       round(min(m)::numeric, 1)                                         AS min,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY m)::numeric, 1) AS mediana,
       round(percentile_cont(0.9) WITHIN GROUP (ORDER BY m)::numeric, 1) AS p90,
       round(percentile_cont(0.95) WITHIN GROUP (ORDER BY m)::numeric, 1) AS p95,
       round(max(m)::numeric, 1)                                         AS max
  FROM minutos
 GROUP BY ROLLUP (origen)
 ORDER BY origen NULLS LAST;

\echo ''
\echo '=== 3. El número que decide el umbral ==='
\echo 'Qué porcentaje de llegadas legítimas quedaría marcado como estancado'
\echo 'para cada umbral candidato. Un umbral que marca el 30% de los casos'
\echo 'normales no es una alerta, es ruido que se aprende a ignorar.'

WITH minutos AS (
  SELECT extract(epoch FROM (llegada_en - primera_respuesta_en)) / 60.0 AS m
    FROM reportes
   WHERE llegada_en IS NOT NULL
     AND primera_respuesta_en IS NOT NULL
     -- Un descartado o un duplicado tiene hora de llegada pero no es una
     -- atención real; contarlo mueve la mediana sin que haya pasado nada.
     AND estado NOT IN ('DUPLICADO', 'DESCARTADO')
),
umbrales AS (SELECT unnest(ARRAY[15, 30, 45, 60, 90, 120]) AS u)
SELECT u                                                                 AS umbral_min,
       count(*) FILTER (WHERE m > u)                                     AS llegadas_tardias,
       round(100.0 * count(*) FILTER (WHERE m > u) / nullif(count(*), 0), 1)
                                                                         AS falsas_alarmas_pct
  FROM umbrales, minutos
 GROUP BY u
 ORDER BY u;

\echo ''
\echo '=== 4. Casos cerrados sin que nadie anotara la llegada ==='
\echo 'Si esto crece, el problema no es el umbral sino que el dato no se recoge.'

SELECT count(*)                                                          AS cerrados_sin_llegada
  FROM reportes
 WHERE estado = 'RESUELTO'
   AND primera_respuesta_en IS NOT NULL
   AND llegada_en IS NULL;
