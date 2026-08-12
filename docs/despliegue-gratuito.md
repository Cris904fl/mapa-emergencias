# Desplegar sin pagar nada

Se puede tener todo el sistema en internet con capas gratuitas. Pero hay una
restricción que conviene entender antes de empezar, porque no tiene vuelta.

## La restricción: Ollama no cabe en un hosting gratuito

`qwen2.5:7b` necesita unos **5 GB de RAM** para cargar. Las capas gratuitas de
Render, Koyeb, Fly y compañía dan entre **512 MB y 1 GB**. No es que vaya lento:
no arranca. Y sin GPU, ninguna de ellas está pensada para inferencia.

No hay ningún servicio que hospede Ollama gratis. Cualquier guía que lo prometa
está describiendo una prueba con crédito temporal.

Así que para la parte de IA hay tres caminos, y los tres son legítimos:

| Opción | Costo | Ventaja | Costo real |
|---|---|---|---|
| **A. Groq (u otro compatible)** | gratis con límites | cero infraestructura, rápido | los reportes viajan a un tercero |
| **B. Ollama en tu PC + túnel** | gratis | privado, el modelo es tuyo | tu máquina tiene que estar encendida |
| **C. Sin IA** | gratis | nada que falle | los conteos quedan como los escribió el ciudadano |

La opción C no es una derrota: el sistema está construido para que la extracción
sea una comodidad. Con `IA_PROVEEDOR=ninguno` todo funciona, los reportes entran y
la cola se ordena — solo que con los datos del formulario y no con los del texto
libre.

### Opción A: un proveedor con forma OpenAI

Groq tiene capa gratuita con límites por minuto y por día, es rápido, y habla el
protocolo de OpenAI, que es justo lo que implementa el proveedor `compatible`.

```
IA_PROVEEDOR=compatible
IA_URL_COMPATIBLE=https://api.groq.com/openai/v1
IA_CLAVE_COMPATIBLE=gsk_...
IA_MODELO=llama-3.3-70b-versatile
IA_APLICAR_AUTOMATICAMENTE=false
```

Sirve igual OpenRouter (tiene modelos gratuitos), o cualquier vLLM propio. No se
ha medido la calidad de esta ruta con el prompt del proyecto: antes de subir
`IA_APLICAR_AUTOMATICAMENTE` a `true`, repetir las mediciones de
[`ia-local.md`](ia-local.md).

Ojo con lo que implica: las descripciones de los reportes llevan datos de
personas concretas y salen de tu infraestructura. Para un ejercicio o un piloto
puede estar bien; para una operación real es una decisión que hay que tomar a
conciencia.

### Opción B: Ollama en tu máquina, expuesto con un túnel

Cloudflare Tunnel es gratis y no requiere abrir puertos ni tener IP fija:

```bash
cloudflared tunnel --url http://localhost:11434
```

Devuelve una URL pública que va en `OLLAMA_URL` del servicio desplegado. Los
datos siguen procesándose en tu equipo.

Lo que hay que aceptar: si tu PC se apaga o se suspende, la extracción deja de
funcionar. El sistema lo tolera —el trabajador registra el fallo y el reporte
sigue vivo— pero no es una configuración para depender de ella.

## El resto del sistema

| Pieza | Servicio | Notas |
|---|---|---|
| PWA | **Cloudflare Pages** | Gratis, ancho de banda sin límite, sin arranque en frío. Build `npm run construir --workspace=@emergencias/web`, salida `apps/web/dist`. |
| PostgreSQL + **PostGIS** | **Supabase** | Capa gratuita con PostGIS ya instalado. Es la pieza que restringe la elección: no todos los Postgres gratuitos traen PostGIS. Neon también sirve. |
| API | **Render** o **Koyeb** | Ver la advertencia de abajo. |
| Redis | *ninguno* | Ver «Sin Redis». |
| Cron | **cron-job.org** o GitHub Actions | Para refrescar prioridades. |

### La advertencia sobre la API

