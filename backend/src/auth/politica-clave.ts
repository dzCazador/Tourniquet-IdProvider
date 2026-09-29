/**
 * Politica minima de contrasenas (`specs/01` §4):
 *   1. 10 caracteres o mas
 *   2. sin diccionario comun
 *   3. sin fecha
 *
 * La complejidad por cliente entra despues via `cat_cliente.politica_json`
 * (Fase 04). Esto es el piso que no se negocia para ningun tenant.
 */

export const LONGITUD_MINIMA = 10;
export const LONGITUD_MAXIMA = 200;

/**
 * Lista corta a proposito: no es un filtro de compromiso, es una barrera para
 * que nadie arranque con "password123". El argon2id hace el trabajo pesado.
 */
const DICCIONARIO_COMUN = new Set([
  'password', 'password1', 'password123', 'passw0rd', 'contrasena', 'contraseña',
  'contrasena1', 'clave123', 'clave1234', 'qwerty', 'qwerty123', '123456',
  '12345678', '123456789', '1234567890', 'administrator', 'administrador',
  'admin123', 'admin1234', 'welcome', 'welcome1', 'letmein', 'changeme',
  'tourniquet', 'tourniquet1', 'rhpro', 'rhpro123', 'usuario', 'usuario1',
  'abc123', 'abc12345', 'iloveyou', 'monkey', 'dragon', 'master', 'login',
  'prueba', 'prueba123', 'test1234', 'secret', 'secreto', 'sistema',
]);

/**
 * Secuencias con forma de fecha: `dd-mm-aaaa`, `aaaa-mm-dd`, `mm-aaaa`, y las
 * variantes compactas de 6 y 8 digitos. Cubre cualquier "fecha del tenant" que
 * alguien empiece a usar como contrasena sin pensar en que es la primera
 * palabra que un atacante prueba.
 *
 * Los limites se expresan con lookarounds y NO con `\b`: `\b` no existe entre
 * una letra y un digito, asi que `Quilmes12051990` (que es exactamente como
 * la gente escribe una fecha en una contrasena) se escapaba. Ademas se valida
 * que dia y mes esten en rango, para no rechazar una contrasena fuerte que
 * tenga 8 digitos seguidos por casualidad.
 */
const RE_AAAA_MM_DD = /(?<!\d)(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/;
const RE_DD_MM_AAAA = /(?<!\d)(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})(?!\d)/;
const RE_MM_AAAA = /(?<!\d)(\d{1,2})[-/.](\d{4})(?!\d)/;
const RE_DDMMAAAA = /(?<!\d)(\d{2})(\d{2})(\d{4})(?!\d)/;
const RE_AAAAMMDD = /(?<!\d)(\d{4})(\d{2})(\d{2})(?!\d)/;

function enRango(valor: string, min: number, max: number): boolean {
  const numero = Number(valor);
  return numero >= min && numero <= max;
}

/** `true` si el texto contiene algo que se lee como una fecha de calendario. */
export function contieneFecha(texto: string): boolean {
  let m = RE_AAAA_MM_DD.exec(texto);
  if (m && enRango(m[2], 1, 12) && enRango(m[3], 1, 31)) {
    return true;
  }

  m = RE_DD_MM_AAAA.exec(texto);
  if (m && enRango(m[1], 1, 31) && enRango(m[2], 1, 12)) {
    return true;
  }

  m = RE_MM_AAAA.exec(texto);
  if (m && enRango(m[1], 1, 12)) {
    return true;
  }

  m = RE_DDMMAAAA.exec(texto);
  if (m && enRango(m[1], 1, 31) && enRango(m[2], 1, 12)) {
    return true;
  }

  m = RE_AAAAMMDD.exec(texto);
  if (m && enRango(m[2], 1, 12) && enRango(m[3], 1, 31)) {
    return true;
  }

  return false;
}

export interface ContextoPolitica {
  /** Se rechaza si la contrasena lo contiene. */
  usuario?: string;
  codigoCliente?: string;
  nombreCliente?: string;
}

export interface ResultadoPolitica {
  valida: boolean;
  motivos: string[];
}

function normalizar(valor: string): string {
  return valor.trim().toLowerCase();
}

/**
 * Evalua la politica minima. Devuelve TODOS los motivos, no el primero: el
 * bootstrap imprime la lista entera para que el usuario no tenga que adivinar
 * e iterar.
 */
export function validarPoliticaClave(
  clave: string,
  contexto: ContextoPolitica = {},
): ResultadoPolitica {
  const motivos: string[] = [];
  const plano = normalizar(clave);

  if (typeof clave !== 'string' || clave.length === 0) {
    return { valida: false, motivos: ['la contrasena esta vacia'] };
  }

  if (clave.length < LONGITUD_MINIMA) {
    motivos.push(`debe tener al menos ${LONGITUD_MINIMA} caracteres`);
  }

  if (clave.length > LONGITUD_MAXIMA) {
    motivos.push(`no puede superar ${LONGITUD_MAXIMA} caracteres`);
  }

  if (DICCIONARIO_COMUN.has(plano)) {
    motivos.push('es una contrasena de diccionario comun');
  }

  // Se prueba sobre el texto plano, no sobre una forma normalizada: "clave-2024"
  // tiene que caer igual.
  if (contieneFecha(clave)) {
    motivos.push('no debe contener una fecha');
  }

  if (contexto.usuario && plano.includes(normalizar(contexto.usuario))) {
    motivos.push('no debe contener el nombre de usuario');
  }

  for (const prohibido of [contexto.codigoCliente, contexto.nombreCliente]) {
    if (prohibido && prohibido.length >= 4 && plano.includes(normalizar(prohibido))) {
      motivos.push('no debe contener el nombre del cliente');
      break;
    }
  }

  return { valida: motivos.length === 0, motivos };
}

/** `idn_usuario.usuario` es unico y se guarda en minuscula (`specs/02` §3). */
export function normalizarUsuario(usuario: string): string {
  return usuario.trim().toLowerCase();
}
