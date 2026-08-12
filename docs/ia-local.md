# IA local con Ollama

Cómo funciona la extracción de texto libre con un modelo local, y —más
importante— **qué se midió y qué salió mal**. El prompt y el esquema de
`apps/api/src/servicios/ia/extractor.ts` no son un primer borrador: son el
resultado de tres iteraciones medidas contra casos reales.

## Por qué un modelo local

- **Gratis.** No hay cuota que se agote a mitad de una emergencia.
- **Los datos no salen de la máquina.** Los reportes traen descripciones de
  personas concretas, direcciones y teléfonos. Que eso no viaje a un tercero es
  una propiedad valiosa por sí misma, no solo un ahorro.
- **Funciona sin internet.** Si la sala de crisis tiene el servidor en LAN, la
  extracción sigue funcionando aunque se caiga el enlace externo.

El costo es la velocidad, y no es menor: ver las mediciones.

## Puesta en marcha

```bash
ollama pull qwen2.5          # 4.4 GB, 7B, Q4_K_M
```

En `.env`:

```
IA_PROVEEDOR=ollama
IA_MODELO=qwen2.5:latest
OLLAMA_URL=http://localhost:11434
IA_APLICAR_AUTOMATICAMENTE=false
```

`GET /listo` confirma que el proveedor está bien configurado:

```json
"extraccion_ia": {
  "ok": true,
  "detalle": "ollama · qwen2.5:latest · alcanzable · aplica sin revisión: no"
}
```

Comprueba también que el modelo esté **descargado**, no solo que Ollama
responda: si falta, Ollama intenta bajarlo en medio de la petición y el primer
reporte se queda esperando varios minutos sin explicación.

## Decodificación restringida: la razón de que esto funcione

Ollama acepta un JSON Schema en el parámetro `format`. Con él, el muestreo
**solo puede emitir tokens que produzcan JSON válido contra el esquema**. No es
que se le pida al modelo que devuelva JSON y se cruce los dedos: es imposible
que devuelva otra cosa.

Consecuencia práctica: un modelo de 7B produce estructura correcta de forma
consistente. Lo que la gramática **no** garantiza es que los valores tengan
sentido —ni que respeten `min(0)`— así que la salida se valida igual con el mismo
esquema Zod. Un conteo negativo pasaría la gramática y rompería la función de
prioridad.

## Mediciones

Máquina: Intel i7-10510U (4 núcleos, portátil de 2019), **sin GPU dedicada**,
inferencia por CPU. Modelo `qwen2.5:7b` Q4_K_M. Temperatura 0.

### Iteración 1 — el esquema en orden "natural"

`categoria` primero, luego conteos, luego justificación.

| | Resultado |
|---|---|
| Conteos correctos | 4/4 |
| Categoría correcta | **1/4** |

Los conteos salieron perfectos, incluida la trampa de «somos como 40 casas», que
no convirtió en 40 personas, y los vulnerables de «dos niños pequeños y un
abuelo» (3). Pero la categoría fue casi aleatoria: `SERVICIOS_CAIDOS` para gente
atrapada, `FALLECIDOS` para falta de agua.

Las justificaciones en prosa eran correctas, así que el modelo *entendía*. El
problema era estructural: bajo decodificación restringida el JSON se emite en el
orden del esquema, así que el modelo tenía que elegir la categoría —la decisión
más difícil— antes de haber razonado nada, y la gramática sobre un enum de 15
valores lo encerraba en la primera rama que alcanzaba.

### Iteración 2 — justificación primero

Se movió `justificacion` al principio y las clasificaciones al final, y se agregó
una guía de categorías con reglas de desempate.

| | Resultado |
|---|---|
| Categoría correcta | **4/6** |

Es cadena de pensamiento dentro de la salida estructurada: el modelo razona en un
campo de texto y luego se compromete. De los dos fallos restantes, uno era un
desacuerdo defendible (¿techo caído es `DANO_ESTRUCTURAL` o `NECESITA_ALBERGUE`?
mi respuesta esperada era discutible).

Pero apareció el fallo grave:

- «no sabemos cuántos hay adentro» → `atrapadas: 1`
- «varias personas no pueden salir» → `afectadas: 5, atrapadas: 5`

**Cifras inventadas.** El prompt decía explícitamente que no inventara, y aun así
lo hacía. Es el peor error posible del sistema: ese número ordena la cola de
rescate.

