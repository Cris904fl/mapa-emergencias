import { z } from 'zod';
import { CATEGORIAS, SEVERIDADES } from '../../esquemas/dominio.ts';
import { obtenerProveedor } from './proveedores.ts';

/**
 * Extracción estructurada de reportes en texto libre.
 *
 * El único trabajo del modelo acá es convertir lo que una persona escribió a la
 * carrera —"estamos atrapados en una casa cerca del parque, somos 5 y una señora
 * está herida"— en campos con los que se pueda consultar y ordenar. No decide a
 * quién se rescata primero.
 *
 * El esquema y el prompt de este archivo no son un primer borrador: salieron de
 * medir tres versiones contra qwen2.5:7b en CPU. El registro está en
 * docs/ia-local.md; los dos hallazgos que dieron forma a lo de abajo son el
 * orden de los campos y la escapatoria para cantidades desconocidas.
 */

export const VERSION_PROMPT = 'extraccion-v3';

/**
 * Esquema de salida.
 *
 * **El orden de los campos es funcional, no estético.** Bajo decodificación
 * restringida el JSON se emite en el orden del esquema, así que el modelo tiene
 * que comprometerse con cada campo en ese orden. La primera versión ponía
 * `categoria` al principio y acertaba 1 de 4: el modelo elegía la categoría
 * antes de haber razonado nada. Poniendo `justificacion` primero —donde razona
 * en prosa— y las clasificaciones al final, la precisión subió a 6 de 7 con el
 * mismo modelo. Es cadena de pensamiento dentro de la salida estructurada.
 *
 * Si alguien reordena estos campos, la calidad de la extracción cae. Vale la
 * pena volver a medir antes de tocarlo.
 */
export const EsquemaExtraccion = z.object({
  // 1. Razonar primero, en prosa.
  justificacion: z
    .string()
    .describe('Una o dos frases sobre qué dice el reporte y qué necesita esa gente.'),

  /**
   * 2. La escapatoria explícita.
   *
   * Sin este campo el modelo inventaba cifras: "varias personas" se convertía en
   * 5, "no sabemos cuántos hay adentro" en 1. Es el peor error posible del
   * sistema, porque ese número ordena la cola de rescate. Darle un booleano
   * dedicado —una salida más fácil de tomar que inventar— llevó las cifras
   * inventadas a cero en la medición.
   */
  cantidad_indeterminada: z
    .boolean()
    .describe('true si el texto dice que hay personas pero no cuántas.'),

  // 3. Conteos. Es lo que el modelo hace mejor cuando el texto los da explícitos.
  personas_afectadas: z.number().int().min(0).describe('Total de personas involucradas.'),
  personas_atrapadas: z.number().int().min(0),
  personas_heridas: z.number().int().min(0),
  personas_fallecidas: z.number().int().min(0),
  personas_vulnerables: z
    .number()
    .int()
    .min(0)
    .describe('Menores, adultos mayores, gestantes o personas con discapacidad mencionadas.'),
  requiere_rescate: z
    .boolean()
    .describe('true solo si hay personas que no pueden salir por sus propios medios.'),

  // 4. Clasificaciones al final, ya con el razonamiento hecho.
  severidad: z.enum(SEVERIDADES),
  categoria: z.enum(CATEGORIAS),
  confianza: z.enum(['ALTA', 'MEDIA', 'BAJA']),
});

export type Extraccion = z.infer<typeof EsquemaExtraccion>;

/**
 * Instrucciones.
 *
 * Escrito para modelos actuales: sin mayúsculas de énfasis del tipo "CRITICAL:
 * YOU MUST", que producen sobreactivación. Lo que sí lleva es el contexto que el
 * modelo no puede adivinar —el uso colombiano del español, qué significa cada
 * categoría en este dominio, y la consecuencia real de inflar un número— porque
 * eso es lo único que no está en su entrenamiento.
 *
 * La guía de categorías con reglas de desempate se agregó porque sin ella el
 * modelo confundía DANO_ESTRUCTURAL con PERSONAS_ATRAPADAS y con
 * NECESITA_ALBERGUE, que son tres despachos distintos.
 */
