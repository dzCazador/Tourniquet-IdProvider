#!/usr/bin/env node
/**
 * Verificacion por script de la Fase 02. No mira nada "a ojo": cada criterio
 * de aceptacion que se puede comprobar sin app corriendo se comprueba aca.
 *
 *   1. `clave_privada_cifrada` es binario iv(12)+tag(16)+ciphertext, no texto.
 *   2. Descifrar con `TQ_MASTER_KEY` devuelve un PEM RSA valido.
 *   3. Firmar un JWT con la clave leida de la base y validarlo con
 *      `jwtVerify` de jose contra la clave publica del JWKS.
 *   4. El header lleva `alg=RS256` y el `kid` de la fila.
 *   5. `alg=none` y HS256 los rechaza el verificador.
 *   6. El JWKS trae la activa y excluye las retiradas de mas de 24 h.
 *
 * Imprime el JWT completo, que es material PUBLICO y de vida corta.
 *
 * Uso:  npm run verificar:clave
 */
import { createRequire } from 'node:module';
import { createPrivateKey, randomUUID } from 'node:crypto';
import { cargar, prepararEntorno } from './lib/entorno.mjs';

const { PrismaService } = cargar('prisma/prisma.service.js');
const { FirmaService } = cargar('claves/firma.service.js');
const { MasterKeyService } = cargar('claves/master-key.service.js');
const { cifrar, descifrar, OVERHEAD_CIFRADO } = cargar('claves/crypto.js');
const jose = createRequire(import.meta.url)('jose');

let fallos = 0;
function verificar(descripcion, condicion, extra = '') {
  if (condicion) {
    console.log(`  [ok]   ${descripcion}${extra ? ` (${extra})` : ''}`);
  } else {
    fallos += 1;
    console.log(`  [FALLA] ${descripcion}${extra ? ` (${extra})` : ''}`);
  }
}

console.log('\n  Verificacion de claves de firma\n');
console.log('  ' + '-'.repeat(64) + '\n');

/** Para poder cerrar la conexion desde el catch, que vive fuera de `ejecutar`. */
let prismaInstancia = null;

try {
  await ejecutar();
} catch (error) {
  await prismaInstancia?.$disconnect?.().catch(() => {});
  const mensaje = error instanceof Error ? error.message : String(error);
  const esConexion =
    error?.constructor?.name === 'PrismaClientInitializationError' ||
    /Can't reach database server|Initialization engine error|P1001|P1002/i.test(mensaje);
  if (esConexion) {
    const catalogo = (process.env.DATABASE_URL || '').match(/database=([^;]+)/i)?.[1] ?? '(sin definir)';
    console.error('\n  No pude conectarme a la base de control.');
    console.error(`  Catalogo apunta a: ${catalogo}\n`);
  } else {
    console.error(`\n  ${mensaje}\n`);
  }
  process.exit(1);
}

