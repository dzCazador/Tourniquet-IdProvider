import { IsString, Length, Matches } from 'class-validator';

/**
 * `POST /operacion/claves/reactivar`: qué clave volver a dejar activa
 * (`specs/01` §5.1).
 *
 * El `kid` con `@Matches(/^[0-9a-f]{16}$/)` y no un `@IsString()` pelado, porque
 * el `kid` **no** es un texto libre: lo genera `FirmaService.calcularKid` como
 * los primeros 16 hex del sha256 del SPKI DER. Aceptar cualquier string y dejar
 * que la base decida significa una consulta con basura; y un `kid` mal formado es
 * un pedido mal formado, que es 400 y no un 500 del motor.
 *
 * Sin trim: el `kid` no lleva espacios, y un `kid` con un espacio al final es
 * un error de tipeo que tiene que verse, no algo que se "arregle" en silencio.
 */
export class ReactivarClaveDto {
  @IsString()
  @Length(16, 16, { message: 'kid: son 16 caracteres hexadecimales (specs/01 §5)' })
  @Matches(/^[0-9a-f]{16}$/, { message: 'kid: tiene que ser el kid del JWKS, en minuscula' })
  kid!: string;
}
