import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Esteticas que el portal sabe pintar. Lista CERRADA a proposito: `estetica-tourniquet.md`
 * §11 describe exactamente dos y la austera tiene su acento por defecto medido. Un
 * valor desconocido no es un tema nuevo, es una instalacion mal configurada, y
 * tratarlo como un tema nuevo seria dejarle al cliente una pantalla que nadie
 * midio.
 */
export type Estetica = 'gothic' | 'austero';

export const ESTETICAS: readonly Estetica[] = ['gothic', 'austero'];

/**
 * Acento por defecto de la estetica austera, en `#rrggbb`.
 *
 * **No es una eleccion estetica, es una eleccion de contraste**, y los numeros
 * estan medidos con la misma funcion que usa el portal (`frontend/src/design/contraste.ts`):
 *
 *   - `pergamino` (el texto del boton principal) sobre el acento: **5.63:1**, AA
 *     de texto normal (4.5) con margen. Es la restriccion dura: el boton primario
 *     esta hecho de `bg-oxblood text-pergamino`, asi que un acento que baje de
 *     4.5:1 rompe el texto del boton de todos los clientes austeros a la vez.
 *   - el acento sobre `tinta`: **3.01:1**, que es el umbral de SC 1.4.11 para
 *     bordes e iconos que significan algo. El acento gótico da 1.80:1 y por eso
 *     esta declarado decorativo y nunca es texto; el austero llega al umbral sin
 *     tener que recordar ese usos.
 *
 * Con mas contraste que el gótico y el mismo resto de la paleta, la austera
 * cumple la promesa de §11 ("la misma estructura y los mismos contrastes").
 */
export const ACENTO_AUSTERO = '#41607e';

export interface TemaCliente {
  estetica: Estetica;
  /**
   * Acento en `#rrggbb`, o `null` para el de la estetica. Nunca sale del regex de
   * `esHex`: el valor viaja a una variable CSS en el navegador de cada empleado y
   * cualquier cosa que no sea un hex de seis digitos es un vector de inyeccion de
   * estilo.
   */
  color_acento: string | null;
}

export interface Marca {
  /**
   * `cat_cliente.nombre` de la instalacion, o `null`.
   *
   * `null` cuando la base no declara un unico cliente activo, y el portal dibuja
   * el wordmark del producto. Ver `leer()` para por que no se devuelve la lista.
   */
  cliente: string | null;
  tema: TemaCliente;
}

/** Tema del producto. Se usa cuando no hay cliente, o cuando no se declaro tema. */
export const TEMA_POR_DEFECTO: TemaCliente = { estetica: 'gothic', color_acento: null };

/** Acento que corresponde a cada estetica, para el portal. */
export const ACENTO_POR_ESTETICA: Record<Estetica, string> = {
  gothic: '#7a0f16',
  austero: ACENTO_AUSTERO,
};

/**
 * Un color es aceptable si y solo si son seis digitos hexadecimales con `#`.
 *
 * Tres cosas motivan el regex y ninguna es paranoia:
 *
 *   1. El valor sale del **contenido de una columna** que escribe una persona
 *      con un `.sql`, no de un archivo de codigo. Es entrada de usuario.
 *   2. Termina en una variable CSS que el navegador aplica a toda la pagina. Un
 *      valor con `;`, `}` o `url(...)` no es "un color raro": es CSS arbitrario
 *      inyectado en el IdP de una empresa.
 *   3. Aceptar `#rgb` o `#rrggbbaa` abre la puerta a que el valor tenga que
 *      coincidir byte a byte con lo que el navegador normaliza, y ese tipo de
 *      diferencia se descubre en pantalla, no en el log.
 *
 * Mayusculas y minusculas si se aceptan, y el valor sale en minusculas: `#7A0F16`
 * es un color tan valido como `#7a0f16` y es como lo copia cualquiera de un
 * selector de color. Rechazarlo seria hacer que un valor correcto se ignorara en
 * silencio, que es la peor forma de fallar.
 */
export function esHexEstricto(valor: unknown): valor is string {
  return typeof valor === 'string' && /^#[0-9a-f]{6}$/i.test(valor);
}

