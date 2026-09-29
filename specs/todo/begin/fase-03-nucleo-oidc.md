# Fase 03 — Núcleo OIDC: discovery, JWKS, authorize, token, revoke, logout

**Estado:** ✅ **Completada y verificada por HTTP contra la base real**
(2026-09-29: los seis endpoints, los criterios de aceptación de abajo, y `npm run
verificar:oidc` con 165 comprobaciones. El flujo también se recorrió a mano con `curl`;
la transcripción está en *Estado de verificación*). Sin cambios de esquema: la
columna `tok_sesion.idaplicacion` que pedía la trampa 3 ya estaba en `00-crear-base.sql`.
**Depende de:** [02](fase-02-identidad-y-claves.md)
**Repo:** Tourniquet
**Requiere acción del usuario:** no
**Riesgo:** alto — es el corazón del IdP; un error acá es un error de seguridad, no un bug visible
**Reversible:** no aplica (nada desplegado todavía)
**Spec normativo:** `specs/01-tokenos-y-seguridad.md` §1, §2, §3, §9
**Mapa:** `specs/04-fases.md` Fase 01 (tercer tercio)

---

## Por qué esta fase es una unidad separada

Desde acá ya no hay "código de Tourniquet": hay un IdP del que cuelgan tokens que otras
aplicaciones van a confiar. La superficie de error es del tipo que no se ve en la UI: un
`redirect_uri` mal comparado, un `state` que no se valida, un refresh que no rota. Por eso esta
fase se cierra **enteramente por `curl`**, antes de que exista una sola pantalla (la 04), y con los
criterios de aceptación de `specs/04` Fase 01 que ya están escritos para este flujo.

La decisión de qué librería firma queda tomada acá: `jose` para RS256, JWKS y validación. Nada de
HS256 en ningún punto: si algún día alguien pone un secreto compartido, la app valida con la clave
pública y el token no valida, que es exactamente el fallo que se quiere.

---

## Objetivo

Los seis endpoints de `specs/01` §1 funcionando, verificables por `curl` de punta a punta, con
rotación de refresh, revocación por `sid` y anti-replay de `jti`.

---

## Alcance

**Entra:**

- `/.well-known/openid-configuration`
- `/.well-known/jwks.json`
- `/oidc/authorize` (GET, valida y persiste el code)
- `/oidc/token` (POST, `authorization_code` y `refresh_token`)
- `/oidc/revoke` (POST, RFC 7009)
- `/oidc/logout` (GET/POST, mata la sesión central)
- `/userinfo` (GET, sólo datos personales)
- Tablas `tok_sesion`, `tok_autorization_code`, `tok_refresh_token` en uso real.
- Caches: `jti` vistos, JWKS.

**No entra:**

- Consentimiento explícito ni pantalla: en esta fase el portal es un placeholder, la 04 lo arma.
- MFA en el login (Fase 09).
- `client_secret` / clientes confidentiales: **no** se implementa (`specs/01` §1, no diseñado).
- ROPC / implicit: **nunca** (`specs/01` §1).

---

## Tareas

### 1. Módulo `oidc/`

Controller por endpoint, service por responsabilidad:

```
src/oidc/
├── discovery.controller.ts     # /.well-known/openid-configuration
├── jwks.controller.ts          # /.well-known/jwks.json (memo 60 s, se movió acá desde claves/)
├── authorize.controller.ts / authorize.service.ts
├── token.controller.ts / token.service.ts
├── revoke.controller.ts
├── logout.controller.ts
├── userinfo.controller.ts
├── claims.ts          // construcción del access token, fuente única de la tabla de specs/01 §2
├── jti-cache.ts       // caché anti-replay
├── jwks-cache.ts      // caché 24 h + refresh forzado ante kid desconocido
├── validador.service.ts   // el validador de referencia: el que copia RHPro en la 06
├── sesion.service.ts      // tok_sesion y tok_refresh_token: alta, cierre, familia
├── aplicacion.service.ts  // cat_aplicacion: redirect exacto, origen, pertenencia al cliente
├── codigos.ts / cookies.ts / errores.ts / vidas.ts
```

### 2. Discovery

