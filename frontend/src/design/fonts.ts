import { Cinzel, EB_Garamond, Inter, JetBrains_Mono, UnifrakturMaguntia } from 'next/font/google';

/**
 * Las cinco tipografias de `estetica-tourniquet.md` §3, auto-alojadas.
 *
 * `next/font` las descarga en build y las emite como `woff2` local con un
 * subtconjunto latino: en runtime **no hay ni una request a un CDN de Google**
 * (criterio 9 de §9). Eso importa mas de lo que parece en un IdP: una pantalla
 * de login que depende de un tercero de terceros tiene un modo de falla que no
 * es un modo de falla de la app, y ademas filtra la IP del empleado a un
 * servicio de terceros.
 *
 * `display: 'swap'` en todas. Un login no puede esperar a una fuente, y con
 * `swap` el texto aparece ya y la fuente reemplaza cuando llega; sin
 * `fallback` calibrado, el salto de ancho alinea el formulario y lo hace
 * "bailar" justo en el momento en que el usuario esta escribiendo su clave.
 *
 * **`preload` solo en el wordmark** (trampa 6 de la fase 07, que es donde se
 * cobró la factura de esta decisión). `next/font` tiene `preload: true` por
 * default, y con cinco familias el login descargaba las cinco antes de pintar el
 * formulario, incluidas las que la pantalla no usa arriba del pliegue. El
 * comentario de esta versión del archivo decía "preload en ninguna" y el
 * código no lo cumplía: el default de la librería es `true`, y no poner la
 * opción **es** poner `true`.
 *
 * La regla que queda es la del spec: se precarga lo que está en el primer
 * viewport y lo demás se pide solo si hay texto que lo necesite. Del login, eso
 * es el wordmark (arriba, en blackletter, y sin él la pantalla dice
 * "Tourniquet" en una serif de reserva durante medio segundo). `Cinzel` (el
 * título de la placa), `EB Garamond` (los avisos de abajo) e `Inter`
 * (etiquetas y botón) se piden cuando los hay.
 *
 * Los pesos son los **usados**, no los de la paleta completa: cada peso extra
 * es un woff2 en el export que alguien tiene que servir de mas. Cuando la Fase
 * 07 pinsca un peso nuevo, se agrega aca y no se reemplaza a ojo.
 */

const wordmark = UnifrakturMaguntia({
  subsets: ['latin'],
  weight: '400',
  display: 'swap',
  // Unico preload del portal: es el unico texto en el primer viewport de las seis
  // pantallas, y el que mas se nota si tarda (dice el nombre del producto).
  preload: true,
  variable: '--fuente-wordmark',
  fallback: ['serif'],
});

const titulo = Cinzel({
  subsets: ['latin'],
  // 400 para el H1/H2 de pagina, 600 para el wordmark del panel. El 700 no se
  // carga: los `h1`/`h2` del portal pesan 400/600 explicitamente y sin esto el
  // navegador sintetiza el bold y el titulo queda de otro grosor al de la
  // fuente.
  weight: ['400', '600'],
  display: 'swap',
  preload: false,
  variable: '--fuente-titulo',
  fallback: ['serif'],
});

const cuerpo = EB_Garamond({
  subsets: ['latin'],
  weight: '400',
  display: 'swap',
  preload: false,
  variable: '--fuente-cuerpo',
  fallback: ['serif'],
});

const interfaz = Inter({
  subsets: ['latin'],
  display: 'swap',
  preload: false,
  variable: '--fuente-interfaz',
  fallback: ['system-ui', 'Segoe UI', 'Arial', 'sans-serif'],
});

const codigo = JetBrains_Mono({
  subsets: ['latin'],
  weight: '400',
  display: 'swap',
  // Solo la usa el inspector de token de desarrollo, que no existe en el export de
  // produccion (`quitar-rutas-dev.mjs`). Precargarla en el login seria pagar una
  // fuente que ninguna pantalla de produccion usa.
  preload: false,
  variable: '--fuente-codigo',
  fallback: ['ui-monospace', 'Consolas', 'monospace'],
});

/** Clases que hay que poner en `<html>` para que las variables existan. */
export const clasesDeFuente = [
  wordmark.variable,
  titulo.variable,
  cuerpo.variable,
  interfaz.variable,
  codigo.variable,
].join(' ');
