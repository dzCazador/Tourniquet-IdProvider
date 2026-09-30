import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Response } from 'express';

/**
 * `Cache-Control: no-store` en TODAS las respuestas de estos endpoints,
 * incluidas las exitosas.
 *
 * Va como interceptor y no como filtro a proposito: un `@Catch()` de Nest solo
 * se ejecuta cuando hay excepcion, asi que un filtro que pusiera la cabecera
 * dejaba los 200 -- que son la respuesta normal -- sin `no-store`. Y eso es
 * justo el caso que importa: un `GET /me` cacheado por un proxy deja al
 * navegador "logueado" sin cookie, y un `GET /registry/bases/:tenant` cacheado
 * es el inventario de un cliente servido a cualquiera que pase por ahi.
 *
 * Los 200 de estos endpoints ademas no se pueden cachear ni un segundo: el
 * `tenant` y las apps habilitadas cambian cuando un `admin_identidad` da de alta
 * o de baja a alguien, y esa decision tiene que verse en la proxima request.
 */
@Injectable()
export class SinCacheInterceptor implements NestInterceptor {
  intercept(contexto: ExecutionContext, siguiente: CallHandler) {
    const res = contexto.switchToHttp().getResponse<Response>();
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    return siguiente.handle();
  }
}
