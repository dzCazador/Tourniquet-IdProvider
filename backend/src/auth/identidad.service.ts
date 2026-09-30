import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditoriaService, type CodigoDetalle } from './auditoria.service';
import { RateLimitService } from './rate-limit.service';
import { hashear, necesitaRehash, verificarHash } from './password.service';
import { normalizarUsuario, validarPoliticaClave } from './politica-clave';

/** `specs/01` §4: 5 intentos fallidos seguidos. Contador POR USUARIO. */
export const MAX_INTENTOS_FALLIDOS = 5;
export const MINUTOS_BLOQUEO = 15;

/**
 * Mensajes unicos para la respuesta al cliente.
 *
 * El de credenciales es el MISMO para "usuario inexistente" y "clave mala": si
 * difieren, `POST /login` pasa a ser un oraculo de que cuentas existen. Los de
 * bloqueado e inactivo si pueden ser propios, porque solo se emiten cuando el
 * usuario ya existe y no dependen de adivinar una clave.
 */
export const MENSAJE_CREDENCIALES = 'Credenciales invalidas';
export const MENSAJE_BLOQUEADO = 'Usuario bloqueado temporalmente por intentos fallidos';
export const MENSAJE_INACTIVO = 'Usuario inactivo, contacte al administrador';
export const MENSAJE_RATE_LIMIT = 'Demasiados intentos. Reintente en un momento.';

const FORMATO_USUARIO = /^[a-z0-9._-]{3,50}$/;

export interface ContextoIntento {
  ip: string;
  userAgent: string;
  idAplicacion?: string | null;
}

export interface UsuarioSesion {
  idusuario: string;
  usuario: string;
  nombre: string;
  apellido: string;
  email: string | null;
}

export type MotivoFallo = 'credenciales' | 'bloqueado' | 'inactivo' | 'rate_limit';

/**
 * Fallo de `verificar`.
 *
 * `bloqueadoHasta` y `reintentoEnMs` son los dos datos que el portal necesita
 * para **enseñar** algo: la hora local hasta la que se espera, y cuanto falta
 * para reintentar. Van como dato estructurado, no dentro de `mensaje`, para
 * que el front los formatee con la zona horaria del navegador en vez de
 * adivinar un `HH:MM` impreso por el servidor.
 */
export type ResultadoVerificacion =
  | { ok: true; usuario: UsuarioSesion }
  | {
      ok: false;
      motivo: MotivoFallo;
      mensaje: string;
      bloqueadoHasta?: Date;
      reintentoEnMs?: number;
    };

export interface DatosAdmin {
  usuario: string;
  nombre: string;
  apellido: string;
  clave: string;
  email?: string | null;
  codigoCliente?: string;
  nombreCliente?: string;
}

@Injectable()
export class IdentidadService {
  private readonly logger = new Logger(IdentidadService.name);

