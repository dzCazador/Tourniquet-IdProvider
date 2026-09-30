'use client';

import { useState } from 'react';
import { Confirmar } from '@/design/components/Confirmar';
import { Costura } from '@/design/ornaments/Costura';
import {
  activarMfa,
  desactivarMfa,
  regenerarCodigosMfa,
  type EnrolamientoMfa,
  type UsuarioAdmin,
} from '@/lib/api';

/**
 * MFA en `/admin/usuarios` (Fase 09, `specs/01` §8.1).
 *
 * Tres acciones sobre un usuario del tenant: **activar**, **desactivar** y
 * **regenerar los códigos de recuperación**. Las dos primeras necesitan
 * confirmación —la de desactivar es destructiva— y la tercera avisa que los
 * anteriores dejan de servir.
 *
 * **La única pantalla del panel que muestra un secreto**, y por eso tiene los
 * mismos tres cuidados que la `clave_temporal` de la Fase 08: el aviso de que no
 * se vuelve a ver, el botón de copiar, y nada más que la confirmación de "ya lo
 * copié". Sin el botón de copiar, un admin reescribe 10 códigos a mano y los
 * manda por chat, que es peor que perderlos.
 *
 * ## Por qué NO hay QR
 *
 * Es lo primero que se agrega cuando aparece un `otpauth://`, y acá se decidió
 * en contra a propósito: un QR decodifica `otpauth://` es un_encoder de~200
 * líneas de álgebra de campos finitos y mascaras, para un caso de uso que
 * ocurre **una vez por enrolamiento** y donde hay dos salidas más:
 *
 *   - La app de autenticación de casi todo el mundo tiene "Ingresar clave
 *     manualmente" (Google Authenticator, Microsoft Authenticator, 1Password,
 *     Authy). La clave en base32 de 32 caracteres se tipea en 20 segundos.
 *   - El admin puede pegar la URI en cualquier herramienta de QR sin conexión,
 *     o guardarla.
 *
 * El costo de las dos salidas es un mensaje que este diálogo dice explícitamente.
 * El costo de un encoder de QR en el repo es un archivo que hay que mantener
 * correcto y auditar (un QR mal generado manda al usuario a enrolar un secret
 * equivocado y nadie se entera hasta que no puede entrar).
 */
export function MfaTabla({ usuario }: { usuario: UsuarioAdmin }) {
  const mfa = usuario.mfa;

  if (!mfa || mfa.estado === 'off') {
    return <span className="font-interfaz text-menor text-plata">no</span>;
  }

  return (
    <span className="font-interfaz text-menor">
      <span className={mfa.estado === 'on' ? 'text-verdigris' : 'text-plata'}>
        {mfa.estado === 'on' ? 'activo' : 'sin confirmar'}
      </span>
      {/*
        El `aviso_pocos` sale del backend (umbral de `specs/01` §8.5) y no de un
        `2` escrito acá: si el umbral cambia, el panel y `/mi-cuenta` tienen que
        decir lo mismo, y un número duplicado en el front garantiza que en algún
        momento dejarán de coincidir.
      */}
      {mfa.aviso_pocos ? (
        <span className="block text-sangre">
          {mfa.codigos_restantes} c&#243;digo{mfa.codigos_restantes === 1 ? '' : 's'}
        </span>
      ) : null}
    </span>
  );
}

/** Lo que se muestra una sola vez, ya sea el enrolamiento o los códigos. */
export type MfaEntregado =
  | { tipo: 'enrolar'; usuario: UsuarioAdmin; datos: EnrolamientoMfa }
  | { tipo: 'codigos'; usuario: UsuarioAdmin; codigos: string[] };

