import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FirmaService } from '../claves/firma.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuditoriaService, CodigoDetalle, ResultadoAuditoria } from '../auth/auditoria.service';
import { RateLimitService } from '../auth/rate-limit.service';
import { AplicacionService } from './aplicacion.service';
import { ClaimsService } from './claims';
import { challengeS256, compararSecreto, generarRefreshToken, huellaCorta, sha256Hex } from './codigos';
import { ErrorOidc } from './errores';
import { Sesion, SesionService } from './sesion.service';
import { ACCESS_TTL_MIN_POR_DEFECTO } from './vidas';

export const GRANT_CODE = 'authorization_code';
export const GRANT_REFRESH = 'refresh_token';

export interface RespuestaToken {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
}

export interface CuerpoToken {
  grant_type?: string | undefined;
  code?: string | undefined;
  redirect_uri?: string | undefined;
  client_id?: string | undefined;
  code_verifier?: string | undefined;
  refresh_token?: string | undefined;
  scope?: string | undefined;
}

export interface ContextoToken {
  ip: string;
  userAgent: string;
}

type CodeRow = {
  id: number;
  sid: string;
  idaplicacion: string;
  code_hash: string;
  code_challenge: string;
  method: string;
  redirect_uri: string;
  creado_en: Date;
  expira_en: Date;
  usado_en: Date | null;
};

type RefreshRow = {
  id: number;
  sid: string;
  idaplicacion: string;
  creado_en: Date;
  expira_en: Date;
  usado_en: Date | null;
  revocado_en: Date | null;
};

/**
 * `POST /oidc/token`: canje de authorization code y renovacion por refresh.
 *
 * Dos reglas gobiernan todo el archivo:
 *
 *   - **El code y el refresh son de un solo uso.** El canje marca `usado_en` con
 *     un `update` condicional (`WHERE usado_en IS NULL`) y mira que haya
 *     afectado una fila: dos requests simultaneos con el mismo code pasan los
 *     dos la lectura y solo uno debe ganar el canje. El que pierde ve
 *     `invalid_grant` y queda auditado como `replay`.
 *   - **Reusar un refresh ya rotado revoca la familia.** Es la unica senal fiable
 *     de robo: o el atacante robo el token, o la app legitima lo reuso, y en los
 *     dos casos la sesion se cae y queda el evento `replay` (`specs/01` §3).
 */
