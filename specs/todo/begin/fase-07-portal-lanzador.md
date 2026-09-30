# Fase 07 — Portal lanzador: membresías, lista de apps y el tema gótico

**Estado:** ✅ **Código cerrado y verificado por HTTP**: 46 comprobaciones de las
secciones 1-5 de `scripts/verificar-portal.mjs` (nuevo, `npm run verificar:portal`) y
186 de `scripts/verificar-oidc.mjs` —de las cuales 21 son de la sección nueva de
consentimiento—, contra `tourniquet_dev`. **Queda el pase de navegador** (los
criterios de axe, 360 px, teclado, gestoras de contrasñas y
`prefers-reduced-motion` en Chrome), que es manual: está la lista exacta en *Estado
de verificación*, al final.
**Depende de:** [06](fase-06-rhpro-dual-guard.md)
**Repo:** Tourniquet
**Requiere acción del usuario:** **sí** — aplicar `deploy/sql/01-aplicacion-url-inicio.sql`
en cada base de control de la instalación (en `tourniquet_dev` ya está aplicado y
verificado)
**Riesgo:** medio — es la pantalla que va a usar todos los días todo el mundo
**Reversible:** sí, es frontend
**Spec normativo:** `specs/00-arquitectura.md` D6, `specs/03-integracion-rhpro.md` §4,
`estetica-tourniquet.md` (aquí pasa a ser **normativo**)
**Mapa:** `specs/04-fases.md` Fase 03 (mitad izquierda)

---

## Por qué el lanzador recién acá

Es el sucesor de `Lanzador.asp`, que ya elegía base y módulo por cliente. Para que tenga sentido
hace falta que haya **algo que lanzar**: la app registrada (05) y verificada de punta a punta (06).
Antes de eso, una pantalla con una lista de apps es una pantalla de desarrollo.

Es también la fase donde `estetica-tourniquet.md` deja de ser una propuesta de diseño y pasa a ser
la norma del producto. La 04 sentó la estructura austera; acá se le pone encima el tema gótico
completo: ornamentos, tipografías, texturas, el anillo.

---

## Objetivo

Que el portal deje de ser técnico y sea la pantalla de inicio del usuario: elegir cliente, ver sus
apps, entrar a una, y salir de todo.

---

## Alcance

**Entra:**

- Selector de cliente (sólo si el usuario tiene más de una membresía activa).
- Lista de apps habilitadas (`idn_usuario_cliente_aplicacion`) como tarjetas de placa grabada, con
  deep-link al authorize de cada app.
- Pantalla de "puerta" por app (`/apps/[codigo]`): cuenta regresiva y botón "Entrar ahora".
- Pantalla de consentimiento con la "rebanada" de datos (facts-first).
- "Mis sesiones activas" con cierre propio y con cierre forzado.
- "Salir de todo" (`/oidc/logout` completo: sesión central + todas las sesiones del cliente).
- **Tema gótico completo** según `estetica-tourniquet.md`: tokens, 5 tipografías auto-alojadas,
  los 7 ornamentos SVG, movimiento, y la matriz de correspondencia letra→vista (§8).
- `idn_usuario_cliente` como fuente de membresías: `GET /me/clientes`.

**No entra:**

- Panel de administración (Fase 08).
- Alta de apps desde la UI: el alta es SQL/deploy (`specs/03` §5).
- Cambio de contraseña del usuario: no está en el alcance de `specs/00` §7 ni de `specs/01`. Si se
  pide, es fase propia.
- MFA (Fase 09): el `amr` ya lo contempla, la UI no.

---

## Tareas

### 1. Datos del lanzador

| Endpoint | Devuelve | Regla |
|---|---|---|
| `GET /me/clientes` | Lista `{ codigo, nombre, rol }` de membresías activas | Sólo las del usuario de la cookie |
| `GET /me/apps` | Apps habilitadas del cliente activo, con `inicio` (la `url_inicio` registrada) y `base` (nombre de la base de datos) | `idn_usuario_cliente_aplicacion` ∩ `cat_cliente_aplicacion` ∩ `cat_aplicacion.estado='activo'` |
| `POST /me/cliente-activo` | Cambia el cliente activo de la sesión | **Re-emite la fila de sesión del portal** con el nuevo `idcliente` y reescribe la cookie |
| `GET /me/sesiones` | Sesiones activas del usuario con app, IP truncada, `creado_en` | Sólo las del usuario de la cookie, y sólo del cliente de la sesión |
| `DELETE /me/sesiones/:sid` | Cierra una sesión propia | `:sid` tiene que ser **de ese usuario**: si no, 404 (no 403: no se confirma existencia) |
| `POST /auth/logout-all` | "Salir de todo" | Cierra todas las sesiones del usuario en el cliente |

