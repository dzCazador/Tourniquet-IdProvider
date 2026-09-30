import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const dotenv = await import('dotenv');
dotenv.config();

/**
 * Aplicar un `.sql` de `deploy/sql/` a la base de DESARROLLO.
 *
 * Es el unico camino por el que el agente escribe en una base real, y por eso
 * su trabajo no es aplicar el SQL: es hacer que sea **imposible** que el SQL
 * termine en una base que no sea `tourniquet_dev` (regla 3 de `AGENTS.md`).
 * Cuatro barriers, en este orden:
 *
 *   1. La base de `DATABASE_URL` tiene que llamarse exactamente
 *      `tourniquet_dev`. Se aborta antes de abrir cualquier conexion.
 *   2. Si el archivo tiene el marcador `-- @fin-bloque-base`, se aplica **solo
 *      lo que esta despues**. Ese marcador esta deliberadamente despues del
 *      `USE [tourniquet]` del bloque 0 de `00-crear-base.sql`: sin este corte,
 *      correr el `00` desde el agente crearia la base de PRODUCCION y escribiria
 *      el esquema ahi. Ver `deploy/README.md`.
 *   3. `SELECT DB_NAME()` en la conexion abierta tiene que devolver
 *      `tourniquet_dev`. La URL se podria cambiar entre la guardia 1 y el
 *      `USE`; el nombre real de la base conectada no.
 *   4. `sqlcmd -b`: cualquier error aborta con codigo distinto de 0 y el
 *      runner lo propaga, en vez de seguir como si nada.
 *
 * La conexion se arma desde `DATABASE_URL`, no desde los defaults de `sqlcmd`:
 * el default es el motor local con autenticacion de Windows, que en una
 * instalacion con servidor propio y SQL auth no conecta con nada y falla con un
 * error que no dice cual de las dos cosas esta mal.
 *
 * La contrasena viaja por `SQLCMDPASSWORD` y no en `-P`: un `-P` en la linea de
 * comandos queda en la lista de procesos de la maquina.
 */

const BASE_DE_DESARROLLO = 'tourniquet_dev';
const MARCADOR_BLOQUE_BASE = '-- @fin-bloque-base';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('ERROR: DATABASE_URL no definida en .env');
  process.exit(1);
}

const conexion = parsearConexion(databaseUrl);

// Barrera 1 · el nombre de la base, antes de abrir nada.
if (!conexion.base) {
  console.error('ERROR: DATABASE_URL no tiene database=. Abortando.');
  process.exit(1);
}

if (conexion.base !== BASE_DE_DESARROLLO) {
  console.error(
    `ERROR: DATABASE_URL apunta a "${conexion.base}", no a "${BASE_DE_DESARROLLO}". ` +
      'Abortando para proteger bases ajenas.',
  );
  process.exit(1);
}

const sqlFile = process.argv[2];
if (!sqlFile) {
  console.error('Uso: node scripts/ejecutar-sql-dev.mjs <archivo.sql>');
  process.exit(1);
}

const sqlPath = resolve(sqlFile);
const destino = leerSqlParaDev(sqlPath);
const conexionArgs = construirArgs(conexion);

try {
  // Barrera 3 · el nombre real de la base en la conexion abierta.
  try {
    const nombre = ejecutar(
      conexionArgs.concat(['-Q', 'SET NOCOUNT ON; SELECT DB_NAME() AS db']),
      true,
    );
    const abierto = nombre.trim().split(/\r?\n/).find((linea) => linea.trim().length > 0)?.trim() ?? '';
    if (abierto !== BASE_DE_DESARROLLO) {
      console.error(
        `ERROR: la conexion abrio "${abierto}", no "${BASE_DE_DESARROLLO}". Abortando.`,
      );
      process.exit(1);
    }
  } catch (error) {
    console.error('ERROR: no pude verificar la base conectada. Abortando.');
    console.error(String(error.stderr ?? error.message).trim());
    process.exit(1);
  }

  try {
    // Barrera 4 · `-b` hace que un error en cualquier lote aborte.
    ejecutar(conexionArgs.concat(['-i', destino.ruta]), false);
    console.log(`\nScript aplicado exitosamente a la base ${BASE_DE_DESARROLLO}`);
  } catch (error) {
    console.error('Error aplicando el script SQL:');
    console.error(String(error.stderr ?? error.message).trim());
    process.exit(error.status ?? 1);
  }
} finally {
  destino.limpiar();
}

// --- helpers -------------------------------------------------------------------

