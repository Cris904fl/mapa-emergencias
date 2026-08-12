import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import limiteTasa from '@fastify/rate-limit';
import { config } from './config.ts';
import { ErrorHttp } from './lib/errores.ts';
import type { Sesion } from './lib/auth.ts';
import { rutasSalud } from './rutas/salud.ts';
import { rutasSesion } from './rutas/sesion.ts';
import { rutasReportes } from './rutas/reportes.ts';
import { rutasRecursos } from './rutas/recursos.ts';
import { rutasTablero } from './rutas/tablero.ts';
import { rutasCampo } from './rutas/campo.ts';

declare module 'fastify' {
  interface FastifyRequest {
    /** Sesión del portador del token, o null si la petición es anónima. */
    sesion: Sesion | null;
  }
}

export async function construirApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.LOG_NIVEL,
      // Nunca registrar el cuerpo de un reporte completo: lleva descripciones
      // con datos de personas concretas y datos de contacto.
      redact: ['req.headers.authorization', 'req.body.contacto_reportante'],
    },
    // Confía en X-Forwarded-* : detrás de un proxy es lo que permite que el
    // límite de tasa cuente la IP real y no la del proxy.
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
  });

  await app.register(cors, {
    origin: true,
    credentials: true,
  });

  await app.register(jwt, { secret: config.JWT_SECRETO });

  await app.register(multipart, {
    limits: {
      // 12 MB por archivo: una foto de celular reducida a 1568 px cabe de
      // sobra, y el tope evita que un video largo bloquee la subida en una red
      // que apenas funciona.
      fileSize: 12 * 1024 * 1024,
      files: 1,
    },
  });

  /**
   * Límite de tasa.
   *
   * El alta de reportes queda abierta sin autenticación, así que este es el
   * único freno contra abuso. Se calibra generoso a propósito: durante una
   * emergencia real varias personas del mismo barrio comparten la misma IP de
   * salida —un wifi comunitario, una antena— y bloquearlas por reportar
   * demasiado sería el peor error posible.
   */
  await app.register(limiteTasa, {
    max: 120,
    timeWindow: '1 minute',
    // Sondas de salud fuera del conteo: las llama el balanceador.
    allowList: (peticion) => peticion.url === '/salud' || peticion.url === '/listo',
    errorResponseBuilder: (_peticion, contexto) => ({
      error: 'demasiadas_peticiones',
      mensaje: `Límite de ${contexto.max} peticiones por minuto alcanzado. Reintente en ${Math.ceil(contexto.ttl / 1000)} s.`,
    }),
  });

  /**
   * Autenticación opcional en todas las rutas.
   *
   * Se resuelve la sesión si viene un token válido y se sigue si no: las rutas
   * que exigen personal operativo lo verifican ellas mismas con puedeOperar().
   * Un token vencido o corrupto no aborta la petición — un ciudadano con una
   * sesión caducada en el navegador tiene que poder reportar igual.
   */
  app.decorateRequest('sesion', null);

  app.addHook('onRequest', async (peticion) => {
    const cabecera = peticion.headers.authorization;
    if (!cabecera?.startsWith('Bearer ')) return;

    try {
      peticion.sesion = await peticion.jwtVerify<Sesion>();
    } catch {
      peticion.sesion = null;
    }
  });

  // ------------------------------------------------------------------------
  // Manejo de errores
  // ------------------------------------------------------------------------
  app.setErrorHandler((error: FastifyError, peticion, respuesta) => {
    if (error instanceof ErrorHttp) {
      // Errores esperados: se responden sin ruido en los registros.
      peticion.log.debug({ codigo: error.codigo, url: peticion.url }, error.message);
      return respuesta.code(error.estado).send({
        error: error.codigo,
        mensaje: error.message,
        ...(error.detalles ? { detalles: error.detalles } : {}),
      });
    }

    if (error.statusCode === 429) {
      return respuesta.send(error);
    }

    // Cuerpo demasiado grande o JSON malformado: los reporta Fastify.
    if (error.statusCode && error.statusCode < 500) {
      return respuesta.code(error.statusCode).send({
        error: 'solicitud_invalida',
        mensaje: error.message,
      });
    }

    peticion.log.error({ err: error, url: peticion.url }, 'Error no manejado');
    return respuesta.code(500).send({
      error: 'error_interno',
      mensaje: 'Ocurrió un error procesando la petición',
    });
  });

  app.setNotFoundHandler((peticion, respuesta) =>
    respuesta.code(404).send({
      error: 'ruta_no_encontrada',
      mensaje: `No existe ${peticion.method} ${peticion.url}`,
    }),
  );

  // ------------------------------------------------------------------------
  // Rutas
  // ------------------------------------------------------------------------
  await app.register(rutasSalud);
  await app.register(rutasSesion);
  await app.register(rutasReportes);
  await app.register(rutasRecursos);
  await app.register(rutasTablero);
  await app.register(rutasCampo);

  return app;
}
