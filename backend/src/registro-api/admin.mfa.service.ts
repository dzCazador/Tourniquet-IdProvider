import { Injectable, Logger } from '@nestjs/common';
import { AuditoriaService, detalleDe } from '../auth/auditoria.service';
import { MfaService, type EnrolamientoMfa } from '../auth/mfa.service';
import { formatearCodigo } from '../auth/totp';
import { noEncontrado, peticionInvalida } from '../registro/errores';
import { SesionService } from '../oidc/sesion.service';
import { PrismaService } from '../prisma/prisma.service';
import type { SesionAdmin } from './admin.types';
import type { Peticion } from './admin.usuarios.service';

/**
 * Las tres acciones de MFA que puede hacer un `admin_identidad`
 * (`specs/01` §8.1 y §8.4): activar, desactivar y regenerar códigos.
 *
 * Vienen en un service propio y no como tres métodos más de
 * `AdminUsuariosService` por dos razones concretas:
 *
 *   - `AdminUsuariosService` ya está en 667 líneas y su regla de oro es "todo lo
 *     que entra es una decisión sobre quién existe y a qué apps entra". El MFA es
 *     otra cosa: es un **mecanismo de autenticación**, y mezclarlo haría que la
 *     próxima persona que agregue un método de permisos de negocio lo encontrara
 *     al lado de `activarMfa`.
 *   - Las tres escriben material **secreto en claro** en la respuesta (el
 *     `otpauth://` y los códigos). Es el único lugar del panel que devuelve algo
 *     que sólo existe una vez, y conviene que su homepage diga eso.
 *
 * Igual que en el resto del panel: el filtro de tenant va en el `where`, la
 * escritura se audita con el `idusuario` del **admin** y el afectado en el
 * `detalle` (`specs/01` §7).
 */
@Injectable()
export class AdminMfaService {
  private readonly logger = new Logger(AdminMfaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mfa: MfaService,
    private readonly sesiones: SesionService,
    private readonly auditoria: AuditoriaService,
  ) {}

  /**
   * Activa MFA para un usuario del cliente y devuelve el `otpauth://` y los 10
   * códigos de recuperación, **una sola vez**.
   *
   * El usuario queda en `pending`: entra con la clave sola hasta que confirme
   * desde `/mi-cuenta` con un código de su app (`specs/01` §8.1).
   *
   * `noEncontrado` si el usuario no es miembro del cliente del admin: un
   * `idusuario` de otro tenant es indistinguible de uno que no existe, y un 403
   * confirmaría que el usuario existe.
   */
  async activar(
    idusuario: string,
    admin: SesionAdmin,
    ctx: Peticion,
  ): Promise<EnrolamientoMfa & { usuario_nombre: string }> {
    const usuario = await this.usuarioDelCliente(idusuario, admin.idcliente);
    const enrolamiento = await this.mfa.activar(idusuario);

    await this.auditoria.registrarSeguro({
      resultado: 'ok',
      idusuario: admin.idusuario,
      idaplicacion: null,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      // El secret y los códigos NUNCA entran al detalle: la fila dice que hubo un
      // alta de MFA, no qué secret se generó.
      detalle: detalleDe('admin_activa_mfa', { usuario: idusuario, cliente: admin.idcliente }),
    });

    this.logger.log(
      `admin ${admin.usuario} activa MFA de ${usuario.usuario} (cliente=${admin.idcliente}); ` +
        'queda en pending hasta que el usuario confirme',
    );

    return { ...enrolamiento, usuario_nombre: usuario.nombre_completo };
  }

  /**
   * Desactiva MFA de un usuario del cliente y cierra sus sesiones **de ese
   * cliente** (`specs/01` §8.4).
   *
   * Idempotente: si ya estaba apagado devuelve `ya_estaba_apagado: true` y no
   * cierra nada. Un doble clic en "Desactivar MFA" no puede ser un error.
   */
  async desactivar(
    idusuario: string,
    admin: SesionAdmin,
    ctx: Peticion,
  ): Promise<{ estado: 'off'; sesiones_cerradas: number; ya_estaba_apagado: boolean }> {
    const usuario = await this.usuarioDelCliente(idusuario, admin.idcliente);
    const antes = await this.mfa.estadoDe(idusuario);

    if (antes.estado === 'off') {
      return { estado: 'off', sesiones_cerradas: 0, ya_estaba_apagado: true };
    }

    await this.mfa.desactivar(idusuario);
    const cerradas = await this.sesiones.cerrarTodasDelCliente(
      idusuario,
      admin.idcliente,
      'revocada',
    );

    await this.auditoria.registrarSeguro({
      resultado: 'ok',
      idusuario: admin.idusuario,
      idaplicacion: null,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      detalle: detalleDe('admin_desactiva_mfa', {
        usuario: idusuario,
        cliente: admin.idcliente,
        estado_anterior: antes.estado,
      }),
    });

    this.logger.log(
      `admin ${admin.usuario} desactiva MFA de ${usuario.usuario} ` +
        `(cliente=${admin.idcliente}) estado_anterior=${antes.estado} sesiones=${cerradas}`,
    );

    return { estado: 'off', sesiones_cerradas: cerradas, ya_estaba_apagado: false };
  }

