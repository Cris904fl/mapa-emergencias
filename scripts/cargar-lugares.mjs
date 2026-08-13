#!/usr/bin/env node
/**
 * Carga la geografía administrativa de Colombia en `lugares`, desde el Marco
 * Geoestadístico Nacional del DANE.
 *
 *   node --env-file-if-exists=.env scripts/cargar-lugares.mjs
 *
 * Por qué existe: con `lugares` vacía, el trigger `reportes_antes_insertar` no
 * resuelve la zona de ningún reporte y el panel de «Zonas» del tablero se queda
 * en blanco. No es un adorno: es la única vista que agrupa —«en este municipio
 * hay once reportes y cuatro personas atrapadas»— y sin ella la sala de crisis
 * solo ve una lista.
 *
 * ## Por qué se baja del servicio y no se versiona un archivo
 *
 * A diferencia de `cargar-recursos.mjs`, que lee un JSON del repositorio, acá se
 * consulta el servicio del DANE en el momento. La geometría de 1.155 polígonos
 * son unos 10 MB: versionarlos engordaría el repositorio para congelar un dato
 * que el DANE actualiza, y que tiene una fuente oficial consultable. El código
 * DIVIPOLA de cada entidad es su identidad estable, así que volver a correr esto
 * el año que viene actualiza en vez de duplicar.
 *
 * ## La generalización no es una optimización, es una decisión
 *
 * El servicio entrega la geometría completa: **142 KB y 3.667 vértices para un
 * solo municipio**, unos 155 MB para el país. Con `maxAllowableOffset` el
 * servidor la simplifica antes de enviarla y baja a 9 KB por municipio, unos
 * 10 MB en total.
 *
 * El valor por omisión es 0,0002 grados, unos 22 m. Esa es la única precisión
 * que este dato necesita: sirve para decir en qué municipio cayó un punto, y un
 * error solo es posible a menos de 22 m de una frontera municipal. Se puede
 * pedir la geometría exacta con `--tolerancia=0`, pero son quince veces más
 * bytes para una exactitud que ninguna decisión de este sistema usa.
 *
 * Consecuencia conocida: simplificar puede dejar rendijas entre municipios
 * vecinos. Un reporte que caiga justo en una se queda sin zona —`lugar_id` en
 * NULL—, que es exactamente lo que pasa hoy con la tabla vacía. Degrada al
 * estado actual, no a algo peor.
 *
 * ## Por omisión solo municipios, y esto no es pereza
 *
 * El trigger resuelve la zona con `ORDER BY ST_Area(l.geom) ASC LIMIT 1`: el
 * lugar más pequeño que contiene el punto. Con un solo nivel cargado eso es
 * siempre el municipio y no hay ambigüedad.
 *
 * Cargar también los departamentos rompe eso en Bogotá, y **Bogotá es de donde
 * viene la mayoría de los reportes**. En DIVIPOLA el Distrito Capital existe dos
 * veces —departamento `11` y municipio `11001`— sobre el mismo territorio, con el
 * área idéntica hasta el último decimal. El `ORDER BY` queda empatado y Postgres
 * desempata como quiera, así que dos reportes de la misma cuadra pueden caer en
 * filas distintas con el mismo nombre, y el panel de «Zonas» mostraría
 * «BOGOTÁ, D.C.» dos veces con los reportes repartidos entre las dos.
 *
 * Con `--con-departamentos` se cargan los dos niveles y los municipios quedan
 * colgados de su departamento. Sirve si algún día se quiere agrupar por
 * departamento, pero exige antes una migración que haga al trigger preferir el
 * `tipo` más específico en vez de fiarse del área. Mientras eso no exista, un
 * nivel es correcto y dos son ambiguos.
 */

import pg from 'pg';

const RAIZ = 'https://portalgis.dane.gov.co/mparcgis/rest/services/Hosted';

/**
 * Los dos niveles que se cargan, en orden: el padre antes que el hijo.
 *
 * `portalgis.dane.gov.co` y no `geoportal.dane.gov.co`: el segundo es el que
 * aparece en la documentación y desde acá no responde —se queda colgado hasta el
 * tiempo límite—, mientras este contesta en menos de un segundo. Si algún día
 * deja de hacerlo, los mismos datos se pueden bajar a mano del geoportal.
 */
