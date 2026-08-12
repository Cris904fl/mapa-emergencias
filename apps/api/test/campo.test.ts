import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { construirApp } from '../src/app.ts';
import { bd } from '../src/db/pool.ts';
import {
  asegurarBaseDePruebas,
  cerrar,
  crearRecurso,
  crearReporteDirecto,
  limpiarDatos,
} from './ayudas.ts';
import { hashearClave } from '../src/lib/auth.ts';

/**
 * Pruebas del trabajo en campo.
 *
 * Lo que más importa acá es el candado de concurrencia al tomar un caso: si dos
 * rescatistas pueden tomar el mismo reporte, dos equipos salen al mismo sitio y
 * otro pedido de auxilio se queda sin nadie. Es la clase de error que no aparece
 * probando a mano, porque requiere dos usuarios.
 */

let app: FastifyInstance;
let tokenA: string;
let tokenB: string;

const POSICION = { lat: 4.6155, lng: -74.0762 };

before(async () => {
  await asegurarBaseDePruebas();
  app = await construirApp();
  await app.ready();
});

after(async () => {
  await app.close();
  await cerrar();
});

/** Crea dos rescatistas y devuelve sus tokens. */
async function crearRescatistas(): Promise<[string, string]> {
  const hash = await hashearClave('clavedeprueba');

  const { rows: organizaciones } = await bd.consultar<{ id: string }>(
    `INSERT INTO organizaciones (nombre, tipo) VALUES ('Socorro de prueba', 'SOCORRO') RETURNING id`,
  );
  const organizacionId = organizaciones[0]!.id;

  const tokens: string[] = [];
  for (const [nombre, correo] of [
    ['Rescatista A', 'a@prueba.local'],
    ['Rescatista B', 'b@prueba.local'],
  ]) {
    await bd.consultar(
      `INSERT INTO usuarios (organizacion_id, rol, nombre, correo, hash_clave)
       VALUES ($1, 'RESPONDIENTE', $2, $3, $4)`,
      [organizacionId, nombre, correo, hash],
    );

    const respuesta = await app.inject({
      method: 'POST',
      url: '/v1/sesion',
      payload: { correo, clave: 'clavedeprueba' },
    });
    tokens.push(respuesta.json().token);
  }

  return [tokens[0]!, tokens[1]!];
}

beforeEach(async () => {
  await limpiarDatos();
  [tokenA, tokenB] = await crearRescatistas();
});

const conToken = (token: string) => ({ authorization: `Bearer ${token}` });

describe('acceso a la sección de campo', () => {
  it('rechaza a quien no está autenticado', async () => {
    const respuesta = await app.inject({
      method: 'GET',
      url: `/v1/campo/casos?lat=${POSICION.lat}&lng=${POSICION.lng}`,
    });
    assert.equal(respuesta.statusCode, 403);
  });
});

describe('casos cercanos', () => {
  it('ordena por distancia cuando se pide así', async () => {
    await crearRecurso({ ...POSICION });
    // Uno cerca y poco grave, otro lejos y crítico. Es el caso que distingue
    // las dos ordenaciones.
    await crearReporteDirecto({
      lat: POSICION.lat + 0.001, // ~110 m
      lng: POSICION.lng,
      severidad: 'BAJA',
      categoria: 'SERVICIOS_CAIDOS',
    });
    await crearReporteDirecto({
      lat: POSICION.lat + 0.02, // ~2.2 km
      lng: POSICION.lng,
      severidad: 'CRITICA',
      atrapadas: 8,
      afectadas: 10,
    });

    await bd.consultar('SELECT fn_refrescar_prioridades_vencidas($1, 100)', ['0 seconds']);

    const porDistancia = (
      await app.inject({
        method: 'GET',
        url: `/v1/campo/casos?lat=${POSICION.lat}&lng=${POSICION.lng}&orden=distancia`,
        headers: conToken(tokenA),
      })
    ).json();

    const porPrioridad = (
      await app.inject({
        method: 'GET',
        url: `/v1/campo/casos?lat=${POSICION.lat}&lng=${POSICION.lng}&orden=prioridad`,
        headers: conToken(tokenA),
      })
    ).json();

    assert.equal(porDistancia.casos.length, 2);
    // El primero por distancia es el de baja severidad; por prioridad, el crítico.
    assert.ok(porDistancia.casos[0].distancia_m < porDistancia.casos[1].distancia_m);
    assert.equal(porPrioridad.casos[0].severidad, 'CRITICA');
    assert.notEqual(porDistancia.casos[0].id, porPrioridad.casos[0].id);
  });

  it('calcula la distancia en metros reales', async () => {
    // ~0.001 grados de latitud ≈ 111 m. Si alguien invierte lat/lng en la
    // consulta espacial, este número se va a las decenas de miles.
    await crearReporteDirecto({ lat: POSICION.lat + 0.001, lng: POSICION.lng });

    const cuerpo = (
      await app.inject({
        method: 'GET',
        url: `/v1/campo/casos?lat=${POSICION.lat}&lng=${POSICION.lng}`,
        headers: conToken(tokenA),
      })
    ).json();

    assert.ok(
      cuerpo.casos[0].distancia_m > 100 && cuerpo.casos[0].distancia_m < 125,
      `distancia inesperada: ${cuerpo.casos[0].distancia_m} m`,
    );
  });
});

