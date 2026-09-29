import { Controller, Get, Header } from '@nestjs/common';
import { FirmaService, JwkFirma } from '../claves/firma.service';

/**
 * TTL del memo en memoria del JWKS. Corto a proposito: el IdP que sigue
 * publicando una clave que el administrador acaba de retirar por compromise
 * durante una hora seria una rotacion a medias. `specs/01` §5 pone la ventana de
 * solapamiento en 24 h para el lado de las apps (que cachean 24 h), no para el
 * emisor.
 */
const TTL_JWKS_SERVIDOR_MS = 60 * 1000;

/**
 * `GET /.well-known/jwks.json`.
 *
 * Publico y **solo material publico**: la clave privada vive cifrada en
 * `tok_clave_firma` y no sale de ahi (`specs/01` §5). El documento se arma desde
 * el JWK que se guardo al crear el par, asi que no hay conversion en cada
 * request ni occasion de que una fila con la privada se cuelgue en la respuesta.
 *
 * Vive en el modulo de OIDC y no en `claves/`: la ruta es fija por
 * especificacion, asi que no lleva prefijo de controller.
 */
@Controller('.well-known')
export class JwksController {
  private memo: { claves: JwkFirma[]; venceEn: number } | null = null;
  private enCurso: Promise<{ keys: JwkFirma[] }> | null = null;

  constructor(private readonly firma: FirmaService) {}

  @Get('jwks.json')
  @Header('Cache-Control', 'public, max-age=300')
  async jwks() {
    if (this.memo && this.memo.venceEn > Date.now()) {
      return { keys: this.memo.claves };
    }

    if (!this.enCurso) {
      this.enCurso = this.firma.jwks().finally(() => {
        this.enCurso = null;
      });
    }

    const resultado = await this.enCurso;
    this.memo = { claves: resultado.keys, venceEn: Date.now() + TTL_JWKS_SERVIDOR_MS };
    return resultado;
  }
}
