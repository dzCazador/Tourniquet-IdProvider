import { randomInt } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { AuditoriaService, detalleDe } from '../auth/auditoria.service';
import { AVISO_CODIGOS_POCOS } from '../auth/mfa.service';
import { hashear } from '../auth/password.service';
import { normalizarUsuario } from '../auth/politica-clave';
import { conflicto, noEncontrado, peticionInvalida } from '../registro/errores';
import { SesionService } from '../oidc/sesion.service';
import { PrismaService } from '../prisma/prisma.service';
import { AltaUsuarioDto, EditarUsuarioDto, ListadoUsuariosDto } from './dto/admin.dto';
import type { EstadoMfaUsuario } from '../auth/mfa.service';
import type { SesionAdmin } from './admin.types';

/** Tope de la paginacion del panel. 100 es el limite de la fase 08 §4. */
export const TOPE_POR_PAGINA = 100;

/**
 * Alfabeto de la clave temporal: sin vocales analogues ni caracteres que se
 * confunden leyendo un cartel de papel (`0/O`, `1/l/I`).
 *
 * Se leen **en voz alta** y se anotan en una planilla, asi que el problema real no
 * es la entropia: es que alguien la escriba mal y el usuario no entre. Por eso
 * `O` y `0` no estan, y `l` esta.
 */
const ALFABETO_TEMPORAL = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const LARGO_TEMPORAL = 20;

/**
 * Genera una clave temporal de 20 caracteres del alfabeto sin ambiguos.
 *
 * `randomInt` y no un `Math.random` sobre el alfabeto: `Math.random` no es
 * criptografico, y una clave temporal que un atacante puede predecir es peor que
 * ninguna (parece segura). Con `randomInt` de `node:crypto` hay
 * 32^20 ≈ 10^30 combinaciones.
 */
export function claveTemporal(): string {
  let salida = '';
  for (let i = 0; i < LARGO_TEMPORAL; i += 1) {
    salida += ALFABETO_TEMPORAL[randomInt(ALFABETO_TEMPORAL.length)];
  }
  return salida;
}

/** Fila de `idn_usuario` tal como la ve el admin. */
export interface UsuarioAdmin {
  idusuario: string;
  usuario: string;
  nombre: string;
  apellido: string;
  email: string | null;
  estado: string;
  apps: string[];
  ultima_sesion: string | null;
  /**
   * Estado del segundo factor (Fase 09), o `null` si la fila viniera sin
   * `mfa_estado` (no deberia pasar: es NOT NULL en el DDL).
   *
   * `codigos_restantes` y `aviso_pocos` salen de una **sola** consulta agrupada
   * para toda la pagina, no de una por fila. La columna "MFA" del panel es la que
   * un admin mira para decidir si abrir el alta de un usuario, y mostrar "on"
   * sin decir si le quedan códigos esconde justo el caso que hay que actuar
   * (dos códigos y una app de autenticación que se rompió).
   */
  mfa: EstadoMfaUsuario | null;
}

export interface ResultadoAlta {
  idusuario: string;
  usuario: string;
  /** `true` si la fila de `idn_usuario` **ya existía** (alta en otro cliente). */
  compartido: boolean;
  clave_temporal: string | null;
  apps: string[];
}

/**
 * Lo que el panel puede hacer con las identidades de **un** cliente: quién existe,
 * a qué apps entra y si está dado de baja. Nada más.
 *
 * **No hay permisos de negocio acá** (D2 de `specs/00`): ni perfiles, ni roles
 * finos, ni nada que se parezca a `menumstr`. El unico rol que existe es
 * `user | admin_identidad` (`idn_usuario_cliente.rol`) y lo decide el tenant, no
 * este panel.
 *
 * **Regla de oro del archivo: `where: { idcliente }` en TODA consulta.** No un
 * `if` que filtre despues, no un `.map` que descarte: el filtro va en el `where` de
 * Prisma, en la misma linea que la consulta, para que sea visible en el diff. Un
 * filtro en JavaScript es el que se olvida en el proximo metodo que se escriba, y
 * el olvido no se ve en la pantalla (la lista sale vacia) sino en la prueba de
 * travesia entre tenants, que es la unica que lo caza.
 */
