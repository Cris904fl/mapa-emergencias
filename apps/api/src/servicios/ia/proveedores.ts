import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { config } from '../../config.ts';
import { describirErrorIa, obtenerClienteIa } from './cliente.ts';

/**
 * Capa de proveedores de inferencia.
 *
 * Tres implementaciones detrás de una misma interfaz, porque los tres casos de
 * uso del proyecto son distintos:
 *
 *   · `ollama`     — modelo local, gratis, sin enviar datos de personas a
 *                    terceros. Es la opción por defecto para desarrollo y para
 *                    un despliegue en servidor propio.
 *   · `compatible` — cualquier API con forma OpenAI (Groq, OpenRouter, vLLM…).
 *                    Es el camino para un despliegue en la nube donde no cabe un
 *                    modelo local: varios de esos servicios tienen capa gratuita.
 *   · `anthropic`  — la mejor calidad de las tres, de pago.
 *
 * El esquema Zod es la única fuente de verdad de la forma de salida; cada
 * adaptador lo traduce a lo que su API espera. Y los tres validan el resultado
 * con el mismo `esquema.parse()`: la decodificación restringida garantiza JSON
 * bien formado, no que los valores tengan sentido.
 */

export type ResultadoInferencia<T> =
  | {
      ok: true;
      datos: T;
      modelo: string;
      tokensEntrada: number;
      tokensSalida: number;
      latenciaMs: number;
    }
  | { ok: false; motivo: string; clase: string; reintentable: boolean };

export type PeticionInferencia<T> = {
  esquema: z.ZodType<T>;
  /** Nombre del esquema. Algunas APIs lo exigen en `response_format`. */
  nombreEsquema: string;
  instrucciones: string;
  entrada: string;
  imagen?: { base64: string; tipoMime: string };
};

export type Proveedor = {
  nombre: 'anthropic' | 'ollama' | 'compatible';
  modelo: string;
  /**
   * ¿Se confía en este proveedor para escribir los campos canónicos de un
   * reporte sin que una persona revise?
   *
   * Por defecto **no** para los modelos locales. La medición sobre
   * `qwen2.5:7b` en CPU (ver docs/ia-local.md) mostró conteos explícitos
   * correctos y cero cifras inventadas, pero errores en `requiere_rescate` y
   * en la distinción entre "atrapado" y "se quedó sin vivienda" con confianza
   * ALTA. Esos dos campos alimentan directamente la cola de rescate, así que
   * la propuesta se guarda y se muestra, y la aplica un operador.
   */
  confiableParaAplicar: boolean;
  soportaImagenes: boolean;
  disponible(): Promise<boolean>;
  inferir<T>(peticion: PeticionInferencia<T>): Promise<ResultadoInferencia<T>>;
};

function aEsquemaJson(esquema: z.ZodType<unknown>): Record<string, unknown> {
  // `$refStrategy: 'none'` aplana las referencias: ni Ollama ni la mayoría de
  // las APIs compatibles resuelven `$ref`.
  const generado = zodToJsonSchema(esquema, {
    target: 'jsonSchema7',
    $refStrategy: 'none',
  }) as Record<string, unknown>;

  // El `$schema` sobra y algunos servidores lo rechazan.
  delete generado.$schema;
  return generado;
}

/**
 * Valida la salida contra el esquema Zod.
 *
 * Hace falta incluso con decodificación restringida: la gramática de Ollama
 * garantiza que el JSON encaje en la *forma* del esquema, no que respete
 * restricciones semánticas como `min(0)`. Un conteo negativo pasaría la
 * gramática y rompería la función de prioridad.
 */
function validar<T>(esquema: z.ZodType<T>, crudo: unknown): { ok: true; datos: T } | { ok: false; motivo: string } {
  const analisis = esquema.safeParse(crudo);
  if (analisis.success) return { ok: true, datos: analisis.data };
  return {
    ok: false,
    motivo: analisis.error.issues
      .map((problema) => `${problema.path.join('.') || '(raíz)'}: ${problema.message}`)
      .join('; '),
  };
}

