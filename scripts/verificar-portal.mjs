#!/usr/bin/env node
/**
 * Verificacion por HTTP del portal lanzador (Fase 07) y del panel de identidad
 * (Fase 08). Es el equivalente a los criterios de aceptacion de
 * `specs/todo/begin/fase-07-portal-lanzador.md` y `fase-08-admin-identidad.md`,
 * hecho con `fetch` y con lecturas de la base, en vez de a mano.
 *
 * Por que un script y no tests: la regla del repo (ver `AGENTS.md` y el README del
 * plan) prohibe generar suites. Este archivo no es una suite: no hay `describe`, no
 * hay mocks, no hay Snapshot; es un recorrido por HTTP con veredicto, que es
 * exactamente lo mismo que `scripts/verificar-oidc.mjs` para el nucleo OIDC.
 *
 * Que verifica, en orden:
 *   1. `/me` sin sesion → 401, y con sesion → quien soy, de que cliente y con que
 *      rol; las membresias son solo las del usuario.
 *   2. `/me/clientes` y `/me/apps`: la interseccion de los tres filtros de
 *      `specs/02` §3, con `inicio` y `base` y **sin** credenciales de la base.
 *   3. `POST /me/cliente-activo`: solo a un cliente del que es miembro, y la
 *      re-emision de la sesion del portal (la vieja queda cerrada y las sesiones de
 *      las apps no se tocan).
 *   4. `GET /me/sesiones` y `DELETE /me/sesiones/:sid`: las propias, con la IP
 *      truncada; un `sid` ajeno es 404 y sigue vivo.
 *   5. `POST /auth/logout-all`: apaga todas las sesiones del usuario en el cliente y
 *      **solo** en ese cliente.
 *   6. `no-store` en todas las respuestas de `/me`.
 *   7. (Fase 08) `/admin/*`: filtro de tenant en todos los endpoints, 403 para un
 *      `user`, alta de usuario, reset de clave, habilitacion de apps, cierre
 *      forzado con motivo, y la lectura de auditoria que no cruza tenants.
 *
 * Requiere el backend arriba y `npm run build` hecho (usa el backend compilado
 * para crear sesiones y leer la base, igual que `verificar-oidc.mjs`).
 *
 * Uso:
 *   npm run verificar:portal
 *   npm run verificar:portal -- --url http://localhost:3001 --cliente marcelino
 */
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { cargar, prepararEntorno } from './lib/entorno.mjs';

const { PrismaService } = cargar('prisma/prisma.service.js');
const { SesionService } = cargar('oidc/sesion.service.js');
const { COOKIE_SESION_PORTAL } = cargar('oidc/vidas.js');
const { hashear } = cargar('auth/password.service.js');

const args = argumentos();
const { entorno, configService } = prepararEntorno();

/** El mismo `configService` que construyo `prepararEntorno`, para los servicios. */
const configServiceDelScript = () => configService;
const BASE = (args.url ?? entorno.TQ_ISSUER).replace(/\/+$/, '');
const CLIENTE = args.cliente ?? 'marcelino';
const USUARIO = args.usuario ?? 'admin';
const APP = args.app ?? 'rhpro';

// Cliente "de al lado" para las pruebas de travesia: un cliente **distinto** del de
// la sesion principal. No hace falta que el usuario principal no sea miembro de el
// (en el despliegue actual el admin es miembro de los cuatro), porque la mitad
// fuerte de la prueba —"este `sid` no es mio" y "este cliente no es mio"— se hace con
// el usuario de prueba, que es miembro de UN solo cliente.
const OTRO_CLIENTE = args.otro ?? 'cervi';

let fallos = 0;
let seccionN = 0;

/** Usuario de prueba para el cruce de sesiones. Se borra al final. */
const USUARIO_AJENO = 'verificacion-ajeno';

const prisma = new PrismaService(entorno.DATABASE_URL);
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

/** `fetch` sin seguir redirecciones, igual que en `verificar-oidc.mjs`. */
async function pedir(ruta, opciones = {}) {
  const respuesta = await fetch(`${BASE}${ruta}`, { redirect: 'manual', ...opciones });
  const texto = await respuesta.text();
  let json = null;
  try {
    json = JSON.parse(texto);
  } catch {
    // Un 401 del filtro, un 302 o un 500 con texto plano: se devuelve igual, porque
    // varios criterios assertan sobre el cuerpo de la respuesta.
  }
  return { status: respuesta.status, headers: respuesta.headers, texto, json };
}

const jsonPost = (cuerpo, opciones = {}) => ({
  ...opciones,
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(opciones.headers ?? {}) },
  body: JSON.stringify(cuerpo),
});

/** Header de cookie de la sesion del portal, tal como la escribe el login. */
function cookieDe(sid) {
  return { headers: { cookie: `${COOKIE_SESION_PORTAL}=${encodeURIComponent(sid)}` } };
}

function esCookie(respuesta) {
  return (respuesta.headers.get('set-cookie') ?? '').includes(`${COOKIE_SESION_PORTAL}=`);
}

function cookieNueva(respuesta) {
  const crudo = respuesta.headers.get('set-cookie') ?? '';
  const valor = /tok_sesion_portal=([^;]*)/.exec(crudo);
  return valor ? decodeURIComponent(valor[1]) : null;
}

async function ejecutar() {
  console.log('\n  Verificacion del portal lanzador y del panel (Fases 07-08)\n');
  console.log(`  api=${BASE}   usuario=${USUARIO}   cliente=${CLIENTE}   otro=${OTRO_CLIENTE}\n`);

  // --- Preparacion ------------------------------------------------------------

  const usuario = await prisma.idn_usuario.findUnique({ where: { usuario: USUARIO } });
  if (!usuario) {
    throw new Error(`El usuario "${USUARIO}" no existe. Correr:  npm run bootstrap:admin`);
  }

  const membresias = await prisma.idn_usuario_cliente.findMany({
    where: { idusuario: usuario.idusuario },
    select: { idcliente: true, rol: true },
    orderBy: { idcliente: 'asc' },
  });
  if (membresias.length < 2) {
    throw new Error(
      `El usuario "${USUARIO}" es miembro de ${membresias.length} cliente(s). ` +
        'Esta verificacion necesita al menos dos para probar el cambio de cliente y ' +
        'la traversed entre tenants.',
    );
  }

  if (!membresias.some((m) => m.idcliente === CLIENTE)) {
    throw new Error(`"${USUARIO}" no es miembro de "${CLIENTE}".`);
  }
  if (OTRO_CLIENTE === CLIENTE) {
    throw new Error('El cliente ajeno tiene que ser distinto del de la sesion principal.');
  }
  const existeOtro = await prisma.cat_cliente.findUnique({ where: { codigo: OTRO_CLIENTE } });
  if (!existeOtro) {
    throw new Error(`El cliente "${OTRO_CLIENTE}" no existe en cat_cliente.`);
  }

  // Usuario de prueba para "un sid ajeno". No se le hace login (asi que no deja
  // filas en `aud_login` y se puede borrar al final).
  //
  // Se borra primero el que haya quedado de una corrida interrumpida: un
  // `Ctrl+C` a mitad del recorrido deja la fila puesta, y la corrida siguiente
  // muere en este `create` con "Unique constraint failed" sin decir que lo que
  // choca es un usuario de prueba del propio script.
  const ajenoViejo = await prisma.idn_usuario.findUnique({
    where: { usuario: USUARIO_AJENO },
    select: { idusuario: true },
  });
  if (ajenoViejo) {
    await limpiarUsuarioDePrueba(ajenoViejo.idusuario);
    nota(`limpiado el "${USUARIO_AJENO}" de una corrida anterior`);
  }
  const ajeno = await prisma.idn_usuario.create({
    data: {
      usuario: USUARIO_AJENO,
      nombre: 'Verificacion',
      apellido: 'Ajena',
      clave_hash: await hashear(randomUUID()),
      membresias: { create: { idcliente: CLIENTE, rol: 'user' } },
      membresiasAplicacion: { create: { idcliente: CLIENTE, idaplicacion: APP } },
    },
  });
  nota(`usuario de prueba "${USUARIO_AJENO}" (${ajeno.idusuario.slice(0, 8)}) en "${CLIENTE}"`);

  const cerrar = [];
  try {
    await correr(usuario, ajeno, cerrar);
    // La Fase 09 va aparte y al final a proposito: necesita la clave del admin
    // (con eco oculto) para las acciones de panel, y el recorrido de las fases
    // 07-08 no la necesita porque usa el token de una sesion de app. Pedirla en
    // medio de un recorrido largo hace que un script que fallaria en 30 segundos
    // tarde cinco minutos en preguntar algo.
    await mfaPorHttp();
  } finally {
    // Cierre de todo lo que se abrio, en orden inverso. Cada cierre es idempotente
    // y falla en silencio: que quede una sesion abierta de una corrida de
    // verificacion no rompe nada, pero hay que avisar.
    for (const sid of cerrar.reverse()) {
      await sesionesSvc.cerrar(sid, 'logout').catch(() => {});
    }
    await prisma.tok_sesion.deleteMany({ where: { idusuario: ajeno.idusuario } }).catch(() => {});
    await prisma.idn_usuario.deleteMany({ where: { usuario: USUARIO_AJENO } }).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  }
}

