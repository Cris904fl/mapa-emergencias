import type { z } from 'zod';
import { solicitudInvalida } from './errores.ts';

/**
 * Valida con un esquema Zod y lanza un ErrorHttp 400 con los problemas en un
 * formato estable para el cliente.
 *
 * Se validan las peticiones a mano en lugar de usar el proveedor de tipos de
 * Fastify para no acoplar el proyecto a la compatibilidad entre versiones de
 * ese plugin y de Zod: son dos dependencias que suben de major por separado, y
 * un fallo ahí rompe todas las rutas a la vez.
 */
export function validar<Esquema extends z.ZodTypeAny>(
  esquema: Esquema,
  datos: unknown,
  dondeVino = 'la petición',
): z.infer<Esquema> {
  const resultado = esquema.safeParse(datos);
  if (!resultado.success) {
    throw solicitudInvalida(
      `Datos inválidos en ${dondeVino}`,
      resultado.error.issues.map((problema) => ({
        campo: problema.path.join('.') || '(raíz)',
        mensaje: problema.message,
      })),
    );
  }
  return resultado.data;
}