describe('tomar un caso', () => {
  it('lo asigna y lo pasa a ASIGNADO', async () => {
    const reporte = await crearReporteDirecto({ ...POSICION });

    const respuesta = await app.inject({
      method: 'POST',
      url: `/v1/campo/casos/${reporte}/tomar`,
      headers: conToken(tokenA),
    });

    assert.equal(respuesta.statusCode, 200);
    assert.equal(respuesta.json().estado, 'ASIGNADO');

    const { rows } = await bd.consultar<{
      responsable_id: string | null;
      tomado_en: Date | null;
      origen_triage: string;
    }>('SELECT responsable_id, tomado_en, origen_triage FROM reportes WHERE id = $1', [reporte]);

    assert.ok(rows[0]!.responsable_id !== null);
    assert.ok(rows[0]!.tomado_en !== null, 'el trigger debe fijar tomado_en');
    // Tomarlo es un acto humano: bloquea que la IA vuelva a escribir los conteos.
    assert.equal(rows[0]!.origen_triage, 'OPERADOR');
  });

  it('un segundo rescatista NO puede tomar el mismo caso', async () => {
    // El invariante que evita que dos equipos salgan al mismo sitio.
    const reporte = await crearReporteDirecto({ ...POSICION });

    const primera = await app.inject({
      method: 'POST',
      url: `/v1/campo/casos/${reporte}/tomar`,
      headers: conToken(tokenA),
    });
    assert.equal(primera.statusCode, 200);

    const segunda = await app.inject({
      method: 'POST',
      url: `/v1/campo/casos/${reporte}/tomar`,
      headers: conToken(tokenB),
    });

    assert.equal(segunda.statusCode, 409);
    // El mensaje dice quién lo tiene: en campo eso permite coordinar por radio.
    assert.match(segunda.json().mensaje, /Rescatista A/);
  });

  it('tomarlo dos veces uno mismo es idempotente', async () => {
    const reporte = await crearReporteDirecto({ ...POSICION });

    const primera = await app.inject({
      method: 'POST',
      url: `/v1/campo/casos/${reporte}/tomar`,
      headers: conToken(tokenA),
    });
    const segunda = await app.inject({
      method: 'POST',
      url: `/v1/campo/casos/${reporte}/tomar`,
      headers: conToken(tokenA),
    });

    assert.equal(primera.statusCode, 200);
    assert.equal(segunda.statusCode, 200, 'reintentar por mala señal no debe fallar');
  });

  it('no se puede tomar un caso ya resuelto', async () => {
    const reporte = await crearReporteDirecto({ ...POSICION });
    await bd.consultar(`UPDATE reportes SET estado = 'RESUELTO' WHERE id = $1`, [reporte]);

    const respuesta = await app.inject({
      method: 'POST',
      url: `/v1/campo/casos/${reporte}/tomar`,
      headers: conToken(tokenA),
    });

    assert.equal(respuesta.statusCode, 409);
    assert.match(respuesta.json().mensaje, /resuelto/i);
  });

  it('liberar un caso lo deja disponible para otro', async () => {
    const reporte = await crearReporteDirecto({ ...POSICION });

    await app.inject({
      method: 'POST',
      url: `/v1/campo/casos/${reporte}/tomar`,
      headers: conToken(tokenA),
    });
    const liberado = await app.inject({
      method: 'POST',
      url: `/v1/campo/casos/${reporte}/liberar`,
      headers: conToken(tokenA),
    });
    assert.equal(liberado.statusCode, 200);

    const tomadoPorB = await app.inject({
      method: 'POST',
      url: `/v1/campo/casos/${reporte}/tomar`,
      headers: conToken(tokenB),
    });
    assert.equal(tomadoPorB.statusCode, 200);
  });
});

