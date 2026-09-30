# Fase 04 — Portal: login, tema gótico y callback decodificado

**Estado:** ✅ **Completada y verificada** — 78 comprobaciones por HTTP y sobre
la base, y 61 en Chrome sobre el export real. Detalle en *Estado de verificación*.
**Depende de:** [03](fase-03-nucleo-oidc.md)
**Repo:** Tourniquet
**Requiere acción del usuario:** no (salvo los 5 criterios de navegador, abajo)
**Riesgo:** medio — es la primera superficie visible y la que más se toca
**Reversible:** sí, es frontend
**Spec normativo:** `specs/03-integracion-rhpro.md` §4, `specs/01` §4 (cookies),
`estetica-tourniquet.md`
**Mapa:** `specs/04-fases.md` Fase 01 (portal mínimo)
**Sin cambios de esquema:** ni una tabla, ni una columna, ni un índice nuevo. El
`detalle` de `aud_login` no tiene CHECK de valores, así que el código nuevo
`returnto_invalido` entra sin migración.

---

## Por qué esta fase va antes del registro demo

`specs/04` Fase 01 pide un portal que sea **sólo** pantalla de login y un callback que muestre el
token decodificado. No es el lanzador todavía: el lanzador necesita datos de registro (qué apps
existen, cuáles están habilitadas), y eso llega en la 05.

La secuencia importa por una razón práctica: hasta que el portal no se puede **usar a mano**, el
flujo OIDC de la 03 sólo se prueba con `curl`. Tener la pantalla de login funcionando permite
verificar el `authorize` con sesión real, que es donde aparecen los bugs de redirect y de estado
de sesión que `curl` no muestra.

También es la fase donde el tema gótico se pone a prueba por primera vez contra requisitos reales:
el login tiene que funcionar con el gestor de contraseñas, con lectores de pantalla y a las
contraste alto. `estetica-tourniquet.md` §7.1 es la lista de requisitos de esa pantalla.

---

## Objetivo

Pantalla de login que crea la sesión central y arranca el flujo `/oidc/authorize`, más una página
de callback técnica que muestre el access decodificado para inspección manual.

---

## Alcance

**Entra:**

- `frontend/src/app/login/page.tsx`: login con usuario y clave contra la API.
- Cookie de sesión del portal: `HttpOnly`, `Secure` (en prod), `SameSite=Lax`, vida 8 h
  (`specs/01` §3).
- `returnTo`: el login recuerda a qué `/oidc/authorize` venía el usuario y vuelve ahí.
- `frontend/src/app/dev/token/page.tsx`: **sólo en desarrollo**, muestra el access decodificado
  (payload legible, firma oculta).
- `frontend/src/design/`: los tokens de color, fuentes, ornamentos y componentes base de
  `estetica-tourniquet.md` §10 — pero en su **versión austera** (P3 en el README de esta carpeta):
  estructura y tokens listos, tema gótico completo en la 07.
- Manejo de errores de login: mensajes genéricos, estado `bloqueado` con hora, rate limit visible
  cuando salta.

**No entra:**

- La lista de apps / lanzador (Fase 07).
- Panel de administración (Fase 08).
- Consentimiento explícito: en esta fase el authorize no pide confirmación; la pantalla de
  consentimiento con su "rebanada" de datos llega en la 07.
- "Salir de todo" completo (Fase 07). Acá hay logout simple de la sesión del portal.

---

## Tareas

### 1. Helper de API del portal

Un único cliente HTTP en `frontend/src/lib/api.ts`:

- `credentials: 'include'` en **todo** (la cookie va en la sesión del portal).
- `cache: 'no-store'` en login y authorize: una respuesta con la sesión no se cachea en el
  navegador.
- Errores: normaliza a `{ codigo, mensaje }`. El backend responde con un **código** (`clave_incorrecta`,
  `bloqueado`, `rate_limit`, `credencial_desconocida`), y el front decide el texto. El backend nunca
  manda un mensaje pensado para mostrar al usuario directamente: los mensajes son código cerrado.

### 2. `POST /auth/login` (backend, en `src/auth/`)