@Injectable()
export class AdminUsuariosService {
  private readonly logger = new Logger(AdminUsuariosService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sesiones: SesionService,
    private readonly auditoria: AuditoriaService,
  ) {}

  /**
   * Alta de un usuario en el cliente del admin.
   *
   * El caso importante es el **usuario que ya existe**: el login es global
   * (`idn_usuario.usuario` es UNIQUE, `specs/02` §3), asi que un `jperez` que ya
   * trabaja en otro cliente **no es un usuario nuevo**: es el mismo humano y lo que
   * falta es la membresía. Por eso el alta:
   *
   *   - no crea una fila nueva de `idn_usuario` (sería un segundo `jperez`, o un
   *     409 de índice unico);
   *   - no pisa nombre/apellido/email sin `sobrescribirDatos: true`;
   *   - agrega la membresía y las habilitaciones **de este** cliente.
   *
   * Y por eso la respuesta trae `compartido: true`: la UI tiene que decirlo
   * ("este usuario ya existe en el sistema; se agregó a tu cliente"), porque para
   * el admin es información nueva y para el usuario final no cambia nada.
   */
  async alta(dto: AltaUsuarioDto, admin: SesionAdmin, ctx: Peticion): Promise<ResultadoAlta> {
    const usuario = normalizarUsuario(dto.usuario);
    const apps = await this.appsValidas(dto.aplicaciones, admin.idcliente);

    const existente = await this.prisma.idn_usuario.findUnique({ where: { usuario } });

    if (existente && !dto.sobrescribirDatos) {
      // 409 y no un update silencioso: el criterio de la fase 08 pide que el
      // nombre del otro cliente no se pise sin que el admin lo pida explicitamente.
      conflicto('usuario_existe');
    }

    // La clave se genera **aca**, nunca viene del navegador: mandarla en el body
    // la deja en el historial de red de cualquier proxy y en el body de cualquier
    // log del servidor intermedio (trampa 3 de la fase 08).
    const temporal = dto.claveTemporal === false ? null : claveTemporal();

    const idusuario = await this.prisma.$transaction(async (tx) => {
      let id: string;

      if (existente) {
        id = existente.idusuario;
        if (dto.sobrescribirDatos) {
          await tx.idn_usuario.update({
            where: { idusuario: id },
            data: {
              nombre: dto.nombre,
              apellido: dto.apellido,
              email: dto.email ?? null,
              actualizado_en: new Date(),
            },
          });
        }
      } else {
        const creada = await tx.idn_usuario.create({
          data: {
            usuario,
            nombre: dto.nombre,
            apellido: dto.apellido,
            email: dto.email ?? null,
            clave_hash: await hashear(temporal ?? claveTemporal()),
            mfa_estado: 'off',
            estado: 'activo',
            intentos_fallidos: 0,
            bloqueado_hasta: null,
            creado_en: new Date(),
          },
          select: { idusuario: true },
        });
        id = creada.idusuario;
      }

      await tx.idn_usuario_cliente.upsert({
        where: { idusuario_idcliente: { idusuario: id, idcliente: admin.idcliente } },
        create: {
          idusuario: id,
          idcliente: admin.idcliente,
          rol: 'user',
          creado_en: new Date(),
        },
        // El `update: {}` es deliberado: dar de alta a un usuario que ya es
        // miembro no le cambia el rol. Un admin que quiere promoverlo a
        // `admin_identidad` es otra operacion (por SQL, Fase 10) y no va escondida
        // en un alta.
        update: {},
      });

      for (const app of apps) {
        // `upsert` y no `createMany({ skipDuplicates: true })`: esa opcion no
        // existe para el proveedor MSSQL de Prisma (solo PostgreSQL/MySQL/SQLite),
        // y usarla es un error de tipos que se ve aca y no en produccion. Con 20
        // apps como maximo del DTO, ir de a una es lo que hay.
        await tx.idn_usuario_cliente_aplicacion.upsert({
          where: {
            idusuario_idcliente_idaplicacion: {
              idusuario: id,
              idcliente: admin.idcliente,
              idaplicacion: app,
            },
          },
          create: {
            idusuario: id,
            idcliente: admin.idcliente,
            idaplicacion: app,
            creado_en: new Date(),
          },
          update: {},
        });
      }

      return id;
    });

    await this.auditoria.registrarSeguro({
      resultado: 'ok',
      idusuario: admin.idusuario,
      idaplicacion: apps[0] ?? null,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      detalle: detalleDe('admin_alta_usuario', {
        usuario: idusuario,
        cliente: admin.idcliente,
        compartido: String(Boolean(existente)),
      }),
    });

    this.logger.log(
      `alta usuario=${usuario} cliente=${admin.idcliente} por=${admin.usuario} ` +
        `apps=${apps.join(',') || '(ninguna)'} compartido=${Boolean(existente)}`,
    );

    return {
      idusuario,
      usuario,
      compartido: Boolean(existente),
      clave_temporal: temporal,
      apps,
    };
  }

