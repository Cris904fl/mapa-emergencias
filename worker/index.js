/**
 * Worker de Cloudflare que sirve la PWA y reenvía /v1 a la API.
 *
 * Por qué el reenvío: la PWA llama a la API con rutas relativas (`/v1/...`) y
 * eso no es un descuido, es de lo que depende el modo sin conexión. Un service
 * worker **solo puede ver peticiones de su propio origen**, así que si la PWA
 * llamara directo a `https://api.ejemplo.com/v1/...`, dejaría de ver los envíos
 * y la bandeja de salida —lo que reintenta el reporte cuando vuelve la señal—
 * dejaría de funcionar. En desarrollo lo resuelve el proxy de Vite; en
 * producción lo resuelve este archivo.
 *
 * Nació como una Pages Function. Se pasó a Worker porque el panel de Cloudflare
 * dejó de ofrecer Pages para proyectos nuevos; la lógica es la misma.
 *
 * Configuración: ver wrangler.jsonc y la variable API_ORIGEN.
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Todo lo que no sea la API es la PWA: index.html, el bundle, el service
    // worker, el manifiesto.
    if (!url.pathname.startsWith('/v1/')) {
      return env.ASSETS.fetch(request);
    }

    const destino = env.API_ORIGEN;

    // Sin la variable configurada se falla diciendo qué falta, en vez de
    // devolver el 404 del sitio estático, que haría pensar que la ruta de la
    // API está mal escrita.
    if (!destino) {
      return Response.json(
        {
          error: 'sin_configurar',
          mensaje: 'Falta la variable API_ORIGEN en el proyecto de Cloudflare.',
        },
        { status: 500 },
      );
    }

    const objetivo = new URL(url.pathname + url.search, destino);
    const cabeceras = new Headers(request.headers);

    /**
     * La IP real del visitante.
     *
     * Sin esto todas las peticiones llegarían a la API con la IP de Cloudflare,
     * y el límite de 120 por minuto —que es *por IP*— se volvería un límite de
     * 120 por minuto **para todo el mundo junto**. En una emergencia, que es
     * cuando varios vecinos reportan a la vez, sería justo el momento en que
     * deja de responder. La API corre con `trustProxy`, así que lee esta
     * cabecera.
     */
    const ipReal = request.headers.get('CF-Connecting-IP');
    if (ipReal) cabeceras.set('X-Forwarded-For', ipReal);

    // El Host tiene que ser el de la API, no el del sitio.
    cabeceras.delete('host');

    return fetch(
      new Request(objetivo, {
        method: request.method,
        headers: cabeceras,
        body: request.body,
        redirect: 'manual',
      }),
    );
  },
};
