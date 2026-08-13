-- ---------------------------------------------------------------------------
-- 010 · Suscripciones a notificaciones push
-- ---------------------------------------------------------------------------
-- Por qué existe: hoy alguien reporta una emergencia y no vuelve a saber nada.
-- Ni cuando un equipo toma su caso, ni cuando llega, ni cuando lo cierran. La
-- app le da un código para consultar, pero eso obliga a que la persona vuelva a
-- preguntar — y quien acaba de reportar que su casa se está cayendo no está
-- pendiente de recargar una página.
--
-- La suscripción se ata al REPORTE y no a un usuario, porque el ciudadano no
-- tiene cuenta y no debe tenerla: exigir registro para pedir auxilio garantiza
-- perder reportes. Un dispositivo se suscribe a los casos que él mismo reportó.

CREATE TABLE suscripciones_push (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporte_id  uuid NOT NULL REFERENCES reportes (id) ON DELETE CASCADE,

  -- Los tres datos que entrega la API de Push del navegador. El endpoint es la
  -- URL del servicio del fabricante (Google, Mozilla, Apple); las dos claves
  -- cifran el contenido de extremo a extremo, de modo que el servicio de push
  -- transporta el mensaje sin poder leerlo.
  endpoint    text NOT NULL,
  clave_p256dh text NOT NULL,
  clave_auth  text NOT NULL,

  creado_en   timestamptz NOT NULL DEFAULT now(),

  -- Cuándo dejó de servir. Un endpoint muere cuando la persona desinstala la
  -- app, limpia los datos del navegador o revoca el permiso; el servicio de
  -- push responde 404 o 410 y se marca acá en vez de borrarlo, para poder ver
  -- cuántas notificaciones se están perdiendo y por qué.
  invalidado_en timestamptz,
  ultimo_error  text,

  -- Un mismo dispositivo no puede suscribirse dos veces al mismo reporte. Pasa
  -- de forma natural: la persona abre la app otra vez y el navegador devuelve
  -- la misma suscripción.
  CONSTRAINT suscripciones_push_unica UNIQUE (reporte_id, endpoint)
);

-- El envío busca por reporte y solo las vivas.
CREATE INDEX suscripciones_push_activas_ix
  ON suscripciones_push (reporte_id)
  WHERE invalidado_en IS NULL;

COMMENT ON TABLE suscripciones_push IS
  'Suscripciones de un dispositivo a los cambios de un reporte concreto. '
  'Sin cuentas: el ciudadano no se registra para pedir auxilio.';
