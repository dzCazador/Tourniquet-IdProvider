import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Post,
  Req,
  UseFilters,
  UseInterceptors,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuditoriaService, detalleDe } from '../auth/auditoria.service';
import { PortalService, type ContextoSesionPortal } from '../auth/portal.service';
import { MfaService } from '../auth/mfa.service';
import { ErrorPortal } from '../auth/portal.service';
import { ConfirmarMfaDto } from '../auth/dto/mfa.dto';
import { sidDeLaPeticion } from '../oidc/cookies';
import { SesionService } from '../oidc/sesion.service';
import { FiltroErroresRegistro, sinSesion } from './errores';
import { SinCacheInterceptor } from './sin-cache.interceptor';

/**
 * `/me/mfa`: lo que el usuario hace **sobre su propio** segundo factor
 * (`specs/01` §8.1).
 *
 * Tres operaciones y sólo tres, y ninguna es "activar":
 *
 *   - `GET /me/mfa`: el estado y cuántos códigos de recuperación quedan.
 *   - `POST /me/mfa/confirmar`: `pending` → `on`, con un código de la app.
 *   - `DELETE /me/mfa`: apagar el MFA propio.
 *
 * **Activar no está acá y esa es la decisión.** El secret lo genera el backend
 * y se muestra una sola vez, y hay que decidir quién lo recibe: si el usuario
 * lo activara solo, el `otpauth://` y los 10 códigos de recuperación saldrían en
 * un POST desde el navegador de una persona que todavía no tiene MFA, que es
 * exactamente el escenario de un atacante con la clave de otra persona: se
 * lleva la clave, se lleva los códigos de recuperación y deja a la víctima sin
 * segundo factor. Que lo active un `admin_identidad` del panel pone a una persona
 * autorizada entre la clave y el segundo factor. Es el mismo criterio con el que
 * el alta de usuarios es del panel y no del correo (`specs/00` §5).
 *
 * Todo lo que hay acá requiere la **sesión del portal**: o sea que la clave ya
 * está verificada. Es un endpoint de cuenta, no de ingreso.
 */
@Controller('me/mfa')
@UseFilters(FiltroErroresRegistro)
@UseInterceptors(SinCacheInterceptor)
export class MeMfaController {
  constructor(
    private readonly portal: PortalService,
    private readonly mfa: MfaService,
    private readonly sesiones: SesionService,
    private readonly auditoria: AuditoriaService,
  ) {}

  /**
   * Estado del MFA propio y códigos que quedan.
   *
   * `aviso_pocos` viene del backend y no se recalcula en el front: el umbral (2)
   * es parte del contrato de `specs/01` §8.5 y metido en el React obligaría a
   * cambiar dos archivos cuando cambie.
   */
  @Get()
  async estado(@Req() req: Request): Promise<object> {
    const ctx = await this.contextoDe(req);
    const estado = await this.mfa.estadoDe(ctx.usuario.idusuario);
    return { usuario: ctx.usuario.usuario, ...estado };
  }

  /**
   * Confirma el enrolamiento con un código de la app de autenticación.
   *
   * Con `mfa_estado='off'` responde 400 y no 404: el usuario sabe si lo tiene
   * activo, y un 404 lo haría pensar que la pantalla está rota. El 400 también
   * es el que evita que llamar dos veces al botón "confirmar" sea un operacion
   * silenciosa que no hace nada.
   */
  @Post('confirmar')
  @HttpCode(200)
  async confirmar(
    @Body() dto: ConfirmarMfaDto,
    @Req() req: Request,
    @Ip() ip: string,
  ): Promise<object> {
    const ctx = await this.contextoDe(req);
    const antes = await this.mfa.estadoDe(ctx.usuario.idusuario);

    if (antes.estado !== 'pending') {
      // `ErrorPortal` y no `peticionInvalida` de `registro/errores`: los
      // endpoints `/me/*` hablan el contrato del portal (`{ codigo, mensaje }`) y
      // el front los lee con el mismo `aErrorPortal` que el login. Un solo
      // contrato para toda la superficie del portal es lo que evita que el
      // cliente tenga dos readers de error.
      //
      // El mensaje distingue los dos casos porque el usuario **sabe** si lo tiene
      // activo: un 404 o un 400 genérico lo haría pensar que la pantalla está
      // rota. Lo que no se distingue es nada de la cuenta: anybody que vea esto
      // ya esta autenticado como esa persona.
      throw new ErrorPortal('mfa_no_pendiente', HttpStatus.BAD_REQUEST, {
        mensaje:
          antes.estado === 'on'
            ? 'El segundo factor ya esta activo.'
            : 'No hay ningun segundo factor esperando confirmacion.',
      });
    }

    const codigosRestantes = await this.mfa.confirmar(ctx.usuario.idusuario, dto.codigo);

    await this.auditoria.registrarSeguro({
      resultado: 'ok',
      idusuario: ctx.usuario.idusuario,
      idaplicacion: null,
      ip,
      userAgent: req.get('user-agent') ?? 'desconocido',
      detalle: detalleDe('mfa_confirmado', { cliente: ctx.cliente.idcliente }),
    });

    return { estado: 'on', codigos_restantes: codigosRestantes, aviso_pocos: false };
  }

  /**
   * Apaga el MFA propio.
   *
   * Cierra las sesiones vivas **de este usuario en el cliente de su sesión**
   * (motivo `revocada`), por lo que decide `specs/01` §8.4: el token de una
   * sesión vieja seguiría afirmando `mfa` mientras la cuenta ya no lo exige.
   *
   * Y devuelve `sesiones_cerradas` para que la UI pueda decirlo: una respuesta
   * muda dejaría al usuario pensando que lo apagó y, al usarlo dos horas después,
   * que lo apagó a medias.
   */
  @Delete()
  async desactivar(@Req() req: Request, @Ip() ip: string): Promise<object> {
    const ctx = await this.contextoDe(req);
    const antes = await this.mfa.estadoDe(ctx.usuario.idusuario);

    if (antes.estado === 'off') {
      // Idempotente en el resultado, y no un 404: "apagar" algo que ya está
      // apagado es el estado final, no un error. Un 400 acá haría que un doble
      // clic en el botón pareciera un fallo.
      return { estado: 'off', sesiones_cerradas: 0, ya_estaba_apagado: true };
    }

    await this.mfa.desactivar(ctx.usuario.idusuario);
    const cerradas = await this.sesiones.cerrarTodasDelCliente(
      ctx.usuario.idusuario,
      ctx.cliente.idcliente,
      'revocada',
    );

    await this.auditoria.registrarSeguro({
      resultado: 'ok',
      idusuario: ctx.usuario.idusuario,
      idaplicacion: null,
      ip,
      userAgent: req.get('user-agent') ?? 'desconocido',
      detalle: detalleDe('mfa_desactivado', {
        cliente: ctx.cliente.idcliente,
        estado_anterior: antes.estado,
      }),
    });

    return { estado: 'off', sesiones_cerradas: cerradas, ya_estaba_apagado: false };
  }

  private async contextoDe(req: Request): Promise<ContextoSesionPortal> {
    const ctx = await this.portal.contextoDe(sidDeLaPeticion(req));
    if (!ctx) {
      sinSesion();
    }
    return ctx;
  }
}
