#!/usr/bin/env node
/**
 * Verificacion por HTTP de la Fase 03 (nucleo OIDC). Es el equivalente a los
 * criterios de aceptacion de `specs/todo/begin/fase-03-nucleo-oidc.md`, hecho
 * con `fetch` en vez de a mano: los mismos endpoints, los mismos errores, pero
 * corridos todos y con veredicto.
 *
 * Que verifica, en el orden de los criterios:
 *   1. discovery: los 6 endpoints, `code` unico, `S256` unico, issuer exacto;
 *   2. JWKS: la clave activa, su `kid`, y que no haya material privado;
 *   3. authorize: `redirect_uri` variantes (carácter, subdominio, esquema, host
 *      en mayusculas, prefijo) rechazadas **sin redireccion**; sin PKCE no hay
 *      code; `plain` tampoco; sin `state` tampoco;
 *   4. authorize → token → userinfo de punta a punta, con los claims correctos;
 *   5. code reusado → `invalid_grant` + `replay` en `aud_login`;
 *   6. refresh: rotacion, mismo `sid`, y **reuso** → familia revocada y sesion
 *      cerrada por replay (incluido el refresh recien emitido);
 *   7. logout mata la sesion: el access sigue criptograficamente valido pero
 *      `/userinfo` lo rechaza por `sid` muerto, y el portal sigue andando;
 *   8. el validador de referencia (el que RHPro copiara en la Fase 06) rechaza
 *      `aud` distinto, `tenant` distinto, `iss` distinto, `alg=none`, HS256,
 *      `kid` inventado, access vencido y `jti` repetido;
 *   9. `/oidc/revoke` devuelve 200 exista o no el token;
 *  10. en la base: `code_hash`/`token_hash` son sha256 hex, nunca el valor, y
 *      `aud_login` no tiene ni un code ni un refresh en claro.
 *
 * Requiere el backend arriba. Con el rate limit default (10 por minuto) este
 * script se corta solo en el medio: hay mas de diez llamadas a `/oidc/token` en
 * un minuto, asi que para la corrida hay que subir `RATE_LIMIT_POR_MINUTO` (ver
 * `.env`).
 *
 * Uso:
 *   npm run verificar:oidc
 *   npm run verificar:oidc -- --url http://localhost:3001 --app rhpro
 */
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { cargar, prepararEntorno } from './lib/entorno.mjs';

const { PrismaService } = cargar('prisma/prisma.service.js');
const { FirmaService } = cargar('claves/firma.service.js');
const { MasterKeyService } = cargar('claves/master-key.service.js');
const { SesionService } = cargar('oidc/sesion.service.js');
const { JwksCacheService, TTL_JWKS_RP_MS } = cargar('oidc/jwks-cache.js');
const { JtiCacheService } = cargar('oidc/jti-cache.js');
const { ValidadorService } = cargar('oidc/validador.service.js');
const { challengeS256, sha256Hex } = cargar('oidc/codigos.js');
const { COOKIE_SESION_PORTAL } = cargar('oidc/vidas.js');

const jose = createRequire(import.meta.url)('jose');

const args = argumentos();
const { entorno, configService } = prepararEntorno();
const BASE = (args.url ?? entorno.TQ_ISSUER).replace(/\/+$/, '');
const ISSUER = String(entorno.TQ_ISSUER).replace(/\/+$/, '');
const APP = args.app ?? 'rhpro';
const CLIENTE = args.cliente ?? 'marcelino';
const USUARIO = args.usuario ?? 'admin';

let fallos = 0;
let seccionN = 0;

/** Secretos que este script emitio: al final se busca que ninguno este en la base. */
const secretosEmitidos = [];

// La URL se pasa explicita: el script no depende de que ningun `.env` se cargue
// por su cuenta (ver PrismaService).
const prisma = new PrismaService(entorno.DATABASE_URL);
const masterKey = new MasterKeyService(configService);
const firma = new FirmaService(prisma, masterKey);
const sesionesSvc = new SesionService(prisma);

// --- flujo ---------------------------------------------------------------------

function seccion(titulo) {
  seccionN += 1;
  console.log(`\n  [${seccionN}] ${titulo}`);
  console.log('  ' + '-'.repeat(68));
}

function verificar(descripcion, condicion, extra = '') {
  if (condicion) {
    console.log(`    [ok]    ${descripcion}${extra ? ` (${extra})` : ''}`);
  } else {
    fallos += 1;
    console.log(`    [FALLA] ${descripcion}${extra ? ` (${extra})` : ''}`);
  }
  return Boolean(condicion);
}

function nota(texto) {
  console.log(`    [nota]  ${texto}`);
}

function argumentos() {
  const salida = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const nombre = argv[i].slice(2);
    const siguiente = argv[i + 1];
    if (siguiente === undefined || siguiente.startsWith('--')) {
      console.error(`\n  El flag --${nombre} necesita un valor.\n`);
      process.exit(1);
    }
    salida[nombre] = siguiente;
    i += 1;
  }
  return salida;
}

/**
 * `fetch` sin seguir redirecciones. `redirect: 'manual'` es lo que permite **ver**
 * el 302 del authorize: si se dejara seguir, el script no podria assertar ni la
 * URL de destino ni la ausencia de redireccion en los casos de error.
 */
async function pedir(ruta, opciones = {}) {
  const respuesta = await fetch(`${BASE}${ruta}`, { redirect: 'manual', ...opciones });
  const texto = await respuesta.text();
  let json = null;
  try {
    json = JSON.parse(texto);
  } catch {
    // No es JSON (un 302 sin cuerpo, texto plano, una pagina de error). Se
    // devuelve igual: varios criterios assertan sobre la ausencia de cuerpo.
  }
  return { status: respuesta.status, headers: respuesta.headers, texto, json };
}

const form = (objeto) => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(objeto).toString(),
});

const portador = (token) => ({ headers: { authorization: `Bearer ${token}` } });

const decodificar = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
const cabeceraDe = (token) => JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
const codigoDe = (token) => token.split('.')[1];

