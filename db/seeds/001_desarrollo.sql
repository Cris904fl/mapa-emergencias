-- Datos de prueba para desarrollo.
--
-- Geografía inventada sobre coordenadas reales de Bogotá para que el mapa se
-- vea sensato al abrirlo. Los UUID son fijos a propósito: el archivo se puede
-- volver a ejecutar sin duplicar nada y las pruebas pueden referenciar filas
-- concretas.
--
-- No usar en producción.

BEGIN;

-- ---------------------------------------------------------------------------
-- Organizaciones
-- ---------------------------------------------------------------------------
INSERT INTO organizaciones (id, nombre, tipo, sigla, telefono_contacto) VALUES
  ('11111111-0000-4000-8000-000000000001', 'Cuerpo Oficial de Bomberos',        'SOCORRO',     'COB',  '119'),
  ('11111111-0000-4000-8000-000000000002', 'Defensa Civil Colombiana',          'SOCORRO',     'DCC',  '144'),
  ('11111111-0000-4000-8000-000000000003', 'Secretaría Distrital de Salud',     'SALUD',       'SDS',  '123'),
  ('11111111-0000-4000-8000-000000000004', 'Cruz Roja Colombiana',              'ONG',         'CRC',  '132'),
  ('11111111-0000-4000-8000-000000000005', 'Junta de Acción Comunal Santa Fe',  'COMUNITARIA', 'JAC',  NULL)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Usuarios
-- ---------------------------------------------------------------------------
-- hash_clave es un scrypt de la cadena 'demo1234' (ver apps/api/src/lib/auth.ts).
-- Solo para desarrollo: en producción las claves se fijan con
--   npm run clave --workspace=@emergencias/api -- <correo> <clave>
INSERT INTO usuarios (id, organizacion_id, rol, nombre, telefono, correo, hash_clave) VALUES
  ('22222222-0000-4000-8000-000000000001', '11111111-0000-4000-8000-000000000001', 'OPERADOR',
   'Operadora de sala', '3001112233', 'operadora@demo.local',
   'scrypt$d74e42158906fd49874f7913af101319$9674cba5e21793139b9201a042f7710275170610b0a79bf51bfbdc275eae48cbab227ce785ffb640167195c808f81601691ecc605b0f67dfd67287f2b9affbd1'),
  ('22222222-0000-4000-8000-000000000002', '11111111-0000-4000-8000-000000000002', 'RESPONDIENTE',
   'Socorrista en campo', '3002223344', 'socorrista@demo.local',
   'scrypt$d74e42158906fd49874f7913af101319$9674cba5e21793139b9201a042f7710275170610b0a79bf51bfbdc275eae48cbab227ce785ffb640167195c808f81601691ecc605b0f67dfd67287f2b9affbd1'),
  ('22222222-0000-4000-8000-000000000003', '11111111-0000-4000-8000-000000000003', 'ADMIN',
   'Administrador', '3003334455', 'admin@demo.local',
   'scrypt$d74e42158906fd49874f7913af101319$9674cba5e21793139b9201a042f7710275170610b0a79bf51bfbdc275eae48cbab227ce785ffb640167195c808f81601691ecc605b0f67dfd67287f2b9affbd1'),
  ('22222222-0000-4000-8000-000000000004', NULL, 'CIUDADANO',
   'Vecina de Santa Fe', '3104445566', NULL, NULL)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Lugares · municipio y dos barrios contenidos
-- ---------------------------------------------------------------------------
-- El trigger de reportes elige el polígono contenedor de MENOR área, así que
-- un reporte dentro de un barrio queda asignado al barrio, y uno en zona
-- rural del municipio queda asignado al municipio.
-- El «Bogotá D.C.» de acá es un rectángulo de cuatro esquinas, no el municipio.
-- Llevaba el código DIVIPOLA real `11001` y eso rompía dos cosas: afirmaba ser
-- la entidad de verdad, y colisionaba con `lugares_codigo_uk` en cuanto se
-- cargaba la geografía real con `scripts/cargar-lugares.mjs` — el `ON CONFLICT
-- (id)` no atrapa un choque de `codigo`, así que la siembra fallaba entera.
-- Sin código no colisiona con nada y sigue sirviendo para lo único que hace:
-- dar un padre a los dos barrios de prueba.
INSERT INTO lugares (id, padre_id, tipo, nombre, codigo, geom) VALUES
  ('33333333-0000-4000-8000-000000000001', NULL, 'MUNICIPIO', 'Bogotá D.C. (prueba)', NULL,
   ST_GeomFromText('MULTIPOLYGON(((
      -74.15 4.55, -74.00 4.55, -74.00 4.75, -74.15 4.75, -74.15 4.55
    )))', 4326)::geography),

  ('33333333-0000-4000-8000-000000000002', '33333333-0000-4000-8000-000000000001', 'BARRIO', 'Santa Fe', NULL,
   ST_GeomFromText('MULTIPOLYGON(((
      -74.09 4.600, -74.07 4.600, -74.07 4.620, -74.09 4.620, -74.09 4.600
    )))', 4326)::geography),

  ('33333333-0000-4000-8000-000000000003', '33333333-0000-4000-8000-000000000001', 'BARRIO', 'La Esperanza', NULL,
   ST_GeomFromText('MULTIPOLYGON(((
      -74.08 4.630, -74.06 4.630, -74.06 4.650, -74.08 4.650, -74.08 4.630
    )))', 4326)::geography)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Recursos
