import { useEffect, useRef } from 'react';
import maplibregl, { type Map as MapaLibre } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { ColeccionGeoJson } from '../lib/api.ts';

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

type Props = {
  reportes: ColeccionGeoJson | null;
  recursos: ColeccionGeoJson | null;
  onSeleccionar?: (id: string) => void;
};

export function Mapa({ reportes, recursos, onSeleccionar }: Props) {
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

      for (const capa of ['reportes-punto', 'recursos-punto']) {
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

  return (
    <div className="envoltorio-mapa">
      <div ref={contenedor} className="mapa" />
      <div className="leyenda">
        <span className="titulo-leyenda">Severidad</span>
        {Object.entries(COLOR_POR_SEVERIDAD).map(([severidad, color]) => (
          <span key={severidad} className="entrada-leyenda">
            <i style={{ background: color }} aria-hidden="true" />
            {severidad.toLowerCase()}
          </span>
        ))}
        <span className="entrada-leyenda">
          <i className="anillo-rescate" aria-hidden="true" />
          requiere rescate
        </span>
        <span className="entrada-leyenda">
          <i style={{ background: '#0369a1' }} aria-hidden="true" />
          recurso disponible
        </span>
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
