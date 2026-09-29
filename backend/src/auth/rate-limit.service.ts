import { Injectable, OnModuleDestroy } from '@nestjs/common';

export const LIMITE_POR_MINUTO = 10;
export const VENTANA_MS = 60_000;

/**
 * Techo de claves vivas. Sin esto, un atacante que varye la IP de origen puede
 * inflar el Map hasta comerse la memoria del proceso: cada request crea una
 * entrada y las viejas solo moririan si alguien las recorrera.
 */
const MAX_CLAVES = 50_000;

export interface ResultadoLimite {
  permitido: boolean;
  restantes: number;
  reintentoEnMs: number;
}

interface Ventana {
  cuenta: number;
  reiniciaEn: number;
}

export type AmbitoLimite = 'ip' | 'usuario';

/**
 * Rate limit en memoria, con ventana fija de 1 minuto.
 *
 * DEUDA CONOCIDA: el contador vive en el proceso, asi que se pierde al
 * reiniciar y no se comparte entre instancias. Alcanza para una instancia por
 * instalacion (D3 de `specs/00`). Si alguna vez hay varias, esto pasa a store
 * externo (Redis) y el resto de la app no deberia notar el cambio: por eso la
 * interfaz es `consumar(ambito, clave)` y no un `Map` expuesto.
 *
 * El bloqueo por intentos de `idn_usuario` SI sobrevive al reinicio porque
 * esta en la base: los dos mecanismos no se solapan en lo que cubren.
 */
@Injectable()
export class RateLimitService implements OnModuleDestroy {
  private readonly ventanas = new Map<string, Ventana>();
  private readonly purga: NodeJS.Timeout;

  constructor() {
    this.purga = setInterval(() => this.purgar(), VENTANA_MS);
    // `unref` para que el intervalo no mantenga vivo el proceso en tests/scripts.
    this.purga.unref?.();
  }

  onModuleDestroy(): void {
    clearInterval(this.purga);
  }

  /**
   * Consume un turno del ambito. El que se aplica es el PEOR de los dos
   * (`specs/01` §4): si la IP ya esta agotada se rechaza aunque el usuario
   * tenga turnos, y al reves.
   */
  consumir(ambito: AmbitoLimite, clave: string, limite = LIMITE_POR_MINUTO): ResultadoLimite {
    const ahora = Date.now();
    const id = `${ambito}:${clave}`;
    const vigente = this.ventanas.get(id);

    if (!vigente || vigente.reiniciaEn <= ahora) {
      // Si la ventana nueva nos deja sin margen, limpiamos antes de crecer.
      if (this.ventanas.size >= MAX_CLAVES) {
        this.purgar();
      }
      const reiniciaEn = ahora + VENTANA_MS;
      this.ventanas.set(id, { cuenta: 1, reiniciaEn });
      return { permitido: true, restantes: limite - 1, reintentoEnMs: 0 };
    }

    vigente.cuenta += 1;
    const permitido = vigente.cuenta <= limite;
    return {
      permitido,
      restantes: Math.max(0, limite - vigente.cuenta),
      reintentoEnMs: permitido ? 0 : vigente.reiniciaEn - ahora,
    };
  }

  /** El peor de los dos ambitos manda. */
  consumirVarios(
    reglas: { ambito: AmbitoLimite; clave: string; limite?: number }[],
  ): ResultadoLimite {
    let peor: ResultadoLimite = { permitido: true, restantes: LIMITE_POR_MINUTO, reintentoEnMs: 0 };
    for (const regla of reglas) {
      const actual = this.consumir(regla.ambito, regla.clave, regla.limite);
      if (!actual.permitido && actual.reintentoEnMs > peor.reintentoEnMs) {
        peor = actual;
      }
    }
    return peor;
  }

  private purgar(): void {
    const ahora = Date.now();
    for (const [id, ventana] of this.ventanas) {
      if (ventana.reiniciaEn <= ahora) {
        this.ventanas.delete(id);
      }
    }
  }
}
