import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, cerrarPool } from './pool.ts';

/**
 * Corredor de migraciones mínimo.
 *
 * Cada archivo se aplica una vez, en orden alfabético, dentro de su propia
 * transacción. Se guarda el SHA-256 del contenido: si un archivo ya aplicado
 * cambia, el corredor falla en lugar de ignorarlo en silencio. Editar una
 * migración ya desplegada es la forma más común de que dos entornos terminen
 * con esquemas distintos creyendo estar iguales.
 */

const aqui = path.dirname(fileURLToPath(import.meta.url));
const directorioMigraciones = path.resolve(aqui, '../../../../db/migrations');

async function asegurarTablaControl(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS migraciones_aplicadas (
      nombre      text PRIMARY KEY,
      sha256      text NOT NULL,
      aplicada_en timestamptz NOT NULL DEFAULT now()
    )
  `);
}

function sha256(texto: string): string {
  return createHash('sha256').update(texto, 'utf8').digest('hex');
}

export async function migrar(): Promise<{ aplicadas: string[]; omitidas: string[] }> {
  await asegurarTablaControl();

  const archivos = (await readdir(directorioMigraciones))
    .filter((nombre) => nombre.endsWith('.sql'))
    .sort();

  const { rows: yaAplicadas } = await pool.query<{ nombre: string; sha256: string }>(
    'SELECT nombre, sha256 FROM migraciones_aplicadas',
  );
  const registro = new Map(yaAplicadas.map((fila) => [fila.nombre, fila.sha256]));

  const aplicadas: string[] = [];
  const omitidas: string[] = [];

  for (const nombre of archivos) {
    const sql = await readFile(path.join(directorioMigraciones, nombre), 'utf8');
    const huella = sha256(sql);
    const huellaGuardada = registro.get(nombre);

    if (huellaGuardada) {
      if (huellaGuardada !== huella) {
        throw new Error(
          `La migración ${nombre} ya fue aplicada pero su contenido cambió.\n` +
            'Crear una migración nueva en lugar de editar una existente.',
        );
      }
      omitidas.push(nombre);
      continue;
    }

    const cliente = await pool.connect();
    try {
      await cliente.query('BEGIN');
      await cliente.query(sql);
      await cliente.query(
        'INSERT INTO migraciones_aplicadas (nombre, sha256) VALUES ($1, $2)',
        [nombre, huella],
      );
      await cliente.query('COMMIT');
      aplicadas.push(nombre);
      console.log(`  aplicada  ${nombre}`);
    } catch (error) {
      await cliente.query('ROLLBACK').catch(() => {});
      throw new Error(
        `Falló la migración ${nombre}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    } finally {
      cliente.release();
    }
  }

  return { aplicadas, omitidas };
}

// Ejecutado directamente desde la línea de comandos.
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` ||
    process.argv[1]?.endsWith('migrar.ts')) {
  try {
    const { aplicadas, omitidas } = await migrar();
    console.log(
      aplicadas.length > 0
        ? `\n${aplicadas.length} migración(es) aplicada(s), ${omitidas.length} ya estaban.`
        : `\nNada por aplicar (${omitidas.length} migraciones ya estaban).`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await cerrarPool();
  }
}
