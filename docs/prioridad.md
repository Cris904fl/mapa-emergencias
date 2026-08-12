# El índice de prioridad

Documento de diseño de la función que ordena la cola de atención. Es la pieza más
delicada del sistema: un error acá no produce una pantalla fea, produce que un
equipo de rescate salga al lugar equivocado.

Implementación: `db/migrations/005_prioridad.sql`.
Pruebas: `apps/api/test/prioridad.test.ts`.

## Por qué no se suman los términos en crudo

La formulación de partida era:

```
prioridad = personas_en_riesgo
          + gravedad_reportada
          + distancia_a_recursos
          + concentración_de_reportes
          + tiempo_sin_atención
```

Tiene dos problemas que la vuelven inservible tal cual.

**1. El signo de la distancia está invertido.** Sumar `distancia_a_recursos`
premia estar *cerca* de la ayuda. Es exactamente al revés de lo que interesa:
quien está a 12 km del recurso más cercano tarda más en ser alcanzado y, con
todo lo demás igual, debería salir antes en la cola. El término tiene que
invertirse: lo que aporta es el **aislamiento**, no la distancia.

**2. Las unidades no son comparables.** "23 personas", "1200 metros" y "6 horas"
no se pueden sumar. Si se hace, el término con la magnitud más grande —los
metros— domina el puntaje y los demás quedan como ruido decimal. Un reporte con
30 personas atrapadas a 500 m puntuaría por debajo de un daño material a 8 km.

## La forma que sí funciona

Cada término se normaliza a `0..1` contra un **punto de saturación** explícito y
se pondera con pesos que suman 100. El resultado es un puntaje `0..100`
interpretable y acotado.

```
puntaje = Σ  peso_i × normalizado_i        con  Σ peso_i = 100
```

| Término | Qué mide | Normalización | Peso v1 |
|---|---|---|---|
| `personas` | carga humana en riesgo | `min(1, carga / 30)` | 35 |
| `severidad` | gravedad declarada | tabla fija por nivel | 25 |
| `aislamiento` | distancia al recurso disponible más cercano | `min(1, metros / 5000)` | 15 |
| `concentracion` | reportes abiertos en 300 m | `min(1, vecinos / 10)` | 10 |
| `espera` | horas sin que nadie se haga cargo | `min(1, horas / 12)` | 15 |

### personas

```
carga = atrapadas×3 + heridas×2 + afectadas×1 + vulnerables×0.5
```

Los factores reflejan urgencia de intervención, no importancia de las personas.
Alguien atrapado necesita un equipo con herramienta; alguien afectado sin más
necesita asistencia que puede esperar más.

**Las personas fallecidas quedan fuera a propósito.** Recuperar cuerpos es una
tarea distinta de rescatar a alguien con vida, y sumarlas acá desviaría equipos
desde vidas todavía salvables. Se registran en el reporte para el consolidado de
la emergencia, no para ordenar la cola. Hay una prueba que falla si alguien
agrega `personas_fallecidas` a la carga.

### severidad

| Nivel | Normalizado |
|---|---|
| `CRITICA` | 1.00 |
| `ALTA` | 0.75 |
| `MEDIA` | 0.45 |
| `BAJA` | 0.20 |
| `DESCONOCIDA` | **0.50** |

`DESCONOCIDA` vale 0.5 y no 0. Cuando alguien no sabe qué tan grave es lo que
está viviendo, lo correcto es dejar su reporte a media tabla para que un operador
lo mire, no enterrarlo al fondo. Tratar "no sé" como "nada grave" castigaría
justamente a quien está más desorientado.

### aislamiento

Distancia en metros al recurso `DISPONIBLE` más cercano, con búsqueda de vecino
más cercano (`<->` sobre el índice GiST parcial `recursos_disponibles_geom_gix`).

Si no hay ningún recurso disponible, el aislamiento es total (`1.0`) y el crudo
se reporta como `-1` para distinguir "muy lejos" de "no hay nada".

Punto de saturación en 5 km: más allá de esa distancia, en términos operativos,
todo es "lejos".

### concentracion

Reportes abiertos dentro de 300 m, excluyendo el propio. Muchos reportes en un
radio pequeño indican un evento de alcance mayor al que describe cualquiera por
separado: un edificio, una cuadra, un barrio.

Los reportes cerrados (`RESUELTO`, `DUPLICADO`, `DESCARTADO`) no cuentan: el
término mide trabajo pendiente concentrado, no historia.

### espera

Horas desde `reportado_en` —el momento del hecho según el dispositivo— y **no**
desde `creado_en`. Con sincronización diferida un reporte puede llegar horas
después de haberse creado sin señal, y esas horas de espera cuentan: la persona
lleva ese tiempo esperando, no el que lleva el servidor sabiéndolo.

**El término se va a cero cuando alguien se hace cargo** (`primera_respuesta_en`
deja de ser nulo). La primera versión lo congelaba en su último valor y estaba
mal: un reporte asignado conservaba para siempre su bono de doce horas de espera
y seguía desplazando a reportes que nadie había mirado todavía. Lo que el término
mide es precisamente "nadie lo ha mirado", así que deja de aplicar cuando ya
alguien lo hizo.