Las capas gratuitas de servicios web **suspenden el proceso tras unos minutos sin
tráfico**, y la siguiente petición tarda entre 30 y 60 segundos en despertarlo.

Para una aplicación de emergencias eso es un problema de verdad, no un detalle:
el primer reporte después de un rato de calma es exactamente el que no puede
esperar. Dos mitigaciones:

- Un cron cada 10 minutos golpeando `/salud` mantiene el proceso despierto. Es lo
  que hace todo el mundo y funciona.
- Y de fondo: la PWA guarda el reporte en el dispositivo **antes** de intentar
  enviarlo, así que un arranque en frío no pierde nada. Se reintenta solo. Esta es
  la razón por la que el modo sin conexión no es un adorno.

### Sin Redis

BullMQ necesita un Redis de verdad (comandos bloqueantes, scripts Lua). Los Redis
gratuitos tipo Upstash no lo soportan completo, y montar uno propio ya no es
gratis.

La API funciona sin trabajadores, con dos ajustes:

**1. La prioridad se refresca por cron.** Dos términos del índice cambian solos —la
espera crece con el reloj, la concentración cambia con los vecinos— así que hay
una ruta para invocarlo desde fuera:

```
SECRETO_MANTENIMIENTO=<una cadena larga y aleatoria>
```

```bash
curl -X POST https://tu-api/v1/mantenimiento/refrescar-prioridades \
  -H "x-secreto-mantenimiento: $SECRETO_MANTENIMIENTO"
```

Un cron cada minuto en cron-job.org hace el mismo trabajo que el trabajador. Sin
el secreto configurado la ruta responde 400 y queda inutilizable, que es el
comportamiento correcto.

**2. La extracción se dispara a mano.** Sin cola, `encolarTriage` falla y queda
registrado como aviso; el reporte se acepta igual. Un operador la dispara desde el
tablero con «Estructurar texto», que llama a `POST /v1/reportes/:id/triage-ia`.

Dado que la política recomendada es que un humano revise la propuesta antes de
aplicarla, esto encaja bien: la extracción a demanda sobre el reporte que el
operador está mirando es más útil que procesar todo en lote.

### Medios

En disco local, que en un hosting gratuito es efímero: las fotos se pierden en
cada redespliegue. Supabase Storage tiene capa gratuita y es el reemplazo
natural. El esquema no cambia — `medios_reporte.llave_almacen` ya es una llave de
objeto, no una ruta.

### Teselas del mapa

El tablero usa OpenStreetMap, cuya política de uso **no permite tráfico de
producción**. Para algo publicado hace falta un proveedor propio o contratado;
varios tienen capa gratuita. El cambio es una URL en
`apps/web/src/componentes/Mapa.tsx`.

## Para una beta ciudadana, casi nada de lo anterior aplica

Vale la pena separarlo, porque simplifica mucho el primer despliegue.

**El ciudadano no usa el mapa.** Desde que el bundle quedó partido, la vista
«Reportar» no descarga MapLibre, no pide teselas, no calcula rutas y no toca la
IA. Los tres problemas grandes de este documento —la licencia de OpenStreetMap,
el OSRM de demostración y Ollama que no cabe en un hospedaje gratuito— **solo
aparecen en el tablero y en la vista de campo**, que en una beta mira una sola
persona.

Así que una beta para gente probando el reporte necesita cuatro piezas y ninguna
decisión sobre IA:

| Pieza | Servicio | Arranque en frío |
|---|---|---|
| PWA (lo que usa la gente) | Cloudflare Pages | no |
| Postgres + PostGIS | Supabase o Neon | no |
| API | Render o Koyeb | sí, y no importa (ver abajo) |
| Cron de prioridades | cron-job.org | — |

### Tres cosas que impiden que arranque, y ya están arregladas

Las tres fallan de formas que no se parecen a su causa, así que conviene saber
que existen antes de pelear con ellas:

1. **`--env-file` mata el proceso si el archivo no existe.** En un hospedaje no
   hay `.env`: las variables vienen del panel. Los scripts usan
   `--env-file-if-exists`, que sigue leyendo el archivo en local y no se queja
   cuando no está. (`probar` sí conserva el estricto: `.env.pruebas` está
   versionado y si falta, la suite debe fallar.)
