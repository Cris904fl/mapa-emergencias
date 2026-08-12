import { bd } from '../db/pool.ts';
import { config } from '../config.ts';

/**
 * Ruta desde donde está el rescatista hasta el caso.
 *
 * Hay una advertencia de dominio en el centro de este archivo, y es la razón por
 * la que no basta con llamar a un motor de rutas y devolver la respuesta.
 *
 * Un motor de ruteo trabaja sobre el grafo vial de OpenStreetMap, que refleja
 * las calles en un día normal. En una emergencia las calles están tapadas con
 * escombros, hundidas, inundadas o cortadas por un deslizamiento — y este
 * sistema ya sabe cuáles, porque los ciudadanos las están reportando. Devolver
 * una ruta que pasa por una vía que alguien reportó bloqueada hace diez minutos
 * es mandar al rescatista a perder tiempo que no tiene.
 *
 * Así que la ruta se cruza contra los reportes abiertos que la obstruyen y se
 * devuelven como advertencias. No se recalcula la ruta evitándolos: eso requiere
 * un grafo propio con pgRouting y penalizaciones dinámicas, que es un proyecto
 * en sí mismo. Avisar es honesto y ya es útil; recalcular mal sería peor que no
 * recalcular.
 */

export type Coordenada = { lat: number; lng: number };

/** Categorías que hacen intransitable o difícil una vía. */
const CATEGORIAS_OBSTRUCTIVAS = [
  'VIA_BLOQUEADA',
  'DESLIZAMIENTO',
  'INUNDACION',
  'INCENDIO',
] as const;

export type Obstaculo = {
  id: string;
  codigo_publico: string;
  categoria: string;
  severidad: string;
  lat: number;
  lng: number;
  /** Distancia del obstáculo a la ruta propuesta, en metros. */
  distancia_a_ruta_m: number;
  /** Metros a recorrer desde el origen hasta encontrarlo. */
  metros_desde_origen: number;
  descripcion: string | null;
  reportado_en: string;
};

export type Ruta = {
  /**
   * `vial` = ruta real por calles. `linea_recta` = no hubo motor de ruteo
   * disponible y esto es la distancia geodésica, que en ciudad puede quedarse
   * corta por un factor de 1.3 a 1.6.
   */
  tipo: 'vial' | 'linea_recta';
  distancia_m: number;
  duracion_s: number | null;
  geometria: { type: 'LineString'; coordinates: [number, number][] };
  obstaculos: Obstaculo[];
  /** Presente cuando el ruteo falló y se cayó a la línea recta. */
  aviso?: string;
};

const RADIO_TIERRA_M = 6_371_008.8;

/** Distancia geodésica. Suficiente para el respaldo; PostGIS hace lo exacto. */
function distanciaHaversine(a: Coordenada, b: Coordenada): number {
  const aRad = (grados: number) => (grados * Math.PI) / 180;
  const dLat = aRad(b.lat - a.lat);
  const dLng = aRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aRad(a.lat)) * Math.cos(aRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * RADIO_TIERRA_M * Math.asin(Math.sqrt(h));
}

function lineaRecta(desde: Coordenada, hasta: Coordenada, aviso?: string): Omit<Ruta, 'obstaculos'> {
  return {
    tipo: 'linea_recta',
    distancia_m: Math.round(distanciaHaversine(desde, hasta)),
    // Sin ruta no hay estimación de tiempo defendible: en emergencia el
    // recorrido depende de qué calles quedaron abiertas, no de la distancia.
    // Devolver null es más honesto que inventar una velocidad promedio.
    duracion_s: null,
    geometria: {
      type: 'LineString',
      coordinates: [
        [desde.lng, desde.lat],
        [hasta.lng, hasta.lat],
      ],
    },
    ...(aviso ? { aviso } : {}),
  };
}

