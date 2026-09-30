#!/usr/bin/env node
/**
 * Verificación de la rotación de claves (`specs/01` §5).
 *
 *   1. La clave activa existe, tiene la edad que corresponde y la política de 90
 *      días dice si hay que rotar.
 *   2. El JWKS publica la activa **más** las retiradas dentro de 24 h, y ninguna
 *      más vieja.
 *   3. Con `--token <access>`: el token valida, con qué `kid` se firmó, si ese
 *      `kid` sigue publicado y cuánto le queda de vida.
 *
 * ## Por qué esto NO puede contar "N tokens firmados con kids fuera del JWKS"
 *
 * El borrador de la fase 09 pedía un job que dijera cuántos tokens vivos están
 * firmados con un `kid` que ya no está en el JWKS. **No se puede contar, y la
 * razón es un invariante del repo**: los access tokens no se persisten
 * (`AGENTS.md`: ningún token en la base; el anti-replay es un caché en memoria,
 * `oidc/jti-cache.ts`). No hay tabla donde estén, así que no hay `COUNT` que
 * hacer.
 *
 * Lo que sí se puede afirmar con certeza, y es lo que este script reporta, es la
 * **cota**: un token de `ACCESS_TTL_MIN` firmado con una clave retirada hace
 * más de esa ventana ya expiró solo. Por eso cada clave retirada trae
 * `tokens_en_vuelo`, que es `0` cuando la ventana ya pasó y `?` cuando todavía
 * pueden quedar algunos.
 *
 * El `--token` existe para el caso que de verdad importa en un drill: un token
 * **real**, emitido antes de la rotación, validado contra el JWKS de después.
 *
 * Uso:  npm run verificar:rotacion
 *       npm run verificar:rotacion -- --token eyJhbGciOiJSUzI1NiIs...
 */
import { cargar, prepararEntorno } from './lib/entorno.mjs';
import { fallo, parsearFlags } from './lib/consola.mjs';

const { PrismaService } = cargar('prisma/prisma.service.js');
const { FirmaService, DIAS_ROTACION, VENTANA_JWKS_MS } = cargar('claves/firma.service.js');
const { MasterKeyService } = cargar('claves/master-key.service.js');

const USO = `
  Uso: npm run verificar:rotacion [-- --token <access token>]

    (sin flags)   Estado de las claves y del JWKS.
    --token T     Ademas valida ese access token y dice con que kid se firmo,
                  si ese kid sigue publicado y cuanto le queda de vida.
`.trim();

const flags = parsearFlags(process.argv.slice(2), ['token'], USO);

let fallos = 0;
function verificar(descripcion, condicion, extra = '') {
  if (condicion) {
    console.log(`  [ok]   ${descripcion}${extra ? ` (${extra})` : ''}`);
  } else {
    fallos += 1;
    console.log(`  [FALLA] ${descripcion}${extra ? ` (${extra})` : ''}`);
  }
}

let prismaInstancia = null;

try {
  await ejecutar();
} catch (error) {
  await prismaInstancia?.$disconnect?.().catch(() => {});
  fallo(error, 'verificar la rotación');
}

