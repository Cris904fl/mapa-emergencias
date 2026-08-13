import { useEffect, useState } from 'react';
import { listarBandeja, type CargaReporte, type ElementoBandeja } from '../lib/bd.ts';
import { agregarALaBandeja, alCambiarBandeja, sincronizarBandeja } from '../lib/bandeja.ts';
import {
  describirPrecision,
  dentroDeColombia,
  formatearCoordenada,
  obtenerUbicacion,
  type EstadoUbicacion,
} from '../lib/geo.ts';
import { formatearBytes, reducirFoto } from '../lib/imagen.ts';
import { ConsultarCaso } from '../componentes/ConsultarCaso.tsx';

/**
 * Formulario ciudadano.
 *
 * Principios que guían este archivo, en orden:
 *
 *   1. El reporte se guarda en el dispositivo ANTES de intentar enviarlo. El
 *      botón nunca falla por falta de red.
 *   2. Lo único obligatorio es la ubicación y el tipo de emergencia. Todo lo
 *      demás es opcional, incluyendo la descripción: alguien atrapado bajo
 *      escombros no va a llenar ocho campos.
 *   3. Los conteos de personas se piden aparte del texto porque quien está en el
 *      sitio contando es mejor fuente que un modelo leyendo su prosa. Si los
 *      deja vacíos, la extracción automática los completa desde el texto.
 */

const CATEGORIAS: { valor: string; etiqueta: string; ayuda: string }[] = [
  { valor: 'PERSONAS_ATRAPADAS', etiqueta: 'Personas atrapadas', ayuda: 'Alguien no puede salir' },
  { valor: 'HERIDOS', etiqueta: 'Personas heridas', ayuda: 'Se necesita atención médica' },
  { valor: 'DESAPARECIDOS', etiqueta: 'Personas desaparecidas', ayuda: 'No se sabe dónde están' },
  { valor: 'DANO_ESTRUCTURAL', etiqueta: 'Daño en edificación', ayuda: 'Grietas, techos, muros' },
  { valor: 'INCENDIO', etiqueta: 'Incendio', ayuda: '' },
  { valor: 'INUNDACION', etiqueta: 'Inundación', ayuda: '' },
  { valor: 'DESLIZAMIENTO', etiqueta: 'Deslizamiento', ayuda: 'Se vino la tierra' },
  { valor: 'VIA_BLOQUEADA', etiqueta: 'Vía bloqueada', ayuda: 'No pueden pasar vehículos' },
  { valor: 'NECESITA_AGUA', etiqueta: 'Falta agua', ayuda: '' },
  { valor: 'NECESITA_ALIMENTO', etiqueta: 'Falta comida', ayuda: '' },
  { valor: 'NECESITA_MEDICAMENTOS', etiqueta: 'Faltan medicamentos', ayuda: '' },
  { valor: 'NECESITA_ALBERGUE', etiqueta: 'Necesita dónde quedarse', ayuda: '' },
  { valor: 'SERVICIOS_CAIDOS', etiqueta: 'Sin luz, agua o señal', ayuda: '' },
  { valor: 'OTRO', etiqueta: 'Otra cosa', ayuda: 'Explíquelo en la descripción' },
];

const SEVERIDADES: { valor: string; etiqueta: string }[] = [
  { valor: 'DESCONOCIDA', etiqueta: 'No sé' },
  { valor: 'CRITICA', etiqueta: 'Hay vidas en peligro ahora' },
  { valor: 'ALTA', etiqueta: 'Grave, pero no inmediato' },
  { valor: 'MEDIA', etiqueta: 'Urgente, sin peligro de vida' },
  { valor: 'BAJA', etiqueta: 'Daño material solamente' },
];

const MAX_FOTOS = 3;

/**
 * Por encima de esto la ubicación deja de servir para mandar a alguien.
 *
 * 150 m es aproximadamente una manzana y media: con eso todavía se puede llegar
 * preguntando. Más allá, el punto señala una zona y no un sitio — y es justo lo
 * que devuelve el navegador cuando estima por red en vez de usar el GPS. En la
 * beta llegó un reporte con 2 km de radio.
 */
const PRECISION_ACEPTABLE_M = 150;

