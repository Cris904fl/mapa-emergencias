import type { FastifyInstance } from 'fastify';
import { bd } from '../db/pool.ts';
import { almacen } from '../servicios/almacen.ts';
import { iaHabilitada, config } from '../config.ts';
import { obtenerProveedor } from '../servicios/ia/proveedores.ts';

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

    /**
     * Dónde van a parar las fotos.
     *
     * Tampoco cuenta para el estado de «listo» —un reporte sin foto sigue
     * sirviendo— pero se informa porque el modo disco en un hospedaje efímero
     * pierde los archivos **en silencio**: la subida responde 201, la foto
     * queda en la base, y desaparece en el siguiente reinicio. Verlo acá evita
     * descubrirlo cuando alguien pregunte por una foto que ya no está.
     */
    comprobaciones.almacen_medios = {
      ok: true,
      detalle:
        almacen.descripcion +
        (config.SUPABASE_URL ? '' : ' · efímero si el disco no es persistente'),
    };

    // La IA no cuenta para el estado de "listo": es una comodidad, no un
    // requisito para recibir reportes. Se informa con detalle porque un
    // proveedor mal configurado —el modelo sin descargar, Ollama apagado— es
    // silencioso de otra forma: los reportes entran y nunca se enriquecen.
    if (!iaHabilitada) {
      comprobaciones.extraccion_ia = { ok: true, detalle: 'deshabilitada (IA_PROVEEDOR=ninguno)' };
    } else {
      const proveedor = obtenerProveedor();
      const alcanzable = proveedor ? await proveedor.disponible() : false;
      comprobaciones.extraccion_ia = {
        ok: true,
        detalle:
          `${config.IA_PROVEEDOR} · ${config.IA_MODELO} · ` +
          `${alcanzable ? 'alcanzable' : 'NO alcanzable'} · ` +
          `aplica sin revisión: ${proveedor?.confiableParaAplicar ? 'sí' : 'no'}`,
      };
    }

    const todoBien = Object.values(comprobaciones).every((c) => c.ok);
    return respuesta.code(todoBien ? 200 : 503).send({
      estado: todoBien ? 'listo' : 'no_listo',
      comprobaciones,
    });
  });
}