-- ---------------------------------------------------------------------------
INSERT INTO recursos (id, organizacion_id, tipo, nombre, estado, geom, movil, capacidad_total, capacidad_usada, telefono) VALUES
  ('44444444-0000-4000-8000-000000000001', '11111111-0000-4000-8000-000000000003', 'HOSPITAL',
   'Hospital San Rafael', 'DISPONIBLE',
   ST_SetSRID(ST_MakePoint(-74.0700, 4.6280), 4326)::geography, false, 120, 84, '6012223344'),

  ('44444444-0000-4000-8000-000000000002', '11111111-0000-4000-8000-000000000001', 'ESTACION_BOMBEROS',
   'Estación B-4 Chapinero', 'DISPONIBLE',
   ST_SetSRID(ST_MakePoint(-74.0750, 4.6150), 4326)::geography, false, NULL, 0, '119'),

  ('44444444-0000-4000-8000-000000000003', '11111111-0000-4000-8000-000000000004', 'ALBERGUE',
   'Albergue Colegio La Esperanza', 'DISPONIBLE',
   ST_SetSRID(ST_MakePoint(-74.0700, 4.6400), 4326)::geography, false, 200, 45, NULL),

  ('44444444-0000-4000-8000-000000000004', '11111111-0000-4000-8000-000000000005', 'PUNTO_AGUA',
   'Punto de agua parque Santa Fe', 'AGOTADO',
   ST_SetSRID(ST_MakePoint(-74.0790, 4.6120), 4326)::geography, false, NULL, 0, NULL),

  ('44444444-0000-4000-8000-000000000005', '11111111-0000-4000-8000-000000000003', 'AMBULANCIA',
   'Ambulancia TAB-07', 'OCUPADO',
   ST_SetSRID(ST_MakePoint(-74.0760, 4.6210), 4326)::geography, true, 2, 2, '123'),

  ('44444444-0000-4000-8000-000000000006', '11111111-0000-4000-8000-000000000002', 'EQUIPO_RESCATE',
   'Grupo USAR Defensa Civil', 'DISPONIBLE',
   ST_SetSRID(ST_MakePoint(-74.0810, 4.6060), 4326)::geography, true, 8, 0, '144')
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Reportes
-- ---------------------------------------------------------------------------
-- Los primeros cuatro están dentro de un radio de ~300 m entre sí: sirven
-- para ver el término de concentración del índice de prioridad haciendo algo.
-- El último está en zona rural del municipio, lejos de todo recurso: sirve
-- para ver el término de aislamiento.
INSERT INTO reportes (
  id, id_cliente, reportante_id, contacto_reportante,
  categoria, severidad, estado, descripcion,
  geom, precision_ubicacion_m,
  personas_afectadas, personas_atrapadas, personas_heridas, personas_vulnerables,
  requiere_rescate, origen_triage, reportado_en
) VALUES
  ('55555555-0000-4000-8000-000000000001', '99999999-0000-4000-8000-000000000001',
   '22222222-0000-4000-8000-000000000004', '3104445566',
   'PERSONAS_ATRAPADAS', 'CRITICA', 'RECIBIDO',
   'Estamos atrapados en una casa cerca del parque, somos 5 y una señora está herida.',
   ST_SetSRID(ST_MakePoint(-74.0800, 4.6100), 4326)::geography, 12.0,
   5, 5, 1, 1, true, 'CIUDADANO', now() - interval '3 hours'),

  ('55555555-0000-4000-8000-000000000002', '99999999-0000-4000-8000-000000000002',
   NULL, '3115556677',
   'DANO_ESTRUCTURAL', 'ALTA', 'RECIBIDO',
   'Hay grietas grandes en el edificio de la esquina y varias personas no pueden salir.',
   ST_SetSRID(ST_MakePoint(-74.0805, 4.6110), 4326)::geography, 25.0,
   6, 2, 0, 2, true, 'CIUDADANO', now() - interval '2 hours 20 minutes'),

  ('55555555-0000-4000-8000-000000000003', '99999999-0000-4000-8000-000000000003',
   NULL, NULL,
   'NECESITA_AGUA', 'MEDIA', 'RECIBIDO',
   'No hay agua en toda la cuadra desde ayer, somos como 40 casas.',
   ST_SetSRID(ST_MakePoint(-74.0795, 4.6118), 4326)::geography, 40.0,
   8, 0, 0, 3, false, 'CIUDADANO', now() - interval '9 hours'),

  ('55555555-0000-4000-8000-000000000004', '99999999-0000-4000-8000-000000000004',
   NULL, 'Radio JAC canal 2',
   'VIA_BLOQUEADA', 'MEDIA', 'RECIBIDO',
   'La calle está tapada con escombros, no pueden entrar ambulancias.',
   ST_SetSRID(ST_MakePoint(-74.0810, 4.6105), 4326)::geography, 15.0,
   0, 0, 0, 0, false, 'OPERADOR', now() - interval '1 hour 10 minutes'),

  ('55555555-0000-4000-8000-000000000005', '99999999-0000-4000-8000-000000000005',
   NULL, '3128889900',
   'HERIDOS', 'ALTA', 'RECIBIDO',
   'Dos personas con heridas en la cabeza en el andén frente al colegio.',
   ST_SetSRID(ST_MakePoint(-74.0690, 4.6380), 4326)::geography, 8.0,
   2, 0, 2, 0, true, 'OPERADOR', now() - interval '45 minutes'),

  ('55555555-0000-4000-8000-000000000006', '99999999-0000-4000-8000-000000000006',
   NULL, NULL,
   'NECESITA_ALBERGUE', 'MEDIA', 'RECIBIDO',
   'Se nos cayó el techo, somos una familia de 7 con dos niños pequeños y un abuelo.',
   ST_SetSRID(ST_MakePoint(-74.0655, 4.6420), 4326)::geography, 30.0,
   7, 0, 0, 3, false, 'CIUDADANO', now() - interval '5 hours'),

  ('55555555-0000-4000-8000-000000000007', '99999999-0000-4000-8000-000000000007',
   NULL, NULL,
   'DESLIZAMIENTO', 'CRITICA', 'RECIBIDO',
   'Se vino la tierra sobre tres viviendas en la vereda, no sabemos cuántos hay adentro.',
   ST_SetSRID(ST_MakePoint(-74.1400, 4.7200), 4326)::geography, 120.0,
   12, 4, 2, 5, true, 'CIUDADANO', now() - interval '6 hours'),

  ('55555555-0000-4000-8000-000000000008', '99999999-0000-4000-8000-000000000008',
   NULL, NULL,
   'SERVICIOS_CAIDOS', 'BAJA', 'RECIBIDO',
   'Sin luz en el conjunto, ya volvió.',
   ST_SetSRID(ST_MakePoint(-74.0720, 4.6350), 4326)::geography, 20.0,
   0, 0, 0, 0, false, 'OPERADOR', now() - interval '11 hours')
