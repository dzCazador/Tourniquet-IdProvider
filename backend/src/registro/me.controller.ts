import { Controller, Get, Req, UseFilters, UseInterceptors } from '@nestjs/common';
import type { Request } from 'express';
import { PortalService, type ContextoSesionPortal } from '../auth/portal.service';
import { sidDeLaPeticion } from '../oidc/cookies';
import { PrismaService } from '../prisma/prisma.service';
import { FiltroErroresRegistro, sinSesion } from './errores';
import { SinCacheInterceptor } from './sin-cache.interceptor';

/**
 * `GET /me` y `GET /me/apps`: lo que el portal necesita para pintar al usuario
 * y el lanzador.
 *
 * Los dos leen la **misma** sesion del portal (`tok_sesion_portal`) y por eso
 * comparten `contextoDe`: el `tenant` que Contestan es el `idcliente` de esa
 * fila de `tok_sesion`, decidido en el login. Nunca un parametro, un header o
 * una cookie del cliente (invariante de `AGENTS.md`).
 *
 * `GET /me` es super-set de `GET /auth/session` (Fase 04) y agrega lo que el
 * lanzador necesita: el rol del usuario en el cliente actual y la lista de sus
 * membresias. Los dos conviven porque el login y el logout del portal usan el
 * chico y no necesitan el resto.
 */
@Controller('me')
@UseFilters(FiltroErroresRegistro)
@UseInterceptors(SinCacheInterceptor)
export class MeController {
  constructor(
    private readonly portal: PortalService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Quien esta logueado: usuario, cliente activo y rol.
   *
   * `clientes` son **todas** sus membresias activas, no solo el cliente de la
   * sesion. No es una via para ver clientes ajenos (la consulta sale del filtro
   * de membresias del propio usuario), es lo que le permite al portal ofrecer
   * cambiar de cliente, y es el mismo dato que ya viaja en el 400
   * `cliente_ambiguo` del login.
   *
   * `rol` puede ser `null`: la sesion sigue viva pero al cliente de la sesion
   * le sacaron la membresia despues del login. Es un estado real y no se
   * disimula inventando un rol.
   */
  @Get()
  async yo(@Req() req: Request): Promise<object> {
    const ctx = await this.contextoDe(req);

    return {
      usuario: ctx.usuario.usuario,
      nombre: `${ctx.usuario.nombre} ${ctx.usuario.apellido}`.trim(),
      email: ctx.usuario.email,
      clienteActual: { ...ctx.cliente, rol: ctx.rol },
      clientes: ctx.membresias,
      expira_en: ctx.sesion.expira_en.toISOString(),
    };
  }

  /**
   * Apps a las que el usuario puede entrar **en el cliente de su sesion**.
   *
   * La lista sale de la interseccion de tres filtros, y cada uno quita algo
   * distinto:
   *
   *   - `idn_usuario_cliente_aplicacion`: que el usuario este **habilitado**
   *     (la fila que el authorize exige). Sin ella la lista es vacia, no un
   *     error: es el estado de un `user` sin apps, que es real.
   *   - `cat_cliente_aplicacion`: que la app exista **para ese cliente**. Sin
   *     este filtro, un miembro de `cervi` veria en su lanzador apps que solo
   *     existen para otro cliente, y el authorize las rechazaria con
   *     `access_denied` despues de que el usuario eligiera.
   *   - `cat_aplicacion.estado = 'activo'`: una app dada de baja no se ofrece.
   *
   * Los tres van **dentro** del filtro de la sesion, no despues: por eso un
   * usuario de otro cliente no aparece nunca, ni por error de paginado ni por
   * una app compartida entre clientes.
   */
  @Get('apps')
  async apps(@Req() req: Request): Promise<object> {
    const ctx = await this.contextoDe(req);
    const idcliente = ctx.cliente.idcliente;

    const apps = await this.prisma.cat_aplicacion.findMany({
      where: {
        estado: 'activo',
        clientes: { some: { idcliente, cliente: { estado: 'activo' } } },
        membresias: { some: { idusuario: ctx.usuario.idusuario, idcliente } },
      },
      select: { codigo: true, nombre: true, estado: true },
      orderBy: { codigo: 'asc' },
    });

    return { idcliente, total: apps.length, apps };
  }

  /**
   * Sesion viva o 401. Unico lugar donde estos endpoints deciden que no hay
   * sesion, para que los dos se comporten igual.
   */
  private async contextoDe(req: Request): Promise<ContextoSesionPortal> {
    const ctx = await this.portal.contextoDe(sidDeLaPeticion(req));
    if (!ctx) {
      sinSesion();
    }
    return ctx;
  }
}
