# Modo sin conexión

Documento de diseño de la parte de la PWA que hace que un reporte no se pierda
cuando no hay señal. Es lo que separa este proyecto de "un formulario con un
mapa".

Implementación: `apps/web/src/lib/bd.ts`, `apps/web/src/lib/bandeja.ts`,
`apps/web/public/sw.js`.

## Premisa

En una emergencia la red es lo primero que se cae, y lo hace de formas que no son
"encendido/apagado": la antena está saturada, el wifi comunitario está asociado
pero sin salida, la señal aparece treinta segundos y se va. Cualquier diseño que
asuma "si `navigator.onLine` es `true`, la petición va a funcionar" pierde
reportes.

De ahí la regla que ordena todo el módulo: **el reporte se escribe en el
dispositivo antes de intentar enviarlo, siempre.** El botón "Enviar" nunca falla
por falta de red, porque enviar no es lo que hace.

## Idempotencia: la pieza que lo habilita todo

Cada reporte lleva un `id_cliente`, un UUID que **genera el dispositivo** con
`crypto.randomUUID()`. En la base es `UNIQUE`, y el alta usa:

```sql
INSERT INTO reportes (...) VALUES (...)
ON CONFLICT (id_cliente) DO UPDATE SET id_cliente = reportes.id_cliente
RETURNING id, codigo_publico, (xmax = 0) AS creado
```

El `DO UPDATE` es deliberadamente vacío: sirve para que `RETURNING` devuelva la
fila existente (un `DO NOTHING` no devuelve nada) sin modificar ningún dato.
`xmax = 0` distingue inserción real de reenvío.

Consecuencia: **reintentar es gratis y seguro**. El cliente puede reenviar el
mismo reporte desde cuatro caminos distintos, a la vez, veinte veces, y el
resultado es un solo reporte. Todo lo demás se apoya en esto.

La respuesta HTTP distingue los casos —201 si creó, 200 si era reenvío— para que
la PWA sepa si puede sacar el elemento de su bandeja.

## Cuatro capas de reintento

Ninguna sola es confiable, así que hay cuatro y todas llaman a la misma función.

| Capa | Cubre | Falla cuando |
|---|---|---|
| Intento inmediato al enviar | el caso normal | no hay red en ese instante |
| Evento `online` | vuelve la señal con la app abierta | el evento no dispara o miente |
| Temporizador cada 30 s | señal intermitente, `onLine` mentiroso | la pestaña está cerrada |
| Background Sync del service worker | pestaña cerrada | el navegador no lo implementa (Safari) |

La tercera capa merece una nota: `navigator.onLine` y el evento `online` solo
saben si hay una interfaz de red asociada, **no si hay salida a internet**. Estar
conectado a una antena que no cursa tráfico devuelve `true`. Sin el reintento
periódico, una bandeja podría no drenarse nunca aunque el dispositivo se
considere "en línea".

Un candado (`sincronizando`) evita que dos capas hagan el trabajo a la vez.

## Estado de cada elemento

```
pendiente ──▶ enviando ──▶ confirmado
    ▲             │
    └─────────────┘         └──▶ rechazado  (4xx: no reintentar)
      (fallo de red)
```

`enviando` se vuelve a tomar como pendiente al arrancar: si el navegador se cerró
en medio de un envío, el elemento quedó marcado como en curso y nadie lo tomaría
de nuevo. Reintentar es seguro por la idempotencia.

La distinción entre `rechazado` (4xx) y `pendiente` (5xx o fallo de red) importa:
un 400 significa que la carga es inválida y reintentar no va a cambiar nada.
Marcarlo como rechazado y mostrarlo es mejor que reintentar en silencio para
siempre.

Los confirmados no se borran de inmediato: se conservan siete días para que la
persona pueda ver su **código público** —`RPT-JRGWC`— que es lo que le permite
preguntar por su caso.

## Un defecto que apareció al probarlo

La primera versión notificaba a la interfaz solo desde el camino de
sincronización exitosa. Sin conexión, el resultado era el peor posible para esta
aplicación: la persona apretaba «Enviar», el reporte se guardaba correctamente, y
**la pantalla no mostraba nada**. Ninguna forma de saber si su pedido de auxilio
quedó registrado o se perdió.

La corrección fue mover el aviso al punto de guardado, con `agregarALaBandeja()`
como entrada única: guarda, avisa a la pantalla, y recién entonces intenta enviar.
Apareció probando el flujo sin red en el navegador, no revisando el código.

## Fotos: después y más livianas

Las fotos se reducen a 1568 px de lado largo con canvas **en el teléfono**, antes
de guardarlas. Una foto de celular pesa entre 3 y 8 MB; reducida queda en 200-400
KB sin perder lo que un operador necesita ver.

Se hace en el cliente por el ancho de banda, no por el costo de tokens: subir 8 MB
por una red de emergencia puede tomar minutos o no terminar. El ahorro en tokens
del modelo multimodal es un beneficio secundario.

Y se suben **después** del texto, en una petición aparte: el reporte pesa un
kilobyte y ordena un rescate; la foto pesa cientos y es complemento. En una red
que apenas responde, mandar primero lo liviano y completo es mejor que quedarse a
mitad de una subida grande.

La orientación EXIF se respeta explícitamente (`imageOrientation: 'from-image'`):
sin eso las fotos verticales llegan acostadas y cuesta interpretarlas.

## Service worker

Dos responsabilidades:

1. **Cachear el armazón** para que la app abra sin conexión. Si alguien pierde la
   señal y cierra la app, tiene que poder volver a abrirla y seguir reportando.
2. **Drenar la bandeja** con Background Sync.

Las peticiones a `/v1/` **nunca** se sirven de caché: mostrar una cola de rescate
vieja como si fuera la actual es peor que no mostrar nada.

Usa la API cruda de IndexedDB, no la biblioteca `idb`, porque el archivo se sirve
tal cual sin pasar por el empaquetador. El esquema tiene que coincidir con
`src/lib/bd.ts`; si cambia allá, hay que cambiarlo acá.

**Limitación aceptada:** el service worker sincroniza el texto de los reportes,
no las fotos. Subir multipart desde ahí es posible pero suma complejidad, y el
reporte es lo que ordena un rescate. Las fotos las sube la página al abrirse.

## Qué se verificó en navegador

1. Reporte con red → confirmado, código público en pantalla.
2. Reporte sin red (`fetch` rechazando, `onLine` en `false`) → guardado, aviso
   "se enviará solo cuando haya señal", insignia "1 por enviar".
3. Recarga de la página con el reporte pendiente → se envió solo al arrancar y
   quedó confirmado con su código.
4. Reenvío del mismo `id_cliente` → HTTP 200, `creado: false`, un solo reporte en
   la base.
