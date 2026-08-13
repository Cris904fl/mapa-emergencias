import { useEffect, useState } from 'react';
import { Reportar } from './paginas/Reportar.tsx';
import { Tablero } from './paginas/Tablero.tsx';
import { Campo } from './paginas/Campo.tsx';
import { iniciarSincronizacionAutomatica } from './lib/bandeja.ts';
import { hayVersionNueva } from './lib/version.ts';
import {
  ETIQUETAS,
  alCambiarElSistema,
  aplicar,
  guardar,
  siguiente,
  temaGuardado,
  type Tema,
} from './lib/tema.ts';

/**
 * Cada cuánto se pregunta si hay una versión nueva desplegada.
 *
 * Diez minutos: es una petición del HTML, que pesa unos pocos kilobytes y la
 * sirve el Worker de Cloudflare, así que el costo es despreciable. Más seguido
 * no aporta —nadie despliega cada minuto— y más espaciado deja a alguien de
 * guardia media hora con código viejo sin saberlo.
 */
const INTERVALO_VERSION_MS = 600_000;

type Vista = 'reportar' | 'campo' | 'tablero';

const VISTAS: { id: Vista; etiqueta: string }[] = [
  { id: 'reportar', etiqueta: 'Reportar' },
  { id: 'campo', etiqueta: 'Atender' },
  { id: 'tablero', etiqueta: 'Tablero' },
];

function vistaInicial(): Vista {
  const parametro = new URLSearchParams(location.search).get('vista');
  return VISTAS.some((vista) => vista.id === parametro) ? (parametro as Vista) : 'reportar';
}

export function App() {
  const [vista, setVista] = useState<Vista>(vistaInicial);
  const [enLinea, setEnLinea] = useState(navigator.onLine);
  const [versionVieja, setVersionVieja] = useState(false);

  /**
   * El tema arranca de lo guardado, no de un valor por defecto: el script en
   * línea de `index.html` ya lo aplicó antes de pintar, así que leer lo mismo acá
   * deja al botón mostrando el estado real desde el primer instante.
   */
  const [tema, setTema] = useState<Tema>(temaGuardado);

  // Repintar cuando el sistema cambia de tema, pero solo mientras nadie haya
  // elegido a mano: a quien puso «claro» no se le cambia la pantalla al
  // atardecer.
  useEffect(() => {
    if (tema !== 'sistema') return;
    return alCambiarElSistema(() => aplicar('sistema'));
  }, [tema]);

  function cambiarTema() {
    const nuevo = siguiente(tema);
    setTema(nuevo);
    guardar(nuevo);
  }

  // El sincronizador arranca una sola vez, a nivel de aplicación: es un proceso
  // de fondo que debe seguir corriendo aunque el usuario cambie de vista.
  useEffect(() => iniciarSincronizacionAutomatica(), []);

  /**
   * Vigilar si se desplegó una versión nueva.
   *
   * Se comprueba también al volver a la pestaña, porque es justo el momento en
   * que alguien retoma el tablero después de un rato y va a fiarse de lo que ve.
   *
   * No se comprueba al arrancar: la página acaba de cargarse, así que por
   * definición tiene la versión que el servidor está sirviendo.
   */
  useEffect(() => {
    let vivo = true;

    async function comprobar() {
      if (document.hidden) return;
      if (await hayVersionNueva()) {
        if (vivo) setVersionVieja(true);
      }
    }

    const temporizador = window.setInterval(() => void comprobar(), INTERVALO_VERSION_MS);
    const alVolver = () => void comprobar();
    document.addEventListener('visibilitychange', alVolver);

    return () => {
      vivo = false;
      window.clearInterval(temporizador);
      document.removeEventListener('visibilitychange', alVolver);
    };
  }, []);

  useEffect(() => {
    const actualizar = () => setEnLinea(navigator.onLine);
    window.addEventListener('online', actualizar);
    window.addEventListener('offline', actualizar);
    return () => {
      window.removeEventListener('online', actualizar);
      window.removeEventListener('offline', actualizar);
    };
  }, []);

  function cambiarVista(nueva: Vista) {
    setVista(nueva);
    const url = new URL(location.href);
    url.searchParams.set('vista', nueva);
    history.replaceState(null, '', url);
  }

  return (
    <div className="aplicacion">
      {/* Aviso de conexión siempre visible. En una emergencia el usuario tiene
          que saber, sin buscarlo, si lo que está haciendo salió o se quedó
          guardado en el teléfono. */}
      {!enLinea && (
        <div className="aviso-sin-red" role="status">
          Sin conexión. Los reportes se guardan en este dispositivo y se envían
          solos cuando vuelva la señal.
        </div>
      )}

      {/* Avisa, no recarga.
          Recargarle la pantalla a alguien que está despachando equipos —o a un
          ciudadano a medio llenar el formulario— es peor que dejarlo con código
          viejo: se perdería lo que está escribiendo. Se dice que hay algo nuevo
          y decide quien está trabajando.

          Va después del aviso de conexión a propósito: quedarse sin señal es más
          urgente que estar una versión atrás. */}
      {versionVieja && (
        <div className="aviso-version" role="status">
          <span>Hay una versión nueva de la aplicación.</span>
          <button type="button" onClick={() => location.reload()}>
            Recargar
          </button>
        </div>
      )}

      <nav className="navegacion" aria-label="Secciones">
        {VISTAS.map((opcion) => (
          <button
            key={opcion.id}
            type="button"
            className={vista === opcion.id ? 'activa' : ''}
            onClick={() => cambiarVista(opcion.id)}
            aria-current={vista === opcion.id ? 'page' : undefined}
          >
            {opcion.etiqueta}
          </button>
        ))}

        {/* El tema, al otro extremo de la barra.
            Lejos de las tres secciones a propósito: es un ajuste, no una parte
            del trabajo, y en la pantalla del ciudadano no debe competir con
            «Enviar reporte». Un solo botón que rota entre automático, claro y
            oscuro — el nombre del estado va en el texto accesible y no en un
            icono suelto, porque un sol y una luna no dicen cuál de los dos está
            activo ni que exista el automático. */}
        <button
          type="button"
          className="boton-tema"
          onClick={cambiarTema}
          title={`Tema: ${ETIQUETAS[tema].nombre}. Toque para cambiar.`}
          aria-label={`Tema ${ETIQUETAS[tema].nombre}. Toque para cambiar.`}
        >
          <span aria-hidden="true">{ETIQUETAS[tema].icono}</span>
          <span className="nombre-tema">{ETIQUETAS[tema].nombre}</span>
        </button>
      </nav>

      <main>
        {vista === 'reportar' && <Reportar />}
        {vista === 'campo' && <Campo />}
        {vista === 'tablero' && <Tablero onIrACampo={() => cambiarVista('campo')} />}
      </main>
    </div>
  );
}
