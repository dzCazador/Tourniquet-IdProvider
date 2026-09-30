import type { Request } from 'express';
import { sidDeLaPeticion } from '../oidc/cookies';

/**
 * Tipos compartidos del panel `admin_identidad` y el unico lugar donde se lee la
 * cookie de sesion para el panel.
 *
 * Vive en su propio archivo y no en el guard porque lo usan el guard, los tres
 * servicios y los controladores: si el contexto viviera en el guard, importarlo
 * desde un servicio seria una dependencia en la direccion contraria a la del
 * modulo, y el "de que cliente estoy operando" se moveria al archivo que decide
 * quien entra.
 */
export interface SesionAdmin {
  /** Cliente sobre el que se opera. Sale del guard, nunca del body. */
  idcliente: string;
  /** Quien administra. Es el `idusuario` que va en `aud_login` (`specs/01` §7). */
  idusuario: string;
  usuario: string;
  nombre: string;
  rol: 'admin_identidad';
}

/** El `request` con el contexto del admin colgado por el guard. */
export type RequestConAdmin = Request & { admin: SesionAdmin };

/** Lee el contexto que dejo el guard, o 500 si no paso (un `if` de desarrollo). */
export function adminDe(req: Request): SesionAdmin {
  const ctx = (req as RequestConAdmin).admin;
  if (!ctx) {
    // Si se llega aca, un endpoint quedo sin `@UseGuards(AdminGuard)`. Es un bug de
    // cableado, no una condicion de negocio, y por eso el mensaje lo dice: un
    // 403 en este punto taparia el problema real.
    throw new Error(
      'adminDe() sin AdminGuard: el endpoint tiene que declarar @UseGuards(AdminGuard).',
    );
  }
  return ctx;
}

export { sidDeLaPeticion };
