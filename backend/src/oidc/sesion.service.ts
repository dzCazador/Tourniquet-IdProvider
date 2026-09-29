import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { enDias, enHoras, REFRESH_TTL_DIAS, SESION_PORTAL_TTL_HORAS, SESION_TTL_DIAS } from './vidas';

export type MotivoCierre = 'logout' | 'revocada' | 'replay' | 'expirada';

export type Sesion = {
  sid: string;
  idusuario: string;
  idcliente: string;
  idaplicacion: string | null;
  amr: string;
  ip: string;
  user_agent: string;
  creado_en: Date;
  expira_en: Date;
  cerrada_en: Date | null;
  motivo_cierre: string | null;
};

export interface ContextoSesion {
  ip: string;
  userAgent: string;
}

/**
 * Ciclo de vida de `tok_sesion` y `tok_refresh_token`.
 *
 * Hay **una sesion por app** (`idaplicacion`), y ademas la del portal
 * (`idaplicacion IS NULL`, la que vive en la cookie). Es la distincion que hace
 * posible el "salir de todo" sin cerrar las apps de otros tenants, y la que hace
 * que cerrar sesion en una app no mate al portal (`specs/01` §2.1 y §4).
 *
 * Regla del archivo: las sesiones no se borran, se **cierran** (`cerrada_en` +
 * `motivo_cierre`). Un `DELETE` aca seria la forma corta de revocar tokens sin
 * dejar rastro, y `tok_sesion` es append-only con revocacion (invariante de
 * `AGENTS.md`).
 */
