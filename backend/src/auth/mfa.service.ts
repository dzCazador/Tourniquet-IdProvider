import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { MasterKeyService } from '../claves/master-key.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  compararConVentana,
  formatearCodigo,
  generarCodigoRecuperacion,
  generarSecreto,
  normalizarCodigo,
  uriOtpAuth,
} from './totp';

/**
 * Cantidad de códigos de recuperación por usuario (`specs/01` §8.5).
 *
 * Diez y no uno: el código se usa una vez, se anota en un papel, y con uno solo
 * el primer uso lo deja sin nada. Diez son suficientes para un ida y vuelta a la
 * fotocopiadora sin que el papel sea una invitación a probarlos.
 */
export const CANTIDAD_CODIGOS = 10;

/**
 * A partir de cuántos códigos que quedan la UI avisa (`specs/01` §8.5).
 *
 * El aviso va en `/mi-cuenta` y en la pantalla de verificación, y no bloquea
 * nada: un usuario con un código y el teléfono sin batería tiene que poder
 * entrar igual, y avisarlo es information, no un bloqueo.
 */
export const AVISO_CODIGOS_POCOS = 2;

export type EstadoMfa = 'off' | 'pending' | 'on';

export interface EstadoMfaUsuario {
  estado: EstadoMfa;
  /** Códigos de recuperación sin usar. `0` cuando el MFA está apagado. */
  codigos_restantes: number;
  /** `true` desde el umbral de `AVISO_CODIGOS_POCOS`. */
  aviso_pocos: boolean;
  /** ISO 8601 del último período TOTP aceptado, o `null`. Diagnóstico. */
  ultimo_periodo: string | null;
}

/**
 * Lo que devuelve `activar`: el `otpauth://` y los códigos, **una sola vez**.
 *
 * El campo se llama `unica_vez` a propósito. No es decorativo: es el aviso de
 * que esta respuesta es la última oportunidad de leerlo, y el tipo obliga a que
 * quien lo consuma lo muestre antes de que el request se termine.
 */
export interface EnrolamientoMfa {
  usuario: string;
  otpauth: string;
  /** El secret en base32, por si la app del usuario no puede leer el QR. */
  clave: string;
  codigos: string[];
  estado: EstadoMfa;
  unica_vez: true;
}

export type ResultadoVerificacionMfa =
  | { ok: true; metodo: 'totp' | 'recuperacion'; periodo: number | null; codigos_restantes: number }
  | {
      ok: false;
      motivo: 'sin_secret' | 'codigo_incorrecto' | 'reutilizado' | 'usuario_inactivo';
    };

/**
 * `idn_usuario.mfa_secret_cifrada`, `mfa_estado`, `mfa_ultimo_periodo` y los
 * códigos de recuperación (`specs/01` §8).
 *
 * Reglas del archivo, que son las del `AGENTS.md` aplicadas a un solo lugar:
 *
 * 1. **El secret se cifra acá y no antes.** `MasterKeyService.cifrar` genera el
 *    IV aleatorio por registro, así que en ningún momento existe un secret
 *    cifrado listo para escribir desde afuera. La columna se escribe siempre con
 *    el resultado de esta función, nunca con bytes que vengan del pedido.
 * 2. **El secret no sale.** No hay ningún método público que devuelva
 *    `mfa_secret_cifrada` en claro, y `activar`/`reactivar` devuelven el
 *    `otpauth://` **una vez**, que es un caso distinto: es el enrolamiento, y sin
 *    él no hay segundo factor.
 * 3. **Un código de recuperación se marca usado, no se borra**, y sólo con un
 *    `UPDATE` condicionado a `usado_en IS NULL`: dos pedidos con el mismo código
 *    a la vez no pueden consumir dos filas.
 */
@Injectable()
export class MfaService {
  private readonly logger = new Logger(MfaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly masterKey: MasterKeyService,
  ) {}

