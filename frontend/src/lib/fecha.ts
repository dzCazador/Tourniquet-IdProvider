/**
 * Formato de fechas del portal.
 *
 * Vive en `lib/` y no en una pagina porque **tres** pantallas lo necesitan (el
 * panel de usuarios, el de sesiones y el de auditoría) y porque importar un helper
 * desde `page.tsx` mete la pagina entera en el grafo de modulos de las otras dos: con
 * `import { fecha } from '../usuarios/page'`, `/admin/sesiones` arrastra el formulario
 * de alta del panel de usuarios a su bundle (se ve en el tamano de la pagina: 181 B
 * en `/admin/usuarios` y el codigo entero en el chunk compartido).
 *
 * **La hora es local del navegador, no del servidor.** `specs/00` §fechas: en la base
 * es UTC, en la API es ISO, y el formateo es de la UI. Un admin que lee "14:05" y
 * está en otra zona horaria tiene que entender que esa hora es la suya, no la del
 * servidor; por eso el formato lleva el día y el mes, y no solo la hora.
 */

/** `30/09 14:05` en hora local. `—` si la fecha no se puede parsear. */
export function fecha(iso: string | null | undefined): string {
  if (!iso) {
    return '—';
  }
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleString(undefined, {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
}

/** `14:05` en hora local, para las pantallas donde el día ya está a la vista. */
export function hora(iso: string | null | undefined): string {
  if (!iso) {
    return '—';
  }
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
