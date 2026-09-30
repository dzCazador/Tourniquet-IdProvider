import { Injectable, Logger } from '@nestjs/common';
import { AuditoriaService, detalleDe } from '../auth/auditoria.service';
import { SesionService, type MotivoAdmin } from '../oidc/sesion.service';
import { noEncontrado } from '../registro/errores';
import { PrismaService } from '../prisma/prisma.service';
import type { SesionAdmin } from './admin.types';
import { TOPE_POR_PAGINA, type Peticion } from './admin.usuarios.service';

/** Sesión del panel: la de `tok_sesion` con los nombres resueltos y la IP entera. */
export interface SesionAdminRow {
  sid: string;
  idusuario: string;
  /** Siempre el cliente del admin: la fila se devuelve con el dato que la filtro. */
  idcliente: string;
  usuario: string;
  nombre: string;
  app: string;
  idaplicacion: string | null;
  es_portal: boolean;
  ip: string;
  user_agent: string;
  amr: string;
  creado_en: string;
  expira_en: string;
}

/**
 * Sesiones del tenant: listado y cierre forzado.
 *
 * **La IP va entera y no truncada** (al reves que en `/me/sesiones`): el lector de
 * esta pantalla es un admin que diagnostica, y "cerraron la sesión desde
 * 190.5.7.9" no se distingue de "cerraron la sesión desde 190.5.x.x". El que
 * recorta son las lecturas del usuario sobre sus propias sesiones, no las del admin
 * sobre las de su gente.
 *
 * Mismo criterio de filtro que `AdminUsuariosService`: `idcliente` en el `where`,
 * adentro, y el `idusuario IN (miembros del tenant)` para el listado de usuarios.
 */
@Injectable()
export class AdminSesionesService {
  private readonly logger = new Logger(AdminSesionesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sesiones: SesionService,
    private readonly auditoria: AuditoriaService,
  ) {}

  /**
   * Sesiones **vivas** de los miembros del tenant, de la más nueva a la más vieja.
   *
   * El filtro de membresía es la parte importante: `idcliente` solo alcanza si las
   * sesiones que se listan son de usuarios **de ese cliente**, y la forma de decirlo
   * es `usuario: { membresias: { some: { idcliente } } }` en la misma condición. Con
   * las dos (sesión del cliente + usuario del cliente) un admin de `cervi` no ve ni
   * una sesión de un usuario de `jugos`, aunque ese usuario tenga su sesión abierta
   * en este mismo portal.
   */
  async listar(
    admin: SesionAdmin,
    pagina = 1,
    porPagina = Math.min(TOPE_POR_PAGINA, 50),
  ): Promise<{ total: number; pagina: number; por_pagina: number; sesiones: SesionAdminRow[] }> {
    const ahora = new Date();
    const where = {
      cerrada_en: null,
      expira_en: { gt: ahora },
      // El filtro de tenant va primero, y el de usuario inmediatamente despues: los
      // dos juntos son la condicion de "esto es de mi cliente".
      usuario: { membresias: { some: { idcliente: admin.idcliente } } },
      cliente: { codigo: admin.idcliente },
    };

    const [total, filas] = await Promise.all([
      this.prisma.tok_sesion.count({ where }),
      this.prisma.tok_sesion.findMany({
        where,
        select: {
          sid: true,
          idusuario: true,
          idcliente: true,
          idaplicacion: true,
          amr: true,
          ip: true,
          user_agent: true,
          creado_en: true,
          expira_en: true,
          usuario: { select: { usuario: true, nombre: true, apellido: true } },
          aplicacion: { select: { nombre: true } },
        },
        orderBy: { creado_en: 'desc' },
        skip: (pagina - 1) * porPagina,
        take: porPagina,
      }),
    ]);

    return {
      total,
      pagina,
      por_pagina: porPagina,
      sesiones: filas.map((f) => ({
        sid: f.sid,
        idusuario: f.idusuario,
        idcliente: admin.idcliente,
        usuario: f.usuario.usuario,
        nombre: `${f.usuario.nombre} ${f.usuario.apellido}`.trim(),
        app: f.aplicacion?.nombre ?? 'Portal',
        idaplicacion: f.idaplicacion,
        es_portal: f.idaplicacion === null,
        ip: f.ip,
        user_agent: f.user_agent,
        amr: f.amr,
        creado_en: f.creado_en.toISOString(),
        expira_en: f.expira_en.toISOString(),
      })),
    };
  }