async function ejecutar() {
console.log('\n  Verificacion del nucleo OIDC (Fase 03)\n');
console.log(`  issuer=${BASE}   app=${APP}   cliente=${CLIENTE}   usuario=${USUARIO}\n`);

if ((entorno.RATE_LIMIT_POR_MINUTO ?? 10) < 40) {
  nota(
    `RATE_LIMIT_POR_MINUTO=${entorno.RATE_LIMIT_POR_MINUTO}: este script hace mas de ` +
      'diez llamadas a /oidc/token en un minuto y se va a cortar con 429.',
  );
  nota('Subilo en el .env y reiniciá el backend para una corrida completa.');
}

// ---------------------------------------------------------------------------
seccion('Discovery');

const discovery = await pedir('/.well-known/openid-configuration');
if (!verificar('el server responde el discovery', discovery.status === 200, `HTTP ${discovery.status}`)) {
  throw new Error('El backend no responde. Sin discovery no hay nada que verificar.');
}

const d = discovery.json;
verificar('el issuer es exactamente TQ_ISSUER', d.issuer === ISSUER, d.issuer);

for (const [nombre, ruta] of Object.entries({
  authorization_endpoint: '/oidc/authorize',
  token_endpoint: '/oidc/token',
  userinfo_endpoint: '/userinfo',
  jwks_uri: '/.well-known/jwks.json',
  revocation_endpoint: '/oidc/revoke',
  end_session_endpoint: '/oidc/logout',
})) {
  verificar(`anuncia ${nombre}`, d[nombre] === `${ISSUER}${ruta}`, d[nombre]);
}

verificar(
  'response_types_supported = ["code"] y nada mas',
  Array.isArray(d.response_types_supported) &&
    d.response_types_supported.length === 1 &&
    d.response_types_supported[0] === 'code',
  JSON.stringify(d.response_types_supported),
);
verificar(
  'code_challenge_methods_supported = ["S256"] y nada mas',
  Array.isArray(d.code_challenge_methods_supported) &&
    d.code_challenge_methods_supported.length === 1 &&
    d.code_challenge_methods_supported[0] === 'S256',
  JSON.stringify(d.code_challenge_methods_supported),
);
verificar(
  'grant_types = authorization_code + refresh_token',
  Array.isArray(d.grant_types_supported) &&
    d.grant_types_supported.includes('authorization_code') &&
    d.grant_types_supported.includes('refresh_token'),
  JSON.stringify(d.grant_types_supported),
);
verificar(
  'scopes = openid, profile, email',
  Array.isArray(d.scopes_supported) && d.scopes_supported.join(',') === 'openid,profile,email',
  JSON.stringify(d.scopes_supported),
);
verificar(
  'NO anuncia implicit ni password (no existen: specs/01 §1)',
  !/implicit|password/.test(JSON.stringify(d)),
);

// ---------------------------------------------------------------------------
seccion('JWKS');

const jwks = await pedir('/.well-known/jwks.json');
verificar('el JWKS responde 200', jwks.status === 200, `HTTP ${jwks.status}`);

const claves = jwks.json?.keys ?? [];
verificar('publica al menos una clave', claves.length >= 1, `${claves.length} clave(s)`);

const CAMPOS_PRIVADOS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'k', 'oth'];
const conPrivado = claves.filter((k) => CAMPOS_PRIVADOS.some((campo) => campo in k));
verificar('ninguna clave trae material privado', conPrivado.length === 0, `campos: ${Object.keys(claves[0] ?? {}).join(',')}`);

const filaActiva = await prisma.tok_clave_firma.findFirst({ where: { activa: true } });
const publicada = filaActiva ? claves.find((k) => k.kid === filaActiva.kid) : null;
verificar('la clave activa esta publicada', Boolean(publicada), filaActiva?.kid ?? '(sin clave activa)');
verificar('el kid publicado es el de tok_clave_firma', publicada?.kid === filaActiva?.kid, publicada?.kid);
verificar('el JWK declara kty=RSA, alg=RS256 y use=sig',
  publicada?.kty === 'RSA' && publicada?.alg === 'RS256' && publicada?.use === 'sig');

// ---------------------------------------------------------------------------
seccion('Sesion central y datos de la verificacion');

const usuario = await prisma.idn_usuario.findUnique({ where: { usuario: USUARIO } });
if (!usuario) {
  throw new Error(`El usuario "${USUARIO}" no existe. Correr:  npm run bootstrap:admin`);
}

const app = await prisma.cat_aplicacion.findUnique({ where: { codigo: APP } });
if (!app) {
  throw new Error(`La app "${APP}" no esta en cat_aplicacion. Aplicar deploy/sql/90-semilla-catalogo.sql`);
}
const redirectUri = JSON.parse(app.redirect_uris_json)[0];
verificar('la app tiene un redirect_uri registrado', typeof redirectUri === 'string', redirectUri);

// La habilitacion por app es una fila de `idn_usuario_cliente_aplicacion`, no un
// usuario ni una credencial: si falta, el authorize responde `access_denied` y
// no habria nada que verificar.
const habilitacion = await prisma.idn_usuario_cliente_aplicacion.findUnique({
  where: {
    idusuario_idcliente_idaplicacion: {
      idusuario: usuario.idusuario,
      idcliente: CLIENTE,
      idaplicacion: APP,
    },
  },
});
if (!habilitacion) {
  await prisma.idn_usuario_cliente_aplicacion.create({
    data: { idusuario: usuario.idusuario, idcliente: CLIENTE, idaplicacion: APP },
  });
  nota(`se creo la habilitacion (${USUARIO}, ${CLIENTE}, ${APP})`);
}

// Sesion central, exactamente como la va a crear `POST /auth/login` (Fase 04).
const sesionPortal = await sesionesSvc.sesionDePortal(usuario.idusuario, CLIENTE, {
  ip: '127.0.0.1',
  userAgent: 'verificar-oidc',
});
verificar('se creo la sesion central del portal', Boolean(sesionPortal.sid), sesionPortal.sid.slice(0, 8));
verificar('la sesion del portal tiene idaplicacion NULL', sesionPortal.idaplicacion === null);

const cookie = { headers: { cookie: `${COOKIE_SESION_PORTAL}=${encodeURIComponent(sesionPortal.sid)}` } };

// App **inactiva** de prueba. Una app inactiva tiene que ser indistinguible de
// una inexistente (mismo `unauthorized_client`): si se distinguieran, el
// endpoint seria un oraculo del catalogo de apps. Se crea y se borra en la misma
// corrida, y nunca toca una app real.
const APP_INACTIVA = 'verificacion-inactiva';
await prisma.cat_aplicacion.upsert({
  where: { codigo: APP_INACTIVA },
  update: { estado: 'inactivo' },
  create: {
    codigo: APP_INACTIVA,
    nombre: 'Verificacion (inactiva)',
    tipo_cliente: 'public',
    redirect_uris_json: JSON.stringify([redirectUri]),
    origenes_json: JSON.stringify([]),
    estado: 'inactivo',
  },
});

// Un par verifier/challenge para toda la corrida. El `verifier` es el unico que
// puede canjear los codes que se emiten aca: los que se emiten para probar un
// verifier incorrecto se canjean con otro a proposito y quedan sin usar.
const verifier = randomBytes(32).toString('base64url');
const challenge = challengeS256(verifier);
const STATE = 'st-' + randomBytes(6).toString('hex');

