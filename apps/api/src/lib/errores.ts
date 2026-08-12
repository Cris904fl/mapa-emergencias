/**
 * Errores de dominio con código HTTP. Existen para que las rutas no tengan que
 * construir respuestas de error a mano y para que el manejador global pueda
 * distinguir un fallo esperado (400/404/409) de un defecto del servidor, que sí
 * hay que registrar con detalle.
 */
export class ErrorHttp extends Error {
  readonly estado: number;
  readonly codigo: string;
  readonly detalles?: unknown;

  // Los campos se asignan explícitamente y no con propiedades de parámetro
  // (`constructor(readonly estado: number)`) porque Node ejecuta estos archivos
  // borrando tipos, sin transformarlos, y esa azúcar sintáctica requiere
  // generar código. La opción `erasableSyntaxOnly` del tsconfig hace que tsc
  // avise si alguien la reintroduce.
  constructor(estado: number, codigo: string, mensaje: string, detalles?: unknown) {
    super(mensaje);
    this.name = 'ErrorHttp';
    this.estado = estado;
    this.codigo = codigo;
    this.detalles = detalles;
  }
}

export const solicitudInvalida = (mensaje: string, detalles?: unknown) =>
  new ErrorHttp(400, 'solicitud_invalida', mensaje, detalles);

export const noAutenticado = (mensaje = 'Se requiere autenticación') =>
  new ErrorHttp(401, 'no_autenticado', mensaje);

export const sinPermiso = (mensaje = 'No tiene permiso para esta operación') =>
  new ErrorHttp(403, 'sin_permiso', mensaje);

export const noEncontrado = (recurso: string) =>
  new ErrorHttp(404, 'no_encontrado', `${recurso} no existe`);

export const conflicto = (mensaje: string, detalles?: unknown) =>
  new ErrorHttp(409, 'conflicto', mensaje, detalles);

/** Códigos de error de Postgres que sabemos traducir a respuestas HTTP. */
export const CODIGOS_PG = {
  VIOLACION_UNICO: '23505',
  VIOLACION_LLAVE_FORANEA: '23503',
  VIOLACION_CHECK: '23514',
  VIOLACION_NO_NULO: '23502',
} as const;

export function esErrorPg(error: unknown, codigo: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === codigo
  );
}
