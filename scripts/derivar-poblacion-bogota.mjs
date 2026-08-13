#!/usr/bin/env node
/**
 * Convierte las hojas de cálculo de proyecciones de población de Bogotá en los
 * CSV que lee `cargar-lugares.mjs`.
 *
 *   node scripts/derivar-poblacion-bogota.mjs <archivo.ods> [anio]
 *
 * Detecta solo si la hoja es la de localidades o la de UPZ y escribe
 * `db/poblacion-localidades-bogota.csv` o `db/poblacion-upz-bogota.csv`.
 *
 * ## Por qué existe como herramienta aparte
 *
 * La Secretaría Distrital de Planeación publica esto **solo en ODS** —no hay CSV
 * ni servicio consultable— y cada archivo son ~1,9 MB que descomprimidos son 30 MB
 * de XML: miles de filas con la población abierta por sexo y edad, para cada zona,
 * cada año entre 2005 y 2035, y cada área (cabecera y centro poblado / rural
 * disperso).
 *
 * De todo eso salen 20 o 112 números. Meter un lector de ODS en el cargador sería
 * cargar el peso permanente de un formato que se lee una vez al año, y versionar
 * los ODS engordaría el repositorio con 3,8 MB para guardar 132 filas. Así que
 * esto corre a mano, deja CSV auditables, y el cargador no sabe que el ODS existe.
 *
 * ## Nada se lee por posición
 *
 * Las dos hojas tienen estructuras distintas: la de UPZ trae dos columnas más, el
 * año está en otro sitio, y los grupos de edad son rangos (`Hombres_0-4`, hasta
 * `Mujeres_85 y más`) mientras la de localidades usa edades sueltas
 * (`Hombres_0`..`Hombres_100`). Todo se ubica por el **nombre** de la columna en la
 * cabecera. Contar posiciones habría funcionado con el primer archivo y habría
 * leído el año en la casilla del área con el segundo.
 *
 * ## Por qué el año por omisión es 2018 y no el actual
 *
 * Los municipios llevan la población del censo de 2018 (`stp27_pers` del MGN
 * integrado). Si las zonas de Bogotá llevaran la proyección de 2026, el panel de
 * zonas compararía razones por habitante calculadas con denominadores de años
 * distintos, y las de Bogotá saldrían sistemáticamente más bajas por usar una
 * población mayor. **Para comparar entre zonas importa más que el año sea el mismo
 * que que sea reciente.**
 *
 * Queda una diferencia que no se puede eliminar: el censo cuenta a quien encontró
 * y la serie distrital corrige la omisión censal, así que para Bogotá 2018 son
 * 3,2 % de diferencia entre las dos. La misma cifra medida de dos maneras.
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

/**
 * Los dos niveles que sabe leer, en orden de preferencia.
 *
 * La hoja de UPZ trae también las columnas de localidad, así que si se encuentran
 * las de UPZ hay que quedarse con esas: son las más específicas del archivo.
 */
const NIVELES = [
  {
    nombre: 'UPZ',
    columnaCodigo: 'Código UPZ',
    columnaNombre: 'Nombre UPZ',
    /** IDECA publica los códigos sin rellenar («57»); la hoja con tres («057»). */
    anchoCodigo: 3,
    salida: 'poblacion-upz-bogota.csv',
  },
  {
    nombre: 'localidad',
    columnaCodigo: 'Código Localidad',
    columnaNombre: 'Nombre Localidad',
    anchoCodigo: 2,
    salida: 'poblacion-localidades-bogota.csv',
  },
];

const [rutaOds, anioPedido] = process.argv.slice(2);
const anio = Number(anioPedido ?? ANIO_POR_OMISION);

