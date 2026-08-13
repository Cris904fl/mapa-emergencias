import webpush from 'web-push';
import { config } from '../config.ts';
import { bd } from '../db/pool.ts';

/**
 * Avisar a quien reportó cuando su caso avanza.
 *
 * Antes de esto, un ciudadano mandaba su reporte y no volvía a saber nada: ni
 * cuando un equipo lo tomaba, ni cuando llegaba, ni cuando lo cerraban. Le
 * quedaba un código para consultar, pero eso obliga a que él vuelva a
 * preguntar — y quien acaba de reportar una emergencia no está pendiente de
 * recargar una página. Esto es lo que convierte «mandé algo a un buzón» en
 * «alguien viene».
 *
 * Se usa Web Push y no mensajes de texto porque la PWA ya tiene service
 * worker, no cuesta por mensaje, y no exige pedirle el teléfono a nadie.
 *
 * El contenido va cifrado de extremo a extremo: el servicio de push del
 * fabricante transporta el mensaje sin poder leerlo. Aun así, **el texto no
 * dice qué ocurrió ni dónde** — solo que el caso avanzó. Una notificación se ve
 * en la pantalla bloqueada, y la de un vecino no tiene por qué enterarse de que
 * en tal casa hay gente atrapada.
 */

export const notificacionesHabilitadas = Boolean(
  config.VAPID_CLAVE_PUBLICA && config.VAPID_CLAVE_PRIVADA,
);

if (notificacionesHabilitadas) {
  webpush.setVapidDetails(
    config.VAPID_CONTACTO,
    config.VAPID_CLAVE_PUBLICA!,
    config.VAPID_CLAVE_PRIVADA!,
  );
}

/**
 * Qué se le dice a la persona en cada estado.
 *
 * Solo los estados que le importan a quien reportó. `EN_TRIAGE` y `VERIFICADO`
 * son movimientos internos de la sala de crisis: notificarlos sería ruido, y el
 * ruido enseña a ignorar las notificaciones que sí importan.
 */
const MENSAJES: Record<string, { titulo: string; cuerpo: string }> = {
  ASIGNADO: {
    titulo: 'Su reporte fue asignado',
    cuerpo: 'Un equipo quedó a cargo de su caso.',
  },
  EN_ATENCION: {
    titulo: 'El equipo llegó al sitio',
    cuerpo: 'Están atendiendo su caso.',
  },
  RESUELTO: {
    titulo: 'Su caso se cerró',
    cuerpo: 'Toque para ver qué quedó registrado.',
  },
};

type Suscripcion = {
  id: string;
  endpoint: string;
  clave_p256dh: string;
  clave_auth: string;
};

/**
 * Notifica a los dispositivos suscritos a un reporte.
 *
 * No lanza nunca: un fallo notificando no puede tumbar el cambio de estado que
 * la provocó. Un equipo que marca «llegué al sitio» no puede recibir un error
 * porque el teléfono de otra persona ya no existe.
 */
export async function notificarCambioDeEstado(
  reporteId: string,
  estadoNuevo: string,
): Promise<{ enviadas: number; invalidadas: number } | null> {
  if (!notificacionesHabilitadas) return null;

  const mensaje = MENSAJES[estadoNuevo];
  if (!mensaje) return null;

  const { rows: suscripciones } = await bd.consultar<Suscripcion>(
    `SELECT id, endpoint, clave_p256dh, clave_auth
       FROM suscripciones_push
      WHERE reporte_id = $1 AND invalidado_en IS NULL`,
    [reporteId],
  );

  if (suscripciones.length === 0) return { enviadas: 0, invalidadas: 0 };

  const { rows: datos } = await bd.consultar<{ codigo_publico: string }>(
    'SELECT codigo_publico FROM reportes WHERE id = $1',
    [reporteId],
  );
  const codigo = datos[0]?.codigo_publico ?? '';

  const carga = JSON.stringify({
    titulo: mensaje.titulo,
    cuerpo: `${mensaje.cuerpo}${codigo ? ` (${codigo})` : ''}`,
    codigo,
  });

  let enviadas = 0;
  let invalidadas = 0;

  await Promise.all(
    suscripciones.map(async (s) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: s.endpoint,
            keys: { p256dh: s.clave_p256dh, auth: s.clave_auth },
          },
          carga,
        );
        enviadas++;
      } catch (error) {
        const estado = (error as { statusCode?: number }).statusCode;

        // 404 y 410 significan que ese endpoint ya no existe: la persona
        // desinstaló la app, limpió los datos del navegador o revocó el
        // permiso. Se marca en vez de borrar, para poder ver después cuántas
        // notificaciones se están perdiendo y por qué.
        if (estado === 404 || estado === 410) {
          invalidadas++;
          await bd.consultar(
            `UPDATE suscripciones_push
                SET invalidado_en = now(), ultimo_error = $2
              WHERE id = $1`,
            [s.id, `HTTP ${estado}`],
          );
        } else {
          await bd
            .consultar('UPDATE suscripciones_push SET ultimo_error = $2 WHERE id = $1', [
              s.id,
              (error as Error).message?.slice(0, 300) ?? 'error desconocido',
            ])
            .catch(() => {});
        }
      }
    }),
  );

  return { enviadas, invalidadas };
}
