import { Controller, Get, Ip, Query, Req, Res, UseFilters } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthorizeService, paramUnico, PeticionAuthorize } from './authorize.service';
import { sidDeLaPeticion } from './cookies';
import { ErrorOidc, FiltroErroresOidc } from './errores';
import { agregarParametros } from './authorize.service';

/**
 * `GET /oidc/authorize`.
 *
 * Es una navegacion del navegador, no una llamada de API: contesta **302** con
 * el `code` en la query del `redirect_uri`. Los errores van por el filtro del
 * modulo, que ya sabe si se pueden redirigir (`ErrorOidc.redirigir`) o si
 * tienen que responderse en el request.
 *
 * Los parametros de query **no** se validan con `class-validator`: en OAuth la
 * respuesta a un parametro mal formado es un codigo de error de OAuth
 * (`invalid_request`), no un 400 de validacion de DTO, y un parametro repetido
 * tiene que ser un error, no "el primero". La validacion de la forma esta en
 * `AuthorizeService`, en el orden que la spec exige.
 */
@Controller('oidc')
@UseFilters(FiltroErroresOidc)
export class AuthorizeController {
  constructor(private readonly authorize: AuthorizeService) {}

  @Get('authorize')
  async autorizar(
    @Query() query: Record<string, unknown>,
    @Req() req: Request,
    @Res() res: Response,
    @Ip() ip: string,
  ): Promise<void> {
    const peticion: PeticionAuthorize = {
      response_type: paramUnico(query, 'response_type'),
      client_id: paramUnico(query, 'client_id'),
      redirect_uri: paramUnico(query, 'redirect_uri'),
      state: paramUnico(query, 'state'),
      code_challenge: paramUnico(query, 'code_challenge'),
      code_challenge_method: paramUnico(query, 'code_challenge_method'),
      scope: paramUnico(query, 'scope'),
    };

    // La URL completa del authorize, para el `returnTo` del login. Se arma con
    // el issuer y no con el host de la request: un `Host` manipulado por el
    // cliente no puede decidir a donde vuelve el usuario.
    const urlAuthorize = `${this.authorize.emisor}/oidc/authorize${req.originalUrl.replace(/^\/oidc\/authorize/, '')}`;

    try {
      const resultado = await this.authorize.autorizar(peticion, {
        ip,
        userAgent: req.get('user-agent') ?? 'desconocido',
        sidPortal: sidDeLaPeticion(req),
        urlAuthorize,
      });

      res.setHeader('Cache-Control', 'no-store');
      res.redirect(302, resultado.url);
    } catch (error) {
      if (error instanceof ErrorOidc && error.redirigir) {
        res.setHeader('Cache-Control', 'no-store');
        res.redirect(302, agregarParametros(error.redirigir.uri, {
          error: error.codigo,
          ...(error.redirigir.state ? { state: error.redirigir.state } : {}),
        }));
        return;
      }
      throw error;
    }
  }
}
