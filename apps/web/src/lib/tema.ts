/**
 * Tema claro u oscuro, con elección explícita que sobrevive al cierre.
 *
 * Tres estados y no dos: `sistema` es el de partida y no es lo mismo que
 * «claro». Alguien que nunca tocó el botón debe seguir al teléfono —que pasa a
 * oscuro al anochecer, justo cuando importa para quien va a atender de noche—,
 * y alguien que eligió claro a las tres de la tarde no debe encontrarse la
 * pantalla oscura a las siete. Un interruptor de dos posiciones obliga a decidir
 * por él en el primer arranque y pierde el automático para siempre.
 *
 * El atributo `data-tema` de `<html>` lo escribe también un script en línea en
 * `index.html`, antes de que pinte la página. Sin eso habría un destello claro
 * en cada carga: el HTML se dibuja antes de que React arranque. Esa duplicación
 * es a propósito y está anotada en los dos sitios.
 */

const LLAVE = 'tema';

export type Tema = 'sistema' | 'claro' | 'oscuro';
/** Lo que de verdad se pinta: `sistema` ya está resuelto. */
export type TemaResuelto = 'claro' | 'oscuro';

const CONSULTA_OSCURO = '(prefers-color-scheme: dark)';

function esTema(valor: string | null): valor is Tema {
  return valor === 'sistema' || valor === 'claro' || valor === 'oscuro';
}

/**
 * La preferencia guardada.
 *
 * `localStorage` lanza en algunos modos de privacidad, y quedarse sin tema es un
 * precio absurdo por eso: ante cualquier fallo se sigue al sistema.
 */
export function temaGuardado(): Tema {
  try {
    const valor = localStorage.getItem(LLAVE);
    return esTema(valor) ? valor : 'sistema';
  } catch {
    return 'sistema';
  }
}

export function temaDelSistema(): TemaResuelto {
  return window.matchMedia(CONSULTA_OSCURO).matches ? 'oscuro' : 'claro';
}

export function resolver(tema: Tema): TemaResuelto {
  return tema === 'sistema' ? temaDelSistema() : tema;
}

/** Escribe el tema en el documento. Es lo único que el CSS mira. */
export function aplicar(tema: Tema): void {
  document.documentElement.dataset.tema = resolver(tema);
}

export function guardar(tema: Tema): void {
  aplicar(tema);
  try {
    localStorage.setItem(LLAVE, tema);
  } catch {
    // Se aplicó igual; solo no sobrevivirá al cierre. Peor sería no aplicarlo.
  }
}

/**
 * Avisa cuando el sistema cambia de tema, para repintar sin recargar.
 *
 * Solo importa mientras la preferencia sea `sistema`: quien eligió a mano no
 * quiere que el atardecer le cambie la pantalla. Devuelve la función para dejar
 * de escuchar.
 */
export function alCambiarElSistema(escuchar: () => void): () => void {
  const consulta = window.matchMedia(CONSULTA_OSCURO);
  consulta.addEventListener('change', escuchar);
  return () => consulta.removeEventListener('change', escuchar);
}

/** El siguiente en la rueda del botón. */
export function siguiente(tema: Tema): Tema {
  return tema === 'sistema' ? 'claro' : tema === 'claro' ? 'oscuro' : 'sistema';
}

export const ETIQUETAS: Record<Tema, { icono: string; nombre: string }> = {
  sistema: { icono: '◐', nombre: 'automático' },
  claro: { icono: '☀', nombre: 'claro' },
  oscuro: { icono: '☾', nombre: 'oscuro' },
};
