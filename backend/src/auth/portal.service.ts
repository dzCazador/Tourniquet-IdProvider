import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { SesionService, type Sesion } from '../oidc/sesion.service';
import type { UsuarioSesion } from './identidad.service';
import { clientIdDelReturnTo } from './return-to';

/**
 * Sesion central del portal: la fila de `tok_sesion` con `idaplicacion IS NULL`
 * que vive en la cookie `tok_sesion_portal` (`specs/01` §2.1 y §4).
 *
 * Acá vive lo que la sesion del portal decide y que ninguna otra parte puede
 * decidir por su cuenta: **de que cliente (tenant) es la sesion**. El token
 * sale con el `tenant` de aca, y ese valor sale de la membresia, nunca de un
 * parametro, un header o una cookie del cliente (invariante de `AGENTS.md`).
 */

/**
 * Codigos de error que el front puede recibir. Lista CERRADA: el backend no
 * manda mensajes para mostrar, manda codigos, y el front decide el texto
 * (`specs/01` §4). El `mensaje` que acompana es un resumen tecnico: sirve
 * para un log o para un codigo que el front todavia no conoce, y el portal
 * **no** lo muestra al usuario.
 *
 * `clave_incorrecta` cubre los DOS casos por design: usuario inexistente y
 * clave incorrecta dan el mismo codigo, el mismo status y el mismo texto. Un
 * codigo distinto seria un oraculo de que cuentas existen, que es exactamente
 * lo que `identidad.service.ts` evita antes de llegar aca.
 */
export type CodigoPortal =
  | 'clave_incorrecta'
  | 'bloqueado'
  | 'inactivo'
  | 'rate_limit'
  | 'returnto_invalido'
  | 'sin_cliente'
  | 'cliente_ambiguo'
  | 'cliente_no_pertenece'
  | 'error';

export interface ResumenCliente {
  idcliente: string;
  nombre: string;
}

export interface RespuestaError {
  codigo: CodigoPortal;
  mensaje: string;
  /** ISO 8601. Solo en `bloqueado`: el front lo muestra en hora local. */
  bloqueado_hasta?: string;
  /** Segundos. Solo en `rate_limit`: evita el "reintente en un momento". */
  reintento_seg?: number;
  /**
   * Solo en `cliente_ambiguo`: los clientes del usuario, para que el portal
   * ofrezca elegir en vez de dejarlo en un callejon sin salida. Son **solo los
   * suyos** — la consulta sale del filtro de membresias — asi que el 400 no
   * revela la existencia de ningun otro cliente de la instalacion.
   */
  clientes?: ResumenCliente[];
}

export class ErrorPortal extends Error {
  constructor(
    readonly codigo: CodigoPortal,
    readonly status: number,
    readonly cuerpo: Omit<RespuestaError, 'codigo'>,
  ) {
    super(cuerpo.mensaje);
  }
}

/**
 * Membresia de un cliente tal como la ve el usuario: codigo, nombre y el rol
 * que tiene **en ese cliente**. El rol viaja en la membresia y no en un
 * "rol global", porque es por cliente: el mismo usuario puede ser
 * `admin_identidad` en uno y `user` en otro.
 */
export interface ResumenMembresia extends ResumenCliente {
  rol: string;
}

export interface EstadoSesion {
  usuario: string;
  nombre: string;
  clienteActual: ResumenCliente;
  /** Sesion del portal (la de la cookie), no la de ninguna app. */
  expira_en: string;
}

/**
 * Todo lo que la cookie de sesion del portal autoriza, resuelto una vez.
 *
 * Es el unico contexto del que salen `idusuario` e `idcliente` para los
 * endpoints de lectura (`GET /me`, `GET /me/apps`, `GET /registry/bases/:tenant`).
 * Vive en un solo lugar a proposito: si cada endpoint releyera la cookie y
 *buscara la sesion por su cuenta, cada uno tendria su propia version de "que
 * cuenta como sesion viva" y un olvido en uno seria un endpoint que acepta una
 * sesion cerrada.
 *
 * `rol` es el del usuario en `cliente`, o `null` si la membresia ya no existe
 * (pasa cuando le dan de baja el cliente con la sesion abierta: la sesion
 * sigue viva, el permiso ya no esta).
 */