const NIVELES = [
  {
    tipo: 'DEPARTAMENTO',
    servicio: 'Serv_Dpto_MGN_2025/FeatureServer/319',
    campoCodigo: 'dpto_ccdgo',
    campoNombre: 'dpto_cnmbre',
    campoPadre: null,
    esperados: 33,
  },
  {
    tipo: 'MUNICIPIO',
    servicio: 'Serv_Mpio_MGN_2025/FeatureServer/317',
    campoCodigo: 'mpio_cdpmp',
    campoNombre: 'mpio_cnmbre',
    /** El código de departamento, para colgar el municipio de su padre. */
    campoPadre: 'dpto_ccdgo',
    esperados: 1122,
  },
];

/**
 * Cuántas entidades se piden por petición.
 *
 * Eran cien —cerca de un mega por respuesta— y el servicio del DANE cortó la
 * conexión a mitad de descarga dos veces de tres. Cincuenta son medio mega:
 * más peticiones, cada una menos tiempo expuesta a que el socket se caiga, y
 * una que falle cuesta la mitad reintentarla.
 */
const POR_PAGINA = 50;

const argumentos = process.argv.slice(2);
const tolerancia = (() => {
  const puesta = argumentos.find((a) => a.startsWith('--tolerancia='));
  return puesta ? Number(puesta.split('=')[1]) : 0.0002;
})();

if (!Number.isFinite(tolerancia) || tolerancia < 0) {
  console.error('--tolerancia debe ser un número de grados mayor o igual a 0.');
  process.exit(1);
}

const conDepartamentos = argumentos.includes('--con-departamentos');

/**
 * Asignarles zona a los reportes que ya estaban en la base.
 *
 * El trigger resuelve la zona al insertar y al mover el punto, no hacia atrás:
 * los reportes que entraron cuando `lugares` estaba vacía se quedan con
 * `lugar_id` en NULL para siempre, y el panel de «Zonas» los ignora.
 *
 * Va detrás de una bandera y no por omisión porque escribe sobre reportes de
 * personas reales. Es una escritura inocua —solo rellena lo que está en NULL, y
 * `lugar_id` no alimenta el índice de prioridad ni ninguna decisión— pero
 * «inocuo» lo decide quien administra el despliegue, no este script.
 */
const soloZonas = argumentos.includes('--solo-zonas');
const asignarZonas = soloZonas || argumentos.includes('--asignar-zonas');

/**
 * Cargar solo la población, sin volver a bajar la geometría.
 *
 * Es el caso normal después de la primera carga: la geometría de los municipios
 * no cambia entre censos, la población sí. Y la diferencia de costo es enorme —
 * la población son 1.122 filas sin geometría, unos pocos kilobytes contra los
 * 10 MB de los polígonos.
 */
const soloPoblacion = argumentos.includes('--solo-poblacion');

/**
 * Los niveles que se van a cargar de verdad.
 *
 * Sin `--con-departamentos` se carga solo el municipio: es el nivel que hace
 * útil el panel de «Zonas» y el único que resuelve sin ambigüedad (ver la nota
 * de la cabecera sobre Bogotá).
 */
const aCargar =
  soloZonas || soloPoblacion
    ? // Ni `--solo-zonas` ni `--solo-poblacion` bajan geometría. Son operaciones
      // independientes de la carga, y juntarlas obligaba a bajar 10 MB para hacer
      // un UPDATE — y a exponerse a que la descarga falle en algo que no la
      // necesita.
      []
    : conDepartamentos
      ? NIVELES
      : NIVELES.filter((n) => n.tipo === 'MUNICIPIO');

/** La población se carga siempre, salvo cuando se pidió expresamente otra cosa. */
const conPoblacion = soloPoblacion || !soloZonas;

/**
 * De dónde sale la población.
 *
 * `stp27_pers` del MGN integrado con el censo de 2018. El nombre del campo no
 * dice nada, así que se verificó contra cifras conocidas antes de confiar en él:
 * Bogotá da 7 181 469, que es exactamente el dato publicado del CNPV 2018, y
 * coincide con la suma de la población por sexo (`stp32_1_se + stp32_2_se`) en
 * todos los municipios probados. Dos vías independientes al mismo número.
 */