- Valida DTO con `class-validator` (`ValidationPipe` global, `whitelist: true`).
- Verifica argon2id con bloqueo y rate limit (ya implementado en la 02).
- Crea `tok_sesion` con `idaplicacion = null` (sesión del portal, no de una app) — de ahí la
  columna que se agregó en la 03.
- Cookie: `tok_sesion_portal`, `HttpOnly`, `SameSite=Lax`, `Secure` si `TQ_ISSUER` es https,
  `Path=/`, `Max-Age=8h`. El **id de sesión va en la cookie**, no el token: el frontend no
  necesita ningún token para estar logueado en el portal, sólo para pedir un code.
- `aud_login` con `resultado` correspondiente.
- **No** devuelve el `idaplicacion` de una app: el portal no es una app.

### 3. `GET /auth/session` y `POST /auth/logout`

- `session`: devuelve `{ usuario, nombre, clienteActual }` desde la cookie, o 401. El front lo usa
  para decidir si pintar el login o redirigir.
- `logout`: cierra la sesión del portal y borra la cookie. **No** revoca las sesiones de apps: eso
  es `/oidc/logout` ("salir de todo"), que llega en la 07. Acá es "salir del portal".

### 4. `login/page.tsx`

Estructura y comportamiento (los detalles visuales van en `estetica-tourniquet.md`):

- Un solo campo de texto y uno de clave, con `<label>` visible en ambos.
- `autocomplete="username"` y `autocomplete="current-password"`, `name` e `id` correctos: el gestor
  de contraseñas tiene que reconocerlos.
- Botón con `aria-busy` durante la request; el formulario **no** se deshabilita.
- Mensaje de error en un `role="alert"` con texto plano, sin animación, sin revelar si el usuario
  existe.
- Estado `bloqueado`: "Tu cuenta está bloqueada hasta las HH:MM. Intentá de nuevo después."
- `returnTo` se preserva por el query string y se valida **en el backend**: sólo se acepta un
  `returnTo` que sea un path relativo que empiece por `/oidc/authorize`. Nada de URL absoluta
  (open redirect).
- Copypaste habilitado. Sin captcha.
- Debajo, en cuerpo chico: aviso de privacidad y a quién escribir si se bloqueó la cuenta. Sin
  eslogan, sin letra de canción, sin tips.

### 5. Login → authorize

Flujo completo, ya con sesión real (lo que `curl` no cubre):

```
GET /oidc/authorize?...  →  sin sesión ⇒ redirect a /login?returnTo=<encodeURIComponent(original)>
                        →  /login POST ok ⇒ redirect al authorize original
                        →  authorize con sesión ⇒ 302 a la app con code+state
```

El `returnTo` se compara con la URL completa, no por prefijo, para que un atacante no pueda
mandar `returnTo=/oidc/authorize?client_id=rhpro&redirect_uri=https://evil` y quedarse con el
resultado. Validación en el backend de `tq-api`, no en el front.

### 6. `dev/token/page.tsx`

Sólo si `NODE_ENV !== 'production'`; con build de producción, la ruta **no existe** (o devuelve
404). Muestra el payload del access decodificado en bloques `JetBrains Mono`, con `sub`, `aud`,
`tenant`, `sid`, `amr`, `exp` destacados y el resto en gris. La firma y el token completo no se
imprimen: mostrar un access completo en pantalla es una invitación a copiarlo.

Es una herramienta de inspección manual, coherente con "sin tests" del repo: reemplaza al test
automatizado que no se escribe, y sirve en la 06 para debuggear el guard dual de RHPro.

### 7. Tokens de diseño (versión austera)

`frontend/src/design/tokens.ts` con la paleta de `estetica-tourniquet.md` §4 completa, aunque sólo
se use el subconjunto austero. Los ornamentos y el set gótico (anillo, placa, costuras) se
implementan en la 07; acá sólo:

- La paleta, tipografías y escala de espaciado.
- `Campo`, `Boton`, `Lamina` (404/500) con los tokens.
- Verificación de contraste de los pares de §4.

