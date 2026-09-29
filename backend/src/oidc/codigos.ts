import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Generacion y verificacion de los dos valores opacos del flujo: el
 * authorization code y el refresh token.
 *
 * Los dos son de un solo uso y los dos se guardan **hasheados** (sha256) en la
 * base (`specs/02` §3). Si alguien lee la base de control no puede canjear codes
 * ni refresh tokens: no tiene los valores, tiene sus huellas.
 */

/** 32 bytes = 256 bits. RFC 6749 §10.10 pide 128 bits como minimo. */
const BYTES_OPACOS = 32;

/** Codigo authorization. Opaque para el cliente: no es un JWT. */
export function generarCode(): string {
  return randomBytes(BYTES_OPACOS).toString('base64url');
}

/** Refresh token. Opaque: al reves que un JWT, no se puede leer ni falsificar. */
export function generarRefreshToken(): string {
  return randomBytes(BYTES_OPACOS).toString('base64url');
}

/** `verifier` del cliente. */
export function generarCodeVerifier(): string {
  return randomBytes(BYTES_OPACOS).toString('base64url');
}

/** Huella sha256 en hex (64 caracteres), que es lo que se persiste y se indexa. */
export function sha256Hex(valor: string): string {
  return createHash('sha256').update(valor, 'utf8').digest('hex');
}

/** `code_challenge` de PKCE S256: `base64url(sha256(code_verifier))`. */
export function challengeS256(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');
}

/**
 * Comparacion en tiempo constante.
 *
 * Comparar con `!==` sobre dos strings devuelve en cuanto encuentra la primer
 * diferencia: el tiempo de respuesta filtra Informacion byte a byte. Aca se
 * comparan los SHA-256 de los dos valores, que tienen siempre la misma long
 * (32 bytes), asi que `timingSafeEqual` no puede fallar por largos distintos y
 * la comparacion no depende de donde este el primer caracter diferente.
 *
 * Se usa para el `code_verifier` contra el `code_challenge` guardado.
 */
export function compararSecreto(a: string, b: string): boolean {
  const huellaA = createHash('sha256').update(a, 'utf8').digest();
  const huellaB = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(huellaA, huellaB);
}

/**
 * Un JWT son tres segmentos separados por punto. Lo unico que se usa para
 * distinguirlos es el tipo de credencial que se esta-presentando: un access
 * token se verifica por firma, un refresh token se busca por su hash. No es una
 * decision de seguridad: `token` es opaco y el unico que decide es el servidor.
 */
export function esJwt(token: string): boolean {
  return token.split('.').length === 3;
}

/** Primeros 8 hex de la huella, para logs y auditoria. Nunca el valor. */
export function huellaCorta(valor: string): string {
  return sha256Hex(valor).slice(0, 8);
}
