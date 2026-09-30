'use client';

import type { ReactNode } from 'react';
import { Boton } from '@/design/components/Boton';
import { Anillo } from '@/design/ornaments/Anillo';

/**
 * `Confirmar`: el diálogo de confirmación de las acciones del panel.
 *
 * Existe por la trampa 6 de la Fase 08 —"un diálogo con el tema fuerte puede
 * terminar siendo un click sin leer"— y la regla que sale de ahí es **el texto del
 * botón dice qué va a pasar**, no "Confirmar". "Deshabilitar el acceso de Juan Pérez a
 * RHPro" es un botón que dice lo que hace; "Confirmar" es un botón que exige haber
 * leído el título, y a las 3 de la mañana nadie lo lee dos veces.
 *
 * Y por eso el diálogo **no** es un `window.confirm` (que en algunos navegadores es un
 * diálogo del sistema, sin el texto del tema, sin el motivo del cierre y sin poder
 * elegir el motivo del cierre forzado, que es obligatorio).
 *
 * Va como componente y no como hook porque tiene estado propio (abierto/cerrado) y
 * porque el contenido del diálogo es distinto en cada llamada. El `onConfirm` puede
 * ser asíncrono: el botón queda en `aria-busy` hasta que termina, y un doble clic no
 * ejecuta la acción dos veces.
 */
export function Confirmar({
  titulo,
  children,
  textoConfirmar,
  destructivo = false,
  onConfirm,
  onCancel,
  ocupado = false,
}: {
  titulo: string;
  /** Qué pasa exactamente, en una o dos frases. */
  children: ReactNode;
  /** Texto del botón: la acción, con su objeto. Nunca "Confirmar" a secas. */
  textoConfirmar: string;
  destructivo?: boolean;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
  ocupado?: boolean;
}) {
  return (
    <div
      // El fondo no es un overlay oscuro: es la lamina del tema, opaca, para que el
      // texto de encima este sobre `tinta-alta` y no sobre el contenido que tapa.
      className="fixed inset-0 z-20 flex items-center justify-center bg-tinta/90 p-4"
      role="presentation"
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirmar-titulo"
        className="w-full max-w-md rounded-placa border border-plata/60 bg-tinta-alta p-5"
      >
        <div className="flex items-start gap-3">
          <Anillo className="shrink-0 text-hierro" diametro={32} />
          <h2 id="confirmar-titulo" className="font-titulo text-chico text-hueso">
            {titulo}
          </h2>
        </div>

        <div className="mt-3 space-y-2 font-interfaz text-chico text-plata">{children}</div>

        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Boton
            variante="secondary"
            type="button"
            onClick={onCancel}
            className="sm:min-w-32"
            // El foco arranca en **Cancelar**, no en la acción: si el diálogo se abre
            // con Enter por una fila de la tabla, el primer Enter tiene que poder
            // abortar. Es el default seguro en un panel donde casi todas las acciones
            // son destructivas.
            autoFocus
          >
            Cancelar
          </Boton>
          <Boton
            type="button"
            onClick={() => void onConfirm()}
            cargando={ocupado}
            className={destructivo ? 'border-sangre-honda sm:min-w-48' : 'sm:min-w-48'}
          >
            {textoConfirmar}
          </Boton>
        </div>
      </div>
    </div>
  );
}