  /**
   * Hash argon2id de una cadena fija, para igualar el costo cuando el usuario
   * no existe. Sin esto, "no existe" responde en un SELECT y "clave mala" en
   * ~100 ms de argon2: la diferencia se mide y delata que cuentas hay.
   */
  private hashComparacion: Promise<string> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
    private readonly limite: RateLimitService,
  ) {}

  private obtenerHashComparacion(): Promise<string> {
    if (!this.hashComparacion) {
      this.hashComparacion = hashear('tourniquet-comparacion-fantasma');
    }
    return this.hashComparacion;
  }

  /**
   * Crea el primer administrador.
   *
   * Idempotente: si el `usuario` ya existe NO se pisa. Un bootstrap re-ejecutado
   * por error no puede dejar al admin real sin su clave, y avisar es mejor que
   * un exito mudo.
   */
  async crearAdmin(
    datos: DatosAdmin,
  ): Promise<{ idusuario: string; creado: boolean }> {
    const usuario = normalizarUsuario(datos.usuario);

    if (!FORMATO_USUARIO.test(usuario)) {
      throw new Error(
        `Usuario invalido: se permiten 3 a 50 caracteres [a-z0-9._-] en minuscula.`,
      );
    }

    const politica = validarPoliticaClave(datos.clave, {
      usuario,
      codigoCliente: datos.codigoCliente,
      nombreCliente: datos.nombreCliente,
    });
    if (!politica.valida) {
      throw new Error(`La contrasena no cumple la politica minima: ${politica.motivos.join('; ')}.`);
    }

    const existente = await this.prisma.idn_usuario.findUnique({ where: { usuario } });
    if (existente) {
      return { idusuario: existente.idusuario, creado: false };
    }

    const claveHash = await hashear(datos.clave);

    const fila = await this.prisma.idn_usuario.create({
      data: {
        usuario,
        nombre: datos.nombre,
        apellido: datos.apellido,
        email: datos.email ?? null,
        clave_hash: claveHash,
        mfa_estado: 'off',
        estado: 'activo',
        intentos_fallidos: 0,
        bloqueado_hasta: null,
        creado_en: new Date(),
      },
    });

    return { idusuario: fila.idusuario, creado: true };
  }

  /**
   * Membresia al tenant para cada cliente activo. Idempotente: se filtran las
   * que ya existen antes de insertar, porque `createMany({ skipDuplicates })`
   * no existe para el proveedor MSSQL de Prisma (solo PostgreSQL/MySQL/
   * SQLite). El filtro evita el error de PK en el camino normal; si dos
   * bootstraps corrieran a la vez, el que pierda recibe el error de la base,
   * que es el comportamiento correcto.
   */
  async crearMembresias(idusuario: string, rol = 'admin_identidad'): Promise<number> {
    const clientes = await this.prisma.cat_cliente.findMany({
      where: { estado: 'activo' },
      select: { codigo: true },
    });

    if (clientes.length === 0) {
      return 0;
    }

    const existentes = await this.prisma.idn_usuario_cliente.findMany({
      where: { idusuario },
      select: { idcliente: true },
    });
    const yaEsta = new Set(existentes.map((m) => m.idcliente));
    const faltantes = clientes.filter((cliente) => !yaEsta.has(cliente.codigo));

    if (faltantes.length === 0) {
      return 0;
    }

    const resultado = await this.prisma.idn_usuario_cliente.createMany({
      data: faltantes.map((cliente) => ({
        idusuario,
        idcliente: cliente.codigo,
        rol,
        creado_en: new Date(),
      })),
    });

    return resultado.count;
  }

  /**
   * Habilitacion de ingreso por app (`idn_usuario_cliente_aplicacion`).
   *
   * Es la fila que decide si el usuario **puede entrar** a una app; no dice nada
   * de que ve adentro (D2 de `specs/00`). El authorize la exige, asi que sin
   * esta fila el admin de un cliente no podria entrar a ninguna de sus apps y el
   * flujo OIDC no tendria nada que probar.
   *
   * Se crean para todos los pares (cliente, app) que el cliente tiene
   * provisionados en `cat_cliente_aplicacion`, y solo para los que faltan.
   */
  async crearHabilitaciones(idusuario: string): Promise<number> {
    const pares = await this.prisma.cat_cliente_aplicacion.findMany({
      where: { cliente: { estado: 'activo' } },
      select: { idcliente: true, idaplicacion: true },
      orderBy: [{ idcliente: 'asc' }, { idaplicacion: 'asc' }],
    });

    if (pares.length === 0) {
      return 0;
    }

    const existentes = await this.prisma.idn_usuario_cliente_aplicacion.findMany({
      where: { idusuario },
      select: { idcliente: true, idaplicacion: true },
    });
    const yaEsta = new Set(existentes.map((m) => `${m.idcliente}|${m.idaplicacion}`));

    const faltantes = pares.filter((p) => !yaEsta.has(`${p.idcliente}|${p.idaplicacion}`));
    if (faltantes.length === 0) {
      return 0;
    }

    const ahora = new Date();
    const resultado = await this.prisma.idn_usuario_cliente_aplicacion.createMany({
      data: faltantes.map((par) => ({
        idusuario,
        idcliente: par.idcliente,
        idaplicacion: par.idaplicacion,
        creado_en: ahora,
      })),
    });

    return resultado.count;
  }

  /**
   * Verifica credenciales y deja auditoria de TODOS los resultados.
   *
   * El orden importa: primero el rate limit (para no gastar argon2 en un
   * intento que se va a rechazar igual), despues el bloqueo, y recien ahi la
   * comparacion de la clave.
   */
  async verificar(
    usuario: string,
    clave: string,
    ctx: ContextoIntento,
  ): Promise<ResultadoVerificacion> {
    const normalizado = normalizarUsuario(usuario ?? '');

    // Doble limite, el peor gana (`specs/01` §4).
    const cuota = this.limite.consumirVarios([
      { ambito: 'ip', clave: ctx.ip },
      { ambito: 'usuario', clave: normalizado || '(vacio)' },
    ]);
    if (!cuota.permitido) {
      await this.auditar('error', null, 'rate_limit', ctx);
      return {
        ok: false,
        motivo: 'rate_limit',
        mensaje: MENSAJE_RATE_LIMIT,
        reintentoEnMs: cuota.reintentoEnMs,
      };
    }

    const fila = await this.prisma.idn_usuario.findUnique({
      where: { usuario: normalizado },
    });

    if (!fila) {
      // Se paga el mismo argon2 que en un acierto fallido. Sin esto, el tiempo
      // de respuesta enumera cuentas.
      await verificarHash(await this.obtenerHashComparacion(), clave);
      // `clave_incorrecta` y no "no existe": el `detalle` tambien se lee.
      await this.auditar('claves', null, 'clave_incorrecta', ctx);
      return { ok: false, motivo: 'credenciales', mensaje: MENSAJE_CREDENCIALES };
    }

    const ahora = new Date();

    if (fila.bloqueado_hasta && fila.bloqueado_hasta > ahora) {
      await this.auditar('bloq', fila.idusuario, 'usuario_bloqueado', ctx);
      return {
        ok: false,
        motivo: 'bloqueado',
        mensaje: MENSAJE_BLOQUEADO,
        bloqueadoHasta: fila.bloqueado_hasta,
      };
    }

    if (fila.estado !== 'activo') {
      await this.auditar('error', fila.idusuario, 'usuario_inactivo', ctx);
      return { ok: false, motivo: 'inactivo', mensaje: MENSAJE_INACTIVO };
    }

    const correcta = await verificarHash(fila.clave_hash, clave);

    if (!correcta) {
      const intentos = fila.intentos_fallidos + 1;
      const seBloquea = intentos >= MAX_INTENTOS_FALLIDOS;
      // Una sola fecha para el UPDATE y para la respuesta: si se calculara dos
      // veces, el `bloqueado_hasta` que ve el usuario podria no ser el que
      // quedo en la base, y "volve a intentar a las 15:31" seria mentira.
      const bloqueadoHasta = seBloquea
        ? new Date(ahora.getTime() + MINUTOS_BLOQUEO * 60_000)
        : null;

      await this.prisma.idn_usuario.update({
        where: { idusuario: fila.idusuario },
        data: {
          intentos_fallidos: intentos,
          bloqueado_hasta: bloqueadoHasta ?? fila.bloqueado_hasta,
          actualizado_en: ahora,
        },
      });

      await this.auditar(
        seBloquea ? 'bloq' : 'claves',
        fila.idusuario,
        seBloquea ? 'intentos_superados' : 'clave_incorrecta',
        ctx,
      );

      return seBloquea
        ? {
            ok: false,
            motivo: 'bloqueado',
            mensaje: MENSAJE_BLOQUEADO,
            bloqueadoHasta: bloqueadoHasta as Date,
          }
        : { ok: false, motivo: 'credenciales', mensaje: MENSAJE_CREDENCIALES };
    }

    // Acierto: se limpia el contador y, si los parametros del hash quedaron
    // viejos, se rehashea en el acto. Migrar `t` no debería obligar a pedir la
    // contrasena vieja a nadie.
    const datos: {
      intentos_fallidos: number;
      bloqueado_hasta: null;
      actualizado_en: Date;
      clave_hash?: string;
    } = {
      intentos_fallidos: 0,
      bloqueado_hasta: null,
      actualizado_en: ahora,
    };
    if (necesitaRehash(fila.clave_hash)) {
      datos.clave_hash = await hashear(clave);
      this.logger.log(`clave_hash rehasheada para ${fila.idusuario} (parametros actualizados)`);
    }

    await this.prisma.idn_usuario.update({
      where: { idusuario: fila.idusuario },
      data: datos,
    });

    await this.auditar('ok', fila.idusuario, null, ctx);

    return {
      ok: true,
      usuario: {
        idusuario: fila.idusuario,
        usuario: fila.usuario,
        nombre: fila.nombre,
        apellido: fila.apellido,
        email: fila.email,
      },
    };
  }

  private async auditar(
    resultado: 'ok' | 'claves' | 'bloq' | 'error',
    idusuario: string | null,
    detalle: CodigoDetalle | null,
    ctx: ContextoIntento,
  ): Promise<void> {
    await this.auditoria.registrarSeguro({
      resultado,
      idusuario,
      idaplicacion: ctx.idAplicacion ?? null,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      detalle,
    });
  }
}
