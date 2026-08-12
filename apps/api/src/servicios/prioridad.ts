import { bd } from '../db/pool.ts';

/**
 * Fachada sobre las funciones de prioridad que viven en PostgreSQL
 * (db/migrations/005_prioridad.sql).
 *
 * El cálculo está en la base y no acá a propósito: necesita los vecinos
 * espaciales y la distancia al recurso más cercano, y traer eso a Node para
 * calcularlo en JavaScript significaría varias consultas y una carrera con
 * cualquier otro proceso que esté insertando reportes. Además, tener la
 * fórmula en SQL permite auditarla y ajustarla —cambiando la fila activa de
 * `pesos_prioridad`— sin desplegar código.
 */

export type ComponentePrioridad = {
  crudo: number | string;
  normalizado: number;
  peso: number;
  aporte: number;
  unidad?: string;
};

export type DesglosePrioridad = {
  personas: ComponentePrioridad;
  severidad: ComponentePrioridad;
  aislamiento: ComponentePrioridad;
  concentracion: ComponentePrioridad;
  espera: ComponentePrioridad;
};

/** Recalcula y persiste la prioridad de un reporte. Devuelve el puntaje. */
export async function refrescarPrioridad(reporteId: string): Promise<number | null> {
  const { rows } = await bd.consultar<{ puntaje: number | null }>(
    'SELECT fn_refrescar_prioridad($1) AS puntaje',
    [reporteId],
  );
  return rows[0]?.puntaje ?? null;
}

/**
 * Calcula la prioridad sin persistirla. Útil para explicar un puntaje en la
 * interfaz sin efectos secundarios.
 */
export async function calcularPrioridad(
  reporteId: string,
): Promise<{ score: number; version: number; componentes: DesglosePrioridad } | null> {
  const { rows } = await bd.consultar<{
    calculo: { score: number; version: number; componentes: DesglosePrioridad } | null;
  }>('SELECT fn_prioridad_reporte($1) AS calculo', [reporteId]);

  return rows[0]?.calculo ?? null;
}

/**
 * Refresca en lote los reportes abiertos cuya prioridad quedó vieja.
 *
 * Hace falta porque dos de los cinco términos cambian sin que el reporte se
 * modifique: el de espera crece con el reloj y el de concentración cambia
 * cuando aparecen reportes vecinos. Sin este refresco periódico la cola se
 * congela en el orden que tenía al momento de la última escritura.
 */
export async function refrescarPrioridadesVencidas(
  desfaseSegundos = 300,
  limite = 500,
): Promise<number> {
  const { rows } = await bd.consultar<{ refrescados: number }>(
    `SELECT fn_refrescar_prioridades_vencidas(make_interval(secs => $1), $2) AS refrescados`,
    [desfaseSegundos, limite],
  );
  return rows[0]?.refrescados ?? 0;
}

/** Pesos vigentes, para mostrarlos junto al puntaje en la interfaz. */
export async function pesosVigentes(): Promise<Record<string, unknown> | null> {
  const { rows } = await bd.consultar<Record<string, unknown>>(
    'SELECT * FROM pesos_prioridad WHERE activa',
  );
  return rows[0] ?? null;
}
