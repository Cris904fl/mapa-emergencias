import { enTransaccion, bd, type Consultador } from '../db/pool.ts';
import { extraerDeTexto, type Extraccion } from './ia/extractor.ts';
import { refrescarPrioridad } from './prioridad.ts';

/**
 * Promoción de una extracción de IA a los campos canónicos de un reporte.
 *
 * Este archivo es donde se hace cumplir la regla de fondo del sistema: la IA
 * estructura información desordenada, no decide a quién se rescata primero.
 * Concretamente, tres candados:
 *
 *   1. Si `origen_triage` ya es 'OPERADOR', no se toca nada. Una persona
 *      revisó el reporte y su lectura manda. (El trigger de la base también lo
 *      impide, así que ni un script suelto puede saltárselo.)
 *   2. Un conteo que el ciudadano escribió en el formulario no se sobreescribe.
 *      Quien está en el sitio contando personas es mejor fuente que un modelo
 *      leyendo su prosa. Solo se rellenan los campos que quedaron en cero.
 *   3. `requiere_rescate` solo puede subir a true, nunca bajar a false. Un
 *      falso negativo acá significa no mandar un equipo a donde hacía falta.
 *
 * La propuesta completa se guarda en `extracciones_ia` pase lo que pase,
 * incluso cuando no se aplica: sirve para auditar, para medir precisión contra
 * las correcciones humanas, y para reprocesar con otro modelo más adelante.
 */

type FilaReporte = {
  id: string;
  codigo_publico: string;
  descripcion: string | null;
  categoria: string;
  severidad: string;
  origen_triage: string;
  personas_afectadas: number;
  personas_atrapadas: number;
  personas_heridas: number;
  personas_fallecidas: number;
  personas_vulnerables: number;
  requiere_rescate: boolean;
};

export type ResultadoTriage =
  | { estado: 'aplicada'; camposActualizados: string[]; extraccionId: string }
  | { estado: 'registrada_sin_aplicar'; motivo: string; extraccionId: string }
  | { estado: 'omitida'; motivo: string }
  | { estado: 'fallo'; motivo: string; clase: string; reintentable: boolean };

/**
 * Decide qué campos de la propuesta se pueden aplicar sin pisar información
 * humana. Devuelve el fragmento a actualizar y la lista de campos tocados.
 */
function calcularActualizacion(
  reporte: FilaReporte,
  propuesta: Extraccion,
): { valores: Record<string, unknown>; campos: string[] } {
  const valores: Record<string, unknown> = {};
  const campos: string[] = [];

  const conteos = [
    ['personas_afectadas', propuesta.personas_afectadas],
    ['personas_atrapadas', propuesta.personas_atrapadas],
    ['personas_heridas', propuesta.personas_heridas],
    ['personas_fallecidas', propuesta.personas_fallecidas],
    ['personas_vulnerables', propuesta.personas_vulnerables],
  ] as const;

  for (const [campo, valorPropuesto] of conteos) {
    // Solo se rellena lo que el ciudadano dejó vacío.
    if (reporte[campo] === 0 && valorPropuesto > 0) {
      valores[campo] = valorPropuesto;
      campos.push(campo);
    }
  }

  // La severidad se completa únicamente cuando el ciudadano no supo decirla.
  // Si él dijo BAJA y el modelo dice CRITICA, se respeta al ciudadano y la
  // discrepancia queda registrada en extracciones_ia para que un operador la
  // vea: resolver ese desacuerdo es trabajo de una persona, no del modelo.
  if (reporte.severidad === 'DESCONOCIDA' && propuesta.severidad !== 'DESCONOCIDA') {
    valores.severidad = propuesta.severidad;
    campos.push('severidad');
  }

  if (propuesta.requiere_rescate && !reporte.requiere_rescate) {
    valores.requiere_rescate = true;
    campos.push('requiere_rescate');
  }

  return { valores, campos };
}