  /**
   * Edita nombre, apellido, email y estado. **No** cambia el `usuario` (el login) ni
   * el `clave_hash`: el login se cambia con otro mecanismo (es el identificador que
   * la persona usa todos los días y cambiarlo rompe lo que tiene en la cabeza) y la
   * clave se cambia con un reset, que deja rastro.
   *
   * `estado = 'inactivo'` cierra **en cascada** las sesiones vivas del usuario en
   * ese cliente: dejar a alguien sin ingreso no es sacarlo de la lista, es sacarlo
   * de adentro. Un access ya emitido sigue siendo criptograficamente valido 15
   * minutos, pero `/userinfo` lo rechaza porque el `sid` esta muerto (el validador
   * consulta la sesion), asi que el efecto real es inmediato para cualquier app que
   * valide contra el IdP.
   */
  async editar(
    idusuario: string,
    dto: EditarUsuarioDto,
    admin: SesionAdmin,
    ctx: Peticion,
  ): Promise<UsuarioAdmin> {
    const usuario = await this.usuarioDelCliente(idusuario, admin.idcliente);

    const cambios: Record<string, unknown> = { actualizado_en: new Date() };
    if (dto.nombre !== undefined) cambios['nombre'] = dto.nombre;
    if (dto.apellido !== undefined) cambios['apellido'] = dto.apellido;
    if (dto.email !== undefined) cambios['email'] = dto.email;
    if (dto.estado !== undefined) cambios['estado'] = dto.estado;

    await this.prisma.idn_usuario.update({ where: { idusuario }, data: cambios });

    let cerradas = 0;
    if (dto.estado === 'inactivo') {
      cerradas = await this.sesiones.cerrarTodasDelCliente(idusuario, admin.idcliente, 'revocada');
    }

    await this.auditoria.registrarSeguro({
      resultado: 'ok',
      idusuario: admin.idusuario,
      idaplicacion: null,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      detalle: detalleDe(
        dto.estado === 'inactivo' ? 'admin_desactiva_usuario' : 'admin_edita_usuario',
        { usuario: idusuario, cliente: admin.idcliente, estado: dto.estado ?? usuario.estado },
      ),
    });

    this.logger.log(
      `edita usuario=${usuario.usuario} cliente=${admin.idcliente} por=${admin.usuario} ` +
        `estado=${dto.estado ?? '(sin cambio)'} sesiones_cerradas=${cerradas}`,
    );

    return this.ficha(idusuario, admin.idcliente);
  }

