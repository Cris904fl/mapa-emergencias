import Anthropic from '@anthropic-ai/sdk';
import { config, iaHabilitada } from '../../config.ts';

/**
 * Cliente Anthropic compartido.
 *
 * Devuelve `null` cuando no hay clave configurada. Todo el código que consume
 * IA debe manejar ese caso: recibir un pedido de auxilio no puede depender de
 * que un servicio externo esté disponible ni pagado.
 */
let instancia: Anthropic | null | undefined;

export function obtenerClienteIa(): Anthropic | null {
  if (instancia !== undefined) return instancia;

  instancia = iaHabilitada
    ? new Anthropic({
        apiKey: config.ANTHROPIC_API_KEY,
        // 2 reintentos automáticos ante 429 y 5xx; el timeout por defecto del
        // SDK (10 min) es excesivo para una extracción corta que está en el
        // camino de un trabajador en cola.
        maxRetries: 2,
        timeout: 60_000,
      })
    : null;

  return instancia;
}

/**
 * Traduce un fallo del SDK a algo que sirva en los registros sin tumbar el
 * trabajador. Ninguna falla de IA debe perder un reporte: se registra, el
 * reporte se queda con los datos del ciudadano, y sigue.
 */
export function describirErrorIa(error: unknown): { clase: string; mensaje: string; reintentable: boolean } {
  if (error instanceof Anthropic.RateLimitError) {
    return { clase: 'limite_de_tasa', mensaje: error.message, reintentable: true };
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return { clase: 'conexion', mensaje: error.message, reintentable: true };
  }
  if (error instanceof Anthropic.AuthenticationError) {
    return { clase: 'autenticacion', mensaje: 'ANTHROPIC_API_KEY inválida', reintentable: false };
  }
  if (error instanceof Anthropic.BadRequestError) {
    return { clase: 'solicitud_invalida', mensaje: error.message, reintentable: false };
  }
  if (error instanceof Anthropic.APIError) {
    return {
      clase: `api_${error.status ?? 'desconocido'}`,
      mensaje: error.message,
      reintentable: (error.status ?? 0) >= 500,
    };
  }
  return {
    clase: 'desconocido',
    mensaje: error instanceof Error ? error.message : String(error),
    reintentable: false,
  };
}
