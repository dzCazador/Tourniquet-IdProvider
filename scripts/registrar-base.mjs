#!/usr/bin/env node
/**
 * Registra la credencial de una base de negocio ya inventariada.
 *
 *   1. Verifica `TQ_MASTER_KEY` (sin ella no se puede escribir nada cifrado).
 *   2. Cifra la contrasena con AES-256-GCM y escribe `usuario` +
 *      `credencial_cifrada` en `cat_base_datos`.
 *
 * **Por que esto es un script y no un `.sql`**: `credencial_cifrada` es
 * `iv(12)||tag(16)||ciphertext` con IV **aleatorio por registro**
 * (`specs/01` §6). No se puede escribir en un archivo versionado: un IV fijo
 * reutilizado con GCM rompe la confidencialidad por completo, y `.gitignore` no
 * protege un archivo ya commiteado.
 *
 * **Por que no hay endpoint HTTP**: la contrasena de una base de negocio entra,
 * se cifra y no sale. Un endpoint que la acepta por POST la expone a cualquier
 * red y a todo log del camino. El que puede correr este script ya tiene el
 * archivo de la base y la master key: ya gano.
 *
 * Idempotente en cuanto al resultado: correrlo dos veces deja la misma
 * credencial. Los BYTES son distintos cada vez, y eso es lo correcto -- el IV
 * tiene que ser aleatorio por escritura.
 *
 * Uso:
 *   npm run registrar:base -- --listar
 *   npm run registrar:base -- --codigo ARG_RHPro_Marcelino --usuario rhpro_app
 *   npm run registrar:base -- --codigo ARG_RHPro_Marcelino --verificar
 */
import { cargar, prepararEntorno } from './lib/entorno.mjs';
import { fallo, parsearFlags, preguntarSecreto, preguntarTexto } from './lib/consola.mjs';

const { PrismaService } = cargar('prisma/prisma.service.js');
const { MasterKeyService } = cargar('claves/master-key.service.js');
const { BdDatosService, SIN_REGISTRAR } = cargar('registro/bd-datos.service.js');

const USO = [
  '      npm run registrar:base -- --listar',
  '      npm run registrar:base -- --codigo ARG_RHPro_Marcelino --usuario rhpro_app',
  '      npm run registrar:base -- --codigo ARG_RHPro_Marcelino --verificar',
].join('\n');

const flags = parsearFlags(process.argv.slice(2), ['codigo', 'usuario'], USO);

console.log('\n  Tourniquet - registro de credencial de base\n');
console.log('  ' + '-'.repeat(64) + '\n');

let prismaInstancia = null;

try {
  await ejecutar();
} catch (error) {
  await prismaInstancia?.$disconnect?.().catch(() => {});
  fallo(error, 'registrar la credencial de la base');
}

async function ejecutar() {
  // El mismo esquema de Joi que usa la app: si el `.env` esta incompleto, el
  // mensaje es identico al que daria `npm start`.
  const { entorno, configService } = prepararEntorno();
  const masterKey = new MasterKeyService(configService);

  prismaInstancia = new PrismaService(entorno.DATABASE_URL);
  const bd = new BdDatosService(prismaInstancia, masterKey);

  // --listar: inventario completo del despliegue, con un SI/NO por base en vez
  // del valor. Es seguro mostrar y exportar: el tamano del binario ya dice si
  // hay material cifrado, asi que el SI/NO no agrega nada.
  if (flags.listar) {
    await listar(bd);
    return;
  }

  // El codigo se pide si no vino por flag: la base se elige de una lista corta
  // y equivocarse de `codigo` cifraba la contrasena de la base equivocada.
  const codigo = flags.codigo || (await preguntarTexto('Codigo de la base'));
  if (!codigo) {
    console.error('\n  Falta el codigo de la base. Ver el inventario con --listar.\n');
    await prismaInstancia.$disconnect();
    process.exit(1);
  }

  const actual = await prismaInstancia.cat_base_datos.findUnique({
    where: { codigo },
    select: { codigo: true, idcliente: true, idaplicacion: true, host: true, base: true },
  });
  if (!actual) {
    console.error(`\n  La base "${codigo}" no esta en el inventario de cat_base_datos.`);
    console.error('  Correr antes 90-semilla-catalogo.sql, o el SQL de la instalacion.\n');
    await prismaInstancia.$disconnect();
    process.exit(1);
  }

  console.log('');
  console.log(`  Base:    ${actual.codigo}  (cliente=${actual.idcliente} app=${actual.idaplicacion})`);
  console.log(`  Servidor: ${actual.host}`);
  console.log(`  Base:     ${actual.base}\n`);

  if (flags.verificar) {
    await verificar(bd, actual.codigo);
    return;
  }

  await registrar(bd, actual, flags.usuario);
}

