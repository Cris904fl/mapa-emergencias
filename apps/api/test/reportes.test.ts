import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { construirApp } from '../src/app.ts';
import { bd } from '../src/db/pool.ts';
import { config } from '../src/config.ts';
import { almacen } from '../src/servicios/almacen.ts';
import { colasHabilitadas, encolarTriage } from '../src/trabajadores/colas.ts';
import {
  asegurarBaseDePruebas,
  cerrar,
  crearLugar,
  crearRecurso,
  crearReporteDirecto,
  limpiarDatos,
} from './ayudas.ts';

/**
 * Pruebas de la ruta de reportes y de los invariantes que la base hace cumplir
 * por trigger.
 *
 * Se usa `app.inject()` en lugar de HTTP real: recorre exactamente el mismo
 * ciclo de Fastify (hooks, validación, manejador de errores) sin abrir un
 * puerto, así que la suite no choca con un servidor de desarrollo levantado.
 */

let app: FastifyInstance;

const REPORTE_BASE = {
  categoria: 'PERSONAS_ATRAPADAS',
  descripcion: 'Estamos atrapados en una casa cerca del parque, somos 5 y una señora está herida.',
  lat: 4.61,
  lng: -74.08,
};

before(async () => {
  await asegurarBaseDePruebas();
  app = await construirApp();
  await app.ready();
});

after(async () => {
  await app.close();
  await cerrar();
});

beforeEach(async () => {
  await limpiarDatos();
});

async function crearPorApi(cuerpo: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/v1/reportes',
    payload: { id_cliente: randomUUID(), ...REPORTE_BASE, ...cuerpo },
  });
}

describe('alta de reportes', () => {
  it('crea un reporte y devuelve código público legible', async () => {
    const respuesta = await crearPorApi({});
    assert.equal(respuesta.statusCode, 201);

    const cuerpo = respuesta.json();
    assert.equal(cuerpo.creado, true);
    // El código se dicta por radio: sin 0/O ni 1/I/L, que se confunden al oído.
    assert.match(cuerpo.codigo_publico, /^RPT-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{5}$/);
    assert.ok(typeof cuerpo.prioridad_score === 'number');
  });

  it('es idempotente por id_cliente: el reenvío no duplica', async () => {
    // Es la garantía de la que depende todo el modo sin conexión: la PWA puede
    // reintentar sin miedo desde el service worker, al recuperar señal o al
    // reabrirse.
    const idCliente = randomUUID();
    const carga = { id_cliente: idCliente, ...REPORTE_BASE };

    const primera = await app.inject({ method: 'POST', url: '/v1/reportes', payload: carga });
    const segunda = await app.inject({ method: 'POST', url: '/v1/reportes', payload: carga });

    assert.equal(primera.statusCode, 201);
    assert.equal(segunda.statusCode, 200, 'el reenvío responde 200, no 201');
    assert.equal(primera.json().id, segunda.json().id);
    assert.equal(segunda.json().creado, false);

    const { rows } = await bd.consultar<{ n: number }>(
      'SELECT count(*)::int AS n FROM reportes WHERE id_cliente = $1',
      [idCliente],
    );
    assert.equal(rows[0]!.n, 1);
  });

  it('rechaza coordenadas fuera del territorio colombiano', async () => {
    // (0,0) es lo que reporta un GPS que no logró fijar posición.
    const respuesta = await crearPorApi({ lat: 0, lng: 0 });
    assert.equal(respuesta.statusCode, 400);
    assert.equal(respuesta.json().error, 'solicitud_invalida');
  });

  it('rechaza una fecha de reporte en el futuro', async () => {
    const dentroDeDosHoras = new Date(Date.now() + 2 * 3600_000).toISOString();
    const respuesta = await crearPorApi({ reportado_en: dentroDeDosHoras });
    assert.equal(respuesta.statusCode, 400);
  });

  it('acepta un reporte sin descripción ni contacto (anónimo y sin texto)', async () => {
    const respuesta = await app.inject({
      method: 'POST',
      url: '/v1/reportes',
      payload: {
        id_cliente: randomUUID(),
        categoria: 'NECESITA_AGUA',
        lat: 4.61,
        lng: -74.08,
      },
    });
    assert.equal(respuesta.statusCode, 201);
  });

  it('sincroniza un lote y reporta qué se creó y qué era reenvío', async () => {
    const yaEnviado = randomUUID();
    await app.inject({
      method: 'POST',
      url: '/v1/reportes',
      payload: { id_cliente: yaEnviado, ...REPORTE_BASE },
    });

    const respuesta = await app.inject({
      method: 'POST',
      url: '/v1/reportes/sincronizar',
      payload: {
        reportes: [
          { id_cliente: yaEnviado, ...REPORTE_BASE },
          { id_cliente: randomUUID(), ...REPORTE_BASE, categoria: 'HERIDOS' },
          { id_cliente: randomUUID(), ...REPORTE_BASE, categoria: 'NECESITA_AGUA' },
        ],
      },
    });

    assert.equal(respuesta.statusCode, 200);
    const cuerpo = respuesta.json();
    assert.equal(cuerpo.recibidos, 3);
    assert.equal(cuerpo.creados, 2);
    assert.equal(cuerpo.duplicados, 1);
    // El cliente necesita el id_cliente de vuelta para borrar de su bandeja.
    assert.equal(cuerpo.resultados.length, 3);
    assert.ok(cuerpo.resultados.every((r: { id_cliente?: string }) => r.id_cliente));
  });
});

