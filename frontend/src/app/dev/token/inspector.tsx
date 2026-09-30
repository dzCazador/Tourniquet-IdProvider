'use client';

import { useState, type FormEvent } from 'react';
import { Boton } from '@/design/components/Boton';
import { Campo } from '@/design/components/Campo';
import { Costura } from '@/design/ornaments/Costura';

/**
 * `/dev/token`: el inspector del access token.
 *
 * Reemplaza al test automatizado que `AGENTS.md` prohibe, y es la razon por la
 * que la Fase 04 lo pide: es una herramienta de **inspeccion manual**, y el
 * unico modo de verificar un token que no esta automatizado es mirarlo.
 *
 * De donde sale el token: el portal **no tiene ninguno**. El access vive en la
 * memoria de la app y su refresh en una cookie `HttpOnly` del dominio de la app
 * (`specs/01` §4), asi que el portal no puede leerlo ni por accident. Por eso
 * el token se **pega**: el operador lo saca del devtools de la app que lo
 * recibio, lo pega aca, y ve el payload. Es la unica forma honesta de hacerlo
 * sin inventar un endpoint de debug que devuelva tokens.
 *
 * Lo que NO hace, y es lo importante:
 *   - No **verifica** la firma. Verificar es trabajo de `ValidadorService`
 *     (backend) y de la app; aca solo se lee lo que ya se sabe que es un JWT.
 *     Decir "verificado" aca seria mentir.
 *   - No **guarda** nada. El texto vive en el estado del componente y se pierde
 *     al recargar. Ni `localStorage`, ni `sessionStorage`, ni query string: si
 *     el token fuera a la URL quedaria en el historial y en el `Referer` de la
 *     pagina siguiente.
 *   - No imprime **el token completo ni la firma**. Solo el payload. Un access
 *     en pantalla es una invitacion a copiarlo, y alguien con un escritorio con
 *     pantalla compartida lo copia (trampa 5 de `fase-04`).
 */

type Parte = { clave: string; valor: string; destacado: boolean };

/** Claims que se destacan. Son los que `specs/01` §2 define. */
const DESTACADOS = new Set(['sub', 'aud', 'tenant', 'sid', 'amr', 'iss', 'exp', 'iat', 'nbf', 'jti', 'base']);

/**
 * Decodifica el **payload** de un JWT. No valida nada: `atob` con la
 * sustitucion base64url y `JSON.parse`. Si algo falla, se devuelve `null` y la
 * pagina dice que no lo puede leer, que es distinto de "el token es invalido"
 * y no hay que mentir sobre la diferencia.
 */
function decodificarPayload(token: string): Record<string, unknown> | null {
  const partes = token.trim().split('.');
  if (partes.length !== 3 || !partes[1]) {
    return null;
  }

  try {
    const base64 = partes[1].replace(/-/g, '+').replace(/_/g, '/');
    const relleno = base64.length % 4 === 0 ? '' : '='.repeat(4 - (base64.length % 4));
    const json = decodeURIComponent(
      atob(base64 + relleno)
        .split('')
        .map((caracter) => `%${caracter.charCodeAt(0).toString(16).padStart(2, '0')}`)
        .join(''),
    );
    const objeto: unknown = JSON.parse(json);
    return typeof objeto === 'object' && objeto !== null ? (objeto as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function partes(payload: Record<string, unknown>): Parte[] {
  return Object.entries(payload)
    .sort(([a], [b]) => {
      // Los destacados arriba y en el orden de `specs/01` §2, que es el orden
      // en que uno lee un token mirando si el `aud` es el que deberia.
      const fa = DESTACADOS.has(a) ? 0 : 1;
      const fb = DESTACADOS.has(b) ? 0 : 1;
      return fa - fb || a.localeCompare(b);
    })
    .map(([clave, valor]) => ({
      clave,
      valor: typeof valor === 'string' ? valor : JSON.stringify(valor),
      destacado: DESTACADOS.has(clave),
    }));
}

/** Epoch a ISO local. Solo para leer; el token no se modifica. */
function instante(valor: string): string {
  const epoch = Number(valor);
  if (!Number.isFinite(epoch) || epoch <= 0) {
    return '';
  }
  const fecha = new Date(epoch * 1000);
  if (Number.isNaN(fecha.getTime())) {
    return '';
  }
  return `${fecha.toLocaleString()} (${epoch})`;
}

export function InspectorToken() {
  const [entrada, setEntrada] = useState('');
  const [payload, setPayload] = useState<Record<string, unknown> | null>(null);
  const [fallo, setFallo] = useState<string>('');

  function inspeccionar(evento: FormEvent<HTMLFormElement>): void {
    evento.preventDefault();
    const decodificado = decodificarPayload(entrada);
    if (!decodificado) {
      setPayload(null);
      setFallo('No se pudo leer el payload. Revisa que sea el token completo y que no tenga espacios.');
      return;
    }
    setFallo('');
    setPayload(decodificado);
  }

  const filas = payload ? partes(payload) : [];

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-12">
      <h1 className="font-titulo text-2xl text-hueso">Inspector de token</h1>
      <Costura className="my-6" />

      <p className="font-interfaz text-chico text-plata">
        Pega un access token para ver su payload. Solo se muestra el contenido del token: ni la
        firma ni el token completo, y no se guarda nada. La firma no se verifica aca.
      </p>

      <form onSubmit={inspeccionar} className="mt-6">
        <Campo
          etiqueta="Access token"
          name="token"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={entrada}
          onChange={(evento) => setEntrada(evento.target.value)}
          className="font-codigo"
          campoClassName="font-codigo text-menor"
        />
        <div className="mt-4 flex gap-3">
          <Boton type="submit" disabled={entrada.trim().length === 0}>
            Decodificar
          </Boton>
          {payload ? (
            <Boton
              type="button"
              variante="secondary"
              onClick={() => {
                setEntrada('');
                setPayload(null);
                setFallo('');
              }}
            >
              Limpiar
            </Boton>
          ) : null}
        </div>
      </form>

      {fallo ? (
        <p role="alert" className="mt-4 font-interfaz text-menor text-sangre">
          {fallo}
        </p>
      ) : null}

      {payload ? (
        <section className="mt-8" aria-label="Payload del token">
          <h2 className="font-titulo text-lg text-hueso">Payload</h2>
          <Costura className="my-4" />

          <dl className="overflow-x-auto rounded-campo border border-hierro bg-tinta-alta">
            {filas.map(({ clave, valor, destacado }) => (
              <div
                key={clave}
                className="grid grid-cols-1 gap-1 border-b border-hierro px-4 py-3 last:border-b-0 sm:grid-cols-[10rem_1fr] sm:gap-4"
              >
                <dt className={`font-codigo text-menor ${destacado ? 'text-brasa' : 'text-plata'}`}>
                  {clave}
                </dt>
                <dd
                  className={`break-all font-codigo text-menor ${destacado ? 'text-hueso' : 'text-plata'}`}
                >
                  {valor}
                  {/* `exp`/`iat`/`nbf` son epoch: la fecha al lado es lo que
                      hace util la fila, porque un numero crudo no dice si el
                      token ya vencio. */}
                  {clave === 'exp' || clave === 'iat' || clave === 'nbf' ? (
                    <span className="ml-2 text-plata">{instante(valor)}</span>
                  ) : null}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}
    </main>
  );
}
