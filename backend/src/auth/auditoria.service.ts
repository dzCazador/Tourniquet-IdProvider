import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** Los unicos valores que acepta el CHECK de `aud_login`. */
export type ResultadoAuditoria = 'ok' | 'claves' | 'bloq' | 'replay' | 'expirado' | 'error';

/**
 * Codigos de motivo para `detalle`. Nunca el input del usuario: un
 * `detalle` con el `usuario` tipeado es un vector de enumeracion de cuentas
 * aunque la tabla no sea publica.
 *
 * Ojo con `clave_incorrecta`: se usa TAMBIEN cuando el usuario no existe, a
 * proposito. Si se distinguen por el `detalle`, la tabla vuelve a filtrar que
 * cuentas hay aunque la respuesta sea identica. Quien mira la auditoria
 * distingue los casos por `idusuario IS NULL`.
 */
export type CodigoDetalle =
  | 'clave_incorrecta'
  | 'usuario_bloqueado'
  | 'intentos_superados'
  | 'usuario_inactivo'
  | 'rate_limit'
  | 'error_interno'
  // Login del portal (Fase 04). `returnto_invalido` se escribe con
  // `idusuario IS NULL` a proposito: se rechaza antes de verificar la clave,
  // asi que todavia no se sabe de que usuario se trata.
  | 'returnto_invalido'
  // Flujo OIDC (Fase 03). Mismo criterio: un codigo corto que dice **que paso**,
  // nunca el valor de la credencial. Los `code` y los refresh se anotan
  // hasheados (primeros 8 hex) en el `detalle`, jamas completos.
  | 'code_desconocido'
  | 'code_reutilizado'
  | 'code_vencido'
  | 'verificador_incorrecto'
  | 'redirect_distinto'
  | 'pkce_ausente'
  | 'refresh_desconocido'
  | 'refresh_reutilizado'
  | 'refresh_vencido'
  | 'refresh_revocado'
  | 'sesion_cerrada'
  | 'sesion_expirada'
  | 'sesion_revocada'
  | 'grant_desconocido'
  | 'parametro_invalido'
  | 'scope_invalido'
  | 'app_desconocida'
  | 'usuario_no_habilitado'
  | 'logout';

export interface EventoAuditoria {
  resultado: ResultadoAuditoria;
  idusuario: string | null;
  idaplicacion?: string | null;
  ip: string;
  userAgent: string;
  detalle?: CodigoDetalle | null;
}

/**
 * `aud_login` es append-only. Esta clase solo tiene `registrar`: no expone
 * update ni delete, y no hay forma de que un modulo los Agregue despues sin
 * escribir el metodo a mano. El borrado por retencion lo hace un job SQL
 * externo (`specs/01` §7).
 */
@Injectable()
export class AuditoriaService {
  private readonly logger = new Logger(AuditoriaService.name);

  constructor(private readonly prisma: PrismaService) {}

  async registrar(evento: EventoAuditoria): Promise<void> {
    await this.prisma.aud_login.create({
      data: {
        resultado: evento.resultado,
        idusuario: evento.idusuario,
        idaplicacion: evento.idaplicacion ?? null,
        ip: evento.ip,
        user_agent: (evento.userAgent || 'desconocido').slice(0, 500),
        detalle: evento.detalle ?? null,
        ts: new Date(),
      },
    });
  }

  /**
   * Auditar nunca debe tumbar un login. Si el INSERT falla se registra el
   * fallo con un codigo y se sigue: denegar el acceso a un usuario valido
   * porque la auditoria se caido seria un DoS:autoatribuido.
   */
  async registrarSeguro(evento: EventoAuditoria): Promise<void> {
    try {
      await this.registrar(evento);
    } catch (error) {
      this.logger.error(
        `No se pudo escribir aud_login (resultado=${evento.resultado}): ` +
          `${error instanceof Error ? error.message : 'error desconocido'}`,
      );
    }
  }
}