async function pedirAuthorize(extra = {}, opciones = cookie) {
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: APP,
    redirect_uri: redirectUri,
    state: STATE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: 'openid profile email',
    ...extra,
  });
  // `state: undefined` en el override hay que sacarlo: `URLSearchParams` lo
  // volveria el string "undefined".
  for (const [clave, valor] of [...query]) {
    if (valor === 'undefined') query.delete(clave);
  }
  return pedir(`/oidc/authorize?${query}`, opciones);
}

// ---------------------------------------------------------------------------
seccion('Authorize: redirect_uri exacto, PKCE y state');

// Las variantes de la trampa 1. Ninguna puede redirigir.
for (const [nombre, uri] of [
  ['un caracter mas', `${redirectUri}x`],
  ['otro subdominio', redirectUri.replace('//localhost', '//evil.localhost')],
  ['otro esquema', redirectUri.replace('http://', 'https://')],
  ['host en mayusculas', redirectUri.replace('localhost', 'LocalHost')],
  ['un path distinto', `${redirectUri}/extra`],
  ['otro origen entero', 'http://localhost:9999/auth/callback'],
]) {
  const r = await pedirAuthorize({ redirect_uri: uri });
  verificar(
    `redirect_uri con ${nombre} → 400 SIN redireccion`,
    r.status === 400 && !r.headers.get('location'),
    `HTTP ${r.status} location=${r.headers.get('location') ?? '(ninguna)'}`,
  );
}

// Antes de validar el `redirect_uri` no hay a donde redirigir: estos cuatro se
// responden en el request. Ademas, `redirect_uri` ausente y `client_id` ausente
// son `invalid_request` por la misma razon.
for (const [nombre, extra] of [
  ['sin redirect_uri', { redirect_uri: undefined }],
  ['sin client_id', { client_id: undefined }],
  ['con response_type=token', { response_type: 'token' }],
  ['sin response_type', { response_type: undefined }],
  ['con client_id desconocido', { client_id: 'no-existe' }],
  ['con client_id de una app inactiva', { client_id: 'verificacion-inactiva' }],
]) {
  const r = await pedirAuthorize(extra);
  verificar(`${nombre} → 400 SIN redireccion`, r.status === 400 && !r.headers.get('location'),
    `HTTP ${r.status} ${r.json?.error ?? ''}`);
}
// Despues de validar el `redirect_uri` los errores SI van por redireccion, con
// `error` y `state`, que es lo que pide OIDC. Lo importante es que no sale un
// code: el code es lo que se roba.
for (const [nombre, extra, esperado] of [
  ['sin code_challenge', { code_challenge: undefined, code_challenge_method: undefined }, 'invalid_request'],
  ['con code_challenge_method=plain', { code_challenge_method: 'plain' }, 'invalid_request'],
  ['con code_challenge corto', { code_challenge: 'corto' }, 'invalid_request'],
  ['sin state', { state: undefined }, 'invalid_request'],
  ['con scope no soportado', { scope: 'openid superpoderes' }, 'invalid_scope'],
]) {
  const r = await pedirAuthorize(extra);
  const destino = r.headers.get('location');
  const conError = destino ? new URL(destino) : null;
  verificar(
    `${nombre} → 302 al redirect_uri con error=${esperado} y SIN code`,
    r.status === 302 &&
      Boolean(conError) &&
      conError.origin + conError.pathname === new URL(redirectUri).origin + new URL(redirectUri).pathname &&
      conError.searchParams.get('error') === esperado &&
      conError.searchParams.get('code') === null,
    `HTTP ${r.status} ${destino ?? '(sin redireccion)'}`,
  );
  if ('state' in extra) {
    // Sin `state` no hay nada que reflejar: el parametro no puede volver.
    verificar(`${nombre} → sin state no se inventa uno`, conError?.searchParams.get('state') === null);
  } else {
    verificar(`${nombre} → el state vuelve en el error`, conError?.searchParams.get('state') === STATE);
  }
}

// Sin la habilitacion por app, el authorize responde `access_denied` aunque la
// sesion central este viva. Se prueba con otro cliente del mismo usuario.
const clienteSinHabilitar = await prisma.idn_usuario_cliente.findFirst({
  where: { idusuario: usuario.idusuario, idcliente: { not: CLIENTE } },
  select: { idcliente: true },
});
if (clienteSinHabilitar) {
  const idCliente = clienteSinHabilitar.idcliente;
  const portales = await sesionesSvc.sesionDePortal(usuario.idusuario, idCliente, {
    ip: '127.0.0.1',
    userAgent: 'verificar-oidc',
  });

  // Se saca la habilitacion, se prueba, y **se vuelve a poner**: la fila es del
  // usuario, no de la corrida, y dejarla borrada seria dejar al admin sin
  // entrar a una app por haber corrido el verificador.
  await prisma.idn_usuario_cliente_aplicacion.deleteMany({
    where: { idusuario: usuario.idusuario, idcliente: idCliente, idaplicacion: APP },
  });
  try {
    const sinHabilitacion = await pedirAuthorize(
      {},
      { headers: { cookie: `${COOKIE_SESION_PORTAL}=${encodeURIComponent(portales.sid)}` } },
    );
    const destino = sinHabilitacion.headers.get('location');
    verificar(
      'usuario sin habilitacion para la app → access_denied (no hay code)',
      sinHabilitacion.status === 302 &&
        new URL(destino).searchParams.get('error') === 'access_denied' &&
        new URL(destino).searchParams.get('code') === null,
      `HTTP ${sinHabilitacion.status} ${destino ?? '(sin redireccion)'}`,
    );
  } finally {
    await prisma.idn_usuario_cliente_aplicacion.upsert({
      where: {
        idusuario_idcliente_idaplicacion: { idusuario: usuario.idusuario, idcliente: idCliente, idaplicacion: APP },
      },
      update: {},
      create: { idusuario: usuario.idusuario, idcliente: idCliente, idaplicacion: APP },
    });
    await sesionesSvc.cerrar(portales.sid, 'logout');
  }
}

const sinCookie = await pedirAuthorize({}, { headers: {} });
verificar(
  'sin sesion central → 302 al login del portal con returnTo',
  sinCookie.status === 302 && (sinCookie.headers.get('location') ?? '').includes('/login?returnTo='),
  (sinCookie.headers.get('location') ?? '(ninguna)').slice(0, 70),
);

// --- El authorize bueno -------------------------------------------------------
const authorize = await pedirAuthorize();
const location = authorize.headers.get('location') ?? '';
verificar('el authorize responde 302', authorize.status === 302, `HTTP ${authorize.status}`);
verificar('el Location es el redirect_uri registrado', location.startsWith(redirectUri), location.slice(0, 80));
verificar('el Location trae code y state', location.includes('code=') && location.includes('state='));