describe('cerrar un caso', () => {
  it('solo lo cierra quien lo tomó', async () => {
    const reporte = await crearReporteDirecto({ ...POSICION });

    await app.inject({
      method: 'POST',
      url: `/v1/campo/casos/${reporte}/tomar`,
      headers: conToken(tokenA),
    });

    const porB = await app.inject({
      method: 'POST',
      url: `/v1/campo/casos/${reporte}/resolver`,
      headers: conToken(tokenB),
      payload: {},
    });
    assert.equal(porB.statusCode, 409);

    const porA = await app.inject({
      method: 'POST',
      url: `/v1/campo/casos/${reporte}/resolver`,
      headers: conToken(tokenA),
      payload: { nota: 'Cinco evacuadas', personas_atendidas: 5 },
    });
    assert.equal(porA.statusCode, 200);
  });

  it('la nota de cierre queda en la bitácora', async () => {
    const reporte = await crearReporteDirecto({ ...POSICION });

    await app.inject({
      method: 'POST',
      url: `/v1/campo/casos/${reporte}/tomar`,
      headers: conToken(tokenA),
    });
    await app.inject({
      method: 'POST',
      url: `/v1/campo/casos/${reporte}/resolver`,
      headers: conToken(tokenA),
      payload: { nota: 'Cinco evacuadas, una al hospital', personas_atendidas: 5 },
    });

    const { rows } = await bd.consultar<{ nota: string | null; por: string | null }>(
      `SELECT h.nota, u.nombre AS por
         FROM historial_estado_reporte h
         LEFT JOIN usuarios u ON u.id = h.cambiado_por
        WHERE h.reporte_id = $1 AND h.estado_nuevo = 'RESUELTO'`,
      [reporte],
    );

    assert.match(rows[0]!.nota ?? '', /5 persona\(s\) atendida\(s\)/);
    assert.match(rows[0]!.nota ?? '', /una al hospital/);
    assert.equal(rows[0]!.por, 'Rescatista A');
  });

  it('resuelto deja de aparecer en los casos cercanos', async () => {
    const reporte = await crearReporteDirecto({ ...POSICION });

    await app.inject({
      method: 'POST',
      url: `/v1/campo/casos/${reporte}/tomar`,
      headers: conToken(tokenA),
    });
    await app.inject({
      method: 'POST',
      url: `/v1/campo/casos/${reporte}/resolver`,
      headers: conToken(tokenA),
      payload: {},
    });

    const cuerpo = (
      await app.inject({
        method: 'GET',
        url: `/v1/campo/casos?lat=${POSICION.lat}&lng=${POSICION.lng}`,
        headers: conToken(tokenA),
      })
    ).json();

    assert.equal(cuerpo.casos.length, 0);
  });
});

