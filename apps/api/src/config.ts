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

  /**
   * Puerto de escucha.
   *
   * `PORT` gana sobre `API_PUERTO` porque es lo que inyectan los hospedajes
   * (Render, Koyeb, Fly) y no se puede cambiar desde su panel. Sin esto el
   * despliegue parece exitoso —el proceso arranca y no se queja— pero la
   * plataforma enruta a un puerto donde no hay nadie escuchando, y el síntoma
   * es un 502 sin una sola línea de error en los registros.
   */
  API_PUERTO: z.coerce.number().int().positive().default(3010),
  API_HOST: z.string().default('0.0.0.0'),
  LOG_NIVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  JWT_SECRETO: z.string().min(16, 'JWT_SECRETO debe tener al menos 16 caracteres'),

  ALMACEN_MEDIOS: z.string().default('./almacen'),

  /**
   * Almacenamiento de objetos para fotos, video y audio.
   *
   * Con las tres puestas, los medios van a Supabase Storage; sin ellas, a
   * disco. Hace falta en cualquier hospedaje con disco efímero: en la capa
   * gratuita de Render el sistema de archivos se borra en cada redespliegue y
   * cada vez que la instancia hiberna, así que las fotos se perdían solas.
   *
   * `SUPABASE_CLAVE_SERVICIO` es la clave de rol de servicio del proyecto:
   * salta las políticas de acceso, así que va como variable secreta y nunca en
   * el repositorio.
   */
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_CLAVE_SERVICIO: z.string().min(20).optional(),
  SUPABASE_BUCKET: z.string().default('medios-reportes'),

  /**
   * Notificaciones push a quien reportó.
   *
   * Sin las tres, la función queda apagada y todo lo demás sigue igual: es una
   * comodidad, no un requisito para recibir un pedido de auxilio.
   *
   * Las claves VAPID identifican a este servidor ante los servicios de push de
   * los fabricantes. **Cambiarlas invalida todas las suscripciones existentes**,
   * así que se generan una vez y se conservan.
   */
  VAPID_CLAVE_PUBLICA: z.string().min(40).optional(),
  VAPID_CLAVE_PRIVADA: z.string().min(20).optional(),
  /** Correo de contacto que exige el estándar, por si un servicio necesita avisar. */
  VAPID_CONTACTO: z.string().default('mailto:soporte@example.org'),

  /**
   * Secreto para la ruta de mantenimiento que refresca prioridades.
   *
   * Solo hace falta en un despliegue sin Redis, donde un cron externo reemplaza
   * al trabajador de BullMQ. Sin él la ruta responde 400 y queda inutilizable,
   * que es el comportamiento correcto: mejor apagada que abierta.
   */
  SECRETO_MANTENIMIENTO: z.string().min(16).optional(),

  /**
   * Permiso explícito para sembrar datos de prueba en una base que no es local.
   *
   * Se pone el **anfitrión exacto** que se quiere sembrar, no un `true`: una
   * bandera booleana se copia una vez al `.env` y se queda puesta, y entonces la
   * salvaguarda deja de proteger justo cuando hace falta. Ver `db/sembrar.ts`.
   */
  SEMBRAR_ANFITRION: z.string().optional(),

  // La IA es opcional a propósito. Con IA_PROVEEDOR en 'ninguno' la API acepta
  // reportes igual y simplemente no los enriquece: la extracción automática es
  // una comodidad, no un requisito para recibir un pedido de auxilio.
  //
  //   ollama     → modelo local, gratis, los datos no salen de la máquina
  //   compatible → cualquier API con forma OpenAI (Groq, OpenRouter, vLLM…)
  //   anthropic  → API de Anthropic
  IA_PROVEEDOR: z.enum(['ninguno', 'ollama', 'compatible', 'anthropic']).default('ninguno'),

  IA_MODELO: z.string().default('qwen2.5:latest'),
  IA_MAX_TOKENS: z.coerce.number().int().positive().default(600),

  /**
   * Un modelo local en CPU tarda decenas de segundos por reporte. El límite es
   * alto a propósito: la extracción corre en un trabajador en segundo plano, no
   * en el camino de la petición del ciudadano.
   */
  IA_TIEMPO_LIMITE_MS: z.coerce.number().int().positive().default(180_000),

  /**
   * ¿Puede el modelo escribir los campos canónicos del reporte sin que una
   * persona revise?
   *
   * Por defecto NO. La medición sobre qwen2.5:7b en CPU (docs/ia-local.md) dio
   * conteos explícitos correctos y cero cifras inventadas, pero se equivocó en
   * `requiere_rescate` y en distinguir "atrapado" de "se quedó sin vivienda",
   * con confianza ALTA. Esos campos ordenan la cola de rescate. Con esto en
   * false la propuesta se guarda, se muestra en el tablero, y la aplica un
   * operador con un clic.
   */
  IA_APLICAR_AUTOMATICAMENTE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((valor) => valor === 'true'),

  // Ollama
  OLLAMA_URL: z.string().default('http://localhost:11434'),

  // API con forma OpenAI
  IA_URL_COMPATIBLE: z.string().default('https://api.groq.com/openai/v1'),
  IA_CLAVE_COMPATIBLE: z.string().optional(),

  // Anthropic
  ANTHROPIC_API_KEY: z.string().optional(),

  // Píxeles del lado largo a los que la PWA reduce cada foto antes de subirla.
  // Se define acá para que cliente y servidor compartan el mismo número.
  IA_IMAGEN_LADO_MAX: z.coerce.number().int().positive().default(1568),

  /**
   * Motor de ruteo con API de OSRM.
   *
   * El valor por defecto es el servidor de demostración público del proyecto
   * OSRM: no pide clave y sirve para desarrollo, pero su política de uso no
   * permite tráfico de producción. Para algo real hay que levantar un OSRM
   * propio (una imagen Docker y un extracto de OpenStreetMap de Colombia) y
   * apuntar esta variable ahí.
   *
   * Vacío = sin ruteo: la API responde con distancia en línea recta y lo marca
   * como tal, para que la interfaz no presente una estimación como si fuera una
   * ruta.
   */
  RUTEO_URL: z.string().default('https://router.project-osrm.org'),

  /**
   * Distancia a la que un reporte de vía bloqueada se considera un obstáculo
   * sobre la ruta propuesta. 60 m cubre el ancho de una calzada y sus
   * aproximaciones sin marcar como obstáculo todo lo que hay a una cuadra.
   */
  RUTEO_RADIO_OBSTACULO_M: z.coerce.number().int().positive().default(60),
});

