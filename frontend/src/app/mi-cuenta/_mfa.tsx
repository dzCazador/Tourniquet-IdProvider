'use client';

import { useCallback, useEffect, useState } from 'react';
import { Boton } from '@/design/components/Boton';
import { Campo } from '@/design/components/Campo';
import { Confirmar } from '@/design/components/Confirmar';
import { Costura } from '@/design/ornaments/Costura';
import {
  ErrorPortal,
  confirmarMfa,
  desactivarMfaPropio,
  leerMfa,
  type EstadoMfa,
} from '@/lib/api';

/**
 * El bloque de segundo factor de `/mi-cuenta` (Fase 09, `specs/01` §8.1).
 *
 * Son **dos** acciones, no tres, y la que falta es la interesante:
 *
 *   - `pending` → **Confirmar** con un código de la app. Es lo que puede hacer el
 *     usuario sin ayuda.
 *   - `on` → **Desactivar** (el propio).
 *   - **Activar no está acá.** Lo dispara un `admin_identidad` desde el panel,
 *     porque el `otpauth://` y los 10 códigos de recuperación se muestran una
 *     sola vez y hay que decidir quién se los entrega a quién: si lo activara el
 *     mismo usuario desde acá, un atacante con la clave de otra persona se
 *     llevaría el secret y los códigos en un POST (el escenario exacto que el
 *     panel pone en el medio). Está anotado en `MeMfaController`.
 *
 * **El aviso de "quedan pocos códigos"** sale de `aviso_pocos`, que calcula el
 * backend con el umbral de `specs/01` §8.5. Acá no se recalcula: si el umbral
 * cambia, el texto tiene que ser el mismo en el panel y acá, y un `2` metido en
 * el React obliga a tocar dos archivos.
 *
 * Tema bajo (estética §2, `/mi-cuenta` es bajo-medio): la fila de estado es texto
 * sobre `tinta-alta`, el `Sello` es lo único con aire de tema, y el campo del
 * código de confirmación es el mismo `Campo` del resto del portal.
 */
