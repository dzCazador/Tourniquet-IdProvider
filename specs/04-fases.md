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
  frontend, cookie de sesión propia; `user_per.idp_sub` (T-SQL de SQL Server, con permiso en
  `rhpro_marcelino`).
- Tourniquet: registrar `cliente` demo (p. ej. `cervi`), `aplicacion rhpro`, `base_datos`
  `rhpro_marcelino` como inventario, y habilitar un usuario por SQL.
- **Aceptación**: con `AUTH_MODO=dual` RHPro acepta **ambos** orígenes; token con `aud` o
  `tenant` equivocado ⇒ 401; usuario del IdP sin alta en `user_per` ⇒ 401 "no habilitado";
  menú/perfiles/permisos de RHPro sin cambios observables: mismo comportamiento que Fase 00 con
  la sesión originada en el portal; logout de app ≠ logout central, y "salir de todo" apaga las
  dos.
- **Estado**: implementada y verificada (ver `specs/todo/begin/fase-06-rhpro-dual-guard.md`).
  Login completo por navegador confirmado. Quedan para una fase posterior el **refresh silencioso**
  y el **logout de app** contra `/oidc/revoke`, más `POST /auth/rotate-jwks`.

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

- **MFA TOTP** (`specs/01` §8) con códigos de recuperación. **Entregado** (Fase 09).
- **Rotación de claves de firma** al primer aniversario o compromiso: drill documentado (runbook en
  `deploy/`). **Entregado** (Fase 09): procedimiento por script, endpoint apagado por default,
  runbook y script de verificación. El **drill completo falta ejecutarse una vez real** contra
  una instalación de cliente: es el paso que la Fase 09 deja agendado para cuando haya un
  `TQ_ISSUER` propio.
- **Job externo de limpieza** (`tok_autorization_code` vencido, retención `aud_login`) en SQL
  Agent, ejecuta el usuario. **Entregado** (Fase 09), y además para motores **sin SQL Agent**
  (SQL Server Express): los mismos `.sql` se agendan con el Planificador de tareas de Windows.
- **Decisión documentada de federación saliente** (AD/Entra del cliente) sobre D1 — spec propio si
  se aprueba. **Decidida: no aprobada, queda como mejora a futuro** con las cuatro decisiones
  previas anotadas en `specs/todo/begin/README.md` § *Federación, si algún día*.
- **Interfaz de export** para el futuro TenantRegistry de RHPro (`/registry/bases/:tenant` con
  inventario; el desencripto de credenciales por mecanismo separado, aún **sin diseño**).
  **Entregado** (Fase 09) el inventario, en `bases` y `aplicaciones`. El **desencripto de
  credenciales sigue sin diseño** y no se implementa en ninguna fase.
- **Aceptación**: cada ítem entregado con su runbook de producción; lo no entregado sigue
  listado acá como pendiente, no como supuesto. La lista vigente está en el `README.md` de la
  raíz, en dos tablas: lo que no se implementó, y lo que existe con una limitación conocida.

## Fase 05 — Despliegue en un cliente

La Fase 04 madre, después del endurecimiento: convertir el repositorio en algo que un
administrador de sistemas del cliente pueda instalar sin ayuda.

- **Runbooks de operación** en `deploy/runbooks/`: `instalacion.md` (de cero a login
  funcionando), `backup-restore.md` (base de control y master key **por separado**, con el
  restore **probado**), `rollback.md` (deshacer cada paso) y `emergencia.md` (cómo entra la
  gente si el IdP está caído). **Entregado** (Fase 10).
- **Generador de la semilla de cliente**: `npm run generar:instalacion` escribe un
  `91-semilla-<cliente>.sql` con los dominios, el inventario de base y el tema reales. No abre
  conexión a ninguna base. **Entregado** (Fase 10).
- **Guardas de arranque de producción**: `https` del `issuer`, master key de 32 bytes,
  `DATABASE_URL` fuera de `tourniquet_dev` y `DEBUG` ausente. Las cuatro cortan el proceso con un
  mensaje que dice qué corregir (`specs/00` §8.2). **Entregado** (Fase 10).
- **Marca por cliente** (`GET /marca`): el nombre que se ve en la pantalla de ingreso y el tema
  (`gothic`/`austero`) desde `cat_cliente.politica_json.tema`. El acento es el único token que se
  sobreescribe en runtime; el resto de la paleta no se mueve. **Entregado** (Fase 10).
- **Aceptación**: la instalación se ejecutó **completa en una máquina limpia** siguiendo sólo
  `runbooks/instalacion.md`, sin ayuda; la prueba de humo de 10 puntos pasó entera; el backup
  existe y **el restore se probó**; el camino `AUTH_MODO=local` se probó **realmente**, con
  Tourniquet apagado. **Lo que falta de esto está anotado en
  [`fase-10-despliegue-cliente.md`](todo/begin/fase-10-despliegue-cliente.md) § *Estado*:
  el código y los procedimientos están escritos y verificados contra `tourniquet_dev`, pero
  ejecutarlos en la máquina del cliente —y con el cliente mirando— es la fase siguiente.

## Reglas transversales a todas las fases

1. No se crea ninguna tabla sin actualizar `specs/02` **primero**.
2. Ningún claim nuevo sin actualizar la tabla de `specs/01` §2 primero.
3. Los SQL de producción de la base de control los ejecuta el usuario; el agente sólo toca
   `tourniquet_dev` con permiso explícito.
4. Ante un requisito de negocio de una app ("que el token lleve el perfil"), la respuesta es D2
   de `specs/00`: se resuelve en la base de la app, no en Tourniquet.
