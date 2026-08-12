/**
 * Reenvía /v1/* de Cloudflare Pages hacia la API.
 *
 * Por qué existe: la PWA llama a la API con rutas relativas (`/v1/...`) y eso no
 * es un descuido, es de lo que depende el modo sin conexión. Un service worker
 * **solo puede ver peticiones de su propio origen**, así que si la PWA llamara
 * directo a `https://api.ejemplo.com/v1/...`, el service worker dejaría de ver
 * los envíos y la bandeja de salida —lo que reintenta el reporte cuando vuelve
 * la señal— dejaría de funcionar. En desarrollo eso lo resuelve el proxy de
 * Vite; en producción lo resuelve este archivo.
 *
 * Configuración en Cloudflare Pages:
 *   · Directorio raíz del proyecto: apps/web
 *   · Variable de entorno: API_ORIGEN = https://tu-api.onrender.com
 */

export async function onRequest({ request, env }) {
  const destino = env.API_ORIGEN;

  // Sin la variable configurada se falla con un mensaje que dice qué falta, en
  // vez de devolver un 404 del sitio estático que haría pensar que la ruta de
  // la API está mal escrita.
  if (!destino) {
    return new Response(
      JSON.stringify({
        error: 'sin_configurar',
        mensaje: 'Falta la variable API_ORIGEN en el proyecto de Cloudflare Pages.',
      }),
      { status: 500, headers: { 'content-type': 'application/json; charset=utf-8' } },
    );
  }

  const url = new URL(request.url);
  const objetivo = new URL(url.pathname + url.search, destino);

  const cabeceras = new Headers(request.headers);

  /**
   * La IP real del visitante.
   *
   * Sin esto todas las peticiones llegarían a la API con la IP de Cloudflare, y
   * el límite de 120 por minuto —que es *por IP*— se volvería un límite de 120
   * por minuto **para todo el mundo junto**. En una emergencia, que es cuando
   * varios vecinos reportan a la vez, sería justo el momento en que deja de
   * responder. La API ya corre con `trustProxy`, así que lee esta cabecera.
   */
  const ipReal = request.headers.get('CF-Connecting-IP');
  if (ipReal) cabeceras.set('X-Forwarded-For', ipReal);

  // El Host tiene que ser el de la API, no el de Pages.
  cabeceras.delete('host');

  return fetch(
    new Request(objetivo, {
      method: request.method,
      headers: cabeceras,
      body: request.body,
      redirect: 'manual',
    }),
  );
}