export function MfaDialogo({
  entregado,
  alCerrar,
}: {
  entregado: MfaEntregado;
  alCerrar: () => void;
}) {
  const nombre = nombreDe(entregado.usuario);
  const esEnrolar = entregado.tipo === 'enrolar';
  const codigos = esEnrolar ? entregado.datos.codigos : entregado.codigos;

  return (
    <Confirmar
      titulo={esEnrolar ? `MFA de ${nombre}: entregá estos datos` : `Códigos de ${nombre}`}
      textoConfirmar="Ya los copié, cerrar"
      onCancel={alCerrar}
      onConfirm={alCerrar}
    >
      {esEnrolar ? (
        <>
          <p>
            <strong>{nombre}</strong> entra <strong>igual que hasta ahora</strong>: el segundo
            factor queda esperando confirmación y no se pide en el ingreso hasta que la confirme
            desde <code>/mi-cuenta</code> con un código de 6 dígitos.
          </p>

          <Costura className="my-2" />

          <p className="font-interfaz text-menor text-plata">
            1. En la app de autenticación, elegí <strong>agregar cuenta → escribir la clave
            manualmente</strong>.
            <br />
            2. Copiá esta clave:
          </p>
          <p className="rounded-campo border border-plata/60 bg-tinta p-3 text-center font-codigo text-chico tracking-widest text-hueso">
            {entregado.datos.clave}
          </p>
          <BotonCopiar texto={entregado.datos.clave} etiqueta="Copiar la clave" />

          {/*
            La URI va también, y es lo que se usa si la app del usuario **sí** puede
            leer un QR: en lugar de generarlo acá, el admin puede pegar esta
            cadena en cualquier lector de QR (o en la pantalla del escritorio con
            un generador sin conexión). Es la misma información que el QR
            codificaría, en texto.
          */}
          <details className="mt-2">
            <summary className="foco-brasa min-h-tactil cursor-pointer font-interfaz text-menor text-plata hover:text-hueso">
              Para leer con un QR (avanzado)
            </summary>
            <p className="mt-2 max-w-full break-all font-codigo text-xs text-plata">
              {entregado.datos.otpauth}
            </p>
            <BotonCopiar texto={entregado.datos.otpauth} etiqueta="Copiar la URI" />
          </details>
        </>
      ) : null}

      <Costura className="my-2" />

      <p>
        {esEnrolar ? 'Códigos de recuperación' : 'Estos códigos'}: se muestran{' '}
        <strong>una sola vez</strong> y cada uno sirve <strong>una vez</strong>. Entregáselos
        impresos o por un canal seguro; después no hay forma de volver a verlos.
      </p>
      <ul className="grid grid-cols-2 gap-1 rounded-campo border border-plata/60 bg-tinta p-3 font-codigo text-chico text-hueso">
        {codigos.map((codigo) => (
          <li key={codigo} className="tracking-wider">
            {codigo}
          </li>
        ))}
      </ul>
      <BotonCopiar texto={codigos.join('\n')} etiqueta="Copiar los 10 códigos" />
    </Confirmar>
  );
}

/**
 * Las tres acciones, con su confirmación.
 *
 * Van en un hook y no en el `TablaUsuarios` para que el estado de la pantalla (que
 * ya tiene búsqueda, paginación y dos diálogos) no crezca con un estado por
 * acción. Lo que devuelve es lo que la tabla necesita: un disparador por acción
 * y el diálogo que haya que mostrar.
 */