Esto deja el portal coherente desde el día uno y hace que la 07 sea Pintar encima, no reformatear.

---

## Criterios de aceptación

- [x] Login OK con el admin del bootstrap ⇒ cookie de sesión HttpOnly, `SameSite=Lax`, `Secure` en
      https; `Max-Age` de 8 h.
- [x] La cookie **no** se puede leer desde JavaScript (`document.cookie` no la muestra) y no hay
      ningún access token en `localStorage` ni en `sessionStorage` (`AGENTS.md`: el access nunca
      en `localStorage`). *Medido en Chrome: `document.cookie` vacío y los dos almacenes sin una sola clave.*
- [x] Login con clave incorrecta: mismo mensaje que con usuario inexistente, sin revelar cuál de
      los dos falló; auditado como `claves`.
- [x] Tras 5 intentos: mensaje de bloqueo con hora local explícita; el correcto posterior también
      falla hasta que venza.
- [x] El gestor de contraseñas del navegador ofrece guardar la clave en Chrome y en Firefox.
      *En Chrome verificado entero. **Firefox no está instalado en la máquina donde corrió la
      verificación**: lo verificado son los prerrequisitos que el gestor inspecciona (los mismos
      que usa Firefox: un `<form>`, `autocomplete="username"`, `autocomplete="current-password"`,
      `name` correctos, `<label>` visible, sin `autocomplete="off"`, sin `readonly`, botón `submit`),
      pero la burbuja nativa de Firefox no se vio. Queda pendiente ese cuarto de verificación.*
- [x] El login funciona enter completo por teclado, con foco siempre visible, y `role="alert"` en
      el error se anuncia.
- [x] `returnTo` malicioso (`//evil.com`, `https://evil.com/oidc/authorize`, un
      `redirect_uri` ajeno) es rechazado: el backend devuelve 400 y el browser no sale del
      dominio.
- [x] Flujo navegador completo: login → authorize → 302 a la app registrada con `code` y `state`
      (probable con una app de prueba registrada, o observando el 302 en las devtools).
- [x] Logout del portal: cookie borrada, `tok_sesion.cerrada_en` con `motivo='logout'`.
- [x] `/dev/token` muestra el payload decodificado sin la firma ni el token completo; en build de
      producción la ruta devuelve 404.
- [x] axe-core sin `critical` ni `serious`; Lighthouse Accessibility ≥ 95 en `/login`.
- [x] Zoom 200 % y 360 px de ancho: sin scroll horizontal.
- [x] `npm run lint` y `npm run build` verdes en backend y frontend.

---

## Seguridad

| Invariante | Cómo se respeta |
|---|---|
| El access **no** va en `localStorage` | En esta fase el portal ni siquiera maneja access tokens: pide un code y redirige. El token vive en la cookie HttpOnly de la app, en el dominio de la app |
| Cookies `HttpOnly`+`Secure`+`SameSite=Lax` | En `POST /auth/login`; `Secure` condicionado a que `TQ_ISSUER` sea https (en dev, http) |
| Sin open redirect | `returnTo` validado **en backend**: path relativo que empiece por `/oidc/authorize` y que no empiece por `//` |
| Genérico en el error | Mensaje único usuario/clave; `detalle` de auditoría con código, no con el input |
| Sin secretos en el bundle | El front no tiene `TQ_MASTER_KEY` ni `DATABASE_URL`; sólo `NEXT_PUBLIC_API_URL` |
| La clave nunca se manda a un tercero | El POST va a `tq-api` en el mismo despliegue; nunca a la app que pidió el authorize |

## Trampas

1. **`SameSite=Lax` y el authorize.** El flujo empieza con un 302 **desde** la app al portal. Con
   `Lax` la cookie se manda en navegación de primer nivel (un GET de nivel superior), que es
   exactamente el caso del authorize. Con `Strict` no se mandaría y el usuario rebotaría al login
   en loop. **`Lax` no es un detalle de estilo acá: es un requisito del flujo.**
