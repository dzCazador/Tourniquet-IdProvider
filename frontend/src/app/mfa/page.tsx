'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState, type SyntheticEvent } from 'react';
import { Boton } from '@/design/components/Boton';
import { Campo } from '@/design/components/Campo';
import { Anillo } from '@/design/ornaments/Anillo';
import { Costura } from '@/design/ornaments/Costura';
import { Placa } from '@/design/ornaments/Placa';
import {
  API_URL,
  ErrorPortal,
  verificarMfa,
  type CodigoPortal,
  type ResultadoLogin,
} from '@/lib/api';

/**
 * `/mfa`: el segundo paso del login con segundo factor (`specs/01` §8.2).
 *
 * **Tema bajo, sin excepción** (`estetica-tourniquet.md` §2 y la fila "Verificación
 * MFA" de §7): el marco es el de siempre —anillo, placa, costuras— y **todo lo
 * que hay que leer o escribir va sobrio**. Un campo de 6 dígitos con textura de
 * foil detrás no se lee, y a las 3 de la mañana en un hospital eso no es una
 * cuestión estética: es la diferencia entre entrar y no entrar.
 *
 * Los tres requisitos de la pantalla, todos de la fase 09 y todos deliberados:
 *
 *  1. **6 dígitos, `inputMode="numeric"`, `autocomplete="one-time-code"`.** El
 *     `autocomplete` es lo que hace que iOS y Android ofrezcan pegar el código
 *     que acaba de copiarse de la app de autenticación, y sin él el usuario lo
 *     tipea de memoria con 30 segundos de vida.
 *  2. **`letra de 28 px` y `text-center` con `letter-spacing`.** El tracking es lo
 *     que hace legible un campo de 6 cifras: los números pegados ("283041") son
 *     una masa y con separación son seis dígitos.
 *  3. **El foco va al campo, no al aviso de error**, y el aviso se anuncia solo
 *     por `aria-live="assertive"`. Es el mismo criterio del login (fase 04 §7.1):
 *     el Enter siguiente reenvía sin que nadie tenga que buscar el botón.
 *
 * **El `factor_id` viaja en la URL** (`?factor=...`), no en el estado del
 * componente, y es la única forma de que un F5 no rompa el ingreso: con
 * `output: 'export'` no hay estado de servidor que sobreviva a la recarga. No es
 * un token —sin el código no sirve para nada y vive 5 minutos— pero por eso
 * **no se manda `returnTo`**: el destino lo resuelve el backend desde la fila del
 * desafío, y el portal no puede decidir a dónde vuelve el usuario.
 */
