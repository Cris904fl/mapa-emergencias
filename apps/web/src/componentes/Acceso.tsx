import { useState } from 'react';
import { api, fijarToken } from '../lib/api.ts';

/**
 * Inicio de sesión para personal de socorro.
 *
 * Compartido entre el tablero y la pantalla de campo. No hay registro público:
 * las cuentas las crea quien administra el despliegue
 * (`npm run clave --workspace=@emergencias/api`).
 */
export function Acceso({
  autenticado,
  onCambio,
  compacto = false,
}: {
  autenticado: boolean;
  onCambio: (valor: boolean, usuario?: { nombre: string | null; rol: string }) => void;
  /** En campo el formulario ocupa la pantalla; en el tablero va en la cabecera. */
  compacto?: boolean;
}) {
  const [abierto, setAbierto] = useState(false);
  const [correo, setCorreo] = useState('');
  const [clave, setClave] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [entrando, setEntrando] = useState(false);

  if (autenticado) {
    return (
      <button
        type="button"
        className="enlace"
        onClick={() => {
          fijarToken(null);
          onCambio(false);
        }}
      >
        Cerrar sesión
      </button>
    );
  }

  if (compacto && !abierto) {
    return (
      <button type="button" onClick={() => setAbierto(true)}>
        Iniciar sesión
      </button>
    );
  }

  return (
    <form
      className={compacto ? 'acceso' : 'acceso acceso-amplio'}
      onSubmit={async (evento) => {
        evento.preventDefault();
        setEntrando(true);
        try {
          const { token, usuario } = await api.iniciarSesion(correo, clave);
          fijarToken(token);
          setError(null);
          setAbierto(false);
          onCambio(true, usuario);
        } catch {
          setError('Credenciales inválidas');
        } finally {
          setEntrando(false);
        }
      }}
    >
      {!compacto && <h2>Entrar</h2>}
      <input
        type="email"
        value={correo}
        onChange={(e) => setCorreo(e.target.value)}
        placeholder="correo"
        autoComplete="username"
        required
      />
      <input
        type="password"
        value={clave}
        onChange={(e) => setClave(e.target.value)}
        placeholder="clave"
        autoComplete="current-password"
        required
      />
      <button type="submit" disabled={entrando}>
        {entrando ? 'Entrando…' : 'Entrar'}
      </button>
      {error && (
        <span className="error" role="alert">
          {error}
        </span>
      )}
    </form>
  );
}
