#!/usr/bin/env node
/**
 * Da de alta un usuario de prueba: lo crea si no existe, le da membresia en uno
 * o mas clientes con un rol, y lo habilita a entrar a las apps de esos clientes.
 *
 * Es la contraparte de `bootstrap-admin.mjs` (que da de alta al primer
 * administrador en TODOS los clientes) para el caso de la Fase 05: un usuario
 * de un cliente, con un rol, habilitado a una app. Por eso el alta de membresia
 * e habilitacion va por `asegurarMembresia` / `asegurarHabilitacion`, que son
 * de a uno; las de `bootstrap` son de a todos.
 *
 * Idempotente por `usuario`: correrlo dos veces no duplica ni pisa la clave. Si
 * el usuario ya existe avisa y sigue, y NO vuelve a pedir la contrasena: un
 * alta re-ejecutada por error no puede cambiarle el password a alguien.
 *
 * Al final imprime el `idusuario`, que es el valor que en la Fase 06 va en
 * `user_per.idp_sub`. Se imprime completo porque no es un secreto: es el `sub`
 * del token y viaja en claro por definicion. Lo que no se imprime jamas es la
 * contrasena.
 *
 * Uso:
 *   npm run alta:usuario -- --usuario prueba --nombre "Prueba" --apellido "Cervi" \
 *                      --cliente cervi --rol user --app rhpro
 */
import { cargar, prepararEntorno } from './lib/entorno.mjs';
import { fallo, parsearFlags, preguntarSecreto, preguntarTexto } from './lib/consola.mjs';

const { PrismaService } = cargar('prisma/prisma.service.js');
const { MasterKeyService } = cargar('claves/master-key.service.js');
const { IdentidadService, ROLES } = cargar('auth/identidad.service.js');
const { AuditoriaService } = cargar('auth/auditoria.service.js');
const { RateLimitService } = cargar('auth/rate-limit.service.js');
const { validarPoliticaClave } = cargar('auth/politica-clave.js');

const USO = [
  '      npm run alta:usuario -- --usuario prueba --nombre "Prueba" --apellido "Cervi" \\',
  '                            --cliente cervi --rol user --app rhpro',
  '',
  '  --cliente acepta varios separados por coma:  --cliente cervi,jugos',
  '  --rol      user | admin_identidad             (por defecto: user)',
  '  --app      app a habilitar; sin el, todas las del cliente',
  '  --sin-apps no habilitar a ninguna app: el usuario entra al portal y a ninguna app',
].join('\n');

const flags = parsearFlags(
  process.argv.slice(2),
  ['usuario', 'nombre', 'apellido', 'cliente', 'rol', 'app'],
  USO,
);

console.log('\n  Tourniquet - alta de usuario\n');
console.log('  ' + '-'.repeat(64) + '\n');

let prismaInstancia = null;

try {
  await ejecutar();
} catch (error) {
  await prismaInstancia?.$disconnect?.().catch(() => {});
  fallo(error, 'dar de alta el usuario');
}

