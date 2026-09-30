# 01 — Tokens, flujos OIDC y seguridad

Normativo. Los valores numéricos (vidas, params, umbrales) son decisión de diseño: cambiar uno
implica cambiar este spec y el `.env.example`, no sólo el código.

## 1. Endpoints (perfil OIDC mínimo)

| Endpoint | Método | Descripción |
|---|---|---|
| `/.well-known/openid-configuration` | GET | Discovery. `issuer` canónico con `https://` en producción |
| `/.well-known/jwks.json` | GET | Claves públicas RS256 activas + últimas 2 retiradas (ventana de solapamiento) |
| `/oidc/authorize` | GET | Pantalla de login/consentimiento (el portal); valida `client_id`, `redirect_uri` **exacto**, `state`, `code_challenge` (S256 obligatorio) |
| `/oidc/consentir` | POST | Aceptación del consentimiento: revalida el pedido completo y **recién ahí** emite el `code` (§1.1) |
| `/oidc/consentimiento` | GET | Datos para pintar la pantalla de consentimiento: nombre de la app, cliente y base. Sesión central obligatoria |
| `/oidc/token` | POST | Intercambio `authorization_code` → tokens; y `refresh_token` → access nuevo (rotación) |
| `/oidc/revoke` | POST | Revoca un token (RFC 7009) |
| `/oidc/logout` | GET/POST | `post_logout_redirect_uri` del registro de la app; mata la sesión central (`sid`) |
| `/userinfo` | GET | `{ sub, usuario, nombre, apellido, email? }` — datos personales, **sin** claims de autorización |

Tipos de cliente soportados: **public con PKCE** (todas las apps Next; `client_secret` no existe
en este modo) y **confidential** sólo si una app backend necesita login de servidor a servidor
(Fase 04; no diseñado).

**No se implementa** implicit flow ni ROPC (password grant). Nunca se emite token con la
contraseña en un POST de API ajena al login del portal.

`post_logout_redirect_uri` se valida **exacto** contra `cat_aplicacion.redirect_uris_json`, la
misma lista del `redirect_uri`. RFC 9457 pide una lista propia; agregar `post_logout_redirect_
uris_json` es un cambio de esquema, y hasta que exista la limitación es que una app sólo puede
volver del logout a un URI que ya tenía registrado como callback.

### 1.1 El authorize no emite el `code`: pide consentimiento primero

Con sesión central viva, `GET /oidc/authorize` **valida el pedido entero y no emite nada**: responde
**302** a `<TQ_PORTAL_URL>/consentimiento` con los mismos parámetros. El `code` se emite recién
cuando el portal hace `POST /oidc/consentir` con ese mismo pedido.

Por qué el consentimiento es del IdP y no del lanzador: el lanzador es una pantalla, se puede
saltar entrando por la app. Si el IdP no fuera el que exige la aceptación, "el usuario aceptó
entrar a RHPro" sería una fila de auditoría escrita por un portal al que se puede llegar sin
aceptar nada, y el control real (que es la habilitación en `idn_usuario_cliente_aplicacion`)
quedaría separado de la pantalla que lo explica.

Por qué el `code` se emite tarde y no en el authorize: un modal de consentimiento sobre la misma
pantalla del authorize se rompe con un F5 —el `code` ya se consumió— y deja al usuario en un estado
raro. Con el consentimiento en su propia ruta, el pedido se puede repetir, cancelar y volver a
intentar, y el `code` no existe hasta que hubo una respuesta.

**Lo que el portal puede alterar del pedido entre el authorize y el `consentir` es todo, y no
importa**: `POST /oidc/consentir` revalida `client_id` (activa), `redirect_uri` (**exacto**),
`code_challenge` (formato S256), `scope`, la sesión central y la habilitación del usuario, en el
mismo orden que el authorize. Lo único que no se puede reconstruir es el `code_verifier`, que vive
en el navegador de la app: si el portal cambiara el `code_challenge`, el canje de la app falla por
PKCE. El `code_challenge` es un hash público por definición, no un secreto que haya que proteger.

La aceptación se audita en `aud_login` (`detalle = consentimiento_aceptado`) con el `idaplicacion`
de la app. Cancelar no deja rastro en `tok_sesion` ni emite nada: no hay sesión de la app que
matar.

### 1.2 El `code_verifier` es de la app, y por eso el lanzador abre la app

