import {
  Body,
  Controller,
  Get,
  HttpCode,
  Ip,
  Logger,
  Post,
  Req,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { AuditoriaService, detalleDe } from '../auth/auditoria.service';
import { SinCacheInterceptor } from '../registro/sin-cache.interceptor';
import { FirmaService } from './firma.service';
import { OperadorGuard } from './operacion.guard';
import { RequestConOperador, type Operador } from './operacion.types';
import { ReactivarClaveDto } from './dto/operacion.dto';
import { FiltroErroresOperacion } from './operacion.errores';

/**
 * `/operacion/*`: las operaciones que son de la **instalación** y no de un
 * cliente. Hoy hay una sola: la rotación de las claves de firma
 * (`specs/01` §5.1).
 *
 * **Por qué el prefijo `operacion` y no `admin`** es la decisión más importante de
 * este archivo, y no es una cuestión de gusto:
 *
 *   - `/admin/*` significa, en todo el repo, "panel de un cliente": su guard
 *     (`AdminGuard`) autoriza al `admin_identidad` **de ese cliente** y resuelve
 *     el `idcliente` con el que se opera.
 *   - La rotación de claves **afecta a todos los clientes**: el JWKS es único por
 *     instalación. Un endpoint de rotación debajo de `/admin` leído por un
 *     `admin_identidad` de `cervi` sería un endpoint donde un administrador de un
 *     cliente puede romper el login de otro.
 *   - Con un prefijo propio, esa confusión no es ni siquiera escribible, y el
 *     `RotacionGuard`/`OperadorGuard` deja de depender del tenant.
 *
 * **Deshabilitado por default** (`TQ_ROTACION_HABILITADA=false`): el caso normal
 * es el procedimiento manual por script (`npm run rotar:clave`), que es lo que va
 * al runbook. Con la variable apagada, `GET /operacion/claves` responde 404 y no
 * hay forma de que alguien descubra que existe.
 *
 * El `@UseGuards` va **por método**, no en el módulo, por la misma razón que en
 * `AdminController`: un endpoint nuevo que se olvide de la anotación no debe
 * quedar publicado por olvido.
 */
@Controller('operacion/claves')
@UseFilters(FiltroErroresOperacion)
@UseInterceptors(SinCacheInterceptor)
export class OperacionController {
  private readonly logger = new Logger(OperacionController.name);

  constructor(
    private readonly firma: FirmaService,
    private readonly auditoria: AuditoriaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * `GET /operacion/claves`: el estado de las claves, para el drill.
   *
   * `tokens_en_vuelo` es la estimación por fecha que explica `FirmaService.estado`:
   * los access tokens no se persisten, así que no hay forma de contar cuántos
   * quedaron firmados con una clave retirada; lo que sí se sabe es que a los 15
   * minutos de la retirada no queda ninguno.
   */
  @Get()
  @UseGuards(OperadorGuard)
  async estado(): Promise<object> {
    const vida = this.config.get<number>('ACCESS_TTL_MIN') ?? 15;
    return this.firma.estado(vida);
  }

  /**
   * `POST /operacion/claves/rotar`: genera la clave nueva, la activa y retira la
   * anterior, que sigue en el JWKS 24 h (`specs/01` §5).
   *
   * Lo que el endpoint **no** hace, y por eso el runbook sigue siendo necesario:
   *   - no reinicia el memo interno del JWKS (60 s, `oidc/oidc.module.ts`), así
   *     que la propagación a `/userinfo` y a las apps tarda hasta un minuto;
   *   - no verifica que un login real funcione con la clave nueva. Eso lo hace el
   *     drill del runbook, y es la razón de que el paso 5 sea "entrar de verdad":
   *     una rotación que nadie probó se descubre durante un incidente.
   */
  @Post('rotar')
  @HttpCode(200)
  @UseGuards(OperadorGuard)
  async rotar(@Req() req: Request, @Ip() ip: string): Promise<object> {
    const kid = await this.firma.activarNueva();
    const estado = await this.firma.estado(this.config.get<number>('ACCESS_TTL_MIN') ?? 15);

    await this.auditar('op_rotacion_claves', operadorDe(req), { kid, ip, userAgent: req.get('user-agent') ?? 'desconocido' });

    return {
      kid_activa: kid,
      /** Lo anterior queda publicada 24 h: ese es el margen de rollback. */
      ventana_solapamiento_h: VENTANA_JWKS_HORAS,
      estado,
      proximos_pasos: [
        'Verificar GET /.well-known/jwks.json: la clave nueva y la anterior, las dos.',
        'Entrar de verdad en una app configurada con este TQ_ISSUER (paso 5 del runbook).',
        'Si algo falla, POST /operacion/claves/reactivar con el kid anterior.',
      ],
    };
  }

  /**
   * `POST /operacion/claves/reactivar`: el **rollback** (`specs/01` §5.1).
   *
   * Reactiva una clave que ya estaba en la tabla y retira la que estaba activa.
   * Es seguro dentro de la ventana de 24 h del JWKS, que es cuando las dos están
   * publicadas: fuera de esa ventana, reactivar una clave vieja no recupera los
   * tokens que esa clave ya dejo sin validar, pero si deja de firmar con la clave
   * que el operador dio por comprometida.
   *
   * El `kid` va en el cuerpo y **no** en la URL: es el dato que decide qué clave
   * firma todo lo que viene después, y una URL con el `kid` se queda en los logs
   * de acceso de cualquier proxy.
   */
  @Post('reactivar')
  @HttpCode(200)
  @UseGuards(OperadorGuard)
  async reactivar(
    @Body() dto: ReactivarClaveDto,
    @Req() req: Request,
    @Ip() ip: string,
  ): Promise<object> {
    const kid = await this.firma.reactivar(dto.kid);
    const estado = await this.firma.estado(this.config.get<number>('ACCESS_TTL_MIN') ?? 15);

    await this.auditar('op_reactivacion_claves', operadorDe(req), {
      kid,
      ip,
      userAgent: req.get('user-agent') ?? 'desconocido',
    });

    return { kid_activa: kid, ventana_solapamiento_h: VENTANA_JWKS_HORAS, estado };
  }

  private async auditar(
    codigo: 'op_rotacion_claves' | 'op_reactivacion_claves',
    operador: Operador,
    ctx: { kid: string; ip: string; userAgent: string },
  ): Promise<void> {
    // El `idusuario` de la fila es el **operador**, no "sistema" (`specs/01` §7):
    // una rotación de claves es de las cosas que más se investigan después, y sin
    // saber quién la hizo la fila no sirve.
    await this.auditoria.registrarSeguro({
      resultado: 'ok',
      idusuario: operador.idusuario,
      idaplicacion: null,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      // El `kid` sí va en el detalle: es un identificador público (está en el
      // header de cada token) y es lo que hace falta para revertir la operación.
      detalle: detalleDe(codigo, { kid: ctx.kid, operador: operador.usuario }),
    });

    this.logger.log(
      `${codigo} por ${operador.usuario} (${operador.nombre}): kid=${ctx.kid}`,
    );
  }
}

/** La ventana de solapamiento del JWKS, en horas (`specs/01` §5). */
const VENTANA_JWKS_HORAS = 24;

function operadorDe(req: Request): Operador {
  return (req as RequestConOperador).operador;
}
