import { aplicarMovimiento } from '../motion';

/**
 * `Sello`: el sello de lacre con el codigo de la app.
 *
 * Es el "sesion sellada" de `estetica-tourniquet.md` §8: la sesion viva lleva el
 * sello cerrado, y al cerrarla el sello se abre. El color dice el estado sin
 * texto —`verdigris` viva, `hierro` cerrada— y por eso el texto que va adentro es
 * el **codigo** y no un icono: el `aria-label` es lo que dice el estado a un lector
 * de pantalla, y el codigo es lo que el usuario ya vio en la lista de apps.
 *
 * `oxblood` es el color del lacre, y es decorativo (1.80:1): nunca es texto. El
 * `TQ` de adentro va en `pergamino` (9.44:1 sobre `oxblood`), que es el unico par
 * del tema donde texto sobre acento esta permitido.
 *
 * El SVG es propio y pesa ~1 KB. Se dibuja en `viewBox` 48x48 con un circulo
 * irregular (el lacre nunca es un circulo perfecto) y el "TQ" con trazos.
 */
export function Sello({
  codigo = 'TQ',
  estado = 'activa',
  className = '',
  diametro = 44,
}: {
  /** Texto del lacre. Por defecto el monograma; la app pone su codigo. */
  codigo?: string;
  /** `activa` = sesión sellada (lacre cerrado). `cerrada` = el sello se abre. */
  estado?: 'activa' | 'cerrada';
  className?: string;
  diametro?: number;
}) {
  const texto = estado === 'activa' ? 'sesión activa' : 'sesión cerrada';
  const colorLacre = estado === 'activa' ? 'text-oxblood' : 'text-hierro';

  return (
    <span
      className={`relative inline-flex shrink-0 items-center justify-center ${colorLacre} ${aplicarMovimiento('sello')} ${className}`}
      // El SVG de adentro es decorativo; el estado lo anuncia este `span`.
      role="img"
      aria-label={`${codigo}: ${texto}`}
    >
      <svg viewBox="0 0 48 48" width={diametro} height={diametro} aria-hidden focusable="false">
        {/*
          El lacre: un disco con los bordes desiguales de una cera estampada a mano.
          Es un circulo con tres goterones abajo y no un poligono de 20 puntos
          porque a 44 px de alto la diferencia no se ve, y un path largo es una
          fuente de ruido en el diff.
        */}
        <circle cx="24" cy="22" r="19" className="fill-current" />
        <circle cx="18" cy="39" r="2.6" className="fill-current" />
        <circle cx="26" cy="41" r="2" className="fill-current" />
        <circle cx="33" cy="37" r="2.4" className="fill-current" />
        {/* El filete grabado, en `pergamino`: el unico texto del tema que va sobre oxblood. */}
        <circle cx="24" cy="22" r="13" className="fill-none stroke-pergamino" strokeWidth="1.2" opacity="0.8" />
      </svg>
      <span
        aria-hidden
        className="absolute font-titulo text-pergamino"
        style={{ fontSize: Math.round(diametro * 0.26) }}
      >
        {codigo.slice(0, 3)}
      </span>
    </span>
  );
}
