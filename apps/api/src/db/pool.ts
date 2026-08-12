import pg from 'pg';
import { config } from '../config.ts';

/**
 * `numeric` de Postgres llega como string al driver para no perder precisión.
 * Para los puntajes y distancias de este dominio (dos decimales, magnitudes
 * pequeñas) el double de JavaScript es exacto de sobra, y devolver números
 * evita que cada consumidor haga parseFloat. Los `bigint` se dejan como string
 * a propósito: `medios_reporte.bytes` puede pasar Number.MAX_SAFE_INTEGER.
 */
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (valor) => Number.parseFloat(valor));

export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (error) => {
  console.error('Error inesperado en un cliente idle del pool', error);
});

export type Consultador = {
  consultar<T extends pg.QueryResultRow = pg.QueryResultRow>(
    sql: string,
    parametros?: unknown[],
  ): Promise<pg.QueryResult<T>>;
};

export const bd: Consultador = {
  consultar: (sql, parametros) => pool.query(sql, parametros as never),
};

/**
 * Ejecuta un bloque dentro de una transacción.
 *
 * `usuarioId` no es decorativo: se publica como variable de sesión
 * `app.usuario_id`, que es de donde el trigger de bitácora saca el autor de
 * cada cambio de estado. Sin esto la bitácora queda con actor NULL y se pierde
 * la trazabilidad de quién movió un reporte en la cola.
 */
export async function enTransaccion<T>(
  trabajo: (cliente: Consultador) => Promise<T>,
  opciones: { usuarioId?: string | null; nota?: string | null } = {},
): Promise<T> {
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');

    if (opciones.usuarioId) {
      // set_config con parámetro, no interpolación: `SET LOCAL` no acepta
      // marcadores de posición y concatenar acá sería inyección de SQL.
      await cliente.query('SELECT set_config($1, $2, true)', ['app.usuario_id', opciones.usuarioId]);
    }
    if (opciones.nota) {
      await cliente.query('SELECT set_config($1, $2, true)', ['app.nota_cambio', opciones.nota]);
    }

    const resultado = await trabajo({
      consultar: (sql, parametros) => cliente.query(sql, parametros as never),
    });

    await cliente.query('COMMIT');
    return resultado;
  } catch (error) {
    await cliente.query('ROLLBACK').catch(() => {
      /* la conexión ya puede estar rota; el error original es el que importa */
    });
    throw error;
  } finally {
    cliente.release();
  }
}

export async function cerrarPool(): Promise<void> {
  await pool.end();
}