async function ejecutar() {
// Entorno validado con el mismo esquema de Joi que la app.
const { entorno, configService } = prepararEntorno();
const masterKey = new MasterKeyService(configService);
const EMISOR = entorno.TQ_ISSUER;

prismaInstancia = new PrismaService(entorno.DATABASE_URL);
const firma = new FirmaService(prismaInstancia, masterKey);

const kid = await firma.asegurarActiva();
const fila = await prismaInstancia.tok_clave_firma.findUnique({ where: { kid } });
const cifrado = Buffer.from(fila.clave_privada_cifrada);

console.log(`  kid=${kid}  ${cifrado.length} bytes cifrados\n`);

// 1. Es binario, no texto.
verificar('clave_privada_cifrada no es texto PEM', !cifrado.toString('utf8').includes('-----BEGIN'));
verificar('no es texto legible en general', !/^[\x20-\x7e]+$/.test(cifrado.toString('latin1')));
verificar(
  `tiene el overhead iv(12)+tag(16)=${OVERHEAD_CIFRADO} mas ciphertext`,
  cifrado.length > OVERHEAD_CIFRADO,
  `${cifrado.length} - ${OVERHEAD_CIFRADO} = ${cifrado.length - OVERHEAD_CIFRADO} B de PEM`,
);

// 2. Descifrado -> PEM RSA valido. `createPrivateKey` tira si no lo es: es la
//    comprobacion de verdad, no un regex.
let privadaPem = null;
try {
  privadaPem = descifrar(cifrado, masterKey.valorB64);
  const clave = createPrivateKey(privadaPem);
  verificar('descifra a un PEM RSA valido', clave.asymmetricKeyType === 'rsa', clave.asymmetricKeyType);
  verificar('el PEM es PKCS#8', privadaPem.includes('BEGIN PRIVATE KEY'));
} catch (error) {
  verificar(`descifra a un PEM RSA valido (${error.message})`, false);
}

// El IV pegado al ciphertext tiene que ser el que descifra: si el IV se
// compartiera entre registros, el tag no validaria.
const otro = cifrar('texto-de-prueba', masterKey.valorB64);
verificar('cifrar() produce IV aleatorio por registro', !otro.subarray(0, 12).equals(cifrado.subarray(0, 12)));
verificar('cifrar/descifrar round-trip', descifrar(otro, masterKey.valorB64) === 'texto-de-prueba');
try {
  descifrar(otro, Buffer.alloc(32).toString('base64'));
  verificar('descifrar con otra clave falla (tag GCM)', false);
} catch {
  verificar('descifrar con otra clave falla (tag GCM)', true);
}

// 3 y 4. Firmar y validar contra el JWKS.
const { keys } = await firma.jwks();
verificar('el JWKS publica al menos la clave activa', keys.length >= 1, `${keys.length} clave(s)`);

// El payload es exactamente la tabla de `specs/01` §2: aca se verifica la firma
// y la forma, no la semántica de los claims (eso lo verifica la Fase 03).
const token = await firma.firmar(
  {
    iss: EMISOR,
    sub: '00000000-0000-4000-8000-000000000000',
    aud: 'prueba-verificacion',
    tenant: 'prueba',
    nombre: 'Prueba Verificacion',
    sid: '11111111-1111-4111-8111-111111111111',
    amr: ['pwd'],
    jti: randomUUID(),
  },
  5,
);

const header = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
verificar('el header declara alg=RS256', header.alg === 'RS256', header.alg);
verificar('el header lleva el kid de la fila', header.kid === kid, header.kid);

const jwk = keys.find((k) => k.kid === kid);
const publica = await jose.importJWK(jwk, 'RS256');
try {
  const { payload } = await jose.jwtVerify(token, publica, {
    algorithms: ['RS256'],
    issuer: EMISOR,
    audience: 'prueba-verificacion',
  });
  verificar('jwtVerify acepta el token contra la clave del JWKS', true, `sub=${payload.sub}`);
  verificar('el payload trae el sid', payload.sid === '11111111-1111-4111-8111-111111111111');
  verificar('el payload trae el amr', Array.isArray(payload.amr) && payload.amr.includes('pwd'));
  verificar('el payload trae el tenant', payload.tenant === 'prueba');
  verificar('el payload trae el nombre', payload.nombre === 'Prueba Verificacion');
  // El `kid` se elige leyendo el HEADER. Antes se leia del payload y por eso
  // `FirmaService.verificar` rechazaba todo (Fase 03).
  const verificado = await firma.verificar(token, keys, {
    issuer: EMISOR,
    audience: 'prueba-verificacion',
    vidaMinutos: 5,
  });
  verificar('FirmaService.verificar acepta el token propio', verificado.sub !== undefined);
} catch (error) {
  verificar(`jwtVerify acepta el token (${error.message})`, false);
}

// 5. alg=none y HS256 tienen que morir.
const sinFirma = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
const cuerpo = token.split('.')[1];
try {
  await jose.jwtVerify(`${sinFirma}.${cuerpo}.`, publica, { algorithms: ['RS256'] });
  verificar('alg=none rechazado', false);
} catch {
  verificar('alg=none rechazado', true);
}
try {
  const hmac = await jose.SignJWT({ sub: 'x' })
    .setProtectedHeader({ alg: 'HS256' })
    .sign(new TextEncoder().encode('secreto-cualquiera'));
  await jose.jwtVerify(hmac, publica, { algorithms: ['RS256'] });
  verificar('HS256 rechazado', false);
} catch {
  verificar('HS256 rechazado', true);
}

// 6. Ventana de 24 h del JWKS.
const ahora = Date.now();
const retiradas = await prismaInstancia.tok_clave_firma.findMany({
  where: { NOT: { kid } },
  select: { kid: true, retirada_en: true, activa: true },
});
const viejasFuera = retiradas.filter(
  (r) => r.retirada_en && ahora - r.retirada_en.getTime() > 24 * 60 * 60 * 1000,
);
const viejasPublicadas = viejasFuera.filter((r) => keys.some((k) => k.kid === r.kid));
verificar(
  'las retiradas de mas de 24 h NO estan en el JWKS',
  viejasPublicadas.length === 0,
  `${viejasFuera.length} retirada(s) vieja(s), ${viejasPublicadas.length} filtrada(s)`,
);

await prismaInstancia.$disconnect();

console.log('\n  ' + '-'.repeat(64) + '\n');
console.log(`  ${fallos === 0 ? 'TODO OK' : `${fallos} COMPROBACION(ES) FALLIDA(S)`}\n`);
console.log('  JWT firmado (publico, expira en 5 min):\n');
console.log(`  ${token}\n`);

process.exit(fallos === 0 ? 0 : 1);
}
