import {
  descontarFotoPendiente,
  eliminarFoto,
  fotosDe,
  guardarEnBandeja,
  listarBandeja,
  marcarEstado,
  pendientesDeEnvio,
  purgarConfirmados,
  registrarIntentoFallido,
  type CargaReporte,
  type ElementoBandeja,
} from './bd.ts';

/**
 * Sincronización de la bandeja de salida.
 *
 * Estrategia deliberada de varias capas, porque ninguna sola es confiable en la
 * red de una emergencia:
 *
 *   1. Intento inmediato al enviar el formulario.
 *   2. Evento `online` del navegador — dispara en cuanto vuelve la señal.
 *   3. Temporizador cada 30 s — el evento `online` miente con frecuencia:
 *      reporta conexión cuando hay wifi asociado pero sin salida real.
 *   4. Background Sync del service worker — es la única que funciona con la
 *      pestaña cerrada.
 *
 * Todos los caminos convergen en la misma función, y todos son seguros de
 * repetir porque el alta en la API es idempotente por `id_cliente`.
 */

export type ResultadoSincronizacion = {
  intentados: number;
  confirmados: number;
  fallidos: number;
  fotos_subidas: number;
  sin_red: boolean;
};

const oyentes = new Set<() => void>();

/** Notifica a la interfaz que la bandeja cambió. */
export function alCambiarBandeja(oyente: () => void): () => void {
  oyentes.add(oyente);
  return () => oyentes.delete(oyente);
}

function notificar(): void {
  for (const oyente of oyentes) oyente();
}

/**
 * Punto único de entrada para crear un reporte: guarda en el dispositivo,
 * avisa a la interfaz y recién entonces intenta enviar.
 *
 * El aviso a la interfaz va acá y no colgado del resultado del envío. Ese fue
 * un error real de la primera versión: sin conexión, el reporte se guardaba
 * bien pero la pantalla no mostraba nada, porque la notificación solo se
 * disparaba cuando la sincronización tenía éxito. El resultado era el peor
 * posible para esta aplicación — la persona apretaba «Enviar», no veía
 * absolutamente nada, y no tenía forma de saber si su pedido de auxilio quedó
 * registrado o se perdió.
 */
export async function agregarALaBandeja(
  carga: CargaReporte,
  fotos: Blob[] = [],
): Promise<void> {
  await guardarEnBandeja(carga, fotos);
  notificar();

  // El envío se dispara sin esperarlo: que la red esté caída no debe demorar
  // la confirmación en pantalla.
  void sincronizarBandeja();
  void pedirSincronizacionEnSegundoPlano();
}

let sincronizando = false;

export async function sincronizarBandeja(): Promise<ResultadoSincronizacion> {
  const vacio: ResultadoSincronizacion = {
    intentados: 0,
    confirmados: 0,
    fallidos: 0,
    fotos_subidas: 0,
    sin_red: false,
  };

  // Un solo sincronizador a la vez: si coinciden el temporizador y el evento
  // `online`, el segundo no debe duplicar trabajo.
  if (sincronizando) return vacio;
  sincronizando = true;

  try {
    const pendientes = await pendientesDeEnvio();
    if (pendientes.length === 0) {
      await subirFotosPendientes();
      await purgarConfirmados();
      return vacio;
    }

    if (!navigator.onLine) {
      // Se notifica igual: la interfaz debe poder reflejar que hay elementos
      // esperando aunque no se haya intentado nada.
      notificar();
      return { ...vacio, intentados: pendientes.length, sin_red: true };
    }

    const resultado = await enviarLote(pendientes);
    const fotosSubidas = await subirFotosPendientes();
    await purgarConfirmados();

    notificar();
    return { ...resultado, fotos_subidas: fotosSubidas };
  } finally {
    sincronizando = false;
  }
}

