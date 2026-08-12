-- 005 · Índice de prioridad geoespacial
--
-- La idea de partida era sumar términos heterogéneos:
--
--     prioridad = personas_en_riesgo + gravedad + distancia_a_recursos
--                 + concentracion + tiempo_sin_atencion
--
-- Sumado así no funciona. Dos problemas concretos:
--
--   1. `distancia_a_recursos` en crudo premia estar CERCA de la ayuda, que es
--      lo contrario de lo que se busca: quien está lejos es quien tarda más en
--      ser alcanzado. El término tiene que invertirse.
--   2. Las unidades no son comparables. "23 personas" y "1200 metros" no se
--      pueden sumar; el metro dominaría el puntaje por pura magnitud.
--
-- Acá cada término se normaliza a 0..1 contra un punto de saturación explícito
-- y se pondera con pesos que suman 100. El resultado es un puntaje 0..100
-- interpretable, y `componentes` guarda el desglose para que un operador pueda
-- ver por qué un reporte está donde está en la cola. Un número que ordena
-- rescates sin explicación no es utilizable.

CREATE OR REPLACE FUNCTION fn_prioridad_reporte(p_reporte_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  w   pesos_prioridad;
  r   reportes;

  v_distancia_m     numeric;
  v_vecinos         integer;
  v_horas_espera    numeric;
  v_carga_humana    numeric;

  n_personas        numeric;
  n_severidad       numeric;
  n_aislamiento     numeric;
  n_concentracion   numeric;
  n_espera          numeric;

  v_score           numeric;
BEGIN
  SELECT * INTO w FROM pesos_prioridad WHERE activa;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No hay una versión activa en pesos_prioridad';
  END IF;

  SELECT * INTO r FROM reportes WHERE id = p_reporte_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- ------------------------------------------------------------------
  -- 1. Carga humana
  -- ------------------------------------------------------------------
  -- Personas fallecidas quedan FUERA a propósito. Recuperar cuerpos es una
  -- tarea distinta de rescatar a alguien con vida, y sumarlas acá desviaría
  -- equipos desde vidas todavía salvables. Se registran en el reporte para
  -- el consolidado de la emergencia, no para ordenar la cola de rescate.
  v_carga_humana :=
      r.personas_atrapadas   * 3.0
    + r.personas_heridas     * 2.0
    + r.personas_afectadas   * 1.0
    + r.personas_vulnerables * 0.5;

  n_personas := least(1.0, v_carga_humana / w.personas_saturacion);

  -- ------------------------------------------------------------------
  -- 2. Gravedad reportada
  -- ------------------------------------------------------------------
  -- DESCONOCIDA vale 0.5, no 0: cuando la persona no sabe qué tan grave es,
  -- lo correcto es dejar el reporte a media tabla para que alguien lo mire,
  -- no enterrarlo al fondo de la cola.
  n_severidad := CASE r.severidad
    WHEN 'CRITICA'     THEN 1.00
    WHEN 'ALTA'        THEN 0.75
    WHEN 'MEDIA'       THEN 0.45
    WHEN 'BAJA'        THEN 0.20
    WHEN 'DESCONOCIDA' THEN 0.50
  END;

  -- ------------------------------------------------------------------
  -- 3. Aislamiento (distancia invertida)
  -- ------------------------------------------------------------------
  -- Distancia en metros al recurso disponible más cercano. El operador <->
  -- usa el índice GiST parcial `recursos_disponibles_geom_gix`, así que esto
  -- es una búsqueda de vecino más cercano, no un recorrido de tabla.
  SELECT ST_Distance(rec.geom, r.geom)
    INTO v_distancia_m
    FROM recursos rec
   WHERE rec.estado = 'DISPONIBLE'
   ORDER BY rec.geom <-> r.geom
   LIMIT 1;

  -- Sin ningún recurso disponible, el aislamiento es total.
  n_aislamiento := CASE
    WHEN v_distancia_m IS NULL THEN 1.0
    ELSE least(1.0, v_distancia_m / w.distancia_saturacion_m)
  END;

  -- ------------------------------------------------------------------
  -- 4. Concentración de reportes
  -- ------------------------------------------------------------------
  -- Muchos reportes abiertos en un radio pequeño indican un evento con
  -- alcance mayor al que describe cualquiera de ellos por separado: un
  -- edificio, una cuadra, un barrio. ST_DWithin sobre geography mide metros
  -- reales y aprovecha el índice.
  SELECT count(*)
    INTO v_vecinos
    FROM reportes otro
   WHERE otro.id <> r.id
     AND otro.estado NOT IN ('RESUELTO', 'DUPLICADO', 'DESCARTADO')
     AND ST_DWithin(otro.geom, r.geom, w.radio_concentracion_m);

  n_concentracion := least(1.0, v_vecinos::numeric / w.vecinos_saturacion);

  -- ------------------------------------------------------------------
  -- 5. Tiempo sin atención
  -- ------------------------------------------------------------------
  -- Se mide desde `reportado_en` (el momento del hecho según el cliente) y no
  -- desde `creado_en`: con sincronización diferida un reporte puede llegar
  -- horas después de haberse creado sin señal, y esas horas cuentan.
  --
  -- Y en el momento en que alguien se hace cargo el término se va a CERO, no
  -- se congela en su último valor. Congelarlo fue el primer intento y está
  -- mal: un reporte asignado hace un rato conservaría para siempre su bono de
  -- doce horas de espera y seguiría desplazando a reportes que nadie ha
  -- mirado todavía. Lo que este término mide es exactamente eso — que nadie lo
  -- ha mirado — así que deja de aplicar cuando ya alguien lo hizo.
  --
  -- Queda un hueco conocido: una asignación que se estanca (ASIGNADO hace
  -- horas y el equipo nunca llegó) no vuelve a subir por esta vía. Ese es un
  -- problema distinto —seguimiento de asignaciones— y merece su propio término
  -- o su propia alerta, no reutilizar este.
  v_horas_espera := CASE
    WHEN r.primera_respuesta_en IS NOT NULL THEN 0.0
    ELSE extract(epoch FROM (now() - r.reportado_en)) / 3600.0
  END;

  n_espera := greatest(0.0, least(1.0, v_horas_espera / w.horas_saturacion));

  -- ------------------------------------------------------------------
  -- Puntaje
  -- ------------------------------------------------------------------
  v_score :=
      w.peso_personas      * n_personas
    + w.peso_severidad     * n_severidad
    + w.peso_aislamiento   * n_aislamiento
    + w.peso_concentracion * n_concentracion
    + w.peso_espera        * n_espera;

  RETURN jsonb_build_object(
    'score',   round(v_score, 2),
    'version', w.version,
    'componentes', jsonb_build_object(
      'personas', jsonb_build_object(
        'crudo', v_carga_humana, 'normalizado', round(n_personas, 4),
        'peso', w.peso_personas, 'aporte', round(w.peso_personas * n_personas, 2)
      ),
      'severidad', jsonb_build_object(
        'crudo', r.severidad::text, 'normalizado', round(n_severidad, 4),
        'peso', w.peso_severidad, 'aporte', round(w.peso_severidad * n_severidad, 2)
      ),
      'aislamiento', jsonb_build_object(
        'crudo', round(coalesce(v_distancia_m, -1), 1), 'normalizado', round(n_aislamiento, 4),
        'peso', w.peso_aislamiento, 'aporte', round(w.peso_aislamiento * n_aislamiento, 2),
        'unidad', 'metros al recurso disponible más cercano (-1 = ninguno)'
      ),
      'concentracion', jsonb_build_object(
        'crudo', v_vecinos, 'normalizado', round(n_concentracion, 4),
        'peso', w.peso_concentracion, 'aporte', round(w.peso_concentracion * n_concentracion, 2),
        'unidad', format('reportes abiertos en %s m', w.radio_concentracion_m)
      ),
      'espera', jsonb_build_object(
        'crudo', round(v_horas_espera, 2), 'normalizado', round(n_espera, 4),
        'peso', w.peso_espera, 'aporte', round(w.peso_espera * n_espera, 2),
        'unidad', 'horas sin atención'
      )
    )
  );
END;
$$;

COMMENT ON FUNCTION fn_prioridad_reporte(uuid) IS
  'Índice de prioridad 0..100 de un reporte, con desglose por término. '
  'Lee los pesos de la versión activa en pesos_prioridad.';

-- ---------------------------------------------------------------------------
-- Materialización
-- ---------------------------------------------------------------------------
-- La prioridad NO puede ser una columna generada: depende del reloj (término
-- de espera) y de los vecinos (término de concentración), así que cambia sin
-- que el reporte se modifique. Se resuelve con dos caminos:
--
--   · fn_refrescar_prioridad + trabajador periódico → columna indexable,
--     que es lo que ordena la cola en el tablero.
--   · v_cola_prioridad_vivo → recálculo al vuelo, para cuando importa la
--     exactitud al segundo y el volumen lo permite.
--
-- El desfase entre ambos es visible en `prioridad_calculada_en`. Preferimos
-- eso a esconder el problema detrás de una única respuesta ambigua.
CREATE OR REPLACE FUNCTION fn_refrescar_prioridad(p_reporte_id uuid)
RETURNS numeric
LANGUAGE plpgsql
AS $$
DECLARE
  v_resultado jsonb;
BEGIN
  v_resultado := fn_prioridad_reporte(p_reporte_id);
  IF v_resultado IS NULL THEN
    RETURN NULL;
  END IF;

  UPDATE reportes
     SET prioridad_score        = (v_resultado->>'score')::numeric,
         prioridad_componentes  = v_resultado->'componentes',
         prioridad_version      = (v_resultado->>'version')::integer,
         prioridad_calculada_en = now()
   WHERE id = p_reporte_id;

  RETURN (v_resultado->>'score')::numeric;
END;
$$;

-- Refresca los reportes abiertos cuya prioridad esté más vieja que el desfase
-- dado. Es lo que invoca el trabajador de BullMQ.
CREATE OR REPLACE FUNCTION fn_refrescar_prioridades_vencidas(
  p_desfase interval DEFAULT interval '5 minutes',
  p_limite  integer  DEFAULT 500
)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_id      uuid;
  v_contado integer := 0;
BEGIN
  FOR v_id IN
    SELECT id
      FROM reportes
     WHERE estado NOT IN ('RESUELTO', 'DUPLICADO', 'DESCARTADO')
       AND (prioridad_calculada_en IS NULL
            OR prioridad_calculada_en < now() - p_desfase)
     ORDER BY prioridad_calculada_en NULLS FIRST
     LIMIT p_limite
  LOOP
    PERFORM fn_refrescar_prioridad(v_id);
    v_contado := v_contado + 1;
  END LOOP;

  RETURN v_contado;
END;
$$;

-- ---------------------------------------------------------------------------
-- Vistas de lectura
-- ---------------------------------------------------------------------------

-- Cola viva: recalcula la prioridad en el momento de consultar.
CREATE OR REPLACE VIEW v_cola_prioridad_vivo AS
SELECT
  r.id,
  r.codigo_publico,
  r.categoria,
  r.severidad,
  r.estado,
  r.descripcion,
  r.personas_afectadas,
  r.personas_atrapadas,
  r.personas_heridas,
  r.personas_vulnerables,
  r.requiere_rescate,
  r.origen_triage,
  r.reportado_en,
  r.primera_respuesta_en,
  l.nombre AS lugar,
  ST_Y(r.geom::geometry) AS lat,
  ST_X(r.geom::geometry) AS lng,
  p.calculo->>'score'          AS score_texto,
  (p.calculo->>'score')::numeric AS score,
  p.calculo->'componentes'     AS componentes
FROM reportes r
LEFT JOIN lugares l ON l.id = r.lugar_id
CROSS JOIN LATERAL (SELECT fn_prioridad_reporte(r.id) AS calculo) p
WHERE r.estado NOT IN ('RESUELTO', 'DUPLICADO', 'DESCARTADO');

COMMENT ON VIEW v_cola_prioridad_vivo IS
  'Cola de atención con prioridad recalculada al consultar. Exacta pero O(n) '
  'en llamadas a la función: usar con filtros o volúmenes acotados.';

-- Consolidado por zona administrativa. Responde "¿qué barrios/veredas
-- concentran más personas afectadas?" sin que el cliente sepa de geometría.
CREATE OR REPLACE VIEW v_resumen_por_lugar AS
SELECT
  l.id                AS lugar_id,
  l.nombre            AS lugar,
  l.tipo              AS tipo_lugar,
  l.codigo,
  -- Los agregados se convierten a int: count() y sum() devuelven bigint, y los
  -- drivers lo entregan como texto porque no cabe en un number de JavaScript.
  -- Para estos conteos el rango de int sobra y el consumidor recibe números.
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
  ST_X(l.centroide::geometry)                        AS lng
FROM lugares l
LEFT JOIN reportes r
       ON r.lugar_id = l.id
      AND r.estado NOT IN ('RESUELTO', 'DUPLICADO', 'DESCARTADO')
GROUP BY l.id, l.nombre, l.tipo, l.codigo, l.centroide;

-- Cobertura: para cada reporte abierto, el recurso disponible más cercano y a
-- qué distancia. Es la consulta que responde "¿tenemos con qué atender esto?".
CREATE OR REPLACE VIEW v_cobertura_reportes AS
SELECT
  r.id                AS reporte_id,
  r.codigo_publico,
  r.categoria,
  r.severidad,
  r.prioridad_score,
  cercano.id          AS recurso_id,
  cercano.nombre      AS recurso,
  cercano.tipo        AS tipo_recurso,
  round(cercano.distancia_m::numeric, 1) AS distancia_m
FROM reportes r
LEFT JOIN LATERAL (
  SELECT rec.id,
         rec.nombre,
         rec.tipo,
         ST_Distance(rec.geom, r.geom) AS distancia_m
    FROM recursos rec
   WHERE rec.estado = 'DISPONIBLE'
   ORDER BY rec.geom <-> r.geom
   LIMIT 1
) cercano ON true
WHERE r.estado NOT IN ('RESUELTO', 'DUPLICADO', 'DESCARTADO');
