import { useState } from 'react';
import { api, ErrorApi, type CasoConsultado } from '../lib/api.ts';
import { GaleriaMedios } from './GaleriaMedios.tsx';

/**
 * Consulta de un caso por su código público.
 *
 * Existe porque la app ya se lo prometía a la gente: al confirmar un reporte
 * dice «anótelo, con ese código puede preguntar por su caso» — y hasta ahora no
 * había dónde preguntar. Un código que no sirve para nada es peor que no dar
 * ninguno, porque hace creer que hay un canal abierto.
 *
 * Lo que se muestra está pensado para quien reportó, no para un operador: qué
 * está pasando con su caso y cuándo, sin puntajes ni desgloses. La pregunta que
 * trae a alguien acá es «¿alguien vio lo que mandé?».
 */

const ESTADOS_LEGIBLES: Record<string, { titulo: string; explicacion: string }> = {
  RECIBIDO: {
    titulo: 'Recibido',
    explicacion:
      'Su reporte llegó y está en la lista. Todavía nadie lo ha revisado, y no hay ' +
      'un plazo para que lo hagan.',
  },
  EN_TRIAGE: {
    titulo: 'En revisión',
    explicacion: 'Alguien está mirando su reporte para decidir qué hacer.',
  },
  VERIFICADO: {
    titulo: 'Verificado',
    explicacion: 'Se confirmó lo que reportó. Está a la espera de que se le asigne un equipo.',
  },
  ASIGNADO: {
    titulo: 'Asignado',
    explicacion: 'Hay un equipo a cargo de su caso.',
  },
  EN_ATENCION: {
    titulo: 'En atención',
    explicacion: 'El equipo llegó al sitio y está trabajando.',
  },
  RESUELTO: {
    titulo: 'Resuelto',
    explicacion: 'El caso se cerró.',
  },
  DUPLICADO: {
    titulo: 'Duplicado',
    explicacion: 'Su reporte se unió a otro del mismo hecho. La atención sigue por ese.',
  },
  DESCARTADO: {
    titulo: 'Descartado',
    explicacion: 'El caso se cerró sin atención. Si cree que fue un error, vuelva a reportar.',
  },
};

function fecha(iso: string): string {
  return new Date(iso).toLocaleString('es-CO', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function ConsultarCaso() {
  const [codigo, setCodigo] = useState('');
  const [caso, setCaso] = useState<CasoConsultado | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [buscando, setBuscando] = useState(false);

  async function buscar(evento: React.FormEvent) {
    evento.preventDefault();
    if (!codigo.trim()) return;

    setBuscando(true);
    setError(null);
    setCaso(null);

    try {
      setCaso(await api.consultarPorCodigo(codigo));
    } catch (problema) {
      // El 404 es el caso frecuente y merece su propio mensaje: casi siempre es
      // un código mal copiado, no un reporte perdido.
      setError(
        problema instanceof ErrorApi && problema.estado === 404
          ? 'No encontramos ningún reporte con ese código. Revise que esté bien copiado.'
          : 'No se pudo consultar ahora. Intente de nuevo en un momento.',
      );
    } finally {
      setBuscando(false);
    }
  }

  const estado = caso ? ESTADOS_LEGIBLES[caso.properties.estado] : undefined;

  return (
    <section className="consultar-caso" aria-labelledby="titulo-consulta">
      <h2 id="titulo-consulta">¿Ya reportó? Consulte su caso</h2>
      <p className="nota-panel">
        Escriba el código que le dimos al enviar el reporte. Tiene la forma
        <code> RPT-XXXXX</code>.
      </p>

      <form onSubmit={buscar} className="formulario-consulta">
        <label>
          Código del reporte
          <input
            type="text"
            value={codigo}
            onChange={(evento) => setCodigo(evento.target.value)}
            placeholder="RPT-XXXXX"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            maxLength={20}
          />
        </label>
        <button type="submit" className="principal" disabled={buscando || !codigo.trim()}>
          {buscando ? 'Consultando…' : 'Consultar'}
        </button>
      </form>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {caso && (
        <div className="resultado-consulta">
          <div className={`estado-caso-grande estado-${caso.properties.estado.toLowerCase()}`}>
            <span className="etiqueta-estado">{estado?.titulo ?? caso.properties.estado}</span>
            <p>{estado?.explicacion ?? ''}</p>
          </div>

          {/* Quien llega hasta acá vino a preguntar «¿alguien vio lo que mandé?»,
              y con el sistema como está hoy la respuesta suele ser que no.
              Decírselo sin darle a dónde acudir sería dejarlo peor que antes de
              consultar. */}
          {caso.properties.estado === 'RECIBIDO' && (
            <p className="recordar-linea-oficial">
              Si sigue siendo una emergencia, no espere por aquí:{' '}
              <strong>
                llame al <a href="tel:123">123</a>
              </strong>
              .
            </p>
          )}

          <dl className="datos-caso">
            <dt>Código</dt>
            <dd>
              <code>{caso.properties.codigo_publico}</code>
            </dd>
            <dt>Tipo</dt>
            <dd>{caso.properties.categoria.replaceAll('_', ' ').toLowerCase()}</dd>
            <dt>Reportado</dt>
            <dd>{fecha(caso.properties.reportado_en)}</dd>
            {caso.properties.lugar && (
              <>
                <dt>Zona</dt>
                <dd>{caso.properties.lugar}</dd>
              </>
            )}
          </dl>

          {/* La foto se muestra acá por una razón distinta a la del rescatista:
              no es para ver el daño —quien reportó estaba ahí— sino para
              confirmar que la subida funcionó. La app dice «se envían después
              del reporte» y hasta ahora no volvía a mencionarlo nunca. */}
          <GaleriaMedios medios={caso.medios} titulo="Lo que usted envió" />

          {/* La bitácora es lo que de verdad responde «¿alguien vio esto?».
              Se muestra completa y en orden: no hay nada que esconderle a
              quien reportó sobre lo que pasó con su propio caso. */}
          {caso.historial.length > 0 && (
            <>
              <h3>Qué ha pasado</h3>
              <ol className="linea-tiempo">
                {caso.historial.map((paso, indice) => (
                  <li key={`${paso.creado_en}-${indice}`}>
                    <span className="momento">{fecha(paso.creado_en)}</span>
                    <span className="que-paso">
                      {ESTADOS_LEGIBLES[paso.estado_nuevo]?.titulo ?? paso.estado_nuevo}
                      {paso.nota && <span className="nota-paso"> · {paso.nota}</span>}
                    </span>
                  </li>
                ))}
              </ol>
            </>
          )}
        </div>
      )}
    </section>
  );
}