  /** Estado del MFA de un usuario, con los códigos que le quedan. */
  async estadoDe(idusuario: string): Promise<EstadoMfaUsuario> {
    const fila = await this.prisma.idn_usuario.findUnique({
      where: { idusuario },
      select: { mfa_estado: true, mfa_ultimo_periodo: true },
    });

    if (!fila) {
      throw new Error(`El usuario ${idusuario} no existe.`);
    }

    const restantes = await this.contarCodigos(idusuario);
    const estado = fila.mfa_estado as EstadoMfa;

    return {
      estado,
      codigos_restantes: estado === 'off' ? 0 : restantes,
      aviso_pocos: estado !== 'off' && restantes <= AVISO_CODIGOS_POCOS,
      ultimo_periodo: fila.mfa_ultimo_periodo === null ? null : fila.mfa_ultimo_periodo.toString(),
    };
  }

  /**
   * Enciende MFA para un usuario: secret nuevo, `mfa_estado='pending'` y 10
   * códigos de recuperación.
   *
   * **Vuelve a `pending` y no a `off` aunque estuviera apagado**, y genera un
   * secret nuevo cada vez. Es la decisión que hace que "activar" sobre un
   * usuario que ya tenía MFA no sea un Alberto: si reactivara, el secret
   * anterior dejaría de valer y el usuario que ya tenía la app configurada se
   * quedaría sin acceso hasta que el admin le pase el `otpauth` nuevo. Con
   * `pending`, el login sigue funcionando con clave sola (`specs/01` §8.1) y
   * hasta que el usuario confirme hay dos caminos: el anterior si conserva el
   * secret, o el nuevo.
   *
   * Los códigos de recuperación anteriores se **invalidan** (`usado_en` con la
   * hora) en vez de borrarse: son 10 filas por activación y la app los borra por
   * edad, no por activación. Invalidarlos es la operación que se puede hacer
   * sin tocar la auditoría de "quién tenía códigos", y `specs/01` §8.5 dice
   * que regenerarlos invalida los anteriores.
   */
  async activar(idusuario: string, ahora: Date = new Date()): Promise<EnrolamientoMfa> {
    const usuario = await this.prisma.idn_usuario.findUnique({
      where: { idusuario },
      select: { idusuario: true, usuario: true },
    });

    if (!usuario) {
      throw new Error(`El usuario ${idusuario} no existe.`);
    }

    const clave = generarSecreto();

    const codigos = await this.prisma.$transaction(async (tx) => {
      await tx.idn_usuario.update({
        where: { idusuario },
        data: {
          // Cifrado acá: el IV aleatorio lo genera `cifrar` y va pegado al
          // ciphertext, así que este valor no se puede escribir desde afuera.
          mfa_secret_cifrada: this.masterKey.cifrar(clave),
          mfa_estado: 'pending',
          // El período anti-reuso arranca en NULL con cada secret nuevo: el
          // contador es del secret, no de la persona. Sin esto, un
          // `mfa_ultimo_periodo` del secret viejo rechazaría el primer código
          // del nuevo con el error de "reutilizado", que es un mensaje falso.
          mfa_ultimo_periodo: null,
          actualizado_en: ahora,
        },
      });

      return this.reemplazarCodigos(tx, idusuario, ahora);
    });

    this.logger.log(
      `MFA activator para ${usuario.usuario}: secret nuevo, ${codigos.length} codigos ` +
        `de recuperacion (quedan pendientes de confirmacion)`,
    );

    return {
      usuario: usuario.usuario,
      otpauth: uriOtpAuth(usuario.usuario, clave),
      clave,
      codigos: codigos.map(formatearCodigo),
      estado: 'pending',
      unica_vez: true,
    };
  }