2. **`credentials: 'include'` + CORS.** Si el portal y `tq-api` están en orígenes distintos (dist
   inet), sin CORS con `origin` exacto y `credentials: true`, la cookie no viaja y el login
   "funciona" y al refresh de sesión da 401. `specs/01` §4: orígenes exactos, nunca `*`.
3. **Guardar `returnTo` completo y compararlo mal.** Un `startsWith('/oidc/authorize')` en el
   front es abrir un redirect a cualquier app registrada que se haya colado en el query. La
   comparación es del path normalizado, en el backend.
4. **El estado `bloqueado` filtrando existencia.** Mostrar "tu cuenta está bloqueada" sólo si el
   usuario existe es enumeración de cuentas. El mensaje de bloqueo se devuelve igual cuando el
   intento fue fallido y el contador cruzó el umbral, que es un dato que ya se sabe.
5. **Imprimir el access completo en `/dev/token`**: aunque sea una página de desarrollo, alguien la
   deja abierta en un escritorio con pantalla compartida. Sólo payload.

---

## Decisiones que tomó esta fase

Las cinco son cosas que el enunciado de la fase dejaba abiertas. Todas se
resolvieron **sin cambiar ningún spec normativo** y quedó escrito por qué acá,
que es donde se las vuelve a mirar.

### 1. El tema entra en el marco, no en la función

`estetica-tourniquet.md` §2 dice "la atmósfera va en fondo, marcos, ornamentos y
títulos; los controles son sobrios", y la P3 del `README` de esta carpeta
decía austero. Las dos cosas se cumplen a la vez: la estructura es austera y
los tokens del tema están puestos, pero **el tema vive en el marco** —anillo de
hierro en el wordmark, placa grabada como plano del formulario, filete
`oxblood` en el separador, `Cinzel` en el título— y **no** aparece en nada que
el usuario tenga que leer o escribir. Etiquetas, campos, botones y el mensaje de
error van en `Inter` sobre `tinta-alta`, sin textura y sin tipografía
decorativa.

De la letra de la canción no quedó nada en la UI, y del nombre del artista
tampoco: eso es §1.1, y es la línea que separa "gótico" de "propaganda". La
referencia se queda acá, en el spec.

### 2. `EB Garamond` es para los avisos, no para los mensajes

`estetica-tourniquet.md` §3 le asigna "texto de lectura, mensajes, ayudas". La
lectura de §3 que se aplicó es: **avisos fijos** (privacidad, a quién escribir
si te bloquean) en `EB Garamond`; **mensajes y controles** en `Inter`. La razón
es §2 regla 1 y §7.1: un mensaje de error se lee con prisa, a las 3 de la
mañana, en un puesto compartido. Ponerlo en una serif más ligera lo hace más
bonito y menos legible, y el mismo criterio que pone el tema en el marco pide
sacar el tema de la función.

### 3. El `tenant` se deduce; si no se puede, **se pregunta**

El login crea la sesión del portal, y esa sesión **es** el `tenant` de todo lo
que sale después. Un usuario con varias membresías tiene más de un tenant
posible. Implementado en este orden:

1. **El pedido trae `cliente`**: es lo que eligió en el selector, y manda
   primero. Se valida contra sus propias membresías, no contra `cat_cliente`:
   pedir un cliente del que no es miembro da `cliente_no_pertenece`, no una
   sesión.
2. **Una sola membresía activa** ⇒ no hay nada que elegir.
3. **Varias, y el `returnTo` trae un `client_id` cuya app pertenece a un único**
   cliente del que es miembro ⇒ ese cliente, sin preguntar nada.
4. **Varias y nada las desambigua** ⇒ `cliente_ambiguo` **con la lista de sus
   clientes**, y el portal muestra el selector.

> **Esto se corrigió durante la fase.** La primera versión era un 400 seco que
> decía "entrás desde la raíz", que remitía a un selector que no existía. Contra
> los datos reales —`admin` es miembro de los cuatro clientes y `rhpro` está
> provisionada en los cuatro— eso dejaba al **admin de la instalación sin poder
> entrar nunca**: la única cuenta que puede administrar el portal era
> justamente la que no podía usarlo. La razón por la que el caso 3 casi nunca
> resuelve es que la sembrada de desarrollo provisiona la misma app en todos los
> clientes; contra un despliegue real con una app por cliente, el 3 funciona y
> el selector no se ve nunca.

