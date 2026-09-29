import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { Response } from 'express';

/**
 * Errores del endpoint, en los codigos cerrados de RFC 6749 §4.1.2.1 y §5.2.
 *
 * La respuesta al cliente es SIEMPRE `{ error, error_description? }` y la
 * `error_description` es generica a proposito. El motivo real (code vencido,
 * code ya usado, verifier incorrecto, redirect distinto) va al `detalle` de
 * `aud_login`, que es donde se consulta para diagnosticar: separar "el cliente
 * esta mal programado" de "alguien esta robando codes" es una decision de
 * diagnostico, y el cliente no tiene por que saberla.
 */
export type CodigoErrorOauth =
  | 'invalid_request'
  | 'unauthorized_client'
  | 'access_denied'
  | 'unsupported_response_type'
  | 'unsupported_grant_type'
  | 'invalid_scope'
  | 'invalid_grant'
  | 'invalid_client'
  | 'temporarily_unavailable'
  | 'server_error'
  | 'login_required'
  | 'portal_no_configurado'
  | 'sesion_no_valida'
  | 'usuario_no_habilitado';

const DESCRIPCIONES: Record<CodigoErrorOauth, string> = {
  invalid_request: 'Falta un parametro obligatorio o el pedido esta mal formado.',
  unauthorized_client: 'La aplicacion no puede usar este flujo.',
  access_denied: 'El usuario no esta habilitado para esta aplicacion.',
  unsupported_response_type: 'Solo se admite response_type=code.',
  unsupported_grant_type: 'Solo se admiten authorization_code y refresh_token.',
  invalid_scope: 'El scope pedido no esta soportado.',
  invalid_grant: 'La credencial presentada no es valida, vencio o ya se uso.',
  invalid_client: 'La aplicacion no es valida.',
  temporarily_unavailable: 'Demasiados intentos. Reintente en un momento.',
  server_error: 'Error interno del servidor de identidad.',
  login_required: 'Hay que iniciar sesion en el portal.',
  portal_no_configurado: 'El portal no esta configurado (TQ_PORTAL_URL vacio).',
  sesion_no_valida: 'La sesion no existe, esta cerrada o vencio.',
  usuario_no_habilitado: 'El usuario no esta habilitado para esta aplicacion.',
};

export function cuerpoError(codigo: CodigoErrorOauth): {
  error: CodigoErrorOauth;
  error_description: string;
} {
  return { error: codigo, error_description: DESCRIPCIONES[codigo] };
}

/**
 * Error con codigo OAuth. Lo lanzan los services; `FiltroErroresOidc` lo
 * traduce a la respuesta HTTP, para que el mismo error se vea igual saliendo de
 * authorize o de token.
 *
 * `redirigir` es lo que separa un error de authorize que se puede devolver por
 * `redirect_uri` (el URI ya quedo validado, redirigir es seguro) de uno que NO
 * (redirect invalido, app desconocida): esos se responden en el request, sin
 * redireccion, porque mandar el error a un URI no validado seria un redirect
 * abierto.
 */
export class ErrorOidc extends HttpException {
  constructor(
    readonly codigo: CodigoErrorOauth,
    readonly redirigir: { uri: string; state?: string } | null = null,
    status = HttpStatus.BAD_REQUEST,
  ) {
    super(cuerpoError(codigo), status);
  }
}

/**
 * Filtro de los endpoints OIDC. Vive en el modulo de OIDC y no como
 * `APP_FILTER` global: el login del portal (Fase 04) responde con su propio
 * formato `{ codigo, mensaje }` y no tiene por que hablar OAuth.
 *
 * `Cache-Control: no-store` en todo: las respuestas de authorize, token, revoke
 * y logout llevan `code` o tokens. Un cache intermedio que las guarde es un
 * authorization code guardado en un proxy.
 */
@Catch()
export class FiltroErroresOidc implements ExceptionFilter {
  catch(excepcion: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');

    if (excepcion instanceof HttpException) {
      const estado = excepcion.getStatus();
      const cuerpo = excepcion.getResponse();
      res.status(estado).json(cuerpo);
      return;
    }

    // Un error que no es `HttpException` es un bug. Se responde con la forma
    // OAuth y se deja el detalle para el log del proceso: al cliente no se le
    // manda la excepcion.
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json(cuerpoError('server_error'));
  }
}
