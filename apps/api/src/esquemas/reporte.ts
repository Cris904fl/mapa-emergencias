import { z } from 'zod';
import {
  zCategoria,
  zEstado,
  zEstadoRecurso,
  zLatitud,
  zLongitud,
  zSeveridad,
  zTipoRecurso,
} from './dominio.ts';

/**
 * Validación de entrada. Todo lo que llega del cliente pasa por acá antes de
 * tocar la base.
 */

export const zCrearReporte = z.object({
  /**
   * UUID generado en el dispositivo. Es la pieza que hace funcionar el modo
   * sin conexión: la PWA puede reintentar el envío N veces —al recuperar
   * señal, al reabrir la app, desde el service worker— y el servidor
   * reconoce el reenvío en lugar de crear duplicados.
   */
  id_cliente: z.string().uuid('id_cliente debe ser un UUID generado en el cliente'),

  categoria: zCategoria,
  severidad: zSeveridad.default('DESCONOCIDA'),

  descripcion: z.string().trim().max(4000).optional(),
  contacto_reportante: z.string().trim().max(200).optional(),

  lat: zLatitud,
  lng: zLongitud,
  precision_ubicacion_m: z.number().nonnegative().max(100_000).optional(),

  personas_afectadas: z.number().int().min(0).max(100_000).default(0),
  personas_atrapadas: z.number().int().min(0).max(100_000).default(0),
  personas_heridas: z.number().int().min(0).max(100_000).default(0),
  personas_fallecidas: z.number().int().min(0).max(100_000).default(0),
  personas_vulnerables: z.number().int().min(0).max(100_000).default(0),

  requiere_rescate: z.boolean().default(false),

  /**
   * Momento del hecho según el dispositivo. Se acepta del cliente porque con
   * sincronización diferida es el único dato real de cuándo ocurrió; el
   * servidor guarda aparte su propia hora de recepción en `creado_en`.
   *
   * Se rechaza una fecha futura: un reloj mal puesto en el celular podría
   * dejar el reporte con espera negativa y hundirlo en la cola.
   */
  reportado_en: z
    .string()
    .datetime({ offset: true })
    .refine((valor) => new Date(valor).getTime() <= Date.now() + 5 * 60_000, {
      message: 'reportado_en no puede estar en el futuro',
    })
    .optional(),
});

export type CrearReporte = z.infer<typeof zCrearReporte>;

/**
 * Lote de sincronización. El tope de 100 acota el tamaño de la petición: un
 * dispositivo que estuvo horas sin señal drena su bandeja en varias tandas, lo
 * cual además es más robusto en una red intermitente que un envío gigante que
 * falla completo.
 */
export const zSincronizarLote = z.object({
  reportes: z.array(zCrearReporte).min(1).max(100),
});

/** Caja envolvente "minLng,minLat,maxLng,maxLat". */
export const zBbox = z
  .string()
  .transform((valor, ctx) => {
    const partes = valor.split(',').map((parte) => Number.parseFloat(parte.trim()));
    if (partes.length !== 4 || partes.some((numero) => !Number.isFinite(numero))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'bbox debe ser "minLng,minLat,maxLng,maxLat"',
      });
      return z.NEVER;
    }
    const [minLng, minLat, maxLng, maxLat] = partes as [number, number, number, number];
    if (minLng >= maxLng || minLat >= maxLat) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'bbox invertida: el mínimo debe ser menor que el máximo',
      });
      return z.NEVER;
    }
    return { minLng, minLat, maxLng, maxLat };
  });

export const zConsultarReportes = z.object({
  bbox: zBbox.optional(),
  estado: zEstado.optional(),
  categoria: zCategoria.optional(),
  severidad: zSeveridad.optional(),
  /** Por defecto solo lo que está sin cerrar, que es el caso de uso normal. */
  incluir_cerrados: z.coerce.boolean().default(false),
  limite: z.coerce.number().int().min(1).max(1000).default(200),
  desplazamiento: z.coerce.number().int().min(0).default(0),
});

export const zConsultarCercanos = z.object({
  lat: z.coerce.number().pipe(zLatitud),
  lng: z.coerce.number().pipe(zLongitud),
  /** Radio en metros. 50 km es el techo razonable para una consulta operativa. */
  radio_m: z.coerce.number().int().min(1).max(50_000).default(2000),
  limite: z.coerce.number().int().min(1).max(200).default(50),
});

export const zCambiarEstado = z.object({
  estado: zEstado,
  nota: z.string().trim().max(1000).optional(),
  organizacion_asignada_id: z.string().uuid().optional(),
  recurso_asignado_id: z.string().uuid().optional(),
  /** Obligatorio al marcar DUPLICADO: el CHECK de la base lo exige. */
  duplicado_de_id: z.string().uuid().optional(),
});

export const zConsultarRecursos = z.object({
  bbox: zBbox.optional(),
  tipo: zTipoRecurso.optional(),
  estado: zEstadoRecurso.optional(),
  limite: z.coerce.number().int().min(1).max(1000).default(300),
});

export const zActualizarRecurso = z.object({
  estado: zEstadoRecurso.optional(),
  capacidad_usada: z.number().int().min(0).optional(),
  lat: zLatitud.optional(),
  lng: zLongitud.optional(),
  notas: z.string().trim().max(1000).optional(),
});

export const zIniciarSesion = z.object({
  correo: z.string().email(),
  clave: z.string().min(8),
});