`issuer` exacto desde `TQ_ISSUER` (en producción, `https://` obligatorio: si el issuer no es https
en prod, la app no puede validar bien y el discovery devuelve un error al arrancar). Incluye los
endpoints de la §1, `response_types_supported: ["code"]`, `grant_types_supported:
["authorization_code","refresh_token"]`, `code_challenge_methods_supported: ["S256"]` y
`scopes_supported: ["openid","profile","email"]`. **No** anuncia implicit ni password.

### 3. `/oidc/authorize`

Orden de validación (el orden importa para no filtrar información):

1. `client_id` existe y está `activa` en `cat_aplicacion`.
2. `redirect_uri` **exacto**, member de `redirect_uris_json` (comparación de string completo; sin
   wildcard, sin prefijo, sin normalizar). Falla ⇒ error **sin redirect**.
3. `state` presente (se refleja, no se valida: su validación es del cliente).
4. `code_challenge` presente y `code_challenge_method=S256`. **Sin PKCE no hay code**: no hay
   excepción para clientes "de prueba".
5. El usuario tiene sesión central viva: si no, redirect al login del portal conservando los
   parámetros del authorize (returnTo).

Con sesión: crear `tok_sesion` si no había una para `(idusuario, idcliente)`, insertar
`tok_autorization_code` con `code_hash = sha256(code)`, `expira_en = +60 s`, `redirect_uri` y
`code_challenge` copiados, y redirigir con `code` y `state`.

**El code nunca se persiste en claro**: sólo su sha256. Si alguien lee la base, no puede
canjear codes.

### 4. `/oidc/token`

`grant_type=authorization_code`:

1. `code` → sha256 → buscar en `tok_autorization_code`. No existe, venció (`expira_en < now`) o ya
   tiene `usado_en` ⇒ `invalid_grant` + auditoría (`replay` si ya estaba usado).
2. Verificar `code_verifier` contra el `code_challenge` guardado: `base64url(sha256(verifier)) ==
   code_challenge`. comparison en **tiempo constante**.
3. Verificar que el `redirect_uri` del body sea **idéntico** al del code persistido.
4. Marcar `usado_en`, emitir access + refresh, `aud_login` `ok`.

`grant_type=refresh_token`:

1. sha256 del token → buscar en `tok_refresh_token`. No existe o revocado ⇒ `invalid_grant`.
2. **Rotación estricta**: si `usado_en IS NOT NULL` ⇒ el token fue reusado. Acción según
   `specs/01` §3: revocar **toda la familia** del `sid` (todos los refresh de esa sesión),
   `tok_sesion.cerrada_en` con `motivo_cierre='replay'`, y `aud_login` con `resultado='replay'`.
   Esto es lo que corta el robo de token: el atacante y la víctima pierden la sesión, y queda
   registrado.
3. Si el `sid` está cerrada (logout, expirada) ⇒ `invalid_grant` aunque el refresh sea "válido".
4. Marcar `usado_en`, crear el nuevo refresh, `reemplazado_por` = id del nuevo.
5. Access nuevo con el **mismo `sid`** (la sesión sobrevive al refresh) y `iat`/`exp` renovados.

Vida del refresh: 7 días de inactividad sliding, 30 días absolutos desde `creado_en`
(`tok_sesion.expira_en`). El slido nunca extiende `tok_sesion.expira_en`.

### 5. `/oidc/revoke`

RFC 7009: revocar un token y devolver 200 siempre (no confirma ni niega). Se acepta access
(revoca el `sid` de esa app) o refresh (revoca ese token y su familia). Es lo que la app llama
cuando el usuario cierra sesión **en la app** (`specs/01` §4): el `sid` derivado de esa app cae, la
sesión central sigue.

Distinción importante entre los dos niveles de cierre, que `specs/01` §4 define y esta fase tiene
que respectar:

| Acción | Qué muere | Qué sigue |
|---|---|---|
| `/oidc/revoke` desde la app | Refresh de esa app | Sesión central, otras apps |
| `/oidc/logout` ("salir de todo") | `sid` completo: todos sus refresh, todas sus apps | Nada; la sesión central también |

### 6. `/oidc/logout`

Modelo de sesiones: **una `tok_sesion` por app** (columna `idaplicacion`). El mismo usuario
entrando en dos apps tiene dos `sid`. Por eso "salir de todo" revoca todas las sesiones del
usuario en el cliente, no una fila.

