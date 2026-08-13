/**
 * Cliente de la API para el tablero.
 *
 * El formulario ciudadano NO usa este módulo: escribe en la bandeja local y deja
 * que el sincronizador se encargue. Esa separación es intencional — la ruta que
 * recibe un pedido de auxilio nunca debe depender de que una petición HTTP
 * funcione en el momento.
 */

export class ErrorApi extends Error {
  readonly estado: number;
  readonly codigo: string;

  constructor(estado: number, codigo: string, mensaje: string) {
    super(mensaje);
    this.name = 'ErrorApi';
    this.estado = estado;
    this.codigo = codigo;
  }
}

let token: string | null = localStorage.getItem('emergencias:token');

export function fijarToken(nuevo: string | null): void {
  token = nuevo;
  if (nuevo) localStorage.setItem('emergencias:token', nuevo);
  else localStorage.removeItem('emergencias:token');
}

export function tieneSesion(): boolean {
  return token !== null;
}

async function pedir<T>(ruta: string, opciones: RequestInit = {}): Promise<T> {
  const cabeceras = new Headers(opciones.headers);
  if (!cabeceras.has('content-type') && opciones.body) {
    cabeceras.set('content-type', 'application/json');
  }
  if (token) cabeceras.set('authorization', `Bearer ${token}`);

  const respuesta = await fetch(ruta, { ...opciones, headers: cabeceras });

  if (!respuesta.ok) {
    const cuerpo = (await respuesta.json().catch(() => null)) as
      | { error?: string; mensaje?: string }
      | null;
    throw new ErrorApi(
      respuesta.status,
      cuerpo?.error ?? 'error_desconocido',
      cuerpo?.mensaje ?? `HTTP ${respuesta.status}`,
    );
  }

  return respuesta.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Tipos de respuesta
// ---------------------------------------------------------------------------

export type ComponentePrioridad = {
  crudo: number | string;
  normalizado: number;
  peso: number;
  aporte: number;
  unidad?: string;
};

export type ReporteCola = {
  id: string;
  codigo_publico: string;
  categoria: string;
  severidad: string;
  estado: string;
  descripcion: string | null;
  personas_afectadas: number;
  personas_atrapadas: number;
  personas_heridas: number;
  personas_vulnerables: number;
  requiere_rescate: boolean;
  origen_triage: string;
  reportado_en: string;
  primera_respuesta_en: string | null;
  lugar: string | null;
  lat: number;
  lng: number;
  score: number | null;
  componentes: Record<string, ComponentePrioridad> | null;
};

export type Resumen = {
  reportes: {
    abiertos: number;
    sin_triage: number;
    sin_atender: number;
    criticos: number;
    con_rescate_pendiente: number;
    resueltos: number;
    personas_atrapadas: number;
    personas_heridas: number;
    personas_afectadas: number;
    triados_por_ia: number;
    triados_por_persona: number;
    asignados_estancados: number;
  };
  espera_maxima_minutos: number | null;
  recursos: {
    disponibles: number;
    ocupados: number;
    agotados: number;
    fuera_de_servicio: number;
  };
  generado_en: string;
};

export type Conglomerado = {
  grupo: number;
  reportes: number;
  personas_afectadas: number;
  personas_atrapadas: number;
  prioridad_maxima: number | null;
  codigos: string[];
  categorias: string[];
  lat: number;
  lng: number;
};

export type Zona = {
  lugar_id: string;
  lugar: string;
  tipo_lugar: string;
  reportes_abiertos: number;
  personas_afectadas: number;
  personas_atrapadas: number;
  personas_vulnerables: number;
  con_rescate_pendiente: number;
  criticos: number;
  prioridad_maxima: number | null;
  lat: number;
  lng: number;
};

/** Nombres de filtro, espejo de apps/api/src/esquemas/filtros.ts. */
export type NombreFiltro =
  | 'abiertos'
  | 'criticos'
  | 'atrapadas'
  | 'heridas'
  | 'sin_atender'
  | 'sin_triage'
  | 'rescate'
  | 'ia_sin_revisar'
  | 'sin_responsable'
  | 'estancados'
  | 'resueltos';

/** Espejo de `severidad_reporte` en db/migrations/002_tipos.sql. */
export type Severidad = 'CRITICA' | 'ALTA' | 'MEDIA' | 'BAJA' | 'DESCONOCIDA';

/**
 * Un archivo adjunto a un reporte.
 *
 * `bytes` llega como texto y no como número: es un `bigint` en la base y el
 * driver lo entrega así a propósito (ver HANDOFF §5). Se convierte donde se
 * muestra, no acá.
 *
 * Se omiten `etiquetas_ia`, `modelo_ia` y `analizado_en`, que la API sí
 * devuelve: el etiquetado multimodal nunca se ha ejecutado, así que declarar su
 * forma sería inventarla.
 */
export type Medio = {
  id: string;
  tipo: 'FOTO' | 'VIDEO' | 'AUDIO';
  tipo_mime: string;
  bytes: string;
  capturado_en: string | null;
};

/**
 * Un reporte visto por quien lo hizo, buscado con su código público.
 *
 * Se declara solo lo que la pantalla de consulta necesita: el detalle completo
 * trae mucho más (puntaje, componentes, extracciones de IA) que no tiene por
 * qué mostrarse a un ciudadano preocupado por su caso.
 */
export type CasoConsultado = {
  properties: {
    codigo_publico: string;
    estado: string;
    categoria: string;
    severidad: string;
    descripcion: string | null;
    lugar: string | null;
    reportado_en: string;
    primera_respuesta_en: string | null;
  };
  medios: Medio[];
  historial: {
    estado_nuevo: string;
    estado_anterior: string | null;
    creado_en: string;
    nota: string | null;
    por: string | null;
  }[];
};

export type CasoCampo = {
  id: string;
  codigo_publico: string;
  categoria: string;
  severidad: string;
  estado: string;
  descripcion: string | null;
  personas_afectadas: number;
  personas_atrapadas: number;
  personas_heridas: number;
  personas_vulnerables: number;
  requiere_rescate: boolean;
  contacto_reportante: string | null;
  reportado_en: string;
  prioridad_score: number | null;
  lugar: string | null;
  lat: number;
  lng: number;
  responsable_id: string | null;
  responsable: string | null;
  tomado_en: string | null;
  es_mio: boolean;
  distancia_m: number;
};

export type Obstaculo = {
  id: string;
  codigo_publico: string;
  categoria: string;
  severidad: string;
  lat: number;
  lng: number;
  distancia_a_ruta_m: number;
  metros_desde_origen: number;
  descripcion: string | null;
};

export type RutaCaso = {
  caso: { id: string; codigo_publico: string };
  destino: { lat: number; lng: number };
  tipo: 'vial' | 'linea_recta';
  distancia_m: number;
  duracion_s: number | null;
  geometria: { type: 'LineString'; coordinates: [number, number][] };
  obstaculos: Obstaculo[];
  aviso?: string;
};

/**
 * Personal de socorro con posición conocida.
 *
 * `antiguedad_s` no es un adorno: es la diferencia entre saber dónde está
 * alguien y creer que se sabe. Una posición de hace dos horas dibujada igual
 * que una de hace dos minutos manda equipos a donde ya no hay nadie, así que
 * todo lo que muestre este dato tiene que mostrar también su edad.
 */
export type PersonalCampo = {
  id: string;
  nombre: string;
  rol: string;
  organizacion: string | null;
  lat: number;
  lng: number;
  posicion_precision_m: number | null;
  posicion_en: string;
  antiguedad_s: number;
  casos_abiertos: number;
};

export type ColeccionGeoJson = {
  type: 'FeatureCollection';
  features: {
    id: string;
    type: 'Feature';
    geometry: { type: 'Point'; coordinates: [number, number] };
    properties: Record<string, unknown>;
  }[];
  meta?: { total: number };
};

// ---------------------------------------------------------------------------
// Operaciones
// ---------------------------------------------------------------------------

export const api = {
  iniciarSesion: (correo: string, clave: string) =>
    pedir<{ token: string; usuario: { nombre: string | null; rol: string } }>('/v1/sesion', {
      method: 'POST',
      body: JSON.stringify({ correo, clave }),
    }),

  resumen: () => pedir<Resumen>('/v1/tablero/resumen'),

  cola: (limite = 50, vivo = false, filtro?: NombreFiltro, severidad?: Severidad) =>
    pedir<{
      modo: string;
      filtro: NombreFiltro | null;
      filtro_etiqueta: string | null;
      severidad: Severidad | null;
      total: number;
      reportes: ReporteCola[];
    }>(
      `/v1/tablero/cola?limite=${limite}&vivo=${vivo}` +
        (filtro ? `&filtro=${filtro}` : '') +
        (severidad ? `&severidad=${severidad}` : ''),
    ),

  conglomerados: (radioM = 300) =>
    pedir<{ conglomerados: Conglomerado[] }>(`/v1/tablero/conglomerados?radio_m=${radioM}`),

  zonas: () => pedir<{ zonas: Zona[] }>('/v1/tablero/zonas'),

  aislados: (umbralM = 5000) =>
    pedir<{ reportes: ReporteCola[] }>(`/v1/tablero/aislados?umbral_m=${umbralM}`),

  reportesGeoJson: (filtro?: NombreFiltro, severidad?: Severidad) =>
    pedir<ColeccionGeoJson>(
      `/v1/reportes?limite=500` +
        (filtro ? `&filtro=${filtro}` : '') +
        (severidad ? `&severidad=${severidad}` : ''),
    ),

  recursosGeoJson: () => pedir<ColeccionGeoJson>('/v1/recursos'),

  // ---- Notificaciones ----

  clavePublicaNotificaciones: () =>
    pedir<{ habilitadas: boolean; clave: string | null }>('/v1/notificaciones/clave-publica'),

  suscribirNotificaciones: (cuerpo: {
    codigo: string;
    endpoint: string;
    claves: { p256dh: string; auth: string };
  }) =>
    pedir<{ suscrito: boolean }>('/v1/notificaciones/suscribir', {
      method: 'POST',
      body: JSON.stringify(cuerpo),
    }),

  /**
   * Consulta de un caso por su código público.
   *
   * Es la contraparte de la promesa que la app hace al confirmar un reporte
   * («anótelo, con ese código puede preguntar por su caso»). El código se
   * normaliza acá —mayúsculas, sin espacios— porque quien lo escribe lo copió
   * a mano de una pantalla, a veces con afán.
   */
  consultarPorCodigo: (codigo: string) =>
    pedir<CasoConsultado>(
      `/v1/reportes/codigo/${encodeURIComponent(codigo.trim().toUpperCase())}`,
    ),

  /**
   * Los archivos de un reporte, por su id.
   *
   * Existe para la vista de campo: `GET /v1/campo/casos` sale de
   * `v_casos_campo`, que no trae los medios, y agregárselos obligaría a que cada
   * consulta de la cola cargara la lista de archivos de veinte reportes para
   * mostrar los de uno. Se pide el detalle solo del caso que se va a mirar.
   *
   * Devuelve solo `medios` de todo el detalle: es lo único que hace falta y
   * declarar el resto sería declarar lo que no se usa.
   */
  mediosDelReporte: (id: string) =>
    pedir<{ medios: Medio[] }>(`/v1/reportes/${encodeURIComponent(id)}`).then((r) => r.medios),

  cambiarEstado: (id: string, estado: string, nota?: string) =>
    pedir<Record<string, unknown>>(`/v1/reportes/${id}/estado`, {
      method: 'PATCH',
      body: JSON.stringify({ estado, nota }),
    }),

  triarConIa: (id: string) =>
    pedir<{ estado: string; motivo?: string; camposActualizados?: string[] }>(
      `/v1/reportes/${id}/triage-ia`,
      { method: 'POST' },
    ),

  estadoServidor: () =>
    pedir<{ estado: string; comprobaciones: Record<string, { ok: boolean; detalle?: string }> }>(
      '/listo',
    ),

  // ---- Campo ----

  reportarPosicion: (lat: number, lng: number, precision_m?: number) =>
    pedir<{ registrada_en: string }>('/v1/campo/posicion', {
      method: 'POST',
      body: JSON.stringify({ lat, lng, precision_m }),
    }),

  casosCercanos: (
    lat: number,
    lng: number,
    opciones: { orden?: 'prioridad' | 'distancia'; radio_m?: number; solo_libres?: boolean } = {},
  ) => {
    const parametros = new URLSearchParams({
      lat: String(lat),
      lng: String(lng),
      orden: opciones.orden ?? 'prioridad',
      radio_m: String(opciones.radio_m ?? 10_000),
      limite: '30',
    });
    if (opciones.solo_libres) parametros.set('solo_libres', 'true');
    return pedir<{ orden: string; casos: CasoCampo[] }>(`/v1/campo/casos?${parametros}`);
  },

  misCasos: () => pedir<{ casos: CasoCampo[] }>('/v1/campo/mis-casos'),

  /** Personal con posición conocida. Toda la sección /v1/campo exige sesión operativa. */
  personalEnCampo: () => pedir<{ personal: PersonalCampo[] }>('/v1/campo/personal'),

  rutaHasta: (idCaso: string, lat: number, lng: number) =>
    pedir<RutaCaso>(`/v1/campo/casos/${idCaso}/ruta?lat=${lat}&lng=${lng}`),

  tomarCaso: (idCaso: string) =>
    pedir<{ tomado: boolean; codigo_publico: string; estado: string }>(
      `/v1/campo/casos/${idCaso}/tomar`,
      { method: 'POST' },
    ),

  liberarCaso: (idCaso: string) =>
    pedir<{ liberado: boolean }>(`/v1/campo/casos/${idCaso}/liberar`, { method: 'POST' }),

  marcarEnAtencion: (idCaso: string) =>
    pedir<{ estado: string }>(`/v1/campo/casos/${idCaso}/en-atencion`, { method: 'POST' }),

  /**
   * `llego_en` es ISO y opcional: se manda solo si el rescatista lo anotó al
   * cerrar. Se omite —y no se rellena con el instante del cierre— porque un dato
   * inventado arruina la medición del tiempo de llegada.
   */
  resolverCaso: (
    idCaso: string,
    nota?: string,
    personas_atendidas?: number,
    llego_en?: string,
  ) =>
    pedir<{ estado: string; nota: string }>(`/v1/campo/casos/${idCaso}/resolver`, {
      method: 'POST',
      body: JSON.stringify({ nota, personas_atendidas, llego_en }),
    }),
};
