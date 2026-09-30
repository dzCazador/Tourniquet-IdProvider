'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { MarcoAdmin } from '../_marco';
import { MfaTabla, useMfaPanel } from './_mfa';
import { Cargando } from '@/design/components/Marco';
import { Boton } from '@/design/components/Boton';
import { Campo } from '@/design/components/Campo';
import { Confirmar } from '@/design/components/Confirmar';
import { Costura } from '@/design/ornaments/Costura';
import {
  altaUsuario,
  deshabilitarApp,
  editarUsuario,
  ErrorAdmin,
  habilitarApp,
  listarAppsDisponibles,
  listarUsuarios,
  resetearClave,
  type UsuarioAdmin,
} from '@/lib/api';
import { mensajeDe, usePanel } from '../_datos';
import { fecha } from '@/lib/fecha';

/**
 * `/admin/usuarios`: el listado del tenant, con alta, edición, reset y
 * habilitación.
 *
 * La pantalla tiene tres bloques y ninguno compite con los otros: la **búsqueda**
 * arriba, la **tabla** en el medio y el **formulario de alta** aparte (una placa
 * debajo de la tabla, no un modal: un modal encima de una tabla es el lugar donde
 * un error de validación no se ve porque quedó tapado).
 *
 * **La tabla es sobria** (estética §2, nivel bajo): `Inter`, sin textura, bordes de
 * `hierro`, y el scroll horizontal **dentro** de la tabla (`overflow-x-auto` en el
 * contenedor, no en la página) para que a 360 px la página no se desplace. Es el
 * criterio de la 08 y el motivo por el que la tabla va en un `div` y no en una
 * grilla con `min-w`: el `min-w` es lo que hace scrollear la página entera.
 *
 * `intentos_fallidos` y `bloqueado_hasta` **no se piden** al backend (trampa 2 de
 * la fase 08): mostrarlos le dice a quien puede estar probando contraseñas de esa
 * cuenta en qué estado está el bloqueo.
 */
export default function PanelUsuarios() {
  const { datos, cargando, error, recargar } = usePanel(() => listarUsuarios({}));
  const [q, setQ] = useState('');
  const [buscando, setBuscando] = useState(false);
  const [mensaje, setMensaje] = useState('');

  /**
   * El listado del **filtro activo**, o el de la primera carga.
   *
   * Son dos estados a propósito y no uno: la búsqueda va al backend (para paginar
   * bien y no traer 4000 filas) y `usePanel` no sabe de filtros. Se resuelve con
   * `filtrados ?? datos`, y `filtrados` se vuelve a `null` con cada recarga para
   * que la próxima carga del panel sea la que manda.
   */
  const [filtrados, setFiltrados] = useState<typeof datos>(null);

  const filas = useMemo(() => {
    const base = filtrados ?? datos;
    if (!base) {
      return null;
    }
    return q.trim() ? { ...base, usuarios: filtrar(base.usuarios, q) } : base;
  }, [datos, filtrados, q]);

  async function buscar(evento: React.FormEvent<HTMLFormElement>): Promise<void> {
    evento.preventDefault();
    setBuscando(true);
    setMensaje('');
    try {
      setFiltrados(await listarUsuarios({ q: q.trim() || undefined }));
    } catch (fallo) {
      setMensaje(mensajeDe(fallo));
    } finally {
      setBuscando(false);
    }
  }

  return (
    <MarcoAdmin titulo="Usuarios">
      {error ? (
        <p role="alert" className="mb-4 font-interfaz text-chico text-sangre">
          {error}
        </p>
      ) : null}
      {mensaje ? (
        <p role="alert" className="mb-4 font-interfaz text-chico text-sangre">
          {mensaje}
        </p>
      ) : null}

      <form onSubmit={(e) => void buscar(e)} className="mb-4 flex flex-wrap items-end gap-2">
        <Campo
          etiqueta="Buscar por usuario, nombre o apellido"
          name="q"
          className="min-w-64 flex-1"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoComplete="off"
        />
        <Boton type="submit" cargando={buscando} className="min-h-tactil">
          Buscar
        </Boton>
      </form>

      {cargando && !filas ? (
        <Cargando texto="Leyendo los usuarios" />
      ) : filas ? (
        <TablaUsuarios
          usuarios={filas.usuarios}
          total={filas.total}
          alCambiar={() => {
            setFiltrados(null);
            recargar();
          }}
          avisar={setMensaje}
        />
      ) : null}

      <Costura className="my-8" />

      <FormularioAlta alTerminar={() => { setFiltrados(null); recargar(); }} />
    </MarcoAdmin>
  );
}

