import { AA_NO_TEXTO, AA_TEXTO_NORMAL, contraste } from './contraste';

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
 * Las variables CSS que consume Tailwind. Se generan desde `color` para que el
 * unico lugar con un hex siga siendo este archivo.
 */
export const variablesCss = Object.entries(color)
  .map(([nombre, valor]) => `  --color-${nombre}: ${valor};`)
  .join('\n');
