import { randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';

/** `specs/01` §4: argon2id, m=64MB, t=3, p=4, salt 16 B. */
export const PARAMETROS_ARGON2 = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 4,
} as const;

export const BYTES_SALT = 16;

/**
 * `argon2id` va EXPLICITO. El default de la libreria no esta garantizado entre
 * versiones y argon2i (el que a veces es el default) pasa la prueba de "es
 * argon2" y no pasa la de seguridad.
 */
export function hashear(clave: string): Promise<string> {
  return argon2.hash(clave, {
    ...PARAMETROS_ARGON2,
    salt: randomBytes(BYTES_SALT),
  });
}

/**
 * Verifica contra los parametros que trae el propio hash, no contra los
 * actuales: por eso subir `timeCost` mas adelante no invalida las contrasenas
 * ya guardadas.
 *
 * @returns `false` tambien ante un hash malformado, para que un registro
 * corrupto no se confunda con un acierto.
 */
export async function verificarHash(hash: string, clave: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, clave);
  } catch {
    return false;
  }
}

/**
 * `true` si el hash se creo con parametros distintos a los actuales.
 *
 * Es lo que habilita la migracion continua: el login verifica con lo que hay y
 * rehashea con los parametros de hoy. Un sistema que rehashea a mano obliga a
 * pedirle la contrasena vieja a cada usuario; este no.
 */
export function necesitaRehash(hash: string): boolean {
  return argon2.needsRehash(hash, { ...PARAMETROS_ARGON2 });
}
