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

### 5.1 Quién rota, por dónde y cómo se deshace (decidido en la Fase 09)

**La rotación es de la instalación, no de un tenant.** El JWKS es único por instalación y el
token no lleva `tenant` en la firma, así que rotar afecta a todos los clientes a la vez. Por eso
**no** es un endpoint del panel `/admin/*`: ahí `AdminGuard` autoriza al `admin_identidad` de **un
cliente**, y un admin de `cervi` no puede rotar las claves que firman los tokens de `jugos`.

Tres decisiones, y el motivo de cada una:

| Decisión | Por qué |
|---|---|
| **Lista de operadores en la configuración** (`TQ_OPERADORES_CLAVES`, logins separados por coma) en vez de un rol nuevo en `idn_usuario_cliente.rol` | El rol es **por cliente** y la operación es **de la instalación**: un rol nuevo en esa tabla haría que un admin de un cliente rotara las claves de todos. La lista es del entorno, como `TQ_ISSUER` |
| **Ruta `POST /operacion/claves/rotar`, no `/admin/claves/rotar`** | En todo el repo `/admin/*` significa "panel de un cliente" y ya tiene un guard con otro sentido. Un prefijo propio hace que la confusion entre "panel de `cervi`" y "rotar las claves de la instalación" no sea ni posible de escribir |
| **Deshabilitada por default** (`TQ_ROTACION_HABILITADA=false`) | El caso normal es el procedimiento **manual** por script (`scripts/rotar-clave.mjs`, que es lo que va al runbook). El endpoint existe para el drill y para una instalación que quiera automatizar, y mientras la variable no se ponga en `true` **el endpoint no existe**: responde 404, no 403, porque "no hay que protegerlo" no es lo mismo que "no te deja" |

Las dos exigen, además, una **sesión de portal viva**: el endpoint es para una persona con un
login, no para un proceso. Y toda rotación queda en `aud_login` con el `idusuario` del operador
(el caso "sistema" que admite `specs/01` §7 es el job de expiración, no esto).

**Rollback.** Reactivar la clave anterior es una operación más del mismo servicio
(`FirmaService.reactivar`): pone `activa=1` en esa clave y retira la que estaba activa. Es
segura **mientras la clave que se reactiva siga en la tabla**, o sea dentro de la fila — nunca se
borran claves—, y por eso el runbook dice "reactivá el `kid` anterior" y no "generá una nueva": un
drill a la mitad se deshace con el mismo `kid` que estaba en el JWKS antes.

**La ventana de 24 h es lo que hace reversible la rotación.** Entre la publicación de la clave
nueva y la caída de la anterior hay 24 h en las que el JWKS publica las dos, y ese es el margen
real de deshacer. Fuera de esa ventana, un token firmado con la clave retirada ya no valida, y lo
que queda es reemitir el ingreso de los usuarios afectados.

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
- Toda escritura de auditoría pasa con el `sub` real de la sesión. **No hay filas de "sistema"**:
  la rotación de claves la escribe el operador con su propio `idusuario` (§5.1) y los jobs de
  retención no escriben en `aud_login` en absoluto — el 98 sólo marca `tok_sesion`, y borrar
  `aud_login` viejo no es un evento del que dependa el ingreso de nadie.
- **Acciones de administración: el `idusuario` es el admin, y el afectado viaja en el `detalle`.**
  `idusuario` es la columna que se consulta ("qué hizo este usuario"), y lo que vale es quién
  **actuó**: un `alta_usuario` escrita con el `idusuario` del altaado haría que un admin se
  atribuyera a sí mismo la creación de una cuenta ajena, y una baja de permisos sería
  indistinguible de un login. El afectado y el contexto van en el `detalle`, que es
  `nvarchar(500)` y sigue siendo un **código corto con datos estructurados**, nunca un volcado del
  input: `admin_alta_usuario|usuario=<uuid>|app=<codigo>`. Es el mismo criterio que el resto de la
  columna —"qué pasó, no el valor de lo que se tipeó"— con los identificadores que hacen falta
  para que la fila sirva.

### 7.1 Los cuatro jobs de retención (Fase 09)

La retención y la limpieza se hacen **por SQL fuera de la app**, en cuatro scripts idempotentes
de `deploy/sql/` (`95-` a `98-`), con su `SELECT` de conteo previo y posterior:

| Script | Qué borra o marca | Frecuencia |
|---|---|---|
| `95-job-codigos.sql` | `tok_autorization_code` vencido hace más de 1 día, y `tok_mfa_challenge` vencido | cada 5 min |
| `96-job-refresh.sql` | `tok_refresh_token` revocado hace más de 90 días | diaria |
| `97-job-auditoria.sql` | `aud_login` con `ts` de más de 2 años | mensual |
| `98-job-sesiones.sql` | **marca** `cerrada_en`/`motivo_cierre='expirada'`; no borra | cada hora |

Tres reglas que los jobs respetan y que son de diseño, no de implementación:

