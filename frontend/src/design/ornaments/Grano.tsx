/**
 * `Grano`: grano fino de pelicula, el "foil" de la lamina (`estetica-tourniquet.md`
 * §5, y la linea *"I wrapped our love in all this foil"* de la §1).
 *
 * `feTurbulence` con `baseFrequency` alta y dos octavas: sale la textura de metal
 * rayado, no el ruido de television. Va a opacidad 0.03 sobre `tinta`, que es lo
 * que lo hace "grano" y no "suciedad".
 *
 * Es el unico uso de filtro SVG del tema, y por eso se declara aqui y no en el
 * componente: un `<filter>` necesita un `id` **unico en el documento**, y con dos
 * Gramnos en la misma pagina (el launcher con lista y la pantalla de puerta, por
 * ejemplo) dos `<feTurbulence>` con el mismo id se contaminan entre si y el
 * navegador usa el primero para los dos. El sufijo con `useId` lo evita.
 *
 * Decorativo y siempre `aria-hidden`: no aporta nada a un lector de pantalla y
 * como elemento con nombre solo agrega ruido.
 */
import { useId } from 'react';

export function Grano({ className = '' }: { className?: string }) {
  const id = useId().replace(/:/g, '');

  return (
    <svg aria-hidden focusable="false" className={`pointer-events-none absolute inset-0 h-full w-full ${className}`}>
      <filter id={`grano-${id}`}>
        {/*
          `stitchTiles="stitch"` y `baseFrequency` en 0.8/0.9: sin el stitch, el
          filtro se calcula sobre un tile y al repetirlo aparecen costuras visibles
          cada 24 px. Es el detalle que separa "grano" de "rejilla de ruido".
        */}
        <feTurbulence
          type="fractalNoise"
          baseFrequency="0.82"
          numOctaves="2"
          stitchTiles="stitch"
          result="ruido"
        />
        <feColorMatrix
          in="ruido"
          type="matrix"
          // Solo el canal alpha, y al 3 %: se quiere el grano, no un velo gris.
          values="0 0 0 0 0.78  0 0 0 0 0.80  0 0 0 0 0.83  0 0 0 0.03 0"
        />
      </filter>
      <rect width="100%" height="100%" filter={`url(#grano-${id})`} />
    </svg>
  );
}