const POBLACION = {
  servicio: 'MGN_INTEGRADO_CNPV2018_gdb/FeatureServer/4',
  campoCodigo: 'mpio_cdpmp',
  campoPoblacion: 'stp27_pers',
  anio: 2018,
};

if (conDepartamentos) {
  console.warn(
    'Aviso: con los dos niveles, un reporte de Bogotá puede resolver al\n' +
      'departamento 11 o al municipio 11001 —misma área, empate en el trigger—\n' +
      'y el panel de «Zonas» puede partir Bogotá en dos filas del mismo nombre.\n',
  );
}

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL no está definida. ¿Falta el .env?');
  process.exit(1);
}

/**
 * Cuántas veces se reintenta una página antes de rendirse, y cuánto se espera.
 *
 * La primera versión de este script no reintentaba, y la primera corrida real
 * murió con `fetch failed` en el municipio 500 de 1.122. Bajar el país entero
 * son doce peticiones de casi un mega contra un servicio público: que una se
 * caiga no es la excepción, es lo esperable. Y rendirse a la mitad obliga a
 * empezar de cero, que es la peor reacción posible a un error pasajero.
 *
 * Las esperas crecen —1 s, 2 s, 4 s, 8 s— porque si el servicio está saturado,
 * insistir de inmediato es parte del problema.
 */
const REINTENTOS = 4;
/**
 * Tiempo límite por petición. Generoso a propósito.
 *
 * Una petición colgada es peor que una fallida —la fallida se reintenta— pero
 * abortar mientras se lee el cuerpo es lo que dispara la aserción interna de
 * undici que mata el proceso. Con páginas de cincuenta entidades, dos minutos
 * son de sobra para cualquier respuesta legítima, así que este límite solo salta
 * cuando de verdad no hay nada del otro lado.
 */
const LIMITE_MS = 120_000;

const esperar = (ms) => new Promise((listo) => setTimeout(listo, ms));

/** El motivo real detrás del `fetch failed` de Node, que por sí solo no dice nada. */
function motivo(error) {
  const causa = error?.cause;
  const detalle = causa?.code ?? causa?.message;
  return detalle ? `${error.message} (${detalle})` : String(error?.message ?? error);
}

/** Una página del servicio, en GeoJSON y ya en WGS84. */
async function pedirPagina(nivel, desde) {
  const parametros = new URLSearchParams({
    where: '1=1',
    outFields: [nivel.campoCodigo, nivel.campoNombre, nivel.campoPadre].filter(Boolean).join(','),
    // Sin un orden explícito la paginación del servicio no es estable y se
    // pueden repetir o perder entidades entre páginas.
    orderByFields: nivel.campoCodigo,
    resultOffset: String(desde),
    resultRecordCount: String(POR_PAGINA),
    outSR: '4326',
    maxAllowableOffset: String(tolerancia),
    f: 'geojson',
  });

  const respuesta = await fetch(`${RAIZ}/${nivel.servicio}/query?${parametros}`, {
    signal: AbortSignal.timeout(LIMITE_MS),
  });
  if (!respuesta.ok) {
    throw new Error(`El servicio del DANE respondió HTTP ${respuesta.status} (${nivel.tipo})`);
  }

  const cuerpo = await respuesta.json();
  // ArcGIS contesta 200 con un objeto de error adentro, así que el estado HTTP
  // no basta para saber si salió bien.
  if (cuerpo.error) {
    // Se marca como definitivo: un error del propio servicio —una consulta mal
    // formada, una capa que ya no existe— va a contestar lo mismo cuatro veces.
    const fallo = new Error(`El servicio del DANE falló: ${cuerpo.error.message ?? 'sin detalle'}`);
    fallo.definitivo = true;
    throw fallo;
  }
  return cuerpo.features ?? [];
}

