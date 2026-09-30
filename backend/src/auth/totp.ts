import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/**
 * TOTP (RFC 6238) y base32 (RFC 4648), implementados acá y no con una
 * dependencia.
 *
 * Por qué no una librería (`otplib`, `otpauth`, `@otplib/preset-default`): este
 * es el **único** uso de TOTP del repo, son unas 60 líneas, y la alternativa era
 * sumar un paquete al `package.json` de un producto de identidad con
 * `argon2`, `jose` y `@prisma/client` como dependencias. Lo que sí pesa es que
 * la implementación quede **en el repo y con sus vectores de prueba**:
 * `scripts/verificar-mfa.mjs` corre los valores del RFC 6238 apéndice B contra
 * esta función, así que un cambio acá que rompa el algoritmo se ve sin
 * necesidad de una app de autenticación real.
 *
 * **SHA-1 no es un error acá.** RFC 6238 usa HMAC-SHA-1 y es lo que entiende
 * Google Authenticator, Microsoft Authenticator, Authy, 1Password y el resto de
 * las apps que alguien tiene instalada. El riesgo del SHA-1 en TOTP no es la
 * colisión de tramas: es la longitud efectiva de la clave, y 160 bits contra un
 * atacante que conoce el código de un período de 30 s es suficiente. Cambiar a
 * SHA-256 rompe la compatibilidad con las apps que ya están en el teléfono de la
 * gente, y `specs/01` §8 fija SHA-1.
 *
 * `specs/01` §8: TOTP SHA-1, 30 s, 6 dígitos, ventana ±1.
 */

/** Periodo en segundos. `specs/01` §8. */
export const PERIODO_SEG = 30;

/** Dígitos del código. */
export const DIGITOS = 6;

/**
 * Ventana de períodos aceptados a cada lado.
 *
 * `±1` es a la vez la tolerancia de reloj y **la ventana de reuso**: un código
 * válido en el período N también valida en N+1. La primera mitad se acepta
 * porque los relojes del teléfono y del servidor no coinciden al segundo; la
 * segunda se cierra en `mfa.service.ts` con `mfa_ultimo_periodo`.
 */
export const VENTANA_PERIODOS = 1;

/**
 * Bytes del secreto: 160, que es el tamaño de la clave de HMAC-SHA-1. Es el
 * estándar de facto de todas las apps de TOTP; un secreto más largo no aporta
 * nada y uno más corto le daría ventaja a un atacante.
 */
export const BYTES_SECRETO = 20;

/** Issuer del `otpauth://`. Se muestra en la app del usuario como cuenta. */
export const EMISOR_TOTP = 'Tourniquet';

const ALFABETO_BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Codifica bytes a base32 sin padding (RFC 4648).
 *
 * Sin padding a propósito: la forma canónica que imprimen las apps de TOTP
 * (`otpauth://` con la clave de 32 caracteres) no lleva `=`, y un `=` en el medio
 * de la URL hay que escaparlo. El padding tampoco hace falta para nuestra
 * entrada: los 20 bytes del secreto son exactamente 32 caracteres de base32
 * (160 / 5 = 32), sin resto.
 */
export function aBase32(bytes: Buffer): string {
  let salida = '';
  let buffer = 0;
  let bits = 0;

  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      salida += ALFABETO_BASE32[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    salida += ALFABETO_BASE32[(buffer << (5 - bits)) & 31];
  }

  return salida;
}

/**
 * Decodifica base32 a bytes. Tolera minúsculas, guiones y espacios **y los
 * descarta**, porque el usuario copia la clave de un cartel impreso donde puede
 * haber un espacio cada cinco caracteres, y del `otpauth://` pegado en un
 * navegador que a veces lo pasa con guiones.
 *
 * Un carácter fuera del alfabeto no se ignora en silencio: se lanza. Un secreto
 * mal leído que produce bytes distintos se detecta en el primer código
 *comparado, y un error en el momento de enrolar es un mensaje para el
 * admin; un secreto truncado en silencio sería un usuario que nunca puede
 * entrar.
 */