export function BloqueMfa({ alCambiar }: { alCambiar: () => void }) {
  const [estado, setEstado] = useState<EstadoMfa | null>(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState('');
  const [mensaje, setMensaje] = useState('');
  const [ocupado, setOcupado] = useState(false);

  // Confirmación
  const [confirmando, setConfirmando] = useState(false);
  const [codigo, setCodigo] = useState('');

  // Desactivación
  const [apagando, setApagando] = useState(false);

  const recargar = useCallback(async () => {
    setCargando(true);
    setError('');
    try {
      setEstado(await leerMfa());
    } catch (fallo) {
      setError(textoDe(fallo, 'No pudimos leer el estado del segundo factor.'));
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => {
    void recargar();
  }, [recargar]);

  async function confirmar(): Promise<void> {
    if (ocupado) {
      return;
    }
    setOcupado(true);
    setError('');
    try {
      const r = await confirmarMfa(codigo.trim());
      setConfirmando(false);
      setCodigo('');
      setMensaje('Segundo factor activado. En el próximo ingreso te va a pedir el codigo.');
      setEstado({
        estado: r.estado,
        codigos_restantes: r.codigos_restantes,
        aviso_pocos: r.aviso_pocos,
        ultimo_periodo: null,
      });
      alCambiar();
    } catch (fallo) {
      setError(textoDe(fallo, 'No pudimos activar el segundo factor. Revisa el codigo.'));
    } finally {
      setOcupado(false);
    }
  }

  async function desactivar(): Promise<void> {
    if (ocupado) {
      return;
    }
    setOcupado(true);
    setError('');
    try {
      const r = await desactivarMfaPropio();
      setApagando(false);
      setMensaje(
        r.sesiones_cerradas > 0
          ? `Segundo factor desactivado. Se cerraron ${r.sesiones_cerradas} sesion(es) abierta(s) en ${'este cliente'}: vuelve a entrar.`
          : 'Segundo factor desactivado.',
      );
      await recargar();
      alCambiar();
    } catch (fallo) {
      setError(textoDe(fallo, 'No pudimos desactivar el segundo factor.'));
    } finally {
      setOcupado(false);
    }
  }

  if (cargando || !estado) {
    return null;
  }

  return (
    <section aria-labelledby="titulo-mfa" className="mt-8">
      <Costura className="mb-6" />
      <h2 id="titulo-mfa" className="font-titulo text-chico text-hueso">
        Segundo factor
      </h2>

      {error ? (
        <p role="alert" className="mt-3 font-interfaz text-chico text-sangre">
          {error}
        </p>
      ) : null}
      {mensaje ? (
        <p role="status" className="mt-3 font-interfaz text-chico text-verdigris">
          {mensaje}
        </p>
      ) : null}

      <p className="mt-2 max-w-2xl font-cuerpo text-cuerpo text-plata">{descripcionDe(estado)}</p>

      {estado.aviso_pocos ? (
        <p className="mt-3 rounded-campo border border-sangre-honda bg-tinta-alta p-3 font-interfaz text-chico text-sangre">
          Te quedan {estado.codigos_restantes} c&#243;digo(s) de recuperaci&#243;n. Pedile a quien
          administra el acceso que te genere nuevos: sin ellos, si perd&#233;s el tel&#233;fono no
          entr&#225;s m&#225;s.
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        {estado.estado === 'pending' ? (
          <Boton type="button" onClick={() => setConfirmando(true)}>
            Activar el segundo factor
          </Boton>
        ) : null}

        {estado.estado === 'on' ? (
          <Boton variante="secondary" type="button" onClick={() => setApagando(true)}>
            Desactivar el segundo factor
          </Boton>
        ) : null}
      </div>

      {estado.estado === 'off' ? (
        <p className="mt-3 font-interfaz text-menor text-plata">
          Para activarlo, ped&#237;selo a qui&#233;n administra el acceso de tu organizaci&#243;n: te
          entrega un c&#243;digo de 6 d&#237;gitos y 10 c&#243;digos de recuperaci&#243;n, y vos lo
          confirm&#225;s con el primer c&#243;digo desde ac&#225;.
        </p>
      ) : null}

      {confirmando ? (
        <Confirmar
          titulo="Confirmar el segundo factor"
          textoConfirmar="Activar el segundo factor"
          onCancel={() => {
            setConfirmando(false);
            setCodigo('');
          }}
          onConfirm={() => void confirmar()}
          ocupado={ocupado}
        >
          <p>
            Abr&#237; la app de autenticaci&#243;n del tel&#233;fono y escrib&#237; el c&#243;digo de
            6 d&#237;gitos que te muestra. A partir del pr&#243;ximo ingreso, este portal te va a
            pedir clave <strong>y</strong> c&#243;digo.
          </p>
          <Campo
            etiqueta="C&#243;digo de 6 d&#237;gitos"
            name="codigo-confirmar"
            value={codigo}
            onChange={(evento) => setCodigo(evento.target.value)}
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            required
            className="font-interfaz"
            campoClassName="text-center font-codigo text-[28px] tracking-[0.35em] tabular-nums"
          />
        </Confirmar>
      ) : null}

      {apagando ? (
        <Confirmar
          titulo="Desactivar el segundo factor"
          textoConfirmar="Desactivar y cerrar las sesiones"
          destructivo
          onCancel={() => setApagando(false)}
          onConfirm={() => void desactivar()}
          ocupado={ocupado}
        >
          <p>
            Tu cuenta queda con usuario y clave nom&#225;s. Adem&#225;s se cierran tus sesiones
            abiertas <strong>en este cliente</strong>: tendr&#225;s que volver a entrar y las apps
            donde ya est&#225;s te van a pedir la clave otra vez.
          </p>
          <p>
            Los 10 c&#243;digos de recuperaci&#243;n quedan sin vigor. Si cre&#233;s que se filtraron,
            pedile a qui&#233;n administra el acceso que reactive el segundo factor antes.
          </p>
        </Confirmar>
      ) : null}
    </section>
  );
}

/** Una frase por estado, con lo que la persona tiene que hacer (o esperar). */
function descripcionDe(estado: EstadoMfa): string {
  if (estado.estado === 'on') {
    return `Activo. En cada ingreso te piden la clave y un c&#243;digo de 6 d&#237;gitos de tu app de autenticaci&#243;n. Te quedan ${estado.codigos_restantes} c&#243;digo(s) de recuperaci&#243;n.`;
  }

  if (estado.estado === 'pending') {
    return 'Hay un segundo factor enrolado pero todav&#237;a no lo confirmaste. Mientras tanto entr&#225;s solo con tu clave: confirm&#225;lo cuando puedas para que empiece a pedir.';
  }

  return 'No ten&#233;s un segundo factor activo.';
}

function textoDe(fallo: unknown, porDefecto: string): string {
  if (fallo instanceof ErrorPortal) {
    if (fallo.codigo === 'mfa_no_pendiente') {
      return 'No hay ningun segundo factor esperando confirmacion, o ya esta activo.';
    }
    if (fallo.codigo === 'sesion_requerida') {
      return 'Tu sesi&#243;n no est&#225; activa. Volv&#233; a entrar desde el portal.';
    }
    if (fallo.codigo === 'sin_conexion') {
      return 'No pudimos comunicarnos con el servicio de identidad. Revis&#225; tu conexi&#243;n.';
    }
    if (fallo.codigo === 'error') {
      return 'No pudimos completar la operaci&#243;n. Reintent&#225; en un momento.';
    }
  }
  return porDefecto;
}