/** La misma página, insistiendo mientras el fallo pueda ser pasajero. */
async function pedirPaginaConReintentos(nivel, desde) {
  for (let intento = 1; ; intento++) {
    try {
      return await pedirPagina(nivel, desde);
    } catch (error) {
      if (error.definitivo || intento > REINTENTOS) throw error;
      const espera = 1000 * 2 ** (intento - 1);
      // El aviso va a stderr para no ensuciar la línea de progreso, y se dice en
      // vez de callarse: una descarga que tardó el triple por reintentos es un
      // dato sobre el servicio, no ruido.
      console.error(
        `\n  reintento ${intento}/${REINTENTOS} en ${espera / 1000}s ` +
          `(${nivel.tipo} desde ${desde}): ${motivo(error)}`,
      );
      await esperar(espera);
    }
  }
}

async function descargar(nivel) {
  const entidades = [];
  for (let desde = 0; ; desde += POR_PAGINA) {
    const pagina = await pedirPaginaConReintentos(nivel, desde);
    entidades.push(...pagina);
    process.stdout.write(`\r  ${nivel.tipo}: ${entidades.length}`);
    if (pagina.length < POR_PAGINA) break;
  }
  process.stdout.write('\n');
  return entidades;
}

/**
 * La población de cada municipio, sin geometría.
 *
 * `returnGeometry=false` es lo que hace que esto sea barato: son 1.122 filas de
 * dos campos, unos pocos kilobytes, frente a los 10 MB de los polígonos. Cabe en
 * tres peticiones y casi no está expuesto a que el socket se caiga.
 */
async function descargarPoblacion() {
  const POR_PAGINA_SIN_GEOM = 500;
  const porCodigo = new Map();

  for (let desde = 0; ; desde += POR_PAGINA_SIN_GEOM) {
    const parametros = new URLSearchParams({
      where: '1=1',
      outFields: `${POBLACION.campoCodigo},${POBLACION.campoPoblacion}`,
      orderByFields: POBLACION.campoCodigo,
      resultOffset: String(desde),
      resultRecordCount: String(POR_PAGINA_SIN_GEOM),
      returnGeometry: 'false',
      f: 'json',
    });

    let cuerpo;
    for (let intento = 1; ; intento++) {
      try {
        const respuesta = await fetch(`${RAIZ}/${POBLACION.servicio}/query?${parametros}`, {
          signal: AbortSignal.timeout(LIMITE_MS),
        });
        if (!respuesta.ok) throw new Error(`HTTP ${respuesta.status}`);
        cuerpo = await respuesta.json();
        if (cuerpo.error) {
          const fallo = new Error(cuerpo.error.message ?? 'sin detalle');
          fallo.definitivo = true;
          throw fallo;
        }
        break;
      } catch (error) {
        if (error.definitivo || intento > REINTENTOS) throw error;
        const espera = 1000 * 2 ** (intento - 1);
        console.error(`\n  reintento ${intento}/${REINTENTOS} en ${espera / 1000}s: ${motivo(error)}`);
        await esperar(espera);
      }
    }

    const filas = cuerpo.features ?? [];
    for (const fila of filas) {
      const codigo = fila.attributes?.[POBLACION.campoCodigo];
      const habitantes = fila.attributes?.[POBLACION.campoPoblacion];
      // Un municipio sin dato se deja sin población: NULL significa «no se sabe»
      // y es distinto de cero, que significaría que no vive nadie.
      if (codigo && Number.isFinite(habitantes)) porCodigo.set(codigo, Math.round(habitantes));
    }

    process.stdout.write(`\r  POBLACIÓN: ${porCodigo.size}`);
    if (filas.length < POR_PAGINA_SIN_GEOM) break;
  }
  process.stdout.write('\n');
  return porCodigo;
}

// ---------------------------------------------------------------- descarga

/**
 * La aserción interna de undici, que no se puede atrapar con try.
 *
 * Cuando el servicio corta el socket TLS a mitad de una respuesta —o cuando el
 * `AbortSignal` la interrumpe mientras se lee el cuerpo—, el `fetch` de Node no
 * lanza un error normal: falla un `assert` dentro de undici, de forma asíncrona,
 * fuera de cualquier `try`. El proceso se muere con un volcado de pila que habla
 * de `this.paused` y no dice nada de lo que estaba pasando.
 *
 * No se puede seguir después de eso —el estado interno de la librería quedó
 * roto— pero sí se puede explicar y decir que no se escribió nada, que es la
 * única pregunta que importa cuando algo se cae a la mitad.
 */