/** Filtro del lado del navegador para el texto ya escrito: la lista del tenant es chica. */
function filtrar(usuarios: UsuarioAdmin[], texto: string): UsuarioAdmin[] {
  const bajo = texto.toLowerCase();
  return usuarios.filter((u) =>
    [u.usuario, u.nombre, u.apellido].some((campo) => campo.toLowerCase().includes(bajo)),
  );
}

/** Nombre completo, con fallback al `usuario` si no hay nombre cargado. */
function nombreDe(usuario: UsuarioAdmin): string {
  const completo = `${usuario.nombre} ${usuario.apellido}`.trim();
  return completo.length > 0 ? completo : usuario.usuario;
}

function TablaUsuarios({
  usuarios,
  total,
  alCambiar,
  avisar,
}: {
  usuarios: UsuarioAdmin[];
  total: number;
  alCambiar: () => void;
  avisar: (texto: string) => void;
}) {
  const [confirmando, setConfirmando] = useState<
    { usuario: UsuarioAdmin; accion: 'desactivar' | 'reset' | 'deshabilitar'; app?: string } | null
  >(null);
  const [ocupado, setOcupado] = useState(false);
  const [claveNueva, setClaveNueva] = useState<{ usuario: string; clave: string } | null>(null);

  /**
   * MFA: su propio hook con sus propios diálogos (`_mfa.tsx`).
   *
   * Vive aparte y no como tres estados más acá porque el bloque de entregables
   * (secret + 10 códigos, **una sola vez**) es un caso distinto del de la clave
   * temporal: se muestra **después** de la confirmación y tiene que sobrevivir a
   * la recarga de la tabla. Con un estado más por acción, el `setConfirmando(null)`
   * del `ejecutar` común se llevaría por delante el bloque que el admin todavía
   * tiene que leer.
   */
  const mfa = useMfaPanel({ avisar, alTerminar: alCambiar });

  async function ejecutar(): Promise<void> {
    if (!confirmando || ocupado) {
      return;
    }
    setOcupado(true);
    avisar('');
    try {
      if (confirmando.accion === 'desactivar') {
        await editarUsuario(confirmando.usuario.idusuario, { estado: 'inactivo' });
      } else if (confirmando.accion === 'reset') {
        const r = await resetearClave(confirmando.usuario.idusuario);
        setClaveNueva({ usuario: confirmando.usuario.usuario, clave: r.clave_temporal });
      } else if (confirmando.app) {
        await deshabilitarApp(confirmando.usuario.idusuario, confirmando.app);
      }
      setConfirmando(null);
      alCambiar();
    } catch (fallo) {
      avisar(mensajeDe(fallo));
    } finally {
      setOcupado(false);
    }
  }

  return (
    <>
      {/*
        El `overflow-x-auto` va acá y no en la pagina: a 360 px la tabla se scrollea
        sola y el encabezado del portal queda quieto (criterio de la 08).
      */}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[46rem] border-collapse text-left">
          <caption className="sr-only">
            Usuarios del cliente, con sus apps habilitadas y su última sesión
          </caption>
          <thead>
            <tr className="border-b border-plata/60">
              {['Usuario', 'Nombre', 'Apps habilitadas', 'Última sesión', 'Estado', 'MFA', 'Acciones'].map(
                (columna) => (
                  <th
                    key={columna}
                    scope="col"
                    className="px-3 py-2 font-interfaz text-menor uppercase tracking-wide text-plata"
                  >
                    {columna}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {usuarios.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-4 font-interfaz text-chico text-plata">
                  No hay usuarios que coincidan.
                </td>
              </tr>
            ) : (
              usuarios.map((usuario) => (
                <tr key={usuario.idusuario} className="border-b border-hierro align-top">
                  <td className="px-3 py-2 font-codigo text-chico text-hueso">{usuario.usuario}</td>
                  <td className="px-3 py-2 font-interfaz text-chico text-hueso">{nombreDe(usuario)}</td>
                  <td className="px-3 py-2">
                    <ul className="flex flex-wrap gap-1">
                      {usuario.apps.length === 0 ? (
                        <li className="font-interfaz text-menor text-plata">ninguna</li>
                      ) : (
                        usuario.apps.map((app) => (
                          <li key={app}>
                            <span className="mr-1 inline-flex items-center gap-1 rounded-campo border border-plata/60 px-2 py-0.5 font-codigo text-menor text-hueso">
                              {app}
                              {/*
                                El botón de deshabilitar va **dentro** de la celda de
                                la app, con `aria-label` que dice a quién y a qué
                                app: con cuatro apps por fila, cuatro botones
                                iguales no dicen qué deshabilitan (trampa 6).
                              */}
                              <button
                                type="button"
                                aria-label={`Deshabilitar el acceso de ${nombreDe(usuario)} a ${app}`}
                                onClick={() =>
                                  setConfirmando({ usuario, accion: 'deshabilitar', app })
                                }
                                className="foco-brasa text-plata hover:text-sangre"
                              >
                                ×
                              </button>
                            </span>
                          </li>
                        ))
                      )}
                    </ul>
                  </td>
                  <td className="px-3 py-2 font-interfaz text-menor text-plata">
                    {usuario.ultima_sesion ? fecha(usuario.ultima_sesion) : 'nunca'}
                  </td>
                  <td className="px-3 py-2">
                    <Estado valor={usuario.estado} />
                  </td>
                  <td className="px-3 py-2">
                    <MfaTabla usuario={usuario} />
                  </td>
                  <td className="px-3 py-2">
                    <ul className="flex flex-wrap gap-2">
                      <li>
                        <Boton
                          variante="secondary"
                          className="min-h-tactil px-2 py-1"
                          onClick={() => setConfirmando({ usuario, accion: 'reset' })}
                        >
                          Nueva clave
                        </Boton>
                      </li>
                      <li>
                        <Boton
                          variante="secondary"
                          className="min-h-tactil px-2 py-1"
                          onClick={() => setConfirmando({ usuario, accion: 'desactivar' })}
                        >
                          {usuario.estado === 'inactivo' ? 'Reactivar' : 'Desactivar'}
                        </Boton>
                      </li>
                      {/*
                        Los tres botones de MFA, y su regla de aparición: los que
                        aplican al estado actual. "Activar MFA" **no** aparece con
                        un segundo factor ya enrolado (`pending` u `on`), porque
                        activar genera un secret nuevo y deja el anterior dando
                        vueltas: para cambiar el secret, el camino es desactivar
                        (que pide confirmación y queda auditado) y volver a
                        activar.
                      */}
                      {!usuario.mfa || usuario.mfa.estado === 'off' ? (
                        <li>
                          <Boton
                            variante="secondary"
                            className="min-h-tactil px-2 py-1"
                            onClick={() => mfa.pedir(usuario, 'activar')}
                          >
                            Activar MFA
                          </Boton>
                        </li>
                      ) : (
                        <>
                          <li>
                            <Boton
                              variante="secondary"
                              className="min-h-tactil px-2 py-1"
                              onClick={() => mfa.pedir(usuario, 'desactivar')}
                            >
                              Desactivar MFA
                            </Boton>
                          </li>
                          <li>
                            <Boton
                              variante="secondary"
                              className="min-h-tactil px-2 py-1"
                              onClick={() => mfa.pedir(usuario, 'codigos')}
                            >
                              C&#243;digos MFA
                            </Boton>
                          </li>
                        </>
                      )}
                    </ul>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <p className="mt-2 font-interfaz text-menor text-plata">
        {usuarios.length} de {total} usuario(s) del cliente.
      </p>

      {confirmando ? (
        <Confirmar
          titulo={
            confirmando.accion === 'reset'
              ? 'Generar una clave nueva'
              : confirmando.accion === 'desactivar'
                ? `${confirmando.usuario.estado === 'inactivo' ? 'Reactivar' : 'Desactivar'} el acceso de ${nombreDe(confirmando.usuario)}`
                : `Deshabilitar a ${nombreDe(confirmando.usuario)} en ${confirmando.app}`
          }
          textoConfirmar={
            confirmando.accion === 'reset'
              ? `Generar la clave de ${confirmando.usuario.usuario}`
              : confirmando.accion === 'desactivar'
                ? `${confirmando.usuario.estado === 'inactivo' ? 'Reactivar' : 'Desactivar'} a ${nombreDe(confirmando.usuario)}`
                : `Deshabilitar ${confirmando.app} a ${nombreDe(confirmando.usuario)}`
          }
          destructivo={confirmando.accion !== 'reset' && confirmando.usuario.estado !== 'inactivo'}
          onCancel={() => setConfirmando(null)}
          onConfirm={() => void ejecutar()}
          ocupado={ocupado}
        >
          {confirmando.accion === 'reset' ? (
            <p>
              Se genera una clave nueva y se muestra <strong>una sola vez</strong>. La anterior deja de
              funcionar de inmediato.
            </p>
          ) : confirmando.accion === 'desactivar' ? (
            <p>
              {confirmando.usuario.estado === 'inactivo'
                ? 'Vuelve a poder entrar al portal y a las apps habilitadas.'
                : 'Deja de poder entrar y se cierran sus sesiones abiertas en este cliente. Sus apps abiertas dejan de valer en el próximo uso.'}
            </p>
          ) : (
            <p>
              No podrá entrar a <strong>{confirmando.app}</strong> en el próximo ingreso. Si tiene una
              sesión abierta, puede seguir usándola hasta que expire.
            </p>
          )}
        </Confirmar>
      ) : null}

      {claveNueva ? (
        <ClaveTemporal
          usuario={claveNueva.usuario}
          clave={claveNueva.clave}
          alCerrar={() => setClaveNueva(null)}
        />
      ) : null}

      {mfa.dialogos}
    </>
  );
}

/**
 * La clave temporal, una vez.
 *
 * Es la unica pantalla del producto que muestra un secreto, y por eso tiene tres
 * cuidados: el aviso de que **no se vuelve a ver** (y es verdad: el backend solo
 * tiene el hash), el boton de copiar —un admin que reescribe 20 caracteres a mano
 * los manda por chat a un usuario, que es peor (trampa 3 de la 08)— y el foco en el
 * texto para que un Ctrl+C ande sin seleccionar.
 */
function ClaveTemporal({
  usuario,
  clave,
  alCerrar,
}: {
  usuario: string;
  clave: string;
  alCerrar: () => void;
}) {
  const [copiado, setCopiado] = useState(false);

  return (
    <Confirmar
      titulo={`Clave temporal de ${usuario}`}
      textoConfirmar="Ya la copié, cerrar"
      onCancel={alCerrar}
      onConfirm={alCerrar}
    >
      <p>
        Esta clave se muestra <strong>una sola vez</strong>. Después solo queda su hash: si se pierde,
        hay que generar otra.
      </p>
      <p className="rounded-campo border border-plata/60 bg-tinta p-3 text-center font-codigo text-lg tracking-widest text-hueso">
        {clave}
      </p>
      <p>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(clave);
            setCopiado(true);
          }}
          className="foco-brasa rounded-campo border border-plata/60 px-3 py-1 text-plata hover:text-hueso"
        >
          {copiado ? 'Copiada' : 'Copiar'}
        </button>
      </p>
    </Confirmar>
  );
}

function Estado({ valor }: { valor: string }) {
  const inactivo = valor === 'inactivo';
  return (
    <span
      className={`font-interfaz text-menor ${inactivo ? 'text-plata' : 'text-verdigris'}`}
    >
      {inactivo ? 'inactivo' : 'activo'}
    </span>
  );
}

/**
 * El formulario de alta.
 *
 * Tres decisiones que son de la fase y no del formulario:
 *
 *  1. **La clave la genera el servidor** y se muestra una vez. El campo de clave
 *     **no está** en el formulario (trampa 3 de la 08).
 *  2. **Las apps salen de `GET /admin/apps`**, que es la lista habilitable de este
 *     cliente. Un `<input>` de texto libre para las apps dejaría escribir cualquier
 *     `codigo` y el error (400 `app_no_habilitable`) llegaría después de haber
 *     escrito el resto del formulario.
 *  3. **El `usuario` va con el patrón del backend** (`[a-z0-9._-]`, minúsculas) en el
 *     campo y no solo en el servidor: el mensaje de validación del navegador es
 *     instantáneo y sin ir a la red, y el backend vuelve a validarlo igual.
 */
function FormularioAlta({ alTerminar }: { alTerminar: () => void }) {
  const [usuario, setUsuario] = useState('');
  const [nombre, setNombre] = useState('');
  const [apellido, setApellido] = useState('');
  const [email, setEmail] = useState('');
  const [apps, setApps] = useState<string[]>([]);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState('');
  const [alta, setAlta] = useState<{ usuario: string; compartido: boolean; clave: string | null } | null>(
    null,
  );

  const { datos: disponibles } = usePanel(() => listarAppsDisponibles());

  async function enviar(evento: React.FormEvent<HTMLFormElement>): Promise<void> {
    evento.preventDefault();
    if (enviando) {
      return;
    }
    setEnviando(true);
    setError('');
    try {
      const r = await altaUsuario({
        usuario: usuario.trim().toLowerCase(),
        nombre: nombre.trim(),
        apellido: apellido.trim(),
        ...(email.trim() ? { email: email.trim() } : {}),
        aplicaciones: apps,
      });
      setAlta({ usuario: r.usuario, compartido: r.compartido, clave: r.clave_temporal });
      alTerminar();
      setUsuario('');
      setNombre('');
      setApellido('');
      setEmail('');
      setApps([]);
    } catch (fallo) {
      setError(mensajeDe(fallo));
    } finally {
      setEnviando(false);
    }
  }

  return (
    <section aria-labelledby="titulo-alta">
      <h2 id="titulo-alta" className="font-titulo text-chico text-hueso">
        Dar de alta un usuario
      </h2>
      <p className="mt-1 max-w-2xl font-interfaz text-menor text-plata">
        Si el usuario ya existe en el sistema (trabaja en otro cliente), se le agrega a{' '}
        <strong>este</strong> cliente sin cambiar sus datos ni su clave.
      </p>

      <form onSubmit={(e) => void enviar(e)} className="mt-4 max-w-2xl space-y-3" noValidate>
        {error ? (
          <p role="alert" className="font-interfaz text-chico text-sangre">
            {error}
          </p>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <Campo
            etiqueta="Usuario (login)"
            name="usuario"
            value={usuario}
            onChange={(e) => setUsuario(e.target.value)}
            required
            minLength={3}
            maxLength={50}
            pattern="[a-z0-9._\-]{3,50}"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            ayuda="Minúsculas, números, punto, guion y guion bajo."
          />
          <Campo
            etiqueta="Correo"
            name="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="off"
          />
          <Campo
            etiqueta="Nombre"
            name="nombre"
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            required
            autoComplete="off"
          />
          <Campo
            etiqueta="Apellido"
            name="apellido"
            value={apellido}
            onChange={(e) => setApellido(e.target.value)}
            autoComplete="off"
          />
        </div>

        <fieldset>
          <legend className="font-interfaz text-chico text-plata">Aplicaciones habilitadas</legend>
          <div className="mt-2 flex flex-wrap gap-3">
            {(disponibles?.apps ?? []).map((app) => (
              <label key={app.codigo} className="flex min-h-tactil items-center gap-2">
                <input
                  type="checkbox"
                  name="apps"
                  value={app.codigo}
                  checked={apps.includes(app.codigo)}
                  onChange={(e) =>
                    setApps((previas) =>
                      e.target.checked
                        ? [...previas, app.codigo]
                        : previas.filter((a) => a !== app.codigo),
                    )
                  }
                  className="foco-brasa h-4 w-4 accent-[#7a0f16]"
                />
                <span className="font-interfaz text-chico text-hueso">
                  {app.nombre} <span className="font-codigo text-menor text-plata">{app.codigo}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <Boton type="submit" cargando={enviando}>
          Dar de alta
        </Boton>
      </form>

      {alta ? (
        <ClaveTemporal
          usuario={alta.usuario}
          clave={alta.clave ?? '(sin clave temporal)'}
          alCerrar={() => setAlta(null)}
        />
      ) : null}

      {alta?.compartido ? (
        <p role="status" className="mt-3 font-interfaz text-chico text-verdigris">
          Ese usuario ya existía en el sistema: se agregó a este cliente con sus datos y su clave.
        </p>
      ) : null}
    </section>
  );
}
