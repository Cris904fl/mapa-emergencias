import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  clave: string,
  sal: Buffer,
  longitud: number,
) => Promise<Buffer>;

/**
 * Hash de contraseñas con scrypt de node:crypto.
 *
 * Se usa scrypt en lugar de bcrypt/argon2 para no arrastrar una dependencia
 * nativa: este proyecto tiene que poder desplegarse rápido y en máquinas
 * heterogéneas, y una compilación de node-gyp fallando en el servidor de una
 * alcaldía es exactamente el tipo de problema que no se quiere tener durante
 * una emergencia. scrypt está en la biblioteca estándar y es adecuado para el
 * caso: pocas cuentas de operador, no un padrón de millones de usuarios.
 *
 * Formato almacenado: scrypt$<sal en hex>$<derivada en hex>
 */

const LONGITUD_SAL = 16;
const LONGITUD_DERIVADA = 64;
const PREFIJO = 'scrypt';

export async function hashearClave(clave: string): Promise<string> {
  const sal = randomBytes(LONGITUD_SAL);
  const derivada = await scrypt(clave, sal, LONGITUD_DERIVADA);
  return `${PREFIJO}$${sal.toString('hex')}$${derivada.toString('hex')}`;
}

export async function verificarClave(clave: string, almacenado: string): Promise<boolean> {
  const partes = almacenado.split('$');
  if (partes.length !== 3 || partes[0] !== PREFIJO) return false;

  const [, salHex, derivadaHex] = partes as [string, string, string];

  let sal: Buffer;
  let esperada: Buffer;
  try {
    sal = Buffer.from(salHex, 'hex');
    esperada = Buffer.from(derivadaHex, 'hex');
  } catch {
    return false;
  }
  if (sal.length !== LONGITUD_SAL || esperada.length !== LONGITUD_DERIVADA) return false;

  const calculada = await scrypt(clave, sal, LONGITUD_DERIVADA);

  // timingSafeEqual exige longitudes iguales, ya garantizadas arriba.
  return timingSafeEqual(calculada, esperada);
}

export type Sesion = {
  usuarioId: string;
  rol: 'CIUDADANO' | 'OPERADOR' | 'RESPONDIENTE' | 'ADMIN';
  organizacionId: string | null;
};

/** Roles autorizados a hacer triage y mover reportes en la cola. */
export const ROLES_OPERATIVOS = ['OPERADOR', 'RESPONDIENTE', 'ADMIN'] as const;

export function puedeOperar(sesion: Sesion | null): boolean {
  return sesion !== null && (ROLES_OPERATIVOS as readonly string[]).includes(sesion.rol);
}
