import { Injectable, Logger } from '@nestjs/common';
import { MasterKeyService } from '../claves/master-key.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Valor centinela de `cat_base_datos.usuario` cuando la base esta registrada pero
 * todavia no se sabe con que login se le habla. Es lo que escribe
 * `90-semilla-catalogo.sql` y lo que decide si el inventario esta completo.
 *
 * **La columna es NOT NULL a proposito**: que exista una fila significa que la
 * base existe, y `usuario` es la unica forma de decirlo sin hacer nullable. La
 * contrapartida es que el que arma una conexion tiene que comparar contra este
 * valor antes: un string de conexion con `sin_registrar` no da un error visible,
 * da "login failed", que no dice "no lo registraste".
 */
export const SIN_REGISTRAR = 'sin_registrar';

/** Motor unico del repo (`AGENTS.md` regla 2, `specs/02` §3). */
export const ENGINE_POR_DEFECTO = 'sqlserver';

/**
 * Fila de inventario, **sin** `usuario` ni `credencial_cifrada`.
 *
 * El tipo no tiene esos campos a proposito: es la unica forma de que un endpoint
 * no los devuelva por accidente, porque no existen para serializar. Si alguna
 * vez hicieran falta en una respuesta (no deberian, `specs/01` §6), el cambio
 * seria un tipo nuevo, no un `select` mas permisivo.
 *
 * `credencial_registrada` es un booleano: dice si hay material cifrado, no cual
 * es. El inventario necesita poder contestar "esta base todavia no tiene
 * contrasena" sin que eso implique devolverla.
 */
export interface BaseInventario {
  codigo: string;
  idcliente: string;
  idaplicacion: string;
  host: string;
  base: string;
  engine: string;
  estado: string;
  /** NULL en el DDL: la columna existe y puede estar vacia. */
  notas: string | null;
  credencial_registrada: boolean;
}

/**
 * Fila de inventario de una **aplicación** de un cliente, para
 * `GET /registry/aplicaciones/:tenant` (Fase 09, `specs/00` §4.2).
 *
 * `base` es el **nombre** de la base de negocio activa de esa app
 * (`cat_base_datos.base`), o `null` si no hay ninguna inventariada. Es el mismo
 * dato que viaja en el claim `base` del token (`specs/01` §2): lo que la app
 * necesita saber es a qué base habla, y el **nombre** de la base no es una
 * credencial.
 *
 * El tipo **no** declara `usuario`, `credencial_cifrada` ni `host`: no es que la
 * consulta no los pida, es que no hay forma de que salgan en la respuesta porque
 * no existen para serializar. `credencial_registrada` sigue siendo un booleano.
 */
export interface AplicacionInventario {
  codigo: string;
  nombre: string;
  /** La URL por la que el lanzador abre la app (`cat_aplicacion.url_inicio`). */
  url_inicio: string;
  estado: string;
  /** Nombre de la base de negocio activa, o `null`. Nunca el host. */
  base: string | null;
}

export interface CredencialBase {
  /** Login de SQL Server. En claro: es inventario interno, no un secreto. */
  usuario: string;
  /** Contrasena. Entra en claro, se cifra adentro y no sale nunca. */
  clave: string;
}

/**
 * `cat_base_datos`: inventario de las bases de negocio de las apps
 * (`specs/01` §6, `specs/02` §3).
 *
 * Tourniquet **no se conecta** a estas bases (D3 de `specs/00`): lo que guarda
 * es lo que el despliegue asistido necesita saber. Lo que sí hace es mantener
 * la credencial cifrada, porque es el dato que hace que el inventario sirva
 * para algo mas que para acordarse de nombres.
 *
 * Reglas del archivo:
 *
 * 1. **La columna `credencial_cifrada` se escribe solo desde aca**, y siempre
 *    pasando por `MasterKeyService` (AES-256-GCM, IV aleatorio por registro).
 *    Nunca se acepta un valor cifrado desde afuera: si la API o un script
 *    pudieran escribir bytes ya cifrados, el IV -- que va pegado al
 *    ciphertext -- pasaria a ser control de quien llama, y reutilizar un IV con
 *    GCM rompe la confidencialidad por completo.
 * 2. **La contrasena no sale.** No hay ningun metodo publico que la devuelva
 *    para mandarla por HTTP. `descifrar` existe para el despliegue y para
 *    verificar, y por eso es un metodo aparte del que escribe.
 */
@Injectable()
export class BdDatosService {
  private readonly logger = new Logger(BdDatosService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly masterKey: MasterKeyService,
  ) {}

