import { IsString, Length } from 'class-validator';

/**
 * `POST /me/cliente-activo`: que cliente queda activo para el lanzador.
 *
 * El nombre del campo es `cliente` y no `idcliente` porque es lo que el usuario
 * elige, no un identificador de base de datos: el front lo manda desde el selector
 * de membresías, donde lo que hay en pantalla es un nombre de cliente.
 *
 * El largo es el de `cat_cliente.codigo` (`specs/02` §3), y **no** hay validación
 * de formato: la comparación de códigos de cliente es exacta en todo el repo (el
 * login no normaliza mayúsculas), así que un patrón de charset acá daría un 400 a
 * un cliente legítimo cuyo código no entre — y un 400 que dice "el formato no es
 * válido" en lugar del 403 que corresponde ("no sos miembro de ese cliente").
 */
export class ClienteActivoDto {
  @IsString()
  @Length(1, 20)
  cliente!: string;
}
