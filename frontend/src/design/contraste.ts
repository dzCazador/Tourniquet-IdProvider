/**
 * Contraste WCAG 2.2, medido, no estimado.
 *
 * Vive en el repo y no en un spreadsheet porque §4 de `estetica-tourniquet.md`
 * ya improperó una vez: decia que `sangre` daba 5.9:1 y daba 3.63:1, que es
 * exactamente el valor que hizo fallar el texto de error del login contra AA.
 * Una razon de contraste escrita a mano en un documento es una razon de
 * contraste que nadie vuelve a medir; esta se puede volver a correr.
 *
 * La funcion es la de WCAG 2.x para sRGB, sin cambios respecto de 1.4: la
 * luminancia relativa se calcula sobre canales linealizados y el ratio es
 * `(L1 + 0.05) / (L2 + 0.05)`.
 */

function canalesLineales(hex: string): [number, number, number] {
  const limpio = hex.replace('#', '');
  if (limpio.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(limpio)) {
    throw new Error(`Color invalido: ${hex}. Se espera #rrggbb.`);
  }
  const entero = parseInt(limpio, 16);
  return [(entero >> 16) & 255, (entero >> 8) & 255, entero & 255];
}

/** `rgba(r,g,b,a)`, la forma en que Tailwind escribe `plata/60`. */
function canalesConAlfa(valor: string): [number, number, number, number] | null {
  const encontrado = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(
    valor.trim(),
  );
  if (!encontrado) {
    return null;
  }
  const alfa = encontrado[4] === undefined ? 1 : Number(encontrado[4]);
  return [Number(encontrado[1]), Number(encontrado[2]), Number(encontrado[3]), alfa];
}

/**
 * Convierte un token `#rrggbb` en `rgba(r,g,b,a)`.
 *
 * Existe por una trampa de Tailwind: `theme('colors.tinta/93')` **no** inyecta
 * alfa. `theme()` lee el valor crudo del token y descarta el modificador, asi
 * que el build compila `theme('colors.tinta/93')` a `#0a0a0c` opaco y sin
 * avisar. Para que un token lleve alfa hay dos caminos, y este es el que se usa
 * en el portal: el color se expone YA con alfa desde `tokens.ts`.
 *
 * El otro camino seria declarar la paleta como funciones con `<alpha-value>`,
 * que es lo que hace el default de Tailwind. Acá no se puede: `color` se usa
 * como valor plano en `variablesCss`, en `contraste()` y en el CSS compilado, y
 * volverlo funciones rompe las tres.
 */
export function rgba(hex: string, alfa: number): string {
  const [r, g, b] = canalesLineales(hex);
  return `rgba(${r}, ${g}, ${b}, ${alfa})`;
}

/**
 * Compone un color con alfa sobre un fondo opaco.
 *
 * Hace falta porque la mitad de los bordes del portal son `plata/60`, y el
 * contraste de un color semitransparente **no** es el de su canal: sin
 * componer, `plata` mediría 12:1 y en pantalla pinta como un gris medio. El
 * alfa se aplica sobre el fondo (la segunda columna de la fila), que es como
 * el navegador lo pinta.
 */
function componer(encima: [number, number, number, number], fondo: [number, number, number]): [number, number, number] {
  const a = encima[3];
  return [
    encima[0] * a + fondo[0] * (1 - a),
    encima[1] * a + fondo[1] * (1 - a),
    encima[2] * a + fondo[2] * (1 - a),
  ];
}

function luminancia(canales: [number, number, number]): number {
  const lineal = (canal: number): number => {
    const c = canal / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lineal(canales[0]) + 0.7152 * lineal(canales[1]) + 0.0722 * lineal(canales[2]);
}

/**
 * Razon de contraste entre dos colores, redondeada a dos decimales.
 *
 * Acepta `#rrggbb` y `rgba(r,g,b,a)`. Un color con alfa se compone sobre el
 * segundo, que tiene que ser opaco.
 */
export function contraste(primerColor: string, segundoColor: string): number {
  const fondo = canalesLineales(segundoColor);
  const conAlfa = canalesConAlfa(primerColor);
  const a = conAlfa ? componer(conAlfa, fondo) : canalesLineales(primerColor);

  const la = luminancia(a);
  const lb = luminancia(fondo);
  const [claro, oscuro] = la > lb ? [la, lb] : [lb, la];
  return Math.round(((claro + 0.05) / (oscuro + 0.05)) * 100) / 100;
}

/** Umbral de WCAG 2.2 para texto de tamaño normal (SC 1.4.3). */
export const AA_TEXTO_NORMAL = 4.5;

/** Umbral de WCAG 2.2 para texto grande (>= 18.66 px bold o 24 px) (SC 1.4.3). */
export const AA_TEXTO_GRANDE = 3;

/** Umbral de WCAG 2.2 para bordes e iconos que significan algo (SC 1.4.11). */
export const AA_NO_TEXTO = 3;
