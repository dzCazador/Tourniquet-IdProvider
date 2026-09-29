# Fase 08 — Panel `admin_identidad` por cliente

**Estado:** ⬜ Pendiente
**Depende de:** [07](fase-07-portal-lanzador.md)
**Repo:** Tourniquet
**Requiere acción del usuario:** no
**Riesgo:** medio — es la primera superficie que escribe datos de identidad desde la UI
**Reversible:** parcial: los cambios se pueden deshacer a mano, pero no hay rollback de UI
**Spec normativo:** `specs/02-base-de-datos.md` §3, `specs/01` §7, `estetica-tourniquet.md` §2
**Mapa:** `specs/04-fases.md` Fase 03 (mitad derecha)

---

## Por qué esta fase va después del lanzador y no antes

El panel existe para administrar **accesos de un cliente concreto**, y para hacerlo bien necesita
que el modelo de membresías, sesiones y apps ya esté en uso. Además, si el panel se construye
antes del lanzador, cada pantalla del admin inventa su propio patrón de autorización y después
hay que revisarlas todas.

La diferencia con el panel de RHPro es el motivo de ser: acá **no** hay administración de negocio.
No hay perfiles, no hay permisos, no hay `menumstr`, no hay liquidación. Hay exactamente tres
cosas: **quién existe**, **a qué cliente pertenece** y **a qué apps entra**. Si aparece una
columna de permiso de negocio en este panel, es un defecto (D2 de `specs/00`).

---

## Objetivo

Que un `admin_identidad` de un cliente pueda dar de alta usuarios, habilitar apps y cerrar sesiones
de su tenant, sin ver ni tocar nada de los otros tenants.

---

## Alcance

**Entra:**

- Layout de admin con selector de cliente **fijo al tenant del admin** (un admin de `cervi` no
  tiene selector: sólo administra `cervi`).
- `POST /admin/usuarios`: alta en `idn_usuario` + `idn_usuario_cliente` + opcionalmente
  `idn_usuario_cliente_aplicacion`.
- `PATCH /admin/usuarios/:id`: nombre, apellido, email, `estado` (`activo|inactivo`). **No** cambia
  el `usuario` (el login) ni el `clave_hash` desde acá.
- `POST /admin/usuarios/:id/habilitar` y `/deshabilitar`: alta/baja en
  `idn_usuario_cliente_aplicacion`.
- `GET /admin/usuarios`: listado del tenant con búsqueda por usuario/nombre, paginado.
- `POST /admin/usuarios/:id/reset-clave`: genera clave temporal y la **entrega una sola vez** por
  pantalla (o envía el alta por el canal que el cliente defina; ver Trampa 3).
- `GET /admin/sesiones` + `DELETE /admin/sesiones/:sid`: sesiones de los usuarios del tenant, con
  cierre forzado y **motivo obligatorio**.
- `GET /admin/auditoria`: lectura de `aud_login` del tenant, filtros por usuario, resultado y
  rango de fechas.
- Tema gótico en **nivel medio** (`estetica-tourniquet.md` §2): marcos, sellos y separadores; tablas
  y formularios sobrios.

**No entra:**

- Permisos de negocio, perfiles, roles finos. `rol` es `user|admin_identidad` y nada más.
- Alta de apps, clientes o bases desde la UI: son cambios de deploy (`specs/03` §5).
- Cambio de contraseña por el propio usuario (fuera de `specs/01`; fase propia si se pide).
- Borrar usuarios: se desactivan (`estado='inactivo'`). Borrar es irreversible y deja auditoría
  colgada de `idusuario`; el IdP no borra identidades.

---

## Tareas

### 1. Módulo `registro-api/` y el guard de administración

```
backend/src/registro-api/
├── admin.guard.ts           // exige rol admin_identidad del tenant
├── admin.controller.ts
├── admin.usuarios.service.ts
├── admin.sesiones.service.ts
├── admin.auditoria.service.ts
└── dto/                     // class-validator, whitelist: true
```

`AdminGuard` con la regla única, sin excepciones:

1. Usuario autenticado (cookie de sesión del portal) → `idn_usuario_cliente` con `rol='admin_identidad'`
   y `cat_cliente.estado='activo'`.
2. El `codigo` de cliente del request (path, body o query) tiene que ser **uno de esos clientes**.
   Si no aparece en la lista ⇒ 403.
3. **Todas** las queries del servicio llevan `WHERE idcliente = <tenant del admin>`. El filtro va
   en el `where` del Prisma, no en un `if` de JavaScript: un `if` se puede olvidar en el próximo
   método que se escriba.

El punto 3 es la invariante D2+tenant de `AGENTS.md` aplicada a la escritura. Un método de
servicio sin filtro de tenant se considera defecto de review, igual que una columna de permiso de
negocio.

### 2. Alta de usuario