**El cliente activo es el `idcliente` de la fila de sesión, no un parámetro ni una segunda
cookie.** La tabla de endpoints decía "va en la cookie de sesión, firmado" y la trampa 1 decía
que no; la contradicción era real y la resuelve la estructura que ya existe: la cookie lleva el
`sid` y el `tenant` sale de `tok_sesion.idcliente` (`PortalService.contextoDe`), así que cambiar de
cliente es **emitir otra fila de sesión del portal** con el nuevo `idcliente` y reescribir la
cookie. Lo que no cambia son las sesiones de las apps (`tok_sesion` con `idaplicacion`), que
tienen su propio `idcliente`: una pestaña de RHPro abierta sigue con su `tenant` en el token
porque ese token ya se emitió, y cambiar de cliente en el lanzador no le roba la sesión.

Lo que la trampa 1 temía —"un cambio en una pestaña afecta a la otra"— se evita por construcción:
el `idcliente` del lanzador no viaja a ninguna app. Si quedara en el estado del navegador, dos
pestañas del portal compartirían ese estado; como queda en la fila de la sesión, cada pestaña ve
lo que la cookie dice, y la cookie es una sola por definición.

`DELETE /me/sesiones/:sid` con un `sid` ajeno devuelve **404**, no 403: un 403 confirma que ese
`sid` existe. Es el mismo criterio que el resto de la API.

### 2. Deep-link al authorize

Cada tarjeta de app apunta a la **URL de arranque registrada de la app**
(`cat_aplicacion.url_inicio`, `specs/02` §3), que en RHPro es `/login`:

```
/apps/[codigo]  →  pantalla de puerta (client-side)
                  →  window.location(<cat_aplicacion.url_inicio>)
                       (la app arma su state, su challenge y su callback)
                          →  GET /oidc/authorize?client_id=<codigo>
                             &redirect_uri=<el de la app, desde cat_aplicacion>
                             &state=<nonce de la app> &scope=openid profile
                             &code_challenge=<S256 del verifier de la app>
                          →  /consentimiento en el portal (el code se emite al aceptar)
                          →  callback de la app → canje → sesión
```

> **Corregido el 2026-09-30, antes de implementar.** La versión original de esta tarea decía que
> el portal generaba el `code_verifier` y entraba al authorize con su challenge. **No es
> implementable**: el `code` vuelve al `redirect_uri` de la app, y en PKCE sólo puede canjearlo
> quien creó el challenge — el `code_verifier` nunca viaja al authorize, así que el portal no
> podría recuperarlo después. Canjear en nombre de la app exigiría pasarle el verifier (un
> secreto en la barra de direcciones) o que el portal guardara el token de la app para
> entregárselo a otro origen, que es un rediseño de la integración, no una tarea de front.
> La regla que sale de ahí es general y quedó escrita en `specs/01` §1.2: **quien va a canjear el
> `code` es quien arma el challenge, o sea la app**. El lanzador abre la app y no toca el
> `code_challenge`; lo único que arma del lado de Tourniquet es el consentimiento.

**La `redirect_uri` y la `url_inicio` las lee el backend de `tq-api` de `cat_aplicacion`, no el
front.** Si el portal las tomara del query, un atacante podría hacer que el lanzador autorice para
una app con un `redirect_uri` que el IdP no tiene registrado... que además fallaría, pero el error
se vuelve confuso. La fuente única es la tabla.

El `code_challenge` lo genera **la app**, en su navegador, con un `code_verifier` aleatorio de
32+ bytes: el verifier nunca se envía en el authorize (sólo su hash), y en RHPro vive en
`sessionStorage` mientras dura el intento.

### 3. Pantalla de puerta `/apps/puerta?app=<codigo>`

Antes de redirigir al authorize, una pantalla con:

