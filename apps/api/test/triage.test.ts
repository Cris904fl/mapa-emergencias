import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { calcularActualizacion } from '../src/servicios/triage.ts';
import { EsquemaExtraccion, type Extraccion } from '../src/servicios/ia/extractor.ts';

/**
 * Pruebas de la política de qué puede escribir un modelo en un reporte.
 *
 * No hacen inferencia real: se construyen propuestas a mano, que es lo correcto
 * porque lo que se está probando es la política, no el modelo. Un modelo cambia
 * de versión; la regla de que no puede pisar lo que dijo una persona no.
 *
 * Los casos de "cifra indeterminada" vienen de una medición real contra
 * qwen2.5:7b donde el modelo convertía "varias personas" en 5 y "no sabemos
 * cuántos hay adentro" en 1 (ver docs/ia-local.md).
 */

const REPORTE_VACIO = {
  id: 'r1',
  codigo_publico: 'RPT-XXXXX',
  descripcion: 'texto',
  categoria: 'OTRO',
  severidad: 'DESCONOCIDA',
  origen_triage: 'CIUDADANO',
  personas_afectadas: 0,
  personas_atrapadas: 0,
  personas_heridas: 0,
  personas_fallecidas: 0,
  personas_vulnerables: 0,
  requiere_rescate: false,
};

function propuesta(cambios: Partial<Extraccion> = {}): Extraccion {
  return {
    justificacion: 'justificación de prueba',
    cantidad_indeterminada: false,
    personas_afectadas: 0,
    personas_atrapadas: 0,
    personas_heridas: 0,
    personas_fallecidas: 0,
    personas_vulnerables: 0,
    requiere_rescate: false,
    severidad: 'DESCONOCIDA',
    categoria: 'OTRO',
    confianza: 'ALTA',
    ...cambios,
  };
}

