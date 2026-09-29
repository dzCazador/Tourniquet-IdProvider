# Fase 07 — Portal lanzador: membresías, lista de apps y el tema gótico

**Estado:** ⬜ Pendiente
**Depende de:** [06](fase-06-rhpro-dual-guard.md)
**Repo:** Tourniquet
**Requiere acción del usuario:** no
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
| `GET /me/apps` | Apps habilitadas del cliente activo | `idn_usuario_cliente_aplicacion` ∩ `cat_cliente_aplicacion` ∩ `cat_aplicacion.estado='activo'` |
| `POST /me/cliente-activo` | Cambia el cliente activo de la sesión | El cliente activo va en la cookie de sesión, firmado |
| `GET /me/sesiones` | Sesiones activas del usuario con app, IP truncada, `creado_en` | Sólo las del usuario de la cookie |
| `DELETE /me/sesiones/:sid` | Cierra una sesión propia | `:sid` tiene que ser **de ese usuario**: si no, 404 (no 403: no se confirma existencia) |
| `POST /auth/logout-all` | "Salir de todo" | Cierra todas las sesiones del usuario en el cliente |

**El cliente activo en la cookie, no en un parámetro de query.** Si el cliente se eligiera por
`?cliente=otro`, cualquier endpoint que lo lea acepta que el cliente lo elija el request. Al
firmarlo en la cookie, la fuente es la sesión.

`DELETE /me/sesiones/:sid` con un `sid` ajeno devuelve **404**, no 403: un 403 confirma que ese
`sid` existe. Es el mismo criterio que el resto de la API.

### 2. Deep-link al authorize

Cada tarjeta de app apunta a:

```
/apps/[codigo]  →  pantalla de puerta (client-side)
                  →  GET /oidc/authorize?client_id=<codigo>
                     &redirect_uri=<el de la app, desde cat_aplicacion>
                     &state=<nonce en sesión>
                     &scope=openid profile
                     &code_challenge=<S256 de un verifier nuevo>
```

**El `redirect_uri` lo lee el backend de `tq-api` de `cat_aplicacion`**, no el front. Si el portal
lo tomara del query, un atacante podría hacer que el portal autorice para una app con un
`redirect_uri` que el IdP no tiene registrado... que además fallaría, pero el error se vuelve
confuso. La fuente única es la tabla.

El `code_challenge` se genera en el navegador con un `code_verifier` aleatorio de 32+ bytes: el
portal es un cliente público, y el verifier **nunca** se envía en el authorize (sólo su hash).

### 3. Pantalla de puerta `/apps/[codigo]`

Antes de redirigir al authorize, una pantalla con:

