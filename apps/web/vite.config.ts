import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    // El proxy sirve la API bajo el mismo origen que la PWA en desarrollo. Eso
    // evita problemas de CORS y —más importante— hace que el service worker
    // pueda interceptar las peticiones a /v1, que es lo que necesita el modo
    // sin conexión: un service worker solo ve su propio origen.
    proxy: {
      '/v1': {
        target: process.env.VITE_API_URL ?? 'http://localhost:3010',
        changeOrigin: true,
      },
      '/salud': { target: process.env.VITE_API_URL ?? 'http://localhost:3010' },
      '/listo': { target: process.env.VITE_API_URL ?? 'http://localhost:3010' },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
