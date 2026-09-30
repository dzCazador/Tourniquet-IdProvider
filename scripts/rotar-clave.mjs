#!/usr/bin/env node
/**
 * Rotación (y rollback) de la clave de firma por consola.
 *
 * Es el **procedimiento del runbook** (`deploy/runbooks/rotacion-claves.md`),
 * no un script auxiliary: `POST /operacion/claves/rotar` existe para el drill y
 * para automatizar, y está apagado por default (`TQ_ROTACION_HABILITADA=false`).
 * Un script que corre con el `.env` en la mano no necesita ni bandera ni sesión
 * de portal, y por eso es el camino que va al runbook de producción.
 *
 *   npm run rotar:clave                 # estado de las claves (no cambia nada)
 *   npm run rotar:clave -- --rotar      # genera y activa una clave nueva
 *   npm run rotar:clave -- --reactivar abc123def4567890
 *
 * --rotar pide confirmación escribiendo ROTAR, salvo que venga `--si`.
 * Sin confirmación, un `npm run rotar:clave -- --rotar` con el flag equivocado
 * en un script de despliegue firmaría todo con una clave que nadie más conoce
 * todavía: es reversible en 24 h, pero los 15 minutos de tokens emitidos con la
 * clave vieja se caen igual.
 */
import { cargar, prepararEntorno } from './lib/entorno.mjs';
import { fallo, parsearFlags, preguntarTexto } from './lib/consola.mjs';

const { PrismaService } = cargar('prisma/prisma.service.js');
const { FirmaService, DIAS_ROTACION } = cargar('claves/firma.service.js');
const { MasterKeyService } = cargar('claves/master-key.service.js');
const { VENTANA_JWKS_MS } = cargar('claves/firma.service.js');

const USO = `
  Uso: npm run rotar:clave -- [--rotar | --reactivar <kid> | --si]

    (sin flags)      Muestra el estado de las claves. No cambia nada.
    --rotar          Genera una clave nueva, la activa y retira la anterior
                     (que sigue en el JWKS 24 h, specs/01 §5).
    --reactivar KID  Reactiva una clave ya retirada: es el ROLLBACK.
    --si             No pide confirmación (para pipelines).
`.trim();

const flags = parsearFlags(process.argv.slice(2), ['reactivar'], USO);

/** Para poder cerrar la conexión desde el catch, que vive fuera de `ejecutar`. */
let prismaInstancia = null;

try {
  await ejecutar();
} catch (error) {
  await prismaInstancia?.$disconnect?.().catch(() => {});
  fallo(error, flags.reactivar ? 'reactivar la clave' : 'rotar la clave');
}

