/**
 * `Anillo`: el tourniquet.
 *
 * SVG original del repo, sin atribucion y sin request extra (`estetica-tourniquet.md`
 * §1.1 y §5). Tres trazos concentricos, una muesca abierta a las 2 y un remache
 * en la interseccion: es el "instrumento que comprime el flujo para detenerlo"
 * del concepto, dibujado sin una sola palabra de la cancion.
 *
 * Los colores van con utilidades de Tailwind (`stroke-plata`, `fill-oxblood`)
 * y no con un `var()` escrito aca: las utilidades salen de `tokens.ts` igual que
 * cualquier otra clase, asi que el hex sigue estando en un solo archivo. La
 * excepcion es `oxblood`, que **si** es una variable (`--color-acento`) porque
 * es el unico token que se sobreescribe por cliente (`estetica-tourniquet.md`
 * §11) — y el mapeo esta en `tailwind.config.ts`, no en este componente.
 *
 * Es **decorativo**: sin `titulo` queda con `aria-hidden`, porque el nombre de
 * quien esta entrando ya esta en el texto visible del wordmark —que desde la
 * Fase 10 es el del cliente, no el del producto— y un SVG sin nombre no le
 * aporta nada a un lector de pantalla. El borde de 1.5 px es el de los iconos
 * de la spec §3.
 */
export function Anillo({
  className = '',
  diametro = 96,
  titulo,
}: {
  className?: string;
  diametro?: number;
  /** Si se pasa, el SVG deja de ser decorativo y se anuncia con nombre. */
  titulo?: string;
}) {
  return (
    <svg
      viewBox="0 0 100 100"
      width={diametro}
      height={diametro}
      className={className}
      role={titulo ? 'img' : undefined}
      aria-hidden={titulo ? undefined : true}
      aria-label={titulo}
      focusable="false"
    >
      {/* Anillo exterior. La muesca se abre con `strokeDasharray` en vez de
          partir el circulo en dos `<path>`: el circulo entero se ve mejor
          behind de las tipografias, y el hueco queda de un trazo. */}
      <circle cx="50" cy="50" r="44" fill="none" className="stroke-hierro" strokeWidth="4" />
      <circle
        cx="50"
        cy="50"
        r="44"
        fill="none"
        className="stroke-plata"
        strokeWidth="1.5"
        strokeDasharray="243 34"
        strokeDashoffset="14"
        transform="rotate(-118 50 50)"
      />
      {/* Anillo interior: la columna del instrumento. */}
      <circle
        cx="50"
        cy="50"
        r="32"
        fill="none"
        className="stroke-hierro"
        strokeWidth="1.5"
        strokeDasharray="182 19"
        transform="rotate(-118 50 50)"
      />
      {/* Remache: el punto donde el anillo se cierra. */}
      <circle cx="50" cy="7" r="4" className="fill-plata" />
      <circle cx="50" cy="7" r="1.8" className="fill-oxblood" />
      {/* Terminaciones de la muesca, achaflanadas. */}
      <path
        d="M 21.4 16.6 L 26.8 22 M 73.2 22 L 78.6 16.6"
        className="stroke-plata"
        strokeWidth="1.5"
        strokeLinecap="square"
        fill="none"
      />
    </svg>
  );
}