/** ¿La propuesta contradice lo que dijo el ciudadano? Se anota, no se resuelve. */
function detectarDiscrepancias(reporte: FilaReporte, propuesta: Extraccion): string[] {
  const notas: string[] = [];

  if (
    reporte.severidad !== 'DESCONOCIDA' &&
    reporte.severidad !== propuesta.severidad
  ) {
    notas.push(
      `severidad: el formulario dice ${reporte.severidad}, el texto sugiere ${propuesta.severidad}`,
    );
  }
  if (reporte.categoria !== propuesta.categoria) {
    notas.push(
      `categoría: el formulario dice ${reporte.categoria}, el texto sugiere ${propuesta.categoria}`,
    );
  }
  if (reporte.personas_afectadas > 0 && propuesta.personas_afectadas > reporte.personas_afectadas) {
    notas.push(
      `personas: el formulario dice ${reporte.personas_afectadas}, el texto sugiere ${propuesta.personas_afectadas}`,
    );
  }

  return notas;
}

export async function triarReporteConIa(reporteId: string): Promise<ResultadoTriage> {
  const { rows } = await bd.consultar<FilaReporte>(
    `SELECT id, codigo_publico, descripcion, categoria, severidad, origen_triage,
            personas_afectadas, personas_atrapadas, personas_heridas,
            personas_fallecidas, personas_vulnerables, requiere_rescate
       FROM reportes
      WHERE id = $1`,
    [reporteId],
  );

  const reporte = rows[0];
  if (!reporte) {
    return { estado: 'omitida', motivo: 'El reporte no existe' };
  }

  // Candado 1: triage humano es definitivo.
  if (reporte.origen_triage === 'OPERADOR') {
    return { estado: 'omitida', motivo: 'El reporte ya tiene triage humano' };
  }

  if (!reporte.descripcion || reporte.descripcion.trim().length < 10) {
    return { estado: 'omitida', motivo: 'El reporte no trae texto libre que estructurar' };
  }

  const resultado = await extraerDeTexto(reporte.descripcion, {
    categoriaDeclarada: reporte.categoria,
  });

  if (!resultado.ok) {
    return {
      estado: 'fallo',
      motivo: resultado.motivo,
      clase: resultado.clase,
      reintentable: resultado.reintentable,
    };
  }

  const { valores, campos } = calcularActualizacion(reporte, resultado.propuesta);
  const discrepancias = detectarDiscrepancias(reporte, resultado.propuesta);

  const justificacion = [
    resultado.propuesta.justificacion,
    discrepancias.length > 0 ? `Discrepancias: ${discrepancias.join('; ')}` : null,
  ]
    .filter(Boolean)
    .join(' | ');

  // La confianza BAJA se registra pero no se aplica: cuando el modelo mismo
  // dice que tuvo que inferir, el valor de tenerlo en la cola es menor que el
  // riesgo de ensuciar los conteos.
  const aplicar = campos.length > 0 && resultado.propuesta.confianza !== 'BAJA';

  const extraccionId = await enTransaccion(async (cliente: Consultador) => {
    const { rows: insertadas } = await cliente.consultar<{ id: string }>(
      `INSERT INTO extracciones_ia (
         reporte_id, modelo, version_prompt, propuesta, justificacion,
         aplicada, aplicada_en, tokens_entrada, tokens_salida, latencia_ms
       ) VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $6 THEN now() ELSE NULL END, $7, $8, $9)
       RETURNING id`,
      [
        reporte.id,
        resultado.modelo,
        resultado.versionPrompt,
        JSON.stringify(resultado.propuesta),
        justificacion,
        aplicar,
        resultado.tokensEntrada,
        resultado.tokensSalida,
        resultado.latenciaMs,
      ],
    );

    if (aplicar) {
      // Construcción parametrizada del SET: los nombres de columna vienen de
      // una lista cerrada definida en este archivo, nunca de la entrada.
      const asignaciones = campos.map((campo, indice) => `${campo} = $${indice + 2}`);
      asignaciones.push(`origen_triage = 'IA'`);

      await cliente.consultar(
        `UPDATE reportes SET ${asignaciones.join(', ')} WHERE id = $1 AND origen_triage <> 'OPERADOR'`,
        [reporte.id, ...campos.map((campo) => valores[campo])],
      );
    }

    return insertadas[0]!.id;
  });

  if (!aplicar) {
    return {
      estado: 'registrada_sin_aplicar',
      motivo:
        campos.length === 0
          ? 'La propuesta no agregaba nada sobre lo que ya reportó el ciudadano'
          : `Confianza ${resultado.propuesta.confianza}: se deja a revisión humana`,
      extraccionId,
    };
  }

  // Los conteos cambiaron, así que la posición en la cola también.
  await refrescarPrioridad(reporte.id);

  return { estado: 'aplicada', camposActualizados: campos, extraccionId };
}
