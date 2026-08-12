import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

/**
 * Almacenamiento local del dispositivo.
 *
 * Es la pieza central del modo sin conexión: un reporte se escribe acá ANTES de
 * intentar enviarlo, siempre. Si la red falla, si el navegador se cierra, si el
 * celular se queda sin batería a mitad del envío, el reporte sigue existiendo y
 * se reintenta después. La premisa es que en una emergencia la red es lo
 * primero que se cae, y perder un pedido de auxilio no es una opción.
 */

export const NOMBRE_BD = 'mapa-emergencias';
export const VERSION_BD = 1;

export type EstadoEnvio = 'pendiente' | 'enviando' | 'confirmado' | 'rechazado';

/** Carga que viaja a POST /v1/reportes, tal como la construye el formulario. */
export type CargaReporte = {
  id_cliente: string;
  categoria: string;
  severidad: string;
  descripcion?: string;
  contacto_reportante?: string;
  lat: number;
  lng: number;
  precision_ubicacion_m?: number;
  personas_afectadas: number;
  personas_atrapadas: number;
  personas_heridas: number;
  personas_fallecidas: number;
  personas_vulnerables: number;
  requiere_rescate: boolean;
  reportado_en: string;
};

export type ElementoBandeja = {
  /** Clave primaria. Es el mismo UUID que hace idempotente el alta en la API. */
  id_cliente: string;
  carga: CargaReporte;
  estado: EstadoEnvio;
  creado_en: string;
  intentos: number;
  ultimo_error?: string;
  /** Asignados por el servidor cuando el reporte queda confirmado. */
  id_servidor?: string;
  codigo_publico?: string;
  /** ¿Quedan fotos por subir para este reporte? */
  fotos_pendientes: number;
};

export type FotoPendiente = {
  id: string;
  id_cliente: string;
  blob: Blob;
  tipo_mime: string;
  creado_en: string;
  intentos: number;
};

interface EsquemaBd extends DBSchema {
  bandeja: {
    key: string;
    value: ElementoBandeja;
    indexes: { 'por-estado': EstadoEnvio };
  };
  fotos: {
    key: string;
    value: FotoPendiente;
    indexes: { 'por-cliente': string };
  };
}

let promesaBd: Promise<IDBPDatabase<EsquemaBd>> | undefined;

export function abrirBd(): Promise<IDBPDatabase<EsquemaBd>> {
  promesaBd ??= openDB<EsquemaBd>(NOMBRE_BD, VERSION_BD, {
    upgrade(bd) {
      const bandeja = bd.createObjectStore('bandeja', { keyPath: 'id_cliente' });
      bandeja.createIndex('por-estado', 'estado');

      const fotos = bd.createObjectStore('fotos', { keyPath: 'id' });
      fotos.createIndex('por-cliente', 'id_cliente');
    },
  });
  return promesaBd;
}

// ---------------------------------------------------------------------------
// Bandeja de salida
// ---------------------------------------------------------------------------

export async function guardarEnBandeja(carga: CargaReporte, fotos: Blob[] = []): Promise<void> {
  const bd = await abrirBd();
  const tx = bd.transaction(['bandeja', 'fotos'], 'readwrite');

  await tx.objectStore('bandeja').put({
    id_cliente: carga.id_cliente,
    carga,
    estado: 'pendiente',
    creado_en: new Date().toISOString(),
    intentos: 0,
    fotos_pendientes: fotos.length,
  });

  const almacenFotos = tx.objectStore('fotos');
  for (const [indice, blob] of fotos.entries()) {
    await almacenFotos.put({
      id: `${carga.id_cliente}:${indice}`,
      id_cliente: carga.id_cliente,
      blob,
      tipo_mime: blob.type || 'image/jpeg',
      creado_en: new Date().toISOString(),
      intentos: 0,
    });
  }

  await tx.done;
}

export async function listarBandeja(): Promise<ElementoBandeja[]> {
  const bd = await abrirBd();
  const todos = await bd.getAll('bandeja');
  return todos.sort((a, b) => a.creado_en.localeCompare(b.creado_en));
}

export async function pendientesDeEnvio(): Promise<ElementoBandeja[]> {
  const bd = await abrirBd();
  // Se incluye 'enviando' además de 'pendiente': si el navegador se cerró en
  // medio de un envío, el elemento quedó marcado como en curso y nadie lo
  // volvería a tomar. Reintentar es seguro porque el alta es idempotente.
  const pendientes = await bd.getAllFromIndex('bandeja', 'por-estado', 'pendiente');
  const enCurso = await bd.getAllFromIndex('bandeja', 'por-estado', 'enviando');
  return [...pendientes, ...enCurso].sort((a, b) => a.creado_en.localeCompare(b.creado_en));
}

export async function marcarEstado(
  idCliente: string,
  estado: EstadoEnvio,
  extra: Partial<ElementoBandeja> = {},
): Promise<void> {
  const bd = await abrirBd();
  const elemento = await bd.get('bandeja', idCliente);
  if (!elemento) return;
  await bd.put('bandeja', { ...elemento, ...extra, estado });
}

export async function registrarIntentoFallido(idCliente: string, error: string): Promise<void> {
  const bd = await abrirBd();
  const elemento = await bd.get('bandeja', idCliente);
  if (!elemento) return;
  await bd.put('bandeja', {
    ...elemento,
    estado: 'pendiente',
    intentos: elemento.intentos + 1,
    ultimo_error: error,
  });
}

/**
 * Elimina un elemento ya confirmado y sin fotos pendientes.
 *
 * Los confirmados no se borran de inmediato: se conservan para que el ciudadano
 * pueda ver su código público —lo que le permite preguntar por su caso— y los
 * limpia `purgarConfirmados` después de un tiempo.
 */
export async function eliminarDeBandeja(idCliente: string): Promise<void> {
  const bd = await abrirBd();
  const tx = bd.transaction(['bandeja', 'fotos'], 'readwrite');
  await tx.objectStore('bandeja').delete(idCliente);

  const indice = tx.objectStore('fotos').index('por-cliente');
  for await (const cursor of indice.iterate(idCliente)) {
    await cursor.delete();
  }
  await tx.done;
}

/** Descarta confirmados con más de `dias` días para no llenar el dispositivo. */
export async function purgarConfirmados(dias = 7): Promise<number> {
  const bd = await abrirBd();
  const limite = new Date(Date.now() - dias * 86_400_000).toISOString();
  const confirmados = await bd.getAllFromIndex('bandeja', 'por-estado', 'confirmado');

  let purgados = 0;
  for (const elemento of confirmados) {
    if (elemento.creado_en < limite && elemento.fotos_pendientes === 0) {
      await eliminarDeBandeja(elemento.id_cliente);
      purgados++;
    }
  }
  return purgados;
}

// ---------------------------------------------------------------------------
// Fotos
// ---------------------------------------------------------------------------

export async function fotosDe(idCliente: string): Promise<FotoPendiente[]> {
  const bd = await abrirBd();
  return bd.getAllFromIndex('fotos', 'por-cliente', idCliente);
}

export async function eliminarFoto(id: string): Promise<void> {
  const bd = await abrirBd();
  await bd.delete('fotos', id);
}

export async function descontarFotoPendiente(idCliente: string): Promise<void> {
  const bd = await abrirBd();
  const elemento = await bd.get('bandeja', idCliente);
  if (!elemento) return;
  await bd.put('bandeja', {
    ...elemento,
    fotos_pendientes: Math.max(0, elemento.fotos_pendientes - 1),
  });
}