  /**
   * Regenera los códigos de recuperación: **invalida** los anteriores y entrega
   * 10 nuevos, una sola vez.
   *
   * Sólo tiene sentido con MFA `pending` u `on`: con `off` no hay códigos que
   * renovar, y la respuesta 400 (`peticionInvalida: mfa_no_activado`) evita que
   * un admin pulse "regenerar" en el caso equivocado y crea la impresión de que
   * hay códigos que él no puede ver.
   *
   * **No** genera un secret nuevo: el usuario ya tiene la app configurada y un
   * secret nuevo lo dejaría sin acceso. Regenerar códigos y cambiar el secret
   * son operaciones distintas, y la segunda es "desactivar y activar".
   */
  async regenerarCodigos(
    idusuario: string,
    admin: SesionAdmin,
    ctx: Peticion,
  ): Promise<{ usuario: string; codigos: string[]; unica_vez: true; estado: string }> {
    const usuario = await this.usuarioDelCliente(idusuario, admin.idcliente);
    const antes = await this.mfa.estadoDe(idusuario);

    if (antes.estado === 'off') {
      peticionInvalida('mfa_no_activado');
    }

    // `regenerarCodigos` y no `activar`: activar genera un secret nuevo y deja
    // el MFA en `pending`, y un usuario que ya tiene la app configurada se
    // quedaria sin acceso al confirmar. Regenerar codigos solo invalida los
    // anteriores (specs/01 §8.5).
    const codigos = await this.mfa.regenerarCodigos(idusuario);

    await this.auditoria.registrarSeguro({
      resultado: 'ok',
      idusuario: admin.idusuario,
      idaplicacion: null,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      detalle: detalleDe('admin_regenera_codigos_mfa', {
        usuario: idusuario,
        cliente: admin.idcliente,
        estado_anterior: antes.estado,
      }),
    });

    this.logger.warn(
      `admin ${admin.usuario} regenera los codigos de MFA de ${usuario.usuario} ` +
        `(cliente=${admin.idcliente}); los anteriores quedan invalidos`,
    );

    return {
      usuario: usuario.usuario,
      codigos: codigos.map(formatearCodigo),
      unica_vez: true,
      estado: antes.estado,
    };
  }

  /**
   * Estado del MFA de un usuario del cliente, para la fila de la tabla.
   *
   * `mfa_secret_cifrada` **no** sale de acá: el tipo `EstadoMfaUsuario` es el que
   * no lo declara, y el secret nunca se descifra para mostrarlo (criterio de la
   * fase 09: "el campo no está" en el listado del panel).
   */
  async estadoDe(idusuario: string, admin: SesionAdmin) {
    await this.usuarioDelCliente(idusuario, admin.idcliente);
    return this.mfa.estadoDe(idusuario);
  }

  /**
   * Usuario **del cliente** o 404.
   *
   * La misma comprobación que hace `AdminUsuariosService`, repetida acá a
   * propósito: si el filtro de membresía viviera en un solo service, un método
   * nuevo escrito en el otro no lo tendría y administersa el MFA de un usuario
   * de otro tenant.
   */
  private async usuarioDelCliente(
    idusuario: string,
    idcliente: string,
  ): Promise<{ usuario: string; nombre_completo: string }> {
    const fila = await this.prisma.idn_usuario.findFirst({
      where: { idusuario, membresias: { some: { idcliente } } },
      select: { usuario: true, nombre: true, apellido: true },
    });

    if (!fila) {
      noEncontrado();
    }

    return {
      usuario: fila.usuario,
      nombre_completo: `${fila.nombre} ${fila.apellido}`.trim() || fila.usuario,
    };
  }
}
