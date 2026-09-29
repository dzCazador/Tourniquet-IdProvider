import { Injectable } from '@nestjs/common';
import { errors as joseErrors } from 'jose';
import { FirmaService, JwkFirma, ALG_FIRMA } from '../claves/firma.service';
import { JwksCacheService } from './jwks-cache';
import { JtiCacheService } from './jti-cache';
import { ACCESS_TTL_MIN_POR_DEFECTO } from './vidas';

/**
 * Motivo por el que un token fue rechazado. Son codigos cerrados: el endpoint
 * responde 401 con `WWW-Authenticate` y el motivo va al log o a la auditoria,
 * nunca al cliente (un `kid` desconocido y una firma invalida se responden
 * igual: distinguirlos le diria al atacante si su token esta cerca de servir).
 */
export type MotivoRechazo =
  | 'malformado'
  | 'alg_invalido'
  | 'kid_desconocido'
  | 'firma_invalida'
  | 'expirado'
  | 'iss_invalido'
  | 'aud_invalido'
  | 'tenant_invalido'
  | 'jti_repetido';

export type ResultadoValidacion =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; motivo: MotivoRechazo; kid?: string };

export interface OpcionesValidar {
  /**
   * `iss` que espera quien valida. OBLIGATORIO: es el control que impide que un
   * token valido de **otra** instalacion (que use la misma clave, por ejemplo un
   * entorno de pruebas) sirva aca.
   */
  issuer: string;
  /**
   * `aud` que espera la app. Se puede omitir **solo** en endpoints del propio IdP
   * (`/userinfo`), que no pertenece a ninguna app: ahi no hay un `aud` legitimo
   * que exigir. En una app, siempre.
   */
  audience?: string;
  /** `tenant` que espera esta instalacion (`specs/00` D2, `specs/03`). */
  tenant?: string;
  /** Vida esperada del access, para acotar `iat`/`maxTokenAge`. */
  vidaMinutos?: number;
  /**
   * Rechazar un `jti` ya presentado. Apagado por defecto: en un endpoint de
   * recurso el mismo token se presenta varias veces por diseño (ver
   * `jti-cache.ts`). Lo enciende quien tenga un evento de un solo uso en la mano.
   */
  consumirJti?: boolean;
}

/**
 * Verificacion de tokens: el codigo de referencia.
 *
 * Es el mismo validador que usa `/userinfo` y el que RHPro va a copiar en la
 * Fase 06. Vive en el repo, y no en el script de pruebas, por una razon que ya
 * se pago una vez en la Fase 02: un validador que existe en dos versiones se
 * contradice sin que nadie se entere, y el que se contradice es el que decide si
 * un token es de tu tenant.
 *
 * Lo que verifica, en este orden:
 *   1. que el token sea un JWT con header legible;
 *   2. `alg` fijo RS256 (el verificador de `jose` lo rechaza antes de mirar la
 *      firma: `alg=none` y HS256 mueren acá, sin haber confiado en nada);
 *   3. la firma contra la clave del `kid` del **header**;
 *   4. `iss`, `aud`, `exp`/`nbf` con 60 s de tolerancia y `maxTokenAge`;
 *   5. `tenant`, si la app lo espera;
 *   6. `jti`, si el que llama pidio el control anti-replay.
 */
@Injectable()
export class ValidadorService {
  constructor(
    private readonly firma: FirmaService,
    private readonly jwks: JwksCacheService,
    private readonly jti: JtiCacheService,
  ) {}