`POST /admin/usuarios`:

```json
{ "usuario": "jperez", "nombre": "Juan", "apellido": "Pérez", "email": "jperez@ejemplo.com",
  "aplicaciones": ["rhpro"], "claveTemporal": true }
```

- `usuario` se normaliza a minúsculas (único global, `specs/02` §3). Conflicto con otro cliente ⇒
  la fila de `idn_usuario` es **compartida**: no se crea un usuario nuevo, se agrega la
  membresía. Es el comportamiento correcto para "un solo logueo" (D6), y hay que hacerlo explícito
  en la UI: "este usuario ya existe en el sistema; se agregó a tu cliente".
- `clave_hash` = argon2id de una clave temporal generada por el servidor (o la que el admin
  escriba, si el cliente lo pide). Nunca se manda una clave en claro desde el browser al alta por
  formulario: el servidor la genera y la entrega una vez.
- `aud_login` con `detalle='alta_usuario'` y el `sub` del admin.

### 3. Reset de clave

Generar 20 caracteres aleatorios (alfanumérico sin caracteres ambiguos), argon2id, e **mostrarla
una sola vez** con un aviso explícito de que no se vuelve a ver. Copypaste habilitado (Trampa 3).
Cada reset deja auditoría con el `sub` del admin.

### 4. Listados

Paginados con límite duro (100 por página). La búsqueda por texto va a `usuario`, `nombre` y
`apellido` con `contains` de Prisma, escapando los wildcards de SQL. La lista devuelve **sólo** del
tenant activo del admin.

Datos por usuario en la lista: `usuario`, `nombre`, `apellido`, `email`, `estado`, apps
habilitadas (códigos), última sesión (`max(creado_en)` de `tok_sesion` abierta). **No** el
`clave_hash`, **no** el `mfa_secret_cifrada`, **no** el `intentos_fallidos` (que es información de
ataque).

### 5. Cierre forzado de sesión

`DELETE /admin/sesiones/:sid` con `motivo` **obligatorio** (enum de 4-5 valores: `soporte`,
`sospecha`, `reemplazo`, `solicitud_del_usuario`, `otro`). El motivo va a
`tok_sesion.motivo_cierre` y a `aud_login.detalle`, junto al `sub` del admin. Sin motivo, la
API devuelve 400: un cierre de sesión sin explicación es indistinguible de un abuso.

El admin puede cerrar sesiones **de su tenant**. Un `sid` de otro tenant ⇒ 404, por el mismo
criterio que en la 07.

### 6. Lectura de auditoría

`GET /admin/auditoria` con filtros y paginación. Escopado por `idusuario IN (miembros de mi
tenant)`: la auditoría global del IdP **no** se le enseña a un admin de cliente, porque contiene
intentos de login de usuarios de otros clientes, con sus IPs. Esa es una travesía entre tenants
por diseño de la consulta, y por eso el filtro es por membresía, no por cliente del evento.

Columnas: `ts` (hora local), usuario (o "—" si no existió), `idaplicacion`, `ip`, `user_agent`
resumido, `resultado`, `detalle`. El `detalle` es un código corto, no un volcado.

`user_agent` crudo es largo y feo: se muestra "Chrome 120 / Windows" con un parser mínimo del
propio portal, no la cadena entera. Guardar el crudo sirve para diagnóstico.

### 7. Front del admin

```
frontend/src/app/admin/
├── layout.tsx          // marco de tema medio, selector de cliente si N
├── page.tsx            // dashboard: usuarios, sesiones activas, últimos eventos
├── usuarios/page.tsx
├── usuarios/[id]/page.tsx
├── sesiones/page.tsx
└── auditoria/page.tsx
```

- Tema **medio**: header con grabados y sello, separadores `—✦—`, tabs sobrias. Tablas de datos
  limpias, tipografía Inter, sin textura. (`estetica-tourniquet.md` §2, nivel de tema "bajo" en
  datos.)
- Toda escritura con confirmación cuando es destructiva (deshabilitar usuario, cerrar sesión, reset
  de clave). El diálogo de confirmación **sí** es del tema: lámina con el anillo, texto claro, dos
  botones.
- Formularios: los mismos componentes `Campo`/`Boton` del login, con los contrastes de §4. Un
  panel de administración con inputs ilegibles es la peor combinación posible.

---

## Criterios de aceptación

- [ ] Un `admin_identidad` de `cervi` no ve ningún cliente, usuario, sesión ni evento de otro
      tenant: ni en listados, ni en el endpoint de detalle, ni en el conteo del dashboard.
- [ ] Un `user` (no admin) que pegue a `/admin/*` recibe 403 en **todas** las rutas, no sólo en la
      navegación.
- [ ] `GET /admin/usuarios` de un tenant no incluye usuarios de otro ni usuarios sin membresía en
      ese tenant.