@Injectable()
export class SesionService {
  private readonly logger = new Logger(SesionService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Sesion por `sid`, exista o no. */
  async porSid(sid: string): Promise<Sesion | null> {
    if (!this.esUuid(sid)) {
      // Un valor que no es UUID no puede ser un `sid` de esta tabla. Filtrar
      // aca evita mandarle a la base una consulta con basura de header/cookie.
      return null;
    }
    return this.prisma.tok_sesion.findUnique({ where: { sid } });
  }

  /** Sesion **viva**: no cerrada y dentro de su vida absoluta. */
  async viva(sid: string): Promise<Sesion | null> {
    const sesion = await this.porSid(sid);
    if (!sesion) {
      return null;
    }
    return this.estaViva(sesion) ? sesion : null;
  }

  estaViva(sesion: Sesion, ahora = new Date()): boolean {
    return sesion.cerrada_en === null && sesion.expira_en > ahora;
  }

  /**
   * Sesion de una app: reusa la que ya este viva para ese usuario/cliente/app y
   * si no crea una.
   *
   * Reusar importa por dos razones. Una, que el mismo `sid` sobrevive a
   * re-entries del portal (el token de la app no queda huerfano). Dos, que sin
   * reuso cada visita al authorize abriria una fila: `tok_sesion` es la tabla
   * que el portal lista en "mis sesiones" y llenarla de muertas la hace
   * inutilizable.
   */
  async sesionDeApp(
    idusuario: string,
    idcliente: string,
    idaplicacion: string,
    amr: string,
    ctx: ContextoSesion,
  ): Promise<Sesion> {
    const ahora = new Date();

    const existente = await this.prisma.tok_sesion.findFirst({
      where: {
        idusuario,
        idcliente,
        idaplicacion,
        cerrada_en: null,
        expira_en: { gt: ahora },
      },
      orderBy: { creado_en: 'desc' },
    });

    if (existente) {
      return existente;
    }

    return this.prisma.tok_sesion.create({
      data: {
        sid: randomUUID(),
        idusuario,
        idcliente,
        idaplicacion,
        amr,
        ip: ctx.ip,
        user_agent: (ctx.userAgent || 'desconocido').slice(0, 500),
        creado_en: ahora,
        // Vida ABSOLUTA desde ahora. El refresh deslizante la respeta pero no
        // la extiende (specs/01 §3).
        expira_en: enDias(SESION_TTL_DIAS, ahora),
      },
    });
  }

  /**
   * Sesion central del portal. La crea `POST /auth/login` (Fase 04); este metodo
   * existe desde ya para que el camino de login y el de authorize compartan la
   * misma regla de vida y nobody tenga que inventarse la suya.
   */
  async sesionDePortal(idusuario: string, idcliente: string, ctx: ContextoSesion): Promise<Sesion> {
    const ahora = new Date();
    return this.prisma.tok_sesion.create({
      data: {
        sid: randomUUID(),
        idusuario,
        idcliente,
        idaplicacion: null,
        amr: 'pwd',
        ip: ctx.ip,
        user_agent: (ctx.userAgent || 'desconocido').slice(0, 500),
        creado_en: ahora,
        expira_en: enHoras(SESION_PORTAL_TTL_HORAS, ahora),
      },
    });
  }

  /**
   * Cierra una sesion y revoca su familia de refresh. Devuelve `true` si la
   * sesion existia y estaba viva (o sea, si esto sirvio de algo).
   *
   * Idempotente a proposito: cerrar dos veces no es un error, es lo que pasa
   * cuando el usuario aprieta logout y la app tambien manda su `/oidc/revoke`.
   */
  async cerrar(sid: string, motivo: MotivoCierre): Promise<boolean> {
    const sesion = await this.porSid(sid);
    if (!sesion) {
      return false;
    }

    const ahora = new Date();
    const familias = await this.revocarFamilia(sid, motivo, ahora);

    if (sesion.cerrada_en !== null) {
      return false;
    }

    await this.prisma.tok_sesion.update({
      where: { sid },
      data: { cerrada_en: ahora, motivo_cierre: motivo },
    });

    this.logger.log(
      `sesion cerrada sid=${sid.slice(0, 8)} motivo=${motivo} refresh_revocados=${familias}`,
    );
    return true;
  }

  /**
   * Revoca todos los refresh tokens vivos de una sesion (la "familia").
   *
   * La rotacion es una cadena, pero la familia se define por `sid`: todos los
   * refresh de esa sesion, el rotado y los que todavia no se usaron. Revocar
   * solo el eslabon dejaria vivo el ultimo token emitido, que es el que se
   * lleva el atacante.
   */
  async revocarFamilia(sid: string, motivo: MotivoCierre, ahora = new Date()): Promise<number> {
    const { count } = await this.prisma.tok_refresh_token.updateMany({
      where: { sid, revocado_en: null },
      data: { revocado_en: ahora, motivo },
    });
    return count;
  }

  /**
   * "Salir de todo": cierra **todas** las sesiones del usuario en el cliente,
   * la del portal y la de cada app. Un usuario de dos clientes no se ve afectado
   * en el otro: el filtro es `idcliente`, no `idusuario`.
   */
  async cerrarTodasDelCliente(idusuario: string, idcliente: string, motivo: MotivoCierre): Promise<number> {
    const ahora = new Date();
    const abiertas = await this.prisma.tok_sesion.findMany({
      where: { idusuario, idcliente, cerrada_en: null },
      select: { sid: true },
    });

    if (abiertas.length === 0) {
      return 0;
    }

    await this.revocarFamilias(abiertas.map((s) => s.sid), motivo, ahora);

    const { count } = await this.prisma.tok_sesion.updateMany({
      where: { idusuario, idcliente, cerrada_en: null },
      data: { cerrada_en: ahora, motivo_cierre: motivo },
    });

    this.logger.log(
      `salir de todo: usuario=${idusuario.slice(0, 8)} cliente=${idcliente} ` +
        `sesiones=${count} motivo=${motivo}`,
    );
    return count;
  }

  private async revocarFamilias(sids: string[], motivo: MotivoCierre, ahora: Date): Promise<number> {
    const { count } = await this.prisma.tok_refresh_token.updateMany({
      where: { sid: { in: sids }, revocado_en: null },
      data: { revocado_en: ahora, motivo },
    });
    return count;
  }

  /**
   * Vida de un refresh nuevo: 7 dias de inactividad, recortada por la vida
   * absoluta de la sesion. El recorte importa: sin el, "deslizante" extenderia
   * la sesion para siempre y `tok_sesion.expira_en` seria decorativo.
   */
  async expiraRefresh(sesion: Sesion, ahora = new Date()): Promise<Date> {
    const deslizante = enDias(REFRESH_TTL_DIAS, ahora);
    return deslizante < sesion.expira_en ? deslizante : sesion.expira_en;
  }

  /**
   * Refresh token por su huella. Lo usa `/oidc/revoke`: ahi la **posesion** del
   * token en claro es la credencial, asi que no hay nada que verificar, solo que
   * exista.
   */
  async refrescoPorHash(hash: string): Promise<{ sid: string; idaplicacion: string } | null> {
    return this.prisma.tok_refresh_token.findUnique({
      where: { token_hash: hash },
      select: { sid: true, idaplicacion: true },
    });
  }

  private esUuid(valor: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(valor);
  }
}