En PKCE el `code_challenge` lo crea **el cliente que va a canjear el `code`**, y el `code` vuelve
al `redirect_uri` de ese mismo cliente (`specs/01` §1). De ahí sale, sin ninguna opción de diseño
de por medio: **el deep-link del lanzador abre la app, y la app inicia su propio flujo** (su
`state`, su challenge, su callback, su canje). El portal no puede canjear por la app —no tiene el
verifier— ni pasarle el verifier —sería mandarle el secreto del canje en la barra de direcciones,
donde queda en el historial y en el `Referer`—.

Por eso la URL de arranque de la app es un dato **registrado** (`cat_aplicacion.url_inicio`,
`specs/02` §3) y no uno derivado del `redirect_uri`: el lanzador abre lo que la app declaró, y si
una app se mueve, se cambia el registro y no el portal.

## 2. Modelo de claims

Access token (JWT firmado RS256, `kid` en header):

| Claim | Ejemplo | Origen | Notas |
|---|---|---|---|
| `iss` | `https://auth.cliente.com` | config | Fijo por instalación |
| `sub` | `9f2c…uuid` | `idn_usuario.idusuario` | UUID v4, **nunca** el username ni el `iduser` de RHPro |
| `aud` | `rhpro` | `cat_aplicacion.codigo` | Una app por token. El backend de la app **debe** rechazar tokens con `aud` distinta |
| `tenant` | `cervi` | `cat_cliente.codigo` | Escopado de datos y validación de instalación (D3 en `specs/00`) |
| `base` | `rhpro_cervi` | `cat_base_datos.base` | Opcional; identifica la base destino de esta instalación. **El nombre de la base**, no el `codigo` del inventario (`ARG_RHPro_Cervi`): lo que la app necesita saber es a qué base habla. Se omite si no hay exactamente una base activa para cliente+app |
| `nombre` | `Cristian Della` | `idn_usuario` | `nombre` + `apellido`. Para UI y auditoría; no es autorización |
| `sid` | `a1b9…` | `tok_sesion.id` | Sesión **de la app** (la fila con `idaplicacion` = `aud`). Ver §2.1 |
| `amr` | `["pwd"]` | `tok_sesion.amr` | `["pwd","mfa"]` cuando exista MFA |
| `jti` | `7c3e…` | emisión | Anti-replay; se rechazan `jti` vistos (caché 2× vida del access) |
| `iat`/`nbf`/`exp` | epoch | emisión | `nbf = iat`. Ver §3 |

### 2.1 El `sid` es por aplicación, no central

**Hay dos filas en `tok_sesion` cuando el usuario entra desde el portal:** la del portal
(`idaplicacion IS NULL`, creada en el login, cookie `tok_sesion_portal`) y la de cada app a la que
entra (`idaplicacion = <aud>`). El `sid` que viaja en el token es **siempre** el de la app:

- El `aud` del token es una app, y el cierre de sesión que la app puede hacer (`/oidc/revoke`)
  tiene que morir en **esa** app sin tocar la sesión central ni las demás: con un `sid` único
  central no se podría expresar (cerrar la sesión central cerraría todas las apps, que es otra
  operación, la de "salir de todo").
- El mismo usuario entrando en dos apps tiene dos `sid`, y por eso "salir de todo" revoca **todas
  las filas de sesión** del usuario en el cliente, no una.
- El `tenant` del token es el `idcliente` de la sesión del portal de la que se derivó. **No** se
  acepta por query ni por header: lo deduce el servidor de la sesión (invariante de `AGENTS.md`).

**No se emite `id_token`.** El perfil es "discovery + code + PKCE + `/userinfo`": la app usa el
`access_token` contra `/userinfo` para los datos personales. Agregar `id_token` después es un
claim nuevo y requiere actualizar esta tabla primero.

**Sin columna para el `scope` concedido.** `tok_autorization_code` no lo guarda: el scope se
valida contra la lista soportada y se devuelve en la respuesta del token, pero `/userinfo` devuelve
siempre los mismos datos personales. Honrar el scope por endpoint (p. ej. `email` opcional) exige
una columna y su `NN-*.sql`; queda anotado acá para que no se tome por omisión.

Refresh token: **opaco** (no JWT), `tok_refresh_token`, guardado hasheado (sha256), atado a
`sid`, de un solo uso (rotación).

El token **no** lleva roles, perfiles ni permisos de negocio (D2). Si una app necesita saber
"qué puede hacer", lo resuelve contra su base como hace hoy RHPro con `menumstr`.

## 3. Vidas de tokens