Dos decisiones de seguridad que vienen con el selector:

- **La lista del 400 son solo sus clientes.** La consulta sale del filtro de
  membresías, así que el 400 no revela la existencia de ningún otro cliente de
  la instalación (verificado: pidiendo la lista de un usuario de tres, no
  aparece un cuarto cliente del que no es miembro).
- **El `cliente` solo se acepta en el segundo intento**, después de que
  `IdentidadService` haya verificado la clave. Mandarlo en el primer POST
  permitiría elegir tenant sin haberse autenticado, y hacer probing de qué
  clientes existen ajenos.

El frontend conserva la clave en el estado del componente entre los dos POST
(que es lo que evita hacer que el usuario la retipee) y **no** la manda en el
primer intento ni la guarda en `localStorage`. Cuando la Fase 08 diseñe el
recupero de cuentas, esto debería ser un token de continuación de un solo uso en
vez de un segundo POST con la contraseña: reenviarla dos veces es aceptable
porque viaja por el mismo TLS y contra el mismo origen, pero es una repetición
que no hace falta.

### 4. `/dev/token` pega el token en vez de obtenerlo

El portal **no tiene ningún access token**: el access vive en la memoria de la
app y su refresh en una cookie `HttpOnly` del dominio de la app (`specs/01`
§4). No hay forma de que el portal lea uno, y agregar un endpoint de debug que
devuelva tokens sería peor que pegar. Así que la página **decodifica** lo que
se le pega: no verifica la firma (es trabajo de `ValidadorService` y de cada
app; decir "verificado" ahí sería mentir), no guarda nada, y no imprime ni el
token completo ni la firma.

### 5. `notFound()` no basta para que la ruta no exista

`/dev/token` es un Server Component que llama `notFound()` cuando
`NODE_ENV=production`, y además `frontend/scripts/quitar-rutas-dev.mjs` borra
`out/dev` después del build. Las dos cosas hacen falta: `notFound()` impide que
el formulario se escriba en el HTML, pero Next **igual deja el archivo**
`out/dev/token/index.html` con el cuerpo del 404 adentro, y un web server
estático responde 200 a un archivo que está. Sin el script, el criterio
"en build de producción la ruta devuelve 404" sería falso por un detalle del
hosting.

---

## Verificación de esta fase

**Por HTTP contra `tourniquet_dev`, 78 comprobaciones, todas verdes.** Lo que
cada una cubre está en los criterios de arriba marcados **[v]**. Los tres
grupos:

- **19** de `returnTo` hostil: `//evil.com`, `https://evil.com/...`,
  `http://localhost:3001.evil/...`, `/oidc/authorize-malicioso`, barra
  invertida, fragmento, `userinfo@host`, path con prefijo, y 3 KB de ruido. Todos
  400 `returnto_invalido` y auditados con `idusuario IS NULL`.
- **32** de flujo: cookie con los cinco atributos, `sid` que es UUID, ningún
  token en el cuerpo, authorize con sesión → 302 con `code` y `state`
  reflejado, authorize sin sesión → 302 al login con `returnTo`, login →
  authorize → token → `/userinfo`, logout idempotente, y logout de portal que
  **no** mata la sesión de la app.
- **27** de bloqueo y rate limit: 5 intentos → 423 con `bloqueado_hasta` a
  14.99 min, la clave correcta también falla mientras está bloqueado, un usuario
  inexistente no recibe `bloqueado_hasta`, y el exceso de cuota da 429 con
  `reintento_seg`.

**En la base**, sobre `tourniquet_dev`: 49 sesiones de portal con
`expira_en - creado_en = 28800 s` exactas, `amr = 'pwd'` en todas, ninguna
`cerrada_en < creado_en`, y el `logout` auditado con el `idusuario` real (esa
última verificación **falló en la primera pasada** y se corrigió: el
`AuthController` audtaba con `idusuario` nulo, y `specs/01` §7 pide el `sub`
real de la sesión).