  /**
   * Inventario de un cliente, para `GET /registry/bases/:tenant`.
   *
   * El filtro por `idcliente` lo pone el parametro, pero **la autorizacion la
   * decide el llamador** contra `idn_usuario_cliente` (invariante de
   * `AGENTS.md`: el `tenant` nunca se deduce de un parametro). Este metodo solo
   * lee; no sabe quien pregunta.
   *
   * Devuelve tambien las bases `inactivo`: una base que se dio de baja queda
   * como historico y sirve para diagnosticar ("esta installing se registro
   * contra `rhpro_cervi` y despues se migro a otra"). El indice filtrado
   * `UQ_cat_base_datos_cliente_aplicacion_activa` garantiza una sola activa por
   * cliente+app (`specs/02` §4), y aca `estado` dice cual es.
   */
  async inventario(idcliente: string): Promise<BaseInventario[]> {
    const filas = await this.prisma.cat_base_datos.findMany({
      where: { idcliente },
      select: {
        codigo: true,
        idcliente: true,
        idaplicacion: true,
        host: true,
        base: true,
        engine: true,
        estado: true,
        notas: true,
        // Se pide solo el `isSet`: el buffer de la credencial no tiene por que
        // viajar hasta el backend para contestar un booleano.
        credencial_cifrada: true,
      },
      orderBy: [{ estado: 'asc' }, { codigo: 'asc' }],
    });

    return filas.map((fila) => ({
      codigo: fila.codigo,
      idcliente: fila.idcliente,
      idaplicacion: fila.idaplicacion,
      host: fila.host,
      base: fila.base,
      engine: fila.engine,
      estado: fila.estado,
      notas: fila.notas,
      credencial_registrada: fila.credencial_cifrada !== null,
    }));
  }

  /**
   * `true` si el usuario es `admin_identidad` de **ese** cliente.
   *
   * La fila de `idn_usuario_cliente` se lee en cada pedido y no se cachea: un
   * permiso cacheado es un permiso revocado que sigue sirviendo, y dar de baja
   * a un administrador tiene que tener efecto en la proxima request.
   */
  async esAdminDeCliente(idusuario: string, idcliente: string): Promise<boolean> {
    const membresia = await this.prisma.idn_usuario_cliente.findUnique({
      where: { idusuario_idcliente: { idusuario, idcliente } },
      select: { rol: true },
    });
    return membresia?.rol === 'admin_identidad';
  }

  /**
   * Apps del cliente con su base de negocio activa, para
   * `GET /registry/aplicaciones/:tenant` (Fase 09, `specs/00` §4.2).
   *
   * Sale de `cat_cliente_aplicacion` —las apps que existen **para ese cliente**—
   * y no del catálogo global: un TenantRegistry que lee el inventario de `cervi`
   * tiene que ver las apps de `cervi`, y ofrecerle las de `jugos` sería una
   * travesía entre tenants con forma de dato.
   *
   * Se incluyen las apps `inactivo` por el mismo motivo que `inventario()`: la
   * fila es histórico y sirve para diagnosticar una instalación que se migró.
   *
   * La base se resuelve con **una segunda consulta** y un `Map`, no con un
   * `include` anidado: la relación `cat_aplicacion` ↔ `cat_base_datos` no existe
   * en el esquema de Prisma (hay FKs sueltas por `idcliente` + `idaplicacion`) y
   * declararla obligaría a tocar el DDL. Es el mismo patrón que usa
   * `MeController.apps`.
   *
   * El filtro de `base` es `estado = 'activo'` **y** `idcliente`, que es lo que
   * hace que el nombre de la base sea el de **este** cliente.
   */
  async aplicaciones(idcliente: string): Promise<AplicacionInventario[]> {
    const apps = await this.prisma.cat_aplicacion.findMany({
      where: { clientes: { some: { idcliente } } },
      select: { codigo: true, nombre: true, url_inicio: true, estado: true },
      orderBy: { codigo: 'asc' },
    });

    if (apps.length === 0) {
      return [];
    }

    const bases = await this.prisma.cat_base_datos.findMany({
      where: {
        idcliente,
        estado: 'activo',
        idaplicacion: { in: apps.map((a) => a.codigo) },
      },
      // El `base` y nada más: ni `usuario`, ni `host`, ni `credencial_cifrada`.
      // La respuesta de este endpoint es inventario, y el `host` es un dato de
      // la red del cliente que no necesita un TenantRegistry remoto.
      select: { idaplicacion: true, base: true },
    });

    const basePorApp = new Map(bases.map((b) => [b.idaplicacion, b.base]));

    return apps.map((app) => ({
      codigo: app.codigo,
      nombre: app.nombre,
      url_inicio: app.url_inicio,
      estado: app.estado,
      base: basePorApp.get(app.codigo) ?? null,
    }));
  }

