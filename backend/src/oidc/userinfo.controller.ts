import { Controller, Get, Header, Headers, Res, UseFilters } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { FiltroErroresOidc } from './errores';
import { SesionService } from './sesion.service';
import { ValidadorService } from './validador.service';

/**
 * `GET /userinfo`: los datos personales del `sub` del token.
 *
 * Y **nada mas**. Sin roles, sin permisos, sin perfil de negocio, sin datos de
 * otro cliente: la autorizacion de negocio es de cada app contra su propia base
 * (D2 de `specs/00`). Agregar un claim de negocio aca seria el defecto que
 * `specs/04` prohibe explicitamente.
 *
 * **El `sid` se comprueba contra `tok_sesion` aunque el JWT sea valido** (trampa
 * 5 de la Fase 03). Un access vive 15 min: sin esta comprobacion, un logout
 * no revocaria nada hasta que el token expire, y `specs/01` §9 ("sesion zombi
 * tras logout") seria mentira. El costo es una lectura por llamada, que es lo
 * que compra la revocacion inmediata.
 *
 * No se audita cada llamada: `aud_login` es de eventos de acceso, y aca se audita
 * el canje. Un endpoint de recurso que se audita por llamada llena la tabla de
 * ruido y la vuelve inutilizable para lo que importa (replay, credenciales
 * malas, accesos denegados).
 */
@Controller()
@UseFilters(FiltroErroresOidc)
export class UserinfoController {
  private readonly issuer: string;

  constructor(
    private readonly validador: ValidadorService,
    private readonly sesiones: SesionService,
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.issuer = config.getOrThrow<string>('TQ_ISSUER');
  }

  @Get('userinfo')
  @Header('Cache-Control', 'no-store')
  async userinfo(@Headers('authorization') authorization: string | undefined, @Res() res: Response): Promise<void> {
    const token = this.tokenDelHeader(authorization);

    // Sin `audience`: `/userinfo` es del IdP, no de una app, y no hay un `aud`
    // legitimo que exigir (ver `FirmaService.verificar`). El `aud` lo valida
    // cada app en su propia API.
    const resultado = await this.validador.validar(token, { issuer: this.issuer });
    if (!resultado.ok) {
      this.responderNoAutorizado(res);
      return;
    }

    const sub = resultado.payload.sub;
    const sid = resultado.payload.sid;
    if (typeof sub !== 'string' || typeof sid !== 'string') {
      this.responderNoAutorizado(res);
      return;
    }

    // La revocacion es inmediata aunque el token siga criptograficamente valido.
    const sesion = await this.sesiones.viva(sid);
    if (!sesion || sesion.idusuario !== sub) {
      this.responderNoAutorizado(res);
      return;
    }

    const usuario = await this.prisma.idn_usuario.findUnique({
      where: { idusuario: sub },
      select: { usuario: true, nombre: true, apellido: true, email: true },
    });

    if (!usuario) {
      this.responderNoAutorizado(res);
      return;
    }

    res.status(200).json({
      sub,
      usuario: usuario.usuario,
      nombre: usuario.nombre,
      apellido: usuario.apellido,
      // `email` es opcional de verdad (`specs/01` §1: `email?`): se omite la
      // clave entera, no se manda en null, para que un cliente que chequee
      // `"email" in datos` funcione en los dos casos.
      ...(usuario.email ? { email: usuario.email } : {}),
    });
  }

  private tokenDelHeader(authorization: string | undefined): string {
    const prefijo = 'Bearer ';
    if (typeof authorization !== 'string' || !authorization.startsWith(prefijo)) {
      return '';
    }
    return authorization.slice(prefijo.length).trim();
  }

  /**
   * 401 con `WWW-Authenticate`. Todos los fallos se responden igual, con el
   * mismo motivo generico: decir *por que* fallo el token le diria al atacante
   * si su token esta cerca de servir (un `kid` desconocido es una respuesta
   * distinta a una firma invalida).
   */
  private responderNoAutorizado(res: Response): void {
    res.setHeader('WWW-Authenticate', 'Bearer error="invalid_token"');
    res.status(401).json({ error: 'invalid_token' });
  }
}
