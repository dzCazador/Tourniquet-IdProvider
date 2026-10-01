import { API_URL } from './api';
import { ESTETICAS, acentoPorEstetica, type Estetica } from '@/design/tokens';

/**
 * La marca de la instalacion: como se llama y con que acento se pinta el portal.
 *
 * Viene de `GET /marca` (`backend/src/marca/`), que es publico **a proposito**:
 * la pantalla de ingreso es lo primero que ve un empleado que nunca se ha
 * logueado, y en ese momento no hay sesion de la que sacar el nombre del cliente.
 *
 * Lo que el endpoint devuelve es lo minimo para pintar una pagina —el nombre y el
 * tema— y nunca el `codigo` del cliente ni la lista de clientes. Lo que el
 * portal muestra **despues** del ingreso sale de `/me`, con el `tenant` leido del
 * token (invariante de `AGENTS.md`).
 *
 * Este archivo es el cliente HTTP y los tipos; aplicar el tema al DOM es de
 * `design/marca.tsx`, que es donde estan los tokens.
 */

/** El nombre del producto. No es configurable: es de Tourniquet, no del cliente. */
export const PRODUCTO = 'Tourniquet';

export interface TemaMarca {
  estetica: Estetica;
  /**
   * Acento ya resuelto por el backend, en `#rrggbb`. Viene resuelto y no en
   * crudo a proposito: el backend es quien conoce el acento de cada estetica y
   * quien descarta un valor que no sea un hex, asi que el navegador no vuelve a
   * validar nada y no hay dos lugares con la misma lista de valores validos.
   */
  color_acento: string;
}

export interface Marca {
  /** `cat_cliente.nombre`, o `null` si la instalacion no declara un unico cliente. */
  cliente: string | null;
  tema: TemaMarca;
}

/**
 * Lo que se dibuja mientras `/marca` no respondio, y tambien lo que se dibuja si
 * no responde nunca.
 *
 * **El tema del producto, no un estado de error.** Un IdP que al fallar la
 * consulta de marca muestra un error en la pantalla de ingreso le esta
 * diciendo al empleado que el sistema esta caido cuando lo que puede estar caido
 * es un dato de decoracion. La pantalla de ingreso tiene que funcionar con o
 * sin marca: es la unica que se ve sin sesion, y es justamente la que hace falta
 * cuando algo anda mal.
 *
 * El nombre cae a la marca del producto por la misma razon, y con la misma
 * consecuencia: un login que muestra "Tourniquet" en vez del nombre del cliente
 * es un login que anda. Se avisará en la consola para que el que administra lo
 * vea, y no en la pantalla.
 */
export const MARCA_POR_DEFECTO: Marca = {
  cliente: null,
  tema: { estetica: 'gothic', color_acento: acentoPorEstetica.gothic },
};

/**
 * Un `#rrggbb` y nada mas.
 *
 * El backend ya lo valida (`esHexEstricto`) y por eso esto es una segunda
 * barrera, no la primera. Se repite en el cliente porque el valor termina en
 * `style.setProperty` y esa es la ultima linea de defensa: una variable CSS mal
 * formada no rompe la pagina de forma visible, rompe cosas en silencio y en
 * cualquier navegador que no sea el que se probo. Un tema raro tiene que verse
 * como un tema raro, no como un portal sin pintar.
 */
function esHex(valor: unknown): valor is string {
  return typeof valor === 'string' && /^#[0-9a-f]{6}$/i.test(valor);
}

function normalizar(bruto: unknown): Marca {
  if (bruto === null || typeof bruto !== 'object') {
    return MARCA_POR_DEFECTO;
  }

  const dato = bruto as Record<string, unknown>;
  const tema = (dato.tema ?? {}) as Record<string, unknown>;
  const estetica: Estetica = ESTETICAS.includes(tema.estetica as Estetica)
    ? (tema.estetica as Estetica)
    : MARCA_POR_DEFECTO.tema.estetica;

  const acento = esHex(tema.color_acento)
    ? (tema.color_acento as string).toLowerCase()
    : acentoPorEstetica[estetica];

  const cliente = typeof dato.cliente === 'string' && dato.cliente.trim() !== '' ? dato.cliente.trim() : null;

  return { cliente, tema: { estetica, color_acento: acento } };
}

/**
 * `GET /marca`. **Nunca tira**: un fallo de red devuelve la marca por defecto.
 *
 * `cache: 'no-store'` por el mismo motivo que el resto de los pedidos de
 * `api.ts`: el export es estatico y el que decide el cache es el web server del
 * cliente. Un `/marca` cacheado por el navegador es un cliente que renombro su
 * empresa y sigue viendo el nombre viejo en la pantalla de ingreso hasta que
 * expire la entrada.
 */
export async function leerMarca(): Promise<Marca> {
  try {
    const respuesta = await fetch(`${API_URL}/marca`, {
      credentials: 'omit',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });

    if (!respuesta.ok) {
      throw new Error(`HTTP ${respuesta.status}`);
    }

    return normalizar(await respuesta.json());
  } catch (error) {
    // A la consola y no a la pantalla. Ver la nota de `MARCA_POR_DEFECTO`.
    console.warn('[tourniquet] no se pudo leer /marca; se usa la marca del producto.', error);
    return MARCA_POR_DEFECTO;
  }
}
