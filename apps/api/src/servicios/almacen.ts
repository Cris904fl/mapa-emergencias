import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.ts';

/**
 * Dónde viven las fotos, el video y el audio de los reportes.
 *
 * Hay dos implementaciones y se elige por configuración:
 *
 *   · **disco** — el comportamiento de siempre. Sirve en desarrollo y en un
 *     servidor propio con disco persistente.
 *   · **supabase** — almacenamiento de objetos. Hace falta en un hospedaje
 *     gratuito, donde el disco es efímero: en Render el sistema de archivos se
 *     borra en cada redespliegue **y cada vez que la instancia hiberna y vuelve**.
 *     Las fotos de la beta se estaban perdiendo solas.
 *
 * La llave no cambia entre las dos: `medios_reporte.llave_almacen` siempre fue
 * una llave derivada del SHA-256, no una ruta de archivo. Por eso migrar no
 * toca el esquema.
 *
 * Se elige por presencia de credenciales y no por una variable de modo: una
 * bandera que diga «usar supabase» sin las claves puestas sería una forma de
 * fallar en producción y no en desarrollo, que es la peor.
 */

export type Almacen = {
  /** Descripción legible, para el arranque y para `/listo`. */
  readonly descripcion: string;
  guardar(llave: string, bytes: Buffer, tipoMime: string): Promise<void>;
  /** `null` cuando el objeto no está: un medio puede haberse perdido. */
  leer(llave: string): Promise<Buffer | null>;
};

// ---------------------------------------------------------------- en disco

function almacenEnDisco(raiz: string): Almacen {
  const raizAbsoluta = path.resolve(raiz);

  return {
    descripcion: `disco (${raizAbsoluta})`,

    async guardar(llave, bytes) {
      const destino = rutaSegura(llave);
      await mkdir(path.dirname(destino), { recursive: true });
      await writeFile(destino, bytes);
    },

    async leer(llave) {
      return readFile(rutaSegura(llave)).catch(() => null);
    },
  };

  /**
   * La llave sale de la base y se derivó de un hexadecimal, así que no puede
   * traer saltos de directorio. Se verifica igual: cuesta nada y protege si
   * alguna vez una llave entra por otra vía.
   */
  function rutaSegura(llave: string): string {
    const ruta = path.resolve(raizAbsoluta, llave);
    if (ruta !== raizAbsoluta && !ruta.startsWith(raizAbsoluta + path.sep)) {
      throw new Error(`Llave de almacén inválida: ${llave}`);
    }
    return ruta;
  }
}

// -------------------------------------------------------------- en Supabase

function almacenEnSupabase(urlBase: string, clave: string, bucket: string): Almacen {
  const raiz = `${urlBase.replace(/\/+$/, '')}/storage/v1/object`;
  const cabeceras = { authorization: `Bearer ${clave}`, apikey: clave };

  return {
    descripcion: `Supabase Storage (bucket «${bucket}»)`,

    async guardar(llave, bytes, tipoMime) {
      const respuesta = await fetch(`${raiz}/${bucket}/${llave}`, {
        method: 'POST',
        headers: {
          ...cabeceras,
          'content-type': tipoMime,
          // El mismo archivo tiene la misma llave —se deriva de su SHA-256—,
          // así que reenviarlo debe sobrescribir en vez de fallar. Es lo que
          // pasa cuando alguien recupera señal y la bandeja reintenta.
          'x-upsert': 'true',
        },
        body: new Uint8Array(bytes),
      });

      if (!respuesta.ok) {
        const detalle = await respuesta.text().catch(() => '');
        throw new Error(
          `Supabase Storage rechazó la subida (HTTP ${respuesta.status}): ${detalle.slice(0, 200)}`,
        );
      }
    },

    /**
     * Devuelve `null` cuando el objeto no está, y lanza solo cuando el almacén
     * falló de verdad.
     *
     * La distinción importa porque hay un medio huérfano en producción —la fila
     * existe en `medios_reporte` y el archivo no, de cuando iban al disco
     * efímero de Render— y **Supabase Storage no contesta 404 para eso**:
     * contesta `400` con un cuerpo que dice `"error":"not_found"`. Con solo
     * mirar el código de estado, una condición conocida y esperada salía como
     * `500 error_interno`, se registraba con detalle en cada petición, y la
     * pantalla del ciudadano le echaba la culpa a su señal.
     *
     * Un 400 que no sea «no está» sí se lanza, y ahora con el cuerpo incluido:
     * significaría que la llave que armamos está mal, y eso hay que verlo, no
     * confundirlo con un archivo perdido.
     */
    async leer(llave) {
      const respuesta = await fetch(`${raiz}/${bucket}/${llave}`, { headers: cabeceras });
      if (respuesta.status === 404) return null;

      if (!respuesta.ok) {
        const detalle = await respuesta.text().catch(() => '');
        if (/not.?found/i.test(detalle)) return null;
        throw new Error(
          `Supabase Storage falló al leer (HTTP ${respuesta.status}): ${detalle.slice(0, 200)}`,
        );
      }

      return Buffer.from(await respuesta.arrayBuffer());
    },
  };
}

// ------------------------------------------------------------------ elección

export const almacen: Almacen =
  config.SUPABASE_URL && config.SUPABASE_CLAVE_SERVICIO
    ? almacenEnSupabase(
        config.SUPABASE_URL,
        config.SUPABASE_CLAVE_SERVICIO,
        config.SUPABASE_BUCKET,
      )
    : almacenEnDisco(config.ALMACEN_MEDIOS);
