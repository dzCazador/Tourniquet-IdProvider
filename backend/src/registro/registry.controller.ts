import { Controller, Get, Logger, Param, Req, UseFilters, UseInterceptors } from '@nestjs/common';
import type { Request } from 'express';
import { PortalService } from '../auth/portal.service';
import { sidDeLaPeticion } from '../oidc/cookies';
import { BdDatosService } from './bd-datos.service';
import { FiltroErroresRegistro, sinPermiso, sinSesion, tenantInvalido } from './errores';
import { SinCacheInterceptor } from './sin-cache.interceptor';

/**
 * Longitud maxima de un `cat_cliente.codigo` (`specs/02` §3, y el mismo limite
 * que usa `LoginDto.cliente`).
 *
 * Es un limite de longitud y no de juego de caracteres a proposito: la
 * comparacion de codigos de cliente es **exacta** en todo el repo (el login no
 * normaliza mayusculas), asi que inventar una regla de charset aca daria un 400
 * a un cliente legitimo cuyo codigo no entre en el patron.
 */
const MAXIMO_CODIGO_CLIENTE = 20;

/**
 * `GET /registry/bases/:tenant`: inventario de las bases de negocio de un
 * cliente, **sin credenciales** (`specs/01` §6, `specs/02` §3).
 *
 * Es el anticipo del export de la Fase 09. Lo que importa de este endpoint no
 * es lo que devuelve sino **quien puede pedirlo**:
 *
 * - El `tenant` del path es un **filtro**, no una autorizacion. La sesion del
 *   portal dice quien pregunta; lo que ese usuario puede ver de *ese* cliente se
 *   decide contra `idn_usuario_cliente` (invariante de `AGENTS.md`: el `tenant`
 *   nunca se deduce de un parametro).
 * - El rol se relee de la base en cada pedido, sin cache. Un permiso cacheado
 *   es un permiso revocado que sigue sirviendo.
 * - Un `admin_identidad` de `cervi` que pide `/registry/bases/otro` recibe 403,
 *   y un `user` de `cervi` tambien. El 403 es el mismo en los tres casos: no
 *   dice si el cliente existe ni que rol tiene el que pregunta.
 * - La respuesta no tiene `usuario` ni `credencial_cifrada`, y eso no es una
 *   decision del controller sino del tipo `BaseInventario`, que no declara esos
 *   campos. Un endpoint que los devolviera no tendria nada que compilar.
 */
@Controller('registry')
@UseFilters(FiltroErroresRegistro)
@UseInterceptors(SinCacheInterceptor)
export class RegistryController {
  private readonly logger = new Logger(RegistryController.name);

  constructor(
    private readonly portal: PortalService,
    private readonly bd: BdDatosService,
  ) {}

  @Get('bases/:tenant')
  async bases(@Req() req: Request, @Param('tenant') tenant: string): Promise<object> {
    if (typeof tenant !== 'string' || tenant.length === 0 || tenant.length > MAXIMO_CODIGO_CLIENTE) {
      tenantInvalido();
    }

    const ctx = await this.portal.contextoDe(sidDeLaPeticion(req));
    if (!ctx) {
      sinSesion();
    }

    // Aca esta la autorizacion. El `:tenant` del path ya se uso como filtro de
    // la consulta; lo que decide si se responde es que ESE usuario sea
    // `admin_identidad` de ESE cliente. Un admin de otro tenant no pasa.
    if (!(await this.bd.esAdminDeCliente(ctx.usuario.idusuario, tenant))) {
      sinPermiso();
    }

    const bases = await this.bd.inventario(tenant);

    this.logger.log(
      `inventario de bases leido cliente=${tenant} ` +
        `solicitante=${ctx.usuario.usuario} filas=${bases.length}`,
    );

    return { idcliente: tenant, total: bases.length, bases };
  }
}