describe('resolución de zona por contención espacial', () => {
  it('asigna el polígono contenedor más específico', async () => {
    // Un municipio grande y un barrio contenido en él. El reporte cae dentro de
    // los dos; debe quedar asignado al barrio, que es el útil para despachar.
    await crearLugar({
      nombre: 'Municipio',
      tipo: 'MUNICIPIO',
      wkt: 'MULTIPOLYGON(((-74.15 4.55, -74.00 4.55, -74.00 4.75, -74.15 4.75, -74.15 4.55)))',
    });
    const barrioId = await crearLugar({
      nombre: 'Barrio Chico',
      tipo: 'BARRIO',
      wkt: 'MULTIPOLYGON(((-74.09 4.60, -74.07 4.60, -74.07 4.62, -74.09 4.62, -74.09 4.60)))',
    });

    const respuesta = await crearPorApi({ lat: 4.61, lng: -74.08 });
    const { id } = respuesta.json();

    const { rows } = await bd.consultar<{ lugar_id: string | null }>(
      'SELECT lugar_id FROM reportes WHERE id = $1',
      [id],
    );
    assert.equal(rows[0]!.lugar_id, barrioId);
  });

  it('deja la zona en null si el punto no cae en ningún polígono conocido', async () => {
    const respuesta = await crearPorApi({ lat: 12.5, lng: -81.7 }); // San Andrés
    const { id } = respuesta.json();

    const { rows } = await bd.consultar<{ lugar_id: string | null }>(
      'SELECT lugar_id FROM reportes WHERE id = $1',
      [id],
    );
    assert.equal(rows[0]!.lugar_id, null);
  });
});

describe('consulta en GeoJSON', () => {
  it('devuelve una FeatureCollection válida y recorta por bbox', async () => {
    await crearReporteDirecto({ lat: 4.61, lng: -74.08 }); // dentro
    await crearReporteDirecto({ lat: 4.72, lng: -74.14 }); // fuera del recorte

    const respuesta = await app.inject({
      method: 'GET',
      url: '/v1/reportes?bbox=-74.09,4.60,-74.07,4.62',
    });

    assert.equal(respuesta.statusCode, 200);
    const coleccion = respuesta.json();
    assert.equal(coleccion.type, 'FeatureCollection');
    assert.equal(coleccion.features.length, 1);
    assert.equal(coleccion.features[0].type, 'Feature');
    assert.equal(coleccion.features[0].geometry.type, 'Point');
    assert.deepEqual(coleccion.features[0].geometry.coordinates, [-74.08, 4.61]);
  });

  it('rechaza una bbox invertida', async () => {
    const respuesta = await app.inject({
      method: 'GET',
      url: '/v1/reportes?bbox=-74.07,4.62,-74.09,4.60',
    });
    assert.equal(respuesta.statusCode, 400);
  });

  it('oculta los reportes cerrados salvo que se pidan', async () => {
    const abierto = await crearReporteDirecto({ lat: 4.61, lng: -74.08 });
    const cerrado = await crearReporteDirecto({ lat: 4.611, lng: -74.081 });
    await bd.consultar(`UPDATE reportes SET estado = 'RESUELTO' WHERE id = $1`, [cerrado]);

    const porDefecto = (await app.inject({ method: 'GET', url: '/v1/reportes' })).json();
    assert.equal(porDefecto.features.length, 1);
    assert.equal(porDefecto.features[0].id, abierto);

    const conCerrados = (
      await app.inject({ method: 'GET', url: '/v1/reportes?incluir_cerrados=true' })
    ).json();
    assert.equal(conCerrados.features.length, 2);
  });
});

