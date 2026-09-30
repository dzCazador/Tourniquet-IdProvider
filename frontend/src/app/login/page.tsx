'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState, type SyntheticEvent } from 'react';
import { Boton } from '@/design/components/Boton';
import { Campo } from '@/design/components/Campo';
import { Anillo } from '@/design/ornaments/Anillo';
import { Costura } from '@/design/ornaments/Costura';
import { Placa } from '@/design/ornaments/Placa';
import { ErrorPortal, iniciarSesion, leerSesion, type CodigoPortal, type ResumenCliente } from '@/lib/api';

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
        router.replace(returnTo && returnTo !== '/' ? returnTo : '/');
      }
    });
    return () => {
      vigente = false;
    };
  }, [router, returnTo]);

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
      // Aca vuelve el destino **ya validado y ya relativo**. `router.push` con
      // un path relativo nunca sale del origen: el riesgo de open redirect
      // estaba en que el backend lo aceptara, y ya se cerro ahi.
      router.replace(resultado.returnTo);
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
    <main className="flex min-h-screen flex-col items-center justify-center px-4 py-10 sm:py-16">
      <div className="w-full max-w-md">
        <div className="mb-8 flex flex-col items-center text-center">
          <Anillo className="text-hierro" diametro={84} />
          {/* El wordmark es el unico lugar con blackletter del producto, y
              "Tourniquet" visible es lo que lo anuncia: el SVG de arriba va
              con `aria-hidden` para que no se lea dos veces. */}
          <h1 className="mt-4 font-wordmark text-4xl tracking-wide text-hueso">Tourniquet</h1>
          <p className="mt-2 font-interfaz text-chico text-plata">Ingreso unico</p>
        </div>

        <Placa className="trama-peltre">
          <form onSubmit={(evento) => void enviar(evento)} noValidate>
            <h2 className="font-titulo text-lg font-normal text-hueso">Iniciar sesion</h2>
            <Costura className="my-5" />

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

            <div className="space-y-4">
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
            */}
            {clientes.length > 0 ? (
              <div className="mt-6">
                <Costura className="mb-4" />
                <h3 className="font-titulo text-sm font-normal text-hueso">Cliente</h3>
                <ul className="mt-3 space-y-2">
                  {clientes.map((c, indice) => (
                    <li key={c.idcliente}>
                      <button
                        ref={indice === 0 ? primerBotonCliente : undefined}
                        type="button"
                        disabled={enviado}
                        onClick={(evento) => void enviar(evento, c.idcliente)}
                        className="foco-brasa flex min-h-tactil w-full items-center justify-between gap-3 rounded-campo border border-plata/60 bg-tinta px-3 py-2 text-left font-interfaz text-chico text-hueso transition-colors hover:bg-hierro hover:border-plata disabled:pointer-events-none disabled:opacity-60"
                      >
                        <span>{c.nombre}</span>
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
              <Boton className="mt-6 w-full" cargando={cargando} bloqueado={enviado}>
                Ingresar
              </Boton>
            ) : null}

            {/* Aviso de privacidad y ayuda: esto SI es texto de lectura, y va en
                la fuente de cuerpo (`estetica-tourniquet.md` §3). El mensaje de
                error de arriba NO: ese va en `Inter` porque es funcional, se lee
                con prisa y a las 3 de la mañana, y §2 regla 1 pide que la
                pantalla se lea de una. La misma tipografia para las dos cosas
                seria jerarquizarlas. */}
            <p className="mt-6 font-cuerpo text-cuerpo text-plata">
              Al ingresar se registra el intento, con tu direccion IP y tu navegador. Si tu
              cuenta queda bloqueada por intentos fallidos, avisale a quien administra el
              acceso de tu organizacion.
            </p>
          </form>
        </Placa>

        <p className="mt-6 text-center font-cuerpo text-cuerpo text-plata">
          No se guarda nada en este navegador: la sesion viaja en una cookie del servidor y
          ningun token queda guardado en el equipo.
        </p>
      </div>
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

function MarcoSinFormulario() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-4">
      <Anillo className="text-hierro" diametro={84} />
      <h1 className="mt-4 font-wordmark text-4xl text-hueso">Tourniquet</h1>
    </main>
  );
}
