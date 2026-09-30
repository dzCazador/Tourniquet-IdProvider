'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Boton } from '@/design/components/Boton';
import { Costura } from '@/design/ornaments/Costura';
import { Anillo } from '@/design/ornaments/Anillo';
import { cerrarSesion, leerSesion, type EstadoSesion } from '@/lib/api';

/**
 * Raiz del portal.
 *
 * En esta fase **no** es el lanzador: la lista de apps habilitadas es la Fase
 * 07, y lo unico que hay que probar aca es que la sesion central existe y se
 * puede cerrar. Lo que se muestra es deliberadamente magro y sobrio, porque
 * esta pantalla se va a reemplazar casi entera en la 07; la idea es que nadie
 * se acostumbre a una UI que va a cambiar.
 */
export default function Raiz() {
  const router = useRouter();
  const [estado, setEstado] = useState<EstadoSesion | null>(null);
  const [cargando, setCargando] = useState(true);
  const [saliendo, setSaliendo] = useState(false);

  useEffect(() => {
    let vigente = true;
    void leerSesion()
      .then((sesion) => {
        if (!vigente) {
          return;
        }
        setEstado(sesion);
        if (!sesion) {
          router.replace('/login');
        }
      })
      .finally(() => {
        if (vigente) {
          setCargando(false);
        }
      });
    return () => {
      vigente = false;
    };
  }, [router]);

  async function salir(): Promise<void> {
    setSaliendo(true);
    try {
      await cerrarSesion();
    } finally {
      router.replace('/login');
    }
  }

  if (cargando || !estado) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <Anillo className="text-hierro" diametro={72} />
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-xl flex-col items-center justify-center px-6 py-16 text-center">
      <Anillo className="text-hierro" diametro={84} />
      <h1 className="mt-5 font-wordmark text-4xl text-hueso">Tourniquet</h1>
      <Costura className="my-7 w-full" />

      <p className="font-interfaz text-chico text-plata">
        Sesion abierta como <span className="text-hueso">{estado.nombre}</span> para{' '}
        <span className="text-hueso">{estado.clienteActual.nombre}</span>.
      </p>

      <p className="mt-4 max-w-md font-interfaz text-menor text-plata">
        El listado de aplicaciones llega en una fase posterior. Esta pantalla todavia es tecnica.
      </p>

      <div className="mt-8 flex flex-wrap justify-center gap-3">
        <Boton variante="primary" onClick={salir} cargando={saliendo} type="button">
          Cerrar sesion del portal
        </Boton>
        {/*
          El inspector de token SOLO en desarrollo.

          `process.env.NODE_ENV` lo reemplaza Next por la cadena literal en el
          bundle, asi que esto se resuelve en build y la rama `production` se
          elimina por dead-code elimination. Sin el filtro, un build de
          produccion muestra un enlace a `/dev/token` que **no existe** -- la
          pagina da `notFound()` y `quitar-rutas-dev.mjs` borra `out/dev`-- y
          el usuario caeria en un 404 desde un botón que el propio producto
          puso. Un enlace a una pagina que no se sirvio no es un detalle
          cosmetico: es la promesa de una pantalla que no esta ahi.
        */}
        {process.env.NODE_ENV !== 'production' ? (
          <a
            href="/dev/token"
            className="foco-brasa inline-flex min-h-tactil items-center rounded-campo border border-plata/60 px-4 py-2 font-interfaz text-chico text-hueso hover:bg-tinta-alta"
          >
            Inspeccionar token
          </a>
        ) : null}
      </div>
    </main>
  );
}