async function ejecutar() {
  const { entorno, configService } = prepararEntorno();
  const masterKey = new MasterKeyService(configService);
  const vidaAccess = entorno.ACCESS_TTL_MIN;

  prismaInstancia = new PrismaService(entorno.DATABASE_URL);
  const firma = new FirmaService(prismaInstancia, masterKey);

  console.log('\n  Rotacion de clave de firma\n');
  console.log('  ' + '-'.repeat(64) + '\n');

  if (flags.reactivar) {
    const kid = String(flags.reactivar).trim().toLowerCase();

    if (!/^[0-9a-f]{16}$/.test(kid)) {
      console.error(`\n  "${kid}" no parece un kid: son 16 hexadecimales (specs/01 §5).`);
      console.error('  El kid se ve en el /.well-known/jwks.json o en el header del token.\n');
      process.exit(1);
    }

    if (!flags.si) {
      const respuesta = await preguntarTexto(
        `  Reactivar el kid ${kid} (deja de firmar con la clave actual). Escriba REACTIVAR:`,
        '',
      );
      if (respuesta.trim().toUpperCase() !== 'REACTIVAR') {
        console.log('\n  Cancelado. No se toco ninguna clave.\n');
        await prismaInstancia.$disconnect();
        process.exit(0);
      }
    }

    const reactivado = await firma.reactivar(kid);
    console.log(`\n  kid activa ahora: ${reactivado}`);
    console.log('  La clave anterior quedo en el JWKS 24 h. Entrar de verdad en una app para');
    console.log('  verificar (paso 5 del runbook) antes de cerrar esto.\n');
    await imprimirEstado(firma, vidaAccess);
    await prismaInstancia.$disconnect();
    process.exit(0);
  }

  await imprimirEstado(firma, vidaAccess);

  if (!flags.rotar) {
    console.log('  Para rotar:  npm run rotar:clave -- --rotar');
    console.log('  Runbook:     deploy/runbooks/rotacion-claves.md\n');
    await prismaInstancia.$disconnect();
    process.exit(0);
  }

  if (!flags.si) {
    const respuesta = await preguntarTexto('\n  Rotar ahora. Escriba ROTAR:', '');
    if (respuesta.trim().toUpperCase() !== 'ROTAR') {
      console.log('\n  Cancelado. No se toco ninguna clave.\n');
      await prismaInstancia.$disconnect();
      process.exit(0);
    }
  }

  const antes = await firma.estado(vidaAccess);
  const nuevo = await firma.activarNueva();
  const despues = await firma.estado(vidaAccess);

  console.log(`\n  kid anterior: ${antes.kid_activa ?? '(ninguna)'}`);
  console.log(`  kid nueva   : ${nuevo}`);
  console.log(`  ventana de solapamiento: ${VENTANA_JWKS_MS / 3_600_000} h en el JWKS\n`);

  console.log('  Los 5 pasos del runbook (deploy/runbooks/rotacion-claves.md):');
  console.log('    1. Verificar /.well-known/jwks.json: aparecen las DOS claves.');
  console.log('    2. Verificar que el token nuevo lleva el kid nuevo.');
  console.log('    3. Entrar de verdad en una app con este TQ_ISSUER.');
  console.log('    4. Esperar 24 h (o hasta que la app haya refrescado el JWKS).');
  console.log(`    5. npm run verificar:rotacion -- --token <access> : confirmar el estado.\n`);
  console.log(`  Kid activa segun la base: ${despues.kid_activa}`);
  console.log(`  Proxima rotacion por politica (${DIAS_ROTACION} dias): ${despues.vence_en}\n`);

  await prismaInstancia.$disconnect();
  process.exit(0);
}

/** El estado, con la misma forma que devuelve `FirmaService.estado`. */
async function imprimirEstado(firma, vidaAccess) {
  const estado = await firma.estado(vidaAccess);
  const jwks = await firma.jwks();

  console.log(`  kid activa  : ${estado.kid_activa ?? '(ninguna)'}`);
  console.log(`  creada      : ${estado.creada_en ?? '-'}`);
  console.log(
    `  edad        : ${estado.dias_activa ?? '-'} dias (rotacion por politica: ${DIAS_ROTACION})`,
  );
  console.log(`  vence       : ${estado.vence_en ?? '-'}`);
  console.log(`  claves en el JWKS ahora: ${jwks.keys.length}\n`);

  console.log('  kid          activa  creada                 retirada               en JWKS  en vuelo');
  for (const clave of estado.claves) {
    console.log(
      `  ${clave.kid}  ${clave.activa ? 'si     ' : 'no      '} ` +
        `${clave.creada_en}  ${(clave.retirada_en ?? '-').padEnd(23)} ` +
        `${clave.en_jwks ? 'si' : 'no '}       ${clave.tokens_en_vuelo ?? '?'}`,
    );
  }

  if (estado.dias_activa !== null && estado.dias_activa > DIAS_ROTACION) {
    console.log(
      `\n  AVISO: la clave activa tiene ${estado.dias_activa} dias y la politica son ` +
        `${DIAS_ROTACION} (specs/01 §5).`,
    );
  }
}
