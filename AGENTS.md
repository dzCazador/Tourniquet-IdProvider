# AGENTS.md — Convenciones del repo Tourniquet

Repo de identidad central (IdP OIDC) de la suite. Las convenciones de ingeniería son las de
`D:\Programacion\Nest\RHPro-NextGeneration` **adaptadas**: se copia lo transversal y se anota
la diferencia. El detalle de diseño vive en `specs/` y se lee bajo demanda.

## 🎯 Objetivo

Servir logueo único, registro de clientes/apps/bases y emisión de tokens OIDC para RHPro AR,
RHPro Chile y apps futuras. **No es una app de negocio**: no duplicar aquí nada de RHPro.

## 🚫 Restricciones críticas (OBLIGATORIAS)

1. **PROHIBIDO generar tests**: no crear `.spec.ts`/`.test.ts(x)`, mocks ni suites. Verificación
   manual + `npm run lint`.
2. **Motor único: SQL Server (T-SQL).** `deploy/sql/` es **exclusivamente T-SQL**: se escribe
   para Microsoft SQL Server y no hace falta abstraerse ni mantener una variante "portable"
   (es legítimo usar `datetime2`, `sysutcdatetime()`, `TOP`, `STRING_AGG`, índices filtrados
   con `WHERE`, `ON DELETE NO ACTION`, etc.).
   - **No existe `.env.prod` multi-motor ni artefactos `.mysql.sql`**: a diferencia de RHPro, no
     se genera una variante por motor ni por deploy. **No escribir SQL "portable" a propósito.**
   - Si algún día **hace falta otro motor** (MySQL, PostgreSQL, …), se crean **archivos
     scripts nuevos y propios** para ese motor en ese momento, con su numeración y su
     verificador, y se documenta acá. **No** se genera ahora, **no** se adivina y **no** se
     "porta" el SQL existente. Antes de hacerlo hay que dejar escrita la decisión en `specs/02`.
   - **Multibase = varias bases SQL Server (una por cliente/app), no varios motores.**
3. **Sin `prisma migrate` / `db push` / `migrate reset`.** El esquema lo cambia SQL versionado
   en `deploy/sql/`, aplicado por `scripts/ejecutar-sql-dev.mjs` **sólo sobre la base de
   desarrollo** (`DATABASE_URL` con `database=tourniquet_dev`; guardia dura igual que RHPro:
   aborta en cualquier otra base, y el usuario corre el SQL en producción).
4. **Windows / Git Bash**: respetar separadores de ruta; nada de comandos PowerShell que fallen
   fuera de Bash.
5. **Módulos TS/Node**: mismo criterio que RHPro — sin extensiones `.js` en imports relativos
   salvo que la config ESM lo exija; la compilación debe resolver `dist/main.js`.

## 🔐 Invariantes de seguridad (aplican a TODO código del repo)

- **`tenant`, `aud`, `sub` y `sid` se leen SIEMPRE del token validado; jamás de un parámetro,
  header o cookie del cliente.** Un request nunca puede nombrar a otro cliente.
- **No loguear nunca**: tokens completos, `pwd_hash`, `mfa_secret`, material privado de claves,
  cadenas de conexión de `base_datos` (ni siquiera parcialmente en errores).
- Contraseñas: **argon2id** (params de `specs/01`). Nada de sha1/md5/base64 "hash".
- Credenciales de bases ajenas (`base_datos.usuario/contraseña`): cifrado sobre la marcha
  (AES-256-GCM, master key desde env; ver `specs/01` §6). Nunca viajan por una API.
- Tokens: el access **no** se persiste en `localStorage` del portal; cookies `HttpOnly` o
  memoria, según el flujo de `specs/01`. Ningún token en query string salvo `code` del flujo
  PKCE estándar.
- Toda escritura de sesión/acceso (`login_audit`, `sesion`, `refresh_token`) es
  **append-only o por revocación**; nunca se borra auditoría desde la app.

## 🧱 Convenciones de código

- **Backend** (`backend/`): NestJS, carpetas por módulo (`auth/`, `oidc/`, `clientes/`,
  `apps/`, `sesiones/`, `auditoria/`, `prisma/`), patrón `*.module/controller/service/dto` de
  RHPro. Validación con `class-validator` vía pipes, igual que RHPro.
- **Frontend** (`frontend/`): Next.js App Router, `output: "export"` (exportable, se sirve como
  estático), Tailwind; el portal es la lista de apps del tenant (sucesor del lanzador).
- **Fechas**: UTC en BD, ISO en API, formateo en la UI — mismos criterios de
  `RHPro-NextGeneration/specs/fechas.md`.
- **Nomenclatura BD**: tablas del dominio propio con prefijo de funcion (`cat_`/`idn_`/`tok_`/`aud_`), minúsculas snake_case
  (`specs/02`). No se tocan esquemas ajenos: Tourniquet sólo escribe su base de control.
- **Variables de entorno (OBLIGATORIA)**: una sola fuente de verdad,
  `backend/src/config/env.schema.ts` (esquema **Joi**). Toda variable que el backend use se
  declara ahí; si no está en el esquema, no es configuración. Se inyecta con `ConfigService`
  (`@nestjs/config`), nunca `process.env` directo. Ver `specs/00` §8.
  - **Difiere de RHPro a propósito**: allá `joi` es dependencia muerta y cada módulo valida
    su `process.env` por su cuenta. Acá es centralizado, para que una variable mal escrita se
    detecte antes de levantar la app y en un solo lugar.
  - `TQ_MASTER_KEY`, `DATABASE_URL` y `TQ_BOOTSTRAP_CLAVE` son **sensibles**: se redactan
    (`[REDACTADO]`) en todo mensaje de error. Prohibido agregarles reglas de Joi que impriman
    el valor (`.pattern()` las imprime: usar `.custom()`).

## 🤖 Protocolo del agente

1. Antes de escribir código de un tema, leer el spec de la tabla de abajo.
2. Toda decisión nueva de seguridad/arquitectura se documenta en el spec **antes** de
   implementarla (no al revés).
3. Cambios de esquema: pedir permiso, SQL a `deploy/sql/` numerado, ejecutar sólo contra
   `tourniquet_dev`.
4. `npm run lint` verde antes de dar por cerrado un cambio.
5. Respuesta concisa, directa a la implementación.

## 🧭 Enrutamiento de specs

| Si la tarea trata de… | Leer |
|---|---|
| Qué es Tourniquet, decisiones, topología, riesgos | `specs/00-arquitectura.md` |
| Endpoints OIDC, claims, tiempos, claves, sesiones, MFA, cifrados | `specs/01-tokenos-y-seguridad.md` |
| Tablas `cat_*` / `idn_*` / `tok_*` / `aud_*`, DDL, guardia de ejecución, tipos SQL Server | `specs/02-base-de-datos.md` |
| Cómo RHPro valida tokens, `sub → user_per`, portal, alta de apps | `specs/03-integracion-rhpro.md` |
| Orden de trabajo y criterios de aceptación | `specs/04-fases.md` |
| Convenciones transversales originales | `D:\Programacion\Nest\RHPro-NextGeneration\AGENTS.md` y sus `specs/` |