const analisis = esquema.safeParse({
  ...process.env,
  // El puerto que inyecta el hospedaje manda sobre el del archivo de entorno.
  API_PUERTO: process.env.PORT ?? process.env.API_PUERTO,
});

if (!analisis.success) {
  const detalles = analisis.error.issues
    .map((problema) => `  · ${problema.path.join('.') || '(raíz)'}: ${problema.message}`)
    .join('\n');
  console.error(`Configuración inválida:\n${detalles}`);
  process.exit(1);
}

export const config = analisis.data;

/** ¿Hay extracción automática configurada en esta instancia? */
export const iaHabilitada = config.IA_PROVEEDOR !== 'ninguno';

// Aviso temprano de una combinación que no va a funcionar: es mejor verlo al
// arrancar que descubrirlo cuando el primer reporte falle en la cola.
if (config.IA_PROVEEDOR === 'anthropic' && !config.ANTHROPIC_API_KEY) {
  console.warn('IA_PROVEEDOR=anthropic pero falta ANTHROPIC_API_KEY: la extracción no va a funcionar.');
}
if (config.IA_PROVEEDOR === 'compatible' && !config.IA_CLAVE_COMPATIBLE) {
  console.warn('IA_PROVEEDOR=compatible pero falta IA_CLAVE_COMPATIBLE: la extracción no va a funcionar.');
}