async function listar(bd) {
  const clientes = await prismaInstancia.cat_cliente.findMany({
    where: { estado: 'activo' },
    select: { codigo: true },
    orderBy: { codigo: 'asc' },
  });

  for (const cliente of clientes) {
    const bases = await bd.inventario(cliente.codigo);
    if (bases.length === 0) continue;

    console.log(`  ${cliente.codigo}`);
    for (const base of bases) {
      const estado = base.credencial_registrada
        ? 'CREDENCIAL OK'
        : base.engine + ' / PENDIENTE';
      console.log(
        `    ${base.codigo.padEnd(24)} ${base.host.padEnd(18)} ${base.base.padEnd(20)} ` +
          `${base.estado.padEnd(9)} ${estado}`,
      );
    }
  }

  console.log('');
  console.log('  PENDIENTE = la base existe pero no se le habla a ningun lado todavia.');
  console.log('  Registrar con:  npm run registrar:base -- --codigo <codigo>\n');

  await prismaInstancia.$disconnect();
}

async function verificar(bd, codigo) {
  console.log('  Descifrando con la master key del entorno y comparando con lo que se tipea.');
  console.log('  Ni la contrasena guardada ni la tipeada se muestran.\n');

  let guardada;
  try {
    guardada = await bd.descifrarCredencial(codigo);
  } catch (error) {
    console.error(`  ${error instanceof Error ? error.message : String(error)}`);
    await prismaInstancia.$disconnect();
    process.exit(1);
  }

  const tipeada = await preguntarSecreto('Contrasena esperada (oculta): ');
  await prismaInstancia.$disconnect();

  if (guardada === tipeada) {
    console.log('\n  [ok] La credencial guardada descifra a la contrasena esperada.\n');
    return;
  }

  console.error('\n  [error] La credencial guardada NO descifra a la contrasena esperada.\n');
  console.error('  O la master key del entorno no es la de este registro, o la fila esta');
  console.error('  corrupta, o la contrasena se rotacion sin volver a registrar.\n');
  process.exit(1);
}

async function registrar(bd, base, usuarioPorFlag) {
  const usuario =
    usuarioPorFlag || (await preguntarTexto(`Usuario de SQL Server (login para ${base.base})`));

  if (!usuario) {
    console.error('\n  Falta el usuario de la base.\n');
    await prismaInstancia.$disconnect();
    process.exit(1);
  }

  if (usuario === SIN_REGISTRAR) {
    console.error(`\n  "${SIN_REGISTRAR}" es el centinela de "todavia no registrado", no un login.`);
    console.error('  Con el, la base queda a medias: existe en el inventario pero no se le');
    console.error('  puede hablar a nadie.\n');
    await prismaInstancia.$disconnect();
    process.exit(1);
  }

  console.log('');
  const clave = await preguntarSecreto('Contrasena (oculta): ');

  if (!clave) {
    console.error('\n  Falta la contrasena.\n');
    await prismaInstancia.$disconnect();
    process.exit(1);
  }

  const actualizada = await bd.registrarCredencial(base.codigo, { usuario, clave });

  await prismaInstancia.$disconnect();

  console.log('');
  console.log(`  [ok] Credencial registrada para ${actualizada.codigo}`);
  console.log(`         usuario:  ${usuario}`);
  console.log('         contrasena: cifrada (AES-256-GCM), no se muestra');
  console.log('');
  console.log('  Para comprobar que descifra:');
  console.log(`      npm run registrar:base -- --codigo ${actualizada.codigo} --verificar`);
  console.log('');
}
