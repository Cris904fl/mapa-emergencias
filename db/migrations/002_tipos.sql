-- 002 · Tipos enumerados
--
-- Se usan ENUM y no tablas de catálogo porque son valores del dominio que
-- cambian con una migración, no en tiempo de ejecución: la lógica de
-- priorización y los tableros dependen de ellos. Agregar un valor a un ENUM
-- es `ALTER TYPE ... ADD VALUE`, barato; quitarlo requiere migración, lo cual
-- es correcto — borrar una categoría con reportes históricos no debe ser fácil.

CREATE TYPE rol_usuario AS ENUM (
  'CIUDADANO',     -- reporta; puede ser anónimo
  'OPERADOR',      -- hace triage en la sala de crisis
  'RESPONDIENTE',  -- atiende en campo
  'ADMIN'
);

CREATE TYPE tipo_organizacion AS ENUM (
  'GOBIERNO',      -- alcaldía, gobernación, UNGRD
  'SOCORRO',       -- bomberos, Defensa Civil, Cruz Roja
  'SALUD',
  'ONG',
  'COMUNITARIA',   -- junta de acción comunal, líderes de barrio
  'PRIVADA'
);

-- Geografía administrativa. El nivel VEREDA importa: en Colombia buena parte
-- de las emergencias ocurre en zona rural dispersa, donde no hay barrios.
CREATE TYPE tipo_lugar AS ENUM (
  'PAIS',
  'DEPARTAMENTO',
  'MUNICIPIO',
  'LOCALIDAD',
  'BARRIO',
  'VEREDA',
  'ZONA_ALBERGUE'
);

CREATE TYPE tipo_recurso AS ENUM (
  'HOSPITAL',
  'PUESTO_SALUD',
  'ALBERGUE',
  'PUNTO_AGUA',
  'PUNTO_ALIMENTO',
  'PUESTO_MANDO',
  'ESTACION_BOMBEROS',
  'EQUIPO_RESCATE',
  'AMBULANCIA',
  'MAQUINARIA',
  'HELIPUERTO'
);

CREATE TYPE estado_recurso AS ENUM (
  'DISPONIBLE',
  'OCUPADO',
  'AGOTADO',        -- el albergue está lleno, el punto de agua se acabó
  'FUERA_SERVICIO'
);

CREATE TYPE categoria_reporte AS ENUM (
  'PERSONAS_ATRAPADAS',
  'HERIDOS',
  'DESAPARECIDOS',
  'FALLECIDOS',
  'DANO_ESTRUCTURAL',
  'INCENDIO',
  'INUNDACION',
  'DESLIZAMIENTO',
  'VIA_BLOQUEADA',
  'NECESITA_AGUA',
  'NECESITA_ALIMENTO',
  'NECESITA_MEDICAMENTOS',
  'NECESITA_ALBERGUE',
  'SERVICIOS_CAIDOS',   -- energía, acueducto, telecomunicaciones
  'OTRO'
);

-- DESCONOCIDA es un valor de primera clase, no un NULL disfrazado: el ciudadano
-- muchas veces no sabe qué tan grave es, y la priorización debe tratar
-- "no sé" distinto de "no me lo dijeron".
CREATE TYPE severidad_reporte AS ENUM (
  'CRITICA',
  'ALTA',
  'MEDIA',
  'BAJA',
  'DESCONOCIDA'
);

CREATE TYPE estado_reporte AS ENUM (
  'RECIBIDO',
  'EN_TRIAGE',
  'VERIFICADO',
  'ASIGNADO',
  'EN_ATENCION',
  'RESUELTO',
  'DUPLICADO',
  'DESCARTADO'
);

-- Trazabilidad del dato: quién puso el número que ordena la cola de rescate.
-- La IA nunca debe poder escribir un campo sin dejar esta marca.
CREATE TYPE origen_dato AS ENUM (
  'CIUDADANO',   -- tal como lo envió quien reportó
  'IA',          -- extraído de texto libre por un modelo
  'OPERADOR'     -- corregido o confirmado por una persona
);

CREATE TYPE tipo_medio AS ENUM ('FOTO', 'VIDEO', 'AUDIO');
