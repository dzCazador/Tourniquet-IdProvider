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
  iniciarSesion,
  leerSesion,
  type CodigoPortal,
  type ResumenCliente,
} from '@/lib/api';

/**
 * `/login`: la pantalla de clave.
 *
 * Toda la parte interesante esta en `estetica-tourniquet.md` §7.1 y en las
 * trampas de `fase-04`. Lo que este archivo NO hace es drama: no hay
 * eslogan, ni letra, ni tips, ni "no soy robot", ni contador de intentos, ni
 * animacion de error. El tema esta en el marco (anillo, placa, filete
 * oxblood, `Cinzel` en el titulo) y la funcion esta en `Inter` sobre
 * `tinta-alta`, sin textura. Esa es la linea de §2: la atmosfera va en el
 * marco, la legibilidad va en la funcion.
 */

/** Textos de la lista cerrada de codigos. El backend manda codigo, no frases. */
const TEXTOS: Record<CodigoPortal, string> = {
  clave_incorrecta: 'No pudimos validar tu usuario o tu clave.',
  // Existe en la lista de codigos a proposito, aunque el backend actual
  // responde `clave_incorrecta` para los dos casos: si alguna vez los separa,
  // el texto es el MISMO. Un texto distinto aca seria un oraculo de que cuentas
  // hay, y el listado de `fase-04` §4 lo prohibe explicitamente.
  credencial_desconocida: 'No pudimos validar tu usuario o tu clave.',
  bloqueado: '',
  inactivo: 'Tu cuenta esta dada de baja. Escribi a quien administra el acceso.',
  rate_limit: '',
  returnto_invalido: 'El enlace de ingreso no es valido. Volve a entrar desde el portal.',
  sin_cliente: 'Tu usuario no esta habilitado en ningun cliente de esta instalacion.',
  cliente_ambiguo: 'Elegi con que cliente queres ingresar.',
  cliente_no_pertenece: 'No sos miembro de ese cliente. Volve a elegir.',
  sesion_requerida: '',
  sin_conexion:
    'No pudimos comunicarnos con el servicio de identidad. Revisa tu conexion o ' +
    'avisa a quien administra el sistema: reintentar no sirve si el servicio esta caido.',
  error: 'No pudimos completar la operacion. Reintenta en un momento.',
};

