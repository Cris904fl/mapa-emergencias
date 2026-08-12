import { z } from 'zod';

/**
 * Filtros del tablero, uno por cada cifra de cabecera.
 *
 * Están definidos en un solo lugar porque los consumen tres rutas —la cola, el
 * GeoJSON del mapa y el resumen— y tienen que coincidir exactamente. Si el
 * mosaico dice "3 críticos" y al tocarlo la lista muestra cuatro, el operador
 * deja de confiar en el tablero, y con razón.
 *
 * Cada filtro es la condición SQL que corresponde a su cifra. Se escriben acá y
 * no en cada consulta para que la definición de "sin atender" sea una sola.
 */

export const FILTROS = {
  abiertos: {
    etiqueta: 'abiertos',
    // Sin condición extra: la exclusión de cerrados ya la aplican las consultas.
    condicion: null,
  },
  criticos: {
    etiqueta: 'críticos',
    condicion: `r.severidad = 'CRITICA'`,
  },
  atrapadas: {
    etiqueta: 'con personas atrapadas',
    condicion: 'r.personas_atrapadas > 0',
  },
  heridas: {
    etiqueta: 'con personas heridas',
    condicion: 'r.personas_heridas > 0',
  },
  sin_atender: {
    etiqueta: 'sin atender',
    // "Sin atender" es que nadie se haya hecho cargo, no un estado: un reporte
    // puede estar EN_TRIAGE y seguir sin que nadie haya salido a campo.
    condicion: 'r.primera_respuesta_en IS NULL',
  },
  sin_triage: {
    etiqueta: 'sin triage',
    condicion: `r.estado = 'RECIBIDO'`,
  },
  rescate: {
    etiqueta: 'con rescate pendiente',
    condicion: 'r.requiere_rescate',
  },
  ia_sin_revisar: {
    etiqueta: 'con datos de IA sin revisar',
    // Es el filtro que permite a un operador ir directo a lo que un modelo tocó
    // y nadie confirmó todavía.
    condicion: `r.origen_triage = 'IA'`,
  },
  sin_responsable: {
    etiqueta: 'sin responsable en campo',
    condicion: 'r.responsable_id IS NULL',
  },
  resueltos: {
    etiqueta: 'resueltos',
    condicion: `r.estado = 'RESUELTO'`,
    /** Este filtro necesita ver los cerrados, al contrario que los demás. */
    incluyeCerrados: true,
  },
} as const;

export type NombreFiltro = keyof typeof FILTROS;

export const zFiltro = z.enum(
  Object.keys(FILTROS) as [NombreFiltro, ...NombreFiltro[]],
);

/**
 * Devuelve la condición SQL del filtro y si hay que dejar de excluir los
 * reportes cerrados.
 *
 * Las condiciones son cadenas fijas de este archivo, nunca entrada del usuario:
 * lo que llega por la petición es el *nombre* del filtro, validado contra el
 * enum. Por eso se pueden interpolar sin riesgo de inyección.
 */
export function condicionDeFiltro(
  nombre: NombreFiltro | undefined,
): { condicion: string | null; incluyeCerrados: boolean } {
  if (!nombre) return { condicion: null, incluyeCerrados: false };

  const filtro = FILTROS[nombre];
  return {
    condicion: filtro.condicion,
    incluyeCerrados: 'incluyeCerrados' in filtro ? filtro.incluyeCerrados : false,
  };
}

/** Etiqueta legible, para que la interfaz muestre qué está filtrando. */
export function etiquetaDeFiltro(nombre: NombreFiltro): string {
  return FILTROS[nombre].etiqueta;
}
