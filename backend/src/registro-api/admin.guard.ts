import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { PortalService, type ContextoSesionPortal } from '../auth/portal.service';
import { sinPermiso, sinSesion } from '../registro/errores';
import { sidDeLaPeticion, type RequestConAdmin, type SesionAdmin } from './admin.types';

/**
 * `AdminGuard`: la unica puerta de `/admin/*`, y tiene una sola regla.
 *
 * 1. Hay sesion de portal (`tok_sesion_portal`) y el usuario es
 *    `admin_identidad` **de algun cliente**, y ese cliente esta `activo`.
 * 2. El `idcliente` con el que se opera tiene que ser **uno de esos clientes**. Si
 *    no esta en la lista, 403.
 *
 * Lo que el guard **no** hace, y es la parte importante: no decide el alcance de
 * una escritura. Devuelve el `idcliente` que se va a usar, y ese valor viaja en el
 * `request` para que **todos** los servicios lo usen en el `where` de Prisma. Un
 * guard que solo autoriza y un servicio que decide el tenant por su cuenta es un
 * panel con dos fuentes de verdad de "de que cliente es esto", y la segunda es la
 * que nadie revisa (`AGENTS.md`, invariante de tenant).
 *
 * **El `?cliente=` de la URL no cambia el alcance.** Si el pedido trae un cliente,
 * se compara contra la lista de clientes donde el usuario es admin: si no esta, 403.
 * Es lo que hace que el panel de `cervi` no pueda convertirse en el panel de
 * `jugos` con un parametro.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly portal: PortalService) {}

  async canActivate(contexto: ExecutionContext): Promise<boolean> {
    const req = contexto.switchToHttp().getRequest<Request>();
    const ctx = await this.portal.contextoDe(sidDeLaPeticion(req));
    if (!ctx) {
      sinSesion();
    }

    // `membresias` solo trae clientes **activos** (`contextoDe` los filtra), asi que
    // la lista de abajo ya es la lista de clientes administrables.
    const administrables = ctx.membresias.filter((m) => m.rol === 'admin_identidad');
    if (administrables.length === 0) {
      sinPermiso();
    }

    const pedido = req.query?.cliente;
    const idcliente = typeof pedido === 'string' && pedido.length > 0 ? pedido : null;

    // Sin `?cliente=`, se opera sobre el **cliente de la sesion**, que es el que el
    // usuario eligio en el portal. Si no es admin de ese cliente, 403: la respuesta
    // correcta no es "administrá el primero que encuentres", es "cambiá de cliente
    // en el portal" (que ademas re-emite la sesion, ver `PortalService.cambiarCliente`).
    // Tomar el primer `admin_identidad` de la lista seria operar sobre un cliente que
    // el usuario no eligio, y escribir en el tenant equivocado sin que nadie lo pida.
    if (idcliente === null) {
      const propio = ctx.cliente.idcliente;
      if (!administrables.some((m) => m.idcliente === propio)) {
        sinPermiso();
      }
      (req as RequestConAdmin).admin = { ...contextoComoSesion(ctx), idcliente: propio };
      return true;
    }

    if (!administrables.some((m) => m.idcliente === idcliente)) {
      sinPermiso();
    }

    (req as RequestConAdmin).admin = { ...contextoComoSesion(ctx), idcliente };
    return true;
  }
}

/**
 * Se separa de `ContextoSesionPortal` a proposito: el panel no necesita las
 * membresias ni el `expira_en`, y copiar el contexto entero a la request es
 * copiar datos que ningun servicio del panel va a leer.
 */
function contextoComoSesion(ctx: ContextoSesionPortal): Omit<SesionAdmin, 'idcliente'> {
  return {
    idusuario: ctx.usuario.idusuario,
    usuario: ctx.usuario.usuario,
    nombre: `${ctx.usuario.nombre} ${ctx.usuario.apellido}`.trim(),
    rol: 'admin_identidad',
  };
}
