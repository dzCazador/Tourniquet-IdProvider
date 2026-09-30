# Tourniquet

**IdP (proveedor de identidad) central de la suite**: un solo logueo para todas las
aplicaciones de la casa — RHPro Argentina, RHPro Chile y las aplicaciones futuras de cada
cliente. Es el sucesor directo del `Lanzador.asp` del legacy, que ya elegía "base + módulo"
por cliente; acá se elige *cliente → aplicación* y la sesión viaja como token OIDC.

- **Backend:** NestJS + TypeScript + Prisma, **SQL Server** (motor único real).
- **Frontend (portal/lanzador):** Next.js App Router + React + Tailwind, export estático.
- **Repo:** `D:\Programacion\Nest\Tourniquet` (separado de `RHPro-NextGeneration`). RHPro es
  un *consumer*: valida tokens de Tourniquet por JWKS y conserva su autorización de negocio.

## Qué resuelve y qué NO

| Tourniquet resuelve | Tourniquet NO resuelve |
|---|---|
| Quién sos (identidad central, contraseña y **segundo factor MFA**, Fase 09) | Qué podés ver dentro de cada app (perfil/`menumstr` sigue en la base de cada base) |
| De qué cliente sos (`tenant`) y a qué apps tenés acceso | Permisos de negocio |
| Registro de apps y bases (`aplicacion`, `base_datos`) | Ejecución de procesos de negocio |
| Emisión/validación de tokens OIDC, sesiones, logout cross-app | Reportes, liquidación, ningún dominio RHPro |
| Portal/lanzador con la lista de apps habilitadas | — |
| Rotación de claves de firma y retención de auditoría (jobs externos) | — |

## Lo que **no** está hecho (y no es un supuesto)

Lista explícita, para que no aparezca como "falta" en un informe. La primera tabla
es lo que se dejó **fuera a propósito**; la segunda es lo que existe y tiene una
limitación conocida.

### No implementado

| # | Qué | Por qué / cuándo |
|---|---|---|
| △ | **Federación saliente** (login con la cuenta de Microsoft/Google/Entra del cliente) | Requiere spec propio y aprobación (D1 de `specs/00`). El diseño de `user_per.idp_sub` en RHPro la deja abierta sin rediseñar nada: `specs/todo/begin/README.md` § *Federación, si algún día* |
| △ | **Auto-provisioning de `user_per`** en RHPro (SCIM hacia las apps) | Decidido, NO implementado. Las cuatro decisiones que hay que tomar antes están en `specs/00` §7 |
| △ | **Cliente `confidential`** con `client_secret` (backend a backend) | No diseñado. Sólo hay clientes `public` con PKCE: `specs/01` §1 |
| △ | **Recuperación de la master key** | **Imposible por diseño.** El runbook dice qué hacer si se pierde (regenerar claves y recifrar credenciales), no cómo recuperarla |
| △ | **Email de recuperación o de verificación** | No implementado. El alta de usuarios la hace un `admin_identidad` desde el panel, que es un camino auditable |
| △ | **Cambio de contraseña por el usuario** | No implementado. Hoy el cambio lo hace el panel (que genera una clave temporal mostrada una vez) o `npm run resetear:clave` |
| △ | **Logs centralizados / SIEM** | No implementado. `aud_login` es la fuente, y se exporta con el panel o por SQL |
| △ | **Rate limit distribuido** | No implementado: es **en memoria, una instancia por instalación** (D3 de `specs/00`). Con más de una instancia, el límite real es el de cada una |
| △ | **Desencripto de credenciales de bases** para el futuro TenantRegistry de RHPro | **Sin diseño.** `GET /registry/bases/:tenant` y `/registry/aplicaciones/:tenant` dan inventario sin credenciales, y ningún endpoint devuelve contraseñas: `specs/00` §4.2 |

### Con limitación conocida

