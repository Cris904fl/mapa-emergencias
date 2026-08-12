import { bd, enTransaccion, type Consultador } from '../db/pool.ts';
import { ESTADOS_CERRADOS } from '../esquemas/dominio.ts';
import type { CrearReporte } from '../esquemas/reporte.ts';
import { conflicto, noEncontrado } from '../lib/errores.ts';

/**
 * Acceso a datos de reportes. Toda la geometría se construye y se lee acá para
 * que las rutas trabajen con lat/lng y GeoJSON y nunca con SQL espacial.
 */

/** Lista de estados cerrados como literal SQL parametrizable. */
const ESTADOS_CERRADOS_SQL = `('${ESTADOS_CERRADOS.join("','")}')`;

export type ResultadoInsercion = {
  id: string;
  codigo_publico: string;
  /** false cuando el reporte ya existía: reenvío de la cola sin conexión. */
  creado: boolean;
};

const COLUMNAS_INSERCION = [
  'id_cliente',
  'reportante_id',
  'contacto_reportante',
  'categoria',
  'severidad',
  'descripcion',
  'precision_ubicacion_m',
  'personas_afectadas',
  'personas_atrapadas',
  'personas_heridas',
  'personas_fallecidas',
  'personas_vulnerables',
  'requiere_rescate',
  'reportado_en',
] as const;

/**
 * Inserta un reporte de forma idempotente.
 *
 * `ON CONFLICT (id_cliente) DO UPDATE SET id_cliente = reportes.id_cliente` es
 * una actualización deliberadamente vacía: sirve para que la cláusula RETURNING
 * devuelva la fila existente (un `DO NOTHING` no devuelve nada) sin modificar
 * ningún dato. `xmax = 0` distingue inserción real de reenvío — es el truco
 * estándar en PostgreSQL para saber cuál de las dos ramas se tomó.
 */
export async function insertarReporte(
  cliente: Consultador,
  entrada: CrearReporte,
  reportanteId: string | null,
): Promise<ResultadoInsercion> {
  const valores = [
    entrada.id_cliente,
    reportanteId,
    entrada.contacto_reportante ?? null,
    entrada.categoria,
    entrada.severidad,
    entrada.descripcion ?? null,
    entrada.precision_ubicacion_m ?? null,
    entrada.personas_afectadas,
    entrada.personas_atrapadas,
    entrada.personas_heridas,
    entrada.personas_fallecidas,
    entrada.personas_vulnerables,
    entrada.requiere_rescate,
    entrada.reportado_en ?? new Date().toISOString(),
    entrada.lng,
    entrada.lat,
  ];

  const marcadores = COLUMNAS_INSERCION.map((_, indice) => `$${indice + 1}`);
  const marcadorLng = `$${COLUMNAS_INSERCION.length + 1}`;
  const marcadorLat = `$${COLUMNAS_INSERCION.length + 2}`;

  const { rows } = await cliente.consultar<ResultadoInsercion>(
    `INSERT INTO reportes (${COLUMNAS_INSERCION.join(', ')}, geom)
     VALUES (${marcadores.join(', ')},
             ST_SetSRID(ST_MakePoint(${marcadorLng}, ${marcadorLat}), 4326)::geography)
     ON CONFLICT (id_cliente) DO UPDATE SET id_cliente = reportes.id_cliente
     RETURNING id, codigo_publico, (xmax = 0) AS creado`,
    valores,
  );

  return rows[0]!;
}

export async function crearReporte(
  entrada: CrearReporte,
  reportanteId: string | null = null,
): Promise<ResultadoInsercion> {
  return enTransaccion((cliente) => insertarReporte(cliente, entrada, reportanteId), {
    usuarioId: reportanteId,
  });
}

/**
 * Inserta un lote completo en una sola transacción.
 *
 * Todo o nada: si un elemento del lote es inválido a nivel de base, la PWA debe
 * reintentar el lote entero. Es preferible a un éxito parcial en el que el
 * cliente no sabe qué quedó guardado y qué no — y como la operación es
 * idempotente por `id_cliente`, reintentar no cuesta nada.
 */
