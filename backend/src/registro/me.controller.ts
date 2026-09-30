import {
  Body,
  Controller,
  Delete,
  Get,
  Ip,
  Param,
  Post,
  Req,
  Res,
  UseFilters,
  UseInterceptors,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuditoriaService, detalleDe } from '../auth/auditoria.service';
import { PortalService, type ContextoSesionPortal } from '../auth/portal.service';
import { escribirCookieDeSesion, sidDeLaPeticion } from '../oidc/cookies';
import { ipTruncada, SesionService } from '../oidc/sesion.service';
import { PrismaService } from '../prisma/prisma.service';
import { ClienteActivoDto } from './dto/cliente-activo.dto';
import { FiltroErroresRegistro, noEncontrado, sinSesion } from './errores';
import { SinCacheInterceptor } from './sin-cache.interceptor';

/**
 * Cuantas sesiones de las propias se devuelven como maximo.
 *
 * El tope existe porque la lista es para que una persona la lea, y una persona
 * tiene pocas sesiones: si alguna vez aparecen cientos, lo que se esta mirando es
 * un ataque o un bug de loop, y en los dos casos la lista entera no ayuda a
 * diagnosticar — entorpece la pagina y esconde la fila que importa. Con el tope, el
 * frontend dice "hay mas" y el que investiga mira la base (`specs/04` Fase 03).
 */
const TOPE_SESIONES_PROPIAS = 50;

/**
 * `GET /me`, `GET /me/apps`, `GET /me/clientes`, `POST /me/cliente-activo`,
 * `GET /me/sesiones` y `DELETE /me/sesiones/:sid`.
 *
 * Todos leen la **misma** sesion del portal (`tok_sesion_portal`) y por eso
 * comparten `contextoDe`: el `tenant` que contestan es el `idcliente` de esa fila de
 * `tok_sesion`, decidido en el login y cambiado solo por `POST /me/cliente-activo`.
 * Nunca un parametro, un header o una cookie del cliente (invariante de
 * `AGENTS.md`).
 *
 * `GET /me` es super-set de `GET /auth/session` (Fase 04) y agrega lo que el
 * lanzador necesita: el rol del usuario en el cliente actual y la lista de sus
 * membresias. Los dos conviven porque el login y el logout del portal usan el
 * chico y no necesitan el resto.
 */
@Controller('me')
@UseFilters(FiltroErroresRegistro)
@UseInterceptors(SinCacheInterceptor)
export class MeController {
  constructor(
    private readonly portal: PortalService,
    private readonly prisma: PrismaService,
    private readonly sesiones: SesionService,
    private readonly auditoria: AuditoriaService,
  ) {}

  /**
   * Quien esta logueado: usuario, cliente activo y rol.
   *
   * `clientes` son **todas** sus membresias activas, no solo el cliente de la
   * sesion. No es una via para ver clientes ajenos (la consulta sale del filtro
   * de membresias del propio usuario), es lo que le permite al portal ofrecer
   * cambiar de cliente, y es el mismo dato que ya viaja en el 400
   * `cliente_ambiguo` del login.
   *
   * `rol` puede ser `null`: la sesion sigue viva pero al cliente de la sesion
   * le sacaron la membresia despues del login. Es un estado real y no se
   * disimula inventando un rol.
   */
  @Get()
  async yo(@Req() req: Request): Promise<object> {
    const ctx = await this.contextoDe(req);

    return {
      usuario: ctx.usuario.usuario,
      nombre: `${ctx.usuario.nombre} ${ctx.usuario.apellido}`.trim(),
      email: ctx.usuario.email,
      clienteActual: { ...ctx.cliente, rol: ctx.rol },
      clientes: ctx.membresias,
      expira_en: ctx.sesion.expira_en.toISOString(),
    };
  }

  /**
   * Membresías del usuario, para el selector de cliente del lanzador.
   *
   * Es un endpoint aparte y no un campo más de `/me` por una razón práctica: el
   * selector se pide **siempre**, incluso con una sola membresía (para saber que
   * no hay que mostrarlo), y en `/me` el frontend ya tiene el dato. Se conserva
   * por simetría del contrato —cada pantalla lee lo que necesita— y porque
   * `GET /me` va a crecer con cosas del login que el selector no necesita.
   */
  @Get('clientes')
  async clientes(@Req() req: Request): Promise<object> {
    const ctx = await this.contextoDe(req);
    return { total: ctx.membresias.length, clientes: ctx.membresias };
  }

