import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import {
  api,
  tieneSesion,
  ErrorApi,
  type ColeccionGeoJson,
  type Conglomerado,
  type NombreFiltro,
  type PersonalCampo,
  type Severidad,
  type ReporteCola,
  type Resumen,
  type Zona,
} from '../lib/api.ts';
import { FotosDelReporte } from '../componentes/GaleriaMedios.tsx';
import { TIBIA_S, describirAntiguedad } from '../lib/frescura.ts';

/**
 * Tablero de la sala de crisis.
 *
 * Decisión de presentación central: al lado de cada puntaje de prioridad se
 * puede desplegar su desglose por término. Un número que ordena rescates sin
 * explicación no es usable por alguien que después tiene que justificar por qué
 * mandó el equipo a un lado y no al otro.
 */

const INTERVALO_REFRESCO_MS = 20_000;

/**
 * El mapa se carga aparte del resto de la aplicación.
 *
 * MapLibre pesa más que todo lo demás junto y solo lo usa esta pantalla. La
 * vista «Reportar» —un ciudadano con la red caída, que es el caso de uso que
 * justifica toda la arquitectura sin conexión— no tiene por qué descargarlo
 * antes de poder escribir una línea. Detrás de un `import()` dinámico el
 * empaquetador lo saca a su propio trozo y esa pantalla deja de pedirlo.
 *
 * El componente se exporta con nombre, así que hay que traducirlo a `default`:
 * es lo único que `lazy` sabe leer.
 */
const Mapa = lazy(() =>
  import('../componentes/Mapa.tsx').then((modulo) => ({ default: modulo.Mapa })),
);

