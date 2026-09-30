/** @type {import('next').NextConfig} */

// La API del portal es una URL PUBLICA y va incrustada en el bundle: no hay
// runtime donde configurarla, porque el export es estatico. Si `next build`
// corre sin `NEXT_PUBLIC_API_URL`, el bundle queda con el default de
// desarrollo (`http://localhost:3001`) y el build TERMINA BIEN: un portal
// desplegado en el servidor del cliente, con el login apuntando a la
// localhost del navegador de cada usuario.
//
// El sintoma es desconcertante -- "funciona en mi maquina" y en produccion el
// login no hace nada -- y se descubre tarde. Por eso aca se corta el build en
// vez de avisar. Mismo criterio que `backend/src/config/env.schema.ts`: una
// variable faltante tiene que detectable ANTES de levantar, no despues.
//
// Nota: `process.env` se lee dentro de `next.config.js`, que corre en Node
// (no en el navegador), asi que esto si puede leer variables de entorno.
const API_URL = process.env.NEXT_PUBLIC_API_URL;

if (!API_URL) {
  if (process.env.NODE_ENV === 'development') {
    console.warn(
      '\n  [aviso] NEXT_PUBLIC_API_URL no esta definida: el portal usara ' +
        'http://localhost:3001.\n' +
        '          Copiar frontend/.env.example a frontend/.env.local.\n',
    );
  } else {
    throw new Error(
      '\n  NEXT_PUBLIC_API_URL no esta definida.\n\n' +
        '  El portal es un export estatico: la URL de la API se incrusta en el\n' +
        '  bundle durante el build y no hay forma de cambiarla despues. Sin esta\n' +
        '  variable el bundle queda apuntando a http://localhost:3001 y el login\n' +
        '  no funciona en ninguna maquina salvo en la del que lo compilo.\n\n' +
        '  Copiar frontend/.env.example a frontend/.env.local, o pasarla en el\n' +
        '  entorno del build. Tiene que ser la MISMA URL publica que TQ_ISSUER\n' +
        '  del .env de la raiz: si no coinciden, la cookie de sesion se escribe en\n' +
        '  un origen y el authorize la lee de otro.\n',
    );
  }
}

const nextConfig = {
  // El portal se sirve como estatico (se lo baja el web server del cliente o un
  // CDN). Consecuencia directa: no hay servidor de Next, y por eso NO hay
  // middleware, ni route handlers, ni `cookies()`/`headers()` de servidor.
  // Cualquier lectura de la sesion se hace desde el navegador contra `tq-api`
  // con la cookie `HttpOnly` (`specs/01` §4).
  output: 'export',

  // `true` genera `login/index.html` en vez de `login.html`. Es lo que espera un
  // servidor estatico sin reglas de rewrite, y hace que `/login` y
  // `/login/` sean el mismo archivo en cualquier hosting.
  trailingSlash: true,

  images: {
    unoptimized: true,
  },

  // El lint se corre como paso aparte (`npm run lint` en el CI y antes de
  // cerrar cada fase, ver `AGENTS.md`). Dejarlo adentro del build hace que un
  // error de eslint se vea como un fallo de compilacion.
  eslint: {
    ignoreDuringBuilds: true,
  },
};

module.exports = nextConfig;
