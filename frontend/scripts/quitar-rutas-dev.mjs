#!/usr/bin/env node
/**
 * Borra `/dev/` del export estatico, SIEMPRE en `next build`.
 *
 * `/dev/token` es la pagina que decodifica un access token a mano
 * (`specs/todo/begin/fase-04-portal-login.md` §6). Existe para desarrollo y no
 * puede quedar en un build de produccion.
 *
 * Por que hace falta este script y no alcanza con `notFound()` en la pagina:
 * `notFound()` ya impide que el formulario se escriba en el HTML (eso lo hace
 * el Server Component de `app/dev/token/page.tsx`, y es la primera linea de
 * defensa), pero Next **igual deja el archivo** `out/dev/token/index.html` en
 * el export, con el cuerpo del 404 adentro. Un web server estatico no sabe
 * que esa pagina "no existe": si el archivo esta, responde 200, y el criterio
 * de la fase -- "en build de produccion la ruta devuelve 404" -- seria falso
 * solo por un detalle del hosting.
 *
 * Con este script el archivo no esta, y la ruta no existe de verdad. Es la
 * diferencia entre "no se puede ver el token" y "no hay pagina".
 *
 * `next dev` no produce `out/`, asi que la herramienta de desarrollo sigue
 * disponible en `npm run dev` sin tocar nada.
 */
import { rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const objetivo = join(raiz, 'out', 'dev');

try {
  await rm(objetivo, { recursive: true, force: true });
  console.log('  out/dev eliminado: el inspector de token no existe en este build.');
} catch (error) {
  // `force: true` hace que no falle si la carpeta no esta (build sin la ruta,
  // o plataforma Windows con un archivo tomado). Si de verdad falla, se avisa:
  // un token decodificable en produccion no es un detalle cosmetico.
  console.error(
    '  No se pudo eliminar out/dev:',
    error instanceof Error ? error.message : 'error desconocido',
  );
  process.exitCode = 1;
}