// ---------------------------------------------------------------------------
// Ollama
// ---------------------------------------------------------------------------

function crearProveedorOllama(): Proveedor {
  const base = config.OLLAMA_URL.replace(/\/$/, '');

  return {
    nombre: 'ollama',
    modelo: config.IA_MODELO,
    confiableParaAplicar: config.IA_APLICAR_AUTOMATICAMENTE,
    soportaImagenes: true,

    async disponible() {
      try {
        const respuesta = await fetch(`${base}/api/tags`, {
          signal: AbortSignal.timeout(3000),
        });
        if (!respuesta.ok) return false;
        const cuerpo = (await respuesta.json()) as { models?: { name?: string }[] };
        // Se comprueba además que el modelo pedido esté descargado: si no lo
        // está, Ollama intenta bajarlo en medio de la petición y el primer
        // reporte se queda esperando varios minutos sin explicación.
        return (cuerpo.models ?? []).some(
          (modelo) => modelo.name === config.IA_MODELO,
        );
      } catch {
        return false;
      }
    },

    async inferir(peticion) {
      const inicio = Date.now();

      const mensajeUsuario: Record<string, unknown> = { role: 'user', content: peticion.entrada };
      if (peticion.imagen) {
        // Ollama recibe las imágenes como base64 crudo en `images`, sin el
        // prefijo `data:`.
        mensajeUsuario.images = [peticion.imagen.base64];
      }

      try {
        const respuesta = await fetch(`${base}/api/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          signal: AbortSignal.timeout(config.IA_TIEMPO_LIMITE_MS),
          body: JSON.stringify({
            model: config.IA_MODELO,
            stream: false,
            // `format` con un JSON Schema activa decodificación restringida: el
            // muestreo solo puede emitir tokens que produzcan JSON válido
            // contra el esquema. Por eso un modelo de 7B devuelve estructura
            // correcta de forma consistente.
            format: aEsquemaJson(peticion.esquema),
            options: {
              // temperatura 0: esto es extracción, no redacción. Se quiere la
              // misma salida para el mismo reporte.
              temperature: 0,
              num_predict: config.IA_MAX_TOKENS,
            },
            messages: [
              { role: 'system', content: peticion.instrucciones },
              mensajeUsuario,
            ],
          }),
        });

        if (!respuesta.ok) {
          const detalle = await respuesta.text().catch(() => '');
          return {
            ok: false,
            motivo: `Ollama respondió ${respuesta.status}: ${detalle.slice(0, 200)}`,
            clase: `http_${respuesta.status}`,
            reintentable: respuesta.status >= 500,
          };
        }

        const cuerpo = (await respuesta.json()) as {
          model?: string;
          message?: { content?: string };
          prompt_eval_count?: number;
          eval_count?: number;
          done_reason?: string;
        };

        const contenido = cuerpo.message?.content;
        if (!contenido) {
          return {
            ok: false,
            motivo: `Ollama no devolvió contenido (done_reason: ${cuerpo.done_reason ?? '?'})`,
            clase: 'sin_contenido',
            reintentable: true,
          };
        }

        let crudo: unknown;
        try {
          crudo = JSON.parse(contenido);
        } catch {
          // Con `format` esto no debería pasar; si pasa, suele ser porque se
          // agotó num_predict a mitad del JSON.
          return {
            ok: false,
            motivo: `Ollama devolvió JSON inválido: ${contenido.slice(0, 200)}`,
            clase: 'json_invalido',
            reintentable: true,
          };
        }

        const validado = validar(peticion.esquema, crudo);
        if (!validado.ok) {
          return {
            ok: false,
            motivo: `La salida no cumple el esquema: ${validado.motivo}`,
            clase: 'esquema_no_cumplido',
            reintentable: false,
          };
        }

        return {
          ok: true,
          datos: validado.datos,
          modelo: `ollama/${cuerpo.model ?? config.IA_MODELO}`,
          tokensEntrada: cuerpo.prompt_eval_count ?? 0,
          tokensSalida: cuerpo.eval_count ?? 0,
          latenciaMs: Date.now() - inicio,
        };
      } catch (error) {
        const esTiempoLimite = error instanceof Error && error.name === 'TimeoutError';
        return {
          ok: false,
          motivo: esTiempoLimite
            ? `Ollama no respondió en ${config.IA_TIEMPO_LIMITE_MS} ms. En CPU un modelo de 7B puede tardar más de un minuto por reporte.`
            : error instanceof Error
              ? error.message
              : String(error),
          clase: esTiempoLimite ? 'tiempo_limite' : 'conexion',
          reintentable: true,
        };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// API con forma OpenAI (Groq, OpenRouter, vLLM, LM Studio…)
// ---------------------------------------------------------------------------

function crearProveedorCompatible(): Proveedor {
  const base = config.IA_URL_COMPATIBLE.replace(/\/$/, '');

  return {
    nombre: 'compatible',
    modelo: config.IA_MODELO,
    confiableParaAplicar: config.IA_APLICAR_AUTOMATICAMENTE,
    soportaImagenes: true,

    async disponible() {
      if (!config.IA_CLAVE_COMPATIBLE) return false;
      try {
        const respuesta = await fetch(`${base}/models`, {
          headers: { authorization: `Bearer ${config.IA_CLAVE_COMPATIBLE}` },
          signal: AbortSignal.timeout(5000),
        });
        return respuesta.ok;
      } catch {
        return false;
      }
    },

    async inferir(peticion) {
      const inicio = Date.now();

      const contenidoUsuario: unknown = peticion.imagen
        ? [
            {
              type: 'image_url',
              image_url: {
                url: `data:${peticion.imagen.tipoMime};base64,${peticion.imagen.base64}`,
              },
            },
            { type: 'text', text: peticion.entrada },
          ]
        : peticion.entrada;

      try {
        const respuesta = await fetch(`${base}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${config.IA_CLAVE_COMPATIBLE}`,
          },
          signal: AbortSignal.timeout(config.IA_TIEMPO_LIMITE_MS),
          body: JSON.stringify({
            model: config.IA_MODELO,
            temperature: 0,
            max_tokens: config.IA_MAX_TOKENS,
            response_format: {
              type: 'json_schema',
              json_schema: {
                name: peticion.nombreEsquema,
                strict: true,
                schema: aEsquemaJson(peticion.esquema),
              },
            },
            messages: [
              { role: 'system', content: peticion.instrucciones },
              { role: 'user', content: contenidoUsuario },
            ],
          }),
        });

        if (!respuesta.ok) {
          const detalle = await respuesta.text().catch(() => '');
          return {
            ok: false,
            motivo: `El proveedor respondió ${respuesta.status}: ${detalle.slice(0, 200)}`,
            clase: `http_${respuesta.status}`,
            // 429 y 5xx se reintentan; el resto es problema de la petición.
            reintentable: respuesta.status === 429 || respuesta.status >= 500,
          };
        }

        const cuerpo = (await respuesta.json()) as {
          model?: string;
          choices?: { message?: { content?: string }; finish_reason?: string }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };

        const eleccion = cuerpo.choices?.[0];
        const contenido = eleccion?.message?.content;
        if (!contenido) {
          return {
            ok: false,
            motivo: `Sin contenido (finish_reason: ${eleccion?.finish_reason ?? '?'})`,
            clase: 'sin_contenido',
            reintentable: eleccion?.finish_reason === 'length',
          };
        }

        let crudo: unknown;
        try {
          crudo = JSON.parse(contenido);
        } catch {
          return {
            ok: false,
            motivo: `JSON inválido: ${contenido.slice(0, 200)}`,
            clase: 'json_invalido',
            reintentable: true,
          };
        }

        const validado = validar(peticion.esquema, crudo);
        if (!validado.ok) {
          return {
            ok: false,
            motivo: `La salida no cumple el esquema: ${validado.motivo}`,
            clase: 'esquema_no_cumplido',
            reintentable: false,
          };
        }

        return {
          ok: true,
          datos: validado.datos,
          modelo: `${new URL(base).host}/${cuerpo.model ?? config.IA_MODELO}`,
          tokensEntrada: cuerpo.usage?.prompt_tokens ?? 0,
          tokensSalida: cuerpo.usage?.completion_tokens ?? 0,
          latenciaMs: Date.now() - inicio,
        };
      } catch (error) {
        const esTiempoLimite = error instanceof Error && error.name === 'TimeoutError';
        return {
          ok: false,
          motivo: error instanceof Error ? error.message : String(error),
          clase: esTiempoLimite ? 'tiempo_limite' : 'conexion',
          reintentable: true,
        };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

function crearProveedorAnthropic(): Proveedor {
  return {
    nombre: 'anthropic',
    modelo: config.IA_MODELO,
    // El único que viene con aplicación automática habilitada por defecto.
    confiableParaAplicar: true,
    soportaImagenes: true,

    async disponible() {
      return obtenerClienteIa() !== null;
    },

    async inferir(peticion) {
      const cliente = obtenerClienteIa();
      if (!cliente) {
        return {
          ok: false,
          motivo: 'No hay ANTHROPIC_API_KEY configurada',
          clase: 'sin_credencial',
          reintentable: false,
        };
      }

      const inicio = Date.now();

      const contenidoUsuario = peticion.imagen
        ? ([
            {
              type: 'image' as const,
              source: {
                type: 'base64' as const,
                media_type: peticion.imagen.tipoMime as 'image/jpeg',
                data: peticion.imagen.base64,
              },
            },
            { type: 'text' as const, text: peticion.entrada },
          ] as const)
        : peticion.entrada;

      try {
        const mensaje = await cliente.beta.messages.parse({
          model: config.IA_MODELO,
          max_tokens: config.IA_MAX_TOKENS,
          system: [
            {
              type: 'text',
              text: peticion.instrucciones,
              // Las instrucciones son idénticas en cada llamada; cachearlas
              // baja el costo a ~10% en las lecturas siguientes.
              cache_control: { type: 'ephemeral' },
            },
          ],
          messages: [{ role: 'user', content: contenidoUsuario as never }],
          output_format: betaZodOutputFormat(peticion.esquema as never),
        });

        const analizado = mensaje.parsed_output;
        if (!analizado) {
          return {
            ok: false,
            motivo: `Sin salida estructurada (stop_reason: ${mensaje.stop_reason})`,
            clase: 'sin_salida_estructurada',
            reintentable: mensaje.stop_reason === 'max_tokens',
          };
        }

        const validado = validar(peticion.esquema, analizado);
        if (!validado.ok) {
          return {
            ok: false,
            motivo: `La salida no cumple el esquema: ${validado.motivo}`,
            clase: 'esquema_no_cumplido',
            reintentable: false,
          };
        }

        return {
          ok: true,
          datos: validado.datos,
          modelo: mensaje.model,
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
    },
  };
}

// ---------------------------------------------------------------------------
// Selección
// ---------------------------------------------------------------------------

let proveedor: Proveedor | null | undefined;

/** Devuelve el proveedor configurado, o null si la IA está deshabilitada. */
export function obtenerProveedor(): Proveedor | null {
  if (proveedor !== undefined) return proveedor;

  switch (config.IA_PROVEEDOR) {
    case 'ollama':
      proveedor = crearProveedorOllama();
      break;
    case 'compatible':
      proveedor = crearProveedorCompatible();
      break;
    case 'anthropic':
      proveedor = crearProveedorAnthropic();
      break;
    default:
      proveedor = null;
  }

  return proveedor;
}

/** Solo para las pruebas: fuerza que se vuelva a leer la configuración. */
export function reiniciarProveedor(): void {
  proveedor = undefined;
}
