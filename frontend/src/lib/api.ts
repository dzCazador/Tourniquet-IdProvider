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
function leerClientesDelError(valor: unknown): ResumenCliente[] | undefined {
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
    clientes: leerClientesDelError((cuerpo as { clientes?: unknown }).clientes),
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

/**
 * `POST /auth/logout-all`: "salir de todo".
 *
 * Cierra todas las sesiones del usuario **en el cliente de su sesion**, la del
 * portal y la de cada app. Es distinto de `cerrarSesion`, que solo cierra la del
 * portal, y la distincion va en el boton y en la pantalla: "salir del portal" deja
 * las apps vivas, "salir de todo" las mata (fase 07 §7).
 */
export async function cerrarTodo(): Promise<{ cerradas: number }> {
  const respuesta = await pedir('/auth/logout-all', { method: 'POST', cache: 'no-store' });
  if (!respuesta.ok) {
    throw await aErrorPortal(respuesta);
  }
  return (await respuesta.json()) as { cerradas: number };
}

// --- El lanzador (fase 07) ----------------------------------------------------

export interface Membresia {
  idcliente: string;
  nombre: string;
  rol: string;
}

export interface QuienSoy {
  usuario: string;
  nombre: string;
  email: string | null;
  clienteActual: Membresia;
  clientes: Membresia[];
  expira_en: string;
}

export interface AppLanzador {
  codigo: string;
  nombre: string;
  /** Nombre de la base de datos, o `null` si la app no tiene inventariada ninguna. */
  base: string | null;
  /** URL de arranque registrada (`cat_aplicacion.url_inicio`). */
  inicio: string;
}

export interface SesionPropia {
  sid: string;
  idaplicacion: string | null;
  app: string;
  es_portal: boolean;
  ip: string;
  user_agent: string;
  creado_en: string;
  expira_en: string;
}

/** `GET /me`, o `null` si no hay sesion central. */
export async function leerYo(): Promise<QuienSoy | null> {
  const respuesta = await pedir('/me', { cache: 'no-store' });
  if (respuesta.status === 401) {
    return null;
  }
  if (!respuesta.ok) {
    throw await aErrorPortal(respuesta);
  }
  return (await respuesta.json()) as QuienSoy;
}

/** `GET /me/clientes`: las membresías activas del usuario. */
export async function leerClientes(): Promise<Membresia[]> {
  const respuesta = await pedir('/me/clientes', { cache: 'no-store' });
  if (!respuesta.ok) {
    throw await aErrorPortal(respuesta);
  }
  const cuerpo = (await respuesta.json()) as { clientes?: Membresia[] };
  return cuerpo.clientes ?? [];
}

/**
 * `GET /me/apps`: las apps habilitadas en el cliente de la sesion.
 *
 * La lista puede venir **vacia** y eso no es un error: es el estado de un usuario
 * con membresía pero sin ninguna app habilitada, que el panel muestra con un texto
 * propio. Por eso la funcion devuelve el array y no tira.
 */
export async function leerApps(): Promise<AppLanzador[]> {
  const respuesta = await pedir('/me/apps', { cache: 'no-store' });
  if (!respuesta.ok) {
    throw await aErrorPortal(respuesta);
  }
  const cuerpo = (await respuesta.json()) as { apps?: AppLanzador[] };
  return cuerpo.apps ?? [];
}

/**
 * `POST /me/cliente-activo`: cambia el cliente de la sesion.
 *
 * Un POST y no un `?cliente=` por URL, por el motivo del backend: el `tenant` sale
 * de la sesion, nunca del pedido. Aca se devuelve la sesion nueva y la cookie ya
 * reescrita, asi que la pagina solo tiene que recargar.
 */
export async function cambiarClienteActivo(cliente: string): Promise<QuienSoy> {
  const respuesta = await pedir('/me/cliente-activo', {
    method: 'POST',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cliente }),
  });
  if (!respuesta.ok) {
    throw await aErrorPortal(respuesta);
  }
  return (await respuesta.json()) as QuienSoy;
}

export interface SesionesPropias {
  total: number;
  hay_mas: boolean;
  sesiones: SesionPropia[];
}

