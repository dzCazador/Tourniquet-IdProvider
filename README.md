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
| Quién sos (identidad central, contraseña, MFA futuro) | Qué podés ver dentro de cada app (perfil/`menumstr` sigue en la base de cada base) |
| De qué cliente sos (`tenant`) y a qué apps tenés acceso | Permisos de negocio |
| Registro de apps y bases (`aplicacion`, `base_datos`) | Ejecución de procesos de negocio |
| Emisión/validación de tokens OIDC, sesiones, logout cross-app | Reportes, liquidación, ningún dominio RHPro |
| Portal/lanzador con la lista de apps habilitadas | — |

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
2. `specs/todo/begin/README.md` — el índice; después, la Fase 00.
3. El portal se dibuja con `specs/todo/begin/estetica-tourniquet.md`: la estética gótica sale de la
   canción *Tourniquet* de Marilyn Manson (letra como guía de tono y motivo visual), con los
   requisitos de accesibilidad y de contrato de seguridad por encima del tema.