`npm run verificar:oidc` de la Fase 03 sigue pasando entero, así que la
`AuthController` no rompió nada del núcleo OIDC.

### Segunda vuelta: 61 comprobaciones en Chrome

Se repitió lo que había quedado para un humano, **contra el export real servido
como estático** (no contra `next dev`, que sirve otra cosa) y con el Chrome del
sistema. Cada sección corre en un contexto de navegador nuevo: compartir el
contexto hacía que el login de una sección destruyera el contexto de ejecución de
la siguiente, y el fallo aparecía en la sección equivocada.

| Grupo | Qué midió | Resultado |
|---|---|---|
| Gestor de contraseñas | Los 9 prerrequisitos que Chrome inspecciona: un `<form>`, `autocomplete="username"`/`current-password`, `name` correctos, `<label>` visible, sin `autocomplete="off"`, sin `readonly`, botón `submit`, clave que se pinta oculta | 9/9 |
| Teclado | Orden del foco, foco visible en las 3 paradas (outline `brasa` 2 px + anillo `hueso`), Enter desde el campo de clave, la raíz no vuelve al formulario | 7/7 |
| Aviso de error | `role="alert"` + `aria-live`, texto sin "¡ERROR!", color `sangre` medido, foco que vuelve al campo y lo deja seleccionado, borde `sangre-honda` en los dos, una sola región de aviso, sin "te quedan N intentos", sin letra de la canción | 9/9 |
| Responsive | `/login`, `/` y 404 a 360 px, a 360 px con `dpr` 2 (zoom 200 %) y a 1280 px, más `Ctrl++` real: sin scroll horizontal en los 9 casos | 10/10 |
| Cookie y sesión | La cookie aparece con `HttpOnly`, `SameSite=Lax`, `Path=/`; `document.cookie` no la ve; `localStorage` y `sessionStorage` vacíos | 7/7 |
| `returnTo` malicioso | Los 3 payloads, en navegador: rechazados, **sin ninguna navegación fuera del origen**, y sin crear cookie | 9/9 |
| `/dev/token` | 404 real en el build de producción, la lámina del portal y no un error del servidor, sin el HTML del inspector | 3/3 |
| Logout | Parte de una sesión real, vuelve al login, cookie borrada | 3/3 |
| axe-core | `/login`, `/` y 404, contra `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa` y `best-practice` | **0 violaciones**, ni graves ni moderadas ni menores |
| `prefers-reduced-motion` | Ninguna animación corriendo con `reduce` | 1/1 |

**Lighthouse** (categoría accesibilidad, mismo export): `/login` **100**, raíz
**100**, lámina de 404 **100**. La lámina hay que medirla con un status 200
artificial porque Lighthouse **no audita una respuesta 404**: sin ese rodeo el
número es 0 y no distingue "la página no es accesible" de "Lighthouse no la miró".

**Lo que la corrida en navegador encontró y estaba mal** (los tres ya
corregidos y reverificados):

1. **`Campo` no reenviaba el `ref`.** `primerCampo.current?.focus()` era un
   no-op, y el foco se quedaba en el botón de ingresar después de un error. La
   causa es de React 18: `ref` es una prop **especial** que React intercepta
   antes de armar `props`, así que un componente de función que la declara en su
   tipo y la lee de `props` recibe siempre `undefined` — sin error de TypeScript
   y sin error de runtime, solo un aviso por consola. Se resolvió con
   `forwardRef`.
2. **El foco se lo quedaba la región del aviso.** `aria-live="assertive"` ya
   anuncia; además de ser redundante, obligaba al usuario a tabular de vuelta
   hasta el campo para reintentar. Ahora el foco va al primer campo, con el
   contenido seleccionado, y el `Enter` siguiente reenvía sin buscar el botón.
3. **Los campos no se ponían en rojo.** `estetica-tourniquet.md` §8 pide "el
   borde `sangre` y listo", y el login nunca pasaba el estado. Ahora `Campo` tiene
   un `invalido` aparte del `error`: los dos campos llevan `aria-invalid` y el
   borde `sangre-honda` (medido `rgb(194, 52, 60)`) pero **siguen compartiendo un
   solo mensaje**, que es lo que evita la enumeración de cuentas.

