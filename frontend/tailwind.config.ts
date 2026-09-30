import type { Config } from 'tailwindcss';
import { color, espacio, foco, radio } from './src/design/tokens';

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
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    colors: { ...color },
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
  plugins: [],
};

export default config;