1. **`aud_login` nunca se borra desde la app y su retención es de 2 años o la del contrato.** Si
   un cliente pide 5 años, se cambia `97-job-auditoria.sql` y esta línea, no el criterio.
2. **`tok_sesion` no se borra: se cierra.** Un `DELETE` de sesiones sería la forma corta de
  _revocar_ sin dejar rastro, y `tok_sesion` es append-only con revocación. El job 98 existe
   para que "mis sesiones" no dependa de un filtro de fechas en cada consulta y para que el
   `motivo='expirada'` quede escrito.
3. **Los refresh vencidos se conservan mientras la sesión viva.** El job 96 borra los
   **revocados** hace más de 90 días, no los que "expiran": un refresh que expiró solo es
   evidencia de que esa sesión existió, y borrarlo por fecha de expiración dejaría el
   `replay` de una familia sin el token con el que se detectó.

**Quién los agendar es del cliente, y el motor puede no tener Agente.** Los cuatro scripts son
T-SQL puro, idempotentes y sin dependencias del entorno del backend (no leen `TQ_MASTER_KEY` ni
hablan con la app), así que se agendan de las dos maneras:

| Motor | Cómo | Quién |
|---|---|---|
| SQL Server completo | **SQL Agent**: un trabajo por script, con su propia frecuencia | el usuario |
| **SQL Server Express** (no tiene SQL Agent) | **Planificador de tareas de Windows** corriendo `deploy/jobs/ejecutar-jobs.cmd`, que invoca `sqlcmd` por cada `.sql` | el usuario |

El procedure de esa segunda variante —cuenta de servicio, autenticación, permisos mínimos del
usuario de SQL, y el paso exacto del Planificador— está en `deploy/runbooks/jobs-limpieza.md`.
Lo que **no** cambia entre las dos es la regla: el borrado lo hace un `.sql` versionado, con
`DELETE` acotado por fecha, ejecutándose **fuera** del proceso de la aplicación.

## 8. MFA (diseño cerrado; implementado en la Fase 09)

- `idn_usuario.mfa_secret_cifrada` cifrado (AES-GCM, mismo master key, `varbinary(512)`),
  `mfa_estado` (`off|pending|on`), `mfa_ultimo_periodo` bigint NULL.
- TOTP RFC 6238, SHA-1, 30 s, 6 dígitos, ventana ±1; códigos de recuperación de un solo uso.
- El claim `amr` ya contempla `mfa`: la app que quiera exigir segundo factor para una acción
  (no está en alcance hoy) lo lee del token sin cambios de esquema.

### 8.1 Los tres estados, y por qué hay tres

| Estado | Qué hay | Qué exige el login | Quién lo cambia |
|---|---|---|---|
| `off` | nada | clave sola | el admin (o el usuario) desactiva |
| `pending` | `mfa_secret_cifrada` poblado, códigos de recuperación generados, `mfa_estado='pending'` | **clave sola** | el usuario, confirmando un código de su app |
| `on` | lo mismo, confirmado | clave **y** segundo factor | el admin (o el usuario) desactiva |

**En `pending` no se pide el segundo factor.** Ese es el sentido de `pending` y la trampa más
falsa de esta sección: si `pending` pidiera el código, un usuario al que el admin le activa MFA
mientras está en medio de un ingreso se quedaría sin acceso entre el alta y la confirmación, y
la confirmación—que es un paso aparte—no se puede hacer desde una pantalla a la que no se llega.
En `pending` el ingreso funciona normal y la confirmación se hace desde `/mi-cuenta`.

**El `otpauth://` y los códigos de recuperación se muestran una sola vez**, en la respuesta que
activa: son la única vez que existen en claro. Después quedan el secret cifrado y los hashes, y no
hay endpoint que los devuelva. Es el mismo criterio que la `clave_temporal` de la Fase 08.

### 8.2 Endpoint del segundo factor (login en dos pasos)

El login con `mfa_estado='on'` **no crea sesión** y responde 200 con
`{ requiere_mfa: true, factor_id, expira_en }`. `factor_id` es el `id` de la fila de
`tok_mfa_challenge` (un UUID, de un solo uso, vida 5 minutos).

`POST /auth/mfa/verify` con `{ factor_id, codigo }` es el que **crea la sesión** y escribe la
cookie. `codigo` acepta las dos formas del segundo factor: 6 dígitos de TOTP o un código de
recuperación. Hasta ese momento no existe fila en `tok_sesion`: un `mfa_estado='on'` sin código
no deja nada detrás.

El desafío se resuelve **en el servidor**: la fila guarda el `idusuario`, el `idcliente` ya
resuelto y el `returnTo` ya validado del paso 1. El segundo pedido no manda usuario, ni cliente,
ni destino, y el portal los muestra desde la fila. Es lo que hace que un F5 en la pantalla de
verificación no rompa el ingreso y que recargar con el `factor_id` a mano no sirva de nada sin el
código.

