import type { ReactNode } from 'react';
import { Anillo } from '../ornaments/Anillo';
import { Grano } from '../ornaments/Grano';
import { Malla } from '../ornaments/Malla';
import { useMarca } from '../marca';
import { PRODUCTO } from '@/lib/marca';

/**
 * `Marco`: el marco de las pantallas del portal con sesion.
 *
 * Reúne lo que las cinco pantallas de la Fase 07 repiten —fondo con `malla` y
 * `grano`, anillo, wordmark, `Costura`— y sobre todo garantiza dos cosas que si
 * cada pagina las hiciera por su cuenta se desuniformarian en dos commits:
 *
 *   1. **El mismo nivel de tema por zona.** El marco es tema **alto** (el anillo,
 *      el wordmark, la `Costura` del encabezado) y el contenido es lo que cada
 *      pantalla baja a su nivel: "bajo" en las tablas y los formularios del panel,
 *      "medio" en las placas del lanzador. Es la division de `estetica-tourniquet.md`
 *      §2 hecha un solo vez.
 *   2. **El velo detras del wordmark.** El `Anillo` y el nombre van sobre `tinta`
 *      con la `Malla` y el `Grano` encima, y el texto del wordmark es el unico que
 *      se apoya directo en esa superficie. Por eso la superficie del encabezado es
 *      la unica que lleva las texturas: el contenido va sobre placas opacas.
 *
 * No es un componente de layout de Next (`layout.tsx`): cada pantalla del portal
 * tiene su propio marco porque cada una decide su propio nivel de tema y su
 * propio encabezado, y un `layout` compartido obligaria a meter props de todo
 * tipo para dos pantallas que no se parecen.
 */
export function Marco({
  titulo,
  descripcion,
  children,
  acciones,
}: {
  /** `h1` de la pantalla. En `Cinzel` (`.font-titulo`), nunca en blackletter. */
  titulo: string;
  /** Bajada del titulo. Una linea, en `EB Garamond` (`.font-cuerpo`). */
  descripcion?: string;
  acciones?: ReactNode;
  children: ReactNode;
}) {
  const { nombre } = useMarca();

  return (
    <div className="relative flex min-h-dvh flex-col">
      {/*
        La superficie con textura, detras de todo y sin capturar eventos.

        `ornamento-textura` es la clase que la estetica `austero` apaga
        (`globals.css`). Va en el contenedor y no en `Malla`/`Grano` por dos
        motivos: son dos superficies de pantalla completa y apagarlas por
        `display: none` tiene que ser una regla, no un `if` en JS; y el
        contenedor es el unico lugar donde se ve que `Malla` y `Grano` son la
        misma capa y no dos texturas distintas.
      */}
      <div aria-hidden className="ornamento-textura pointer-events-none absolute inset-0 overflow-hidden">
        <Malla />
        <Grano />
      </div>

      <a
        href="#contenido"
        className="foco-brasa sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-10 focus:rounded-campo focus:border focus:border-plata focus:bg-tinta-alta focus:px-3 focus:py-2 focus:font-interfaz focus:text-chico focus:text-hueso"
      >
        Saltear al contenido
      </a>

      <header className="relative border-b border-hierro px-4 py-5 sm:px-6">
        <div className="mx-auto flex w-full max-w-5xl items-center gap-4">
          <Anillo className="text-hierro" diametro={48} />
          <div>
            {/*
              El wordmark es `h1` solo en `/login` (que es su pagina). Aca es un
              `p`: el `h1` de esta pantalla es el tituto de la vista, y dos `h1` en
              un documento hacen que un lector de pantalla anuncie la pagina dos
              veces.

              Y es el **nombre del cliente**, por el mismo motivo que en `/login`
              (`estetica-tourniquet.md` §11): el encabezado de cada pantalla es la
              unica parte del portal que esta presente en todas, y si dice
              "Tourniquet" el que administra tiene veinte pestanas abiertas y
              ninguna dice de que empresa es.
            */}
            <p className="truncate font-wordmark text-2xl tracking-wide text-hueso">{nombre}</p>
            <p className="font-interfaz text-menor text-plata">{PRODUCTO}</p>
          </div>
          {acciones ? <div className="ml-auto flex items-center gap-2">{acciones}</div> : null}
        </div>
      </header>

      <main id="contenido" className="relative mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-6">
        <h1 className="font-titulo text-2xl font-normal text-hueso sm:text-3xl">{titulo}</h1>
        {descripcion ? (
          <p className="mt-2 max-w-2xl font-cuerpo text-cuerpo text-plata">{descripcion}</p>
        ) : null}
        <div className="mt-6">{children}</div>
      </main>

      <footer className="relative border-t border-hierro px-4 py-4 sm:px-6">
        <p className="mx-auto w-full max-w-5xl font-interfaz text-menor text-plata">
          Identidad central de la suite. Ningun token queda guardado en este
          navegador: la sesion viaja en una cookie del servidor.
        </p>
      </footer>
    </div>
  );
}

/**
 * Estado de carga de una pantalla del portal.
 *
 * La mancha de tinta expanding (`motion.ts` §6) y **nada** de skeleton: un skeleton
 * reserva el lugar del contenido que todavia no existe, y en el lanzador ese lugar
 * es una lista cuya altura no se conoce. Con el esqueleto puesto, la pantalla
 * "salta" cuando llegan los datos; con la mancha, no.
 */
export function Cargando({ texto = 'Cargando' }: { texto?: string }) {
  return (
    <div className="flex items-center gap-3 py-10" role="status">
      <span aria-hidden className="relative inline-flex h-4 w-4 items-center justify-center">
        <span className="absolute h-4 w-4 rounded-full bg-brasa motion-safe:animate-[tourniquet-tinta_900ms_ease-in-out_infinite]" />
        <span className="h-1.5 w-1.5 rounded-full bg-brasa" />
      </span>
      <span className="font-interfaz text-chico text-plata">{texto}</span>
    </div>
  );
}
