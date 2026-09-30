#!/usr/bin/env node
/**
 * Recupera el acceso a un usuario cambiando su clave.
 *
 * Cubre el hueco que el propio bootstrap admite: "para cambiar la contrasena,
 * usar el recupero de administrador (Fase 08)", que todavia no existe. Es la
 * version minima de ese recupero para un operador con acceso al servidor: no
 * hay correo de restablecimiento, no hay self-service, y no debe haberlos hasta
 * que la Fase 08 thoughtfully disene eso con un flujo auditado.
 *
 * QUE HACE, Y POR QUE CADA COSA
 *
 *   - **Pide la clave con eco oculto.** El unico momento en que la contrasena
 *     existe fuera de la cabeza del operador. Si se pasa por variable de
 *     entorno queda en el historial del shell y la pueden leer otros procesos
 *     del mismo usuario, que es justo lo que `.env.example` advierte de
 *     `TQ_BOOTSTRAP_CLAVE`.
 *   - **Valida la politica minima** (`specs/01` §4) con el MISMO codigo que el
 *     alta: una clave que el bootstrap no habria aceptado tampoco se escribe
 *     por esta via.
 *   - **Limpia el bloqueo.** Un usuario que se olvido la clave suele haber
 *     quemado los 5 intentos y estar bloqueado 15 min. Sin limpiar el
 *     contador, la clave nueva seria correcta y el login seguiria fallando
 *     con "bloqueada", que es la peor forma de no explicar un problema: el
 *     operador cree que el script fallo.
 *   - **Cierra las sesiones vivas de ese usuario, en todos los clientes.** Es
 *     lo que distingue un cambio de clave de una concession: si alguien esta
 *     operando con un token de esa cuenta, cambiarle la clave y dejarlo
 *     adentro hasta que expire el refresh (7 dias) no cambio nada. La sesion se
 *     CIERRA (`cerrada_en`), nunca se borra: `tok_sesion` es append-only con
 *     revocacion (invariante de `AGENTS.md`).
 *   - **Rehashea con argon2id** a traves de `password.service`, nunca con algo
 *     propio: los parametros (`m=64MB, t=3, p=4`) y el formato PHC tienen que
 *     ser los mismos que usa el login, o `verificarHash` no los reconoce.
 *
 * QUE NO HACE, POR DISEÑO
 *
 *   - **No es un endpoint HTTP.** No hay ruta en `tq-api` que lo dispare: quien
 *     puede correr esto ya tiene el archivo de la base y la master key, o sea
 *     que ya gano. Un endpoint seria una puerta de recuperacion expuesta sin
 *     factor de recuperacion, que es peor que no tener puerta.
 *   - **No audita en `aud_login`.** No hay sesion ni `ip`/`user_agent` que
 *     registrar: no vino de un login. Se deja el rastro en el log del proceso
 *     y en la fila del usuario.
 *   - **No habilita ni deshabilita el usuario.** No es de eso: si la cuenta
 *     esta dada de baja, el camino es otro (y hoy no hay otro; ver la Fase 08).
 *
 * Uso:
 *   npm run resetear:clave
 *   npm run resetear:clave -- --usuario admin
 *   npm run resetear:clave -- --usuario admin --listar
 */
import readline from 'node:readline';
import { Writable } from 'node:stream';
import { cargar, prepararEntorno } from './lib/entorno.mjs';

const { PrismaService } = cargar('prisma/prisma.service.js');
const { SesionService } = cargar('oidc/sesion.service.js');
const { hashear } = cargar('auth/password.service.js');
const { validarPoliticaClave, normalizarUsuario } = cargar('auth/politica-clave.js');

/** Solo para pipelines; el prompt es lo preferible (ver cabecera). */
const CLAVE_POR_ENTORNO = 'TQ_RESETEAR_CLAVE';

// --- entrada por consola -------------------------------------------------------

/**
 * Pregunta sin eco. `readline` escribe el prompt en `output` y lo que el
 * usuario teclea tambien; se le pasa un writable que se traga lo tecleado y
 * deja pasar el prompt.
 */
