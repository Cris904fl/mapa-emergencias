#!/usr/bin/env node
/**
 * Cambia la contraseña dentro de DATABASE_URL en el .env, codificándola bien.
 *
 *   node scripts/fijar-clave-bd.mjs 'la-clave-nueva'
 *
 * Existe por una razón concreta: la contraseña vive dentro de una URL, así que
 * un `@`, un `#` o un `/` la parten en dos y el error que sale —«ENOTFOUND» o
 * «autenticación fallida»— no se parece en nada a su causa. Aquí se codifica
 * con encodeURIComponent y se acabó el problema.
 *
 * No imprime la contraseña. Solo dice qué host y qué usuario quedaron.
 */

import { readFileSync, writeFileSync } from 'node:fs';

const clave = process.argv[2];

if (!clave) {
  console.error(
    "Uso: node scripts/fijar-clave-bd.mjs 'la-clave-nueva'\n" +
      '  · Use comillas simples: la clave puede traer caracteres que el shell interpreta.',
  );
  process.exit(1);
}

const RUTA = '.env';
const contenido = readFileSync(RUTA, 'utf8');
const lineas = contenido.split(/\r?\n/);

const indice = lineas.findIndex((l) => l.startsWith('DATABASE_URL='));
if (indice === -1) {
  console.error(`No hay ninguna línea DATABASE_URL= activa en ${RUTA}.`);
  process.exit(1);
}

const url = new URL(lineas[indice].slice('DATABASE_URL='.length).trim());
url.password = encodeURIComponent(clave);

// El pooler de Supabase presenta una cadena de certificados que `pg` no valida
// contra el almacén del sistema. Sin esto falla con «self-signed certificate».
if (!url.searchParams.has('uselibpqcompat')) url.searchParams.set('uselibpqcompat', 'true');
if (!url.searchParams.has('sslmode')) url.searchParams.set('sslmode', 'require');

lineas[indice] = `DATABASE_URL=${url.toString()}`;
writeFileSync(RUTA, lineas.join('\n'));

console.log('Actualizado', RUTA);
console.log('  host    :', url.host);
console.log('  usuario :', url.username);
console.log('  clave   :', clave.length, 'caracteres (codificados:', url.password.length + ')');
console.log('  params  :', url.search);
console.log('\nPruebe con:  npm run bd:probar-conexion');
