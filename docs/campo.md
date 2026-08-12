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

### La sesión se abre solo desde acá

«Atender» es el único lugar donde se inicia y se cierra sesión. El tablero lee la
sesión pero no ofrece login: allí la sesión solo habilita acciones sobre un
reporte, mientras que en campo es la puerta de entrada. Tener un solo sitio donde
autenticarse evita que alguien quede con sesión abierta desde una pantalla y crea
que la tiene en la otra.

Sin sesión, el tablero se ve completo en **modo consulta** —mosaicos, mapa, cola,
todo— con un aviso que remite a «Atender» para poder actuar. Consultar el estado
de la emergencia es abierto a propósito: ponerlo detrás de un login no protege
nada y estorba a quien necesita mirarlo rápido.

En desarrollo la pantalla de acceso lista las cuentas de la semilla y las llena
con un toque, para no tener que buscarlas en el README. Ese bloque va dentro de un
`import.meta.env.DEV`, así que Vite lo elimina del build de producción — se
verificó que las cadenas no quedan en el bundle (sí en el source map, que por
diseño lleva el código original).

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

### Cómo se muestra en el tablero

El mapa dibuja al personal como un anillo con núcleo blanco, en un color que no
aparece ni en la escala de severidad ni en los recursos: en un mapa donde el
color ya significa «qué tan grave», el punto que significa «quién» no puede
parecerse a ninguno. Debajo del mapa va una tira con el nombre, los casos
abiertos y la edad de la posición de cada uno — el mapa dice *dónde*, la tira
dice *quién y con cuánta carga*, que es lo que decide a quién se le manda el
siguiente caso.

La antigüedad se pinta en tres franjas escalonadas (`lib/frescura.ts`):

| Franja | Antigüedad | Cómo se ve |
|---|---|---|
| actual | < 5 min | opacidad plena |
| envejeciendo | 5–30 min | atenuada |
| desactualizada | > 30 min | muy tenue, borde gris, contada aparte |

Se escalona en vez de interpolar a propósito: tres franjas nítidas se leen de un
vistazo, mientras que un degradado continuo obliga a comparar dos puntos entre sí
para saber cuál es más viejo. Y la edad se dice **siempre** en el emergente,
incluso cuando es de hace segundos: si solo apareciera al envejecer, su ausencia
se leería como «está aquí» en vez de como «no se sabe».

Los umbrales viven en un módulo aparte por la misma razón que los filtros de KPI:
el mapa desvanece el punto, la leyenda explica qué significa desvanecido y la
tira cuenta cuántos lo están. Si esos tres se separan, el tablero dice tres cosas
distintas sobre el mismo dato.

Dos consecuencias de que toda la sección `/v1/campo` exija sesión operativa:

- **Sin sesión no se consulta.** El tablero se ve en modo consulta y la capa
  queda vacía; la leyenda tampoco anuncia el personal, porque una entrada de
  leyenda para una capa vacía hace buscar en el mapa algo que no está.
- **La consulta va aparte del resto del tablero**, no dentro del mismo
  `Promise.all`. Un token vencido responde 403 y no puede tumbar la cola ni el
  mapa, que se miran sin sesión a propósito. Cuando falla se dice por qué: dejar
  la capa vacía sin explicación se leería como «no hay nadie en campo».

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

### «Asignados sin llegada»

El mosaico que existe para un defecto que ninguno de los otros puede mostrar. Al
pasar a `ASIGNADO` el trigger fija `primera_respuesta_en`, eso apaga el término
de espera del índice, y el reporte deja de subir en la cola. A partir de ahí un
caso olvidado se ve **exactamente igual** que uno atendido.

El filtro `estancados` los saca a la superficie: siguen en `ASIGNADO` —llegar al
sitio los pasaría a `EN_ATENCION`— y su `primera_respuesta_en` tiene más de 30
minutos. Se ancla ahí y no en `tomado_en` porque es el instante exacto en que el
término de espera se apagó, así que mide el tiempo durante el que el reporte
estuvo invisible para la priorización. Liberar el caso también lo saca de la
cifra, que es correcto: vuelve a estar disponible y la cola lo recoge.

Por qué una alerta y no un sexto término del índice: ver
[`prioridad.md`](prioridad.md).

### Filtro por severidad

La leyenda del mapa hace doble oficio: explica el color y filtra por él. Es donde
el operador ya está mirando cuando se pregunta «y si solo veo las críticas», así
que poner el control en otra parte de la pantalla sería mandarlo a buscar.

Es **ortogonal** al filtro de KPI y se combina con él con AND: «qué tan grave» y
«en qué situación está» son preguntas distintas y un operador quiere cruzarlas.
Los dos se anuncian juntos en la barra y se quitan por separado — con ambos
activos, un «quitar filtro» único dejaría al operador sin saber cuál de los dos
estaba recortando la lista.

La severidad va a la cola **y** al GeoJSON del mapa, igual que el filtro de KPI.
`GET /v1/reportes` ya la aceptaba; `GET /v1/tablero/cola` no, y sin eso tocar la
leyenda habría dejado el mapa con tres puntos y la lista de al lado con veinte.
