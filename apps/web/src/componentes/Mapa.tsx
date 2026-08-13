import { useEffect, useRef } from 'react';
import maplibregl, { type Map as MapaLibre } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { ColeccionGeoJson, PersonalCampo, Severidad } from '../lib/api.ts';
import { FRESCA_S, TIBIA_S, describirAntiguedad } from '../lib/frescura.ts';

/**
 * Mapa del tablero.
 *
 * Nota sobre el fondo cartográfico: se usan teselas de OpenStreetMap, que sirven
 * para desarrollo pero cuya política de uso no permite tráfico de producción.
 * Antes de desplegar hay que apuntar a un proveedor propio o contratado; el
 * único cambio es la URL en ESTILO.
 */

const ESTILO: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: '© colaboradores de OpenStreetMap',
      maxzoom: 19,
    },
  },
  layers: [{ id: 'fondo', type: 'raster', source: 'osm' }],
};

// El color comunica severidad. Se eligieron tonos que se distinguen también en
// escala de grises y para el tipo más común de daltonismo: la diferencia no
// depende solo del matiz, sino también de la luminosidad.
const COLOR_POR_SEVERIDAD: Record<string, string> = {
  CRITICA: '#b91c1c',
  ALTA: '#ea580c',
  MEDIA: '#ca8a04',
  BAJA: '#65a30d',
  DESCONOCIDA: '#64748b',
};

// Color del personal de socorro. Se eligió un tono que no aparece en la escala
// de severidad ni en los recursos: en un mapa donde el color ya significa «qué
// tan grave», un punto que significa «quién» no puede parecerse a ninguno.
const COLOR_PERSONAL = '#0d9488';

type Props = {
  reportes: ColeccionGeoJson | null;
  recursos: ColeccionGeoJson | null;
  personal?: PersonalCampo[] | null;
  onSeleccionar?: (id: string) => void;
  /**
   * Punto al que volar cuando cambia.
   *
   * Lo usa la cola de atención: tocar un reporte de la lista lleva el mapa
   * hasta donde ocurrió. Sin esto, el operador tiene que buscar a ojo entre
   * decenas de puntos cuál es el que acaba de leer, que es justo el trabajo
   * que el tablero debería ahorrarle.
   *
   * Lleva `clave` para poder volver a volar al mismo sitio: si solo dependiera
   * de las coordenadas, tocar dos veces el mismo reporte no haría nada.
   */
  enfocar?: { lat: number; lng: number; clave: string } | null;
  /** Severidad activa, para marcar cuál entrada de la leyenda está pulsada. */
  severidad?: Severidad | null;
  /** Si se pasa, las entradas de severidad de la leyenda se vuelven botones. */
  onFiltrarSeveridad?: (severidad: Severidad) => void;
};

/**
 * Opacidad escalonada por antigüedad, compartida por el punto y su núcleo.
 *
 * Se escalona en vez de interpolar a propósito: tres franjas nítidas —actual,
 * envejeciendo, desactualizada— se leen de un vistazo, mientras que un
 * degradado continuo obliga a comparar dos puntos entre sí para saber cuál es
 * más viejo. Lo tenue se lee como «no cuente con esto» sin abrir nada.
 */
const OPACIDAD_POR_ANTIGUEDAD: maplibregl.ExpressionSpecification = [
  'step',
  ['coalesce', ['get', 'antiguedad_s'], 0],
  0.95,
  FRESCA_S,
  0.55,
  TIBIA_S,
  0.22,
];

/**
 * El personal llega como lista plana; el mapa necesita GeoJSON.
 *
 * La forma se declara acá en vez de tomarla de `@types/geojson`: ese paquete
 * entra de refilón con maplibre-gl y no está en las dependencias de este
 * paquete. Es la misma decisión que ya tomó `ColeccionGeoJson` en `api.ts`.
 */
type ColeccionPersonal = {
  type: 'FeatureCollection';
  features: {
    type: 'Feature';
    geometry: { type: 'Point'; coordinates: [number, number] };
    properties: Record<string, unknown>;
  }[];
};

function personalAGeoJson(personal: PersonalCampo[]): ColeccionPersonal {
  return {
    type: 'FeatureCollection',
    features: personal.map((persona) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [persona.lng, persona.lat] },
      properties: {
        nombre: persona.nombre,
        rol: persona.rol,
        organizacion: persona.organizacion,
        antiguedad_s: persona.antiguedad_s,
        precision_m: persona.posicion_precision_m,
        casos_abiertos: persona.casos_abiertos,
      },
    })),
  };
}