export async function sincronizarLote(
  entradas: CrearReporte[],
  reportanteId: string | null = null,
): Promise<ResultadoInsercion[]> {
  return enTransaccion(async (cliente) => {
    const resultados: ResultadoInsercion[] = [];
    for (const entrada of entradas) {
      resultados.push(await insertarReporte(cliente, entrada, reportanteId));
    }
    return resultados;
  }, { usuarioId: reportanteId });
}

/** Propiedades que viajan en cada Feature de GeoJSON. */
const PROPIEDADES_GEOJSON = `jsonb_build_object(
  'codigo_publico',        r.codigo_publico,
  'categoria',             r.categoria,
  'severidad',             r.severidad,
  'estado',                r.estado,
  'descripcion',           r.descripcion,
  'personas_afectadas',    r.personas_afectadas,
  'personas_atrapadas',    r.personas_atrapadas,
  'personas_heridas',      r.personas_heridas,
  'personas_fallecidas',   r.personas_fallecidas,
  'personas_vulnerables',  r.personas_vulnerables,
  'requiere_rescate',      r.requiere_rescate,
  'origen_triage',         r.origen_triage,
  'precision_ubicacion_m', r.precision_ubicacion_m,
  'lugar',                 l.nombre,
  'reportado_en',          r.reportado_en,
  'primera_respuesta_en',  r.primera_respuesta_en,
  'prioridad_score',       r.prioridad_score,
  'prioridad_calculada_en', r.prioridad_calculada_en
)`;

export type ColeccionGeoJson = {
  type: 'FeatureCollection';
  features: unknown[];
  /** Metadatos fuera del estándar GeoJSON pero permitidos como miembro extra. */
  meta: { total: number; limite: number; desplazamiento: number };
};

export async function listarReportesGeoJson(filtros: {
  bbox?: { minLng: number; minLat: number; maxLng: number; maxLat: number };
  estado?: string;
  categoria?: string;
  severidad?: string;
  incluir_cerrados: boolean;
  limite: number;
  desplazamiento: number;
}): Promise<ColeccionGeoJson> {
  const condiciones: string[] = [];
  const parametros: unknown[] = [];

  if (!filtros.incluir_cerrados) {
    condiciones.push(`r.estado NOT IN ${ESTADOS_CERRADOS_SQL}`);
  }
  if (filtros.estado) {
    parametros.push(filtros.estado);
    condiciones.push(`r.estado = $${parametros.length}`);
  }
  if (filtros.categoria) {
    parametros.push(filtros.categoria);
    condiciones.push(`r.categoria = $${parametros.length}`);
  }
  if (filtros.severidad) {
    parametros.push(filtros.severidad);
    condiciones.push(`r.severidad = $${parametros.length}`);
  }
  if (filtros.bbox) {
    // ST_MakeEnvelope + ST_Intersects sobre geography aprovecha el índice GiST.
    parametros.push(filtros.bbox.minLng, filtros.bbox.minLat, filtros.bbox.maxLng, filtros.bbox.maxLat);
    const base = parametros.length - 3;
    condiciones.push(
      `ST_Intersects(r.geom, ST_MakeEnvelope($${base}, $${base + 1}, $${base + 2}, $${base + 3}, 4326)::geography)`,
    );
  }

  const donde = condiciones.length > 0 ? `WHERE ${condiciones.join(' AND ')}` : '';

  parametros.push(filtros.limite, filtros.desplazamiento);
  const marcadorLimite = `$${parametros.length - 1}`;
  const marcadorDesplazamiento = `$${parametros.length}`;

  const { rows } = await bd.consultar<{ coleccion: ColeccionGeoJson }>(
    `WITH filtrados AS (
       SELECT r.*, l.nombre AS nombre_lugar
         FROM reportes r
         LEFT JOIN lugares l ON l.id = r.lugar_id
         ${donde}
        ORDER BY r.prioridad_score DESC NULLS LAST, r.reportado_en DESC
        LIMIT ${marcadorLimite} OFFSET ${marcadorDesplazamiento}
     ),
     total AS (
       SELECT count(*) AS n FROM reportes r ${donde}
     )
     SELECT jsonb_build_object(
       'type', 'FeatureCollection',
       'features', coalesce(jsonb_agg(
         jsonb_build_object(
           'type', 'Feature',
           'id', f.id,
           'geometry', ST_AsGeoJSON(f.geom)::jsonb,
           'properties', jsonb_build_object(
             'codigo_publico',        f.codigo_publico,
             'categoria',             f.categoria,
             'severidad',             f.severidad,
             'estado',                f.estado,
             'descripcion',           f.descripcion,
             'personas_afectadas',    f.personas_afectadas,
             'personas_atrapadas',    f.personas_atrapadas,
             'personas_heridas',      f.personas_heridas,
             'personas_fallecidas',   f.personas_fallecidas,
             'personas_vulnerables',  f.personas_vulnerables,
             'requiere_rescate',      f.requiere_rescate,
             'origen_triage',         f.origen_triage,
             'precision_ubicacion_m', f.precision_ubicacion_m,
             'lugar',                 f.nombre_lugar,
             'reportado_en',          f.reportado_en,
             'primera_respuesta_en',  f.primera_respuesta_en,
             'prioridad_score',       f.prioridad_score
           )
         ) ORDER BY f.prioridad_score DESC NULLS LAST
       ), '[]'::jsonb),
       'meta', jsonb_build_object(
         'total', (SELECT n FROM total),
         'limite', ${marcadorLimite}::int,
         'desplazamiento', ${marcadorDesplazamiento}::int
       )
     ) AS coleccion
     FROM filtrados f`,
    parametros,
  );

  return rows[0]!.coleccion;
}

