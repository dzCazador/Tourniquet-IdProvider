import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ClavesModule } from '../claves/claves.module';
import { OidcModule } from '../oidc/oidc.module';
import { BdDatosService } from './bd-datos.service';
import { MeController } from './me.controller';
import { RegistryController } from './registry.controller';

/**
 * Endpoints de lectura del portal (`/me`, `/me/apps`, `/me/clientes`,
 * `/me/sesiones`) y del inventario de bases (`/registry/bases/:tenant`). Fase 05, con
 * el lanzador de la Fase 07 encima.
 *
 * **Por que vive en `registro/` y no repartido en `auth/` y `cat_base_datos/`:**
 * los endpoints comparten el mismo contexto de sesion (`PortalService`) y la misma
 * regla de que el `tenant` sale de la sesion y no del pedido. Lo que se lee es
 * *registro*: quien es el usuario, a que apps entra y que bases tiene el cliente.
 * La escritura de ese registro (alta de usuario, credencial de base) no es de aca:
 * va por script o por el panel `admin_identidad` (`registro-api/`, Fase 08), con la
 * misma primitiva de cifrado.
 *
 * Importa `OidcModule` por `PortalService` y `SesionService` (que viven ahi desde la
 * Fase 03), `AuthModule` por `AuditoriaService` —el cierre de una sesion propia y
 * el cambio de cliente se auditan— y `ClavesModule` por `MasterKeyService`, que es la
 * unica forma de que `credencial_cifrada` se escriba. No declara `PrismaService`:
 * `PrismaModule` es global, y repetir el provider abriria un pool por modulo.
 */
@Module({
  imports: [OidcModule, AuthModule, ClavesModule],
  controllers: [MeController, RegistryController],
  providers: [BdDatosService],
  exports: [BdDatosService],
})
export class RegistroModule {}
