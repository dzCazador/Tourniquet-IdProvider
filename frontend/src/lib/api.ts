/**
 * Cliente HTTP del portal. UNO solo, para las tres operaciones de sesion.
 *
 * La razon de que sea uno y no tres `fetch` sueltos en cada pagina no es DRY:
 * es que `credentials: 'include'` y `cache: 'no-store'` son **requisitos de
 * seguridad** de este flujo, no preferencias de estilo (`specs/01` §4). Un
 * `fetch` que se olvide de `credentials: 'include'` en la pantalla de logout
 * deja la cookie puesta sin avisar, y el usuario cree que salio.
 */

/**
 * Base de la API. En build se congela (`NEXT_PUBLIC_*` se reemplaza por
 * Next), asi que es un valor de configuracion, no un secreto: el front no tiene
 * ni `TQ_MASTER_KEY` ni `DATABASE_URL`, y no deberia empezar a tenerlos.
 */
const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001').replace(/\/+$/, '');

/**
 * Codigos que manda `AuthController` (`backend/src/auth/portal.service.ts`).
 * Lista CERRADA y de la misma forma en los dos lados: aca se decide el texto,
 * alla se decide el codigo. El backend nunca manda una frase para mostrar.
 */
export type CodigoPortal =
  | 'clave_incorrecta'
  | 'credencial_desconocida'
  | 'bloqueado'
  | 'inactivo'
  | 'rate_limit'
  | 'returnto_invalido'
  | 'sin_cliente'
  | 'cliente_ambiguo'
  | 'cliente_no_pertenece'
  | 'sesion_requerida'
  // SOLO del cliente: el `fetch` ni llego al servidor (backend caido, CORS mal
  // puesto, sin red). Status 0. Es un codigo del portal, no del backend, por
  // eso no esta en `CodigoPortal` de `portal.service.ts`.
  | 'sin_conexion'
  | 'error';

export interface ResumenCliente {
  idcliente: string;
  nombre: string;
}

export interface ErrorApi {
  codigo: CodigoPortal;
  /** Resumen tecnico del backend. NO se muestra al usuario. */
  mensaje?: string;
  /** ISO 8601. Solo cuando `codigo === 'bloqueado'`. */
  bloqueado_hasta?: string;
  /** Segundos. Solo cuando `codigo === 'rate_limit'`. */
  reintento_seg?: number;
  /** Solo en `cliente_ambiguo`: los clientes del usuario, para elegir. */
  clientes?: ResumenCliente[];
}

export class ErrorPortal extends Error {
  constructor(
    readonly codigo: CodigoPortal,
    readonly status: number,
    readonly datos: Omit<ErrorApi, 'codigo'>,
  ) {
    super(codigo);
    this.name = 'ErrorPortal';
  }
}

interface ErrorCrudo {
  codigo?: unknown;
  mensaje?: unknown;
  bloqueado_hasta?: unknown;
  reintento_seg?: unknown;
  message?: unknown;
  error?: unknown;
}

function esRegistro(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === 'object' && valor !== null;
}

function texto(valor: unknown): string | undefined {
  return typeof valor === 'string' ? valor : undefined;
}

function numero(valor: unknown): number | undefined {
  return typeof valor === 'number' && Number.isFinite(valor) ? valor : undefined;
}

/**
 * Lee la lista de clientes del error `cliente_ambiguo`.
 *
 * Se valida en el cliente y no se confia en la forma: si el backend mandara
 * cualquier otra cosa, se descarta y el portal vuelve al mensaje generico en
 * vez de renderizar `undefined` como nombre de un boton.
 */
function leerClientes(valor: unknown): ResumenCliente[] | undefined {
  if (!Array.isArray(valor)) {
    return undefined;
  }
  const lista = valor.filter(
    (c): c is ResumenCliente =>
      typeof c === 'object' &&
      c !== null &&
      typeof (c as ResumenCliente).idcliente === 'string' &&
      typeof (c as ResumenCliente).nombre === 'string',
  );
  return lista.length > 0 ? lista : undefined;
}

/**
 * Normaliza cualquier falla a `ErrorPortal`.
 *
 * Un error de red (CORS, backend caido, DNS) no tiene cuerpo JSON: cae en
 * `fallback` y se reporta como `error`. La distincion importa porque
 * `sin_cliente` y `cliente_ambiguo` son situacion del usuario y merecen un
 * texto propio, mientras que un 502 del servidor no y no se resuelve con texto:
 * se resuelve reintentando.
 */
