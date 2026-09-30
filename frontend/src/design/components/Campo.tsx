'use client';

import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react';

/**
 * `Campo`: input con `<label>` visible, error y foco `brasa`.
 *
 * Los cuatro requisitos de `estetica-tourniquet.md` §7.1 estan aca y no en la
 * pagina de login, porque son propiedades del control:
 *
 *   - `<label>` **visible** y asociado por `htmlFor`/`id` generado con
 *     `useId`. El `useId` importa: dos campos con el mismo `id` en el mismo
 *     documento hacen que el clic en el label vaya al control equivocado, y en
 *     un portal estatico con varias instancias eso es un bug real, no teorico.
 *   - `autoComplete` lo pasa quien lo usa, y en el login es
 *     `username`/`current-password`. Es lo que hace que el gestor de contrasenas
 *     ofrezca guardar la clave (criterio de aceptacion de la fase).
 *   - El error va con `aria-describedby` + `aria-invalid`, no solo con color: un
 *     borde rojo sin `aria-invalid` no le dice nada a un lector de pantalla.
 *   - La sombra de error usa `sangre-honda` (3.63:1, suficiente para un borde
 *     que significa algo, SC 1.4.11) y el TEXTO del error usa `sangre`
 *     (4.93:1, AA para texto normal). Confundir esos dos es el defecto que
 *     corrigio la tabla §4 en esta fase.
 *
 * Copypaste: nunca se bloquea. Un `onPaste` que preventDefault es un muro para
 * los gestores de contrasenas y para el pelear con una clave larga, y el
 * rate limit del backend es el control (§7.1).
 */
type PropsCampo = InputHTMLAttributes<HTMLInputElement> & {
  etiqueta: string;
  /** Texto del error **de este campo**. Vacio o ausente = sin mensaje propio. */
  error?: string;
  /**
   * Marca el campo como invalido SIN darle un mensaje propio.
   *
   * Es lo que usa el login, y la separacion es a proposito: los dos campos
   * comparten **un solo** mensaje generico ("No pudimos validar tu usuario o
   * tu clave"), porque un mensaje por campo dice cual de los dos fallo y eso
   * es enumeracion de cuentas (`specs/01` §4). El aviso vive en el `role="alert"`
   * de arriba y los dos campos solo llevan el estado: `aria-invalid` y el
   * borde `sangre-honda`, que es lo que pide `estetica-tourniquet.md` §8 ("sin
   * color de alarma, sin icono agresivo: el borde `sangre` y listo").
   */
  invalido?: boolean;
  ayuda?: ReactNode;
  className?: string;
  campoClassName?: string;
};

/**
 * `forwardRef` y no un `ref` en las props.
 *
 * En React 18 `ref` es una prop **especial**: React la intercepta antes de
 * armar el objeto de props y se la pasa al componente por el mecanismo de refs,
 * no por `props.ref`. Un componente de funcion que declara `ref` en su tipo y la
 * lee de `props` recibe siempre `undefined`, sin error de TypeScript (el tipo lo
 * dice) y sin error de runtime (React solo avisa por consola). El síntoma es
 * que `input.focus()` no hace nada: el foco se queda donde estaba.
 *
 * `forwardRef` es justamente el puente que convierte la ref de React en una
 * prop normal del `<input>` de abajo. Con React 19 esto deja de hacer falta
 * (las refs son props comunes), pero el repo esta en 18 y migrar no es de esta
 * fase.
 */
export const Campo = forwardRef<HTMLInputElement, PropsCampo>(function Campo(
  { etiqueta, error, invalido = false, ayuda, className = '', campoClassName = '', ...props },
  ref,
) {
  const id = useId();
  const idError = `${id}-error`;
  const idAyuda = `${id}-ayuda`;
  const mensaje = typeof error === 'string' ? error : '';
  const hayMensaje = mensaje.length > 0;
  const hayError = hayMensaje || invalido;

  const descritosPor = [hayMensaje ? idError : null, ayuda ? idAyuda : null]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={className}>
      <label htmlFor={id} className="block font-interfaz text-chico text-plata">
        {etiqueta}
      </label>

      <input
        {...props}
        ref={ref}
        id={id}
        aria-invalid={hayError || undefined}
        aria-describedby={descritosPor || undefined}
        className={[
          'foco-brasa mt-1 block w-full rounded-campo border bg-tinta px-3 py-2',
          'font-interfaz text-chico text-hueso placeholder:text-plata/50',
          'min-h-tactil',
          hayError
            ? 'border-sangre-honda'
            : 'border-plata/60 hover:border-plata',
          campoClassName,
        ].join(' ')}
      />

      {ayuda ? (
        <p id={idAyuda} className="mt-1 font-interfaz text-menor text-plata">
          {ayuda}
        </p>
      ) : null}

      {hayMensaje ? (
        <p id={idError} className="mt-1 font-interfaz text-menor text-sangre">
          {mensaje}
        </p>
      ) : null}
    </div>
  );
});