describe('hora de llegada al sitio', () => {
  /**
   * El punto de todas estas pruebas es el mismo: el dato que se va a usar para
   * calibrar el umbral de «asignados sin llegada» tiene que decir de dónde
   * salió, y no puede inventarse cuando falta.
   */
  const tomar = async (id: string) =>
    app.inject({ method: 'POST', url: `/v1/campo/casos/${id}/tomar`, headers: conToken(tokenA) });

  const llegada = async (id: string) => {
    const { rows } = await bd.consultar<{ llegada_en: Date | null; llegada_origen: string | null }>(
      'SELECT llegada_en, llegada_origen FROM reportes WHERE id = $1',
      [id],
    );
    return rows[0]!;
  };

  it('marcar la llegada la sella como MARCADA', async () => {
    const reporte = await crearReporteDirecto({ ...POSICION });
    await tomar(reporte);
    await app.inject({
      method: 'POST',
      url: `/v1/campo/casos/${reporte}/en-atencion`,
      headers: conToken(tokenA),
    });

    const registro = await llegada(reporte);
    assert.equal(registro.llegada_origen, 'MARCADA');
    assert.ok(registro.llegada_en);
  });

  it('cerrar sin decir nada no inventa una hora de llegada', async () => {
    // Es la regla que da sentido a todo lo demás: rellenar el hueco con el
    // instante del cierre parecería más completo y arruinaría la medición.
    const reporte = await crearReporteDirecto({ ...POSICION });
    await tomar(reporte);
    await app.inject({
      method: 'POST',
      url: `/v1/campo/casos/${reporte}/resolver`,
      headers: conToken(tokenA),
      payload: {},
    });

    const registro = await llegada(reporte);
    assert.equal(registro.llegada_en, null);
    assert.equal(registro.llegada_origen, null);
  });

  it('declararla al cerrar la guarda como DECLARADA', async () => {
    const reporte = await crearReporteDirecto({ ...POSICION });
    await tomar(reporte);
    // El caso se tomó hace 40 minutos: sin envejecer la asignación, «llegué
    // hace 20» sería anterior a que le asignaran el caso y se descartaría con
    // razón. Es el escenario real —salir, llegar, cerrar— comprimido.
    await bd.consultar(
      `UPDATE reportes SET primera_respuesta_en = now() - interval '40 minutes' WHERE id = $1`,
      [reporte],
    );
    const hace20 = new Date(Date.now() - 20 * 60_000).toISOString();

    await app.inject({
      method: 'POST',
      url: `/v1/campo/casos/${reporte}/resolver`,
      headers: conToken(tokenA),
      payload: { llego_en: hace20 },
    });

    const registro = await llegada(reporte);
    assert.equal(registro.llegada_origen, 'DECLARADA');
    // Se guarda la hora declarada, no la del cierre: son 20 minutos de
    // diferencia y es justamente lo que se quiere poder medir.
    assert.ok(Math.abs(registro.llegada_en!.getTime() - Date.parse(hace20)) < 1000);
  });

  it('una hora declarada no pisa la que se marcó al llegar', async () => {
    const reporte = await crearReporteDirecto({ ...POSICION });
    await tomar(reporte);
    await app.inject({
      method: 'POST',
      url: `/v1/campo/casos/${reporte}/en-atencion`,
      headers: conToken(tokenA),
    });
    const marcada = await llegada(reporte);

    await app.inject({
      method: 'POST',
      url: `/v1/campo/casos/${reporte}/resolver`,
      headers: conToken(tokenA),
      payload: { llego_en: new Date(Date.now() - 5 * 60_000).toISOString() },
    });

    const despues = await llegada(reporte);
    assert.equal(despues.llegada_origen, 'MARCADA');
    assert.equal(despues.llegada_en!.getTime(), marcada.llegada_en!.getTime());
  });

  it('rechaza una llegada en el futuro', async () => {
    const reporte = await crearReporteDirecto({ ...POSICION });
    await tomar(reporte);

    const respuesta = await app.inject({
      method: 'POST',
      url: `/v1/campo/casos/${reporte}/resolver`,
      headers: conToken(tokenA),
      payload: { llego_en: new Date(Date.now() + 30 * 60_000).toISOString() },
    });

    assert.equal(respuesta.statusCode, 400);
  });

  it('una llegada anterior a la asignación se descarta, pero el cierre sí ocurre', async () => {
    // Un dedazo no puede impedir que alguien cierre un caso en campo. Se
    // descarta el dato dudoso y se cierra igual.
    const reporte = await crearReporteDirecto({ ...POSICION });
    await tomar(reporte);

    const respuesta = await app.inject({
      method: 'POST',
      url: `/v1/campo/casos/${reporte}/resolver`,
      headers: conToken(tokenA),
      payload: { llego_en: new Date(Date.now() - 48 * 3600_000).toISOString() },
    });

    assert.equal(respuesta.statusCode, 200);
    const registro = await llegada(reporte);
    assert.equal(registro.llegada_en, null, 'no se guarda una llegada imposible');
  });
});