  /**
   * Confirma el enrolamiento: `pending` → `on`.
   *
   * Verifica **el código TOTP** y no un código de recuperación: confirmar con
   * un código de recuperación dejaría activa una cuenta cuya app nunca se
   * configuró, y el usuario se enteraría en el próximo ingreso, cuando ya no
   * hay nadie a quien preguntarle.
   */
  async confirmar(idusuario: string, codigo: string, ahora: Date = new Date()): Promise<number> {
    const resultado = await this.verificarCodigo(idusuario, codigo, ahora);

    if (!resultado.ok) {
      // Se propaga el motivo como un error y no como un `false`: la diferencia
      // entre "el código no sirve" y "el usuario no tiene MFA" importa para el
      // mensaje, y el service de la capa de arriba decide el status.
      throw new Error(
        resultado.motivo === 'sin_secret'
          ? 'El usuario no tiene un secreto de MFA enrolado.'
          : 'El codigo no coincide con el de la app de autenticacion.',
      );
    }

    await this.prisma.idn_usuario.update({
      where: { idusuario },
      data: { mfa_estado: 'on', actualizado_en: ahora },
    });

    this.logger.log(`MFA confirmado para ${idusuario.slice(0, 8)} (periodo ${resultado.periodo})`);

    return await this.contarCodigos(idusuario);
  }

  /**
   * Apaga MFA: borra el secret, invalida los códigos, limpia el período y deja
   * `mfa_estado='off'`.
   *
   * El `mfa_secret_cifrada = null` es lo que hace que la próxima activación
   * genere un secret nuevo en vez de reutilizar uno que alguien ya conoce.
   *
   * **No** cierra sesiones: eso lo hace quien llama (`SesionService`), porque es
   * una decisión de alcance (el cliente) y no de este service, que no sabe de
   * tenants (`specs/01` §8.4).
   */
  async desactivar(idusuario: string, ahora: Date = new Date()): Promise<number> {
    await this.prisma.$transaction(async (tx) => {
      await tx.idn_usuario.update({
        where: { idusuario },
        data: {
          mfa_secret_cifrada: null,
          mfa_estado: 'off',
          mfa_ultimo_periodo: null,
          actualizado_en: ahora,
        },
      });

      const { count } = await tx.idn_usuario_mfa_codigo.updateMany({
        where: { idusuario, usado_en: null },
        data: { usado_en: ahora },
      });

      return count;
    });

    this.logger.log(`MFA desactivado para ${idusuario.slice(0, 8)}`);
    return this.contarVigentes(idusuario);
  }

  /**
   * Verifica el segundo factor de un login. **No** cambia el estado del MFA ni
   * cierra nada: eso lo hace el DesafioService cuando el código es correcto.
   */
  async verificarCodigo(
    idusuario: string,
    codigo: string,
    ahora: Date = new Date(),
  ): Promise<ResultadoVerificacionMfa> {
    const fila = await this.prisma.idn_usuario.findUnique({
      where: { idusuario },
      select: {
        mfa_secret_cifrada: true,
        mfa_ultimo_periodo: true,
        estado: true,
      },
    });

    if (!fila?.mfa_secret_cifrada) {
      return { ok: false, motivo: 'sin_secret' };
    }

    // Un desafío se abre con la clave verificada y vive 5 minutos. En esa
    // ventana un admin puede dar de baja la cuenta, y sin este chequeo el
    // segundo factor creaba la sesion de un usuario desactivado: el panel cierra
    // las sesiones al desactivar, pero no puede cerrar un ingreso que todavia
    // no existe. Sale con su propio motivo para que la respuesta sea `inactivo`
    // y no "codigo incorrecto", que seria hacer creer al usuario que su app de
    // autenticacion esta rota.
    if (fila.estado !== 'activo') {
      return { ok: false, motivo: 'usuario_inactivo' };
    }

    let secreto: string;
    try {
      secreto = this.masterKey.descifrar(Buffer.from(fila.mfa_secret_cifrada));
    } catch {
      // Master key que no descifra esta fila. Es un error de instalación, no de
      // usuario, y el mensaje lo dice: "el código está mal" sería la respuesta
      // más confusa que existe.
      throw new Error(
        `TQ_MASTER_KEY no descifra el secreto MFA de ${idusuario.slice(0, 8)}. ` +
          'O la master key del entorno no es con la que se cifro, o la fila esta corrupta.',
      );
    }

    const limpio = (codigo ?? '').trim();

    // Un código de 6 dígitos numéricos es TOTP; cualquier otra cosa tiene que ser
    // un código de recuperación. Se decide por la forma y no "probando las dos":
    // probar las dos contra la misma base convierte un código de recuperación
    // mal tipeado en un intento fallido de TOTP, y la auditoría del intento ya
    // no dice qué pasó.
    if (/^\d{6}$/.test(limpio)) {
      return this.verificarTotp(idusuario, secreto, limpio, fila.mfa_ultimo_periodo, ahora);
    }

    return this.verificarCodigoRecuperacion(idusuario, limpio, ahora);
  }

