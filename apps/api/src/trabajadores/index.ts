import { Worker } from 'bullmq';
import { config, iaHabilitada } from '../config.ts';
import { bd, cerrarPool } from '../db/pool.ts';
import { almacen } from '../servicios/almacen.ts';
import { triarReporteConIa } from '../servicios/triage.ts';
import { etiquetarImagen } from '../servicios/ia/imagen.ts';
import { refrescarPrioridadesVencidas } from '../servicios/prioridad.ts';
import {
  NOMBRE_COLA_IMAGENES,
  NOMBRE_COLA_PRIORIDAD,
  NOMBRE_COLA_TRIAGE,
  cerrarColas,
  obtenerConexionRedis,
  programarRefrescoPrioridad,
} from './colas.ts';

/**
 * Proceso de trabajadores. Se ejecuta aparte de la API:
 *
 *   npm run trabajadores --workspace=@emergencias/api
 *
 * Va separado para que un pico de trabajo de IA no consuma el bucle de eventos
 * que atiende las peticiones de los ciudadanos, y para poder escalar los dos
 * de forma independiente.
 */

const registrar = (mensaje: string, extra?: unknown) =>
  console.log(`[trabajadores] ${mensaje}`, extra ?? '');

const conexion = obtenerConexionRedis();

// --------------------------------------------------------------------------
// Triage: texto libre → campos estructurados
// --------------------------------------------------------------------------
const trabajadorTriage = new Worker<{ reporteId: string }>(
  NOMBRE_COLA_TRIAGE,
  async (trabajo) => {
    const resultado = await triarReporteConIa(trabajo.data.reporteId);

    // Solo los fallos reintentables se propagan como excepción para que BullMQ
    // los reintente. Una descripción demasiado corta o un reporte ya revisado
    // por una persona no son errores: son resultados legítimos, y reintentarlos
    // gastaría cuota sin cambiar nada.
    if (resultado.estado === 'fallo' && resultado.reintentable) {
      throw new Error(`Fallo reintentable (${resultado.clase}): ${resultado.motivo}`);
    }

    return resultado;
  },
  { connection: conexion, concurrency: 4 },
);

// --------------------------------------------------------------------------
// Etiquetado de imágenes
// --------------------------------------------------------------------------
const trabajadorImagenes = new Worker<{ medioId: string }>(
  NOMBRE_COLA_IMAGENES,
  async (trabajo) => {
    const { rows } = await bd.consultar<{ llave_almacen: string; tipo_mime: string }>(
      'SELECT llave_almacen, tipo_mime FROM medios_reporte WHERE id = $1 AND tipo = $2',
      [trabajo.data.medioId, 'FOTO'],
    );
    const medio = rows[0];
    if (!medio) return { estado: 'omitida', motivo: 'El medio no existe o no es una foto' };

    const bytes = await almacen.leer(medio.llave_almacen);
    if (!bytes) return { estado: 'omitida', motivo: 'No se encontró el archivo en el almacén' };

    const resultado = await etiquetarImagen(bytes, medio.tipo_mime);

    if (!resultado.ok) {
      if (resultado.reintentable) {
        throw new Error(`Fallo reintentable (${resultado.clase}): ${resultado.motivo}`);
      }
      return { estado: 'fallo', motivo: resultado.motivo };
    }

    await bd.consultar(
      `UPDATE medios_reporte
          SET etiquetas_ia = $2, modelo_ia = $3, analizado_en = now()
        WHERE id = $1`,
      [trabajo.data.medioId, JSON.stringify(resultado.etiquetas), resultado.modelo],
    );

    return { estado: 'etiquetada', personas_visibles: resultado.etiquetas.personas_visibles };
  },
  { connection: conexion, concurrency: 2 },
);

// --------------------------------------------------------------------------
// Refresco periódico de prioridades
// --------------------------------------------------------------------------
const trabajadorPrioridad = new Worker(
  NOMBRE_COLA_PRIORIDAD,
  async () => {
    const refrescados = await refrescarPrioridadesVencidas(300, 500);
    return { refrescados };
  },
  { connection: conexion, concurrency: 1 },
);

for (const [nombre, trabajador] of [
  ['triage', trabajadorTriage],
  ['imagenes', trabajadorImagenes],
  ['prioridad', trabajadorPrioridad],
] as const) {
  trabajador.on('completed', (trabajo, resultado) => {
    registrar(`${nombre} ok`, { id: trabajo.id, resultado });
  });
  trabajador.on('failed', (trabajo, error) => {
    registrar(`${nombre} FALLÓ`, {
      id: trabajo?.id,
      intento: trabajo?.attemptsMade,
      error: error.message,
    });
  });
}

await programarRefrescoPrioridad();

registrar(
  iaHabilitada
    ? `en marcha. Extracción con ${config.IA_MODELO}.`
    : 'en marcha. Sin ANTHROPIC_API_KEY: solo se refrescan prioridades.',
);

async function apagar(senal: string): Promise<void> {
  registrar(`${senal} recibida, cerrando`);
  await Promise.all([
    trabajadorTriage.close(),
    trabajadorImagenes.close(),
    trabajadorPrioridad.close(),
  ]);
  await cerrarColas();
  await cerrarPool();
  process.exit(0);
}

process.on('SIGTERM', () => void apagar('SIGTERM'));
process.on('SIGINT', () => void apagar('SIGINT'));
