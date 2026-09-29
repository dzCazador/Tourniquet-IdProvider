/**
 * Vidas y ventanas de `specs/01` §3, en un solo lugar.
 *
 * Son decisiones de diseño, no defaults de una librería: cambiarlas es cambiar
 * el spec y este archivo, no sólo una constante perdida en un service. La única
 * que se ajusta por entorno es la vida del access (`ACCESS_TTL_MIN`), porque es
 * la que un operador tiene que poder tocar sin recompilar.
 */

/** Vida del authorization code. 60 s, un solo uso. */
export const CODE_TTL_SEG = 60;

/**
 * Default de `ACCESS_TTL_MIN`. Vive aca y en el esquema de entorno: si el
 * validador no recibe la vida por parametro, usa el mismo numero que la app usa
 * para emitir. Un validador con un TTL propio distinto del emisor acepta
 * tokens que el emisor ya no emite, o al reves.
 */
export const ACCESS_TTL_MIN_POR_DEFECTO = 15;

/** Refresh: 7 días de inactividad (deslizante). */
export const REFRESH_TTL_DIAS = 7;

/** Refresh/sesión: 30 días absolutos desde `tok_sesion.creado_en`. */
export const SESION_TTL_DIAS = 30;

/** Vida de la sesión central del portal: 8 h o logout. */
export const SESION_PORTAL_TTL_HORAS = 8;

/** `clockTolerance` de la validación. Máximo 60 s (`specs/01` §5). */
export const TOLERANCIA_RELOJ_SEG = 60;

/** Duración de la cookie de sesión del portal. */
export const COOKIE_SESION_MAX_AGE_SEG = SESION_PORTAL_TTL_HORAS * 60 * 60;

/** Nombre de la cookie de sesión del portal (`specs/01` §4). */
export const COOKIE_SESION_PORTAL = 'tok_sesion_portal';

export const MINUTO_MS = 60_000;
export const DIA_MS = 24 * 60 * MINUTO_MS;

export function enDias(dias: number, desde = new Date()): Date {
  return new Date(desde.getTime() + dias * DIA_MS);
}

export function enHoras(horas: number, desde = new Date()): Date {
  return new Date(desde.getTime() + horas * 60 * MINUTO_MS);
}

export function enSegundos(segundos: number, desde = new Date()): Date {
  return new Date(desde.getTime() + segundos * 1000);
}

