import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { config } from '../../config.ts';
import { CATEGORIAS, SEVERIDADES } from '../../esquemas/dominio.ts';
import { obtenerClienteIa, describirErrorIa } from './cliente.ts';

/**
 * Extracción estructurada de reportes en texto libre.
 *
 * El único trabajo del modelo acá es convertir lo que una persona escribió a
 * la carrera —"estamos atrapados en una casa cerca del parque, somos 5 y una
 * señora está herida"— en campos con los que se pueda consultar y ordenar.
 * No decide a quién se rescata primero: eso lo hace el índice de prioridad con
 * pesos versionados y auditables, y por encima de todo lo hace un operador.
 *
 * Detalle de implementación verificado contra el SDK instalado (0.70.1): la
 * salida estructurada vive en `client.beta.messages.parse`, el formato se
 * declara con `output_format: betaZodOutputFormat(...)` y el objeto validado
 * llega en `.parsed_output`. Ojo: el ejemplo del propio JSDoc del SDK dice
 * `.parsed`, que no existe en los tipos — el nombre correcto es el que se usa
 * acá. La API no beta (`client.messages.parse` con `output_config.format`) que
 * describe la documentación pública no está expuesta en esta versión.
 */

export const VERSION_PROMPT = 'extraccion-v1';

/**
 * Esquema de salida.
 *
 * `confianza` y `justificacion` no son adornos: son lo que permite que un
 * operador acepte o rechace la propuesta en dos segundos, y lo que hace posible
 * medir después qué tan bien funciona la extracción comparándola con las
 * correcciones humanas.
 */
export const EsquemaExtraccion = z.object({
  categoria: z.enum(CATEGORIAS).describe('Categoría que mejor describe la necesidad principal.'),
  severidad: z
    .enum(SEVERIDADES)
    .describe('DESCONOCIDA si el texto no da elementos para juzgar la gravedad.'),
  personas_afectadas: z.number().int().min(0).describe('Total de personas involucradas.'),
  personas_atrapadas: z.number().int().min(0),
  personas_heridas: z.number().int().min(0),
  personas_fallecidas: z.number().int().min(0),
  personas_vulnerables: z
    .number()
    .int()
    .min(0)
    .describe('Menores, adultos mayores, personas con discapacidad o gestantes mencionadas.'),
  requiere_rescate: z
    .boolean()
    .describe('true solo si hay personas que no pueden salir por sus propios medios.'),
  confianza: z
    .enum(['ALTA', 'MEDIA', 'BAJA'])
    .describe('Qué tan explícito era el texto. BAJA cuando hubo que inferir.'),
  justificacion: z
    .string()
    .describe('Una o dos frases citando la parte del texto que sustenta los conteos.'),
});

export type Extraccion = z.infer<typeof EsquemaExtraccion>;

/**
 * Instrucciones del sistema.
 *
 * Escrito para un modelo actual: sin mayúsculas de énfasis ni "CRITICAL: YOU
 * MUST", que en modelos recientes producen sobreactivación. Lo que sí lleva es
 * el contexto que el modelo no puede adivinar —el uso colombiano del español,
 * qué significa cada categoría en este dominio, y la consecuencia real de
 * inflar un número— porque eso es lo único que no está en su entrenamiento.
 */