function temaDePolitica(politicaJson: string | null): TemaCliente {
  if (politicaJson === null || politicaJson.trim() === '') {
    return TEMA_POR_DEFECTO;
  }

  let politica: unknown;
  try {
    politica = JSON.parse(politicaJson);
  } catch {
    // No se tira. `politica_json` es JSON libre y versionable (`specs/02` §3) y
    // un typo en una columna tiene que dejar el portal en el tema por defecto
    // funcionando, no dejar al cliente sin pantalla de ingreso. El aviso va al
    // log del servidor, que es donde lo va a ver quien administra.
    new Logger(MarcaService.name).warn(
      'cat_cliente.politica_json no es JSON valido: se usa el tema por defecto. ' +
        'Revisar la columna antes de dar por buena la instalacion.',
    );
    return TEMA_POR_DEFECTO;
  }

  if (politica === null || typeof politica !== 'object' || Array.isArray(politica)) {
    return TEMA_POR_DEFECTO;
  }

  const tema = (politica as Record<string, unknown>).tema;
  if (tema === null || typeof tema !== 'object' || Array.isArray(tema)) {
    return TEMA_POR_DEFECTO;
  }

  const crudo = tema as Record<string, unknown>;
  const estetica: Estetica = ESTETICAS.includes(crudo.estetica as Estetica)
    ? (crudo.estetica as Estetica)
    : TEMA_POR_DEFECTO.estetica;

  // El acento se valida **por separado** de la estetica, y a proposito: un
  // cliente que escribe `{"estetica":"neon","color_acento":"#123456"}` quiere un
  // color, y el color es valido. La estetica elige el acento por default; cuando
  // hay un `color_acento` explicito, manda el explicito.
  const acento = esHexEstricto(crudo.color_acento)
    ? (crudo.color_acento as string).toLowerCase()
    : null;

  if (crudo.color_acento !== undefined && crudo.color_acento !== null && acento === null) {
    new Logger(MarcaService.name).warn(
      'cat_cliente.politica_json.tema.color_acento no es un #rrggbb: se ignora y ' +
        'se usa el acento de la estetica.',
    );
  }

  return { estetica, color_acento: acento };
}

@Injectable()
export class MarcaService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * La marca de la instalacion: como se llama y con que tema se pinta.
   *
   * **Por que NO devuelve una lista de clientes.** D3 de `specs/00` es una
   * instancia por cliente: donde va Chile solo hay base de Chile. Este es el unico
   * endpoint publico del IdP, y un endpoint publico que devuelve la lista de
   * clientes de una instalacion seria un directorio de tenants publicado sin
   * autenticacion. Asi que se toma `take: 2` y:
   *
   *   - exactamente un cliente activo -> es el de la instalacion;
   *   - cero o dos o mas -> `cliente: null` y tema por defecto.
   *
   * En el caso de varios se elige **no mostrar ninguno** y no el primero: una
   * instancia con dos clientes activos es una instalacion mal hecha, y publicar
   * el nombre de uno de los dos seria publicar el de un cliente a quien esta
   * mirando la pantalla de ingreso del otro.
   *
   * Sin cache a proposito: es una lectura indexada de una tabla de una fila, y un
   * TTL de cache aca significaria que un cambio de tema en `cat_cliente` tarda en
   * verse, que es exactamente la clase de sorpresa que un runbook de rollback no
   * necesita.
   */
  async leer(): Promise<Marca> {
    const clientes = await this.prisma.cat_cliente.findMany({
      where: { estado: 'activo' },
      select: { nombre: true, politica_json: true },
      orderBy: { codigo: 'asc' },
      take: 2,
    });

    if (clientes.length !== 1) {
      if (clientes.length > 1) {
        new Logger(MarcaService.name).warn(
          `La instalacion tiene ${clientes.length} clientes activos y D3 es una ` +
            'instancia por cliente: /marca no muestra ninguno y el portal usa la ' +
            'marca del producto. Revisar cat_cliente.estado.',
        );
      }
      return { cliente: null, tema: TEMA_POR_DEFECTO };
    }

    return {
      cliente: clientes[0].nombre,
      tema: temaDePolitica(clientes[0].politica_json),
    };
  }
}
