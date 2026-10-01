import { AA_NO_TEXTO, AA_TEXTO_NORMAL, contraste, rgba } from './contraste';

/**
 * Tokens del portal. FUENTE UNICA de valores: ningun componente escribe un hex
 * suelto (`estetica-tourniquet.md` §10).
 *
 * El color vive en dos lugares y solo en dos: este archivo (para TS) y las
 * variables CSS que `globals.css` deriva de el (para Tailwind). No hay una
 * tercera copia, y por eso cambiar un acento por cliente (spec §11) es cambiar
 * una linea aca.
 */

/**
 * Paleta de `estetica-tourniquet.md` §4, con los valores **medidos**, no los
 * que el documento decia antes de la Fase 04. La columna `contraste` de cada
 * par es el valor real devuelto por `contraste()`; los comentarios con "AA" son
 * los que cumplen el umbral, y estan ahi para que un cambio de color sin
 * recalcular se note en la revision en vez de en el auditor de accesibilidad.
 */
export const color = {
  /** Fondo de pagina. */
  tinta: '#0a0a0c',
  /** Fondo de panel y de campo. Decorativo contra `tinta` (1.06:1). */
  'tinta-alta': '#121216',
  /** Bordes faibles y separadores. Decorativo (1.17:1). */
  hierro: '#1c1c22',
  /** Borde de control y texto secundario fuerte. 12.29:1 sobre `tinta`, AA. */
  plata: '#c8ccd4',
  /** Texto de cuerpo. 15.34:1 sobre `tinta`, AA. */
  hueso: '#e8e2d6',
  /** Texto sobre `oxblood`. 16.95:1 sobre `tinta`, 9.44:1 sobre `oxblood`, AA. */
  pergamino: '#f2ede3',
  /** Acento del tema. 1.80:1: DECORATIVO, nunca texto. */
  oxblood: '#7a0f16',
  /** Texto de error. 4.93:1 sobre `tinta`, 4.65:1 sobre `tinta-alta`, AA. */
  sangre: '#d2565d',
  /** Borde e icono de error. 3.63:1: cumple 1.4.11 (no texto), no 1.4.3. */
  'sangre-honda': '#c2343c',
  /** Foco de teclado y acento de estado. 8.18:1 sobre `tinta`, AA. */
  brasa: '#c9a227',
  /** Exito y sesion activa. 5.68:1 sobre `tinta`, AA. */
  verdigris: '#569584',
} as const;

export type NombreColor = keyof typeof color;

/**
 * El **acento** del tema, y el unico token que se sobreescribe en runtime.
 *
 * Va en una variable CSS (`--color-acento`) y no como un hex suelto por dos
 * motivos, y los dos son de `estetica-tourniquet.md` §11:
 *
 *   1. **El acento es por cliente.** Vive en `cat_cliente.politica_json.tema` y
 *      lo escribe una persona con un `.sql` en la instalacion. Un token de
 *      codigo no puede ser eso: habria que recompilar el portal entero para
 *      cambiarle el color a una empresa.
 *   2. **El resto de la paleta no se sobreescribe.** Solo el acento cambia entre
 *      clientes; `tinta`, `hueso`, `sangre` y `brasa` estan medidos y auditados
 *      como un conjunto, y aceptar un color de fondo del cliente seria
 *      devolverle al cliente la garantia de contraste de su propia pantalla de
 *      ingreso. El acento es decorativo en los dos temas, y por eso es el
 *      unico que se puede mover sin volver a medir nada.
 *
 * El mapeo de "clase de Tailwind" a "variable" se hace UNA vez, en
 * `tailwind.config.ts`. `fill-oxblood`, `stroke-oxblood`, `text-oxblood`,
 * `bg-oxblood` y `.filete-oxblood` salen todos de aca, asi que cambiar el acento
 * de una instalacion no toca ni un componente.
 */
export const VAR_ACENTO = '--color-acento';

