/**
 * Frescura de una posición reportada.
 *
 * Vive aparte por la misma razón que los filtros de KPI: el mapa pinta el punto
 * desvanecido, la leyenda explica qué significa desvanecido y el resumen bajo el
 * mapa cuenta cuántos lo están. Si esos tres números se separan, el tablero dice
 * tres cosas distintas sobre el mismo dato y deja de ser creíble.
 *
 * Tampoco puede vivir en `componentes/Mapa.tsx`: el tablero lo necesita, y
 * importar un valor de ese módulo lo arrastraría —con MapLibre detrás— al trozo
 * de entrada que la vista «Reportar» descarga.
 */

/** Por debajo de esto la posición se considera actual. */
export const FRESCA_S = 300; // 5 min

/** A partir de acá la posición ya no sirve para decidir a quién mandar. */
export const TIBIA_S = 1800; // 30 min

/** «hace 2 min», «hace 3 h». La unidad se elige por magnitud, no por regla fija. */
export function describirAntiguedad(segundos: number): string {
  if (segundos < 60) return 'hace menos de un minuto';
  if (segundos < 3600) return `hace ${Math.round(segundos / 60)} min`;
  if (segundos < 86_400) return `hace ${Math.floor(segundos / 3600)} h`;
  return `hace ${Math.floor(segundos / 86_400)} d`;
}
