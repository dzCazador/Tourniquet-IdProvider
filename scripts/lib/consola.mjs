/**
 * Consola de los scripts `.mjs`: preguntar, parsear flags y mostrar un fallo
 * legible.
 *
 * Vive en `lib/` y no en cada script por una razon concreta: `bootstrap-admin`
 * ya tenia su propia copia de estas cuatro funciones, y copiar las a los
 * scripts nuevos es como se reproduce un bug. El caso concreto es el parseo de
 * flags con valor: si cada script asume que `--nombre Valor` y `--nombre=Valor`
 * se parsean solos, uno de los dos va a crear un usuario llamado literalmente
 * `true`.
 */
import readline from 'node:readline';
import { Writable } from 'node:stream';

/**
 * Pregunta sin eco. `readline` escribe el prompt y lo que el usuario tipea en
 * `output`; se le pasa un writable que se traga todo. Si la entrada no es
 * interactiva (pipe), no hay eco que tapar y se lee normal.
 */
export function preguntarSecreto(pregunta) {
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

/** Pregunta visible, con valor por defecto. */
export function preguntarTexto(pregunta, porDefecto) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const sufijo = porDefecto ? ` [${porDefecto}]` : '';
  return new Promise((resolve) => {
    rl.question(`${pregunta}${sufijo}: `, (respuesta) => {
      rl.close();
      resolve(respuesta.trim() || porDefecto || '');
    });
  });
}

/**
 * Flags con valor obligatorio, en las dos formas (`--x valor` y `--x=valor`).
 *
 * Se declara la lista en vez de asumir que todo flag trae valor, porque asumirlo
 * produjo un bug real: `--usuario admin` (con espacio) se parseaba como la flag
 * `usuario admin` y el valor quedaba con el string `"true"`, con lo cual se
 * creaba un usuario literalmente llamado "true". Un flag sin valor tiene que ser
 * un error, nunca un valor inventado.
 *
 * Un flag sin valor que **no** esta en `conValor` es una bandera booleana
 * (`--verificar`): vale `true`.
 *
 * @param conValor nombres de flags que necesitan un valor adelante.
 * @param uso texto de ayuda a mostrar si algo esta mal.
 */
export function parsearFlags(argv, conValor, uso) {
  const conValorSet = new Set(conValor);
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

    if (conValorSet.has(cuerpo)) {
      const siguiente = argv[i + 1];
      if (siguiente === undefined || siguiente.startsWith('--')) {
        console.error(`\n  El flag --${cuerpo} necesita un valor.`);
        console.error('  Uso:');
        console.error(uso);
        console.error('');
        process.exit(1);
      }
      flags[cuerpo] = siguiente;
      i++;
      continue;
    }

    flags[cuerpo] = true;
  }

  return flags;
}

/**
 * Falla legible en vez del volcado de la libreria minificada de Prisma.
 *
 * No se imprime `DATABASE_URL`: puede traer usuario y clave, y una cadena de
 * conexion en un error es una credencial escrita en un log (invariante de
 * `AGENTS.md`). Solo se menciona el catalogo, que no es secreto y es justo lo
 * que hay que revisar.
 *
 * @param que nombre del script, para que el mensaje diga que se estaba
 * haciendo ("registrar la base", "dar de alta el usuario").
 */
export function fallo(error, que) {
  const mensaje = error instanceof Error ? error.message : String(error);
  const esConexion =
    error?.constructor?.name === 'PrismaClientInitializationError' ||
    /Can't reach database server|Initialization engine error|P1001|P1002/i.test(mensaje);

  if (esConexion) {
    const catalogo = (process.env.DATABASE_URL || '').match(/database=([^;]+)/i)?.[1] ?? '(sin definir)';
    console.error(`\n  No pude conectarme a la base de control para ${que}.`);
    console.error(`  Catalogo apunta a: ${catalogo}`);
    console.error('  Revisar que SQL Server este levantado y que .env tenga la cadena correcta.');
    console.error('  Detalle: ' + mensaje.split('\n').filter(Boolean).slice(0, 3).join(' | ') + '\n');
  } else {
    console.error(`\n  ${mensaje}\n`);
  }
  process.exit(1);
}