  /**
   * Apps a las que el usuario puede entrar **en el cliente de su sesion**.
   *
   * La lista sale de la interseccion de tres filtros, y cada uno quita algo
   * distinto:
   *
   *   - `idn_usuario_cliente_aplicacion`: que el usuario este **habilitado**
   *     (la fila que el authorize exige). Sin ella la lista es vacia, no un
   *     error: es el estado de un `user` sin apps, que es real.
   *   - `cat_cliente_aplicacion`: que la app exista **para ese cliente**. Sin
   *     este filtro, un miembro de `cervi` veria en su lanzador apps que solo
   *     existen para otro cliente, y el authorize las rechazaria con
   *     `access_denied` despues de que el usuario eligiera.
   *   - `cat_aplicacion.estado = 'activo'`: una app dada de baja no se ofrece.
   *
   * Los tres van **dentro** del filtro de la sesion, no despues: por eso un
   * usuario de otro cliente no aparece nunca, ni por error de paginado ni por
   * una app compartida entre clientes.
   *
   * `inicio` y `base` son los dos datos que la pantalla de puerta necesita y que
   * no puede inventar: la URL registrada por la que se abre la app
   * (`cat_aplicacion.url_inicio`, `specs/01` §1.2) y el **nombre** de la base de
   * la que va a leer los datos. Nunca el host, nunca el usuario, nunca la
   * credencial (`specs/01` §6): el usuario tiene motivo legitimo de saber a que
   * datos entra, y ninguno de los otros dos.
   */
  @Get('apps')
  async apps(@Req() req: Request): Promise<object> {
    const ctx = await this.contextoDe(req);
    const idcliente = ctx.cliente.idcliente;

    const apps = await this.prisma.cat_aplicacion.findMany({
      where: {
        estado: 'activo',
        clientes: { some: { idcliente, cliente: { estado: 'activo' } } },
        membresias: { some: { idusuario: ctx.usuario.idusuario, idcliente } },
      },
      select: { codigo: true, nombre: true, url_inicio: true },
      orderBy: { codigo: 'asc' },
    });

    // Una consulta aparte para las bases, y no un `include` anidado: la relacion
    // `cat_aplicacion` <-> `cat_base_datos` no existe en el esquema de Prisma (solo
    // hay FKs sueltas por `idcliente` + `idaplicacion`), y declararla obligaria a
    // tocar el DDL. Con el indice `UQ_cat_base_datos_cliente_aplicacion_activa` hay
    // **una** base activa por combinacion, asi que el `Map` nunca tiene dos
    // entradas para la misma app.
    const bases = await this.prisma.cat_base_datos.findMany({
      where: {
        idcliente,
        estado: 'activo',
        idaplicacion: { in: apps.map((a) => a.codigo) },
      },
      select: { idaplicacion: true, base: true },
    });
    const basePorApp = new Map(bases.map((b) => [b.idaplicacion, b.base]));

    return {
      idcliente,
      total: apps.length,
      apps: apps.map((app) => ({
        codigo: app.codigo,
        nombre: app.nombre,
        inicio: app.url_inicio,
        base: basePorApp.get(app.codigo) ?? null,
      })),
    };
  }

  /**
   * Cambia el cliente activo. Re-emite la sesion del portal (ver
   * `PortalService.cambiarCliente`) y por eso **reescribe la cookie**.
   *
   * El selector del lanzador es un POST y no un `?cliente=`: si el cliente viniera
   * por query, cualquier endpoint que lo leyera aceptaria que lo elija el pedido, y
   * el `tenant` del token de la app siguiente sería el de la URL.
   */
  @Post('cliente-activo')
  async clienteActivo(
    @Body() dto: ClienteActivoDto,
    @Req() req: Request,
    @Res() res: Response,
    @Ip() ip: string,
  ): Promise<void> {
    const ctx = await this.contextoDe(req);
    const userAgent = req.get('user-agent') ?? 'desconocido';

    const resultado = await this.portal.cambiarCliente(ctx, dto.cliente, { ip, userAgent });

    if (resultado.cambio) {
      // La cookie se escribe siempre, tambien cuando no hubo cambio: es la que
      // apunta a la fila de sesion, y escribiendola en los dos casos el frontend no
      // tiene que distinguir "cambio" de "no cambio" para decidir si refresca.
      escribirCookieDeSesion(req, res, resultado.sesion.sid);

      await this.auditoria.registrarSeguro({
        resultado: 'ok',
        idusuario: ctx.usuario.idusuario,
        idaplicacion: null,
        ip,
        userAgent,
        detalle: detalleDe('cambio_de_cliente', { cliente: resultado.cliente.idcliente }),
      });
    }

    res.status(200).json({
      clienteActual: { ...resultado.cliente, rol: ctx.rol },
      expira_en: resultado.sesion.expira_en.toISOString(),
      cambio: resultado.cambio,
    });
  }

