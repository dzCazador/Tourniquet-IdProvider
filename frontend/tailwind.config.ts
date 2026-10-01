import type { Config } from 'tailwindcss';
// `PluginCreator` no se puede pedir a `tailwindcss` porque su `index.d.ts` es un
// `export =` de la funcion `plugin`: los tipos viven en `types/config`.
import type { PluginCreator } from 'tailwindcss/types/config';
import { VAR_ACENTO, color, espacio, foco, radio, raizCss, textura, veloFondo } from './src/design/tokens';

/**
 * Tailwind no repite ningun valor: todo sale de `src/design/tokens.ts`.
 *
 * La paleta se expone como `tinta`, `oxblood`, `sangre`... y no como
 * `tourniquet-oxblood`: el nombre del token *es* el nombre de la clase, para
 * que `grep -rn "#[0-9a-f]{6}" frontend/src/app` no tenga que encontrar nada y
 * para que un cliente que cambie su acento (spec §11) cambie el token y no una
 * lista de clases de mil lugares.
 *
 * `safelist` esta vacio a proposito: las clases se escriben completas en el
 * JSX. Con valores dinamicos tipo `style={{ color: color.brasa }}` no hay
 * problema; el problema seria inventar `text-${nombre}` y confiar en que
 * Tailwind lo vea en el codigo, que no lo ve.
 */

/**
 * El unico color de la paleta que **no** es un hex sino una variable CSS: el
 * acento, que es por cliente (`cat_cliente.politica_json.tema`, `estetica-
 * tourniquet.md` §11).
 *
 * Va declarado en un solo lugar y a mano, no con un `map` sobre `color`, por una
 * razon que conviene que quede escrita: el mapeo tiene que ser **explicito** para
 * que se vea que es el unico. Si fuera `Object.fromEntries(Object.keys(color).map(...))`
 * el dia de manana habria veinte variables y nadie sabria cuales se pueden
 * sobreescribir en runtime — y la respuesta ("ninguna, porque en twenty
 * lugares hay `/NN`") se pierde.
 *
 * El costo de que sea una variable esta medido: ninguna clase del acento usa
 * modificador de opacidad. `border-plata/60` (23 usos) si lo usa, y por eso
 * `plata` sigue siendo un hex.
 */
const acento: Record<string, string> = { oxblood: `var(${VAR_ACENTO})` };

/**
 * Emite el `:root` con el valor por defecto del acento.
 *
 * Va como plugin y no escrito en `globals.css` porque `globals.css` no puede
 * importar un `.ts`: si el hex del default viviera en la hoja de estilos, el
 * unico lugar con un color pasaria a ser dos.
 */
function acentoPorDefecto(): PluginCreator {
  return ({ addBase }) => {
    addBase({ ':root': raizCss });
  };
}

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    /*
     * `velo` son los tokens con alfa del fondo de login, y van anidados bajo su
     * propio nombre para no mezclar cuatro `tinta`-con-alfa sueltos en la
     * paleta: `theme('colors.velo.centro')` en la hoja de estilos, `bg-velo-
     * centro` en el JSX. Se REGISTERAN con el alfa ya puesto porque `theme()`
     * no sabe inyectarlo (ver `rgba()` en `contraste.ts`).
     *
     * `textura` es lo mismo para la trama de peltre, y existe como grupo
     * aparte para que la estetica austera pueda apagarla sin tocar los colores
     * que llevan el 4 % de plata.
     */
    colors: { ...color, ...acento, velo: { ...veloFondo }, textura: { ...textura } },
    extend: {
      spacing: espacio,
      borderRadius: {
        campo: radio.campo,
        placa: radio.placa,
      },
      fontFamily: {
        wordmark: ['var(--fuente-wordmark)', 'serif'],
        titulo: ['var(--fuente-titulo)', 'serif'],
        cuerpo: ['var(--fuente-cuerpo)', 'serif'],
        interfaz: ['var(--fuente-interfaz)', 'system-ui', 'sans-serif'],
        codigo: ['var(--fuente-codigo)', 'ui-monospace', 'monospace'],
      },
      fontSize: {
        // Cuerpo de lectura de 18 px: el piso de `estetica-tourniquet.md` §3.
        // Los labels de formulario bajan a 15 px, que es lo que el portal usa,
        // y siguen siendo 15 px: por eso la escala separa `chico` de `cuerpo`.
        cuerpo: ['1.125rem', { lineHeight: '1.6' }],
        chico: ['0.9375rem', { lineHeight: '1.5' }],
        menor: ['0.8125rem', { lineHeight: '1.5' }],
      },
      minHeight: {
        // 44x44 px: SC 2.5.8 de WCAG 2.2, criterio 2.5.5 antes.
        tactil: '44px',
      },
      outlineColor: { foco: foco.color },
      outlineWidth: { foco: foco.ancho },
      outlineOffset: { foco: foco.desplazamiento },
    },
  },
  plugins: [acentoPorDefecto()],
};

export default config;