describe('ciclo de atención', () => {
  it('exige personal operativo para cambiar de estado', async () => {
    const reporte = await crearReporteDirecto({ lat: 4.61, lng: -74.08 });
    const respuesta = await app.inject({
      method: 'PATCH',
      url: `/v1/reportes/${reporte}/estado`,
      payload: { estado: 'EN_TRIAGE' },
    });
    assert.equal(respuesta.statusCode, 403);
  });

  it('los triggers fijan primera_respuesta_en y resuelto_en, y escriben bitácora', async () => {
    const reporte = await crearReporteDirecto({ lat: 4.61, lng: -74.08 });

    await bd.consultar(`UPDATE reportes SET estado = 'ASIGNADO' WHERE id = $1`, [reporte]);
    await bd.consultar(`UPDATE reportes SET estado = 'RESUELTO' WHERE id = $1`, [reporte]);

    const { rows } = await bd.consultar<{
      primera_respuesta_en: Date | null;
      resuelto_en: Date | null;
    }>('SELECT primera_respuesta_en, resuelto_en FROM reportes WHERE id = $1', [reporte]);

    assert.ok(rows[0]!.primera_respuesta_en !== null);
    assert.ok(rows[0]!.resuelto_en !== null);

    const { rows: historial } = await bd.consultar<{ estado_nuevo: string }>(
      'SELECT estado_nuevo FROM historial_estado_reporte WHERE reporte_id = $1 ORDER BY creado_en',
      [reporte],
    );
    // Alta + dos cambios: la bitácora registra también el estado inicial.
    assert.deepEqual(
      historial.map((f) => f.estado_nuevo),
      ['RECIBIDO', 'ASIGNADO', 'RESUELTO'],
    );
  });

  it('no permite marcar RESUELTO sin fecha de resolución', async () => {
    // El CHECK de la base es la última línea de defensa contra un estado
    // inconsistente creado por SQL directo.
    await assert.rejects(
      bd.consultar(
        `INSERT INTO reportes (id_cliente, categoria, estado, geom)
         VALUES (gen_random_uuid(), 'OTRO', 'RESUELTO',
                 ST_SetSRID(ST_MakePoint(-74.08, 4.61), 4326)::geography)`,
      ),
      /reportes_resuelto_con_fecha/,
    );
  });

  it('no permite marcar DUPLICADO sin decir de qué es duplicado', async () => {
    const reporte = await crearReporteDirecto({ lat: 4.61, lng: -74.08 });
    await assert.rejects(
      bd.consultar(`UPDATE reportes SET estado = 'DUPLICADO' WHERE id = $1`, [reporte]),
      /reportes_duplicado_con_referencia/,
    );
  });
});

describe('candado del triage humano frente a la IA', () => {
  it('un proceso automático no puede sobreescribir un triage hecho por una persona', async () => {
    // Es la regla de fondo del sistema, y se hace cumplir en la base para que
    // ningún camino de código —ni un script suelto— pueda evadirla.
    const reporte = await crearReporteDirecto({ lat: 4.61, lng: -74.08 });

    await bd.consultar(`UPDATE reportes SET origen_triage = 'OPERADOR' WHERE id = $1`, [reporte]);

    await assert.rejects(
      bd.consultar(`UPDATE reportes SET origen_triage = 'IA' WHERE id = $1`, [reporte]),
      /triage humano/,
    );
  });

  it('sí permite que una persona corrija lo que puso la IA', async () => {
    const reporte = await crearReporteDirecto({ lat: 4.61, lng: -74.08 });

    await bd.consultar(`UPDATE reportes SET origen_triage = 'IA' WHERE id = $1`, [reporte]);
    await bd.consultar(`UPDATE reportes SET origen_triage = 'OPERADOR' WHERE id = $1`, [reporte]);

    const { rows } = await bd.consultar<{ origen_triage: string }>(
      'SELECT origen_triage FROM reportes WHERE id = $1',
      [reporte],
    );
    assert.equal(rows[0]!.origen_triage, 'OPERADOR');
  });

  it('el triage por IA se omite sin clave configurada, sin perder el reporte', async () => {
    // .env.pruebas deja ANTHROPIC_API_KEY vacía: la instancia debe seguir
    // aceptando y sirviendo reportes con normalidad.
    const respuesta = await crearPorApi({});
    assert.equal(respuesta.statusCode, 201);

    const { rows } = await bd.consultar<{ origen_triage: string; n_extracciones: number }>(
      `SELECT r.origen_triage,
              (SELECT count(*)::int FROM extracciones_ia e WHERE e.reporte_id = r.id) AS n_extracciones
         FROM reportes r WHERE r.id = $1`,
      [respuesta.json().id],
    );
    assert.equal(rows[0]!.origen_triage, 'CIUDADANO');
    assert.equal(rows[0]!.n_extracciones, 0);
  });
});

