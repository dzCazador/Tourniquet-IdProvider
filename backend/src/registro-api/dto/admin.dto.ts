import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  Matches,
  ValidateIf,
} from 'class-validator';
import { MOTIVOS_ADMIN } from '../../oidc/sesion.service';

/**
 * DTOs del panel `admin_identidad` (Fase 08).
 *
 * Todos con `class-validator` y el `ValidationPipe` global (`whitelist: true`,
 * `forbidNonWhitelisted: true`): un campo que no este en el DTO **no llega al
 * servicio**, y eso es lo que impide que un POST con `{ "rol": "admin_identidad" }`
 * termine tocando una columna de rol. `forbidNonWhitelisted` ademas hace que el
 * error diga que campo sobra, que es la forma de que un cliente mal programado se
 * entere en el desarrollo y no en produccion.
 *
 * El `usuario` se valida con la misma forma que el login (`[a-z0-9._-]`, 3-50), y en
 * **minusculas**: el login normaliza con `normalizarUsuario` y el indice unico es
 * sobre el valor normalizado, asi que un alta con mayusculas crearia una fila que
 * nadie podria usar para entrar.
 */
const FORMATO_USUARIO = /^[a-z0-9._-]+$/;

export class AltaUsuarioDto {
  @IsString()
  @Length(3, 50)
  @Matches(FORMATO_USUARIO, { message: 'usuario: solo [a-z0-9._-], en minuscula' })
  usuario!: string;

  @IsString()
  @Length(1, 100)
  nombre!: string;

  @IsString()
  @Length(0, 100)
  apellido!: string;

  @IsOptional()
  @IsEmail({}, { message: 'email: no parece una direccion de correo' })
  @MaxLength(200)
  email?: string;

  /**
   * Apps a las que queda habilitado de entrada. Se validan contra el **tenant del
   * admin** en el servicio, no contra `cat_aplicacion`: habilitar a alguien en una
   * app que no existe para su cliente no es un error de validacion de entrada, es
   * una peticion que no se puede cumplir, y la respuesta tiene que poder distinguir
   * "no existe" de "no te corresponde".
   */
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @Matches(FORMATO_USUARIO, { each: true, message: 'aplicaciones: solo [a-z0-9._-]' })
  aplicaciones!: string[];

  /**
   * Generar clave temporal y entregarla **una vez**.
   *
   * El default es `true` porque el alta sin clave deja un usuario que no puede
   * entrar, y un admin que escribe la clave en el formulario la manda en claro por
   * la red (trampa 3 de la fase 08). `false` esta para el caso real de una
   * integracion que ya tiene el hash: entonces el admin manda el hash, no la clave.
   */
  @IsOptional()
  @IsBoolean()
  claveTemporal?: boolean;

  /**
   * Pisar `nombre`, `apellido` y `email` de un usuario que ya existe.
   *
   * Es **opt-in explicito** (criterio de aceptacion de la 08): sin esto, dar de
   * alta a alguien que ya existe en otro cliente devuelve 409 y no toca nada. Con
   * esto, el admin dice "si, quiero que su nombre sea este", que es una decision
   * distinta de "crear el usuario".
   */
  @IsOptional()
  @IsBoolean()
  sobrescribirDatos?: boolean;
}

export class EditarUsuarioDto {
  @IsOptional()
  @IsString()
  @Length(1, 100)
  nombre?: string;

  @IsOptional()
  @IsString()
  @Length(0, 100)
  apellido?: string;

  @IsOptional()
  @IsEmail({}, { message: 'email: no parece una direccion de correo' })
  @MaxLength(200)
  email?: string;

  /**
   * `activo` o `inactivo`. **No** `bloqueado`: ese estado es del sistema (intentos
   * fallidos, `specs/01` §4) y un admin que pone `bloqueado` deja el contador y el
   * `bloqueado_hasta` en un estado que no corresponde con el motivo.
   */
  @IsOptional()
  @IsIn(['activo', 'inactivo'], { message: 'estado: solo activo|inactivo' })
  estado?: 'activo' | 'inactivo';
}

export class CierreSesionDto {
  /**
   * Motivo **obligatorio** (fase 08 §5). El `@ValidateIf` no hace falta: el campo no
   * es opcional y `@IsIn` con la lista de `MOTIVOS_ADMIN` es la unica fuente de la
   * verdad, que es la misma que el CHECK de la base.
   */
  @IsString()
  @IsIn(MOTIVOS_ADMIN as unknown as string[], {
    message: `motivo: uno de ${MOTIVOS_ADMIN.join(', ')}`,
  })
  motivo!: (typeof MOTIVOS_ADMIN)[number];
}

export class ListadoUsuariosDto {
  @IsOptional()
  @Type(() => Number)
  pagina?: number;

  @IsOptional()
  @Type(() => Number)
  por_pagina?: number;

  /**
   * Busqueda por `usuario`, `nombre` o `apellido`.
   *
   * El largo maximo de 100 es el de las columnas: sin tope, un `contains` con 4 KB
   * es una consulta que va a la base y vuelve vacia, y alguien que lo haga a mano
   * para probar tiene que esperar el timeout entero.
   */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  /**
   * `todos` (default), `activos` o `inactivos`. Se llama `estado` y no
   * `filtro_estado` porque es el mismo dominio de `idn_usuario.estado`.
   */
  @IsOptional()
  @IsIn(['todos', 'activo', 'inactivo'])
  estado?: 'todos' | 'activo' | 'inactivo';
}

export class ListadoAuditoriaDto {
  @IsOptional()
  @Type(() => Number)
  pagina?: number;

  @IsOptional()
  @Type(() => Number)
  por_pagina?: number;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  usuario?: string;

  @IsOptional()
  @IsIn(['ok', 'claves', 'bloq', 'replay', 'expirado', 'error'])
  resultado?: 'ok' | 'claves' | 'bloq' | 'replay' | 'expirado' | 'error';

  @IsOptional()
  @IsString()
  @MaxLength(500)
  detalle?: string;

  @ValidateIf((o: ListadoAuditoriaDto) => o.desde !== undefined)
  @IsString()
  desde?: string;

  @ValidateIf((o: ListadoAuditoriaDto) => o.hasta !== undefined)
  @IsString()
  hasta?: string;
}
