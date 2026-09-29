#!/usr/bin/env node
/**
 * Genera `TQ_MASTER_KEY`: 32 bytes aleatorios en base64.
 *
 * El script IMPRIME la clave. No escribe ningun archivo, y en particular no
 * toca el `.env`: el entorno lo edita la persona a mano. Un archivo que el
 * repo gitignorea sigue siendo un archivo que puede terminar en un backup, en
 * un chat o en un `cp` a otro lado; que la clave exista en un solo lugar hace
 * que perderla sea un incidente y no una sorpresa.
 *
 * Uso:  npm run generar:clave
 */
import { randomBytes } from 'node:crypto';

const LONGITUD = 32;
const BYTES_POR_LINEA = 64;

/** Sin argumentos, sin flags: si acepta opciones, alguien las va a pasar. */
if (process.argv.length > 2) {
  console.error('Este script no acepta argumentos.');
  console.error('Uso: npm run generar:clave');
  process.exit(1);
}

const clave = randomBytes(LONGITUD).toString('base64');

console.log('');
console.log('  TQ_MASTER_KEY (32 bytes, base64)');
console.log('  ' + '-'.repeat(BYTES_POR_LINEA));
console.log('');
console.log(`  TQ_MASTER_KEY=${clave}`);
console.log('');
console.log('  Cargala en el entorno. En desarrollo, en el .env que editas a mano:');
console.log('');
console.log(`      TQ_MASTER_KEY=${clave}`);
console.log('');
console.log('  En produccion va al gestor de secretos del cliente, NO al .env del');
console.log('  servidor (ver deploy/runbooks y la Fase 10).');
console.log('');
console.log('  ------------------------------------------------------------------');
console.log('  Esta master key NO tiene recuperacion. Si la perdes, no hay');
console.log('  restore posible: hay que regenerar las claves de firma de');
console.log('  tok_clave_firma y volver a cifrar todas las credenciales de');
console.log('  cat_base_datos. Guardala en el gestor de secretos, no "en un');
console.log('  lugar seguro" cualquiera.');
console.log('  ------------------------------------------------------------------');
console.log('');
console.log('  Este valor no vuelve a aparecer por pantalla. Si lo perdes,');
console.log('  genera uno nuevo ANTES de tener datos cifrados.');
console.log('');
