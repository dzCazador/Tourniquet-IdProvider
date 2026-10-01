import { Controller, Get, Header } from '@nestjs/common';
import { ACENTO_POR_ESTETICA, MarcaService, type Marca } from './marca.service';

/**
 * `GET /marca`.
 *
 * **Es el unico endpoint publico del IdP que no es de OIDC**, y por eso tiene su
 * propio modulo (`marca/`) en vez de vivir en `registro/`: ahi todo lo que se
 * expone es de lectura con sesion, y `tenant` sale de la sesion y nunca del
 * pedido. Aca no hay sesion todavia -- es la pantalla de ingreso, la primera
 * pagina que ve un empleado que no se ha logueado nunca -- y no la hay por
 * construccion, no por excepcion.
 *
 * Que sea publico no significa que devuelva el registro: devuelve **el nombre
 * con el que se pinta la pagina y el tema**. El `codigo` del cliente NO viaja, y
 * la lista de clientes tampoco. Lo que el portal muestra antes de la sesion es
 * decoracion de marca; lo que el portal muestra despues sale de `/me`, con el
 * `tenant` validado desde el token (invariante de `AGENTS.md`).
 */
@Controller('marca')
export class MarcaController {
  constructor(private readonly marca: MarcaService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  leer(): Promise<Marca & { acento: string }> {
    return this.marca.leer().then((marca) => ({
      ...marca,
      /**
       * Acento resuelto, no solo el declarado: el portal no tiene por que
       * conocer la tabla de la estetica, y si el `color_acento` guardado no es un
       * hex valido el backend ya lo haya descartado.
       */
      acento: marca.tema.color_acento ?? ACENTO_POR_ESTETICA[marca.tema.estetica],
    }));
  }
}
