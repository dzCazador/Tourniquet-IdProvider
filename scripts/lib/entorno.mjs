/**
 * Arranque comun de los scripts `.mjs`: carga el backend compilado, carga el
 * `.env` y valida el entorno.
 *
 * Los scripts no levantan Nest, pero usan EXACTAMENTE el mismo esquema de Joi
 * que la app (`backend/src/config/env.schema.ts`). Si cada uno validara por su
 * cuenta, el mensaje que ve el operador al correr el bootstrap seria distinto
 * del que ve al arrancar la app, y con el tiempo alguno de los dos se queda
 * viejo y miente.
 */
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

export const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DIST = resolve(RAIZ, 'backend', 'dist');

/**
 * Carga un modulo del backend compilado.
 *
 * @throws sale con codigo 1 si el backend no esta compilado, que es la causa
 * casi unica de este error y la que mas confunde si no se dice.
 */
export function cargar(modulo) {
  const require = createRequire(import.meta.url);
  const archivo = resolve(DIST, modulo);
  try {
    return require(archivo);
  } catch (error) {
    if (error.code === 'MODULE_NOT_FOUND' && error.message.includes(archivo)) {
      console.error('\n  El backend no esta compilado. Correr primero:\n');
      console.error('      npm run build\n');
      process.exit(1);
    }
    throw error;
  }
}

/**
 * Carga el `.env` y valida el entorno. Sale con codigo 1 si algo no cumple.
 *
 * @returns el entorno ya validado, con los defaults aplicados, y un
 * `ConfigService` minimo para poder instanciar servicios que lo esperan
 * inyectado (`MasterKeyService`) sin montar Nest.
 */
export function prepararEntorno() {
  const esquema = cargar('config/env.schema.js');

  // Rutas de la raiz del repo, no relativas al cwd: el script se puede correr
  // desde cualquier lado y tiene que leer el mismo `.env` que la app.
  dotenv.config({ path: esquema.RUTAS_ENV });

  let entorno;
  try {
    entorno = esquema.validarEntorno();
  } catch (error) {
    console.error('\n  El entorno no es valido:\n');
    for (const linea of esquema.describirErrores(error)) {
      console.error(`  ${linea}`);
    }
    console.error('\n  Copiar .env.example a .env y completar. Para la master key:');
    console.error('      npm run generar:clave\n');
    process.exit(1);
  }

  return { entorno, configService: esquema.configServiceDe(entorno) };
}
