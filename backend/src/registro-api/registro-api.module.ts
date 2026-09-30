import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OidcModule } from '../oidc/oidc.module';
import { AdminAuditoriaService } from './admin.auditoria.service';
import { AdminController } from './admin.controller';
import { AdminGuard } from './admin.guard';
import { AdminSesionesService } from './admin.sesiones.service';
import { AdminUsuariosService } from './admin.usuarios.service';

/**
 * `registro-api`: la escritura del registro de identidades — el panel
 * `admin_identidad` de la Fase 08.
 *
 * **Por qué un módulo propio y no más endpoints en `registro/`:** `registro/` es de
 * lectura y habla con el usuario (el lanzador, `/me`, el inventario de bases), y este
 * módulo es de escritura y habla con el **admin de un cliente**. La diferencia no es
 * de cantidad de endpoints sino de dirección: acá todo lo que entra es una decisión
 * que alguien tomó sobre otras personas, y por eso los tres servicios llevan el
 * filtro de tenant en el `where` y toda escritura deja fila en `aud_login` con el
 * `sub` real del admin (`specs/01` §7).
 *
 * Lo que **no** existe acá y no debe agregarse (D2 de `specs/00`): permisos de
 * negocio, perfiles, roles finos, cualquier columna que decida qué ve un usuario
 * adentro de una app. Eso vive en la base de cada app, y el IdP solo decide quién
 * entra.
 *
 * Importa `OidcModule` por `PortalService` (el guard resuelve la sesion) y
 * `AuthModule` por `AuditoriaService` (toda escritura se audita). `PrismaModule` es
 * global y `SesionService` viene exportado de `OidcModule`, asi que no hace falta
 * declarar ninguno de los dos.
 */
@Module({
  imports: [OidcModule, AuthModule],
  controllers: [AdminController],
  providers: [AdminGuard, AdminUsuariosService, AdminSesionesService, AdminAuditoriaService],
})
export class RegistroApiModule {}