function preguntarSecreto(pregunta) {
  if (!process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((r) => rl.question(pregunta, (res) => {
      rl.close();
      r(res.trim());
    }));
  }
  const mudo = new Writable({
    write(_c, _e, cb) {
      cb();
    },
  });
  const rl = readline.createInterface({ input: process.stdin, output: mudo, terminal: true });
  return new Promise((r) => {
    rl.question(pregunta, (res) => {
      rl.close();
      r(res.trim());
    });
  });
}

function preguntarTexto(pregunta) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((r) => {
    rl.question(`${pregunta}: `, (res) => {
      rl.close();
      r(res.trim());
    });
  });
}

// --- flags ---------------------------------------------------------------------

/**
 * Flags que necesitan valor. Se declara la lista en vez de asumirlo, por la
 * misma razon que en `bootstrap-admin.mjs`: asumir que `--usuario admin` trae
 * valor produjo un usuario llamado literalmente "true".
 */
const CON_VALOR = new Set(['usuario']);

function parsearFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const nombre = arg.slice(2);
    const igual = nombre.indexOf('=');
    if (igual >= 0) {
      flags[nombre.slice(0, igual)] = nombre.slice(igual + 1);
      continue;
    }
    if (CON_VALOR.has(nombre)) {
      const siguiente = argv[i + 1];
      if (siguiente !== undefined && !siguiente.startsWith('--')) {
        flags[nombre] = siguiente;
        i++;
        continue;
      }
    }
    flags[nombre] = true;
  }
  return flags;
}

// --- cuerpo ---------------------------------------------------------------------

const flags = parsearFlags(process.argv.slice(2));

let prisma = null;

try {
  await ejecutar();
} catch (error) {
  await prisma?.$disconnect?.().catch(() => {});
  // Igual que el bootstrap: no se vuelca `DATABASE_URL` ni el error crudo de
  // Prisma, que puede traer la cadena de conexion.
  const mensaje = error instanceof Error ? error.message : String(error);
  console.error(`\n  ${mensaje}\n`);
  process.exit(1);
}

async function listar() {
  const usuarios = await prisma.idn_usuario.findMany({
    orderBy: { usuario: 'asc' },
    select: {
      usuario: true,
      nombre: true,
      apellido: true,
      estado: true,
      intentos_fallidos: true,
      bloqueado_hasta: true,
    },
  });

  console.log('');
  console.log('  usuario        nombre           estado   intentos  bloqueado');
  console.log('  ' + '-'.repeat(64));
  for (const u of usuarios) {
    const bloqueado =
      u.bloqueado_hasta && u.bloqueado_hasta > new Date()
        ? 'si, hasta ' + u.bloqueado_hasta.toISOString().replace('T', ' ').slice(0, 16)
        : 'no';
    console.log(
      `  ${u.usuario.padEnd(14)} ${(u.nombre + ' ' + u.apellido).trim().padEnd(17)} ` +
        `${String(u.estado).padEnd(8)} ${String(u.intentos_fallidos).padEnd(9)} ${bloqueado}`,
    );
  }
  console.log('');
}

