'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { Boton } from '@/design/components/Boton';
import { Cargando } from '@/design/components/Marco';
import { Placa } from '@/design/ornaments/Placa';
import { Costura } from '@/design/ornaments/Costura';
import { Anillo } from '@/design/ornaments/Anillo';
import { leerApps, type AppLanzador } from '@/lib/api';

/**
 * `/apps/puerta?app=<codigo>`: la pantalla de puerta.
 *
 * Existe por un motivo concreto: el deep-link a un IdP se abre en pestaña nueva o
 * en la misma, y el usuario necesita **ver a donde va antes de que su identidad
 * salga del portal**. Sin esta pantalla, el 302 a la app se siente como un salto
 * del portal a un tercero sin explicación — y el portal es un IdP corporativo, no
 * un sitio de noticias: el usuario tiene que poder ver a qué datos entra.
 *
 * Lo que muestra, y lo que **no**:
 *
 *   - el nombre de la app y su `codigo`;
 *   - el cliente y la **base de la que va a leer los datos**. El nombre de la base
 *     y nunca el host, el usuario o la credencial (`specs/01` §6);
 *   - una cuenta regresiva de 5 s con boton de "Entrar ahora";
 *   - un link para volver al lanzador sin entrar.
 *
 * **Lo que no hace es armar el pedido OIDC.** De la puerta sale un
 * `window.location.assign(app.inicio)`, y de ahi la app inicia su propio flujo
 * (su `state`, su challenge, su callback). El motivo es de PKCE y esta escrito en
 * `specs/01` §1.2: el `code` vuelve al `redirect_uri` de la app y solo puede
 * canjearlo quien creo el `code_challenge`. Si el portal lo armara, el canje
 * fallaria — y si se lo pasara a la app, seria un secreto en la barra de
 * direcciones.
 *
 * **La ruta es una sola, con el codigo en la query, y no `/apps/[codigo]`.** Con
 * `output: 'export'` una ruta dinamica exige `generateStaticParams`, o sea que los
 * codigos de app hay que conocerlos **en el build**: una app nueva no apareceria
 * hasta que se vuelva a compilar, y el listado de apps sale de la base en runtime.
 * El `codigo` viaja en la URL y lo valida el backend (el authorize vuelve a
 * comparar el `redirect_uri` contra el registro), asi que no es una entrada que
 * RHPro pueda usar para otra cosa.
 *
 * La cuenta regresiva se limpia en el `cleanup` del efecto (trampa 2 de la fase
 * 07): con export estatico la navegacion es cliente puro, y un `setTimeout` que
 * sobrevive al desmontaje redirige desde una pantalla que ya no existe.
 */
const CUENTA_REGRESIVA_SEG = 5;