process.on('uncaughtException', (error) => {
  // Se distingue la aserción de undici de un error de programación. Tratar
  // cualquier excepción como «fallo de red» sería mentir en el caso que más
  // importa: cuando el que está roto es este script.
  const esCorteDeRed =
    error?.code === 'ERR_ASSERTION' && /paused|undici/i.test(String(error?.stack ?? error));

  if (!esCorteDeRed) {
    console.error('\nFALLO no previsto:', error);
    process.exit(1);
  }

  console.error(`\nLa descarga se cortó por un fallo interno de red: ${motivo(error)}`);
  console.error('No se escribió nada. Volver a correrlo empieza de cero sin dejar rastro.');
  console.error('Si se repite, ya están cargados los municipios: use --solo-zonas.');
  process.exit(1);
});

if (aCargar.length > 0) {
  console.log(
    `Bajando la geografía del MGN (tolerancia ${tolerancia} grados ≈ ${Math.round(tolerancia * 111_320)} m)…`,
  );
} else if (conPoblacion) {
  console.log('Bajando solo la población del censo (sin geometría)…');
}

const porNivel = new Map();
let poblacionPorCodigo = new Map();
try {
  for (const nivel of aCargar) porNivel.set(nivel.tipo, await descargar(nivel));
  if (conPoblacion) poblacionPorCodigo = await descargarPoblacion();
} catch (error) {
  console.error(`\nFALLO bajando los datos: ${motivo(error)}`);
  console.error('No se escribió nada: la validación y la carga van después de bajar todo.');
  console.error('Si fue un tropiezo de red, volver a correrlo empieza de nuevo sin dejar rastro.');
  process.exit(1);
}

// Se valida todo antes de escribir nada, por lo mismo que en cargar-recursos:
// media geografía cargada es peor que ninguna, porque unos reportes resolverían
// su zona y otros no, y la diferencia no se vería en ninguna parte.
const problemas = [];
for (const nivel of aCargar) {
  const entidades = porNivel.get(nivel.tipo);

  if (entidades.length !== nivel.esperados) {
    problemas.push(
      `${nivel.tipo}: llegaron ${entidades.length} y se esperaban ${nivel.esperados}. ` +
        'Si el DANE publicó una versión nueva del MGN, actualice «esperados» a conciencia.',
    );
  }

  const codigos = new Set();
  entidades.forEach((e, i) => {
    const codigo = e.properties?.[nivel.campoCodigo];
    const nombre = e.properties?.[nivel.campoNombre];
    const donde = `${nivel.tipo} ${i + 1}${codigo ? ` (${codigo})` : ''}`;

    if (!codigo) problemas.push(`${donde}: sin código DIVIPOLA`);
    else if (codigos.has(codigo)) problemas.push(`${donde}: código repetido`);
    else codigos.add(codigo);

    if (!nombre?.trim()) problemas.push(`${donde}: sin nombre`);
    if (!e.geometry) problemas.push(`${donde}: sin geometría`);
    else if (e.geometry.type !== 'Polygon' && e.geometry.type !== 'MultiPolygon') {
      problemas.push(`${donde}: geometría ${e.geometry.type}, se esperaba un polígono`);
    }
  });
}

// Todo municipio tiene que poder colgarse de un departamento cargado. Solo
// aplica cuando se piden los dos niveles: sin departamentos no hay padre que
// resolver y `padre_id` queda en NULL, que es válido.
if (conDepartamentos) {
  const codigosDepartamento = new Set(
    porNivel.get('DEPARTAMENTO').map((e) => e.properties.dpto_ccdgo),
  );
  for (const municipio of porNivel.get('MUNICIPIO')) {
    const padre = municipio.properties.dpto_ccdgo;
    if (!codigosDepartamento.has(padre)) {
      problemas.push(
        `MUNICIPIO ${municipio.properties.mpio_cdpmp}: su departamento ${padre} no vino en la descarga`,
      );
    }
  }
}

if (problemas.length > 0) {
  console.error('\nNo se cargó nada. Problemas encontrados:\n');
  problemas.slice(0, 20).forEach((p) => console.error('  ·', p));
  if (problemas.length > 20) console.error(`  … y ${problemas.length - 20} más`);
  process.exit(1);
}

