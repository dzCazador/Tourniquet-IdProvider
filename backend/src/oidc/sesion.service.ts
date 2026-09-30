import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { enDias, enHoras, REFRESH_TTL_DIAS, SESION_PORTAL_TTL_HORAS, SESION_TTL_DIAS } from './vidas';

export type MotivoCierre = 'logout' | 'revocada' | 'replay' | 'expirada';

/**
 * Motivos que elige **una persona** al forzar el cierre desde el panel de
 * `admin_identidad` (Fase 08 §5).
 *
 * Son una lista distinta de `MotivoCierre` a proposito, y no un `string` mas: son
 * los unicos cinco valores que el CHECK de `tok_sesion.motivo_cierre` acepta **por
 * decision de una persona**, y el tipo es lo que obliga a que el DTO los valide y a
 * que la escritura de la sesion no los mezcle con los tecnicos.
 */
export const MOTIVOS_ADMIN = [
  'soporte',
  'sospecha',
  'reemplazo',
  'solicitud_del_usuario',
  'otro',
] as const;

export type MotivoAdmin = (typeof MOTIVOS_ADMIN)[number];

/** `true` si el motivo lo eligio una persona (y no el sistema). */
export function esMotivoAdmin(motivo: string): motivo is MotivoAdmin {
  return (MOTIVOS_ADMIN as readonly string[]).includes(motivo);
}

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
 * Sesión con los nombres de la app y del cliente ya resueltos, que es como la
 * muestran las dos pantallas que la listan (`/me/sesiones` y `/admin/sesiones`).
 */
export interface SesionConNombres extends Sesion {
  /** `null` en la sesión del portal: el portal no es una app. */
  aplicacion: { nombre: string } | null;
  cliente: { nombre: string };
}

/**
 * IP con los dos ultimos octetos ocultos: `190.5.x.x`.
 *
 * Se usa en **las sesiones propias** (`/me/sesiones`), no en las del panel de
 * admin. La razon es que las dos pantallas tienen readershipes distintas: un
 * usuario no necesita ver el octeto de su propia IP para reconocer su sesion, y en
 * un puesto de trabajo compartido la pantalla es visible para los que estan al
 * lado; un admin, en cambio, diagnostica con la IP entera y para eso la pide.
 *
 * El prefijo `::ffff:` se quita antes de truncar: es como Express entrega una IPv4
 * cuando el socket es IPv6 (`req.ip` sale `::ffff:127.0.0.1` en `next dev` y en
 * cualquier proxy IPv6), y sin quitarlo el resultado era `::ffff:127.0.x.x`, que no
 * es una IP ni un `x.x` y se ve como un dato roto.
 *
 * Una IP que no es IPv4 —un IPv6 de verdad, un unix socket, un `localhost` de
 * desarrollo— se devuelve como "origen local" en vez de deformarse: truncar un
 * IPv6 por puntos es inventar una direccion que no existe.
 */
export function ipTruncada(ip: string): string {
  const limpio = ip.startsWith('::ffff:') ? ip.slice('::ffff:'.length) : ip;
  const partes = limpio.split('.');
  if (partes.length !== 4) {
    return partes.length > 1 ? 'origen local' : limpio;
  }
  return `${partes[0]}.${partes[1]}.x.x`;
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
   * Sesiones **vivas** de un usuario en un cliente, de la mas nueva a la mas vieja.
   *
   * El filtro va entero en el `where` —usuario, cliente, abierta, sin vencer— y no
   * como un `if` sobre un `findMany` sin filtro: `/me/sesiones` y `/admin/sesiones`
   * muestran datos de otros tenants si el filtro se olvida en alguno, y ese error no
   * se ve en la pantalla (la lista sale vacía o con gente de más) sino en la prueba
   * de travesía de la fase, que es la unica que lo caza (invariante de `AGENTS.md`).
   *
   * Trae el nombre de la app y del cliente por relación, no por codigo: la lista
   * es para que una persona lea "RHPro, desde las 14:05", y mostrar `rhpro`
   * significaría que el portal obliga a saber el código de la app.
   */
  async activasDe(idusuario: string, idcliente: string): Promise<SesionConNombres[]> {
    return this.prisma.tok_sesion.findMany({
      where: { idusuario, idcliente, cerrada_en: null, expira_en: { gt: new Date() } },
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
        cerrada_en: true,
        motivo_cierre: true,
        aplicacion: { select: { nombre: true } },
        cliente: { select: { nombre: true } },
      },
      orderBy: { creado_en: 'desc' },
    });
  }

  /**
   * Sesion viva **de ese usuario y de ese cliente**, o `null`.
   *
   * Es el filtro que hace que `DELETE /me/sesiones/:sid` de un `sid` ajeno sea un
   * 404 y no un cierre: la consulta lleva `idusuario` e `idcliente` adentro, así
   * que un `sid` de otro usuario es indistinguible de uno que no existe. Cerrar la
   * sesión de otro no sería un permiso, sería un agujero.
   */
  async vivaDeUsuario(sid: string, idusuario: string, idcliente: string): Promise<Sesion | null> {
    if (!this.esUuid(sid)) {
      return null;
    }

    const sesion = await this.prisma.tok_sesion.findFirst({
      where: { sid, idusuario, idcliente, cerrada_en: null, expira_en: { gt: new Date() } },
    });
    return sesion;
  }

  /**
   * Sesión viva de un `sid` **con filtro de tenant**, para el cierre forzado del
   * panel de admin (`specs/01` §7).
   *
   * Es el mismo criterio que `vivaDeUsuario` y por el mismo motivo: un `sid` de otro
   * cliente da `null` y el panel responde 404, no "ese `sid` es de jugos".
   */
  async vivaDeTenant(sid: string, idcliente: string): Promise<Sesion | null> {
    if (!this.esUuid(sid)) {
      return null;
    }

    return this.prisma.tok_sesion.findFirst({
      where: { sid, idcliente, cerrada_en: null, expira_en: { gt: new Date() } },
    });
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
   *
   * **Los motivos de una persona no describen un refresh.** Cuando el motivo es
   * del panel (`sospecha`, `soporte`, …), la familia se revoca con `revocada` y el
   * motivo humano queda solo en `tok_sesion.motivo_cierre` y en `aud_login`. Es
   * tambien una necesidad del esquema: `tok_refresh_token.motivo` tiene su propia
   * lista cerrada, sin los cinco del panel, y escribir ahi un valor de persona
   * reventaria el CHECK en el momento de revocar — o sea, en el peor momento, con
   * la sesion a medio cerrar.
   */
  async cerrar(sid: string, motivo: MotivoCierre | MotivoAdmin): Promise<boolean> {
    const sesion = await this.porSid(sid);
    if (!sesion) {
      return false;
    }

    const ahora = new Date();
    const motivoFamilia: MotivoCierre = esMotivoAdmin(motivo) ? 'revocada' : motivo;
    const familias = await this.revocarFamilia(sid, motivoFamilia, ahora);

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
