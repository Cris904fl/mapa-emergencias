import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { bd, enTransaccion } from '../db/pool.ts';
import { zLatitud, zLongitud } from '../esquemas/dominio.ts';
import { conflicto, noEncontrado, sinPermiso, solicitudInvalida } from '../lib/errores.ts';
import { validar } from '../lib/validar.ts';
import { puedeOperar } from '../lib/auth.ts';
import { refrescarPrioridad } from '../servicios/prioridad.ts';
import { notificarCambioDeEstado } from '../servicios/notificaciones.ts';
import { rutaHastaReporte } from '../servicios/ruteo.ts';

/**
 * Rutas para trabajo en campo.
 *
 * Separadas de `/v1/tablero` porque el usuario es distinto: alguien con un
 * celular, moviéndose, con una mano ocupada y con prisa. Las respuestas traen lo
 * mínimo para decidir a dónde ir, y las acciones son de un solo paso.
 */

const zPosicion = z.object({
  lat: zLatitud,
  lng: zLongitud,
  precision_m: z.number().nonnegative().max(100_000).optional(),
});

const zConsultaCasos = z.object({
  lat: z.coerce.number().pipe(zLatitud),
  lng: z.coerce.number().pipe(zLongitud),
  radio_m: z.coerce.number().int().min(100).max(100_000).default(10_000),
  limite: z.coerce.number().int().min(1).max(100).default(20),
  /**
   * `prioridad` usa el índice del sistema, que ya pondera personas, gravedad,
   * aislamiento y espera. `distancia` responde literalmente "cuál tengo más
   * cerca". No se ofrece una tercera mezcla inventada: son dos preguntas
   * distintas y quien está en campo sabe cuál está haciendo.
   */
  orden: z.enum(['prioridad', 'distancia']).default('prioridad'),
  /** Excluye los casos que ya tomó otra persona. */
  solo_libres: z.coerce.boolean().default(false),
});

const zRuta = z.object({
  lat: z.coerce.number().pipe(zLatitud),
  lng: z.coerce.number().pipe(zLongitud),
});

const zResolver = z.object({
  nota: z.string().trim().max(1000).optional(),
  personas_atendidas: z.number().int().min(0).max(100_000).optional(),
  /**
   * Hora de llegada al sitio, para quien cerró sin haberla marcado.
   *
   * Es opcional y sin valor por defecto a propósito. Rellenarla sola con el
   * instante del cierre parecería más completo y sería peor: un caso cerrado a
   * los 45 minutos pudo haber llegado a los 10, y ese dato inventado
   * envenenaría la única medición que sirve para calibrar el umbral de
   * «asignados sin llegada». No saber es un estado válido; fingir que se sabe
   * no lo es.
   *
   * Se guarda como DECLARADA, distinta de la MARCADA en su momento.
   */
  llego_en: z.string().datetime({ offset: true }).optional(),
});

