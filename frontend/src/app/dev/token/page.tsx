import { notFound } from 'next/navigation';
import { InspectorToken } from './inspector';

/**
 * `/dev/token` — el acceso a la pagina, no la pagina.
 *
 * `estetica-tourniquet.md` §1.1 y el criterio de aceptacion de `fase-04` §6
 * piden que en un build de produccion **la ruta no exista**. Con
 * `output: 'export'` no hay servidor que pueda responder 404 por codigo, asi
 * que la unida forma de que la ruta no exista es que Next no la escriba: y eso
 * es lo que hace `notFound()` en un Server Component durante el prerender.
 *
 * Por que es un Server Component y no un `'use client'` con un `if`: en un
 * componente cliente, `NODE_ENV` se reemplaza por la cadena literal en el
 * bundle del navegador, y el chequeo pasaria a ser de RUNTIME -- con lo que
 * el HTML prerenderizado (que es lo que se sirve) seguiria mostrando el
 * formulario. Aca el `if` se evalua en el build, que es donde tiene que
 * evaluarse.
 *
 * El contenido vive en `inspector.tsx` para que el corte sea de una sola rama
 * y no de todo el modulo.
 */
export const dynamic = 'force-static';

export default function PaginaDevToken() {
  if (process.env.NODE_ENV === 'production') {
    notFound();
  }

  return <InspectorToken />;
}
