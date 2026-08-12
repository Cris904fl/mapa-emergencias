import { createConnection } from 'node:net';

/**
 * Espera a que PostgreSQL acepte conexiones TCP.
 *
 * Existe porque `docker compose up -d` retorna cuando el contenedor arrancó, no
 * cuando Postgres está listo para atender: correr las migraciones de inmediato
 * falla con "connection refused" una de cada dos veces. Solo se comprueba el
 * puerto, que es suficiente para el caso y no requiere dependencias.
 */

const puerto = Number.parseInt(process.env.POSTGRES_PORT ?? '5434', 10);
const host = process.env.POSTGRES_HOST ?? 'localhost';
const intentosMaximos = 60;
const esperaMs = 1000;

function puertoAbierto() {
  return new Promise((resolver) => {
    const conexion = createConnection({ host, port: puerto });
    const cerrar = (resultado) => {
      conexion.destroy();
      resolver(resultado);
    };
    conexion.setTimeout(2000);
    conexion.once('connect', () => cerrar(true));
    conexion.once('error', () => cerrar(false));
    conexion.once('timeout', () => cerrar(false));
  });
}

for (let intento = 1; intento <= intentosMaximos; intento++) {
  if (await puertoAbierto()) {
    console.log(`PostgreSQL responde en ${host}:${puerto}`);
    process.exit(0);
  }
  if (intento === 1) process.stdout.write(`Esperando a PostgreSQL en ${host}:${puerto}`);
  process.stdout.write('.');
  await new Promise((r) => setTimeout(r, esperaMs));
}

console.error(`\nPostgreSQL no respondió en ${host}:${puerto} tras ${intentosMaximos} s.`);
process.exit(1);
