import { useEffect, useState } from 'react';
import { Reportar } from './paginas/Reportar.tsx';
import { Tablero } from './paginas/Tablero.tsx';
import { iniciarSincronizacionAutomatica } from './lib/bandeja.ts';

type Vista = 'reportar' | 'tablero';

function vistaInicial(): Vista {
  const parametro = new URLSearchParams(location.search).get('vista');
  return parametro === 'tablero' ? 'tablero' : 'reportar';
}

export function App() {
  const [vista, setVista] = useState<Vista>(vistaInicial);
  const [enLinea, setEnLinea] = useState(navigator.onLine);

  // El sincronizador arranca una sola vez, a nivel de aplicación: es un proceso
  // de fondo que debe seguir corriendo aunque el usuario cambie de vista.
  useEffect(() => iniciarSincronizacionAutomatica(), []);

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

      <nav className="navegacion" aria-label="Secciones">
        <button
          type="button"
          className={vista === 'reportar' ? 'activa' : ''}
          onClick={() => cambiarVista('reportar')}
          aria-current={vista === 'reportar' ? 'page' : undefined}
        >
          Reportar
        </button>
        <button
          type="button"
          className={vista === 'tablero' ? 'activa' : ''}
          onClick={() => cambiarVista('tablero')}
          aria-current={vista === 'tablero' ? 'page' : undefined}
        >
          Tablero
        </button>
      </nav>

      <main>{vista === 'reportar' ? <Reportar /> : <Tablero />}</main>
    </div>
  );
}