export function Reportar() {
  const [categoria, setCategoria] = useState('');
  const [severidad, setSeveridad] = useState('DESCONOCIDA');
  const [descripcion, setDescripcion] = useState('');
  const [contacto, setContacto] = useState('');
  const [afectadas, setAfectadas] = useState('');
  const [atrapadas, setAtrapadas] = useState('');
  const [heridas, setHeridas] = useState('');
  const [vulnerables, setVulnerables] = useState('');
  const [requiereRescate, setRequiereRescate] = useState(false);

  const [ubicacion, setUbicacion] = useState<EstadoUbicacion>({ fase: 'inactiva' });
  const [latManual, setLatManual] = useState('');
  const [lngManual, setLngManual] = useState('');
  const [mostrarManual, setMostrarManual] = useState(false);

  const [fotos, setFotos] = useState<{ blob: Blob; nombre: string; original: number }[]>([]);
  const [procesandoFoto, setProcesandoFoto] = useState(false);

  const [guardando, setGuardando] = useState(false);
  const [ultimoGuardado, setUltimoGuardado] = useState<string | null>(null);
  const [bandeja, setBandeja] = useState<ElementoBandeja[]>([]);

  // Pedir la ubicación al abrir: es el dato que más tarda, así que conviene
  // arrancarlo mientras la persona escoge el tipo de emergencia.
  useEffect(() => {
    void solicitarUbicacion();
  }, []);

  useEffect(() => {
    const refrescar = () => void listarBandeja().then(setBandeja);
    void refrescar();
    return alCambiarBandeja(refrescar);
  }, []);

  async function solicitarUbicacion() {
    setUbicacion({ fase: 'buscando' });
    try {
      const posicion = await obtenerUbicacion();
      setUbicacion({ fase: 'lista', ubicacion: posicion });
    } catch (error) {
      setUbicacion({
        fase: 'error',
        mensaje: error instanceof Error ? error.message : 'No se pudo obtener la ubicación',
        puedeReintentar: true,
      });
      setMostrarManual(true);
    }
  }

  async function agregarFotos(archivos: FileList | null) {
    if (!archivos || archivos.length === 0) return;
    setProcesandoFoto(true);

    try {
      const nuevas = [...fotos];
      for (const archivo of Array.from(archivos).slice(0, MAX_FOTOS - fotos.length)) {
        const reducida = await reducirFoto(archivo);
        nuevas.push({
          blob: reducida.blob,
          nombre: archivo.name,
          original: reducida.bytes_originales,
        });
      }
      setFotos(nuevas);
    } catch (error) {
      // Que falle una foto no debe impedir enviar el reporte.
      console.warn('No se pudo procesar la foto', error);
    } finally {
      setProcesandoFoto(false);
    }
  }

  function coordenadasElegidas(): { lat: number; lng: number; precision?: number } | null {
    if (mostrarManual && latManual && lngManual) {
      const lat = Number.parseFloat(latManual.replace(',', '.'));
      const lng = Number.parseFloat(lngManual.replace(',', '.'));
      if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
    }
    if (ubicacion.fase === 'lista') {
      return {
        lat: ubicacion.ubicacion.lat,
        lng: ubicacion.ubicacion.lng,
        precision: ubicacion.ubicacion.precision_m,
      };
    }
    return null;
  }

  const coordenadas = coordenadasElegidas();
  const coordenadasValidas =
    coordenadas !== null && dentroDeColombia(coordenadas.lat, coordenadas.lng);
  const puedeEnviar = categoria !== '' && coordenadasValidas && !guardando;

  async function enviar(evento: React.FormEvent) {
    evento.preventDefault();
    if (!puedeEnviar || !coordenadas) return;

    setGuardando(true);
    try {
      const entero = (valor: string) => {
        const numero = Number.parseInt(valor, 10);
        return Number.isFinite(numero) && numero > 0 ? numero : 0;
      };

      const carga: CargaReporte = {
        id_cliente: crypto.randomUUID(),
        categoria,
        severidad,
        lat: coordenadas.lat,
        lng: coordenadas.lng,
        personas_afectadas: entero(afectadas),
        personas_atrapadas: entero(atrapadas),
        personas_heridas: entero(heridas),
        personas_fallecidas: 0,
        personas_vulnerables: entero(vulnerables),
        requiere_rescate: requiereRescate,
        reportado_en: new Date().toISOString(),
      };

      if (descripcion.trim()) carga.descripcion = descripcion.trim();
      if (contacto.trim()) carga.contacto_reportante = contacto.trim();
      if (coordenadas.precision !== undefined) {
        carga.precision_ubicacion_m = Math.round(coordenadas.precision);
      }

      // Paso crítico: primero al almacenamiento local. A partir de acá el
      // reporte existe aunque se caiga la red, se cierre el navegador o se
      // apague el teléfono. `agregarALaBandeja` guarda, refresca la pantalla y
      // recién entonces intenta enviar.
      await agregarALaBandeja(
        carga,
        fotos.map((foto) => foto.blob),
      );

      setUltimoGuardado(carga.id_cliente);

      // Limpiar el formulario, conservando el contacto: si alguien reporta
      // varias cosas del mismo sitio, volver a escribir su celular es fricción
      // innecesaria.
      setCategoria('');
      setSeveridad('DESCONOCIDA');
      setDescripcion('');
      setAfectadas('');
      setAtrapadas('');
      setHeridas('');
      setVulnerables('');
      setRequiereRescate(false);
      setFotos([]);
    } finally {
      setGuardando(false);
    }
  }

  const recienGuardado = ultimoGuardado
    ? bandeja.find((elemento) => elemento.id_cliente === ultimoGuardado)
    : undefined;

  const pendientes = bandeja.filter(
    (elemento) => elemento.estado === 'pendiente' || elemento.estado === 'enviando',
  );

  return (
    <div className="pagina-reportar">
      <header className="encabezado">
        <h1>Reportar una emergencia</h1>
        <p className="subtitulo">
          Solo hacen falta dos cosas: dónde está y qué pasó. Lo demás es opcional.
        </p>
      </header>

      {recienGuardado && (
        <div
          className={`confirmacion ${recienGuardado.estado === 'confirmado' ? 'enviada' : 'guardada'}`}
          role="status"
        >
          {recienGuardado.estado === 'confirmado' ? (
            <>
              <strong>Reporte enviado.</strong> Su código es{' '}
              <code>{recienGuardado.codigo_publico}</code>. Anótelo: con ese código
              puede consultar su caso más abajo.
              {/* Compartir por WhatsApp no es un adorno de producto: en una
                  emergencia la coordinación pasa por ahí de todas formas, y un
                  vecino que reenvía el código está avisando a quien sí puede
                  llegar. Se usa el enlace wa.me, que abre la app instalada. */}
              <div className="acciones-confirmacion">
                <a
                  className="boton-compartir"
                  href={`https://wa.me/?text=${encodeURIComponent(
                    `Reporté una emergencia. Código ${recienGuardado.codigo_publico}. ` +
                      `Se puede consultar en ${location.origin}/?vista=reportar`,
                  )}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Compartir por WhatsApp
                </a>
                <button
                  type="button"
                  className="enlace"
                  onClick={() =>
                    void navigator.clipboard?.writeText(recienGuardado.codigo_publico ?? '')
                  }
                >
                  copiar el código
                </button>
              </div>
            </>
          ) : (
            <>
              <strong>Reporte guardado en este dispositivo.</strong> Se enviará solo
              cuando haya señal. No hace falta que deje la aplicación abierta.
            </>
          )}
        </div>
      )}

      <form onSubmit={enviar} className="formulario">
        {/* ---------------- Ubicación ---------------- */}
        <fieldset>
          <legend>1. Dónde está</legend>

          {ubicacion.fase === 'buscando' && <p className="cargando">Buscando su ubicación…</p>}

          {ubicacion.fase === 'lista' && (
            <p className="ubicacion-ok">
              Ubicación obtenida:{' '}
              <code>
                {formatearCoordenada(ubicacion.ubicacion.lat)},{' '}
                {formatearCoordenada(ubicacion.ubicacion.lng)}
              </code>
              <br />
              <small>{describirPrecision(ubicacion.ubicacion.precision_m)}</small>
            </p>
          )}

          {/* Una ubicación con cientos de metros de error no sirve para mandar a
              nadie: es la que da el navegador cuando no hay permiso de GPS y
              estima por la red. Ya se mostraba la precisión en letra pequeña y
              en la beta alguien envió un reporte con 2 km de radio — la vio y
              siguió. Así que se dice fuerte y se ofrece la salida, pero **no se
              bloquea el envío**: un reporte con mala ubicación sigue siendo
              mejor que ninguno. */}
          {ubicacion.fase === 'lista' &&
            ubicacion.ubicacion.precision_m > PRECISION_ACEPTABLE_M && (
              <div className="aviso-precision" role="alert">
                <strong>Esta ubicación es muy imprecisa.</strong> El punto puede estar a{' '}
                {ubicacion.ubicacion.precision_m >= 1000
                  ? `${(ubicacion.ubicacion.precision_m / 1000).toFixed(1)} km`
                  : `${Math.round(ubicacion.ubicacion.precision_m)} m`}{' '}
                de donde usted está, y así es difícil que alguien lo encuentre.
                <div className="acciones-precision">
                  <button type="button" onClick={() => void solicitarUbicacion()}>
                    Intentar de nuevo
                  </button>
                  <button
                    type="button"
                    className="enlace"
                    onClick={() => setMostrarManual(true)}
                  >
                    escribir las coordenadas a mano
                  </button>
                </div>
                <small>
                  Suele mejorar si sale al aire libre o si le da permiso de ubicación a la
                  aplicación. Si no puede, envíelo igual y describa el sitio con
                  referencias.
                </small>
              </div>
            )}

          {ubicacion.fase === 'error' && (
            <p className="error" role="alert">
              {ubicacion.mensaje}
            </p>
          )}

          <div className="acciones-ubicacion">
            <button type="button" onClick={() => void solicitarUbicacion()}>
              {ubicacion.fase === 'lista' ? 'Actualizar ubicación' : 'Obtener mi ubicación'}
            </button>
            <button type="button" className="enlace" onClick={() => setMostrarManual(!mostrarManual)}>
              {mostrarManual ? 'Usar el GPS' : 'Escribir coordenadas a mano'}
            </button>
          </div>

          {mostrarManual && (
            <div className="coordenadas-manuales">
              <label>
                Latitud
                <input
                  type="text"
                  inputMode="decimal"
                  value={latManual}
                  onChange={(e) => setLatManual(e.target.value)}
                  placeholder="4.610000"
                />
              </label>
              <label>
                Longitud
                <input
                  type="text"
                  inputMode="decimal"
                  value={lngManual}
                  onChange={(e) => setLngManual(e.target.value)}
                  placeholder="-74.080000"
                />
              </label>
            </div>
          )}

          {coordenadas && !coordenadasValidas && (
            <p className="error" role="alert">
              Esas coordenadas quedan fuera de Colombia. Revise si están invertidas
              o si a la longitud le falta el signo menos.
            </p>
          )}
        </fieldset>

        {/* ---------------- Qué pasó ---------------- */}
        <fieldset>
          <legend>2. Qué pasó</legend>

          <div className="opciones-categoria">
            {CATEGORIAS.map((opcion) => (
              <label
                key={opcion.valor}
                className={`tarjeta-opcion ${categoria === opcion.valor ? 'elegida' : ''}`}
              >
                <input
                  type="radio"
                  name="categoria"
                  value={opcion.valor}
                  checked={categoria === opcion.valor}
                  onChange={() => setCategoria(opcion.valor)}
                />
                <span className="etiqueta">{opcion.etiqueta}</span>
                {opcion.ayuda && <span className="ayuda">{opcion.ayuda}</span>}
              </label>
            ))}
          </div>

          <label className="campo">
            Qué tan grave es
            <select value={severidad} onChange={(e) => setSeveridad(e.target.value)}>
              {SEVERIDADES.map((opcion) => (
                <option key={opcion.valor} value={opcion.valor}>
                  {opcion.etiqueta}
                </option>
              ))}
            </select>
            {/* "No sé" es una respuesta legítima y no castiga en la cola: vale
                media tabla, no el fondo. */}
            <small>Si no está seguro, deje «No sé». No perjudica su reporte.</small>
          </label>

          <label className="campo">
            Cuéntelo con sus palabras <span className="opcional">(opcional)</span>
            <textarea
              value={descripcion}
              onChange={(e) => setDescripcion(e.target.value)}
              rows={4}
              maxLength={4000}
              placeholder="Ej: estamos atrapados en una casa cerca del parque, somos 5 y una señora está herida."
            />
            <small>
              Escriba como hable. El sistema lee este texto para completar los datos
              que no llenó; una persona revisa antes de despachar.
            </small>
          </label>
        </fieldset>

        {/* ---------------- Personas ---------------- */}
        <fieldset>
          <legend>
            3. Cuántas personas <span className="opcional">(opcional)</span>
          </legend>
          <p className="nota-campo">
            Si sabe las cifras, escríbalas: son más confiables que lo que el sistema
            pueda deducir del texto y hacen que su reporte se ordene mejor.
          </p>

          <div className="rejilla-conteos">
            <label>
              En total
              <input
                type="number"
                min="0"
                inputMode="numeric"
                value={afectadas}
                onChange={(e) => setAfectadas(e.target.value)}
              />
            </label>
            <label>
              Atrapadas
              <input
                type="number"
                min="0"
                inputMode="numeric"
                value={atrapadas}
                onChange={(e) => setAtrapadas(e.target.value)}
              />
            </label>
            <label>
              Heridas
              <input
                type="number"
                min="0"
                inputMode="numeric"
                value={heridas}
                onChange={(e) => setHeridas(e.target.value)}
              />
            </label>
            <label>
              Niños, mayores
              <input
                type="number"
                min="0"
                inputMode="numeric"
                value={vulnerables}
                onChange={(e) => setVulnerables(e.target.value)}
              />
            </label>
          </div>

          <label className="casilla">
            <input
              type="checkbox"
              checked={requiereRescate}
              onChange={(e) => setRequiereRescate(e.target.checked)}
            />
            Hay personas que no pueden salir por sus propios medios
          </label>
        </fieldset>

        {/* ---------------- Fotos y contacto ---------------- */}
        <fieldset>
          <legend>
            4. Fotos y contacto <span className="opcional">(opcional)</span>
          </legend>

          <label className="campo">
            Fotos (hasta {MAX_FOTOS})
            <input
              type="file"
              accept="image/*"
              multiple
              capture="environment"
              disabled={fotos.length >= MAX_FOTOS || procesandoFoto}
              onChange={(e) => void agregarFotos(e.target.files)}
            />
            <small>
              Se reducen en su teléfono antes de guardarlas, para que suban aunque la
              red esté mala. Se envían después del reporte.
            </small>
          </label>

          {procesandoFoto && <p className="cargando">Procesando la foto…</p>}

          {fotos.length > 0 && (
            <ul className="lista-fotos">
              {fotos.map((foto, indice) => (
                <li key={indice}>
                  {foto.nombre} — {formatearBytes(foto.original)} →{' '}
                  <strong>{formatearBytes(foto.blob.size)}</strong>
                  <button
                    type="button"
                    className="enlace"
                    onClick={() => setFotos(fotos.filter((_, i) => i !== indice))}
                  >
                    quitar
                  </button>
                </li>
              ))}
            </ul>
          )}

          <label className="campo">
            Un teléfono o forma de contactarlo
            <input
              type="text"
              value={contacto}
              onChange={(e) => setContacto(e.target.value)}
              placeholder="300 123 4567, o «radio de la JAC canal 2»"
              maxLength={200}
            />
            <small>No es obligatorio. Puede reportar sin identificarse.</small>
          </label>
        </fieldset>

        <button type="submit" className="boton-principal" disabled={!puedeEnviar}>
          {guardando ? 'Guardando…' : 'Enviar reporte'}
        </button>

        {!puedeEnviar && !guardando && (
          <p className="nota-campo">
            {categoria === ''
              ? 'Escoja qué pasó para poder enviar.'
              : 'Hace falta la ubicación para poder enviar.'}
          </p>
        )}
      </form>

      {/* ---------------- Bandeja de salida ---------------- */}
      {bandeja.length > 0 && (
        <section className="bandeja">
          <h2>
            Sus reportes{' '}
            {pendientes.length > 0 && (
              <span className="insignia">{pendientes.length} por enviar</span>
            )}
          </h2>
          <ul>
            {bandeja.map((elemento) => (
              <li key={elemento.id_cliente} className={`elemento ${elemento.estado}`}>
                <div className="fila-principal">
                  <span className="categoria">
                    {CATEGORIAS.find((c) => c.valor === elemento.carga.categoria)?.etiqueta ??
                      elemento.carga.categoria}
                  </span>
                  <span className={`estado ${elemento.estado}`}>
                    {elemento.estado === 'confirmado' && elemento.codigo_publico
                      ? elemento.codigo_publico
                      : elemento.estado === 'pendiente'
                        ? 'por enviar'
                        : elemento.estado === 'enviando'
                          ? 'enviando…'
                          : 'rechazado'}
                  </span>
                </div>
                <small>
                  {new Date(elemento.creado_en).toLocaleString('es-CO')}
                  {elemento.fotos_pendientes > 0 && ` · ${elemento.fotos_pendientes} foto(s) por subir`}
                  {elemento.intentos > 0 && elemento.estado !== 'confirmado' &&
                    ` · ${elemento.intentos} intento(s)`}
                </small>
                {elemento.estado === 'rechazado' && (
                  <small className="error">
                    El servidor no aceptó este reporte. Vuelva a crearlo revisando los datos.
                  </small>
                )}
              </li>
            ))}
          </ul>
          <button type="button" onClick={() => void sincronizarBandeja()}>
            Intentar enviar ahora
          </button>
        </section>
      )}

      {/* La bandeja de arriba muestra lo que este teléfono envió; esto sirve
          para cualquier código, también el de un vecino o el que alguien dictó
          por teléfono. Va al final porque quien abre la app casi siempre viene
          a reportar, no a consultar. */}
      <ConsultarCaso />
    </div>
  );
}