const destino = new URL(location);
const code = destino.searchParams.get('code');
verificar('el state vuelve literal (se refleja, no se valida)', destino.searchParams.get('state') === STATE,
  destino.searchParams.get('state'));
verificar('el code no es el state', code !== STATE && Boolean(code), code ? `${code.slice(0, 8)}…` : '(vacio)');
secretosEmitidos.push(code);

const filaCode = await prisma.tok_autorization_code.findUnique({ where: { code_hash: sha256Hex(code) } });
verificar('el code se persiste hasheado (se busca por sha256)', Boolean(filaCode));
verificar('el code en claro NO esta en la base', !JSON.stringify(filaCode ?? {}).includes(code));
verificar('el state se persiste hasheado', filaCode?.state_hash === sha256Hex(STATE));
verificar('el code queda atado al redirect_uri del authorize', filaCode?.redirect_uri === redirectUri);
verificar('el code expira a 60 s', filaCode ? filaCode.expira_en.getTime() - Date.now() <= 61_000 : false,
  filaCode ? `${Math.round((filaCode.expira_en.getTime() - Date.now()) / 1000)} s` : '');
verificar('el code nace sin usar', filaCode?.usado_en === null);

// ---------------------------------------------------------------------------
seccion('Canje del code: lo que NO puede pasar');

async function codeNuevo() {
  const r = await pedirAuthorize();
  const c = new URL(r.headers.get('location')).searchParams.get('code');
  secretosEmitidos.push(c);
  return c;
}

const sinVerifier = await pedir('/oidc/token', form({
  grant_type: 'authorization_code',
  code,
  redirect_uri: redirectUri,
  client_id: APP,
}));
verificar('sin code_verifier → invalid_grant', sinVerifier.json?.error === 'invalid_grant', sinVerifier.json?.error);

const code2 = await codeNuevo();
const verifierDistinto = await pedir('/oidc/token', form({
  grant_type: 'authorization_code',
  code: code2,
  redirect_uri: redirectUri,
  client_id: APP,
  code_verifier: randomBytes(32).toString('base64url'),
}));
verificar('code_verifier que no corresponde al challenge → invalid_grant',
  verifierDistinto.json?.error === 'invalid_grant', verifierDistinto.json?.error);
verificar('el code NO se marca usado cuando el verifier falla',
  (await prisma.tok_autorization_code.findUnique({ where: { code_hash: sha256Hex(code2) } }))?.usado_en === null,
  'queda disponible para el canje legitimo');

const code3 = await codeNuevo();
const redirectDistinto = await pedir('/oidc/token', form({
  grant_type: 'authorization_code',
  code: code3,
  redirect_uri: `${redirectUri}x`,
  client_id: APP,
  code_verifier: verifier,
}));
verificar('redirect_uri DISTINTO en /token → invalid_grant (trampa 1)',
  redirectDistinto.json?.error === 'invalid_grant', redirectDistinto.json?.error);
verificar('el code NO se marca usado con el redirect_uri distinto',
  (await prisma.tok_autorization_code.findUnique({ where: { code_hash: sha256Hex(code3) } }))?.usado_en === null);

const code4 = await codeNuevo();
const clientDistinto = await pedir('/oidc/token', form({
  grant_type: 'authorization_code',
  code: code4,
  redirect_uri: redirectUri,
  client_id: 'rhpro-otra',
  code_verifier: verifier,
}));
verificar('client_id distinto del del code → invalid_grant', clientDistinto.json?.error === 'invalid_grant',
  clientDistinto.json?.error);

const ropc = await pedir('/oidc/token', form({ grant_type: 'password', username: 'a', password: 'b' }));
verificar('grant_type=password (ROPC) no existe', ropc.json?.error === 'unsupported_grant_type', ropc.json?.error);

const grantDesconocido = await pedir('/oidc/token', form({ grant_type: 'implicit' }));
verificar('grant_type=implicit no existe', grantDesconocido.json?.error === 'unsupported_grant_type',
  grantDesconocido.json?.error);

const sinGrant = await pedir('/oidc/token', form({}));
verificar('sin grant_type → invalid_request', sinGrant.json?.error === 'invalid_request', sinGrant.json?.error);

// ---------------------------------------------------------------------------
seccion('Canje del code: el flujo completo');

const code5 = await codeNuevo();
const canje = await pedir('/oidc/token', form({
  grant_type: 'authorization_code',
  code: code5,
  redirect_uri: redirectUri,
  client_id: APP,
  code_verifier: verifier,
}));
if (!verificar('el canje responde 200', canje.status === 200, `HTTP ${canje.status} ${canje.json?.error ?? ''}`)) {
  throw new Error(`El canje legitimo fallo: ${JSON.stringify(canje.json)}`);
}

const tokens = canje.json;
const access = tokens.access_token;
const refresh = tokens.refresh_token;
secretosEmitidos.push(refresh);

verificar('devuelve access_token, refresh_token, token_type y expires_in',
  Boolean(access) && Boolean(refresh) && tokens.token_type === 'Bearer' && typeof tokens.expires_in === 'number',
  `expires_in=${tokens.expires_in}`);
verificar('el refresh es opaco (no es un JWT)', refresh.split('.').length !== 3);
verificar('el token response tiene SOLO las claves del RFC 6749 §5.1 (no filtra el sid ni la ip)',
  Object.keys(tokens).sort().join(',') === 'access_token,expires_in,refresh_token,scope,token_type',
  Object.keys(tokens).join(','));

const claims = decodificar(access);
const cabecera = cabeceraDe(access);
verificar('el header declara alg=RS256', cabecera.alg === 'RS256', cabecera.alg);
verificar('el header lleva el kid de la clave activa', cabecera.kid === filaActiva.kid, cabecera.kid);
verificar('iss es TQ_ISSUER', claims.iss === ISSUER, claims.iss);
verificar('sub es el idusuario', claims.sub === usuario.idusuario, claims.sub);
verificar('sub NO es el username ni el iduser de RHPro', claims.sub !== usuario.usuario);
verificar('aud es el codigo de la app', claims.aud === APP, claims.aud);
verificar('tenant es el cliente de la sesion del portal', claims.tenant === CLIENTE, claims.tenant);
verificar('sid trae la sesion de la app (UUID)', /^[0-9a-f-]{36}$/.test(String(claims.sid)), claims.sid);
verificar('amr = ["pwd"]', Array.isArray(claims.amr) && claims.amr.join(',') === 'pwd', JSON.stringify(claims.amr));
verificar('jti es un UUID aleatorio', /^[0-9a-f-]{36}$/.test(String(claims.jti)), claims.jti);
verificar('base trae el nombre de la base activa del cliente', typeof claims.base === 'string' && claims.base.length > 0,
  claims.base);
