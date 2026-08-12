import { construirApp } from './app.ts';
import { config, iaHabilitada } from './config.ts';
import { cerrarPool } from './db/pool.ts';
import { cerrarColas } from './trabajadores/colas.ts';

const app = await construirApp();

try {
  await app.listen({ port: config.API_PUERTO, host: config.API_HOST });
  app.log.info(
    {
      puerto: config.API_PUERTO,
      modelo_ia: iaHabilitada ? config.IA_MODELO : 'deshabilitada',
    },
    'API de mapa de emergencias en marcha',
  );
} catch (error) {
  app.log.error(error, 'No se pudo iniciar el servidor');
  process.exit(1);
}

/**
 * Apagado ordenado. Importa más de lo habitual: si el proceso muere en medio de
 * una transacción de alta de reporte, ese pedido de auxilio se pierde sin que
 * nadie lo sepa. Fastify deja de aceptar conexiones nuevas y termina las que
 * están en vuelo antes de cerrar el pool.
 */
let apagando = false;

async function apagar(senal: string): Promise<void> {
  if (apagando) return;
  apagando = true;

  app.log.info({ senal }, 'Apagando');

  const temporizador = setTimeout(() => {
    app.log.error('El apagado ordenado excedió 15 s; saliendo a la fuerza');
    process.exit(1);
  }, 15_000);
  temporizador.unref();

  try {
    await app.close();
    await cerrarColas();
    await cerrarPool();
    clearTimeout(temporizador);
    process.exit(0);
  } catch (error) {
    app.log.error(error, 'Error durante el apagado');
    process.exit(1);
  }
}

process.on('SIGTERM', () => void apagar('SIGTERM'));
process.on('SIGINT', () => void apagar('SIGINT'));

process.on('unhandledRejection', (razon) => {
  app.log.error({ razon }, 'Promesa rechazada sin manejar');
});