async function ejecutar() {
  const { entorno, configService } = prepararEntorno();
  const masterKey = new MasterKeyService(configService);
  const EMISOR = entorno.TQ_ISSUER;
  const vidaAccess = entorno.ACCESS_TTL_MIN;

  prismaInstancia = new PrismaService(entorno.DATABASE_URL);
  const firma = new FirmaService(prismaInstancia, masterKey);

  console.log('\n  Verificacion de la rotacion de claves\n');
  console.log('  ' + '-'.repeat(64) + '\n');

  const estado = await firma.estado(vidaAccess);
  const { keys } = await firma.jwks();

  // 1. La clave activa.
  verificar('hay exactamente una clave activa', estado.claves.filter((c) => c.activa).length === 1,
    `${estado.kid_activa}`);
  verificar('la clave activa esta publicada en el JWKS',
    keys.some((k) => k.kid === estado.kid_activa));
  if (estado.dias_activa !== null) {
    verificar(
      `la clave activa esta dentro de la politica de ${DIAS_ROTACION} dias`,
      estado.dias_activa <= DIAS_ROTACION,
      `${estado.dias_activa} dias, vence ${estado.vence_en}`,
    );
  }

  // 2. La ventana de solapamiento: las retiradas de menos de 24 h sí, las de
  //    más no. Es el criterio de `specs/01` §5 y lo que hace la rotación
  //    reversible durante 24 h.
  const ahora = Date.now();
  const viejas = estado.claves.filter(
    (c) => !c.activa && c.retirada_en && ahora - Date.parse(c.retirada_en) > VENTANA_JWKS_MS,
  );
  const viejasPublicadas = viejas.filter((c) => keys.some((k) => k.kid === c.kid));
  verificar('las retiradas de mas de 24 h NO estan en el JWKS', viejasPublicadas.length === 0,
    `${viejas.length} vieja(s), ${viejasPublicadas.length} filtrada(s)`);

  const recientes = estado.claves.filter(
    (c) => !c.activa && c.retirada_en && ahora - Date.parse(c.retirada_en) <= VENTANA_JWKS_MS,
  );
  const recientesPublicadas = recientes.filter((c) => keys.some((k) => k.kid === c.kid));
  verificar('las retiradas de menos de 24 h SI estan en el JWKS',
    recientesPublicadas.length === recientes.length,
    `${recientes.length} en ventana`);

  // 3. La cota de tokens en vuelo, y por que es una cota y no un conteo.
  console.log('\n  Tokens por clave (cota, no conteo):');
  for (const clave of estado.claves) {
    if (clave.activa) {
      console.log(`    ${clave.kid}  activa      (sin cota: firma todo lo nuevo)`);
      continue;
    }
    console.log(
      `    ${clave.kid}  retirada    en vuelo: ${clave.tokens_en_vuelo ?? '?'}` +
        (clave.tokens_en_vuelo === 0
          ? `  (la ventana de ${vidaAccess} min ya paso: todo lo que firmo expiro)`
          : `  (pueden quedar hasta ${vidaAccess} min de tokens)`),
    );
  }
  const enVuelo = estado.claves.filter((c) => c.tokens_en_vuelo === null && !c.activa).length;
  console.log(
    '    Los access tokens no se persisten (invariante de AGENTS.md), asi que este numero' +
      `\n    es una COTA por fecha, no un conteo. Claves todavia dentro de la ventana: ${enVuelo}.`,
  );

  // 4. Un token real, si lo pasaron.
  if (typeof flags.token === 'string' && flags.token.trim() !== '') {
    console.log('\n  Token pasado por --token:');
    const token = flags.token.trim();
    const [cabecera] = token.split('.');
    let kid = '(ilegible)';
    try {
      kid = JSON.parse(Buffer.from(cabecera, 'base64url').toString('utf8')).kid ?? '(ausente)';
    } catch {
      verificar('el token tiene un header legible', false);
    }

    const publicada = keys.some((k) => k.kid === kid);
    console.log(`    kid del header : ${kid}`);
    console.log(`    en el JWKS hoy : ${publicada ? 'si' : 'NO'}`);

    try {
      const payload = await firma.verificar(token, keys, {
        issuer: EMISOR,
        vidaMinutos: vidaAccess,
      });
      const expira = payload.exp ? payload.exp * 1000 : null;
      const restante = expira === null ? null : Math.max(0, Math.round((expira - Date.now()) / 1000));
      console.log(`    valida         : si`);
      console.log(`    sub            : ${payload.sub}`);
      console.log(`    aud            : ${JSON.stringify(payload.aud)}`);
      console.log(`    expira en      : ${restante !== null ? `${restante} s` : '(sin exp)'}`);
      verificar('el kid del token esta publicado en el JWKS', publicada,
        publicada ? '' : 'una app con el JWKS cacheado lo va a rechazar: hay que forzar el refresco');
    } catch (error) {
      const mensaje = error instanceof Error ? error.message : String(error);
      console.log(`    valida         : NO (${mensaje})`);
      verificar('el token valida contra el JWKS actual', false, mensaje);
    }
  }

  await prismaInstancia.$disconnect();

  console.log('\n  ' + '-'.repeat(64) + '\n');
  console.log(`  ${fallos === 0 ? 'TODO OK' : `${fallos} COMPROBACION(ES) FALLIDA(S)`}\n`);
  process.exit(fallos === 0 ? 0 : 1);
}
