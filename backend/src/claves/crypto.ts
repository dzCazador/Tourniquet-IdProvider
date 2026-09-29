import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** Longitud exacta de la master key, en bytes. `specs/01` §6. */
export const LONGITUD_MASTER_KEY = 32;

/** 32 bytes en base64 son 44 caracteres (con un solo `=` de relleno). */
export const LONGITUD_MASTER_KEY_CARACTERES = 44;

/** Bytes de IV. 96 bits: el tamaño recomendado por NIST SP 800-38D para GCM. */
export const BYTES_IV = 12;

/** Bytes de tag de autenticacion. */
export const BYTES_TAG = 16;

/** `iv(12) || tag(16)` pegados al ciphertext (`specs/02` §2). */
export const OVERHEAD_CIFRADO = BYTES_IV + BYTES_TAG;

const ALGORITMO = 'aes-256-gcm';

const BASE64_ESTRICTO = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Valida `TQ_MASTER_KEY`: mide 32 bytes exactos y decodifica de base64
 * de verdad. `Buffer.from(x, 'base64')` es permisivo (ignora caracteres raros y
 * recorta), asi que un valor corrupto pasaria el chequeo de largo y produciria
 * una clave equivocada en silencio. Ahi se hace el round-trip.
 *
 * No hay fallback ni derivacion: si la master key no esta, la app no arranca.
 */
export function decodificarMasterKey(masterKeyB64: string | undefined): Buffer {
  const valor = (masterKeyB64 ?? '').trim();

  if (valor === '') {
    throw new Error(
      'TQ_MASTER_KEY no esta definida. Generala con "npm run generar:clave" y ' +
        'cargala en el entorno. Sin ella no se puede descifrar tok_clave_firma.',
    );
  }

  if (!BASE64_ESTRICTO.test(valor) || valor.length % 4 !== 0) {
    throw new Error('TQ_MASTER_KEY no es base64 valido (se espera base64 estandar).');
  }

  const bytes = Buffer.from(valor, 'base64');

  if (bytes.length !== LONGITUD_MASTER_KEY) {
    throw new Error(
      `TQ_MASTER_KEY debe tener ${LONGITUD_MASTER_KEY} bytes exactos ` +
        `(${LONGITUD_MASTER_KEY_CARACTERES} caracteres base64); se decodificaron ${bytes.length} bytes ` +
        `(${valor.length} caracteres). Generala con "npm run generar:clave".`,
    );
  }

  if (bytes.toString('base64') !== valor) {
    throw new Error('TQ_MASTER_KEY no es base64 canonico: no se puede decodificar sin perdida.');
  }

  return bytes;
}

/**
 * Cifra con AES-256-GCM. El IV es aleatorio POR REGISTRO y va pegado al
 * ciphertext: reutilizar un IV con GCM rompe la confidencialidad por completo
 * (se recuperan los dos textos y se falsifica el tag), asi que jamas se
 * deriva ni se hardcodea uno.
 *
 * @returns `iv(12) || tag(16) || ciphertext`, listo para una columna
 * `varbinary`. Ojo con el tamaño: una credencial de base entra en
 * `varbinary(512)`, pero el PEM PKCS#8 de una RSA 2048 ronda los 1700 B y
 * necesita `varbinary(max)` (`specs/02` §2).
 */
export function cifrar(texto: string, masterKeyB64: string): Buffer {
  const clave = decodificarMasterKey(masterKeyB64);
  const iv = randomBytes(BYTES_IV);

  const cifrador = createCipheriv(ALGORITMO, clave, iv);
  const ciphertext = Buffer.concat([cifrador.update(texto, 'utf8'), cifrador.final()]);

  return Buffer.concat([iv, cifrador.getAuthTag(), ciphertext]);
}

/**
 * Revierte `cifrar`. Si el tag no cuadra (clave equivocada, fila corrupta,
 * alguien edito los bytes) `final()` lanza: la autenticacion de GCM es la
 * unica defensa contra cifrado manipulado, nunca se la saltea.
 */
export function descifrar(buf: Buffer, masterKeyB64: string): string {
  const clave = decodificarMasterKey(masterKeyB64);

  if (buf.length <= OVERHEAD_CIFRADO) {
    throw new Error('Registro cifrado truncado: no alcanza para iv(12)+tag(16)+ciphertext.');
  }

  const iv = buf.subarray(0, BYTES_IV);
  const tag = buf.subarray(BYTES_IV, BYTES_IV + BYTES_TAG);
  const ciphertext = buf.subarray(BYTES_IV + BYTES_TAG);

  const descifrador = createDecipheriv(ALGORITMO, clave, iv);
  descifrador.setAuthTag(tag);

  return Buffer.concat([descifrador.update(ciphertext), descifrador.final()]).toString('utf8');
}