`post_logout_redirect_uri` validado **exacto** contra el registro (mismo criterio que
`redirect_uri`; si no viene, no redirige: muestra la pantalla de despedida). Mata la sesión
(`cerrada_en`, `motivo='logout'`), revoca los refresh del `sid`, borra la cookie de sesión del
portal.

### 7. `/userinfo`

Devuelve `{ sub, usuario, nombre, apellido, email? }` y **nada más**. Sin roles, sin perfil, sin
`tenant` de otros clientes. Requiere access token válido; si el `sid` fue revocado, 401 aunque el
JWT no haya expirado todavía (el access vive 15 min, pero la revocación es inmediata: se comprueba
el `sid` contra `tok_sesion`).

### 8. Claims (`claims.ts`)

Fuente única, exactamente la tabla de `specs/01` §2, ni una columna más:

```
iss, sub, aud, tenant, [base], nombre, sid, amr, jti, iat, exp
```

- `sub` = `idusuario` (UUID v4 generado por la app), **nunca** el username ni el `iduser` de RHPro.
- `base` sale de `cat_base_datos` de la combinación activa cliente+app (`estado='activo'`), o se
  omite si hay más de una activa (que no debería haber: hay un índice único filtrado por eso).
- `amr = ["pwd"]` (o `["pwd","mfa"]` cuando exista MFA, Fase 09).
- `jti` aleatorio por token, con caché anti-replay de 2× la vida del access (30 min) en memoria.

**Un claim nuevo requiere actualizar `specs/01` §2 primero.** No hay excepción por "es Helpful".

### 9. Caches

- `jwks-cache`: 24 h, con refresh **forzado** una vez por token ante `kid` desconocido
  (`specs/01` §5). Una vez por token, no por request: si no, un atacante con kid inventado genera un
  refresh de JWKS por request (DoS).
- `jti-cache`: `Map` con purga por TTL. Volumetría estimada: logins × 2, en una instalación chica
  es de Memory. Si algún día no entra, se pasa a store externo, no se agranda el TTL.

---

## Criterios de aceptación

Todos por `curl` o script, antes de que exista frontend. Los cuatro primeros son los que
`specs/04` Fase 01 exige explícitamente.

- [x] `curl /.well-known/openid-configuration` devuelve los 6 endpoints, `code` como único
      `response_types_supported`, `S256` como único `code_challenge_methods_supported`, y
      `issuer` exactamente igual a `TQ_ISSUER`.
- [x] `curl /.well-known/jwks.json` devuelve la clave activa con `kid` = el de `tok_clave_firma`, y
      **nunca** material privado (ni `d`, ni `p`, ni `q`).
- [x] Flujo completo `authorize` → `code` → `token` → `access` + `refresh` → `userinfo` con `curl`:
      el access decodificado trae `sub`, `aud`, `tenant`, `sid`, `jti`, `amr`, `iss` correctos, y
      `userinfo` devuelve los datos personales de ese `sub`.
- [x] **Code reusado**: usar el mismo `code` dos veces ⇒ 2º `invalid_grant` + fila en
      `aud_login` con `resultado='replay'`.
- [x] **Refresh reusado**: usar un refresh ya rotado ⇒ toda la familia del `sid` revocada,
      `tok_sesion.cerrada_en` con `motivo='replay'`, y **el siguiente refresh de la familia también
      falla** (incluso uno recién emitido, porque la sesión está cerrada).
- [x] **Logout**: `/oidc/logout` mata la sesión; el siguiente refresh falla; el access ya emitido
      sigue siendo criptográficamente válido hasta su `exp` (15 min) pero `/userinfo` lo rechaza
      por `sid` muerto.
- [x] `redirect_uri` distinto al registrado (variante con un carácter más, otro subdominio, otro
      esquema, mayúscula en el host) ⇒ `invalid_request` **sin redirección**.
- [x] `/oidc/token` sin `code_verifier`, o con un `verifier` que no corresponde al challenge ⇒
      `invalid_grant`.
- [x] Token con `aud` distinto del de la app, o `tenant` distinto del esperado, es rechazado por
      el validador de referencia (el mismo que copiará RHPro en la 06).
