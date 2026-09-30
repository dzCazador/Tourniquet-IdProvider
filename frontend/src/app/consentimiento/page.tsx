'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { Boton } from '@/design/components/Boton';
import { Cargando } from '@/design/components/Marco';
import { Anillo } from '@/design/ornaments/Anillo';
import { Costura } from '@/design/ornaments/Costura';
import { Placa } from '@/design/ornaments/Placa';
import { consentir, ErrorConsentimiento, leerConsentimiento, type DatosConsentimiento } from '@/lib/api';

/**
 * `/consentimiento`: la pantalla de consentimiento del IdP.
 *
 * La abre `GET /oidc/authorize` cuando el usuario ya tiene sesion central. Aca
 * esta la razon por la que esta pantalla **no** es "un modal en el lanzador" (trampa
 * 3 de la fase 07): el `code` se emite en `POST /oidc/consentir`, o sea que si el
 * usuario recarga la pagina no hay nada que recuperar y no hay estado raro que
 * limpiar — se vuelve a pedir el consentimiento y listo. Un modal sobre la misma
 * pantalla del authorize, en cambio, se rompe con un F5.
 *
 * El contenido es **facts-first** (la "rebanada" de `estetica-tourniquet.md` §7):
 * quien es la app, que recibe y que **no** recibe. Nada de copy persuasivo, nada de
 * "confia en nosotros". La linea que guia la pantalla es *"you never ever believed
 * in me"* (spec §1): el portal no pide fe, muestra los hechos.
 *
 * Lo que la pantalla deliberadamente **no** dice: nada de permisos, nada de
 * perfiles, nada de "tu rol". El token no lleva permisos de negocio (D2 de
 * `specs/00`) y una pantalla que los insinua hace creer que el portal los maneja.
 *
 * El `code_challenge` viaja en la URL de esta pantalla y se reenvia al
 * `consentir`. Es lo correcto: es el hash publico de un verifier que esta en el
 * navegador de la app, no un secreto, y el backend lo revalida igual
 * (`specs/01` §1.1).
 */
