#!/usr/bin/env node
/**
 * Verificación del TOTP contra los vectores del RFC 6238 (Fase 09).
 *
 * Este es el único lugar del repo donde el algoritmo de `auth/totp.ts` se
 * comprueba contra una fuente **externa**: los valores del apéndice B del RFC.
 * Todo lo demás (el login en dos pasos, la confirmación, la ventana) se prueba
 * por HTTP con `verificar-portal.mjs`; el algoritmo no, porque probarlo con el
 * propio código que lo implementa no probaría nada.
 *
 *   1. Base32 (RFC 4648): ida y vuelta, con y sin guiones.
 *   2. TOTP (RFC 6238, SHA-1, 6 dígitos): los cinco vectores del apéndice B con
 *      el secreto `12345678901234567890` en base32.
 *   3. Ventana ±1: un código del período anterior y del siguiente se aceptan; uno
 *      de hace 3 períodos no.
 *   4. Anti-reuso: el mismo período devuelve el mismo código (que es lo que el
 *      `mfa_ultimo_periodo` de la base tiene que impedir reutilizar).
 *   5. Códigos de recuperación: alfabeto sin ambiguos, formato y normalización.
 *
 * Uso:  npm run verificar:mfa
 */
import { cargar } from './lib/entorno.mjs';

const {
  aBase32,
  desdeBase32,
  codigoDePeriodo,
  compararConVentana,
  generarSecreto,
  generarCodigoRecuperacion,
  formatearCodigo,
  normalizarCodigo,
  ALFABETO_CODIGO,
  PERIODO_SEG,
  DIGITOS,
  VENTANA_PERIODOS,
  BYTES_SECRETO,
} = cargar('auth/totp.js');

let fallos = 0;
function verificar(descripcion, condicion, extra = '') {
  if (condicion) {
    console.log(`  [ok]   ${descripcion}${extra ? ` (${extra})` : ''}`);
  } else {
    fallos += 1;
    console.log(`  [FALLA] ${descripcion}${extra ? ` (${extra})` : ''}`);
  }
}

console.log('\n  Verificacion del TOTP (RFC 6238) y de los codigos de recuperacion\n');
console.log('  ' + '-'.repeat(64) + '\n');

// --- 1 · Base32 ---------------------------------------------------------------
// El secreto de los vectores del RFC son los 20 bytes ASCII "12345678901234567890".
const SECRETO_RFC = aBase32(Buffer.from('12345678901234567890', 'ascii'));
verificar('el secreto del RFC codifica a 32 caracteres base32', SECRETO_RFC.length === 32, SECRETO_RFC);
verificar(
  'base32 ida y vuelta (20 bytes)',
  desdeBase32(SECRETO_RFC).toString('ascii') === '12345678901234567890',
);
verificar(
  'base32 acepta guiones y espacios (pegado de un cartel impreso)',
  desdeBase32(`${SECRETO_RFC.slice(0, 8)} ${SECRETO_RFC.slice(8, 16)}-${SECRETO_RFC.slice(16)}`)
    .toString('ascii') === '12345678901234567890',
);
verificar('base32 acepta minusculas', desdeBase32(SECRETO_RFC.toLowerCase()).length === 20);

const secretoNuevo = generarSecreto();
verificar(
  'un secret nuevo son 20 bytes (160 bits, el tamano de HMAC-SHA1)',
  desdeBase32(secretoNuevo).length === BYTES_SECRETO,
  `${secretoNuevo.length} chars base32 = ${BYTES_SECRETO} bytes`,
);
verificar('dos secrets nuevos son distintos', generarSecreto() !== generarSecreto());

// --- 2 · Vectores del RFC 6238 (apendice B, SHA-1) ---------------------------
// El RFC publica valores de 8 digitos; el codigo de 6 digitos es el mismo numero
// dinamico truncado, o sea `valor % 10^6`.
//
// OJO con la columna "Time (sec)" del apendice B: son **segundos**, no el
// contador. Con T0=0 y X=30, el tiempo 59 corresponde al contador 1, no al 59.
// Es la trampa de esta comprobacion: pasar el tiempo tal cual como periodo da
// codigos que se ven "plausibles" (6 digitos, cambian cada 30 s) y que no
// coinciden con ninguna app del mundo. Por eso la conversion va explicita y
// comentada, y no escondida en un `.map`.
const VECTORES = [
  { segundos: 59, ocho: '94287082' },
  { segundos: 1111111109, ocho: '07081804' },
  { segundos: 1111111111, ocho: '14050471' },
  { segundos: 1234567890, ocho: '89005924' },
  { segundos: 2000000000, ocho: '69279037' },
  { segundos: 20000000000, ocho: '65353130' },
];

console.log('\n  Vectores del RFC 6238 (secreto "12345678901234567890", SHA-1, 30 s):');
console.log('  La columna "Time" del RFC son SEGUNDOS; el contador es floor(t/30).\n');
for (const { segundos, ocho } of VECTORES) {
  const contador = Math.floor(segundos / PERIODO_SEG);
  const esperado = ocho.slice(-DIGITOS);
  const obtenido = codigoDePeriodo(SECRETO_RFC, contador);
  verificar(`T=${segundos}s (contador ${contador}) -> ${esperado}`, obtenido === esperado, obtenido);
}