- [x] Token con `alg=none` y token con HS256 firmado con un secreto inventado: ambos rechazados.
- [x] `jti` repetido ⇒ rechazado. Y el caché se purga a los ~30 min.
- [x] Access vencido (`exp` pasado) rechazado con tolerancia ≤ 60 s.
- [x] `/userinfo` con access de otra app (otro `sid`) ⇒ 401. **Interpretado como:** un access cuyo
      `sid` está cerrado o revocado ⇒ 401 (trampa 5). Lo que *no* puede pasar es un access sano de
      otra app: ese token lo emitió este mismo IdP y 401 lo rechazaría del lado equivocado.
- [x] `/oidc/revoke` devuelve 200 y revoca; con token inexistente **también** 200 (RFC 7009).
- [x] `tok_autorization_code.code_hash` y `tok_refresh_token.token_hash` en la base son sha256 hex,
      **nunca** el valor en claro. (Y el `state_hash` también: el `state` tampoco va en claro.)
- [x] `npm run lint` verde; `npm run build` ok.

**Cómo se verifican.** `npm run verificar:oidc` (script nuevo) corre los quince criterios por HTTP
contra el backend arriba y la base real, e imprime `ok`/`FALLA` por cada uno, más una tabla con
lo que quedó en `aud_login`. Sale con código 1 si algo falla, así que sirve de puerta. **No es un
test**: no hay suite, no hay mocks y no corre solo; es el equivalente en `fetch` de hacer los
`curl` a mano, con veredicto.

Dos cosas que el script **no** toca, por decisión: no pide ni cambia contraseñas (usa el usuario
del bootstrap, sin clave), y lo único que escribe en el catálogo es una app inactiva de prueba
que crea y borra en la misma corrida. La fila de habilitación que saca para probar el
`access_denied` la vuelve a poner en un `finally`.

---

## Estado de verificación (2026-09-29, contra SQL Server real)

`npm run verificar:oidc` → **165 comprobaciones, 0 fallas**, tres corridas seguidas idénticas
(las últimas dos, ya con el catálogo de desarrollo renombrado a `tourniquet_dev`: ver *Pendiente
para la Fase 03* de la fase 02). El mismo recorrido hecho a mano con `curl` (server con el rate
limit por defecto, 10/min):

```
### 1. authorize SIN sesión
HTTP/1.1 302 Found
Location: http://localhost:3002/login?returnTo=http%3A%2F%2Flocalhost%3A3001%2Foidc%2Fauthorize%3F...

### 2. authorize CON sesión
HTTP/1.1 302 Found
Location: http://localhost:3000/auth/callback?code=woWAD26YQHGPfWs6WZ09EqGL7bcsG4p-RO8U25VUFAY&state=abc

### 3. canje del code
payload: {"tenant":"marcelino","base":"rhpro_marcelino","nombre":"Ana Perez",
          "sid":"47670470-…","amr":["pwd"],"iss":"http://localhost:3001","aud":"rhpro",
          "sub":"03ee4317-…","iat":…,"nbf":…,"exp":…,"jti":"5b86dd88-…"}
expires_in: 900

### 4. userinfo
{"sub":"03ee4317-…","usuario":"admin","nombre":"Ana","apellido":"Perez"}

### 5. refresh (mismo sid, jti nuevo)
nuevo access sid: 47670470-175f-43a3-b1ff-2cda84cec137 | jti: 23873809

### 6. reusar el refresh viejo
{"error":"invalid_grant","error_description":"La credencial presentada no es valida, vencio o ya se uso."}

### 7. el refresh NUEVO tambien falla
{"error":"invalid_grant", …}

### 8. userinfo con el access muerto      → HTTP 401
### 9. logout                             → HTTP 200, Set-Cookie: tok_sesion_portal=; Max-Age=0; …
### 10. revoke de un token inexistente    → HTTP 200
```

**Estado de la base después del replay y el logout** (evidencia de que la familia y la
"salir de todo" hacen lo que dicen):

```
tok_sesion                                   tok_refresh_token
sid      cliente    app         motivo         id  sid      usado  reemplazado_por  revocado  motivo
dc933433 marcelino (portal)  logout          33  47670470  no     -                 si       replay
47670470 marcelino rhpro      replay          32  47670470  si     33               si       replay
44b3c1e3 marcelino (portal)  logout          31  47670470  no     -                 si       replay
```

**Rate limit** (con `RATE_LIMIT_POR_MINUTO=10`, el default de `specs/01` §4): 10 pedidos a
`/oidc/token` ⇒ 200/400, el 11º ⇒ `429 {"error":"temporarily_unavailable"}`, y quedan filas
`error`/`rate_limit` en `aud_login`. El `.env` de desarrollo quedó con `200` porque la
verificación completa hace más de diez llamadas a `/token` en un minuto.

