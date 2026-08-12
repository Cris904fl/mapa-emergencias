-- Consultas PostGIS de referencia.
--
-- Cada bloque responde una de las preguntas operativas que justifican tener
-- geoespacial en la base y no solo un par de columnas lat/lng. Sirven como
-- documentación viva y como banco de pruebas manual: se ejecutan enteras
-- contra los datos de db/seeds/001_desarrollo.sql.
--
--   docker exec emergencias_postgres psql -U emergencias -d emergencias \
--     -f /tmp/db/queries/consultas-ejemplo.sql

\echo '=== 1. Emergencias abiertas a menos de 2 km de un hospital ==='
-- ST_DWithin sobre geography mide metros reales sobre el elipsoide y usa el
-- índice GiST. Es preferible a calcular ST_Distance y filtrar después: DWithin
-- puede descartar por caja envolvente antes de calcular la distancia exacta.
SELECT r.codigo_publico,
       r.categoria,
       r.severidad,
       h.nombre                             AS hospital,
       round(ST_Distance(r.geom, h.geom)::numeric, 0) AS metros
  FROM reportes r
  JOIN recursos h
    ON h.tipo IN ('HOSPITAL', 'PUESTO_SALUD')
   AND ST_DWithin(r.geom, h.geom, 2000)
 WHERE r.estado NOT IN ('RESUELTO', 'DUPLICADO', 'DESCARTADO')
 ORDER BY metros;


\echo ''
\echo '=== 2. Dónde se concentran los reportes (agrupamiento DBSCAN) ==='
-- ST_ClusterDBSCAN agrupa por densidad: no hay que decirle cuántos grupos
-- existen, solo el radio y el mínimo de vecinos. Es la herramienta correcta
-- para "¿dónde está pasando algo grande?" — a diferencia de una grilla fija,
-- encuentra el grupo donde efectivamente está, no donde cae la celda.
-- Opera sobre geometry, así que el radio va en grados: 0.0027° ≈ 300 m en
-- latitudes cercanas al ecuador, que es el caso de Colombia.
WITH agrupados AS (
  SELECT id,
         codigo_publico,
         categoria,
         personas_afectadas,
         geom,
         ST_ClusterDBSCAN(geom::geometry, eps := 0.0027, minpoints := 2)
           OVER () AS grupo
    FROM reportes
   WHERE estado NOT IN ('RESUELTO', 'DUPLICADO', 'DESCARTADO')
)
SELECT grupo,
       count(*)                        AS reportes,
       sum(personas_afectadas)         AS personas,
       array_agg(codigo_publico ORDER BY codigo_publico) AS codigos,
       -- Centro del grupo, para poner un marcador agregado en el mapa.
       round(ST_Y(ST_Centroid(ST_Collect(geom::geometry)))::numeric, 6) AS lat,
       round(ST_X(ST_Centroid(ST_Collect(geom::geometry)))::numeric, 6) AS lng,
       -- Radio del grupo en metros: qué tan disperso está el evento.
       round(
         (ST_MaxDistance(ST_Collect(geom::geometry), ST_Collect(geom::geometry))
          * 111320 / 2)::numeric, 0
       ) AS radio_aprox_m
  FROM agrupados
 WHERE grupo IS NOT NULL   -- NULL = punto aislado, sin grupo
 GROUP BY grupo
 ORDER BY personas DESC;


\echo ''
\echo '=== 3. Zonas con más personas afectadas ==='
-- Se apoya en la vista v_resumen_por_lugar, que a su vez se apoya en el
-- lugar_id que resolvió el trigger por contención espacial. El cliente nunca
-- tuvo que saber en qué barrio estaba.
SELECT lugar,
       tipo_lugar,
       reportes_abiertos,
       personas_afectadas,
       personas_atrapadas,
       personas_vulnerables,
       con_rescate_pendiente,
       criticos,
       prioridad_maxima
  FROM v_resumen_por_lugar
 WHERE reportes_abiertos > 0
 ORDER BY personas_afectadas DESC, prioridad_maxima DESC;


\echo ''
\echo '=== 4. Solicitudes sin atender, por antigüedad ==='
-- "Sin atender" es primera_respuesta_en IS NULL, no un estado: un reporte
-- puede estar EN_TRIAGE y seguir sin que nadie se haya hecho cargo en campo.
SELECT codigo_publico,
       categoria,
       severidad,
       estado,
       prioridad_score,
       personas_afectadas,
       date_trunc('minute', now() - reportado_en) AS esperando_hace
  FROM reportes
 WHERE estado NOT IN ('RESUELTO', 'DUPLICADO', 'DESCARTADO')
   AND primera_respuesta_en IS NULL
 ORDER BY reportado_en;


