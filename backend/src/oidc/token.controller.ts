import { Body, Controller, HttpCode, Ip, Post, Req, UseFilters } from '@nestjs/common';
import type { Request } from 'express';
import { ErrorOidc, FiltroErroresOidc } from './errores';
import { CuerpoToken, GRANT_CODE, GRANT_REFRESH, TokenService } from './token.service';

/**
 * `POST /oidc/token`.
 *
 * El cuerpo se valida a mano, y no con un DTO de `class-validator`, por dos
 * razones concretas de OAuth:
 *
 *   - RFC 6749 §3.2 dice que el servidor **debe ignorar** los parametros que no
 *     reconoce. Con el `ValidationPipe` global en `forbidNonWhitelisted`, un
 *     cliente que manda un parametro extra recibe un 400 con un mensaje de
 *     validacion, que no es un error de OAuth.
 *   - Un parametro repetido (`grant_type=a&grant_type=b`) no es un caso de
 *     borde: es un pedido mal formado, y la respuesta correcta es
 *     `invalid_request`.
 *
 * El `grant_type` se resuelve antes de tocar la base: un `grant_type` desconocido
 * no tiene nada que ver con ningun code ni ningun refresh.
 */
@Controller('oidc')
@UseFilters(FiltroErroresOidc)
export class TokenController {
  constructor(private readonly tokens: TokenService) {}

  @Post('token')
  @HttpCode(200)
  async token(@Body() body: unknown, @Ip() ip: string, @Req() req: Request): Promise<unknown> {
    const cuerpo = normalizarCuerpoOauth(body);
    const ctx = { ip, userAgent: req.get('user-agent') ?? 'desconocido' };

    if (!cuerpo.grant_type) {
      // Parametro obligatorio que no vino: `invalid_request` (RFC 6749 §5.2).
      // Distinguirlo de "grant desconocido" si lo usa el cliente para detectar
      // que se le olvido el parametro.
      throw new ErrorOidc('invalid_request');
    }

    switch (cuerpo.grant_type) {
      case GRANT_CODE:
        return this.tokens.canjear(cuerpo, ctx);
      case GRANT_REFRESH:
        return this.tokens.renovar(cuerpo, ctx);
      default:
        throw new ErrorOidc('unsupported_grant_type');
    }
  }
}

/**
 * Cuerpo OAuth a `{ [nombre]: string }`, con los repetidos rechazados.
 *
 * `application/x-www-form-urlencoded` es lo que manda todo cliente OAuth
 * (`application/json` llega igual por el express, por si un cliente moderno lo
 * manda). Un valor que no sea string se descarta: no se castea, porque
 * `[object Object]` no es un parametro, es un bug del cliente.
 */
export function normalizarCuerpoOauth(body: unknown): CuerpoToken {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ErrorOidc('invalid_request');
  }

  const salida: Record<string, unknown> = {};
  for (const [clave, valor] of Object.entries(body as Record<string, unknown>)) {
    if (typeof valor === 'string') {
      salida[clave] = valor;
    } else if (clave === 'grant_type' && Array.isArray(valor)) {
      // `grant_type` repetido: es `invalid_request`, no "el primero".
      throw new ErrorOidc('invalid_request');
    }
  }

  return salida as CuerpoToken;
}