ON CONFLICT (id_cliente) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Avanzar algunos reportes por el flujo de atención
-- ---------------------------------------------------------------------------
-- Se hace con UPDATE y no insertando el estado final directamente para que
-- los triggers hagan su trabajo: fijan primera_respuesta_en y resuelto_en, y
-- dejan la bitácora con actor. Insertar un 'RESUELTO' de una sola vez además
-- violaría el CHECK reportes_resuelto_con_fecha.
SET LOCAL app.usuario_id = '22222222-0000-4000-8000-000000000001';
SET LOCAL app.nota_cambio = 'Triage inicial de datos de prueba';

UPDATE reportes SET estado = 'EN_TRIAGE'
 WHERE id = '55555555-0000-4000-8000-000000000004';

UPDATE reportes
   SET estado = 'ASIGNADO',
       organizacion_asignada_id = '11111111-0000-4000-8000-000000000003',
       recurso_asignado_id      = '44444444-0000-4000-8000-000000000005'
 WHERE id = '55555555-0000-4000-8000-000000000005';

UPDATE reportes SET estado = 'RESUELTO'
 WHERE id = '55555555-0000-4000-8000-000000000008';

COMMIT;

-- Calcular la prioridad inicial de todo lo abierto.
SELECT fn_refrescar_prioridades_vencidas(interval '0 seconds', 1000) AS reportes_priorizados;
