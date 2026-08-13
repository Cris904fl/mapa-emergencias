import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { config } from '../config.ts';

/**
 * Colas de trabajo.
 *
 * Todo lo lento o falible vive acá y no en el camino de la petición: extraer
 * datos con un modelo, etiquetar una foto, recalcular prioridades. La regla es
 * que ninguna de estas tareas pueda impedir que se reciba un reporte.
 */

export const NOMBRE_COLA_TRIAGE = 'triage-ia';
export const NOMBRE_COLA_IMAGENES = 'etiquetado-imagenes';
export const NOMBRE_COLA_PRIORIDAD = 'refresco-prioridad';

let conexion: Redis | undefined;
let yaSeAvisoDeRedis = false;

/**
 * Las colas se apagan dejando `REDIS_URL` vacía.
 *
 * Es la misma convención que ya usa `RUTEO_URL`: vacío significa «esta pieza no
 * está disponible, siga sin ella». Un despliegue gratuito no tiene Redis —los
 * gestionados no soportan los comandos bloqueantes que BullMQ necesita— y el
 * sistema está pensado para funcionar sin él: la prioridad se refresca por cron
 * y la extracción se dispara a demanda desde el tablero.
 */
export function colasHabilitadas(): boolean {
  return config.REDIS_URL.trim().length > 0;
}

/**
 * Cuánto se espera como mucho al encolar antes de rendirse.
 *
 * Existe porque `maxRetriesPerRequest: null` —que BullMQ exige— hace que
 * ioredis reintente **para siempre**: contra un Redis inalcanzable, `add()` no
 * se resuelve ni se rechaza, y el `await` del alta de un reporte se queda
 * colgado hasta que el cliente se rinde. El ciudadano se queda mirando una
 * pantalla que no responde mientras su reporte ya está guardado en la base.
 */
const ESPERA_MAX_ENCOLADO_MS = 2_000;

export function obtenerConexionRedis(): Redis {
  if (conexion) return conexion;

  const nueva = new Redis(config.REDIS_URL, {
    // Requerido por BullMQ: sin esto los comandos bloqueantes fallan al
    // reconectar.
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });

  /**
   * Sin este manejador el proceso se muere.
   *
   * ioredis emite `error` en cada intento fallido de conexión, y un
   * EventEmitter sin oyente de `error` convierte eso en una excepción no
   * capturada que tumba el servidor entero. Con Redis apagado, la API debe
   * seguir recibiendo reportes: es lo único que no puede fallar.
   *
   * Se avisa una sola vez para no llenar el registro con un mensaje por
   * reintento.
   */
  nueva.on('error', (error: Error & { code?: string }) => {
    if (yaSeAvisoDeRedis) return;
    yaSeAvisoDeRedis = true;
    // ioredis a veces deja `message` vacío y solo pone `code` (ECONNREFUSED,
    // ENOTFOUND). Un aviso que dice «Redis no está disponible ()» no ayuda a
    // nadie a las tres de la mañana.
    const detalle = error.message || error.code || String(error);
    console.warn(
      `Redis no está disponible (${detalle}). ` +
        'Los reportes se siguen aceptando; el enriquecimiento por IA queda a demanda. ' +
        'Para apagar las colas del todo, deje REDIS_URL vacía.',
    );
  });

  conexion = nueva;
  return conexion;
}

/** Corta la espera de una promesa que puede no resolverse nunca. */
async function conLimite<T>(promesa: Promise<T>, ms: number, accion: string): Promise<T> {
  let temporizador: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promesa,
      new Promise<never>((_, rechazar) => {
        temporizador = setTimeout(() => rechazar(new Error(`Tiempo agotado al ${accion}`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(temporizador);
  }
}

const colas = new Map<string, Queue>();

function obtenerCola(nombre: string): Queue {
  let cola = colas.get(nombre);
  if (!cola) {
    cola = new Queue(nombre, {
      connection: obtenerConexionRedis(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        // Se conservan los últimos fallos para poder revisar qué reportes no
        // se pudieron enriquecer; los éxitos se descartan pronto.
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 500 },
      },
    });
    colas.set(nombre, cola);
  }
  return cola;
}

/**
 * Encola la extracción de un reporte.
 *
 * `jobId` es el id del reporte: si el mismo reporte se encola dos veces —por
 * ejemplo porque la PWA reenvió el lote— BullMQ descarta el duplicado en lugar
 * de pagar dos veces la llamada al modelo.
 */
export async function encolarTriage(reporteId: string): Promise<void> {
  if (!colasHabilitadas()) return;
  await conLimite(
    obtenerCola(NOMBRE_COLA_TRIAGE).add('triar', { reporteId }, { jobId: `triage:${reporteId}` }),
    ESPERA_MAX_ENCOLADO_MS,
    'encolar el triage',
  );
}

export async function encolarEtiquetadoImagen(medioId: string): Promise<void> {
  if (!colasHabilitadas()) return;
  await conLimite(
    obtenerCola(NOMBRE_COLA_IMAGENES).add('etiquetar', { medioId }, { jobId: `imagen:${medioId}` }),
    ESPERA_MAX_ENCOLADO_MS,
    'encolar el etiquetado de la imagen',
  );
}

/**
 * Programa el refresco periódico de prioridades.
 *
 * Hace falta porque dos términos del índice cambian solos: el de espera crece
 * con el reloj y el de concentración cambia cuando llegan reportes vecinos. Sin
 * esto la cola se congela en el orden de la última escritura y un reporte que
 * lleva seis horas sin atención se ve igual que uno de hace cinco minutos.
 */
export async function programarRefrescoPrioridad(): Promise<void> {
  // El proceso de trabajadores sí necesita Redis; sin él no tiene nada que
  // hacer. Se dice de frente en vez de arrancar y quedarse callado.
  if (!colasHabilitadas()) {
    throw new Error(
      'REDIS_URL está vacía: los trabajadores necesitan Redis. ' +
        'En un despliegue sin Redis, use el cron sobre ' +
        'POST /v1/mantenimiento/refrescar-prioridades en lugar de este proceso.',
    );
  }

  const cola = obtenerCola(NOMBRE_COLA_PRIORIDAD);
  await cola.upsertJobScheduler(
    'refresco-periodico',
    { every: 60_000 },
    { name: 'refrescar', data: {} },
  );
}

export async function cerrarColas(): Promise<void> {
  await Promise.all([...colas.values()].map((cola) => cola.close()));
  colas.clear();
  if (conexion) {
    conexion.disconnect();
    conexion = undefined;
  }
}
