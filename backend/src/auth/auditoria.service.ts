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
  | 'logout'
  // Portal lanzador y consentimiento (Fase 07). Los tres son del usuario sobre si
  // mismo, asi que el `idusuario` de la fila es el suyo y alcanza con el codigo.
  | 'consentimiento_aceptado'
  | 'sesion_cerrada_propia'
  | 'logout_todo'
  // Cambio de cliente activo (Fase 07). El `detalle` lleva el cliente nuevo, que
  // no es un campo de la tabla: por eso el `idusuario` solo no alcanza.
  | 'cambio_de_cliente'
  // Panel `admin_identidad` (Fase 08). El `idusuario` de estas filas es **el admin**,
  // que es quien actuo (`specs/01` §7), y el usuario afectado viaja en el `detalle`
  // con el formato `admin_<operacion>[|usuario=<uuid>][|app=<codigo>]`. Los
  // prefijos `admin_` no son decorativos: son lo que permite distinguir de un
  // vistazo una accion de administracion de un login en la lectura del panel.
  | 'admin_alta_usuario'
  | 'admin_edita_usuario'
  | 'admin_desactiva_usuario'
  | 'admin_reset_clave'
  | 'admin_habilita_app'
  | 'admin_deshabilita_app'
  | 'admin_cierra_sesion'
  | 'admin_cierra_sesiones_usuario'
  // MFA (Fase 09). Los cuatro primeros son del **login en dos pasos**: el
  // `idusuario` de esas filas es el usuario que esta verificando su segundo
  // factor, no un admin. Los tres `admin_` son del panel, con el criterio de
  // `specs/01` §7: `idusuario` = quien actuo, el afectado en el `detalle`.
  //
  // `mfa_requerido` es la fila que hace posible ver un ataque de fuerza bruta
  // sobre el segundo factor: dice "la clave de esta persona es correcta y el
  // factor no". Sin ella, un ingreso fallido a MFA sería indistinguible de una
  // clave mala en la lectura del panel.
  | 'mfa_requerido'
  | 'mfa_ok'
  | 'mfa_incorrecto'
  | 'mfa_desafio_invalido'
  | 'mfa_confirmado'
  | 'mfa_desactivado'
  | 'admin_activa_mfa'
  | 'admin_desactiva_mfa'
  | 'admin_regenera_codigos_mfa'
  // Rotacion de claves de firma (Fase 09, `specs/01` §5.1). El prefijo `op_` y no
  // `admin_` porque NO es una accion de un tenant: es de la instalacion entera, y
  // el detalle lo dice asi en la lectura.
  | 'op_rotacion_claves'
  | 'op_reactivacion_claves';

/**
 * `detalle` de una fila: el codigo solo, o el codigo seguido de los
 * identificadores que hacen falta para que la fila sirva.
 *
 * El tipo lo dice con una plantilla literal, no con un `string`: `CodigoDetalle` o
 * `CodigoDetalle|algo|mas` obliga a que el prefijo sea **uno de la lista cerrada** y
 * que lo que venga detras sea contexto, nunca otra cosa. Un `string` libre
 * permitiria escribir `detalle: usuario.pepito` —que es el vector de enumeracion que
 * este archivo existe para cerrar— sin que TypeScript lo notara.
 *
 * El formato es `codigo|k=v|k=v` con los `k` en `snake_case`. Los valores son
 * identificadores del sistema (`idusuario`, `codigo` de app o de cliente, `sid`),
 * nunca texto tipeado por alguien.
 */
export type DetalleAuditoria = CodigoDetalle | `${CodigoDetalle}|${string}`;

/**
 * Arma un `detalle` con contexto, descartando los identificadores que no aplican.
 *
 * `detalleDe('admin_cierra_sesion', { usuario: id, sid: 'a1b9…' })` produce
 * `admin_cierra_sesion|usuario=…|sid=…`. Los `undefined` y los `null` no dejan
 * rastro: un `usuario=` vacio se lee como un dato que se perdio, y en una tabla de
 * auditoria es peor que un dato que no se escribio.
 */
export function detalleDe(
  codigo: CodigoDetalle,
  contexto: Record<string, string | null | undefined>,
): DetalleAuditoria {
  const partes = Object.entries(contexto)
    .filter(([, valor]) => Boolean(valor))
    .map(([clave, valor]) => `${clave}=${valor as string}`);
  return partes.length === 0 ? codigo : `${codigo}|${partes.join('|')}`;
}

export interface EventoAuditoria {
  resultado: ResultadoAuditoria;
  idusuario: string | null;
  idaplicacion?: string | null;
  ip: string;
  userAgent: string;
  detalle?: DetalleAuditoria | null;
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
