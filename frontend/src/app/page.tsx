'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { CabeceraPortal } from './_portal/CabeceraPortal';
import { Cargando } from '@/design/components/Marco';
import { PlacaApp } from '@/design/components/PlacaApp';
import { Costura } from '@/design/ornaments/Costura';
import { leerApps, leerYo, type AppLanzador, type QuienSoy } from '@/lib/api';

/**
 * `/`: el lanzador. Es la pantalla de inicio del usuario (D6 de `specs/00`).
 *
 * Reemplaza la pantalla tecnica de la Fase 04, que existia para probar que la
 * sesion central se podia cerrar. Esta hace lo que hacia `Lanzador.asp` —elegir
 * cliente y abrir una app— y lo hace con las tres fuentes de datos del portal:
 * `/me` (quien sos y de que cliente), `/me/apps` (a que apps podes entrar) y nada
 * mas. **No hay una lista de todas las apps del catalogo**: lo que se ofrece es la
 * interseccion de "habilitado para vos" con "existe para este cliente", y esa
 * interseccion la calcula el backend (invariante de `AGENTS.md`).
 *
 * Los estados que la pantalla tiene que distinguir, y por que cada uno es distinto:
 *
 *   - **sin sesion** → al login, sin dejar el usuario en un circulo;
 *   - **cargando** → la mancha, sin skeleton (el alto de la lista todavia no se conoce);
 *   - **sin apps habilitadas** → un texto que dice que no tiene ninguna y a quien
 *     escribir, y **no** un error: es el estado real de un `user` recien dado de
 *     alta;
 *   - **con apps** → las placas, en rejilla de 1 a 3 columnas.
 *
 * El link de `/dev/token` que estaba en la pantalla tecnica **no** se copia: es
 * una herramienta de desarrollo y `quitar-rutas-dev.mjs` borra la pagina del
 * export (`README.md` del plan, "El frontend, a partir de la 04").
 */
export default function Lanzador() {
  const router = useRouter();
  const [yo, setYo] = useState<QuienSoy | null>(null);
  const [apps, setApps] = useState<AppLanzador[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let vigente = true;

    async function cargar(): Promise<void> {
      try {
        const quien = await leerYo();
        if (!vigente) {
          return;
        }
        if (!quien) {
          // Sin sesion central: al login. Sin `returnTo` porque esta no es una
          // pantalla a la que se vuelva: el login solo tiene que dejar al usuario
          // adentro.
          router.replace('/login');
          return;
        }

        setYo(quien);
        // Las apps se piden **despues** de saber quien es: con la sesion sola ya
        // se sabe el cliente, y sin sesion la llamada seria un 401 que la pagina
        // tendria que adivinar.
        const lista = await leerApps();
        if (vigente) {
          setApps(lista);
        }
      } catch {
        if (vigente) {
          setError('No pudimos leer tus aplicaciones. Reintenta en un momento.');
        }
      } finally {
        if (vigente) {
          setCargando(false);
        }
      }
    }

    void cargar();
    return () => {
      vigente = false;
    };
  }, [router]);

  if (cargando && !yo) {
    return (
      <main className="flex min-h-dvh items-center justify-center">
        <Cargando texto="Abriendo el lanzador" />
      </main>
    );
  }

  if (!yo) {
    return (
      <main className="flex min-h-dvh items-center justify-center px-4">
        <p role="alert" className="font-interfaz text-chico text-sangre">
          {error || 'No pudimos abrir el lanzador.'}
        </p>
      </main>
    );
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <CabeceraPortal
        nombre={yo.nombre}
        cliente={yo.clienteActual}
        clientes={yo.clientes}
        esAdmin={yo.clienteActual.rol === 'admin_identidad'}
      />

      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-6">
        <h1 className="font-titulo text-2xl font-normal text-hueso sm:text-3xl">
          Tus aplicaciones
        </h1>
        <p className="mt-2 max-w-2xl font-cuerpo text-cuerpo text-plata">
          Entrar a una app no te pide la clave: tu sesion ya esta abierta en este
          navegador.
        </p>

        <Costura className="my-6" />

        {error ? (
          <p role="alert" className="mb-4 font-interfaz text-chico text-sangre">
            {error}
          </p>
        ) : null}

        {cargando ? (
          <Cargando texto="Buscando tus aplicaciones" />
        ) : apps.length === 0 ? (
          <p className="max-w-xl font-cuerpo text-cuerpo text-plata">
            Todavia no tenes ninguna aplicacion habilitada en{' '}
            <span className="text-hueso">{yo.clienteActual.nombre}</span>. Si esperabas
            ver alguna, avisale a quien administra el acceso de tu organizacion.
          </p>
        ) : (
          <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {apps.map((app) => (
              <li key={app.codigo}>
                <PlacaApp app={app} />
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