async function aErrorPortal(respuesta: Response): Promise<ErrorPortal> {
  let cuerpo: ErrorCrudo = {};
  try {
    const parseado: unknown = await respuesta.json();
    if (esRegistro(parseado)) {
      cuerpo = parseado as ErrorCrudo;
    }
  } catch {
    // Respuesta sin JSON (un 502 de un proxy, una pagina de error del web
    // server). Se sigue con el cuerpo vacio y el status manda.
  }

  const codigoCrudo = cuerpo.codigo ?? cuerpo.error;
  const codigo: CodigoPortal =
    typeof codigoCrudo === 'string' && esCodigoConocido(codigoCrudo) ? codigoCrudo : 'error';

  return new ErrorPortal(codigo, respuesta.status, {
    mensaje: texto(cuerpo.mensaje) ?? texto(cuerpo.message),
    bloqueado_hasta: texto(cuerpo.bloqueado_hasta),
    reintento_seg: numero(cuerpo.reintento_seg),
    clientes: leerClientes((cuerpo as { clientes?: unknown }).clientes),
  });
}

const CODIGOS: ReadonlySet<string> = new Set<CodigoPortal>([
  'clave_incorrecta',
  'credencial_desconocida',
  'bloqueado',
  'inactivo',
  'rate_limit',
  'returnto_invalido',
  'sin_cliente',
  'cliente_ambiguo',
  'cliente_no_pertenece',
  'sesion_requerida',
  'sin_conexion',
  'error',
]);

function esCodigoConocido(valor: string): valor is CodigoPortal {
  return CODIGOS.has(valor);
}

async function pedir(ruta: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(`${API_URL}${ruta}`, {
      ...init,
      // SIEMPRE. La sesion del portal viaja en la cookie `tok_sesion_portal`
      // y sin esto el login "funciona" y al refrescar da 401.
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        ...(init.headers ?? {}),
      },
    });
  } catch (error) {
    // Falla ANTES de llegar al servidor: el backend esta caido, CORS esta mal
    // puesto, o no hay red. Codigo propio y no `error`, porque el consejo que
    // corresponde es otro: "reintenta en un momento" no sirve si lo que esta
    // caido es el servicio de identidad, y en un portal corporativo lo que
    // hace falta es avisarle a quien lo administra.
    throw new ErrorPortal('sin_conexion', 0, {
      mensaje: error instanceof Error ? error.message : 'fallo de red',
    });
  }
}

export interface EstadoSesion {
  usuario: string;
  nombre: string;
  clienteActual: { idcliente: string; nombre: string };
  expira_en: string;
}

export interface ResultadoLogin extends EstadoSesion {
  /** Path RELATIVO ya validado por el backend. Nunca una URL absoluta. */
  returnTo: string;
}

/**
 * `POST /auth/login`.
 *
 * El `returnTo` viaja **completo** y lo revalida el backend: el front no
 * decide a donde se vuelve (`estetica-tourniquet.md` no aplica aca, pero si
 * `fase-04` §5). Que este metodo no lo sanee es a proposito: si lo hiciera,
 * la unica validacion real estaria en un componente que cualquiera puede
 * editar.
 */
export async function iniciarSesion(
  usuario: string,
  clave: string,
  returnTo: string | null,
  cliente?: string | null,
): Promise<ResultadoLogin> {
  const respuesta = await pedir('/auth/login', {
    method: 'POST',
    // `no-store`: una respuesta con sesion en el cache del navegador es una
    // sesion que sobrevive al logout.
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      usuario,
      clave,
      ...(returnTo ? { returnTo } : {}),
      ...(cliente ? { cliente } : {}),
    }),
  });

  if (!respuesta.ok) {
    throw await aErrorPortal(respuesta);
  }

  return (await respuesta.json()) as ResultadoLogin;
}

/** `GET /auth/session`, o `null` si no hay sesion. */
export async function leerSesion(): Promise<EstadoSesion | null> {
  const respuesta = await pedir('/auth/session', { cache: 'no-store' });

  // 401 es "no hay sesion", no un fallo: el 401 no distingue cookie de otro,
  // sesion cerrada y sesion vencida, y no hay que distinguirlo.
  if (respuesta.status === 401) {
    return null;
  }
  if (!respuesta.ok) {
    throw await aErrorPortal(respuesta);
  }

  return (await respuesta.json()) as EstadoSesion;
}

/** `POST /auth/logout`. Idempotente: sin sesion tambien responde 200. */
export async function cerrarSesion(): Promise<void> {
  const respuesta = await pedir('/auth/logout', { method: 'POST', cache: 'no-store' });
  if (!respuesta.ok) {
    throw await aErrorPortal(respuesta);
  }
}

export { API_URL };