const INSTRUCCIONES = `Extraes datos estructurados de reportes ciudadanos de emergencia escritos en español colombiano, tal como los envía la gente: apurados, con errores de tipeo, en voz de vecino y con regionalismos.

Contexto de uso
Este dato entra a una sala de crisis. Los conteos que produzcas alimentan una cola de atención que ordena en qué orden salen los equipos de rescate. Un número inflado desvía recursos de alguien que sí los necesita; un número inventado hace que un operador desconfíe de todo el sistema. Por eso: cuenta solo lo que el texto sostiene.

Reglas de conteo
- Extrae únicamente lo que el texto afirma o implica de forma directa. Si dice "somos 5", son 5. Si dice "varias personas", no inventes una cifra: deja el conteo en 0 y explica en la justificación que la cantidad es indeterminada.
- "una señora está herida" es 1 herida; si además dice "somos 5", entonces son 5 afectadas y 1 de ellas herida. Las categorías de conteo se solapan a propósito: personas_afectadas es el total, y atrapadas/heridas/fallecidas son subconjuntos de ese total.
- Expresiones colombianas frecuentes que sí cuentan como personas vulnerables: "el abuelito", "mi mamá que está viejita", "los pelados", "los chinos" (niños), "una señora en embarazo", "mi hijo que es discapacitado".
- Cantidades de vivienda no son cantidades de persona: "somos como 40 casas" no son 40 afectadas. Si el texto solo habla de casas o predios, deja los conteos de personas en 0 y anótalo en la justificación.

Severidad
- CRITICA: hay vidas en riesgo inmediato — personas atrapadas, heridas graves, riesgo de colapso o de que el agua siga subiendo.
- ALTA: hay riesgo para la integridad pero no inminente, o hay heridos leves.
- MEDIA: necesidad material urgente sin riesgo inmediato de vida (agua, alimento, albergue).
- BAJA: afectación material sin personas afectadas.
- DESCONOCIDA: el texto no da elementos para juzgar. Es una respuesta válida y preferible a adivinar.

Categoría
Elige la necesidad principal, la que define qué equipo debe salir. Si alguien describe daño estructural con gente adentro que no puede salir, la categoría es PERSONAS_ATRAPADAS y no DANO_ESTRUCTURAL: lo que se despacha es un grupo de rescate.

requiere_rescate
true solo si hay personas que no pueden salir por sus propios medios. Una vía bloqueada que impide el paso de ambulancias no es rescate de personas; es VIA_BLOQUEADA con requiere_rescate en false.

Justificación
Una o dos frases, citando el fragmento del texto en que te apoyaste. La leerá un operador que tiene el reporte original al lado y necesita decidir rápido si tu lectura es correcta.`;

export type ResultadoExtraccion =
  | {
      ok: true;
      propuesta: Extraccion;
      modelo: string;
      versionPrompt: string;
      tokensEntrada: number;
      tokensSalida: number;
      latenciaMs: number;
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
  const cliente = obtenerClienteIa();
  if (!cliente) {
    return {
      ok: false,
      motivo: 'No hay ANTHROPIC_API_KEY configurada',
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

  const inicio = Date.now();

  try {
    const mensaje = await cliente.beta.messages.parse({
      model: config.IA_MODELO,
      max_tokens: config.IA_MAX_TOKENS,
      // Las instrucciones van como bloque cacheable: son idénticas en cada
      // llamada y con muchos reportes por minuto la lectura de caché cuesta
      // ~10% de la escritura. Lo variable (el reporte) va después, en el turno
      // del usuario, para no invalidar el prefijo.
      system: [
        {
          type: 'text',
          text: INSTRUCCIONES,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [
        {
          role: 'user',
          content: contexto.categoriaDeclarada
            ? `Categoría que marcó la persona en el formulario: ${contexto.categoriaDeclarada}\n` +
              `(puede estar equivocada; el texto manda)\n\nReporte:\n${texto}`
            : `Reporte:\n${texto}`,
        },
      ],
      output_format: betaZodOutputFormat(EsquemaExtraccion),
    });

    const propuesta = mensaje.parsed_output;
    if (!propuesta) {
      // Ocurre si el modelo se rehusó o si se agotó max_tokens a mitad del JSON.
      return {
        ok: false,
        motivo: `El modelo no devolvió una salida analizable (stop_reason: ${mensaje.stop_reason})`,
        clase: 'sin_salida_estructurada',
        reintentable: mensaje.stop_reason === 'max_tokens',
      };
    }

    return {
      ok: true,
      propuesta,
      modelo: mensaje.model,
      versionPrompt: VERSION_PROMPT,
      tokensEntrada: mensaje.usage.input_tokens,
      tokensSalida: mensaje.usage.output_tokens,
      latenciaMs: Date.now() - inicio,
    };
  } catch (error) {
    const descrito = describirErrorIa(error);
    return {
      ok: false,
      motivo: descrito.mensaje,
      clase: descrito.clase,
      reintentable: descrito.reintentable,
    };
  }
}
