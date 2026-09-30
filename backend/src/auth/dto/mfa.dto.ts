import { IsString, IsUUID, Length, Matches, MaxLength } from 'class-validator';

/**
 * DTOs del segundo factor del login (`specs/01` §8.2).
 *
 * `factor_id` va con `@IsUUID()` y no como `string`: es la PK de
 * `tok_mfa_challenge` y un valor con otra forma es un pedido mal formado, que es
 * 400 y no un "código inválido" de 401. La distinción importa porque el 400 dice
 * "tu programa está mal" y el 401 "volvé a entrar": con un `string` y un `find`
 * al final, un `factor_id` vacío daba el mismo 401 que uno vencido, y el
 * integrador no tenía forma de saber que era un bug suyo.
 *
 * `codigo` acepta las dos formas del segundo factor (6 dígitos de TOTP o un
 * código de recuperación de 10) y por eso el rango es 6 a 20 y no uno exacto. El
 * backend decide por la **forma** (`/^\d{6}$/` y, si no, código de recuperación) y
 * no probando las dos.
 *
 * Lo que **no** viaja acá: usuario, cliente ni `returnTo`. Los tres se resuelven
 * en el paso 1 y se leen de la fila del desafío (invariante de `AGENTS.md`: el
 * `tenant` no se deduce de un parámetro).
 */
export class VerificarMfaDto {
  @IsUUID('4', { message: 'factor_id: debe ser el UUID que devolvio el login' })
  factor_id!: string;

  @IsString()
  @Length(1, 20)
  @MaxLength(20)
  codigo!: string;
}

/**
 * `POST /me/mfa/confirmar`: el código con el que el usuario confirma su
 * enrolamiento (`specs/01` §8.1).
 *
 * **Sólo 6 dígitos, y no "6 o 10".** A diferencia de la verificación del login,
 * acá el código de recuperación no sirve: confirmar con uno dejaría el MFA
 * activo en una cuenta cuya app de autenticación nunca se configuró, y el
 * usuario se enteraría en el próximo ingreso, cuando ya no hay nadie a quien
 * preguntarle. La diferencia de forma entre los dos endpoints es deliberada.
 */
export class ConfirmarMfaDto {
  @IsString()
  @Matches(/^\d{6}$/, { message: 'codigo: los 6 digitos que muestra la app de autenticacion' })
  codigo!: string;
}