  /** Sesiones vivas de los miembros del tenant. Es el "sesiones_abiertas" del resumen. */
  async contarSesiones(idcliente: string): Promise<number> {
    return this.prisma.tok_sesion.count({
      where: {
        cerrada_en: null,
        expira_en: { gt: new Date() },
        cliente: { codigo: idcliente },
        usuario: { membresias: { some: { idcliente } } },
      },
    });
  }

  /**
   * Cierre forzado de una sesión del tenant, con motivo obligatorio.
   *
   * Tres cosas que hacen que esto no sea "un delete":
   *
   *  1. **El filtro de tenant va en la consulta** (`vivaDeTenant`), no despues: un
   *     `sid` de otro cliente da `null` y la respuesta es 404, idéntica a la de un
   *     `sid` que no existe. Un 403 confirmaría que ese `sid` existe.
   *  2. **El motivo es obligatorio y va a la fila** (`tok_sesion.motivo_cierre`),
   *     no solo a la auditoría: un cierre de sesión sin explicación es
   *     indistinguible de un abuso, y el motivo es lo primero que se mira cuando se
   *     investiga un acceso. Los cinco valores son los del CHECK de la columna.
   *  3. **La familia de refresh se revoca con `revocada`**, no con el motivo humano
   *     (ver `SesionService.cerrar`): el motivo de una persona no describe un token.
   *
   * El access ya emitido sigue siendo criptográficamente válido hasta 15 minutos,
   * pero `/userinfo` lo rechaza porque el `sid` está muerto: es el mismo mecanismo
   * que usa el logout, y por eso el panel no necesita inventar nada para que el
   * cierre sirva.
   */
  async cerrar(
    sid: string,
    motivo: MotivoAdmin,
    admin: SesionAdmin,
    ctx: Peticion,
  ): Promise<{ sid: string; motivo: MotivoAdmin; usuario: string }> {
    const sesion = await this.sesiones.vivaDeTenant(sid, admin.idcliente);
    if (!sesion) {
      noEncontrado();
    }

    // El filtro de usuario tambien: que la sesión sea del cliente no alcanza si el
    // usuario fue dado de baja del cliente y su sesión quedo abierta. Es el mismo
    // criterio que el listado, y por el mismo motivo.
    const miembro = await this.prisma.idn_usuario_cliente.findUnique({
      where: { idusuario_idcliente: { idusuario: sesion.idusuario, idcliente: admin.idcliente } },
      select: { idusuario: true, usuario: { select: { usuario: true } } },
    });
    if (!miembro) {
      noEncontrado();
    }

    await this.sesiones.cerrar(sid, motivo);

    await this.auditoria.registrarSeguro({
      resultado: 'ok',
      idusuario: admin.idusuario,
      idaplicacion: sesion.idaplicacion,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      // `specs/01` §7: el `idusuario` es **quien actuó** (el admin) y el afectado
      // viaja en el `detalle`, con el `sid` y el motivo. Es lo que hace que la fila
      // sirva para "quién le cerró la sesión a este usuario y por qué".
      detalle: detalleDe('admin_cierra_sesion', {
        usuario: sesion.idusuario,
        cliente: admin.idcliente,
        sid: sesion.sid.slice(0, 8),
        motivo,
      }),
    });

    this.logger.log(
      `cierre forzado sid=${sesion.sid.slice(0, 8)} usuario=${sesion.idusuario.slice(0, 8)} ` +
        `cliente=${admin.idcliente} motivo=${motivo} por=${admin.usuario}`,
    );

    return { sid: sesion.sid, motivo, usuario: miembro.usuario.usuario };
  }
}
