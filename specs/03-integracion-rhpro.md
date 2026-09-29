# 03 — Integración de RHPro (y de cualquier app futura) con Tourniquet

RHPro es el primer relying party. El capítulo 1-4 describe RHPro; el 5 es la guía genérica para
las próximas apps de la casa.

## 1. Estado actual del login RHPro (punto de partida)

- Hoy el login es un **placeholder**: `backend/src/auth/auth.service.ts` valida contra
  `AUTH_USERNAME`/`AUTH_PASSWORD` del `.env` y firma un JWT HS256 con `JWT_SECRET` de una sola
  clave. `user_per` existe en la base y tiene CRUD (`seguridad/usuarios`), pero **no participa**
  en el login.
- Paso previo obligatorio en el roadmap de RHPro (**Fase 00**, ver `specs/04`): login real contra
  `user_per` de la base activa (hash + política local), manteniendo el mismo formato de sesión
  (`UserSession`: `usuario`, `nombre`, `perfil`, `base`). El modo local queda como **fallback**
  del modo dual (§2) y cumple D5 de `specs/00`.

## 2. Guard dual en `backend/src/auth`

El `JwtAuthGuard` valida el bearer en este orden, con env `AUTH_MODO` (`local | idp | dual`):

1. `AUTH_MODO=local` → sólo token propio RHPro (comportamiento Fase 00).
2. `AUTH_MODO=idp` → sólo token Tourniquet (instalaciones con portal obligatorio).
3. `AUTH_MODO=dual` → intenta token Tourniquet; si el header/issuer no corresponde, token local.

Para un token de Tourniquet se exige: `iss == TQ_ISSUER`, `alg == RS256`, `kid` resuelto en
JWKS (cache 24 h, refresh forzado ante `kid` desconocido), `exp/nbf` con tolerancia ≤ 60 s,
`aud == TQ_AUDIENCE` (p. ej. `rhpro`), `tenant == TQ_TENANT` de la instalación. Cualquier
desvío ⇒ 401 con detalle genérico (no se informa qué claim falló al cliente final; sí al log).

El guard **nunca** lee permisos del token: arma la sesión como hoy (perfil/perfiles resueltos
contra `user_per`/`perf_usr` de la base activa, ver `seguridad/menu/menu.service.ts`) — D2 de
`specs/00`.

## 3. Mapeo `sub → user_per`

- Columna nueva en la base de negocio: `user_per.idp_sub uniqueidentifier NULL` (única filtrada).
  Es DDL sobre bases RHPro: se prepara en `deploy/sql/` del repo RHPro (variante SQL Server +
  `.mysql.sql`, con la política de ese repo), ejecuta contra `rhpro_marcelino` con permiso y se
  replica en la base de Chile cuando exista.
- Alta de usuario central (`idn_usuario`) y de operador (`user_per`) quedan **vinculadas por
  `idp_sub`**, no por nombre: un login puede cambiar de nombre y el sub no.
- Resolución en un request de Tourniquet: `sub` → `user_per WHERE idp_sub = @sub`; si no hay
  fila ⇒ 401 "usuario no habilitado en este sistema" (la existencia en el IdP **no** habilita
  la app: hay que darlo de alta como operador, igual que hoy).
- Auto-provisioning (crear el `user_per` desde el portal con perfil por defecto) queda fuera de
  alcance (`specs/00` §7) hasta que un contrato lo pida.

## 4. Flujo portal → RHPro

```
Usuario ──▶ Portal Tourniquet (login único, elige cliente y app)
        ──▶ /oidc/authorize?client_id=rhpro&redirect_uri=https://rhpro.<cliente>/auth/callback
             &state=..&code_challenge=..&scope=openid profile
        ──▶ callback RHPro (frontend Next): POST /auth/exchange { code, verifier }
        ──▶ tq-api devuelve access+refresh (aud=rhpro); RHPro backend reenvía su cookie de
             sesión propia (cookie.util.ts) y el refresh queda HttpOnly en el dominio RHPro
        ──▶ refresh silencioso del lado RHPro; logout → /oidc/revoke + cerrar cookie local
```

Detalles:

- `redirect_uri` y `origenes_json` se registran exactos en `cat_aplicacion` (sin wildcard) —
  requisito de `specs/01` §9.
- El front RHPro conserva la forma actual (`auth-context.tsx` consume la respuesta de login,
  claims decorativos como `base` salen ahora de `cat_base_datos.codigo` registrado, validado en
  el backend).
- El batch/`tickets`/cualquier consumer interno de RHPro usa el mismo guard dual: no hay
  segundo mecanismo.
- Renovación del JWKS por admin: endpoint `POST /auth/rotate-jwks` (rompe cache) pensado para
  el día de rotación de claves (procedimiento `specs/01` §5).

## 5. Alta de una app nueva (guía genérica)

1. **SQL** (deploy del cliente / `tourniquet_dev`): `INSERT cat_aplicacion` (código, redirect
   URIs, orígenes CORS) + `cat_cliente_aplicacion` por cada tenant que la usa + las filas
   `cat_base_datos` que correspondan como inventario.
2. **App**: frontend con el intercambio PKCE (helper estándar `oauth4webapi` o `openid-client`
   en el backend Nest que hace de *confidential-lite* si la app no quiere token en el browser);
   backend Nest copia el patrón del guard dual de RHPro con su `TQ_AUDIENCE`.
3. **Registro de accesos**: el `admin_identidad` del tenant habilita usuarios en
   `idn_usuario_cliente_aplicacion` desde el portal (Fase 03) o por SQL (Fase 01-02).
4. Nada de la app se toca en el código de Tourniquet: el registro **es** la integración (D1).

## 6. Relación con la variante Chile

- Chile es otra instalación de RHPro (`aud`/`codigo` propio sugerido: `rhpro-chile`, o el mismo
  `rhpro` con claim `base` distinto — decisión por contrato del cliente, se registra y listo).
- El mismo build sirve; `.env` chileno: `DATABASE_URL` a su base, `FEATURES=chile`,
  `AUTH_MODO=idp`, `TQ_TENANT`/`TQ_AUDIENCE` propios.
- Las pantallas extra de Chile nunca se protegen por token: se protegen por `menuCodigo` +
  `menumstr.menuaccess` de su base (plan de migración RHPro), como el resto.