function Puerta() {
  const router = useRouter();
  const parametros = useSearchParams();
  const codigo = parametros.get('app');

  const [app, setApp] = useState<AppLanzador | null>(null);
  const [faltante, setFaltante] = useState(false);
  const [restante, setRestante] = useState(CUENTA_REGRESIVA_SEG);
  const [cargando, setCargando] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // La app se busca en la lista habilitada del usuario, no en un catalogo: si el
  // backend dejo de habilitarla entre el clic y esta pantalla, el resultado es
  // "no la ves" y no una app que el portal ofrece y el authorize va a rechazar.
  useEffect(() => {
    let vigente = true;

    async function cargar(): Promise<void> {
      if (!codigo) {
        setFaltante(true);
        setCargando(false);
        return;
      }
      try {
        const apps = await leerApps();
        if (!vigente) {
          return;
        }
        const encontrada = apps.find((a) => a.codigo === codigo) ?? null;
        setApp(encontrada);
        setFaltante(!encontrada);
      } catch {
        if (vigente) {
          setFaltante(true);
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
  }, [codigo]);

  // La cuenta regresiva arranca **despues** de saber que hay una app: si la lista
  // tarda dos segundos en llegar, arrancar el reloj antes haria que el usuario
  // pueda caer en la app antes de haber leido que app es.
  useEffect(() => {
    if (!app || restante <= 0) {
      return;
    }

    timer.current = setTimeout(() => setRestante((r) => r - 1), 1000);
    return () => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, [app, restante]);

  // El ultimo segundo dispara la salida. Va en un efecto aparte del reloj para que
  // "quedan 0" y "navego" no sean el mismo estado: si el reloj se limpia al
  // desmontar, la navegacion tampoco.
  useEffect(() => {
    if (!app || restante > 0) {
      return;
    }
    window.location.assign(app.inicio);
  }, [app, restante]);

  if (cargando) {
    return (
      <main className="flex min-h-dvh items-center justify-center">
        <Cargando texto="Abriendo la puerta" />
      </main>
    );
  }

  if (faltante || !app) {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col items-center justify-center gap-6 px-4 text-center">
        <Anillo className="text-hierro" diametro={72} />
        <h1 className="font-titulo text-2xl font-normal text-hueso">Esa aplicación no está disponible</h1>
        <p className="font-cuerpo text-cuerpo text-plata">
          {codigo
            ? `No tenés habilitada la aplicación "${codigo}" en este cliente, o dejó de estarlo.`
            : 'La dirección no dice qué aplicación es.'}
        </p>
        <Link
          href="/"
          className="foco-brasa inline-flex min-h-tactil items-center rounded-campo border border-plata/60 px-4 py-2 font-interfaz text-chico text-hueso hover:bg-hierro"
        >
          Volver al lanzador
        </Link>
      </main>
    );
  }

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 flex flex-col items-center text-center">
          <Anillo className="text-hierro" diametro={56} />
          <h1 className="mt-4 font-titulo text-2xl font-normal text-hueso">Entrar a {app.nombre}</h1>
          <p className="mt-1 font-codigo text-menor text-plata">{app.codigo}</p>
        </div>

        <Placa className="trama-peltre">
          {/*
            Los hechos, en `Inter` sobre la placa opaca, y no en `Cinzel`: esta es
            la parte que el usuario **lee** antes de decidir (estetica §2, regla 1).
          */}
          <p className="font-interfaz text-chico text-hueso">
            Vas a entrar a <span className="text-brasa">{app.nombre}</span>.
          </p>

          <Costura className="my-4" />

          <dl className="space-y-3 font-interfaz text-chico">
            <div>
              <dt className="text-plata">Datos de la organización</dt>
              <dd className="text-hueso">
                {app.base ? (
                  <>
                    Lee los datos de <span className="font-codigo">{app.base}</span>
                  </>
                ) : (
                  'No usa una base de datos propia'
                )}
              </dd>
            </div>
            <div>
              <dt className="text-plata">Tu sesión</dt>
              <dd className="text-hueso">
                No te va a pedir la clave. Vas a ver la pantalla de consentimiento y,
                si la aceptás, entrás.
              </dd>
            </div>
          </dl>

          {/*
            El boton va deshabilitado hasta que la app este cargada, y el contador
            en `aria-live` para que un lector de pantalla anuncie el tiempo que
            falta. Con `prefers-reduced-motion` el contador sigue corriendo: es un
            temporizador, no una animacion, y saltarselo seria quitarle al usuario
            el control sobre la salida.
          */}
          <p aria-live="polite" className="mt-5 font-interfaz text-menor text-plata">
            {restante > 0 ? `Sale solo en ${restante} s` : 'Entrando…'}
          </p>

          <Boton
            className="mt-3 w-full"
            type="button"
            onClick={() => app && window.location.assign(app.inicio)}
          >
            Entrar ahora
          </Boton>

          <Link
            href="/"
            className="foco-brasa mt-4 flex min-h-tactil items-center justify-center rounded-campo px-3 font-interfaz text-menor text-plata hover:text-hueso"
          >
            Volver al lanzador sin entrar
          </Link>
        </Placa>
      </div>
    </main>
  );
}

/**
 * `useSearchParams()` en una pagina prerenderizada obliga a la pagina entera a
 * postponerse al cliente, y Next 14 aborta el build si no hay un `<Suspense>`
 * alrededor. El fallback es el marco de la puerta sin la app: el anillo y el
 * wordmark, que es lo que el usuario ve mientras llega el JavaScript.
 */
export default function PaginaPuerta() {
  return (
    <Suspense fallback={<Cargando texto="Abriendo la puerta" />}>
      <Puerta />
    </Suspense>
  );
}
