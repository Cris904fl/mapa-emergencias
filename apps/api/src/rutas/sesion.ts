import type { FastifyInstance } from 'fastify';
import { bd } from '../db/pool.ts';
import { zIniciarSesion } from '../esquemas/reporte.ts';
import { verificarClave, type Sesion } from '../lib/auth.ts';
import { noAutenticado } from '../lib/errores.ts';
import { validar } from '../lib/validar.ts';

export async function rutasSesion(app: FastifyInstance): Promise<void> {
  /**
   * Inicio de sesión para personal operativo. No hay registro público: las
   * cuentas las crea quien administra el despliegue (ver src/db/hash-clave.ts).
   */
  app.post('/v1/sesion', async (peticion) => {
    const { correo, clave } = validar(zIniciarSesion, peticion.body, 'las credenciales');

    const { rows } = await bd.consultar<{
      id: string;
      rol: Sesion['rol'];
      organizacion_id: string | null;
      hash_clave: string | null;
      nombre: string | null;
      activo: boolean;
    }>(
      `SELECT id, rol, organizacion_id, hash_clave, nombre, activo
         FROM usuarios
        WHERE correo = $1`,
      [correo],
    );

    const usuario = rows[0];

    // Se verifica la clave incluso cuando el usuario no existe, contra un hash
    // de descarte, para que el tiempo de respuesta no revele qué correos están
    // registrados. Y el mensaje de error es el mismo en todos los casos.
    const hashParaVerificar =
      usuario?.hash_clave ??
      'scrypt$00000000000000000000000000000000$' + '0'.repeat(128);
    const claveCorrecta = await verificarClave(clave, hashParaVerificar);

    if (!usuario || !usuario.activo || !usuario.hash_clave || !claveCorrecta) {
      throw noAutenticado('Credenciales inválidas');
    }

    const token = app.jwt.sign(
      {
        usuarioId: usuario.id,
        rol: usuario.rol,
        organizacionId: usuario.organizacion_id,
      } satisfies Sesion,
      { expiresIn: '12h' },
    );

    await bd.consultar('UPDATE usuarios SET visto_en = now() WHERE id = $1', [usuario.id]);

    return {
      token,
      // 12 horas: cubre un turno completo de sala de crisis sin obligar a
      // volver a autenticarse a mitad de una emergencia.
      expira_en: '12h',
      usuario: {
        id: usuario.id,
        nombre: usuario.nombre,
        rol: usuario.rol,
        organizacion_id: usuario.organizacion_id,
      },
    };
  });

  /** Datos de la sesión actual. */
  app.get('/v1/sesion', async (peticion) => {
    if (!peticion.sesion) throw noAutenticado();

    const { rows } = await bd.consultar<Record<string, unknown>>(
      `SELECT u.id, u.nombre, u.rol, u.correo, o.nombre AS organizacion
         FROM usuarios u
         LEFT JOIN organizaciones o ON o.id = u.organizacion_id
        WHERE u.id = $1`,
      [peticion.sesion.usuarioId],
    );

    if (!rows[0]) throw noAutenticado();
    return rows[0];
  });
}
