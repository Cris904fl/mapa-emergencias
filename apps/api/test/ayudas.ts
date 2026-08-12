import pg from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.ts';
import { bd, pool } from '../src/db/pool.ts';
import { cerrarColas } from '../src/trabajadores/colas.ts';

/**
 * Utilidades de la suite.
 *
 * Salvaguarda importante: `asegurarBaseDePruebas` se niega a correr si la URL
 * de conexión no apunta a una base cuyo nombre termine en `_test`. La suite
 * trunca tablas, y un error de configuración que la apunte a la base de
 * desarrollo —o peor— borraría datos reales.
 */

const aqui = path.dirname(fileURLToPath(import.meta.url));
const directorioMigraciones = path.resolve(aqui, '../../../db/migrations');

function nombreBaseDeUrl(url: string): string {
  return new URL(url).pathname.replace(/^\//, '');
}

export async function asegurarBaseDePruebas(): Promise<void> {
  const nombre = nombreBaseDeUrl(config.DATABASE_URL);

  if (!nombre.endsWith('_test')) {
    throw new Error(
      `La suite solo corre contra una base cuyo nombre termine en "_test". ` +
        `DATABASE_URL apunta a "${nombre}". Revise .env.pruebas.`,
    );
  }

  // Se crea la base conectándose a `postgres`, que siempre existe.
  const urlAdmin = new URL(config.DATABASE_URL);
  urlAdmin.pathname = '/postgres';

  const admin = new pg.Client({ connectionString: urlAdmin.toString() });
  await admin.connect();
  try {
    const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [nombre]);
    if (rows.length === 0) {
      // El nombre no puede ir como parámetro en CREATE DATABASE; se cita con
      // el identificador escapado. Además ya se validó el sufijo arriba.
      await admin.query(`CREATE DATABASE "${nombre.replace(/"/g, '""')}"`);
    }
  } finally {
    await admin.end();
  }

  await aplicarMigraciones();
}

async function aplicarMigraciones(): Promise<void> {
  const archivos = (await readdir(directorioMigraciones))
    .filter((nombre) => nombre.endsWith('.sql'))
    .sort();

  // Se detecta por una tabla del esquema en lugar de llevar registro: la base
  // de pruebas es desechable y reconstruirla entera es lo más simple.
  const { rows } = await bd.consultar<{ existe: boolean }>(
    `SELECT to_regclass('public.reportes') IS NOT NULL AS existe`,
  );
  if (rows[0]?.existe) return;

  for (const nombre of archivos) {
    const sql = await readFile(path.join(directorioMigraciones, nombre), 'utf8');
    await bd.consultar(sql);
  }
}

/**
 * Deja las tablas de datos vacías, conservando el esquema y la fila activa de
 * pesos_prioridad (que insertó la migración y de la que depende la función de
 * prioridad).
 */
export async function limpiarDatos(): Promise<void> {
  await bd.consultar(`
    TRUNCATE reportes, medios_reporte, extracciones_ia, historial_estado_reporte,
             recursos, lugares, usuarios, organizaciones
      RESTART IDENTITY CASCADE
  `);
}

/**
 * Cierra todo lo que mantiene vivo el bucle de eventos.
 *
 * Las colas van incluidas porque el alta de un reporte abre una conexión a
 * Redis de forma perezosa: sin cerrarla el proceso de pruebas nunca termina, y
 * el síntoma es desconcertante — la suite pasa pero el comando se queda colgado
 * sin imprimir nada si la salida está en una tubería.
 */
export async function cerrar(): Promise<void> {
  await cerrarColas();
  await pool.end();
}

// ---------------------------------------------------------------------------
// Constructores de datos
// ---------------------------------------------------------------------------

let contador = 0;
const siguienteId = () => `id-${++contador}`;

export async function crearRecurso(opciones: {
  nombre?: string;
  tipo?: string;
  estado?: string;
  lat: number;
  lng: number;
}): Promise<string> {
  const { rows } = await bd.consultar<{ id: string }>(
    `INSERT INTO recursos (tipo, nombre, estado, geom)
     VALUES ($1, $2, $3, ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography)
     RETURNING id`,
    [
      opciones.tipo ?? 'EQUIPO_RESCATE',
      opciones.nombre ?? `Recurso ${siguienteId()}`,
      opciones.estado ?? 'DISPONIBLE',
      opciones.lng,
      opciones.lat,
    ],
  );
  return rows[0]!.id;
}

export async function crearLugar(opciones: {
  nombre: string;
  tipo?: string;
  wkt: string;
}): Promise<string> {
  const { rows } = await bd.consultar<{ id: string }>(
    `INSERT INTO lugares (tipo, nombre, geom)
     VALUES ($1, $2, ST_GeomFromText($3, 4326)::geography)
     RETURNING id`,
    [opciones.tipo ?? 'BARRIO', opciones.nombre, opciones.wkt],
  );
  return rows[0]!.id;
}

export type OpcionesReporte = {
  lat: number;
  lng: number;
  categoria?: string;
  severidad?: string;
  atrapadas?: number;
  heridas?: number;
  afectadas?: number;
  fallecidas?: number;
  vulnerables?: number;
  descripcion?: string;
  horasAtras?: number;
  estado?: string;
};

export async function crearReporteDirecto(opciones: OpcionesReporte): Promise<string> {
  const { rows } = await bd.consultar<{ id: string }>(
    `INSERT INTO reportes (
       id_cliente, categoria, severidad, descripcion, geom,
       personas_afectadas, personas_atrapadas, personas_heridas,
       personas_fallecidas, personas_vulnerables, reportado_en
     ) VALUES (
       gen_random_uuid(), $1, $2, $3,
       ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography,
       $6, $7, $8, $9, $10,
       now() - make_interval(hours => $11)
     )
     RETURNING id`,
    [
      opciones.categoria ?? 'OTRO',
      opciones.severidad ?? 'DESCONOCIDA',
      opciones.descripcion ?? null,
      opciones.lng,
      opciones.lat,
      opciones.afectadas ?? 0,
      opciones.atrapadas ?? 0,
      opciones.heridas ?? 0,
      opciones.fallecidas ?? 0,
      opciones.vulnerables ?? 0,
      opciones.horasAtras ?? 0,
    ],
  );
  return rows[0]!.id;
}

export type Calculo = {
  score: number;
  version: number;
  componentes: Record<string, { crudo: number | string; normalizado: number; aporte: number }>;
};

export async function prioridadDe(reporteId: string): Promise<Calculo> {
  const { rows } = await bd.consultar<{ calculo: Calculo }>(
    'SELECT fn_prioridad_reporte($1) AS calculo',
    [reporteId],
  );
  return rows[0]!.calculo;
}
