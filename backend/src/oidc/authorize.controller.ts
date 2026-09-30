import {
  Body,
  Controller,
  Get,
  HttpCode,
  Ip,
  Post,
  Query,
  Req,
  Res,
  UseFilters,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuditoriaService } from '../auth/auditoria.service';
import {
  AuthorizeService,
  paramUnico,
  PeticionAuthorize,
  type DatosConsentimiento,
} from './authorize.service';
import { sidDeLaPeticion } from './cookies';
import { ErrorOidc, FiltroErroresOidc } from './errores';
import { agregarParametros } from './authorize.service';

/**
 * `GET /oidc/authorize`, `GET /oidc/consentimiento` y `POST /oidc/consentir`.
 *
 * El authorize es una navegacion del navegador, no una llamada de API: contesta
 * **302** con el `code` en la query del `redirect_uri`. Los errores van por el filtro
 * del modulo, que ya sabe si se pueden redirigir (`ErrorOidc.redirigir`) o si tienen
 * que responderse en el request.
 *
 * Los parametros de query **no** se validan con `class-validator`: en OAuth la
 * respuesta a un parametro mal formado es un codigo de error de OAuth
 * (`invalid_request`), no un 400 de validacion de DTO, y un parametro repetido tiene
 * que ser un error, no "el primero". La validacion de la forma esta en
 * `AuthorizeService`, en el orden que la spec exige.
 *
 * Lo de Fase 07 es que el authorize **no emite el `code`**: manda al consentimiento
 * del portal, y el `code` sale de `POST /oidc/consentir`. Las dos pantallas de este
 * archivo son las que hacen que eso sea un control del IdP y no un cartel.
 */
@Controller('oidc')
@UseFilters(FiltroErroresOidc)
export class AuthorizeController {
  constructor(
    private readonly authorize: AuthorizeService,
    private readonly auditoria: AuditoriaService,
  ) {}

  @Get('authorize')
  async autorizar(
    @Query() query: Record<string, unknown>,
    @Req() req: Request,
    @Res() res: Response,
    @Ip() ip: string,
  ): Promise<void> {
    const peticion = pedirAuthorize(query);

    // La URL completa del authorize, para el `returnTo` del login. Se arma con el
    // issuer y no con el host de la request: un `Host` manipulado por el cliente no
    // puede decidir a donde vuelve el usuario.
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

  /**
   * Hechos para la pantalla de consentimiento: nombre de la app, cliente y base.
   *
   * Es una lectura, y por eso responde JSON y no redirige. El portal la llama desde
   * la pagina de consentimiento para pintar los renglones; si el usuario no esta
   * habilitado para esa app, responde `access_denied` y la pantalla muestra un
   * mensaje en vez de una lista de hechos que no corresponden.
   */
  @Get('consentimiento')
  async consentimiento(
    @Query() query: Record<string, unknown>,
    @Req() req: Request,
    @Ip() ip: string,
  ): Promise<DatosConsentimiento> {
    return this.authorize.datosDeConsentimiento(paramUnico(query, 'client_id'), {
      ip,
      userAgent: req.get('user-agent') ?? 'desconocido',
      sidPortal: sidDeLaPeticion(req),
    });
  }

  /**
   * El usuario aceptan: se revalida el pedido entero y se emite el `code`.
   *
   * **Por que un POST y no un GET que continue el 302:** un GET que emite un
   * `code` se puede disparar con un prefetch, con un escaner de link en una red de
   * la oficina o con el "abrir en pestana nueva" del navegador. Un POST que el
   * portal hace a proposito, con la sesion, es lo unico que no se dispara solo.
   *
   * Y por que el portal puede mandar cualquier cosa y no importa: aca se repite la
   * validacion completa del authorize (app activa, `redirect_uri` exacto, challenge
   * S256, scope, sesion viva, habilitacion). Lo que el portal **no** puede cambiar
   * de forma util es el `code_verifier`, que esta en el navegador de la app: un
   * challenge retocado muere en el canje, por PKCE.
   *
   * `@HttpCode(200)` explicito porque el default de Nest en un POST es 201, y 201
   * aqui seria mentir: no se creo un recurso con identidad propia, se devolvio la
   * URL a la que tiene que ir el navegador. Un cliente que espere 200 fijo (que es
   * lo que hacen los `fetch` con `ok`) no tiene que conocer el default del framework.
   */
  @Post('consentir')
  @HttpCode(200)
  async consentir(
    @Body() body: Record<string, unknown>,
    @Req() req: Request,
    @Ip() ip: string,
  ): Promise<{ url: string }> {
    const userAgent = req.get('user-agent') ?? 'desconocido';

    // Un `throw` de `paramUnico` (`invalid_request`) sale por el filtro del modulo
    // con la forma OAuth, que es lo que el portal sabe leer.
    const resultado = await this.authorize.autorizar(
      pedirAuthorize(body),
      {
        ip,
        userAgent,
        sidPortal: sidDeLaPeticion(req),
        // No se usa: con sesion central viva el camino del login no se alcanza. Va
        // como el propio authorize porque el metodo es el mismo, no para que quede
        // una rama muerta: si alguien lo llama sin sesion, la respuesta es
        // `login_required` (por `exigirSesion`), no esta URL.
        urlAuthorize: this.authorize.emisor + req.originalUrl,
      },
      // `exigirSesion`: aceptar el consentimiento sin sesion es un 401, no una
      // redireccion al login. Ver `AuthorizeService.autorizar`.
      { consentida: true, exigirSesion: true },
    );

    if (resultado.emitido) {
      await this.auditoria.registrarSeguro({
        resultado: 'ok',
        idusuario: resultado.emitido.idusuario,
        idaplicacion: resultado.emitido.idaplicacion,
        ip,
        userAgent,
        detalle: 'consentimiento_aceptado',
      });
    }

    return { url: resultado.url };
  }
}

/**
 * Los siete parametros del pedido OIDC, de la query o del body.
 *
 * El mismo extractor para el authorize y para el `consentir`, a proposito: si los
 * dos tuvieran su propia version, la revalidacion del `consentir` estaria
 * comprobando algo distinto de lo que el authorize comprobo, que es exactamente
 * lo que ese endpoint existe para que no pase.
 */
function pedirAuthorize(fuente: Record<string, unknown>): PeticionAuthorize {
  return {
    response_type: paramUnico(fuente, 'response_type'),
    client_id: paramUnico(fuente, 'client_id'),
    redirect_uri: paramUnico(fuente, 'redirect_uri'),
    state: paramUnico(fuente, 'state'),
    code_challenge: paramUnico(fuente, 'code_challenge'),
    code_challenge_method: paramUnico(fuente, 'code_challenge_method'),
    scope: paramUnico(fuente, 'scope'),
  };
}
