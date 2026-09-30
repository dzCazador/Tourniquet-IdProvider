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
import { AMR_CON_MFA, SesionService } from '../oidc/sesion.service';
import { AuditoriaService, detalleDe } from './auditoria.service';
import { LoginDto } from './dto/login.dto';
import { VerificarMfaDto } from './dto/mfa.dto';
import { IdentidadService } from './identidad.service';
import { MfaDesafioService, MAX_INTENTOS_MFA } from './mfa-desafio.service';
import { MfaService } from './mfa.service';
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
    private readonly sesiones: SesionService,
    private readonly auditoria: AuditoriaService,
    private readonly mfa: MfaService,
    private readonly desafios: MfaDesafioService,
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

    // --- Segundo factor (specs/01 §8) --------------------------------------
    //
    // Va DESPUES de resolver el cliente y no antes, por una razón que es de
    // seguridad y no de orden: si el MFA se pidiera antes de resolver el tenant,
    // un usuario de un cliente que no existe en esta instalacion recibira un
    // "ingresa tu codigo" y no un 403, o sea que la respuesta pasa a depender de
    // si tiene MFA. Y va antes de crear la sesion, que es lo importante: con
    // `mfa_estado='on'` no queda fila en `tok_sesion` ni cookie, y un ingreso a
    // medias no deja nada con que quedarse adentro.
    //
    // `mfa_estado='pending'` NO pide nada (specs/01 §8.1): el usuario al que se
    // le activa MFA sigue entrando con la clave hasta confirmar.
    const mfa = await this.mfa.estadoDe(verificado.usuario.idusuario);

    if (mfa.estado === 'on') {
      const desafio = await this.desafios.crear(
        verificado.usuario.idusuario,
        cliente.idcliente,
        destino.destino,
        { ip, userAgent: req.get('user-agent') ?? 'desconocido' },
      );

      // Fila propia, y no una modificacion de la del login: "la clave de esta
      // persona es correcta y el factor no" es un evento distinto de "entro", y
      // sin esta fila un ataque de fuerza bruta contra el segundo factor es
      // indistinguible de una clave mala en la lectura del panel.
      await this.auditoria.registrarSeguro({
        resultado: 'ok',
        idusuario: verificado.usuario.idusuario,
        idaplicacion: null,
        ip,
        userAgent: req.get('user-agent') ?? 'desconocido',
        detalle: detalleDe('mfa_requerido', {
          cliente: cliente.idcliente,
          factor: desafio.id.slice(0, 8),
        }),
      });

      this.logger.log(
        `login con segundo factor usuario=${verificado.usuario.usuario} ` +
          `cliente=${cliente.idcliente} factor=${desafio.id.slice(0, 8)}`,
      );

      res.status(HttpStatus.OK).json({
        requiere_mfa: true,
        factor_id: desafio.id,
        expira_en: desafio.expira_en.toISOString(),
        intentos_restantes: MAX_INTENTOS_MFA,
        codigos_restantes: mfa.codigos_restantes,
        aviso_pocos: mfa.aviso_pocos,
      });
      return;
    }

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
   * `POST /auth/mfa/verify`: el **segundo paso** del login con segundo factor
   * (`specs/01` §8.2).
   *
   * Recibe dos cosas y nada más: el `factor_id` y el código. El usuario, el
   * cliente y el destino salen de la fila de `tok_mfa_challenge`, que los
   * escribió el backend en el paso 1. Por eso un F5 en la pantalla de
   * verificación no rompe el ingreso, y por eso el cliente no puede nombrar a
   * otro tenant aunque quiera (invariante de `AGENTS.md`).
   *
   * **Acá se crea la sesión.** El paso 1 no dejó fila en `tok_sesion` ni cookie:
   * un `mfa_estado='on'` sin código no tiene nada detrás.
   *
   * El `amr` de la sesión es `pwd,mfa`, y de ahí sale el `amr` de la sesión de
   * cada app y del access token (`specs/01` §2.1).
   *
   * La IP y el user agent que se auditan son los del **paso 1** (los de la fila
   * del desafío) y no los de este pedido: son los del ingreso que se está
   * completando, y un segundo pedido podría venir con una IP distinta si hay un
   * proxy en el medio. La fila también es lo que evita que el cliente elija qué
   * IP se escribe en la auditoría.
   */
  @Post('mfa/verify')
  async verificarMfa(
    @Body() dto: VerificarMfaDto,
    @Req() req: Request,
    @Res() res: Response,
    @Ip() ip: string,
  ): Promise<void> {
    noStore(res);

    const encontrado = await this.desafios.vigente(dto.factor_id);

    if (!('desafio' in encontrado)) {
      // `usado` es `replay` y el resto es `error`. Un `factor_id` que ya se
      // consumio es alguien que esta reintentando el canje del segundo factor, y
      // eso va con el resultado que existe para eso en el CHECK de `aud_login`.
      const reuso = encontrado.motivo === 'usado';

      await this.auditoria.registrarSeguro({
        resultado: reuso ? 'replay' : 'error',
        // NULL y no un idusuario: el desafio rechazado puede no existir, y sin
        // fila no hay de quien sacar el `idusuario` sin inventarlo.
        idusuario: null,
        idaplicacion: null,
        ip,
        userAgent: req.get('user-agent') ?? 'desconocido',
        detalle: detalleDe('mfa_desafio_invalido', {
          motivo: encontrado.motivo,
          factor: dto.factor_id.slice(0, 8),
        }),
      });

      this.logger.warn(`desafio MFA rechazado motivo=${encontrado.motivo}`);

      throw new ErrorPortal('mfa_desafio_invalido', HttpStatus.UNAUTHORIZED, {
        mensaje: 'La verificacion del segundo factor expiro. Volve a ingresar.',
      });
    }

    const desafio = encontrado.desafio;
    const verificado = await this.mfa.verificarCodigo(desafio.idusuario, dto.codigo);

    if (!verificado.ok) {
      // El usuario fue dado de baja entre los dos pasos: el panel cierra las
      // sesiones al desactivar, pero no puede cerrar un ingreso que todavia no
      // existe (trampa 6 de la fase 09).
      if (verificado.motivo === 'usuario_inactivo') {
        await this.auditoria.registrarSeguro({
          resultado: 'error',
          idusuario: desafio.idusuario,
          idaplicacion: null,
          ip: desafio.ip,
          userAgent: desafio.user_agent,
          detalle: detalleDe('mfa_desafio_invalido', { motivo: 'usuario_inactivo' }),
        });
        throw new ErrorPortal('inactivo', HttpStatus.UNAUTHORIZED, {
          mensaje: 'Usuario dado de baja.',
        });
      }

      const restantes = await this.desafios.registrarIntentoFallido(desafio.id);

      await this.auditoria.registrarSeguro({
        resultado: 'claves',
        idusuario: desafio.idusuario,
        idaplicacion: null,
        ip: desafio.ip,
        userAgent: desafio.user_agent,
        // El motivo va en el detalle porque `reutilizado` y `codigo_incorrecto`
        // son cosas distintas: uno es un codigo espiado en el limite de la
        // ventana, y el otro es que el usuario se equivoco al tipear.
        detalle: detalleDe('mfa_incorrecto', { motivo: verificado.motivo, factor: desafio.id.slice(0, 8) }),
      });

      this.logger.warn(
        `codigo MFA incorrecto usuario=${desafio.idusuario.slice(0, 8)} ` +
          `motivo=${verificado.motivo} intentos_restantes=${restantes}`,
      );

      throw new ErrorPortal('mfa_incorrecto', HttpStatus.UNAUTHORIZED, {
        mensaje:
          restantes > 0
            ? 'El codigo no coincide.'
            : 'Se agotaron los intentos. Volve a ingresar.',
        intentos_restantes: restantes,
      });
    }

    // De un solo uso: si otra peticion gano la carrera, esta cae y no crea
    // sesion. Sin esto, dos verificaciones del mismo `factor_id` con el mismo
    // codigo de recuperacion abririan dos sesiones.
    if (!(await this.desafios.marcarUsado(desafio.id))) {
      await this.auditoria.registrarSeguro({
        resultado: 'replay',
        idusuario: desafio.idusuario,
        idaplicacion: null,
        ip: desafio.ip,
        userAgent: desafio.user_agent,
        detalle: detalleDe('mfa_desafio_invalido', { motivo: 'usado', factor: desafio.id.slice(0, 8) }),
      });
      throw new ErrorPortal('mfa_desafio_invalido', HttpStatus.UNAUTHORIZED, {
        mensaje: 'La verificacion del segundo factor expiro. Volve a ingresar.',
      });
    }

    const usuario = await this.identidad.datosDe(desafio.idusuario);
    if (!usuario) {
      throw new ErrorPortal('inactivo', HttpStatus.UNAUTHORIZED, { mensaje: 'Usuario dado de baja.' });
    }

    const cliente = await this.portal.nombreDeCliente(desafio.idcliente);
    const sesion = await this.portal.iniciarSesion(
      desafio.idusuario,
      desafio.idcliente,
      { ip: desafio.ip, userAgent: desafio.user_agent },
      AMR_CON_MFA,
    );

    escribirCookieDeSesion(req, res, sesion.sid);

    await this.auditoria.registrarSeguro({
      resultado: 'ok',
      idusuario: desafio.idusuario,
      idaplicacion: null,
      ip: desafio.ip,
      userAgent: desafio.user_agent,
      detalle: detalleDe('mfa_ok', {
        cliente: desafio.idcliente,
        metodo: verificado.metodo,
        factor: desafio.id.slice(0, 8),
      }),
    });

    this.logger.log(
      `login con MFA ok usuario=${usuario.usuario} cliente=${desafio.idcliente} ` +
        `metodo=${verificado.metodo} sid=${sesion.sid.slice(0, 8)}`,
    );

    res.status(HttpStatus.OK).json({
      usuario: usuario.usuario,
      nombre: `${usuario.nombre} ${usuario.apellido}`.trim(),
      clienteActual: cliente,
      returnTo: desafio.return_to,
      codigos_restantes: verificado.codigos_restantes,
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

  /**
   * `POST /auth/logout-all`: "salir de todo".
   *
   * Cierra **todas** las sesiones del usuario **en el cliente de su sesion**: la
   * del portal y la de cada app a la que entro (`specs/01` §4). Un usuario de dos
   * clientes no se ve afectado en el otro, porque el filtro es `idcliente`.
   *
   * Es distinto de `/auth/logout`, que cierra solo la sesion del portal y deja
   * vivas las apps. Y es distinto de `/oidc/logout` —que hace lo mismo pero ademas
   * acepta el `post_logout_redirect_uri` de una app y lo valida contra el registro,
   * por RFC 9457— porque el boton del lanzador no tiene ningun `redirect_uri` de
   * app que validar: el destino es la despedida del portal.
   *
   * Idempotente: sin cookie, o con la sesion ya cerrada, es un 200 con
   * `cerradas: 0`.
   */
  @Post('logout-all')
  async logoutAll(@Req() req: Request, @Res() res: Response, @Ip() ip: string): Promise<void> {
    noStore(res);
    const userAgent = req.get('user-agent') ?? 'desconocido';
    const sid = sidDeLaPeticion(req);
    const sesion = sid ? await this.sesiones.viva(sid) : null;
    let cerradas = 0;

    if (sesion) {
      cerradas = await this.sesiones.cerrarTodasDelCliente(
        sesion.idusuario,
        sesion.idcliente,
        'logout',
      );

      // Con el `sub` real de la sesion (`specs/01` §7). Sin `idusuario` esta fila
      // seria indistinguible de un logout sin sesion, y "salir de todo" es de las
      // cosas que mas se investiga despues: sin saber quien lo pidio, no sirve.
      await this.auditoria.registrarSeguro({
        resultado: 'ok',
        idusuario: sesion.idusuario,
        idaplicacion: null,
        ip,
        userAgent,
        detalle: detalleDe('logout_todo', { cliente: sesion.idcliente, sesiones: String(cerradas) }),
      });
    }

    borrarCookieDeSesion(req, res);

    this.logger.log(
      `salir de todo: usuario=${sesion ? sesion.idusuario.slice(0, 8) : '(ninguno)'} ` +
        `sesiones=${cerradas}`,
    );

    res.status(HttpStatus.OK).json({ ok: true, cerradas });
  }
}

function noStore(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
}
