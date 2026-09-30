/**
 * Movimiento del portal (`estetica-tourniquet.md` §6).
 *
 * **Pesado y lento, con sensación de masa**: 400-700 ms con
 * `cubic-bezier(0.2, 0.8, 0.2, 1)`. La sensacion de masa viene de la curva, no de
 * la duracion sola: una transicion lineal de 600 ms se siente como una barra de
 * carga, y la misma duracion con esta curva se siente como algo que se detiene.
 *
 * El archivo es la fuente unica de los numeros, y `aplicarMovimiento` es la forma
 * de usarlos. Existe para que "con `prefers-reduced-motion` no hay animaciones" no
 * dependa de que cada componente se acuerde de escribir `motion-safe:`: la funcion
 * lo antepone, asi que un `aplicarMovimiento('anillo-entra')` queda quieto si el
 * sistema pide menos movimiento, sin que nadie tenga que decidir eso en el JSX.
 *
 * Tailwind resuelve la preferencia con el variante `motion-safe:`, que es un
 * `@media (prefers-reduced-motion: no-preference)`: la hoja de estilos compilada
 * lleva la consulta, asi que en un export estatico no hay nada que decidir en
 * runtime.
 */
export const CURVA = 'cubic-bezier(0.2, 0.8, 0.2, 1)';

export const DURACION = {
  /** Cambio de color de un control en hover o focus. Lo unico que queda con `reduce`. */
  estado: 150,
  /** Cambio de una lamina o de un panel. */
  media: 400,
  /** Entrada de pagina: el anillo se cierra. */
  anillo: 600,
  /** La mancha de tinta, en loop. Es la unica animacion en loop del producto. */
  tinta: 900,
} as const;

/**
 * Clases de una animacion, ya con el guarda de `prefers-reduced-motion`.
 *
 * `nombre` es una clave de `ANIMACIONES` y no una clase suelta: es lo que impide
 * que un componente se invente un `animate-[wiggle_1s]` que no existe en el tema y
 * que nadie va a poder apagar con la preferencia del sistema.
 */
export function aplicarMovimiento(nombre: keyof typeof ANIMACIONES): string {
  return `motion-safe:${ANIMACIONES[nombre]}`;
}

/**
 * Las animaciones del tema, y solo estas.
 *
 * Cada una dice que se mueve y cuanto:
 *
 *   - `anillo-entra`: el anillo de la cabecera se "cierra" al cargar la pagina
 *     (escala 0.96 -> 1 con un desenfoque de 2 px). Una sola vez, 600 ms, y **el
 *     texto no se anima**: el texto entra de golpe, sin transicion, para que nadie
 *     espere a leerlo.
 *   - `tinta`: la mancha de tinta que se expande mientras espera una operacion. Es
 *     la unica que se repite, y no va acompanada de skeletons: un skeleton esconde
 *     el layout justo cuando el usuario esta mirando donde va a aparecer el error.
 *   - `sello`: el sello de lacre que se cierra al abrir una sesion, y al abrirse
 *     cuando esa sesion se cierra. 400 ms.
 */
export const ANIMACIONES = {
  'anillo-entra': 'animate-[tourniquet-anillo_600ms_cubic-bezier(0.2,0.8,0.2,1)_both]',
  'tinta': 'animate-[tourniquet-tinta_900ms_ease-in-out_infinite]',
  'sello': 'animate-[tourniquet-sello_400ms_cubic-bezier(0.2,0.8,0.2,1)_both]',
} as const;

/**
 * Los tres `@keyframes` viven en `globals.css`, no aca.
 *
 * Injectarlos desde TS exigiria un `<style>` en el `layout`, y eso mete **estilo
 * inline** en un portal que hoy no tiene ninguno: en un export estatico la hoja de
 * estilos es un `.css` enlazado, y un despliegue que agregue una CSP con
 * `style-src 'self'` bloquearia el tag y se perderian las tres animaciones (con el
 * resto del tema intacto, que es el peor sintoma posible: "anda todo menos el
 * movimiento"). Ademas los numeros estan duplicados en `DURACION` de este archivo
 * y en la duracion de cada regla, asi que la unica forma de que no se separen es
 * decir en los dos lugares que estan calados el uno contra el otro — que es lo que
 * hace el comentario de `globals.css`.
 */

/**
 * Si el sistema pide menos movimiento.
 *
 * Va en el `useEffect`, no en el render: en un export estatico no hay SSR que
 * considere, pero el valor tiene que leerse **en el cliente** y en un momento
 * concreto. Se usa solo donde la decision cambia comportamiento y no estilo —hoy,
 * en ningún lado: las animaciones las apaga Tailwind— así que queda disponible
 * para el caso en que aparezca uno, en vez de ir a buscar el `matchMedia` otra vez.
 */
export function respetaMovimiento(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