@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);
  private readonly vidaAccess: number;
  private readonly limitePorMinuto: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly firma: FirmaService,
    private readonly claims: ClaimsService,
    private readonly sesiones: SesionService,
    private readonly apps: AplicacionService,
    private readonly auditoria: AuditoriaService,
    private readonly limite: RateLimitService,
    config: ConfigService,
  ) {
    this.vidaAccess = config.get<number>('ACCESS_TTL_MIN') ?? ACCESS_TTL_MIN_POR_DEFECTO;
    this.limitePorMinuto = config.get<number>('RATE_LIMIT_POR_MINUTO') ?? 10;
  }

  async canjear(body: CuerpoToken, ctx: ContextoToken): Promise<RespuestaToken> {
    this.aplicarLimitePorIp(ctx);

    const code = this.requerido(body.code);
    const redirectUri = this.requerido(body.redirect_uri);
    const verifier = this.requerido(body.code_verifier);
    const clientId = this.requerido(body.client_id);

    // --- Buscar el code por su huella. El valor en claro nunca se persiste ---
    const hash = sha256Hex(code);
    const fila: CodeRow | null = await this.prisma.tok_autorization_code.findUnique({
      where: { code_hash: hash },
    });

    if (!fila) {
      await this.auditar('error', null, 'code_desconocido', ctx, { huella: hash, app: null });
      throw new ErrorOidc('invalid_grant');
    }

    const conCode = (resultado: ResultadoAuditoria, detalle: CodigoDetalle) =>
      this.auditar(resultado, null, detalle, ctx, { huella: hash, app: fila.idaplicacion });

    // --- Un solo uso -------------------------------------------------------
    if (fila.usado_en !== null) {
      // No se revoca la sesion: un doble clic o un reintento de red de la app
      // legitima se ven igual que un robo, y castigar al usuario por eso lo deja
      // sin apps. La familia se revoca solo en el reuso de refresh, que si es la
      // senal de robo (`specs/01` §9).
      await conCode('replay', 'code_reutilizado');
      throw new ErrorOidc('invalid_grant');
    }

    // --- Expirado ----------------------------------------------------------
    const ahora = new Date();
    if (fila.expira_en <= ahora) {
      await conCode('expirado', 'code_vencido');
      throw new ErrorOidc('invalid_grant');
    }

    // --- La app del code tiene que seguir viva y ser la que se pidio --------
    const app = await this.apps.activa(fila.idaplicacion);
    if (!app || app.codigo !== clientId) {
      await conCode('error', 'app_desconocida');
      throw new ErrorOidc('invalid_grant');
    }

    // --- PKCE ---------------------------------------------------------------
    // `challengeS256` recalcula el challenge del verifier que manda el cliente
    // y lo compara con el que se guardo. La comparacion es en tiempo constante:
    // comparar con `!==` devuelve en cuanto encuentra la primer diferencia, y
    // con un codechallege corto se puede adivinar (trampa 2 de la Fase 03).
    if (!compararSecreto(challengeS256(verifier), fila.code_challenge)) {
      await conCode('error', 'verificador_incorrecto');
      throw new ErrorOidc('invalid_grant');
    }

    // --- redirect_uri IDENTICO al del authorize ----------------------------
    // Validarlo solo en el authorize deja el canje abierto a otro `redirect_uri`
    // (trampa 1): el code viaja en el query de un 302 y lo captura cualquiera que
    // este en la red del cliente.
    if (redirectUri !== fila.redirect_uri) {
      await conCode('error', 'redirect_distinto');
      throw new ErrorOidc('invalid_grant');
    }

    // --- Marcar usado (condicional) ----------------------------------------
    const { count } = await this.prisma.tok_autorization_code.updateMany({
      where: { id: fila.id, usado_en: null },
      data: { usado_en: ahora },
    });

    if (count === 0) {
      // Perdio la carrera contra otro canje del mismo code.
      await conCode('replay', 'code_reutilizado');
      throw new ErrorOidc('invalid_grant');
    }

    // --- Sesion de la app ---------------------------------------------------
    const sesion = await this.sesiones.viva(fila.sid);
    if (!sesion) {
      await conCode('error', 'sesion_cerrada');
      throw new ErrorOidc('invalid_grant');
    }

    this.aplicarLimitePorUsuario(sesion.idusuario, ctx);

    // --- Emitir -------------------------------------------------------------
    const { respuesta } = await this.emitir(sesion, this.responderScope(body.scope));
    await this.auditar('ok', sesion.idusuario, null, ctx, { app: fila.idaplicacion });

    this.logger.log(
      `code canjeado app=${fila.idaplicacion} sid=${fila.sid.slice(0, 8)} ` +
        `code=${huellaCorta(code)}`,
    );

    return respuesta;
  }

  async renovar(body: CuerpoToken, ctx: ContextoToken): Promise<RespuestaToken> {
    this.aplicarLimitePorIp(ctx);

    const refresh = this.requerido(body.refresh_token);
    const clientId = this.requerido(body.client_id);

    const hash = sha256Hex(refresh);
    const fila: RefreshRow | null = await this.prisma.tok_refresh_token.findUnique({
      where: { token_hash: hash },
    });

    if (!fila) {
      await this.auditar('error', null, 'refresh_desconocido', ctx, { huella: hash, app: null });
      throw new ErrorOidc('invalid_grant');
    }

    const conRefresh = (resultado: ResultadoAuditoria, detalle: CodigoDetalle) =>
      this.auditar(resultado, null, detalle, ctx, { huella: hash, app: fila.idaplicacion });

    if (fila.revocado_en !== null) {
      await conRefresh('error', 'refresh_revocado');
      throw new ErrorOidc('invalid_grant');
    }

    // --- REPLAY: el token ya se uso. Se cae toda la familia. ---------------
    if (fila.usado_en !== null) {
      const revocados = await this.sesiones.revocarFamilia(fila.sid, 'replay');
      await this.sesiones.cerrar(fila.sid, 'replay');
      await conRefresh('replay', 'refresh_reutilizado');

      this.logger.warn(
        `REPLAY de refresh en app=${fila.idaplicacion} sid=${fila.sid.slice(0, 8)}: ` +
          `familia revocada (${revocados} refresh). Sesion cerrada por replay.`,
      );
      throw new ErrorOidc('invalid_grant');
    }

    const ahora = new Date();

    if (fila.expira_en <= ahora) {
      await conRefresh('expirado', 'refresh_vencido');
      throw new ErrorOidc('invalid_grant');
    }

    // --- La sesion manda sobre el token ------------------------------------
    // Un refresh "valido" de una sesion cerrada (logout, revocada, replay
    // anterior) no sirve: la sesion es lo que se revocó, no el token.
    const sesion = await this.sesiones.porSid(fila.sid);
    if (!sesion || sesion.cerrada_en !== null) {
      await conRefresh('error', 'sesion_cerrada');
      throw new ErrorOidc('invalid_grant');
    }
    if (sesion.expira_en <= ahora) {
      await conRefresh('expirado', 'sesion_expirada');
      throw new ErrorOidc('invalid_grant');
    }

    if (fila.idaplicacion !== clientId) {
      await conRefresh('error', 'app_desconocida');
      throw new ErrorOidc('invalid_grant');
    }

    this.aplicarLimitePorUsuario(sesion.idusuario, ctx);

    // --- Rotacion estricta --------------------------------------------------
    const { count } = await this.prisma.tok_refresh_token.updateMany({
      where: { id: fila.id, usado_en: null },
      data: { usado_en: ahora },
    });

    if (count === 0) {
      const revocados = await this.sesiones.revocarFamilia(fila.sid, 'replay');
      await this.sesiones.cerrar(fila.sid, 'replay');
      await conRefresh('replay', 'refresh_reutilizado');
      this.logger.warn(
        `REPLAY concurrente de refresh sid=${fila.sid.slice(0, 8)}: familia revocada (${revocados})`,
      );
      throw new ErrorOidc('invalid_grant');
    }

    // --- Emitir access + refresh nuevo, mismo `sid` -------------------------
    const { respuesta, idRefresh } = await this.emitir(sesion, 'openid');

    // La cadena de rotacion: el eslabon viejo apunta al nuevo. Permite
    // reconstruir la familia andando el eslabon (y guardar el motivo `rotado`,
    // que no es revocacion: ese token ya se uso).
    await this.prisma.tok_refresh_token.update({
      where: { id: fila.id },
      data: { reemplazado_por: idRefresh, motivo: 'rotado' },
    });

    await this.auditar('ok', sesion.idusuario, null, ctx, { app: fila.idaplicacion });
    return respuesta;
  }

  /**
   * Emite el access y un refresh nuevo, y conecta la rotacion.
   *
   * El `sid` **no** cambia: la sesion sobrevive al refresh. Lo que se renueva es
   * el `iat`/`exp` del access y la vida del refresh.
   *
   * Devuelve el `id` del refresh nuevo por separado y no dentro de la respuesta
   * que va por HTTP: `_idRefresh` es un dato interno (sirve para el eslabon
   * `reemplazado_por`) y mandarlo en el token response seria filtrar un id de
   * fila a un cliente que no lo necesita.
   */
  private async emitir(
    sesion: Sesion,
    scope: string,
  ): Promise<{ respuesta: RespuestaToken; idRefresh: number }> {
    const claims = await this.claims.construir(sesion);
    const access = await this.firma.firmar(claims, this.vidaAccess);

    const refresh = generarRefreshToken();
    const expiraEn = await this.sesiones.expiraRefresh(sesion);

    const creado = await this.prisma.tok_refresh_token.create({
      data: {
        sid: sesion.sid,
        idaplicacion: sesion.idaplicacion ?? '',
        token_hash: sha256Hex(refresh),
        creado_en: new Date(),
        // 7 dias de inactividad, recortados por la vida absoluta de la sesion:
        // el deslizamiento nunca extiende `tok_sesion.expira_en` (`specs/01` §3).
        expira_en: expiraEn,
      },
      select: { id: true },
    });

    return {
      idRefresh: creado.id,
      respuesta: {
        access_token: access,
        token_type: 'Bearer',
        expires_in: this.vidaAccess * 60,
        refresh_token: refresh,
        scope,
      },
    };
  }

  /**
   * El scope que se devuelve. No se persiste en el code (la tabla no tiene
   * columna, y `specs/01` §2.1 lo deja anotado), asi que en el canje se devuelve
   * el pedido y en el refresh el default. `/userinfo` no depende del scope.
   */
  private responderScope(scope: string | undefined): string {
    const pedido = (scope ?? '').split(/\s+/).filter(Boolean);
    return pedido.length > 0 ? pedido.join(' ') : 'openid';
  }

  /**
   * Parametro obligatorio del canje.
   *
   * Falta ⇒ `invalid_grant` y no `invalid_request`. El RFC 6749 §4.1.3 pide
   * `invalid_request` para un parametro faltante, pero la Fase 03 es explicita:
   * un canje sin `code_verifier` es `invalid_grant`. Ademas tiene mas sentido:
   * `invalid_request` le diria al cliente "te falta un parametro" y
   * `invalid_grant` "tu credencial no sirve", que es la misma situacion para
   * el que esta integrando, y no distingue un code malo de un code al que le
   * falta la mitad de la informacion.
   */
  private requerido(valor: string | undefined): string {
    if (typeof valor !== 'string' || valor.length === 0) {
      throw new ErrorOidc('invalid_grant');
    }
    return valor;
  }

  /**
   * Doble limite de `specs/01` §4: por IP siempre, por usuario cuando se sabe.
   * El que se aplica es el primero que salta, y queda auditado (`rate_limit`):
   * un rate limit que no deja rastro es un rate limit del que nadie se puede
   * enterar cuando empieza a doler.
   */
  private aplicarLimitePorIp(ctx: ContextoToken): void {
    const cuota = this.limite.consumir('ip', ctx.ip, this.limitePorMinuto);
    if (!cuota.permitido) {
      void this.auditar('error', null, 'rate_limit', ctx);
      throw new ErrorOidc('temporarily_unavailable', null, 429);
    }
  }

  private aplicarLimitePorUsuario(idusuario: string, ctx: ContextoToken): void {
    const cuota = this.limite.consumir('usuario', idusuario, this.limitePorMinuto);
    if (!cuota.permitido) {
      void this.auditar('error', idusuario, 'rate_limit', ctx);
      throw new ErrorOidc('temporarily_unavailable', null, 429);
    }
  }

  private async auditar(
    resultado: ResultadoAuditoria,
    idusuario: string | null,
    detalle: CodigoDetalle | null,
    ctx: ContextoToken,
    extra: { huella?: string; app?: string | null } = {},
  ): Promise<void> {
    // El `detalle` lleva la huella del code/refresh (8 hex) para poder seguir
    // una credencial en el log sin escribirla: con el sha256 entero el `detalle`
    // duplicaria el `code_hash` de la fila de al lado, que ya existe para eso.
    // La credencial en claro, jamas.
    const sufijo = extra.huella ? `:${extra.huella.slice(0, 8)}` : '';
    await this.auditoria.registrarSeguro({
      resultado,
      idusuario,
      idaplicacion: extra.app ?? null,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      detalle: detalle ? (`${detalle}${sufijo}` as CodigoDetalle) : null,
    });
  }
}