export function Tablero({ onIrACampo }: { onIrACampo: () => void }) {
  /**
   * El tablero lee la sesión pero no la crea: se entra desde «Atender». Acá la
   * sesión solo habilita las acciones sobre un reporte; consultar el estado de la
   * emergencia es abierto a propósito, porque tenerlo detrás de un login no
   * protege nada y sí estorba a quien necesita mirarlo rápido.
   */
  const autenticado = tieneSesion();
  const [resumen, setResumen] = useState<Resumen | null>(null);
  const [cola, setCola] = useState<ReporteCola[]>([]);
  const [conglomerados, setConglomerados] = useState<Conglomerado[]>([]);
  const [zonas, setZonas] = useState<Zona[]>([]);
  const [reportesGeo, setReportesGeo] = useState<ColeccionGeoJson | null>(null);
  const [recursosGeo, setRecursosGeo] = useState<ColeccionGeoJson | null>(null);
  const [expandido, setExpandido] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(true);
  const [personal, setPersonal] = useState<PersonalCampo[] | null>(null);
  const [avisoPersonal, setAvisoPersonal] = useState<string | null>(null);

  /**
   * Reporte al que el mapa debe volar, elegido tocándolo en la cola.
   *
   * Lleva un contador en la clave para que tocar dos veces el mismo reporte
   * vuelva a centrarlo: es lo que uno hace cuando ya movió el mapa buscando
   * otra cosa y quiere regresar.
   */
  const [enfocar, setEnfocar] = useState<{ lat: number; lng: number; clave: string } | null>(
    null,
  );

  /**
   * Filtro activo, elegido tocando una cifra de cabecera. Se aplica a la lista y
   * al mapa a la vez: si el mosaico dice «3 críticos» y el mapa muestra doce
   * puntos, el operador deja de confiar en el tablero.
   */
  const [filtro, setFiltro] = useState<NombreFiltro | null>(null);
  const [etiquetaFiltro, setEtiquetaFiltro] = useState<string | null>(null);

  /**
   * Severidad activa, elegida tocando la leyenda del mapa.
   *
   * Es ortogonal al filtro de KPI y se combina con él: «qué tan grave» y «en qué
   * situación está» son preguntas distintas. Va al mismo sitio que el otro
   * filtro —la cola y el GeoJSON del mapa— porque si solo filtrara el mapa, la
   * lista de al lado mostraría reportes que el mapa no dibuja.
   */
  const [severidad, setSeveridad] = useState<Severidad | null>(null);

  const cargar = useCallback(async () => {
    try {
      const [r, c, g, z, rg, recg] = await Promise.all([
        api.resumen(),
        api.cola(50, false, filtro ?? undefined, severidad ?? undefined),
        api.conglomerados(300),
        api.zonas(),
        api.reportesGeoJson(filtro ?? undefined, severidad ?? undefined),
        api.recursosGeoJson(),
      ]);
      setResumen(r);
      setCola(c.reportes);
      setEtiquetaFiltro(c.filtro_etiqueta);
      setConglomerados(g.conglomerados);
      setZonas(z.zonas);
      setReportesGeo(rg);
      setRecursosGeo(recg);
      setError(null);
    } catch (problema) {
      setError(
        problema instanceof ErrorApi
          ? `${problema.message} (HTTP ${problema.estado})`
          : 'No se pudo contactar la API',
      );
    } finally {
      setCargando(false);
    }
  }, [filtro, severidad]);

  /**
   * El personal se pide aparte del resto del tablero, no dentro del mismo
   * `Promise.all`.
   *
   * Es la única consulta de esta pantalla que exige sesión operativa —toda la
   * sección /v1/campo lo hace—, y un token vencido no puede tumbar el resto: el
   * tablero se mira en modo consulta a propósito. Si falla, se dice por qué en
   * vez de dejar la capa vacía sin explicación, que se leería como «no hay
   * nadie en campo».
   */
  const cargarPersonal = useCallback(async () => {
    if (!tieneSesion()) {
      setPersonal(null);
      setAvisoPersonal(null);
      return;
    }

    try {
      const { personal: gente } = await api.personalEnCampo();
      setPersonal(gente);
      setAvisoPersonal(null);
    } catch (problema) {
      setPersonal(null);
      setAvisoPersonal(
        problema instanceof ErrorApi && (problema.estado === 401 || problema.estado === 403)
          ? 'La sesión venció: el personal en campo dejó de mostrarse.'
          : 'No se pudo leer la posición del personal.',
      );
    }
  }, []);

  useEffect(() => {
    void cargar();
    void cargarPersonal();
    const temporizador = window.setInterval(() => {
      void cargar();
      void cargarPersonal();
    }, INTERVALO_REFRESCO_MS);
    return () => window.clearInterval(temporizador);
  }, [cargar, cargarPersonal]);

  return (
    <div className="pagina-tablero">
      <header className="encabezado">
        <div>
          <h1>Sala de crisis</h1>
          {resumen && (
            <p className="subtitulo">
              Actualizado {new Date(resumen.generado_en).toLocaleTimeString('es-CO')} · se refresca
              cada {INTERVALO_REFRESCO_MS / 1000} s
            </p>
          )}
        </div>
      </header>

      {/* Sin sesión el tablero se ve completo pero no se puede actuar sobre un
          reporte. Se dice dónde entrar en lugar de poner otro formulario acá. */}
      {!autenticado && (
        <div className="aviso-sesion">
          <span>
            Está viendo el tablero <strong>en modo consulta</strong>. Para tomar o cerrar
            casos, entre desde «Atender».
          </span>
          <button type="button" onClick={onIrACampo}>
            Ir a Atender
          </button>
        </div>
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {cargando && <p className="cargando">Cargando…</p>}

      {resumen && (
        <Cifras
          resumen={resumen}
          filtroActivo={filtro}
          onFiltrar={(nuevo) => setFiltro(nuevo === filtro ? null : nuevo)}
        />
      )}

      {/* Los dos filtros se anuncian juntos y se quitan por separado: con ambos
          activos, un «quitar filtro» único dejaría al operador sin saber cuál de
          los dos estaba recortando la lista. */}
      {(filtro || severidad) && (
        <div className="barra-filtro" role="status">
          Mostrando solo reportes{' '}
          {filtro && <strong>{etiquetaFiltro ?? filtro}</strong>}
          {filtro && severidad && ' y '}
          {severidad && <strong>de severidad {severidad.toLowerCase()}</strong>}{' '}
          ({cola.length})
          {filtro && (
            <button type="button" className="enlace" onClick={() => setFiltro(null)}>
              quitar {severidad ? 'el de KPI' : 'filtro'}
            </button>
          )}
          {severidad && (
            <button type="button" className="enlace" onClick={() => setSeveridad(null)}>
              quitar {filtro ? 'el de severidad' : 'filtro'}
            </button>
          )}
        </div>
      )}

      <section className="seccion-mapa">
        {/* El marcador ocupa el mismo alto que el mapa para que la cola de
            atención no salte hacia arriba y vuelva a bajar mientras carga. */}
        <Suspense fallback={<div className="mapa-cargando">Cargando el mapa…</div>}>
          <Mapa
            reportes={reportesGeo}
            recursos={recursosGeo}
            personal={personal}
            onSeleccionar={setExpandido}
            enfocar={enfocar}
            severidad={severidad}
            onFiltrarSeveridad={(elegida) =>
              setSeveridad(elegida === severidad ? null : elegida)
            }
          />
        </Suspense>
        <ResumenPersonal personal={personal} aviso={avisoPersonal} autenticado={autenticado} />
      </section>

      <div className="rejilla-paneles">
        <section className="panel">
          <h2>Cola de atención</h2>
          <p className="nota-panel">
            Ordenada por el índice de prioridad. Toque un puntaje para ver de qué está
            compuesto.
          </p>
          <ol className="cola">
            {cola.map((reporte) => (
              <FilaCola
                key={reporte.id}
                reporte={reporte}
                expandido={expandido === reporte.id}
                onAlternar={() => setExpandido(expandido === reporte.id ? null : reporte.id)}
                onVerEnMapa={() =>
                  setEnfocar({
                    lat: reporte.lat,
                    lng: reporte.lng,
                    // El instante hace la clave única: sin él, tocar el mismo
                    // reporte dos veces no volvería a centrarlo.
                    clave: `${reporte.id}-${Date.now()}`,
                  })
                }
                autenticado={autenticado}
                onCambio={() => void cargar()}
              />
            ))}
            {cola.length === 0 && !cargando && <li className="vacio">No hay reportes abiertos.</li>}
          </ol>
        </section>

        <div className="columna-lateral">
          <section className="panel">
            <h2>Concentraciones</h2>
            <p className="nota-panel">
              Grupos detectados por densidad (DBSCAN, radio de 300 m). Señalan eventos
              más grandes de lo que describe cada reporte por separado.
            </p>
            {conglomerados.length === 0 ? (
              <p className="vacio">Sin concentraciones detectadas.</p>
            ) : (
              <ul className="lista-simple">
                {conglomerados.map((grupo) => (
                  <li key={grupo.grupo}>
                    <strong>{grupo.reportes} reportes</strong> · {grupo.personas_afectadas} personas
                    {grupo.personas_atrapadas > 0 && ` (${grupo.personas_atrapadas} atrapadas)`}
                    <br />
                    <small>{grupo.categorias.join(', ').toLowerCase()}</small>
                    <br />
                    <small className="tenue">{grupo.codigos.join(' · ')}</small>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="panel">
            <h2>Zonas</h2>
            {zonas.length === 0 ? (
              <p className="vacio">Sin zonas con reportes abiertos.</p>
            ) : (
              <table className="tabla">
                <thead>
                  <tr>
                    <th>Zona</th>
                    <th>Rep.</th>
                    <th>Pers.</th>
                    <th>Atrap.</th>
                  </tr>
                </thead>
                <tbody>
                  {zonas.map((zona) => (
                    <tr key={zona.lugar_id}>
                      <td>
                        {zona.lugar}
                        <br />
                        <small className="tenue">{zona.tipo_lugar.toLowerCase()}</small>
                      </td>
                      <td>{zona.reportes_abiertos}</td>
                      <td>{zona.personas_afectadas}</td>
                      <td>{zona.personas_atrapadas}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

/**
 * Quién está en campo, debajo del mapa.
 *
 * El mapa dice dónde; esta tira dice quién y con cuánta carga, que es lo que
 * decide a quién se le manda el siguiente caso. Cada entrada lleva la edad de
 * su posición al lado del nombre: sin eso, una fila que dice «0 casos» invita a
 * mandarle trabajo a alguien de quien no se sabe nada desde hace una hora.
 */
function ResumenPersonal({
  personal,
  aviso,
  autenticado,
}: {
  personal: PersonalCampo[] | null;
  aviso: string | null;
  autenticado: boolean;
}) {
  // Sin sesión no se consulta: el aviso de «modo consulta» ya explica por qué y
  // repetirlo acá sería ruido.
  if (!autenticado) return null;

  if (aviso) {
    return (
      <p className="tira-personal-aviso" role="status">
        {aviso}
      </p>
    );
  }

  if (!personal) return null;

  if (personal.length === 0) {
    return (
      <p className="tira-personal-aviso">
        Nadie ha reportado posición todavía. Se registra sola cuando alguien abre «Atender».
      </p>
    );
  }

  const desactualizados = personal.filter((persona) => persona.antiguedad_s >= TIBIA_S).length;

  return (
    <div className="tira-personal">
      <p className="cabecera-personal">
        <strong>{personal.length}</strong> en campo
        {desactualizados > 0 && (
          <span className="tenue">
            {' '}
            · {desactualizados} con posición desactualizada
          </span>
        )}
      </p>
      <ul className="lista-personal">
        {personal.map((persona) => (
          <li
            key={persona.id}
            className={persona.antiguedad_s >= TIBIA_S ? 'persona vieja' : 'persona'}
          >
            <span className="nombre-persona">{persona.nombre}</span>
            <span className="tenue">
              {persona.casos_abiertos === 1
                ? '1 caso'
                : `${persona.casos_abiertos} casos`}{' '}
              · {describirAntiguedad(persona.antiguedad_s)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Cifras({
  resumen,
  filtroActivo,
  onFiltrar,
}: {
  resumen: Resumen;
  filtroActivo: NombreFiltro | null;
  onFiltrar: (filtro: NombreFiltro) => void;
}) {
  const r = resumen.reportes;
  const espera = resumen.espera_maxima_minutos;

  return (
    <section className="cifras" aria-label="Cifras principales">
      <Cifra valor={r.abiertos} etiqueta="abiertos" filtro="abiertos" {...{ filtroActivo, onFiltrar }} />
      <Cifra valor={r.criticos} etiqueta="críticos" tono="alarma" filtro="criticos" {...{ filtroActivo, onFiltrar }} />
      {/* Aquí la cifra y el filtro tienen unidades distintas a propósito: el
          mosaico cuenta PERSONAS atrapadas, el filtro trae los REPORTES que las
          tienen. Se aclara en el título para que no parezca un descuadre. */}
      <Cifra
        valor={r.personas_atrapadas}
        etiqueta="personas atrapadas"
        tono="alarma"
        filtro="atrapadas"
        titulo="Toque para ver los reportes con personas atrapadas"
        {...{ filtroActivo, onFiltrar }}
      />
      <Cifra
        valor={r.personas_heridas}
        etiqueta="personas heridas"
        tono="aviso"
        filtro="heridas"
        titulo="Toque para ver los reportes con personas heridas"
        {...{ filtroActivo, onFiltrar }}
      />
      <Cifra valor={r.sin_atender} etiqueta="sin atender" tono="aviso" filtro="sin_atender" {...{ filtroActivo, onFiltrar }} />
      <Cifra
        valor={espera === null ? '—' : espera >= 60 ? `${Math.floor(espera / 60)} h` : `${espera} min`}
        etiqueta="espera más larga"
        tono={espera !== null && espera > 240 ? 'alarma' : 'normal'}
        filtro="sin_atender"
        titulo="Toque para ver todo lo que está sin atender"
        {...{ filtroActivo, onFiltrar }}
      />
      <Cifra valor={r.sin_triage} etiqueta="sin triage" filtro="sin_triage" {...{ filtroActivo, onFiltrar }} />
      {/* Casos que alguien tomó y a los que nunca llegó. Es la única cifra que
          señala algo que el resto del tablero no puede mostrar: al asignarse, un
          reporte deja de subir en la cola, así que uno olvidado se ve igual que
          uno atendido. Sin este mosaico, nadie lo mira. */}
      <Cifra
        valor={r.asignados_estancados}
        etiqueta="asignados sin llegada"
        tono={r.asignados_estancados > 0 ? 'alarma' : 'normal'}
        filtro="estancados"
        titulo="Tomados hace más de 30 minutos y todavía sin llegada al sitio"
        {...{ filtroActivo, onFiltrar }}
      />
      <Cifra
        valor={r.con_rescate_pendiente}
        etiqueta="rescate pendiente"
        tono="alarma"
        filtro="rescate"
        {...{ filtroActivo, onFiltrar }}
      />
      {/* Cuántos reportes tocó la IA y cuántos una persona: hace visible el
          reparto de trabajo entre ambos en vez de esconderlo. Al tocarlo se ve
          justo lo que la IA escribió y nadie confirmó todavía. */}
      <Cifra
        valor={`${r.triados_por_persona} / ${r.triados_por_ia}`}
        etiqueta="triage persona / IA"
        filtro="ia_sin_revisar"
        titulo="Toque para revisar lo que escribió la IA"
        {...{ filtroActivo, onFiltrar }}
      />
      <Cifra valor={r.resueltos} etiqueta="resueltos" filtro="resueltos" {...{ filtroActivo, onFiltrar }} />
      {/* Los recursos no son reportes: este no filtra la cola. */}
      <Cifra valor={resumen.recursos.disponibles} etiqueta="recursos disponibles" />
    </section>
  );
}

function Cifra({
  valor,
  etiqueta,
  tono = 'normal',
  filtro,
  filtroActivo,
  onFiltrar,
  titulo,
}: {
  valor: number | string;
  etiqueta: string;
  tono?: 'normal' | 'aviso' | 'alarma';
  filtro?: NombreFiltro;
  filtroActivo?: NombreFiltro | null;
  onFiltrar?: (filtro: NombreFiltro) => void;
  titulo?: string;
}) {
  const contenido = (
    <>
      <span className="valor">{valor}</span>
      <span className="etiqueta">{etiqueta}</span>
    </>
  );

  // Sin filtro asociado se renderiza como texto y no como botón: un control que
  // parece pulsable y no hace nada es peor que uno que no lo parece.
  if (!filtro || !onFiltrar) {
    return <div className={`cifra ${tono}`}>{contenido}</div>;
  }

  const activo = filtroActivo === filtro;

  return (
    <button
      type="button"
      className={`cifra pulsable ${tono} ${activo ? 'activa' : ''}`}
      onClick={() => onFiltrar(filtro)}
      aria-pressed={activo}
      title={titulo ?? `Toque para filtrar: ${etiqueta}`}
    >
      {contenido}
    </button>
  );
}

function FilaCola({
  reporte,
  expandido,
  onAlternar,
  onVerEnMapa,
  autenticado,
  onCambio,
}: {
  reporte: ReporteCola;
  expandido: boolean;
  onAlternar: () => void;
  onVerEnMapa: () => void;
  autenticado: boolean;
  onCambio: () => void;
}) {
  const [ocupado, setOcupado] = useState(false);

  const minutosEspera = Math.round(
    (Date.now() - new Date(reporte.reportado_en).getTime()) / 60_000,
  );

  async function actuar(accion: () => Promise<unknown>) {
    setOcupado(true);
    try {
      await accion();
      onCambio();
    } catch (error) {
      console.warn(error);
    } finally {
      setOcupado(false);
    }
  }

  return (
    /* Tocar la fila lleva el mapa hasta el reporte. Va en el <li> y no en un
       botón que lo envuelva porque adentro ya hay botones —el puntaje, las
       acciones— y anidarlos sería HTML inválido. Los de adentro detienen la
       propagación para que abrir el desglose no mueva además el mapa. Para
       teclado y lectores de pantalla está el botón explícito «ver en el mapa»
       de la fila de metadatos. */
    <li
      className={`fila-cola severidad-${reporte.severidad.toLowerCase()}`}
      onClick={onVerEnMapa}
    >
      <div className="cabecera-fila">
        <button
          type="button"
          className="puntaje"
          onClick={(evento) => {
            evento.stopPropagation();
            onAlternar();
          }}
          aria-expanded={expandido}
          title="Ver de qué está compuesto este puntaje"
        >
          {reporte.score === null ? '—' : reporte.score.toFixed(1)}
        </button>

        <div className="datos-fila">
          <div className="titulo-fila">
            <code>{reporte.codigo_publico}</code>{' '}
            <span className="categoria">{reporte.categoria.replaceAll('_', ' ').toLowerCase()}</span>
            {reporte.requiere_rescate && <span className="marca-rescate">rescate</span>}
            {reporte.origen_triage === 'IA' && (
              <span className="marca-ia" title="Datos completados por extracción automática, sin revisar">
                IA sin revisar
              </span>
            )}
          </div>

          <div className="meta-fila">
            {reporte.personas_afectadas > 0 && <span>{reporte.personas_afectadas} personas</span>}
            {reporte.personas_atrapadas > 0 && (
              <span className="alarma">{reporte.personas_atrapadas} atrapadas</span>
            )}
            {reporte.personas_heridas > 0 && <span>{reporte.personas_heridas} heridas</span>}
            {reporte.lugar && <span>{reporte.lugar}</span>}
            <span>
              {minutosEspera >= 60
                ? `hace ${Math.floor(minutosEspera / 60)} h`
                : `hace ${minutosEspera} min`}
            </span>
            <span className="estado-reporte">{reporte.estado.toLowerCase()}</span>
            <button
              type="button"
              className="enlace ver-en-mapa"
              onClick={(evento) => {
                evento.stopPropagation();
                onVerEnMapa();
              }}
            >
              ver en el mapa
            </button>
          </div>

          {reporte.descripcion && <p className="descripcion">«{reporte.descripcion}»</p>}
        </div>
      </div>

      {expandido && (
        <div className="detalle-fila">
          {reporte.componentes ? (
            <table className="tabla-componentes">
              <caption>De qué está compuesto el puntaje</caption>
              <thead>
                <tr>
                  <th>Término</th>
                  <th>Valor</th>
                  <th>Normal.</th>
                  <th>Peso</th>
                  <th>Aporte</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(reporte.componentes).map(([nombre, componente]) => (
                  <tr key={nombre}>
                    <td>
                      {nombre}
                      {componente.unidad && (
                        <>
                          <br />
                          <small className="tenue">{componente.unidad}</small>
                        </>
                      )}
                    </td>
                    <td>{String(componente.crudo)}</td>
                    <td>{componente.normalizado.toFixed(2)}</td>
                    <td>{componente.peso}</td>
                    <td>
                      <strong>{componente.aporte.toFixed(2)}</strong>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="vacio">Sin desglose: la prioridad no se ha calculado todavía.</p>
          )}

          {/* Las fotos van entre el desglose y las acciones: primero se mira,
              después se decide.

              Se cargan solas porque este bloque solo existe cuando el operador
              expandió la fila — expandir ya es pedirlo. Cargar las fotos de la
              cola entera para mirar una sería descargar cincuenta reportes.

              El stopPropagation es por lo mismo que el de las acciones: abrir
              una foto no debe además volar el mapa hasta el reporte. */}
          <div onClick={(evento) => evento.stopPropagation()}>
            <FotosDelReporte reporteId={reporte.id} autocargar titulo="Fotos del reporte" />
          </div>

          {autenticado && (
            /* Un solo stopPropagation para todas las acciones: cambiar el
               estado de un reporte no debe además mover el mapa. */
            <div className="acciones-fila" onClick={(evento) => evento.stopPropagation()}>
              <button
                type="button"
                disabled={ocupado}
                onClick={() => void actuar(() => api.cambiarEstado(reporte.id, 'EN_TRIAGE'))}
              >
                Poner en triage
              </button>
              <button
                type="button"
                disabled={ocupado}
                onClick={() => void actuar(() => api.cambiarEstado(reporte.id, 'ASIGNADO'))}
              >
                Asignar
              </button>
              <button
                type="button"
                disabled={ocupado}
                onClick={() => void actuar(() => api.cambiarEstado(reporte.id, 'RESUELTO'))}
              >
                Marcar resuelto
              </button>
              {reporte.descripcion && (
                <button
                  type="button"
                  disabled={ocupado}
                  onClick={() => void actuar(() => api.triarConIa(reporte.id))}
                  title="Estructurar el texto libre con el modelo"
                >
                  Estructurar texto
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