/** Formato de la hora local del desbloqueo: `14:05`. */
function horaLocal(iso: string): string {
  const fecha = new Date(iso);
  if (Number.isNaN(fecha.getTime())) {
    return '';
  }
  return fecha.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/**
 * Texto de un codigo. **No es un hook**: es una funcion pura y se llama dentro
 * de un ternario, que es justo el caso donde el linter de hooks se queja si se
 * disfraza de hook.
 */
function mensajeDeError(
  codigo: CodigoPortal,
  datos: { bloqueado_hasta?: string; reintento_seg?: number },
): string {
  if (codigo === 'bloqueado') {
    const hora = datos.bloqueado_hasta ? horaLocal(datos.bloqueado_hasta) : '';
    // Sin la hora en el mensaje no hay forma de que el usuario sepa cuando
    // volver: "tu cuenta esta bloqueada" a secas hace que la gente reintente
    // cada 30 segundos y se lleve el resto de la cuota de rate limit.
    return hora
      ? `Tu cuenta esta bloqueada hasta las ${hora}. Vuelve a intentar despues de ese horario.`
      : 'Tu cuenta esta bloqueada por intentos fallidos. Vuelve a intentar mas tarde.';
  }

  if (codigo === 'rate_limit') {
    const segundos = datos.reintento_seg ?? 60;
    return `Demasiados intentos. Vuelve a intentar en ${segundos} segundos.`;
  }

  return TEXTOS[codigo];
}

function Login() {
  const router = useRouter();
  const parametros = useSearchParams();

  // El `returnTo` viaja crudo y lo valida el backend (`fase-04` §5). El front
  // no lo compara ni por prefijo ni de ninguna otra forma: una comparacion acá
  // seria la unica validacion real y editarla seria cambiar la seguridad del
  // producto con un parche de estilos.
  const [returnTo, setReturnTo] = useState<string | null>(null);
  const [usuario, setUsuario] = useState('');
  const [clave, setClave] = useState('');
  const [cargando, setCargando] = useState(false);
  const [enviado, setEnviado] = useState(false);
  const [error, setError] = useState<{
    codigo: CodigoPortal;
    datos: { bloqueado_hasta?: string; reintento_seg?: number };
  } | null>(null);
  /**
   * Clientes a elegir, cuando el backend respondio `cliente_ambiguo`.
   *
   * Es el caso real del admin de una instalacion con varios clientes: es
   * miembro de los cuatro y la app `rhpro` existe en los cuatro, asi que el
   * `returnTo` no puede desambiguar. Antes de esto el portal le respondia 400
   * y no habia ninguna forma de entrar, que es un callejon sin salida para la
   * unica cuenta que puede administering.
   */
  const [clientes, setClientes] = useState<ResumenCliente[]>([]);

  /**
   * Navega al destino que devolvio el login.
   *
   * El backend devuelve el destino **relativo al issuer** (`/oidc/authorize?...`),
   * porque es ahi donde vive el authorize y no en este portal: el `returnTo` lo
   * produce `GET /oidc/authorize` del backend y `validarReturnTo` solo acepta
   * paths bajo `<issuer>/oidc/authorize` (`backend/src/auth/return-to.ts`).
   *
   * Por eso `router.replace(destino)` estaba mal: Next resuelve ese path contra
   * el origen **de este portal** (`:3002`), no contra el issuer (`:3001`), y
   * terminaba en `http://localhost:3002/oidc/authorize/` -> 404. La URL absoluta
   * se resuelve sola, y como es otro origen tiene que ser una navegacion de
   * verdad (`location.assign`), no una del router de Next.
   *
   * `/` si es del portal: es el caso "no venia returnTo" y se queda adentro.
   */
  const irAlDestino = useCallback((destino: string | null | undefined): void => {
    if (!destino || destino === '/') {
      router.replace('/');
      return;
    }
    window.location.assign(`${API_URL}${destino}`);
  }, [router]);

  const primerCampo = useRef<HTMLInputElement>(null);
  const primerBotonCliente = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setReturnTo(parametros.get('returnTo'));
  }, [parametros]);

  // Si ya hay sesion, entrar a `/login` no muestra un formulario que va a fallar:
  // manda al authorize original o a la raiz. Es el caso de un F5 en el login
  // despues de un login exitoso.
  useEffect(() => {
    let vigente = true;
    void leerSesion().then((estado) => {
      if (vigente && estado) {
        irAlDestino(returnTo);
      }
    });
    return () => {
      vigente = false;
    };
  }, [irAlDestino, returnTo]);

  /**
   * Envia el login. `clienteElegido` solo viene distinto de `null` en el
   * **segundo** intento, el que responde a `cliente_ambiguo`.
   *
   * El evento es `SyntheticEvent` y no `FormEvent<HTMLFormElement>` a proposito:
   * esta funcion la disparan tanto el `<form>` como los botones de cliente, y
   * un solo tipo para los dos evita el `as any` que haria falta con el otro.
   */
  async function enviar(
    evento: SyntheticEvent<HTMLFormElement | HTMLButtonElement>,
    clienteElegido: string | null = null,
  ): Promise<void> {
    evento.preventDefault();
    if (enviado) {
      return;
    }

    setEnviado(true);
    setCargando(true);
    setError(null);

    try {
      const resultado = await iniciarSesion(usuario, clave, returnTo, clienteElegido);
      // Destino ya validado por el backend: no es un open redirect. Pero es
      // relativo **al issuer**, asi que se navega con `irAlDestino`, que lo
      // resuelve contra `API_URL` y no contra el origen de este portal.
      irAlDestino(resultado.returnTo);
    } catch (fallo) {
      const codigo = fallo instanceof ErrorPortal ? fallo.codigo : 'error';
      const datos = fallo instanceof ErrorPortal ? fallo.datos : {};

      setError({ codigo, datos });
      // Los clientes a elegir se derivan del error y se guardan en el estado
      // **antes** de mirar el foco, para que el render siguiente ya los tenga.
      const aElegir = codigo === 'cliente_ambiguo' ? (datos.clientes ?? []) : [];
      setClientes(aElegir);

      setEnviado(false);
      setCargando(false);

      if (aElegir.length > 0) {
        // Hay que elegir cliente: el foco va al PRIMER boton de la lista, que
        // es lo que el usuario tiene que tocar. Devolverlo al campo de usuario
        // lo obliga a pasar por teclado algo que ya respondio.
        primerBotonCliente.current?.focus();
        return;
      }

      // El foco va al PRIMER campo, seleccionado, y no a la region del aviso.
      // El aviso se anuncia solo por `aria-live="assertive"`; mover el foco al
      // contenedor del aviso obligaba al usuario a tabular de vuelta hasta el
      // campo para reintentar, y el `select()` sobre un input sin foco no
      // selecciona nada visible. Ademas, con el foco en el campo, el Enter
      // siguiente reenvia sin que nadie tenga que buscar el boton.
      primerCampo.current?.focus();
      primerCampo.current?.select();
    }
  }

  const mensaje = error ? mensajeDeError(error.codigo, error.datos) : '';
  const hayError = mensaje.length > 0;
  // `cliente_ambiguo` no es un problema de credenciales: la clave ya quedo
  // verificada. Poner los campos en rojo ahi seria decirle al usuario que se
  // equivoco de clave cuando lo que falta es contestar una pregunta.
  const hayErrorDeCredencial = hayError && error?.codigo !== 'cliente_ambiguo';

  return (
    // `min-h-dvh` y no `min-h-screen`: en un movil el `vh` clasico no incluye
    // las barras de direccion, asi que la pantalla "entera" mide mas que lo
    // que se ve y el centrado queda medio pixel fuera. `dvh` es la caja real.
    //
    // El `py` baja a `py-4` bajo 820 px de alto. Es la mitad menos visible de
    // la compactacion y la que menos se nota: 32 px de aire arriba y abajo no
    // son nada, pero son 32 px de los 768 que hay.
    <main className="fondo-login flex min-h-dvh flex-col items-center px-4 py-4 [@media(max-height:820px)]:py-3 sm:py-8">
      {/*
        `my-auto` y NO `justify-center` en el `<main>`. Es el bug mas caro que
        tenia esta pantalla: con `justify-center` y un contenido mas alto que la
        pantalla, el desborde se reparte arriba y abajo y **la mitad de arriba se
        va fuera del area scrolleable**. Con el wordmark arriba, eso es
        exactamente el anillo y el titulo: inalcanzables con el scroll del raton
        y con el del teclado. `my-auto` en el hijo centra cuando hay lugar y
        scrollea desde arriba cuando no.

        Y el `shrink-0` del formulario va implicito en el `my-auto`: en una
        columna flex, `auto` en los margenes es lo que cede espacio. Sin eso, el
        bloque de arriba se encogeria para dejarle lugar al aviso de abajo.
      */}
      <div className="my-auto w-full max-w-md">
        <Encabezado />

        <Placa className="trama-peltre">
          <form onSubmit={(evento) => void enviar(evento)} noValidate>
            <h2 className="font-titulo text-lg font-normal text-hueso">Iniciar sesion</h2>
            <Costura className="my-4" />

            {/*
              Un solo `role="alert"` para los dos campos, y es a proposito: el
              mensaje es el mismo con usuario inexistente que con clave mala
              (`specs/01` §4), asi que un aviso por campo direccionaria al
              atacante hacia cual de los dos fallo. Los campos reciben solo el
              ESTADO (`invalido`: `aria-invalid` + borde `sangre-honda`), no un
              mensaje propio.
            */}
            <div role="alert" aria-live="assertive" className="min-h-[1.25rem]">
              {mensaje ? <p className="mb-4 font-interfaz text-menor text-sangre">{mensaje}</p> : null}
            </div>

            <div className="space-y-3">
              <Campo
                etiqueta="Usuario"
                name="username"
                type="text"
                autoComplete="username"
                inputMode="text"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                required
                ref={primerCampo}
                invalido={hayErrorDeCredencial}
                value={usuario}
                onChange={(evento) => setUsuario(evento.target.value)}
                className="font-interfaz"
              />

              <Campo
                etiqueta="Clave"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                invalido={hayErrorDeCredencial}
                value={clave}
                onChange={(evento) => setClave(evento.target.value)}
                className="font-interfaz"
              />
            </div>

            {/*
              Selector de cliente. Aparece SOLO cuando el backend respondio
              `cliente_ambiguo`, o sea cuando la clave ya fue verificada y lo
              unico que falta es decir de que cliente se entra. Por eso no es
              un campo mas del formulario: es una pregunta distinta, y por eso
              los campos de arriba quedan con su valor intacto -- la clave sigue
              en el estado del componente (nunca en `localStorage`) y el segundo
              intento la reenvia sin que nadie la vuelva a tipear.

              La lista es de BOTONES y no un `<select>` por dos motivos: queda
              navegable con Tab en el orden en que se lee, y el nombre del
              cliente se ve entero en vez de en un control de 40 px de ancho.

              Y va en **rejilla con alto maximo**, que es la correccion que
              hizo falta cuando se probo con una cuenta real. `admin` es miembro
              de los cuatro clientes, y una columna de botones de ancho completo
              empujaba el formulario fuera de la pantalla: en una de las pruebas
              el selector dejo el boton de ingresar por debajo del pliegue y la
              unica forma de elegir era scrollear hasta el final. El `max-h` con
              scroll interno pone un techo a la lista: con cuatro clientes o con
              cuarenta, el alto del formulario es el mismo.

              El `p-1 -m-1` no es decorativo: sin el padding, el `overflow` se
              come el anillo de foco del primer y del ultimo boton, que es el
              mismo problema que ya esta anotado en `globals.css` para cualquier
              elemento con `overflow` propio.
            */}
            {clientes.length > 0 ? (
              <div className="mt-5">
                <Costura className="mb-3" />
                <h3 className="font-titulo text-sm font-normal text-hueso">
                  Cliente
                  {/* El numero no es decoracion: el admin de una instalacion con
                      muchos clientes tiene que saber cuantos hay antes de
                      scrollear la lista. */}
                  <span className="font-interfaz text-menor text-plata">
                    {' '}
                    · {clientes.length}
                  </span>
                </h3>
                <ul className="-m-1 mt-2 grid max-h-64 grid-cols-1 gap-2 overflow-y-auto p-1 sm:grid-cols-2">
                  {clientes.map((c, indice) => (
<li key={c.idcliente}>
                      {/*
                        La celda apila el codigo **debajo** del nombre y no al
                        lado. En dos columnas la celda queda en ~168 px de ancho,
                        y "Cerveceria Cervi" con "cervi" al lado no entra: partir
                        el nombre del cliente a la mitad en el paso donde la gente
                        tiene que elegir a que organizacion entra es peor que un
                        renglon mas.
                      */}
                      <button
                        ref={indice === 0 ? primerBotonCliente : undefined}
                        type="button"
                        disabled={enviado}
                        onClick={(evento) => void enviar(evento, c.idcliente)}
                        className="foco-brasa flex min-h-tactil w-full flex-col items-start justify-center gap-0.5 rounded-campo border border-plata/60 bg-tinta px-3 py-2 text-left font-interfaz text-chico text-hueso transition-colors hover:border-plata hover:bg-hierro disabled:pointer-events-none disabled:opacity-60"
                      >
                        <span className="w-full break-words">{c.nombre}</span>
                        {/* El `codigo` es dato, no decoracion: es lo que va en el
                            claim `tenant` y sirve para distinguir dos clientes con
                            el mismo nombre. */}
                        <span className="font-codigo text-menor text-plata">{c.idcliente}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {/* El boton NO se deshabilita durante la request: queda en
                `aria-busy` y en un segundo envio ignorado. Un `disabled`
                borraria el foco del control que disparo el formulario y el
                reintento con Enter se comeria la primera pulsacion. Con el
                selector de cliente en pantalla deja de tener sentido: el paso
                siguiente es tocar un cliente, no volver a enviar. */}
            {clientes.length === 0 ? (
              <Boton className="mt-5 w-full" cargando={cargando} bloqueado={enviado}>
                Ingresar
              </Boton>
            ) : null}
          </form>
        </Placa>
      </div>

      {/*
        Los avisos de privacidad van **fuera** de la columna del formulario, en
        una franja ancha propia, y en un `<details open>`.

        **Fuera de la columna de 448 px, que es la parte que los hacia giganticos.**
        Es un error de caja mio: 448 px es el ancho correcto para un formulario de
        clave -- mas ancho y los campos se vuelven lineas de texto-- pero es un
        ancho de **campo**, no de prosa. Los avisos son 290 caracteres de texto
        corrido, y a 18 px en 384 px de ancho interior dan cuatro renglones cada
        uno y 265 px de alto: el 29 % de la pantalla. En una franja de 768 px dan
        dos renglones cada uno y ocupan la mitad. El ancho de la prosa es el del
        texto, no el del formulario que tiene encima.

        Estan fuera del `my-auto` del formulario y no dentro por lo mismo: asi el
        formulario se centra en el espacio que le queda y el aviso se apoya al
        pie, como un pie de pagina, que es lo que es.

        En `<details open>` porque se pueden plegar, y **abiertos por defecto**:
        en una pantalla alta no se oculta nada y el aviso se lee igual, y en una
        corta el usuario los colapsa con un toque y recupera ~200 px. Lo que NO
        se plega jamas es el mensaje de error ni el de bloqueo con su hora: esos
        son accionables y tienen que verse sin un clic, que es lo que §7.1 pide.

        El texto no baja de 18 px. Es el piso de `estetica-tourniquet.md` §3 y no
        se negocia por una cuestion de alto: bajarlo arreglaria la mitad del
        problema de alto a costa de legibilidad.
      */}
      <details open className="group mt-5 w-full max-w-3xl shrink-0">
        <summary className="foco-brasa mx-auto flex min-h-tactil w-fit cursor-pointer list-none items-center justify-center gap-2 rounded-campo px-3 text-center font-interfaz text-menor text-plata hover:text-hueso">
          <span>Aviso de privacidad y ayuda</span>
          {/* El chevron es un SVG propio y no un caracter: el `details` del
              navegador cambia de lado el marcador segun el SO, y el
              triangulo de texto queda pegado al texto en Windows. */}
          <svg
            viewBox="0 0 16 16"
            width="12"
            height="12"
            aria-hidden
            focusable="false"
            className="shrink-0 transition-transform group-open:rotate-180"
          >
            <path
              d="M 3 6 L 8 11 L 13 6"
              className="stroke-plata"
              strokeWidth="1.5"
              strokeLinecap="square"
              fill="none"
            />
          </svg>
        </summary>

        <div className="mx-auto mt-1 max-w-3xl space-y-3 font-cuerpo text-cuerpo text-plata">
          <p>
            Al ingresar se registra el intento, con tu direccion IP y tu navegador. Si tu cuenta
            queda bloqueada por intentos fallidos, avisale a quien administra el acceso de tu
            organizacion.
          </p>
          <p>
            No se guarda nada en este navegador: la sesion viaja en una cookie del servidor y
            ningun token queda guardado en el equipo.
          </p>
        </div>
      </details>
    </main>
  );
}

/**
 * `useSearchParams()` en una pagina prerenderizada obliga a la pagina entera a
 * postponerse al cliente, y Next 14 aborta el build si no hay un `<Suspense>`
 * alrededor. El fallback es el marco sin formulario: el usuario ve el
 * wordmark mientras llega el JavaScript, en vez de un blanco.
 */
export default function PaginaLogin() {
  return (
    <Suspense fallback={<MarcoSinFormulario />}>
      <Login />
    </Suspense>
  );
}

/**
 * El anillo, el wordmark y el subtitulo.
 *
 * Vive aca y no inline en el `return` por una razon concreta: el fallback del
 * `<Suspense>` dibuja **el mismo** encabezado, y con los tamaños en los dos
 * lugares se cumple en cuanto uno se compacta y el otro no. El wordmark es lo
 * unico que el usuario ve durante la carga del JavaScript, asi que un fallback
 * con otro tamaño hace un salto visible justo antes de que aparezca el
 * formulario.
 *
 * Los tres numeros del header bajaron (anillo 84 -> 64, wordmark `text-4xl` ->
 * `text-3xl`, `mb-8` -> `mb-6`) porque entre el encabezado, la placa y los dos
 * avisos la pantalla medida daba ~970 px de alto, y el equipo mas probable de un
 * turno de RRHH tiene 768. El subtitulo, ademas, se oculta solo en pantallas
 * bajas: es texto de apoyo y la primera cosa que se puede caer sin que se pierda
 * nada.
 */
function Encabezado() {
  return (
    <div className="mb-6 flex flex-col items-center text-center">
      <Anillo className="text-hierro" diametro={64} />
      {/* El wordmark es el unico lugar con blackletter del producto, y
          "Tourniquet" visible es lo que lo anuncia: el SVG de arriba va
          con `aria-hidden` para que no se lea dos veces. */}
      <h1 className="mt-4 font-wordmark text-3xl tracking-wide text-hueso sm:text-4xl">
        Tourniquet
      </h1>
      <p className="mt-1 font-interfaz text-chico text-plata [@media(max-height:820px)]:hidden">
        Ingreso unico
      </p>
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
