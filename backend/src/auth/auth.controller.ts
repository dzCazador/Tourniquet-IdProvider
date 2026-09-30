import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Ip,
  Post,
  Req,
  Res,
  UseFilters,
  Catch,
  ArgumentsHost,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { sidDeLaPeticion, escribirCookieDeSesion, borrarCookieDeSesion } from '../oidc/cookies';
import { AuditoriaService } from './auditoria.service';
import { LoginDto } from './dto/login.dto';
import { IdentidadService } from './identidad.service';
import { ErrorPortal, PortalService, type EstadoSesion } from './portal.service';
import { validarReturnTo } from './return-to';

/**
 * Filtro del portal. Va declarado ANTES del controlador a proposito: el
 * decorador `@UseFilters(FiltroErroresPortal)` se evalua cuando se define la
 * clase del controlador, y si el filtro se declarara despues todavia estaria
 * en su zona temporal muerta y el arranque fallaria con un `ReferenceError`
 * que no senala el archivo.
 *
 * Vive aca y no como `APP_FILTER` global porque el nucleo OIDC ya tiene el suyo
 * (`oidc/errores.ts`), con la forma `{ error, error_description }` de RFC 6749.
 * El login responde `{ codigo, mensaje }` y no tiene por que hablar el idioma
 * de OAuth.
 *
 * `ErrorPortal` sale tal cual. Un `HttpException` de otra clase sale con su
 * propio cuerpo (el `ValidationPipe` global usa esa, y el 400 de un DTO malo
 * tiene que seguir siendo legible). Cualquier otra cosa es un bug: 500 con un
 * codigo y el detalle real en el log del proceso, nunca en el navegador.
 */
@Catch()
export class FiltroErroresPortal {
  private readonly logger = new Logger(FiltroErroresPortal.name);

  catch(excepcion: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    noStore(res);

    if (excepcion instanceof ErrorPortal) {
      res.status(excepcion.status).json({ codigo: excepcion.codigo, ...excepcion.cuerpo });
      return;
    }

    if (excepcion instanceof HttpException) {
      res.status(excepcion.getStatus()).json(excepcion.getResponse());
      return;
    }

    this.logger.error(
      `Error no controlado en /auth: ` +
        `${excepcion instanceof Error ? excepcion.message : 'error desconocido'}`,
    );
    res
      .status(HttpStatus.INTERNAL_SERVER_ERROR)
      .json({ codigo: 'error', mensaje: 'Error interno del portal.' });
  }
}

/**
 * `POST /auth/login`, `GET /auth/session`, `POST /auth/logout`.
 *
 * Es el unico camino por el que el portal obtiene una sesion central, y por lo
 * tanto el unico lugar donde nace el `tenant` de todo lo que sale despues.
 *
 * **Por que el archivo vive en `auth/` pero se declara en `OidcModule`:** la
 * sesion del portal es una fila de `tok_sesion` y la cookie que la apunta la
 * escribe `oidc/cookies.ts`, o sea que el controlador necesita a `SesionService`,
 * que vive en `OidcModule`. Declarar el controlador en `OidcModule` evita una
 * dependencia circular (`OidcModule` ya importa `AuthModule` para
 * `IdentidadService`); la otra salida seria mover `SesionService` a un modulo
 * propio, que es refactor de la Fase 03 para un problema de esta fase.
 *
 * `no-store` en las tres respuestas: las dos primeras deciden si el navegador
 * cree que hay sesion, y la tercera es la que la termina. Una copia en el cache
 * de un proxy de un 200 de `/auth/session` deja al usuario "logueado" sin
 * cookie.
 */
