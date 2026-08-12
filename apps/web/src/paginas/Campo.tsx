import { useCallback, useEffect, useRef, useState } from 'react';
import { Acceso } from '../componentes/Acceso.tsx';
import {
  api,
  tieneSesion,
  ErrorApi,
  type CasoCampo,
  type RutaCaso,
} from '../lib/api.ts';
import { describirPrecision, obtenerUbicacion, type Ubicacion } from '../lib/geo.ts';

/**
 * Pantalla de campo, para quien va a atender.
 *
 * Es una pantalla distinta del tablero porque el usuario es distinto: alguien con
 * un celular, moviéndose, con una mano ocupada y con prisa. De ahí que las
 * acciones sean de un toque, que la distancia esté en el sitio más visible de
 * cada tarjeta, y que no haya nada que requiera leer con calma.
 *
 * Las dos ordenaciones son deliberadamente explícitas y no una mezcla
 * automática: «lo más cerca» y «lo más urgente» son preguntas distintas, y quien
 * está en la calle sabe cuál está haciendo. Un puntaje combinado inventado
 * escondería esa decisión.
 */

const CATEGORIAS_LEGIBLES: Record<string, string> = {
  PERSONAS_ATRAPADAS: 'Personas atrapadas',
  HERIDOS: 'Personas heridas',
  DESAPARECIDOS: 'Desaparecidos',
  FALLECIDOS: 'Fallecidos',
  DANO_ESTRUCTURAL: 'Daño en edificación',
  INCENDIO: 'Incendio',
  INUNDACION: 'Inundación',
  DESLIZAMIENTO: 'Deslizamiento',
  VIA_BLOQUEADA: 'Vía bloqueada',
  NECESITA_AGUA: 'Falta agua',
  NECESITA_ALIMENTO: 'Falta comida',
  NECESITA_MEDICAMENTOS: 'Faltan medicamentos',
  NECESITA_ALBERGUE: 'Necesita albergue',
  SERVICIOS_CAIDOS: 'Servicios caídos',
  OTRO: 'Otro',
};

/** Cada cuánto se reporta la posición al servidor. */
const INTERVALO_POSICION_MS = 60_000;
const INTERVALO_CASOS_MS = 30_000;

function formatearDistancia(metros: number): string {
  return metros < 1000 ? `${metros} m` : `${(metros / 1000).toFixed(1)} km`;
}

function formatearDuracion(segundos: number): string {
  const minutos = Math.round(segundos / 60);
  if (minutos < 60) return `${minutos} min`;
  return `${Math.floor(minutos / 60)} h ${minutos % 60} min`;
}

function haceCuanto(iso: string): string {
  const minutos = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutos < 60) return `hace ${minutos} min`;
  const horas = Math.floor(minutos / 60);
  return `hace ${horas} h ${minutos % 60} min`;
}

