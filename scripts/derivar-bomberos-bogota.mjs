#!/usr/bin/env node
/**
 * Baja las estaciones de bomberos de Bogotá de IDECA y escribe el JSON que lee
 * `cargar-recursos.mjs`.
 *
 *   node scripts/derivar-bomberos-bogota.mjs
 *   node --env-file-if-exists=.env scripts/cargar-recursos.mjs db/bomberos-bogota.json
 *
 * ## Por qué dos pasos y no uno
 *
 * `cargar-recursos.mjs` ya valida todo lo que importa: tipos contra el enum,
 * coordenadas dentro de Colombia, colisiones de clave dentro del archivo, y
 * reconciliación por `fuente` + `fuente_id`. Escribir un cargador nuevo que
 * hable con IDECA sería duplicar esa validación y con ella el riesgo. Este script
 * solo traduce de un formato a otro y deja que el cargador probado haga su
 * trabajo.
 *
 * ## Por qué estas 19 y no las 3.059 instituciones de salud
 *
 * IDECA también publica 3.059 instituciones prestadoras de salud con coordenadas
 * oficiales, y **no se cargan a propósito**: ningún campo distingue un hospital de
 * un consultorio odontológico de una pieza —`CLASE_DE_P` dice «IPS» en las 3.059—
 * y no existe una capa de urgencias para filtrarlas.
 *
 * Meterlas distorsionaría el índice de prioridad, no solo el mapa: el término de
 * aislamiento mide la distancia al recurso disponible más cercano, así que tres
 * mil consultorios harían que todos los reportes de Bogotá parezcan bien
 * cubiertos y les bajarían el puntaje. Un consultorio no es capacidad de
 * emergencia. Las estaciones de bomberos, en cambio, son inequívocas.
 *
 * Fuente: IDECA / Unidad Administrativa Especial de Catastro Distrital,
 * servicio `emergencias/bomberos`. Datos abiertos de Bogotá.
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';

const URL_CAPA =
  'https://serviciosgis.catastrobogota.gov.co/arcgis/rest/services/emergencias/bomberos/MapServer/0/query';

/** Las que se esperan hoy. Si el número cambia, conviene mirar antes de cargar. */
const ESPERADAS = 19;

const parametros = new URLSearchParams({
  where: '1=1',
  outFields: 'ESTACION,NOMBRE,COMPAÑIA,DIRECCION,TELEFONOS',
  outSR: '4326',
  f: 'geojson',
});

const respuesta = await fetch(`${URL_CAPA}?${parametros}`, {
  signal: AbortSignal.timeout(60_000),
});

if (!respuesta.ok) {
  console.error(`IDECA respondió HTTP ${respuesta.status}.`);
  process.exit(1);
}

const cuerpo = await respuesta.json();
if (cuerpo.error) {
  console.error(`IDECA falló: ${cuerpo.error.message ?? 'sin detalle'}`);
  process.exit(1);
}

const entidades = cuerpo.features ?? [];
const problemas = [];

if (entidades.length !== ESPERADAS) {
  problemas.push(
    `Llegaron ${entidades.length} estaciones y se esperaban ${ESPERADAS}. ` +
      'Revise el servicio antes de cargar: puede haber estaciones nuevas o puede ' +
      'estar respondiendo a medias.',
  );
}

const recursos = [];
for (const [i, e] of entidades.entries()) {
  const p = e.properties ?? {};
  const codigo = String(p.ESTACION ?? '').trim();
  const nombre = String(p.NOMBRE ?? '').trim();
  const donde = `estación ${i + 1}${codigo ? ` (${codigo})` : ''}`;

  if (!codigo) problemas.push(`${donde}: sin código de estación`);
  if (!nombre) problemas.push(`${donde}: sin nombre`);

  const coordenadas = e.geometry?.coordinates;
  if (!Array.isArray(coordenadas) || coordenadas.length < 2) {
    problemas.push(`${donde}: sin coordenadas`);
    continue;
  }
  const [lng, lat] = coordenadas;

  /**
   * El teléfono va en `notas` porque `recursos` no tiene columna para él.
   *
   * Podría ser una migración, y no lo es: para un rescatista que mira la lista de
   * recursos cercanos, el teléfono junto al nombre resuelve el problema —poder
   * llamar antes de salir— sin agregarle una columna a una tabla de un sistema en
   * uso. Si algún día hay teléfonos de más fuentes, ahí sí vale la columna.
   */
  const telefono = String(p.TELEFONOS ?? '')
    .split('/')
    .map((t) => t.trim())
    .filter(Boolean)
    .join(' / ');

  const notas = [
    'IDECA (Catastro Distrital), dato oficial.',
    p.DIRECCION ? `Dirección: ${String(p.DIRECCION).trim()}.` : null,
    telefono ? `Teléfono: ${telefono}.` : null,
    p.COMPAÑIA ? `${String(p.COMPAÑIA).trim()}.` : null,
  ]
    .filter(Boolean)
    .join(' ');

  recursos.push({
    nombre,
    tipo: 'ESTACION_BOMBEROS',
    lat,
    lng,
    capacidad_total: null,
    notas,
    // La identidad estable es el código de estación, no el nombre: es la misma
    // lección de la migración 011. Y con `fuente` distinta, estas conviven con
    // las de OpenStreetMap en vez de pelearse por el índice de nombre.
    fuente: 'ideca',
    fuente_id: `bomberos/${codigo}`,
  });
}

if (problemas.length > 0) {
  console.error('No se escribió nada. Problemas encontrados:\n');
  problemas.forEach((p) => console.error('  ·', p));
  process.exit(1);
}

const salida = path.resolve('db', 'bomberos-bogota.json');
writeFileSync(salida, JSON.stringify(recursos, null, 2) + '\n', 'utf8');

console.log(`${recursos.length} estaciones de bomberos de Bogotá escritas en ${salida}`);
console.log('\nCargar con:');
console.log('  node --env-file-if-exists=.env scripts/cargar-recursos.mjs db/bomberos-bogota.json');
