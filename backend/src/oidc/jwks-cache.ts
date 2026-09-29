import { Inject, Injectable } from '@nestjs/common';
import { JwkFirma } from '../claves/firma.service';

/**
 * Como se trae el JWKS. Inyectado para que el mismo cache sirva para los dos
 * lados:
 *
 * - En la app, el "JWKS" es la tabla `tok_clave_firma` (lectura de la base): el
 *   IdP no se llama a si mismo por HTTP para validar su propio token, que seria
 *   un round-trip y una dependencia de su propia disponibilidad.
 * - En el script de verificacion (y en la Fase 06, en RHPro), el JWKS se pide
 *   por HTTP a `/.well-known/jwks.json`, que es lo que va a hacer cualquier app.
 */
export const CARGAR_JWKS = Symbol('CARGAR_JWKS');
export type CargarJwks = () => Promise<{ keys: JwkFirma[] }>;

/** Lado relying party (`specs/01` §5). */
export const TTL_JWKS_RP_MS = 24 * 60 * 60 * 1000;

/**
 * Minimo entre refrescos **forzados**. El refresco forzado es lo que responde a
 * un `kid` desconocido, y un `kid` desconocido lo produce cualquiera: sin este
 * tope, un atacante que mande tokens con `kid` inventado genera una lectura (o
 * un request HTTP) del JWKS por request, que es un DoS barato de armar.
 *
 * Con el tope, un `kid` inventado re-descarga el JWKS como maximo una vez cada
 * 30 s. El costo de equivocarse es bajo (un token recien emitido con una clave
 * recien rotada podria rechazarse y el cliente reintenta), el de no hacerlo es
 * alto.
 */
export const MINIMO_ENTRE_REFRESCOS_MS = 30 * 1000;

interface Entrada {
  claves: JwkFirma[];
  venceEn: number;
}

/**
 * Cache de JWKS con refresco forzado acotado.
 *
 * El TTL por defecto es el del lado RP (24 h, `specs/01` §5). El lado IdP pasa
 * uno mucho mas corto a proposito: si el IdP emitiera con una clave que el
 * administrador acaba de rotar por compromise, esperar 24 h para enterarse es
 * exactamente la rotacion que no se hizo.
 */
@Injectable()
export class JwksCacheService {
  private entrada: Entrada | null = null;
  private enCurso: Promise<{ keys: JwkFirma[] }> | null = null;
  private ultimoForzado = 0;

  constructor(
    @Inject(CARGAR_JWKS) private readonly cargar: CargarJwks,
    private readonly ttlMs: number = TTL_JWKS_RP_MS,
  ) {}

  /** Claves vigente de la cache, recargando si vencieron. */
  async claves(): Promise<JwkFirma[]> {
    if (this.entrada && this.entrada.venceEn > Date.now()) {
      return this.entrada.claves;
    }
    return (await this.recargar()).keys;
  }

  /**
   * Claves para validar **un** token. Si el `kid` no esta, intenta un refresco
   * forzado: una vez por token, y no mas de una vez cada
   * `MINIMO_ENTRE_REFRESCOS_MS` para todo el proceso.
   */
  async clavesParaKid(kid: string | undefined): Promise<JwkFirma[]> {
    const actuales = await this.claves();
    if (kid === undefined || actuales.some((k) => k.kid === kid)) {
      return actuales;
    }

    if (Date.now() - this.ultimoForzado < MINIMO_ENTRE_REFRESCOS_MS) {
      // Ya se re-descargo hace nada: devolver lo que hay y que la verificacion
      // falle con "kid desconocido" en vez de pegarle a la fuente otra vez.
      return actuales;
    }

    this.ultimoForzado = Date.now();
    return (await this.recargar()).keys;
  }

  /** Descarta la cache. Para la rotacion de claves (Fase 09). */
  invalidar(): void {
    this.entrada = null;
  }

  private async recargar(): Promise<{ keys: JwkFirma[] }> {
    // Una sola peticion en vuelo: si veinte requests piden refresco al mismo
    // tiempo (que es justo lo que hace un atacante), hacen una sola lectura.
    if (!this.enCurso) {
      this.enCurso = this.cargar().finally(() => {
        this.enCurso = null;
      });
    }

    const resultado = await this.enCurso;
    this.entrada = { claves: resultado.keys, venceEn: Date.now() + this.ttlMs };
    return resultado;
  }
}
