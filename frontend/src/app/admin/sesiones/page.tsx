'use client';

import { useState } from 'react';
import { MarcoAdmin } from '../_marco';
import { Cargando } from '@/design/components/Marco';
import { Boton } from '@/design/components/Boton';
import { Confirmar } from '@/design/components/Confirmar';
import { Sello } from '@/design/ornaments/Sello';
import {
  cerrarSesionForzada,
  listarSesiones,
  MOTIVOS_CIERRE,
  type MotivoCierre,
  type SesionAdminRow,
} from '@/lib/api';
import { mensajeDe, usePanel } from '../_datos';
import { fecha } from '@/lib/fecha';
import { resumirNavegador } from '@/lib/user-agent';

/**
 * `/admin/sesiones`: las sesiones abiertas del tenant y el cierre forzado.
 *
 * La diferencia con `/mi-cuenta` (la del propio usuario) está en tres cosas y las
 * tres importan:
 *
 *   - **La IP va entera.** El admin diagnostica; el usuario solo reconoce la suya.
 *   - **El motivo es obligatorio** y se elige acá, no se escribe: cinco opciones
 *     cerradas que son las del CHECK de `tok_sesion.motivo_cierre`. Un `<textarea>`
 *     para el motivo daría cincoimming códigos distintos y la columna es una lista
 *     cerrada (`fase-08` §5).
 *   - **El botón de cierre dice qué cierra**: "Cerrar la sesión de Juan Pérez en RHPro",
 *     no "Cerrar" (trampa 6: con ocho filas, ocho botones iguales).
 *
 * Y el aviso que hay que dejar clarísimo, porque un admin deshabilita una app y
 * espera que surta efecto (trampa 5): cerrar la sesión es lo que hace **efecto
 * inmediato**; deshabilitar la app impide el **próximo** ingreso y deja válida la
 * sesión que ya está abierta. Por eso el cierre de sesión está al lado del
 * listado de sesiones y el de deshabilitar, en la pantalla de usuarios.
 */
export default function PanelSesiones() {
  const { datos, cargando, error, recargar } = usePanel(() => listarSesiones());
  const [mensaje, setMensaje] = useState('');
  const [confirmando, setConfirmando] = useState<SesionAdminRow | null>(null);
  const [motivo, setMotivo] = useState<MotivoCierre>('soporte');
  const [ocupado, setOcupado] = useState(false);

  async function cerrar(): Promise<void> {
    if (!confirmando || ocupado) {
      return;
    }
    setOcupado(true);
    setMensaje('');
    try {
      const r = await cerrarSesionForzada(confirmando.sid, motivo);
      setMensaje(`Se cerró la sesión de ${r.usuario}. Motivo: ${r.motivo}.`);
      setConfirmando(null);
      recargar();
    } catch (fallo) {
      setMensaje(mensajeDe(fallo));
    } finally {
      setOcupado(false);
    }
  }

  return (
    <MarcoAdmin titulo="Sesiones abiertas">
      {error ? (
        <p role="alert" className="mb-4 font-interfaz text-chico text-sangre">
          {error}
        </p>
      ) : null}
      {mensaje ? (
        <p role="status" className="mb-4 font-interfaz text-chico text-verdigris">
          {mensaje}
        </p>
      ) : null}

      {cargando && !datos ? (
        <Cargando texto="Leyendo las sesiones" />
      ) : datos && datos.sesiones.length === 0 ? (
        <p className="font-interfaz text-chico text-plata">
          No hay sesiones abiertas en este cliente.
        </p>
      ) : datos ? (
        <ul className="space-y-2">
          {datos.sesiones.map((sesion) => (
            <li
              key={sesion.sid}
              className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-placa border border-hierro bg-tinta-alta p-3"
            >
              {/*
                El sello va con `aria-hidden` dentro de la fila: el estado real
                ("abierta") lo dice la propia fila y el `Sello` repetido ocho veces
                seria ruido para el lector. El estado de la sesión es lo importante
                y está en el texto.
              */}
              <Sello codigo={sesion.es_portal ? 'TQ' : sesion.app.slice(0, 3)} diametro={34} />
              <div className="min-w-0 flex-1">
                <p className="font-titulo text-chico text-hueso">
                  {sesion.nombre}{' '}
                  <span className="font-interfaz text-menor text-plata">({sesion.usuario})</span>
                </p>
                <p className="font-interfaz text-menor text-plata">
                  {sesion.app} · {resumirNavegador(sesion.user_agent)} · {sesion.ip} · desde las{' '}
                  {fecha(sesion.creado_en)}
                </p>
                {/*
                  El `amr` se muestra porque es el dato que dice **cómo** se
                  autenticó la persona: con MFA o sin ella. Sin esto, un admin ve
                  ocho sesiones y no puede distinguir una entrada con clave de una
                  entrada con segundo factor, que es justo lo que se viene a
                  verificar en una revisión de seguridad.
                */}
                <p className="font-codigo text-menor text-plata">amr: {sesion.amr}</p>
              </div>
              <Boton
                variante="secondary"
                className="min-h-tactil px-3 py-1"
                onClick={() => {
                  setMotivo('soporte');
                  setConfirmando(sesion);
                }}
                aria-label={`Cerrar la sesión de ${sesion.nombre} en ${sesion.app}`}
              >
                Cerrar sesión
              </Boton>
            </li>
          ))}
        </ul>
      ) : null}

      {datos ? (
        <p className="mt-3 font-interfaz text-menor text-plata">{datos.total} sesión(es) abierta(s).</p>
      ) : null}

      {confirmando ? (
        <Confirmar
          titulo={`Cerrar la sesión de ${confirmando.nombre} en ${confirmando.app}`}
          textoConfirmar={`Cerrar la sesión de ${confirmando.nombre}`}
          destructivo
          onCancel={() => setConfirmando(null)}
          onConfirm={() => void cerrar()}
          ocupado={ocupado}
        >
          <p>
            Se cierra ahora y en todos los navegadores. La sesión sigue siendo
            criptográficamente válida hasta que expire, pero el servicio de identidad ya no la acepta.
          </p>
          <fieldset className="mt-3">
            <legend className="font-interfaz text-chico text-plata">
              Motivo (obligatorio, queda registrado)
            </legend>
            <div className="mt-2 space-y-2">
              {MOTIVOS_CIERRE.map((opcion) => (
                <label key={opcion.valor} className="flex min-h-tactil items-center gap-2">
                  <input
                    type="radio"
                    name="motivo"
                    value={opcion.valor}
                    checked={motivo === opcion.valor}
                    onChange={() => setMotivo(opcion.valor)}
                    className="foco-brasa h-4 w-4 accent-[#7a0f16]"
                  />
                  <span className="font-interfaz text-chico text-hueso">{opcion.texto}</span>
                </label>
              ))}
            </div>
          </fieldset>
        </Confirmar>
      ) : null}
    </MarcoAdmin>
  );
}