  /**
   * Genera una clave nueva y la devuelve **una sola vez**.
   *
   * No hay "ver la clave actual" ni "la clave temporal sigue siendo esta": la
   * respuesta de este endpoint es la unica vez que existe el texto en claro, y
   * despues solo queda el hash. Por eso la UI tiene que avisarlo antes de confirmar
   * y no volver a mostrar nada.
   */
  async resetClave(idusuario: string, admin: SesionAdmin, ctx: Peticion): Promise<{ clave_temporal: string }> {
    const usuario = await this.usuarioDelCliente(idusuario, admin.idcliente);
    const temporal = claveTemporal();

    await this.prisma.idn_usuario.update({
      where: { idusuario },
      data: {
        clave_hash: await hashear(temporal),
        intentos_fallidos: 0,
        // El bloqueo se levanta con el reset: si el admin resetea la clave, el
        // motivo del bloqueo (intentos fallidos con la clave anterior) ya no
        // aplica. Dejar el `bloqueado_hasta` en el futuro haria que el usuario
        // siga sin poder entrar despues de que le dieron una clave nueva, y el
        // admin creeria que "no funciona".
        bloqueado_hasta: null,
        actualizado_en: new Date(),
      },
    });

    await this.auditoria.registrarSeguro({
      resultado: 'ok',
      idusuario: admin.idusuario,
      idaplicacion: null,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      // La clave **nunca** entra en el detalle: solo el hecho de que hubo un
      // reset, el usuario al que se le hizo y el admin que lo hizo.
      detalle: detalleDe('admin_reset_clave', { usuario: idusuario, cliente: admin.idcliente }),
    });

    this.logger.log(
      `reset de clave usuario=${usuario.usuario} cliente=${admin.idcliente} por=${admin.usuario}`,
    );

    return { clave_temporal: temporal };
  }

  /**
   * Habilita o deshabilita el ingreso a una app del cliente.
   *
   * Se borra la fila de `idn_usuario_cliente_aplicacion`, no se marca una bandera:
   * la habilitacion **es** la fila (D2 de `specs/00`: no decide qué ve adentro, solo
   * si entra). Y borrar es un `delete` con la condicion de tenant adentro, asi que
   * un `idaplicacion` de otro tenant no se puede ni deshabilitar ni habilitar.
   */
  async cambiarHabilitacion(
    idusuario: string,
    idaplicacion: string,
    habilitar: boolean,
    admin: SesionAdmin,
    ctx: Peticion,
  ): Promise<{ apps: string[] }> {
    await this.usuarioDelCliente(idusuario, admin.idcliente);
    await this.appDelCliente(idaplicacion, admin.idcliente);

    if (habilitar) {
      await this.prisma.idn_usuario_cliente_aplicacion.upsert({
        where: {
          idusuario_idcliente_idaplicacion: { idusuario, idcliente: admin.idcliente, idaplicacion },
        },
        create: { idusuario, idcliente: admin.idcliente, idaplicacion, creado_en: new Date() },
        update: {},
      });
    } else {
      const { count } = await this.prisma.idn_usuario_cliente_aplicacion.deleteMany({
        where: { idusuario, idcliente: admin.idcliente, idaplicacion },
      });
      if (count === 0) {
        // No estaba habilitada: 404 y no un 200 mudo. Un "deshabilitar" que dice
        // que funciono cuando no habia nada que hacer es como se pierde la cuenta
        // de por que un usuario no entra a una app.
        noEncontrado();
      }
    }

    await this.auditoria.registrarSeguro({
      resultado: 'ok',
      idusuario: admin.idusuario,
      idaplicacion,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      detalle: detalleDe(
        habilitar ? 'admin_habilita_app' : 'admin_deshabilita_app',
        { usuario: idusuario, cliente: admin.idcliente, app: idaplicacion },
      ),
    });

    this.logger.log(
      `${habilitar ? 'habilita' : 'deshabilita'} app=${idaplicacion} ` +
        `usuario=${idusuario.slice(0, 8)} cliente=${admin.idcliente} por=${admin.usuario}`,
    );

    return { apps: await this.appsDe(idusuario, admin.idcliente) };
  }

