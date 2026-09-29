import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { ClaimsAccess } from '../claves/firma.service';
import { PrismaService } from '../prisma/prisma.service';
import { Sesion } from './sesion.service';

/**
 * Construccion del access token: exactamente la tabla de `specs/01` §2, ni un
 * claim mas.
 *
 * El motivo de que sea un unico lugar y no "algo que arma cada endpoint" es
 * `D2` de `specs/00` y la regla transversal 2 de `specs/04`: un claim de
 * negocio en el token es un defecto, y un token distinto por endpoint es
 * exactamente como empieza. Un claim nuevo se agrega aca **despues** de
 * actualizar la tabla del spec, no antes.
 *
 * Todos los valores salen de la base de control o del config, nunca de un
 * parametro del request. El `tenant` viene de la sesion, no de un query
 * (invariante de `AGENTS.md`).
 */
@Injectable()
export class ClaimsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async construir(sesion: Sesion): Promise<ClaimsAccess> {
    const usuario = await this.prisma.idn_usuario.findUnique({
      where: { idusuario: sesion.idusuario },
      select: { idusuario: true, nombre: true, apellido: true },
    });

    if (!usuario) {
      // Sesion sin usuario es un estado imposible por FK. Si aparece, es un bug
      // o una fila borrada a mano: mejor un error ruidoso que un token sin `sub`.
      throw new Error(`La sesion ${sesion.sid} apunta a un usuario inexistente.`);
    }

    const claims: ClaimsAccess = {
      iss: this.config.getOrThrow<string>('TQ_ISSUER'),
      sub: usuario.idusuario,
      aud: sesion.idaplicacion ?? '',
      tenant: sesion.idcliente,
      nombre: `${usuario.nombre} ${usuario.apellido}`.trim(),
      sid: sesion.sid,
      amr: this.amr(sesion.amr),
      jti: randomUUID(),
    };

    const base = await this.baseActiva(sesion.idcliente, claims.aud);
    if (base) {
      claims.base = base;
    }

    return claims;
  }

  /**
   * `amr` es una lista en el token y un `nvarchar(50)` en la base ("pwd" o
   * "pwd,mfa"). La conversion va aca para que ningun endpoint pueda emitir un
   * `amr` con el formato de la columna.
   */
  private amr(valor: string): string[] {
    return valor
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
  }

  /**
   * Claim `base`: el nombre de la base de negocio de ESTA instalacion.
   *
   * Sale de la combinacion activa cliente+app. El indice
   * `UQ_cat_base_datos_cliente_aplicacion_activa` garantiza que hay a lo sumo
   * una, pero el codigo igual lo pide: si alguna vez hay dos (o cero), el claim
   * se **omite** en vez de adivinar. Un `base` equivocado en el token manda a la
   * app a la base equivocada, y eso no es un problema de formato.
   */
  private async baseActiva(idcliente: string, idaplicacion: string): Promise<string | null> {
    const bases = await this.prisma.cat_base_datos.findMany({
      where: { idcliente, idaplicacion, estado: 'activo' },
      select: { base: true },
      take: 2,
    });

    return bases.length === 1 ? bases[0].base : null;
  }
}
