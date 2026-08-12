import type { FastifyInstance } from 'fastify';
import { bd } from '../db/pool.ts';
import { zActualizarRecurso, zConsultarRecursos } from '../esquemas/reporte.ts';
import { noEncontrado, sinPermiso, solicitudInvalida } from '../lib/errores.ts';
import { validar } from '../lib/validar.ts';
import { puedeOperar } from '../lib/auth.ts';

export async function rutasRecursos(app: FastifyInstance): Promise<void> {
  /** Recursos como GeoJSON, para pintarlos como otra capa del mapa. */
  app.get('/v1/recursos', async (peticion) => {
    const filtros = validar(zConsultarRecursos, peticion.query, 'los filtros');

    const condiciones: string[] = [];
    const parametros: unknown[] = [];

    if (filtros.tipo) {
      parametros.push(filtros.tipo);
      condiciones.push(`rec.tipo = $${parametros.length}`);
    }
    if (filtros.estado) {
      parametros.push(filtros.estado);
      condiciones.push(`rec.estado = $${parametros.length}`);
    }
    if (filtros.bbox) {
      parametros.push(
        filtros.bbox.minLng,
        filtros.bbox.minLat,
        filtros.bbox.maxLng,
        filtros.bbox.maxLat,
      );
      const base = parametros.length - 3;
      condiciones.push(
        `ST_Intersects(rec.geom, ST_MakeEnvelope($${base}, $${base + 1}, $${base + 2}, $${base + 3}, 4326)::geography)`,
      );
    }

    const donde = condiciones.length > 0 ? `WHERE ${condiciones.join(' AND ')}` : '';
    parametros.push(filtros.limite);

    const { rows } = await bd.consultar<{ coleccion: unknown }>(
      `SELECT jsonb_build_object(
         'type', 'FeatureCollection',
         'features', coalesce(jsonb_agg(
           jsonb_build_object(
             'type', 'Feature',
             'id', f.id,
             'geometry', ST_AsGeoJSON(f.geom)::jsonb,
             'properties', jsonb_build_object(
               'nombre', f.nombre,
               'tipo', f.tipo,
               'estado', f.estado,
               'movil', f.movil,
               'capacidad_total', f.capacidad_total,
               'capacidad_usada', f.capacidad_usada,
               'cupos_libres', f.capacidad_total - f.capacidad_usada,
               'telefono', f.telefono,
               'organizacion', f.organizacion,
               'notas', f.notas,
               'actualizado_en', f.actualizado_en
             )
           ) ORDER BY f.nombre
         ), '[]'::jsonb)
       ) AS coleccion
       FROM (
         SELECT rec.*, o.nombre AS organizacion
           FROM recursos rec
           LEFT JOIN organizaciones o ON o.id = rec.organizacion_id
           ${donde}
          ORDER BY rec.nombre
          LIMIT $${parametros.length}
       ) f`,
      parametros,
    );

    return rows[0]!.coleccion;
  });

  /**
   * Actualiza estado, ocupación o posición de un recurso.
   *
   * La posición importa: una ambulancia o un equipo de rescate se mueven, y el
   * término de aislamiento del índice de prioridad mide la distancia al recurso
   * disponible más cercano. Un recurso con posición vieja distorsiona la cola.
   */
  app.patch<{ Params: { id: string } }>('/v1/recursos/:id', async (peticion) => {
    if (!puedeOperar(peticion.sesion)) {
      throw sinPermiso('Solo el personal operativo puede actualizar recursos');
    }

    const cambio = validar(zActualizarRecurso, peticion.body, 'la actualización del recurso');

    // lat y lng van juntas o no van.
    const tieneLat = cambio.lat !== undefined;
    const tieneLng = cambio.lng !== undefined;
    if (tieneLat !== tieneLng) {
      throw solicitudInvalida('Para reubicar un recurso hay que enviar lat y lng juntas');
    }

    const asignaciones: string[] = [];
    const parametros: unknown[] = [peticion.params.id];

    if (cambio.estado !== undefined) {
      parametros.push(cambio.estado);
      asignaciones.push(`estado = $${parametros.length}`);
    }
    if (cambio.capacidad_usada !== undefined) {
      parametros.push(cambio.capacidad_usada);
      asignaciones.push(`capacidad_usada = $${parametros.length}`);
    }
    if (cambio.notas !== undefined) {
      parametros.push(cambio.notas);
      asignaciones.push(`notas = $${parametros.length}`);
    }
    if (tieneLat && tieneLng) {
      parametros.push(cambio.lng, cambio.lat);
      asignaciones.push(
        `geom = ST_SetSRID(ST_MakePoint($${parametros.length - 1}, $${parametros.length}), 4326)::geography`,
      );
    }

    if (asignaciones.length === 0) {
      throw solicitudInvalida('No se envió ningún campo a actualizar');
    }

    const { rows } = await bd.consultar<Record<string, unknown>>(
      `UPDATE recursos SET ${asignaciones.join(', ')}
        WHERE id = $1
        RETURNING id, nombre, tipo, estado, capacidad_total, capacidad_usada,
                  ST_Y(geom::geometry) AS lat, ST_X(geom::geometry) AS lng,
                  actualizado_en`,
      parametros,
    );

    if (!rows[0]) throw noEncontrado('El recurso');
    return rows[0];
  });

  /** Recursos más cercanos a un punto, ordenados por distancia. */
  app.get('/v1/recursos/cercanos', async (peticion) => {
    const consulta = peticion.query as Record<string, string>;
    const lat = Number.parseFloat(consulta.lat ?? '');
    const lng = Number.parseFloat(consulta.lng ?? '');
    const limite = Math.min(Number.parseInt(consulta.limite ?? '5', 10) || 5, 50);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      throw solicitudInvalida('lat y lng son obligatorios y deben ser números');
    }

    const { rows } = await bd.consultar(
      `SELECT rec.id,
              rec.nombre,
              rec.tipo,
              rec.estado,
              rec.capacidad_total - rec.capacidad_usada AS cupos_libres,
              round(ST_Distance(rec.geom, punto.geom)::numeric, 1) AS distancia_m,
              ST_Y(rec.geom::geometry) AS lat,
              ST_X(rec.geom::geometry) AS lng
         FROM recursos rec
        CROSS JOIN (SELECT ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography AS geom) punto
        WHERE rec.estado = 'DISPONIBLE'
        ORDER BY rec.geom <-> punto.geom
        LIMIT $3`,
      [lng, lat, limite],
    );

    return { recursos: rows };
  });
}
