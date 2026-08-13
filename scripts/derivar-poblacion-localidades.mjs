#!/usr/bin/env node
/**
 * Convierte la hoja de cálculo de proyecciones de población de Bogotá en el CSV
 * que lee `cargar-lugares.mjs`.
 *
 *   node scripts/derivar-poblacion-localidades.mjs <archivo.ods> [anio]
 *
 * ## Por qué existe como herramienta aparte
 *
 * La Secretaría Distrital de Planeación publica esto **solo en ODS** —no hay CSV
 * ni servicio consultable— y el archivo son 1,9 MB que descomprimidos son 31 MB
 * de XML: 843 filas por 2.314 columnas, con la población abierta por sexo y por
 * cada edad de 0 a 100, para cada localidad, cada año entre 2005 y 2035, y cada
 * área (cabecera y centro poblado / rural disperso).
 *
 * De todo eso salen veinte números. Meter un lector de ODS en el cargador para
 * eso sería cargar el peso permanente de un formato que se lee una vez al año, y
 * versionar el ODS engordaría el repositorio con 1,9 MB para guardar veinte
 * filas. Así que esto corre a mano, deja un CSV auditable de veinte líneas, y el
 * cargador no sabe que el ODS existe.
 *
 * ## Por qué el año por omisión es 2018 y no el actual
 *
 * Los municipios llevan la población del censo de 2018 (`stp27_pers` del MGN
 * integrado). Si las localidades llevaran la proyección de 2026, el panel de
 * zonas compararía razones por habitante calculadas con denominadores de años
 * distintos, y las de Bogotá saldrían sistemáticamente más bajas por usar una
 * población más grande. **Para comparar entre zonas importa más que el año sea el
 * mismo que que sea reciente.** Se puede pedir otro año como segundo argumento,
 * pero entonces habría que mover también el de los municipios.
 *
 * Fuente: «Proyecciones y retroproyecciones de Población (2005 - 2035)»,
 * Secretaría Distrital de Planeación con el DANE, versión de marzo de 2025,
 * CC BY 4.0.
 * https://datosabiertos.bogota.gov.co/dataset/proyecciones-y-retroproyecciones-de-poblacion-2005-2035
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';

const ANIO_POR_OMISION = 2018;

const [rutaOds, anioPedido] = process.argv.slice(2);
const anio = Number(anioPedido ?? ANIO_POR_OMISION);

if (!rutaOds) {
  console.error(
    'Uso: node scripts/derivar-poblacion-localidades.mjs <archivo.ods> [anio]\n' +
      `  anio por omisión: ${ANIO_POR_OMISION} (ver la nota de la cabecera)`,
  );
  process.exit(1);
}

if (!Number.isInteger(anio) || anio < 2005 || anio > 2035) {
  console.error('El año debe ser un entero entre 2005 y 2035 (el rango que publica la fuente).');
  process.exit(1);
}

/**
 * Saca un archivo de dentro de un ZIP. Un ODS es un ZIP.
 *
 * Se lee el directorio central y no los encabezados locales porque estos últimos
 * pueden traer los tamaños en cero cuando el archivo se escribió en flujo, y
 * entonces no se sabe cuántos bytes descomprimir. El directorio central siempre
 * los tiene.
 */
function extraerDelZip(buffer, nombreBuscado) {
  // Fin del directorio central: se busca hacia atrás porque lleva un comentario
  // de longitud variable al final.
  let fin = -1;
  for (let i = buffer.length - 22; i >= 0 && i > buffer.length - 65_557; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      fin = i;
      break;
    }
  }
  if (fin < 0) throw new Error('No parece un ZIP: no se encontró el directorio central.');

  const entradas = buffer.readUInt16LE(fin + 10);
  let cursor = buffer.readUInt32LE(fin + 16);

  for (let n = 0; n < entradas; n++) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error('Directorio central corrupto.');
    }
    const metodo = buffer.readUInt16LE(cursor + 10);
    const comprimido = buffer.readUInt32LE(cursor + 20);
    const largoNombre = buffer.readUInt16LE(cursor + 28);
    const largoExtra = buffer.readUInt16LE(cursor + 30);
    const largoComentario = buffer.readUInt16LE(cursor + 32);
    const desplazamiento = buffer.readUInt32LE(cursor + 42);
    const nombre = buffer.toString('utf8', cursor + 46, cursor + 46 + largoNombre);

    if (nombre === nombreBuscado) {
      // En el encabezado local los largos de nombre y extra pueden diferir de los
      // del directorio, así que se releen acá.
      const nombreLocal = buffer.readUInt16LE(desplazamiento + 26);
      const extraLocal = buffer.readUInt16LE(desplazamiento + 28);
      const inicio = desplazamiento + 30 + nombreLocal + extraLocal;
      const datos = buffer.subarray(inicio, inicio + comprimido);
      return metodo === 0 ? datos : inflateRawSync(datos);
    }

    cursor += 46 + largoNombre + largoExtra + largoComentario;
  }
  throw new Error(`El ZIP no contiene «${nombreBuscado}».`);
}

/**
 * Las celdas de una fila de ODS, expandiendo las repeticiones.
 *
 * OpenDocument comprime las celdas iguales consecutivas con
 * `table:number-columns-repeated`, así que sin expandirlas las columnas se
 * desalinean y uno acaba leyendo el año en la casilla del área. El tope de 4096
 * es para no expandir las repeticiones de relleno del final de la hoja, que
 * pueden declarar decenas de miles de columnas vacías.
 */
