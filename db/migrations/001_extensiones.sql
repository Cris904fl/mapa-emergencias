-- 001 · Extensiones
-- PostGIS es el motor geoespacial; el resto son utilidades que el esquema
-- usa directamente, así que se declaran acá y no en cada migración.

CREATE EXTENSION IF NOT EXISTS postgis;      -- geography, GiST, ST_*
CREATE EXTENSION IF NOT EXISTS pgcrypto;     -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pg_trgm;      -- búsqueda por similitud en descripciones
CREATE EXTENSION IF NOT EXISTS citext;       -- correos sin distinción de mayúsculas
CREATE EXTENSION IF NOT EXISTS unaccent;     -- "Bogotá" ≡ "Bogota" al buscar lugares
