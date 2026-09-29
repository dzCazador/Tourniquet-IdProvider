import { Injectable } from '@nestjs/common';
import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto';
import {
  importJWK,
  importPKCS8,
  jwtVerify,
  SignJWT,
  type JWK,
  type JWTPayload,
} from 'jose';
import { PrismaService } from '../prisma/prisma.service';
import { MasterKeyService } from './master-key.service';

/** Unico algoritmo aceptado. `specs/01` §5: `none` y HS256 se rechazan siempre. */
export const ALG_FIRMA = 'RS256';

/** `specs/01` §5: 2048 por defecto. Subir a 3072 requiere decision documentada. */
export const MODULUS_RSA = 2048;

/** La clave retirada sigue en el JWKS esta ventana (`specs/01` §5). */
export const VENTANA_JWKS_MS = 24 * 60 * 60 * 1000;

export type JwkFirma = JWK & { kid: string; alg: string; use: 'sig' };

/**
 * Payload del access token: exactamente la tabla de `specs/01` §2, ni un claim
 * mas. Lo arma `oidc/claims.ts` y lo firma `FirmaService`; que sea un tipo y no
 * un `object` es lo que hace que agregar un claim sea un cambio visible en el
 * compilador y no algo que aparece de golpe en un token de produccion.
 */
export interface ClaimsAccess {
  iss: string;
  sub: string;
  aud: string;
  tenant: string;
  base?: string;
  nombre: string;
  sid: string;
  amr: string[];
  jti: string;
}

