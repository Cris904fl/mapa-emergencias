#!/usr/bin/env node
/**
 * Quita las estaciones de bomberos de OpenStreetMap que están dentro de Bogotá,
 * para dejar las oficiales de IDECA como única fuente en la ciudad.
 *
 *   node --env-file-if-exists=.env scripts/depurar-bomberos-bogota.mjs            # simula
 *   node --env-file-if-exists=.env scripts/depurar-bomberos-bogota.mjs --ejecutar # borra
 *   node --env-file-if-exists=.env scripts/depurar-bomberos-bogota.mjs --ejecutar --podar-json
 *
 * ## Por qué borrar y no dejar las dos
 *
 * `fuente` + `fuente_id` evita que una carga pise filas de otra fuente, pero no
 * dedup­lica el mundo: la misma estación existe en OSM y en IDECA como dos filas
 * distintas. Medido en producción, en el área de Bogotá había **24 estaciones de
 * OSM** para unas 19 físicas —«Alejandro Lince Kennedy B-5» aparecía dos veces
 * dentro del propio OSM— y cargar las 19 oficiales encima dejaría 43 marcadores.
 *
 * A un rescatista que mira los recursos cercanos, tres entradas de la misma
 * estación no le dan más opciones: le dan tres veces la misma y ninguna con
 * teléfono. El dato oficial trae dirección y teléfono; el comunitario, ni uno ni
 * otro.
 *
 * ## Por qué el recorte es por polígono y no por caja
 *
 * Se borra lo que cae **dentro del municipio 11001**, no dentro de un rectángulo
 * alrededor de Bogotá. Con una caja se llevaría por delante las estaciones de
 * Soacha, Cota y Chía, que son municipios vecinos con sus propios bomberos y para
 * los que IDECA no publica nada: quedarían sin ningún recurso. Es posible hacerlo
 * bien porque `lugares` ya tiene la geometría real del municipio.
 *
 * ## Qué es reversible y qué no
 *
 * El borrado sí: `db/recursos-colombia.json` conserva las filas de OSM, y volver
 * a correr `cargar-recursos.mjs` con ese archivo las repone. Eso es una red de
 * seguridad y también una trampa —volverían sin que nadie lo pidiera— así que con
 * `--podar-json` se quitan también del archivo y el repositorio queda diciendo lo
 * mismo que la base.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const argumentos = process.argv.slice(2);
const ejecutar = argumentos.includes('--ejecutar');
const podarJson = argumentos.includes('--podar-json');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL no está definida. ¿Falta el .env?');
  process.exit(1);
}

const cliente = new pg.Client({ connectionString: process.env.DATABASE_URL });

try {
  await cliente.connect();
} catch (error) {
  console.error('No se pudo conectar:', error instanceof Error ? error.message : error);
  process.exit(1);
}

try {
  const { rows: bogota } = await cliente.query(
    "SELECT id FROM lugares WHERE codigo = '11001' AND tipo = 'MUNICIPIO'",
  );

  if (bogota.length === 0) {
    console.error(
      'No hay ningún municipio con código 11001 en `lugares`.\n' +
        'Cargue la geografía primero: sin el polígono de Bogotá no se puede recortar\n' +
        'con precisión, y hacerlo con una caja se llevaría a Soacha y Cota por delante.',
    );
    process.exit(1);
  }

  /** Las condiciones del recorte, en un solo sitio para que simular y ejecutar no puedan divergir. */
  const DONDE = `tipo = 'ESTACION_BOMBEROS'
                   AND fuente = 'osm'
                   AND ST_Intersects(geom, (SELECT geom FROM lugares WHERE codigo = '11001'))`;

  const { rows: candidatas } = await cliente.query(
    `SELECT nombre, fuente_id FROM recursos WHERE ${DONDE} ORDER BY nombre`,
  );

  const { rows: quedan } = await cliente.query(
    `SELECT count(*)::int AS n FROM recursos
      WHERE tipo = 'ESTACION_BOMBEROS' AND fuente = 'ideca'`,
  );

  console.log(`Estaciones de OSM dentro de Bogotá: ${candidatas.length}`);
  candidatas.forEach((r) => console.log(`  · ${r.nombre}  [${r.fuente_id}]`));
  console.log(`\nEstaciones de IDECA que quedarían: ${quedan[0].n}`);

  if (quedan[0].n === 0) {
    console.error(
      '\nNO se borra nada: no hay ninguna estación de IDECA cargada todavía.\n' +
        'Cargue primero db/bomberos-bogota.json, o Bogotá se quedaría sin bomberos en el mapa.',
    );
    process.exit(1);
  }

  if (candidatas.length === 0) {
    console.log('\nNada que borrar.');
    process.exit(0);
  }

  if (!ejecutar) {
    console.log('\nSimulación: no se borró nada. Para hacerlo, agregue --ejecutar');
    console.log('(y --podar-json para quitarlas también de db/recursos-colombia.json,');
    console.log(' o volverán la próxima vez que se cargue ese archivo).');
    process.exit(0);
  }

  const { rowCount } = await cliente.query(`DELETE FROM recursos WHERE ${DONDE}`);
  console.log(`\nBorradas ${rowCount} estación(es) de OSM dentro de Bogotá.`);

  if (podarJson) {
    const ruta = path.resolve('db', 'recursos-colombia.json');
    const todos = JSON.parse(readFileSync(ruta, 'utf8'));
    const fuera = new Set(candidatas.map((r) => r.fuente_id));
    const podados = todos.filter((r) => !(r.fuente === 'osm' && fuera.has(r.fuente_id)));
    writeFileSync(ruta, JSON.stringify(podados, null, 2) + '\n', 'utf8');
    console.log(
      `db/recursos-colombia.json: ${todos.length} → ${podados.length} recursos ` +
        `(${todos.length - podados.length} quitados).`,
    );
  } else {
    console.log(
      'Aviso: db/recursos-colombia.json todavía las contiene, así que volverán\n' +
        'la próxima vez que se cargue ese archivo. Use --podar-json para evitarlo.',
    );
  }
} catch (error) {
  console.error('FALLO:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await cliente.end();
}