export function desdeBase32(texto: string): Buffer {
  const limpio = texto
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/=+$/, '');

  if (limpio.length === 0) {
    throw new Error('El secreto TOTP viene vacio.');
  }

  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;

  for (const caracter of limpio) {
    const valor = ALFABETO_BASE32.indexOf(caracter);
    if (valor < 0) {
      throw new Error(`El secreto TOTP tiene un caracter invalido: "${caracter}".`);
    }
    buffer = (buffer << 5) | valor;
    bits += 5;
    if (bits >= 8) {
      bytes.push((buffer >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

/** Genera un secreto nuevo, en base32, listo para el `otpauth://`. */
export function generarSecreto(): string {
  return aBase32(randomBytes(BYTES_SECRETO));
}

/** Período TOTP del instante dado: `floor(epoch / 30)`. */
export function periodoDe(fecha: Date = new Date()): number {
  return Math.floor(fecha.getTime() / 1000 / PERIODO_SEG);
}

/**
 * El código TOTP de **un** período.
 *
 * HMAC-SHA1 de un contador de 8 bytes en big-endian, y el truncamiento dinámico
 * de RFC 4226: se toma el último nibble del digest como offset, y los 4 bytes
 * que empiezan ahí como un entero, al que se le saca el bit de signo (el
 * `& 0x7f`) antes de módulo. El `& 0x7f` no es cosmético: sin él, un valor con
 * el bit 31 en 1 daría negativo y el módulo de un negativo en JavaScript no es
 * el que dice el RFC.
 *
 * @param secreto base32 (el que se entrega al usuario).
 * @param periodo número de período de 30 s. Se pasa explícito y no se calcula
 *   adentro para que la verificación con `periodo ± 1` sea una llamada por
 *   candidato y no tres relecturas del reloj.
 */
export function codigoDePeriodo(secreto: string, periodo: number): string {
  const clave = desdeBase32(secreto);

  // Contador de 8 bytes big-endian (RFC 4226), con BigInt porque el período
  // supera los 32 bits a partir de 2038 y `writeBigInt64BE` no existe en Node.
  const contador = Buffer.alloc(8);
  contador.writeBigInt64BE(BigInt(periodo));

  const digest = createHmac('sha1', clave).update(contador).digest();
  const offset = digest[digest.length - 1] & 0x0f;

  const binario =
    ((digest[offset] & 0x7f) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3];

  return String(binario % 10 ** DIGITOS).padStart(DIGITOS, '0');
}

/**
 * El código que corresponde a **ahora**, en el período propio.
 *
 * Es lo que usa la confirmación del enrolamiento (el usuario lo lee de la app y
 * lo tipea acá) y lo que se usa en las pruebas. Para **verificar** un código
 * que viene del usuario, usar `compararConVentana`.
 */
export function codigoActual(secreto: string, ahora: Date = new Date()): string {
  return codigoDePeriodo(secreto, periodoDe(ahora));
}

export interface ResultadoComparacion {
  ok: boolean;
  /**
   * Período del código que coincidió, o `null`. Lo devuelve la comparación para
   * que el llamador pueda **guardarlo** en `mfa_ultimo_periodo` y rechazar el
   * reuso (`specs/01` §8.3): sin este dato, guardar "el período actual" sirve
   * sólo de la mitad, porque el código que coincidió puede haber sido el del
   * período anterior.
   */
  periodo: number | null;
}

/**
 * Compara un código contra la ventana `±1`.
 *
 * La comparación es en **tiempo constante** (`timingSafeEqual`) y sobre el largo
 * exacto: un `===` sobre strings de 6 dígitos devuelve antes en el primer
 * carácter que difiere, y con eso un atacante que puede medir tiempos obtiene
 * el código dígito a dígito. Con 6 dígitos y una ventana de 3 períodos hay
 * 10^6 candidatos por período: el costo de la constante es nada y la diferencia
 * es el código entero.
 *
 * Los tres períodos se comparan de mayor a menor (T+1, T, T-1) para que, si un
 * código repetido coincidiera en dos períodos —que no puede pasar con TOTP de
 * 6 dígitos, pero el código no lo da por hecho—, gane el más reciente: es el que
 * deja el `mfa_ultimo_periodo` más alto y el que menos ventana de reuso deja
 * abierta.
 */
export function compararConVentana(
  secreto: string,
  codigo: string,
  ahora: Date = new Date(),
): ResultadoComparacion {
  const central = periodoDe(ahora);

  for (let delta = VENTANA_PERIODOS; delta >= -VENTANA_PERIODOS; delta -= 1) {
    const periodo = central + delta;
    if (comparacionConstante(codigoDePeriodo(secreto, periodo), codigo)) {
      return { ok: true, periodo };
    }
  }

  return { ok: false, periodo: null };
}

/**
 * Comparación en tiempo constante de dos códigos de largo fijo.
 *
 * `timingSafeEqual` **lanza** si los buffers tienen distinto largo, así que el
 * largo se compara antes: un código de 4 dígitos tiene que fallar, no romper el
 * ingreso con una excepción.
 */
function comparacionConstante(esperado: string, recibido: string): boolean {
  const a = Buffer.from(esperado.padEnd(DIGITOS, ' ').slice(0, DIGITOS), 'utf8');
  const b = Buffer.from(recibido.padEnd(DIGITOS, ' ').slice(0, DIGITOS), 'utf8');
  return timingSafeEqual(a, b) && a.length === b.length;
}

/**
 * `otpauth://totp/...` para enrolar (`specs/01` §8.1).
 *
 * El `label` va como `<issuer>:<cuenta>`, que es lo que Google Authenticator
 * muestra como dos líneas ("Tourniquet" arriba, el usuario abajo). Se
 * percent-encodinga con `encodeURIComponent` porque el usuario es un login
 * `[a-z0-9._-]` y no necesita escapado, pero un `usuario` futuro con otro
 * carácter rompería la URL sin que nadie lo viera.
 *
 * `algorithm=SHA1`, `digits=6` y `period=30` van explícitos: son los defaults de
 * la mayoría de las apps, pero escribirlos hace que el `otpauth://` diga lo que
 * este IdP espera en vez de depender de lo que la app asuma.
 */
export function uriOtpAuth(usuario: string, secreto: string): string {
  const etiqueta = encodeURIComponent(`${EMISOR_TOTP}:${usuario}`);
  const params = new URLSearchParams({
    secret: secreto,
    issuer: EMISOR_TOTP,
    algorithm: 'SHA1',
    digits: String(DIGITOS),
    period: String(PERIODO_SEG),
  });
  return `otpauth://totp/${etiqueta}?${params.toString()}`;
}

/**
 * Un código de recuperación, con el alfabeto sin ambiguos.
 *
 * Sin `I`, `L`, `O`, `U`, `0` ni `1`: se anotan en un papel y se leen en voz
 * alta, y un `0` escrito como `O` no sirve para entrar. 28 símbolos, 10
 * caracteres ⇒ ~48 bits, que es lo que alcanza para un factor de un solo uso con
 * retención de 90 días y cinco intentos por desafío (`specs/01` §8.5).
 *
 * `randomInt` y no `Math.random`: un código de recuperación predecible es peor que
 * no tener códigos.
 */
export const ALFABETO_CODIGO = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

export const LARGO_CODIGO = 10;

export function generarCodigoRecuperacion(): string {
  let salida = '';
  for (let i = 0; i < LARGO_CODIGO; i += 1) {
    salida += ALFABETO_CODIGO[randomInt(ALFABETO_CODIGO.length)];
  }
  return salida;
}

/**
 * Como lo ve el usuario: dos bloques de cinco, separados por un guion.
 *
 * El guion es de **presentación**. `normalizarCodigo` lo saca antes de hashear, y
 * por eso sirve en los dos casos si el usuario lo escribe con guion, sin guion o
 * con el guion copiado de un papel con doble espacio.
 */
export function formatearCodigo(codigo: string): string {
  return `${codigo.slice(0, 5)}-${codigo.slice(5)}`;
}

/**
 * Normaliza un codigo de recuperacion que viene del usuario: sin espacios, sin guiones y
 * en mayúsculas.
 *
 * Devuelve `null` si el resultado no tiene el largo exacto o tiene caracteres
 * fuera del alfabeto. `null` y no una excepción: el caso es un usuario que
 * tecleó mal, y el llamador lo trata como "código incorrecto" (una sola fila de
 * auditoría, sin detalle de qué se escribió).
 */
export function normalizarCodigo(entrada: string): string | null {
  const limpio = (entrada ?? '').toUpperCase().replace(/[\s-]/g, '');

  if (limpio.length !== LARGO_CODIGO) {
    return null;
  }

  for (const caracter of limpio) {
    if (!ALFABETO_CODIGO.includes(caracter)) {
      return null;
    }
  }

  return limpio;
}
