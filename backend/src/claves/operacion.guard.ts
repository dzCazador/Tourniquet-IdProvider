import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { PortalService } from '../auth/portal.service';
import { sidDeLaPeticion } from '../oidc/cookies';
import { RequestConOperador } from './operacion.types';

/**
 * `OperadorGuard`: la unica puerta de `/operacion/*`, que hoy es la rotación de
 * las claves de firma de **toda la instalación** (`specs/01` §5.1).
 *
 * Tres reglas, en este orden, y el orden importa:
 *
 *  1. **`TQ_ROTACION_HABILITADA` en `true`.** Si no, responde **404**, no 403:
 *     con la variable apagada el endpoint no existe, y "no existe" no le dice a
 *     un atacante que hay un endpoint que existe pero está apagado.
 *  2. **Sesión de portal viva.** Es una operación para una persona con un login,
 *     no para un proceso. Y el `usuario` sale de la sesión, nunca del pedido.
 *  3. **`usuario` en `TQ_OPERADORES_CLAVES`.** Lista de logins separados por coma
 *     en la configuración, comparada **exacta** y en minúsculas (los logins se
 *     almacenan en minúscula, `normalizarUsuario`).
 *
 * Por qué una lista de la configuración y no un rol en
 * `idn_usuario_cliente.rol`: el rol es **por cliente** y esta operación es de la
 * **instalación**. Un rol nuevo en esa tabla haría que un `admin_identidad` de
 * `cervi` pudiera rotar las claves que firman los tokens de `jugos`. La decisión,
 * con su motivo, está en `specs/01` §5.1.
 *
 * Por qué no es el `AdminGuard` de `/admin/*`: ése autoriza por
 * `admin_identidad` de **un** cliente, y `/admin` significa "panel de un cliente"
 * en todo el repo. Por eso la ruta de la rotación es `/operacion/...` y no
 * `/admin/claves/...` como decía el borrador de la fase: la confusión entre
 * "panel de un tenant" y "rotar las claves de la instalación" no tiene que ser
 * ni siquiera escribible.
 *
 * Un operador puede ser `admin_identidad` de cero clientes: la lista de
 * operadores es independiente de los tenants, que es exactamente lo que hace falta
 * para el que administra la instalación sin administrar clientes.
 */
@Injectable()
export class OperadorGuard implements CanActivate {
  private readonly logger = new Logger(OperadorGuard.name);

  constructor(
    private readonly portal: PortalService,
    private readonly config: ConfigService,
  ) {}

  async canActivate(contexto: ExecutionContext): Promise<boolean> {
    if (!this.habilitada()) {
      // 404 y no 403. Ver el comentario del metodo.
      throw new HttpException({ codigo: 'no_encontrado' }, HttpStatus.NOT_FOUND);
    }

    const req = contexto.switchToHttp().getRequest<Request>();
    const ctx = await this.portal.contextoDe(sidDeLaPeticion(req));

    if (!ctx) {
      throw new HttpException({ codigo: 'sesion_requerida' }, HttpStatus.UNAUTHORIZED);
    }

    const operadores = this.operadores();

    if (!operadores.has(ctx.usuario.usuario)) {
      this.logger.warn(
        `intento de operacion de instalacion por ${ctx.usuario.usuario}: no esta en ` +
          'TQ_OPERADORES_CLAVES',
      );
      throw new HttpException({ codigo: 'sin_permiso' }, HttpStatus.FORBIDDEN);
    }

    (req as RequestConOperador).operador = {
      idusuario: ctx.usuario.idusuario,
      usuario: ctx.usuario.usuario,
      nombre: `${ctx.usuario.nombre} ${ctx.usuario.apellido}`.trim(),
    };

    return true;
  }

  /**
   * `TQ_ROTACION_HABILITADA`.
   *
   * Hay dos caminos por los que llega el valor y **los dos importan**:
   *
   * 1. **Dentro de Nest**, `ConfigModule` validó con el esquema Joi, que tiene
   *    `.boolean()` con `truthy`/`falsy`: el `.env` dice `false` en texto y lo que
   *    llega acá ya es el booleano `false`. Por eso el `typeof` va primero: un
   *    `.trim()` sobre un booleano revienta con "is not a function" y el guard
   *    respondía 500 en vez de 404, que es la peor forma de fallar un
   *    "el endpoint no existe".
   * 2. **Desde los scripts** (`configServiceDe` de `env.schema.ts`), que también
   *    devuelve el valor ya convertido... pero un `scripts/` puede llamar a
   *    `config.get` con un entorno sintético sin pasar por Joi, y ahí llega
   *    texto.
   *
   * Se aceptan `true`, `1`, `si` y `yes` porque el valor viene de un `.env` o de
   * un gestor de secretos donde lo único garantizado es que es texto, y un
   * operador que escribe `1` y ve el endpoint apagado concluye que está roto.
   */
  private habilitada(): boolean {
    const bruto = this.config.get<boolean | string>('TQ_ROTACION_HABILITADA');

    if (typeof bruto === 'boolean') {
      return bruto;
    }

    const texto = String(bruto ?? 'false').trim().toLowerCase();
    return texto === 'true' || texto === '1' || texto === 'si' || texto === 'yes';
  }

  /**
   * `TQ_OPERADORES_CLAVES`: set de logins en minúscula.
   *
   * Se normaliza con `normalizarUsuario` (el mismo del login) para que
   * `Admin` y `admin` en el entorno se cuentan como la misma persona, y no dos.
   */
  private operadores(): Set<string> {
    const bruto = this.config.get<string>('TQ_OPERADORES_CLAVES') ?? '';
    return new Set(
      bruto
        .split(',')
        .map((valor) => valor.trim().toLowerCase())
        .filter(Boolean),
    );
  }
}
