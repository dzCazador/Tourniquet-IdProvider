# 04 — Fases y criterios de aceptación

Roadmap del **diseño a la producción**. Sin automatización de tests (regla del repo): cada fase
se verifica a mano con la lista de criterios, que es parte del spec. Ningún criterio de
aceptación admite "lo probé y anduvo" sin registrar: se marca en la fila de la fase.

> **Plan de ejecución detallado:** `specs/todo/begin/`. Descompone estas fases madre en unidades de
> trabajo ejecutables de a una (00–11), con tareas, SQL exactos, criterios y trampas. Ahí vive
> también `estetica-tourniquet.md`, el sistema de diseño del portal.

## Fase 00 — (Repo RHPro) Login local real contra `user_per`

Prerrequisito no negociable: Tourniquet necesita un fallback local honesto (D5 `specs/00`).

- Reemplazar el estático `AUTH_USERNAME`/`AUTH_PASSWORD` por validación contra `user_per` de la
  base activa, con hash fuerte y política de bloqueo local.
- Conservar el contrato de `UserSession`/`auth-context.tsx` para no tocar pantallas.
- **Aceptación**: login/logout funcionando con usuarios reales de `rhpro_marcelino`; bloqueo por
  intentos; lint verde; el `perfil` sigue resolviéndose contra `perf_usr` de la base.

## Fase 01 — Tourniquet mínimo (IdP usable por consola)

Scaffold del repo (`backend/` Nest + `frontend/` portal Next vacío) y núcleo de identidad.

- `deploy/sql/01-*.sql`: tablas `cat_*` / `idn_*` / `tok_*` / `aud_*` de `specs/02` + índices. `scripts/ejecutar-sql-dev.mjs`
  con guardia a `tourniquet_dev`.
- argon2id + `scripts/bootstrap-admin.mjs`.
- Discovery, JWKS, `/oidc/authorize`, `/oidc/token` (code+PKCE), `/oidc/revoke`, `/oidc/logout`.
- `tok_clave_firma` con AES-GCM + `TQ_MASTER_KEY`; generación de par RSA al bootstrap.
- Auditoría `aud_login` escribiendo en todos los resultados.
- Portal: **sólo** pantalla de login + callback mínimo que muestre el token decodificado (no es
  el lanzador todavía).
- **Aceptación**: un `curl`-driven authorize→token→userinfo emite `access` con `sub`, `aud`,
  `tenant`, `sid` correctos; code usado 2 veces ⇒ `invalid_grant` + evento en auditoría; refresh
  reusado ⇒ revocación de la familia; logout mata la sesión y el siguiente refresh falla; JWKS
  muestra el `kid` activo; `npm run lint` verde en ambos proyectos; la base de control recreable
  de cero sólo con `deploy/sql/` (exportar/importar en una instancia nueva).

## Fase 02 — RHPro como relying party

Toque en dos repos: RHPro (guard dual + mapeo) y Tourniquet (registro real del cliente demo).

- RHPro: `AUTH_MODO` + `JwtAuthGuard` dual (§2 `specs/03`), `/auth/exchange` en backend, callback
  frontend, cookie de sesión propia; `user_per.idp_sub` (+SQL portable con permiso en
  `rhpro_marcelino`).
- Tourniquet: registrar `cliente` demo (p. ej. `cervi`), `aplicacion rhpro`, `base_datos`
  `rhpro_marcelino` como inventario, y habilitar un usuario por SQL.
- **Aceptación**: con `AUTH_MODO=dual` RHPro acepta **ambos** orígenes; token con `aud` o
  `tenant` equivocado ⇒ 401; usuario del IdP sin alta en `user_per` ⇒ 401 "no habilitado";
  menú/perfiles/permisos de RHPro sin cambios observables: mismo comportamiento que Fase 00 con
  la sesión originada en el portal; logout de app ≠ logout central, y "salir de todo" apaga las
  dos.

## Fase 03 — Portal lanzador + administración de accesos

El portal deja de ser técnico y se vuelve el reemplazo del `Lanzador.asp`.

- UI: selector de cliente (si hay N memberships), lista de apps habilitadas
  (`idn_usuario_cliente_aplicacion`) con deep-link al authorize de cada app; "mis sesiones
  activas" con cierre forzado propio.
- Panel `admin_identidad` (por cliente): alta/edición de `idn_usuario`, membresías, habilitación
  de apps, cierre de sesión ajeno con motivo en auditoría.
- **Aceptación**: un usuario de dos clientes jamás ve datos del otro en ninguna pantalla (prueba
  manual cruzada documentada); deshabilitar una app en el registro ⇒ el authorize de esa app
  falla aunque el usuario tenga token vivo de portal (15' o revocación); toda acción de admin
  queda auditada con `sub` del admin; CORS de RHPro lee el perfil del token sin cambios.

## Fase 04 — Endurecimiento y opciones

Se toma lo que el primer contrato real pida; todo lo demás queda documentado como no hecho.

- MFA TOTP (`specs/01` §8) con códigos de recuperación.
- Rotación de claves de firma al primer aniversario o compromiso: drill documentado (runbook en
  `deploy/`).
- Job externo de limpieza (`tok_autorization_code` vencido, retención `aud_login`) en SQL
  Agent, ejecuta el usuario.
- Decisión documentada de federación saliente (AD/Entra del cliente) sobre D1 — spec propio si
  se aprueba.
- Interfaz de export para el futuro TenantRegistry de RHPro (`/registry/bases/:tenant` con
  inventario; el desencripto de credenciales por mecanismo separado, aún **sin diseño**).
- **Aceptación**: cada ítem entregado con su runbook de producción; lo no entregado sigue
  listado acá como pendiente, no como supuesto.

## Reglas transversales a todas las fases

1. No se crea ninguna tabla sin actualizar `specs/02` **primero**.
2. Ningún claim nuevo sin actualizar la tabla de `specs/01` §2 primero.
3. Los SQL de producción de la base de control los ejecuta el usuario; el agente sólo toca
   `tourniquet_dev` con permiso explícito.
4. Ante un requisito de negocio de una app ("que el token lleve el perfil"), la respuesta es D2
   de `specs/00`: se resuelve en la base de la app, no en Tourniquet.
