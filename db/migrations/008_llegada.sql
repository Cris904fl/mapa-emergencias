-- ---------------------------------------------------------------------------
-- 008 · Hora de llegada al sitio, con su procedencia
-- ---------------------------------------------------------------------------
-- Por qué existe esta migración: el umbral de «asignados sin llegada» no se
-- puede calibrar porque el dato no se está recogiendo. Al medir la bitácora, 2
-- de cada 5 casos cerrados nunca pasaron por EN_ATENCION — el rescatista cierra
-- desde el celular sin acordarse del botón intermedio. Esperar más tiempo no lo
-- arregla: el instrumento de medición es el que está roto, no la muestra.
--
-- La solución no puede ser inventar la llegada al cerrar. Eso rellenaría el
-- hueco con el instante del cierre, que es exactamente la métrica que
-- contamina: un caso cerrado a los 45 minutos pudo haber llegado a los 10.
--
-- Por eso se guardan DOS cosas: cuándo llegó y CÓMO se supo. Es la misma
-- decisión que ya tomó `origen_triage` para los conteos — un número que se va a
-- usar para decidir tiene que decir de dónde salió.

CREATE TYPE origen_llegada AS ENUM (
  -- La marcó al llegar: la hora es la del reloj del servidor en ese momento.
  'MARCADA',
  -- La declaró después, al cerrar el caso: es un recuerdo, no una medición.
  -- Sirve para calibrar, pero es evidencia más débil y hay que poder separarla.
  'DECLARADA'
);

ALTER TABLE reportes
  ADD COLUMN llegada_en     timestamptz,
  ADD COLUMN llegada_origen origen_llegada;

-- O están las dos o no está ninguna: una hora sin procedencia no se puede
-- interpretar, y una procedencia sin hora no dice nada.
ALTER TABLE reportes
  ADD CONSTRAINT reportes_llegada_completa
  CHECK ((llegada_en IS NULL) = (llegada_origen IS NULL));

-- Nadie llega antes de que le asignen el caso. Sin este CHECK, un dedazo al
-- declarar la hora entra como un tiempo de llegada negativo y envenena
-- justamente el promedio que se quiere calcular.
ALTER TABLE reportes
  ADD CONSTRAINT reportes_llegada_posterior_a_respuesta
  CHECK (llegada_en IS NULL
         OR primera_respuesta_en IS NULL
         OR llegada_en >= primera_respuesta_en);

COMMENT ON COLUMN reportes.llegada_en IS
  'Cuándo llegó el equipo al sitio. NULL = no se sabe, que es distinto de cero.';
COMMENT ON COLUMN reportes.llegada_origen IS
  'MARCADA (medida al llegar) o DECLARADA (recordada al cerrar). Para poder '
  'separar la evidencia fuerte de la débil al calibrar el umbral de estancados.';

-- Recuperar lo que ya está en la bitácora: los casos que sí pasaron por
-- EN_ATENCION tienen su hora registrada y son evidencia MARCADA legítima.
UPDATE reportes r
   SET llegada_en = h.primera,
       llegada_origen = 'MARCADA'
  FROM (
    SELECT reporte_id, min(creado_en) AS primera
      FROM historial_estado_reporte
     WHERE estado_nuevo = 'EN_ATENCION'
     GROUP BY reporte_id
  ) h
 WHERE h.reporte_id = r.id
   AND r.llegada_en IS NULL
   -- El CHECK de arriba no admite una llegada anterior a la primera respuesta.
   -- Si la bitácora tuviera un caso así, se deja sin rellenar en vez de forzar
   -- el dato: no saber es un estado válido.
   AND (r.primera_respuesta_en IS NULL OR h.primera >= r.primera_respuesta_en);

-- ---------------------------------------------------------------------------
-- El trigger de marcas ahora también sella la llegada
-- ---------------------------------------------------------------------------
-- Se reemplaza la función de 006 en vez de editarla allá: el corredor de
-- migraciones guarda el SHA-256 de lo ya aplicado y falla si un archivo cambia.
CREATE OR REPLACE FUNCTION trg_reportes_marcas_atencion()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.estado IS DISTINCT FROM OLD.estado THEN
    -- Primera respuesta: el primer paso que implica que alguien se hizo cargo.
    -- Detiene el término de espera del índice de prioridad.
    IF NEW.primera_respuesta_en IS NULL
       AND NEW.estado IN ('ASIGNADO', 'EN_ATENCION', 'RESUELTO') THEN
      NEW.primera_respuesta_en := now();
    END IF;

    -- Llegada al sitio. Solo se sella la primera vez: si alguien vuelve a pasar
    -- el caso por EN_ATENCION, la llegada sigue siendo la original.
    IF NEW.llegada_en IS NULL AND NEW.estado = 'EN_ATENCION' THEN
      NEW.llegada_en := now();
      NEW.llegada_origen := 'MARCADA';
    END IF;

    IF NEW.estado = 'RESUELTO' AND NEW.resuelto_en IS NULL THEN
      NEW.resuelto_en := now();
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- Índice parcial para la consulta de calibración: son pocas filas frente al
-- total y siempre se piden juntas con su procedencia.
CREATE INDEX reportes_llegada_ix
  ON reportes (llegada_origen, llegada_en)
  WHERE llegada_en IS NOT NULL;
