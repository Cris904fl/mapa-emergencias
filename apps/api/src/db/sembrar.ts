import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, cerrarPool } from './pool.ts';
import { config } from '../config.ts';

/**
 * Carga los datos de prueba de db/seeds. A diferencia de las migraciones no se
 * lleva registro: los archivos de semilla son idempotentes (ON CONFLICT DO
 * NOTHING con UUID fijos) y se re-ejecutan a voluntad.
 */

const aqui = path.dirname(fileURLToPath(import.meta.url));
const directorioSemillas = path.resolve(aqui, '../../../../db/seeds');

export async function sembrar(): Promise<string[]> {
  if (config.NODE_ENV === 'production') {
    throw new Error('Los datos de prueba no se cargan en producción.');
  }

  const archivos = (await readdir(directorioSemillas))
    .filter((nombre) => nombre.endsWith('.sql'))
    .sort();

  for (const nombre of archivos) {
    const sql = await readFile(path.join(directorioSemillas, nombre), 'utf8');
    // El archivo maneja su propia transacción (BEGIN/COMMIT), así que se envía
    // completo en una sola llamada.
    await pool.query(sql);
    console.log(`  sembrado  ${nombre}`);
  }

  return archivos;
}

if (process.argv[1]?.endsWith('sembrar.ts')) {
  try {
    const archivos = await sembrar();
    console.log(`\n${archivos.length} archivo(s) de semilla cargado(s).`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await cerrarPool();
  }
}