\echo ''
\echo '=== 5. Recursos disponibles cerca de cada emergencia (3 más cercanos) ==='
-- LATERAL + <-> es el patrón de K vecinos más cercanos en PostGIS: el
-- operador <-> ordena por distancia usando el índice GiST, así que el LIMIT 3
-- corta temprano en lugar de calcular la distancia a todos los recursos.
SELECT r.codigo_publico,
       r.categoria,
       cercanos.nombre     AS recurso,
       cercanos.tipo,
       cercanos.distancia_m,
       cercanos.orden
  FROM reportes r
 CROSS JOIN LATERAL (
   SELECT rec.nombre,
          rec.tipo,
          round(ST_Distance(rec.geom, r.geom)::numeric, 0) AS distancia_m,
          row_number() OVER (ORDER BY rec.geom <-> r.geom) AS orden
     FROM recursos rec
    WHERE rec.estado = 'DISPONIBLE'
    ORDER BY rec.geom <-> r.geom
    LIMIT 3
 ) cercanos
 WHERE r.estado NOT IN ('RESUELTO', 'DUPLICADO', 'DESCARTADO')
 ORDER BY r.prioridad_score DESC NULLS LAST, cercanos.orden;


\echo ''
\echo '=== 6. Reportes fuera del alcance de todo recurso disponible (>5 km) ==='
-- El caso que más importa en zona rural dispersa: emergencias que nadie puede
-- alcanzar rápido. Es el término de aislamiento del índice de prioridad,
-- expuesto como lista de trabajo.
SELECT r.codigo_publico,
       r.categoria,
       r.severidad,
       r.personas_afectadas,
       l.nombre AS lugar,
       round(cercano.distancia_m::numeric, 0) AS metros_al_recurso_mas_cercano
  FROM reportes r
  LEFT JOIN lugares l ON l.id = r.lugar_id
  LEFT JOIN LATERAL (
    SELECT ST_Distance(rec.geom, r.geom) AS distancia_m
      FROM recursos rec
     WHERE rec.estado = 'DISPONIBLE'
     ORDER BY rec.geom <-> r.geom
     LIMIT 1
  ) cercano ON true
 WHERE r.estado NOT IN ('RESUELTO', 'DUPLICADO', 'DESCARTADO')
   AND (cercano.distancia_m IS NULL OR cercano.distancia_m > 5000)
 ORDER BY cercano.distancia_m DESC NULLS FIRST;


\echo ''
\echo '=== 7. Posibles duplicados: mismo tipo, cerca, y en ventana de tiempo ==='
-- Deduplicación asistida, no automática: la consulta propone pares y una
-- persona decide. Combina proximidad espacial (150 m), coincidencia de
-- categoría, cercanía temporal (2 horas) y similitud de texto por trigramas.
SELECT a.codigo_publico AS reporte_a,
       b.codigo_publico AS reporte_b,
       a.categoria,
       round(ST_Distance(a.geom, b.geom)::numeric, 0) AS metros,
       abs(extract(epoch FROM (a.reportado_en - b.reportado_en)) / 60)::integer AS minutos_aparte,
       round(similarity(coalesce(a.descripcion, ''), coalesce(b.descripcion, ''))::numeric, 3) AS similitud_texto
  FROM reportes a
  JOIN reportes b
    ON b.id > a.id                     -- cada par una sola vez
   AND b.categoria = a.categoria
   AND ST_DWithin(a.geom, b.geom, 150)
   AND abs(extract(epoch FROM (a.reportado_en - b.reportado_en))) < 7200
 WHERE a.estado NOT IN ('RESUELTO', 'DUPLICADO', 'DESCARTADO')
   AND b.estado NOT IN ('RESUELTO', 'DUPLICADO', 'DESCARTADO')
 ORDER BY metros;


\echo ''
\echo '=== 8. Ocupación de albergues y capacidad restante ==='
SELECT nombre,
       estado,
       capacidad_total,
       capacidad_usada,
       capacidad_total - capacidad_usada AS cupos_libres,
       round(100.0 * capacidad_usada / nullif(capacidad_total, 0), 1) AS porcentaje_ocupado
  FROM recursos
 WHERE tipo = 'ALBERGUE'
 ORDER BY porcentaje_ocupado DESC NULLS LAST;