/** `GET /me/sesiones`: las sesiones vivas del usuario en el cliente de su sesion. */
export async function leerSesiones(): Promise<SesionesPropias> {
  const respuesta = await pedir('/me/sesiones', { cache: 'no-store' });
  if (!respuesta.ok) {
    throw await aErrorPortal(respuesta);
  }
  return (await respuesta.json()) as SesionesPropias;
}

/**
 * `DELETE /me/sesiones/:sid`: cierra una sesion **propia**.
 *
 * Un `sid` de otro usuario responde 404, que es indistinguible de "no existe": por
 * eso no se muestra ningun mensaje que distinga los dos casos.
 */
export async function cerrarSesionPropia(sid: string): Promise<void> {
  const respuesta = await pedir(`/me/sesiones/${encodeURIComponent(sid)}`, {
    method: 'DELETE',
    cache: 'no-store',
  });
  if (!respuesta.ok) {
    throw await aErrorPortal(respuesta);
  }
}

// --- El consentimiento (fase 07) ----------------------------------------------

export interface DatosConsentimiento {
  app: { codigo: string; nombre: string };
  cliente: { codigo: string; nombre: string };
  base: string | null;
}

/** `GET /oidc/consentimiento`: los hechos para pintar la pantalla de consentimiento. */
export async function leerConsentimiento(clientId: string): Promise<DatosConsentimiento> {
  const respuesta = await pedir(`/oidc/consentimiento?client_id=${encodeURIComponent(clientId)}`, {
    cache: 'no-store',
  });
  if (!respuesta.ok) {
    const fallo = await leerErrorOidc(respuesta);
    throw new ErrorConsentimiento(fallo.error, respuesta.status);
  }
  return (await respuesta.json()) as DatosConsentimiento;
}

/** `POST /oidc/consentir`: acepta y devuelve la URL de la app. */
export async function consentir(pedido: Record<string, string>): Promise<string> {
  const respuesta = await pedir('/oidc/consentir', {
    method: 'POST',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(pedido),
  });
  if (!respuesta.ok) {
    const fallo = await leerErrorOidc(respuesta);
    throw new ErrorConsentimiento(fallo.error, respuesta.status);
  }
  const cuerpo = (await respuesta.json()) as { url?: string };
  if (typeof cuerpo.url !== 'string') {
    throw new ErrorConsentimiento('server_error', 502);
  }
  return cuerpo.url;
}

/**
 * Errores del authorize y del consentimiento, en los codigos cerrados de
 * `specs/01` §1.
 *
 * Son **otra** lista y no la de `CodigoPortal`, a proposito: son codigos de OAuth
 * (`access_denied`, `login_required`), no del portal, y mezclarlos en un solo
 * `Record` de textos seria una lista de 25 entradas donde la mitad nunca aparece en
 * la misma pantalla.
 */
export type CodigoOidc =
  | 'invalid_request'
  | 'unauthorized_client'
  | 'access_denied'
  | 'invalid_scope'
  | 'login_required'
  | 'portal_no_configurado'
  | 'server_error'
  | 'sin_conexion';

export class ErrorConsentimiento extends Error {
  constructor(
    readonly codigo: CodigoOidc,
    readonly status: number,
  ) {
    super(codigo);
    this.name = 'ErrorConsentimiento';
  }
}

const CODIGOS_OIDC: ReadonlySet<string> = new Set<CodigoOidc>([
  'invalid_request',
  'unauthorized_client',
  'access_denied',
  'invalid_scope',
  'login_required',
  'portal_no_configurado',
  'server_error',
  'sin_conexion',
]);

/**
 * Traduce la respuesta de un endpoint OIDC a `ErrorConsentimiento`.
 *
 * Un `sin_conexion` por el mismo motivo que en `pedir`: si el backend esta caido,
 * el consejo "reintenta" no sirve, y el codigo tiene que poder distinguirlo.
 */
async function leerErrorOidc(respuesta: Response): Promise<{ error: CodigoOidc }> {
  if (respuesta.status === 0) {
    return { error: 'sin_conexion' };
  }
  let codigo: unknown;
  try {
    const cuerpo = (await respuesta.json()) as { error?: unknown };
    codigo = cuerpo.error;
  } catch {
    // Sin JSON: manda el status y abajo se cae en `server_error`.
  }
  return {
    error: typeof codigo === 'string' && CODIGOS_OIDC.has(codigo) ? (codigo as CodigoOidc) : 'server_error',
  };
}

export { API_URL };