verificar('nombre viene de idn_usuario', claims.nombre === `${usuario.nombre} ${usuario.apellido}`, claims.nombre);
verificar('exp - iat = ACCESS_TTL_MIN (15)', claims.exp - claims.iat === 900, `${claims.exp - claims.iat} s`);
verificar('nbf = iat', claims.nbf === claims.iat);
verificar('los claims son EXACTAMENTE los de specs/01 §2',
  Object.keys(claims).sort().join(',') === 'amr,aud,base,exp,iat,iss,jti,nbf,nombre,sid,sub,tenant',
  Object.keys(claims).sort().join(','));

const sesionApp = await prisma.tok_sesion.findUnique({ where: { sid: claims.sid } });
verificar('tok_sesion de la app tiene idaplicacion = aud', sesionApp?.idaplicacion === APP, sesionApp?.idaplicacion ?? '(null)');
verificar('el sid del token NO es el de la sesion del portal', sesionApp?.sid !== sesionPortal.sid);
verificar('el tenant sale de la sesion, no del query (mismo cliente que el portal)',
  sesionApp?.idcliente === sesionPortal.idcliente, sesionApp?.idcliente ?? '(null)');
verificar('el usuario quedo auditado con el app del canje',
  Boolean(await prisma.aud_login.findFirst({
    where: { resultado: 'ok', idusuario: usuario.idusuario, idaplicacion: APP },
    orderBy: { id: 'desc' },
  })));

// ---------------------------------------------------------------------------
seccion('Userinfo');

const info = await pedir('/userinfo', portador(access));
verificar('userinfo responde 200', info.status === 200, `HTTP ${info.status}`);
verificar('devuelve el sub del token', info.json?.sub === claims.sub, info.json?.sub);
verificar('devuelve usuario, nombre y apellido',
  info.json?.usuario === usuario.usuario &&
    info.json?.nombre === usuario.nombre &&
    info.json?.apellido === usuario.apellido,
  `${info.json?.usuario} ${info.json?.nombre} ${info.json?.apellido}`);
verificar('devuelve SOLO datos personales (sin tenant, base, sid, amr ni roles)',
  Object.keys(info.json ?? {}).sort().join(',') ===
    ['apellido', 'nombre', 'sub', 'usuario'].concat(info.json?.email ? ['email'] : []).sort().join(','),
  Object.keys(info.json ?? {}).join(','));

const sinToken = await pedir('/userinfo');
verificar('sin Authorization → 401', sinToken.status === 401, `HTTP ${sinToken.status}`);
verificar('el 401 trae WWW-Authenticate: Bearer',
  (sinToken.headers.get('www-authenticate') ?? '').includes('Bearer'),
  sinToken.headers.get('www-authenticate') ?? '(ninguno)');

const cabeceraAlterada = await pedir('/userinfo', portador(access.slice(0, -4) + 'AAAA'));
verificar('access con firma alterada → 401', cabeceraAlterada.status === 401, `HTTP ${cabeceraAlterada.status}`);

const basura = await pedir('/userinfo', portador('esto-no-es-un-jwt'));
verificar('token que no es un JWT → 401', basura.status === 401, `HTTP ${basura.status}`);

const kidDesconocido = await pedir('/userinfo', portador(
  `${Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'kid-que-no-existe' })).toString('base64url')}` +
    `.${codigoDe(access)}.${access.split('.')[2]}`,
));
verificar('access con kid desconocido → 401', kidDesconocido.status === 401, `HTTP ${kidDesconocido.status}`);

const algNone = await pedir('/userinfo', portador(
  `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${codigoDe(access)}.`,
));
verificar('access con alg=none → 401', algNone.status === 401, `HTTP ${algNone.status}`);

// ---------------------------------------------------------------------------
seccion('Code reusado');

const reuso = await pedir('/oidc/token', form({
  grant_type: 'authorization_code',
  code: code5,
  redirect_uri: redirectUri,
  client_id: APP,
  code_verifier: verifier,
}));
verificar('el mismo code por segunda vez → invalid_grant', reuso.json?.error === 'invalid_grant', reuso.json?.error);

const replayCode = await prisma.aud_login.findFirst({
  where: { resultado: 'replay', detalle: { startsWith: 'code_reutilizado' } },
  orderBy: { id: 'desc' },
});
verificar('queda una fila en aud_login con resultado=replay', Boolean(replayCode), replayCode?.detalle ?? '');
verificar('el detalle lleva la huella del code (8 hex), no el code',
  replayCode?.detalle === `code_reutilizado:${sha256Hex(code5).slice(0, 8)}`, replayCode?.detalle ?? '');

// ---------------------------------------------------------------------------
seccion('Refresh: rotacion estricta');

const refresh1 = await pedir('/oidc/token', form({
  grant_type: 'refresh_token',
  refresh_token: refresh,
  client_id: APP,
}));
if (!verificar('el refresh se renueva', refresh1.status === 200, `HTTP ${refresh1.status} ${refresh1.json?.error ?? ''}`)) {
  throw new Error(`La renovacion fallo: ${JSON.stringify(refresh1.json)}`);
}

const access2 = refresh1.json.access_token;
const refresh2 = refresh1.json.refresh_token;
secretosEmitidos.push(refresh2);

verificar('el refresh entregado es distinto del anterior', refresh2 !== refresh);
verificar('el access entregado es distinto del anterior', access2 !== access);

const claims2 = decodificar(access2);
verificar('el access nuevo conserva el MISMO sid (la sesion sobrevive al refresh)', claims2.sid === claims.sid, claims2.sid);
verificar('el access nuevo renueva iat/exp', claims2.iat > claims.iat && claims2.exp > claims.exp);
verificar('el access nuevo tiene otro jti', claims2.jti !== claims.jti);
verificar('los claims de identidad no cambian',
  claims2.sub === claims.sub && claims2.aud === claims.aud && claims2.tenant === claims.tenant);

const filaRefreshViejo = await prisma.tok_refresh_token.findUnique({ where: { token_hash: sha256Hex(refresh) } });
verificar('el refresh viejo queda con usado_en', Boolean(filaRefreshViejo?.usado_en));
verificar('el refresh viejo apunta al nuevo (reemplazado_por)', Boolean(filaRefreshViejo?.reemplazado_por),
  String(filaRefreshViejo?.reemplazado_por ?? '(null)'));
verificar('el refresh se persiste hasheado (sha256 hex)',
  filaRefreshViejo?.token_hash === sha256Hex(refresh), filaRefreshViejo?.token_hash ?? '');