export interface ContextoSesionPortal {
  sesion: Sesion;
  usuario: UsuarioSesion;
  cliente: ResumenCliente;
  rol: string | null;
  /** Membresias activas del usuario. Solo las suyas: sale del filtro de membresias. */
  membresias: ResumenMembresia[];
}

@Injectable()
export class PortalService {
  private readonly logger = new Logger(PortalService.name);
  private readonly issuer: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sesiones: SesionService,
    config: ConfigService,
  ) {
    this.issuer = config.getOrThrow<string>('TQ_ISSUER').replace(/\/+$/, '');
  }

  get emisor(): string {
    return this.issuer;
  }

  /**
   * De que cliente es la sesion que este login acaba de crear.
   *
   * El `tenant` de todo lo que sale de este login sale de aca, y hay cuatro
   * caminos, del mas deterministico al mas explicito:
   *
   *   1. **El pedido trae `cliente`**: es el que eligio el usuario en el
   *      selector. Se valida contra sus propias membresias, no contra
   *      `cat_cliente`: pedir un cliente del que no es miembro da
   *      `cliente_no_pertenece`, no una sesion.
   *   2. **Una sola membresia activa**: no hay nada que elegir. Es el caso del
   *      despliegue chico y de un usuario de un solo cliente.
   *   3. **Varias, y el `returnTo` trae un `client_id` cuya app pertenece a un
   *      unico cliente** del que el usuario es miembro: el tenant queda
   *      determinado y no se pregunta nada. El `client_id` se cruza contra
   *      `cat_cliente_aplicacion` **con el filtro del usuario adentro**: si no
   *      es miembro de ese cliente, no cuenta como candidato, y el authorize lo
   *      va a rechazar con `access_denied` como debe.
   *   4. **Varias y nada las desambigua**: `cliente_ambiguo` **con la lista**,
   *      y el portal muestra el selector. No se elige solo: la alternativa --
   *      tomar la primera alfabeticamente -- mete al usuario en el tenant
   *      equivocado sin decirselo, y el `tenant` equivocado en el token se
   *      propaga a cada app donde entre.
   *
   * Cero membresias activas (`sin_cliente`) es un estado real y no un error de
   * tipeo: el usuario existe y su clave es correcta, pero no pertenece a ningun
   * cliente de esta instalacion.
   */
  async resolverCliente(
    idusuario: string,
    destinoReturnTo: string,
    clientePedido?: string | null,
  ): Promise<ResumenCliente> {
    const membresias = await this.prisma.idn_usuario_cliente.findMany({
      where: { idusuario, cliente: { estado: 'activo' } },
      select: { idcliente: true, cliente: { select: { nombre: true } } },
      orderBy: { idcliente: 'asc' },
    });

    if (membresias.length === 0) {
      throw new ErrorPortal('sin_cliente', HttpStatus.FORBIDDEN, {
        mensaje: 'El usuario no pertenece a ningun cliente activo de esta instalacion.',
      });
    }

    // 1 · Eleccion explicita del usuario. Va PRIMERO y no como fallback: si
    // eligio, se respeta aunque el `returnTo` apuntara a otro cliente. Al
    // revés --deducir y usar eso-- seria ignorar lo que el usuario acaba de
    // contestarte, y en un `returnTo` de una app que existe en varios clientes
    // lo devolveria a la pregunta que ya respondio.
    if (clientePedido) {
      const elegida = membresias.find((m) => m.idcliente === clientePedido);
      if (!elegida) {
        throw new ErrorPortal('cliente_no_pertenece', HttpStatus.FORBIDDEN, {
          mensaje: `El usuario no es miembro del cliente "${clientePedido}".`,
        });
      }
      return { idcliente: elegida.idcliente, nombre: elegida.cliente.nombre };
    }

    // 2 · Una sola membresia.
    if (membresias.length === 1) {
      return { idcliente: membresias[0].idcliente, nombre: membresias[0].cliente.nombre };
    }

    // 3 · Deducible por la app del `returnTo`.
    const clientId = clientIdDelReturnTo(destinoReturnTo);
    if (clientId) {
      const candidatos = await this.prisma.cat_cliente_aplicacion.findMany({
        where: {
          idaplicacion: clientId,
          cliente: { estado: 'activo', membresias: { some: { idusuario } } },
        },
        select: { idcliente: true },
      });

      const unicos = [...new Set(candidatos.map((c) => c.idcliente))];
      if (unicos.length === 1) {
        const idcliente = unicos[0];
        return {
          idcliente,
          nombre: membresias.find((m) => m.idcliente === idcliente)?.cliente.nombre ?? idcliente,
        };
      }
    }

    // 4 · Preguntar. La lista viaja en el error y son **solo sus** clientes: el
    // filtro de membresias es el mismo que el de arriba, asi que el 400 no
    // revela la existencia de ningun otro cliente de la instalacion.
    throw new ErrorPortal('cliente_ambiguo', HttpStatus.BAD_REQUEST, {
      mensaje: 'El usuario pertenece a varios clientes y el pedido no determina cual.',
      clientes: membresias.map((m) => ({ idcliente: m.idcliente, nombre: m.cliente.nombre })),
    });
  }

  /** Crea la fila de sesion del portal (`idaplicacion IS NULL`). */
  async iniciarSesion(
    idusuario: string,
    idcliente: string,
    ctx: { ip: string; userAgent: string },
  ): Promise<Sesion> {
    return this.sesiones.sesionDePortal(idusuario, idcliente, ctx);
  }

  /**
   * Estado de la sesion del portal para `GET /auth/session`.
   *
   * `null` si no hay cookie, la sesion no existe, esta cerrada o vencio. No
   * distingue los casos: para el navegador son lo mismo, y distinguirlos
   * permitiria enumerar `sid` (invariante de `AGENTS.md`: el `sid` nunca se
   * deduce de nada que venga del cliente).
   */
  async estadoDe(sid: string | null): Promise<EstadoSesion | null> {
    const ctx = await this.contextoDe(sid);
    if (!ctx) {
      return null;
    }

    return {
      usuario: ctx.usuario.usuario,
      nombre: `${ctx.usuario.nombre} ${ctx.usuario.apellido}`.trim(),
      clienteActual: { idcliente: ctx.cliente.idcliente, nombre: ctx.cliente.nombre },
      expira_en: ctx.sesion.expira_en.toISOString(),
    };
  }

  /**
   * Sesion viva + usuario + cliente de la sesion, en una sola consulta.
   *
   * Es lo que consumen `GET /me`, `GET /me/apps` y `GET /registry/bases/:tenant`
   * (Fase 05). Las tres leen el mismo contexto y por eso lo leen de aca y no de
   * la sesion directo: una version propia de "que cuenta como viva" en cada
   * endpoint es una forma de que uno de ellos acepte una sesion cerrada.
   *
   * `null` en los mismos casos que `estadoDe`, y por el mismo motivo: no hay
   * sesion, o la sesion quedo huerfana (el usuario o el cliente se dieron de
   * baja despues del login). No se distingue el motivo.
   *
   * **`rol` y `membresias` se leen de la base en cada pedido, sin cache.** Un
   * permiso cacheado es un permiso revocado que sigue sirviendo: dar de baja a
   * alguien tiene que tener efecto en la proxima request, no en la proxima
   * expiracion de cache.
   */
  async contextoDe(sid: string | null): Promise<ContextoSesionPortal | null> {
    if (!sid) {
      return null;
    }

    const sesion = await this.sesiones.viva(sid);
    if (!sesion) {
      return null;
    }

    const [usuario, cliente, membresias] = await Promise.all([
      this.prisma.idn_usuario.findUnique({
        where: { idusuario: sesion.idusuario },
        select: { idusuario: true, usuario: true, nombre: true, apellido: true, email: true },
      }),
      this.prisma.cat_cliente.findUnique({
        where: { codigo: sesion.idcliente },
        select: { codigo: true, nombre: true },
      }),
      this.prisma.idn_usuario_cliente.findMany({
        where: { idusuario: sesion.idusuario, cliente: { estado: 'activo' } },
        select: { idcliente: true, rol: true, cliente: { select: { nombre: true } } },
        orderBy: { idcliente: 'asc' },
      }),
    ]);

    // Sesion huerfana: el usuario fue dado de baja entre el login y ahora. Se
    // responde `null` (401) y no una sesion a medio construir.
    if (!usuario || !cliente) {
      return null;
    }

    return {
      sesion,
      usuario,
      cliente: { idcliente: cliente.codigo, nombre: cliente.nombre },
      rol: membresias.find((m) => m.idcliente === cliente.codigo)?.rol ?? null,
      membresias: membresias.map((m) => ({
        idcliente: m.idcliente,
        nombre: m.cliente.nombre,
        rol: m.rol,
      })),
    };
  }

  /**
   * Cierra la sesion del portal y devuelve el `idusuario` al que pertenecía.
   *
   * Idempotente: un logout sin cookie, o de una sesion ya cerrada, devuelve
   * `null` y no es un error. El navegador tiene que poder apretar "salir" dos
   * veces sin que la segunda rompa.
   *
   * Devolver el `idusuario` y no un booleano es por la auditoria: `specs/01` §7
   * pide que "toda escritura de auditoría pasa con el `sub` real de la sesión
   * (no admite 'sistema')". Un `logout` con `idusuario NULL` es indistinguible
   * de un logout sin sesion, o sea que un cierre de sesion no deja rastro de
   * quien lo pidio, que es justo el dato que se mira cuando se investiga un
   * acceso.
   *
   * **No toca las sesiones de las apps**: cerrar el portal es "salir del
   * portal". "Salir de todo" es `/oidc/logout` y es de la Fase 07.
   */
  async cerrarSesion(sid: string | null, motivo: 'logout'): Promise<string | null> {
    if (!sid) {
      return null;
    }

    const sesion = await this.sesiones.porSid(sid);
    if (!sesion) {
      return null;
    }

    await this.sesiones.cerrar(sid, motivo);
    return sesion.idusuario;
  }

  /**
   * Traduce el fallo de `IdentidadService.verificar` al contrato del portal.
   *
   * `verificar` ya audito el intento, asi que aca no se vuelve a auditar lo
   * mismo: esta funcion solo decide status, codigo y que dato extra se puede
   * dar sin abrir un canal lateral.
   */
  errorDeFallo(
    motivo: 'credenciales' | 'bloqueado' | 'inactivo' | 'rate_limit',
    datos: { bloqueadoHasta?: Date | null; reintentoEnMs?: number } = {},
  ): ErrorPortal {
    switch (motivo) {
      case 'credenciales':
        return new ErrorPortal('clave_incorrecta', HttpStatus.UNAUTHORIZED, {
          mensaje: 'Usuario o contrasena incorrectos.',
        });
      case 'bloqueado':
        // 423 (Locked, RFC 4918). `HttpStatus` de Nest no lo trae, y meter un
        // 403 generico obliga al front a mirar el cuerpo para distinguir
        // "bloqueado" de "dado de baja".
        return new ErrorPortal('bloqueado', 423, {
          mensaje: 'Cuenta bloqueada por intentos fallidos.',
          ...(datos.bloqueadoHasta ? { bloqueado_hasta: datos.bloqueadoHasta.toISOString() } : {}),
        });
      case 'inactivo':
        return new ErrorPortal('inactivo', HttpStatus.UNAUTHORIZED, {
          mensaje: 'Usuario dado de baja.',
        });
      case 'rate_limit':
        return new ErrorPortal('rate_limit', HttpStatus.TOO_MANY_REQUESTS, {
          mensaje: 'Rate limit por IP o por usuario.',
          reintento_seg: Math.max(1, Math.ceil((datos.reintentoEnMs ?? 60_000) / 1000)),
        });
    }
  }
}
