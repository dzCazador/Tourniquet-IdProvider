'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Boton } from '@/design/components/Boton';
import { Costura } from '@/design/ornaments/Costura';
import { cambiarClienteActivo, cerrarTodo, ErrorPortal, type Membresia } from '@/lib/api';

/**
 * La cabecera del portal con sesion: cliente activo, selector, "salir de todo" y
 * el enlace a `/mi-cuenta`.
 *
 * Va en `_portal/` y no en un `layout.tsx` compartido por dos razones. La primera
 * es que necesita **datos de sesion**, y un layout de App Router con `output:
 * 'export'` no tiene forma de leerlos: hay que pedir `/me` desde el navegador. La
 * segunda es que la cabecera es distinta en cada pantalla: el login no la tiene, la
 * pantalla de puerta no deberia tener "salir de todo" (el usuario todavia no
 * entro), y la despedida no tiene nada de esto. Un layout comun obligaria a
 * la condicion en todas partes.
 *
 * **El selector solo aparece con dos o mas membresias** (`estetica-tourniquet.md`
 * §7): con una, la pregunta ya esta contestada y el control es ruido.
 */
export function CabeceraPortal({
  nombre,
  cliente,
  clientes,
  esAdmin,
}: {
  nombre: string;
  cliente: Membresia;
  clientes: Membresia[];
  esAdmin: boolean;
}) {
  const router = useRouter();
  const [cambiando, setCambiando] = useState(false);
  const [saliendo, setSaliendo] = useState(false);
  const [error, setError] = useState('');

  async function cambiar(clienteElegido: string): Promise<void> {
    if (cambiando || clienteElegido === cliente.idcliente) {
      return;
    }
    setCambiando(true);
    setError('');
    try {
      await cambiarClienteActivo(clienteElegido);
      // `router.refresh()` no sirve en un export estatico: no hay servidor de
      // render al que volver a pedir. La recarga es real, y es la que trae la
      // cookie nueva.
      window.location.assign('/');
    } catch (fallo) {
      setError(
        fallo instanceof ErrorPortal && fallo.codigo === 'cliente_no_pertenece'
          ? 'No sos miembro de ese cliente.'
          : 'No pudimos cambiar de cliente. Reintenta en un momento.',
      );
      setCambiando(false);
    }
  }

  async function salirDeTodo(): Promise<void> {
    if (saliendo) {
      return;
    }
    if (!window.confirm('Esto cierra tu sesión del portal y todas las apps de este cliente. ¿Seguís?')) {
      return;
    }
    setSaliendo(true);
    setError('');
    try {
      await cerrarTodo();
    } catch {
      setError('No pudimos cerrar las sesiones. Reintenta en un momento.');
      setSaliendo(false);
      return;
    }
    window.location.assign('/logout/despedida');
  }

  return (
    <div className="border-b border-hierro bg-tinta-alta">
      <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3 sm:px-6">
        <div className="min-w-0">
          {/*
            El nombre del cliente va en `Cinzel` y el `usuario` en `Inter`: el
            primero es titulo de pantalla y el segundo es dato. Invertirlo es el
            error clasico de esta cabecera.
          */}
          <p className="truncate font-titulo text-chico text-hueso">{cliente.nombre}</p>
          <p className="truncate font-interfaz text-menor text-plata">
            {nombre} · <span className="font-codigo">{cliente.idcliente}</span>
          </p>
        </div>

        <nav aria-label="Navegacion del portal" className="ml-auto flex flex-wrap items-center gap-2">
          {clientes.length > 1 ? (
            <label className="flex items-center gap-2">
              <span className="font-interfaz text-menor text-plata">Cliente</span>
              {/*
                Un `<select>` y no una lista de botones como en el login: aca la
                eleccion es "ir a otro sitio" (recarga la pagina) y no "responder
                una pregunta de esta pantalla", y un desplegable no tapa el
                contenido de abajo. El login, que si tiene que decidir sin salir de
                la pantalla, usa botones.
              */}
              <select
                value={cliente.idcliente}
                disabled={cambiando}
                onChange={(evento) => void cambiar(evento.target.value)}
                className="foco-brasa min-h-tactil rounded-campo border border-plata/60 bg-tinta px-2 py-1 font-interfaz text-chico text-hueso hover:border-plata disabled:opacity-60"
              >
                {clientes.map((c) => (
                  <option key={c.idcliente} value={c.idcliente}>
                    {c.nombre}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          {esAdmin ? (
            <Link
              href="/admin"
              className="foco-brasa inline-flex min-h-tactil items-center rounded-campo border border-plata/60 px-3 py-1 font-interfaz text-chico text-hueso hover:bg-hierro"
            >
              Administración
            </Link>
          ) : null}

          <Link
            href="/mi-cuenta"
            className="foco-brasa inline-flex min-h-tactil items-center rounded-campo border border-plata/60 px-3 py-1 font-interfaz text-chico text-hueso hover:bg-hierro"
          >
            Mis sesiones
          </Link>

          <Boton variante="secondary" className="min-h-tactil px-3 py-1" onClick={() => void salirDeTodo()} cargando={saliendo}>
            Salir de todo
          </Boton>
        </nav>
      </div>

      {error ? (
        <div role="alert" className="mx-auto w-full max-w-5xl px-4 pb-3 sm:px-6">
          <p className="font-interfaz text-menor text-sangre">{error}</p>
        </div>
      ) : null}

      <div className="mx-auto w-full max-w-5xl px-4 pb-2 sm:px-6">
        <Costura />
      </div>
    </div>
  );
}
