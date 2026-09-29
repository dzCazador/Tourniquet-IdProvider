import { Controller, Get, Header } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SCOPES_SOPORTADOS } from './authorize.service';
import { ALG_FIRMA } from '../claves/firma.service';

/**
 * `GET /.well-known/openid-configuration`.
 *
 * Publico, sin sesion: es lo primero que consulta cualquier cliente, y las apps
 * no tienen sesion todavia cuando lo hacen.
 *
 * Lo que se anuncia y lo que no es una decision: se anuncian `code` y PKCE
 * `S256` y nada mas. Anunciar implicit o `password` (que existen en el RFC y no
 * se implementan, `specs/01` §1) invita a los clientes a usarlos, y un cliente
 * que elige un flujo que el IdP no soporta falla en el peor momento: en el
 * login del usuario.
 */
@Controller('.well-known')
export class DiscoveryController {
  private readonly issuer: string;

  constructor(config: ConfigService) {
    this.issuer = config.getOrThrow<string>('TQ_ISSUER').replace(/\/+$/, '');
  }

  @Get('openid-configuration')
  @Header('Cache-Control', 'public, max-age=300')
  openidConfiguration() {
    const iss = this.issuer;
    return {
      issuer: iss,
      authorization_endpoint: `${iss}/oidc/authorize`,
      token_endpoint: `${iss}/oidc/token`,
      userinfo_endpoint: `${iss}/userinfo`,
      jwks_uri: `${iss}/.well-known/jwks.json`,
      revocation_endpoint: `${iss}/oidc/revoke`,
      end_session_endpoint: `${iss}/oidc/logout`,

      // Perfil minimo de `specs/01` §1. Lo que no esta en esta lista, este IdP
      // no lo hace.
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      response_modes_supported: ['query'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: [...SCOPES_SOPORTADOS],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: [ALG_FIRMA],
      // Sin `client_secret`: solo clientes publicos con PKCE (`specs/01` §1).
      token_endpoint_auth_methods_supported: ['none'],
      claims_supported: [
        'iss',
        'sub',
        'aud',
        'tenant',
        'base',
        'nombre',
        'sid',
        'amr',
        'jti',
        'iat',
        'nbf',
        'exp',
      ],
    };
  }
}