  /**
   * Registra (o reemplaza) la credencial de una base ya inventariada.
   *
   * Es lo que llama `scripts/registrar-base.mjs`. La base tiene que existir
   * antes: la crea la semilla de catalogo con `usuario='sin_registrar'` y
   * `credencial_cifrada` NULL, y este metodo completa ese registro. Alta y
   * credencial son dos pasos distintos a proposito, porque el inventario se
   * puede cargar en cualquier instalacion sin ninguna contrasena.
   *
   * **Reescribir la credencial es una operacion normal** (rotacion), y por eso
   * es idempotente en cuanto al resultado: el IV es aleatorio, asi que dos
   * corridas producen bytes distintos y eso no es un problema, es lo unico
   * seguro con GCM.
   */
  async registrarCredencial(codigo: string, credencial: CredencialBase): Promise<BaseInventario> {
    const usuario = credencial.usuario.trim();
    const clave = credencial.clave;

    if (!usuario || !clave) {
      throw new Error('La credencial necesita usuario y contrasena.');
    }
    if (usuario === SIN_REGISTRAR) {
      throw new Error(
        `Usuario invalido: "${SIN_REGISTRAR}" es el centinela de "todavia no registrado", ` +
          'no un login. Sin `usuario` real la base queda a medias y no sirve ni para ' +
          'conectar ni para diagnosticar.',
      );
    }

    const base = await this.prisma.cat_base_datos.findUnique({
      where: { codigo },
      select: { codigo: true, idcliente: true, idaplicacion: true, estado: true },
    });
    if (!base) {
      throw new Error(
        `La base "${codigo}" no esta en el inventario. ` +
          'Cargar primero 90-semilla-catalogo.sql (o el SQL de la instalacion del cliente).',
      );
    }

    try {
      await this.prisma.cat_base_datos.update({
        where: { codigo },
        data: {
          usuario,
          // `masterKey.cifrar` genera el IV aleatorio por registro y arma
          // `iv(12)||tag(16)||ciphertext` (`claves/crypto.ts`).
          credencial_cifrada: this.masterKey.cifrar(clave),
        },
        select: { codigo: true },
      });
    } catch (error) {
      throw this.explicar(error, base);
    }

    this.logger.log(
      `credencial registrada base=${base.codigo} cliente=${base.idcliente} ` +
        `app=${base.idaplicacion} usuario=${usuario} contrasena=[NO SE LOGUEA]`,
    );

    const inventario = await this.inventario(base.idcliente);
    const actualizada = inventario.find((b) => b.codigo === codigo);
    if (!actualizada) {
      throw new Error(`No se pudo releer la base "${codigo}" despues de actualizarla.`);
    }
    return actualizada;
  }

  /**
   * Descifra la credencial. **Solo** para el despliegue y para verificar que lo
   * que se escribio se puede leer: no hay ningun endpoint que llame a esto.
   *
   * `@throws` si la master key no corresponde o la fila esta corrupta. El error
   * de GCM no distingue las dos cosas a proposito: los dos casos son "no la
   * puedo leer" y el detalle va al log de quien lo pidio.
   */
  async descifrarCredencial(codigo: string): Promise<string> {
    const fila = await this.prisma.cat_base_datos.findUnique({
      where: { codigo },
      select: { credencial_cifrada: true },
    });
    if (!fila) {
      throw new Error(`La base "${codigo}" no esta en el inventario.`);
    }
    if (fila.credencial_cifrada === null) {
      throw new Error(`La base "${codigo}" todavia no tiene credencial registrada.`);
    }
    return this.masterKey.descifrar(fila.credencial_cifrada);
  }

  /**
   * Traduce el error del motor a algo que se pueda arreglar.
   *
   * El caso que importa es `UQ_cat_base_datos_cliente_aplicacion_activa`: es un
   * indice UNICO **filtrado** a `estado='activo'`, o sea que una segunda base
   * activa del mismo cliente y la misma app lo rechaza con "Cannot insert
   * duplicate key" (`specs/02` §4). El mensaje crudo de Prisma no dice de que
   * se trata, y el operador ve un error de clave duplicada en una tabla donde no
   * duplico ningun `codigo`.
   */
  private explicar(error: unknown, base: { codigo: string; idcliente: string; idaplicacion: string }): Error {
    const mensaje = error instanceof Error ? error.message : String(error);
    const esUnico = /duplicate key|duplicate key row|IX_/i.test(mensaje) || (error as { code?: string })?.code === 'P2002';

    if (esUnico) {
      return new Error(
        `No se pudo registrar la credencial: ya hay una base ACTIVA para ` +
          `cliente="${base.idcliente}" app="${base.idaplicacion}". El indice ` +
          'UQ_cat_base_datos_cliente_aplicacion_activa permite una sola activa por ' +
          'combinacion. Poner la anterior en inactivo no es un atajo: si la base nueva ' +
          'es real y esta activa, la pregunta es si el indice tiene que cambiar, y eso ' +
          'es un cambio de esquema con su incremental y su spec.',
      );
    }

    return error instanceof Error ? error : new Error(mensaje);
  }
}