verificar('el refresh en claro NO esta en la base', !JSON.stringify(filaRefreshViejo ?? {}).includes(refresh));

const refreshDesconocido = await pedir('/oidc/token', form({
  grant_type: 'refresh_token',
  refresh_token: 'inventado',
  client_id: APP,
}));
verificar('refresh inexistente → invalid_grant', refreshDesconocido.json?.error === 'invalid_grant',
  refreshDesconocido.json?.error);

// ---------------------------------------------------------------------------
seccion('Refresh reusado: se cae la familia');

const reusoRefresh = await pedir('/oidc/token', form({
  grant_type: 'refresh_token',
  refresh_token: refresh,
  client_id: APP,
}));
verificar('reusar un refresh YA ROTADO → invalid_grant', reusoRefresh.json?.error === 'invalid_grant',
  reusoRefresh.json?.error);

const sesionTrasReplay = await prisma.tok_sesion.findUnique({ where: { sid: claims.sid } });
verificar('tok_sesion.cerrada_en quedo seteado', sesionTrasReplay?.cerrada_en !== null,
  String(sesionTrasReplay?.cerrada_en ?? 'null'));
verificar('tok_sesion.motivo_cierre = replay', sesionTrasReplay?.motivo_cierre === 'replay',
  sesionTrasReplay?.motivo_cierre ?? '(null)');

const refreshVivos = await prisma.tok_refresh_token.count({ where: { sid: claims.sid, revocado_en: null } });
verificar('no queda ningun refresh vivo de la familia', refreshVivos === 0, `${refreshVivos} vivo(s)`);

const replayRefresh = await prisma.aud_login.findFirst({
  where: { resultado: 'replay', detalle: { startsWith: 'refresh_reutilizado' } },
  orderBy: { id: 'desc' },
});
verificar('queda auditado con resultado=replay', Boolean(replayRefresh), replayRefresh?.detalle ?? '');

// El refresh NUEVO tambien tiene que fallar: lo que se cerro es la sesion.
const trasReplay = await pedir('/oidc/token', form({
  grant_type: 'refresh_token',
  refresh_token: refresh2,
  client_id: APP,
}));
verificar('el refresh NUEVO tambien falla (la sesion esta cerrada)', trasReplay.json?.error === 'invalid_grant',
  trasReplay.json?.error);

verificar('el access sigue siendo criptograficamente valido (15 min)',
  decodificar(access2).exp > Math.floor(Date.now() / 1000), 'exp en el futuro');
verificar('pero /userinfo lo rechaza por el sid muerto',
  (await pedir('/userinfo', portador(access2))).status === 401, 'HTTP 401');

// ---------------------------------------------------------------------------
seccion('Revocar una app (POST /oidc/revoke)');

const codeRevocar = await codeNuevo();
const canjeRevocar = await pedir('/oidc/token', form({
  grant_type: 'authorization_code',
  code: codeRevocar,
  redirect_uri: redirectUri,
  client_id: APP,
  code_verifier: verifier,
}));
const accessApp = canjeRevocar.json.access_token;
const refreshApp = canjeRevocar.json.refresh_token;
secretosEmitidos.push(refreshApp);
const sidApp = decodificar(accessApp).sid;

const revokeDesconocido = await pedir('/oidc/revoke', form({ token: 'este-token-no-existe' }));
verificar('revoke de un token inexistente tambien devuelve 200 (RFC 7009)',
  revokeDesconocido.status === 200, `HTTP ${revokeDesconocido.status}`);

const revoke = await pedir('/oidc/revoke', form({ token: accessApp }));
verificar('revoke de un access devuelve 200', revoke.status === 200, `HTTP ${revoke.status}`);

const sesionRevocada = await prisma.tok_sesion.findUnique({ where: { sid: sidApp } });
verificar('la sesion de esa app quedo cerrada con motivo=revocada',
  sesionRevocada?.cerrada_en !== null && sesionRevocada?.motivo_cierre === 'revocada',
  sesionRevocada?.motivo_cierre ?? '(null)');

verificar('el refresh de esa app murio con el revoke',
  (await pedir('/oidc/token', form({ grant_type: 'refresh_token', refresh_token: refreshApp, client_id: APP })))
    .json?.error === 'invalid_grant');
verificar('el access de esa app ya no sirve en userinfo',
  (await pedir('/userinfo', portador(accessApp))).status === 401);

const revokeRefresh = await pedir('/oidc/revoke', form({ token: refreshApp }));
verificar('revoke de un refresh devuelve 200 (idempotente)', revokeRefresh.status === 200, `HTTP ${revokeRefresh.status}`);

const revokeSinToken = await pedir('/oidc/revoke', form({}));
verificar('revoke sin token → invalid_request (pedido mal formado)',
  revokeSinToken.status === 400 && revokeSinToken.json?.error === 'invalid_request',
  `HTTP ${revokeSinToken.status}`);

// La sesion central y el authorize siguen: por eso revoke es "cerrar esta app".
const authorizePostRevoke = await pedirAuthorize();
verificar('el authorize sigue funcionando (el portal no se toco)',
  authorizePostRevoke.status === 302 && (authorizePostRevoke.headers.get('location') ?? '').includes('code='),
  `HTTP ${authorizePostRevoke.status}`);

// ---------------------------------------------------------------------------
seccion('Salir de todo (GET /oidc/logout)');

const logout = await pedir('/oidc/logout', cookie);
verificar('logout responde 200', logout.status === 200, `HTTP ${logout.status}`);
verificar('logout manda a borrar la cookie de sesion',
  (logout.headers.get('set-cookie') ?? '').includes(`${COOKIE_SESION_PORTAL}=;`),
  (logout.headers.get('set-cookie') ?? '(ninguna)').slice(0, 48));

const trasLogout = await prisma.tok_sesion.findUnique({ where: { sid: sesionPortal.sid } });
verificar('la sesion central quedo cerrada', trasLogout?.cerrada_en !== null, String(trasLogout?.cerrada_en ?? 'null'));
verificar('con motivo_cierre=logout', trasLogout?.motivo_cierre === 'logout', trasLogout?.motivo_cierre ?? '(null)');

const sesionesAbiertas = await prisma.tok_sesion.count({
  where: { idusuario: usuario.idusuario, idcliente: CLIENTE, cerrada_en: null },
});
verificar('"salir de todo" no deja ninguna sesion abierta del usuario en el cliente',
  sesionesAbiertas === 0, `${sesionesAbiertas} abierta(s)`);

const trasLogoutAuthorize = await pedirAuthorize();
verificar('con la cookie muerta el authorize vuelve al login del portal',
  trasLogoutAuthorize.status === 302 &&
    (trasLogoutAuthorize.headers.get('location') ?? '').includes('/login?returnTo='));