export function Campo() {
  const [autenticado, setAutenticado] = useState(tieneSesion());
  const [usuario, setUsuario] = useState<{ nombre: string | null; rol: string } | null>(null);

  const [ubicacion, setUbicacion] = useState<Ubicacion | null>(null);
  const [errorUbicacion, setErrorUbicacion] = useState<string | null>(null);

  const [orden, setOrden] = useState<'prioridad' | 'distancia'>('prioridad');
  const [soloLibres, setSoloLibres] = useState(false);
  const [casos, setCasos] = useState<CasoCampo[]>([]);
  const [mios, setMios] = useState<CasoCampo[]>([]);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [rutaAbierta, setRutaAbierta] = useState<{ idCaso: string; ruta: RutaCaso } | null>(null);
  const [calculandoRuta, setCalculandoRuta] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState<string | null>(null);

  const ubicacionRef = useRef<Ubicacion | null>(null);
  ubicacionRef.current = ubicacion;

  // ---- Ubicación ----
  const pedirUbicacion = useCallback(async () => {
    try {
      const posicion = await obtenerUbicacion();
      setUbicacion(posicion);
      setErrorUbicacion(null);
      if (tieneSesion()) {
        // Reportarla para que la sala de crisis vea dónde está su gente.
        await api
          .reportarPosicion(posicion.lat, posicion.lng, Math.round(posicion.precision_m))
          .catch(() => {});
      }
    } catch (problema) {
      setErrorUbicacion(problema instanceof Error ? problema.message : 'No se pudo ubicar');
    }
  }, []);

  useEffect(() => {
    if (!autenticado) return;
    void pedirUbicacion();
    const temporizador = window.setInterval(() => void pedirUbicacion(), INTERVALO_POSICION_MS);
    return () => window.clearInterval(temporizador);
  }, [autenticado, pedirUbicacion]);

  // ---- Casos ----
  const cargarCasos = useCallback(async () => {
    const posicion = ubicacionRef.current;
    if (!posicion || !tieneSesion()) return;

    setCargando(true);
    try {
      const [cercanos, propios] = await Promise.all([
        api.casosCercanos(posicion.lat, posicion.lng, { orden, solo_libres: soloLibres }),
        api.misCasos(),
      ]);
      setCasos(cercanos.casos);
      setMios(propios.casos);
      setError(null);
    } catch (problema) {
      setError(problema instanceof ErrorApi ? problema.message : 'No se pudo contactar la API');
    } finally {
      setCargando(false);
    }
  }, [orden, soloLibres]);

  useEffect(() => {
    void cargarCasos();
    const temporizador = window.setInterval(() => void cargarCasos(), INTERVALO_CASOS_MS);
    return () => window.clearInterval(temporizador);
  }, [cargarCasos, ubicacion?.lat, ubicacion?.lng]);

  // ---- Acciones ----
  async function actuar(idCaso: string, accion: () => Promise<unknown>) {
    setOcupado(idCaso);
    setError(null);
    try {
      await accion();
      await cargarCasos();
    } catch (problema) {
      // Los 409 son los interesantes: "ya lo tomó otro", "solo puede cerrarlo
      // quien lo tomó". Hay que mostrarlos tal cual, no como error genérico.
      setError(problema instanceof ErrorApi ? problema.message : 'La acción falló');
    } finally {
      setOcupado(null);
    }
  }

  async function verRuta(caso: CasoCampo) {
    const posicion = ubicacionRef.current;
    if (!posicion) return;

    if (rutaAbierta?.idCaso === caso.id) {
      setRutaAbierta(null);
      return;
    }

    setCalculandoRuta(caso.id);
    try {
      const ruta = await api.rutaHasta(caso.id, posicion.lat, posicion.lng);
      setRutaAbierta({ idCaso: caso.id, ruta });
    } catch {
      setError('No se pudo calcular la ruta');
    } finally {
      setCalculandoRuta(null);
    }
  }

  // ---- Render ----
  if (!autenticado) {
    // La pantalla de acceso ocupa la vista completa: es la puerta de entrada al
    // trabajo en campo, y trae su propio título.
    return (
      <Acceso
        autenticado={false}
        onCambio={(valor, datos) => {
          setAutenticado(valor);
          if (datos) setUsuario(datos);
        }}
      />
    );
  }

  const idsMios = new Set(mios.map((caso) => caso.id));
  const otros = casos.filter((caso) => !idsMios.has(caso.id));

  return (
    <div className="pagina-campo">
      <header className="encabezado">
        <div>
          <h1>Atención en campo</h1>
          {usuario && (
            <p className="subtitulo">
              {usuario.nombre} · {usuario.rol.toLowerCase()}
            </p>
          )}
        </div>
        <Acceso autenticado onCambio={setAutenticado} />
      </header>

      {/* Estado de ubicación: si no hay, nada de esta pantalla funciona. */}
      <div className={`barra-ubicacion ${ubicacion ? 'ok' : 'pendiente'}`}>
        {ubicacion ? (
          <>
            <span>
              Su posición: {ubicacion.lat.toFixed(5)}, {ubicacion.lng.toFixed(5)}
              <br />
              <small>{describirPrecision(ubicacion.precision_m)}</small>
            </span>
            <button type="button" onClick={() => void pedirUbicacion()}>
              Actualizar
            </button>
          </>
        ) : (
          <>
            <span>{errorUbicacion ?? 'Buscando su ubicación…'}</span>
            <button type="button" onClick={() => void pedirUbicacion()}>
              Reintentar
            </button>
          </>
        )}
      </div>

      {error && (
        <p className="error aviso-accion" role="alert">
          {error}
        </p>
      )}

      {/* ---- Mis casos ---- */}
      {mios.length > 0 && (
        <section className="seccion-campo">
          <h2>Lo que tomé ({mios.length})</h2>
          <ul className="lista-casos">
            {mios.map((caso) => (
              <TarjetaCaso
                key={caso.id}
                caso={{ ...caso, es_mio: true }}
                ocupado={ocupado === caso.id}
                calculandoRuta={calculandoRuta === caso.id}
                ruta={rutaAbierta?.idCaso === caso.id ? rutaAbierta.ruta : null}
                onRuta={() => void verRuta(caso)}
                onEnAtencion={() => void actuar(caso.id, () => api.marcarEnAtencion(caso.id))}
                onResolver={(nota, personas) =>
                  void actuar(caso.id, () => api.resolverCaso(caso.id, nota, personas))
                }
                onLiberar={() => void actuar(caso.id, () => api.liberarCaso(caso.id))}
              />
            ))}
          </ul>
        </section>
      )}

      {/* ---- Casos cercanos ---- */}
      <section className="seccion-campo">
        <div className="cabecera-seccion">
          <h2>Casos cerca ({otros.length})</h2>
          {cargando && <span className="cargando">actualizando…</span>}
        </div>

        <div className="controles-campo">
          <div className="grupo-orden" role="group" aria-label="Ordenar por">
            <button
              type="button"
              className={orden === 'prioridad' ? 'activa' : ''}
              onClick={() => setOrden('prioridad')}
            >
              Más urgente
            </button>
            <button
              type="button"
              className={orden === 'distancia' ? 'activa' : ''}
              onClick={() => setOrden('distancia')}
            >
              Más cerca
            </button>
          </div>
          <label className="casilla casilla-compacta">
            <input
              type="checkbox"
              checked={soloLibres}
              onChange={(e) => setSoloLibres(e.target.checked)}
            />
            Ocultar los que ya tomó alguien
          </label>
        </div>

        {/* Las dos ordenaciones responden preguntas distintas y conviene decirlo:
            lo más cercano puede ser lo menos grave. */}
        <p className="nota-panel">
          {orden === 'prioridad'
            ? 'Ordenados por el índice de prioridad. El primero puede no ser el más cercano.'
            : 'Ordenados por distancia en línea recta. El más cercano puede no ser el más grave.'}
        </p>

        {otros.length === 0 && !cargando && (
          <p className="vacio">No hay casos abiertos en 10 km de su posición.</p>
        )}

        <ul className="lista-casos">
          {otros.map((caso) => (
            <TarjetaCaso
              key={caso.id}
              caso={caso}
              ocupado={ocupado === caso.id}
              calculandoRuta={calculandoRuta === caso.id}
              ruta={rutaAbierta?.idCaso === caso.id ? rutaAbierta.ruta : null}
              onRuta={() => void verRuta(caso)}
              onTomar={() => void actuar(caso.id, () => api.tomarCaso(caso.id))}
            />
          ))}
        </ul>
      </section>
    </div>
  );
}

