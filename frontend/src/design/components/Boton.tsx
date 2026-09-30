'use client';

import type { ButtonHTMLAttributes, ReactNode } from 'react';

/**
 * `Boton`: primary / secondary / ghost, con `aria-busy` y sin deshabilitar el
 * formulario mientras espera.
 *
 * La regla de `estetica-tourniquet.md` §7.1 es explicita: el formulario **no**
 * se deshabilita durante la request, el estado se muestra en el boton. El
 * motivo es practico mas que estetico: un `disabled` en el submit borra el foco
 * del control que lo disparo, y en Safari eso hace que el formulario se
 * quede sin anuncio de error y el teclado se coma la primera pulsacion de
 * Enter del reintento.
 *
 * El boton disabled de verdad solo existe para el estado "ya enviado": se
 * bloquea con `aria-disabled` + `pointer-events: none` en vez de `disabled`, y
 * se marca `aria-busy` mientras espera. Asi el nodo sigue siendo el mismo, el
 * foco no salta y el anuncio de error sigue teniendo a quien anunciarselo.
 */
export function Boton({
  variante = 'primary',
  cargando = false,
  bloqueado = false,
  className = '',
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variante?: 'primary' | 'secondary' | 'ghost';
  cargando?: boolean;
  bloqueado?: boolean;
}) {
  const inactivo = bloqueado || cargando;

  /**
   * Borde de los tres TODOS en `plata/60`, y no solo el secundario.
   *
   * El borde es lo que dibuja el limite del boton: el fondo `tinta-alta` sobre
   * la pagina `tinta` da 1.06:1, o sea que sin borde el boton no tiene borde.
   * Con `oxblood` (que era lo que llevaba el primario) el limite daba 1.70:1,
   * y WCAG 2.2 SC 1.4.11 pide **3:1** para el borde de un control. `plata` al
   * 60 % da 4.83:1 sobre el propio fondo del boton.
   *
   * Entonces la jerarquia entre primario y secundario va por el **relleno**,
   * que es donde se puede gastar sin perder contraste: primario con panel,
   * secundario transparente. `oxblood` se queda donde sí es decorativo y no
   * tiene que distinguir nada: el bisel de la placa y el separador.
   */
  const estilos: Record<string, string> = {
    primary: 'border-plata/60 bg-tinta-alta text-hueso hover:bg-hierro hover:border-plata',
    secondary: 'border-plata/60 bg-transparent text-hueso hover:border-plata hover:bg-tinta-alta',
    ghost: 'border-transparent bg-transparent text-plata hover:text-hueso hover:bg-tinta-alta',
  };

  return (
    <button
      {...props}
      type={props.type ?? 'submit'}
      aria-busy={cargando || undefined}
      aria-disabled={inactivo || undefined}
      // Sin `disabled`: el control sigue siendo el mismo nodo y conserva el
      // foco. `pointer-events: none` es lo que impide el segundo submit.
      className={[
        'foco-brasa inline-flex min-h-tactil items-center justify-center gap-2',
        'rounded-campo border px-4 py-2 font-interfaz text-chico',
        'transition-colors duration-150',
        estilos[variante] ?? estilos.primary,
        inactivo ? 'pointer-events-none cursor-progress opacity-60' : 'cursor-pointer',
        className,
      ].join(' ')}
    >
      {cargando ? <Espera /> : null}
      {children}
    </button>
  );
}

/**
 * El unico indicador de carga del producto, y es un punto de 1.5 px de `brasa`
 * con un pulso lento (`estetica-tourniquet.md` §6: la mancha de tinta de la 07,
 * aqui en su version minima). No hay skeleton y no hay spin: un spinner
 * rapido al lado de un boton es ruido, y un skeleton en el login esconde el
 * layout justo cuando el usuario esta mirando donde va a aparecer el error.
 *
 * `motion-reduce` lo deja fijo: con `prefers-reduced-motion` la animacion se
 * apaga, y el estado sigue viéndose porque el color no cambia con ella.
 */
function Espera() {
  return (
    <span
      className="inline-block h-1.5 w-1.5 rounded-full bg-brasa motion-safe:animate-pulse"
      aria-hidden
    />
  );
}