const logoutSinRedirect = await pedir(`/oidc/logout?client_id=${APP}`, cookie);
verificar('sin post_logout_redirect_uri responde 200 sin redirigir',
  logoutSinRedirect.status === 200 && !logoutSinRedirect.headers.get('location'), `HTTP ${logoutSinRedirect.status}`);

const logoutMal = await pedir(
  `/oidc/logout?client_id=${APP}&post_logout_redirect_uri=${encodeURIComponent(`${redirectUri}x`)}`,
  cookie,
);
verificar('post_logout_redirect_uri NO registrado → 400 sin redireccion',
  logoutMal.status === 400 && !logoutMal.headers.get('location'),
  `HTTP ${logoutMal.status} location=${logoutMal.headers.get('location') ?? '(ninguna)'}`);

const logoutOk = await pedir(
  `/oidc/logout?client_id=${APP}&post_logout_redirect_uri=${encodeURIComponent(redirectUri)}&state=despedida`,
  cookie,
);
verificar('post_logout_redirect_uri registrado → 302 con state',
  logoutOk.status === 302 && (logoutOk.headers.get('location') ?? '').includes('state=despedida'),
  logoutOk.headers.get('location') ?? '(ninguna)');

const logoutPost = await pedir('/oidc/logout', {
  ...cookie,
  ...form({ post_logout_redirect_uri: redirectUri, client_id: APP }),
});
verificar('POST /oidc/logout tambien funciona (RFC 9457)',
  logoutPost.status === 200 || logoutPost.status === 302, `HTTP ${logoutPost.status}`);

// ---------------------------------------------------------------------------
seccion('Validador de referencia (el que copiara RHPro en la Fase 06)');

// JWKS **por HTTP**, cacheado 24 h con refresco forzado: es exactamente lo que
// hara una app, no una lectura a la base.
const clavesPorHttp = await pedir('/.well-known/jwks.json');
const jwksRp = new JwksCacheService(async () => ({ keys: clavesPorHttp.json.keys }), TTL_JWKS_RP_MS);
const jtiRp = new JtiCacheService();
const validador = new ValidadorService(firma, jwksRp, jtiRp);

// Sesion sana para tener un token real contra el que comparar.
const sesionPortal2 = await sesionesSvc.sesionDePortal(usuario.idusuario, CLIENTE, { ip: '127.0.0.1', userAgent: 'verificar-oidc' });
const cookie2 = { headers: { cookie: `${COOKIE_SESION_PORTAL}=${encodeURIComponent(sesionPortal2.sid)}` } };
const authorize2 = await pedirAuthorize({}, cookie2);
const code6 = new URL(authorize2.headers.get('location')).searchParams.get('code');
const canje2 = await pedir('/oidc/token', form({
  grant_type: 'authorization_code',
  code: code6,
  redirect_uri: redirectUri,
  client_id: APP,
  code_verifier: verifier,
}));
if (canje2.status !== 200) {
  throw new Error(`No pude armar un token sano para el validador: ${JSON.stringify(canje2.json)}`);
}
const claimsSanos = decodificar(canje2.json.access_token);
verificar('la sesion del validador es una sesion de app viva', claimsSanos.sid !== claims.sid, claimsSanos.sid);

const opc = { issuer: claimsSanos.iss, audience: APP, tenant: CLIENTE, vidaMinutos: 15 };
const sano = await validador.validar(canje2.json.access_token, opc);
verificar('acepta un token sano (JWKS por HTTP, aud y tenant correctos)', sano.ok, sano.ok ? '' : sano.motivo);

const audDistinto = await validador.validar(canje2.json.access_token, { ...opc, audience: 'rhpro-chile' });
verificar('rechaza aud distinto del de la app', !audDistinto.ok && audDistinto.motivo === 'aud_invalido',
  audDistinto.ok ? '(ACEPTO)' : audDistinto.motivo);

const tenantDistinto = await validador.validar(canje2.json.access_token, { ...opc, tenant: 'otro-cliente' });
verificar('rechaza tenant distinto del esperado', !tenantDistinto.ok && tenantDistinto.motivo === 'tenant_invalido',
  tenantDistinto.ok ? '(ACEPTO)' : tenantDistinto.motivo);

const issDistinto = await validador.validar(canje2.json.access_token, { ...opc, issuer: 'https://otro-idp.example' });
verificar('rechaza iss de otra instalacion', !issDistinto.ok, issDistinto.ok ? '(ACEPTO)' : issDistinto.motivo);