/**
 * Acento por defecto de cada estetica (`estetica-tourniquet.md` §11).
 *
 * Los dos valores estan **medidos** con `contraste()` de este mismo archivo, y
 * los numeros estan en `paresContrastados`. El de la austera no es "un azul": es
 * el azul mas apagado que todavia deja el boton primario en AA, y esta eleccion
 * es la que hace que `austero` no sea un tema nuevo sino el mismo tema.
 */
export const acentoPorEstetica = {
  /** 1.80:1 sobre `tinta`: decorativo, nunca texto. Ver `color.oxblood`. */
  gothic: color.oxblood,
  /** 5.63:1 con `pergamino` (texto del boton) y 3.01:1 sobre `tinta`. */
  austero: '#41607e',
} as const;

export const ESTETICAS = ['gothic', 'austero'] as const;

export type Estetica = (typeof ESTETICAS)[number];

/**
 * Textura de peltre de `.trama-peltre`.
 *
 * Se declara como token y no escrito en la hoja de estilos por el mismo motivo
 * que `veloFondo`: son colores **con alfa** de tokens que ya existen, y
 * `theme('colors.plata/2.2')` no existe —`theme()` descarta el modificador de
 * opacidad en silencio—. Con los dos valores aca, la textura se apaga entera en
 * la estetica austera tocando un solo lugar.
 */
export const textura = {
  /** El filete de plata. Es lo que hace que la placa no sea un rectángulo liso. */
  plata: rgba(color.plata, 0.022),
  /** El reflejo del acento. En `austero` no se usa: la textura esta al 0 %. */
  acento: rgba(color.oxblood, 0.05),
} as const;

/**
 * Pares que la pantalla de login usa de verdad, con su razon medida.
 *
 * La lista es corta a proposito: son los que un lector de pantalla y un
 * verificador de contraste van a mirar. Anadir un par aca es la forma de
 * comprometer el portal a que siga midiendo bien; cualquier combinacion que no
 * este en esta tabla es, por definicion, una que todavia nadie midio.
 */
export const paresContrastados = {
  'hueso sobre tinta': { a: color.hueso, b: color.tinta, minimo: AA_TEXTO_NORMAL },
  'hueso sobre tinta-alta': { a: color.hueso, b: color['tinta-alta'], minimo: AA_TEXTO_NORMAL },
  'plata sobre tinta-alta': { a: color.plata, b: color['tinta-alta'], minimo: AA_TEXTO_NORMAL },
  'sangre sobre tinta-alta': { a: color.sangre, b: color['tinta-alta'], minimo: AA_TEXTO_NORMAL },
  'brasa sobre tinta-alta': { a: color.brasa, b: color['tinta-alta'], minimo: AA_TEXTO_NORMAL },
  'pergamino sobre oxblood': { a: color.pergamino, b: color.oxblood, minimo: AA_TEXTO_NORMAL },
  'sangre-honda sobre tinta-alta': { a: color['sangre-honda'], b: color['tinta-alta'], minimo: AA_NO_TEXTO },
  'plata 60% sobre tinta-alta (borde de control)': {
    a: 'rgba(200,204,212,0.6)',
    b: color['tinta-alta'],
    minimo: AA_NO_TEXTO,
  },

  /**
   * Estetica `austero` (seccion de arriba). Los tres pares que hacen que sea **el
   * mismo tema** y no uno nuevo:
   *
   *   1. `pergamino` sobre el acento austero: **5.63:1**, AA de texto normal. Es
   *      la restriccion dura — el boton primario esta hecho de
   *      `bg-oxblood text-pergamino` — y por eso `austero` no puede elegir un
   *      azul cualquiera.
   *   2. El acento austero sobre `tinta`: **3.01:1**, el umbral de SC 1.4.11. El
   *      acento gótico da 1.80:1 y está declarado decorativo; el austero llega al
   *      umbral sin tener que arrastrar esa salvedad.
   *   3. `hueso` sobre `tinta` (el fondo real de la austera): **15.34:1**, el
   *      mismo valor que da el gótico con el raster puesto. La austera saca la
   *      textura y con ella la imagen de fondo, asi que el wordmark queda sobre
   *      `tinta` pelada: la razon sube, no baja, y el minimo de §2 regla 1
   *      (14:1) se sostiene sin volver a medir el JPG.
   */
  'pergamino sobre el acento austero': {
    a: color.pergamino,
    b: acentoPorEstetica.austero,
    minimo: AA_TEXTO_NORMAL,
  },
  'acento austero sobre tinta (borde decorativo)': {
    a: acentoPorEstetica.austero,
    b: color.tinta,
    minimo: AA_NO_TEXTO,
  },
  'hueso sobre tinta (fondo sin textura, estetica austero)': {
    a: color.hueso,
    b: color.tinta,
    minimo: 14,
  },
  /**
   * El fondo real del wordmark: el peor pixel de la zona donde se apoya, ya
   * con la textura del §1.1 y el velo de `.fondo-login` compuestos.
   *
   * No es un token: es el valor **medido** pixel a pixel sobre el
   * `fondo-login.jpg` que genera `scripts/generar-fondo.py`, y por eso lo
   * declarado aca y el archivo generado estan calibrados el uno contra el otro.
   * El umbral es 14 y no `AA_TEXTO_NORMAL` (4.5) a proposito: §2 regla 1 pone
   * el texto de cuerpo en 14:1 y esa es la promesa que hay que sostener.
   *
   * **Si se cambia un `NIVEL_*` del generador o un stop del velo, hay que
   * volver a medir y actualizar este numero.** El `auditarContraste()` solo mira
   * que el par siga dando bien, no que la composicion siga siendo la misma, y
   * las dos cosas pueden moverse sin que se toquen.
   */
  'hueso sobre el fondo real del wordmark': {
    a: color.hueso,
    b: '#0d0d0e',
    minimo: 14,
  },
} as const;