// --- 3 · Ventana +-1 ----------------------------------------------------------
// `compararConVentana` compara contra el AHORA, asi que los periodos se eligen
// relativos a el en vez de usar el reloj del RFC.
const ahoraMs = Date.now();
const periodoAhora = Math.floor(ahoraMs / 1000 / PERIODO_SEG);
const dentroDe = (periodo) => new Date(periodo * PERIODO_SEG * 1000 + 1000);

verificar(
  `el codigo del periodo actual se acepta (ventana ${VENTANA_PERIODOS})`,
  compararConVentana(secretoNuevo, codigoDePeriodo(secretoNuevo, periodoAhora), new Date(ahoraMs)).ok,
);
verificar(
  'el codigo del periodo anterior se acepta (reloj del telefono atrasado)',
  compararConVentana(
    secretoNuevo,
    codigoDePeriodo(secretoNuevo, periodoAhora - 1),
    new Date(ahoraMs),
  ).ok,
);
verificar(
  'el codigo del periodo siguiente se acepta (reloj adelantado)',
  compararConVentana(
    secretoNuevo,
    codigoDePeriodo(secretoNuevo, periodoAhora + 1),
    new Date(ahoraMs),
  ).ok,
);
verificar(
  'un codigo de hace 3 periodos NO se acepta',
  !compararConVentana(
    secretoNuevo,
    codigoDePeriodo(secretoNuevo, periodoAhora - 3),
    new Date(ahoraMs),
  ).ok,
);
verificar(
  'un codigo cualquiera NO se acepta',
  !compararConVentana(secretoNuevo, '000000', new Date(ahoraMs)).ok ||
    codigoDePeriodo(secretoNuevo, periodoAhora) === '000000',
);
verificar(
  'un codigo de 4 digitos no revienta la comparacion (se compara en tiempo constante)',
  !compararConVentana(secretoNuevo, '1234', new Date(ahoraMs)).ok,
);
verificar(
  'el periodo devuelto es el del codigo que coincidio, no el central',
  compararConVentana(secretoNuevo, codigoDePeriodo(secretoNuevo, periodoAhora - 1), new Date(ahoraMs))
    .periodo === periodoAhora - 1,
);

// --- 4 · Determinismo (lo que hace posible el anti-reuso) ---------------------
verificar(
  'el mismo periodo da siempre el mismo codigo',
  codigoDePeriodo(secretoNuevo, periodoAhora) === codigoDePeriodo(secretoNuevo, periodoAhora),
);
verificar('el codigo tiene 6 digitos', /^\d{6}$/.test(codigoDePeriodo(secretoNuevo, periodoAhora)));
verificar('dentroDe() es coherente con el periodo', dentroDe(periodoAhora).getTime() > ahoraMs - 60_000);

// --- 5 · Codigos de recuperacion ----------------------------------------------
console.log('\n  Codigos de recuperacion:');
verificar(
  'el alfabeto no tiene I, L, O, U, 0 ni 1',
  !/[ILOU01]/.test(ALFABETO_CODIGO),
  `${ALFABETO_CODIGO.length} simbolos`,
);
const codigo = generarCodigoRecuperacion();
verificar('el codigo tiene 10 caracteres', codigo.length === 10, codigo);
verificar('el codigo usa solo el alfabeto', [...codigo].every((c) => ALFABETO_CODIGO.includes(c)));
verificar('dos codigos son distintos', generarCodigoRecuperacion() !== generarCodigoRecuperacion());
verificar('el formato es XXXXX-XXXXX', formatearCodigo(codigo) === `${codigo.slice(0, 5)}-${codigo.slice(5)}`);
verificar(
  'normalizar acepta lo que el usuario ve en el papel',
  normalizarCodigo(formatearCodigo(codigo).toLowerCase()) === codigo,
  normalizarCodigo(formatearCodigo(codigo).toLowerCase()) ?? 'null',
);
verificar('normalizar acepta con espacios', normalizarCodigo(` ${codigo} `) === codigo);
verificar('un codigo corto se rechaza', normalizarCodigo('ABC') === null);
verificar('un simbolo fuera del alfabeto se rechaza', normalizarCodigo('ABCDEFGH-J') === null);

console.log('\n  ' + '-'.repeat(64) + '\n');
console.log(`  ${fallos === 0 ? 'TODO OK' : `${fallos} COMPROBACION(ES) FALLIDA(S)`}\n`);
console.log('  Esto comprueba el ALGORITMO. El camino completo (login en dos pasos,');
console.log('  confirmacion, codigo de recuperacion, amr) se prueba por HTTP con');
console.log('  `npm run verificar:portal -- --mfa`.\n');

process.exit(fallos === 0 ? 0 : 1);