2. **El hospedaje inyecta `PORT`, no `API_PUERTO`.** Sin atenderlo el proceso
   arranca sin quejarse, escucha en 3010, y la plataforma enruta a otro puerto:
   502 permanente sin una sola línea de error. `config.ts` le da prioridad a
   `PORT`.
3. **La PWA llama a `/v1` con rutas relativas**, y eso no es un descuido: un
   service worker solo ve peticiones de su propio origen, así que si llamara
   directo a la API por su dominio, la bandeja de salida —lo que reintenta el
   reporte cuando vuelve la señal— dejaría de funcionar. En desarrollo lo
   resuelve el proxy de Vite; en producción lo resuelve
   `apps/web/functions/v1/[[ruta]].js`, que reenvía a la API y de paso pasa la
   IP real del visitante para que el límite de tasa siga siendo por persona y no
   uno solo para todo el mundo.

### El arranque en frío no duele acá, y es por diseño

La API gratuita se suspende tras unos minutos sin tráfico y tarda 30–60 s en
despertar. Suena grave para emergencias, salvo que **la PWA guarda el reporte en
el teléfono antes de intentar enviarlo**: quien reporta ve «guardado» de
inmediato y el envío se reintenta solo. El arranque en frío no pierde nada.

La PWA vive en Cloudflare Pages, que no se suspende, así que abrir la aplicación
es instantáneo aunque la API esté dormida.

## Orden sugerido

1. **Supabase**: crear proyecto, `CREATE EXTENSION postgis;`. Copiar la cadena de
   conexión (la de *connection pooling* si la ofrece).
2. **Migrar** desde la máquina local, apuntando allá:
   ```bash
   DATABASE_URL='postgres://...supabase...' npm run bd:migrar
   ```
   Sembrar es **opcional y probablemente no se quiera**: los datos de prueba son
   dos barrios de Bogotá y aparecerían como reportes reales en el tablero.
   Lo que sí hay que crear es la cuenta de operador:
   ```bash
   DATABASE_URL='postgres://...' npm run clave --workspace=@emergencias/api -- correo@ejemplo.co una-clave-larga
   ```
3. **Render/Koyeb**: desplegar `apps/api`, comando
   `npm run iniciar --workspace=@emergencias/api`. Variables mínimas:
   `DATABASE_URL`, `JWT_SECRETO` (16+ caracteres), `NODE_ENV=production`,
   `IA_PROVEEDOR=ninguno`, `SECRETO_MANTENIMIENTO` (16+).
4. **Cloudflare Pages**: directorio raíz `apps/web`, comando de construcción
   `npm run construir`, salida `dist`, y la variable `API_ORIGEN` con la URL de
   la API del paso 3. No hace falta `VITE_API_URL`: eso es solo para el proxy de
   desarrollo.
5. **Cron** en cron-job.org: `/salud` cada 10 min (mantener despierta) y
   `/v1/mantenimiento/refrescar-prioridades` cada minuto con la cabecera
   `x-secreto-mantenimiento`.

### Qué NO encender en una beta con gente real

- **La IA.** Aunque Groq tenga capa gratuita, las descripciones llevan datos de
  personas y saldrían hacia un tercero. Con `ninguno` todo funciona igual.
- **La semilla de desarrollo**, por lo dicho en el paso 2.

### Antes de compartir el enlace

El tablero se ve sin sesión —es deliberado— y muestra la descripción de cada
reporte. Si la beta va a grupos abiertos, conviene decidir si el contacto de
quien reporta debe verse ahí.

## Y una nota sobre para qué es gratis

Estas capas sirven para mostrar el proyecto, para un piloto, para que alguien lo
pruebe. Una operación de emergencia real necesita infraestructura que no se
suspenda, respaldos, y un compromiso de disponibilidad — nada de eso viene en una
capa gratuita, y conviene decirlo antes de que alguien lo confunda.
