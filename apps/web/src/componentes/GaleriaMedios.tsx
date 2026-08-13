import { useState } from 'react';
import type { Medio } from '../lib/api.ts';
import { formatearBytes } from '../lib/imagen.ts';

/**
 * Muestra las fotos, el audio y el video de un reporte.
 *
 * Sirve a dos pantallas con motivos distintos, y por eso el título es del que
 * llama y no de aquí:
 *
 *   · En la consulta por código, para quien reportó. La pregunta que responde no
 *     es «cómo se ve el daño» —él estaba ahí— sino **«¿llegó mi foto?»**. Hasta
 *     ahora la aplicación decía «se envían después del reporte» y después
 *     callaba para siempre: la única forma de saber si la subida funcionó era
 *     que no diera error.
 *   · En la vista de campo, para el rescatista. Ahí sí importa lo que se ve:
 *     saber si es agua, fuego o una casa caída cambia lo que se lleva y con
 *     quién va. Es probablemente el dato más útil que el sistema ya tenía
 *     guardado y no le estaba mostrando a nadie.
 *
 * No hay miniaturas: `/v1/medios/:id` entrega el archivo completo. Ya viene
 * reducido a 1568 px desde el teléfono de quien reportó, así que son unos
 * cientos de kilobytes y no varios megas — pero es una descarga real, y por eso
 * en campo esto se pide a demanda salvo en los casos propios.
 *
 * El service worker no cachea `/v1/`, así que sin señal las imágenes no cargan.
 * Se dice con un texto en lugar de dejar el icono de imagen rota, que no explica
 * nada.
 */

export function GaleriaMedios({ medios, titulo }: { medios: Medio[]; titulo: string }) {
  if (medios.length === 0) return null;

  return (
    <section className="galeria-medios">
      <h4>{titulo}</h4>
      <ul>
        {medios.map((medio) => (
          <li key={medio.id}>
            <Elemento medio={medio} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function Elemento({ medio }: { medio: Medio }) {
  const [fallo, setFallo] = useState(false);
  const url = `/v1/medios/${medio.id}`;
  const esImagen = medio.tipo === 'FOTO' || medio.tipo_mime.startsWith('image/');

  if (fallo) {
    return (
      // Las dos causas se ven igual desde una etiqueta `img`, así que se
      // nombran las dos en vez de adivinar. Hay un medio en producción cuyo
      // archivo no existe, así que la segunda no es hipotética.
      <p className="medio-fallido">
        No se pudo cargar este archivo. Puede ser falta de señal —no se guardan
        para verlos sin conexión— o que el archivo ya no esté.
      </p>
    );
  }

  if (esImagen) {
    return (
      // Abre en pestaña nueva en vez de una lupa propia: el visor del navegador
      // ya hace zoom y girar, y en un celular con una mano funciona mejor que
      // cualquier cosa que se pueda escribir acá.
      <a href={url} target="_blank" rel="noopener noreferrer" className="miniatura">
        <img src={url} alt="Foto del reporte" loading="lazy" onError={() => setFallo(true)} />
        <small>{formatearBytes(Number(medio.bytes))}</small>
      </a>
    );
  }

  if (medio.tipo === 'AUDIO') {
    return (
      <audio controls preload="none" src={url} onError={() => setFallo(true)}>
        <a href={url}>Descargar el audio</a>
      </audio>
    );
  }

  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="enlace-medio">
      Ver el video · {formatearBytes(Number(medio.bytes))}
    </a>
  );
}
