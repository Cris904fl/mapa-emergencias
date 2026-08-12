-- 006 · Triggers
--
-- Todo lo que va acá está en la base y no en la API por una razón: son
-- invariantes que ningún camino de código debería poder evadir. Un cambio de
-- estado sin bitácora, o un reporte sin código público, no son estados válidos
-- del sistema — y tarde o temprano alguien va a escribir un script que inserte
-- directo por SQL.

-- ---------------------------------------------------------------------------
-- actualizado_en
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_tocar_actualizado_en()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.actualizado_en := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER organizaciones_tocar BEFORE UPDATE ON organizaciones
  FOR EACH ROW EXECUTE FUNCTION trg_tocar_actualizado_en();
CREATE TRIGGER usuarios_tocar BEFORE UPDATE ON usuarios
  FOR EACH ROW EXECUTE FUNCTION trg_tocar_actualizado_en();
CREATE TRIGGER lugares_tocar BEFORE UPDATE ON lugares
  FOR EACH ROW EXECUTE FUNCTION trg_tocar_actualizado_en();
CREATE TRIGGER recursos_tocar BEFORE UPDATE ON recursos
  FOR EACH ROW EXECUTE FUNCTION trg_tocar_actualizado_en();
CREATE TRIGGER reportes_tocar BEFORE UPDATE ON reportes
  FOR EACH ROW EXECUTE FUNCTION trg_tocar_actualizado_en();

-- ---------------------------------------------------------------------------
-- Código público legible
-- ---------------------------------------------------------------------------
-- Alfabeto sin 0/O ni 1/I/L: el código se dicta por radio y por teléfono, y
-- confundir un carácter significa despachar al reporte equivocado.
CREATE OR REPLACE FUNCTION fn_generar_codigo_publico()
RETURNS text LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  alfabeto constant text := '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  codigo   text := '';
BEGIN
  FOR i IN 1..5 LOOP
    codigo := codigo || substr(alfabeto, 1 + floor(random() * length(alfabeto))::integer, 1);
  END LOOP;
  RETURN 'RPT-' || codigo;
END;
$$;

-- ---------------------------------------------------------------------------
-- Antes de insertar un reporte: código público y resolución de zona
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_reportes_antes_insertar()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  intentos  integer := 0;
  candidato text;
BEGIN
  IF NEW.codigo_publico IS NULL OR btrim(NEW.codigo_publico) = '' THEN
    LOOP
      intentos  := intentos + 1;
      candidato := fn_generar_codigo_publico();
      EXIT WHEN NOT EXISTS (
        SELECT 1 FROM reportes WHERE codigo_publico = candidato
      );
      IF intentos >= 20 THEN
        RAISE EXCEPTION 'No se pudo generar un código público único en % intentos', intentos;
      END IF;
    END LOOP;
    NEW.codigo_publico := candidato;
  END IF;

  -- La verificación de existencia de arriba deja una ventana de carrera entre
  -- inserciones concurrentes; el índice único `reportes_codigo_publico_uk` es
  -- la garantía real y la API reintenta ante violación. Con 31^5 ≈ 28,6
  -- millones de combinaciones la colisión es rara, pero no imposible.

  -- Zona administrativa por contención espacial. Se toma el polígono
  -- contenedor de menor área, que es el más específico: barrio antes que
  -- localidad, vereda antes que municipio.
  IF NEW.lugar_id IS NULL THEN
    SELECT l.id
      INTO NEW.lugar_id
      FROM lugares l
     WHERE ST_Intersects(l.geom, NEW.geom)
     ORDER BY ST_Area(l.geom) ASC
     LIMIT 1;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER reportes_antes_insertar BEFORE INSERT ON reportes
  FOR EACH ROW EXECUTE FUNCTION trg_reportes_antes_insertar();

-- Reubicar un reporte (corrección del operador) debe recalcular la zona.
CREATE OR REPLACE FUNCTION trg_reportes_reubicar()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT ST_Equals(NEW.geom::geometry, OLD.geom::geometry) THEN
    SELECT l.id
      INTO NEW.lugar_id
      FROM lugares l
     WHERE ST_Intersects(l.geom, NEW.geom)
     ORDER BY ST_Area(l.geom) ASC
     LIMIT 1;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER reportes_reubicar BEFORE UPDATE OF geom ON reportes
  FOR EACH ROW EXECUTE FUNCTION trg_reportes_reubicar();

-- ---------------------------------------------------------------------------
-- Marcas de tiempo del ciclo de atención
-- ---------------------------------------------------------------------------
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

    IF NEW.estado = 'RESUELTO' AND NEW.resuelto_en IS NULL THEN
      NEW.resuelto_en := now();
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER reportes_marcas_atencion BEFORE UPDATE OF estado ON reportes
  FOR EACH ROW EXECUTE FUNCTION trg_reportes_marcas_atencion();

-- ---------------------------------------------------------------------------
-- Bitácora de estados
-- ---------------------------------------------------------------------------
-- El actor sale de una variable de sesión que la API fija por transacción
-- (`SET LOCAL app.usuario_id`). Si nadie la fijó queda NULL, que es el caso
-- honesto: un cambio hecho por un proceso automático o por SQL directo.
CREATE OR REPLACE FUNCTION trg_reportes_bitacora()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_usuario_id      uuid;
  v_organizacion_id uuid;
  v_nota            text;
BEGIN
  BEGIN
    v_usuario_id := nullif(current_setting('app.usuario_id', true), '')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    v_usuario_id := NULL;
  END;

  v_nota := nullif(current_setting('app.nota_cambio', true), '');

  IF v_usuario_id IS NOT NULL THEN
    SELECT organizacion_id INTO v_organizacion_id FROM usuarios WHERE id = v_usuario_id;
  END IF;

  INSERT INTO historial_estado_reporte (
    reporte_id, estado_anterior, estado_nuevo, cambiado_por, organizacion_id, nota
  ) VALUES (
    NEW.id,
    CASE WHEN TG_OP = 'UPDATE' THEN OLD.estado ELSE NULL END,
    NEW.estado,
    v_usuario_id,
    v_organizacion_id,
    v_nota
  );

  RETURN NULL;
END;
$$;

CREATE TRIGGER reportes_bitacora_insertar AFTER INSERT ON reportes
  FOR EACH ROW EXECUTE FUNCTION trg_reportes_bitacora();

CREATE TRIGGER reportes_bitacora_cambio AFTER UPDATE OF estado ON reportes
  FOR EACH ROW
  WHEN (NEW.estado IS DISTINCT FROM OLD.estado)
  EXECUTE FUNCTION trg_reportes_bitacora();

-- ---------------------------------------------------------------------------
-- Protección del triage humano frente a la IA
-- ---------------------------------------------------------------------------
-- Regla: una vez que una persona fijó los conteos y la severidad de un
-- reporte (origen_triage = 'OPERADOR'), un proceso automático no puede
-- volverlos a escribir. La IA estructura texto desordenado; no decide quién
-- se rescata primero.
CREATE OR REPLACE FUNCTION trg_reportes_proteger_triage()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.origen_triage = 'OPERADOR' AND NEW.origen_triage = 'IA' THEN
    RAISE EXCEPTION
      'El reporte % ya tiene triage humano; un proceso automático no puede sobreescribirlo',
      OLD.codigo_publico
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER reportes_proteger_triage BEFORE UPDATE OF origen_triage ON reportes
  FOR EACH ROW EXECUTE FUNCTION trg_reportes_proteger_triage();