describe('política de escritura de la IA', () => {
  it('rellena los conteos que el ciudadano dejó en cero', () => {
    const { valores, campos } = calcularActualizacion(
      REPORTE_VACIO,
      propuesta({ personas_afectadas: 5, personas_heridas: 1, personas_vulnerables: 2 }),
    );

    assert.deepEqual(valores.personas_afectadas, 5);
    assert.deepEqual(valores.personas_heridas, 1);
    assert.deepEqual(valores.personas_vulnerables, 2);
    assert.ok(campos.includes('personas_afectadas'));
  });

  it('NUNCA aplica personas_atrapadas, ni con confianza ALTA', () => {
    // Es el campo con más apalancamiento (pesa ×3 en la carga humana) y el que
    // el modelo local se equivoca de forma reproducible: ante "se nos inundó la
    // casa, somos 4" propuso 4 atrapadas con confianza ALTA. Ordenar la cola de
    // rescate por gente que no necesita rescate es el peor fallo del sistema.
    const { valores, campos } = calcularActualizacion(
      REPORTE_VACIO,
      propuesta({ personas_afectadas: 4, personas_atrapadas: 4, confianza: 'ALTA' }),
    );

    assert.equal(valores.personas_atrapadas, undefined);
    assert.ok(!campos.includes('personas_atrapadas'));
    // Los demás conteos sí pasan: el problema es específico de este campo.
    assert.equal(valores.personas_afectadas, 4);
  });

  it('NO sobreescribe un conteo que el ciudadano escribió', () => {
    // Quien está en el sitio contando personas es mejor fuente que un modelo
    // leyendo su prosa.
    const reporte = { ...REPORTE_VACIO, personas_afectadas: 3 };
    const { valores, campos } = calcularActualizacion(
      reporte,
      propuesta({ personas_afectadas: 12 }),
    );

    assert.equal(valores.personas_afectadas, undefined);
    assert.ok(!campos.includes('personas_afectadas'));
  });

  it('ignora TODOS los conteos cuando la cantidad es indeterminada', () => {
    // El caso que motivó el campo: el modelo veía "varias personas no pueden
    // salir" y proponía 5. Aunque proponga cifras, con la bandera activada no
    // se aplican.
    const { valores, campos } = calcularActualizacion(
      REPORTE_VACIO,
      propuesta({
        cantidad_indeterminada: true,
        personas_afectadas: 5,
        personas_atrapadas: 5,
        requiere_rescate: true,
      }),
    );

    assert.equal(valores.personas_afectadas, undefined);
    assert.equal(valores.personas_heridas, undefined);
    assert.ok(!campos.some((campo) => campo.startsWith('personas_')));
    // requiere_rescate sí puede pasar: no es un conteo, y es la dirección segura.
    assert.equal(valores.requiere_rescate, true);
  });

  it('completa la severidad solo si el ciudadano dijo DESCONOCIDA', () => {
    const conDesconocida = calcularActualizacion(
      REPORTE_VACIO,
      propuesta({ severidad: 'CRITICA' }),
    );
    assert.equal(conDesconocida.valores.severidad, 'CRITICA');

    // Si el ciudadano dijo BAJA y el modelo dice CRITICA, manda el ciudadano.
    // La discrepancia queda registrada para que un operador la resuelva.
    const conBaja = calcularActualizacion(
      { ...REPORTE_VACIO, severidad: 'BAJA' },
      propuesta({ severidad: 'CRITICA' }),
    );
    assert.equal(conBaja.valores.severidad, undefined);
  });

  it('requiere_rescate solo sube a true, nunca baja a false', () => {
    // Un falso negativo acá significa no mandar un equipo a donde hacía falta.
    const sube = calcularActualizacion(REPORTE_VACIO, propuesta({ requiere_rescate: true }));
    assert.equal(sube.valores.requiere_rescate, true);

    const noBaja = calcularActualizacion(
      { ...REPORTE_VACIO, requiere_rescate: true },
      propuesta({ requiere_rescate: false }),
    );
    assert.equal(noBaja.valores.requiere_rescate, undefined);
  });

  it('no propone nada cuando el ciudadano ya lo llenó todo', () => {
    const reporteCompleto = {
      ...REPORTE_VACIO,
      severidad: 'ALTA',
      personas_afectadas: 5,
      personas_atrapadas: 2,
      personas_heridas: 1,
      personas_vulnerables: 1,
      requiere_rescate: true,
    };

    const { campos } = calcularActualizacion(
      reporteCompleto,
      propuesta({
        personas_afectadas: 9,
        personas_atrapadas: 4,
        severidad: 'CRITICA',
        requiere_rescate: true,
      }),
    );

    assert.equal(campos.length, 0, 'no debe haber nada que aplicar');
  });

  it('nunca propone cambiar la categoría', () => {
    // La categoría define qué equipo se despacha. La propuesta del modelo se
    // guarda como discrepancia para que la lea un operador, pero no se escribe.
    const { valores, campos } = calcularActualizacion(
      REPORTE_VACIO,
      propuesta({ categoria: 'PERSONAS_ATRAPADAS' }),
    );

    assert.equal(valores.categoria, undefined);
    assert.ok(!campos.includes('categoria'));
  });
});

describe('esquema de extracción', () => {
  it('el orden de los campos pone el razonamiento antes de las clasificaciones', () => {
    // No es una preferencia de estilo: bajo decodificación restringida el JSON
    // se emite en el orden del esquema. Con `categoria` primero la precisión
    // medida fue 1/4; con `justificacion` primero, 6/7. Si alguien reordena
    // esto, esta prueba falla y obliga a volver a medir.
    const orden = Object.keys(EsquemaExtraccion.shape);

    assert.equal(orden[0], 'justificacion', 'justificacion debe ir primero');
    assert.ok(
      orden.indexOf('cantidad_indeterminada') < orden.indexOf('personas_afectadas'),
      'la bandera de cantidad indeterminada va antes de los conteos',
    );
    assert.ok(
      orden.indexOf('justificacion') < orden.indexOf('categoria'),
      'la justificación va antes de la categoría',
    );
    assert.ok(
      orden.indexOf('personas_afectadas') < orden.indexOf('severidad'),
      'los conteos van antes de las clasificaciones',
    );
  });

  it('rechaza conteos negativos', () => {
    // La gramática de Ollama garantiza que el JSON encaje en la forma del
    // esquema, no que respete min(0). Un conteo negativo rompería la función de
    // prioridad, así que la validación con Zod es la que lo atrapa.
    const resultado = EsquemaExtraccion.safeParse({
      ...propuesta(),
      personas_afectadas: -3,
    });
    assert.equal(resultado.success, false);
  });

  it('rechaza una categoría que no existe en el dominio', () => {
    const resultado = EsquemaExtraccion.safeParse({
      ...propuesta(),
      categoria: 'INVENTADA',
    });
    assert.equal(resultado.success, false);
  });
});
