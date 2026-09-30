/**
 * Resumen de `user_agent` para las dos pantallas que lo muestran: las sesiones
 * propias (`/mi-cuenta`) y la auditoría del panel.
 *
 * Por que un parser propio y no una librería: el dato que se muestra es
 * "navegador / sistema" (trampa 6 de la fase 07), son dos campos, y la librería
 * que hace eso trae un diccionario de signatures de por medio que hay que mantener
 * para siempre y que en un IdP corporativo no aporta nada. Ademas, un
 * `user_agent` de 500 caracteres en una celda de 300 px es ilegible, y lo que el
 * admin quiere comparar es "¿este usuario entrando desde otro equipo?".
 *
 * **Lo que se guarda es la cadena cruda** (esta en `tok_sesion.user_agent` y en
 * `aud_login.user_agent`) y lo que se muestra es esto: guardar el resumen perderia
 * el dato de diagnostico, que es el que sirve cuando el resumen no alcanza.
 *
 * Es un parser **mínimo y a proposito degradable**: si no reconoce el navegador,
 * dice "Navegador desconocido" en vez de inventar uno, y el sistema operativo se
 * deduce por lo que se pueda. Un resumen equivocado en una pantalla de sesiones es
 * peor que un resumen incompleto: hace pensar que uno sabe algo que no sabe.
 */

/** Familia de navegador, en el orden en que se prueban (el primero que gana). */
const NAVEGADORES: ReadonlyArray<readonly [string, RegExp]> = [
  ['Edge', /Edg[eA]?\/|EdgiOS\//],
  ['Opera', /OPR\/|Opera/],
  ['Chrome', /Chrom(?:e|ium)\//],
  ['Firefox', /Firefox\/|FxiOS\//],
  ['Safari', /Safari\//],
  ['Internet Explorer', /MSIE |Trident\//],
];

/** Sistema operativo: la clave es lo que aparece en el UA, no una deducción. */
const SISTEMAS: ReadonlyArray<readonly [string, RegExp]> = [
  ['Windows', /Windows/],
  ['Android', /Android/],
  ['iOS', /iPhone|iPad|iPod/],
  ['macOS', /Mac OS X|Macintosh/],
  ['Linux', /Linux|X11/],
];

/**
 * "Chrome 120 / Windows".
 *
 * La version sale del propio UA, y es la **major** porque la minor no dice nada
 * útil para un admin ("¿este usuario esta en un Chrome de la semana pasada?") y
 * hace la celda tres veces mas ancha.
 */
export function resumirNavegador(userAgent: string): string {
  const ua = userAgent ?? '';

  const navegador = NAVEGADORES.find(([, patron]) => patron.test(ua));
  const sistema = SISTEMAS.find(([, patron]) => patron.test(ua));

  const nombre = navegador ? navegador[0] : 'Navegador desconocido';
  const version = navegador ? versionMayor(ua, navegador[0]) : '';
  const sistemaTexto = sistema ? sistema[0] : 'sistema desconocido';

  return [nombre + version, sistemaTexto].join(' / ');
}

function versionMayor(ua: string, navegador: string): string {
  // Cada familia usa un token distinto para su version, y el orden importa: `Safari`
  // esta en el UA de Chrome (`Chrome/120 ... Safari/537`), asi que si se buscara
  // `Version/` antes que el token de cada familia, todo Safari seria la version de
  // WebKit. Por eso el token va con el nombre del navegador.
  const token: Record<string, RegExp> = {
    Edge: /Edg[eA]?\/([\d.]+)/,
    Opera: /OPR\/([\d.]+)/,
    Chrome: /Chrom(?:e|ium)\/([\d.]+)/,
    Firefox: /Firefox\/([\d.]+)/,
    Safari: /Version\/([\d.]+)/,
    'Internet Explorer': /(?:MSIE |rv:)([\d.]+)/,
  };

  const patron = token[navegador];
  const encontrado = patron?.exec(ua);
  return encontrado ? ` ${encontrado[1]?.split('.')[0]}` : '';
}