describe('ruta y obstáculos', () => {
  it('detecta las vías bloqueadas que hay sobre el trayecto', async () => {
    // Es la información que un mapa comercial no tiene: sabe las calles, pero no
    // que un vecino acaba de reportarlas intransitables.
    const destino = await crearReporteDirecto({
      lat: POSICION.lat + 0.02,
      lng: POSICION.lng,
      categoria: 'PERSONAS_ATRAPADAS',
    });

    // Un bloqueo justo a mitad de camino.
    await crearReporteDirecto({
      lat: POSICION.lat + 0.01,
      lng: POSICION.lng,
      categoria: 'VIA_BLOQUEADA',
      descripcion: 'Poste caído atravesado en la calle',
    });
    // Y uno lejos de la ruta, que NO debe aparecer.
    await crearReporteDirecto({
      lat: POSICION.lat + 0.01,
      lng: POSICION.lng + 0.01, // ~1.1 km al lado
      categoria: 'VIA_BLOQUEADA',
    });

    const respuesta = await app.inject({
      method: 'GET',
      url: `/v1/campo/casos/${destino}/ruta?lat=${POSICION.lat}&lng=${POSICION.lng}`,
      headers: conToken(tokenA),
    });

    assert.equal(respuesta.statusCode, 200);
    const cuerpo = respuesta.json();

    // Sin RUTEO_URL en .env.pruebas, cae a línea recta y lo declara.
    assert.equal(cuerpo.tipo, 'linea_recta');
    assert.equal(cuerpo.obstaculos.length, 1, 'solo el que está sobre la ruta');
    assert.equal(cuerpo.obstaculos[0].categoria, 'VIA_BLOQUEADA');
    // A mitad de camino de ~2.2 km.
    assert.ok(
      cuerpo.obstaculos[0].metros_desde_origen > 900 &&
        cuerpo.obstaculos[0].metros_desde_origen < 1300,
      `posición inesperada: ${cuerpo.obstaculos[0].metros_desde_origen} m`,
    );
  });

  it('no cuenta como obstáculo el propio caso de destino', async () => {
    // Un reporte de vía bloqueada al que se va a atender no se reporta a sí
    // mismo como obstáculo para llegar.
    const destino = await crearReporteDirecto({
      lat: POSICION.lat + 0.01,
      lng: POSICION.lng,
      categoria: 'VIA_BLOQUEADA',
    });

    const cuerpo = (
      await app.inject({
        method: 'GET',
        url: `/v1/campo/casos/${destino}/ruta?lat=${POSICION.lat}&lng=${POSICION.lng}`,
        headers: conToken(tokenA),
      })
    ).json();

    assert.equal(cuerpo.obstaculos.length, 0);
  });

  it('ignora los obstáculos ya resueltos', async () => {
    const destino = await crearReporteDirecto({
      lat: POSICION.lat + 0.02,
      lng: POSICION.lng,
    });
    const bloqueo = await crearReporteDirecto({
      lat: POSICION.lat + 0.01,
      lng: POSICION.lng,
      categoria: 'VIA_BLOQUEADA',
    });
    await bd.consultar(`UPDATE reportes SET estado = 'RESUELTO' WHERE id = $1`, [bloqueo]);

    const cuerpo = (
      await app.inject({
        method: 'GET',
        url: `/v1/campo/casos/${destino}/ruta?lat=${POSICION.lat}&lng=${POSICION.lng}`,
        headers: conToken(tokenA),
      })
    ).json();

    assert.equal(cuerpo.obstaculos.length, 0, 'una vía ya despejada no es obstáculo');
  });
});