### Lo único que no se pudo verificar

**La burbuja del gestor de contraseñas de Firefox**: no hay Firefox instalado en
la máquina. Lo que se verificó son los prerrequisitos —los mismos que Firefox
inspecciona— y en Chrome se midió de verdad. Es lo único que queda de esta
fase, y es un cuarto de hora de humano con Firefox abierto.

### El selector de cliente, medido aparte

El selector no estaba en el alcance de la fase y entró a mitad de camino
porque la primera versión del login dejaba al admin sin poder entrar (ver
"Decisiones que tomó esta fase", punto 3). Se midió por separado, **16
comprobaciones en Chrome** contra el export real:

| Qué | Resultado |
|---|---|
| Primer POST sin elegir | 400 `cliente_ambiguo` con la lista de sus 3 clientes |
| La lista trae nombre **y** código, en botones | 3 botones, `Cerveceria Cervi / cervi`, `Jugos / jugos`, `Santander / santander` |
| No aparecen clientes ajenos | `marcelino` no está en la lista de un usuario que no es miembro |
| El botón "Ingresar" desaparece | el paso siguiente es elegir, no reenviar |
| El aviso es una **pregunta** | "Elegi con que cliente queres ingresar", no un error |
| Los campos **no** se ponen en rojo | borde `plata/60`: la clave era correcta, no hay nada que corregir |
| El foco va al primer botón de cliente | no obliga a tabular hasta algo que ya respondió |
| El campo de usuario conserva lo tipeado | y con él la clave, en el estado del componente: no se retipea |
| Segundo POST con el cliente elegido | 200, y la sesión queda en ese tenant |
| La raíz nombra al cliente elegido | "Sesión abierta como Prueba Cervi **para Jugos**" |
| Con un solo cliente | un solo POST, sin selector |

Por HTTP, 14 comprobaciones más: la lista sale del filtro de membresías, pedir
un cliente del que no es miembro da 403 `cliente_no_pertenece` sin cookie, el
código es **exacto** (`CERVI` en mayúsculas no se normaliza), `cliente` con
clave mala sigue dando `clave_incorrecta` **sin** devolver la lista, y un
`cliente` de 50 caracteres es 400 de DTO.

La batería completa de la fase se volvió a correr después del cambio:
**61/61 en verde**, axe-core con 0 violaciones en las tres pantallas.

### Cierre

Al cerrar la fase, `tourniquet_dev` quedó sin los fixtures de verificación
(`f04.navegador`, `admin.f04`, `prueba.cervi`) y sin ninguna fila colgando:
0 sesiones, 0 auditoría, 0 membresías y 0 habilitaciones huérfanas, 4 clientes,
1 clave de firma activa. El usuario `admin` conserva intactas sus 138 filas de
auditoría. El orden de borrado y por qué hay que hacerlo a mano están en
`deploy/README.md`.

Se necesitan dos cosas para repetir la corrida: `CORS_ORIGIN=http://localhost:3002`
en el `.env` de la raíz (sin eso la cookie no viaja y el login "funciona" pero al
refrescar da 401 — trampa 2), y `NEXT_PUBLIC_API_URL` en `frontend/.env` o en el
entorno del build, porque **`next build` ahora corta si falta** (§`next.config.js`):
en un export estático la URL queda incrustada en el bundle y sin eso el portal
desplegado apuntaría a la `localhost` de cada usuario.

---

## Deuda que esta fase deja anotada

1. **El oráculo de enumeración en el estado de bloqueo** (trampa 4 de esta
   fase, a medias). `identidad.service.ts` responde `bloqueado` **solo** si la
   fila existe, porque un usuario inexistente nunca incrementa
   `intentos_fallidos` — no hay fila que incrementar. O sea que "tu cuenta está
   bloqueada hasta las 15:31" confirma que la cuenta existe. El código heredó
   esa decisión de la Fase 02, que la documenta como aceptada (el mismo
   argumento sostiene `inactivo`), y esta fase no la rediseñó porque hacerlo es
   un cambio de diseño que va primero al spec. **Va a la Fase 09** con
   `auth/identidad.service.ts`, donde ya se tocan los umbrales.