  /**
   * TOTP con anti-reuso (`specs/01` §8.3).
   *
   * El orden importa: primero la comparación con la ventana ±1, y sólo si
   * coincidió se mira `mfa_ultimo_periodo`. Al revés, un código que ya se usó se
   * reportaría como "incorrecto", y en la auditoría eso es indistinguible de que
   * el usuario se equivocó al tipear.
   */
  private async verificarTotp(
    idusuario: string,
    secreto: string,
    codigo: string,
    ultimoPeriodo: bigint | null,
    ahora: Date,
  ): Promise<ResultadoVerificacionMfa> {
    const comparacion = compararConVentana(secreto, codigo, ahora);

    if (!comparacion.ok || comparacion.periodo === null) {
      return { ok: false, motivo: 'codigo_incorrecto' };
    }

    if (ultimoPeriodo !== null && BigInt(comparacion.periodo) <= ultimoPeriodo) {
      return { ok: false, motivo: 'reutilizado' };
    }

    // El `UPDATE` condicionado a `mfa_ultimo_periodo` anterior cierra la carrera
    // entre dos verificaciones concurrentes del mismo código: si otra ya lo
    // consumió, el `where` no matchea y el count es 0.
    const actualizado = await this.prisma.idn_usuario.updateMany({
      where: {
        idusuario,
        OR: [
          { mfa_ultimo_periodo: null },
          { mfa_ultimo_periodo: { lt: BigInt(comparacion.periodo) } },
        ],
      },
      data: { mfa_ultimo_periodo: BigInt(comparacion.periodo) },
    });

    if (actualizado.count === 0) {
      return { ok: false, motivo: 'reutilizado' };
    }

    return {
      ok: true,
      metodo: 'totp',
      periodo: comparacion.periodo,
      codigos_restantes: await this.contarCodigos(idusuario),
    };
  }

  /**
   * Código de recuperación: un solo uso, con la comparación en dos pasos para que
   * la fila no quede marcada si el código no era el.
   *
   * El hash lleva sal de usuario (`sha256(codigo + idusuario)`, `specs/01` §8.5),
   * así que la búsqueda por hash ya trae el usuario adentro: no hace falta
   * filtrar por `idusuario`, y un `codigo_hash` que no existe da `null` en vez de
   * un código de otro usuario.
   */
  private async verificarCodigoRecuperacion(
    idusuario: string,
    codigo: string,
    ahora: Date,
  ): Promise<ResultadoVerificacionMfa> {
    const normalizado = normalizarCodigo(codigo);

    if (normalizado === null) {
      return { ok: false, motivo: 'codigo_incorrecto' };
    }

    const fila = await this.prisma.idn_usuario_mfa_codigo.findFirst({
      where: { codigo_hash: this.hashDeCodigo(normalizado, idusuario), usado_en: null },
      select: { id: true },
    });

    if (!fila) {
      return { ok: false, motivo: 'codigo_incorrecto' };
    }

    const consumido = await this.prisma.idn_usuario_mfa_codigo.updateMany({
      where: { id: fila.id, usado_en: null },
      data: { usado_en: ahora },
    });

    if (consumido.count === 0) {
      // Otra petición lo consumió entre el SELECT y el UPDATE.
      return { ok: false, motivo: 'reutilizado' };
    }

    return {
      ok: true,
      metodo: 'recuperacion',
      periodo: null,
      codigos_restantes: await this.contarCodigos(idusuario),
    };
  }