/**
 * El recorrido. Va en su propia funcion para que el `finally` de `ejecutar` pueda
 * limpiar sin meterse en medio de las comprobaciones.
 */
async function correr(usuario, ajeno, cerrar) {
  // --- 1 · Quiien soy ---------------------------------------------------------

  seccion('Sesion central: /me y /me/clientes');

  const sinSesion = await pedir('/me');
  verificar('/me sin cookie → 401 sesion_requerida',
    sinSesion.status === 401 && sinSesion.json?.codigo === 'sesion_requerida',
    `HTTP ${sinSesion.status} ${sinSesion.json?.codigo ?? ''}`);

  const cookieMuerta = await pedir('/me', cookieDe(randomUUID()));
  verificar('/me con un sid que no existe → 401 (no distingue el motivo)',
    cookieMuerta.status === 401 && cookieMuerta.json?.codigo === 'sesion_requerida',
    `HTTP ${cookieMuerta.status}`);

  const sesionPortal = await sesionesSvc.sesionDePortal(usuario.idusuario, CLIENTE, {
    ip: '190.5.7.9',
    userAgent: 'verificar-portal',
  });
  cerrar.push(sesionPortal.sid);
  const cookie = cookieDe(sesionPortal.sid);

  const me = await pedir('/me', cookie);
  verificar('/me responde 200', me.status === 200, `HTTP ${me.status}`);
  verificar('/me devuelve el usuario y el cliente de la sesion',
    me.json?.usuario === USUARIO && me.json?.clienteActual?.idcliente === CLIENTE,
    `${me.json?.usuario} en ${me.json?.clienteActual?.idcliente}`);
  verificar('/me NO devuelve el hash ni el estado de bloqueo',
    !/clave_hash|mfa_secret|intentos_fallidos|bloqueado_hasta/.test(me.texto),
    me.texto.slice(0, 60));
  verificar('/me responde Cache-Control: no-store',
    (me.headers.get('cache-control') ?? '').includes('no-store'),
    me.headers.get('cache-control') ?? '(ninguno)');

  const clientes = await pedir('/me/clientes', cookie);
  const esperados = await membresiasDe(usuario.idusuario);
  verificar('/me/clientes devuelve solo las membresias del usuario',
    clientes.status === 200 && clientes.json?.total === esperados.length &&
    clientes.json.clientes.every((c) => esperados.includes(c.idcliente)),
    `${clientes.json?.total} membresia(s)`);
  verificar('/me/clientes trae el rol por cliente (admin_identidad)',
    clientes.json?.clientes?.every((c) => c.rol === 'admin_identidad' || c.rol === 'user'),
    (clientes.json?.clientes ?? []).map((c) => `${c.idcliente}:${c.rol}`).join(' '));

  // El usuario de prueba es miembro de UN cliente: para el, el resto de la
  // instalacion es ajeno, y sus endpoints tienen que responder como si no existiera.
  const sesionAjenoPortal = await sesionesSvc.sesionDePortal(ajeno.idusuario, CLIENTE, {
    ip: '190.5.7.9',
    userAgent: 'verificar-portal',
  });
  cerrar.push(sesionAjenoPortal.sid);
  const ajenaCtx = cookieDe(sesionAjenoPortal.sid);
  const clientesAjenos = await pedir('/me/clientes', ajenaCtx);
  verificar('un usuario de un solo cliente ve SOLO ese cliente',
    clientesAjenos.json?.total === 1 && clientesAjenos.json?.clientes?.[0]?.idcliente === CLIENTE,
    (clientesAjenos.json?.clientes ?? []).map((c) => c.idcliente).join(' '));
  const cambioAjeno = await pedir('/me/cliente-activo', jsonPost({ cliente: OTRO_CLIENTE }, ajenaCtx));
  verificar('y no puede cambiar a un cliente del que no es miembro → 403',
    cambioAjeno.status === 403 && cambioAjeno.json?.codigo === 'cliente_no_pertenece',
    `HTTP ${cambioAjeno.status} ${cambioAjeno.json?.codigo ?? ''}`);

  // --- 2 · La lista de apps del lanzador ---------------------------------------

  seccion('Lanzador: /me/apps (los tres filtros y nada de credenciales)');

  const apps = await pedir('/me/apps', cookie);
  verificar('/me/apps responde 200', apps.status === 200, `HTTP ${apps.status}`);
  verificar('/me/apps responde con el idcliente DE LA SESION, no con otro',
    apps.json?.idcliente === CLIENTE, String(apps.json?.idcliente));
  verificar('/me/apps trae la url de arranque registrada (inicio) y el nombre de la base',
    Array.isArray(apps.json?.apps) &&
    apps.json.apps.every((a) => typeof a.inicio === 'string' && a.inicio.startsWith('http')),
    (apps.json?.apps ?? []).map((a) => `${a.codigo}→${a.base ?? 'sin base'}`).join(' '));
  verificar('/me/apps NO devuelve host, usuario ni credencial de la base',
    !/"host"|"usuario"|"credencial/.test(apps.texto), '(sin host/usuario/credencial)');
  verificar('/me/apps NO incluye apps de otro cliente',
    !(apps.json?.apps ?? []).some((a) => a.codigo === 'no-existe') && Array.isArray(apps.json?.apps),
    `${apps.json?.total} app(s)`);

  // Sesion del mismo usuario en el cliente ajeno: la lista tiene que cambiar de
  // cliente, y las apps habilitadas de un cliente no se ofrecen en el otro.
  const sesionAjenaOtro = await sesionesSvc.sesionDePortal(usuario.idusuario, OTRO_CLIENTE, {
    ip: '190.5.7.9',
    userAgent: 'verificar-portal',
  });
  cerrar.push(sesionAjenaOtro.sid);
  const appsAjenas = await pedir('/me/apps', cookieDe(sesionAjenaOtro.sid));
  verificar('con la sesion de otro cliente, /me/apps responde con ESE idcliente',
    appsAjenas.json?.idcliente === OTRO_CLIENTE, String(appsAjenas.json?.idcliente));
  verificar('y la base que muestra es la de ese cliente, no la del otro',
    (appsAjenas.json?.apps ?? []).every((a) => a.base !== undefined) &&
    JSON.stringify(appsAjenas.json?.apps) !== JSON.stringify(apps.json?.apps),
    (appsAjenas.json?.apps ?? []).map((a) => a.base ?? 'sin base').join(' '));

  // --- 3 · Cambio de cliente ---------------------------------------------------

  seccion('Cambio de cliente: POST /me/cliente-activo');

  // El caso "no es miembro" se prueba con el usuario de prueba, que es miembro de
  // un solo cliente (arriba, seccion 1). Con `admin` no se puede: en el despliegue
  // actual es `admin_identidad` de los cuatro clientes, asi que cualquier cliente
  // del catalogo le es valido y el 403 no se puede provocar por esa via.
  const inexistente = await pedir('/me/cliente-activo', jsonPost({ cliente: 'no-existe' }, cookie));
  verificar('cambiar a un cliente inexistente → 403 (no confirma que el cliente exista)',
    inexistente.status === 403 && inexistente.json?.codigo === 'cliente_no_pertenece',
    `HTTP ${inexistente.status} ${inexistente.json?.codigo ?? ''}`);

  const vacio = await pedir('/me/cliente-activo', jsonPost({ cliente: '' }, cookie));
  verificar('cambiar a un cliente vacio → 400 del DTO',
    vacio.status === 400, `HTTP ${vacio.status}`);

  // Sesion de app viva en el cliente original, para comprobar que el cambio de
  // cliente NO la toca (es lo que hace segura la trampa 1 de la fase 07).
  const sesionApp = await sesionesSvc.sesionDeApp(usuario.idusuario, CLIENTE, APP, 'pwd', {
    ip: '190.5.7.9',
    userAgent: 'verificar-portal',
  });
  cerrar.push(sesionApp.sid);

  const destino = esperados.find((c) => c !== CLIENTE);
  const cambio = await pedir('/me/cliente-activo', jsonPost({ cliente: destino }, cookie));
  verificar('cambiar a una membresia propia → 200', cambio.status === 200, `HTTP ${cambio.status}`);
  verificar('la respuesta trae el cliente nuevo y el rol',
    cambio.json?.clienteActual?.idcliente === destino, String(cambio.json?.clienteActual?.idcliente));
  verificar('y reescribe la cookie de sesion', esCookie(cambio), '(Set-Cookie)');

  const sidNuevo = cookieNueva(cambio);
  const filaVieja = await prisma.tok_sesion.findUnique({ where: { sid: sesionPortal.sid } });
  verificar('la fila de sesion vieja quedo CERRADA (no se reusa)',
    filaVieja?.cerrada_en !== null, String(filaVieja?.cerrada_en ?? 'null'));
  verificar('con motivo_cierre=revocada (re-emision, no logout)',
    filaVieja?.motivo_cierre === 'revocada', String(filaVieja?.motivo_cierre ?? 'null'));
  verificar('la fila nueva es del cliente nuevo y es una sesion del portal',
    Boolean(sidNuevo) &&
    (await prisma.tok_sesion.findUnique({ where: { sid: sidNuevo } }))?.idcliente === destino,
    `${sidNuevo ? sidNuevo.slice(0, 8) : '(sin cookie nueva)'}`);

  const filaApp = await prisma.tok_sesion.findUnique({ where: { sid: sesionApp.sid } });
  verificar('la sesion de la APP sigue abierta y con su idcliente original',
    filaApp?.cerrada_en === null && filaApp?.idcliente === CLIENTE,
    `idcliente=${filaApp?.idcliente}`);

  const appsTrasCambio = await pedir('/me/apps', cookieDe(sidNuevo));
  verificar('con la sesion nueva, /me/apps responde por el cliente nuevo',
    appsTrasCambio.json?.idcliente === destino, String(appsTrasCambio.json?.idcliente));

  const repetido = await pedir('/me/cliente-activo', jsonPost({ cliente: destino }, cookieDe(sidNuevo)));
  verificar('repetir el mismo cliente es idempotente (cambio=false, sin sesion nueva)',
    repetido.status === 200 && repetido.json?.cambio === false, `cambio=${repetido.json?.cambio}`);

  const auditoriaCambio = await prisma.aud_login.findFirst({
    where: { idusuario: usuario.idusuario, detalle: { startsWith: 'cambio_de_cliente' } },
    orderBy: { id: 'desc' },
    select: { detalle: true },
  });
  verificar('el cambio de cliente quedo auditado con el cliente nuevo en el detalle',
    typeof auditoriaCambio?.detalle === 'string' && auditoriaCambio.detalle.includes(`cliente=${destino}`),
    String(auditoriaCambio?.detalle ?? '(sin fila)'));

  // Vuelve al cliente original para el resto de la corrida.
  const vuelta = await pedir('/me/cliente-activo', jsonPost({ cliente: CLIENTE }, cookieDe(sidNuevo)));
  cerrar.push(cookieNueva(vuelta));
  const sesion = await sesionesSvc.sesionDePortal(usuario.idusuario, CLIENTE, {
    ip: '190.5.7.9',
    userAgent: 'verificar-portal',
  });
  cerrar.push(sesion.sid);
  const ctx = cookieDe(sesion.sid);

  // --- 4 · Sesiones propias ----------------------------------------------------

  seccion('Mis sesiones activas: GET /me/sesiones y DELETE /me/sesiones/:sid');

  const propias = await pedir('/me/sesiones', ctx);
  verificar('/me/sesiones responde 200', propias.status === 200, `HTTP ${propias.status}`);
  verificar('incluye la sesion del portal y la de la app',
    propias.json?.sesiones?.some((s) => s.es_portal) &&
    propias.json.sesiones.some((s) => s.idaplicacion === APP),
    propias.json?.sesiones?.map((s) => `${s.app}`).join(' '));
  verificar('la IP viene TRUNCADA (dos ultimos octetos ocultos)',
    propias.json?.sesiones?.every((s) => /^\d{1,3}\.\d{1,3}\.x\.x$/.test(s.ip)),
    propias.json?.sesiones?.map((s) => s.ip).join(' '));
  verificar('el user_agent viene crudo y el nombre de la app, no el codigo solo',
    propias.json?.sesiones?.every((s) => typeof s.user_agent === 'string' && typeof s.app === 'string'),
    propias.json?.sesiones?.[0]?.app ?? '');
  verificar('NO expone el idusuario de otros ni el sid de otro cliente',
    propias.json?.sesiones?.every((s) => s.sid && s.es_portal !== undefined),
    `${propias.json?.total} sesion(es)`);

  const sesionAjenaApp = await sesionesSvc.sesionDeApp(ajeno.idusuario, CLIENTE, APP, 'pwd', {
    ip: '190.5.7.9',
    userAgent: 'verificar-portal',
  });
  const borrarAjena = await pedir(`/me/sesiones/${sesionAjenaApp.sid}`, { method: 'DELETE', ...ctx });
  verificar('DELETE de un sid de OTRO usuario → 404 (no 403)', borrarAjena.status === 404,
    `HTTP ${borrarAjena.status} ${borrarAjena.json?.codigo ?? ''}`);
  verificar('y ese sid sigue vivo',
    (await prisma.tok_sesion.findUnique({ where: { sid: sesionAjenaApp.sid } }))?.cerrada_en === null,
    'cerrada_en=null');

  const cerrarApp = await pedir(`/me/sesiones/${sesionApp.sid}`, { method: 'DELETE', ...ctx });
  verificar('DELETE de una sesion propia → 200', cerrarApp.status === 200, `HTTP ${cerrarApp.status}`);
  const filaCerrada = await prisma.tok_sesion.findUnique({ where: { sid: sesionApp.sid } });
  verificar('la sesion queda cerrada con motivo_cierre=logout',
    filaCerrada?.cerrada_en !== null && filaCerrada?.motivo_cierre === 'logout',
    String(filaCerrada?.motivo_cierre ?? 'null'));
  const auditoriaCierre = await prisma.aud_login.findFirst({
    where: { idusuario: usuario.idusuario, detalle: { startsWith: 'sesion_cerrada_propia' } },
    orderBy: { id: 'desc' },
    select: { detalle: true, idusuario: true },
  });
  verificar('el cierre propio quedo auditado con el sub del que lo cerro',
    auditoriaCierre?.idusuario === usuario.idusuario,
    String(auditoriaCierre?.detalle ?? '(sin fila)'));

  const cerrarPortal = await pedir(`/me/sesiones/${sesion.sid}`, { method: 'DELETE', ...ctx });
  verificar('DELETE de la sesion del PORTAL → 200 y despues /me da 401',
    cerrarPortal.status === 200 && (await pedir('/me', ctx)).status === 401,
    `cierre HTTP ${cerrarPortal.status}`);

  // --- 5 · Salir de todo -------------------------------------------------------

  seccion('Salir de todo: POST /auth/logout-all');

  const sesionTodas = await sesionesSvc.sesionDePortal(usuario.idusuario, CLIENTE, {
    ip: '190.5.7.9',
    userAgent: 'verificar-portal',
  });
  const appParaSalir = await sesionesSvc.sesionDeApp(usuario.idusuario, CLIENTE, APP, 'pwd', {
    ip: '190.5.7.9',
    userAgent: 'verificar-portal',
  });
  // Sesion del MISMO usuario en otro cliente: "salir de todo" es por cliente, asi que
  // esta tiene que sobrevivir.
  const appOtroCliente = await sesionesSvc.sesionDeApp(usuario.idusuario, destino, APP, 'pwd', {
    ip: '190.5.7.9',
    userAgent: 'verificar-portal',
  });
  cerrar.push(appOtroCliente.sid);

  const todas = await pedir('/auth/logout-all', { method: 'POST', ...cookieDe(sesionTodas.sid) });
  verificar('logout-all responde 200', todas.status === 200, `HTTP ${todas.status}`);
  verificar('y borra la cookie de sesion', esCookie(todas) && cookieNueva(todas) === '',
    (todas.headers.get('set-cookie') ?? '(ninguna)').slice(0, 40));

  const ambasCerradas = await prisma.tok_sesion.findMany({
    where: { sid: { in: [sesionTodas.sid, appParaSalir.sid] } },
    select: { sid: true, cerrada_en: true },
  });
  verificar('cierra TODAS las sesiones del usuario en el cliente (portal y apps)',
    ambasCerradas.length === 2 && ambasCerradas.every((s) => s.cerrada_en !== null),
    `${ambasCerradas.filter((s) => s.cerrada_en !== null).length}/2 cerradas`);

  const otraViva = await prisma.tok_sesion.findUnique({ where: { sid: appOtroCliente.sid } });
  verificar('la sesion del usuario en OTRO cliente sigue viva',
    otraViva?.cerrada_en === null, `idcliente=${otraViva?.idcliente}`);

  const logoutTodoAuditado = await prisma.aud_login.findFirst({
    where: { idusuario: usuario.idusuario, detalle: { startsWith: 'logout_todo' } },
    orderBy: { id: 'desc' },
    select: { detalle: true },
  });
  verificar('"salir de todo" quedo auditado con el sub y el cliente',
    typeof logoutTodoAuditado?.detalle === 'string' && logoutTodoAuditado.detalle.includes(`cliente=${CLIENTE}`),
    String(logoutTodoAuditado?.detalle ?? '(sin fila)'));

  const logoutTodoSinSesion = await pedir('/auth/logout-all', { method: 'POST', headers: {} });
  verificar('logout-all sin sesion es 200 con cerradas=0 (idempotente)',
    logoutTodoSinSesion.status === 200 && logoutTodoSinSesion.json?.cerradas === 0,
    `HTTP ${logoutTodoSinSesion.status} cerradas=${logoutTodoSinSesion.json?.cerradas}`);

  // ---------------------------------------------------------------------------
  await panelDeIdentidad(usuario, ajeno, cerrar, destino);
}

/**
 * Fase 08: el panel `admin_identidad`.
 *
 * Va en su propia funcion porque necesita su propio contexto: el panel se prueba
 * con un admin en `CLIENTE` y con un usuario comun en el mismo cliente (para el 403),
 * y los dos journey no comparten sesion.
 */
async function panelDeIdentidad(usuario, ajeno, cerrar, otroCliente) {
  const sesionAdmin = await sesionesSvc.sesionDePortal(usuario.idusuario, CLIENTE, {
    ip: '190.5.7.9',
    userAgent: 'verificar-portal',
  });
  cerrar.push(sesionAdmin.sid);
  const admin = cookieDe(sesionAdmin.sid);

  const sesionUser = await sesionesSvc.sesionDePortal(ajeno.idusuario, CLIENTE, {
    ip: '190.5.7.9',
    userAgent: 'verificar-portal',
  });
  cerrar.push(sesionUser.sid);
  const user = cookieDe(sesionUser.sid);

  seccion('Panel admin_identidad: el guard de tenant');

  for (const ruta of ['/admin/usuarios', '/admin/sesiones', '/admin/auditoria', '/admin/resumen']) {
    const r = await pedir(ruta, user);
    verificar(`${ruta} con rol=user → 403 sin_permiso`,
      r.status === 403 && r.json?.codigo === 'sin_permiso', `HTTP ${r.status} ${r.json?.codigo ?? ''}`);
  }

  for (const ruta of ['/admin/usuarios', '/admin/sesiones', '/admin/auditoria', '/admin/resumen']) {
    const sinCookie = await pedir(ruta);
    verificar(`${ruta} sin sesion → 401 sesion_requerida`,
      sinCookie.status === 401 && sinCookie.json?.codigo === 'sesion_requerida',
      `HTTP ${sinCookie.status}`);
  }

  seccion('Panel: alta de usuario, reset de clave y habilitacion de apps');

  const sufijo = Date.now().toString(36).slice(-6);
  const nuevoUsuario = `verif${sufijo}`;

  // Un `:id` que no es UUID tiene que dar 400 y no 500: es un pedido mal formado,
  // y un 500 en el panel hace pensar que el panel esta roto.
  const idBasura = await pedir('/admin/usuarios/no-es-un-uuid', admin);
  verificar('un :id que no es UUID → 400 (no 500 del motor)', idBasura.status === 400,
    `HTTP ${idBasura.status}`);

  // 201 y no 200: lo que se crea es la membresía (y a veces el usuario). El codigo
  // lo pone el controlador con `@HttpCode(201)`.
  const alta = await pedir('/admin/usuarios', jsonPost({
    usuario: nuevoUsuario,
    nombre: 'Alta',
    apellido: 'De Prueba',
    email: `${nuevoUsuario}@ejemplo.invalid`,
    aplicaciones: [APP],
    claveTemporal: true,
  }, admin));
  verificar('alta de usuario → 201', alta.status === 201, `HTTP ${alta.status} ${alta.json?.codigo ?? ''}`);
  const claveTemporal = alta.json?.clave_temporal ?? null;
  verificar('el alta devuelve la clave temporal UNA vez',
    typeof claveTemporal === 'string' && claveTemporal.length >= 16,
    claveTemporal ? `${claveTemporal.length} caracteres` : '(vacia)');

  const filaAlta = await prisma.idn_usuario.findUnique({
    where: { usuario: nuevoUsuario },
    select: {
      idusuario: true,
      usuario: true,
      clave_hash: true,
      membresias: { select: { idcliente: true, rol: true } },
      membresiasAplicacion: { select: { idcliente: true, idaplicacion: true } },
    },
  });
  verificar('la fila existe con el hash argon2id y la membresia del tenant del admin',
    filaAlta?.clave_hash?.startsWith('$argon2id$') &&
    filaAlta.membresias.some((m) => m.idcliente === CLIENTE) &&
    filaAlta.membresiasAplicacion.some((m) => m.idcliente === CLIENTE && m.idaplicacion === APP),
    `membresia=${filaAlta?.membresias.map((m) => m.idcliente).join(',')}`);

  verificar('el alta NO habilita al usuario en otro tenant',
    !filaAlta?.membresias.some((m) => m.idcliente === otroCliente) &&
    !filaAlta?.membresiasAplicacion.some((m) => m.idcliente === otroCliente),
    'sin membresia en ' + otroCliente);

  verificar('la respuesta del alta NO trae el hash ni los intentos fallidos',
    !/clave_hash|intentos_fallidos|bloqueado_hasta|mfa_secret/.test(alta.texto),
    '(sin secretos)');

  const idAlta = filaAlta?.idusuario;
  const auditoriaAlta = await prisma.aud_login.findFirst({
    where: { detalle: { startsWith: 'admin_alta_usuario' } },
    orderBy: { id: 'desc' },
    select: { idusuario: true, detalle: true },
  });
  verificar('el alta quedo auditada con el sub del ADMIN (no el del altaado)',
    auditoriaAlta?.idusuario === usuario.idusuario &&
    typeof auditoriaAlta?.detalle === 'string' && auditoriaAlta.detalle.includes(`usuario=${idAlta}`),
    String(auditoriaAlta?.detalle ?? '(sin fila)'));

  const reAlta = await pedir('/admin/usuarios', jsonPost({
    usuario: nuevoUsuario,
    nombre: 'Otro',
    apellido: 'Nombre',
    aplicaciones: [],
  }, admin));
  verificar('alta de un usuario que ya existe → 409 y NO pisa sus datos',
    reAlta.status === 409 &&
    (await prisma.idn_usuario.findUnique({ where: { usuario: nuevoUsuario } }))?.nombre === 'Alta',
    `HTTP ${reAlta.status} nombre=${(await prisma.idn_usuario.findUnique({ where: { usuario: nuevoUsuario } }))?.nombre}`);

  const listado = await pedir(`/admin/usuarios?q=${nuevoUsuario}`, admin);
  verificar('el listado del admin incluye al usuario nuevo',
    listado.status === 200 && (listado.json?.usuarios ?? []).some((u) => u.usuario === nuevoUsuario),
    `${listado.json?.total ?? '?'} usuario(s)`);
  verificar('el listado NO trae clave_hash, mfa ni intentos_fallidos',
    !/clave_hash|mfa_secret|intentos_fallidos|bloqueado_hasta/.test(listado.texto),
    '(sin secretos)');

  const reset = await pedir(`/admin/usuarios/${idAlta}/reset-clave`, { method: 'POST', ...admin });
  verificar('reset de clave → 200 con una clave nueva',
    reset.status === 200 && typeof reset.json?.clave_temporal === 'string' &&
    reset.json.clave_temporal !== claveTemporal,
    'clave distinta a la del alta');
  const segundoListado = await pedir(`/admin/usuarios/${idAlta}`, admin);
  verificar('despues del reset, la ficha NO vuelve a mostrar la clave',
    segundoListado.status === 200 && segundoListado.json?.clave_temporal === undefined,
    '(sin clave en la ficha)');

  const deshabilitar = await pedir(`/admin/usuarios/${idAlta}/apps/${APP}`, { method: 'DELETE', ...admin });
  verificar('deshabilitar la app → 200 y la fila de habilitacion desaparece',
    deshabilitar.status === 200 &&
    (await prisma.idn_usuario_cliente_aplicacion.count({
      where: { idusuario: idAlta, idcliente: CLIENTE, idaplicacion: APP },
    })) === 0,
    `HTTP ${deshabilitar.status}`);

  const deshabilitarDosVeces = await pedir(`/admin/usuarios/${idAlta}/apps/${APP}`, { method: 'DELETE', ...admin });
  verificar('deshabilitar una app que ya no esta → 404 (idempotente no es "ok" mudo)',
    deshabilitarDosVeces.status === 404, `HTTP ${deshabilitarDosVeces.status}`);

  const habilitar = await pedir(`/admin/usuarios/${idAlta}/apps/${APP}`, { method: 'PUT', ...admin });
  verificar('habilitar la app de nuevo → 200 y la fila vuelve',
    habilitar.status === 200 &&
    (await prisma.idn_usuario_cliente_aplicacion.count({
      where: { idusuario: idAlta, idcliente: CLIENTE, idaplicacion: APP },
    })) === 1,
    `HTTP ${habilitar.status}`);

  seccion('Panel: desactivacion de usuario y cierre forzado de sesiones');

  const editar = await pedir(`/admin/usuarios/${idAlta}`, {
    ...jsonPost({ estado: 'inactivo' }, admin),
    method: 'PATCH',
  });
  verificar('desactivar un usuario → 200 con estado=inactivo',
    editar.status === 200 && editar.json?.estado === 'inactivo', `HTTP ${editar.status}`);

  const sesionDelInactivo = await sesionesSvc.sesionDePortal(idAlta, CLIENTE, {
    ip: '190.5.7.9',
    userAgent: 'verificar-portal',
  });
  const cascada = await pedir(`/admin/usuarios/${idAlta}`, {
    ...jsonPost({ estado: 'inactivo' }, admin),
    method: 'PATCH',
  });
  verificar('volver a desactivar cierra en cascada las sesiones del usuario',
    cascada.status === 200 &&
    (await prisma.tok_sesion.findUnique({ where: { sid: sesionDelInactivo.sid } }))?.cerrada_en !== null,
    'sesiones del usuario cerradas');

  const reactivar = await pedir(`/admin/usuarios/${idAlta}`, {
    ...jsonPost({ estado: 'activo' }, admin),
    method: 'PATCH',
  });
  verificar('reactivar un usuario → 200 con estado=activo',
    reactivar.status === 200 && reactivar.json?.estado === 'activo', `HTTP ${reactivar.status}`);

  // Sesion de app de un miembro del tenant, para el cierre forzado.
  const victima = await sesionesSvc.sesionDeApp(ajeno.idusuario, CLIENTE, APP, 'pwd', {
    ip: '190.5.7.9',
    userAgent: 'verificar-portal',
  });

  const sinMotivo = await pedir(`/admin/sesiones/${victima.sid}`, { method: 'DELETE', ...admin });
  verificar('cierre forzado SIN motivo → 400',
    sinMotivo.status === 400, `HTTP ${sinMotivo.status} ${sinMotivo.json?.codigo ?? ''}`);

  // `jsonPost` trae `method: 'POST'` porque asi se usa en los endpoints de alta, y
  // el cierre forzado es un DELETE con cuerpo: hay que volver a poner el verbo o la
  // ruta no existe y el 404 dice "Cannot DELETE" (que es lo que paso la primera vez).
  const cerrarCon = (cuerpo) => ({ ...jsonPost(cuerpo, admin), method: 'DELETE' });

  const motivoInvalido = await pedir(`/admin/sesiones/${victima.sid}`, cerrarCon({ motivo: 'porque-si' }));
  verificar('cierre forzado con un motivo fuera de la lista → 400',
    motivoInvalido.status === 400, `HTTP ${motivoInvalido.status}`);

  const cierreForzado = await pedir(`/admin/sesiones/${victima.sid}`, cerrarCon({ motivo: 'sospecha' }));
  verificar('cierre forzado con motivo → 200', cierreForzado.status === 200, `HTTP ${cierreForzado.status}`);
  const filaVictima = await prisma.tok_sesion.findUnique({ where: { sid: victima.sid } });
  verificar('la sesion queda cerrada con el MOTIVO en tok_sesion.motivo_cierre',
    filaVictima?.cerrada_en !== null && filaVictima?.motivo_cierre === 'sospecha',
    String(filaVictima?.motivo_cierre ?? 'null'));
  const auditoriaCierreAdmin = await prisma.aud_login.findFirst({
    where: { detalle: { startsWith: 'admin_cierra_sesion' } },
    orderBy: { id: 'desc' },
    select: { idusuario: true, detalle: true },
  });
  verificar('el cierre forzado quedo auditado con el sub del admin, el sid y el motivo',
    auditoriaCierreAdmin?.idusuario === usuario.idusuario &&
    String(auditoriaCierreAdmin?.detalle).includes('sospecha') &&
    String(auditoriaCierreAdmin?.detalle).includes(`sid=${victima.sid.slice(0, 8)}`),
    String(auditoriaCierreAdmin?.detalle ?? '(sin fila)'));

  // Un sid de otro tenant: 404, y sigue vivo.
  const sesionOtroTenant = await sesionesSvc.sesionDePortal(ajeno.idusuario, CLIENTE, {
    ip: '190.5.7.9',
    userAgent: 'verificar-portal',
  });
  await sesionesSvc.cerrar(sesionOtroTenant.sid, 'logout');
  const strangerSid = randomUUID();
  const stranger = await pedir(`/admin/sesiones/${strangerSid}`, cerrarCon({ motivo: 'soporte' }));
  verificar('cierre forzado de un sid inexistente → 404', stranger.status === 404, `HTTP ${stranger.status}`);

  seccion('Panel: lectura de auditoria y de sesiones (el filtro de tenant)');

  const sesionesAdmin = await pedir('/admin/sesiones', admin);
  verificar('/admin/sesiones responde 200 y trae el nombre de la app',
    sesionesAdmin.status === 200 && (sesionesAdmin.json?.sesiones ?? []).every((s) => typeof s.app === 'string'),
    `${sesionesAdmin.json?.total ?? '?'} sesion(es)`);
  verificar('/admin/sesiones solo trae sesiones del tenant del admin',
    (sesionesAdmin.json?.sesiones ?? []).every((s) => s.idcliente === CLIENTE),
    `idcliente=${(sesionesAdmin.json?.sesiones ?? [])[0]?.idcliente}`);

  const auditoria = await pedir('/admin/auditoria', admin);
  verificar('/admin/auditoria responde 200', auditoria.status === 200, `HTTP ${auditoria.status}`);
  const eventos = auditoria.json?.eventos ?? [];
  verificar('los eventos tienen ts, resultado, detalle y usuario resuelto',
    eventos.every((e) => e.ts && e.resultado) && eventos.some((e) => e.detalle?.startsWith('admin_')),
    `${eventos.length} evento(s)`);
  verificar('el user_agent llega CRUDO (lo resume el front, ver lib/user-agent.ts)',
    eventos.every((e) => typeof e.user_agent === 'string'),
    eventos[0]?.user_agent?.slice(0, 40) ?? '');

  // Travesia: un login fallido de un usuario de OTRO tenant no puede aparecer. Por
  // eso hace falta un usuario de verdad del otro cliente: con un usuario del mismo
  // tenant la comprobacion daria verde sin provar nada.
  // La IP es UNICA POR CORRIDA: con una fija (203.0.113.7), una fila que quedo de
  // una corrida anterior con un usuario de este mismo tenant hace que el filtro
  // parezca roto cuando no lo esta. Es la diferencia entre un test que prueba y un
  // test que mira.
  const ipIntrusa = `198.51.100.${1 + Math.floor(Math.random() * 250)}`;
  nota(`IP de la prueba de travesia: ${ipIntrusa}`);

  const ajenaOTro = await prisma.idn_usuario.create({
    data: {
      usuario: `verifajena${Date.now().toString(36).slice(-4)}`,
      nombre: 'Verificacion',
      apellido: 'Otro cliente',
      clave_hash: await hashear(randomUUID()),
      membresias: { create: { idcliente: otroCliente, rol: 'user' } },
    },
    select: { idusuario: true, usuario: true },
  });
  try {
    await prisma.aud_login.create({
      data: {
        resultado: 'claves',
        idusuario: ajenaOTro.idusuario,
        idaplicacion: null,
        ip: ipIntrusa,
        user_agent: 'verificar-portal',
        detalle: 'clave_incorrecta',
      },
    });
    const tras = await pedir('/admin/auditoria?resultado=claves', admin);
    const intrusos = (tras.json?.eventos ?? []).filter((e) => e.ip === ipIntrusa);
    verificar('un login fallido de un usuario de OTRO tenant NO aparece en la auditoria',
      intrusos.length === 0,
      `${intrusos.length} intruso(s) de ${tras.json?.eventos?.length ?? 0} evento(s)`);

    const sasDelOtro = await pedir('/admin/sesiones', admin);
    verificar('las sesiones del otro cliente tampoco aparecen',
      (sasDelOtro.json?.sesiones ?? []).every((s) => s.idcliente === CLIENTE),
      `${sasDelOtro.json?.total ?? 0} sesion(es), todas de ${CLIENTE}`);
  } finally {
    await limpiarUsuarioDePrueba(ajenaOTro.idusuario);
  }

  const resumen = await pedir('/admin/resumen', admin);
  verificar('/admin/resumen responde 200 con conteos del tenant',
    resumen.status === 200 && typeof resumen.json?.usuarios === 'number' && resumen.json.usuarios > 0,
    `usuarios=${resumen.json?.usuarios} sesiones=${resumen.json?.sesiones_abiertas}`);
  verificar('/admin/resumen NO cuenta usuarios de otro tenant',
    (await prisma.idn_usuario_cliente.count({ where: { idcliente: CLIENTE } })) === resumen.json?.usuarios,
    'conteo = membresias del tenant');

  // El usuario de prueba se borra, junto con lo que lo referencia. El panel no
  // borra identidades (se desactivan, y con razon), pero esta corrida dejo filas
  // en `aud_login` y `tok_sesion` que apuntan a el y las FK son NO ACTION: sin
  // esta limpieza, `verificar-portal` deja basura que se acumula en cada corrida y
  // ensucia el listado de usuarios del panel. Es el unico `delete` de
  // `aud_login` del repo, y es aca: un script de prueba, no la aplicacion.
  await limpiarUsuarioDePrueba(idAlta);
  nota(`Usuario de prueba "${nuevoUsuario}" borrado (con sus sesiones y su auditoria).`);
}

/**
 * Borra un usuario de prueba y todo lo que lo referencia.
 *
 * El orden importa por las FK (`NO ACTION`): primero las filas que lo apuntan
 * (auditoria y sesiones), despues las suyas (habilitaciones y membresia), y al
 * final la fila. Es lo unico del repo que borra de `aud_login`, y a proposito
 * esta fuera de la aplicacion: `aud_login` es append-only para el producto.
 */
async function limpiarUsuarioDePrueba(idusuario) {
  await prisma.aud_login.deleteMany({ where: { idusuario } });
  await prisma.tok_sesion.deleteMany({ where: { idusuario } });
  await prisma.idn_usuario_cliente_aplicacion.deleteMany({ where: { idusuario } });
  await prisma.idn_usuario_cliente.deleteMany({ where: { idusuario } });
  await prisma.idn_usuario.deleteMany({ where: { idusuario } });
}

/** Membresias activas del usuario, para comparar contra lo que devuelve la API. */
async function membresiasDe(idusuario) {
  const filas = await prisma.idn_usuario_cliente.findMany({
    where: { idusuario, cliente: { estado: 'activo' } },
    select: { idcliente: true },
    orderBy: { idcliente: 'asc' },
  });
  return filas.map((f) => f.idcliente);
}

/**
 * Fase 09: el segundo factor de punta a punta, por HTTP.
 *
 * Usa un usuario de prueba con **clave conocida** (`CLAVE_MFA`), porque hace
 * falta pasar el paso 1 del login varias veces. Se crea, se usa y se borra al
 * final; el `finally` de `mfaPorHttp` lo limpia aunque el recorrido falle a la
 * mitad, y `limpiarUsuarioDePrueba` saca también los códigos de recuperación.
 *
 * Los códigos TOTP se calculan **descifrando el secret de la base** con la
 * master key, o sea con el mismo `totp.js` que usa el backend. Eso no alcanza
 * para probar el algoritmo —para eso están los vectores del RFC en
 * `verificar-mfa.mjs`— pero sí para probar el camino: que el secret que se
 * descifra sea el que el admin recibió, que el anti-reuso rechace el reuso y
 * que un código de hace 3 períodos entre por la ventana de reloj.
 */
async function mfaPorHttp() {
  const { MasterKeyService } = cargar('claves/master-key.service.js');
  const totp = cargar('auth/totp.js');
  const { descifrar } = cargar('claves/crypto.js');
  const masterKey = new MasterKeyService(configServiceDelScript());

  const USUARIO_MFA = 'verificacion-mfa';
  const CLAVE_MFA = 'Verificacion-MFA-2026!a';
  const USUARIO_ADMIN = 'verificacion-admin';
  const CLAVE_ADMIN = 'Verificacion-Admin-2026!a';

  seccion('Segundo factor: alta, pending, ingreso en dos pasos (Fase 09)');

  /**
   * El admin de las acciones de panel es un usuario **de prueba** con
   * `admin_identidad` en el cliente, y no el admin real del repo.
   *
   * Es la razón por la que esta seccion no pide ninguna clave: un script de
   * verificación que arranca con "Clave del admin:" es un script que no se puede
   * correr en una máquina donde nadie conoce esa clave, y además obliga a que
   * quien lo corre sea alguien. Con un admin de prueba con clave conocida, el
   * script es autónomo y de paso prueba algo que el panel importa: que las
   * acciones de MFA funcionan para **cualquier** `admin_identidad` del tenant, y
   * no sólo para la cuenta con la que se administersa.
   */
  // Limpieza defensiva de una corrida anterior interrumpida. Un `Ctrl+C` en el
  // medio de esta seccion deja los dos usuarios de prueba puestos, y la corrida
  // siguiente falla con "Unique constraint failed" en el primer `create`, que
  // no dice nada de la causa real. Borrarlos al empezar hace el script
  // re-ejecutable sin que haya que acordarse de borrar a mano.
  for (const usuarioViejo of [USUARIO_MFA, USUARIO_ADMIN]) {
    const fila = await prisma.idn_usuario.findUnique({
      where: { usuario: usuarioViejo },
      select: { idusuario: true },
    });
    if (fila) {
      await prisma.tok_mfa_challenge.deleteMany({ where: { idusuario: fila.idusuario } }).catch(() => {});
      await prisma.idn_usuario_mfa_codigo.deleteMany({ where: { idusuario: fila.idusuario } }).catch(() => {});
      await limpiarUsuarioDePrueba(fila.idusuario);
      nota(`limpiado el "${usuarioViejo}" de una corrida anterior`);
    }
  }

  const adminDePrueba = await prisma.idn_usuario.create({
    data: {
      usuario: USUARIO_ADMIN,
      nombre: 'Verificacion',
      apellido: 'Admin',
      clave_hash: await hashear(CLAVE_ADMIN),
      mfa_estado: 'off',
      membresias: { create: { idcliente: CLIENTE, rol: 'admin_identidad' } },
      membresiasAplicacion: { create: { idcliente: CLIENTE, idaplicacion: APP } },
    },
  });
  const loginAdmin = await pedir('/auth/login', jsonPost({ usuario: USUARIO_ADMIN, clave: CLAVE_ADMIN }));
  const cookieAdmin = esCookie(loginAdmin) ? cookieDe(cookieNueva(loginAdmin)) : null;
  verificar('el admin de prueba entra al panel del cliente', cookieAdmin !== null,
    cookieAdmin ? `sid=${(cookieNueva(loginAdmin) ?? '').slice(0, 8)}` : `HTTP ${loginAdmin.status}`);
  if (!cookieAdmin) {
    await limpiarUsuarioDePrueba(adminDePrueba.idusuario);
    throw new Error('Sin sesion de admin no se puede seguir con la seccion de MFA.');
  }
  const sidAdmin = cookieNueva(loginAdmin);

  // El usuario de prueba. `mfa_estado` arranca en `off`, que es el estado por
  // defecto del DDL: toda la seccion empieza desde cero y comprueba que el
  // default es `off`.
  const dePrueba = await prisma.idn_usuario.create({
    data: {
      usuario: USUARIO_MFA,
      nombre: 'Verificacion',
      apellido: 'MFA',
      clave_hash: await hashear(CLAVE_MFA),
      mfa_estado: 'off',
      membresias: { create: { idcliente: CLIENTE, rol: 'user' } },
      membresiasAplicacion: { create: { idcliente: CLIENTE, idaplicacion: APP } },
    },
  });
  nota(`usuarios de prueba "${USUARIO_MFA}" y "${USUARIO_ADMIN}" en "${CLIENTE}"`);

  const sidsAbiertos = [];
  try {
    // 1. Con MFA apagado, el login es de un paso y crea sesion.
    const loginNormal = await pedir('/auth/login', jsonPost({ usuario: USUARIO_MFA, clave: CLAVE_MFA }));
    verificar('login sin MFA → 200 con sesion',
      loginNormal.status === 200 && esCookie(loginNormal) && !loginNormal.json?.requiere_mfa);
    const sidNormal = cookieNueva(loginNormal);
    if (sidNormal) {
      sidsAbiertos.push(sidNormal);
    }
    const sesionNormal = sidNormal
      ? await prisma.tok_sesion.findUnique({ where: { sid: sidNormal }, select: { amr: true } })
      : null;
    verificar('la sesion sin segundo factor queda con amr=pwd', sesionNormal?.amr === 'pwd',
      sesionNormal?.amr ?? '(sin sesion)');

    // 2. El panel del admin activa MFA. Es la via de produccion (`specs/01` §8.1):
    //    el `otpauth://` y los 10 codigos salen **una sola vez** de esta respuesta.
    const activar = await pedir(`/admin/usuarios/${dePrueba.idusuario}/mfa`,
      jsonPost({}, { ...cookieAdmin }));

    verificar('el panel activa MFA → 200 con otpauth y 10 codigos',
      activar.status === 200 && typeof activar.json?.otpauth === 'string' && activar.json?.codigos?.length === 10,
      `HTTP ${activar.status} codigos=${activar.json?.codigos?.length ?? '-'}`);
    verificar('la respuesta del alta dice unica_vez=true', activar.json?.unica_vez === true);
    verificar('el otpauth lleva issuer=Tourniquet y secret',
      /^otpauth:\/\/totp\/Tourniquet%3A/.test(activar.json?.otpauth ?? '') &&
        (activar.json?.otpauth ?? '').includes('secret='));
    verificar('el secret son 32 caracteres base32',
      (activar.json?.clave ?? '').length === 32, activar.json?.clave ?? '');

    // 3. En la base: `pending`, secret binario, 10 codigos hasheados.
    const fila = await prisma.idn_usuario.findUnique({
      where: { idusuario: dePrueba.idusuario },
      select: { mfa_estado: true, mfa_secret_cifrada: true, mfa_ultimo_periodo: true },
    });
    verificar('el usuario queda en pending (todavia no pide codigo)', fila?.mfa_estado === 'pending',
      fila?.mfa_estado ?? '-');
    const secretoCifrado = Buffer.from(fila?.mfa_secret_cifrada ?? []);
    verificar('mfa_secret_cifrada es binario, no texto',
      secretoCifrado.length > 28 && !/^[\x20-\x7e]+$/.test(secretoCifrado.toString('latin1')),
      `${secretoCifrado.length} bytes`);
    verificar('mfa_ultimo_periodo arranca en NULL (nunca se acepto un codigo)',
      fila?.mfa_ultimo_periodo === null || fila?.mfa_ultimo_periodo === undefined);

    const codigos = await prisma.idn_usuario_mfa_codigo.findMany({
      where: { idusuario: dePrueba.idusuario },
      select: { codigo_hash: true, usado_en: true },
    });
    verificar('hay 10 codigos de recuperacion, hasheados y sin usar',
      codigos.length === 10 && codigos.every((c) => /^[0-9a-f]{64}$/.test(c.codigo_hash) && c.usado_en === null));
    verificar('los 10 hashes son distintos (10 codigos distintos)',
      new Set(codigos.map((c) => c.codigo_hash)).size === 10);

    // 4. `pending` NO pide codigo: el login sigue siendo de un paso.
    const loginPending = await pedir('/auth/login', jsonPost({ usuario: USUARIO_MFA, clave: CLAVE_MFA }));
    verificar('con MFA pending el login NO pide codigo (trampa 2 de la fase 09)',
      loginPending.status === 200 && !loginPending.json?.requiere_mfa && esCookie(loginPending));
    const sidPending = cookieNueva(loginPending);
    if (sidPending) sidsAbiertos.push(sidPending);

    // 5. Confirmacion: con un codigo de la app, `pending` → `on`.
    const secreto = descifrar(secretoCifrado, masterKey.valorB64);
    const cookiePendiente = sidPending ? cookieDe(sidPending) : {};
    const confirmar = await pedir('/me/mfa/confirmar',
      jsonPost({ codigo: totp.codigoActual(secreto) }, { ...cookiePendiente }));
    verificar('POST /me/mfa/confirmar con el codigo correcto → estado on',
      confirmar.status === 200 && confirmar.json?.estado === 'on', `HTTP ${confirmar.status}`);

    // 6. Con `on`, el login responde 200 `requiere_mfa` y **no** deja sesion.
    const antesDelLogin = await prisma.tok_sesion.count({
      where: { idusuario: dePrueba.idusuario, cerrada_en: null },
    });
    const loginMfa = await pedir('/auth/login', jsonPost({ usuario: USUARIO_MFA, clave: CLAVE_MFA }));
    verificar('con MFA on el login responde requiere_mfa=true',
      loginMfa.status === 200 && loginMfa.json?.requiere_mfa === true, `HTTP ${loginMfa.status}`);
    verificar('el desafio trae factor_id (uuid v4)',
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(loginMfa.json?.factor_id ?? ''),
      loginMfa.json?.factor_id ?? '-');
    verificar('el paso 1 NO escribe cookie de sesion', !esCookie(loginMfa));
    verificar('el paso 1 NO crea fila en tok_sesion',
      (await prisma.tok_sesion.count({ where: { idusuario: dePrueba.idusuario, cerrada_en: null } })) === antesDelLogin);
    verificar('el desafio trae los 5 intentos y los codigos restantes',
      loginMfa.json?.intentos_restantes === 5 && loginMfa.json?.codigos_restantes === 10);

    const factor = loginMfa.json?.factor_id;

    // 7. Un codigo incorrecto: 401, cuenta los intentos y NO crea sesion.
    const malo = await pedir('/auth/mfa/verify', jsonPost({ factor_id: factor, codigo: '000000' }));
    verificar('un codigo incorrecto → 401 mfa_incorrecto',
      malo.status === 401 && malo.json?.codigo === 'mfa_incorrecto', `HTTP ${malo.status}`);
    verificar('la respuesta dice cuantos intentos quedan',
      malo.json?.intentos_restantes === 4, `${malo.json?.intentos_restantes ?? '-'}`);
    verificar('un codigo incorrecto NO crea sesion',
      (await prisma.tok_sesion.count({ where: { idusuario: dePrueba.idusuario, cerrada_en: null } })) === antesDelLogin);

    // 8. El codigo correcto completa el login y la sesion queda `pwd,mfa`.
    //
    // El codigo es el del **periodo siguiente**, no el actual, y es deliberado: la
    // confirmacion del paso 5 ya consumio el periodo actual
    // (`mfa_ultimo_periodo`), asi que el mismo codigo seria "correcto y
    // reutilizado" y el backend lo rechazaria por el anti-reuso. Usar el
    // siguiente prueba, de paso, que la ventana +-1 acepta un codigo de periodo
    // futuro, que es la mitad de la tolerancia de reloj.
    const codigoOk = totp.codigoDePeriodo(secreto, totp.periodoDe() + 1);
    const ok = await pedir('/auth/mfa/verify', jsonPost({ factor_id: factor, codigo: codigoOk }));
    verificar('el codigo correcto → 200 con cookie de sesion',
      ok.status === 200 && esCookie(ok), `HTTP ${ok.status}`);
    const sidMfa = cookieNueva(ok);
    if (sidMfa) sidsAbiertos.push(sidMfa);
    verificar('el returnTo sale de la fila del desafio, no del pedido',
      typeof ok.json?.returnTo === 'string', ok.json?.returnTo ?? '-');
    const sesionMfa = sidMfa
      ? await prisma.tok_sesion.findUnique({ where: { sid: sidMfa }, select: { amr: true } })
      : null;
    verificar('la sesion con segundo factor queda con amr=pwd,mfa',
      sesionMfa?.amr === 'pwd,mfa', sesionMfa?.amr ?? '(sin sesion)');

    // 9. Anti-reuso: el mismo codigo, en otro desafio, ya no sirve.
    const segundo = await pedir('/auth/login', jsonPost({ usuario: USUARIO_MFA, clave: CLAVE_MFA }));
    const reuso = await pedir('/auth/mfa/verify',
      jsonPost({ factor_id: segundo.json?.factor_id, codigo: codigoOk }));
    verificar('reusar el mismo codigo TOTP → 401 (trampa 1 de la fase 09)',
      reuso.status === 401 && reuso.json?.codigo === 'mfa_incorrecto', `HTTP ${reuso.status}`);

    // 10. Un factor_id invalido dice "volvé a ingresar" y no distingue el motivo.
    const factorFalso = await pedir('/auth/mfa/verify',
      jsonPost({ factor_id: '00000000-0000-4000-8000-000000000000', codigo: '123456' }));
    verificar('un factor_id que no existe → 401 mfa_desafio_invalido',
      factorFalso.status === 401 && factorFalso.json?.codigo === 'mfa_desafio_invalido',
      `HTTP ${factorFalso.status}`);

    // 11. Un codigo de hace 3 períodos NO entra (fuera de la ventana +-1).
    const tercero = await pedir('/auth/login', jsonPost({ usuario: USUARIO_MFA, clave: CLAVE_MFA }));
    const viejo = await pedir('/auth/mfa/verify', jsonPost({
      factor_id: tercero.json?.factor_id,
      codigo: totp.codigoDePeriodo(secreto, totp.periodoDe() - 3),
    }));
    verificar('un codigo de hace 3 periodos → 401', viejo.status === 401, `HTTP ${viejo.status}`);

    // 12. Codigo de recuperacion: entra, y usarlo dos veces no.
    const cuarto = await pedir('/auth/login', jsonPost({ usuario: USUARIO_MFA, clave: CLAVE_MFA }));
    const recuperacion = (activar.json?.codigos ?? [])[0];
    const conRecuperacion = await pedir('/auth/mfa/verify',
      jsonPost({ factor_id: cuarto.json?.factor_id, codigo: recuperacion }));
    verificar('un codigo de recuperacion completa el login',
      conRecuperacion.status === 200 && esCookie(conRecuperacion), `HTTP ${conRecuperacion.status}`);
    const sidRecuperacion = cookieNueva(conRecuperacion);
    if (sidRecuperacion) sidsAbiertos.push(sidRecuperacion);

    const quinto = await pedir('/auth/login', jsonPost({ usuario: USUARIO_MFA, clave: CLAVE_MFA }));
    const reusoRecuperacion = await pedir('/auth/mfa/verify',
      jsonPost({ factor_id: quinto.json?.factor_id, codigo: recuperacion }));
    verificar('reusar un codigo de recuperacion → 401', reusoRecuperacion.status === 401,
      `HTTP ${reusoRecuperacion.status}`);

    // 13. `/me/mfa` del propio usuario: estado y codigos que quedan.
    const estadoPropio = await pedir('/me/mfa',
      sidRecuperacion ? cookieDe(sidRecuperacion) : {});
    verificar('GET /me/mfa → estado on con 9 codigos',
      estadoPropio.json?.estado === 'on' && estadoPropio.json?.codigos_restantes === 9,
      `${estadoPropio.json?.codigos_restantes ?? '-'} codigos`);
    verificar('el listado del panel NO trae el secret cifrado',
      !(JSON.stringify(activar.json ?? {}).includes('mfa_secret_cifrada')));

    // 14. El panel regenera los codigos: los anteriores dejan de servir.
    const regenerar = await pedir(`/admin/usuarios/${dePrueba.idusuario}/mfa/codigos`,
      jsonPost({}, { ...cookieAdmin }));
    verificar('el panel regenera los codigos → 10 nuevos',
      regenerar.status === 200 && regenerar.json?.codigos?.length === 10, `HTTP ${regenerar.status}`);
    verificar('el conjunto de codigos es distinto al anterior',
      !(regenerar.json?.codigos ?? []).includes(recuperacion));
    const usadoAntes = await prisma.idn_usuario_mfa_codigo.count({
      where: { idusuario: dePrueba.idusuario, usado_en: { not: null } },
    });
    verificar('los codigos anteriores quedan marcados como usados (invalidados)',
      usadoAntes >= 10, `${usadoAntes} invalidados`);

    // 15. El panel desactiva MFA y cierra las sesiones del cliente.
    const desactivar = await pedir(`/admin/usuarios/${dePrueba.idusuario}/mfa`,
      { method: 'DELETE', ...cookieAdmin });
    verificar('el panel desactiva MFA y cierra las sesiones',
      desactivar.status === 200 && desactivar.json?.estado === 'off' &&
        desactivar.json?.sesiones_cerradas >= 1,
      `HTTP ${desactivar.status} sesiones=${desactivar.json?.sesiones_cerradas ?? '-'}`);
    const filaDespues = await prisma.idn_usuario.findUnique({
      where: { idusuario: dePrueba.idusuario },
      select: { mfa_estado: true, mfa_secret_cifrada: true },
    });
    verificar('al desactivar, el secret se borra y el estado vuelve a off',
      filaDespues?.mfa_estado === 'off' && filaDespues?.mfa_secret_cifrada === null);

    // 16. Volver a entrar es de un paso otra vez.
    const loginFinal = await pedir('/auth/login', jsonPost({ usuario: USUARIO_MFA, clave: CLAVE_MFA }));
    verificar('tras desactivar, el login vuelve a ser de un paso',
      loginFinal.status === 200 && !loginFinal.json?.requiere_mfa && esCookie(loginFinal));
    const sidFinal = cookieNueva(loginFinal);
    if (sidFinal) sidsAbiertos.push(sidFinal);

    // 17. La clave incorrecta sigue sin decir si el usuario existe.
    const claveMala = await pedir('/auth/login',
      jsonPost({ usuario: USUARIO_MFA, clave: 'otra-clave-que-no-es' }));
    verificar('clave incorrecta con MFA activo → 401 antes de pedir el factor',
      claveMala.status === 401 && claveMala.json?.codigo === 'clave_incorrecta' &&
        !claveMala.json?.requiere_mfa,
      `HTTP ${claveMala.status}`);

    // --- Inventario de aplicaciones (9.4) --------------------------------------

    seccion('Registro para el TenantRegistry: /registry/aplicaciones (Fase 09 §9.4)');

    const apps = await pedir(`/registry/aplicaciones/${CLIENTE}`, { ...cookieAdmin });
    verificar(`/registry/aplicaciones/${CLIENTE} → 200 para el admin del cliente`,
      apps.status === 200 && Array.isArray(apps.json?.aplicaciones),
      `HTTP ${apps.status} ${apps.json?.total ?? 0} app(s)`);
    // Se miran las CLAVES de cada objeto, no el texto de la respuesta: un
    // `/host/i` sobre el JSON marca "localhost" dentro de `url_inicio` y hace
    // fallar la comprobacion con un falso positivo, que es peor que no
    // comprobar. Lo que se verifica es que no exista ninguna clave prohibida.
    const clavesProhibidas = ['usuario', 'credencial_cifrada', 'credencial', 'host', 'esquema'];
    const claves = [];
    const juntar = (v) => {
      if (Array.isArray(v)) return v.forEach(juntar);
      if (v && typeof v === 'object') {
        for (const [k, valor] of Object.entries(v)) {
          claves.push(k);
          juntar(valor);
        }
      }
    };
    juntar(apps.json ?? {});
    const filtradas = claves.filter((k) => clavesProhibidas.includes(k));
    verificar('la respuesta NO trae usuario, host ni credencial (por nombre de clave)',
      filtradas.length === 0, filtradas.length ? filtradas.join(',') : `${claves.length} clave(s): ${[...new Set(claves)].join(',')}`);
    verificar('cada app trae codigo, nombre, url_inicio, estado y base',
      (apps.json?.aplicaciones ?? []).every((a) =>
        'codigo' in a && 'nombre' in a && 'url_inicio' in a && 'estado' in a && 'base' in a));

    const appsAjenas = await pedir(`/registry/aplicaciones/${OTRO_CLIENTE}`, { ...cookieAdmin });
    verificar(`un admin de ${CLIENTE} NO lee /registry/aplicaciones/${OTRO_CLIENTE}`,
      appsAjenas.status === 403 && appsAjenas.json?.codigo === 'sin_permiso',
      `HTTP ${appsAjenas.status}`);

    const appsSinSesion = await pedir(`/registry/aplicaciones/${CLIENTE}`);
    verificar('/registry/aplicaciones sin cookie → 401',
      appsSinSesion.status === 401 && appsSinSesion.json?.codigo === 'sesion_requerida',
      `HTTP ${appsSinSesion.status}`);

    // --- La rotacion apagada por default (9.2) ---------------------------------

    seccion('Rotacion de claves: apagada por default (Fase 09 §9.2)');

    const rotacion = await pedir('/operacion/claves', { ...cookieAdmin });
    verificar('GET /operacion/claves sin TQ_ROTACION_HABILITADA → 404 (no 403)',
      rotacion.status === 404, `HTTP ${rotacion.status}`);
    const rotar = await pedir('/operacion/claves/rotar', jsonPost({}, { ...cookieAdmin }));
    verificar('POST /operacion/claves/rotar apagado → 404', rotar.status === 404, `HTTP ${rotar.status}`);
    const rotarConBody = await pedir('/operacion/claves/reactivar',
      jsonPost({ kid: '0123456789abcdef' }, { ...cookieAdmin }));
    verificar('POST /operacion/claves/reactivar apagado → 404', rotarConBody.status === 404,
      `HTTP ${rotarConBody.status}`);
    const rotarSinSesion = await pedir('/operacion/claves');
    verificar('GET /operacion/claves sin sesion → 404 tambien (el guard va primero)',
      rotarSinSesion.status === 404, `HTTP ${rotarSinSesion.status}`);
  } finally {
    for (const sid of [...sidsAbiertos, sidAdmin].filter(Boolean)) {
      await sesionesSvc.cerrar(sid, 'logout').catch(() => {});
    }
    await prisma.tok_mfa_challenge.deleteMany({ where: { idusuario: dePrueba.idusuario } }).catch(() => {});
    await prisma.idn_usuario_mfa_codigo.deleteMany({ where: { idusuario: dePrueba.idusuario } }).catch(() => {});
    await limpiarUsuarioDePrueba(dePrueba.idusuario);
    await limpiarUsuarioDePrueba(adminDePrueba.idusuario);
    nota('usuarios de prueba de MFA borrados');
  }
}

// La corrida arranca ACA, al final del archivo y no arriba: las ayudantes son
// `const` y estarian en zona muerta si `ejecutar` se llamara antes de que el modulo
// los haya evaluado.
try {
  await ejecutar();
  console.log('\n  ' + '-'.repeat(68) + '\n');
  console.log(
    fallos === 0
      ? '  TODO OK: los criterios de aceptacion de las Fases 07, 08 y 09 pasan.\n'
      : `  ${fallos} COMPROBACION(ES) FALLIDA(S)\n`,
  );
  process.exit(fallos === 0 ? 0 : 1);
} catch (error) {
  await prisma.$disconnect().catch(() => {});
  console.error(`\n  ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
