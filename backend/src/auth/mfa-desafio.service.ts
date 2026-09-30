import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { enMinutos } from '../oidc/vidas';

/**
 * Intentos de codigo incorrecto antes de que el desafío muera.
 *
 * **No** se suman a `idn_usuario.intentos_fallidos` (`specs/01` §8.2): ese
 * contador bloquea la **contraseña** 15 minutos, y mezclarlos dejaría a un
 * usuario con la clave correcta bloqueado por teclear mal un codigo. Son dos
 * bloqueos distintos, con dos consecuencias distintas: uno es "tu cuenta está
 * bajo ataque por fuerza bruta de clave" y el otro es "este intento de ingreso
 * falló"; mezclados en una columna, la auditoría no puede separarlos.
 */
export const MAX_INTENTOS_MFA = 5;

/** Vida del desafío: 5 minutos (`specs/01` §8.2). */
export const VIDA_DESAFIO_MIN = 5;

export type Desafio = {
  id: string;
  idusuario: string;
  idcliente: string;
  return_to: string;
  ip: string;
  user_agent: string;
  creado_en: Date;
  expira_en: Date;
  intentos: number;
  usado_en: Date | null;
};

export interface ContextoIntentoDisafio {
  ip: string;
  userAgent: string;
}

export type MotivoRechazo = 'desconocido' | 'vencido' | 'usado' | 'intentos_agotados';

/**
 * `tok_mfa_challenge`: el estado de un login **en curso** que todavía no es
 * sesión (`specs/01` §8.2).
 *
 * Existe porque el login con MFA son dos pedidos y entre los dos tiene que
 * sobrevivir la respuesta a "de qué usuario, de qué cliente y a qué destino se
 * trata". Las otras dos salidas que se consideraron y por qué no:
 *
 *   - **En la respuesta y de vuelta en el pedido**: el cliente elige el `tenant`
 *     y el destino, que es exactamente lo que `AGENTS.md` prohíbe.
 *   - **En una cookie firmada**: una cookie no firmada es peor (cualquiera la
 *     escribe), y una firmada necesita una clave y un formato que acá ya existen
 *     para otra cosa (`MasterKeyService`). La fila además deja contador de
 *     intentos, que una cookie no puede llevar sin firma.
 *
 * El `id` de la fila es el `factor_id` que viaja en la respuesta del login. No es
 * un token: sin el codigo del segundo factor no sirve para nada, y vive 5
 * minutos.
 */
@Injectable()
export class MfaDesafioService {
  private readonly logger = new Logger(MfaDesafioService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Abre un desafío para un login que ya pasó la contraseña.
   *
   * Los valores que se guardan (usuario, cliente, destino) ya vienen resueltos
   * del paso 1: el `idcliente` salió de las membresías del usuario y el
   * `return_to` pasó por `validarReturnTo`. Acá no se vuelve a decidir ninguno de
   * los dos, y en `POST /auth/mfa/verify` no se reciben.
   */
  async crear(
    idusuario: string,
    idcliente: string,
    returnTo: string,
    ctx: ContextoIntentoDisafio,
  ): Promise<Desafio> {
    const ahora = new Date();

    const fila = await this.prisma.tok_mfa_challenge.create({
      data: {
        id: randomUUID(),
        idusuario,
        idcliente,
        return_to: returnTo,
        ip: ctx.ip,
        user_agent: (ctx.userAgent || 'desconocido').slice(0, 500),
        creado_en: ahora,
        expira_en: enMinutos(VIDA_DESAFIO_MIN, ahora),
        intentos: 0,
      },
    });

    this.logger.log(
      `desafio MFA abierto id=${fila.id.slice(0, 8)} usuario=${idusuario.slice(0, 8)} ` +
        `cliente=${idcliente} expira=${fila.expira_en.toISOString()}`,
    );

    return fila;
  }

  /**
   * El desafío, si todavía se puede usar, o el motivo por el que no.
   *
   * Los cuatro motivos se devuelven **separados** a propósito: la UI los trata
   * distinto ("volvé a ingresar" en todos, pero el mensaje de "usado" es otro
   * que el de "incorrecto") y la auditoría registra `replay` en un caso y
   * `claves` en otro. Con un `null` unico, los cuatro se colapsan en "algo fallo" y se pierde el
   * reuso, que es la senal que importa.
   *
   * `intentos >= MAX` mata el desafío: es un límite **por desafío**, no
   * acumulado. Un usuario que falló dos veces en un ingreso y abre otro tiene
   * cinco intentos nuevos, que es lo que espera alguien que se equivoca dos
   * veces por tecleo.
   */
  async vigente(factorId: string): Promise<{ desafio: Desafio } | { motivo: MotivoRechazo }> {
    if (!esUuid(factorId)) {
      // Sin UUID no hay fila: se filtra antes de tocar la base, y un `factor_id`
      // mal formado es un pedido mal formado, no un "desconocido".
      return { motivo: 'desconocido' };
    }

    const fila = await this.prisma.tok_mfa_challenge.findUnique({ where: { id: factorId } });

    if (!fila) {
      return { motivo: 'desconocido' };
    }

    if (fila.usado_en !== null) {
      return { motivo: 'usado' };
    }

    if (fila.expira_en <= new Date()) {
      return { motivo: 'vencido' };
    }

    if (fila.intentos >= MAX_INTENTOS_MFA) {
      return { motivo: 'intentos_agotados' };
    }

    return { desafio: fila };
  }

  /**
   * Suma un intento fallido y devuelve cuántos quedan.
   *
   * `0` significa que este fue el último: el desafío muere y el usuario tiene
   * que volver a ingresar. No se hace `delete` ni se marca usado: la fila se
   * purga por edad con el job 95, y una fila de intento fallido es evidencia de
   * un intento de acceso, no basura.
   */
  async registrarIntentoFallido(id: string): Promise<number> {
    const { count } = await this.prisma.tok_mfa_challenge.updateMany({
      where: { id, usado_en: null, intentos: { lt: MAX_INTENTOS_MFA } },
      data: { intentos: { increment: 1 } },
    });

    if (count === 0) {
      return 0;
    }

    const fila = await this.prisma.tok_mfa_challenge.findUnique({
      where: { id },
      select: { intentos: true },
    });

    const restantes = Math.max(0, MAX_INTENTOS_MFA - (fila?.intentos ?? MAX_INTENTOS_MFA));
    this.logger.log(`intento MFA fallido id=${id.slice(0, 8)} quedan=${restantes}`);
    return restantes;
  }

  /**
   * Marca el desafío como usado, después de un codigo correcto.
   *
   * El `where` con `usado_en: null` es lo que lo hace de un solo uso: dos
   * verificaciones concurrentes del mismo codigo, y sólo una cierra la
   * sesión. La que pierde recibe `count: 0` y el llamador responde que el codigo
   * ya se usó.
   */
  async marcarUsado(id: string, ahora: Date = new Date()): Promise<boolean> {
    const { count } = await this.prisma.tok_mfa_challenge.updateMany({
      where: { id, usado_en: null },
      data: { usado_en: ahora },
    });

    if (count > 0) {
      this.logger.log(`desafio MFA cerrado id=${id.slice(0, 8)}`);
    }

    return count > 0;
  }
}

function esUuid(valor: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(valor);
}