const sinFirma = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${codigoDe(canje2.json.access_token)}.`;
const none = await validador.validar(sinFirma, opc);
verificar('rechaza alg=none', !none.ok, none.ok ? '(ACEPTO)' : none.motivo);

const hmac = await new jose.SignJWT({ sub: claimsSanos.sub })
  .setProtectedHeader({ alg: 'HS256' })
  .sign(new TextEncoder().encode('secreto-cualquiera'));
const hs = await validador.validar(hmac, opc);
verificar('rechaza HS256 firmado con un secreto inventado', !hs.ok, hs.ok ? '(ACEPTO)' : hs.motivo);

const kidFalso = await validador.validar(
  `${Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'kid-que-no-existe' })).toString('base64url')}.${codigoDe(canje2.json.access_token)}.${canje2.json.access_token.split('.')[2]}`,
  opc,
);
verificar('rechaza kid desconocido', !kidFalso.ok && kidFalso.motivo === 'kid_desconocido',
  kidFalso.ok ? '(ACEPTO)' : kidFalso.motivo);

const vencido = await firma.firmar(
  { ...claimsSanos, iss: ISSUER, aud: APP, tenant: CLIENTE, jti: randomUUID() },
  -1,
);
const vencidoRes = await validador.validar(vencido, opc);
verificar('rechaza un access vencido (exp pasado)', !vencidoRes.ok, vencidoRes.ok ? '(ACEPTO)' : vencidoRes.motivo);

const privado = masterKey.descifrar(Buffer.from(filaActiva.clave_privada_cifrada));
const claveImportada = await jose.importPKCS8(privado, 'RS256');
const viejo = await new jose.SignJWT({ ...claimsSanos, jti: randomUUID() })
  .setProtectedHeader({ alg: 'RS256', kid: filaActiva.kid })
  .setIssuer(ISSUER)
  .setAudience(APP)
  .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
  .setExpirationTime(Math.floor(Date.now() / 1000) + 7200)
  .sign(claveImportada);
const viejoRes = await validador.validar(viejo, opc);
verificar('rechaza un token con iat de hace 2 h (maxTokenAge, con exp futuro)',
  !viejoRes.ok, viejoRes.ok ? '(ACEPTO)' : viejoRes.motivo);

const primerUso = await validador.validar(canje2.json.access_token, { ...opc, consumirJti: true });
verificar('el anti-replay acepta el primer uso del jti', primerUso.ok, primerUso.ok ? '' : primerUso.motivo);
const jtiRepetido = await validador.validar(canje2.json.access_token, { ...opc, consumirJti: true });
verificar('el anti-replay RECHAZA el jti repetido', !jtiRepetido.ok && jtiRepetido.motivo === 'jti_repetido',
  jtiRepetido.ok ? '(ACEPTO)' : jtiRepetido.motivo);
verificar('sin `consumirJti` el mismo token se sigue aceptando (endpoint de recurso)',
  (await validador.validar(canje2.json.access_token, opc)).ok, 'como lo hacen las apps');

verificar('el TTL del cache de jti es 2x la vida del access (30 min)',
  JtiCacheService.TTL_MS === 30 * 60 * 1000, `${JtiCacheService.TTL_MS / 60000} min`);
const entradasAntes = jtiRp.entradas;
jtiRp.purgar(Date.now() + 31 * 60 * 1000);
verificar('el cache de jti se purga a los ~30 min', jtiRp.entradas < entradasAntes,
  `${entradasAntes} → ${jtiRp.entradas}`);

let refrescos = 0;
const contador = new JwksCacheService(async () => { refrescos += 1; return { keys: [] }; }, TTL_JWKS_RP_MS);
for (let i = 0; i < 20; i += 1) {
  await contador.clavesParaKid(`kid-inventado-${i}`);
}
verificar('20 kid inventados NO generan 20 refrescos del JWKS (anti-DoS)', refrescos <= 2, `${refrescos} refresco(s)`);

// ---------------------------------------------------------------------------
seccion('CORS, cache y secretos');

const cORS = await pedir('/.well-known/jwks.json', { headers: { origin: 'https://evil.example' } });
verificar('el backend NUNCA responde Access-Control-Allow-Origin: *',
  cORS.headers.get('access-control-allow-origin') !== '*', cORS.headers.get('access-control-allow-origin') ?? '(ninguno)');
verificar('un origen no declarado no recibe permiso de CORS',
  cORS.headers.get('access-control-allow-origin') === null, cORS.headers.get('access-control-allow-origin') ?? '(ninguno)');

const jwksCache = await pedir('/.well-known/jwks.json');
verificar('el JWKS se puede cachear (Cache-Control con max-age)',
  Number(jwksCache.headers.get('cache-control')?.match(/max-age=(\d+)/)?.[1] ?? 0) > 0,
  jwksCache.headers.get('cache-control') ?? '(ninguno)');

const sinCode = await pedir('/oidc/token', form({ grant_type: 'authorization_code' }));
verificar('/oidc/token responde Cache-Control: no-store',
  (sinCode.headers.get('cache-control') ?? '').includes('no-store'),
  sinCode.headers.get('cache-control') ?? '(ninguno)');

const authorizeNoStore = await pedirAuthorize();
verificar('/oidc/authorize responde Cache-Control: no-store',
  (authorizeNoStore.headers.get('cache-control') ?? '').includes('no-store'),
  authorizeNoStore.headers.get('cache-control') ?? '(ninguno)');

// Ningun code ni refresh emitido en esta corrida puede estar en la base.
const volcadoAuditoria = await prisma.aud_login.findMany({ select: { detalle: true } });
const enAuditoria = secretosEmitidos.filter((s) => s && volcadoAuditoria.some((f) => (f.detalle ?? '').includes(s)));
verificar('ningun code ni refresh en claro quedo en aud_login', enAuditoria.length === 0, `${enAuditoria.length} filtrado(s)`);

const codigosEnBase = await prisma.tok_autorization_code.findMany({ select: { code_hash: true, state_hash: true } });
verificar('todos los code_hash son sha256 hex (64)',
  codigosEnBase.every((f) => /^[0-9a-f]{64}$/.test(f.code_hash)), `${codigosEnBase.length} fila(s)`);
verificar('todos los state_hash son sha256 hex (64)',
  codigosEnBase.every((f) => f.state_hash === null || /^[0-9a-f]{64}$/.test(f.state_hash)));

const refreshes = await prisma.tok_refresh_token.findMany({ select: { token_hash: true } });
verificar('todos los token_hash son sha256 hex (64)',
  refreshes.every((f) => /^[0-9a-f]{64}$/.test(f.token_hash)), `${refreshes.length} fila(s)`);

// ---------------------------------------------------------------------------
seccion('Auditoria: que quedo escrito');

await prisma.cat_aplicacion.deleteMany({ where: { codigo: 'verificacion-inactiva' } }).catch(() => {});

const resumen = await prisma.$queryRaw`
  SELECT resultado, detalle, COUNT(*) AS veces
  FROM aud_login
  WHERE ts > DATEADD(minute, -30, SYSUTCDATETIME())
  GROUP BY resultado, detalle
  ORDER BY resultado, detalle`;
console.table(resumen);

await prisma.$disconnect();

console.log('\n  ' + '-'.repeat(68) + '\n');
console.log(
  fallos === 0
    ? '  TODO OK: los criterios de aceptacion de la Fase 03 pasan.\n'
    : `  ${fallos} COMPROBACION(ES) FALLIDA(S)\n`,
);
process.exit(fallos === 0 ? 0 : 1);
}

// La corrida arranca ACA, al final del archivo y no arriba: `form`, `pedir` y
// las demas ayudantes son `const` y estarian en zona muerta si `ejecutar` se
// llamara antes de que el modulo los haya evaluado.
try {
  await ejecutar();
} catch (error) {
  await prisma.$disconnect().catch(() => {});
  const mensaje = error instanceof Error ? error.message : String(error);
  const esConexion =
    error?.constructor?.name === 'PrismaClientInitializationError' ||
    /Can't reach database server|Initialization engine error|P1001|P1002/i.test(mensaje);
  if (esConexion) {
    const catalogo = (entorno.DATABASE_URL || '').match(/database=([^;]+)/i)?.[1] ?? '(sin definir)';
    console.error('\n  No pude conectarme a la base de control.');
    console.error(`  Catalogo apunta a: ${catalogo}\n`);
  } else if (/fetch failed|ECONNREFUSED|ENOTFOUND|socket hang up/i.test(mensaje)) {
    console.error(`\n  No pude hablar con ${BASE}.`);
    console.error('  El backend tiene que estar arriba:  npm run start --workspace backend\n');
  } else {
    console.error(`\n  ${mensaje}\n`);
  }
  process.exit(1);
}
