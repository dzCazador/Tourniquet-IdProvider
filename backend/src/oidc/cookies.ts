import { Request, Response } from 'express';
import { COOKIE_SESION_MAX_AGE_SEG, COOKIE_SESION_PORTAL } from './vidas';

/**
 * Lectura y borrado de la cookie de sesion del portal.
 *
 * Va a mano y no con `cookie-parser` por una sola cookie: la dependencia es un
 * parser general con politicas propias, y lo que hace falta aca es leer **un**
 * valor que el propio IdP escribio (un UUID), sin tener que lidiar con cookies
 * duplicadas ni con limites de tamano. Si alguna vez hay que leer cookies de
 * terceros, ahi si conviene la libreria.
 */
export function leerCookie(cabecera: string | undefined, nombre: string): string | null {
  if (!cabecera) {
    return null;
  }

  for (const parte of cabecera.split(';')) {
    const separador = parte.indexOf('=');
    if (separador < 0) {
      continue;
    }
    if (parte.slice(0, separador).trim() !== nombre) {
      continue;
    }
    const valor = parte.slice(separador + 1).trim();
    try {
      return decodeURIComponent(valor);
    } catch {
      // Un valor con percent-rompido no es nuestro: se trata como ausente en
      // vez de romper el pedido.
      return null;
    }
  }

  return null;
}

/** El `sid` de la sesion del portal, o `null`. */
export function sidDeLaPeticion(req: Request): string | null {
  return leerCookie(req.headers.cookie, COOKIE_SESION_PORTAL);
}

/**
 * `Set-Cookie` que borra la cookie de sesion.
 *
 * Los atributos tienen que **coincidir** con los de la que se escribio (mismo
 * `Path`, mismo `SameSite`): si difieren, el navegador guarda la nueva cookie
 * como una distinta y la vieja sigue mandandose.
 */
export function borrarCookieDeSesion(req: Request, res: Response): void {
  const seguro = (req.protocol === 'https' || req.get('x-forwarded-proto') === 'https') ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_SESION_PORTAL}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${seguro}`,
  );
}

/** `Set-Cookie` que escribe la cookie de sesion del portal (`specs/01` §4). */
export function escribirCookieDeSesion(req: Request, res: Response, sid: string): void {
  const seguro = (req.protocol === 'https' || req.get('x-forwarded-proto') === 'https') ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_SESION_PORTAL}=${encodeURIComponent(sid)}; Path=/; ` +
      `Max-Age=${COOKIE_SESION_MAX_AGE_SEG}; HttpOnly; SameSite=Lax${seguro}`,
  );
}
