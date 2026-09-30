'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { CabeceraPortal } from '../_portal/CabeceraPortal';
import { Cargando } from '@/design/components/Marco';
import { Costura } from '@/design/ornaments/Costura';
import { Sello } from '@/design/ornaments/Sello';
import { leerYo, type QuienSoy } from '@/lib/api';

/**
 * Marco del panel `admin_identidad`: cabecera del portal + navegación de secciones
 * + contenido.
 *
 * Cuatro diferencias con el marco del portal, y las tres primeras importan:
 *
 *  1. **El cliente es fijo y visible.** Un admin de `cervi` administra `cervi` y nada
 *     más: el `AdminGuard` opera sobre el `idcliente` de la sesion, sin selector (si
 *     el usuario administra varios clientes, los cambia desde el portal, que
 *     re-emite la sesion). El nombre del cliente con su `codigo` va en la cabecera de
 *     cada pantalla, porque en una pantalla con tablas el nombre del cliente es el
 *     dato que evita el error más caro del panel: operar sobre el tenant
 *     equivocado.
 *  2. **Navegación con `Link` y recarga con `window.location`**, nunca
 *     `router.refresh()`: con `output: 'export'` no hay servidor de render al que
 *     volver a pedir nada (misma nota que en la 07).
 *  3. **Tema medio en el marco, bajo en los datos** (estética §2): separadores
 *     `—✦—`, sello y grabados en la cabecera; tablas, formularios y valores en
 *     `Inter` sobre `tinta-alta`, sin textura.
 *
 * El panel **no** tiene una pantalla propia de "no tenés permiso": el backend ya
 * responde 403 y esta pantalla manda al lanzador, que es donde el usuario va a
 * anyways si no es admin. Una pantalla de error propia sería una pantalla más con
 * el mismo texto.
 */
export function MarcoAdmin({ titulo, children }: { titulo: string; children: ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="flex min-h-dvh flex-col">
      <CabeceraAdminInterna />

      <main className="relative mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h1 className="font-titulo text-2xl font-normal text-hueso">{titulo}</h1>
          <Sello codigo="ADM" diametro={40} />
        </div>

        <Costura className="my-5" />

        <nav aria-label="Secciones del panel" className="mb-6">
          <ul className="flex flex-wrap gap-2">
            {SECCIONES.map((seccion) => {
              const actual = pathname === seccion.ruta;
              return (
                <li key={seccion.ruta}>
                  <Link
                    href={seccion.ruta}
                    aria-current={actual ? 'page' : undefined}
                    className={`foco-brasa inline-flex min-h-tactil items-center rounded-campo border px-3 py-1 font-interfaz text-chico ${
                      actual
                        ? 'border-plata bg-tinta-alta text-hueso'
                        : 'border-transparent text-plata hover:border-plata/60 hover:text-hueso'
                    }`}
                  >
                    {seccion.titulo}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        {children}
      </main>
    </div>
  );
}

const SECCIONES = [
  { titulo: 'Resumen', ruta: '/admin' },
  { titulo: 'Usuarios', ruta: '/admin/usuarios' },
  { titulo: 'Sesiones', ruta: '/admin/sesiones' },
  { titulo: 'Auditoría', ruta: '/admin/auditoria' },
];

/**
 * La cabecera del panel, con la sesion del usuario.
 *
 * Reusa `CabeceraPortal` en vez de duplicarla: el logout, el enlace a `/mi-cuenta` y
 * el nombre del cliente son los mismos. Lo que **no** se reusa es el selector de
 * cliente, y por eso se pasa `clientes: []`: con un solo elemento, el selector no se
 * renderiza, y en el panel el cliente no se elige (ver punto 1 del comentario de
 * arriba).
 */
function CabeceraAdminInterna() {
  const router = useRouter();
  const [yo, setYo] = useState<QuienSoy | null>(null);
  const [listo, setListo] = useState(false);

  useEffect(() => {
    let vigente = true;

    void leerYo().then((quien) => {
      if (!vigente) {
        return;
      }
      setYo(quien);
      setListo(true);
      // Sin sesion, o con un rol que no es `admin_identidad` de este cliente, el
      // panel no tiene nada que mostrar. Se vuelve al lanzador: el backend responde
      // 403 igual, y esta pantalla no es un lugar para explicar un 403 que el
      // usuario no puede arreglar desde aca.
      if (!quien || quien.clienteActual.rol !== 'admin_identidad') {
        router.replace('/');
      }
    });

    return () => {
      vigente = false;
    };
  }, [router]);

  if (!listo || !yo || yo.clienteActual.rol !== 'admin_identidad') {
    return <Cargando texto="Abriendo el panel" />;
  }

  return (
    <CabeceraPortal
      nombre={yo.nombre}
      cliente={yo.clienteActual}
      clientes={[]}
      esAdmin
    />
  );
}
