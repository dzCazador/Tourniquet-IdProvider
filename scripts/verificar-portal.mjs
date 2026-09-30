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
const { entorno } = prepararEntorno();
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

  const alta = await pedir('/admin/usuarios', jsonPost({
    usuario: nuevoUsuario,
    nombre: 'Alta',
    apellido: 'De Prueba',
    email: `${nuevoUsuario}@ejemplo.invalid`,
    aplicaciones: [APP],
    claveTemporal: true,
  }, admin));
  verificar('alta de usuario → 200', alta.status === 200, `HTTP ${alta.status} ${alta.json?.codigo ?? ''}`);
  const claveTemporal = alta.json?.clave_temporal ?? null;
  verificar('el alta devuelve la clave temporal UNA vez',
    typeof claveTemporal === 'string' && claveTemporal.length >= 16,
    claveTemporal ? `${claveTemporal.length} caracteres` : '(vacia)');

  const filaAlta = await prisma.idn_usuario.findUnique({
    where: { usuario: nuevoUsuario },
    select: {
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

  const motivoInvalido = await pedir(`/admin/sesiones/${victima.sid}`, jsonPost({ motivo: 'porque-si' }, admin));
  verificar('cierre forzado con un motivo fuera de la lista → 400',
    motivoInvalido.status === 400, `HTTP ${motivoInvalido.status}`);

  const cierreForzado = await pedir(`/admin/sesiones/${victima.sid}`, jsonPost({ motivo: 'sospecha' }, admin));
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
  const stranger = await pedir(`/admin/sesiones/${strangerSid}`, jsonPost({ motivo: 'soporte' }, admin));
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
  verificar('el user_agent viene resumido, no la cadena cruda',
    eventos.every((e) => typeof e.navegador === 'string'),
    eventos[0]?.navegador ?? '');

  // Travesia: un login fallido de un usuario de OTRO tenant no puede aparecer.
  const ajenoOtro = await prisma.idn_usuario.findFirst({
    where: { idusuario: { notIn: [usuario.idusuario, ajeno.idusuario] } },
    select: { idusuario: true },
  });
  if (ajenoOtro) {
    await prisma.aud_login.create({
      data: {
        resultado: 'claves',
        idusuario: ajenoOtro.idusuario,
        idaplicacion: null,
        ip: '203.0.113.7',
        user_agent: 'verificar-portal',
        detalle: 'clave_incorrecta',
      },
    });
    const tras = await pedir(`/admin/auditoria?resultado=claves`, admin);
    const intrusion = (tras.json?.eventos ?? []).filter((e) => e.ip === '203.0.113.7');
    verificar('un login fallido de un usuario de OTRO tenant NO aparece en la auditoria',
      intrusion.length === 0, `${intrusion.length} intruso(s) de ${eventos.length} eventos`);
  } else {
    nota('No hay un tercer usuario en la base: el cruce de auditoria no se pudo probar.');
  }

  const resumen = await pedir('/admin/resumen', admin);
  verificar('/admin/resumen responde 200 con conteos del tenant',
    resumen.status === 200 && typeof resumen.json?.usuarios === 'number' && resumen.json.usuarios > 0,
    `usuarios=${resumen.json?.usuarios} sesiones=${resumen.json?.sesiones_abiertas}`);
  verificar('/admin/resumen NO cuenta usuarios de otro tenant',
    (await prisma.idn_usuario_cliente.count({ where: { idcliente: CLIENTE } })) === resumen.json?.usuarios,
    'conteo = membresias del tenant');

  // Limpieza de la alta de prueba: se desactiva en vez de borrar, igual que el
  // panel. El borrado fisico lo hace el operador si quiere (no hay endpoint).
  nota(`El usuario de prueba "${nuevoUsuario}" quedo INACTIVO en la base (limpiar a mano).`);
  await prisma.idn_usuario.update({
    where: { usuario: nuevoUsuario },
    data: { estado: 'inactivo' },
  });
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

// La corrida arranca ACA, al final del archivo y no arriba: las ayudantes son
// `const` y estarian en zona muerta si `ejecutar` se llamara antes de que el modulo
// los haya evaluado.
try {
  await ejecutar();
  console.log('\n  ' + '-'.repeat(68) + '\n');
  console.log(
    fallos === 0
      ? '  TODO OK: los criterios de aceptacion de las Fases 07 y 08 pasan.\n'
      : `  ${fallos} COMPROBACION(ES) FALLIDA(S)\n`,
  );
  process.exit(fallos === 0 ? 0 : 1);
} catch (error) {
  await prisma.$disconnect().catch(() => {});
  console.error(`\n  ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