if (!rutaOds) {
  console.error(
    'Uso: node scripts/derivar-poblacion-bogota.mjs <archivo.ods> [anio]\n' +
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
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Directorio central corrupto.');

    const metodo = buffer.readUInt16LE(cursor + 10);
    const comprimido = buffer.readUInt32LE(cursor + 20);
    const largoNombre = buffer.readUInt16LE(cursor + 28);
    const largoExtra = buffer.readUInt16LE(cursor + 30);
    const largoComentario = buffer.readUInt16LE(cursor + 32);
    const desplazamiento = buffer.readUInt32LE(cursor + 42);
    const nombre = buffer.toString('utf8', cursor + 46, cursor + 46 + largoNombre);

    if (nombre === nombreBuscado) {
      // Los largos del encabezado local pueden diferir de los del directorio.
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
 * Las celdas de una fila, expandiendo las repeticiones.
 *
 * OpenDocument comprime las celdas iguales consecutivas con
 * `table:number-columns-repeated`, y sin expandirlas las columnas se desalinean.
 * El tope de 4096 evita expandir el relleno del final de la hoja, que declara
 * decenas de miles de columnas vacías.
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

// La cabecera se busca por su contenido: la hoja trae filas de adorno arriba y
// contarlas a mano sería frágil.
const indiceCabecera = filas.findIndex((f) => {
  const c = celdasDeFila(f);
  return c.includes('AÑO') && c.some((x) => x === 'Código Localidad' || x === 'Código UPZ');
});

if (indiceCabecera < 0) {
  console.error(
    'No se encontró la cabecera esperada (una fila con «AÑO» y «Código UPZ» o «Código Localidad»).\n' +
      'Si la fuente cambió la estructura de la hoja, hay que revisar este script.',
  );
  process.exit(1);
}

const cabecera = celdasDeFila(filas[indiceCabecera]);
const nivel = NIVELES.find((n) => cabecera.includes(n.columnaCodigo));

if (!nivel) {
  console.error('La hoja no trae ninguna columna de código reconocida.');
  process.exit(1);
}

const colCodigo = cabecera.indexOf(nivel.columnaCodigo);
const colNombre = cabecera.indexOf(nivel.columnaNombre);
const colAnio = cabecera.indexOf('AÑO');
// Prefijo y no `_\d+$`: la hoja de localidades usa edades sueltas («Hombres_0») y
// la de UPZ usa rangos que terminan en texto («Mujeres_85 y más»).
const colsPoblacion = cabecera
  .map((nombre, i) => ({ nombre, i }))
  .filter(({ nombre }) => /^(Hombres|Mujeres)_/.test(nombre))
  .map(({ i }) => i);

if (colNombre < 0 || colAnio < 0 || colsPoblacion.length === 0) {
  console.error(
    `Cabecera incompleta para ${nivel.nombre}: ` +
      `nombre=${colNombre}, año=${colAnio}, columnas de población=${colsPoblacion.length}`,
  );
  process.exit(1);
}

const porZona = new Map();
let filasUsadas = 0;

for (let i = indiceCabecera + 1; i < filas.length; i++) {
  const c = celdasDeFila(filas[i]);
  if (c.length <= colAnio || Number(c[colAnio]) !== anio) continue;

  const codigo = String(c[colCodigo] ?? '').trim();
  if (!codigo) continue;

  const llave = codigo.padStart(nivel.anchoCodigo, '0');
  let total = 0;
  for (const col of colsPoblacion) {
    const valor = Number(String(c[col] ?? '').replace(/[^\d.-]/g, ''));
    if (Number.isFinite(valor)) total += valor;
  }

  const previo = porZona.get(llave);
  // Se suma en vez de asignar: cada zona puede aparecer dos veces, una por
  // cabecera municipal y otra por centro poblado y rural disperso.
  porZona.set(llave, {
    nombre: previo?.nombre ?? String(c[colNombre] ?? '').trim(),
    poblacion: (previo?.poblacion ?? 0) + Math.round(total),
  });
  filasUsadas++;
}

if (porZona.size === 0) {
  console.error(`No se encontró ninguna fila del año ${anio}.`);
  process.exit(1);
}

// --------------------------------------------------------------- escritura

const salida = path.resolve('db', nivel.salida);
const lineas = [
  `# Población por ${nivel.nombre} de Bogotá, año ${anio}.`,
  '#',
  '# Derivado de «Proyecciones y retroproyecciones de Población (2005 - 2035)»,',
  '# Secretaría Distrital de Planeación con el DANE, CC BY 4.0.',
  '# https://datosabiertos.bogota.gov.co/dataset/proyecciones-y-retroproyecciones-de-poblacion-2005-2035',
  '#',
  `# El total de cada ${nivel.nombre} es la suma de todas las columnas Hombres_* y`,
  '# Mujeres_*, sumando las dos áreas de la fuente: cabecera municipal y centro',
  '# poblado y rural disperso.',
  '#',
  `# El año es ${anio} a propósito, para que coincida con el censo que usan los`,
  '# municipios: comparar reportes por habitante entre zonas exige el mismo',
  '# denominador. Regenerar con:',
  '#   node scripts/derivar-poblacion-bogota.mjs <archivo.ods> [anio]',
  'codigo,nombre,poblacion',
  ...[...porZona.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([codigo, { nombre, poblacion }]) => `${codigo},${nombre},${poblacion}`),
];

writeFileSync(salida, lineas.join('\n') + '\n', 'utf8');

const total = [...porZona.values()].reduce((a, x) => a + x.poblacion, 0);
console.log(
  `Nivel ${nivel.nombre} · año ${anio} · ${filasUsadas} fila(s) de la hoja · ${porZona.size} zonas`,
);
console.log(`Total: ${total.toLocaleString('es-CO')} habitantes`);
console.log(`Escrito: ${salida}`);