**Auditoría de una corrida** (30 min): `ok` (canjes, logout, revocaciones), `replay` con
`code_reutilizado:3f1e4938` y `refresh_reutilizado:3edc1ed9`, y `error` con
`verificador_incorrecto`, `redirect_distinto`, `app_desconocida`, `refresh_revocado`,
`refresh_desconocido`. **Ningún code ni refresh en claro**: el `detalle` lleva los **8 primeros
hex** del sha256, no el hash entero (el hash entero ya está en `code_hash`, al lado).

**Bugs que aparecieron al verificar, y que no aparecían en la 02**

1. **`FirmaService.verificar` rechazaba todos los tokens.** Leía el `kid` del **payload**
   (`token.split('.')[1]`) cuando el `kid` viaja en el **header** (`[0]`). Como ningún claim
   `kid` existe, el `kid` era siempre `undefined` y el verificador terminaba en "kid desconocido".
   No lo detectó la 02 porque la verificación de esa fase usaba `jwtVerify` con la clave pública
   directamente, sin pasar por el método. Ahora hay un criterio que lo cubre.
2. **`auth_time` salía en el token** y no está en la tabla de `specs/01` §2. Se sacó de la firma
   (la tabla manda), y en su lugar el token lleva `nbf = iat`, que es lo que `specs/01` §5 le
   exige verificar a las apps. La tabla del §2 se actualizó antes de tocar el código.
3. **`code_hash` y `token_hash` no tenían `@unique` en `schema.prisma`.** El SQL los tiene
   (son PK única en la práctica: el canje y la renovación los buscan por hash en cada request),
   pero sin el `@unique` el compilador no dejaba usar `findUnique`. Agregado; el SQL no cambió.

---

## Decisiones de esta fase (donde el plan y lo que había que hacer no coincidían)

1. **`post_logout_redirect_uri` se valida contra `redirect_uris_json`.** RFC 9457 pide una lista
   propia; agregar la columna es un cambio de esquema y esta fase no tenía permiso para eso. La
   limitación (una app sólo vuelve del logout a un URI que ya tenía como callback) quedó escrita
   en `specs/01` §1.
2. **Los errores de authorize van por redirección cuando el `redirect_uri` ya está validado**, y en
   el request cuando todavía no. `?sin-code_challenge` responde `302 …?error=invalid_request&
   state=…`; `?redirect_uri=evil` responde `400` sin `Location`. Es la forma que pide OIDC y lo que
   hace que la trampa 1 sea de verdad: nunca se manda nada a un URI no validado.
