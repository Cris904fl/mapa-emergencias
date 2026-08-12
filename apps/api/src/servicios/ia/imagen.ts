import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { config } from '../../config.ts';
import { obtenerClienteIa, describirErrorIa } from './cliente.ts';

/**
 * Etiquetado preliminar de fotos.
 *
 * Frontera que este módulo no cruza: describe lo que se ve, no dictamina.
 * "Se observan grietas en un muro" es una observación; "el edificio va a
 * colapsar" es un juicio estructural que requiere un ingeniero en sitio y que
 * un modelo mirando una foto no puede hacer. Las etiquetas van a
 * `medios_reporte.etiquetas_ia`, una columna que ninguna consulta de
 * priorización lee: son una ayuda para que un operador decida a qué foto
 * mirar primero, nada más.
 */

export const VERSION_PROMPT_IMAGEN = 'imagen-v1';

const TIPOS_MIME_SOPORTADOS = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
type TipoMimeSoportado = (typeof TIPOS_MIME_SOPORTADOS)[number];

export const EsquemaEtiquetasImagen = z.object({
  elementos_visibles: z
    .array(z.string())
    .describe('Lista corta de lo que efectivamente se ve, en sustantivos simples.'),
  personas_visibles: z
    .number()
    .int()
    .min(0)
    .describe('Cuántas personas se distinguen. 0 si no se distingue ninguna.'),
  agua_visible: z.boolean(),
  fuego_o_humo_visible: z.boolean(),
  escombros_visibles: z.boolean(),
  via_obstruida_visible: z.boolean(),
  danio_edificacion_visible: z
    .boolean()
    .describe('Si se aprecia daño en una edificación, sin juzgar su gravedad.'),
  legible: z
    .boolean()
    .describe('false si la foto está demasiado oscura, borrosa o cortada para describirla.'),
  descripcion: z.string().describe('Dos frases como máximo, descriptivas y sin conclusiones.'),
});

export type EtiquetasImagen = z.infer<typeof EsquemaEtiquetasImagen>;

const INSTRUCCIONES = `Describes fotografías enviadas por ciudadanos durante una emergencia, para que un operador de sala de crisis decida cuáles revisar primero.

Tu tarea es describir, no dictaminar.

Qué sí hacer
- Enumerar lo que se ve: agua, escombros, humo, grietas, personas, vehículos, vías, postes caídos.
- Contar personas solo si se distinguen. Si hay un bulto que podría ser alguien, no lo cuentes y dilo en la descripción.
- Marcar legible en false cuando la foto esté muy oscura, borrosa, desenfocada o tan recortada que no se entienda qué muestra. Es una respuesta útil: le ahorra tiempo al operador.

Qué no hacer
- No evaluar si una estructura es segura, si va a colapsar, ni cuánto daño tiene. Eso requiere una inspección presencial y no se puede determinar desde una fotografía. Puedes decir "se observan grietas en un muro"; no puedes decir "riesgo de colapso".
- No estimar profundidades de agua, alturas ni distancias en metros.
- No deducir causas ("esto fue un sismo").
- No identificar personas, ni describir rasgos físicos, ni leer documentos, placas o rótulos con datos personales que aparezcan en la imagen.

Si la foto no muestra nada relacionable con una emergencia, dilo con claridad en la descripción y deja los indicadores en false.`;

export type ResultadoEtiquetado =
  | {
      ok: true;
      etiquetas: EtiquetasImagen;
      modelo: string;
      versionPrompt: string;
      tokensEntrada: number;
      tokensSalida: number;
      latenciaMs: number;
    }
  | { ok: false; motivo: string; clase: string; reintentable: boolean };

function esTipoMimeSoportado(tipo: string): tipo is TipoMimeSoportado {
  return (TIPOS_MIME_SOPORTADOS as readonly string[]).includes(tipo);
}

/**
 * Etiqueta una imagen ya almacenada.
 *
 * `bytes` llega tal como se guardó. El redimensionado se hace en la PWA antes
 * de subir (ver apps/web/src/lib/imagen.ts): además de reducir tokens, ahorra
 * datos en la red degradada del cliente, que es donde el ahorro importa.
 */
export async function etiquetarImagen(
  bytes: Buffer,
  tipoMime: string,
): Promise<ResultadoEtiquetado> {
  const cliente = obtenerClienteIa();
  if (!cliente) {
    return {
      ok: false,
      motivo: 'No hay ANTHROPIC_API_KEY configurada',
      clase: 'deshabilitada',
      reintentable: false,
    };
  }

  if (!esTipoMimeSoportado(tipoMime)) {
    return {
      ok: false,
      motivo: `Tipo de imagen no soportado por el modelo: ${tipoMime}`,
      clase: 'mime_no_soportado',
      reintentable: false,
    };
  }

  const inicio = Date.now();

  try {
    const mensaje = await cliente.beta.messages.parse({
      model: config.IA_MODELO,
      max_tokens: config.IA_MAX_TOKENS,
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
          // La imagen va antes del texto: es el orden que recomienda la
          // documentación de Anthropic para entradas multimodales.
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: tipoMime,
                data: bytes.toString('base64'),
              },
            },
            { type: 'text', text: 'Describe esta fotografía siguiendo tus instrucciones.' },
          ],
        },
      ],
      output_format: betaZodOutputFormat(EsquemaEtiquetasImagen),
    });

    const etiquetas = mensaje.parsed_output;
    if (!etiquetas) {
      return {
        ok: false,
        motivo: `El modelo no devolvió una salida analizable (stop_reason: ${mensaje.stop_reason})`,
        clase: 'sin_salida_estructurada',
        reintentable: mensaje.stop_reason === 'max_tokens',
      };
    }

    return {
      ok: true,
      etiquetas,
      modelo: mensaje.model,
      versionPrompt: VERSION_PROMPT_IMAGEN,
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
