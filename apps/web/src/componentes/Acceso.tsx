import { useState } from 'react';
import { api, fijarToken } from '../lib/api.ts';

/**
 * Inicio de sesión para personal de socorro.
 *
 * Se entra únicamente desde la vista «Atender». El tablero no ofrece login: ahí
 * la sesión solo habilita acciones sobre reportes, mientras que en campo es la
 * puerta de entrada. Tener un solo lugar donde autenticarse evita que alguien
 * quede con sesión abierta desde una pantalla y crea que la tiene en la otra.
 *
 * Está pensada para alguien parado en la calle, con una mano ocupada, quizá con
 * el celular al sol y con prisa. De ahí:
 *
 *   · Etiquetas de verdad sobre cada campo, no placeholders. Un placeholder
 *     desaparece al escribir, así que quien se distrae ya no sabe qué campo es —
 *     y los lectores de pantalla lo anuncian mal.
 *   · Botón de mostrar la clave: escribir una contraseña a ciegas en un teclado
 *     táctil, con lluvia o con guantes, falla mucho.
 *   · El error va en un bloque con `role="alert"`, no en un texto suelto al lado
 *     del botón que es fácil de no ver.
 */

/** Cuentas de los datos de prueba. Solo se muestran en desarrollo. */
const CUENTAS_DEMO = [
  { correo: 'socorrista@demo.local', rol: 'Rescatista', para: 'atender casos en campo' },
  { correo: 'operadora@demo.local', rol: 'Operadora', para: 'triage en la sala de crisis' },
  { correo: 'admin@demo.local', rol: 'Administrador', para: 'todo' },
];
const CLAVE_DEMO = 'demo1234';

export function Acceso({
  autenticado,
  onCambio,
}: {
  autenticado: boolean;
  onCambio: (valor: boolean, usuario?: { nombre: string | null; rol: string }) => void;
}) {
  const [correo, setCorreo] = useState('');
  const [clave, setClave] = useState('');
  const [verClave, setVerClave] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [entrando, setEntrando] = useState(false);

  async function entrar(evento: React.FormEvent) {
    evento.preventDefault();
    setEntrando(true);
    try {
      const { token, usuario } = await api.iniciarSesion(correo.trim(), clave);
      fijarToken(token);
      setError(null);
      setClave('');
      onCambio(true, usuario);
    } catch {
      // Mismo mensaje para correo inexistente y clave errada: decir cuál de los
      // dos falló revelaría qué cuentas existen.
      setError('Correo o clave incorrectos.');
    } finally {
      setEntrando(false);
    }
  }

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

  return (
    <div className="pantalla-acceso">
      <div className="tarjeta-acceso">
        <div className="marca-acceso" aria-hidden="true">
          <svg viewBox="0 0 48 48" width="44" height="44">
            <path
              d="M24 5c-7 0-12.6 5.6-12.6 12.6C11.4 26.4 24 41 24 41s12.6-14.6 12.6-23.4C36.6 10.6 31 5 24 5z"
              fill="currentColor"
            />
            <rect x="21.8" y="11" width="4.4" height="10.5" rx="2.2" fill="#fff" />
            <circle cx="24" cy="25.5" r="2.6" fill="#fff" />
          </svg>
        </div>

        <h1>Atención en campo</h1>
        <p className="descripcion-acceso">
          Entre con su cuenta de socorro para ver los casos cerca de usted, tomarlos y
          cerrarlos.
        </p>

        <form onSubmit={entrar} className="formulario-acceso">
          {/* Etiqueta visible, no placeholder: no desaparece al escribir. */}
          <label className="campo-acceso">
            <span className="etiqueta-campo">Correo</span>
            <input
              type="email"
              value={correo}
              onChange={(e) => setCorreo(e.target.value)}
              autoComplete="username"
              inputMode="email"
              autoCapitalize="none"
              spellCheck={false}
              enterKeyHint="next"
              required
              autoFocus
            />
          </label>

          <label className="campo-acceso">
            <span className="etiqueta-campo">Clave</span>
            <div className="campo-con-boton">
              <input
                type={verClave ? 'text' : 'password'}
                value={clave}
                onChange={(e) => setClave(e.target.value)}
                autoComplete="current-password"
                enterKeyHint="go"
                required
              />
              <button
                type="button"
                className="boton-ver"
                onClick={() => setVerClave(!verClave)}
                aria-label={verClave ? 'Ocultar la clave' : 'Mostrar la clave'}
                aria-pressed={verClave}
              >
                {verClave ? 'ocultar' : 'mostrar'}
              </button>
            </div>
          </label>

          {error && (
            <p className="error-acceso" role="alert">
              {error}
            </p>
          )}

          <button type="submit" className="boton-principal" disabled={entrando}>
            {entrando ? 'Entrando…' : 'Entrar'}
          </button>
        </form>

        <p className="nota-acceso">
          Las cuentas las crea quien administra el despliegue. No hay registro abierto.
        </p>

        {/* Solo en desarrollo: evita tener que buscar las credenciales de prueba
            en el README. Vite lo elimina del build de producción. */}
        {import.meta.env.DEV && (
          <div className="cuentas-demo">
            <span className="titulo-demo">Cuentas de prueba (solo en desarrollo)</span>
            <ul>
              {CUENTAS_DEMO.map((cuenta) => (
                <li key={cuenta.correo}>
                  <button
                    type="button"
                    onClick={() => {
                      setCorreo(cuenta.correo);
                      setClave(CLAVE_DEMO);
                      setError(null);
                    }}
                  >
                    <strong>{cuenta.rol}</strong>
                    <small>{cuenta.correo}</small>
                    <small className="tenue">{cuenta.para}</small>
                  </button>
                </li>
              ))}
            </ul>
            <small className="tenue">
              Clave: <code>{CLAVE_DEMO}</code> · toque una para llenar el formulario
            </small>
          </div>
        )}
      </div>
    </div>
  );
}
