'use client';

import { useEffect, useState } from 'react';
import { MarcoAdmin } from './_marco';
import { Cargando } from '@/design/components/Marco';
import { Costura } from '@/design/ornaments/Costura';
import { leerResumen, listarAuditoria, type EventoAuditoria, type ResumenAdmin } from '@/lib/api';
import { resumirNavegador } from '@/lib/user-agent';
import { usePanel } from './_datos';

/**
 * `/admin`: el resumen del panel.
 *
 * Cuatro números y tres listas cortas. No hay gráficas ni tendencias: un admin de
 * identidad necesita saber "cuántos son" y "qué pasó", y un dashboard con más
 * números es ruido con datos de RRHH (y cada número es una consulta mas al mismo
 * IdP).
 *
 * Las tres listas son las que el admin mira todas las mañanas: **sesiones abiertas**
 * (¿hay alguien adentro que no debería estar?), **últimos eventos** (¿se intentó
 * algo raro?) y **altas recientes** (¿quién entró al tenant?).
 */
export default function PanelResumen() {
  const { datos, error, cargando, recargar } = usePanel<ResumenAdmin>(() => leerResumen());
  const [eventos, setEventos] = useState<EventoAuditoria[]>([]);

  // Los eventos del resumen salen del mismo endpoint de auditoría, página 1: es el
  // mismo dato que la pantalla de auditoría, y duplicar un endpoint "los últimos N"
  // para el dashboard es la forma de que los dos muestren cosas distintas.
  useEffect(() => {
    let vigente = true;
    void listarAuditoria({ pagina: 1 })
      .then((r) => {
        if (vigente) {
          setEventos(r.eventos);
        }
      })
      .catch(() => {
        // El resumen ya tiene su propio mensaje de error; que falten los eventos no
        // tapa los cuatro contadores, que son lo que la pantalla viene a mostrar.
        if (vigente) {
          setEventos([]);
        }
      });
    return () => {
      vigente = false;
    };
  }, [datos]);

  return (
    <MarcoAdmin titulo="Resumen del acceso">
      {error ? (
        <p role="alert" className="mb-4 font-interfaz text-chico text-sangre">
          {error}
        </p>
      ) : null}

      {cargando || !datos ? (
        <Cargando texto="Leyendo el panel" />
      ) : (
        <div className="space-y-8">
          {/*
            Los numeros van en `Cinzel` porque son titulos de tarjeta, y el
            subtexto en `Inter`: es la division de §2 aplicada a un contador.
          */}
          <ul className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Contador titulo="Usuarios" valor={datos.usuarios} pie={`${datos.usuarios_activos} activos`} />
            <Contador titulo="Inactivos" valor={datos.usuarios_inactivos} pie="sin ingreso" />
            <Contador titulo="Sesiones abiertas" valor={datos.sesiones_abiertas} pie="en este cliente" />
            <Contador titulo="Eventos (24 h)" valor={datos.eventos_24h} pie="ingresos y cierres" />
          </ul>

          <section aria-labelledby="titulo-eventos">
            <h2 id="titulo-eventos" className="font-titulo text-chico text-hueso">
              Últimos eventos
            </h2>
            <Costura className="my-3" />
            {eventos.length === 0 ? (
              <p className="font-interfaz text-chico text-plata">Todavía no hay eventos.</p>
            ) : (
              <ul className="space-y-2">
                {eventos.slice(0, 8).map((evento) => (
                  <li
                    key={evento.id}
                    className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-campo border border-hierro bg-tinta-alta px-3 py-2"
                  >
                    <span
                      className={`font-codigo text-menor ${tonoDe(evento.resultado)}`}
                    >
                      {evento.resultado}
                    </span>
                    <span className="font-interfaz text-chico text-hueso">
                      {evento.usuario ?? 'usuario desconocido'}
                    </span>
                    <span className="font-interfaz text-menor text-plata">
                      {evento.detalle ?? 'sin detalle'}
                    </span>
                    <span className="ml-auto font-interfaz text-menor text-plata">
                      {resumirNavegador(evento.user_agent)} · {evento.ip}
                    </span>
                    <span className="font-interfaz text-menor text-plata">{fecha(evento.ts)}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 font-interfaz text-menor text-plata">
              <button
                type="button"
                onClick={() => recargar()}
                className="foco-brasa rounded-campo px-2 py-1 text-plata underline hover:text-hueso"
              >
                Actualizar
              </button>
            </p>
          </section>
        </div>
      )}
    </MarcoAdmin>
  );
}

function Contador({ titulo, valor, pie }: { titulo: string; valor: number; pie: string }) {
  return (
    <li className="rounded-placa border border-plata/60 bg-tinta-alta p-4">
      <p className="font-titulo text-3xl text-hueso">{valor}</p>
      <p className="mt-1 font-interfaz text-chico text-plata">{titulo}</p>
      <p className="font-interfaz text-menor text-plata">{pie}</p>
    </li>
  );
}

/** Color del resultado. `ok` en verdigris, `error`/ataques en `sangre`. */
function tonoDe(resultado: string): string {
  if (resultado === 'ok') {
    return 'text-verdigris';
  }
  if (resultado === 'replay') {
    return 'text-sangre';
  }
  return 'text-plata';
}

function fecha(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleString(undefined, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}