| Token | Vida | Renovable | Notas |
|---|---|---|---|
| Access | **15 min** | vía refresh | El único que viaja en `Authorization: Bearer` |
| Refresh | **7 días de inactividad / 30 días absolutos** desde `tok_sesion` | con rotación estricta | Uso antiguo del rotateado ⇒ revoke de toda la sesión + `login_audit` tipo `replay` |
| Authorization code | **60 s**, un solo uso | no | Ligado a `code_challenge` |
| Sesión central (portal) | **8 h** o logout | no | La vida absoluta de refresh no la extiende |

Estos valores son **decisiones de diseño**, no defaults de una librería. Viven como constantes en
constantes en `backend/src/oidc/` (con el § de este spec en el comentario) y sólo dos son
ajustables por entorno sin tocar código: la vida del access (`ACCESS_TTL_MIN`) y el rate limit
(`RATE_LIMIT_POR_MINUTO`). Cambiar cualquiera de los otros es cambiar **este spec y el código**, no
sólo el `.env`.

## 4. Identidad, contraseñas y sesiones

- `idn_usuario.clave_hash`: **argon2id** `m=64MB, t=3, p=4`, salt 16 B aleatorio, parametrizado
  en la librería; sin migración en T = se crea con hash fuerte desde la Fase 01.
- Política mínima: 10 caracteres, sin diccionario común, sin fecha del tenant. La complejidad
  por cliente se agrega cuando un contrato la pida, vía columna `cat_cliente.política` (Fase 04).
- Bloqueo: 5 intentos fallidos seguidos ⇒ 15 min de bloqueo + evento `login_audit`. El contador
  es por usuario, no por IP.
- Rate limit del login y `/oidc/token`: 10 req/min por IP + 10/min por usuario (el peor gana).
- Cookies del portal: `HttpOnly`, `Secure`, `SameSite=Lax`. El access token de una app vive en
  memoria del front + refresh en cookie `HttpOnly` **del dominio de la app** (no del IdP).
- **Cookie de sesión del portal: `tok_sesion_portal`**, con el `sid` de la fila de sesión del portal
  (`tok_sesion` con `idaplicacion IS NULL`) como valor, vida 8 h. Va el **id de sesión**, no un
  token: el portal no necesita access token para estar logueado, sólo para pedir un code.
  `SameSite=Lax` es un requisito del flujo, no un detalle de estilo: el authorize entra por un 302
  desde la app, y con `Strict` la cookie no viajaría y el usuario rebotaría en loop.
- `/oidc/authorize` **sin** cookie de sesión no falla: redirige al login del portal con un
  `returnTo` validado en el backend (path relativo que empiece por `/oidc/authorize`).
- Logout: el portal ofrece dos niveles — *"cerrar esta app"* (revoca sólo el `sid`-derivado de
  esa app, la sesión central sigue) y *"salir de todo"* (`/oidc/logout`, revoca sesión y todos
  los refresh). El front de la app llama `/oidc/revoke` al cerrar sesión.
- CORS: el portal y cada app declaran su `origin` exacto en `cat_aplicacion.origenes` (JSON
  array de orígenes); nunca `*`.

## 5. Claves de firma (RS256) y JWKS

- Par: RSA 2048 mínimo (2048 por defecto en este setup; migrar a 3072 sólo con decisión
  documentada acá). `kid` = hash corto de la clave pública.
- Rotación: **90 días** o ante compromiso. Proceso: generar nueva clave → publicar en JWKS
  (coexiste) → firmar tokens nuevos con `kid` nuevo → conservar la anterior 24 h en JWKS →
  retirar. Los tokens viejos expiran solos (15 min), así que la ventana de solapamiento sólo
  importa por relojes desincronizados: `clockTolerance` de validación 60 s máximo.
- Claves privadas: tabla `tok_clave_firma`, **cifradas con AES-256-GCM** con master key desde
  env `TQ_MASTER_KEY` (32 B, base64). Nunca en el repo ni en backups sueltos del SQL; la base
  de control se respalda, la master key se guarda aparte (gestor de secretos del cliente).
- Validación en apps: caché JWKS 24 h + refresco forzado ante `kid` desconocido (una vez por
  token, no por request). Verificar siempre: `iss`, `aud`, `exp`, `nbf`, `alg` fijo RS256
  (rechazar `none`).
- **El validador de referencia** es `backend/src/oidc/validador.service.ts` + `jwks-cache.ts`: es
  exactamente el código que RHPro va a copiar (Fase 06) y el que usa el propio `/userinfo`. Por
  eso vive en el repo y no en un script suelto: si el IdP no valida sus propios tokens con las
  mismas reglas que exige a las apps, la documentación miente. La caché del JWKS es del lado
  **cliente** (24 h); el endpoint `/.well-known/jwks.json` del lado servidor no cachea 24 h lo que
  publica, memoiza 60 s en memoria y anuncia `Cache-Control: max-age=300`, para que una rotación
  de clave se propague en minutos y no en un día.

