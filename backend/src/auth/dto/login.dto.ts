import { IsOptional, IsString, Length, MaxLength } from 'class-validator';

/**
 * Cuerpo de `POST /auth/login`.
 *
 * `whitelist: true` + `forbidNonWhitelisted: true` (globales en `main.ts`)
 * hacen que un campo de mas sea un 400, no algo que se ignora en silencio.
 * Conviene: un cliente que mande `returnTo` a un typo deberia enterarse.
 */
export class LoginDto {
  /**
   * Se valida la FORMA y nada mas. Que el usuario exista, y si esta bloqueado,
   * lo decide `IdentidadService`; el error de uno u otro es el mismo
   * (`clave_incorrecta`) para que el endpoint no sea un oraculo de cuentas.
   *
   * El limite de 50 es el de `idn_usuario.usuario` (`specs/02`): mas largo no
   * puede existir, y recortarlo en silencio haria que dos entradas distintas
   * dieran el mismo error de forma distinta.
   */
  @IsString()
  @Length(1, 50)
  usuario!: string;

  /**
   * Sin limite inferior que signifique algo: la politica de clave es de
   * CREACION (`specs/01` §4), no de verificacion. Un piso de 10 aca rechazaria
   * por DTO una clave vieja corta antes de gastar el argon2, y la respuesta
   * seria distinta de la de "clave incorrecta" -- o sea, un canal lateral.
   * Solo se corta lo patologico.
   */
  @IsString()
  @Length(1, 512)
  clave!: string;

  /**
   * A donde vuelve el usuario. Lo produce `GET /oidc/authorize` y lo valida
   * `validarReturnTo` (origen exacto + path exacto), no el navegador.
   */
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  returnTo?: string;

  /**
   * Cliente (tenant) elegido, en el **segundo** intento.
   *
   * Solo lo manda el portal cuando el backend respondio `cliente_ambiguo`: un
   * usuario con membresias en varios clientes tiene que contestar cual es, y el
   * `tenant` de la sesion sale de aca. Viene **despues** de verificar la clave a
   * proposito: mandar el tenant en el primer POST permitiria elegir el cliente
   * sin haberse autenticado, y probing de que clientes existen ajenos.
   *
   * El limite de 20 es el de `cat_cliente.codigo` (`specs/02`).
   */
  @IsOptional()
  @IsString()
  @MaxLength(20)
  cliente?: string;
}
