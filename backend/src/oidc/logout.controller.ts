import {
  Body,
  Controller,
  Get,
  HttpCode,
  Ip,
  Logger,
  Post,
  Query,
  Req,
  Res,
  UseFilters,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuditoriaService } from '../auth/auditoria.service';
import { agregarParametros } from './authorize.service';
import { AplicacionService } from './aplicacion.service';
import { borrarCookieDeSesion, sidDeLaPeticion } from './cookies';
import { ErrorOidc, FiltroErroresOidc } from './errores';
import { SesionService } from './sesion.service';

/**
 * `GET` y `POST /oidc/logout`: "salir de todo".
 *
 * Mata **todas** las sesiones del usuario en el cliente: la del portal y la de
 * cada app (`specs/01` §4). No es lo mismo que `/oidc/revoke`, que cierra una
 * sola app. La distincion es la de la tabla de la Fase 03 y depende de que
 * `tok_sesion` tenga una fila por app.
 *
 * Dos endpoints y no uno porque el RFC 9457 (`end_session_endpoint`) lo define
 * como GET navegable para que funcione con `<a href>` y `window.close()`, y
 * ademas POST para los clientes que lo llaman por `fetch`. Ambos hacen
 * exactamente lo mismo.
 *
 * `post_logout_redirect_uri` se valida **exacto** contra `redirect_uris_json` de
 * la app, igual que el `redirect_uri` del authorize. Es la misma defensa: sin
 * comparacion exacta, cualquiera podria mandar a un usuario a una pagina con su
 * `state` pegado. No hay columna propia de post-logout (eso seria un cambio de
 * esquema, y se pidio reserva para el); queda anotado en `specs/01` §1.
 */
@Controller('oidc')
@UseFilters(FiltroErroresOidc)
export class LogoutController {
  private readonly logger = new Logger(LogoutController.name);

  constructor(
    private readonly sesiones: SesionService,
    private readonly apps: AplicacionService,
    private readonly auditoria: AuditoriaService,
  ) {}

  @Get('logout')
  async logoutGet(
    @Query() query: Record<string, unknown>,
    @Req() req: Request,
    @Res() res: Response,
    @Ip() ip: string,
  ): Promise<void> {
    await this.logout(this.leer(query), req, res, ip);
  }

  @Post('logout')
  @HttpCode(200)
  async logoutPost(
    @Body() body: Record<string, unknown>,
    @Query() query: Record<string, unknown>,
    @Req() req: Request,
    @Res() res: Response,
    @Ip() ip: string,
  ): Promise<void> {
    // El `post_logout_redirect_uri` puede venir por query o por form: se acepta
    // el que este. Se valida igual en los dos casos.
    const fuente = typeof body?.post_logout_redirect_uri === 'string' ? body : query;
    await this.logout(this.leer(fuente), req, res, ip);
  }

  private leer(fuente: Record<string, unknown>): {
    clientId: string | null;
    redirect: string | null;
    state: string | null;
  } {
    const texto = (nombre: string): string | null => {
      const valor = fuente?.[nombre];
      return typeof valor === 'string' ? valor : null;
    };
    return {
      clientId: texto('client_id'),
      redirect: texto('post_logout_redirect_uri'),
      state: texto('state'),
    };
  }

  private async logout(
    params: { clientId: string | null; redirect: string | null; state: string | null },
    req: Request,
    res: Response,
    ip: string,
  ): Promise<void> {
    const ctx = { ip, userAgent: req.get('user-agent') ?? 'desconocido' };

    // --- Sesion central ----------------------------------------------------
    const sid = sidDeLaPeticion(req);
    const sesion = sid ? await this.sesiones.viva(sid) : null;

    if (sesion) {
      const cerradas = await this.sesiones.cerrarTodasDelCliente(
        sesion.idusuario,
        sesion.idcliente,
        'logout',
      );
      await this.auditoria.registrarSeguro({
        resultado: 'ok',
        idusuario: sesion.idusuario,
        idaplicacion: null,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        detalle: 'logout',
      });
      this.logger.log(
        `salir de todo: usuario=${sesion.idusuario.slice(0, 8)} cliente=${sesion.idcliente} ` +
          `sesiones=${cerradas}`,
      );
    }

    // La cookie se borra siempre, haya sesion o no: si no la hay, es que ya no
    // sirve, y dejarla puesta hace que el proximo authorize la vuelva a mandar.
    borrarCookieDeSesion(req, res);
    res.setHeader('Cache-Control', 'no-store');

    // --- Redireccion de despedida -----------------------------------------
    if (!params.redirect) {
      // Sin `post_logout_redirect_uri` no se redirige: se devuelve la respuesta
      // minima. La pantalla de despedida la arma el portal (Fase 04/07).
      res.status(200).type('text/plain; charset=utf-8').send('Sesion cerrada.');
      return;
    }

    if (!params.clientId) {
      throw new ErrorOidc('invalid_request');
    }

    const app = await this.apps.activa(params.clientId);
    if (!app || !this.apps.redirectRegistrado(app, params.redirect)) {
      // Sin redireccion: el `redirect_uri` no esta validado, y mandarlo igual
      // seria un redirect abierto con el `state` del cliente pegado.
      throw new ErrorOidc('invalid_request');
    }

    res.redirect(
      302,
      agregarParametros(params.redirect, {
        ...(params.state ? { state: params.state } : {}),
      }),
    );
  }
}