async function rutaVial(
  desde: Coordenada,
  hasta: Coordenada,
): Promise<Omit<Ruta, 'obstaculos'>> {
  if (!config.RUTEO_URL) {
    return lineaRecta(desde, hasta, 'No hay motor de ruteo configurado (RUTEO_URL vacío).');
  }

  const base = config.RUTEO_URL.replace(/\/$/, '');
  // OSRM espera lng,lat — al revés de lo habitual. Confundirlo devuelve rutas
  // en el otro hemisferio, que es un error silencioso y desconcertante.
  const coordenadas = `${desde.lng},${desde.lat};${hasta.lng},${hasta.lat}`;
  const url = `${base}/route/v1/driving/${coordenadas}?overview=full&geometries=geojson&alternatives=false`;

  try {
    const respuesta = await fetch(url, { signal: AbortSignal.timeout(8000) });

    if (!respuesta.ok) {
      return lineaRecta(desde, hasta, `El motor de ruteo respondió ${respuesta.status}.`);
    }

    const cuerpo = (await respuesta.json()) as {
      code?: string;
      routes?: {
        distance?: number;
        duration?: number;
        geometry?: { type?: string; coordinates?: [number, number][] };
      }[];
    };

    const ruta = cuerpo.routes?.[0];
    if (cuerpo.code !== 'Ok' || !ruta?.geometry?.coordinates?.length) {
      return lineaRecta(
        desde,
        hasta,
        `El motor de ruteo no encontró ruta (code: ${cuerpo.code ?? '?'}). Puede ser que el punto quede lejos de una vía conocida.`,
      );
    }

    return {
      tipo: 'vial',
      distancia_m: Math.round(ruta.distance ?? 0),
      duracion_s: ruta.duration != null ? Math.round(ruta.duration) : null,
      geometria: { type: 'LineString', coordinates: ruta.geometry.coordinates },
    };
  } catch (error) {
    const esTiempoLimite = error instanceof Error && error.name === 'TimeoutError';
    return lineaRecta(
      desde,
      hasta,
      esTiempoLimite
        ? 'El motor de ruteo no respondió a tiempo.'
        : `No se pudo consultar el motor de ruteo: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Reportes abiertos que obstruyen la ruta.
 *
 * `ST_LineLocatePoint` da la posición del obstáculo a lo largo de la ruta como
 * fracción de 0 a 1, y multiplicada por la longitud da los metros desde el
 * origen. Eso permite ordenarlos por el orden en que el rescatista los va a
 * encontrar, que es la información útil: un bloqueo a 200 m importa más que uno
 * a 3 km, porque el primero se resuelve dando la vuelta y el segundo puede que
 * ya esté despejado cuando llegue.
 */
async function obstaculosEnRuta(
  geometria: Ruta['geometria'],
  excluirReporteId: string,
): Promise<Obstaculo[]> {
  // Con dos puntos idénticos ST_MakeLine produce una geometría degenerada.
  if (geometria.coordinates.length < 2) return [];

  const { rows } = await bd.consultar<Obstaculo>(
    `WITH ruta AS (
       SELECT ST_SetSRID(ST_GeomFromGeoJSON($1), 4326) AS geom_plana
     ),
     medida AS (
       SELECT geom_plana,
              geom_plana::geography AS geom_geo,
              ST_Length(geom_plana::geography) AS largo_m
         FROM ruta
     )
     SELECT r.id,
            r.codigo_publico,
            r.categoria::text  AS categoria,
            r.severidad::text  AS severidad,
            ST_Y(r.geom::geometry) AS lat,
            ST_X(r.geom::geometry) AS lng,
            round(ST_Distance(r.geom, m.geom_geo)::numeric, 0)::int AS distancia_a_ruta_m,
            round(
              (ST_LineLocatePoint(m.geom_plana, r.geom::geometry) * m.largo_m)::numeric,
              0
            )::int AS metros_desde_origen,
            r.descripcion,
            r.reportado_en
       FROM reportes r
       CROSS JOIN medida m
      WHERE r.id <> $2
        AND r.estado NOT IN ('RESUELTO', 'DUPLICADO', 'DESCARTADO')
        AND r.categoria = ANY($3::categoria_reporte[])
        AND ST_DWithin(r.geom, m.geom_geo, $4)
      ORDER BY metros_desde_origen`,
    [
      JSON.stringify(geometria),
      excluirReporteId,
      CATEGORIAS_OBSTRUCTIVAS,
      config.RUTEO_RADIO_OBSTACULO_M,
    ],
  );

  return rows;
}

/** Calcula la ruta y le anexa los obstáculos reportados. */
export async function rutaHastaReporte(
  desde: Coordenada,
  hasta: Coordenada,
  reporteId: string,
): Promise<Ruta> {
  const ruta = await rutaVial(desde, hasta);
  const obstaculos = await obstaculosEnRuta(ruta.geometria, reporteId);
  return { ...ruta, obstaculos };
}