// ----------------------------------------------------------------- escritura

const cliente = new pg.Client({ connectionString: process.env.DATABASE_URL });

// El `connect` va en su propio try: si falla, lo que se necesita es una línea que
// diga qué pasó, no un volcado de pila de pg-protocol. `npm run bd:probar-conexion`
// traduce los tres errores típicos con detalle.
try {
  await cliente.connect();
} catch (error) {
  console.error(
    '\nNo se pudo conectar a la base:',
    error instanceof Error ? error.message : error,
  );
  console.error('Los datos ya se bajaron y se validaron; no se escribió nada.');
  console.error('Para diagnosticar la conexión: npm run bd:probar-conexion');
  process.exit(1);
}

/** Cuántas entidades por INSERT. Cada una lleva su geometría, así que el lote
 *  se mide en megas y no en filas. */
const TAMANO_LOTE = 25;

let creados = 0;
let actualizados = 0;

try {
  /** Código DIVIPOLA → id en la base, para resolver `padre_id`. */
  const idPorCodigo = new Map();

  for (const nivel of aCargar) {
    const entidades = porNivel.get(nivel.tipo);

    for (let i = 0; i < entidades.length; i += TAMANO_LOTE) {
      const lote = entidades.slice(i, i + TAMANO_LOTE);

      const valores = [];
      const parametros = [];
      lote.forEach((e, j) => {
        const b = j * 4;
        /**
         * La cadena de saneamiento de la geometría, de adentro hacia afuera:
         *
         *   · `ST_SetSRID` porque `ST_GeomFromGeoJSON` no asume 4326 y sin SRID
         *     el casteo a geography falla.
         *   · `ST_MakeValid` porque la simplificación del servidor puede dejar
         *     anillos que se cruzan, y PostGIS los rechaza al indexar.
         *   · `ST_CollectionExtract(…, 3)` porque `ST_MakeValid` puede devolver
         *     una colección con líneas o puntos sueltos; solo interesan las
         *     áreas.
         *   · `ST_Multi` porque la columna es MultiPolygon y el servicio manda
         *     Polygon cuando la entidad es de una sola pieza.
         */
        valores.push(
          `($${b + 1}, $${b + 2}::tipo_lugar, $${b + 3}, ` +
            `ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($${b + 4}), 4326)), 3))::geography)`,
        );
        parametros.push(
          e.properties[nivel.campoNombre].trim(),
          nivel.tipo,
          e.properties[nivel.campoCodigo],
          JSON.stringify(e.geometry),
        );
      });

      const { rows } = await cliente.query(
        `INSERT INTO lugares (nombre, tipo, codigo, geom)
         VALUES ${valores.join(', ')}
         ON CONFLICT (codigo) WHERE codigo IS NOT NULL DO UPDATE
            SET nombre = excluded.nombre,
                tipo = excluded.tipo,
                geom = excluded.geom
         RETURNING id, codigo, (xmax = 0) AS es_nuevo`,
        parametros,
      );

      for (const fila of rows) {
        idPorCodigo.set(fila.codigo, fila.id);
        fila.es_nuevo ? creados++ : actualizados++;
      }
      process.stdout.write(`\r  ${nivel.tipo}: ${Math.min(i + TAMANO_LOTE, entidades.length)}/${entidades.length}`);
    }
    process.stdout.write('\n');

    // Los padres se cuelgan después de insertar el nivel, en una sola consulta:
    // así el INSERT no necesita saber en qué orden llegaron las filas.
    if (nivel.campoPadre && conDepartamentos) {
      const codigos = [];
      const padres = [];
      for (const e of entidades) {
        const idPadre = idPorCodigo.get(e.properties[nivel.campoPadre]);
        if (idPadre) {
          codigos.push(e.properties[nivel.campoCodigo]);
          padres.push(idPadre);
        }
      }
      await cliente.query(
        `UPDATE lugares AS l
            SET padre_id = d.padre::uuid
           FROM unnest($1::text[], $2::text[]) AS d(codigo, padre)
          WHERE l.codigo = d.codigo`,
        [codigos, padres],
      );
      console.log(`  ${nivel.tipo}: ${codigos.length} colgados de su departamento`);
    }
  }

  // ------------------------------------------------------------- población
  if (poblacionPorCodigo.size > 0) {
    const codigos = [...poblacionPorCodigo.keys()];
    const habitantes = [...poblacionPorCodigo.values()];

    const { rowCount } = await cliente.query(
      `UPDATE lugares AS l
          SET poblacion = p.habitantes,
              poblacion_anio = $3
         FROM unnest($1::text[], $2::int[]) AS p(codigo, habitantes)
        WHERE l.codigo = p.codigo`,
      [codigos, habitantes, POBLACION.anio],
    );
    console.log(`  POBLACIÓN: ${rowCount} lugar(es) con población del censo ${POBLACION.anio}`);
  }

  const { rows: resumen } = await cliente.query(
    `SELECT tipo::text, count(*)::int AS n,
            count(padre_id)::int AS con_padre,
            round(avg(ST_NPoints(geom::geometry)))::int AS vertices_promedio
       FROM lugares GROUP BY tipo ORDER BY tipo`,
  );

  console.log(`\nCreados: ${creados} · actualizados: ${actualizados}\n`);
  console.log('Lugares en la base:');
  resumen.forEach((f) =>
    console.log(
      `  · ${f.tipo.padEnd(13)} ${String(f.n).padStart(5)}   con padre: ${String(f.con_padre).padStart(5)}   vértices promedio: ${f.vertices_promedio}`,
    ),
  );

  /**
   * Los reportes que ya estaban en la base no tienen zona: el trigger solo
   * resuelve al insertar y al mover el punto. Se dice, en vez de dejar creer que
   * la carga los arregló sola.
   */
  const { rows: pendientes } = await cliente.query(
    `SELECT count(*)::int AS n FROM reportes WHERE lugar_id IS NULL`,
  );

  if (pendientes[0].n === 0) {
    console.log('\nTodos los reportes tienen zona.');
  } else if (!asignarZonas) {
    console.log(
      `\n${pendientes[0].n} reporte(s) ya existentes siguen sin zona: el trigger la resuelve` +
        '\nal insertar, no hacia atrás. Para asignárselas, con esta misma orden:' +
        '\n\n  node --env-file-if-exists=.env scripts/cargar-lugares.mjs --asignar-zonas',
    );
  } else {
    /**
     * La misma consulta del trigger, palabra por palabra.
     *
     * Que sea idéntica es el punto: si acá se escribiera otra cosa, un reporte
     * viejo y uno nuevo del mismo sitio podrían acabar en zonas distintas y
     * nadie lo notaría. Si el trigger cambia, esto tiene que cambiar con él.
     */
    const { rowCount } = await cliente.query(
      `UPDATE reportes r
          SET lugar_id = (
                SELECT l.id
                  FROM lugares l
                 WHERE ST_Intersects(l.geom, r.geom)
                 ORDER BY ST_Area(l.geom) ASC
                 LIMIT 1)
        WHERE r.lugar_id IS NULL
          AND EXISTS (SELECT 1 FROM lugares l WHERE ST_Intersects(l.geom, r.geom))`,
      [],
    );

    const { rows: restantes } = await cliente.query(
      `SELECT count(*)::int AS n FROM reportes WHERE lugar_id IS NULL`,
    );

    console.log(`\nZonas asignadas a ${rowCount} reporte(s) que no la tenían.`);
    if (restantes[0].n > 0) {
      // Un reporte fuera de todo polígono: coordenadas en el mar, o en una
      // rendija que dejó la generalización. Se dice cuántos, porque cero y tres
      // significan cosas distintas.
      console.log(
        `${restantes[0].n} siguen sin zona: su punto no cae dentro de ningún municipio cargado.`,
      );
    }

    const { rows: porZona } = await cliente.query(
      `SELECT l.nombre, count(*)::int AS n
         FROM reportes r JOIN lugares l ON l.id = r.lugar_id
        GROUP BY l.nombre ORDER BY n DESC, l.nombre LIMIT 10`,
    );
    if (porZona.length > 0) {
      console.log('\nReportes por zona:');
      porZona.forEach((f) => console.log(`  · ${f.nombre.padEnd(28)} ${f.n}`));
    }
  }
} catch (error) {
  console.error('\nFALLO:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await cliente.end();
}
