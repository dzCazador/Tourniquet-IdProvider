'use client';

import { useState } from 'react';
import { MarcoAdmin } from '../_marco';
import { Cargando } from '@/design/components/Marco';
import { Boton } from '@/design/components/Boton';
import { Campo } from '@/design/components/Campo';
import { listarAuditoria, type EventoAuditoria } from '@/lib/api';
import { usePanel } from '../_datos';
import { fecha } from '@/lib/fecha';
import { resumirNavegador } from '@/lib/user-agent';

/**
 * `/admin/auditoria`: los eventos de los miembros de este cliente.
 *
 * Lo que el backend **no** manda y por qué importa (trampa 1 de la fase 08):
 *
 *   - **No hay eventos de otros clientes.** `aud_login` es global y un login
 *     fallido de un usuario de otro tenant trae su IP y su navegador. El filtro es
 *     por membresía, y la prueba es explícita: un login fallido de otro cliente no
 *     aparece.
 *   - **No hay eventos con `idusuario IS NULL`.** Son los intentos de login contra
 *     cuentas que no existen, y sin `idusuario` no hay forma de saber de qué cliente
 *     eran: no le sirven a nadie de este panel.
 *
 * El `detalle` se muestra **partido**: el código (`admin_cierra_sesion`,
 * `clave_incorrecta`) y los identificadores que lo hacen accionable (`usuario=…`,
 * `sid=…`, `motivo=…`). Es la diferencia entre una columna de texto y una que
 * responde "¿quién le cerró la sesión a este usuario y por qué?".
 */
export default function PanelAuditoria() {
  const { datos, cargando, error } = usePanel(() => listarAuditoria({}));
  const [usuario, setUsuario] = useState('');
  const [resultado, setResultado] = useState('');
  const [filtrado, setFiltrado] = useState<{ total: number; eventos: EventoAuditoria[] } | null>(null);
  const [consultando, setConsultando] = useState(false);

  const eventos = filtrado?.eventos ?? datos?.eventos ?? [];
  const total = filtrado?.total ?? datos?.total ?? 0;

  async function filtrar(evento: React.FormEvent<HTMLFormElement>): Promise<void> {
    evento.preventDefault();
    setConsultando(true);
    try {
      setFiltrado(
        await listarAuditoria({
          ...(usuario.trim() ? { usuario: usuario.trim() } : {}),
          ...(resultado ? { resultado } : {}),
        }),
      );
    } catch {
      setFiltrado(null);
    } finally {
      setConsultando(false);
    }
  }

  return (
    <MarcoAdmin titulo="Auditoría">
      {error ? (
        <p role="alert" className="mb-4 font-interfaz text-chico text-sangre">
          {error}
        </p>
      ) : null}

      <form
        onSubmit={(e) => void filtrar(e)}
        className="mb-4 flex flex-wrap items-end gap-2"
        noValidate
      >
        <Campo
          etiqueta="Usuario"
          name="usuario"
          className="min-w-48 flex-1"
          value={usuario}
          onChange={(e) => setUsuario(e.target.value)}
          autoComplete="off"
          ayuda="Busca por login, entre los miembros de este cliente."
        />
        <label className="block">
          <span className="block font-interfaz text-chico text-plata">Resultado</span>
          <select
            value={resultado}
            onChange={(e) => setResultado(e.target.value)}
            className="foco-brasa mt-1 min-h-tactil rounded-campo border border-plata/60 bg-tinta px-2 py-2 font-interfaz text-chico text-hueso"
          >
            <option value="">Todos</option>
            {['ok', 'claves', 'bloq', 'replay', 'expirado', 'error'].map((valor) => (
              <option key={valor} value={valor}>
                {valor}
              </option>
            ))}
          </select>
        </label>
        <Boton type="submit" cargando={consultando} className="min-h-tactil">
          Filtrar
        </Boton>
      </form>

      {cargando && eventos.length === 0 ? (
        <Cargando texto="Leyendo la auditoría" />
      ) : eventos.length === 0 ? (
        <p className="font-interfaz text-chico text-plata">No hay eventos para ese filtro.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[52rem] border-collapse text-left">
            <caption className="sr-only">Eventos de auditoría de los miembros de este cliente</caption>
            <thead>
              <tr className="border-b border-plata/60">
                {['Cuándo', 'Resultado', 'Usuario', 'Qué pasó', 'Navegador', 'IP'].map((columna) => (
                  <th
                    key={columna}
                    scope="col"
                    className="px-3 py-2 font-interfaz text-menor uppercase tracking-wide text-plata"
                  >
                    {columna}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {eventos.map((evento) => (
                <tr key={evento.id} className="border-b border-hierro align-top">
                  <td className="whitespace-nowrap px-3 py-2 font-interfaz text-menor text-plata">
                    {fecha(evento.ts)}
                  </td>
                  <td className="px-3 py-2">
                    <span className={`font-codigo text-menor ${tonoDe(evento.resultado)}`}>
                      {evento.resultado}
                    </span>
                  </td>
                  <td className="px-3 py-2 font-interfaz text-chico text-hueso">
                    {evento.usuario ?? <span className="text-plata">(desconocido)</span>}
                  </td>
                  <td className="px-3 py-2">
                    <p className="font-codigo text-menor text-hueso">{evento.detalle ?? '—'}</p>
                    {evento.contexto ? (
                      <ul className="mt-1 space-y-0.5">
                        {Object.entries(evento.contexto).map(([clave, valor]) => (
                          <li key={clave} className="font-interfaz text-menor text-plata">
                            {clave}: <span className="font-codigo">{valor}</span>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 font-interfaz text-menor text-plata">
                    {resumirNavegador(evento.user_agent)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 font-codigo text-menor text-plata">
                    {evento.ip}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-3 font-interfaz text-menor text-plata">
        {eventos.length} de {total} evento(s). La auditoría se conserva 2 años y no se borra desde
        la aplicación.
      </p>
    </MarcoAdmin>
  );
}

function tonoDe(resultado: string): string {
  if (resultado === 'ok') {
    return 'text-verdigris';
  }
  if (resultado === 'replay' || resultado === 'error') {
    return 'text-sangre';
  }
  return 'text-plata';
}
