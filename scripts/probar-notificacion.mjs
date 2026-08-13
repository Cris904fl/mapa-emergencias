#!/usr/bin/env node
/**
 * Prueba de punta a punta de una notificación push.
 *
 *   node --env-file-if-exists=.env scripts/probar-notificacion.mjs RPT-XXXXX "su-clave" [ESTADO]
 *
 * Cambia el estado de un reporte **a través de la API**, no por SQL directo.
 * Esa diferencia es todo el punto: escribir en la base se salta la ruta que
 * dispara el aviso, así que la notificación nunca saldría y la prueba diría que
 * algo está roto cuando no lo está.
 *
 * Existe como archivo y no como un `node -e` porque el anidamiento de comillas
 * que eso exige es imposible de escribir bien en PowerShell.
 */

import pg from 'pg';

const API = process.env.API_PRUEBA ?? 'https://mapa-emergencias.onrender.com';
const CORREO = process.env.CORREO_PRUEBA ?? 'cristiafl3@gmail.com';

const [codigo, clave, estado = 'ASIGNADO'] = process.argv.slice(2);

if (!codigo || !clave) {
  console.error(
    'Uso: node --env-file-if-exists=.env scripts/probar-notificacion.mjs <RPT-XXXXX> "<clave>" [ESTADO]\n' +
      '  ESTADO: ASIGNADO (por defecto) · EN_ATENCION · RESUELTO\n' +
      '  Use comillas dobles alrededor de la clave.',
  );
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL no está definida. ¿Falta el .env?');
  process.exit(1);
}

// 1. Entrar --------------------------------------------------------------
console.log(`Entrando como ${CORREO}…`);
const respuestaSesion = await fetch(`${API}/v1/sesion`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ correo: CORREO, clave }),
});
const sesion = await respuestaSesion.json();

if (!sesion.token) {
  console.error(`  FALLÓ (HTTP ${respuestaSesion.status}):`, sesion.mensaje ?? sesion);
  console.error('  → Si dice «Credenciales inválidas», la clave no es esa.');
  process.exit(1);
}
console.log(`  ok · ${sesion.usuario?.nombre ?? ''} (${sesion.usuario?.rol ?? '?'})`);

// 2. Buscar el reporte y ver si alguien está suscrito ---------------------
const cliente = new pg.Client({ connectionString: process.env.DATABASE_URL });
await cliente.connect();

const { rows } = await cliente.query(
  `SELECT r.id, r.estado::text,
          (SELECT count(*)::int FROM suscripciones_push s
            WHERE s.reporte_id = r.id AND s.invalidado_en IS NULL) AS suscripciones
     FROM reportes r WHERE r.codigo_publico = upper($1)`,
  [codigo],
);
await cliente.end();

const reporte = rows[0];
if (!reporte) {
  console.error(`No existe ningún reporte con código ${codigo}.`);
  process.exit(1);
}

console.log(`Reporte ${codigo}: estado ${reporte.estado} · ${reporte.suscripciones} suscripción(es)`);

if (reporte.suscripciones === 0) {
  console.error('  → Nadie está suscrito a este reporte, así que no habrá notificación.');
  console.error('    Vuelva a la app, reporte de nuevo y acepte los avisos.');
  process.exit(1);
}

if (reporte.estado === estado) {
  console.error(
    `  → El reporte YA está en ${estado}. La API no notifica si el estado no cambia;\n` +
      '    pruebe con otro estado (EN_ATENCION o RESUELTO).',
  );
  process.exit(1);
}

// 3. Cambiar el estado por la API, que es lo que dispara el aviso ---------
console.log(`Cambiando ${reporte.estado} → ${estado} por la API…`);
const respuesta = await fetch(`${API}/v1/reportes/${reporte.id}/estado`, {
  method: 'PATCH',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${sesion.token}` },
  body: JSON.stringify({ estado, nota: 'Prueba de notificación push' }),
});

if (respuesta.ok) {
  console.log(`  ok (HTTP ${respuesta.status})`);
  console.log('\nLa notificación ya salió. Debería verla en unos segundos.');
  console.log('Si no llega, revise los registros de Render: el envío deja aviso al fallar.');
} else {
  const cuerpo = await respuesta.text();
  console.error(`  FALLÓ (HTTP ${respuesta.status}):`, cuerpo.slice(0, 200));
  process.exitCode = 1;
}
