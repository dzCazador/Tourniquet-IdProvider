/**
 * `Costura`: el separador de seccion (`—✦—`).
 *
 * La "linea divisoria" como ornamento primario de `estetica-tourniquet.md` §1:
 * el pespunte y su nudo central. Tres trazos, sin texto: el asterisco del
 * ejemplo del spec es un dibujo, no un caracter, para que no dependa de la
 * fuente ni aparezca distinto en un Windows y en un Mac.
 *
 * Decorativo, siempre `aria-hidden`: un separador decorativo entre dos bloques
 * de texto no aporta nada a un lector de pantalla y como elemento semantico
 * solo agrega ruido. Si alguna vez separa dos secciones que se navigan, lo
 * correcto es un `<hr>` con etiqueta, no este componente.
 */
export function Costura({ className = '' }: { className?: string }) {
  return (
    <div className={`flex items-center gap-3 ${className}`} aria-hidden>
      <span className="h-px flex-1 bg-hierro" />
      <svg viewBox="0 0 24 12" width="24" height="12" focusable="false" className="shrink-0">
        {/* El pespunte: tres puntos a cada lado. */}
        <path
          d="M 1 6 h 2 M 4.5 6 h 2 M 8 6 h 2"
          className="stroke-plata"
          strokeWidth="1.5"
          strokeLinecap="butt"
          fill="none"
        />
        <path
          d="M 14 6 h 2 M 17.5 6 h 2 M 21 6 h 2"
          className="stroke-plata"
          strokeWidth="1.5"
          strokeLinecap="butt"
          fill="none"
        />
        {/* El nudo central. */}
        <path d="M 12 1 L 15 6 L 12 11 L 9 6 Z" className="stroke-oxblood" strokeWidth="1.5" fill="none" />
        <circle cx="12" cy="6" r="1.2" className="fill-oxblood" />
      </svg>
      <span className="h-px flex-1 bg-hierro" />
    </div>
  );
}
