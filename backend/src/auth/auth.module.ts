import { Module } from '@nestjs/common';
import { ClavesModule } from '../claves/claves.module';
import { AuditoriaService } from './auditoria.service';
import { IdentidadService } from './identidad.service';
import { MfaDesafioService } from './mfa-desafio.service';
import { MfaService } from './mfa.service';
import { RateLimitService } from './rate-limit.service';

/**
 * Identidad, contraseña, auditoría y **segundo factor** (`specs/01` §8).
 *
 * `MfaService` y `MfaDesafioService` se exportan porque los usan tres módulos que
 * no son éste: `OidcModule` (que declara `AuthController` y necesita el desafío
 * en el login en dos pasos), `RegistroModule` (`/me/mfa`) y `RegistroApiModule`
 * (las tres acciones del panel). Lo que **no** se exporta es `totp.ts`: es una
 * función pura sin dependencias, y la importa quien la necesita
 * (`mfa.service.ts` y `scripts/verificar-mfa.mjs`).
 *
 * `ClavesModule` entra por `MasterKeyService`: el secret del MFA se cifra y se
 * descifra con la misma master key que las claves de firma y las credenciales de
 * las bases (`specs/01` §6). Es la misma primitiva a propósito, y por eso el
 * servicio **no** puede existir sin ese módulo: un `MfaService` sin master key
 * tendría el secret en claro o no tendría nada.
 */
@Module({
  imports: [ClavesModule],
  providers: [
    AuditoriaService,
    RateLimitService,
    IdentidadService,
    MfaService,
    MfaDesafioService,
  ],
  exports: [
    IdentidadService,
    RateLimitService,
    AuditoriaService,
    MfaService,
    MfaDesafioService,
  ],
})
export class AuthModule {}
