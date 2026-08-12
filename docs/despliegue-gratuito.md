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

## Orden sugerido

1. Supabase: crear proyecto, `CREATE EXTENSION postgis;`, correr las migraciones
   con `DATABASE_URL` apuntando allá.
2. Render/Koyeb: desplegar `apps/api`, comando `npm run iniciar --workspace=@emergencias/api`.
3. Cloudflare Pages: desplegar `apps/web/dist` con `VITE_API_URL` a la API.
4. Cron: `/salud` cada 10 min y `/v1/mantenimiento/refrescar-prioridades` cada minuto.
5. IA: empezar en `ninguno`, y activarla cuando se decida entre la opción A y la B.

## Y una nota sobre para qué es gratis

Estas capas sirven para mostrar el proyecto, para un piloto, para que alguien lo
pruebe. Una operación de emergencia real necesita infraestructura que no se
suspenda, respaldos, y un compromiso de disponibilidad — nada de eso viene en una
capa gratuita, y conviene decirlo antes de que alguien lo confunda.