## 6. Credenciales de bases registradas

- `cat_base_datos` guarda usuario/contraseña (o `pwd`) de bases **de las apps**, cifrados con el
  mismo esquema AES-256-GCM + `TQ_MASTER_KEY`. Cifrado sobre la marcha, por columna, sin IV
  reutilizado (IV aleatorio por registro guardado junto al ciphertext).
- Estos datos son **inventario**: sirven para despliegue asistido y, en el futuro, para el
  TenantRegistry de RHPro (`specs/00` §4). Ningún endpoint de Tourniquet los devuelve en claro.
- Rotación de credenciales de bases ajenas: fuera de alcance; se registra el cambio manual.

## 7. Auditoría

- `aud_login`: `id, idusuario?, idaplicacion?, ip, user_agent, resultado(ok|claves|bloq|
  replay|expirado), timestamp, detalle?`. Append-only, sin UPDATE ni DELETE desde la app.
- `tok_sesion`: sesiones activas y su cierre; el portal (rol administrador de identidad, Fase
  03) puede listar y forzar cierre de sesión de un usuario.
- Retención: 2 años o el contrato del cliente; el borrado se hace por job SQL externo a la app,
  nunca con DELETE desde código de negocio.
- Toda escritura de auditoría pasa con el `sub` real de la sesión (no admite "sistema" salvo
  rotación de claves y expiración por job).
- **Acciones de administración: el `idusuario` es el admin, y el afectado viaja en el `detalle`.**
  `idusuario` es la columna que se consulta ("qué hizo este usuario"), y lo que vale es quién
  **actuó**: un `alta_usuario` escrita con el `idusuario` del altaado haría que un admin se
  atribuyera a sí mismo la creación de una cuenta ajena, y una baja de permisos sería
  indistingible de un login. El afectado y el contexto van en el `detalle`, que es
  `nvarchar(500)` y sigue siendo un **código corto con datos estructurados**, nunca un volcado del
  input: `admin_alta_usuario|usuario=<uuid>|app=<codigo>`. Es el mismo criterio que el resto de la
  columna —"qué pasó, no el valor de lo que se tipeó"— con los identificadores que hacen falta
  para que la fila sirva.

## 8. MFA (diseño cerrado, activación Fase 04)

- `idn_usuario.mfa_secret` cifrado (AES-GCM, mismo master key), `mfa_estado` (`off|pending|on`).
- TOTP RFC 6238, SHA-1 30 s 6 dígitos, ventana ±1; códigos de recuperación de un solo uso.
- El claim `amr` ya contempla `mfa`: la app que quiera exigir segundo factor para una acción
  (no está en alcance hoy) lo lee del token sin cambios de esquema.

## 9. Amenazas y controles (resumen de review)

| Amenaza | Control |
|---|---|
| Redirect URI abierto (robo de code) | Comparación **exacta** contra lista registrada; sin wildcards; PKCE S256 obligatorio. El `redirect_uri` se **revalida** en `/oidc/token` contra el del code persistido: validar sólo en el authorize deja el canje abierto a otro `redirect_uri` |
| Token replay | `jti` único + caché anti-replay; HTTPS estricto; `aud` validada por la app |
| Refresh secuestrado | Rotación estricta: reuso del viejo ⇒ revocación de familia y alerta `replay` |
| DoS por `kid` inventado | El refresco forzado del JWKS está acotado: una vez por token **y** como máximo una vez cada 30 s |
| Fuga de base de control | Cifrado de columnas sensibles con master key externa; `pwd_hash` argon2id; nada en claro |
| Travesía entre tenants | `tenant`/`aud`/`sub` del token siempre; `tenant` deducido de la sesión del portal, nunca del query; toda query del portal escopada |
| Sesión zombi tras logout | `/oidc/logout` revoca `sid`; access vive 15 min sin refresh posible (no se renueva `sid` muerto) y `/userinfo` lo rechaza por `sid` muerto |
| Fuerza bruta login | Lockout 5/15' + rate limit doble (IP/usuario) + evento en auditoría |
| Code reutilizado | `invalid_grant` + evento `replay` en `aud_login`. **No** se revoca la familia: un doble clic o un reintento de red de la app legítima se verían igual que un robo, y matar la sesión por eso deja al usuario sin apps hasta que vuelva a loguearse. La familia se revoca sólo en el reuso de refresh, que sí es la señal de robo (`specs/01` §3) |
