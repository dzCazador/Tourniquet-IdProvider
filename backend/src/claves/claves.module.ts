import { Module } from '@nestjs/common';
import { FirmaService } from './firma.service';
import { MasterKeyService } from './master-key.service';

/**
 * Par de claves de firma: generacion, cifrado de la privada y firma/verificacion.
 *
 * Sin controllers: el endpoint publico del JWKS vive en `oidc/jwks.controller.ts`
 * porque la ruta `/.well-known/jwks.json` es de descubrimiento, no de claves.
 * Este modulo expone el servicio a los que necesitan firmar (emision de tokens)
 * o validar (el validador de referencia).
 */
@Module({
  providers: [MasterKeyService, FirmaService],
  exports: [MasterKeyService, FirmaService],
})
export class ClavesModule {}
