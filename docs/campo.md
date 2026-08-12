# Atención en campo

Cómo funciona la pantalla de quien va a atender, y las tres decisiones de diseño
que la separan de «una lista de casos con un mapa».

Implementación: `apps/api/src/rutas/campo.ts`, `apps/api/src/servicios/ruteo.ts`,
`apps/web/src/paginas/Campo.tsx`.

## Quién la usa

Un rescatista con cuenta (`rol = 'RESPONDIENTE'`, `OPERADOR` o `ADMIN`). No hay
registro público: las cuentas las crea quien administra el despliegue con

```bash
npm run clave --workspace=@emergencias/api -- socorrista@ejemplo.co una-clave-larga
```

La pantalla asume un celular, en la calle, con una mano ocupada y con prisa. De
ahí que la distancia esté en el elemento más grande de cada tarjeta, que las
acciones sean de un toque, y que el contacto del ciudadano sea un enlace `tel:`
para llamar sin copiar el número.

## Decisión 1: dos ordenaciones explícitas, no un puntaje mezclado

«Lo más cercano» y «lo más urgente» son preguntas distintas, y con frecuencia dan
respuestas distintas. En los datos de prueba:

| Orden | Primero de la lista |
|---|---|
| Más cerca | a 419 m, prioridad 49 |
| Más urgente | a 740 m, prioridad 59, cinco personas atrapadas |

Era tentador combinar ambas en un solo número —prioridad menos una penalización
por kilómetro— y presentar una única lista «óptima». No se hizo, y la razón es
que ese número escondería la decisión en lugar de tomarla: la penalización por
distancia correcta depende de si el rescatista va a pie o en camión, de si la vía
está despejada, y de cuántos equipos más hay disponibles. Nada de eso lo sabe el
servidor.

Así que la interfaz muestra las dos ordenaciones como un interruptor, con la
distancia y la prioridad visibles en cada tarjeta, y una línea que dice
explícitamente qué se está viendo: «el primero puede no ser el más cercano».
Quien está en la calle decide.

## Decisión 2: la ruta se cruza contra los reportes de vías bloqueadas

Un motor de ruteo trabaja sobre el grafo vial de OpenStreetMap, que refleja las
calles en un día normal. En una emergencia las calles están tapadas con
escombros, hundidas, inundadas o cortadas por un deslizamiento — **y este sistema
ya sabe cuáles, porque los ciudadanos las están reportando.**

Devolver una ruta que pasa por una vía que alguien reportó bloqueada hace diez
minutos es mandar al rescatista a perder tiempo que no tiene. Así que
`GET /v1/campo/casos/:id/ruta` calcula la ruta y después la cruza contra los
reportes abiertos de categoría `VIA_BLOQUEADA`, `DESLIZAMIENTO`, `INUNDACION` e
`INCENDIO` que estén a menos de 60 m del trayecto:

```
⚠ 2 reporte(s) obstruyen esta ruta
  Vía bloqueada a 440 m del inicio
    «Poste caido atravesado en la calle, no pasa nada.»
  Deslizamiento a 2.5 km del inicio
    «Se vino la tierra sobre tres viviendas en la vereda…»
```

Se ordenan por metros desde el origen —el orden en que los va a encontrar—
usando `ST_LineLocatePoint`, que da la posición del obstáculo a lo largo de la
ruta como fracción de 0 a 1. Un bloqueo a 200 m importa más que uno a 3 km,
porque el primero se resuelve dando la vuelta y el segundo puede estar despejado
cuando llegue.

**Lo que NO hace, y se dice en la interfaz:** no recalcula la ruta evitándolos.
Eso requiere un grafo propio con pgRouting y penalizaciones dinámicas, que es un
proyecto en sí mismo. Avisar es honesto y ya es útil; recalcular mal sería peor
que no recalcular.

### El motor de rutas

Por defecto, el servidor de demostración público de OSRM (`RUTEO_URL`). No pide
clave y sirve para desarrollo, pero **su política de uso no permite tráfico de
producción**: para algo real hay que levantar un OSRM propio con un extracto de
OpenStreetMap de Colombia.

Con `RUTEO_URL` vacío el sistema cae a distancia en línea recta y lo declara como
tal (`tipo: 'linea_recta'`), con un aviso de que la distancia real por calles
suele ser 1.3 a 1.6 veces mayor. En las pruebas se usa este modo a propósito, para
que la suite no salga a la red.