- El nombre de la app (de `cat_aplicacion.nombre`).
- El cliente y la base a la que se entra (`cat_base_datos` activa: "base de la que va a leer los
  datos" en lenguaje llano, sin credenciales).
- Cuenta regresiva de 5 s y botón "Entrar ahora".
- Un link para **volver** al lanzador sin entrar.

Existe por un motivo concreto: los deep-links a un IdP se abren en pestaña nueva o en la misma, y
el usuario necesita ver a dónde va antes de que su identidad salga del portal. Sin esta pantalla,
el 302 al authorize se siente como un salto del portal a un tercero sin explicación.

### 4. Consentimiento con la "rebanada"

Título: "Aceptás el ingreso de **{app}**". Debajo, 3-4 renglones de **hechos**, no de promesas:

- Quién es la app (nombre y `codigo`).
- Qué recibe: tu nombre de usuario y tu identificador.
- Qué **no** recibe: tus contraseñas, tus permisos de negocio, los datos de otras apps.
- Que el ingreso dura hasta que cierres sesión o que alguien la cierre.

Botón "Entrar" / "Cancelar". `state` y PKCE ya vienen del paso anterior.

Es la pantalla que corresponde a la línea *"you never ever believed in me"*: el portal no pide
fe, muestra los hechos. Y evita la sorpresa de "mi sesión de RHPro dice que tengo permisos de RRHH
que no pedí".

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
| `design/fonts.ts` | `next/font` con `UnifrakturMaguntia`, `Cinzel`, `EB Garamond`, `Inter`, `JetBrains Mono`, todas con `display: 'swap'` y `preload` de las que se usan |
| `design/ornaments/*.tsx` | Los 7 ornamentos: Anillo, Placa, Costura, Malla, Grano, Sello, Mancha |
| `design/motion.ts` | Duraciones y curvas + guard de `prefers-reduced-motion` |
| `design/components/PlacaApp.tsx` | Tarjeta de app: placa grabada, anillo, estado |
| `design/components/Lamina.tsx` | Lámina de 404/500 |
| `app/apps/page.tsx`, `app/apps/[codigo]/page.tsx` | Las vistas con marco de tema alto/medio |
| `app/consentimiento/page.tsx` | Consentimiento: marco alto, contenido sobrio |

Presupuesto de la §9: < 60 KB de ornamentos, fuentes del subconjunto latino, cero requests a
terceros, cero PNG/JPG.

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

Los de `specs/04` Fase 03, más los de la estética:

- [ ] Usuario con una membresía: el lanzador no muestra selector de cliente.
- [ ] Usuario con dos membresías: selector visible; cambiar de cliente **cambia la lista de apps**
      y todas las llamadas posteriores usan el cliente de la cookie, no un parámetro.
- [ ] La lista de apps sale de `idn_usuario_cliente_aplicacion`: un usuario con membresía pero sin
      habilitación ve la lista vacía, no un error.
- [ ] Deep-link: clic en la tarjeta ⇒ pantalla de puerta ⇒ 5 s ⇒ authorize ⇒ callback de la app ⇒
      sesión iniciada. El `redirect_uri` que sale en la barra de direcciones es el registrado.
- [ ] Botón "Entrar ahora" saltea la cuenta regresiva y hace lo mismo.
- [ ] Consentimiento: la pantalla lista qué recibe y qué no recibe la app. Cancelar vuelve al
      lanzador sin crear sesión de la app.
- [ ] **Prueba manual de travesía (la de `specs/04` Fase 03)**: usuario `cervi` y usuario de otro
      cliente, lado a lado. Ninguna pantalla del `cervi` muestra nada del otro: ni apps, ni
      sesiones, ni nombres de cliente. Se documenta en la fase, con las pantallas y los pasos
      exactos de la prueba.
- [ ] **Deshabilitar una app en el registro** (`idn_usuario_cliente_aplicacion` borrada, o
      `cat_aplicacion.estado='inactivo'`) ⇒ el authorize de esa app falla aunque el usuario tenga
      token vivo del portal. Es el criterio que demuestra que la habilitación no es decorativa.
- [ ] "Mis sesiones activas" lista las del usuario con app y hora; cerrar una sesión la deja
      inutilizable (su refresh falla en el siguiente uso).
- [ ] `DELETE /me/sesiones/:sid` con un `sid` de otro usuario ⇒ **404**, y el `sid` sigue vivo.
- [ ] Toda acción de admin... *(esta parte es de la Fase 08; acá:)* cerrar una sesión propia queda
      en `aud_login` con el `sub` del que la cerró.
- [ ] "Salir de todo": después, ninguna app del cliente acepta el token del usuario; entrar de
      nuevo requiere login.
- [ ] Estética: los 10 criterios de `estetica-tourniquet.md` §9 verificados.
- [ ] `npm run lint` y `npm run build` verdes; el export estático no supera 1 MB de HTML por
      página.
- [ ] Con `prefers-reduced-motion`, no hay animaciones (criterio 5 de la estética).
- [ ] El portal sigue funcionando **sin** cookie de terceros: ni analytics, ni fuentes remotas, ni
      CDN. Un `grep` de `fetch(` en el front sólo muestra llamadas a `tq-api` y al authorize.

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

1. **El selector de cliente con la sesión en cookie compartida.** Si el cliente activo va en la
   cookie y el usuario tiene dos pestañas de apps distintas, un cambio en una pestaña afecta a la
   otra. Solución: el cliente activo **no** va en la cookie del portal sino en la sesión por app
   (`tok_sesion`), y el selector elige para la navegación siguiente. Verificar con dos pestañas
   abiertas.
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