function Consentimiento() {
  const parametros = useSearchParams();

  const [datos, setDatos] = useState<DatosConsentimiento | null>(null);
  const [error, setError] = useState<{ codigo: string; mensaje: string } | null>(null);
  const [cargando, setCargando] = useState(true);
  const [aceptando, setAceptando] = useState(false);
  const enviado = useRef(false);

  // El pedido tal cual vino del authorize. Se relee del `searchParams` y no de un
  // estado, porque esta pagina se puede recargar y el estado no sobrevive.
  const pedido = (() => {
    const params = new URLSearchParams();
    for (const clave of [
      'response_type',
      'client_id',
      'redirect_uri',
      'state',
      'code_challenge',
      'code_challenge_method',
      'scope',
    ]) {
      const valor = parametros.get(clave);
      if (valor !== null) {
        params.set(clave, valor);
      }
    }
    return Object.fromEntries(params.entries());
  })();

  const clientId = pedido.client_id ?? '';

  useEffect(() => {
    let vigente = true;

    async function cargar(): Promise<void> {
      if (!clientId || !pedido.redirect_uri || !pedido.state || !pedido.code_challenge) {
        setError({
          codigo: 'invalid_request',
          mensaje: 'El enlace de ingreso no está completo. Volvé a entrar desde el lanzador.',
        });
        setCargando(false);
        return;
      }

      try {
        const hechos = await leerConsentimiento(clientId);
        if (vigente) {
          setDatos(hechos);
        }
      } catch (fallo) {
        if (!vigente) {
          return;
        }
        if (fallo instanceof ErrorConsentimiento) {
          setError({ codigo: fallo.codigo, mensaje: mensajeDe(fallo.codigo) });
        } else {
          setError({ codigo: 'server_error', mensaje: mensajeDe('server_error') });
        }
      } finally {
        if (vigente) {
          setCargando(false);
        }
      }
    }

    void cargar();
    // `pedido` se reconstruye en cada render; la dependencia real es el `client_id`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId]);

  async function aceptar(): Promise<void> {
    if (enviado.current) {
      return;
    }
    enviado.current = true;
    setAceptando(true);
    setError(null);

    try {
      const url = await consentir(pedido);
      // Salida del sitio: es la URL registrada de la app, y la validacion la hizo
      // el backend dos veces (en el authorize y en el consentir).
      window.location.assign(url);
    } catch (fallo) {
      const codigo = fallo instanceof ErrorConsentimiento ? fallo.codigo : 'server_error';
      setError({ codigo, mensaje: mensajeDe(codigo) });
      setAceptando(false);
      enviado.current = false;
    }
  }

  if (cargando) {
    return (
      <main className="flex min-h-dvh items-center justify-center">
        <Cargando texto="Comprobando el ingreso" />
      </main>
    );
  }

  if (error && !datos) {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col items-center justify-center gap-6 px-4 text-center">
        <Anillo className="text-hierro" diametro={72} />
        <h1 className="font-titulo text-2xl font-normal text-hueso">No pudimos preparar el ingreso</h1>
        <p className="font-cuerpo text-cuerpo text-plata">{error.mensaje}</p>
        <Link
          href="/"
          className="foco-brasa inline-flex min-h-tactil items-center rounded-campo border border-plata/60 px-4 py-2 font-interfaz text-chico text-hueso hover:bg-hierro"
        >
          Volver al lanzador
        </Link>
      </main>
    );
  }

  if (!datos) {
    return null;
  }

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 flex flex-col items-center text-center">
          <Anillo className="text-hierro" diametro={56} />
          <h1 className="mt-4 font-titulo text-2xl font-normal text-hueso">
            Aceptás el ingreso de <span className="text-brasa">{datos.app.nombre}</span>
          </h1>
          <p className="mt-1 font-codigo text-menor text-plata">{datos.app.codigo}</p>
        </div>

        <Placa className="trama-peltre">
          {/*
            Los cuatro renglones de hechos. El primero es quien es la app, el
            segundo que recibe, el tercero que NO recibe (el que evita la sorpresa
            de "mi sesion de RHPro dice que tengo permisos de RRHH que no pedi") y el
            cuarto la duracion.
          */}
          <dl className="space-y-4 font-interfaz text-chico">
            <div>
              <dt className="text-plata">Aplicación</dt>
              <dd className="text-hueso">
                {datos.app.nombre} · <span className="font-codigo">{datos.app.codigo}</span>
                {datos.base ? (
                  <>
                    {' '}
                    — lee los datos de <span className="font-codigo">{datos.base}</span>
                  </>
                ) : null}
              </dd>
            </div>
            <div>
              <dt className="text-plata">Qué recibe</dt>
              <dd className="text-hueso">Tu nombre de usuario y tu identificador interno.</dd>
            </div>
            <div>
              <dt className="text-plata">Qué no recibe</dt>
              <dd className="text-hueso">
                Tus contraseñas, tus permisos de negocio ni los datos de otras
                aplicaciones. La organización es <span className="text-hueso">{datos.cliente.nombre}</span>.
              </dd>
            </div>
            <div>
              <dt className="text-plata">Cuánto dura</dt>
              <dd className="text-hueso">
                Hasta que cierres sesión o que alguien la cierre desde el panel de
                administración.
              </dd>
            </div>
          </dl>

          <Costura className="my-5" />

          {error ? (
            <p role="alert" className="mb-4 font-interfaz text-chico text-sangre">
              {error.mensaje}
            </p>
          ) : null}

          <div className="flex flex-col gap-2 sm:flex-row">
            <Boton className="sm:flex-1" type="button" onClick={() => void aceptar()} cargando={aceptando}>
              Entrar
            </Boton>
            {/*
              Cancelar **no** es un POST: no hay endpoint al que llamar. Vuelve al
              lanzador con un simple `Link`, y lo que queda es que no se emitio
              ningun `code` — no hay sesion de la app que cerrar, ni refresh que
              revocar, ni fila que limpiar (`specs/01` §1.1).
            */}
            <Link
              href="/"
              className="foco-brasa inline-flex min-h-tactil items-center justify-center rounded-campo border border-plata/60 px-4 py-2 font-interfaz text-chico text-hueso hover:bg-hierro sm:flex-1"
            >
              Cancelar
            </Link>
          </div>
        </Placa>
      </div>
    </main>
  );
}

/**
 * Texto de cada codigo de error del consentimiento.
 *
 * Lista cerrada y en el portal, como en `/login`: el backend manda codigos y el
 * front decide el texto. Los tres que importan son `access_denied` (te sacaron la
 * habilitacion entre medio), `login_required` (la sesion central se cayo) y
 * `sin_conexion` (el servicio esta caido, y reintentar no sirve).
 */
function mensajeDe(codigo: string): string {
  switch (codigo) {
    case 'access_denied':
      return 'Tu usuario no está habilitado para esta aplicación en este cliente.';
    case 'login_required':
      return 'Tu sesión del portal no está activa. Volvé a entrar desde el lanzador.';
    case 'unauthorized_client':
      return 'Esta aplicación no está disponible para tu organización.';
    case 'invalid_request':
      return 'El enlace de ingreso no es válido. Volvé a entrar desde el lanzador.';
    case 'portal_no_configurado':
      return 'El servicio de identidad no tiene configurada la pantalla de ingreso.';
    case 'sin_conexion':
      return 'No pudimos comunicarnos con el servicio de identidad. Revisá tu conexión o avisale a quien administra el sistema.';
    default:
      return 'No pudimos completar el ingreso. Reintentá en un momento.';
  }
}

export default function PaginaConsentimiento() {
  return (
    <Suspense fallback={<Cargando texto="Comprobando el ingreso" />}>
      <Consentimiento />
    </Suspense>
  );
}