function Mfa() {
  const router = useRouter();
  const parametros = useSearchParams();

  const [factor, setFactor] = useState<string | null>(null);
  const [aviso, setAviso] = useState('');
  const [codigo, setCodigo] = useState('');
  const [recuperacion, setRecuperacion] = useState(false);
  const [cargando, setCargando] = useState(false);
  const [enviado, setEnviado] = useState(false);
  const [error, setError] = useState<{ codigo: CodigoPortal; datos: { intentos_restantes?: number } } | null>(
    null,
  );

  const campo = useRef<HTMLInputElement>(null);
  const primerCampo = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setFactor(parametros.get('factor'));
  }, [parametros]);

  /**
   * Sin `factor` no hay nada que verificar: se vuelve al login.
   *
   * Se manda al login y no a un error propio porque es la única acción posible —
   * el desafío sin el `factor_id` no existe— y una pantalla que dice "falta un
   * dato" sin poder hacer nada al respecto es una pantalla de error de más.
   */
  useEffect(() => {
    if (factor === null) {
      router.replace('/login');
    }
  }, [factor, router]);

  useEffect(() => {
    campo.current?.focus();
  }, [recuperacion]);

  const irAlDestino = useCallback(
    (destino: string | null | undefined): void => {
      if (!destino || destino === '/') {
        router.replace('/');
        return;
      }
      window.location.assign(`${API_URL}${destino}`);
    },
    [router],
  );

  async function enviar(evento: SyntheticEvent<HTMLFormElement>): Promise<void> {
    evento.preventDefault();
    if (enviado || !factor) {
      return;
    }

    setEnviado(true);
    setCargando(true);
    setError(null);

    try {
      const resultado = (await verificarMfa(factor, codigo)) as ResultadoLogin;
      // El destino viene de la fila del desafio, ya validado en el paso 1.
      irAlDestino(resultado.returnTo);
    } catch (fallo) {
      const codigoError = fallo instanceof ErrorPortal ? fallo.codigo : 'error';
      const datos = fallo instanceof ErrorPortal ? fallo.datos : {};

      setError({ codigo: codigoError, datos });
      setEnviado(false);
      setCargando(false);

      // Un desafío vencido, usado o con los intentos agotados no se reintenta
      // desde acá: se vuelve al login. Es lo que dice el mensaje y lo que evita
      // que el usuario INSISTA contra un 401 que ya no va a cambiar.
      if (codigoError === 'mfa_desafio_invalido') {
        setAviso('Volvé a ingresar para empezar de nuevo.');
      }

      primerCampo.current?.focus();
      primerCampo.current?.select();
    }
  }

  const mensaje = textoDeError(error);
  const hayError = mensaje.length > 0;

  if (!factor) {
    return <MarcoSinFormulario />;
  }

  return (
    // Mismo marco que el login: `my-auto` y no `justify-center` por el mismo
    // motivo de la fase 04 (con contenido mas alto que la pantalla, el bloque de
    // arriba se va del area scrolleable).
    <main className="fondo-login flex min-h-dvh flex-col items-center px-4 py-4 [@media(max-height:820px)]:py-3 sm:py-8">
      <div className="my-auto w-full max-w-md">
        <Encabezado />

        <Placa className="trama-peltre">
          <form onSubmit={(evento) => void enviar(evento)} noValidate>
            <h2 className="font-titulo text-lg font-normal text-hueso">Verificacion en dos pasos</h2>
            <Costura className="my-4" />

            {/*
              Un solo `role="alert"` y sin icono: el mismo tono que el login
              (estetica §8, "Take your hatred out on your mouth"). El error de
              MFA no distingue "clave incorrecta" de "código incorrecto" ni debe
              intentarlo: el backend devuelve el mismo `mfa_incorrecto` para los
              dos y un mensaje distinto sería Information que un atacante con un
              `factor_id` puede usar.
            */}
            <div role="alert" aria-live="assertive" className="min-h-[2.5rem]">
              {mensaje ? <p className="mb-4 font-interfaz text-menor text-sangre">{mensaje}</p> : null}
              {!mensaje && aviso ? (
                <p className="mb-4 font-interfaz text-menor text-plata">{aviso}</p>
              ) : null}
            </div>

            {/*
              El campo con `inputMode="numeric"` y `letra de 28 px`.

              La clase del input va en `campoClassName` y no en `className`: el
              primero es el `<input>` (donde va el tracking y el centrado) y el
              segundo es el contenedor con el `<label>`. Con los dos al revés, el
              centrado se aplica al bloque con el label y el tracking se ve
              corrido.
            */}
            <Campo
              etiqueta={recuperacion ? 'Codigo de recuperacion' : 'Codigo de 6 digitos'}
              name="codigo"
              ref={primerCampo}
              value={codigo}
              onChange={(evento) => setCodigo(evento.target.value)}
              // `one-time-code` es lo que hace que el sistema operativo ofrezca
              // pegar el código que el usuario acaba de ver en la app. Es el
              // requisito 1 de la fase y el que mas tiempo ahorra.
              autoComplete="one-time-code"
              inputMode={recuperacion ? 'text' : 'numeric'}
              pattern={recuperacion ? '[A-Za-z0-9-]{6,20}' : '[0-9]{6}'}
              maxLength={recuperacion ? 20 : 6}
              // Con `type="text"` y no `password`: el código se muestra. Es un
              // número de 30 segundos que la persona acaba de ver en su propio
              // teléfono, y ocultarlo sólo agrega un botón que apretar mal.
              type="text"
              required
              autoCapitalize={recuperacion ? 'characters' : 'none'}
              autoCorrect="off"
              spellCheck={false}
              className="font-interfaz"
              campoClassName={[
                'text-center font-codigo text-[28px] tracking-[0.35em]',
                recuperacion ? '' : 'tabular-nums',
              ].join(' ')}
            />

            <Boton className="mt-5 w-full" cargando={cargando} bloqueado={enviado}>
              {recuperacion ? 'Entrar con el codigo' : 'Verificar'}
            </Boton>

            {/*
              El alternador entre TOTP y código de recuperación, y el "volver".

              Los dos son enlaces, no botones: no hacen la acción primary de la
              pantalla, y un `Boton` de 44 px por cada alternativa empuja el
              campo de 6 dígitos fuera de la pantalla de 768 px de alto. Es el
              mismo criterio del selector de cliente del login (fase 07).
            */}
            <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
              <button
                type="button"
                onClick={() => {
                  setRecuperacion(!recuperacion);
                  setCodigo('');
                  setError(null);
                  setAviso('');
                }}
                className="foco-brasa min-h-tactil rounded-campo px-2 font-interfaz text-menor text-plata hover:text-hueso"
              >
                {recuperacion ? 'Usar el codigo de 6 digitos' : 'Usar un codigo de recuperacion'}
              </button>

              <a
                href="/login"
                className="foco-brasa min-h-tactil rounded-campo px-2 font-interfaz text-menor text-plata hover:text-hueso"
              >
                Volver al ingreso
              </a>
            </div>
          </form>
        </Placa>

        {/*
          Aviso de códigos, fuera de la columna del formulario y en `<details
          open>` por la misma razón que en `/login`: es texto de apoyo, plegable
          en una pantalla baja, y **no** un mensaje de error. Cuando
          `aviso_pocos` viene del backend, el texto dice qué hacer (avisarle a
          quien administra), que es el consejo útil y no "quedan pocos".
        */}
        <details open className="mt-5 w-full max-w-3xl shrink-0">
          <summary className="foco-brasa mx-auto flex min-h-tactil w-fit cursor-pointer list-none items-center justify-center rounded-campo px-3 text-center font-interfaz text-menor text-plata hover:text-hueso">
            <span>Ayuda y aviso</span>
            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden focusable="false" className="shrink-0 transition-transform group-open:rotate-180">
              <path d="M 3 6 L 8 11 L 13 6" className="stroke-plata" strokeWidth="1.5" strokeLinecap="square" fill="none" />
            </svg>
          </summary>
          <div className="mx-auto mt-1 max-w-3xl space-y-3 font-cuerpo text-cuerpo text-plata">
            <p>
              El codigo de 6 digitos es el que te muestra la app de autenticacion. Cada
             codigo vale 30 segundos.
            </p>
            <p>
              Si la perdiste, us&#225; uno de los <strong>c&#243;digos de recuperaci&#243;n</strong> que
              te entreg&#243; quien administra el acceso. Cada uno sirve una sola vez.
            </p>
          </div>
        </details>
      </div>
    </main>
  );
}

