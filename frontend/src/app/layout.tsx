import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { clasesDeFuente } from '@/design/fonts';
import { color } from '@/design/tokens';
import './globals.css';

/**
 * Layout raiz.
 *
 * `lang="es"` no es decorativo: sin el, un lector de pantalla de un Windows en
 * ingles pronuncia el español con las reglas del ingles, y los nombres propios
 * ("Tourniquet", los nombres de cliente) salen irreconocibles.
 *
 * `export const dynamic = 'force-static'` explicito porque el build es
 * `output: 'export'` y todo el portal es estatico: no hay nada del lado del
 * servidor que esperar. La sesion se lee desde el navegador contra `tq-api`
 * con la cookie `HttpOnly` (`specs/01` §4), y por eso la pagina de login es un
 * componente cliente.
 */
export const dynamic = 'force-static';

export const metadata: Metadata = {
  title: {
    default: 'Tourniquet',
    template: '%s · Tourniquet',
  },
  description: 'Ingreso unico a las aplicaciones de la organizacion.',
  robots: {
    // El portal no tiene nada que indexear: las pantallas reales (login,
    // lanzador, panel) son todas de sesion. Dejarlo abierto hace que un
    // buscador indexe un login que despues le muestra a cualquiera.
    index: false,
    follow: false,
  },
};

/**
 * `width`/`initialScale` se declaran igual que el default de Next porque el
 * motivo para declararlos es lo que **no** se pone: nada de `maximumScale` ni
 * `userScalable: false`. Bloquear el zoom es un fallo de WCAG 1.4.4 y el
 * criterio de la fase pide ver la pagina a 200 %.
 *
 * `themeColor` va en `viewport` y no en `metadata` porque Next 14 lo rechaza
 * en `metadata` (avisa en cada build) y lo usa para pintar las barras del
 * navegador en Android: sin el, hay un destello blanco en cada navegacion.
 */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: color.tinta,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es" className={clasesDeFuente}>
      <body className="min-h-screen bg-tinta text-hueso antialiased">{children}</body>
    </html>
  );
}
