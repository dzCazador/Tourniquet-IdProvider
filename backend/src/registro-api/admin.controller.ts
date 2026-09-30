import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Ip,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Request } from 'express';
import { FiltroErroresRegistro } from '../registro/errores';
import { SinCacheInterceptor } from '../registro/sin-cache.interceptor';
import { AdminGuard } from './admin.guard';
import { AdminAuditoriaService } from './admin.auditoria.service';
import { AdminSesionesService } from './admin.sesiones.service';
import { AdminUsuariosService, type Peticion } from './admin.usuarios.service';
import { adminDe } from './admin.types';
import {
  AltaUsuarioDto,
  CierreSesionDto,
  EditarUsuarioDto,
  ListadoAuditoriaDto,
  ListadoUsuariosDto,
} from './dto/admin.dto';

/**
 * `/admin/*`: el panel `admin_identidad` de **un** cliente (Fase 08).
 *
 * **`ParseUUIDPipe` en todos los `:id` y `:sid`**: los dos son UUID de la base. Un
 * id con otra forma (un `undefined` de un cliente mal programado, un numero) es un
 * pedido mal formado y por eso 400, no 500: sin el pipe, el mensaje del motor
 * ("error de conversión a uniqueidentifier") se escapa como error interno, y un
 * 500 en un panel de administración es la diferencia entre "el panel esta roto" y
 * "alguien mando basura".
 *
 * Lo que este controlador NO tiene y por qué (D2 de `specs/00`): perfiles,
 * permisos, roles finos, `menumstr`, liquidacion. Hay exactamente tres cosas —
 * quién existe, a qué apps entra y qué sesiones tiene— y la aparecen las que el
 * tenant decide, que son identidad. Un endpoint acá que devuelva un permiso de
 * negocio es un defecto de review, no una funcionalidad pendiente.
 *
 * **El `@UseGuards(AdminGuard)` es del controlador y no del módulo** a propósito: si
 * estuviera en el modulo, un endpoint nuevo que se olvidara de la anotación
 * publicaria un endpoint de administracion sin querer, y el olvido no se ve en el
 * codigo (el controller compila) sino en produccion. Con la anotacion en cada
 * metodo, el unico default es "sin proteccion" y se nota en el diff.
 *
 * Igual que en `/me`, el `idcliente` con el que se opera **no viene del cuerpo**:
 * lo resuelve el guard desde la sesion y lo deja en `req.admin`. Un body con
 * `{"cliente": "otro"}` no llega al servicio, porque el `ValidationPipe` global corre
 * con `forbidNonWhitelisted`.
 */
@Controller('admin')
@UseFilters(FiltroErroresRegistro)
@UseInterceptors(SinCacheInterceptor)
@UseGuards(AdminGuard)
export class AdminController {
  constructor(
    private readonly usuarios: AdminUsuariosService,
    private readonly sesiones: AdminSesionesService,
    private readonly auditoria: AdminAuditoriaService,
  ) {}

  /**
   * `GET /admin/resumen`: los tres numeros del dashboard.
   *
   * Son conteos del tenant y nada mas: usuarios (membresias del cliente), sesiones
   * vivas de esos usuarios, y eventos de auditoria de las ultimas 24 h. No hay
   * graficas ni tendencias: un admin de identidad necesita saber "cuantos son" y
   * "cuanto pasaron", y un dashboard con mas numeros es ruido con datos de RRHH.
   */
  @Get('resumen')
  async resumen(@Req() req: Request): Promise<object> {
    const admin = adminDe(req);
    const desde = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [usuarios, sesiones, eventos, porEstado] = await Promise.all([
      this.usuarios.contarUsuarios(admin.idcliente),
      this.sesiones.contarSesiones(admin.idcliente),
      this.auditoria.contarEventos(admin.idcliente, desde),
      this.usuarios.contarPorEstado(admin.idcliente),
    ]);

    return {
      idcliente: admin.idcliente,
      usuarios,
      usuarios_activos: porEstado.activos,
      usuarios_inactivos: porEstado.inactivos,
      sesiones_abiertas: sesiones,
      eventos_24h: eventos,
    };
  }

  // --- Usuarios ---------------------------------------------------------------

  /** `GET /admin/usuarios`: listado del tenant, con búsqueda y paginación. */
  @Get('usuarios')
  async listarUsuarios(
    @Query() query: ListadoUsuariosDto,
    @Req() req: Request,
  ): Promise<object> {
    return this.usuarios.listar(query, adminDe(req));
  }

  /** `GET /admin/apps`: apps habilitables en este cliente (para los checkboxes). */
  @Get('apps')
  async apps(@Req() req: Request): Promise<object> {
    const admin = adminDe(req);
    const apps = await this.usuarios.appsDisponibles(admin);
    return { total: apps.length, apps };
  }

  /** `GET /admin/usuarios/:id`: ficha de un usuario del tenant. */
  @Get('usuarios/:id')
  async ficha(@Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request): Promise<object> {
    return this.usuarios.ficha(id, adminDe(req).idcliente);
  }

