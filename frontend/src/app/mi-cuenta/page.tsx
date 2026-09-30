'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { CabeceraPortal } from '../_portal/CabeceraPortal';
import { BloqueMfa } from './_mfa';
import { Boton } from '@/design/components/Boton';
import { Cargando, Marco } from '@/design/components/Marco';
import { Sello } from '@/design/ornaments/Sello';
import { Costura } from '@/design/ornaments/Costura';
import {
  cerrarSesion,
  cerrarSesionPropia,
  cerrarTodo,
  leerSesiones,
  leerYo,
  type SesionPropia,
  type QuienSoy,
} from '@/lib/api';
import { resumirNavegador } from '@/lib/user-agent';

/**
 * `/mi-cuenta`: las sesiones activas del usuario y las tres salidas.
 *
 * La pantalla existe porque las tres salidas se confunden entre si, y confundirlas
 * es el error de uso mas caro del producto (fase 07 §7):
 *
 * | Acción | Qué hace |
 * |---|---|
 * | Cerrar esta sesión (por fila) | Revoca **una** sesión: la de esa app, o la del portal |
 * | Salir del portal | Cierra la sesión central; las apps siguen vivas |
 * | Salir de todo | Cierra la sesión central **y** todas las apps de este cliente |
 *
 * Las tres estan en la misma pantalla y con textos que dicen que pasan, porque
 * "salir de todo" sin confirmacion es el que deja a la gente con la duda de si
 * cerro algo ("¿salí de RHPro? no me puedo entrar..."), y "cerrar esta sesión"
 * sin explicar cual es el que deja sesiones abiertas sin que nadie lo sepa.
 *
 * La fila de la sesión **del portal** se ofrece como "salir del portal" y no como
 * "cerrar esta sesión", aunque la operación sea la misma: cerrar la sesión que
 * estás mirando es desloguearse, y decirlo de otra forma es una sorpresa
 *olectada. El backend marca esa fila con `es_portal` justamente para que el texto
 * pueda ser distinto.
 *
 * Sin paginación, con el tope de 50 del backend: una persona tiene pocas sesiones,
 * y si aparecen muchas lo que se mira es la base (`specs/04` Fase 03).
 */