function TarjetaCaso({
  caso,
  ocupado,
  calculandoRuta,
  ruta,
  onRuta,
  onTomar,
  onEnAtencion,
  onResolver,
  onLiberar,
}: {
  caso: CasoCampo;
  ocupado: boolean;
  calculandoRuta: boolean;
  ruta: RutaCaso | null;
  onRuta: () => void;
  onTomar?: () => void;
  onEnAtencion?: () => void;
  onResolver?: (nota?: string, personas?: number) => void;
  onLiberar?: () => void;
}) {
  const [cerrando, setCerrando] = useState(false);
  const [nota, setNota] = useState('');
  const [personas, setPersonas] = useState('');

  const tomadoPorOtro = caso.responsable_id !== null && !caso.es_mio;

  return (
    <li className={`tarjeta-caso severidad-${caso.severidad.toLowerCase()} ${caso.es_mio ? 'mio' : ''}`}>
      <div className="cabecera-caso">
        <span className="distancia">{formatearDistancia(caso.distancia_m)}</span>
        <div className="titulo-caso">
          <strong>{CATEGORIAS_LEGIBLES[caso.categoria] ?? caso.categoria}</strong>
          <div className="etiquetas-caso">
            <code>{caso.codigo_publico}</code>
            {caso.requiere_rescate && <span className="marca-rescate">rescate</span>}
            {caso.prioridad_score !== null && (
              <span className="marca-prioridad">prio {caso.prioridad_score.toFixed(0)}</span>
            )}
            <span className="estado-caso">{caso.estado.replace('_', ' ').toLowerCase()}</span>
          </div>
        </div>
      </div>

      <div className="personas-caso">
        {caso.personas_afectadas > 0 && <span>{caso.personas_afectadas} personas</span>}
        {caso.personas_atrapadas > 0 && (
          <span className="alarma">{caso.personas_atrapadas} atrapadas</span>
        )}
        {caso.personas_heridas > 0 && <span className="aviso">{caso.personas_heridas} heridas</span>}
        {caso.personas_vulnerables > 0 && <span>{caso.personas_vulnerables} vulnerables</span>}
        {caso.lugar && <span>{caso.lugar}</span>}
        <span>{haceCuanto(caso.reportado_en)}</span>
      </div>

      {caso.descripcion && <p className="descripcion">«{caso.descripcion}»</p>}

      {caso.contacto_reportante && (
        <p className="contacto">
          Contacto: <a href={`tel:${caso.contacto_reportante}`}>{caso.contacto_reportante}</a>
        </p>
      )}

      {tomadoPorOtro && (
        <p className="tomado-por">Lo tomó {caso.responsable} · {haceCuanto(caso.tomado_en!)}</p>
      )}

      {/* ---- Ruta ---- */}
      {ruta && (
        <div className="panel-ruta">
          <div className="resumen-ruta">
            <strong>{formatearDistancia(ruta.distancia_m)}</strong>
            {ruta.duracion_s !== null && <> · {formatearDuracion(ruta.duracion_s)} en vehículo</>}
            {ruta.tipo === 'linea_recta' && (
              <>
                {' '}
                <span className="aviso">en línea recta</span>
              </>
            )}
          </div>

          {ruta.tipo === 'linea_recta' && (
            <p className="nota-panel">
              No hubo motor de rutas disponible. La distancia real por calles suele ser
              entre 1.3 y 1.6 veces mayor.
              {ruta.aviso && <> {ruta.aviso}</>}
            </p>
          )}

          {/* Esta es la parte que un mapa comercial no puede dar: sabe las
              calles, pero no que un vecino acaba de reportarlas intransitables. */}
          {ruta.obstaculos.length > 0 ? (
            <div className="obstaculos">
              <strong className="titulo-obstaculos">
                ⚠ {ruta.obstaculos.length} reporte(s) obstruyen esta ruta
              </strong>
              <ul>
                {ruta.obstaculos.map((obstaculo) => (
                  <li key={obstaculo.id}>
                    <span className="marca-obstaculo">
                      {CATEGORIAS_LEGIBLES[obstaculo.categoria] ?? obstaculo.categoria}
                    </span>{' '}
                    a {formatearDistancia(obstaculo.metros_desde_origen)} del inicio
                    {obstaculo.descripcion && (
                      <>
                        <br />
                        <small>«{obstaculo.descripcion}»</small>
                      </>
                    )}
                  </li>
                ))}
              </ul>
              <p className="nota-panel">
                La ruta no los evita: el motor usa el mapa de calles normal. Considere
                otro camino.
              </p>
            </div>
          ) : (
            <p className="sin-obstaculos">Sin vías bloqueadas reportadas sobre la ruta.</p>
          )}

          <a
            className="enlace-externo"
            href={`https://www.google.com/maps/dir/?api=1&destination=${ruta.destino.lat},${ruta.destino.lng}&travelmode=driving`}
            target="_blank"
            rel="noreferrer"
          >
            Abrir en Google Maps para navegar
          </a>
        </div>
      )}

      {/* ---- Acciones ---- */}
      <div className="acciones-caso">
        <button type="button" onClick={onRuta} disabled={calculandoRuta}>
          {calculandoRuta ? 'Calculando…' : ruta ? 'Ocultar ruta' : 'Ver ruta'}
        </button>

        {onTomar && !tomadoPorOtro && (
          <button type="button" className="principal" onClick={onTomar} disabled={ocupado}>
            {ocupado ? '…' : 'Tomar este caso'}
          </button>
        )}

        {onTomar && tomadoPorOtro && (
          <button type="button" onClick={onTomar} disabled={ocupado} title="Ya lo tomó otra persona">
            Tomar de todos modos
          </button>
        )}

        {onEnAtencion && caso.estado !== 'EN_ATENCION' && (
          <button type="button" onClick={onEnAtencion} disabled={ocupado}>
            Llegué al sitio
          </button>
        )}

        {onResolver && !cerrando && (
          <button type="button" className="principal" onClick={() => setCerrando(true)}>
            Marcar resuelto
          </button>
        )}

        {onLiberar && (
          <button type="button" className="enlace" onClick={onLiberar} disabled={ocupado}>
            liberar
          </button>
        )}
      </div>

      {/* Cierre con nota: lo que se escriba acá queda en la bitácora del caso. */}
      {cerrando && onResolver && (
        <form
          className="formulario-cierre"
          onSubmit={(evento) => {
            evento.preventDefault();
            const n = Number.parseInt(personas, 10);
            onResolver(nota.trim() || undefined, Number.isFinite(n) ? n : undefined);
            setCerrando(false);
            setNota('');
            setPersonas('');
          }}
        >
          <label>
            Personas atendidas
            <input
              type="number"
              min="0"
              inputMode="numeric"
              value={personas}
              onChange={(e) => setPersonas(e.target.value)}
            />
          </label>
          <label>
            Qué pasó
            <textarea
              rows={2}
              value={nota}
              onChange={(e) => setNota(e.target.value)}
              placeholder="Ej: cinco personas evacuadas, una remitida al hospital"
            />
          </label>
          <div className="acciones-caso">
            <button type="submit" className="principal" disabled={ocupado}>
              Confirmar cierre
            </button>
            <button type="button" className="enlace" onClick={() => setCerrando(false)}>
              cancelar
            </button>
          </div>
        </form>
      )}
    </li>
  );
}
