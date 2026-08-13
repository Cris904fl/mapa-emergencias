/**
 * Detectar que se desplegó una versión nueva mientras la pestaña seguía abierta.
 *
 * Hace falta porque el tablero está pensado para dejarse abierto —se refresca
 * solo cada 20 segundos— y la aplicación no se recarga nunca por su cuenta.
 * Cambiar de vista dentro de la app no es una navegación, así que quien deja la
 * sala de crisis abierta toda la noche **no recibe nada de lo que se despliegue**
 * hasta que cierre y vuelva a entrar. Si mañana se arregla algo del índice de
 * prioridad, la persona de guardia sigue con el código de ayer y no tiene forma
 * de saberlo.
 *
 * ## Por qué no se usa el service worker
 *
 * Sería lo natural —`updatefound`, `controllerchange`— y no funciona aquí:
 * `sw.js` es un archivo estático de `public/` que se copia sin tocar, así que
 * **es idéntico byte a byte en cada despliegue**. Los que cambian de nombre son
 * los bundles, que llevan hash. El navegador compara el service worker, lo
 * encuentra igual, y no anuncia nada. Un aviso montado sobre esa señal no se
 * mostraría nunca, que es peor que no tenerlo: parecería que funciona.
 *
 * Así que se compara lo que de verdad cambia: el nombre del bundle que declara
 * el HTML. El que está corriendo se lee del propio documento, no de
 * `import.meta.url`, para que las dos mitades de la comparación salgan del mismo
 * sitio.
 *
 * El `?comprobar-version` no es un truco de caché del navegador sino del service
 * worker: sin él, esta petición cae en la rama «activos estáticos, caché
 * primero» y devolvería para siempre el `index.html` guardado, o sea la versión
 * vieja comparándose consigo misma. `sw.js` deja pasar ese parámetro.
 */

const PATRON_BUNDLE = /\/assets\/index-[A-Za-z0-9_-]+\.js/;

/** El bundle que está corriendo, según el propio documento. */
function bundleActual(): string | null {
  for (const script of document.scripts) {
    const coincidencia = script.src.match(PATRON_BUNDLE);
    if (coincidencia) return coincidencia[0];
  }
  return null;
}

/**
 * ¿El servidor está sirviendo un bundle distinto al que tenemos cargado?
 *
 * Devuelve `false` ante cualquier duda —sin red, HTML raro, en desarrollo— para
 * no ofrecerle una recarga a alguien que está trabajando por un fallo de red
 * pasajero.
 */
export async function hayVersionNueva(): Promise<boolean> {
  // En desarrollo el HTML apunta a `/src/main.tsx` y no hay bundles con hash:
  // la comparación no tiene sentido y daría un falso positivo permanente.
  if (!import.meta.env.PROD) return false;

  const actual = bundleActual();
  if (!actual) return false;

  try {
    const respuesta = await fetch('/?comprobar-version=1', { cache: 'no-store' });
    if (!respuesta.ok) return false;
    const servido = (await respuesta.text()).match(PATRON_BUNDLE)?.[0];
    return servido !== undefined && servido !== actual;
  } catch {
    return false;
  }
}