/**
 * Recorta el bloque 0 de un archivo que lo tenga.
 *
 * Un archivo sin el marcador se aplica entero: los incrementales, las semillas
 * y la verificacion no lo tienen, y no hay nada que saltear. El archivo
 * recortado va a un temporal que se borra en el `finally`, y **solo existe**
 * en ese caso, para que el camino normal no deje nada en el disco.
 */
function leerSqlParaDev(ruta) {
  const contenido = readFileSync(ruta, 'utf8');
  const corte = contenido.indexOf(MARCADOR_BLOQUE_BASE);
  if (corte < 0) {
    return { ruta, limpiar: () => {} };
  }

  const desde = contenido.indexOf('\n', corte) + 1;
  const carpeta = mkdtempSync(join(tmpdir(), 'tourniquet-sql-'));
  const destino = join(carpeta, ruta.split(/[\\/]/).pop());

  console.log(
    `  [guardia] ${ruta.split(/[\\/]/).pop()} tiene bloque 0 (CREATE DATABASE + USE): ` +
      'se aplica solo lo que esta despues del marcador.',
  );
  writeFileSync(destino, contenido.slice(desde), 'utf8');

  return {
    ruta: destino,
    limpiar: () => {
      try {
        rmSync(carpeta, { recursive: true, force: true });
      } catch {
        // Un temporal que no se borra no es un motivo para fallar una aplicacion
        // que ya termino bien. Vive en el temp del sistema y se limpia solo.
      }
    },
  };
}

function parsearConexion(bruto) {
  // Prisma: sqlserver://servidor:puerto;clave=valor;clave=valor
  // JDBC:   jdbc:sqlserver://servidor:puerto;database=x;user=y
  // ODBC:   server=x;database=y        (todo clave=valor, sin esquema)
  const sinEsquema = bruto.replace(/^[a-z0-9+]+:\/\//i, '').replace(/^jdbc:/i, '');
  const [primero, ...resto] = sinEsquema.split(';').filter((p) => p.length > 0);

  const esEstiloServidor = !primero.includes('=');
  const params = {};
  for (const parte of esEstiloServidor ? resto : [primero, ...resto]) {
    const igual = parte.indexOf('=');
    if (igual < 0) continue;
    // Se normalizan los nombres: `Initial Catalog`, `user id` y `TrustServerCertificate`
    // llegan con espacios y con mayusculas distintas.
    const clave = parte.slice(0, igual).trim().toLowerCase().replace(/\s+/g, '');
    params[clave] = decodeURIComponent(parte.slice(igual + 1).trim());
  }

  const servidor = esEstiloServidor ? primero : (params.server ?? params.datasource ?? params.addr);

  return {
    servidor,
    base: params.database ?? params.initialcatalog ?? params.databasename,
    usuario: params.user ?? params.userid ?? params.uid,
    contrasena: params.password ?? params.pwd,
    cifrar: String(params.encrypt ?? '').toLowerCase() === 'true',
    confiarCertificado: String(params.trustservercertificate ?? '').toLowerCase() === 'true',
  };
}

/** `host:puerto` (Prisma) o `host\instance,puerto` (ODBC) → `tcp:host,puerto`. */
function hostParaSqlcmd(servidor) {
  const limpio = servidor.replace(/^tcp:/i, '');
  const [host, puerto] = limpio.split(/[,:]/);
  return puerto ? `tcp:${host},${puerto}` : host;
}

function construirArgs(conexion) {
  const args = ['-S', hostParaSqlcmd(conexion.servidor), '-d', conexion.base];

  if (conexion.usuario) {
    args.push('-U', conexion.usuario);
  }
  if (conexion.cifrar) {
    args.push('-N');
  }
  if (conexion.confiarCertificado) {
    args.push('-C');
  }

  // Salida legible: los `.sql` traen `PRINT` y `SELECT` de verificacion, y
  // tirarlos a la basura es dejar el unico comprobatorio de la aplicacion sin
  // que nadie lo vea. `-w 65000` evita el corte de linea a 80 columnas (que parte
  // los JSON de `redirect_uris_json` en varias), `-W` quita el relleno de
  // espacios y `-h-1` saca las cabeceras de tabla.
  args.push('-b', '-W', '-h', '-1', '-w', '65000');
  args.push('-l', '60');

  return args;
}

function ejecutar(args, capturar) {
  return execFileSync('sqlcmd', args, {
    stdio: capturar ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
    env: {
      ...process.env,
      // La contrasena va por aca y no en `-P`, que la dejaria en la lista de
      // procesos de la maquina.
      ...(conexion.contrasena ? { SQLCMDPASSWORD: conexion.contrasena } : {}),
    },
  });
}
