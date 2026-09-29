#!/usr/bin/env node
/**
 * Crea el primer administrador de Tourniquet y deja la clave de firma lista.
 *
 *   1. Verifica `TQ_MASTER_KEY` (sin ella no se puede escribir nada cifrado).
 *   2. Se asegura de que exista UNA clave de firma activa en `tok_clave_firma`.
 *   3. Crea el admin con argon2id y le da membresia en cada cliente activo.
 *
 * Idempotente: correrlo dos veces no duplica ni pisa nada. Si el usuario ya
 * existe avisa y sigue, porque un bootstrap re-ejecutado por error no puede
 * dejar al admin real sin su contrasena.
 *
 * La contrasena se pide por prompt con eco oculto. Como alternativa se
 * puede pasar por `TQ_BOOTSTRAP_CLAVE`, que es lo que corresponde en un
 * pipeline, pero OJO: una variable de entorno queda en el historial del shell
 * y es visible para otros procesos del usuario. El prompt no deja rastro.
 *
 * Uso:
 *   npm run bootstrap:admin
 *   npm run bootstrap:admin -- --usuario admin --nombre Ana --apellido Perez
 */
import readline from 'node:readline';
import { Writable } from 'node:stream';
import { cargar, prepararEntorno } from './lib/entorno.mjs';

const { PrismaService } = cargar('prisma/prisma.service.js');
const { FirmaService } = cargar('claves/firma.service.js');
const { MasterKeyService } = cargar('claves/master-key.service.js');
const { IdentidadService } = cargar('auth/identidad.service.js');
const { AuditoriaService } = cargar('auth/auditoria.service.js');
const { RateLimitService } = cargar('auth/rate-limit.service.js');
const { validarPoliticaClave } = cargar('auth/politica-clave.js');

// --- entrada por consola -------------------------------------------------------

/**
 * Pregunta sin eco. `readline` escribe el prompt y lo que el usuario escribe en
 * `output`; se le pasa un writable que se traga todo. Si la entrada no es
 * interactiva (pipe), no hay eco que tapar y se lee normal.
 */
function preguntarSecreto(pregunta) {
  if (!process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => rl.question(pregunta, (r) => { rl.close(); resolve(r.trim()); }));
  }
  const salidaMuda = new Writable({ write(_chunk, _enc, cb) { cb(); } });
  const rl = readline.createInterface({ input: process.stdin, output: salidaMuda, terminal: true });
  return new Promise((resolve) => {
    rl.question(pregunta, (respuesta) => { rl.close(); resolve(respuesta.trim()); });
  });
}

function preguntarTexto(pregunta, porDefecto) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const sufijo = porDefecto ? ` [${porDefecto}]` : '';
  return new Promise((resolve) => {
    rl.question(`${pregunta}${sufijo}: `, (respuesta) => {
      rl.close();
      resolve((respuesta.trim() || porDefecto || ''));
    });
  });
}

/**
 * Flags con valor obligatorio. Se declara la lista en vez de asumir que todo
 * flag trae valor, porque asumirlo produjo un bug real: `--usuario admin`
 * (con espacio) se parseaba como la flag `usuario admin` y `flags.usuario`
 * quedaba con el string `"true"`, con lo cual se creaba un usuario
 * literalmente llamado "true". Un flag sin valor tiene que ser un error, nunca
 * un valor inventado.
 */
const FLAGS_CON_VALOR = new Set(['usuario', 'nombre', 'apellido']);

function parsearFlags(argv) {
  const flags = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;

    const cuerpo = arg.slice(2);
    const igual = cuerpo.indexOf('=');

    if (igual >= 0) {
      flags[cuerpo.slice(0, igual)] = cuerpo.slice(igual + 1);
      continue;
    }

    const siguiente = argv[i + 1];
    if (FLAGS_CON_VALOR.has(cuerpo) && siguiente !== undefined && !siguiente.startsWith('--')) {
      flags[cuerpo] = siguiente;
      i++;
      continue;
    }

    console.error(`\n  El flag --${cuerpo} necesita un valor.`);
    console.error('  Uso:');
    console.error('      npm run bootstrap:admin -- --usuario admin --nombre "Ana" --apellido "Perez"');
    console.error('      (o la forma --usuario=admin)\n');
    process.exit(1);
  }

  return flags;
}

// --- cuerpo --------------------------------------------------------------------

const flags = parsearFlags(process.argv.slice(2));

console.log('\n  Tourniquet - bootstrap de administrador\n');
console.log('  ' + '-'.repeat(64) + '\n');

/**
 * Falla legible en vez del volcado de la libreria minificada de Prisma.
 *
 * No se imprime `DATABASE_URL`: puede traer usuario y clave, y una cadena de
 * conexion en un error es una credencial escrita en un log. Solo se menciona
 * el catalogo, que no es secreto y es justo lo que hay que revisar.
 */