/** Texto de un error del segundo factor. Un codigo por caso, sin adornos. */
function textoDeError(error: { codigo: CodigoPortal; datos: { intentos_restantes?: number } } | null): string {
  if (!error) {
    return '';
  }

  if (error.codigo === 'mfa_incorrecto') {
    const restantes = error.datos.intentos_restantes;
    if (restantes !== undefined && restantes <= 1) {
      return 'Ultimo intento. Si falla, volve a ingresar con tu usuario y tu clave.';
    }
    if (restantes !== undefined && restantes <= 3) {
      return `El codigo no coincide. Te ${restantes === 1 ? 'queda' : 'quedan'} ${restantes} intento${restantes === 1 ? '' : 's'}.`;
    }
    return 'El codigo no coincide.';
  }

  if (error.codigo === 'mfa_desafio_invalido') {
    return 'La verificacion expiro. Volve a ingresar con tu usuario y tu clave.';
  }

  if (error.codigo === 'inactivo') {
    return 'Tu cuenta esta dada de baja. Escribi a quien administra el acceso.';
  }

  if (error.codigo === 'sin_conexion') {
    return 'No pudimos comunicarnos con el servicio de identidad. Revisa tu conexion.';
  }

  return 'No pudimos completar la operacion. Reintenta en un momento.';
}

/** El anillo y el wordmark: el mismo encabezado que el login, mas chico. */
function Encabezado() {
  return (
    <div className="mb-6 flex flex-col items-center text-center">
      <Anillo className="text-hierro" diametro={56} />
      <p className="mt-3 font-wordmark text-2xl tracking-wide text-hueso">Tourniquet</p>
      <p className="mt-1 font-interfaz text-chico text-plata">Segundo paso</p>
    </div>
  );
}

function MarcoSinFormulario() {
  return (
    <main className="fondo-login flex min-h-dvh flex-col items-center px-4">
      <div className="my-auto">
        <Encabezado />
      </div>
    </main>
  );
}

/**
 * `useSearchParams()` en una página prerenderizada obliga a la página entera a
 * postponerse al cliente, y Next 14 aborta el build sin un `<Suspense>` alrededor
 * (mismo motivo que en `/login`).
 */
export default function PaginaMfa() {
  return (
    <Suspense fallback={<MarcoSinFormulario />}>
      <Mfa />
    </Suspense>
  );
}
