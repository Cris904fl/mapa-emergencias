/* eslint-disable no-undef */
/**
 * Service worker.
 *
 * Dos responsabilidades:
 *
 *   1. Cachear el armazón de la aplicación para que abra sin conexión. Si
 *      alguien pierde la señal y cierra la app, tiene que poder volver a
 *      abrirla y seguir reportando.
 *   2. Drenar la bandeja de salida con Background Sync — el único camino que
 *      funciona con la pestaña cerrada.
 *
 * Se usa la API cruda de IndexedDB y no la biblioteca `idb` porque este archivo
 * se sirve tal cual, sin pasar por el empaquetador. El esquema tiene que
 * coincidir con src/lib/bd.ts; si cambia allá, hay que cambiarlo acá.
 */

const VERSION_CACHE = 'emergencias-v1';
const ARMAZON = ['/', '/index.html', '/manifest.webmanifest', '/icono.svg'];

const NOMBRE_BD = 'mapa-emergencias';
const VERSION_BD = 1;

self.addEventListener('install', (evento) => {
  evento.waitUntil(
    caches
      .open(VERSION_CACHE)
      // addAll falla completo si un recurso falla; se agrega uno por uno para
      // que un 404 en un icono no impida instalar el service worker.
      .then((cache) => Promise.allSettled(ARMAZON.map((ruta) => cache.add(ruta))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (evento) => {
  evento.waitUntil(
    caches
      .keys()
      .then((claves) =>
        Promise.all(claves.filter((clave) => clave !== VERSION_CACHE).map((clave) => caches.delete(clave))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (evento) => {
  const peticion = evento.request;

  if (peticion.method !== 'GET') return;

  const url = new URL(peticion.url);
  if (url.origin !== self.location.origin) return;

  // Las peticiones a la API nunca se sirven de caché: mostrar una cola de
  // rescate vieja como si fuera la actual es peor que no mostrar nada.
  if (url.pathname.startsWith('/v1/')) return;

  // Navegaciones: red primero, caché como respaldo. Así la app abre sin
  // conexión con la última versión que se alcanzó a guardar.
  if (peticion.mode === 'navigate') {
    evento.respondWith(
      fetch(peticion)
        .then((respuesta) => {
          const copia = respuesta.clone();
          void caches.open(VERSION_CACHE).then((cache) => cache.put('/index.html', copia));
          return respuesta;
        })
        .catch(() => caches.match('/index.html').then((r) => r ?? Response.error())),
    );
    return;
  }

  // Activos estáticos: caché primero, y se refresca en segundo plano.
  evento.respondWith(
    caches.match(peticion).then((enCache) => {
      const desdeRed = fetch(peticion)
        .then((respuesta) => {
          if (respuesta.ok) {
            const copia = respuesta.clone();
            void caches.open(VERSION_CACHE).then((cache) => cache.put(peticion, copia));
          }
          return respuesta;
        })
        .catch(() => enCache ?? Response.error());

      return enCache ?? desdeRed;
    }),
  );
});

// ---------------------------------------------------------------------------
// Background Sync
// ---------------------------------------------------------------------------

self.addEventListener('sync', (evento) => {
  if (evento.tag === 'sincronizar-bandeja') {
    evento.waitUntil(drenarBandeja());
  }
});

self.addEventListener('message', (evento) => {
  if (evento.data?.tipo === 'sincronizar-ahora') {
    evento.waitUntil(drenarBandeja());
  }
});

function abrirBd() {
  return new Promise((resolver, rechazar) => {
    const solicitud = indexedDB.open(NOMBRE_BD, VERSION_BD);
    solicitud.onsuccess = () => resolver(solicitud.result);
    solicitud.onerror = () => rechazar(solicitud.error);
    // Si la base no existe todavía, el usuario nunca creó un reporte y no hay
    // nada que drenar. No se crea el esquema acá: eso lo hace la página, que es
    // la dueña del modelo de datos.
    solicitud.onupgradeneeded = () => {
      solicitud.transaction?.abort();
      rechazar(new Error('La base local aún no existe'));
    };
  });
}

function leerPendientes(bd) {
  return new Promise((resolver, rechazar) => {
    const tx = bd.transaction('bandeja', 'readonly');
    const solicitud = tx.objectStore('bandeja').getAll();
    solicitud.onsuccess = () =>
      resolver(
        solicitud.result.filter(
          (elemento) => elemento.estado === 'pendiente' || elemento.estado === 'enviando',
        ),
      );
    solicitud.onerror = () => rechazar(solicitud.error);
  });
}

function guardarElemento(bd, elemento) {
  return new Promise((resolver, rechazar) => {
    const tx = bd.transaction('bandeja', 'readwrite');
    tx.objectStore('bandeja').put(elemento);
    tx.oncomplete = () => resolver();
    tx.onerror = () => rechazar(tx.error);
  });
}

/**
 * Envía los reportes pendientes.
 *
 * Limitación conocida y aceptada: acá solo se sincroniza el texto del reporte,
 * no las fotos. Subir multipart desde el service worker es posible pero suma
 * complejidad, y el reporte es lo que ordena un rescate mientras la foto es
 * complemento. Las fotos las sube la página en cuanto se abre de nuevo.
 */
async function drenarBandeja() {
  let bd;
  try {
    bd = await abrirBd();
  } catch {
    return;
  }

  const pendientes = await leerPendientes(bd).catch(() => []);
  if (pendientes.length === 0) return;

  try {
    const respuesta = await fetch('/v1/reportes/sincronizar', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reportes: pendientes.map((elemento) => elemento.carga) }),
    });

    if (!respuesta.ok) {
      // Lanzar hace que el navegador reintente el evento de sync más tarde con
      // su propia estrategia de espera.
      throw new Error(`HTTP ${respuesta.status}`);
    }

    const cuerpo = await respuesta.json();
    const porIdCliente = new Map(pendientes.map((elemento) => [elemento.id_cliente, elemento]));

    for (const confirmado of cuerpo.resultados ?? []) {
      const elemento = porIdCliente.get(confirmado.id_cliente);
      if (!elemento) continue;
      await guardarElemento(bd, {
        ...elemento,
        estado: 'confirmado',
        id_servidor: confirmado.id,
        codigo_publico: confirmado.codigo_publico,
      });
    }

    // Avisar a las pestañas abiertas, si hay alguna, para que refresquen.
    const clientes = await self.clients.matchAll({ includeUncontrolled: true });
    for (const cliente of clientes) {
      cliente.postMessage({ tipo: 'bandeja-sincronizada', confirmados: cuerpo.confirmados ?? 0 });
    }
  } catch (error) {
    for (const elemento of pendientes) {
      await guardarElemento(bd, {
        ...elemento,
        estado: 'pendiente',
        intentos: (elemento.intentos ?? 0) + 1,
        ultimo_error: String(error?.message ?? error),
      }).catch(() => {});
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Notificaciones push
// ---------------------------------------------------------------------------
// Es lo que cierra el ciclo para quien reportó. Sin esto, un ciudadano manda su
// reporte y no vuelve a saber nada: ni cuando un equipo lo toma, ni cuando
// llega, ni cuando lo cierran.
//
// El contenido llega cifrado de extremo a extremo, pero **el texto no dice qué
// ocurrió ni dónde**: una notificación se ve en la pantalla bloqueada, y quien
// pase al lado del teléfono no tiene por qué enterarse de que en tal casa hay
// gente atrapada.

self.addEventListener('push', (evento) => {
  let datos = {};
  try {
    datos = evento.data ? evento.data.json() : {};
  } catch {
    // Una carga que no es JSON no debe impedir que se muestre algo: la persona
    // igual quiere saber que su caso se movió.
  }

  const titulo = datos.titulo || 'Su reporte se actualizó';
  const cuerpo = datos.cuerpo || 'Toque para ver el estado de su caso.';

  evento.waitUntil(
    self.registration.showNotification(titulo, {
      body: cuerpo,
      icon: '/icono.svg',
      badge: '/icono.svg',
      // Agrupa por caso: tres cambios seguidos no dejan tres notificaciones
      // apiladas, sino la última. En una emergencia, una lista de avisos
      // repetidos es ruido.
      tag: datos.codigo ? `reporte-${datos.codigo}` : 'reporte',
      renotify: true,
      data: { codigo: datos.codigo || null },
    }),
  );
});

self.addEventListener('notificationclick', (evento) => {
  evento.notification.close();
  const codigo = evento.notification.data?.codigo;

  evento.waitUntil(
    (async () => {
      const clientes = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });

      // Si la app ya está abierta se reutiliza esa pestaña en vez de abrir otra:
      // llenarle el teléfono de pestañas a alguien que está en una emergencia es
      // exactamente lo contrario de ayudar.
      for (const cliente of clientes) {
        if (cliente.url.includes(self.location.origin)) {
          cliente.postMessage({ tipo: 'consultar-caso', codigo });
          return cliente.focus();
        }
      }

      const destino = codigo
        ? `/?vista=reportar&codigo=${encodeURIComponent(codigo)}`
        : '/?vista=reportar';
      return self.clients.openWindow(destino);
    })(),
  );
});