export async function rutasCampo(app: FastifyInstance): Promise<void> {
  /** Toda esta sección exige personal operativo. */
  app.addHook('onRequest', async (peticion) => {
    if (!peticion.url.startsWith('/v1/campo')) return;
    if (!puedeOperar(peticion.sesion)) {
      throw sinPermiso('Esta sección es para personal de socorro autenticado');
    }
  });

  /**
   * Reporta la posición del dispositivo.
   *
   * Se guarda con su hora para que quien la consulte sepa de cuándo es: una
   * posición de hace dos horas en una emergencia es casi inútil, y presentarla
   * como actual sería peor que no tenerla.
   */
  app.post('/v1/campo/posicion', async (peticion) => {
    const posicion = validar(zPosicion, peticion.body, 'la posición');
    const usuarioId = peticion.sesion!.usuarioId;

    await bd.consultar(
      `UPDATE usuarios
          SET ultima_posicion = ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography,
              posicion_precision_m = $4,
              posicion_en = now()
        WHERE id = $1`,
      [usuarioId, posicion.lng, posicion.lat, posicion.precision_m ?? null],
    );

    return { registrada_en: new Date().toISOString() };
  });

  /**
   * Casos cercanos a una posición.
   *
   * La distancia se calcula con `ST_Distance` sobre geography —metros reales— y
   * el orden por distancia usa el operador `<->` con el índice GiST, así que el
   * LIMIT corta temprano en lugar de medir contra todos los reportes abiertos.
   */
  app.get('/v1/campo/casos', async (peticion) => {
    const consulta = validar(zConsultaCasos, peticion.query, 'los parámetros');
    const usuarioId = peticion.sesion!.usuarioId;

    // El orden por distancia aprovecha el índice; el de prioridad ordena el
    // conjunto ya recortado por radio.
    const ordenSql =
      consulta.orden === 'distancia'
        ? 'c.geom <-> punto.geom'
        : 'c.prioridad_score DESC NULLS LAST, c.geom <-> punto.geom';

    const filtroLibres = consulta.solo_libres
      ? 'AND (c.responsable_id IS NULL OR c.responsable_id = $5)'
      : '';

    const { rows } = await bd.consultar(
      `SELECT c.id,
              c.codigo_publico,
              c.categoria,
              c.severidad,
              c.estado,
              c.descripcion,
              c.personas_afectadas,
              c.personas_atrapadas,
              c.personas_heridas,
              c.personas_vulnerables,
              c.requiere_rescate,
              c.contacto_reportante,
              c.reportado_en,
              c.prioridad_score,
              c.lugar,
              c.lat,
              c.lng,
              c.responsable_id,
              c.responsable,
              c.tomado_en,
              (c.responsable_id = $5) AS es_mio,
              round(ST_Distance(c.geom, punto.geom)::numeric, 0)::int AS distancia_m
         FROM v_casos_campo c
        CROSS JOIN (SELECT ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography AS geom) punto
        WHERE ST_DWithin(c.geom, punto.geom, $3)
          ${filtroLibres}
        ORDER BY ${ordenSql}
        LIMIT $4`,
      [consulta.lng, consulta.lat, consulta.radio_m, consulta.limite, usuarioId],
    );

    return {
      orden: consulta.orden,
      radio_m: consulta.radio_m,
      desde: { lat: consulta.lat, lng: consulta.lng },
      casos: rows,
    };
  });

  /** Casos que tomó quien consulta. Es la pantalla de "lo mío". */
  app.get('/v1/campo/mis-casos', async (peticion) => {
    const usuarioId = peticion.sesion!.usuarioId;

    const { rows } = await bd.consultar(
      `SELECT id, codigo_publico, categoria, severidad, estado, descripcion,
              personas_afectadas, personas_atrapadas, personas_heridas,
              requiere_rescate, contacto_reportante, reportado_en,
              prioridad_score, lugar, lat, lng, tomado_en
         FROM v_casos_campo
        WHERE responsable_id = $1
        ORDER BY prioridad_score DESC NULLS LAST`,
      [usuarioId],
    );

    return { casos: rows };
  });

  /**
   * Ruta hasta un caso, con los reportes que la obstruyen.
   *
   * Lo segundo es la parte que un mapa comercial no puede dar: las vías
   * bloqueadas, deslizamientos e inundaciones que hay sobre el trayecto salen de
   * los reportes de esta misma emergencia, no del grafo vial.
   */
  app.get<{ Params: { id: string } }>('/v1/campo/casos/:id/ruta', async (peticion) => {
    const desde = validar(zRuta, peticion.query, 'la posición de origen');

    const { rows } = await bd.consultar<{ lat: number; lng: number; codigo_publico: string }>(
      `SELECT ST_Y(geom::geometry) AS lat, ST_X(geom::geometry) AS lng, codigo_publico
         FROM reportes WHERE id = $1`,
      [peticion.params.id],
    );
    const destino = rows[0];
    if (!destino) throw noEncontrado('El caso');

    const ruta = await rutaHastaReporte(desde, destino, peticion.params.id);

    return {
      caso: { id: peticion.params.id, codigo_publico: destino.codigo_publico },
      destino: { lat: destino.lat, lng: destino.lng },
      ...ruta,
    };
  });

  /**
   * Toma un caso.
   *
   * El UPDATE es condicional a que nadie más lo tenga. Es lo que evita que dos
   * rescatistas salgan al mismo sitio: el segundo recibe 409 con el nombre de
   * quien lo tomó, en lugar de sobreescribirlo en silencio. La condición está en
   * el WHERE y no en una lectura previa a propósito — leer y después escribir
   * deja una ventana entre las dos operaciones.
   */
  app.post<{ Params: { id: string } }>('/v1/campo/casos/:id/tomar', async (peticion) => {
    const usuarioId = peticion.sesion!.usuarioId;
    const organizacionId = peticion.sesion!.organizacionId;

    const resultado = await enTransaccion(
      async (cliente) => {
        const { rows } = await cliente.consultar<{ estado: string; codigo_publico: string }>(
          `UPDATE reportes
              SET responsable_id = $2,
                  organizacion_asignada_id = coalesce(organizacion_asignada_id, $3),
                  estado = CASE WHEN estado IN ('RECIBIDO', 'EN_TRIAGE', 'VERIFICADO')
                                THEN 'ASIGNADO'::estado_reporte
                                ELSE estado END,
                  origen_triage = 'OPERADOR'
            WHERE id = $1
              AND estado NOT IN ('RESUELTO', 'DUPLICADO', 'DESCARTADO')
              AND (responsable_id IS NULL OR responsable_id = $2)
            RETURNING estado::text, codigo_publico`,
          [peticion.params.id, usuarioId, organizacionId],
        );
        return rows[0] ?? null;
      },
      { usuarioId, nota: 'Caso tomado en campo' },
    );

    if (!resultado) {
      // Distinguir "no existe" de "ya lo tomó otro" y de "ya está cerrado":
      // en campo son tres situaciones con reacciones distintas.
      const { rows } = await bd.consultar<{
        estado: string;
        responsable: string | null;
      }>(
        `SELECT r.estado::text, u.nombre AS responsable
           FROM reportes r
           LEFT JOIN usuarios u ON u.id = r.responsable_id
          WHERE r.id = $1`,
        [peticion.params.id],
      );

      const existente = rows[0];
      if (!existente) throw noEncontrado('El caso');
      if (['RESUELTO', 'DUPLICADO', 'DESCARTADO'].includes(existente.estado)) {
        throw conflicto(`Este caso ya está ${existente.estado.toLowerCase()}`);
      }
      throw conflicto(
        `El caso ya lo tomó ${existente.responsable ?? 'otra persona'}`,
        { responsable: existente.responsable },
      );
    }

    await refrescarPrioridad(peticion.params.id);

    // Avisarle a quien reportó: es el momento en que 'mandé algo a un buzón' se
    // convierte en 'alguien viene'. Nunca puede tumbar la acción de campo.
    await notificarCambioDeEstado(peticion.params.id, 'ASIGNADO').catch(() => {});

    return { tomado: true, codigo_publico: resultado.codigo_publico, estado: resultado.estado };
  });

  /** Libera un caso que ya no se va a atender, para que lo tome alguien más. */
  app.post<{ Params: { id: string } }>('/v1/campo/casos/:id/liberar', async (peticion) => {
    const usuarioId = peticion.sesion!.usuarioId;

    const { rowCount } = await enTransaccion(
      (cliente) =>
        cliente.consultar(
          `UPDATE reportes
              SET responsable_id = NULL,
                  estado = CASE WHEN estado = 'ASIGNADO'
                                THEN 'VERIFICADO'::estado_reporte
                                ELSE estado END
            WHERE id = $1 AND responsable_id = $2`,
          [peticion.params.id, usuarioId],
        ),
      { usuarioId, nota: 'Caso liberado en campo' },
    );

    if (rowCount === 0) throw conflicto('Este caso no está tomado por usted');
    await refrescarPrioridad(peticion.params.id);
    return { liberado: true };
  });

  /** Llegó al sitio y está trabajando. */
  app.post<{ Params: { id: string } }>('/v1/campo/casos/:id/en-atencion', async (peticion) => {
    const usuarioId = peticion.sesion!.usuarioId;

    const { rowCount } = await enTransaccion(
      (cliente) =>
        cliente.consultar(
          `UPDATE reportes SET estado = 'EN_ATENCION'
            WHERE id = $1
              AND responsable_id = $2
              AND estado NOT IN ('RESUELTO', 'DUPLICADO', 'DESCARTADO')`,
          [peticion.params.id, usuarioId],
        ),
      { usuarioId, nota: 'En atención en sitio' },
    );

    if (rowCount === 0) {
      throw conflicto('Hay que tomar el caso antes de marcarlo en atención');
    }
    await refrescarPrioridad(peticion.params.id);

    // Avisarle a quien reportó: es el momento en que 'mandé algo a un buzón' se
    // convierte en 'alguien viene'. Nunca puede tumbar la acción de campo.
    await notificarCambioDeEstado(peticion.params.id, 'EN_ATENCION').catch(() => {});

    return { estado: 'EN_ATENCION' };
  });

  /**
   * Cierra el caso.
   *
   * Solo lo puede cerrar quien lo tomó. No es burocracia: cerrar un caso lo saca
   * de la cola y de los conteos de la sala de crisis, así que tiene que quedar
   * claro quién dice que está resuelto. Un ADMIN puede hacerlo por la ruta de
   * operador (`PATCH /v1/reportes/:id/estado`) si hace falta corregir.
   */
  app.post<{ Params: { id: string } }>('/v1/campo/casos/:id/resolver', async (peticion) => {
    const cuerpo = validar(zResolver, peticion.body ?? {}, 'el cierre del caso');
    const usuarioId = peticion.sesion!.usuarioId;

    // Una llegada en el futuro es un reloj mal puesto o un dedazo, y entra a la
    // medición como un tiempo imposible. Se admite un minuto de holgura porque
    // el reloj del celular y el del servidor no van a coincidir al segundo.
    if (cuerpo.llego_en && Date.parse(cuerpo.llego_en) > Date.now() + 60_000) {
      throw solicitudInvalida('La hora de llegada no puede estar en el futuro');
    }

    const nota = [
      'Resuelto en campo',
      cuerpo.personas_atendidas !== undefined
        ? `${cuerpo.personas_atendidas} persona(s) atendida(s)`
        : null,
      cuerpo.llego_en ? 'llegada declarada al cerrar' : null,
      cuerpo.nota,
    ]
      .filter(Boolean)
      .join(' · ');

    const { rowCount } = await enTransaccion(
      (cliente) =>
        cliente.consultar(
          // La llegada solo se escribe si no había ninguna: una hora recordada
          // al cerrar no puede pisar la que se midió al llegar. Y solo se acepta
          // si es posterior a la primera respuesta — el CHECK de la tabla lo
          // exige, así que sin este filtro un dedazo tumbaría el cierre entero
          // en vez de descartar solo el dato dudoso.
          `UPDATE reportes
              SET estado = 'RESUELTO',
                  llegada_en = CASE
                    WHEN llegada_en IS NULL
                     AND $3::timestamptz IS NOT NULL
                     AND (primera_respuesta_en IS NULL OR $3::timestamptz >= primera_respuesta_en)
                    THEN $3::timestamptz ELSE llegada_en END,
                  llegada_origen = CASE
                    WHEN llegada_en IS NULL
                     AND $3::timestamptz IS NOT NULL
                     AND (primera_respuesta_en IS NULL OR $3::timestamptz >= primera_respuesta_en)
                    THEN 'DECLARADA'::origen_llegada ELSE llegada_origen END
            WHERE id = $1
              AND responsable_id = $2
              AND estado NOT IN ('RESUELTO', 'DUPLICADO', 'DESCARTADO')`,
          [peticion.params.id, usuarioId, cuerpo.llego_en ?? null],
        ),
      { usuarioId, nota },
    );

    if (rowCount === 0) {
      throw conflicto(
        'Solo puede cerrar el caso quien lo tomó, y solo si sigue abierto',
      );
    }


    // Avisarle a quien reportó: es el momento en que 'mandé algo a un buzón' se
    // convierte en 'alguien viene'. Nunca puede tumbar la acción de campo.
    await notificarCambioDeEstado(peticion.params.id, 'RESUELTO').catch(() => {});

    return { estado: 'RESUELTO', nota };
  });

  /**
   * Personal en campo con posición conocida. Para que la sala de crisis vea
   * dónde está su gente. Devuelve la antigüedad del dato, no solo el punto.
   */
  app.get('/v1/campo/personal', async () => {
    const { rows } = await bd.consultar(
      `SELECT u.id,
              u.nombre,
              u.rol::text AS rol,
              o.nombre AS organizacion,
              ST_Y(u.ultima_posicion::geometry) AS lat,
              ST_X(u.ultima_posicion::geometry) AS lng,
              u.posicion_precision_m,
              u.posicion_en,
              round(extract(epoch FROM (now() - u.posicion_en)))::int AS antiguedad_s,
              (SELECT count(*)::int FROM reportes r
                WHERE r.responsable_id = u.id
                  AND r.estado NOT IN ('RESUELTO', 'DUPLICADO', 'DESCARTADO')) AS casos_abiertos
         FROM usuarios u
         LEFT JOIN organizaciones o ON o.id = u.organizacion_id
        WHERE u.ultima_posicion IS NOT NULL
          AND u.activo
          AND u.rol IN ('RESPONDIENTE', 'OPERADOR', 'ADMIN')
        ORDER BY u.posicion_en DESC`,
    );

    return { personal: rows };
  });
}