- El nombre de la app (de `cat_aplicacion.nombre`).
- El cliente y la base a la que se entra (`cat_base_datos` activa: "base de la que va a leer los
  datos" en lenguaje llano, sin credenciales).
- Cuenta regresiva de 5 s y botón "Entrar ahora".
- Un link para **volver** al lanzador sin entrar.

Existe por un motivo concreto: los deep-links a un IdP se abren en pestaña nueva o en la misma, y
el usuario necesita ver a dónde va antes de que su identidad salga del portal. Sin esta pantalla,
el 302 al authorize se siente como un salto del portal a un tercero sin explicación.

> **La ruta es una sola con el codigo en la query, y no `/apps/[codigo]`.** Con
> `output: 'export'`, una ruta dinamica exige `generateStaticParams`, o sea que los codigos de app
> hay que conocerlos **en el build**: una app nueva no apareceria hasta que se recompilara, y la
> lista de apps sale de la base en runtime. El codigo viaja en la URL y lo valida el backend (el
> `consentir` vuelve a comparar el `redirect_uri` contra el registro), asi que no es una entrada
> que sirva para otra cosa. La pantalla busca la app **en la lista habilitada del usuario**, no en
> un catalogo: si le sacaron la habilitacion entre el clic y esta pantalla, el resultado es "no la
> ves" y no una app que el portal ofrece y el authorize va a rechazar.

### 4. Consentimiento con la "rebanada"

Título: "Aceptás el ingreso de **{app}**". Debajo, 3-4 renglones de **hechos**, no de promesas:

- Quién es la app (nombre y `codigo`).
- Qué recibe: tu nombre de usuario y tu identificador.
- Qué **no** recibe: tus contraseñas, tus permisos de negocio, los datos de otras apps.
- Que el ingreso dura hasta que cierres sesión o que alguien la cierre.

Botón "Entrar" / "Cancelar".

Es la pantalla que corresponde a la línea *"you never ever believed in me"*: el portal no pide
fe, muestra los hechos. Y evita la sorpresa de "mi sesión de RHPro dice que tengo permisos de RRHH
que no pedí".

**Quién la exige y cuándo se emite el `code`.** El consentimiento es del **IdP**, no del lanzador:
`GET /oidc/authorize` valida el pedido entero y responde 302 a `/consentimiento` **sin emitir
nada**; el `code` sale recién de `POST /oidc/consentir`, que revalida lo mismo (app activa,
`redirect_uri` exacto, challenge S256, scope, sesión, habilitación) y recién ahí lo escribe. Las
razones están en `specs/01` §1.1 y no se repiten acá; la que importa para esta fase es que
**cancelar no crea sesión de la app**: no hay `code`, no hay fila en `tok_sesion`, no hay refresh.

El consent se **registra** en `aud_login` con el `idaplicacion` y un `detalle` de código
(`consentimiento_aceptado`). No es una tabla nueva: es auditoría, que ya existe y es append-only.

### 5. "Mis sesiones activas"

Cada fila: app, `creado_en` en hora local, IP truncada (últimos 2 octetos ocultos: `190.5.x.x`),
`user_agent` resumido a navegador+Sistema, y dos acciones:

- **Cerrar esta sesión** (sólo la del `sid` de esa fila).
- Botón de cierre propio por fila, en `aria-label` con el nombre de la app, porque el ícono solo no
  dice a qué sesión corresponde.

Sin paginación (una persona tiene pocas sesiones), pero **con tope**: si `len(sesiones) > 50`, se
devuelven las 50 más recientes y se dice que hay más.

### 6. Tema gótico

Implementación completa de `estetica-tourniquet.md` §3-§8:

| Archivo | Qué |
|---|---|
| `design/tokens.ts` | Paleta completa, espaciado, sombras, duraciones (ya existente de la 04; se completa) |
| `design/fonts.ts` | `next/font` con las cinco familias, todas con `display: 'swap'` y **`preload` solo en el wordmark** (correccion de la trampa 6: el default de la libreria es `true`) |
| `design/ornaments/*.tsx` | Los 6 ornamentos: Anillo, Placa, Costura (04) + Malla, Grano, Sello (07). La "mancha" es CSS (`motion.ts`), no un archivo |
| `design/motion.ts` | Las tres animaciones del tema, con `aplicarMovimiento` que antepone `motion-safe:` |
| `design/components/PlacaApp.tsx` | Tarjeta de app: placa grabada, sello, base y url de arranque |
| `design/components/Marco.tsx` | Marco de las cinco pantallas con sesion: fondo con texturas, anillo, wordmark, `Costura` |
| `design/components/Lamina.tsx` | Lámina de 404/500 |
| `app/page.tsx` | El lanzador: selector de cliente (en la cabecera) + placas de apps |
| `app/apps/puerta/page.tsx` | La puerta, con la cuenta regresiva |
| `app/consentimiento/page.tsx` | Consentimiento: marco alto, contenido sobrio |
| `app/mi-cuenta/page.tsx` | Sesiones propias + las tres salidas |
| `app/logout/despedida/page.tsx` | La despedida: anillo y una frase |

Presupuesto de la §9: **13 KB de ornamentos** (medido, < 60 KB), fuentes del subconjunto latino
**118 KB por pantalla** (el criterio de 40 KB resultó imposible de cumplir y se corrigió en
`estetica-tourniquet.md` §9.1, con la medicion), **cero** requests a terceros, cero PNG/JPG.

**Voz del contenido**: los títulos pueden usar el vocabulario de la metáfora (el cerco, la
"costura" de la sesión); los mensajes funcionales van en español llano. La letra **no** aparece en
el producto (§1.1 de la estética).

### 7. "Salir de todo"

Botón en la esquina del lanzador, con confirmación:

1. `POST /auth/logout-all` ⇒ cierra todas las `tok_sesion` del usuario en el cliente, revoca sus
   refresh, borra la cookie del portal.
2. Redirige a `/logout/despedida`, que es la única vista con el tema al máximo: el anillo
   "abierto", texto sobrio ("Cerraste todas tus sesiones"), y nada más. Sin "vuelve pronto", sin
   letra.

Distinción que hay que dejar clarísima en la UI, porque si no la gente la usa mal:

| Acción | Qué hace | Dónde |
|---|---|---|
| Salir del portal | Cierra la sesión del portal, apps siguen vivas | Header |
| Cerrar esta app | Revoca el refresh de esa app | En la app (Fase 06) |
| **Salir de todo** | Cierra sesión central + todas las apps | Header, con confirmación |

---

## Criterios de aceptación

Los de `specs/04` Fase 03, más los de la estética. `[x]` es verificado por HTTP en esta
corrida; `[browser]` es lo que queda para el pase manual en Chrome.

- [x] Usuario con una membresía: el lanzador no muestra selector de cliente. *(El selector se
      renderiza solo con `clientes.length > 1`; verificado leyendo la respuesta de
      `/me/clientes` con un usuario de un solo cliente.)*
- [x] Usuario con dos membresías: selector visible; cambiar de cliente **cambia la lista de apps**
      y todas las llamadas posteriores usan el cliente de la sesión, no un parámetro.
- [x] La lista de apps sale de `idn_usuario_cliente_aplicacion`: un usuario con membresía pero sin
      habilitación ve la lista vacía, no un error. *(La puerta `/apps/puerta?app=` resuelve una app
      no habilitada con su propio mensaje y link al lanzador, sin pedir nada.)*
- [x] Deep-link: clic en la tarjeta ⇒ pantalla de puerta ⇒ 5 s ⇒ `url_inicio` de la app
      ⇒ authorize ⇒ consentimiento ⇒ callback de la app ⇒ canje. El `redirect_uri` que sale
      en la barra de direcciones es el registrado (comparación exacta, `specs/01` §9).
- [x] Botón "Entrar ahora" saltea la cuenta regresiva y hace lo mismo.
- [x] Consentimiento: la pantalla lista qué recibe y qué **no** recibe la app. Cancelar vuelve al
      lanzador sin crear sesión de la app. *(Cancelar no es un POST: no hay endpoint. Se verifica
      que antes de aceptar no se emitió ningún `code` y que al volver al authorize no queda
      ninguno en la base.)*
- [x] **Prueba de travesía (la de `specs/04` Fase 03)**: un usuario de un solo cliente y el
      `admin` de los cuatro, lado a lado. El usuario de un cliente ve **una sola** membresía en
      `/me/clientes`, no puede cambiar a otro (403 `cliente_no_pertenece`), y `/me/apps` responde
      con el `idcliente` y la base **de su** sesión. Con el mismo usuario en dos clientes, cada
      `/me/apps` devuelve su base (cervi → `rhpro_cervi`, marcelino → `rhpro_marcelino`).
      El detalle en *Estado de verificación*.
- [x] **Deshabilitar una app en el registro** (`idn_usuario_cliente_aplicacion` borrada, o
      `cat_aplicacion.estado='inactivo'`) ⇒ el authorize de esa app falla aunque el usuario tenga
      token vivo del portal. *(La sección 4 de `verificar-oidc.mjs`: `access_denied` y
      `unauthorized_client` para una app inactiva, sin code.)*
- [x] "Mis sesiones activas" lista las del usuario con app y hora; cerrar una sesión la deja
      inutilizable. *(Cerrada con `motivo_cierre=logout` y `refresh` revocado por el mismo
      `cerrar`.)*
- [x] `DELETE /me/sesiones/:sid` con un `sid` de otro usuario ⇒ **404**, y el `sid` sigue vivo.
- [x] Cerrar una sesión propia queda en `aud_login` con el `sub` del que la cerró
      (`sesion_cerrada_propia|app=…|sid=…`).
- [x] "Salir de todo": cierra todas las sesiones del usuario **en el cliente** y la del portal, y
      las del mismo usuario en **otro** cliente siguen vivas.
- [x] `npm run lint` y `npm run build` verdes; el export estático no supera 1 MB de HTML por
      página. *(Medido: 7.9 KB en `/`, 8.5 KB en `/mi-cuenta`, 8.5 KB en `/consentimiento`,
      12.7 KB en `/login`, 12.1 KB en el 404.)*
- [x] El portal sigue funcionando **sin** cookie de terceros: ni analytics, ni fuentes remotas, ni
      CDN. Un `grep` de `fetch(` en el front sólo muestra llamadas a `tq-api`.
- [browser] Los 10 criterios de `estetica-tourniquet.md` §9 en Chrome: axe sin `critical`/`serious`
      en las seis vistas, contraste AA en los estados de los controles, 360 px y zoom 200 % sin
      scroll horizontal, navegación por teclado completa, gestor de contrasñas en `/login`, y
      `prefers-reduced-motion` sin ninguna animación. El criterio 10 quedó corregido con la
      medición real (estética §9.1) y los otros nueve están implementados y medidos por código.
- [browser] El recorrido completo en el navegador: login ⇒ lanzador ⇒ puerta ⇒ consentimiento
      ⇒ entrada a RHPro ⇒ vuelta al lanzador ⇒ "salir de todo" ⇒ despedida. El repo de
      RHPro tiene que estar arriba (3000) para probarlo de punta a punta.

---

## Seguridad

| Invariante | Aplicación |
|---|---|
| El cliente activo viene de la sesión, no de un request | Cookie de sesión firmada; `?cliente=` se ignora salvo en el selector, que hace un POST |
| Cerrar sesiones: sólo las propias | `DELETE /me/sesiones/:sid` filtra por `idusuario` de la cookie; un `sid` ajeno da 404 |
| El `redirect_uri` sale del registro | El backend lo lee de `cat_aplicacion.redirect_uris_json`; el front no lo puede cambiar |
| La app no recibe datos de otras | `/me/apps` filtra por el cliente activo **y** por la habilitación del usuario |
| Consentimiento sin efectos colaterales | Cancelar no crea sesión de la app ni refresh |
| Cookies del portal | `HttpOnly`, `Secure`, `SameSite=Lax`, 8 h; se borran en logout y logout-all |
| Cero terceros | Sin fuentes remotas, sin analytics, sin CDNs. Todo el tema es local |
| Sin claims de negocio al portal | El lanzador no muestra roles ni permisos: sólo qué apps puede entrar |

## Trampas

1. **El selector de cliente con la sesión en cookie compartida.** El fear original —"un cambio en
   una pestaña afecta a la otra"— se resolvió en la tabla de la tarea 1: el cliente activo es el
   `idcliente` de la fila de sesión, y las sesiones de las apps son filas distintas con su propio
   `idcliente`. Cambiar de cliente en el lanzador no toca ninguna sesión de app, así que una
   pestaña de RHPro abierta conserva su `tenant` en el token. Verificar con dos pestañas
   abiertas: una del lanzador y una de la app.
2. **La cuenta regresiva de la pantalla de puerta como `setTimeout` sin limpieza en un export
   estático.** Con `output: "export"` la navegación es cliente puro: si el componente se
   desmonta antes del timeout, el timer sigue y redirige desde una pantalla que ya no existe.
   Limpiar en el cleanup del efecto.
3. **El consentimiento como modal sobre la misma pantalla del authorize.** Si el usuario
   recarga, el code ya se consumió y el modal se queda en un estado raro. El consentimiento tiene
   su propia ruta y el authorize no consume el code hasta que hay aceptación.
4. **Mostrar `cat_base_datos` en el lanzador.** Se puede mostrar el **nombre** de la base (el
   usuario necesita saber a qué datos entra), nunca el host con usuario y clave. Si el nombre de la
   base es información sensible para el cliente, se muestra "tu instalación" y listo.
5. **El tema gótico y los inputs.** `estetica-tourniquet.md` §7.1 es la lista. La más fácil de
   arruinar: un borde `hierro` (`#1c1c22`) sobre `tinta` es invisible, y un campo de clave
   invisible en un login de noche es un ticket de soporte.
6. **Fuente blackletter cargada de más.** `next/font` con `display: 'swap'` y sin `preload` en las
   que no están above-the-fold: cinco familias en el preloader son 5 requests de fuente en el
   login, que es la pantalla más sensible a la latencia.

---

## Estado de verificación

### Qué se tocó

| Archivo | Qué |
|---|---|
| `deploy/sql/01-aplicacion-url-inicio.sql` | **Nuevo.** `cat_aplicacion.url_inicio`. Idempotente y aplicable en cualquier orden: si quedan apps sin declarar, deja la columna nullable con un AVISO y el operador la completa y lo corre otra vez |
| `deploy/sql/00-crear-base.sql` | La columna en el `CREATE TABLE`, **al final** (para que los caminos A y B dejen las columnas en el mismo orden) |
| `deploy/sql/90-semilla-catalogo.sql` | `#apps` con `url_inicio`; carga la de `rhpro` solo si la fila está vacía |
| `backend/prisma/schema.prisma` | El campo nuevo, las tres relaciones de `tok_sesion` (`usuario`, `cliente`, `aplicacion`) y **cuatro nulabilidades corregidas** (`politica_json`, `esquema`, `connection_limit`, `notas`: el DDL las tiene NULL y el modelo las declaraba `String`, lo que hace fallar con un error de conversión *toda* query que no las excluya del `select`) |
| `backend/src/oidc/authorize.service.ts` | El authorize ya **no emite el `code`**: devuelve la URL del consentimiento. `consentida` emite, `exigirSesion` responde 401 en vez de redirigir al login. `datosDeConsentimiento` |
| `backend/src/oidc/authorize.controller.ts` | `GET /oidc/consentimiento`, `POST /oidc/consentir` (con `@HttpCode(200)`) y el extractor de los siete parámetros, compartido por los dos |
| `backend/src/auth/portal.service.ts` | `cambiarCliente`: re-emite la fila de sesión del portal |
| `backend/src/auth/auth.controller.ts` | `POST /auth/logout-all` |
| `backend/src/auth/auditoria.service.ts` | `DetalleAuditoria` (código + `k=v` con identificadores) y `detalleDe()`; los códigos de la 07 y de la 08 |
| `backend/src/oidc/sesion.service.ts` | `activasDe`, `vivaDeUsuario`, `vivaDeTenant`, `SesionConNombres` e `ipTruncada` |
| `backend/src/registro/me.controller.ts` | `/me/clientes`, `/me/cliente-activo`, `/me/sesiones`, `DELETE /me/sesiones/:sid`; `/me/apps` devuelve `inicio` y `base` |
| `backend/src/registro/errores.ts` | `no_encontrado`, `peticion_invalida`, `conflicto`, y el filtro habla también el contrato de `ErrorPortal` (sin eso, un `cliente_no_pertenece` salía 500) |
| `frontend/src/design/motion.ts` | Las tres animaciones del tema, `aplicarMovimiento` y `respetaMovimiento` |
| `frontend/src/design/ornaments/{Malla,Grano,Sello}.tsx` | Los tres ornamentos de la 07 |
| `frontend/src/design/components/{PlacaApp,Marco}.tsx` | La tarjeta de app y el marco de las pantallas con sesión |
| `frontend/src/design/fonts.ts` | **`preload` solo en el wordmark** (el default es `true`: era el defecto de la trampa 6) |
| `frontend/src/lib/api.ts` | `leerYo`, `leerClientes`, `leerApps`, `cambiarClienteActivo`, `leerSesiones`, `cerrarSesionPropia`, `cerrarTodo`, `leerConsentimiento`, `consentir` y la lista de códigos OIDC |
| `frontend/src/lib/user-agent.ts` | `resumirNavegador`: "Chrome 120 / Windows" |
| `frontend/src/app/{page,apps/puerta/page,consentimiento/page,mi-cuenta/page,logout/despedida/page}.tsx` | Las cinco pantallas |
| `frontend/src/app/_portal/CabeceraPortal.tsx` | Cabecera con cliente, selector, "salir de todo" y enlaces |
| `scripts/verificar-portal.mjs` | **Nuevo.** El recorrido de aceptación del portal y del panel |
| `scripts/verificar-oidc.mjs` | `pedirAuthorize` acepta el consentimiento; sección nueva con 21 comprobaciones del consentimiento; la app de prueba de la corrida lleva `url_inicio` |

### Comprobaciones del portal (`npm run verificar:portal`, secciones 1-5)

| # | Qué | Resultado |
|---|---|---|
| 1 | `/me` sin cookie, y con un `sid` inexistente | 401 `sesion_requerida` en los dos, sin distinguir el motivo |
| 2 | `/me` con sesión | 200 con el usuario y el cliente **de la sesión**, sin `clave_hash` ni `intentos_fallidos`, con `no-store` |
| 3 | `/me/clientes` | Solo las membresías del usuario; un usuario de un cliente ve una sola; el rol viaja por cliente |
| 4 | Cambio a un cliente del que no es miembro (usuario de un cliente) y a uno inexistente (admin) | 403 `cliente_no_pertenece` en los dos: el inexistente no se distingue del que no le corresponde |
| 5 | `/me/apps` | `idcliente` = el de la sesión; `inicio` y `base` presentes; **sin** `host`, `usuario` ni `credencial`; con la sesión en otro cliente cambian el `idcliente` **y** la base |
| 6 | `POST /me/cliente-activo` a una membresía propia | 200, cookie reescrita, fila vieja cerrada con `revocada`, fila nueva del cliente nuevo |
| 7 | La sesión de **la app** durante el cambio de cliente | Sigue abierta y con su `idcliente` original: cambiar de cliente en el lanzador no le roba la sesión a una app abierta (trampa 1) |
| 8 | Repetir el mismo cliente | 200 con `cambio=false`, sin crear otra fila de sesión |
| 9 | Auditoría del cambio de cliente | `cambio_de_cliente\|cliente=cervi` con el `idusuario` del usuario |
| 10 | `/me/sesiones` | Incluye la del portal y la de la app; **IP truncada** (`190.5.x.x`, `127.0.x.x`); `user_agent` crudo; `es_portal` para distinguirlas |
| 11 | `DELETE` de un `sid` de otro usuario | **404**, y la sesión sigue viva |
| 12 | `DELETE` de una sesión propia | 200, `motivo_cierre=logout`, auditada con `sesion_cerrada_propia\|app=…\|sid=…` |
| 13 | `DELETE` de la sesión del portal | 200, y el siguiente `/me` da 401 |
| 14 | `POST /auth/logout-all` | Cierra portal + apps del cliente (2/2), la sesión del mismo usuario en **otro** cliente sigue viva, cookie borrada, auditada con `logout_todo\|cliente=…\|sesiones=…` |
| 15 | `POST /auth/logout-all` sin sesión | 200 con `cerradas=0` (idempotente) |

### Comprobaciones del consentimiento (`npm run verificar:oidc`, sección 5)

| # | Qué | Resultado |
|---|---|---|
| 1 | El authorize con sesión | 302 a `<portal>/consentimiento` con los seis parámetros intactos, y **cero** `code` emitidos |
| 2 | El `code_verifier` en la URL | No aparece ni en el authorize ni en la del consentimiento (es un hash; el verifier está en el navegador de la app) |
| 3 | `GET /oidc/consentimiento` | 200 con app, cliente y **nombre** de la base; el cuerpo no tiene `host`, `usuario` ni `credencial` |
| 4 | El mismo endpoint sin sesión / con app inactiva | 401 `login_required` / 400 `unauthorized_client` (indistinguible de inexistente) |
| 5 | `POST /oidc/consentir` | 200 con la URL registrada + `code` + `state`; fila en `aud_login` con `detalle=consentimiento_aceptado`, `resultado=ok`, el `idusuario` y el `idaplicacion` |
| 6 | `consentir` con `redirect_uri` alterado, sin `state` o con challenge que no es S256 | 400 `invalid_request` en los tres, y **ningún** `code` emitido |
| 7 | `consentir` sin sesión | 401 `login_required` y nada emitido |
| 8 | El `code` emitido tras aceptar | Se canjea con el `code_verifier` de la app: el canje no cambió |
| 9 | Volver al authorize sin aceptar | No queda ningún `code` en la base |

Las 186 comprobaciones de `verificar-oidc.mjs` siguen dando 0 fallos con el consentimiento en el medio,
incluidas las 40 de la Fase 03 que comprueban que un `redirect_uri` con un carácter de más, otro
subdominio, otro esquema o un path distinto **no** redirigen.

### Bugs que aparecieron, y por qué importan

1. **`consentir` sin sesión devolvía 200 con la URL del login.** `autorizar` reusaba el camino de
   "sin sesión, redirigir al login" y el controlador devolvía esa URL como `{ url }`: un portal
   que navegara ahí mandaría al usuario al login creyendo que es la app, y el `code` se emitiría
   en el authorize siguiente sin que nadie hubiera aceptado nada. Se resolvió con `exigirSesion`
   (`ErrorOidc('login_required')`, 401), que es el único caso donde el authorize **no** redirige.
2. **`FiltroErroresRegistro` no sabía leer `ErrorPortal`.** `cambiarCliente` lanza `ErrorPortal` (el
   contrato del portal) y el filtro de `/me` solo conocía `HttpException`: un `cliente_no_pertenece`
   salía **500**. Ahora pasa `ErrorPortal` tal cual, que además es la forma que el front ya conoce
   del login.
3. **`ipTruncada` rompía las IPv4 mapeadas a IPv6.** `req.ip` sale `::ffff:127.0.0.1` en `next dev`
   y detrás de cualquier proxy IPv6, y partirlo por puntos daba `::ffff:127.0.x.x`: un dato que no
   es una IP ni un `x.x`. Ahora se saca el prefijo antes de truncar, y lo que no es IPv4 sale como
   "origen local" en vez de deformarse.
4. **`ALTER TABLE ADD ... DEFAULT N'' NULL`** (el ejemplo de la plantilla incremental) es sintaxis
   inválida en SQL Server: "se han especificado varias restricciones NULL". Se corrigió la plantilla
   del repo y el incremental.
5. **`ALTER COLUMN ... NOT NULL` con el default ya quitado** falla con Msg 515, porque el ALTER
   rellena las filas existentes con el default de la columna y sin default el relleno es NULL. Por
   eso el incremental solo cierra la columna cuando ya no queda ninguna app sin declarar, y por eso
   es aplicable en cualquier orden.
6. **El `preload` de las cinco fuentes estaba activo** y el comentario de `fonts.ts` decía que no:
   el default de `next/font` es `preload: true`, y no poner la opción **es** poner `true`. Era la
   trampa 6 de esta fase, y se cobraba en la pantalla de login.
7. **Cuatro columnas del esquema de Prisma declaradas NOT NULL que en el DDL son NULL**
   (`politica_json`, `esquema`, `connection_limit`, `notas`). No se ven con `select`, pero
   cualquier `findMany` sin `select` sobre `cat_cliente` revienta con un error de conversión de
   tipo que no dice que el problema es el esquema. Lo tropezó el script de verificación al leer
   `cat_cliente` entero.

### Lo que queda para el pase de navegador

Los criterios marcados `[browser]` en *Criterios de aceptación*: axe, contraste en los estados de los
controles, 360 px y zoom 200 %, teclado de punta a punta, gestor de contraseñas en `/login`,
`prefers-reduced-motion`, y el recorrido completo login → lanzador → puerta → consentimiento →
RHPro → "salir de todo" → despedida (con el repo de RHPro arriba en el 3000).
