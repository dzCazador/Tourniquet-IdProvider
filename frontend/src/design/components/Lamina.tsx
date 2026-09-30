import type { ReactNode } from 'react';
import { Anillo } from '../ornaments/Anillo';
import { Costura } from '../ornaments/Costura';

/**
 * `Lamina`: la pantalla de 404 y de 500.
 *
 * Es el unico lugar donde `estetica-tourniquet.md` §7 autoriza el tema al
 * limite, y aun asi el mensaje es **funcional**: "esta pagina no existe" y
 * "algo fallo de nuestro lado", con una accion concreta. Un 500 que dice
 * "tourniquet se النار" no ayuda a nadie a las 3 de la mañana; uno que dice
 * "volve a intentar en un minuto" si.
 *
 * El codigo HTTP va en `Cinzel` y grande porque es lo unico que el usuario
 * necesita leer de esa pantalla; el cuerpo va en `Inter`, porque es texto de
 * lectura, no adorno.
 */
export function Lamina({
  codigo,
  titulo,
  children,
  accion,
}: {
  codigo: string;
  titulo: string;
  children?: ReactNode;
  accion?: ReactNode;
}) {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-xl flex-col items-center justify-center px-6 py-16">
      <Anillo className="text-hierro" diametro={112} />

      <p className="mt-8 font-titulo text-6xl tracking-widest text-hueso" aria-hidden>
        {codigo}
      </p>
      {/* El codigo tambien existe para el lector de pantalla: el `aria-hidden`
          de arriba es solo para que no se lea dos veces. */}
      <h1 className="sr-only">
        {codigo}: {titulo}
      </h1>

      <Costura className="my-6 w-full max-w-64" />

      <p className="text-center font-interfaz text-chico text-plata">{titulo}</p>
      {children ? <div className="mt-3 text-center text-chico text-plata">{children}</div> : null}
      {accion ? <div className="mt-8">{accion}</div> : null}
    </main>
  );
}
