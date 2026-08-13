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
  /**
   * Tarea programada: mantener la API despierta y refrescar las prioridades.
   *
   * Dos cosas que el despliegue gratuito necesita de fuera:
   *
   * 1. **Despertarla.** La instancia gratuita de Render hiberna tras unos
   *    minutos sin tráfico y tarda hasta un minuto en volver. El reporte del
   *    ciudadano no se pierde —la PWA lo guarda en el teléfono antes de
   *    enviarlo— pero la aplicación parece rota justo cuando más importa.
   *
   * 2. **Refrescar la cola.** Dos términos del índice de prioridad cambian
   *    solos: la espera crece con el reloj y la concentración cambia cuando
   *    llegan reportes vecinos. Sin el trabajador de BullMQ —que necesita un
   *    Redis que aquí no hay— nadie los recalcula, y la cola se congela en el
   *    orden de la última escritura: un reporte de hace seis horas se vería
   *    igual que uno de hace cinco minutos.
   *
   * Se hace desde acá y no desde un servicio de cron externo porque el Worker ya
   * existe, no hace falta otra cuenta y la configuración queda versionada junto
   * al código que depende de ella.
   */
  async scheduled(controller, env, ctx) {
    const destino = env.API_ORIGEN;
    if (!destino) {
      console.warn('Sin API_ORIGEN: no hay a quién despertar.');
      return;
    }

    // waitUntil para que el Worker no termine antes de que salgan las
    // peticiones: despertar la instancia puede tardar bastante.
    /**
     * Un reintento, con pausa.
     *
     * Medido: contra la instancia gratuita, alrededor de una de cada tres
     * peticiones falla en la capa de red mientras despierta. Sin reintento, esa
     * de cada tres deja la instancia dormida otros diez minutos — que es
     * exactamente lo que este cron existe para evitar.
     */
    const intentar = async (accion, hacer) => {
      for (let intento = 1; intento <= 2; intento++) {
        try {
          return await hacer();
        } catch (error) {
          if (intento === 2) {
            console.warn(`${accion}: falló dos veces (${error.message})`);
            return null;
          }
          await new Promise((seguir) => setTimeout(seguir, 3_000));
        }
      }
      return null;
    };

    ctx.waitUntil(
      (async () => {
        const salud = await intentar('despertar', async () => {
          const r = await fetch(new URL('/salud', destino));
          console.log(`despertar: HTTP ${r.status}`);
          return r;
        });
        if (!salud) return;

        // El refresco exige el secreto compartido. Va como *secret* del Worker y
        // no como variable normal: `wrangler deploy` reescribe las variables con
        // las del repositorio, y un secreto no puede vivir en el repositorio.
        if (!env.SECRETO_MANTENIMIENTO) {
          console.log('Sin SECRETO_MANTENIMIENTO: no se refrescan prioridades.');
          return;
        }

        await intentar('refresco de prioridades', async () => {
          const r = await fetch(new URL('/v1/mantenimiento/refrescar-prioridades', destino), {
            method: 'POST',
            headers: { 'x-secreto-mantenimiento': env.SECRETO_MANTENIMIENTO },
          });
          console.log(`refresco de prioridades: HTTP ${r.status}`);
          return r;
        });
      })(),
    );
  },

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
