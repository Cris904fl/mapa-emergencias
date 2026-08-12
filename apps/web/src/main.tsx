import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './estilos.css';

const raiz = document.getElementById('raiz');
if (!raiz) throw new Error('No se encontró el elemento raíz');

createRoot(raiz).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

/**
 * Registro del service worker.
 *
 * Va después de renderizar y sin bloquear: si el registro falla —navegador sin
 * soporte, contexto sin HTTPS— la aplicación tiene que funcionar igual. La
 * bandeja local en IndexedDB no depende del service worker; este solo agrega
 * que la app abra sin conexión y que pueda enviar con la pestaña cerrada.
 */
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((error) => {
      console.warn('No se pudo registrar el service worker:', error);
    });
  });
}
