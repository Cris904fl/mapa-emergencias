import { api } from './api.ts';

/**
 * Suscripción a avisos sobre un reporte propio.
 *
 * Decisión central: **el permiso se pide justo después de reportar**, nunca al
 * abrir la aplicación. Un navegador que pregunta «¿permitir notificaciones?»
 * antes de que la persona sepa para qué sirve el sitio recibe un «no» casi
 * siempre — y el navegador recuerda ese «no» para siempre. Pedirlo cuando el
 * reporte acaba de salir es el único momento en que la respuesta a «¿quiere que
 * le avisemos cuando alguien tome su caso?» es obviamente sí.
 *
 * Todo acá degrada en silencio: un navegador sin soporte, un permiso negado o
 * un servidor sin claves configuradas no rompen nada. Las notificaciones son
 * una comodidad; el reporte ya está guardado.
 */

export type EstadoPermiso = 'no-soportado' | 'sin-pedir' | 'concedido' | 'denegado';

export function estadoPermiso(): EstadoPermiso {
  if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
    return 'no-soportado';
  }
  if (Notification.permission === 'granted') return 'concedido';
  if (Notification.permission === 'denied') return 'denegado';
  return 'sin-pedir';
}

/** La clave pública viene del servidor: cambiarla no obliga a reconstruir la PWA. */
async function clavePublica(): Promise<string | null> {
  try {
    const { habilitadas, clave } = await api.clavePublicaNotificaciones();
    return habilitadas ? clave : null;
  } catch {
    return null;
  }
}

/**
 * La clave viaja en base64url y `PushManager` la exige como bytes.
 *
 * Es un paso mecánico pero fácil de equivocar: sin el relleno y sin traducir
 * los dos caracteres que cambian entre base64url y base64, `atob` devuelve
 * basura y la suscripción falla con un error que no dice nada útil.
 */
function base64UrlABytes(base64url: string): Uint8Array<ArrayBuffer> {
  const relleno = '='.repeat((4 - (base64url.length % 4)) % 4);
  const base64 = (base64url + relleno).replace(/-/g, '+').replace(/_/g, '/');
  const crudo = atob(base64);

  // Se construye sobre un ArrayBuffer explícito y no con `Uint8Array.from`
  // porque `applicationServerKey` exige un búfer respaldado por memoria propia:
  // el tipo genérico que infiere `from` no le sirve.
  const bytes = new Uint8Array(new ArrayBuffer(crudo.length));
  for (let i = 0; i < crudo.length; i++) bytes[i] = crudo.charCodeAt(i);
  return bytes;
}

/**
 * Pide permiso si hace falta y suscribe este dispositivo a un reporte.
 *
 * Devuelve `true` solo si quedó suscrito de verdad.
 */
export async function suscribirseAReporte(codigo: string): Promise<boolean> {
  if (estadoPermiso() === 'no-soportado' || estadoPermiso() === 'denegado') return false;

  const clave = await clavePublica();
  if (!clave) return false;

  if (Notification.permission !== 'granted') {
    const respuesta = await Notification.requestPermission();
    if (respuesta !== 'granted') return false;
  }

  try {
    const registro = await navigator.serviceWorker.ready;

    // Si ya hay una suscripción se reutiliza: el navegador devuelve la misma y
    // volver a crearla sin necesidad invalidaría la anterior.
    const suscripcion =
      (await registro.pushManager.getSubscription()) ??
      (await registro.pushManager.subscribe({
        // Obligatorio en todos los navegadores actuales: no se permite recibir
        // push silenciosos, siempre hay que mostrarle algo a la persona.
        userVisibleOnly: true,
        applicationServerKey: base64UrlABytes(clave),
      }));

    const json = suscripcion.toJSON();
    if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return false;

    await api.suscribirNotificaciones({
      codigo,
      endpoint: json.endpoint,
      claves: { p256dh: json.keys.p256dh, auth: json.keys.auth },
    });

    return true;
  } catch {
    return false;
  }
}
