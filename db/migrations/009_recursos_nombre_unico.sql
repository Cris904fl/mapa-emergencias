-- ---------------------------------------------------------------------------
-- 009 · Nombre único de recurso, para poder recargarlos sin duplicar
-- ---------------------------------------------------------------------------
-- Los recursos se cargan desde un archivo (scripts/cargar-recursos.mjs) y esa
-- lista se va a corregir varias veces: una coordenada mal copiada, un hospital
-- que cierra, una estación que se agrega. Sin un identificador estable, cada
-- recarga duplicaría todo.
--
-- El nombre es lo único que sirve de identificador natural acá: no hay código
-- oficial común entre hospitales, bomberos y albergues. Se compara en
-- minúsculas porque «Hospital San Rafael» y «HOSPITAL SAN RAFAEL» son el mismo
-- sitio, y duplicarlos rompería el término de aislamiento del índice: dos
-- copias del mismo hospital no ponen más ayuda cerca de nadie.
--
-- Es la misma convención que ya usa `organizaciones`.

CREATE UNIQUE INDEX recursos_nombre_unico_ix ON recursos (lower(nombre));

COMMENT ON INDEX recursos_nombre_unico_ix IS
  'Permite recargar la lista de recursos de forma idempotente (ON CONFLICT).';
