import { Injectable, Logger } from '@nestjs/common';
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
import { MINUTO_MS } from '../oidc/vidas';
import { MasterKeyService } from './master-key.service';

/** Unico algoritmo aceptado. `specs/01` §5: `none` y HS256 se rechazan siempre. */
export const ALG_FIRMA = 'RS256';

/** `specs/01` §5: 2048 por defecto. Subir a 3072 requiere decision documentada. */
export const MODULUS_RSA = 2048;

/** La clave retirada sigue en el JWKS esta ventana (`specs/01` §5). */
export const VENTANA_JWKS_MS = 24 * 60 * 60 * 1000;

/**
 * Cada cuanto se rota la clave de firma (`specs/01` §5): 90 dias, o por
 * compromiso.
 *
 * Vive aca y no en un `.env` porque no es configurable: es una politica del
 * producto, y una politica que se pueda aflojar con una variable es una politica
 * que alguien afloja. El que rota por compromiso (una clave filtrada) no espera
 * a que se cumpla el plazo, y por eso el mismo endpoint existe para las dos
 * cosas.
 */
export const DIAS_ROTACION = 90;

/** Una clave del estado de rotación, con lo que un operador necesita de ella. */
export interface ClaveEstado {
  kid: string;
  activa: boolean;
  creada_en: string;
  retirada_en: string | null;
  /** `true` si el JWKS la publica ahora mismo (activa o retirada hace < 24 h). */
  en_jwks: boolean;
  /**
   * Tokens de esta clave que todavía podrían estar vivos, o `null` si no se puede
   * saber todavía.
   *
   * `0` = ninguno: la clave se retiró hace mas de la vida del access token, así
   * que todo lo que firmó expiró solo. `null` = todavía pueden quedar algunos, y
   * la cuenta es la ventana de vida del access.
   */
  tokens_en_vuelo: number | null;
}

export interface EstadoClaves {
  kid_activa: string | null;
  creada_en: string | null;
  dias_activa: number | null;
  rotacion_dias: number;
  /** Fecha en la que la clave activa cumple los 90 días. ISO 8601. */
  vence_en: string | null;
  claves: ClaveEstado[];
}

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
  private readonly logger = new Logger(FirmaService.name);

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
   * **Lo que NO hace** es borrar la clave anterior: queda con `retirada_en` y el
   * JWKS la publica 24 h más. Ese margen es lo que hace reversible la rotación
   * (`reactivar`), y un `DELETE` de la fila lo eliminaría.
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

    this.logger.log(
      `rotacion de clave de firma: activa ${publicaJwk.kid} (la anterior queda en el JWKS 24 h)`,
    );

    return publicaJwk.kid;
  }

  /**
   * Reactiva una clave ya retirada: es el **rollback** de la rotación
   * (`specs/01` §5.1).
   *
   * Pone `activa=1` en esa clave y retira la que estaba activa. Es seguro
   * mientras la clave siga en la tabla —y las claves **no se borran**, así que en
   * la práctica siempre lo está— y por eso el runbook dice "reactivá el `kid`
   * anterior" y no "generá una nueva": una clave nueva en el rollback invalida
   * todos los tokens que la clave anterior había firmado, que es justo lo que se
   * está intentando evitar.
   *
   * **La fila tiene que descifrar con la master key actual**: si se reactivó
   * después de un cambio de master key, firmar va a fallar en el primer token y
   * el error dice exactamente eso (`clavePrivada`).
   *
   * El `where` de la actualización lleva `activa: false` implícito en el
   * `updateMany` de la clave activa, y las dos operaciones van en una
   * transacción: no hay un instante en el que haya dos claves activas o ninguna.
   */
  async reactivar(kid: string): Promise<string> {
    const objetivo = await this.prisma.tok_clave_firma.findUnique({
      where: { kid },
      select: { kid: true, activa: true },
    });

    if (!objetivo) {
      throw new Error(
        `No hay clave de firma con kid=${kid}. Las claves no se borran, asi que un kid ` +
          'inexistente significa que se escribio a mano o que la base no es la de esta instalacion.',
      );
    }

    const ahora = new Date();
    const kidPrevio = await this.rotarActiva(kid, ahora);

    this.logger.log(
      `reactivacion de clave de firma: ${kid} vuelve a ser la activa (se retira ${kidPrevio ?? 'ninguna'})`,
    );

    return kid;
  }

  /**
   * Estado de las claves, para el drill y para la pantalla de operación.
   *
   * `tokens_en_vuelo` es una **estimación por fecha**, y el motivo por el que la
   * estimación es honesta: los access tokens no se persisten (invariante de
   * `AGENTS.md`: ningún token en la base), así que no hay forma de contar cuántos
   * quedaron firmados con una clave retirada. Lo que sí se sabe con certeza es
   * que un token de 15 min firmado con una clave retirada hace más de 15 min ya
   * expiró, y ese es el único número que un operador necesita para decidir si
   * esperar o reiniciar lo que haga falta.
   */
  async estado(vidaAccessMin: number): Promise<EstadoClaves> {
    const ahora = new Date();
    const filas = await this.prisma.tok_clave_firma.findMany({
      select: { kid: true, activa: true, creado_en: true, retirada_en: true },
      orderBy: { creado_en: 'desc' },
    });

    const activa = filas.find((f) => f.activa) ?? null;

    return {
      kid_activa: activa?.kid ?? null,
      creada_en: activa?.creado_en.toISOString() ?? null,
      dias_activa: activa ? Math.floor((ahora.getTime() - activa.creado_en.getTime()) / 86_400_000) : null,
      rotacion_dias: DIAS_ROTACION,
      vence_en: activa ? new Date(activa.creado_en.getTime() + DIAS_ROTACION * 86_400_000).toISOString() : null,
      claves: filas.map((f) => ({
        kid: f.kid,
        activa: f.activa,
        creada_en: f.creado_en.toISOString(),
        retirada_en: f.retirada_en ? f.retirada_en.toISOString() : null,
        en_jwks:
          f.activa ||
          (f.retirada_en !== null && f.retirada_en.getTime() >= ahora.getTime() - VENTANA_JWKS_MS),
        tokens_en_vuelo: f.retirada_en
          ? ahora.getTime() - f.retirada_en.getTime() > vidaAccessMin * MINUTO_MS
            ? 0
            : null
          : null,
      })),
    };
  }

  /**
   * Deja `kid` como la unica activa y devuelve la que estaba activa antes.
   *
   * Privado porque las dos operaciones que lo usan (`activarNueva` y `reactivar`)
   * ya son las que exponen el contrato; dejarlo publico sería una tercera puerta
   * para dejar la tabla con dos claves activas.
   */
  private async rotarActiva(kid: string, ahora: Date): Promise<string | null> {
    const previa = await this.leerActiva();

    await this.prisma.$transaction([
      this.prisma.tok_clave_firma.updateMany({
        where: { activa: true },
        data: { activa: false, retirada_en: ahora },
      }),
      this.prisma.tok_clave_firma.update({
        where: { kid },
        data: { activa: true, retirada_en: null },
      }),
    ]);

    return previa?.kid ?? null;
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
