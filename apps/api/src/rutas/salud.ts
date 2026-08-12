import type { FastifyInstance } from 'fastify';
import { bd } from '../db/pool.ts';
import { iaHabilitada, config } from '../config.ts';

/**
 * Sondas de salud.
 *
 * `/salud` es un latido barato para el balanceador. `/listo` sí toca la base:
 * un proceso que responde HTTP pero no puede escribir reportes no está listo, y
 * decir lo contrario haría que el balanceador le siga mandando pedidos de
 * auxilio que se van a perder.
 */
export async function rutasSalud(app: FastifyInstance): Promise<void> {
  app.get('/salud', async () => ({
    estado: 'vivo',
    momento: new Date().toISOString(),
  }));

  app.get('/listo', async (peticion, respuesta) => {
    const comprobaciones: Record<string, { ok: boolean; detalle?: string }> = {};

    try {
      const { rows } = await bd.consultar<{ postgis: string }>('SELECT postgis_version() AS postgis');
      comprobaciones.base_de_datos = { ok: true, detalle: `PostGIS ${rows[0]?.postgis ?? '?'}` };
    } catch (error) {
      comprobaciones.base_de_datos = {
        ok: false,
        detalle: error instanceof Error ? error.message : String(error),
      };
    }

    try {
      const { rows } = await bd.consultar<{ version: number }>(
        'SELECT version FROM pesos_prioridad WHERE activa',
      );
      comprobaciones.pesos_prioridad = rows[0]
        ? { ok: true, detalle: `versión ${rows[0].version}` }
        : { ok: false, detalle: 'No hay una versión activa de pesos' };
    } catch (error) {
      comprobaciones.pesos_prioridad = {
        ok: false,
        detalle: error instanceof Error ? error.message : String(error),
      };
    }

    // La IA no cuenta para el estado de "listo": es una comodidad, no un
    // requisito para recibir reportes. Se informa y ya.
    comprobaciones.extraccion_ia = {
      ok: true,
      detalle: iaHabilitada ? `habilitada (${config.IA_MODELO})` : 'deshabilitada: sin ANTHROPIC_API_KEY',
    };

    const todoBien = Object.values(comprobaciones).every((c) => c.ok);
    return respuesta.code(todoBien ? 200 : 503).send({
      estado: todoBien ? 'listo' : 'no_listo',
      comprobaciones,
    });
  });
}