  /**
   * Listado del tenant, paginado, con busqueda.
   *
   * La entra **obligatoria** es la membresía: el filtro es
   * `membresias: { some: { idcliente } }`, o sea que un usuario que existe en el IdP
   * pero **no es miembro de este cliente** no aparece (criterio de la 08). Y un
   * `intentos_fallidos` que no se pide en el `select` no puede salir ni por
   * accidente: mostrar el estado de bloqueo a quien puede estar probando contrasenas
   * de esa cuenta es informacion de ataque (trampa 2 de la fase 08).
   */
  async listar(
    dto: ListadoUsuariosDto,
    admin: SesionAdmin,
  ): Promise<{ total: number; pagina: number; por_pagina: number; usuarios: UsuarioAdmin[] }> {
    const pagina = Math.max(1, dto.pagina ?? 1);
    const porPagina = Math.min(TOPE_POR_PAGINA, Math.max(1, dto.por_pagina ?? 25));

    const where = {
      // El filtro de tenant va primero y solo. Todo lo demas se suma.
      membresias: { some: { idcliente: admin.idcliente } },
      ...(dto.estado && dto.estado !== 'todos' ? { estado: dto.estado } : {}),
      ...(dto.q
        ? {
            OR: [
              { usuario: { contains: this.limpia(dto.q) } },
              { nombre: { contains: this.limpia(dto.q) } },
              { apellido: { contains: this.limpia(dto.q) } },
            ],
          }
        : {}),
    };

    const [total, filas] = await Promise.all([
      this.prisma.idn_usuario.count({ where }),
      this.prisma.idn_usuario.findMany({
        where,
        select: {
          idusuario: true,
          usuario: true,
          nombre: true,
          apellido: true,
          email: true,
          estado: true,
          mfa_estado: true,
          mfa_ultimo_periodo: true,
          membresiasAplicacion: {
            where: { idcliente: admin.idcliente },
            select: { idaplicacion: true },
            orderBy: { idaplicacion: 'asc' },
          },
        },
        orderBy: [{ usuario: 'asc' }],
        skip: (pagina - 1) * porPagina,
        take: porPagina,
      }),
    ]);

    // La ultima sesion viva por usuario: una consulta agrupada, no N+1. Es un dato
    // que el admin mira para decidir "este usuario entra o no", no un historial.
    const ids = filas.map((f) => f.idusuario);
    const [ultimas, codigos] = await Promise.all([
      this.ultimaSesionPorUsuario(ids, admin.idcliente),
      this.codigosMfaPorUsuario(ids),
    ]);

    return {
      total,
      pagina,
      por_pagina: porPagina,
      usuarios: filas.map((f) => ({
        idusuario: f.idusuario,
        usuario: f.usuario,
        nombre: f.nombre,
        apellido: f.apellido,
        email: f.email,
        estado: f.estado,
        apps: f.membresiasAplicacion.map((m) => m.idaplicacion),
        ultima_sesion: ultimas.get(f.idusuario) ?? null,
        mfa: this.mfaDe(f.mfa_estado, f.mfa_ultimo_periodo, codigos.get(f.idusuario) ?? 0),
      })),
    };
  }

  /** Miembros del cliente (todos, en cualquier estado). Es el "usuarios" del resumen. */
  async contarUsuarios(idcliente: string): Promise<number> {
    return this.prisma.idn_usuario_cliente.count({ where: { idcliente } });
  }

  /** Reparto por estado, para el resumen. `bloqueado` se cuenta como activo. */
  async contarPorEstado(idcliente: string): Promise<{ activos: number; inactivos: number }> {
    const filas = await this.prisma.idn_usuario.findMany({
      where: { membresias: { some: { idcliente } } },
      select: { estado: true },
    });

    let activos = 0;
    let inactivos = 0;
    for (const fila of filas) {
      if (fila.estado === 'inactivo') {
        inactivos += 1;
      } else {
        activos += 1;
      }
    }
    return { activos, inactivos };
  }

