import { resolve } from 'node:path';
import * as Joi from 'joi';
import { decodificarMasterKey } from '../claves/crypto';

/**
 * Fuente única de verdad del entorno. Toda variable que el backend use tiene que
 * estar acá: si no está en este esquema, no es configuración, es una variable
 * que alguien inventó.
 *
 * Por qué Joi y no validación a mano en cada punto de uso (que es lo que hace
 * RHPro, ver `specs/00` §7): con el esquema, una variable mal escrita se
 * detecta **antes** de levantar la app y en un solo lugar. distributed checks
 * significan que la mitad de las variables se validan y la otra mitad no, y
 * nadie se da cuenta hasta que algo falla en producción.
 */

/**
 * Variables cuyo valor NO puede aparecer nunca en un mensaje de error ni en un
 * log. Se redactan a mano aunque Joi no filtre (ver `redactar`).
 *
 * `DATABASE_URL` entra acá porque suele traer usuario y clave de la base: una
 * cadena de conexión en un error es una credencial escrita en un log
 * (invariante de `AGENTS.md`).
 */
export const VARIABLES_SENSIBLES = ['TQ_MASTER_KEY', 'DATABASE_URL', 'TQ_BOOTSTRAP_CLAVE'] as const;

/**
 * `TQ_MASTER_KEY` se valida llamando a `decodificarMasterKey`, la MISMA función
 * que usa `MasterKeyService` al descifrar. Es deliberado:
 *
 * - Una sola definición de "qué es una master key válida". Si el schema y el
 *   servicio tuvieran reglas propias, podrían divergir y la app validaría con
 *   una clave que después no puede usar.
 * - No se usa `Joi.string().pattern(...)` a propósito: esa regla mete el valor
 *   literal en el mensaje de error, y eso imprimiría la master key en la
 *   consola del operador cada vez que se pegue mal. Los `custom` no filtran.
 */
const masterKey = Joi.string()
  .required()
  .custom((valor, helpers) => {
    try {
      decodificarMasterKey(valor);
      return valor;
    } catch (error) {
      return helpers.error('any.invalid', {
        message: error instanceof Error ? error.message : 'formato invalido',
      });
    }
  })
  .messages({ 'any.invalid': '{{#message}}' })
  .description(
    '32 bytes en base64 (44 caracteres). Generala con `npm run generar:clave`. ' +
      'Sin recuperacion: si se pierde, hay que regenerar las claves de firma y ' +
      'recifrar las credenciales de las bases.',
  );

export const ESQUEMA_ENTORNO = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development')
    .description('Modo de ejecucion.'),

  PORT: Joi.number()
    .port()
    .default(3001)
    .description('Puerto HTTP del backend.'),

  DATABASE_URL: Joi.string()
    .required()
    .description('Cadena de conexion a la base de control. La lee Prisma.'),

  TQ_ISSUER: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .required()
    .custom((valor, helpers) => {
      // En produccion el issuer tiene que ser https. No es cosmetico: el `iss`
      // es lo que la app compara contra el `issuer` del discovery, y un IdP
      // servido en http hace que el navegador bloquee las respuestas con
      // credenciales y que el token viaja en claro. En desarrollo se permite
      // http, que es la unica forma de probar por localhost.
      if (process.env.NODE_ENV === 'production' && !String(valor).startsWith('https://')) {
        return helpers.error('any.invalid', {
          message:
            'en produccion TQ_ISSUER tiene que ser https (specs/01 §1). ' +
            'Un issuer en http hace que el discovery no valide y que el token viaje en claro.',
        });
      }
      return valor;
    })
    .messages({ 'any.invalid': '{{#message}}' })
    .description('Issuer de los tokens OIDC. Debe coincidir con la URL publica del IdP.'),

  TQ_PORTAL_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .allow('')
    .optional()
    .description(
      'URL base del portal (Next). La usa /oidc/authorize para mandar al login ' +
        'cuando no hay sesion central. Vacio = el authorize responde que falta ' +
        'configurar en vez de inventar un destino.',
    ),

  TQ_MASTER_KEY: masterKey,

  ACCESS_TTL_MIN: Joi.number()
    .integer()
    .min(1)
    .max(1440)
    .default(15)
    .description('Vida del access token, en minutos (specs/01 §3).'),

  RATE_LIMIT_POR_MINUTO: Joi.number()
    .integer()
    .min(1)
    .max(10_000)
    .default(10)
    .description(
      'Requests por minuto por IP y por usuario en /auth/login y /oidc/token ' +
        '(specs/01 §4). Solo se sube para pruebas de flujo completo: bajar el ' +
        'default de 10 es cambiar el spec, no el .env.',
    ),

  CORS_ORIGIN: Joi.string()
    .allow('')
    .optional()
    .description(
      'Origenes permitidos, separados por coma. Vacio = CORS deshabilitado. ' +
        'Nunca `*`: cada app declara su origen exacto en `cat_aplicacion.origenes`.',
    ),
})
  // Se permiten variables desconocidas a proposito: el proceso puede correr en
  // un entorno con variables de otros servicios, y frenar el arranque por eso
  // seria un falso positivo. El typo que de verdad importa -- el de
  // `TQ_MASTER_KEY` -- ya lo caza que sea `required()`.
  .unknown(true);