Nótese la diferencia medida en un caso real: 740 m en línea recta contra 2527 m
por calles. Presentar la primera cifra como si fuera la distancia a recorrer sería
engañoso, y por eso la interfaz marca cuál de las dos está mostrando.

## Decisión 3: tomar un caso es exclusivo, y el candado está en el WHERE

Si dos rescatistas pueden tomar el mismo reporte, dos equipos salen al mismo sitio
y otro pedido de auxilio se queda sin nadie.

El `UPDATE` de `POST /v1/campo/casos/:id/tomar` lleva la condición en el propio
`WHERE`:

```sql
UPDATE reportes SET responsable_id = $2, ...
 WHERE id = $1
   AND estado NOT IN ('RESUELTO','DUPLICADO','DESCARTADO')
   AND (responsable_id IS NULL OR responsable_id = $2)
```

No se lee primero y se escribe después: eso deja una ventana entre las dos
operaciones en la que otro puede colarse. Si `rowCount` es 0, una segunda consulta
distingue los tres casos y responde distinto, porque en campo son tres situaciones
con reacciones distintas:

| Situación | Respuesta |
|---|---|
| No existe | 404 |
| Ya está cerrado | 409 «Este caso ya está resuelto» |
| Lo tomó otro | 409 «El caso ya lo tomó Fulano» |

El nombre en el mensaje no es cortesía: permite coordinar por radio con quien lo
tiene.

La condición `responsable_id = $2` además hace la operación **idempotente para uno
mismo**: reintentar por mala señal no falla.

Cerrar el caso solo lo puede hacer quien lo tomó. No es burocracia — cerrar saca
el caso de la cola y de los conteos de la sala de crisis, así que tiene que quedar
claro quién dice que está resuelto. Un `ADMIN` puede corregir por la ruta de
operador (`PATCH /v1/reportes/:id/estado`).

## El ciclo completo

```
RECIBIDO ──tomar──▶ ASIGNADO ──llegué──▶ EN_ATENCION ──resolver──▶ RESUELTO
                        │
                     liberar
                        ▼
                   VERIFICADO  (disponible para otro)
```

Cada paso queda en `historial_estado_reporte` con el actor y la nota. La bitácora
de un caso real de las pruebas:

```
(alta)      -> RECIBIDO
RECIBIDO    -> ASIGNADO     por Socorrista en campo  "Caso tomado en campo"
ASIGNADO    -> EN_ATENCION  por Socorrista en campo  "En atención en sitio"
EN_ATENCION -> RESUELTO     por Socorrista en campo  "Resuelto en campo · 5
                                                      persona(s) atendida(s) ·
                                                      Cinco personas evacuadas,
                                                      una remitida al hospital"
```

Tomar un caso también fija `origen_triage = 'OPERADOR'`, lo que activa el trigger
que impide que la IA vuelva a escribir los conteos de ese reporte: a partir de que
alguien está en el sitio, su lectura manda.

## Posición del personal

La pantalla reporta la posición del dispositivo cada minuto a
`POST /v1/campo/posicion`, y `usuarios.ultima_posicion` la guarda junto con
`posicion_en`. Ese segundo campo importa: una posición de hace dos horas en una
emergencia es casi inútil, y presentarla como actual sería peor que no tenerla.
`GET /v1/campo/personal` devuelve la antigüedad del dato en segundos para que
quien consulte pueda juzgar.

## Filtros del tablero

Cada cifra de cabecera del tablero es un botón que filtra la cola **y el mapa a la
vez**. Si el mosaico dice «2 críticos» y el mapa muestra doce puntos, el operador
deja de confiar en el tablero, con razón.

Las definiciones viven en un solo archivo (`apps/api/src/esquemas/filtros.ts`)
porque las consumen tres rutas —la cola, el GeoJSON del mapa y el resumen— y
tienen que coincidir exactamente. Hay una prueba que compara cada filtro contra
su cifra.

Un detalle que se aclara en la interfaz: el mosaico «personas atrapadas» cuenta
**personas** (23), y su filtro trae los **reportes** que las tienen (6). Son
unidades distintas y ambas correctas; el `title` del botón lo dice para que no
parezca un descuadre.

El único mosaico que no filtra es «recursos disponibles», porque los recursos no
son reportes. Se renderiza como texto y no como botón: un control que parece
pulsable y no hace nada es peor que uno que no lo parece.
