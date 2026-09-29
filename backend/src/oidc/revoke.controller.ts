import { Body, Controller, HttpCode, Ip, Post, Req, UseFilters } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { AuditoriaService } from '../auth/auditoria.service';
import { esJwt, sha256Hex } from './codigos';
import { ErrorOidc, FiltroErroresOidc } from './errores';
import { SesionService } from './sesion.service';
import { ValidadorService } from './validador.service';

/**
 * `POST /oidc/revoke` (RFC 7009).
 *
 * Responde **200 siempre**, exista o no el token. Confirmar o negar si una
 * credencial existe convierte el endpoint en un oraculo de credenciales validas,
 * y RFC 7009 lo dice explicitamente: la respuesta no confirma ni niega nada.
 * Por eso el unico 4xx posible es el pedido mal formado (sin `token`).
 *
 * Que muere, en realidad, y que sigue vivo:
 *
 * | Credencial | Que se revoca | Que sigue |
 * |---|---|---|
 * | refresh de la app | la sesion de esa app (su refresh entero) | sesion central y otras apps |
 * | access de la app | la sesion de esa app | idem |
 *
 * Es el "cerrar esta app" de `specs/01` §4. "Salir de todo" es `/oidc/logout`.
 */
@Controller('oidc')
@UseFilters(FiltroErroresOidc)
export class RevokeController {
  private readonly issuer: string;

  constructor(
    private readonly sesiones: SesionService,
    private readonly validador: ValidadorService,
    private readonly auditoria: AuditoriaService,
    config: ConfigService,
  ) {
    this.issuer = config.getOrThrow<string>('TQ_ISSUER');
  }

  @Post('revoke')
  @HttpCode(200)
  async revocar(
    @Body() body: Record<string, unknown>,
    @Ip() ip: string,
    @Req() req: Request,
  ): Promise<{ revocado: true }> {
    const token = typeof body?.token === 'string' ? body.token : '';
    if (!token) {
      throw new ErrorOidc('invalid_request');
    }

    const ctx = { ip, userAgent: req.get('user-agent') ?? 'desconocido' };

    // Un JWT son tres segmentos; el refresh es opaco. Solo se usa para elegir
    // **como** se busca la credencial, nunca para decidir si se cree.
    if (esJwt(token)) {
      await this.revocarAccess(token, ctx);
    } else {
      await this.revocarRefresh(token, ctx);
    }

    return { revocado: true };
  }

  private async revocarRefresh(
    token: string,
    ctx: { ip: string; userAgent: string },
  ): Promise<void> {
    const fila = await this.sesiones.refrescoPorHash(sha256Hex(token));
    if (!fila) {
      return;
    }

    const sesion = await this.sesiones.porSid(fila.sid);
    await this.sesiones.cerrar(fila.sid, 'revocada');
    await this.auditar(ctx, sesion?.idusuario ?? null, fila.idaplicacion);
  }

  /**
   * Un access token solo se usa para revocar si **verifica**. Un token vencido o
   * con firma manipulada no dice de que sesion viene sin confiar en el, y cerrar
   * una sesion a partir de un `sid` sin verificar seria un DoS: alcanza con que
   * alguien se entere de un `sid` para matar la sesion de otro.
   */
  private async revocarAccess(
    token: string,
    ctx: { ip: string; userAgent: string },
  ): Promise<void> {
    const resultado = await this.validador.validar(token, { issuer: this.issuer });
    if (!resultado.ok) {
      return;
    }

    const sid = typeof resultado.payload.sid === 'string' ? resultado.payload.sid : '';
    if (!sid) {
      return;
    }

    const sesion = await this.sesiones.porSid(sid);
    if (!sesion) {
      return;
    }

    await this.sesiones.cerrar(sid, 'revocada');
    await this.auditar(ctx, sesion.idusuario, sesion.idaplicacion);
  }

  private async auditar(
    ctx: { ip: string; userAgent: string },
    idusuario: string | null,
    idaplicacion: string | null,
  ): Promise<void> {
    await this.auditoria.registrarSeguro({
      resultado: 'ok',
      idusuario,
      idaplicacion,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      detalle: 'sesion_revocada',
    });
  }
}