| Qué | La limitación |
|---|---|
| **MFA TOTP** (Fase 09) | No es recuperación de cuenta (sin correo, sin SMS, sin "¿olvidé mi código?"), **no protege el egreso** (cerrar sesión sigue siendo sólo el click) y el enrolamiento lo dispara un `admin_identidad`, no el usuario solo. `specs/01` §8.6 |
| **`/operacion/claves/rotar`** | **404 por default**: existe con `TQ_ROTACION_HABILITADA=true` y una lista de operadores. El procedimiento normal es manual, con `npm run rotar:clave` |
| **Job de "N tokens con `kid` fuera del JWKS"** | **No se puede contar**, y no es una funcionalidad faltante: los access tokens no se persisten. `npm run verificar:rotacion` reporta la cota por fecha (`tokens_en_vuelo`), que es lo único cierto |
| **Segundo factor en apps** | El claim `amr` ya dice `["pwd","mfa"]`, pero **ninguna app exige un segundo factor para una acción**: leer el `amr` y aplicar una política es trabajo de cada app |
| **`POST /oidc/token` con `prompt`/`max_age`** | No implementado. No hay *reauthentication* por API: para exigir el segundo factor de nuevo hay que hacer logout y entrar |

## Mapa de specs (normativos)

| Spec | Trata de |
|---|---|
| `specs/00-arquitectura.md` | Qué es Tourniquet, decisiones, componentes, relación con RHPro/multibase/Chile, riesgos |
| `specs/01-tokenos-y-seguridad.md` | Flujos OIDC, claims, vida de tokens, claves RS256/JWKS, passwords, sesiones, auditoría |
| `specs/02-base-de-datos.md` | Base de control `cat_*` / `idn_*` / `tok_*` / `aud_*`, tablas, tipos, regla SQL Server (sin artefactos MySQL), guardia de SQL dev |
| `specs/03-integracion-rhpro.md` | Cómo RHPro consume Tourniquet: guard dual, `sub → user_per`, portal, alta de apps nuevas |
| `specs/04-fases.md` | Roadmap 01–04 con criterios de aceptación |
| `specs/todo/begin/` | **Plan de implementación fase por fase** (00 → 11): tareas, SQL, criterios de aceptación y trampas |
| `specs/todo/begin/estetica-tourniquet.md` | Sistema de diseño del portal: estética gótica (negro, oxblood, placa grabada) y la guía de tono |

Convenciones del repo para agentes: **`AGENTS.md`**.

## Por dónde se empieza

1. `specs/00-arquitectura.md` y `specs/04-fases.md` — el marco.
2. `specs/todo/begin/README.md` — el índice y el estado real de cada fase; después, la Fase 05.
3. El portal se dibuja con `specs/todo/begin/estetica-tourniquet.md`: la estética gótica sale de la
   canción *Tourniquet* de Marilyn Manson (letra como guía de tono y motivo visual), con los
   requisitos de accesibilidad y de contrato de seguridad por encima del tema.

## Levantar el portal (desarrollo)

El backend y el frontend son dos procesos y **no comparten `.env`**: el del
backend vive en la raíz, el del portal en `frontend/.env` (Next lee
`.env`, `.env.local`, `.env.development`… desde la carpeta del frontend, en ese
orden de prioridad).

```bash
# 1. raiz: base de control, master key y admin
npm run sql:dev
npm run generar:clave
npm run bootstrap:admin

# 2. la API (3001)
npm run start --workspace backend

# 3. el portal (3002), en otra terminal
cd frontend && npm run dev
```

**¿Olvidaste la clave del admin?** `npm run resetear:clave -- --usuario admin`
(te la pide con eco oculto). Es un script de consola a propósito, no una ruta
de "recuperación por correo": ver `deploy/README.md`.

## Verificar (todo a mano, sin tests)

| Comando | Qué comprueba |
|---|---|
| `npm run verificar:clave` | Cifrado, firma y JWKS de las claves de la tabla `tok_clave_firma` |
| `npm run verificar:mfa` | El TOTP contra los **vectores del RFC 6238** y los códigos de recuperación |
| `npm run verificar:rotacion` | Estado de las claves, ventana de solapamiento y, con `--token`, un token real |
| `npm run verificar:oidc` | El núcleo OIDC por HTTP (authorize, token, refresh, revoke, logout) |
| `npm run verificar:portal` | Portal, panel y **segundo factor** por HTTP (135 comprobaciones) |

Rotar las claves es `npm run rotar:clave -- --rotar`; el procedimiento completo está
en `deploy/runbooks/rotacion-claves.md`. Los jobs de retención se **agendan**, no se
corren a mano: `deploy/runbooks/jobs-limpieza.md`.

`CORS_ORIGIN` tiene que traer `http://localhost:3002` en el `.env` de la raíz, y
`frontend/.env` tiene que traer `NEXT_PUBLIC_API_URL=http://localhost:3001` —el
build **corta** si falta, porque en un export estático la URL queda incrustada en
el bundle. Detalle en `specs/todo/begin/README.md`.