describe('filtros del tablero', () => {
  it('cada filtro devuelve exactamente lo que dice su cifra', async () => {
    // Si el mosaico dice "2 críticos" y la lista trae tres, el operador deja de
    // confiar en el tablero. Esta prueba fija esa correspondencia.
    await crearReporteDirecto({ ...POSICION, severidad: 'CRITICA', atrapadas: 3 });
    await crearReporteDirecto({ ...POSICION, severidad: 'CRITICA' });
    await crearReporteDirecto({ ...POSICION, severidad: 'BAJA' });

    const tomado = await crearReporteDirecto({ ...POSICION, severidad: 'MEDIA' });
    await app.inject({
      method: 'POST',
      url: `/v1/campo/casos/${tomado}/tomar`,
      headers: conToken(tokenA),
    });

    const resumen = (await app.inject({ method: 'GET', url: '/v1/tablero/resumen' })).json();

    const cuenta = async (filtro: string) => {
      const respuesta = await app.inject({
        method: 'GET',
        url: `/v1/tablero/cola?filtro=${filtro}&limite=500`,
      });
      return respuesta.json().total as number;
    };

    assert.equal(await cuenta('criticos'), resumen.reportes.criticos);
    assert.equal(await cuenta('sin_atender'), resumen.reportes.sin_atender);
    assert.equal(await cuenta('abiertos'), resumen.reportes.abiertos);
    // `atrapadas` cuenta REPORTES con personas atrapadas, mientras la cifra del
    // mosaico suma PERSONAS. Son unidades distintas a propósito.
    assert.equal(await cuenta('atrapadas'), 1);
    assert.equal(await cuenta('sin_responsable'), 3);
    // El mosaico de estancados sale de la misma condición que responde la cola.
    assert.equal(await cuenta('estancados'), resumen.reportes.asignados_estancados);
  });

  it('un asignado recién tomado no cuenta como estancado, uno viejo sí', async () => {
    // Es el defecto que este filtro existe para hacer visible: al pasar a
    // ASIGNADO se apaga el término de espera y el reporte deja de subir en la
    // cola, así que un caso olvidado se ve igual que uno atendido.
    const reporte = await crearReporteDirecto({ ...POSICION });
    await app.inject({
      method: 'POST',
      url: `/v1/campo/casos/${reporte}/tomar`,
      headers: conToken(tokenA),
    });

    const estancados = async () =>
      (await app.inject({ method: 'GET', url: '/v1/tablero/cola?filtro=estancados' })).json()
        .total as number;

    assert.equal(await estancados(), 0, 'recién tomado no está estancado');

    // Se envejece la marca de primera respuesta en vez de esperar 30 minutos.
    await bd.consultar(
      `UPDATE reportes SET primera_respuesta_en = now() - interval '31 minutes' WHERE id = $1`,
      [reporte],
    );

    assert.equal(await estancados(), 1, 'a los 31 minutos sin llegar sí lo está');

    // Llegar al sitio lo saca de la cifra: es lo que el mosaico está esperando.
    await app.inject({
      method: 'POST',
      url: `/v1/campo/casos/${reporte}/en-atencion`,
      headers: conToken(tokenA),
    });

    assert.equal(await estancados(), 0, 'llegar al sitio lo saca');
  });

  it('la severidad filtra la cola, y se combina con el filtro de KPI', async () => {
    // El mapa ya filtraba por severidad y la cola no. Si se separan, el mapa
    // muestra tres puntos y la lista de al lado veinte.
    await crearReporteDirecto({ ...POSICION, severidad: 'CRITICA', atrapadas: 2 });
    await crearReporteDirecto({ ...POSICION, severidad: 'CRITICA' });
    await crearReporteDirecto({ ...POSICION, severidad: 'BAJA', atrapadas: 1 });

    const total = async (consulta: string) =>
      (await app.inject({ method: 'GET', url: `/v1/tablero/cola?${consulta}` })).json()
        .total as number;

    assert.equal(await total('severidad=CRITICA'), 2);
    assert.equal(await total('severidad=BAJA'), 1);
    // Los dos filtros se cruzan con AND: de los críticos, el que tiene atrapadas.
    assert.equal(await total('severidad=CRITICA&filtro=atrapadas'), 1);
  });

  it('rechaza una severidad que no existe', async () => {
    const respuesta = await app.inject({
      method: 'GET',
      url: '/v1/tablero/cola?severidad=GRAVISIMA',
    });
    assert.equal(respuesta.statusCode, 400);
  });

  it('rechaza un filtro que no existe', async () => {
    const respuesta = await app.inject({
      method: 'GET',
      url: '/v1/tablero/cola?filtro=inventado',
    });
    assert.equal(respuesta.statusCode, 400);
  });

  it('el filtro de resueltos sí muestra los cerrados', async () => {
    // Es el único filtro que necesita dejar de excluir los cerrados.
    const reporte = await crearReporteDirecto({ ...POSICION });
    await app.inject({
      method: 'POST',
      url: `/v1/campo/casos/${reporte}/tomar`,
      headers: conToken(tokenA),
    });
    await app.inject({
      method: 'POST',
      url: `/v1/campo/casos/${reporte}/resolver`,
      headers: conToken(tokenA),
      payload: {},
    });

    const cuerpo = (
      await app.inject({ method: 'GET', url: '/v1/tablero/cola?filtro=resueltos' })
    ).json();

    assert.equal(cuerpo.total, 1);
    assert.equal(cuerpo.reportes[0].estado, 'RESUELTO');
  });
});
