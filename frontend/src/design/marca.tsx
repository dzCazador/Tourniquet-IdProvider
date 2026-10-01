'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { VAR_ACENTO, type Estetica } from './tokens';
import { MARCA_POR_DEFECTO, PRODUCTO, leerMarca, type Marca } from '@/lib/marca';

/**
 * Proveedor de la marca: el nombre del cliente y el tema, en toda la pagina.
 *
 * Se monta en `layout.tsx` y no en cada pantalla porque el dato es de la
 * **instalacion**, no de la vista: el mismo nombre y el mismo acento en el login,
 * en el lanzador y en el panel. Y porque hay que aplicarlo una sola vez, al
 * `<html>`, que es el unico elemento del que heredan las variables CSS.
 *
 * `design/marca.tsx` y no `lib/marca.ts` porque aplicar el tema es lo unico que
 * toca el DOM: `lib/marca.ts` hace el `fetch` y no sabe que existe un
 * `document`. La division es la misma que hay entre `lib/api.ts` y
 * `design/components/`.
 */

interface ContextoMarca {
  /** Nombre a mostrar como wordmark: el del cliente, o el del producto. */
  nombre: string;
  /** El nombre del cliente, o `null`. Para textos que digan "de tu organizacion". */
  cliente: string | null;
  tema: { estetica: Estetica; color_acento: string };
}

const Contexto = createContext<ContextoMarca>({
  nombre: PRODUCTO,
  cliente: null,
  tema: MARCA_POR_DEFECTO.tema,
});

/**
 * Pinta el tema en el `<html>`.
 *
 * Hace **dos** cosas y no una, y por eso estan juntas en la misma funcion:
 *
 *   1. `--color-acento` al valor del cliente. Es la unica variable de color que
 *      existe, y la escriben todos los `bg-oxblood` / `stroke-oxblood` /
 *      `text-oxblood` del portal sin que ningun componente sepa que hay un
 *      cliente del otro lado (`estetica-tourniquet.md` §11).
 *   2. `data-estetica`, que es lo que leen las reglas de `austero` de
 *      `globals.css` para apagar la textura.
 *
 * El atributo va en `<html>` y no en `<body>` a proposito: las reglas de la
 * austera usan `html[data-estetica=...] .trama-peltre`, y un selector de ancestro
 * con atributo sobre `<body>` obligaria a que el atributo existiera antes de que
 * se pueda aplicar. Ademas `display: none` sobre un ancestro de `<body>`
 * apaga la pagina entera si algo sale mal.
 */
function aplicar(tema: { estetica: Estetica; color_acento: string }): void {
  const raiz = document.documentElement;
  raiz.style.setProperty(VAR_ACENTO, tema.color_acento);
  raiz.setAttribute('data-estetica', tema.estetica);
}

export function ProveedorMarca({ children }: { children: ReactNode }) {
  // El estado arranca en la marca por defecto, no en `null`: la pagina tiene que
  // pintar en el primer frame, y `gothic` es lo que hay en `:root` antes de que
  // llegue nada. Con `null` habria que decidir que se dibuja mientras carga, y
  // la unica respuesta correcta es la misma que se dibuja si nunca llega.
  const [marca, setMarca] = useState<Marca>(MARCA_POR_DEFECTO);

  useEffect(() => {
    let vigente = true;

    void leerMarca().then((leida) => {
      if (!vigente) {
        return;
      }
      setMarca(leida);
      aplicar(leida.tema);
    });

    return () => {
      vigente = false;
    };
  }, []);

  useEffect(() => {
    // El `document.title` tambien es de la instalacion, y el export estatico lo
    // deja fijo en el HTML. `/login` es la pestana donde el empleado va a
    // quedarse con el portal abierto: que diga "Cerveceria Cervi - Tourniquet"
    // y no "Tourniquet" es la diferencia entre encontrar la pestana entre veinte
    // y no encontrarla.
    const titulo = marca.cliente ? `${marca.cliente} · ${PRODUCTO}` : PRODUCTO;
    document.title = titulo;
  }, [marca.cliente]);

  return (
    <Contexto.Provider
      value={{
        nombre: marca.cliente ?? PRODUCTO,
        cliente: marca.cliente,
        tema: marca.tema,
      }}
    >
      {children}
    </Contexto.Provider>
  );
}

/**
 * La marca de la pagina. **No tira nunca si falta el proveedor**: devuelve la
 * marca por defecto. Un `useContext` sin provider que se queja obliga a que cada
 * pantalla que use el hook tenga que acordarse de envolverla, y basta una para
 * que el portal entero se caiga.
 */
export function useMarca(): ContextoMarca {
  return useContext(Contexto);
}