function celdasDeFila(xmlFila) {
  const celdas = [];
  const re = /<table:table-cell([^>]*?)(?:\/>|>([\s\S]*?)<\/table:table-cell>)/g;
  let m;
  while ((m = re.exec(xmlFila)) !== null) {
    const atributos = m[1] ?? '';
    const cuerpo = m[2] ?? '';
    const texto = [...cuerpo.matchAll(/<text:p[^>]*>([\s\S]*?)<\/text:p>/g)]
      .map((t) => t[1].replace(/<[^>]+>/g, ''))
      .join(' ')
      .trim();
    const repetido = /table:number-columns-repeated="(\d+)"/.exec(atributos);
    const veces = repetido ? Math.min(Number(repetido[1]), 4096) : 1;
    for (let i = 0; i < veces; i++) celdas.push(texto);
  }
  return celdas;
}

// --------------------------------------------------------------- extracción

const contenido = extraerDelZip(readFileSync(rutaOds), 'content.xml').toString('utf8');
const filas = [...contenido.matchAll(/<table:table-row[^>]*>([\s\S]*?)<\/table:table-row>/g)].map(
  (f) => f[1],
);

// La cabecera se busca por su contenido y no por su número de fila: la hoja trae
// filas de adorno arriba y contar a mano sería frágil.
const indiceCabecera = filas.findIndex((f) => {
  const c = celdasDeFila(f);
  return c[4] === 'Código Localidad' && c[7] === 'AÑO';
});

if (indiceCabecera < 0) {
  console.error(
    'No se encontró la fila de cabecera esperada (con «Código Localidad» y «AÑO»).\n' +
      'Si la fuente cambió la estructura de la hoja, hay que revisar este script.',
  );
  process.exit(1);
}

const cabecera = celdasDeFila(filas[indiceCabecera]);
const columnasPoblacion = cabecera
  .map((nombre, i) => ({ nombre, i }))
  .filter(({ nombre }) => /^(Hombres|Mujeres)_\d+$/.test(nombre))
  .map(({ i }) => i);

if (columnasPoblacion.length === 0) {
  console.error('No se encontró ninguna columna Hombres_N ni Mujeres_N.');
  process.exit(1);
}

/** código de localidad → { nombre, poblacion } sumando sexos, edades y áreas. */
const porLocalidad = new Map();
let filasUsadas = 0;

for (let i = indiceCabecera + 1; i < filas.length; i++) {
  const c = celdasDeFila(filas[i]);
  if (c.length < 9 || Number(c[7]) !== anio) continue;

  const codigo = String(c[4] ?? '').trim();
  if (!codigo) continue;

  // El código viene sin ceros a la izquierda («1») y IDECA lo publica con dos
  // dígitos («01»). Se normaliza acá para que las dos fuentes se puedan cruzar.
  const llave = codigo.padStart(2, '0');
  let total = 0;
  for (const col of columnasPoblacion) {
    const valor = Number(String(c[col] ?? '').replace(/[^\d.-]/g, ''));
    if (Number.isFinite(valor)) total += valor;
  }

  const previo = porLocalidad.get(llave);
  // Se suma en vez de asignar: cada localidad puede aparecer dos veces, una por
  // cabecera municipal y otra por centro poblado y rural disperso.
  porLocalidad.set(llave, {
    nombre: previo?.nombre ?? String(c[5] ?? '').trim(),
    poblacion: (previo?.poblacion ?? 0) + Math.round(total),
  });
  filasUsadas++;
}

if (porLocalidad.size === 0) {
  console.error(`No se encontró ninguna fila del año ${anio}.`);
  process.exit(1);
}

// --------------------------------------------------------------- escritura

const salida = path.resolve('db', 'poblacion-localidades-bogota.csv');
const lineas = [
  `# Población por localidad de Bogotá, año ${anio}.`,
  '#',
  '# Derivado de «Proyecciones y retroproyecciones de Población (2005 - 2035)»,',
  '# Secretaría Distrital de Planeación con el DANE, CC BY 4.0.',
  '# https://datosabiertos.bogota.gov.co/dataset/proyecciones-y-retroproyecciones-de-poblacion-2005-2035',
  '#',
  '# El total de cada localidad es la suma de todas las columnas Hombres_N y',
  '# Mujeres_N (edades 0 a 100), sumando las dos áreas de la fuente: cabecera',
  '# municipal y centro poblado y rural disperso.',
  '#',
  `# El año es ${anio} a propósito, para que coincida con el censo que usan los`,
  '# municipios: comparar reportes por habitante entre zonas exige el mismo',
  '# denominador. Regenerar con: node scripts/derivar-poblacion-localidades.mjs <ods> [anio]',
  'codigo,nombre,poblacion',
  ...[...porLocalidad.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([codigo, { nombre, poblacion }]) => `${codigo},${nombre},${poblacion}`),
];

writeFileSync(salida, lineas.join('\n') + '\n', 'utf8');

const total = [...porLocalidad.values()].reduce((a, x) => a + x.poblacion, 0);
console.log(`Año ${anio} · ${filasUsadas} fila(s) de la hoja · ${porLocalidad.size} localidades`);
console.log(`Total Bogotá: ${total.toLocaleString('es-CO')} habitantes`);
console.log(`Escrito: ${salida}`);
