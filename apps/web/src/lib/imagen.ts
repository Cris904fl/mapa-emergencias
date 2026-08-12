/**
 * Reducción de fotos en el dispositivo, antes de guardarlas en la bandeja.
 *
 * Se hace en el cliente y no en el servidor por dos razones, y la segunda es la
 * que manda: una foto de celular pesa entre 3 y 8 MB, y subir eso por una red
 * de emergencia puede tomar minutos o no terminar nunca. Reducir a 1568 px de
 * lado largo la deja en unos 200-400 KB sin perder lo que un operador necesita
 * ver. La segunda razón, menor, es que también recorta el costo en tokens
 * cuando la imagen pasa por el modelo multimodal.
 *
 * Se usa canvas y no una biblioteca: está en todos los navegadores y no agrega
 * dependencias a una aplicación que tiene que cargar rápido en una red mala.
 */

export const LADO_MAXIMO = 1568;
export const CALIDAD_JPEG = 0.82;

export type FotoReducida = {
  blob: Blob;
  ancho: number;
  alto: number;
  bytes_originales: number;
  bytes_finales: number;
};

export async function reducirFoto(
  archivo: File,
  ladoMaximo = LADO_MAXIMO,
): Promise<FotoReducida> {
  const bitmap = await crearBitmap(archivo);

  try {
    const escala = Math.min(1, ladoMaximo / Math.max(bitmap.width, bitmap.height));
    const ancho = Math.max(1, Math.round(bitmap.width * escala));
    const alto = Math.max(1, Math.round(bitmap.height * escala));

    const lienzo = document.createElement('canvas');
    lienzo.width = ancho;
    lienzo.height = alto;

    const contexto = lienzo.getContext('2d');
    if (!contexto) throw new Error('No se pudo preparar la imagen en este dispositivo');

    contexto.imageSmoothingQuality = 'high';
    contexto.drawImage(bitmap, 0, 0, ancho, alto);

    const blob = await new Promise<Blob | null>((resolver) =>
      lienzo.toBlob(resolver, 'image/jpeg', CALIDAD_JPEG),
    );
    if (!blob) throw new Error('No se pudo comprimir la imagen');

    return {
      blob,
      ancho,
      alto,
      bytes_originales: archivo.size,
      bytes_finales: blob.size,
    };
  } finally {
    // Liberar la memoria del bitmap: en un celular modesto varias fotos sin
    // cerrar bastan para que el navegador mate la pestaña.
    bitmap.close?.();
  }
}

async function crearBitmap(archivo: File): Promise<ImageBitmap> {
  if ('createImageBitmap' in globalThis) {
    // La orientación EXIF se respeta explícitamente: sin esto las fotos
    // tomadas en vertical llegan acostadas y cuesta interpretarlas.
    return createImageBitmap(archivo, { imageOrientation: 'from-image' });
  }
  throw new Error('Este navegador no permite procesar imágenes');
}

export function formatearBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