  /**
   * Sesiones vivas del usuario **en el cliente de su sesion**.
   *
   * No son las de todos sus clientes: "salir de todo" es por cliente
   * (`specs/01` §4), asi que la lista es por cliente tambien. Ver las de otro
   * cliente no seria un bug grave —son suyas—, pero sí haría que el botón de
   * "salir de todo" de `/mi-cuenta` pareciera más ineffective de lo que es.
   *
   * La IP viene truncada (`ipTruncada`) y el `user_agent` crudo: el primero es lo
   * que la lista muestra, y el segundo lo resume el front. Guardar el crudo sirve
   * para diagnóstico; mandarlo crudo en la respuesta sería mandar 500 caracteres
   * que nadie lee.
   */
  @Get('sesiones')
  async sesionesPropias(@Req() req: Request): Promise<object> {
    const ctx = await this.contextoDe(req);

    const abiertas = await this.sesiones.activasDe(
      ctx.usuario.idusuario,
      ctx.cliente.idcliente,
    );
    const total = abiertas.length;
    const tope = abiertas.slice(0, TOPE_SESIONES_PROPIAS);

    return {
      idcliente: ctx.cliente.idcliente,
      total,
      hay_mas: total > tope.length,
      sesiones: tope.map((sesion) => ({
        sid: sesion.sid,
        // `null` es la del portal. Distinguirla en la respuesta es lo que permite
        // que la pantalla no ofrezca "cerrar" sobre la sesion que esta usando para
        // mirarla: cerrarla seria desloguearse, no cerrar una sesion.
        idaplicacion: sesion.idaplicacion,
        app: sesion.aplicacion?.nombre ?? 'Portal',
        es_portal: sesion.idaplicacion === null,
        ip: ipTruncada(sesion.ip),
        user_agent: sesion.user_agent,
        creado_en: sesion.creado_en.toISOString(),
        expira_en: sesion.expira_en.toISOString(),
      })),
    };
  }

  /**
   * Cerrar una sesion propia.
   *
   * El filtro `idusuario` + `idcliente` va **dentro** de la consulta
   * (`SesionService.vivaDeUsuario`): un `sid` de otro usuario da `null` y la
   * respuesta es 404, no 403. Con un 403 se confirmaria que ese `sid` existe, y
   * con eso este endpoint seria un oraculo de las sesiones de todo el IdP.
   *
   * Cerrar la sesion **del portal** desde acá es lo mismo que "salir del portal":
   * la cookie sigue apuntando a una fila cerrada y el siguiente pedido que la use
   * responde 401, que el front traduce como "no hay sesion". Por eso la sesion del
   * portal viene marcada con `es_portal` y el front la ofrece como logout, no como
   * "cerrar esta sesion".
   */
  @Delete('sesiones/:sid')
  async cerrarSesion(
    @Param('sid') sid: string,
    @Req() req: Request,
    @Ip() ip: string,
  ): Promise<object> {
    const ctx = await this.contextoDe(req);

    const sesion = await this.sesiones.vivaDeUsuario(
      sid,
      ctx.usuario.idusuario,
      ctx.cliente.idcliente,
    );
    if (!sesion) {
      noEncontrado();
    }

    // `logout` y no `revocada`: la cierra la persona que es dueño de la sesion, y
    // en `tok_sesion` esa es la diferencia con el cierre forzado del panel (que usa
    // el motivo que eligio el admin).
    await this.sesiones.cerrar(sesion.sid, 'logout');

    await this.auditoria.registrarSeguro({
      resultado: 'ok',
      idusuario: ctx.usuario.idusuario,
      idaplicacion: sesion.idaplicacion,
      ip,
      userAgent: req.get('user-agent') ?? 'desconocido',
      detalle: detalleDe('sesion_cerrada_propia', {
        app: sesion.idaplicacion ?? 'portal',
        sid: sesion.sid.slice(0, 8),
      }),
    });

    return { ok: true, sid: sesion.sid };
  }

  /**
   * Sesion viva o 401. Unico lugar donde estos endpoints deciden que no hay
   * sesion, para que los dos se comporten igual.
   */
  private async contextoDe(req: Request): Promise<ContextoSesionPortal> {
    const ctx = await this.portal.contextoDe(sidDeLaPeticion(req));
    if (!ctx) {
      sinSesion();
    }
    return ctx;
  }
}