const INSTRUCCIONES = `Extraes datos estructurados de reportes ciudadanos de emergencia escritos en español colombiano, tal como los envía la gente: apurados, con errores de tipeo, en voz de vecino y con regionalismos.

Contexto de uso
Este dato entra a una sala de crisis. Los conteos que produzcas alimentan una cola de atención que ordena en qué orden salen los equipos de rescate. Un número inflado desvía recursos de alguien que sí los necesita.

Responde los campos en el orden del esquema. Empieza por "justificacion": una o dos frases sobre qué dice el reporte y qué necesita esa gente. Ese razonamiento sustenta todo lo demás.

CUANDO NO SE SABE LA CANTIDAD
Si el texto indica que hay personas pero no dice cuántas -"varias personas", "no sabemos cuántos hay adentro", "hay gente"- pon cantidad_indeterminada en true y deja TODOS los conteos en 0. No estimes, no supongas, no pongas 1 ni 5.
Que la cantidad sea desconocida es un dato valioso por sí mismo: el operador sabrá que tiene que averiguarla. Inventar una cifra es peor que dejarla en cero.
Si el texto sí da cifras, pon cantidad_indeterminada en false.

CONTEO DE PERSONAS
Cuenta solo lo que el texto sostiene. Si dice "somos 5", son 5.
personas_afectadas es el TOTAL de personas involucradas; atrapadas, heridas y fallecidas son subconjuntos de ese total.
Cantidades de vivienda no son cantidades de persona: "somos como 40 casas" son 0 afectadas.
Expresiones colombianas que cuentan como personas vulnerables: "el abuelito", "mi mamá que está viejita", "los pelados", "los chinos" (niños), "una señora en embarazo", "mi hijo que es discapacitado".
requiere_rescate es true solo si hay personas que no pueden salir por sus propios medios. Quedarse sin techo no es estar atrapado. Una vía bloqueada tampoco: eso impide el paso de vehículos, no atrapa personas.

SEVERIDAD
CRITICA: vidas en riesgo inmediato (personas atrapadas, heridos graves, riesgo de colapso, el agua sigue subiendo).
ALTA: riesgo para la integridad no inminente, o heridos leves.
MEDIA: necesidad material urgente sin riesgo de vida (agua, alimento, albergue).
BAJA: daño material sin personas afectadas.
DESCONOCIDA: el texto no da elementos para juzgar. Es una respuesta válida y preferible a adivinar.

CATEGORIA: la necesidad principal, la que define qué equipo debe salir.
PERSONAS_ATRAPADAS: hay gente que no puede salir. Gana sobre DANO_ESTRUCTURAL, INCENDIO, INUNDACION y DESLIZAMIENTO cuando hay personas adentro que no pueden salir.
HERIDOS: lesionados que necesitan atención médica, sin nadie atrapado.
DESAPARECIDOS: no se sabe dónde está alguien.
FALLECIDOS: hay personas muertas. Solo si el texto lo dice.
DANO_ESTRUCTURAL: grietas, techos o muros dañados, sin gente atrapada y sin que la familia haya quedado sin vivienda.
INCENDIO: hay fuego.
INUNDACION: hay agua donde no debería.
DESLIZAMIENTO: se movió la tierra o un talud.
VIA_BLOQUEADA: no pueden pasar vehículos.
NECESITA_AGUA / NECESITA_ALIMENTO / NECESITA_MEDICAMENTOS: falta ese recurso.
NECESITA_ALBERGUE: la vivienda quedó inhabitable y la gente no tiene dónde quedarse. Gana sobre DANO_ESTRUCTURAL cuando el texto deja claro que se quedaron sin techo.
SERVICIOS_CAIDOS: sin energía, acueducto o telecomunicaciones.
OTRO: nada de lo anterior aplica.

CONFIANZA
ALTA: el texto era explícito. MEDIA: hubo algo de interpretación. BAJA: tuviste que inferir bastante, o la cantidad de personas es indeterminada.

Justificación
La leerá un operador que tiene el reporte original al lado y necesita decidir rápido si tu lectura es correcta.`;

export type ResultadoExtraccion =
  | {
      ok: true;
      propuesta: Extraccion;
      modelo: string;
      versionPrompt: string;
      tokensEntrada: number;
      tokensSalida: number;
      latenciaMs: number;
      /** ¿El proveedor está autorizado a escribir sin revisión humana? */
      confiableParaAplicar: boolean;
    }
  | { ok: false; motivo: string; clase: string; reintentable: boolean };

/**
 * Estructura un reporte en texto libre. Nunca lanza: el llamador es un
 * trabajador en cola y un fallo de IA no debe reintentarse eternamente ni
 * tumbar el proceso.
 */
export async function extraerDeTexto(
  descripcion: string,
  contexto: { categoriaDeclarada?: string | null } = {},
): Promise<ResultadoExtraccion> {
  const proveedor = obtenerProveedor();
  if (!proveedor) {
    return {
      ok: false,
      motivo: 'IA_PROVEEDOR está en "ninguno"',
      clase: 'deshabilitada',
      reintentable: false,
    };
  }

  const texto = descripcion.trim();
  if (texto.length < 10) {
    return {
      ok: false,
      motivo: 'Descripción demasiado corta para extraer algo útil',
      clase: 'entrada_insuficiente',
      reintentable: false,
    };
  }

  const entrada = contexto.categoriaDeclarada
    ? `Categoría que marcó la persona en el formulario: ${contexto.categoriaDeclarada}\n` +
      `(puede estar equivocada; el texto manda)\n\nReporte:\n${texto}`
    : `Reporte:\n${texto}`;

  const resultado = await proveedor.inferir({
    esquema: EsquemaExtraccion,
    nombreEsquema: 'extraccion_reporte',
    instrucciones: INSTRUCCIONES,
    entrada,
  });

  if (!resultado.ok) return resultado;

  return {
    ok: true,
    propuesta: resultado.datos,
    modelo: resultado.modelo,
    versionPrompt: VERSION_PROMPT,
    tokensEntrada: resultado.tokensEntrada,
    tokensSalida: resultado.tokensSalida,
    latenciaMs: resultado.latenciaMs,
    confiableParaAplicar: proveedor.confiableParaAplicar,
  };
}