@Injectable()
export class FirmaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly masterKey: MasterKeyService,
  ) {}

  /**
   * `kid` = primeros 16 hex de sha256 del SPKI DER. Es estable para la misma
   * clave, no filtra nada de la privada y no depende del formato en que se
   * guarde el PEM.
   */
  private calcularKid(spkiDer: Buffer): string {
    return createHash('sha256').update(spkiDer).digest('hex').slice(0, 16);
  }

  /**
   * Genera el par RSA 2048. La publica se guarda como JWK (es lo que el JWKS
   * sirve tal cual); la privada sale en PKCS#8 PEM para cifrarla.
   */
  generarPar(): { kid: string; publicaJwk: JwkFirma; privadaPem: string } {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: MODULUS_RSA,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    const spkiDer = createPublicKey(publicKey).export({ type: 'spki', format: 'der' });
    const kid = this.calcularKid(spkiDer);

    // `export({ format: 'jwk' })` tipa todos los campos como opcionales porque
    // JsonWebKey es la union de todos los algoritmos. Para RSA, `n` y `e`
    // estan siempre: se narrowing explicito, no un cast a ciegas.
    const nodo = createPublicKey(publicKey).export({ format: 'jwk' });

    const publicaJwk: JwkFirma = {
      kty: 'RSA',
      n: nodo.n as string,
      e: nodo.e as string,
      kid,
      alg: ALG_FIRMA,
      use: 'sig',
    };

    return { kid, publicaJwk, privadaPem: privateKey };
  }

  /**
   * Inserta una clave ya generada. La privada se cifra acá y no antes: en
   * ningun momento existe en claro persistida.
   */
  private async insertar(publicaJwk: JwkFirma, privadaPem: string) {
    return this.prisma.tok_clave_firma.create({
      data: {
        kid: publicaJwk.kid,
        alg: ALG_FIRMA,
        clave_publica: JSON.stringify(publicaJwk),
        clave_privada_cifrada: this.masterKey.cifrar(privadaPem),
        activa: true,
        creado_en: new Date(),
      },
    });
  }

  /** Devuelve la clave activa, o `null` si la tabla esta vacia. */
  async leerActiva() {
    return this.prisma.tok_clave_firma.findFirst({ where: { activa: true } });
  }

  /**
   * Idempotente: si ya hay una activa no genera otra. Un doble arranque no
   * debe dejar dos `activa=1` ni invalidar tokens ya emitidos.
   */
  async asegurarActiva(): Promise<string> {
    const actual = await this.leerActiva();
    if (actual) {
      return actual.kid;
    }
    const { publicaJwk, privadaPem } = this.generarPar();
    const fila = await this.insertar(publicaJwk, privadaPem);
    return fila.kid;
  }

  /**
   * Rotacion (`specs/01` §5): generar -> publicar -> firmar con la nueva ->
   * retirar la anterior, que sigue en el JWKS 24 h para que los tokens viejos
   * (15 min de vida) validen con relojes desincronizados.
   *
   * Existe desde esta fase pero NO se expone por HTTP: la rotacion es de la
   * Fase 09, y un endpoint de rotacion abierto seria una via para DoS sobre
   * los tokens del tenant.
   */
  async activarNueva(): Promise<string> {
    const { publicaJwk, privadaPem } = this.generarPar();
    const ahora = new Date();

    await this.prisma.$transaction([
      this.prisma.tok_clave_firma.updateMany({
        where: { activa: true },
        data: { activa: false, retirada_en: ahora },
      }),
      this.prisma.tok_clave_firma.create({
        data: {
          kid: publicaJwk.kid,
          alg: ALG_FIRMA,
          clave_publica: JSON.stringify(publicaJwk),
          clave_privada_cifrada: this.masterKey.cifrar(privadaPem),
          activa: true,
          creado_en: ahora,
        },
      }),
    ]);

    return publicaJwk.kid;
  }

  /**
   * JWKS publico: la activa mas las retiradas dentro de 24 h. Las mas viejas
   * se caen, asi que el documento no crece sin limite y un `kid` que ya no esta
   * fuerza a la app a refrescar (que es el comportamiento Wanted).
   */
  async jwks(): Promise<{ keys: JwkFirma[] }> {
    const ahora = new Date();
    const filas = await this.prisma.tok_clave_firma.findMany({
      where: {
        OR: [
          { activa: true },
          { retirada_en: { gte: new Date(ahora.getTime() - VENTANA_JWKS_MS) } },
        ],
      },
      orderBy: { creado_en: 'desc' },
    });

    const keys: JwkFirma[] = [];
    for (const fila of filas) {
      try {
        keys.push(JSON.parse(fila.clave_publica) as JwkFirma);
      } catch {
        // Una fila corrupta no debe tumbar el JWKS entero: se saltea.
      }
    }
    return { keys };
  }

  /**
   * Firma un access token con la clave activa. `iat`, `nbf` y `exp` los pone
   * acá: son tiempo de emision, no datos, y que los escriba una sola funcion
   * evita que dos rutas de emision produzcan tokens con TTL distintos.
   *
   * `nbf = iat` a proposito. `specs/01` §5 le exige a las apps verificar
   * `nbf`, y un `nbf` ausente no se verifica: no es un chequeo, es un campo de
   * adorno. Como el reloj del IdP y el de la app pueden diferir, el margen de
   * 60 s de `clockTolerance` es lo que evita que un token "`recién emitido`"
   * falle por un segundo de diferencia.
   */
  async firmar(claims: ClaimsAccess, vidaMinutos: number): Promise<string> {
    const clave = await this.leerActiva();
    if (!clave) {
      throw new Error('No hay clave de firma activa en tok_clave_firma.');
    }

    const privada = await this.clavePrivada(clave.kid);

    const ahora = Math.floor(Date.now() / 1000);

    // Los claims van en el payload del constructor: `SignJWT` en jose v5 no
    // expone `setClaim`.
    return new SignJWT({
      tenant: claims.tenant,
      ...(claims.base ? { base: claims.base } : {}),
      nombre: claims.nombre,
      sid: claims.sid,
      amr: claims.amr,
    })
      .setProtectedHeader({ alg: ALG_FIRMA, kid: clave.kid, typ: 'JWT' })
      .setIssuer(claims.iss)
      .setAudience(claims.aud)
      .setSubject(claims.sub)
      .setIssuedAt(ahora)
      .setNotBefore(ahora)
      .setExpirationTime(ahora + vidaMinutos * 60)
      .setJti(claims.jti)
      .sign(privada);
  }

  /**
   * Descifra la clave privada activa.
   *
   * El mensaje de error es explícito a propósito. GCM da
   * "Unsupported state or unable to authenticate data", que no dice si el
   * problema es la master key, la fila o el ciphertext; y desde `/oidc/token`
   * eso llega al cliente como un `invalid_grant` sin pista, porque el canje de
   * un code que sí existe falla en el paso de firma. Con la master key
   * equivocada el síntoma aparece como "mis codes no se canjean" y la causa
   * real está a tres archivos de distancia.
   *
   * OJO: la master key correcta es la del entorno, y se valida **por descifrado**,
   * no por formato. `decodificarMasterKey` acepta 32 bytes base64 que no son la
   * clave con la que se cifró la fila, así que el arranque puede pasar y el
   * fallo aparece recién acá.
   */
  private async clavePrivada(kid: string): Promise<import('jose').KeyLike> {
    const fila = await this.prisma.tok_clave_firma.findUnique({ where: { kid } });
    if (!fila) {
      throw new Error(`La clave de firma ${kid} desaparecio de tok_clave_firma.`);
    }

    let privadaPem: string;
    try {
      privadaPem = this.masterKey.descifrar(fila.clave_privada_cifrada);
    } catch {
      throw new Error(
        `TQ_MASTER_KEY no descifra la clave de firma activa (kid=${kid}). ` +
          'O la master key del entorno no es con la que se cifro esta fila (hay que ' +
          'generar una clave nueva con `activarNueva()`), o la fila esta corrupta.',
      );
    }

    return importPKCS8(privadaPem, ALG_FIRMA);
  }

  /**
   * Verifica un token contra un conjunto de claves publicas, restringiendo `alg`
   * a RS256: un `alg=none` o un HS256 con la publica como secreto se rechazan
   * antes de tocar la firma.
   *
   * `audience` es opcional a proposito, y solo para un caso: los endpoints del
   * propio IdP (`/userinfo`), que no pertenecen a ninguna app y por lo tanto no
   * tienen un `aud` legitimo que exigir. En una app, siempre se pasa: es el
   * control que impide que el token de RHPro Chile sirva en la instalacion de
   * Argentina.
   *
   * `vidaMinutos` acota el reloj: sin ese chequeo, un token con `iat` muy viejo
   * (y `exp` movido con el) seguiria aceptandose. `specs/01` §3 pone la vida
   * del access en 15 min.
   */
  async verificar(
    token: string,
    claves: JwkFirma[],
    opciones: { issuer: string; audience?: string; vidaMinutos: number },
  ): Promise<JWTPayload> {
    if (claves.length === 0) {
      throw new Error('No hay claves publicadas en el JWKS.');
    }

    // OJO: el `kid` viaja en el HEADER, no en el payload. `token.split('.')` da
    // [header, payload, firma]: leer el elemento [1] devolvia siempre `undefined`
    // y `verificar()` rechazaba hasta los tokens bien firmados por el propio IdP.
    // El bug no se ve en la Fase 02 porque la verificacion de ahi usaba
    // `jwtVerify` con la clave publica, sin pasar por acá.
    const [cabecera] = token.split('.');
    let kid: string | undefined;
    try {
      kid = cabecera
        ? (JSON.parse(Buffer.from(cabecera, 'base64url').toString('utf8')) as { kid?: string }).kid
        : undefined;
    } catch {
      throw new Error('Token malformado.');
    }

    const jwk = claves.find((k) => k.kid === kid);
    if (!jwk) {
      // Se propaga el `kid` para que el que llama sepa si tiene que refrescar el
      // JWKS (una vez por token, no por request: `specs/01` §5).
      throw new Error(`kid desconocido: ${kid ?? '(ausente)'}.`);
    }

    const clave = await importJWK(jwk, ALG_FIRMA);

    const { payload } = await jwtVerify(token, clave, {
      algorithms: [ALG_FIRMA],
      issuer: opciones.issuer,
      audience: opciones.audience,
      clockTolerance: 60,
      maxTokenAge: opciones.vidaMinutos * 60,
    });

    return payload;
  }
}
