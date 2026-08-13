import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.ts';
import { bd } from '../db/pool.ts';
import { noEncontrado, solicitudInvalida } from '../lib/errores.ts';
import { validar } from '../lib/validar.ts';
import { notificacionesHabilitadas } from '../servicios/notificaciones.ts';

/**
 * Suscripción de un dispositivo a los cambios de un reporte.
 *
 * Abierta sin autenticación, igual que el alta de reportes y por la misma
 * razón: quien pide auxilio no tiene cuenta. Lo que evita el abuso es que hay
 * que conocer el **código público** del reporte, que solo tiene quien lo hizo
 * (o alguien a quien se lo pasó, que es un caso legítimo: un familiar
 * siguiendo el caso).
 */

const zSuscribir = z.object({
  codigo: z.string().trim().min(3).max(20),
  endpoint: z.string().url().max(1000),
  claves: z.object({
    p256dh: z.string().min(20).max(200),
    auth: z.string().min(10).max(100),
  }),
});

export async function rutasNotificaciones(app: FastifyInstance): Promise<void> {
  /**
   * Clave pública VAPID, que la PWA necesita para suscribirse.
   *
   * Es pública por diseño —va en el navegador de cualquiera— pero se sirve
   * desde acá en vez de incrustarla en el bundle para que cambiarla no exija
   * reconstruir y volver a desplegar la aplicación web.
   */
  app.get('/v1/notificaciones/clave-publica', async () => {
    if (!notificacionesHabilitadas) {
      return { habilitadas: false, clave: null };
    }
    return { habilitadas: true, clave: config.VAPID_CLAVE_PUBLICA };
  });

  app.post('/v1/notificaciones/suscribir', async (peticion, respuesta) => {
    if (!notificacionesHabilitadas) {
      throw solicitudInvalida('Las notificaciones no están configuradas en este servidor');
    }

    const entrada = validar(zSuscribir, peticion.body, 'la suscripción');

    const { rows } = await bd.consultar<{ id: string }>(
      'SELECT id FROM reportes WHERE codigo_publico = upper($1)',
      [entrada.codigo],
    );
    const reporte = rows[0];
    if (!reporte) throw noEncontrado('El reporte');

    // Idempotente: el navegador devuelve la misma suscripción cada vez que se
    // abre la app, así que suscribirse dos veces al mismo caso es lo normal y
    // no un error. Y si el endpoint estaba marcado como muerto, revive: la
    // persona volvió a dar permiso.
    await bd.consultar(
      `INSERT INTO suscripciones_push (reporte_id, endpoint, clave_p256dh, clave_auth)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (reporte_id, endpoint) DO UPDATE
          SET clave_p256dh = excluded.clave_p256dh,
              clave_auth = excluded.clave_auth,
              invalidado_en = NULL,
              ultimo_error = NULL`,
      [reporte.id, entrada.endpoint, entrada.claves.p256dh, entrada.claves.auth],
    );

    return respuesta.code(201).send({ suscrito: true });
  });
}
