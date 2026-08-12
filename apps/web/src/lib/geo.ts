export type Ubicacion = {
  lat: number;
  lng: number;
  precision_m: number;
  momento: string;
  /** true cuando la escribió la persona a mano en vez de venir del GPS. */
  manual: boolean;
};

export type EstadoUbicacion =
  | { fase: 'inactiva' }
  | { fase: 'buscando' }
  | { fase: 'lista'; ubicacion: Ubicacion }
  | { fase: 'error'; mensaje: string; puedeReintentar: boolean };

/**
 * Obtiene la posición del dispositivo.
 *
 * `timeout` generoso (20 s) porque un GPS en interiores o bajo escombros tarda,
 * y `maximumAge` de un minuto para aceptar una lectura reciente en lugar de
 * hacer esperar de nuevo. Lo que no se hace es rendirse en silencio: si falla,
 * el formulario ofrece escribir las coordenadas a mano.
 */
export function obtenerUbicacion(): Promise<Ubicacion> {
  return new Promise((resolver, rechazar) => {
    if (!('geolocation' in navigator)) {
      rechazar(new Error('Este dispositivo no permite obtener la ubicación'));
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (posicion) =>
        resolver({
          lat: posicion.coords.latitude,
          lng: posicion.coords.longitude,
          precision_m: posicion.coords.accuracy,
          momento: new Date(posicion.timestamp).toISOString(),
          manual: false,
        }),
      (error) => {
        const mensajes: Record<number, string> = {
          1: 'No dio permiso de ubicación. Puede activarlo en los ajustes del navegador o escribir las coordenadas a mano.',
          2: 'No se pudo determinar la ubicación. Si está bajo techo, intente salir o escriba las coordenadas a mano.',
          3: 'La búsqueda de ubicación tardó demasiado. Intente de nuevo.',
        };
        rechazar(new Error(mensajes[error.code] ?? 'No se pudo obtener la ubicación'));
      },
      { enableHighAccuracy: true, timeout: 20_000, maximumAge: 60_000 },
    );
  });
}

/** ¿La coordenada cae dentro del rango del territorio colombiano? */
export function dentroDeColombia(lat: number, lng: number): boolean {
  // Mismos límites que valida la API (apps/api/src/esquemas/dominio.ts): así el
  // formulario avisa antes de enviar en lugar de recibir un 400.
  return lat >= -4.5 && lat <= 16 && lng >= -82 && lng <= -66;
}

export function formatearCoordenada(valor: number): string {
  return valor.toFixed(6);
}

export function describirPrecision(metros: number): string {
  if (metros <= 20) return `precisión de ${Math.round(metros)} m (buena)`;
  if (metros <= 100) return `precisión de ${Math.round(metros)} m (aceptable)`;
  if (metros <= 1000) return `precisión de ${Math.round(metros)} m (baja)`;
  return `precisión de ${(metros / 1000).toFixed(1)} km (muy baja)`;
}