async function ejecutar() {
  const { entorno, configService } = prepararEntorno();
  const masterKey = new MasterKeyService(configService);

  prismaInstancia = new PrismaService(entorno.DATABASE_URL);
  const auditoria = new AuditoriaService(prismaInstancia);
  const limite = new RateLimitService();
  limite.onModuleDestroy();
  const identidad = new IdentidadService(prismaInstancia, auditoria, limite);

  // 1. Cliente(s). El alta sin cliente no tiene sentido: un usuario sin
  //    membresia puede loguearse pero no tiene de que cliente ser.
  const clientes = await elegirClientes();
  if (clientes.length === 0) {
    console.error('\n  No hay clientes activos en la instalacion. Correr 90-semilla-catalogo.sql.\n');
    await prismaInstancia.$disconnect();
    process.exit(1);
  }

  // 2. Rol. Se valida aca y tambien en `asegurarMembresia`: un rol mal escrito
  //    tiene que ser un error visible, no una membresia que parece de admin y
  //    no puede hacer nada.
  const rol = typeof flags.rol === 'string' ? flags.rol.trim() : 'user';
  if (!ROLES.includes(rol)) {
    console.error(`\n  Rol invalido "${rol}". Valores validos: ${ROLES.join(' | ')}.\n`);
    await prismaInstancia.$disconnect();
    process.exit(1);
  }

  // 3. Usuario. Se reusa `crearAdmin` --que es el alta con argon2id y la misma
  //    politica minima-- en vez de escribir un alta nueva: dos alta con dos
  //    politicas es como un dia una de las dos se queda vieja.
  const login = flags.usuario || (await preguntarTexto('Usuario (login)'));
  if (!login) {
    console.error('\n  Falta el usuario.\n');
    await prismaInstancia.$disconnect();
    process.exit(1);
  }

  const existente = await prismaInstancia.idn_usuario.findFirst({
    where: { usuario: String(login).trim().toLowerCase() },
    select: { idusuario: true, usuario: true },
  });

  let idusuario;
  if (existente) {
    idusuario = existente.idusuario;
    console.log(`\n  [aviso] El usuario "${existente.usuario}" ya existe: no se toco su clave.`);
  } else {
    const nombre = flags.nombre || (await preguntarTexto('Nombre'));
    const apellido = flags.apellido || (await preguntarTexto('Apellido'));
    if (!nombre || !apellido) {
      console.error('\n  Faltan datos obligatorios (usuario, nombre, apellido).\n');
      await prismaInstancia.$disconnect();
      process.exit(1);
    }

    const clave = await pedirClave(String(login).trim().toLowerCase());
    const politica = validarPoliticaClave(clave, { usuario: String(login).trim().toLowerCase() });
    if (!politica.valida) {
      console.error('\n  La contrasena no cumple la politica minima:');
      for (const motivo of politica.motivos) {
        console.error(`    - ${motivo}`);
      }
      console.error('');
      await prismaInstancia.$disconnect();
      process.exit(1);
    }

    const alta = await identidad.crearAdmin({
      usuario: String(login),
      nombre,
      apellido,
      clave,
    });
    idusuario = alta.idusuario;
    console.log(`\n  [ok] Usuario creado: ${String(login).trim().toLowerCase()}`);
  }

  // 4. Membresias e habilitaciones, de a uno.
  for (const cliente of clientes) {
    const creada = await identidad.asegurarMembresia(idusuario, cliente.codigo, rol);
    console.log(
      `  [${creada ? 'ok' : '--'}] Membresia ${cliente.codigo} rol=${rol}` +
        `${creada ? '' : ' (ya existia)'}`,
    );

    const apps = await elegirApps(cliente.codigo);
    for (const app of apps) {
      const creada2 = await identidad.asegurarHabilitacion(idusuario, cliente.codigo, app.codigo);
      console.log(
        `  [${creada2 ? 'ok' : '--'}] Habilitacion ${cliente.codigo}/${app.codigo}` +
          `${creada2 ? '' : ' (ya existia)'}`,
      );
    }
    if (apps.length === 0) {
      const porQue = flags['sin-apps'] ? '(--sin-apps)' : '(ninguna app para este cliente)';
      console.log(`  [--] Sin habilitaciones en ${cliente.codigo} ${porQue}`);
    }
  }

  await prismaInstancia.$disconnect();

  // El idusuario es el `sub` del token y el `idp_sub` de RHPro en la Fase 06. Se
  // imprime completo porque no es un secreto, y solo eso: los datos de conexion
  // no van en el mismo bloque, que es lo que el operador copia y pega.
  console.log('\n' + '-'.repeat(64));
  console.log('');
  console.log('  idusuario (usar como sub / idp_sub en la Fase 06):');
  console.log('');
  console.log(`      ${idusuario}`);
  console.log('');
  console.log('  ' + '-'.repeat(64) + '\n');
}