/**
 * Verifica los pares declarados. Pensado para correrse a mano (o desde un
 * script) cuando se toca la paleta: si algo queda por debajo del umbral, tira.
 */
export function auditarContraste(): { par: string; ratio: number; cumple: boolean }[] {
  return Object.entries(paresContrastados).map(([par, definicion]) => {
    const ratio = contraste(definicion.a, definicion.b);
    return { par, ratio, cumple: ratio >= definicion.minimo };
  });
}

/**
 * Escala de espaciado. Multiplos de 4 px, con los nombres de la escala de
 * `estetica-tourniquet.md` §4 para que la Fase 07 no tenga que inventar
 * medidas nuevas sobre la misma pantalla.
 */
export const espacio = {
  0: '0',
  1: '0.25rem',
  2: '0.5rem',
  3: '0.75rem',
  4: '1rem',
  5: '1.5rem',
  6: '2rem',
  7: '3rem',
  8: '4rem',
} as const;

/**
 * Radios. Chaflanados y chicos: son placas de metal, no botones redondeados.
 * `placa` es el del marco grabado del formulario.
 */
export const radio = {
  campo: '2px',
  placa: '3px',
  nulo: '0',
} as const;

/**
 * Foco de teclado. El doble anillo no es decorativo: `brasa` sola da 2.07:1
 * sobre `pergamino` y no se veria, asi que el anillo exterior va en `hueso`
 * (spec §4). Se declara aca y no como clase suelta para que ningun control se
 * quede sin el.
 */
export const foco = {
  ancho: '2px',
  desplazamiento: '2px',
  color: color.brasa,
  anilloExterno: color.hueso,
  anilloExternoAncho: '1px',
} as const;

/** Ancho minimo del area tactil de un control. Criterio 2.5.8 (WCAG 2.2). */
export const AREA_TACTIL_MIN = '44px';

