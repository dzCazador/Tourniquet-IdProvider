import { ArgumentsHost, Catch, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Response } from 'express';

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
 *   - `tenant_invalido` (400): el `:tenant` del path no tiene forma de codigo de
 *     cliente. Se rechaza antes de tocar la base.
 *   - `error` (500): bug. El detalle va al log del proceso.
 */
export type CodigoRegistro = 'sesion_requerida' | 'sin_permiso' | 'tenant_invalido' | 'error';

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