2. **`frontend/pnpm-lock.yaml` está muerto.** El repo es un workspace de npm
   (`package-lock.json` en la raíz, `npm run lint --workspaces`) y ese archivo
   es de la Fase 01. No molesta, pero miente: si alguien corre `pnpm install`
   desincroniza el árbol. Se deja para que lo borre quien lo decida, porque
   borrar un lockfile no es una decisión de una fase.

3. **El presupuesto de fuentes de `estetica-tourniquet.md` §9.10 no se cumple
   como está escrito.** Pide "< 40 KB por peso usado (subconjunto latino)" y
   `next/font/google` emite `latin` **y** `latin-ext` por peso, sin forma de
   bajar `latin-ext`. Medido: `UnifrakturMaguntia` 22 KB, `Cinzel` 25 KB el
   mayor peso, `Inter` 83 KB (es variable: un archivo cubre todos los grosores,
   así que "por peso" no le aplica), 492 KB el total de las cinco familias. Los
   pesos se bajaron a los que se usan y no hay `preload` (que era donde se
   gastaba la mayor parte), pero el criterio necesita corregirse: o pasa a
   "subconjunto latino + latin-ext", o la 07 pasa a `next/font/local` con woff2
   previamente recortados.

4. **`verdigris` en la tabla de contraste de §4 estaba mal medido** y se
   corrigió **antes** de escribir el código (ver el bloque de nota al principio
   de esa sección). Decía 5.3:1 y daba 4.35:1. Junto con `sangre`, que decía
   5.9:1 y daba 3.63:1 — y ese no pasaba AA para texto normal, o sea que **el
   mensaje de error del login habría fallado el criterio de axe-core**. La tabla
   de §4 se recalculó entera y ahora la fuente de verdad es
   `frontend/src/design/contraste.ts`, que se puede volver a correr.

5. **El botón primario no se veía.** `bg-tinta-alta` sobre la página `tinta` da
   1.06:1, así que el borde es lo único que dibuja el control, y llevaba
   `oxblood` a 1.70:1 sobre su propio fondo. SC 1.4.11 pide 3:1 para el borde de
   un control. Ahora los tres bordes van en `plata/60` (4.83:1) y la jerarquía
   primario/secundario pasó al **relleno**, que es donde se puede gastar sin
   perder contraste. La regla nueva quedó escrita en §4, para que la 07 no lo
   repita.

6. **La raíz llevaba un enlace a una página que no existe en producción.**
   "Inspeccionar token" apuntaba a `/dev/token`, que `notFound()` borra del
   export y `quitar-rutas-dev.mjs` elimina del disco. El enlace se inyectaba al
   hidratar, así que tampoco se veía en el HTML y una revisión del HTML
   exportado no lo delata: aparecía en producción y llevaba a un 404. Ahora va
   con `process.env.NODE_ENV !== 'production'`, que Next resuelve en build y
   elimina por *dead-code elimination* (verificado: la cadena `dev/token` ya no
   aparece en ningún chunk del export).

7. **La semilla pisa los nombres reales de los clientes.** No es un defecto de
   esta fase, pero se encontró acá: `90-semilla-catalogo.sql` hace `UPDATE` del
   `nombre` de todo cliente existente, así que un `npm run sql:dev` de rutina
   devolvió `RRHH Cervi` a `Cerveceria Cervi`. **Decisión del 2026-09-29: se
   deja como está** —la semilla sigue siendo la fuente de la verdad del
   catálogo y el nombre real de un cliente se carga por SQL propio al instalarlo
   — y el riesgo quedó anotado en el propio `.sql` y en `deploy/README.md`, con
   la indicación de que el arreglo (sacar el `UPDATE`) es una decisión de una
   sola línea si alguna vez molesta. Dos fuentes de verdad para la misma columna
   es peor que una.