export type ReporteDetallado = Record<string, unknown>;

export async function obtenerReporte(id: string): Promise<ReporteDetallado | null> {
  const { rows } = await bd.consultar<{ reporte: ReporteDetallado }>(
    `SELECT jsonb_build_object(
       'id', r.id,
       'geometry', ST_AsGeoJSON(r.geom)::jsonb,
       'lat', ST_Y(r.geom::geometry),
       'lng', ST_X(r.geom::geometry),
       'properties', ${PROPIEDADES_GEOJSON},
       'prioridad_componentes', r.prioridad_componentes,
       'prioridad_version', r.prioridad_version,
       'organizacion_asignada', o.nombre,
       'recurso_asignado', rec.nombre,
       'duplicado_de', dup.codigo_publico,
       'medios', coalesce((
         SELECT jsonb_agg(jsonb_build_object(
           'id', m.id,
           'tipo', m.tipo,
           'tipo_mime', m.tipo_mime,
           'bytes', m.bytes,
           'capturado_en', m.capturado_en,
           'etiquetas_ia', m.etiquetas_ia,
           'modelo_ia', m.modelo_ia,
           'analizado_en', m.analizado_en
         ) ORDER BY m.creado_en)
         FROM medios_reporte m WHERE m.reporte_id = r.id
       ), '[]'::jsonb),
       'historial', coalesce((
         SELECT jsonb_agg(jsonb_build_object(
           'estado_anterior', h.estado_anterior,
           'estado_nuevo', h.estado_nuevo,
           'nota', h.nota,
           'por', u.nombre,
           'creado_en', h.creado_en
         ) ORDER BY h.creado_en)
         FROM historial_estado_reporte h
         LEFT JOIN usuarios u ON u.id = h.cambiado_por
         WHERE h.reporte_id = r.id
       ), '[]'::jsonb),
       'extracciones_ia', coalesce((
         SELECT jsonb_agg(jsonb_build_object(
           'modelo', e.modelo,
           'version_prompt', e.version_prompt,
           'propuesta', e.propuesta,
           'justificacion', e.justificacion,
           'aplicada', e.aplicada,
           'creado_en', e.creado_en
         ) ORDER BY e.creado_en DESC)
         FROM extracciones_ia e WHERE e.reporte_id = r.id
       ), '[]'::jsonb)
     ) AS reporte
     FROM reportes r
     LEFT JOIN lugares l         ON l.id   = r.lugar_id
     LEFT JOIN organizaciones o  ON o.id   = r.organizacion_asignada_id
     LEFT JOIN recursos rec      ON rec.id = r.recurso_asignado_id
     LEFT JOIN reportes dup      ON dup.id = r.duplicado_de_id
     WHERE r.id = $1`,
    [id],
  );

  return rows[0]?.reporte ?? null;
}

