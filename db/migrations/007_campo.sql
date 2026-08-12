-- 007 · Trabajo en campo
--
-- Agrega lo que hace falta para que un rescatista opere desde su celular:
-- saber dónde está, y que un reporte tenga una persona responsable y no solo
-- una organización.

-- ---------------------------------------------------------------------------
-- Posición del personal en campo
-- ---------------------------------------------------------------------------
-- La última posición conocida de quien está en la calle. Sirve para dos cosas:
-- que la app le muestre los casos más cercanos a él, y que la sala de crisis vea
-- dónde está su gente.
--
-- Es la última posición REPORTADA, no la posición actual: `posicion_en` dice de
-- cuándo es. Un dato de hace dos horas en una emergencia es casi inútil, y quien
-- consulta tiene que poder notarlo.
ALTER TABLE usuarios
  ADD COLUMN ultima_posicion geography(Point, 4326),
  ADD COLUMN posicion_precision_m numeric(8, 1),
  ADD COLUMN posicion_en timestamptz;

CREATE INDEX usuarios_posicion_gix ON usuarios USING GIST (ultima_posicion)
  WHERE ultima_posicion IS NOT NULL;

COMMENT ON COLUMN usuarios.ultima_posicion IS
  'Última posición reportada por el dispositivo. Mirar posicion_en antes de confiar en ella.';

-- ---------------------------------------------------------------------------
-- Responsable de un reporte
-- ---------------------------------------------------------------------------
-- `organizacion_asignada_id` dice qué entidad se hizo cargo; esto dice QUIÉN.
-- Hace falta para que un rescatista pueda tomar un caso y para que dos no salgan
-- al mismo sitio sin saberlo.
ALTER TABLE reportes
  ADD COLUMN responsable_id uuid REFERENCES usuarios (id) ON DELETE SET NULL,
  ADD COLUMN tomado_en timestamptz;

CREATE INDEX reportes_responsable_ix ON reportes (responsable_id, estado)
  WHERE responsable_id IS NOT NULL;

-- Un reporte tomado tiene que decir cuándo. Evita filas a medio construir por
-- un UPDATE manual.
ALTER TABLE reportes
  ADD CONSTRAINT reportes_tomado_con_fecha CHECK (
    responsable_id IS NULL OR tomado_en IS NOT NULL
  );

COMMENT ON COLUMN reportes.responsable_id IS
  'Persona que tomó el caso en campo. Distinto de organizacion_asignada_id, que es la entidad.';

-- ---------------------------------------------------------------------------
-- Marca de tiempo al tomar un caso
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_reportes_marca_tomado()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.responsable_id IS NOT NULL
     AND (OLD.responsable_id IS NULL OR OLD.responsable_id <> NEW.responsable_id)
     AND NEW.tomado_en IS NULL THEN
    NEW.tomado_en := now();
  END IF;

  -- Al liberar el caso se limpia la marca, para que el CHECK siga cumpliéndose.
  IF NEW.responsable_id IS NULL THEN
    NEW.tomado_en := NULL;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER reportes_marca_tomado BEFORE UPDATE OF responsable_id ON reportes
  FOR EACH ROW EXECUTE FUNCTION trg_reportes_marca_tomado();

-- ---------------------------------------------------------------------------
-- Vista de trabajo en campo
-- ---------------------------------------------------------------------------
-- Lo que necesita ver un rescatista, sin los agregados del tablero. Se deja
-- como vista para que la ruta de la API no repita los joins.
CREATE OR REPLACE VIEW v_casos_campo AS
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
  r.contacto_reportante,
  r.reportado_en,
  r.primera_respuesta_en,
  r.prioridad_score,
  r.geom,
  ST_Y(r.geom::geometry) AS lat,
  ST_X(r.geom::geometry) AS lng,
  l.nombre           AS lugar,
  r.responsable_id,
  u.nombre           AS responsable,
  r.tomado_en,
  o.nombre           AS organizacion_asignada
FROM reportes r
LEFT JOIN lugares l        ON l.id = r.lugar_id
LEFT JOIN usuarios u       ON u.id = r.responsable_id
LEFT JOIN organizaciones o ON o.id = r.organizacion_asignada_id
WHERE r.estado NOT IN ('RESUELTO', 'DUPLICADO', 'DESCARTADO');

COMMENT ON VIEW v_casos_campo IS
  'Casos abiertos con lo que necesita quien atiende en campo. Incluye geom para consultas espaciales.';
