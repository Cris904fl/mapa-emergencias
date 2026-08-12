import { z } from 'zod';

/**
 * Configuración validada al arrancar. Si falta algo esencial el proceso muere
 * de inmediato con un mensaje claro: preferimos eso a descubrir a las 3 de la
 * mañana, en medio de una emergencia, que DATABASE_URL estaba vacía.
 */
const esquema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL es obligatoria'),
  REDIS_URL: z.string().default('redis://localhost:6381'),

  API_PUERTO: z.coerce.number().int().positive().default(3010),
  API_HOST: z.string().default('0.0.0.0'),
  LOG_NIVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  JWT_SECRETO: z.string().min(16, 'JWT_SECRETO debe tener al menos 16 caracteres'),

  ALMACEN_MEDIOS: z.string().default('./almacen'),

  // La IA es opcional a propósito. Sin clave la API acepta reportes igual y
  // simplemente no los enriquece: la extracción automática es una comodidad,
  // no un requisito para recibir un pedido de auxilio.
  ANTHROPIC_API_KEY: z.string().optional(),
  IA_MODELO: z.string().default('claude-opus-5'),
  IA_MAX_TOKENS: z.coerce.number().int().positive().default(2048),
  // Píxeles del lado largo a los que la PWA reduce cada foto antes de subirla.
  // Se define acá para que cliente y servidor compartan el mismo número.
  IA_IMAGEN_LADO_MAX: z.coerce.number().int().positive().default(1568),
});

const analisis = esquema.safeParse(process.env);

if (!analisis.success) {
  const detalles = analisis.error.issues
    .map((problema) => `  · ${problema.path.join('.') || '(raíz)'}: ${problema.message}`)
    .join('\n');
  console.error(`Configuración inválida:\n${detalles}`);
  process.exit(1);
}

export const config = analisis.data;

/** ¿Hay extracción automática disponible en esta instancia? */
export const iaHabilitada = Boolean(config.ANTHROPIC_API_KEY);