export async function buscarPorCodigoPublico(codigo: string): Promise<{ id: string } | null> {
  const { rows } = await bd.consultar<{ id: string }>(
    'SELECT id FROM reportes WHERE codigo_publico = $1',
    [codigo.toUpperCase()],
  );
  return rows[0] ?? null;
}

/** Reportes abiertos dentro de un radio, ordenados por distancia. */
export async function reportesCercanos(consulta: {
  lat: number;
  lng: number;
  radio_m: number;
  limite: number;
}) {
  const { rows } = await bd.consultar(
    `SELECT r.id,
            r.codigo_publico,
            r.categoria,
            r.severidad,
            r.estado,
            r.personas_afectadas,
            r.prioridad_score,
            round(ST_Distance(r.geom, punto.geom)::numeric, 1) AS distancia_m,
            ST_Y(r.geom::geometry) AS lat,
            ST_X(r.geom::geometry) AS lng
       FROM reportes r
      CROSS JOIN (SELECT ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography AS geom) punto
      WHERE r.estado NOT IN ${ESTADOS_CERRADOS_SQL}
        AND ST_DWithin(r.geom, punto.geom, $3)
      ORDER BY r.geom <-> punto.geom
      LIMIT $4`,
    [consulta.lng, consulta.lat, consulta.radio_m, consulta.limite],
  );
  return rows;
}

export async function cambiarEstado(
  id: string,
  cambio: {
    estado: string;
    nota?: string;
    organizacion_asignada_id?: string;
    recurso_asignado_id?: string;
    duplicado_de_id?: string;
  },
  usuarioId: string,
): Promise<ReporteDetallado> {
  if (cambio.estado === 'DUPLICADO' && !cambio.duplicado_de_id) {
    throw conflicto('Para marcar DUPLICADO hay que indicar duplicado_de_id');
  }

  await enTransaccion(
    async (cliente) => {
      const asignaciones = ['estado = $2'];
      const parametros: unknown[] = [id, cambio.estado];

      if (cambio.organizacion_asignada_id) {
        parametros.push(cambio.organizacion_asignada_id);
        asignaciones.push(`organizacion_asignada_id = $${parametros.length}`);
      }
      if (cambio.recurso_asignado_id) {
        parametros.push(cambio.recurso_asignado_id);
        asignaciones.push(`recurso_asignado_id = $${parametros.length}`);
      }
      if (cambio.duplicado_de_id) {
        parametros.push(cambio.duplicado_de_id);
        asignaciones.push(`duplicado_de_id = $${parametros.length}`);
      }

      // Un cambio de estado hecho por una persona fija el triage como humano,
      // lo que además bloquea que la IA vuelva a escribir los conteos.
      asignaciones.push(`origen_triage = 'OPERADOR'`);

      const { rowCount } = await cliente.consultar(
        `UPDATE reportes SET ${asignaciones.join(', ')} WHERE id = $1`,
        parametros,
      );

      if (rowCount === 0) throw noEncontrado('El reporte');
    },
    { usuarioId, nota: cambio.nota ?? null },
  );

  const reporte = await obtenerReporte(id);
  if (!reporte) throw noEncontrado('El reporte');
  return reporte;
}