Este cambio salió de una prueba que falló, no de una revisión de código.

**Hueco conocido, hoy cubierto por una alerta y no por la fórmula:** una
asignación estancada —ASIGNADO hace horas, el equipo nunca llegó— no vuelve a
subir por esta vía. Sigue sin subir: se resolvió con un mosaico propio
(«asignados sin llegada», filtro `estancados`) que los saca a la superficie sin
tocar los pesos.

Se eligió la alerta y no un sexto término a propósito. Agregar un término obliga
a repartir de nuevo los cinco pesos para que sigan sumando 100 y a volver a medir
el orden resultante — es el invariante más delicado del sistema y no conviene
moverlo sin datos reales de cuánto tardan las llegadas. La alerta cuesta una
condición SQL y no arriesga nada; el precio es que depende de que alguien mire el
tablero. Cuando haya tiempos de llegada medidos, el término propio es la solución
correcta.

El umbral de 30 minutos es un punto de partida sin medir: muy corto inunda el
mosaico en una ciudad con tráfico, muy largo lo vuelve inútil.

**Por qué sigue sin medir.** Al intentar calibrarlo se descubrió que el dato no
se estaba recogiendo: 2 de cada 5 casos cerrados nunca pasaban por
`EN_ATENCION`, porque marcar la llegada es opcional. Eso se corrigió
—`reportes.llegada_en` con su procedencia, y la pregunta al cerrar; ver
[`campo.md`](campo.md)— pero el reloj de la medición empieza desde ahí. Hasta que
haya cobertura razonable, mover el umbral sería cambiar un número inventado por
otro. La consulta que lo dirá está en `db/queries/tiempos-de-llegada.sql` y
reporta la cobertura antes que cualquier percentil.

## Los pesos viven en datos

Tabla `pesos_prioridad`, una fila por versión, con un `CHECK` que exige que los
cinco pesos sumen exactamente 100 y un índice único parcial que garantiza una
sola versión activa.

Durante una emergencia real los pesos se ajustan: si el cuello de botella es
transporte, sube `peso_aislamiento`; si hay riesgo de colapso, sube
`peso_severidad`. Cada ajuste es una fila nueva y cada reporte guarda en
`prioridad_version` con qué versión se calculó, así que un puntaje viejo sigue
siendo explicable meses después.

```sql
INSERT INTO pesos_prioridad (version, descripcion, peso_personas, peso_severidad,
                             peso_aislamiento, peso_concentracion, peso_espera, activa)
VALUES (2, 'Emergencia con vías bloqueadas: el aislamiento manda',
        30, 20, 30, 10, 10, false);

BEGIN;
UPDATE pesos_prioridad SET activa = false WHERE activa;
UPDATE pesos_prioridad SET activa = true  WHERE version = 2;
COMMIT;
```

## Cada puntaje se explica

`fn_prioridad_reporte` devuelve, además del puntaje, el desglose por término con
el valor crudo, el normalizado, el peso y el aporte. Se persiste en
`prioridad_componentes` y se expone en `GET /v1/reportes/:id/prioridad`.

Una prueba verifica que la suma de los aportes sea igual al puntaje: si no lo
fuera, la pantalla que lo justifica estaría mintiendo.

Ejemplo real (deslizamiento en zona rural, datos de prueba):

| Término | Crudo | Normal. | Peso | Aporte |
|---|---|---|---|---|
| personas | 30.5 | 1.00 | 35 | 35.00 |
| severidad | CRITICA | 1.00 | 25 | 25.00 |
| aislamiento | 11 772 m | 1.00 | 15 | 15.00 |
| concentracion | 0 vecinos | 0.00 | 10 | 0.00 |
| espera | 6 h | 0.50 | 15 | 7.50 |
| **puntaje** | | | | **82.50** |

Un operador puede leer esa tabla y decir "está arriba porque hay 12 personas con
4 atrapadas, es crítico, y no hay nada disponible a menos de 11 km" — que es
exactamente lo que necesita para justificar la decisión.

## Por qué el cálculo está en SQL y no en Node

Necesita los vecinos espaciales y la distancia al recurso más cercano. Traer eso
a la aplicación significaría varias consultas por reporte y una carrera con
cualquier otro proceso que esté insertando. Además, tenerlo en SQL permite
auditarlo y ajustarlo sin desplegar código.

## Materialización y frescura

La prioridad **no puede ser una columna generada**: dos de sus cinco términos
cambian sin que el reporte se modifique — el de espera crece con el reloj y el de
concentración cambia cuando aparecen reportes vecinos.

Se resuelve con dos caminos, y la diferencia entre ambos se expone en lugar de
esconderse:

| Camino | Qué da | Cuándo |
|---|---|---|
| `prioridad_score` + trabajador cada 60 s | columna indexable, ordena la cola | por defecto |
| `v_cola_prioridad_vivo` / `?vivo=true` | recálculo al consultar, exacto | cuando importa el segundo |

`prioridad_calculada_en` dice qué tan fresco es el número materializado. En una
sala de crisis conviene saber eso; una única respuesta ambigua sería peor.
