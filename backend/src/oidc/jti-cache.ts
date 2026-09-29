import { Injectable, OnModuleDestroy } from '@nestjs/common';

/**
 * Anti-replay de `jti` (`specs/01` §2, §9).
 *
 * Cada token emitido lleva un `jti` aleatorio, y queda anotado aca por el
 * doble de su vida (30 min con access de 15). El TTL es corto a proposito: si
 * un `jti` volviera a aparecer despues de 30 min, el token que lo lleva ya
 * expiro y la verificacion criptografica lo rechaza igual. Guardarlo mas tiempo
 * solo agrega memoria sin agregar seguridad.
 *
 * **Donde NO se usa, y por que.** No se usa para rechazar un segundo acceso con
 * el mismo access token: `/userinfo` es un endpoint de recurso y las apps lo
 * llaman varias veces con el mismo token (cada navegacion, cada pantalla, en
 * paralelo). Si el `jti` se consumiera en la primera llamada, la segunda
 * devolveria 401 y ninguna app podria refreshing su perfil. El modelo bearer no
 * permite distinguir "reuso legitimo" de "atacante con el token robado" en un
 * endpoint de recurso: son la misma request.
 *
 * Lo que si es un reuso detectable y con consecuencias es el canje de una
 * credencial **de un solo uso**: el authorization code y el refresh token. Los
 * dos se tratan con su marca de un solo uso en la base (`usado_en`) y con la
 * revocacion de familia, no con esta cache (trampa 5 de la Fase 03).
 *
 * La cache queda disponible para el validador (`consumir`), que es el codigo que
 * las apps copian: alla el que llama decide si el segundo uso de un token es un
 * incidente o el funcionamiento normal de su app.
 */
@Injectable()
export class JtiCacheService implements OnModuleDestroy {
  /** 2 × la vida del access (15 min). */
  static readonly TTL_MS = 30 * 60 * 1000;

  /** Techo de entradas vivas. Es un Map, no una base: se acota igual. */
  private static readonly MAX_ENTRADAS = 50_000;

  private readonly vistos = new Map<string, number>();
  private readonly purga: NodeJS.Timeout;

  constructor() {
    this.purga = setInterval(() => this.purgar(), JtiCacheService.TTL_MS);
    this.purga.unref?.();
  }

  onModuleDestroy(): void {
    clearInterval(this.purga);
  }

  /** Anota un `jti` y devuelve `false` si ya estaba (o sea: reuso). */
  registrar(jti: string, ahora = Date.now()): boolean {
    if (this.vistos.size >= JtiCacheService.MAX_ENTRADAS) {
      this.purgar();
    }
    if (this.vistos.has(jti)) {
      return false;
    }
    this.vistos.set(jti, ahora + JtiCacheService.TTL_MS);
    return true;
  }

  /** `true` si el `jti` ya fue visto. No anota. */
  contiene(jti: string): boolean {
    return this.vistos.has(jti);
  }

  /**
   * Marca el `jti` como usado y devuelve `true` si era la primera vez.
   *
   * Esto es lo que usa `validador.consumirJti: true`: el que valida decide si
   * la segunda presentacion del mismo token es un incidente.
   */
  consumir(jti: string, ahora = Date.now()): boolean {
    return this.registrar(jti, ahora);
  }

  /** Borra a mano. Para el criterio de aceptacion que mide la purga (~30 min). */
  purgar(ahora = Date.now()): void {
    for (const [jti, vence] of this.vistos) {
      if (vence <= ahora) {
        this.vistos.delete(jti);
      }
    }
  }

  get entradas(): number {
    return this.vistos.size;
  }
}