/** Entorno ya validado y con defaults aplicados. */
export interface Entorno {
  NODE_ENV: 'development' | 'production' | 'test';
  PORT: number;
  DATABASE_URL: string;
  TQ_ISSUER: string;
  TQ_PORTAL_URL?: string;
  TQ_MASTER_KEY: string;
  ACCESS_TTL_MIN: number;
  RATE_LIMIT_POR_MINUTO: number;
  CORS_ORIGIN?: string;
}

/**
 * Redaccion defensiva. Aunque el schema use reglas que no filtran, cualquier
 * regla futura que se agregue (`pattern`, `replace`, un `messages` mal copiado)
 * podria volcar un valor sensible en el mensaje. Prefiero un `SCRUBBED` feo
 * que una master key en la consola del operador.
 */
export function redactar(mensaje: string, entorno: NodeJS.ProcessEnv = process.env): string {
  let salida = mensaje;

  for (const nombre of VARIABLES_SENSIBLES) {
    const valor = entorno[nombre];
    if (valor && valor.length > 0) {
      salida = salida.split(valor).join('[REDACTADO]');
    }
  }

  // La forma literal de la regla `pattern` de Joi, por si el valor no esta en
  // el entorno que se paso (p. ej. se valido un objeto sintetico).
  return salida.replace(/with value "[^"]*"/g, 'with value [REDACTADO]');
}

/**
 * Vuelve los errores de Joi como lineas accionables, sin volcar ningun valor.
 *
 *   - TQ_MASTER_KEY: TQ_MASTER_KEY debe tener 32 bytes exactos (44 caracteres base64)...
 *
 * Acepta `unknown` a proposito: en un `catch` de TypeScript con `strict` la
 * variable es `unknown`, y obligar a castear en cada llamador solo mueve el
 * problema. Si no fuera un error de Joi, devuelve una linea generica en vez de
 * fallar.
 */
export function describirErrores(error: unknown, entorno?: NodeJS.ProcessEnv): string[] {
  if (!Joi.isError(error) || !Array.isArray(error.details)) {
    const mensaje = error instanceof Error ? error.message : String(error);
    return [`(validacion) ${redactar(mensaje, entorno)}`];
  }

  return error.details.map((detalle) => {
    const clave = detalle.path.join('.') || '(raiz)';
    return `- ${clave}: ${redactar(detalle.message, entorno)}`;
  });
}

/**
 * Valida el entorno y devuelve la version ya normalizada.
 *
 * @throws {Joi.ValidationError} si algo no cumple. Los scripts y el arranque
 * usan `describirErrores` sobre ese error para mostrarlo bien.
 */
export function validarEntorno(entorno: NodeJS.ProcessEnv = process.env): Entorno {
  const { value, error } = ESQUEMA_ENTORNO.validate(entorno, {
    abortEarly: false,
    convert: true,
    allowUnknown: true,
  });

  if (error) {
    throw error;
  }

  return value as Entorno;
}

/** Igual que `validarEntorno`, pero devuelve `null` en vez de tirar. */
export function intentarValidarEntorno(entorno?: NodeJS.ProcessEnv): Entorno | null {
  try {
    return validarEntorno(entorno);
  } catch {
    return null;
  }
}

/**
 * Lo minimo que `MasterKeyService` necesita de un `ConfigService`.
 *
 * Se declara estructuralmente y no importando la clase de `@nestjs/config`,
 * para que este modulo no dependa de Nest: los scripts `.mjs` lo cargan desde
 * `backend/dist` sin levantar la app.
 */
export interface LectorConfig {
  get<T = unknown>(clave: string): T | undefined;
  getOrThrow<T = unknown>(clave: string): T;
}

/**
 * Construye un `ConfigService` minimal sobre un entorno YA validado, para que
 * los scripts puedan instanciar servicios que esperan inyeccion sin montar
 * Nest. La validacion no se repite: si llega hasta aca, el entorno ya paso por
 * `validarEntorno`.
 */
export function configServiceDe(entorno: Entorno): LectorConfig {
  const fuente = entorno as unknown as Record<string, unknown>;
  return {
    get: <T,>(clave: string) => fuente[clave] as T | undefined,
    getOrThrow: <T,>(clave: string) => {
      const valor = fuente[clave];
      if (valor === undefined || valor === null) {
        throw new Error(`${clave} no esta definida en el entorno.`);
      }
      return valor as T;
    },
  };
}

/**
 * Rutas de `.env`, resueltas desde el archivo para que no dependan del
 * directorio de trabajo.
 *
 * **Hay una sola: la de la raíz del repo.** Se listaba también
 * `backend/.env` "por compatibilidad", y esa compatibilidad fue una trampa: el
 * cliente de Prisma carga por su cuenta los `.env` que encuentra junto a
 * `schema.prisma`, o sea ese, **antes** de que corra el `dotenv.config` de la app;
 * y como `dotenv` no pisa variables ya definidas, el archivo de la raíz perdía.
 * Con dos claves distintas, la app firmaba con la del `backend/.env` mientras el
 * canónico tenía otra, y el síntoma (los codes no se canjean) no señalaba el
 * problema. Ver `specs/00` §8.1 y la fase 02.
 *
 * `backend/src/config/` y `backend/dist/config/` están ambos a 3 niveles de la
 * raíz del repo, así que el mismo `../../..` sirve para `nest start` (src) y
 * para `node dist/main.js`.
 */
export const RUTAS_ENV = [resolve(__dirname, '..', '..', '..', '.env')];