Cinco intentos fallidos matan el desafío (`intentos` en la fila) y el usuario tiene que volver a
ingresar. El desafío no suma intentos al bloqueo de contraseña (`intentos_fallidos` de
`idn_usuario`): son dos cosas distintas, y mezclarlas dejaría a un usuario con la clave correcta
bloqueado por teclear mal un código.

### 8.3 Anti-reuso del código TOTP (trampa 1 de la fase 09)

La ventana ±1 que hace tolerante al reloj es **la misma ventana por la que un código sirve dos
veces**: un código válido en el período `N` también valida en `N+1`. Por eso
`idn_usuario.mfa_ultimo_periodo` guarda **el último período aceptado** y un período `<=` a ese
valor se rechaza, aunque el código sea correcto.

El costo es Known: un código verificado en el límite pierde su validez antes de que termine el
período. Preferible a un código espiado en el límite sirviendo dos veces.

Un código de recuperación **no** consume período: es de un solo uso, y la unicidad la da
`usado_en` + el `UPDATE` condicionado, no el reloj.

### 8.4 Desactivar MFA cierra las sesiones del cliente

`DELETE` de MFA (del panel o del propio usuario) pone `mfa_estado='off'`, borra el secret
cifrado y los códigos no usados, y **cierra las sesiones vivas de ese usuario en ese cliente**
(motivo `revocada`).

Por qué, si `amr` es un registro de lo que pasó y no una política: el token de una sesión vieja
seguiría afirmando `mfa` mientras la cuenta ya no lo exige, y un token robado de esa sesión
valdría lo mismo que una contraseña, que es justo lo que el admin quiso evitar al desactivar.
Con el cierre, la sesión siguiente se crea con `amr = 'pwd'`, que es la verdad.

Los access ya emitidos siguen siendo criptográficamente válidos 15 minutos; lo que deja de valer
es `/userinfo` y el refresh, porque el `sid` está muerto.

### 8.5 Códigos de recuperación

- 10 por usuario, de un solo uso, en `idn_usuario_mfa_codigo`.
- 10 caracteres del alfabeto sin ambiguos (`ABC…XYZ23456789`, sin `I L O U 0 1`), en dos bloques
  de cinco separados por un guion. Se leen en voz alta y se anotan en un papel.
- Se guardan **hasheados** con sha256 y sal con el `idusuario` del propio usuario
  (`sha256(codigo_normalizado + idusuario)`). No es un secreto de alta entropía: 10 caracteres de
  un alfabeto de 28 son ~48 bits, y un sha256 sin sal deja el ataque por diccionario a un atacante
  con una GPU. La sal es pública a propósito —es el mismo UUID que ya viaja en el claim `sub`—
  y lo que evita es la tabla precalculada, no el atacante con la base.
- Se **normalizan** al verificar: sin guion, en mayúsculas. El usuario los escribe como los ve.
- Regenerarlos **invalida** los anteriores: es lo que se hace cuando se sospecha de que se
  filtraron o se perdieron, y por eso la operación es del panel y queda auditada.
- Cuando quedan **2 o menos**, la UI avisa. Un usuario sin códigos de recuperación y con el
  teléfono roto es un usuario que llama a un operador de puerta.

### 8.6 Lo que MFA **no** es

- **No protege el egreso.** Con MFA activo, cerrar sesión sigue siendo sólo el click
  (`specs/01` §4): el segundo factor protege el ingreso. Proteger el egreso es un segundo factor
  al cerrar, que no está en esta spec.
- **No es recuperación de cuenta.** No hay correo, no hay SMS, no hay "¿olvidé mi código?": el
  único camino de vuelta es un código de recuperación o un operador con el panel. Es lo mismo que
  el resto del alta de usuarios (Fase 08: el alta la hace un admin).
- **No viaja en el token.** `amr` dice `mfa`, nunca el secret, nunca el código, nunca el
  `factor_id`.

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
| Código TOTP reutilizado | `mfa_ultimo_periodo`: un período `<=` al último aceptado se rechaza, aunque el código sea correcto. La ventana ±1 del reloj es también la ventana de reuso (§8.3) |
| Secret del segundo factor filtrado | `mfa_secret_cifrada` con AES-256-GCM y `TQ_MASTER_KEY`; el `otpauth://` sale **una sola vez** (el alta) y ningún endpoint lo devuelve. Ante la duda, desactivar y volver a activar: eso genera un secret nuevo e invalida los códigos anteriores |
| Códigos de recuperación en papel | Un solo uso (`usado_en`), hasheados con sal por usuario, y regenerarlos desde el panel **invalida** los anteriores. El papel es el riesgo asumido: es el mismo compromiso que una contraseña escrita, y por eso son 10 y no 1 |
| Rotación de claves firmada a medias | El proceso es generar → publicar → firmar → retirar, y la ventana de 24 h del JWKS es el margen de deshacer. `deploy/runbooks/rotacion-claves.md` tiene los pasos, la verificación y el rollback; `npm run verificar:rotacion` dice si el estado de las claves es el esperado |
