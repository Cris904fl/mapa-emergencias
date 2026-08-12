import { useCallback, useEffect, useState } from 'react';
import { Mapa } from '../componentes/Mapa.tsx';
import {
  api,
  tieneSesion,
  ErrorApi,
  type ColeccionGeoJson,
  type Conglomerado,
  type NombreFiltro,
  type ReporteCola,
  type Resumen,
  type Zona,
} from '../lib/api.ts';

/**
 * Tablero de la sala de crisis.
 *
 * Decisión de presentación central: al lado de cada puntaje de prioridad se
 * puede desplegar su desglose por término. Un número que ordena rescates sin
 * explicación no es usable por alguien que después tiene que justificar por qué
 * mandó el equipo a un lado y no al otro.
 */

const INTERVALO_REFRESCO_MS = 20_000;

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

  /**
   * Filtro activo, elegido tocando una cifra de cabecera. Se aplica a la lista y
   * al mapa a la vez: si el mosaico dice «3 críticos» y el mapa muestra doce
   * puntos, el operador deja de confiar en el tablero.
   */
  const [filtro, setFiltro] = useState<NombreFiltro | null>(null);
  const [etiquetaFiltro, setEtiquetaFiltro] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    try {
      const [r, c, g, z, rg, recg] = await Promise.all([
        api.resumen(),
        api.cola(50, false, filtro ?? undefined),
        api.conglomerados(300),
        api.zonas(),
        api.reportesGeoJson(filtro ?? undefined),
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
  }, [filtro]);

  useEffect(() => {
    void cargar();
    const temporizador = window.setInterval(() => void cargar(), INTERVALO_REFRESCO_MS);
    return () => window.clearInterval(temporizador);
  }, [cargar]);

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

      {filtro && (
        <div className="barra-filtro" role="status">
          Mostrando solo reportes <strong>{etiquetaFiltro ?? filtro}</strong> ({cola.length})
          <button type="button" className="enlace" onClick={() => setFiltro(null)}>
            quitar filtro
          </button>
        </div>
      )}

      <section className="seccion-mapa">
        <Mapa reportes={reportesGeo} recursos={recursosGeo} onSeleccionar={setExpandido} />
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
  autenticado,
  onCambio,
}: {
  reporte: ReporteCola;
  expandido: boolean;
  onAlternar: () => void;
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
    <li className={`fila-cola severidad-${reporte.severidad.toLowerCase()}`}>
      <div className="cabecera-fila">
        <button
          type="button"
          className="puntaje"
          onClick={onAlternar}
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

          {autenticado && (
            <div className="acciones-fila">
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