  /** Ficha de un usuario del tenant. 404 si no es miembro de este cliente. */
  async ficha(idusuario: string, idcliente: string): Promise<UsuarioAdmin> {
    const fila = await this.prisma.idn_usuario.findFirst({
      where: { idusuario, membresias: { some: { idcliente } } },
      select: {
        idusuario: true,
        usuario: true,
        nombre: true,
        apellido: true,
        email: true,
        estado: true,
        mfa_estado: true,
        mfa_ultimo_periodo: true,
        membresiasAplicacion: {
          where: { idcliente },
          select: { idaplicacion: true },
          orderBy: { idaplicacion: 'asc' },
        },
      },
    });
    if (!fila) {
      noEncontrado();
    }

    const [ultimas, codigos] = await Promise.all([
      this.ultimaSesionPorUsuario([idusuario], idcliente),
      this.codigosMfaPorUsuario([idusuario]),
    ]);

    return {
      idusuario: fila.idusuario,
      usuario: fila.usuario,
      nombre: fila.nombre,
      apellido: fila.apellido,
      email: fila.email,
      estado: fila.estado,
      apps: fila.membresiasAplicacion.map((m) => m.idaplicacion),
      ultima_sesion: ultimas.get(idusuario) ?? null,
      mfa: this.mfaDe(fila.mfa_estado, fila.mfa_ultimo_periodo, codigos.get(idusuario) ?? 0),
    };
  }

  /**
   * Apps **habilitables** para este cliente: las que existen en
   * `cat_cliente_aplicacion` y estan activas.
   *
   * Es la lista que la UI muestra para los checkboxes del alta, y sale del mismo
   * filtro que usa el authorize: habilitar en una app que no esta registrada para
   * el cliente daria una fila de habilitacion que el authorize nunca mira.
   */
  async appsDisponibles(admin: SesionAdmin): Promise<{ codigo: string; nombre: string }[]> {
    return this.prisma.cat_aplicacion.findMany({
      where: {
        estado: 'activo',
        clientes: { some: { idcliente: admin.idcliente, cliente: { estado: 'activo' } } },
      },
      select: { codigo: true, nombre: true },
      orderBy: { codigo: 'asc' },
    });
  }

  // --- privado ---------------------------------------------------------------

  /** `id` de la peticion: lo que viaja a `aud_login`. */
  /**
   * Las apps pedidas, filtradas por el cliente del admin.
   *
   * Se valida cada una contra `cat_cliente_aplicacion` del tenant: una app que
   * existe en el catalogo pero no para este cliente se rechaza con 400, y el
   * mensaje dice cual. Sin este chequeo, un POST con `aplicaciones: ["rhpro"]`
   * desde el panel de un cliente que no tiene `rhpro` crearia una habilitacion
   * invisible que nadie puede usar.
   */
  private async appsValidas(peticiones: string[], idcliente: string): Promise<string[]> {
    const pedidas = [...new Set(peticiones.map((a) => normalizarUsuario(a)))].filter(Boolean);
    if (pedidas.length === 0) {
      return [];
    }

    const validas = await this.prisma.cat_cliente_aplicacion.findMany({
      where: {
        idcliente,
        cliente: { estado: 'activo' },
        aplicacion: { estado: 'activo', codigo: { in: pedidas } },
      },
      select: { idaplicacion: true },
    });
    const aceptadas = new Set(validas.map((v) => v.idaplicacion));

    const rechazadas = pedidas.filter((p) => !aceptadas.has(p));
    if (rechazadas.length > 0) {
      peticionInvalida(`app_no_habilitable=${rechazadas.join(',')}`);
    }

    return pedidas;
  }

  private async appDelCliente(idaplicacion: string, idcliente: string): Promise<void> {
    const vinculo = await this.prisma.cat_cliente_aplicacion.findFirst({
      where: { idaplicacion, idcliente, cliente: { estado: 'activo' }, aplicacion: { estado: 'activo' } },
      select: { idaplicacion: true },
    });
    if (!vinculo) {
      // 404 y no 400: para el admin del cliente, una app que no es de su cliente es
      // indistinguible de una que no existe (invariante de `AGENTS.md`).
      noEncontrado();
    }
  }

  /** Usuario **del cliente**: 404 si existe en otro tenant pero no en este. */
  private async usuarioDelCliente(
    idusuario: string,
    idcliente: string,
  ): Promise<{ idusuario: string; usuario: string; estado: string }> {
    const fila = await this.prisma.idn_usuario.findFirst({
      where: { idusuario, membresias: { some: { idcliente } } },
      select: { idusuario: true, usuario: true, estado: true },
    });
    if (!fila) {
      noEncontrado();
    }
    return fila;
  }