/** Tipografia por rol, expuesta como variables de clase de `next/font`. */
export const tipografia = {
  /** Wordmark. Blackletter: maximo 3 apariciones en pantalla (spec §3). */
  wordmark: 'var(--fuente-wordmark)',
  /** Titulos de pagina: el feel de placa grabada. */
  titulo: 'var(--fuente-titulo)',
  /** Texto de lectura. */
  cuerpo: 'var(--fuente-cuerpo)',
  /** Labels, botones, tablas, valores. Nunca decorativa. */
  interfaz: 'var(--fuente-interfaz)',
  /** Tokens, `sub`/`aud`/`sid`, el inspector de la Fase 06. */
  codigo: 'var(--fuente-codigo)',
} as const;

/**
 * Velo del fondo de `/login`: `tinta` con alfa, para el gradiente radial de
 * `.fondo-login` (`globals.css`).
 *
 * Vive como token y no como `theme('colors.tinta/93')` en la hoja de estilos
 * porque **`theme()` no inyecta alfa**: lee el valor crudo del token y descarta
 * el modificador, y compila `theme('colors.tinta/93')` a `#0a0a0c` **opaco y
 * sin avisar**. Con eso, el velo tapaba la imagen entera y el login volvia al
 * plano de acero de antes con 62 KB de descarga. Ver `rgba()` en `contraste.ts`.
 *
 * Los cuatro numeros estan calibrados contra el peor pixel de la zona del
 * wordmark, no puestos a ojo: con estos, `hueso` mide 15.08:1 atras del
 * wordmark y 15.20:1 atras del subtitulo, contra los 14:1 que §2 regla 2 pide
 * para texto de cuerpo. Si se cambia el generador de la textura hay que volver
 * a medirlos.
 */
export const veloFondo = {
  /** El centro de la columna del contenido: practicamente opaco. */
  centro: rgba(color.tinta, 0.93),
  /**
   * La **meseta**, que es lo que hace funcionar el velo. No es un degradado
   * desde el centro: el wordmark esta arriba del centro del gradiente, a un
   * 42 % del radio, asi que con una rampa desde el origen el texto caeria
   * justo en la parte que ya se esta aclarando. La meseta llega hasta el 68 %.
   */
  meseta: rgba(color.tinta, 0.91),
  /** Donde la textura tiene que verse. */
  margen: rgba(color.tinta, 0.4),
  /** El borde de la pantalla, la textura abierta. */
  borde: rgba(color.tinta, 0.3),
} as const;

/**
 * El bloque `:root` que Tailwind inyecta en la capa base.
 *
 * Antes existia un `variablesCss` que emitia **todos** los tokens como variables y
 * no lo consumia nadie. Se reemplazo por esto, que es lo que la pagina necesita:
 * **una** variable, la del acento.
 *
 * La razon de no convertir toda la paleta en variables es una trampa de Tailwind
 * que ya esta pagada en este repo: un color declarado como `var(--x)` no admite
 * el modificador de opacidad, porque Tailwind no puede parsearlo — y lo descarta
 * **en silencio**, sin warning (ver `rgba()` en `contraste.ts` y el comentario de
 * `.fondo-login`). El portal usa `border-plata/60` en 23 lugares: convertir `plata`
 * en variable los dejaria con el borde en `none` y el build en verde.
 *
 * El acento no usa ningun modificador de opacidad en ninguna parte, asi que es
 * el unico token que puede ser variable sin costo.
 *
 * El valor por defecto es el del tema `gothic`. El `austero` (o el `#rrggbb` que
 * haya puesto el cliente en `cat_cliente.politica_json.tema`) lo sobreescribe en
 * runtime desde `design/marca.tsx`, despues de que `/marca` responda. Escribir
 * el default aca y no en el CSS es lo que hace que el portal se pinte **bien**
 * desde el primer frame, antes de que la respuesta llegue: sin esto, el acento
 * estaria sin definir durante el primer render y `bg-oxblood` saldria transparente.
 */
export const raizCss: Record<string, string> = {
  [VAR_ACENTO]: acentoPorEstetica.gothic,
};

