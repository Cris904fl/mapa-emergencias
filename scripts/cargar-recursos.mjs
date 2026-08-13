#!/usr/bin/env node
/**
 * Carga recursos de atención (hospitales, estaciones, albergues) desde un JSON.
 *
 *   node --env-file-if-exists=.env scripts/cargar-recursos.mjs db/recursos.json
 *
 * Por qué existe: sin recursos en la base, el término de aislamiento del índice
 * de prioridad devuelve -1 y le entrega los 15 puntos completos a **todos** los
 * reportes. Deja de diferenciar, y el índice pasa a ordenar con cuatro términos
 * en vez de cinco sin que nada avise.
 *
 * Por qué un archivo y no una migración con datos: las coordenadas de un
 * hospital son un hecho del mundo, no del esquema. Cambian, dependen del
 * municipio donde se despliegue, y equivocarse en una tiene consecuencias
 * reales — el sistema diría que hay ayuda cerca donde no la hay.
 *
 * Es idempotente por nombre: volver a correrlo actualiza en vez de duplicar.
 */

import { readFile } from 'node:fs/promises';
import pg from 'pg';

/**
 * Espejo del enum `tipo_recurso` de db/migrations/002_tipos.sql.
 *
 * Se valida acá y no solo en la base para poder decir «tipo desconocido, use
 * uno de estos» con la lista completa, en vez del error críptico de Postgres
 * sobre un valor inválido de enum. Si se agrega un tipo a la base, hay que
 * agregarlo también aquí.
 */
const TIPOS = [
  'HOSPITAL',
  'PUESTO_SALUD',
  'ALBERGUE',
  'PUNTO_AGUA',
  'PUNTO_ALIMENTO',
  'PUESTO_MANDO',
  'ESTACION_BOMBEROS',
  'EQUIPO_RESCATE',
  'AMBULANCIA',
  'MAQUINARIA',
  'HELIPUERTO',
];

const ruta = process.argv[2];

if (!ruta) {
  console.error('Uso: node --env-file-if-exists=.env scripts/cargar-recursos.mjs <archivo.json>');
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL no está definida. ¿Falta el .env?');
  process.exit(1);
}

const recursos = JSON.parse(await readFile(ruta, 'utf8'));

if (!Array.isArray(recursos) || recursos.length === 0) {
  console.error('El archivo debe ser una lista con al menos un recurso.');
  process.exit(1);
}

// Se valida todo antes de escribir nada: media carga es peor que ninguna,
// porque deja el índice midiendo distancias contra un mapa incompleto.
const problemas = [];
recursos.forEach((r, i) => {
  const donde = `recurso ${i + 1}${r.nombre ? ` («${r.nombre}»)` : ''}`;
  if (!r.nombre?.trim()) problemas.push(`${donde}: falta «nombre»`);
  if (!TIPOS.includes(r.tipo)) {
    problemas.push(`${donde}: «tipo» debe ser uno de ${TIPOS.join(', ')}`);
  }
  if (typeof r.lat !== 'number' || typeof r.lng !== 'number') {
    problemas.push(`${donde}: «lat» y «lng» deben ser números`);
  } else if (r.lat < -4.3 || r.lat > 13.5 || r.lng < -82 || r.lng > -66.8) {
    // El mismo rango que valida la API para los reportes. Un signo cambiado en
    // la longitud pone un hospital de Bogotá en el océano Índico.
    problemas.push(`${donde}: (${r.lat}, ${r.lng}) queda fuera de Colombia`);
  }
});

if (problemas.length > 0) {
  console.error('No se cargó nada. Problemas encontrados:\n');
  problemas.forEach((p) => console.error('  ·', p));
  process.exit(1);
}

const cliente = new pg.Client({ connectionString: process.env.DATABASE_URL });
await cliente.connect();

let creados = 0;
let actualizados = 0;

try {
  for (const r of recursos) {
    const { rows } = await cliente.query(
      `INSERT INTO recursos (nombre, tipo, estado, geom, capacidad_total, notas)
       VALUES ($1, $2::tipo_recurso, 'DISPONIBLE',
               ST_SetSRID(ST_MakePoint($4, $3), 4326)::geography, $5, $6)
       ON CONFLICT (lower(nombre)) DO UPDATE
          SET tipo = excluded.tipo,
              geom = excluded.geom,
              capacidad_total = excluded.capacidad_total,
              notas = excluded.notas
       RETURNING (xmax = 0) AS es_nuevo`,
      [r.nombre.trim(), r.tipo, r.lat, r.lng, r.capacidad_total ?? null, r.notas ?? null],
    );
    if (rows[0]?.es_nuevo) creados++;
    else actualizados++;
  }

  const { rows } = await cliente.query(
    `SELECT tipo::text, count(*)::int n FROM recursos GROUP BY tipo ORDER BY tipo`,
  );
  console.log(`Creados: ${creados} · actualizados: ${actualizados}\n`);
  console.log('Recursos en la base:');
  rows.forEach((f) => console.log('  ·', f.tipo.padEnd(15), f.n));
} catch (error) {
  console.error('FALLO:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await cliente.end();
}
