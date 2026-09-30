import { ArgumentsHost, Catch, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { ErrorPortal } from '../auth/portal.service';

/**
 * Contrato de error de los endpoints de lectura del portal y del registro
 * (`/me`, `/me/apps`, `/registry/bases/:tenant`).
 *
 * Mismo criterio que el resto del repo: el backend manda **codigos**, no
 * mensajes para mostrar, y el front decide el texto. Los codigos son cortos a
 * proposito -- dicen QUE paso, nunca el valor de nada que venga del cliente.
 *
 *   - `sesion_requerida` (401): no hay cookie, la sesion no existe, esta cerrada
 *     o vencio. **No distingue los casos**, igual que `GET /auth/session`: para
 *     el navegador son lo mismo, y separarlos permitiria enumerar `sid`.
 *   - `sin_permiso` (403): hay sesion, pero no alcanza. No dice si el cliente
 *     existe, ni que rol tiene, ni si es el cliente equivocado: el 403 es la
 *     misma respuesta para "no sos admin", "no sos miembro" y "ese cliente no
 *     existe".
 *   - `no_encontrado` (404): el recurso pedido no existe **o no es de este
 *     usuario**. Las dos cosas son la misma respuesta, y por eso existe: un 403
 *     sobre un `sid` ajeno confirma que ese `sid` existe, y con eso el endpoint
 *     `/me/sesiones/:sid` se convierte en un oraculo de sesiones de todo el IdP.
 *   - `tenant_invalido` (400): el `:tenant` del path no tiene forma de codigo de
 *     cliente. Se rechaza antes de tocar la base.
 *   - `error` (500): bug. El detalle va al log del proceso.
 */
export type CodigoRegistro =
  | 'sesion_requerida'
  | 'sin_permiso'
  | 'no_encontrado'
  | 'peticion_invalida'
  | `peticion_invalida:${string}`
  | 'conflicto'
  | `conflicto:${string}`
  | 'tenant_invalido'
  | 'error';

function lanzar(codigo: CodigoRegistro, status: number): never {
  throw new HttpException({ codigo }, status);
}

/** 401. Sin sesion, o con una sesion que ya no cuenta. */
export function sinSesion(): never {
  return lanzar('sesion_requerida', HttpStatus.UNAUTHORIZED);
}

/** 403. La sesion es valida pero no habilita esto. */
export function sinPermiso(): never {
  return lanzar('sin_permiso', HttpStatus.FORBIDDEN);
}

/** 400. El `:tenant` del path no puede ser un `cat_cliente.codigo`. */
export function tenantInvalido(): never {
  return lanzar('tenant_invalido', HttpStatus.BAD_REQUEST);
}

/** 404. No existe, o no es del usuario que pregunta. Las dos son lo mismo. */
export function noEncontrado(): never {
  return lanzar('no_encontrado', HttpStatus.NOT_FOUND);
}

/**
 * 400. El cuerpo o el query no cumple el contrato del endpoint.
 *
 * Para lo que el `ValidationPipe` **no** puede ver: no es lo mismo que un DTO mal
 * formado (que sale con el cuerpo del `HttpException` del pipe). Esto es para las
 * reglas que dependen del estado —"esa clave ya la tiene otro usuario", "ese motivo
 * de cierre no existe"— y que el front traduce con un texto propio.
 */
export function peticionInvalida(detalle?: string): never {
  return lanzar(
    detalle ? `peticion_invalida:${detalle}` : 'peticion_invalida',
    HttpStatus.BAD_REQUEST,
  );
}

/** 409. La operacion es coherente pero choca con el estado actual. */
export function conflicto(detalle?: string): never {
  return lanzar(detalle ? `conflicto:${detalle}` : 'conflicto', HttpStatus.CONFLICT);
}

/**
 * Filtro de estos endpoints.
 *
 * El `no-store` de las respuestas **exitosas** lo pone `SinCacheInterceptor`, no
 * este filtro: un `@Catch()` de Nest solo se ve cuando hay excepcion, asi que
 * aca solo quedan los 4xx y el 500.
 *
 * Vive aca y no como `APP_FILTER` global porque el nucleo OIDC ya tiene el suyo
 * (`oidc/errores.ts`, con la forma `{ error, error_description }` de RFC 6749) y
 * el login del portal el otro (`auth.controller.ts`, con `{ codigo, mensaje }`).
 * Un filtro global aplicaria el ultimo que se declare a los tres.
 */
@Catch()
export class FiltroErroresRegistro {
  private readonly logger = new Logger(FiltroErroresRegistro.name);

  catch(excepcion: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');

    // `ErrorPortal` es el contrato de `{ codigo, mensaje }` del portal (login,
    // logout, cambio de cliente), y se responde tal cual. Sin esta rama, un
    // `cliente_no_pertenece` de `/me/cliente-activo` caia en la de abajo y salia un
    // **500**: el usuario veria "error del sistema" cuando en realidad eligio un
    // cliente del que no es miembro, que es una situacion suya y conocida. Los
    // codigos de `ErrorPortal` son los mismos que ya conoce el portal
    // (`CodigoPortal` en `frontend/src/lib/api.ts`), asi que el front no aprende
    // nada nuevo.
    if (excepcion instanceof ErrorPortal) {
      res.status(excepcion.status).json({ codigo: excepcion.codigo, ...excepcion.cuerpo });
      return;
    }

    if (excepcion instanceof HttpException) {      res.status(excepcion.getStatus()).json(excepcion.getResponse());
      return;
    }

    this.logger.error(
      `Error no controlado en /me o /registry: ` +
        `${excepcion instanceof Error ? excepcion.message : 'error desconocido'}`,
    );
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ codigo: 'error' });
  }
}