/** Envía en tandas de 25 para que una red intermitente no tumbe todo el lote. */
async function enviarLote(
  pendientes: ElementoBandeja[],
): Promise<Omit<ResultadoSincronizacion, 'fotos_subidas'>> {
  const TAMANO_TANDA = 25;
  let confirmados = 0;
  let fallidos = 0;

  for (let inicio = 0; inicio < pendientes.length; inicio += TAMANO_TANDA) {
    const tanda = pendientes.slice(inicio, inicio + TAMANO_TANDA);

    for (const elemento of tanda) {
      await marcarEstado(elemento.id_cliente, 'enviando');
    }

    try {
      const respuesta = await fetch('/v1/reportes/sincronizar', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reportes: tanda.map((elemento) => elemento.carga) }),
      });

      if (!respuesta.ok) {
        // 400 es un rechazo permanente: la carga no es válida y reintentar no
        // va a cambiar nada. Se marca como rechazado para que la interfaz lo
        // muestre y el ciudadano pueda corregirlo, en lugar de reintentar
        // eternamente en silencio.
        const permanente = respuesta.status >= 400 && respuesta.status < 500;
        const detalle = await respuesta.text().catch(() => `HTTP ${respuesta.status}`);

        for (const elemento of tanda) {
          if (permanente) {
            await marcarEstado(elemento.id_cliente, 'rechazado', { ultimo_error: detalle });
          } else {
            await registrarIntentoFallido(elemento.id_cliente, detalle);
          }
          fallidos++;
        }
        continue;
      }

      const cuerpo = (await respuesta.json()) as {
        resultados: { id_cliente: string; id: string; codigo_publico: string }[];
      };

      for (const confirmado of cuerpo.resultados) {
        await marcarEstado(confirmado.id_cliente, 'confirmado', {
          id_servidor: confirmado.id,
          codigo_publico: confirmado.codigo_publico,
          ultimo_error: undefined,
        });
        confirmados++;
      }
    } catch (error) {
      // Fallo de red: no es culpa de la carga, se reintenta.
      const mensaje = error instanceof Error ? error.message : 'Error de red';
      for (const elemento of tanda) {
        await registrarIntentoFallido(elemento.id_cliente, mensaje);
        fallidos++;
      }
    }
  }

  return { intentados: pendientes.length, confirmados, fallidos, sin_red: false };
}

/**
 * Sube las fotos de los reportes ya confirmados.
 *
 * Va después del texto y por separado a propósito: el reporte es lo que salva
 * vidas y pesa un kilobyte; la foto es evidencia complementaria y pesa cientos.
 * En una red que apenas responde, mandar primero lo liviano y completo es mejor
 * que quedarse a mitad de una subida grande.
 */
async function subirFotosPendientes(): Promise<number> {
  if (!navigator.onLine) return 0;

  const elementos = await listarBandeja();
  let subidas = 0;

  for (const elemento of elementos) {
    if (elemento.estado !== 'confirmado' || !elemento.id_servidor) continue;
    if (elemento.fotos_pendientes === 0) continue;

    for (const foto of await fotosDe(elemento.id_cliente)) {
      try {
        const formulario = new FormData();
        formulario.append('archivo', foto.blob, `${foto.id}.jpg`);

        const respuesta = await fetch(`/v1/reportes/${elemento.id_servidor}/medios`, {
          method: 'POST',
          body: formulario,
        });

        if (respuesta.ok) {
          await eliminarFoto(foto.id);
          await descontarFotoPendiente(elemento.id_cliente);
          subidas++;
        } else if (respuesta.status >= 400 && respuesta.status < 500) {
          // Archivo no aceptado: descartarlo en lugar de reintentar siempre.
          await eliminarFoto(foto.id);
          await descontarFotoPendiente(elemento.id_cliente);
        }
      } catch {
        // Sin red: se queda para el próximo intento.
        return subidas;
      }
    }
  }

  return subidas;
}

/**
 * Pide al service worker un Background Sync.
 *
 * Es lo único que permite enviar con la pestaña cerrada. No está en todos los
 * navegadores —Safari no lo implementa— así que es un extra sobre las otras
 * capas, nunca el único mecanismo.
 */
export async function pedirSincronizacionEnSegundoPlano(): Promise<boolean> {
  if (!('serviceWorker' in navigator)) return false;

  try {
    const registro = (await navigator.serviceWorker.ready) as ServiceWorkerRegistration & {
      sync?: { register: (etiqueta: string) => Promise<void> };
    };
    if (!registro.sync) return false;
    await registro.sync.register('sincronizar-bandeja');
    return true;
  } catch {
    return false;
  }
}

let temporizador: number | undefined;

/** Arranca las capas de reintento. Se llama una vez al iniciar la aplicación. */
export function iniciarSincronizacionAutomatica(): () => void {
  const alVolverLaRed = () => void sincronizarBandeja();

  window.addEventListener('online', alVolverLaRed);

  // El temporizador existe porque `navigator.onLine` y el evento `online` solo
  // saben si hay una interfaz de red asociada, no si hay salida a internet.
  // En una emergencia es muy común estar conectado a una antena que no cursa
  // tráfico: sin este reintento periódico la bandeja no se drenaría nunca.
  temporizador = window.setInterval(() => void sincronizarBandeja(), 30_000);

  // El service worker avisa cuando drenó la bandeja por su cuenta.
  navigator.serviceWorker?.addEventListener('message', (evento: MessageEvent) => {
    if ((evento.data as { tipo?: string })?.tipo === 'bandeja-sincronizada') notificar();
  });

  void sincronizarBandeja();

  return () => {
    window.removeEventListener('online', alVolverLaRed);
    if (temporizador !== undefined) window.clearInterval(temporizador);
  };
}
