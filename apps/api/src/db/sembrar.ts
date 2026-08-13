import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, cerrarPool } from './pool.ts';
import { config } from '../config.ts';

/**
 * Carga los datos de prueba de db/seeds. A diferencia de las migraciones no se
 * lleva registro: los archivos de semilla son idempotentes (ON CONFLICT DO
 * NOTHING con UUID fijos) y se re-ejecutan a voluntad.
 *
 * Salvaguarda: se niega a sembrar una base que no esté en esta máquina.
 *
 * El único control era `NODE_ENV === 'production'`, y no alcanza: lo que decide
 * a dónde se escribe es `DATABASE_URL`, no una etiqueta. Con un `.env` de
 * desarrollo apuntando al pooler de Supabase —que es la configuración normal
 * para administrar el despliegue desde aquí— `npm run bd:sembrar` escribía los
 * datos de demostración **en producción**: los tres usuarios de prueba con
 * clave `demo1234`, y los dos barrios de Bogotá en `lugares`, que está vacía a
 * propósito para que no aparezcan como geografía real. Peor todavía,
 * `npm run bd:reiniciar` borra el volumen local y después siembra, así que el
 * daño quedaba a un comando cuyo nombre no lo sugiere.
 *
 * Se comprueba el destino y no la intención, por la misma razón por la que el
 * almacén de medios se elige por presencia de credenciales y no por una
 * bandera: una configuración que falla en producción y no en desarrollo es la
 * peor de todas.
 */

const aqui = path.dirname(fileURLToPath(import.meta.url));
const directorioSemillas = path.resolve(aqui, '../../../../db/seeds');

/** Lo que cuenta como «esta máquina». */
const ANFITRIONES_LOCALES = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '[::1]',
  'host.docker.internal',
]);

export async function sembrar(): Promise<string[]> {
  if (config.NODE_ENV === 'production') {
    throw new Error('Los datos de prueba no se cargan en producción.');
  }

  const anfitrion = new URL(config.DATABASE_URL).hostname;

  // La salida es nombrar el anfitrión exacto que se quiere sembrar, y no una
  // bandera de forzado: una bandera booleana se copia una vez y se queda
  // puesta para siempre. Escribir el nombre obliga a decir a dónde va.
  if (!ANFITRIONES_LOCALES.has(anfitrion) && config.SEMBRAR_ANFITRION !== anfitrion) {
    throw new Error(
      `DATABASE_URL apunta a «${anfitrion}», que no es esta máquina, y los datos ` +
        `de semilla incluyen usuarios con clave conocida y geografía de ejemplo.\n` +
        `  · Para sembrar la base local: apunte DATABASE_URL a localhost:5434.\n` +
        `  · Si de verdad quiere sembrar «${anfitrion}»: SEMBRAR_ANFITRION=${anfitrion}`,
    );
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