  private async appsDe(idusuario: string, idcliente: string): Promise<string[]> {
    const filas = await this.prisma.idn_usuario_cliente_aplicacion.findMany({
      where: { idusuario, idcliente },
      select: { idaplicacion: true },
      orderBy: { idaplicacion: 'asc' },
    });
    return filas.map((f) => f.idaplicacion);
  }

  /**
   * `creado_en` de la sesion viva mas reciente de cada usuario, en una sola consulta.
   *
   * `groupBy` + `Map` en vez de una consulta por usuario: el listado de 100 filas
   * con N+1 son 100 viajes de ida y vuelta a la base para pintar una columna, y en
   * una red de cliente se nota.
   */
  private async ultimaSesionPorUsuario(
    idusuarios: string[],
    idcliente: string,
  ): Promise<Map<string, string>> {
    if (idusuarios.length === 0) {
      return new Map();
    }

    const ahora = new Date();
    const filas = await this.prisma.tok_sesion.groupBy({
      by: ['idusuario'],
      where: {
        idusuario: { in: idusuarios },
        idcliente,
        cerrada_en: null,
        expira_en: { gt: ahora },
      },
      _max: { creado_en: true },
    });

    const salida = new Map<string, string>();
    for (const fila of filas) {
      if (fila._max.creado_en) {
        salida.set(fila.idusuario, fila._max.creado_en.toISOString());
      }
    }
    return salida;
  }

  /**
   * Codigos de recuperacion sin usar, por usuario, en UNA consulta.
   *
   * `groupBy` + `Map` como `ultimaSesionPorUsuario`, y por el mismo motivo: 25
   * filas con N+1 son 25 viajes de ida y vuelta para pintar una columna, y en una
   * red de cliente se nota. El filtro `usado_en: null` es el que hace el conteo
   * una cuenta y no un historico.
   */
  private async codigosMfaPorUsuario(idusuarios: string[]): Promise<Map<string, number>> {
    if (idusuarios.length === 0) {
      return new Map();
    }

    const grupos = await this.prisma.idn_usuario_mfa_codigo.groupBy({
      by: ['idusuario'],
      where: { idusuario: { in: idusuarios }, usado_en: null },
      _count: { _all: true },
    });

    const salida = new Map<string, number>();
    for (const grupo of grupos) {
      salida.set(grupo.idusuario, grupo._count._all);
    }
    return salida;
  }

  /**
   * La forma del MFA que ve el panel.
   *
   * `mfa_secret_cifrada` **no** se pide en ningun `select` de este archivo: no es
   * que la columna este oculta en la respuesta, es que no llega a salir del
   * motor (criterio de aceptacion de la fase 09). `mfa_ultimo_periodo` si se pide
   * y sale, y es un dato de diagnóstico, no un secreto: es el período TOTP del
   * último código aceptado, y con el se responde "hace cuanto confirmo su
   * segundo factor".
   */
  private mfaDe(
    estado: string,
    ultimoPeriodo: bigint | null,
    codigosRestantes: number,
  ): EstadoMfaUsuario {
    const estadoMfa = estado as EstadoMfaUsuario['estado'];
    const off = estadoMfa === 'off';

    return {
      estado: estadoMfa,
      codigos_restantes: off ? 0 : codigosRestantes,
      aviso_pocos: !off && codigosRestantes <= AVISO_CODIGOS_POCOS,
      ultimo_periodo: ultimoPeriodo === null ? null : ultimoPeriodo.toString(),
    };
  }

  /**
   * Limpia lo que el usuario puede poner en la busqueda.
   *
   * `contains` de Prisma genera un `LIKE '%texto%'`, y `%` y `_` son comodines
   * para SQL: sin escapar, buscar `%` trae **todos** los usuarios del tenant. No es
   * unaInjection (el valor va como parametro), pero es un `LIKE` que hace lo que el
   * admin no pidio, y la respuesta va con los datos de todos.
   */
  private limpia(texto: string): string {
    return texto.replace(/[%_\\]/g, '');
  }
}

/** Lo que viaja a `aud_login` en cada escritura del panel. */
export interface Peticion {
  ip: string;
  userAgent: string;
}
