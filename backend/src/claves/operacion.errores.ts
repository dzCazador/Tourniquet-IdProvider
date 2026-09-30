import { ArgumentsHost, Catch, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Response } from 'express';

/**
 * Contrato de error de `/operacion/*`.
 *
 * Son los **mismos tres códigos** que usa `registro/errores.ts` y por el mismo
 * motivo: `sesion_requerida` (401) no distingue por qué no hay sesión, y
 * `sin_permiso` (403) no dice si el operador existe en la lista o si el
 * endpoint existe. Los **códigos**, nunca mensajes para mostrar —el front decide
 * el texto— y el detalle técnico va al log del proceso.
 *
 * El filtro va declarado **antes** del controlador, como en `auth.controller.ts`:
 * si se declarara después, el decorador `@UseFilters` se evaluaría con la clase
 * todavía en su zona temporal muerta y el arranque fallaría con un
 * `ReferenceError` que no señala el archivo.
 *
 * No es un `APP_FILTER` global por la misma razón que los otros dos filtros
 *propio del repo: cada superficie de error habla un idioma distinto (el portal usa
 * `{ codigo, mensaje }`, el nucleo OIDC usa `{ error, error_description }` de
 * RFC 6749) y un filtro global aplicaria el ultimo que se declare a todos.
 */
@Catch()
export class FiltroErroresOperacion {
  private readonly logger = new Logger(FiltroErroresOperacion.name);

  catch(excepcion: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');

    if (excepcion instanceof HttpException) {
      res.status(excepcion.getStatus()).json(excepcion.getResponse());
      return;
    }

    this.logger.error(
      `Error no controlado en /operacion: ` +
        `${excepcion instanceof Error ? excepcion.message : 'error desconocido'}`,
    );
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ codigo: 'error' });
  }
}
