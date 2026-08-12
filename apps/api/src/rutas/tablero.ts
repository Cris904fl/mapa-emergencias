import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { bd } from '../db/pool.ts';
import { config } from '../config.ts';
import { pesosVigentes, refrescarPrioridadesVencidas } from '../servicios/prioridad.ts';
import { solicitudInvalida } from '../lib/errores.ts';
import { FILTROS, condicionDeFiltro, etiquetaDeFiltro, zFiltro } from '../esquemas/filtros.ts';
import { zSeveridad } from '../esquemas/dominio.ts';

/**
 * Consultas agregadas para el tablero de la sala de crisis. Todas de lectura y
 * apoyadas en las vistas de db/migrations/005_prioridad.sql.
 */
export async function rutasTablero(app: FastifyInstance): Promise<void> {
  /**
   * Cola de atención ordenada por prioridad.
   *
   * `vivo=true` recalcula el puntaje al consultar (exacto, pero una llamada a
   * función por fila); por defecto lee la columna materializada, que un
   * trabajador refresca cada minuto. Se expone la diferencia en lugar de
   * esconderla porque en una sala de crisis conviene saber qué tan fresco es
   * el número que se está mirando.
   */
  app.get('/v1/tablero/cola', async (peticion) => {
    const consulta = peticion.query as Record<string, string>;
    const limite = Math.min(Number.parseInt(consulta.limite ?? '50', 10) || 50, 500);
    const vivo = consulta.vivo === 'true';

    // El filtro llega como el nombre del mosaico que se tocó en el tablero.
    const nombreFiltro = consulta.filtro
      ? zFiltro.safeParse(consulta.filtro)
      : { success: false as const };
    const filtro = nombreFiltro.success ? nombreFiltro.data : undefined;
    if (consulta.filtro && !filtro) {
      throw solicitudInvalida(`Filtro desconocido: ${consulta.filtro}`);
    }

    const { condicion, incluyeCerrados } = condicionDeFiltro(filtro);

    /**
     * Severidad, ortogonal al filtro de KPI.
     *
     * El mapa ya podía filtrar por severidad (`GET /v1/reportes`) pero la cola
     * no, así que tocar la leyenda habría dejado el mapa mostrando tres puntos y
     * la lista veinte. Se combina con el filtro de KPI con AND: los dos
     * responden preguntas distintas —«qué tan grave» y «en qué situación
     * está»— y un operador quiere poder cruzarlas.
     */
    const severidad = consulta.severidad
      ? zSeveridad.safeParse(consulta.severidad)
      : { success: false as const };
    if (consulta.severidad && !severidad.success) {
      throw solicitudInvalida(`Severidad desconocida: ${consulta.severidad}`);
    }

    // La vista viva no expone todas las columnas que usan los filtros, así que
    // se filtra sobre la tabla y se recalcula el puntaje al vuelo por fila. Es
    // el mismo compromiso que ya tenía el modo vivo: exactitud a cambio de una
    // llamada a función por fila.
    const donde = [
      incluyeCerrados ? null : `r.estado NOT IN ('RESUELTO', 'DUPLICADO', 'DESCARTADO')`,
      condicion,
      // El valor sale del enum ya validado, no de la petición en crudo: es la
      // misma razón por la que las condiciones de filtros.ts se pueden
      // interpolar sin riesgo de inyección.
      severidad.success ? `r.severidad = '${severidad.data}'` : null,
    ]
      .filter(Boolean)
      .join(' AND ');

    const puntaje = vivo
      ? `(fn_prioridad_reporte(r.id)->>'score')::numeric`
      : 'r.prioridad_score';
    const componentes = vivo
      ? `fn_prioridad_reporte(r.id)->'componentes'`
      : 'r.prioridad_componentes';

    const { rows } = await bd.consultar(
      `SELECT r.id, r.codigo_publico, r.categoria, r.severidad, r.estado, r.descripcion,
              r.personas_afectadas, r.personas_atrapadas, r.personas_heridas,
              r.personas_vulnerables, r.requiere_rescate, r.origen_triage,
              r.reportado_en, r.primera_respuesta_en,
              l.nombre AS lugar,
              u.nombre AS responsable,
              r.tomado_en,
              ST_Y(r.geom::geometry) AS lat,
              ST_X(r.geom::geometry) AS lng,
              ${puntaje} AS score,
              ${componentes} AS componentes,
              r.prioridad_calculada_en
         FROM reportes r
         LEFT JOIN lugares l  ON l.id = r.lugar_id
         LEFT JOIN usuarios u ON u.id = r.responsable_id
        WHERE ${donde}
        ORDER BY ${vivo ? 'score' : 'r.prioridad_score'} DESC NULLS LAST, r.reportado_en
        LIMIT $1`,
      [limite],
    );

    return {
      modo: vivo ? 'vivo' : 'materializado',
      filtro: filtro ?? null,
      filtro_etiqueta: filtro ? etiquetaDeFiltro(filtro) : null,
      severidad: severidad.success ? severidad.data : null,
      total: rows.length,
      pesos: await pesosVigentes(),
      reportes: rows,
    };
  });

  /**
   * Refresco de prioridades por invocación externa.
   *
   * Existe para el despliegue sin Redis: dos términos del índice cambian solos
   * —la espera crece con el reloj y la concentración cambia cuando llegan
   * reportes vecinos— y sin el trabajador de BullMQ nadie los recalcula. Un cron
   * externo gratuito (cron-job.org, GitHub Actions) golpea esta ruta cada minuto
   * y cumple la misma función.
   *
   * Se protege con un secreto compartido y no con la sesión de operador porque
   * el llamador es una máquina, no una persona.
   */
  app.post('/v1/mantenimiento/refrescar-prioridades', async (peticion, respuesta) => {
    const secreto = config.SECRETO_MANTENIMIENTO;
    if (!secreto) {
      throw solicitudInvalida('SECRETO_MANTENIMIENTO no está configurado en esta instancia');
    }

    const enviado = peticion.headers['x-secreto-mantenimiento'];
    // Comparación de longitud constante: esta ruta es pública.
    const iguales =
      typeof enviado === 'string' &&
      enviado.length === secreto.length &&
      timingSafeEqual(Buffer.from(enviado), Buffer.from(secreto));

    if (!iguales) {
      return respuesta.code(401).send({ error: 'no_autenticado', mensaje: 'Secreto inválido' });
    }

    const refrescados = await refrescarPrioridadesVencidas(60, 500);
    return { refrescados };
  });

  /** Consolidado por zona administrativa. */
  app.get('/v1/tablero/zonas', async () => {
    const { rows } = await bd.consultar(
      `SELECT * FROM v_resumen_por_lugar
        WHERE reportes_abiertos > 0
        ORDER BY personas_afectadas DESC, prioridad_maxima DESC NULLS LAST`,
    );
    return { zonas: rows };
  });

  /**
   * Conglomerados por densidad (DBSCAN).
   *
   * Responde "¿dónde está pasando algo grande?" sin que nadie haya tenido que
   * decidir de antemano cuántos eventos hay ni dónde poner una grilla.
   */
  app.get('/v1/tablero/conglomerados', async (peticion) => {
    const consulta = peticion.query as Record<string, string>;
    const radioM = Math.min(Number.parseInt(consulta.radio_m ?? '300', 10) || 300, 20_000);
    const minimo = Math.max(Number.parseInt(consulta.minimo ?? '2', 10) || 2, 2);

    if (radioM < 10) throw solicitudInvalida('radio_m debe ser al menos 10');

    // ST_ClusterDBSCAN opera sobre geometry y su eps va en grados. A las
    // latitudes de Colombia 1 grado ≈ 111 320 m, aproximación suficiente para
    // agrupar; las distancias que se reportan sí se calculan sobre geography.
    const { rows } = await bd.consultar(
      `WITH agrupados AS (
         SELECT id, codigo_publico, categoria, severidad, personas_afectadas,
                personas_atrapadas, prioridad_score, geom,
                ST_ClusterDBSCAN(geom::geometry, eps := $1 / 111320.0, minpoints := $2)
                  OVER () AS grupo
           FROM reportes
          WHERE estado NOT IN ('RESUELTO', 'DUPLICADO', 'DESCARTADO')
       )
       SELECT grupo,
              count(*)::int                     AS reportes,
              sum(personas_afectadas)::int      AS personas_afectadas,
              sum(personas_atrapadas)::int      AS personas_atrapadas,
              max(prioridad_score)              AS prioridad_maxima,
              round(avg(prioridad_score)::numeric, 2) AS prioridad_promedio,
              array_agg(codigo_publico ORDER BY prioridad_score DESC NULLS LAST) AS codigos,
              array_agg(DISTINCT categoria::text)     AS categorias,
              ST_Y(ST_Centroid(ST_Collect(geom::geometry))) AS lat,
              ST_X(ST_Centroid(ST_Collect(geom::geometry))) AS lng
         FROM agrupados
        WHERE grupo IS NOT NULL
        GROUP BY grupo
        ORDER BY personas_afectadas DESC`,
      [radioM, minimo],
    );

    return { radio_m: radioM, minimo_por_grupo: minimo, conglomerados: rows };
  });

  /** Cifras de cabecera. */
  app.get('/v1/tablero/resumen', async () => {
    const { rows } = await bd.consultar<Record<string, unknown>>(
      // Los count()/sum() se convierten a int en SQL: sin el cast el driver de
      // Postgres los entrega como texto (bigint no cabe en un number de
      // JavaScript) y el tablero tendría que parsearlos. Para estas cifras el
      // rango de int es de sobra; el único bigint que se deja como texto es
      // medios_reporte.bytes, donde el desborde sí es posible.
      `SELECT
         (count(*) FILTER (WHERE estado NOT IN ('RESUELTO','DUPLICADO','DESCARTADO')))::int AS abiertos,
         (count(*) FILTER (WHERE estado = 'RECIBIDO'))::int                                 AS sin_triage,
         (count(*) FILTER (WHERE primera_respuesta_en IS NULL
                             AND estado NOT IN ('RESUELTO','DUPLICADO','DESCARTADO')))::int  AS sin_atender,
         (count(*) FILTER (WHERE severidad = 'CRITICA'
                             AND estado NOT IN ('RESUELTO','DUPLICADO','DESCARTADO')))::int  AS criticos,
         (count(*) FILTER (WHERE requiere_rescate
                             AND estado NOT IN ('RESUELTO','DUPLICADO','DESCARTADO')))::int  AS con_rescate_pendiente,
         (count(*) FILTER (WHERE estado = 'RESUELTO'))::int                                  AS resueltos,
         coalesce(sum(personas_atrapadas) FILTER (
           WHERE estado NOT IN ('RESUELTO','DUPLICADO','DESCARTADO')), 0)::int               AS personas_atrapadas,
         coalesce(sum(personas_heridas) FILTER (
           WHERE estado NOT IN ('RESUELTO','DUPLICADO','DESCARTADO')), 0)::int               AS personas_heridas,
         coalesce(sum(personas_afectadas) FILTER (
           WHERE estado NOT IN ('RESUELTO','DUPLICADO','DESCARTADO')), 0)::int               AS personas_afectadas,
         (count(*) FILTER (WHERE origen_triage = 'IA'))::int                                 AS triados_por_ia,
         (count(*) FILTER (WHERE origen_triage = 'OPERADOR'))::int                           AS triados_por_persona,
         -- La condición se toma del catálogo de filtros en vez de copiarla: es la
         -- misma que responde la cola cuando se toca este mosaico, y si las dos
         -- se separan el tablero miente sobre su propia cifra. Por eso la tabla
         -- va aliasada como r, que es el alias que usan las condiciones.
         (count(*) FILTER (WHERE ${FILTROS.estancados.condicion}))::int                      AS asignados_estancados
       FROM reportes r`,
    );

    const { rows: masAntiguo } = await bd.consultar<{ minutos: number | null }>(
      `SELECT round(extract(epoch FROM (now() - min(reportado_en))) / 60) AS minutos
         FROM reportes
        WHERE primera_respuesta_en IS NULL
          AND estado NOT IN ('RESUELTO','DUPLICADO','DESCARTADO')`,
    );

    const { rows: recursos } = await bd.consultar<Record<string, unknown>>(
      `SELECT (count(*) FILTER (WHERE estado = 'DISPONIBLE'))::int     AS disponibles,
              (count(*) FILTER (WHERE estado = 'OCUPADO'))::int        AS ocupados,
              (count(*) FILTER (WHERE estado = 'AGOTADO'))::int        AS agotados,
              (count(*) FILTER (WHERE estado = 'FUERA_SERVICIO'))::int AS fuera_de_servicio
         FROM recursos`,
    );

    return {
      reportes: rows[0],
      espera_maxima_minutos: masAntiguo[0]?.minutos ?? null,
      recursos: recursos[0],
      generado_en: new Date().toISOString(),
    };
  });

  /** Reportes fuera del alcance de todo recurso disponible. */
  app.get('/v1/tablero/aislados', async (peticion) => {
    const consulta = peticion.query as Record<string, string>;
    const umbralM = Math.min(Number.parseInt(consulta.umbral_m ?? '5000', 10) || 5000, 200_000);

    const { rows } = await bd.consultar(
      `SELECT r.id, r.codigo_publico, r.categoria, r.severidad,
              r.personas_afectadas, r.prioridad_score,
              l.nombre AS lugar,
              round(cercano.distancia_m::numeric, 0) AS distancia_recurso_m,
              ST_Y(r.geom::geometry) AS lat,
              ST_X(r.geom::geometry) AS lng
         FROM reportes r
         LEFT JOIN lugares l ON l.id = r.lugar_id
         LEFT JOIN LATERAL (
           SELECT ST_Distance(rec.geom, r.geom) AS distancia_m
             FROM recursos rec
            WHERE rec.estado = 'DISPONIBLE'
            ORDER BY rec.geom <-> r.geom
            LIMIT 1
         ) cercano ON true
        WHERE r.estado NOT IN ('RESUELTO', 'DUPLICADO', 'DESCARTADO')
          AND (cercano.distancia_m IS NULL OR cercano.distancia_m > $1)
        ORDER BY cercano.distancia_m DESC NULLS FIRST`,
      [umbralM],
    );

    return { umbral_m: umbralM, reportes: rows };
  });

  /**
   * Posibles duplicados. Propone pares; la decisión es de una persona.
   *
   * La deduplicación automática es tentadora y peligrosa: dos llamados de la
   * misma cuadra pueden ser el mismo evento o dos casas distintas, y fusionar
   * mal significa dejar de atender a alguien.
   */
  app.get('/v1/tablero/posibles-duplicados', async (peticion) => {
    const consulta = peticion.query as Record<string, string>;
    const radioM = Math.min(Number.parseInt(consulta.radio_m ?? '150', 10) || 150, 5000);
    const minutos = Math.min(Number.parseInt(consulta.minutos ?? '120', 10) || 120, 1440);

    const { rows } = await bd.consultar(
      `SELECT a.id AS id_a, a.codigo_publico AS codigo_a,
              b.id AS id_b, b.codigo_publico AS codigo_b,
              a.categoria,
              round(ST_Distance(a.geom, b.geom)::numeric, 0) AS metros,
              round(abs(extract(epoch FROM (a.reportado_en - b.reportado_en)) / 60)) AS minutos_aparte,
              round(similarity(coalesce(a.descripcion, ''), coalesce(b.descripcion, ''))::numeric, 3)
                AS similitud_texto
         FROM reportes a
         JOIN reportes b
           ON b.id > a.id
          AND b.categoria = a.categoria
          AND ST_DWithin(a.geom, b.geom, $1)
          AND abs(extract(epoch FROM (a.reportado_en - b.reportado_en))) < $2 * 60
        WHERE a.estado NOT IN ('RESUELTO', 'DUPLICADO', 'DESCARTADO')
          AND b.estado NOT IN ('RESUELTO', 'DUPLICADO', 'DESCARTADO')
        ORDER BY metros, minutos_aparte`,
      [radioM, minutos],
    );

    return { radio_m: radioM, ventana_minutos: minutos, pares: rows };
  });
}
