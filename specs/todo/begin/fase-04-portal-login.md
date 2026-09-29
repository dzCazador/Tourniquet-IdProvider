# Fase 04 — Portal: login, tema gótico y callback decodificado

**Estado:** ⬜ Pendiente
**Depende de:** [03](fase-03-nucleo-oidc.md)
**Repo:** Tourniquet
**Requiere acción del usuario:** no
**Riesgo:** medio — es la primera superficie visible y la que más se toca
**Reversible:** sí, es frontend
**Spec normativo:** `specs/03-integracion-rhpro.md` §4, `specs/01` §4 (cookies),
`estetica-tourniquet.md`
**Mapa:** `specs/04-fases.md` Fase 01 (portal mínimo)

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

- [ ] Login OK con el admin del bootstrap ⇒ cookie de sesión HttpOnly, `SameSite=Lax`, `Secure` en
      https; `Max-Age` de 8 h.
- [ ] La cookie **no** se puede leer desde JavaScript (`document.cookie` no la muestra) y no hay
      ningún access token en `localStorage` ni en `sessionStorage` (`AGENTS.md`: el access nunca
      en `localStorage`).
- [ ] Login con clave incorrecta: mismo mensaje que con usuario inexistente, sin revelar cuál de
      los dos falló; auditado como `claves`.
- [ ] Tras 5 intentos: mensaje de bloqueo con hora local explícita; el correcto posterior también
      falla hasta que venza.
- [ ] El gestor de contraseñas del navegador ofrece guardar la clave en Chrome y en Firefox.
- [ ] El login funciona enter completo por teclado, con foco siempre visible, y `role="alert"` en
      el error se anuncia.
- [ ] `returnTo` malicioso (`//evil.com`, `https://evil.com/oidc/authorize`, un
      `redirect_uri` ajeno) es rechazado: el backend devuelve 400 y el browser no sale del
      dominio.
- [ ] Flujo navegador completo: login → authorize → 302 a la app registrada con `code` y `state`
      (probable con una app de prueba registrada, o observando el 302 en las devtools).
- [ ] Logout del portal: cookie borrada, `tok_sesion.cerrada_en` con `motivo='logout'`.
- [ ] `/dev/token` muestra el payload decodificado sin la firma ni el token completo; en build de
      producción la ruta devuelve 404.
- [ ] axe-core sin `critical` ni `serious`; Lighthouse Accessibility ≥ 95 en `/login`.
- [ ] Zoom 200 % y 360 px de ancho: sin scroll horizontal.
- [ ] `npm run lint` y `npm run build` verdes en backend y frontend.

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