export default function MiCuenta() {
  const router = useRouter();
  const [yo, setYo] = useState<QuienSoy | null>(null);
  const [sesiones, setSesiones] = useState<SesionPropia[]>([]);
  const [hayMas, setHayMas] = useState(false);
  const [cargando, setCargando] = useState(true);
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [error, setError] = useState('');

  async function recargar(): Promise<void> {
    const lista = await leerSesiones();
    setSesiones(lista.sesiones);
    setHayMas(lista.hay_mas);
  }

  useEffect(() => {
    let vigente = true;

    async function cargar(): Promise<void> {
      try {
        const quien = await leerYo();
        if (!vigente) {
          return;
        }
        if (!quien) {
          router.replace('/login');
          return;
        }
        setYo(quien);
        const lista = await leerSesiones();
        if (vigente) {
          setSesiones(lista.sesiones);
          setHayMas(lista.hay_mas);
        }
      } catch {
        if (vigente) {
          setError('No pudimos leer tus sesiones. Reintenta en un momento.');
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

  async function cerrarUna(sesion: SesionPropia): Promise<void> {
    if (ocupado) {
      return;
    }
    const que =
      sesion.es_portal ? 'tu sesión del portal' : `la sesión de ${sesion.app}`;
    if (!window.confirm(`Se cierra ${que}. La app te va a pedir entrar otra vez. ¿Seguís?`)) {
      return;
    }
    setOcupado(sesion.sid);
    setError('');
    try {
      await cerrarSesionPropia(sesion.sid);
      if (sesion.es_portal) {
        // Cerrar la sesión del portal es desloguearse: seguir en la pagina con la
        // cookie muerta da un 401 en la siguiente llamada y parece un error.
        window.location.assign('/login');
        return;
      }
      await recargar();
    } catch {
      setError('No pudimos cerrar esa sesión. Reintenta en un momento.');
    } finally {
      setOcupado(null);
    }
  }

  async function salirDelPortal(): Promise<void> {
    if (!window.confirm('Se cierra tu sesión del portal. Las apps donde ya entraste siguen abiertas.')) {
      return;
    }
    setOcupado('portal');
    setError('');
    try {
      await cerrarSesion();
    } finally {
      window.location.assign('/login');
    }
  }

  async function salirDeTodo(): Promise<void> {
    if (
      !window.confirm(
        'Se cierra tu sesión del portal y todas las apps de este cliente, en este navegador y en los demás. Vas a tener que entrar otra vez en cada app. ¿Seguís?',
      )
    ) {
      return;
    }
    setOcupado('todo');
    setError('');
    try {
      await cerrarTodo();
    } catch {
      setError('No pudimos cerrar las sesiones. Reintenta en un momento.');
      setOcupado(null);
      return;
    }
    window.location.assign('/logout/despedida');
  }

  if (cargando || !yo) {
    return (
      <main className="flex min-h-dvh items-center justify-center">
        <Cargando texto="Abriendo tus sesiones" />
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

      <Marco
        titulo="Mis sesiones"
        descripcion={`Sesiones abiertas de ${yo.nombre} en ${yo.clienteActual.nombre}. Una sesión por aplicación.`}
      >
        {error ? (
          <p role="alert" className="mb-4 font-interfaz text-chico text-sangre">
            {error}
          </p>
        ) : null}

        {sesiones.length === 0 ? (
          <p className="font-cuerpo text-cuerpo text-plata">
            No tenés sesiones abiertas. Entrá a una app desde el lanzador y aparecerá acá.
          </p>
        ) : (
          <ul className="space-y-3">
            {sesiones.map((sesion) => (
              <li
                key={sesion.sid}
                className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-placa border border-hierro bg-tinta-alta p-4"
              >
                <Sello codigo={sesion.es_portal ? 'TQ' : sesion.app.slice(0, 3)} diametro={36} />

                <div className="min-w-0 flex-1">
                  <p className="font-titulo text-chico text-hueso">
                    {sesion.es_portal ? 'Portal' : sesion.app}
                  </p>
                  <p className="font-interfaz text-menor text-plata">
                    {resumirNavegador(sesion.user_agent)} · {sesion.ip} · desde las{' '}
                    {horaLocal(sesion.creado_en)}
                  </p>
                </div>

                <Boton
                  variante="secondary"
                  className="min-h-tactil px-3 py-1"
                  type="button"
                  cargando={ocupado === sesion.sid}
                  onClick={() => void cerrarUna(sesion)}
                  // El `aria-label` con el nombre de la app es **obligatorio** acá y
                  // no por accesibilidad formal: con cinco filas de botones iguales,
                  // un lector de pantalla anuncia "botón" cinco veces y el usuario
                  // no sabe cuál cierra cuál (trampa 5 de la fase 07).
                  aria-label={
                    sesion.es_portal
                      ? 'Salir del portal'
                      : `Cerrar la sesión de ${sesion.app}`
                  }
                >
                  {sesion.es_portal ? 'Salir del portal' : 'Cerrar esta sesión'}
                </Boton>
              </li>
            ))}
          </ul>
        )}

        {hayMas ? (
          <p className="mt-3 font-interfaz text-menor text-plata">
            Se muestran solo las 50 más recientes. Si necesitás ver el resto, avisale a
            quien administra el acceso.
          </p>
        ) : null}

        {/*
          El bloque de segundo factor va **después** de las sesiones y antes de
          las salidas, por el orden en que un usuario lo recorre: qué tiene
          abierto, cómo se protege su cuenta, cómo se sale. Va antes de las
          salidas y no después porque "salir de todo" es la última cosa que se
          toca en esa pantalla, y un bloque que obliga a releer después de
          apagar el MFA sería una trampa.
        */}
        <BloqueMfa alCambiar={recargar} />

        <Costura className="my-8" />

        {/*
          Las tres salidas, con su texto completo. La última tiene el borde de
          `sangre-honda` porque es la que no tiene vuelta atrás en el navegador: las
          otras dos se pueden rehacer entrando otra vez, esta deja a la persona
          afuera de todas las apps.
        */}
        <div className="space-y-4">
          <div>
            <Boton variante="secondary" type="button" onClick={() => void salirDelPortal()} cargando={ocupado === 'portal'}>
              Salir del portal
            </Boton>
            <p className="mt-2 font-interfaz text-menor text-plata">
              Cierra tu sesión del portal. Las apps donde ya entraste siguen abiertas.
            </p>
          </div>

          <div>
            <Boton
              type="button"
              onClick={() => void salirDeTodo()}
              cargando={ocupado === 'todo'}
              className="border-sangre-honda"
            >
              Salir de todo
            </Boton>
            <p className="mt-2 font-interfaz text-menor text-plata">
              Cierra tu sesión del portal y todas las apps de {yo.clienteActual.nombre},
              en todos los navegadores. Vas a tener que entrar otra vez en cada una.
            </p>
          </div>
        </div>
      </Marco>
    </div>
  );
}

/** `14:05` en hora local, sin segundos ni zona. */
function horaLocal(iso: string): string {
  const fecha = new Date(iso);
  if (Number.isNaN(fecha.getTime())) {
    return '—';
  }
  return fecha.toLocaleString(undefined, {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}
