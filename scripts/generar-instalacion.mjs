#!/usr/bin/env node
/**
 * Genera la semilla de catalogo de UN cliente: `deploy/sql/91-semilla-<cliente>.sql`.
 *
 * **Este script no escribe en ninguna base.** No abre coneccion, no lee el
 * `.env` y no necesita `TQ_MASTER_KEY`. Escribir un archivo y nada mas, por tres
 * motivos que son la misma razon:
 *
 *   1. La semilla va versionada y la ejecuta el usuario con `sqlcmd` sobre la base
 *      del cliente. Un generador que ademas ejecutara su propia salida seria un
 *      camino mas por el que un `.sql` toca una base equivocada.
 *   2. Es el unico camino por el que se escribe un `.sql` nuevo, asi que el
 *      numero (`91-`), el encabezado y la lista de lo que NO va adentro quedan
 *      garantizados por construccion y no por buena memoria.
 *   3. Generarlo **en la maquina del cliente** es lo que obliga a que los dominios
 *      sean los de ese cliente y no los de desarrollo. `90-semilla-catalogo.sql`
 *      lleva `localhost` en los `redirect_uri`, y uno de esos en una instalacion
 *      real es un `redirect_uri` valido para siempre (trampa 5 de `fase-10`).
 *
 * Lo que NO va en el archivo generado, y por que (mismo criterio que
 * `deploy/README.md`): credenciales de base (van por `registrar:base`, que cifra
 * con AES-256-GCM y IV aleatorio por registro), usuarios (van por
 * `bootstrap:admin` / `alta:usuario`, que hashean argon2id en el momento) y
 * claves de firma (las genera `generar:clave` y la master key vive en el gestor
 * de secretos, nunca en la base).
 *
 * Escribe UN archivo y se niega a sobrescribir uno existente. Un `91-` retirado no
 * se reutiliza nunca: una base que ya aplico un `91` no puede recibir despues un
 * `91` distinto (`specs/02` §5.1).
 *
 * **Donde va el archivo.** Por defecto, `deploy/sql/91-semilla-<cliente>.sql`, que
 * es lo correcto en el repo de la instalacion. En el repo de DESARROLLO de
 * Tourniquet no: ese `deploy/sql/` es de `tourniquet_dev` y sus dominios son
 * `localhost`, y un `auth.cervi.com` committed ahi no describe ninguna
 * instalacion. Ahi va con `--salida` a una carpeta de la maquina donde se prepara
 * el despliegue, y se sube al repo del cliente por el canal que el cliente use.
 *
 * Uso:
 *   npm run generar:instalacion
 *   npm run generar:instalacion -- --cliente cervi --nombre "Cerveceria Cervi"
 *   npm run generar:instalacion -- --salida ruta/al/archivo.sql
 *   npm run generar:instalacion -- --ejemplo     # imprime el SQL sin escribir nada
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsearFlags, preguntarTexto } from './lib/consola.mjs';

const RAIZ = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DIR_SQL = resolve(RAIZ, 'deploy', 'sql');
const PREFIJO = '91-semilla-';

/**
 * Formato de los codigos de cliente y de base.
 *
 * No es una validacion estetica: `codigo` sale en el claim `tenant` del token y
 * `codigo` de la base es la clave con la que el panel nombra la fila, y los dos
 * van a URLs, a logs y a archivos `.sql`. Se acepta lo que el motor acepta
 * (`nvarchar(20)` / `nvarchar(40)`, case-insensitive en SQL Server, y el archivo
 * del cliente lo va a tener que abrir Windows) y nada mas.
 */
const RE_CODIGO_CLIENTE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,19}$/;
const RE_CODIGO_BASE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const RE_HEX = /^#[0-9a-f]{6}$/i;

