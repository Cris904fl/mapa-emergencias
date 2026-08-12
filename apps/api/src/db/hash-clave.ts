import { hashearClave } from '../lib/auth.ts';
import { pool, cerrarPool } from './pool.ts';

/**
 * Utilidad de línea de comandos para fijar la contraseña de un operador.
 *
 *   npm run clave --workspace=@emergencias/api -- operadora@demo.local demo1234
 *
 * Existe porque no hay registro público de cuentas: los operadores los crea
 * quien administra el despliegue, no un formulario abierto en internet.
 */

const [correo, clave] = process.argv.slice(2);

if (!correo || !clave) {
  console.error('Uso: npm run clave --workspace=@emergencias/api -- <correo> <clave>');
  process.exit(1);
}

if (clave.length < 8) {
  console.error('La clave debe tener al menos 8 caracteres.');
  process.exit(1);
}

try {
  const hash = await hashearClave(clave);
  const { rowCount } = await pool.query(
    'UPDATE usuarios SET hash_clave = $2 WHERE correo = $1',
    [correo, hash],
  );

  if (rowCount === 0) {
    console.error(`No existe un usuario con correo ${correo}.`);
    process.exitCode = 1;
  } else {
    console.log(`Clave actualizada para ${correo}.`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await cerrarPool();
}
