/**
 * Validacion del `returnTo` del login.
 *
 * `specs/01` §4: el authorize sin sesion manda al login con un `returnTo`, y ese
 * `returnTo` es una URL que decide a donde vuelve el usuario. Si se acepta sin
 * mirar, es un redirect abierto **con la sesion recien creada en la mano**: el
 * atacante pide el login con `returnTo=https://evil`, el backend escribe la
 * cookie de sesion y despues redirige al atacante desde el navegador del
 * usuario.
 *
 * La regla es deliberadamente MAS ESTRICTA que "empieza por /oidc/authorize"
 * (trampa 3 de la Fase 04):
 *
 *   1. Se parsea con `URL` contra el **issuer**, no con `startsWith`. Un
 *      `startsWith('/oidc/authorize')` acepta `//evil.com/oidc/authorize` y
 *      `/oidc/authorize.evil`, y no ve un `\` que algunos navegadores
 *      normalizan a `/`.
 *   2. El origen tiene que coincidir EXACTO con el del `iss`. Sin esto,
 *      `https://tourniquet.evil/oidc/authorize?...` pasaria el chequeo de
 *      prefijo.
 *   3. El path tiene que ser EXACTAMENTE `<base>/oidc/authorize`. Con
 *      `startsWith`, `/oidc/authorize-malicioso` entra.
 *   4. No se acepta `userinfo` (`https://tourniquet@evil/...`) ni fragmento
 *      (`#`, que el navegador ni manda al servidor ni puede validar).
 *   5. Sale un path RELATIVO. El navegador lo resuelve contra el origen del
 *      IdP, y el destino lo vuelve a validar entero `AuthorizeService`: aca se
 *      acepta la **forma**, no se confia en el contenido de la query.
 */

/** Tope de longitud. Un authorize legitimo con PKCE y `state` no pasa de 2 KB. */
const MAX_LONGITUD = 2048;

/** Path del authorize, relativo a la base del issuer (`specs/01` §1). */
const PATH_AUTHORIZE = '/oidc/authorize';

export type MotivoReturnTo = 'vacio' | 'largo' | 'caracteres' | 'no_relativo' | 'path' | 'fragmento';

export type ResultadoReturnTo =
  | { ok: true; destino: string }
  | { ok: false; motivo: MotivoReturnTo };

/**
 * Caracteres que hacen que un `returnTo` no se pueda ni leer ni comparar.
 *
 * Se chequean por codigo y no con una clase de caracteres de control dentro de
 * un regex, a proposito: esa regla dispara `no-control-regex`, y desactivar la
 * regla en todo el archivo para un chequeo de tres lineas es peor que
 * escribirlo explicito.
 */
function tieneCaracteresProhibidos(valor: string): boolean {
  for (let i = 0; i < valor.length; i++) {
    const codigo = valor.charCodeAt(i);
    if (codigo < 0x20 || codigo === 0x7f || valor[i] === '\\') {
      return true;
    }
  }
  return false;
}

/**
 * Normaliza y valida un `returnTo`.
 *
 * @param returnTo  Lo que vino en el cuerpo del POST. Vacio significa "el
 *                  usuario entro directo al login": es legitimo y devuelve la
 *                  raiz del portal.
 * @param issuer    `TQ_ISSUER` normalizado (sin barra final). Define el unico
 *                  origen al que se puede volver.
 */
export function validarReturnTo(
  returnTo: string | null | undefined,
  issuer: string,
): ResultadoReturnTo {
  const bruto = (returnTo ?? '').trim();

  if (bruto.length === 0) {
    return { ok: true, destino: '/' };
  }

  if (bruto.length > MAX_LONGITUD) {
    return { ok: false, motivo: 'largo' };
  }

  if (tieneCaracteresProhibidos(bruto)) {
    return { ok: false, motivo: 'caracteres' };
  }

  let url: URL;
  let base: URL;
  try {
    base = new URL(issuer);
    // Resolver contra el issuer es lo que neutraliza el protocol-relative:
    // `//evil.com/x` se parsea como URL absoluta con otro origen y cae en el
    // chequeo siguiente. Por eso el chequeo de origen va DESPUES del parseo.
    url = new URL(bruto, issuer);
  } catch {
    return { ok: false, motivo: 'no_relativo' };
  }

  if (url.origin !== base.origin) {
    return { ok: false, motivo: 'no_relativo' };
  }

  if (url.hash !== '') {
    return { ok: false, motivo: 'fragmento' };
  }

  if (url.username !== '' || url.password !== '') {
    return { ok: false, motivo: 'no_relativo' };
  }

  // El issuer puede tener una base de path (despliegue detras de un proxy con
  // prefijo). El authorize se sirve en `<base>/oidc/authorize`, asi que se
  // compara contra el path completo del issuer y no contra `/oidc/authorize`
  // a secas: si no, una instalacion valida con prefijo no podria loguearse.
  const basePath = base.pathname.replace(/\/+$/, '');
  if (url.pathname !== `${basePath}${PATH_AUTHORIZE}`) {
    return { ok: false, motivo: 'path' };
  }

  // Relativo, sin re-codificar: `url.search` ya viene percent-encoded por `URL`,
  // y re-codificar escaparia los `%` que la app cliente puso en su `state`.
  return { ok: true, destino: `${url.pathname}${url.search}` };
}

/**
 * `client_id` del authorize que trae el `returnTo` validado, o `null`.
 *
 * Se usa solo para **desambiguar el tenant** de la sesion del portal (ver
 * `PortalService.resolverCliente`): un usuario con varias membresias que entra
 * por una app tiene un unico cliente posible. No es una decision de seguridad
 * del authorize -- ese sigue validando `client_id` entero contra
 * `cat_aplicacion` -- asi que un valor raro aca no rompe nada: cae en el camino
 * ambiguo.
 */
export function clientIdDelReturnTo(destino: string): string | null {
  try {
    const url = new URL(destino, 'http://origen.invalido');
    const valor = url.searchParams.get('client_id');
    return valor && valor.length > 0 && valor.length <= 40 ? valor : null;
  } catch {
    return null;
  }
}