### Iteración 3 — la escapatoria explícita

Se agregó `cantidad_indeterminada: boolean` al esquema, justo después de la
justificación, con instrucción de usarlo cuando el texto habla de personas sin
dar cifra.

| | Resultado |
|---|---|
| Categoría correcta | 6/7 |
| **Cifras inventadas** | **0** |
| Bandera indeterminada correcta | 6/7 |

Los dos casos que antes inventaban ahora devuelven 0 con la bandera activada y
confianza `BAJA`, lo que además encaja con la guarda que ya existía: el triage no
aplica propuestas de confianza baja.

La lección: cuando un modelo inventa un valor, no hay que insistir en el prompt —
hay que darle una salida más fácil de tomar que inventar, y una señal para que el
código no confíe en el resto.

### Latencia

| Momento | Tiempo |
|---|---|
| Primera llamada (carga del modelo + prompt de ~1080 tokens) | **178 s** |
| Llamadas siguientes, modelo cargado | **~48 s** |

La caída de 178 a 48 s es la caché de prefijo: el prompt del sistema es idéntico
en cada llamada, así que Ollama reutiliza su KV cache mientras el modelo siga
cargado. Vale la pena subir `OLLAMA_KEEP_ALIVE` para que no se descargue entre
reportes.

**~48 s por reporte no sirve para uso interactivo, y sí sirve para lo que hace
este sistema:** la extracción corre en un trabajador de BullMQ, no en el camino de
la petición del ciudadano. El reporte se acepta y se responde en milisegundos; el
enriquecimiento llega después.

Para acelerar: `qwen2.5:3b` es ~2× más rápido con menos calidad, o cualquier
máquina con GPU cambia el orden de magnitud.

## Qué NO se le deja escribir al modelo

Tres capas, todas apoyadas en las mediciones de arriba.

**1. `IA_APLICAR_AUTOMATICAMENTE=false` por defecto.** La propuesta se guarda en
`extracciones_ia` con su justificación y sus discrepancias, se muestra en el
tablero, y la aplica un operador con un clic. Con un modelo local esto es lo
correcto, no una precaución excesiva: ver el caso de abajo.

**2. `personas_atrapadas` nunca se aplica automáticamente, ni con confianza
ALTA.** Es el campo con más apalancamiento del sistema —pesa ×3 en la carga
humana del índice de prioridad— y el que el modelo se equivoca de forma
reproducible:

| Texto del reporte | Propuso | El texto dice |
|---|---|---|
| «se nos cayó el techo, somos una familia de 7» | `atrapadas: 7` | que se quedaron sin techo |
| «se nos inundó la casa, el agua nos llega a la rodilla, somos 4» | `atrapadas: 4` | que hay agua en la casa |

Ninguno dice que alguien esté atrapado, y en los dos el modelo lo afirmó con
confianza ALTA. El segundo caso se observó con la aplicación automática
encendida: la prioridad del reporte pasó de 16.93 a 49.28, buena parte de eso
sobre un dato inventado. Esa es la razón de que el campo esté excluido en
`calcularActualizacion`, con una prueba que lo fija.

**3. La categoría nunca se aplica.** Define qué equipo se despacha. La propuesta
del modelo se registra como discrepancia para que un operador la lea.

Y por encima de todo, el trigger de la base impide que un proceso automático
sobreescriba un reporte que ya tocó una persona (`origen_triage = 'OPERADOR'`).

## Imágenes

`qwen2.5:7b` **no** es multimodal. Para el etiquetado de fotos hace falta un
modelo con visión:

```bash
ollama pull gemma3:4b        # multimodal y multilingüe, 3.3 GB
```

El etiquetado usa el mismo proveedor, así que basta cambiar `IA_MODELO`. No se
midió: queda pendiente.

## Otros proveedores

La capa de `proveedores.ts` expone la misma interfaz para tres backends, así que
cambiar es cuestión de variables de entorno:

| `IA_PROVEEDOR` | Para qué |
|---|---|
| `ollama` | local, gratis, privado |
| `compatible` | cualquier API con forma OpenAI: Groq, OpenRouter, vLLM, LM Studio |
| `anthropic` | la mejor calidad de las tres, de pago |

`compatible` es el camino para un despliegue en la nube, donde no cabe un modelo
local — ver [`despliegue-gratuito.md`](despliegue-gratuito.md).
