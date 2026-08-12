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

export function obtenerConexionRedis(): Redis {
  conexion ??= new Redis(config.REDIS_URL, {
    // Requerido por BullMQ: sin esto los comandos bloqueantes fallan al
    // reconectar.
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
  return conexion;
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
  await obtenerCola(NOMBRE_COLA_TRIAGE).add(
    'triar',
    { reporteId },
    { jobId: `triage:${reporteId}` },
  );
}

export async function encolarEtiquetadoImagen(medioId: string): Promise<void> {
  await obtenerCola(NOMBRE_COLA_IMAGENES).add(
    'etiquetar',
    { medioId },
    { jobId: `imagen:${medioId}` },
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
