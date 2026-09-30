'use client';

import Link from 'next/link';
import { Anillo } from '@/design/ornaments/Anillo';
import { aplicarMovimiento } from '@/design/motion';

/**
 * `/logout/despedida`: la pantalla de salida.
 *
 * Es la unica vista con el tema al maximo, y aun asi dice **una sola cosa**: cerraste
 * todas tus sesiones. Sin "volve pronto", sin "gracias por usar Tourniquet", sin
 * sugerencia de volver a entrar.
 *
 * La razon es de uso, no de pudor: en un IdP corporativo, una pantalla de logout
 * con copy de marketing es la primera señal de que el producto es un portal de
 * consumo, y hace que la gente dude de si cerro. "Cerraste todas tus sesiones" es un
 * hecho, y el unico boton es volver a entrar, que es la unica accion que alguien
 * que salio de todas sus apps puede querer.
 *
 * El anillo "abierto" es la entrada de pagina de `motion.ts` (escala 0.96 → 1 con
 * desenfoque de 2 px, 600 ms, una vez): el anillo se cierra en el logout, y con
 * `prefers-reduced-motion` aparece quieto.
 *
 * **No pide la clave de vuelta ni redirige al login**: si el usuario clicked
 * "volver a entrar" eso ya es `/login`, y ponerlo en un `redirect` desde aca haria
 * que un F5 lo mande al login con la sesion todavia viva en otro caso.
 */
export default function Despedida() {
  return (
    <main className="relative flex min-h-dvh flex-col items-center justify-center px-4 text-center">
      <Anillo className={`text-hierro ${aplicarMovimiento('anillo-entra')}`} diametro={96} />

      <h1 className="mt-8 font-titulo text-2xl font-normal text-hueso">
        Cerraste todas tus sesiones
      </h1>

      <p className="mt-3 max-w-md font-cuerpo text-cuerpo text-plata">
        La sesión del portal y las de todas las aplicaciones de tu cliente quedaron
        cerradas en este navegador.
      </p>

      <Link
        href="/login"
        className="foco-brasa mt-8 inline-flex min-h-tactil items-center rounded-campo border border-plata/60 bg-tinta-alta px-4 py-2 font-interfaz text-chico text-hueso hover:bg-hierro"
      >
        Volver a entrar
      </Link>
    </main>
  );
}