describe('explicación de la prioridad', () => {
  it('devuelve el desglose por término y los pesos vigentes', async () => {
    await crearRecurso({ lat: 4.61, lng: -74.08 });
    const reporte = await crearReporteDirecto({
      lat: 4.615,
      lng: -74.082,
      afectadas: 6,
      atrapadas: 2,
      severidad: 'ALTA',
      horasAtras: 3,
    });

    const respuesta = await app.inject({
      method: 'GET',
      url: `/v1/reportes/${reporte}/prioridad`,
    });

    assert.equal(respuesta.statusCode, 200);
    const cuerpo = respuesta.json();
    assert.ok(typeof cuerpo.score === 'number');
    assert.deepEqual(Object.keys(cuerpo.componentes).sort(), [
      'aislamiento',
      'concentracion',
      'espera',
      'personas',
      'severidad',
    ]);
    assert.equal(cuerpo.pesos.version, 1);
  });

  it('devuelve 404 para un reporte inexistente', async () => {
    const respuesta = await app.inject({
      method: 'GET',
      url: '/v1/reportes/00000000-0000-4000-8000-000000000000/prioridad',
    });
    assert.equal(respuesta.statusCode, 404);
  });
});

describe('alta de reportes sin Redis', () => {
  /**
   * El fallo que este bloque fija por escrito casi arruina el primer
   * despliegue: con REDIS_URL apuntando a un Redis inexistente, el alta de un
   * reporte se quedaba colgada para siempre y el proceso se moría.
   *
   * Eran dos cosas sumadas. `maxRetriesPerRequest: null` —que BullMQ exige—
   * hace que ioredis reintente sin límite, así que `add()` no se resolvía ni se
   * rechazaba y el `await` de la ruta esperaba indefinidamente; el `.catch()`
   * que la ruta ya tenía no servía de nada porque nunca hubo un rechazo. Y por
   * debajo, la conexión de ioredis no tenía oyente de `error`, lo que convierte
   * cada intento fallido en una excepción no capturada que tumba el servidor.
   *
   * La regla que queda fijada: **recibir un reporte no puede depender de Redis**.
   */
  it('acepta un reporte con descripción aunque las colas estén apagadas', async () => {
    const original = config.REDIS_URL;
    (config as { REDIS_URL: string }).REDIS_URL = '';

    try {
      const respuesta = await app.inject({
        method: 'POST',
        url: '/v1/reportes',
        payload: {
          id_cliente: randomUUID(),
          lat: 4.61,
          lng: -74.08,
          categoria: 'OTRO',
          severidad: 'BAJA',
          descripcion: 'Descripción larga para que dispare el encolado del triage por IA',
        },
      });

      assert.equal(respuesta.statusCode, 201);
      assert.ok(respuesta.json().codigo_publico);
    } finally {
      (config as { REDIS_URL: string }).REDIS_URL = original;
    }
  });

  it('encolar no hace nada cuando REDIS_URL está vacía', async () => {
    const original = config.REDIS_URL;
    (config as { REDIS_URL: string }).REDIS_URL = '';

    try {
      assert.equal(colasHabilitadas(), false);
      // No debe lanzar ni quedarse colgado: simplemente no encola.
      await encolarTriage(randomUUID());
    } finally {
      (config as { REDIS_URL: string }).REDIS_URL = original;
    }
  });
});

describe('almacenamiento de medios', () => {
  /**
   * El contrato que importa: subir una foto y volver a leerla devuelve los
   * mismos bytes, viva donde viva. Las fotos de la beta se estaban perdiendo
   * porque el disco de Render es efímero; al meter Supabase Storage detrás de
   * la misma interfaz, esta prueba es la que garantiza que el cambio no rompió
   * el camino que ya funcionaba.
   */
  it('guarda y recupera los mismos bytes', async () => {
    const bytes = Buffer.from('contenido de prueba con acentos: ñáé', 'utf8');
    const llave = 'ab/cd/abcd1234prueba';

    await almacen.guardar(llave, bytes, 'image/jpeg');
    const leidos = await almacen.leer(llave);

    assert.ok(leidos, 'debe encontrar lo que acabó de guardar');
    assert.deepEqual(leidos, bytes);
  });

  it('devuelve null cuando el medio no está, en vez de lanzar', async () => {
    // Un medio perdido no puede tumbar la descarga: la ruta responde 404 y el
    // reporte sigue existiendo.
    assert.equal(await almacen.leer('00/00/no-existe-en-ningun-lado'), null);
  });

  it('rechaza una llave que se sale del directorio del almacén', async () => {
    await assert.rejects(() => almacen.leer('../../../etc/passwd'));
  });
});