- [ ] Alta de usuario que ya existe en otro cliente: reutiliza la fila de `idn_usuario`, agrega la
      membresía, y **no** pisa nombre/apellido/email sin que el admin lo confirme explícitamente.
- [ ] El alta muestra la clave temporal **una sola vez**; un refresh no la vuelve a mostrar.
- [ ] Habilitar una app: el usuario puede entrar a esa app en el siguiente login. Deshabilitarla:
      el authorize falla aunque tenga token vivo (criterio de `specs/04` Fase 03).
- [ ] Desactivar un usuario (`estado='inactivo'`): su login falla con mensaje genérico y sus
      sesiones se cierran en cascada.
- [ ] Cierre forzado de sesión sin `motivo` ⇒ 400. Con motivo ⇒ la sesión muere, y en
      `aud_login` queda el `sub` del admin, el `sid` y el motivo.
- [ ] `DELETE /admin/sesiones/:sid` de otro tenant ⇒ 404.
- [ ] `GET /admin/auditoria` de un admin de `cervi` **no** devuelve eventos de usuarios de otros
      tenants (probado con un login fallido de un usuario de otro cliente: no aparece).
- [ ] En el listado de usuarios no aparece `clave_hash`, `mfa_secret_cifrada` ni
      `intentos_fallidos` (verificado mirando el JSON de la respuesta, no la pantalla).
- [ ] Todas las acciones de escritura dejaron fila en `aud_login` con el `sub` real del admin
      (nunca "sistema").
- [ ] Panel usable a 360 px y con zoom 200 %; tablas con scroll horizontal **dentro de la tabla**,
      no de la página.
- [ ] axe sin `critical`/`serious`; contraste AA en todos los estados de los controles.
- [ ] `npm run lint` y `npm run build` verdes.

---

## Seguridad

| Invariante | Aplicación |
|---|---|
| `tenant` siempre del token/sesión | El admin opera sobre un tenant fijo derivado de su membresía. Un `?cliente=` en la URL **no** cambia el alcance: `AdminGuard` compara contra la lista de clientes del admin |
| Filtro de tenant en el `where`, no en un `if` | Regla de review: todo método de `admin.*.service.ts` con `where: { idcliente }` |
| Sin enumeración de existencia | `sid` o usuario ajeno ⇒ 404, no 403 |
| Escritura siempre auditada con `sub` real | `aud_login.detalle` con código de operación + `idusuario` del admin |
| Nada de secretos en las respuestas | Ni `clave_hash`, ni `mfa_secret_cifrada`, ni `intentos_fallidos`, ni credenciales de bases |
| No borrar identidades | Sólo `estado='inactivo'`. `idn_usuario` y `aud_login` no tienen endpoint de borrado |
| Contraseña temporal de un solo uso | Se muestra una vez, se pide cambio... (no hay cambio de contraseña por el usuario: la siguiente clave la fija otro reset del admin) |

## Trampas

1. **Auditoría global expuesta al admin de cliente.** Es la travesía más fácil de colar en este
   panel: `GET /admin/auditoria` sin filtro devuelve los intentos de login de **todos** los tenants
   del IdP, con IP y user agent. El filtro obligatorio es por `idusuario IN (mis miembros)`, y la
   prueba de aceptación es explícita: un login fallido de otro tenant **no** aparece.
2. **`intentos_fallidos` y `bloqueado_hasta` en la ficha de usuario.** Muestran el estado del lockout
   a quien puede estar probando contraseñas de esa cuenta. No se exponen.
3. **La clave temporal en el POST.** Mandar la clave desde el browser al backend la deja en el
   historial de red del proxy y en el body de cualquier log del servidor intermedio. El servidor
   la genera; el admin la recibe. Copypaste sí, porque un admin que reescribe 20 caracteres a mano
   la manda por chat a un usuario, que es peor.
4. **Cerrar sesión de otro usuario por URL adivinada.** El `sid` es un UUID v4, así que adivinarlo
   no es el vector; el defecto es que el servicio no filtre por tenant. La prueba de
   aceptación con un `sid` de otro tenant es la que lo detecta.
5. **Deshabilitar una app y esperar.** La fila borrada de `idn_usuario_cliente_aplicacion` impide el
   **nuevo** authorize, pero el token de portal ya emitido sigue siendo válido 15 minutos. La UI
   del panel tiene que decirlo ("puede tardar hasta 15 minutos en surtir efecto"), o el admin
   cree que falló. La opción fuerte es cerrar las sesiones del usuario en esa app, que es un botón
   al lado.
6. **Confirmaciones que no se leen.** El diálogo de "deshabilitar usuario" con el tema fuerte puede
   terminar siendo un click sin leer. Los botones destructivos llevan texto explícito
   ("Deshabilitar el acceso de Juan Pérez a RHPro"), no sólo "Confirmar".