3. **Un parámetro obligatorio que falta en `/oidc/token` es `invalid_grant`, no
   `invalid_request`.** El RFC dice "SHOULD `invalid_request`", pero el criterio de aceptación de
   esta fase pide `invalid_grant` para el canje sin `code_verifier`, y además tiene más sentido:
   `invalid_request` le diría al cliente "te falta un campo" (y lo distingue de "tu code está
   mal"), cuando para el que integra es lo mismo.
4. **El `scope` se valida y se devuelve, pero no se persiste** (`tok_autorization_code` no tiene
   columna y no se agregó). `/userinfo` devuelve siempre los mismos datos personales. Queda
   anotado en `specs/01` §2.1 para que nadie lo tome por omisión cuando quiera `email` opcional.
5. **La comprobación de `jti` repetido vive en el validador, no en `/userinfo`.** En un endpoint
   de recurso el mismo access token se presenta muchas veces por diseño (cada navegación, cada
   pantalla, en paralelo): si el `jti` se consumiera en la primera llamada, la segunda daría 401 y
   **ninguna** app podría refrescar su perfil. El modelo bearer no permite distinguir "reuso
   legítimo" de "atacante con el token robado" en un endpoint de recurso. El control de un solo
   uso real (code y refresh) está en `usado_en` y en la revocación de familia, que es donde sí se
   distingue el robo. `validador.consumirJti: true` queda disponible para el que tenga un evento de
   un solo uso en la mano, y el criterio se verifica por ahí.
6. **`/oidc/authorize` exige `idn_usuario_cliente_aplicacion`** (habilitación por app), no sólo la
   membresía al cliente. Sin eso, la tabla no la respeta nadie hasta la Fase 08 y la Fase 03
   acepta tokens de apps que el usuario no tiene. `bootstrap-admin.mjs` ahora crea esas filas
   (idempotente: la 2ª corrida creó 0).
7. **El JWKS del lado IdP memoiza 60 s, no 24 h.** Los 24 h son de la **app** (`specs/01` §5), que
   no tiene otra fuente. El emisor tiene la tabla: seguir firmando 24 h con una clave que el
   administrador acaba de rotar por compromise no es una rotación. `Cache-Control: max-age=300`.
8. **Dos variables de entorno nuevas**: `TQ_PORTAL_URL` (a dónde manda el authorize cuando no hay
   sesión; vacía ⇒ `portal_no_configurado` en vez de inventar un destino) y
   `RATE_LIMIT_POR_MINUTO` (el 10 de `specs/01` §4 es el default; se sube para pruebas de flujo).
9. **CORS sigue por `CORS_ORIGIN`, no por `cat_aplicacion.origenes_json`.** La trampa 6 pide que no
   se responda `*` y eso ya está; leer el origen del catálogo es un middleware que no estaba en la
   lista de tareas y lo deja la Fase 04/07, cuando el portal esté en otro origen. Verificado: un
   `Origin` no declarado no recibe permiso de CORS, y nunca hay `*`.
10. **El canje marca `usado_en` con un `UPDATE ... WHERE usado_en IS NULL`**, no con un
    `SELECT` seguido de un `UPDATE`. Dos requests con el mismo code en el mismo instante pasan los
    dos la lectura; con el `UPDATE` condicional sólo uno gana el canje y el otro ve `invalid_grant`
    y queda auditado como `replay`. Lo mismo en la rotación del refresh (donde el perdedor además
    dispara la revocación de familia).
11. **`code_reutilizado` no revoca la familia**, a diferencia de `refresh_reutilizado`. Un doble
    clic o un reintento de red de la app legítima se ven igual que un robo, y castigar al usuario
    por eso lo deja sin apps hasta que vuelva a loguearse. La familia se cae solo en el reuso de
    refresh, que sí es la señal de robo. Queda escrito en `specs/01` §9.

---

## Qué hereda la Fase 04 (el contrato que hay que respetar)

- **Cookie de sesión del portal:** `tok_sesion_portal`, con el `sid` de la fila de `tok_sesion`
  con `idaplicacion IS NULL`. La escribe y la borra `cookies.ts`; `POST /auth/login` la pone
  (8 h, `HttpOnly`, `SameSite=Lax`, `Secure` si el issuer es https) y `sesionDePortal()` ya crea
  la fila con la vida correcta, así que el login no tiene que inventarse ninguna regla.
- **Sin sesión, `/oidc/authorize` responde 302 a
  `${TQ_PORTAL_URL}/login?returnTo=<URL completa del authorize, encodeURIComponent>`.** El
  `returnTo` se valida en el **backend** del portal (path relativo que empiece por
  `/oidc/authorize`), nunca en el front: comparar por prefijo en el navegador es un open redirect.
- **Códigos de error del authorize** (los que el portal puede querer mostrar):
  `invalid_request`, `unauthorized_client`, `access_denied` (usuario sin habilitación para la
  app), `unsupported_response_type`, `invalid_scope`, `login_required` y `portal_no_configurado`
  (este último sale como 400 en el request, no como redirección).
- **`/oidc/logout` es "salir de todo"**: cierra la sesión del portal y **todas** las de las apps
  del cliente. El "salir del portal nomás" (cerrar sólo la fila del portal, sin tocar las apps) no
  existe todavía: si el login de la 04 lo necesita, es un endpoint aparte, no una bandera de este.
- **El validador de referencia ya está escrito** (`oidc/validador.service.ts` +
  `jwks-cache.ts`), con la fuente del JWKS inyectada. En la 06 se copia tal cual y se le pasa la
  fuente por HTTP en vez de por base.

---

## Seguridad

| Invariante | Aplicación en esta fase |
|---|---|
| `tenant`/`aud`/`sub` salen de la **base** y del token validado, nunca de un parámetro del cliente | El authorize toma `client_id` del query pero **todos** los claims se resuelven desde `cat_*` / `idn_*` / `tok_*` / `aud_*` de ese cliente. `tenant` no se acepta por query: es el `idcliente` de la sesión del portal, y el `sub` es `idn_usuario.idusuario` de esa sesión |
| PKCE S256 obligatorio | Sin `code_challenge` no hay code. `plain` se rechaza con el mismo `invalid_request`. Sin excepción para "cliente interno" |
| Redirect URI exacto | Sin wildcard, sin prefijo, comparación de string completo, y **revalidado** en `/oidc/token` contra el que quedó persistido en el code |
| Refresh de un solo uso | Rotación estricta con `UPDATE` condicional + revocación de familia (y de la sesión) ante reuso |
| `state` | Se refleja sin validar (es del cliente); el cliente valida. Documentado para que nadie lo entienda al revés |
| Anti-replay | `jti` con caché de 2× vida del access, en el validador. La de verdad está en `usado_en` de code y refresh, con revocación de familia |
| Nada de secreto compartido | Sólo RS256; no hay `client_secret` en el código ni en el `.env.example` |
| No loguear tokens | Los `code` y refresh se loguean **hasheados** (primeros 8 hex), nunca completos. Igual en el `detalle` de `aud_login`, que lleva 8 hex y no el sha256 entero |

## Trampas

1. **El `redirect_uri` se persiste en `tok_autorization_code` y se revalida en `/token`.** No
   alcanza con validarlo en el authorize: el code puede canjearse en otra request, con otro
   `redirect_uri`.
2. **Comparar `code_verifier` con `!==` sobre strings.** Es comparación de secretos: usar
   `crypto.timingSafeEqual` sobre buffers de igual largo.
3. **`tok_sesion` necesita `idaplicacion`**: sin esa columna, "salir de todo" no sabe qué sesiones
   cerrar y la lista de sesiones del portal (Fase 07) no puede distinguir "sesión en RHPro" de
   "sesión en otra app". Es un `02-sesion-aplicacion.sql` incremental, y `specs/02` §3 se actualiza
   **antes** de escribirlo.
   **Resuelto sin incremental:** la Fase 01 la metió en `00-crear-base.sql` desde el principio
   (`idaplicacion nvarchar(40) NULL`, NULL = sesión del portal) y `specs/02` §3 ahora la documenta.
   No hizo falta ningún `NN-*.sql`.
4. **`tok_autorization_code` expira a 60 s**: si el portal tarda más de un minuto entre emitir el
   code y que la app canjee, el canje falla. Con login por código es instantáneo; con MFA (Fase 09)
   hay que medir. Si molesta, se **cambia el spec** (60 s → 120 s), no se mete un sleep.
5. **`/userinfo` y el access vencido**: un access con `exp` válido pero `sid` revocado tiene que
   dar 401. Si sólo se valida el JWT, la revocación no sirve y `specs/01` §9 miente.
6. **CORS**: el portal y cada app declaran su origen exacto (`cat_aplicacion.origenes_json`). El
   backend de `tq-api` no responde `Access-Control-Allow-Origin: *` a nada, y menos a `/oidc/token`.
   Hoy el que resuelve es `CORS_ORIGIN` (origenes exactos, lista vacía = CORS deshabilitado);
   leer la lista del catálogo es middleware propio y queda para la Fase 04/07.
7. **El `tenant` no sale de un parámetro.** El authorize recibe `client_id` por query, pero el
   `tenant` del token es el `idcliente` de la **sesión del portal**: la cookie `tok_sesion_portal`
   con el `sid` de la fila `idaplicacion IS NULL`. Un request no puede nombrar a otro cliente, y
   tampoco aunque agregue `?tenant=` al authorize: el parámetro no existe.
8. **Un `redirect_uri` puede traer query propia** (`?tab=inicio`). Armar el 302 concatenando `?` a
   mano rompe; el `code` va con `URL` + `searchParams`.
9. **La cookie de sesión se borra con los mismos atributos con los que se escribió** (`Path`,
   `SameSite`). Si difieren, el navegador guarda la nueva cookie como si fuera otra y la vieja
   sigue mandándose: el logout "funciona" y el usuario sigue logueado.
10. **`aud_login` es de eventos de acceso, no de trazas.** `/userinfo` no se audita por llamada:
    llenaría la tabla de ruido y la volvería inutilizable para lo que importa (replay,
    credenciales malas, accesos denegados).
