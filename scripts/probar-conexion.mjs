#!/usr/bin/env node
/**
 * Comprueba que DATABASE_URL conecta y que PostGIS está instalado.
 *
 *   npm run bd:probar-conexion
 *
 * Imprime el host al que se conectó —para que un marcador de plantilla sin
 * reemplazar salte a la vista— pero nunca la contraseña.
 */

import pg from 'pg';

const cadena = process.env.DATABASE_URL;

if (!cadena) {
  console.error('DATABASE_URL no está definida. ¿Falta el .env?');
  process.exit(1);
}

const url = new URL(cadena);
console.log('host   :', url.host);
console.log('usuario:', url.username);

const cliente = new pg.Client({ connectionString: cadena });

try {
  await cliente.connect();
  const { rows } = await cliente.query(
    `SELECT current_database() AS bd,
            split_part(version(), ' ', 2) AS postgres,
            (SELECT extversion FROM pg_extension WHERE extname = 'postgis') AS postgis,
            (SELECT count(*)::int FROM migraciones_aplicadas) AS migraciones`,
  );
  const f = rows[0];
  console.log('\nCONECTADO');
  console.log('  base       :', f.bd);
  console.log('  PostgreSQL :', f.postgres);
  console.log('  PostGIS    :', f.postgis ?? 'NO INSTALADO — falta CREATE EXTENSION postgis;');
  console.log('  migraciones:', f.migraciones, 'aplicadas');
} catch (error) {
  const mensaje = error instanceof Error ? error.message : String(error);
  console.error('\nFALLO:', mensaje);

  // Los tres errores que salen de verdad, con su causa real. Ninguno de los
  // tres se parece a lo que en realidad está pasando.
  if (mensaje.includes('ENOTFOUND')) {
    console.error(
      '  → El host no resuelve. Si es «db.<algo>.supabase.co», esa dirección es\n' +
        '    solo IPv6: use la cadena del pooler (aws-N-REGION.pooler.supabase.com).',
    );
  } else if (mensaje.includes('self-signed certificate')) {
    console.error('  → Falta «uselibpqcompat=true» en la cadena de conexión.');
  } else if (/password|authentication/i.test(mensaje)) {
    console.error(
      '  → Revise el usuario: en el pooler es «postgres.<ref-del-proyecto>»,\n' +
        '    no «postgres». Y un cambio de contraseña tarda unos minutos.',
    );
  } else if (mensaje.includes('migraciones_aplicadas')) {
    console.error('  → Conectó bien, pero falta correr «npm run bd:migrar».');
  }
  process.exitCode = 1;
} finally {
  await cliente.end().catch(() => {});
}