  async validar(token: string, opciones: OpcionesValidar): Promise<ResultadoValidacion> {
    const cabecera = this.leerCabecera(token);
    if (!cabecera) {
      return { ok: false, motivo: 'malformado' };
    }

    // `alg` se mira ANTES de buscar la clave. Un `alg=none` o un HS256 con un
    // `kid` que no existe tiene que morir por el algoritmo, no "porque no
    // conozco esa clave": si el motivo fuera el `kid`, un atacante veria que su
    // token con HS256 murio en un paso distinto al de un RS256 con firma mala, y
    // el mensaje de error le diria que el camino que funciona es el del `kid`.
    if (cabecera.alg !== ALG_FIRMA) {
      return { ok: false, motivo: 'alg_invalido', kid: cabecera.kid };
    }

    let claves: JwkFirma[];
    try {
      claves = await this.jwks.clavesParaKid(cabecera.kid);
    } catch {
      // Fallo de la fuente del JWKS (base caida). No es un token invalido: es un
      // error del IdP, y por eso NO se responde 401 sino 500.
      throw new Error('No se pudo obtener el JWKS para validar el token.');
    }

    if (claves.length === 0 || !claves.some((k) => k.kid === cabecera.kid)) {
      return { ok: false, motivo: 'kid_desconocido', kid: cabecera.kid };
    }

    let payload: Record<string, unknown>;
    try {
      payload = (await this.firma.verificar(token, claves, {
        issuer: opciones.issuer,
        audience: opciones.audience,
        vidaMinutos: opciones.vidaMinutos ?? ACCESS_TTL_MIN_POR_DEFECTO,
      })) as Record<string, unknown>;
    } catch (error) {
      return { ok: false, motivo: this.motivo(error, token, opciones), kid: cabecera.kid };
    }

    if (opciones.tenant !== undefined && payload.tenant !== opciones.tenant) {
      return { ok: false, motivo: 'tenant_invalido', kid: cabecera.kid };
    }

    if (opciones.consumirJti) {
      const jti = typeof payload.jti === 'string' ? payload.jti : '';
      if (jti && !this.jti.consumir(jti)) {
        return { ok: false, motivo: 'jti_repetido', kid: cabecera.kid };
      }
    }

    return { ok: true, payload };
  }

  /**
   * Header del token: `alg` y `kid`.
   *
   * El `kid` viaja en el header y no en el payload (jose lo pone ahi, y leerlo
   * del lugar equivocado fue el bug que hacia que `FirmaService.verificar`
   * rechazara hasta los tokens bien firmados por el propio IdP). `jose` valida
   * los dos por su cuenta: leerlos aca es para elegir la clave antes de
   * verificar y para nombrar el motivo del rechazo.
   */
  private leerCabecera(token: string): { alg: string; kid: string } | null {
    const partes = token.split('.');
    if (partes.length !== 3) {
      return null;
    }
    try {
      const json = JSON.parse(Buffer.from(partes[0], 'base64url').toString('utf8')) as {
        alg?: unknown;
        kid?: unknown;
      };
      if (typeof json.alg !== 'string') {
        return null;
      }
      return { alg: json.alg, kid: typeof json.kid === 'string' ? json.kid : '' };
    } catch {
      return null;
    }
  }

  /**
   * Traduce el error de `jose` a un motivo cerrado.
   *
   * `ERR_JWT_CLAIM_VALIDATION_FAILED` no dice que claim fallo, asi que el
   * payload se vuelve a leer **sin verificar** para nombrar el motivo. Es seguro:
   * el token ya fue rechazado y lo que se devuelve es el motivo del rechazo, no
   * una decision. Confiar en ese payload seria otra cosa.
   */
  private motivo(error: unknown, token: string, opciones: OpcionesValidar): MotivoRechazo {
    const codigo = error instanceof joseErrors.JOSEError ? error.code : undefined;
    switch (codigo) {
      case 'ERR_JWT_EXPIRED':
        return 'expirado';
      case 'ERR_JWT_CLAIM_VALIDATION_FAILED': {
        const sinVerificar = this.leerPayloadSinVerificar(token);
        if (typeof sinVerificar?.iss === 'string' && sinVerificar.iss !== opciones.issuer) {
          return 'iss_invalido';
        }
        return 'aud_invalido';
      }
      case 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED':
      case 'ERR_JWS_INVALID':
        return 'firma_invalida';
      case 'ERR_JWT_INVALID':
        return 'malformado';
      default:
        return /algoritmo|algorithm/i.test(error instanceof Error ? error.message : String(error))
          ? 'alg_invalido'
          : 'firma_invalida';
    }
  }

  private leerPayloadSinVerificar(token: string): Record<string, unknown> | null {
    try {
      const partes = token.split('.');
      if (partes.length !== 3) {
        return null;
      }
      return JSON.parse(Buffer.from(partes[1], 'base64url').toString('utf8')) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}
