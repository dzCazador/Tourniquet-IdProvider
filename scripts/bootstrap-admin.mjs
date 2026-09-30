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
import { cargar, prepararEntorno } from './lib/entorno.mjs';
import { fallo, parsearFlags, preguntarSecreto, preguntarTexto } from './lib/consola.mjs';

const { PrismaService } = cargar('prisma/prisma.service.js');
const { FirmaService } = cargar('claves/firma.service.js');
const { MasterKeyService } = cargar('claves/master-key.service.js');
const { IdentidadService } = cargar('auth/identidad.service.js');
const { AuditoriaService } = cargar('auth/auditoria.service.js');
const { RateLimitService } = cargar('auth/rate-limit.service.js');
const { validarPoliticaClave } = cargar('auth/politica-clave.js');

// --- flags ----------------------------------------------------------------------
// El parseo vive en `lib/consola.mjs` desde la Fase 05: estaba aca porque era
// el unico script con flags, y duplicarlo en `alta-usuario.mjs` y
// `registrar-base.mjs` era copiar tambien la forma en que se rompe.

const USO = '      npm run bootstrap:admin -- --usuario admin --nombre "Ana" --apellido "Perez"';
const flags = parsearFlags(process.argv.slice(2), ['usuario', 'nombre', 'apellido'], USO);

console.log('\n  Tourniquet - bootstrap de administrador\n');
console.log('  ' + '-'.repeat(64) + '\n');

/** Para poder cerrar la conexion desde el catch, que vive fuera de `ejecutar`. */
let prismaInstancia = null;

try {
  await ejecutar();
} catch (error) {
  await prismaInstancia?.$disconnect?.().catch(() => {});
  fallo(error, 'crear el administrador');
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
