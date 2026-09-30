'use client';

import { useCallback, useEffect, useState } from 'react';
import { ErrorAdmin, ErrorPortal } from '@/lib/api';

/**
 * Estado de carga de una pantalla del panel, y el texto de sus errores.
 *
 * Las cuatro pantallas del panel hacen lo mismo: pedir un endpoint, mostrar la
 * mancha mientras llega, y mostrar **un** mensaje si falla. Con eso copiado cuatro
 * veces hay cuatro lugares donde el mensaje de "no pudimos leer" se escribe, y la
 * diferencia entre pantallas (una dice "reintentá", otra dice "no pudimos
 * comunicarnos") es la clase de error, no el estado.
 *
 * `usePanel` no_cachea nada entre pantallas: con `output: 'export'` cada pantalla es
 * una pagina y una recarga completa, así que la "cache" sería un modulo en
 * memoria que se pierde en la primera navegacion.
 */
export function usePanel<T>(carga: () => Promise<T>) {
  const [datos, setDatos] = useState<T | null>(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState('');

  const recargar = useCallback(async () => {
    setCargando(true);
    setError('');
    try {
      setDatos(await carga());
    } catch (fallo) {
      setError(mensajeDe(fallo));
    } finally {
      setCargando(false);
    }
    // `carga` va en las dependencias y es una funcion nueva en cada render del
    // llamador: sin el envoltorio, el efecto se re-dispara en cada render y la
    // pantalla queda pidiendo el mismo endpoint en loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let vigente = true;
    void carga()
      .then((r) => {
        if (vigente) {
          setDatos(r);
        }
      })
      .catch((fallo: unknown) => {
        if (vigente) {
          setError(mensajeDe(fallo));
        }
      })
      .finally(() => {
        if (vigente) {
          setCargando(false);
        }
      });
    return () => {
      vigente = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { datos, cargando, error, recargar };
}

/**
 * Texto de un error del panel.
 *
 * Los cuatro casos que el admin puede ver, y por qué tienen textos distintos:
 *
 *   - `sin_permiso`: no es admin de este cliente. No es recuperable desde la
 *     pantalla: el mensaje lo dice y la UI manda al lanzador.
 *   - `no_encontrado`: el usuario o el `sid` no es de este cliente, o ya no existe.
 *     El texto **no** dice cuál de las dos, porque el backend tampoco lo sabe (y esa
 *     es la razón del 404).
 *   - `conflicto:usuario_existe`: el login ya está en el sistema. Es el caso normal
 *     del alta de alguien que trabaja en dos clientes, y el texto lo explica.
 *   - `sin_conexion`: el IdP no respondió. Reintentar puede servir; avisar a quien
 *     administra, también.
 */
export function mensajeDe(fallo: unknown): string {
  if (fallo instanceof ErrorAdmin) {
    switch (fallo.codigo) {
      case 'sin_permiso':
        return 'Tu usuario no administra este cliente.';
      case 'no_encontrado':
        return 'No encontramos ese recurso en este cliente.';
      case 'conflicto:usuario_existe':
        return 'Ese usuario ya existe en el sistema. Se agregó a tu cliente sin cambiar sus datos.';
      case 'peticion_invalida:app_no_habilitable':
        return 'Una de las aplicaciones no existe en este cliente.';
      case 'peticion_invalida':
        return 'Los datos del formulario no son válidos.';
      case 'sesion_requerida':
        return 'Tu sesión no está activa. Volvé a entrar desde el portal.';
      case 'sin_conexion':
        return 'No pudimos comunicarnos con el servicio de identidad. Revisá tu conexión.';
      default:
        return 'No pudimos completar la operación. Reintentá en un momento.';
    }
  }

  if (fallo instanceof ErrorPortal) {
    return 'Tu sesión no está activa. Volvé a entrar desde el portal.';
  }

  return 'No pudimos completar la operación. Reintentá en un momento.';
}