  /** Códigos sin usar de un usuario. */
  async contarCodigos(idusuario: string): Promise<number> {
    return this.contarVigentes(idusuario);
  }

  private async contarVigentes(idusuario: string): Promise<number> {
    return this.prisma.idn_usuario_mfa_codigo.count({ where: { idusuario, usado_en: null } });
  }

  /**
   * `sha256(codigo_normalizado + idusuario)`.
   *
   * La sal es el `idusuario`, que es público (viaja en el claim `sub`), y eso es
   * deliberado: con una sal aleatoria por código habría que guardarla y el
   * `UPDATE` condicionado del uso se vuelve más caro. Lo que gana la sal de
   * usuario es que **el hash de un código no sirve para buscarlo en otra
   * columna**: los 10 códigos de Juan no tienen el mismo hash que los de Ana ni
   * que ninguna tabla precalculada, que es el ataque de verdad contra un sha256
   * pelado de 48 bits.
   */
  hashDeCodigo(codigo: string, idusuario: string): string {
    return createHash('sha256').update(`${codigo}${idusuario}`, 'utf8').digest('hex');
  }

  private generarListaDeCodigos(): string[] {
    return Array.from({ length: CANTIDAD_CODIGOS }, () => generarCodigoRecuperacion());
  }

  /**
   * Invalida los códigos sin usar y crea `CANTIDAD_CODIGOS` nuevos, en la misma
   * transacción. Devuelve los **en claro**: es la única vez que existen, y el
   * que llama los muestra una vez (`specs/01` §8.5).
   *
   * Invalidar en vez de borrar es lo que hace que la fila siga siendo evidencia
   * de que ese usuario tuvo códigos y de cuándo, y evita el `DELETE` (que en
   * esta tabla sería la única cosa que borra el backend, y sólo por edad lo hace
   * el job).
   */
  private async reemplazarCodigos(
    tx: Prisma.TransactionClient,
    idusuario: string,
    ahora: Date,
  ): Promise<string[]> {
    const codigos = this.generarListaDeCodigos();

    await tx.idn_usuario_mfa_codigo.updateMany({
      where: { idusuario, usado_en: null },
      data: { usado_en: ahora },
    });

    for (const codigo of codigos) {
      await tx.idn_usuario_mfa_codigo.create({
        data: {
          idusuario,
          codigo_hash: this.hashDeCodigo(codigo, idusuario),
          creado_en: ahora,
        },
      });
    }

    return codigos;
  }

  /**
   * Regenera los códigos de recuperación **sin tocar el secret** ni el estado.
   *
   * La diferencia con `activar` es la que importa y no es cosmética: `activar`
   * genera un secret nuevo y deja el MFA en `pending`, así que un usuario con la
   * app ya configurada se quedaría sin acceso al confirmar. Regenerar códigos
   * es la operación de "se perdieron o se filtraron", y su única consecuencia
   * tiene que ser que los anteriores dejan de servir.
   *
   * `mfa_ultimo_periodo` **no** se toca: el secret no cambió, así que el
   * contador anti-reuso sigue siendo válido y reiniciarlo haría que un código
   * TOTP de hace 2 segundos volviera a ser aceptable.
   */
  async regenerarCodigos(idusuario: string, ahora: Date = new Date()): Promise<string[]> {
    const usuario = await this.prisma.idn_usuario.findUnique({
      where: { idusuario },
      select: { idusuario: true },
    });

    if (!usuario) {
      throw new Error(`El usuario ${idusuario} no existe.`);
    }

    const codigos = await this.prisma.$transaction((tx) => this.reemplazarCodigos(tx, idusuario, ahora));

    this.logger.log(
      `codigos de recuperacion regenerados para ${idusuario.slice(0, 8)} (${codigos.length}); ` +
        'los anteriores quedan invalidos',
    );

    return codigos;
  }
}