/** Origenes de la app: nunca `http` fuera de localhost (trampa 2 de `fase-10`). */
function esHttpsSeguro(url) {
  if (/^https:\/\//i.test(url)) return true;
  // `http://localhost` y `http://127.0.0.1` si: es la unica forma de probar en
  // la maquina del que instala, y no viaja a ninguna app.
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(url);
}

const USO = [
  '      npm run generar:instalacion',
  '      npm run generar:instalacion -- --cliente cervi --nombre "Cerveceria Cervi"',
  '      npm run generar:instalacion -- --salida ruta/al/archivo.sql',
  '      npm run generar:instalacion -- --ejemplo',
  '      npm run generar:instalacion -- --fuerza      (sobrescribe el archivo, a mano)',
].join('\n');

const flags = parsearFlags(
  process.argv.slice(2),
  [
    'cliente',
    'nombre',
    'app',
    'nombre-app',
    'issuer',
    'origen',
    'callback',
    'inicio',
    'base',
    'nombre-base',
    'host-base',
    'icono',
    'tema',
    'acento',
    'salida',
  ],
  USO,
);

console.log('\n  Tourniquet - generador de instalacion\n');
console.log('  ' + '-'.repeat(64) + '\n');

try {
  await ejecutar();
} catch (error) {
  console.error(`\n  ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

async function ejecutar() {
  const datos = await preguntar();

  const sql = componer(datos);
  const destino = flags.salida
    ? isAbsolute(String(flags.salida))
      ? String(flags.salida)
      : resolve(process.cwd(), String(flags.salida))
    : resolve(DIR_SQL, `${PREFIJO}${datos.cliente.toLowerCase()}.sql`);

  if (flags.ejemplo) {
    console.log('\n' + sql);
    console.log('\n  [ejemplo] No se escribio nada. Sin --ejemplo el archivo seria:\n');
    console.log(`      ${relativo(RAIZ, destino)}\n`);
    return;
  }

  if (existsSync(destino) && !flags.fuerza) {
    throw new Error(
      `El archivo ya existe:\n      ${destino}\n\n` +
        'No se sobrescribe. Un 91- aplicado en una base no puede ser distinto ' +
        'despues (specs/02 §5.1). Correr con --salida <otra ruta>, borrar el ' +
        'archivo a mano si todavia no se aplico en ninguna base, o usar --fuerza.',
    );
  }

  // Otro `91-semilla-*` en el directorio no es un error: D3 es una instancia por
  // cliente, asi que cada instalacion tiene SU `91-` y van a bases distintas. Lo
  // que no puede pasar es aplicarle dos `91-` distintos a la MISMA base, y eso
  // no lo puede ver este script: lo ve quien ejecuta.
  const otros = existeOtroSemilla(destino);
  if (otros.length > 0) {
    console.log('\n  [aviso] En `deploy/sql/` hay otras semillas de instalacion:');
    for (const otro of otros) {
      console.log(`      ${otro}`);
    }
    console.log('  Cada cliente tiene la suya y van a bases distintas. Aplicar dos');
    console.log('  `91-` distintos a la MISMA base es un error: el segundo pisa el');
    console.log('  primero en silencio (es idempotente, no acumulativo).\n');
  }

  writeFileSync(destino, sql, 'utf8');

  console.log(`\n  [ok] Escrito ${relative(RAIZ, destino)}\n`);
  console.log('  Que sigue:');
  console.log(`      sqlcmd -S <srv> -d tourniquet -i "${relative(RAIZ, destino)}" -b\n`);
  console.log('  Y despues, en este orden (deploy/runbooks/instalacion.md):');
  console.log('      1. npm run generar:clave        -> master key al gestor de secretos');
  console.log('      2. npm run registrar:base       -> credencial cifrada de la base');
  console.log('      3. npm run bootstrap:admin      -> primer administrador\n');
  console.log('  Lo que NO lleva, a proposito: usuarios, contrasenas y claves de firma.');
  console.log('  Ver la seccion "Por que la semilla no lleva usuarios ni credenciales"');
  console.log('  de deploy/README.md.\n');
}

/** Los otros `91-semilla-*` del directorio, si los hay. */
function existeOtroSemilla(destino) {
  if (!existsSync(DIR_SQL)) {
    return [];
  }
  return readdirSync(DIR_SQL)
    .filter((nombre) => nombre.startsWith(PREFIJO) && nombre.endsWith('.sql'))
    .map((nombre) => resolve(DIR_SQL, nombre))
    .filter((ruta) => ruta !== resolve(destino))
    .map((ruta) => relative(RAIZ, ruta));
}

/** Pregunta lo que no vino por flag. Los flags son para pipelines y para repetir. */async function preguntar() {
  console.log('  Los que vienen por flag se usan tal cual; el resto se pregunta.\n');

  const cliente = (flags.cliente || (await preguntarTexto('Codigo del cliente (claim `tenant`)', 'cervi')))
    .toString()
    .trim();
  if (!RE_CODIGO_CLIENTE.test(cliente)) {
    throw new Error(
      `Codigo de cliente invalido: "${cliente}".\n` +
        '  Son hasta 20 caracteres, letras, digitos, guion y guion bajo, y no puede\n' +
        '  empezar con guion. Va en el claim `tenant` de todos los tokens.',
    );
  }

  const nombre = (flags.nombre || (await preguntarTexto('Nombre del cliente (lo que se ve en el portal)'))).toString().trim();
  if (!nombre) {
    throw new Error('Falta el nombre del cliente: es el texto que el empleado ve en la pantalla de ingreso.');
  }

  const app = (flags.app || (await preguntarTexto('Codigo de la app (claim `aud`)', 'rhpro'))).toString().trim();
  if (!RE_CODIGO_BASE.test(app)) {
    throw new Error(`Codigo de app invalido: "${app}". Es el claim \`aud\` de todos los tokens de la app.`);
  }

  const nombreApp = (flags['nombre-app'] || (await preguntarTexto('Nombre de la app', 'RHPro')))
    .toString()
    .trim();
  if (!nombreApp) {
    throw new Error('Falta el nombre de la app: es lo que se ve en la lista del lanzador.');
  }

  const issuer = (flags.issuer || (await preguntarTexto('Origen del IdP (TQ_ISSUER)', 'https://auth.' + cliente + '.com')))
    .toString()
    .trim()
    .replace(/\/+$/, '');
  if (!esHttpsSeguro(issuer)) {
    throw new Error(
      `TQ_ISSUER tiene que ser https en una instalacion real, y "${issuer}" no lo es.\n` +
        '  El `issuer` es el string que las apps comparan contra el del discovery: con\n' +
        '  una barra al final, con `www`, o en http, TODAS las apps dan 401 (trampa 2\n' +
        '  de fase-10). Se copia y se pega el mismo string en el discovery, en el\n' +
        '  `.env` y en la config de cada app.',
    );
  }

  const origen = (flags.origen || (await preguntarTexto('Origen de la app (donde vive el portal de RHPro)', 'https://rhpro.' + cliente + '.com')))
    .toString()
    .trim()
    .replace(/\/+$/, '');
  if (!esHttpsSeguro(origen)) {
    throw new Error(`El origen de la app tiene que ser https: "${origen}" no lo es.`);
  }

  const callback = (flags.callback || (await preguntarTexto('Callback de la app (redirect_uri)', origen + '/auth/callback')))
    .toString()
    .trim();
  if (!callback.startsWith(origen + '/')) {
    throw new Error(
      `El callback tiene que estar bajo el origen de la app.\n` +
        `      callback: ${callback}\n` +
        `      origen:   ${origen}\n` +
        '  Un `redirect_uri` de otro origen es exactamente lo que un atacante\n' +
        '  necesita para que le manden el codigo de ese cliente (specs/01 §9).',
    );
  }

  const inicio = (flags.inicio || (await preguntarTexto('Pagina de ingreso de la app (url_inicio)', origen + '/login')))
    .toString()
    .trim();
  if (!inicio.startsWith(origen + '/')) {
    throw new Error(`La url_inicio tiene que estar bajo el origen de la app: "${inicio}" no lo esta.`);
  }

  // El codigo de la base sale del cliente y de la app, y no del nombre: los
  // nombres llevan acentos y espacios ("Cerveceria Cervi"), y un `codigo` con
  // acentos es una fila que despues hay que escribir a mano en un `.sql`.
  const codigoBase = (
    flags.base ||
    (await preguntarTexto('Codigo de la base de negocio', `${app.toLowerCase()}_${cliente.toLowerCase()}`))
  )
    .toString()
    .trim();
  if (!RE_CODIGO_BASE.test(codigoBase)) {
    throw new Error(
      `Codigo de base invalido: "${codigoBase}".\n` +
        '  Hasta 40 caracteres, letras, digitos, guion y guion bajo, sin espacios ni\n' +
        '  acentos. Es la clave con la que el panel nombra la fila.',
    );
  }

  const nombreBase = (flags['nombre-base'] || (await preguntarTexto('Nombre de la base de negocio', codigoBase)))
    .toString()
    .trim();
  if (!nombreBase) {
    throw new Error('Falta el nombre de la base de negocio.');
  }

  const hostBase = (flags['host-base'] || (await preguntarTexto('Host donde vive la base de negocio', '<host-sql-del-cliente>')))
    .toString()
    .trim();

  const tema = (flags.tema || (await preguntarTexto('Tema del portal (gothic | austero)', 'gothic')))
    .toString()
    .trim()
    .toLowerCase();
  if (tema !== 'gothic' && tema !== 'austero') {
    throw new Error(
      `Tema invalido: "${tema}".\n` +
        '  Solo hay dos (estetica-tourniquet.md §11): `gothic` (el del producto) y\n' +
        '  `austero` (el mismo, con un acento azul neutro y sin textura). Un valor\n' +
        '  nuevo seria un tema que nadie midio.',
    );
  }

  let acento = flags.acento ? String(flags.acento).trim() : '';
  if (acento && !RE_HEX.test(acento)) {
    throw new Error(
      `El acento tiene que ser un color #rrggbb: "${acento}" no lo es.\n` +
        '  Va a una variable CSS en el navegador de cada empleado, asi que solo se\n' +
        '  acepta un hex de seis digitos. Sin --acento se usa el de la estetica.',
    );
  }
  if (!acento && tema === 'austero') {
    acento = '41607e';
    console.log('\n  [nota] Estetica austera sin --acento: se usa el azul neutro por');
    console.log('         defecto #41607e (medido: 5.63:1 con `pergamino` sobre el');
    console.log('         boton principal, 3.01:1 sobre `tinta`). Para cambiarlo,');
    console.log('         `--acento #rrggbb`.\n');
  }
  if (acento) {
    acento = acento.toLowerCase();
  }

  const icono = leerIcono(flags.icono);

  console.log('\n  Resumen de lo que se va a escribir:');
  console.log(`      cliente      ${cliente}  ("${nombre}")`);
  console.log(`      app          ${app}  ("${nombreApp}")`);
  console.log(`      issuer       ${issuer}`);
  console.log(`      origen app   ${origen}`);
  console.log(`      callback     ${callback}`);
  console.log(`      url_inicio   ${inicio}`);
  console.log(`      base         ${codigoBase}  ("${nombreBase}", host ${hostBase})`);
  console.log(`      tema         ${tema}${acento ? ` con acento #${acento}` : ''}`);
  console.log(`      icono        ${icono ? 'incluido' : 'ninguno'}`);
  console.log('\n  NO incluye: usuarios, contrasenas de base, claves de firma.\n');

  return {
    cliente,
    nombre,
    app,
    nombreApp,
    issuer,
    origen,
    callback,
    inicio,
    base: codigoBase,
    nombreBase,
    hostBase,
    tema,
    acento,
    icono,
  };
}

/**
 * El icono es lo unico del `.sql` que es binario, asi que se embebe como base64
 * en un `OPENROWSET`/`OPENROWSET` no: no hay una forma de meter un SVG en un
 * `nvarchar` que el navegador pueda usar como `src` **y** que ademas sea legible
 * en una revision. Se escribe la RUTA en `notas` y el archivo va al lado, en el
 * servidor web que sirve el portal.
 */
function leerIcono(ruta) {
  if (!ruta) {
    return '';
  }

  const archivo = isAbsolute(String(ruta)) ? String(ruta) : resolve(process.cwd(), String(ruta));

  if (!existsSync(archivo)) {
    throw new Error(`No existe el archivo de icono: ${archivo}`);
  }
  const contenido = readFileSync(archivo, 'utf8');
  if (!/^\s*<svg[\s>]/i.test(contenido)) {
    throw new Error(
      `El icono tiene que ser un SVG (raiz <svg>): ${basename(archivo)} no lo es.\n` +
        '  Un PNG o un JPG en el icono de una app es un request extra por empleado en\n' +
        '  cada ingreso, y el export del portal es estatico.',
    );
  }
  if (/<script|onload=|onerror=/i.test(contenido)) {
    throw new Error(`El SVG tiene scripting: ${basename(archivo)}. Se sirve como <img>, no se ejecuta.`);
  }
  return `  ${basename(archivo)}`;
}

function cadena(valor) {
  return `N'${String(valor).replace(/'/g, "''")}'`;
}

function componer(d) {
  const tema = d.acento
    ? `{ "estetica": "${d.tema}", "color_acento": "#${d.acento}" }`
    : `{ "estetica": "${d.tema}" }`;

  const notas = ['app de la instalacion'];
  if (d.icono) {
    notas.push(`icono: ${d.icono} (copiar al servidor web del portal)`);
  }

  return `-- =============================================================================
-- Tourniquet · 91 · Semilla de catalogo · ${d.cliente}
-- MOTOR: SQL Server
--
-- QUE ES ESTE SCRIPT
--   Carga el catalogo MINIMO de la instalacion de ${d.nombre}: una app, un
--   cliente, el vinculo entre los dos y el INVENTARIO de su base de negocio.
--   Idempotente: se puede correr las veces que haga falta, sin duplicar.
--
--
-- QUE NO SE SIEMBRA, Y POR QUE
--   NO usuarios.      El primer administrador lo crea
--                     \`npm run bootstrap:admin\` (argon2id, clave por prompt).
--                     Una clave en un \`.sql\` es una credencial en el repo.
--   NO contrasenas.    \`credencial_cifrada\` va NULL y \`usuario\` con el centinela
--                     \`sin_registrar\`. Las carga \`npm run registrar:base\`, que cifra
--                     con AES-256-GCM y IV aleatorio por registro (specs/01 §6).
--   NO claves de firma. Las genera \`npm run generar:clave\`; la master key vive
--                     en el gestor de secretos del cliente, nunca en la base.
--
--
-- QUEIENE LO EJECUTA
--   El USUARIO, con \`sqlcmd -b\`, sobre la base de control del cliente. El agente
--   no lo corre: su unico camino a una base es \`scripts/ejecutar-sql-dev.mjs\`, con
--   guardia dura a \`tourniquet_dev\` (regla 3 de AGENTS.md).
--
--
-- LOS TRES VALORES QUE MAS SE ROMPEN EN UNA INSTALACION
--   1. \`TQ_ISSUER\`. Este es el string que las apps comparan contra el del
--      discovery. Si el certificado sirve un dominio y el \`.env\` dice otro (con
--      barra al final, con \`www\`, en http), TODAS las apps dan 401 y el sintoma
--      no apunta a la causa. Copiar y pegar el mismo string:
--          ${d.issuer}
--   2. Los \`redirect_uri\`. Son la lista de destinos a los que este IdP puede
--      mandar un codigo de autorizacion. Un \`localhost\` o un origen ajeno que
--      quede aca es un destino valido PARA SIEMPRE (specs/01 §9):
--          ${d.callback}
--   3. \`usuario = sin_registrar\`. Es un CENTINELA, no un login. La base esta
--      registrada pero todavia no se le habla a nadie. Antes de armar una conexion
--      hay que comparar contra ese valor: un string de conexion armado con el
--      centinela falla con "login failed", que no dice "no lo registraste".
--
--
-- LIMITE CONOCIDO
--   UQ_cat_base_datos_cliente_aplicacion_activa es UNICO y FILTRADO por
--   estado='activo': una sola base ACTIVA por combinacion cliente+app. Si este
--   cliente llegara a tener dos bases activas de esta misma app, el indice las
--   rechaza. No se resuelve poniendo la segunda en 'inactivo' por el margen: las
--   dos son reales. La pregunta previa es si el indice tiene que cambiar, y eso
--   es un cambio de esquema con su incremental y su spec.
-- =============================================================================


SET NOCOUNT ON;
GO

PRINT N'-- ===========================================';
PRINT N'-- 91 · Semilla de catalogo · ${d.nombre}';
PRINT N'-- app + cliente + vinculo + inventario de bases.';
PRINT N'-- Sin usuarios, sin contrasenas, sin claves.';
PRINT N'-- ===========================================';
GO


-- -----------------------------------------------------------------------------
-- 1 · Datos de entrada
-- -----------------------------------------------------------------------------
IF OBJECT_ID(N'tempdb..#apps') IS NOT NULL DROP TABLE #apps;
CREATE TABLE #apps
(
    fila             int IDENTITY(1,1) NOT NULL,
    codigo           nvarchar(40)  NOT NULL,
    nombre           nvarchar(100) NOT NULL,
    tipo_cliente     nvarchar(10)  NOT NULL,
    redirect_uris    nvarchar(max) NOT NULL,
    origenes         nvarchar(max) NOT NULL,
    url_inicio       nvarchar(1000) NOT NULL
);

IF OBJECT_ID(N'tempdb..#clientes') IS NOT NULL DROP TABLE #clientes;
CREATE TABLE #clientes
(
    fila             int IDENTITY(1,1) NOT NULL,
    codigo           nvarchar(20)  NOT NULL,
    nombre           nvarchar(100) NOT NULL,
    tema             nvarchar(200) NOT NULL
);

IF OBJECT_ID(N'tempdb..#bases') IS NOT NULL DROP TABLE #bases;
CREATE TABLE #bases
(
    fila             int IDENTITY(1,1) NOT NULL,
    codigo           nvarchar(40)  NOT NULL,
    idcliente        nvarchar(20)  NOT NULL,
    idaplicacion     nvarchar(40)  NOT NULL,
    host             nvarchar(200) NOT NULL,
    [base]           nvarchar(100) NOT NULL,
    usuario          nvarchar(100) NOT NULL,
    estado           nvarchar(10)  NOT NULL,
    notas            nvarchar(500) NULL
);

-- Un solo cliente por instalacion: D3 de \`specs/00-arquitectura.md\` es una
-- instancia por app/base, y \`GET /marca\` muestra el nombre de un unico cliente
-- activo. Con dos clientes activos en la misma base, el portal deja de mostrar el
-- nombre de cualquiera de los dos.
INSERT INTO #apps (codigo, nombre, tipo_cliente, redirect_uris, origenes, url_inicio)
VALUES
    (${cadena(d.app)}, ${cadena(d.nombreApp)}, N'public',
     ${cadena(`["${d.callback}"]`)},
     ${cadena(`["${d.origen}"]`)},
     ${cadena(d.inicio)});

-- \`politica_json.tema\` es lo que el portal lee en \`GET /marca\` para saber con
-- que acento pintar (\`estetica-tourniquet.md\` §11). Un JSON invalido no rompe
-- nada: el backend avisa al log y usa el tema por defecto. Aca va con la forma
-- exacta que documenta §11.
INSERT INTO #clientes (codigo, nombre, tema)
VALUES
    (${cadena(d.cliente)}, ${cadena(d.nombre)}, ${cadena(tema)});

-- Inventario, SIN contrasena. Ver el bloque de arriba.
INSERT INTO #bases (codigo, idcliente, idaplicacion, host, [base], usuario, estado, notas)
VALUES
    (${cadena(d.base)}, ${cadena(d.cliente)}, ${cadena(d.app)}, ${cadena(d.hostBase)},
     ${cadena(d.nombreBase)}, N'sin_registrar', N'activo', ${cadena(notas.join('; '))});
GO


-- -----------------------------------------------------------------------------
-- 2 · Apps
-- -----------------------------------------------------------------------------
DECLARE @codigo nvarchar(40), @nombre nvarchar(100), @tipo nvarchar(10),
        @uris nvarchar(max), @orig nvarchar(max), @inicio nvarchar(1000);

DECLARE cur CURSOR LOCAL FAST_FORWARD FOR
    SELECT codigo, nombre, tipo_cliente, redirect_uris, origenes, url_inicio FROM #apps;

OPEN cur;
FETCH NEXT FROM cur INTO @codigo, @nombre, @tipo, @uris, @orig, @inicio;
WHILE @@FETCH_STATUS = 0
BEGIN
    IF NOT EXISTS (SELECT 1 FROM dbo.cat_aplicacion WHERE codigo = @codigo)
    BEGIN
        INSERT INTO dbo.cat_aplicacion
            (codigo, nombre, tipo_cliente, redirect_uris_json, origenes_json, url_inicio, estado)
        VALUES (@codigo, @nombre, @tipo, @uris, @orig, @inicio, N'activo');
        PRINT N'-- Aplicacion [' + @codigo + N']';
    END
    ELSE
    BEGIN
        -- Los \`redirect_uri\` y los origenes SI se actualizan: son lo que
        -- define a quien este IdP le puede mandar un codigo, y una semilla que
        -- no los refresca deja la instalacion anterior sirviendo. Cambiarlos es
        -- siempre a mano, revisado.
        UPDATE dbo.cat_aplicacion
        SET nombre = @nombre, redirect_uris_json = @uris, origenes_json = @orig, url_inicio = @inicio
        WHERE codigo = @codigo;
        PRINT N'-- Aplicacion [' + @codigo + N'] ya existe (uris y origenes actualizados)';
    END
    FETCH NEXT FROM cur INTO @codigo, @nombre, @tipo, @uris, @orig, @inicio;
END
CLOSE cur;
DEALLOCATE cur;
GO

-- -----------------------------------------------------------------------------
-- 3 · Clientes
-- -----------------------------------------------------------------------------
DECLARE @codigo nvarchar(20), @nombre nvarchar(100), @tema nvarchar(200);

DECLARE cur CURSOR LOCAL FAST_FORWARD FOR
    SELECT codigo, nombre, tema FROM #clientes;

OPEN cur;
FETCH NEXT FROM cur INTO @codigo, @nombre, @tema;
WHILE @@FETCH_STATUS = 0
BEGIN
    IF NOT EXISTS (SELECT 1 FROM dbo.cat_cliente WHERE codigo = @codigo)
    BEGIN
        INSERT INTO dbo.cat_cliente (codigo, nombre, estado, politica_json)
        VALUES (@codigo, @nombre, N'activo', N'{"tema": ' + @tema + N'}');
        PRINT N'-- Cliente [' + @codigo + N']';
    END
    ELSE
    BEGIN
        UPDATE dbo.cat_cliente
        SET nombre = @nombre, politica_json = N'{"tema": ' + @tema + N'}'
        WHERE codigo = @codigo;
        PRINT N'-- Cliente [' + @codigo + N'] ya existe (nombre y tema actualizados)';
    END
    FETCH NEXT FROM cur INTO @codigo, @nombre, @tema;
END
CLOSE cur;
DEALLOCATE cur;
GO

-- -----------------------------------------------------------------------------
-- 4 · Vinculo cliente-aplicacion
--
-- Sin esta fila, el authorize de la app responde \`unauthorized_client\` aunque la
-- app y el cliente esten activos.
-- -----------------------------------------------------------------------------
DECLARE @app nvarchar(40), @cli nvarchar(20);

DECLARE cur CURSOR LOCAL FAST_FORWARD FOR
    SELECT DISTINCT idcliente, idaplicacion FROM #bases ORDER BY idcliente, idaplicacion;

OPEN cur;
FETCH NEXT FROM cur INTO @cli, @app;
WHILE @@FETCH_STATUS = 0
BEGIN
    IF NOT EXISTS (SELECT 1 FROM dbo.cat_cliente_aplicacion
                   WHERE idcliente = @cli AND idaplicacion = @app)
    BEGIN
        INSERT INTO dbo.cat_cliente_aplicacion (idcliente, idaplicacion)
        VALUES (@cli, @app);
        PRINT N'-- Vinculo [' + @cli + N'] -> [' + @app + N']';
    END
    ELSE
        PRINT N'-- Vinculo [' + @cli + N'] -> [' + @app + N'] ya existe';
    FETCH NEXT FROM cur INTO @cli, @app;
END
CLOSE cur;
DEALLOCATE cur;
GO

-- -----------------------------------------------------------------------------
-- 5 · Inventario de bases de negocio - SIN CONTRASENA
-- -----------------------------------------------------------------------------
DECLARE @cod nvarchar(40), @cli nvarchar(20), @app nvarchar(40),
        @host nvarchar(200), @base nvarchar(100), @usr nvarchar(100),
        @estado nvarchar(10), @notas nvarchar(500);

DECLARE cur CURSOR LOCAL FAST_FORWARD FOR
    SELECT codigo, idcliente, idaplicacion, host, [base], usuario, estado, notas
    FROM #bases ORDER BY codigo;

OPEN cur;
FETCH NEXT FROM cur INTO @cod, @cli, @app, @host, @base, @usr, @estado, @notas;
WHILE @@FETCH_STATUS = 0
BEGIN
    IF NOT EXISTS (SELECT 1 FROM dbo.cat_base_datos WHERE codigo = @cod)
    BEGIN
        INSERT INTO dbo.cat_base_datos
            (codigo, idcliente, idaplicacion, host, [base], usuario,
             credencial_cifrada, [engine], estado, notas)
        VALUES
            (@cod, @cli, @app, @host, @base, @usr,
             NULL,
             N'sqlserver', @estado, @notas);
        PRINT N'-- Base [' + @cod + N'] (inventario, SIN contrasena)';
    END
    ELSE
        PRINT N'-- Base [' + @cod + N'] ya existe';
    FETCH NEXT FROM cur INTO @cod, @cli, @app, @host, @base, @usr, @estado, @notas;
END
CLOSE cur;
DEALLOCATE cur;
GO


-- =============================================================================
-- 6 · Verificacion
-- =============================================================================
PRINT N'';
PRINT N'--- VERIFICACION · 91-semilla-${d.cliente} ---';
PRINT N'';

PRINT N'--- 1 · Apps ---';
SELECT codigo, nombre, tipo_cliente, url_inicio, estado FROM dbo.cat_aplicacion ORDER BY codigo;
GO

PRINT N'--- 2 · Clientes (esperado: 1) ---';
SELECT codigo, nombre, estado FROM dbo.cat_cliente ORDER BY codigo;
GO

PRINT N'--- 3 · Vinculos cliente-aplicacion ---';
SELECT idcliente, idaplicacion FROM dbo.cat_cliente_aplicacion ORDER BY idcliente, idaplicacion;
GO

PRINT N'--- 4 · Inventario de bases ---';
PRINT N'-- usuario = sin_registrar y credencial = SIN CREDENCIAL es lo correcto:';
PRINT N'-- la base esta registrada, pero todavia no se le habla a ningun lado.';

SELECT
    codigo, idcliente, idaplicacion, host, [base],
    CASE WHEN credencial_cifrada IS NULL
         THEN N'SIN CREDENCIAL'
         ELSE N'CIFRADA (' + CAST(DATALENGTH(credencial_cifrada) AS nvarchar(10)) + N' B)'
    END AS credencial,
    CASE WHEN usuario = N'sin_registrar'
         THEN N'sin_registrar (PENDIENTE)'
         ELSE usuario
    END AS usuario,
    [engine], estado, notas
FROM dbo.cat_base_datos
ORDER BY codigo;
GO

PRINT N'--- 5 · Chequeos que tienen que dar 0 ---';
SELECT
    -- Un \`localhost\` o un \`http\` en los redirect_uris de una instalacion real
    -- es un destino valido para siempre: alguien con un IdP en su maquina
    -- podria canjear codes (specs/01 §9, trampa 5 de fase-10).
    (SELECT COUNT(*) FROM dbo.cat_aplicacion
        WHERE redirect_uris_json LIKE N'%localhost%'
           OR redirect_uris_json LIKE N'%http://%'
           OR origenes_json LIKE N'%localhost%'
           OR origenes_json LIKE N'%http://%')            AS uris_no_https,
    -- Mas de un cliente activo hace que GET /marca no muestre ninguno.
    (SELECT COUNT(*) FROM dbo.cat_cliente WHERE estado = N'activo')  AS clientes_activos,
    -- El hash SIEMPRE empieza con \$argon2id\$. Un valor que no, es una clave en
    -- claro o un hash de otro algoritmo.
    (SELECT COUNT(*) FROM dbo.idn_usuario
        WHERE clave_hash NOT LIKE N'\$argon2id\$%')       AS hashes_no_argon2id,
    -- Con datos cargados y cero claves de firma, algo se cargo por SQL.
    (SELECT CASE WHEN (SELECT COUNT(*) FROM dbo.idn_usuario) > 0
                  AND (SELECT COUNT(*) FROM dbo.tok_clave_firma) = 0
                 THEN 1 ELSE 0 END)                       AS usuarios_sin_clave_firma,
    -- Un registro a medias no sirve ni para diagnosticar ni para conectar.
    (SELECT COUNT(*) FROM dbo.cat_base_datos
        WHERE (credencial_cifrada IS NULL AND usuario <> N'sin_registrar')
           OR (credencial_cifrada IS NOT NULL AND usuario = N'sin_registrar'))
                                                             AS registros_a_medias;
GO

PRINT N'';
PRINT N'-- Siguiente: npm run registrar:base (credencial) y npm run bootstrap:admin.';
PRINT N'-- El orden completo esta en deploy/runbooks/instalacion.md.';
GO
`;
}
