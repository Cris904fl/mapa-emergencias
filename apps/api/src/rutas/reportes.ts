import { createHash } from 'node:crypto';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.ts';
import { bd } from '../db/pool.ts';
import {
  zCambiarEstado,
  zConsultarCercanos,
  zConsultarReportes,
  zCrearReporte,
  zSincronizarLote,
} from '../esquemas/reporte.ts';
import { CODIGOS_PG, esErrorPg, noEncontrado, sinPermiso, solicitudInvalida } from '../lib/errores.ts';
import { validar } from '../lib/validar.ts';
import { puedeOperar } from '../lib/auth.ts';
import {
  buscarPorCodigoPublico,
  cambiarEstado,
  crearReporte,
  listarReportesGeoJson,
  obtenerReporte,
  reportesCercanos,
  sincronizarLote,
} from '../repositorios/reportes.ts';
import { calcularPrioridad, pesosVigentes, refrescarPrioridad } from '../servicios/prioridad.ts';
import { triarReporteConIa } from '../servicios/triage.ts';
import { encolarTriage, encolarEtiquetadoImagen } from '../trabajadores/colas.ts';
import { almacen } from '../servicios/almacen.ts';
import { notificarCambioDeEstado } from '../servicios/notificaciones.ts';

export async function rutasReportes(app: FastifyInstance): Promise<void> {
  /**
   * Alta de un reporte. Abierta sin autenticación a propósito: exigir cuenta
   * para pedir auxilio garantiza perder reportes. El abuso se contiene con
   * límite de tasa (ver app.ts), no con un muro de registro.
   *
   * Idempotente por `id_cliente`. Responde 201 si creó y 200 si era un reenvío,
   * de modo que la PWA sepa si puede borrar el elemento de su bandeja de salida.
   */
  app.post('/v1/reportes', async (peticion, respuesta) => {
    const entrada = validar(zCrearReporte, peticion.body, 'el cuerpo del reporte');
    const reportanteId = peticion.sesion?.usuarioId ?? null;

    const resultado = await crearReporte(entrada, reportanteId);

    // La prioridad se calcula de una vez: un reporte sin puntaje no aparece
    // ordenado en la cola, y en una emergencia ese hueco importa.
    const puntaje = await refrescarPrioridad(resultado.id);

    // El enriquecimiento por IA va a una cola: es lento y falible, y no debe
    // demorar la confirmación al ciudadano ni tumbar el alta si falla.
    if (entrada.descripcion && entrada.descripcion.trim().length >= 10) {
      await encolarTriage(resultado.id).catch((error) => {
        peticion.log.warn({ error, reporteId: resultado.id }, 'No se pudo encolar el triage por IA');
      });
    }

    return respuesta.code(resultado.creado ? 201 : 200).send({
      id: resultado.id,
      codigo_publico: resultado.codigo_publico,
      creado: resultado.creado,
      prioridad_score: puntaje,
    });
  });

  /**
   * Drenaje de la bandeja de salida de la PWA.
   *
   * Devuelve un resultado por elemento con el `id_cliente` que envió el cliente,
   * para que pueda emparejar y borrar exactamente lo que quedó confirmado.
   */
  app.post('/v1/reportes/sincronizar', async (peticion) => {
    const { reportes } = validar(zSincronizarLote, peticion.body, 'el lote de sincronización');
    const reportanteId = peticion.sesion?.usuarioId ?? null;

    const resultados = await sincronizarLote(reportes, reportanteId);

    for (const resultado of resultados) {
      await refrescarPrioridad(resultado.id);
    }

    const nuevos = resultados.filter((resultado) => resultado.creado);
    for (const resultado of nuevos) {
      await encolarTriage(resultado.id).catch((error) => {
        peticion.log.warn({ error, reporteId: resultado.id }, 'No se pudo encolar el triage por IA');
      });
    }

    return {
      recibidos: resultados.length,
      creados: nuevos.length,
      duplicados: resultados.length - nuevos.length,
      resultados: resultados.map((resultado, indice) => ({
        id_cliente: reportes[indice]!.id_cliente,
        id: resultado.id,
        codigo_publico: resultado.codigo_publico,
        creado: resultado.creado,
      })),
    };
  });

  /** Listado como FeatureCollection de GeoJSON, listo para MapLibre. */
  app.get('/v1/reportes', async (peticion) => {
    const filtros = validar(zConsultarReportes, peticion.query, 'los filtros');
    return listarReportesGeoJson(filtros);
  });

  app.get('/v1/reportes/cercanos', async (peticion) => {
    const consulta = validar(zConsultarCercanos, peticion.query, 'los parámetros de cercanía');
    return { reportes: await reportesCercanos(consulta) };
  });

  /** Consulta por código público: es lo que un ciudadano tiene a mano. */
  app.get<{ Params: { codigo: string } }>('/v1/reportes/codigo/:codigo', async (peticion) => {
    const encontrado = await buscarPorCodigoPublico(peticion.params.codigo);
    if (!encontrado) throw noEncontrado('El reporte');

    const reporte = await obtenerReporte(encontrado.id);
    if (!reporte) throw noEncontrado('El reporte');
    return reporte;
  });

  app.get<{ Params: { id: string } }>('/v1/reportes/:id', async (peticion) => {
    const reporte = await obtenerReporte(peticion.params.id);
    if (!reporte) throw noEncontrado('El reporte');
    return reporte;
  });

  /**
   * Explicación del puntaje: recalcula al vuelo y devuelve el desglose por
   * término junto con los pesos vigentes.
   *
   * Es una ruta de primera clase, no un extra de depuración: un número que
   * ordena rescates sin explicación no es utilizable por un operador que tiene
   * que justificar por qué mandó el equipo a un lado y no al otro.
   */
  app.get<{ Params: { id: string } }>('/v1/reportes/:id/prioridad', async (peticion) => {
    const calculo = await calcularPrioridad(peticion.params.id);
    if (!calculo) throw noEncontrado('El reporte');

    return {
      score: calculo.score,
      version: calculo.version,
      componentes: calculo.componentes,
      pesos: await pesosVigentes(),
      nota:
        'El puntaje se calculó en el momento de esta consulta. La columna ' +
        'prioridad_score del reporte puede estar unos minutos atrás: la ' +
        'refresca un trabajador periódico.',
    };
  });

  /** Cambio de estado. Solo personal operativo. */
  app.patch<{ Params: { id: string } }>('/v1/reportes/:id/estado', async (peticion) => {
    if (!puedeOperar(peticion.sesion)) {
      throw sinPermiso('Solo el personal operativo puede cambiar el estado de un reporte');
    }

    const cambio = validar(zCambiarEstado, peticion.body, 'el cambio de estado');

    try {
      const reporte = await cambiarEstado(peticion.params.id, cambio, peticion.sesion!.usuarioId);
      await refrescarPrioridad(peticion.params.id);

      // Avisarle a quien reportó. Va con `catch` y sin `await` bloqueante sobre
      // el resultado: que falle una notificación no puede tumbar el cambio de
      // estado que la provocó. Un operador que marca un caso resuelto no puede
      // recibir un error porque el teléfono de otra persona ya no existe.
      await notificarCambioDeEstado(peticion.params.id, cambio.estado).catch((error) => {
        peticion.log.warn({ error, reporteId: peticion.params.id }, 'No se pudo notificar');
      });

      return reporte;
    } catch (error) {
      if (esErrorPg(error, CODIGOS_PG.VIOLACION_LLAVE_FORANEA)) {
        throw solicitudInvalida('Alguna de las referencias enviadas no existe');
      }
      if (esErrorPg(error, CODIGOS_PG.VIOLACION_CHECK)) {
        throw solicitudInvalida(
          'El cambio viola una regla del reporte (por ejemplo, DUPLICADO sin duplicado_de_id)',
        );
      }
      throw error;
    }
  });

  /**
   * Dispara la extracción por IA de forma sincrónica.
   *
   * Existe aparte de la cola para que un operador pueda pedir "estructúrame
   * este texto ahora" y ver el resultado, en vez de esperar al trabajador.
   */
  app.post<{ Params: { id: string } }>('/v1/reportes/:id/triage-ia', async (peticion) => {
    if (!puedeOperar(peticion.sesion)) {
      throw sinPermiso('Solo el personal operativo puede disparar el triage por IA');
    }
    return triarReporteConIa(peticion.params.id);
  });

  /**
   * Subida de una foto, video o audio.
   *
   * El archivo se guarda en disco en desarrollo y se deduplica por SHA-256: la
   * misma foto reenviada al recuperar señal no ocupa espacio dos veces. En
   * producción se cambia la escritura por S3/MinIO sin tocar el esquema.
   */
  app.post<{ Params: { id: string } }>('/v1/reportes/:id/medios', async (peticion, respuesta) => {
    const { rows } = await bd.consultar<{ id: string }>('SELECT id FROM reportes WHERE id = $1', [
      peticion.params.id,
    ]);
    if (!rows[0]) throw noEncontrado('El reporte');

    const archivo = await peticion.file();
    if (!archivo) throw solicitudInvalida('Falta el archivo en el campo multipart');

    const bytes = await archivo.toBuffer();
    if (bytes.length === 0) throw solicitudInvalida('El archivo está vacío');

    const tipoMime = archivo.mimetype;
    const tipo = tipoMime.startsWith('image/')
      ? 'FOTO'
      : tipoMime.startsWith('video/')
        ? 'VIDEO'
        : tipoMime.startsWith('audio/')
          ? 'AUDIO'
          : null;

    if (!tipo) throw solicitudInvalida(`Tipo de archivo no soportado: ${tipoMime}`);

    const sha256 = createHash('sha256').update(bytes).digest('hex');
    // Se reparte en subdirectorios por los dos primeros bytes del hash para no
    // dejar decenas de miles de archivos en una sola carpeta.
    const llaveAlmacen = path.posix.join(sha256.slice(0, 2), sha256.slice(2, 4), sha256);

    await almacen.guardar(llaveAlmacen, bytes, tipoMime);

    try {
      const { rows: insertadas } = await bd.consultar<{ id: string }>(
        `INSERT INTO medios_reporte (reporte_id, tipo, llave_almacen, tipo_mime, bytes, sha256)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [peticion.params.id, tipo, llaveAlmacen, tipoMime, bytes.length, sha256],
      );

      const medioId = insertadas[0]!.id;

      if (tipo === 'FOTO') {
        await encolarEtiquetadoImagen(medioId).catch((error) => {
          peticion.log.warn({ error, medioId }, 'No se pudo encolar el etiquetado de la imagen');
        });
      }

      return respuesta.code(201).send({ id: medioId, tipo, bytes: bytes.length, sha256 });
    } catch (error) {
      if (esErrorPg(error, CODIGOS_PG.VIOLACION_UNICO)) {
        // Mismo archivo ya asociado a este reporte: reenvío tras recuperar
        // señal. No es un error para el cliente.
        return respuesta.code(200).send({ duplicado: true, sha256 });
      }
      throw error;
    }
  });

  /** Descarga de un medio. */
  app.get<{ Params: { id: string } }>('/v1/medios/:id', async (peticion, respuesta) => {
    const { rows } = await bd.consultar<{ llave_almacen: string; tipo_mime: string }>(
      'SELECT llave_almacen, tipo_mime FROM medios_reporte WHERE id = $1',
      [peticion.params.id],
    );
    const medio = rows[0];
    if (!medio) throw noEncontrado('El medio');

    // La validación de la llave vive dentro del almacén en disco, que es el
    // único que puede sufrir saltos de directorio.
    const bytes = await almacen.leer(medio.llave_almacen);
    if (!bytes) throw noEncontrado('El archivo del medio');

    return respuesta.type(medio.tipo_mime).send(bytes);
  });
}
