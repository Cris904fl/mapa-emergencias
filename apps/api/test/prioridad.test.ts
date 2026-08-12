import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bd } from '../src/db/pool.ts';
import {
  asegurarBaseDePruebas,
  cerrar,
  crearRecurso,
  crearReporteDirecto,
  limpiarDatos,
  prioridadDe,
} from './ayudas.ts';

/**
 * Pruebas del índice de prioridad.
 *
 * Es lo que ordena la cola de rescate, así que un error acá no produce una
 * pantalla fea: produce que un equipo salga al lugar equivocado. Cada prueba
 * fija una propiedad de la fórmula que debe seguir siendo cierta aunque alguien
 * ajuste los pesos.
 */

// Punto de referencia en Bogotá.
const BASE = { lat: 4.61, lng: -74.08 };

/** Desplaza un punto ~n metros al norte. 1° de latitud ≈ 111 320 m. */
const nMetrosAlNorte = (metros: number) => ({
  lat: BASE.lat + metros / 111_320,
  lng: BASE.lng,
});

before(async () => {
  await asegurarBaseDePruebas();
});

after(async () => {
  await cerrar();
});

beforeEach(async () => {
  await limpiarDatos();
});

describe('índice de prioridad', () => {
  it('el aislamiento se invierte: más lejos del recurso, más prioridad', async () => {
    // Esta es la corrección de fondo sobre la fórmula original, donde
    // `distancia_a_recursos` sumada en crudo premiaba estar CERCA de la ayuda.
    await crearRecurso({ ...BASE, nombre: 'Base' });

    const cerca = await crearReporteDirecto({ ...nMetrosAlNorte(200), afectadas: 4 });
    const lejos = await crearReporteDirecto({ ...nMetrosAlNorte(9000), afectadas: 4 });

    const calculoCerca = await prioridadDe(cerca);
    const calculoLejos = await prioridadDe(lejos);

    assert.ok(
      calculoLejos.componentes.aislamiento!.aporte > calculoCerca.componentes.aislamiento!.aporte,
      'el reporte lejano debe aportar más por aislamiento',
    );
    assert.ok(calculoLejos.score > calculoCerca.score);
  });

  it('sin ningún recurso disponible el aislamiento es total', async () => {
    await crearRecurso({ ...BASE, estado: 'FUERA_SERVICIO' });
    const reporte = await crearReporteDirecto({ ...BASE, afectadas: 1 });

    const calculo = await prioridadDe(reporte);

    assert.equal(calculo.componentes.aislamiento!.normalizado, 1);
    assert.equal(calculo.componentes.aislamiento!.crudo, -1, 'crudo -1 señala "ningún recurso"');
  });

  it('cada término está acotado a 0..1 y el puntaje a 0..100', async () => {
    // Cifras absurdamente grandes no deben poder desbordar el puntaje: es lo
    // que garantiza que un reporte con un cero de más no aplaste la cola.
    await crearRecurso({ ...BASE });
    const reporte = await crearReporteDirecto({
      ...nMetrosAlNorte(500_000),
      afectadas: 99_999,
      atrapadas: 99_999,
      heridas: 99_999,
      vulnerables: 99_999,
      severidad: 'CRITICA',
      horasAtras: 5000,
    });

    const calculo = await prioridadDe(reporte);

    for (const [nombre, componente] of Object.entries(calculo.componentes)) {
      assert.ok(
        componente.normalizado >= 0 && componente.normalizado <= 1,
        `${nombre} normalizado fuera de 0..1: ${componente.normalizado}`,
      );
    }
    assert.ok(calculo.score <= 100, `puntaje por encima de 100: ${calculo.score}`);
    assert.ok(calculo.score >= 0);
  });

  it('severidad DESCONOCIDA queda a media tabla, no al fondo', async () => {
    // Un ciudadano que no sabe qué tan grave es lo suyo no debe quedar debajo
    // de alguien que reportó explícitamente "baja".
    await crearRecurso({ ...BASE });
    const desconocida = await crearReporteDirecto({ ...BASE, severidad: 'DESCONOCIDA' });
    const baja = await crearReporteDirecto({ ...BASE, severidad: 'BAJA' });
    const critica = await crearReporteDirecto({ ...BASE, severidad: 'CRITICA' });

    const cDesconocida = (await prioridadDe(desconocida)).componentes.severidad!;
    const cBaja = (await prioridadDe(baja)).componentes.severidad!;
    const cCritica = (await prioridadDe(critica)).componentes.severidad!;

    assert.ok(cDesconocida.normalizado > cBaja.normalizado);
    assert.ok(cDesconocida.normalizado < cCritica.normalizado);
  });

  it('las personas fallecidas no aumentan la urgencia de rescate', async () => {
    // Decisión de diseño explícita: recuperar cuerpos es una tarea distinta de
    // rescatar a alguien con vida, y contarla acá desviaría equipos de vidas
    // salvables. Si alguien agrega personas_fallecidas a la carga humana, esta
    // prueba falla y obliga a discutirlo.
    await crearRecurso({ ...BASE });
    const soloFallecidas = await crearReporteDirecto({ ...BASE, fallecidas: 10 });
    const sinNadie = await crearReporteDirecto({ ...BASE });

    const conFallecidas = await prioridadDe(soloFallecidas);
    const vacio = await prioridadDe(sinNadie);

    assert.equal(
      conFallecidas.componentes.personas!.aporte,
      vacio.componentes.personas!.aporte,
      'personas_fallecidas no debe entrar en la carga humana',
    );
  });

  it('pondera atrapadas por encima de heridas, y heridas por encima de afectadas', async () => {
    await crearRecurso({ ...BASE });
    const atrapadas = await crearReporteDirecto({ ...BASE, atrapadas: 3 });
    const heridas = await crearReporteDirecto({ ...BASE, heridas: 3 });
    const afectadas = await crearReporteDirecto({ ...BASE, afectadas: 3 });

    const a = (await prioridadDe(atrapadas)).componentes.personas!.aporte;
    const h = (await prioridadDe(heridas)).componentes.personas!.aporte;
    const f = (await prioridadDe(afectadas)).componentes.personas!.aporte;

    assert.ok(a > h, 'atrapadas debe pesar más que heridas');
    assert.ok(h > f, 'heridas debe pesar más que afectadas');
  });

  it('la concentración cuenta vecinos abiertos y excluye los cerrados', async () => {
    await crearRecurso({ ...BASE });
    const principal = await crearReporteDirecto({ ...BASE });

    // Tres vecinos a 100 m, dentro del radio de 300 m de la versión 1.
    for (let i = 0; i < 3; i++) {
      await crearReporteDirecto(nMetrosAlNorte(100 + i));
    }

    const conVecinos = await prioridadDe(principal);
    assert.equal(conVecinos.componentes.concentracion!.crudo, 3);

    // Al cerrar uno, deja de contar: la cola mide trabajo pendiente.
    const { rows } = await bd.consultar<{ id: string }>(
      `SELECT id FROM reportes WHERE id <> $1 LIMIT 1`,
      [principal],
    );
    await bd.consultar(`UPDATE reportes SET estado = 'DESCARTADO' WHERE id = $1`, [rows[0]!.id]);

    const trasCerrar = await prioridadDe(principal);
    assert.equal(trasCerrar.componentes.concentracion!.crudo, 2);
  });

  it('el reloj de espera se detiene con la primera respuesta', async () => {
    await crearRecurso({ ...BASE });
    const reporte = await crearReporteDirecto({ ...BASE, horasAtras: 10 });

    const antes = await prioridadDe(reporte);
    assert.ok(
      antes.componentes.espera!.aporte > 0,
      'un reporte de hace 10 horas sin atender debe aportar espera',
    );

    // Pasar a ASIGNADO dispara el trigger que fija primera_respuesta_en.
    await bd.consultar(`UPDATE reportes SET estado = 'ASIGNADO' WHERE id = $1`, [reporte]);

    const despues = await prioridadDe(reporte);
    assert.ok(
      despues.componentes.espera!.aporte < antes.componentes.espera!.aporte,
      'tras la primera respuesta la espera no debe seguir creciendo',
    );
  });

  it('la suma de los aportes es igual al puntaje', async () => {
    // Propiedad estructural: el puntaje tiene que ser explicable exactamente
    // por su desglose, o la pantalla que lo justifica estaría mintiendo.
    await crearRecurso({ ...BASE });
    const reporte = await crearReporteDirecto({
      ...nMetrosAlNorte(1500),
      afectadas: 7,
      atrapadas: 2,
      heridas: 1,
      vulnerables: 3,
      severidad: 'ALTA',
      horasAtras: 4,
    });

    const calculo = await prioridadDe(reporte);
    const suma = Object.values(calculo.componentes).reduce(
      (total, componente) => total + componente.aporte,
      0,
    );

    // Tolerancia por el redondeo a dos decimales de cada aporte.
    assert.ok(
      Math.abs(suma - calculo.score) < 0.05,
      `la suma de aportes (${suma}) no coincide con el puntaje (${calculo.score})`,
    );
  });

  it('fn_refrescar_prioridad persiste el puntaje y su versión', async () => {
    await crearRecurso({ ...BASE });
    const reporte = await crearReporteDirecto({ ...BASE, afectadas: 5, severidad: 'ALTA' });

    await bd.consultar('SELECT fn_refrescar_prioridad($1)', [reporte]);

    const { rows } = await bd.consultar<{
      prioridad_score: number | null;
      prioridad_version: number | null;
      prioridad_componentes: unknown;
      prioridad_calculada_en: Date | null;
    }>(
      `SELECT prioridad_score, prioridad_version, prioridad_componentes, prioridad_calculada_en
         FROM reportes WHERE id = $1`,
      [reporte],
    );

    const fila = rows[0]!;
    assert.ok(fila.prioridad_score !== null && fila.prioridad_score > 0);
    assert.equal(fila.prioridad_version, 1);
    assert.ok(fila.prioridad_componentes !== null);
    assert.ok(fila.prioridad_calculada_en !== null);
  });

  it('devuelve null para un reporte que no existe', async () => {
    const { rows } = await bd.consultar<{ calculo: unknown }>(
      `SELECT fn_prioridad_reporte('00000000-0000-4000-8000-000000000000'::uuid) AS calculo`,
    );
    assert.equal(rows[0]!.calculo, null);
  });
});
