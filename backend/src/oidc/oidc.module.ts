import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuthController } from '../auth/auth.controller';
import { PortalService } from '../auth/portal.service';
import { ClavesModule } from '../claves/claves.module';
import { FirmaService, JwkFirma } from '../claves/firma.service';
import { OperacionController } from '../claves/operacion.controller';
import { OperadorGuard } from '../claves/operacion.guard';
import { AplicacionService } from './aplicacion.service';
import { AuthorizeController } from './authorize.controller';
import { AuthorizeService } from './authorize.service';
import { ClaimsService } from './claims';
import { DiscoveryController } from './discovery.controller';
import { JwksCacheService, CARGAR_JWKS } from './jwks-cache';
import { JwksController } from './jwks.controller';
import { JtiCacheService } from './jti-cache';
import { LogoutController } from './logout.controller';
import { RevokeController } from './revoke.controller';
import { SesionService } from './sesion.service';
import { TokenController } from './token.controller';
import { TokenService } from './token.service';
import { UserinfoController } from './userinfo.controller';
import { ValidadorService } from './validador.service';

/**
 * TTL del memo de JWKS **dentro del IdP**.
 *
 * El lado app cachea 24 h (`specs/01` §5) porque no tiene otra fuente. El
 * IdP si: tiene la tabla. Acá el TTL es corto a proposito, para que una
 * rotacion de clave se aplique en minutos y no en un dia: un administrador que
 * rota por compromise y sigue firmando con la clavecomprometida 24 h mas no
 * rotó nada.
 */
const TTL_JWKS_INTERNO_MS = 60 * 1000;

/**
 * Nucleo OIDC (`specs/01` §1): discovery, JWKS, authorize, token, revoke, logout
 * y userinfo.
 *
 * Los controladores son finitos: uno por endpoint, que es como la spec los
 * describe y como se los prueba por `curl`. Los services van por
 * responsabilidad (sesiones, claims, registro de apps, validacion), no por
 * endpoint, para que el canje, la revocacion y el logout compartan exactamente
 * las mismas reglas de cierre de sesion.
 *
 * `AuthController` y `OperacionController` son las dos excepciones, y por el
 * mismo motivo concreto: los dos necesitan services que son provider de **este**
 * módulo y no del suyo (`AuthController` → `SesionService` de acá;
 * `OperacionController` → `PortalService` de acá, vía su guard). Declararlos en
 * su propio módulo crearía `AuthModule <-> OidcModule` y
 * `ClavesModule <-> OidcModule` circulares. Los archivos viven en `auth/` y
 * `claves/`; ver el comentario de cada controlador.
 */
@Module({
  imports: [ClavesModule, AuthModule],
  controllers: [
    DiscoveryController,
    JwksController,
    AuthorizeController,
    TokenController,
    RevokeController,
    LogoutController,
    UserinfoController,
    AuthController,
    // `/operacion/claves`: la rotacion de las claves de firma, que es de la
    // INSTALACION y no de un tenant (`specs/01` §5.1). Se declara desde aca, y no
    // en `ClavesModule`, por la misma razon que `AuthController`: su guard
    // necesita `PortalService`, que es provider de este modulo, y meterlo en
    // `ClavesModule` crearia la dependencia circular `ClavesModule <-> OidcModule`.
    OperacionController,
  ],
  providers: [
    AplicacionService,
    SesionService,
    OperadorGuard,
    PortalService,
    ClaimsService,
    JtiCacheService,
    JwksCacheService,
    ValidadorService,
    AuthorizeService,
    TokenService,
    {
      // La fuente del JWKS del lado IdP es la tabla de claves, no el endpoint
      // publico: el IdP no se llama a si mismo por HTTP para validar su propio
      // token. El script de verificacion (y RHPro en la Fase 06) inyectan la
      // fuente por HTTP, que es lo que hace cualquier app.
      provide: CARGAR_JWKS,
      useFactory: (firma: FirmaService) => () => firma.jwks(),
      inject: [FirmaService],
    },
    {
      provide: JwksCacheService,
      useFactory: (cargar: () => Promise<{ keys: JwkFirma[] }>) =>
        new JwksCacheService(cargar, TTL_JWKS_INTERNO_MS),
      inject: [CARGAR_JWKS],
    },
  ],
  exports: [
    SesionService,
    ValidadorService,
    JtiCacheService,
    JwksCacheService,
    AplicacionService,
    // `PortalService` se exporta para los endpoints de lectura del portal y del
    // registro (`registro/`, Fase 05): son los que necesitan resolver la sesion
    // a `idusuario` + `idcliente` + rol. Vive aci porque depende de
    // `SesionService`, que es provider de este modulo.
    PortalService,
  ],
})
export class OidcModule {}