async function pedirClave(usuario) {
  const clave = process.env.TQ_BOOTSTRAP_CLAVE;
  if (clave) {
    console.log('\n  Contrasena tomada de TQ_BOOTSTRAP_CLAVE.');
    console.log('  Ojo: una variable de entorno queda en el historial del shell.');
    return clave;
  }
  console.log('');
  return preguntarSecreto('Contrasena (oculta, minimo 10 caracteres): ');
}

async function elegirClientes() {
  const activos = await prismaInstancia.cat_cliente.findMany({
    where: { estado: 'activo' },
    select: { codigo: true, nombre: true },
    orderBy: { codigo: 'asc' },
  });

  if (flags.cliente) {
    const pedidos = String(flags.cliente)
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);

    const elegidos = [];
    for (const codigo of pedidos) {
      const cliente = activos.find((c) => c.codigo === codigo);
      if (!cliente) {
        throw new Error(
          `El cliente "${codigo}" no existe o esta inactivo. ` +
            `Activos: ${activos.map((c) => c.codigo).join(', ') || '(ninguno)'}.`,
        );
      }
      elegidos.push(cliente);
    }
    return elegidos;
  }

  if (activos.length === 1) {
    return activos;
  }

  console.log('  Clientes activos:');
  activos.forEach((c, i) => console.log(`    ${i + 1}) ${c.codigo}  ${c.nombre}`));
  const respuesta = await preguntarTexto('  Cliente (codigo, o numeros separados por coma)');
  const pedidos = respuesta
    .split(',')
    .map((c) => c.trim())
    .map((c) => (/^\d+$/.test(c) ? activos[Number(c) - 1]?.codigo : c))
    .filter(Boolean);

  return pedidos.map((codigo) => {
    const cliente = activos.find((c) => c.codigo === codigo);
    if (!cliente) {
      throw new Error(`El cliente "${codigo}" no existe o esta inactivo.`);
    }
    return cliente;
  });
}

/**
 * Apps a las que se habilita el usuario en ese cliente.
 *
 * Sale de `cat_cliente_aplicacion` (las apps que existen PARA ese cliente) y no
 * de `cat_aplicacion`: habilitar a alguien en una app que su cliente no tiene
 * crea una fila que el authorize nunca va a usar, y hace creer que el usuario
 * tiene acceso a algo que no existe para el.
 */
async function elegirApps(idcliente) {
  // "Miembro sin apps" es un estado real y no una falta: el usuario se loguea
  // al portal, ve que no tiene ninguna app habilitada y el `admin_identidad` de
  // su cliente se la habilita despues (Fase 08). Por eso es una opcion y no
  // un error.
  if (flags['sin-apps']) {
    return [];
  }

  const pares = await prismaInstancia.cat_cliente_aplicacion.findMany({
    where: { idcliente, cliente: { estado: 'activo' }, aplicacion: { estado: 'activo' } },
    select: { idaplicacion: true, aplicacion: { select: { nombre: true } } },
    orderBy: { idaplicacion: 'asc' },
  });

  const apps = pares.map((p) => ({ codigo: p.idaplicacion, nombre: p.aplicacion.nombre }));

  if (flags.app) {
    const pedida = String(flags.app).trim();
    const app = apps.find((a) => a.codigo === pedida);
    if (!app) {
      // Aviso y se sigue, no error: con `--cliente cervi,otro` es normal que
      // la app exista para uno y no para el otro (es lo que significa que no
      // este cliente la tenga registrada). Tirar aqui abortaria el alta a
      // medias y dejaria al usuario con la membresia creada y la habilitacion
      // sin hacer, que es peor que un aviso.
      console.log(
        `  [aviso] La app "${pedida}" no existe para el cliente "${idcliente}": ` +
          `queda sin apps. Disponibles: ${apps.map((a) => a.codigo).join(', ') || '(ninguna)'}.`,
      );
      return [];
    }
    return [app];
  }

  return apps;
}
