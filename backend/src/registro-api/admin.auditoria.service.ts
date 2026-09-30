import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TOPE_POR_PAGINA } from './admin.usuarios.service';
import type { ListadoAuditoriaDto } from './dto/admin.dto';
import type { SesionAdmin } from './admin.types';

/** Evento de `aud_login` como lo ve el panel. */
export interface EventoAuditoria {
  id: number;
  ts: string;
  /** `null` cuando el login fue de un usuario que no existe. */
  usuario: string | null;
  idusuario: string | null;
  nombre: string | null;
  idaplicacion: string | null;
  resultado: string;
  detalle: string | null;
  /** Código suelto del `detalle`: la columna es `codigo|k=v` (`specs/01` §7). */
  codigo: string | null;
  ip: string;
  /**
   * El `user_agent` **crudo**, tal como lo guardo el sistema.
   *
   * El resumen a "Chrome 120 / Windows" lo arma el front
   * (`frontend/src/lib/user-agent.ts`): guardar el crudo y resumir en la pantalla es
   * lo que permite que el resumen mejore sin perder el dato de diagnostico, y lo que
   * hace que este endpoint no tenga que mantener un parser de user agents.
   */
  user_agent: string;
  /** `null` cuando el `detalle` no trae `k=v` reconocibles. */
  contexto: Record<string, string> | null;
}

/**
 * Lectura de `aud_login` para el admin de un cliente.
 *
 * **El filtro es por membresía, no por `idcliente` del evento.** `aud_login` no
 * tiene columna de cliente: un login fallido de un usuario de `jugos` que se
 * equivoca la clave en este IdP es una fila con `idusuario` de un usuario de
 * `jugos` y **la IP de esa persona**. Sin el filtro por membresía, el admin de
 * `cervi` vería los intentos de login de todos los tenants de la instalación, con
 * sus IPs y sus navegadores: es la travesía entre tenants más fácil de colar en
 * este panel (trampa 1 de la fase 08) y por eso el filtro va en el `where` de la
 * consulta, no en un `if` del servicio.
 *
 * Los eventos con `idusuario IS NULL` (login de un usuario inexistente) **no**
 * aparecen nunca: sin `idusuario` no hay forma de saber si el que se equivocó es de
 * este cliente o de otro, y un intento de login contra una cuenta que no existe no
 * le sirve a nadie de este panel. Para ver eso está la base.
 */
@Injectable()
export class AdminAuditoriaService {
  private readonly logger = new Logger(AdminAuditoriaService.name);

  constructor(private readonly prisma: PrismaService) {}

  async listar(
    dto: ListadoAuditoriaDto,
    admin: SesionAdmin,
  ): Promise<{ total: number; pagina: number; por_pagina: number; eventos: EventoAuditoria[] }> {
    const pagina = Math.max(1, dto.pagina ?? 1);
    const porPagina = Math.min(TOPE_POR_PAGINA, Math.max(1, dto.por_pagina ?? 50));

    // Los miembros del tenant, como lista de `idusuario`. Es la Translate que hace
    // el filtro de la travesia: sin esto, `where: {}`.
    const miembros = await this.prisma.idn_usuario_cliente.findMany({
      where: { idcliente: admin.idcliente },
      select: { idusuario: true },
    });
    const idusuarios = miembros.map((m) => m.idusuario);

    const desde = this.aFecha(dto.desde);
    const hasta = this.aFecha(dto.hasta, true);

    const where = {
      idusuario: { in: idusuarios },
      ...(dto.resultado ? { resultado: dto.resultado } : {}),
      ...(dto.detalle ? { detalle: { contains: this.limpia(dto.detalle) } } : {}),
      ...(desde || hasta
        ? { ts: { ...(desde ? { gte: desde } : {}), ...(hasta ? { lte: hasta } : {}) } }
        : {}),
    };

    // Filtro por `usuario` (el login, no el UUID): el admin conoce "jperez", no el
    // `idusuario`. Se resuelve a una lista de UUID con una consulta y se cruza con
    // la de los miembros: los dos filtros juntos, y no uno o el otro.
    const whereUsuario = dto.usuario ? await this.idusuariosQueEmpiezanCon(dto.usuario) : null;
    const whereFinal =
      whereUsuario && whereUsuario.length > 0
        ? { ...where, idusuario: { in: whereUsuario } }
        : where;

    const [total, filas] = await Promise.all([
      this.prisma.aud_login.count({ where: whereFinal }),
      this.prisma.aud_login.findMany({
        where: whereFinal,
        select: {
          id: true,
          ts: true,
          idusuario: true,
          idaplicacion: true,
          resultado: true,
          detalle: true,
          ip: true,
          user_agent: true,
          usuario: { select: { usuario: true, nombre: true, apellido: true } },
        },
        orderBy: { id: 'desc' },
        skip: (pagina - 1) * porPagina,
        take: porPagina,
      }),
    ]);

    return {
      total,
      pagina,
      por_pagina: porPagina,
      eventos: filas.map((f) => {
        const partes = this.separarDetalle(f.detalle);
        return {
          id: f.id,
          ts: f.ts.toISOString(),
          usuario: f.usuario?.usuario ?? null,
          idusuario: f.idusuario,
          nombre: f.usuario ? `${f.usuario.nombre} ${f.usuario.apellido}`.trim() : null,
          idaplicacion: f.idaplicacion,
          resultado: f.resultado,
          detalle: partes.codigo,
          codigo: partes.codigo,
          ip: f.ip,
          user_agent: f.user_agent,
          contexto: partes.contexto,
        };
      }),
    };
  }

