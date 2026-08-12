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

  cola: (limite = 50, vivo = false) =>
    pedir<{ modo: string; reportes: ReporteCola[] }>(
      `/v1/tablero/cola?limite=${limite}&vivo=${vivo}`,
    ),

  conglomerados: (radioM = 300) =>
    pedir<{ conglomerados: Conglomerado[] }>(`/v1/tablero/conglomerados?radio_m=${radioM}`),

  zonas: () => pedir<{ zonas: Zona[] }>('/v1/tablero/zonas'),

  aislados: (umbralM = 5000) =>
    pedir<{ reportes: ReporteCola[] }>(`/v1/tablero/aislados?umbral_m=${umbralM}`),

  reportesGeoJson: (bbox?: string) =>
    pedir<ColeccionGeoJson>(`/v1/reportes${bbox ? `?bbox=${bbox}&limite=500` : '?limite=500'}`),

  recursosGeoJson: () => pedir<ColeccionGeoJson>('/v1/recursos'),

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
};
