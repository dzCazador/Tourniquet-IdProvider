import type { ReactNode } from 'react';

/**
 * `Placa`: la placa grabada que enmarca el formulario de login.
 *
 * La idea es que el login se vea como una placa atornillada a una pared, no
 * como un formulario flotando en el vacio (`estetica-tourniquet.md` §7). Por
 * eso el marco es un `position: absolute` que se dibuja DETRAS del contenido y
 * el panel lleva su propio fondo opaco encima: si el marco quedara adelante, el
 * texto de error o el borde del campo en foco se verian cruzados por una linea.
 *
 * Doble trazo (exterior en `hierro`, interior en `oxblood` a 1.5 px) y esquinas
 * achaflanadas. El `oxblood` aca es decorativo: 1.80:1, asi que nunca es texto ni
 * un borde que tenga que distinguir algo. SVG original del repo, ~1 KB, sin
 * request extra.
 */
export function Placa({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`relative ${className}`}>
      <PlacaMarco aria-hidden />
      {/*
        El padding es compacto a proposito (`py-6 sm:py-8` y no `py-8
        sm:py-10`): entre este padding, el encabezado y los avisos de abajo, la
        pantalla de login daba ~1010 px de alto y no entraba en un monitor de
        768, que es el equipo mas probable de un puesto de RRHH. El ajuste se
        hace aca y no con un `max-h` en la pagina, que cortaria el formulario.

        El `[@media(max-height:820px)]:py-5` son 12 px mas, y tambien se
        ajustan por alto de pantalla y no por ancho: la pregunta es si entra en
        la pantalla, no que tan angosta es.
      */}
      <div className="relative rounded-placa bg-tinta-alta px-5 py-6 [@media(max-height:820px)]:py-5 sm:px-8 sm:py-8">
        {children}
      </div>
    </div>
  );
}

/** El marco solo, para cuando se quiere la placa sin el panel opaco. */
export function PlacaMarco({ className = '' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 400 400"
      preserveAspectRatio="none"
      aria-hidden
      focusable="false"
      className={`pointer-events-none absolute -inset-px h-[calc(100%+2px)] w-[calc(100%+2px)] ${className}`}
    >
      {/* Trazo exterior: hierro, el metal sin pulir. */}
      <path
        d="M 10 0 H 390 L 400 10 V 390 L 390 400 H 10 L 0 390 V 10 Z"
        fill="none"
        className="stroke-hierro"
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
      />
      {/* Trazo interior: el bisel grabado. */}
      <path
        d="M 14 4 H 386 L 396 14 V 386 L 386 396 H 14 L 4 386 V 14 Z"
        fill="none"
        className="stroke-oxblood"
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
        opacity="0.9"
      />
    </svg>
  );
}