  /** Eventos de los miembros del tenant desde una fecha. Es el "eventos_24h". */
  async contarEventos(idcliente: string, desde: Date): Promise<number> {
    return this.prisma.aud_login.count({
      where: { ts: { gte: desde }, usuario: { membresias: { some: { idcliente } } } },
    });
  }

  /**
   * `idusuario` de los miembros del tenant cuyo login empieza con el texto buscado.
   *
   * Intersecta **con los miembros del tenant**, no con todos los usuarios: un
   * `jperez` de otro cliente no puede servir para descubrir que existe.
   */
  private async idusuariosQueEmpiezanCon(texto: string): Promise<string[]> {
    const filas = await this.prisma.idn_usuario_cliente.findMany({
      where: {
        cliente: { estado: 'activo' },
        usuario: { usuario: { contains: this.limpia(texto) } },
      },
      select: { idusuario: true },
    });
    return filas.map((f) => f.idusuario);
  }

  /**
   * Parte `codigo|k=v|k=v` en sus dos mitades.
   *
   * El `detalle` es texto libre con estructura (`specs/01` §7), y el panel lo
   * muestra: el codigo como columna y los identificadores aparte. Un `detalle` con
   * un `|` que no parece `k=v` se devuelve entero como codigo, sin fallar: la
   * lectura de auditoría no puede romperse por una fila rara.
   */
  private separarDetalle(detalle: string | null): { codigo: string | null; contexto: Record<string, string> | null } {
    if (!detalle) {
      return { codigo: null, contexto: null };
    }

    const partes = detalle.split('|');
    const codigo = partes[0] ?? null;
    const contexto: Record<string, string> = {};

    for (const parte of partes.slice(1)) {
      const igual = parte.indexOf('=');
      if (igual > 0) {
        contexto[parte.slice(0, igual)] = parte.slice(igual + 1);
      }
    }

    return { codigo, contexto: Object.keys(contexto).length > 0 ? contexto : null };
  }

  /**
   * Fecha del filtro, en ISO o `YYYY-MM-DD`.
   *
   * `YYYY-MM-DD` se interpreta como **inicio del dia** para `desde` y como **fin del
   * dia** para `hasta`: si no, "hoy" en el filtro `hasta` seria las 00:00 de hoy y no
   * se vería nada del día que el admin está mirando.
   */
  private aFecha(texto: string | undefined, finDelDia = false): Date | null {
    if (!texto) {
      return null;
    }
    const soloDia = /^\d{4}-\d{2}-\d{2}$/.test(texto);
    const fecha = new Date(soloDia ? `${texto}T${finDelDia ? '23:59:59.999' : '00:00:00.000'}Z` : texto);
    return Number.isNaN(fecha.getTime()) ? null : fecha;
  }

  private limpia(texto: string): string {
    return texto.replace(/[%_\\]/g, '');
  }
}