@Controller('auth')
@UseFilters(FiltroErroresPortal)
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly identidad: IdentidadService,
    private readonly portal: PortalService,
    private readonly auditoria: AuditoriaService,
  ) {}

  @Post('login')
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res() res: Response,
    @Ip() ip: string,
  ): Promise<void> {
    noStore(res);

    // El `returnTo` se valida ANTES de gastar argon2, por dos razones. Una: es
    // un 400 deterministico y sooner, y gastarse un argon2 (~100 ms) para
    // responder un parametro invalido es regalarle al atacante un amplificador
    // de DoS. Dos, y la importante: si se comprobara despues de crear la
    // sesion, el redirect se ejecutaria con la cookie ya escrita.
    const destino = validarReturnTo(dto.returnTo, this.portal.emisor);
    if (!destino.ok) {
      await this.auditoria.registrarSeguro({
        resultado: 'error',
        idusuario: null,
        ip,
        userAgent: req.get('user-agent') ?? 'desconocido',
        detalle: 'returnto_invalido',
      });
      throw new ErrorPortal('returnto_invalido', HttpStatus.BAD_REQUEST, {
        mensaje: `returnTo rechazado (${destino.motivo}).`,
      });
    }

    const verificado = await this.identidad.verificar(dto.usuario, dto.clave, {
      ip,
      userAgent: req.get('user-agent') ?? 'desconocido',
      idAplicacion: null,
    });

    if (!verificado.ok) {
      // `verificar` ya dejo la auditoria del intento; aca solo se traduce el
      // fallo al contrato del portal. Volver a auditar seria duplicar la fila.
      throw this.portal.errorDeFallo(verificado.motivo, {
        bloqueadoHasta: verificado.bloqueadoHasta,
        reintentoEnMs: verificado.reintentoEnMs,
      });
    }

    // El tenant se resuelve DESPUES de verificar la clave y ANTES de crear la
    // sesion. `sin_cliente`, `cliente_no_pertenece` y `cliente_ambiguo` son
    // 403/400 de un usuario **ya autenticado**, y asi el front los distingue de
    // "clave incorrecta" sin que el backend haya filtrado nada sobre la
    // existencia de la cuenta.
    const cliente = await this.portal.resolverCliente(
      verificado.usuario.idusuario,
      destino.destino,
      dto.cliente,
    );

    const sesion = await this.portal.iniciarSesion(verificado.usuario.idusuario, cliente.idcliente, {
      ip,
      userAgent: req.get('user-agent') ?? 'desconocido',
    });

    // El `sid` va en la cookie, no en el cuerpo. El portal no necesita ningun
    // token para estar logueado: necesita una referencia a la sesion para
    // pedir codes (`specs/01` §4).
    escribirCookieDeSesion(req, res, sesion.sid);

    this.logger.log(
      `login ok usuario=${verificado.usuario.usuario} cliente=${cliente.idcliente} ` +
        `sid=${sesion.sid.slice(0, 8)}`,
    );

    res.status(HttpStatus.OK).json({
      usuario: verificado.usuario.usuario,
      nombre: `${verificado.usuario.nombre} ${verificado.usuario.apellido}`.trim(),
      clienteActual: cliente,
      returnTo: destino.destino,
    });
  }

  /**
   * `GET /auth/session`: quien esta logueado en el portal, o 401.
   *
   * El 401 **no** distingue "sin cookie", "cookie de otro", "sesion cerrada" y
   * "sesion vencida": los cuatro son "no hay sesion" para el navegador, y
   * separarlos permitiria probar `sid` (invariante de `AGENTS.md`: el `sid`
   * nunca se deduce de nada que venga del cliente).
   */
  @Get('session')
  async sesion(@Req() req: Request, @Res() res: Response): Promise<void> {
    noStore(res);
    const estado: EstadoSesion | null = await this.portal.estadoDe(sidDeLaPeticion(req));

    if (!estado) {
      res.status(HttpStatus.UNAUTHORIZED).json({ codigo: 'sesion_requerida' });
      return;
    }

    res.status(HttpStatus.OK).json(estado);
  }

  /**
   * `POST /auth/logout`: cierra la sesion del PORTAL.
   *
   * No revoca las sesiones de las apps ni sus refresh: eso es `/oidc/logout`
   * ("salir de todo"), que es de la Fase 07. Lo que hace esta es dejar al
   * usuario sin sesion central, o sea, que el proximo authorize lo mande de
   * vuelta al login.
   *
   * Idempotente: logout sin cookie, o de una sesion ya cerrada, es un 200.
   */
  @Post('logout')
  async logout(@Req() req: Request, @Res() res: Response, @Ip() ip: string): Promise<void> {
    noStore(res);
    const sid = sidDeLaPeticion(req);
    const idusuario = await this.portal.cerrarSesion(sid, 'logout');
    borrarCookieDeSesion(req, res);

    // Con el `idusuario` real de la sesion (`specs/01` §7). Un `logout` con
    // `idusuario NULL` seria indistinguible de un logout sin sesion, y un
    // cierre de sesion que no dice quien lo pidio no sirve para investigar un
    // acceso. Sin cookie no se audita nada: no hay sesion de la que sacarlo.
    if (idusuario) {
      await this.auditoria.registrarSeguro({
        resultado: 'ok',
        idusuario,
        ip,
        userAgent: req.get('user-agent') ?? 'desconocido',
        detalle: 'logout',
      });
    }

    this.logger.log(
      `logout del portal sid=${sid ? sid.slice(0, 8) : '(sin cookie)'} ` +
        `usuario=${idusuario ? idusuario.slice(0, 8) : '(ninguno)'}`,
    );
    res.status(HttpStatus.OK).json({ ok: true, cerrada: idusuario !== null });
  }
}

function noStore(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
}
