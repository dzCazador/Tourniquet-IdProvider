import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { cifrar, decodificarMasterKey, descifrar } from './crypto';

/**
 * Lee `TQ_MASTER_KEY` UNA vez y la mantiene en memoria.
 *
 * La clave no se loguea, no se expone por ningun endpoint, no va en el
 * `health` y no se escribe en ningun archivo. `valorB64` existe para que los
 * scripts y los servicios reusen exactamente la misma primitiva; no la
 * expongas por HTTP.
 *
 * El valor viene por `ConfigService` (inyectado), no por `process.env`: el
 * esquema de `config/env.schema.ts` ya lo validó al arrancar, así que acá
 * `getOrThrow` no puede fallar y no hace falta repetir la comprobación. El
 * `decodificarMasterKey` que queda es una red de seguridad para el caso de que
 * alguien construya este service a mano en un script.
 */
@Injectable()
export class MasterKeyService {
  private readonly masterKeyB64: string;

  constructor(config: ConfigService) {
    this.masterKeyB64 = config.getOrThrow<string>('TQ_MASTER_KEY');
    decodificarMasterKey(this.masterKeyB64);
  }

  get valorB64(): string {
    return this.masterKeyB64;
  }

  cifrar(texto: string): Buffer {
    return cifrar(texto, this.masterKeyB64);
  }

  descifrar(buf: Buffer): string {
    return descifrar(buf, this.masterKeyB64);
  }
}