export function Mapa({
  reportes,
  recursos,
  personal,
  onSeleccionar,
  severidad,
  onFiltrarSeveridad,
  enfocar,
}: Props) {
  const contenedor = useRef<HTMLDivElement>(null);
  const mapa = useRef<MapaLibre | null>(null);
  const listo = useRef(false);

  useEffect(() => {
    if (!contenedor.current || mapa.current) return;

    const instancia = new maplibregl.Map({
      container: contenedor.current,
      style: ESTILO,
      center: [-74.08, 4.62],
      zoom: 12,
      attributionControl: { compact: true },
    });

    instancia.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    instancia.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

    instancia.on('load', () => {
      instancia.addSource('reportes', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      instancia.addSource('recursos', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      instancia.addSource('personal', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });

      // Halo que crece con la cantidad de personas afectadas: hace visible de un
      // golpe de vista dónde hay más gente en riesgo, sin leer números.
      instancia.addLayer({
        id: 'reportes-halo',
        type: 'circle',
        source: 'reportes',
        paint: {
          'circle-radius': [
            'interpolate',
            ['linear'],
            ['coalesce', ['get', 'personas_afectadas'], 0],
            0, 6,
            5, 14,
            20, 26,
            50, 38,
          ],
          'circle-color': [
            'match',
            ['coalesce', ['get', 'severidad'], 'DESCONOCIDA'],
            'CRITICA', COLOR_POR_SEVERIDAD.CRITICA!,
            'ALTA', COLOR_POR_SEVERIDAD.ALTA!,
            'MEDIA', COLOR_POR_SEVERIDAD.MEDIA!,
            'BAJA', COLOR_POR_SEVERIDAD.BAJA!,
            COLOR_POR_SEVERIDAD.DESCONOCIDA!,
          ],
          'circle-opacity': 0.28,
        },
      });

      instancia.addLayer({
        id: 'reportes-punto',
        type: 'circle',
        source: 'reportes',
        paint: {
          'circle-radius': 6,
          'circle-color': [
            'match',
            ['coalesce', ['get', 'severidad'], 'DESCONOCIDA'],
            'CRITICA', COLOR_POR_SEVERIDAD.CRITICA!,
            'ALTA', COLOR_POR_SEVERIDAD.ALTA!,
            'MEDIA', COLOR_POR_SEVERIDAD.MEDIA!,
            'BAJA', COLOR_POR_SEVERIDAD.BAJA!,
            COLOR_POR_SEVERIDAD.DESCONOCIDA!,
          ],
          'circle-stroke-width': 2,
          'circle-stroke-color': '#ffffff',
        },
      });

      // Anillo adicional para lo que necesita rescate: es la distinción que un
      // operador busca primero y no debe depender solo del color.
      instancia.addLayer({
        id: 'reportes-rescate',
        type: 'circle',
        source: 'reportes',
        filter: ['==', ['get', 'requiere_rescate'], true],
        paint: {
          'circle-radius': 11,
          'circle-color': 'rgba(0,0,0,0)',
          'circle-stroke-width': 2,
          'circle-stroke-color': '#111827',
        },
      });

      instancia.addLayer({
        id: 'recursos-punto',
        type: 'circle',
        source: 'recursos',
        paint: {
          'circle-radius': 7,
          'circle-color': [
            'match',
            ['coalesce', ['get', 'estado'], 'DISPONIBLE'],
            'DISPONIBLE', '#0369a1',
            'OCUPADO', '#7c3aed',
            '#9ca3af',
          ],
          'circle-stroke-width': 2,
          'circle-stroke-color': '#ffffff',
        },
      });

      // El personal va encima de todo: es la capa que se consulta para decidir a
      // quién mandar, y un punto de persona tapado por un halo de reporte no
      // sirve. Se dibuja como anillo —relleno con núcleo blanco— para que no se
      // confunda con los discos llenos de reportes y recursos ni siquiera en
      // escala de grises.
      instancia.addLayer({
        id: 'personal-punto',
        type: 'circle',
        source: 'personal',
        paint: {
          'circle-radius': 9,
          'circle-color': COLOR_PERSONAL,
          'circle-opacity': OPACIDAD_POR_ANTIGUEDAD,
          'circle-stroke-width': 2,
          'circle-stroke-color': '#ffffff',
          'circle-stroke-opacity': OPACIDAD_POR_ANTIGUEDAD,
        },
      });

      instancia.addLayer({
        id: 'personal-nucleo',
        type: 'circle',
        source: 'personal',
        paint: {
          'circle-radius': 3.5,
          'circle-color': '#ffffff',
          'circle-opacity': OPACIDAD_POR_ANTIGUEDAD,
        },
      });

      const emergente = new maplibregl.Popup({ closeButton: true, maxWidth: '280px' });

      instancia.on('click', 'reportes-punto', (evento) => {
        const rasgo = evento.features?.[0];
        if (!rasgo) return;

        const p = rasgo.properties as Record<string, unknown>;
        const puntaje = typeof p.prioridad_score === 'number' ? p.prioridad_score.toFixed(1) : '—';

        emergente
          .setLngLat(evento.lngLat)
          .setHTML(
            `<strong>${escapar(String(p.codigo_publico ?? ''))}</strong><br>` +
              `${escapar(String(p.categoria ?? ''))} · ${escapar(String(p.severidad ?? ''))}<br>` +
              `Prioridad: <strong>${puntaje}</strong><br>` +
              `Personas: ${Number(p.personas_afectadas ?? 0)}` +
              (Number(p.personas_atrapadas ?? 0) > 0
                ? ` (${Number(p.personas_atrapadas)} atrapadas)`
                : '') +
              (p.lugar ? `<br>${escapar(String(p.lugar))}` : ''),
          )
          .addTo(instancia);

        if (rasgo.id !== undefined && onSeleccionar) onSeleccionar(String(rasgo.id));
      });

      instancia.on('click', 'recursos-punto', (evento) => {
        const rasgo = evento.features?.[0];
        if (!rasgo) return;
        const p = rasgo.properties as Record<string, unknown>;
        emergente
          .setLngLat(evento.lngLat)
          .setHTML(
            `<strong>${escapar(String(p.nombre ?? ''))}</strong><br>` +
              `${escapar(String(p.tipo ?? ''))} · ${escapar(String(p.estado ?? ''))}` +
              (p.cupos_libres !== null && p.cupos_libres !== undefined
                ? `<br>Cupos libres: ${Number(p.cupos_libres)}`
                : ''),
          )
          .addTo(instancia);
      });

      instancia.on('click', 'personal-punto', (evento) => {
        const rasgo = evento.features?.[0];
        if (!rasgo) return;
        const p = rasgo.properties as Record<string, unknown>;
        const antiguedad = Number(p.antiguedad_s ?? 0);
        const casos = Number(p.casos_abiertos ?? 0);

        // La antigüedad se dice siempre y de primera, incluso cuando es de hace
        // segundos: si solo apareciera al envejecer, su ausencia se leería como
        // «está aquí» en vez de como «no se sabe».
        emergente
          .setLngLat(evento.lngLat)
          .setHTML(
            `<strong>${escapar(String(p.nombre ?? ''))}</strong><br>` +
              `${escapar(String(p.rol ?? '').toLowerCase())}` +
              (p.organizacion ? ` · ${escapar(String(p.organizacion))}` : '') +
              `<br>Posición ${describirAntiguedad(antiguedad)}` +
              (antiguedad >= TIBIA_S ? ' <strong>(desactualizada)</strong>' : '') +
              (p.precision_m ? `<br>Precisión: ±${Number(p.precision_m)} m` : '') +
              `<br>Casos abiertos: ${casos}`,
          )
          .addTo(instancia);
      });

      for (const capa of ['reportes-punto', 'recursos-punto', 'personal-punto']) {
        instancia.on('mouseenter', capa, () => {
          instancia.getCanvas().style.cursor = 'pointer';
        });
        instancia.on('mouseleave', capa, () => {
          instancia.getCanvas().style.cursor = '';
        });
      }

      listo.current = true;
    });

    mapa.current = instancia;

    return () => {
      instancia.remove();
      mapa.current = null;
      listo.current = false;
    };
  }, [onSeleccionar]);

  // Actualizar los datos sin recrear el mapa: recrearlo perdería el encuadre
  // que el operador acaba de ajustar.
  useEffect(() => {
    const instancia = mapa.current;
    if (!instancia || !reportes) return;

    const aplicar = () => {
      const fuente = instancia.getSource('reportes') as maplibregl.GeoJSONSource | undefined;
      fuente?.setData(reportes as never);
    };

    if (listo.current) aplicar();
    else instancia.once('load', aplicar);
  }, [reportes]);

  useEffect(() => {
    const instancia = mapa.current;
    if (!instancia || !recursos) return;

    const aplicar = () => {
      const fuente = instancia.getSource('recursos') as maplibregl.GeoJSONSource | undefined;
      fuente?.setData(recursos as never);
    };

    if (listo.current) aplicar();
    else instancia.once('load', aplicar);
  }, [recursos]);

  /**
   * Volar al reporte que se tocó en la cola.
   *
   * `flyTo` y no `jumpTo` a propósito: el desplazamiento animado deja ver hacia
   * dónde se movió el mapa. Un salto instantáneo obliga a reorientarse desde
   * cero, y en una sala de crisis eso es medio segundo perdido en cada consulta.
   *
   * El zoom se fija en 16 —aproximadamente una manzana— porque es la escala a
   * la que se decide a quién mandar. Si el operador ya estaba más cerca, se
   * respeta su encuadre.
   */
  useEffect(() => {
    const instancia = mapa.current;
    if (!instancia || !enfocar) return;

    const volar = () =>
      instancia.flyTo({
        center: [enfocar.lng, enfocar.lat],
        zoom: Math.max(instancia.getZoom(), 16),
        duration: 900,
      });

    if (listo.current) volar();
    else instancia.once('load', volar);
  }, [enfocar]);

  useEffect(() => {
    const instancia = mapa.current;
    if (!instancia) return;

    // A diferencia de reportes y recursos, acá sí se aplica el caso nulo: sin
    // sesión no se consulta el personal, y la capa tiene que quedar vacía en vez
    // de conservar las últimas posiciones conocidas al cerrar sesión.
    const coleccion = personalAGeoJson(personal ?? []);

    const aplicar = () => {
      const fuente = instancia.getSource('personal') as maplibregl.GeoJSONSource | undefined;
      fuente?.setData(coleccion as never);
    };

    if (listo.current) aplicar();
    else instancia.once('load', aplicar);
  }, [personal]);

  return (
    <div className="envoltorio-mapa">
      <div ref={contenedor} className="mapa" />
      <div className="leyenda">
        <span className="titulo-leyenda">Severidad</span>
        {/* La leyenda hace doble oficio: explica el color y filtra por él. Es
            donde el operador ya está mirando cuando se pregunta «y si solo veo
            las críticas», así que poner el control en otra parte de la pantalla
            sería mandarlo a buscar. Sin `onFiltrarSeveridad` se dibuja como
            texto y no como botón: un control que parece pulsable y no hace nada
            es peor que uno que no lo parece. */}
        {Object.entries(COLOR_POR_SEVERIDAD).map(([nombre, color]) => {
          const muestra = <i style={{ background: color }} aria-hidden="true" />;

          if (!onFiltrarSeveridad) {
            return (
              <span key={nombre} className="entrada-leyenda">
                {muestra}
                {nombre.toLowerCase()}
              </span>
            );
          }

          const activa = severidad === nombre;

          return (
            <button
              key={nombre}
              type="button"
              className={`entrada-leyenda pulsable ${activa ? 'activa' : ''}`}
              onClick={() => onFiltrarSeveridad(nombre as Severidad)}
              aria-pressed={activa}
              title={
                activa
                  ? 'Quitar el filtro de severidad'
                  : `Ver solo los reportes de severidad ${nombre.toLowerCase()}`
              }
            >
              {muestra}
              {nombre.toLowerCase()}
            </button>
          );
        })}
        <span className="entrada-leyenda">
          <i className="anillo-rescate" aria-hidden="true" />
          requiere rescate
        </span>
        <span className="entrada-leyenda">
          <i style={{ background: '#0369a1' }} aria-hidden="true" />
          recurso disponible
        </span>
        {/* Solo se anuncia el personal cuando hay alguno: una entrada de leyenda
            para una capa vacía hace buscar en el mapa algo que no está. */}
        {personal && personal.length > 0 && (
          <>
            <span className="entrada-leyenda">
              <i className="punto-personal" aria-hidden="true" />
              personal en campo
            </span>
            <span className="entrada-leyenda">
              <i className="punto-personal desvanecido" aria-hidden="true" />
              posición vieja
            </span>
          </>
        )}
      </div>
    </div>
  );
}

/** Los textos van a innerHTML del emergente, así que se escapan. */
function escapar(texto: string): string {
  return texto
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