export function useMfaPanel({
  avisar,
  alTerminar,
}: {
  avisar: (texto: string) => void;
  alTerminar: () => void;
}) {
  const [confirmando, setConfirmando] = useState<{
    usuario: UsuarioAdmin;
    accion: 'activar' | 'desactivar' | 'codigos';
  } | null>(null);
  const [entregado, setEntregado] = useState<MfaEntregado | null>(null);
  const [ocupado, setOcupado] = useState(false);

  async function ejecutar(): Promise<void> {
    if (!confirmando || ocupado) {
      return;
    }
    setOcupado(true);
    avisar('');
    try {
      if (confirmando.accion === 'activar') {
        const datos = await activarMfa(confirmando.usuario.idusuario);
        setEntregado({ tipo: 'enrolar', usuario: confirmando.usuario, datos });
      } else if (confirmando.accion === 'desactivar') {
        const r = await desactivarMfa(confirmando.usuario.idusuario);
        avisar(
          r.sesiones_cerradas > 0
            ? `MFA desactivado. Se cerraron ${r.sesiones_cerradas} sesión(es) abierta(s) en este cliente: el usuario tiene que volver a entrar.`
            : 'MFA desactivado.',
        );
      } else {
        const r = await regenerarCodigosMfa(confirmando.usuario.idusuario);
        setEntregado({ tipo: 'codigos', usuario: confirmando.usuario, codigos: r.codigos });
      }
      setConfirmando(null);
      alTerminar();
    } catch (fallo) {
      avisar(
        fallo instanceof Error && fallo.name === 'ErrorAdmin'
          ? 'No pudimos completar la operación de MFA.'
          : 'No pudimos completar la operación de MFA.',
      );
    } finally {
      setOcupado(false);
    }
  }

  const dialogo =
    confirmando && confirmando.accion === 'activar' ? (
      <Confirmar
        titulo={`Activar el segundo factor de ${nombreDe(confirmando.usuario)}`}
        textoConfirmar={`Activar MFA de ${nombreDe(confirmando.usuario)}`}
        onCancel={() => setConfirmando(null)}
        onConfirm={() => void ejecutar()}
        ocupado={ocupado}
      >
        <p>
          Se genera una clave y 10 códigos de recuperación, y se muestran{' '}
          <strong>una sola vez</strong>. Entregáselos a {nombreDe(confirmando.usuario)} por
          escrito.
        </p>
        <p>
          Hasta que el usuario confirme un código desde <code>/mi-cuenta</code>,{' '}
          <strong>sigue entrando solo con la clave</strong>: activar no le corta el acceso.
        </p>
        {confirmando.usuario.mfa && confirmando.usuario.mfa.estado !== 'off' ? (
          <p className="text-sangre">
            Este usuario ya tenía un segundo factor enrolado. Activar de nuevo genera una clave
            nueva: <strong>el usuario tiene que volver a configurar la app</strong> o se queda sin
            poder entrar.
          </p>
        ) : null}
      </Confirmar>
    ) : null;

  const dialogoDesactivar =
    confirmando && confirmando.accion === 'desactivar' ? (
      <Confirmar
        titulo={`Desactivar el segundo factor de ${nombreDe(confirmando.usuario)}`}
        textoConfirmar={`Desactivar MFA de ${nombreDe(confirmando.usuario)}`}
        destructivo
        onCancel={() => setConfirmando(null)}
        onConfirm={() => void ejecutar()}
        ocupado={ocupado}
      >
        <p>
          {nombreDe(confirmando.usuario)} entra <strong>solo con usuario y clave</strong>, y se le
          cierran las sesiones abiertas <strong>en este cliente</strong>. Va a tener que volver a
          entrar.
        </p>
        <p>
          Los códigos de recuperación que le entregaste <strong>dejan de servir</strong>. Si lo que
          querías era renovar esos códigos, la acción correcta es generar códigos nuevos, no
          desactivar.
        </p>
      </Confirmar>
    ) : null;

  const dialogoCodigos =
    confirmando && confirmando.accion === 'codigos' ? (
      <Confirmar
        titulo={`Generar códigos de recuperación para ${nombreDe(confirmando.usuario)}`}
        textoConfirmar={`Generar 10 códigos para ${nombreDe(confirmando.usuario)}`}
        onCancel={() => setConfirmando(null)}
        onConfirm={() => void ejecutar()}
        ocupado={ocupado}
      >
        <p>
          Los 10 códigos anteriores <strong>dejan de funcionar de inmediato</strong>. Mostrame los
          nuevos antes de cerrar esta pantalla: es la única vez que aparecen.
        </p>
        <p>
          No cambia la clave de la app de autenticación: el usuario no tiene que volver a
          configurar nada.
        </p>
      </Confirmar>
    ) : null;

  return {
    pedir: (usuario: UsuarioAdmin, accion: 'activar' | 'desactivar' | 'codigos') =>
      setConfirmando({ usuario, accion }),
    dialogos: (
      <>
        {dialogo}
        {dialogoDesactivar}
        {dialogoCodigos}
        {entregado ? (
          <MfaDialogo entregado={entregado} alCerrar={() => setEntregado(null)} />
        ) : null}
      </>
    ),
  };
}

function BotonCopiar({ texto, etiqueta }: { texto: string; etiqueta: string }) {
  const [copiado, setCopiado] = useState(false);

  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(texto);
        setCopiado(true);
      }}
      className="foco-brasa mx-auto mt-2 min-h-tactil rounded-campo border border-plata/60 px-3 py-1 font-interfaz text-menor text-plata hover:text-hueso"
    >
      {copiado ? 'Copiado' : etiqueta}
    </button>
  );
}

function nombreDe(usuario: UsuarioAdmin): string {
  const completo = `${usuario.nombre} ${usuario.apellido}`.trim();
  return completo.length > 0 ? completo : usuario.usuario;
}
