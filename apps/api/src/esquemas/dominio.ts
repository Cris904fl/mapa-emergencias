import { z } from 'zod';

/**
 * Valores del dominio, espejo de los ENUM de PostgreSQL (db/migrations/002).
 *
 * Están en un solo archivo porque los consumen tres lugares —validación de
 * peticiones, esquema de salida estructurada de la IA, y tipos de respuesta— y
 * si se duplican terminan desincronizados. Cuando se agregue un valor al ENUM
 * en una migración, este archivo es el único que hay que tocar del lado de la
 * aplicación.
 */

export const CATEGORIAS = [
  'PERSONAS_ATRAPADAS',
  'HERIDOS',
  'DESAPARECIDOS',
  'FALLECIDOS',
  'DANO_ESTRUCTURAL',
  'INCENDIO',
  'INUNDACION',
  'DESLIZAMIENTO',
  'VIA_BLOQUEADA',
  'NECESITA_AGUA',
  'NECESITA_ALIMENTO',
  'NECESITA_MEDICAMENTOS',
  'NECESITA_ALBERGUE',
  'SERVICIOS_CAIDOS',
  'OTRO',
] as const;

export const SEVERIDADES = ['CRITICA', 'ALTA', 'MEDIA', 'BAJA', 'DESCONOCIDA'] as const;

export const ESTADOS = [
  'RECIBIDO',
  'EN_TRIAGE',
  'VERIFICADO',
  'ASIGNADO',
  'EN_ATENCION',
  'RESUELTO',
  'DUPLICADO',
  'DESCARTADO',
] as const;

export const ORIGENES_DATO = ['CIUDADANO', 'IA', 'OPERADOR'] as const;

export const TIPOS_RECURSO = [
  'HOSPITAL',
  'PUESTO_SALUD',
  'ALBERGUE',
  'PUNTO_AGUA',
  'PUNTO_ALIMENTO',
  'PUESTO_MANDO',
  'ESTACION_BOMBEROS',
  'EQUIPO_RESCATE',
  'AMBULANCIA',
  'MAQUINARIA',
  'HELIPUERTO',
] as const;

export const ESTADOS_RECURSO = ['DISPONIBLE', 'OCUPADO', 'AGOTADO', 'FUERA_SERVICIO'] as const;

/** Estados en los que un reporte ya no está en la cola de atención. */
export const ESTADOS_CERRADOS = ['RESUELTO', 'DUPLICADO', 'DESCARTADO'] as const;

export const zCategoria = z.enum(CATEGORIAS);
export const zSeveridad = z.enum(SEVERIDADES);
export const zEstado = z.enum(ESTADOS);
export const zTipoRecurso = z.enum(TIPOS_RECURSO);
export const zEstadoRecurso = z.enum(ESTADOS_RECURSO);

export type Categoria = (typeof CATEGORIAS)[number];
export type Severidad = (typeof SEVERIDADES)[number];
export type Estado = (typeof ESTADOS)[number];
export type OrigenDato = (typeof ORIGENES_DATO)[number];

/**
 * Coordenadas. El rango se acota a Colombia continental e insular con un
 * margen amplio.
 *
 * No es paranoia: un GPS sin fijar reporta (0, 0) —el Golfo de Guinea— y un
 * error de signo pone el reporte en China. Ambos casos llenarían el mapa de
 * ruido y desviarían el término de concentración del índice de prioridad.
 * Rechazar temprano es preferible a limpiar después.
 */
export const zLatitud = z
  .number()
  .min(-4.5, 'Latitud fuera del territorio colombiano')
  .max(16, 'Latitud fuera del territorio colombiano');

export const zLongitud = z
  .number()
  .min(-82, 'Longitud fuera del territorio colombiano')
  .max(-66, 'Longitud fuera del territorio colombiano');
