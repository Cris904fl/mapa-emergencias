import { hashearClave } from '../lib/auth.ts';
import { pool, cerrarPool } from './pool.ts';

/**
 * Provisiona un operador: lo crea si no existe, o le cambia la clave si ya está.
 *
 *   npm run clave --workspace=@emergencias/api -- <correo> <clave> [rol] [organización]
 *
 * Existe porque no hay registro público de cuentas: los operadores los crea
 * quien administra el despliegue, no un formulario abierto en internet.
 *
 * Antes solo hacía UPDATE, lo que funcionaba en desarrollo —donde la semilla ya
 * había creado los usuarios— pero dejaba un despliegue limpio sin ninguna forma
 * de crear el primero: respondía «no existe ese usuario» y ahí se acababa el
 * camino. Y crear uno a mano por SQL tampoco es trivial, porque la tabla exige
 * que todo operador tenga organización.
 */

const [correo, clave, rolPedido, organizacionPedida] = process.argv.slice(2);

const ROLES = ['OPERADOR', 'RESPONDIENTE', 'ADMIN'] as const;
type Rol = (typeof ROLES)[number];

function salir(mensaje: string): never {
  console.error(mensaje);
  process.exit(1);
}

if (!correo || !clave) {
  salir(
    'Uso: npm run clave --workspace=@emergencias/api -- <correo> <clave> [rol] [organización]\n' +
      `  rol: ${ROLES.join(' | ')} (por defecto ADMIN al crear)`,
  );
}

if (clave.length < 8) salir('La clave debe tener al menos 8 caracteres.');

if (rolPedido && !ROLES.includes(rolPedido as Rol)) {
  salir(`Rol desconocido: ${rolPedido}. Debe ser uno de ${ROLES.join(', ')}.`);
}

try {
  const hash = await hashearClave(clave);

  const { rows: existentes } = await pool.query<{ id: string; rol: string }>(
    'SELECT id, rol::text FROM usuarios WHERE correo = $1',
    [correo],
  );
  const existente = existentes[0];

  if (existente) {
    // Se actualiza el rol solo si se pidió explícitamente: cambiarle el rol a
    // alguien por el solo hecho de reiniciarle la clave sería una sorpresa.
    await pool.query(
      `UPDATE usuarios
          SET hash_clave = $2,
              rol = coalesce($3::rol_usuario, rol)
        WHERE id = $1`,
      [existente.id, hash, rolPedido ?? null],
    );
    console.log(
      `Clave actualizada para ${correo}` +
        (rolPedido && rolPedido !== existente.rol ? ` · rol: ${existente.rol} → ${rolPedido}` : ''),
    );
  } else {
    const rol: Rol = (rolPedido as Rol) ?? 'ADMIN';

    // Todo operador necesita organización (usuarios_operador_con_organizacion).
    // Se resuelve sin adivinar: si hay una sola, esa; si no hay ninguna, se crea
    // la que se haya nombrado; si hay varias, se exige elegir.
    const { rows: orgs } = await pool.query<{ id: string; nombre: string }>(
      organizacionPedida
        ? 'SELECT id, nombre FROM organizaciones WHERE lower(nombre) = lower($1)'
        : 'SELECT id, nombre FROM organizaciones',
      organizacionPedida ? [organizacionPedida] : [],
    );

    let organizacionId: string;
    let nombreOrg: string;

    if (orgs.length === 1) {
      organizacionId = orgs[0]!.id;
      nombreOrg = orgs[0]!.nombre;
    } else if (orgs.length === 0) {
      if (!organizacionPedida) {
        salir(
          'No hay ninguna organización todavía. Indique el nombre de la que hay que crear:\n' +
            `  npm run clave --workspace=@emergencias/api -- ${correo} <clave> ${rol} "Nombre de la organización"`,
        );
      }
      // COMUNITARIA es el tipo menos comprometido para la primera organización
      // de un despliegue: no dice que sea un organismo de socorro ni una entidad
      // de gobierno, que sería afirmar algo falso. Se cambia después con un
      // UPDATE si corresponde.
      const { rows } = await pool.query<{ id: string; nombre: string }>(
        `INSERT INTO organizaciones (nombre, tipo)
         VALUES ($1, 'COMUNITARIA') RETURNING id, nombre`,
        [organizacionPedida],
      );
      organizacionId = rows[0]!.id;
      nombreOrg = rows[0]!.nombre;
      console.log(`Organización creada: ${nombreOrg} (tipo COMUNITARIA)`);
    } else {
      salir(
        'Hay varias organizaciones. Indique cuál con el cuarto argumento:\n' +
          orgs.map((o) => `  · ${o.nombre}`).join('\n'),
      );
    }

    await pool.query(
      `INSERT INTO usuarios (correo, nombre, rol, organizacion_id, hash_clave)
       VALUES ($1, $2, $3::rol_usuario, $4, $5)`,
      [correo, correo.split('@')[0], rol, organizacionId, hash],
    );

    console.log(`Usuario creado: ${correo} · rol ${rol} · organización ${nombreOrg}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await cerrarPool();
}
