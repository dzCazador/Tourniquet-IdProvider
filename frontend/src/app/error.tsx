'use client';

import { useEffect } from 'react';
import { Boton } from '@/design/components/Boton';
import { Lamina } from '@/design/components/Lamina';

/**
 * Error de render del portal. Solo llega aca un fallo de JavaScript del lado del
 * cliente, no un 5xx de `tq-api`: el portal es estatico y no hay servidor que
 * pueda fallar. El texto no promete nada que el codigo no pueda cumplir, y la
 * accion es recargar, que es lo que de verdad arregla un chunk que no cargo.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // El `digest` es con lo que Next correlaciona el error del servidor con el
    // del navegador; sin el, un fallo de chunk no se puede diagnosticar. Se
    // deja en la consola del operador y no se manda a ningun lado: en un IdP
    // no hay a donde mandarlo.
    if (process.env.NODE_ENV !== 'production') {
      // eslint-disable-next-line no-console
      console.error('Fallo de render en el portal', error.digest ?? '(sin digest)');
    }
  }, [error]);

  return (
    <Lamina
      codigo="500"
      titulo="Algo fallo de nuestro lado."
      accion={
        <div className="flex flex-wrap justify-center gap-3">
          <Boton type="button" onClick={reset}>
            Reintentar
          </Boton>
          <a href="/login">
            <Boton type="button" variante="secondary">
              Ir al ingreso
            </Boton>
          </a>
        </div>
      }
    >
      <p>La sesion no se toco. Podes reintentar sin volver a ingressar.</p>
    </Lamina>
  );
}