  /**
   * `POST /admin/usuarios`: alta.
   *
   * La respuesta trae `clave_temporal` **una sola vez**. No hay forma de recuperarla
   * despues (solo queda el hash argon2) y no hay endpoint que la vuelva a dar: el
   * reset es la unica via para obtener otra.
   */
  @Post('usuarios')
  @HttpCode(201)
  async alta(
    @Body() dto: AltaUsuarioDto,
    @Req() req: Request,
    @Ip() ip: string,
  ): Promise<object> {
    return this.usuarios.alta(dto, adminDe(req), peticionDe(req, ip));
  }

  /**
   * `PATCH /admin/usuarios/:id`: nombre, apellido, email y estado.
   *
   * `estado = 'inactivo'` cierra en cascada las sesiones del usuario **en este
   * cliente** (y solo en este cliente: un admin de `cervi` no toca las sesiones de
   * esa persona en `jugos`).
   */
  @Patch('usuarios/:id')
  async editar(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: EditarUsuarioDto,
    @Req() req: Request,
    @Ip() ip: string,
  ): Promise<object> {
    return this.usuarios.editar(id, dto, adminDe(req), peticionDe(req, ip));
  }

  /** `POST /admin/usuarios/:id/reset-clave`: clave nueva, mostrada una vez. */
  @Post('usuarios/:id/reset-clave')
  @HttpCode(200)
  async resetClave(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
    @Ip() ip: string,
  ): Promise<object> {
    return this.usuarios.resetClave(id, adminDe(req), peticionDe(req, ip));
  }

  /**
   * `PUT` y `DELETE` sobre `/admin/usuarios/:id/apps/:app`: habilitar y deshabilitar.
   *
   * Verbos distintos y no un `POST .../toggle`, porque "toggle" es ambiguo en un
   * sistema donde la habilitacion decide si alguien entra: el verbo dice que se
   * quiere **dejar** al usuario en ese estado, y un doble clic o un reintento de red
   * no lo deja en el contrario.
   */
  @Put('usuarios/:id/apps/:app')
  async habilitar(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('app') app: string,
    @Req() req: Request,
    @Ip() ip: string,
  ): Promise<object> {
    return this.usuarios.cambiarHabilitacion(id, app, true, adminDe(req), peticionDe(req, ip));
  }

  @Delete('usuarios/:id/apps/:app')
  async deshabilitar(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('app') app: string,
    @Req() req: Request,
    @Ip() ip: string,
  ): Promise<object> {
    return this.usuarios.cambiarHabilitacion(id, app, false, adminDe(req), peticionDe(req, ip));
  }

  // --- Sesiones ---------------------------------------------------------------

  /** `GET /admin/sesiones`: sesiones vivas de los miembros del tenant. */
  @Get('sesiones')
  async listarSesiones(
    @Query('pagina') pagina: string | undefined,
    @Query('por_pagina') porPagina: string | undefined,
    @Req() req: Request,
  ): Promise<object> {
    return this.sesiones.listar(
      adminDe(req),
      aEntero(pagina, 1),
      aEntero(porPagina, 50),
    );
  }

  /**
   * `DELETE /admin/sesiones/:sid`: cierre forzado, con motivo obligatorio.
   *
   * Sin `motivo` el DTO devuelve 400 y no se cierra nada: un cierre de sesión sin
   * explicación es indistinguible de un abuso (`fase-08` §5), y el motivo va tanto a
   * `tok_sesion.motivo_cierre` como a la fila de auditoría con el `sub` del admin.
   */
  @Delete('sesiones/:sid')
  async cerrarSesion(
    @Param('sid', new ParseUUIDPipe()) sid: string,
    @Body() dto: CierreSesionDto,
    @Req() req: Request,
    @Ip() ip: string,
  ): Promise<object> {
    return this.sesiones.cerrar(sid, dto.motivo, adminDe(req), peticionDe(req, ip));
  }

  // --- Auditoría --------------------------------------------------------------

  /**
   * `GET /admin/auditoria`: los eventos de **los miembros de este cliente**.
   *
   * El filtro por membresía es del servicio (`AdminAuditoriaService`), y es la
   * travesía entre tenants más fácil de colar en este panel: `aud_login` es global
   * y un login fallido de otro tenant trae su IP y su navegador.
   */
  @Get('auditoria')
  async listarAuditoria(
    @Query() query: ListadoAuditoriaDto,
    @Req() req: Request,
  ): Promise<object> {
    return this.auditoria.listar(query, adminDe(req));
  }
}

/** `ip` + `userAgent` del request, que es lo que viaja a `aud_login`. */
function peticionDe(req: Request, ip: string): Peticion {
  return { ip, userAgent: req.get('user-agent') ?? 'desconocido' };
}

/**
 * Query numérica tolerante: ausente o inválida = default. Un `?pagina=abc` es la
 * página 1, y no un 400.
 *
 * Es deliberado que sea tolerante y no estricto: `pagina` y `por_pagina` son
 * controles de la UI, no un contrato de API, y un 400 por un `?pagina=` mal formado
 * hace que la pantalla quede en blanco con un error que el usuario no puede
 * provocar ni corregir. El default de `por_pagina` esta en el servicio, que es
 * donde esta el tope de 100.
 */
function aEntero(valor: string | undefined, porDefecto: number): number {
  if (valor === undefined) {
    return porDefecto;
  }
  const n = Number.parseInt(valor, 10);
  return Number.isFinite(n) && n > 0 ? n : porDefecto;
}