function fallo(error) {
  const mensaje = error instanceof Error ? error.message : String(error);
  const esConexion =
    error?.constructor?.name === 'PrismaClientInitializationError' ||
    /Can't reach database server|Initialization engine error|P1001|P1002/i.test(mensaje);

  if (esConexion) {
    const catalogo = (process.env.DATABASE_URL || '').match(/database=([^;]+)/i)?.[1] ?? '(sin definir)';
    console.error('\n  No pude conectarme a la base de control.');
    console.error(`  Catalogo apunta a: ${catalogo}`);
    console.error('  Revisar que SQL Server este levantado y que .env tenga la cadena correcta.');
    console.error('  Detalle: ' + mensaje.split('\n').filter(Boolean).slice(0, 3).join(' | ') + '\n');
  } else {
    console.error(`\n  ${mensaje}\n`);
  }
  process.exit(1);
}

/** Para poder cerrar la conexion desde el catch, que vive fuera de `ejecutar`. */
let prismaInstancia = null;

try {
  await ejecutar();
} catch (error) {
  await prismaInstancia?.$disconnect?.().catch(() => {});
  fallo(error);
}

async function ejecutar() {
// 1. Entorno. El mismo esquema de Joi que usa la app: si el `.env` esta
//    incompleto, el mensaje es identico al que daria `npm start`.
const { entorno, configService } = prepararEntorno();
const masterKey = new MasterKeyService(configService);

// La URL se pasa explicita: el script no depende de que ningun  se
// cargue por su cuenta (ver PrismaService).
prismaInstancia = new PrismaService(entorno.DATABASE_URL);
const firma = new FirmaService(prismaInstancia, masterKey);
const auditoria = new AuditoriaService(prismaInstancia);
const limite = new RateLimitService();
limite.onModuleDestroy();
const identidad = new IdentidadService(prismaInstancia, auditoria, limite);

// 2. Clave de firma. Idempotente: si ya hay una activa, se respeta y no se
//    genera otra (generar una nueva invalidaria los tokens ya emitidos).
const kidExistente = await firma.asegurarActiva();
console.log(`  [ok] Clave de firma activa: kid=${kidExistente}`);

// 3. Datos del admin.
const usuario = flags.usuario || (await preguntarTexto('Usuario (login)'));
const nombre = flags.nombre || (await preguntarTexto('Nombre'));
const apellido = flags.apellido || (await preguntarTexto('Apellido'));

if (!usuario || !nombre || !apellido) {
  console.error('\n  Faltan datos obligatorios (usuario, nombre, apellido).\n');
  await prismaInstancia.$disconnect();
  process.exit(1);
}

let clave = process.env.TQ_BOOTSTRAP_CLAVE;
if (!clave) {
  console.log('');
  clave = await preguntarSecreto('Contrasena (oculta, minimo 10 caracteres): ');
} else {
  console.log('\n  Contrasena tomada de TQ_BOOTSTRAP_CLAVE.');
}

// No se hace eco de la contrasena en ningun momento: ni al pedirla, ni al
// fallar la politica, ni al hashing.
const politica = validarPoliticaClave(clave, { usuario });
if (!politica.valida) {
  console.error('\n  La contrasena no cumple la politica minima:');
  for (const motivo of politica.motivos) {
    console.error(`    - ${motivo}`);
  }
  console.error('');
  await prismaInstancia.$disconnect();
  process.exit(1);
}

// 4. Alta. Idempotente: no pisa un usuario existente.
const { idusuario, creado } = await identidad.crearAdmin({
  usuario,
  nombre,
  apellido,
  clave,
});

if (!creado) {
  console.log(`\n  [aviso] El usuario "${usuario}" ya existia: no se modifico nada.`);
  console.log('          Para cambiar la contrasena, usar el recupero de administrador (Fase 08).');
} else {
  console.log(`\n  [ok] Administrador creado: ${usuario}`);
}

// 5. Membresia en cada cliente activo. Necesaria para que el portal lo vea.
const membresias = await identidad.crearMembresias(idusuario, 'admin_identidad');
const clientes = await prismaInstancia.cat_cliente.findMany({
  where: { estado: 'activo' },
  select: { codigo: true, nombre: true },
});
console.log(`  [ok] Membresias: ${membresias} nueva(s) sobre ${clientes.length} cliente(s) activo(s)`);
for (const cliente of clientes) {
  console.log(`        - ${cliente.codigo}  ${cliente.nombre}`);
}

// 5.b Habilitacion de ingreso por app. El authorize la exige (Fase 03), asi que
//      un admin sin estas filas puede loguearse al portal pero no entrar a
//      ninguna app: es exactamente el estado en el que un administrador no
//      puede hacer su trabajo.
const habilitaciones = await identidad.crearHabilitaciones(idusuario);
const apps = await prismaInstancia.cat_aplicacion.findMany({
  where: { estado: 'activo' },
  select: { codigo: true },
  orderBy: { codigo: 'asc' },
});
console.log(
  `  [ok] Habilitaciones: ${habilitaciones} nueva(s). El admin entra a las apps ` +
    `de todos sus clientes: ${apps.map((a) => a.codigo).join(', ')}`,
);

await prismaInstancia.$disconnect();

// El idusuario es el `sub`/`idp_sub` que las apps van a usar en la Fase 06. Se
// imprime completo porque sin el no hay forma de enlazar el portal con la base
// de negocio: no es un secreto.
console.log('\n' + '-'.repeat(64));
console.log('');
console.log('  idusuario (usar como idp_sub / sub en la Fase 06):');
console.log('');
console.log(`      ${idusuario}`);
console.log('');
console.log('  ' + '-'.repeat(64) + '\n');
}