async function ejecutar() {
  const { entorno } = prepararEntorno();
  prisma = new PrismaService(entorno.DATABASE_URL);
  const sesiones = new SesionService(prisma);

  console.log('\n  Tourniquet - recuperar acceso de un usuario\n');
  console.log('  ' + '-'.repeat(64) + '\n');

  if (flags.listar) {
    await listar();
    await prisma.$disconnect();
    return;
  }

  const usuario = typeof flags.usuario === 'string' ? flags.usuario : await preguntarTexto('Usuario (login)');
  if (!usuario) {
    console.error('\n  Falta el usuario. Ver los existentes con:\n');
    console.error('      npm run resetear:clave -- --listar\n');
    await prisma.$disconnect();
    process.exit(1);
  }

  const normalizado = normalizarUsuario(usuario);
  const fila = await prisma.idn_usuario.findUnique({ where: { usuario: normalizado } });

  if (!fila) {
    console.error(`\n  No existe ningun usuario con el login "${normalizado}".`);
    console.error('  Ojo: el login se guarda en minuscula y sin espacios.\n');
    console.error('  Ver los existentes con:  npm run resetear:clave -- --listar\n');
    await prisma.$disconnect();
    process.exit(1);
  }

  // Se muestra a quien se le va a cambiar la clave. Es el mismo control que
  // tiene el login: sin esto, cambiar la clave del usuario equivocado es un
  // fallo silencioso con consecuencias reales.
  console.log(`  Usuario : ${fila.usuario}`);
  console.log(`  Persona : ${(fila.nombre + ' ' + fila.apellido).trim()}`);
  console.log(`  Estado  : ${fila.estado}`);
  if (fila.bloqueado_hasta && fila.bloqueado_hasta > new Date()) {
    console.log(`  Bloqueado hasta ${fila.bloqueado_hasta.toISOString().replace('T', ' ').slice(0, 16)}`);
  }
  if (fila.intentos_fallidos > 0) {
    console.log(`  Intentos fallidos: ${fila.intentos_fallidos} (se van a limpiar)`);
  }
  console.log('');

  let clave = process.env[CLAVE_POR_ENTORNO];
  if (clave) {
    console.log(`  Contrasena tomada de ${CLAVE_POR_ENTORNO}.`);
    console.log('  OJO: queda en el historial del shell. El prompt es lo preferible.\n');
  } else {
    clave = await preguntarSecreto('  Contrasena nueva (oculta, minimo 10 caracteres): ');
  }

  const politica = validarPoliticaClave(clave, {
    usuario: fila.usuario,
    nombreCliente: undefined,
  });
  if (!politica.valida) {
    console.error('\n  La contrasena no cumple la politica minima:');
    for (const motivo of politica.motivos) {
      console.error(`    - ${motivo}`);
    }
    console.error('\n  No se modifico nada.\n');
    await prisma.$disconnect();
    process.exit(1);
  }

  // La confirmacion solo va por prompt, nunca por flag: un `--si` en la linea de
  // comandos queda en el historial al lado del usuario, y un recuperador de
  // credenciales que se puede correr sin mirar es un recuperador que se corre
  // sin mirar.
  const confirmacion = await preguntarTexto('\n  Cambiar la clave de "' + fila.usuario + '"? (si/no)');
  if (!/^s(i|í|í)$/i.test(confirmacion)) {
    console.log('\n  Cancelado. No se modifico nada.\n');
    await prisma.$disconnect();
    return;
  }

  const claveHash = await hashear(clave);
  // La clave no se vuelve a tocar en ningun punto de aqui en adelante.
  clave = null;

  const ahora = new Date();
  await prisma.idn_usuario.update({
    where: { idusuario: fila.idusuario },
    data: {
      clave_hash: claveHash,
      // Limpiar el bloqueo es parte del arreglo, no un bonus: ver la cabecera.
      intentos_fallidos: 0,
      bloqueado_hasta: null,
      actualizado_en: ahora,
    },
  });

  // Sesiones vivas del usuario, en TODOS los clientes. Se cierran una por una
  // para que `cerrar()` revoque tambien la familia de refresh de cada `sid`
  // (que es lo que hace el logout de verdad) y para que quede el `motivo_cierre`
  // en la fila.
  const abiertas = await prisma.tok_sesion.findMany({
    where: { idusuario: fila.idusuario, cerrada_en: null },
    select: { sid: true },
  });
  let cerradas = 0;
  for (const s of abiertas) {
    if (await sesiones.cerrar(s.sid, 'revocada')) {
      cerradas++;
    }
  }

  console.log('');
  console.log(`  [ok] Clave de "${fila.usuario}" cambiada (argon2id).`);
  console.log(`  [ok] Bloqueo limpiado: intentos_fallidos = 0, bloqueado_hasta = NULL.`);
  console.log(`  [ok] Sesiones cerradas: ${cerradas} de ${abiertas.length} vivas.`);
  console.log('');
  console.log('  Las sesiones de las apps de ese usuario tambien quedaron cerradas:');
  console.log('  va a tener que entrar de nuevo en cada una.');
  console.log('');
  console.log('  -'.repeat(64));
  console.log(`      idusuario: ${fila.idusuario}`);
  console.log('  ' + '-'.repeat(64) + '\n');

  await prisma.$disconnect();
}
